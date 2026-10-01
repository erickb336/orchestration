// ORC-007: parallel agents per step (copies and best-of), iteration loops, and breakdown steps that
// create child tasks with goal-level iteration. Scripted adapters and a temporary git repository.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { toDef } from "../src/domain/pipeline";
import type { State, StepDef } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler;
let now = Date.parse("2026-09-29T12:00:00Z");
const iso = () => new Date(now).toISOString();
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
const running = (id: string) => M.activeAttempts(st(), id);
const adapter = (p: string) => (p === "claude" ? claude : codex);
const finishRun = (runId: string, opts: Parameters<ScriptedAdapter["finish"]>[1] = {}) => {
  const a = st().attempts.find((x) => x.id === runId)!;
  adapter(a.snapshot.provider).finish(runId, opts);
};
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const newTask = (title: string, patternId = "change", steps?: StepDef[]) => {
  const id = (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId }).result as { newId: string }).newId;
  if (steps) setTestPipeline(store, id, steps, iso(), "test pipeline");
  return id;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-fan-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", "init");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000, ackTimeoutMs: 10_000 });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Fan", repoPath: repo, vision: "v", focus: "f" });
  cmd("setWorkerLimit", { limit: 12 });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setRoleDefault", { role: "designer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("parallel agents per step", () => {
  it("copies: three reviewers on alternating providers run at once; findings are summed", () => {
    const steps: StepDef[] = [
      { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] },
      { id: "S2", purpose: "Review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }], parallel: { count: 3, mode: "copies", providers: ["claude", "codex"] } },
      { id: "S3", purpose: "Repair", role: "coder", dependsOn: ["S2"], inputs: [{ step: "S2", output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S2", output: "findings" }] },
    ];
    const id = newTask("Parallel review", "change", steps);
    tick();
    finishRun(running(id)[0].id, { write: ["a.txt", "a\n"] });
    tick();
    tick();
    const reviews = running(id);
    expect(reviews.map((r) => r.stepId).sort()).toEqual(["S2", "S2-c2", "S2-c3"]);
    expect(new Set(reviews.map((r) => r.snapshot.provider))).toEqual(new Set(["claude", "codex"]));
    expect(task(id).pipelineHistory.at(-1)!.reason).toMatch(/3 parallel copies/);
    finishRun(reviews[0].id, { findings: 0 });
    finishRun(reviews[1].id, { findings: 0 });
    finishRun(reviews[2].id, { findings: 1 }); // one copy found something: repair runs
    tick();
    tick();
    const repair = running(id)[0];
    expect(repair.stepId).toBe("S3");
    expect(repair.snapshot.inputs.map((i) => i.step).sort()).toEqual(["S2", "S2-c2", "S2-c3"]);
  });

  it("best-of: two implementations on different providers; the reviewer's choice is the only one that goes further", () => {
    const steps: StepDef[] = [
      { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }], parallel: { count: 2, mode: "best-of", providers: ["codex", "claude"] } },
      { id: "S2", purpose: "Compare and review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
      { id: "S3", purpose: "Verify", role: "lead", dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "verification", kind: "verification" }] },
    ];
    const id = newTask("Best of two", "change", steps);
    tick();
    const [a, b] = running(id);
    expect(new Set([a.snapshot.provider, b.snapshot.provider])).toEqual(new Set(["codex", "claude"]));
    finishRun(a.id, { write: ["impl.txt", "A\n"] });
    finishRun(b.id, { write: ["impl.txt", "B\n"] });
    tick();
    tick();
    const review = running(id)[0];
    expect(review.snapshot.inputs).toHaveLength(2); // sees both candidates
    expect(claude.runs.get(review.id)!.prompt).toContain("Choose the best candidate");
    finishRun(review.id, { findings: 0, chosen: "S1-c2" });
    tick();
    expect(task(id).bestOf).toEqual({ S1: "S1-c2" });
    tick();
    const verify = running(id)[0];
    expect(verify.snapshot.inputs.map((i) => i.step)).toEqual(["S1-c2"]); // only the chosen one
    finishRun(verify.id);
    tick();
    tick();
    const change = M.finalChange(st(), task(id))!;
    expect(change.stepId).toBe("S1-c2");
    expect(git("show", `${change.ref!.split(" ")[0]}:impl.txt`)).toBe("B");
  });

  it("rejects invalid parallel settings", () => {
    const bad: StepDef[] = [{ id: "S1", purpose: "x", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }], parallel: { count: 2, mode: "best-of" } }];
    const id = newTask("Bad");
    expect(() => setTestPipeline(store, id, bad, iso(), "x")).toThrow(/must read its output to choose/);
  });
});

