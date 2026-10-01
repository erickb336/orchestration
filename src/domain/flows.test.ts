// ORC-021: the pure flow resolver. The six built-in files resolve in order; every flow passes the graph
// rules, every flow that changes code has an independent code review and a security review beside it,
// every flow has `whenToUse`; the rules the service relies on; who may use what; hashes and summaries.
// No files are read here: the built-ins are compiled in.

import { describe, expect, it } from "vitest";
import { BUILT_IN_FILES } from "./builtInFlows";
import { INTERNAL_FLOWS, INTERNAL_FLOW_IDS } from "./internalFlows";
import { builtInCatalog, childDefault, effectiveDefault, eligible, eligibleIds, flowHash, flowRef, flowSummary, resolveFlows, unreviewedReasons, type FlowFile, type RawFlow } from "./flows";
import { validatePipeline } from "./pipeline";
import { buildSeed } from "./seed";
import type { StepDef } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const seed = () => buildSeed(T0, { inFlightRuns: false });
const raw = (id: string, over: Record<string, unknown>): RawFlow => ({ id, name: id, description: `${id} description`, whenToUse: `when ${id}`, ...over }) as RawFlow;
const file = (id: string, over: Record<string, unknown>, name = `${id}.json`): FlowFile => ({ file: `flows/${name}`, raw: raw(id, over) });
const builtIn = (id: string) => builtInCatalog().find((p) => p.id === id)!;
const ids = (steps: StepDef[]) => steps.map((s) => s.id);

const oneStep: StepDef[] = [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }];
const reviewed: StepDef[] = [...oneStep, { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] }];
const SIX = ["change", "bugfix", "feature", "design", "investigation", "goal"];
const CODE = ["change", "bugfix", "feature"];

