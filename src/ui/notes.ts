// Plain-text descriptions of notes to running steps, shared by the task page, the change list and
// notifications. Read-only derivations over domain state; the domain decides what a note's status is. Also the
// lead conversation's words: the one line a reply's changes fold into, where a message of yours stands (and the
// Settings card that unblocks the lead), and a reply's decisions on findings, all without internal ids.

import * as M from "../domain/model";
import { isProvider, type FindingDecision, type Message, type Note, type State, type SteeringChange, type SteeringChangeSet, type Task } from "../domain/types";
import { ROLE_LABEL, fmtTime, type Tone } from "./common";
import { cardHref } from "./settings/sections";

/** The status chip: Queued, Sending, Delivered, Delivered when the run started, or Not delivered with the reason. */
export function noteStatusLabel(n: Pick<Note, "status" | "via" | "reason">): string {
  switch (n.status) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "delivered":
      return n.via === "start" ? "Delivered when the run started" : "Delivered";
    case "not-delivered":
      return `Not delivered: ${n.reason ?? "no reason recorded"}`;
  }
}

/** The chip's tone: agents working while it is on its way, done once delivered, failed when it was not. */
export function noteTone(n: Pick<Note, "status">): Tone {
  switch (n.status) {
    case "delivered":
      return "done";
    case "not-delivered":
      return "fail";
    case "sending":
      return "work";
    default:
      return "neutral";
  }
}

/**
 * Who sent it: "from you", or "from the lead, for your message of Oct 1, 2:05 PM" (the message's time, never its
 * id; "your 2 messages from …" names the first of several).
 */
export function noteSourceLabel(state: Pick<State, "conversation">, n: Pick<Note, "from">): string {
  if (n.from.by === "user") return "from you";
  const ids = n.from.messageIds;
  if (!ids.length) return "from the lead";
  const first = state.conversation.find((m) => m.id === ids[0]);
  if (ids.length === 1) return `from the lead, for your message${first ? ` of ${fmtTime(first.at)}` : ""}`;
  return `from the lead, for your ${ids.length} messages${first ? ` from ${fmtTime(first.at)}` : ""}`;
}

/** "WT-007 S2 (Coder · Claude)": the step a note or a note row is addressed to, with the role and the provider that runs (or would run) it. */
export function noteTargetLabel(state: State, taskId: string | undefined, stepId: string | undefined): string {
  const t = taskId ? state.tasks.find((x) => x.id === taskId) : undefined;
  const st = t && stepId ? t.steps.find((x) => x.id === stepId) : undefined;
  const where = `${taskId ?? "?"} ${stepId ?? "?"}`;
  if (!t || !st) return where;
  const run = M.activeAttempts(state, t.id).find((a) => a.stepId === st.id) ?? [...state.attempts].reverse().find((a) => a.taskId === t.id && a.stepId === st.id);
  const provider = run ? (isProvider(run.snapshot.provider) ? M.providerLabel(run.snapshot.provider) : "Service") : providerOf(state, t, st);
  return `${where} (${ROLE_LABEL[st.role]}${provider ? ` · ${provider}` : ""})`;
}

function providerOf(state: State, t: Task, st: Task["steps"][number]): string | undefined {
  if (st.role === "checks") return "Service";
  const r = M.resolveStep(state, t, st);
  return r.ok ? M.providerLabel(r.selection.provider) : undefined;
}

/** The change-list row: `Note to WT-007 S2 (Coder · Claude): "…"`. */
export function noteRowLabel(state: State, c: Pick<SteeringChange, "taskId" | "stepId" | "after">): string {
  return `Note to ${noteTargetLabel(state, c.taskId, c.stepId)}: "${String(c.after ?? "")}"`;
}

/** The runs a note can be sent to from the task page: running agent steps of an open task, never checks. */
export function canSendNote(state: State, task: Task, stepId: string): boolean {
  if (task.lifecycle === "done" || task.lifecycle === "cancelled") return false;
  const st = task.steps.find((x) => x.id === stepId);
  if (!st || st.role === "checks") return false;
  return M.activeAttempts(state, task.id).some((a) => a.stepId === stepId && a.outcome === "running");
}

// ---------- the lead conversation ----------

/** Rows of a reply's change set, by what became of them; the one place the fold line and the list count from. */
export interface ChangeGroups {
  /** Applied changes other than notes: the focus, priorities, deferrals, drops. */
  changes: SteeringChange[];
  /** Notes that were sent (applied). A sent note cannot be unsent. */
  notes: SteeringChange[];
  suggested: SteeringChange[];
  /** Skipped or rejected by the service: the lead described them, nothing happened. */
  notApplied: SteeringChange[];
  /** Undone by you, dismissed, or superseded by a later reply. */
  resolved: SteeringChange[];
}

