// What happens to the lead's change sets afterwards: undo an applied row, apply or dismiss a suggestion,
// and who set a task's priority.

import { type Deferral, type SteeringChange, type SteeringChangeSet, type State, type Task, ControlError } from "../types";
import { cancelInto, clearDeferral, deferInto, reopenDropped, writePriority } from "./controls";
import { currentVision, draft, event, findStep, isOpen, touch } from "./core";
import { rootOf } from "./fanout";
import { notePermission, rerunWithNoteInto, sendNoteInto } from "./notes";
import { visionContentMovedSince } from "./steering";
import { pushVision } from "./vision";

/** Replace the "left as is on <op>: …" segment of a row's note (review finding 12: failed undos must not pile up). */
function leftNote(note: string | undefined, op: "undo" | "apply", why: string): string {
  const prefix = `left as is on ${op}:`;
  const parts = (note ?? "").split("; ").filter((p) => p && !p.startsWith(prefix));
  parts.push(`${prefix} ${why}`);
  return parts.join("; ");
}

function getChangeSet(s: State, changeSetId: string): SteeringChangeSet {
  const set = s.steering.find((x) => x.id === changeSetId);
  if (!set) throw new ControlError(`Unknown change set ${changeSetId}`);
  return set;
}

function getChange(set: SteeringChangeSet, changeId: string): SteeringChange {
  const c = set.changes.find((x) => x.id === changeId);
  if (!c) throw new ControlError(`Unknown change ${changeId}`);
  return c;
}

export interface UndoResult {
  undone: string[];
  left: { id: string; why: string }[];
}

/** Revert one applied row, compare-and-set. Returns why it was left as is, or undefined when undone. */
function undoRow(s: State, set: SteeringChangeSet, c: SteeringChange, now: string): string | undefined {
  const t = c.taskId ? s.tasks.find((x) => x.id === c.taskId) : undefined;
  switch (c.kind) {
    case "focus": {
      const cur = currentVision(s);
      if (visionContentMovedSince(s, c.visionRev)) return `the vision changed since (now r${cur.rev})`;
      pushVision(s, { author: "user", text: cur.text, focus: String(c.before ?? ""), reason: `Undid the lead's focus change (${set.id})`, source: { undoOf: set.id } }, now);
      return undefined;
    }
    case "priority": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.priority !== c.after) return `you changed it since (now P${t.priority})`;
      writePriority(s, t, Number(c.before), "user", now, `undo of ${c.id}`);
      (t.userSet ??= {}).priority = now; // the lead cannot redo what the user reversed
      return undefined;
    }
    case "defer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.deferral?.changeSetId !== set.id) return "it was run or deferred again since";
      clearDeferral(s, t, "user", now, `undo of ${c.id}`);
      (t.userSet ??= {}).run = now;
      return undefined;
    }
    case "undefer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.deferral) return "it was deferred again since";
      const before = c.before as Deferral | null;
      if (!before || typeof before !== "object") return "the earlier deferral is not on record";
      // Review finding 7: restored as the user's deferral, so the lead can only suggest lifting it again.
      t.deferral = { ...structuredClone(before), by: "user", at: now };
      touch(t, now);
      event(s, now, "user", "control", `Deferral restored by you (undo of ${c.id}); the lead may only suggest lifting it`, t.id);
      return undefined;
    }
    case "drop":
      if (!t) return "task not found";
      // A drop the user applied went through the ordinary cancel, which has no undo.
      if (c.appliedBy === "user") return "you cancelled it; a cancel cannot be undone";
      return reopenDropped(s, t, set.id, now);
    default:
      return "not applied";
  }
}

