// Steering by conversation, domain level. The permission matrix, strict validation of the
// lead's untrusted steering block, deferral (dispatch-only, never a hold), the derived priority tier,
// compare-and-set Undo/Apply/Dismiss, drop and reopen, message status, pins, and determinism.

import { describe, expect, it } from "vitest";
import * as M from "./model";
import { setPipeline } from "./testing/pipelines";
import { buildSeed } from "./seed";
import { ControlError, type Deferral, type LeadRun, type State, type SteerAction, type SteeringMode } from "./types";

const T0 = Date.parse("2026-09-29T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const seed = () => buildSeed(T0);
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const running = (s: State, id?: string) => M.activeAttempts(s, id);
const oneStep = [{ id: "S1", purpose: "Implement", role: "coder" as const, dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" as const }] }];

/** A user task with a one-step coder pipeline (proposed; `promote` makes it ready). */
function userTask(s: State, title: string, priority: number, over: Partial<Parameters<typeof M.createTask>[1]> = {}): { state: State; id: string } {
  const r = M.createTask(s, { title, area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority, holdBeforeStart: false, flowId: "change", ...over }, at(0));
  return { state: setPipeline(r.state, r.newId, 1, oneStep, "one step", "user", at(0)), id: r.newId };
}
const promote = (s: State) => M.leadPromoteProposals(s, at(0));

/** Report a run as finished with every output its step declares. */
const complete = (s: State, attemptId: string, t: string, findings?: number) => {
  const a = s.attempts.find((x) => x.id === attemptId)!;
  const st = task(s, a.taskId).steps.find((x) => x.id === a.stepId)!;
  return M.reportCompletion(s, attemptId, [], t, st.outputs.map((o) => ({ name: o.name, summary: "test", ...(o.kind === "review-findings" ? { openFindings: findings ?? 0 } : {}) })));
};

/** Write a deferral directly (tests of dispatch and presentation do not need a lead run). */
function deferred(s: State, id: string, by: Deferral["by"] = "lead"): State {
  const next = structuredClone(s);
  task(next, id).deferral = { by, at: at(0), reason: "test" };
  return next;
}

/** Post a message, start a message run and complete it with a steering block. */
function steerRun(s: State, steer: unknown, opts: { trigger?: "message" | "planning"; message?: string | false; during?: (s: State) => State; reply?: string; proposals?: M.LeadProposal[] } = {}) {
  let st = s;
  if (opts.message !== false) st = M.postMessage(st, opts.message ?? "Focus on local builds rather than deployment", at(1));
  const r = M.startLeadRun(st, { provider: "claude", model: "m", trigger: opts.trigger ?? (opts.message === false ? "planning" : "message") }, at(2));
  st = r.state;
  if (opts.during) st = opts.during(st);
  st = M.completeLeadRun(st, r.runId, { reply: opts.reply ?? "ok", proposals: opts.proposals ?? [], steer }, at(3));
  return { state: st, set: st.steering.find((cs) => cs.leadRunId === r.runId)!, runId: r.runId };
}

const messageRun: LeadRun = { id: "lead-x", trigger: "message", provider: "claude", model: "m", startedAt: at(0), outcome: "running", messageIds: ["msg-1"], visionRev: 1 };

describe("D1 permission matrix (steerPermission)", () => {
  const modes: SteeringMode[] = ["apply", "apply-own", "suggest"];
  const verdict = (s: State, id: string, action: SteerAction, mode: SteeringMode = "apply", value?: number) => M.steerPermission(s, task(s, id), action, mode, value);

  it("the lead's own unstarted proposal: everything applies, and only-suggest mode turns each into a suggestion", () => {
    const s = seed();
    for (const action of ["priority", "defer", "drop"] as const) {
      expect(verdict(s, "EX-003", action, "apply", 1)).toEqual({ v: "apply" });
      expect(verdict(s, "EX-003", action, "apply-own", 1)).toEqual({ v: "apply" });
      expect(verdict(s, "EX-003", action, "suggest", 1)).toEqual({ v: "suggest", why: "only suggest (Settings)" });
    }
  });

  it("the lead's own started task: priority and defer apply; a drop is only suggested", () => {
    const s = seed();
    expect(verdict(s, "EX-001", "priority", "apply", 3)).toEqual({ v: "apply" });
    expect(verdict(s, "EX-001", "defer")).toEqual({ v: "apply" });
    expect(verdict(s, "EX-001", "drop")).toEqual({ v: "suggest", why: "it has started; cancelling stops its work" });
  });

  it("a task the user touched: pins win over every mode, and the lead may not drop it", () => {
    const s = M.setPriority(seed(), "EX-003", 3, at(0));
    for (const mode of modes) expect(verdict(s, "EX-003", "priority", mode, 1)).toEqual({ v: "suggest", why: "you set P3" });
    expect(verdict(s, "EX-003", "drop")).toEqual({ v: "suggest", why: "you changed this task" });
    const pinned = M.setRunPin(seed(), "EX-003", true, at(0));
    for (const mode of modes) expect(verdict(pinned, "EX-003", "defer", mode)).toEqual({ v: "suggest", why: "you asked it to keep running" });
  });

  it("a user-created task: priority and defer apply in apply mode, are suggestions in apply-own, and it is never dropped", () => {
    const { state: s, id } = userTask(seed(), "Mine", 4);
    expect(verdict(s, id, "priority", "apply", 1)).toEqual({ v: "apply" });
    expect(verdict(s, id, "defer", "apply")).toEqual({ v: "apply" });
    expect(verdict(s, id, "priority", "apply-own", 1)).toEqual({ v: "suggest", why: "your task: suggest-only (Settings)" });
    expect(verdict(s, id, "defer", "apply-own")).toEqual({ v: "suggest", why: "your task: suggest-only (Settings)" });
    for (const mode of modes) expect(verdict(s, id, "drop", mode)).toEqual({ v: "suggest", why: "your task: only you cancel it" });
  });

  it("undefer: the lead's own deferral lifts in apply and apply-own; the user's deferral is only suggested", () => {
    const { state: s0, id } = userTask(seed(), "Mine", 4);
    const byLead = deferred(s0, id, "lead");
    expect(verdict(byLead, id, "undefer", "apply")).toEqual({ v: "apply" });
    expect(verdict(byLead, id, "undefer", "apply-own")).toEqual({ v: "apply" });
    expect(verdict(byLead, id, "undefer", "suggest")).toEqual({ v: "suggest", why: "only suggest (Settings)" });
    expect(verdict(deferred(s0, id, "user"), id, "undefer")).toEqual({ v: "suggest", why: "you deferred it" });
  });

  it("holds and failures keep the current value: paused by you, paused for review, control failure", () => {
    const s = seed();
    expect(verdict(s, "EX-005", "defer")).toEqual({ v: "skip", why: "paused by you" });
    const gated = structuredClone(s);
    task(gated, "EX-003").hold = true;
    task(gated, "EX-003").holdReason = "Review S1";
    expect(verdict(gated, "EX-003", "defer")).toEqual({ v: "skip", why: "paused for review" });
    const failing = structuredClone(s);
    task(failing, "EX-003").controlFailure = { at: at(0), message: "x" };
    expect(verdict(failing, "EX-003", "defer")).toEqual({ v: "skip", why: "needs your attention (control failure)" });
  });

  it("held before start: the priority applies but the hold is never released", () => {
    expect(verdict(seed(), "EX-004", "priority", "apply", 1)).toEqual({ v: "apply", note: "still waits for your go-ahead" });
  });

  it("the dependency guard keeps a prerequisite: EX-007 depends on EX-002", () => {
    const s = seed();
    expect(verdict(s, "EX-002", "defer")).toEqual({ v: "skip", why: "kept: EX-007 depends on it" });
    expect(verdict(s, "EX-002", "drop")).toEqual({ v: "skip", why: "kept: EX-007 depends on it" });
    // A dependent that is already deferred is already waiting: no guard.
    expect(verdict(deferred(s, "EX-007"), "EX-002", "defer")).toEqual({ v: "apply" });
  });

  it("children, done and cancelled tasks are not steerable; nothing-to-change is a no-op", () => {
    const s = structuredClone(seed());
    task(s, "EX-003").parentTaskId = "EX-004";
    expect(verdict(s, "EX-003", "priority", "apply", 1)).toEqual({ v: "reject", why: "child of EX-004: steer EX-004" });
    expect(verdict(s, "EX-006", "priority", "apply", 1)).toEqual({ v: "reject", why: "EX-006 is done" });
    const c = M.cancelTask(s, "EX-004", at(0));
    expect(verdict(c, "EX-004", "defer")).toEqual({ v: "reject", why: "EX-004 is cancelled" });
    expect(M.steerPermission(s, undefined, "defer", "apply")).toEqual({ v: "reject", why: "unknown task" });
    expect(verdict(s, "EX-005", "priority", "apply", 5)).toEqual({ v: "noop" });
    expect(verdict(deferred(seed(), "EX-003"), "EX-003", "defer")).toEqual({ v: "noop" });
    expect(verdict(seed(), "EX-003", "undefer")).toEqual({ v: "noop" });
  });
});

describe("D2 validateSteer is strict", () => {
  const s = seed();
  const v = (steer: unknown, run: LeadRun = messageRun) => M.validateSteer(s, run, steer);
  const reasons = (steer: unknown) => v(steer).items.map((i) => (i.ok ? "ok" : i.reason));

  it("refuses the whole block for planning runs, old runs, and non-objects", () => {
    expect(v({ tasks: [] }, { ...messageRun, messageIds: [] }).refused).toBe("planning runs cannot steer");
    expect(v({ tasks: [] }, { ...messageRun, visionRev: undefined }).refused).toBe("started before steering existed");
    for (const bad of [[], "steer", 7]) expect(v(bad).refused).toBe("the steering block was not an object");
  });

  it("rejects each bad item on its own with a specific reason", () => {
    expect(reasons({ tasks: [{ id: "EX-003", priority: 2.5 }, { id: "EX-003", priority: "1" }, { id: "EX-004", priority: 0 }, { id: "EX-005", priority: 100 }] })).toEqual(Array(4).fill("priority must be a whole number 1–99"));
    expect(reasons({ tasks: [{ id: "EX-003", priority: 1, defer: true }, { id: "EX-004" }] })).toEqual(["give exactly one of priority, defer, drop", "give exactly one of priority, defer, drop"]);
    expect(reasons({ tasks: [{ id: "EX-003", defer: true, why: "x".repeat(301) }] })).toEqual(["why must be text of at most 300 characters"]);
    expect(reasons({ tasks: [{ id: "EX 003", defer: true }, { id: "EX-003", defer: "yes" }, { id: "EX-004", drop: false }, 3] })).toEqual([
      "id must be 1–40 letters, digits, dots, dashes or underscores",
      "defer must be true or false",
      "drop must be true",
      "not an object",
    ]);
  });

  it("rejects a bad focus and ignores one equal to the current focus", () => {
    expect(v({ focus: "x".repeat(501) }).focus).toEqual({ ok: false, why: "focus must be 1–500 characters" });
    expect(v({ focus: 7 }).focus).toEqual({ ok: false, why: "focus must be text" });
    expect(v({ focus: "a\u0007b" }).focus).toEqual({ ok: false, why: "focus contains control characters" });
    expect(v({ focus: "ok\n\ttabs and newlines\n  collapse" }).focus).toEqual({ ok: true, value: "ok tabs and newlines collapse" });
    expect(v({ focus: M.currentVision(s).focus }).focus).toBeUndefined();
  });

  it("caps at 20 items, one per task, and defaults the reason", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `T-${i}`, defer: true }));
    const r = v({ tasks: many, reason: 42 });
    expect(r.items.filter((i) => i.ok)).toHaveLength(20);
    expect(r.items).toHaveLength(20); // the rest is one note, not one row each
    expect(r.notes).toContain("1 more entry ignored: at most 20 changes in one reply");
    expect(reasons({ tasks: [{ id: "EX-003", defer: true }, { id: "EX-003", priority: 1 }] })).toEqual(["ok", "one change per task per reply"]);
    expect(r.reason).toBe("From your message");
    expect(r.notes).toContain("reason ignored: not plain text of at most 500 characters");
    expect(v({ tasks: "EX-003" }).notes).toContain("tasks ignored: not a list");
  });
});

