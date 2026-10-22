type Env = Record<string, string | undefined>;

const PLACEHOLDERS = new Set(["change-me", "changeme", "secret", "password"]);

/** In production the server must not start with a missing or guessable signing key or a non-HTTPS public URL. */
export function assertAuthConfig(env: Env = process.env) {
  if (env["NODE_ENV"]?.trim().toLowerCase() !== "production") return;
  const secret = env["SESSION_SECRET"] ?? "";
  if (secret.length < 32 || PLACEHOLDERS.has(secret.toLowerCase())) {
    throw new Error("Refusing to start: SESSION_SECRET must be a random string of at least 32 characters in production");
  }
  const base = env["BASE_URL"] ?? "";
  if (!base.startsWith("https://")) {
    throw new Error("Refusing to start: BASE_URL must be the public https:// URL of this server in production");
  }
}
