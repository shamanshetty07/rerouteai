import { el, fetchAlternatives, formatDuration, renderJourneys } from "./alternatives.ts";
import { hideAuthPrompt, showAuthPrompt } from "./authLinks.ts";
import { createSaveFooter, initSavedView } from "./savedView.ts";
import { initSearchForm, type SearchValues } from "./searchForm.ts";
import { mockStationSource } from "./stations/stationSource.ts";

const form = document.getElementById("search-form") as HTMLFormElement;
const submit = document.getElementById("submit") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const results = document.getElementById("results")!;
const authPrompt = document.getElementById("auth-prompt")!;
const resultsNote = document.getElementById("results-note")!;
const submitLabel = document.getElementById("submit-label")!;
const modeHint = document.getElementById("mode-hint")!;
const modeInput = () => [...form.querySelectorAll<HTMLInputElement>('input[name="mode"]')].find((r) => r.checked)!;

// Time and transfer limit only apply to alternative-journey search.
function syncMode() {
  const alternatives = modeInput().value === "alternatives";
  for (const field of form.querySelectorAll<HTMLElement>("[data-alt-only]")) field.hidden = !alternatives;
  submitLabel.textContent = alternatives ? "Find journeys" : "Search trains";
  modeHint.textContent = alternatives
    ? "Connecting journeys with up to four changes, ranked best first."
    : "Trains that run straight from your source to your destination on that date.";
}
form.addEventListener("change", (e) => {
  if ((e.target as HTMLElement).getAttribute("name") === "mode") {
    syncMode();
    clearResults();
    setStatus("");
  }
});

function clearResults() {
  results.replaceChildren();
  resultsNote.hidden = true;
}

/** Placeholder cards while the first results load. Decorative, so hidden from assistive technology. */
function showSkeleton() {
  const wrap = el("div");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.display = "contents";
  for (let i = 0; i < 3; i++) wrap.append(el("div", "skeleton"));
  results.replaceChildren(wrap);
}

type StatusState = "loading" | "ok" | "info";

function setStatus(message: string, isError = false, state?: StatusState) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
  if (state && !isError) statusEl.dataset["state"] = state;
  else delete statusEl.dataset["state"];
}

function needSignIn() {
  setStatus("Please sign in to search trains.", true);
  showAuthPrompt(authPrompt);
}

type TrainRow = {
  train: { number: string; name: string; runDays: string[] };
  from: { departure: string };
  to: { arrival: string };
  duration: number;
};
type TrainsResponse = { from: { name: string }; to: { name: string }; trains: TrainRow[] };

const cell = (text: string, label: string) => {
  const td = Object.assign(document.createElement("td"), { textContent: text });
  td.dataset["label"] = label; // shown as the row label when the table stacks on small screens
  return td;
};

function renderTrains(data: TrainsResponse) {
  clearResults();
  if (!data.trains.length) return setStatus("No direct trains found for that route and date.", false, "info");
  const count = data.trains.length;
  setStatus(`${count} train${count === 1 ? "" : "s"} from ${data.from.name} to ${data.to.name}`, false, "ok");

  const table = document.createElement("table");
  table.className = "trains-table";
  const head = table.createTHead().insertRow();
  for (const h of ["Train", "Departs", "Arrives", "Duration", "Runs"]) {
    head.append(Object.assign(document.createElement("th"), { textContent: h }));
  }
  const body = table.createTBody();
  const columns = ["Train", "Departs", "Arrives", "Duration", "Runs"];
  for (const t of data.trains) {
    const days = t.train.runDays.length === 7 ? "Daily" : t.train.runDays.join(" ");
    body.insertRow().append(
      cell(`${t.train.number} ${t.train.name}`, columns[0]!),
      cell(t.from.departure, columns[1]!),
      cell(t.to.arrival, columns[2]!),
      cell(formatDuration(t.duration), columns[3]!),
      cell(days, columns[4]!),
    );
  }
  results.append(table);
}

function setStatusWithRetry(message: string, retry: () => void) {
  setStatus(message, true);
  const button = Object.assign(document.createElement("button"), { type: "button", className: "retry", textContent: "Retry" });
  button.addEventListener("click", retry);
  statusEl.append(button);
}

