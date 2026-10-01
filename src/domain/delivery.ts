// Delivery of finished work and the review-later queue (ORC-008).
// Pure, like model.ts: every operation returns a new State and never mutates its input.
//
// The queue is informational. Nothing here is read to decide dispatch, integration or merging, and a
// landed item's `status` changes only through markLandedReviewed and sendBackLanded.

import * as C from "./checks";
import { MAX_PROVEN_PATHS, coverageCounts } from "./coverage";
import * as F from "./findings";
import * as M from "./model";
import { internalFlow, flowHash, flowRef, serviceFlow } from "./flows";
import { instantiate, toDef } from "./pipeline";
import {
  ControlError,
  REVIEW_ROLES,
  isProvider,
  type CheckObs,
  type GitHubStatus,
  type Landed,
  type LandedFlag,
  type PostureItem,
  type PrAttentionCode,
  type FlowRef,
  type PrDelivery,
  type PrDeliveryConfig,
  type ChangeAuthor,
  type ProviderId,
  type RoleId,
  type ReviewEvidence,
  type Artifact,
  type Attempt,
  type SpecContent,
  type State,
  type StepDef,
  type Task,
} from "./types";

// ---------- helpers ----------

function getTask(s: State, taskId: string): Task {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new ControlError(`Unknown task ${taskId}`);
  return t;
}

function event(s: State, now: string, actor: "user" | "system", kind: "integration" | "config" | "blocked", message: string, taskId?: string) {
  s.seq += 1;
  s.events.push({ id: `ev-${s.seq}`, at: now, actor, kind, taskId, message });
}

