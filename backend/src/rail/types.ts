// Domain model for rail data. Deliberately free of any UI or external-API types so the
// data source (mock today, an API adapter later) can change without touching consumers.

export type Station = {
  /** Stable unique identifier; what the app keys selections and train stops on. */
  id: string;
  name: string;
  /** Official station code, when the data source has one. */
  code?: string;
  city: string;
};

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const TRAIN_TYPES = [
  "vande-bharat",
  "rajdhani",
  "shatabdi",
  "duronto",
  "superfast",
  "express",
  "passenger",
] as const;
export type TrainType = (typeof TRAIN_TYPES)[number];

/**
 * A wall-clock time in Indian Standard Time, relative to the day the train leaves its origin.
 * `dayOffset` 0 is the origin departure day, 1 the next calendar day, and so on, so an overnight
 * journey is just a sequence of times whose dayOffset increases past midnight (23:50 -> 00:05 +1).
 */
export type ScheduleTime = {
  dayOffset: number;
  /** 24-hour "HH:MM". */
  time: string;
};

export type TrainStop = {
  stationId: string;
  /** `null` only at the origin. */
  arrival: ScheduleTime | null;
  /** `null` only at the final stop. */
  departure: ScheduleTime | null;
  /** Cumulative distance from the origin in km. */
  distanceKm: number;
};

export type Train = {
  /** Five-digit Indian Railways train number, kept as a string to preserve it exactly. */
  number: string;
  name: string;
  type: TrainType;
  /** Weekdays on which the train leaves its ORIGIN, not the weekday at any later stop. */
  runDays: Weekday[];
  /** Ordered from origin to final stop. Order is the sequence; there is no separate index. */
  stops: TrainStop[];
};

/** A calendar date as "YYYY-MM-DD" (IST), the same shape as the search form's date input. */
export type IsoDate = string;
