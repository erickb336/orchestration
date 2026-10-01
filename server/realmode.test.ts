// Real-mode scheduling without real providers: scripted asynchronous adapters, a temporary git
// repository, and real worktrees. Verifies concurrency across providers, workspace isolation,
// output parsing, commit artifacts, confirmed stops, failures, and provider health blocking.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import type { CatalogModel, ProviderId, State } from "../src/domain/types";
import { buildEnvelope, parseOutputs } from "./envelope";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import type { AdapterEvent, Assignment, ProviderHealth, RuntimeAdapter } from "./runtimes/types";
import { changedFilesIn } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

/** A controllable adapter: tests decide when runs finish, fail, or acknowledge stops. */
class ScriptedAdapter implements RuntimeAdapter {
  readonly label = "Scripted test adapter";
  readonly capabilities = { start: "supported", streamEvents: "supported", steer: "unsupported", interrupt: "supported", resume: "unsupported", usageReporting: "supported", childAgentTracking: "unsupported" } as const;
  runs = new Map<string, Assignment>();
  interrupts: string[] = [];
  healthStatus: ProviderHealth["status"] = "ready";
  private listeners = new Set<(e: AdapterEvent) => void>();
  constructor(readonly provider: ProviderId) {}
  async health(): Promise<ProviderHealth> {
    return { status: this.healthStatus, detail: this.healthStatus === "ready" ? "ok" : `${this.provider} needs credentials`, checkedAt: new Date().toISOString() };
  }
  async listModels(): Promise<CatalogModel[] | null> {
    return null;
  }
  start(a: Assignment) {
    this.runs.set(a.attemptId, a);
    this.emit({ type: "started", attemptId: a.attemptId, sessionId: `${this.provider}-session-${a.attemptId}`, model: `${a.model}-actual` });
  }
  interrupt(id: string) {
    if (!this.interrupts.includes(id)) this.interrupts.push(id);
  }
  kill(id: string) {
    this.runs.delete(id);
  }
  has(id: string) {
    return this.runs.has(id);
  }
  ids() {
    return [...this.runs.keys()];
  }
  onEvent(l: (e: AdapterEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** ORC-022: scripted runs acknowledge nothing unless a test says so. */
  note(attemptId: string, note: { id: string; text: string }) {
    this.notes.push({ attemptId, ...note });
  }
  readonly notes: { attemptId: string; id: string; text: string }[] = [];
  async shutdown() {
    this.runs.clear();
  }
  emit(e: AdapterEvent) {
    if (e.type === "completed" || e.type === "failed" || e.type === "stopped") this.runs.delete(e.attemptId);
    for (const l of this.listeners) l(e);
  }
  /** Finish a run, optionally writing a file in its worktree first, reporting every declared output (a review lists the changed files it was shown, ORC-013). */
  finish(id: string, opts: { write?: [string, string]; findings?: number; omit?: string } = {}) {
    const a = this.runs.get(id)!;
    if (opts.write) writeFileSync(join(a.workspace.path, opts.write[0]), opts.write[1]);
    const outputs: Record<string, unknown> = {};
    for (const o of a.outputs) {
      if (o.name === opts.omit) continue;
      outputs[o.name] = o.kind === "review-findings" ? { summary: `${o.name} by ${this.provider}`, openFindings: opts.findings ?? 0, reviewedPaths: changedFilesIn(a.prompt) } : { summary: `${o.name} by ${this.provider}` };
    }
    this.emit({ type: "completed", attemptId: id, finalText: `All done.\n\`\`\`json\n${JSON.stringify({ outputs })}\n\`\`\``, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, model: `${a.model}-actual` });
  }
}

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let workspaces: WorkspaceManager;
let scheduler: Scheduler;
let now = Date.parse("2026-09-29T12:00:00Z");
const iso = () => new Date(now).toISOString();
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const tick = () => {
  now += 1000;
  scheduler.tick(now);
};
const st = () => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
const runOf = (taskId: string, stepId: string) => M.activeAttempts(st(), taskId).find((a) => a.stepId === stepId)!;
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-real-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  workspaces = new WorkspaceManager(join(dir, "worktrees"));
  scheduler = new Scheduler(store, { claude, codex }, { workspaces, leaseMs: 30000, ackTimeoutMs: 10000 });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Test", repoPath: repo, vision: "Test vision", focus: "Testing" });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setRoleDefault", { role: "lead", selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const newTask = (title: string, flowId = "change") =>
  (cmd("createTask", { title, area: "Test", outcome: `${title} outcome`, benefit: "b", whyNow: "", approach: "Just do it", acceptance: ["It works"], priority: 1, holdBeforeStart: false, flowId }).result as { newId: string }).newId;

describe("real-mode scheduling with scripted adapters", () => {
  it("runs Claude and Codex concurrently in isolated worktrees and records commit artifacts", () => {
    const a = newTask("Codex change");
    // A second task whose first step runs on Claude.
    const b = newTask("Claude change");
    cmd("setStepSelection", { taskId: b, stepId: "S1", selection: { provider: "claude", model: "claude-sample-large" } });
    tick();
    const runA = runOf(a, "S1");
    const runB = runOf(b, "S1");
    expect(runA.snapshot.provider).toBe("codex");
    expect(runB.snapshot.provider).toBe("claude");
    expect(codex.has(runA.id) && claude.has(runB.id)).toBe(true); // concurrent, different providers
    const wsA = codex.runs.get(runA.id)!.workspace;
    const wsB = claude.runs.get(runB.id)!.workspace;
    expect(wsA.path).not.toBe(wsB.path);
    expect(wsA.access).toBe("write");
    expect(wsA.path.startsWith(join(dir, "worktrees"))).toBe(true);
    expect(runA.snapshot.workspace).toBe(wsA.path); // snapshot records the real path
    expect(codex.runs.get(runA.id)!.prompt).toContain("## Required final output");

    codex.finish(runA.id, { write: ["feature.txt", "from codex\n"] });
    tick();
    const change = st().artifacts.find((x) => x.taskId === a && x.stepId === "S1" && x.name === "change")!;
    expect(change.ref).toMatch(/^[0-9a-f]{12} on orchestration\/.+\/S1\/run-/);
    expect(change.summary).toContain("feature.txt");
    const attempt = st().attempts.find((x) => x.id === runA.id)!;
    expect(attempt).toMatchObject({ outcome: "completed", sessionId: `codex-session-${runA.id}`, actualModel: "codex-sample-large-actual" });
    expect(attempt.usage?.costUsd).toBe(0.01);
    // The managed repository's working tree is untouched; the work lives on its own branch.
    expect(existsSync(join(repo, "feature.txt"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
    const sha = change.ref!.split(" ")[0];
    expect(git("show", `${sha}:feature.txt`)).toBe("from codex");

    // The reviewer (Claude) gets a read-only worktree at that commit.
    tick();
    const review = runOf(a, "S2");
    const ws = claude.runs.get(review.id)!.workspace;
    expect(ws.access).toBe("read");
    expect(readFileSync(join(ws.path, "feature.txt"), "utf8")).toBe("from codex\n");
    expect(claude.runs.get(review.id)!.prompt).toContain(sha);
  });

  it("repair builds on the reviewed change; the run's branch contains both commits", () => {
    const a = newTask("Needs repair");
    tick();
    codex.finish(runOf(a, "S1").id, { write: ["a.txt", "v1\n"] });
    tick();
    tick();
    claude.finish(runOf(a, "S2").id, { findings: 1 });
    claude.finish(runOf(a, "SR1").id, { findings: 0 });
    tick();
    tick();
    const repair = runOf(a, "S3");
    expect(repair.snapshot.provider).toBe("codex");
    const path = codex.runs.get(repair.id)!.workspace.path;
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("v1\n");
    codex.finish(repair.id, { write: ["a.txt", "v2\n"] });
    tick();
    const fixed = st().artifacts.find((x) => x.taskId === a && x.stepId === "S3")!;
    expect(git("show", `${fixed.ref!.split(" ")[0]}:a.txt`)).toBe("v2");
  });

  it("pause shows Pausing until the adapter confirms, then Paused; project pause reaches both providers", () => {
    const a = newTask("A");
    const b = newTask("B");
    cmd("setStepSelection", { taskId: b, stepId: "S1", selection: { provider: "claude", model: "claude-sample-large" } });
    tick();
    const ra = runOf(a, "S1");
    const rb = runOf(b, "S1");
    cmd("pauseProject");
    tick();
    expect(codex.interrupts).toContain(ra.id);
    expect(claude.interrupts).toContain(rb.id);
    expect(M.stateLabel(st(), task(a))).toBe("Pausing");
    expect(M.stateLabel(st(), task(b))).toBe("Pausing");
    codex.emit({ type: "stopped", attemptId: ra.id, how: "interrupted" });
    tick();
    expect(M.stateLabel(st(), task(a))).toBe("Paused");
    expect(M.stateLabel(st(), task(b))).toBe("Pausing"); // Claude has not confirmed yet
    claude.emit({ type: "stopped", attemptId: rb.id, how: "killed" });
    tick();
    expect(M.stateLabel(st(), task(b))).toBe("Paused");
    cmd("resumeProject");
    tick();
    expect(runOf(a, "S1").id).not.toBe(ra.id); // fresh attempt after resume
    expect(codex.runs.get(runOf(a, "S1").id)!.workspace.path).not.toBe(ra.snapshot.workspace);
  });

  it("an unconfirmed stop becomes a control failure; nothing is redispatched meanwhile", () => {
    const a = newTask("A");
    tick();
    const r = runOf(a, "S1");
    cmd("pauseTask", { taskId: a });
    for (let i = 0; i < 12; i++) tick();
    expect(task(a).controlFailure).toBeDefined();
    expect(M.activeAttempts(st(), a).map((x) => x.id)).toEqual([r.id]);
  });

  it("a failed run blocks the step with the provider's message; no automatic retry or provider switch", () => {
    const a = newTask("A");
    tick();
    const r = runOf(a, "S1");
    codex.emit({ type: "failed", attemptId: r.id, message: "Codex is not signed in." });
    tick();
    tick();
    const step = task(a).steps.find((x) => x.id === "S1")!;
    expect(step.state).toBe("blocked");
    expect(step.blockedReason).toContain("Codex is not signed in.");
    expect(M.activeAttempts(st(), a)).toHaveLength(0);
    expect(claude.runs.size).toBe(0);
  });

  it("a stop nobody requested (time limit) fails the step instead of requeueing it forever", () => {
    const a = newTask("Slow");
    tick();
    const r = runOf(a, "S1");
    codex.emit({ type: "activity", attemptId: r.id, note: "Time limit reached" });
    codex.emit({ type: "stopped", attemptId: r.id, how: "interrupted" });
    tick();
    tick();
    tick();
    expect(st().attempts.find((x) => x.id === r.id)!.outcome).toBe("failed");
    const step = task(a).steps.find((x) => x.id === "S1")!;
    expect(step.state).toBe("blocked");
    expect(step.blockedReason).toMatch(/time limit/);
    expect(M.activeAttempts(st(), a)).toHaveLength(0); // not redispatched
  });

  it("the worker environment and allowed connections flow into the snapshot and the assignment", () => {
    cmd("setWorkerEnvironment", { provider: "codex", environment: "local" });
    cmd("setWorkerConnections", { provider: "claude", names: ["cloudflare", "vercel"] });
    const a = newTask("Env codex");
    const b = newTask("Env claude");
    cmd("setStepSelection", { taskId: b, stepId: "S1", selection: { provider: "claude", model: "claude-sample-large" } });
    tick();
    const ra = runOf(a, "S1");
    const rb = runOf(b, "S1");
    expect(ra.snapshot.environment).toBe("local");
    expect(codex.runs.get(ra.id)!.environment).toBe("local");
    expect(rb.snapshot).toMatchObject({ environment: "isolated", connections: ["cloudflare", "vercel"] });
    expect(claude.runs.get(rb.id)!.connections).toEqual(["cloudflare", "vercel"]);
    // Changing the setting later never relabels a dispatched run.
    cmd("setWorkerEnvironment", { provider: "codex", environment: "isolated" });
    expect(st().attempts.find((x) => x.id === ra.id)!.snapshot.environment).toBe("local");
  });

  it("a malformed output block is not accepted", () => {
    const a = newTask("A");
    tick();
    const r = runOf(a, "S1");
    codex.finish(r.id, { omit: "handoff" });
    tick();
    expect(st().attempts.find((x) => x.id === r.id)!.outcome).toBe("failed");
    expect(task(a).steps.find((x) => x.id === "S1")!.blockedReason).toMatch(/handoff/);
  });

  it("an unready provider blocks its steps with the reason while the other provider keeps working", async () => {
    codex.healthStatus = "not-configured";
    await scheduler.refreshHealth();
    const a = newTask("Codex task");
    const b = newTask("Claude task");
    cmd("setStepSelection", { taskId: b, stepId: "S1", selection: { provider: "claude", model: "claude-sample-large" } });
    tick();
    expect(task(a).steps[0]).toMatchObject({ state: "blocked" });
    expect(task(a).steps[0].blockedReason).toContain("codex needs credentials");
    expect(runOf(b, "S1").snapshot.provider).toBe("claude");
  });

  it("a workspace that cannot be created fails the run visibly", () => {
    tick(); // the repository check passes and is cached
    const a = newTask("A");
    rmSync(join(repo, ".git"), { recursive: true, force: true }); // breaks before the workspace is made
    tick();
    const failed = st().attempts.find((x) => x.taskId === a)!;
    expect(failed.outcome).toBe("failed");
    expect(failed.note).toMatch(/not a git repository/);
  });

  it("restart reconciliation marks real runs lost and starts fresh worktrees", async () => {
    const a = newTask("A");
    tick();
    const r = runOf(a, "S1");
    // Crash: a new scheduler instance with fresh adapters (processes died with the service).
    const claude2 = new ScriptedAdapter("claude");
    const codex2 = new ScriptedAdapter("codex");
    const s2 = new Scheduler(store, { claude: claude2, codex: codex2 }, { workspaces, leaseMs: 30000 });
    await s2.refreshHealth();
    await scheduler.stop();
    now += 1000;
    s2.tick(now);
    expect(st().attempts.find((x) => x.id === r.id)!.outcome).toBe("lost");
    now += 1000;
    s2.tick(now);
    const fresh = M.activeAttempts(st(), a)[0];
    expect(fresh.id).not.toBe(r.id);
    expect(codex2.has(fresh.id)).toBe(true);
    await s2.stop();
  });
});

describe("real-mode safety", () => {
  it("never dispatches when the configured repository is not usable (for example the sample project)", async () => {
    const other = new Store(join(dir, "sample.sqlite")); // default seed: the sample project, repo path does not exist
    const c = new ScriptedAdapter("claude");
    const x = new ScriptedAdapter("codex");
    const sch = new Scheduler(other, { claude: c, codex: x }, { workspaces, leaseMs: 30000 });
    await sch.refreshHealth();
    for (let i = 0; i < 3; i++) sch.tick(now + i * 1000);
    expect(M.activeAttempts(other.read().state)).toHaveLength(0);
    expect(c.runs.size + x.runs.size).toBe(0);
    await sch.stop();
    other.close();
  });

  it("M5: the sample project is never dispatched, even after pointing it at a real repository", async () => {
    const other = new Store(join(dir, "sample2.sqlite")); // sample project (fake-mode seed)
    other.command("setRepoPath", { repoPath: repo }, "rp", iso());
    const c = new ScriptedAdapter("claude");
    const x = new ScriptedAdapter("codex");
    const sch = new Scheduler(other, { claude: c, codex: x }, { workspaces, leaseMs: 30000 });
    await sch.refreshHealth();
    for (let i = 0; i < 3; i++) sch.tick(now + i * 1000);
    expect(M.activeAttempts(other.read().state)).toHaveLength(0);
    expect(c.runs.size + x.runs.size).toBe(0);
    await sch.stop();
    other.close();
  });

  it("a real-mode database starts as an empty project", async () => {
    const { buildEmptyProject } = await import("../src/domain/seed");
    const empty = new Store(join(dir, "empty.sqlite"), () => buildEmptyProject());
    const s = empty.read().state;
    expect(s.tasks).toHaveLength(0);
    expect(s.project.repoPath).toBe("");
    empty.close();
  });
});

describe("review regressions (ORC-004)", () => {
  it("H1: agent-planted git hooks never run in the service's own git calls", () => {
    // The managed repo uses a relative hooks path (husky-style), which resolves inside each worktree.
    git("config", "core.hooksPath", ".githooks");
    const a = newTask("Hooks");
    tick();
    const r = runOf(a, "S1");
    const ws = codex.runs.get(r.id)!.workspace.path;
    const marker = join(dir, "hook-ran");
    mkdirSync(join(ws, ".githooks"), { recursive: true });
    for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      writeFileSync(join(ws, ".githooks", hook), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(join(ws, ".githooks", hook), 0o755);
    }
    codex.finish(r.id, { write: ["x.txt", "x\n"] });
    tick();
    expect(st().attempts.find((x) => x.id === r.id)!.outcome).toBe("completed");
    expect(existsSync(marker)).toBe(false);
  });

  it("H1: a run that rewrites the worktree's .git file is not recorded", () => {
    const a = newTask("Gitdir");
    tick();
    const r = runOf(a, "S1");
    const ws = codex.runs.get(r.id)!.workspace.path;
    writeFileSync(join(ws, ".git"), `gitdir: ${join(repo, ".git")}\n`); // aim at the user's own repository
    codex.finish(r.id, { write: ["y.txt", "y\n"] });
    tick();
    expect(st().attempts.find((x) => x.id === r.id)!.outcome).toBe("failed");
    expect(task(a).steps[0].blockedReason).toMatch(/git metadata/);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1); // nothing committed to the user's branch
  });

  it("H2: a null output block fails the run instead of wedging it", () => {
    const a = newTask("Null");
    tick();
    const r = runOf(a, "S1");
    codex.emit({ type: "completed", attemptId: r.id, finalText: "done\n```json\nnull\n```" });
    tick();
    tick();
    expect(st().attempts.find((x) => x.id === r.id)!.outcome).toBe("failed");
  });

  it("low: summaries containing their own code fences still parse", () => {
    const block = JSON.stringify({ outputs: { notes: { summary: "Use:\n```js\nx()\n```\nok" } } }, null, 2);
    const text = `Done.\n\`\`\`json\n${block}\n\`\`\``;
    const parsed = parseOutputs(text, [{ name: "notes", kind: "report" }]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.outputs[0].summary).toContain("x()");
  });
});

describe("workspace checks", () => {
  it("never treats an empty or relative repository path as the current directory", () => {
    expect(workspaces.check("")).toMatchObject({ ok: false });
    expect(workspaces.check("relative/repo")).toMatchObject({ ok: false });
    expect(workspaces.check(repo)).toMatchObject({ ok: true });
  });
});

describe("envelope and outputs", () => {
  it("builds an envelope with spec, inputs, workspace rules, and the output contract", () => {
    const a = newTask("Envelope");
    const s: State = st();
    const t = s.tasks.find((x) => x.id === a)!;
    const text = buildEnvelope({ state: s, task: t, step: t.steps[0], attemptId: "run-x", access: "write" });
    expect(text).toContain("Envelope outcome");
    expect(text).toContain("It works");
    expect(text).toContain("Do not start sub-agents");
    expect(text).toContain('"change"');
    expect(text).toContain('"handoff"');
  });

  it("parses the last JSON block and reports missing or invalid outputs", () => {
    const declared = [
      { name: "findings", kind: "review-findings" as const },
      { name: "notes", kind: "report" as const },
    ];
    const ok = parseOutputs('x\n```json\n{"outputs":{"findings":{"summary":"none","openFindings":0},"notes":"short"}}\n```', declared);
    expect(ok.problems).toEqual([]);
    expect(ok.outputs).toHaveLength(2);
    expect(parseOutputs("no block", declared).problems[0]).toMatch(/no parseable JSON/);
    const bad = parseOutputs('```json\n{"outputs":{"findings":{"summary":"x","openFindings":-1}}}\n```', declared);
    expect(bad.problems.join(" ")).toMatch(/openFindings/);
    expect(bad.problems.join(" ")).toMatch(/notes/);
  });
});
