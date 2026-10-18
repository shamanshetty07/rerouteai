import type { Station } from "./types.ts";

export const DEFAULT_LIMIT = 8;

/** Lower is better: exact code, code prefix, name prefix, city prefix, word prefix, substring. */
function rank(station: Station, q: string): number {
  const code = station.code?.toLowerCase() ?? "";
  const name = station.name.toLowerCase();
  const city = station.city.toLowerCase();

  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (city.startsWith(q)) return 3;
  if (name.split(/\s+/).some((word) => word.startsWith(q))) return 4;
  if (name.includes(q) || city.includes(q)) return 5;
  return Infinity;
}

/** Case-insensitive partial match on name, code and city. An empty query matches nothing. */
export function searchStations(
  stations: readonly Station[],
  query: string,
  limit = DEFAULT_LIMIT,
): Station[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return stations
    .map((station) => ({ station, score: rank(station, q) }))
    .filter((m) => m.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.station.name.localeCompare(b.station.name))
    .slice(0, limit)
    .map((m) => m.station);
}
