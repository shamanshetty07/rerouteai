import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import { SESSION_COOKIE, readCookie } from "../auth/session.ts";

type Env = Record<string, string | undefined>;

// -------------------------------------------------------------------------------------------------
// Security headers

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // the pages carry their own <style> and a few style attributes
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Responses carrying account or search data must never sit in a shared or browser cache. */
const NO_STORE_PREFIXES = ["/auth", "/profile", "/me", "/trains", "/stations", "/journeys"];

export function securityHeaders(env: Env = process.env): RequestHandler {
  const hsts = env["NODE_ENV"] === "production" && (env["BASE_URL"] ?? "").startsWith("https://");
  return (req, res, next) => {
    res.set({
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (hsts) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    if (NO_STORE_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) res.set("Cache-Control", "no-store");
    next();
  };
}

// -------------------------------------------------------------------------------------------------
// CSRF

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined; // "null" and others are refused
  } catch {
    return undefined;
  }
}

/**
 * Cookie-authenticated, state-changing requests (anything but GET/HEAD/OPTIONS) must come from our
 * own origin. This sits on top of SameSite=Lax cookies and needs no token plumbing in the frontend:
 * browsers always attach Origin to such requests, and a cross-site page cannot forge it.
 *
 * Not applied when there is nothing ambient to abuse: requests without the session cookie, or ones
 * authenticated by an explicit `Authorization: Bearer` header, which a cross-site page cannot add.
 * Read-only GETs are never affected.
 */
export function csrfProtection(env: Env = process.env): RequestHandler {
  const configured = originOf(env["BASE_URL"] ?? "http://localhost:8000");
  const production = env["NODE_ENV"] === "production";
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (/^Bearer /i.test(req.headers.authorization ?? "")) return next();
    if (readCookie(req.headers.cookie, SESSION_COOKIE) === undefined) return next();

    const allowed = new Set<string | undefined>([configured]);
    // Outside production the server may be reached on whatever local port it was started on.
    if (!production) allowed.add(`${req.protocol}://${req.get("host")}`);

    const origin = originOf(req.headers.origin) ?? originOf(req.headers.referer);
    const crossSite = req.headers["sec-fetch-site"] === "cross-site";
    if (crossSite || !origin || !allowed.has(origin)) {
      res.status(403).json({ error: "Cross-site request blocked" });
      return;
    }
    next();
  };
}

// -------------------------------------------------------------------------------------------------
// Rate limiting

export type RateLimiterOptions = {
  windowMs: number;
  max: number;
  /** Who is being limited. Defaults to the client IP. */
  key?: (req: Request) => string | number | undefined;
  /** Injectable clock for tests. */
  now?: () => number;
};

const MAX_TRACKED_KEYS = 50_000;

export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown";

/**
 * Fixed-window counter held in this process's memory. That is exact for one server instance; with
 * several instances each enforces its own budget (see the README for what that means), and a
 * restart resets the counts. It adds no dependency and bounds its own memory.
 */
export function rateLimit({ windowMs, max, key = clientIp, now = Date.now }: RateLimiterOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const t = now();
    if (hits.size >= MAX_TRACKED_KEYS) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      if (hits.size >= MAX_TRACKED_KEYS) hits.clear(); // under a flood, forget everyone rather than grow without bound
    }
    const id = String(key(req) ?? clientIp(req));
    let entry = hits.get(id);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(id, entry);
    }
    entry.count += 1;
    res.set({
      "RateLimit-Limit": String(max),
      "RateLimit-Remaining": String(Math.max(0, max - entry.count)),
      "RateLimit-Reset": String(Math.ceil((entry.resetAt - t) / 1000)),
    });
    if (entry.count > max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
      res.status(429).json({ error: "Too many requests, please slow down and try again shortly" });
      return;
    }
    next();
  };
}

/**
 * Express only honours X-Forwarded-For when told how many proxies to trust. By default none are
 * trusted, so a client cannot choose its own IP (and thereby dodge the rate limits).
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = (value ?? "").trim();
  if (v === "" || v.toLowerCase() === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  if (v.toLowerCase() === "true") {
    throw new Error("TRUST_PROXY=true would trust any X-Forwarded-For header; set the number of proxy hops (e.g. 1) or a subnet/keyword (e.g. loopback)");
  }
  return v;
}

// -------------------------------------------------------------------------------------------------
// Errors

type HttpError = Error & { status?: number; statusCode?: number; type?: string };

/** Last-resort handler: clients get a fixed message; stack traces, SQL and driver text stay in the server log. */
export const errorHandler: ErrorRequestHandler = (err: HttpError, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? err.statusCode;
  if (status === 413) return void res.status(413).json({ error: "Request body too large" });
  if (status === 400 && (err.type === "entity.parse.failed" || err.type === "encoding.unsupported" || err.type === "charset.unsupported")) {
    return void res.status(400).json({ error: "Malformed request body" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
