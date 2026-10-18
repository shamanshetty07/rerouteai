import { DEFAULT_LIMIT, searchStations } from "./searchStations.ts";
import { mockStations } from "./mockStations.ts";
import type { Station } from "./types.ts";

/**
 * The only thing the autocomplete knows about where stations come from. An API-backed
 * implementation just has to return the same shape; the UI doesn't change.
 */
export type StationSource = {
  search(query: string, signal?: AbortSignal): Promise<Station[]>;
};

export function createStaticStationSource(
  stations: readonly Station[],
  limit = DEFAULT_LIMIT,
): StationSource {
  return { search: async (query) => searchStations(stations, query, limit) };
}

export const mockStationSource: StationSource = createStaticStationSource(mockStations);
