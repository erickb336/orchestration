// A note is a short instruction for the agent running one step of one task: guidance within the current
// spec, never a change to the spec, the pipeline, a pin or a setting. The lead sends notes as rows of its
// change set (only in a reply to the user's messages); the user sends them from the task page. The service
// decides which run receives one. Desired state (queued, sending) stays apart from observed state: a note is
// "delivered" only on the runtime's acknowledgment, never by implication.

import { downstreamOf } from "../pipeline";
import {
  type Actor,
  type Attempt,
  type Note,
  type NoteSource,
  type SteeringMode,
  type RoleId,
  type State,
  type Step,
  type Task,
  ControlError,
  MAX_NOTES,
  MAX_NOTES_PER_RUN,
  MAX_NOTE_LENGTH,
} from "../types";
import { userHold } from "./controls";
import { activeAttempts, assertOpen, draft, event, findStep, getStep, getTask, isOpen, nextId } from "./core";
import { rootOf } from "./fanout";
import { rerunInto } from "./retries";
import { CONTROL_RE, oneLine } from "./textSafety";

/** Roles the lead may send a note to. Reviews stay independent (the reviewer sees the coder's notes anyway); checks have no agent. */
const LEAD_NOTE_ROLES = new Set<RoleId>(["coder", "designer"]);

type NoteVerdict = { v: "apply" } | { v: "suggest"; why: string } | { v: "reject"; why: string };

/** Who may send a note to what: the single source for the lead's envelope and for apply time. */
export function notePermission(s: State, t: Task | undefined, st: Step | undefined, mode: SteeringMode): NoteVerdict {
  if (!t) return { v: "reject", why: "unknown task" };
  if (t.lifecycle === "done" || t.lifecycle === "cancelled") return { v: "reject", why: `${t.id} is ${t.lifecycle}` };
  // The review, fix and check tasks a pull request creates belong to delivery, as for steering.
  if (t.reviewTarget || t.deliverInto || t.checkTarget) return { v: "reject", why: "delivery task: not steerable" };
  if (!st) return { v: "reject", why: `unknown step on ${t.id}` };
  if (!LEAD_NOTE_ROLES.has(st.role)) return { v: "reject", why: st.role === "checks" ? `${st.id} is a checks step: check runs have no agent` : `${st.id} is a ${st.role.replace("_", " ")} step: notes go to coder and designer steps only` };
  // A child of a Goal is allowed (the note is about the running stage, not the task's priority); its root says whose task it is.
  const own = rootOf(s, t).specs[0]?.author === "lead";
  if (mode === "apply-own" && !own) return { v: "suggest", why: "your task: suggest-only (Settings)" };
  if (mode === "suggest") return { v: "suggest", why: "only suggest (Settings)" };
  return { v: "apply" };
}

type NoteRoute =
  /** The step has a live run: the note goes to it now. */
  | { v: "sending"; attemptId: string }
  /** No live run yet (not started, waiting for a slot, paused, or its run is stopping): the next run's instructions carry it. */
  | { v: "queued"; why: string }
  | { v: "not-delivered"; reason: string }
  /** The step had finished and the sender asked for a rerun; nothing downstream started, so it reruns with the note. */
  | { v: "rerun" }
  /** The step had finished; the rerun needs the user (`why`). */
  | { v: "rerun-suggest"; why: string };

/** Which run a note to this step goes to, from the task's state now. Pure: nothing is sent here. */
function noteRoute(s: State, t: Task, st: Step, ifFinished: "report" | "rerun"): NoteRoute {
  if (t.lifecycle === "done" || t.lifecycle === "cancelled") return { v: "not-delivered", reason: `${t.id} is ${t.lifecycle}` };
  const live = activeAttempts(s, t.id).find((a) => a.stepId === st.id);
  if (live?.outcome === "running") return { v: "sending", attemptId: live.id };
  if (live?.outcome === "stopping") return { v: "queued", why: "its run is stopping" };
  switch (st.state) {
    case "paused":
      return { v: "queued", why: "the task is paused" };
    case "blocked":
      return { v: "not-delivered", reason: `${st.id} is blocked: its last run failed` };
    case "skipped":
      return { v: "not-delivered", reason: `${st.id} was skipped` };
    case "done": {
      if (ifFinished !== "rerun") return { v: "not-delivered", reason: `${st.id} had finished` };
      const why = rerunBlocker(s, t, st);
      return why ? { v: "rerun-suggest", why } : { v: "rerun" };
    }
    default:
      return { v: "queued", why: t.hold || s.project.hold ? "the task is paused" : "the step has not started" };
  }
}

