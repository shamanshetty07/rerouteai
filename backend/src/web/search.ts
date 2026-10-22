import { fetchAlternatives, formatDuration, renderJourneys } from "./alternatives.ts";
import { hideAuthPrompt, showAuthPrompt } from "./authLinks.ts";
import { createSaveFooter, initSavedView } from "./savedView.ts";
import { initSearchForm, type SearchValues } from "./searchForm.ts";
import { mockStationSource } from "./stations/stationSource.ts";

const form = document.getElementById("search-form") as HTMLFormElement;
const submit = document.getElementById("submit") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const results = document.getElementById("results")!;
const authPrompt = document.getElementById("auth-prompt")!;
const modeInput = () => [...form.querySelectorAll<HTMLInputElement>('input[name="mode"]')].find((r) => r.checked)!;

// Time and transfer limit only apply to alternative-journey search.
function syncMode() {
  const alternatives = modeInput().value === "alternatives";
  for (const field of form.querySelectorAll<HTMLElement>("[data-alt-only]")) field.hidden = !alternatives;
  submit.textContent = alternatives ? "Find journeys" : "Search trains";
}
form.addEventListener("change", (e) => {
  if ((e.target as HTMLElement).getAttribute("name") === "mode") {
    syncMode();
    results.replaceChildren();
    setStatus("");
  }
});

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
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

const cell = (text: string) => Object.assign(document.createElement("td"), { textContent: text });

function renderTrains(data: TrainsResponse) {
  results.replaceChildren();
  if (!data.trains.length) return setStatus("No direct trains found for that route and date.");
  const count = data.trains.length;
  setStatus(`${count} train${count === 1 ? "" : "s"} from ${data.from.name} to ${data.to.name}`);

  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const h of ["Train", "Departs", "Arrives", "Duration", "Runs"]) {
    head.append(Object.assign(document.createElement("th"), { textContent: h }));
  }
  const body = table.createTBody();
  for (const t of data.trains) {
    const days = t.train.runDays.length === 7 ? "Daily" : t.train.runDays.join(" ");
    body.insertRow().append(
      cell(`${t.train.number} ${t.train.name}`),
      cell(t.from.departure),
      cell(t.to.arrival),
      cell(formatDuration(t.duration)),
      cell(days),
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
  setStatus("Searching…");
  try {
    const outcome = await fetchAlternatives({ from, to, date, time, ...(maxTransfers !== undefined && { maxTransfers }) });
    results.replaceChildren();
    switch (outcome.kind) {
      case "ok": {
        const n = outcome.result.journeys.length;
        if (!n) return setStatus("No journeys found for that route, date and time. Try a later time or more transfers.");
        setStatus(`${n} journey option${n === 1 ? "" : "s"}, best first`);
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
  results.replaceChildren();
  setStatus("Searching…");
  try {
    const res = await fetch(`/trains/search?${new URLSearchParams({ from, to, date })}`);
    if (res.status === 401) return needSignIn();
    const body = await res.json();
    if (!res.ok) return setStatus(body.error ?? "Search failed.", true);
    renderTrains(body);
  } catch {
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
});

function showView() {
  const saved = location.hash === "#saved";
  document.getElementById("search-view")!.hidden = saved;
  document.getElementById("saved-view")!.hidden = !saved;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".tabs a")) {
    if ((link.dataset["view"] === "saved") === saved) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (saved) void savedView.load();
}
window.addEventListener("hashchange", showView);
showView();
