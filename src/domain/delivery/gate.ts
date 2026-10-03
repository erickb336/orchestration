// The merge queue (one automatic merge candidate at a time) and the merge gate: what a pull request
// still waits for, and what needs the user's attention.

import * as C from "../checks";
import * as M from "../model";
import { clip } from "../text";
import { type GitHubStatus, type PrAttentionCode, type PrDelivery, type State, type Task } from "../types";
import { awaitingRerun, checkLine, type CiClass, classOf, gateCheckNames, rerunBlocker, rerunPlan, rerunsUsed, triageContext } from "./ciTriage";
import { event, sha12 } from "./core";
import { livePr, openPrTasks, openSlotsFull, PR_LIMITS, prName } from "./pr";
import { onlyUndecided, openRepair } from "./repair";
import { reviewView } from "./review";
import { checkTasksFor } from "./serviceChecks";

/** Pull requests that may merge automatically, oldest first. Blocked ones drop out, so the next proceeds. */
export function autoQueue(s: State): Task[] {
  return openPrTasks(s).filter((t) => {
    const pr = t.integration!.pr!;
    return pr.policy === "auto" && pr.number !== undefined && !pr.userHold && !pr.foreignHead && !pr.closeRequested && !pr.attention && !wrongRepo(s, pr) && pr.review.ok && pr.review.forSha === pr.changeSha;
  });
}

/**
 * A base update is prepared only for the merge candidate. When the pull request stops being it (it was
 * switched to hold, held, or blocked) before the prepared head was pushed, the head is dropped: nothing
 * the user did not ask for is pushed onto a pull request they now merge themselves. Mutates the draft.
 */
export function dropStaleUpdate(s: State, t: Task, now: string) {
  const pr = livePr(t);
  if (!pr || pr.pendingHead?.kind !== "update" || pr.op?.kind === "push") return;
  if (autoQueue(s)[0]?.id === t.id) return;
  const dropped = pr.pendingHead;
  delete pr.pendingHead;
  // It was never pushed, so it does not count against the cap.
  pr.counters.baseUpdates = Math.max(0, pr.counters.baseUpdates - 1);
  event(s, now, "system", "integration", `The prepared update of ${prName(pr)} (${sha12(dropped.sha)}) was dropped and not pushed: it no longer merges automatically next`, t.id);
}

/** The only pull request that is ever brought up to date with the base or merged automatically. */
export function mergeCandidate(s: State): Task | undefined {
  return s.project.prDelivery.enabled && !s.project.hold ? autoQueue(s)[0] : undefined;
}

/** The pull request this one waits behind in the merge queue, if any. */
export function queueAhead(s: State, t: Task): Task | undefined {
  const q = autoQueue(s);
  const i = q.indexOf(q.find((x) => x.id === t.id)!);
  return i > 0 ? q[0] : undefined;
}

function autoMergesToday(gh: GitHubStatus | undefined, nowMs: number): number {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return gh?.autoMerges?.day === day ? gh.autoMerges.count : 0;
}

/** The pull request was opened in another repository than the one the remote names now. */
export function wrongRepo(s: State, pr: PrDelivery): boolean {
  const now = s.project.github?.repo;
  return !!now && !!pr.repo && pr.repo !== now;
}

export interface GateItem {
  id: "policy" | "not-paused" | "github" | "ours" | "head" | "checks" | "mergeable" | "no-stop" | "review" | "service-checks" | "paths" | "auto" | "up-to-date" | "attempts";
  label: string;
  ok: boolean;
  detail: string;
  state: "ok" | "waiting" | "blocked";
  /** The reason shown as "needs you" when this item blocks. */
  code?: PrAttentionCode;
  /** Shown and reported, but a user's own merge does not wait for it (the user replaces the agent review). */
  advisory?: boolean;
}
export interface Gate {
  status: "ready" | "waiting" | "blocked";
  items: GateItem[];
}

const APPROVAL_TEXT =
  "GitHub requires an approval the app cannot give. This may be the ruleset's require_extra_approval_for_unattributed_changes applied to commits authored by Orchestrator. Merge on GitHub, approve from another account, or change the ruleset.";

