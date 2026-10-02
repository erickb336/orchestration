// PE review of new work in the factory (ORC-029 2e): the domain hooks. The PE's review runs and the Feature flow's PE
// step come in pass 5.
//
// What is reviewed. While the project has PE review of new work on (`peReviewsNewWork`), every lead proposal and
// breakdown item made while building starts "pending", and so do the lead's updates for a change order. Pending work
// is held from dispatch, "waiting for PE review". An agreement releases it under the usual involvement rules (on
// Check-in it still waits for your go-ahead). An objection keeps it pending while the lead revises it; after three
// rounds it goes to the owner (Needs you) with the objection, and the owner may overrule it, recorded. Nothing is
// dropped: while its review is not settled, the lead never cancels the work (steering only suggests it, and a
// re-planned breakdown keeps it). Code changes are never PE-reviewed: a task you create, a delivery task and a repair
// never carry a review.
//
// Who writes it. Only the service records a verdict (`recordPeReview`, a service command a client cannot send); only
// the owner overrules (`overrulePeReview`). Nothing in the lead's output reaches either.

import { currentSpec, draft, event, getTask } from "./model/core";
import { CONTROL_RE, stripInvisible, visibleOrEmpty } from "./model/textSafety";
import type { ChangeOrder } from "./studio/types";
import { ControlError, StaleWriteError, type PeReviewState, type State, type Task } from "./types";

/** Rounds of PE review before an objection goes to the owner. */
export const MAX_PE_REVIEW_ROUNDS = 3;

/** Why pending work is held. */
export const PE_REVIEW_HOLD = "waiting for PE review";

/** The review new work starts with: pending while the project is building with PE review of new work on, none otherwise. */
export function newWorkReview(s: State): PeReviewState | undefined {
  return s.project.stage === "building" && s.project.peReviewsNewWork ? { status: "pending", rounds: [] } : undefined;
}

/** Why PE review keeps this work from starting, or undefined: it waits for the PE, or for the owner on an objection. */
export function peReviewHold(r: PeReviewState | undefined): string | undefined {
  if (r?.status === "pending") return PE_REVIEW_HOLD;
  if (r?.status === "objected" && !r.overruled) return "the PE objects; waiting for you";
  return undefined;
}

/**
 * PE review of this work is not settled: the PE is reviewing it, or objects and the owner has not overruled. Only the
 * owner cancels such work; the lead may only suggest it (steering), and a re-planned breakdown keeps it. A PE objection
 * is never dropped.
 */
export const peReviewStands = (r: PeReviewState | undefined): boolean => peReviewHold(r) !== undefined;

/** Why the lead may not cancel this work, or undefined (see `peReviewStands`). */
export function peReviewKeeps(r: PeReviewState | undefined): string | undefined {
  if (!peReviewStands(r)) return undefined;
  return r!.status === "pending" ? "the PE is reviewing it; only you cancel it" : "the PE objects to it; only you overrule the objection or cancel it";
}

/** The work a verdict or an overrule is about: a task (a lead proposal or a breakdown item), or a change order's updates. */
export type PeReviewTarget = { taskId: string } | { changeOrder: number };

/** The newest objection's reasons, for the owner. */
export const lastObjection = (r: PeReviewState) => [...r.rounds].reverse().find((x) => x.verdict === "object")?.reasons ?? "";

function located(s: State, target: PeReviewTarget): { name: string; review: PeReviewState | undefined; task?: Task; order?: ChangeOrder } {
  if ("taskId" in target) {
    const task = getTask(s, target.taskId);
    return { name: task.id, review: task.peReview, task };
  }
  const order = s.blueprint.changeOrders.find((c) => c.rev === target.changeOrder);
  if (!order) throw new ControlError(`There is no change order for blueprint r${target.changeOrder}.`);
  return { name: `the updates for change order r${order.rev}`, review: order.peReview, order };
}

