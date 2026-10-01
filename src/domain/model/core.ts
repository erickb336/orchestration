// Helpers every model module shares: the draft copy, lookups, activity events, and the run bookkeeping
// (stop requests, settling notes) that several topics need. model.ts re-exports the public ones.

import { type ActivityEvent, type Actor, type Attempt, type EventKind, type State, type Step, type Task, ControlError, isProvider } from "../types";

export function draft(state: State): State {
  return structuredClone(state);
}

/** The next generated id for a draft state (mutates `s.seq`). Also used by the findings module. */
export function nextId(s: State, prefix: string): string {
  s.seq += 1;
  return `${prefix}-${s.seq}`;
}

function log(s: State, e: Omit<ActivityEvent, "id">) {
  s.events.push({ id: nextId(s, "ev"), ...e });
}

export function getTask(s: State, taskId: string): Task {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new ControlError(`Unknown task ${taskId}`);
  return t;
}

export function getStep(t: Task, stepId: string): Step {
  const st = t.steps.find((x) => x.id === stepId);
  if (!st) throw new ControlError(`Unknown step ${stepId} on ${t.id}`);
  return st;
}

export function findStep(t: Task, stepId: string): Step | undefined {
  return t.steps.find((x) => x.id === stepId);
}

/** Done or skipped: the step's contribution is settled and it satisfies dependencies. */
export function isSettled(st: Step) {
  return st.state === "done" || st.state === "skipped";
}

/** Record an activity event on a draft state. Also used by the findings module. */
export function event(s: State, now: string, actor: Actor, kind: EventKind, message: string, taskId?: string) {
  log(s, { at: now, actor, kind, message, taskId });
}

export function currentSpec(t: Task) {
  return t.specs[t.specs.length - 1];
}

export function currentVision(s: State) {
  return s.project.visions[s.project.visions.length - 1];
}

export function isActive(a: Attempt) {
  return a.outcome === "running" || a.outcome === "stopping";
}

export function activeAttempts(s: State, taskId?: string) {
  return s.attempts.filter((a) => isActive(a) && (taskId === undefined || a.taskId === taskId));
}

/** Active runs of agents (a provider's worker). Service runs (checks) count against their own limit. */
export function activeAgentAttempts(s: State) {
  return s.attempts.filter((a) => isActive(a) && isProvider(a.snapshot.provider));
}

/** Active check runs (run by the service), bounded by `checks.maxConcurrent`. */
export function activeServiceAttempts(s: State) {
  return s.attempts.filter((a) => isActive(a) && a.snapshot.provider === "service");
}

/**
 * The check settings changed, so every active check run is stopped for revision and its
 * step's revision bumped, so a late result is discarded and the step runs again with the new settings.
 * Mutates the draft; returns how many runs were asked to stop.
 */
export function stopServiceRuns(s: State, now: string): number {
  let n = 0;
  for (const a of activeServiceAttempts(s)) {
    if (a.outcome !== "running") continue;
    const t = getTask(s, a.taskId);
    const st = findStep(t, a.stepId);
    if (st) st.revision += 1;
    requestStop(s, a, "revision", now);
    n++;
  }
  return n;
}

export function assertOpen(t: Task, what: string) {
  if (t.lifecycle === "done") throw new ControlError(`${t.id} is done. ${what} would rewrite delivered work; create a follow-up task instead.`);
  if (t.lifecycle === "cancelled") throw new ControlError(`${t.id} is cancelled.`);
}

export function requestStop(s: State, a: Attempt, reason: NonNullable<Attempt["stopReason"]>, now: string) {
  if (a.outcome !== "running") return;
  a.outcome = "stopping";
  a.stopRequestedAt = now;
  a.stopReason = reason;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  if (st) st.state = "stopping";
  event(s, now, "system", "control", `Stop requested for ${a.id} (${reason}); awaiting runtime acknowledgment`, t.id);
}

/** Where a step lands once its run has stopped. */
export function settleStoppedStep(s: State, t: Task, st: Step | undefined) {
  if (!st) return; // removed by a pipeline edit
  if (t.lifecycle === "cancelled" || t.hold || s.project.hold) st.state = "paused";
  else st.state = "pending";
}