describe("iteration", () => {
  it("review → repair repeats until the review is clean, then verification reads the latest change", () => {
    const id = newTask("Iterate"); // Change template: S1 implement, S2 review, S3 repair (loops to S2, max 3), S4 verify
    tick();
    finishRun(running(id)[0].id, { write: ["x.txt", "v1\n"] });
    tick();
    tick();
    finishRun(running(id)[0].id, { findings: 2 }); // S2
    tick();
    tick();
    const repair1 = running(id)[0];
    expect(repair1.stepId).toBe("S3");
    finishRun(repair1.id, { write: ["x.txt", "v2\n"] });
    tick();
    tick();
    const review2 = running(id)[0];
    expect(review2.stepId).toBe("S2-i2");
    expect(review2.snapshot.inputs.find((i) => i.output === "change")!.step).toBe("S3"); // reviews the repaired change
    finishRun(review2.id, { findings: 0 });
    tick();
    tick();
    expect(task(id).steps.find((x) => x.id === "S3-i2")!.state).toBe("skipped"); // loop ends
    const verify = running(id)[0];
    expect(verify.stepId).toBe("S4");
    finishRun(verify.id);
    tick();
    tick();
    expect(task(id).lifecycle).toBe("done");
    expect(git("show", `${M.finalChange(st(), task(id))!.ref!.split(" ")[0]}:x.txt`)).toBe("v2");
  });

  it("stops after the maximum number of iterations", () => {
    const id = newTask("Never clean");
    tick();
    finishRun(running(id)[0].id, { write: ["y.txt", "1\n"] });
    for (let i = 0; i < 30 && task(id).lifecycle !== "done"; i++) {
      tick();
      for (const r of running(id)) {
        const step = task(id).steps.find((x) => x.id === r.stepId)!;
        finishRun(r.id, step.outputs[0].kind === "review-findings" ? { findings: 1 } : { write: ["y.txt", `${i}\n`] });
      }
    }
    const reviews = task(id).steps.filter((x) => x.id.startsWith("S2"));
    expect(reviews.map((x) => x.id)).toEqual(["S2", "S2-i2", "S2-i3"]); // max 3 rounds
    expect(task(id).lifecycle).toBe("done");
  });
});

