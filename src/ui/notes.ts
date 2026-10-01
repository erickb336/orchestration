// ORC-022: plain-text descriptions of notes to running stages, shared by the task page, the change list
// and notifications. Read-only derivations over domain state; the domain decides what a note's status is.

import * as M from "../domain/model";
import { isProvider, type Note, type State, type SteeringChange, type Task } from "../domain/types";
import { ROLE_LABEL, type Tone } from "./common";

/** The status chip: Queued, Sending, Delivered, Delivered at start, or Not delivered with the reason. */
export function noteStatusLabel(n: Pick<Note, "status" | "via" | "reason">): string {
  switch (n.status) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "delivered":
      return n.via === "start" ? "Delivered at start" : "Delivered";
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

/** Who sent it: "from the lead, for your message msg-3" or "from you". */
export function noteSourceLabel(n: Pick<Note, "from">): string {
  if (n.from.by === "user") return "from you";
  const ids = n.from.messageIds;
  return ids.length ? `from the lead, for your message${ids.length === 1 ? "" : "s"} ${ids.join(", ")}` : "from the lead";
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
