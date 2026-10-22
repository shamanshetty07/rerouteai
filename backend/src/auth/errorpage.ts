import type { Request, Response } from "express";
import type { AuthMode } from "./authservice.ts";
import type { ProviderName } from "./providers.ts";

// Friendly page for OAuth failures that happen in the browser (the provider redirects the user
// back to us, so a JSON body would be shown raw). Every string on it is fixed here: nothing from
// the query string, the provider or an exception is ever put into the HTML.

export type AuthFailureCode =
  | "denied"
  | "no_account"
  | "account_exists"
  | "unverified_email"
  | "not_configured"
  | "provider_error"
  | "invalid_state"
  | "not_found"
  | "internal";

export type AuthFailure = {
  status: number;
  code: AuthFailureCode;
  /** Only ever a validated provider name. */
  provider?: ProviderName;
  /** Known only when the signed state cookie was valid. */
  mode?: AuthMode;
  /** An already-validated same-site path. */
  next?: string;
};

const PROVIDER_LABEL: Record<ProviderName, string> = { github: "GitHub", google: "Google" };

type Content = { title: string; message: string; actions: "signin" | "signup" | "retry" | "none" };

function content(code: AuthFailureCode, provider: string): Content {
  switch (code) {
    case "denied":
      return { title: "Sign-in cancelled", message: `You didn't approve access on ${provider}, so nothing was changed. You can try again whenever you like.`, actions: "retry" };
    case "no_account":
      return { title: "No account yet", message: `We couldn't find a Reroute account for this ${provider} login. Sign up to create one.`, actions: "signup" };
    case "account_exists":
      return { title: "You already have an account", message: `This ${provider} login is already registered with Reroute. Sign in instead.`, actions: "signin" };
    case "unverified_email":
      return { title: "Verified email needed", message: `${provider} didn't report a verified email address for this login. Verify an email with ${provider}, then try again.`, actions: "retry" };
    case "not_configured":
      return { title: "Sign-in unavailable", message: "This sign-in method isn't set up on this server yet. Try another method or come back later.", actions: "none" };
    case "provider_error":
      return { title: `${provider} isn't responding`, message: `We couldn't finish signing you in with ${provider}. Please try again in a moment.`, actions: "retry" };
    case "invalid_state":
      return { title: "That sign-in link has expired", message: "The sign-in attempt is no longer valid, usually because it took too long or was opened twice. Please start again.", actions: "retry" };
    case "not_found":
      return { title: "Unknown sign-in method", message: "That sign-in method doesn't exist.", actions: "none" };
    case "internal":
      return { title: "Something went wrong", message: "We couldn't sign you in because of a problem on our side. Please try again.", actions: "retry" };
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function link(provider: ProviderName, mode: AuthMode, next: string | undefined, primary: boolean) {
  const query = next && next !== "/search" ? `?next=${encodeURIComponent(next)}` : "";
  const verb = mode === "signin" ? "Sign in" : "Sign up";
  const href = `/auth/${provider}/${mode}${query}`;
  return `<a class="${primary ? "button" : "button secondary"}" href="${escape(href)}">${verb} with ${PROVIDER_LABEL[provider]}</a>`;
}

export function renderAuthErrorPage(failure: AuthFailure): string {
  const { provider, mode, next } = failure;
  const c = content(failure.code, provider ? PROVIDER_LABEL[provider] : "the provider");

  const links: string[] = [];
  if (provider && c.actions !== "none") {
    // Suggest the fitting next step first; when the mode is unknown, offer both.
    const order: AuthMode[] =
      c.actions === "signup" ? ["signup"] : c.actions === "signin" ? ["signin"] : mode ? [mode] : ["signin", "signup"];
    order.forEach((m, i) => links.push(link(provider, m, next, i === 0)));
  }
  links.push(`<a class="button secondary" href="${escape(next ?? "/search")}">Back to search</a>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(c.title)} · Reroute</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --fg:#1c1c1a; --muted:#6b6b66; --card:#fff; --line:#dcdcd6; --accent:#1d4ed8; --on-accent:#fff; --err:#b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151514; --fg:#ececea; --muted:#9a9a94; --card:#1f1f1d; --line:#34342f; --accent:#6b93ff; --on-accent:#0b1020; --err:#ff8a7a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { max-width:560px; margin:0 auto; padding:48px 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  h1 { font-size:1.375rem; margin:0 0 8px; }
  p { margin:0 0 20px; color:var(--muted); }
  .brand { display:block; margin-bottom:16px; color:var(--muted); font-size:.875rem; }
  .actions { display:flex; flex-wrap:wrap; gap:12px; }
  .button { display:inline-block; padding:10px 18px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:var(--on-accent); text-decoration:none; font:inherit; }
  .button.secondary { background:transparent; color:var(--accent); }
  .button:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
  .status { color:var(--err); font-size:.8125rem; margin-bottom:4px; }
</style>
</head>
<body>
<main>
  <span class="brand">Reroute</span>
  <div class="card" role="alert">
    <div class="status">Sign-in problem</div>
    <h1>${escape(c.title)}</h1>
    <p>${escape(c.message)}</p>
    <div class="actions">${links.join("\n    ")}</div>
  </div>
</main>
</body>
</html>`;
}

/** Browsers navigating from a provider ask for HTML; API clients and tests get the original JSON. */
export const wantsHtml = (req: Request) => (req.headers.accept ?? "").includes("text/html");

export function sendAuthFailure(req: Request, res: Response, failure: AuthFailure, jsonMessage: string, extra?: Record<string, unknown>) {
  res.status(failure.status);
  if (!wantsHtml(req)) return void res.json({ error: jsonMessage, ...extra });
  res
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    })
    .send(renderAuthErrorPage(failure));
}
