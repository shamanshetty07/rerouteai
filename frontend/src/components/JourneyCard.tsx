import { formatDuration, formatInstant, plural } from "@/lib/format";
import type { Journey, JourneyWarning, SearchWarning } from "@/lib/types";

export function WarningList({ warnings, className }: { warnings: (JourneyWarning | SearchWarning)[]; className: string }) {
  if (!warnings.length) return null;
  return (
    <ul className={className}>
      {warnings.map((w, i) => (
        <li key={i}>{w.message}</li>
      ))}
    </ul>
  );
}

/** One journey as a card. `footer` (e.g. a Save or Remove row) is rendered below the details. */
export function JourneyCard({ journey, heading, footer }: { journey: Journey; heading: string; footer?: React.ReactNode }) {
  return (
    <article className="journey">
      <header className="journey-head">
        <h3>{heading}</h3>
        <p className="journey-times">
          {formatInstant(journey.departure)} → {formatInstant(journey.arrival)}
        </p>
        <p className="journey-meta">
          {formatDuration(journey.totalDurationMinutes)} · {journey.transferCount === 0 ? "Direct" : plural(journey.transferCount, "transfer")}
        </p>
      </header>
      <ol className="legs">
        {journey.legs.flatMap((leg, i) => {
          const transfer = journey.transfers[i];
          const items = [
            <li key={`leg-${i}`} className="leg">
              <strong>
                {leg.trainNumber} {leg.trainName}
              </strong>
              <div>
                {leg.from.name} · {formatInstant(leg.departure)}
              </div>
              <div>
                {leg.to.name} · {formatInstant(leg.arrival)}
              </div>
              <div className="journey-meta">{formatDuration(leg.durationMinutes)}</div>
            </li>,
          ];
          if (transfer) {
            items.push(
              <li key={`transfer-${i}`} className="transfer">
                Change at {transfer.station.name} · wait {formatDuration(transfer.waitMinutes)}
              </li>,
            );
          }
          return items;
        })}
      </ol>
      <WarningList warnings={journey.warnings} className="journey-warnings" />
      {footer}
    </article>
  );
}
