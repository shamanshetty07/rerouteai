# backend

Express API for Reroute, run with [Bun](https://bun.com).

```bash
bun install
cp .env.example .env   # set DATABASE_URL
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
