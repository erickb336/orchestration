// Delivery of finished work and the review-later queue (ORC-008).
// Pure, like model.ts: every operation returns a new State and never mutates its input.
//
// The queue is informational. Nothing here is read to decide dispatch, integration or merging, and a
// landed item's `status` changes only through markLandedReviewed and sendBackLanded.

import * as M from "./model";
import { templateSteps } from "./templates";
import { ControlError, REVIEW_ROLES, type Landed, type ProviderId, type RoleId, type SpecContent, type State, type StepDef, type Task } from "./types";

// ---------- helpers ----------

function getTask(s: State, taskId: string): Task {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new ControlError(`Unknown task ${taskId}`);
  return t;
}

function event(s: State, now: string, actor: "user" | "system", kind: "integration" | "config", message: string, taskId?: string) {
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
  t.integration.landed = { at: now, ...entry, flags: entry.flags ?? [], status: "unreviewed", notes: [], followUps: [] };
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
 * Things that wait for the user: pull requests with an attention reason, flagged landed work that is
 * still unreviewed, a GitHub problem, and paused automatic merging.
 */
export function needsYou(s: State): number {
  let n = 0;
  for (const t of s.tasks) {
    const i = t.integration;
    if (i?.pr?.attention && i.pr.phase !== "merged" && i.pr.phase !== "closed") n++;
    if (i?.landed?.status === "unreviewed" && i.landed.flags.length) n++;
  }
  if (s.project.github?.problem) n++;
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
  if (note && l.notes.length < MAX_NOTES_PER_ITEM) {
    s.seq += 1;
    l.notes.push({ id: `note-${s.seq}`, at: now, text: note });
  }
  event(s, now, "user", "integration", `Sent back as a ${a.kind}: ${r.newId}${a.holdBeforeStart ? " (held before start)" : ""}`, origin.id);
  return { state: s, newId: r.newId };
}
