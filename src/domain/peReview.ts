// PE review of new work in the factory (ORC-029: the hooks in 2e, switched on in pass 5).
//
// What is reviewed. While the project has PE review of new work on (`peReviewsNewWork`, the owner's setting, on for a
// new project), new work made while building waits for the PE before it starts:
// - the lead's proposals, and the follow-ups it takes out of findings (the review is on the task);
// - a Goal's breakdown, before its child tasks exist (on the step that made it; the children carry no review of their
//   own, since the PE agreed to them as a whole);
// - a design that a coder step builds, which is the Feature flow's design step (on that step).
// Code changes are never PE-reviewed: they keep the code and security reviews. A task the owner writes, the roadmap
// planned in Vision and delivery tasks carry no review of their own (their design or breakdown still has one).
//
// The loop has the verdict shape of the studio's (pass 4e). The service asks for a PE run on each piece of work that
// waits (askForNewWorkReviews). The PE answers feasible, feasible-if with a change, or not feasible. Feasible
// releases the work. A change sends it back: the lead revises a proposal (its next run lists it, and answers with
// "revises"), and the step that made a breakdown or a design runs again with the change in its brief. The PE then
// reviews the revision and checks its earlier asks first. After three rounds, or when the lead leaves a proposal as
// it is, the work goes to the owner (Needs you) with the objection: the owner overrules it (recorded), edits the work
// (a new review starts), or cancels it. Nothing is dropped. Open cases are product questions: they go to the owner
// through the lead's brief and never send work back.
//
// Who writes it. Only the service records a verdict (`recordPeReview`, a service command a client cannot send). Only
// the owner overrules (`overrulePeReview`) and turns the setting on or off. Nothing in the lead's output reaches them.

import { acceptedOutput } from "./model/artifacts";
import { currentSpec, draft, event, getStep, getTask, isOpen } from "./model/core";
import { applyBreakdown } from "./model/fanout";
import { rerunInto } from "./model/retries";
import { activeStudioRuns, requestStudioRun, requestStudioStop } from "./studio/runs";
import { checkVerdict, endedWithoutResult, MAX_PE_RUNS, type VerdictInput } from "./studio/studio";
import { isUnderWay, type ChangeOrder, type NewWorkReviewRef, type StudioRun } from "./studio/types";
import { ControlError, StaleWriteError, type OutputDef, type PeReviewRound, type PeReviewState, type ProviderId, type State, type Step, type StepDef, type Task } from "./types";

/** Rounds of PE review before a change the PE still asks for goes to the owner. */
export const MAX_PE_REVIEW_ROUNDS = 3;

/** Why pending work is held. */
export const PE_REVIEW_HOLD = "waiting for PE review";
/** Why work the PE still objects to is held. */
export const PE_OBJECTS_HOLD = "the PE objects; waiting for you";
/** Why work whose review the service could not finish is held. */
export const PE_UNFINISHED_HOLD = "PE review could not finish; waiting for you";

/** The review new work starts with: pending while the project is building with PE review of new work on, none otherwise. */
export function newWorkReview(s: State): PeReviewState | undefined {
  return s.project.stage === "building" && s.project.peReviewsNewWork ? { status: "pending", rounds: [] } : undefined;
}

/**
 * Why PE review keeps this work from starting, or undefined: it waits for the PE; or for the owner, on an objection or
 * on a review the service could not finish, until the owner overrules it. A review the owner ended (PE review of new
 * work turned off) holds nothing.
 */
export function peReviewHold(r: PeReviewState | undefined): string | undefined {
  if (!r) return undefined;
  if (r.status === "pending") return PE_REVIEW_HOLD;
  if (r.overruled) return undefined;
  if (r.status === "objected") return PE_OBJECTS_HOLD;
  if (r.status === "ended" && r.ended?.by === "service") return PE_UNFINISHED_HOLD;
  return undefined;
}

/**
 * PE review of this work is not settled: the PE is reviewing it, or it waits for the owner. Only the owner cancels such
 * work; the lead may only suggest it (steering). A PE objection is never dropped.
 */