const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
/** The PE's reasons: newlines kept, control and invisible characters removed. */
const agentText = (x: string) => visibleOrEmpty(stripInvisible(x.replace(CONTROL_G, "")).replace(/\r\n?/g, "\n").trim());

/**
 * Record one PE verdict on pending work (the service, from the PE's review run). A verdict on a task names the spec
 * revision the PE read (compare-and-set: a verdict on a revision the lead has since replaced is refused). "agree"
 * releases it; "object" keeps it pending for the lead's revision, and the third objection sends it to the owner.
 */
export function recordPeReview(state: State, input: { target: PeReviewTarget; verdict: "agree" | "object"; reasons: string; specRev?: number }, now: string): State {
  const found = located(state, input.target);
  const r = found.review;
  if (!r) throw new ControlError(`${found.name} is not PE-reviewed: only new work the lead plans is, while PE review of new work is on. Code changes keep the code and security reviews.`);
  if (r.status !== "pending") throw new ControlError(`PE review of ${found.name} is finished (${r.status}).`);
  if (found.task) {
    if (found.task.lifecycle === "cancelled" || found.task.lifecycle === "done") throw new ControlError(`${found.task.id} is ${found.task.lifecycle}.`);
    const rev = currentSpec(found.task).rev;
    if (input.specRev === undefined) throw new ControlError(`A verdict on ${found.task.id} names the spec revision the PE read.`);
    if (input.specRev !== rev) throw new StaleWriteError(input.specRev, rev);
  }
  const reasons = agentText(input.reasons);
  if (!reasons) throw new ControlError("A verdict states its reasons.");
  if (reasons.length > 2000) throw new ControlError("The verdict's reasons are over 2000 characters.");
  const s = draft(state);
  const mine = located(s, input.target);
  const review = mine.review!;
  review.rounds.push({ at: now, verdict: input.verdict, reasons, ...(mine.task ? { specRev: input.specRev } : {}) });
  const round = review.rounds.length;
  let outcome: string;
  if (input.verdict === "agree") {
    review.status = "agreed";
    outcome = mine.task ? (mine.task.holdBeforeStart ? "it waits for your go-ahead (your involvement setting)" : "it starts under your involvement setting") : "the lead may apply them";
  } else if (round >= MAX_PE_REVIEW_ROUNDS) {
    review.status = "objected";
    outcome = `it still objects after ${MAX_PE_REVIEW_ROUNDS} rounds, so it needs you: overrule the objection, or change or cancel the work`;
  } else outcome = `round ${round} of ${MAX_PE_REVIEW_ROUNDS}; the lead revises it`;
  if (mine.task) mine.task.updatedAt = now;
  event(s, now, "runtime", "decision", `PE review of ${mine.name}: ${input.verdict === "agree" ? "agreed" : "objects"} (${reasons.split("\n")[0].slice(0, 200)}); ${outcome}`, mine.task?.id);
  return s;
}

/** The owner overrules the PE's standing objection, with the reason (recorded): the work is released under the usual rules. */
export function overrulePeReview(state: State, target: PeReviewTarget, why: string, now: string): State {
  const found = located(state, target);
  const r = found.review;
  if (r?.status !== "objected") throw new ControlError(r?.status === "pending" ? `PE review of ${found.name} is still going; it reaches you if the PE still objects after ${MAX_PE_REVIEW_ROUNDS} rounds.` : `There is no PE objection to ${found.name} to overrule.`);
  if (r.overruled) throw new ControlError("You already overruled this objection.");
  const reason = why.replace(/\r\n?/g, "\n").trim();
  if (!reason) throw new ControlError("Say why you overrule the objection.");
  if (reason.length > 1000) throw new ControlError("Your reason is over 1000 characters.");
  const s = draft(state);
  const mine = located(s, target);
  mine.review!.overruled = { at: now, why: reason };
  if (mine.task) mine.task.updatedAt = now;
  event(s, now, "user", "decision", `You overruled the PE's objection to ${mine.name}: ${reason}`, mine.task?.id);
  return s;
}