describe("breakdowns into child tasks", () => {
  it("a planning step creates child tasks; the evaluation waits for them and iterates until nothing is left", () => {
    const id = newTask("Big goal", "goal");
    tick();
    const plan = running(id)[0];
    expect(plan.stepId).toBe("S1");
    expect(claude.runs.get(plan.id)!.prompt).toContain('"items"');
    finishRun(plan.id, {
      items: [
        { title: "Part one", outcome: "one done", approach: "small", acceptance: ["one works"], patternId: "change" },
        { title: "Part two", outcome: "two done", approach: "small", acceptance: ["two works"], patternId: "change", dependsOn: [0] },
        { title: "No acceptance", outcome: "x", approach: "y", acceptance: [] },
      ],
    });
    tick();
    const kids = M.childTasks(st(), task(id));
    expect(kids.map((k) => k.id)).toEqual([`${id}.1`, `${id}.2`]);
    expect(kids[1].dependsOn).toEqual([`${id}.1`]);
    // Autonomy is off in this project, so agent-written child tasks wait to be started, like lead proposals.
    expect(kids.map((k) => k.holdBeforeStart)).toEqual([true, true]);
    tick();
    expect(running(`${id}.1`)).toHaveLength(0);
    cmd("startHeldTask", { taskId: `${id}.1` });
    cmd("startHeldTask", { taskId: `${id}.2` });
    tick();
    expect(running(id)).toHaveLength(0); // S2 waits for the children
    expect(M.stateLabel(st(), task(id))).toBe("Waiting for 2 child tasks");
    expect(running(`${id}.1`)).toHaveLength(1); // children run their own pipelines
    // Finish the children quickly: cancel them (settled) to exercise the wait.
    cmd("cancelTask", { taskId: `${id}.1` });
    cmd("cancelTask", { taskId: `${id}.2` });
    tick();
    tick();
    const evaluate = running(id)[0];
    expect(evaluate.stepId).toBe("S2");
    expect(claude.runs.get(evaluate.id)!.prompt).toContain("Child tasks (results of the breakdown)");
    finishRun(evaluate.id, { items: [{ title: "Part three", outcome: "three", approach: "z", acceptance: ["three works"], patternId: "change" }] });
    tick();
    expect(task(id).steps.some((x) => x.id === "S2-i2")).toBe(true); // next round planned
    cmd("cancelTask", { taskId: `${id}.3` });
    tick();
    tick();
    const evaluate2 = running(id)[0];
    expect(evaluate2.stepId).toBe("S2-i2");
    finishRun(evaluate2.id, { items: [] }); // goal met: no more rounds
    tick();
    tick();
    expect(task(id).steps.some((x) => x.id === "S2-i3")).toBe(false);
    const report = running(id)[0];
    expect(report.stepId).toBe("S3");
  });

  it("at a gate the breakdown can be edited; children are created from the edited items on resume", () => {
    const steps: StepDef[] = [
      { id: "S1", purpose: "Plan", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "plan", kind: "breakdown" }], gate: true },
      { id: "S2", purpose: "Wait", role: "lead", dependsOn: ["S1"], inputs: [], outputs: [{ name: "r", kind: "report" }], waitForChildren: true },
    ];
    const id = newTask("Gated plan", "change", steps);
    tick();
    finishRun(running(id)[0].id, { items: [{ title: "Worker idea", outcome: "c", approach: "a", acceptance: ["ok"], patternId: "change" }] });
    tick();
    expect(task(id).hold).toBe(true);
    expect(M.childTasks(st(), task(id))).toHaveLength(0); // nothing created yet
    const plan = st().artifacts.find((a) => a.taskId === id && a.name === "plan")!;
    cmd("editArtifact", {
      artifactId: plan.id,
      summary: "Two parts instead",
      reason: "Split differently",
      items: [
        { title: "Part X", outcome: "x", approach: "x", acceptance: ["x ok"], patternId: "change" },
        { title: "Part Y", outcome: "y", approach: "y", acceptance: ["y ok"], patternId: "change" },
      ],
    });
    cmd("resumeTask", { taskId: id });
    const kids = M.childTasks(st(), task(id));
    expect(kids.map((k) => M.currentSpec(k).content.title)).toEqual(["Part X", "Part Y"]);
    expect(kids[0]).toMatchObject({ parentStepId: "S1" });
    expect(M.openLeadProposals(st()).map((t) => t.id)).toContain(kids[0].id); // children count toward the lead's open cap
  });

  it("the user can choose or change a best-of candidate; later steps re-run on the new choice", () => {
    const steps: StepDef[] = [
      { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }], parallel: { count: 2, mode: "best-of" } },
      { id: "S2", purpose: "Compare", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
      { id: "S3", purpose: "Verify", role: "lead", dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "verification", kind: "verification" }] },
    ];
    const id = newTask("Choose", "change", steps);
    tick();
    for (const r of running(id)) finishRun(r.id, { write: ["c.txt", `${r.stepId}\n`] });
    tick();
    tick();
    finishRun(running(id)[0].id, { findings: 0, chosen: "S1" });
    tick();
    tick();
    const verify = running(id)[0];
    expect(verify.snapshot.inputs.map((i) => i.step)).toEqual(["S1"]);
    cmd("chooseCandidate", { taskId: id, group: "S1", stepId: "S1-c2" });
    expect(st().attempts.find((a) => a.id === verify.id)!.outcome).toBe("stopping"); // re-run on the new choice
    claude.emit({ type: "stopped", attemptId: verify.id, how: "interrupted" });
    tick();
    tick();
    expect(running(id)[0].snapshot.inputs.map((i) => i.step)).toEqual(["S1-c2"]);
    expect(() => cmd("chooseCandidate", { taskId: id, group: "S1", stepId: "S2" })).toThrow(/not a candidate/);
  });
});

// ---------- ORC-007 review regressions ----------