function getLanded(s: State, taskId: string): { task: Task; landed: Landed } {
  const task = getTask(s, taskId);
  const landed = task.integration?.landed;
  if (!landed) throw new ControlError(`${taskId} has not landed, so it is not in the Review list.`);
  return { task, landed };
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const sha12 = (sha: string) => sha.slice(0, 12);

// ---------- delivery mode ----------

/** Off, the local branch (fast-forward), or GitHub pull requests. The two delivery modes are never on together. */
export type DeliveryMode = "off" | "local" | "pr";

export const MAX_NOTE_CHARS = 4000;
export const MAX_NOTES_PER_ITEM = 200;
// Neither may start with "-": a name is never read as an option by git or gh.
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/;
const REMOTE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const GITHUB_URL = /^https:\/\/github\.com\//;

export function deliveryMode(s: State): DeliveryMode {
  if (s.project.prDelivery.enabled) return "pr";
  return s.project.autonomy.autoDeliver.enabled ? "local" : "off";
}

/** Done tasks whose work is on the integration branch but has not reached the delivery branch. */
export function undeliveredTasks(s: State): Task[] {
  // A fix that was pushed onto another task's pull request is delivered there, never on its own.
  return s.tasks.filter((t) => t.integration?.status === "integrated" && !t.integration.pr && !t.deliverInto && t.integration.delivered?.status !== "delivered");
}

/**
 * Choose how finished work is delivered. Sets `autoDeliver.enabled` and `prDelivery.enabled` together,
 * never both. "local" also queues work that was integrated while delivery was off, and forgets the
 * delivery baseline when the branch changes. "pr" asks for a read-only check of the repository; it
 * publishes nothing by itself.
 */
export function setDeliveryMode(state: State, a: { mode: DeliveryMode; branch?: string }, now: string): State {
  const s = structuredClone(state);
  const p = s.project;
  const before = deliveryMode(state);
  const prevBranch = p.autonomy.autoDeliver.branch;
  if (a.mode === "local") {
    const branch = (a.branch ?? prevBranch).trim();
    if (!BRANCH.test(branch)) throw new ControlError("Choose a valid branch name for delivery.");
    if (before === "local" && branch === prevBranch) return state;
    p.prDelivery.enabled = false;
    p.autonomy.autoDeliver = { enabled: true, branch };
    // The baseline (and the last result) describe the previous branch.
    if (branch !== prevBranch && p.delivery) p.delivery = { pending: p.delivery.pending };
    if (undeliveredTasks(s).length) p.delivery = { ...(p.delivery ?? {}), pending: true };
    event(s, now, "user", "config", `Delivery mode: local branch ${branch} (fast-forward only)`);
    return s;
  }
  if (before === a.mode) return state;
  p.autonomy.autoDeliver = { ...p.autonomy.autoDeliver, enabled: false };
  p.prDelivery.enabled = a.mode === "pr";
  if (a.mode === "pr") {
    p.github = { ...(p.github ?? { ok: false, requiredChecks: [], autoMergeBlockers: [], posture: [] }), recheck: true };
    event(s, now, "user", "config", `Delivery mode: GitHub pull requests (${p.prDelivery.remote}/${p.prDelivery.base}); checking the repository, read-only`);
  } else event(s, now, "user", "config", "Delivery mode: off; finished work stays on the integration branch");
  return s;
}

// ---------- the review-later queue ----------

/**
 * Record that a task's work reached its target branch. Mutates `s` (a draft owned by the caller).
 * An item is created once and never backfilled; it starts unreviewed.
 */
export function recordLanded(
  s: State,
  t: Task,
  entry: Pick<Landed, "via" | "target" | "commit" | "by"> & Partial<Pick<Landed, "simulated" | "mergedBy" | "pr" | "review" | "checks" | "mainCheck" | "flags">>,
  now: string,
): boolean {
  if (!t.integration || t.integration.landed) return false;
  // A link shown as "Open on GitHub" is only ever a github.com address.
  const pr = entry.pr && !entry.simulated && !GITHUB_URL.test(entry.pr.url) ? { number: entry.pr.number, url: "" } : entry.pr;
  // ORC-013 §6.9: checks the user accepted failing, or no check evidence for the landed change while checks are on.
  const changeSha = t.integration.pr?.changeSha ?? M.finalChange(s, t)?.ref?.split(" ")[0];
  const flags = [...new Set([...(entry.flags ?? []), ...C.landedCheckFlags(s, t, changeSha)])];
  t.integration.landed = { at: now, ...entry, ...(pr ? { pr } : {}), flags, status: "unreviewed", notes: [], followUps: [] };
  event(s, now, "system", "integration", `Landed on ${entry.target} (${sha12(entry.commit)})${entry.simulated ? " (simulated)" : ""}; listed for review, which never blocks anything`, t.id);
  return true;
}

/** Every landed task: unreviewed first, then newest first. */
export function landedTasks(s: State): Task[] {
  const rank = (t: Task) => (t.integration!.landed!.status === "unreviewed" ? 0 : 1);
  return s.tasks.filter((t) => t.integration?.landed).sort((a, b) => rank(a) - rank(b) || b.integration!.landed!.at.localeCompare(a.integration!.landed!.at) || a.id.localeCompare(b.id));
}

/** Persistent count for the Review badge: not tied to the last visit. */
export function unreviewedCount(s: State): number {
  return s.tasks.filter((t) => t.integration?.landed?.status === "unreviewed").length;
}

/**
 * Things that wait for the user: pull requests with an attention reason or ready to merge in hold
 * mode, flagged landed work that is still unreviewed, a GitHub problem, and paused automatic merging.
 */
export function needsYou(s: State, nowMs = Date.now()): number {
  let n = 0;
  for (const t of s.tasks) {
    const i = t.integration;
    if (i?.pr && i.status === "integrated" && (i.pr.phase === "built" || i.pr.phase === "open") && ((i.pr.attention && !openRepair(s, i.pr)) || prReady(s, t, nowMs))) n++;
    if (i?.landed?.status === "unreviewed" && i.landed.flags.length) n++;
  }
  if (s.project.github?.problem && (s.project.prDelivery.enabled || openPrTasks(s).length > 0)) n++;
  if (s.project.github?.autoMergePaused) n++;
  return n;
}

export interface LandedReview {
  stepId: string;
  purpose: string;
  role: RoleId;
  artifactId: string;
  openFindings: number;
  summary: string;
  /** Who ran the review. Absent when a person wrote or replaced the findings. */
  provider?: ProviderId;
  model?: string;
  editedByUser: boolean;
}

/** The agent reviews of a landed task: the accepted findings of its finished review steps. */
export function landedReviews(s: State, t: Task): LandedReview[] {
  const out: LandedReview[] = [];
  for (const st of t.steps) {
    if (st.state !== "done" || !REVIEW_ROLES.includes(st.role)) continue;
    for (const o of st.outputs) {
      if (o.kind !== "review-findings") continue;
      const a = M.acceptedOutput(s, t, st.id, o.name);
      if (!a) continue;
      const run = s.attempts.find((x) => x.id === a.attemptId);
      const provider = run?.snapshot.provider;
      out.push({
        stepId: st.id,
        purpose: st.purpose,
        role: st.role,
        artifactId: a.id,
        // ORC-013: structured findings count what is still unresolved; accepted findings are not open.
        openFindings: F.unresolved(s, a),
        summary: a.summary,
        ...(provider && isProvider(provider) ? { provider } : {}),
        model: run ? (run.actualModel ?? run.snapshot.model) : undefined,
        editedByUser: a.author === "user",
      });
    }
  }
  return out;
}

/**
 * The only way a landed item becomes reviewed, or unreviewed again. Opening or reading an item never
 * changes it.
 */
export function markLandedReviewed(state: State, taskIds: string[], reviewed: boolean, now: string): State {
  if (taskIds.length === 0) throw new ControlError("Choose at least one landed item.");
  if (taskIds.length > 100) throw new ControlError("At most 100 items can be marked at once.");
  const s = structuredClone(state);
  const status = reviewed ? "reviewed" : "unreviewed";
  for (const id of new Set(taskIds)) {
    const { task, landed } = getLanded(s, id);
    if (landed.status === status) continue;
    landed.status = status;
    landed.statusAt = now;
    event(s, now, "user", "integration", reviewed ? "Marked reviewed in the Review list" : "Marked not reviewed in the Review list", task.id);
  }
  return s;
}

/**
 * Leave a note on a landed item. The note is recorded at once. `postToGitHub` (pull-request items
 * only, off by default) asks the service to post it as a comment; it stays "pending" until the
 * service records the comment's URL.
 */
export function addLandedNote(state: State, taskId: string, text: string, postToGitHub: boolean, now: string): State {
  const body = text.trim();
  if (!body) throw new ControlError("Write a note first.");
  if (body.length > MAX_NOTE_CHARS) throw new ControlError(`Notes are limited to ${MAX_NOTE_CHARS} characters.`);
  const s = structuredClone(state);
  const { task, landed } = getLanded(s, taskId);
  if (landed.notes.length >= MAX_NOTES_PER_ITEM) throw new ControlError(`An item holds at most ${MAX_NOTES_PER_ITEM} notes.`);
  if (postToGitHub) {
    const why = cannotPostNote(s, task);
    if (why) throw new ControlError(why);
  }
  s.seq += 1;
  landed.notes.push({ id: `note-${s.seq}`, at: now, text: body, ...(postToGitHub ? { comment: { status: "pending" as const, attempts: 0 } } : {}) });
  event(s, now, "user", "integration", `Note on landed work: ${clip(body, 160)}`, task.id);
  return s;
}

/**
 * Why a note on this landed item cannot be posted as a comment on GitHub right now, or undefined when
 * it can. A note is never left waiting for a post that will not be made.
 */
export function cannotPostNote(s: State, task: Task): string | undefined {
  const landed = task.integration?.landed;
  if (!landed || landed.via !== "pr" || !landed.pr || landed.simulated) return "Only work that landed through a real pull request can take a comment on GitHub.";
  if (!s.project.prDelivery.enabled) return "Pull-request delivery is off, so nothing is posted on GitHub. Save the note without posting it, or switch pull-request delivery on first.";
  const repo = landedRepo(task);
  if (repo && s.project.github?.repo && repo !== s.project.github.repo) return `This pull request is in ${repo}, but the remote now points at ${s.project.github.repo}. The app does not post there.`;
  return undefined;
}

/** The repository a landed pull request lives in. */
export function landedRepo(task: Task): string | undefined {
  return task.integration?.landed?.pr?.repo ?? task.integration?.pr?.repo;
}

/** An unfinished revert of this landed commit, if one exists. */
export function openRevertOf(s: State, landed: Landed): Task | undefined {
  return s.tasks.find((x) => x.revertOf?.commit === landed.commit && x.lifecycle !== "done" && x.lifecycle !== "cancelled");
}

/**
 * Send landed work back through the normal pipeline as a linked follow-up task.
 * "fix": a bug-fix task seeded with the note, the open review findings and a failed check on the
 * target branch. "revert": a task whose first writer starts with the revert of the landed commit
 * already prepared. Both are reviewed and delivered like any task.
 */
export function sendBackLanded(state: State, a: { taskId: string; kind: "fix" | "revert"; note: string; holdBeforeStart: boolean }, now: string): { state: State; newId: string } {
  const { task: origin, landed } = getLanded(state, a.taskId);
  const note = a.note.trim();
  if (note.length > MAX_NOTE_CHARS) throw new ControlError(`Notes are limited to ${MAX_NOTE_CHARS} characters.`);
  if (a.kind === "fix" && !note) throw new ControlError("Say what needs fixing; the note becomes the fix task's specification.");
  const c12 = sha12(landed.commit);
  const title = M.currentSpec(origin).content.title;
  let steps: StepDef[];
  let flow: FlowRef;
  let fields: Partial<Task> | undefined;
  if (a.kind === "revert") {
    if (landed.simulated) throw new ControlError("This item is simulated: there is no commit to revert.");
    const open = openRevertOf(state, landed);
    if (open) throw new ControlError(`${open.id} is already reverting this change.`);
    // ORC-016: the revert pipeline is the service's own; no flow file can replace it.
    const revert = internalFlow("revert");
    steps = revert.steps;
    // The first writer is the one whose workspace holds the prepared revert: name the commit for it.
    const first = steps.find((x) => x.role === "coder");
    if (!first) throw new ControlError("The Revert pipeline has no coder step to complete the revert.");
    first.purpose = `${first.purpose} (revert of ${c12})`;
    // The hash is of the steps that run, purpose included (step 1 review, finding 5).
    flow = { ...flowRef(revert, "service"), hash: flowHash(steps) };
    fields = { revertOf: { taskId: origin.id, commit: landed.commit } };
  } else {
    const bugfix = serviceFlow(state, "bugfix");
    steps = structuredClone(bugfix.steps);
    flow = flowRef(bugfix, "service");
  }

  const r = M.createFollowUp(state, origin.id, now, { steps, flow, holdBeforeStart: a.holdBeforeStart, author: "user", fields });
  const content: SpecContent = structuredClone(M.currentSpec(getTask(r.state, r.newId)).content);
  const selected = content.options.find((o) => o.id === content.selectedOptionId);
  if (a.kind === "revert") {
    content.title = `Revert: ${title}`;
    content.whyNow = note || "Sent back as a revert from the Review list.";
    content.outcome = `The change ${origin.id} landed on ${landed.target} (${c12}) is undone; work that landed after it is kept.`;
    content.scopeIncluded = [`Revert commit ${landed.commit}`];
    content.scopeExcluded = ["Any change beyond undoing that commit"];
    content.successCriteria = [];
    content.acceptance = [`The files ${origin.id} changed are back to their earlier content, except where later work changed them`, "No conflict markers remain"];
    if (selected) selected.approach = `Undo ${origin.id} (${c12}) with the revert prepared in the workspace; resolve conflicts and keep later work.`;
  } else {
    const findings = landedReviews(state, origin).filter((f) => f.openFindings > 0);
    content.title = `Fix: ${title}`;
    content.whyNow = `Sent back from the Review list after ${origin.id} landed on ${landed.target} (${c12}).`;
    content.outcome = note;
    content.scopeIncluded = [
      `Fix the problem in the work ${origin.id} landed (${c12})`,
      ...findings.map((f) => `Open review finding (${f.stepId}, ${f.openFindings} open): ${clip(f.summary, 300)}`),
      ...(landed.mainCheck?.state === "failure" ? [`The check on ${landed.target} failed after this change landed${landed.mainCheck.url ? ` (${landed.mainCheck.url})` : ""}`] : []),
    ];
    content.successCriteria = [];
    content.acceptance = [`The reported problem is fixed: ${clip(note, 300)}`, "Behaviour outside the fix is unchanged"];
    if (selected) selected.approach = `Fix the problem reported after ${origin.id} landed: ${clip(note, 600)}`;
  }
  const s = structuredClone(M.editSpec(r.state, r.newId, 1, content, `Sent back as a ${a.kind} from the Review list`, "user", now));
  const l = s.tasks.find((x) => x.id === origin.id)!.integration!.landed!;
  l.status = "sent-back";
  l.statusAt = now;
  l.followUps.push({ taskId: r.newId, kind: a.kind });
  // The send-back reason is always kept: the cap applies to notes added one by one.
  if (note) {
    s.seq += 1;
    l.notes.push({ id: `note-${s.seq}`, at: now, text: note });
  }
  event(s, now, "user", "integration", `Sent back as a ${a.kind}: ${r.newId}${a.holdBeforeStart ? " (held before start)" : ""}`, origin.id);
  return { state: s, newId: r.newId };
}

// ====================================================================================================
// Pull-request delivery: hold and notify (ORC-008 step 2)
//
// Desired state (config, holds, merge requests), intent (`pr.op`) and observed state (`pr.observed`,
// `project.github`) are separate fields. "Merged", "posted" and "closed" are written only from an
// observation. Everything here is pure; the service's PrDriver performs the operations this plans.
//
// Independent review coverage, the dedicated review task, bounded repair, the automatic merge of one
// candidate at a time, the base update and the pause when the base branch fails are step 3 (below).
// Automatic merging happens only when the pull request's policy is "auto", an independent review is
// clean for the exact change, every required check passed on the exact head, GitHub reports it
// mergeable, and nothing is paused or held.
// ====================================================================================================

const MIN = 60_000;

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
  /** ORC-013: dedicated check runs the service starts per pull request. */
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
  /** ORC-013 §7.3: re-runs of GitHub-cancelled jobs per pull request over its life, and per operation. */
  reruns: 5,
  /** After a re-run was requested, the cancelled run still shown counts as pending for this long, or this many observations. */
  rerunWaitMs: 5 * MIN,
  rerunObservations: 2,
};

/** How long each operation may run (the driver's timeouts, summed over its network calls). */
export const OP_TIMEOUT_MS: Record<"publish" | "push" | "merge" | "close" | "rerun", number> = { publish: 240_000, push: 120_000, merge: 120_000, close: 120_000, rerun: 120_000 };

const BACKOFF_MIN = [1, 2, 4, 8, 15];
const sanitizeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
/** A GitHub app slug (ORC-013 §7.5). */
const REVIEW_BOT_SLUG = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NO_CI_ID = "no-ci";

