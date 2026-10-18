import { describe, expect, test } from "bun:test";
import { addDays, elapsedMinutes, formatScheduleTime, isIsoDate, parseClock, toInstant, weekdayOf } from "./time.ts";

describe("parseClock", () => {
  test("accepts valid 24-hour times", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("06:35")).toBe(395);
    expect(parseClock("23:59")).toBe(1439);
  });

  test("rejects malformed times", () => {
    for (const bad of ["24:00", "12:60", "7:30", "07:5", "0730", "", "ab:cd", "07:30:00"]) {
      expect(parseClock(bad)).toBeNull();
    }
  });
});

describe("elapsedMinutes", () => {
  test("keeps counting past midnight", () => {
    expect(elapsedMinutes({ dayOffset: 0, time: "23:50" })).toBe(1430);
    expect(elapsedMinutes({ dayOffset: 1, time: "00:05" })).toBe(1445);
    expect(elapsedMinutes({ dayOffset: 2, time: "06:35" })).toBe(2 * 1440 + 395);
  });

  test("a ride across midnight has the right positive duration", () => {
    const depart = elapsedMinutes({ dayOffset: 0, time: "23:50" });
    const arrive = elapsedMinutes({ dayOffset: 1, time: "00:05" });
    expect(arrive - depart).toBe(15);
  });

  test("throws on an invalid time instead of returning garbage", () => {
    expect(() => elapsedMinutes({ dayOffset: 0, time: "25:00" })).toThrow(RangeError);
  });
});

describe("formatScheduleTime", () => {
  test("marks later days and leaves the origin day plain", () => {
    expect(formatScheduleTime({ dayOffset: 0, time: "17:00" })).toBe("17:00");
    expect(formatScheduleTime({ dayOffset: 1, time: "08:32" })).toBe("08:32 (+1)");
    expect(formatScheduleTime({ dayOffset: 2, time: "06:35" })).toBe("06:35 (+2)");
  });
});

describe("dates", () => {
  test("isIsoDate accepts real calendar dates only", () => {
    expect(isIsoDate("2026-10-19")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true); // leap year
    for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "26-1-1", "2026-1-01", ""]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });

  test("addDays crosses month, year and leap-day boundaries in both directions", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-19", 0)).toBe("2026-10-19");
  });

  test("addDays throws on an invalid date", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });

  test("weekdayOf maps to Monday-first weekdays", () => {
    expect(weekdayOf("2026-10-19")).toBe("mon");
    expect(weekdayOf("2026-10-20")).toBe("tue");
    expect(weekdayOf("2026-10-24")).toBe("sat");
    expect(weekdayOf("2026-10-25")).toBe("sun");
  });

  test("toInstant converts IST wall-clock time to the correct instant, rolling the date", () => {
    // 17:00 IST is 11:30 UTC.
    expect(toInstant("2026-10-19", { dayOffset: 0, time: "17:00" }).toISOString()).toBe("2026-10-19T11:30:00.000Z");
    // 00:25 the next day IST is 18:55 UTC on the origin day.
    expect(toInstant("2026-10-19", { dayOffset: 1, time: "00:25" }).toISOString()).toBe("2026-10-19T18:55:00.000Z");
    // The rollover also crosses a month boundary.
    expect(toInstant("2026-10-31", { dayOffset: 1, time: "08:32" }).toISOString()).toBe("2026-11-01T03:02:00.000Z");
  });
});
