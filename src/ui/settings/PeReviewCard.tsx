// Settings › Quality › PE review of new work (ORC-029 pass 5, U3): on or off, what it holds, and what it costs. The
// checkbox edits the Quality section's draft; Save sends setPeReviewsNewWork, the owner's command. Turning it off
// releases the work the PE is still reviewing, so Save asks first when some waits.

import type { ConfirmOptions } from "../kit";
import { Checkbox } from "../kit";
import type { State } from "../../domain/types";
import type { SendResult } from "../store";
import { SettingsCard } from "./parts";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The work that waits for the PE now: a task's own review (a proposal, a change order's update), or a step's (a breakdown, a design). */
function waitingForPe(s: State): string[] {
  return s.tasks.filter((t) => t.lifecycle !== "done" && t.lifecycle !== "cancelled").flatMap((t) => [...(t.peReview?.status === "pending" ? [t.id] : []), ...t.steps.filter((st) => st.peReview?.status === "pending").map((st) => `${t.id} ${st.id}`)]);
}

export interface PeReviewWords {
  holds: string;
  costs: string;
  /** This project's own figures: its PE runs on new work so far, and their recorded cost. */
  sofar: string;
  /** What waits for the PE now, if anything. */
  now?: string;
}

export function peReviewWords(s: State): PeReviewWords {
  const runs = s.studio.runs.filter((r) => r.kind === "pe" && r.review);
  const costed = runs.filter((r) => r.usage?.costUsd !== undefined);
  const unknown = runs.length - costed.length;
  const waiting = waitingForPe(s);
  return {
    holds: "While it is on, new work waits for the PE before it starts: the lead's proposals and its change order updates, a Goal's breakdown and a Feature's design. Code changes keep the code and security reviews.",
    costs: "Each piece of new work gets one to three PE runs, counted in the building budget, and it starts later. After three rounds the PE's objection goes to you.",
    sofar: runs.length
      ? `This project so far: ${count(runs.length, "PE run")} on new work, ${usd(costed.reduce((a, r) => a + (r.usage!.costUsd ?? 0), 0))} recorded${unknown ? `; ${count(unknown, "run")} with no recorded cost` : ""}.`
      : "This project has no PE run on new work yet, so there is no figure for it.",
    ...(waiting.length ? { now: `Waiting for the PE now: ${waiting.join(", ")}.` } : {}),
  };
}

/** Before Save turns it off: the work the PE is reviewing starts without its review. Undefined when nothing waits. */
export function peReviewOffConfirm(s: State): ConfirmOptions | undefined {
  const waiting = waitingForPe(s);
  if (!waiting.length) return undefined;
  return {
    title: "Turn PE review of new work off?",
    text: `${waiting.join(", ")} ${waiting.length === 1 ? "waits" : "wait"} for the PE now. ${waiting.length === 1 ? "It starts" : "They start"} without its review. An objection that already reached you stays with you.`,
    primaryLabel: "Turn it off",
  };
}

/** The owner's command that saves the checkbox, after asking when turning it off releases work; null when you said no. */
export async function peReviewSteps(s: State, on: boolean, changed: boolean, send: (name: "setPeReviewsNewWork", args: object) => Promise<SendResult>, confirm: (o: ConfirmOptions) => Promise<boolean>): Promise<(() => Promise<SendResult> | null)[] | null> {
  if (!changed) return [];
  const ask = on ? undefined : peReviewOffConfirm(s);
  if (ask && !(await confirm(ask))) return null;
  return [() => send("setPeReviewsNewWork", { on })];
}

export function PeReviewCard({ on, set, state }: { on: boolean; set: (on: boolean) => void; state: State }) {
  const w = peReviewWords(state);
  return (
    <SettingsCard id="pe-review" title="PE review of new work" help={w.holds}>
      <Checkbox label="The PE reviews new work before it starts" hint={w.costs} checked={on} onChange={(e) => set(e.target.checked)} />
      <p className="s-note">
        {w.sofar}
        {w.now ? ` ${w.now}` : ""}
      </p>
    </SettingsCard>
  );
}
