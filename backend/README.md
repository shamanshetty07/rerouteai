# backend

Express API for Reroute, run with [Bun](https://bun.com).

```bash
bun install
cp .env.example .env   # set DATABASE_URL and SESSION_SECRET
bun run db:migrate     # once per database: creates the users table (additive, idempotent)
bun run dev            # hot reload, http://localhost:8000
bun run start
```

## Development login (local only)

Signs you in as a fixed "Development User" so you can use authenticated pages without GitHub or Google OAuth. It uses the normal session cookie and `requireAuth`, so protected routes behave exactly as they do for real users.

1. In `.env`, set a signing key and the flag (the key can be any random string):
   ```bash
   SESSION_SECRET="<output of: openssl rand -hex 32>"
   DEV_LOGIN="true"
   ```
2. Start the app: `bun run dev`. The console prints a `DEV_LOGIN is enabled` warning.
3. Open <http://localhost:8000/auth/dev/login>. You are redirected to `/search` signed in. Add `?next=/profile` to land on another path of this site.
4. To turn it off, remove `DEV_LOGIN` (or set it to anything other than exactly `true`) and restart. The route then returns 404.

Safeguards: it is off unless `DEV_LOGIN` is exactly `true`; the server refuses to start if it is enabled while `NODE_ENV=production`; it only answers requests from the local machine; and it ignores any user id or email in the request. It never reads or issues anything other than the single dev user's session. Don't set `DEV_LOGIN` on any deployed environment.

The users are held in memory, so restarting the server signs you out (the cookie then points at a user that no longer exists); visit the login URL again.

## User storage

Users are stored in PostgreSQL (`users` table, via Bun's built-in `Bun.SQL`), keyed by `(provider, provider_id)`. Email is not unique and is never used to link accounts, so the same address signing in with GitHub and with Google gives two separate users.

- `bun run db:migrate` creates the table if missing. It only ever adds; it never alters or drops data.
- `DATABASE_URL` is required. If it is missing the server errors on first use rather than quietly keeping users in memory. `USER_STORE=memory` opts in to throwaway in-memory users.
- `bun test` always uses the in-memory store and ignores `DATABASE_URL`. To also run the PostgreSQL store tests, point `TEST_DATABASE_URL` at a database you are happy to create a scratch table in (each run creates and drops its own `users_test_<random>` table and never touches `users`):
  ```bash
  TEST_DATABASE_URL="postgresql://..." bun test src/auth/userstore.test.ts
  ```
- Prisma is not used for users yet: with the pinned prerelease packages `prisma contract emit` fails (even on the untouched contract), which is also why `src/prisma/db.ts` does not typecheck.
