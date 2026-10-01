// The user's commands on one pull request: hold, release, merge policy, merge, close, and delivering again.

import { clip } from "../text";
import { ControlError, type PrDelivery, type State, type Task } from "../types";
import { event, getTask, sha12 } from "./core";
import { dropStaleUpdate, refreshAttention, wrongRepo } from "./gate";
import { prBranch, prName, prTask, redeliverable } from "./pr";
import { cancelLinked } from "./repair";
import { checkTasksFor } from "./serviceChecks";
import { deliveryMode } from "./settings";

export function openPr(s: State, taskId: string, what: string): { task: Task; pr: PrDelivery } {
  const r = prTask(s, taskId);
  if (r.pr.phase !== "built" && r.pr.phase !== "open") throw new ControlError(`${taskId}'s pull request is ${r.pr.phase}; there is nothing to ${what}.`);
  return r;
}

/** Hold one pull request: the app does not push, merge or comment on it until the user releases it. */
export function holdPr(state: State, taskId: string, reason: string | undefined, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "hold");
  if (pr.userHold) return state;
  pr.userHold = { at: now, ...(reason?.trim() ? { reason: clip(reason.trim(), 200) } : {}) };
  dropStaleUpdate(s, task, now);
  // A hold withdraws a merge request that has not been sent yet.
  if (!pr.op) delete pr.mergeRequested;
  event(s, now, "user", "integration", `${prName(pr)} kept for you${pr.op ? "; the operation already sent to GitHub cannot be interrupted" : ""}`, task.id);
  return s;
}

export function releasePr(state: State, taskId: string, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "release");
  if (!pr.userHold) return state;
  delete pr.userHold;
  // A release is also "try again": the wait after failed attempts to open it starts over.
  if (pr.phase === "built") {
    pr.counters.failures = 0;
    delete pr.nextAt;
  }
  event(s, now, "user", "integration", `${prName(pr)} released`, task.id);
  refreshAttention(s, task, now);
  return s;
}

/**
 * Per pull request: follow the project (null), hold it for the user, or let it merge automatically.
 * "auto" only chooses who merges; the same gate still has to pass for the exact commit.
 */
export function setPrPolicy(state: State, taskId: string, policy: "hold" | "auto" | null, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "change");
  const source = policy === null ? "project" : "user";
  const next = policy ?? s.project.prDelivery.merge;
  if (pr.policy === next && pr.policySource === source) return state;
  pr.policy = next;
  pr.policySource = source;
  if (next === "auto") delete pr.mergeRequested;
  dropStaleUpdate(s, task, now);
  event(s, now, "user", "integration", `${prName(pr)}: ${next === "auto" ? "merges automatically after an independent review and passing required checks" : "you merge"}${policy === null ? " (follows the project)" : ""}`, task.id);
  refreshAttention(s, task, now);
  return s;
}

/**
 * The user's Merge click, tied to the head they saw. It merges only once GitHub's checks and rules
 * pass for that head; any other head makes the click void.
 */
export function requestPrMerge(state: State, taskId: string, headSha: string, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "merge");
  if (!s.project.prDelivery.enabled) throw new ControlError("Pull-request delivery is off, so the app merges nothing. Merge on GitHub, or switch the delivery mode back on.");
  if (pr.phase !== "open" || pr.number === undefined) throw new ControlError("The pull request is not open yet.");
  if (headSha !== pr.headSha || pr.pendingHead) throw new ControlError("The pull request changed since you looked. Look at it again, then merge.");
  if (pr.foreignHead) throw new ControlError("Someone else pushed to this pull request; the app will not merge it. Merge it on GitHub.");
  if (pr.closeRequested) throw new ControlError("You asked to close this pull request.");
  if (wrongRepo(s, pr)) throw new ControlError(`This pull request is in ${pr.repo}, but the remote now points at ${s.project.github!.repo}. The app does not merge it there.`);
  if (pr.mergeRequested?.headSha === headSha) return state;
  pr.mergeRequested = { at: now, headSha };
  // A new, deliberate request starts the count of refusals over.
  pr.counters.mergeAttempts = 0;
  delete pr.nextAt;
  event(s, now, "user", "integration", `Merge requested for ${prName(pr)} at ${sha12(headSha)}; it merges once GitHub's checks and rules pass for that commit`, task.id);
  refreshAttention(s, task, now);
  return s;
}

