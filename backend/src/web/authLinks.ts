// Sign-in and sign-up choices shown when the API answers 401. Each is a plain link into the
// server's OAuth flow (/auth/<provider>/<signin|signup>), which owns state, PKCE and validation.

type Provider = "github" | "google";
type Mode = "signin" | "signup";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google" },
];

export const authHref = (provider: Provider, mode: Mode) => `/auth/${provider}/${mode}`;

function group(mode: Mode, headingId: string, heading: string, hint: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "auth-group";
  const h = Object.assign(document.createElement("h3"), { id: headingId, textContent: heading });
  const p = Object.assign(document.createElement("p"), { textContent: hint });
  const links = document.createElement("div");
  links.className = "auth-links";
  links.setAttribute("role", "group");
  links.setAttribute("aria-labelledby", headingId);
  const verb = mode === "signin" ? "Sign in" : "Sign up";
  for (const { id, label } of PROVIDERS) {
    const a = document.createElement("a");
    a.href = authHref(id, mode);
    a.textContent = `${verb} with ${label}`;
    a.className = mode === "signin" ? "button" : "button secondary";
    links.append(a);
  }
  section.append(h, p, links);
  return section;
}

/** Fills the (initially hidden) container and reveals it. */
export function showAuthPrompt(container: HTMLElement) {
  container.replaceChildren(
    group("signin", "auth-signin-title", "Already have an account?", "Sign in with the provider you used before."),
    group("signup", "auth-signup-title", "New to Reroute?", "Create your account with GitHub or Google. We never create a password."),
  );
  container.hidden = false;
}

export function hideAuthPrompt(container: HTMLElement) {
  container.hidden = true;
  container.replaceChildren();
}
