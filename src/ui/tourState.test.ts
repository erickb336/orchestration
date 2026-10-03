// The tour: its seen-state (blocked storage never breaks the page and never loops the tour) and its stops.

import { describe, expect, it } from "vitest";
import { parseRoute } from "./route";
import { TOUR_DONE, TOUR_KEY, TOUR_STOPS, TOUR_TASK_ID, createTourGate, demoLandingRedirect, readTourDone, tourNeedsNavigation, writeTourDone, type KeyValueStore } from "./tourState";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwing: KeyValueStore = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
};

describe("the tour's seen-state", () => {
  it("starts once on a first visit to the demo, records done, and does not start again", () => {
    const store = memoryStore();
    const gate = createTourGate(() => store);
    expect(gate.shouldAutoStart(true)).toBe(true);
    // The same page load never starts it twice.
    expect(gate.shouldAutoStart(true)).toBe(false);
    gate.markDone();
    expect(store.data[TOUR_KEY]).toBe(TOUR_DONE);
    // The next load reads the record and stays quiet.
    expect(createTourGate(() => store).shouldAutoStart(true)).toBe(false);
    expect(readTourDone(() => store)).toBe(true);
  });

  it("never starts outside the demo", () => {
    const gate = createTourGate(() => memoryStore());
    expect(gate.shouldAutoStart(false)).toBe(false);
    // Real mode did not consume the one start: switching to the demo in the same load may still start it once.
    expect(gate.shouldAutoStart(true)).toBe(true);
  });

  it("storage that throws means no crash, at most one start per load, and a done mark that still holds in memory", () => {
    const gate = createTourGate(() => throwing);
    expect(gate.shouldAutoStart(true)).toBe(true);
    expect(gate.shouldAutoStart(true)).toBe(false);
    expect(() => gate.markDone()).not.toThrow();
    expect(gate.shouldAutoStart(true)).toBe(false);
    expect(readTourDone(() => throwing)).toBe(false);
    expect(writeTourDone(() => throwing)).toBe(false);
    // An accessor that itself throws (for example a sandboxed frame) is handled too.
    const broken = () => {
      throw new Error("no storage");
    };
    expect(readTourDone(broken)).toBe(false);
    expect(writeTourDone(broken)).toBe(false);
    expect(createTourGate(broken).shouldAutoStart(true)).toBe(true);
  });

  it("a missing store is treated like an empty one", () => {
    expect(readTourDone(() => undefined)).toBe(false);
    expect(writeTourDone(() => undefined)).toBe(false);
    const gate = createTourGate(() => undefined);
    expect(gate.shouldAutoStart(true)).toBe(true);
    expect(gate.started()).toBe(true);
  });

  it("the demo's bare address goes to the Overview, where the tour starts, before and after the tour; nothing else is redirected", () => {
    for (const hash of ["", "#", "#/"]) expect(demoLandingRedirect(true, hash), hash).toBe("#/overview");
    // A link to any page is left alone, and real mode never redirects.
    expect(demoLandingRedirect(true, "#/tasks")).toBeUndefined();
    expect(demoLandingRedirect(true, "#/task/WT-002")).toBeUndefined();
    expect(demoLandingRedirect(false, "")).toBeUndefined();
  });
});

/** The screen files as source text, to check that each stop's element is rendered by some screen. */
const screenSources = Object.values(import.meta.glob<string>(["./**/*.tsx", "!./**/*.test.tsx"], { query: "?raw", import: "default", eager: true })).join("\n");

describe("the tour's stops", () => {
  it("are six or seven short stops in the order a first visitor needs, each one or two plain sentences", () => {
    expect(TOUR_STOPS.length).toBeGreaterThanOrEqual(6);
    expect(TOUR_STOPS.length).toBeLessThanOrEqual(7);
    expect(TOUR_STOPS.map((s) => s.title)).toEqual(["This is a demo", "Needs you", "The factory", "Message the lead", "A task's steps", "Results", "How involved you are"]);
    // It opens on the demo bar: the visitor learns first that everything is simulated.
    expect(TOUR_STOPS[0]).toMatchObject({ element: '[data-tour="demo-bar"]', page: "#/overview" });
    expect(TOUR_STOPS[0].text).toMatch(/simulated/);
    for (const s of TOUR_STOPS) {
      const sentences = s.text.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length, s.title).toBeGreaterThanOrEqual(1);
      expect(sentences.length, s.title).toBeLessThanOrEqual(2);
      expect(s.text.length, s.title).toBeLessThanOrEqual(200);
      // Plain words: no run ids, no internal names.
      expect(s.text, s.title).not.toMatch(/\brun-\d+|\bstage\b|\bworker\b|\bruntime\b/);
    }
    // The last stop says where to replay it.
    expect(TOUR_STOPS.at(-1)!.text).toMatch(/Replay this tour from the Simulation menu/);
  });

  it("each stop points at an element a screen renders, on a page that exists", () => {
    for (const s of TOUR_STOPS) {
      const anchor = /^\[data-tour="([a-z-]+)"\]$/.exec(s.element)?.[1];
      const id = /^#([a-z-]+)$/.exec(s.element)?.[1];
      expect(anchor ?? id, s.element).toBeDefined();
      // A data-tour attribute in a screen (the tabs carry theirs as `tour: "…"`), or a Settings card's id.
      if (anchor) expect(screenSources.includes(`data-tour="${anchor}"`) || screenSources.includes(`tour: "${anchor}"`), anchor).toBe(true);
      if (id) expect(screenSources.includes(`id="${id}"`), id).toBe(true);
      if (s.page) expect(s.page.startsWith("#/"), s.page).toBe(true);
    }
    expect(TOUR_STOPS.map((s) => s.page && parseRoute(s.page))).toEqual([{ page: "overview" }, { page: "overview" }, { page: "overview" }, undefined, { page: "task", id: TOUR_TASK_ID }, { page: "review" }, { page: "settings" }]);
  });

  it("opens a stop's page only when it is not shown already", () => {
    const home = { page: "#/overview" };
    expect(tourNeedsNavigation("#/overview", home, true)).toBe(false);
    expect(tourNeedsNavigation("#/tasks", home, false)).toBe(true);
    // The Results tab is in the header on every page, so the page itself decides.
    expect(tourNeedsNavigation("#/task/WT-002", { page: "#/results" }, true)).toBe(true);
    expect(tourNeedsNavigation("#/review", { page: "#/results" }, true)).toBe(false);
    // Settings open on another section: the card is not shown, so the stop's address opens it.
    expect(tourNeedsNavigation("#/settings/project/delivery", { page: "#/settings/working-style/involvement" }, false)).toBe(true);
    // A stop without a page (the lead's button, in the header) stays where you are.
    expect(tourNeedsNavigation("#/task/WT-002", {}, true)).toBe(false);
  });
});
