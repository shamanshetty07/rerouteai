# Reroute frontend

Next.js (App Router) UI for the Reroute API in `../backend`. The Integrous-inspired design system lives in
`src/app/globals.css`; fonts (Aleo, Host Grotesk, Azeret Mono) load through `next/font`.

The backend keeps owning auth, sessions and data. `next.config.ts` rewrites `/auth`, `/trains`, `/stations`,
`/journeys`, `/me` and `/profile` to it, so the browser only sees one origin: the session cookie stays
first-party and the backend's same-origin CSRF check keeps working.

## Run locally

```sh
# 1. backend, told that the public origin is the Next.js app (OAuth callbacks and the CSRF check use BASE_URL)
cd backend && BASE_URL=http://localhost:3000 bun run dev      # API on :8000
# 2. frontend
cd frontend && bun install && bun run dev                     # UI on :3000
```

With `DEV_LOGIN=true` on the backend, open <http://localhost:3000/auth/dev/login> to sign in without OAuth.
Register OAuth callbacks as `http://localhost:3000/auth/<provider>/callback`.

`BACKEND_URL` (default `http://localhost:8000`) points the proxy elsewhere. In production serve both behind one
host, or set `BACKEND_URL` and use the frontend's public URL as the backend's `BASE_URL`.

`src/lib/types.ts` and `src/lib/mockStations.ts` mirror backend files; keep them in sync with the API.
