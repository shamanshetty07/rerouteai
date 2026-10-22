import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { get as httpGet, type Server } from "node:http";
import { createAuthRouter } from "./authcontroller.ts";
import { createProviders, isProvider } from "./providers.ts";
import { userStore } from "./userstore.ts";

// Everything below runs against mocked provider HTTP: no real GitHub or Google traffic.

const SECRET = "test-session-secret-0123456789abcdef";
const ENV = {
  SESSION_SECRET: SECRET,
  BASE_URL: "http://localhost:8000",
  GITHUB_CLIENT_ID: "gh-client",
  GITHUB_CLIENT_SECRET: "gh-client-secret",
  GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
};

let clock = Math.floor(Date.now() / 1000);
let server: Server;
let base: string;
let savedSecret: string | undefined;
const realWarn = console.warn;

// --- fake provider HTTP -------------------------------------------------------------------------

type Call = { method: string; url: string; headers: Record<string, string>; body: URLSearchParams };
let calls: Call[];
let routes: Record<string, (call: Call) => Response | Promise<Response>>;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const call: Call = {
    method,
    url,
    headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    body: new URLSearchParams(init?.body ? String(init.body) : ""),
  };
  calls.push(call);
  const u = new URL(url);
  const handler = routes[`${method} ${u.origin}${u.pathname}`];
  if (!handler) throw new Error(`unexpected request: ${method} ${u.origin}${u.pathname}`);
  return handler(call);
}

// --- Google signing keys ------------------------------------------------------------------------

const newKey = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
};
let googleKey = newKey("key-initial");
const otherKey = newKey("forger"); // different key material: a forger's key

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(header: object, claims: object, privateKey: KeyObject | null) {
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = privateKey ? createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url") : "";
  return `${data}.${sig}`;
}

// --- HTTP helpers (node:http: the test preload installs happy-dom's browser-style fetch) ---------

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
const request = (path: string, headers: Record<string, string> = {}) =>
  new Promise<Reply>((resolve, reject) => {
    httpGet(`${base}${path}`, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject);
  });