const confirmStop = (runId: string) => {
  const a = st().attempts.find((x) => x.id === runId)!;
  adapter(a.snapshot.provider).emit({ type: "stopped", attemptId: runId, how: "interrupted" });
};
const settle = () => {
  tick();
  tick();
};
const runOf = (taskId: string, stepId: string) => running(taskId).find((r) => r.stepId === stepId);
/** Finish the running step and let the service apply the result and dispatch what follows. */
const complete = (taskId: string, stepId: string, opts: Parameters<ScriptedAdapter["finish"]>[1] = {}) => {
  const r = runOf(taskId, stepId);
  if (!r) throw new Error(`${stepId} of ${taskId} is not running (running: ${running(taskId).map((x) => x.stepId).join(", ") || "none"})`);
  finishRun(r.id, opts);
  settle();
};
const items = (...titles: string[]): Record<string, unknown>[] => titles.map((title) => ({ title, outcome: `${title} done`, approach: "small", acceptance: [`${title} works`], patternId: "change" }));
const bestOfSteps = (): StepDef[] => [
  { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }], parallel: { count: 2, mode: "best-of" } },
  { id: "S2", purpose: "Compare", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
  { id: "S3", purpose: "Verify", role: "lead", dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "verification", kind: "verification" }] },
];
const planSteps = (): StepDef[] => [
  { id: "S1", purpose: "Plan", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "plan", kind: "breakdown" }] },
  { id: "S2", purpose: "Report", role: "lead", dependsOn: ["S1"], inputs: [], outputs: [{ name: "r", kind: "report" }], waitForChildren: true },
];