/** The posture line for the user's "no CI" declaration (ORC-013 §7.4), added or removed. */
function withNoCiPosture(posture: PostureItem[], noCi: boolean): PostureItem[] {
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

// ---------- what the service reports ----------

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
 * read. "rerun" (ORC-013 §7.3) asks GitHub Actions to run cancelled jobs of the head again.
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

// ---------- small views ----------

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
function openSlotsFull(s: State): string | undefined {
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

function prTask(s: State, taskId: string): { task: Task; pr: PrDelivery } {
  const task = getTask(s, taskId);
  const pr = livePr(task);
  if (!pr) throw new ControlError(`${taskId} has no pull request.`);
  return { task, pr };
}

const prName = (pr: PrDelivery) => (pr.number ? `PR #${pr.number}` : `the pull request branch ${pr.branch}`);

function safePrUrl(pr: PrDelivery, number: number, url: string): string {
  if (pr.simulated || GITHUB_URL.test(url)) return url;
  return REPO.test(pr.repo) ? `https://github.com/${pr.repo}/pull/${number}` : "";
}

// ---------- independent review (design §9.1, §9.2) ----------

/**
 * Does a review by this provider count as independent? Judged against everyone who authored a change
 * the pull request holds, not only the author of its newest commit: a fix pushed by another provider
 * never makes the first provider independent of its own work. An unknown author fails closed.
 */
function independent(s: State, pr: PrDelivery, provider: ProviderId | undefined): boolean {
  if (s.project.prDelivery.reviewer === "any-agent") return true;
  return !!provider && M.independentProviders(M.prAuthors(pr)).includes(provider);
}

/** No agent's review can be independent: every provider wrote part of the pull request, or an author is unknown. */
function nobodyIndependent(s: State, pr: PrDelivery): boolean {
  return s.project.prDelivery.reviewer !== "any-agent" && M.independentProviders(M.prAuthors(pr)).length === 0;
}

const NEEDS_USER = "Merge it yourself, or let any agent count as the reviewer (Settings → Delivery).";
function nobodyReason(pr: PrDelivery): string {
  const authors = M.prAuthors(pr);
  return authors.includes("unknown")
    ? `Who wrote part of this pull request is not on record, so no agent's review of ${sha12(pr.changeSha)} can be shown to be independent. ${NEEDS_USER}`
    : `${M.authorsLabel(authors)} each wrote part of this pull request, so no agent's review of ${sha12(pr.changeSha)} is independent, and no provider reviews its own work. ${NEEDS_USER}`;
}

/**
 * Where the independent review of a pull request's change stands.
 * "missing" and "not-independent": a dedicated review can cure it and none exists yet.
 * "pending": a dedicated review is queued or running. "findings": the review that saw the change
 * reported open findings. "blocked": it needs the user. The dedicated review cannot run, ran on a
 * provider that wrote part of the pull request, or was cancelled by the user; or no provider is left
 * that wrote none of it (or an author is unknown), so no agent's review could be independent.
 * "limit": the service already started as many dedicated reviews as it may.
 */
export type ReviewState = "ok" | "pending" | "missing" | "not-independent" | "findings" | "blocked" | "limit" | "too-large";
export interface ReviewView {
  state: ReviewState;
  evidence: ReviewEvidence;
  /** The dedicated review task this is about, if any. */
  reviewTaskId?: string;
}

function lastCompletedRun(s: State, taskId: string, stepId: string): Attempt | undefined {
  let run: Attempt | undefined;
  for (const a of s.attempts) if (a.taskId === taskId && a.stepId === stepId && a.outcome === "completed") run = a;
  return run;
}

interface Covering {
  art: Artifact;
  run: Attempt;
  role: RoleId;
}

const modelOf = (run: Attempt) => run.actualModel ?? run.snapshot.model;
const findingsText = (n: number) => `${n} open finding${n === 1 ? "" : "s"}`;
const sameSha = (a: string, b: string) => a === b || (a.length >= 12 && b.length >= 12 && (a.startsWith(b) || b.startsWith(a)));

/**
 * ORC-013 §5.4: may a review artifact count as evidence for the change `sha`? Findings someone still
 * has to fix or decide are evidence whatever the coverage (they keep the gate blocked and drive the
 * repair). A clean review counts only when a person wrote it, or when its coverage is complete for
 * exactly this change, or when the service recorded no changed-path set for the run at all (nothing
 * under review). A record from before coverage existed, an incomplete or an unproven one never
 * counts as clean.
 */
function countsFor(s: State, art: Artifact, sha: string): boolean {
  if (art.author === "user") return true;
  if (F.unresolved(s, art) > 0) return true;
  const c = art.pathCoverage;
  if (!c || !coverageCounts(c)) return false;
  return c.state === "not-required" || (!!c.to && sameSha(c.to, sha));
}

/** The finished review steps of a task whose accepted findings satisfy `covers` and count for `pr`'s change. */
function reviewsOf(s: State, c: Task, pr: PrDelivery, covers: (run: Attempt) => boolean): Covering[] {
  const out: Covering[] = [];
  for (const st of c.steps) {
    if (st.state !== "done" || !REVIEW_ROLES.includes(st.role)) continue;
    for (const o of st.outputs) {
      if (o.kind !== "review-findings") continue;
      const art = M.acceptedOutput(s, c, st.id, o.name);
      // For findings a person edited, the run is the one whose output they edited.
      const run = lastCompletedRun(s, c.id, st.id);
      if (art && run && covers(run) && countsFor(s, art, pr.changeSha)) out.push({ art, run, role: st.role });
    }
  }
  return out;
}

/** Evidence from a set of reviews that saw the change: unresolved findings, then independence. */
function judge(s: State, pr: PrDelivery, covering: Covering[], source: "pipeline" | "dedicated", taskId: string): ReviewView {
  const h = sha12(pr.changeSha);
  const base = { source, forSha: pr.changeSha, taskId, artifactIds: covering.map((x) => x.art.id) };
  const open = covering.reduce((n, x) => n + F.unresolved(s, x.art), 0);
  if (open > 0) return { state: "findings", evidence: { ok: false, ...base, reason: `The review of ${h} reported ${findingsText(open)}.` } };
  const code = covering.filter((x) => x.role === "code_reviewer");
  const by = code.find((x) => independent(s, pr, isProvider(x.run.snapshot.provider) ? x.run.snapshot.provider : undefined));
  if (!by) {
    const who = code[0].run.snapshot.provider;
    const authors = M.prAuthors(pr);
    const why = authors.includes("unknown")
      ? "and who wrote part of this pull request is not on record"
      : authors.filter((a) => a !== "user").length > 1
        ? `which wrote part of this pull request (written by ${M.authorsLabel(authors)})`
        : "the provider that wrote the change";
    return {
      state: "not-independent",
      evidence: { ok: false, ...base, attemptId: code[0].run.id, ...(isProvider(who) ? { provider: who } : {}), model: modelOf(code[0].run), reason: `The review of ${h} was done by ${M.providerLabel(who)}, ${why}, so it does not count as independent.` },
    };
  }
  const cleared = covering.some((x) => x.art.author === "user");
  // ORC-013: findings someone decided to accept as they are do not block, and the evidence names them.
  const accepted = covering.flatMap((x) => F.acceptedFindings(s, x.art));
  const provider = by.run.snapshot.provider;
  return {
    state: "ok",
    evidence: {
      ok: true,
      ...base,
      attemptId: by.run.id,
      ...(isProvider(provider) ? { provider } : {}),
      model: modelOf(by.run),
      reason: `Clean review of ${h} by ${M.providerLabel(provider)}${cleared ? " (findings cleared by you)" : ""}${accepted.length ? `; ${accepted.length} finding${accepted.length === 1 ? "" : "s"} accepted as is (${accepted.slice(0, 5).join("; ")})` : ""}.`,
      ...(cleared ? { clearedByUser: true } : {}),
      ...(accepted.length ? { accepted } : {}),
    },
  };
}

const noReview = (pr: PrDelivery, reason: string): ReviewEvidence => ({ ok: false, source: "none", reason, forSha: pr.changeSha, artifactIds: [] });

/**
 * The task's own review counts only when it provably covers the final change: a finished code review
 * and a finished security review whose runs received exactly the final change as an input. A finished task alone proves nothing (when
 * a repair loop runs out, its last repair is never reviewed).
 */
function pipelineReview(s: State, pr: PrDelivery): ReviewView {
  const h = sha12(pr.changeSha);
  const missing: ReviewView = { state: "missing", evidence: noReview(pr, `No review saw the final change ${h}.`) };
  const c = s.tasks.find((x) => x.id === pr.changeTaskId);
  if (!c) return missing;
  // Simulated runs make code-change artifacts without commits: the newest one stands for the final change.
  const fc = M.finalChange(s, c) ?? (pr.simulated ? s.artifacts.filter((a) => a.taskId === c.id && a.kind === "code-change").pop() : undefined);
  if (!fc) return missing;
  if (!pr.simulated) {
    const ref = fc.ref?.split(" ")[0] ?? "";
    if (ref.length < 7 || !pr.changeSha.startsWith(ref)) return missing;
  }
  const covering = reviewsOf(s, c, pr, (run) => run.snapshot.inputs.some((i) => i.artifactId === fc.id));
  if (!covering.some((x) => x.role === "code_reviewer")) {
    // ORC-013: a review that saw the change but did not list the files it covered is not clean evidence.
    const saw = c.steps.some((st) => st.state === "done" && st.role === "code_reviewer" && lastCompletedRun(s, c.id, st.id)?.snapshot.inputs.some((i) => i.artifactId === fc.id));
    return saw ? { state: "missing", evidence: noReview(pr, `The review of ${h} did not list the files it covered, so it does not count.`) } : missing;
  }
  const v = judge(s, pr, covering, "pipeline", c.id);
  // ORC-021 review 1: a clean pass also needs a security review that saw the final change; without one the
  // dedicated review (which has one) runs. Findings and a review that is not independent stand as they are.
  if (v.state === "ok" && !covering.some((x) => x.role === "security_reviewer")) return { state: "missing", evidence: noReview(pr, `No security review saw the final change ${h}.`) };
  return v;
}

/**
 * The dedicated review tasks of this pull request for the change it holds now, oldest first.
 * `withCancelled`: also the ones a person cancelled (never the ones the service cancelled itself).
 */
function reviewTasksFor(s: State, t: Task, pr: PrDelivery, withCancelled = false): Task[] {
  return s.tasks.filter(
    (x) => x.reviewTarget?.taskId === t.id && x.reviewTarget.n === pr.n && x.reviewTarget.headSha === pr.changeSha && (x.lifecycle !== "cancelled" || (withCancelled && x.cancelledBy !== "system")),
  );
}

function dedicatedReview(s: State, t: Task, pr: PrDelivery): ReviewView | undefined {
  const all = reviewTasksFor(s, t, pr, true);
  const last = all[all.length - 1];
  if (!last) return undefined;
  if (last.lifecycle === "cancelled") {
    // An earlier review that finished clean still stands. Otherwise the cancellation is the user's
    // word: the review is not missing, and the service does not start another behind their back.
    const earlier = all.filter((x) => x.lifecycle === "done").pop();
    const v = earlier && finishedReview(s, pr, earlier);
    if (v?.state === "ok") return v;
    return {
      state: "blocked",
      reviewTaskId: last.id,
      evidence: noReview(pr, `The independent review ${last.id} of ${sha12(pr.changeSha)} was cancelled${last.cancelledBy === "lead" ? " by the lead" : " by you"}, so no other is started. Ask for a review, or merge it yourself.`),
    };
  }
  return finishedReview(s, pr, last);
}

/** Where one dedicated review task (not cancelled) stands. */
function finishedReview(s: State, pr: PrDelivery, rv: Task): ReviewView {
  const h = sha12(pr.changeSha);
  if (rv.lifecycle !== "done") {
    const blocked = rv.steps.find((x) => x.state === "blocked");
    if (blocked) return { state: "blocked", reviewTaskId: rv.id, evidence: noReview(pr, `The independent review ${rv.id} cannot run: ${blocked.blockedReason ?? "its step is blocked"}`) };
    // ORC-009 review finding 1: steering rejects delivery tasks, but a deferral reached by any other path
    // must be reported as what it is: nothing starts on the review until the deferral is lifted.
    const deferred = !M.activeAttempts(s, rv.id).length && M.deferredBy(s, rv);
    if (deferred) {
      return { state: "blocked", reviewTaskId: rv.id, evidence: noReview(pr, `The independent review ${rv.id} of ${h} is deferred${deferred.task.id !== rv.id ? ` with ${deferred.task.id}` : ""}, so it does not run. Run it now to continue, or merge it yourself.`) };
    }
    // ORC-012 review 1: while shaping the review, like any other work, waits for Start building; it is not queued.
    const how = M.activeAttempts(s, rv.id).length ? "running" : rv.hold || rv.holdBeforeStart ? "paused" : s.project.stage === "shaping" ? "held: it waits until you start building (shaping)" : "queued";
    return { state: "pending", reviewTaskId: rv.id, evidence: noReview(pr, `The independent review ${rv.id} of ${h} is ${how}.`) };
  }
  // A dedicated review counts only when its run read a worktree detached at exactly this commit, and
  // (ORC-013) only when it listed the files it covered.
  const all = reviewsOf(s, rv, pr, () => true);
  if (!all.some((x) => x.role === "code_reviewer") || all.some((x) => x.run.snapshot.reviewedSha !== pr.changeSha)) {
    const ran = rv.steps.some((st) => st.state === "done" && st.role === "code_reviewer" && lastCompletedRun(s, rv.id, st.id)?.snapshot.reviewedSha === pr.changeSha);
    return { state: "missing", reviewTaskId: rv.id, evidence: noReview(pr, ran ? `The review ${rv.id} of ${h} did not list the files it covered, so it does not count.` : `The review ${rv.id} did not read ${h}, so it does not count.`) };
  }
  const v = judge(s, pr, all, "dedicated", rv.id);
  if (v.state === "not-independent") {
    // The reviewer was the user's own choice (a pin or an override). Nothing is substituted and no second review is started.
    return { state: "blocked", reviewTaskId: rv.id, evidence: { ...v.evidence, reason: `${v.evidence.reason} Choose another reviewer and ask for a new review, or let any agent count (Settings → Delivery).` } };
  }
  return { ...v, reviewTaskId: rv.id };
}

/** Where the independent review of this pull request's change stands now. Pure. */
export function reviewView(s: State, t: Task): ReviewView {
  const pr = t.integration?.pr;
  if (!pr) return { state: "missing", evidence: { ok: false, source: "none", reason: "No pull request.", artifactIds: [] } };
  const own = pipelineReview(s, pr);
  if (own.state === "ok") return own;
  // A dedicated review of this exact change, once one exists, is the newer word.
  const dedicated = dedicatedReview(s, t, pr);
  if (dedicated && dedicated.state !== "missing") return dedicated;
  if (own.state === "findings") return own;
  // Review 1 (8): above the coverage limit no agent review can ever be shown complete, so none is started; the user merges.
  if (pr.changed.files > MAX_PROVEN_PATHS) {
    return { state: "too-large", evidence: noReview(pr, `The change ${sha12(pr.changeSha)} touches ${pr.changed.files} files, too many for a review to show it covered them all (the limit is ${MAX_PROVEN_PATHS}). No review is started; look at it and merge it yourself.`) };
  }
  const base = dedicated ?? own;
  // Every provider wrote part of it (or an author is unknown): no review can cure that, so none is started.
  if (nobodyIndependent(s, pr)) return { ...base, state: "blocked", evidence: { ...base.evidence, ok: false, reason: nobodyReason(pr) } };
  if (pr.counters.reviews >= PR_LIMITS.reviews) {
    return { ...base, state: "limit", evidence: { ...base.evidence, reason: `${base.evidence.reason} ${PR_LIMITS.reviews} dedicated reviews were already started for this pull request. Ask for another yourself, or merge it yourself.` } };
  }
  return base;
}

/**
 * Review evidence for a pull request's change (design §9.1): the task's own review when it provably
 * covers the final change and was done by another provider than the author, else a finished dedicated
 * review of exactly that change. Evidence always names the change it is for.
 */
export function reviewCoverage(s: State, t: Task): ReviewEvidence {
  return reviewView(s, t).evidence;
}

/** Create the dedicated review task. Mutates the draft `s`. */
function startReview(s: State, t: Task, pr: PrDelivery, now: string, actor: "user" | "system"): string {
  const h = sha12(pr.changeSha);
  const ids = new Set(s.tasks.map((x) => x.id));
  let k = 1;
  while (ids.has(`${t.id}-RV${k}`)) k++;
  const id = `${t.id}-RV${k}`;
  // ORC-016: the dedicated review pipeline is the service's own; no flow file can replace it.
  // ORC-021: it carries a security review beside the code review; both are independent of the writer,
  // and the findings of either gate the merge (`judge` counts every review role).
  const review = internalFlow("delivery-review");
  const defs = review.steps.map(toDef);
  const named = new Set<RoleId>();
  for (const d of defs) {
    if (d.role !== "code_reviewer" && d.role !== "security_reviewer") continue;
    // The independence rule is not the pipeline's to drop.
    d.independentOf = "writer";
    if (!named.has(d.role)) d.purpose = `${d.role === "security_reviewer" ? "Security review of" : "Review"} ${t.id} for merge into ${pr.base} at ${h}`;
    named.add(d.role);
  }
  // The hash is of the steps that run, with the rewritten purpose and the independence rule (step 1 review, finding 5).
  const flow: FlowRef = { ...flowRef(review, "service"), hash: flowHash(defs) };
  const content: SpecContent = structuredClone(M.currentSpec(t).content);
  const title = content.title;
  content.title = `Review for merge: ${title}`;
  content.whyNow = `${pr.review.reason} A pull request merges only after a review by ${s.project.prDelivery.reviewer === "any-agent" ? "an agent" : "another provider than the one that wrote the change"}.`;
  content.benefit = "The change is looked at independently before it reaches the base branch.";
  const selected = content.options.find((o) => o.id === content.selectedOptionId);
  if (selected) selected.approach = `Review the change ${h} of ${t.id} against its specification. This is a review, not a second implementation. Original approach: ${clip(selected.approach, 600)}`;
  s.tasks.push({
    id,
    priority: t.priority,
    lifecycle: "ready",
    hold: false,
    holdBeforeStart: false,
    specs: [{ rev: 1, at: now, author: "system", reason: `Independent review of ${t.id} (${h}) before it merges into ${pr.base}`, content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    reviewTarget: { taskId: t.id, n: pr.n, headSha: pr.changeSha, baseSha: pr.baseSha },
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "system", reason: "Created from the Delivery review flow", steps: defs.map(toDef), flow }],
    flow,
    flowSince: 1,
  });
  pr.reviewTaskIds.push(id);
  pr.counters.reviews += 1;
  event(s, now, actor, "integration", `Independent review ${id} created for ${prName(pr)} at ${h}: ${clip(pr.review.reason, 200)}`, t.id);
  return id;
}

/**
 * Make sure one dedicated review exists when the change needs one (design §9.2): coverage failed for a
 * reason a review can cure, and no review of this change exists or is running. Never for open
 * findings (those go to repair), never a second one for the same change, never past the cap.
 */
export function ensureReview(state: State, taskId: string, now: string): State {
  const { task, pr } = prTask(state, taskId);
  if (pr.phase !== "built" && pr.phase !== "open") return state;
  // Nothing new is started while delivery is off, the project is paused or the pull request is held.
  if (!mayStartWork(state, pr)) return state;
  const v = reviewView(state, task);
  if (v.state !== "missing" && v.state !== "not-independent") return state;
  const s = structuredClone(state);
  const t = getTask(s, taskId);
  const p = t.integration!.pr!;
  p.review = v.evidence;
  startReview(s, t, p, now, "system");
  p.review = reviewView(s, t).evidence;
  refreshAttention(s, t, now);
  return s;
}

/** May the service start a review or a fix for this pull request now? Not while anything is paused, held, taken over or closing. */
function mayStartWork(s: State, pr: PrDelivery): boolean {
  return s.project.prDelivery.enabled && !s.project.hold && !pr.userHold && !pr.foreignHead && !pr.closeRequested && !stuck(pr) && !wrongRepo(s, pr);
}

/** The user asks for a dedicated review now. They may exceed the service's cap; one at a time per change. */
export function requestPrReview(state: State, taskId: string, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "review");
  if (!s.project.prDelivery.enabled) throw new ControlError("Pull-request delivery is off, so no review is started. Switch the delivery mode back on first.");
  const open = reviewTasksFor(s, task, pr).find((x) => x.lifecycle !== "done");
  if (open) throw new ControlError(`${open.id} is already reviewing this change.`);
  // A review that could never count is not started: no provider reviews its own work.
  if (nobodyIndependent(s, pr)) throw new ControlError(nobodyReason(pr));
  startReview(s, task, pr, now, "user");
  pr.review = reviewView(s, task).evidence;
  refreshAttention(s, task, now);
  return s;
}

// ---------- ORC-013 §6.9: the service's own checks on a pull request's change ----------

/** The dedicated check tasks of this pull request: for the change it holds now, or (`anySha`) any change of this delivery. */
function checkTasksFor(s: State, t: Task, pr: PrDelivery, anySha = false): Task[] {
  return s.tasks.filter((x) => x.checkTarget?.taskId === t.id && x.checkTarget.n === pr.n && (anySha || x.checkTarget.sha === pr.changeSha));
}

/** Create the dedicated check task for the change the pull request holds. Mutates the draft `s`. */
function startChecks(s: State, t: Task, pr: PrDelivery, now: string): string {
  const h = sha12(pr.changeSha);
  const ids = new Set(s.tasks.map((x) => x.id));
  let k = 1;
  while (ids.has(`${t.id}-CK${k}`)) k++;
  const id = `${t.id}-CK${k}`;
  // ORC-016: the dedicated check pipeline is the service's own; no flow file can replace it.
  const checks = internalFlow("delivery-checks");
  const defs = checks.steps.map(toDef);
  const flow = flowRef(checks, "service");
  const content: SpecContent = structuredClone(M.currentSpec(t).content);
  const title = content.title;
  content.title = `Checks for merge: ${title}`;
  content.whyNow = `The change ${h} of ${t.id} has no service-check result under the current check settings. A pull request merges only once the project's checks passed on exactly its change.`;
  content.benefit = "The project's own checks run on the change before it reaches the base branch.";
  const selected = content.options.find((o) => o.id === content.selectedOptionId);
  if (selected) selected.approach = `The service runs the project's checks on ${h} of ${t.id}. No agent is involved.`;
  s.tasks.push({
    id,
    priority: t.priority,
    lifecycle: "ready",
    hold: false,
    holdBeforeStart: false,
    specs: [{ rev: 1, at: now, author: "system", reason: `Service checks on ${t.id} (${h}) before it merges into ${pr.base}`, content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    checkTarget: { taskId: t.id, n: pr.n, sha: pr.changeSha },
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "system", reason: "Created from the Delivery checks flow", steps: defs.map(toDef), flow }],
    flow,
    flowSince: 1,
  });
  pr.counters.checks = (pr.counters.checks ?? 0) + 1;
  event(s, now, "system", "integration", `Check run ${id} created for ${prName(pr)} at ${h}: no service-check result for this change under the current settings`, t.id);
  return id;
}

/**
 * Make sure one dedicated check run exists when the change needs one (§6.9): checks are on, the
 * change has no result under the current settings, no check task for it is open, fewer than the cap
 * were started, and nothing is paused. A failed result is a repair's job, never another run's.
 */
export function ensureChecks(state: State, taskId: string, now: string): State {
  const { task, pr } = prTask(state, taskId);
  if (pr.phase !== "built" && pr.phase !== "open") return state;
  if (!C.checksOn(state.project.checks) || !mayStartWork(state, pr)) return state;
  const ev = C.checkEvidence(state, pr.changeSha);
  if (ev.ok || ev.attemptId) return state;
  if (checkTasksFor(state, task, pr).some((x) => x.lifecycle !== "cancelled" && x.lifecycle !== "done")) return state;
  if ((pr.counters.checks ?? 0) >= PR_LIMITS.checks) return state;
  const s = structuredClone(state);
  const t = getTask(s, taskId);
  startChecks(s, t, t.integration!.pr!, now);
  refreshAttention(s, t, now);
  return s;
}

// ---------- repair into the open pull request (design §9.3) ----------

export type RepairCause =
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
 * or open findings. ORC-013 §7.2: only `code` failures are a fix task's business; a cancelled run, a
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
  // ORC-013 §6.9: the service's own checks failed on the change (under the current settings).
  if (C.checksOn(s.project.checks)) {
    const ev = C.checkEvidence(s, pr.changeSha);
    const art = !ev.ok && ev.attemptId ? s.artifacts.find((a) => a.attemptId === ev.attemptId && a.kind === "check-results") : undefined;
    const results = art?.checkRun ? C.failedResults(art.checkRun).filter((r) => r.kind === "check").map((r) => ({ id: r.id, label: r.label, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}) })) : [];
    if (results.length) return { kind: "service-checks", sha: pr.changeSha, results };
  }
  const v = reviewView(s, t);
  if (v.state === "findings") {
    // ORC-013: only what a repair may fix is listed (auto-fix findings and those decided "fix"), each
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

/** ORC-013: the review's open findings are all ask-user findings nobody has decided yet. */
function onlyUndecided(s: State, t: Task): { count: number; to: "lead" | "user" | "both" } | undefined {
  const v = reviewView(s, t);
  if (v.state !== "findings") return undefined;
  const arts = s.artifacts.filter((a) => v.evidence.artifactIds.includes(a.id));
  let undecided = 0;
  let lead = 0;
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
      else user++;
    }
  }
  return undecided ? { count: undecided, to: lead && user ? "both" : lead ? "lead" : "user" } : undefined;
}

