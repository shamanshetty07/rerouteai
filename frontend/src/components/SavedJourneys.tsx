"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthPrompt } from "@/components/AuthPrompt";
import { JourneyCard } from "@/components/JourneyCard";
import { deleteSavedJourney, describeFailure, listSavedJourneys } from "@/lib/api";
import { formatSavedAt, formatTravelDate } from "@/lib/format";
import type { SavedJourney } from "@/lib/types";

type Status = { message: string; error?: boolean; retry?: () => void };

function SavedCard({ saved, onRemoved, onUnauthorized }: { saved: SavedJourney; onRemoved(id: string): void; onUnauthorized(): void }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState("");

  async function remove() {
    // Two steps, so a stray click doesn't delete anything.
    if (!confirming) return setConfirming(true);
    setRemoving(true);
    setNote("");
    const outcome = await deleteSavedJourney(saved.id);
    if (outcome.kind === "deleted") return onRemoved(saved.id);
    setRemoving(false);
    setConfirming(false);
    setNote(describeFailure(outcome));
    if (outcome.kind === "unauthorized") onUnauthorized();
  }

  const footer = (
    <div className="journey-actions">
      <span className="journey-meta">
        Travel date {formatTravelDate(saved.travelDate)} · Saved {formatSavedAt(saved.savedAt)}
      </span>
      <button
        type="button"
        className="danger"
        disabled={removing}
        onClick={remove}
        aria-label={`Remove saved journey ${saved.source.name} to ${saved.destination.name}`}
      >
        {removing ? "Removing…" : confirming ? "Confirm remove" : "Remove"}
      </button>
      {confirming && (
        <button type="button" className="secondary" disabled={removing} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      )}
      <span className={`action-note${note ? " error" : ""}`} role="status">
        {note}
      </span>
    </div>
  );

  return <JourneyCard journey={saved.journey} heading={`${saved.source.name} → ${saved.destination.name}`} footer={footer} />;
}

export function SavedJourneys() {
  const [journeys, setJourneys] = useState<SavedJourney[] | null>(null);
  const [status, setStatus] = useState<Status>({ message: "Loading saved journeys…" });
  const [needAuth, setNeedAuth] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setNeedAuth(false);
    setLoading(true);
    setStatus({ message: "Loading saved journeys…" });
    const outcome = await listSavedJourneys();
    setLoading(false);
    switch (outcome.kind) {
      case "ok":
        setJourneys(outcome.journeys);
        return setStatus({
          message: outcome.journeys.length
            ? `${outcome.journeys.length} saved journey${outcome.journeys.length === 1 ? "" : "s"}, newest first`
            : "You haven't saved any journeys yet. Search for a journey and press Save.",
        });
      case "unauthorized":
        setJourneys(null);
        setNeedAuth(true);
        return setStatus({ message: "Please sign in to see your saved journeys.", error: true });
      default:
        setJourneys(null);
        return setStatus({ message: describeFailure(outcome), error: true, retry: () => void load() });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function removed(id: string) {
    const left = (journeys ?? []).filter((j) => j.id !== id);
    setJourneys(left);
    setStatus({
      message: left.length ? `Journey removed. ${left.length} saved.` : "You haven't saved any journeys yet. Search for a journey and press Save.",
    });
  }

  return (
    <>
      <h1>Saved journeys</h1>
      <p id="saved-status" role="status" aria-live="polite" className={status.error ? "error" : ""} style={{ color: status.error ? "var(--err)" : "var(--muted)" }}>
        {status.message}
        {status.retry && (
          <button type="button" className="retry" onClick={status.retry}>
            Retry
          </button>
        )}
      </p>
      {needAuth && <AuthPrompt next="/saved" />}
      <div id="saved-list" aria-busy={loading ? true : undefined}>
        {journeys?.map((saved) => (
          <SavedCard
            key={saved.id}
            saved={saved}
            onRemoved={removed}
            onUnauthorized={() => {
              setNeedAuth(true);
              setStatus({ message: "Please sign in to manage your saved journeys.", error: true });
            }}
          />
        ))}
      </div>
    </>
  );
}
