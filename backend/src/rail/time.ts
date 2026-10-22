import { WEEKDAYS, type IsoDate, type ScheduleTime, type Weekday } from "./types.ts";

export const MINUTES_PER_DAY = 24 * 60;
const IST_OFFSET = "+05:30"; // India has a single timezone and no daylight saving.
const IST_OFFSET_MS = 330 * 60_000;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Minutes since midnight for a valid "HH:MM", else null. */
export function parseClock(time: string): number | null {
  const match = TIME_PATTERN.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Minutes since 00:00 on the origin departure day. Monotonic along a journey, even past midnight. */
export function elapsedMinutes(t: ScheduleTime): number {
  const clock = parseClock(t.time);
  if (clock === null) throw new RangeError(`Invalid time "${t.time}"`);
  return t.dayOffset * MINUTES_PER_DAY + clock;
}

/** "06:35 (+2)" for display; the suffix is omitted on the origin day. */
export function formatScheduleTime(t: ScheduleTime): string {
  return t.dayOffset > 0 ? `${t.time} (+${t.dayOffset})` : t.time;
}

export function isIsoDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects overflow such as 2026-02-30, which Date would silently roll into March.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toUtcDate(date: IsoDate): Date {
  if (!isIsoDate(date)) throw new RangeError(`Invalid date "${date}"`);
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const result = toUtcDate(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function weekdayOf(date: IsoDate): Weekday {
  // getUTCDay: 0 = Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(toUtcDate(date).getUTCDay() + 6) % 7]!;
}

/** The real instant a schedule time falls on, given the date the train left its origin. */
export function toInstant(originDate: IsoDate, t: ScheduleTime): Date {
  const clock = parseClock(t.time);
  if (clock === null) throw new RangeError(`Invalid time "${t.time}"`);
  return new Date(`${addDays(originDate, t.dayOffset)}T${t.time}:00${IST_OFFSET}`);
}

/** The IST calendar date an instant falls on. */
export function istDateOf(instant: Date): IsoDate {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch milliseconds of 00:00 IST on this date; add elapsed minutes to get a schedule instant. */
export function istMidnightMs(date: IsoDate): number {
  if (!isIsoDate(date)) throw new RangeError(`Invalid date "${date}"`);
  return new Date(`${date}T00:00:00${IST_OFFSET}`).getTime();
}