/** Why a finished step is not rerun with a note on the lead's say-so alone: the user decides then. */
function rerunBlocker(s: State, t: Task, st: Step): string | undefined {
  // A project-wide pause is yours too.
  if (s.project.hold) return "the project is paused by you";
  if (t.hold) return userHold(t) ? "the task is paused by you" : "the task is paused for review";
  const started = [...downstreamOf(t.steps, [st.id])].filter((id) => findStep(t, id)?.state !== "pending");
  if (started.length) return `${started.join(", ")} already started on its result`;
  return undefined;
}

const short = (x: string, n = 80) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

/** The limits on a note's text, for both senders: 1–500 characters, one paragraph (newlines folded), no control characters. */
export function noteTextCheck(raw: unknown, who: "lead" | "user"): { ok: true; text: string } | { ok: false; why: string } {
  if (typeof raw !== "string") return { ok: false, why: "text must be text" };
  if (CONTROL_RE.test(raw)) return { ok: false, why: "text contains control characters" };
  // The lead's text loses invisible characters like every text it supplies; the user's is only folded into one line.
  const text = who === "lead" ? oneLine(raw) : raw.replace(/\s+/g, " ").trim();
  if (text.length < 1) return { ok: false, why: "text is empty" };
  if (text.length > MAX_NOTE_LENGTH) return { ok: false, why: `text must be 1–${MAX_NOTE_LENGTH} characters, one paragraph` };
  return { ok: true, text };
}

interface NoteDraft {
  text: string;
  from: NoteSource;
  ifFinished: "report" | "rerun";
  simulated?: true;
}

/**
 * Route and record one note on a draft state. The note's status says where it went. Refused only by the
 * per-run cap. `rerunSuggested`: the step had finished and the rerun needs the user; the note is recorded
 * as not delivered until they ask for the rerun.
 */
export function sendNoteInto(s: State, t: Task, st: Step, d: NoteDraft, now: string): { note: Note; rerunSuggested?: string } | { refused: string } {
  const route = noteRoute(s, t, st, d.ifFinished);
  // At most 10 notes for one run: the live run's notes, or the notes already waiting for the step's next run.
  const bound = route.v === "sending" ? s.notes.filter((n) => n.attemptId === route.attemptId) : s.notes.filter((n) => n.taskId === t.id && n.stepId === st.id && n.status === "queued");
  if ((route.v === "sending" || route.v === "queued" || route.v === "rerun") && bound.length >= MAX_NOTES_PER_RUN) return { refused: `at most ${MAX_NOTES_PER_RUN} notes for one run` };
  const note: Note = { id: nextId(s, "note"), taskId: t.id, stepId: st.id, text: d.text, from: d.from, at: now, status: "queued", ...(d.simulated ? { simulated: true as const } : {}) };
  const actor: Actor = d.from.by === "lead" ? "lead" : "user";
  const who = d.from.by === "lead" ? `by lead from ${d.from.messageIds.join(", ")}` : "by you";
  const quote = `"${short(d.text)}"`;
  let rerunSuggested: string | undefined;
  switch (route.v) {
    case "sending":
      note.status = "sending";
      note.attemptId = route.attemptId;
      note.via = "live";
      note.sentAt = now;
      event(s, now, actor, "control", `Note ${note.id} sent to ${st.id}'s run ${route.attemptId} ${who}: ${quote}`, t.id);
      break;
    case "queued":
      event(s, now, actor, "control", `Note ${note.id} queued for ${st.id}'s next run (${route.why}) ${who}: ${quote}`, t.id);
      break;
    case "rerun":
      rerunInto(s, t, st, now, d.from.by, `with note ${note.id}`);
      event(s, now, actor, "control", `Note ${note.id} queued for the rerun of ${st.id} ${who}: ${quote}`, t.id);
      break;
    case "rerun-suggest":
      note.status = "not-delivered";
      note.reason = `${st.id} had finished`;
      note.settledAt = now;
      rerunSuggested = route.why;
      event(s, now, actor, "control", `Note ${note.id} to ${st.id} not delivered: ${st.id} had finished; rerunning it needs you (${route.why}) ${who}: ${quote}`, t.id);
      break;
    case "not-delivered":
      note.status = "not-delivered";
      note.reason = route.reason;
      note.settledAt = now;
      event(s, now, actor, "control", `Note ${note.id} to ${st.id} not delivered: ${route.reason} ${who}: ${quote}`, t.id);
      break;
  }
  s.notes.push(note);
  pruneNotes(s);
  return { note, ...(rerunSuggested ? { rerunSuggested } : {}) };
}

