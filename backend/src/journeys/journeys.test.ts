import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { randomBytes } from "node:crypto";
import { send, serve } from "../../test/http.ts";
import { migrateUsersTable } from "../auth/postgresuserstore.ts";
import { SESSION_COOKIE, createSessionToken } from "../auth/session.ts";
import { userStore } from "../auth/userstore.ts";
import type { Journey } from "../rail/journey.ts";
import { mockRailData } from "../rail/mockTrains.ts";
import { findAlternativeJourneys } from "../rail/routeSearch.ts";
import { errorHandler } from "../server/security.ts";
import { createApp } from "../server/app.ts";
import { createJourneysRouter } from "./controller.ts";
import { migrateSavedJourneysTable, createPostgresSavedJourneyStore } from "./postgresstore.ts";
import { createMemorySavedJourneyStore, journeyKey, type SavedJourneyStore } from "./store.ts";
import { MAX_SAVED_PER_USER } from "./types.ts";
import { JourneyValidationError, parseJourney, parseSaveRequest } from "./validate.ts";

const SECRET = "journeys-test-secret-0123456789abcdef";
const ENV = { SESSION_SECRET: SECRET, BASE_URL: "http://localhost:8000" };

// A genuine route-search result: HWH -> NDLS -> AGC, one transfer, overnight.
let real: Journey;
let other: Journey; // a different trip

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

beforeAll(async () => {
  const search = async (sourceId: string, destinationId: string, earliestDeparture = "16:00") =>
    (await findAlternativeJourneys(mockRailData, { sourceId, destinationId, date: "2026-10-20", earliestDeparture })).journeys[0]!;
  real = await search("HWH", "AGC");
  other = await search("SBC", "HYB", "00:00").catch(() => undefined as never);
  if (!other) other = await search("HWH", "NDLS");
});

// --- validation ---------------------------------------------------------------------------------

