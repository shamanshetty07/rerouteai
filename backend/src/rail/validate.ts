import { elapsedMinutes, MINUTES_PER_DAY, parseClock } from "./time.ts";
import { TRAIN_TYPES, WEEKDAYS, type ScheduleTime, type Station, type Train } from "./types.ts";

export type ValidationIssue = { path: string; message: string };

const MAX_DAY_OFFSET = 6; // longest Indian Railways journeys are around 4 days
const TRAIN_NUMBER = /^\d{5}$/;
const STATION_CODE = /^[A-Z]{1,5}$/;
const blank = (value: string) => value.trim() === "";

export function validateStations(stations: readonly Station[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const codes = new Set<string>();

  stations.forEach((station, i) => {
    const path = `stations[${station.id || i}]`;
    if (blank(station.id)) issues.push({ path, message: "id is required" });
    else if (ids.has(station.id)) issues.push({ path, message: "duplicate station id" });
    ids.add(station.id);

    if (blank(station.name)) issues.push({ path, message: "name is required" });
    if (blank(station.city)) issues.push({ path, message: "city is required" });
    if (station.code !== undefined) {
      if (!STATION_CODE.test(station.code)) issues.push({ path, message: `invalid station code "${station.code}"` });
      else if (codes.has(station.code)) issues.push({ path, message: `duplicate station code "${station.code}"` });
      codes.add(station.code);
    }
  });
  return issues;
}

function timeIssue(t: ScheduleTime): string | null {
  if (!Number.isInteger(t.dayOffset) || t.dayOffset < 0 || t.dayOffset > MAX_DAY_OFFSET) {
    return `dayOffset must be an integer from 0 to ${MAX_DAY_OFFSET}, got ${t.dayOffset}`;
  }
  if (parseClock(t.time) === null) return `time must be a valid 24-hour HH:MM, got "${t.time}"`;
  return null;
}

/**
 * Structural and chronological checks for one train. Pass `knownStationIds` to also check that
 * every stop refers to a station that exists.
 */
export function validateTrain(train: Train, knownStationIds?: ReadonlySet<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const base = `trains[${train.number}]`;
  const report = (path: string, message: string) => issues.push({ path: `${base}${path}`, message });

  if (!TRAIN_NUMBER.test(train.number)) report("", `number must be five digits, got "${train.number}"`);
  if (blank(train.name)) report(".name", "name is required");
  if (!TRAIN_TYPES.includes(train.type)) report(".type", `unknown type "${train.type}"`);

  if (train.runDays.length === 0) report(".runDays", "must run on at least one day");
  const seenDays = new Set<string>();
  for (const day of train.runDays) {
    if (!WEEKDAYS.includes(day)) report(".runDays", `unknown weekday "${day}"`);
    else if (seenDays.has(day)) report(".runDays", `duplicate weekday "${day}"`);
    seenDays.add(day);
  }

  if (train.stops.length < 2) {
    report(".stops", "a train needs at least an origin and a final stop");
    return issues;
  }

  const last = train.stops.length - 1;
  const seenStations = new Set<string>();
  let previousDeparture: number | null = null; // elapsed minutes of the last valid departure
  let previousKm = -1;

  train.stops.forEach((stop, i) => {
    const at = `.stops[${i}]`;

    if (blank(stop.stationId)) report(at, "stationId is required");
    else if (seenStations.has(stop.stationId)) report(at, `station ${stop.stationId} appears twice`);
    else if (knownStationIds && !knownStationIds.has(stop.stationId)) report(at, `unknown station ${stop.stationId}`);
    seenStations.add(stop.stationId);

    if (!Number.isFinite(stop.distanceKm) || stop.distanceKm < 0) report(`${at}.distanceKm`, "must be a non-negative number");
    else if (i === 0 && stop.distanceKm !== 0) report(`${at}.distanceKm`, "origin must be at 0 km");
    else if (i > 0 && stop.distanceKm <= previousKm) report(`${at}.distanceKm`, "must increase along the route");
    if (Number.isFinite(stop.distanceKm)) previousKm = stop.distanceKm;

    // Which times a stop must have depends on its position.
    if (i === 0 && stop.arrival !== null) report(`${at}.arrival`, "origin must not have an arrival");
    if (i > 0 && stop.arrival === null) report(`${at}.arrival`, "arrival is required");
    if (i === last && stop.departure !== null) report(`${at}.departure`, "final stop must not have a departure");
    if (i < last && stop.departure === null) report(`${at}.departure`, "departure is required");

    let arrival: number | null = null;
    let departure: number | null = null;
    for (const [key, t] of [["arrival", stop.arrival], ["departure", stop.departure]] as const) {
      if (!t) continue;
      const problem = timeIssue(t);
      if (problem) report(`${at}.${key}`, problem);
      else if (key === "arrival") arrival = elapsedMinutes(t);
      else departure = elapsedMinutes(t);
    }

    if (i === 0 && stop.departure && stop.departure.dayOffset !== 0) {
      report(`${at}.departure`, "origin departure must have dayOffset 0");
    }

    if (arrival !== null && previousDeparture !== null) {
      if (arrival <= previousDeparture) {
        report(`${at}.arrival`, "arrives at or before the previous departure; is a day rollover (dayOffset) missing?");
      } else if (arrival - previousDeparture > MINUTES_PER_DAY) {
        report(`${at}.arrival`, "more than 24 hours since the previous stop; is dayOffset too large?");
      }
    }
    if (departure !== null && arrival !== null && departure < arrival) {
      report(`${at}.departure`, "departs before it arrives; is a day rollover (dayOffset) missing?");
    }
    if (departure !== null) previousDeparture = departure;
    else if (arrival !== null) previousDeparture = arrival;
  });

  return issues;
}

export function validateRailData(data: { stations: readonly Station[]; trains: readonly Train[] }): ValidationIssue[] {
  const issues = validateStations(data.stations);
  const stationIds = new Set(data.stations.map((s) => s.id));
  const numbers = new Set<string>();

  for (const train of data.trains) {
    if (numbers.has(train.number)) issues.push({ path: `trains[${train.number}]`, message: "duplicate train number" });
    numbers.add(train.number);
    issues.push(...validateTrain(train, stationIds));
  }
  return issues;
}