describe("the six flows", () => {
  it("resolve from the files in manifest order, with no other ids", () => {
    const c = builtInCatalog();
    expect(c.map((p) => p.id)).toEqual(SIX);
    expect(c.every((p) => p.source === "built-in")).toBe(true);
    expect(BUILT_IN_FILES.map((f) => f.file)).toEqual(SIX.map((id) => `flows/${id}.json`));
    // The catalog in the seed is this one.
    expect(seed().flows.map((p) => p.id)).toEqual(SIX);
    for (const removed of ["change-cross-review", "feature-design-gate", "goal-plan-gate", "change-best-of-two", "change-lean"]) expect(c.some((p) => p.id === removed), removed).toBe(false);
  });

  it("every flow passes the pipeline graph rules with no warnings, and so does every internal pipeline", () => {
    for (const p of builtInCatalog()) expect(validatePipeline(p.steps), p.id).toEqual([]);
    for (const p of INTERNAL_FLOWS) expect(validatePipeline(p.steps, { reviewTarget: p.id === "delivery-review", checkTarget: p.id === "delivery-checks" }).filter((i) => i.severity === "error"), p.id).toEqual([]);
  });

  it("every flow has a name, a description and a whenToUse line, and no file has an unknown field", () => {
    for (const f of BUILT_IN_FILES) {
      expect(f.raw.whenToUse.trim().length, f.file).toBeGreaterThan(10);
      expect(f.raw.name.trim().length, f.file).toBeGreaterThan(0);
      expect(f.raw.description.trim().length, f.file).toBeGreaterThan(10);
      expect(Object.keys(f.raw).filter((k) => !["$schema", "$comment", "id", "name", "description", "whenToUse", "steps"].includes(k)), f.file).toEqual([]);
    }
  });

  it("every flow that changes code has an independent code review of every code change; Design, Investigation and Goal change no code", () => {
    for (const id of CODE) expect(unreviewedReasons(builtIn(id).steps), id).toEqual([]);
    for (const id of ["design", "investigation", "goal"]) expect(builtIn(id).steps.some((s) => s.outputs.some((o) => o.kind === "code-change")), id).toBe(false);
    expect(unreviewedReasons(INTERNAL_FLOWS.find((p) => p.id === "revert")!.steps)).toEqual([]);
    // Only Goal breaks down.
    expect(builtInCatalog().map((p) => [p.id, p.breaksDown])).toEqual(SIX.map((id) => [id, id === "goal"]));
    // No built-in pauses, runs in parallel or needs a provider: those capabilities stay in the engine for flow files, unused here.
    for (const p of builtInCatalog()) expect(p.steps.some((s) => s.gate || s.parallel || s.independentOf), p.id).toBe(false);
  });

  it("ORC-021: a security review runs beside every code review, reads the same inputs, feeds the repair and the verification, and is never a replacement", () => {
    const beside = { change: ["S2", "SR1", "S3", "S4"], bugfix: ["S3", "SR1", "S4", "S5"], feature: ["S3", "SR1", "S5", "S6"] } as const;
    for (const [id, [code, sec, repair, verify]] of Object.entries(beside)) {
      const steps = builtIn(id).steps;
      const by = (sid: string) => steps.find((s) => s.id === sid)!;
      expect(by(code).role, id).toBe("code_reviewer");
      expect(by(sec).role, id).toBe("security_reviewer");
      expect(by(sec).purpose, id).toBe("Security review");
      // Parallel: the same prerequisites and inputs, neither waits for the other.
      expect(by(sec).dependsOn, id).toEqual(by(code).dependsOn);
      expect(by(sec).inputs, id).toEqual(by(code).inputs);
      expect(by(code).dependsOn, id).not.toContain(sec);
      expect(by(sec).outputs, id).toEqual([{ name: "findings", kind: "review-findings" }]);
      // The repair reads both and runs if either has findings; both are in the loop body.
      expect(by(repair).dependsOn, id).toEqual(expect.arrayContaining([code, sec]));
      expect(by(repair).inputs, id).toEqual(expect.arrayContaining([{ step: code, output: "findings" }, { step: sec, output: "findings" }]));
      expect(by(repair).runIf, id).toEqual(expect.arrayContaining([{ step: code, output: "findings" }, { step: sec, output: "findings" }]));
      const from = steps.findIndex((s) => s.id === by(repair).iterate!.from);
      const to = steps.findIndex((s) => s.id === repair);
      expect(ids(steps.slice(from, to + 1)), id).toEqual(expect.arrayContaining([code, sec, repair]));
      // The verification reads both.
      expect(by(verify).role, id).toBe("lead");
      expect(by(verify).inputs, id).toEqual(expect.arrayContaining([{ step: code, output: "findings" }, { step: sec, output: "findings" }]));
      // Without the code review the flow would be unreviewed: the security review does not stand in for it.
      const without = steps.filter((s) => s.id !== code).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== code), inputs: s.inputs.filter((r) => r.step !== code), ...(s.runIf ? { runIf: s.runIf.filter((r) => r.step !== code) } : {}) }));
      expect(unreviewedReasons(without).length, id).toBeGreaterThan(0);
    }
    // The internal pipelines too.
    const revert = INTERNAL_FLOWS.find((p) => p.id === "revert")!.steps;
    expect(revert.find((s) => s.id === "SR1")).toMatchObject({ role: "security_reviewer", dependsOn: ["S1"], inputs: revert.find((s) => s.id === "S2")!.inputs });
    expect(revert.find((s) => s.id === "C1")!.dependsOn).toEqual(["S2", "SR1"]);
    expect(revert.find((s) => s.id === "S3")!.inputs).toEqual(expect.arrayContaining([{ step: "S2", output: "findings" }, { step: "SR1", output: "findings" }]));
    const review = INTERNAL_FLOWS.find((p) => p.id === "delivery-review")!.steps;
    expect(review.map((s) => [s.id, s.role, s.independentOf])).toEqual([
      ["S1", "code_reviewer", "writer"],
      ["SR1", "security_reviewer", "writer"],
    ]);
    expect(INTERNAL_FLOWS.find((p) => p.id === "delivery-checks")!.steps.map((s) => s.role)).toEqual(["checks"]);
  });

  it("Design and Investigation are unchanged: no security review, since neither produces code", () => {
    for (const id of ["design", "investigation", "goal"]) expect(builtIn(id).steps.some((s) => s.role === "security_reviewer"), id).toBe(false);
    expect(ids(builtIn("design").steps)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(ids(builtIn("investigation").steps)).toEqual(["S1", "S2", "S3"]);
    expect(ids(builtIn("goal").steps)).toEqual(["S1", "S2", "S3"]);
  });
});

