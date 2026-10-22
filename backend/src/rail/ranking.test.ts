import { describe, expect, test } from "bun:test";
import { DEFAULT_RANKING, compareJourneys, rankJourneys, scoreJourney, type RankableJourney } from "./ranking.ts";

const journey = (over: Partial<RankableJourney> & { train?: string } = {}): RankableJourney => ({
  totalDurationMinutes: 300,
  transferCount: 0,
  totalWaitMinutes: 0,
  startDelayMinutes: 0,
  departure: "2026-10-20T02:30:00.000Z",
  arrival: "2026-10-20T07:30:00.000Z",
  legs: [{ trainNumber: over.train ?? "10001", originDate: "2026-10-20", from: { id: "AAA" }, to: { id: "BBB" } }],
  ...over,
});

describe("scoreJourney", () => {
  test("combines duration, transfers, waiting and start delay with the default weights", () => {
    const j = journey({ totalDurationMinutes: 400, transferCount: 2, totalWaitMinutes: 60, startDelayMinutes: 30 });
    // 400*1 + 2*90 + 60*0.5 + 30*0.5
    expect(scoreJourney(j)).toBe(625);
    expect(DEFAULT_RANKING.transferPenaltyMinutes).toBe(90);
  });

  test("weights are configurable", () => {
    const j = journey({ totalDurationMinutes: 100, transferCount: 1, totalWaitMinutes: 20 });
    const weights = { durationWeight: 2, transferPenaltyMinutes: 10, waitWeight: 1, startDelayWeight: 0 };
    expect(scoreJourney(j, weights)).toBe(230);
  });
});

describe("rankJourneys", () => {
  test("a slower direct train can beat a faster journey that needs several transfers", () => {
    const direct = journey({ train: "10001", totalDurationMinutes: 500 });
    const hopping = journey({ train: "10002", totalDurationMinutes: 400, transferCount: 2, totalWaitMinutes: 100 });
    expect(rankJourneys([hopping, direct]).map((j) => j.legs[0]!.trainNumber)).toEqual(["10001", "10002"]);
    // ...but not if transfers are made cheap.
    const cheap = { ...DEFAULT_RANKING, transferPenaltyMinutes: 0, waitWeight: 0 };
    expect(rankJourneys([direct, hopping], cheap).map((j) => j.legs[0]!.trainNumber)).toEqual(["10002", "10001"]);
  });

  test("equal scores are ordered by arrival, then by train signature, whatever the input order", () => {
    const base = { totalDurationMinutes: 300 };
    const earlier = journey({ ...base, train: "10005", arrival: "2026-10-20T07:00:00.000Z" });
    const fewer = journey({ ...base, train: "10006" });
    const sameA = journey({ ...base, train: "10007" });
    const sameB = journey({ ...base, train: "10008" });
    const expected = ["10005", "10006", "10007", "10008"];

    // All four score 300, so only the tiebreaks decide.
    for (const order of [[sameB, sameA, fewer, earlier], [earlier, fewer, sameA, sameB], [sameA, earlier, sameB, fewer]]) {
      expect(rankJourneys(order).map((j) => j.legs[0]!.trainNumber)).toEqual(expected);
    }
  });

  test("fewer transfers win a score tie on arrival time", () => {
    const oneStop = journey({ train: "10010", totalDurationMinutes: 210, transferCount: 1 }); // 210 + 90 = 300
    const direct = journey({ train: "10011", totalDurationMinutes: 300 });
    expect(rankJourneys([oneStop, direct]).map((j) => j.legs[0]!.trainNumber)).toEqual(["10011", "10010"]);
  });

  test("does not mutate its input and attaches scores", () => {
    const input = [journey({ train: "10002", totalDurationMinutes: 600 }), journey({ train: "10001" })];
    const ranked = rankJourneys(input);
    expect(input.map((j) => j.legs[0]!.trainNumber)).toEqual(["10002", "10001"]);
    expect(ranked.map((j) => j.score)).toEqual([300, 600]);
    expect(compareJourneys(ranked[0]!, ranked[0]!)).toBe(0);
  });
});
