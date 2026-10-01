// ORC-022: notes to a running stage, domain level. The lead's `steer.notes` entries (validation, who may
// send to what, the steering modes and held sets, the change-set rows without Undo), the user's direct note,
// the note's life (queued, sending, delivered via live or start, not delivered with a reason), reruns of a
// finished step, stale-result protection, restart reconciliation, caps and pruning, and the exact text an
// agent reads. Pure: no scheduler, no runtime.

import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildSeed } from "./seed";
import { ControlError, MAX_NOTES, MAX_NOTES_PER_RUN, type Note, type State, type SteeringMode } from "./types";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const seed = () => buildSeed(T0);
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const runOf = (s: State, id: string, stepId: string) => M.activeAttempts(s, id).find((a) => a.stepId === stepId)!;
const note = (s: State, id: string): Note => s.notes.find((n) => n.id === id)!;
const lastNote = (s: State): Note => s.notes[s.notes.length - 1];

/** A lead note entry in the output shape. */
const entry = (task: string, step: string, text = "Skip the README; the owner will write it.", ifFinished?: "report" | "rerun") => ({ task, step, text, ...(ifFinished ? { ifFinished } : {}) });

/** Post a message, start a message run and complete it with a steering block carrying `notes`. */
function steerNotes(s: State, notes: unknown, opts: { during?: (s: State) => State; simulated?: boolean; steer?: Record<string, unknown> } = {}) {
  let st = M.postMessage(s, "Tell the coder to skip the README", at(1));
  const r = M.startLeadRun(st, { provider: "claude", model: "m", trigger: "message" }, at(2));
  st = r.state;
  if (opts.during) st = opts.during(st);
  st = M.completeLeadRun(st, r.runId, { reply: "ok", proposals: [], steer: { reason: "You asked", tasks: [], notes, ...(opts.steer ?? {}) } }, at(3), opts.simulated ? { simulated: true } : {});
  return { state: st, set: st.steering.find((cs) => cs.leadRunId === r.runId)!, runId: r.runId };
}

/** Report a run as finished with every output its step declares. */
const complete = (s: State, attemptId: string, t: string) => {
  const a = s.attempts.find((x) => x.id === attemptId)!;
  const st = task(s, a.taskId).steps.find((x) => x.id === a.stepId)!;
  return M.reportCompletion(s, attemptId, [], t, st.outputs.map((o) => ({ name: o.name, summary: "test", ...(o.kind === "review-findings" ? { openFindings: 0 } : {}) })));
};

const withMode = (s: State, mode: SteeringMode) => M.setSteeringMode(s, mode, at(0));

describe("validation of the lead's notes entries", () => {
  it("accepts a well-formed note, folds it into one line, and defaults ifFinished to report", () => {
    const run = M.startLeadRun(M.postMessage(seed(), "hi", at(1)), { provider: "claude", model: "m", trigger: "message" }, at(2));
    const r = run.state.leadRuns.find((x) => x.id === run.runId)!;
    const v = M.validateSteer(run.state, r, { notes: [{ task: "EX-001", step: "S2", text: "  Skip the\nREADME;  the owner\twrites it. " }] });
    expect(v.noteItems).toEqual([{ ok: true, item: { task: "EX-001", step: "S2", text: "Skip the README; the owner writes it.", ifFinished: "report" } }]);
    expect(v.notes).toEqual([]);
  });

  it("rejects each bad entry on its own with a reason: text limits, control characters, ifFinished, ids, shape; the others still apply", () => {
    const { set, state: s } = steerNotes(seed(), [
      entry("EX-001", "S2", "x".repeat(501)),
      entry("EX-001", "S2", ""),
      entry("EX-001", "S2", "bad\u0007text"),
      { task: "EX-001", step: "S2", text: "ok", ifFinished: "later" },
      { task: "bad id!", step: "S2", text: "ok" },
      { task: "EX-001", step: 7, text: "ok" },
      "not an object",
      entry("EX-001", "S2", "Fine."),
    ]);
    // Only 3 are read: the cap applies before validation, and the rest are counted in one set-level note.
    expect(set.notes).toEqual(["5 more notes ignored: at most 3 notes in one reply"]);
    expect(set.changes.map((c) => [c.kind, c.status, c.note])).toEqual([
      ["note", "rejected", "text must be 1–500 characters, one paragraph"],
      ["note", "rejected", "text is empty"],
      ["note", "rejected", "text contains control characters"],
    ]);
    expect(s.notes).toEqual([]);
    const v = M.validateSteer(s, s.leadRuns[s.leadRuns.length - 1], {
      notes: [{ task: "EX-001", step: "S2", text: "ok", ifFinished: "later" }, { task: "bad id!", step: "S2", text: "ok" }, { task: "EX-001", step: 7, text: "ok" }],
    });
    expect(v.noteItems.map((x) => (x.ok ? "ok" : x.reason))).toEqual(['ifFinished must be "report" or "rerun"', "task must be 1–40 letters, digits, dots, dashes or underscores", "step must be 1–40 letters, digits, dots, dashes or underscores"]);
    const v2 = M.validateSteer(s, s.leadRuns[s.leadRuns.length - 1], { notes: "nope" });
    expect(v2.notes).toEqual(["notes ignored: not a list"]);
    expect(v2.noteItems).toEqual([]);
  });

  it("a rejected entry keeps what could be read of it on its row (task, step, a cleaned copy of the text)", () => {
    const { set } = steerNotes(seed(), [{ task: "EX-001", step: "S2", text: "keep\u0000this", ifFinished: 3 }]);
    expect(set.changes[0]).toMatchObject({ kind: "note", status: "rejected", taskId: "EX-001", stepId: "S2", after: "keepthis", note: "text contains control characters" });
    expect(set.changes[0].noteId).toBeUndefined();
  });

  it("planning runs cannot send notes: the whole block is refused", () => {
    const r = M.startLeadRun(seed(), { provider: "claude", model: "m", trigger: "planning" }, at(2));
    const s = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], steer: { notes: [entry("EX-001", "S2")] } }, at(3));
    expect(s.steering[0].refused).toBe("planning runs cannot steer");
    expect(s.notes).toEqual([]);
  });
});