describe("the resolver's rules (a broken file is a test failure, never a runtime state)", () => {
  const resolve = (...files: FlowFile[]) => resolveFlows([...BUILT_IN_FILES, ...files]);

  it("a graph error, a misnamed file, a duplicate id, an internal id, a bad id and a missing whenToUse throw, naming the file", () => {
    expect(() => resolve(file("xx", { steps: [{ ...oneStep[0], dependsOn: ["S9"] }] }))).toThrow(/flows\/xx\.json: S1 depends on S9/);
    expect(() => resolve(file("mine", { steps: reviewed }, "other.json"))).toThrow(/named "other" but declares the id "mine"/);
    expect(() => resolve(file("change", { steps: reviewed }))).toThrow(/the id "change" appears twice/);
    for (const id of INTERNAL_FLOW_IDS) expect(() => resolve(file(id, { steps: reviewed }))).toThrow(/the service owns/);
    expect(() => resolve(file("Bad", { steps: reviewed }))).toThrow(/id must be lowercase/);
    expect(() => resolve(file("xx", { steps: reviewed, whenToUse: " " }))).toThrow(/whenToUse is required/);
    expect(() => resolve(file("xx", { steps: [] }))).toThrow(/1–30 steps/);
  });

  it("step ids the service reserves and checks.only are refused; a Checks step may not choose among best-of candidates", () => {
    for (const id of ["S1-c2", "S1-i3", "C2-r1-checks", "C2-r12-review", "C2-r1-fix", "C2-r1-security"]) expect(() => resolve(file("xx", { steps: [{ ...oneStep[0], id }] })), id).toThrow(/reserved/);
    for (const id of ["S1-review", "C2-r1", "S1-rename"]) expect(() => resolve(file("xx", { steps: [...reviewed.map((s) => (s.id === "S1" ? { ...s, id } : { ...s, dependsOn: [id], inputs: [{ step: id, output: "change" }] }))] })), id).not.toThrow();
    const only: StepDef[] = [...reviewed, { id: "C1", purpose: "Checks", role: "checks", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings", only: ["lint"] } }];
    expect(() => resolve(file("xx", { steps: only }))).toThrow(/C1\.checks\.only: check commands belong to each project; flows run every configured check/);
    const bestOf: StepDef[] = [
      { ...oneStep[0], parallel: { count: 2, mode: "best-of" } },
      { id: "C1", purpose: "Checks", role: "checks", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings" } },
      { id: "S2", purpose: "Review", role: "code_reviewer", dependsOn: ["C1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
    ];
    expect(() => resolve(file("xx", { steps: bestOf }))).toThrow(/C1 chooses among S1's candidates, so it cannot be a Checks step/);
    // The engine capabilities a flow file may still use: a gate, parallel best-of with an agent chooser, independence.
    const chosen: StepDef[] = [{ ...oneStep[0], parallel: { count: 2, mode: "best-of", providers: ["claude", "codex"] } }, { id: "S2", purpose: "Choose and review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }], independentOf: "writer" }, { id: "S3", purpose: "Verify", role: "lead", dependsOn: ["S2"], inputs: [{ step: "S2", output: "findings" }], outputs: [{ name: "verification", kind: "verification" }], gate: true }];
    const ok = resolve(file("two", { steps: chosen })).find((p) => p.id === "two")!;
    expect(ok.steps[0].parallel).toEqual({ count: 2, mode: "best-of", providers: ["claude", "codex"] });
    expect(ok.steps[2].gate).toBe(true);
    expect(flowSummary(ok.steps)).toBe("S1 Implement (parallel ×2 best of) → S2 Choose and review (reviewed by the other provider) → S3 Verify (pauses for you)");
  });

  it("the files the service creates fix tasks from (change, bugfix) must change code, be reviewed, not break down and not pause", () => {
    const own = (id: string, steps: StepDef[]) => resolveFlows([...BUILT_IN_FILES.filter((f) => f.raw.id !== id), file(id, { steps })]);
    expect(() => own("change", oneStep)).toThrow(/the service creates fix tasks from "change", so it must have an independent code review of every code change/);
    expect(() => own("bugfix", [{ id: "S1", purpose: "Investigate", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "report", kind: "report" }] }])).toThrow(/must produce a code change/);
    expect(() => own("change", builtIn("change").steps.map((s) => (s.id === "S1" ? { ...s, gate: true as const } : s)))).toThrow(/must not pause for a person/);
    expect(() => own("change", [...reviewed, { id: "S3", purpose: "Plan more", role: "designer", dependsOn: ["S2"], inputs: [], outputs: [{ name: "plan", kind: "breakdown" }] }])).toThrow(/must not break down into child tasks/);
    // A review that may be skipped is not a review.
    const skippable = builtIn("change").steps.map((s) => (s.id === "S2" ? { ...s, runIf: [{ step: "C1", output: "checks" }] } : s));
    expect(() => own("change", skippable)).toThrow(/a review with runIf may be skipped/);
    expect(own("change", builtIn("change").steps).map((p) => p.id).sort()).toEqual([...SIX].sort());
  });

  it("the review rule: code from a reviewer, lead or designer is unreviewed; a repair inside a loop is reviewed by the next iteration's unconditional review", () => {
    for (const role of ["code_reviewer", "security_reviewer", "ux_reviewer", "lead", "designer"] as const) {
      const steps: StepDef[] = [...reviewed, { id: "S3", purpose: "Tweak", role, dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "change", kind: "code-change" }] }];
      expect(unreviewedReasons(steps).some((w) => /S3 changes code as a .*; only coder steps may change code/.test(w)), role).toBe(true);
    }
    const checks = (id: string, after: string): StepDef => ({ id, purpose: "Checks", role: "checks", dependsOn: [after], inputs: [{ step: after, output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings" } });
    const loop: StepDef[] = [oneStep[0], checks("C1", "S1"), { ...reviewed[1], dependsOn: ["S1", "C1"] }, { id: "S3", purpose: "Repair", role: "coder", dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }, { step: "S2", output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S2", output: "findings" }], iterate: { from: "C1", max: 3 } }];
    expect(unreviewedReasons(loop)).toEqual([]);
    expect(unreviewedReasons(loop.map((s) => (s.id === "S3" ? { ...s, iterate: { from: "C1", max: 1 } } : s)))).toEqual(["S3's code change is not read by a code reviewer that always runs"]);
    expect(unreviewedReasons(loop.map((s) => (s.id === "S3" ? { ...s, runIf: undefined } : s)))).toEqual(["S3's code change is not read by a code reviewer that always runs"]);
    // A security review alone does not make a change reviewed.
    const securityOnly: StepDef[] = [...oneStep, { id: "SR1", purpose: "Security review", role: "security_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] }];
    expect(unreviewedReasons(securityOnly)).toEqual(["S1's code change is not read by a code reviewer that always runs"]);
  });
});

describe("who may use what", () => {
  it("the lead and the project default may use any of the six; a breakdown item any flow but Goal", () => {
    const s = seed();
    expect(eligibleIds(s, "lead")).toEqual(SIX);
    expect(eligibleIds(s, "default")).toEqual(SIX);
    expect(eligibleIds(s, "child")).toEqual(["change", "bugfix", "feature", "design", "investigation"]);
    expect(eligible(builtIn("goal"), "child")).toBe(false);
    expect(eligible(builtIn("goal"), "lead")).toBe(true);
  });

  it("effectiveDefault is the project default when it exists, else Change; childDefault never breaks down", () => {
    const s = seed();
    expect(effectiveDefault(s).id).toBe("change");
    expect(effectiveDefault({ ...s, project: { ...s.project, defaultFlowId: "feature" } }).id).toBe("feature");
    expect(effectiveDefault({ ...s, project: { ...s.project, defaultFlowId: "change-lean" } }).id).toBe("change");
    const goal = { ...s, project: { ...s.project, defaultFlowId: "goal" } };
    expect(effectiveDefault(goal).id).toBe("goal");
    expect(childDefault(goal).id).toBe("change");
  });
});

describe("hashes and references", () => {
  it("the hash follows what runs: stable across key order, changed by a purpose, not by a description", () => {
    const a = builtIn("change");
    const reordered = a.steps.map((s) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(s).reverse()))) as StepDef);
    expect(flowHash(reordered)).toBe(a.hash);
    expect(flowHash(a.steps.map((s) => (s.id === "S1" ? { ...s, purpose: "Implement carefully" } : s)))).not.toBe(a.hash);
    const described = resolveFlows([...BUILT_IN_FILES.filter((f) => f.raw.id !== "change"), file("change", { steps: a.steps, description: "Another description" })]).find((p) => p.id === "change")!;
    expect(described.hash).toBe(a.hash);
  });

  it("a reference records id, name, source, hash and who chose; an internal pipeline's hash is of its steps", () => {
    expect(flowRef(builtIn("feature"), "lead")).toEqual({ id: "feature", name: "Feature", source: "built-in", hash: builtIn("feature").hash, chosenBy: "lead" });
    const revert = INTERNAL_FLOWS.find((p) => p.id === "revert")!;
    expect(flowRef(revert, "service")).toEqual({ id: "revert", name: "Revert", source: "internal", hash: flowHash(revert.steps), chosenBy: "service" });
  });

  it("flowSummary names every step with its markers", () => {
    expect(flowSummary(builtIn("change").steps)).toBe(
      "S1 Implement → C1 Run the project's checks (run by the service) → S2 Code review → SR1 Security review → S3 Repair review findings and failing checks (if findings, repeats) → C2 Final checks (run by the service) → S4 Verify and integrate",
    );
    expect(flowSummary(builtIn("goal").steps)).toContain("S1 Plan the goal and break it into independent tasks (breakdown)");
    expect(flowSummary(builtIn("goal").steps)).toContain("S2 Evaluate the finished tasks against the goal; list any remaining work (repeats, waits for child tasks, breakdown)");
  });
});