/** The names of the required checks for a pull request: from the repository's rules and from GitHub's own marking. */
export function requiredCheckNames(s: State, pr: PrDelivery): string[] {
  return [...new Set([...(s.project.github?.requiredChecks ?? []), ...(pr.observed?.checks.filter((c) => c.required).map((c) => c.name) ?? [])])];
}

/**
 * May this pull request be merged now? Evaluated for `pr.headSha`. Pure; the UI shows the same list.
 * `byUser`: the user's Merge click. It replaces the agent review and the rules that belong to
 * automatic merging (items 9 to 12), and never GitHub's checks or rules. Without it the gate is the
 * automatic one: the policy must be "auto", an independent review must be clean for exactly this
 * change, and nothing may be paused.
 */
export function prGate(s: State, task: Task, nowMs: number, o: { byUser: boolean }): Gate {
  const pr = livePr(task);
  if (!pr) return { status: "blocked", items: [] };
  const gh = s.project.github;
  const cfg = s.project.prDelivery;
  const ob = pr.observed;
  const items: GateItem[] = [];
  const add = (id: GateItem["id"], label: string, state: GateItem["state"], detail: string, code?: PrAttentionCode, advisory?: boolean) =>
    items.push({ id, label, ok: state === "ok", detail, state, ...(code ? { code } : {}), ...(advisory ? { advisory } : {}) });
  const headAge = pr.headSince ? nowMs - Date.parse(pr.headSince) : 0;
  const h12 = sha12(pr.headSha);

  // 1. Policy
  if (o.byUser) {
    if (pr.mergeRequested?.headSha === pr.headSha) add("policy", "Merge requested", "ok", `You asked to merge ${h12}.`);
    else add("policy", "You merge this pull request", "waiting", `It merges when you choose Merge for ${h12}, or merge it on GitHub.`);
  } else if (pr.policy === "auto") add("policy", "Merges automatically", "ok", "It merges by itself once everything below holds for this exact commit.");
  else add("policy", "You merge this pull request", "waiting", `It merges when you choose Merge for ${h12}, or merge it on GitHub.`);

  // 2. Not paused (shaping is not a pause, but no delivery work starts until building)
  if (s.project.hold) add("not-paused", "Not paused", "waiting", "The project is paused: nothing is pushed, opened, merged or commented.");
  else if (pr.userHold) add("not-paused", "Not paused", "waiting", `Kept for you${pr.userHold.reason ? `: ${pr.userHold.reason}` : ""}. Nothing is pushed, merged or commented until you let it continue.`);
  else if (pr.closeRequested) add("not-paused", "Not paused", "waiting", "You asked to close this pull request.");
  else if (s.project.stage === "shaping") add("not-paused", "Not paused", "waiting", "Vision: nothing is pushed, opened, merged or brought up to date until you start the factory. Nothing is paused.");
  else add("not-paused", "Not paused", "ok", "No pause or hold.");

  // 3. GitHub reachable, the same repository, and a repository the app can merge in
  if (wrongRepo(s, pr))
    add("github", "GitHub reachable", "blocked", `This pull request was opened in ${pr.repo}, but the remote ${pr.remote} now points at ${gh!.repo}. The app does not read, push, merge or close it there. Point the remote back at ${pr.repo}, or close this delivery and deliver again.`, "repo-changed");
  else if (!gh?.ok) add("github", "GitHub reachable", "waiting", gh?.problem ? gh.problem.message : "The repository has not been checked yet.");
  else if (!gh.checkedAt || nowMs - Date.parse(gh.checkedAt) > PR_LIMITS.preflightMaxAgeMs) add("github", "GitHub reachable", "waiting", "The repository check is more than 6 hours old; it is being repeated.");
  else if (gh.mergeQueue)
    add("github", "GitHub reachable", "blocked", `${pr.base} requires a merge queue. A merge from the app would enqueue the pull request or switch on GitHub's own auto-merge, which the app never uses. Merge it on GitHub.`, "github-blocked");
  else if (gh.mergeCommitsAllowed === false) add("github", "GitHub reachable", "blocked", "This repository does not allow merge commits, and the app merges only with a merge commit. Allow them in the repository settings, or merge on GitHub.", "github-blocked");
  else add("github", "GitHub reachable", "ok", `${gh.repo ?? pr.repo}${gh.login ? ` as ${gh.login}` : ""}.`);

  // 4. It is our pull request
  if (pr.foreignHead) add("ours", "Only Orchestrator's commits", "blocked", `Someone else pushed ${sha12(pr.foreignHead.sha)} to this branch. The app will not push to it or merge it again; merge it on GitHub, or close it and deliver again.`, "foreign-push");
  else if (!ob) add("ours", "Open on GitHub", "waiting", pr.phase !== "built" ? "Not seen on GitHub yet." : openSlotsFull(s) ? `Not opened yet: ${openSlotsFull(s)}. It opens when one of them merges or closes, or when you raise the limit in Settings.` : "Not opened yet.");
  else if (ob.state !== "OPEN") add("ours", "Open on GitHub", "waiting", `GitHub reports it ${ob.state.toLowerCase()}.`);
  else if (ob.crossRepo) add("ours", "Open on GitHub", "blocked", "GitHub reports this pull request as coming from another repository; the app only acts on its own.", "foreign-push");
  else if (ob.isDraft) add("ours", "Open on GitHub", "blocked", "It was marked as a draft on GitHub. Mark it ready for review there.", "draft");
  else if (ob.baseRef !== pr.base) add("ours", "Open on GitHub", "blocked", `Its base was changed to ${ob.baseRef} on GitHub; the app opened it against ${pr.base}.`, "base-changed");
  else add("ours", "Open on GitHub", "ok", `Open against ${pr.base}.`);

  // 5. Head matches
  if (!ob) add("head", "The commit you saw", "waiting", "Not seen on GitHub yet.");
  else if (pr.pendingHead) add("head", "The commit you saw", "waiting", pr.pendingHead.kind === "update" ? `A newer head (${sha12(pr.pendingHead.sha)}), brought up to date with ${pr.base}, is being pushed.` : `A fix (${sha12(pr.pendingHead.sha)}) is being pushed onto it.`);
  else if (ob.headSha !== pr.headSha) add("head", "The commit you saw", "blocked", `GitHub shows ${sha12(ob.headSha)}, not ${h12}.`, "foreign-push");
  else add("head", "The commit you saw", "ok", `GitHub shows ${h12}.`);

  // 6. Required checks, for exactly this head. Each failing check is classed (bot,
  //    provider, not-run, code); a cancelled Actions job is re-run once before anything else; the
  //    user's "no CI" declaration lets their own Merge through with zero checks, never an automatic one.
  const names = gateCheckNames(s, pr, ob?.checks ?? []);
  let checksOk = false;
  if (!ob) add("checks", "Required checks", "waiting", "Not seen on GitHub yet.");
  else if (ob.checksFor !== pr.headSha) add("checks", "Required checks", "waiting", "The check results GitHub shows belong to another commit.");
  else if (names.length === 0) {
    if (cfg.noCi && o.byUser) {
      checksOk = true;
      add("checks", "Required checks", "ok", `No CI: you declared this repository has no CI, and GitHub reports no check on ${h12}.`);
    } else if (cfg.noCi)
      add("checks", "Required checks", "blocked", `You declared this repository has no CI, and GitHub reports no check on ${h12}. Automatic merging still needs a required check; merge this one yourself.`, "checks-missing");
    else add("checks", "Required checks", "blocked", `GitHub lists no required check for ${pr.base}. The app merges only what a required check has passed; merge this one on GitHub, or add a required check.`, "checks-missing");
  } else {
    const of = (n: string) => ob.checks.find((c) => c.name === n);
    const failed = names.filter((n) => {
      const c = of(n);
      return !!c && c.conclusion !== null && c.conclusion !== "SUCCESS" && !awaitingRerun(pr, c, nowMs);
    });
    const pending = names.filter((n) => !of(n) || of(n)!.conclusion === null || awaitingRerun(pr, of(n)!, nowMs));
    if (failed.length) {
      const checks = failed.map((n) => of(n)!);
      const classes = checks.map((c) => classOf(s, pr, ob, c));
      const lines = checks.map((c) => checkLine(cfg, c, triageContext(s, pr, ob, c))).join("; ");
      const first = (cls: CiClass) => checks[classes.indexOf(cls)];
      if (classes.includes("code")) add("checks", "Required checks", "blocked", lines, "checks-failed");
      else if (classes.includes("bot")) {
        const c = first("bot");
        add("checks", "Required checks", "blocked", `The review bot ${c.app} reports ${(c.conclusion ?? "").toLowerCase().replace(/_/g, " ")} on ${h12}. A bot's opinion is not fixed automatically. Read it on GitHub, then merge, or choose Fix this PR. ${lines}`, "bot-check");
      } else if (classes.includes("not-run")) {
        const c = first("not-run");
        add("checks", "Required checks", "blocked", `The required check ${c.name} did not run on ${h12}, so nothing shows this head passes. Re-run it on GitHub, or merge it yourself. ${lines}`, "checks-skipped");
      } else if (rerunPlan(s, pr, nowMs)) {
        const used = rerunsUsed(pr).length;
        add("checks", "Required checks", "waiting", `GitHub cancelled ${checks.map((c) => c.name).join(", ")} on ${h12}. It is re-run (${used} of ${cfg.rerunBudget} per check used on this head). ${lines}`);
      } else {
        // Every failed check was cancelled by GitHub and no re-run is planned right now:
        // the reason is the true one. A check that cannot be re-run needs a person; a re-run that
        // waits for something (another required check, the pause, a conflict) is a wait, not a block.
        const blocked = checks.map((c) => [c, rerunBlocker(s, pr, c)] as const).find(([, why]) => why);
        if (blocked) {
          const [c, why] = blocked;
          add("checks", "Required checks", "blocked", `GitHub cancelled ${c.name} on ${h12}${why}. Re-run it on GitHub, or merge it yourself. ${lines}`, "ci-infra");
        } else {
          const conflict = ob.mergeable === "CONFLICTING" || ob.mergeStateStatus === "DIRTY" || (pr.baseConflict?.headSha === pr.headSha && pr.baseConflict.baseSha === s.project.github?.base?.sha);
          const when = pending.length ? `once ${pending.join(", ")} has finished` : conflict ? `once the conflict with ${pr.base} is resolved` : s.project.hold || pr.userHold || pr.closeRequested ? "when the pause ends" : pr.pendingHead || pr.foreignHead ? "once the head is settled" : "next";
          add("checks", "Required checks", "waiting", `GitHub cancelled ${checks.map((c) => c.name).join(", ")} on ${h12}. It is re-run ${when} (${rerunsUsed(pr).length} of ${cfg.rerunBudget} per check used on this head). ${lines}`);
        }
      }
    } else if (pending.length) {
      const reported = names.some((n) => !!of(n));
      const rerunning = pending.filter((n) => of(n) && awaitingRerun(pr, of(n)!, nowMs));
      if (rerunning.length) add("checks", "Required checks", "waiting", `Re-running ${rerunning.join(", ")} on ${h12} (GitHub had cancelled it); waiting for the new run.`);
      else if (!reported && headAge > PR_LIMITS.checksMissingMs) add("checks", "Required checks", "blocked", `No required check (${names.join(", ")}) has reported for 15 minutes. It may not run for this branch.`, "checks-missing");
      else if (headAge > PR_LIMITS.checksPendingMs) add("checks", "Required checks", "blocked", `Still waiting for ${pending.join(", ")} after 60 minutes.`, "checks-timeout");
      else add("checks", "Required checks", "waiting", `Waiting for ${pending.join(", ")}.`);
    } else {
      checksOk = true;
      const reruns = rerunsUsed(pr);
      add("checks", "Required checks", "ok", `${names.join(", ")} passed on ${h12}.${reruns.length ? ` ${reruns.map((u) => `${u.check} was re-run after GitHub cancelled it.`).join(" ")}` : ""}${!requiredCheckNames(s, pr).length ? " No check is required; these are the checks GitHub reported." : ""}`);
    }
  }

  // 7. GitHub's own view
  const updates = !o.byUser && cfg.updateBeforeMerge;
  if (!ob) add("mergeable", "GitHub says it can merge", "waiting", "Not seen on GitHub yet.");
  else if (ob.mergeable === "CONFLICTING" || ob.mergeStateStatus === "DIRTY") add("mergeable", "GitHub says it can merge", "blocked", `It conflicts with ${pr.base}. Resolve it on GitHub, or close it and deliver again.`, "conflict");
  else if (ob.mergeable !== "MERGEABLE" || ob.mergeStateStatus === "UNKNOWN") add("mergeable", "GitHub says it can merge", "waiting", "GitHub has not worked out yet whether it can merge.");
  else if (ob.mergeStateStatus === "CLEAN" || ob.mergeStateStatus === "HAS_HOOKS") add("mergeable", "GitHub says it can merge", "ok", "Mergeable and clean.");
  else if (ob.mergeStateStatus === "UNSTABLE") {
    if (headAge > PR_LIMITS.nonRequiredMs) add("mergeable", "GitHub says it can merge", "blocked", "Checks that are not required are failing or still running after 30 minutes. Merge on GitHub if that is acceptable.", "non-required-failing");
    else add("mergeable", "GitHub says it can merge", "waiting", "Checks that are not required are failing or still running.");
  } else if (ob.mergeStateStatus === "BEHIND") {
    if (updates) add("mergeable", "GitHub says it can merge", "waiting", `GitHub requires it to be up to date with ${pr.base}; the app brings it up to date before it merges.`);
    else add("mergeable", "GitHub says it can merge", "blocked", `GitHub requires it to be up to date with ${pr.base}. The app brings a pull request up to date only when it merges it automatically with "update before merge" on; merge on GitHub, or close it and deliver again.`, "github-blocked");
  } else if (ob.mergeStateStatus === "BLOCKED") {
    if (!checksOk) add("mergeable", "GitHub says it can merge", "waiting", "GitHub is waiting for its required checks.");
    else if (ob.reviewDecision === "REVIEW_REQUIRED") add("mergeable", "GitHub says it can merge", "blocked", APPROVAL_TEXT, "approval-required");
    else if (headAge > PR_LIMITS.githubBlockedMs) add("mergeable", "GitHub says it can merge", "blocked", `GitHub blocks the merge although the required checks passed. ${APPROVAL_TEXT}`, "github-blocked");
    else add("mergeable", "GitHub says it can merge", "waiting", "GitHub blocks the merge although the required checks passed; waiting to see whether that clears.");
  } else add("mergeable", "GitHub says it can merge", "waiting", `GitHub reports the state ${ob.mergeStateStatus.toLowerCase()}.`);

  // 8. No stop on GitHub
  if (!ob) add("no-stop", "No stop on GitHub", "waiting", "Not seen on GitHub yet.");
  else if (ob.reviewDecision === "CHANGES_REQUESTED") add("no-stop", "No stop on GitHub", "blocked", "A reviewer requested changes on GitHub.", "changes-requested");
  else if (ob.reviewDecision === "REVIEW_REQUIRED") add("no-stop", "No stop on GitHub", "blocked", APPROVAL_TEXT, "approval-required");
  else if (ob.labels.includes("orchestration:hold")) add("no-stop", "No stop on GitHub", "blocked", "The label orchestration:hold is set on GitHub. Remove it there to continue.", "hold-label");
  else add("no-stop", "No stop on GitHub", "ok", "No requested changes and no hold label.");

  // 9. Independent review, bound to the exact change. For a user merge it is shown and does not gate.
  const rv = reviewView(s, task);
  const recorded = pr.review.ok && pr.review.forSha === pr.changeSha;
  const REVIEW = "Independent review";
  const advisory = o.byUser;
  const note = advisory ? " You can still merge it yourself: your Merge replaces the agent review." : "";
  if (rv.state === "ok" && recorded) add("review", REVIEW, "ok", rv.evidence.reason, undefined, advisory);
  else if (rv.state === "findings") add("review", REVIEW, "blocked", `${rv.evidence.reason}${note}`, "review-findings", advisory);
  else if (rv.state === "blocked" || rv.state === "too-large") add("review", REVIEW, "blocked", `${rv.evidence.reason}${note}`, "review-blocked", advisory);
  else if (rv.state === "limit") add("review", REVIEW, "blocked", rv.evidence.reason, "review-limit", advisory);
  else if (rv.state === "pending") add("review", REVIEW, "waiting", rv.evidence.reason, undefined, advisory);
  else if (rv.state === "ok") add("review", REVIEW, "waiting", "The review result is being recorded.", undefined, advisory);
  else add("review", REVIEW, "waiting", `${rv.evidence.reason} One dedicated review is started for it${cfg.enabled && !s.project.hold && !pr.userHold ? "" : " once nothing is paused"}.`, undefined, advisory);

  // 9b. The project's own checks, run by the service on exactly this change under the
  // current settings. Shown while checks are on; for a user merge it is advisory, like the review.
  if (C.checksOn(s.project.checks)) {
    const ev = C.checkEvidence(s, pr.changeSha);
    const SC = "Service checks";
    const running = checkTasksFor(s, task, pr).find((x) => x.lifecycle !== "done" && x.lifecycle !== "cancelled");
    // Evidence from the service's own check task is named as such, so a task whose check steps
    // never ran (checks were off at the time) does not read as if they had passed.
    const elsewhere = ev.ok && ev.taskId && ev.taskId !== task.id ? ` Run by the service as ${ev.taskId} on this change${task.steps.some((st) => st.role === "checks" && st.state === "skipped") ? "; the task's own check steps did not run" : ""}.` : "";
    if (ev.ok) add("service-checks", SC, "ok", `${ev.reason}${elsewhere}`, undefined, advisory);
    else if (ev.attemptId) add("service-checks", SC, "blocked", `${ev.reason}${note}`, "service-checks", advisory);
    else if (running) add("service-checks", SC, "waiting", `${ev.reason} ${running.id} runs them.`, undefined, advisory);
    else if ((pr.counters.checks ?? 0) >= PR_LIMITS.checks) add("service-checks", SC, "blocked", `${ev.reason} ${PR_LIMITS.checks} check runs were already started for this pull request. Merge it yourself.`, "service-checks", advisory);
    else add("service-checks", SC, "waiting", `${ev.reason} One check run is started for it${cfg.enabled && !s.project.hold && !pr.userHold ? "" : " once nothing is paused"}.`, undefined, advisory);
  }

  if (!o.byUser) {
    // 10. Paths and workers
    const local = s.project.enabledProviders.filter((p) => s.project.workerEnvironment[p] === "local");
    if (pr.changed.protectedHits.length)
      add("paths", "Protected files and agents", "blocked", `It touches protected files (${pr.changed.protectedHits.slice(0, 5).join(", ")}), which control the checks or the build, so it is never merged automatically. Look at it and merge it yourself.`, "protected-path");
    else if (local.length && !cfg.allowLocalWorkers)
      add("paths", "Protected files and agents", "blocked", `An agent environment is set to "local" (${local.map(M.providerLabel).join(", ")}), which may expose your GitHub sign-in or a GitHub MCP server to agents. Automatic merging is off until the environment is isolated, or you allow local agents in Settings → Delivery. You can merge it yourself.`, "local-workers");
    else add("paths", "Protected files and agents", "ok", local.length ? "No protected file is touched. Local agent environments are allowed by your setting." : "No protected file is touched, and agents run isolated.");

    // 11. Automatic merging is available
    const used = autoMergesToday(gh, nowMs);
    if (gh?.autoMergeBlockers.length) add("auto", "Automatic merging available", "blocked", `Automatic merging is not available in this repository: ${gh.autoMergeBlockers.join("; ")}. Merge it yourself.`, "auto-unavailable");
    else if (gh?.autoMergePaused)
      add("auto", "Automatic merging available", "waiting", `Automatic merging is paused: ${gh.autoMergePaused.reason}. ${gh.autoMergePaused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again, or when you resume it."} You can merge this one yourself.`);
    else if (used >= cfg.maxAutoMergesPerDay) add("auto", "Automatic merging available", "blocked", `The limit of ${cfg.maxAutoMergesPerDay} automatic merge${cfg.maxAutoMergesPerDay === 1 ? "" : "s"} per day (UTC) is reached. It continues tomorrow; merge it yourself, or raise the limit in Settings → Delivery.`, "limit");
    else add("auto", "Automatic merging available", "ok", `${used} of ${cfg.maxAutoMergesPerDay} automatic merges used today.`);

    // 12. Up to date with the base, so the tree the checks ran on is the tree that lands
    const ahead = queueAhead(s, task);
    const UP = `Up to date with ${pr.base}`;
    if (ahead) add("up-to-date", UP, "waiting", `Waiting behind ${prName(ahead.integration!.pr!)}: pull requests merge one at a time, and only the first in line is brought up to date.`);
    else if (!cfg.updateBeforeMerge) add("up-to-date", UP, "ok", "Not required by your setting: the repository's own rule decides.");
    else if (!gh?.base) add("up-to-date", UP, "waiting", `${pr.base} has not been fetched yet.`);
    else if (s.tasks.some((x) => x.integration?.landed?.via === "pr" && x.integration.landed.at > gh.base!.fetchedAt))
      // The app knows the base moved (a pull request merged after the last fetch): what it fetched is stale.
      add("up-to-date", UP, "waiting", `${pr.base} changed after it was last fetched (a pull request merged); it is fetched again before anything else merges.`);
    else if (pr.baseConflict?.headSha === pr.headSha && pr.baseConflict.baseSha === gh.base.sha)
      add("up-to-date", UP, "blocked", `It conflicts with ${pr.base} (${sha12(gh.base.sha)})${pr.baseConflict.files.length ? ` in ${pr.baseConflict.files.slice(0, 10).join(", ")}` : ""}. Nothing was pushed.`, "conflict");
    else if (pr.baseSha !== gh.base.sha) {
      if (pr.counters.baseUpdates >= PR_LIMITS.baseUpdates)
        add("up-to-date", UP, "blocked", `${pr.base} moved again after the app brought this pull request up to date ${PR_LIMITS.baseUpdates} times. Merge it yourself, or close it and deliver again.`, "limit");
      else add("up-to-date", UP, "waiting", `${pr.base} is at ${sha12(gh.base.sha)}; this pull request is brought up to date with it, then its checks run again.`);
    } else if (nowMs - Date.parse(gh.base.fetchedAt) > PR_LIMITS.baseFreshMs) add("up-to-date", UP, "waiting", `${pr.base} is being fetched again before the merge.`);
    else add("up-to-date", UP, "ok", `Contains ${pr.base} at ${sha12(gh.base.sha)}.`);
  }

  // 13. Attempts
  if (pr.counters.mergeAttempts >= PR_LIMITS.mergeAttempts)
    add("attempts", "Merge attempts", "blocked", `GitHub refused the merge ${pr.counters.mergeAttempts} times${pr.message ? `: ${pr.message}` : ""}. Choose Merge to try once more, or merge on GitHub.`, "merge-rejected");
  else add("attempts", "Merge attempts", "ok", pr.counters.mergeAttempts ? `GitHub refused ${pr.counters.mergeAttempts} of ${PR_LIMITS.mergeAttempts}.` : "None refused.");

  const gating = items.filter((i) => !i.advisory);
  const status = gating.some((i) => i.state === "blocked") ? "blocked" : gating.every((i) => i.ok) ? "ready" : "waiting";
  return { status, items };
}

