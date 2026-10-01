// Presentation helpers for fan-out: loops and child tasks.
// Read-only derivations over domain state; no domain logic lives here.

import * as M from "../domain/model";
import type { Artifact, State, Step, Task } from "../domain/types";

// ORC-016: one-line pipeline summaries and step markers moved to the domain (`flowSummary`, `stepMarkers`
// in src/domain/flows.ts), which the lead envelope shares with the UI.

export function isSettledTask(t: Task) {
  return t.lifecycle === "done" || t.lifecycle === "cancelled";
}

/** Child tasks that currently belong to one breakdown artifact version (kept children move to newer versions). */
export function childrenOfArtifact(state: State, task: Task, a: Artifact): Task[] {
  if (a.kind !== "breakdown") return [];
  return M.childTasks(state, task).filter((c) => c.parentArtifactId === a.id);
}

/** Open children of the task's current flow: what a waiting step waits for. Children of an earlier flow are never waited for. */
export function unsettledChildren(state: State, task: Task): Task[] {
  return M.currentChildren(state, task).filter((c) => !isSettledTask(c));
}

export type StepChip = { text: string; title?: string; strong?: boolean };

/** Chips describing a task step's fan-out role: round, loop, child-task wait. */
export function stepChips(state: State, task: Task, st: Step): StepChip[] {
  const out: StepChip[] = [];
  if (st.iteration && st.iteration > 1) out.push({ text: `round ${st.iteration}` });
  if (st.iterate) out.push({ text: `repeats → ${st.iterate.from}, max ${st.iterate.max}`, title: `Repeats from ${st.iterate.from} through ${st.id} until ${st.id} is skipped or ${st.iterate.max} rounds` });
  if (st.waitForChildren) {
    const waiting = unsettledChildren(state, task).length;
    out.push(
      waiting && !M.isSettled(st) && st.state !== "running"
        ? { text: `waiting for ${waiting} child task${waiting === 1 ? "" : "s"}`, strong: true }
        : { text: "waits for child tasks", title: "Starts only after every child task has finished" },
    );
  }
  return out;
}
