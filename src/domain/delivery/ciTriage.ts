// CI triage: why a required check is not green (a review bot, a run GitHub cancelled, a check that never
// ran, or the code), and the bounded re-runs of cancelled jobs.

import { type CheckObs, type PrDelivery, type PrDeliveryConfig, type State } from "../types";
import { GITHUB_URL } from "./core";
import { requiredCheckNames } from "./gate";
import { PR_LIMITS } from "./pr";

/**
 * Why a required check is not green: a review bot's opinion, a run GitHub cancelled (provider), a
 * check that never ran, or the code. Only `code` failures start a fix task; the rest need a person,
 * except a provider failure, which is re-run once per head first.
 */
export type CiClass = "bot" | "provider" | "not-run" | "code";

/**
 * GitHub cancels a job that reaches its time limit, and reports it CANCELLED, not TIMED_OUT. The limit
 * a workflow sets is not in the API; only GitHub's default (360 minutes) can be recognised, so a
 * cancelled job that ran at least this long failed on the code. A shorter `timeout-minutes` cannot be
 * told from a cancellation and takes the re-run first.
 */
export const JOB_TIMEOUT_MS = 360 * 60_000;
const NEAR_TIMEOUT_MS = 5 * 60_000;
const NOT_CODE = new Set(["SUCCESS", "CANCELLED", "SKIPPED", "NEUTRAL", "STALE"]);
/** A conclusion that says the code failed (FAILURE, TIMED_OUT, ERROR, ACTION_REQUIRED, STARTUP_FAILURE, anything unknown). */
const codeConclusion = (c: CheckObs) => c.conclusion !== null && !NOT_CODE.has(c.conclusion);
const ranMs = (c: CheckObs) => (c.startedAt && c.completedAt ? Date.parse(c.completedAt) - Date.parse(c.startedAt) : undefined);

interface TriageContext {
  /** Every check observed on the head: a failure elsewhere in the same workflow run makes a cancelled or skipped job a code failure (review M4). */
  all?: CheckObs[];
  /** This run appeared after the re-runs for its name on this head were spent: cancelled again is a code failure (review M4). */
  reran?: boolean;
}

/**
 * Why a cancelled or skipped check is nonetheless the code's fault (review finding M4), or undefined:
 * another job of the same workflow run failed (a fail-fast matrix leg GitHub cancelled, an aggregator
 * skipped by a failed `needs:`), it was cancelled again after its re-run, or it ran to GitHub's time limit.
 */
export function codeWhy(c: CheckObs, o: TriageContext = {}): string | undefined {
  if (c.conclusion === null || codeConclusion(c)) return undefined;
  if (c.kind !== "status" && c.runId !== undefined && (o.all ?? []).some((x) => x.name !== c.name && x.kind !== "status" && x.runId === c.runId && codeConclusion(x))) return "another job of the same workflow run failed";
  if (c.conclusion === "CANCELLED") {
    if (o.reran) return "cancelled again after its re-run";
    const ran = ranMs(c);
    if (ran !== undefined && ran >= JOB_TIMEOUT_MS - NEAR_TIMEOUT_MS) return `ran to GitHub's ${Math.round(JOB_TIMEOUT_MS / 60_000)}-minute job limit`;
  }
  return undefined;
}

/** Pure: classify one required check on the exact head whose conclusion is not SUCCESS. */
export function triageCheck(cfg: PrDeliveryConfig, c: CheckObs, o: TriageContext = {}): CiClass {
  if (c.app && cfg.reviewBotApps.includes(c.app)) return "bot";
  if (codeWhy(c, o)) return "code";
  if (c.conclusion === "CANCELLED") return "provider";
  if (c.conclusion === "SKIPPED" || c.conclusion === "NEUTRAL" || c.conclusion === "STALE") return "not-run";
  return "code";
}

/** The context `triageCheck` needs for a check observed on this head: the head's other checks, and whether this run came after its name's re-runs were spent. */
export function triageContext(s: State, pr: PrDelivery, ob: { checks: CheckObs[] }, c: CheckObs): TriageContext {
  const used = rerunsUsed(pr, c.name);
  const reran = used.length > 0 && used.length >= s.project.prDelivery.rerunBudget && !used.some((u) => staleAfterRerun(c, u));
  return { all: ob.checks, reran };
}
export const classOf = (s: State, pr: PrDelivery, ob: { checks: CheckObs[] }, c: CheckObs) => triageCheck(s.project.prDelivery, c, triageContext(s, pr, ob, c));

const CLASS_WORD: Record<CiClass, string> = { bot: "review bot", provider: "cancelled by GitHub", "not-run": "did not run", code: "the code" };

/** "build: cancelled (cancelled by GitHub, github-actions, https://…)" — one failing check, with its class and app. */
export function checkLine(cfg: PrDeliveryConfig, c: CheckObs, o: TriageContext = {}): string {
  const cls = triageCheck(cfg, c, o);
  const why = cls === "code" ? codeWhy(c, o) : undefined;
  const parts = [cls === "bot" ? `review bot ${c.app}` : `${CLASS_WORD[cls]}${why ? `: ${why}` : ""}`, ...(cls !== "bot" && c.app ? [c.app] : []), ...(c.url && GITHUB_URL.test(c.url) ? [c.url] : [])];
  return `${c.name}: ${(c.conclusion ?? "running").toLowerCase().replace(/_/g, " ")} (${parts.join(", ")})`;
}

