// The Tasks page and the Activity page. The words come from pure helpers (tasksView.ts,
// activityView.ts), checked over the seed and the demo; the screens are rendered through react-dom/server over a
// fake store, as in home.test.tsx (there is no DOM test environment in this repository).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../api";
import { buildDemo } from "../domain/demo";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import type { State } from "../domain/types";
import { Activity } from "./Activity";
import { ACTOR_LABEL, KINDS, KIND_LABEL, activityHash, eventText, filterEvents, taskFromHash, taskOptions } from "./activityView";
import { Board, TaskCard } from "./Board";
import { ConfirmProvider } from "./kit";
import { StoreContext, type ServiceStore } from "./store";
import { GROUPS, GROUP_LABEL, ago, cardLine, cardState, groupOf, lineText, plainReason, prWords } from "./tasksView";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const line = (s: State, id: string, now = T0) => lineText(cardLine(s, task(s, id), now));

const service = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  startedAt: at(0),
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "normal" },
  dbPath: "/tmp/orchestration-test.db",
  providers: { claude: { label: "Claude", capabilities: {} as never }, codex: { label: "Codex", capabilities: {} as never } },
  ...over,
});

function store(state: State, svc: ServiceInfo = service()): ServiceStore {
  const noop = async () => ({ ok: true as const });
  return {
    state,
    version: 1,
    service: svc,
    status: "online",
    disabled: false,
    loadFailed: false,
    confirmedAt: null,
    retry: () => {},
    send: noop,
    setSim: async () => true,
    refreshHealth: async () => true,
    step: async () => true,
    reset: async () => true,
    postJson: async () => ({ ok: true as const, body: null }),
    uploadVisionDoc: async () => ({ ok: false as const, error: "test" }),
    notice: null,
    setNotice: () => {},
  } as unknown as ServiceStore;
}

const render = (node: React.ReactElement, s: ServiceStore) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={s}>{node}</StoreContext.Provider>
    </ConfirmProvider>,
  );

describe("the groups", () => {
  it("puts Needs you first, as a group and a Status option, and each task in exactly one group", () => {
    expect(GROUPS[0]).toBe("needs-you");
    expect(GROUP_LABEL["needs-you"]).toBe("Needs you");
    expect(GROUPS.slice(1)).toEqual(M.BOARD_COLUMNS);
    const demo = buildDemo(T0);
    const groups = Object.fromEntries(demo.tasks.map((t) => [t.id, groupOf(demo, t, T0)]));
    // The finding that waits for you and the two-option task, wherever their columns are.
    expect(Object.keys(groups).filter((id) => groups[id] === "needs-you")).toEqual(["WT-007", "WT-004.3"]);
    expect(groups["WT-001"]).toBe("done");
    expect(groups["WT-009"]).toBe("paused");
    expect(groups["WT-010"]).toBe("deferred");
    const seed = buildSeed(T0);
    expect(groupOf(seed, task(seed, "EX-004"), T0)).toBe("needs-you");
    expect(groupOf(seed, task(seed, "EX-001"), T0)).toBe("running");
    expect(groupOf(seed, task(seed, "EX-002"), T0)).toBe("reviewing");
  });
});

