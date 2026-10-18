import { createInMemoryRailData } from "./repository.ts";
import { mockStations } from "./mockStations.ts";
import type { ScheduleTime, Train, TrainStop, TrainType, Weekday } from "./types.ts";

// Schedules below are real Indian Railways timetables, trimmed to the major halts (a real train
// has more stops than listed here) and written as `[station, arrival, departure, km]`.
// A time with a "+N" suffix falls N days after the origin departure day: "00:25+1" is 00:25 the
// next calendar day. Treat them as test fixtures, not authoritative timetables.

function sched(value: string | null): ScheduleTime | null {
  if (value === null) return null;
  const [time = "", days = "0"] = value.split("+");
  return { dayOffset: Number(days), time };
}

type Row = [stationId: string, arrival: string | null, departure: string | null, km: number];

function train(number: string, name: string, type: TrainType, runDays: Weekday[], rows: Row[]): Train {
  const stops: TrainStop[] = rows.map(([stationId, arrival, departure, distanceKm]) => ({
    stationId,
    arrival: sched(arrival),
    departure: sched(departure),
    distanceKm,
  }));
  return { number, name, type, runDays, stops };
}

export const mockTrains: readonly Train[] = [
  train("12002", "New Delhi - Rani Kamlapati Shatabdi Express", "shatabdi", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], [
    ["NDLS", null, "06:00", 0],
    ["AGC", "07:50", "07:55", 194.7],
    ["GWL", "09:23", "09:28", 312.8],
    ["BPL", "14:12", "14:15", 702.2],
    ["RKMP", "14:40", null, 708.3],
  ]),
  train("12301", "Howrah - New Delhi Rajdhani Express", "rajdhani", ["mon", "tue", "wed", "thu", "fri", "sat"], [
    ["HWH", null, "16:50", 0],
    ["DHN", "19:55", "20:00", 258.8],
    ["GAYA", "22:32", "22:35", 457.9],
    ["DDU", "00:43+1", "00:50+1", 662.9],
    ["PRYJ", "02:40+1", "02:42+1", 818],
    ["CNB", "04:45+1", "04:50+1", 1012.5],
    ["NDLS", "10:05+1", null, 1452.6],
  ]),
  train("12622", "Tamil Nadu Express", "superfast", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], [
    ["NDLS", null, "21:05", 0],
    ["AGC", "23:25", "23:27", 194.7],
    ["GWL", "01:13+1", "01:15+1", 312.8],
    ["BPL", "06:45+1", "06:50+1", 702.2],
    ["ET", "08:35+1", "08:40+1", 793.5],
    ["NGP", "13:05+1", "13:10+1", 1090.7],
    ["BZA", "23:00+1", "23:10+1", 1751.5],
    ["MAS", "06:35+2", null, 2182.9],
  ]),
  train("12627", "Karnataka Express", "superfast", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], [
    ["SBC", null, "19:20", 0],
    ["BNC", "19:31", "19:32", 4.2],
    ["SUR", "07:10+1", "07:15+1", 681.5],
    ["DD", "10:00+1", "10:05+1", 868.4],
    ["BSL", "17:10+1", "17:15+1", 1290.5],
    ["ET", "21:20+1", "21:25+1", 1597.5],
    ["BPL", "23:00+1", "23:05+1", 1688.8],
    ["GWL", "04:05+2", "04:07+2", 2078.1],
    ["AGC", "05:35+2", "05:40+2", 2196.3],
    ["NZM", "08:33+2", "08:35+2", 2383.8],
    ["NDLS", "09:00+2", null, 2391],
  ]),
  train("12951", "Mumbai Central - New Delhi Tejas Rajdhani Express", "rajdhani", ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], [
    ["MMCT", null, "17:00", 0],
    ["ST", "19:43", "19:48", 263.6],
    ["BRC", "21:06", "21:16", 393.2],
    ["RTM", "00:25+1", "00:28+1", 653.6],
    ["KOTA", "03:15+1", "03:20+1", 922.8],
    ["NDLS", "08:32+1", null, 1388.4],
  ]),
  train("20808", "Hirakud Express", "superfast", ["wed", "sat", "sun"], [
    ["ASR", null, "23:55", 0],
    ["LDH", "02:20+1", "02:30+1", 135.5],
    ["NDLS", "08:00+1", "08:15+1", 448.3],
    ["AGC", "10:35+1", "10:40+1", 643.1],
    ["GWL", "12:32+1", "12:34+1", 761.2],
    ["BSP", "03:50+2", "04:05+2", 1585.9],
    ["BBS", "14:20+2", "14:25+2", 2124.6],
    ["VSKP", "21:50+2", null, 2568.6],
  ]),
];

export const mockRailData = createInMemoryRailData({ stations: mockStations, trains: mockTrains });
