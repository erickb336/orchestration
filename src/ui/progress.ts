// ORC-017 §3.3: progress by area, derived from task state only. Nothing here is stored. Also the one
// place that says what a task is waiting on the user for (§3.2 "Needs you" badge, §3.4 list), so the
// board, the Overview and the progress rows agree.

import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { LiveAgent } from "../domain/areaProgress";
import type { Landed, Message, State, SteeringChangeSet, Task } from "../domain/types";

export { OTHER_AREA, areaOf, liveAgents, progressByArea, type AreaProgress, type Bucket, type LiveAgent, type RestKind } from "../domain/areaProgress";
export { PR_PROBLEM, mergeVerdict, needsYouItems, needsYouOf, optionsLine, type NeedsYou, type NeedsYouEntry, type VerdictMark } from "../domain/needsYou";

/** Tasks the service made for pull-request delivery are not the product's work: the domain's definition, so the board and the domain agree. */
export const serviceOwned = M.serviceOwned;

/** "Codex · implementing" (the task title follows it in the row). */
export function liveText(a: LiveAgent): string {
  return `${M.providerLabel(a.provider)} · ${a.verb}`;
}

/** How many agents work right now, for the header: agent runs only (the service's check runs are not agents). */
export function agentsWorking(state: State): number {
  // Agents only: the service's own check runs are not agents and have their own limit.
  return M.activeAgentAttempts(state).filter((a) => a.outcome === "running").length;
}

/** ORC-025: agent runs that were asked to stop and have not acknowledged yet. They are still busy, so the header never says Idle over them. */
export function agentsStopping(state: State): number {
  return M.activeAgentAttempts(state).filter((a) => a.outcome === "stopping").length;
}

/** The header's live text: "3 agents working", "3 agents working, 1 stopping", "2 agents stopping", or "Idle" only when no agent run is active. */
export function liveIndicatorText(working: number, stopping: number, shaping = false): string {
  const agents = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
  if (!working && !stopping) return "Idle";
  const text = working ? `${agents(working)} working${stopping ? `, ${stopping} stopping` : ""}` : `${agents(stopping)} stopping`;
  return shaping && working ? `${text} (finishing; shaping)` : text;
}

// ---------- ORC-025 pass 2: the badges (N7) ----------

/**
 * The pull requests that wait for you, as the Results page lists them under "Needs you": ready for your merge, or
 * stopped on a problem nobody is fixing. The Results badge counts these and nothing else.
 */
export function prsNeedingYou(state: State, nowMs = Date.now()): Task[] {
  return D.trackedPrTasks(state).filter((t) => {
    const pr = t.integration!.pr!;
    return (!!pr.attention && !D.openRepair(state, pr)) || D.prReady(state, t, nowMs);
  });
}

/** Lead replies newer than the last one this browser showed (`seenAt`, from PREF_LEAD_SEEN). The Lead badge counts these only. */
export function unreadLeadReplies(state: State, seenAt: string | null): number {
  return state.conversation.filter((m) => m.author === "lead" && (!seenAt || m.at > seenAt)).length;
}

// ---------- ORC-025 pass 2: "Latest from the lead" (N3) ----------

export interface LatestReply {
  message: Message;
  set?: SteeringChangeSet;
  applied: number;
  suggested: number;
  /** "2 changes, 1 suggestion" or "No changes". */
  summary: string;
}

/** "2 changes, 1 suggestion"; "No changes" when a reply changed nothing. */
export function changeSummary(applied: number, suggested: number): string {
  const parts: string[] = [];
  if (applied) parts.push(`${applied} change${applied === 1 ? "" : "s"}`);
  if (suggested) parts.push(`${suggested} suggestion${suggested === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "No changes";
}

/** The lead's newest reply and what it changed, or nothing when the lead has not replied yet. */
export function latestLeadReply(state: State): LatestReply | undefined {
  for (let i = state.conversation.length - 1; i >= 0; i--) {
    const message = state.conversation[i];
    if (message.author !== "lead") continue;
    const set = message.changeSetId ? state.steering.find((cs) => cs.id === message.changeSetId) : undefined;
    const applied = set?.changes.filter((c) => c.status === "applied").length ?? 0;
    const suggested = set?.changes.filter((c) => c.status === "suggested").length ?? 0;
    return { message, set, applied, suggested, summary: changeSummary(applied, suggested) };
  }
  return undefined;
}

/** The first lines of a reply: the first paragraph, cut at a word boundary with an ellipsis when it runs past `max` characters. */
export function replyExcerpt(text: string, max = 240): string {
  const first = text.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, "")}…`;
}

// ---------- ORC-025 pass 2: decisions taken in place on Home (H3) ----------

/** What a landed item passed, for its row: "Code ✓ Security ✓" from its review evidence, "Checks ✓" when every required check on the merged head succeeded. */
export function landedVerdict(landed: Landed): string[] {
  const out: string[] = [];
  if (landed.review?.ok) out.push("Code ✓", "Security ✓");
  const required = landed.checks?.filter((c) => c.required) ?? [];
  if (required.length && required.every((c) => c.conclusion === "SUCCESS")) out.push("Checks ✓");
  return out;
}
