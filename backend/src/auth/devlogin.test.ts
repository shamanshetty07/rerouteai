import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { get as httpGet, type Server } from "node:http";
import { assertDevLoginSafe, createDevLoginRouter, devLoginEnabled, isLoopbackAddress } from "./devlogin.ts";
import { requireAuth } from "./middleware.ts";
import { SESSION_COOKIE, createSessionToken, verifySessionToken } from "./session.ts";
import { userStore } from "./userstore.ts";

const SECRET = "test-only-secret";
type Env = Record<string, string | undefined>;

// node:http rather than fetch: the test preload installs happy-dom's browser-style fetch.
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
const request = (base: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<Reply>((resolve, reject) => {
    httpGet(`${base}${path}`, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject);
  });

const servers: Server[] = [];
async function serve(env: Env) {
  const app = express();
  app.use(createDevLoginRouter(env));
  app.get("/protected", requireAuth, (req, res) => void res.json({ id: req.user!.id, provider: req.user!.provider }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const sessionCookie = (reply: Reply) =>
  ([] as string[]).concat(reply.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));

let originalSecret: string | undefined;
beforeAll(() => {
  originalSecret = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = SECRET;
});
afterAll(() => {
  for (const s of servers) s.close();
  if (originalSecret === undefined) delete process.env["SESSION_SECRET"];
  else process.env["SESSION_SECRET"] = originalSecret;
});

describe("enabling", () => {
  test("is off unless DEV_LOGIN is exactly \"true\"", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      expect(devLoginEnabled({ DEV_LOGIN: value })).toBe(false);
    }
    expect(devLoginEnabled({ DEV_LOGIN: "true" })).toBe(true);
  });

  test("refuses to start when enabled in production, whatever the casing", () => {
    for (const nodeEnv of ["production", "Production", " PRODUCTION "]) {
      expect(() => assertDevLoginSafe({ DEV_LOGIN: "true", NODE_ENV: nodeEnv })).toThrow("Refusing to start");
      expect(() => createDevLoginRouter({ DEV_LOGIN: "true", NODE_ENV: nodeEnv })).toThrow("Refusing to start");
    }
  });

  test("production without the flag, and the flag outside production, are both fine", () => {
    expect(() => createDevLoginRouter({ NODE_ENV: "production" })).not.toThrow();
    expect(() => createDevLoginRouter({ NODE_ENV: "production", DEV_LOGIN: "false" })).not.toThrow();
    expect(() => createDevLoginRouter({ DEV_LOGIN: "true", NODE_ENV: "development" })).not.toThrow();
    expect(() => createDevLoginRouter({ DEV_LOGIN: "true" })).not.toThrow();
  });

  test("only loopback peers count as local", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ["192.168.1.20", "10.0.0.5", "::ffff:10.0.0.5", "", undefined]) expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe("when disabled", () => {
  test("the route does not exist and sets no cookie", async () => {
    for (const env of [{}, { DEV_LOGIN: "false" }, { DEV_LOGIN: "TRUE" }, { NODE_ENV: "production" }]) {
      const base = await serve(env);
      const res = await request(base, "/auth/dev/login");
      expect(res.status).toBe(404);
      expect(sessionCookie(res)).toBeUndefined();
    }
  });
});

describe("when enabled", () => {
  let base: string;
  beforeAll(async () => {
    base = await serve({ DEV_LOGIN: "true", NODE_ENV: "development", SESSION_SECRET: SECRET });
  });

  test("protected routes stay protected without a session", async () => {
    expect((await request(base, "/protected")).status).toBe(401);
    expect((await request(base, "/protected", { Authorization: "Bearer forged.token.here" })).status).toBe(401);
  });

  test("signs in the fixed development user through the normal session cookie", async () => {
    const res = await request(base, "/auth/dev/login");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/search");

    const cookie = sessionCookie(res)!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const token = cookie.split(";")[0]!.slice(`${SESSION_COOKIE}=`.length);
    const me = await request(base, "/protected", { Cookie: `${SESSION_COOKIE}=${token}` });
    expect(me.status).toBe(200);
    const { id, provider } = JSON.parse(me.body) as { id: number; provider: string };
    expect(provider).toBe("dev");
    expect(verifySessionToken(token)).toBe(id);
  });

  test("reuses one development user and never touches OAuth accounts", async () => {
    const existing = await userStore.create({ email: "real@example.com", name: "Real", provider: "github", providerId: "gh-1" });
    const first = await request(base, "/auth/dev/login");
    const second = await request(base, "/auth/dev/login");
    const idOf = (r: Reply) => verifySessionToken(sessionCookie(r)!.split(";")[0]!.slice(SESSION_COOKIE.length + 1));
    expect(idOf(first)).toBe(idOf(second));
    expect(idOf(first)).not.toBe(existing.id);
    expect(await userStore.findByProvider("github", "gh-1")).toEqual(existing);
  });

  test("ignores any user id, email or provider sent by the client", async () => {
    const victim = await userStore.create({ email: "victim@example.com", name: "V", provider: "google", providerId: "g-1" });
    const res = await request(base, `/auth/dev/login?userId=${victim.id}&email=victim@example.com&provider=google`);
    const id = verifySessionToken(sessionCookie(res)!.split(";")[0]!.slice(SESSION_COOKIE.length + 1));
    expect(id).not.toBe(victim.id);
  });

  test("redirects only to same-site paths", async () => {
    expect((await request(base, "/auth/dev/login?next=/profile")).headers["location"]).toBe("/profile");
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "profile"]) {
      expect((await request(base, `/auth/dev/login?next=${encodeURIComponent(next)}`)).headers["location"]).toBe("/search");
    }
  });

  test("does not put the token in the response body", async () => {
    const res = await request(base, "/auth/dev/login");
    const token = sessionCookie(res)!.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
    expect(res.body).not.toContain(token);
    expect(String(res.headers["location"])).not.toContain(token);
  });

  test("a token signed with a different key is rejected by the protected route", async () => {
    const real = createSessionToken(1);
    process.env["SESSION_SECRET"] = "another-key";
    const forged = createSessionToken(1);
    process.env["SESSION_SECRET"] = SECRET;
    expect(forged).not.toBe(real);
    expect((await request(base, "/protected", { Authorization: `Bearer ${forged}` })).status).toBe(401);
  });
});

describe("without a signing key", () => {
  test("reports the missing SESSION_SECRET instead of using a default", async () => {
    const saved = process.env["SESSION_SECRET"];
    delete process.env["SESSION_SECRET"];
    try {
      const base = await serve({ DEV_LOGIN: "true" });
      const res = await request(base, "/auth/dev/login");
      expect(res.status).toBe(503);
      expect(res.body).toContain("SESSION_SECRET");
      expect(sessionCookie(res)).toBeUndefined();
    } finally {
      process.env["SESSION_SECRET"] = saved;
    }
  });
});
