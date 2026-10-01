// ORC-016 step 1: every path that creates a task chooses a pattern and records who chose it (P5, P13).
// You may choose anything in the catalog; the lead, breakdown items and the project default get standard
// patterns only; the service's own paths name theirs; follow-ups re-apply the current pattern.

import { describe, expect, it } from "vitest";
import { BUILT_IN_FILES } from "./builtInPatterns";
import { runCommand } from "./commands";
import * as D from "./delivery";
import { buildDemo } from "./demo";
import * as M from "./model";
import { builtInCatalog, childDefault, effectiveDefault, internalPattern, patternHash, resolveCatalog, type PatternFile } from "./patterns";
import { toDef } from "./pipeline";
import { buildSeed } from "./seed";
import type { State, StepDef } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const seed = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const builtIn = (id: string) => builtInCatalog().patterns.find((p) => p.id === id)!;
const newTask = (s: State, over: Partial<M.NewTask> = {}) =>
  M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change", ...over }, at(0));
const oneStep: StepDef[] = [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }];
const localFile = (id: string, over: Record<string, unknown>): PatternFile => ({ file: `~/.orchestration/patterns/${id}.json`, source: "local", raw: { id, name: id, description: "d", whenToUse: "w", ...over } as PatternFile["raw"] });
/** The seed with the built-in catalog plus files of yours. */
function withLocal(s: State, ...files: PatternFile[]): State {
  const r = resolveCatalog([...BUILT_IN_FILES, ...files]);
  return M.setPatternCatalog(s, { loadedAt: at(0), localDir: "~/.orchestration/patterns", patterns: r.patterns, errors: r.errors }, at(0));
}
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
  it("any catalog pattern, experiments included, with the provenance chosen by you", () => {
    const r = newTask(seed(), { patternId: "change-best-of-two" });
    const t = task(r.state, r.newId);
    const p = builtIn("change-best-of-two");
    expect(t.steps.map((x) => x.id)).toEqual(p.steps.map((x) => x.id));
    expect(t.pattern).toEqual({ id: p.id, name: p.name, source: "built-in", hash: p.hash, chain: p.chain, experimental: true, chosenBy: "user" });
    expect(t.patternSince).toBe(1);
    expect(t.pipelineHistory[0]).toMatchObject({ rev: 1, reason: "Created from the Change, best of two implementations pattern", pattern: { id: p.id, hash: p.hash } });
    const gated = newTask(seed(), { patternId: "feature-design-gate" });
    expect(task(gated.state, gated.newId).steps[0].gate).toBe(true);
  });

  it("the service's own pipelines and unknown ids are refused with the existing messages", () => {
    expect(() => newTask(seed(), { patternId: "revert" })).toThrow(/The Revert pattern is used by Send back only\./);
    expect(() => newTask(seed(), { patternId: "delivery-review" })).toThrow(/The Delivery review pattern is used by the service only\./);
    expect(() => newTask(seed(), { patternId: "delivery-checks" })).toThrow(/Delivery checks pattern is used by the service only/);
    expect(() => newTask(seed(), { patternId: "nope" })).toThrow(/Unknown pattern nope/);
  });

  it("the command takes patternId and never reads steps (P1)", () => {
    const r = runCommand(seed(), "createTask", { title: "t", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, patternId: "change", steps: oneStep }, at(0));
    const t = task(r.state, (r.result as { newId: string }).newId);
    expect(t.steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "S3", "C2", "S4"]);
    expect(() => runCommand(seed(), "createTask", { title: "t", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, steps: oneStep }, at(0))).toThrow(/patternId must be a string/);
  });
});

