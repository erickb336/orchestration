// ORC-009: plain-text descriptions of steering changes, shared by the change list and notifications.

import type { SteeringChange, SteeringChangeSet } from "../domain/types";

/** One line for a row: what it did or would do. */
export function describeChange(c: SteeringChange): string {
  switch (c.kind) {
    case "focus":
      return `Focus: "${String(c.after ?? "")}"`;
    case "priority":
      return `${c.taskId} P${String(c.before ?? "?")} → P${String(c.after ?? "?")}`;
    case "defer":
      return `${c.taskId} deferred (after its current step)`;
    case "undefer":
      return `${c.taskId} runs again (deferral lifted)`;
    case "drop":
      return `${c.taskId} dropped (had not started)`;
    default:
      return `${c.taskId ?? "An entry"} could not be read`;
  }
}

/** "Lead changed 4 things (1 suggestion)" or "Lead suggests 3 changes". */
export function setTitle(set: SteeringChangeSet): string {
  const applied = set.changes.filter((c) => c.status === "applied" || c.status === "undone").length;
  const suggested = set.changes.filter((c) => c.status === "suggested").length;
  if (set.refused) return "Lead tried to steer; nothing changed";
  if (applied) return `Lead changed ${applied} thing${applied === 1 ? "" : "s"}${suggested ? ` (${suggested} suggestion${suggested === 1 ? "" : "s"})` : ""}`;
  if (suggested) return `Lead suggests ${suggested} change${suggested === 1 ? "" : "s"}`;
  return "Lead steered; nothing was applied";
}