export const peReviewStands = (r: PeReviewState | undefined): boolean => peReviewHold(r) !== undefined;

/** Why the lead may not cancel this work, or undefined (see `peReviewStands`). */
export function peReviewKeeps(r: PeReviewState | undefined): string | undefined {
  const hold = peReviewHold(r);
  if (!hold) return undefined;
  if (hold === PE_REVIEW_HOLD) return "the PE is reviewing it; only you cancel it";
  if (hold === PE_UNFINISHED_HOLD) return "its PE review could not finish; only you start it or cancel it";
  return "the PE objects to it; only you overrule the objection or cancel it";
}

/**
 * The work a verdict or an overrule is about: a task (a lead proposal), a step of a task (the breakdown or the design
 * it made), or a change order's updates.
 */
export type PeReviewTarget = { taskId: string; stepId?: string } | { changeOrder: number };

/** What the owner reads of the objection: the newest round that sent the work back (its reasons and its change), or why review ended. */
export function lastObjection(r: PeReviewState): string {
  if (r.status === "ended" && r.ended) return r.ended.why;
  const last = [...r.rounds].reverse().find((x) => x.verdict !== "feasible");
  if (!last) return "";
  return last.change ? `${last.reasons} The change it asks for: ${last.change}` : last.reasons;
}

// ---------- the outputs a step makes that the PE reviews ----------

/**
 * The outputs of a step that are new work for the PE: a breakdown (its items become tasks), and a design that a coder
 * step of the same task builds (the Feature flow's design step; a design-only flow's designs are not built).
 */
export function reviewedOutputs(t: Task, st: StepDef): OutputDef[] {
  return st.outputs.filter((o) => o.kind === "breakdown" || (o.kind === "design" && t.steps.some((d) => d.role === "coder" && d.inputs.some((i) => i.step === st.id && i.output === o.name))));
}

/** The version of the step's reviewed output the PE reads now: the accepted one (a person's edit included). */
export function reviewedVersion(s: State, t: Task, st: Step): number | undefined {
  const o = reviewedOutputs(t, st)[0];
  return o ? acceptedOutput(s, t, st.id, o.name)?.version : undefined;
}

/** "the design", "the breakdown": what a step's review is about, in words. */
export function reviewedWhat(t: Task, st: StepDef): string {
  return reviewedOutputs(t, st).some((o) => o.kind === "breakdown") ? "breakdown" : "design";
}

/**
 * A step just completed (on a draft, in reportCompletion): does what it made wait for PE review? A breakdown with
 * items or a design a coder builds does, when the project has PE review of new work on, or when the step is in its
 * review loop (it ran again for the PE's change: the PE reviews the revision, and the rounds go on). A step that runs
 * again after its review settled starts a new review, and the earlier one stays on the record. A breakdown with no
 * items is no new work. Returns true when it waits: then its children are created, and the steps after it start,
 * only once the PE agrees (or the owner overrules).
 */
export function stepReviewInto(s: State, t: Task, st: Step, now: string): boolean {
  const outs = reviewedOutputs(t, st);
  if (!outs.length) return false;
  const arts = outs.map((o) => acceptedOutput(s, t, st.id, o.name)).filter((a) => !!a);
  if (!arts.some((a) => a.kind === "design" || (a.items?.length ?? 0) > 0)) return false;
  const r = st.peReview;
  if (r?.status === "pending") return true;
  const fresh = newWorkReview(s);
  if (!fresh) return false;
  st.peReview = r ? { ...fresh, earlier: [...(r.earlier ?? []), { rounds: r.rounds, closedAt: now, version: reviewedVersion(s, t, st) }] } : fresh;
  event(s, now, "system", "decision", `${st.id}'s ${reviewedWhat(t, st)} waits for PE review before ${reviewedWhat(t, st) === "breakdown" ? "its child tasks are created" : "it is built"}`, t.id);
  return true;
}

