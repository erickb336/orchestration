// Reports from the service about GitHub: the preflight, the fetched base, and observations of open pull
// requests. "Merged", "posted" and "closed" are written only from an observation.

import * as M from "../model";
import { clip } from "../text";
import { type CheckObs, type GitHubStatus, type Landed, type LandedFlag, type PostureItem, type PrDelivery, type State } from "../types";
import { gateCheckNames, rerunsUsed, staleAfterRerun } from "./ciTriage";
import { event, GITHUB_URL, sha12 } from "./core";
import { announceReady, prReady, refreshAttention } from "./gate";
import { recordLanded } from "./landed";
import {
  BACKOFF_MIN,
  livePr,
  MIN,
  type Observations,
  OP_TIMEOUT_MS,
  type OpError,
  PR_LIMITS,
  type PreflightReport,
  prName,
  type ReportContext,
  safePrUrl,
  withNoCiPosture,
} from "./pr";
import { cancelLinked } from "./repair";
import { checkTasksFor } from "./serviceChecks";

/**
 * Record a problem with the connection. `since` names when it began: it stays the same while the same
 * problem lasts or comes back (`recurring`), so it is announced once, not once per retry.
 */
function setProblem(s: State, code: NonNullable<GitHubStatus["problem"]>["code"], message: string, now: string, retryAt?: string, recurring?: { since: string }) {
  const prev = s.project.github;
  const gh: GitHubStatus = prev ?? { ok: false, requiredChecks: [], autoMergeBlockers: [], posture: [] };
  const same = prev?.problem?.code === code;
  gh.ok = false;
  gh.problem = { code, message: clip(message, 300), since: recurring ? recurring.since : same ? prev!.problem!.since : now, ...(retryAt ? { retryAt } : {}) };
  s.project.github = gh;
  if (!same && (!recurring || recurring.since === now)) event(s, now, "system", "blocked", `GitHub delivery stopped: ${clip(message, 300)}`);
}

const FETCH_BACKOFF_MIN = [1, 2, 5, 15, 30];

/**
 * The fetch of the base failed although the repository check may pass (the branch is missing, or git
 * cannot sign in over its own transport while gh can). Counted and backed off separately: a passing
 * check does not reset it, so it cannot flap between "fine" and "failed" every cycle.
 */
export function fetchFailed(s: State, e: OpError, now: string) {
  const cfg = s.project.prDelivery;
  const gh: GitHubStatus = s.project.github ?? { ok: false, requiredChecks: [], autoMergeBlockers: [], posture: [] };
  s.project.github = gh;
  const prev = gh.fetchFailures;
  const count = (prev?.count ?? 0) + 1;
  const nextAt = e.code === "rate-limit" && e.retryAt ? e.retryAt : new Date(Date.parse(now) + FETCH_BACKOFF_MIN[Math.min(count, FETCH_BACKOFF_MIN.length) - 1] * MIN).toISOString();
  const message = `Fetching ${cfg.remote}/${cfg.base} failed${count > 1 ? ` ${count} times in a row` : ""}: ${e.message}`;
  gh.fetchFailures = { count, since: prev?.since ?? now, nextAt, message: clip(message, 300) };
  const code = e.code === "auth" ? "auth" : e.code === "rate-limit" ? "rate-limit" : e.code === "remote" || e.code === "git" ? "remote" : "network";
  setProblem(s, code, code === "auth" ? `GitHub sign-in needed (run \`gh auth login\` in a terminal). ${message}` : message, now, nextAt, { since: gh.fetchFailures.since });
}

/** A failure that is about the connection, not about one pull request. */
export function projectProblem(s: State, e: OpError, now: string) {
  const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
  if (e.code === "auth") setProblem(s, "auth", `GitHub sign-in needed (run \`gh auth login\` in a terminal). ${e.message}`, now);
  else if (e.code === "rate-limit") setProblem(s, "rate-limit", `GitHub's rate limit was reached; waiting. ${e.message}`, now, e.retryAt ?? at(5 * MIN));
  // git's own transport (an SSH key, a credential helper) is not gh's sign-in: `gh auth login` would not help.
  else if (e.code === "remote" || e.code === "git") setProblem(s, "remote", e.message, now, at(5 * MIN));
  else setProblem(s, "network", `GitHub could not be reached. ${e.message}`, now, at(MIN));
}

