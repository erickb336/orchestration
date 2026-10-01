// The planner: the next GitHub operation the service's PrDriver should perform (nextPrOp), recording it as
// begun (beginPrOp), and applying its result (reportPrOp).

import * as M from "../model";
import { clip } from "../text";
import { type GitHubStatus, type PrDelivery, type State, type Task } from "../types";
import { rerunPlan } from "./ciTriage";
import { event, getTask, GITHUB_URL, sha12 } from "./core";
import { autoQueue, mergeCandidate, prGate, refreshAttention, stuck, wrongRepo } from "./gate";
import { landedRepo } from "./landed";
import { backoff, fetchFailed, isProjectError, projectProblem, reportBaseFetched, reportObservations, reportPreflight } from "./observations";
import {
  BACKOFF_MIN,
  livePr,
  MIN,
  OP_TIMEOUT_MS,
  openPrTasks,
  type OpError,
  opMutates,
  PR_LIMITS,
  prName,
  type PrOp,
  type PrOpResult,
  type ReportContext,
  safePrUrl,
  trackedPrTasks,
} from "./pr";
import { promoteHead } from "./prHeads";

function mutationsThisHour(gh: GitHubStatus | undefined, nowMs: number): number {
  const hour = new Date(nowMs).toISOString().slice(0, 13);
  return gh?.mutations?.hour === hour ? gh.mutations.count : 0;
}

/** Does anything need a fresh base now: a writer about to start, a head to build, or a merge just seen? */
function needsBase(s: State): boolean {
  const fetchedAt = s.project.github?.base?.fetchedAt ?? "";
  // The merge candidate is merged only onto a base that was fetched moments ago.
  if (mergeCandidate(s)) return true;
  return s.tasks.some((t) => {
    if (t.lifecycle === "done") return t.integration?.status === "pending" || (t.integration?.landed?.via === "pr" && t.integration.landed.at > fetchedAt);
    if ((t.lifecycle !== "ready" && t.lifecycle !== "active") || t.hold || t.holdBeforeStart) return false;
    return t.steps.some((st) => st.state === "pending" && st.role === "coder");
  });
}

function pendingComment(s: State, nowMs: number): { task: Task; noteId: string } | undefined {
  for (const t of s.tasks) {
    const l = t.integration?.landed;
    if (!l?.pr || l.simulated) continue;
    // Only in the repository the pull request lives in.
    const repo = landedRepo(t);
    if (repo && s.project.github?.repo && repo !== s.project.github.repo) continue;
    const next = t.integration?.pr?.nextAt;
    if (next && Date.parse(next) > nowMs) continue;
    const n = l.notes.find((x) => x.comment?.status === "pending");
    if (n) return { task: t, noteId: n.id };
  }
  return undefined;
}

const publishAllowed = (pr: PrDelivery) => !pr.changed.workflowHits.length || !!pr.workflowPushAllowed;

/**
 * The next operation for the driver, or nothing. Pure; first match wins, in the order of
 * docs/design/ORC-008-design.md §6.4 (with the re-run step added after 6.2). The driver
 * calls this only while no operation is in flight, so a recorded `pr.op` here is an interrupted one.
 */