describe("lead proposals", () => {
  it("a named standard pattern is chosen by the lead; an omitted one takes the default, chosen by default; templateId is an alias", () => {
    const { state, created, rejected } = leadProposes(seed(), [proposal({ patternId: "feature" }), proposal({}), proposal({ templateId: "bugfix" })]);
    expect(rejected).toEqual([]);
    expect(created).toHaveLength(3);
    const [a, b, c] = created.map((id) => task(state, id));
    expect(a.pattern).toMatchObject({ id: "feature", source: "built-in", chosenBy: "lead", hash: builtIn("feature").hash });
    expect(a.steps.map((x) => x.id)).toEqual(builtIn("feature").steps.map((x) => x.id));
    expect(a.pipelineHistory[0]).toMatchObject({ reason: "Created from the Feature pattern", pattern: { id: "feature" } });
    expect(b.pattern).toMatchObject({ id: "change", chosenBy: "default" });
    expect(c.pattern).toMatchObject({ id: "bugfix", chosenBy: "lead" });
  });

  it("unknown, experimental, pausing, unreviewed and internal ids are rejected, naming the valid ids", () => {
    const s = withLocal(seed(), localFile("quick", { steps: oneStep }));
    expect(s.patterns.patterns.find((p) => p.id === "quick")!.flags.unreviewed).toBe(true);
    const bad = ["nope", "change-best-of-two", "feature-design-gate", "quick", "revert", "delivery-review"];
    const { state, created, rejected } = leadProposes(s, bad.map((patternId) => proposal({ patternId })));
    expect(created).toEqual([]);
    expect(rejected).toHaveLength(bad.length);
    for (const [i, id] of bad.entries()) expect(rejected[i]).toMatch(new RegExp(`pattern "${id}" is not available to the lead; choose one of: change, change-cross-review, feature, bugfix, investigation, design, goal`));
    expect(state.tasks.length).toBe(seed().tasks.length);
    // A non-string pattern id is rejected before anything else is read.
    expect(M.validateProposal(s, proposal({ patternId: 3 }) as unknown as M.LeadProposal, at(1))).toBe("patternId must be text");
  });

  it("a standard file of yours is the lead's to use", () => {
    const s = withLocal(seed(), localFile("mine", { steps: builtIn("change").steps }));
    const { state, created, rejected } = leadProposes(s, [proposal({ patternId: "mine" })]);
    expect(rejected).toEqual([]);
    expect(task(state, created[0]).pattern).toMatchObject({ id: "mine", source: "local", chosenBy: "lead" });
  });
});

describe("breakdown items", () => {
  /** A Goal task whose plan step completes with `items`, through the real completion path. */
  function breakDown(s0: State, items: unknown[]): { state: State; id: string } {
    const r = newTask(s0, { patternId: "goal" });
    let s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(1)), at(2));
    const [plan] = M.activeAttempts(s, r.newId);
    expect(plan.stepId).toBe("S1");
    s = M.reportCompletion(s, plan.id, [], at(3), [{ name: "plan", summary: "the plan", items }]);
    return { state: s, id: r.newId };
  }
  const item = (title: string, over: Record<string, unknown> = {}) => ({ title, outcome: `${title} done`, approach: "small", acceptance: [`${title} ok`], ...over });

  it("an item without a pattern takes the child default; a named standard one is chosen by the breakdown; goal is refused for a child", () => {
    const { state, id } = breakDown(seed(), [item("A"), item("B", { patternId: "bugfix" }), item("C", { templateId: "feature" }), item("D", { patternId: "goal" }), item("E", { patternId: "change-lean" })]);
    const kids = M.childTasks(state, task(state, id));
    expect(kids.map((k) => M.currentSpec(k).content.title)).toEqual(["A", "B", "C"]);
    expect(kids[0].pattern).toMatchObject({ id: "change", chosenBy: "default" });
    expect(kids[1].pattern).toMatchObject({ id: "bugfix", chosenBy: "breakdown" });
    expect(kids[2].pattern).toMatchObject({ id: "feature", chosenBy: "breakdown" });
    const ev = state.events.find((e) => e.taskId === id && /rejected/.test(e.message))!.message;
    expect(ev).toMatch(/#4: child tasks cannot break down further \(pattern "Goal"\); use a pattern without breakdown steps: change, change-cross-review, feature, bugfix, investigation, design/);
    expect(ev).toMatch(/#5: pattern "change-lean" is not available to the lead/);
  });

  it("the child default falls back to change when the project default breaks down", () => {
    const s = M.setDefaultPattern(seed(), "goal", at(0));
    expect(effectiveDefault(s).id).toBe("goal");
    expect(childDefault(s).id).toBe("change");
    const { state, id } = breakDown(s, [item("A")]);
    expect(M.childTasks(state, task(state, id))[0].pattern).toMatchObject({ id: "change", chosenBy: "default" });
  });
});

