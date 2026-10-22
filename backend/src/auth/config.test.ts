import { describe, expect, test } from "bun:test";
import { assertAuthConfig } from "./config.ts";
import { safeNextPath } from "./redirect.ts";

const good = { NODE_ENV: "production", SESSION_SECRET: "x".repeat(40), BASE_URL: "https://reroute.example.com" };

describe("assertAuthConfig", () => {
  test("accepts a complete production configuration", () => {
    expect(() => assertAuthConfig(good)).not.toThrow();
  });

  test.each([
    ["missing secret", { SESSION_SECRET: undefined }],
    ["empty secret", { SESSION_SECRET: "" }],
    ["short secret", { SESSION_SECRET: "short" }],
    ["placeholder secret", { SESSION_SECRET: "change-me" }],
    ["missing BASE_URL", { BASE_URL: undefined }],
    ["http BASE_URL", { BASE_URL: "http://reroute.example.com" }],
    ["differently cased NODE_ENV", { NODE_ENV: " Production ", SESSION_SECRET: undefined }],
  ])("production refuses to start with a %s", (_name, override) => {
    expect(() => assertAuthConfig({ ...good, ...override })).toThrow("Refusing to start");
  });

  test("development is not restricted", () => {
    expect(() => assertAuthConfig({})).not.toThrow();
    expect(() => assertAuthConfig({ NODE_ENV: "development", SESSION_SECRET: "abc" })).not.toThrow();
  });
});

describe("safeNextPath", () => {
  test("keeps same-site paths", () => {
    for (const p of ["/search", "/profile", "/a/b?x=1#y"]) expect(safeNextPath(p)).toBe(p);
  });

  test("falls back for anything that could leave the site", () => {
    for (const p of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "", "/ x", "/\nfoo", undefined, 5, ["/a"]]) {
      expect(safeNextPath(p)).toBe("/search");
    }
    expect(safeNextPath("//x", "/home")).toBe("/home");
  });
});
