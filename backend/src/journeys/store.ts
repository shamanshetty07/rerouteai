import { createHash, randomUUID } from "node:crypto";
import type { Journey } from "../rail/journey.ts";
import { istDateOf } from "../rail/time.ts";
import { MAX_SAVED_PER_USER, type SavedJourney } from "./types.ts";

export type SaveResult =
  | { kind: "created"; saved: SavedJourney }
  /** The same journey was already in this user's list; nothing changed. */
  | { kind: "exists"; saved: SavedJourney }
  | { kind: "limit" };

/** Every method takes the owner explicitly: there is no way to read or change a journey without one. */
export type SavedJourneyStore = {
  save(userId: number, journey: Journey): Promise<SaveResult>;
  /** Newest first. */
  list(userId: number): Promise<SavedJourney[]>;
  /** True when a journey owned by `userId` was deleted; false if it doesn't exist or belongs to someone else. */
  remove(userId: number, id: string): Promise<boolean>;
};

/** Identity of a journey: which trains, on which runs, between which stations. Same trips save once. */
export function journeyKey(journey: Journey): string {
  const signature = journey.legs.map((l) => [l.trainNumber, l.originDate, l.from.id, l.to.id]);
  return createHash("sha256").update(JSON.stringify(signature)).digest("hex");
}

export const travelDateOf = (journey: Journey) => istDateOf(new Date(journey.departure));

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMemorySavedJourneyStore(): SavedJourneyStore {
  const rows: { userId: number; key: string; saved: SavedJourney }[] = [];
  return {
    async save(userId, journey) {
      const key = journeyKey(journey);
      const existing = rows.find((r) => r.userId === userId && r.key === key);
      if (existing) return { kind: "exists", saved: existing.saved };
      if (rows.filter((r) => r.userId === userId).length >= MAX_SAVED_PER_USER) return { kind: "limit" };
      const saved: SavedJourney = {
        id: randomUUID(),
        savedAt: new Date().toISOString(),
        source: journey.source,
        destination: journey.destination,
        travelDate: travelDateOf(journey),
        journey,
      };
      rows.push({ userId, key, saved });
      return { kind: "created", saved };
    },
    async list(userId) {
      return rows.filter((r) => r.userId === userId).map((r) => r.saved).reverse();
    },
    async remove(userId, id) {
      const i = rows.findIndex((r) => r.userId === userId && r.saved.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  };
}

/**
 * PostgreSQL unless USER_STORE=memory, the same switch the user store uses (so the two always agree).
 * Like the user store it connects lazily and never falls back to memory silently.
 */
export function selectSavedJourneyStore(env: Record<string, string | undefined> = process.env): () => Promise<SavedJourneyStore> {
  let store: Promise<SavedJourneyStore> | undefined;
  return () =>
    (store ??= (async () => {
      if (env["USER_STORE"] === "memory") return createMemorySavedJourneyStore();
      const url = env["DATABASE_URL"];
      if (!url) throw new Error("DATABASE_URL is not set (or set USER_STORE=memory for throwaway in-memory data)");
      const { createPostgresSavedJourneyStore } = await import("./postgresstore.ts");
      return createPostgresSavedJourneyStore(new Bun.SQL(url, { max: 5 }));
    })());
}