const setCookies = (r: Reply) => ([] as string[]).concat(r.headers["set-cookie"] ?? []);
const cookie = (r: Reply, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=`));
const cookieValue = (r: Reply, name: string) => cookie(r, name)?.split(";")[0]!.slice(name.length + 1);
const location = (r: Reply) => String(r.headers["location"] ?? "");

type Started = { reply: Reply; url: URL; state: string; stateCookie: string };
async function start(provider: string, mode: "signin" | "signup" = "signup", query = ""): Promise<Started> {
  const r = await request(`/auth/${provider}/${mode}${query}`);
  expect(r.status).toBe(302);
  const url = new URL(location(r));
  return { reply: r, url, state: url.searchParams.get("state")!, stateCookie: `oauth_state=${cookieValue(r, "oauth_state")}` };
}

const callback = (provider: string, s: Started, extra: Record<string, string> = {}) =>
  request(`/auth/${provider}/callback?${new URLSearchParams({ code: "auth-code", state: s.state, ...extra })}`, { Cookie: s.stateCookie });

let n = 0;
const uniqueId = () => `${Date.now()}-${++n}`;

// --- fixtures for each provider ----------------------------------------------------------------

function githubOk(opts: { id?: number; login?: string; name?: string | null; emails?: unknown; publicEmail?: string } = {}) {
  const id = opts.id ?? 1000 + ++n;
  routes["POST https://github.com/login/oauth/access_token"] = () => reply({ access_token: "gho_secret_access_token", token_type: "bearer" });
  routes["GET https://api.github.com/user"] = () =>
    reply({ id, login: opts.login ?? "octo", name: opts.name === undefined ? "Octo Cat" : opts.name, email: opts.publicEmail ?? "public-unverified@example.com" });
  routes["GET https://api.github.com/user/emails"] = () =>
    reply(opts.emails ?? [{ email: "octo@example.com", primary: true, verified: true }]);
  return id;
}

function googleToken(s: Started, over: Record<string, unknown> = {}, key = googleKey, header: object = { alg: "RS256", kid: googleKey.kid }) {
  return jwt(
    header,
    {
      iss: "https://accounts.google.com",
      aud: ENV.GOOGLE_CLIENT_ID,
      sub: `g-${uniqueId()}`,
      email: "gina@example.com",
      email_verified: true,
      name: "Gina G",
      nonce: nonceOf(s),
      iat: clock - 10,
      exp: clock + 3600,
      ...over,
    },
    key.privateKey,
  );
}
const nonceOf = (s: Started) => s.url.searchParams.get("nonce")!;

function googleOk(idToken: () => string) {
  routes["POST https://oauth2.googleapis.com/token"] = () => reply({ access_token: "ya29.secret", id_token: idToken() });
  routes["GET https://www.googleapis.com/oauth2/v3/certs"] = () => reply({ keys: [googleKey.jwk] });
}

// --- setup --------------------------------------------------------------------------------------

beforeAll(async () => {
  console.warn = () => {}; // expected provider-failure logs would drown the test output
  savedSecret = process.env["SESSION_SECRET"];
  process.env["SESSION_SECRET"] = SECRET;
  const app = express();
  app.use(
    createAuthRouter({
      env: ENV,
      now: () => clock,
      providers: createProviders({ env: ENV, fetch: fakeFetch, now: () => clock, timeoutMs: 200 }),
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  console.warn = realWarn;
  server.close();
  if (savedSecret === undefined) delete process.env["SESSION_SECRET"];
  else process.env["SESSION_SECRET"] = savedSecret;
});

beforeEach(() => {
  calls = [];
  routes = {};
  clock = Math.floor(Date.now() / 1000);
  // A fresh kid per test, so the provider's cached key set from an earlier test is never reused.
  googleKey = newKey(`key-${++n}`);
});

// =================================================================================================

describe("authorization redirect", () => {
  test("GitHub: correct endpoint, client, callback URL, scope, state and PKCE challenge", async () => {
    const s = await start("github", "signin");
    expect(s.url.origin + s.url.pathname).toBe("https://github.com/login/oauth/authorize");
    const p = s.url.searchParams;
    expect(p.get("client_id")).toBe("gh-client");
    expect(p.get("redirect_uri")).toBe("http://localhost:8000/auth/github/callback");
    expect(p.get("scope")).toBe("read:user user:email");
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(32);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")!.length).toBeGreaterThanOrEqual(43);
    expect(s.url.toString()).not.toContain("secret");
  });

  test("Google: OpenID scopes, nonce, PKCE and the callback URL", async () => {
    const s = await start("google", "signup");
    expect(s.url.origin + s.url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = s.url.searchParams;
    expect(p.get("client_id")).toBe(ENV.GOOGLE_CLIENT_ID);
    expect(p.get("redirect_uri")).toBe("http://localhost:8000/auth/google/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("openid email profile");
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(32);
    expect(p.get("code_challenge_method")).toBe("S256");
  });

  test("state is random per request and travels in a signed HttpOnly SameSite=Lax cookie", async () => {
    const a = await start("github");
    const b = await start("github");
    expect(a.state).not.toBe(b.state);
    const c = cookie(a.reply, "oauth_state")!;
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Secure"); // plain-http local development
    expect(a.stateCookie).not.toContain(a.state.slice(0, 8) + "x"); // sanity: cookie is not just the raw handle
  });

  test("signup and signin both start the flow", async () => {
    expect((await start("github", "signup")).url.hostname).toBe("github.com");
    expect((await start("github", "signin")).url.hostname).toBe("github.com");
  });

  test("an https BASE_URL gives Secure cookies and https callbacks; a trailing slash is ignored", async () => {
    const app = express();
    const env = { ...ENV, BASE_URL: "https://reroute.example.com/" };
    app.use(createAuthRouter({ env, now: () => clock, providers: createProviders({ env, fetch: fakeFetch }) }));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (srv.address() as { port: number }).port;
      const r = await new Promise<Reply>((resolve, reject) =>
        httpGet(`http://127.0.0.1:${port}/auth/google/signin`, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: "" }));
        }).on("error", reject),
      );
      expect(new URL(location(r)).searchParams.get("redirect_uri")).toBe("https://reroute.example.com/auth/google/callback");
      expect(cookie(r, "oauth_state")).toContain("Secure");
    } finally {
      srv.close();
    }
  });

  test("an unconfigured provider answers 503 and sets nothing", async () => {
    const app = express();
    const env = { ...ENV, GITHUB_CLIENT_SECRET: "" };
    app.use(createAuthRouter({ env, providers: createProviders({ env, fetch: fakeFetch }) }));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (srv.address() as { port: number }).port;
      const r = await new Promise<Reply>((resolve, reject) =>
        httpGet(`http://127.0.0.1:${port}/auth/github/signin`, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        }).on("error", reject),
      );
      expect(r.status).toBe(503);
      expect(r.headers["location"]).toBeUndefined();
      expect(cookie(r, "oauth_state")).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  test("unknown providers, including object-prototype names, are 404", async () => {
    for (const name of ["facebook", "constructor", "__proto__", "toString"]) {
      expect((await request(`/auth/${name}/signin`)).status).toBe(404);
    }
    expect(isProvider("constructor")).toBe(false);
  });
});