/** The PE agreed, or the owner overruled: a held breakdown becomes child tasks now, or when the task resumes if it is paused. Mutates the draft. */
function releaseStepInto(s: State, t: Task, st: Step, now: string) {
  for (const o of st.outputs.filter((x) => x.kind === "breakdown")) {
    if (!t.hold) applyBreakdown(s, t, st.id, o.name, now);
    else if (!(t.pendingBreakdowns ?? []).some((x) => x.stepId === st.id && x.output === o.name)) t.pendingBreakdowns = [...(t.pendingBreakdowns ?? []), { stepId: st.id, output: o.name }];
  }
}

/** Every review on a task: its own (a proposal), then its steps' (a breakdown, a design). */
export function reviewsOf(t: Task): { step?: Step; review: PeReviewState }[] {
  return [...(t.peReview ? [{ review: t.peReview }] : []), ...t.steps.filter((st) => st.peReview).map((st) => ({ step: st, review: st.peReview! }))];
}

/** The review that holds this task up now, if any: its own, or a step's whose steps after it would start next. */
export function taskReviewHold(t: Task): { step?: Step; review: PeReviewState; hold: string } | undefined {
  for (const x of reviewsOf(t)) {
    const hold = peReviewHold(x.review);
    if (hold) return { ...x, hold };
  }
  return undefined;
}

// ---------- recording a verdict ----------

function located(s: State, target: PeReviewTarget): { name: string; review: PeReviewState | undefined; task?: Task; step?: Step; order?: ChangeOrder } {
  if ("taskId" in target) {
    const task = getTask(s, target.taskId);
    if (target.stepId === undefined) return { name: task.id, review: task.peReview, task };
    const step = getStep(task, target.stepId);
    return { name: `${task.id} ${step.id}'s ${reviewedWhat(task, step)}`, review: step.peReview, task, step };
  }
  const order = s.blueprint.changeOrders.find((c) => c.rev === target.changeOrder);
  if (!order) throw new ControlError(`There is no change order for blueprint r${target.changeOrder}.`);
  return { name: `the updates for change order r${order.rev}`, review: order.peReview, order };
}

/** One PE verdict on new work, as its run gave it: the verdict (pass 4e), and what it read. */
export interface PeReviewInput extends Omit<VerdictInput, "variant"> {
  target: PeReviewTarget;
  /** A proposal: the spec revision the PE read. */
  specRev?: number;
  /** A breakdown or a design: the version of the step's output the PE read. */
  version?: number;
  by?: PeReviewRound["by"];
}

/** The changes the PE asked for in this review so far, which its next round checks first: "r1", "r2", by round. */
export function earlierAsksOf(r: PeReviewState): { id: string; round: PeReviewRound }[] {
  return r.rounds.map((round, i) => ({ id: `r${i + 1}`, round })).filter((x) => x.round.verdict !== "feasible");
}

/**
 * Record one PE verdict on pending work (the service, from the PE's review run). It names what the PE read
 * (compare-and-set): the spec revision of a proposal, the output version of a breakdown or a design; a verdict on one
 * that has since changed is refused. Feasible releases the work. Feasible-if or not feasible sends it back for
 * revision: the lead revises a proposal, and the step that made a breakdown or a design runs again. The third such
 * verdict sends it to the owner.
 */
