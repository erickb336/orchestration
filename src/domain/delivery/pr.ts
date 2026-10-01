// The pull-request model: its limits, the branch and ref names the app uses, the operations and reports
// exchanged with the service's PrDriver, and small views of the tracked pull requests.
//
// Desired state (config, holds, merge requests), intent (`pr.op`) and observed state (`pr.observed`,
// `project.github`) are separate fields. "Merged", "posted" and "closed" are written only from an
// observation. Everything in delivery/ is pure; the PrDriver performs the operations the planner plans.
//
// Automatic merging happens only when the pull request's policy is "auto", an independent review is
// clean for the exact change, every required check passed on the exact head, GitHub reports it
// mergeable, and nothing is paused or held (the merge gate, gate.ts).

import { ControlError, type CheckObs, type GitHubStatus, type PostureItem, type PrDelivery, type State, type Task } from "../types";
import { getTask, GITHUB_URL } from "./core";
import { deliveredInto } from "./repair";

export const MIN = 60_000;

export const PR_LIMITS = {
  /** Merge attempts per head before the pull request waits for the user. */
  mergeAttempts: 2,
  checksPendingMs: 60 * MIN,
  checksMissingMs: 15 * MIN,
  githubBlockedMs: 10 * MIN,
  nonRequiredMs: 30 * MIN,
  commentAttempts: 3,
  mutationGapMs: 2000,
  mutationsPerHour: 200,
  /** A merge starts only on an observation this fresh. */
  observeFreshMs: 15_000,
  preflightMaxAgeMs: 6 * 60 * MIN,
  mainCheckMs: 120 * MIN,
  observeBatch: 20,
  /** An orphaned child of an earlier service process may still finish this long after its timeout. */
  graceMs: 30_000,
  /** Times the service brings one pull request up to date with the base before it asks the user. */
  baseUpdates: 3,
  /** Fix tasks per pull request. */
  repairs: 2,
  /** Dedicated reviews the service starts per pull request (the user may ask for more). */
  reviews: 3,
  /** Dedicated check runs the service starts per pull request. */
  checks: 3,
  /** An automatic merge needs the base fetched this recently. */
  baseFreshMs: 2 * MIN,
  /** Failed attempts to push and open a pull request before it waits for the user. */
  publishFailures: 6,
  /** A closed pull request is still looked at this long, in case it is reopened and merged on GitHub. */
  closedWatchMs: 24 * 60 * MIN,
  closedWatchEveryMs: 10 * MIN,
  /** A paused automatic merge watches the failing commit this long for a check that passes on a re-run. */
  pausedWatchMs: 24 * 60 * MIN,
  /** Re-runs of GitHub-cancelled jobs per pull request over its life, and per operation. */
  reruns: 5,
  /** After a re-run was requested, the cancelled run still shown counts as pending for this long, or this many observations. */
  rerunWaitMs: 5 * MIN,
  rerunObservations: 2,
};

/** How long each operation may run (the driver's timeouts, summed over its network calls). */
export const OP_TIMEOUT_MS: Record<"publish" | "push" | "merge" | "close" | "rerun", number> = { publish: 240_000, push: 120_000, merge: 120_000, close: 120_000, rerun: 120_000 };

export const BACKOFF_MIN = [1, 2, 4, 8, 15];
const sanitizeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
/** A GitHub app slug (a review bot's name). */
export const REVIEW_BOT_SLUG = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NO_CI_ID = "no-ci";

/** The posture line for the user's "no CI" declaration, added or removed. */
export function withNoCiPosture(posture: PostureItem[], noCi: boolean): PostureItem[] {
  const rest = posture.filter((x) => x.id !== NO_CI_ID);
  return noCi ? [...rest, { id: NO_CI_ID, status: "warn", label: "You declared no CI.", detail: "Your own Merge goes through with no checks on the head. Automatic merging still needs a required check, and any check GitHub does report is honoured." }] : rest;
}

