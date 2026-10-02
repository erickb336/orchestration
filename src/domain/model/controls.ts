// The user's task controls: pause and resume, the go-ahead, cancel, priority, pins, deferral, and the
// project-wide pause. Steering reuses the helpers that work on a draft (writePriority, deferInto, dropInto, …).

import * as F from "../findings";
import { activeStudioRuns, requestStudioStop } from "../studio/runs";
import { type Actor, type Deferral, type State, type Task, ControlError } from "../types";
import { activeAttempts, assertOpen, currentSpec, draft, event, getTask, isOpen, requestStop, touch } from "./core";
import { applyBreakdown, descendants } from "./fanout";
import { activeLeadRun, requestLeadStop } from "./lead";
import { deferredBy } from "./presentation";

function holdTask(s: State, t: Task, now: string, with_?: string) {
  t.hold = true; // persist the hold before interrupting anything
  if (with_) t.pausedWith = with_;
  touch(t, now);
  const active = activeAttempts(s, t.id);
  const why = with_ ? ` with ${with_}` : "";
  event(s, now, "user", "control", active.length ? `Pause requested${why}; hold saved, interrupting ${active.length} run${active.length === 1 ? "" : "s"}` : `Paused${why}; hold saved and excluded from dispatch`, t.id);
  for (const a of active) requestStop(s, a, "pause", now);
}

/** Pausing a task also pauses its unfinished child tasks (and theirs); resuming it resumes them. */
export function pauseTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Pausing");
  if (t.hold) return s;
  holdTask(s, t, now);
  for (const d of descendants(s, t)) if (isOpen(d) && !d.hold) holdTask(s, d, now, t.id);
  return s;
}

export function resumeTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Resuming");
  if (!t.hold) throw new ControlError(`${t.id} has no hold to clear.`);
  t.hold = false;
  t.holdReason = undefined;
  t.pausedWith = undefined;
  for (const st of t.steps) if (st.state === "paused") st.state = "pending";
  // Breakdowns reviewed at a gate (or edited while paused): create their children now, from the latest version.
  const pending = t.pendingBreakdowns ?? [];
  t.pendingBreakdowns = undefined;
  for (const pb of pending) applyBreakdown(s, t, pb.stepId, pb.output, now);
  touch(t, now);
  const note = s.project.hold ? " Project is still paused, so nothing will dispatch until it resumes." : " It is not running until dispatched.";
  event(s, now, "user", "control", `Hold cleared; requeued.${note}`, t.id);
  // Child tasks paused together with this one (or with one of its ancestors) resume with it.
  const above = new Set([t.id]);
  for (let cur = t, i = 0; cur.parentTaskId && i < 10; i++) {
    above.add(cur.parentTaskId);
    const p = s.tasks.find((x) => x.id === cur.parentTaskId);
    if (!p) break;
    cur = p;
  }
  for (const d of descendants(s, t)) {
    if (!d.pausedWith || !above.has(d.pausedWith) || !isOpen(d)) continue;
    d.hold = false;
    d.pausedWith = undefined;
    for (const st of d.steps) if (st.state === "paused") st.state = "pending";
    touch(d, now);
    event(s, now, "user", "control", `Resumed with ${t.id}`, d.id);
  }
  return s;
}

/** Any hold change the user makes on a roadmap task takes the task out of the shaping hold; the user's choice then stands. */
function takeOverShapingHold(s: State, t: Task, now: string) {
  if (!t.heldForShaping) return;
  delete t.heldForShaping;
  event(s, now, "user", "control", "No longer held by the roadmap: your hold setting decides when it starts", t.id);
}

export function startHeldTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Starting");
  takeOverShapingHold(s, t, now);
  t.holdBeforeStart = false;
  touch(t, now);
  event(s, now, "user", "control", `Started on your go-ahead; eligible for dispatch${s.project.stage === "shaping" ? " once you start building" : ""}`, t.id);
  return s;
}

export function setHoldBeforeStart(state: State, taskId: string, value: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Changing hold");
  takeOverShapingHold(s, t, now);
  t.holdBeforeStart = value;
  touch(t, now);
  event(s, now, "user", "control", value ? "Waits for your go-ahead before it starts" : "No longer waits for your go-ahead", t.id);
  return s;
}

/** Cancel a task. `by`: the service cancels its own review and fix tasks when their pull request moves on. */
export function cancelTask(state: State, taskId: string, now: string, by?: { actor: Actor; reason: string }): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Cancelling");
  cancelInto(s, t, now, by);
  return s;
}