describe("GitHub callback", () => {
  test("signs a new user up: exchanges the code, stores the stable id and verified email, sets the session", async () => {
    const id = githubOk();
    const s = await start("github");
    const r = await callback("github", s);

    expect(r.status).toBe(302);
    expect(location(r)).toBe("/search");

    const exchange = calls.find((c) => c.url.endsWith("/login/oauth/access_token"))!;
    expect(exchange.method).toBe("POST");
    expect(Object.fromEntries(exchange.body)).toEqual({
      client_id: "gh-client",
      client_secret: "gh-client-secret",
      code: "auth-code",
      redirect_uri: "http://localhost:8000/auth/github/callback",
      code_verifier: expect.any(String),
    });
    // The PKCE verifier sent now must hash to the challenge sent in the authorize redirect.
    const hashed = new Bun.CryptoHasher("sha256").update(exchange.body.get("code_verifier")!).digest("base64url");
    expect(hashed).toBe(s.url.searchParams.get("code_challenge")!);

    const user = await userStore.findByProvider("github", String(id));
    expect(user).toMatchObject({ email: "octo@example.com", name: "Octo Cat", provider: "github" });

    const session = `session=${cookieValue(r, "session")}`;
    const me = await request("/profile", { Cookie: session });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ id: user!.id, provider: "github" });
    expect(cookie(r, "session")).toContain("HttpOnly");
  });

  test("the session works on protected routes and they stay closed without it", async () => {
    expect((await request("/profile")).status).toBe(401);
    expect((await request("/profile", { Cookie: "session=forged.value.here" })).status).toBe(401);
  });

  test("ignores the unverified public-profile email and uses a verified one, preferring primary", async () => {
    const id = githubOk({
      publicEmail: "spoofed@victim.example",
      emails: [
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "unverified-primary@example.com", primary: true, verified: false },
        { email: "main@example.com", primary: true, verified: true },
      ],
    });
    await callback("github", await start("github"));
    expect((await userStore.findByProvider("github", String(id)))!.email).toBe("main@example.com");
  });

  test("falls back to any verified address when none is primary", async () => {
    const id = githubOk({ emails: [{ email: "only@example.com", primary: false, verified: true }] });
    await callback("github", await start("github"));
    expect((await userStore.findByProvider("github", String(id)))!.email).toBe("only@example.com");
  });

  test("sign-up is refused when GitHub has no verified email, and creates nothing", async () => {
    const id = githubOk({ emails: [{ email: "x@example.com", primary: true, verified: false }] });
    const r = await callback("github", await start("github"));
    expect(r.status).toBe(403);
    expect(cookie(r, "session")).toBeUndefined();
    expect(await userStore.findByProvider("github", String(id))).toBeNull();
  });

  test("sign-in of an existing user does not need a verified email", async () => {
    const id = githubOk();
    await callback("github", await start("github", "signup"));
    githubOk({ id, emails: [] });
    const r = await callback("github", await start("github", "signin"));
    expect(r.status).toBe(302);
    expect(cookie(r, "session")).toBeDefined();
  });

  test("GitHub's HTTP 200 error body for a bad code is a generic 502, with no provider detail", async () => {
    routes["POST https://github.com/login/oauth/access_token"] = () => reply({ error: "bad_verification_code", error_description: "internal detail xyz" });
    const r = await callback("github", await start("github"));
    expect(r.status).toBe(502);
    expect(r.body).not.toContain("bad_verification_code");
    expect(r.body).not.toContain("xyz");
    expect(cookie(r, "session")).toBeUndefined();
  });

  test.each([
    ["token endpoint HTTP 500", () => (routes["POST https://github.com/login/oauth/access_token"] = () => reply({}, 500))],
    ["profile HTTP 401", () => {
      githubOk();
      routes["GET https://api.github.com/user"] = () => reply({ message: "Bad credentials" }, 401);
    }],
    ["emails HTTP 403", () => {
      githubOk();
      routes["GET https://api.github.com/user/emails"] = () => reply({ message: "forbidden" }, 403);
    }],
    ["malformed token JSON", () => (routes["POST https://github.com/login/oauth/access_token"] = () => new Response("<html>", { status: 200 }))],
    ["non-numeric user id", () => {
      githubOk();
      routes["GET https://api.github.com/user"] = () => reply({ id: "abc", login: "x" });
    }],
    ["emails not an array", () => {
      githubOk();
      routes["GET https://api.github.com/user/emails"] = () => reply({ nope: true });
    }],
    ["network failure", () => (routes["POST https://github.com/login/oauth/access_token"] = () => { throw new Error("ECONNRESET"); })],
  ])("%s -> generic 502 and no session", async (_name, arrange) => {
    arrange();
    const r = await callback("github", await start("github"));
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error).toBe("Sign-in with the provider failed, please try again");
    expect(cookie(r, "session")).toBeUndefined();
  });

  test("a provider that never answers times out instead of hanging", async () => {
    githubOk();
    // Emulates a server that never answers: only the provider's own abort signal can end the wait.
    const hang = async (url: string, init?: RequestInit) => {
      await new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))));
      return fakeFetch(url, init);
    };
    const app = express();
    app.use(createAuthRouter({ env: ENV, now: () => clock, providers: createProviders({ env: ENV, fetch: hang, timeoutMs: 50 }) }));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (srv.address() as { port: number }).port;
      const get = (path: string, headers: Record<string, string> = {}) =>
        new Promise<Reply>((resolve, reject) =>
          httpGet(`http://127.0.0.1:${port}${path}`, { headers }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
          }).on("error", reject),
        );
      const started = await get("/auth/github/signup");
      const st = new URL(String(started.headers["location"])).searchParams.get("state")!;
      const ck = `oauth_state=${cookieValue(started, "oauth_state")}`;
      const t0 = Date.now();
      const r = await get(`/auth/github/callback?code=c&state=${st}`, { Cookie: ck });
      expect(r.status).toBe(502);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      srv.close();
    }
  });

  test("provider failures are logged without codes, tokens or secrets", async () => {
    const logged: string[] = [];
    const { warn, error, log } = console;
    console.warn = console.error = console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      githubOk();
      routes["GET https://api.github.com/user"] = () => reply({ message: "Bad credentials" }, 401);
      await callback("github", await start("github"), { code: "super-secret-code" });
    } finally {
      Object.assign(console, { warn, error, log });
    }
    const all = logged.join("\n");
    expect(all).toContain("OAuth github failure");
    for (const secret of ["super-secret-code", "gho_secret_access_token", "gh-client-secret", SECRET]) expect(all).not.toContain(secret);
  });
});

