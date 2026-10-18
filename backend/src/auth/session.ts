import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function secret(): string {
  const value = process.env["SESSION_SECRET"];
  if (!value) throw new Error("SESSION_SECRET is not set");
  return value;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

/** Issues an HS256 JWT whose `sub` is the user id. */
export function createSessionToken(userId: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: String(userId), iat: now, exp: now + MAX_AGE_SECONDS }),
  ).toString("base64url");
  const data = `${HEADER}.${payload}`;
  return `${data}.${sign(data)}`;
}

/** Returns the user id, or null if the token is malformed, forged or expired. */
export function verifySessionToken(token: string | undefined): number | null {
  const parts = token?.split(".");
  if (parts?.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  // Only accept the exact header we issue, which rules out `alg: none` and algorithm swaps.
  if (header !== HEADER) return null;

  const expected = Buffer.from(sign(`${header}.${payload}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const id = Number(claims.sub);
    if (!Number.isInteger(id) || typeof claims.exp !== "number") return null;
    if (claims.exp < Date.now() / 1000) return null;
    return id;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env["NODE_ENV"] === "production",
  maxAge: MAX_AGE_SECONDS * 1000,
} as const;

/** Minimal cookie reader so we don't need cookie-parser. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