/**
 * A run reached a terminal outcome. A note still waiting for its acknowledgment can never get one
 * now; it is recorded as not delivered, never as delivered. (Adapters answer every note themselves; this is
 * the safety net for a run that ended between the hand-over and the answer.)
 */
export function settleSendingNotes(s: State, attemptId: string, reason: string, now: string) {
  for (const n of s.notes) {
    if (n.attemptId !== attemptId || n.status !== "sending") continue;
    n.status = "not-delivered";
    n.reason = reason;
    n.settledAt = now;
    event(s, now, "system", "runtime", `Note ${n.id} to ${n.stepId} not delivered: ${reason}`, n.taskId);
  }
}

/**
 * A queued note whose step can no longer run on its own (its task is done or cancelled, the step
 * finished, was skipped or is blocked, or a flow change removed it) is settled as not delivered, so it never waits
 * forever. These are the same reasons a new note to such a step gets (noteRoute).
 */
export function settleStrandedNotes(s: State, now: string) {
  for (const n of s.notes) {
    if (n.status !== "queued") continue;
    const t = s.tasks.find((x) => x.id === n.taskId);
    const st = t && findStep(t, n.stepId);
    const reason = !t
      ? "the task no longer exists"
      : t.lifecycle === "done" || t.lifecycle === "cancelled"
        ? `${t.id} is ${t.lifecycle}`
        : !st
          ? `the pipeline changed; ${n.stepId} is no longer in it`
          : st.state === "done"
            ? `${n.stepId} had finished`
            : st.state === "skipped"
              ? `${n.stepId} was skipped`
              : st.state === "blocked"
                ? `${n.stepId} is blocked: its last run failed`
                : undefined;
    if (!reason) continue;
    n.status = "not-delivered";
    n.reason = reason;
    n.settledAt = now;
    event(s, now, "system", "control", `Note ${n.id} to ${n.stepId} not delivered: ${reason}`, n.taskId);
  }
}

export function finishTask(t: Task) {
  t.lifecycle = "done";
  t.integration = { status: "pending" };
  // A finished task's deferral is spent; its children must not inherit it.
  t.deferral = undefined;
}

/** The attempt started under a flow the task has since left (never true for tasks from before flows, whose `flowSince` is 0). */
export function beforeFlow(t: Task, a: Attempt): boolean {
  return a.snapshot.pipelineRev < (t.flowSince ?? 0);
}

/**
 * The revision a step created now starts at, above any revision that id ever had on this task (a current
 * step, or an attempt's snapshot), so no earlier run can report into it: reportCompletion discards a result
 * whose step revision is not the current one. Used for flow changes, loop iterations and check rounds alike.
 */
export function nextRevisionFor(s: State, t: Task, id: string): number {
  let highest = 0;
  for (const st of t.steps) if (st.id === id) highest = Math.max(highest, st.revision);
  for (const a of s.attempts) if (a.taskId === t.id && a.stepId === id) highest = Math.max(highest, a.snapshot.stepRev);
  return highest + 1;
}

/** Record a result from before the flow changed as discarded. The step is not touched: no blocked state, no output. */
export function discardEarlierFlow(s: State, t: Task, a: Attempt, now: string, detail = "") {
  a.outcome = "discarded";
  a.note = `Result from before the flow changed (pipeline r${a.snapshot.pipelineRev}); not integrated${detail}`;
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  event(s, now, "runtime", "integration", `${a.id} finished on pipeline r${a.snapshot.pipelineRev}, before the flow changed (r${t.flowSince}); result discarded, not integrated`, t.id);
  settleSendingNotes(s, a.id, "the run ended before the runtime answered", now);
}

export function touch(t: Task, now: string) {
  t.updatedAt = now;
}

/** Internals that src/domain/testing uses to build pipelines no flow offers. Not for production code. */
export const testingInternals = { draft, getTask, assertOpen, requestStop, touch };

export const isOpen = (t: Task) => t.lifecycle !== "done" && t.lifecycle !== "cancelled";
