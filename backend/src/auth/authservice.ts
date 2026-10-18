import { providers, type OAuthProfile, type ProviderName } from "./providers.ts";
import { userStore, type User } from "./userstore.ts";

export type AuthMode = "signin" | "signup";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function authorizeUrl(provider: ProviderName, state: string, redirectUri: string): string {
  return providers[provider].authorizeUrl(state, redirectUri);
}

/** Completes an OAuth callback: signin needs an existing account, signup creates one. */
export async function completeOAuth(
  provider: ProviderName,
  mode: AuthMode,
  code: string,
  redirectUri: string,
): Promise<User> {
  const profile: OAuthProfile = await providers[provider].fetchProfile(code, redirectUri);
  const existing = await userStore.findByProvider(provider, profile.providerId);

  if (mode === "signin") {
    if (!existing) throw new AuthError("No account found, sign up first", 404);
    return existing;
  }
  if (existing) throw new AuthError("Account already exists, sign in instead", 409);

  return userStore.create({
    email: profile.email,
    name: profile.name ?? null,
    provider,
    providerId: profile.providerId,
  });
}

export function getUser(id: number): Promise<User | null> {
  return userStore.findById(id);
}
