import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthMode } from "./authservice.ts";
import type { ProviderName } from "./providers.ts";

// The OAuth "state" is a one-time record kept in a signed, HttpOnly cookie. The `state` value sent
// to the provider is only a random handle: the callback must present the same handle AND a valid
// cookie, which ties the callback to the browser that started the sign-in (login-CSRF defence).

export const OAUTH_STATE_COOKIE = "oauth_state";
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export type OAuthState = {
  provider: ProviderName;
  mode: AuthMode;
  /** Random handle echoed back by the provider as `state`. */
  state: string;
  /** Bound into the Google ID token to stop token replay. */
  nonce: string;
  /** PKCE secret; the provider only ever sees its SHA-256 challenge until the code exchange. */
  verifier: string;
  /** Where to send the user after signing in; already validated as a same-site path. */
  next: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
};

const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function newOAuthState(
  init: Pick<OAuthState, "provider" | "mode" | "next">,
  nowSeconds: number,
): { record: OAuthState; challenge: string } {
  const verifier = random(48);
  return {
    record: { ...init, state: random(), nonce: random(), verifier, exp: nowSeconds + OAUTH_STATE_TTL_SECONDS },
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

const mac = (secret: string, data: string) => createHmac("sha256", `oauth-state:${secret}`).update(data).digest("base64url");

export function sealOAuthState(record: OAuthState, secret: string): string {
  const body = Buffer.from(JSON.stringify(record)).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Returns the record only if the cookie is untampered, unexpired and shaped as issued. */
export function openOAuthState(cookie: string | undefined, secret: string, nowSeconds: number): OAuthState | null {
  const parts = cookie?.split(".");
  if (parts?.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  if (!equal(signature, mac(secret, body))) return null;
  try {
    const r = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<OAuthState>;
    const strings = [r.state, r.nonce, r.verifier, r.next];
    if (!strings.every((s) => typeof s === "string" && s !== "")) return null;
    if (r.provider !== "github" && r.provider !== "google") return null;
    if (r.mode !== "signin" && r.mode !== "signup") return null;
    if (typeof r.exp !== "number" || r.exp < nowSeconds) return null;
    return r as OAuthState;
  } catch {
    return null;
  }
}

export const sameValue = equal;