export function nextPrOp(s: State, nowMs: number): PrOp | undefined {
  const p = s.project;
  const cfg = p.prDelivery;
  const gh = p.github;
  const tracked = trackedPrTasks(s);
  // Only pull requests in the repository the remote names now are read or written.
  const here = (t: Task) => !wrongRepo(s, t.integration!.pr!);
  const open = tracked.filter((t) => t.integration!.pr!.phase === "open" && t.integration!.pr!.number !== undefined && here(t));
  const age = (iso?: string) => (iso ? nowMs - Date.parse(iso) : Number.POSITIVE_INFINITY);
  const paused = gh?.autoMergePaused;
  const mainChecks = s.tasks.filter((t) => {
    const l = t.integration?.landed;
    if (!l || l.via !== "pr") return false;
    const repo = landedRepo(t);
    if (repo && gh?.repo && repo !== gh.repo) return false;
    // A pause that may end by itself keeps looking at the commit that caused it, for a bounded time.
    return l.mainCheck?.state === "pending" || (!!paused && !paused.sticky && paused.taskId === t.id && l.mainCheck?.state === "failure" && age(paused.since) < PR_LIMITS.pausedWatchMs);
  });
  // A closed pull request may still be reopened and merged on GitHub: it is looked at, slowly, for a day.
  const closedWatch = s.tasks.filter((t) => {
    const pr = livePr(t);
    return !!pr && pr.phase === "closed" && pr.number !== undefined && !t.integration?.landed && !wrongRepo(s, pr) && pr.observed?.state === "CLOSED" && age(pr.observed.at) < PR_LIMITS.closedWatchMs;
  });
  // Nothing is watched once pull-request delivery is off and no pull request or main check is tracked.
  if (!cfg.enabled && open.length === 0 && mainChecks.length === 0 && closedWatch.length === 0) return undefined;
  const id = `prop-${s.seq + 1}`;

  // 1. A known problem: wait for its retry time, then only a read, backing off 5 → 30 min. When the
  //    problem is a fetch that keeps failing, the fetch itself is what is tried again.
  if (gh?.problem) {
    if (gh.recheck) return { id, kind: "preflight" };
    const fetchProblem = !!gh.fetchFailures && gh.problem.since === gh.fetchFailures.since && gh.problem.code !== "remote";
    if (gh.problem.retryAt) return Date.parse(gh.problem.retryAt) > nowMs ? undefined : fetchProblem && cfg.enabled ? { id, kind: "fetch" } : { id, kind: "preflight" };
    const wait = Math.min(30 * MIN, Math.max(5 * MIN, Date.parse(gh.checkedAt ?? gh.problem.since) - Date.parse(gh.problem.since)));
    return age(gh.checkedAt) >= wait ? { id, kind: "preflight" } : undefined;
  }
  // 2. The read-only repository check.
  if (!gh || gh.recheck || !gh.checkedAt || age(gh.checkedAt) > PR_LIMITS.preflightMaxAgeMs) return { id, kind: "preflight" };
  if (!gh.ok) return undefined;

  const observe = (withClosed = false): PrOp => ({
    id,
    kind: "observe",
    ...(gh.repo ? { repo: gh.repo } : {}),
    prs: [...open, ...(withClosed ? closedWatch : [])].slice(0, PR_LIMITS.observeBatch).map((t) => ({ taskId: t.id, number: t.integration!.pr!.number! })),
    commits: mainChecks.slice(0, PR_LIMITS.observeBatch).map((t) => t.integration!.landed!.commit),
  });
  // While shaping no delivery work starts (no publish, push, merge or base update);
  // reads go on, and so do the user's own explicit requests to close or to post a note.
  const writable = !p.hold && cfg.enabled && age(gh.lastMutationAt) >= PR_LIMITS.mutationGapMs && mutationsThisHour(gh, nowMs) < PR_LIMITS.mutationsPerHour;
  const canWrite = writable && p.stage !== "shaping";
  const rested = (pr: PrDelivery) => !pr.nextAt || Date.parse(pr.nextAt) <= nowMs;
  const pushable = (pr: PrDelivery) => !pr.userHold && !pr.foreignHead && !pr.closeRequested && !stuck(pr) && publishAllowed(pr);

  // 3. Interrupted intents: reconcile before anything is tried again, and only after the grace time.
  for (const t of tracked) {
    const pr = t.integration!.pr!;
    if (!here(t)) continue;
    if (!pr.op || age(pr.op.at) < OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs) continue;
    // A re-run intent is observed, never sent again (Q11): its budget was spent when it was recorded.
    if ((pr.op.kind === "merge" || pr.op.kind === "close" || pr.op.kind === "rerun") && pr.number !== undefined) return observe();
    if (pr.op.kind === "rerun") continue;
    // publish, push, or a close that never had a number: the operation itself checks the remote first.
    const kind = pr.op.kind === "close" || pr.closeRequested ? "close" : pr.op.kind === "push" ? "push" : "publish";
    if (kind === "close" ? writable : canWrite && !pr.userHold && !pr.foreignHead && !stuck(pr)) return { id, kind, taskId: t.id, n: pr.n, headSha: pr.headSha };
  }

  // 4. The delivery base (a read: it is fetched while shaping too, so building resumes with a fresh base).
  if (cfg.enabled && (!gh.fetchFailures || Date.parse(gh.fetchFailures.nextAt) <= nowMs)) {
    const fetched = age(gh.base?.fetchedAt);
    // A merge the app has seen moved the base: what it fetched before is stale, so it fetches at once.
    const movedSince = !!gh.base && s.tasks.some((t) => t.integration?.landed?.via === "pr" && t.integration.landed.at > gh.base!.fetchedAt);
    if (!gh.base || movedSince || (fetched >= MIN && needsBase(s)) || fetched >= 10 * MIN) return { id, kind: "fetch" };
  }

  // 5. Observe: one batched read.
  const candidate = mergeCandidate(s);
  if (open.length || mainChecks.length || closedWatch.length) {
    const unseen = open.some((t) => !t.integration!.pr!.observed);
    const urgent = !!candidate || unseen || open.some((t) => t.integration!.pr!.mergeRequested || t.integration!.pr!.op);
    const interval = p.hold || (gh.rateRemaining ?? 5000) < 300 ? 5 * MIN : urgent ? 30_000 : open.length ? 2 * MIN : mainChecks.length ? MIN : PR_LIMITS.closedWatchEveryMs;
    // Closed pull requests ride along once per ten-minute slot.
    const slot = (ms: number) => Math.floor(ms / PR_LIMITS.closedWatchEveryMs);
    const withClosed = closedWatch.length > 0 && (!gh.observedAt || slot(nowMs) !== slot(Date.parse(gh.observedAt)));
    if (age(gh.observedAt) >= interval && (open.length || mainChecks.length || withClosed)) return observe(withClosed);
  }

  // 6. Writes. While shaping only the user's own close and note requests (6.5, 6.6) go through.
  if (!writable) return undefined;
  if (!canWrite) {
    const c = pendingComment(s, nowMs);
    if (c) return { id, kind: "comment", taskId: c.task.id, noteId: c.noteId };
    for (const t of tracked) {
      const pr = t.integration!.pr!;
      if (pr.closeRequested && !pr.op && rested(pr) && here(t)) return { id, kind: "close", taskId: t.id, n: pr.n, headSha: pr.headSha };
    }
    return undefined;
  }
  // 6.1 A merge: the user's, bound to the head they saw; else the one candidate of automatic merging.
  const mergeOf = (t: Task, byUser: boolean): PrOp | undefined => {
    const pr = t.integration!.pr!;
    if (pr.op || pr.userHold || pr.foreignHead || pr.closeRequested || pr.pendingHead || !rested(pr)) return undefined;
    if (prGate(s, t, nowMs, { byUser }).status !== "ready") return undefined;
    // Merge freshness: GitHub is looked at again right before the merge.
    if (age(pr.observed?.at) > PR_LIMITS.observeFreshMs) return observe();
    return { id, kind: "merge", taskId: t.id, n: pr.n, headSha: pr.headSha };
  };
  for (const t of open) {
    if (t.integration!.pr!.mergeRequested?.headSha !== t.integration!.pr!.headSha) continue;
    const op = mergeOf(t, true);
    if (op) return op;
  }
  if (candidate && here(candidate)) {
    const op = mergeOf(candidate, false);
    if (op) return op;
  }
  // 6.2 Push a pending head (a fix, or the candidate brought up to date) onto its pull request.
  for (const t of open) {
    const pr = t.integration!.pr!;
    // A head brought up to date is pushed only for the pull request that merges next.
    if (pr.pendingHead?.kind === "update" && autoQueue(s)[0]?.id !== t.id) continue;
    if (pr.pendingHead && !pr.op && pushable(pr) && rested(pr)) return { id, kind: "push", taskId: t.id, n: pr.n, headSha: pr.headSha };
  }
  // 6.2b Re-run the GitHub-cancelled jobs of a head, once per check, before any fix task.
  for (const t of open) {
    const pr = t.integration!.pr!;
    if (pr.op || pr.userHold || pr.foreignHead || pr.closeRequested || pr.pendingHead || stuck(pr) || !rested(pr)) continue;
    const jobs = rerunPlan(s, pr, nowMs);
    if (jobs) return { id, kind: "rerun", taskId: t.id, n: pr.n, headSha: pr.headSha, jobs };
  }
  // 6.3 Bring the merge candidate, and only it, up to date with the base (local; the push follows).
  if (candidate && cfg.updateBeforeMerge && gh.base) {
    const pr = candidate.integration!.pr!;
    const conflicted = pr.baseConflict?.headSha === pr.headSha && pr.baseConflict.baseSha === gh.base.sha;
    if (!pr.simulated && !pr.op && !pr.pendingHead && rested(pr) && pr.baseSha !== gh.base.sha && !conflicted && pr.counters.baseUpdates < PR_LIMITS.baseUpdates && pr.observed?.headSha === pr.headSha)
      return { id, kind: "update", taskId: candidate.id, n: pr.n, headSha: pr.headSha, baseSha: gh.base.sha };
  }
  // 6.4 Publish the oldest built head.
  const openCount = tracked.filter((t) => t.integration!.pr!.phase === "open").length;
  for (const t of tracked) {
    const pr = t.integration!.pr!;
    if (pr.phase !== "built" || pr.op || !pushable(pr) || !rested(pr) || !here(t)) continue;
    if (pr.counters.failures >= PR_LIMITS.publishFailures) continue;
    if (openCount >= cfg.maxOpenPrs) break;
    return { id, kind: "publish", taskId: t.id, n: pr.n, headSha: pr.headSha };
  }
  // 6.5 A note the user chose to post.
  const c = pendingComment(s, nowMs);
  if (c) return { id, kind: "comment", taskId: c.task.id, noteId: c.noteId };
  // 6.6 Close.
  for (const t of tracked) {
    const pr = t.integration!.pr!;
    if (pr.closeRequested && !pr.op && rested(pr) && here(t)) return { id, kind: "close", taskId: t.id, n: pr.n, headSha: pr.headSha };
  }
  return undefined;
}

