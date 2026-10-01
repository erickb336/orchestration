// Changing a task's flow. Allowed before a task has run or once it is confirmed Paused; the pipeline
// starts over; earlier work stays on the record and is never reused; results from runs started before the
// change are discarded; their artifacts cannot be edited. Pure domain tests over a seed with every sample
// task held.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as F from "./findings";
import * as M from "./model";
import { flowSteps, setPipeline } from "./testing/pipelines";
import { builtInCatalog } from "./flows";
import { buildSeed } from "./seed";
import { StaleWriteError, type Finding, type State, type Task } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const builtIn = (id: string) => builtInCatalog().find((p) => p.id === id)!;
const pin = { provider: "claude" as const, model: "claude-sample-large" };

/** The seed with every sample task held, plus one task of yours from `flowId`. */
function withTask(flowId = "bugfix", over: Partial<M.NewTask> = {}): { s: State; id: string } {
  const s0 = buildSeed(T0, { inFlightRuns: false });
  for (const t of s0.tasks) t.hold = true;
  const r = M.createTask(s0, { title: "Mine", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId, ...over }, at(0));
  return { s: r.state, id: r.newId };
}

let n = 0;
function finding(over: Partial<Finding> = {}): Finding {
  n += 1;
  return { id: `F${n}`, key: `key${n}`.padEnd(12, "0"), source: "review", severity: "error", action: "auto-fix", title: `Finding ${n}`, detail: "what is wrong", ...over };
}

/** Promote and dispatch. */
const go = (s: State, t: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(t)), at(t));

/** Complete the one running attempt on a task, reporting every declared output (reviews with `findings`). */
function finish(s: State, id: string, t: number, o: { findings?: Finding[]; ref?: string } = {}): State {
  const [a] = running(s, id);
  const st = step(s, id, a.stepId);
  const outputs = st.outputs.map((d) => ({ name: d.name, summary: `${d.name} at ${t}`, ...(d.kind === "review-findings" ? (o.findings ? { findings: o.findings } : { openFindings: 0 }) : {}), ...(d.kind === "code-change" && o.ref ? { ref: o.ref } : {}) }));
  const done = M.reportCompletion(s, a.id, [], at(t), outputs, { usage: { inputTokens: 10, outputTokens: 5 } });
  return st.role === "code_reviewer" ? securityClean(done, id, t) : done;
}

/** The security review runs beside the code review. These tests are about the code review, so once it completes the security review is dispatched and completed clean. */
function securityClean(s: State, id: string, t: number): State {
  let next = M.dispatchEligible(s, at(t));
  for (const a of running(next, id)) if (step(next, id, a.stepId).role === "security_reviewer") next = M.reportCompletion(next, a.id, [], at(t), [{ name: "findings", summary: "no security findings", findings: [], openFindings: 0 }]);
  return next;
}

/** A Change task paused after S1 (coder) and S2 (review, with one ask-user finding) are done: checks are off, so C1 skipped. */
function pausedAfterReview(): { s: State; id: string; before: State } {
  let { s, id } = withTask("change");
  s = go(s, 1);
  expect(running(s, id)[0].stepId).toBe("S1");
  s = finish(s, id, 2, { ref: "abc123def456 on orchestration/run" });
  s = M.dispatchEligible(s, at(3)); // C1 skipped (checks off), S2 dispatched
  expect(step(s, id, "C1").state).toBe("skipped");
  expect(running(s, id)[0].stepId).toBe("S2");
  s = finish(s, id, 4, { findings: [finding({ action: "ask-user", why: "widens the task" })] });
  expect(s.decisions.filter((d) => d.taskId === id && d.status === "open")).toHaveLength(1);
  s = M.pauseTask(s, id, at(5));
  return { s, id, before: s };
}

