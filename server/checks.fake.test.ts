// ORC-013 §6.8: the fake runtime's simulated check runner. In a task tree's first run the "test" command
// fails and every later run passes, every record says it is simulated, and nothing is ever spawned:
// child_process.spawn is replaced here and must never be called.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(() => {
    throw new Error("spawn must never be called by the simulated runner");
  }),
}));
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawn: spawnSpy, execFile: spawnSpy, spawnSync: spawnSpy, execFileSync: spawnSpy }));

import * as M from "../src/domain/model";
import { buildSeed } from "../src/domain/seed";
import { SimulatedChecks, type CheckAssignment } from "./checks";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { Store } from "./store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-fake-checks-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SimulatedChecks in the fake runtime", () => {
  it("runs the sample's checks without spawning anything: the first run fails 'test', the repair loop shows, every record is simulated, and Final checks reuses the passing run", () => {
    let now = Date.parse("2026-09-30T12:00:00Z");
    const store = new Store(join(dir, "db.sqlite"), () => buildSeed(now, { inFlightRuns: false, checks: true }));
    const cfg = { ...defaultFakeConfig(), progressPerTick: 50 };
    const catalog = store.read().state.project.catalog;
    const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", cfg, catalog.claude), codex: new FakeAdapter("codex", cfg, catalog.codex) });
    expect(scheduler.checks).toBeInstanceOf(SimulatedChecks);
    expect(scheduler.isFake).toBe(true);
    const st = () => store.read().state;
    expect(st().project.checks).toMatchObject({ enabled: true, commands: [{ id: "typecheck" }, { id: "test" }] });
    expect(st().project.checksHealth).toMatchObject({ sandbox: "codex", status: "ready" });
    // The sample story already carries simulated results.
    const ex6 = st().artifacts.filter((a) => a.taskId === "EX-006" && a.kind === "check-results");
    expect(ex6.map((a) => [a.stepId, a.checkRun!.simulated, a.checkRun!.results.map((r) => r.status)])).toEqual([
      ["C1", true, ["passed", "failed"]],
      ["C2", true, ["passed", "passed"]],
    ]);
    // A new task runs through the loop on the simulated runner.
    let key = 0;
    const id = (store.command("createTask", { title: "Sim", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }, `k${++key}`, new Date(now).toISOString()).result as { newId: string }).newId;
    for (let i = 0; i < 80 && st().tasks.find((t) => t.id === id)!.lifecycle !== "done"; i++) {
      now += 1000;
      scheduler.tick(now);
    }
    const t = st().tasks.find((x) => x.id === id)!;
    expect(t.lifecycle).toBe("done");
    const runs = st().attempts.filter((a) => a.taskId === id && a.snapshot.provider === "service");
    expect(runs.map((a) => [a.stepId, a.outcome])).toEqual([
      ["C1", "completed"],
      ["C1-i2", "completed"],
      ["C2", "completed"],
    ]);
    const arts = st().artifacts.filter((a) => a.taskId === id && a.kind === "check-results");
    expect(arts.every((a) => a.checkRun!.simulated === true)).toBe(true);
    expect(arts.every((a) => a.summary.includes("simulated"))).toBe(true);
    expect(arts[0].checkRun!.results.map((r) => r.status)).toEqual(["passed", "failed"]);
    expect(arts[0].checkRun!.results[1].excerpt).toContain("(simulated)");
    expect(arts[1].checkRun!.results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(arts[2].checkRun!.reusedFrom).toBe(runs[1].id);
    expect(arts[0].checkRun!.sha).toMatch(/^sim-run-/);
    expect(M.activeAttempts(st(), id)).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();
    void scheduler.stop();
    store.close();
  });
});

describe("SimulatedChecks: which run fails (ORC-017 review M4)", () => {
  it("a tree's own merge checks and reviews count as its root: only the tree's very first run fails 'test'", () => {
    const c = new SimulatedChecks();
    const status: Record<string, string> = {};
    c.onEvent((e) => {
      if (e.type === "completed") status[e.attemptId] = e.checks!.results.find((r) => r.id === "test")!.status;
    });
    const run = (attemptId: string, taskId: string) => {
      c.start({ attemptId, taskId, stepId: "C1", workspace: "/nowhere", target: "a".repeat(40), commands: [{ id: "test", label: "npm test", kind: "test", argv: ["npm", "test"] }], runTimeoutMs: 1000, sandbox: "none", prepareNetwork: false, env: {}, tmpDir: "/nowhere" } as unknown as CheckAssignment);
      for (let i = 0; i < 4; i++) c.tick(Date.now());
    };
    run("r1", "WT-002");
    run("r2", "WT-002-CK1");
    run("r3", "WT-002.1-RV2");
    run("r4", "WT-003-CK1");
    expect(status).toEqual({ r1: "failed", r2: "passed", r3: "passed", r4: "failed" });
  });
});
