import { Router, type Request, type Response } from "express";
import { AuthError, authorizeUrl, completeOAuth, type AuthMode } from "./authservice.ts";
import { sendAuthFailure, type AuthFailure } from "./errorpage.ts";
import { OAUTH_STATE_COOKIE, newOAuthState, openOAuthState, sameValue, sealOAuthState } from "./oauthstate.ts";
import { ProviderError, isProvider, providers as defaultProviders, type ProviderName, type Providers } from "./providers.ts";
import { requireAuth } from "./middleware.ts";
import { safeNextPath } from "./redirect.ts";
import { SESSION_COOKIE, createSessionToken, readCookie, sessionCookieOptions } from "./session.ts";

type Env = Record<string, string | undefined>;
export type AuthRouterOptions = {
  providers?: Providers;
  env?: Env;
  /** Seconds since the epoch; injectable for expiry tests. */
  now?: () => number;
};

const MAX_PARAM_LENGTH = 2048;
const text = (value: unknown) => (typeof value === "string" && value !== "" && value.length <= MAX_PARAM_LENGTH ? value : undefined);

export function createAuthRouter({ providers = defaultProviders, env = process.env, now = () => Math.floor(Date.now() / 1000) }: AuthRouterOptions = {}) {
  const router = Router();
  const baseUrl = () => (env["BASE_URL"] ?? "http://localhost:8000").replace(/\/+$/, "");
  /** The callback URL registered with each provider: `${BASE_URL}/auth/<provider>/callback`. */
  const redirectUri = (provider: ProviderName) => `${baseUrl()}/auth/${provider}/callback`;
  // Handles already used, so a replayed callback is refused even while its cookie is still valid.
  const used = new Map<string, number>();

  const stateCookieOptions = () => ({ ...sessionCookieOptions, secure: env["NODE_ENV"] === "production" || baseUrl().startsWith("https://"), maxAge: 10 * 60 * 1000 });

  function startOAuth(mode: AuthMode) {
    return (req: Request, res: Response) => {
      const provider = String(req.params["provider"]);
      if (!isProvider(provider)) {
        return void sendAuthFailure(req, res, { status: 404, code: "not_found" }, "Unknown provider");
      }
      const unavailable: AuthFailure = { status: 503, code: "not_configured", provider };
      if (!providers[provider].isConfigured()) {
        return void sendAuthFailure(req, res, unavailable, `Sign-in with ${provider === "github" ? "GitHub" : "Google"} is not configured`);
      }
      const secret = env["SESSION_SECRET"];
      if (!secret) return void sendAuthFailure(req, res, unavailable, "Sign-in is not configured");

      const { record, challenge } = newOAuthState({ provider, mode, next: safeNextPath(req.query["next"]) }, now());
      res.cookie(OAUTH_STATE_COOKIE, sealOAuthState(record, secret), stateCookieOptions());
      res.redirect(
        authorizeUrl(provider, { state: record.state, redirectUri: redirectUri(provider), codeChallenge: challenge, nonce: record.nonce }, providers),
      );
    };
  }

  router.get("/auth/:provider/signin", startOAuth("signin"));
  router.get("/auth/:provider/signup", startOAuth("signup"));

  router.get("/auth/:provider/callback", async (req, res) => {
    const provider = String(req.params["provider"]);
    // The state cookie is single-use whatever happens next.
    res.clearCookie(OAUTH_STATE_COOKIE, { ...stateCookieOptions(), maxAge: undefined });

    if (!isProvider(provider)) {
      return void sendAuthFailure(req, res, { status: 404, code: "not_found" }, "Unknown provider");
    }
    if (req.query["error"] !== undefined) {
      // e.g. access_denied: the user declined. Neither the provider's wording nor any other query
      // value is echoed back; the page text is fixed.
      return void sendAuthFailure(req, res, { status: 403, code: "denied", provider }, "Sign-in was cancelled or denied");
    }

    const secret = env["SESSION_SECRET"];
    const code = text(req.query["code"]);
    const state = text(req.query["state"]);
    const saved = secret ? openOAuthState(readCookie(req.headers.cookie, OAUTH_STATE_COOKIE), secret, now()) : null;
    if (!code || !state || !saved || saved.provider !== provider || !sameValue(state, saved.state) || used.has(saved.state)) {
      return void sendAuthFailure(req, res, { status: 400, code: "invalid_state", provider }, "Invalid OAuth callback");
    }
    used.set(saved.state, saved.exp);
    for (const [handle, exp] of used) if (exp < now()) used.delete(handle);

    try {
      const user = await completeOAuth(
        provider,
        saved.mode,
        { code, redirectUri: redirectUri(provider), codeVerifier: saved.verifier, nonce: saved.nonce },
        providers,
      );
      res.cookie(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions);
      res.redirect(saved.next);
    } catch (err) {
      sendAuthError(req, res, err, { provider, mode: saved.mode, next: saved.next });
    }
  });

  router.post("/auth/signout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  router.get(["/profile", "/me"], requireAuth, (req, res) => {
    const { id, email, name, provider } = req.user!;
    res.json({ id, email, name, provider });
  });

  return router;
}

type Context = Pick<AuthFailure, "provider" | "mode" | "next">;

function sendAuthError(req: Request, res: Response, err: unknown, ctx: Context) {
  if (err instanceof AuthError) sendAuthFailure(req, res, { status: err.status, code: err.code, ...ctx }, err.message);
  else if (err instanceof ProviderError) {
    // Operators get the stage and status only: never codes, tokens, secrets or provider bodies.
    console.warn(`OAuth ${err.provider} failure at "${err.stage}"${err.status ? ` (HTTP ${err.status})` : ""}`);
    sendAuthFailure(req, res, { status: 502, code: "provider_error", ...ctx }, err.message);
  } else {
    console.error(err);
    sendAuthFailure(req, res, { status: 500, code: "internal", ...ctx }, "Internal server error");
  }
}

export default createAuthRouter();
