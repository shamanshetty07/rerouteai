import { createPublicKey, verify, type webcrypto } from "node:crypto";

export type ProviderName = "github" | "google";

export type OAuthProfile = {
  /** The provider's stable user id (GitHub numeric id, Google `sub`). The only thing that identifies the account. */
  providerId: string;
  /** Provider-verified email, or null when the provider did not vouch for one. Never used to find or link accounts. */
  email: string | null;
  name?: string;
};

export type AuthorizeParams = { state: string; redirectUri: string; codeChallenge: string; nonce: string };
export type ProfileParams = { code: string; redirectUri: string; codeVerifier: string; nonce: string };

export type OAuthProvider = {
  /** False until both the client id and secret are set. */
  isConfigured(): boolean;
  /** URL the user is redirected to in order to approve access. */
  authorizeUrl(params: AuthorizeParams): string;
  /** Exchange the callback `code` for the user's verified identity. */
  fetchProfile(params: ProfileParams): Promise<OAuthProfile>;
};

/** A provider call failed or returned something unusable. The message is safe to show; details go to `stage`/`status`. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly stage: string,
    readonly status?: number,
  ) {
    super("Sign-in with the provider failed, please try again");
  }
}

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type ProviderOptions = {
  env?: Env;
  fetch?: Fetch;
  /** Seconds since the epoch; injectable for token-expiry tests. */
  now?: () => number;
  timeoutMs?: number;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function client(provider: ProviderName, opts: ProviderOptions) {
  const env = opts.env ?? process.env;
  const prefix = provider.toUpperCase();
  const id = env[`${prefix}_CLIENT_ID`] ?? "";
  const secret = env[`${prefix}_CLIENT_SECRET`] ?? "";
  // Looked up per call so tests (and `fetch` replacements) take effect after import.
  const http: Fetch = (url, init) =>
    (opts.fetch ?? ((u, i) => globalThis.fetch(u, i)))(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });

  async function json(stage: string, url: string, init?: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await http(url, init);
    } catch {
      throw new ProviderError(provider, `${stage}: request failed or timed out`);
    }
    if (!res.ok) throw new ProviderError(provider, `${stage}: HTTP error`, res.status);
    try {
      return await res.json();
    } catch {
      throw new ProviderError(provider, `${stage}: malformed JSON`);
    }
  }
  return { id, secret, configured: id !== "" && secret !== "", json };
}

// ---------------------------------------------------------------------------------------------
// GitHub

const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "reroute",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

