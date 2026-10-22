import { Router } from "express";
import { requireAuth } from "../auth/middleware.ts";
import { rateLimit } from "../server/security.ts";
import { selectSavedJourneyStore, UUID, type SavedJourneyStore } from "./store.ts";
import { MAX_SAVED_PER_USER } from "./types.ts";
import { JourneyValidationError, parseSaveRequest } from "./validate.ts";

// All routes need a signed-in user, and the owner is always `req.user.id`, taken from the verified
// session. Nothing in the body, query or path can name an owner. CSRF (Origin check on unsafe
// methods) and the per-IP limits are applied for the whole app in server/app.ts.

const perUser = (max: number) => rateLimit({ windowMs: 60_000, max, key: (req) => `user:${req.user?.id}` });

export type JourneysRouterOptions = {
  /** Injectable for tests; defaults to PostgreSQL (or memory when USER_STORE=memory). */
  store?: () => Promise<SavedJourneyStore>;
};

export function createJourneysRouter({ store = selectSavedJourneyStore() }: JourneysRouterOptions = {}) {
  const router = Router();

  /** POST /journeys/saved { journey } -> 201 { journey: SavedJourney } (200 if already saved) */
  router.post("/journeys/saved", requireAuth, perUser(30), async (req, res, next) => {
    try {
      const journey = parseSaveRequest(req.body);
      const result = await (await store()).save(req.user!.id, journey);
      if (result.kind === "limit") {
        return void res.status(409).json({ error: `You can save at most ${MAX_SAVED_PER_USER} journeys. Remove one first.`, code: "LIMIT_REACHED" });
      }
      res.status(result.kind === "created" ? 201 : 200).json({ journey: result.saved });
    } catch (err) {
      if (err instanceof JourneyValidationError) return void res.status(400).json({ error: err.message });
      next(err); // database or other failures: generic 500 from the app's error handler
    }
  });

  /** GET /journeys/saved -> { journeys: SavedJourney[] }, newest first, the caller's own only */
  router.get("/journeys/saved", requireAuth, perUser(120), async (req, res, next) => {
    try {
      res.json({ journeys: await (await store()).list(req.user!.id) });
    } catch (err) {
      next(err);
    }
  });

  /** DELETE /journeys/saved/:id -> 204. 404 for unknown ids and for other users' journeys alike. */
  router.delete("/journeys/saved/:id", requireAuth, perUser(60), async (req, res, next) => {
    try {
      const id = String(req.params["id"]);
      const removed = UUID.test(id) && (await (await store()).remove(req.user!.id, id));
      if (!removed) return void res.status(404).json({ error: "Saved journey not found" });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
