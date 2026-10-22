import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "../../test/dom.ts";
import type { Journey } from "../rail/journey.ts";
import { mockRailData } from "../rail/mockTrains.ts";
import { findAlternativeJourneys } from "../rail/routeSearch.ts";
import type { SavedJourney } from "../journeys/types.ts";
import { deleteSavedJourney, listSavedJourneys, saveJourney, type Failure } from "./savedApi.ts";
import { createSaveFooter, initSavedView, type SavedApi } from "./savedView.ts";

let journey: Journey;
const savedOf = (id: string, j: Journey = journey): SavedJourney => ({
  id,
  savedAt: "2026-10-22T10:00:00.000Z",
  source: j.source,
  destination: j.destination,
  travelDate: "2026-10-20",
  journey: j,
});

beforeEach(async () => {
  journey = (await findAlternativeJourneys(mockRailData, { sourceId: "HWH", destinationId: "AGC", date: "2026-10-20", earliestDeparture: "16:00" })).journeys[0]!;
});
afterEach(() => document.body.replaceChildren());

const reply = (status: number, body?: unknown) => async () => new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("saved-journeys API client", () => {
  test("save posts the journey as JSON and tells new saves from repeats", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ journey: savedOf("a") }), { status: 201 });
    };
    const out = await saveJourney(journey, fetchImpl);
    expect(out).toMatchObject({ kind: "saved", alreadySaved: false });
    expect(seen!.url).toBe("/journeys/saved");
    expect(seen!.init!.method).toBe("POST");
    expect(JSON.parse(String(seen!.init!.body))).toEqual({ journey });
    expect((await saveJourney(journey, async () => new Response(JSON.stringify({ journey: savedOf("a") }), { status: 200 })))).toMatchObject({ alreadySaved: true });
  });

  test("maps 401, 429, 400/409 and failures to values, and never throws", async () => {
    expect(await saveJourney(journey, reply(401, { error: "Not signed in" }))).toEqual({ kind: "unauthorized" });
    expect(await saveJourney(journey, reply(429, {}))).toEqual({ kind: "rate-limited" });
    expect(await saveJourney(journey, reply(409, { error: "You can save at most 100 journeys. Remove one first." }))).toEqual({
      kind: "rejected",
      status: 409,
      message: "You can save at most 100 journeys. Remove one first.",
    });
    expect((await saveJourney(journey, reply(500, { error: "SQL detail" }))) as Failure).toEqual({ kind: "error", message: "Couldn't save this journey. Please try again." });
    expect(await saveJourney(journey, async () => Promise.reject(new Error("down")))).toEqual({ kind: "error", message: "Network error, please try again." });
    expect((await saveJourney(journey, async () => new Response("<html>", { status: 201 }))).kind).toBe("error");
  });

  test("list and delete use the right URLs and treat an already-missing journey as deleted", async () => {
    const urls: string[] = [];
    const record = (status: number, body?: unknown) => async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    };
    expect(await listSavedJourneys(record(200, { journeys: [savedOf("a")] }))).toMatchObject({ kind: "ok" });
    expect(await deleteSavedJourney("id/with?odd chars", record(204))).toEqual({ kind: "deleted" });
    expect(await deleteSavedJourney("x", record(404, { error: "Saved journey not found" }))).toEqual({ kind: "deleted" });
    expect(await deleteSavedJourney("x", record(500))).toMatchObject({ kind: "error" });
    expect(urls[0]).toBe("GET /journeys/saved");
    expect(urls[1]).toBe("DELETE /journeys/saved/id%2Fwith%3Fodd%20chars");
    expect((await listSavedJourneys(reply(401))).kind).toBe("unauthorized");
  });
});

