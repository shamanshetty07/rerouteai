// Creates the users table if it is missing. Additive only; run it once per database: `bun run db:migrate`.
import { migrateUsersTable } from "../src/auth/postgresuserstore.ts";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is not set");

const sql = new Bun.SQL(url, { max: 1 });
try {
  await migrateUsersTable(sql);
  console.log("users table is ready");
} finally {
  await sql.close();
}
