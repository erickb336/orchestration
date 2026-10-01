// ORC-025 pass 4 (T1, T2, T7): the task list's words, apart from React. Which group a task sits in ("Needs you"
// first), the short state on its card, the one plain line about what is happening, and a finished task's one result
// chip. Pure derivations over domain state; nothing here decides anything.

import * as C from "../domain/checks";
import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import type { Runner, State, Task } from "../domain/types";
import { COLUMN_LABEL } from "./common";
import type { Tone } from "./kit";
import { PR_PROBLEM, liveAgents, needsYouOf } from "./progress";
import { stepName } from "./task/stepWords";

// ---------- groups (T1) ----------

/** A group of the list and a column of the board: "Needs you" first, then the board's columns. */
export type Group = "needs-you" | M.Column;
export const GROUPS: Group[] = ["needs-you", ...M.BOARD_COLUMNS];
export const GROUP_LABEL: Record<Group, string> = { "needs-you": "Needs you", ...COLUMN_LABEL };

/** Where a task is listed: under Needs you when it waits for you, whatever its column; otherwise in its column. Each task in one place. */
export function groupOf(state: State, task: Task, nowMs = Date.now()): Group {
  if (task.lifecycle !== "cancelled" && needsYouOf(state, task, nowMs)) return "needs-you";
  return M.column(state, task);
}