describe("journey validation", () => {
  const bad = (mutate: (j: any) => void, message: string | RegExp) => {
    const j = clone(real) as any;
    mutate(j);
    expect(() => parseJourney(j)).toThrow(JourneyValidationError);
    expect(() => parseJourney(j)).toThrow(message);
  };

  test("accepts a real route-search journey unchanged", () => {
    expect(parseJourney(clone(real))).toEqual(real);
  });

  test("keeps only known fields (extras such as userId are dropped)", () => {
    const j = clone(real) as any;
    j.userId = 7;
    j.legs[0].secret = "x";
    j.source.extra = 1;
    const parsed = parseJourney(j) as any;
    expect(parsed.userId).toBeUndefined();
    expect(parsed.legs[0].secret).toBeUndefined();
    expect(parsed.source.extra).toBeUndefined();
  });

  test("rejects non-objects and bad containers", () => {
    for (const input of [null, undefined, 5, "x", [], [real]]) expect(() => parseJourney(input)).toThrow(JourneyValidationError);
    expect(() => parseSaveRequest(undefined)).toThrow("Expected a JSON body");
    expect(() => parseSaveRequest({})).toThrow("journey must be an object");
    expect(() => parseSaveRequest([real])).toThrow("Expected a JSON body");
  });

  test("rejects bad strings, alphabets and control characters, without echoing them", () => {
    bad((j) => (j.legs[0].trainNumber = "12 301"), "journey.legs[0].trainNumber is invalid");
    bad((j) => (j.legs[0].trainNumber = "x".repeat(11)), /trainNumber/);
    bad((j) => (j.legs[0].trainName = "A\nB"), /trainName/);
    bad((j) => (j.legs[0].trainName = "x".repeat(101)), /trainName/);
    bad((j) => (j.source.id = "<script>"), /source\.id/);
    bad((j) => (j.source.name = ""), /source\.name/);
    bad((j) => (j.legs[0].trainType = "teleporter"), /trainType/);
    bad((j) => (j.legs[0].trainNumber = 12301), /trainNumber/);
    try {
      const j = clone(real) as any;
      j.legs[0].trainName = "A\u0000secret-value";
      parseJourney(j);
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-value");
    }
  });

  test("rejects bad numbers, dates and instants", () => {
    bad((j) => (j.legs[0].durationMinutes = -1), /durationMinutes/);
    bad((j) => (j.legs[0].durationMinutes = 1.5), /durationMinutes/);
    bad((j) => (j.legs[0].durationMinutes = 1e9), /durationMinutes/);
    bad((j) => (j.legs[0].distanceKm = "far"), /distanceKm/);
    bad((j) => (j.score = Number.NaN), /score/);
    bad((j) => (j.legs[0].originDate = "2026-02-30"), /originDate/);
    bad((j) => (j.legs[0].originDate = "20/10/2026"), /originDate/);
    bad((j) => (j.departure = "yesterday"), /departure/);
    bad((j) => (j.legs[0].arrival = j.legs[0].departure), /after the departure/);
    bad((j) => (j.totalDurationMinutes = 999_999), /totalDurationMinutes/);
  });

  test("rejects journeys that do not hang together", () => {
    bad((j) => (j.legs[1].from.id = "XXX"), /does not connect/);
    bad((j) => (j.transfers[0].station.id = "XXX"), /does not connect/);
    bad((j) => (j.legs[1].departure = j.legs[0].departure), /before the previous leg/);
    bad((j) => (j.source.id = "ZZZ"), /where the first leg starts/);
    bad((j) => (j.destination.id = "ZZZ"), /where the last leg ends/);
    bad((j) => (j.destination.id = j.source.id), /./);
    bad((j) => (j.transferCount = 0), /transferCount/);
    bad((j) => (j.transfers = []), /transfers must have 1 items/);
    bad((j) => (j.legs = []), /legs must have/);
    bad((j) => (j.legs = Array(6).fill(j.legs[0])), /legs must have/);
    bad((j) => (j.departure = j.arrival), /must match the first and last legs/);
    bad((j) => (j.feasibility = "guaranteed"), /feasibility/);
    bad((j) => (j.warnings = Array(11).fill(j.warnings[0])), /warnings/);
    bad((j) => (j.warnings = [{ code: "EVIL", message: "x" }]), /warnings\[0\]\.code/);
  });

  test("the largest legitimate journey fits well inside the request-size limit", () => {
    const j = clone(real) as any;
    const leg = j.legs[0];
    const transfer = j.transfers[0];
    // Five legs would need four transfers; build a chain by hand to measure worst-case size.
    const t0 = Date.parse(leg.departure);
    const chain = Array.from({ length: 5 }, (_, i) => ({
      ...leg,
      trainName: "N".repeat(100),
      from: { id: `S${i}`, code: `S${i}`, name: "N".repeat(100) },
      to: { id: `S${i + 1}`, code: `S${i + 1}`, name: "N".repeat(100) },
      departure: new Date(t0 + i * 7_200_000).toISOString(),
      arrival: new Date(t0 + i * 7_200_000 + 3_600_000).toISOString(),
    }));
    j.legs = chain;
    j.transfers = chain.slice(0, 4).map((c, i) => ({ ...transfer, station: c.to, arrival: c.arrival, departure: chain[i + 1]!.departure }));
    j.source = chain[0]!.from;
    j.destination = chain[4]!.to;
    j.departure = chain[0]!.departure;
    j.arrival = chain[4]!.arrival;
    j.transferCount = 4;
    j.warnings = Array(10).fill({ code: "NO_REAL_TIME_DATA", message: "m".repeat(200) });
    expect(() => parseJourney(j)).not.toThrow();
    expect(JSON.stringify({ journey: j }).length).toBeLessThan(10_000); // the app-wide body limit
  });
});

// --- API through the real app --------------------------------------------------------------------

let n = 0;
async function newUser() {
  const user = await userStore.create({ email: `j${++n}@example.com`, name: "J", provider: "github", providerId: `jrn-${Date.now()}-${n}` });
  return { user, cookie: `${SESSION_COOKIE}=${createSessionToken(user.id, user.sessionVersion)}` };
}

