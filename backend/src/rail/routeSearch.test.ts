import { describe, expect, test } from "bun:test";
import { mockRailData } from "./mockTrains.ts";
import { scoreJourney } from "./ranking.ts";
import { createInMemoryRailData, type RailData } from "./repository.ts";
import {
  checkConnection,
  DEFAULT_SEARCH_OPTIONS,
  findAlternativeJourneys,
  RouteSearchError,
  type RouteSearchRequest,
  type SearchOptions,
} from "./routeSearch.ts";
import { WEEKDAYS, type Station, type Train, type Weekday } from "./types.ts";

// All fixtures use 2026-10-20, a Tuesday. Times in expectations are IST, as in the schedules.
const TUE = "2026-10-20";
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`).toISOString();

type Row = [station: string, arrival: string | null, departure: string | null];

/** "HH:MM" or "HH:MM+N" (N days after the origin day) -> ScheduleTime. */
function at(value: string | null) {
  if (value === null) return null;
  const [time = "", days = "0"] = value.split("+");
  return { dayOffset: Number(days), time };
}

function mk(number: string, rows: Row[], runDays: readonly Weekday[] = WEEKDAYS): Train {
  return {
    number,
    name: `Train ${number}`,
    type: "express",
    runDays: [...runDays],
    stops: rows.map(([stationId, arrival, departure], i) => ({
      stationId,
      arrival: at(arrival),
      departure: at(departure),
      distanceKm: i * 100,
    })),
  };
}

const stationsOf = (trains: readonly Train[]): Station[] =>
  [...new Set(trains.flatMap((t) => t.stops.map((s) => s.stationId)))].map((id) => ({ id, code: id, name: `${id} Jn`, city: id }));

const rail = (...trains: Train[]) => createInMemoryRailData({ stations: stationsOf(trains), trains });

const request = (over: Partial<RouteSearchRequest> = {}): RouteSearchRequest => ({
  sourceId: "SRC",
  destinationId: "DST",
  date: TUE,
  earliestDeparture: "07:00",
  ...over,
});

const search = (data: RailData, over: Partial<RouteSearchRequest> = {}, options: Partial<SearchOptions> = {}) =>
  findAlternativeJourneys(data, request(over), options);

const trainsOf = (j: { legs: { trainNumber: string }[] }) => j.legs.map((l) => l.trainNumber);

describe("direct and connecting journeys", () => {
  test("finds a direct train and reports it completely", async () => {
    const { journeys, warnings } = await search(rail(mk("10001", [["SRC", null, "08:00"], ["DST", "12:00", null]])));
    expect(warnings).toEqual([]);
    expect(journeys).toHaveLength(1);

    const j = journeys[0]!;
    expect(trainsOf(j)).toEqual(["10001"]);
    expect(j.source).toEqual({ id: "SRC", code: "SRC", name: "SRC Jn" });
    expect(j.destination.id).toBe("DST");
    expect(j.legs[0]).toMatchObject({
      trainNumber: "10001",
      originDate: TUE,
      departure: ist(TUE, "08:00"),
      arrival: ist(TUE, "12:00"),
      durationMinutes: 240,
      distanceKm: 100,
    });
    expect(j).toMatchObject({
      transferCount: 0,
      transfers: [],
      totalDurationMinutes: 240,
      totalWaitMinutes: 0,
      startDelayMinutes: 60,
      feasibility: "schedule-feasible",
      connectionConstraintsSatisfied: true,
    });
    expect(j.warnings.map((w) => w.code)).toEqual(["NO_REAL_TIME_DATA"]);
  });

  test("finds a journey needing one transfer, with exact wait and duration", async () => {
    const data = rail(
      mk("10002", [["SRC", null, "09:00"], ["JNA", "10:00", null]]),
      mk("10003", [["JNA", null, "10:45"], ["DST", "13:00", null]]),
    );
    const { journeys } = await search(data);
    expect(journeys).toHaveLength(1);

    const j = journeys[0]!;
    expect(trainsOf(j)).toEqual(["10002", "10003"]);
    expect(j.transferCount).toBe(1);
    expect(j.transfers).toEqual([
      {
        station: { id: "JNA", code: "JNA", name: "JNA Jn" },
        arrival: ist(TUE, "10:00"),
        departure: ist(TUE, "10:45"),
        waitMinutes: 45,
        requiredBufferMinutes: 30,
      },
    ]);
    expect(j.totalDurationMinutes).toBe(240); // 09:00 -> 13:00
    expect(j.ridingMinutes).toBe(60 + 135);
    expect(j.totalWaitMinutes).toBe(45);
    expect(j.warnings.map((w) => w.code)).toEqual(["NO_REAL_TIME_DATA", "PLATFORM_CHANGE_UNVERIFIED"]);
  });

  const twoTransferNetwork = () =>
    rail(
      mk("20001", [["SRC", null, "06:00"], ["AAA", "08:00", null]]),
      mk("20002", [["AAA", null, "08:40"], ["BBB", "10:00", null]]),
      mk("20003", [["BBB", null, "10:30"], ["DST", "12:30", null]]),
    );

  test("finds a journey needing two transfers and sums waiting and duration correctly", async () => {
    const { journeys } = await search(twoTransferNetwork(), { earliestDeparture: "05:00" });
    expect(journeys).toHaveLength(1);
    const j = journeys[0]!;
    expect(trainsOf(j)).toEqual(["20001", "20002", "20003"]);
    expect(j.transfers.map((t) => [t.station.id, t.waitMinutes])).toEqual([["AAA", 40], ["BBB", 30]]);
    expect(j.totalWaitMinutes).toBe(70);
    expect(j.ridingMinutes).toBe(120 + 80 + 120);
    expect(j.totalDurationMinutes).toBe(390); // 06:00 -> 12:30
    expect(j.totalDurationMinutes).toBe(j.ridingMinutes + j.totalWaitMinutes);
    expect(j.startDelayMinutes).toBe(60); // earliest 05:00, first train 06:00
  });

  test("respects the maximum number of transfers", async () => {
    const data = twoTransferNetwork();
    // Default allows two transfers; one or none is not enough for this network.
    expect(DEFAULT_SEARCH_OPTIONS.maxTransfers).toBe(2);
    expect((await search(data, { earliestDeparture: "05:00" })).journeys).toHaveLength(1);
    expect((await search(data, { earliestDeparture: "05:00" }, { maxTransfers: 1 })).journeys).toEqual([]);
    expect((await search(data, { earliestDeparture: "05:00" }, { maxTransfers: 0 })).journeys).toEqual([]);
    expect((await search(data, { earliestDeparture: "05:00" }, { maxTransfers: 4 })).journeys).toHaveLength(1);
  });
});

describe("detours across the wider network", () => {
  const original = mk("10010", [["SRC", null, "08:00"], ["MID", "10:00", "10:05"], ["DST", "14:00", null]], ["tue"]);

  test("routes through a junction that is not on the original train's route", async () => {
    const data = rail(
      original,
      mk("10011", [["SRC", null, "09:00"], ["OFF", "11:00", null]]),
      mk("10012", [["OFF", null, "11:30"], ["DST", "15:00", null]]),
    );
    // The passenger missed the 08:00 original (and it only runs on Tuesdays).
    const { journeys } = await search(data, { earliestDeparture: "08:30" });
    expect(journeys).toHaveLength(1);
    const j = journeys[0]!;
    expect(trainsOf(j)).toEqual(["10011", "10012"]);
    expect(j.transfers[0]!.station.id).toBe("OFF");
    expect(original.stops.map((s) => s.stationId)).not.toContain("OFF");
  });

  test("a detour that arrives earlier ranks above a slower direct train", async () => {
    const data = rail(
      mk("10020", [["SRC", null, "08:00"], ["DST", "18:00", null]]),
      mk("10021", [["SRC", null, "08:00"], ["JNA", "10:00", null]]),
      mk("10022", [["JNA", null, "10:30"], ["DST", "12:30", null]]),
    );
    const { journeys } = await search(data);
    expect(journeys.map(trainsOf)).toEqual([["10021", "10022"], ["10020"]]);
    expect(journeys[0]!.arrival).toBe(ist(TUE, "12:30"));
    expect(journeys[1]!.arrival).toBe(ist(TUE, "18:00"));
    // 270 min + 90 transfer penalty + 30 min wait * 0.5 + 60 min start delay * 0.5
    expect(journeys[0]!.score).toBe(405);
    expect(journeys[1]!.score).toBe(630);
  });

  test("the search is not limited to a single geographic corridor", async () => {
    // Two different junctions lead to DST; both are offered.
    const data = rail(
      mk("10031", [["SRC", null, "08:00"], ["NRT", "10:00", null]]),
      mk("10032", [["NRT", null, "10:40"], ["DST", "14:00", null]]),
      mk("10033", [["SRC", null, "08:10"], ["SOU", "10:30", null]]),
      mk("10034", [["SOU", null, "11:15"], ["DST", "15:30", null]]),
    );
    const { journeys } = await search(data);
    expect(journeys.map((j) => j.transfers[0]!.station.id)).toEqual(["NRT", "SOU"]);
  });
});

describe("connection feasibility", () => {
  const feeder = mk("10040", [["SRC", null, "08:00"], ["JNA", "10:00", null]]);
  const onward = (departure: string, runDays?: readonly Weekday[]) =>
    mk("10041", [["JNA", null, departure], ["DST", "13:00", null]], runDays);

  test("rejects a connection whose next train departs before the previous one arrives", async () => {
    const data = rail(feeder, onward("09:30", ["tue"]));
    expect((await search(data)).journeys).toEqual([]);

    const arrive = Date.parse(ist(TUE, "10:00"));
    expect(checkConnection(arrive, Date.parse(ist(TUE, "09:30")), "JNA", DEFAULT_SEARCH_OPTIONS)).toMatchObject({
      ok: false,
      reason: "DEPARTS_BEFORE_ARRIVAL",
    });
  });

  test("rejects a connection that leaves less than the transfer buffer", async () => {
    const data = rail(feeder, onward("10:20"));
    expect((await search(data)).journeys).toEqual([]);

    const arrive = Date.parse(ist(TUE, "10:00"));
    expect(checkConnection(arrive, Date.parse(ist(TUE, "10:20")), "JNA", DEFAULT_SEARCH_OPTIONS)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_BUFFER",
      waitMinutes: 20,
    });
  });

  test("accepts a connection that exactly satisfies the buffer", async () => {
    const data = rail(feeder, onward("10:30"));
    const { journeys } = await search(data);
    expect(journeys).toHaveLength(1);
    expect(journeys[0]!.transfers[0]).toMatchObject({ waitMinutes: 30, requiredBufferMinutes: 30 });
    expect(journeys[0]!.connectionConstraintsSatisfied).toBe(true);
  });

  test("buffers are configurable globally and per station", async () => {
    const tight = rail(feeder, onward("10:20"));
    expect((await search(tight, {}, { transfer: { defaultMinutes: 20 } })).journeys).toHaveLength(1);
    expect((await search(tight, {}, { transfer: { defaultMinutes: 10, byStationId: { JNA: 25 } } })).journeys).toEqual([]);

    const loose = rail(feeder, onward("10:30"));
    const strict = await search(loose, {}, { transfer: { defaultMinutes: 30, byStationId: { JNA: 45 } } });
    expect(strict.journeys).toEqual([]);
  });

  test("an excessive wait is rejected unless the limit is raised", async () => {
    const data = rail(feeder, onward("10:30", ["wed"])); // only runs the next day
    expect((await search(data)).journeys).toEqual([]);
    const { journeys } = await search(data, {}, { maxTransferWaitMinutes: 2000 });
    expect(journeys).toHaveLength(1);
    expect(journeys[0]!.totalWaitMinutes).toBe(24 * 60 + 30);
  });

  test("the first train must leave within the initial waiting window", async () => {
    const daily = rail(mk("10044", [["SRC", null, "08:00"], ["DST", "12:00", null]]));
    const next = (await search(daily, { earliestDeparture: "09:00" })).journeys;
    expect(next[0]!.departure).toBe(ist("2026-10-21", "08:00")); // missed today's, so tomorrow's
    expect(next[0]!.startDelayMinutes).toBe(23 * 60);
    expect((await search(daily, { earliestDeparture: "09:00" }, { maxInitialWaitMinutes: 600 })).journeys).toEqual([]);
  });

  test("the next train must actually run on the relevant date", async () => {
    // Runs on Mondays only: Tuesday's passenger would have to wait six days.
    expect((await search(rail(feeder, onward("11:00", ["mon"])), {}, { maxTransferWaitMinutes: 2000 })).journeys).toEqual([]);
    expect((await search(rail(feeder, onward("11:00", ["tue"])))).journeys).toHaveLength(1);
  });

  test("takes the first later run when the nearest one is inside the buffer", async () => {
    // Two trains at JNA: 10:10 is too close, 10:45 works.
    const data = rail(
      feeder,
      mk("10042", [["JNA", null, "10:10"], ["DST", "12:00", null]]),
      mk("10043", [["JNA", null, "10:45"], ["DST", "13:30", null]]),
    );
    const { journeys } = await search(data);
    expect(journeys.map(trainsOf)).toEqual([["10040", "10043"]]);
  });
});

describe("overnight and multi-day journeys", () => {
  test("an overnight train arrives on the next calendar day with the right duration", async () => {
    const data = rail(mk("10050", [["SRC", null, "22:00"], ["DST", "06:00+1", null]]));
    const { journeys } = await search(data, { earliestDeparture: "21:00" });
    const j = journeys[0]!;
    expect(j.departure).toBe(ist("2026-10-20", "22:00"));
    expect(j.arrival).toBe(ist("2026-10-21", "06:00"));
    expect(j.totalDurationMinutes).toBe(480);
    expect(j.legs[0]!.originDate).toBe(TUE);
  });

  test("a journey spanning three calendar days", async () => {
    const data = rail(mk("10060", [["SRC", null, "23:00"], ["MID", "12:00+1", "12:10+1"], ["DST", "05:00+2", null]]));
    const j = (await search(data, { earliestDeparture: "22:00" })).journeys[0]!;
    expect(j.arrival).toBe(ist("2026-10-22", "05:00"));
    expect(j.totalDurationMinutes).toBe(30 * 60);
    expect(j.legs[0]!.durationMinutes).toBe(30 * 60);
  });

  test("a connection across midnight maps the second train's stop back to its origin date", async () => {
    const feeder = mk("10061", [["SRC", null, "22:00"], ["JNA", "23:50", null]]);
    // Leaves ORG on the evening of its origin day and reaches JNA at 00:20 the next day.
    const second = (runDays: readonly Weekday[]) =>
      mk("10062", [["ORG", null, "20:00"], ["JNA", "00:10+1", "00:20+1"], ["DST", "03:00+1", null]], runDays);

    const ok = (await search(rail(feeder, second(["tue"])), { earliestDeparture: "21:00" })).journeys;
    expect(ok).toHaveLength(1);
    expect(ok[0]!.transfers[0]).toMatchObject({ waitMinutes: 30, departure: ist("2026-10-21", "00:20") });
    expect(ok[0]!.legs[1]!.originDate).toBe(TUE);
    expect(ok[0]!.arrival).toBe(ist("2026-10-21", "03:00"));
    expect(ok[0]!.totalDurationMinutes).toBe(300);

    // If it only runs Wednesdays its JNA departure is Thursday 00:20: far too long a wait.
    expect((await search(rail(feeder, second(["wed"])), { earliestDeparture: "21:00" })).journeys).toEqual([]);
  });

  test("the journey horizon bounds how far ahead results may arrive", async () => {
    const data = rail(mk("10063", [["SRC", null, "08:00"], ["MID", "20:00", "20:10"], ["MIE", "08:00+1", "08:10+1"], ["MIF", "20:00+1", "20:10+1"], ["DST", "12:00+2", null]]));
    expect((await search(data)).journeys).toHaveLength(1);
    expect((await search(data, {}, { maxJourneyMinutes: 24 * 60 })).journeys).toEqual([]);
  });
});

describe("ranking, duplicates and stability of results", () => {
  test("returns several alternatives best first, with scores matching the ranking rules", async () => {
    const data = rail(
      mk("10070", [["SRC", null, "08:00"], ["DST", "16:00", null]]),
      mk("10071", [["SRC", null, "08:00"], ["JNA", "10:00", null]]),
      mk("10072", [["JNA", null, "10:30"], ["DST", "15:00", null]]),
      mk("10073", [["SRC", null, "12:00"], ["DST", "19:00", null]]),
    );
    const { journeys } = await search(data);
    expect(journeys.map(trainsOf)).toEqual([["10070"], ["10071", "10072"], ["10073"]]);
    expect(journeys.map((j) => j.score)).toEqual([510, 555, 570]);
    for (const j of journeys) expect(j.score).toBe(scoreJourney(j));
  });

  test("drops a journey that is beaten on departure, arrival and transfers", async () => {
    const data = rail(
      mk("10074", [["SRC", null, "08:00"], ["DST", "12:00", null]]),
      mk("10075", [["SRC", null, "08:00"], ["JNA", "09:00", null]]),
      mk("10076", [["JNA", null, "09:30"], ["DST", "13:00", null]]),
    );
    expect((await search(data)).journeys.map(trainsOf)).toEqual([["10074"]]);
  });

  test("limits the number of results", async () => {
    const data = rail(
      mk("10077", [["SRC", null, "08:00"], ["DST", "12:00", null]]),
      mk("10078", [["SRC", null, "09:00"], ["DST", "14:00", null]]),
      mk("10079", [["SRC", null, "10:00"], ["DST", "16:00", null]]),
    );
    expect((await search(data)).journeys).toHaveLength(3);
    expect((await search(data, {}, { maxResults: 2 })).journeys.map(trainsOf)).toEqual([["10077"], ["10078"]]);
  });

  test("never returns the same journey twice, even if the data source repeats trains", async () => {
    const base = rail(
      mk("10080", [["SRC", null, "09:00"], ["JNA", "10:00", null]]),
      mk("10081", [["JNA", null, "10:45"], ["DST", "13:00", null]]),
      mk("10082", [["SRC", null, "09:30"], ["DST", "14:00", null]]),
    );
    const repeating: RailData = {
      ...base,
      trainsStoppingAt: async (id) => {
        const trains = await base.trainsStoppingAt(id);
        return [...trains, ...trains];
      },
    };
    const clean = await search(base);
    const noisy = await search(repeating);
    expect(noisy.journeys).toEqual(clean.journeys);
    expect(new Set(noisy.journeys.map((j) => trainsOf(j).join(">"))).size).toBe(noisy.journeys.length);
  });

  test("equal-scoring journeys come back in a stable order regardless of data order", async () => {
    const a = mk("10090", [["SRC", null, "08:00"], ["DST", "12:00", null]]);
    const b = mk("10091", [["SRC", null, "08:00"], ["DST", "12:00", null]]);
    const forward = await search(rail(a, b));
    const backward = await search(rail(b, a));
    expect(forward.journeys.map(trainsOf)).toEqual([["10090"], ["10091"]]);
    expect(backward.journeys).toEqual(forward.journeys);
    expect(forward.journeys[0]!.score).toBe(forward.journeys[1]!.score);
  });

  test("public results carry no search internals", async () => {
    const data = rail(
      mk("10092", [["SRC", null, "09:00"], ["JNA", "10:00", null]]),
      mk("10093", [["JNA", null, "10:45"], ["DST", "13:00", null]]),
    );
    const j = (await search(data)).journeys[0]!;
    expect(Object.keys(j).sort()).toEqual(
      [
        "arrival", "connectionConstraintsSatisfied", "departure", "destination", "feasibility", "legs", "ridingMinutes",
        "score", "source", "startDelayMinutes", "totalDurationMinutes", "totalWaitMinutes", "transferCount", "transfers", "warnings",
      ].sort(),
    );
    expect(JSON.parse(JSON.stringify(j))).toEqual(j); // plain JSON, no Dates or Maps
  });
});

describe("cycles and termination", () => {
  test("never revisits a station, so a loop in the network is ignored", async () => {
    const data = rail(
      mk("10100", [["SRC", null, "08:00"], ["AAA", "09:00", "09:05"], ["BBB", "10:00", null]]),
      mk("10101", [["BBB", null, "10:30"], ["AAA", "11:30", "11:35"], ["SRC", "12:30", null]]),
      mk("10102", [["AAA", null, "09:45"], ["DST", "11:45", null]]),
    );
    const { journeys } = await search(data, {}, { maxTransfers: 4 });
    expect(journeys.map(trainsOf)).toEqual([["10100", "10102"]]);
  });

  test("terminates and stays loop-free on a densely connected ring", async () => {
    const ring = ["SRC", "RAA", "RBB", "RCC", "RDD", "DST"];
    const trains: Train[] = [];
    ring.forEach((from, i) => {
      for (const step of [1, -1]) {
        const to = ring[(i + step + ring.length) % ring.length]!;
        const hour = 6 + i * 2;
        const label = `${step > 0 ? 3 : 4}${i}${String(hour).padStart(2, "0")}`.padStart(5, "1");
        trains.push(mk(label, [[from, null, `${String(hour).padStart(2, "0")}:00`], [to, `${String(hour).padStart(2, "0")}:50`, null]]));
      }
    });
    const { journeys } = await search(rail(...trains), { earliestDeparture: "00:00" }, { maxTransfers: 4 });
    expect(journeys.length).toBeGreaterThan(0);
    for (const j of journeys) {
      const stations = [j.legs[0]!.from.id, ...j.legs.map((l) => l.to.id)];
      expect(new Set(stations).size).toBe(stations.length);
      expect(new Set(trainsOf(j)).size).toBe(j.legs.length);
      expect(j.transferCount).toBeLessThanOrEqual(4);
    }
  });
});

describe("invalid and empty searches", () => {
  const data = rail(mk("10110", [["SRC", null, "08:00"], ["DST", "12:00", null]]));
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(RouteSearchError);
      return err as RouteSearchError;
    }
    throw new Error("expected the search to reject");
  };

  test("identical source and destination is an error", async () => {
    expect((await failure(search(data, { destinationId: "SRC" }))).code).toBe("SAME_STATION");
  });

  test("unknown station ids are an error, naming the id", async () => {
    const source = await failure(search(data, { sourceId: "NOPE" }));
    expect(source.code).toBe("INVALID_STATION");
    expect(source.message).toContain("NOPE");
    expect((await failure(search(data, { destinationId: "ZZZ" }))).code).toBe("INVALID_STATION");
  });

  test("invalid dates and times are errors", async () => {
    expect((await failure(search(data, { date: "2026-02-30" }))).code).toBe("INVALID_DATE");
    expect((await failure(search(data, { date: "tomorrow" }))).code).toBe("INVALID_DATE");
    expect((await failure(search(data, { earliestDeparture: "24:00" }))).code).toBe("INVALID_TIME");
    expect((await failure(search(data, { earliestDeparture: "7:00" }))).code).toBe("INVALID_TIME");
  });

  test("unsupported transfer limits are errors", async () => {
    for (const maxTransfers of [-1, 1.5, 5, Number.NaN]) {
      expect((await failure(search(data, {}, { maxTransfers }))).code).toBe("INVALID_MAX_TRANSFERS");
    }
  });

  test("nonsensical options are errors", async () => {
    expect((await failure(search(data, {}, { beamWidth: 0 }))).code).toBe("INVALID_OPTIONS");
    expect((await failure(search(data, {}, { transfer: { defaultMinutes: -5 } }))).code).toBe("INVALID_OPTIONS");
  });

  test("an empty timetable is reported as missing schedule data", async () => {
    const empty = createInMemoryRailData({ stations: stationsOf([mk("10111", [["SRC", null, "08:00"], ["DST", "09:00", null]])]), trains: [] });
    expect((await failure(search(empty))).code).toBe("NO_SCHEDULE_DATA");
  });

  test("returns an empty list, not an invented route, when nothing connects", async () => {
    const disconnected = rail(
      mk("10112", [["SRC", null, "08:00"], ["AAA", "09:00", null]]),
      mk("10113", [["BBB", null, "08:00"], ["DST", "09:00", null]]),
    );
    expect(await search(disconnected)).toEqual({ journeys: [], warnings: [] });
  });

  test("returns nothing when the only train has already left and does not run again soon", async () => {
    const weekly = rail(mk("10114", [["SRC", null, "08:00"], ["DST", "12:00", null]], ["tue"]));
    expect((await search(weekly, { earliestDeparture: "09:00" })).journeys).toEqual([]);
  });
});

describe("incomplete schedule data", () => {
  /** A source that skips validation, as an external provider's data might. */
  const unvalidated = (trains: Train[]): RailData => {
    const stations = stationsOf(trains);
    return {
      getStation: async (id) => stations.find((s) => s.id === id) ?? null,
      getTrain: async (n) => trains.find((t) => t.number === n) ?? null,
      listStations: async () => stations,
      listTrains: async () => trains,
      trainsStoppingAt: async (id) => trains.filter((t) => t.stops.some((s) => s.stationId === id)),
    };
  };

  test("a stop with no usable arrival is never used to get off, and the train is flagged", async () => {
    const broken = mk("10120", [["SRC", null, "08:00"], ["JNA", null, null]]); // arrives nowhere
    const data = unvalidated([broken, mk("10121", [["JNA", null, "10:30"], ["DST", "12:00", null]])]);
    const result = await search(data);
    expect(result.journeys).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "INCOMPLETE_SCHEDULE", trainNumber: "10120" })]);
  });

  test("an unparseable time is treated as missing, not as a valid time", async () => {
    const garbled = mk("10122", [["SRC", null, "08:00"], ["JNA", "25:99", null]]);
    const data = unvalidated([garbled, mk("10123", [["JNA", null, "11:00"], ["DST", "12:00", null]])]);
    expect((await search(data)).journeys).toEqual([]);
  });

  test("a train with out-of-order times is skipped entirely and reported", async () => {
    const backwards = mk("10124", [["SRC", null, "08:00"], ["DST", "07:00", null]]);
    const result = await search(unvalidated([backwards, mk("10125", [["AAA", null, "08:00"], ["BBB", "09:00", null]])]));
    expect(result.journeys).toEqual([]);
    expect(result.warnings.map((w) => w.trainNumber)).toEqual(["10124"]);
    expect(result.warnings[0]!.message).toContain("skipped");
  });

  test("a partly incomplete train is still used where its times are present, with a warning", async () => {
    const partial = mk("10126", [["SRC", null, "08:00"], ["MID", null, "10:00"], ["DST", "12:00", null]]);
    const result = await search(unvalidated([partial]));
    expect(result.journeys).toHaveLength(1);
    expect(result.journeys[0]!.warnings.map((w) => w.code)).toContain("INCOMPLETE_TRAIN_SCHEDULE");
    expect(result.warnings.map((w) => w.trainNumber)).toEqual(["10126"]);
  });

  test("a train that cannot be boarded at the source (no departure) is not offered", async () => {
    const noDeparture = mk("10127", [["SRC", null, null], ["DST", "12:00", null]]);
    expect((await search(unvalidated([noDeparture]))).journeys).toEqual([]);
  });
});

describe("against the mock dataset", () => {
  test("finds the direct Karnataka Express", async () => {
    const { journeys } = await findAlternativeJourneys(mockRailData, {
      sourceId: "SBC",
      destinationId: "NDLS",
      date: TUE,
      earliestDeparture: "19:00",
    });
    expect(journeys[0]!.legs[0]).toMatchObject({ trainNumber: "12627", durationMinutes: 2260, originDate: TUE });
  });

  test("connects Howrah to Agra via New Delhi, overnight, with independently checked times", async () => {
    const { journeys } = await findAlternativeJourneys(mockRailData, {
      sourceId: "HWH",
      destinationId: "AGC",
      date: TUE,
      earliestDeparture: "16:00",
    });
    expect(journeys).toHaveLength(1);
    const j = journeys[0]!;
    expect(j.legs.map((l) => [l.trainNumber, l.from.id, l.to.id])).toEqual([
      ["12301", "HWH", "NDLS"],
      ["12622", "NDLS", "AGC"],
    ]);
    // Rajdhani reaches New Delhi 10:05 on the 21st; Tamil Nadu Express leaves 21:05 the same day.
    expect(j.transfers[0]).toMatchObject({ waitMinutes: 11 * 60, arrival: ist("2026-10-21", "10:05"), departure: ist("2026-10-21", "21:05") });
    expect(j.departure).toBe(ist(TUE, "16:50"));
    expect(j.arrival).toBe(ist("2026-10-21", "23:25"));
    expect(j.totalDurationMinutes).toBe(30 * 60 + 35);
  });
});