describe("review regressions: best-of choices", () => {
  it("a re-run comparison decides again; a person's choice stands until that candidate re-runs", () => {
    const id = newTask("Rechoose", "change", bestOfSteps());
    settle();
    complete(id, "S1", { write: ["c.txt", "S1\n"] });
    complete(id, "S1-c2", { write: ["c.txt", "S1-c2\n"] });
    complete(id, "S2", { findings: 0, chosen: "S1" });
    expect(task(id).bestOf).toEqual({ S1: "S1" });
    // Re-run the comparison: its new choice replaces the old one.
    const verify = runOf(id, "S3")!;
    cmd("rerunStep", { taskId: id, stepId: "S2" });
    confirmStop(verify.id);
    settle();
    complete(id, "S2", { findings: 0, chosen: "S1-c2" });
    expect(task(id).bestOf).toEqual({ S1: "S1-c2" });
    expect(runOf(id, "S3")!.snapshot.inputs.map((i) => i.step)).toEqual(["S1-c2"]);
    // A person chooses S1; a later comparison that prefers S1-c2 does not override it.
    const verify2 = runOf(id, "S3")!;
    cmd("chooseCandidate", { taskId: id, group: "S1", stepId: "S1" });
    confirmStop(verify2.id);
    settle();
    const verify3 = runOf(id, "S3")!;
    cmd("rerunStep", { taskId: id, stepId: "S2" });
    confirmStop(verify3.id);
    settle();
    complete(id, "S2", { findings: 0, chosen: "S1-c2" });
    expect(task(id).bestOf).toEqual({ S1: "S1" });
    expect(st().events.some((e) => e.message.includes("keeping your choice of S1"))).toBe(true);
    // Once the chosen candidate produces a new result, the comparison decides again.
    const verify4 = runOf(id, "S3")!;
    cmd("rerunStep", { taskId: id, stepId: "S1" });
    confirmStop(verify4.id);
    settle();
    complete(id, "S1", { write: ["c.txt", "S1 again\n"] });
    complete(id, "S2", { findings: 0, chosen: "S1-c2" });
    expect(task(id).bestOf).toEqual({ S1: "S1-c2" });
    expect(task(id).bestOfByUser?.S1).toBeUndefined();
  });

  it("other readers of the candidates wait for the choice and re-run when a person changes it; same-provider copies keep the pinned model", () => {
    const steps: StepDef[] = [
      { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }], parallel: { count: 3, mode: "best-of", providers: ["codex", "claude"] } },
      { id: "S2", purpose: "Compare", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
      { id: "S3", purpose: "UX review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "ux", kind: "review-findings" }] },
    ];
    const id = newTask("Siblings", "change", steps);
    cmd("setStepSelection", { taskId: id, stepId: "S1", selection: { provider: "codex", model: "codex-sample-fast" } });
    settle();
    const sel = (sid: string) => task(id).steps.find((x) => x.id === sid)!.selection;
    expect(sel("S1")).toEqual({ provider: "codex", model: "codex-sample-fast" });
    expect(sel("S1-c2")).toEqual({ provider: "claude", model: "auto" });
    expect(sel("S1-c3")).toEqual({ provider: "codex", model: "codex-sample-fast" }); // not "auto"
    for (const c of ["S1", "S1-c2", "S1-c3"]) complete(id, c, { write: ["c.txt", `${c}\n`] });
    expect(running(id).map((r) => r.stepId)).toEqual(["S2"]); // the UX review waits for the choice
    complete(id, "S2", { findings: 0, chosen: "S1-c2" });
    const ux = runOf(id, "S3")!;
    expect(ux.snapshot.inputs.map((i) => i.step)).toEqual(["S1-c2"]);
    complete(id, "S3", { findings: 0 });
    expect(task(id).lifecycle).toBe("done");
  });

  it("changing the choice re-runs every step that received the old one, not only those after the comparison", () => {
    const steps: StepDef[] = [
      ...bestOfSteps().slice(0, 2),
      { id: "S3", purpose: "UX review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "ux", kind: "review-findings" }] },
      { id: "S4", purpose: "Wait", role: "lead", dependsOn: ["S2", "S3"], inputs: [], outputs: [{ name: "r", kind: "report" }], gate: true },
      { id: "S5", purpose: "Report", role: "lead", dependsOn: ["S4"], inputs: [], outputs: [{ name: "r2", kind: "report" }] },
    ];
    const id = newTask("Change choice", "change", steps);
    settle();
    complete(id, "S1", { write: ["c.txt", "a\n"] });
    complete(id, "S1-c2", { write: ["c.txt", "b\n"] });
    complete(id, "S2", { findings: 0, chosen: "S1" });
    complete(id, "S3", { findings: 0 });
    complete(id, "S4");
    expect(task(id).hold).toBe(true); // gate after S4
    cmd("chooseCandidate", { taskId: id, group: "S1", stepId: "S1-c2" });
    const state = Object.fromEntries(task(id).steps.map((x) => [x.id, x.state]));
    expect(state).toMatchObject({ S2: "done", S3: "paused", S4: "paused" });
  });
});

describe("review regressions: pipeline rules", () => {
  const base: StepDef = { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] };
  const review = (id: string, dep: string, extra: Partial<StepDef> = {}): StepDef => ({ id, purpose: `Review ${id}`, role: "code_reviewer", dependsOn: [dep], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }], ...extra });
  const repair = (id: string, dep: string, extra: Partial<StepDef> = {}): StepDef => ({ id, purpose: `Repair ${id}`, role: "coder", dependsOn: [dep], inputs: [{ step: dep, output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], ...extra });
  const cases: [string, StepDef[], RegExp][] = [
    ["copies of a code change", [{ ...base, parallel: { count: 2, mode: "copies" } }, review("S2", "S1")], /cannot all be merged/],
    ["a parallel breakdown", [{ ...planSteps()[0], parallel: { count: 2, mode: "copies" } }], /creates child tasks, so it cannot run in parallel/],
    ["a conditional chooser", [{ ...base, parallel: { count: 2, mode: "best-of" } }, review("S2", "S1", { inputs: [] }), review("S3", "S2", { runIf: [{ step: "S2", output: "findings" }] })], /must always run/],
    ["a parallel chooser", [{ ...base, parallel: { count: 2, mode: "best-of" } }, review("S2", "S1", { parallel: { count: 2, mode: "copies" } })], /cannot itself run in parallel/],
    ["a parallel step inside a loop", [base, review("S2", "S1", { parallel: { count: 2, mode: "copies" } }), repair("S3", "S2", { iterate: { from: "S2", max: 3 } })], /cannot be inside a loop/],
    ["overlapping loops", [base, review("S2", "S1", { iterate: { from: "S2", max: 2 } }), repair("S3", "S2", { iterate: { from: "S2", max: 3 } })], /cannot overlap/],
  ];
  it.each(cases)("rejects %s", (name, steps, msg) => {
    const id = newTask(`Bad ${name}`);
    expect(() => setTestPipeline(store, id, steps, iso(), "x")).toThrow(msg);
  });

  it("removing parallel, iterate, or waiting from a step removes it, and an identical re-save changes nothing", () => {
    const steps: StepDef[] = [base, review("S2", "S1", { parallel: { count: 3, mode: "copies" }, waitForChildren: true }), repair("S3", "S2", { iterate: { from: "S3", max: 3 } })];
    const id = newTask("Unset", "change", steps);
    const plain = steps.map((d) => ({ ...d, parallel: undefined, iterate: undefined, waitForChildren: undefined }));
    setTestPipeline(store, id, plain, iso(), "simpler", 2); // newTask's pipeline was revision 2
    const s2 = task(id).steps.find((x) => x.id === "S2")!;
    expect([s2.parallel, s2.waitForChildren, task(id).steps.find((x) => x.id === "S3")!.iterate]).toEqual([undefined, undefined, undefined]);
    const revs = task(id).steps.map((x) => x.revision);
    setTestPipeline(store, id, plain, iso(), "same again", 3);
    expect(task(id).steps.map((x) => x.revision)).toEqual(revs);
    settle();
    complete(id, "S1", { write: ["u.txt", "1\n"] });
    expect(running(id).map((r) => r.stepId)).toEqual(["S2"]); // no copies
  });

  it("changing a parallel step's purpose changes and re-runs its copies too", () => {
    const steps: StepDef[] = [base, review("S2", "S1", { parallel: { count: 2, mode: "copies" } })];
    const id = newTask("Leader edit", "change", steps);
    settle();
    complete(id, "S1", { write: ["l.txt", "1\n"] });
    const before = running(id);
    expect(before.map((r) => r.stepId).sort()).toEqual(["S2", "S2-c2"]);
    const defs = task(id).steps.map(toDef).map((d) => (d.id === "S2" ? { ...d, purpose: "Review for security" } : d));
    setTestPipeline(store, id, defs, iso(), "focus");
    expect(task(id).steps.find((x) => x.id === "S2-c2")!.purpose).toBe("Review for security (copy 2 of 2)");
    expect(before.map((r) => st().attempts.find((a) => a.id === r.id)!.outcome)).toEqual(["stopping", "stopping"]);
  });
});

