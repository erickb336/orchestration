import { describe, expect, it } from "vitest";
import * as M from "./model";
import { validatePipeline } from "./pipeline";
import { INTERNAL_PATTERNS } from "./internalPatterns";
import { builtInCatalog, patternSteps } from "./patterns";
import { buildSeed } from "./seed";
import type { State, StepDef } from "./types";

const T0 = Date.parse("2026-09-29T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const seed = () => buildSeed(T0);
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const errors = (defs: StepDef[]) => validatePipeline(defs).filter((i) => i.severity === "error");

/** Complete the single running attempt on a task with the given open findings for reviews. */
function finish(s: State, taskId: string, t: number, findings = 0): State {
  const [a] = running(s, taskId);
  const st = step(s, taskId, a.stepId);
  const outputs = st.outputs.map((o) => ({ name: o.name, summary: `${o.name} at ${t}`, openFindings: o.kind === "review-findings" ? findings : undefined }));
  return M.reportCompletion(s, a.id, [], at(t), outputs);
}

describe("built-in and internal patterns", () => {
  it("every one is valid and names no product or model (provider ids only under parallel.providers)", () => {
    for (const p of [...builtInCatalog().patterns, ...INTERNAL_PATTERNS]) {
      // ORC-013: the delivery-checks pipeline is valid only on a task with a checkTarget, like delivery-review on a reviewTarget.
      expect(validatePipeline(p.steps, { checkTarget: p.id === "delivery-checks" }).filter((i) => i.severity === "error"), p.id).toEqual([]);
      // What workers and people read: names, descriptions and the steps, with the provider assignment of a best-of step set aside.
      const neutral = { id: p.id, name: p.name, description: p.description, ...("whenToUse" in p ? { whenToUse: p.whenToUse, hypothesis: p.hypothesis } : {}), steps: p.steps.map((s) => ({ ...s, parallel: s.parallel ? { ...s.parallel, providers: undefined } : undefined })) };
      expect(JSON.stringify(neutral), p.id).not.toMatch(/sample|notes|claude|codex/i);
    }
  });
});

describe("validation", () => {
  it("rejects forward dependencies, inputs from non-upstream steps, and conditions on non-findings", () => {
    const defs = patternSteps("change");
    expect(errors([{ ...defs[0], dependsOn: ["S2"] }, ...defs.slice(1)]).length).toBeGreaterThan(0);
    const badInput = structuredClone(defs);
    badInput[1].dependsOn = [];
    expect(errors(badInput).some((e) => e.message.includes("not upstream"))).toBe(true);
    const badCond = structuredClone(defs);
    badCond[2].runIf = [{ step: "S1", output: "change" }];
    expect(errors(badCond).some((e) => e.message.includes("only be conditioned on review findings"))).toBe(true);
    const dupOut = structuredClone(defs);
    dupOut[0].outputs.push({ name: "change", kind: "report" });
    expect(errors(dupOut).some((e) => e.message.includes("two outputs"))).toBe(true);
  });
});

describe("artifacts and conditions", () => {
  it("records consumed inputs, skips repair without findings, and integrates", () => {
    let s = finish(seed(), "EX-002", 1, 0); // S2 review, no findings
    s = M.dispatchEligible(s, at(2));
    expect(step(s, "EX-002", "S3").state).toBe("skipped");
    const [verify] = running(s, "EX-002");
    expect(verify.stepId).toBe("S4");
    // Verify receives S1.change and S2.findings, not the skipped repair's output.
    expect(verify.snapshot.inputs.map((i) => `${i.step}.${i.output}@v${i.version}`).sort()).toEqual(["S1.change@v1", "S2.findings@v1"]);
    s = finish(s, "EX-002", 3);
    s = M.dispatchEligible(s, at(4));
    expect(task(s, "EX-002").lifecycle).toBe("done");
  });

  it("runs repair when a review has open findings, and passes the findings to it", () => {
    let s = finish(seed(), "EX-002", 1, 2);
    s = M.dispatchEligible(s, at(2));
    const [repair] = running(s, "EX-002");
    expect(repair.stepId).toBe("S3");
    expect(repair.snapshot.inputs.find((i) => i.step === "S2")).toMatchObject({ output: "findings", version: 1 });
    expect(s.artifacts.find((a) => a.taskId === "EX-002" && a.stepId === "S2")!.openFindings).toBe(2);
  });

  it("a rerun produces a new artifact version and marks earlier consumers stale", () => {
    let s = finish(seed(), "EX-002", 1, 0);
    const reviewRun = s.attempts.find((a) => a.taskId === "EX-002" && a.stepId === "S2" && a.outcome === "completed")!;
    s = M.rerunStep(s, "EX-002", "S1", at(2));
    s = M.dispatchEligible(s, at(3));
    s = finish(s, "EX-002", 4);
    expect(M.latestArtifact(s, task(s, "EX-002"), "S1", "change")!.version).toBe(2);
    expect(M.staleInputs(s, task(s, "EX-002"), reviewRun).map((i) => i.output)).toContain("change");
    s = M.dispatchEligible(s, at(5));
    expect(running(s, "EX-002")[0].snapshot.inputs.find((i) => i.output === "change")!.version).toBe(2);
  });

  it("only accepted results produce artifacts", () => {
    let s = M.pauseTask(seed(), "EX-002", at(0));
    s = finish(s, "EX-002", 1, 1);
    expect(s.artifacts.filter((a) => a.taskId === "EX-002" && a.stepId === "S2")).toHaveLength(0);
  });
});

describe("pipeline edits", () => {
  it("rejects stale and invalid pipelines", () => {
    const s = seed();
    const defs = task(s, "EX-003").steps.map((x) => ({ ...x }));
    expect(() => M.setPipeline(s, "EX-003", 0, defs, "x", "user", at(0))).toThrow(/Stale/);
    expect(() => M.setPipeline(s, "EX-003", 1, [{ ...defs[0], dependsOn: ["S9"] }], "x", "user", at(0))).toThrow(/invalid/);
  });

  it("adding a step leaves running work alone", () => {
    let s = seed();
    const t = task(s, "EX-001");
    const defs: StepDef[] = t.steps.map((x) => ({ ...x }));
    defs.push({ id: "S7", purpose: "Write release notes", role: "designer", dependsOn: ["S6"], inputs: [{ step: "S6", output: "verification" }], outputs: [{ name: "notes", kind: "report" }] });
    s = M.setPipeline(s, "EX-001", 1, defs, "Add release notes", "user", at(0));
    expect(running(s, "EX-001")[0].outcome).toBe("running");
    expect(step(s, "EX-001", "S7").state).toBe("pending");
    expect(task(s, "EX-001").pipelineRev).toBe(2);
  });

  it("changing an upstream step stops affected runs, revalidates done steps, and keeps model pins", () => {
    let s = M.setStepSelection(seed(), "EX-001", "S3", { provider: "codex", model: "codex-sample-fast" }, at(0));
    const t = task(s, "EX-001");
    const defs: StepDef[] = t.steps.map((x) => (x.id === "S1" ? { ...x, outputs: [...x.outputs, { name: "copy", kind: "brief" as const }] } : { ...x }));
    const [impl] = running(s, "EX-001");
    s = M.setPipeline(s, "EX-001", 1, defs, "Design also delivers copy", "user", at(1));
    expect(step(s, "EX-001", "S1")).toMatchObject({ state: "pending", invalidatedBy: "pipeline r2" });
    expect(s.attempts.find((a) => a.id === impl.id)!.outcome).toBe("stopping");
    expect(step(s, "EX-001", "S3").selection).toEqual({ provider: "codex", model: "codex-sample-fast" });
    s = finish(s, "EX-001", 2); // late result from the superseded step revision
    expect(s.attempts.find((a) => a.id === impl.id)!.outcome).toBe("discarded");
  });

  it("removing a running step stops it and its late result is discarded", () => {
    let s = seed();
    const defs = patternSteps("change").filter((d) => d.id === "S1"); // drop review/repair/verify
    const [review] = running(s, "EX-002");
    s = M.setPipeline(s, "EX-002", 1, defs, "Ship without review", "user", at(0));
    expect(s.attempts.find((a) => a.id === review.id)!.outcome).toBe("stopping");
    s = M.reportCompletion(s, review.id, [], at(1), [{ name: "findings", summary: "late", openFindings: 0 }]);
    expect(s.attempts.find((a) => a.id === review.id)!.outcome).toBe("discarded");
    s = M.dispatchEligible(s, at(2));
    expect(task(s, "EX-002").lifecycle).toBe("done");
  });

  it("editing a paused task's pipeline keeps it paused", () => {
    let s = seed();
    const defs = patternSteps("change");
    s = M.setPipeline(s, "EX-005", 1, defs, "Swap to change template", "user", at(0));
    expect(task(s, "EX-005").hold).toBe(true);
    expect(task(s, "EX-005").steps.every((x) => x.state === "paused" || x.state === "pending")).toBe(true);
    s = M.dispatchEligible(s, at(1));
    expect(running(s, "EX-005")).toHaveLength(0);
  });
});

describe("review regressions (ORC-002)", () => {
  it("a task is not integrated while a removed step's run is still stopping", () => {
    let s = finish(seed(), "EX-001", 1); // S2 implement done
    s = M.dispatchEligible(s, at(2)); // S3 and S4 reviews run (C1, the Checks step, skipped: checks are off)
    const defs = task(s, "EX-001").steps.filter((x) => ["S1", "S2", "C1", "S3"].includes(x.id)).map((x) => ({ ...x }));
    s = M.setPipeline(s, "EX-001", 1, defs, "Drop UX review, repair, verify", "user", at(3));
    const s3 = running(s, "EX-001").find((a) => a.stepId === "S3")!;
    s = M.reportCompletion(s, s3.id, [], at(4), [{ name: "findings", summary: "ok", openFindings: 0 }]);
    expect(task(s, "EX-001").lifecycle).toBe("active");
    const s4 = running(s, "EX-001")[0];
    s = M.acknowledgeStop(s, s4.id, at(5));
    s = M.dispatchEligible(s, at(6));
    expect(task(s, "EX-001").lifecycle).toBe("done");
  });

  it("run-if ignores findings from a step that was later skipped or is re-running", () => {
    const defs: StepDef[] = [
      ...patternSteps("change")
        .filter((d) => ["S1", "C1", "S2", "S3"].includes(d.id))
        .map((d) => ({ ...d, iterate: undefined })),
      { id: "S5", purpose: "Re-review", role: "code_reviewer", dependsOn: ["S3"], inputs: [], outputs: [{ name: "findings", kind: "review-findings" }], runIf: [{ step: "S2", output: "findings" }] },
      { id: "S6", purpose: "Second repair", role: "coder", dependsOn: ["S5"], inputs: [{ step: "S5", output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S5", output: "findings" }] },
      { id: "S7", purpose: "Verify", role: "lead", dependsOn: ["S6"], inputs: [], outputs: [{ name: "verification", kind: "verification" }] },
    ];
    let s = M.leadPromoteProposals(M.setPipeline(seed(), "EX-003", 1, defs, "custom", "user", at(0)), at(0));
    const step6 = () => step(s, "EX-003", "S6");
    let t = 1;
    const drive = (findings: number) => {
      s = M.dispatchEligible(s, at(t++));
      if (running(s, "EX-003").length) s = finish(s, "EX-003", t++, findings);
    };
    drive(0); // S1
    drive(1); // S2 finds 1
    drive(0); // S3 repair
    drive(1); // S5 re-review finds 1
    s = M.dispatchEligible(s, at(t++));
    expect(running(s, "EX-003")[0].stepId).toBe("S6");
    s = finish(s, "EX-003", t++);
    // Rerun S2 clean: S3 and S5 are skipped, so S6 must be skipped too.
    s = M.rerunStep(s, "EX-003", "S2", at(t++));
    drive(0); // S2 clean
    s = M.dispatchEligible(s, at(t++));
    s = M.dispatchEligible(s, at(t++));
    expect(step(s, "EX-003", "S5").state).toBe("skipped");
    expect(step6().state).toBe("skipped");
  });

  it("a run missing declared outputs is not accepted and blocks the step", () => {
    let s = M.rerunStep(finish(seed(), "EX-002", 1, 0), "EX-002", "S1", at(2));
    s = M.dispatchEligible(s, at(3));
    const [a] = running(s, "EX-002");
    s = M.reportCompletion(s, a.id, [], at(4), [{ name: "handoff", summary: "only handoff" }]);
    expect(s.attempts.find((x) => x.id === a.id)!.outcome).toBe("failed");
    expect(step(s, "EX-002", "S1")).toMatchObject({ state: "blocked" });
    expect(s.artifacts.some((x) => x.attemptId === a.id)).toBe(false);
    s = M.retryStep(s, "EX-002", "S1", at(5));
    s = M.dispatchEligible(s, at(6));
    expect(running(s, "EX-002")[0].stepId).toBe("S1");
  });

  it("a removed step's ID cannot be reused by a new step", () => {
    let s = seed();
    const defs = task(s, "EX-007").steps.filter((x) => x.id !== "S4").map((x) => ({ ...x }));
    s = M.setPipeline(s, "EX-007", 1, defs, "Drop verification", "user", at(0));
    const readd = [...defs, { id: "S4", purpose: "Release notes", role: "designer" as const, dependsOn: ["S3"], inputs: [], outputs: [{ name: "notes", kind: "report" as const }] }];
    expect(() => M.setPipeline(s, "EX-007", 2, readd, "re-add", "user", at(1))).toThrow(/removed step/);
  });

  it("purpose is the worker instruction: changing it on a running step stops the run", () => {
    let s = seed();
    const defs = task(s, "EX-001").steps.map((x) => ({ ...x, purpose: x.id === "S2" ? "Implement with tests" : x.purpose }));
    s = M.setPipeline(s, "EX-001", 1, defs, "Clarify instruction", "user", at(0));
    expect(running(s, "EX-001")[0].outcome).toBe("stopping");
    s = M.acknowledgeStop(s, running(s, "EX-001")[0].id, at(1));
    s = M.dispatchEligible(s, at(2));
    expect(running(s, "EX-001")[0].snapshot.purpose).toBe("Implement with tests");
  });

  it("step IDs must be safe identifiers", () => {
    const defs = patternSteps("change");
    defs[0] = { ...defs[0], id: "../../etc x" };
    expect(validatePipeline(defs).some((i) => i.severity === "error" && i.message.includes("must start with a letter"))).toBe(true);
  });

  it("the internal setPipeline records a custom pipeline as the task's pattern", () => {
    // ORC-016: no command reaches setPipeline; what tests build with it is labelled, never mistaken for a catalog pattern.
    const s = M.setPipeline(seed(), "EX-003", 1, patternSteps("change").slice(0, 1), "one step", "user", at(0));
    expect(task(s, "EX-003").pattern).toEqual({ id: "custom", name: "Custom pipeline", source: "custom", chosenBy: "user" });
    expect(task(s, "EX-003").pipelineHistory[1].pattern).toMatchObject({ source: "custom" });
  });
});
