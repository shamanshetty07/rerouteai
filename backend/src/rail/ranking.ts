// Deterministic ranking, kept apart from route discovery so the policy can change on its own.
// Every term is in "equivalent minutes" so the weights are easy to reason about. There is no
// fare term: the rail data carries no reliable fares, and we do not invent them.

export type RankingWeights = {
  /** Per minute from first boarding to final arrival. */
  durationWeight: number;
  /** Flat penalty per transfer (missed-connection risk, hassle), in minutes. */
  transferPenaltyMinutes: number;
  /** Extra per minute spent waiting at transfers, on top of it counting towards duration. */
  waitWeight: number;
  /** Per minute between the passenger's earliest departure and the first train leaving. */
  startDelayWeight: number;
};

export const DEFAULT_RANKING: RankingWeights = {
  durationWeight: 1,
  transferPenaltyMinutes: 90,
  waitWeight: 0.5,
  startDelayWeight: 0.5,
};

export type RankableJourney = {
  totalDurationMinutes: number;
  transferCount: number;
  totalWaitMinutes: number;
  startDelayMinutes: number;
  departure: string;
  arrival: string;
  legs: readonly { trainNumber: string; originDate: string; from: { id: string }; to: { id: string } }[];
};

export function scoreJourney(j: RankableJourney, w: RankingWeights = DEFAULT_RANKING): number {
  const score =
    w.durationWeight * j.totalDurationMinutes +
    w.transferPenaltyMinutes * j.transferCount +
    w.waitWeight * j.totalWaitMinutes +
    w.startDelayWeight * j.startDelayMinutes;
  return Math.round(score * 1e6) / 1e6; // keeps float noise from deciding ties
}

/** Identifies the exact trains and boarding/alighting points; the last-resort tiebreak. */
export function journeySignature(j: RankableJourney): string {
  return j.legs.map((l) => `${l.trainNumber}@${l.originDate}:${l.from.id}>${l.to.id}`).join("|");
}

/**
 * Orders by score, then arrival, transfers, departure and finally the train signature, so equal
 * scores never come back in an arbitrary order.
 */
export function compareJourneys(a: RankableJourney & { score: number }, b: RankableJourney & { score: number }) {
  if (a.score !== b.score) return a.score - b.score;
  const arrival = Date.parse(a.arrival) - Date.parse(b.arrival);
  if (arrival) return arrival;
  if (a.transferCount !== b.transferCount) return a.transferCount - b.transferCount;
  const departure = Date.parse(a.departure) - Date.parse(b.departure);
  if (departure) return departure;
  const [sa, sb] = [journeySignature(a), journeySignature(b)];
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Scores every journey and returns them best first. Does not mutate the input. */
export function rankJourneys<T extends RankableJourney>(
  journeys: readonly T[],
  weights: RankingWeights = DEFAULT_RANKING,
): (T & { score: number })[] {
  return journeys
    .map((j) => ({ ...j, score: scoreJourney(j, weights) }))
    .sort(compareJourneys);
}
