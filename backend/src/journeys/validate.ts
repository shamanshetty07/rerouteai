import type { Journey, JourneyLeg, JourneyStation, JourneyTransfer, JourneyWarning } from "../rail/journey.ts";
import { TRAIN_TYPES } from "../rail/types.ts";

/** The message is safe to return: it names the field, never echoes the value. */
export class JourneyValidationError extends Error {}

const WARNING_CODES = ["NO_REAL_TIME_DATA", "PLATFORM_CHANGE_UNVERIFIED", "INCOMPLETE_TRAIN_SCHEDULE"] as const;
const MAX_LEGS = 5; // the route search supports at most 4 transfers
const MAX_MINUTES = 14_400; // 10 days
const ID = /^[A-Za-z0-9_-]{1,16}$/;
const TRAIN_NUMBER = /^[A-Za-z0-9]{1,10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const fail = (path: string, what = "is invalid"): never => {
  throw new JourneyValidationError(`${path} ${what}`);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function object(v: unknown, path: string): Record<string, unknown> {
  return isObject(v) ? v : fail(path, "must be an object");
}

function text(v: unknown, path: string, max: number, pattern?: RegExp): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) fail(path);
  // No control characters (newlines, NUL, ...), and the identifiers have a strict alphabet.
  if (/[\u0000-\u001f\u007f]/.test(v as string) || (pattern && !pattern.test(v as string))) fail(path);
  return v as string;
}

function integer(v: unknown, path: string, min: number, max: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail(path);
}

function decimal(v: unknown, path: string, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fail(path);
}

function instant(v: unknown, path: string): string {
  const s = text(v, path, 30, INSTANT);
  return Number.isNaN(Date.parse(s)) ? fail(path) : s;
}

function date(v: unknown, path: string): string {
  const s = text(v, path, 10, DATE);
  return Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s ? fail(path) : s;
}

function station(v: unknown, path: string): JourneyStation {
  const o = object(v, path);
  const out: JourneyStation = { id: text(o["id"], `${path}.id`, 16, ID), name: text(o["name"], `${path}.name`, 100) };
  if (o["code"] !== undefined) out.code = text(o["code"], `${path}.code`, 16, ID);
  return out;
}

function leg(v: unknown, path: string): JourneyLeg {
  const o = object(v, path);
  const trainType = o["trainType"];
  if (!(TRAIN_TYPES as readonly unknown[]).includes(trainType)) fail(`${path}.trainType`);
  const departure = instant(o["departure"], `${path}.departure`);
  const arrival = instant(o["arrival"], `${path}.arrival`);
  if (Date.parse(arrival) <= Date.parse(departure)) fail(`${path}.arrival`, "must be after the departure");
  return {
    trainNumber: text(o["trainNumber"], `${path}.trainNumber`, 10, TRAIN_NUMBER),
    trainName: text(o["trainName"], `${path}.trainName`, 100),
    trainType: trainType as JourneyLeg["trainType"],
    originDate: date(o["originDate"], `${path}.originDate`),
    from: station(o["from"], `${path}.from`),
    to: station(o["to"], `${path}.to`),
    departure,
    arrival,
    durationMinutes: integer(o["durationMinutes"], `${path}.durationMinutes`, 0, MAX_MINUTES),
    distanceKm: decimal(o["distanceKm"], `${path}.distanceKm`, 0, 10_000),
  };
}

function transfer(v: unknown, path: string): JourneyTransfer {
  const o = object(v, path);
  return {
    station: station(o["station"], `${path}.station`),
    arrival: instant(o["arrival"], `${path}.arrival`),
    departure: instant(o["departure"], `${path}.departure`),
    waitMinutes: integer(o["waitMinutes"], `${path}.waitMinutes`, 0, MAX_MINUTES),
    requiredBufferMinutes: integer(o["requiredBufferMinutes"], `${path}.requiredBufferMinutes`, 0, 1_440),
  };
}

