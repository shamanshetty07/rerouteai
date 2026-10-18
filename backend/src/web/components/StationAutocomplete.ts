import type { StationSource } from "../stations/stationSource.ts";
import type { Station } from "../../rail/types.ts";

export type StationAutocompleteOptions = {
  /** Unique per field on the page; used to wire up label and ARIA ids. */
  id: string;
  label: string;
  source: StationSource;
  placeholder?: string;
  /** Called whenever the selected station changes, including to `null` when the text is edited. */
  onChange?: (station: Station | null) => void;
  /** Return a reason to show a station as unavailable (e.g. already chosen elsewhere), else null. */
  isDisabled?: (station: Station) => string | null;
};

export type StationAutocomplete = {
  element: HTMLElement;
  input: HTMLInputElement;
  getSelected(): Station | null;
  setSelected(station: Station | null): void;
  setError(message: string | null): void;
  focus(): void;
  destroy(): void;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const { class: className, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

export function createStationAutocomplete(options: StationAutocompleteOptions): StationAutocomplete {
  const { id, label, source, onChange, isDisabled } = options;

  const root = el("div", { class: "station-field" });
  const labelEl = el("label", { htmlFor: `${id}-input`, textContent: label });
  const wrap = el("div", { class: "station-input-wrap" });
  const input = el(
    "input",
    { id: `${id}-input`, type: "text", placeholder: options.placeholder ?? "Station name, code or city", autocomplete: "off" },
    {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": "false",
      "aria-controls": `${id}-list`,
      "aria-describedby": `${id}-meta ${id}-error`,
      spellcheck: "false",
    },
  );
  const clear = el("button", { type: "button", class: "station-clear", hidden: true, textContent: "×" }, {
    "aria-label": `Clear ${label.toLowerCase()}`,
  });
  const list = el("ul", { id: `${id}-list`, class: "station-options", hidden: true }, {
    role: "listbox",
    "aria-label": `${label} suggestions`,
  });
  const meta = el("p", { id: `${id}-meta`, class: "station-meta" });
  const errorEl = el("p", { id: `${id}-error`, class: "station-error", hidden: true }, { role: "alert" });
  const status = el("div", { class: "visually-hidden" }, { role: "status", "aria-live": "polite" });

  wrap.append(input, clear);
  root.append(labelEl, wrap, list, meta, errorEl, status);

  let selected: Station | null = null;
  let suggestions: Station[] = [];
  let active = -1;
  let requestId = 0;

  const disabledReason = (station: Station) => isDisabled?.(station) ?? null;

  function setSelectedState(station: Station | null, notify: boolean) {
    const changed = selected?.id !== station?.id;
    selected = station;
    meta.textContent = station ? [station.code, station.city].filter(Boolean).join(" · ") : "";
    if (station) setError(null);
    if (notify && changed) onChange?.(station);
  }

  function setError(message: string | null) {
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
    input.setAttribute("aria-invalid", String(Boolean(message)));
  }

  function syncClear() {
    clear.hidden = input.value === "";
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function highlight(index: number) {
    active = index;
    [...list.children].forEach((child, i) => {
      if (child.getAttribute("role") === "option") child.setAttribute("aria-selected", String(i === index));
    });
    const current = list.children[index];
    if (current) {
      input.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  /** Move to the next enabled option in `step` direction, skipping disabled ones. */
  function move(step: 1 | -1) {
    for (let i = active + step; i >= 0 && i < suggestions.length; i += step) {
      if (!disabledReason(suggestions[i]!)) return highlight(i);
    }
  }

  function choose(station: Station) {
    if (disabledReason(station)) return;
    input.value = station.name;
    setSelectedState(station, true);
    syncClear();
    close();
  }

  function render(message?: string) {
    list.replaceChildren();
    if (message || !suggestions.length) {
      list.append(el("li", { class: "station-empty", textContent: message ?? "No matching stations" }, { role: "presentation" }));
    }
    suggestions.forEach((station, i) => {
      const reason = disabledReason(station);
      const item = el("li", { id: `${id}-option-${i}`, class: "station-option" }, {
        role: "option",
        "aria-selected": "false",
      });
      if (reason) item.setAttribute("aria-disabled", "true");
      if (station.id === selected?.id) item.classList.add("is-selected");

      const name = el("span", { class: "station-name", textContent: station.name });
      const sub = el("span", {
        class: "station-sub",
        textContent: reason ?? [station.code, station.city].filter(Boolean).join(" · "),
      });
      item.append(name, sub);
      // mousedown (not click) so the input keeps focus and doesn't blur-close the list first.
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(station);
      });
      list.append(item);
    });
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(-1);
    status.textContent = message ?? (suggestions.length
      ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"} available`
      : "No stations found");
  }

  async function search(query: string) {
    const current = ++requestId;
    try {
      const results = await source.search(query);
      if (current !== requestId) return; // a newer keystroke superseded this one
      suggestions = results;
      render();
    } catch {
      if (current !== requestId) return;
      suggestions = [];
      render("Could not load stations. Try again.");
    }
  }

  input.addEventListener("input", () => {
    // Typing invalidates any earlier selection until a new suggestion is chosen.
    setSelectedState(null, true);
    setError(null);
    syncClear();
    const query = input.value.trim();
    if (!query) {
      requestId++;
      close();
      return;
    }
    void search(query);
  });

  input.addEventListener("focus", () => {
    const query = input.value.trim();
    if (query && !selected) void search(query);
  });

  input.addEventListener("keydown", (e) => {
    const open = !list.hidden;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!open) {
        const query = input.value.trim();
        if (query) void search(query);
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
  });

  root.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next && root.contains(next)) return;
    close();
  });

  clear.addEventListener("click", () => {
    input.value = "";
    setSelectedState(null, true);
    setError(null);
    syncClear();
    close();
    input.focus();
  });

  const onOutsidePointer = (e: Event) => {
    if (!root.contains(e.target as Node)) close();
  };
  document.addEventListener("pointerdown", onOutsidePointer);

  return {
    element: root,
    input,
    getSelected: () => selected,
    setSelected(station) {
      input.value = station?.name ?? "";
      setSelectedState(station, true);
      if (!station) setError(null);
      syncClear();
      close();
    },
    setError,
    focus: () => input.focus(),
    destroy: () => document.removeEventListener("pointerdown", onOutsidePointer),
  };
}