describe("Google callback", () => {
  async function signUp(over: Record<string, unknown> = {}, key = googleKey, header?: object) {
    const s = await start("google");
    googleOk(() => googleToken(s, over, key, header));
    return { s, r: await callback("google", s) };
  }

  test("signs a new user up from a verified ID token and sets the session", async () => {
    const sub = `g-${uniqueId()}`;
    const { s, r } = await signUp({ sub });
    expect(r.status).toBe(302);
    expect(location(r)).toBe("/search");

    const exchange = calls.find((c) => c.url.endsWith("/token"))!;
    expect(Object.fromEntries(exchange.body)).toMatchObject({
      grant_type: "authorization_code",
      client_id: ENV.GOOGLE_CLIENT_ID,
      client_secret: ENV.GOOGLE_CLIENT_SECRET,
      redirect_uri: "http://localhost:8000/auth/google/callback",
      code: "auth-code",
    });
    expect(exchange.body.get("code_verifier")).toBeTruthy();
    expect(s.url.searchParams.get("nonce")).toBeTruthy();

    const user = await userStore.findByProvider("google", sub);
    expect(user).toMatchObject({ email: "gina@example.com", name: "Gina G", provider: "google" });
    const me = await request("/profile", { Cookie: `session=${cookieValue(r, "session")}` });
    expect(me.status).toBe(200);
  });

  test("accepts the bare accounts.google.com issuer and an audience array with a matching azp", async () => {
    expect((await signUp({ iss: "accounts.google.com" })).r.status).toBe(302);
    expect((await signUp({ aud: [ENV.GOOGLE_CLIENT_ID, "other"], azp: ENV.GOOGLE_CLIENT_ID })).r.status).toBe(302);
  });

  test.each([
    ["signed by a different key", () => ({ over: {}, key: otherKey })],
    ["wrong audience", () => ({ over: { aud: "someone-elses-client" } })],
    ["audience array without matching azp", () => ({ over: { aud: [ENV.GOOGLE_CLIENT_ID, "other"], azp: "other" } })],
    ["wrong issuer", () => ({ over: { iss: "https://evil.example.com" } })],
    ["expired", () => ({ over: { exp: clock - 3600 } })],
    ["issued in the future", () => ({ over: { iat: clock + 3600, exp: clock + 7200 } })],
    ["wrong nonce", () => ({ over: { nonce: "replayed-from-another-login" } })],
    ["missing nonce", () => ({ over: { nonce: undefined } })],
    ["missing subject", () => ({ over: { sub: "" } })],
    ["alg none", () => ({ over: {}, header: { alg: "none", kid: googleKey.kid }, key: { privateKey: null } as never })],
    ["alg HS256", () => ({ over: {}, header: { alg: "HS256", kid: googleKey.kid } })],
    ["unknown signing key id", () => ({ over: {}, header: { alg: "RS256", kid: "rotated-away" } })],
  ])("rejects an ID token that is %s, with a generic 502 and no user or session", async (_name, make) => {
    const spec = make() as { over: Record<string, unknown>; key?: typeof googleKey; header?: object };
    const sub = `g-${uniqueId()}`;
    const { r } = await signUp({ sub, ...spec.over }, spec.key, spec.header);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error).toBe("Sign-in with the provider failed, please try again");
    expect(cookie(r, "session")).toBeUndefined();
    expect(await userStore.findByProvider("google", sub)).toBeNull();
  });

  test("a malformed id_token string, a missing id_token and a failed exchange are all rejected", async () => {
    for (const respond of [
      () => reply({ id_token: "not-a-jwt" }),
      () => reply({ access_token: "only-an-access-token" }),
      () => reply({ error: "invalid_grant" }, 400),
    ]) {
      const s = await start("google");
      routes["POST https://oauth2.googleapis.com/token"] = respond;
      routes["GET https://www.googleapis.com/oauth2/v3/certs"] = () => reply({ keys: [googleKey.jwk] });
      expect((await callback("google", s)).status).toBe(502);
    }
  });

  test("a JWKS outage or malformed JWKS is a 502, not a pass", async () => {
    const s = await start("google");
    routes["POST https://oauth2.googleapis.com/token"] = () => reply({ id_token: googleToken(s) });
    routes["GET https://www.googleapis.com/oauth2/v3/certs"] = () => reply({}, 500);
    expect((await callback("google", s)).status).toBe(502);
    const s2 = await start("google");
    routes["POST https://oauth2.googleapis.com/token"] = () => reply({ id_token: googleToken(s2) });
    routes["GET https://www.googleapis.com/oauth2/v3/certs"] = () => reply({ nokeys: 1 });
    expect((await callback("google", s2)).status).toBe(502);
  });

  test("refetches the key set once when a token names an unknown key (rotation)", async () => {
    // First sign-in primes the key cache with key-1. Then Google rotates to key-2.
    await signUp();
    const rotated = newKey(`rotated-${++n}`);
    const s = await start("google");
    calls.length = 0;
    routes["POST https://oauth2.googleapis.com/token"] = () =>
      reply({ id_token: googleToken(s, {}, rotated, { alg: "RS256", kid: rotated.kid }) });
    routes["GET https://www.googleapis.com/oauth2/v3/certs"] = () => reply({ keys: [googleKey.jwk, rotated.jwk] });
    expect((await callback("google", s)).status).toBe(302);
    expect(calls.filter((c) => c.url.endsWith("/certs"))).toHaveLength(1);
  });

  test("an unverified Google email cannot create an account; a verified one can", async () => {
    const sub = `g-${uniqueId()}`;
    expect((await signUp({ sub, email_verified: false })).r.status).toBe(403);
    expect(await userStore.findByProvider("google", sub)).toBeNull();
    expect((await signUp({ sub, email_verified: "false" })).r.status).toBe(403);
    expect((await signUp({ sub })).r.status).toBe(302);
  });

  test("sign-in of an existing Google user works even when the email is unverified", async () => {
    const sub = `g-${uniqueId()}`;
    await signUp({ sub });
    const s = await start("google", "signin");
    googleOk(() => googleToken(s, { sub, email_verified: false }));
    expect((await callback("google", s)).status).toBe(302);
  });
});

