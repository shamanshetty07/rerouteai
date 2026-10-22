const BASE_URL = "https://api.railradar.in";

export type TrainsBetweenParams = {
  from: string;
  to: string;
  date?: string;
  type?: string;
  category?: string;
  byCity?: boolean;
  live?: boolean;
};

type Stop = { code: string; name: string; city?: string; day: number; sequence: number };

export type TrainResult = {
  train: { number: string; name: string; type: string; runDays: string[] };
  from: Stop & { departure: string };
  to: Stop & { arrival: string };
  distance: number;
  duration: number;
  totalHaltsBetween: number;
  live?: {
    startDate?: string;
    expectedArrivalTime?: string;
    platform?: string;
    delayMinutes?: number;
  };
};

export type TrainsBetween = {
  from: { code: string; name: string };
  to: { code: string; name: string };
  count?: number;
  trains: TrainResult[];
};

/** An error from RailRadar, carrying the HTTP status we should surface. */
export class RailRadarError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const cache = new Map<string, { expires: number; value: TrainsBetween }>();

function remember(path: string, value: TrainsBetween) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!); // oldest first
  }
  cache.set(path, { expires: Date.now() + CACHE_TTL_MS, value });
}

/** Static timetable lookups are cached to protect the plan's request quota; live ones never are. */
export async function trainsBetween(params: TrainsBetweenParams): Promise<TrainsBetween> {
  const { from, to, ...filters } = params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const path = `/v1/trains/between/${from}/${to}?${query}`;

  const cacheable = !params.live;
  const hit = cache.get(path);
  if (cacheable && hit && hit.expires > Date.now()) return hit.value;

  const apiKey = process.env["RAILRADAR_API_KEY"];
  if (!apiKey) {
    console.error("RAILRADAR_API_KEY is not set");
    throw new RailRadarError("Train search is temporarily unavailable", 503);
  }

  let res: Response;
  try {
    res = await fetch(BASE_URL + path, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new RailRadarError("Train search is temporarily unavailable", 504);
  }
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: TrainsBetween;
    error?: { message?: string };
  } | null;

  if (!res.ok || !body?.success || !body.data) {
    // The upstream's own wording and our key/quota problems stay in the log; callers get fixed text.
    console.error(`RailRadar request failed (HTTP ${res.status})`);
    if (res.status === 400 || res.status === 404) throw new RailRadarError("No train data found for that search", res.status);
    throw new RailRadarError("Train search is temporarily unavailable", 502);
  }

  if (cacheable) remember(path, body.data);
  return body.data;
}