describe("the project default", () => {
  it("setDefaultPattern takes standard patterns only and records an event; the lead's omitted pattern follows it", () => {
    let s = M.setDefaultPattern(seed(), "feature", at(0));
    expect(s.project.defaultPatternId).toBe("feature");
    expect(s.events.at(-1)!.message).toBe("Default pattern: Feature (feature)");
    expect(() => M.setDefaultPattern(s, "change-best-of-two", at(1))).toThrow(/must be a standard pattern/);
    expect(() => M.setDefaultPattern(s, "feature-design-gate", at(1))).toThrow(/must be a standard pattern/);
    expect(() => M.setDefaultPattern(s, "revert", at(1))).toThrow(/the service owns/);
    expect(() => M.setDefaultPattern(s, "nope", at(1))).toThrow(/Unknown pattern nope/);
    const { state, created } = leadProposes(s, [proposal({})]);
    expect(task(state, created[0]).pattern).toMatchObject({ id: "feature", chosenBy: "default" });
    s = runCommand(s, "setDefaultPattern", { patternId: "change" }, at(2)).state;
    expect(s.project.defaultPatternId).toBe("change");
  });

  it("when the default leaves the catalog, effectiveDefault is change and the stored id is kept", () => {
    let s = M.setDefaultPattern(seed(), "investigation", at(0));
    const without = { ...builtInCatalog(), loadedAt: at(1), patterns: builtInCatalog().patterns.filter((p) => p.id !== "investigation") };
    s = M.setPatternCatalog(s, without, at(1));
    expect(s.project.defaultPatternId).toBe("investigation");
    expect(effectiveDefault(s).id).toBe("change");
    // A default that became user-only (a file of yours replaced it with an experiment) falls back too.
    const exp = withLocal(M.setDefaultPattern(seed(), "design", at(0)), localFile("design", { steps: builtIn("design").steps, experimental: true, hypothesis: "h" }));
    expect(exp.patterns.patterns.find((p) => p.id === "design")!.audience).toBe("user-only");
    expect(effectiveDefault(exp).id).toBe("change");
  });
});

describe("setPatternCatalog", () => {
  it("replaces the catalog, records an event only when the set or the errors changed, and touches no task (P3)", () => {
    let s = seed();
    const before = JSON.stringify(s.tasks);
    const n = s.events.length;
    s = M.setPatternCatalog(s, { ...builtInCatalog(), loadedAt: at(1), localDir: "~/x" }, at(1));
    expect(s.events).toHaveLength(n); // the same set
    expect(s.patterns.loadedAt).toBe(at(1));
    s = withLocal(s, localFile("mine", { steps: builtIn("change").steps }));
    expect(s.events.at(-1)!.message).toBe("Patterns loaded: 12 (1 yours)");
    s = M.setPatternCatalog(s, { ...s.patterns, errors: [{ file: "~/x/bad.json", message: "JSON syntax", line: 2, column: 3, effect: "skipped" }] }, at(3));
    expect(s.events.at(-1)!.message).toBe("Patterns loaded: 12 (1 yours); 1 file has errors");
    expect(JSON.stringify(s.tasks)).toBe(before);
  });
});

