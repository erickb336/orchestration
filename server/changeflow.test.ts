// Changing a task's flow, service level: through the store and the scheduler with
// scripted adapters. Refused while the runtime has not confirmed the stop, accepted once Paused, the new
// steps dispatched as new attempts on resume, and a changed flow file at a restart never touches the task.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_FILES } from "../src/domain/builtInFlows";
import * as M from "../src/domain/model";
import { resolveFlows } from "../src/domain/flows";
import type { State } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler;
let now = Date.parse("2026-09-30T12:00:00Z");
const iso = () => new Date(now).toISOString();
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
const running = (id: string) => M.activeAttempts(st(), id);
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const newTask = (title: string, flowId = "change") =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId }).result as { newId: string }).newId;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-chpat-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", "init"]);
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000, ackTimeoutMs: 10_000 });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "P", repoPath: repo, vision: "v", focus: "f" });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("changing a flow through the service", () => {
  it("is refused while Pausing, accepted once the runtime confirms Paused, dispatches the new steps on resume, and survives a reload", () => {
    // 1. A Change task runs S1.
    const id = newTask("Mine");
    tick();
    const first = running(id)[0];
    expect(first).toMatchObject({ stepId: "S1", snapshot: { pipelineRev: 1, stepRev: 1, role: "coder" } });
    expect(codex.runs.has(first.id)).toBe(true);
    expect(() => cmd("changeFlow", { taskId: id, expectedRev: 1, flowId: "bugfix" })).toThrow(/Pause the task first/);

    // 2. Pause: Pausing until the runtime acknowledges, then Paused.
    cmd("pauseTask", { taskId: id });
    tick();
    expect(running(id)[0].outcome).toBe("stopping");
    expect(codex.interrupts).toContain(first.id);
    expect(() => cmd("changeFlow", { taskId: id, expectedRev: 1, flowId: "bugfix" })).toThrow(/Wait until it shows Paused\./);
    codex.emit({ type: "stopped", attemptId: first.id, how: "interrupted" });
    tick();
    expect(running(id)).toHaveLength(0);
    expect(M.stateLabel(st(), task(id))).toMatch(/^Paused/);
    const refused = store.commandCount();
    expect(() => cmd("changeFlow", { taskId: id, expectedRev: 7, flowId: "bugfix" })).toThrow(/Stale write/);
    expect(store.commandCount()).toBe(refused + 1); // the refusal is recorded, nothing applied
    expect(task(id).pipelineRev).toBe(1);
    cmd("changeFlow", { taskId: id, expectedRev: 1, flowId: "bugfix", note: "needs a reproduction first" });
    const t = task(id);
    expect(t).toMatchObject({ pipelineRev: 2, flowSince: 2, hold: true, flow: { id: "bugfix", chosenBy: "user" } });
    // One above the revision each id had under Change (S2, SR1 and S4 never ran but existed at revision 1); S5 is new.
    expect(t.steps.map((x) => [x.id, x.state, x.revision])).toEqual([["S1", "paused", 2], ["S2", "paused", 2], ["C1", "paused", 2], ["S3", "paused", 2], ["SR1", "paused", 2], ["S4", "paused", 2], ["C2", "paused", 2], ["S5", "paused", 1]]);
    expect(t.pipelineHistory[1]).toMatchObject({ rev: 2, reason: "Flow changed from Change to Bug fix: needs a reproduction first", flow: { id: "bugfix" } });
    expect(st().attempts.find((a) => a.id === first.id)!.outcome).toBe("stopped");
    tick(5000);
    expect(running(id)).toHaveLength(0); // still paused

    // 3. Resume: the new S1 is a new attempt on the new steps.
    cmd("resumeTask", { taskId: id });
    tick();
    const second = running(id)[0];
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ stepId: "S1", snapshot: { pipelineRev: 2, stepRev: 2, role: "coder", inputs: [] } });
    expect(codex.runs.get(second.id)!.outputs.map((o) => o.name)).toEqual(["reproduction"]);

    // 4. A changed flow file (the service restarted on it) changes the catalog, never the task.
    const files = structuredClone(BUILT_IN_FILES);
    const bugfix = files.find((f) => f.raw.id === "bugfix")!;
    bugfix.raw.steps[0].purpose = "Reproduce it another way";
    store.update((s) => M.setFlows(s, resolveFlows(files), iso()), iso());
    expect(st().flows.find((p) => p.id === "bugfix")!.hash).not.toBe(t.flow.hash);
    expect(task(id).steps[0].purpose).toBe(t.steps[0].purpose);
    expect(task(id).flow.hash).toBe(t.flow.hash);
    expect(task(id).pipelineHistory).toEqual(t.pipelineHistory);
    codex.finish(second.id);
    tick();
    expect(task(id).steps[0].state).toBe("done");
    expect(st().artifacts.filter((a) => a.taskId === id).map((a) => [a.stepId, a.name, a.pipelineRev])).toEqual([["S1", "reproduction", 2]]);
    tick();
    expect(running(id)[0]).toMatchObject({ stepId: "S2", snapshot: { pipelineRev: 2 } });
  });

  it("before the first run, the change needs no pause and keeps a pin whose step keeps its role", () => {
    const id = newTask("Later", "bugfix");
    cmd("setStepSelection", { taskId: id, stepId: "S1", selection: { provider: "claude", model: "claude-sample-large" } });
    cmd("setStepSelection", { taskId: id, stepId: "S2", selection: { provider: "claude", model: "claude-sample-large" } });
    cmd("changeFlow", { taskId: id, expectedRev: 1, flowId: "change" });
    const t = task(id);
    expect(t).toMatchObject({ pipelineRev: 2, flowSince: 2, hold: false, flow: { id: "change" } });
    expect(t.steps.find((x) => x.id === "S1")!.selection).toEqual({ provider: "claude", model: "claude-sample-large" });
    expect(t.steps.find((x) => x.id === "S2")!.selection).toBeNull();
    expect(st().events.at(-1)!.message).toBe("Pipeline r2: flow Bug fix → Change; nothing had run; pins kept: S1; dropped: S2 (role changed)");
    tick();
    expect(running(id)[0]).toMatchObject({ stepId: "S1", snapshot: { provider: "claude", pipelineRev: 2, stepRev: 3 } });
  });
});
