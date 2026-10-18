import { describe, expect, test } from "bun:test";
import { mockRailData, mockTrains } from "./mockTrains.ts";
import { mockStations } from "./mockStations.ts";
import type { ScheduleTime, Station, Train } from "./types.ts";
import { validateRailData, validateStations, validateTrain, type ValidationIssue } from "./validate.ts";

const t = (time: string, dayOffset = 0): ScheduleTime => ({ dayOffset, time });

/** A valid overnight train; individual tests break one thing at a time. */
function makeTrain(overrides: Partial<Train> = {}): Train {
  return {
    number: "12345",
    name: "Test Express",
    type: "express",
    runDays: ["mon", "fri"],
    stops: [
      { stationId: "A", arrival: null, departure: t("22:00"), distanceKm: 0 },
      { stationId: "B", arrival: t("23:50"), departure: t("23:55"), distanceKm: 100 },
      { stationId: "C", arrival: t("00:30", 1), departure: t("00:35", 1), distanceKm: 200 },
      { stationId: "D", arrival: t("06:00", 1), departure: null, distanceKm: 300 },
    ],
    ...overrides,
  };
}

/** Replaces one stop's fields. */
function patchStop(train: Train, index: number, patch: Partial<Train["stops"][number]>): Train {
  return { ...train, stops: train.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) };
}

const has = (issues: ValidationIssue[], path: string, text: string) =>
  issues.some((i) => i.path === path && i.message.includes(text));

describe("valid data", () => {
  test("the mock dataset passes validation", () => {
    expect(validateRailData({ stations: mockStations, trains: mockTrains })).toEqual([]);
    expect(mockRailData).toBeDefined();
  });

  test("an overnight train whose times pass midnight is valid", () => {
    expect(validateTrain(makeTrain())).toEqual([]);
  });

  test("a halt that straddles midnight is valid", () => {
    const train = patchStop(makeTrain(), 1, { arrival: t("23:58"), departure: t("00:03", 1) });
    expect(validateTrain(train)).toEqual([]);
  });
});

describe("overnight consistency", () => {
  test("flags a time that goes backwards because the day rollover is missing", () => {
    // 23:55 -> 00:30 with no +1 looks like time travel.
    const train = patchStop(makeTrain(), 2, { arrival: t("00:30"), departure: t("00:35") });
    const issues = validateTrain(train);
    expect(has(issues, "trains[12345].stops[2].arrival", "day rollover")).toBe(true);
  });

  test("flags a departure that is before the arrival at the same stop", () => {
    const train = patchStop(makeTrain(), 1, { arrival: t("23:50"), departure: t("23:40") });
    expect(has(validateTrain(train), "trains[12345].stops[1].departure", "before it arrives")).toBe(true);
  });

  test("flags a day offset that jumps too far", () => {
    const train = patchStop(makeTrain(), 3, { arrival: t("06:00", 3) });
    expect(has(validateTrain(train), "trains[12345].stops[3].arrival", "24 hours")).toBe(true);
  });

  test("flags an origin departure that is not on day 0", () => {
    const train = patchStop(makeTrain(), 0, { departure: t("22:00", 1) });
    expect(has(validateTrain(train), "trains[12345].stops[0].departure", "dayOffset 0")).toBe(true);
  });

  test("rejects arriving at the exact minute the train left the previous stop", () => {
    const train = patchStop(makeTrain(), 2, { arrival: t("23:55"), departure: t("23:56") });
    expect(has(validateTrain(train), "trains[12345].stops[2].arrival", "at or before")).toBe(true);
  });
});

describe("times", () => {
  test.each([["24:00"], ["7:30"], ["12:60"], ["noon"]])("rejects the time %p", (time) => {
    const train = patchStop(makeTrain(), 1, { arrival: t(time) });
    expect(has(validateTrain(train), "trains[12345].stops[1].arrival", "HH:MM")).toBe(true);
  });

  test.each([[-1], [1.5], [7]])("rejects the dayOffset %p", (dayOffset) => {
    const train = patchStop(makeTrain(), 1, { arrival: t("23:50", dayOffset) });
    expect(has(validateTrain(train), "trains[12345].stops[1].arrival", "dayOffset")).toBe(true);
  });
});

