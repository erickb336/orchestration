// A lead reply to the user's messages may carry a `steer` block: a new focus, and per root task a
// priority, a deferral or a drop. The lead's output is untrusted data. The service validates every item,
// checks it against `steerPermission` using the state at apply time, applies what is allowed in the same
// transaction that records the reply, and writes the authoritative change list. The lead never pauses,
// stops, resumes or releases anything, and never touches done tasks, delivery, specs, pins or settings.

import {
  type LeadRun,
  type SteerAction,
  type SteeringChange,
  type SteeringChangeSet,
  type SteeringMode,
  type State,
  type Task,
  MAX_NOTES_PER_REPLY,
  MAX_NOTE_LENGTH,
} from "../types";
import { peReviewKeeps } from "../peReview";
import { clearDeferral, deferInto, dropInto, openDependent, started, userHold, userTouched, writePriority } from "./controls";
import { currentVision, event } from "./core";
import { rootOf } from "./fanout";
import { pendingMessages } from "./lead";
import { notePermission, noteTextCheck, sendNoteInto } from "./notes";
import { CONTROL_RE, oneLine } from "./textSafety";
import { pushVision } from "./vision";

type SteerVerdict =
  | { v: "apply"; note?: string }
  | { v: "suggest"; why: string }
  /** Valid, but a rule keeps the current value. */
  | { v: "skip"; why: string }
  /** Not steerable. */
  | { v: "reject"; why: string }
  /** Nothing would change: not recorded. */
  | { v: "noop" };

/** The single source of what the lead may do to a task: it fills the envelope and enforces at apply time. */
export function steerPermission(s: State, t: Task | undefined, action: SteerAction, mode: SteeringMode, value?: number): SteerVerdict {
  // 1. Not steerable.
  if (!t) return { v: "reject", why: "unknown task" };
  if (t.lifecycle === "done" || t.lifecycle === "cancelled") return { v: "reject", why: `${t.id} is ${t.lifecycle}` };
  // The review and fix tasks the service creates for a pull request belong to delivery, which steering
  // never touches: no priority, deferral or drop, whatever the mode.
  if (t.reviewTarget || t.deliverInto || t.checkTarget) return { v: "reject", why: "delivery task: not steerable" };
  if (t.parentTaskId) return { v: "reject", why: `child of ${t.parentTaskId}: steer ${rootOf(s, t).id}` };
  // 2. Nothing would change.
  if (action === "priority" && value === t.priority) return { v: "noop" };
  if (action === "defer" && t.deferral) return { v: "noop" };
  if (action === "undefer" && !t.deferral) return { v: "noop" };
  // 3. Valid, but the current value is kept: only the user decides when paused or failing work runs, and
  //    a drop or a deferral never leaves another open task waiting or blocked.
  if (action === "defer" && t.hold) return { v: "skip", why: userHold(t) ? "paused by you" : "paused for review" };
  if (action === "defer" && t.controlFailure) return { v: "skip", why: "needs your attention (control failure)" };
  if (action === "defer" || action === "drop") {
    const dep = openDependent(s, t, action);
    if (dep) return { v: "skip", why: `kept: ${dep.id} depends on it` };
  }
  // 4. A user choice or the mode turns it into a suggestion.
  const own = t.specs[0]?.author === "lead";
  let verdict: SteerVerdict;
  switch (action) {
    case "priority":
      if (t.userSet?.priority) verdict = { v: "suggest", why: `you set P${t.priority}` };
      else if (mode === "apply-own" && !own) verdict = { v: "suggest", why: "your task: suggest-only (Settings)" };
      else verdict = { v: "apply", ...(t.holdBeforeStart && t.lifecycle !== "active" ? { note: "still waits for your go-ahead" } : {}) };
      break;
    case "defer":
      if (t.userSet?.run) verdict = { v: "suggest", why: "you asked it to keep running" };
      else if (mode === "apply-own" && !own) verdict = { v: "suggest", why: "your task: suggest-only (Settings)" };
      else verdict = { v: "apply" };
      break;
    case "undefer":
      verdict = t.deferral!.by === "user" ? { v: "suggest", why: "you deferred it" } : { v: "apply" };
      break;
    case "drop":
      if (!own) verdict = { v: "suggest", why: "your task: only you cancel it" };
      // A PE objection is never dropped, nor a review the PE has not finished: the lead may only suggest it.
      else if (peReviewKeeps(t.peReview)) verdict = { v: "suggest", why: peReviewKeeps(t.peReview)! };
      else if (started(s, t)) verdict = { v: "suggest", why: "it has started; cancelling stops its work" };
      else if (userTouched(t)) verdict = { v: "suggest", why: "you changed this task" };
      else verdict = { v: "apply" };
      break;
  }
  // 5. Only suggest.
  if (mode === "suggest" && verdict.v === "apply") return { v: "suggest", why: "only suggest (Settings)" };
  return verdict;
}