describe("the card's one line", () => {
  it("says what an agent is doing, with the provider and the step", () => {
    const s = buildSeed(T0);
    expect(cardLine(s, task(s, "EX-001"), T0)).toEqual({ text: "Implementing · Codex · step 2 of 9", tone: "work", provider: "codex" });
    expect(line(s, "EX-002")).toBe("Reviewing · Claude · step 3 of 7");
  });

  it("says what waits for you, in the reader's words", () => {
    const demo = buildDemo(T0);
    expect(line(demo, "WT-007")).toBe("Waiting for your decision");
    expect(line(demo, "WT-004.3")).toBe("Waiting for you to choose an approach");
    const one = buildSeed(T0);
    const ex4 = task(one, "EX-004");
    M.currentSpec(ex4).content.options = M.currentSpec(ex4).content.options.filter((o) => o.id === M.currentSpec(ex4).content.selectedOptionId);
    expect(line(one, "EX-004")).toBe("Waiting for your go-ahead");
    expect(cardLine(one, ex4, T0).tone).toBe("you");
  });

  it("says why nothing moves: up next, paused, deferred, waiting for another task", () => {
    const idle = buildSeed(T0, { inFlightRuns: false });
    expect(line(idle, "EX-001")).toBe("Up next: step 2 of 9 · Implement");
    expect(line(idle, "EX-005")).toBe("Paused before it started");
    expect(line(idle, "EX-007")).toBe("Waiting for EX-002");
    expect(line(idle, "EX-003")).toBe("Not started · 3 steps");
    const demo = buildDemo(T0);
    expect(line(demo, "WT-009")).toBe("Stopped at step 2 of 8 · Fix");
    expect(line(demo, "WT-010")).toBe("The lead deferred it: It needs a connection anyway, and offline maps comes first.");
    expect(line(demo, "WT-004")).toBe("Waiting for 2 child tasks");
  });

  it("never shows an event message, a run id, a model id or a spec revision", () => {
    for (const s of [buildSeed(T0), buildSeed(T0, { inFlightRuns: false }), buildDemo(T0)]) {
      for (const t of s.tasks) {
        const text = lineText(cardLine(s, t, T0));
        expect(text, t.id).not.toMatch(/run-\d|lead-\d|msg-\d|cs-|sample-|\bspec r\d|\bS\d+\b|_/);
        expect(s.events.some((e) => e.message === text), t.id).toBe(false);
      }
    }
  });

  it("small words: ago, a blocked reason without its step id, a pull request's own label", () => {
    expect(ago(at(-20), T0)).toBe("just now");
    expect(ago(at(-60), T0)).toBe("1 minute ago");
    expect(ago(at(-5 * 60), T0)).toBe("5 minutes ago");
    expect(ago(at(-3 * 3600), T0)).toBe("3 hours ago");
    expect(ago(at(-2 * 86400), T0)).toBe("2 days ago");
    expect(plainReason("S2: Checks failed on the final change")).toBe("Checks failed on the final change");
    expect(plainReason("C1-i2: the sandbox is gone")).toBe("the sandbox is gone");
    expect(plainReason("Prerequisite WT-3 was cancelled")).toBe("Prerequisite WT-3 was cancelled");
    expect(prWords("PR #1001 merging next")).toBe("Pull request #1001: merging next");
    expect(prWords("PR preparing")).toBe("Pull request: preparing");
    expect(prWords("preparing pull request 2")).toBe("Preparing pull request 2");
  });
});

describe("a finished task", () => {
  it("is Done with at most one result chip: Landed (simulated in the demo) or Pull request waiting for you", () => {
    const demo = buildDemo(T0);
    const wt1 = task(demo, "WT-001");
    expect(cardState(demo, wt1, T0)).toMatchObject({ label: "Done", tone: "done" });
    expect(cardLine(demo, wt1, T0)).toMatchObject({ chip: { kind: "landed", label: "Landed", simulated: true }, text: "3 days ago" });
    expect(lineText(cardLine(demo, wt1, T0))).toBe("Landed 3 days ago");
    // Nothing to merge: no chip at all.
    expect(cardLine(demo, task(demo, "WT-013"), T0)).toEqual({ text: "Finished: nothing to merge", tone: "neutral" });
    // A pull request on its way is said in words, without a chip.
    const wt5 = cardLine(demo, task(demo, "WT-005"), T0);
    expect(wt5.chip).toBeUndefined();
    expect(wt5.text).toMatch(/^Pull request/);
    // A pull request that waits for your merge: Done, one chip, and the task is listed under Needs you.
    const ready = structuredClone(demo);
    const t = task(ready, "WT-005");
    t.integration = { ...t.integration!, status: "integrated", pr: { ...t.integration!.pr!, phase: "open", policy: "hold", attention: { code: "remote-diverged", message: "The branch on GitHub moved", since: at(0) } } };
    expect(cardState(ready, t, T0).label).toBe("Done");
    expect(cardLine(ready, t, T0)).toMatchObject({ chip: { kind: "pr", label: "Pull request waiting for you", simulated: true }, tone: "you" });
    expect(lineText(cardLine(ready, t, T0))).toBe("Pull request waiting for you (stopped on a problem)");
    expect(groupOf(ready, t, T0)).toBe("needs-you");
  });
});

describe("the card's state", () => {
  it("is a short word, and says Pausing until the runtime acknowledges the stop", () => {
    const s = buildSeed(T0);
    expect(cardState(s, task(s, "EX-001"), T0)).toEqual({ label: "Running", tone: "work", paused: false, pulse: true });
    expect(cardState(s, task(s, "EX-002"), T0).label).toBe("In review");
    expect(cardState(s, task(s, "EX-004"), T0)).toMatchObject({ label: "Needs you", tone: "you" });
    expect(cardState(s, task(s, "EX-005"), T0)).toMatchObject({ label: "Paused", paused: true });
    expect(cardState(s, task(s, "EX-003"), T0).label).toBe("Proposed");
    const pausing = M.pauseTask(s, "EX-001", at(1));
    expect(cardState(pausing, task(pausing, "EX-001"), T0)).toMatchObject({ label: "Pausing", tone: "work", pulse: true });
  });
});