/** Let this one delivery push a change to CI workflow files. Logged. */
export function allowWorkflowPush(state: State, taskId: string, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "allow");
  if (!pr.changed.workflowHits.length) throw new ControlError("This pull request does not change workflow files.");
  if (pr.workflowPushAllowed) return state;
  pr.workflowPushAllowed = true;
  event(s, now, "user", "integration", `Allowed pushing the workflow change in ${pr.changed.workflowHits.slice(0, 5).join(", ")} for this delivery only`, task.id);
  refreshAttention(s, task, now);
  return s;
}

/** Abandon a delivery. The pull request is closed on GitHub; the branch is kept; nothing is reopened. */
export function closePr(state: State, taskId: string, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "close");
  if (pr.closeRequested) return state;
  delete pr.mergeRequested;
  if (wrongRepo(s, pr)) {
    // The pull request lives in another repository than the remote names now: nothing is sent there.
    pr.phase = "closed";
    delete pr.attention;
    delete pr.op;
    event(s, now, "user", "integration", `Delivery of ${pr.branch} abandoned here. ${prName(pr)} in ${pr.repo} was not touched: the remote now points at ${s.project.github!.repo}. Close it on GitHub if it should not stay open`, task.id);
    return cancelLinked(s, [...pr.reviewTaskIds, ...pr.repairTaskIds, ...checkTasksFor(s, task, pr, true).map((x) => x.id)], now, "the delivery was abandoned");
  }
  if (pr.phase === "built" && !pr.op && pr.counters.failures === 0 && pr.number === undefined) {
    // Nothing was ever sent to GitHub for this head.
    pr.phase = "closed";
    delete pr.attention;
    event(s, now, "user", "integration", `Delivery of ${pr.branch} abandoned before anything was pushed`, task.id);
    return cancelLinked(s, [...pr.reviewTaskIds, ...pr.repairTaskIds, ...checkTasksFor(s, task, pr, true).map((x) => x.id)], now, "the delivery was abandoned");
  }
  pr.closeRequested = { at: now };
  delete pr.nextAt;
  event(s, now, "user", "integration", `Close requested for ${prName(pr)}; it shows as closed once GitHub reports it`, task.id);
  return s;
}

/** Deliver finished work (again) as a pull request. A closed pull request is never reopened: the next one is n+1. */
export function redeliver(state: State, taskIds: string[], now: string): State {
  if (taskIds.length === 0) throw new ControlError("Choose at least one task.");
  if (taskIds.length > 20) throw new ControlError("At most 20 tasks can be delivered again at once.");
  const prOn = state.project.prDelivery.enabled;
  const s = structuredClone(state);
  const ok = new Set(redeliverable(s).map((t) => t.id));
  for (const id of new Set(taskIds)) {
    const t = getTask(s, id);
    if (!ok.has(id))
      throw new ControlError(
        prOn
          ? `${id} cannot be delivered again: it must be done, have a code change, not have landed, and have no open pull request.`
          : `${id} cannot be delivered again while pull-request delivery is off: only work whose pull request was closed or abandoned can go through the current mode. Switch the delivery mode to GitHub pull requests for anything else.`,
      );
    const prev = t.integration!.pr;
    // The closed pull request stays on the record only so the next one takes the next number.
    t.integration = { status: "pending", ...(prev ? { pr: prev } : {}) };
    const mode = deliveryMode(s);
    event(
      s,
      now,
      "user",
      "integration",
      !prOn
        ? `Deliver through the current mode (${mode === "local" ? `local branch ${s.project.autonomy.autoDeliver.branch}` : "off: the integration branch only"}): its pull request stays closed`
        : prev
          ? `Deliver again: a new pull request (${prBranch(s.project.id, t.id, prev.n + 1)}) will be prepared`
          : "Deliver as a pull request",
      t.id,
    );
  }
  return s;
}