const STEER_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MAX_STEER_ITEMS = 20;

interface SteerItem {
  id: string;
  action: SteerAction;
  value?: number;
  why: string;
}

/** One entry of the lead's "notes" list, validated. */
interface NoteItem {
  task: string;
  step: string;
  text: string;
  ifFinished: "report" | "rerun";
}

interface ValidatedSteer {
  refused?: string;
  /** Absent: no focus change, or one equal to the current focus (a no-op, not recorded). */
  focus?: { ok: true; value: string } | { ok: false; why: string };
  reason: string;
  notes: string[];
  items: ({ ok: true; item: SteerItem } | { ok: false; kind: SteeringChange["kind"]; taskId?: string; why: string; reason: string })[];
  /** The notes to running steps; a rejected entry keeps what could be read of it for its row. */
  noteItems: ({ ok: true; item: NoteItem } | { ok: false; taskId?: string; stepId?: string; text?: string; reason: string })[];
}

/** What action an entry names, for a rejected row's kind. */
function guessKind(it: Record<string, unknown> | undefined): SteeringChange["kind"] {
  if (!it) return "invalid";
  const keys = ["priority", "defer", "drop"].filter((k) => it[k] !== undefined);
  if (keys.length !== 1) return "invalid";
  if (keys[0] === "priority") return "priority";
  if (keys[0] === "drop") return "drop";
  return it.defer === false ? "undefer" : "defer";
}

/**
 * Strict, per-item validation of the lead's steering block. Each entry is checked on its own, so one
 * bad entry never discards the others (the H2 flow). Pure: nothing is applied here.
 */
