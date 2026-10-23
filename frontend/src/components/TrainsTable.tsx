import { formatDuration } from "@/lib/format";
import type { TrainRow } from "@/lib/api";

export function TrainsTable({ trains }: { trains: TrainRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          {["Train", "Departs", "Arrives", "Duration", "Runs"].map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {trains.map((t) => (
          <tr key={t.train.number}>
            <td>
              {t.train.number} {t.train.name}
            </td>
            <td>{t.from.departure}</td>
            <td>{t.to.arrival}</td>
            <td>{formatDuration(t.duration)}</td>
            <td>{t.train.runDays.length === 7 ? "Daily" : t.train.runDays.join(" ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
