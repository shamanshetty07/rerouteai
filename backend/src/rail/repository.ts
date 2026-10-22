import { validateRailData, type ValidationIssue } from "./validate.ts";
import type { Station, Train } from "./types.ts";

/**
 * What the rest of the app may ask of rail data. It is async on purpose: the in-memory
 * implementation below and a future API-backed one satisfy the same contract.
 */
export type RailData = {
  getStation(id: string): Promise<Station | null>;
  getTrain(number: string): Promise<Train | null>;
  listStations(): Promise<Station[]>;
  listTrains(): Promise<Train[]>;
  /** Trains with a stop (arrival or departure) at the station, in train-number order. */
  trainsStoppingAt(stationId: string): Promise<Train[]>;
};

export class RailDataError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`Invalid rail data:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
  }
}

/** Builds an in-memory source, refusing data that fails validation. */
export function createInMemoryRailData(data: {
  stations: readonly Station[];
  trains: readonly Train[];
}): RailData {
  const issues = validateRailData(data);
  if (issues.length) throw new RailDataError(issues);

  const stations = new Map(data.stations.map((s) => [s.id, s]));
  const trains = new Map(data.trains.map((t) => [t.number, t]));

  // Route search asks for a station's trains once per frontier label, so index them up front.
  const byStation = new Map<string, Train[]>();
  for (const train of [...trains.values()].sort((a, b) => a.number.localeCompare(b.number))) {
    for (const stop of train.stops) {
      const list = byStation.get(stop.stationId);
      if (list) list.push(train);
      else byStation.set(stop.stationId, [train]);
    }
  }

  return {
    getStation: async (id) => stations.get(id) ?? null,
    getTrain: async (number) => trains.get(number) ?? null,
    listStations: async () => [...stations.values()],
    listTrains: async () => [...trains.values()],
    trainsStoppingAt: async (stationId) => [...(byStation.get(stationId) ?? [])],
  };
}
