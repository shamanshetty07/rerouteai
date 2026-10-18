import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function secret(): string {
  const value = process.env["SESSION_SECRET"];
  if (!value) throw new Error("SESSION_SECRET is not set");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Token format: `<userId>.<expiresAtMs>.<signature>` */
export function createSessionToken(userId: number): string {
  const payload = `${userId}.${Date.now() + MAX_AGE_SECONDS * 1000}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the user id, or null if the token is malformed, forged or expired. */
export function verifySessionToken(token: string | undefined): number | null {
  const parts = token?.split(".");
  if (parts?.length !== 3) return null;
  const [id, expiresAt, signature] = parts as [string, string, string];

  const expected = Buffer.from(sign(`${id}.${expiresAt}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (Number(expiresAt) < Date.now()) return null;
  return Number(id);
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