/** Create the fix task and link it. Returns the new state (a fresh object) and the task's id. */
function startRepair(state: State, taskId: string, cause: RepairCause, now: string, actor: "user" | "system"): { state: State; newId: string } {
  const origin = getTask(state, taskId);
  const pr0 = origin.integration!.pr!;
  const title = M.currentSpec(origin).content.title;
  const h = sha12(pr0.headSha);
  // ORC-016: a fix runs Change, chosen by the service.
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
 * One bounded fix task whose result is pushed onto the same pull request (design §9.3). At most
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

function cancelLinked(state: State, ids: string[], now: string, reason: string): State {
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
    // ORC-013 §6.9: the service-check evidence for the change it holds, under the current settings.
    if (C.checksOn(s.project.checks)) getTask(s, id).integration!.pr!.checks = C.checkEvidence(s, getTask(s, id).integration!.pr!.changeSha);
    else delete getTask(s, id).integration!.pr!.checks;
    // The one dedicated review the change needs (it returns the same state when none is needed or allowed).
    s = ensureReview(s, id, now);
    // ORC-013: and the one check run it needs, when the change has no result of its own.
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

// ---------- the merge queue: one candidate at a time (design §6.4) ----------

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
function dropStaleUpdate(s: State, t: Task, now: string) {
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
function wrongRepo(s: State, pr: PrDelivery): boolean {
  const now = s.project.github?.repo;
  return !!now && !!pr.repo && pr.repo !== now;
}

// ---------- the merge gate (design §9.5) ----------

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

// ---------- CI triage (ORC-013 §7) ----------

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

export interface TriageContext {
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
function triageContext(s: State, pr: PrDelivery, ob: { checks: CheckObs[] }, c: CheckObs): TriageContext {
  const used = rerunsUsed(pr, c.name);
  const reran = used.length > 0 && used.length >= s.project.prDelivery.rerunBudget && !used.some((u) => staleAfterRerun(c, u));
  return { all: ob.checks, reran };
}
const classOf = (s: State, pr: PrDelivery, ob: { checks: CheckObs[] }, c: CheckObs) => triageCheck(s.project.prDelivery, c, triageContext(s, pr, ob, c));

const CLASS_WORD: Record<CiClass, string> = { bot: "review bot", provider: "cancelled by GitHub", "not-run": "did not run", code: "the code" };

/** "build: cancelled (cancelled by GitHub, github-actions, https://…)" — one failing check, with its class and app. */
function checkLine(cfg: PrDeliveryConfig, c: CheckObs, o: TriageContext = {}): string {
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
function gateCheckNames(s: State, pr: PrDelivery, checks: CheckObs[]): string[] {
  const names = requiredCheckNames(s, pr);
  if (names.length || !s.project.prDelivery.noCi) return names;
  return [...new Set(checks.map((c) => c.name))];
}

/** The re-runs already spent on this head, per check name. */
function rerunsUsed(pr: PrDelivery, name?: string): NonNullable<PrDelivery["ciReruns"]>["used"] {
  if (!pr.ciReruns || pr.ciReruns.headSha !== pr.headSha) return [];
  return name === undefined ? pr.ciReruns.used : pr.ciReruns.used.filter((u) => u.check === name);
}

/** The observed run of a check is still the one a re-run was requested for: the new run has not shown up yet. */
function staleAfterRerun(c: CheckObs, u: { jobId: number; at: string }): boolean {
  if (c.jobId !== undefined) return c.jobId === u.jobId;
  return !!c.startedAt && Date.parse(c.startedAt) <= Date.parse(u.at);
}

/**
 * After a re-run was requested for this check, its cancelled run still shows and the wait is not over:
 * at most 2 observations or 5 minutes (§7.3), so a provider that accepts a re-run and never
 * publishes it cannot stall the pull request.
 */
function awaitingRerun(pr: PrDelivery, c: CheckObs, nowMs: number): boolean {
  const u = rerunsUsed(pr, c.name).at(-1);
  if (!u || !staleAfterRerun(c, u)) return false;
  return (u.seen ?? 0) < PR_LIMITS.rerunObservations && nowMs - Date.parse(u.at) < PR_LIMITS.rerunWaitMs;
}

/**
 * Why this GitHub-cancelled check cannot be re-run by the app, or undefined when it can (review
 * finding L7: the gate names the true reason). The clause continues "GitHub cancelled X on <sha>".
 */
function rerunBlocker(s: State, pr: PrDelivery, c: CheckObs): string | undefined {
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
    else add("policy", "You merge this pull request", "waiting", `Hold and notify: it merges when you choose Merge for ${h12}, or merge it on GitHub.`);
  } else if (pr.policy === "auto") add("policy", "Merges automatically", "ok", "It merges by itself once everything below holds for this exact commit.");
  else add("policy", "You merge this pull request", "waiting", `Hold and notify: it merges when you choose Merge for ${h12}, or merge it on GitHub.`);

  // 2. Not paused (ORC-012 review 1: shaping is not a pause, but no delivery work starts until building)
  if (s.project.hold) add("not-paused", "Not paused", "waiting", "The project is paused: nothing is pushed, opened, merged or commented.");
  else if (pr.userHold) add("not-paused", "Not paused", "waiting", `You are holding this pull request${pr.userHold.reason ? `: ${pr.userHold.reason}` : ""}.`);
  else if (pr.closeRequested) add("not-paused", "Not paused", "waiting", "You asked to close this pull request.");
  else if (s.project.stage === "shaping") add("not-paused", "Not paused", "waiting", "Shaping: nothing is pushed, opened, merged or brought up to date until you start building. Nothing is paused.");
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

  // 6. Required checks, for exactly this head. ORC-013 §7: each failing check is classed (bot,
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
        // Every failed check was cancelled by GitHub and no re-run is planned right now (review L7):
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

  // 9b. ORC-013 §6.9: the project's own checks, run by the service on exactly this change under the
  // current settings. Shown while checks are on; for a user merge it is advisory, like the review.
  if (C.checksOn(s.project.checks)) {
    const ev = C.checkEvidence(s, pr.changeSha);
    const SC = "Service checks";
    const running = checkTasksFor(s, task, pr).find((x) => x.lifecycle !== "done" && x.lifecycle !== "cancelled");
    if (ev.ok) add("service-checks", SC, "ok", ev.reason, undefined, advisory);
    else if (ev.attemptId) add("service-checks", SC, "blocked", `${ev.reason}${note}`, "service-checks", advisory);
    else if (running) add("service-checks", SC, "waiting", `${ev.reason} ${running.id} runs them.`, undefined, advisory);
    else if ((pr.counters.checks ?? 0) >= PR_LIMITS.checks) add("service-checks", SC, "blocked", `${ev.reason} ${PR_LIMITS.checks} check runs were already started for this pull request. Merge it yourself.`, "service-checks", advisory);
    else add("service-checks", SC, "waiting", `${ev.reason} One check run is started for it${cfg.enabled && !s.project.hold && !pr.userHold ? "" : " once nothing is paused"}.`, undefined, advisory);
  }

  if (!o.byUser) {
    // 10. Paths and workers
    const local = s.project.enabledProviders.filter((p) => s.project.workerEnvironment[p] === "local");
    if (pr.changed.protectedHits.length)
      add("paths", "Protected files and workers", "blocked", `It touches protected files (${pr.changed.protectedHits.slice(0, 5).join(", ")}), which control the checks or the build, so it is never merged automatically. Look at it and merge it yourself.`, "protected-path");
    else if (local.length && !cfg.allowLocalWorkers)
      add("paths", "Protected files and workers", "blocked", `A worker environment is set to "local" (${local.map(M.providerLabel).join(", ")}), which may expose your GitHub sign-in or a GitHub MCP server to agents. Automatic merging is off until the environment is isolated, or you allow local workers in Settings → Delivery. You can merge it yourself.`, "local-workers");
    else add("paths", "Protected files and workers", "ok", local.length ? "No protected file is touched. Local worker environments are allowed by your setting." : "No protected file is touched, and workers run isolated.");

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
const userGate = (pr: PrDelivery) => pr.policy === "hold" || pr.mergeRequested?.headSha === pr.headSha;

/** Hold mode: GitHub's side is satisfied and the independent review is clean; only the user's Merge is missing. */
export function prReady(s: State, task: Task, nowMs: number): boolean {
  const pr = livePr(task);
  if (!pr || pr.phase !== "open" || pr.policy !== "hold" || pr.op) return false;
  return prGate(s, task, nowMs, { byUser: true }).items.every((i) => i.ok || i.id === "policy");
}

/** Say once per head that a held pull request is ready: its checks passed and its review is clean. */
function announceReady(s: State, t: Task, now: string) {
  const pr = livePr(t);
  // Judged at the time GitHub was last read, like everything that depends on what it showed.
  if (!pr || !prReady(s, t, Date.parse(pr.observed?.at ?? now))) return;
  const msg = `${prName(pr)} is ready for you: required checks passed on ${sha12(pr.headSha)}`;
  if (!s.events.some((e) => e.taskId === t.id && e.message === msg)) event(s, now, "system", "integration", msg, t.id);
}

/** Reasons a head is never pushed: they end only when the delivery is closed (and delivered again). */
const STICKY: PrAttentionCode[] = ["remote-diverged", "foreign-commits"];
const stuck = (pr: PrDelivery) => !!pr.attention && STICKY.includes(pr.attention.code);
/** Reasons a fix task may be working on (bot-check only at the user's request; never automatically). */
const REPAIRABLE: PrAttentionCode[] = ["checks-failed", "service-checks", "review-findings", "conflict", "bot-check"];

/** Set or clear `pr.attention` from the current facts. `since` moves only when the reason or the head changes. */
function refreshAttention(s: State, t: Task, now: string) {
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
    next = { code: "publish-failed", message: `Pushing the branch and opening the pull request failed ${pr.counters.failures} times${pr.message ? `: ${pr.message}` : ""}. Hold and release it to try again, or close it and deliver again.` };
  else {
    // Judged at the time GitHub was last read: a timeout is never declared for a period nobody looked.
    const blocking = prGate(s, t, Date.parse(pr.observed?.at ?? now), { byUser: userGate(pr) }).items.find((i) => i.state === "blocked" && i.code && (pr.phase === "open" || i.id === "review"));
    if (blocking) next = { code: blocking.code!, message: blocking.detail };
    // ORC-013: open findings that all wait for a decision are a decision, not a fix.
    const undecided = blocking?.code === "review-findings" ? onlyUndecided(s, t) : undefined;
    if (undecided) {
      const who = undecided.to === "both" ? "you and the lead" : undecided.to === "lead" ? "the lead" : "you";
      next = { code: "findings-decision", message: `${undecided.count} finding${undecided.count === 1 ? "" : "s"} of the review of ${sha12(pr.changeSha)} need${undecided.count === 1 ? "s" : ""} a decision (${who}). Nothing is fixed until it is taken.` };
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

// ---------- the pull request's text ----------

export function prTitle(t: Task): string {
  return clip(`${t.id}: ${M.currentSpec(t).content.title}`, 200);
}

/** Public text: the repository may be public. The caller redacts it before it leaves the machine. */
export function prBody(s: State, t: Task): string {
  const pr = t.integration!.pr!;
  const c = M.currentSpec(t).content;
  const lines = [
    c.outcome,
    "",
    ...(c.acceptance.length ? ["Acceptance:", ...c.acceptance.map((a) => `- ${a}`), ""] : []),
    ...(pr.review.ok ? [`Automated review by Orchestrator (${pr.review.provider ? M.providerLabel(pr.review.provider) : "agent"}${pr.review.model ? ` · ${pr.review.model}` : ""}), not a human review: 0 open findings on ${sha12(pr.changeSha)}.`, ""] : []),
    "Opened by Orchestrator using this GitHub account.",
  ];
  return `${clip(lines.join("\n"), 5800)}\n\n${prMarker(s.project.id, t.id, pr.n)}`;
}

export function mergeSubject(t: Task): string {
  const pr = t.integration!.pr!;
  return clip(`${t.id}: ${M.currentSpec(t).content.title} (#${pr.number})`, 200);
}

export function mergeBody(s: State, t: Task): string {
  const pr = t.integration!.pr!;
  const checks = requiredCheckNames(s, pr);
  const byUser = pr.mergeRequested?.headSha === pr.headSha;
  const reviewer = pr.review.provider ? ` (${M.providerLabel(pr.review.provider)}${pr.review.model ? ` · ${pr.review.model}` : ""})` : "";
  return [
    byUser ? `Merged from Orchestrator at the user's request, for head ${sha12(pr.headSha)}.` : `Merged automatically by Orchestrator, for head ${sha12(pr.headSha)}.`,
    checks.length ? `Required checks passed on that head: ${checks.join(", ")}.` : "",
    pr.review.ok ? `Automated review by Orchestrator${reviewer}, not a human review: 0 open findings on ${sha12(pr.changeSha)}.` : "",
    pr.headSha !== pr.changeSha ? `The head is the reviewed change ${sha12(pr.changeSha)} with ${pr.base} (${sha12(pr.baseSha)}) merged into it by Orchestrator.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- integration in pull-request mode ----------

export interface PrHeadFacts {
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
 * where they supplied a commit. Candidates of a best-of step that were not chosen are not part of it.
 */
function changeAuthorsOf(s: State, t: Task): ChangeAuthor[] {
  const unchosen = (stepId: string) => {
    const g = t.steps.find((x) => x.id === stepId)?.copyOf;
    if (!g) return false;
    return t.bestOf?.[g] ? t.bestOf[g] !== stepId : t.steps.find((x) => x.id === g)?.parallel?.mode === "best-of" && stepId !== g;
  };
  const out = new Set<ChangeAuthor>();
  for (const a of s.artifacts) if (a.taskId === t.id && a.kind === "code-change" && !unchosen(a.stepId)) out.add(M.artifactAuthor(s, a));
  out.add(changeAuthorOf(s, t));
  return [...out];
}

/**
 * A finished fix task's final commit becomes the pending head of the pull request it repairs (design
 * §6.2, §9.3). Nothing is pushed here. `descends`: the commit contains the pull request's current head,
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
function promoteHead(s: State, taskId: string, now: string): State {
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
  // ORC-013 §7.3: the re-run budget is per head.
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

// ---------- reports from the service ----------

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
function fetchFailed(s: State, e: OpError, now: string) {
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
function projectProblem(s: State, e: OpError, now: string) {
  const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
  if (e.code === "auth") setProblem(s, "auth", `GitHub sign-in needed (run \`gh auth login\` in a terminal). ${e.message}`, now);
  else if (e.code === "rate-limit") setProblem(s, "rate-limit", `GitHub's rate limit was reached; waiting. ${e.message}`, now, e.retryAt ?? at(5 * MIN));
  // git's own transport (an SSH key, a credential helper) is not gh's sign-in: `gh auth login` would not help.
  else if (e.code === "remote" || e.code === "git") setProblem(s, "remote", e.message, now, at(5 * MIN));
  else setProblem(s, "network", `GitHub could not be reached. ${e.message}`, now, at(MIN));
}

const isProjectError = (e: OpError) => e.code === "auth" || e.code === "rate-limit" || e.code === "git";

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
      label: "A worker environment is set to local",
      detail: `A worker environment set to "local" (${local.map(M.providerLabel).join(", ")}) may expose your GitHub sign-in or a GitHub MCP server to agents.`,
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
      if (!had) event(s, now, "system", "config", `${unpushed.count} Orchestrator commit(s) on ${unpushed.branch} are not on ${cfg.remote}/${cfg.base}; the app does not push them`);
    }
  }
  if (first) event(s, now, "system", "integration", `Fetched ${cfg.remote}/${cfg.base} (${sha12(sha)}); new work starts from it`);
  return s;
}

function backoff(pr: PrDelivery, now: string) {
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
      // ORC-013 §7.4: with the user's "no CI" declaration and nothing reported, the head has no checks to be judged by.
      const declaredNoCi = s.project.prDelivery.noCi && names.length === 0 && o.checksFor === o.headSha && o.checks.length === 0;
      const clean = o.headSha === pr.headSha && !pr.foreignHead && o.checksFor === o.headSha && (declaredNoCi || (names.length > 0 && names.every((n) => required.find((c) => c.name === n)?.conclusion === "SUCCESS")));
      const flags: LandedFlag[] = [
        ...(clean ? [] : (["merged-without-clean-gate"] as const)),
        ...(pr.review.ok && pr.review.clearedByUser ? (["findings-cleared-by-user"] as const) : []),
        // ORC-013: the review was clean apart from findings someone accepted as they are.
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
    // ORC-013 §7.3: observations after a re-run request that still show the cancelled run are counted;
    // after 2 (or 5 minutes) the check is judged as observed. The observation, not the request, decides.
    // The driver's own read right after the request never counts (review L8): GitHub has had no time
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
        // says GitHub refused it (review L9). The budget stays spent (I7).
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

// ---------- the planner ----------

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
 * The next operation for the driver, or nothing. Pure; first match wins (design §6.4). The driver
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
  // ORC-012 review 1: while shaping no delivery work starts (no publish, push, merge or base update);
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
  // 6.2b ORC-013 §7.3: re-run the GitHub-cancelled jobs of a head, once per check, before any fix task.
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
  // ORC-012 review 1: delivery work (publish, push, merge) never starts while shaping; the user's own close or note may.
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
      event(s, now, "system", "integration", `Opened pull request #${pr.number} for ${pr.branch} into ${pr.base}${pr.simulated ? " (simulated)" : ""}; ${pr.policy === "auto" ? "it merges by itself after an independent review and passing required checks" : "it is held for you"}`, t.id);
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

// ---------- commands ----------

/** Change the pull-request settings. The delivery mode itself is switched with setDeliveryMode. */
export function setPrDelivery(state: State, patch: Partial<PrDeliveryConfig>, now: string): State {
  const cur = state.project.prDelivery;
  const next: PrDeliveryConfig = { ...cur, ...patch, enabled: cur.enabled, protectedPaths: [...(patch.protectedPaths ?? cur.protectedPaths)].map((x) => String(x).trim()).filter(Boolean) };
  const int = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!REMOTE.test(next.remote)) throw new ControlError("Choose a valid remote name.");
  if (!BRANCH.test(next.base)) throw new ControlError("Choose a valid base branch name.");
  if (next.merge !== "hold" && next.merge !== "auto") throw new ControlError("Choose hold or auto.");
  if (next.reviewer !== "other-provider" && next.reviewer !== "any-agent") throw new ControlError("Choose which reviewer counts as independent.");
  if (next.protectedPaths.length > 20 || next.protectedPaths.some((x) => x.length > 200)) throw new ControlError("At most 20 protected paths of at most 200 characters each.");
  if (!int(next.maxOpenPrs, 1, 20)) throw new ControlError("Open pull requests: between 1 and 20.");
  if (!int(next.maxAutoMergesPerDay, 0, 100)) throw new ControlError("Automatic merges per day: between 0 and 100.");
  for (const k of ["updateBeforeMerge", "autoRepair", "allowLocalWorkers", "noCi"] as const) if (typeof next[k] !== "boolean") throw new ControlError(`${k} must be true or false.`);
  // ORC-013 §7.5
  if (!int(next.rerunBudget, 0, 3)) throw new ControlError("Re-runs of a cancelled check: between 0 and 3 per check per head.");
  next.reviewBotApps = [...(patch.reviewBotApps ?? cur.reviewBotApps)].map((x) => String(x).trim()).filter(Boolean);
  if (next.reviewBotApps.length > 10) throw new ControlError("At most 10 review bots.");
  if (next.reviewBotApps.some((x) => !REVIEW_BOT_SLUG.test(x))) throw new ControlError("A review bot is named by its GitHub app slug: lowercase letters, digits and hyphens, at most 39 characters.");
  if (JSON.stringify(next) === JSON.stringify(cur)) return state;
  const s = structuredClone(state);
  s.project.prDelivery = next;
  if (next.remote !== cur.remote || next.base !== cur.base) {
    // Another remote or base: check it again, and fetch it before any writer starts from it.
    const gh = s.project.github;
    if (gh) {
      gh.recheck = true;
      delete gh.base;
      delete gh.fetchFailures;
    }
  }
  if (next.noCi !== cur.noCi && s.project.github) s.project.github.posture = withNoCiPosture(s.project.github.posture, next.noCi);
  event(
    s,
    now,
    "user",
    "config",
    `Pull-request settings: ${next.remote}/${next.base}, ${next.merge === "auto" ? `merge automatically after an independent review (${next.reviewer === "any-agent" ? "any agent" : "another provider than the writer"}) and passing required checks, at most ${next.maxAutoMergesPerDay} a day` : "hold and notify"}, at most ${next.maxOpenPrs} open${next.noCi !== cur.noCi ? (next.noCi ? "; you declared this repository has no CI (your own Merge works with no checks; automatic merging still needs a required check)" : "; the no-CI declaration was withdrawn") : ""}${next.rerunBudget !== cur.rerunBudget ? `; a check GitHub cancelled is re-run ${next.rerunBudget === 0 ? "never" : `${next.rerunBudget} time${next.rerunBudget === 1 ? "" : "s"} per head`}` : ""}`,
  );
  // Another rule for who may review: a dedicated review that could not start is tried again under it.
  if (next.reviewer !== cur.reviewer) {
    for (const t of s.tasks) {
      if (!t.reviewTarget || t.lifecycle === "done" || t.lifecycle === "cancelled") continue;
      for (const st of t.steps) {
        if (st.state !== "blocked") continue;
        st.state = "pending";
        delete st.blockedReason;
      }
    }
  }
  // The project's choice applies to the pull requests that follow it; one the user set by hand keeps its own.
  for (const t of trackedPrTasks(s)) {
    const pr = t.integration!.pr!;
    if (pr.policySource === "project" && pr.policy !== next.merge) {
      pr.policy = next.merge;
      if (next.merge === "auto") delete pr.mergeRequested;
    }
    dropStaleUpdate(s, t, now);
    pr.review = reviewCoverage(s, t);
    refreshAttention(s, t, now);
  }
  return s;
}

/** Automatic merging continues: the user has looked at the failing base branch. Clears the pause and the day's count of failures. */
export function resumeAutoMerge(state: State, now: string): State {
  const gh = state.project.github;
  if (!gh?.autoMergePaused && !gh?.mainBreaks?.length) return state;
  const s = structuredClone(state);
  delete s.project.github!.autoMergePaused;
  delete s.project.github!.mainBreaks;
  event(s, now, "user", "config", "Automatic merging resumed by you");
  return s;
}

/** Run the read-only repository check now. */
export function recheckGitHub(state: State, now: string): State {
  const s = structuredClone(state);
  const gh = s.project.github ?? { ok: false, requiredChecks: [], autoMergeBlockers: [], posture: [] };
  gh.recheck = true;
  if (gh.problem) delete gh.problem.retryAt;
  s.project.github = gh;
  event(s, now, "user", "config", "Checking the GitHub repository again (read-only)");
  return s;
}

function openPr(s: State, taskId: string, what: string): { task: Task; pr: PrDelivery } {
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
  event(s, now, "user", "integration", `${prName(pr)} held by you${pr.op ? "; the operation already sent to GitHub cannot be interrupted" : ""}`, task.id);
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
  event(s, now, "user", "integration", `${prName(pr)}: ${next === "auto" ? "merges automatically after an independent review and passing required checks" : "hold and notify"}${policy === null ? " (follows the project)" : ""}`, task.id);
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

/** Try again to post a note whose comment failed. */
export function retryLandedComment(state: State, taskId: string, noteId: string, now: string): State {
  const s = structuredClone(state);
  const { task, landed } = getLanded(s, taskId);
  const note = landed.notes.find((n) => n.id === noteId);
  if (!note?.comment) throw new ControlError("That note was not meant to be posted on GitHub.");
  if (note.comment.status !== "failed") throw new ControlError(note.comment.status === "posted" ? "That note is already posted." : "That note is still waiting to be posted.");
  note.comment = { status: "pending", attempts: 0 };
  const pr = task.integration?.pr;
  if (pr) delete pr.nextAt;
  event(s, now, "user", "integration", "Posting the note on the pull request will be tried again", task.id);
  return s;
}

// ---------- labels for the UI ----------

export interface PrLabel {
  text: string;
  tone: "plain" | "strong" | "done" | "danger";
}

/** One short, truthful label for a task's delivery: what it is doing, or exactly what it waits for. */
export function prLabel(s: State, t: Task, nowMs: number): PrLabel | undefined {
  const i = t.integration;
  const pr = i?.pr;
  if (!i || !pr) return undefined;
  const sim = pr.simulated ? " (simulated)" : "";
  // ORC-012 review 1: while shaping, delivery says what it waits for, never "queued" or "preparing".
  const shaping = s.project.stage === "shaping" && !s.project.hold;
  const WAITS = "waits until you start building (shaping)";
  if (i.status !== "integrated") return { text: shaping ? `pull request ${pr.n + 1} ${WAITS}` : `preparing pull request ${pr.n + 1}`, tone: "plain" };
  const name = pr.number ? `PR #${pr.number}` : "PR";
  const plain = (what: string): PrLabel => ({ text: `${name} ${what}${sim}`, tone: "plain" });
  if (pr.phase === "merged") return { text: i.landed?.status === "unreviewed" ? `merged · review${sim}` : `merged${sim}`, tone: "done" };
  if (pr.phase === "closed") return { text: `${name} closed${sim}`, tone: "danger" };
  if (pr.op?.kind === "merge") return { text: `${name} merging${sim}`, tone: "strong" };
  // ORC-013 §7: a cancelled check being re-run, and a review bot's verdict, are named as such.
  const rerunning = pr.op?.kind === "rerun" ? rerunsUsed(pr).filter((u) => u.opId === pr.op!.id) : pr.observed?.checksFor === pr.headSha ? rerunsUsed(pr).filter((u) => pr.observed!.checks.some((c) => c.name === u.check && awaitingRerun(pr, c, nowMs))) : [];
  if (rerunning.length) return plain(`re-running ${[...new Set(rerunning.map((u) => u.check))].join(", ")}`);
  if (pr.attention) {
    const fixing = openRepair(s, pr);
    if (fixing || pr.pendingHead?.kind === "repair") return plain("being fixed");
    if (pr.attention.code === "bot-check") return { text: `${name} bot check · needs you${sim}`, tone: "danger" };
    return { text: `${name} needs you${sim}`, tone: "danger" };
  }
  if (pr.userHold) return plain("held by you");
  if (pr.phase === "built") return plain(!s.project.prDelivery.enabled ? "not opened: delivery is off" : s.project.hold ? "not opened: paused" : shaping ? `not opened: ${WAITS}` : openSlotsFull(s) ? `not opened: ${openSlotsFull(s)}` : "preparing");
  if (prReady(s, t, nowMs)) return { text: `${name} waiting for you${sim}`, tone: "strong" };
  const byUser = userGate(pr);
  const waits = prGate(s, t, nowMs, { byUser }).items.find((x) => !x.ok && x.id !== "policy");
  if (!waits) return pr.policy === "auto" && !byUser ? { text: `${name} merging next${sim}`, tone: "strong" } : pr.mergeRequested ? { text: `${name} merge requested${sim}`, tone: "strong" } : plain("open");
  switch (waits.id) {
    case "not-paused":
      return plain(pr.closeRequested ? "closing" : shaping && !pr.userHold ? WAITS : "paused");
    case "github":
      return plain("waiting for GitHub");
    case "ours":
      return plain("not seen on GitHub yet");
    case "head":
      return plain(pr.pendingHead?.kind === "update" ? "updating" : pr.pendingHead ? "fix being pushed" : "not seen on GitHub yet");
    case "checks":
      return plain("checks");
    case "mergeable":
      return plain(pr.observed?.mergeStateStatus === "BEHIND" ? "behind the base" : "waiting on GitHub");
    case "review":
      return plain("review");
    case "auto":
      return plain("auto-merge paused");
    case "up-to-date": {
      const ahead = queueAhead(s, t);
      return plain(ahead ? `queued behind #${ahead.integration!.pr!.number}` : "updating");
    }
    default:
      return plain(pr.mergeRequested ? "merge requested" : "waiting");
  }
}

/** What is in flight or wanted for this pull request, in plain words. Undefined when nothing is. */
export function prIntentLine(pr: PrDelivery): string | undefined {
  const n = prName(pr);
  if (pr.phase === "merged" || pr.phase === "closed") return undefined;
  if (pr.op?.kind === "merge") return `Merging ${n} (already sent to GitHub; cannot be interrupted). It shows as merged once GitHub reports it.`;
  if (pr.op?.kind === "close") return `Closing ${n} (already sent to GitHub). It shows as closed once GitHub reports it.`;
  if (pr.op?.kind === "push") return `Pushing ${pr.pendingHead ? sha12(pr.pendingHead.sha) : "a newer head"} onto ${n} as a fast-forward.`;
  if (pr.op?.kind === "rerun") {
    const mine = rerunsUsed(pr).filter((u) => u.opId === pr.op!.id);
    return `Asking GitHub to run ${mine.map((u) => u.check).join(", ") || "the cancelled job"} again on ${n} (GitHub had cancelled it). What GitHub reports afterwards decides; nothing is sent twice.`;
  }
  if (pr.op) return `Pushing ${pr.branch} and opening the pull request.`;
  if (pr.closeRequested) return `You asked to close ${n}; not sent yet.`;
  if (pr.mergeRequested) {
    const refused = pr.counters.mergeAttempts;
    return `You asked to merge ${sha12(pr.mergeRequested.headSha)}; it is sent once GitHub's checks and rules pass.${refused ? ` GitHub refused ${refused} of ${PR_LIMITS.mergeAttempts} attempts${pr.message ? ` (${pr.message})` : ""}; it is tried once more.` : pr.message ? ` The last attempt did not go through (${pr.message}); it is tried again.` : ""}`;
  }
  if (pr.pendingHead) return pr.pendingHead.kind === "update" ? `A newer head (${sha12(pr.pendingHead.sha)}), brought up to date with ${pr.base}, waits to be pushed.` : `A fix (${sha12(pr.pendingHead.sha)}) waits to be pushed onto ${n}.`;
  return undefined;
}