/** Undo one row, or every applied row of a reply in reverse order. Compare-and-set: anything changed since is left alone and reported. */
export function undoSteering(state: State, changeSetId: string, changeId: string | undefined, now: string): { state: State; result: UndoResult } {
  const s = draft(state);
  const set = getChangeSet(s, changeSetId);
  const rows = changeId ? [getChange(set, changeId)] : [...set.changes].reverse();
  const result: UndoResult = { undone: [], left: [] };
  let noted = false; // a row's note changed: a new reason, not a repeat of the last failed undo
  for (const c of rows) {
    if (c.status === "undone") {
      result.left.push({ id: c.id, why: "already undone" });
      continue;
    }
    if (c.status !== "applied") {
      if (changeId) result.left.push({ id: c.id, why: "not applied" });
      continue;
    }
    // ORC-022: a sent note cannot be unsent. Undo all skips it (the row says so); nothing is written on it.
    if (c.kind === "note") {
      if (changeId) result.left.push({ id: c.id, why: "a sent note cannot be unsent" });
      continue;
    }
    const why = undoRow(s, set, c, now);
    if (why) {
      const note = leftNote(c.note, "undo", why);
      if (note !== c.note) noted = true;
      c.note = note;
      result.left.push({ id: c.id, why });
    } else {
      c.status = "undone";
      c.resolvedAt = now;
      result.undone.push(c.id);
    }
  }
  // Review finding 12: a repeated failed undo neither grows the note nor logs another event.
  if (result.undone.length || noted) {
    event(s, now, "user", "control", `Undid ${result.undone.length} of the lead's change${result.undone.length === 1 ? "" : "s"} (${set.id})${result.left.length ? `; ${result.left.length} left as is` : ""}`);
  }
  return { state: s, result };
}

export interface ApplyResult {
  applied: string[];
  left: { id: string; why: string }[];
}

/** Apply one suggested row as the user. Returns why it was left as is, or undefined when applied. */
function applyRow(s: State, set: SteeringChangeSet, c: SteeringChange, now: string): string | undefined {
  const t = c.taskId ? s.tasks.find((x) => x.id === c.taskId) : undefined;
  switch (c.kind) {
    case "focus": {
      const cur = currentVision(s);
      if (visionContentMovedSince(s, c.visionRev)) return `the vision changed since (now r${cur.rev})`;
      const rev = pushVision(s, { author: "user", text: cur.text, focus: String(c.after ?? ""), reason: `Applied the lead's suggestion (${set.id}): ${c.why || set.reason}`, source: { changeSetId: set.id } }, now);
      c.visionRev = rev.rev;
      return undefined;
    }
    case "priority": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.priority !== c.before) return `the priority changed since (now P${t.priority})`;
      writePriority(s, t, Number(c.after), "user", now, `applied ${c.id}`);
      (t.userSet ??= {}).priority = now;
      return undefined;
    }
    case "defer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.parentTaskId) return `child of ${t.parentTaskId}`;
      if (t.deferral) return "it is already deferred";
      deferInto(s, t, { by: "user", at: now, reason: c.why || set.reason, changeSetId: set.id }, now, `applied ${c.id}`);
      c.after = structuredClone(t.deferral!);
      return undefined;
    }
    case "undefer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (!t.deferral || JSON.stringify(t.deferral) !== JSON.stringify(c.before)) return "the deferral changed since";
      clearDeferral(s, t, "user", now, `applied ${c.id}`);
      (t.userSet ??= {}).run = now;
      return undefined;
    }
    case "drop": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      cancelInto(s, t, now);
      return undefined;
    }
    // ORC-022: Send on a suggested note, or Rerun with this note on a suggested rerun.
    case "note": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      const st = c.stepId ? findStep(t, c.stepId) : undefined;
      if (!st) return `${c.stepId ?? "?"} is not on ${t.id}'s pipeline`;
      if (c.rerun && c.noteId) return rerunWithNoteInto(s, t, st, c.noteId, now);
      // The user chose: the mode no longer applies, the hard rules (roles, delivery tasks) still do.
      const verdict = notePermission(s, t, st, "apply");
      if (verdict.v === "reject") return verdict.why;
      const sent = sendNoteInto(s, t, st, { text: String(c.after ?? ""), from: { by: "lead", leadRunId: set.leadRunId, changeSetId: set.id, changeId: c.id, messageIds: [...set.messageIds] }, ifFinished: c.ifFinished ?? "report", ...(set.simulated ? { simulated: true as const } : {}) }, now);
      if ("refused" in sent) return sent.refused;
      c.noteId = sent.note.id;
      if (sent.rerunSuggested) {
        c.rerun = true;
        return `${st.id} had finished and ${sent.rerunSuggested}: use "Rerun with this note"`;
      }
      return undefined;
    }
    default:
      return "not a suggestion";
  }
}

