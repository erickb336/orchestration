// Bounded repair into the open pull request: what needs fixing and the fix task that pushes onto the same
// branch. advanceDelivery, called every cycle, keeps each pull request's review, checks and repair moving.

import * as C from "../checks";
import * as F from "../findings";
import * as M from "../model";
import { flowRef, serviceFlow } from "../flows";
import { clip } from "../text";
import { ControlError, type CheckObs, type PrDelivery, type SpecContent, type State, type Task } from "../types";
import { classOf, gateCheckNames } from "./ciTriage";
import { openPr } from "./commands";
import { event, getTask, GITHUB_URL, sha12 } from "./core";
import { announceReady, dropStaleUpdate, refreshAttention } from "./gate";
import { livePr, PR_LIMITS, prName, prTask, trackedPrTasks } from "./pr";
import { ensureReview, mayStartWork, reviewView } from "./review";
import { ensureChecks } from "./serviceChecks";

type RepairCause =
  | { kind: "checks"; checks: { name: string; url?: string }[] }
  | { kind: "service-checks"; sha: string; results: { id: string; label: string; exitCode?: number }[] }
  | { kind: "findings"; summaries: string[] }
  | { kind: "conflict"; files: string[] };

/** A fix task of this pull request that is still working, or finished and not yet placed on the pull request. */
export function openRepair(s: State, pr: PrDelivery): Task | undefined {
  return s.tasks.find((x) => pr.repairTaskIds.includes(x.id) && x.lifecycle !== "cancelled" && (x.lifecycle !== "done" || x.integration?.status === "pending"));
}

/** A repair that was pushed onto another task's pull request: it is delivered there and has no delivery of its own. */
export const deliveredInto = (t: Task) => !!t.deliverInto && t.integration?.status === "integrated" && !t.integration.pr;

/** The live pull request a finished repair task belongs on, if it is still there. */
export function repairTarget(s: State, repair: Task): { task: Task; pr: PrDelivery } | undefined {
  const d = repair.deliverInto;
  const task = d && s.tasks.find((x) => x.id === d.taskId);
  const pr = task && livePr(task);
  return task && pr && pr.n === d!.n && (pr.phase === "built" || pr.phase === "open") && !pr.foreignHead && !pr.closeRequested ? { task, pr } : undefined;
}

/**
 * What is wrong with the current head that a fix task could cure: a conflict, a failed required check,
 * or open findings. Only `code` failures are a fix task's business; a cancelled run, a
 * skipped check and a review bot's opinion are not. `byUser` (the Fix this PR button) may also take
 * on a review bot's failing check, by name and link only.
 */