describe("Save button", () => {
  const mount = (api: Pick<SavedApi, "save">, onUnauthorized?: () => void) => {
    const footer = createSaveFooter(journey, { api, ...(onUnauthorized && { onUnauthorized }) });
    document.body.append(footer);
    return { button: footer.querySelector("button")!, note: footer.querySelector<HTMLElement>("[role=status]")! };
  };

  test("is labelled for assistive tech and shows saving, then saved", async () => {
    let finish!: (o: Awaited<ReturnType<SavedApi["save"]>>) => void;
    const { button, note } = mount({ save: () => new Promise((resolve) => (finish = resolve)) });
    expect(button.getAttribute("aria-label")).toBe("Save journey Howrah Junction to Agra Cantt");
    expect(button.textContent).toBe("Save journey");

    button.click();
    expect(button.textContent).toBe("Saving…");
    expect(button.disabled).toBe(true);

    finish({ kind: "saved", saved: savedOf("a"), alreadySaved: false });
    await flush();
    expect(button.textContent).toBe("Saved ✓");
    expect(button.disabled).toBe(true);
    expect(note.textContent).toContain("Saved");
  });

  test("a repeat save says it was already saved", async () => {
    const { button, note } = mount({ save: async () => ({ kind: "saved", saved: savedOf("a"), alreadySaved: true }) });
    button.click();
    await flush();
    expect(note.textContent).toBe("Already in your saved journeys.");
  });

  test("failures re-enable the button as Try again, with a message and no raw details", async () => {
    let attempt = 0;
    const { button, note } = mount({ save: async () => (++attempt === 1 ? { kind: "error", message: "Network error, please try again." } : { kind: "saved", saved: savedOf("a"), alreadySaved: false }) });
    button.click();
    await flush();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Try again");
    expect(note.textContent).toBe("Network error, please try again.");
    expect(note.classList.contains("error")).toBe(true);
    button.click();
    await flush();
    expect(button.textContent).toBe("Saved ✓");
  });

  test("a 401 asks the page to show its sign-in prompt and keeps the button usable", async () => {
    let asked = 0;
    const { button, note } = mount({ save: async () => ({ kind: "unauthorized" }) }, () => asked++);
    button.click();
    await flush();
    expect(asked).toBe(1);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Save journey");
    expect(note.textContent).toBe("Please sign in to continue.");
  });

  test("rate limiting and server rejections have their own messages", async () => {
    const limited = mount({ save: async () => ({ kind: "rate-limited" }) });
    limited.button.click();
    await flush();
    expect(limited.note.textContent).toContain("Wait a moment");
    const full = mount({ save: async () => ({ kind: "rejected", status: 409, message: "You can save at most 100 journeys. Remove one first." }) });
    full.button.click();
    await flush();
    expect(full.note.textContent).toBe("You can save at most 100 journeys. Remove one first.");
  });
});

