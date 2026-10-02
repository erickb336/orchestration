// State derived for display: a task's board column and state label, and why it is blocked or waiting.
// Nothing here is stored.

import * as C from "../checks";
import * as F from "../findings";
import { PE_REVIEW_HOLD, peReviewHold } from "../peReview";
import { type Deferral, type State, type Step, type Task, REVIEW_ROLES } from "../types";
import { activeAttempts, findStep, getStep, isOpen, isSettled } from "./core";
import { childrenSettled, currentChildren } from "./fanout";
import { startFactoryPlan } from "./shaping";

export type Column = "proposed" | "ready" | "running" | "reviewing" | "paused" | "deferred" | "blocked" | "done" | "cancelled";
export const BOARD_COLUMNS: Column[] = ["proposed", "ready", "running", "reviewing", "paused", "deferred", "blocked", "done"];

/**
 * The deferral that applies to a task: its own, or the nearest ancestor's (walking at most
 * 10 levels). Children are never written, so a root and all its children defer together and one Undo
 * touches one field.
 */
export function deferredBy(s: State, t: Task): { task: Task; deferral: Deferral } | undefined {
  let cur: Task | undefined = t;
  for (let i = 0; cur && i <= 10; i++) {
    // A done or cancelled ancestor's deferral no longer applies, so a deferred root
    // that finishes does not strand its open children (finishTask clears the deferral as well).
    if (cur.deferral && isOpen(cur)) return { task: cur, deferral: cur.deferral };
    if (!cur.parentTaskId) return undefined;
    cur = s.tasks.find((x) => x.id === cur!.parentTaskId);
  }
  return undefined;
}

/** A finished task whose pull request was closed without merging (pull-request delivery only). */
function closedPr(s: State, d: Task | undefined): number | "unopened" | undefined {
  const i = d?.integration;
  if (!s.project.prDelivery.enabled || d?.lifecycle !== "done" || i?.status !== "integrated" || i.pr?.phase !== "closed") return undefined;
  return i.pr.number ?? "unopened";
}
const closedText = (id: string, n: number | "unopened") => (n === "unopened" ? `${id}'s pull request was abandoned before it was opened` : `${id}'s PR #${n} was closed without merging`);

/**
 * Is a prerequisite's work available to the tasks that depend on it? Without pull-request delivery:
 * when it is done. With it: when its code is in the base new work starts from, which means its pull
 * request merged and the base was fetched afterwards (or it had nothing to deliver, or it was
 * integrated before pull-request delivery was switched on).
 */
export function prerequisiteReady(s: State, d: Task | undefined): boolean {
  if (d?.lifecycle !== "done") return false;
  if (!s.project.prDelivery.enabled) return true;
  const i = d.integration;
  if (!i || i.status === "not-needed") return true;
  if (i.status !== "integrated") return false;
  if (!i.pr) return true;
  const fetchedAt = s.project.github?.base?.fetchedAt;
  return !!i.landed && !!fetchedAt && fetchedAt >= i.landed.at;
}

export function blockedReason(s: State, t: Task): string | undefined {
  for (const dep of t.dependsOn) {
    const d = s.tasks.find((x) => x.id === dep);
    if (d?.lifecycle === "cancelled") return `Prerequisite ${dep} was cancelled`;
    const closed = closedPr(s, d);
    if (closed !== undefined) return `${closedText(dep, closed)}. Deliver ${dep} again, or remove the prerequisite.`;
  }
  const st = t.steps.find((x) => x.state === "blocked");
  if (st) return `${st.id}: ${st.blockedReason ?? "blocked"}`;
  if (waitingForChildren(s, t)) {
    for (const c of currentChildren(s, t)) {
      if (!isOpen(c)) continue;
      const dep = c.dependsOn.find((d) => s.tasks.find((x) => x.id === d)?.lifecycle === "cancelled");
      if (dep) return `Child ${c.id} cannot start: its prerequisite ${dep} was cancelled. Cancel ${c.id} or remove the prerequisite.`;
    }
    for (const c of currentChildren(s, t)) {
      const closed = closedPr(s, c);
      if (closed !== undefined) return `Child ${closedText(c.id, closed)}. Deliver ${c.id} again.`;
    }
  }
  return undefined;
}

/** A pending step that is ready except that it waits for this task's child tasks to finish. */
export function waitingForChildren(s: State, t: Task): Step | undefined {
  if (childrenSettled(s, t)) return undefined;
  return t.steps.find((x) => x.state === "pending" && x.waitForChildren && x.dependsOn.every((d) => isSettled(getStep(t, d))));
}

export function column(s: State, t: Task): Column {
  if (t.lifecycle === "cancelled") return "cancelled";
  if (t.lifecycle === "done") return "done";
  const active = activeAttempts(s, t.id);
  if (active.length) {
    const allReview = active.every((a) => {
      const st = findStep(t, a.stepId);
      return !!st && REVIEW_ROLES.includes(st.role);
    });
    return allReview ? "reviewing" : "running";
  }
  if (blockedReason(s, t)) return "blocked";
  if (t.hold) return "paused";
  // Deferred work is idle by design, never "Paused" (a pause is something the runtime confirmed).
  if (deferredBy(s, t)) return "deferred";
  if (t.lifecycle === "proposed") return "proposed";
  // Started but idle: paused by the project hold, otherwise queued for its next step.
  if (t.lifecycle === "active" && s.project.hold) return "paused";
  return "ready";
}

/** "Deferred by lead", "Deferred by you", or "Deferred with T-4" when the deferral comes from an ancestor. */
export function deferredLabel(s: State, t: Task): string | undefined {
  const d = deferredBy(s, t);
  if (!d) return undefined;
  if (d.task.id !== t.id) return `Deferred with ${d.task.id}`;
  return d.deferral.by === "lead" ? "Deferred by lead" : "Deferred by you";
}

