// Delivery of finished work and the review-later queue (ORC-008).
// Pure, like model.ts: every operation returns a new State and never mutates its input.
//
// The queue is informational. Nothing here is read to decide dispatch, integration or merging, and a
// landed item's `status` changes only through markLandedReviewed and sendBackLanded.

import * as M from "./model";
import { templateSteps } from "./templates";
import {
  ControlError,
  REVIEW_ROLES,
  type CheckObs,
  type GitHubStatus,
  type Landed,
  type LandedFlag,
  type PostureItem,
  type PrAttentionCode,
  type PrDelivery,
  type PrDeliveryConfig,
  type ProviderId,
  type RoleId,
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
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const REMOTE = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL = /^https:\/\/github\.com\//;

export function deliveryMode(s: State): DeliveryMode {
  if (s.project.prDelivery.enabled) return "pr";
  return s.project.autonomy.autoDeliver.enabled ? "local" : "off";
}

/** Done tasks whose work is on the integration branch but has not reached the delivery branch. */
export function undeliveredTasks(s: State): Task[] {
  return s.tasks.filter((t) => t.integration?.status === "integrated" && !t.integration.pr && t.integration.delivered?.status !== "delivered");
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
  t.integration.landed = { at: now, ...entry, ...(pr ? { pr } : {}), flags: entry.flags ?? [], status: "unreviewed", notes: [], followUps: [] };
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
    if (i?.pr && i.status === "integrated" && (i.pr.phase === "built" || i.pr.phase === "open") && (i.pr.attention || prReady(s, t, nowMs))) n++;
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
      out.push({
        stepId: st.id,
        purpose: st.purpose,
        role: st.role,
        artifactId: a.id,
        openFindings: a.openFindings ?? 0,
        summary: a.summary,
        provider: run?.snapshot.provider,
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
  if (postToGitHub && (landed.via !== "pr" || !landed.pr || landed.simulated)) throw new ControlError("Only work that landed through a real pull request can take a comment on GitHub.");
  s.seq += 1;
  landed.notes.push({ id: `note-${s.seq}`, at: now, text: body, ...(postToGitHub ? { comment: { status: "pending" as const, attempts: 0 } } : {}) });
  event(s, now, "user", "integration", `Note on landed work: ${clip(body, 160)}`, task.id);
  return s;
}

/** An unfinished revert of this landed commit, if one exists. */
export function openRevertOf(s: State, landed: Landed): Task | undefined {
  return s.tasks.find((x) => x.revertOf?.commit === landed.commit && x.lifecycle !== "done" && x.lifecycle !== "cancelled");
}

/** A project template's steps (the user may have edited it), else the built-in. */
function stepsOf(s: State, templateId: string): StepDef[] {
  const t = s.project.templates.find((x) => x.id === templateId);
  return t ? structuredClone(t.steps) : templateSteps(templateId);
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
  let fields: Partial<Task> | undefined;
  if (a.kind === "revert") {
    if (landed.simulated) throw new ControlError("This item is simulated: there is no commit to revert.");
    const open = openRevertOf(state, landed);
    if (open) throw new ControlError(`${open.id} is already reverting this change.`);
    steps = stepsOf(state, "revert");
    // The first writer is the one whose workspace holds the prepared revert: name the commit for it.
    const first = steps.find((x) => x.role === "coder");
    if (!first) throw new ControlError("The Revert template has no coder step to complete the revert.");
    first.purpose = `${first.purpose} (revert of ${c12})`;
    fields = { revertOf: { taskId: origin.id, commit: landed.commit } };
  } else steps = stepsOf(state, "bugfix");

  const r = M.createFollowUp(state, origin.id, now, { steps, holdBeforeStart: a.holdBeforeStart, author: "user", fields });
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
// Step 3 (independent review coverage, the dedicated review task, repair, automatic merge, base update
// and the main-red breaker) is not built: the seams are marked "step 3" below.
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
};

/** How long each operation may run (the driver's timeouts, summed over its network calls). */
export const OP_TIMEOUT_MS: Record<"publish" | "push" | "merge" | "close", number> = { publish: 240_000, push: 120_000, merge: 120_000, close: 120_000 };

const BACKOFF_MIN = [1, 2, 4, 8, 15];
const sanitizeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

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
}

export type OpErrorCode = "auth" | "not-found" | "head-mismatch" | "rejected" | "rate-limit" | "network" | "timeout" | "unknown" | "remote" | "diverged" | "foreign-commits";
export interface OpError {
  code: OpErrorCode;
  /** Redacted, at most 300 characters. */
  message: string;
  retryAt?: string;
}

/** One operation of the driver. "publish", "merge", "close" and "comment" write to GitHub. */
export type PrOp =
  | { id: string; kind: "preflight" }
  | { id: string; kind: "fetch" }
  | { id: string; kind: "observe"; prs: { taskId: string; number: number }[]; commits: string[] }
  | { id: string; kind: "publish" | "merge" | "close"; taskId: string; n: number; headSha: string }
  | { id: string; kind: "comment"; taskId: string; noteId: string };

export const opMutates = (op: PrOp) => op.kind === "publish" || op.kind === "merge" || op.kind === "close" || op.kind === "comment";

export interface PrOpResult {
  op: PrOp;
  /** The operation as a whole failed, or (merge, close) its outcome could not be observed. */
  error?: OpError;
  /** merge, close: what the gh command itself reported. It records nothing; the observation does. */
  actError?: OpError;
  preflight?: PreflightReport;
  base?: { sha: string };
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

/** Why coder steps that start from the base are not dispatched yet, if they are held. */
export function writersHeld(s: State): string | undefined {
  const cfg = s.project.prDelivery;
  return cfg.enabled && !s.project.github?.base ? `waiting for the first fetch of ${cfg.remote}/${cfg.base}` : undefined;
}

/** Integrated work that never reached a branch: it can be delivered as pull requests. */
export function redeliverable(s: State): Task[] {
  return s.tasks.filter((t) => {
    const i = t.integration;
    if (t.lifecycle !== "done" || !i || i.landed || i.status !== "integrated") return false;
    if (i.pr ? i.pr.phase !== "closed" : i.delivered?.status === "delivered") return false;
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

// ---------- the merge gate (design §9.5; items 9–12 belong to automatic merging, step 3) ----------

export interface GateItem {
  id: "policy" | "not-paused" | "github" | "ours" | "head" | "checks" | "mergeable" | "no-stop" | "attempts";
  label: string;
  ok: boolean;
  detail: string;
  state: "ok" | "waiting" | "blocked";
  /** The reason shown as "needs you" when this item blocks. */
  code?: PrAttentionCode;
}
export interface Gate {
  status: "ready" | "waiting" | "blocked";
  items: GateItem[];
}

const APPROVAL_TEXT =
  "GitHub requires an approval the app cannot give. This may be the ruleset's require_extra_approval_for_unattributed_changes applied to commits authored by Orchestration. Merge on GitHub, approve from another account, or change the ruleset.";

/** The names of the required checks for a pull request: from the repository's rules and from GitHub's own marking. */
export function requiredCheckNames(s: State, pr: PrDelivery): string[] {
  return [...new Set([...(s.project.github?.requiredChecks ?? []), ...(pr.observed?.checks.filter((c) => c.required).map((c) => c.name) ?? [])])];
}

/**
 * May this pull request be merged now? Evaluated for `pr.headSha`. `byUser`: the user's Merge click,
 * which replaces the agent review and never GitHub's checks or rules. Without it (automatic merging)
 * the gate is never ready in this version.
 */
export function prGate(s: State, task: Task, nowMs: number, o: { byUser: boolean }): Gate {
  const pr = livePr(task);
  if (!pr) return { status: "blocked", items: [] };
  const gh = s.project.github;
  const ob = pr.observed;
  const items: GateItem[] = [];
  const add = (id: GateItem["id"], label: string, state: GateItem["state"], detail: string, code?: PrAttentionCode) => items.push({ id, label, ok: state === "ok", detail, state, code });
  const headAge = pr.headSince ? nowMs - Date.parse(pr.headSince) : 0;
  const h12 = sha12(pr.headSha);

  // 1. Policy
  if (o.byUser) {
    if (pr.mergeRequested?.headSha === pr.headSha) add("policy", "Merge requested", "ok", `You asked to merge ${h12}.`);
    else add("policy", "You merge this pull request", "waiting", `Hold and notify: it merges when you choose Merge for ${h12}, or merge it on GitHub.`);
  } else add("policy", "Automatic merging", "blocked", "Automatic merging is not available in this version; pull requests are held for you.", "auto-unavailable");

  // 2. Not paused
  if (s.project.hold) add("not-paused", "Not paused", "waiting", "The project is paused: nothing is pushed, opened, merged or commented.");
  else if (pr.userHold) add("not-paused", "Not paused", "waiting", `You are holding this pull request${pr.userHold.reason ? `: ${pr.userHold.reason}` : ""}.`);
  else if (pr.closeRequested) add("not-paused", "Not paused", "waiting", "You asked to close this pull request.");
  else add("not-paused", "Not paused", "ok", "No pause or hold.");

  // 3. GitHub reachable
  if (!gh?.ok) add("github", "GitHub reachable", "waiting", gh?.problem ? gh.problem.message : "The repository has not been checked yet.");
  else if (!gh.checkedAt || nowMs - Date.parse(gh.checkedAt) > PR_LIMITS.preflightMaxAgeMs) add("github", "GitHub reachable", "waiting", "The repository check is more than 6 hours old; it is being repeated.");
  else add("github", "GitHub reachable", "ok", `${gh.repo ?? pr.repo}${gh.login ? ` as ${gh.login}` : ""}.`);

  // 4. It is our pull request
  if (pr.foreignHead) add("ours", "Only Orchestration's commits", "blocked", `Someone else pushed ${sha12(pr.foreignHead.sha)} to this branch. The app will not push to it or merge it again; merge it on GitHub, or close it and deliver again.`, "foreign-push");
  else if (!ob) add("ours", "Open on GitHub", "waiting", pr.phase === "built" ? "Not opened yet." : "Not seen on GitHub yet.");
  else if (ob.state !== "OPEN") add("ours", "Open on GitHub", "waiting", `GitHub reports it ${ob.state.toLowerCase()}.`);
  else if (ob.crossRepo) add("ours", "Open on GitHub", "blocked", "GitHub reports this pull request as coming from another repository; the app only acts on its own.", "foreign-push");
  else if (ob.isDraft) add("ours", "Open on GitHub", "blocked", "It was marked as a draft on GitHub. Mark it ready for review there.", "draft");
  else if (ob.baseRef !== pr.base) add("ours", "Open on GitHub", "blocked", `Its base was changed to ${ob.baseRef} on GitHub; the app opened it against ${pr.base}.`, "base-changed");
  else add("ours", "Open on GitHub", "ok", `Open against ${pr.base}.`);

  // 5. Head matches
  if (!ob) add("head", "The commit you saw", "waiting", "Not seen on GitHub yet.");
  else if (pr.pendingHead) add("head", "The commit you saw", "waiting", "A newer head is being pushed.");
  else if (ob.headSha !== pr.headSha) add("head", "The commit you saw", "blocked", `GitHub shows ${sha12(ob.headSha)}, not ${h12}.`, "foreign-push");
  else add("head", "The commit you saw", "ok", `GitHub shows ${h12}.`);

  // 6. Required checks, for exactly this head
  const names = requiredCheckNames(s, pr);
  let checksOk = false;
  if (!ob) add("checks", "Required checks", "waiting", "Not seen on GitHub yet.");
  else if (ob.checksFor !== pr.headSha) add("checks", "Required checks", "waiting", "The check results GitHub shows belong to another commit.");
  else if (names.length === 0)
    add("checks", "Required checks", "blocked", `GitHub lists no required check for ${pr.base}. The app merges only what a required check has passed; merge this one on GitHub, or add a required check.`, "checks-missing");
  else {
    const of = (n: string) => ob.checks.find((c) => c.name === n);
    const failed = names.filter((n) => {
      const c = of(n);
      return !!c && c.conclusion !== null && c.conclusion !== "SUCCESS";
    });
    const pending = names.filter((n) => !of(n) || of(n)!.conclusion === null);
    if (failed.length)
      add("checks", "Required checks", "blocked", failed.map((n) => `${n}: ${of(n)!.conclusion!.toLowerCase().replace(/_/g, " ")}${of(n)!.url ? ` (${of(n)!.url})` : ""}`).join("; "), "checks-failed");
    else if (pending.length) {
      const reported = names.some((n) => !!of(n));
      if (!reported && headAge > PR_LIMITS.checksMissingMs) add("checks", "Required checks", "blocked", `No required check (${names.join(", ")}) has reported for 15 minutes. It may not run for this branch.`, "checks-missing");
      else if (headAge > PR_LIMITS.checksPendingMs) add("checks", "Required checks", "blocked", `Still waiting for ${pending.join(", ")} after 60 minutes.`, "checks-timeout");
      else add("checks", "Required checks", "waiting", `Waiting for ${pending.join(", ")}.`);
    } else {
      checksOk = true;
      add("checks", "Required checks", "ok", `${names.join(", ")} passed on ${h12}.`);
    }
  }

  // 7. GitHub's own view
  if (!ob) add("mergeable", "GitHub says it can merge", "waiting", "Not seen on GitHub yet.");
  else if (ob.mergeable === "CONFLICTING" || ob.mergeStateStatus === "DIRTY") add("mergeable", "GitHub says it can merge", "blocked", `It conflicts with ${pr.base}. Resolve it on GitHub, or close it and deliver again.`, "conflict");
  else if (ob.mergeable !== "MERGEABLE" || ob.mergeStateStatus === "UNKNOWN") add("mergeable", "GitHub says it can merge", "waiting", "GitHub has not worked out yet whether it can merge.");
  else if (ob.mergeStateStatus === "CLEAN" || ob.mergeStateStatus === "HAS_HOOKS") add("mergeable", "GitHub says it can merge", "ok", "Mergeable and clean.");
  else if (ob.mergeStateStatus === "UNSTABLE") {
    if (headAge > PR_LIMITS.nonRequiredMs) add("mergeable", "GitHub says it can merge", "blocked", "Checks that are not required are failing or still running after 30 minutes. Merge on GitHub if that is acceptable.", "non-required-failing");
    else add("mergeable", "GitHub says it can merge", "waiting", "Checks that are not required are failing or still running.");
  } else if (ob.mergeStateStatus === "BEHIND")
    add("mergeable", "GitHub says it can merge", "blocked", `GitHub requires it to be up to date with ${pr.base}. This version does not update pull requests; merge on GitHub, or close it and deliver again.`, "github-blocked");
  else if (ob.mergeStateStatus === "BLOCKED") {
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

  // 9–12: independent review, paths and workers, auto-merge availability, up to date (step 3; a user merge skips them).

  // 13. Attempts
  if (pr.counters.mergeAttempts >= PR_LIMITS.mergeAttempts)
    add("attempts", "Merge attempts", "blocked", `GitHub refused the merge ${pr.counters.mergeAttempts} times${pr.message ? `: ${pr.message}` : ""}. Merge on GitHub, or close it and deliver again.`, "merge-rejected");
  else add("attempts", "Merge attempts", "ok", pr.counters.mergeAttempts ? `${pr.counters.mergeAttempts} of ${PR_LIMITS.mergeAttempts} used.` : "None used.");

  const status = items.some((i) => i.state === "blocked") ? "blocked" : items.every((i) => i.ok) ? "ready" : "waiting";
  return { status, items };
}

/** Hold mode: everything except the user's own Merge click is satisfied. */
export function prReady(s: State, task: Task, nowMs: number): boolean {
  const pr = livePr(task);
  if (!pr || pr.phase !== "open" || pr.policy !== "hold" || pr.op) return false;
  return prGate(s, task, nowMs, { byUser: true }).items.every((i) => i.ok || i.id === "policy");
}

/** Reasons a head is never pushed: they end only when the delivery is closed (and delivered again). */
const STICKY: PrAttentionCode[] = ["remote-diverged", "foreign-commits"];
const stuck = (pr: PrDelivery) => !!pr.attention && STICKY.includes(pr.attention.code);

/** Set or clear `pr.attention` from the current facts. `since` moves only when the reason or the head changes. */
function refreshAttention(s: State, t: Task, now: string) {
  const pr = livePr(t);
  if (!pr) return;
  let next: { code: PrAttentionCode; message: string } | undefined;
  if (pr.phase === "merged" || pr.phase === "closed") next = undefined;
  else if (pr.foreignHead) next = { code: "foreign-push", message: `Someone else pushed ${sha12(pr.foreignHead.sha)} to ${pr.branch}. The app will not push to it or merge it again.` };
  else if (pr.attention && STICKY.includes(pr.attention.code)) next = pr.attention; // only closing or delivering again clears it
  else if (pr.phase === "built") {
    if (pr.changed.workflowHits.length && !pr.workflowPushAllowed)
      next = { code: "workflow-change", message: `It changes CI workflow files (${pr.changed.workflowHits.slice(0, 5).join(", ")}), so it is not pushed until you allow it.` };
  } else {
    const blocking = prGate(s, t, Date.parse(now), { byUser: pr.policy === "hold" }).items.find((i) => i.state === "blocked" && i.code);
    if (blocking) next = { code: blocking.code!, message: blocking.detail };
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
    ...(pr.review.ok ? [`Automated review by Orchestration (${pr.review.provider ? M.providerLabel(pr.review.provider) : "agent"}${pr.review.model ? ` · ${pr.review.model}` : ""}), not a human review: 0 open findings on ${sha12(pr.changeSha)}.`, ""] : []),
    "Opened by Orchestration using this GitHub account.",
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
  return [
    `Merged from Orchestration at the user's request, for head ${sha12(pr.headSha)}.`,
    checks.length ? `Required checks passed on that head: ${checks.join(", ")}.` : "",
    pr.review.ok ? `Automated review by Orchestration, not a human review: 0 open findings on ${sha12(pr.changeSha)}.` : "",
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
  const change = M.finalChange(state, t) ?? state.artifacts.filter((a) => a.taskId === t.id && a.kind === "code-change").pop();
  const author = change?.author === "user" ? "user" : (state.attempts.find((a) => a.id === change?.attemptId)?.snapshot.provider ?? "user");
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
    headSha: f.sha,
    baseSha: f.baseSha,
    changed: f.changed,
    // Automatic merging is step 3: every pull request is held for the user.
    policy: "hold",
    policySource: "project",
    phase: "built",
    review: { ok: false, source: "none", reason: "Independent review coverage is not evaluated in this version.", artifactIds: [] },
    reviewTaskIds: [],
    repairTaskIds: [],
    counters: { mergeAttempts: 0, baseUpdates: 0, repairs: 0, reviews: 0, failures: 0 },
  };
  const s = structuredClone(M.reportIntegration(state, taskId, { status: "integrated", sha: f.sha, ref: `${sha12(f.sha)} on ${branch}`, pr }, now));
  refreshAttention(s, getTask(s, taskId), now);
  return s;
}

// ---------- reports from the service ----------

function setProblem(s: State, code: NonNullable<GitHubStatus["problem"]>["code"], message: string, now: string, retryAt?: string) {
  const prev = s.project.github;
  const gh: GitHubStatus = prev ?? { ok: false, requiredChecks: [], autoMergeBlockers: [], posture: [] };
  const same = prev?.problem?.code === code;
  gh.ok = false;
  gh.problem = { code, message: clip(message, 300), since: same ? prev!.problem!.since : now, ...(retryAt ? { retryAt } : {}) };
  s.project.github = gh;
  if (!same) event(s, now, "system", "blocked", `GitHub delivery stopped: ${clip(message, 300)}`);
}

/** A failure that is about the connection, not about one pull request. */
function projectProblem(s: State, e: OpError, now: string) {
  const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
  if (e.code === "auth") setProblem(s, "auth", `GitHub sign-in needed (run \`gh auth login\` in a terminal). ${e.message}`, now);
  else if (e.code === "rate-limit") setProblem(s, "rate-limit", `GitHub's rate limit was reached; waiting. ${e.message}`, now, e.retryAt ?? at(5 * MIN));
  else if (e.code === "remote") setProblem(s, "remote", e.message, now, at(5 * MIN));
  else setProblem(s, "network", `GitHub could not be reached. ${e.message}`, now, at(MIN));
}

const isProjectError = (e: OpError) => e.code === "auth" || e.code === "rate-limit";

/** Posture the app knows without asking GitHub. */
function localPosture(s: State, ctx: ReportContext): PostureItem[] {
  const out: PostureItem[] = [
    {
      id: "not-verified",
      status: "unverified",
      label: "Pull-request delivery is not verified against GitHub",
      detail: "It has run only against a simulated GitHub in tests. Watch the first pull requests, and hold any you are unsure about.",
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
    posture: [...r.posture, ...(r.simulated ? [] : localPosture(s, ctx))],
  };
  delete gh.recheck;
  delete gh.problem;
  if (r.simulated) gh.simulated = true;
  else delete gh.simulated;
  // The fetched base belongs to the repository it was fetched from.
  if (repoChanged) delete gh.base;
  s.project.github = gh;
  if (!prev?.ok || repoChanged) event(s, now, "system", "config", `GitHub repository checked, read-only: ${r.repo ?? "unknown"}${r.login ? ` as ${r.login}` : ""}${r.simulated ? " (simulated)" : ""}`);
  return s;
}

/** The delivery base was fetched into the app's private ref. */
export function reportBaseFetched(state: State, sha: string, now: string): State {
  const gh = state.project.github;
  if (!gh) return state;
  const s = structuredClone(state);
  const first = !gh.base;
  s.project.github!.base = { sha, fetchedAt: now };
  if (first) event(s, now, "system", "integration", `Fetched ${s.project.prDelivery.remote}/${s.project.prDelivery.base} (${sha12(sha)}); new work starts from it`);
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
 * `ctx.opId` names the merge or close operation that asked for this observation.
 */
export function reportObservations(state: State, obs: Observations, now: string, ctx: { opId?: string; actError?: OpError; requested?: { taskId: string; number: number }[] } = {}): State {
  const s = structuredClone(state);
  const nowMs = Date.parse(now);
  const gh = s.project.github;
  const seen = new Set<string>();
  for (const o of obs.prs) {
    const t = s.tasks.find((x) => livePr(x)?.number === o.number && livePr(x)!.phase === "open");
    const pr = t && livePr(t);
    if (!t || !pr) continue;
    seen.add(t.id);
    const wasReady = prReady(s, t, nowMs);
    pr.observed = {
      at: now,
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
      const byApp = pr.op?.kind === "merge" && pr.op.headSha === o.headSha;
      const names = requiredCheckNames(s, pr);
      const required = o.checks.filter((c) => names.includes(c.name));
      const clean = o.headSha === pr.headSha && !pr.foreignHead && o.checksFor === o.headSha && names.length > 0 && names.every((n) => required.find((c) => c.name === n)?.conclusion === "SUCCESS");
      const flags: LandedFlag[] = [...(clean ? [] : (["merged-without-clean-gate"] as const)), ...(pr.changed.protectedHits.length ? (["protected-paths"] as const) : [])];
      pr.phase = "merged";
      settle();
      event(s, now, "system", "integration", `${prName(pr)} merged into ${pr.base} by ${byApp ? "Orchestration, at your request" : (o.mergedBy ?? "a person")}${pr.simulated ? " (simulated)" : ""}`, t.id);
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
          pr: { number: o.number, url: pr.url ?? safePrUrl(pr, o.number, o.url) },
          review: structuredClone(pr.review),
          checks: required.map((c) => ({ ...c })),
          mainCheck: { state: "pending", at: now },
          flags,
        },
        now,
      );
      // Step 3: cancel open review and repair tasks of this pull request here.
      continue;
    }
    if (o.state === "CLOSED") {
      const asked = !!pr.closeRequested;
      pr.phase = "closed";
      settle();
      event(s, now, "system", asked ? "integration" : "blocked", asked ? `${prName(pr)} closed from Orchestration; the branch is kept` : `${prName(pr)} was closed on GitHub without merging${o.closedBy ? ` by ${o.closedBy}` : ""}`, t.id);
      continue;
    }
    // OPEN
    if (o.headSha === pr.headSha) pr.headSince ??= now;
    else if (!pr.foreignHead && o.headSha !== pr.pendingHead?.sha) {
      // Sticky: the app never pushes to or merges this pull request again.
      pr.foreignHead = { sha: o.headSha, at: now };
      delete pr.mergeRequested;
    }
    if (pr.op && (pr.op.kind === "merge" || pr.op.kind === "close")) {
      const own = ctx.opId === pr.op.id;
      const graceOver = nowMs - Date.parse(pr.op.at) >= OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs;
      if ((own && ctx.actError) || graceOver) {
        const what = pr.op.kind;
        pr.message = clip(ctx.actError?.message ?? `The ${what} did not happen: GitHub still shows the pull request open.`, 300);
        if (what === "merge") {
          pr.counters.mergeAttempts += 1;
          if (ctx.actError?.code === "head-mismatch") delete pr.mergeRequested;
        }
        delete pr.op;
        backoff(pr, now);
        event(s, now, "system", "blocked", `${prName(pr)}: the ${what} was not carried out${ctx.actError ? ` (${clip(ctx.actError.message, 200)})` : ""}; GitHub still shows it open`, t.id);
      }
    }
    refreshAttention(s, t, now);
    if (!wasReady && prReady(s, t, nowMs)) {
      const msg = `${prName(pr)} is ready for you: required checks passed on ${sha12(pr.headSha)}`;
      if (!s.events.some((e) => e.taskId === t.id && e.message === msg)) event(s, now, "system", "integration", msg, t.id);
    }
  }
  // An interrupted merge or close whose pull request GitHub did not return: never wait on it forever.
  for (const r of ctx.requested ?? []) {
    const t = s.tasks.find((x) => x.id === r.taskId);
    const pr = t && livePr(t);
    if (!t || !pr?.op || seen.has(t.id) || (pr.op.kind !== "merge" && pr.op.kind !== "close")) continue;
    if (nowMs - Date.parse(pr.op.at) < OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs) continue;
    pr.message = "GitHub did not return this pull request; the interrupted operation was dropped.";
    delete pr.op;
    backoff(pr, now);
  }

  // The check on the base branch after a merge (informational here; the pause and breaker are step 3).
  for (const t of s.tasks) {
    const l = t.integration?.landed;
    if (!l || l.via !== "pr" || l.mainCheck?.state !== "pending") continue;
    const c = obs.commits.find((x) => x.oid === l.commit);
    const stateNow = c ? mainCheckState(gh?.requiredChecks ?? [], c.checks) : "pending";
    if (stateNow === "pending") {
      if (nowMs - Date.parse(l.at) > PR_LIMITS.mainCheckMs) l.mainCheck = { state: "unknown", at: now };
      continue;
    }
    const url = c?.checks.find((x) => x.conclusion !== null && x.conclusion !== "SUCCESS")?.url;
    l.mainCheck = { state: stateNow, at: now, ...(stateNow === "failure" && url && GITHUB_URL.test(url) ? { url } : {}) };
    if (stateNow === "failure") {
      if (!l.flags.includes("main-check-failed")) l.flags.push("main-check-failed");
      event(s, now, "system", "blocked", `The check on ${l.target} failed after ${l.pr ? `PR #${l.pr.number}` : "this change"} landed`, t.id);
    }
  }

  if (gh) {
    gh.observedAt = now;
    if (obs.rateRemaining !== undefined) gh.rateRemaining = obs.rateRemaining;
    if (obs.rateRemaining === 0) setProblem(s, "rate-limit", "GitHub's rate limit was reached; waiting until it resets.", now, obs.rateResetAt ?? new Date(nowMs + 15 * MIN).toISOString());
  }
  return s;
}

// ---------- the planner ----------

function mutationsThisHour(gh: GitHubStatus | undefined, nowMs: number): number {
  const hour = new Date(nowMs).toISOString().slice(0, 13);
  return gh?.mutations?.hour === hour ? gh.mutations.count : 0;
}

/** Does anything need a fresh base now: a writer about to start, a head to build, or a merge just seen? */
function needsBase(s: State): boolean {
  const fetchedAt = s.project.github?.base?.fetchedAt ?? "";
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
  const open = tracked.filter((t) => t.integration!.pr!.phase === "open" && t.integration!.pr!.number !== undefined);
  const mainChecks = s.tasks.filter((t) => t.integration?.landed?.via === "pr" && t.integration.landed.mainCheck?.state === "pending");
  // Nothing is watched once pull-request delivery is off and no pull request or main check is tracked.
  if (!cfg.enabled && open.length === 0 && mainChecks.length === 0) return undefined;
  const id = `prop-${s.seq + 1}`;
  const age = (iso?: string) => (iso ? nowMs - Date.parse(iso) : Number.POSITIVE_INFINITY);

  // 1. A known problem: wait for its retry time, then only the read-only check, backing off 5 → 30 min.
  if (gh?.problem) {
    if (gh.recheck) return { id, kind: "preflight" };
    if (gh.problem.retryAt) return Date.parse(gh.problem.retryAt) > nowMs ? undefined : { id, kind: "preflight" };
    const wait = Math.min(30 * MIN, Math.max(5 * MIN, Date.parse(gh.checkedAt ?? gh.problem.since) - Date.parse(gh.problem.since)));
    return age(gh.checkedAt) >= wait ? { id, kind: "preflight" } : undefined;
  }
  // 2. The read-only repository check.
  if (!gh || gh.recheck || !gh.checkedAt || age(gh.checkedAt) > PR_LIMITS.preflightMaxAgeMs) return { id, kind: "preflight" };
  if (!gh.ok) return undefined;

  const observe = (): PrOp => ({
    id,
    kind: "observe",
    prs: open.slice(0, PR_LIMITS.observeBatch).map((t) => ({ taskId: t.id, number: t.integration!.pr!.number! })),
    commits: mainChecks.slice(0, PR_LIMITS.observeBatch).map((t) => t.integration!.landed!.commit),
  });
  const canWrite = !p.hold && cfg.enabled && age(gh.lastMutationAt) >= PR_LIMITS.mutationGapMs && mutationsThisHour(gh, nowMs) < PR_LIMITS.mutationsPerHour;
  const rested = (pr: PrDelivery) => !pr.nextAt || Date.parse(pr.nextAt) <= nowMs;

  // 3. Interrupted intents: reconcile before anything is tried again, and only after the grace time.
  for (const t of tracked) {
    const pr = t.integration!.pr!;
    if (!pr.op || age(pr.op.at) < OP_TIMEOUT_MS[pr.op.kind] + PR_LIMITS.graceMs) continue;
    if ((pr.op.kind === "merge" || pr.op.kind === "close") && pr.number !== undefined) return observe();
    // publish, push, or a close that never had a number: the operation itself checks the remote first.
    const kind = pr.op.kind === "close" || pr.closeRequested ? "close" : "publish";
    if (kind === "close" ? canWrite : canWrite && !pr.userHold && !pr.foreignHead && !stuck(pr)) return { id, kind, taskId: t.id, n: pr.n, headSha: pr.headSha };
  }

  // 4. The delivery base.
  if (cfg.enabled) {
    const fetched = age(gh.base?.fetchedAt);
    if (!gh.base || (fetched >= MIN && needsBase(s)) || fetched >= 10 * MIN) return { id, kind: "fetch" };
  }

  // 5. Observe: one batched read.
  if (open.length || mainChecks.length) {
    const urgent = open.some((t) => t.integration!.pr!.mergeRequested || t.integration!.pr!.op);
    const interval = p.hold || (gh.rateRemaining ?? 5000) < 300 ? 5 * MIN : urgent ? 30_000 : open.length ? 2 * MIN : MIN;
    if (age(gh.observedAt) >= interval) return observe();
  }

  // 6. Writes.
  if (!canWrite) return undefined;
  // 6.1 The user's merge, bound to the head they saw. (Step 3 adds the automatic merge candidate here.)
  for (const t of open) {
    const pr = t.integration!.pr!;
    if (!pr.mergeRequested || pr.op || pr.userHold || pr.foreignHead || pr.closeRequested || !rested(pr)) continue;
    if (prGate(s, t, nowMs, { byUser: true }).status !== "ready") continue;
    // Merge freshness: GitHub is looked at again right before the merge.
    if (age(pr.observed?.at) > PR_LIMITS.observeFreshMs) return observe();
    return { id, kind: "merge", taskId: t.id, n: pr.n, headSha: pr.headSha };
  }
  // 6.2 push a pending head, 6.3 update the merge candidate to the base: step 3.
  // 6.4 Publish the oldest built head.
  const openCount = tracked.filter((t) => t.integration!.pr!.phase === "open").length;
  for (const t of tracked) {
    const pr = t.integration!.pr!;
    if (pr.phase !== "built" || pr.op || pr.userHold || pr.foreignHead || pr.closeRequested || !rested(pr)) continue;
    if (stuck(pr) || !publishAllowed(pr)) continue;
    if (openCount >= cfg.maxOpenPrs) break;
    return { id, kind: "publish", taskId: t.id, n: pr.n, headSha: pr.headSha };
  }
  // 6.5 A note the user chose to post.
  const c = pendingComment(s, nowMs);
  if (c) return { id, kind: "comment", taskId: c.task.id, noteId: c.noteId };
  // 6.6 Close.
  for (const t of tracked) {
    const pr = t.integration!.pr!;
    if (pr.closeRequested && !pr.op && rested(pr)) return { id, kind: "close", taskId: t.id, n: pr.n, headSha: pr.headSha };
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
  } else if (op.kind === "publish" || op.kind === "merge" || op.kind === "close") {
    const pr = livePr(t);
    if (!pr || pr.n !== op.n || pr.headSha !== op.headSha) return no;
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
      } else {
        if (pr.phase !== "open" || pr.number === undefined || pr.mergeRequested?.headSha !== pr.headSha) return no;
        if (!pr.observed || nowMs - Date.parse(pr.observed.at) > PR_LIMITS.observeFreshMs) return no;
        if (prGate(s, t, nowMs, { byUser: true }).status !== "ready") return no;
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
  if (op.kind === "fetch") return r.base ? reportBaseFetched(state, r.base.sha, now) : fail(r.error ?? unknown);
  if (op.kind === "observe") return r.observed ? reportObservations(state, r.observed, now, { requested: op.prs }) : fail(r.error ?? unknown);

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

  // publish, merge, close: the stale-result guard.
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
  if (op.kind === "publish") {
    delete pr.op;
    if (r.published) {
      pr.phase = "open";
      pr.number = r.published.number;
      pr.url = safePrUrl(pr, r.published.number, r.published.url);
      pr.counters.failures = 0;
      delete pr.nextAt;
      delete pr.message;
      event(s, now, "system", "integration", `Opened pull request #${pr.number} for ${pr.branch} into ${pr.base}${pr.simulated ? " (simulated)" : ""}; it is held for you`, t.id);
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
    else backoff(pr, now);
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
  // Step 3 builds the independent review and the automatic gate; until then nothing merges by itself.
  if (next.merge === "auto") throw new ControlError("Automatic merging is not available in this version yet. Pull requests are held for you to merge.");
  if (next.reviewer !== "other-provider" && next.reviewer !== "any-agent") throw new ControlError("Choose which reviewer counts as independent.");
  if (next.protectedPaths.length > 20 || next.protectedPaths.some((x) => x.length > 200)) throw new ControlError("At most 20 protected paths of at most 200 characters each.");
  if (!int(next.maxOpenPrs, 1, 20)) throw new ControlError("Open pull requests: between 1 and 20.");
  if (!int(next.maxAutoMergesPerDay, 0, 100)) throw new ControlError("Automatic merges per day: between 0 and 100.");
  for (const k of ["updateBeforeMerge", "autoRepair", "allowLocalWorkers"] as const) if (typeof next[k] !== "boolean") throw new ControlError(`${k} must be true or false.`);
  if (JSON.stringify(next) === JSON.stringify(cur)) return state;
  const s = structuredClone(state);
  s.project.prDelivery = next;
  if (next.remote !== cur.remote || next.base !== cur.base) {
    // Another remote or base: check it again, and fetch it before any writer starts from it.
    const gh = s.project.github;
    if (gh) {
      gh.recheck = true;
      delete gh.base;
    }
  }
  event(s, now, "user", "config", `Pull-request settings: ${next.remote}/${next.base}, hold and notify, at most ${next.maxOpenPrs} open`);
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
  event(s, now, "user", "integration", `${prName(pr)} released`, task.id);
  return s;
}

/** Per pull request: follow the project (null), hold, or (step 3) auto. */
export function setPrPolicy(state: State, taskId: string, policy: "hold" | "auto" | null, now: string): State {
  if (policy === "auto") throw new ControlError("Automatic merging is not available in this version yet. Pull requests are held for you to merge.");
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "change");
  const source = policy === null ? "project" : "user";
  if (pr.policy === "hold" && pr.policySource === source) return state;
  pr.policy = "hold";
  pr.policySource = source;
  event(s, now, "user", "integration", `${prName(pr)}: hold and notify${policy === null ? " (follows the project)" : ""}`, task.id);
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
  if (pr.mergeRequested?.headSha === headSha) return state;
  pr.mergeRequested = { at: now, headSha };
  delete pr.nextAt;
  event(s, now, "user", "integration", `Merge requested for ${prName(pr)} at ${sha12(headSha)}; it merges once GitHub's checks and rules pass for that commit`, task.id);
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
  if (pr.phase === "built" && !pr.op && pr.counters.failures === 0 && pr.number === undefined) {
    // Nothing was ever sent to GitHub for this head.
    pr.phase = "closed";
    delete pr.attention;
    event(s, now, "user", "integration", `Delivery of ${pr.branch} abandoned before anything was pushed`, task.id);
    return s;
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
  if (!state.project.prDelivery.enabled) throw new ControlError("Switch the delivery mode to GitHub pull requests first.");
  const s = structuredClone(state);
  const ok = new Set(redeliverable(s).map((t) => t.id));
  for (const id of new Set(taskIds)) {
    const t = getTask(s, id);
    if (!ok.has(id)) throw new ControlError(`${id} cannot be delivered again: it must be done, have a code change, not have landed, and have no open pull request.`);
    const prev = t.integration!.pr;
    // The closed pull request stays on the record only so the next one takes the next number.
    t.integration = { status: "pending", ...(prev ? { pr: prev } : {}) };
    event(s, now, "user", "integration", prev ? `Deliver again: a new pull request (${prBranch(s.project.id, t.id, prev.n + 1)}) will be prepared` : "Deliver as a pull request", t.id);
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

/** One short, truthful label for a task's delivery. */
export function prLabel(s: State, t: Task, nowMs: number): PrLabel | undefined {
  const i = t.integration;
  const pr = i?.pr;
  if (!i || !pr) return undefined;
  const sim = pr.simulated ? " (simulated)" : "";
  if (i.status !== "integrated") return { text: `preparing pull request ${pr.n + 1}`, tone: "plain" };
  const name = pr.number ? `PR #${pr.number}` : "PR";
  if (pr.phase === "merged") return { text: i.landed?.status === "unreviewed" ? `merged · review${sim}` : `merged${sim}`, tone: "done" };
  if (pr.phase === "closed") return { text: `${name} closed${sim}`, tone: "danger" };
  if (pr.op?.kind === "merge") return { text: `${name} merging${sim}`, tone: "strong" };
  if (pr.attention) return { text: `${name} needs you${sim}`, tone: "danger" };
  if (pr.userHold) return { text: `${name} held by you${sim}`, tone: "plain" };
  if (pr.phase === "built") return { text: `${name} preparing${sim}`, tone: "plain" };
  if (prReady(s, t, nowMs)) return { text: `${name} waiting for you${sim}`, tone: "strong" };
  if (pr.mergeRequested) return { text: `${name} merge requested${sim}`, tone: "strong" };
  return { text: `${name} checks${sim}`, tone: "plain" };
}

/** What is in flight or wanted for this pull request, in plain words. Undefined when nothing is. */
export function prIntentLine(pr: PrDelivery): string | undefined {
  const n = prName(pr);
  if (pr.op?.kind === "merge") return `Merging ${n} (already sent to GitHub; cannot be interrupted). It shows as merged once GitHub reports it.`;
  if (pr.op?.kind === "close") return `Closing ${n} (already sent to GitHub). It shows as closed once GitHub reports it.`;
  if (pr.op) return `Pushing ${pr.branch} and opening the pull request.`;
  if (pr.closeRequested) return `You asked to close ${n}; not sent yet.`;
  if (pr.mergeRequested) return `You asked to merge ${sha12(pr.mergeRequested.headSha)}; it is sent once GitHub's checks and rules pass.`;
  return undefined;
}