export function recordPeReview(state: State, input: PeReviewInput, now: string): State {
  const found = located(state, input.target);
  const r = found.review;
  if (!r) throw new ControlError(`${found.name} is not PE-reviewed: only new work is (the lead's proposals, a Goal's breakdown, a Feature's design), while PE review of new work is on. Code changes keep the code and security reviews.`);
  if (r.status !== "pending") throw new ControlError(`PE review of ${found.name} is finished (${r.status}).`);
  if (found.task) {
    if (!isOpen(found.task)) throw new ControlError(`${found.task.id} is ${found.task.lifecycle}.`);
    if (found.step) {
      const v = reviewedVersion(state, found.task, found.step);
      if (found.step.state !== "done" || v === undefined) throw new ControlError(`${found.step.id} is running again; the PE reviews what it makes next.`);
      if (input.version === undefined) throw new ControlError(`A verdict on ${found.name} names the version the PE read.`);
      if (input.version !== v) throw new StaleWriteError(input.version, v);
    } else {
      const rev = currentSpec(found.task).rev;
      if (input.specRev === undefined) throw new ControlError(`A verdict on ${found.task.id} names the spec revision the PE read.`);
      if (input.specRev !== rev) throw new StaleWriteError(input.specRev, rev);
    }
  }
  const round = r.rounds.length + 1;
  if (round > MAX_PE_REVIEW_ROUNDS) throw new ControlError(`PE review of ${found.name} had its ${MAX_PE_REVIEW_ROUNDS} rounds.`);
  const checked = checkVerdict(input, { pass: round, asks: earlierAsksOf(r), on: found.name });
  const s = draft(state);
  const mine = located(s, input.target);
  const review = mine.review!;
  review.rounds.push({
    at: now,
    ...checked,
    ...(mine.step ? { version: input.version } : mine.task ? { specRev: input.specRev } : {}),
    ...(input.by ? { by: { provider: input.by.provider, model: input.by.model, runId: input.by.runId } } : {}),
  });
  let outcome: string;
  if (checked.verdict === "feasible") {
    review.status = "agreed";
    if (mine.step) {
      releaseStepInto(s, mine.task!, mine.step, now);
      outcome = mine.step.outputs.some((o) => o.kind === "breakdown") ? "its child tasks are created" : "it is built next";
    } else outcome = mine.task ? (mine.task.holdBeforeStart ? "it waits for your go-ahead (your involvement setting)" : "it starts under your involvement setting") : "the lead may apply them";
  } else if (round >= MAX_PE_REVIEW_ROUNDS) {
    review.status = "objected";
    outcome = mine.order
      ? `it still asks for a change after ${MAX_PE_REVIEW_ROUNDS} rounds, so it needs you: until you overrule the objection, the updates are not applied`
      : `it still asks for a change after ${MAX_PE_REVIEW_ROUNDS} rounds, so it needs you: overrule the objection, edit the work (the PE reviews it again), or cancel it`;
  } else if (mine.step) {
    // The step that made it runs again, with the PE's change in its brief; the PE reviews what it makes next.
    rerunInto(s, mine.task!, mine.step, now, "system", `the PE asks for a change, round ${round} of ${MAX_PE_REVIEW_ROUNDS}`);
    outcome = `round ${round} of ${MAX_PE_REVIEW_ROUNDS}; ${mine.step.id} revises it`;
  } else outcome = `round ${round} of ${MAX_PE_REVIEW_ROUNDS}; the lead revises ${mine.order ? "them" : "it"}`;
  if (mine.task) mine.task.updatedAt = now;
  const word = checked.verdict === "feasible" ? "agreed" : checked.verdict === "feasible-if" ? "asks for a change" : "objects";
  const cases = checked.openCases?.length ?? 0;
  event(s, now, "runtime", "decision", `PE review of ${mine.name}: ${word} (${checked.reasons.split("\n")[0].slice(0, 200)}); ${outcome}${cases ? `; ${cases} question${cases === 1 ? "" : "s"} for you, through the lead` : ""}`, mine.task?.id);
  return s;
}

/**
 * The owner edited a task's spec (revision `specRev`). On work the PE objected to, or whose review could not finish,
 * and the owner has not overruled, the edit starts a new review of the changed work, with a fresh count of rounds: the
 * work waits for the PE again, and the earlier review stays on the record. Mutates the draft `s`. Only the owner's
 * edit does this: the lead's edit leaves the objection for the owner.
 */
export function reopenPeReviewInto(s: State, t: Task, specRev: number, now: string) {
  const r = t.peReview;
  if (!reopens(r)) return;
  t.peReview = { status: "pending", rounds: [], earlier: [...(r!.earlier ?? []), { rounds: r!.rounds, closedAt: now, specRev }] };
  event(s, now, "user", "decision", `Your edit (spec r${specRev}) starts a new PE review of the work the PE objected to; the objection stays on the record`, t.id);
}

