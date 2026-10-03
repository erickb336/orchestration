// Overrules (ORC-029 pass 6), as pure functions: the work in the factory that a PE objection holds (or a PE review that
// could not finish), what the owner reads about each, the owner's command that overrules it (overrulePeReview), and
// the domain's refusal of a reason, in its words. Settings › Quality › Overrules and the task page's Needs you use them.

import { currentSpec } from "../../domain/model";
import { lastObjection, PE_OBJECTS_HOLD, PE_UNFINISHED_HOLD, peReviewHold, reviewedWhat, reviewsOf } from "../../domain/peReview";
import type { State, Task } from "../../domain/types";

/** One piece of work a PE objection holds, or whose PE review could not finish. */
export interface PeHold {
  taskId: string;
  /** The step whose breakdown or design the PE reviewed; none for the task's own spec. */
  stepId?: string;
  /** "T-005 Packing list: its spec", "T-007 Trip map: S1's design". */
  what: string;
  kind: "objects" | "unfinished";
  /** What the owner reads: the PE's objection, or why the review could not finish. */
  says: string;
  /** The button: overrule the objection, or start without the review. */
  button: string;
}

const isOpen = (t: Task) => t.lifecycle !== "done" && t.lifecycle !== "cancelled";

/** The holds on one task, the task's own review first. */
export function peHoldsOf(t: Task): PeHold[] {
  if (!isOpen(t)) return [];
  const title = `${t.id} ${currentSpec(t).content.title}`;
  return reviewsOf(t).flatMap(({ step, review }) => {
    const hold = peReviewHold(review);
    if (hold !== PE_OBJECTS_HOLD && hold !== PE_UNFINISHED_HOLD) return [];
    const objects = hold === PE_OBJECTS_HOLD;
    return [
      {
        taskId: t.id,
        ...(step ? { stepId: step.id } : {}),
        what: `${title}: ${step ? `${step.id}'s ${reviewedWhat(t, step)}` : "its spec"}`,
        kind: objects ? "objects" : "unfinished",
        says: objects ? `The PE objects after ${review.rounds.length} round${review.rounds.length === 1 ? "" : "s"}: "${lastObjection(review)}"` : `The PE review could not finish: ${lastObjection(review)}`,
        button: objects ? "Overrule the objection" : "Start without the PE's review",
      } satisfies PeHold,
    ];
  });
}

/** Every hold in the factory now, by task. */
export const peHolds = (s: State): PeHold[] => s.tasks.flatMap(peHoldsOf);

/** The domain's words for a reason it refuses (src/domain/peReview.ts), or undefined when it takes it. */
export function overruleProblem(why: string): string | undefined {
  const reason = why.replace(/\r\n?/g, "\n").trim();
  if (!reason) return "Say why you overrule the objection.";
  if (reason.length > 1000) return "Your reason is over 1000 characters.";
  return undefined;
}

/** The owner's command for one hold, with the reason. */
export const overruleRequest = (h: PeHold, why: string) => ({ name: "overrulePeReview" as const, args: { taskId: h.taskId, ...(h.stepId ? { stepId: h.stepId } : {}), why: why.trim() } });

/** What else the owner can do, in one line. */
export const OVERRULE_OTHERWISE = "You can also edit the work, which starts a new PE review, or cancel the task. Your reason is recorded.";
