// ORC-016 step 2: changing a task's pattern (design §7, invariants P7 and P8). Allowed before a task has
// run or once it is confirmed Paused; the pipeline starts over; earlier work stays on the record and is
// never reused; results from runs started before the change are discarded (G2); their artifacts cannot be
// edited (G3). Pure domain tests over a seed with every sample task held.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as M from "./model";
import { builtInCatalog } from "./patterns";
import { buildSeed } from "./seed";
import { StaleWriteError, type Finding, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const builtIn = (id: string) => builtInCatalog().patterns.find((p) => p.id === id)!;
const pin = { provider: "claude" as const, model: "claude-sample-large" };

/** The seed with every sample task held, plus one task of yours from `patternId`. */
function withTask(patternId = "bugfix", over: Partial<M.NewTask> = {}): { s: State; id: string } {
  const s0 = buildSeed(T0, { inFlightRuns: false });
  for (const t of s0.tasks) t.hold = true;
  const r = M.createTask(s0, { title: "Mine", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId, ...over }, at(0));
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
  return M.reportCompletion(s, a.id, [], at(t), outputs, { usage: { inputTokens: 10, outputTokens: 5 } });
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

describe("changePattern before the task starts", () => {
  it("replaces the pattern, records the revision with provenance, moves patternSince, and keeps only pins whose step keeps its role", () => {
    let { s, id } = withTask("bugfix");
    s = M.setStepSelection(s, id, "S1", pin, at(1)); // coder in both
    s = M.setStepSelection(s, id, "S2", pin, at(1)); // coder in Bug fix, reviewer in Change
    s = M.setStepSelection(s, id, "S4", pin, at(1)); // no S4 coder in Change (S4 is the lead's verification)
    const change = builtIn("change");
    const preview = M.patternChangePreview(s, task(s, id), change);
    expect(preview).toEqual({ allowed: true, redo: [], pinsKept: ["S1"], pinsDropped: [{ step: "S2", why: "role changed" }, { step: "S4", why: "role changed" }], artifactsKept: 0, decisionsClosed: 0 });
    const r = M.changePattern(s, id, 1, "change", "simpler fix", at(2));
    const t = task(r, id);
    expect(t.steps.map((x) => x.id)).toEqual(change.steps.map((x) => x.id));
    expect(t.steps.every((x) => x.state === "pending")).toBe(true);
    // One above the revision each id had: pinning bumped S1, S2 and S4 to 2.
    expect(t.steps.map((x) => [x.id, x.revision])).toEqual([["S1", 3], ["C1", 2], ["S2", 3], ["S3", 2], ["C2", 2], ["S4", 3]]);
    expect(step(r, id, "S1").selection).toEqual(pin);
    expect(step(r, id, "S2").selection).toBeNull();
    expect(step(r, id, "S4").selection).toBeNull();
    expect(t.pipelineRev).toBe(2);
    expect(t.patternSince).toBe(2);
    expect(t.pattern).toEqual({ id: "change", name: "Change", source: "built-in", hash: change.hash, chain: change.chain, chosenBy: "user" });
    expect(t.pipelineHistory[1]).toMatchObject({ rev: 2, author: "user", reason: "Pattern changed from Bug fix to Change: simpler fix", pattern: { id: "change", hash: change.hash, chosenBy: "user" } });
    expect(t.pipelineHistory[1].steps.map((x) => x.id)).toEqual(change.steps.map((x) => x.id));
    expect(r.events.at(-1)!.message).toBe("Pipeline r2: pattern Bug fix → Change; nothing had run; pins kept: S1; dropped: S2 (role changed), S4 (role changed)");
    // The command is the same operation, user-only, with an optional note.
    const c = runCommand(s, "changePattern", { taskId: id, expectedRev: 1, patternId: "change" }, at(2)).state;
    expect(task(c, id).pipelineHistory[1].reason).toBe("Pattern changed from Bug fix to Change");
    expect(() => runCommand(s, "changePattern", { taskId: id, expectedRev: "1", patternId: "change" }, at(2))).toThrow(/expectedRev must be a number/);
  });

  it("the same pattern with the same hash changes nothing; the same id with a newer hash is taken up", () => {
    const { s, id } = withTask("bugfix");
    const same = M.changePattern(s, id, 1, "bugfix", "", at(2));
    expect(same).toBe(s);
    // A file of yours replaced "bugfix" with other steps (a newer hash): choosing it again applies the update.
    const edited = structuredClone(s);
    const p = edited.patterns.patterns.find((x) => x.id === "bugfix")!;
    p.steps[0].purpose = "Reproduce it my way";
    p.hash = "f".repeat(64);
    p.source = "local";
    const r = M.changePattern(edited, id, 1, "bugfix", "", at(2));
    expect(task(r, id).pipelineRev).toBe(2);
    expect(task(r, id).pattern).toMatchObject({ id: "bugfix", hash: "f".repeat(64), source: "local" });
    expect(step(r, id, "S1").purpose).toBe("Reproduce it my way");
  });
});

describe("refusals (P7)", () => {
  it("while a run is active, while pausing, and when blocked but not held", () => {
    let { s, id } = withTask("change");
    s = go(s, 1);
    expect(running(s, id)).toHaveLength(1);
    expect(() => M.changePattern(s, id, 1, "bugfix", "", at(2))).toThrow(/Pause the task first; patterns change only before a task starts or while it is paused/);
    expect(M.patternChangePreview(s, task(s, id), builtIn("bugfix"))).toMatchObject({ allowed: false, why: /Pause the task first/ });
    // Pausing: the hold is saved but the runtime has not confirmed the stop.
    const pausing = M.pauseTask(s, id, at(2));
    expect(running(pausing, id)[0].outcome).toBe("stopping");
    expect(() => M.changePattern(pausing, id, 1, "bugfix", "", at(3))).toThrow(/Wait until it shows Paused\./);
    // Paused: the stop is acknowledged, so the change goes through and every step is paused.
    const paused = M.acknowledgeStop(pausing, running(pausing, id)[0].id, at(3));
    const r = M.changePattern(paused, id, 1, "bugfix", "", at(4));
    expect(task(r, id).steps.every((x) => x.state === "paused")).toBe(true);
    expect(task(r, id).hold).toBe(true);
    // Blocked after a failed run, not held: still refused.
    const failed = M.reportRunFailed(s, running(s, id)[0].id, "boom", at(2));
    expect(step(failed, id, "S1").state).toBe("blocked");
    expect(() => M.changePattern(failed, id, 1, "bugfix", "", at(3))).toThrow(/Pause the task first/);
  });

  it("done, cancelled, service-owned, a parent with open child tasks, a child moved to Goal, an internal pattern, and a stale revision", () => {
    const { s, id } = withTask("change");
    expect(() => M.changePattern(s, "EX-006", task(s, "EX-006").pipelineRev, "bugfix", "", at(1))).toThrow(/Done tasks keep the pipeline they ran\. Create a follow-up and choose its pattern there\./);
    const cancelled = M.cancelTask(s, id, at(1));
    expect(() => M.changePattern(cancelled, id, 1, "bugfix", "", at(2))).toThrow(new RegExp(`${id} is cancelled\\.`));
    const owned = structuredClone(s);
    task(owned, id).revertOf = { taskId: "EX-006", commit: "abc" };
    expect(() => M.changePattern(owned, id, 1, "bugfix", "", at(2))).toThrow(/This task's pipeline is set by pull-request delivery\./);
    // A parent with an open child.
    const child = M.createTask(s, { title: "Child", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: [], priority: 2, holdBeforeStart: false, patternId: "change" }, at(1));
    const family = structuredClone(child.state);
    task(family, child.newId).parentTaskId = id;
    expect(() => M.changePattern(family, id, 1, "bugfix", "", at(2))).toThrow(/It has child tasks; cancel them or let them finish first\./);
    const childGone = M.cancelTask(family, child.newId, at(2));
    expect(task(M.changePattern(childGone, id, 1, "bugfix", "", at(3)), id).pattern.id).toBe("bugfix");
    // A child task may not take a pattern that breaks down.
    expect(() => M.changePattern(family, child.newId, 1, "goal", "", at(2))).toThrow(/Goal breaks down into child tasks, which a child task cannot do\./);
    expect(task(M.changePattern(family, child.newId, 1, "bugfix", "", at(2)), child.newId).pattern.id).toBe("bugfix");
    // Internal and unknown patterns use the creation messages.
    expect(() => M.changePattern(s, id, 1, "revert", "", at(1))).toThrow(/The Revert pattern is used by Send back only\./);
    expect(() => M.changePattern(s, id, 1, "nope", "", at(1))).toThrow(/Unknown pattern nope/);
    expect(() => M.changePattern(s, id, 7, "bugfix", "", at(1))).toThrow(StaleWriteError);
  });

  it("the lead may choose standard patterns only; you may choose anything in the catalog", () => {
    const { s, id } = withTask("change");
    expect(() => M.changePattern(s, id, 1, "change-best-of-two", "", at(1), "lead")).toThrow(/pattern "change-best-of-two" is not available to the lead; choose one of: change, change-cross-review, feature, bugfix, investigation, design, goal/);
    expect(() => M.changePattern(s, id, 1, "feature-design-gate", "", at(1), "lead")).toThrow(/not available to the lead/);
    expect(M.patternChangePreview(s, task(s, id), builtIn("change-best-of-two"), "lead")).toMatchObject({ allowed: false, why: /not available to the lead/ });
    const byLead = M.changePattern(s, id, 1, "feature", "", at(1), "lead");
    expect(task(byLead, id).pattern).toMatchObject({ id: "feature", chosenBy: "lead" });
    expect(task(byLead, id).pipelineHistory[1].author).toBe("lead");
    const byYou = M.changePattern(s, id, 1, "change-best-of-two", "", at(1));
    expect(task(byYou, id).pattern).toMatchObject({ id: "change-best-of-two", experimental: true, chosenBy: "user" });
  });
});

describe("a fresh start while paused (P8)", () => {
  it("every new step is paused with a revision above every earlier one; decisions close; best-of and pending breakdowns clear; artifacts stay but are never consumed", () => {
    const { s: paused, id } = pausedAfterReview();
    const s0 = structuredClone(paused);
    task(s0, id).bestOf = { S1: "S1" };
    task(s0, id).bestOfByUser = { S1: at(4) };
    task(s0, id).pendingBreakdowns = [{ stepId: "S2", output: "findings" }];
    task(s0, id).checkRounds = 1;
    task(s0, id).holdReason = "Review S2";
    // A pin on the pending S3 (a coder in Change) bumps it to revision 2; S3 is a reviewer in Bug fix, so the pin is dropped.
    const s1 = M.setStepSelection(s0, id, "S3", pin, at(5));
    expect(step(s1, id, "S3").revision).toBe(2);
    const beforeArts = s1.artifacts.filter((a) => a.taskId === id).map((a) => a.id);
    expect(beforeArts.length).toBeGreaterThan(0);

    const preview = M.patternChangePreview(s1, task(s1, id), builtIn("bugfix"));
    expect(preview).toMatchObject({ allowed: true, redo: ["S1", "C1", "S2"], pinsKept: [], pinsDropped: [{ step: "S3", why: "role changed" }], artifactsKept: beforeArts.length, decisionsClosed: 1 });
    const r = M.changePattern(s1, id, task(s1, id).pipelineRev, "bugfix", "", at(6));
    const t = task(r, id);
    expect(t.hold).toBe(true);
    expect(t.lifecycle).toBe("active");
    expect(t.steps.every((x) => x.state === "paused" && x.selection === null)).toBe(true);
    expect(step(r, id, "S1").revision).toBe(2); // above the attempt's 1
    expect(step(r, id, "S2").revision).toBe(2); // above the attempt on the old S2
    expect(step(r, id, "C1").revision).toBe(2);
    expect(step(r, id, "S3").revision).toBe(3); // above the pinned step's 2
    expect(step(r, id, "S5").revision).toBe(1); // new id
    expect(t.patternSince).toBe(t.pipelineRev);
    expect(t.bestOf).toBeUndefined();
    expect(t.bestOfByUser).toBeUndefined();
    expect(t.pendingBreakdowns).toBeUndefined();
    expect(t.checkRounds).toBeUndefined();
    expect(t.holdReason).toBeUndefined();
    expect(r.decisions.filter((d) => d.taskId === id).map((d) => [d.status, d.why])).toEqual([["superseded", "the task's pattern changed"]]);
    expect(r.artifacts.filter((a) => a.taskId === id).map((a) => a.id)).toEqual(beforeArts);
    expect(r.events.at(-1)!.message).toMatch(/^Pipeline r\d+: pattern Change → Bug fix; 3 completed steps start over; dropped: S3 \(role changed\)$/);
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
    expect(M.fromEarlierPattern(next, task(next, id), repro)).toBe(false);
    expect(beforeArts.every((aid) => M.fromEarlierPattern(next, task(next, id), next.artifacts.find((a) => a.id === aid)!))).toBe(true);
  });

  it("G2: a result from a run started before the change is discarded and its step untouched, on completion and on failure", () => {
    const { s: paused, id } = pausedAfterReview();
    const changed = M.changePattern(paused, id, task(paused, id).pipelineRev, "bugfix", "", at(6));
    const old = changed.attempts.find((a) => a.taskId === id && a.stepId === "S1")!;
    expect(old.snapshot.pipelineRev).toBeLessThan(task(changed, id).patternSince);
    // State surgery standing in for a regression elsewhere: the earlier run is active again.
    const forced = structuredClone(changed);
    const a = forced.attempts.find((x) => x.id === old.id)!;
    a.outcome = "running";
    delete a.endedAt;
    const artsBefore = forced.artifacts.length;
    const done = M.reportCompletion(forced, old.id, [], at(7), [{ name: "change", summary: "late", ref: "fff" }, { name: "handoff", summary: "late" }]);
    expect(done.attempts.find((x) => x.id === old.id)).toMatchObject({ outcome: "discarded", note: "Result from before the pattern changed (pipeline r1); not integrated", endedAt: at(7) });
    expect(step(done, id, "S1")).toMatchObject({ state: "paused", revision: 2 });
    expect(done.artifacts).toHaveLength(artsBefore);
    expect(done.events.at(-1)!.message).toMatch(/finished on pipeline r1, before the pattern changed \(r2\); result discarded, not integrated/);
    const failed = M.reportRunFailed(forced, old.id, "boom", at(7));
    expect(failed.attempts.find((x) => x.id === old.id)).toMatchObject({ outcome: "discarded", note: "Result from before the pattern changed (pipeline r1); not integrated; it failed: boom" });
    expect(step(failed, id, "S1").state).toBe("paused");
    expect(step(failed, id, "S1").blockedReason).toBeUndefined();
  });

  it("G3: an artifact from before the change cannot be edited, with or without its own revision stamp; new work can", () => {
    const { s: paused, id } = pausedAfterReview();
    const changed = M.changePattern(paused, id, task(paused, id).pipelineRev, "bugfix", "", at(6));
    const old = changed.artifacts.find((a) => a.taskId === id && a.stepId === "S1" && a.name === "change")!;
    expect(old.pipelineRev).toBe(1);
    const refusal = /This artifact belongs to an earlier pattern of this task\. It is kept for the record and cannot be edited\./;
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
    // Work under the new pattern is editable as before.
    let next = M.resumeTask(changed, id, at(7));
    next = M.dispatchEligible(next, at(8));
    next = finish(next, id, 9);
    const fresh = next.artifacts.find((a) => a.taskId === id && a.stepId === "S1" && a.name === "reproduction")!;
    expect(fresh.pipelineRev).toBe(task(next, id).pipelineRev);
    const edited = M.editArtifact(next, fresh.id, { summary: "edited", reason: "r" }, at(10));
    expect(edited.artifacts.at(-1)).toMatchObject({ author: "user", name: "reproduction", version: 2, pipelineRev: task(edited, id).pipelineRev });
  });

  it("a task from before patterns (patternSince 0) is never guarded: its late results and edits work as before", () => {
    const { s: paused, id } = pausedAfterReview();
    const legacy = structuredClone(paused);
    task(legacy, id).patternSince = 0;
    task(legacy, id).pattern = { id: "change", name: "Change", source: "legacy", chosenBy: "migration" };
    const old = legacy.artifacts.find((a) => a.taskId === id && a.stepId === "S1" && a.name === "change")!;
    expect(M.fromEarlierPattern(legacy, task(legacy, id), old)).toBe(false);
    expect(M.editArtifact(legacy, old.id, { summary: "edited", reason: "r" }, at(7)).artifacts.at(-1)).toMatchObject({ author: "user" });
  });
});