describe("stops", () => {
  test("requires arrival and departure only where they make sense", () => {
    const withOriginArrival = patchStop(makeTrain(), 0, { arrival: t("21:50") });
    expect(has(validateTrain(withOriginArrival), "trains[12345].stops[0].arrival", "origin")).toBe(true);

    const withFinalDeparture = patchStop(makeTrain(), 3, { departure: t("06:10", 1) });
    expect(has(validateTrain(withFinalDeparture), "trains[12345].stops[3].departure", "final stop")).toBe(true);

    const noMiddleArrival = patchStop(makeTrain(), 1, { arrival: null });
    expect(has(validateTrain(noMiddleArrival), "trains[12345].stops[1].arrival", "required")).toBe(true);

    const noMiddleDeparture = patchStop(makeTrain(), 1, { departure: null });
    expect(has(validateTrain(noMiddleDeparture), "trains[12345].stops[1].departure", "required")).toBe(true);
  });

  test("needs at least two stops", () => {
    const issues = validateTrain(makeTrain({ stops: makeTrain().stops.slice(0, 1) }));
    expect(has(issues, "trains[12345].stops", "at least")).toBe(true);
  });

  test("rejects a station appearing twice", () => {
    const train = patchStop(makeTrain(), 2, { stationId: "B" });
    expect(has(validateTrain(train), "trains[12345].stops[2]", "appears twice")).toBe(true);
  });

  test("checks stops against known stations when given them", () => {
    const issues = validateTrain(makeTrain(), new Set(["A", "B", "C"]));
    expect(has(issues, "trains[12345].stops[3]", "unknown station D")).toBe(true);
    expect(validateTrain(makeTrain(), new Set(["A", "B", "C", "D"]))).toEqual([]);
  });

  test("distance starts at zero and strictly increases", () => {
    expect(has(validateTrain(patchStop(makeTrain(), 0, { distanceKm: 5 })), "trains[12345].stops[0].distanceKm", "0 km")).toBe(true);
    expect(has(validateTrain(patchStop(makeTrain(), 2, { distanceKm: 100 })), "trains[12345].stops[2].distanceKm", "increase")).toBe(true);
    expect(has(validateTrain(patchStop(makeTrain(), 2, { distanceKm: -3 })), "trains[12345].stops[2].distanceKm", "non-negative")).toBe(true);
  });
});

describe("train fields", () => {
  test("number must be five digits", () => {
    expect(validateTrain(makeTrain({ number: "1234" })).some((i) => i.message.includes("five digits"))).toBe(true);
    expect(validateTrain(makeTrain({ number: "ABCDE" })).some((i) => i.message.includes("five digits"))).toBe(true);
  });

  test("name, type and run days are checked", () => {
    expect(has(validateTrain(makeTrain({ name: "  " })), "trains[12345].name", "required")).toBe(true);
    expect(has(validateTrain(makeTrain({ type: "bullet" as Train["type"] })), "trains[12345].type", "unknown")).toBe(true);
    expect(has(validateTrain(makeTrain({ runDays: [] })), "trains[12345].runDays", "at least one")).toBe(true);
    expect(has(validateTrain(makeTrain({ runDays: ["mon", "mon"] })), "trains[12345].runDays", "duplicate")).toBe(true);
    expect(has(validateTrain(makeTrain({ runDays: ["monday" as "mon"] })), "trains[12345].runDays", "unknown weekday")).toBe(true);
  });
});

describe("whole dataset", () => {
  const stations: Station[] = ["A", "B", "C", "D"].map((id) => ({ id, code: id, name: `Station ${id}`, city: "City" }));

  test("accepts a consistent dataset", () => {
    expect(validateRailData({ stations, trains: [makeTrain()] })).toEqual([]);
  });

  test("rejects duplicate train numbers and unknown stations", () => {
    const issues = validateRailData({ stations: stations.slice(0, 3), trains: [makeTrain(), makeTrain()] });
    expect(issues.some((i) => i.message.includes("duplicate train number"))).toBe(true);
    expect(issues.some((i) => i.message.includes("unknown station D"))).toBe(true);
  });

  test("rejects duplicate or malformed stations", () => {
    const dup = [...stations, { id: "A", code: "AA", name: "Again", city: "City" }];
    expect(validateStations(dup).some((i) => i.message.includes("duplicate station id"))).toBe(true);

    const dupCode = [...stations, { id: "E", code: "A", name: "E", city: "City" }];
    expect(validateStations(dupCode).some((i) => i.message.includes('duplicate station code "A"'))).toBe(true);

    const messages = validateStations([{ id: "X", code: "x1", name: "", city: " " }]).map((i) => i.message);
    expect(messages).toContain("name is required");
    expect(messages).toContain("city is required");
    expect(messages).toContain('invalid station code "x1"');
  });

  test("a station may omit its code", () => {
    expect(validateStations([{ id: "X", name: "No Code", city: "Somewhere" }])).toEqual([]);
  });
});
