import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildSeed } from "./seed";
import { ControlError, StaleWriteError, type State } from "./types";
import { diffLines, specToLines } from "./diff";

const T0 = Date.parse("2026-09-29T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const seed = () => buildSeed(T0);
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const running = (s: State, id?: string) => M.activeAttempts(s, id);

/** A stand-in runtime for these tests: how long a stop takes to be acknowledged, or "never" for an unresponsive one. */
interface SimConfig {
  ackDelayMs: number;
  ackMode: "normal" | "never";
  /** After this long without acknowledgment, a control failure is reported. */
  ackTimeoutMs: number;
  progressPerTick: number;
}
const DEFAULT_SIM: SimConfig = { ackDelayMs: 2500, ackMode: "normal", ackTimeoutMs: 8000, progressPerTick: 25 };

/** One tick of the stand-in runtime: promote, dispatch, advance every running attempt (completing it with every declared output), answer stops. */
function simulateTick(state: State, nowMs: number, cfg: SimConfig): State {
  const now = new Date(nowMs).toISOString();
  let s = M.leadPromoteProposals(state, now);
  s = M.dispatchEligible(s, now);
  for (const a of s.attempts) {
    if (a.outcome === "running") {
      const next = a.progress + cfg.progressPerTick;
      const st = task(s, a.taskId).steps.find((x) => x.id === a.stepId);
      s = next >= 100 ? M.reportCompletion(s, a.id, [], now, (st?.outputs ?? []).map((o) => ({ name: o.name, summary: "test" }))) : M.reportProgress(s, a.id, next);
    } else if (a.outcome === "stopping" && a.stopRequestedAt) {
      const elapsed = nowMs - Date.parse(a.stopRequestedAt);
      if (cfg.ackMode === "normal" && elapsed >= cfg.ackDelayMs) s = M.acknowledgeStop(s, a.id, now);
      else if (elapsed >= cfg.ackTimeoutMs) s = M.reportStopTimeout(s, a.id, now);
    }
  }
  return s;
}
/** Report a run as finished with every output its step declares. */
const complete = (s: State, attemptId: string, t: string) => {
  const a = s.attempts.find((x) => x.id === attemptId)!;
  const st = task(s, a.taskId).steps.find((x) => x.id === a.stepId)!;
  return M.reportCompletion(s, attemptId, [], t, st.outputs.map((o) => ({ name: o.name, summary: "test" })));
};

describe("pause", () => {
  it("pausing queued work persists a hold and excludes it from dispatch", () => {
    let s = seed();
    s = M.startHeldTask(s, "EX-004", at(0));
    s = M.pauseTask(s, "EX-004", at(1));
    s = M.dispatchEligible(s, at(2));
    expect(task(s, "EX-004").hold).toBe(true);
    expect(running(s, "EX-004")).toHaveLength(0);
    expect(M.column(s, task(s, "EX-004"))).toBe("paused");
  });

  it("pausing running work shows Pausing until acknowledgment, then Paused with a checkpoint", () => {
    let s = M.pauseTask(seed(), "EX-001", at(0));
    expect(task(s, "EX-001").hold).toBe(true);
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Pausing");
    expect(M.column(s, task(s, "EX-001"))).toBe("running");
    const [a] = running(s, "EX-001");
    s = M.acknowledgeStop(s, a.id, at(3));
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Paused");
    const stopped = s.attempts.find((x) => x.id === a.id)!;
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.artifacts.some((x) => x.startsWith("checkpoint"))).toBe(true);
  });

  it("an unacknowledged stop becomes a visible control failure and blocks redispatch", () => {
    let s = M.pauseTask(seed(), "EX-001", at(0));
    const cfg = { ...DEFAULT_SIM, ackMode: "never" as const };
    s = simulateTick(s, T0 + 10_000, cfg);
    expect(task(s, "EX-001").controlFailure).toBeDefined();
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Control failure");
    expect(running(s, "EX-001")[0].outcome).toBe("stopping");
  });

  it("resume clears the hold and requeues without claiming it is running", () => {
    let s = M.pauseTask(seed(), "EX-001", at(0));
    s = M.acknowledgeStop(s, running(s, "EX-001")[0].id, at(1));
    s = M.resumeTask(s, "EX-001", at(2));
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Queued for next step");
    s = M.dispatchEligible(s, at(3));
    expect(running(s, "EX-001")).toHaveLength(1);
  });
});