describe("D3 deferral is checked only by dispatch", () => {
  it("a deferred ready task is not dispatched; Run now lifts it and pins it to keep running", () => {
    let s = M.startHeldTask(seed(), "EX-004", at(0));
    s = deferred(s, "EX-004");
    s = M.dispatchEligible(s, at(1));
    expect(running(s, "EX-004")).toHaveLength(0);
    expect(() => M.undeferTask(s, "EX-003", at(2))).toThrow(/not deferred/);
    s = M.undeferTask(s, "EX-004", at(2));
    expect(task(s, "EX-004").deferral).toBeUndefined();
    expect(task(s, "EX-004").userSet?.run).toBe(at(2));
    s = M.dispatchEligible(s, at(3));
    expect(running(s, "EX-004")).toHaveLength(1);
  });

  it("a running coder step on a deferred task is never interrupted; its result is accepted and no next step starts", () => {
    let s = deferred(seed(), "EX-001");
    const [a] = running(s, "EX-001");
    expect(a.outcome).toBe("running"); // no requestStop
    s = M.dispatchEligible(s, at(1));
    expect(running(s, "EX-001")[0].outcome).toBe("running");
    s = complete(s, a.id, at(2));
    expect(s.attempts.find((x) => x.id === a.id)!.outcome).toBe("completed");
    expect(s.artifacts.some((x) => x.attemptId === a.id)).toBe(true);
    expect(task(s, "EX-001").hold).toBe(false);
    s = M.dispatchEligible(s, at(3));
    expect(running(s, "EX-001")).toHaveLength(0);
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Deferred by lead");
  });

  it("a deferred task whose last step completes still becomes Done and is queued for integration", () => {
    let { state: s, id } = userTask(seed(), "Last step", 1);
    s = M.dispatchEligible(promote(s), at(1));
    const [a] = running(s, id);
    s = deferred(s, id);
    s = complete(s, a.id, at(2));
    expect(task(s, id).lifecycle).toBe("done");
    expect(task(s, id).integration?.status).toBe("pending");
  });

  it("a deferred task whose remaining step is settled by skipping becomes Done through the finish branch", () => {
    // The check must sit after the finish branch and let a conditional step skip; in the top skip list this task would never finish.
    const steps = [
      { id: "S1", purpose: "Implement", role: "coder" as const, dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" as const }] },
      { id: "S2", purpose: "Review", role: "code_reviewer" as const, dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" as const }] },
      { id: "S3", purpose: "Repair", role: "coder" as const, dependsOn: ["S2"], inputs: [{ step: "S2", output: "findings" }], outputs: [{ name: "fix", kind: "code-change" as const }], runIf: [{ step: "S2", output: "findings" }] },
    ];
    // Room for every task: the finish branch is only reached while worker slots are free.
    const r0 = M.createTask(M.setWorkerLimit(seed(), 8, at(0)), { title: "Skip", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
    const r = { ...r0, state: setPipeline(r0.state, r0.newId, 1, steps, "custom", "user", at(0)) };
    let s = M.dispatchEligible(promote(r.state), at(1));
    s = complete(s, running(s, r.newId)[0].id, at(2));
    s = M.dispatchEligible(s, at(3));
    s = complete(s, running(s, r.newId)[0].id, at(4), 0);
    expect(task(s, r.newId).lifecycle).toBe("active");
    s = deferred(s, r.newId);
    s = M.dispatchEligible(s, at(5)); // S3 skipped: nothing to repair
    expect(task(s, r.newId).steps.find((x) => x.id === "S3")!.state).toBe("skipped");
    expect(running(s, r.newId)).toHaveLength(0);
    s = M.dispatchEligible(s, at(6)); // finish branch
    expect(task(s, r.newId).lifecycle).toBe("done");
  });

  it("a child of a deferred root is not dispatched, and holds leave the deferral in place", () => {
    let s = M.startHeldTask(seed(), "EX-004", at(0));
    s = structuredClone(s);
    task(s, "EX-004").parentTaskId = "EX-003";
    s = deferred(s, "EX-003");
    s = M.dispatchEligible(s, at(1));
    expect(running(s, "EX-004")).toHaveLength(0);
    expect(M.stateLabel(s, task(s, "EX-004"))).toBe("Deferred with EX-003");
    expect(() => M.undeferTask(s, "EX-004", at(2))).toThrow(/Deferred with EX-003: run EX-003 now instead/);
    s = M.pauseProject(s, at(2));
    s = M.resumeProject(s, at(3));
    expect(task(s, "EX-003").deferral).toBeDefined();
    s = M.pauseTask(s, "EX-003", at(4));
    s = M.resumeTask(s, "EX-003", at(5));
    expect(task(s, "EX-003").deferral).toBeDefined();
    s = M.startHeldTask(s, "EX-003", at(6));
    expect(task(s, "EX-003").deferral).toBeDefined();
    s = M.leadPromoteProposals(s, at(7));
    expect(task(s, "EX-003").lifecycle).toBe("proposed"); // a deferred proposal stays proposed
  });
});

describe("D4 presentation", () => {
  it("idle, running, inherited, held and dependent labels; BOARD_COLUMNS has deferred; deferred is never Paused", () => {
    const s0 = seed();
    const idle = deferred(M.startHeldTask(s0, "EX-004", at(0)), "EX-004");
    expect(M.column(idle, task(idle, "EX-004"))).toBe("deferred");
    expect(M.stateLabel(idle, task(idle, "EX-004"))).toBe("Deferred by lead");
    const byUser = deferred(s0, "EX-003", "user");
    expect(M.stateLabel(byUser, task(byUser, "EX-003"))).toBe("Deferred by you");
    const run = deferred(s0, "EX-001");
    expect(M.column(run, task(run, "EX-001"))).toBe("running");
    expect(M.stateLabel(run, task(run, "EX-001"))).toBe("Running · deferred after this step");
    const review = deferred(s0, "EX-002");
    expect(M.stateLabel(review, task(review, "EX-002"))).toBe("In review · deferred after this step");
    const both = deferred(s0, "EX-005");
    expect(M.stateLabel(both, task(both, "EX-005"))).toBe("Paused"); // the hold wins
    expect(M.stateLabel(review, task(review, "EX-007"))).toBe("Waiting on EX-002 (deferred)");
    expect(M.BOARD_COLUMNS).toContain("deferred");
    for (const t of idle.tasks) if (M.deferredBy(idle, t) && !t.hold) expect(M.stateLabel(idle, t)).not.toMatch(/Paused/);
  });
});

describe("D5 priority tier", () => {
  const setup = () => {
    let s = M.setWorkerLimit(seed(), 1, at(0));
    for (const t of s.tasks) s = t.lifecycle === "active" ? M.pauseTask(s, t.id, at(0)) : s;
    for (const a of running(s)) s = M.acknowledgeStop(s, a.id, at(0));
    const a = userTask(s, "Root A", 1);
    const b = userTask(a.state, "Root B", 2);
    const c = userTask(b.state, "Child of A", 5);
    s = structuredClone(promote(c.state));
    task(s, c.id).parentTaskId = a.id;
    task(s, a.id).lifecycle = "active";
    task(s, a.id).steps[0].waitForChildren = true; // the root waits for its child
    return { s, a: a.id, b: b.id, c: c.id };
  };

  it("unpinned children run at their root's tier; a pinned child keeps its own; untouched tasks keep their order", () => {
    const { s, b, c } = setup();
    expect(M.dispatchRank(s, task(s, c))).toEqual([1, 5]);
    const first = M.dispatchEligible(s, at(1));
    expect(running(first).map((x) => x.taskId)).toEqual([c]);
    const pinned = M.setPriority(s, c, 9, at(1));
    expect(M.dispatchRank(pinned, task(pinned, c))).toEqual([9, 9]);
    expect(running(M.dispatchEligible(pinned, at(2))).map((x) => x.taskId)).toEqual([b]);
  });
});

describe("D6 Undo is compare-and-set", () => {
  const applied = () => {
    const base = userTask(seed(), "Mine", 5);
    return steerRun(base.state, { focus: "Local first", reason: "you said so", tasks: [{ id: base.id, priority: 2, why: "fits" }, { id: "EX-003", defer: true, why: "not now" }, { id: "EX-004", drop: true, why: "no" }] });
  };

  it("restores every value in reverse order, pins each, and reports a second undo as already undone", () => {
    const { state: s, set } = applied();
    expect(set.changes.map((c) => c.status)).toEqual(["applied", "applied", "applied", "applied"]);
    const mine = set.changes[1].taskId!;
    const { state: u, result } = M.undoSteering(s, set.id, undefined, at(10));
    expect(result.undone).toEqual([...set.changes.map((c) => c.id)].reverse());
    expect(result.left).toEqual([]);
    expect(M.currentVision(u)).toMatchObject({ rev: 3, author: "user", focus: M.currentVision(s.project.visions.length ? { ...s, project: { ...s.project, visions: s.project.visions.slice(0, 1) } } : s).focus, source: { undoOf: set.id } });
    expect(task(u, mine)).toMatchObject({ priority: 5, userSet: { priority: at(10) } });
    expect(task(u, "EX-003").deferral).toBeUndefined();
    expect(task(u, "EX-003").userSet?.run).toBe(at(10));
    expect(task(u, "EX-004")).toMatchObject({ lifecycle: "ready", dropped: undefined, userSet: { run: at(10) } });
    const again = M.undoSteering(u, set.id, undefined, at(11));
    expect(again.result.undone).toEqual([]);
    expect(again.result.left.every((l) => l.why === "already undone")).toBe(true);
    // The lead cannot redo what the user reversed: the pins turn the same items into suggestions.
    const redo = steerRun(again.state, { tasks: [{ id: mine, priority: 2 }, { id: "EX-003", defer: true }, { id: "EX-004", drop: true }] }, { message: "again" });
    expect(redo.set.changes.map((c) => [c.status, c.note])).toEqual([
      ["suggested", "you set P5"],
      ["suggested", "you asked it to keep running"],
      ["suggested", "you changed this task"],
    ]);
  });

  it("a value the user changed since is left alone and noted; the focus is left once the vision moved", () => {
    const { state: s, set } = applied();
    const mine = set.changes[1].taskId!;
    let s2 = M.setPriority(s, mine, 7, at(5));
    s2 = M.editVision(s2, M.currentVision(s2).rev, "text", "Something else", "hand edit", at(6));
    const { state: u, result } = M.undoSteering(s2, set.id, undefined, at(10));
    expect(result.left).toEqual([
      { id: set.changes[1].id, why: "you changed it since (now P7)" },
      { id: set.changes[0].id, why: "the vision changed since (now r3)" },
    ]);
    expect(task(u, mine).priority).toBe(7);
    expect(u.steering[0].changes[1]).toMatchObject({ status: "applied", note: "left as is on undo: you changed it since (now P7)" });
    expect(M.currentVision(u).rev).toBe(3);
    const single = M.undoSteering(u, set.id, set.changes[0].id, at(11));
    expect(single.result.left).toEqual([{ id: set.changes[0].id, why: "the vision changed since (now r3)" }]);
    const notApplied = M.undoSteering(u, set.id, set.changes[2].id, at(12)); // undone above
    expect(notApplied.result.left).toEqual([{ id: set.changes[2].id, why: "already undone" }]);
  });
});

describe("D7 Apply and Dismiss", () => {
  const suggested = () => {
    const base = userTask(M.setSteeringMode(seed(), "suggest", at(0)), "Mine", 5);
    return steerRun(base.state, { focus: "Local first", tasks: [{ id: base.id, priority: 2, why: "fits" }, { id: "EX-003", defer: true, why: "later" }] });
  };

  it("an applied suggestion is the user's: the priority pins, the deferral is by the user, the focus is authored by the user", () => {
    const { state: s, set } = suggested();
    expect(set.changes.every((c) => c.status === "suggested")).toBe(true);
    const mine = set.changes[1].taskId!;
    const { state: a, result } = M.applySteering(s, set.id, undefined, at(10));
    expect(result.applied).toEqual(set.changes.map((c) => c.id));
    expect(M.currentVision(a)).toMatchObject({ author: "user", focus: "Local first", source: { changeSetId: set.id } });
    expect(a.steering[0].changes[0]).toMatchObject({ status: "applied", appliedBy: "user", visionRev: 2 });
    expect(task(a, mine)).toMatchObject({ priority: 2, userSet: { priority: at(10) } });
    expect(task(a, "EX-003").deferral).toMatchObject({ by: "user", changeSetId: set.id });
    expect(M.steerPermission(a, task(a, "EX-003"), "undefer", "apply")).toEqual({ v: "suggest", why: "you deferred it" });
  });

  it("applying after the value changed is left; dismiss marks the row; supersede follows the rules", () => {
    const { state: s, set } = suggested();
    const mine = set.changes[1].taskId!;
    const moved = M.setPriority(s, mine, 9, at(5));
    const { result } = M.applySteering(moved, set.id, set.changes[1].id, at(10));
    expect(result.left).toEqual([{ id: set.changes[1].id, why: "the priority changed since (now P9)" }]);
    const d = M.dismissSteering(s, set.id, set.changes[2].id, at(10));
    expect(d.state.steering[0].changes[2]).toMatchObject({ status: "dismissed", resolvedAt: at(10) });
    // A later set that targets the same task supersedes the old suggestion; other suggestions survive.
    const later = steerRun(s, { tasks: [{ id: mine, priority: 3 }] }, { message: "again" });
    const old = later.state.steering[0].changes;
    expect(old.map((c) => c.status)).toEqual(["suggested", "superseded", "suggested"]);
  });

  it("rows from a held set are superseded by the next completed message run", () => {
    const base = userTask(seed(), "Mine", 5);
    const held = steerRun(base.state, { focus: "Local first", tasks: [{ id: base.id, priority: 2 }] }, { during: (st) => M.postMessage(st, "wait, also…", at(2.5)) });
    expect(held.set.heldBecause).toMatch(/another message/);
    expect(held.set.changes.map((c) => c.status)).toEqual(["suggested", "suggested"]);
    expect(task(held.state, base.id).priority).toBe(5);
    expect(M.currentVision(held.state).rev).toBe(1);
    const next = steerRun(held.state, { tasks: [] }, { message: false, trigger: "message" }); // answers the pending message
    expect(next.state.steering[0].changes.map((c) => c.status)).toEqual(["superseded", "superseded"]);
  });
});

describe("D8 drop and reopen", () => {
  it("the lead drops its unstarted proposal and nothing else changes; Undo reopens it and pins it", () => {
    const before = seed();
    const { state: s, set } = steerRun(before, { tasks: [{ id: "EX-003", drop: true, why: "no longer fits" }] });
    expect(set.changes).toHaveLength(1);
    expect(task(s, "EX-003")).toMatchObject({ lifecycle: "cancelled", cancelledBy: "lead", dropped: { changeSetId: set.id, lifecycle: "proposed", at: at(3) } });
    expect(s.tasks.filter((t) => t.id !== "EX-003").map((t) => [t.lifecycle, t.priority, t.hold])).toEqual(before.tasks.filter((t) => t.id !== "EX-003").map((t) => [t.lifecycle, t.priority, t.hold]));
    expect(M.validateProposal(s, proposalTitled(M.currentSpec(task(s, "EX-003")).content.title), at(4))).toMatch(/dropped when the focus changed on 2026-09-29; the user can restore it/);
    expect(M.validateProposal(s, proposalTitled(M.currentSpec(task(s, "EX-003")).content.title), new Date(T0 + 8 * 24 * 3600_000).toISOString())).toBeUndefined();
    const { state: u } = M.undoSteering(s, set.id, undefined, at(10));
    expect(task(u, "EX-003")).toMatchObject({ lifecycle: "proposed", userSet: { run: at(10) } });
    expect(task(u, "EX-003").dropped).toBeUndefined();
  });

  it("reopen is refused when an open task with the same title exists since", () => {
    const { state: s, set } = steerRun(seed(), { tasks: [{ id: "EX-003", drop: true }] });
    const dup = userTask(s, M.currentSpec(task(s, "EX-003")).content.title, 3).state;
    const { state: u, result } = M.undoSteering(dup, set.id, undefined, at(10));
    expect(result.left).toEqual([{ id: set.changes[0].id, why: "a task with this title was created since" }]);
    expect(task(u, "EX-003").lifecycle).toBe("cancelled");
  });
});

function proposalTitled(title: string): M.LeadProposal {
  return {
    title,
    area: "x",
    whyNow: "",
    outcome: "o",
    benefit: "",
    scopeIncluded: [],
    scopeExcluded: [],
    options: [
      { id: "A", name: "a", approach: "a", benefit: "", effort: "", risks: "", reversibility: "" },
      { id: "B", name: "b", approach: "b", benefit: "", effort: "", risks: "", reversibility: "" },
    ],
    recommendedOptionId: "A",
    rationale: "r",
    uncertainty: "",
    acceptance: ["ok"],
    flowId: "change",
    priority: 3,
  };
}

describe("D9 messageStatus", () => {
  const nowMs = T0 + 60_000;
  const status = (s: State, m = s.conversation.filter((x) => x.author === "user").pop()!, blocked?: string) => M.messageStatus(s, m, { blocked, nowMs });

  it("answered, working, queued behind a reply, restarting, stopping planning (with the control failure), paused, blocked, starting", () => {
    let s = M.postMessage(seed(), "hi", at(1));
    expect(status(s).kind).toBe("starting");
    expect(status(s, undefined, "no repo").kind).toBe("blocked");
    expect(status(M.pauseProject(s, at(1))).kind).toBe("project-paused");
    const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(2));
    s = r.state;
    expect(status(s)).toMatchObject({ kind: "working" });
    s = M.postMessage(s, "and this", at(3));
    expect(status(s)).toMatchObject({ kind: "queued-behind-reply", text: "Queued behind the current reply." });
    s = M.stopLeadReply(s, at(4));
    expect(status(s, s.conversation[0])).toMatchObject({ kind: "restarting" });
    expect(status(s).kind).toBe("restarting");
    s = M.completeLeadRun(s, r.runId, { reply: "late", proposals: [] }, at(5)); // stopped: applies nothing
    expect(s.leadRuns[0].outcome).toBe("stopped");
    expect(M.pendingMessages(s)).toHaveLength(2);
    const r2 = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(6));
    s = M.completeLeadRun(r2.state, r2.runId, { reply: "done", proposals: [] }, at(7));
    expect(status(s, s.conversation[0]).kind).toBe("answered");
    // A planning run in progress is stopped by a message; the status says so and includes a control failure once it times out.
    let p = M.setAutonomy(seed(), { ...seed().project.autonomy, enabled: true }, at(0));
    const pr = M.startLeadRun(p, { provider: "claude", model: "m", trigger: "planning" }, at(1));
    p = M.postMessage(pr.state, "focus on X", at(2));
    expect(p.leadRuns[0].outcome).toBe("stopping");
    expect(status(p)).toMatchObject({ kind: "stopping-planning", text: "The planning run is stopping; the next lead run answers you." });
    p = M.reportLeadStopTimeout(p, pr.runId, at(30));
    expect(status(p).text).toMatch(/Control failure/);
    expect(() => M.stopLeadReply(p, at(31))).toThrow(ControlError);
  });

  it("retry-wait during the backoff, and after three failures until a new message", () => {
    let s = M.postMessage(seed(), "hi", at(1));
    for (let i = 0; i < 3; i++) {
      const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(2 + i));
      s = M.reportLeadFailed(r.state, r.runId, "rate limited", at(3 + i));
      const st = M.messageStatus(s, s.conversation[0], { nowMs: T0 + (3 + i) * 1000 + 1000 });
      expect(st.kind).toBe("retry-wait");
      expect(st.text).toMatch(i < 2 ? /retrying in about/ : /3 times in a row; send a new message/);
    }
    s = M.postMessage(s, "try again", at(20));
    expect(M.messageStatus(s, s.conversation[0], { nowMs: T0 + 21_000 }).kind).toBe("starting");
  });
});

describe("D10 determinism", () => {
  it("the same state and steer produce a byte-identical change set", () => {
    const base = userTask(seed(), "Mine", 5).state;
    const steer = { focus: "Local first", reason: "r", tasks: [{ id: "EX-003", defer: true, why: "a" }, { id: "EX-002", defer: true, why: "b" }, { id: "EX-004", drop: true }, { id: "nope", priority: 1 }, { id: "EX-006", priority: 2 }] };
    const a = steerRun(base, steer).set;
    const b = steerRun(base, steer).set;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.changes.map((c) => [c.kind, c.status, c.note])).toEqual([
      ["focus", "applied", undefined],
      ["defer", "applied", undefined],
      ["defer", "skipped", "kept: EX-007 depends on it"],
      ["drop", "applied", undefined],
      ["priority", "rejected", "unknown task"],
      ["priority", "rejected", "EX-006 is done"],
    ]);
  });
});