export function createGithubProvider(opts: ProviderOptions = {}): OAuthProvider {
  const c = client("github", opts);
  const fail = (stage: string) => new ProviderError("github", stage);

  return {
    isConfigured: () => c.configured,
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const params = new URLSearchParams({
        client_id: c.id,
        redirect_uri: redirectUri,
        scope: "read:user user:email",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `https://github.com/login/oauth/authorize?${params}`;
    },
    async fetchProfile({ code, redirectUri, codeVerifier }) {
      const token = await c.json("token exchange", "https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.id,
          client_secret: c.secret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      // GitHub reports a bad or reused code as HTTP 200 with an `error` field.
      if (!isObject(token) || typeof token["access_token"] !== "string" || token["access_token"] === "") {
        throw fail("token exchange: no access token");
      }
      const auth = { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token["access_token"]}` };

      const user = await c.json("profile", "https://api.github.com/user", { headers: auth });
      if (!isObject(user) || !Number.isSafeInteger(user["id"]) || (user["id"] as number) <= 0) throw fail("profile: bad id");
      const name = typeof user["name"] === "string" && user["name"] !== "" ? user["name"] : typeof user["login"] === "string" ? user["login"] : undefined;

      // The profile's own `email` is user-editable and unverified, so it is ignored: only an address
      // GitHub reports as verified counts, preferring the primary one.
      const emails = await c.json("emails", "https://api.github.com/user/emails", { headers: auth });
      if (!Array.isArray(emails)) throw fail("emails: malformed");
      const verified = emails.filter(
        (e): e is { email: string; verified: true; primary?: boolean } =>
          isObject(e) && e["verified"] === true && typeof e["email"] === "string" && e["email"] !== "",
      );
      const email = (verified.find((e) => e.primary === true) ?? verified[0])?.email ?? null;

      return { providerId: String(user["id"]), email, ...(name && { name }) };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Google (OpenID Connect)

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CLOCK_SKEW_SECONDS = 60;

type Jwk = webcrypto.JsonWebKey & { kid?: string };

export function createGoogleProvider(opts: ProviderOptions = {}): OAuthProvider {
  const c = client("google", opts);
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const fail = (stage: string) => new ProviderError("google", stage);
  let keys: { jwks: Jwk[]; fetchedAt: number } | undefined;

  async function signingKey(kid: string, forceRefresh: boolean): Promise<Jwk | undefined> {
    if (!keys || forceRefresh || now() - keys.fetchedAt > 3600) {
      const body = await c.json("jwks", GOOGLE_JWKS_URL);
      if (!isObject(body) || !Array.isArray(body["keys"])) throw fail("jwks: malformed");
      keys = { jwks: body["keys"] as Jwk[], fetchedAt: now() };
    }
    return keys.jwks.find((k) => k.kid === kid && k.kty === "RSA");
  }

  /** Verifies signature, issuer, audience, expiry and nonce; returns the claims. */
  async function verifyIdToken(idToken: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw fail("id_token: not a JWT");
    const [h, p, s] = parts as [string, string, string];
    let header: unknown;
    let claims: unknown;
    try {
      header = JSON.parse(Buffer.from(h, "base64url").toString());
      claims = JSON.parse(Buffer.from(p, "base64url").toString());
    } catch {
      throw fail("id_token: undecodable");
    }
    // Only RS256 is accepted, so `alg: none` and HMAC-with-public-key tricks are impossible.
    if (!isObject(header) || header["alg"] !== "RS256" || typeof header["kid"] !== "string") throw fail("id_token: bad header");
    if (!isObject(claims)) throw fail("id_token: bad claims");

    let jwk = await signingKey(header["kid"], false);
    jwk ??= await signingKey(header["kid"], true); // keys rotate; look once more before giving up
    if (!jwk) throw fail("id_token: unknown signing key");
    let valid = false;
    try {
      valid = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
    } catch {
      valid = false;
    }
    if (!valid) throw fail("id_token: bad signature");

    if (typeof claims["iss"] !== "string" || !GOOGLE_ISSUERS.has(claims["iss"])) throw fail("id_token: wrong issuer");
    const aud = claims["aud"];
    if (!(aud === c.id || (Array.isArray(aud) && aud.includes(c.id) && claims["azp"] === c.id))) throw fail("id_token: wrong audience");
    if (typeof claims["exp"] !== "number" || claims["exp"] + CLOCK_SKEW_SECONDS < now()) throw fail("id_token: expired");
    if (typeof claims["iat"] === "number" && claims["iat"] - CLOCK_SKEW_SECONDS > now()) throw fail("id_token: issued in the future");
    if (claims["nonce"] !== nonce) throw fail("id_token: nonce mismatch");
    return claims;
  }

  return {
    isConfigured: () => c.configured,
    authorizeUrl({ state, redirectUri, codeChallenge, nonce }) {
      const params = new URLSearchParams({
        client_id: c.id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },
    async fetchProfile({ code, redirectUri, codeVerifier, nonce }) {
      const token = await c.json("token exchange", "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.id,
          client_secret: c.secret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }),
      });
      if (!isObject(token) || typeof token["id_token"] !== "string") throw fail("token exchange: no id_token");

      const claims = await verifyIdToken(token["id_token"], nonce);
      const sub = claims["sub"];
      if (typeof sub !== "string" || sub === "") throw fail("id_token: no subject");
      const verified = claims["email_verified"] === true || claims["email_verified"] === "true";
      const email = verified && typeof claims["email"] === "string" && claims["email"] !== "" ? claims["email"] : null;
      const name = typeof claims["name"] === "string" && claims["name"] !== "" ? claims["name"] : undefined;
      return { providerId: sub, email, ...(name && { name }) };
    },
  };
}

export type Providers = Record<ProviderName, OAuthProvider>;

export function createProviders(opts: ProviderOptions = {}): Providers {
  return { github: createGithubProvider(opts), google: createGoogleProvider(opts) };
}

export const providers: Providers = createProviders();

export function isProvider(name: string): name is ProviderName {
  return Object.hasOwn(providers, name);
}
