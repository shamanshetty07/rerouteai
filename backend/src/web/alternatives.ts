// Browser-side client and renderer for GET /trains/alternatives. Types come from the backend
// model via `import type`, which is erased at build time, so no server code reaches the bundle.

import type { AlternativeSearchResult, Journey, JourneyWarning, SearchWarning } from "../rail/journey.ts";

export type AlternativesQuery = { from: string; to: string; date: string; time: string; maxTransfers?: number };

export type AlternativesOutcome =
  | { kind: "ok"; result: AlternativeSearchResult }
  | { kind: "unauthorized" }
  /** HTTP 400: the server's message is safe to show. */
  | { kind: "invalid"; message: string }
  /** HTTP 503: timetable data is unavailable; retrying later may help. */
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

export function alternativesUrl({ from, to, date, time, maxTransfers }: AlternativesQuery): string {
  const params = new URLSearchParams({ from, to, date, time });
  if (maxTransfers !== undefined) params.set("maxTransfers", String(maxTransfers));
  return `/trains/alternatives?${params}`;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/** Never throws; the session cookie is sent by the browser's same-origin default. */
export async function fetchAlternatives(
  query: AlternativesQuery,
  fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<AlternativesOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(alternativesUrl(query));
  } catch {
    return { kind: "error", message: "Network error, please try again." };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 400) return { kind: "invalid", message: await errorMessage(res, "Invalid search.") };
  if (res.status === 503) {
    return { kind: "unavailable", message: await errorMessage(res, "Timetable data is temporarily unavailable.") };
  }
  if (!res.ok) return { kind: "error", message: await errorMessage(res, "Search failed.") };
  try {
    return { kind: "ok", result: (await res.json()) as AlternativeSearchResult };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

export const formatDuration = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

const istFormat = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The API sends UTC instants; Indian railway times are shown in IST. */
export const formatInstant = (iso: string) => istFormat.format(new Date(iso));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function warningList(warnings: (JourneyWarning | SearchWarning)[], className: string) {
  const list = el("ul", className);
  for (const w of warnings) list.append(el("li", undefined, w.message));
  return list;
}

function renderJourney(journey: Journey, index: number): HTMLElement {
  const card = el("article", "journey");
  const head = el("header", "journey-head");
  head.append(
    el("h3", undefined, `Option ${index + 1}`),
    el("p", "journey-times", `${formatInstant(journey.departure)} → ${formatInstant(journey.arrival)}`),
    el(
      "p",
      "journey-meta",
      `${formatDuration(journey.totalDurationMinutes)} · ${
        journey.transferCount === 0 ? "Direct" : plural(journey.transferCount, "transfer")
      }`,
    ),
  );
  card.append(head);

  const steps = el("ol", "legs");
  journey.legs.forEach((leg, i) => {
    const item = el("li", "leg");
    item.append(
      el("strong", undefined, `${leg.trainNumber} ${leg.trainName}`),
      el("div", undefined, `${leg.from.name} · ${formatInstant(leg.departure)}`),
      el("div", undefined, `${leg.to.name} · ${formatInstant(leg.arrival)}`),
      el("div", "journey-meta", formatDuration(leg.durationMinutes)),
    );
    steps.append(item);

    const transfer = journey.transfers[i];
    if (transfer) {
      steps.append(
        el("li", "transfer", `Change at ${transfer.station.name} · wait ${formatDuration(transfer.waitMinutes)}`),
      );
    }
  });
  card.append(steps);

  if (journey.warnings.length) card.append(warningList(journey.warnings, "journey-warnings"));
  return card;
}

/** Replaces the container's contents with the journeys, in the order the API returned them. */
export function renderJourneys(container: HTMLElement, result: AlternativeSearchResult) {
  container.replaceChildren();
  if (result.warnings.length) container.append(warningList(result.warnings, "search-warnings"));
  result.journeys.forEach((journey, i) => container.append(renderJourney(journey, i)));
}