describe("review regressions: child tasks", () => {
  it("child tasks are capped per task, and cannot use a template that breaks down again", () => {
    const loop: StepDef[] = [{ ...planSteps()[0], iterate: { from: "S1", max: 10 } }];
    const id = newTask("Endless", "change", loop);
    settle();
    for (let round = 1; round <= 8; round++) {
      const r = running(id)[0];
      if (!r) break;
      const batch = items(...Array.from({ length: 20 }, (_, j) => `R${round} item ${j + 1}`));
      if (round === 1) batch[0].patternId = "goal";
      complete(id, r.stepId, { items: batch });
    }
    const kids = M.descendants(st(), task(id));
    expect(kids).toHaveLength(M.MAX_CHILD_TASKS);
    expect(kids.every((k) => k.holdBeforeStart)).toBe(true);
    expect(st().events.some((e) => e.message.includes("cannot break down further"))).toBe(true);
    expect(st().events.some((e) => e.message.includes(`already has ${M.MAX_CHILD_TASKS} child tasks`))).toBe(true);
    expect(task(id).steps.map((x) => x.id)).toEqual(["S1", "S1-i2", "S1-i3", "S1-i4", "S1-i5", "S1-i6", "S1-i7"]); // 19 + 20 × 4 + 1: stops once nothing more is added
  });

  it("pausing a task pauses its children and resuming resumes them; cancelling cancels them; a child that can never start blocks the parent", () => {
    const id = newTask("Family", "change", planSteps());
    settle();
    complete(id, "S1", { items: items("A", "B").map((x, i) => (i === 1 ? { ...x, dependsOn: [0] } : x)) });
    cmd("startHeldTask", { taskId: `${id}.1` });
    cmd("startHeldTask", { taskId: `${id}.2` });
    settle();
    const childRun = running(`${id}.1`)[0];
    expect(childRun).toBeDefined();
    cmd("pauseTask", { taskId: id });
    expect(task(`${id}.1`)).toMatchObject({ hold: true, pausedWith: id });
    expect(st().attempts.find((a) => a.id === childRun.id)!.outcome).toBe("stopping");
    confirmStop(childRun.id);
    settle();
    cmd("resumeTask", { taskId: id });
    expect([task(`${id}.1`).hold, task(`${id}.2`).hold]).toEqual([false, false]);
    settle();
    expect(running(`${id}.1`)).toHaveLength(1);
    // Cancelling a prerequisite child leaves its dependent unable to start: the parent says so.
    const r = running(`${id}.1`)[0];
    cmd("cancelTask", { taskId: `${id}.1` });
    confirmStop(r.id);
    settle();
    expect(M.blockedReason(st(), task(id))).toMatch(new RegExp(`Child ${id}\\.2 cannot start`));
    cmd("cancelTask", { taskId: id });
    expect(task(`${id}.2`).lifecycle).toBe("cancelled");
  });

  it("a re-run or edited breakdown reconciles its children instead of adding a second batch", () => {
    const id = newTask("Replan", "change", planSteps());
    settle();
    complete(id, "S1", { items: items("A", "B", "C") });
    for (const k of ["1", "3"]) cmd("startHeldTask", { taskId: `${id}.${k}` });
    settle();
    expect(running(`${id}.1`)).toHaveLength(1); // A and C have started
    cmd("rerunStep", { taskId: id, stepId: "S1" });
    settle();
    complete(id, "S1", { items: items("A", "B renamed") });
    const kids = () => Object.fromEntries(M.childTasks(st(), task(id)).map((k) => [M.currentSpec(k).content.title, k.lifecycle]));
    expect(kids()).toMatchObject({ A: "active", B: "cancelled", C: "active", "B renamed": "ready" });
    expect(task(`${id}.4`).holdBeforeStart).toBe(true);
    expect(M.childTasks(st(), task(id))).toHaveLength(4);
    expect(st().events.some((e) => e.message.includes(`${id}.3 already started and no longer listed`))).toBe(true);
    // Editing the breakdown reconciles the same way.
    const plan = M.acceptedOutput(st(), task(id), "S1", "plan")!;
    cmd("editArtifact", { artifactId: plan.id, summary: "Add D", reason: "One more part", items: items("A", "B renamed", "D") });
    expect(M.childTasks(st(), task(id)).map((k) => M.currentSpec(k).content.title)).toEqual(["A", "B", "C", "B renamed", "D"]);
  });
});

