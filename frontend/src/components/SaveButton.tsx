"use client";

import { useState } from "react";
import { describeFailure, saveJourney } from "@/lib/api";
import type { Journey } from "@/lib/types";

type State = { label: string; note: string; error: boolean; disabled: boolean };

/** The footer row for a result card: a Save button plus a polite live note for the outcome. */
export function SaveButton({ journey, onUnauthorized }: { journey: Journey; onUnauthorized?: () => void }) {
  const [state, setState] = useState<State>({ label: "Save journey", note: "", error: false, disabled: false });

  async function save() {
    setState({ label: "Saving…", note: "", error: false, disabled: true });
    const outcome = await saveJourney(journey);
    if (outcome.kind === "saved") {
      // Stays disabled: there is nothing more to do with this card.
      setState({
        label: "Saved ✓",
        note: outcome.alreadySaved ? "Already in your saved journeys." : "Saved. Find it under Saved journeys.",
        error: false,
        disabled: true,
      });
      return;
    }
    setState({
      label: outcome.kind === "unauthorized" ? "Save journey" : "Try again",
      note: describeFailure(outcome),
      error: true,
      disabled: false,
    });
    if (outcome.kind === "unauthorized") onUnauthorized?.();
  }

  return (
    <div className="journey-actions">
      <button type="button" disabled={state.disabled} onClick={save} aria-label={`Save journey ${journey.source.name} to ${journey.destination.name}`}>
        {state.label}
      </button>
      <span className={`action-note${state.error ? " error" : ""}`} role="status">
        {state.note}
      </span>
    </div>
  );
}