async function searchAlternatives(values: SearchValues) {
  const { from, to, date, time, maxTransfers } = values;
  if (time === undefined) return setStatus("Choose an earliest departure time.", true);
  hideAuthPrompt(authPrompt);
  submit.disabled = true;
  // Keep the previous results on screen (dimmed) until the new ones arrive.
  results.setAttribute("aria-busy", "true");
  if (!results.children.length) showSkeleton();
  setStatus("Searching…", false, "loading");
  try {
    const outcome = await fetchAlternatives({ from, to, date, time, ...(maxTransfers !== undefined && { maxTransfers }) });
    clearResults();
    switch (outcome.kind) {
      case "ok": {
        const n = outcome.result.journeys.length;
        if (!n) return setStatus("No journeys found for that route, date and time. Try a later time or more transfers.", false, "info");
        setStatus(`${n} journey option${n === 1 ? "" : "s"}, best first`, false, "ok");
        resultsNote.hidden = false;
        return renderJourneys(results, outcome.result, (journey) =>
          createSaveFooter(journey, {
            onUnauthorized: () => {
              setStatus("Please sign in to save journeys.", true);
              showAuthPrompt(authPrompt);
            },
          }),
        );
      }
      case "unauthorized":
        return needSignIn();
      case "invalid":
        return setStatus(outcome.message, true);
      case "unavailable":
        return setStatusWithRetry(`${outcome.message.replace(/[.!]?$/, ".")} Please try again shortly.`, () => void searchAlternatives(values));
      case "error":
        return setStatusWithRetry(outcome.message, () => void searchAlternatives(values));
    }
  } finally {
    results.removeAttribute("aria-busy");
    submit.disabled = false;
  }
}

async function search(values: SearchValues) {
  if (modeInput().value === "alternatives") return searchAlternatives(values);
  const { from, to, date } = values;
  hideAuthPrompt(authPrompt);
  submit.disabled = true;
  resultsNote.hidden = true;
  showSkeleton();
  setStatus("Searching…", false, "loading");
  try {
    const res = await fetch(`/trains/search?${new URLSearchParams({ from, to, date })}`);
    if (res.status === 401) return (clearResults(), needSignIn());
    const body = await res.json();
    if (!res.ok) return (clearResults(), setStatus(body.error ?? "Search failed.", true));
    renderTrains(body);
  } catch {
    clearResults();
    setStatus("Network error, please try again.", true);
  } finally {
    submit.disabled = false;
  }
}

syncMode();
initSearchForm(form, { source: mockStationSource, onSubmit: search });

// Two views on one page, chosen by the URL hash so each is linkable and the back button works.
const savedView = initSavedView({
  status: document.getElementById("saved-status")!,
  list: document.getElementById("saved-list")!,
  authPrompt: document.getElementById("saved-auth-prompt")!,
  empty: document.getElementById("saved-empty")!,
});

function showView() {
  const saved = location.hash === "#saved";
  document.getElementById("search-view")!.hidden = saved;
  document.getElementById("saved-view")!.hidden = !saved;
  document.body.dataset["view"] = saved ? "saved" : "search";
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".tabs a")) {
    if ((link.dataset["view"] === "saved") === saved) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (saved) void savedView.load();
}
window.addEventListener("hashchange", showView);
showView();

// Header sign-in / sign-up entry points open the same provider links in a dialog.
const authDialog = document.getElementById("auth-dialog") as HTMLDialogElement;
const dialogAuth = document.getElementById("dialog-auth")!;
for (const trigger of document.querySelectorAll<HTMLElement>("[data-open-auth]")) {
  trigger.addEventListener("click", () => {
    showAuthPrompt(dialogAuth);
    if (typeof authDialog.showModal === "function") authDialog.showModal();
    else authDialog.setAttribute("open", "");
  });
}
const closeDialog = () => (typeof authDialog.close === "function" ? authDialog.close() : authDialog.removeAttribute("open"));
document.querySelector("[data-close-auth]")!.addEventListener("click", closeDialog);
// A click on the backdrop lands on the <dialog> itself, outside its content box.
authDialog.addEventListener("click", (e) => {
  if (e.target !== authDialog) return;
  const box = authDialog.getBoundingClientRect();
  if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) closeDialog();
});

// Colour theme: follows the system until the visitor picks one; the pick is remembered if storage works.
const themeToggle = document.getElementById("theme-toggle")!;
const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset["theme"] ?? (systemDark?.matches ? "dark" : "light")) === "dark";
function paintTheme() {
  const use = themeToggle.querySelector("use")!;
  use.setAttribute("href", isDark() ? "#i-sun" : "#i-moon");
  themeToggle.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
}
try {
  const saved = localStorage.getItem("reroute-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset["theme"] = saved;
} catch {}
themeToggle.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset["theme"] = next;
  try {
    localStorage.setItem("reroute-theme", next);
  } catch {}
  paintTheme();
});
paintTheme();