describe("review regressions: iteration", () => {
  it("after a re-run comes back clean, the next iteration is skipped instead of repeating the review", () => {
    const id = newTask("Clean rerun"); // Change: S1 implement, S2 review, S3 repair (loop to S2), S4 verify
    settle();
    complete(id, "S1", { write: ["z.txt", "1\n"] });
    complete(id, "S2", { findings: 1 });
    complete(id, "S3", { write: ["z.txt", "2\n"] });
    const review2 = runOf(id, "S2-i2")!;
    expect(review2).toBeDefined();
    cmd("rerunStep", { taskId: id, stepId: "S2" });
    confirmStop(review2.id);
    settle();
    complete(id, "S2", { findings: 0 });
    const state = Object.fromEntries(task(id).steps.map((x) => [x.id, x.state]));
    expect(state).toMatchObject({ S3: "skipped", "S2-i2": "skipped", "S3-i2": "skipped" });
    expect(running(id)[0].stepId).toBe("S4");
  });
});

describe("review regressions (re-verification)", () => {
  const impl: StepDef = { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }], parallel: { count: 2, mode: "best-of" } };
  const compare: StepDef = { id: "S2", purpose: "Compare", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] };

  it("an automatic re-choice re-runs other readers that used the old choice, and they wait while the comparison re-runs", () => {
    const steps: StepDef[] = [
      impl,
      compare,
      { id: "S3", purpose: "UX review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "ux", kind: "review-findings" }] },
      { id: "S4", purpose: "Verify", role: "lead", dependsOn: ["S2", "S3"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "v", kind: "verification" }] },
    ];
    const id = newTask("Auto rechoice", "change", steps);
    settle();
    complete(id, "S1", { write: ["r.txt", "a\n"] });
    complete(id, "S1-c2", { write: ["r.txt", "b\n"] });
    complete(id, "S2", { findings: 0, chosen: "S1" });
    complete(id, "S3", { findings: 0 });
    const verify = runOf(id, "S4")!;
    cmd("rerunStep", { taskId: id, stepId: "S2" });
    confirmStop(verify.id);
    settle();
    complete(id, "S2", { findings: 0, chosen: "S1-c2" });
    expect(task(id).bestOf).toEqual({ S1: "S1-c2" });
    expect(runOf(id, "S3")!.snapshot.inputs.map((i) => i.step)).toEqual(["S1-c2"]); // re-run on the new choice
  });

  it("the final change comes only from steps that are done now, not from a repair that a clean re-run skipped", () => {
    const id = newTask("Final after clean rerun");
    settle();
    complete(id, "S1", { write: ["f.txt", "1\n"] });
    complete(id, "S2", { findings: 1 });
    complete(id, "S3", { write: ["f.txt", "2\n"] });
    const review2 = runOf(id, "S2-i2")!;
    cmd("rerunStep", { taskId: id, stepId: "S2" });
    confirmStop(review2.id);
    settle();
    complete(id, "S2", { findings: 0 });
    complete(id, "S4");
    expect(task(id).lifecycle).toBe("done");
    expect(M.finalChange(st(), task(id))!.stepId).toBe("S1"); // S3's old repair is not merged
  });

  it("rejects edits that would break expanded steps, and keeps service-set fields a client leaves out", () => {
    const id = newTask("Guarded", "change", [impl, compare, { id: "S3", purpose: "Repair", role: "coder", dependsOn: ["S2"], inputs: [{ step: "S2", output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S2", output: "findings" }], iterate: { from: "S2", max: 3 } }]);
    settle();
    const current = () => task(id).steps.map(toDef);
    // Changing the count after the step has expanded is refused rather than ignored.
    const more = current().map((d) => (d.id === "S1" ? { ...d, parallel: { count: 4, mode: "best-of" as const } } : d));
    expect(() => setTestPipeline(store, id, more, iso(), "more")).toThrow(/cannot change/);
    // Renaming the leader's output without updating readers of the copies is refused (copies follow the leader).
    const renamed = current().map((d) =>
      d.id === "S1" ? { ...d, outputs: [{ name: "patch", kind: "code-change" as const }] } : d.id === "S2" ? { ...d, inputs: d.inputs.map((r) => (r.step === "S1" ? { ...r, output: "patch" } : r)) } : d,
    );
    expect(() => setTestPipeline(store, id, renamed, iso(), "rename")).toThrow(/Parallel copies follow/);
    // A client that omits copyOf does not break the group.
    const stripped = current().map(({ copyOf: _c, iteration: _i, ...d }) => d);
    setTestPipeline(store, id, stripped, iso(), "same, without service fields");
    expect(task(id).steps.find((x) => x.id === "S1-c2")!.copyOf).toBe("S1");
    // A best-of step must always run.
    const cond = [{ ...impl, runIf: [] }, compare].map((d) => d);
    const id2 = newTask("Conditional best-of");
    const pre: StepDef = { id: "S0", purpose: "Review first", role: "code_reviewer", dependsOn: [], inputs: [], outputs: [{ name: "f", kind: "review-findings" }] };
    const bad = [pre, { ...cond[0], dependsOn: ["S0"], runIf: [{ step: "S0", output: "f" }] }, cond[1]];
    expect(() => setTestPipeline(store, id2, bad, iso(), "x")).toThrow(/is best-of, so it must always run/);
  });

  it("resuming a child resumes the grandchildren that were paused with an ancestor", () => {
    const id = newTask("Three levels", "change", planSteps());
    settle();
    complete(id, "S1", { items: items("Child") });
    const child = `${id}.1`;
    setTestPipeline(store, child, planSteps(), iso(), "break this down too");
    cmd("startHeldTask", { taskId: child });
    settle();
    complete(child, "S1", { items: items("Grandchild") });
    const grandchild = `${child}.1`;
    expect(task(grandchild).parentTaskId).toBe(child);
    cmd("pauseTask", { taskId: id });
    expect(task(grandchild)).toMatchObject({ hold: true, pausedWith: id });
    cmd("resumeTask", { taskId: child });
    expect(task(grandchild).hold).toBe(false);
    expect(task(id).hold).toBe(true); // the root stays paused until you resume it
  });
});
