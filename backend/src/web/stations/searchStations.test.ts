import { describe, expect, test } from "bun:test";
import { mockStations } from "./mockStations.ts";
import { searchStations } from "./searchStations.ts";

const names = (query: string, limit?: number) => searchStations(mockStations, query, limit).map((s) => s.name);

describe("searchStations", () => {
  test("matches partial station names", () => {
    expect(names("nizam")).toEqual(["Hazrat Nizamuddin"]);
    expect(names("shivaji")).toContain("Chhatrapati Shivaji Maharaj Terminus");
  });

  test("is case-insensitive", () => {
    expect(names("NEW DELHI")).toEqual(names("new delhi"));
    expect(names("nEw DeLhI")).toContain("New Delhi");
  });

  test("matches by station code, exact code first", () => {
    expect(names("sbc")[0]).toBe("KSR Bengaluru City Junction");
    expect(names("MAS")[0]).toBe("Chennai Central");
    expect(names("ndl")).toContain("New Delhi");
  });

  test("matches by city", () => {
    const hyderabad = searchStations(mockStations, "hyderabad");
    expect(hyderabad.map((s) => s.code).sort()).toEqual(["HYB", "KCG", "SC"]);
    expect(names("bengaluru")).toHaveLength(5);
  });

  test("returns nothing when no station matches", () => {
    expect(names("zzzzqq")).toEqual([]);
  });

  test("returns nothing for an empty or whitespace query instead of the whole dataset", () => {
    expect(names("")).toEqual([]);
    expect(names("   ")).toEqual([]);
  });

  test("caps the number of suggestions", () => {
    expect(names("a", 5)).toHaveLength(5);
    expect(names("a").length).toBeLessThanOrEqual(8);
  });
});

describe("mock station data", () => {
  test("ids and codes are unique and well formed", () => {
    const ids = mockStations.map((s) => s.id);
    const codes = mockStations.map((s) => s.code);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(codes).size).toBe(codes.length);
    for (const s of mockStations) {
      expect(s.code).toMatch(/^[A-Z]{1,5}$/);
      expect(s.name.trim()).not.toBe("");
      expect(s.city.trim()).not.toBe("");
    }
  });

  test("covers the major cities", () => {
    const cities = new Set(mockStations.map((s) => s.city));
    for (const city of ["Delhi", "Mumbai", "Bengaluru", "Chennai", "Hyderabad", "Kolkata"]) {
      expect(cities.has(city)).toBe(true);
    }
  });
});