/** Apply one suggestion, or every suggestion of a reply, as the user. Compare-and-set against the recorded `before`. */
export function applySteering(state: State, changeSetId: string, changeId: string | undefined, now: string): { state: State; result: ApplyResult } {
  const s = draft(state);
  const set = getChangeSet(s, changeSetId);
  const rows = changeId ? [getChange(set, changeId)] : set.changes.filter((c) => c.status === "suggested");
  const result: ApplyResult = { applied: [], left: [] };
  for (const c of rows) {
    if (c.status !== "suggested") {
      result.left.push({ id: c.id, why: c.status === "applied" ? "already applied" : `not a suggestion (${c.status})` });
      continue;
    }
    // ORC-022 review M2: a rerun stops and invalidates downstream work, so it is applied only on its own row, never in bulk.
    if (!changeId && c.kind === "note" && c.rerun) {
      result.left.push({ id: c.id, why: "needs Rerun with this note" });
      continue;
    }
    const why = applyRow(s, set, c, now);
    if (why) {
      c.note = leftNote(c.note, "apply", why);
      result.left.push({ id: c.id, why });
    } else {
      c.status = "applied";
      c.appliedBy = "user";
      c.resolvedAt = now;
      result.applied.push(c.id);
    }
  }
  if (result.applied.length) event(s, now, "user", "control", `Applied ${result.applied.length} of the lead's suggestion(s) (${set.id})${result.left.length ? `; ${result.left.length} left as is` : ""}`);
  return { state: s, result };
}

/** Dismiss one suggestion, or every suggestion of a reply. The lead sees dismissed rows in its next envelope. */
export function dismissSteering(state: State, changeSetId: string, changeId: string | undefined, now: string): { state: State; result: { dismissed: string[] } } {
  const s = draft(state);
  const set = getChangeSet(s, changeSetId);
  const rows = changeId ? [getChange(set, changeId)] : set.changes.filter((c) => c.status === "suggested");
  const dismissed: string[] = [];
  for (const c of rows) {
    if (c.status !== "suggested") continue;
    c.status = "dismissed";
    c.resolvedAt = now;
    dismissed.push(c.id);
  }
  if (dismissed.length) event(s, now, "user", "control", `Dismissed ${dismissed.length} of the lead's suggestion(s) (${set.id})`);
  return { state: s, result: { dismissed } };
}

/** Suggestions nobody has applied, dismissed or superseded yet. */
export function openSuggestions(s: State): { set: SteeringChangeSet; change: SteeringChange }[] {
  const out: { set: SteeringChangeSet; change: SteeringChange }[] = [];
  for (const set of s.steering) for (const change of set.changes) if (change.status === "suggested") out.push({ set, change });
  return out;
}

/** The lead's applied focus change behind the current vision, when it still stands (for Undo on the banner and the Vision card). */
export function currentFocusChange(s: State): { set: SteeringChangeSet; change: SteeringChange } | undefined {
  const v = currentVision(s);
  const id = v.source?.changeSetId;
  if (v.author !== "lead" || !id) return undefined;
  const set = s.steering.find((x) => x.id === id);
  const change = set?.changes.find((c) => c.kind === "focus" && c.status === "applied" && c.visionRev === v.rev);
  return set && change ? { set, change } : undefined;
}

type PriorityProvenance = { kind: "user" } | { kind: "lead"; was: number; changeSetId: string; changeId: string } | { kind: "auto" } | { kind: "child"; rootId: string; priority: number };

/** Who set a task's priority: you (pinned), the lead (while its value still holds), nobody (auto), or its root for a child. */
export function priorityProvenance(s: State, t: Task): PriorityProvenance {
  if (t.parentTaskId && !t.userSet?.priority) {
    const root = rootOf(s, t);
    return { kind: "child", rootId: root.id, priority: root.priority };
  }
  if (t.userSet?.priority) return { kind: "user" };
  for (let i = s.steering.length - 1; i >= 0; i--) {
    const set = s.steering[i];
    for (let j = set.changes.length - 1; j >= 0; j--) {
      const c = set.changes[j];
      if (c.kind !== "priority" || c.taskId !== t.id || c.appliedBy !== "lead" || (c.status !== "applied" && c.status !== "undone")) continue;
      return c.status === "applied" && c.after === t.priority ? { kind: "lead", was: Number(c.before), changeSetId: set.id, changeId: c.id } : { kind: "auto" };
    }
  }
  return { kind: "auto" };
}