/**
 * Record the intent of a write before it is attempted. Re-checks, inside the transaction, everything
 * the planner saw: the project pause, the hold, the gate and that no other intent is recorded.
 * `started` is false when nothing may start; the state is then unchanged.
 */
export function beginPrOp(state: State, op: PrOp, now: string): { state: State; started: boolean } {
  const no = { state, started: false };
  const nowMs = Date.parse(now);
  const p = state.project;
  const gh = p.github;
  if (!opMutates(op) || p.hold || !p.prDelivery.enabled || !gh?.ok || gh.problem) return no;
  // Delivery work (publish, push, merge) never starts while shaping; the user's own close or note may.
  if (p.stage === "shaping" && op.kind !== "close" && op.kind !== "comment") return no;
  if (gh.lastMutationAt && nowMs - Date.parse(gh.lastMutationAt) < PR_LIMITS.mutationGapMs) return no;
  if (mutationsThisHour(gh, nowMs) >= PR_LIMITS.mutationsPerHour) return no;
  const s = structuredClone(state);
  const t = s.tasks.find((x) => x.id === (op as { taskId: string }).taskId);
  if (!t) return no;
  if (op.kind === "comment") {
    const l = t.integration?.landed;
    const note = l?.notes.find((x) => x.id === op.noteId);
    if (!l?.pr || l.simulated || note?.comment?.status !== "pending") return no;
    note.comment.attempts += 1;
  } else if (op.kind === "rerun") {
    const pr = livePr(t);
    if (!pr || pr.n !== op.n || pr.headSha !== op.headSha || wrongRepo(s, pr)) return no;
    if (pr.op && nowMs - Date.parse(pr.op.at) < OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs) return no;
    if (pr.nextAt && Date.parse(pr.nextAt) > nowMs) return no;
    if (pr.userHold || pr.foreignHead || pr.closeRequested || pr.pendingHead) return no;
    // Re-checked inside the transaction: the same jobs, on the same head, still re-runnable with budget left.
    const plan = rerunPlan(s, pr, nowMs);
    if (!plan || JSON.stringify(plan) !== JSON.stringify(op.jobs)) return no;
    // The budget is spent when the intent is recorded (Q11), before anything is sent.
    if (pr.ciReruns?.headSha !== pr.headSha) pr.ciReruns = { headSha: pr.headSha, used: [] };
    for (const j of op.jobs) pr.ciReruns.used.push({ check: j.check, jobId: j.jobId, at: now, opId: op.id });
    pr.counters.reruns = (pr.counters.reruns ?? 0) + op.jobs.length;
    pr.op = { id: op.id, kind: "rerun", at: now, headSha: pr.headSha };
    const names = op.jobs.map((j) => j.check).join(", ");
    event(s, now, "system", "integration", `Re-running ${names} on ${prName(pr)} (${sha12(pr.headSha)}): GitHub cancelled ${op.jobs.length === 1 ? "it" : "them"}. ${pr.counters.reruns} of ${PR_LIMITS.reruns} re-runs used for this pull request; no fix task is started for a cancelled run`, t.id);
  } else if (op.kind === "publish" || op.kind === "push" || op.kind === "merge" || op.kind === "close") {
    const pr = livePr(t);
    if (!pr || pr.n !== op.n || pr.headSha !== op.headSha) return no;
    // The app acts on a pull request only in the repository it opened it in.
    if (wrongRepo(s, pr)) return no;
    // A recorded intent may still be running (in an orphaned process) until its timeout and the grace time have passed.
    if (pr.op && nowMs - Date.parse(pr.op.at) < OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs) return no;
    if (pr.nextAt && Date.parse(pr.nextAt) > nowMs) return no;
    if (op.kind === "close") {
      if (!pr.closeRequested || (pr.phase !== "built" && pr.phase !== "open")) return no;
    } else {
      if (pr.userHold || pr.foreignHead || pr.closeRequested) return no;
      if (op.kind === "publish") {
        if (pr.phase !== "built" || !publishAllowed(pr) || stuck(pr)) return no;
        if (openPrTasks(s).length >= p.prDelivery.maxOpenPrs) return no;
      } else if (op.kind === "push") {
        if (pr.phase !== "open" || !pr.pendingHead || !publishAllowed(pr) || stuck(pr)) return no;
        // Re-checked inside the transaction: the pull request may have been switched to hold since it was planned.
        if (pr.pendingHead.kind === "update" && autoQueue(s)[0]?.id !== t.id) return no;
      } else {
        if (pr.phase !== "open" || pr.number === undefined || pr.pendingHead) return no;
        if (!pr.observed || nowMs - Date.parse(pr.observed.at) > PR_LIMITS.observeFreshMs) return no;
        // The user's Merge for exactly this head, or the one candidate of automatic merging. Both
        // re-run the whole gate here, inside the transaction.
        const byUser = pr.mergeRequested?.headSha === pr.headSha;
        if (!byUser && (pr.policy !== "auto" || mergeCandidate(s)?.id !== t.id)) return no;
        if (prGate(s, t, nowMs, { byUser }).status !== "ready") return no;
        pr.lastMergeIntent = { at: now, headSha: pr.headSha, auto: !byUser };
        if (!byUser) {
          const day = now.slice(0, 10);
          const g0 = s.project.github!;
          g0.autoMerges = { day, count: g0.autoMerges?.day === day ? g0.autoMerges.count + 1 : 1 };
        }
      }
    }
    pr.op = { id: op.id, kind: op.kind, at: now, headSha: pr.headSha };
  } else return no;
  s.seq += 1; // operation ids never repeat
  const hour = now.slice(0, 13);
  const g = s.project.github!;
  g.lastMutationAt = now;
  g.mutations = { hour, count: g.mutations?.hour === hour ? g.mutations.count + 1 : 1 };
  return { state: s, started: true };
}

