// A step as the person reads it: its name, who works on it (only while running or done),
// and its state in words. Pure derivations over domain state; nothing here decides anything.

import * as C from "../../domain/checks";
import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import type { Attempt, State, Step, Task } from "../../domain/types";
import { selectionText } from "../common";
import { unsettledChildren } from "../fanout";
import type { StepMark } from "../kit/StepList";

export interface StepWords {
  /** The step's purpose: "Implement", "Code review". */
  name: string;
  /** The loop round, from 2 on ("round 2"). */
  round?: number;
  /** Who does it: "Claude · claude-sample-large", or "the service" for a Checks step. Only while running or done. */
  who?: string;
  /** The state in words: "Waiting", "Running", "Done: no findings", "Skipped: nothing to fix", "Needs you: 1 finding", "Blocked: …". */
  state: string;
  mark: StepMark;
  /** The run the words describe: the active one, or the last completed one of a done step. */
  run?: Attempt;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const REVIEW_ROLES = new Set(["code_reviewer", "security_reviewer", "ux_reviewer"]);

/** The step's purpose without the expansion's "(iteration 2)" suffix: the round is said beside it ("round 2"). */
export function stepName(st: Pick<Step, "purpose">): string {
  return st.purpose.replace(/\s*\(iteration \d+\)\s*$/, "");
}

/** The last completed run of a step. */
export function lastCompletedRun(state: State, task: Task, st: Step): Attempt | undefined {
  let run: Attempt | undefined;
  for (const a of state.attempts) if (a.taskId === task.id && a.stepId === st.id && a.outcome === "completed") run = a;
  return run;
}

/** "Claude · claude-sample-large" for an agent run (the model the provider reported, if it did); "the service" for a check run. */
function whoRan(st: Step, run: Attempt): string {
  if (st.role === "checks" || run.snapshot.provider === "service") return "the service";
  return selectionText({ provider: run.snapshot.provider, model: run.actualModel ?? run.snapshot.model });
}

/** A done step's words: what a review found, whether checks passed, or plain "Done". */
function doneWords(state: State, task: Task, st: Step): { state: string; mark: StepMark } {
  if (st.role === "checks") {
    const out = st.outputs.find((o) => o.kind === "check-results");
    const art = out && M.acceptedOutput(state, task, st.id, out.name);
    const results = art?.checkRun?.results ?? [];
    const failed = results.filter((r) => r.status === "failed" || r.status === "timed-out").length;
    if (!results.length) return { state: "Done", mark: "done" };
    return failed ? { state: `Done: ${failed} of ${plural(results.length, "check")} failed`, mark: "done" } : { state: "Passed", mark: "done" };
  }
  if (REVIEW_ROLES.has(st.role)) {
    let found = 0;
    let mine = 0;
    let lead = 0;
    for (const o of st.outputs) {
      if (o.kind !== "review-findings") continue;
      const art = M.acceptedOutput(state, task, st.id, o.name);
      if (!art) continue;
      found += art.findings ? art.findings.length : (art.openFindings ?? 0);
      for (const f of art.findings ?? []) {
        const d = F.decisionFor(state, art, f);
        if (d?.status !== "open") continue;
        if (d.routedTo === "user") mine++;
        else lead++;
      }
    }
    if (mine) return { state: `Needs you: ${plural(mine, "finding")}`, mark: "you" };
    if (lead) return { state: `Done: the lead is deciding ${plural(lead, "finding")}`, mark: "done" };
    return { state: found ? `Done: ${plural(found, "finding")}` : "Done: no findings", mark: "done" };
  }
  return { state: "Done", mark: "done" };
}

/** A pending step's words: why it has not started, in the reader's terms. */
function pendingWords(state: State, task: Task, st: Step): string {
  if (task.lifecycle === "cancelled") return "Not run";
  if (st.invalidatedBy) return st.invalidatedBy.startsWith("edited ") ? `Runs again: you ${st.invalidatedBy}` : `Runs again: ${st.invalidatedBy} changed`;
  if (st.runIf?.length) {
    let mine = 0;
    let lead = 0;
    for (const r of st.runIf) {
      const art = M.acceptedOutput(state, task, r.step, r.output);
      for (const f of art?.findings ?? []) {
        if (!F.isBlocking(f) || f.action !== "ask-user") continue;
        const d = F.decisionFor(state, art!, f);
        if (d && d.status !== "open") continue;
        if (d?.routedTo === "lead") lead++;
        else mine++;
      }
    }
    if (mine) return "Waits for your decision";
    if (lead) return "Waits for the lead's decision";
  }
  if (st.waitForChildren) {
    const n = unsettledChildren(state, task).length;
    if (n) return `Waiting for ${plural(n, "child task")}`;
  }
  if (st.role === "checks") {
    if (!C.checksOn(state.project.checks)) return "Will be skipped: checks are off";
    if (C.checksHeld(state)) return "Waiting for the checks sandbox";
  }
  return "Waiting";
}

/** The words for one step of a task. */
export function stepWords(state: State, task: Task, st: Step): StepWords {
  const active = M.activeAttempts(state, task.id).find((a) => a.stepId === st.id);
  const run = active ?? (st.state === "done" ? lastCompletedRun(state, task, st) : undefined);
  const base: Omit<StepWords, "state" | "mark"> = {
    name: stepName(st),
    ...(st.iteration && st.iteration > 1 ? { round: st.iteration } : {}),
    ...(run ? { who: whoRan(st, run), run } : {}),
  };
  if (active) return { ...base, mark: "running", state: active.outcome === "stopping" ? "Stopping" : "Running" };
  switch (st.state) {
    case "done":
      return { ...base, ...doneWords(state, task, st) };
    case "skipped":
      return { ...base, mark: "skipped", state: st.role === "checks" && !C.checksOn(state.project.checks) ? "Skipped: checks are off" : st.runIf?.length ? "Skipped: nothing to fix" : "Skipped" };
    case "blocked": {
      const final = st.role === "checks" && st.blockedReason?.startsWith("Checks failed");
      const open = final && state.decisions.some((d) => d.kind === "final-checks" && d.taskId === task.id && d.status === "open" && state.artifacts.find((a) => a.id === d.artifactId)?.stepId === st.id);
      if (open) return { ...base, mark: "you", state: "Needs you: checks failed on the final change" };
      return { ...base, mark: "fail", state: st.blockedReason ? `Blocked: ${st.blockedReason}` : "Blocked" };
    }
    case "paused":
      return { ...base, mark: "waiting", state: "Paused" };
    case "running":
    case "stopping":
      // The step says it runs but no run is active (a stale record): say what the step says.
      return { ...base, mark: "running", state: st.state === "stopping" ? "Stopping" : "Running" };
    default:
      return { ...base, mark: "waiting", state: pendingWords(state, task, st) };
  }
}
