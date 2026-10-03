// Running a step again: retry a blocked step, rerun a finished one (everything downstream is invalidated),
// and the bounded automatic retries after a failed run.

import { type State, type Step, type Task, ControlError } from "../types";
import { activeAttempts, assertOpen, draft, event, findStep, getStep, getTask, isSettled, requestStop, touch } from "./core";

/** Clear a blocked step so the next dispatch tries it again with current configuration. */
export function retryStep(state: State, taskId: string, stepId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Retrying");
  const st = getStep(t, stepId);
  if (st.state !== "blocked") throw new ControlError(`${stepId} is not blocked.`);
  st.state = t.hold ? "paused" : "pending";
  st.blockedReason = undefined;
  touch(t, now);
  event(s, now, "user", "control", `Retry ${stepId}; eligible for the next dispatch`, t.id);
  return s;
}

export function rerunStep(state: State, taskId: string, stepId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Rerunning");
  rerunInto(s, t, getStep(t, stepId), now, "user");
  return s;
}

/**
 * Rerun a finished step on a draft state: it goes back to pending, everything downstream is invalidated and
 * downstream runs in flight are stopped. Also used by a note that reruns a finished step, and by the service when the
 * PE sends a step's output back for revision (`actor` "system").
 */
export function rerunInto(s: State, t: Task, st: Step, now: string, actor: "user" | "lead" | "system", detail?: string) {
  const stepId = st.id;
  if (st.state !== "done") throw new ControlError(`${stepId} has not completed.`);
  st.state = "pending";
  st.invalidatedBy = undefined;
  const invalid = new Set([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of t.steps) {
      if (!invalid.has(d.id) && d.dependsOn.some((x) => invalid.has(x))) {
        invalid.add(d.id);
        changed = true;
        if (isSettled(d)) {
          d.state = "pending";
          d.invalidatedBy = stepId;
        }
      }
    }
  }
  // Downstream work in flight was built on the old upstream output: stop it, and bump its
  // step revision so a late completion is discarded rather than integrated.
  for (const a of activeAttempts(s, t.id)) {
    if (a.stepId === stepId || !invalid.has(a.stepId)) continue;
    const d = findStep(t, a.stepId);
    if (!d) continue;
    d.revision += 1;
    d.invalidatedBy = stepId;
    requestStop(s, a, "revision", now);
  }
  touch(t, now);
  const downstream = [...invalid].filter((x) => x !== stepId);
  event(s, now, actor, "control", `Rerun ${stepId}${actor === "lead" ? " by lead" : ""}${detail ? ` (${detail})` : ""}${downstream.length ? `; downstream ${downstream.join(", ")} need revalidation` : ""}`, t.id);
}

/** Failures a retry cannot fix: missing credentials, configuration, or unusable workspaces. */
const NOT_RETRYABLE = /API key|not signed in|not enabled|not in the .* catalog|not available|isolation|git metadata|not a git repository|time limit|usage limit|rate limit|quota|budget/i;

/** Steps blocked by a failed run that may be retried automatically now (bounded per step). */
export function autoRetryCandidates(s: State, nowMs = Date.now()): { taskId: string; stepId: string }[] {
  const max = s.project.autonomy.autoRetry;
  if (!max || s.project.hold) return [];
  const out: { taskId: string; stepId: string }[] = [];
  for (const t of s.tasks) {
    if (t.lifecycle === "done" || t.lifecycle === "cancelled" || t.hold) continue;
    for (const st of t.steps) {
      if (st.state !== "blocked" || !st.blockedReason?.startsWith("Last run failed")) continue;
      if ((st.autoRetries ?? 0) >= max || NOT_RETRYABLE.test(st.blockedReason)) continue;
      // Back off: 1, 2, 4 … minutes after the failed run ended.
      const last = s.attempts.filter((a) => a.taskId === t.id && a.stepId === st.id && a.endedAt).pop();
      if (last?.endedAt && nowMs - Date.parse(last.endedAt) < 2 ** (st.autoRetries ?? 0) * 60_000) continue;
      out.push({ taskId: t.id, stepId: st.id });
    }
  }
  return out;
}

export function autoRetryStep(state: State, taskId: string, stepId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  const st = getStep(t, stepId);
  if (st.state !== "blocked") return state;
  st.autoRetries = (st.autoRetries ?? 0) + 1;
  st.state = "pending";
  const reason = st.blockedReason;
  st.blockedReason = undefined;
  touch(t, now);
  event(s, now, "lead", "control", `Automatic retry ${st.autoRetries}/${s.project.autonomy.autoRetry} of ${stepId} after: ${reason}`, t.id);
  return s;
}