/** A short truthful state label that distinguishes desired from observed state. */
export function stateLabel(s: State, t: Task): string {
  const col = column(s, t);
  const active = activeAttempts(s, t.id);
  const stopping = active.filter((a) => a.outcome === "stopping");
  if (t.controlFailure) return "Control failure";
  if (stopping.length) return stopLabel(s, t);
  if (col === "cancelled") return "Cancelled";
  if (col === "done") return "Done";
  if (col === "blocked") return "Blocked";
  // One word for a pause, whether the task or the project is paused; the header says "Project paused".
  if (col === "paused") return "Paused";
  // A deferred task keeps working until its current step ends; then nothing new starts.
  if ((col === "running" || col === "reviewing") && deferredBy(s, t)) return `${col === "running" ? "Running" : "In review"} · deferred after this step`;
  if (col === "reviewing") return "In review";
  if (col === "deferred") return deferredLabel(s, t)!;
  if (t.lifecycle === "active" && active.length === 0 && waitingForChildren(s, t)) {
    const open = currentChildren(s, t).filter(isOpen).length;
    if (open === 0) return "Waiting for child pull requests to merge";
    return `Waiting for ${open} child task${open === 1 ? "" : "s"}`;
  }
  // A repair that would read undecided findings waits for the decision; nothing is blocked.
  const awaiting = t.lifecycle === "active" && active.length === 0 ? F.awaitingDecision(s, t) : undefined;
  if (awaiting) return F.awaitingLabel(awaiting);
  // A Checks step that would start next waits while the sandbox is not ready; nothing runs unsandboxed by itself.
  if (t.lifecycle === "active" && active.length === 0 && C.checksHeld(s) && t.steps.some((st) => st.state === "pending" && st.role === "checks" && st.dependsOn.every((d) => isSettled(getStep(t, d))))) return C.HELD_LABEL;
  // While shaping, a step that would start next waits for Start building; nothing is paused.
  if (t.lifecycle === "active" && active.length === 0) return s.project.stage === "shaping" ? "Next step waits (shaping)" : "Queued for next step";
  if (col === "proposed" && waitingOn(s, t)) return waitingLabel(s, t);
  // The roadmap's own hold is named as such; the user's hold before start keeps its own label. What follows
  // Start building is decided by the involvement setting at that moment, so the label reads it now; a
  // dependency wait is shown under the shaping hold too.
  if (col === "ready" && t.heldForShaping) {
    const dep = waitingOn(s, t);
    return `Planned; waits until you start building${dep ? ` and on ${dep}` : ""}, then ${startFactoryPlan(s).release ? "starts on Autopilot" : "waits for your go-ahead (your involvement setting)"}`;
  }
  // PE review comes first: the involvement setting applies once the PE agreed (ORC-029 2e).
  const review = peReviewHold(t.peReview);
  if ((col === "ready" || col === "proposed") && review) return review === PE_REVIEW_HOLD ? "Waiting for PE review" : "The PE objects: needs you";
  // "Wait for my go-ahead" is the setting; the state names what it waits for. A project pause shows in the header, not here.
  if (col === "ready" && t.holdBeforeStart) return "Waiting for your go-ahead";
  // A dependency wait is shown before the stage, with shaping noted.
  if (col === "ready" && waitingOn(s, t)) return waitingLabel(s, t);
  if (col === "ready" && s.project.stage === "shaping") return "Ready (shaping)";
  return col[0].toUpperCase() + col.slice(1);
}

/** "Waiting on T-x", or "Waiting on T-x (deferred)" when the prerequisite itself is deferred; "(shaping)" while nothing would start anyway. */
function waitingLabel(s: State, t: Task): string {
  const dep = waitingOn(s, t)!;
  const d = s.tasks.find((x) => x.id === dep);
  return `Waiting on ${dep}${d && deferredBy(s, d) ? " (deferred)" : ""}${s.project.stage === "shaping" ? " (shaping)" : ""}`;
}

/** Why runs on this task are stopping, derived from the stop requests and current desired state. */
export function stopLabel(s: State, t: Task): string {
  if (t.lifecycle === "cancelled") return "Cancelling";
  if (t.hold || s.project.hold) return "Pausing";
  const reasons = new Set(activeAttempts(s, t.id).filter((a) => a.outcome === "stopping").map((a) => a.stopReason));
  if (reasons.has("revision")) return "Stopping for revision";
  if (reasons.has("model-change")) return "Stopping for model change";
  // A pause was lifted before the runtime acknowledged it; the run must still stop before redispatch.
  return "Resuming";
}

export function waitingOn(s: State, t: Task): string | undefined {
  return t.dependsOn.find((d) => !prerequisiteReady(s, s.tasks.find((x) => x.id === d)));
}

/** Why a finished prerequisite is still waited on (pull-request delivery), in plain words. */
export function waitingDetail(s: State, depId: string): string | undefined {
  const d = s.tasks.find((x) => x.id === depId);
  if (d?.lifecycle !== "done" || prerequisiteReady(s, d)) return undefined;
  const i = d.integration;
  const pr = i?.status === "integrated" ? i.pr : undefined;
  if (pr && i?.landed) return `${depId}'s pull request merged; waiting for the next fetch of ${pr.remote}/${pr.base}`;
  if (pr) return pr.number ? `Waiting for ${depId}'s PR #${pr.number} to merge` : `Waiting for ${depId}'s pull request to be opened and merged`;
  return `Waiting for ${depId}'s pull request to be prepared`;
}