export const isProjectError = (e: OpError) => e.code === "auth" || e.code === "rate-limit" || e.code === "git";

/** Posture the app knows without asking GitHub. */
function localPosture(s: State, ctx: ReportContext): PostureItem[] {
  const out: PostureItem[] = [
    {
      id: "sandbox-verified",
      status: "ok",
      label: "Pull-request delivery was checked on a real GitHub sandbox",
      detail: "Checked on 2026-09-30 with gh 2.101.0 and scripted agents (docs/tasks/ORC-008.md). Your repository's rules may differ: watch the first pull requests, and hold any you are unsure about.",
    },
  ];
  const local = s.project.enabledProviders.filter((p) => s.project.workerEnvironment[p] === "local");
  if (local.length)
    out.push({
      id: "local-workers",
      status: "warn",
      label: "An agent environment is set to local",
      detail: `An agent environment set to "local" (${local.map(M.providerLabel).join(", ")}) may expose your GitHub sign-in or a GitHub MCP server to agents.`,
    });
  if (ctx.workerShell) out.push({ id: "worker-shell", status: "warn", label: "Claude workers have shell access", detail: "With shell access, the app cannot claim that only the service reaches GitHub." });
  return out;
}

/** The result of the read-only repository check. */
export function reportPreflight(state: State, r: PreflightReport, now: string, ctx: ReportContext = {}): State {
  const s = structuredClone(state);
  const prev = s.project.github;
  if (!r.ok) {
    const prob = r.problem ?? { code: "network" as const, message: "The repository check failed." };
    setProblem(s, prob.code, prob.message, now, prob.retryAt);
    const gh = s.project.github!;
    gh.checkedAt = now;
    delete gh.recheck;
    if (r.repo) gh.repo = r.repo;
    if (r.ghVersion) gh.ghVersion = r.ghVersion;
    return s;
  }
  const repoChanged = !!prev?.repo && !!r.repo && prev.repo !== r.repo;
  const gh: GitHubStatus = {
    ...(prev ?? {}),
    ok: true,
    checkedAt: now,
    repo: r.repo,
    login: r.login,
    ghVersion: r.ghVersion,
    requiredChecks: [...r.requiredChecks],
    autoMergeBlockers: [...r.autoMergeBlockers],
    // What the last fetch found on the local delivery branch stays listed until the next fetch.
    posture: withNoCiPosture([...r.posture, ...(r.simulated ? [] : localPosture(s, ctx)), ...(prev?.posture.filter((x) => x.id === UNPUSHED_ID) ?? [])], s.project.prDelivery.noCi),
  };
  if (r.mergeQueue) gh.mergeQueue = true;
  else delete gh.mergeQueue;
  if (r.mergeCommitsAllowed === false) gh.mergeCommitsAllowed = false;
  else delete gh.mergeCommitsAllowed;
  // A failing fetch keeps its own counter and wait. A passing check does not reset it, and while the
  // fetch is what fails the problem stays until a fetch works (the next one is tried right away when
  // the user asked for this check).
  if (gh.fetchFailures && repoChanged) delete gh.fetchFailures;
  const fetchProblem = !!gh.fetchFailures && prev?.problem?.since === gh.fetchFailures.since && prev.problem.code !== "remote";
  if (fetchProblem) {
    if (prev?.recheck) gh.fetchFailures = { ...gh.fetchFailures!, nextAt: now };
    gh.ok = false;
    gh.problem = { ...prev!.problem!, retryAt: gh.fetchFailures!.nextAt };
  } else delete gh.problem;
  delete gh.recheck;
  if (r.simulated) gh.simulated = true;
  else delete gh.simulated;
  // The fetched base belongs to the repository it was fetched from.
  if (repoChanged) delete gh.base;
  s.project.github = gh;
  if (!prev?.ok || repoChanged) event(s, now, "system", "config", `GitHub repository checked, read-only: ${r.repo ?? "unknown"}${r.login ? ` as ${r.login}` : ""}${r.simulated ? " (simulated)" : ""}`);
  return s;
}

const UNPUSHED_ID = "unpushed-local";

/**
 * The delivery base was fetched into the app's private ref. `unpushed`: Orchestration's own commits on
 * the local delivery branch that the remote base does not have (local delivery put them there). The
 * app never pushes them; it says so.
 */
