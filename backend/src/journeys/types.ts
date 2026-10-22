import type { Journey, JourneyStation } from "../rail/journey.ts";

/** What the API returns for a saved journey. `journey` is exactly what the route search produced. */
export type SavedJourney = {
  /** Random UUID; ownership is always checked against the session, never inferred from the id. */
  id: string;
  /** ISO 8601, UTC. */
  savedAt: string;
  source: JourneyStation;
  destination: JourneyStation;
  /** Date of departure in IST, YYYY-MM-DD. */
  travelDate: string;
  journey: Journey;
};

export const MAX_SAVED_PER_USER = 100;
