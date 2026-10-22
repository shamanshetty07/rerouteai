import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { get as httpGet, type Server } from "node:http";
import { requireAuth } from "../auth/middleware.ts";
import { createSessionToken } from "../auth/session.ts";
import { userStore } from "../auth/userstore.ts";
import { mockRailData } from "../rail/mockTrains.ts";
import { alternativesHandler } from "./traincontroller.ts";

let server: Server;
let base: string;
let token: string;

beforeAll(async () => {
  process.env["SESSION_SECRET"] ??= "test-secret";
  const user = await userStore.create({ email: "t@example.com", name: "T", provider: "github", providerId: "alt-test" });
  token = createSessionToken(user.id);

  const app = express();
  app.get("/trains/alternatives", requireAuth, alternativesHandler(mockRailData));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
});

// node:http rather than fetch: the test preload installs happy-dom's browser-style fetch.
type Reply = { status: number; json: () => Promise<unknown> };
const get = (query: string, authed = true) =>
  new Promise<Reply>((resolve, reject) => {
    const headers = authed ? { Authorization: `Bearer ${token}` } : {};
    httpGet(`${base}/trains/alternatives?${query}`, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(body) }));
    }).on("error", reject);
  });

describe("GET /trains/alternatives", () => {
  test("requires a signed-in user", async () => {
    expect((await get("from=HWH&to=AGC&date=2026-10-20&time=16:00", false)).status).toBe(401);
  });

  test("returns ranked journeys with warnings for a valid search", async () => {
    const res = await get("from=hwh&to=AGC&date=2026-10-20&time=16:00");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { journeys: { legs: { trainNumber: string }[]; transferCount: number }[]; warnings: unknown[] };
    expect(body.journeys.map((j) => j.legs.map((l) => l.trainNumber))).toEqual([["12301", "12622"]]);
    expect(body.journeys[0]!.transferCount).toBe(1);
    expect(body.warnings).toEqual([]);
  });

  test("honours maxTransfers", async () => {
    const res = await get("from=HWH&to=AGC&date=2026-10-20&time=16:00&maxTransfers=0");
    expect(await res.json()).toEqual({ journeys: [], warnings: [] });
  });

  test("returns an empty list when nothing is feasible", async () => {
    const res = await get("from=TVC&to=NDLS&date=2026-10-20&time=16:00");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ journeys: [], warnings: [] });
  });

  test.each([
    ["from=NDLS&date=2026-10-20&time=16:00", "from and to are required"],
    ["from=NDLS&to=AGC&time=16:00", "date"],
    ["from=NDLS&to=NDLS&date=2026-10-20&time=16:00", "different stations"],
    ["from=NOPE&to=AGC&date=2026-10-20&time=16:00", "Unknown station: NOPE"],
    ["from=NDLS&to=AGC&date=2026-02-30&time=16:00", "Invalid date"],
    ["from=NDLS&to=AGC&date=2026-10-20&time=25:00", "Invalid time"],
    ["from=NDLS&to=AGC&date=2026-10-20&time=16:00&maxTransfers=9", "maxTransfers"],
    ["from=NDLS&to=AGC&date=2026-10-20&time=16:00&maxTransfers=two", "maxTransfers must be an integer"],
  ])("rejects %s with a 400", async (query, message) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(message);
  });
});
