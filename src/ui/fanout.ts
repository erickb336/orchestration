// Presentation helpers for fan-out: parallel copies, best-of choices, loops, and child tasks.
// Read-only derivations over domain state; no domain logic lives here.

import * as M from "../domain/model";
import type { Artifact, State, Step, StepDef, Task } from "../domain/types";

// ORC-016: one-line pipeline summaries and step markers moved to the domain (`patternSummary`, `stepMarkers`
// in src/domain/patterns.ts), which the lead envelope shares with the UI.

export function isSettledTask(t: Task) {
  return t.lifecycle === "done" || t.lifecycle === "cancelled";
}

/** The members of a parallel group (in pipeline order), its mode, and the recorded choice. */
export function copyGroup(task: Task, st: StepDef) {
  if (!st.copyOf) return undefined;
  const members = task.steps.filter((x) => x.copyOf === st.copyOf);
  const leader = task.steps.find((x) => x.id === st.copyOf);
  const mode = leader?.parallel?.mode ?? "copies";
  return { group: st.copyOf, members, index: members.findIndex((x) => x.id === st.id) + 1, mode, chosen: task.bestOf?.[st.copyOf], byUser: !!task.bestOfByUser?.[st.copyOf] };
}

/** True when this step is a best-of candidate that was not chosen. Its work is kept but goes no further. */
export function notChosen(task: Task, stepId: string): boolean {
  const st = task.steps.find((x) => x.id === stepId);
  const g = st?.copyOf;
  return !!g && !!task.bestOf?.[g] && task.bestOf[g] !== stepId;
}

/** Child tasks that currently belong to one breakdown artifact version (kept children move to newer versions). */
export function childrenOfArtifact(state: State, task: Task, a: Artifact): Task[] {
  if (a.kind !== "breakdown") return [];
  return M.childTasks(state, task).filter((c) => c.parentArtifactId === a.id);
}

/** Open children of the task's current pattern: what a waiting step waits for. Children of an earlier pattern are never waited for. */
export function unsettledChildren(state: State, task: Task): Task[] {
  return M.currentChildren(state, task).filter((c) => !isSettledTask(c));
}

export type StepChip = { text: string; title?: string; strong?: boolean };

/** Chips describing a task step's fan-out role: copy, round, loop, child-task wait, unexpanded parallel. */
export function stepChips(state: State, task: Task, st: Step): StepChip[] {
  const out: StepChip[] = [];
  const g = copyGroup(task, st);
  if (g) {
    out.push({
      text: `copy ${g.index} of ${g.members.length}${g.mode === "best-of" ? " (best of)" : ""}`,
      title: g.mode === "best-of" ? `Best of ${g.members.length}: a later step chooses one of ${g.members.map((x) => x.id).join(", ")}` : `Parallel copies of ${g.group}: every copy's output goes forward`,
    });
    if (g.mode === "best-of" && g.chosen) out.push(g.chosen === st.id ? { text: "chosen", strong: true } : { text: "not chosen", title: `${g.chosen} was chosen; this candidate's work stays on its branch` });
  }
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
  if (st.parallel && !st.copyOf) out.push({ text: `parallel ×${st.parallel.count} (${st.parallel.mode === "best-of" ? "best of" : "copies"})`, title: "Expands into separate agents when it starts" });
  return out;
}