describe("the Tasks page", () => {
  const demo = buildDemo(T0);
  const markup = render(<Board />, store(demo));

  it("lists Needs you first, then the columns, with no visit bookkeeping and no Role or Provider filter", () => {
    const needs = markup.indexOf(">Needs you</h2>");
    expect(needs).toBeGreaterThan(0);
    for (const h of [">Ready</h2>", ">Paused</h2>", ">Deferred</h2>", ">Done</h2>"]) expect(markup.indexOf(h)).toBeGreaterThan(needs);
    expect(markup).toContain('<option value="needs-you">Needs you</option>');
    for (const gone of ["since your last visit", "Mark all seen", "New decision", ">Role<", ">Provider<", "Changed since last visit", "badge-new"]) expect(markup).not.toContain(gone);
    for (const kept of [">Area<", ">Status<", ">Sort<"]) expect(markup).toContain(kept);
  });

  it("shows one plain line per card and no raw event text", () => {
    expect(markup).toContain("Waiting for your decision");
    expect(markup).toContain("Waiting for you to choose an approach");
    expect(markup).not.toMatch(/run-\d{3}|Dispatched|acknowledged stop|cs-lead/);
  });

  it("the board view names every column, empty ones narrow", () => {
    const board = renderBoard(demo);
    expect(board).toContain("tl-board");
    for (const g of GROUPS) expect(board).toContain(`>${GROUP_LABEL[g]}</h2>`);
    expect(board).toContain("tl-col tl-col--empty");
    expect(board).not.toContain("Empty:");
  });

  it("a card is one link to the task, with Done and one result chip for finished work", () => {
    const card = render(<TaskCard state={demo} task={task(demo, "WT-001")} nowMs={T0} />, store(demo));
    expect(card).toContain('href="#/task/WT-001"');
    expect(card).toContain(">Done<");
    expect(card).toContain(">Landed<");
    expect(card.match(/k-chip--sim/g)).toHaveLength(1);
    expect(card).not.toContain("review");
  });
});

/** The board view, as a person who chose it last time sees it (the view is a per-browser preference). */
function renderBoard(s: State): string {
  const prev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === "orchestration.view" ? "board" : null), setItem: () => {} };
  try {
    return render(<Board />, store(s));
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = prev;
  }
}

describe("the Activity page", () => {
  it("says who acted and the roles in words, and filters by task and kind", () => {
    expect(eventText("Dispatched S3 (code_reviewer) to Claude · claude-sample-large as run-1332 on spec r1")).toBe("Dispatched S3 (Code reviewer) to Claude · claude-sample-large as run-1332 on spec r1");
    expect(eventText("Dispatched S1 (coder) to Codex")).toBe("Dispatched S1 (Coder) to Codex");
    expect(eventText("Dispatched C1 (checks) to the service")).toBe("Dispatched C1 (Checks) to the service");
    expect(eventText("the ux_reviewer and security_reviewer agreed")).toBe("the UX reviewer and Security reviewer agreed");
    // A word that only looks like a role outside parentheses is left alone.
    expect(eventText("the lead checks the coder's work")).toBe("the lead checks the coder's work");
    expect(ACTOR_LABEL).toEqual({ user: "You", lead: "Lead", runtime: "Agent", system: "Service" });
    expect(KINDS).toHaveLength(10);
    for (const k of KINDS) expect(KIND_LABEL[k]).not.toMatch(/_/);
    expect(taskFromHash("#/activity?task=WT-004.1")).toBe("WT-004.1");
    expect(taskFromHash("#/activity")).toBe("");
    expect(activityHash("WT-004.1")).toBe("#/activity?task=WT-004.1");
    expect(activityHash("")).toBe("#/activity");
    const demo = buildDemo(T0);
    const mine = filterEvents(demo.events, "WT-007", "");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.taskId === "WT-007")).toBe(true);
    expect(mine[0].at >= mine[mine.length - 1].at).toBe(true);
    expect(filterEvents(demo.events, "", "decision").every((e) => e.kind === "decision")).toBe(true);
    const options = taskOptions(demo);
    expect(options.map((o) => o.value)).toContain("WT-007");
    expect(options.find((o) => o.value === "WT-007")?.label).toBe("WT-007 Make the trail map readable with VoiceOver");
  });

  it("renders the log in words, with a task filter", () => {
    const demo = buildDemo(T0);
    const markup = render(<Activity />, store(demo));
    expect(markup).toContain(">Task<");
    expect(markup).toContain(">All tasks<");
    expect(markup).toContain(">Service<");
    expect(markup).not.toMatch(/\((code|security|ux)_reviewer\)/);
    expect(markup).not.toContain("Append-only");
  });
});
