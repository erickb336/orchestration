// ORC-021: every path that creates a task chooses a flow and records who chose it. You and the lead may
// choose any of the six; a breakdown item any flow but Goal; the project default any of the six; the
// service's own paths name theirs; follow-ups re-apply the current flow.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as D from "./delivery";
import { buildDemo } from "./demo";
import * as M from "./model";
import { setPipeline } from "./testing/pipelines";
import { builtInCatalog, childDefault, effectiveDefault, flowHash, internalFlow } from "./flows";
import { toDef } from "./pipeline";
import { buildSeed } from "./seed";
import type { State, StepDef } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const seed = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const builtIn = (id: string) => builtInCatalog().find((p) => p.id === id)!;
const newTask = (s: State, over: Partial<M.NewTask> = {}) =>
  M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change", ...over }, at(0));
const oneStep: StepDef[] = [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }];
const SIX = "change, bugfix, feature, design, investigation, goal";
const proposal = (over: Record<string, unknown> = {}) => ({
  title: `P ${Math.random().toString(36).slice(2, 8)}`,
  area: "Core",
  whyNow: "now",
  outcome: "done",
  benefit: "b",
  scopeIncluded: [],
  scopeExcluded: [],
  options: [
    { id: "A", name: "Do it", approach: "one way", benefit: "", effort: "", risks: "", reversibility: "" },
    { id: "B", name: "Defer", approach: "not now", benefit: "", effort: "", risks: "", reversibility: "" },
  ],
  recommendedOptionId: "A",
  rationale: "because",
  uncertainty: "",
  acceptance: ["it works"],
  priority: 3,
  ...over,
});
/** Run one lead reply through the real path: start a run, complete it with proposals. */
function leadProposes(s0: State, proposals: Record<string, unknown>[]): { state: State; created: string[]; rejected: string[] } {
  // Room for every proposal: the sample project already holds lead-proposed tasks.
  const s = structuredClone(s0);
  s.project.autonomy = { ...s.project.autonomy, maxOpenProposals: 50, maxProposalsPerCycle: 10 };
  const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(1));
  const next = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: proposals as unknown as M.LeadProposal[] }, at(2));
  const msg = next.conversation.filter((m) => m.author === "lead").pop()!;
  return { state: next, created: msg.proposedTaskIds ?? [], rejected: msg.rejected ?? [] };
}

describe("createTask (you)", () => {
  it("any of the six flows, with the provenance chosen by you", () => {
    for (const id of ["change", "bugfix", "feature", "design", "investigation", "goal"]) {
      const r = newTask(seed(), { flowId: id });
      const t = task(r.state, r.newId);
      const p = builtIn(id);
      expect(t.steps.map((x) => x.id), id).toEqual(p.steps.map((x) => x.id));
      expect(t.flow, id).toEqual({ id: p.id, name: p.name, source: "built-in", hash: p.hash, chosenBy: "user" });
      expect(t.flowSince, id).toBe(1);
      expect(t.pipelineHistory[0], id).toMatchObject({ rev: 1, reason: `Created from the ${p.name} flow`, flow: { id: p.id, hash: p.hash } });
    }
  });

  it("the service's own pipelines, the removed catalog entries and unknown ids are refused", () => {
    expect(() => newTask(seed(), { flowId: "revert" })).toThrow(/The Revert flow is used by Send back only\./);
    expect(() => newTask(seed(), { flowId: "delivery-review" })).toThrow(/The Delivery review flow is used by the service only\./);
    expect(() => newTask(seed(), { flowId: "delivery-checks" })).toThrow(/Delivery checks flow is used by the service only/);
    expect(() => newTask(seed(), { flowId: "nope" })).toThrow(/Unknown flow nope/);
    expect(() => newTask(seed(), { flowId: "change-best-of-two" })).toThrow(/Unknown flow change-best-of-two/);
  });

  it("the command takes flowId and never reads steps", () => {
    const r = runCommand(seed(), "createTask", { title: "t", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, flowId: "change", steps: oneStep }, at(0));
    const t = task(r.state, (r.result as { newId: string }).newId);
    expect(t.steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "SR1", "S3", "C2", "S4"]);
    expect(() => runCommand(seed(), "createTask", { title: "t", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, steps: oneStep }, at(0))).toThrow(/flowId must be a string/);
    expect(() => runCommand(seed(), "createTask", { title: "t", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, patternId: "change" }, at(0))).toThrow(/flowId must be a string/);
  });
});