export function cancelInto(s: State, t: Task, now: string, by?: { actor: Actor; reason: string }) {
  t.lifecycle = "cancelled";
  t.cancelledBy = by?.actor ?? "user";
  touch(t, now);
  const active = activeAttempts(s, t.id);
  event(s, now, by?.actor ?? "user", "control", `Cancelled${by ? ` (${by.reason})` : ""}; spec and partial artifacts retained${active.length ? `; stopping ${active.length} run${active.length === 1 ? "" : "s"}` : ""}`, t.id);
  for (const a of active) requestStop(s, a, "cancel", now);
  // Nothing on a cancelled task waits for a decision any more.
  F.supersedeDecisions(s, t.id, now, { reason: `${t.id} was cancelled` });
  // Unfinished child tasks exist only for this task's goal: cancel them too.
  const children = descendants(s, t).filter(isOpen);
  for (const c of children) {
    c.lifecycle = "cancelled";
    c.cancelledBy = by?.actor ?? "user";
    touch(c, now);
    const runs = activeAttempts(s, c.id);
    event(s, now, "user", "control", `Cancelled with ${t.id}${runs.length ? `; stopping ${runs.length} run${runs.length === 1 ? "" : "s"}` : ""}`, c.id);
    for (const a of runs) requestStop(s, a, "cancel", now);
    F.supersedeDecisions(s, c.id, now, { reason: `${c.id} was cancelled with ${t.id}` });
  }
  const gone = new Set([t.id, ...children.map((c) => c.id)]);
  for (const d of s.tasks.filter((x) => isOpen(x) && !gone.has(x.id))) {
    const dep = d.dependsOn.find((x) => gone.has(x));
    if (dep) event(s, now, "system", "blocked", `Blocked: prerequisite ${dep} was cancelled`, d.id);
  }
}

/** Write a priority. The user's own command also pins it; the lead's write names its change set. */
export function writePriority(s: State, t: Task, priority: number, actor: "user" | "lead", now: string, detail?: string) {
  const old = t.priority;
  t.priority = priority;
  touch(t, now);
  event(s, now, actor, "control", `Priority P${old} → P${priority}${actor === "lead" ? " by lead" : ""}${detail ? ` (${detail})` : ""}`, t.id);
}

export function setPriority(state: State, taskId: string, priority: number, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Reprioritizing");
  if (!Number.isInteger(priority) || priority < 1) throw new ControlError("Priority must be a positive integer.");
  writePriority(s, t, priority, "user", now);
  (t.userSet ??= {}).priority = now;
  return s;
}

/** Pin the priority ("the lead may not reorder this"), or let the lead reorder it again. */
export function setPriorityPin(state: State, taskId: string, pinned: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Pinning");
  if (pinned) (t.userSet ??= {}).priority = now;
  else if (t.userSet) delete t.userSet.priority;
  touch(t, now);
  event(s, now, "user", "control", pinned ? `Priority P${t.priority} pinned; the lead may not reorder it` : "Priority unpinned; the lead may reorder it", t.id);
  return s;
}

/** "Keep running whatever the focus": the lead may not defer this task. Pinning a deferred task lifts its deferral. */
export function setRunPin(state: State, taskId: string, pinned: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Pinning");
  if (pinned) (t.userSet ??= {}).run = now;
  else if (t.userSet) delete t.userSet.run;
  touch(t, now);
  event(s, now, "user", "control", pinned ? "Keeps running whatever the focus; the lead may not defer it" : "The lead may defer this task again", t.id);
  if (pinned && t.deferral) clearDeferral(s, t, "user", now, "keeps running whatever the focus");
  return s;
}

/** Defer: nothing new starts on the task or its descendants. The running step, if any, finishes and its result is kept. */
export function deferInto(s: State, t: Task, d: Deferral, now: string, detail?: string) {
  t.deferral = { ...d };
  touch(t, now);
  const running = activeAttempts(s, t.id).length;
  event(s, now, d.by, "control", `Deferred by ${d.by === "lead" ? "lead" : "you"}${detail ? ` (${detail})` : ""}: ${d.reason}${running ? "; the current step finishes first" : ""}`, t.id);
}

export function clearDeferral(s: State, t: Task, actor: "user" | "lead", now: string, detail?: string) {
  t.deferral = undefined;
  touch(t, now);
  event(s, now, actor, "control", `Deferral lifted by ${actor === "lead" ? "lead" : "you"}${detail ? ` (${detail})` : ""}; eligible for dispatch again`, t.id);
}

/** Run now: clear the task's own deferral and keep it running whatever the focus. */
export function undeferTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Running");
  const d = deferredBy(s, t);
  if (!d) throw new ControlError(`${t.id} is not deferred.`);
  if (d.task.id !== t.id) throw new ControlError(`Deferred with ${d.task.id}: run ${d.task.id} now instead.`);
  clearDeferral(s, t, "user", now);
  (t.userSet ??= {}).run = now;
  return s;
}

