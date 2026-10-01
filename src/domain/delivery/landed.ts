// The review-later queue: what landed on the target branch, marked as seen, annotated, or sent back.

import * as C from "../checks";
import * as F from "../findings";
import * as M from "../model";
import { internalFlow, flowHash, flowRef, serviceFlow } from "../flows";
import { clip } from "../text";
import { ControlError, REVIEW_ROLES, isProvider, type Landed, type FlowRef, type ProviderId, type RoleId, type SpecContent, type State, type StepDef, type Task } from "../types";
import { event, getLanded, getTask, GITHUB_URL, sha12 } from "./core";
import { prReady } from "./gate";
import { openPrTasks } from "./pr";
import { openRepair } from "./repair";

export const MAX_NOTE_CHARS = 4000;
export const MAX_NOTES_PER_ITEM = 200;

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
  // Flags: checks the user accepted failing, or no check evidence for the landed change while checks are on.
  const changeSha = t.integration.pr?.changeSha ?? M.finalChange(s, t)?.ref?.split(" ")[0];
  const flags = [...new Set([...(entry.flags ?? []), ...C.landedCheckFlags(s, t, changeSha)])];
  t.integration.landed = { at: now, ...entry, ...(pr ? { pr } : {}), flags, status: "unreviewed", notes: [], followUps: [] };
  event(s, now, "system", "integration", `Landed on ${entry.target} (${sha12(entry.commit)})${entry.simulated ? " (simulated)" : ""}; listed under Results, which never blocks anything`, t.id);
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

interface LandedReview {
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
        // Structured findings count what is still unresolved; accepted findings are not open.
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
    event(s, now, "user", "integration", reviewed ? "Marked as seen under Results" : "Marked as new under Results", task.id);
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
    // The revert pipeline is the service's own; no flow file can replace it.
    const revert = internalFlow("revert");
    steps = revert.steps;
    // The first writer is the one whose workspace holds the prepared revert: name the commit for it.
    const first = steps.find((x) => x.role === "coder");
    if (!first) throw new ControlError("The Revert pipeline has no coder step to complete the revert.");
    first.purpose = `${first.purpose} (revert of ${c12})`;
    // The hash is of the steps that run, purpose included, so it names exactly what ran.
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
  event(s, now, "user", "integration", `Sent back as a ${a.kind}: ${r.newId}${a.holdBeforeStart ? " (waits for your go-ahead)" : ""}`, origin.id);
  return { state: s, newId: r.newId };
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