describe("lead proposals", () => {
  it("a named flow is chosen by the lead; an omitted one takes the default, chosen by default; any of the six is accepted", () => {
    const { state, created, rejected } = leadProposes(seed(), [proposal({ flowId: "feature" }), proposal({}), proposal({ flowId: "bugfix" }), proposal({ flowId: "goal" }), proposal({ flowId: "design" }), proposal({ flowId: "investigation" })]);
    expect(rejected).toEqual([]);
    expect(created).toHaveLength(6);
    const [a, b, c, d] = created.map((id) => task(state, id));
    expect(a.flow).toMatchObject({ id: "feature", source: "built-in", chosenBy: "lead", hash: builtIn("feature").hash });
    expect(a.steps.map((x) => x.id)).toEqual(builtIn("feature").steps.map((x) => x.id));
    expect(a.pipelineHistory[0]).toMatchObject({ reason: "Created from the Feature flow", flow: { id: "feature" } });
    expect(b.flow).toMatchObject({ id: "change", chosenBy: "default" });
    expect(c.flow).toMatchObject({ id: "bugfix", chosenBy: "lead" });
    expect(d.flow).toMatchObject({ id: "goal", chosenBy: "lead" });
  });

  it("unknown ids, the removed catalog entries, the old alias and internal ids are rejected, naming the six", () => {
    const bad = ["nope", "change-best-of-two", "change-cross-review", "feature-design-gate", "revert", "delivery-review"];
    const { state, created, rejected } = leadProposes(seed(), bad.map((flowId) => proposal({ flowId })));
    expect(created).toEqual([]);
    expect(rejected).toHaveLength(bad.length);
    for (const [i, id] of bad.entries()) expect(rejected[i]).toMatch(new RegExp(`unknown flow "${id}"; choose one of: ${SIX}`));
    expect(state.tasks.length).toBe(seed().tasks.length);
    // A non-string id is rejected before anything else is read; the old names are not aliases.
    expect(M.validateProposal(seed(), proposal({ flowId: 3 }) as unknown as M.LeadProposal, at(1))).toBe("flowId must be text");
    const aliased = leadProposes(seed(), [proposal({ patternId: "feature" }), proposal({ templateId: "feature" })]);
    expect(aliased.rejected).toEqual([]);
    expect(aliased.created.map((id) => task(aliased.state, id).flow.id)).toEqual(["change", "change"]);
  });
});

