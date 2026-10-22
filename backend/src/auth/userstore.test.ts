import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createPostgresUserStore, migrateUsersTable } from "./postgresuserstore.ts";
import { DuplicateUserError, createMemoryUserStore, selectUserStore, type UserStore } from "./userstore.ts";

const alice = { email: "alice@example.com", name: "Alice", provider: "github", providerId: "gh-1" } as const;

/** Behaviour every store must share, whatever backs it. */
function storeContract(name: string, make: () => Promise<UserStore>) {
  describe(`${name} user store`, () => {
    test("creates a user and finds it by id and by provider identity", async () => {
      const store = await make();
      const user = await store.create(alice);
      expect(user).toEqual({ id: expect.any(Number), ...alice });
      expect(await store.findById(user.id)).toEqual(user);
      expect(await store.findByProvider("github", "gh-1")).toEqual(user);
    });

    test("returns null for unknown users", async () => {
      const store = await make();
      expect(await store.findById(123456789)).toBeNull();
      expect(await store.findByProvider("google", "nobody")).toBeNull();
    });

    test("a duplicate provider identity is rejected, whatever the other fields say", async () => {
      const store = await make();
      const first = await store.create(alice);
      await expect(store.create({ ...alice, email: "other@example.com", name: null })).rejects.toBeInstanceOf(DuplicateUserError);
      expect(await store.findById(first.id)).toEqual(first);
    });

    test("concurrent creates of one identity produce exactly one user", async () => {
      const store = await make();
      const results = await Promise.allSettled([store.create(alice), store.create(alice), store.create(alice)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(DuplicateUserError);
    });

    test("the same email under another provider is a separate account (no auto-linking)", async () => {
      const store = await make();
      const github = await store.create(alice);
      const google = await store.create({ ...alice, provider: "google", providerId: "g-1" });
      expect(google.id).not.toBe(github.id);
      expect(await store.findByProvider("github", "gh-1")).toEqual(github);
      expect(await store.findByProvider("google", "g-1")).toEqual(google);
    });

    test("the same provider id under different providers does not collide", async () => {
      const store = await make();
      await store.create({ ...alice, provider: "github", providerId: "42" });
      await store.create({ ...alice, provider: "google", providerId: "42" });
    });
  });
}

storeContract("in-memory", async () => createMemoryUserStore());

describe("store selection", () => {
  test("USER_STORE=memory selects the in-memory store", async () => {
    const store = await selectUserStore({ USER_STORE: "memory" })();
    expect((await store.create(alice)).provider).toBe("github");
  });

  test("without DATABASE_URL it fails loudly instead of falling back to memory", async () => {
    await expect(selectUserStore({})()).rejects.toThrow("DATABASE_URL is not set");
  });

  test("unit tests run against the memory store, with no database URL in the environment", () => {
    expect(process.env["USER_STORE"]).toBe("memory");
    expect(process.env["DATABASE_URL"]).toBeUndefined();
  });
});

// Opt-in: needs a reachable PostgreSQL in TEST_DATABASE_URL. Each run creates and drops its own
// uniquely named table, so it never reads, writes or deletes the application's `users` data.
const testDbUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!testDbUrl)("PostgreSQL user store", () => {
  const table = `users_test_${randomBytes(6).toString("hex")}`;
  const sql = new Bun.SQL(testDbUrl ?? "postgres://unused", { max: 3 });

  beforeAll(() => migrateUsersTable(sql, table));
  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS ${sql(table)}`;
    await sql.close();
  });

  storeContract("postgres", async () => {
    await sql`TRUNCATE ${sql(table)}`; // our own scratch table only
    return createPostgresUserStore(sql, table);
  });

  test("users survive a restart: a brand-new connection and store still find them", async () => {
    await sql`TRUNCATE ${sql(table)}`;
    const created = await createPostgresUserStore(sql, table).create(alice);

    const reopened = new Bun.SQL(testDbUrl!, { max: 1 });
    try {
      expect(await createPostgresUserStore(reopened, table).findById(created.id)).toEqual(created);
    } finally {
      await reopened.close();
    }
  });

  test("migrating again is harmless and keeps existing rows", async () => {
    await sql`TRUNCATE ${sql(table)}`;
    const created = await createPostgresUserStore(sql, table).create(alice);
    await migrateUsersTable(sql, table);
    expect(await createPostgresUserStore(sql, table).findById(created.id)).toEqual(created);
  });
});
