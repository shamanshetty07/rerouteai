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

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An icon from the sprite in search.html. Decorative: hidden from assistive technology. */
export function icon(name: string, className = "icon"): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const timeFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));
const formatDay = (iso: string) => dayFormat.format(new Date(iso));
/** Whole IST calendar days between two instants, for the "+1 day" marker on overnight arrivals. */
const dayShift = (from: string, to: string) =>
  Math.round((Date.parse(`${dayKey.format(new Date(to))}T00:00:00Z`) - Date.parse(`${dayKey.format(new Date(from))}T00:00:00Z`)) / 86_400_000);

const TRAIN_TYPE_LABEL = (type: string) => type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function warningList(warnings: (JourneyWarning | SearchWarning)[], className: string) {
  const list = el("ul", className);
  for (const w of warnings) list.append(el("li", undefined, w.message));
  return list;
}

function tripEnd(kind: "dep" | "arr", iso: string, station: string, shift = 0) {
  const end = el("div", `trip-end ${kind}`);
  const time = el("div", "trip-time", formatTime(iso));
  const day = el("div", "trip-day", formatDay(iso));
  if (shift > 0) day.append(" ", el("span", "plus", `+${shift} day${shift === 1 ? "" : "s"}`));
  end.append(time, day, el("div", "trip-station", station));
  return end;
}

function stop(kind: "dep" | "arr", iso: string, name: string) {
  const row = el("div", `stop ${kind}`);
  row.append(el("span", "stop-time", formatTime(iso)), el("span", "stop-name", name));
  return row;
}

export type JourneyCardOptions = {
  /** Small badge next to the heading, e.g. for the top-ranked option. */
  badge?: string;
  /** Open the leg-by-leg timeline initially. */
  open?: boolean;
};

/** One journey as a card. `footer` (e.g. a Save or Remove button) is appended below the details. */
export function renderJourneyCard(journey: Journey, heading: string, footer?: HTMLElement, options: JourneyCardOptions = {}): HTMLElement {
  const card = el("article", options.badge ? "journey is-best" : "journey");

  const head = el("header", "journey-head");
  head.append(el("h3", undefined, heading));
  if (options.badge) head.append(el("span", "badge blue", options.badge));
  const duration = el("span", "duration");
  duration.append(icon("clock"), formatDuration(journey.totalDurationMinutes));
  head.append(duration);
  card.append(head);

  // Departure-board summary: the answer to "when do I leave, when do I arrive, how many changes".
  const trip = el("div", "trip");
  const line = el("div", "trip-line");
  const track = el("div", "trip-track");
  track.setAttribute("aria-hidden", "true");
  track.append(el("i"));
  for (let i = 0; i < journey.transferCount; i++) track.append(el("i", "change"));
  track.append(el("i"));
  line.append(
    track,
    el("p", "journey-meta", journey.transferCount === 0 ? "Direct" : plural(journey.transferCount, "transfer")),
  );
  trip.append(
    tripEnd("dep", journey.departure, journey.source.name),
    line,
    tripEnd("arr", journey.arrival, journey.destination.name, dayShift(journey.departure, journey.arrival)),
  );
  card.append(trip);

  const trains = el("ul", "trains");
  trains.setAttribute("aria-label", "Trains on this journey");
  for (const leg of journey.legs) {
    const chip = el("li");
    chip.append(el("span", "num", leg.trainNumber), el("span", "nm", leg.trainName));
    chip.title = `${leg.trainNumber} ${leg.trainName}`;
    trains.append(chip);
  }
  card.append(trains);

  if (journey.warnings.length) card.append(warningList(journey.warnings, "journey-warnings"));

  const details = el("details", "details");
  details.open = options.open ?? false;
  const summary = el("summary");
  const label = el("span");
  label.append(el("span", "when-closed", "Show legs and changes"), el("span", "when-open", "Hide legs and changes"));
  summary.append(label, icon("chevron"));
  details.append(summary);

  const steps = el("ol", "legs");
  journey.legs.forEach((leg, i) => {
    const item = el("li", "leg");
    const title = el("div", "leg-title");
    title.append(el("strong", undefined, `${leg.trainNumber} ${leg.trainName}`), el("span", "badge", TRAIN_TYPE_LABEL(leg.trainType)));
    const ride = el("div", "ride");
    ride.append(el("span", "journey-meta", `${formatDuration(leg.durationMinutes)} on board`), el("span", "journey-meta", `${Math.round(leg.distanceKm)} km`));
    item.append(title, stop("dep", leg.departure, leg.from.name), ride, stop("arr", leg.arrival, leg.to.name));
    steps.append(item);

    const transfer = journey.transfers[i];
    if (transfer) {
      steps.append(el("li", "transfer", `Change at ${transfer.station.name} · wait ${formatDuration(transfer.waitMinutes)}`));
    }
  });
  details.append(steps);
  card.append(details);

  if (footer) card.append(footer);
  return card;
}

/**
 * Replaces the container's contents with the journeys, in the order the API returned them.
 * `footer` optionally builds a per-journey action row (the page uses it for the Save button).
 */
export function renderJourneys(container: HTMLElement, result: AlternativeSearchResult, footer?: (journey: Journey) => HTMLElement) {
  container.replaceChildren();
  if (result.warnings.length) container.append(warningList(result.warnings, "search-warnings"));
  result.journeys.forEach((journey, i) =>
    container.append(
      renderJourneyCard(journey, `Option ${i + 1}`, footer?.(journey), i === 0 ? { badge: "Best ranked", open: true } : {}),
    ),
  );
}
