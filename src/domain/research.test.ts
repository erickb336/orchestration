// Read-only research steps (ORC-031, unit 31a): the flow schema and the graph rules refuse research on every step
// that writes, a research step's workspace is read-only whatever its role, and Investigation's evidence step is one.

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import schema from "../../flows/flow.schema.json";
import { BUILT_IN_FILES } from "./builtInFlows";
import { builtInCatalog, flowSummary, resolveFlows, type RawFlow } from "./flows";
import { stepAccess, structuralKey, validatePipeline } from "./pipeline";
import { STEP_ROLES, type StepDef } from "./types";

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const errors = (steps: StepDef[]) => validatePipeline(steps).filter((i) => i.severity === "error").map((i) => i.message);

/** A small flow file with the given steps, in the file format. */
const file = (steps: StepDef[]) => ({ id: "probe-flow", name: "Probe", description: "A test flow.", whenToUse: "In tests.", steps });

const research: StepDef = { id: "S1", purpose: "Gather evidence", role: "coder", research: true, dependsOn: [], inputs: [], outputs: [{ name: "report", kind: "report" }] };
const writer: StepDef = { id: "S2", purpose: "Implement", role: "coder", dependsOn: ["S1"], inputs: [{ step: "S1", output: "report" }], outputs: [{ name: "change", kind: "code-change" }] };
const checks: StepDef = { id: "C1", purpose: "Run the checks", role: "checks", dependsOn: ["S2"], inputs: [{ step: "S2", output: "change" }], outputs: [{ name: "results", kind: "check-results" }], checks: { onFail: "findings" } };
const capture: StepDef = { id: "E1", purpose: "Capture evidence", role: "evidence", dependsOn: ["S2"], inputs: [{ step: "S2", output: "change" }], outputs: [{ name: "evidence", kind: "evidence" }] };

describe("the schema and the graph rules refuse research on a step that writes", () => {
  it("accept research on a step that reports", () => {
    expect(validate(file([research])), JSON.stringify(validate.errors)).toBe(true);
    expect(errors([research])).toEqual([]);
  });

  it("refuse research on a step that outputs a code change, for every role", () => {
    for (const role of STEP_ROLES.filter((r) => r !== "checks" && r !== "evidence")) {
      const step: StepDef = { ...writer, id: "S1", role, research: true, dependsOn: [], inputs: [] };
      expect(validate(file([step])), role).toBe(false);
      expect(errors([step]).join(" "), role).toContain("outputs a code change, so it cannot be a research step");
    }
  });

  it("refuse research on a checks step and on a capture of evidence", () => {
    for (const service of [checks, capture]) {
      const steps = [{ ...writer, id: "S2", dependsOn: [], inputs: [] }, { ...service, research: true }];
      expect(validate(file(steps)), service.role).toBe(false);
      expect(errors(steps).join(" "), service.role).toContain("is run by the service, so it cannot be a research step");
    }
  });

  it("refuse research on a step whose findings start a repair that writes code, and allow it when the repair writes a report", () => {
    const review: StepDef = { id: "S1", purpose: "Look for problems", role: "code_reviewer", research: true, dependsOn: [], inputs: [], outputs: [{ name: "findings", kind: "review-findings" }] };
    const repair: StepDef = { id: "S2", purpose: "Fix them", role: "coder", dependsOn: ["S1"], inputs: [{ step: "S1", output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S1", output: "findings" }] };
    expect(errors([review, repair])).toEqual(["S1's findings start S2, which changes code, so S1 cannot be a research step."]);
    // The file passes the schema; the graph rules refuse it, and so does the resolver.
    expect(validate(file([review, repair]))).toBe(true);
    expect(() => resolveFlows([{ file: "flows/probe-flow.json", raw: file([review, repair]) as RawFlow }])).toThrow("cannot be a research step");
    const revise: StepDef = { ...repair, outputs: [{ name: "report", kind: "report" }] };
    expect(errors([review, revise])).toEqual([]);
  });

  it("refuse research that is not exactly true in a file", () => {
    expect(validate(file([{ ...research, research: false }]))).toBe(false);
    expect(validate(file([{ ...research, research: "yes" as unknown as boolean }]))).toBe(false);
  });
});

describe("a research step's workspace", () => {
  it("is read-only for every role; outside research only a coder writes", () => {
    for (const role of STEP_ROLES) {
      expect(stepAccess({ role, research: true }), role).toBe("read");
      expect(stepAccess({ role }), role).toBe(role === "coder" ? "write" : "read");
    }
  });

  it("counts in what the step does: marking a step research changes its structure", () => {
    const { research: _r, ...plain } = research;
    expect(structuralKey(research)).not.toBe(structuralKey(plain));
  });
});

describe("the research steps in the built-in flows", () => {
  it("Investigation's evidence step is research, and no other built-in step is", () => {
    const marked = builtInCatalog().flatMap((f) => f.steps.filter((s) => s.research).map((s) => `${f.id}/${s.id}`));
    expect(marked).toEqual(["investigation/S1"]);
    const s1 = builtInCatalog().find((f) => f.id === "investigation")!.steps[0];
    expect(stepAccess(s1)).toBe("read");
    expect(flowSummary([s1])).toBe("S1 Investigate and gather evidence (read-only research)");
  });

  it("every built-in file still passes the schema", () => {
    for (const f of BUILT_IN_FILES) expect(validate(f.raw), `${f.file}: ${JSON.stringify(validate.errors)}`).toBe(true);
  });
});
