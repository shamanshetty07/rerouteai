// Alternative-route search over a RailData source.
//
// Algorithm: a round-based, time-dependent label search (the idea behind RAPTOR). Round k holds
// the partial journeys that use exactly k trains. Each is a "label": a station reached at an
// instant, plus the legs that got it there. To go from round k to k+1 we take every label, find
// the next run of every train stopping at its station that satisfies the transfer rules, and
// ride it to each later stop, producing new labels. Reaching the destination records a journey.
// Time is handled as epoch milliseconds built from a run's origin date plus schedule offsets, so
// midnight crossings and multi-day trains need no special cases.
//
// Why this and not Dijkstra: we want several alternatives bounded by a transfer limit, not one
// shortest path, and the transfer count is a first-class constraint. Rounds give it for free.
//
// Bounds that keep it finite on a large, cyclic network:
//  - at most `maxTransfers + 1` rounds, and the final round only looks for the destination;
//  - a journey never revisits a station or reboards a train it already used (no cycles);
//  - a label is dropped if an earlier round already reached its station no later (it could do
//    everything this one can, with more transfers left);
//  - at most `beamWidth` labels, with distinct last trains, are kept per station per round;
//  - boarding waits, the overall horizon and arrival slack behind the best journey are capped.
//
// This module knows nothing about any external API or storage; it only uses the RailData contract.

import type {
  AlternativeSearchResult,
  Journey,
  JourneyLeg,
  JourneyStation,
  JourneyTransfer,
  JourneyWarning,
  SearchWarning,
} from "./journey.ts";
import { DEFAULT_RANKING, journeySignature, rankJourneys, type RankingWeights } from "./ranking.ts";
import type { RailData } from "./repository.ts";
import { runsOnOriginDate } from "./schedule.ts";
import { addDays, isIsoDate, istDateOf, istMidnightMs, MINUTES_PER_DAY, parseClock } from "./time.ts";
import type { IsoDate, ScheduleTime, Station, Train } from "./types.ts";

const MINUTE_MS = 60_000;

export type TransferRules = {
  /** Minimum time between arriving on one train and departing on the next, in minutes. */
  defaultMinutes: number;
  /** Per-station overrides, e.g. a large interchange that needs longer. */
  byStationId?: Readonly<Record<string, number>>;
};

export type SearchOptions = {
  /** Trains changes allowed; 0 means direct only. */
  maxTransfers: number;
  transfer: TransferRules;
  /** Longest acceptable wait at a transfer station. */
  maxTransferWaitMinutes: number;
  /** How long after the earliest departure the first train may leave. */
  maxInitialWaitMinutes: number;
  /** Everything must arrive within this long of the earliest departure. */
  maxJourneyMinutes: number;
  /** Drop journeys arriving more than this long after the earliest-arriving one found. */
  maxArrivalSlackMinutes: number;
  /** Labels kept per station per round. */
  beamWidth: number;
  maxResults: number;
  ranking: RankingWeights;
};

export const MAX_SUPPORTED_TRANSFERS = 4;

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  maxTransfers: 2,
  transfer: { defaultMinutes: 30 },
  maxTransferWaitMinutes: 12 * 60,
  maxInitialWaitMinutes: 24 * 60,
  maxJourneyMinutes: 3 * MINUTES_PER_DAY,
  maxArrivalSlackMinutes: 12 * 60,
  beamWidth: 8,
  maxResults: 5,
  ranking: DEFAULT_RANKING,
};

export type RouteSearchRequest = {
  sourceId: string;
  destinationId: string;
  /** Travel date, YYYY-MM-DD (IST). */
  date: IsoDate;
  /** Earliest time the passenger can board on `date`, 24-hour HH:MM (IST). */
  earliestDeparture: string;
};

export type RouteSearchErrorCode =
  | "INVALID_STATION"
  | "SAME_STATION"
  | "INVALID_DATE"
  | "INVALID_TIME"
  | "INVALID_MAX_TRANSFERS"
  | "INVALID_OPTIONS"
  | "NO_SCHEDULE_DATA";