/**
 * The checks the gate judges for a head. Normally the required ones. With the user's "no CI"
 * declaration and no required check, every check GitHub does report is judged as required, so the
 * declaration never waives a reported check.
 */
export function gateCheckNames(s: State, pr: PrDelivery, checks: CheckObs[]): string[] {
  const names = requiredCheckNames(s, pr);
  if (names.length || !s.project.prDelivery.noCi) return names;
  return [...new Set(checks.map((c) => c.name))];
}

/** The re-runs already spent on this head, per check name. */
export function rerunsUsed(pr: PrDelivery, name?: string): NonNullable<PrDelivery["ciReruns"]>["used"] {
  if (!pr.ciReruns || pr.ciReruns.headSha !== pr.headSha) return [];
  return name === undefined ? pr.ciReruns.used : pr.ciReruns.used.filter((u) => u.check === name);
}

/** The observed run of a check is still the one a re-run was requested for: the new run has not shown up yet. */
export function staleAfterRerun(c: CheckObs, u: { jobId: number; at: string }): boolean {
  if (c.jobId !== undefined) return c.jobId === u.jobId;
  return !!c.startedAt && Date.parse(c.startedAt) <= Date.parse(u.at);
}

/**
 * After a re-run was requested for this check, its cancelled run still shows and the wait is not over:
 * at most 2 observations or 5 minutes (§7.3), so a provider that accepts a re-run and never
 * publishes it cannot stall the pull request.
 */
export function awaitingRerun(pr: PrDelivery, c: CheckObs, nowMs: number): boolean {
  const u = rerunsUsed(pr, c.name).at(-1);
  if (!u || !staleAfterRerun(c, u)) return false;
  return (u.seen ?? 0) < PR_LIMITS.rerunObservations && nowMs - Date.parse(u.at) < PR_LIMITS.rerunWaitMs;
}

/**
 * Why this GitHub-cancelled check cannot be re-run by the app, or undefined when it can (review
 * finding L7: the gate names the true reason). The clause continues "GitHub cancelled X on <sha>".
 */
export function rerunBlocker(s: State, pr: PrDelivery, c: CheckObs): string | undefined {
  const cfg = s.project.prDelivery;
  if (cfg.rerunBudget === 0) return "; re-runs are off (Settings → Delivery)";
  if (c.app !== "github-actions") return `; ${c.app ?? "this check"} has no re-run`;
  if (!Number.isInteger(c.jobId) || c.jobId! <= 0) return "; GitHub reported no job id to re-run";
  const spent = rerunsUsed(pr, c.name).length;
  if (spent >= cfg.rerunBudget) return `, and its re-run is used (${spent} of ${cfg.rerunBudget})`;
  if ((pr.counters.reruns ?? 0) >= PR_LIMITS.reruns) return `, and the ${PR_LIMITS.reruns} re-runs of this pull request are used`;
  return undefined;
}

/** Can this failing check be re-run: a GitHub-cancelled Actions job with an id, budget left for its name and for the pull request. */
function rerunnable(s: State, pr: PrDelivery, ob: { checks: CheckObs[] }, c: CheckObs): boolean {
  return classOf(s, pr, ob, c) === "provider" && rerunBlocker(s, pr, c) === undefined;
}

/**
 * The jobs to re-run on this head, or nothing (§7.3): the pull request is open and seen at this head
 * with checks for it, every required check has settled, at least one failed, every failed one is a
 * re-runnable provider failure with budget left, and nothing conflicts. Any `code` failure suppresses
 * re-runs: a fix is needed anyway. Pure; the planner, the intent and the gate all use it.
 */
export function rerunPlan(s: State, pr: PrDelivery, nowMs: number): { check: string; jobId: number }[] | undefined {
  const ob = pr.observed;
  if (!s.project.prDelivery.enabled || !ob || ob.state !== "OPEN" || ob.headSha !== pr.headSha || ob.checksFor !== pr.headSha) return undefined;
  if (pr.phase !== "open" || pr.number === undefined || pr.pendingHead || pr.foreignHead) return undefined;
  if (ob.mergeable === "CONFLICTING" || ob.mergeStateStatus === "DIRTY") return undefined;
  if (pr.baseConflict?.headSha === pr.headSha && pr.baseConflict.baseSha === s.project.github?.base?.sha) return undefined;
  const names = gateCheckNames(s, pr, ob.checks);
  const checks = names.map((n) => ob.checks.find((c) => c.name === n));
  if (!checks.length || checks.some((c) => !c || c.conclusion === null || awaitingRerun(pr, c, nowMs))) return undefined;
  const failed = checks.filter((c): c is CheckObs => !!c && c.conclusion !== "SUCCESS");
  if (!failed.length || failed.some((c) => !rerunnable(s, pr, ob, c))) return undefined;
  const jobs = failed.map((c) => ({ check: c.name, jobId: c.jobId! }));
  if ((pr.counters.reruns ?? 0) + jobs.length > PR_LIMITS.reruns) return undefined;
  return jobs.slice(0, PR_LIMITS.reruns);
}
