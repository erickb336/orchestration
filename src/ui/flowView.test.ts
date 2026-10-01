// ORC-021: the pure helpers behind the flow picker, the task page's flow line, the Change flow panel and
// Settings → Flows. The components only render what these return.

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { builtInCatalog } from "../domain/flows";
import { buildSeed } from "../domain/seed";
import { ROLES, type FlowRef, type State } from "../domain/types";
import { ROLE_LABEL } from "./common";
import { PIPELINE_CHANGED_MESSAGE, changeConsequences, defaultFlowNote, earlierFlowLabel, flowAtRev, flowLineParts, flowLineText, revisionFlowLabel, sameFlow } from "./flowView";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const catalog = builtInCatalog();
const builtIn = (id: string) => catalog.find((p) => p.id === id)!;

describe("the task page", () => {
  const ref = (over: Partial<FlowRef>): FlowRef => ({ id: "change", name: "Change", source: "built-in", hash: "abcdef0123456789", chosenBy: "user", ...over });

  it("writes the flow line as 'Flow: <name>', and legacy and custom pipelines truthfully; no hash is shown", () => {
    expect(flowLineText(ref({}))).toBe("Flow: Change");
    expect(flowLineParts(ref({}))).toEqual({ prefix: "Flow: ", name: "Change" });
    expect(flowLineText(ref({ source: "internal", id: "revert", name: "Revert" }))).toBe("Flow: Revert");
    expect(flowLineParts(ref({ source: "legacy", id: "feature", name: "Feature", hash: undefined }))).toEqual({ prefix: "From before flows: ", name: "Feature" });
    expect(flowLineParts(ref({ source: "custom", id: "custom", name: "Custom pipeline", hash: undefined }))).toEqual({ prefix: "", name: "Custom pipeline" });
    expect(flowLineText(ref({ source: "custom", id: "custom", name: "Custom pipeline", hash: undefined }))).toBe("Custom pipeline");
    expect(flowLineText(ref({}))).not.toContain("abcdef");
  });

  it("finds the flow in effect at a pipeline revision, skipping expansions, and labels earlier-flow artifacts with it", () => {
    const feature = ref({ id: "feature", name: "Feature" });
    const change = ref({});
    const task = {
      flow: change,
      pipelineHistory: [
        { rev: 1, at: at(0), author: "user" as const, reason: "Created from the Feature flow", steps: [], flow: feature },
        { rev: 2, at: at(1), author: "system" as const, reason: "Expanded S3 into 2 copies", steps: [] },
        { rev: 3, at: at(2), author: "user" as const, reason: "Flow changed from Feature to Change", steps: [], flow: change },
      ],
    };
    expect(flowAtRev(task, 1)?.name).toBe("Feature");
    expect(flowAtRev(task, 2)?.name).toBe("Feature");
    expect(flowAtRev(task, 3)?.name).toBe("Change");
    expect(flowAtRev(task, 0)).toBeUndefined();
    expect(earlierFlowLabel(task, 2)).toBe("earlier flow (r2, Feature)");
    expect(earlierFlowLabel(task, 0)).toBe("earlier flow (r0)");
    expect(revisionFlowLabel(task.pipelineHistory[0])).toBe("Feature");
    expect(revisionFlowLabel(task.pipelineHistory[1])).toBeUndefined();
  });

  it("knows when choosing a flow would change nothing: same id, hash and source", () => {
    const change = builtIn("change");
    expect(sameFlow(ref({ hash: change.hash }), change)).toBe(true);
    expect(sameFlow(ref({ hash: "0000" }), change)).toBe(false);
    expect(sameFlow(ref({ hash: change.hash, source: "legacy" }), change)).toBe(false);
    expect(sameFlow(ref({ hash: change.hash }), builtIn("feature"))).toBe(false);
  });
});

describe("the Change flow panel", () => {
  it("turns a preview into plain sentences: nothing run, pins, decisions and artifacts", () => {
    expect(changeConsequences({ redo: [], pinsKept: [], pinsDropped: [], artifactsKept: 0, decisionsClosed: 0 })).toEqual(["Nothing has run yet, so the pipeline is simply replaced.", "No step has a provider or model pin."]);
    expect(changeConsequences({ redo: ["S1"], pinsKept: ["S1"], pinsDropped: [], artifactsKept: 1, decisionsClosed: 1 })).toEqual([
      "1 completed step starts over (S1); their results stay on the record and are not used again.",
      "Pins kept: S1.",
      "1 open decision is closed.",
      '1 artifact is kept, labelled "earlier flow".',
    ]);
    expect(
      changeConsequences({
        redo: ["S1", "C1", "S2"],
        pinsKept: [],
        pinsDropped: [
          { step: "S2", why: "role changed" },
          { step: "S6", why: "no such step" },
        ],
        artifactsKept: 4,
        decisionsClosed: 2,
      }),
    ).toEqual([
      "3 completed steps start over (S1, C1, S2); their results stay on the record and are not used again.",
      "Pins dropped: S2 (role changed), S6 (no such step).",
      "2 open decisions are closed.",
      '4 artifacts are kept, labelled "earlier flow".',
    ]);
    expect(PIPELINE_CHANGED_MESSAGE).toBe("The pipeline changed while you were choosing; review again.");
  });

  it("matches the domain's preview for a real task (Bug fix → Change): a pin on S1 (coder in both) stays and one on S2 (coder → reviewer) is dropped", () => {
    const s0 = buildSeed(T0, { inFlightRuns: false });
    for (const t of s0.tasks) t.hold = true;
    const r = M.createTask(s0, { title: "Mine", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "bugfix" }, at(0));
    let s: State = r.state;
    const pin = { provider: "claude" as const, model: "claude-sample-large" };
    s = M.setStepSelection(s, r.newId, "S1", pin, at(1));
    s = M.setStepSelection(s, r.newId, "S2", pin, at(2));
    const t = s.tasks.find((x) => x.id === r.newId)!;
    const preview = M.flowChangePreview(s, t, builtIn("change"));
    expect(preview.allowed).toBe(true);
    expect(changeConsequences(preview)).toEqual(["Nothing has run yet, so the pipeline is simply replaced.", "Pins kept: S1.", "Pins dropped: S2 (role changed)."]);
  });
});

describe("roles in the UI", () => {
  it("every role has a label; ORC-021 adds the security reviewer", () => {
    for (const r of ROLES) expect(ROLE_LABEL[r], r).toBeTruthy();
    expect(ROLE_LABEL.security_reviewer).toBe("Security reviewer");
  });
});

describe("Settings → Flows", () => {
  it("notes a stored default that is not one of the flows, and says nothing otherwise", () => {
    expect(defaultFlowNote("change", catalog, builtIn("change"))).toBeUndefined();
    expect(defaultFlowNote("goal", catalog, builtIn("goal"))).toBeUndefined();
    expect(defaultFlowNote("change-lean", catalog, builtIn("change"))).toBe('Using Change: "change-lean" is not one of the flows.');
  });
});
