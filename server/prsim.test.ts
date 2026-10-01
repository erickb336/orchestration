// Pull-request scenario 19: with the fake runtime the whole pull-request flow runs on the simulated
// GitHub. No process is ever started (no git, no gh), and every record is labelled simulated.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const counted = <T extends (...a: never[]) => unknown>(name: string, fn: T): T =>
    ((...a: never[]) => {
      spawned.calls.push(`${name} ${String(a[0])}`);
      return fn(...a);
    }) as T;
  return {
    ...real,
    spawn: counted("spawn", real.spawn as never),
    spawnSync: counted("spawnSync", real.spawnSync as never),
    exec: counted("exec", real.exec as never),
    execSync: counted("execSync", real.execSync as never),
    execFile: counted("execFile", real.execFile as never),
    execFileSync: counted("execFileSync", real.execFileSync as never),
    fork: counted("fork", real.fork as never),
  };
});

import * as D from "../src/domain/delivery";
import type { State } from "../src/domain/types";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler, simSha } from "./scheduler";
import { Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";

let dir: string;
let store: Store;
let scheduler: Scheduler;
let now = Date.parse("2026-09-30T12:00:00Z");
const iso = () => new Date(now).toISOString();
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const tick = async (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
  await scheduler.prIdle();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-prsim-"));
  store = new Store(join(dir, "db.sqlite"));
  const config = defaultFakeConfig();
  scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
  spawned.calls = [];
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("fake runtime (scenario 19)", () => {
  it("the whole flow runs on the simulated GitHub: zero processes, every record labelled simulated", async () => {
    cmd("setDeliveryMode", { mode: "pr" });
    const id = (cmd("createTask", { title: "Simulated change", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
    setTestPipeline(store, id, [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], iso(), "one step");
    cmd("setPriority", { taskId: id, priority: 1 });

    for (let i = 0; i < 200 && !(task(id).integration?.pr?.phase === "open" && D.prReady(st(), task(id), now)); i++) await tick();
    const pr = task(id).integration!.pr!;
    expect(st().project.github).toMatchObject({ ok: true, simulated: true, repo: "simulated/repository", requiredChecks: ["simulated-check"], base: { sha: "sim-base" } });
    expect(pr).toMatchObject({ phase: "open", simulated: true, number: 1000, url: "simulated://pr/1000", policy: "hold", headSha: simSha(`${id}-1`) });
    expect(simSha(`${id}-1`)).toMatch(/^sim[0-9a-f]{9}$/); // shown whole: commits are cut to 12 characters
    expect(D.prLabel(st(), task(id), now)).toEqual({ text: "PR #1000 ready to merge", tone: "strong", simulated: true });
    expect(st().events.some((e) => e.message.includes("Opened pull request #1000") && e.message.includes("(simulated)"))).toBe(true);

    // Held: it merges only when asked.
    for (let i = 0; i < 5; i++) await tick(31_000);
    expect(task(id).integration!.pr!.phase).toBe("open");
    cmd("requestPrMerge", { taskId: id, headSha: pr.headSha });
    for (let i = 0; i < 10 && task(id).integration!.pr!.phase === "open"; i++) await tick(3000);
    expect(task(id).integration!.pr!.phase).toBe("merged");
    const landed = task(id).integration!.landed!;
    expect(landed).toMatchObject({ via: "pr", simulated: true, by: "app", commit: "sim-m1000", status: "unreviewed", target: "simulated/repository main", pr: { number: 1000, url: "simulated://pr/1000" } });
    expect(D.unreviewedCount(st())).toBeGreaterThanOrEqual(1);
    // A simulated item has no commit to revert and takes no comment on GitHub.
    expect(() => cmd("sendBackLanded", { taskId: id, kind: "revert", note: "", holdBeforeStart: false })).toThrow(/simulated/);
    expect(() => cmd("addLandedNote", { taskId: id, text: "note", postToGitHub: true })).toThrow(/real pull request/);

    expect(spawned.calls).toEqual([]);
    // The counter does see a process when one is started.
    const cp = await import("node:child_process");
    cp.execFileSync("git", ["--version"]);
    expect(spawned.calls).toEqual(["execFileSync git"]);
  });

  it("automatic merging on the simulated GitHub: reviewed, merged by itself, still zero processes and every record simulated", async () => {
    cmd("setDeliveryMode", { mode: "pr" });
    cmd("setPrDelivery", { config: { merge: "auto" } });
    cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "auto" } });
    cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "auto" } });
    const id = (cmd("createTask", { title: "Simulated automatic change", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
    setTestPipeline(store, id, [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], iso(), "one step");
    cmd("setPriority", { taskId: id, priority: 1 });
    for (let i = 0; i < 400 && task(id).integration?.pr?.phase !== "merged"; i++) await tick(2000);
    const pr = task(id).integration!.pr!;
    expect(pr).toMatchObject({ phase: "merged", simulated: true, policy: "auto" });
    // Its one-step pipeline had no review: exactly one dedicated review ran, on the other provider.
    const reviews = st().tasks.filter((t) => t.reviewTarget?.taskId === id);
    expect(reviews).toHaveLength(1);
    const evidence = task(id).integration!.landed!.review!;
    expect(evidence).toMatchObject({ ok: true, source: "dedicated", forSha: pr.changeSha });
    expect(evidence.provider).not.toBe(pr.changeAuthor);
    expect(task(id).integration!.landed).toMatchObject({ simulated: true, by: "app", via: "pr" });
    expect(st().events.some((e) => e.message.includes("merged into main by Orchestrator, automatically") && e.message.includes("(simulated)"))).toBe(true);
    expect(spawned.calls).toEqual([]);
  });

  it("a real service that was started without a GitHub connection says so instead of doing anything", async () => {
    // (Still no process: the driver reports the missing connection from the repository check.)
    const { PrDriver } = await import("./prdelivery");
    cmd("setDeliveryMode", { mode: "pr" });
    const driver = new PrDriver(store, undefined, undefined);
    scheduler.tick(now); // holds the lease
    driver.tick(now, { name: "scheduler", holder: scheduler.holder, nowMs: now });
    await driver.idle();
    driver.tick(now + 1000, { name: "scheduler", holder: scheduler.holder, nowMs: now + 1000 });
    expect(st().project.github).toMatchObject({ ok: false, problem: { code: "gh-missing" } });
    expect(spawned.calls).toEqual([]);
  });
});
