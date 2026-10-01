// ORC-018 §6: which done tasks the board folds under "Done earlier (n)". Pure; the Board renders the split.

import * as D from "../domain/delivery";
import type { State, Task } from "../domain/types";
import { needsYouOf } from "./progress";

export const DONE_COLLAPSE_MS = 7 * 24 * 60 * 60 * 1000;

/** When the task settled: its outcome's time, else its last update. */
export function settledAtOf(t: Task): string {
  return t.outcome?.settledAt ?? t.updatedAt;
}

/**
 * A done task older than 7 days collapses, unless it still asks something of you: it needs you, its pull
 * request is open (or built and about to open), it landed and you have not reviewed it, or its integration
 * is in conflict.
 */
export function collapsesDone(state: State, t: Task, nowMs: number): boolean {
  if (t.lifecycle !== "done") return false;
  const settled = Date.parse(settledAtOf(t));
  if (!Number.isFinite(settled) || nowMs - settled <= DONE_COLLAPSE_MS) return false;
  if (needsYouOf(state, t, nowMs)) return false;
  const pr = D.livePr(t);
  if (pr && (pr.phase === "open" || pr.phase === "built")) return false;
  if (t.integration?.landed?.status === "unreviewed") return false;
  // An integration conflict is unresolved work, whatever its age (review L8).
  if (t.integration?.status === "conflict") return false;
  return true;
}

/** The done tasks in their given order, split into the ones shown and the ones folded away. */
export function splitDone(state: State, done: Task[], nowMs: number): { recent: Task[]; earlier: Task[] } {
  const recent: Task[] = [];
  const earlier: Task[] = [];
  for (const t of done) (collapsesDone(state, t, nowMs) ? earlier : recent).push(t);
  return { recent, earlier };
}