describe("follow-ups", () => {
  /** A done task made from `patternId`, with a pin on S1. */
  function doneTask(s0: State, patternId: string): { state: State; id: string } {
    const r = newTask(s0, { patternId });
    let s = M.setStepSelection(r.state, r.newId, "S1", { provider: "codex", model: "codex-sample-fast" }, at(1));
    const t = task(s, r.newId);
    t.lifecycle = "done";
    for (const st of t.steps) st.state = "done";
    s = structuredClone(s);
    return { state: s, id: r.newId };
  }

  it("a follow-up of a done Feature task re-applies the current feature (its new hash) and keeps pins with the same id and role", () => {
    const { state: s0, id } = doneTask(seed(), "feature");
    const oldHash = task(s0, id).pattern.hash;
    // The catalog's feature changed meanwhile: a file of yours with a different S2 purpose and a designer S1 as before.
    const edited = builtIn("feature").steps.map((st) => (st.id === "S2" ? { ...st, purpose: "Implement with care" } : st));
    const s = withLocal(s0, localFile("feature", { steps: edited }));
    const current = s.patterns.patterns.find((p) => p.id === "feature")!;
    expect(current.hash).not.toBe(oldHash);
    const f = M.createFollowUp(s, id, at(5));
    const ft = task(f.state, f.newId);
    expect(ft.pattern).toMatchObject({ id: "feature", source: "local", hash: current.hash, chosenBy: "follow-up" });
    expect(ft.steps.find((x) => x.id === "S2")!.purpose).toBe("Implement with care");
    expect(ft.steps.find((x) => x.id === "S1")!.selection).toEqual({ provider: "codex", model: "codex-sample-fast" });
    expect(ft.pipelineHistory[0].reason).toBe(`Created from the feature pattern (follow-up to ${id})`);
    // A pin is dropped when the step with that id changed role.
    const swapped = withLocal(s0, localFile("feature", { steps: edited.map((st) => (st.id === "S1" ? { ...st, role: "coder" as const, purpose: "Sketch in code" } : st)) }));
    const g = M.createFollowUp(swapped, id, at(6));
    expect(task(g.state, g.newId).steps.find((x) => x.id === "S1")!.selection).toBeNull();
  });

  it("a follow-up of a custom (or legacy) task copies its steps and keeps its source", () => {
    const r = newTask(seed(), {});
    let s = M.setPipeline(r.state, r.newId, 1, oneStep, "one step", "user", at(1));
    const t = task(s, r.newId);
    t.lifecycle = "done";
    for (const st of t.steps) st.state = "done";
    s = structuredClone(s);
    const f = M.createFollowUp(s, r.newId, at(2));
    const ft = task(f.state, f.newId);
    expect(ft.steps.map((x) => x.id)).toEqual(["S1"]);
    expect(ft.pattern).toEqual({ id: "custom", name: "Custom pipeline", source: "custom", chosenBy: "follow-up" });
    expect(ft.pipelineHistory[0].reason).toBe(`Copied from ${r.newId}`);
    const legacy = structuredClone(s);
    task(legacy, r.newId).pattern = { id: "feature", name: "Feature", source: "legacy", chosenBy: "migration" };
    const l = M.createFollowUp(legacy, r.newId, at(3));
    expect(task(l.state, l.newId).pattern).toEqual({ id: "feature", name: "Feature", source: "legacy", chosenBy: "follow-up" });
    expect(task(l.state, l.newId).steps.map((x) => x.id)).toEqual(["S1"]);
  });
});