describe("state validation", () => {
  const fresh = async () => {
    githubOk();
    return start("github");
  };
  const noProviderCalls = () => expect(calls).toHaveLength(0);

  test("no state cookie", async () => {
    const s = await fresh();
    const r = await request(`/auth/github/callback?code=c&state=${s.state}`);
    expect(r.status).toBe(400);
    noProviderCalls();
  });

  test("wrong state value", async () => {
    const s = await fresh();
    expect((await callback("github", { ...s, state: "attacker-chosen-state" })).status).toBe(400);
    noProviderCalls();
  });

  test("missing state, missing code, empty and oversized parameters", async () => {
    const s = await fresh();
    const cookieHeader = { Cookie: s.stateCookie };
    expect((await request(`/auth/github/callback?code=c`, cookieHeader)).status).toBe(400);
    expect((await request(`/auth/github/callback?state=${s.state}`, cookieHeader)).status).toBe(400);
    expect((await request(`/auth/github/callback?code=&state=${s.state}`, cookieHeader)).status).toBe(400);
    expect((await request(`/auth/github/callback?code=${"a".repeat(5000)}&state=${s.state}`, cookieHeader)).status).toBe(400);
    expect((await request(`/auth/github/callback?code[]=a&state=${s.state}`, cookieHeader)).status).toBe(400);
    noProviderCalls();
  });

  test("tampered cookie (payload edited or signature stripped)", async () => {
    const s = await fresh();
    const value = s.stateCookie.slice("oauth_state=".length);
    const [body, sig] = value.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), mode: "signin", next: "https://evil.example" })).toString("base64url");
    expect((await callback("github", { ...s, stateCookie: `oauth_state=${forged}.${sig}` })).status).toBe(400);
    expect((await callback("github", { ...s, stateCookie: `oauth_state=${body}` })).status).toBe(400);
    expect((await callback("github", { ...s, stateCookie: "oauth_state=garbage" })).status).toBe(400);
    noProviderCalls();
  });

  test("a cookie signed with another secret is refused", async () => {
    const s = await fresh();
    const app = express();
    const env = { ...ENV, SESSION_SECRET: "a-completely-different-secret-0123456789" };
    app.use(createAuthRouter({ env, now: () => clock, providers: createProviders({ env, fetch: fakeFetch }) }));
    // Forge by starting a flow on the other server and replaying its cookie against ours.
    const srv = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x));
    });
    try {
      const port = (srv.address() as { port: number }).port;
      const other = await new Promise<Reply>((resolve, reject) =>
        httpGet(`http://127.0.0.1:${port}/auth/github/signup`, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: 0, headers: res.headers, body: "" }));
        }).on("error", reject),
      );
      const foreign = `oauth_state=${cookieValue(other, "oauth_state")}`;
      const state = new URL(location(other)).searchParams.get("state")!;
      expect((await callback("github", { ...s, state, stateCookie: foreign })).status).toBe(400);
    } finally {
      srv.close();
    }
    noProviderCalls();
  });

  test("an expired state is refused", async () => {
    const s = await fresh();
    clock += 11 * 60;
    expect((await callback("github", s)).status).toBe(400);
    noProviderCalls();
  });

  test("a state started for one provider cannot complete the other provider's callback", async () => {
    const s = await fresh();
    googleOk(() => "x");
    expect((await callback("google", s)).status).toBe(400);
    noProviderCalls();
  });

  test("a callback cannot be replayed, even with the old cookie", async () => {
    const s = await fresh();
    expect((await callback("github", s)).status).toBe(302);
    const callsAfterFirst = calls.length;
    expect((await callback("github", s)).status).toBe(400);
    expect(calls).toHaveLength(callsAfterFirst);
  });

  test("the state cookie is cleared on every callback", async () => {
    const ok = await callback("github", await fresh());
    expect(cookie(ok, "oauth_state")).toMatch(/oauth_state=;/);
    const bad = await request("/auth/github/callback?code=c&state=nope");
    expect(cookie(bad, "oauth_state")).toMatch(/oauth_state=;/);
  });

  test("provider-denied authorization is a generic 403 with no provider calls", async () => {
    const s = await fresh();
    const r = await request(`/auth/github/callback?error=access_denied&error_description=The+user+said+no&state=${s.state}`, { Cookie: s.stateCookie });
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("said no");
    expect(r.body).not.toContain("access_denied");
    expect(cookie(r, "session")).toBeUndefined();
    noProviderCalls();
  });
});