describe("Saved journeys view", () => {
  let status: HTMLElement;
  let list: HTMLElement;
  let authPrompt: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `<p id="s" role="status"></p><section id="p" hidden></section><div id="l"></div>`;
    status = document.getElementById("s")!;
    list = document.getElementById("l")!;
    authPrompt = document.getElementById("p")!;
  });

  const view = (api: Partial<SavedApi>) =>
    initSavedView({ status, list, authPrompt }, { list: async () => ({ kind: "ok", journeys: [] }), remove: async () => ({ kind: "deleted" }), ...api });

  test("shows a loading state, then the journeys in the order returned", async () => {
    let finish!: (o: Awaited<ReturnType<SavedApi["list"]>>) => void;
    const v = view({ list: () => new Promise((resolve) => (finish = resolve)) });
    const pending = v.load();
    expect(status.textContent).toBe("Loading saved journeys…");
    expect(list.getAttribute("aria-busy")).toBe("true");

    finish({ kind: "ok", journeys: [savedOf("first"), savedOf("second")] });
    await pending;
    expect(status.textContent).toBe("2 saved journeys, newest first");
    expect(list.hasAttribute("aria-busy")).toBe(false);
    const cards = [...list.querySelectorAll("article.journey")];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector("h3")!.textContent).toBe("Howrah Junction → Agra Cantt");
    expect(cards[0]!.textContent).toContain("12301 Howrah - New Delhi Rajdhani Express");
    expect(cards[0]!.textContent).toContain("Change at New Delhi");
    expect(cards[0]!.textContent).toContain("Travel date 20 Oct 2026");
    expect(cards[0]!.textContent).toContain("Saved 22 Oct 2026");
  });

  test("an empty list shows a helpful empty state", async () => {
    await view({}).load();
    expect(status.textContent).toContain("haven't saved any journeys yet");
    expect(list.children).toHaveLength(0);
  });

  test("a single journey uses the singular", async () => {
    await view({ list: async () => ({ kind: "ok", journeys: [savedOf("a")] }) }).load();
    expect(status.textContent).toBe("1 saved journey, newest first");
  });

  test("401 shows the sign-in and sign-up choices instead of the list", async () => {
    await view({ list: async () => ({ kind: "unauthorized" }) }).load();
    expect(status.textContent).toBe("Please sign in to see your saved journeys.");
    expect(authPrompt.hidden).toBe(false);
    expect([...authPrompt.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/auth/github/signin",
      "/auth/google/signin",
      "/auth/github/signup",
      "/auth/google/signup",
    ]);
  });

  test("a failure offers Retry, which reloads, and hides the sign-in panel again", async () => {
    let calls = 0;
    const v = view({ list: async () => (++calls === 1 ? { kind: "error", message: "Network error, please try again." } : { kind: "ok", journeys: [savedOf("a")] }) });
    await v.load();
    expect(status.className).toBe("error");
    expect(status.textContent).toContain("Network error, please try again.");
    status.querySelector<HTMLButtonElement>(".retry")!.click();
    await flush();
    expect(status.textContent).toBe("1 saved journey, newest first");
    expect(list.querySelectorAll("article")).toHaveLength(1);
    expect(authPrompt.hidden).toBe(true);
  });

  test("Remove takes two steps: the first click only asks for confirmation, Cancel backs out", async () => {
    const removed: string[] = [];
    await view({ list: async () => ({ kind: "ok", journeys: [savedOf("a")] }), remove: async (id) => (removed.push(id), { kind: "deleted" }) }).load();
    const [remove, cancel] = list.querySelectorAll<HTMLButtonElement>(".journey-actions button");
    expect(remove!.getAttribute("aria-label")).toBe("Remove saved journey Howrah Junction to Agra Cantt");
    remove!.click();
    expect(remove!.textContent).toBe("Confirm remove");
    expect(cancel!.hidden).toBe(false);
    expect(removed).toEqual([]);
    cancel!.click();
    expect(remove!.textContent).toBe("Remove");
    expect(cancel!.hidden).toBe(true);
    expect(removed).toEqual([]);
  });

  test("confirming removes the card, updates the count, and ends in the empty state", async () => {
    const removed: string[] = [];
    await view({
      list: async () => ({ kind: "ok", journeys: [savedOf("a"), savedOf("b")] }),
      remove: async (id) => (removed.push(id), { kind: "deleted" }),
    }).load();
    const click = async (index: number) => {
      const [remove] = list.querySelectorAll<HTMLButtonElement>("article")[index]!.querySelectorAll<HTMLButtonElement>(".journey-actions button");
      remove!.click();
      remove!.click();
      await flush();
    };
    await click(0);
    expect(removed).toEqual(["a"]);
    expect(list.querySelectorAll("article")).toHaveLength(1);
    expect(status.textContent).toBe("Journey removed. 1 saved.");
    await click(0);
    expect(removed).toEqual(["a", "b"]);
    expect(list.querySelectorAll("article")).toHaveLength(0);
    expect(status.textContent).toContain("haven't saved any journeys yet");
  });

  test("a failed removal keeps the card and explains why, ready to try again", async () => {
    await view({
      list: async () => ({ kind: "ok", journeys: [savedOf("a")] }),
      remove: async () => ({ kind: "error", message: "Network error, please try again." }),
    }).load();
    const [remove] = list.querySelectorAll<HTMLButtonElement>(".journey-actions button");
    remove!.click();
    remove!.click();
    await flush();
    expect(list.querySelectorAll("article")).toHaveLength(1);
    expect(remove!.disabled).toBe(false);
    expect(remove!.textContent).toBe("Remove");
    expect(list.querySelector(".action-note")!.textContent).toBe("Network error, please try again.");
  });

  test("a 401 while removing shows the sign-in panel", async () => {
    await view({ list: async () => ({ kind: "ok", journeys: [savedOf("a")] }), remove: async () => ({ kind: "unauthorized" }) }).load();
    const [remove] = list.querySelectorAll<HTMLButtonElement>(".journey-actions button");
    remove!.click();
    remove!.click();
    await flush();
    expect(authPrompt.hidden).toBe(false);
    expect(status.textContent).toBe("Please sign in to manage your saved journeys.");
  });

  test("journey text is rendered as text, never as HTML", async () => {
    const hostile = { ...journey, source: { ...journey.source, name: "<img src=x onerror=alert(1)>" } };
    await view({ list: async () => ({ kind: "ok", journeys: [savedOf("a", hostile as Journey)] }) }).load();
    expect(list.querySelector("img")).toBeNull();
    expect(list.querySelector("h3")!.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("overlapping loads do not double-render", async () => {
    let resolveList!: (o: Awaited<ReturnType<SavedApi["list"]>>) => void;
    let calls = 0;
    const v = view({ list: () => (calls++, new Promise((resolve) => (resolveList = resolve))) });
    const first = v.load();
    void v.load();
    resolveList({ kind: "ok", journeys: [savedOf("a")] });
    await first;
    expect(calls).toBe(1);
    expect(list.querySelectorAll("article")).toHaveLength(1);
  });
});
