import { mockStations } from "./mockStations";
import { DEFAULT_LIMIT, searchStations } from "./searchStations";
import type { Station } from "./types";

/**
 * The only thing the autocomplete knows about where stations come from. An API-backed
 * implementation just has to return the same shape; the UI doesn't change.
 */
export type StationSource = {
  search(query: string, signal?: AbortSignal): Promise<Station[]>;
};

export function createStaticStationSource(stations: readonly Station[], limit = DEFAULT_LIMIT): StationSource {
  return { search: async (query) => searchStations(stations, query, limit) };
}

export const mockStationSource: StationSource = createStaticStationSource(mockStations);
