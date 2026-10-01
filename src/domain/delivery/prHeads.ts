// Integration in pull-request mode: the service reports the head it built for a task or pushed for a fix,
// and the pull request moves to the new change.

import * as M from "../model";
import { type PrDelivery, type ChangeAuthor, type State, type Task } from "../types";
import { event, getTask, sha12 } from "./core";
import { refreshAttention } from "./gate";
import { prBranch, prName } from "./pr";
import { cancelLinked, repairTarget } from "./repair";
import { reviewCoverage } from "./review";

interface PrHeadFacts {
  n: number;
  /** Full SHA of the task's final commit: the pull request head. */
  sha: string;
  /** The base tip the head contains. */
  baseSha: string;
  changed: PrDelivery["changed"];
  simulated?: boolean;
}

/** The task's final commit is prepared as a pull-request head. Nothing has been pushed yet. */
export function reportPrHead(state: State, taskId: string, f: PrHeadFacts, now: string): State {
  const t = getTask(state, taskId);
  const p = state.project;
  const cfg = p.prDelivery;
  const author = changeAuthorOf(state, t);
  const branch = prBranch(p.id, t.id, f.n);
  const pr: PrDelivery = {
    n: f.n,
    repo: p.github?.repo ?? "",
    remote: cfg.remote,
    base: cfg.base,
    branch,
    ...(f.simulated ? { simulated: true } : {}),
    changeSha: f.sha,
    changeTaskId: t.id,
    changeAuthor: author,
    changeAuthors: changeAuthorsOf(state, t),
    headSha: f.sha,
    baseSha: f.baseSha,
    changed: f.changed,
    // The project's choice; the user can change it for this one pull request.
    policy: cfg.merge,
    policySource: "project",
    phase: "built",
    review: { ok: false, source: "none", reason: "Not evaluated yet.", forSha: f.sha, artifactIds: [] },
    reviewTaskIds: [],
    repairTaskIds: [],
    counters: { mergeAttempts: 0, baseUpdates: 0, repairs: 0, reviews: 0, failures: 0, reruns: 0, checks: 0 },
  };
  const s = structuredClone(M.reportIntegration(state, taskId, { status: "integrated", sha: f.sha, ref: `${sha12(f.sha)} on ${branch}`, pr }, now));
  const built = getTask(s, taskId);
  if (built.integration?.pr) built.integration.pr.review = reviewCoverage(s, built);
  refreshAttention(s, built, now);
  return s;
}

/**
 * Who wrote a task's final change: the provider of the run that produced the commit; the user only
 * when their edit supplied another commit; "unknown" when the run is not on record (never "user":
 * an unknown author gets no pass on the independent review).
 */
function changeAuthorOf(s: State, t: Task): ChangeAuthor {
  const change = M.finalChange(s, t) ?? s.artifacts.filter((a) => a.taskId === t.id && a.kind === "code-change").pop();
  return change ? M.artifactAuthor(s, change) : "unknown";
}

/**
 * Everyone who authored a commit of a task's change: every run that produced a code change in it (an
 * earlier coder step, a repair round, a run that was done again on another provider), and the user
 * where they supplied a commit.
 */
function changeAuthorsOf(s: State, t: Task): ChangeAuthor[] {
  const out = new Set<ChangeAuthor>();
  for (const a of s.artifacts) if (a.taskId === t.id && a.kind === "code-change") out.add(M.artifactAuthor(s, a));
  out.add(changeAuthorOf(s, t));
  return [...out];
}

/**
 * A finished fix task's final commit becomes the pending head of the pull request it repairs; the planner
 * pushes it later. Nothing is pushed here. `descends`: the commit contains the pull request's current head,
 * so the push is a plain fast-forward; otherwise the fix is stale and is not delivered.
 */
