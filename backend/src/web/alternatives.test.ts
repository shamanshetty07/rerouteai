import { afterEach, describe, expect, test } from "bun:test";
import { mockRailData } from "../rail/mockTrains.ts";
import { findAlternativeJourneys } from "../rail/routeSearch.ts";
import { alternativesUrl, fetchAlternatives, formatInstant, renderJourneys } from "./alternatives.ts";
import { mockStationSource } from "./stations/stationSource.ts";

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const query = { from: "HWH", to: "AGC", date: "2026-10-20", time: "16:00" };

afterEach(() => document.body.replaceChildren());

describe("alternativesUrl", () => {
  test("encodes every parameter and omits maxTransfers when unset", () => {
    expect(alternativesUrl(query)).toBe("/trains/alternatives?from=HWH&to=AGC&date=2026-10-20&time=16%3A00");
    expect(alternativesUrl({ ...query, maxTransfers: 0 })).toContain("&maxTransfers=0");
  });
});

describe("fetchAlternatives", () => {
  test("returns the parsed result on 200", async () => {
    const out = await fetchAlternatives(query, reply(200, { journeys: [], warnings: [] }));
    expect(out).toEqual({ kind: "ok", result: { journeys: [], warnings: [] } });
  });

  test("maps 400 to the server's message", async () => {
    const out = await fetchAlternatives(query, reply(400, { error: "Invalid time" }));
    expect(out).toEqual({ kind: "invalid", message: "Invalid time" });
  });

  test("maps 401 to unauthorized", async () => {
    expect(await fetchAlternatives(query, reply(401, { error: "Not signed in" }))).toEqual({ kind: "unauthorized" });
  });

  test("maps 503 to unavailable", async () => {
    const out = await fetchAlternatives(query, reply(503, { error: "No schedule data", code: "NO_SCHEDULE_DATA" }));
    expect(out).toEqual({ kind: "unavailable", message: "No schedule data" });
  });

  test("turns network failures and unparseable errors into safe messages", async () => {
    const down = (async () => {
      throw new Error("boom");
    });
    expect((await fetchAlternatives(query, down)).kind).toBe("error");
    const html = (async () => new Response("<html>", { status: 500 }));
    expect(await fetchAlternatives(query, html)).toEqual({ kind: "error", message: "Search failed." });
  });
});

describe("renderJourneys", () => {
  test("renders legs, transfer wait and warnings in the order returned", async () => {
    const result = await findAlternativeJourneys(mockRailData, {
      sourceId: "HWH",
      destinationId: "AGC",
      date: "2026-10-20",
      earliestDeparture: "16:00",
    });
    const container = document.createElement("div");
    renderJourneys(container, result);

    const cards = container.querySelectorAll("article.journey");
    expect(cards).toHaveLength(result.journeys.length);
    const card = cards[0]!;
    expect(card.textContent).toContain("12301 Howrah - New Delhi Rajdhani Express");
    expect(card.textContent).toContain("12622 Tamil Nadu Express");
    expect(card.textContent).toContain("1 transfer");
    expect(card.querySelector(".transfer")!.textContent).toBe("Change at New Delhi · wait 11h 00m");
    expect(card.textContent).toContain("16:50"); // 11:20Z shown in IST
    expect(card.querySelectorAll(".journey-warnings li").length).toBeGreaterThan(0);
  });

  test("shows search-level warnings and uses text, not HTML", () => {
    const container = document.createElement("div");
    renderJourneys(container, {
      journeys: [],
      warnings: [{ code: "INCOMPLETE_SCHEDULE", trainNumber: "1", message: "<b>x</b>" }],
    });
    expect(container.querySelector(".search-warnings li")!.textContent).toBe("<b>x</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  test("formats instants in IST", () => {
    expect(formatInstant("2026-10-20T11:20:00.000Z")).toContain("16:50");
  });
});

describe("station compatibility", () => {
  test("every station the form can offer is known to the alternatives repository", async () => {
    const known = new Set((await mockRailData.listStations()).map((s) => s.id));
    expect(known.size).toBeGreaterThan(0);
    for (const id of known) {
      const offered = await mockStationSource.search(id);
      expect(offered.length).toBeGreaterThan(0);
      for (const s of offered) expect(known.has(s.code ?? s.id)).toBe(true);
    }
  });
});
