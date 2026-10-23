import { describe, expect, test } from "bun:test";
import { alternativesUrl, deleteSavedJourney, fetchAlternatives } from "./api";
import { mockStations } from "./mockStations";
import { searchStations } from "./searchStations";

const reply = (status: number, body?: unknown) => async () => new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("fetchAlternatives", () => {
  const q = { from: "MMCT", to: "NDLS", date: "2026-10-25", time: "08:00" };

  test("builds the query string, adding maxTransfers only when given", () => {
    expect(alternativesUrl(q)).toBe("/trains/alternatives?from=MMCT&to=NDLS&date=2026-10-25&time=08%3A00");
    expect(alternativesUrl({ ...q, maxTransfers: 1 })).toContain("maxTransfers=1");
  });

  test("maps HTTP statuses to outcomes without throwing", async () => {
    expect(await fetchAlternatives(q, reply(401))).toEqual({ kind: "unauthorized" });
    expect(await fetchAlternatives(q, reply(400, { error: "Bad date" }))).toEqual({ kind: "invalid", message: "Bad date" });
    expect((await fetchAlternatives(q, reply(503))).kind).toBe("unavailable");
    expect((await fetchAlternatives(q, reply(200, { journeys: [], warnings: [] }))).kind).toBe("ok");
    expect((await fetchAlternatives(q, async () => Promise.reject(new Error("offline")))).kind).toBe("error");
  });
});

describe("deleteSavedJourney", () => {
  test("treats 404 as already deleted", async () => {
    expect(await deleteSavedJourney("x", reply(404))).toEqual({ kind: "deleted" });
    expect(await deleteSavedJourney("x", reply(204))).toEqual({ kind: "deleted" });
    expect((await deleteSavedJourney("x", reply(401))).kind).toBe("unauthorized");
  });
});

describe("searchStations", () => {
  const names = (query: string) => searchStations(mockStations, query).map((s) => s.name);
  test("matches by code first, then name, case-insensitively", () => {
    expect(names("sbc")[0]).toBe("KSR Bengaluru City Junction");
    expect(names("NEW DELHI")).toContain("New Delhi");
  });
  test("empty query matches nothing", () => {
    expect(names("  ")).toEqual([]);
  });
});
