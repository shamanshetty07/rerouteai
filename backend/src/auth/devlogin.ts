import { Router } from "express";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from "./session.ts";
import { safeNextPath } from "./redirect.ts";
import { DuplicateUserError, userStore, type User } from "./userstore.ts";

// Development-only sign-in for working on authenticated pages without OAuth credentials.
// Off unless DEV_LOGIN=true, never allowed in production, and it signs in one fixed,
// clearly labelled user: no request input picks the account, so nobody can be impersonated.

type Env = Record<string, string | undefined>;

const DEV_USER = {
  email: "dev-user@reroute.invalid",
  name: "Development User",
  provider: "dev",
  providerId: "reroute-dev-login",
} as const;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const devLoginEnabled = (env: Env = process.env) => env["DEV_LOGIN"] === "true";

const isProduction = (env: Env) => env["NODE_ENV"]?.trim().toLowerCase() === "production";

/** Throws, so the server never starts, when the dev login is switched on in production. */
export function assertDevLoginSafe(env: Env = process.env) {
  if (devLoginEnabled(env) && isProduction(env)) {
    throw new Error("Refusing to start: DEV_LOGIN=true is not allowed when NODE_ENV=production");
  }
}

async function devUser(): Promise<User> {
  const existing = await userStore.findByProvider(DEV_USER.provider, DEV_USER.providerId);
  if (existing) return existing;
  try {
    return await userStore.create({ ...DEV_USER });
  } catch (err) {
    // A concurrent first login created it between our lookup and insert.
    const created = err instanceof DuplicateUserError && (await userStore.findByProvider(DEV_USER.provider, DEV_USER.providerId));
    if (created) return created;
    throw err;
  }
}

/** The peer's socket address, not the Host header, which any client can forge. */
export const isLoopbackAddress = (address: string | undefined) => address !== undefined && LOOPBACK_ADDRESSES.has(address);

/** An empty router unless the dev login is enabled, so the route simply does not exist otherwise. */
export function createDevLoginRouter(env: Env = process.env): Router {
  const router = Router();
  assertDevLoginSafe(env);
  if (!devLoginEnabled(env)) return router;

  console.warn("DEV_LOGIN is enabled: GET /auth/dev/login signs in a development user. Local use only.");

  /** GET /auth/dev/login[?next=/search] -> sets the normal session cookie and redirects. */
  router.get("/auth/dev/login", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Development login is only available from the local machine" });
      return;
    }
    // The signing key comes from the environment like every other session; never a built-in default.
    if (!env["SESSION_SECRET"]) {
      res.status(503).json({ error: "Set SESSION_SECRET (e.g. `openssl rand -hex 32`) to use the development login" });
      return;
    }
    const user = await devUser();
    res.cookie(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions);
    res.redirect(safeNextPath(req.query["next"]));
  });

  return router;
}
