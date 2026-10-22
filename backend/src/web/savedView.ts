// Save button on result cards and the Saved Journeys view. Both talk to /journeys/saved through
// savedApi.ts, take it as a dependency (so tests need no network) and build DOM with textContent only.

import type { Journey } from "../rail/journey.ts";
import type { SavedJourney } from "../journeys/types.ts";
import { renderJourneyCard } from "./alternatives.ts";
import { hideAuthPrompt, showAuthPrompt } from "./authLinks.ts";
import { deleteSavedJourney, listSavedJourneys, saveJourney, type DeleteOutcome, type ListOutcome, type SaveOutcome } from "./savedApi.ts";

export type SavedApi = {
  save(journey: Journey): Promise<SaveOutcome>;
  list(): Promise<ListOutcome>;
  remove(id: string): Promise<DeleteOutcome>;
};

export const defaultSavedApi: SavedApi = {
  save: (journey) => saveJourney(journey),
  list: () => listSavedJourneys(),
  remove: (id) => deleteSavedJourney(id),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void) {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const savedFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const formatTravelDate = (isoDate: string) => dateFormat.format(new Date(`${isoDate}T00:00:00Z`));

/** Messages for the failures every action shares. Returns true when the user needs to sign in. */
function describeFailure(outcome: { kind: string; message?: string }): string {
  switch (outcome.kind) {
    case "unauthorized":
      return "Please sign in to continue.";
    case "rate-limited":
      return "You're going a bit fast. Wait a moment and try again.";
    default:
      return outcome.message ?? "Something went wrong. Please try again.";
  }
}

// ---------------------------------------------------------------------------------------------
// Save button

export type SaveButtonOptions = {
  api?: Pick<SavedApi, "save">;
  /** Called when the server says the user isn't signed in, so the page can show its sign-in prompt. */
  onUnauthorized?: () => void;
};

/** The footer row for a result card: a Save button plus a polite live note for the outcome. */
export function createSaveFooter(journey: Journey, { api = defaultSavedApi, onUnauthorized }: SaveButtonOptions = {}): HTMLElement {
  const row = el("div", "journey-actions");
  const note = el("span", "action-note");
  note.setAttribute("role", "status");
  const save = el("button", undefined, "Save journey");
  save.type = "button";
  save.setAttribute("aria-label", `Save journey ${journey.source.name} to ${journey.destination.name}`);

  save.addEventListener("click", async () => {
    save.disabled = true;
    save.textContent = "Saving…";
    note.textContent = "";
    note.className = "action-note";
    const outcome = await api.save(journey);
    if (outcome.kind === "saved") {
      save.textContent = "Saved ✓";
      note.textContent = outcome.alreadySaved ? "Already in your saved journeys." : "Saved. Find it under Saved journeys.";
      return; // stays disabled: there is nothing more to do with this card
    }
    save.disabled = false;
    save.textContent = outcome.kind === "unauthorized" ? "Save journey" : "Try again";
    note.textContent = describeFailure(outcome);
    note.className = "action-note error";
    if (outcome.kind === "unauthorized") onUnauthorized?.();
  });

  row.append(save, note);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Saved Journeys view

export type SavedViewElements = {
  /** Where the status line (loading, empty, errors) is written. */
  status: HTMLElement;
  /** Where the cards go. */
  list: HTMLElement;
  /** The sign-in / sign-up panel for this view. */
  authPrompt: HTMLElement;
};

export type SavedView = {
  /** Fetches and renders. Safe to call repeatedly (e.g. every time the view is opened). */
  load(): Promise<void>;
};

export function initSavedView({ status, list, authPrompt }: SavedViewElements, api: Pick<SavedApi, "list" | "remove"> = defaultSavedApi): SavedView {
  let loading = false;

  const setStatus = (message: string, isError = false, retry?: () => void) => {
    status.textContent = message;
    status.className = isError ? "error" : "";
    if (retry) status.append(button("Retry", "retry", retry));
  };

  function showEmptyIfNeeded() {
    if (list.children.length === 0) setStatus("You haven't saved any journeys yet. Search for a journey and press Save.");
  }

  function card(saved: SavedJourney): HTMLElement {
    const footer = el("div", "journey-actions");
    const note = el("span", "action-note");
    note.setAttribute("role", "status");
    const meta = el("span", "journey-meta", `Travel date ${formatTravelDate(saved.travelDate)} · Saved ${savedFormat.format(new Date(saved.savedAt))}`);
    const remove = el("button", "danger", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove saved journey ${saved.source.name} to ${saved.destination.name}`);
    const cancel = el("button", "secondary", "Cancel");
    cancel.type = "button";
    cancel.hidden = true;
    let confirming = false;

    const reset = () => {
      confirming = false;
      remove.textContent = "Remove";
      cancel.hidden = true;
    };
    cancel.addEventListener("click", reset);

    remove.addEventListener("click", async () => {
      // Two steps, so a stray click doesn't delete anything.
      if (!confirming) {
        confirming = true;
        remove.textContent = "Confirm remove";
        cancel.hidden = false;
        return;
      }
      remove.disabled = cancel.disabled = true;
      remove.textContent = "Removing…";
      note.textContent = "";
      const outcome = await api.remove(saved.id);
      if (outcome.kind === "deleted") {
        article.remove();
        if (list.children.length === 0) showEmptyIfNeeded();
        else setStatus(`Journey removed. ${list.children.length} saved.`);
        return;
      }
      remove.disabled = cancel.disabled = false;
      reset();
      note.textContent = describeFailure(outcome);
      note.className = "action-note error";
      if (outcome.kind === "unauthorized") {
        setStatus("Please sign in to manage your saved journeys.", true);
        showAuthPrompt(authPrompt);
      }
    });

    footer.append(meta, remove, cancel, note);
    const article = renderJourneyCard(saved.journey, `${saved.source.name} → ${saved.destination.name}`, footer);
    return article;
  }

  async function load() {
    if (loading) return;
    loading = true;
    hideAuthPrompt(authPrompt);
    list.setAttribute("aria-busy", "true");
    setStatus("Loading saved journeys…");
    try {
      const outcome = await api.list();
      list.replaceChildren();
      switch (outcome.kind) {
        case "ok": {
          if (outcome.journeys.length === 0) return showEmptyIfNeeded();
          setStatus(`${outcome.journeys.length} saved journey${outcome.journeys.length === 1 ? "" : "s"}, newest first`);
          for (const saved of outcome.journeys) list.append(card(saved));
          return;
        }
        case "unauthorized":
          setStatus("Please sign in to see your saved journeys.", true);
          return showAuthPrompt(authPrompt);
        default:
          return setStatus(describeFailure(outcome), true, () => void load());
      }
    } finally {
      list.removeAttribute("aria-busy");
      loading = false;
    }
  }

  return { load };
}
