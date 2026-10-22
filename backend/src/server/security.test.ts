import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { SESSION_COOKIE, createSessionToken } from "../auth/session.ts";
import { userStore } from "../auth/userstore.ts";
import { send, serve } from "../../test/http.ts";
import { createApp } from "./app.ts";
import { csrfProtection, errorHandler, parseTrustProxy, rateLimit } from "./security.ts";

const SECRET = "security-test-secret-0123456789abcdef";
const ENV = { SESSION_SECRET: SECRET, BASE_URL: "http://localhost:8000" };
const PROD = {
  NODE_ENV: "production",
  SESSION_SECRET: SECRET,
  BASE_URL: "https://reroute.example.com",
  DATABASE_URL: "postgresql://u:p@db.example.com/app",
  USER_STORE: "postgres",
};

let saved: string | undefined;
beforeAll(() => {
  saved = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = SECRET;
});
afterAll(() => {
  if (saved === undefined) delete process.env["SESSION_SECRET"];
  else process.env["SESSION_SECRET"] = saved;
});

let n = 0;
async function signedInCookie() {
  const user = await userStore.create({ email: `s${++n}@example.com`, name: "S", provider: "github", providerId: `sec-${Date.now()}-${n}` });
  return { user, cookie: `${SESSION_COOKIE}=${createSessionToken(user.id)}` };
}

async function withApp<T>(env: Record<string, string>, run: (base: string) => Promise<T>): Promise<T> {
  const { base, close } = await serve(createApp(env));
  try {
    return await run(base);
  } finally {
    close();
  }
}

describe("CSRF protection of state-changing requests", () => {
  const post = (base: string, headers: Record<string, string>) => send(base, "/auth/signout", { method: "POST", headers });

  test("a cookie-authenticated POST needs a same-origin Origin (or Referer)", async () => {
    const { cookie } = await signedInCookie();
    await withApp(ENV, async (base) => {
      expect((await post(base, { Cookie: cookie, Origin: "http://localhost:8000" })).status).toBe(204);
      expect((await post(base, { Cookie: cookie, Referer: "http://localhost:8000/search" })).status).toBe(204);
      expect((await post(base, { Cookie: cookie, Origin: base })).status).toBe(204); // the dev server's own host:port
    });
  });

  test.each([
    ["no Origin or Referer", {}],
    ["a foreign Origin", { Origin: "https://evil.example" }],
    ["a foreign Referer", { Referer: "https://evil.example/page" }],
    ["Origin: null (sandboxed iframes, redirects)", { Origin: "null" }],
    ["a look-alike origin", { Origin: "http://localhost:8000.evil.example" }],
    ["the right origin but Sec-Fetch-Site: cross-site", { Origin: "http://localhost:8000", "Sec-Fetch-Site": "cross-site" }],
    ["an Origin with a different port", { Origin: "http://localhost:9999" }],
  ])("is rejected with 403 for %s, and nothing is revoked", async (_name, headers) => {
    const { user, cookie } = await signedInCookie();
    await withApp(ENV, async (base) => {
      const r = await post(base, { Cookie: cookie, ...headers });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: "Cross-site request blocked" });
    });
    expect((await userStore.findById(user.id))!.sessionVersion).toBe(0);
  });

  test("production accepts only the configured origin, not the request's own host", async () => {
    const { cookie } = await signedInCookie();
    await withApp(PROD, async (base) => {
      expect((await post(base, { Cookie: cookie, Origin: "https://reroute.example.com" })).status).toBe(204);
      expect((await post(base, { Cookie: cookie, Origin: base })).status).toBe(403);
    });
  });

  test("requests that carry no ambient credentials are not CSRF-checked", async () => {
    const { user } = await signedInCookie();
    await withApp(ENV, async (base) => {
      expect((await post(base, {})).status).toBe(204); // no cookie: nothing to abuse
      const bearer = await post(base, { Authorization: `Bearer ${createSessionToken(user.id)}` }); // explicit header
      expect(bearer.status).toBe(204);
    });
  });

  test("read-only GETs are never blocked, even cross-site", async () => {
    const { cookie } = await signedInCookie();
    await withApp(ENV, async (base) => {
      const r = await send(base, "/profile", { headers: { Cookie: cookie, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
      expect(r.status).toBe(200);
    });
  });

  test("the middleware covers every unsafe method", async () => {
    const app = express();
    app.use(csrfProtection(ENV));
    app.all("/x", (_req, res) => void res.json({ ok: true }));
    const { base, close } = await serve(app);
    try {
      const headers = { Cookie: `${SESSION_COOKIE}=whatever` };
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await send(base, "/x", { method, headers })).status).toBe(403);
      for (const method of ["GET", "HEAD", "OPTIONS"]) expect((await send(base, "/x", { method, headers })).status).not.toBe(403);
    } finally {
      close();
    }
  });
});

