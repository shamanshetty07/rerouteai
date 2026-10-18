import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush, mouseDown, options, type } from "../../test/dom.ts";
import { initSearchForm, type SearchForm, type SearchValues } from "./searchForm.ts";
import { mockStationSource } from "./stations/stationSource.ts";

let form: HTMLFormElement;
let search: SearchForm;
let submitted: SearchValues[];

beforeEach(() => {
  document.body.innerHTML = `
    <form id="f" novalidate>
      <div data-station-field="from"></div>
      <button type="button" data-swap>swap</button>
      <div data-station-field="to"></div>
      <input name="date" type="date">
      <p data-date-error hidden></p>
      <button type="submit">Search</button>
    </form>`;
  form = document.getElementById("f") as HTMLFormElement;
  submitted = [];
  search = initSearchForm(form, {
    source: mockStationSource,
    onSubmit: (values) => void submitted.push(values),
    today: () => "2026-10-19",
  });
});

afterEach(() => {
  search.from.destroy();
  search.to.destroy();
  document.body.replaceChildren();
});

/** Types a query into a field and picks the suggestion whose code matches. */
async function pick(field: SearchForm["from"], query: string, code: string) {
  await type(field.input, query);
  const option = options(field.element).find((o) => o.textContent?.includes(code));
  if (!option) throw new Error(`No suggestion for ${code}`);
  mouseDown(option);
}

async function submit() {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

const errorOf = (field: SearchForm["from"]) => field.element.querySelector<HTMLElement>(".station-error")!;

describe("search form", () => {
  test("defaults the date to today and blocks past dates", () => {
    expect(search.dateInput.value).toBe("2026-10-19");
    expect(search.dateInput.min).toBe("2026-10-19");
  });

  test("submits the selected station codes, not the typed text", async () => {
    await pick(search.from, "new del", "NDLS");
    await pick(search.to, "chennai cen", "MAS");
    search.dateInput.value = "2026-10-25";
    await submit();

    expect(submitted).toEqual([{ from: "NDLS", to: "MAS", date: "2026-10-25" }]);
  });

  test("prevents submission when either station is unselected", async () => {
    await submit();
    expect(submitted).toHaveLength(0);
    expect(errorOf(search.from).hidden).toBe(false);
    expect(errorOf(search.to).hidden).toBe(false);
    expect(search.from.input.getAttribute("aria-invalid")).toBe("true");

    await pick(search.from, "pune", "PUNE");
    await submit();
    expect(submitted).toHaveLength(0);
    expect(errorOf(search.from).hidden).toBe(true);
    expect(errorOf(search.to).textContent).toContain("destination");
  });

  test("typed text that was never picked from the suggestions does not count", async () => {
    await pick(search.from, "pune", "PUNE");
    await type(search.to.input, "Chennai Central"); // exact name, but not chosen
    await submit();
    expect(submitted).toHaveLength(0);
    expect(search.to.getSelected()).toBeNull();
  });

  test("clears the error once a station is selected", async () => {
    await submit();
    await pick(search.from, "pune", "PUNE");
    expect(errorOf(search.from).hidden).toBe(true);
  });

  test("prevents the same station as source and destination", async () => {
    await pick(search.from, "new del", "NDLS");

    // It is offered but disabled in the other field.
    await type(search.to.input, "new del");
    const [option] = options(search.to.element);
    expect(option!.getAttribute("aria-disabled")).toBe("true");
    mouseDown(option!);
    expect(search.to.getSelected()).toBeNull();

    // And the form rejects it even if both were somehow set.
    search.to.setSelected(search.from.getSelected());
    await submit();
    expect(submitted).toHaveLength(0);
    expect(errorOf(search.to).textContent).toContain("different");
  });

  test("swaps the selected stations and their displayed values", async () => {
    await pick(search.from, "new del", "NDLS");
    await pick(search.to, "chennai cen", "MAS");

    search.swap();
    expect(search.from.getSelected()?.id).toBe("MAS");
    expect(search.to.getSelected()?.id).toBe("NDLS");
    expect(search.from.input.value).toBe("Chennai Central");
    expect(search.to.input.value).toBe("New Delhi");

    form.querySelector<HTMLButtonElement>("[data-swap]")!.click(); // swap back via the button
    expect(search.from.getSelected()?.id).toBe("NDLS");

    search.swap();
    search.dateInput.value = "2026-10-25";
    await submit();
    expect(submitted).toEqual([{ from: "MAS", to: "NDLS", date: "2026-10-25" }]);
  });

  test("swapping with one side empty moves the selection across", async () => {
    await pick(search.from, "pune", "PUNE");
    search.swap();
    expect(search.from.getSelected()).toBeNull();
    expect(search.from.input.value).toBe("");
    expect(search.to.getSelected()?.id).toBe("PUNE");
  });

  test("rejects a missing or past date", async () => {
    await pick(search.from, "new del", "NDLS");
    await pick(search.to, "pune", "PUNE");
    search.dateInput.value = "2026-10-01";
    await submit();
    expect(submitted).toHaveLength(0);
    expect(form.querySelector<HTMLElement>("[data-date-error]")!.hidden).toBe(false);

    search.dateInput.value = "";
    await submit();
    expect(submitted).toHaveLength(0);
  });
});
