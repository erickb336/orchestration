// ORC-016 step 3, service level: the store writes a task's outcome once, in the transaction that settles it
// (P11), and never again: not on later writes, not for tasks settled before the upgrade, not after the
// sample data is reset. The record survives decision pruning, and a reopened task that settles again has
// its record replaced.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DECISIONS } from "../src/domain/findings";
import * as M from "../src/domain/model";
import type { FindingDecision, State } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { proposal, ScriptedAdapter, st as steerItem, steer } from "./testing/scripted";
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
const newTask = (title: string, patternId = "change") =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId }).result as { newId: string }).newId;
const finishRun = (id: string, opts: Parameters<ScriptedAdapter["finish"]>[1] = {}) => {
  const a = running(id)[0];
  (a.snapshot.provider === "claude" ? claude : codex).finish(a.id, opts);
};
const edit = (fn: (s: State) => void) =>
  store.update(
    (s) => {
      const next = structuredClone(s);
      fn(next);
      return next;
    },
    iso(),
  );

/** Drive a Change task to Done: S1 (Codex) → C1 skipped (checks off) → S2 (Claude, `review`) → S3 skipped or run → C2 skipped → S4 (the lead). */
function runToDone(id: string, review: Parameters<ScriptedAdapter["finish"]>[1] = {}): string {
  tick();
  expect(running(id)[0].stepId).toBe("S1");
  finishRun(id, { write: [`${id}.txt`, "x\n"] });
  tick();
  tick();
  expect(running(id)[0].stepId).toBe("S2");
  finishRun(id, review);
  tick();
  tick();
  if (running(id)[0]?.stepId === "S3") {
    finishRun(id, { write: [`${id}-fix.txt`, "y\n"] });
    tick();
    tick();
  }
  expect(running(id)[0].stepId).toBe("S4");
  finishRun(id);
  tick(); // the completion is applied in this cycle: the transaction that settles the task
  expect(task(id).lifecycle).toBe("done");
  return iso();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-outc-"));
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

describe("one outcome per settle (P11)", () => {
  it("is written once when a scripted run finishes the task, in that transaction, and never changes on later writes", () => {
    const id = newTask("Done once");
    expect(task(id).outcome).toBeUndefined();
    const settledAt = runToDone(id);
    const o = task(id).outcome!;
    expect(o).toMatchObject({ v: 1, result: "done", settledAt, pattern: { id: "change", chosenBy: "user" }, patternChanges: 0, runsBeforePattern: 0 });
    expect(o.runs.map((r) => [r.role, r.runner, r.model, r.completed])).toEqual([
      ["coder", "codex", "codex-sample-large-actual", 1],
      ["code_reviewer", "claude", "claude-sample-large-actual", 1],
      ["lead", "claude", "claude-sample-large-actual", 1],
    ]);
    expect(o.usage).toEqual([
      { provider: "codex", inputTokens: 100, outputTokens: 50, costUsd: 0.01, runsWithoutUsage: 0 },
      { provider: "claude", inputTokens: 200, outputTokens: 100, costUsd: 0.02, runsWithoutUsage: 0 },
    ]);
    // Later writes touch the task (integration, visits, settings) and leave the record exactly as written.
    tick();
    tick(60_000);
    cmd("markVisited");
    cmd("setPriority", { taskId: newTask("Other"), priority: 2 });
    expect(task(id).integration?.status).not.toBe("pending");
    expect(task(id).outcome).toEqual(o);
    const raw = new DatabaseSync(store.path);
    const persisted = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as State;
    raw.close();
    expect(persisted.tasks.find((t) => t.id === id)!.outcome).toEqual(o);
  });

  it("is written at cancel too, with what had run", () => {
    const id = newTask("Cancelled");
    tick();
    const run = running(id)[0];
    cmd("cancelTask", { taskId: id });
    const o = task(id).outcome!;
    expect(o).toMatchObject({ result: "cancelled", settledAt: iso(), firstRunAt: run.startedAt });
    expect(o.runs).toEqual([expect.objectContaining({ role: "coder", runner: "codex", runs: 1, completed: 0 })]);
    // The stop is acknowledged later; the record stays as written at cancel.
    tick();
    codex.emit({ type: "stopped", attemptId: run.id, how: "interrupted" });
    tick();
    expect(st().attempts.find((a) => a.id === run.id)!.outcome).toBe("stopped");
    expect(task(id).outcome).toEqual(o);
  });

  it("gives none to tasks settled before the upgrade, even after later writes, nor after the sample data is reset", () => {
    // A format-14 database: the seed as it stood before patterns, with its done task EX-006.
    const path = join(dir, "old.sqlite");
    const fresh = new Store(path);
    fresh.close();
    const raw = new DatabaseSync(path);
    const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as Record<string, unknown> & { project: Record<string, unknown>; tasks: Record<string, unknown>[] };
    doc.version = 14;
    delete doc.patterns;
    delete doc.retiredTemplates;
    doc.project.templates = [];
    delete doc.project.defaultPatternId;
    for (const t of doc.tasks) {
      delete t.pattern;
      delete t.patternSince;
    }
    raw.prepare("UPDATE state SET format = 14, json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();
    const upgraded = new Store(path);
    const done = () => upgraded.read().state.tasks.filter((t) => t.lifecycle === "done" || t.lifecycle === "cancelled");
    expect(done().length).toBeGreaterThan(0);
    expect(done().every((t) => t.outcome === undefined)).toBe(true);
    upgraded.command("markVisited", {}, "m1", iso());
    upgraded.update((s) => M.markVisited(s, iso()), iso());
    expect(done().every((t) => t.outcome === undefined)).toBe(true);
    // A task that settles after the upgrade does get one.
    const open = upgraded.read().state.tasks.find((t) => t.lifecycle !== "done" && t.lifecycle !== "cancelled")!;
    upgraded.command("cancelTask", { taskId: open.id }, "m2", iso());
    expect(upgraded.read().state.tasks.find((t) => t.id === open.id)!.outcome).toMatchObject({ result: "cancelled" });
    upgraded.close();
    // Reset sample data replaces every task: the sample's done task has no open counterpart, so no record.
    cmd("resetSampleData");
    const sampleDone = st().tasks.filter((t) => t.lifecycle === "done");
    expect(sampleDone.length).toBeGreaterThan(0);
    expect(sampleDone.every((t) => t.outcome === undefined)).toBe(true);
  });

  it("survives decision pruning: the counts stay once the decisions themselves are gone", () => {
    const id = newTask("With decisions");
    tick();
    finishRun(id, { write: ["a.txt", "a\n"] });
    tick();
    tick();
    expect(running(id)[0].stepId).toBe("S2");
    finishRun(id, { structured: [{ id: "F1", severity: "warning", action: "ask-user", title: "Widens the task", detail: "d", why: "scope" }] });
    tick();
    const d = st().decisions.find((x) => x.taskId === id)!;
    expect(d).toMatchObject({ status: "open", routedTo: "user" });
    cmd("decideFinding", { decisionId: d.id, decision: "accept", note: "fine as is" });
    tick();
    tick();
    expect(running(id)[0].stepId).toBe("S4");
    finishRun(id);
    tick();
    expect(task(id).lifecycle).toBe("done");
    expect(task(id).outcome!.decisions).toEqual({ total: 1, byUser: 1, byLead: 0, fix: 0, accept: 1, followUp: 0, superseded: 0, open: 0 });
    // Fill the record past its cap with superseded decisions of a task that no longer exists, then let a new
    // review create one more: pruning drops the decided decisions of settled tasks first, ours included.
    edit((s) => {
      for (let i = 0; i < MAX_DECISIONS; i++) {
        const x: FindingDecision = { id: `fd-fill-${i}`, taskId: "T-gone", artifactId: "art-gone", findingId: "F1", key: "k".repeat(12), kind: "finding", finding: { source: "review", severity: "error", title: "t", detail: "d" }, routedTo: "user", status: "superseded", usedBy: [], createdAt: iso() };
        s.decisions.push(x);
      }
    });
    const other = newTask("Other");
    tick();
    finishRun(other, { write: ["b.txt", "b\n"] });
    tick();
    tick();
    finishRun(other, { structured: [{ id: "F1", severity: "error", action: "ask-user", title: "Another", detail: "d", why: "scope" }] });
    tick();
    expect(st().decisions.length).toBeLessThanOrEqual(MAX_DECISIONS);
    expect(st().decisions.some((x) => x.taskId === id)).toBe(false);
    expect(task(id).outcome!.decisions.total).toBe(1);
  });

  it("a dropped proposal is settled; after Undo reopens it, cancelling settles it again and replaces the record", () => {
    cmd("postMessage", { text: "plan something small" });
    tick();
    const r1 = M.activeLeadRun(st())!;
    claude.reply(r1.id, "One proposal.", [proposal({ title: "Tiny tidy-up", priority: 5 })]);
    tick();
    const id = st().conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds![0];
    tick();
    expect(task(id).holdBeforeStart).toBe(true); // lead proposals wait for you while the lead does not plan on its own: it never starts
    expect(running(id)).toHaveLength(0);
    expect(task(id).outcome).toBeUndefined();
    cmd("postMessage", { text: "drop that, not now" });
    tick();
    const r2 = M.activeLeadRun(st())!;
    claude.reply(r2.id, "Dropped.", [], steer({ tasks: [steerItem.drop(id)] }));
    tick();
    expect(task(id)).toMatchObject({ lifecycle: "cancelled", cancelledBy: "lead" });
    const first = task(id).outcome!;
    expect(first).toMatchObject({ result: "cancelled", settledAt: iso(), runs: [] });
    const set = st().steering.at(-1)!;
    cmd("undoSteering", { changeSetId: set.id });
    expect(task(id).lifecycle).not.toBe("cancelled");
    tick(5000);
    cmd("cancelTask", { taskId: id });
    const second = task(id).outcome!;
    expect(second.settledAt).toBe(iso());
    expect(second.settledAt).not.toBe(first.settledAt);
    expect(second).toMatchObject({ result: "cancelled", pattern: { id: "change", chosenBy: "lead" } }); // the scripted proposal names its pattern
  });
});