describe("rate limiting", () => {
  function limited(max: number, windowMs: number, key?: Parameters<typeof rateLimit>[0]["key"]) {
    let t = 1_000_000;
    const app = express();
    app.set("trust proxy", false);
    app.use(rateLimit({ windowMs, max, now: () => t, ...(key && { key }) }));
    app.get("/", (_req, res) => void res.json({ ok: true }));
    return { app, advance: (ms: number) => (t += ms) };
  }

  test("allows `max` requests per window, then 429 with Retry-After, then recovers", async () => {
    const { app, advance } = limited(3, 60_000);
    const { base, close } = await serve(app);
    try {
      for (let i = 0; i < 3; i++) expect((await send(base, "/")).status).toBe(200);
      const blocked = await send(base, "/");
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(blocked.headers["ratelimit-remaining"]).toBe("0");
      expect(JSON.parse(blocked.body).error).toContain("Too many requests");
      advance(60_001);
      expect((await send(base, "/")).status).toBe(200);
    } finally {
      close();
    }
  });

  test("budgets are per key", async () => {
    const { app } = limited(1, 60_000, (req) => String(req.headers["x-user"]));
    const { base, close } = await serve(app);
    try {
      expect((await send(base, "/", { headers: { "X-User": "a" } })).status).toBe(200);
      expect((await send(base, "/", { headers: { "X-User": "a" } })).status).toBe(429);
      expect((await send(base, "/", { headers: { "X-User": "b" } })).status).toBe(200);
    } finally {
      close();
    }
  });

  test("auth endpoints are limited per client IP", async () => {
    await withApp(ENV, async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < 45; i++) statuses.push((await send(base, "/auth/github/signin")).status);
      expect(statuses.slice(0, 40).every((s) => s !== 429)).toBe(true); // 503: provider not configured here
      expect(statuses.slice(40).every((s) => s === 429)).toBe(true);
      // The callback shares that budget, so it cannot be hammered for state-guessing either.
      expect((await send(base, "/auth/github/callback?code=x&state=y")).status).toBe(429);
      // Static pages are unaffected.
      expect((await send(base, "/search")).status).toBe(200);
    });
  });

  test("a spoofed X-Forwarded-For does not buy a fresh budget unless a proxy is trusted", async () => {
    await withApp(ENV, async (base) => {
      let blocked = 0;
      for (let i = 0; i < 45; i++) {
        if ((await send(base, "/auth/github/signin", { headers: { "X-Forwarded-For": `10.0.0.${i}` } })).status === 429) blocked++;
      }
      expect(blocked).toBe(5);
    });
    await withApp({ ...ENV, TRUST_PROXY: "1" }, async (base) => {
      let blocked = 0;
      for (let i = 0; i < 45; i++) {
        if ((await send(base, "/auth/github/signin", { headers: { "X-Forwarded-For": `10.0.1.${i}` } })).status === 429) blocked++;
      }
      expect(blocked).toBe(0); // behind a configured proxy, distinct client addresses have distinct budgets
    });
  });

  test("TRUST_PROXY parsing: hop counts and keywords pass, blanket trust is refused", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(() => parseTrustProxy("true")).toThrow("TRUST_PROXY=true");
    expect(() => createApp({ ...ENV, TRUST_PROXY: "true" })).toThrow("TRUST_PROXY=true");
  });

  test("API routes are limited per signed-in user, and failed requests count too", async () => {
    const heavy = await signedInCookie();
    const light = await signedInCookie();
    await withApp(ENV, async (base) => {
      // /trains/search spends RailRadar quota (30/min). Invalid input is rejected before any upstream call.
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await send(base, "/trains/search?from=NOPE!&to=X", { headers: { Cookie: heavy.cookie } })).status);
      expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
      // Another user, and a different route for the same user, are unaffected.
      expect((await send(base, "/trains/search?from=NOPE!&to=X", { headers: { Cookie: light.cookie } })).status).toBe(400);
      expect((await send(base, "/trains/alternatives?from=NDLS", { headers: { Cookie: heavy.cookie } })).status).toBe(400);
    });
  });
});