/** The private local ref that holds the fetched tip of the delivery base. Writers start from it. */
export const prBaseRef = (projectId: string) => `refs/orchestration/${sanitizeId(projectId)}/base`;
/** The only kind of branch the app ever pushes. */
export const prBranch = (projectId: string, taskId: string, n: number) => `orchestration/${sanitizeId(projectId)}/pr/${taskId}-${n}`;
export const PR_BRANCH_REF = /^refs\/heads\/orchestration\/[A-Za-z0-9._-]+\/pr\/[A-Za-z0-9._-]+-\d+$/;
export const prMarker = (projectId: string, taskId: string, n: number) => `<!-- orchestration:pr:${projectId}/${taskId}/${n} -->`;
export const noteMarker = (projectId: string, noteId: string) => `<!-- orchestration:note:${projectId}/${noteId} -->`;

/** Glob over a repository path: `**` crosses directories, `*` and `?` stay inside one. Anchored. */
export function matchGlob(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

export interface PrObservation {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  crossRepo: boolean;
  url: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  labels: string[];
  checks: CheckObs[];
  /** The commit the checks ran on. */
  checksFor: string;
  mergedAt?: string;
  mergeCommit?: string;
  mergedBy?: string;
  closedBy?: string;
}

export interface Observations {
  /** When GitHub was read (stamped by the driver). An observation is as old as its read, not as its arrival. */
  at?: string;
  prs: PrObservation[];
  commits: { oid: string; checks: CheckObs[] }[];
  rateRemaining?: number;
  rateResetAt?: string;
}

export interface PreflightReport {
  ok: boolean;
  simulated?: boolean;
  problem?: { code: NonNullable<GitHubStatus["problem"]>["code"]; message: string; retryAt?: string };
  repo?: string;
  login?: string;
  ghVersion?: string;
  requiredChecks: string[];
  autoMergeBlockers: string[];
  posture: PostureItem[];
  /** The base branch requires a merge queue. */
  mergeQueue?: boolean;
  /** false: merge commits are not allowed in this repository. */
  mergeCommitsAllowed?: boolean;
}

export type OpErrorCode = "auth" | "not-found" | "head-mismatch" | "rejected" | "rate-limit" | "network" | "timeout" | "unknown" | "remote" | "diverged" | "foreign-commits" | "git" | "conflict";
export interface OpError {
  code: OpErrorCode;
  /** Redacted, at most 300 characters. */
  message: string;
  retryAt?: string;
}

/**
 * One operation of the driver. "publish", "push", "merge", "close", "comment" and "rerun" write to the
 * remote or to GitHub. "update" is local: it builds the commit that brings a pull request up to date
 * with the base; the push that follows publishes it. `repo` on "observe": the one repository that is
 * read. "rerun" asks GitHub Actions to run cancelled jobs of the head again.
 */
export type PrOp =
  | { id: string; kind: "preflight" }
  | { id: string; kind: "fetch" }
  | { id: string; kind: "observe"; repo?: string; prs: { taskId: string; number: number }[]; commits: string[] }
  | { id: string; kind: "publish" | "push" | "merge" | "close"; taskId: string; n: number; headSha: string }
  | { id: string; kind: "update"; taskId: string; n: number; headSha: string; baseSha: string }
  | { id: string; kind: "comment"; taskId: string; noteId: string }
  | { id: string; kind: "rerun"; taskId: string; n: number; headSha: string; jobs: { check: string; jobId: number }[] };

export const opMutates = (op: PrOp) => op.kind === "publish" || op.kind === "push" || op.kind === "merge" || op.kind === "close" || op.kind === "comment" || op.kind === "rerun";

export interface PrOpResult {
  op: PrOp;
  /** The operation as a whole failed, or (merge, close) its outcome could not be observed. */
  error?: OpError;
  /** merge, close: what the gh command itself reported. It records nothing; the observation does. */
  actError?: OpError;
  preflight?: PreflightReport;
  /** fetch. `unpushed`: Orchestration's commits on the local delivery branch that the remote base lacks. */
  base?: { sha: string; unpushed?: { branch: string; count: number } };
  /** update: the service's merge of the base into the head, built locally and not pushed yet. */
  updated?: { sha: string; baseSha: string };
  /** update: the base does not merge cleanly into the head. */
  conflict?: { files: string[] };
  /** push: the pending head is on the remote branch. */
  pushed?: { sha: string };
  observed?: Observations;
  published?: { number: number; url: string };
  /** close: no pull request was ever opened for this head. */
  nothingOpen?: boolean;
  /** close: the app's own pull request, opened by an interrupted publish, was found on GitHub only now. */
  adopted?: { number: number; url: string };
  comment?: { url: string };
}

export interface ReportContext {
  /** Claude workers run with shell access (a posture warning). */
  workerShell?: boolean;
}

/** The task's pull request while its delivery record is current (a re-delivery in progress has none). */
export function livePr(t: Task): PrDelivery | undefined {
  return t.integration?.status === "integrated" ? t.integration.pr : undefined;
}

/** Tasks whose pull request is built or open: what the app still acts on or watches. */
export function trackedPrTasks(s: State): Task[] {
  return s.tasks
    .filter((t) => {
      const pr = livePr(t);
      return !!pr && (pr.phase === "built" || pr.phase === "open");
    })
    .sort((a, b) => (a.integration!.at ?? "").localeCompare(b.integration!.at ?? "") || a.id.localeCompare(b.id));
}

export function openPrTasks(s: State): Task[] {
  return trackedPrTasks(s).filter((t) => t.integration!.pr!.phase === "open");
}

/** Why a built pull request is not opened yet because of the open limit, or nothing. */
export function openSlotsFull(s: State): string | undefined {
  const open = openPrTasks(s).length;
  const max = s.project.prDelivery.maxOpenPrs;
  return open >= max ? `${open} of ${max} pull requests are open, your limit` : undefined;
}

/** Why coder steps that start from the base are not dispatched yet, if they are held. */
export function writersHeld(s: State): string | undefined {
  const cfg = s.project.prDelivery;
  return cfg.enabled && !s.project.github?.base ? `waiting for the first fetch of ${cfg.remote}/${cfg.base}` : undefined;
}

/**
 * A revert in pull-request mode starts from the remote base as fetched after the work it undoes
 * landed (and after the revert was asked for): never from a stale base, never from a local branch.
 */
export function revertWaitsForBase(s: State, t: Task): boolean {
  if (!t.revertOf || !s.project.prDelivery.enabled) return false;
  const fetchedAt = s.project.github?.base?.fetchedAt;
  const landedAt = s.tasks.find((x) => x.id === t.revertOf!.taskId)?.integration?.landed?.at ?? "";
  return !fetchedAt || fetchedAt < landedAt || fetchedAt < t.createdAt;
}

/**
 * Integrated work that never reached a branch: it can be delivered (again). With pull-request delivery
 * on, as a pull request. With it off, only work whose pull request was closed or abandoned: it goes
 * through the current mode instead, so nothing is stranded by a mode switch.
 */
export function redeliverable(s: State): Task[] {
  const prOn = s.project.prDelivery.enabled;
  return s.tasks.filter((t) => {
    const i = t.integration;
    if (t.lifecycle !== "done" || !i || i.landed || i.status !== "integrated" || deliveredInto(t)) return false;
    if (i.pr ? i.pr.phase !== "closed" : !prOn || i.delivered?.status === "delivered") return false;
    return s.artifacts.some((a) => a.taskId === t.id && a.kind === "code-change");
  });
}

export function prTask(s: State, taskId: string): { task: Task; pr: PrDelivery } {
  const task = getTask(s, taskId);
  const pr = livePr(task);
  if (!pr) throw new ControlError(`${taskId} has no pull request.`);
  return { task, pr };
}

export const prName = (pr: PrDelivery) => (pr.number ? `PR #${pr.number}` : `the pull request branch ${pr.branch}`);

export function safePrUrl(pr: PrDelivery, number: number, url: string): string {
  if (pr.simulated || GITHUB_URL.test(url)) return url;
  return REPO.test(pr.repo) ? `https://github.com/${pr.repo}/pull/${number}` : "";
}