describe("Q. idempotency of the lead's changes", () => {
  it("a change set is applied once per run even if the run's outcome were replayed", () => {
    const { state: s, set, runId } = steerRun(seed(), { focus: "Local first", tasks: [{ id: "EX-003", priority: 1 }] });
    expect(M.currentVision(s).rev).toBe(2);
    // The run-outcome guard alone would let a stale replay apply again; the change-set id is the second guard.
    const replayed = structuredClone(s);
    replayed.leadRuns.find((r) => r.id === runId)!.outcome = "running";
    const again = M.completeLeadRun(replayed, runId, { reply: "again", proposals: [], steer: { focus: "Local first again", tasks: [{ id: "EX-003", priority: 2 }] } }, at(9));
    expect(again.steering).toHaveLength(1);
    expect(again.steering[0].id).toBe(set.id);
    expect(M.currentVision(again).rev).toBe(2);
    expect(task(again, "EX-003").priority).toBe(1);
  });
});

describe("D11 pins from commands", () => {
  it("setPriority pins; createTask pins only with priorityPinned; the pin commands toggle", () => {
    let s = M.setPriority(seed(), "EX-003", 2, at(0));
    expect(task(s, "EX-003").userSet?.priority).toBe(at(0));
    const plain = userTask(s, "Plain", 3);
    expect(task(plain.state, plain.id).userSet?.priority).toBeUndefined();
    const pinned = userTask(s, "Pinned", 3, { priorityPinned: true });
    expect(task(pinned.state, pinned.id).userSet?.priority).toBe(at(0));
    s = M.setPriorityPin(s, "EX-003", false, at(1));
    expect(task(s, "EX-003").userSet?.priority).toBeUndefined();
    s = M.setRunPin(s, "EX-003", true, at(2));
    expect(task(s, "EX-003").userSet?.run).toBe(at(2));
    s = M.setRunPin(s, "EX-003", false, at(3));
    expect(task(s, "EX-003").userSet?.run).toBeUndefined();
    expect(M.priorityProvenance(s, task(s, "EX-003"))).toEqual({ kind: "auto" });
    const led = steerRun(s, { tasks: [{ id: "EX-003", priority: 1 }] });
    expect(M.priorityProvenance(led.state, task(led.state, "EX-003"))).toEqual({ kind: "lead", was: 2, changeSetId: led.set.id, changeId: led.set.changes[0].id });
  });
});

