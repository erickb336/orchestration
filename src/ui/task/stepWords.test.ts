// ORC-025 pass 3 (P6): a step's words on the task page: name, who (only while running or done), state in words.

import { describe, expect, it } from "vitest";
import { buildDemo } from "../../domain/demo";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import type { State } from "../../domain/types";
import { stepName, stepWords } from "./stepWords";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const words = (s: State, id: string) => {
  const t = task(s, id);
  return Object.fromEntries(t.steps.map((st) => [st.id, stepWords(s, t, st)]));
};

describe("stepWords", () => {
  it("names the step by its purpose and says the loop round beside it, not in it", () => {
    const s = buildDemo(T0);
    const w = words(s, "WT-001");
    expect(w["S2-i2"]).toMatchObject({ name: "Code review", round: 2, mark: "done", state: "Done: no findings" });
    expect(w["S2"].round).toBeUndefined();
    expect(stepName({ purpose: "Repair review findings and failing checks (iteration 3)" })).toBe("Repair review findings and failing checks");
  });

  it("says who worked on a step only while it runs or once it is done", () => {
    const s = buildDemo(T0);
    const w = words(s, "WT-007");
    expect(w.S1).toMatchObject({ who: "Claude · claude-sample-large", state: "Done", mark: "done" });
    expect(w.C1).toMatchObject({ who: "the service", state: "Passed", mark: "done" });
    expect(w.S3).toMatchObject({ state: "Waiting", mark: "waiting" });
    expect(w.S3.who).toBeUndefined();
  });

  it("a review that found something the person must decide needs you; the repair that would read it waits for the decision", () => {
    const s = buildDemo(T0);
    const w = words(s, "WT-007");
    expect(w.S4).toMatchObject({ mark: "you", state: "Needs you: 1 finding" });
    expect(w.S5).toMatchObject({ mark: "waiting", state: "Waits for your decision" });
  });

  it("checks say Passed or how many failed; a skipped repair says why; a goal's steps wait for the child tasks", () => {
    const s = buildDemo(T0);
    expect(words(s, "WT-001").C1.state).toBe("Done: 1 of 2 checks failed");
    expect(words(s, "WT-001")["C1-i2"].state).toBe("Passed");
    expect(words(s, "WT-005").S3).toMatchObject({ mark: "skipped", state: "Skipped: nothing to fix" });
    expect(words(s, "WT-004").S2.state).toBe("Waiting for 2 child tasks");
  });

  it("a running step says Running with the provider and model that run it; a stopping one says Stopping", () => {
    const s = buildSeed(T0);
    const t = s.tasks.find((x) => M.activeAttempts(s, x.id).some((a) => a.outcome === "running"))!;
    const run = M.activeAttempts(s, t.id).find((a) => a.outcome === "running")!;
    const st = t.steps.find((x) => x.id === run.stepId)!;
    expect(stepWords(s, t, st)).toMatchObject({ mark: "running", state: "Running", who: `${M.providerLabel(run.snapshot.provider)} · ${run.snapshot.model}` });
    const stopping = structuredClone(s);
    stopping.attempts.find((a) => a.id === run.id)!.outcome = "stopping";
    expect(stepWords(stopping, task(stopping, t.id), st)).toMatchObject({ mark: "running", state: "Stopping" });
  });

  it("a blocked step says why; a paused one says Paused; a cancelled task's pending steps were not run", () => {
    const s = buildDemo(T0);
    const t = structuredClone(task(s, "WT-002"));
    t.steps[0].state = "blocked";
    t.steps[0].blockedReason = "the worktree could not be created";
    expect(stepWords(s, t, t.steps[0])).toMatchObject({ mark: "fail", state: "Blocked: the worktree could not be created" });
    t.steps[1].state = "paused";
    expect(stepWords(s, t, t.steps[1])).toMatchObject({ mark: "waiting", state: "Paused" });
    t.lifecycle = "cancelled";
    expect(stepWords(s, t, t.steps[2]).state).toBe("Not run");
  });

  it("a checks step says when it will be skipped because checks are off", () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    const t = s.tasks.find((x) => x.steps.some((st) => st.role === "checks" && st.state === "pending"))!;
    const st = t.steps.find((x) => x.role === "checks" && x.state === "pending")!;
    expect(stepWords(s, t, st).state).toBe("Will be skipped: checks are off");
  });
});
