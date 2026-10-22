import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { serve, send, setCookies, type Reply } from "../../test/http.ts";
import { createApp } from "../server/app.ts";
import { SESSION_COOKIE, createSessionToken, readCookie, sessionCookieOptions, verifySession, verifySessionToken } from "./session.ts";
import { userStore } from "./userstore.ts";

const SECRET = "session-test-secret-0123456789abcdef";
const ENV = { SESSION_SECRET: SECRET, BASE_URL: "http://localhost:8000" };

let saved: string | undefined;
let base: string;
let close: () => void;
let n = 0;

beforeAll(async () => {
  saved = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = SECRET;
  ({ base, close } = await serve(createApp(ENV)));
});
afterAll(() => {
  close();
  if (saved === undefined) delete process.env["SESSION_SECRET"];
  else process.env["SESSION_SECRET"] = saved;
});

const newUser = () => userStore.create({ email: `u${++n}@example.com`, name: "U", provider: "github", providerId: `sess-${Date.now()}-${n}` });
const profile = (cookie?: string, headers: Record<string, string> = {}) =>
  send(base, "/profile", { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
const signout = (cookie: string | undefined, headers: Record<string, string> = {}) =>
  send(base, "/auth/signout", { method: "POST", headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: "http://localhost:8000", ...headers } });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const HEADER = { alg: "HS256", typ: "JWT" };
const sign = (data: string, secret = SECRET) => createHmac("sha256", secret).update(data).digest("base64url");
function forge(claims: object, { header = HEADER, secret = SECRET } = {}) {
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${sign(data, secret)}`;
}
const now = () => Math.floor(Date.now() / 1000);

describe("session validation", () => {
  test("a valid session is accepted, and no session or garbage is 401", async () => {
    const user = await newUser();
    expect((await profile(`${SESSION_COOKIE}=${createSessionToken(user.id)}`)).status).toBe(200);
    expect((await profile()).status).toBe(401);
    for (const bad of ["", "x", "a.b", "a.b.c.d", "....", "%", "not a token"]) {
      expect((await profile(`${SESSION_COOKIE}=${encodeURIComponent(bad)}`)).status).toBe(401);
    }
  });

  test("a malformed percent-escape in the cookie is a 401, not a server error", async () => {
    expect((await profile(`${SESSION_COOKIE}=%E0%A4%A`)).status).toBe(401);
    expect((await profile(`other=%E0%A4%A; ${SESSION_COOKIE}=%`)).status).toBe(401);
    expect(readCookie(`${SESSION_COOKIE}=%E0%A4%A`, SESSION_COOKIE)).toBeUndefined();
  });

  test("expired, wrong-key, wrong-algorithm, unsigned and tampered tokens are all rejected", async () => {
    const user = await newUser();
    const claims = { sub: String(user.id), sv: 0, iat: now(), exp: now() + 3600 };
    const good = forge(claims);
    expect((await profile(`${SESSION_COOKIE}=${good}`)).status).toBe(200);

    const rejected = [
      forge({ ...claims, exp: now() - 10 }), // expired
      forge(claims, { secret: "another-secret-entirely-0123456789ab" }), // signed with another key
      forge(claims, { header: { alg: "none", typ: "JWT" } as never }), // header we never issue
      forge(claims, { header: { alg: "HS512", typ: "JWT" } as never }),
      `${b64(HEADER)}.${b64(claims)}.`, // no signature
      forge({ sub: "abc", exp: now() + 3600 }), // non-numeric subject
      forge({ sub: String(user.id) }), // no expiry
      forge({ ...claims, sv: -1 }),
      forge({ ...claims, sv: "0" }),
      good.replace(/.$/, (c) => (c === "A" ? "B" : "A")), // one flipped signature character
      `${good.split(".")[0]}.${b64({ ...claims, sub: "1" })}.${good.split(".")[2]}`, // payload swapped, signature kept
    ];
    for (const token of rejected) expect((await profile(`${SESSION_COOKIE}=${token}`)).status).toBe(401);
    for (const token of rejected) expect(verifySessionToken(token)).toBeNull();
  });

  test("a token for a user that no longer exists is rejected", async () => {
    expect((await profile(`${SESSION_COOKIE}=${createSessionToken(99999999)}`)).status).toBe(401);
  });

  test("the Authorization header works as an alternative, with the same checks", async () => {
    const user = await newUser();
    expect((await profile(undefined, { Authorization: `Bearer ${createSessionToken(user.id)}` })).status).toBe(200);
    expect((await profile(undefined, { Authorization: "Bearer junk" })).status).toBe(401);
    expect((await profile(undefined, { Authorization: createSessionToken(user.id) })).status).toBe(401); // no scheme
  });

  test("tokens issued before session versions existed (no `sv`) still work as version 0", async () => {
    const user = await newUser();
    const legacy = forge({ sub: String(user.id), iat: now(), exp: now() + 3600 });
    expect(verifySession(legacy)).toEqual({ userId: user.id, version: 0 });
    expect((await profile(`${SESSION_COOKIE}=${legacy}`)).status).toBe(200);
  });

  test("session cookies are HttpOnly, SameSite=Lax and site-wide; Secure for https deployments", async () => {
    expect(sessionCookieOptions).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const script = `import { sessionCookieOptions as o } from ${JSON.stringify(new URL("./session.ts", import.meta.url).href)}; console.log(JSON.stringify(o));`;
    const run = async (env: Record<string, string>) => {
      const p = Bun.spawn(["bun", "--no-env-file", "-e", script], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: "pipe" });
      return JSON.parse(await new Response(p.stdout).text());
    };
    expect((await run({ NODE_ENV: "production" })).secure).toBe(true);
    expect((await run({ BASE_URL: "https://reroute.example.com" })).secure).toBe(true);
    expect((await run({})).secure).toBe(false);
  });
});

describe("logout", () => {
  test("clears the cookie, and the old token stops working everywhere", async () => {
    const user = await newUser();
    const old = `${SESSION_COOKIE}=${createSessionToken(user.id, 0)}`;
    const other = `${SESSION_COOKIE}=${createSessionToken(user.id, 0)}`; // a second device
    expect((await profile(old)).status).toBe(200);

    const out = await signout(old);
    expect(out.status).toBe(204);
    const cleared = setCookies(out).find((c) => c.startsWith(`${SESSION_COOKIE}=;`))!;
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Path=/");
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect((await profile(old)).status).toBe(401); // replaying the stolen/old token fails
    expect((await profile(other)).status).toBe(401);
    expect((await userStore.findById(user.id))!.sessionVersion).toBe(1);

    // Signing in again issues a token at the new version.
    const fresh = `${SESSION_COOKIE}=${createSessionToken(user.id, 1)}`;
    expect((await profile(fresh)).status).toBe(200);
  });

  test("it only revokes the signed-out user", async () => {
    const a = await newUser();
    const b = await newUser();
    await signout(`${SESSION_COOKIE}=${createSessionToken(a.id)}`);
    expect((await profile(`${SESSION_COOKIE}=${createSessionToken(b.id)}`)).status).toBe(200);
  });

  test("a bad, expired or already-revoked token revokes nothing but still clears the cookie", async () => {
    const user = await newUser();
    const out = await signout(`${SESSION_COOKIE}=${forge({ sub: String(user.id), sv: 0, exp: now() + 60 }, { secret: "wrong-wrong-wrong-wrong-wrong-12345" })}`);
    expect(out.status).toBe(204);
    expect((await userStore.findById(user.id))!.sessionVersion).toBe(0);

    const stale = `${SESSION_COOKIE}=${createSessionToken(user.id, 0)}`;
    await signout(stale);
    expect((await userStore.findById(user.id))!.sessionVersion).toBe(1);
    await signout(stale); // replaying the old token must not bump the version again
    expect((await userStore.findById(user.id))!.sessionVersion).toBe(1);

    expect((await signout(undefined)).status).toBe(204);
  });

  test("a Bearer-authenticated sign-out revokes too", async () => {
    const user = await newUser();
    const out = await send(base, "/auth/signout", { method: "POST", headers: { Authorization: `Bearer ${createSessionToken(user.id)}` } });
    expect(out.status).toBe(204);
    expect((await userStore.findById(user.id))!.sessionVersion).toBe(1);
  });

  test("sign-out is a POST only: a GET (e.g. an <img> tag) does nothing", async () => {
    const user = await newUser();
    const r = await send(base, "/auth/signout", { headers: { Cookie: `${SESSION_COOKIE}=${createSessionToken(user.id)}` } });
    expect(r.status).toBe(404);
    expect((await userStore.findById(user.id))!.sessionVersion).toBe(0);
  });
});

export type { Reply };
