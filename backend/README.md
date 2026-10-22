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

## OAuth setup (GitHub and Google)

Sign-in uses the authorization-code flow with PKCE and a signed, expiring, single-use state cookie. Accounts are identified only by the provider's stable user id, never by email, so the same address on GitHub and on Google gives two separate users.

**Routes** (from `src/auth/authcontroller.ts`):

| Purpose | Path |
|---|---|
| Start sign-in / sign-up | `GET /auth/github/signin`, `/auth/github/signup`, `/auth/google/signin`, `/auth/google/signup` (optional `?next=/path`, same-site paths only, default `/search`) |
| Provider callback | `GET /auth/github/callback`, `GET /auth/google/callback` |

The callback URL you register with each provider is `${BASE_URL}/auth/<provider>/callback`:

| | GitHub | Google |
|---|---|---|
| Local development (`BASE_URL=http://localhost:8000`, the default) | `http://localhost:8000/auth/github/callback` | `http://localhost:8000/auth/google/callback` |
| Production (`BASE_URL=https://<your-domain>`) | `https://<your-domain>/auth/github/callback` | `https://<your-domain>/auth/google/callback` |

If you change `PORT`, change `BASE_URL` to match, then register the new URL. The URL must match exactly, including scheme, host, port and path.

**GitHub** — github.com → Settings → Developer settings → OAuth Apps → New OAuth App. Set *Homepage URL* to `BASE_URL` and *Authorization callback URL* to the GitHub URL above. Generate a client secret. GitHub allows one callback URL per app, so create one app for local development and one for production. Put the values in `.env` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Reroute requests `read:user user:email` and only trusts an email GitHub reports as verified.

**Google** — console.cloud.google.com → APIs & Services → OAuth consent screen (configure it; add yourself as a test user while in testing), then Credentials → Create credentials → OAuth client ID → *Web application*. Add the Google URL above under *Authorized redirect URIs* (add both the local and the production URL to one client if you like). Put the values in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Reroute requests `openid email profile`, verifies the ID token (RS256 signature against Google's published keys, issuer, audience, expiry, nonce) and requires `email_verified` to create an account.

**Also required:** `SESSION_SECRET` (e.g. `openssl rand -hex 32`) and a database (`DATABASE_URL`, `bun run db:migrate`). A provider with no id or secret answers `503 not configured`. In production (`NODE_ENV=production`) the server refuses to start unless `SESSION_SECRET` is 32+ characters and not a placeholder, and `BASE_URL` is `https://`.

**Try it:** `bun run dev`, open `http://localhost:8000/auth/github/signup` (first time) and approve; you land on `/search` signed in. Later visits use `/auth/github/signin`. A sign-in for an account that was never signed up returns 404 "No account found, sign up first".

Automated tests mock every provider HTTP call. A real GitHub or Google sign-in has not been run against this implementation.

## Security and deployment notes

- **Sessions** are HS256 JWTs (7 days) in an HttpOnly, SameSite=Lax, `Secure`-on-https cookie. Signing out (`POST /auth/signout`) revokes **every** session of that user by bumping `users.session_version`; tokens carrying an older version are refused. Run `bun run db:migrate` **before** deploying a version that needs the column (it is additive and keeps existing users).
- **CSRF:** cookie-authenticated `POST/PUT/PATCH/DELETE` requests must carry an `Origin` (or `Referer`) equal to `BASE_URL` (outside production also the server's own host:port), and are refused when `Sec-Fetch-Site: cross-site`. Requests with no session cookie or an explicit `Authorization: Bearer` header are not affected, and GETs are never checked. OAuth callbacks are protected by the signed, single-use state cookie instead.
- **Rate limits** (in-process memory): auth endpoints 40 per 10 min per IP; the authenticated API 240/min per IP, and per user 30/min `/trains/search`, 60/min `/trains/alternatives`, 120/min `/stations/search`. Behind a reverse proxy set `TRUST_PROXY` to the number of proxy hops, otherwise all clients share the proxy's IP; with several server instances each keeps its own counters, so the real ceiling is `limit x instances` (use a shared store such as Redis if that matters).
- **Headers:** CSP (`default-src 'self'`, no inline scripts), `X-Frame-Options: DENY`, `nosniff`, referrer policy, HSTS for https production, `no-store` on account and API responses. **CORS is deliberately not enabled**: the API is same-origin only.
- **Production startup** refuses to run without a 32+ character non-placeholder `SESSION_SECRET`, an `https://` `BASE_URL`, `DATABASE_URL`, and with `DEV_LOGIN=true` or `USER_STORE=memory`. It warns when no OAuth provider, `RAILRADAR_API_KEY` or `TRUST_PROXY` is configured.
- **Errors:** clients only see fixed messages; SQL, driver, stack and RailRadar details stay in the server log.
- The server speaks plain HTTP: terminate TLS at a reverse proxy or platform load balancer.
