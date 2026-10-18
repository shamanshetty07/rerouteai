import { randomBytes } from "node:crypto";
import { Router, type RequestHandler, type Response } from "express";
import { AuthError, authorizeUrl, completeOAuth, type AuthMode } from "./authservice.ts";
import { NotImplementedError, isProvider, type ProviderName } from "./providers.ts";
import { requireAuth } from "./middleware.ts";
import {
  SESSION_COOKIE,
  createSessionToken,
  readCookie,
  sessionCookieOptions,
} from "./session.ts";

const STATE_COOKIE = "oauth_state";
const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:8000";

const router = Router();

function redirectUri(provider: ProviderName): string {
  return `${BASE_URL}/auth/${provider}/callback`;
}

function startOAuth(mode: AuthMode): RequestHandler {
  return (req, res) => {
    const provider = String(req.params["provider"]);
    if (!isProvider(provider)) {
      res.status(404).json({ error: "Unknown provider" });
      return;
    }
    // State carries the mode and a nonce; the nonce cookie guards against CSRF.
    const state = `${mode}.${randomBytes(16).toString("hex")}`;
    res.cookie(STATE_COOKIE, state, { ...sessionCookieOptions, maxAge: 10 * 60 * 1000 });
    res.redirect(authorizeUrl(provider, state, redirectUri(provider)));
  };
}

router.get("/auth/:provider/signin", startOAuth("signin"));
router.get("/auth/:provider/signup", startOAuth("signup"));

router.get("/auth/:provider/callback", async (req, res) => {
  const provider = String(req.params["provider"]);
  const { code, state } = req.query;
  const savedState = readCookie(req.headers.cookie, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE);

  if (!isProvider(provider)) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  if (typeof code !== "string" || typeof state !== "string" || state !== savedState) {
    res.status(400).json({ error: "Invalid OAuth callback" });
    return;
  }

  const mode: AuthMode = state.startsWith("signup.") ? "signup" : "signin";
  try {
    const user = await completeOAuth(provider, mode, code, redirectUri(provider));
    res.cookie(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions);
    res.redirect("/profile");
  } catch (err) {
    sendAuthError(res, err);
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

function sendAuthError(res: Response, err: unknown) {
  if (err instanceof AuthError) res.status(err.status).json({ error: err.message });
  else if (err instanceof NotImplementedError) res.status(501).json({ error: err.message });
  else {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export default router;
