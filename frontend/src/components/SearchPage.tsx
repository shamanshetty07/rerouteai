"use client";

import { useState } from "react";
import { AuthPrompt } from "@/components/AuthPrompt";
import { JourneyCard, WarningList } from "@/components/JourneyCard";
import { SaveButton } from "@/components/SaveButton";
import { SearchForm, type SearchMode, type SearchValues } from "@/components/SearchForm";
import { TrainsTable } from "@/components/TrainsTable";
import { fetchAlternatives, fetchTrains, type TrainsResponse } from "@/lib/api";
import type { AlternativeSearchResult } from "@/lib/types";

type Status = { message: string; error?: boolean; retry?: () => void };
type Results = { kind: "alternatives"; data: AlternativeSearchResult } | { kind: "direct"; data: TrainsResponse } | null;

export function SearchPage() {
  const [mode, setMode] = useState<SearchMode>("alternatives");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ message: "" });
  const [results, setResults] = useState<Results>(null);
  const [needAuth, setNeedAuth] = useState(false);

  function changeMode(next: SearchMode) {
    setMode(next);
    setResults(null);
    setStatus({ message: "" });
  }

  function requireSignIn(message: string) {
    setStatus({ message, error: true });
    setNeedAuth(true);
  }

  async function searchAlternatives(values: SearchValues) {
    const { from, to, date, time, maxTransfers } = values;
    if (time === undefined) return setStatus({ message: "Choose an earliest departure time.", error: true });
    // Previous results stay on screen (dimmed) until the new ones arrive.
    const retry = () => void searchAlternatives(values);
    const outcome = await fetchAlternatives({ from, to, date, time, ...(maxTransfers !== undefined && { maxTransfers }) });
    switch (outcome.kind) {
      case "ok": {
        const n = outcome.result.journeys.length;
        setResults({ kind: "alternatives", data: outcome.result });
        return setStatus({
          message: n ? `${n} journey option${n === 1 ? "" : "s"}, best first` : "No journeys found for that route, date and time. Try a later time or more transfers.",
        });
      }
      case "unauthorized":
        setResults(null);
        return requireSignIn("Please sign in to search trains.");
      case "invalid":
        setResults(null);
        return setStatus({ message: outcome.message, error: true });
      case "unavailable":
        setResults(null);
        return setStatus({ message: `${outcome.message.replace(/[.!]?$/, ".")} Please try again shortly.`, error: true, retry });
      case "error":
        setResults(null);
        return setStatus({ message: outcome.message, error: true, retry });
    }
  }

  async function searchDirect({ from, to, date }: SearchValues) {
    const outcome = await fetchTrains({ from, to, date });
    if (outcome.kind === "unauthorized") return requireSignIn("Please sign in to search trains.");
    if (outcome.kind === "error") return setStatus({ message: outcome.message, error: true });
    const { data } = outcome;
    if (!data.trains.length) return setStatus({ message: "No direct trains found for that route and date." });
    setResults({ kind: "direct", data });
    const count = data.trains.length;
    setStatus({ message: `${count} train${count === 1 ? "" : "s"} from ${data.from.name} to ${data.to.name}` });
  }

  async function search(values: SearchValues) {
    setNeedAuth(false);
    setBusy(true);
    setStatus({ message: "Searching…" });
    if (mode === "direct") setResults(null);
    try {
      await (mode === "alternatives" ? searchAlternatives(values) : searchDirect(values));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Find another way there</h1>
      <p className="lede">Search direct trains, or let Reroute build journeys with connections when the direct route is full.</p>

      <SearchForm mode={mode} onModeChange={changeMode} busy={busy} onSubmit={search} />

      <p id="status" role="status" aria-live="polite" className={status.error ? "error" : ""}>
        {status.message}
        {status.retry && (
          <button type="button" className="retry" onClick={status.retry}>
            Retry
          </button>
        )}
      </p>

      {needAuth && <AuthPrompt next="/search" />}

      <div className="scroll" id="results" aria-busy={busy && results?.kind === "alternatives" ? true : undefined}>
        {results?.kind === "alternatives" && (
          <>
            <WarningList warnings={results.data.warnings} className="search-warnings" />
            {results.data.journeys.map((journey, i) => (
              <JourneyCard
                key={`${journey.departure}-${journey.legs.map((l) => l.trainNumber).join("-")}-${i}`}
                journey={journey}
                heading={`Option ${i + 1}`}
                footer={<SaveButton journey={journey} onUnauthorized={() => requireSignIn("Please sign in to save journeys.")} />}
              />
            ))}
          </>
        )}
        {results?.kind === "direct" && <TrainsTable trains={results.data.trains} />}
      </div>
    </>
  );
}
