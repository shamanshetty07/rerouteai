export type ProviderName = "github" | "google";

export type OAuthProfile = {
  providerId: string;
  email: string;
  name?: string;
};

export type OAuthProvider = {
  /** URL the user is redirected to in order to approve access. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchange the callback `code` for the user's profile. */
  fetchProfile(code: string, redirectUri: string): Promise<OAuthProfile>;
};

export class NotImplementedError extends Error {}

function env(name: string): string {
  return process.env[name] ?? "";
}

const github: OAuthProvider = {
  authorizeUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: env("GITHUB_CLIENT_ID"),
      redirect_uri: redirectUri,
      scope: "read:user user:email",
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },
  async fetchProfile() {
    // TODO: POST https://github.com/login/oauth/access_token, then GET https://api.github.com/user
    throw new NotImplementedError("GitHub token exchange is not wired up yet");
  },
};

const google: OAuthProvider = {
  authorizeUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },
  async fetchProfile() {
    // TODO: POST https://oauth2.googleapis.com/token, then GET https://openidconnect.googleapis.com/v1/userinfo
    throw new NotImplementedError("Google token exchange is not wired up yet");
  },
};

export const providers: Record<ProviderName, OAuthProvider> = { github, google };

export function isProvider(name: string): name is ProviderName {
  return name in providers;
}
