"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { StationSource } from "@/lib/stationSource";
import type { Station } from "@/lib/types";

type Props = {
  label: string;
  source: StationSource;
  /** What is typed in the box. Owned by the parent so a swap can move it between fields. */
  text: string;
  /** The chosen station; null until a suggestion is picked, and again as soon as the text is edited. */
  station: Station | null;
  onText(text: string): void;
  onSelect(station: Station): void;
  error?: string | null;
  /** Return a reason to show a station as unavailable (e.g. already chosen elsewhere), else null. */
  disabledReason?(station: Station): string | null;
  inputRef?: React.Ref<HTMLInputElement>;
};

const detail = (s: Station) => [s.code, s.city].filter(Boolean).join(" · ");

export function StationField({ label, source, text, station, onText, onSelect, error, disabledReason, inputRef }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Station[]>([]);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(-1);

  const reason = (s: Station) => disabledReason?.(s) ?? null;

  async function search(query: string) {
    const current = ++requestId.current;
    try {
      const results = await source.search(query);
      if (current !== requestId.current) return; // a newer keystroke superseded this one
      setSuggestions(results);
      setFailed(false);
    } catch {
      if (current !== requestId.current) return;
      setSuggestions([]);
      setFailed(true);
    }
    setActive(-1);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function choose(s: Station) {
    if (reason(s)) return;
    onSelect(s);
    close();
  }

  /** Move to the next enabled option in `step` direction, skipping disabled ones. */
  function move(step: 1 | -1) {
    for (let i = active + step; i >= 0 && i < suggestions.length; i += step) {
      if (!reason(suggestions[i]!)) return setActive(i);
    }
  }

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, []);

  const listId = `${id}-list`;
  const status = !open ? "" : failed ? "Could not load stations. Try again." : suggestions.length ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} available` : "No stations found";

  return (
    <div
      className="station-field"
      ref={root}
      onBlur={(e) => {
        if (!e.relatedTarget || !root.current?.contains(e.relatedTarget as Node)) close();
      }}
    >
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className="station-input-wrap">
        <input
          ref={inputRef}
          id={`${id}-input`}
          type="text"
          value={text}
          placeholder="Station name, code or city"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
          aria-describedby={`${id}-meta ${id}-error`}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            onText(e.target.value);
            const query = e.target.value.trim();
            if (!query) {
              requestId.current++;
              close();
            } else void search(query);
          }}
          onFocus={() => {
            const query = text.trim();
            if (query && !station) void search(query);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (!open) {
                if (text.trim()) void search(text.trim());
                return;
              }
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Enter" && open && active >= 0) {
              e.preventDefault(); // pick the suggestion instead of submitting the form
              choose(suggestions[active]!);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              close();
            }
          }}
        />
        {text !== "" && (
          <button
            type="button"
            className="station-clear"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              onText("");
              close();
              (root.current?.querySelector("input") as HTMLInputElement | null)?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <ul id={listId} className="station-options" role="listbox" aria-label={`${label} suggestions`}>
          {(failed || !suggestions.length) && (
            <li className="station-empty" role="presentation">
              {failed ? "Could not load stations. Try again." : "No matching stations"}
            </li>
          )}
          {suggestions.map((s, i) => {
            const why = reason(s);
            return (
              <li
                key={s.id}
                id={`${id}-option-${i}`}
                className={`station-option${s.id === station?.id ? " is-selected" : ""}`}
                role="option"
                aria-selected={i === active}
                aria-disabled={why ? true : undefined}
                // mousedown (not click) so the input keeps focus and doesn't blur-close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s);
                }}
              >
                <span className="station-name">{s.name}</span>
                <span className="station-sub">{why ?? detail(s)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <p id={`${id}-meta`} className="station-meta">
        {station ? detail(station) : ""}
      </p>
      <p id={`${id}-error`} className="station-error" role="alert" hidden={!error}>
        {error}
      </p>
      <div className="visually-hidden" role="status" aria-live="polite">
        {status}
      </div>
    </div>
  );
}