describe("races (serialized)", () => {
  it("pause before completion: the result is not integrated", () => {
    let s = M.pauseTask(seed(), "EX-002", at(0));
    const [a] = running(s, "EX-002");
    s = M.reportCompletion(s, a.id, ["late result"], at(1));
    expect(task(s, "EX-002").lifecycle).toBe("active");
    expect(s.attempts.find((x) => x.id === a.id)!.outcome).toBe("stopped");
    expect(task(s, "EX-002").steps.find((x) => x.id === "S2")!.state).toBe("paused");
  });

  it("completion before pause: task done and pause is rejected", () => {
    let s = seed();
    // Finish EX-002 fully.
    for (let i = 0; i < 40 && task(s, "EX-002").lifecycle !== "done"; i++) s = simulateTick(s, T0 + i * 1000, DEFAULT_SIM);
    expect(task(s, "EX-002").lifecycle).toBe("done");
    expect(() => M.pauseTask(s, "EX-002", at(100))).toThrow(ControlError);
  });

  it("edit during a run discards the old-revision result and creates a new revision", () => {
    let s = seed();
    const [a] = running(s, "EX-001");
    const t = task(s, "EX-001");
    const content = { ...structuredClone(M.currentSpec(t).content), outcome: "Revised outcome" };
    s = M.editSpec(s, "EX-001", 1, content, "Narrow scope", "user", at(0));
    expect(M.currentSpec(task(s, "EX-001")).rev).toBe(2);
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Stopping for revision");
    // Old run finishes before acknowledging the stop.
    s = M.reportCompletion(s, a.id, ["old result"], at(1));
    expect(s.attempts.find((x) => x.id === a.id)!.outcome).toBe("discarded");
    expect(task(s, "EX-001").lifecycle).not.toBe("done");
    // Earlier design result needs revalidation against r2.
    expect(task(s, "EX-001").steps.find((x) => x.id === "S1")!.invalidatedBy).toBe("spec r2");
    // Next dispatch runs on r2.
    s = M.dispatchEligible(s, at(2));
    expect(running(s, "EX-001").every((x) => x.snapshot.specRev === 2)).toBe(true);
  });

  it("no new dispatch on a task while a stop is unacknowledged", () => {
    let s = seed();
    const content = structuredClone(M.currentSpec(task(s, "EX-001")).content);
    s = M.editSpec(s, "EX-001", 1, content, "Tweak", "user", at(0));
    s = M.dispatchEligible(s, at(1));
    expect(running(s, "EX-001")).toHaveLength(1);
    expect(running(s, "EX-001")[0].outcome).toBe("stopping");
  });
});

describe("spec edits", () => {
  it("rejects stale writes", () => {
    let s = seed();
    const c = structuredClone(M.currentSpec(task(s, "EX-003")).content);
    s = M.editSpec(s, "EX-003", 1, c, "first", "user", at(0));
    expect(() => M.editSpec(s, "EX-003", 1, c, "second", "user", at(1))).toThrow(StaleWriteError);
  });

  it("editing paused work keeps the hold", () => {
    let s = seed();
    const c = structuredClone(M.currentSpec(task(s, "EX-005")).content);
    s = M.editSpec(s, "EX-005", 1, { ...c, benefit: "changed" }, "copy", "user", at(0));
    expect(task(s, "EX-005").hold).toBe(true);
    expect(M.column(s, task(s, "EX-005"))).toBe("paused");
  });

  it("user override preserves the recommendation and requires a reason", () => {
    const s = seed();
    expect(() => M.overrideSelection(s, "EX-004", 1, "B", "", at(0))).toThrow(ControlError);
    const s2 = M.overrideSelection(s, "EX-004", 1, "B", "Touch users are rare here", at(0));
    const c = M.currentSpec(task(s2, "EX-004")).content;
    expect(c.recommendedOptionId).toBe("A");
    expect(c.selectedOptionId).toBe("B");
    expect(c.decidedBy).toBe("user");
    expect(c.overrideReason).toBe("Touch users are rare here");
    expect(task(s2, "EX-004").specs).toHaveLength(2);
  });

  it("completed tasks cannot be edited; a follow-up is created instead", () => {
    const s = seed();
    const c = M.currentSpec(task(s, "EX-006")).content;
    expect(() => M.editSpec(s, "EX-006", 2, c, "x", "user", at(0))).toThrow(/follow-up/);
    const { state, newId } = M.createFollowUp(s, "EX-006", at(0));
    expect(task(state, newId).followUpOf).toBe("EX-006");
    expect(task(state, "EX-006").specs).toHaveLength(2);
  });

  it("diff shows changed fields", () => {
    const s = seed();
    const t = task(s, "EX-006");
    const d = diffLines(specToLines(t.specs[0].content), specToLines(t.specs[1].content));
    expect(d.filter((x) => x.kind === "add").map((x) => x.text)).toContain("Selected: B");
    expect(d.filter((x) => x.kind === "del").map((x) => x.text)).toContain("Selected: A");
  });
});

