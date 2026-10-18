import type { RequestHandler } from "express";
import { getUser } from "./authservice.ts";
import { SESSION_COOKIE, readCookie, verifySessionToken } from "./session.ts";
import type { User } from "./userstore.ts";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Reads the JWT from `Authorization: Bearer <token>` or the session cookie. */
function extractToken(authorization: string | undefined, cookies: string | undefined) {
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return readCookie(cookies, SESSION_COOKIE);
}

/** Rejects with 401 unless the request carries a valid JWT for an existing user. */
export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const userId = verifySessionToken(extractToken(req.headers.authorization, req.headers.cookie));
    const user = userId === null ? null : await getUser(userId);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};