export function reportBaseFetched(state: State, sha: string, now: string, unpushed?: { branch: string; count: number }): State {
  const gh = state.project.github;
  if (!gh) return state;
  const s = structuredClone(state);
  const g = s.project.github!;
  const cfg = s.project.prDelivery;
  const first = !gh.base;
  g.base = { sha, fetchedAt: now };
  if (g.fetchFailures) {
    const recovered = g.problem?.since === g.fetchFailures.since;
    delete g.fetchFailures;
    // The problem was the fetch itself: it is over.
    if (recovered) {
      delete g.problem;
      g.ok = true;
    }
  }
  if (unpushed) {
    const had = g.posture.some((x) => x.id === UNPUSHED_ID);
    g.posture = g.posture.filter((x) => x.id !== UNPUSHED_ID);
    if (unpushed.count > 0) {
      g.posture.push({
        id: UNPUSHED_ID,
        status: "warn",
        label: `${unpushed.count} Orchestrator commit${unpushed.count === 1 ? "" : "s"} on ${unpushed.branch} ${unpushed.count === 1 ? "is" : "are"} not on ${cfg.remote}/${cfg.base}`,
        detail: `Local delivery put ${unpushed.count === 1 ? "it" : "them"} on your branch ${unpushed.branch}. The app does not push ${unpushed.count === 1 ? "it" : "them"}, and new work starts from ${cfg.remote}/${cfg.base}, which does not have ${unpushed.count === 1 ? "it" : "them"}. Push ${unpushed.branch} yourself if pull requests should build on that work.`,
      });
      if (!had) event(s, now, "system", "config", `${unpushed.count} Orchestrator commit${unpushed.count === 1 ? " is" : "s are"} on ${unpushed.branch} and not on ${cfg.remote}/${cfg.base}; the app does not push ${unpushed.count === 1 ? "it" : "them"}`);
    }
  }
  if (first) event(s, now, "system", "integration", `Fetched ${cfg.remote}/${cfg.base} (${sha12(sha)}); new work starts from it`);
  return s;
}

export function backoff(pr: PrDelivery, now: string) {
  pr.counters.failures += 1;
  const minutes = BACKOFF_MIN[Math.min(pr.counters.failures, BACKOFF_MIN.length) - 1];
  pr.nextAt = new Date(Date.parse(now) + minutes * MIN).toISOString();
}

function mainCheckState(names: string[], checks: CheckObs[]): "pending" | "success" | "failure" {
  const watched = names.length ? names.map((n) => checks.find((c) => c.name === n)) : checks;
  if (watched.some((c) => c && c.conclusion !== null && c.conclusion !== "SUCCESS")) return "failure";
  if (watched.length === 0 || watched.some((c) => !c || c.conclusion === null)) return "pending";
  return "success";
}

/**
 * What GitHub reports about the app's pull requests and landed commits. MERGED and CLOSED are
 * terminal evidence and always apply; everything else is bound to the head it was observed for.
 * `ctx.opId` names the merge or close operation that asked for this observation. `ctx.repo`: the
 * repository that was read; a number is matched only to a pull request the app opened there.
 */