describe("changeFlow before the task starts", () => {
  it("replaces the flow, records the revision with provenance, moves flowSince, and keeps only pins whose step keeps its role", () => {
    let { s, id } = withTask("bugfix");
    s = M.setStepSelection(s, id, "S1", pin, at(1)); // coder in both
    s = M.setStepSelection(s, id, "S2", pin, at(1)); // coder in Bug fix, reviewer in Change
    s = M.setStepSelection(s, id, "S4", pin, at(1)); // no S4 coder in Change (S4 is the lead's verification)
    const change = builtIn("change");
    const preview = M.flowChangePreview(s, task(s, id), change);
    expect(preview).toEqual({ allowed: true, redo: [], pinsKept: ["S1"], pinsDropped: [{ step: "S2", why: "role changed" }, { step: "S4", why: "role changed" }], artifactsKept: 0, decisionsClosed: 0 });
    const r = M.changeFlow(s, id, 1, "change", "simpler fix", at(2));
    const t = task(r, id);
    expect(t.steps.map((x) => x.id)).toEqual(change.steps.map((x) => x.id));
    expect(t.steps.every((x) => x.state === "pending")).toBe(true);
    // One above the revision each id had: pinning bumped S1, S2 and S4 to 2.
    expect(t.steps.map((x) => [x.id, x.revision])).toEqual([["S1", 3], ["C1", 2], ["S2", 3], ["SR1", 2], ["S3", 2], ["C2", 2], ["S4", 3]]);
    expect(step(r, id, "S1").selection).toEqual(pin);
    expect(step(r, id, "S2").selection).toBeNull();
    expect(step(r, id, "S4").selection).toBeNull();
    expect(t.pipelineRev).toBe(2);
    expect(t.flowSince).toBe(2);
    expect(t.flow).toEqual({ id: "change", name: "Change", source: "built-in", hash: change.hash, chosenBy: "user" });
    expect(t.pipelineHistory[1]).toMatchObject({ rev: 2, author: "user", reason: "Flow changed from Bug fix to Change: simpler fix", flow: { id: "change", hash: change.hash, chosenBy: "user" } });
    expect(t.pipelineHistory[1].steps.map((x) => x.id)).toEqual(change.steps.map((x) => x.id));
    expect(r.events.at(-1)!.message).toBe("Pipeline r2: flow Bug fix → Change; nothing had run; pins kept: S1; dropped: S2 (role changed), S4 (role changed)");
    // The command is the same operation, user-only, with an optional note.
    const c = runCommand(s, "changeFlow", { taskId: id, expectedRev: 1, flowId: "change" }, at(2)).state;
    expect(task(c, id).pipelineHistory[1].reason).toBe("Flow changed from Bug fix to Change");
    expect(() => runCommand(s, "changeFlow", { taskId: id, expectedRev: "1", flowId: "change" }, at(2))).toThrow(/expectedRev must be a number/);
  });

  it("the same flow with the same hash changes nothing; the same id with a newer hash is taken up", () => {
    const { s, id } = withTask("bugfix");
    const same = M.changeFlow(s, id, 1, "bugfix", "", at(2));
    expect(same).toBe(s);
    // The bugfix file changed and the service restarted (a newer hash): choosing it again applies the update.
    const edited = structuredClone(s);
    const p = edited.flows.find((x) => x.id === "bugfix")!;
    p.steps[0].purpose = "Reproduce it my way";
    p.hash = "f".repeat(64);
    const r = M.changeFlow(edited, id, 1, "bugfix", "", at(2));
    expect(task(r, id).pipelineRev).toBe(2);
    expect(task(r, id).flow).toMatchObject({ id: "bugfix", hash: "f".repeat(64), source: "built-in" });
    expect(step(r, id, "S1").purpose).toBe("Reproduce it my way");
  });
});

