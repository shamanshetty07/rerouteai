import { providers as defaultProviders, type AuthorizeParams, type ProfileParams, type ProviderName, type Providers } from "./providers.ts";
import { DuplicateUserError, userStore, type User } from "./userstore.ts";

export type AuthMode = "signin" | "signup";

export type AuthErrorCode = "no_account" | "account_exists" | "unverified_email";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: AuthErrorCode,
  ) {
    super(message);
  }
}

export function authorizeUrl(provider: ProviderName, params: AuthorizeParams, providers: Providers = defaultProviders): string {
  return providers[provider].authorizeUrl(params);
}

/**
 * Completes an OAuth callback: signin needs an existing account, signup creates one.
 * Accounts are found only by (provider, stable provider id), never by email, so a GitHub and a
 * Google login with the same address stay separate users and an email can't claim someone's account.
 */
export async function completeOAuth(
  provider: ProviderName,
  mode: AuthMode,
  params: ProfileParams,
  providers: Providers = defaultProviders,
): Promise<User> {
  const profile = await providers[provider].fetchProfile(params);
  const existing = await userStore.findByProvider(provider, profile.providerId);

  if (mode === "signin") {
    if (!existing) throw new AuthError("No account found, sign up first", 404, "no_account");
    return existing;
  }
  if (existing) throw new AuthError("Account already exists, sign in instead", 409, "account_exists");
  // A new account needs an address the provider has verified; an unverified one proves nothing.
  if (!profile.email) throw new AuthError("Your account has no verified email address", 403, "unverified_email");

  try {
    return await userStore.create({
      email: profile.email,
      name: profile.name ?? null,
      provider,
      providerId: profile.providerId,
    });
  } catch (err) {
    // Two simultaneous sign-ups for one identity: the database's unique key picks the winner.
    if (err instanceof DuplicateUserError) throw new AuthError("Account already exists, sign in instead", 409, "account_exists");
    throw err;
  }
}

export function getUser(id: number): Promise<User | null> {
  return userStore.findById(id);
}