export function validateSteer(s: State, r: LeadRun, steer: unknown): ValidatedSteer {
  const out: ValidatedSteer = { reason: "From your message", notes: [], items: [], noteItems: [] };
  // Permission is decided by the messages the run answers, never by its trigger.
  if (r.messageIds.length === 0) return { ...out, refused: "planning runs cannot steer" };
  if (r.visionRev === undefined) return { ...out, refused: "started before steering existed" };
  if (!steer || typeof steer !== "object" || Array.isArray(steer)) return { ...out, refused: "the steering block was not an object" };
  const b = steer as Record<string, unknown>;
  if (b.focus !== undefined && b.focus !== null) {
    if (typeof b.focus !== "string") out.focus = { ok: false, why: "focus must be text" };
    else if (CONTROL_RE.test(b.focus)) out.focus = { ok: false, why: "focus contains control characters" };
    else {
      const f = oneLine(b.focus);
      if (f.length < 1 || f.length > 500) out.focus = { ok: false, why: "focus must be 1–500 characters" };
      else if (f !== oneLine(currentVision(s).focus)) out.focus = { ok: true, value: f };
    }
  }
  if (typeof b.reason === "string" && !CONTROL_RE.test(b.reason) && oneLine(b.reason) && oneLine(b.reason).length <= 500) out.reason = oneLine(b.reason);
  else if (b.reason !== undefined && b.reason !== null) out.notes.push("reason ignored: not plain text of at most 500 characters");
  if (b.tasks !== undefined && b.tasks !== null) {
    if (!Array.isArray(b.tasks)) out.notes.push("tasks ignored: not a list");
    else {
      // Entries past the cap are counted in one note, never one persisted row each.
      const extra = b.tasks.length - MAX_STEER_ITEMS;
      if (extra > 0) out.notes.push(`${extra} more entr${extra === 1 ? "y" : "ies"} ignored: at most ${MAX_STEER_ITEMS} changes in one reply`);
      const seen = new Set<string>();
      b.tasks.slice(0, MAX_STEER_ITEMS).forEach((raw: unknown) => {
        const it = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
        const id = typeof it?.id === "string" && STEER_ID_RE.test(it.id) ? it.id : undefined;
        // The copy kept on a rejected row is plain text too: control characters stripped, one line, capped.
        const why = typeof it?.why === "string" ? oneLine(it.why.replace(new RegExp(CONTROL_RE.source, "g"), "")).slice(0, 300) : "";
        const fail = (reason: string) => out.items.push({ ok: false, kind: guessKind(it), ...(id ? { taskId: id } : {}), why, reason });
        try {
          if (!it) return fail("not an object");
          if (!id) return fail("id must be 1–40 letters, digits, dots, dashes or underscores");
          const keys = ["priority", "defer", "drop"].filter((k) => it[k] !== undefined);
          if (keys.length !== 1) return fail("give exactly one of priority, defer, drop");
          if (it.why !== undefined && it.why !== null && (typeof it.why !== "string" || it.why.length > 300)) return fail("why must be text of at most 300 characters");
          if (typeof it.why === "string" && CONTROL_RE.test(it.why)) return fail("why contains control characters");
          let action: SteerAction;
          let value: number | undefined;
          if (keys[0] === "priority") {
            if (typeof it.priority !== "number" || !Number.isInteger(it.priority) || it.priority < 1 || it.priority > 99) return fail("priority must be a whole number 1–99");
            action = "priority";
            value = it.priority;
          } else if (keys[0] === "defer") {
            if (typeof it.defer !== "boolean") return fail("defer must be true or false");
            action = it.defer ? "defer" : "undefer";
          } else {
            if (it.drop !== true) return fail("drop must be true");
            action = "drop";
          }
          if (seen.has(id)) return fail("one change per task per reply");
          seen.add(id);
          out.items.push({ ok: true, item: { id, action, ...(value !== undefined ? { value } : {}), why } });
        } catch (err) {
          fail(`invalid (${err instanceof Error ? err.message : String(err)})`);
        }
      });
    }
  }
  // Notes to running steps. Each entry is checked on its own; entries past the cap are counted in one note.
  if (b.notes !== undefined && b.notes !== null) {
    if (!Array.isArray(b.notes)) out.notes.push("notes ignored: not a list");
    else {
      const extra = b.notes.length - MAX_NOTES_PER_REPLY;
      if (extra > 0) out.notes.push(`${extra} more note${extra === 1 ? "" : "s"} ignored: at most ${MAX_NOTES_PER_REPLY} notes in one reply`);
      b.notes.slice(0, MAX_NOTES_PER_REPLY).forEach((raw: unknown) => {
        const it = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
        const task = typeof it?.task === "string" && STEER_ID_RE.test(it.task) ? it.task : undefined;
        const step = typeof it?.step === "string" && STEER_ID_RE.test(it.step) ? it.step : undefined;
        // The copy kept on a rejected row is plain text too: control characters stripped, one line, capped.
        const text = typeof it?.text === "string" ? oneLine(it.text.replace(new RegExp(CONTROL_RE.source, "g"), "")).slice(0, MAX_NOTE_LENGTH) : undefined;
        const fail = (reason: string) => out.noteItems.push({ ok: false, ...(task ? { taskId: task } : {}), ...(step ? { stepId: step } : {}), ...(text ? { text } : {}), reason });
        if (!it) return fail("not an object");
        if (!task) return fail("task must be 1–40 letters, digits, dots, dashes or underscores");
        if (!step) return fail("step must be 1–40 letters, digits, dots, dashes or underscores");
        const checked = noteTextCheck(it.text, "lead");
        if (!checked.ok) return fail(checked.why);
        let ifFinished: NoteItem["ifFinished"] = "report";
        if (it.ifFinished !== undefined && it.ifFinished !== null) {
          if (it.ifFinished !== "report" && it.ifFinished !== "rerun") return fail('ifFinished must be "report" or "rerun"');
          ifFinished = it.ifFinished;
        }
        out.noteItems.push({ ok: true, item: { task, step, text: checked.text, ifFinished } });
      });
    }
  }
  return out;
}