describe("saved-journeys API", () => {
  let base: string;
  let close: () => void;
  let savedSecret: string | undefined;

  beforeAll(async () => {
    savedSecret = process.env["SESSION_SECRET"];
    process.env["SESSION_SECRET"] = SECRET;
    ({ base, close } = await serve(createApp(ENV)));
  });
  afterAll(() => {
    close();
    if (savedSecret === undefined) delete process.env["SESSION_SECRET"];
    else process.env["SESSION_SECRET"] = savedSecret;
  });

  const call = (cookie: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(base, path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== "GET" ? { Origin: base } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const json = (r: { body: string }) => JSON.parse(r.body);

  test("saves a valid journey for the signed-in user and returns it", async () => {
    const { cookie } = await newUser();
    const r = await call(cookie, "POST", "/journeys/saved", { journey: real });
    expect(r.status).toBe(201);
    const { journey } = json(r);
    expect(journey).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      savedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      source: real.source,
      destination: real.destination,
      travelDate: "2026-10-20",
      journey: real,
    });
  });

  test("saving the same journey again is idempotent (200, same id, one list entry)", async () => {
    const { cookie } = await newUser();
    const first = json(await call(cookie, "POST", "/journeys/saved", { journey: real })).journey;
    const again = await call(cookie, "POST", "/journeys/saved", { journey: real });
    expect(again.status).toBe(200);
    expect(json(again).journey.id).toBe(first.id);
    expect(json(await call(cookie, "GET", "/journeys/saved")).journeys).toHaveLength(1);
  });

  test("lists only the caller's journeys, newest first", async () => {
    const a = await newUser();
    const b = await newUser();
    const saved1 = json(await call(a.cookie, "POST", "/journeys/saved", { journey: real })).journey;
    await new Promise((r) => setTimeout(r, 5));
    const saved2 = json(await call(a.cookie, "POST", "/journeys/saved", { journey: other })).journey;
    await call(b.cookie, "POST", "/journeys/saved", { journey: real });

    const listA = json(await call(a.cookie, "GET", "/journeys/saved")).journeys;
    expect(listA.map((s: { id: string }) => s.id)).toEqual([saved2.id, saved1.id]);
    const listB = json(await call(b.cookie, "GET", "/journeys/saved")).journeys;
    expect(listB).toHaveLength(1);
    expect(listB[0].id).not.toBe(saved1.id);
    expect(json(await call((await newUser()).cookie, "GET", "/journeys/saved")).journeys).toEqual([]);
  });

  test("deletes a saved journey, which then disappears from the list", async () => {
    const { cookie } = await newUser();
    const { journey } = json(await call(cookie, "POST", "/journeys/saved", { journey: real }));
    const del = await call(cookie, "DELETE", `/journeys/saved/${journey.id}`);
    expect(del.status).toBe(204);
    expect(del.body).toBe("");
    expect(json(await call(cookie, "GET", "/journeys/saved")).journeys).toEqual([]);
    expect((await call(cookie, "DELETE", `/journeys/saved/${journey.id}`)).status).toBe(404); // already gone
  });

  test("another user can neither delete nor see a journey, and gets the same 404 as for a missing id", async () => {
    const owner = await newUser();
    const intruder = await newUser();
    const { journey } = json(await call(owner.cookie, "POST", "/journeys/saved", { journey: real }));

    const attempt = await call(intruder.cookie, "DELETE", `/journeys/saved/${journey.id}`);
    const missing = await call(intruder.cookie, "DELETE", "/journeys/saved/00000000-0000-4000-8000-000000000000");
    expect(attempt.status).toBe(404);
    expect(attempt.body).toBe(missing.body);
    expect(json(await call(owner.cookie, "GET", "/journeys/saved")).journeys).toHaveLength(1); // still there
    expect(json(await call(intruder.cookie, "GET", "/journeys/saved")).journeys).toEqual([]);
  });

  test("the owner comes from the session only: a user id in the body, query or headers changes nothing", async () => {
    const victim = await newUser();
    const attacker = await newUser();
    const r = await call(
      attacker.cookie,
      "POST",
      `/journeys/saved?userId=${victim.user.id}&user_id=${victim.user.id}`,
      { journey: real, userId: victim.user.id, user_id: victim.user.id, owner: victim.user.id },
      { "X-User-Id": String(victim.user.id) },
    );
    expect(r.status).toBe(201);
    expect(json(await call(victim.cookie, "GET", `/journeys/saved?userId=${attacker.user.id}`)).journeys).toEqual([]);
    expect(json(await call(attacker.cookie, "GET", "/journeys/saved")).journeys).toHaveLength(1);
  });

  test("requires authentication on every route", async () => {
    const { cookie } = await newUser();
    const { journey } = json(await call(cookie, "POST", "/journeys/saved", { journey: real }));
    for (const [method, path, body] of [
      ["POST", "/journeys/saved", { journey: real }],
      ["GET", "/journeys/saved", undefined],
      ["DELETE", `/journeys/saved/${journey.id}`, undefined],
    ] as const) {
      expect((await call(undefined, method, path, body)).status).toBe(401);
      expect((await call(`${SESSION_COOKIE}=forged.token.value`, method, path, body)).status).toBe(401);
    }
    expect(json(await call(cookie, "GET", "/journeys/saved")).journeys).toHaveLength(1); // untouched
  });

  test("rejects invalid payloads with 400 and a message that does not echo the input", async () => {
    const { cookie } = await newUser();
    const mutated = clone(real) as any;
    mutated.legs[0].trainNumber = "<img src=x onerror=alert(1)>";
    for (const body of [{}, { journey: null }, { journey: "x" }, { journey: [] }, { journey: mutated }, { journey: { ...clone(real), legs: [] } }, []]) {
      const r = await call(cookie, "POST", "/journeys/saved", body);
      expect(r.status).toBe(400);
      expect(Object.keys(json(r))).toEqual(["error"]);
      expect(r.body).not.toContain("onerror");
    }
    expect((await call(cookie, "POST", "/journeys/saved")).status).toBe(400); // no body at all
    const wrongType = await call(cookie, "POST", "/journeys/saved", undefined, { "Content-Type": "text/plain" });
    expect(wrongType.status).toBe(400);
    expect(json(await call(cookie, "GET", "/journeys/saved")).journeys).toEqual([]); // nothing was stored
  });

  test("malformed JSON is a 400 and an oversized body a 413, both with fixed messages", async () => {
    const { cookie } = await newUser();
    const malformed = await send(base, "/journeys/saved", { method: "POST", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: '{"journey":' });
    expect(malformed.status).toBe(400);
    expect(json(malformed)).toEqual({ error: "Malformed request body" });
    const huge = await call(cookie, "POST", "/journeys/saved", { journey: real, padding: "x".repeat(20_000) });
    expect(huge.status).toBe(413);
  });

  test("malformed ids are a plain 404", async () => {
    const { cookie } = await newUser();
    for (const id of ["abc", "1", "%27%3B%20DROP%20TABLE%20users%3B--", "00000000-0000-0000-0000-00000000000g", "../../etc/passwd"]) {
      expect((await call(cookie, "DELETE", `/journeys/saved/${id}`)).status).toBe(404);
    }
  });

  test("state-changing calls are CSRF-protected; reading is not", async () => {
    const { cookie } = await newUser();
    const { journey } = json(await call(cookie, "POST", "/journeys/saved", { journey: real }));
    const noOrigin = (method: string, path: string, body?: unknown) =>
      send(base, path, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body && { body: JSON.stringify(body) }) });
    expect((await noOrigin("POST", "/journeys/saved", { journey: other })).status).toBe(403);
    expect((await noOrigin("DELETE", `/journeys/saved/${journey.id}`)).status).toBe(403);
    const evil = await send(base, `/journeys/saved/${journey.id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(json(await call(cookie, "GET", "/journeys/saved")).journeys).toHaveLength(1); // nothing happened
    expect((await send(base, "/journeys/saved", { headers: { Cookie: cookie, Origin: "https://evil.example" } })).status).toBe(200);
  });

  test("responses are not cacheable and the save route is rate limited per user", async () => {
    const heavy = await newUser();
    const light = await newUser();
    const first = await call(heavy.cookie, "GET", "/journeys/saved");
    expect(first.headers["cache-control"]).toBe("no-store");
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await call(heavy.cookie, "POST", "/journeys/saved", {})).status);
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    expect((await call(light.cookie, "POST", "/journeys/saved", { journey: real })).status).toBe(201);
  });

  test("a signed-out session can no longer read or write", async () => {
    const { user, cookie } = await newUser();
    await call(cookie, "POST", "/auth/signout");
    expect((await call(cookie, "GET", "/journeys/saved")).status).toBe(401);
    expect(user.id).toBeGreaterThan(0);
  });
});

describe("saved-journeys API when the store fails", () => {
  const realError = console.error;
  afterEach(() => {
    console.error = realError;
  });

  test("database errors are a generic 500 with no SQL, credentials or driver text", async () => {
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    const boom = async () => {
      throw new Error('relation "saved_journeys" does not exist: SELECT * FROM saved_journeys -- password=hunter2 postgresql://u:p@db/x');
    };
    const failing: SavedJourneyStore = { save: boom, list: boom, remove: boom };
    const saved = process.env["SESSION_SECRET"];
    process.env["SESSION_SECRET"] = SECRET;
    const app = express();
    app.use(express.json());
    app.use(createJourneysRouter({ store: async () => failing }));
    app.use(errorHandler);
    const { base, close } = await serve(app);
    try {
      const { cookie } = await newUser();
      const h = { Cookie: cookie };
      const id = "11111111-1111-4111-8111-111111111111";
      const results = [
        await send(base, "/journeys/saved", { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ journey: real }) }),
        await send(base, "/journeys/saved", { headers: h }),
        await send(base, `/journeys/saved/${id}`, { method: "DELETE", headers: h }),
      ];
      for (const r of results) {
        expect(r.status).toBe(500);
        expect(JSON.parse(r.body)).toEqual({ error: "Internal server error" });
        for (const leak of ["hunter2", "SELECT", "postgresql://", "saved_journeys", "does not exist"]) expect(r.body).not.toContain(leak);
      }
      expect(logged.length).toBe(3); // operators still get the detail in the log
    } finally {
      close();
      if (saved === undefined) delete process.env["SESSION_SECRET"];
      else process.env["SESSION_SECRET"] = saved;
    }
  });
});

// --- the store contract: memory always, PostgreSQL when TEST_DATABASE_URL is set -----------------

function storeContract(name: string, make: () => Promise<{ store: SavedJourneyStore; user: () => Promise<number> }>) {
  describe(`${name} saved-journey store`, () => {
    test("saves, lists newest first, and deletes", async () => {
      const { store, user } = await make();
      const u = await user();
      const a = await store.save(u, real);
      expect(a.kind).toBe("created");
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.save(u, other);
      expect(b.kind).toBe("created");
      const list = await store.list(u);
      expect(list.map((s) => s.id)).toEqual([(b as any).saved.id, (a as any).saved.id]);
      expect(list[1]!.journey).toEqual(real);
      expect(list[1]!.travelDate).toBe("2026-10-20");
      expect(await store.remove(u, (a as any).saved.id)).toBe(true);
      expect((await store.list(u)).map((s) => s.id)).toEqual([(b as any).saved.id]);
    });

    test("the same journey twice is one row; a different journey is another", async () => {
      const { store, user } = await make();
      const u = await user();
      const first = await store.save(u, real);
      const second = await store.save(u, clone(real));
      expect(second.kind).toBe("exists");
      expect((second as any).saved.id).toBe((first as any).saved.id);
      expect(await store.list(u)).toHaveLength(1);
      expect(journeyKey(real)).not.toBe(journeyKey(other));
    });

    test("users are isolated from each other, including for deletes", async () => {
      const { store, user } = await make();
      const [a, b] = [await user(), await user()];
      const saved = (await store.save(a, real)) as any;
      expect((await store.save(b, real)).kind).toBe("created"); // same trip, separate copy
      expect(await store.remove(b, saved.saved.id)).toBe(false);
      expect((await store.list(a)).map((s) => s.id)).toEqual([saved.saved.id]);
      expect(await store.list(b)).toHaveLength(1);
      expect(await store.remove(a, saved.saved.id)).toBe(true);
      expect(await store.list(b)).toHaveLength(1); // b's copy unaffected
    });

    test("deleting an unknown id is false", async () => {
      const { store, user } = await make();
      expect(await store.remove(await user(), "00000000-0000-4000-8000-000000000000")).toBe(false);
    });

    test(`stops at ${MAX_SAVED_PER_USER} per user, still allowing re-saves of existing ones`, async () => {
      const { store, user } = await make();
      const u = await user();
      const base = clone(real) as any;
      for (let i = 0; i < MAX_SAVED_PER_USER; i++) {
        const j = clone(base);
        j.legs[0].originDate = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10); // distinct runs
        expect((await store.save(u, j)).kind).toBe("created");
      }
      expect((await store.save(u, other)).kind).toBe("limit");
      const again = clone(base);
      again.legs[0].originDate = "2026-01-01";
      expect((await store.save(u, again)).kind).toBe("exists");
      expect(await store.list(u)).toHaveLength(MAX_SAVED_PER_USER);
      expect((await store.save(await user(), other)).kind).toBe("created"); // another user unaffected
    });
  });
}

storeContract("in-memory", async () => {
  const store = createMemorySavedJourneyStore();
  let id = 0;
  return { store, user: async () => ++id }; // the memory store does not need real user rows
});

// Opt-in: needs PostgreSQL in TEST_DATABASE_URL. Each run creates and drops its own uniquely named
// scratch tables (including its own users table), so it never reads or writes real data.
const testDbUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!testDbUrl)("PostgreSQL saved-journey store", () => {
  const suffix = randomBytes(6).toString("hex");
  const usersTable = `users_jtest_${suffix}`;
  const table = `saved_jtest_${suffix}`;
  const sql = new Bun.SQL(testDbUrl ?? "postgres://unused", { max: 4 });
  let counter = 0;

  beforeAll(async () => {
    await migrateUsersTable(sql, usersTable);
    await migrateSavedJourneysTable(sql, table, usersTable);
  });
  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS ${sql(table)}`;
    await sql`DROP TABLE IF EXISTS ${sql(usersTable)}`;
    await sql.close();
  });

  const makeUser = async () => {
    const [row] = await sql`INSERT INTO ${sql(usersTable)} (email, provider, provider_id) VALUES ('t@example.com', 'github', ${`pg-${suffix}-${++counter}`}) RETURNING id`;
    return (row as { id: number }).id;
  };

  storeContract("postgres", async () => {
    await sql`TRUNCATE ${sql(table)}`; // our own scratch table only
    return { store: createPostgresSavedJourneyStore(sql, table), user: makeUser };
  });

  test("journeys survive a restart: a brand-new connection and store still find them", async () => {
    const u = await makeUser();
    const saved = (await createPostgresSavedJourneyStore(sql, table).save(u, real)) as any;
    const reopened = new Bun.SQL(testDbUrl!, { max: 1 });
    try {
      const list = await createPostgresSavedJourneyStore(reopened, table).list(u);
      expect(list.map((s) => s.id)).toEqual([saved.saved.id]);
      expect(list[0]!.journey).toEqual(real);
    } finally {
      await reopened.close();
    }
  });

  test("migrating again is harmless and keeps existing rows", async () => {
    const u = await makeUser();
    await createPostgresSavedJourneyStore(sql, table).save(u, real);
    await migrateSavedJourneysTable(sql, table, usersTable);
    expect(await createPostgresSavedJourneyStore(sql, table).list(u)).toHaveLength(1);
  });

  test("deleting a user removes that user's journeys and nobody else's", async () => {
    const store = createPostgresSavedJourneyStore(sql, table);
    const [a, b] = [await makeUser(), await makeUser()];
    await store.save(a, real);
    await store.save(b, real);
    await sql`DELETE FROM ${sql(usersTable)} WHERE id = ${a}`;
    expect(await store.list(a)).toEqual([]);
    expect(await store.list(b)).toHaveLength(1);
  });

  test("the database itself refuses journeys for unknown users and rows that break the constraints", async () => {
    const store = createPostgresSavedJourneyStore(sql, table);
    await expect(store.save(2_000_000_000, real)).rejects.toThrow(); // foreign key
    const u = await makeUser();
    const insert = (over: { transfers?: number; journey?: object; arrival?: string }) => sql`
      INSERT INTO ${sql(table)} (user_id, journey_key, source_id, source_name, destination_id, destination_name, travel_date,
                                 departure_at, arrival_at, transfer_count, total_duration_minutes, journey)
      VALUES (${u}, ${`k-${++counter}`}, 'A', 'A', 'B', 'B', '2026-10-20', '2026-10-20T10:00:00Z',
              ${over.arrival ?? "2026-10-20T12:00:00Z"}::timestamptz, ${over.transfers ?? 0}, 60, ${over.journey ?? {}}::jsonb)`;
    await insert({}); // baseline: valid
    await expect(insert({ transfers: 9 })).rejects.toThrow();
    await expect(insert({ arrival: "2026-10-20T09:00:00Z" })).rejects.toThrow();
    await expect(insert({ journey: [] })).rejects.toThrow();
    await expect(insert({ journey: { x: "a".repeat(40_000) } })).rejects.toThrow();
  });

  test("concurrent saves of one journey create exactly one row", async () => {
    const store = createPostgresSavedJourneyStore(sql, table);
    const u = await makeUser();
    const results = await Promise.all(Array.from({ length: 6 }, () => store.save(u, real)));
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(await store.list(u)).toHaveLength(1);
  });

  test("a stored journey is reachable only with its owner id; SQL in ids is inert", async () => {
    const store = createPostgresSavedJourneyStore(sql, table);
    const [a, b] = [await makeUser(), await makeUser()];
    const saved = (await store.save(a, real)) as any;
    expect(await store.remove(b, saved.saved.id)).toBe(false);
    await expect(store.remove(a, "x'; DROP TABLE users; --")).rejects.toThrow(); // not a uuid: refused by the driver, run as a value
    expect(await store.list(a)).toHaveLength(1);
  });
});
