// Sign-in and sign-up choices shown when the API answers 401. Each is a plain link into the
// backend's OAuth flow (/auth/<provider>/<signin|signup>), which owns state, PKCE and validation.

type Provider = "github" | "google";
type Mode = "signin" | "signup";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google" },
];

/** `next` brings the user back to the page they were on. */
export const authHref = (provider: Provider, mode: Mode, next?: string) =>
  `/auth/${provider}/${mode}${next ? `?next=${encodeURIComponent(next)}` : ""}`;

function Group({ mode, id, heading, hint, next }: { mode: Mode; id: string; heading: string; hint: string; next?: string }) {
  const verb = mode === "signin" ? "Sign in" : "Sign up";
  return (
    <div className="auth-group">
      <h3 id={id}>{heading}</h3>
      <p>{hint}</p>
      <div className="auth-links" role="group" aria-labelledby={id}>
        {PROVIDERS.map(({ id: provider, label }) => (
          // Full-page navigation on purpose: this is a redirect flow, not a client route.
          <a key={provider} href={authHref(provider, mode, next)} className={mode === "signin" ? "button" : "button secondary"}>
            {verb} with {label}
          </a>
        ))}
      </div>
    </div>
  );
}

export function AuthPrompt({ next }: { next?: string }) {
  return (
    <section id="auth-prompt" className="cad" aria-label="Sign in or sign up">
      <Group mode="signin" id="auth-signin-title" heading="Already have an account?" hint="Sign in with the provider you used before." next={next} />
      <Group
        mode="signup"
        id="auth-signup-title"
        heading="New to Reroute?"
        hint="Create your account with GitHub or Google. We never create a password."
        next={next}
      />
    </section>
  );
}