describe("who may send a note to what", () => {
  const verdict = (s: State, id: string, stepId: string, mode: SteeringMode = "apply") => M.notePermission(s, task(s, id), task(s, id).steps.find((x) => x.id === stepId), mode);

  it("the lead may note coder and designer steps only: never a review, checks or lead step, a delivery task, a finished task, or an unknown step", () => {
    const s = seed();
    expect(verdict(s, "EX-001", "S2")).toEqual({ v: "apply" }); // coder
    expect(verdict(s, "EX-001", "S1")).toEqual({ v: "apply" }); // designer (routing decides it has finished)
    expect(verdict(s, "EX-002", "S2")).toEqual({ v: "reject", why: "S2 is a code reviewer step: notes go to coder and designer steps only" });
    expect(verdict(s, "EX-002", "SR1")).toEqual({ v: "reject", why: "SR1 is a security reviewer step: notes go to coder and designer steps only" });
    expect(verdict(s, "EX-001", "S4")).toEqual({ v: "reject", why: "S4 is a ux reviewer step: notes go to coder and designer steps only" });
    expect(verdict(s, "EX-002", "C1")).toEqual({ v: "reject", why: "C1 is a checks step: check runs have no agent" });
    expect(verdict(s, "EX-002", "S4")).toEqual({ v: "reject", why: "S4 is a lead step: notes go to coder and designer steps only" });
    expect(verdict(s, "EX-006", "S1")).toEqual({ v: "reject", why: "EX-006 is done" });
    expect(verdict(s, "EX-001", "nope")).toEqual({ v: "reject", why: "unknown step on EX-001" });
    expect(M.notePermission(s, undefined, undefined, "apply")).toEqual({ v: "reject", why: "unknown task" });
    const delivery = structuredClone(s);
    task(delivery, "EX-001").reviewTarget = { taskId: "EX-006", n: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40) };
    expect(verdict(delivery, "EX-001", "S2")).toEqual({ v: "reject", why: "delivery task: not steerable" });
  });

  it("through the reply: rejected entries become rejected rows with the reason, and nothing is sent to them", () => {
    const { set, state: s } = steerNotes(seed(), [entry("EX-002", "S2"), entry("EX-002", "C1"), entry("EX-006", "S1")]);
    expect(set.changes.map((c) => [c.taskId, c.stepId, c.status])).toEqual([
      ["EX-002", "S2", "rejected"],
      ["EX-002", "C1", "rejected"],
      ["EX-006", "S1", "rejected"],
    ]);
    expect(set.changes.map((c) => c.note)).toEqual(["S2 is a code reviewer step: notes go to coder and designer steps only", "C1 is a checks step: check runs have no agent", "EX-006 is done"]);
    expect(s.notes).toEqual([]);
  });

  it("a child task of a goal is allowed: the note is about the running stage; its root says whose task it is", () => {
    const s0 = seed();
    const s = structuredClone(s0);
    const child = structuredClone(task(s, "EX-001"));
    child.id = "EX-001.1";
    child.parentTaskId = "EX-001";
    s.tasks.push(child);
    expect(verdict(s, "EX-001.1", "S2")).toEqual({ v: "apply" });
    expect(verdict(s, "EX-001.1", "S2", "apply-own")).toEqual({ v: "apply" }); // the root is the lead's
    const { set } = steerNotes(s, [entry("EX-001.1", "S2")]);
    expect(set.changes[0]).toMatchObject({ kind: "note", status: "applied", taskId: "EX-001.1", stepId: "S2" });
  });

  it("the modes: apply sends; apply-own sends to the lead's own roots and suggests for yours; suggest only suggests", () => {
    const mine = M.createTask(seed(), { title: "Mine", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 4, holdBeforeStart: false, flowId: "change" }, at(0));
    const s = mine.state;
    for (const mode of ["apply", "apply-own", "suggest"] as const) {
      const own = verdict(withMode(s, mode), "EX-001", "S2", mode);
      const yours = verdict(withMode(s, mode), mine.newId, "S1", mode);
      expect(own).toEqual(mode === "suggest" ? { v: "suggest", why: "only suggest (Settings)" } : { v: "apply" });
      expect(yours).toEqual(mode === "apply" ? { v: "apply" } : mode === "apply-own" ? { v: "suggest", why: "your task: suggest-only (Settings)" } : { v: "suggest", why: "only suggest (Settings)" });
    }
    const { set, state: s2 } = steerNotes(withMode(s, "apply-own"), [entry("EX-001", "S2"), entry(mine.newId, "S1")]);
    expect(set.changes.map((c) => [c.taskId, c.status, c.note])).toEqual([
      ["EX-001", "applied", undefined],
      [mine.newId, "suggested", "your task: suggest-only (Settings)"],
    ]);
    expect(s2.notes).toHaveLength(1); // a suggested note is not sent and has no record yet
    expect(set.changes[1].noteId).toBeUndefined();
  });

  it("a held set (you wrote again while the lead worked) turns its notes into suggestions; Send applies them and sends the note", () => {
    const { set, state: s } = steerNotes(seed(), [entry("EX-001", "S2")], { during: (st) => M.postMessage(st, "wait, one more thing", at(2.5)) });
    expect(set.heldBecause).toMatch(/another message/);
    expect(set.changes[0]).toMatchObject({ kind: "note", status: "suggested", note: "held: newer direction" });
    expect(s.notes).toEqual([]);
    const r = M.applySteering(s, set.id, set.changes[0].id, at(10));
    expect(r.result).toEqual({ applied: [set.changes[0].id], left: [] });
    const row = r.state.steering[0].changes[0];
    expect(row).toMatchObject({ status: "applied", appliedBy: "user" });
    const n = note(r.state, row.noteId!);
    expect(n).toMatchObject({ taskId: "EX-001", stepId: "S2", status: "sending", via: "live", attemptId: runOf(s, "EX-001", "S2").id, from: { by: "lead", changeSetId: set.id, changeId: row.id } });
    // Applying again or dismissing a sent row leaves it alone.
    expect(M.applySteering(r.state, set.id, row.id, at(11)).result.left).toEqual([{ id: row.id, why: "already applied" }]);
  });

  it("Dismiss works on a suggested note; a later note to the same step supersedes it; task changes and notes never supersede each other", () => {
    const s0 = withMode(seed(), "suggest");
    const a = steerNotes(s0, [entry("EX-001", "S2")]);
    const dismissed = M.dismissSteering(a.state, a.set.id, a.set.changes[0].id, at(5));
    expect(dismissed.state.steering[0].changes[0].status).toBe("dismissed");
    // A suggested note, then a later reply with a note to the same step and a priority suggestion for the task.
    const b = steerNotes(a.state, [entry("EX-001", "S2", "Second thought.")], { steer: { tasks: [{ id: "EX-001", priority: 9, why: "x" }] } });
    expect(b.state.steering[0].changes[0].status).toBe("superseded");
    const c = steerNotes(a.state, [], { steer: { tasks: [{ id: "EX-001", priority: 9, why: "x" }] } });
    expect(c.state.steering[0].changes[0].status).toBe("suggested"); // a priority change is not the note's target
    const d = steerNotes(c.state, [entry("EX-001", "S2", "Third.")]);
    expect(d.state.steering[1].changes.find((x) => x.kind === "priority")!.status).toBe("suggested"); // a note is not the priority's target
  });

  it("a sent note has no Undo: a targeted undo says so, and Undo all skips it while undoing the rest", () => {
    const { set, state: s } = steerNotes(seed(), [entry("EX-001", "S2")], { steer: { tasks: [{ id: "EX-003", priority: 9, why: "x" }] } });
    const [prio, noteRow] = set.changes;
    expect(prio).toMatchObject({ kind: "priority", status: "applied" });
    expect(noteRow).toMatchObject({ kind: "note", status: "applied", appliedBy: "lead" });
    const one = M.undoSteering(s, set.id, noteRow.id, at(5));
    expect(one.result).toEqual({ undone: [], left: [{ id: noteRow.id, why: "a sent note cannot be unsent" }] });
    expect(one.state.steering[0].changes[1].note).toBeUndefined();
    const all = M.undoSteering(s, set.id, undefined, at(5));
    expect(all.result).toEqual({ undone: [prio.id], left: [] });
    expect(all.state.steering[0].changes[1]).toMatchObject({ status: "applied" });
    expect(note(all.state, noteRow.noteId!).status).toBe("sending");
  });
});