/** Validate and apply a completed message run's steering block; returns the authoritative change set. */
export function steerFromRun(s: State, r: LeadRun, steer: unknown, now: string, simulated?: true): SteeringChangeSet {
  const setId = `cs-${r.id}`;
  const v = validateSteer(s, r, steer);
  // A set from the simulated lead says so in a structured flag, so the UI labels it without text in the focus.
  const set: SteeringChangeSet = { id: setId, leadRunId: r.id, messageIds: [...r.messageIds], at: now, mode: s.project.steeringMode, basedOnVisionRev: r.visionRev ?? currentVision(s).rev, reason: v.reason, notes: v.notes, changes: [], ...(simulated ? { simulated: true as const } : {}) };
  if (v.refused) {
    set.refused = v.refused;
    event(s, now, "system", "control", `Lead run ${r.id}: steering refused (${v.refused})`);
    return set;
  }
  // Newer direction wins: the run is completed now, so its own messages are covered; anything still
  // pending was posted while it worked. A vision edit meanwhile also holds the set.
  const newer = pendingMessages(s).length > 0;
  // Only a change to the text or focus holds the set. Documents attached or removed
  // meanwhile are noted truthfully, and the focus still applies.
  const visionMoved = visionContentMovedSince(s, r.visionRev);
  if (newer) set.heldBecause = "You sent another message while the lead was working; its next reply decides.";
  else if (visionMoved) set.heldBecause = "You edited the vision while the lead was working.";
  if (!visionMoved && currentVision(s).rev !== r.visionRev) set.notes.push("Your vision documents changed while the lead was working; its reply may not reflect them.");
  const held = !!set.heldBecause;
  const mode = s.project.steeringMode;
  const from = r.messageIds.join(", ");
  const rows: SteeringChange[] = [];
  const row = (c: Omit<SteeringChange, "id">): SteeringChange => {
    const full = { id: `${setId}.${rows.length + 1}`, ...c };
    rows.push(full);
    return full;
  };

  // Focus first, so the task changes and the new proposals follow it.
  const cur = currentVision(s);
  if (v.focus) {
    if (!v.focus.ok) row({ kind: "focus", before: cur.focus, after: null, why: v.reason, status: "rejected", note: v.focus.why });
    else if (visionMoved) row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "rejected", note: `you edited the vision (now r${cur.rev}); your edit stands` });
    // An undone change cannot be redone. Task rows are guarded by the pins Undo sets;
    // a focus has no pin, so a focus the user undid can only be suggested again.
    else if (undoneFocus(s, v.focus.value)) row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "suggested", note: "you undid this focus", visionRev: r.visionRev });
    else if (held || mode === "suggest") row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "suggested", note: held ? "held: newer direction" : "only suggest (Settings)", visionRev: r.visionRev });
    else {
      const rev = pushVision(s, { author: "lead", text: cur.text, focus: v.focus.value, reason: v.reason, source: { changeSetId: setId, leadRunId: r.id, messageIds: [...r.messageIds] }, ...(simulated ? { simulated: true as const } : {}) }, now, `Focus r${cur.rev + 1} by lead from your message ${from} (${setId}): ${v.reason}`);
      row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "applied", appliedBy: "lead", visionRev: rev.rev });
    }
  }

  // Task items, in array order. No-ops are not recorded; the rest get rows now so their ids follow the
  // order the lead gave, even when the dependency-guard retry pass applies some of them later.
  const pending: { item: SteerItem; change: SteeringChange }[] = [];
  for (const entry of v.items) {
    if (!entry.ok) {
      row({ kind: entry.kind, ...(entry.taskId ? { taskId: entry.taskId } : {}), before: null, after: null, why: entry.why, status: "rejected", note: entry.reason });
      continue;
    }
    const { item } = entry;
    const t = s.tasks.find((x) => x.id === item.id);
    if (t && steerPermission(s, t, item.action, mode, item.value).v === "noop") continue;
    const kind: SteeringChange["kind"] = item.action;
    const before: SteeringChange["before"] = !t ? null : item.action === "priority" ? t.priority : item.action === "defer" ? null : item.action === "undefer" ? structuredClone(t.deferral ?? null) : t.lifecycle;
    const after: SteeringChange["after"] = item.action === "priority" ? (item.value ?? null) : item.action === "defer" ? { by: "lead", at: now, reason: item.why, changeSetId: setId } : item.action === "undefer" ? null : "cancelled";
    pending.push({ item, change: row({ kind, taskId: item.id, before, after, why: item.why, status: "skipped" }) });
  }
  // Each item is checked against the current state, including the items already applied in this run.
  // Items kept only by the dependency guard are re-checked after the others, until none more apply, so
  // the lead may defer or drop both a prerequisite and its dependent in either order.
  const decide = (p: { item: SteerItem; change: SteeringChange }): boolean => {
    const { item, change } = p;
    const t = s.tasks.find((x) => x.id === item.id);
    let verdict = steerPermission(s, t, item.action, mode, item.value);
    if (held && verdict.v === "apply") verdict = { v: "suggest", why: "held: newer direction" };
    if (verdict.v === "skip" && verdict.why.startsWith("kept:")) {
      change.status = "skipped";
      change.note = verdict.why;
      return false;
    }
    if (verdict.v === "noop") {
      change.status = "skipped";
      change.note = "nothing to change";
    } else if (verdict.v === "reject" || verdict.v === "skip" || verdict.v === "suggest") {
      change.status = verdict.v === "reject" ? "rejected" : verdict.v === "skip" ? "skipped" : "suggested";
      change.note = verdict.why;
    } else {
      const task = t!;
      const detail = `${change.id}, from ${from}`;
      if (item.action === "priority") writePriority(s, task, item.value!, "lead", now, `${detail}${item.why ? `: ${item.why}` : ""}`);
      else if (item.action === "defer") deferInto(s, task, { by: "lead", at: now, reason: item.why, changeSetId: setId }, now, change.id);
      else if (item.action === "undefer") clearDeferral(s, task, "lead", now, `${change.id}${item.why ? `: ${item.why}` : ""}`);
      else dropInto(s, task, setId, item.why, now, change.id);
      change.status = "applied";
      change.appliedBy = "lead";
      // A row applied on the retry pass drops its "kept: …" note from the first pass.
      if (verdict.note) change.note = verdict.note;
      else delete change.note;
    }
    return true;
  };
  let queue = pending.filter((p) => !decide(p));
  for (let pass = 0; queue.length && pass < MAX_STEER_ITEMS; pass++) {
    const again = queue.filter((p) => !decide(p));
    if (again.length === queue.length) break;
    queue = again;
  }

  // Notes to running steps, after the task changes (a note to a task dropped above is refused as
  // cancelled). Each is checked against the state now, sent when allowed, and recorded as a row; "applied"
  // means sent, and the row then shows the note's live status. A note has no Undo.
  for (const entry of v.noteItems) {
    if (!entry.ok) {
      row({ kind: "note", ...(entry.taskId ? { taskId: entry.taskId } : {}), ...(entry.stepId ? { stepId: entry.stepId } : {}), before: null, after: entry.text ?? null, why: "", status: "rejected", note: entry.reason });
      continue;
    }
    const { item } = entry;
    const t = s.tasks.find((x) => x.id === item.task);
    const st = t?.steps.find((x) => x.id === item.step);
    let verdict = notePermission(s, t, st, mode);
    if (held && verdict.v === "apply") verdict = { v: "suggest", why: "held: newer direction" };
    const base = { kind: "note" as const, taskId: item.task, stepId: item.step, before: null, after: item.text, why: "", ...(item.ifFinished === "rerun" ? { ifFinished: item.ifFinished } : {}) };
    if (verdict.v !== "apply") {
      row({ ...base, status: verdict.v === "reject" ? "rejected" : "suggested", note: verdict.why });
      continue;
    }
    const change = row({ ...base, status: "skipped" });
    const sent = sendNoteInto(s, t!, st!, { text: item.text, from: { by: "lead", leadRunId: r.id, changeSetId: setId, changeId: change.id, messageIds: [...r.messageIds] }, ifFinished: item.ifFinished, ...(simulated ? { simulated: true as const } : {}) }, now);
    if ("refused" in sent) {
      change.status = "rejected";
      change.note = sent.refused;
      continue;
    }
    change.noteId = sent.note.id;
    if (sent.rerunSuggested) {
      change.status = "suggested";
      change.rerun = true;
      change.note = `${st!.id} had finished; the rerun needs your go-ahead: ${sent.rerunSuggested}`;
    } else {
      change.status = "applied";
      change.appliedBy = "lead";
    }
  }

  set.changes = rows;
  const count = (st: SteeringChange["status"], kind?: SteeringChange["kind"]) => rows.filter((c) => c.status === st && (!kind || c.kind === kind)).length;
  const parts = [
    count("applied", "focus") && "focus changed",
    count("applied", "priority") && `${count("applied", "priority")} reprioritized`,
    count("applied", "defer") && `${count("applied", "defer")} deferred`,
    count("applied", "undefer") && `${count("applied", "undefer")} deferral${count("applied", "undefer") === 1 ? "" : "s"} lifted`,
    count("applied", "drop") && `${count("applied", "drop")} dropped`,
    count("applied", "note") && `${count("applied", "note")} note${count("applied", "note") === 1 ? "" : "s"} sent`,
  ].filter(Boolean);
  const rest = [count("suggested") && `${count("suggested")} suggestion${count("suggested") === 1 ? "" : "s"}`, count("skipped") && `${count("skipped")} kept`, count("rejected") && `${count("rejected")} rejected`].filter(Boolean);
  event(s, now, "lead", "control", `Lead run ${r.id} steered from ${from}: ${parts.length ? parts.join(", ") : "nothing applied"}${rest.length ? `; ${rest.join(", ")}` : ""} (${setId})${set.heldBecause ? ` — held: ${set.heldBecause}` : ""}`);
  return set;
}

