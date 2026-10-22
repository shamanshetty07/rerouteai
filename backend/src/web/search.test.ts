import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mockRailData } from "../rail/mockTrains.ts";
import { findAlternativeJourneys } from "../rail/routeSearch.ts";
import { flush, mouseDown, options, type } from "../../test/dom.ts";

// search.ts wires the real page on import, so the tests load the page's own markup.
const realFetch = globalThis.fetch;
let journeys: unknown;
let calls: string[];
let respond: () => Promise<Response>;

const json = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));
const form = () => document.getElementById("search-form") as HTMLFormElement;
const status = () => document.getElementById("status")!;
const results = () => document.getElementById("results")!;

async function pick(id: string, query: string, code: string) {
  const input = document.getElementById(`${id}-input`) as HTMLInputElement;
  await type(input, query);
  mouseDown(options(input.closest(".station-field")!).find((o) => o.textContent?.includes(code))!);
}

async function submit() {
  form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

beforeAll(async () => {
  const html = await Bun.file(new URL("../../public/search.html", import.meta.url)).text();
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script[\s\S]*?<\/script>/, "");
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return respond();
  }) as unknown as typeof fetch;
  journeys = await findAlternativeJourneys(mockRailData, {
    sourceId: "HWH",
    destinationId: "AGC",
    date: "2026-10-20",
    earliestDeparture: "16:00",
  });
  await import("./search.ts");
  await pick("from", "howrah", "HWH");
  await pick("to", "agra", "AGC");
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  respond = json(200, journeys);
});

describe("search page wiring", () => {
  test("defaults to alternative journeys with its extra fields visible", () => {
    expect(form().querySelector<HTMLInputElement>('input[name="mode"]:checked')!.value).toBe("alternatives");
    for (const f of form().querySelectorAll<HTMLElement>("[data-alt-only]")) expect(f.hidden).toBe(false);
  });

  test("submits stations, date, time and maxTransfers to /trains/alternatives and renders the legs", async () => {
    await submit();
    const url = new URL(calls[0]!, "http://x");
    expect(url.pathname).toBe("/trains/alternatives");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ from: "HWH", to: "AGC", maxTransfers: "2" });
    expect(url.searchParams.get("time")).toMatch(/^\d\d:\d\d$/);
    expect(status().textContent).toBe("1 journey option, best first");
    expect(results().querySelector(".transfer")!.textContent).toContain("Change at New Delhi");
  });

  test("keeps the previous results, dimmed, while a new search is running", async () => {
    await submit();
    expect(results().querySelectorAll(".journey")).toHaveLength(1);

    let finish!: (r: Response) => void;
    respond = () => new Promise((resolve) => (finish = resolve));
    await submit();
    expect(status().textContent).toBe("Searching…");
    expect(results().getAttribute("aria-busy")).toBe("true");
    expect(results().querySelectorAll(".journey")).toHaveLength(1);
    expect((document.getElementById("submit") as HTMLButtonElement).disabled).toBe(true);

    finish(new Response(JSON.stringify({ journeys: [], warnings: [] })));
    await flush();
    expect(results().hasAttribute("aria-busy")).toBe(false);
    expect(results().querySelectorAll(".journey")).toHaveLength(0);
    expect(status().textContent).toContain("No journeys found");
  });

  test("shows the server's message for a 400", async () => {
    respond = json(400, { error: "Invalid time" });
    await submit();
    expect(status().textContent).toBe("Invalid time");
    expect(status().className).toBe("error");
  });

  test("a 401 shows a sign-in group and a sign-up group, each linking to the right provider and mode", async () => {
    respond = json(401, { error: "Not signed in" });
    await submit();
    expect(status().textContent).toBe("Please sign in to search trains.");

    const prompt = document.getElementById("auth-prompt")!;
    expect(prompt.hidden).toBe(false);
    const links = [...prompt.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Sign in with GitHub", "/auth/github/signin"],
      ["Sign in with Google", "/auth/google/signin"],
      ["Sign up with GitHub", "/auth/github/signup"],
      ["Sign up with Google", "/auth/google/signup"],
    ]);
  });

  test("the sign-in and sign-up choices are labelled groups that are distinguishable in text", () => {
    const prompt = document.getElementById("auth-prompt")!;
    expect(prompt.getAttribute("aria-label")).toBe("Sign in or sign up");
    const groups = [...prompt.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups.map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)!.textContent)).toEqual([
      "Already have an account?",
      "New to Reroute?",
    ]);
    // Sign-up links never share a label with sign-in links, so screen-reader users can tell them apart.
    const labels = [...prompt.querySelectorAll("a")].map((a) => a.textContent);
    expect(new Set(labels).size).toBe(labels.length);
    expect(prompt.querySelectorAll("a[href^='/auth/']")).toHaveLength(4); // real links: keyboard focusable by default
  });

  test("the sign-in prompt disappears when the next search starts", async () => {
    respond = json(401, { error: "Not signed in" });
    await submit();
    respond = json(200, journeys);
    await submit();
    expect(document.getElementById("auth-prompt")!.hidden).toBe(true);
    expect(document.getElementById("auth-prompt")!.children).toHaveLength(0);
  });

  test("a 503 offers Retry, which repeats the same search", async () => {
    respond = json(503, { error: "No schedule data" });
    await submit();
    expect(status().textContent).toContain("No schedule data. Please try again shortly.");
    const first = calls[0];

    respond = json(200, journeys);
    status().querySelector<HTMLButtonElement>(".retry")!.click();
    await flush();
    expect(calls).toEqual([first!, first!]);
    expect(results().querySelectorAll(".journey")).toHaveLength(1);
    expect(status().querySelector(".retry")).toBeNull();
  });

  test("network failure also offers Retry", async () => {
    respond = () => Promise.reject(new Error("down"));
    await submit();
    expect(status().textContent).toContain("Network error");
    expect(status().querySelector(".retry")).not.toBeNull();
  });

  test("direct mode hides the alternative-only fields and uses /trains/search", async () => {
    const direct = form().querySelector<HTMLInputElement>('input[name="mode"][value="direct"]')!;
    direct.checked = true;
    direct.dispatchEvent(new Event("change", { bubbles: true }));
    for (const f of form().querySelectorAll<HTMLElement>("[data-alt-only]")) expect(f.hidden).toBe(true);
    expect(results().children).toHaveLength(0);

    respond = json(200, { from: { name: "A" }, to: { name: "B" }, trains: [] });
    await submit();
    const url = new URL(calls[0]!, "http://x");
    expect(url.pathname).toBe("/trains/search");
    expect([...url.searchParams.keys()].sort()).toEqual(["date", "from", "to"]);
    expect(status().textContent).toContain("No direct trains");
  });
});