/** Does the user's own merge apply to this pull request right now? Otherwise the automatic gate does. */
export const userGate = (pr: PrDelivery) => pr.policy === "hold" || pr.mergeRequested?.headSha === pr.headSha;

/** Hold mode: GitHub's side is satisfied and the independent review is clean; only the user's Merge is missing. */
export function prReady(s: State, task: Task, nowMs: number): boolean {
  const pr = livePr(task);
  if (!pr || pr.phase !== "open" || pr.policy !== "hold" || pr.op) return false;
  return prGate(s, task, nowMs, { byUser: true }).items.every((i) => i.ok || i.id === "policy");
}

/** Say once per head that a held pull request is ready: its checks passed and its review is clean. */
export function announceReady(s: State, t: Task, now: string) {
  const pr = livePr(t);
  // Judged at the time GitHub was last read, like everything that depends on what it showed.
  if (!pr || !prReady(s, t, Date.parse(pr.observed?.at ?? now))) return;
  const msg = `${prName(pr)} is ready for you: required checks passed on ${sha12(pr.headSha)}`;
  if (!s.events.some((e) => e.taskId === t.id && e.message === msg)) event(s, now, "system", "integration", msg, t.id);
}

/** Reasons a head is never pushed: they end only when the delivery is closed (and delivered again). */
const STICKY: PrAttentionCode[] = ["remote-diverged", "foreign-commits"];
export const stuck = (pr: PrDelivery) => !!pr.attention && STICKY.includes(pr.attention.code);
/** Reasons a fix task may be working on (bot-check only at the user's request; never automatically). */
const REPAIRABLE: PrAttentionCode[] = ["checks-failed", "service-checks", "review-findings", "conflict", "bot-check"];