describe("security headers and CORS", () => {
  test("pages and API responses carry the hardening headers", async () => {
    const { cookie } = await signedInCookie();
    await withApp(ENV, async (base) => {
      for (const path of ["/search", "/profile"]) {
        const r = await send(base, path, { headers: { Cookie: cookie } });
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
        expect(r.headers["x-frame-options"]).toBe("DENY");
        expect(r.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        expect(r.headers["x-powered-by"]).toBeUndefined();
        const csp = String(r.headers["content-security-policy"]);
        for (const directive of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
          expect(csp).toContain(directive);
        }
        expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      }
      expect((await send(base, "/profile", { headers: { Cookie: cookie } })).headers["cache-control"]).toBe("no-store");
      expect((await send(base, "/auth/github/signin")).headers["cache-control"]).toBe("no-store");
    });
  });

  test("HSTS is sent only for https production deployments", async () => {
    await withApp(PROD, async (base) => {
      expect((await send(base, "/search")).headers["strict-transport-security"]).toContain("max-age=");
    });
    await withApp(ENV, async (base) => {
      expect((await send(base, "/search")).headers["strict-transport-security"]).toBeUndefined();
    });
  });

  test("CORS is not enabled: no cross-origin read access is ever granted", async () => {
    const { cookie } = await signedInCookie();
    await withApp(ENV, async (base) => {
      const headers = { Origin: "https://evil.example", Cookie: cookie };
      const get = await send(base, "/profile", { headers });
      const preflight = await send(base, "/trains/search", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
      });
      for (const r of [get, preflight]) {
        expect(r.headers["access-control-allow-origin"]).toBeUndefined();
        expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
      }
    });
  });

  test("the static server does not expose dotfiles or the source tree", async () => {
    await withApp(ENV, async (base) => {
      for (const path of ["/.env", "/../.env", "/..%2f.env", "/src/auth/session.ts", "/package.json", "/%2e%2e/package.json"]) {
        const r = await send(base, path);
        expect(r.status).not.toBe(200);
        expect(r.body).not.toContain("SESSION_SECRET");
      }
    });
  });
});

describe("error handling", () => {
  const originalError = console.error;
  afterEach(() => {
    console.error = originalError;
  });

  test("malformed and oversized JSON bodies get short fixed messages", async () => {
    await withApp(ENV, async (base) => {
      const bad = await send(base, "/auth/signout", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":' });
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body)).toEqual({ error: "Malformed request body" });
      expect(bad.body).not.toContain("Unexpected");

      const big = await send(base, "/auth/signout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ x: "a".repeat(20_000) }) });
      expect(big.status).toBe(413);
      expect(JSON.parse(big.body)).toEqual({ error: "Request body too large" });
    });
  });

  test("a database failure behind an authenticated route is a generic 500 with no SQL or credentials", async () => {
    const { cookie } = await signedInCookie();
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    const real = userStore.findById;
    userStore.findById = async () => {
      throw new Error('password authentication failed for user "app" (postgresql://app:hunter2@db.internal/prod) in: SELECT * FROM users');
    };
    try {
      await withApp(ENV, async (base) => {
        const r = await send(base, "/profile", { headers: { Cookie: cookie } });
        expect(r.status).toBe(500);
        expect(JSON.parse(r.body)).toEqual({ error: "Internal server error" });
        for (const leak of ["hunter2", "postgresql://", "SELECT", "password authentication", "at ", "node_modules"]) expect(r.body).not.toContain(leak);
        expect(r.headers["content-type"]).toContain("application/json");
      });
    } finally {
      userStore.findById = real;
    }
    expect(logged.length).toBeGreaterThan(0); // operators still see the failure in the server log
  });

  test("any thrown error, sync or async, becomes the same generic JSON", async () => {
    console.error = () => {};
    const app = express();
    app.get("/sync", () => {
      throw new Error("secret detail");
    });
    app.get("/async", async () => {
      throw new Error("secret detail");
    });
    app.use(errorHandler);
    const { base, close } = await serve(app);
    try {
      for (const path of ["/sync", "/async"]) {
        const r = await send(base, path);
        expect(r.status).toBe(500);
        expect(r.body).toBe('{"error":"Internal server error"}');
      }
    } finally {
      close();
    }
  });
});