export function changeGroups(set: Pick<SteeringChangeSet, "changes">): ChangeGroups {
  const applied = set.changes.filter((c) => c.status === "applied");
  return {
    changes: applied.filter((c) => c.kind !== "note"),
    notes: applied.filter((c) => c.kind === "note"),
    suggested: set.changes.filter((c) => c.status === "suggested"),
    notApplied: set.changes.filter((c) => c.status === "skipped" || c.status === "rejected"),
    resolved: set.changes.filter((c) => c.status === "undone" || c.status === "dismissed" || c.status === "superseded"),
  };
}

/**
 * Whether Undo is offered on an applied row. A drop the user applied is an ordinary cancel, with no undo. A sent
 * note cannot be unsent, so its row has no Undo and Undo all leaves it.
 */
export function undoable(c: SteeringChange): boolean {
  return c.status === "applied" && c.kind !== "note" && !(c.kind === "drop" && c.appliedBy === "user");
}

/** Whether Apply all takes a suggestion. A rerun with a note is applied only on its own row, because it asks first. */
export function bulkApplicable(c: SteeringChange): boolean {
  return c.status === "suggested" && !(c.kind === "note" && c.rerun);
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The fold line under a reply: "2 changes, 1 note", "2 suggestions", "1 change, 1 not applied", "3 undone or dismissed". */
export function foldSummary(set: Pick<SteeringChangeSet, "changes">): string {
  const g = changeGroups(set);
  const parts = [
    g.changes.length && count(g.changes.length, "change"),
    g.notes.length && count(g.notes.length, "note"),
    g.suggested.length && count(g.suggested.length, "suggestion"),
    g.notApplied.length && `${g.notApplied.length} not applied`,
    g.resolved.length && `${g.resolved.length} undone or dismissed`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "No changes";
}

/**
 * The actions the fold line carries, so the common case needs no opening: Undo (or Undo all) for what can be
 * undone, and Apply (Send for a note, Apply all for several) for the suggestions Apply all takes. A rerun with a
 * note is never among them: it asks first, on its own row.
 */
export function foldActions(set: Pick<SteeringChangeSet, "changes">): { undo?: "Undo" | "Undo all"; apply?: "Apply" | "Send" | "Apply all" } {
  const undo = set.changes.filter(undoable).length;
  const bulk = set.changes.filter(bulkApplicable);
  const apply = bulk.length > 1 ? "Apply all" : bulk.length === 1 ? (bulk[0].kind === "note" ? "Send" : "Apply") : undefined;
  return { ...(undo ? { undo: undo === 1 ? "Undo" : "Undo all" } : {}), ...(apply ? { apply } : {}) };
}

/**
 * Where a message of yours stands, in the conversation's words. A message sent while the lead writes a reply
 * waits for that reply and is answered next, by itself: there is nothing to press.
 */
export function messageStatusText(state: State, status: { kind: string; text: string }): string {
  if (status.kind !== "queued-behind-reply") return status.text;
  const run = M.activeLeadRun(state);
  return run && run.messageIds.length ? "The lead answers this right after its reply to your earlier message." : "The lead answers this when its current run ends.";
}

/**
 * Where in Settings a blocked lead is unblocked, read from the service's reason: a new project when this is the
 * sample, the repository when none is usable, the providers when the lead's is unavailable or still being checked,
 * and otherwise the lead's model (not enabled, or not in the catalog).
 */
export function leadBlockedLink(state: Pick<State, "project">, blocked: string): { href: string; label: string } {
  if (state.project.sample) return { href: cardHref("new-project"), label: "Start a new project in Settings › Project" };
  if (/repository/i.test(blocked)) return { href: cardHref("repository"), label: "Settings › Project › Repository" };
  if (/not available|provider/i.test(blocked)) return { href: cardHref("providers"), label: "Settings › Agents › Providers" };
  return { href: cardHref("models"), label: "Settings › Agents › Models" };
}

type DecisionRow = NonNullable<Message["leadDecisions"]>[number];

const DECIDED: Record<FindingDecision["status"], string> = {
  open: "still open",
  fix: "to be fixed",
  accept: "accepted as it is",
  "follow-up": "a follow-up task",
  superseded: "no longer open",
};

/**
 * One decision a lead reply took on a finding, by the task and the finding's title, never the decision's id:
 * `WT-007 “Distances are read in miles only”: accepted as it is — why`.
 */
export function leadDecisionText(row: DecisionRow, now: FindingDecision | undefined): string {
  const what = now ? `${row.taskId} “${now.finding.title}”` : `A finding on ${row.taskId}`;
  const verdict = row.what === "decided" ? (DECIDED[row.status as FindingDecision["status"]] ?? row.status) : row.what === "suggested" ? "the lead suggests a fix; yours to decide" : "handed to you to decide";
  const since = now && now.status !== row.status && now.status !== "open" ? ` (since then: ${DECIDED[now.status]})` : "";
  return `${what}: ${verdict}${since}${row.why ? ` — ${row.why}` : ""}`;
}