describe("breakdown items", () => {
  /** A Goal task whose plan step completes with `items`, through the real completion path. */
  function breakDown(s0: State, items: unknown[]): { state: State; id: string } {
    const r = newTask(s0, { flowId: "goal" });
    let s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(1)), at(2));
    const [plan] = M.activeAttempts(s, r.newId);
    expect(plan.stepId).toBe("S1");
    s = M.reportCompletion(s, plan.id, [], at(3), [{ name: "plan", summary: "the plan", items }]);
    return { state: s, id: r.newId };
  }
  const item = (title: string, over: Record<string, unknown> = {}) => ({ title, outcome: `${title} done`, approach: "small", acceptance: [`${title} ok`], ...over });

  it("an item without a flow takes the child default; a named one is chosen by the breakdown; Goal and unknown ids are refused for a child", () => {
    const { state, id } = breakDown(seed(), [item("A"), item("B", { flowId: "bugfix" }), item("C", { flowId: "feature" }), item("D", { flowId: "goal" }), item("E", { flowId: "change-lean" }), item("F", { flowId: "design" }), item("G", { flowId: "investigation" })]);
    const kids = M.childTasks(state, task(state, id));
    expect(kids.map((k) => M.currentSpec(k).content.title)).toEqual(["A", "B", "C", "F", "G"]);
    expect(kids[0].flow).toMatchObject({ id: "change", chosenBy: "default" });
    expect(kids[1].flow).toMatchObject({ id: "bugfix", chosenBy: "breakdown" });
    expect(kids[2].flow).toMatchObject({ id: "feature", chosenBy: "breakdown" });
    const ev = state.events.find((e) => e.taskId === id && /rejected/.test(e.message))!.message;
    expect(ev).toMatch(/#4: child tasks cannot break down further \(flow "Goal"\); use a flow without breakdown steps: change, bugfix, feature, design, investigation/);
    expect(ev).toMatch(/#5: unknown flow "change-lean"; choose one of: change, bugfix, feature, design, investigation/);
  });

  it("the child default falls back to Change when the project default is Goal", () => {
    const s = M.setDefaultFlow(seed(), "goal", at(0));
    expect(effectiveDefault(s).id).toBe("goal");
    expect(childDefault(s).id).toBe("change");
    const { state, id } = breakDown(s, [item("A")]);
    expect(M.childTasks(state, task(state, id))[0].flow).toMatchObject({ id: "change", chosenBy: "default" });
  });
});

describe("the project default", () => {
  it("setDefaultFlow takes any of the six and records an event; the lead's omitted flow follows it", () => {
    let s = M.setDefaultFlow(seed(), "feature", at(0));
    expect(s.project.defaultFlowId).toBe("feature");
    expect(s.events.at(-1)!.message).toBe("Default flow: Feature (feature)");
    for (const id of ["change", "bugfix", "feature", "design", "investigation", "goal"]) expect(M.setDefaultFlow(s, id, at(1)).project.defaultFlowId, id).toBe(id);
    expect(() => M.setDefaultFlow(s, "change-best-of-two", at(1))).toThrow(/Unknown flow change-best-of-two/);
    expect(() => M.setDefaultFlow(s, "revert", at(1))).toThrow(/the service owns/);
    expect(() => M.setDefaultFlow(s, "nope", at(1))).toThrow(/Unknown flow nope/);
    const { state, created } = leadProposes(s, [proposal({})]);
    expect(task(state, created[0]).flow).toMatchObject({ id: "feature", chosenBy: "default" });
    s = runCommand(s, "setDefaultFlow", { flowId: "change" }, at(2)).state;
    expect(s.project.defaultFlowId).toBe("change");
    expect(() => runCommand(s, "setDefaultPattern", { patternId: "change" }, at(2))).toThrow(/Unknown command setDefaultPattern/);
  });

  it("when the stored default is not among the flows, effectiveDefault is Change and the stored id is kept", () => {
    let s = M.setDefaultFlow(seed(), "investigation", at(0));
    s = M.setFlows(s, builtInCatalog().filter((p) => p.id !== "investigation"), at(1));
    expect(s.project.defaultFlowId).toBe("investigation");
    expect(effectiveDefault(s).id).toBe("change");
  });
});

describe("setFlows", () => {
  it("replaces the flows, records an event only when the set (id, hash) changed, and touches no task", () => {
    let s = seed();
    const before = JSON.stringify(s.tasks);
    const n = s.events.length;
    s = M.setFlows(s, builtInCatalog(), at(1));
    expect(s.events).toHaveLength(n); // the same set
    const edited = builtInCatalog().map((p) => (p.id === "bugfix" ? { ...p, hash: "f".repeat(64) } : p));
    s = M.setFlows(s, edited, at(2));
    expect(s.events.at(-1)!.message).toBe("Flows loaded: Change, Bug fix, Feature, Design, Investigation, Goal");
    expect(s.flows.find((p) => p.id === "bugfix")!.hash).toBe("f".repeat(64));
    expect(JSON.stringify(s.tasks)).toBe(before);
  });
});