// ---------- time ----------

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago": the same steps as relTime, in words. */
export function ago(iso: string, nowMs = Date.now()): string {
  const s = Math.round((nowMs - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.round(m / 60);
  if (h < 36) return unit(h, "hour");
  return unit(Math.round(h / 24), "day");
}

// ---------- the state on the card ----------

export interface CardState {
  label: string;
  tone: Tone;
  paused: boolean;
  pulse: boolean;
}

/**
 * A short state for the card's pill. What agents are doing right now comes first and stays truthful ("Pausing" until
 * the runtime acknowledges); a finished task is "Done" (T7); an open task that waits for you is "Needs you".
 * The detail is the card's line, so the pill stays one or two words.
 */
export function cardState(state: State, task: Task, nowMs = Date.now()): CardState {
  const s = (label: string, tone: Tone, extra: Partial<CardState> = {}): CardState => ({ label, tone, paused: false, pulse: false, ...extra });
  if (task.controlFailure) return s("Control failure", "fail");
  const active = M.activeAttempts(state, task.id);
  if (active.some((a) => a.outcome === "stopping")) return s(M.stopLabel(state, task), "work", { pulse: true });
  const col = M.column(state, task);
  if (col === "running" || col === "reviewing") return s(COLUMN_LABEL[col], "work", { pulse: true });
  if (col === "done") return s("Done", "done");
  if (col === "cancelled") return s("Cancelled", "neutral");
  if (needsYouOf(state, task, nowMs)) return s("Needs you", "you");
  if (col === "blocked") return s("Blocked", "fail");
  if (col === "paused") return s("Paused", "neutral", { paused: true });
  return s(COLUMN_LABEL[col], "neutral");
}

// ---------- the one line (T2) and the result chip (T7) ----------

/** A finished task's one result chip: it landed, or its pull request waits for you. */
export interface ResultChip {
  kind: "landed" | "pr";
  label: "Landed" | "Pull request waiting for you";
  simulated: boolean;
}

export interface CardLine {
  /** The words after the chip, if any: "Implementing · Codex · step 2 of 7", "2 days ago". Empty when the chip says it all. */
  text: string;
  tone: Tone;
  chip?: ResultChip;
  /** The agent working now, for the provider mark. */
  provider?: Runner;
}

/** The line as one string: the chip's label and the words ("Landed 2 days ago"). For titles and tests. */
export function lineText(line: CardLine): string {
  return [line.chip?.label, line.text].filter(Boolean).join(" ");
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What waits for you on an open task, as the card says it. */
const NEEDS_WORDS: Record<string, string> = {
  "decide a finding": "Waiting for your decision",
  "decide on failing checks": "Waiting for your decision on failing checks",
  "choose an option": "Waiting for you to choose an approach",
  "give the go-ahead": "Waiting for your go-ahead",
  "review the step": "Waiting for you to look at the last step",
};

/** "step 2 of 7" for a step of the task's pipeline. */
const stepOf = (task: Task, stepId: string) => {
  const i = task.steps.findIndex((st) => st.id === stepId);
  return i >= 0 ? `step ${i + 1} of ${task.steps.length}` : "";
};

/** The step a started task takes next, or the one it stopped at. */
function nextStep(task: Task) {
  return task.steps.find((st) => st.state === "pending" || st.state === "paused" || st.state === "blocked" || st.state === "running" || st.state === "stopping");
}

/** A blocked reason without the step id in front ("S2: Checks failed …" → "Checks failed …"). */
export function plainReason(reason: string): string {
  return reason.replace(/^[A-Z]+[0-9][\w.-]*:\s*/, "");
}

/** The pull request's own label (the board chip's words) as a line: "PR #1001 merging next" → "Pull request #1001: merging next". */
export const prWords = (text: string) => cap(text.replace(/^PR( #\d+)? /, "Pull request$1: "));

function doneLine(state: State, task: Task, nowMs: number): CardLine {
  const i = task.integration;
  const pr = i?.pr;
  const needs = needsYouOf(state, task, nowMs);
  if (i?.landed) {
    const l = i.landed;
    const chip: ResultChip = { kind: "landed", label: "Landed", simulated: !!l.simulated };
    const extra = needs ? " · flagged for you" : l.status === "sent-back" || l.followUps.length ? " · sent back" : "";
    return { text: `${ago(l.at, nowMs)}${extra}`, tone: needs ? "you" : "neutral", chip };
  }
  if (pr && needs) {
    const chip: ResultChip = { kind: "pr", label: "Pull request waiting for you", simulated: !!pr.simulated };
    return { text: needs.what === PR_PROBLEM ? "(stopped on a problem)" : "", tone: "you", chip };
  }
  if (i?.status === "conflict") return { text: "Integration conflict", tone: "fail" };
  if (pr) {
    const label = D.prLabel(state, task, nowMs);
    return { text: label ? prWords(label.text) : "Pull request", tone: "neutral" };
  }
  if (i?.status === "integrated") return { text: D.deliveredInto(task) ? `Pushed onto ${task.deliverInto!.taskId}'s pull request` : "On the integration branch", tone: "neutral" };
  if (i?.status === "pending") return { text: D.deliveryMode(state) === "pr" ? "Preparing the pull request" : "Waiting to be integrated", tone: "neutral" };
  return { text: "Finished: nothing to merge", tone: "neutral" };
}

/**
 * The one plain line a card shows about what is happening (T2): what a finished task delivered, what an open task
 * waits for you to do, what an agent is doing now ("Implementing · Codex · step 2 of 7"), or why nothing moves.
 * Never an event message, a run id or a model id.
 */
export function cardLine(state: State, task: Task, nowMs = Date.now()): CardLine {
  if (task.lifecycle === "cancelled") return { text: "", tone: "neutral" };
  if (task.lifecycle === "done") return doneLine(state, task, nowMs);
  if (task.controlFailure) return { text: "The stop was not confirmed: open the task to retry it", tone: "fail" };
  const needs = needsYouOf(state, task, nowMs);
  if (needs) return { text: NEEDS_WORDS[needs.what] ?? `Waiting for you to ${needs.what}`, tone: "you" };
  const agents = liveAgents(state, task);
  if (agents.length) {
    const a = agents[0];
    const who = a.provider === "claude" || a.provider === "codex" ? M.providerLabel(a.provider) : "";
    const parts = [cap(a.verb), who, stepOf(task, a.stepId), agents.length > 1 ? `+${agents.length - 1} more` : ""].filter(Boolean);
    return { text: parts.join(" · "), tone: "work", ...(who ? { provider: a.provider } : {}) };
  }
  const col = M.column(state, task);
  if (col === "blocked") {
    const why = M.blockedReason(state, task);
    return { text: why ? `Blocked: ${plainReason(why)}` : "Blocked", tone: "fail" };
  }
  const deferred = M.deferredBy(state, task);
  if (deferred) {
    if (deferred.task.id !== task.id) return { text: `Deferred with ${deferred.task.id}`, tone: "neutral" };
    const d = deferred.deferral;
    return { text: `${d.by === "lead" ? "The lead deferred it" : "You deferred it"}${d.reason ? `: ${d.reason}` : ""}`, tone: "neutral" };
  }
  const next = nextStep(task);
  const where = next ? `${stepOf(task, next.id)} · ${stepName(next)}` : "";
  if (col === "paused") {
    if (task.lifecycle !== "active") return { text: "Paused before it started", tone: "neutral" };
    return { text: [task.hold ? "Stopped at" : "Project paused at", where || "the next step"].join(" "), tone: "neutral" };
  }
  if (task.lifecycle === "active") {
    const children = M.waitingForChildren(state, task);
    if (children) {
      const open = M.currentChildren(state, task).filter((c) => c.lifecycle !== "done" && c.lifecycle !== "cancelled").length;
      return { text: open ? `Waiting for ${plural(open, "child task")}` : "Waiting for the child tasks' pull requests to merge", tone: "neutral" };
    }
    const awaiting = F.awaitingDecision(state, task);
    if (awaiting?.lead) return { text: `The lead is deciding ${plural(awaiting.lead, "finding")}`, tone: "neutral" };
    if (M.stateLabel(state, task) === C.HELD_LABEL) return { text: "Waiting for the checks sandbox (Settings → Checks)", tone: "neutral" };
    if (state.project.stage === "shaping") return { text: "Waits until you start building", tone: "neutral" };
    return { text: where ? `Up next: ${where}` : "Up next", tone: "neutral" };
  }
  const dep = M.waitingOn(state, task);
  if (dep) return { text: M.waitingDetail(state, dep) ?? `Waiting for ${dep}`, tone: "neutral" };
  if (task.heldForShaping) return { text: "Planned: starts after you start building", tone: "neutral" };
  return { text: `Not started · ${plural(task.steps.length, "step")}`, tone: "neutral" };
}
