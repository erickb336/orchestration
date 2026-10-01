// ORC-017 §4: the tour's seen-state. Blocked storage never breaks the page and never loops the tour.

import { describe, expect, it } from "vitest";
import { TOUR_DONE, TOUR_KEY, createTourGate, firstVisitRedirect, readTourDone, writeTourDone, type KeyValueStore } from "./tourState";

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

  it("a first visit to the demo's bare address goes to the Overview, where the tour starts; nothing else is redirected", () => {
    const empty = () => memoryStore();
    for (const hash of ["", "#", "#/"]) expect(firstVisitRedirect(true, hash, empty), hash).toBe("#/overview");
    // A link to a page, a seen tour, real mode, or storage that throws (treated as not seen) decide the rest.
    expect(firstVisitRedirect(true, "#/tasks", empty)).toBeUndefined();
    expect(firstVisitRedirect(true, "#/task/WT-002", empty)).toBeUndefined();
    expect(firstVisitRedirect(true, "", () => memoryStore({ [TOUR_KEY]: TOUR_DONE }))).toBeUndefined();
    expect(firstVisitRedirect(false, "", empty)).toBeUndefined();
    expect(firstVisitRedirect(true, "", () => throwing)).toBe("#/overview");
  });
});
