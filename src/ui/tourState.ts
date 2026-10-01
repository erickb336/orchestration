// ORC-017 §4: whether the first-run tour has been seen. The record is a per-viewer convenience in
// browser storage (see Tour.tsx for the tour itself); every access is wrapped, so blocked storage never breaks the page. When storage
// throws, the tour may start once per page load and never loops.

export const TOUR_KEY = "orc.tour.v1";
export const TOUR_DONE = "done";

/** The subset of Storage the tour uses, so a test can hand in one that throws. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True when the record says done. A store that is missing or throws counts as "not seen". */
export function readTourDone(store: () => KeyValueStore | undefined): boolean {
  try {
    return store()?.getItem(TOUR_KEY) === TOUR_DONE;
  } catch {
    return false;
  }
}

/** Record "done". Returns whether the record was written; a store that throws is not an error for the page. */
export function writeTourDone(store: () => KeyValueStore | undefined): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(TOUR_KEY, TOUR_DONE);
    return true;
  } catch {
    return false;
  }
}

export interface TourGate {
  /** Whether the tour should start by itself now: demo only, not yet done, and at most once per page load. */
  shouldAutoStart(demo: boolean): boolean;
  /** Skip, Esc and Done all end here. Kept in memory as well, so a store that throws still stops the auto start. */
  markDone(): void;
  /** Whether this load has recorded a start or a completion. */
  started(): boolean;
}

export function createTourGate(store: () => KeyValueStore | undefined): TourGate {
  let started = false;
  let done = false;
  return {
    shouldAutoStart(demo) {
      if (!demo || started || done) return false;
      if (readTourDone(store)) {
        done = true;
        return false;
      }
      started = true;
      return true;
    },
    markDone() {
      done = true;
      started = true;
      writeTourDone(store);
    },
    started: () => started || done,
  };
}

/** The bare address ("", "#", "#/"): a visit that names no page. Only such a visit is sent to the Overview for the tour. */
export function isLandingHash(hash: string): boolean {
  return hash === "" || hash === "#" || hash === "#/";
}

/**
 * Where a visit to the demo's bare address goes: the Overview, where Progress by area and the tour live (before
 * and after the tour). A link to any page, and real mode, are left alone.
 */
export function demoLandingRedirect(demo: boolean, hash: string): string | undefined {
  return demo && isLandingHash(hash) ? "#/overview" : undefined;
}

/** The browser's localStorage, when the page can reach it. The accessor itself may throw; callers wrap it. */
export const browserStore = (): KeyValueStore | undefined => (typeof window !== "undefined" ? window.localStorage : undefined);
