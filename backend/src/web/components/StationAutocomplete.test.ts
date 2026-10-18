import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush, mouseDown, optionNames, options, press, type } from "../../../test/dom.ts";
import { mockStationSource, type StationSource } from "../stations/stationSource.ts";
import type { Station } from "../stations/types.ts";
import { createStationAutocomplete, type StationAutocomplete } from "./StationAutocomplete.ts";

let field: StationAutocomplete;
let changes: (Station | null)[];

function mountField(overrides: Partial<Parameters<typeof createStationAutocomplete>[0]> = {}) {
  changes = [];
  field = createStationAutocomplete({
    id: "t",
    label: "From",
    source: mockStationSource,
    onChange: (s) => changes.push(s),
    ...overrides,
  });
  document.body.append(field.element);
}

const listbox = () => field.element.querySelector<HTMLElement>('[role="listbox"]')!;
const highlighted = () => field.element.querySelector('[aria-selected="true"]');

beforeEach(() => mountField());
afterEach(() => {
  field.destroy();
  document.body.replaceChildren();
});

describe("suggestions", () => {
  test("shows nothing for empty input", async () => {
    expect(listbox().hidden).toBe(true);
    await type(field.input, "   ");
    expect(listbox().hidden).toBe(true);
    expect(options(field.element)).toHaveLength(0);
  });

  test("shows matches as the user types with name, code and city", async () => {
    await type(field.input, "chennai");
    expect(listbox().hidden).toBe(false);
    expect(field.input.getAttribute("aria-expanded")).toBe("true");
    expect(optionNames(field.element)).toEqual(["Chennai Central", "Chennai Egmore", "Tambaram"]);
    expect(options(field.element)[0]!.textContent).toContain("MAS · Chennai");
  });

  test("shows a clear message when nothing matches", async () => {
    await type(field.input, "zzzzqq");
    expect(listbox().textContent).toContain("No matching stations");
    expect(options(field.element)).toHaveLength(0);
    expect(field.element.querySelector('[role="status"]')!.textContent).toBe("No stations found");
  });

  test("shows an error message if the source fails", async () => {
    field.destroy();
    document.body.replaceChildren();
    const failing: StationSource = { search: () => Promise.reject(new Error("boom")) };
    mountField({ source: failing });
    await type(field.input, "delhi");
    expect(listbox().textContent).toContain("Could not load stations");
  });

  test("ignores a slow response that was superseded by a newer keystroke", async () => {
    field.destroy();
    document.body.replaceChildren();
    const resolvers: Record<string, (s: Station[]) => void> = {};
    const source: StationSource = {
      search: (q) => new Promise((resolve) => (resolvers[q] = resolve)),
    };
    mountField({ source });
    const [delhi, pune] = [{ id: "D", name: "Delhi Stn", city: "Delhi" }, { id: "P", name: "Pune Stn", city: "Pune" }];
    field.input.value = "d";
    field.input.dispatchEvent(new Event("input", { bubbles: true }));
    field.input.value = "p";
    field.input.dispatchEvent(new Event("input", { bubbles: true }));
    resolvers["p"]!([pune]);
    await flush();
    resolvers["d"]!([delhi]); // arrives late
    await flush();
    expect(optionNames(field.element)).toEqual(["Pune Stn"]);
  });
});

