// ORC-018 §6: which done tasks fold under "Done earlier", and what is never hidden.

import { describe, expect, it } from "vitest";
import { buildSeed } from "../domain/seed";
import type { Landed, PrDelivery, State, Task, TaskOutcome } from "../domain/types";
import { DONE_COLLAPSE_MS, collapsesDone, settledAtOf, splitDone } from "./doneCollapse";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const base: State = buildSeed(NOW);
const seedDone = base.tasks.find((t) => t.lifecycle === "done")!;

/** A done task, settled `days` ago by its updatedAt, with the given overrides. */
function done(days: number, over: Partial<Task> = {}): Task {
  return { ...structuredClone(seedDone), lifecycle: "done", updatedAt: ago(days), controlFailure: undefined, integration: undefined, outcome: undefined, ...over };
}
const withTask = (t: Task): State => ({ ...base, tasks: base.tasks.map((x) => (x.id === t.id ? t : x)) });
const outcomeAt = (settledAt: string) => ({ ...({ v: 1, result: "done", settledAt } as Partial<TaskOutcome>) }) as TaskOutcome;
const landed = (status: Landed["status"]): Landed => ({ at: ago(10), via: "pr", target: "o/r main", commit: "a".repeat(40), by: "app", flags: [], status, notes: [], followUps: [] });
const pr = (phase: PrDelivery["phase"]): PrDelivery => ({ n: 1, phase } as unknown as PrDelivery);

describe("collapsesDone", () => {
  it("keeps a done task whose integration is in conflict, however old (review L8)", () => {
    const t = done(30, { integration: { status: "conflict" } as Task["integration"] });
    expect(collapsesDone(withTask(t), t, NOW)).toBe(false);
  });

  it("folds a done task settled more than 7 days ago, and keeps a recent one", () => {
    expect(collapsesDone(withTask(done(8)), done(8), NOW)).toBe(true);
    expect(collapsesDone(withTask(done(2)), done(2), NOW)).toBe(false);
    expect(DONE_COLLAPSE_MS).toBe(7 * DAY);
  });

  it("takes the settle time from the outcome when there is one", () => {
    const oldUpdate = done(20, { outcome: outcomeAt(ago(3)) });
    expect(settledAtOf(oldUpdate)).toBe(ago(3));
    expect(collapsesDone(withTask(oldUpdate), oldUpdate, NOW)).toBe(false);
    const oldOutcome = done(1, { outcome: outcomeAt(ago(9)) });
    expect(collapsesDone(withTask(oldOutcome), oldOutcome, NOW)).toBe(true);
  });

  it("is exactly 7 days: at the boundary the task stays", () => {
    const edge = done(7);
    expect(collapsesDone(withTask(edge), edge, NOW)).toBe(false);
    const past = done(7, { updatedAt: new Date(NOW - 7 * DAY - 1).toISOString() });
    expect(collapsesDone(withTask(past), past, NOW)).toBe(true);
  });

  it("never hides a task that needs you", () => {
    const t = done(30, { controlFailure: { kind: "stop-unacknowledged", attemptId: "a", at: ago(29), message: "x" } as Task["controlFailure"] });
    expect(collapsesDone(withTask(t), t, NOW)).toBe(false);
  });

  it("never hides a task whose pull request is open or built, and folds one that merged", () => {
    for (const phase of ["open", "built"] as const) {
      const t = done(30, { integration: { status: "integrated", pr: pr(phase) } });
      expect(collapsesDone(withTask(t), t, NOW), phase).toBe(false);
    }
    const merged = done(30, { integration: { status: "integrated", pr: pr("merged"), landed: landed("reviewed") } });
    expect(collapsesDone(withTask(merged), merged, NOW)).toBe(true);
  });

  it("never hides landed work you have not reviewed; a reviewed or sent-back one folds", () => {
    const unreviewed = done(30, { integration: { status: "integrated", landed: landed("unreviewed") } });
    expect(collapsesDone(withTask(unreviewed), unreviewed, NOW)).toBe(false);
    for (const status of ["reviewed", "sent-back"] as const) {
      const t = done(30, { integration: { status: "integrated", landed: landed(status) } });
      expect(collapsesDone(withTask(t), t, NOW), status).toBe(true);
    }
  });

  it("applies to done tasks only", () => {
    const cancelled = done(30, { lifecycle: "cancelled" });
    expect(collapsesDone(withTask(cancelled), cancelled, NOW)).toBe(false);
    const active = done(30, { lifecycle: "active" });
    expect(collapsesDone(withTask(active), active, NOW)).toBe(false);
  });
});

describe("splitDone", () => {
  it("keeps the given order on both sides", () => {
    const a = done(1, { id: "A" });
    const b = done(9, { id: "B" });
    const c = done(2, { id: "C" });
    const d = done(40, { id: "D" });
    const s: State = { ...base, tasks: [a, b, c, d] };
    const { recent, earlier } = splitDone(s, [a, b, c, d], NOW);
    expect(recent.map((t) => t.id)).toEqual(["A", "C"]);
    expect(earlier.map((t) => t.id)).toEqual(["B", "D"]);
  });
});