describe("project pause", () => {
  it("freezes dispatch, stops runs, and resume preserves task holds", () => {
    let s = M.pauseTask(seed(), "EX-005", at(0));
    s = M.pauseProject(s, at(1));
    expect(running(s).every((a) => a.outcome === "stopping")).toBe(true);
    for (const a of running(s)) s = M.acknowledgeStop(s, a.id, at(2));
    s = M.startHeldTask(s, "EX-004", at(3));
    s = M.dispatchEligible(s, at(4));
    expect(running(s)).toHaveLength(0);
    s = M.resumeProject(s, at(5));
    expect(task(s, "EX-005").hold).toBe(true);
    s = M.dispatchEligible(s, at(6));
    expect(running(s, "EX-005")).toHaveLength(0);
    expect(running(s, "EX-001")).toHaveLength(1);
  });
});

describe("step model configuration", () => {
  it("resolves step → task role → project role → project default", () => {
    let s = seed();
    const t = () => task(s, "EX-003");
    const st = () => t().steps[0]; // coder
    expect(M.resolveStep(s, t(), st())).toMatchObject({ ok: true, source: "project-role" });
    s = M.setTaskRoleOverride(s, "EX-003", "coder", { provider: "claude", model: "claude-sample-fast" }, at(0));
    expect(M.resolveStep(s, t(), st())).toMatchObject({ ok: true, source: "task-role", selection: { provider: "claude" } });
    s = M.setStepSelection(s, "EX-003", "S1", { provider: "claude", model: "claude-sample-fast" }, at(1));
    expect(M.resolveStep(s, t(), st())).toMatchObject({ ok: true, source: "step", selection: { model: "claude-sample-fast" } });
    s = M.setStepSelection(s, "EX-003", "S1", null, at(2));
    s = M.setTaskRoleOverride(s, "EX-003", "coder", null, at(3));
    s = M.setRoleDefault(s, "coder", null, at(4));
    expect(M.resolveStep(s, t(), st())).toMatchObject({ ok: true, source: "project-default" });
  });

  it("changing a role default affects unpinned undispatched steps only, never run snapshots", () => {
    let s = seed();
    s = M.setStepSelection(s, "EX-004", "S2", { provider: "claude", model: "claude-sample-fast" }, at(0));
    const before = s.attempts.find((a) => a.taskId === "EX-001" && a.stepId === "S2")!;
    s = M.setRoleDefault(s, "coder", { provider: "claude", model: "claude-sample-large" }, at(1));
    const ex7 = task(s, "EX-007");
    expect(M.resolveStep(s, ex7, ex7.steps[0])).toMatchObject({ selection: { provider: "claude", model: "claude-sample-large" } });
    const ex4 = task(s, "EX-004");
    expect(M.resolveStep(s, ex4, ex4.steps[1])).toMatchObject({ source: "step", selection: { model: "claude-sample-fast" } });
    expect(s.attempts.find((a) => a.id === before.id)!.snapshot).toEqual(before.snapshot);
  });

  it("changing a running step's model stops the old attempt before a new one starts", () => {
    let s = seed();
    const [old] = running(s, "EX-001");
    s = M.setStepSelection(s, "EX-001", "S2", { provider: "claude", model: "claude-sample-large" }, at(0));
    s = M.dispatchEligible(s, at(1));
    expect(running(s, "EX-001")).toHaveLength(1);
    expect(running(s, "EX-001")[0].id).toBe(old.id);
    s = M.acknowledgeStop(s, old.id, at(2));
    s = M.dispatchEligible(s, at(3));
    const [fresh] = running(s, "EX-001");
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.snapshot).toMatchObject({ provider: "claude", model: "claude-sample-large", source: "step", stepRev: 2 });
  });

  it("disabled provider blocks the step with an explanation instead of substituting", () => {
    let s = M.setProviderEnabled(seed(), "codex", false, at(0));
    s = M.startHeldTask(s, "EX-004", at(1));
    // Finish design so the coder step becomes eligible.
    s = M.setStepSelection(s, "EX-004", "S1", null, at(2));
    s = M.dispatchEligible(s, at(3));
    const d = running(s, "EX-004")[0];
    s = complete(s, d.id, at(4));
    s = M.dispatchEligible(s, at(5));
    const st = task(s, "EX-004").steps.find((x) => x.id === "S2")!;
    expect(st.state).toBe("blocked");
    expect(st.blockedReason).toMatch(/Codex is not enabled/);
    expect(running(s).some((a) => a.taskId === "EX-004" && a.snapshot.provider === "claude" && a.stepId === "S2")).toBe(false);
  });

  it("rerunning an upstream step invalidates downstream results", () => {
    // EX-002 mid-flight: S1 done, S2 running.
    let s = seed();
    const [rev] = running(s, "EX-002");
    s = complete(s, rev.id, at(0));
    s = M.rerunStep(s, "EX-002", "S1", at(1));
    const steps = task(s, "EX-002").steps;
    expect(steps.find((x) => x.id === "S1")!.state).toBe("pending");
    expect(steps.find((x) => x.id === "S2")!.invalidatedBy).toBe("S1");
  });
});