/** The same for the owner's edit of a held breakdown or design (output version `version`). Mutates the draft `s`. */
export function reopenStepReviewInto(s: State, t: Task, st: Step, version: number, now: string) {
  const r = st.peReview;
  if (!reopens(r)) return;
  st.peReview = { status: "pending", rounds: [], earlier: [...(r!.earlier ?? []), { rounds: r!.rounds, closedAt: now, version }] };
  event(s, now, "user", "decision", `Your edit (${st.id} v${version}) starts a new PE review of the ${reviewedWhat(t, st)} the PE objected to; the objection stays on the record`, t.id);
}

const reopens = (r: PeReviewState | undefined) => !!r && !r.overruled && (r.status === "objected" || (r.status === "ended" && r.ended?.by === "service"));

/** The owner overrules the PE's standing objection, or starts work whose review could not finish, with the reason (recorded). */
export function overrulePeReview(state: State, target: PeReviewTarget, why: string, now: string): State {
  const found = located(state, target);
  const r = found.review;
  if (!r || !reopens(r)) {
    if (r?.overruled) throw new ControlError("You already overruled this objection.");
    throw new ControlError(r?.status === "pending" ? `PE review of ${found.name} is still going; it reaches you if the PE still asks for a change after ${MAX_PE_REVIEW_ROUNDS} rounds.` : `There is no PE objection to ${found.name} to overrule.`);
  }
  const reason = why.replace(/\r\n?/g, "\n").trim();
  if (!reason) throw new ControlError("Say why you overrule the objection.");
  if (reason.length > 1000) throw new ControlError("Your reason is over 1000 characters.");
  const s = draft(state);
  const mine = located(s, target);
  mine.review!.overruled = { at: now, why: reason };
  if (mine.step) releaseStepInto(s, mine.task!, mine.step, now);
  if (mine.task) mine.task.updatedAt = now;
  event(s, now, "user", "decision", `You overruled the PE's objection to ${mine.name}: ${reason}`, mine.task?.id);
  return s;
}

// ---------- the owner's setting ----------

/**
 * Turn PE review of new work on or off (the owner's). On: new work from now on waits for the PE. Off: nothing new
 * waits, and work the PE is still reviewing is released (its rounds stay on the record, and its PE runs are asked to
 * stop); an objection that already reached you stays with you.
 */
export function setPeReviewsNewWork(state: State, on: boolean, now: string): State {
  if (state.project.peReviewsNewWork === on) return state;
  const s = draft(state);
  s.project.peReviewsNewWork = on;
  const released: string[] = [];
  if (!on) {
    const end = (r: PeReviewState) => {
      r.status = "ended";
      r.ended = { at: now, why: "you turned PE review of new work off", by: "owner" };
    };
    for (const t of s.tasks) {
      if (!isOpen(t)) continue;
      if (t.peReview?.status === "pending") {
        end(t.peReview);
        released.push(t.id);
      }
      for (const st of t.steps) {
        if (st.peReview?.status !== "pending") continue;
        end(st.peReview);
        released.push(`${t.id} ${st.id}`);
        if (st.state === "done") releaseStepInto(s, t, st, now);
      }
    }
    for (const co of s.blueprint.changeOrders) if (co.peReview?.status === "pending") end(co.peReview);
    for (const r of activeStudioRuns(s)) if (r.review) requestStudioStop(s, r, "PE review of new work is off", now);
    for (const r of s.studio.runs) if (r.review && r.status === "queued") Object.assign(r, { status: "failed", endedAt: now, note: "not started: PE review of new work is off" });
  }
  event(
    s,
    now,
    "user",
    "config",
    on
      ? "PE review of new work: on. From now on, the lead's proposals, Goal breakdowns and Feature designs wait for the PE before they start."
      : `PE review of new work: off. New work starts without the PE${released.length ? `; released ${released.join(", ")}` : ""}. An objection that already reached you stays with you.`,
  );
  return s;
}

// ---------- the lead's revisions ----------

/** Proposals the PE sent back that wait for the lead's revision: the newest round asks for a change on the spec revision that is current. */
export function proposalsToRevise(s: State): Task[] {
  return s.tasks.filter((t) => {
    const r = t.peReview;
    if (r?.status !== "pending" || !isOpen(t)) return false;
    const last = r.rounds.at(-1);
    return !!last && last.verdict !== "feasible" && last.specRev === currentSpec(t).rev;
  });
}