describe("redirect after sign-in", () => {
  test("honours a same-site next path (kept inside the signed state)", async () => {
    githubOk();
    expect(location(await callback("github", await start("github", "signup", "?next=/profile")))).toBe("/profile");
  });

  test.each(["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "profile", ""])(
    "rejects %p and falls back to /search",
    async (next) => {
      githubOk();
      const r = await callback("github", await start("github", "signup", `?next=${encodeURIComponent(next)}`));
      expect(location(r)).toBe("/search");
    },
  );
});

describe("account isolation", () => {
  test("the same verified email on GitHub and Google makes two separate users, with no merging", async () => {
    const ghId = githubOk({ emails: [{ email: "shared@example.com", primary: true, verified: true }] });
    const gh = await callback("github", await start("github"));
    const sub = `g-${uniqueId()}`;
    const s = await start("google");
    googleOk(() => googleToken(s, { sub, email: "shared@example.com" }));
    const g = await callback("google", s);

    const ghUser = (await userStore.findByProvider("github", String(ghId)))!;
    const gUser = (await userStore.findByProvider("google", sub))!;
    expect(gUser.id).not.toBe(ghUser.id);
    const profile = async (r: Reply) => JSON.parse((await request("/profile", { Cookie: `session=${cookieValue(r, "session")}` })).body);
    expect((await profile(gh)).provider).toBe("github");
    expect((await profile(g)).provider).toBe("google");
  });

  test("a Google account claiming a GitHub user's email gets no access to that user", async () => {
    const ghId = githubOk({ emails: [{ email: "victim@example.com", primary: true, verified: true }] });
    await callback("github", await start("github"));
    const victim = (await userStore.findByProvider("github", String(ghId)))!;

    // Attacker: unverified claim -> refused outright.
    const unverifiedSub = `g-${uniqueId()}`;
    let s = await start("google");
    googleOk(() => googleToken(s, { sub: unverifiedSub, email: "victim@example.com", email_verified: false }));
    expect((await callback("google", s)).status).toBe(403);

    // Even a verified claim only creates the attacker's own separate account.
    const verifiedSub = `g-${uniqueId()}`;
    s = await start("google");
    googleOk(() => googleToken(s, { sub: verifiedSub, email: "victim@example.com" }));
    const r = await callback("google", s);
    const me = JSON.parse((await request("/profile", { Cookie: `session=${cookieValue(r, "session")}` })).body);
    expect(me.id).not.toBe(victim.id);
    expect(me.provider).toBe("google");
  });

  test("sign-in for an unknown identity is 404 and sign-up for an existing one is 409", async () => {
    const id = githubOk();
    expect((await callback("github", await start("github", "signin"))).status).toBe(404);
    expect((await callback("github", await start("github", "signup"))).status).toBe(302);
    githubOk({ id });
    expect((await callback("github", await start("github", "signup"))).status).toBe(409);
  });

  test("simultaneous sign-up callbacks for one identity create exactly one user", async () => {
    const id = githubOk();
    const [a, b] = await Promise.all([start("github"), start("github")]);
    const results = await Promise.all([callback("github", a), callback("github", b)]);
    expect(results.map((r) => r.status).sort()).toEqual([302, 409]);
    expect(await userStore.findByProvider("github", String(id))).not.toBeNull();
  });

  test("identity is the provider id: a changed email or login does not create a new user", async () => {
    const id = githubOk({ emails: [{ email: "old@example.com", primary: true, verified: true }] });
    await callback("github", await start("github", "signup"));
    githubOk({ id, login: "renamed", emails: [{ email: "new@example.com", primary: true, verified: true }] });
    const r = await callback("github", await start("github", "signin"));
    expect(r.status).toBe(302);
    expect((await userStore.findByProvider("github", String(id)))!.email).toBe("old@example.com");
  });
});