export function repairCause(s: State, t: Task, o: { byUser?: boolean } = {}): RepairCause | undefined {
  const pr = livePr(t);
  if (!pr || pr.pendingHead || (pr.phase !== "built" && pr.phase !== "open")) return undefined;
  const ob = pr.observed;
  if (pr.baseConflict?.headSha === pr.headSha && pr.baseConflict.baseSha === s.project.github?.base?.sha) return { kind: "conflict", files: pr.baseConflict.files.slice(0, 20) };
  if (ob && ob.state === "OPEN" && ob.headSha === pr.headSha && (ob.mergeable === "CONFLICTING" || ob.mergeStateStatus === "DIRTY")) return { kind: "conflict", files: [] };
  if (ob && ob.state === "OPEN" && ob.checksFor === pr.headSha) {
    const failed = gateCheckNames(s, pr, ob.checks)
      .map((n) => ob.checks.find((c) => c.name === n))
      .filter((c): c is CheckObs => !!c && c.conclusion !== null && c.conclusion !== "SUCCESS")
      .filter((c) => {
        const cls = classOf(s, pr, ob, c);
        return cls === "code" || (cls === "bot" && !!o.byUser);
      });
    // Names and links only: CI log text is untrusted input and never reaches an agent.
    if (failed.length) return { kind: "checks", checks: failed.map((c) => ({ name: c.name, ...(c.url && GITHUB_URL.test(c.url) ? { url: c.url } : {}) })) };
  }
  // The service's own checks failed on the change (under the current settings).
  if (C.checksOn(s.project.checks)) {
    const ev = C.checkEvidence(s, pr.changeSha);
    const art = !ev.ok && ev.attemptId ? s.artifacts.find((a) => a.attemptId === ev.attemptId && a.kind === "check-results") : undefined;
    const results = art?.checkRun ? C.failedResults(art.checkRun).filter((r) => r.kind === "check").map((r) => ({ id: r.id, label: r.label, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}) })) : [];
    if (results.length) return { kind: "service-checks", sha: pr.changeSha, results };
  }
  const v = reviewView(s, t);
  if (v.state === "findings") {
    // Only what a repair may fix is listed (auto-fix findings and those decided "fix"), each
    // with its decision. When only undecided ask-user findings remain, no fix task can be started.
    const arts = s.artifacts.filter((a) => v.evidence.artifactIds.includes(a.id) && F.unresolved(s, a) > 0);
    const summaries: string[] = [];
    for (const a of arts) {
      if (!a.findings) {
        if ((a.openFindings ?? 0) > 0) summaries.push(clip(a.summary, 1200));
        continue;
      }
      for (const f of a.findings) {
        if (!F.isBlocking(f)) continue;
        const d = F.decisionFor(s, a, f);
        if (f.action !== "auto-fix" && d?.status !== "fix") continue;
        summaries.push(clip(`${f.id} [${f.severity}]${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""} — ${f.title}${f.detail ? `: ${f.detail}` : ""}${d ? ` (${F.decisionLabel(d)})` : ""}`, 1200));
      }
    }
    return summaries.length ? { kind: "findings", summaries } : undefined;
  }
  return undefined;
}

/**
 * The review's open findings are all ask-user findings nobody has decided yet: how many, and who takes them, in words
 * ("you", "the lead", "the PE", or several of them, as their decisions are routed).
 */
export function onlyUndecided(s: State, t: Task): { count: number; who: string } | undefined {
  const v = reviewView(s, t);
  if (v.state !== "findings") return undefined;
  const arts = s.artifacts.filter((a) => v.evidence.artifactIds.includes(a.id));
  let undecided = 0;
  let lead = 0;
  let pe = 0;
  let user = 0;
  for (const a of arts) {
    if (F.fixable(s, a) > 0) return undefined;
    if (!a.findings) return undefined;
    undecided += F.undecided(s, a);
    for (const f of a.findings) {
      if (!F.isBlocking(f) || f.action !== "ask-user") continue;
      const d = F.decisionFor(s, a, f);
      if (d && d.status !== "open") continue;
      if (!d || d.routedTo === "lead") lead++;
      else if (d.routedTo === "pe") pe++;
      else user++;
    }
  }
  if (!undecided) return undefined;
  const deciders = [user && "you", lead && "the lead", pe && "the PE"].filter((x): x is string => !!x);
  return { count: undecided, who: deciders.length > 1 ? `${deciders.slice(0, -1).join(", ")} and ${deciders.at(-1)}` : deciders[0] };
}

