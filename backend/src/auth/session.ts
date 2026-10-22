import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function secret(): string {
  const value = process.env["SESSION_SECRET"];
  if (!value) throw new Error("SESSION_SECRET is not set");
  return value;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

/**
 * Issues an HS256 JWT whose `sub` is the user id and `sv` the user's session version. Signing out
 * bumps the version stored with the user, which invalidates every token carrying an older one.
 */
export function createSessionToken(userId: number, sessionVersion = 0): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: String(userId), sv: sessionVersion, iat: now, exp: now + MAX_AGE_SECONDS }),
  ).toString("base64url");
  const data = `${HEADER}.${payload}`;
  return `${data}.${sign(data)}`;
}

export type VerifiedSession = { userId: number; version: number };

/** Returns the user id alone; see `verifySession` for the version used to honour sign-out. */
export function verifySessionToken(token: string | undefined): number | null {
  return verifySession(token)?.userId ?? null;
}

/** Returns the claims, or null if the token is malformed, forged or expired. */
export function verifySession(token: string | undefined): VerifiedSession | null {
  const parts = token?.split(".");
  if (parts?.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  // Only accept the exact header we issue, which rules out `alg: none` and algorithm swaps.
  if (header !== HEADER) return null;

  const expected = Buffer.from(sign(`${header}.${payload}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const id = Number(claims.sub);
    if (!Number.isInteger(id) || typeof claims.exp !== "number") return null;
    if (claims.exp < Date.now() / 1000) return null;
    // Tokens issued before sign-out existed carry no `sv`; they count as version 0.
    const version = claims.sv === undefined ? 0 : claims.sv;
    if (!Number.isInteger(version) || version < 0) return null;
    return { userId: id, version };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  // https deployments (production, or any https BASE_URL) never send the session over plain http.
  secure: process.env["NODE_ENV"] === "production" || (process.env["BASE_URL"] ?? "").startsWith("https://"),
  path: "/",
  maxAge: MAX_AGE_SECONDS * 1000,
} as const;

/** Options that make `res.clearCookie` actually match the cookie that was set. */
export const sessionCookieClearOptions = { ...sessionCookieOptions, maxAge: undefined };

/** Minimal cookie reader so we don't need cookie-parser. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined; // a malformed escape is "no cookie", not a server error
      }
    }
  }
  return undefined;
}