// Harder cases: drops and their dependents, deferral, undo, the cap on entries and plain-text fields. The
// service's own review and fix tasks are covered in delivery.review3.test.ts and server/steering.test.ts; the
// confirmation dialog for a drop is UI-only.
describe("drops, deferral, undo and plain text", () => {
  it("a drop counts every open dependent, deferred or not, so it never leaves a task Blocked", () => {
    const base = userTask(seed(), "Mine", 5);
    const s = structuredClone(base.state);
    task(s, base.id).dependsOn = ["EX-003"];
    for (const tasks of [
      [{ id: "EX-003", drop: true }, { id: base.id, defer: true }],
      [{ id: base.id, defer: true }, { id: "EX-003", drop: true }],
    ]) {
      const r = steerRun(s, { tasks });
      const byTask = (id: string) => r.set.changes.find((c) => c.taskId === id)!;
      expect(byTask("EX-003")).toMatchObject({ kind: "drop", status: "skipped", note: `kept: ${base.id} depends on it` });
      expect(byTask(base.id)).toMatchObject({ kind: "defer", status: "applied" });
      expect(task(r.state, "EX-003").lifecycle).not.toBe("cancelled");
      expect(M.blockedReason(r.state, task(r.state, base.id))).toBeUndefined();
      expect(M.stateLabel(r.state, task(r.state, base.id))).not.toMatch(/Blocked/);
    }
    // Deferring the prerequisite once its dependent is deferred is still fine: nothing waits silently.
    const both = steerRun(s, { tasks: [{ id: base.id, defer: true }, { id: "EX-003", defer: true }] });
    expect(both.set.changes.map((c) => c.status)).toEqual(["applied", "applied"]);
  });

  it("a drop the user applied is an ordinary cancel; Undo says so instead of failing on reopen", () => {
    const r = steerRun(M.setSteeringMode(seed(), "suggest", at(0)), { tasks: [{ id: "EX-003", drop: true }] });
    expect(r.set.changes[0]).toMatchObject({ kind: "drop", status: "suggested" });
    const applied = M.applySteering(r.state, r.set.id, undefined, at(5));
    expect(applied.result.applied).toEqual([r.set.changes[0].id]);
    expect(task(applied.state, "EX-003")).toMatchObject({ lifecycle: "cancelled", cancelledBy: "user" });
    expect(task(applied.state, "EX-003").dropped).toBeUndefined();
    expect(applied.state.steering[0].changes[0]).toMatchObject({ status: "applied", appliedBy: "user" });
    const undo = M.undoSteering(applied.state, r.set.id, undefined, at(6));
    expect(undo.result).toEqual({ undone: [], left: [{ id: r.set.changes[0].id, why: "you cancelled it; a cancel cannot be undone" }] });
    expect(task(undo.state, "EX-003").lifecycle).toBe("cancelled");
  });

  it("a deferred root that finishes no longer defers its children, and finishing clears the deferral", () => {
    let s = structuredClone(seed());
    task(s, "EX-004").parentTaskId = "EX-003";
    s = deferred(s, "EX-003");
    expect(M.deferredBy(s, task(s, "EX-004"))?.task.id).toBe("EX-003");
    for (const lifecycle of ["done", "cancelled"] as const) {
      const fin = structuredClone(s);
      task(fin, "EX-003").lifecycle = lifecycle;
      expect(M.deferredBy(fin, task(fin, "EX-004"))).toBeUndefined();
      expect(M.stateLabel(fin, task(fin, "EX-004"))).not.toMatch(/Deferred/);
    }
    let { state: u, id } = userTask(seed(), "Last step", 1);
    u = M.dispatchEligible(promote(u), at(1));
    const [a] = running(u, id);
    u = deferred(u, id);
    u = complete(u, a.id, at(2));
    expect(task(u, id)).toMatchObject({ lifecycle: "done", deferral: undefined });
  });

  it("entries past the cap of 20 are one note, never one persisted row each", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `T-${i}`, defer: true }));
    const v = M.validateSteer(seed(), messageRun, { tasks: many });
    expect(v.items).toHaveLength(20);
    expect(v.notes).toEqual(["4980 more entries ignored: at most 20 changes in one reply"]);
    const r = steerRun(seed(), { tasks: many });
    expect(r.set.changes).toHaveLength(20);
    expect(r.set.notes).toEqual(["4980 more entries ignored: at most 20 changes in one reply"]);
  });

  it("a new project starts with no change sets, so old ones cannot rewrite its tasks", () => {
    const r = steerRun(buildSeed(T0, { inFlightRuns: false }), { focus: "Local first", tasks: [{ id: "EX-003", priority: 1 }] });
    expect(r.state.steering).toHaveLength(1);
    const fresh = M.initProject(r.state, { name: "New", repoPath: "/tmp/new", vision: "v", focus: "f" }, at(10));
    expect(fresh.steering).toEqual([]);
    expect(() => M.undoSteering(fresh, r.set.id, undefined, at(11))).toThrow(ControlError);
  });

  it("an undone focus change or undefer cannot be redone by the lead; it is only suggested", () => {
    const first = steerRun(seed(), { focus: "Local first", tasks: [] });
    expect(first.set.changes[0]).toMatchObject({ kind: "focus", status: "applied" });
    const undone = M.undoSteering(first.state, first.set.id, undefined, at(10)).state;
    expect(M.currentVision(undone)).toMatchObject({ rev: 3, author: "user" });
    const again = steerRun(undone, { focus: "Local first", tasks: [] }, { message: "again" });
    expect(again.set.changes).toEqual([expect.objectContaining({ kind: "focus", status: "suggested", note: "you undid this focus", after: "Local first" })]);
    expect(M.currentVision(again.state).rev).toBe(3);
    const other = steerRun(again.state, { focus: "Something else", tasks: [] }, { message: "other" });
    expect(other.set.changes[0]).toMatchObject({ kind: "focus", status: "applied" });
    expect(M.currentVision(other.state)).toMatchObject({ rev: 4, focus: "Something else" });
    // Undefer: Undo restores the deferral as the user's, so lifting it again is only suggested.
    const d = structuredClone(seed());
    task(d, "EX-003").deferral = { by: "lead", at: at(0), reason: "old focus", changeSetId: "cs-old" };
    const lifted = steerRun(d, { tasks: [{ id: "EX-003", defer: false }] });
    expect(lifted.set.changes[0]).toMatchObject({ kind: "undefer", status: "applied" });
    expect(task(lifted.state, "EX-003").deferral).toBeUndefined();
    const back = M.undoSteering(lifted.state, lifted.set.id, undefined, at(10)).state;
    expect(task(back, "EX-003").deferral).toMatchObject({ by: "user", reason: "old focus", changeSetId: "cs-old" });
    const redo = steerRun(back, { tasks: [{ id: "EX-003", defer: false }] }, { message: "again" });
    expect(redo.set.changes).toEqual([expect.objectContaining({ kind: "undefer", status: "suggested", note: "you deferred it" })]);
    expect(task(redo.state, "EX-003").deferral).toBeDefined();
  });

  it("focus, reason and why are one line of plain text: control characters are rejected, whitespace collapses", () => {
    const v = M.validateSteer(seed(), messageRun, {
      focus: "Local\n\nfirst,\tthen   deploy",
      reason: "because\u0007",
      tasks: [
        { id: "EX-003", defer: true, why: "w\u0000x" },
        { id: "EX-004", defer: true, why: "multi\nline  why" },
      ],
    });
    expect(v.focus).toEqual({ ok: true, value: "Local first, then deploy" });
    expect(v.reason).toBe("From your message");
    expect(v.notes).toContain("reason ignored: not plain text of at most 500 characters");
    expect(v.items).toEqual([
      { ok: false, kind: "defer", taskId: "EX-003", why: "wx", reason: "why contains control characters" },
      { ok: true, item: { id: "EX-004", action: "defer", why: "multi line why" } },
    ]);
    expect(M.validateSteer(seed(), messageRun, { reason: "one\nline\treason" }).reason).toBe("one line reason");
    expect(M.validateSteer(seed(), messageRun, { focus: "ok\u001b[31m" }).focus).toEqual({ ok: false, why: "focus contains control characters" });
    // Applied: the recorded focus, reason and deferral carry the single-line text.
    const r = steerRun(seed(), { focus: "Local\nfirst", reason: "you\nsaid", tasks: [{ id: "EX-003", defer: true, why: "not\nnow" }] });
    expect(M.currentVision(r.state).focus).toBe("Local first");
    expect(r.set.reason).toBe("you said");
    expect(task(r.state, "EX-003").deferral?.reason).toBe("not now");
  });
});