/**
 * Apply the result of one operation. A result applies only while its intent is still the recorded one
 * (operation id, `n` and head); anything else is a stale result and changes nothing.
 */
export function reportPrOp(state: State, r: PrOpResult, now: string, ctx: ReportContext = {}): State {
  const op = r.op;
  const fail = (e: OpError): State => {
    const s = structuredClone(state);
    projectProblem(s, e, now);
    return s;
  };
  const unknown: OpError = { code: "unknown", message: "The operation returned nothing." };
  if (op.kind === "preflight") {
    if (r.preflight) return reportPreflight(state, r.preflight, now, ctx);
    // The check itself failed: the same problem an operation would have reported, retried with backoff.
    const e = r.error ?? unknown;
    const code = e.code === "auth" ? "auth" : e.code === "rate-limit" ? "rate-limit" : e.code === "remote" ? "remote" : "network";
    const message = code === "auth" ? `GitHub sign-in needed (run \`gh auth login\` in a terminal). ${e.message}` : e.message;
    return reportPreflight(state, { ok: false, problem: { code, message, ...(code === "rate-limit" && e.retryAt ? { retryAt: e.retryAt } : {}) }, requiredChecks: [], autoMergeBlockers: [], posture: [] }, now, ctx);
  }
  if (op.kind === "fetch") {
    if (r.base) return reportBaseFetched(state, r.base.sha, now, r.base.unpushed);
    const s = structuredClone(state);
    fetchFailed(s, r.error ?? unknown, now);
    return s;
  }
  if (op.kind === "observe") return r.observed ? reportObservations(state, r.observed, now, { requested: op.prs, repo: op.repo }) : fail(r.error ?? unknown);

  if (op.kind === "update") {
    // Built locally; nothing was pushed. It applies only to the head and the base it was built for.
    const cur = state.tasks.find((x) => x.id === op.taskId);
    const curPr = cur && livePr(cur);
    if (!curPr || curPr.n !== op.n || curPr.headSha !== op.headSha || curPr.pendingHead || curPr.op || curPr.phase !== "open") return state;
    const s = structuredClone(state);
    const t = getTask(s, op.taskId);
    const pr = t.integration!.pr!;
    if (r.updated && r.updated.sha === pr.headSha) {
      // The head already contains this base tip: nothing to push.
      pr.baseSha = r.updated.baseSha;
      delete pr.baseConflict;
    } else if (r.updated) {
      pr.pendingHead = { sha: r.updated.sha, changeSha: pr.changeSha, changeTaskId: pr.changeTaskId, changeAuthor: pr.changeAuthor, changeAuthors: M.prAuthors(pr), baseSha: r.updated.baseSha, kind: "update" };
      pr.counters.baseUpdates += 1;
      delete pr.baseConflict;
      event(s, now, "system", "integration", `${pr.base} moved to ${sha12(r.updated.baseSha)}: prepared ${sha12(r.updated.sha)}, a merge of it into ${prName(pr)} made by Orchestrator (${pr.counters.baseUpdates} of ${PR_LIMITS.baseUpdates}); it is pushed next, never forced`, t.id);
    } else if (r.conflict) {
      pr.baseConflict = { baseSha: op.baseSha, headSha: pr.headSha, files: r.conflict.files.slice(0, 20) };
      refreshAttention(s, t, now);
    } else {
      pr.message = clip((r.error ?? unknown).message, 300);
      backoff(pr, now);
    }
    return s;
  }

  if (op.kind === "comment") {
    const s = structuredClone(state);
    const t = s.tasks.find((x) => x.id === op.taskId);
    const note = t?.integration?.landed?.notes.find((x) => x.id === op.noteId);
    if (!t || !note?.comment || note.comment.status !== "pending") return state;
    if (r.comment && GITHUB_URL.test(r.comment.url)) {
      // "Posted" needs the comment's address; an exit code alone records nothing.
      note.comment = { status: "posted", url: r.comment.url, attempts: note.comment.attempts };
      event(s, now, "system", "integration", "Your note was posted as a comment on the pull request", t.id);
      return s;
    }
    const e = r.error ?? unknown;
    if (isProjectError(e)) projectProblem(s, e, now);
    else if (note.comment.attempts >= PR_LIMITS.commentAttempts) {
      note.comment = { status: "failed", error: clip(e.message, 300), attempts: note.comment.attempts };
      event(s, now, "system", "blocked", `Your note could not be posted on the pull request after ${PR_LIMITS.commentAttempts} attempts: ${clip(e.message, 200)}`, t.id);
    } else {
      note.comment.error = clip(e.message, 300);
      const pr = t.integration?.pr;
      if (pr) pr.nextAt = new Date(Date.parse(now) + BACKOFF_MIN[Math.min(note.comment.attempts, BACKOFF_MIN.length) - 1] * MIN).toISOString();
    }
    return s;
  }

  // publish, push, merge, close: the stale-result guard.
  const cur = state.tasks.find((x) => x.id === op.taskId);
  const curPr = cur && livePr(cur);
  if (!curPr || curPr.op?.id !== op.id || curPr.n !== op.n || curPr.headSha !== op.headSha) return state;

  if (op.kind !== "publish" && r.observed) {
    let from = state;
    if (op.kind === "close" && r.adopted && curPr.number === undefined) {
      from = structuredClone(state);
      const pr = from.tasks.find((x) => x.id === op.taskId)!.integration!.pr!;
      pr.number = r.adopted.number;
      pr.url = safePrUrl(pr, r.adopted.number, r.adopted.url);
      pr.phase = "open";
    }
    // The command's exit code records nothing: the observation made right after it does.
    let s = reportObservations(from, r.observed, now, { opId: op.id, actError: r.actError });
    const e = r.actError;
    if (e && isProjectError(e)) {
      s = structuredClone(s);
      projectProblem(s, e, now);
    }
    return s;
  }

  const s = structuredClone(state);
  const t = s.tasks.find((x) => x.id === op.taskId)!;
  const pr = t.integration!.pr!;
  if (op.kind === "push") {
    delete pr.op;
    // "Pushed" needs the remote branch to hold exactly the pending head.
    if (r.pushed && pr.pendingHead && r.pushed.sha === pr.pendingHead.sha) return promoteHead(s, t.id, now);
    const e = r.error ?? unknown;
    pr.message = clip(e.message, 300);
    if (e.code === "diverged") {
      pr.attention = { code: "remote-diverged", message: `The branch ${pr.branch} on ${pr.remote} holds commits the app did not push. Nothing was pushed and nothing is forced; merge it on GitHub, or close this delivery and deliver again.`, headSha: pr.headSha, since: now };
      event(s, now, "system", "blocked", `${prName(pr)} needs you: ${pr.attention.message}`, t.id);
    } else if (e.code === "foreign-commits") {
      pr.attention = { code: "foreign-commits", message: clip(e.message, 600), headSha: pr.headSha, since: now };
      event(s, now, "system", "blocked", `${prName(pr)} needs you: ${clip(e.message, 300)}`, t.id);
    } else if (isProjectError(e) || e.code === "remote") projectProblem(s, e, now);
    else backoff(pr, now);
    return s;
  }
  if (op.kind === "publish") {
    delete pr.op;
    if (r.published) {
      pr.phase = "open";
      pr.number = r.published.number;
      pr.url = safePrUrl(pr, r.published.number, r.published.url);
      pr.counters.failures = 0;
      delete pr.nextAt;
      delete pr.message;
      event(s, now, "system", "integration", `Opened pull request #${pr.number} for ${pr.branch} into ${pr.base}${pr.simulated ? " (simulated)" : ""}; ${pr.policy === "auto" ? "it merges by itself after an independent review and passing required checks" : "you merge it"}`, t.id);
      refreshAttention(s, t, now);
      return s;
    }
    const e = r.error ?? unknown;
    pr.message = clip(e.message, 300);
    if (e.code === "diverged") {
      pr.attention = { code: "remote-diverged", message: `The branch ${pr.branch} on ${pr.remote} holds commits the app did not push. Nothing was pushed and nothing is forced; close this delivery and deliver again.`, headSha: pr.headSha, since: now };
      event(s, now, "system", "blocked", `${prName(pr)} needs you: ${pr.attention.message}`, t.id);
    } else if (e.code === "foreign-commits") {
      pr.attention = { code: "foreign-commits", message: clip(e.message, 600), headSha: pr.headSha, since: now };
      event(s, now, "system", "blocked", `${prName(pr)} needs you: ${clip(e.message, 300)}`, t.id);
    } else if (isProjectError(e) || e.code === "remote") projectProblem(s, e, now);
    else {
      // Bounded: after enough failures it waits for the user instead of trying forever.
      backoff(pr, now);
      refreshAttention(s, t, now);
    }
    return s;
  }
  if (op.kind === "close" && r.nothingOpen) {
    // Nothing was ever opened for this head, so there is nothing on GitHub to close.
    pr.phase = "closed";
    delete pr.op;
    delete pr.closeRequested;
    delete pr.mergeRequested;
    delete pr.attention;
    event(s, now, "system", "integration", `Delivery of ${pr.branch} abandoned; no pull request had been opened`, t.id);
    return s;
  }
  // merge or close whose outcome could not be observed: the intent stays and is reconciled by an
  // observation after the grace time. Nothing is recorded from the command alone.
  const e = r.error ?? r.actError ?? unknown;
  pr.message = clip(e.message, 300);
  if (isProjectError(e)) projectProblem(s, e, now);
  return s;
}