describe("refusals", () => {
  it("while a run is active, while pausing, and when blocked but not held", () => {
    let { s, id } = withTask("change");
    s = go(s, 1);
    expect(running(s, id)).toHaveLength(1);
    expect(() => M.changeFlow(s, id, 1, "bugfix", "", at(2))).toThrow(/Pause the task first; flows change only before a task starts or while it is paused/);
    expect(M.flowChangePreview(s, task(s, id), builtIn("bugfix"))).toMatchObject({ allowed: false, why: /Pause the task first/ });
    // Pausing: the hold is saved but the runtime has not confirmed the stop.
    const pausing = M.pauseTask(s, id, at(2));
    expect(running(pausing, id)[0].outcome).toBe("stopping");
    expect(() => M.changeFlow(pausing, id, 1, "bugfix", "", at(3))).toThrow(/Wait until it shows Paused\./);
    // Paused: the stop is acknowledged, so the change goes through and every step is paused.
    const paused = M.acknowledgeStop(pausing, running(pausing, id)[0].id, at(3));
    const r = M.changeFlow(paused, id, 1, "bugfix", "", at(4));
    expect(task(r, id).steps.every((x) => x.state === "paused")).toBe(true);
    expect(task(r, id).hold).toBe(true);
    // Blocked after a failed run, not held: still refused.
    const failed = M.reportRunFailed(s, running(s, id)[0].id, "boom", at(2));
    expect(step(failed, id, "S1").state).toBe("blocked");
    expect(() => M.changeFlow(failed, id, 1, "bugfix", "", at(3))).toThrow(/Pause the task first/);
  });

  it("done, cancelled, service-owned, a parent with open child tasks, a child moved to Goal, an internal flow, and a stale revision", () => {
    const { s, id } = withTask("change");
    expect(() => M.changeFlow(s, "EX-006", task(s, "EX-006").pipelineRev, "bugfix", "", at(1))).toThrow(/Done tasks keep the pipeline they ran\. Create a follow-up and choose its flow there\./);
    const cancelled = M.cancelTask(s, id, at(1));
    expect(() => M.changeFlow(cancelled, id, 1, "bugfix", "", at(2))).toThrow(new RegExp(`${id} is cancelled\\.`));
    const owned = structuredClone(s);
    task(owned, id).revertOf = { taskId: "EX-006", commit: "abc" };
    expect(() => M.changeFlow(owned, id, 1, "bugfix", "", at(2))).toThrow(/This task's pipeline is set by pull-request delivery\./);
    // A parent with an open child.
    const child = M.createTask(s, { title: "Child", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: [], priority: 2, holdBeforeStart: false, flowId: "change" }, at(1));
    const family = structuredClone(child.state);
    task(family, child.newId).parentTaskId = id;
    expect(() => M.changeFlow(family, id, 1, "bugfix", "", at(2))).toThrow(/It has child tasks; cancel them or let them finish first\./);
    const childGone = M.cancelTask(family, child.newId, at(2));
    expect(task(M.changeFlow(childGone, id, 1, "bugfix", "", at(3)), id).flow.id).toBe("bugfix");
    // A child task may not take a flow that breaks down.
    expect(() => M.changeFlow(family, child.newId, 1, "goal", "", at(2))).toThrow(/Goal breaks down into child tasks, which a child task cannot do\./);
    expect(task(M.changeFlow(family, child.newId, 1, "bugfix", "", at(2)), child.newId).flow.id).toBe("bugfix");
    // Internal and unknown flows use the creation messages.
    expect(() => M.changeFlow(s, id, 1, "revert", "", at(1))).toThrow(/The Revert flow is used by Send back only\./);
    expect(() => M.changeFlow(s, id, 1, "nope", "", at(1))).toThrow(/Unknown flow nope/);
    expect(() => M.changeFlow(s, id, 7, "bugfix", "", at(1))).toThrow(StaleWriteError);
  });

  it("the lead may choose any of the six, like you; a removed catalog entry is unknown to both; a child task never takes Goal", () => {
    const { s, id } = withTask("change");
    expect(() => M.changeFlow(s, id, 1, "change-best-of-two", "", at(1), "lead")).toThrow(/Unknown flow change-best-of-two/);
    expect(() => M.changeFlow(s, id, 1, "change-best-of-two", "", at(1))).toThrow(/Unknown flow change-best-of-two/);
    const byLead = M.changeFlow(s, id, 1, "feature", "", at(1), "lead");
    expect(task(byLead, id).flow).toMatchObject({ id: "feature", chosenBy: "lead" });
    expect(task(byLead, id).pipelineHistory[1].author).toBe("lead");
    const byYou = M.changeFlow(s, id, 1, "goal", "", at(1));
    expect(task(byYou, id).flow).toMatchObject({ id: "goal", chosenBy: "user" });
    const child = M.createTask(s, { title: "Child", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: [], priority: 2, holdBeforeStart: false, flowId: "change" }, at(1));
    const family = structuredClone(child.state);
    task(family, child.newId).parentTaskId = id;
    expect(() => M.changeFlow(family, child.newId, 1, "goal", "", at(2), "lead")).toThrow(/Goal breaks down into child tasks, which a child task cannot do\./);
    expect(M.flowChangePreview(family, task(family, child.newId), builtIn("goal"), "lead")).toMatchObject({ allowed: false, why: /which a child task cannot do/ });
    expect(task(M.changeFlow(family, child.newId, 1, "design", "", at(2), "lead"), child.newId).flow).toMatchObject({ id: "design", chosenBy: "lead" });
  });
});

describe("a fresh start while paused", () => {
  it("every new step is paused with a revision above every earlier one; decisions close; pending breakdowns clear; artifacts stay but are never consumed", () => {
    const { s: paused, id } = pausedAfterReview();
    const s0 = structuredClone(paused);
    task(s0, id).pendingBreakdowns = [{ stepId: "S2", output: "findings" }];
    task(s0, id).checkRounds = 1;
    task(s0, id).holdReason = "Review S2";
    // A pin on the pending S3 (a coder in Change) bumps it to revision 2; S3 is a reviewer in Bug fix, so the pin is dropped.
    const s1 = M.setStepSelection(s0, id, "S3", pin, at(5));
    expect(step(s1, id, "S3").revision).toBe(2);
    const beforeArts = s1.artifacts.filter((a) => a.taskId === id).map((a) => a.id);
    expect(beforeArts.length).toBeGreaterThan(0);

    const preview = M.flowChangePreview(s1, task(s1, id), builtIn("bugfix"));
    expect(preview).toMatchObject({ allowed: true, redo: ["S1", "C1", "S2", "SR1"], pinsKept: [], pinsDropped: [{ step: "S3", why: "role changed" }], artifactsKept: beforeArts.length, decisionsClosed: 1 });
    const r = M.changeFlow(s1, id, task(s1, id).pipelineRev, "bugfix", "", at(6));
    const t = task(r, id);
    expect(t.hold).toBe(true);
    expect(t.lifecycle).toBe("active");
    expect(t.steps.every((x) => x.state === "paused" && x.selection === null)).toBe(true);
    expect(step(r, id, "S1").revision).toBe(2); // above the attempt's 1
    expect(step(r, id, "S2").revision).toBe(2); // above the attempt on the old S2
    expect(step(r, id, "C1").revision).toBe(2);
    expect(step(r, id, "S3").revision).toBe(3); // above the pinned step's 2
    expect(step(r, id, "S5").revision).toBe(1); // new id
    expect(t.flowSince).toBe(t.pipelineRev);
    expect(t.pendingBreakdowns).toBeUndefined();
    expect(t.checkRounds).toBeUndefined();
    expect(t.holdReason).toBeUndefined();
    expect(r.decisions.filter((d) => d.taskId === id).map((d) => [d.status, d.why])).toEqual([["superseded", "the task's flow changed"]]);
    expect(r.artifacts.filter((a) => a.taskId === id).map((a) => a.id)).toEqual(beforeArts);
    expect(r.events.at(-1)!.message).toMatch(/^Pipeline r\d+: flow Change → Bug fix; 4 completed steps start over; dropped: S3 \(role changed\)$/);
    // Resume: the new S1 runs with no inputs; the new S2 (the fix) reads only the new S1's reproduction.
    let next = M.resumeTask(r, id, at(7));
    next = M.dispatchEligible(next, at(8));
    const s1run = running(next, id)[0];
    expect(s1run.stepId).toBe("S1");
    expect(s1run.snapshot).toMatchObject({ pipelineRev: t.pipelineRev, stepRev: 2, inputs: [], role: "coder" });
    next = finish(next, id, 9);
    next = M.dispatchEligible(next, at(10));
    const s2run = running(next, id)[0];
    expect(s2run.stepId).toBe("S2");
    const repro = next.artifacts.find((a) => a.attemptId === s1run.id)!;
    expect(repro).toMatchObject({ name: "reproduction", version: 1, pipelineRev: t.pipelineRev });
    expect(s2run.snapshot.inputs).toEqual([{ step: "S1", output: "reproduction", artifactId: repro.id, version: 1 }]);
    expect(s2run.snapshot.inputs.some((i) => beforeArts.includes(i.artifactId))).toBe(false);
    expect(M.fromEarlierFlow(next, task(next, id), repro)).toBe(false);
    expect(beforeArts.every((aid) => M.fromEarlierFlow(next, task(next, id), next.artifacts.find((a) => a.id === aid)!))).toBe(true);
  });

  it("a result from a run started before the change is discarded and its step untouched, on completion and on failure", () => {
    const { s: paused, id } = pausedAfterReview();
    const changed = M.changeFlow(paused, id, task(paused, id).pipelineRev, "bugfix", "", at(6));
    const old = changed.attempts.find((a) => a.taskId === id && a.stepId === "S1")!;
    expect(old.snapshot.pipelineRev).toBeLessThan(task(changed, id).flowSince);
    // State surgery standing in for a regression elsewhere: the earlier run is active again.
    const forced = structuredClone(changed);
    const a = forced.attempts.find((x) => x.id === old.id)!;
    a.outcome = "running";
    delete a.endedAt;
    const artsBefore = forced.artifacts.length;
    const done = M.reportCompletion(forced, old.id, [], at(7), [{ name: "change", summary: "late", ref: "fff" }, { name: "handoff", summary: "late" }]);
    expect(done.attempts.find((x) => x.id === old.id)).toMatchObject({ outcome: "discarded", note: "Result from before the flow changed (pipeline r1); not integrated", endedAt: at(7) });
    expect(step(done, id, "S1")).toMatchObject({ state: "paused", revision: 2 });
    expect(done.artifacts).toHaveLength(artsBefore);
    expect(done.events.at(-1)!.message).toMatch(/finished on pipeline r1, before the flow changed \(r2\); result discarded, not integrated/);
    const failed = M.reportRunFailed(forced, old.id, "boom", at(7));
    expect(failed.attempts.find((x) => x.id === old.id)).toMatchObject({ outcome: "discarded", note: "Result from before the flow changed (pipeline r1); not integrated; it failed: boom" });
    expect(step(failed, id, "S1").state).toBe("paused");
    expect(step(failed, id, "S1").blockedReason).toBeUndefined();
  });

  it("an artifact from before the change cannot be edited, with or without its own revision stamp; new work can", () => {
    const { s: paused, id } = pausedAfterReview();
    const changed = M.changeFlow(paused, id, task(paused, id).pipelineRev, "bugfix", "", at(6));
    const old = changed.artifacts.find((a) => a.taskId === id && a.stepId === "S1" && a.name === "change")!;
    expect(old.pipelineRev).toBe(1);
    const refusal = /This artifact belongs to an earlier flow of this task\. It is kept for the record and cannot be edited\./;
    expect(() => M.editArtifact(changed, old.id, { summary: "edited", reason: "r" }, at(7))).toThrow(refusal);
    expect(() => runCommand(changed, "editArtifact", { artifactId: old.id, summary: "edited", reason: "r" }, at(7))).toThrow(refusal);
    // An older artifact without the stamp takes its revision from its attempt's snapshot.
    const unstamped = structuredClone(changed);
    for (const a of unstamped.artifacts) delete a.pipelineRev;
    expect(M.artifactPipelineRev(unstamped, unstamped.artifacts.find((a) => a.id === old.id)!)).toBe(1);
    expect(() => M.editArtifact(unstamped, old.id, { summary: "edited", reason: "r" }, at(7))).toThrow(refusal);
    // An older edit of it (no attempt) takes its revision from the version it edited.
    const withEdit = structuredClone(unstamped);
    withEdit.artifacts.push({ ...old, id: "art-edit", attemptId: "edit", author: "user", version: old.version + 1, pipelineRev: undefined });
    expect(M.artifactPipelineRev(withEdit, withEdit.artifacts.find((a) => a.id === "art-edit")!)).toBe(1);
    expect(() => M.editArtifact(withEdit, "art-edit", { summary: "edited", reason: "r" }, at(7))).toThrow(refusal);
    // Work under the new flow is editable as before.
    let next = M.resumeTask(changed, id, at(7));
    next = M.dispatchEligible(next, at(8));
    next = finish(next, id, 9);
    const fresh = next.artifacts.find((a) => a.taskId === id && a.stepId === "S1" && a.name === "reproduction")!;
    expect(fresh.pipelineRev).toBe(task(next, id).pipelineRev);
    const edited = M.editArtifact(next, fresh.id, { summary: "edited", reason: "r" }, at(10));
    expect(edited.artifacts.at(-1)).toMatchObject({ author: "user", name: "reproduction", version: 2, pipelineRev: task(edited, id).pipelineRev });
  });

  it("a task from before flows (flowSince 0) is never guarded: its late results and edits work as before", () => {
    const { s: paused, id } = pausedAfterReview();
    const legacy = structuredClone(paused);
    task(legacy, id).flowSince = 0;
    task(legacy, id).flow = { id: "change", name: "Change", source: "legacy", chosenBy: "migration" };
    const old = legacy.artifacts.find((a) => a.taskId === id && a.stepId === "S1" && a.name === "change")!;
    expect(M.fromEarlierFlow(legacy, task(legacy, id), old)).toBe(false);
    expect(M.editArtifact(legacy, old.id, { summary: "edited", reason: "r" }, at(7)).artifacts.at(-1)).toMatchObject({ author: "user" });
  });
});

describe("decisions, child tasks, late stops and loop ids across a change", () => {
  const titleOf = (c: Task) => M.currentSpec(c).content.title;

  it("a decision taken under the earlier flow is not carried into the new flow's review, and a decision the change closed cannot be decided", () => {
    const { s: paused, id } = pausedAfterReview();
    const open = paused.decisions.find((d) => d.taskId === id && d.status === "open")!;
    // (a) Decided before the change: accepted. Under Bug fix, the review reports the same finding key again.
    const accepted = F.decideFinding(paused, open.id, "accept", "fine as is", at(5));
    const changed = M.changeFlow(accepted, id, task(accepted, id).pipelineRev, "bugfix", "", at(6));
    expect(changed.decisions.find((d) => d.id === open.id)!.status).toBe("accept");
    expect(F.earlierDecision(changed, task(changed, id), open.key)).toBeUndefined();
    let next = M.resumeTask(changed, id, at(7));
    next = M.dispatchEligible(next, at(8));
    expect(running(next, id)[0].stepId).toBe("S1");
    next = finish(next, id, 9);
    next = M.dispatchEligible(next, at(10));
    expect(running(next, id)[0].stepId).toBe("S2");
    next = finish(next, id, 11, { ref: "0123456789ab on orchestration/run" });
    next = M.dispatchEligible(next, at(12)); // C1 skipped (checks off), S3 reviews
    expect(running(next, id)[0].stepId).toBe("S3");
    next = finish(next, id, 13, { findings: [finding({ key: open.key, action: "ask-user", why: "widens the task" })] });
    const fresh = next.decisions.filter((d) => d.taskId === id && d.key === open.key && d.id !== open.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ status: "open" }); // not "decided as before"
    expect(fresh[0].carriedFrom).toBeUndefined();
    expect(F.settledByKey(next, task(next, id), finding({ key: open.key }))).toBe(false);
    expect(next.events.some((e) => e.taskId === id && /decided as before/.test(e.message))).toBe(false);
    // (b) Left open at the change: closed as superseded, and no longer decidable; the message says why.
    const closed = M.changeFlow(paused, id, task(paused, id).pipelineRev, "bugfix", "", at(6));
    expect(closed.decisions.find((d) => d.id === open.id)!.status).toBe("superseded");
    const refusal = /belongs to an earlier flow of T-\d+: it was closed when the flow changed and cannot be decided/;
    expect(() => F.decideFinding(closed, open.id, "accept", "late", at(7))).toThrow(refusal);
    expect(() => F.decideFinding(closed, open.id, "reopen", undefined, at(7))).toThrow(refusal);
    // A superseded decision of the current flow (an artifact replaced by a newer run) is untouched by this rule.
    const sup = structuredClone(paused);
    const d0 = sup.decisions.find((d) => d.id === open.id)!;
    d0.status = "superseded";
    expect(() => F.decideFinding(sup, open.id, "reopen", undefined, at(7))).not.toThrow();
  });

  it("child tasks of a breakdown made under the earlier flow are the record: never relinked, never waited for, and told apart", () => {
    let { s, id } = withTask("goal");
    // Step-by-step review (on a custom copy of the Goal steps) holds the task after the plan, before its children exist.
    s = setPipeline(s, id, 1, flowSteps("goal"), "custom goal", "user", at(0));
    s = M.setReviewEveryStep(s, id, true, at(0));
    s = go(s, 1);
    expect(running(s, id)[0].stepId).toBe("S1");
    const items = (titles: string[]) => titles.map((title) => ({ title, outcome: `${title} is done`, approach: "do it", acceptance: ["ok"], flowId: "change" }));
    s = M.reportCompletion(s, running(s, id)[0].id, [], at(2), [{ name: "plan", summary: "two parts", items: items(["Part one", "Part two"]) }]);
    // The review hold keeps the task; the children are created when you resume.
    expect(task(s, id).hold).toBe(true);
    expect(M.childTasks(s, task(s, id))).toHaveLength(0);
    s = M.resumeTask(s, id, at(3));
    s = M.setReviewEveryStep(s, id, false, at(3));
    const first = M.childTasks(s, task(s, id));
    expect(first.map(titleOf)).toEqual(["Part one", "Part two"]);
    const plan1 = s.artifacts.find((a) => a.taskId === id && a.name === "plan")!;
    expect(first.every((c) => c.parentArtifactId === plan1.id)).toBe(true);
    // Both children finish (with delivery off, a done child is a ready prerequisite); S2 has not started.
    s = structuredClone(s);
    for (const c of first) task(s, c.id).lifecycle = "done";
    expect(M.childrenSettled(s, task(s, id))).toBe(true);
    s = M.pauseTask(s, id, at(4));
    expect(running(s, id)).toHaveLength(0);
    const changed = M.changeFlow(s, id, task(s, id).pipelineRev, "goal", "", at(5));
    const t = task(changed, id);
    expect(first.every((c) => M.childFromEarlierFlow(changed, t, task(changed, c.id)))).toBe(true);
    expect(M.currentChildren(changed, t)).toEqual([]);
    expect(M.childrenSettled(changed, t)).toBe(true); // nothing of the current flow to wait for
    // Resume: the new S1 plans again. A title from before is not relinked; it is refused as an existing task. New titles become new children.
    let next = M.resumeTask(changed, id, at(6));
    next = M.dispatchEligible(next, at(7));
    expect(running(next, id)[0].stepId).toBe("S1");
    next = M.reportCompletion(next, running(next, id)[0].id, [], at(8), [{ name: "plan", summary: "again", items: items(["Part one", "Part three"]) }]);
    const nt = task(next, id);
    expect(M.currentChildren(next, nt).map(titleOf)).toEqual(["Part three"]);
    expect(M.childTasks(next, nt)).toHaveLength(3);
    for (const c of first) expect(task(next, c.id).parentArtifactId).toBe(plan1.id); // not relinked to the new plan
    expect(next.events.some((e) => e.taskId === id && /a task with this title already exists/.test(e.message))).toBe(true);
    // The evaluate step waits for the new child only: once it finishes, the earlier two (done long ago) do not hold anything back.
    expect(M.childrenSettled(next, nt)).toBe(false);
    expect(M.waitingForChildren(next, nt)?.id).toBe("S2");
    const later = structuredClone(next);
    task(later, M.currentChildren(later, nt)[0].id).lifecycle = "done";
    expect(M.childrenSettled(later, task(later, id))).toBe(true);
    expect(M.waitingForChildren(later, task(later, id))).toBeUndefined();
    // An earlier child that is open again (a dropped one restored with Undo, say) is still never waited for.
    const reopened = structuredClone(later);
    task(reopened, first[0].id).lifecycle = "active";
    expect(M.childrenSettled(reopened, task(reopened, id))).toBe(true);
    expect(M.waitingForChildren(reopened, task(reopened, id))).toBeUndefined();
    // The rule that refuses a change while children are open still stands.
    const paused2 = M.pauseTask(later, id, at(9));
    expect(M.flowChangeBlocker(paused2, task(paused2, id))).toBeUndefined();
    const withOpen = structuredClone(paused2);
    task(withOpen, M.currentChildren(withOpen, task(withOpen, id))[0].id).lifecycle = "active";
    expect(M.flowChangeBlocker(withOpen, task(withOpen, id))).toBe("It has child tasks; cancel them or let them finish first.");
  });

  it("a stop acknowledged or a run lost from before the change settles that attempt alone and leaves the new step untouched", () => {
    const { s: paused, id } = pausedAfterReview();
    const changed = M.changeFlow(paused, id, task(paused, id).pipelineRev, "bugfix", "", at(6));
    const old = changed.attempts.find((a) => a.taskId === id && a.stepId === "S1")!;
    let next = M.resumeTask(changed, id, at(7));
    next = M.dispatchEligible(next, at(8));
    const fresh = running(next, id)[0];
    expect(fresh.stepId).toBe("S1");
    // State surgery standing in for a regression elsewhere: the earlier run is active again while the new S1 runs.
    const stopping = structuredClone(next);
    const a = stopping.attempts.find((x) => x.id === old.id)!;
    a.outcome = "stopping";
    delete a.endedAt;
    const acked = M.acknowledgeStop(stopping, old.id, at(9));
    expect(acked.attempts.find((x) => x.id === old.id)).toMatchObject({ outcome: "stopped", endedAt: at(9), note: expect.stringMatching(/Stopped on pipeline r1, before the flow changed \(r2\); its step was not touched/) });
    expect(step(acked, id, "S1").state).toBe("running"); // not reset to pending under the new run
    expect(running(acked, id).map((x) => x.id)).toEqual([fresh.id]);
    const lostState = structuredClone(next);
    const b = lostState.attempts.find((x) => x.id === old.id)!;
    b.outcome = "running";
    delete b.endedAt;
    const lost = M.reportRunLost(lostState, old.id, "no live process", at(9));
    expect(lost.attempts.find((x) => x.id === old.id)).toMatchObject({ outcome: "lost", note: expect.stringMatching(/no live process; no result was produced or integrated; it ran on pipeline r1, before the flow changed \(r2\)/) });
    expect(step(lost, id, "S1").state).toBe("running");
    // An ordinary stop of the current run still requeues its step.
    const normal = M.acknowledgeStop(M.pauseTask(next, id, at(9)), fresh.id, at(10));
    expect(step(normal, id, "S1").state).toBe("paused");
  });

  it("loop iterations created after a change start above any revision their ids had before", () => {
    // Iterations: a Change task whose loop had expanded (S2-i2 ran) before the change to Change without verification.
    let { s, id } = withTask("change");
    s = go(s, 1);
    s = finish(s, id, 2, { ref: "0123456789ab on orchestration/run" });
    s = M.dispatchEligible(s, at(3)); // C1 skipped, S2
    s = finish(s, id, 4, { findings: [finding()] }); // an auto-fix finding: S3 repairs without a decision
    s = M.dispatchEligible(s, at(5));
    expect(running(s, id)[0].stepId).toBe("S3");
    s = finish(s, id, 6, { ref: "abcdef012345 on orchestration/run" });
    expect(task(s, id).steps.map((x) => x.id)).toContain("S2-i2");
    s = M.dispatchEligible(s, at(7));
    expect(running(s, id)[0].stepId).toBe("S2-i2");
    expect(running(s, id).map((x) => x.stepId)).toEqual(["S2-i2", "SR1-i2"]); // the security review beside it runs too
    s = M.pauseTask(s, id, at(8));
    for (const a of running(s, id)) s = M.acknowledgeStop(s, a.id, at(9));
    expect(running(s, id)).toHaveLength(0);
    // Away to Bug fix (no S2-i2 there), and back to Change while still paused.
    const fix = M.changeFlow(s, id, task(s, id).pipelineRev, "bugfix", "", at(10));
    expect(task(fix, id).steps.map((x) => x.id)).toEqual(["S1", "S2", "C1", "S3", "SR1", "S4", "C2", "S5"]);
    expect(M.nextRevisionFor(fix, task(fix, id), "S2-i2")).toBe(2); // the attempt on the old S2-i2 ran at revision 1
    const back = M.changeFlow(fix, id, task(fix, id).pipelineRev, "change", "", at(11));
    expect(step(back, id, "S1").revision).toBe(3); // 1 ran, 2 under Bug fix, 3 now
    let n = M.resumeTask(back, id, at(12));
    n = M.dispatchEligible(n, at(13));
    n = finish(n, id, 14, { ref: "0123456789ab on orchestration/run" });
    n = M.dispatchEligible(n, at(15));
    n = finish(n, id, 16, { findings: [finding()] });
    n = M.dispatchEligible(n, at(17));
    expect(running(n, id)[0].stepId).toBe("S3");
    n = finish(n, id, 18, { ref: "abcdef012345 on orchestration/run" });
    expect(step(n, id, "S2-i2").revision).toBe(2);
    expect(step(n, id, "SR1-i2").revision).toBe(2); // its run before the change was at revision 1 too
    expect(step(n, id, "C1-i2").revision).toBe(1); // never ran (checks are off): nothing to stay above
    expect(step(n, id, "S3-i2").revision).toBe(1);
  });
});