describe("review regressions", () => {
  it("rerunning upstream stops in-flight downstream work so its stale result never integrates", () => {
    let s = seed();
    const [review] = running(s, "EX-002"); // S2 running on S1's output
    s = M.rerunStep(s, "EX-002", "S1", at(0));
    expect(running(s, "EX-002")[0].outcome).toBe("stopping");
    s = M.reportCompletion(s, review.id, ["review of old S1"], at(1));
    expect(s.attempts.find((a) => a.id === review.id)!.outcome).toBe("discarded");
    expect(task(s, "EX-002").steps.find((x) => x.id === "S2")!.state).toBe("pending");
    // S2 waits for the rerun of S1; only S1 dispatches.
    s = M.dispatchEligible(s, at(2));
    expect(running(s, "EX-002").map((a) => a.stepId)).toEqual(["S1"]);
  });

  it("an acknowledged project pause moves started tasks to Paused, not Running", () => {
    let s = M.pauseProject(seed(), at(0));
    for (const a of running(s)) s = M.acknowledgeStop(s, a.id, at(1));
    expect(M.column(s, task(s, "EX-001"))).toBe("paused");
    // ORC-025: one word for a pause; the header says "Project paused".
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Paused");
  });

  it("an idle started task between steps is queued, not running", () => {
    let s = seed();
    const [a] = running(s, "EX-001");
    s = complete(s, a.id, at(0));
    expect(M.column(s, task(s, "EX-001"))).toBe("ready");
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Queued for next step");
  });

  it("stop label reflects the real reason after a project resume", () => {
    let s = M.pauseProject(seed(), at(0));
    s = M.resumeProject(s, at(1));
    // ORC-025: the pause was lifted, so the task resumes once the run has stopped; the banner says a run is still stopping.
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Resuming");
  });

  it("the lead does not promote proposals with unfinished prerequisites", () => {
    const s = M.leadPromoteProposals(seed(), at(0));
    expect(task(s, "EX-007").lifecycle).toBe("proposed");
  });

  it("configuration changes leave closed tasks untouched", () => {
    let s = M.cancelTask(seed(), "EX-005", at(0));
    const st = task(s, "EX-005").steps[0];
    s = { ...s, tasks: s.tasks.map((t) => (t.id === "EX-005" ? { ...t, steps: [{ ...st, state: "blocked" as const, blockedReason: "x" }, ...t.steps.slice(1)] } : t)) };
    s = M.setRoleDefault(s, "designer", null, at(1));
    expect(task(s, "EX-005").steps[0].state).toBe("blocked");
  });
});

describe("service-owned tasks", () => {
  it("a dedicated review, a check run, a fix pushed onto a pull request and a revert are the service's: not the product's work, and their flow cannot change", () => {
    const s = seed();
    const plain = task(s, "EX-001");
    expect(M.serviceOwned(plain)).toBe(false);
    const owned = [
      { reviewTarget: { taskId: "EX-006", n: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40) } },
      { checkTarget: { taskId: "EX-006", n: 1, sha: "a".repeat(40) } },
      { deliverInto: { taskId: "EX-006", n: 1, mergeBase: false } },
      { revertOf: { taskId: "EX-006", commit: "a".repeat(40) } },
    ];
    for (const fields of owned) {
      const t = { ...structuredClone(plain), ...fields };
      expect(M.serviceOwned(t), Object.keys(fields)[0]).toBe(true);
      expect(M.flowChangeBlocker(s, t), Object.keys(fields)[0]).toBe("This task's pipeline is set by pull-request delivery.");
    }
  });
});

describe("dependencies", () => {
  it("dependents wait on unfinished prerequisites and block on cancelled ones", () => {
    let s = seed();
    expect(M.stateLabel(s, task(s, "EX-007"))).toBe("Waiting on EX-002");
    s = M.dispatchEligible(s, at(0));
    expect(running(s, "EX-007")).toHaveLength(0);
    s = M.cancelTask(s, "EX-002", at(1));
    expect(M.column(s, task(s, "EX-007"))).toBe("blocked");
  });
});

describe("simulation", () => {
  it("respects the worker limit", () => {
    let s = M.startHeldTask(seed(), "EX-004", at(0));
    for (let i = 0; i < 30; i++) {
      s = simulateTick(s, T0 + i * 1000, DEFAULT_SIM);
      expect(running(s).length).toBeLessThanOrEqual(s.project.workerLimit);
    }
  });
});