/** Create the fix task and link it. Returns the new state (a fresh object) and the task's id. */
function startRepair(state: State, taskId: string, cause: RepairCause, now: string, actor: "user" | "system"): { state: State; newId: string } {
  const origin = getTask(state, taskId);
  const pr0 = origin.integration!.pr!;
  const title = M.currentSpec(origin).content.title;
  const h = sha12(pr0.headSha);
  // A fix runs the Change flow, chosen by the service.
  const change = serviceFlow(state, "change");
  const r = M.createFollowUp(state, taskId, now, {
    steps: structuredClone(change.steps),
    flow: flowRef(change, "service"),
    holdBeforeStart: false,
    author: actor,
    dependsOn: [],
    fields: { deliverInto: { taskId, n: pr0.n, mergeBase: cause.kind === "conflict" } },
  });
  const content: SpecContent = structuredClone(M.currentSpec(getTask(r.state, r.newId)).content);
  const selected = content.options.find((o) => o.id === content.selectedOptionId);
  const what =
    cause.kind === "checks"
      ? `the required check${cause.checks.length === 1 ? "" : "s"} ${cause.checks.map((c) => c.name).join(", ")} failed on ${h}`
      : cause.kind === "service-checks"
        ? `the project's check${cause.results.length === 1 ? "" : "s"} ${cause.results.map((c) => c.label).join(", ")} failed on ${sha12(cause.sha)} (run by the service)`
        : cause.kind === "findings"
          ? `the review of ${sha12(pr0.changeSha)} reported open findings`
          : `it conflicts with ${pr0.base}`;
  content.title = `Fix ${prName(pr0)}: ${title}`;
  content.whyNow = `${prName(pr0)} of ${taskId} cannot merge: ${what}.`;
  content.outcome = cause.kind === "conflict" ? `The pull request of ${taskId} merges cleanly into ${pr0.base}, with both sides' work kept.` : `The pull request of ${taskId} passes its required checks and its review, with its original outcome intact.`;
  content.scopeIncluded =
    cause.kind === "checks"
      ? cause.checks.map((c) => `Make the required check "${c.name}" pass${c.url ? ` (${c.url})` : ""}. Find the cause in the code; do not weaken tests, CI or build scripts.`)
      : cause.kind === "service-checks"
        ? cause.results.map((c) => `Make the project's check "${c.label}" pass${c.exitCode !== undefined ? ` (it exited ${c.exitCode})` : ""}; its output is in the check results this task's steps read. Find the cause in the code; do not weaken tests, CI or build scripts.`)
        : cause.kind === "findings"
          ? cause.summaries.map((x) => `Open review finding: ${x}`)
          : [`Resolve the conflict with ${pr0.base}${cause.files.length ? ` in ${cause.files.join(", ")}` : ""}, keeping the work of both sides.`];
  content.scopeExcluded = ["Any change beyond what is needed to fix this pull request", "Weakening tests, CI or build scripts"];
  content.successCriteria = [];
  content.acceptance = [cause.kind === "conflict" ? "No conflict markers remain and both sides' behaviour is kept" : "The reported problem is fixed", `The original outcome still holds: ${clip(M.currentSpec(origin).content.outcome, 300)}`];
  if (selected) selected.approach = `Fix the pull request of ${taskId} on top of its current head ${h}: ${what}. The result is pushed onto the same pull request and reviewed again.`;
  const s = structuredClone(M.editSpec(r.state, r.newId, 1, content, `Fix for ${prName(pr0)} of ${taskId}`, actor, now));
  const t = getTask(s, taskId);
  const pr = t.integration!.pr!;
  pr.repairTaskIds.push(r.newId);
  pr.counters.repairs += 1;
  event(s, now, actor, "integration", `Fix task ${r.newId} created for ${prName(pr)} (${pr.counters.repairs} of ${PR_LIMITS.repairs}): ${what}. Its result is pushed onto the same pull request.`, taskId);
  return { state: s, newId: r.newId };
}

/**
 * One bounded fix task whose result is pushed onto the same pull request. At most
 * PR_LIMITS.repairs per pull request and one at a time. `byUser`: the Fix this PR button; it does not
 * need automatic repair to be on, and it counts against the same cap.
 */