describe("superseding, Keep running and retries", () => {
  it("a refused set or a reply without a block decides nothing; only accepted rows supersede a target", () => {
    const held = steerRun(seed(), { tasks: [{ id: "EX-003", priority: 1 }] }, { during: (s) => M.postMessage(s, "newer", at(2)) });
    expect(held.set.heldBecause).toBeDefined();
    expect(held.set.changes[0].status).toBe("suggested");
    const refused = steerRun(held.state, 7, { message: "again" });
    expect(refused.set.refused).toBe("the steering block was not an object");
    expect(refused.state.steering[0].changes[0].status).toBe("suggested");
    const noBlock = steerRun(refused.state, undefined, { message: "and again" });
    expect(noBlock.state.steering[0].changes[0].status).toBe("suggested");
    const decided = steerRun(noBlock.state, { tasks: [] }, { message: "decide" });
    expect(decided.state.steering[0].changes[0].status).toBe("superseded");
    const sug = steerRun(M.setSteeringMode(seed(), "suggest", at(0)), { tasks: [{ id: "EX-003", priority: 1 }] });
    const rejectedOnly = steerRun(sug.state, { tasks: [{ id: "EX-003", priority: 0 }] }, { message: "bad" });
    expect(rejectedOnly.set.changes[0].status).toBe("rejected");
    expect(rejectedOnly.state.steering[0].changes[0].status).toBe("suggested");
    const accepted = steerRun(rejectedOnly.state, { tasks: [{ id: "EX-003", priority: 2 }] }, { message: "ok" });
    expect(accepted.state.steering[0].changes[0].status).toBe("superseded");
  });

  it("Keep running whatever the focus lifts the task's deferral", () => {
    const pinned = M.setRunPin(deferred(seed(), "EX-003"), "EX-003", true, at(1));
    expect(task(pinned, "EX-003").deferral).toBeUndefined();
    expect(task(pinned, "EX-003").userSet?.run).toBe(at(1));
  });

  it("a row applied on the retry pass loses its kept note; a repeated failed undo neither grows the note nor logs again", () => {
    const base = userTask(seed(), "Mine", 5);
    const s = structuredClone(base.state);
    task(s, base.id).dependsOn = ["EX-003"];
    const retried = steerRun(s, { tasks: [{ id: "EX-003", defer: true }, { id: base.id, defer: true }] });
    expect(retried.set.changes.map((c) => [c.status, c.note])).toEqual([["applied", undefined], ["applied", undefined]]);
    const r = steerRun(seed(), { tasks: [{ id: "EX-003", priority: 1 }] });
    const changed = M.setPriority(r.state, "EX-003", 7, at(5));
    const once = M.undoSteering(changed, r.set.id, undefined, at(6));
    expect(once.state.events.length).toBe(changed.events.length + 1);
    const twice = M.undoSteering(once.state, r.set.id, undefined, at(7));
    expect(twice.state.steering[0].changes[0].note).toBe("left as is on undo: you changed it since (now P7)");
    expect(twice.state.events.length).toBe(once.state.events.length);
  });
});
