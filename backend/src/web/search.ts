import { initSearchForm, type SearchValues } from "./searchForm.ts";
import { mockStationSource } from "./stations/stationSource.ts";

const form = document.getElementById("search-form") as HTMLFormElement;
const submit = document.getElementById("submit") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const results = document.getElementById("results")!;

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
}

function needSignIn() {
  statusEl.className = "error";
  statusEl.replaceChildren("You need to sign in. ");
  for (const [provider, label] of [["github", "GitHub"], ["google", "Google"]] as const) {
    const a = document.createElement("a");
    a.href = `/auth/${provider}/signin`;
    a.textContent = `Sign in with ${label}`;
    a.className = "signin-link";
    statusEl.append(a);
  }
}

type TrainRow = {
  train: { number: string; name: string; runDays: string[] };
  from: { departure: string };
  to: { arrival: string };
  duration: number;
};
type TrainsResponse = { from: { name: string }; to: { name: string }; trains: TrainRow[] };

const cell = (text: string) => Object.assign(document.createElement("td"), { textContent: text });
const duration = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;

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
      cell(duration(t.duration)),
      cell(days),
    );
  }
  results.append(table);
}

async function search({ from, to, date }: SearchValues) {
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

initSearchForm(form, { source: mockStationSource, onSubmit: search });