export function reportObservations(state: State, obs: Observations, now: string, ctx: { opId?: string; actError?: OpError; requested?: { taskId: string; number: number }[]; repo?: string } = {}): State {
  const s = structuredClone(state);
  const nowMs = Date.parse(now);
  // The time GitHub was read, never later than now: the freshness checks are about the read.
  const readAt = obs.at && Date.parse(obs.at) <= nowMs ? obs.at : now;
  const gh = s.project.github;
  const repo = ctx.repo ?? gh?.repo;
  const seen = new Set<string>();
  /** Review and fix tasks that belong to a pull request which merged, closed or was taken over. */
  const cancel: { ids: string[]; reason: string }[] = [];
  for (const o of obs.prs) {
    const t = s.tasks.find((x) => {
      const p = livePr(x);
      return p?.number === o.number && (p.phase === "open" || p.phase === "closed") && (!repo || !p.repo || p.repo === repo);
    });
    const pr = t && livePr(t);
    if (!t || !pr) continue;
    seen.add(t.id);
    if (pr.phase === "closed") {
      // A closed pull request is only watched for one thing: someone reopened and merged it on GitHub.
      if (o.state !== "MERGED" || !o.mergeCommit) continue;
    }
    const wasReady = prReady(s, t, nowMs);
    pr.observed = {
      at: readAt,
      state: o.state,
      isDraft: o.isDraft,
      crossRepo: o.crossRepo,
      headSha: o.headSha,
      baseRef: o.baseRef,
      mergeable: o.mergeable,
      mergeStateStatus: o.mergeStateStatus,
      reviewDecision: o.reviewDecision,
      labels: [...o.labels],
      checks: o.checks.map((c) => ({ ...c })),
      checksFor: o.checksFor,
      ...(o.mergedAt ? { mergedAt: o.mergedAt } : {}),
      ...(o.mergeCommit ? { mergeCommit: o.mergeCommit } : {}),
      ...(o.mergedBy ? { mergedBy: o.mergedBy } : {}),
      ...(o.closedBy ? { closedBy: o.closedBy } : {}),
    };
    const settle = () => {
      delete pr.op;
      delete pr.mergeRequested;
      delete pr.closeRequested;
      delete pr.pendingHead;
      delete pr.nextAt;
      delete pr.attention;
    };
    if (o.state === "MERGED") {
      // Truthful records: "merged" needs the merge commit GitHub made.
      if (!o.mergeCommit) continue;
      // Attributed by the merge the app sent for this head: the intent in flight, or the last one it
      // sent when GitHub reports the merge only after the command had seemed to fail.
      const late = !!pr.lastMergeIntent && pr.lastMergeIntent.headSha === o.headSha && !!o.mergedBy && o.mergedBy === gh?.login;
      const byApp = (pr.op?.kind === "merge" && pr.op.headSha === o.headSha) || late;
      const auto = byApp && !!pr.lastMergeIntent?.auto && pr.lastMergeIntent.headSha === o.headSha;
      const names = gateCheckNames(s, pr, o.checks);
      const required = o.checks.filter((c) => names.includes(c.name));
      // With the user's "no CI" declaration and nothing reported, the head has no checks to be judged by.
      const declaredNoCi = s.project.prDelivery.noCi && names.length === 0 && o.checksFor === o.headSha && o.checks.length === 0;
      const clean = o.headSha === pr.headSha && !pr.foreignHead && o.checksFor === o.headSha && (declaredNoCi || (names.length > 0 && names.every((n) => required.find((c) => c.name === n)?.conclusion === "SUCCESS")));
      const flags: LandedFlag[] = [
        ...(clean ? [] : (["merged-without-clean-gate"] as const)),
        ...(pr.review.ok && pr.review.clearedByUser ? (["findings-cleared-by-user"] as const) : []),
        // The review was clean apart from findings someone accepted as they are.
        ...(pr.review.ok && pr.review.accepted?.length ? (["findings-accepted"] as const) : []),
        ...(pr.changed.protectedHits.length ? (["protected-paths"] as const) : []),
      ];
      pr.phase = "merged";
      settle();
      const who = byApp ? (auto ? "Orchestrator, automatically: independent review clean and required checks passed on that head" : "Orchestrator, at your request") : (o.mergedBy ?? "a person");
      event(s, now, "system", "integration", `${prName(pr)} merged into ${pr.base} by ${who}${pr.simulated ? " (simulated)" : ""}`, t.id);
      recordLanded(
        s,
        t,
        {
          via: "pr",
          target: `${pr.repo} ${pr.base}`,
          commit: o.mergeCommit,
          by: byApp ? "app" : "person",
          ...(o.mergedBy ? { mergedBy: o.mergedBy } : {}),
          ...(pr.simulated ? { simulated: true } : {}),
          pr: { number: o.number, url: pr.url ?? safePrUrl(pr, o.number, o.url), ...(pr.repo ? { repo: pr.repo } : {}) },
          review: structuredClone(pr.review),
          checks: required.map((c) => ({ ...c })),
          // With "no CI" declared and nothing reported on the head, the base's check is not watched.
          mainCheck: { state: declaredNoCi ? "unknown" : "pending", at: now },
          flags,
        },
        now,
      );
      cancel.push({ ids: [...pr.reviewTaskIds, ...pr.repairTaskIds, ...checkTasksFor(s, t, pr, true).map((x) => x.id)], reason: `${prName(pr)} merged` });
      continue;
    }
    if (o.state === "CLOSED") {
      const asked = !!pr.closeRequested;
      pr.phase = "closed";
      if (asked) pr.closedByRequest = true;
      settle();
      event(s, now, "system", asked ? "integration" : "blocked", asked ? `${prName(pr)} closed from Orchestrator; the branch is kept` : `${prName(pr)} was closed on GitHub without merging${o.closedBy ? ` by ${o.closedBy}` : ""}`, t.id);
      cancel.push({ ids: [...pr.reviewTaskIds, ...pr.repairTaskIds, ...checkTasksFor(s, t, pr, true).map((x) => x.id)], reason: `${prName(pr)} was closed` });
      continue;
    }
    // OPEN
    if (o.headSha === pr.headSha) pr.headSince ??= now;
    else if (!pr.foreignHead && o.headSha !== pr.pendingHead?.sha) {
      // Sticky: the app never pushes to or merges this pull request again.
      pr.foreignHead = { sha: o.headSha, at: now };
      delete pr.mergeRequested;
      delete pr.pendingHead;
      cancel.push({ ids: [...pr.reviewTaskIds, ...pr.repairTaskIds], reason: `someone else pushed to ${prName(pr)}` });
    }
    // Observations after a re-run request that still show the cancelled run are counted;
    // after 2 (or 5 minutes) the check is judged as observed. The observation, not the request, decides.
    // The driver's own read right after the request never counts: GitHub has had no time
    // to publish the new run, so that read says nothing about it.
    const ownRerunRead = pr.op?.kind === "rerun" && ctx.opId === pr.op.id;
    if (o.checksFor === pr.headSha && !ownRerunRead) {
      for (const u of rerunsUsed(pr)) {
        const c = o.checks.find((x) => x.name === u.check);
        if (c && staleAfterRerun(c, u)) u.seen = (u.seen ?? 0) + 1;
      }
    }
    if (pr.op?.kind === "rerun") {
      const own = ctx.opId === pr.op.id;
      const graceOver = nowMs - Date.parse(pr.op.at) >= OP_TIMEOUT_MS.rerun + PR_LIMITS.graceMs;
      if (own || graceOver) {
        const mine = rerunsUsed(pr).filter((u) => u.opId === pr.op!.id);
        delete pr.op;
        // A definite refusal means the re-run did not happen: the wait is over at once, and the record
        // says GitHub refused it. The budget stays spent: a re-run counts once it is requested.
        const definite = !!ctx.actError && !["network", "timeout", "unknown"].includes(ctx.actError.code);
        if (definite) {
          for (const u of mine) {
            u.seen = PR_LIMITS.rerunObservations;
            u.refused = clip(ctx.actError!.message, 200);
          }
        }
        if (ctx.actError) {
          pr.message = clip(ctx.actError.message, 300);
          event(s, now, "system", "blocked", `${prName(pr)}: the re-run of ${mine.map((u) => u.check).join(", ") || "the cancelled job"} was not accepted by GitHub (${clip(ctx.actError.message, 200)}); it is not sent again`, t.id);
        }
      }
    }
    if (pr.op && (pr.op.kind === "merge" || pr.op.kind === "close")) {
      const own = ctx.opId === pr.op.id;
      const graceOver = nowMs - Date.parse(pr.op.at) >= OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs;
      // A command that failed for a reason that says nothing about GitHub's answer (the network, a
      // timeout) may still have gone through: its intent stays until the grace time has passed.
      const definite = !!ctx.actError && !["network", "timeout", "unknown"].includes(ctx.actError.code);
      if ((own && definite) || graceOver) {
        const what = pr.op.kind;
        pr.message = clip(ctx.actError?.message ?? `The ${what} did not happen: GitHub still shows the pull request open.`, 300);
        if (what === "merge") {
          // Only a refusal counts as a refusal. A sign-in, rate-limit or network failure is tried again.
          const refused = own && (ctx.actError?.code === "rejected" || ctx.actError?.code === "head-mismatch");
          if (refused) pr.counters.mergeAttempts += 1;
          if (ctx.actError?.code === "head-mismatch") delete pr.mergeRequested;
          // A spent request is withdrawn, so Merge can be chosen again deliberately.
          if (pr.counters.mergeAttempts >= PR_LIMITS.mergeAttempts) delete pr.mergeRequested;
        }
        delete pr.op;
        backoff(pr, now);
        event(s, now, "system", "blocked", `${prName(pr)}: the ${what} was not carried out${ctx.actError ? ` (${clip(ctx.actError.message, 200)})` : ""}; GitHub still shows it open`, t.id);
      }
    }
    refreshAttention(s, t, now);
    if (!wasReady) announceReady(s, t, now);
  }
  // An interrupted merge or close whose pull request GitHub did not return: never wait on it forever.
  for (const r of ctx.requested ?? []) {
    const t = s.tasks.find((x) => x.id === r.taskId);
    const pr = t && livePr(t);
    if (!t || !pr?.op || seen.has(t.id) || (pr.op.kind !== "merge" && pr.op.kind !== "close" && pr.op.kind !== "rerun")) continue;
    if (nowMs - Date.parse(pr.op.at) < OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs) continue;
    pr.message = "GitHub did not return this pull request; the interrupted operation was dropped.";
    delete pr.op;
    backoff(pr, now);
  }

  // The check on the base branch after a merge. A failure after a merge the app made pauses automatic
  // merging; a second one within a day keeps it paused until the user resumes it. Nothing is reverted.
  const DAY = 24 * 60 * MIN;
  for (const t of s.tasks) {
    const l = t.integration?.landed;
    if (!l || l.via !== "pr") continue;
    const paused = gh?.autoMergePaused;
    // While a pause that may end by itself lasts, the commit that caused it is looked at again: a re-run may pass.
    const rewatch = !!paused && !paused.sticky && paused.taskId === t.id && l.mainCheck?.state === "failure";
    if (l.mainCheck?.state !== "pending" && !rewatch) continue;
    const c = obs.commits.find((x) => x.oid === l.commit);
    const stateNow = c ? mainCheckState(gh?.requiredChecks ?? [], c.checks) : "pending";
    if (rewatch) {
      if (stateNow === "success") {
        l.mainCheck = { state: "success", at: now };
        event(s, now, "system", "integration", `The check on ${l.target} passed when it ran again`, t.id);
      }
      continue;
    }
    if (stateNow === "pending") {
      if (nowMs - Date.parse(l.at) > PR_LIMITS.mainCheckMs) l.mainCheck = { state: "unknown", at: now };
      continue;
    }
    const url = c?.checks.find((x) => x.conclusion !== null && x.conclusion !== "SUCCESS")?.url;
    l.mainCheck = { state: stateNow, at: now, ...(stateNow === "failure" && url && GITHUB_URL.test(url) ? { url } : {}) };
    if (stateNow === "failure") {
      if (!l.flags.includes("main-check-failed")) l.flags.push("main-check-failed");
      const what = l.pr ? `PR #${l.pr.number}` : "this change";
      event(s, now, "system", "blocked", `The check on ${l.target} failed after ${what} landed`, t.id);
      if (l.by === "app" && gh) {
        const breaks = [...(gh.mainBreaks ?? []).filter((x) => nowMs - Date.parse(x) < DAY), now];
        gh.mainBreaks = breaks;
        const sticky = breaks.length >= 2;
        gh.autoMergePaused = { since: now, reason: `the check on ${l.target} is failing after ${what}`, sticky, taskId: t.id };
        event(s, now, "system", "blocked", `Automatic merging is paused: the check on ${l.target} is failing after ${what}. ${sticky ? "It is the second failure within a day, so it stays paused until you resume it." : "It resumes when the check passes again, or when you resume it."} Nothing is reverted automatically.`);
      }
    }
  }
  // A pause that is not sticky ends when the newest landed commit's check passes.
  if (gh?.autoMergePaused && !gh.autoMergePaused.sticky) {
    const since = gh.autoMergePaused.since;
    const newest = s.tasks
      .map((t) => t.integration?.landed)
      .filter((l): l is Landed => !!l && l.via === "pr")
      .sort((a, b) => a.at.localeCompare(b.at))
      .pop();
    if (newest?.mainCheck?.state === "success" && newest.mainCheck.at >= since) {
      delete gh.autoMergePaused;
      event(s, now, "system", "integration", `Automatic merging resumed: the check on ${newest.target} passes again`);
    }
  }

  if (gh) {
    gh.observedAt = now;
    if (obs.rateRemaining !== undefined) gh.rateRemaining = obs.rateRemaining;
    if (obs.rateRemaining === 0) setProblem(s, "rate-limit", "GitHub's rate limit was reached; waiting until it resets.", now, obs.rateResetAt ?? new Date(nowMs + 15 * MIN).toISOString());
  }
  let out = s;
  for (const c of cancel) out = cancelLinked(out, c.ids, now, c.reason);
  return out;
}