/** At most 2,000 notes: settled notes of finished tasks go first, then other settled notes; a note still in flight goes only when nothing else is left. */
function pruneNotes(s: State) {
  if (s.notes.length <= MAX_NOTES) return;
  const settled = (n: Note) => n.status === "delivered" || n.status === "not-delivered";
  const finished = (n: Note) => {
    const t = s.tasks.find((x) => x.id === n.taskId);
    return !t || !isOpen(t);
  };
  const rank = (n: Note) => (settled(n) && finished(n) ? 0 : settled(n) ? 1 : 2);
  const order = s.notes.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i);
  const drop = new Set(order.slice(0, s.notes.length - MAX_NOTES).map((x) => x.n.id));
  s.notes = s.notes.filter((n) => !drop.has(n.id));
}

/**
 * Dispatch bound a new run to this step: the notes waiting for it go into the run's instructions. They
 * read "sending" until the service confirms the run started with them (`reportNoteOutcome`, via "start").
 */
export function bindQueuedNotes(s: State, t: Task, st: Step, a: Attempt, now: string) {
  for (const n of s.notes) {
    if (n.taskId !== t.id || n.stepId !== st.id || n.status !== "queued") continue;
    n.attemptId = a.id;
    n.status = "sending";
    n.via = "start";
    n.sentAt = now;
    event(s, now, "lead", "dispatch", `Note ${n.id} written into the instructions of ${a.id}`, t.id);
  }
}

/** Your direct note to a running agent step (any role but checks). Returns the note's id. */
export function sendNote(state: State, taskId: string, stepId: string, text: string, now: string): { state: State; noteId: string } {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Sending a note");
  const st = getStep(t, stepId);
  if (st.role === "checks") throw new ControlError("Check runs have no agent to read a note.");
  const checked = noteTextCheck(text, "user");
  if (!checked.ok) throw new ControlError(`The note was not sent: ${checked.why}.`);
  if (!activeAttempts(s, t.id).some((a) => a.stepId === st.id)) throw new ControlError(`${st.id} is not running; a note goes to a running step.`);
  const r = sendNoteInto(s, t, st, { text: checked.text, from: { by: "user" }, ifFinished: "report" }, now);
  if ("refused" in r) throw new ControlError(`The note was not sent: ${r.refused}.`);
  return { state: s, noteId: r.note.id };
}

/**
 * "Rerun with this note" on a draft state: the existing rerun rules decide, then the note (which reached no
 * agent) waits for the new run, and the row that suggested it counts as applied by the user. Returns why it
 * was left as is, or undefined when done.
 */
export function rerunWithNoteInto(s: State, t: Task, st: Step, noteId: string, now: string): string | undefined {
  const n = s.notes.find((x) => x.id === noteId);
  if (!n || n.taskId !== t.id || n.stepId !== st.id) return `${noteId} is not a note to ${t.id} ${st.id}`;
  if (n.status !== "not-delivered") return `the note is ${n.status}`;
  if (st.state !== "done") return `${st.id} has not completed`;
  rerunInto(s, t, st, now, "user", `with note ${n.id}`);
  n.status = "queued";
  delete n.attemptId;
  delete n.via;
  delete n.reason;
  delete n.sentAt;
  delete n.settledAt;
  for (const set of s.steering) {
    for (const c of set.changes) {
      if (c.noteId !== n.id || c.status !== "suggested") continue;
      c.status = "applied";
      c.appliedBy = "user";
      c.resolvedAt = now;
      delete c.note;
    }
  }
  event(s, now, "user", "control", `Note ${n.id} queued for the rerun of ${st.id}: "${short(n.text)}"`, t.id);
  return undefined;
}

/** The suggested rerun: rerun the finished step, with the note written into the new run's instructions. */
export function rerunWithNote(state: State, taskId: string, stepId: string, noteId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Rerunning");
  const why = rerunWithNoteInto(s, t, getStep(t, stepId), noteId, now);
  if (why) throw new ControlError(`Not rerun: ${why}.`);
  return s;
}