describe("selection", () => {
  test("selecting a suggestion stores the station object and shows its name", async () => {
    await type(field.input, "new del");
    mouseDown(options(field.element)[0]!);

    expect(field.getSelected()).toMatchObject({ id: "NDLS", code: "NDLS", name: "New Delhi" });
    expect(field.input.value).toBe("New Delhi");
    expect(changes.at(-1)?.id).toBe("NDLS");
    expect(listbox().hidden).toBe(true);
    expect(field.element.querySelector(".station-meta")!.textContent).toBe("NDLS · Delhi");
  });

  test("editing the input invalidates the previous selection", async () => {
    await type(field.input, "new del");
    mouseDown(options(field.element)[0]!);
    expect(field.getSelected()).not.toBeNull();

    await type(field.input, "New Delh");
    expect(field.getSelected()).toBeNull();
    expect(changes.at(-1)).toBeNull();
    expect(field.element.querySelector(".station-meta")!.textContent).toBe("");
  });

  test("the clear button resets the field and refocuses the input", async () => {
    await type(field.input, "pune");
    mouseDown(options(field.element)[0]!);
    const clear = field.element.querySelector<HTMLButtonElement>(".station-clear")!;
    expect(clear.hidden).toBe(false);

    clear.click();
    expect(field.input.value).toBe("");
    expect(field.getSelected()).toBeNull();
    expect(clear.hidden).toBe(true);
    expect(document.activeElement).toBe(field.input);
  });

  test("setSelected updates the displayed value and selection", () => {
    field.setSelected({ id: "MAS", code: "MAS", name: "Chennai Central", city: "Chennai" });
    expect(field.input.value).toBe("Chennai Central");
    expect(field.getSelected()?.id).toBe("MAS");
    field.setSelected(null);
    expect(field.input.value).toBe("");
  });

  test("outside click closes the list", async () => {
    await type(field.input, "delhi");
    expect(listbox().hidden).toBe(false);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(listbox().hidden).toBe(true);
  });

  test("disabled stations are shown with a reason and cannot be chosen", async () => {
    field.destroy();
    document.body.replaceChildren();
    mountField({ isDisabled: (s) => (s.id === "NDLS" ? "Already chosen as destination" : null) });
    await type(field.input, "new del");
    const [option] = options(field.element);
    expect(option!.getAttribute("aria-disabled")).toBe("true");
    expect(option!.textContent).toContain("Already chosen as destination");
    mouseDown(option!);
    expect(field.getSelected()).toBeNull();
  });
});

describe("keyboard", () => {
  test("arrow keys move the highlight and Enter selects it", async () => {
    await type(field.input, "chennai");
    expect(highlighted()).toBeNull();

    press(field.input, "ArrowDown");
    expect(highlighted()!.textContent).toContain("Chennai Central");
    expect(field.input.getAttribute("aria-activedescendant")).toBe(highlighted()!.id);

    press(field.input, "ArrowDown");
    expect(highlighted()!.textContent).toContain("Chennai Egmore");
    press(field.input, "ArrowUp");
    expect(highlighted()!.textContent).toContain("Chennai Central");

    press(field.input, "ArrowDown");
    const enter = press(field.input, "Enter");
    expect(enter.defaultPrevented).toBe(true); // does not submit the form
    expect(field.getSelected()?.id).toBe("MS");
    expect(field.input.value).toBe("Chennai Egmore");
  });

  test("the highlight does not run past either end of the list", async () => {
    await type(field.input, "chennai");
    press(field.input, "ArrowUp");
    expect(highlighted()).toBeNull();
    for (let i = 0; i < 10; i++) press(field.input, "ArrowDown");
    expect(highlighted()!.textContent).toContain("Tambaram");
  });

  test("Escape closes the list without selecting", async () => {
    await type(field.input, "delhi");
    press(field.input, "ArrowDown");
    press(field.input, "Escape");
    expect(listbox().hidden).toBe(true);
    expect(field.getSelected()).toBeNull();
    expect(field.input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("Enter with nothing highlighted does not select or swallow the event", async () => {
    await type(field.input, "delhi");
    const enter = press(field.input, "Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(field.getSelected()).toBeNull();
  });

  test("arrow navigation skips disabled stations", async () => {
    field.destroy();
    document.body.replaceChildren();
    mountField({ isDisabled: (s) => (s.id === "MAS" ? "taken" : null) });
    await type(field.input, "chennai");
    press(field.input, "ArrowDown");
    expect(highlighted()!.textContent).toContain("Chennai Egmore");
  });

  test("exposes combobox ARIA wiring", () => {
    expect(field.input.getAttribute("role")).toBe("combobox");
    expect(field.input.getAttribute("aria-controls")).toBe(listbox().id);
    expect(field.element.querySelector("label")!.htmlFor).toBe(field.input.id);
    expect(listbox().getAttribute("role")).toBe("listbox");
  });
});
