import { addDays, elapsedMinutes, toInstant, weekdayOf } from "./time.ts";
import type { IsoDate, Train, TrainStop } from "./types.ts";

export const stopOf = (train: Train, stationId: string): TrainStop | undefined =>
  train.stops.find((s) => s.stationId === stationId);

/** Total scheduled journey time, origin departure to final arrival. */
export function totalDurationMinutes(train: Train): number {
  const first = train.stops[0]!.departure!;
  const last = train.stops[train.stops.length - 1]!.arrival!;
  return elapsedMinutes(last) - elapsedMinutes(first);
}

/** Whether the train leaves its origin on this date. */
export function runsOnOriginDate(train: Train, originDate: IsoDate): boolean {
  return train.runDays.includes(weekdayOf(originDate));
}

export type Departure = {
  /** The date the train left its origin; identifies this particular run of the train. */
  originDate: IsoDate;
  stop: TrainStop;
  departsAt: Date;
};

/**
 * The run of `train` that departs `stationId` on the calendar date `date`, if there is one.
 * runDays are origin weekdays, so for an overnight train a boarding date has to be mapped back
 * to the origin date first: a train leaving Delhi on day 2 of a Mon-origin run departs Tuesday.
 */
export function findDeparture(train: Train, stationId: string, date: IsoDate): Departure | null {
  const stop = stopOf(train, stationId);
  if (!stop?.departure) return null;

  const originDate = addDays(date, -stop.departure.dayOffset);
  if (!runsOnOriginDate(train, originDate)) return null;
  return { originDate, stop, departsAt: toInstant(originDate, stop.departure) };
}

export type Segment = {
  from: TrainStop;
  to: TrainStop;
  durationMinutes: number;
  distanceKm: number;
  /** Calendar days crossed: 0 for same-day, 1 for an overnight ride, and so on. */
  daysCrossed: number;
};

/** The ride from one stop to a later one on the same train; null if the order is wrong or absent. */
export function getSegment(train: Train, fromId: string, toId: string): Segment | null {
  const fromIndex = train.stops.findIndex((s) => s.stationId === fromId);
  const toIndex = train.stops.findIndex((s) => s.stationId === toId);
  if (fromIndex < 0 || toIndex <= fromIndex) return null;

  const from = train.stops[fromIndex]!;
  const to = train.stops[toIndex]!;
  return {
    from,
    to,
    durationMinutes: elapsedMinutes(to.arrival!) - elapsedMinutes(from.departure!),
    distanceKm: Math.round((to.distanceKm - from.distanceKm) * 10) / 10,
    daysCrossed: to.arrival!.dayOffset - from.departure!.dayOffset,
  };
}
