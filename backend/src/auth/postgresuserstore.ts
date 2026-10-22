import { DuplicateUserError, type User, type UserProvider, type UserStore } from "./userstore.ts";

type Sql = InstanceType<typeof Bun.SQL>;

type Row = { id: number; email: string; name: string | null; provider: string; provider_id: string; session_version: number };

const toUser = (row: Row): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  provider: row.provider as UserProvider,
  providerId: row.provider_id,
  sessionVersion: row.session_version,
});

/** Additive and idempotent: safe to run repeatedly, never alters or drops existing data. */
export async function migrateUsersTable(sql: Sql, table = "users") {
  // email is deliberately not unique: the same address under two providers stays two accounts.
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(table)} (
      id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email       text NOT NULL,
      name        text,
      provider    text NOT NULL,
      provider_id text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_id)
    )`;
  // Added after the first release; existing rows keep working and start at version 0.
  await sql`ALTER TABLE ${sql(table)} ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0`;
}

const UNIQUE_VIOLATION = "23505";

export function createPostgresUserStore(sql: Sql, table = "users"): UserStore {
  return {
    async findByProvider(provider, providerId) {
      const [row] = await sql`
        SELECT id, email, name, provider, provider_id, session_version FROM ${sql(table)}
        WHERE provider = ${provider} AND provider_id = ${providerId}`;
      return row ? toUser(row as Row) : null;
    },
    async findById(id) {
      const [row] = await sql`
        SELECT id, email, name, provider, provider_id, session_version FROM ${sql(table)} WHERE id = ${id}`;
      return row ? toUser(row as Row) : null;
    },
    async create(data) {
      try {
        const [row] = await sql`
          INSERT INTO ${sql(table)} (email, name, provider, provider_id)
          VALUES (${data.email}, ${data.name}, ${data.provider}, ${data.providerId})
          RETURNING id, email, name, provider, provider_id, session_version`;
        return toUser(row as Row);
      } catch (err) {
        if ((err as { errno?: string }).errno === UNIQUE_VIOLATION) throw new DuplicateUserError();
        throw err;
      }
    },
    async revokeSessions(id) {
      await sql`UPDATE ${sql(table)} SET session_version = session_version + 1 WHERE id = ${id}`;
    },
  };
}