describe("the service's own paths", () => {
  it("a fix send-back uses the catalog's bugfix and a revert the internal pipeline, both chosen by the service", () => {
    let s = seed();
    const landed = task(s, "EX-006");
    landed.integration = { status: "integrated", landed: { at: at(0), via: "local", target: "main", commit: "a".repeat(40), by: "app", flags: [], status: "unreviewed", notes: [], followUps: [] } };
    s = structuredClone(s);
    const fix = D.sendBackLanded(s, { taskId: "EX-006", kind: "fix", note: "broken", holdBeforeStart: false }, at(1));
    expect(task(fix.state, fix.newId).pattern).toMatchObject({ id: "bugfix", source: "built-in", chosenBy: "service", hash: builtIn("bugfix").hash });
    expect(task(fix.state, fix.newId).steps.map((x) => x.id)).toEqual(builtIn("bugfix").steps.map((x) => x.id));
    const revert = D.sendBackLanded(fix.state, { taskId: "EX-006", kind: "revert", note: "", holdBeforeStart: false }, at(2));
    const rt = task(revert.state, revert.newId);
    expect(rt.pattern).toMatchObject({ id: "revert", name: "Revert", source: "internal", chosenBy: "service" });
    // Step 1 review, finding 5: the hash is of the steps that run, with the commit named in the first writer's purpose.
    expect(rt.steps[0].purpose).toMatch(/\(revert of [0-9a-f]{12}\)$/);
    expect(rt.pattern.hash).toBe(patternHash(rt.steps.map(toDef)));
    expect(rt.pattern.hash).not.toBe(patternHash(internalPattern("revert").steps));
    expect(rt.pipelineHistory[0].pattern).toEqual(rt.pattern);
    // A file of yours that replaces bugfix is what a fix uses.
    const mine = withLocal(s, localFile("bugfix", { steps: builtIn("bugfix").steps.map((st) => (st.id === "S1" ? { ...st, purpose: "Reproduce it my way" } : st)) }));
    const fix2 = D.sendBackLanded(mine, { taskId: "EX-006", kind: "fix", note: "broken", holdBeforeStart: false }, at(3));
    expect(task(fix2.state, fix2.newId).steps[0].purpose).toBe("Reproduce it my way");
    expect(task(fix2.state, fix2.newId).pattern).toMatchObject({ id: "bugfix", source: "local", chosenBy: "service" });
  });

  it("a Markdown import uses the project default, chosen by default", () => {
    const s = M.setDefaultPattern(seed(), "investigation", at(0));
    const r = M.importMarkdown(s, "| ID | Title |\n| --- | --- |\n| IMP-1 | Imported one |\n", at(1));
    expect(r.imported).toEqual(["IMP-1"]);
    const t = task(r.state, "IMP-1");
    expect(t.pattern).toMatchObject({ id: "investigation", chosenBy: "default" });
    expect(t.steps.map((x) => x.id)).toEqual(["S1", "S2", "S3"]);
    expect(t.patternSince).toBe(1);
  });

  it("resetSampleData keeps the catalog and the retired templates, like initProject (step 1 review, finding 7)", () => {
    const s = withLocal(seed(), localFile("mine", { steps: builtIn("change").steps }));
    s.retiredTemplates = [{ id: "old", name: "Old", description: "", steps: oneStep, kind: "custom", retiredAt: at(0), exportedTo: "~/.orchestration/patterns/old.json", exportedId: "old" }];
    const r = runCommand(s, "resetSampleData", {}, at(1)).state;
    expect(r.patterns).toEqual(s.patterns);
    expect(r.patterns.patterns.some((p) => p.id === "mine" && p.source === "local")).toBe(true);
    expect(r.retiredTemplates).toEqual(s.retiredTemplates);
    // ORC-017: the reset restores the demo story (not the test fixture); its tasks are back.
    expect(r.tasks.map((t) => t.id)).toEqual(buildDemo(Date.parse(at(1))).tasks.map((t) => t.id));
    expect(r.project.name).toBe("Weekend Trips (sample)");
  });

  it("initProject keeps the catalog and resets the default; the seed's tasks carry built-in references", () => {
    const s = M.initProject(M.setDefaultPattern(seed(), "feature", at(0)), { name: "N", repoPath: "/tmp/n", vision: "v", focus: "f" }, at(1));
    expect(s.project.defaultPatternId).toBe("change");
    expect(s.patterns.patterns.length).toBe(builtInCatalog().patterns.length);
    for (const t of seed().tasks) {
      expect(t.pattern.source, t.id).toBe("built-in");
      expect(t.pattern.chosenBy, t.id).toBe("lead");
      expect(t.patternSince, t.id).toBe(1);
      expect(t.pipelineHistory[0].pattern?.id, t.id).toBe(t.pattern.id);
    }
  });
});