/** Those no lead run has taken yet (none was shown them, or the one shown them ended without completing): they start a lead run. */
export function revisionsDueForLead(s: State): Task[] {
  return proposalsToRevise(s).filter((t) => {
    const shown = t.peReview!.rounds.at(-1)!.shownTo;
    return !shown || !s.leadRuns.some((r) => r.id === shown && (r.outcome === "running" || r.outcome === "stopping" || r.outcome === "completed"));
  });
}

/** A lead run starts: it is shown the proposals due for revision (its envelope lists them). Mutates the draft. */
export function showRevisionsInto(s: State, leadRunId: string) {
  for (const t of revisionsDueForLead(s)) t.peReview!.rounds.at(-1)!.shownTo = leadRunId;
}

/**
 * A lead run completed (on a draft, after its proposals were applied): the proposals it was shown and left as they
 * were go to the owner with the PE's objection. The lead may disagree with the PE; the owner decides. Returns their ids.
 */
export function unrevisedInto(s: State, leadRunId: string, now: string): string[] {
  const left = proposalsToRevise(s).filter((t) => t.peReview!.rounds.at(-1)!.shownTo === leadRunId);
  for (const t of left) {
    t.peReview!.status = "objected";
    t.updatedAt = now;
    event(s, now, "lead", "decision", `The lead left ${t.id} as it was, so the PE's objection goes to you: overrule it, edit the work (the PE reviews it again), or cancel it`, t.id);
  }
  return left.map((t) => t.id);
}

// ---------- the PE's runs on new work ----------

/** New work the PE should review now, with what it reads: a proposal's spec revision, or a step's output version. */
export function newWorkReviewsDue(s: State): NewWorkReviewRef[] {
  if (s.project.stage !== "building") return [];
  const due: NewWorkReviewRef[] = [];
  for (const t of s.tasks) {
    if (!isOpen(t) || t.hold) continue;
    if (t.peReview?.status === "pending") {
      const rev = currentSpec(t).rev;
      if (t.peReview.rounds.at(-1)?.specRev !== rev) due.push({ taskId: t.id, specRev: rev });
    }
    for (const st of t.steps) {
      if (st.peReview?.status !== "pending" || st.state !== "done") continue;
      const v = reviewedVersion(s, t, st);
      if (v !== undefined && st.peReview.rounds.at(-1)?.version !== v) due.push({ taskId: t.id, stepId: st.id, version: v });
    }
  }
  return due;
}

const sameRef = (a: NewWorkReviewRef, b: NewWorkReviewRef) => a.taskId === b.taskId && a.stepId === b.stepId && a.specRev === b.specRev && a.version === b.version;

/** The PE's runs on one piece of new work as it reads it now, oldest first. */
export function newWorkRunsOf(s: State, ref: NewWorkReviewRef): StudioRun[] {
  return s.studio.runs.filter((r) => r.kind === "pe" && r.review && sameRef(r.review, ref));
}

/** The PE's brief for new work: what the run record says it was asked to do (the envelope has the rest). */
export function newWorkBrief(s: State, ref: NewWorkReviewRef): string {
  const t = getTask(s, ref.taskId);
  const what = ref.stepId === undefined ? `the proposal ${t.id} (spec r${ref.specRev})` : `${t.id} ${ref.stepId}'s ${reviewedWhat(t, getStep(t, ref.stepId))} (v${ref.version})`;
  return `PE review of new work, ${what}: feasibility, scale, longevity and budget, against the blueprint; one verdict.`;
}

/** Review ended because the service could not run the PE: the work goes to the owner, never left waiting. Mutates the draft. */
function endByServiceInto(s: State, ref: NewWorkReviewRef, why: string, now: string) {
  const t = getTask(s, ref.taskId);
  const r = ref.stepId === undefined ? t.peReview : getStep(t, ref.stepId).peReview;
  if (r?.status !== "pending") return;
  r.status = "ended";
  r.ended = { at: now, why, by: "service" };
  t.updatedAt = now;
  event(s, now, "system", "decision", `PE review of ${ref.stepId === undefined ? t.id : `${t.id} ${ref.stepId}`} could not finish (${why}); it needs you: start it anyway (overrule), edit it, or cancel it`, t.id);
}

