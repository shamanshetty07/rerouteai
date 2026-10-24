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
  :root { color-scheme: light dark; --bg:#f5f3ee; --fg:#0c1a36; --muted:#5d6679; --card:#fff; --line:#e4dfd3; --blue:#2a56f5; --blue-soft:#e8edff; --on-blue:#fff; --err:#b3261e; --err-soft:#fdecea; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#080f22; --fg:#e9eefb; --muted:#9eaac8; --card:#0f1a38; --line:#22305a; --blue:#6a8dff; --blue-soft:#16265a; --on-blue:#06122e; --err:#ff9188; --err-soft:#35161a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--fg); font:16px/1.55 "SF Pro Display","SF Pro Text",Inter,"Segoe UI",Roboto,system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  .band { position:relative; overflow:hidden; background:linear-gradient(120deg, #0a1733 40%, #16327a 100%); height:200px; }
  .band::after { content:""; position:absolute; left:0; right:0; bottom:14px; height:2px; background:rgb(255 255 255 / .35); }
  .band::before { content:""; position:absolute; left:0; right:0; bottom:0; height:10px; background:repeating-linear-gradient(90deg, rgb(255 255 255 / .2) 0 8px, transparent 8px 40px); animation:sleepers 1s linear infinite; }
  @keyframes sleepers { to { background-position:-40px 0; } }
  main { width:min(560px, 100% - 32px); margin:-92px auto 0; padding-bottom:48px; position:relative; }
  .brand { display:inline-flex; align-items:center; gap:10px; margin:0 0 20px; color:#fff; font-weight:700; font-size:1.25rem; letter-spacing:-.02em; text-decoration:none; }
  .mark { width:34px; height:34px; border-radius:11px; background:var(--blue); display:grid; place-items:center; }
  .mark svg { width:20px; height:20px; fill:none; stroke:var(--on-blue); stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:22px; padding:28px; box-shadow:0 2px 6px rgb(6 15 38 / .1), 0 32px 64px -24px rgb(6 15 38 / .45); }
  .status { display:inline-flex; align-items:center; gap:8px; padding:4px 12px 4px 8px; margin-bottom:14px; border-radius:999px; background:var(--err-soft); color:var(--err); font-size:.8125rem; font-weight:650; }
  .status::before { content:"!"; width:18px; height:18px; border-radius:50%; background:var(--err); color:var(--card); font:700 12px/18px system-ui,sans-serif; text-align:center; }
  h1 { margin:0 0 8px; font-size:1.625rem; line-height:1.15; letter-spacing:-.025em; }
  p { margin:0 0 24px; color:var(--muted); }
  .actions { display:flex; flex-wrap:wrap; gap:12px; }
  .button { display:inline-flex; align-items:center; justify-content:center; min-height:46px; padding:0 20px; border-radius:12px; border:1.5px solid var(--blue); background:var(--blue); color:var(--on-blue); text-decoration:none; font:inherit; font-weight:600; font-size:.9375rem; transition:background .2s; }
  .button.secondary { background:transparent; color:var(--blue); }
  .button.secondary:hover { background:var(--blue-soft); }
  .button:focus-visible, .brand:focus-visible { outline:3px solid var(--blue); outline-offset:3px; }
  @media (max-width:480px) { .actions .button { flex:1 1 100%; } .card { padding:22px 18px; } }
  @media (prefers-reduced-motion: reduce) { .band::before { animation:none; } }
</style>
</head>
<body>
<div class="band" aria-hidden="true"></div>
<main>
  <a class="brand" href="/search"><span class="mark"><svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M6 15.8V12a4 4 0 0 1 4-4h4"/></svg></span>Reroute</a>
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