describe("the note's life", () => {
  it("a live run: the note is sending, bound to that run, until the runtime acknowledges it; the activity feed records it", () => {
    const s0 = seed();
    const run = runOf(s0, "EX-001", "S2");
    const { set, state: s } = steerNotes(s0, [entry("EX-001", "S2")]);
    const n = lastNote(s);
    expect(n).toMatchObject({ id: expect.stringMatching(/^note-\d+$/), taskId: "EX-001", stepId: "S2", attemptId: run.id, text: "Skip the README; the owner will write it.", status: "sending", via: "live", sentAt: at(3), at: at(3) });
    expect(n.from).toEqual({ by: "lead", leadRunId: set.leadRunId, changeSetId: set.id, changeId: set.changes[0].id, messageIds: set.messageIds });
    expect(set.changes[0]).toMatchObject({ kind: "note", status: "applied", appliedBy: "lead", noteId: n.id, after: n.text, before: null });
    expect(s.events.filter((e) => e.taskId === "EX-001").pop()!.message).toMatch(new RegExp(`Note ${n.id} sent to S2's run ${run.id} by lead from msg-\\d+: "Skip the README`));
    expect(s.events.find((e) => /steered from/.test(e.message))!.message).toMatch(/: 1 note\(s\) sent \(cs-/);
    // Delivered only on the acknowledgment.
    const d = M.reportNoteOutcome(s, { attemptId: run.id, noteId: n.id, outcome: "delivered" }, at(6));
    expect(note(d, n.id)).toMatchObject({ status: "delivered", via: "live", settledAt: at(6) });
    expect(note(d, n.id).reason).toBeUndefined();
    expect(d.events[d.events.length - 1].message).toBe(`Note ${n.id} delivered to S2's run ${run.id}`);
    // Or refused, with the runtime's reason.
    const nd = M.reportNoteOutcome(s, { attemptId: run.id, noteId: n.id, outcome: "not-delivered", reason: " no active turn " }, at(6));
    expect(note(nd, n.id)).toMatchObject({ status: "not-delivered", reason: "no active turn", settledAt: at(6) });
    expect(nd.events[nd.events.length - 1].message).toBe(`Note ${n.id} to S2's run ${run.id} not delivered: no active turn`);
    expect(note(M.reportNoteOutcome(s, { attemptId: run.id, noteId: n.id, outcome: "not-delivered" }, at(6)), n.id).reason).toBe("the runtime did not take it");
  });

  it("stale-result protection: an answer for another run, for a settled note, or for an unknown note changes nothing", () => {
    const s0 = seed();
    const { state: s } = steerNotes(s0, [entry("EX-001", "S2")]);
    const n = lastNote(s);
    expect(M.reportNoteOutcome(s, { attemptId: "run-999", noteId: n.id, outcome: "delivered" }, at(6))).toBe(s);
    expect(M.reportNoteOutcome(s, { attemptId: n.attemptId!, noteId: "note-999", outcome: "delivered" }, at(6))).toBe(s);
    const settled = M.reportNoteOutcome(s, { attemptId: n.attemptId!, noteId: n.id, outcome: "not-delivered", reason: "refused" }, at(6));
    expect(M.reportNoteOutcome(settled, { attemptId: n.attemptId!, noteId: n.id, outcome: "delivered" }, at(7))).toBe(settled);
    expect(note(settled, n.id).status).toBe("not-delivered");
  });

  it("a run that ends, stops, fails or is lost before the acknowledgment leaves its note not delivered, never delivered", () => {
    const s0 = seed();
    const run = runOf(s0, "EX-001", "S2");
    const { state: s } = steerNotes(s0, [entry("EX-001", "S2")]);
    const n = lastNote(s);
    expect(note(complete(s, run.id, at(5)), n.id)).toMatchObject({ status: "not-delivered", reason: "the run ended before the runtime answered" });
    const stopping = M.pauseTask(s, "EX-001", at(4));
    expect(note(M.acknowledgeStop(stopping, run.id, at(5)), n.id)).toMatchObject({ status: "not-delivered", reason: "the run stopped first" });
    expect(note(M.reportRunFailed(s, run.id, "crash", at(5)), n.id)).toMatchObject({ status: "not-delivered", reason: "the run ended before the runtime answered" });
    expect(note(M.reportRunLost(s, run.id, "gone", at(5)), n.id)).toMatchObject({ status: "not-delivered", reason: "the run was lost before the runtime answered" });
    // A note already delivered is untouched by the run's end.
    const delivered = M.reportNoteOutcome(s, { attemptId: run.id, noteId: n.id, outcome: "delivered" }, at(4));
    expect(note(complete(delivered, run.id, at(5)), n.id).status).toBe("delivered");
  });

  it("a restart: a note left sending gets no answer and is marked not delivered with that reason; the others are untouched", () => {
    const s0 = seed();
    const { state: s } = steerNotes(s0, [entry("EX-001", "S2")]);
    const sending = lastNote(s);
    const queued = M.sendNote(M.pauseTask(s, "EX-001", at(4)), "EX-001", "S2", "Queued one", at(5)).state; // the run is stopping: queued
    expect(lastNote(queued).status).toBe("queued");
    const r = M.reconcileNotes(queued, at(9));
    expect(note(r, sending.id)).toMatchObject({ status: "not-delivered", reason: "the service restarted before the runtime answered", settledAt: at(9) });
    expect(lastNote(r).status).toBe("queued");
    expect(M.reconcileNotes(r, at(10))).toBe(r);
  });

  it("a run that is stopping: the note is queued for the step's next run, and never resumes anything", () => {
    const s = M.pauseTask(seed(), "EX-001", at(1));
    const { state: s2 } = steerNotes(s, [entry("EX-001", "S2")]);
    expect(lastNote(s2).status).toBe("queued");
    expect(lastNote(s2).attemptId).toBeUndefined();
    expect(s2.events.filter((e) => e.taskId === "EX-001").pop()!.message).toMatch(/queued for S2's next run \(its run is stopping\)/);
    expect(task(s2, "EX-001").hold).toBe(true);
  });

  it("a step that has not started: queued, bound at dispatch as sending via start, and delivered at start once the service confirms the run started", () => {
    const s0 = M.startHeldTask(seed(), "EX-003", at(0));
    const { state: s } = steerNotes(s0, [entry("EX-003", "S1")]);
    const n = lastNote(s);
    expect(n).toMatchObject({ status: "queued" });
    expect(M.queuedNotes(s, "EX-003", "S1").map((x) => x.id)).toEqual([n.id]);
    const d = M.dispatchEligible(M.leadPromoteProposals(s, at(4)), at(4));
    const run = runOf(d, "EX-003", "S1");
    expect(run).toBeDefined();
    expect(note(d, n.id)).toMatchObject({ status: "sending", via: "start", attemptId: run.id, sentAt: at(4) });
    expect(M.notesAtStart(d, run.id).map((x) => x.id)).toEqual([n.id]);
    expect(d.events.some((e) => e.message === `Note ${n.id} written into the instructions of ${run.id}`)).toBe(true);
    const ok = M.reportNoteOutcome(d, { attemptId: run.id, noteId: n.id, outcome: "delivered" }, at(5));
    expect(note(ok, n.id)).toMatchObject({ status: "delivered", via: "start" });
    expect(ok.events[ok.events.length - 1].message).toBe(`Note ${n.id} delivered to S1's run ${run.id} at start`);
    expect(M.notesReceived(ok, run.id)).toHaveLength(1);
    // A note that reached a run is never re-sent: a rerun of the step starts without it.
    const done = complete(ok, run.id, at(6));
    const again = M.dispatchEligible(M.rerunStep(done, "EX-003", "S1", at(7)), at(8));
    const second = runOf(again, "EX-003", "S1");
    expect(second.id).not.toBe(run.id);
    expect(M.notesAtStart(again, second.id)).toEqual([]);
    expect(note(again, n.id)).toMatchObject({ status: "delivered", attemptId: run.id });
    // A start that fails settles the note as not delivered.
    const failed = M.reportRunFailed(d, run.id, "Could not start the run: no worktree", at(5));
    expect(note(failed, n.id)).toMatchObject({ status: "not-delivered", reason: "the run ended before the runtime answered" });
  });

  it("a paused task: the note is queued and the pause still wins (nothing is dispatched until you resume)", () => {
    const s0 = seed();
    expect(task(s0, "EX-005").hold).toBe(true); // a designer step, paused by the user
    const { state: s } = steerNotes(s0, [entry("EX-005", "S1")]);
    expect(lastNote(s)).toMatchObject({ status: "queued" });
    expect(s.events.filter((e) => e.taskId === "EX-005").pop()!.message).toMatch(/\(the task is paused\)/);
    const d = M.dispatchEligible(s, at(4));
    expect(M.activeAttempts(d, "EX-005")).toEqual([]);
    expect(task(d, "EX-005").hold).toBe(true);
    expect(lastNote(d).status).toBe("queued");
    const resumed = M.dispatchEligible(M.resumeTask(d, "EX-005", at(5)), at(6));
    expect(lastNote(resumed)).toMatchObject({ status: "sending", via: "start", attemptId: runOf(resumed, "EX-005", "S1").id });
  });

  it("a finished step: not delivered with the reason (report); a skipped or blocked step likewise", () => {
    const s0 = seed();
    const { set, state: s } = steerNotes(s0, [entry("EX-001", "S1")]); // the designer step is done
    expect(lastNote(s)).toMatchObject({ status: "not-delivered", reason: "S1 had finished", settledAt: at(3) });
    expect(lastNote(s).attemptId).toBeUndefined();
    expect(set.changes[0]).toMatchObject({ status: "applied", noteId: lastNote(s).id });
    expect(set.changes[0].rerun).toBeUndefined();
    const blocked = structuredClone(s0);
    step(blocked, "EX-003", "S1").state = "blocked";
    expect(lastNote(steerNotes(blocked, [entry("EX-003", "S1")]).state)).toMatchObject({ status: "not-delivered", reason: "S1 is blocked: its last run failed" });
    const skipped = structuredClone(s0);
    step(skipped, "EX-003", "S1").state = "skipped";
    expect(lastNote(steerNotes(skipped, [entry("EX-003", "S1")]).state)).toMatchObject({ status: "not-delivered", reason: "S1 was skipped" });
  });

  it("the per-reply and per-run caps: at most 3 notes in one reply and 10 for one run; the entry over the cap is rejected and the others apply", () => {
    let s = seed();
    const run = runOf(s, "EX-001", "S2");
    for (let i = 0; i < 9; i++) s = M.sendNote(s, "EX-001", "S2", `note ${i}`, at(1 + i)).state;
    expect(M.notesOfRun(s, run.id)).toHaveLength(9);
    const { set, state: s2 } = steerNotes(s, [entry("EX-001", "S2", "tenth"), entry("EX-001", "S2", "eleventh"), entry("EX-001", "S2", "twelfth"), entry("EX-001", "S2", "never read")]);
    expect(set.changes.map((c) => [c.status, c.note])).toEqual([
      ["applied", undefined],
      ["rejected", `at most ${MAX_NOTES_PER_RUN} notes for one run`],
      ["rejected", `at most ${MAX_NOTES_PER_RUN} notes for one run`],
    ]);
    expect(set.notes).toEqual(["1 more note ignored: at most 3 notes in one reply"]);
    expect(M.notesOfRun(s2, run.id)).toHaveLength(10);
    expect(() => M.sendNote(s2, "EX-001", "S2", "one more", at(20))).toThrow(/at most 10 notes for one run/);
    // The queued cap counts the notes waiting for the step's next run.
    let q = M.startHeldTask(seed(), "EX-003", at(0));
    for (let i = 0; i < 10; i++) q = steerNotes(q, [entry("EX-003", "S1", `queued ${i}`)]).state;
    expect(M.queuedNotes(q, "EX-003", "S1")).toHaveLength(10);
    expect(steerNotes(q, [entry("EX-003", "S1", "too many")]).set.changes[0]).toMatchObject({ status: "rejected", note: "at most 10 notes for one run" });
  });

  it("pruning: beyond 2,000 notes, settled notes of finished tasks go first, then other settled ones; notes in flight stay", () => {
    const s = structuredClone(seed());
    const mk = (i: number, taskId: string, status: Note["status"]): Note => ({ id: `note-x${i}`, taskId, stepId: "S1", text: "t", from: { by: "user" }, at: at(i), status });
    for (let i = 0; i < MAX_NOTES; i++) s.notes.push(mk(i, i % 2 ? "EX-006" : "EX-001", i % 3 ? "delivered" : "queued"));
    const { state: out } = steerNotes(s, [entry("EX-001", "S2", "the one that tips it over")]);
    expect(out.notes).toHaveLength(MAX_NOTES);
    const dropped = s.notes.find((n) => !out.notes.some((x) => x.id === n.id))!;
    expect(dropped).toMatchObject({ taskId: "EX-006", status: "delivered" }); // the oldest settled note of a done task
    expect(out.notes.filter((n) => n.status === "queued")).toHaveLength(s.notes.filter((n) => n.status === "queued").length);
  });

  it("the text an agent reads is exactly the framing from the spec, for the lead and for the user", () => {
    const lead: Pick<Note, "text" | "from" | "at" | "sentAt"> = { text: "Skip the README.", from: { by: "lead", leadRunId: "lead-1", changeSetId: "cs-lead-1", changeId: "cs-lead-1.1", messageIds: ["msg-1"] }, at: at(0), sentAt: at(2) };
    expect(M.noteMessage(lead)).toBe(
      `Note from the lead, relaying the user (mid-run, ${at(2)}): Skip the README.\nThis is guidance within your current assignment; it does not change the specification. Apply it from now on, keep the work you have done unless the note says otherwise, and finish with the output block as instructed. If you had already finished, apply the note and give the output block again.`,
    );
    expect(M.noteMessage({ text: "Use the helper.", from: { by: "user" }, at: at(0) })).toMatch(new RegExp(`^Note from the user \\(mid-run, ${at(0)}\\): Use the helper\\.\\n`));
  });

  it("the simulated flag: a note from the simulated lead carries it, and so does an acknowledgment from the fake runtime", () => {
    const sim = steerNotes(seed(), [entry("EX-001", "S2")], { simulated: true });
    const n = lastNote(sim.state);
    expect(n.simulated).toBe(true);
    const real = steerNotes(seed(), [entry("EX-001", "S2")]);
    const m = lastNote(real.state);
    expect(m.simulated).toBeUndefined();
    expect(note(M.reportNoteOutcome(real.state, { attemptId: m.attemptId!, noteId: m.id, outcome: "delivered" }, at(5)), m.id).simulated).toBeUndefined();
    expect(note(M.reportNoteOutcome(real.state, { attemptId: m.attemptId!, noteId: m.id, outcome: "delivered" }, at(5), true), m.id).simulated).toBe(true);
  });

  it("recent notes: the lead's envelope window is 24 hours", () => {
    const s = structuredClone(seed());
    s.notes.push({ id: "note-old", taskId: "EX-001", stepId: "S2", text: "old", from: { by: "user" }, at: new Date(T0 - 25 * 3600_000).toISOString(), status: "delivered" });
    s.notes.push({ id: "note-new", taskId: "EX-001", stepId: "S2", text: "new", from: { by: "user" }, at: new Date(T0 - 23 * 3600_000).toISOString(), status: "delivered" });
    expect(M.recentNotes(s, T0).map((n) => n.id)).toEqual(["note-new"]);
  });
});

describe("rerunning a finished step with a note", () => {
  /** EX-002's S1 (coder) is done and its downstream S2 is running: a rerun would discard started work. */
  const downstreamStarted = () => seed();
  /** A task whose coder step is done and nothing downstream has started. */
  const nothingDownstream = () => {
    const s0 = M.startHeldTask(seed(), "EX-003", at(0));
    const d = M.dispatchEligible(M.leadPromoteProposals(s0, at(1)), at(1));
    return complete(d, runOf(d, "EX-003", "S1").id, at(2));
  };

  it("ifFinished rerun, nothing downstream started: the step reruns with the note queued for the new run", () => {
    const s = nothingDownstream();
    expect(step(s, "EX-003", "S1").state).toBe("done");
    const { set, state: s2 } = steerNotes(s, [entry("EX-003", "S1", "Use the existing helper.", "rerun")]);
    expect(set.changes[0]).toMatchObject({ kind: "note", status: "applied", appliedBy: "lead", ifFinished: "rerun" });
    expect(step(s2, "EX-003", "S1").state).toBe("pending");
    expect(step(s2, "EX-003", "S2").state).toBe("pending"); // Investigation: S2 reviews S1's evidence and had not started
    expect(lastNote(s2)).toMatchObject({ status: "queued" });
    expect(s2.events.some((e) => e.taskId === "EX-003" && /Rerun S1 by lead \(with note note-\d+\)/.test(e.message))).toBe(true);
    const d = M.dispatchEligible(s2, at(10));
    expect(lastNote(d)).toMatchObject({ status: "sending", via: "start", attemptId: runOf(d, "EX-003", "S1").id });
  });

  it("ifFinished rerun, downstream started: a suggestion with the reason; the note is recorded as not delivered until you ask for the rerun", () => {
    const s = downstreamStarted();
    const { set, state: s2 } = steerNotes(s, [entry("EX-002", "S1", "Use the existing helper.", "rerun")]);
    const row = set.changes[0];
    expect(row).toMatchObject({ kind: "note", status: "suggested", rerun: true, ifFinished: "rerun", note: "S1 had finished; the rerun needs your go-ahead: C1, S2, SR1 already started on its result" });
    expect(note(s2, row.noteId!)).toMatchObject({ status: "not-delivered", reason: "S1 had finished" });
    expect(step(s2, "EX-002", "S1").state).toBe("done");
    // Rerun with this note: the existing rerun rules (downstream invalidated, its runs stopped), the note queued, the row applied by you.
    const r = M.rerunWithNote(s2, "EX-002", "S1", row.noteId!, at(10));
    expect(step(r, "EX-002", "S1").state).toBe("pending");
    expect(runOf(r, "EX-002", "S2").outcome).toBe("stopping");
    expect(note(r, row.noteId!).status).toBe("queued");
    expect(note(r, row.noteId!)).not.toHaveProperty("attemptId");
    expect(note(r, row.noteId!)).not.toHaveProperty("reason");
    expect(note(r, row.noteId!)).not.toHaveProperty("settledAt");
    expect(r.steering[0].changes[0]).toMatchObject({ status: "applied", appliedBy: "user", resolvedAt: at(10) });
    expect(r.steering[0].changes[0].note).toBeUndefined();
    // Send (applySteering) on the same row does the same thing.
    const viaApply = M.applySteering(s2, set.id, row.id, at(10));
    expect(viaApply.result.applied).toEqual([row.id]);
    expect(step(viaApply.state, "EX-002", "S1").state).toBe("pending");
  });

  it("ifFinished rerun on a paused task is a suggestion too; the rules of rerunWithNote are the task page's", () => {
    const s = M.pauseTask(nothingDownstream(), "EX-003", at(3));
    const { set, state: s2 } = steerNotes(s, [entry("EX-003", "S1", "x", "rerun")]);
    expect(set.changes[0]).toMatchObject({ status: "suggested", rerun: true, note: "S1 had finished; the rerun needs your go-ahead: the task is paused by you" });
    const id = set.changes[0].noteId!;
    expect(() => M.rerunWithNote(s2, "EX-003", "S1", "note-999", at(4))).toThrow(ControlError);
    expect(() => M.rerunWithNote(s2, "EX-003", "S2", id, at(4))).toThrow(/is not a note to EX-003 S2/);
    const sentOne = steerNotes(seed(), [entry("EX-001", "S2")]);
    expect(() => M.rerunWithNote(sentOne.state, "EX-001", "S2", lastNote(sentOne.state).id, at(4))).toThrow(/the note is sending/);
    const r = M.rerunWithNote(s2, "EX-003", "S1", id, at(4)); // paused: the step goes back to pending and waits for Resume
    expect(step(r, "EX-003", "S1").state).toBe("pending");
    expect(note(r, id).status).toBe("queued");
    expect(() => M.rerunWithNote(r, "EX-003", "S1", id, at(5))).toThrow(/the note is queued/);
  });

  it("the mode makes the rerun a suggestion too; Send then reruns when nothing downstream started", () => {
    const s = withMode(nothingDownstream(), "suggest");
    const { set, state: s2 } = steerNotes(s, [entry("EX-003", "S1", "x", "rerun")]);
    expect(set.changes[0]).toMatchObject({ status: "suggested", note: "only suggest (Settings)", ifFinished: "rerun" });
    expect(set.changes[0].rerun).toBeUndefined();
    expect(set.changes[0].noteId).toBeUndefined();
    const r = M.applySteering(s2, set.id, set.changes[0].id, at(5));
    expect(r.result.applied).toEqual([set.changes[0].id]);
    expect(step(r.state, "EX-003", "S1").state).toBe("pending");
    expect(lastNote(r.state)).toMatchObject({ status: "queued", from: { by: "lead" } });
    // With downstream started, Send records the note as not delivered and offers the rerun instead.
    const held = steerNotes(withMode(downstreamStarted(), "suggest"), [entry("EX-002", "S1", "x", "rerun")]);
    const rr = M.applySteering(held.state, held.set.id, held.set.changes[0].id, at(5));
    expect(rr.result.left).toEqual([{ id: held.set.changes[0].id, why: 'S1 had finished and C1, S2, SR1 already started on its result: use "Rerun with this note"' }]);
    expect(rr.state.steering[0].changes[0]).toMatchObject({ status: "suggested", rerun: true, noteId: expect.stringMatching(/^note-/) });
  });
});

describe("your direct note (sendNote)", () => {
  it("goes to any running agent step except checks, labelled from you, with the same limits", () => {
    const s0 = seed();
    const review = runOf(s0, "EX-002", "S2"); // a code reviewer: the lead may not, you may
    const r = M.sendNote(s0, "EX-002", "S2", "Please also check the retry path.\nThanks.", at(1));
    expect(note(r.state, r.noteId)).toMatchObject({ taskId: "EX-002", stepId: "S2", attemptId: review.id, status: "sending", via: "live", from: { by: "user" }, text: "Please also check the retry path. Thanks." });
    expect(r.state.events.filter((e) => e.taskId === "EX-002").pop()!.message).toMatch(/sent to S2's run run-\d+ by you: "Please also check/);
    expect(() => M.sendNote(s0, "EX-002", "C1", "x", at(1))).toThrow(/Check runs have no agent/);
    expect(() => M.sendNote(s0, "EX-003", "S1", "x", at(1))).toThrow(/S1 is not running/);
    expect(() => M.sendNote(s0, "EX-006", "S1", "x", at(1))).toThrow(/EX-006 is done/);
    expect(() => M.sendNote(s0, "EX-001", "S2", "   ", at(1))).toThrow(/text is empty/);
    expect(() => M.sendNote(s0, "EX-001", "S2", "x".repeat(501), at(1))).toThrow(/1–500 characters/);
    expect(() => M.sendNote(s0, "EX-001", "S2", "a\u0001b", at(1))).toThrow(/control characters/);
    expect(() => M.sendNote(s0, "nope", "S1", "x", at(1))).toThrow(ControlError);
  });

  it("your text is only folded into one line, never otherwise altered; the lead's loses invisible characters", () => {
    expect(M.noteTextCheck(" keep ​this  as\nis ", "user")).toEqual({ ok: true, text: "keep ​this as is" });
    expect(M.noteTextCheck(" strip ​this  as\nis ", "lead")).toEqual({ ok: true, text: "strip this as is" });
    expect(M.noteTextCheck(42, "user")).toEqual({ ok: false, why: "text must be text" });
  });
});