/**
 * The lead drops (cancels) its own unstarted proposal. Only `steerPermission` allows it: a lead-authored
 * root that is proposed or ready, with no attempts, no descendants, no open dependent and untouched by
 * the user. Nothing runs, so nothing is stopped; Undo (reopen) restores it.
 */
export function dropInto(s: State, t: Task, changeSetId: string, why: string, now: string, detail?: string) {
  const previous = t.lifecycle as "proposed" | "ready";
  t.lifecycle = "cancelled";
  t.cancelledBy = "lead";
  t.dropped = { changeSetId, lifecycle: previous, at: now };
  touch(t, now);
  event(s, now, "lead", "control", `Dropped by lead${detail ? ` (${detail})` : ""}: ${why}; Undo restores it`, t.id);
}

/** Reopen a dropped proposal. Returns why it was left as is, or undefined on success. */
export function reopenDropped(s: State, t: Task, changeSetId: string, now: string): string | undefined {
  if (t.lifecycle !== "cancelled") return `${t.id} is ${t.lifecycle}`;
  if (!t.dropped || t.dropped.changeSetId !== changeSetId) return "it was not dropped by this change";
  if (s.attempts.some((a) => a.taskId === t.id)) return "it has run since";
  const title = currentSpec(t).content.title.trim().toLowerCase();
  if (s.tasks.some((x) => x.id !== t.id && x.lifecycle !== "cancelled" && currentSpec(x).content.title.trim().toLowerCase() === title)) return "a task with this title was created since";
  t.lifecycle = t.dropped.lifecycle;
  t.dropped = undefined;
  t.cancelledBy = undefined;
  (t.userSet ??= {}).run = now;
  touch(t, now);
  event(s, now, "user", "control", `Reopened: the lead's drop (${changeSetId}) was undone`, t.id);
  return undefined;
}

/** Started work: the lead may reorder or defer it, but never drop it. Same predicate as createChildren. */
export function started(s: State, t: Task): boolean {
  return t.lifecycle === "active" || t.lifecycle === "done" || s.attempts.some((a) => a.taskId === t.id) || s.tasks.some((c) => c.parentTaskId === t.id);
}

/** The user changed something on this task by hand: the lead may not drop it. */
export function userTouched(t: Task): boolean {
  if (t.userSet?.priority || t.userSet?.run) return true;
  if (t.hold && !t.holdReason && !t.pausedWith) return true;
  if (t.specs.some((r) => r.author === "user") || t.pipelineHistory.some((r) => r.author === "user")) return true;
  if (t.steps.some((st) => st.selection !== null)) return true;
  return Object.keys(t.roleOverrides).length > 0;
}

/** A user hold (not a review gate, not inherited from an ancestor). */
export const userHold = (t: Task) => t.hold && !t.holdReason && !t.pausedWith;

/**
 * The dependency guard: an open task outside `t`'s tree that depends on a member of the tree. A drop
 * would leave it Blocked whenever it runs again, so for a drop every open dependent counts; a deferral
 * only leaves a not-deferred dependent waiting silently, so a dependent that is
 * already deferred does not keep a deferral back.
 */
export function openDependent(s: State, t: Task, action: "defer" | "drop"): Task | undefined {
  const tree = new Set([t.id, ...descendants(s, t).map((d) => d.id)]);
  return s.tasks.find((x) => isOpen(x) && !tree.has(x.id) && (action === "drop" || !deferredBy(s, x)) && x.dependsOn.some((d) => tree.has(d)));
}

export function pauseProject(state: State, now: string): State {
  const s = draft(state);
  if (s.project.hold) return s;
  s.project.hold = true;
  const active = activeAttempts(s);
  event(s, now, "user", "control", `Project paused; dispatch and integration frozen${active.length ? `; interrupting ${active.length} run${active.length === 1 ? "" : "s"}` : ""}`);
  for (const a of active) requestStop(s, a, "project-pause", now);
  const lead = activeLeadRun(s);
  if (lead && lead.outcome === "running") requestLeadStop(s, lead, "project paused", now);
  // A studio run that pausing stops is asked for again once the stop is confirmed: it runs when the project resumes.
  for (const r of activeStudioRuns(s)) requestStudioStop(s, r, "project paused", now, true);
  return s;
}

export function resumeProject(state: State, now: string): State {
  const s = draft(state);
  if (!s.project.hold) return s;
  s.project.hold = false;
  let kept = 0;
  for (const t of s.tasks) {
    if (t.lifecycle === "done" || t.lifecycle === "cancelled") continue;
    if (t.hold) {
      kept++;
      continue;
    }
    for (const st of t.steps) if (st.state === "paused") st.state = "pending";
  }
  event(s, now, "user", "control", `Project resumed${kept ? `; ${kept} paused task${kept === 1 ? "" : "s"} stay${kept === 1 ? "s" : ""} paused` : ""}`);
  return s;
}
