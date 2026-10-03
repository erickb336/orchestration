// The first-run tour's stops, and whether the tour has been seen. The record is a per-viewer convenience in
// browser storage (see Tour.tsx for the tour itself); every access is wrapped, so blocked storage never breaks the page. When storage
// throws, the tour may start once per page load and never loops.

import { parseRoute } from "./route";

/** One stop: the element it points at, the page it is on, and one or two plain sentences. */
export interface TourStop {
  /** A CSS selector: a `data-tour` attribute, or a Settings card's own id. */
  element: string;
  /** The page the stop shows (a hash). Without one, the stop stays on whichever page is open. */
  page?: string;
  title: string;
  text: string;
  /** Where the popover lines up under the element: its start (default) or, for one at the right edge, its end. */
  align?: "start" | "end";
}

/** The running task whose steps the tour opens. */
export const TOUR_TASK_ID = "WT-002";

/** Seven stops over the screens a first visitor needs: Home, the lead, a task page, Results and Settings. */
export const TOUR_STOPS: TourStop[] = [
  { element: '[data-tour="demo-bar"]', page: "#/overview", title: "This is a demo", text: "A sample project, and everything in it is simulated: no agents run, and nothing leaves this computer." },
  { element: '[data-tour="needs-you"]', page: "#/overview", title: "Needs you", text: "Only the decisions that need you, answered right here: choose an approach, decide a finding, merge a pull request." },
  { element: '[data-tour="progress"]', page: "#/overview", title: "The factory", text: "One line per area: each task at its step, from building to landed. Above it, the budgets." },
  { element: '[data-tour="lead"]', align: "end", title: "Message the lead", text: "Your main channel, from any page: ask what is running, change the focus, or have it pass a note to a running coder. Every change it makes has an Undo." },
  { element: '[data-tour="steps"]', page: `#/task/${TOUR_TASK_ID}`, title: "A task's steps", text: "A task runs as steps in plain words, each a fresh agent given only the inputs and principles it needs. From here you can pause the task or send a note to the running step." },
  { element: '[data-tour="tab-results"]', page: "#/results", title: "Results", text: "What landed waits here for you to look at, at your own pace. Merge a ready pull request, mark a result as seen, or send it back." },
  { element: "#involvement", page: "#/settings/working-style/involvement", title: "How involved you are", text: "Choose how much the lead does on its own: Autopilot, Check-in or Manual. Replay this tour from the Simulation menu." },
];

/**
 * Whether going to a stop needs a navigation first: its page is another page than the one open, or the page is
 * open but does not show the stop's element (another Settings section). A stop without a page never navigates.
 */
export function tourNeedsNavigation(currentHash: string, stop: Pick<TourStop, "page">, elementShown: boolean): boolean {
  if (!stop.page) return false;
  return parseRoute(currentHash).page !== parseRoute(stop.page).page || !elementShown;
}

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

/** The browser's localStorage, when the page can reach it. The accessor itself may throw; callers wrap it. */
export const browserStore = (): KeyValueStore | undefined => (typeof window !== "undefined" ? window.localStorage : undefined);
