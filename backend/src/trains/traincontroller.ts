import { Router, type Response } from "express";
import { requireAuth } from "../auth/middleware.ts";
import { RailRadarError, trainsBetween, type TrainsBetweenParams } from "./railradar.ts";
import { isStation, searchStations } from "./stations.ts";

const router = Router();

const STATION_CODE = /^[A-Z0-9]{1,5}$/;
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

function sendError(res: Response, err: unknown) {
  if (err instanceof ValidationError) res.status(400).json({ error: err.message });
  else if (err instanceof RailRadarError) res.status(err.status).json({ error: err.message });
  else {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/** GET /stations/search?q=new+del[&limit=8] -> [{ code, name }] */
router.get("/stations/search", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query["limit"]) || 8, 1), 20);
    res.json(await searchStations(text(req.query["q"]) ?? "", limit));
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /trains/search?from=NDLS&to=AGC&date=2026-10-25[&type=&category=&byCity=&live=] */
router.get("/trains/search", requireAuth, async (req, res) => {
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

export default router;
