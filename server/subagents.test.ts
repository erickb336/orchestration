// Subagents in read-only research steps (ORC-031, unit 31a), service level, with scripted adapters (no real runs):
// a research step's run gets a read-only workspace whatever its role, and `allowSubagents` only where the owner allows
// helpers on a provider that tracks them; the adapters' `subagent` events are recorded on the run; one where none is
// allowed reaches Needs you; and a format-19 database from before the fields loads with them off.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { needsYouItems } from "../src/domain/needsYou";
import { setSubagentProviders } from "../src/domain/subagents";
import { startFactoryArgs } from "../src/domain/testing/factory";
import type { ProviderId, State } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
const opened: { close(): void | Promise<void> }[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-subagents-"));
});
afterEach(async () => {
  for (const o of opened.splice(0).reverse()) {
    try {
      await o.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

let key = 0;
const k = () => `k-${++key}`;
const runOf = (s: State, id: string, stepId: string) => M.activeAttempts(s, id).find((a) => a.stepId === stepId);

/** A project of its own on a fresh repository, building, with the coder on Codex; `tracking`: the providers that track subagents. */
async function service(tracking: ProviderId[]) {
  const repo = join(dir, `repo-${++key}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const store = new Store(join(dir, `db-${key}.sqlite`));
  opened.push(store);
  const claude = new ScriptedAdapter("claude");
  const codex = new ScriptedAdapter("codex");
  const scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, `worktrees-${key}`)), leaseMs: 60_000, ackTimeoutMs: 10_000 });
  opened.push({ close: () => scheduler.stop() });
  await scheduler.refreshHealth();
  let now = T0;
  const tick = () => scheduler.tick((now += 1000));
  const state = () => store.read().state;
  const cmd = (name: string, args: object = {}) => store.command(name, args, k(), iso(now));
  cmd("initProject", { name: "Apps", repoPath: repo, vision: "Ship the apps.", focus: "Local builds" });
  cmd("startFactory", startFactoryArgs(state()));
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
  // As the service does at start, from the adapters' capability maps (server/app.ts).
  store.update((s) => setSubagentProviders(s, tracking, iso(now)), iso(now));
  const create = (flowId: string) => {
    const id = (cmd("createTask", { title: `Work ${flowId}`, area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId }).result as { newId: string }).newId;
    tick(); // promoted
    tick(); // dispatched
    return { id, run: runOf(state(), id, "S1")! };
  };
  return { store, codex, tick, state, cmd, create };
}

describe("a research step's run", () => {
  it("is read-only although its role is a coder's, and may start no helper by default", async () => {
    const f = await service(["codex"]);
    const { run } = f.create("investigation");
    const a = f.codex.started.find((x) => x.attemptId === run.id)!;
    expect(a.role).toBe("coder");
    expect(a.workspace.access).toBe("read");
    expect(a.allowSubagents).toBeUndefined();
    expect(a.prompt).toContain("It is read-only for you: do not create, modify, or delete any file.");
  });

  it("gets allowSubagents with the owner's cap, and its helpers are recorded from the adapter's events", async () => {
    const f = await service(["codex"]);
    f.cmd("setResearchHelpers", { step: "investigation/S1", cap: 2 });
    const { id, run } = f.create("investigation");
    // Codex limits its sub-agents only at once (agents.max_threads): the allowance says so (ORC-030 r6).
    expect(f.codex.started.find((x) => x.attemptId === run.id)!.allowSubagents).toEqual({ cap: 2, atOnce: true });
    f.codex.emit({ type: "subagent", attemptId: run.id, subagent: { phase: "started", id: "thread-a", asked: "Find where sync is called", model: "gpt-test", usageInParent: false } });
    f.codex.emit({ type: "subagent", attemptId: run.id, subagent: { phase: "ended", id: "thread-a", how: "completed", usage: { inputTokens: 500, outputTokens: 50 } } });
    f.tick();
    const rec = f.state().attempts.find((x) => x.id === run.id)!.subagents!;
    expect(rec).toMatchObject({ count: 1, mostAtOnce: 1, items: [{ id: "thread-a", asked: "Find where sync is called", ended: "completed", usageInParent: false }] });
    expect(needsYouItems(f.state()).some((i) => i.key.startsWith("helpers-"))).toBe(false);
    expect(id).toBeTruthy();
  });

  it("is told it is research, and how many helpers it may start; a run with none allowed is told to start none", async () => {
    const f = await service(["codex"]);
    const plain = f.create("investigation");
    const first = f.codex.started.find((x) => x.attemptId === plain.run.id)!.prompt;
    expect(first).toContain("This step is read-only research: gather evidence and report what you find. Change no file, whatever the brief above says.");
    expect(first).toContain("Do not start sub-agents or delegate");
    f.cmd("setResearchHelpers", { step: "investigation/S1", cap: 2 });
    const allowed = f.create("investigation");
    const second = f.codex.started.find((x) => x.attemptId === allowed.run.id)!.prompt;
    expect(second).toContain("You may start at most 2 helper agents (your provider's own subagents) for read-only searches; they cannot write either.");
    expect(second).toContain("Notes reach you, not them.");
    expect(second).not.toContain("Do not start sub-agents");
  });

  it("gets none on a provider that does not track subagents, and the setting cannot be turned on", async () => {
    const f = await service([]);
    expect(() => f.cmd("setResearchHelpers", { step: "investigation/S1", cap: 2 })).toThrow("No provider tracks helper agents yet");
    const { run } = f.create("investigation");
    expect(f.codex.started.find((x) => x.attemptId === run.id)!.allowSubagents).toBeUndefined();
  });
});

describe("a writer's run", () => {
  it("writes, never gets allowSubagents, and a helper it reports reaches Needs you", async () => {
    const f = await service(["codex"]);
    f.cmd("setResearchHelpers", { step: "investigation/S1", cap: 2 });
    const { id, run } = f.create("change");
    const a = f.codex.started.find((x) => x.attemptId === run.id)!;
    expect(a.workspace.access).toBe("write");
    expect(a.allowSubagents).toBeUndefined();
    f.codex.emit({ type: "subagent", attemptId: run.id, subagent: { phase: "started", id: "thread-x", asked: "Edit the README", usageInParent: false } });
    f.tick();
    expect(f.state().attempts.find((x) => x.id === run.id)!.subagents!.count).toBe(1);
    const item = needsYouItems(f.state()).find((i) => i.key === `helpers-${run.id}`);
    expect(item).toMatchObject({ what: "A helper agent started where none is allowed", href: `#/task/${id}` });
    f.cmd("markSubagentsSeen", { runId: run.id });
    expect(needsYouItems(f.state()).some((i) => i.key === `helpers-${run.id}`)).toBe(false);
  });
});

describe("a format-19 database from before ORC-031", () => {
  it("loads with helpers off for every step and no provider tracking them", () => {
    const path = join(dir, "old.sqlite");
    const first = new Store(path);
    first.close();
    const db = new DatabaseSync(path);
    const row = db.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string };
    const doc = JSON.parse(row.json) as { project: Record<string, unknown> };
    delete doc.project.researchHelpers;
    delete doc.project.subagentProviders;
    db.prepare("UPDATE state SET json = ? WHERE id = 1").run(JSON.stringify(doc));
    db.close();
    const again = new Store(path);
    opened.push(again);
    expect(again.read().state.project.researchHelpers).toEqual({});
    expect(again.read().state.project.subagentProviders).toEqual([]);
  });
});
