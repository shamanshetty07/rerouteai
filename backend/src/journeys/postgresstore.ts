import type { Journey } from "../rail/journey.ts";
import { MAX_SAVED_PER_USER, type SavedJourney } from "./types.ts";
import { journeyKey, travelDateOf, type SavedJourneyStore, type SaveResult } from "./store.ts";

type Sql = InstanceType<typeof Bun.SQL>;

/**
 * Additive and idempotent: creates the table and indexes only when missing and never touches the
 * users table or any existing row. Deleting a user removes that user's saved journeys (CASCADE).
 */
export async function migrateSavedJourneysTable(sql: Sql, table = "saved_journeys", usersTable = "users") {
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(table)} (
      id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               integer     NOT NULL REFERENCES ${sql(usersTable)} (id) ON DELETE CASCADE,
      journey_key           text        NOT NULL,
      source_id             text        NOT NULL,
      source_name           text        NOT NULL,
      destination_id        text        NOT NULL,
      destination_name      text        NOT NULL,
      travel_date           date        NOT NULL,
      departure_at          timestamptz NOT NULL,
      arrival_at            timestamptz NOT NULL,
      transfer_count        smallint    NOT NULL CHECK (transfer_count BETWEEN 0 AND 4),
      total_duration_minutes integer    NOT NULL CHECK (total_duration_minutes >= 0),
      journey               jsonb       NOT NULL CHECK (jsonb_typeof(journey) = 'object' AND octet_length(journey::text) <= 32768),
      created_at            timestamptz NOT NULL DEFAULT now(),
      CHECK (arrival_at > departure_at),
      UNIQUE (user_id, journey_key)
    )`;
  // The list query: one user's journeys, newest first.
  await sql`CREATE INDEX IF NOT EXISTS ${sql(`${table}_user_created_idx`)} ON ${sql(table)} (user_id, created_at DESC)`;
}

type Row = { id: string; created_at: Date | string; travel_date: string; journey: unknown };

function toSaved(row: Row): SavedJourney {
  // jsonb normally arrives parsed; tolerate a driver that hands back text.
  const journey = (typeof row.journey === "string" ? JSON.parse(row.journey) : row.journey) as Journey;
  return {
    id: row.id,
    savedAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    source: journey.source,
    destination: journey.destination,
    travelDate: row.travel_date,
    journey,
  };
}

const COLUMNS = (sql: Sql) => sql`id, created_at, to_char(travel_date, 'YYYY-MM-DD') AS travel_date, journey`;

export type PostgresStoreOptions = { table?: string; /** Per-user cap; tests lower it. */ max?: number };

export function createPostgresSavedJourneyStore(sql: Sql, { table = "saved_journeys", max = MAX_SAVED_PER_USER }: PostgresStoreOptions = {}): SavedJourneyStore {
  async function findByKey(db: Sql, userId: number, key: string): Promise<SavedJourney | null> {
    const [row] = await db`SELECT ${COLUMNS(sql)} FROM ${sql(table)} WHERE user_id = ${userId} AND journey_key = ${key}`;
    return row ? toSaved(row as Row) : null;
  }

  return {
    async save(userId, journey): Promise<SaveResult> {
      const key = journeyKey(journey);
      // De-duplication is guaranteed by the UNIQUE key. The cap needs a count-then-insert, so saves by
      // the same user are serialised with a transaction-scoped advisory lock; other users never wait.
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${table}), ${userId}::integer)`;
        const [row] = await tx`
        INSERT INTO ${sql(table)}
          (user_id, journey_key, source_id, source_name, destination_id, destination_name, travel_date,
           departure_at, arrival_at, transfer_count, total_duration_minutes, journey)
        -- The journey is passed as an object: the driver encodes it as JSON itself (a pre-stringified
        -- value would be stored as a JSON *string*, which the table's CHECK constraint refuses).
        SELECT ${userId}::integer, ${key}::text, ${journey.source.id}::text, ${journey.source.name}::text,
               ${journey.destination.id}::text, ${journey.destination.name}::text, ${travelDateOf(journey)}::date,
               ${journey.departure}::timestamptz, ${journey.arrival}::timestamptz, ${journey.transferCount}::smallint,
               ${journey.totalDurationMinutes}::integer, ${journey}::jsonb
        WHERE (SELECT count(*) FROM ${sql(table)} WHERE user_id = ${userId}) < ${max}
        ON CONFLICT (user_id, journey_key) DO NOTHING
        RETURNING ${COLUMNS(sql)}`;
        if (row) return { kind: "created", saved: toSaved(row as Row) } as SaveResult;
        // Nothing inserted: either this exact journey is already saved, or the cap was hit.
        const existing = await findByKey(tx as unknown as Sql, userId, key);
        return (existing ? { kind: "exists", saved: existing } : { kind: "limit" }) as SaveResult;
      });
    },

    async list(userId) {
      const rows = await sql`
        SELECT ${COLUMNS(sql)} FROM ${sql(table)} WHERE user_id = ${userId} ORDER BY created_at DESC, id`;
      return (rows as Row[]).map(toSaved);
    },

    async remove(userId, id) {
      // The owner is part of the WHERE clause: someone else's id simply matches nothing.
      const rows = await sql`DELETE FROM ${sql(table)} WHERE id = ${id}::uuid AND user_id = ${userId} RETURNING id`;
      return rows.length > 0;
    },
  };
}