/**
 * Older suggestions are superseded by a held set's successor, or by a later row for the same target.
 * Only a reply that decided something supersedes. A reply without a steering block,
 * or whose block was refused, leaves the held suggestions for the next one; and only rows the service
 * accepted (applied or suggested) count as a decision on their target.
 */
export function supersedeSuggestions(s: State, set: SteeringChangeSet | undefined, now: string) {
  if (!set || set.refused) return;
  const accepted = set.changes.filter((x) => x.status === "applied" || x.status === "suggested");
  // A note's target is its step; a note never supersedes a task change, nor the other way round.
  const same = (x: SteeringChange, c: SteeringChange) => {
    if (x.kind === "focus") return c.kind === "focus";
    if (x.kind === "note") return c.kind === "note" && x.taskId === c.taskId && x.stepId === c.stepId;
    return c.kind !== "note" && x.taskId !== undefined && x.taskId === c.taskId;
  };
  for (const cs of s.steering) {
    if (cs.id === set.id) continue;
    for (const c of cs.changes) {
      if (c.status !== "suggested") continue;
      const sameTarget = accepted.some((x) => same(x, c));
      if (cs.heldBecause || sameTarget) {
        c.status = "superseded";
        c.resolvedAt = now;
      }
    }
  }
}

/**
 * Attaching or removing a document creates a vision revision without touching the
 * text or focus. Compare-and-set on the lead's focus changes, and the "you edited the vision" hold,
 * therefore compare the text and focus, never the raw revision number: a document-only change
 * invalidates nothing.
 */
export function visionContentMovedSince(s: State, rev: number | undefined): boolean {
  const then = rev === undefined ? undefined : s.project.visions.find((v) => v.rev === rev);
  if (!then) return true;
  const cur = currentVision(s);
  return cur.text !== then.text || cur.focus !== then.focus;
}

/** Did the user undo a lead focus change to exactly this text? Then it is only suggested again. */
function undoneFocus(s: State, focus: string): boolean {
  return s.steering.some((cs) => cs.changes.some((c) => c.kind === "focus" && c.status === "undone" && oneLine(String(c.after ?? "")) === focus));
}
