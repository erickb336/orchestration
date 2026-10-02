// ORC-029 pass 2a, through the store and the scheduler: what a run cost is recorded however it ends. A paused,
// revised or cancelled run's usage counts toward the building budget, the lead's too, and a run that failed
// before its runtime started it is a known $0, not an unknown.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { buildingSpend, estimateUsd, type ModelPrice } from "../src/domain/spend";
import { startFactoryArgs } from "../src/domain/testing/factory";
import type { State } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

/** The scripted runtime reports `<model>-actual`; a price list of the test's own for those. */
const LIST: ModelPrice[] = [
  { provider: "codex", model: "codex-sample-large-actual", inputPerMTok: 2, outputPerMTok: 10, source: "https://example.test/pricing", checked: "2026-10-01" },
  { provider: "claude", model: "claude-sample-large-actual", inputPerMTok: 1, outputPerMTok: 5, source: "https://example.test/pricing", checked: "2026-10-01" },
];

let dir: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler;
let now = Date.parse("2026-10-01T12:00:00Z");
const iso = () => new Date(now).toISOString();
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const st = (): State => store.read().state;
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const newTask = (title: string) =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
const attempt = (id: string) => st().attempts.find((a) => a.id === id)!;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-spend-"));
  const repo = join(dir, "repo");
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
  cmd("startFactory", startFactoryArgs(store.read().state));
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a stopped run's usage", () => {
  it("a paused worker run keeps the usage its runtime reported with the stop, and the building spend counts it", () => {
    const id = newTask("Paused");
    tick();
    const [run] = M.activeAttempts(st(), id);
    cmd("pauseTask", { taskId: id });
    tick();
    expect(attempt(run.id).outcome).toBe("stopping");
    codex.emit({ type: "stopped", attemptId: run.id, how: "interrupted", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    tick();
    expect(attempt(run.id)).toMatchObject({ outcome: "stopped", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    expect(buildingSpend(st(), LIST)).toMatchObject({ usd: 2, unknown: [] });
  });

  it("a cancelled worker run keeps it too", () => {
    const id = newTask("Cancelled");
    tick();
    const [run] = M.activeAttempts(st(), id);
    cmd("cancelTask", { taskId: id });
    tick();
    codex.emit({ type: "stopped", attemptId: run.id, how: "killed", usage: { inputTokens: 500_000, outputTokens: 100_000 } });
    tick();
    expect(attempt(run.id)).toMatchObject({ outcome: "stopped", usage: { inputTokens: 500_000, outputTokens: 100_000 } });
    expect(buildingSpend(st(), LIST).usd).toBeCloseTo(2, 10);
  });

  it("a stopped lead run keeps it, and the building spend counts it", () => {
    cmd("postMessage", { text: "How is it going?" });
    tick();
    const lead = M.activeLeadRun(st())!;
    expect(lead.outcome).toBe("running");
    cmd("pauseProject");
    expect(M.activeLeadRun(st())!.outcome).toBe("stopping");
    claude.emit({ type: "stopped", attemptId: lead.id, how: "interrupted", usage: { costUsd: 0.25, inputTokens: 40_000, outputTokens: 2_000 } });
    tick();
    expect(st().leadRuns.find((r) => r.id === lead.id)).toMatchObject({ outcome: "stopped", usage: { costUsd: 0.25 } });
    expect(buildingSpend(st(), LIST)).toMatchObject({ usd: 0.25, unknown: [] });
  });
});

describe("a run that never started", () => {
  it("failed before its runtime started it, with no usage: a known $0, not an unknown", () => {
    codex.reportsStart = false;
    const id = newTask("Never ran");
    tick();
    const [run] = M.activeAttempts(st(), id);
    codex.emit({ type: "failed", attemptId: run.id, message: "Codex could not start: not signed in" });
    tick();
    const failed = attempt(run.id);
    expect(failed).toMatchObject({ outcome: "failed" });
    expect(failed.sessionId).toBeUndefined();
    expect(estimateUsd(failed, LIST)).toEqual({ basis: "not-started", usd: 0, estimated: true });
    expect(buildingSpend(st(), LIST)).toMatchObject({ usd: 0, runs: 1, unknown: [] });
  });

  it("a run that started and then failed with no usage stays unknown: it may have spent tokens nobody recorded", () => {
    const id = newTask("Ran, then failed");
    tick();
    const [run] = M.activeAttempts(st(), id);
    codex.emit({ type: "failed", attemptId: run.id, message: "Codex crashed" });
    tick();
    expect(attempt(run.id).sessionId).toBeDefined();
    expect(buildingSpend(st(), LIST).unknown).toEqual([{ runId: run.id, provider: "codex", model: "codex-sample-large-actual", reason: "no-usage" }]);
  });
});