/**
 * The runtime's answer for one note (or the service's, for a note written into a run that started). A result
 * for another run, or for a note no longer waiting, changes nothing: stale-result protection. `simulated`:
 * the answer came from the fake runtime.
 */
export function reportNoteOutcome(state: State, e: { attemptId: string; noteId: string; outcome: "delivered" | "not-delivered"; reason?: string; heldForTurn?: true }, now: string, simulated?: true): State {
  const n0 = state.notes.find((x) => x.id === e.noteId);
  if (!n0 || n0.attemptId !== e.attemptId || n0.status !== "sending") return state;
  const s = draft(state);
  const n = s.notes.find((x) => x.id === e.noteId)!;
  n.status = e.outcome;
  n.settledAt = now;
  if (e.outcome === "not-delivered") n.reason = (e.reason?.replace(/\s+/g, " ").trim() || "the runtime did not take it").slice(0, 300);
  else delete n.reason;
  if (simulated) n.simulated = true;
  if (e.heldForTurn) n.heldForTurn = true;
  event(
    s,
    now,
    "runtime",
    "runtime",
    e.outcome === "delivered"
      ? `Note ${n.id} delivered to ${n.stepId}'s run ${n.attemptId}${n.via === "start" ? " at start" : ""}${n.heldForTurn ? ", held until the agent's turn began" : ""}`
      : `Note ${n.id} to ${n.stepId}'s run ${n.attemptId} not delivered: ${n.reason}`,
    n.taskId,
  );
  return s;
}

/** On a restart (or a new scheduler): a note left waiting for an answer gets none; it is never shown as delivered. */
export function reconcileNotes(state: State, now: string): State {
  if (!state.notes.some((n) => n.status === "sending")) return state;
  const s = draft(state);
  for (const n of s.notes) {
    if (n.status !== "sending") continue;
    n.status = "not-delivered";
    n.reason = "the service restarted before the runtime answered";
    n.settledAt = now;
    event(s, now, "system", "runtime", `Note ${n.id} to ${n.stepId}'s run ${n.attemptId} not delivered: ${n.reason}`, n.taskId);
  }
  return s;
}

export const noteOf = (s: State, id: string): Note | undefined => s.notes.find((n) => n.id === id);
/** Notes bound to a run, whatever their status, oldest first. */
export const notesOfRun = (s: State, attemptId: string): Note[] => s.notes.filter((n) => n.attemptId === attemptId);
/** Notes waiting for a step's next run. */
export const queuedNotes = (s: State, taskId: string, stepId: string): Note[] => s.notes.filter((n) => n.taskId === taskId && n.stepId === stepId && n.status === "queued");
/** Notes written into a run's instructions (for its envelope, before the run is confirmed started). */
export const notesAtStart = (s: State, attemptId: string): Note[] => s.notes.filter((n) => n.attemptId === attemptId && n.via === "start" && (n.status === "sending" || n.status === "delivered"));
/** Notes a run received: the delivered ones (downstream steps are shown these). */
export const notesReceived = (s: State, attemptId: string): Note[] => s.notes.filter((n) => n.attemptId === attemptId && n.status === "delivered");
/** Notes sent within the window (the lead's envelope lists the last 24 hours), oldest first. */
export function recentNotes(s: State, nowMs: number, windowMs = 24 * 60 * 60_000): Note[] {
  const since = new Date(nowMs - windowMs).toISOString();
  return s.notes.filter((n) => n.at >= since);
}

/**
 * Exactly what the agent reads: mid-run as a user message, or in the "Notes for this run" section of its envelope.
 * The acceptance sentence (ORC-028) follows a real run in which a note ("also say how many lines…") was followed and
 * the task's own acceptance criterion (name the files read) was dropped.
 */
export function noteMessage(n: Pick<Note, "text" | "from" | "at" | "sentAt">): string {
  const who = n.from.by === "lead" ? "Note from the lead, relaying the user" : "Note from the user";
  return `${who} (mid-run, ${n.sentAt ?? n.at}): ${n.text}\nThis is guidance within your current assignment; it does not change the specification. Apply it from now on, keep the work you have done unless the note says otherwise, and still meet everything the task asks for, including its acceptance criteria. Finish with the output block as instructed. If you had already finished, apply the note and give the output block again.`;
}
