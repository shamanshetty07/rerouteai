import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { mockStations } from "./mockStations.ts";
import { mockRailData, mockTrains } from "./mockTrains.ts";
import { createInMemoryRailData, RailDataError } from "./repository.ts";
import type { Train } from "./types.ts";

describe("in-memory rail data", () => {
  test("looks up stations and trains by id, returning null when absent", async () => {
    expect((await mockRailData.getStation("NDLS"))?.name).toBe("New Delhi");
    expect((await mockRailData.getTrain("12951"))?.name).toContain("Rajdhani");
    expect(await mockRailData.getStation("NOPE")).toBeNull();
    expect(await mockRailData.getTrain("00000")).toBeNull();
  });

  test("lists everything it was given", async () => {
    expect(await mockRailData.listStations()).toHaveLength(mockStations.length);
    expect(await mockRailData.listTrains()).toHaveLength(mockTrains.length);
  });

  test("finds the trains stopping at a station, sorted by number", async () => {
    const atBhopal = await mockRailData.trainsStoppingAt("BPL");
    expect(atBhopal.map((t) => t.number)).toEqual(["12002", "12622", "12627"]);
    expect(await mockRailData.trainsStoppingAt("TVC")).toEqual([]);
  });

  test("refuses invalid data, reporting every problem", () => {
    const broken: Train = { ...mockTrains[0]!, number: "1", stops: [mockTrains[0]!.stops[0]!] };
    try {
      createInMemoryRailData({ stations: mockStations, trains: [broken] });
      throw new Error("expected createInMemoryRailData to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RailDataError);
      expect((err as RailDataError).issues.length).toBeGreaterThanOrEqual(2);
      expect((err as RailDataError).message).toContain("five digits");
    }
  });
});

describe("mock dataset coverage", () => {
  const lastArrival = (t: Train) => t.stops[t.stops.length - 1]!.arrival!;

  test("includes day, overnight and multi-night journeys", () => {
    const daysSpanned = new Set(mockTrains.map((t) => lastArrival(t).dayOffset));
    expect([...daysSpanned].sort()).toEqual([0, 1, 2]);
  });

  test("includes both daily and non-daily trains", () => {
    expect(mockTrains.some((t) => t.runDays.length === 7)).toBe(true);
    expect(mockTrains.some((t) => t.runDays.length < 7)).toBe(true);
  });

  test("includes a train that leaves just before midnight", () => {
    expect(mockTrains.some((t) => t.stops[0]!.departure!.time >= "23:00")).toBe(true);
  });

  test("every station a train uses exists in the station list", () => {
    const ids = new Set(mockStations.map((s) => s.id));
    for (const train of mockTrains) {
      for (const stop of train.stops) expect(ids.has(stop.stationId)).toBe(true);
    }
  });
});

describe("independence", () => {
  test("the data layer imports nothing from the web UI or an external API", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("*.ts").scan({ cwd: import.meta.dir })) {
      if (file.endsWith(".test.ts")) continue;
      const source = await Bun.file(`${import.meta.dir}/${file}`).text();
      if (/\.\.\/web\/|\.\.\/trains\/|railradar|fetch\(|process\.env/i.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
