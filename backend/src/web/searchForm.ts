import { createStationAutocomplete, type StationAutocomplete } from "./components/StationAutocomplete.ts";
import type { StationSource } from "./stations/stationSource.ts";
import type { Station } from "./stations/types.ts";

export type SearchValues = { from: string; to: string; date: string };

export type SearchFormOptions = {
  source: StationSource;
  /** Receives station codes (or ids when a station has no code), never the typed text. */
  onSubmit(values: SearchValues): void | Promise<void>;
  /** Today's date as YYYY-MM-DD in the user's timezone; injectable for tests. */
  today?: () => string;
};

export type SearchForm = {
  from: StationAutocomplete;
  to: StationAutocomplete;
  dateInput: HTMLInputElement;
  swap(): void;
  validate(): boolean;
};

const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

const identifier = (station: Station) => station.code ?? station.id;

function mount(form: HTMLFormElement, selector: string): HTMLElement {
  const node = form.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Search form is missing ${selector}`);
  return node;
}

export function initSearchForm(form: HTMLFormElement, options: SearchFormOptions): SearchForm {
  const { source, onSubmit } = options;
  const dateInput = mount(form, 'input[name="date"]') as HTMLInputElement;
  const dateError = mount(form, "[data-date-error]");

  const today = (options.today ?? localToday)();
  dateInput.min = today;
  dateInput.value ||= today;

  // Selected values only ever come from the autocompletes; both fields share the same component.
  const from: StationAutocomplete = createStationAutocomplete({
    id: "from",
    label: "From",
    source,
    onChange: () => to?.getSelected() && to.setError(null),
    isDisabled: (s) => (to?.getSelected()?.id === s.id ? "Already chosen as destination" : null),
  });
  const to: StationAutocomplete = createStationAutocomplete({
    id: "to",
    label: "To",
    source,
    onChange: () => from.getSelected() && from.setError(null),
    isDisabled: (s) => (from.getSelected()?.id === s.id ? "Already chosen as origin" : null),
  });
  mount(form, '[data-station-field="from"]').replaceWith(from.element);
  mount(form, '[data-station-field="to"]').replaceWith(to.element);

  function swap() {
    const a = from.getSelected();
    const b = to.getSelected();
    from.setSelected(b);
    to.setSelected(a);
  }
  mount(form, "[data-swap]").addEventListener("click", swap);

  dateInput.addEventListener("input", () => {
    dateError.hidden = true;
    dateInput.removeAttribute("aria-invalid");
  });

  function validate(): boolean {
    const origin = from.getSelected();
    const destination = to.getSelected();
    const invalid: StationAutocomplete[] = [];

    if (!origin) {
      from.setError("Select a source station from the suggestions.");
      invalid.push(from);
    }
    if (!destination) {
      to.setError("Select a destination station from the suggestions.");
      invalid.push(to);
    } else if (origin && origin.id === destination.id) {
      to.setError("Source and destination must be different.");
      invalid.push(to);
    }

    const dateOk = dateInput.value !== "" && dateInput.value >= today;
    dateError.hidden = dateOk;
    dateError.textContent = dateOk ? "" : "Choose a travel date that is today or later.";
    if (dateOk) dateInput.removeAttribute("aria-invalid");
    else dateInput.setAttribute("aria-invalid", "true");

    if (invalid.length) invalid[0]!.focus();
    else if (!dateOk) dateInput.focus();
    return invalid.length === 0 && dateOk;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validate()) return;
    void onSubmit({
      from: identifier(from.getSelected()!),
      to: identifier(to.getSelected()!),
      date: dateInput.value,
    });
  });

  return { from, to, dateInput, swap, validate };
}