export function reportRepairHead(state: State, repairTaskId: string, f: PrHeadFacts & { descends: boolean }, now: string): State {
  const repair = getTask(state, repairTaskId);
  if (repair.lifecycle !== "done" || repair.integration?.status !== "pending") return state;
  const target = repairTarget(state, repair);
  // The pull request is gone (merged, closed, taken over): the caller delivers the fix on its own.
  if (!target) return state;
  if (!f.descends) return M.reportIntegration(state, repairTaskId, { status: "not-needed", message: `stale: the head of ${prName(target.pr)} moved after this fix started, so it was not pushed` }, now);
  // A push in flight decides the head first.
  if (target.pr.op) return M.reportIntegrationError(state, repairTaskId, `waiting for an operation on ${prName(target.pr)} to finish`, now);
  const s = structuredClone(state);
  const rt = getTask(s, repairTaskId);
  const t = getTask(s, target.task.id);
  const pr = t.integration!.pr!;
  // The fix adds its authors to the pull request's; it never replaces them. The pull request still
  // holds the earlier commits, so a review must be independent of everyone who wrote any of it.
  pr.pendingHead = { sha: f.sha, changeSha: f.sha, changeTaskId: rt.id, changeAuthor: changeAuthorOf(s, rt), changeAuthors: [...new Set([...M.prAuthors(pr), ...changeAuthorsOf(s, rt)])], baseSha: f.baseSha, kind: "repair" };
  // What the pull request will hold once the fix is pushed. A fix that touches CI workflow files is
  // never pushed on an earlier permission: it is asked for again.
  pr.changed = f.changed;
  if (f.changed.workflowHits.length) delete pr.workflowPushAllowed;
  delete pr.nextAt;
  rt.integration = { status: "integrated", at: now, sha: f.sha, ref: `${sha12(f.sha)} → ${prName(pr)} of ${t.id}` };
  event(s, now, "system", "integration", `Fix ${sha12(f.sha)} is ready for ${prName(pr)} of ${t.id}; it is pushed onto that pull request, not opened as its own`, rt.id);
  refreshAttention(s, t, now);
  return s;
}

/** The pending head is on the remote branch: it becomes the pull request's head. Mutates the draft; returns the state to continue with. */
export function promoteHead(s: State, taskId: string, now: string): State {
  const t = getTask(s, taskId);
  const pr = t.integration!.pr!;
  const p = pr.pendingHead;
  if (!p) return s;
  const before = pr.changeAuthor;
  pr.headSha = p.sha;
  pr.baseSha = p.baseSha;
  pr.changeSha = p.changeSha;
  pr.changeTaskId = p.changeTaskId;
  pr.changeAuthor = p.changeAuthor;
  // Only ever grows: every author of a commit the pull request holds stays an author.
  pr.changeAuthors = [...new Set([...M.prAuthors({ ...pr, changeAuthor: before }), ...(p.changeAuthors ?? [p.changeAuthor])])];
  delete pr.pendingHead;
  // Everything that was bound to the old head is void: the Merge click, the attempts, what GitHub showed.
  delete pr.mergeRequested;
  delete pr.headSince;
  delete pr.observed;
  delete pr.baseConflict;
  delete pr.message;
  delete pr.nextAt;
  // The re-run budget is per head.
  delete pr.ciReruns;
  pr.counters.mergeAttempts = 0;
  pr.counters.failures = 0;
  if (p.kind === "update") {
    event(s, now, "system", "integration", `Brought ${prName(pr)} up to date with ${pr.base} (${sha12(p.baseSha)}): pushed ${sha12(p.sha)} as a fast-forward. Its checks run again; the reviewed change ${sha12(pr.changeSha)} is unchanged, so the review is not repeated`, t.id);
  } else {
    event(s, now, "system", "integration", `Pushed the fix from ${p.changeTaskId} onto ${prName(pr)} (${sha12(p.sha)}) as a fast-forward. It is reviewed and checked again`, t.id);
  }
  let out = s;
  if (p.kind === "repair") {
    // Reviews and check runs of the change this pull request no longer holds must never count, and need not finish.
    const stale = s.tasks.filter((x) => (x.reviewTarget?.taskId === t.id && x.reviewTarget.n === pr.n && x.reviewTarget.headSha !== pr.changeSha) || (x.checkTarget?.taskId === t.id && x.checkTarget.n === pr.n && x.checkTarget.sha !== pr.changeSha)).map((x) => x.id);
    out = cancelLinked(s, stale, now, `${prName(pr)} holds a newer change`);
  }
  const t2 = getTask(out, taskId);
  t2.integration!.pr!.review = reviewCoverage(out, t2);
  refreshAttention(out, t2, now);
  return out;
}