/**
 * Ask for a PE run on each piece of new work that waits for one (the service, on each cycle while building). The PE's
 * provider follows the task's override for the PE, then the project's PE default, then the other provider than the
 * one that made the work. When no enabled provider can run it, or its runs ended twice without a verdict, its review
 * ends and the work goes to the owner.
 */
export function askForNewWorkReviews(state: State, now: string): State {
  const due = newWorkReviewsDue(state);
  if (!due.length) return state;
  let s = state;
  for (const ref of due) {
    const runs = newWorkRunsOf(s, ref);
    if (runs.some(isUnderWay)) continue;
    if (endedWithoutResult(runs) >= MAX_PE_RUNS) {
      s = draft(s);
      endByServiceInto(s, ref, `the PE's runs on it ended ${MAX_PE_RUNS} times without a verdict`, now);
      continue;
    }
    try {
      s = requestStudioRun(s, { kind: "pe", review: ref, brief: newWorkBrief(s, ref), selection: newWorkPeSelection(s, ref) }, now).state;
    } catch (e) {
      if (!(e instanceof ControlError)) throw e;
      s = draft(s);
      endByServiceInto(s, ref, `the PE cannot run: ${e.message}`, now);
    }
  }
  return s;
}

/**
 * Who reviews new work as the PE: the task's own choice for the PE, then the project's PE default, then the other
 * provider than the one that made the work (the lead's for a proposal, the run's for a step's output), so the check is
 * independent; the maker's own when the other is not enabled.
 */
export function newWorkPeSelection(s: State, ref: NewWorkReviewRef): { provider: ProviderId; model: string } {
  const p = s.project;
  const t = getTask(s, ref.taskId);
  const chosen = t.roleOverrides.pe ?? p.roleDefaults.pe;
  if (chosen) return chosen;
  let maker: ProviderId | undefined = p.leadSelection.provider;
  if (ref.stepId !== undefined) {
    const st = getStep(t, ref.stepId);
    const o = reviewedOutputs(t, st)[0];
    const art = o && acceptedOutput(s, t, st.id, o.name);
    const run = art && s.attempts.find((a) => a.id === art.attemptId);
    maker = run && (run.snapshot.provider === "claude" || run.snapshot.provider === "codex") ? run.snapshot.provider : undefined;
  }
  const other = maker === "claude" ? "codex" : maker === "codex" ? "claude" : undefined;
  if (other && p.enabledProviders.includes(other)) return { provider: other, model: "auto" };
  return maker ? { provider: maker, model: "auto" } : p.defaultSelection;
}

/** Why a PE run on new work no longer fits, or undefined: the work is finished or cancelled, its review moved on, or it changed since. */
export function newWorkStaleReason(s: State, ref: NewWorkReviewRef): string | undefined {
  const t = s.tasks.find((x) => x.id === ref.taskId);
  if (!t || !isOpen(t)) return `${ref.taskId} is ${t ? t.lifecycle : "gone"}`;
  if (ref.stepId === undefined) {
    if (t.peReview?.status !== "pending") return `PE review of ${t.id} is ${t.peReview?.status ?? "off"}`;
    if (currentSpec(t).rev !== ref.specRev) return `${t.id}'s spec is r${currentSpec(t).rev} now, not r${ref.specRev}`;
    return undefined;
  }
  const st = t.steps.find((x) => x.id === ref.stepId);
  if (!st || st.peReview?.status !== "pending") return `PE review of ${t.id} ${ref.stepId} is ${st?.peReview?.status ?? "off"}`;
  const v = st.state === "done" ? reviewedVersion(s, t, st) : undefined;
  if (v !== ref.version) return `${t.id} ${st.id}'s output is ${v === undefined ? "being made again" : `v${v}`} now, not v${ref.version}`;
  return undefined;
}
