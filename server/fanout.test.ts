// Iteration loops, and breakdown steps that create child tasks with goal-level iteration.
// Scripted adapters and a temporary git repository.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFactoryArgs } from "../src/domain/testing/factory";
import * as M from "../src/domain/model";
import type { State, StepDef } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

// Real git and many scheduler cycles per test: a busy machine can take
// several times vitest's 5 s default, so these tests get 20 s. A real hang still fails.
vi.setConfig({ testTimeout: 20_000 });

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
const newTask = (title: string, flowId = "change", steps?: StepDef[]) => {
  const id = (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId }).result as { newId: string }).newId;
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
  cmd("startFactory", startFactoryArgs(store.read().state));
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

describe("iteration", () => {
  it("review → repair repeats until the review is clean, then verification reads the latest change", () => {
    const id = newTask("Iterate"); // Change flow: S1 implement, S2 review, S3 repair (loops to S2, max 3), S4 verify
    tick();
    finishRun(running(id)[0].id, { write: ["x.txt", "v1\n"] });
    tick();
    tick();
    for (const a of running(id)) finishRun(a.id, { findings: a.stepId === "S2" ? 2 : 0 }); // S2, and the security review beside it clean
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
    for (const a of running(id)) finishRun(a.id, { findings: 0 }); // S2-i2 and SR1-i2
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
        { title: "Part one", outcome: "one done", approach: "small", acceptance: ["one works"], flowId: "change" },
        { title: "Part two", outcome: "two done", approach: "small", acceptance: ["two works"], flowId: "change", dependsOn: [0] },
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
    finishRun(evaluate.id, { items: [{ title: "Part three", outcome: "three", approach: "z", acceptance: ["three works"], flowId: "change" }] });
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

  it("with step-by-step review the breakdown can be edited at the pause; children are created from the edited items on resume", () => {
    const steps: StepDef[] = [
      { id: "S1", purpose: "Plan", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "plan", kind: "breakdown" }] },
      { id: "S2", purpose: "Wait", role: "lead", dependsOn: ["S1"], inputs: [], outputs: [{ name: "r", kind: "report" }], waitForChildren: true },
    ];
    const id = newTask("Reviewed plan", "change", steps);
    cmd("setReviewEveryStep", { taskId: id, value: true });
    tick();
    finishRun(running(id)[0].id, { items: [{ title: "Worker idea", outcome: "c", approach: "a", acceptance: ["ok"], flowId: "change" }] });
    tick();
    expect(task(id).hold).toBe(true);
    expect(M.childTasks(st(), task(id))).toHaveLength(0); // nothing created yet
    const plan = st().artifacts.find((a) => a.taskId === id && a.name === "plan")!;
    cmd("editArtifact", {
      artifactId: plan.id,
      summary: "Two parts instead",
      reason: "Split differently",
      items: [
        { title: "Part X", outcome: "x", approach: "x", acceptance: ["x ok"], flowId: "change" },
        { title: "Part Y", outcome: "y", approach: "y", acceptance: ["y ok"], flowId: "change" },
      ],
    });
    cmd("resumeTask", { taskId: id });
    const kids = M.childTasks(st(), task(id));
    expect(kids.map((k) => M.currentSpec(k).content.title)).toEqual(["Part X", "Part Y"]);
    expect(kids[0]).toMatchObject({ parentStepId: "S1" });
    expect(M.openLeadProposals(st()).map((t) => t.id)).toContain(kids[0].id); // children count toward the lead's open cap
  });

});

// ---------- harder cases: pipeline rules, child tasks, iteration and re-verification ----------

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
const items = (...titles: string[]): Record<string, unknown>[] => titles.map((title) => ({ title, outcome: `${title} done`, approach: "small", acceptance: [`${title} works`], flowId: "change" }));
const planSteps = (): StepDef[] => [
  { id: "S1", purpose: "Plan", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "plan", kind: "breakdown" }] },
  { id: "S2", purpose: "Report", role: "lead", dependsOn: ["S1"], inputs: [], outputs: [{ name: "r", kind: "report" }], waitForChildren: true },
];

