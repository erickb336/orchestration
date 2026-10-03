// What a task needs from the person, each thing once, for the top of the task page.
// Pure derivations over domain state, so the page and its tests agree on what is shown.

import * as D from "../../domain/delivery";
import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import type { FindingDecision, State, Task } from "../../domain/types";
import { peHoldsOf, type PeHold } from "../settings/overrules";

export type NeedsYouItem =
  /** A pull request that waits for your merge, or stopped on a problem the app does not fix by itself. */
  | { kind: "pr"; ready: boolean; problem?: string }
  /** The final checks failed: add a fix round, or accept the failing checks. */
  | { kind: "final-checks"; stepId: string; reason: string; decision?: FindingDecision }
  /** Review findings routed to you. */
  | { kind: "decisions"; decisions: FindingDecision[] }
  /** A PE objection holds the work after its rounds, or its PE review could not finish: overrule it, edit or cancel. */
  | { kind: "pe"; holds: PeHold[] }
  /** The spec has several options and the task waits for your go-ahead: choose, then start. */
  | { kind: "choose"; optionIds: string[]; selected: string; recommended: string }
  /** The task waits for your go-ahead and there is nothing to choose. */
  | { kind: "go-ahead" };

export const isOpenTask = (t: Task) => t.lifecycle !== "done" && t.lifecycle !== "cancelled";

/** The final checks step(s) that failed and wait for a decision, with the open decision when there is one. */
export function failedFinalChecks(state: State, task: Task): { stepId: string; reason: string; decision?: FindingDecision }[] {
  return task.steps
    .filter((st) => st.role === "checks" && st.state === "blocked" && st.blockedReason?.startsWith("Checks failed"))
    .map((st) => ({
      stepId: st.id,
      reason: st.blockedReason!,
      decision: state.decisions.find((x) => x.kind === "final-checks" && x.taskId === task.id && x.status === "open" && state.artifacts.find((a) => a.id === x.artifactId)?.stepId === st.id),
    }));
}

/** Findings of this task the lead or the PE is deciding (shown as a note; the controls to take one over sit on the output). */
export function leadDecisions(state: State, task: Task): FindingDecision[] {
  return F.agentDecisions(state).filter((d) => d.taskId === task.id && d.kind === "finding");
}

/** The task waits for your go-ahead: held before start and not started (shaping, a deferral or a pause do not change that). */
export function waitsForGoAhead(task: Task): boolean {
  return isOpenTask(task) && task.holdBeforeStart && task.lifecycle !== "active";
}

/**
 * Everything the task needs from you, most pressing first: the pull request, failing final checks, findings
 * to decide, a PE objection, then the option choice or the go-ahead. Each appears once on the page, at the top.
 */
export function needsYouItems(state: State, task: Task, nowMs: number): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  const pr = D.livePr(task);
  if (pr && (pr.phase === "built" || pr.phase === "open")) {
    const ready = D.prReady(state, task, nowMs);
    const problem = pr.attention && !D.openRepair(state, pr) ? pr.attention.message : undefined;
    if (ready || problem) out.push({ kind: "pr", ready, ...(problem ? { problem } : {}) });
  }
  for (const f of failedFinalChecks(state, task)) out.push({ kind: "final-checks", ...f });
  const decisions = F.openDecisions(state, "user").filter((d) => d.taskId === task.id && d.kind === "finding");
  if (decisions.length) out.push({ kind: "decisions", decisions });
  // PE review comes before your go-ahead, as on Home: while an objection holds the work, there is nothing to start yet.
  const holds = peHoldsOf(task);
  if (holds.length) out.push({ kind: "pe", holds });
  else if (waitsForGoAhead(task)) {
    const c = M.currentSpec(task).content;
    if (c.options.length > 1) out.push({ kind: "choose", optionIds: c.options.map((o) => o.id), selected: c.selectedOptionId, recommended: c.recommendedOptionId });
    else out.push({ kind: "go-ahead" });
  }
  return out;
}

/** How many things need you, for the card's count. */
export function needsYouCount(items: NeedsYouItem[]): number {
  return items.reduce((n, i) => n + (i.kind === "decisions" ? i.decisions.length : i.kind === "pe" ? i.holds.length : 1), 0);
}