describe("follow-ups", () => {
  /** A done task made from `flowId`, with a pin on S1. */
  function doneTask(s0: State, flowId: string): { state: State; id: string } {
    const r = newTask(s0, { flowId });
    let s = M.setStepSelection(r.state, r.newId, "S1", { provider: "codex", model: "codex-sample-fast" }, at(1));
    const t = task(s, r.newId);
    t.lifecycle = "done";
    for (const st of t.steps) st.state = "done";
    s = structuredClone(s);
    return { state: s, id: r.newId };
  }

  it("a follow-up of a done Feature task re-applies the current Feature (its new hash after a changed file) and keeps pins with the same id and role", () => {
    const { state: s0, id } = doneTask(seed(), "feature");
    const oldHash = task(s0, id).flow.hash;
    // The feature file changed meanwhile (and the service restarted): a different S2 purpose and a designer S1 as before.
    const edited = builtIn("feature").steps.map((st) => (st.id === "S2" ? { ...st, purpose: "Implement with care" } : st));
    const s = M.setFlows(s0, builtInCatalog().map((p) => (p.id === "feature" ? { ...p, steps: edited, hash: flowHash(edited) } : p)), at(2));
    const current = s.flows.find((p) => p.id === "feature")!;
    expect(current.hash).not.toBe(oldHash);
    const f = M.createFollowUp(s, id, at(5));
    const ft = task(f.state, f.newId);
    expect(ft.flow).toMatchObject({ id: "feature", source: "built-in", hash: current.hash, chosenBy: "follow-up" });
    expect(ft.steps.find((x) => x.id === "S2")!.purpose).toBe("Implement with care");
    expect(ft.steps.find((x) => x.id === "S1")!.selection).toEqual({ provider: "codex", model: "codex-sample-fast" });
    expect(ft.pipelineHistory[0].reason).toBe(`Created from the Feature flow (follow-up to ${id})`);
    // A pin is dropped when the step with that id changed role.
    const swappedSteps = edited.map((st) => (st.id === "S1" ? { ...st, role: "coder" as const, purpose: "Sketch in code" } : st));
    const swapped = M.setFlows(s0, builtInCatalog().map((p) => (p.id === "feature" ? { ...p, steps: swappedSteps, hash: flowHash(swappedSteps) } : p)), at(2));
    const g = M.createFollowUp(swapped, id, at(6));
    expect(task(g.state, g.newId).steps.find((x) => x.id === "S1")!.selection).toBeNull();
  });

  it("a follow-up of a custom (or legacy) task copies its steps and keeps its source", () => {
    const r = newTask(seed(), {});
    let s = setPipeline(r.state, r.newId, 1, oneStep, "one step", "user", at(1));
    const t = task(s, r.newId);
    t.lifecycle = "done";
    for (const st of t.steps) st.state = "done";
    s = structuredClone(s);
    const f = M.createFollowUp(s, r.newId, at(2));
    const ft = task(f.state, f.newId);
    expect(ft.steps.map((x) => x.id)).toEqual(["S1"]);
    expect(ft.flow).toEqual({ id: "custom", name: "Custom pipeline", source: "custom", chosenBy: "follow-up" });
    expect(ft.pipelineHistory[0].reason).toBe(`Copied from ${r.newId}`);
    const legacy = structuredClone(s);
    task(legacy, r.newId).flow = { id: "feature", name: "Feature", source: "legacy", chosenBy: "migration" };
    const l = M.createFollowUp(legacy, r.newId, at(3));
    expect(task(l.state, l.newId).flow).toEqual({ id: "feature", name: "Feature", source: "legacy", chosenBy: "follow-up" });
    expect(task(l.state, l.newId).steps.map((x) => x.id)).toEqual(["S1"]);
  });
});

