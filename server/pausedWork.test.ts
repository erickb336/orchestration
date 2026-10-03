// Resume starts from the paused work's changes (ORC-030 C4), with real git in a temporary repository and scripted
// adapters for Claude and Codex. The service records a paused writer's files as a commit on its own branch once the
// runtime confirmed the stop, and the step's next run gets them applied, uncommitted, from the same base, so its
// change still compares to the base and the reviews see all of it. Also: keeping the Mac awake while runs are active.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as M from "../src/domain/model";
import { startFactoryArgs } from "../src/domain/testing/factory";
import type { State } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

// Real git and many scheduler cycles per test.
vi.setConfig({ testTimeout: 20_000 });

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let workspaces: WorkspaceManager;
let scheduler: Scheduler;
let awake: boolean[];
let now = Date.parse("2026-10-03T12:00:00Z");
const iso = () => new Date(now).toISOString();
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const commit = (file: string, text: string, msg: string) => {
  writeFileSync(join(repo, file), text);
  git("add", "-A");
  git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", msg);
};
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
const run = (id: string) => M.activeAttempts(st(), id)[0];
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const newTask = (title: string) =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
const oneStep = (id: string) =>
  setTestPipeline(store, id, [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], iso(), "one step");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-paused-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commit("README.md", "hello\n", "init");
  commit("app.txt", "one\ntwo\nthree\n", "app");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  workspaces = new WorkspaceManager(join(dir, "worktrees"));
  awake = [];
  scheduler = new Scheduler(store, { claude, codex }, { workspaces, leaseMs: 120_000, ackTimeoutMs: 10_000, keepAwake: { set: (active) => awake.push(active) } });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Paused", repoPath: repo, vision: "v", focus: "f" });
  cmd("startFactory", startFactoryArgs(store.read().state));
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A writer worktree of `attemptId` on the repository's HEAD, as the scheduler prepares one. */
const writer = (attemptId: string, seed?: Parameters<WorkspaceManager["prepare"]>[0]["seed"]) =>
  workspaces.prepare({ repoPath: repo, projectId: "p", attemptId, taskId: "T", stepId: "S1", access: "write", ...(seed ? { seed } : {}) });

