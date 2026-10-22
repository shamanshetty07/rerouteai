import { Router, type RequestHandler, type Response } from "express";
import { requireAuth } from "../auth/middleware.ts";
import { mockRailData } from "../rail/mockTrains.ts";
import type { RailData } from "../rail/repository.ts";
import { findAlternativeJourneys, RouteSearchError, type SearchOptions } from "../rail/routeSearch.ts";
import { RailRadarError, trainsBetween, type TrainsBetweenParams } from "./railradar.ts";
import { isStation, searchStations } from "./stations.ts";
import { rateLimit } from "../server/security.ts";

const router = Router();

const STATION_CODE = /^[A-Z0-9]{1,5}$/;
const FILTER = /^[A-Za-z0-9 _-]{1,32}$/;
const MAX_QUERY_LENGTH = 100;

// Per signed-in user. /trains/search spends RailRadar quota, so it gets the tightest budget.
const perUser = (max: number) => rateLimit({ windowMs: 60_000, max, key: (req) => `user:${req.user?.id}` });
const stationsLimit = perUser(120);
const searchLimit = perUser(30);
const alternativesLimit = perUser(60);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class ValidationError extends Error {}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function flag(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ValidationError(`${name} must be "true" or "false"`);
}

function parseSearch(query: Record<string, unknown>): TrainsBetweenParams {
  const from = text(query["from"])?.toUpperCase();
  const to = text(query["to"])?.toUpperCase();
  if (!from || !to || !STATION_CODE.test(from) || !STATION_CODE.test(to)) {
    throw new ValidationError("from and to are required station codes, e.g. NDLS");
  }
  if (from === to) throw new ValidationError("from and to must be different stations");

  const date = text(query["date"]);
  if (date && (!DATE.test(date) || Number.isNaN(Date.parse(date)))) {
    throw new ValidationError("date must be a valid YYYY-MM-DD");
  }

  // Free-text filters go to RailRadar and into the cache key, so keep them short and plain.
  for (const name of ["type", "category"] as const) {
    const v = text(query[name]);
    if (v !== undefined && !FILTER.test(v)) throw new ValidationError(`${name} may only contain letters, digits, spaces, "_" and "-" (max 32)`);
  }

  return {
    from,
    to,
    ...(date && { date }),
    ...(text(query["type"]) && { type: text(query["type"])! }),
    ...(text(query["category"]) && { category: text(query["category"])! }),
    ...(query["byCity"] !== undefined && { byCity: flag(query["byCity"], "byCity")! }),
    ...(query["live"] !== undefined && { live: flag(query["live"], "live")! }),
  };
}

/** Optional integer query value; range checks stay with the route search. */
function integer(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new ValidationError(`${name} must be an integer`);
  return Number(value);
}

function sendError(res: Response, err: unknown) {
  if (err instanceof ValidationError) res.status(400).json({ error: err.message });
  // Missing timetable data is our problem, not a malformed request.
  else if (err instanceof RouteSearchError) res.status(err.code === "NO_SCHEDULE_DATA" ? 503 : 400).json({ error: err.message, code: err.code });
  else if (err instanceof RailRadarError) res.status(err.status).json({ error: err.message });
  else {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/** GET /stations/search?q=new+del[&limit=8] -> [{ code, name }] */
router.get("/stations/search", requireAuth, stationsLimit, async (req, res) => {
  try {
    const q = text(req.query["q"]) ?? "";
    if (q.length > MAX_QUERY_LENGTH) throw new ValidationError("q is too long");
    const limit = Math.min(Math.max(Number(req.query["limit"]) || 8, 1), 20);
    res.json(await searchStations(q, limit));
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /trains/search?from=NDLS&to=AGC&date=2026-10-25[&type=&category=&byCity=&live=] */
router.get("/trains/search", requireAuth, searchLimit, async (req, res) => {
  try {
    const params = parseSearch(req.query);
    for (const code of [params.from, params.to]) {
      if (!(await isStation(code))) throw new ValidationError(`Unknown station: ${code}`);
    }
    res.json(await trainsBetween(params));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /trains/alternatives?from=SBC&to=HYB&date=2026-10-25&time=18:30[&maxTransfers=2]
 * -> { journeys, warnings }: schedule-feasible multi-train journeys, best first.
 *
 * Separate from /trains/search, which proxies RailRadar's direct-train lookup and has its own
 * response shape. Stations are the rail repository's ids (station codes), not RailRadar's directory.
 */
export function alternativesHandler(rail: RailData): RequestHandler {
  return async (req, res) => {
    try {
      const from = text(req.query["from"])?.toUpperCase();
      const to = text(req.query["to"])?.toUpperCase();
      const date = text(req.query["date"]);
      const time = text(req.query["time"]);
      if (!from || !to) throw new ValidationError("from and to are required station codes, e.g. SBC");
      if (!date || !time) throw new ValidationError("date (YYYY-MM-DD) and time (HH:MM) are required");

      const maxTransfers = integer(req.query["maxTransfers"], "maxTransfers");
      const options: Partial<SearchOptions> = maxTransfers === undefined ? {} : { maxTransfers };
      res.json(
        await findAlternativeJourneys(
          rail,
          { sourceId: from, destinationId: to, date, earliestDeparture: time },
          options,
        ),
      );
    } catch (err) {
      sendError(res, err);
    }
  };
}

router.get("/trains/alternatives", requireAuth, alternativesLimit, alternativesHandler(mockRailData));

export default router;