function warning(v: unknown, path: string): JourneyWarning {
  const o = object(v, path);
  if (!(WARNING_CODES as readonly unknown[]).includes(o["code"])) fail(`${path}.code`);
  return { code: o["code"] as JourneyWarning["code"], message: text(o["message"], `${path}.message`, 200) };
}

function list<T>(v: unknown, path: string, min: number, max: number, each: (item: unknown, p: string) => T): T[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(path, `must have ${min === max ? min : `${min} to ${max}`} items`);
  return (v as unknown[]).map((item, i) => each(item, `${path}[${i}]`));
}

/**
 * Checks an untrusted journey and returns a clean copy containing only the known fields (anything
 * else the client sent is dropped). Besides shapes, sizes and alphabets, it checks that the journey
 * hangs together: legs connect station to station, time moves forward, and the totals agree.
 * It cannot prove the timetable really offers the journey; a saved journey is a snapshot of what
 * the user was shown, visible only to them.
 */
export function parseJourney(input: unknown, path = "journey"): Journey {
  const o = object(input, path);
  const legs = list(o["legs"], `${path}.legs`, 1, MAX_LEGS, leg);
  const transfers = list(o["transfers"], `${path}.transfers`, legs.length - 1, legs.length - 1, transfer);
  const source = station(o["source"], `${path}.source`);
  const destination = station(o["destination"], `${path}.destination`);

  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  if (source.id !== first.from.id) fail(`${path}.source`, "must be where the first leg starts");
  if (destination.id !== last.to.id) fail(`${path}.destination`, "must be where the last leg ends");
  if (source.id === destination.id) fail(`${path}.destination`, "must differ from the source");

  legs.forEach((l, i) => {
    const next = legs[i + 1];
    if (!next) return;
    const t = transfers[i]!;
    if (l.to.id !== next.from.id || t.station.id !== l.to.id) fail(`${path}.legs[${i}]`, "does not connect to the next leg");
    if (Date.parse(next.departure) < Date.parse(l.arrival)) fail(`${path}.legs[${i + 1}].departure`, "is before the previous leg arrives");
  });

  const departure = instant(o["departure"], `${path}.departure`);
  const arrival = instant(o["arrival"], `${path}.arrival`);
  if (departure !== first.departure || arrival !== last.arrival) fail(`${path}.departure`, "must match the first and last legs");

  const transferCount = integer(o["transferCount"], `${path}.transferCount`, 0, MAX_LEGS - 1);
  if (transferCount !== legs.length - 1) fail(`${path}.transferCount`, "must equal the number of transfers");
  if (o["feasibility"] !== "schedule-feasible") fail(`${path}.feasibility`);
  if (typeof o["connectionConstraintsSatisfied"] !== "boolean") fail(`${path}.connectionConstraintsSatisfied`);

  return {
    source,
    destination,
    legs,
    transfers,
    transferCount,
    departure,
    arrival,
    totalDurationMinutes: integer(o["totalDurationMinutes"], `${path}.totalDurationMinutes`, 0, MAX_MINUTES),
    ridingMinutes: integer(o["ridingMinutes"], `${path}.ridingMinutes`, 0, MAX_MINUTES),
    totalWaitMinutes: integer(o["totalWaitMinutes"], `${path}.totalWaitMinutes`, 0, MAX_MINUTES),
    startDelayMinutes: integer(o["startDelayMinutes"], `${path}.startDelayMinutes`, 0, MAX_MINUTES),
    feasibility: "schedule-feasible",
    connectionConstraintsSatisfied: o["connectionConstraintsSatisfied"] as boolean,
    warnings: list(o["warnings"], `${path}.warnings`, 0, 10, warning),
    score: decimal(o["score"], `${path}.score`, 0, 10_000_000),
  };
}

/** Request body of POST /journeys/saved: `{ journey }`. Any other key (such as a user id) is ignored. */
export function parseSaveRequest(body: unknown): Journey {
  if (!isObject(body)) throw new JourneyValidationError("Expected a JSON body of the form { journey }");
  return parseJourney(body["journey"]);
}