describe("recording a paused writer's work", () => {
  it("records tracked, untracked and deleted files as one commit on the run's own branch, as Orchestrator, with no hook run", () => {
    // A hook that would leave a trace if the service ever ran one.
    const hooks = join(repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    for (const h of ["pre-commit", "post-commit", "post-index-change"]) {
      writeFileSync(join(hooks, h), `#!/bin/sh\ntouch "${join(dir, `hook-${h}`)}"\n`);
      chmodSync(join(hooks, h), 0o755);
    }
    const ws = writer("run-p");
    writeFileSync(join(ws.path, "app.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(ws.path, "new.txt"), "new\n");
    rmSync(join(ws.path, "README.md"));
    const kept = workspaces.keepPaused({ ...ws, message: "T S1: paused work (run-p)" })!;
    // Checked before this test runs git itself (its own `git status` would run the index hook).
    for (const h of ["pre-commit", "post-commit", "post-index-change"]) expect(existsSync(join(dir, `hook-${h}`)), h).toBe(false);
    expect(kept).toMatchObject({ base: ws.base, files: ["README.md", "app.txt", "new.txt"], total: 3 });
    expect(gitIn(ws.path, "rev-parse", ws.branch!)).toBe(kept.commit);
    expect(git("rev-parse", `${kept.commit}^`)).toBe(ws.base);
    expect(git("log", "-1", "--format=%an <%ae>", kept.commit)).toBe("Orchestration <orchestration@localhost>");
    expect(git("show", `${kept.commit}:new.txt`)).toBe("new");
    expect(gitIn(ws.path, "status", "--porcelain")).toBe(""); // nothing left only in the worktree
    // Again (a drain that is applied twice): the same commit, not a new one.
    expect(workspaces.keepPaused({ ...ws, message: "again" })!.commit).toBe(kept.commit);
  });

  it("a run that changed nothing records nothing", () => {
    const ws = writer("run-n");
    expect(workspaces.keepPaused({ ...ws, message: "nothing" })).toBeNull();
    expect(gitIn(ws.path, "rev-parse", ws.branch!)).toBe(ws.base);
  });
});

describe("the carry: the next run starts from the paused work", () => {
  it("on the same base: the files as the paused run left them, uncommitted; the final change compares to the base", () => {
    const paused = writer("run-a");
    writeFileSync(join(paused.path, "app.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(paused.path, "half.txt"), "half done\n");
    const kept = workspaces.keepPaused({ ...paused, message: "paused" })!;
    const next = writer("run-b", { kind: "carry", commit: kept.commit, base: kept.base });
    expect(next.base).toBe(kept.base);
    expect(next.seed).toEqual({ kind: "carry", commit: kept.commit, from: kept.base, conflicted: [], files: ["app.txt", "half.txt"], total: 2 });
    expect(readFileSync(join(next.path, "half.txt"), "utf8")).toBe("half done\n");
    expect(gitIn(next.path, "rev-parse", "HEAD")).toBe(next.base); // nothing committed
    expect(gitIn(next.path, "status", "--porcelain").split("\n").sort()).toEqual(["A  half.txt", "M  app.txt"]);
    writeFileSync(join(next.path, "half.txt"), "all done\n");
    const c = workspaces.commit({ ...next, message: "T S1: finished" });
    expect(c.changed).toBe(true);
    expect(git("rev-parse", `${c.sha}^`)).toBe(next.base);
    expect(c.files.sort()).toEqual(["app.txt", "half.txt"]);
    expect(git("show", `${c.sha}:app.txt`)).toBe("one\nTWO\nthree");
    expect(git("log", "-1", "--format=%an", c.sha)).toBe("Orchestration");
  });

  it("on a moved base: a conflict is left with markers, and the work is not recorded while one remains", () => {
    const paused = writer("run-c");
    writeFileSync(join(paused.path, "app.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(paused.path, "other.txt"), "mine\n");
    const kept = workspaces.keepPaused({ ...paused, message: "paused" })!;
    commit("app.txt", "one\ntwo, changed on main\nthree\n", "main moved");
    const next = writer("run-d", { kind: "carry", commit: kept.commit, base: kept.base });
    expect(next.base).toBe(git("rev-parse", "main"));
    expect(next.seed!.conflicted).toEqual(["app.txt"]);
    expect(readFileSync(join(next.path, "app.txt"), "utf8")).toMatch(/^<<<<<<< /m);
    expect(readFileSync(join(next.path, "other.txt"), "utf8")).toBe("mine\n");
    expect(() => workspaces.commit({ ...next, message: "T S1" })).toThrow(/unresolved conflict markers in app\.txt/);
    writeFileSync(join(next.path, "app.txt"), "one\nTWO, changed on main\nthree\n");
    const c = workspaces.commit({ ...next, message: "T S1" });
    expect(git("rev-parse", `${c.sha}^`)).toBe(next.base);
    expect(c.files.sort()).toEqual(["app.txt", "other.txt"]);
  });

  it("conflict markers the paused run itself left unresolved are checked too", () => {
    const paused = writer("run-e");
    writeFileSync(join(paused.path, "app.txt"), "one\n<<<<<<< HEAD\ntwo\n=======\nTWO\n>>>>>>> theirs\nthree\n");
    const kept = workspaces.keepPaused({ ...paused, message: "paused" })!;
    const next = writer("run-f", { kind: "carry", commit: kept.commit, base: kept.base });
    expect(next.seed!.conflicted).toEqual(["app.txt"]);
    expect(() => workspaces.commit({ ...next, message: "T S1" })).toThrow(/unresolved conflict markers in app\.txt/);
    writeFileSync(join(next.path, "app.txt"), "one\nTWO\nthree\n");
    expect(workspaces.commit({ ...next, message: "T S1" }).changed).toBe(true);
  });

  it("paused work that is no longer in the repository fails the start and leaves no worktree", () => {
    expect(() => writer("run-g", { kind: "carry", commit: "f".repeat(40), base: git("rev-parse", "HEAD") })).toThrow(/no longer in the repository/);
    expect(existsSync(workspaces.pathFor(repo, "run-g", "p"))).toBe(false);
  });
});

describe("pause and resume a writer mid-change (scheduler, scripted runtimes)", () => {
  it("resumes from the paused run's changes; the final change includes them; the paused run's late result never lands", () => {
    const id = newTask("Half-done change");
    oneStep(id);
    tick();
    const first = run(id);
    const ws1 = codex.runs.get(first.id)!.workspace.path;
    writeFileSync(join(ws1, "app.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(ws1, "wip.txt"), "started\n");
    cmd("pauseTask", { taskId: id });
    tick();
    expect(codex.interrupts).toContain(first.id);
    // Nothing is recorded before the runtime confirms the stop.
    expect(task(id).steps[0].pausedWork).toBeUndefined();
    codex.emit({ type: "stopped", attemptId: first.id, how: "interrupted" });
    tick();
    const pw = task(id).steps[0].pausedWork!;
    expect(pw).toMatchObject({ attemptId: first.id, files: ["app.txt", "wip.txt"], total: 2 });
    expect(git("rev-parse", `orchestration/${st().project.id}/${id}/S1/${first.id}`)).toBe(pw.commit);
    expect(st().attempts.find((a) => a.id === first.id)!.outcome).toBe("stopped");

    cmd("resumeTask", { taskId: id });
    tick();
    const second = run(id);
    expect(second.id).not.toBe(first.id);
    expect(second.snapshot.startedFrom).toMatchObject({ attemptId: first.id, commit: pw.commit });
    const a2 = codex.runs.get(second.id)!;
    expect(readFileSync(join(a2.workspace.path, "wip.txt"), "utf8")).toBe("started\n");
    expect(a2.prompt).toContain("starts from the changes of the paused run");
    expect(a2.prompt).toContain("- wip.txt");
    expect(a2.prompt).toMatch(/Review these changes first/);

    // A late result from the paused run is ignored: its process was told to stop and its run is over.
    codex.emit({ type: "completed", attemptId: first.id, finalText: "late\n```json\n{\"outputs\":{\"change\":{\"summary\":\"late\"}}}\n```" });
    codex.finish(second.id, { write: ["wip.txt", "finished\n"] });
    tick();
    const change = st().artifacts.find((x) => x.taskId === id && x.name === "change")!;
    expect(change.attemptId).toBe(second.id);
    const sha = change.ref!.split(" ")[0];
    expect(git("show", `${sha}:wip.txt`)).toBe("finished");
    expect(git("show", `${sha}:app.txt`)).toBe("one\nTWO\nthree");
    // The change compares to the base the paused run started from: its parent is that base.
    expect(git("rev-parse", `${sha}^`)).toBe(pw.base);
    expect(change.summary).toContain("app.txt");
    expect(st().attempts.find((a) => a.id === first.id)!.outcome).toBe("stopped");
    expect(task(id).steps[0].pausedWork).toBeUndefined();
  });

  it("a writer that changed nothing keeps nothing; the next run starts from the base", () => {
    const id = newTask("Nothing yet");
    oneStep(id);
    tick();
    const first = run(id);
    cmd("pauseTask", { taskId: id });
    tick();
    codex.emit({ type: "stopped", attemptId: first.id, how: "interrupted" });
    tick();
    expect(task(id).steps[0].pausedWork).toBeUndefined();
    cmd("resumeTask", { taskId: id });
    tick();
    expect(run(id).snapshot.startedFrom).toBeUndefined();
    expect(codex.runs.get(run(id).id)!.prompt).not.toContain("paused run");
  });

  it("holds the Mac awake while a run is active, lets go when none is, and when the service stops", async () => {
    expect(awake.filter(Boolean)).toHaveLength(0);
    const id = newTask("Awake");
    oneStep(id);
    tick();
    expect(awake.at(-1)).toBe(true);
    codex.finish(run(id).id, { write: ["x.txt", "x\n"] });
    tick();
    expect(M.activeAttempts(st())).toHaveLength(0);
    expect(awake.at(-1)).toBe(false);
    newTask("Awake again");
    tick();
    expect(awake.at(-1)).toBe(true);
    await scheduler.stop();
    expect(awake.at(-1)).toBe(false);
  });
});