describe("the service's own paths", () => {
  it("a fix send-back uses Bug fix and a revert the internal pipeline, both chosen by the service", () => {
    let s = seed();
    const landed = task(s, "EX-006");
    landed.integration = { status: "integrated", landed: { at: at(0), via: "local", target: "main", commit: "a".repeat(40), by: "app", flags: [], status: "unreviewed", notes: [], followUps: [] } };
    s = structuredClone(s);
    const fix = D.sendBackLanded(s, { taskId: "EX-006", kind: "fix", note: "broken", holdBeforeStart: false }, at(1));
    expect(task(fix.state, fix.newId).flow).toMatchObject({ id: "bugfix", source: "built-in", chosenBy: "service", hash: builtIn("bugfix").hash });
    expect(task(fix.state, fix.newId).steps.map((x) => x.id)).toEqual(builtIn("bugfix").steps.map((x) => x.id));
    const revert = D.sendBackLanded(fix.state, { taskId: "EX-006", kind: "revert", note: "", holdBeforeStart: false }, at(2));
    const rt = task(revert.state, revert.newId);
    expect(rt.flow).toMatchObject({ id: "revert", name: "Revert", source: "internal", chosenBy: "service" });
    // The hash is of the steps that run, with the commit named in the first writer's purpose.
    expect(rt.steps[0].purpose).toMatch(/\(revert of [0-9a-f]{12}\)$/);
    expect(rt.flow.hash).toBe(flowHash(rt.steps.map(toDef)));
    expect(rt.flow.hash).not.toBe(flowHash(internalFlow("revert").steps));
    expect(rt.pipelineHistory[0].flow).toEqual(rt.flow);
    expect(rt.steps.map((x) => [x.id, x.role])).toEqual([
      ["S1", "coder"],
      ["S2", "code_reviewer"],
      ["SR1", "security_reviewer"],
      ["C1", "checks"],
      ["S3", "lead"],
    ]);
  });

  it("a Markdown import uses the project default, chosen by default", () => {
    const s = M.setDefaultFlow(seed(), "investigation", at(0));
    const r = M.importMarkdown(s, "| ID | Title |\n| --- | --- |\n| IMP-1 | Imported one |\n", at(1));
    expect(r.imported).toEqual(["IMP-1"]);
    const t = task(r.state, "IMP-1");
    expect(t.flow).toMatchObject({ id: "investigation", chosenBy: "default" });
    expect(t.steps.map((x) => x.id)).toEqual(["S1", "S2", "S3"]);
    expect(t.flowSince).toBe(1);
  });

  it("resetSampleData keeps the flows, like initProject", () => {
    const s = M.setFlows(seed(), builtInCatalog().map((p) => (p.id === "change" ? { ...p, hash: "e".repeat(64) } : p)), at(0));
    const r = runCommand(s, "resetSampleData", {}, at(1)).state;
    expect(r.flows).toEqual(s.flows);
    // ORC-017: the reset restores the demo story (not the test fixture); its tasks are back.
    expect(r.tasks.map((t) => t.id)).toEqual(buildDemo(Date.parse(at(1))).tasks.map((t) => t.id));
    expect(r.project.name).toBe("Weekend Trips (sample)");
  });

  it("initProject keeps the flows and resets the default; the seed's tasks carry built-in references", () => {
    const s = M.initProject(M.setDefaultFlow(seed(), "feature", at(0)), { name: "N", repoPath: "/tmp/n", vision: "v", focus: "f" }, at(1));
    expect(s.project.defaultFlowId).toBe("change");
    expect(s.flows.length).toBe(builtInCatalog().length);
    for (const t of seed().tasks) {
      expect(t.flow.source, t.id).toBe("built-in");
      expect(t.flow.chosenBy, t.id).toBe("lead");
      expect(t.flowSince, t.id).toBe(1);
      expect(t.pipelineHistory[0].flow?.id, t.id).toBe(t.flow.id);
    }
  });
});