describe("pipeline rules for loops and waits", () => {
  const base: StepDef = { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] };
  const review = (id: string, dep: string, extra: Partial<StepDef> = {}): StepDef => ({ id, purpose: `Review ${id}`, role: "code_reviewer", dependsOn: [dep], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }], ...extra });
  const repair = (id: string, dep: string, extra: Partial<StepDef> = {}): StepDef => ({ id, purpose: `Repair ${id}`, role: "coder", dependsOn: [dep], inputs: [{ step: dep, output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], ...extra });
  it("rejects overlapping loops", () => {
    const id = newTask("Bad overlapping loops");
    const steps = [base, review("S2", "S1", { iterate: { from: "S2", max: 2 } }), repair("S3", "S2", { iterate: { from: "S2", max: 3 } })];
    expect(() => setTestPipeline(store, id, steps, iso(), "x")).toThrow(/cannot overlap/);
  });

  it("removing iterate or waiting from a step removes it, and an identical re-save changes nothing", () => {
    const steps: StepDef[] = [base, review("S2", "S1", { waitForChildren: true }), repair("S3", "S2", { iterate: { from: "S3", max: 3 } })];
    const id = newTask("Unset", "change", steps);
    const plain = steps.map((d) => ({ ...d, iterate: undefined, waitForChildren: undefined }));
    setTestPipeline(store, id, plain, iso(), "simpler", 2); // newTask's pipeline was revision 2
    const s2 = task(id).steps.find((x) => x.id === "S2")!;
    expect([s2.waitForChildren, task(id).steps.find((x) => x.id === "S3")!.iterate]).toEqual([undefined, undefined]);
    const revs = task(id).steps.map((x) => x.revision);
    setTestPipeline(store, id, plain, iso(), "same again", 3);
    expect(task(id).steps.map((x) => x.revision)).toEqual(revs);
    settle();
    complete(id, "S1", { write: ["u.txt", "1\n"] });
    expect(running(id).map((r) => r.stepId)).toEqual(["S2"]);
  });

});

describe("child tasks: caps, controls and reconciliation", () => {
  it("child tasks are capped per task, and cannot use a flow that breaks down again (Goal)", () => {
    const loop: StepDef[] = [{ ...planSteps()[0], iterate: { from: "S1", max: 10 } }];
    const id = newTask("Endless", "change", loop);
    settle();
    for (let round = 1; round <= 8; round++) {
      const r = running(id)[0];
      if (!r) break;
      const batch = items(...Array.from({ length: 20 }, (_, j) => `R${round} item ${j + 1}`));
      if (round === 1) batch[0].flowId = "goal";
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

describe("iteration after a clean re-run", () => {
  it("after a re-run comes back clean, the next iteration is skipped instead of repeating the review", () => {
    const id = newTask("Clean rerun"); // Change: S1 implement, S2 review, S3 repair (loop to S2), S4 verify
    settle();
    complete(id, "S1", { write: ["z.txt", "1\n"] });
    complete(id, "S2", { findings: 1 });
    complete(id, "SR1", { findings: 0 });
    complete(id, "S3", { write: ["z.txt", "2\n"] });
    const review2 = runOf(id, "S2-i2")!;
    expect(review2).toBeDefined();
    cmd("rerunStep", { taskId: id, stepId: "S2" });
    confirmStop(review2.id);
    confirmStop(runOf(id, "SR1-i2")!.id); // the security review beside it read the repair too, so it was stopped as well
    settle();
    complete(id, "S2", { findings: 0 });
    const state = Object.fromEntries(task(id).steps.map((x) => [x.id, x.state]));
    expect(state).toMatchObject({ S3: "skipped", "S2-i2": "skipped", "SR1-i2": "skipped", "S3-i2": "skipped" });
    expect(running(id)[0].stepId).toBe("S4");
  });
});

describe("re-verification", () => {
  it("the final change comes only from steps that are done now, not from a repair that a clean re-run skipped", () => {
    const id = newTask("Final after clean rerun");
    settle();
    complete(id, "S1", { write: ["f.txt", "1\n"] });
    complete(id, "S2", { findings: 1 });
    complete(id, "SR1", { findings: 0 });
    complete(id, "S3", { write: ["f.txt", "2\n"] });
    const review2 = runOf(id, "S2-i2")!;
    cmd("rerunStep", { taskId: id, stepId: "S2" });
    confirmStop(review2.id);
    confirmStop(runOf(id, "SR1-i2")!.id);
    settle();
    complete(id, "S2", { findings: 0 });
    complete(id, "S4");
    expect(task(id).lifecycle).toBe("done");
    expect(M.finalChange(st(), task(id))!.stepId).toBe("S1"); // S3's old repair is not merged
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