/** Set or clear `pr.attention` from the current facts. `since` moves only when the reason or the head changes. */
export function refreshAttention(s: State, t: Task, now: string) {
  const pr = livePr(t);
  if (!pr) return;
  let next: { code: PrAttentionCode; message: string } | undefined;
  if (pr.phase === "merged" || pr.phase === "closed") next = undefined;
  else if (pr.foreignHead) next = { code: "foreign-push", message: `Someone else pushed ${sha12(pr.foreignHead.sha)} to ${pr.branch}. The app will not push to it or merge it again.` };
  else if (pr.attention && STICKY.includes(pr.attention.code)) next = pr.attention; // only closing or delivering again clears it
  else if (wrongRepo(s, pr))
    next = { code: "repo-changed", message: `This pull request was opened in ${pr.repo}, but the remote ${pr.remote} now points at ${s.project.github!.repo}. The app does not read, push, merge or close it there. Point the remote back, or close this delivery and deliver again.` };
  else if (pr.changed.workflowHits.length && !pr.workflowPushAllowed && (pr.phase === "built" || pr.pendingHead))
    next = { code: "workflow-change", message: `It changes CI workflow files (${pr.changed.workflowHits.slice(0, 5).join(", ")}), so it is not pushed until you allow it.` };
  else if (pr.phase === "built" && pr.counters.failures >= PR_LIMITS.publishFailures)
    next = { code: "publish-failed", message: `Pushing the branch and opening the pull request failed ${pr.counters.failures} times${pr.message ? `: ${pr.message}` : ""}. Choose Keep for me and then let it continue to try again, or close it and deliver again.` };
  else {
    // Judged at the time GitHub was last read: a timeout is never declared for a period nobody looked.
    const blocking = prGate(s, t, Date.parse(pr.observed?.at ?? now), { byUser: userGate(pr) }).items.find((i) => i.state === "blocked" && i.code && (pr.phase === "open" || i.id === "review"));
    if (blocking) next = { code: blocking.code!, message: blocking.detail };
    // Open findings that all wait for a decision are a decision, not a fix.
    const undecided = blocking?.code === "review-findings" ? onlyUndecided(s, t) : undefined;
    if (undecided) {
      next = { code: "findings-decision", message: `${undecided.count} finding${undecided.count === 1 ? "" : "s"} of the review of ${sha12(pr.changeSha)} need${undecided.count === 1 ? "s" : ""} a decision (${undecided.who}). Nothing is fixed until it is taken.` };
    }
  }
  if (next && pr.policy === "auto" && REPAIRABLE.includes(next.code)) {
    const fixing = openRepair(s, pr);
    if (fixing) next = { code: next.code, message: `${next.message} ${fixing.id} is fixing it; its result is pushed onto this pull request.` };
    else if (pr.pendingHead?.kind === "repair") next = { code: next.code, message: `${next.message} A fix is being pushed onto this pull request.` };
    else if (pr.counters.repairs >= PR_LIMITS.repairs) next = { code: next.code, message: `${next.message} ${PR_LIMITS.repairs} fix tasks already ran, so it needs you.` };
  }
  if (!next) {
    delete pr.attention;
    return;
  }
  if (pr.attention?.code === next.code && pr.attention.headSha === pr.headSha) {
    pr.attention.message = clip(next.message, 600);
    return;
  }
  pr.attention = { code: next.code, message: clip(next.message, 600), headSha: pr.headSha, since: now };
  event(s, now, "system", "blocked", `${prName(pr)} needs you: ${clip(next.message, 300)}`, t.id);
}