export class RouteSearchError extends Error {
  constructor(
    readonly code: RouteSearchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ConnectionCheck =
  | { ok: true; waitMinutes: number; requiredBufferMinutes: number }
  | { ok: false; reason: "DEPARTS_BEFORE_ARRIVAL" | "INSUFFICIENT_BUFFER" | "WAIT_TOO_LONG"; waitMinutes: number };

export function transferBufferMinutes(rules: TransferRules, stationId: string): number {
  return rules.byStationId?.[stationId] ?? rules.defaultMinutes;
}

/**
 * Whether a passenger arriving at `arriveMs` can take a train leaving the same station at
 * `departMs`. This is the one place connection rules live; the search and the tests both use it.
 * It is schedule-only: no delays and no platform or walking-distance information.
 */
export function checkConnection(
  arriveMs: number,
  departMs: number,
  stationId: string,
  options: Pick<SearchOptions, "transfer" | "maxTransferWaitMinutes">,
): ConnectionCheck {
  const waitMinutes = Math.round((departMs - arriveMs) / MINUTE_MS);
  const requiredBufferMinutes = transferBufferMinutes(options.transfer, stationId);
  if (departMs < arriveMs) return { ok: false, reason: "DEPARTS_BEFORE_ARRIVAL", waitMinutes };
  if (waitMinutes < requiredBufferMinutes) return { ok: false, reason: "INSUFFICIENT_BUFFER", waitMinutes };
  if (waitMinutes > options.maxTransferWaitMinutes) return { ok: false, reason: "WAIT_TOO_LONG", waitMinutes };
  return { ok: true, waitMinutes, requiredBufferMinutes };
}

// ---------------------------------------------------------------------------------------------
// Schedule preparation: turn a Train into minute offsets, and never guess at missing data.

type PreparedStop = {
  stationId: string;
  /** Minutes since 00:00 of the origin date, or null if absent or unparseable. */
  arrival: number | null;
  departure: number | null;
  distanceKm: number;
};

type PreparedTrain = {
  train: Train;
  stops: PreparedStop[];
  /** False when the schedule cannot be trusted at all (too short or out of chronological order). */
  usable: boolean;
  /** True when some stops lack a usable time; those stops are simply not offered as boarding/alighting. */
  incomplete: boolean;
};

function offsetOf(t: ScheduleTime | null | undefined): number | null {
  if (!t || !Number.isInteger(t.dayOffset) || t.dayOffset < 0) return null;
  const clock = parseClock(t.time);
  return clock === null ? null : t.dayOffset * MINUTES_PER_DAY + clock;
}

function prepareTrain(train: Train): PreparedTrain {
  const last = train.stops.length - 1;
  let incomplete = false;
  let usable = train.stops.length >= 2;
  let previous = -1;

  const stops = train.stops.map((stop, i): PreparedStop => {
    const arrival = i === 0 ? null : offsetOf(stop.arrival);
    const departure = i === last ? null : offsetOf(stop.departure);
    if ((i > 0 && arrival === null) || (i < last && departure === null)) incomplete = true;

    for (const time of [arrival, departure]) {
      if (time === null) continue;
      if (time < previous) usable = false; // out of order: any duration computed from it would be wrong
      previous = time;
    }
    return { stationId: stop.stationId, arrival, departure, distanceKm: stop.distanceKm };
  });
  return { train, stops, usable, incomplete };
}

/**
 * The first run of `prepared` boarding at `stop` within [notBeforeMs, notAfterMs]. runDays are
 * origin weekdays, so we walk origin dates and offset each by the stop's own departure time.
 */
function nextRun(
  prepared: PreparedTrain,
  departureOffset: number,
  notBeforeMs: number,
  notAfterMs: number,
): { originDate: IsoDate; departMs: number } | null {
  const firstDate = istDateOf(new Date(notBeforeMs - departureOffset * MINUTE_MS));
  const days = Math.ceil((notAfterMs - notBeforeMs) / (MINUTES_PER_DAY * MINUTE_MS)) + 2;
  for (let n = 0; n < days; n++) {
    const originDate = addDays(firstDate, n);
    const departMs = istMidnightMs(originDate) + departureOffset * MINUTE_MS;
    if (departMs < notBeforeMs) continue;
    if (departMs > notAfterMs) return null;
    if (runsOnOriginDate(prepared.train, originDate)) return { originDate, departMs };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Search

type RawLeg = {
  prepared: PreparedTrain;
  originDate: IsoDate;
  boardIndex: number;
  alightIndex: number;
  departMs: number;
  arriveMs: number;
};

type Label = {
  stationId: string;
  arriveMs: number;
  legs: RawLeg[];
  /** Source plus every station any leg has called at or passed through; never revisited. */
  visited: ReadonlySet<string>;
};

const legKey = (leg: RawLeg) => `${leg.prepared.train.number}@${leg.originDate}:${leg.boardIndex}`;
const labelKey = (l: Label) => l.legs.map(legKey).join("|");

function validateOptions(options: SearchOptions) {
  if (
    !Number.isInteger(options.maxTransfers) ||
    options.maxTransfers < 0 ||
    options.maxTransfers > MAX_SUPPORTED_TRANSFERS
  ) {
    throw new RouteSearchError(
      "INVALID_MAX_TRANSFERS",
      `maxTransfers must be an integer from 0 to ${MAX_SUPPORTED_TRANSFERS}`,
    );
  }
  const positive: [string, number][] = [
    ["maxTransferWaitMinutes", options.maxTransferWaitMinutes],
    ["maxInitialWaitMinutes", options.maxInitialWaitMinutes],
    ["maxJourneyMinutes", options.maxJourneyMinutes],
    ["maxArrivalSlackMinutes", options.maxArrivalSlackMinutes],
  ];
  for (const [name, value] of positive) {
    if (!Number.isFinite(value) || value < 0) throw new RouteSearchError("INVALID_OPTIONS", `${name} must be a non-negative number`);
  }
  for (const [name, value] of [["beamWidth", options.beamWidth], ["maxResults", options.maxResults]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new RouteSearchError("INVALID_OPTIONS", `${name} must be a positive integer`);
  }
  const buffers = [options.transfer.defaultMinutes, ...Object.values(options.transfer.byStationId ?? {})];
  if (buffers.some((m) => !Number.isFinite(m) || m < 0)) {
    throw new RouteSearchError("INVALID_OPTIONS", "transfer buffers must be non-negative numbers");
  }
}

const toStation = (s: Station): JourneyStation => ({ id: s.id, ...(s.code && { code: s.code }), name: s.name });

/**
 * Finds schedule-feasible journeys from source to destination, best first. Returns an empty list
 * (never an invented route) when none exist within the limits.
 */
export async function findAlternativeJourneys(
  rail: RailData,
  request: RouteSearchRequest,
  overrides: Partial<SearchOptions> = {},
): Promise<AlternativeSearchResult> {
  const options: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...overrides };
  validateOptions(options);

  if (!isIsoDate(request.date)) throw new RouteSearchError("INVALID_DATE", `Invalid date "${request.date}"; expected YYYY-MM-DD`);
  if (parseClock(request.earliestDeparture) === null) {
    throw new RouteSearchError("INVALID_TIME", `Invalid time "${request.earliestDeparture}"; expected 24-hour HH:MM`);
  }

  const [source, destination] = await Promise.all([rail.getStation(request.sourceId), rail.getStation(request.destinationId)]);
  if (!source) throw new RouteSearchError("INVALID_STATION", `Unknown station: ${request.sourceId}`);
  if (!destination) throw new RouteSearchError("INVALID_STATION", `Unknown station: ${request.destinationId}`);
  if (source.id === destination.id) throw new RouteSearchError("SAME_STATION", "Source and destination must be different stations");

  if ((await rail.listTrains()).length === 0) {
    throw new RouteSearchError("NO_SCHEDULE_DATA", "No train schedules are available");
  }

  const earliestMs = istMidnightMs(request.date) + parseClock(request.earliestDeparture)! * MINUTE_MS;
  const horizonMs = earliestMs + options.maxJourneyMinutes * MINUTE_MS;
  const maxLegs = options.maxTransfers + 1;

  // Per-search caches: trains by station, and prepared schedules by train number.
  const trainsAt = new Map<string, PreparedTrain[]>();
  const prepared = new Map<string, PreparedTrain>();
  const warned = new Map<string, SearchWarning>();

  const prepare = (train: Train): PreparedTrain => {
    let p = prepared.get(train.number);
    if (!p) {
      p = prepareTrain(train);
      prepared.set(train.number, p);
      if (!p.usable || p.incomplete) {
        warned.set(train.number, {
          code: "INCOMPLETE_SCHEDULE",
          trainNumber: train.number,
          message: p.usable
            ? `Train ${train.number} has stops with missing or invalid times; those stops were not used`
            : `Train ${train.number} has an unusable schedule and was skipped`,
        });
      }
    }
    return p;
  };

  const preparedAt = async (stationId: string): Promise<PreparedTrain[]> => {
    let list = trainsAt.get(stationId);
    if (!list) {
      list = (await rail.trainsStoppingAt(stationId)).map(prepare);
      trainsAt.set(stationId, list);
    }
    return list;
  };

  const found: { legs: RawLeg[] }[] = [];
  let bestArrivalMs = Infinity;
  /** Earliest arrival at each station over all completed rounds. */
  const reached = new Map<string, number>([[source.id, earliestMs]]);
  let frontier: Label[] = [{ stationId: source.id, arriveMs: earliestMs, legs: [], visited: new Set([source.id]) }];

  for (let round = 1; round <= maxLegs && frontier.length; round++) {
    const lastRound = round === maxLegs;
    const next: Label[] = [];

    for (const label of frontier) {
      const isFirstLeg = label.legs.length === 0;
      const used = new Set(label.legs.map((l) => l.prepared.train.number));

      for (const p of await preparedAt(label.stationId)) {
        if (!p.usable || used.has(p.train.number)) continue;
        const boardIndex = p.stops.findIndex((s) => s.stationId === label.stationId);
        const board = p.stops[boardIndex];
        if (!board || board.departure === null) continue; // cannot board without a scheduled departure

        // The earliest run of this train that passes the connection rules.
        const waitCap = isFirstLeg ? options.maxInitialWaitMinutes : options.maxTransferWaitMinutes;
        const latestMs = label.arriveMs + waitCap * MINUTE_MS;
        let run: ReturnType<typeof nextRun> = null;
        for (let from = label.arriveMs; ; ) {
          run = nextRun(p, board.departure, from, latestMs);
          if (!run) break;
          if (isFirstLeg) break; // boarding at the start is bounded only by the earliest departure
          const check = checkConnection(label.arriveMs, run.departMs, label.stationId, options);
          if (check.ok) break;
          if (check.reason === "WAIT_TOO_LONG") {
            run = null;
            break;
          }
          from = run.departMs + 1;
        }
        if (!run) continue;

        const midnight = istMidnightMs(run.originDate);
        for (let j = boardIndex + 1; j < p.stops.length; j++) {
          const stop = p.stops[j]!;
          if (stop.arrival === null) continue; // no scheduled arrival: cannot get off here
          const isDestination = stop.stationId === destination.id;
          if (lastRound && !isDestination) continue;
          if (label.visited.has(stop.stationId)) continue;

          const arriveMs = midnight + stop.arrival * MINUTE_MS;
          if (arriveMs > horizonMs || arriveMs > bestArrivalMs + options.maxArrivalSlackMinutes * MINUTE_MS) continue;

          const leg: RawLeg = { prepared: p, originDate: run.originDate, boardIndex, alightIndex: j, departMs: run.departMs, arriveMs };
          const legs = [...label.legs, leg];
          if (isDestination) {
            found.push({ legs });
            bestArrivalMs = Math.min(bestArrivalMs, arriveMs);
          } else {
            // Stations ridden through count as visited too: returning to one would be a cycle,
            // and alighting there in the first place would have been at least as good.
            const passed = p.stops.slice(boardIndex, j + 1).map((s) => s.stationId);
            next.push({ stationId: stop.stationId, arriveMs, legs, visited: new Set([...label.visited, ...passed]) });
          }
        }
      }
    }

    // Prune: nothing slower than an earlier round's arrival, then a beam of distinct last trains.
    const byStation = new Map<string, Label[]>();
    for (const l of next) {
      const earlier = reached.get(l.stationId);
      if (earlier !== undefined && earlier <= l.arriveMs) continue;
      if (l.arriveMs > bestArrivalMs + options.maxArrivalSlackMinutes * MINUTE_MS) continue;
      const list = byStation.get(l.stationId);
      if (list) list.push(l);
      else byStation.set(l.stationId, [l]);
    }

    frontier = [];
    for (const [stationId, labels] of [...byStation].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      labels.sort((a, b) => a.arriveMs - b.arriveMs || (labelKey(a) < labelKey(b) ? -1 : 1));
      const lastLegs = new Set<string>();
      const kept: Label[] = [];
      for (const l of labels) {
        const key = legKey(l.legs[l.legs.length - 1]!);
        if (lastLegs.has(key)) continue; // same ride reached by a different earlier path: equivalent
        lastLegs.add(key);
        kept.push(l);
        if (kept.length === options.beamWidth) break;
      }
      reached.set(stationId, Math.min(reached.get(stationId) ?? Infinity, kept[0]!.arriveMs));
      frontier.push(...kept);
    }
  }

  // Turn raw legs into public journeys.
  const sourceStation = toStation(source);
  const destinationStation = toStation(destination);
  const stationCache = new Map<string, JourneyStation>([[source.id, sourceStation], [destination.id, destinationStation]]);
  const stationOf = async (id: string): Promise<JourneyStation> => {
    let s = stationCache.get(id);
    if (!s) {
      const station = await rail.getStation(id);
      s = station ? toStation(station) : { id, name: id }; // a stop whose station record is missing keeps its id
      stationCache.set(id, s);
    }
    return s;
  };

  const seen = new Set<string>();
  const drafts: Omit<Journey, "score">[] = [];
  for (const { legs: rawLegs } of found) {
    if (rawLegs.some((l) => l.arriveMs > bestArrivalMs + options.maxArrivalSlackMinutes * MINUTE_MS)) continue;
    const journey = await buildJourney(rawLegs);
    const signature = journeySignature(journey);
    if (seen.has(signature)) continue;
    seen.add(signature);
    drafts.push(journey);
  }

  async function buildJourney(rawLegs: RawLeg[]): Promise<Omit<Journey, "score">> {
    const legs: JourneyLeg[] = [];
    for (const raw of rawLegs) {
      const from = raw.prepared.stops[raw.boardIndex]!;
      const to = raw.prepared.stops[raw.alightIndex]!;
      legs.push({
        trainNumber: raw.prepared.train.number,
        trainName: raw.prepared.train.name,
        trainType: raw.prepared.train.type,
        originDate: raw.originDate,
        from: await stationOf(from.stationId),
        to: await stationOf(to.stationId),
        departure: new Date(raw.departMs).toISOString(),
        arrival: new Date(raw.arriveMs).toISOString(),
        durationMinutes: Math.round((raw.arriveMs - raw.departMs) / MINUTE_MS),
        distanceKm: Math.round((to.distanceKm - from.distanceKm) * 10) / 10,
      });
    }

    const transfers: JourneyTransfer[] = [];
    let allValid = true;
    for (let i = 1; i < rawLegs.length; i++) {
      const [incoming, outgoing] = [rawLegs[i - 1]!, rawLegs[i]!];
      const stationId = legs[i]!.from.id;
      const check = checkConnection(incoming.arriveMs, outgoing.departMs, stationId, options);
      allValid &&= check.ok;
      transfers.push({
        station: legs[i]!.from,
        arrival: legs[i - 1]!.arrival,
        departure: legs[i]!.departure,
        waitMinutes: check.waitMinutes,
        requiredBufferMinutes: transferBufferMinutes(options.transfer, stationId),
      });
    }

    const [first, last] = [rawLegs[0]!, rawLegs[rawLegs.length - 1]!];
    const warnings: JourneyWarning[] = [
      { code: "NO_REAL_TIME_DATA", message: "Based on published schedules; live delays are not considered" },
    ];
    if (transfers.length) {
      warnings.push({ code: "PLATFORM_CHANGE_UNVERIFIED", message: "Platform and walking time between trains at transfers are not verified" });
    }
    for (const raw of rawLegs) {
      if (raw.prepared.incomplete) {
        warnings.push({
          code: "INCOMPLETE_TRAIN_SCHEDULE",
          message: `Train ${raw.prepared.train.number} has incomplete schedule data; the times used for this journey are present`,
        });
      }
    }

    return {
      source: sourceStation,
      destination: destinationStation,
      legs,
      transfers,
      transferCount: transfers.length,
      departure: legs[0]!.departure,
      arrival: legs[legs.length - 1]!.arrival,
      totalDurationMinutes: Math.round((last.arriveMs - first.departMs) / MINUTE_MS),
      ridingMinutes: legs.reduce((sum, l) => sum + l.durationMinutes, 0),
      totalWaitMinutes: transfers.reduce((sum, t) => sum + t.waitMinutes, 0),
      startDelayMinutes: Math.round((first.departMs - earliestMs) / MINUTE_MS),
      feasibility: "schedule-feasible",
      connectionConstraintsSatisfied: allValid,
      warnings,
    };
  }

  // Redundancy filter: drop a journey if another leaves no earlier, arrives no later and changes
  // no more often (and is not simply identical in those terms, which signature dedupe handled).
  const useful = drafts.filter(
    (a) =>
      !drafts.some(
        (b) =>
          b !== a &&
          b.transferCount <= a.transferCount &&
          Date.parse(b.arrival) <= Date.parse(a.arrival) &&
          Date.parse(b.departure) >= Date.parse(a.departure) &&
          (b.transferCount < a.transferCount ||
            Date.parse(b.arrival) < Date.parse(a.arrival) ||
            Date.parse(b.departure) > Date.parse(a.departure)),
      ),
  );

  return {
    journeys: rankJourneys(useful, options.ranking).slice(0, options.maxResults),
    warnings: [...warned.values()].sort((a, b) => (a.trainNumber < b.trainNumber ? -1 : 1)),
  };
}
