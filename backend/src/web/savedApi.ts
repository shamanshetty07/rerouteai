// Browser client for /journeys/saved. Like alternatives.ts it never throws: every outcome, including
// network failures, comes back as a value the UI can show.

import type { Journey } from "../rail/journey.ts";
import type { SavedJourney } from "../journeys/types.ts";

export type Failure =
  | { kind: "unauthorized" }
  /** HTTP 400/409/404: the server's message is safe to show. */
  | { kind: "rejected"; status: number; message: string }
  | { kind: "rate-limited" }
  | { kind: "error"; message: string };

export type SaveOutcome = { kind: "saved"; saved: SavedJourney; alreadySaved: boolean } | Failure;
export type ListOutcome = { kind: "ok"; journeys: SavedJourney[] } | Failure;
export type DeleteOutcome = { kind: "deleted" } | Failure;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (url, init) => fetch(url, init);

async function message(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

async function failure(res: Response, fallback: string): Promise<Failure> {
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 429) return { kind: "rate-limited" };
  if (res.status === 400 || res.status === 404 || res.status === 409) {
    return { kind: "rejected", status: res.status, message: await message(res, fallback) };
  }
  return { kind: "error", message: fallback };
}

const NETWORK: Failure = { kind: "error", message: "Network error, please try again." };

export async function saveJourney(journey: Journey, fetchImpl: Fetch = defaultFetch): Promise<SaveOutcome> {
  let res: Response;
  try {
    // Same-origin: the browser adds the session cookie and the Origin header the server's CSRF check needs.
    res = await fetchImpl("/journeys/saved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journey }),
    });
  } catch {
    return NETWORK;
  }
  if (res.status !== 200 && res.status !== 201) return failure(res, "Couldn't save this journey. Please try again.");
  try {
    const body = (await res.json()) as { journey: SavedJourney };
    return { kind: "saved", saved: body.journey, alreadySaved: res.status === 200 };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

export async function listSavedJourneys(fetchImpl: Fetch = defaultFetch): Promise<ListOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/journeys/saved");
  } catch {
    return NETWORK;
  }
  if (!res.ok) return failure(res, "Couldn't load your saved journeys. Please try again.");
  try {
    const body = (await res.json()) as { journeys: SavedJourney[] };
    return { kind: "ok", journeys: body.journeys };
  } catch {
    return { kind: "error", message: "Unexpected response from the server." };
  }
}

export async function deleteSavedJourney(id: string, fetchImpl: Fetch = defaultFetch): Promise<DeleteOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/journeys/saved/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    return NETWORK;
  }
  if (res.status === 204) return { kind: "deleted" };
  // 404 means it is already gone (maybe removed in another tab): the list should simply drop it.
  if (res.status === 404) return { kind: "deleted" };
  return failure(res, "Couldn't remove this journey. Please try again.");
}
