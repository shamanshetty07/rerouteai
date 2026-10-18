import { describe, expect, test } from "bun:test";
import { mockTrains } from "./mockTrains.ts";
import { findDeparture, getSegment, runsOnOriginDate, totalDurationMinutes } from "./schedule.ts";
import type { Train } from "./types.ts";

const byNumber = (number: string): Train => {
  const found = mockTrains.find((t) => t.number === number);
  if (!found) throw new Error(`No mock train ${number}`);
  return found;
};

describe("totalDurationMinutes", () => {
  // The expected values are the durations Indian Railways publishes for these trains, so they
  // check the day-offset arithmetic against independent data, not against itself.
  test.each([
    ["12002", 520], // same-day Shatabdi
    ["12951", 932], // one night
    ["12301", 1035], // one night
    ["12622", 2010], // two nights
    ["12627", 2260], // two nights
    ["20808", 2755], // three calendar days
  ])("train %s takes %d minutes", (number, minutes) => {
    expect(totalDurationMinutes(byNumber(number))).toBe(minutes);
  });
});

describe("runsOnOriginDate", () => {
  test("uses the origin weekday", () => {
    const howrahRajdhani = byNumber("12301"); // not on Sundays
    expect(runsOnOriginDate(howrahRajdhani, "2026-10-24")).toBe(true); // Saturday
    expect(runsOnOriginDate(howrahRajdhani, "2026-10-25")).toBe(false); // Sunday
  });
});

describe("findDeparture (overnight-aware boarding lookup)", () => {
  const howrahRajdhani = byNumber("12301"); // Mon-Sat from Howrah; reaches Kanpur after midnight

  test("finds a same-day departure at the origin", () => {
    const dep = findDeparture(howrahRajdhani, "HWH", "2026-10-20")!;
    expect(dep.originDate).toBe("2026-10-20");
    expect(dep.departsAt.toISOString()).toBe("2026-10-20T11:20:00.000Z"); // 16:50 IST
  });

  test("maps a boarding date after midnight back to the origin date", () => {
    const dep = findDeparture(howrahRajdhani, "CNB", "2026-10-20")!; // Kanpur 04:50 on Tuesday
    expect(dep.originDate).toBe("2026-10-19"); // train left Howrah on Monday
    expect(dep.departsAt.toISOString()).toBe("2026-10-19T23:20:00.000Z"); // 04:50 IST Tuesday
  });

  test("a Monday-morning departure from Kanpur needs a Sunday origin run, which doesn't exist", () => {
    expect(findDeparture(howrahRajdhani, "CNB", "2026-10-19")).toBeNull();
  });

  test("a Sunday-morning departure from Kanpur exists because the train left Howrah on Saturday", () => {
    const dep = findDeparture(howrahRajdhani, "CNB", "2026-10-25")!;
    expect(dep.originDate).toBe("2026-10-24");
  });

  test("the origin has no run on a non-running day", () => {
    expect(findDeparture(howrahRajdhani, "HWH", "2026-10-25")).toBeNull();
  });

  test("handles a three-day, thrice-weekly train (Hirakud: Wed/Sat/Sun from Amritsar)", () => {
    const hirakud = byNumber("20808");
    // New Delhi departs 08:15 on day 2, so a Thursday boarding comes from a Wednesday origin run.
    expect(findDeparture(hirakud, "NDLS", "2026-10-22")?.originDate).toBe("2026-10-21");
    expect(findDeparture(hirakud, "NDLS", "2026-10-21")).toBeNull(); // would need a Tuesday origin
    expect(findDeparture(hirakud, "ASR", "2026-10-21")?.departsAt.toISOString()).toBe("2026-10-21T18:25:00.000Z"); // 23:55 IST
  });

  test("rolls the date across a month boundary", () => {
    const rajdhani = byNumber("12951"); // daily from Mumbai
    const dep = findDeparture(rajdhani, "KOTA", "2026-11-01")!;
    expect(dep.originDate).toBe("2026-10-31");
    expect(dep.departsAt.toISOString()).toBe("2026-10-31T21:50:00.000Z"); // 03:20 IST on 1 Nov
  });

  test("has no departure from the final stop or an unknown station", () => {
    expect(findDeparture(howrahRajdhani, "NDLS", "2026-10-20")).toBeNull();
    expect(findDeparture(howrahRajdhani, "ZZZ", "2026-10-20")).toBeNull();
  });

  test("a halt that straddles midnight departs on the next day", () => {
    const train: Train = {
      number: "12345",
      name: "Midnight Halt Express",
      type: "express",
      runDays: ["fri"],
      stops: [
        { stationId: "A", arrival: null, departure: { dayOffset: 0, time: "22:00" }, distanceKm: 0 },
        { stationId: "B", arrival: { dayOffset: 0, time: "23:58" }, departure: { dayOffset: 1, time: "00:03" }, distanceKm: 100 },
        { stationId: "C", arrival: { dayOffset: 1, time: "02:00" }, departure: null, distanceKm: 200 },
      ],
    };
    // Arrives Friday 23:58, leaves Saturday 00:03; a Saturday boarding maps to the Friday run.
    const dep = findDeparture(train, "B", "2026-10-24")!;
    expect(dep.originDate).toBe("2026-10-23");
    expect(findDeparture(train, "B", "2026-10-23")).toBeNull();
  });
});

describe("getSegment", () => {
  test("measures a full overnight journey", () => {
    const seg = getSegment(byNumber("12951"), "MMCT", "NDLS")!;
    expect(seg.durationMinutes).toBe(932);
    expect(seg.distanceKm).toBe(1388.4);
    expect(seg.daysCrossed).toBe(1);
  });

  test("measures a short ride that crosses midnight", () => {
    // Vadodara 21:16 -> Ratlam 00:25 the next day.
    const seg = getSegment(byNumber("12951"), "BRC", "RTM")!;
    expect(seg.durationMinutes).toBe(3 * 60 + 9);
    expect(seg.daysCrossed).toBe(1);
    expect(seg.distanceKm).toBe(260.4);
  });

  test("a same-day ride crosses no days", () => {
    expect(getSegment(byNumber("12002"), "NDLS", "BPL")!.daysCrossed).toBe(0);
  });

  test("spans two nights", () => {
    expect(getSegment(byNumber("12622"), "NDLS", "MAS")!.daysCrossed).toBe(2);
  });

  test("rejects backwards, identical and unknown pairs", () => {
    const train = byNumber("12951");
    expect(getSegment(train, "NDLS", "MMCT")).toBeNull();
    expect(getSegment(train, "ST", "ST")).toBeNull();
    expect(getSegment(train, "ST", "ZZZ")).toBeNull();
    expect(getSegment(train, "ZZZ", "ST")).toBeNull();
  });
});
