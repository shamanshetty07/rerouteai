// Creates the users and saved_journeys tables if they are missing. Additive only; run it once per database: `bun run db:migrate`.
import { migrateUsersTable } from "../src/auth/postgresuserstore.ts";
import { migrateSavedJourneysTable } from "../src/journeys/postgresstore.ts";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is not set");

const sql = new Bun.SQL(url, { max: 1 });
try {
  await migrateUsersTable(sql);
  await migrateSavedJourneysTable(sql);
  console.log("users and saved_journeys tables are ready");
} finally {
  await sql.close();
}