export function createRepair(state: State, taskId: string, cause: RepairCause, now: string, o: { byUser?: boolean } = {}): { state: State; newId: string } {
  const { pr } = prTask(state, taskId);
  if (pr.phase !== "built" && pr.phase !== "open") throw new ControlError(`${taskId}'s pull request is ${pr.phase}; there is nothing to fix.`);
  if (pr.foreignHead) throw new ControlError("Someone else pushed to this pull request; the app does not push to it again.");
  if (pr.counters.repairs >= PR_LIMITS.repairs) throw new ControlError(`${PR_LIMITS.repairs} fix tasks already ran for this pull request. Fix it yourself on GitHub, or close it and deliver again.`);
  const open = openRepair(state, pr);
  if (open) throw new ControlError(`${open.id} is already fixing this pull request.`);
  if (pr.pendingHead?.kind === "repair") throw new ControlError("A fix is waiting to be pushed onto this pull request.");
  if (!o.byUser && (pr.policy !== "auto" || !state.project.prDelivery.autoRepair)) throw new ControlError("Automatic repair runs only for pull requests that merge automatically.");
  const r = startRepair(state, taskId, cause, now, o.byUser ? "user" : "system");
  refreshAttention(r.state, getTask(r.state, taskId), now);
  return r;
}

/** The Fix this PR button: a fix task for what is wrong with the pull request now. */
export function repairPr(state: State, taskId: string, now: string): { state: State; newId: string } {
  const { task } = openPr(state, taskId, "fix");
  if (!state.project.prDelivery.enabled) throw new ControlError("Pull-request delivery is off, so a fix could not be pushed. Switch the delivery mode back on first.");
  const cause = repairCause(state, task, { byUser: true });
  if (!cause) throw new ControlError("Nothing a fix task could cure was found: no required check failed on the code, no open review finding and no conflict on this head. A cancelled or skipped check is re-run on GitHub, not fixed.");
  return createRepair(state, taskId, cause, now, { byUser: true });
}

export function cancelLinked(state: State, ids: string[], now: string, reason: string): State {
  let s = state;
  for (const id of ids) {
    const x = s.tasks.find((t) => t.id === id);
    if (x && x.lifecycle !== "done" && x.lifecycle !== "cancelled") s = M.cancelTask(s, id, now, { actor: "system", reason });
  }
  return s;
}

/**
 * Keep every tracked pull request's review and repair moving: record the review evidence for the
 * change it holds, start the one dedicated review it needs, start a bounded fix when it merges
 * automatically, and refresh what it is waiting for. The service calls this every cycle; it changes
 * nothing when nothing changed. New tasks are created only while pull-request delivery is on and
 * neither the project nor the pull request is paused.
 */
export function advanceDelivery(state: State, now: string): State {
  if (trackedPrTasks(state).length === 0) return state;
  let s = structuredClone(state);
  for (const id of trackedPrTasks(s).map((t) => t.id)) {
    dropStaleUpdate(s, getTask(s, id), now);
    getTask(s, id).integration!.pr!.review = reviewView(s, getTask(s, id)).evidence;
    // The service-check evidence for the change it holds, under the current settings.
    if (C.checksOn(s.project.checks)) getTask(s, id).integration!.pr!.checks = C.checkEvidence(s, getTask(s, id).integration!.pr!.changeSha);
    else delete getTask(s, id).integration!.pr!.checks;
    // The one dedicated review the change needs (it returns the same state when none is needed or allowed).
    s = ensureReview(s, id, now);
    // And the one check run it needs, when the change has no result of its own.
    s = ensureChecks(s, id, now);
    let t = getTask(s, id);
    let pr = t.integration!.pr!;
    const cfg = s.project.prDelivery;
    const may = mayStartWork(s, pr);
    if (may && pr.policy === "auto" && cfg.autoRepair && pr.counters.repairs < PR_LIMITS.repairs && !openRepair(s, pr) && !pr.pendingHead) {
      const cause = repairCause(s, t);
      if (cause) {
        s = startRepair(s, id, cause, now, "system").state;
        t = getTask(s, id);
        pr = t.integration!.pr!;
      }
    }
    refreshAttention(s, t, now);
    // A review that finishes after the checks passed makes a held pull request ready between two reads of GitHub.
    announceReady(s, t, now);
  }
  return s;
}
