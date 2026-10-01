// Integration of a finished task's change, and delivery to a local branch (pull-request delivery is in
// delivery.ts).

import { recordLanded } from "../delivery";
import { type Artifact, type Integration, type State, type Task, ControlError } from "../types";
import { acceptedOutput } from "./artifacts";
import { draft, event, getTask } from "./core";

/** The next done task waiting for integration, oldest first. */
export function nextIntegration(s: State, nowMs = Date.now()): Task | undefined {
  // A pending task that hit an environment error waits a minute before the next attempt.
  const ready = (t: Task) => !t.integration?.at || nowMs - Date.parse(t.integration.at) >= 60_000;
  return s.tasks.filter((t) => t.lifecycle === "done" && t.integration?.status === "pending" && ready(t)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
}

/** Integration could not run for an environmental reason: keep it pending and retry later. */
export function reportIntegrationError(state: State, taskId: string, message: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.integration?.status !== "pending") return state;
  const repeated = t.integration.message === message;
  // A closed pull request stays on the record so the next one takes the next number.
  t.integration = { status: "pending", at: now, message, ...(t.integration.pr ? { pr: t.integration.pr } : {}) };
  if (!repeated) event(s, now, "system", "blocked", `Integration is waiting: ${message}. It will be retried.`, t.id);
  return s;
}

/** Try a conflicted integration again (for example after resolving the conflict on the user's branch). */
export function retryIntegration(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done" || t.integration?.status !== "conflict") throw new ControlError(`${taskId} has no integration conflict to retry.`);
  t.integration = { status: "pending", ...(t.integration.pr ? { pr: t.integration.pr } : {}) };
  event(s, now, "user", "integration", "Integration will be retried", t.id);
  return s;
}

/**
 * The task's final code change: the latest accepted change of a step that is done now. Skipped or
 * re-run steps contribute nothing, even if they produced a change earlier.
 */
export function finalChange(s: State, t: Task): Artifact | undefined {
  const changes: Artifact[] = [];
  for (const st of t.steps) {
    if (st.state !== "done") continue;
    for (const o of st.outputs) {
      if (o.kind !== "code-change") continue;
      const a = acceptedOutput(s, t, st.id, o.name);
      if (a?.ref) changes.push(a);
    }
  }
  return changes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
}

export function reportIntegration(state: State, taskId: string, result: Integration, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done" || t.integration?.status !== "pending") return s;
  const closed = t.integration.pr;
  // A conflict keeps the earlier (closed) pull request on the record, so a retry takes the next number.
  t.integration = { ...result, at: now, ...(result.status === "conflict" && !result.pr && closed ? { pr: closed } : {}) };
  // A prepared pull-request head is not on the integration branch: local delivery has nothing to do for it.
  const pr = result.pr;
  if (result.status === "integrated" && !pr && s.project.autonomy.autoDeliver.enabled) s.project.delivery = { ...(s.project.delivery ?? {}), pending: true };
  const msg =
    result.status === "integrated"
      ? pr
        ? `Prepared pull request branch ${pr.branch} (${pr.headSha.slice(0, 12)})`
        : `Integrated into the integration branch (${result.ref})`
      : result.status === "conflict"
        ? `Integration conflict: ${result.message}`
        : result.message
          ? `Not delivered: ${result.message}`
          : "Nothing to integrate (no code change)";
  event(s, now, "lead", result.status === "conflict" ? "blocked" : "integration", msg, t.id);
  return s;
}

/** Is a delivery attempt due now? Failed attempts wait: 1 minute when skipped, 5 when conflicting. */
export function deliveryDue(s: State, nowMs: number): boolean {
  const d = s.project.delivery;
  // ORC-012 review 1: no delivery work starts while shaping.
  if (!s.project.autonomy.autoDeliver.enabled || !d?.pending || s.project.hold || s.project.stage === "shaping") return false;
  if (!d.lastAttemptAt) return true;
  const wait = d.status === "conflict" ? 5 * 60_000 : 60_000;
  return nowMs - Date.parse(d.lastAttemptAt) >= wait;
}

/**
 * Record a delivery attempt. Delivered: every integrated task not yet delivered is marked delivered
 * and gets its review-later item. Blocked (the branch was reset or rewritten, or foreign commits would
 * be added): automatic delivery is switched off and the user decides. Tasks delivered as pull requests
 * are never touched. A retry with the same outcome leaves the tasks as they were, so it is not a new event.
 */
export function reportDeliveryResult(state: State, result: { status: "delivered" | "skipped" | "conflict" | "blocked"; message: string; sha?: string }, now: string): State {
  const s = draft(state);
  const prev = s.project.delivery ?? { pending: true };
  const changed = prev.status !== result.status || prev.message !== result.message;
  const branch = s.project.autonomy.autoDeliver.branch;
  s.project.delivery = {
    ...prev,
    pending: result.status !== "delivered" && result.status !== "blocked",
    lastAttemptAt: now,
    status: result.status,
    message: result.message,
    ...(result.status === "delivered" && result.sha ? { lastSha: result.sha } : {}),
  };
  if (result.status === "blocked") s.project.autonomy.autoDeliver = { ...s.project.autonomy.autoDeliver, enabled: false };
  for (const t of s.tasks) {
    const i = t.integration;
    // A fix pushed onto another task's pull request is delivered there, never by local delivery.
    if (i?.status !== "integrated" || i.pr || t.deliverInto || i.delivered?.status === "delivered") continue;
    if (i.delivered?.status !== result.status || i.delivered.message !== result.message) i.delivered = { status: result.status, at: now, message: result.message };
    // Work integrated before its merge commit was recorded cannot be shown later, so it is not listed.
    if (result.status === "delivered" && i.sha) recordLanded(s, t, { via: "local", target: branch, commit: i.sha, by: "app" }, now);
  }
  if (changed) event(s, now, "lead", result.status === "delivered" ? "integration" : "blocked", `Delivery to ${branch}: ${result.message}`);
  return s;
}

/**
 * Local delivery stopped because the branch no longer contains what was delivered before. Forget that
 * baseline: the next delivery starts from the branch as it is now. Turning delivery back on is a
 * separate choice.
 */
export function resetDeliveryBaseline(state: State, now: string): State {
  if (state.project.prDelivery.enabled) throw new ControlError("Pull-request delivery is on; the baseline belongs to local branch delivery.");
  const s = draft(state);
  s.project.delivery = { pending: true };
  event(s, now, "user", "config", `Delivery baseline reset: the next delivery to ${s.project.autonomy.autoDeliver.branch} starts from the branch as it is now`);
  return s;
}
