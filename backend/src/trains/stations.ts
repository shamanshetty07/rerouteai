import { RailRadarError } from "./railradar.ts";

export type Station = { code: string; name: string };

const BASE_URL = "https://api.railradar.in";
const TTL_MS = 24 * 60 * 60 * 1000;

type Directory = { stations: Station[]; byCode: Map<string, Station> };

let directory: Directory | null = null;
let loadedAt = 0;
let loading: Promise<Directory> | null = null;

/** Parses RailRadar's compact `CODE|Name` per-line station list. */
function parse(text: string): Directory {
  const stations: Station[] = [];
  for (const line of text.split("\n")) {
    const sep = line.indexOf("|");
    if (sep > 0) stations.push({ code: line.slice(0, sep), name: line.slice(sep + 1).trim() });
  }
  return { stations, byCode: new Map(stations.map((s) => [s.code, s])) };
}

async function fetchDirectory(): Promise<Directory> {
  const apiKey = process.env["RAILRADAR_API_KEY"];
  if (!apiKey) {
    console.error("RAILRADAR_API_KEY is not set");
    throw new RailRadarError("Station search is temporarily unavailable", 503);
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/lookup/stations/compressed`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RailRadarError("Station search is temporarily unavailable", 504);
  }
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: string } | null;
  if (!res.ok || !body?.success || typeof body.data !== "string") {
    console.error(`Could not load stations (HTTP ${res.status})`);
    throw new RailRadarError("Station search is temporarily unavailable", 502);
  }
  return parse(body.data);
}

/**
 * The whole directory is fetched once a day and searched in memory, so typing in the
 * autocomplete never spends RailRadar quota. On a failed refresh we keep serving the old list.
 */
async function getDirectory(): Promise<Directory> {
  if (directory && Date.now() - loadedAt < TTL_MS) return directory;
  loading ??= fetchDirectory()
    .then((fresh) => {
      directory = fresh;
      loadedAt = Date.now();
      return fresh;
    })
    .catch((err) => {
      if (directory) return directory;
      throw err;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function isStation(code: string): Promise<boolean> {
  return (await getDirectory()).byCode.has(code);
}

/** Lower rank = better match: exact code, code prefix, name prefix, word prefix, substring. */
function rank(station: Station, q: string): number {
  const code = station.code.toLowerCase();
  const name = station.name.toLowerCase();
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (name.split(/\s+/).some((word) => word.startsWith(q))) return 3;
  if (name.includes(q)) return 4;
  return Infinity;
}

export async function searchStations(query: string, limit = 8): Promise<Station[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const { stations } = await getDirectory();

  return stations
    .map((station) => ({ station, score: rank(station, q) }))
    .filter((m) => m.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.station.name.length - b.station.name.length)
    .slice(0, limit)
    .map((m) => m.station);
}
