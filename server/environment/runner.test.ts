// The environment runner without Docker: it hands a run to the host sandbox with the reason, the host sandbox records
// that reason, and the facade routes a run with an environment to it. The probe's judgement, on what a client saw.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckRunners, DirectChecks, type CheckAssignment, type CheckRunner } from "../checks";
import type { AdapterEvent } from "../runtimes/types";
import { EnvironmentChecks } from "./runner";
import { PROBE_PRIVATE_HOST, PreparedEnvironments, judgeEnvProbe } from "./prepared";
import { removeTree } from "./copy";
import { phaseArgs } from "./docker";
import { runDocker } from "../studio/container";

const plan = { source: { from: "setting" as const, image: "python:3.13@sha256:" + "a".repeat(64) }, prepare: [["make"]], prepareFrom: "setting" as const, hosts: ["pypi.org"] };

function assignment(dir: string, o: Partial<CheckAssignment> = {}): CheckAssignment {
  return {
    attemptId: `a-${Math.random().toString(36).slice(2, 8)}`, taskId: "T1", stepId: "C1", workspace: dir, target: "f".repeat(40),
    commands: [{ id: "test", label: "test", kind: "check", argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 20_000 }],
    runTimeoutMs: 60_000, sandbox: "none", prepareNetwork: false, env: { PATH: process.env.PATH ?? "" }, tmpDir: join(dir, "t"), cacheDir: join(dir, "c"), logDir: join(dir, "l"),
    environment: { plan, project: "p1" }, ...o,
  };
}

const stub = () => {
  const started: CheckAssignment[] = [];
  const r = { started, start: (a: CheckAssignment) => started.push(a), has: () => false, ids: () => [], onEvent: () => () => {}, interrupt() {}, kill() {}, probe: async () => ({}) as never, shutdown: async () => {}, simulated: false } as unknown as CheckRunner & { started: CheckAssignment[] };
  return r;
};

describe("without Docker", () => {
  it("hands the run to the host sandbox, with the reason, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-env-unit-"));
    const host = stub();
    const env = new EnvironmentChecks({ environments: new PreparedEnvironments({ docker: "/nonexistent/docker", root: dir }), fallback: () => host });
    const events: AdapterEvent[] = [];
    env.onEvent((e) => events.push(e));
    const a = assignment(dir);
    env.start(a);
    for (let i = 0; i < 50 && !host.started.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(host.started).toHaveLength(1);
    expect(host.started[0]).toMatchObject({ attemptId: a.attemptId, environment: undefined, hostReason: expect.stringMatching(/Docker is not installed/) });
    expect(env.has(a.attemptId)).toBe(false);
    expect(events.map((e) => e.type === "activity" && e.note)).toContainEqual(expect.stringMatching(/^Running on this computer: Docker is not installed/));
    removeTree(dir);
  });

  it("the host sandbox's record says why the environment did not run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-env-unit-"));
    const direct = new DirectChecks({});
    const done = new Promise<AdapterEvent>((res) => direct.onEvent((e) => (e.type === "completed" || e.type === "failed") && res(e)));
    direct.start(assignment(dir, { environment: undefined, hostReason: "Docker is not running" }));
    const e = await done;
    expect(e).toMatchObject({ type: "completed", checks: { environment: { ran: "host", reason: "Docker is not running" } } });
    removeTree(dir);
  });

  it("the facade sends a run with an environment to the environment runner, and others to the host sandboxes", () => {
    const codex = stub();
    const direct = stub();
    const env = stub();
    const f = new CheckRunners(codex, direct, env);
    f.start(assignment("/x"));
    f.start(assignment("/x", { environment: undefined, sandbox: "codex" }));
    f.start(assignment("/x", { environment: undefined }));
    expect([env.started.length, codex.started.length, direct.started.length]).toEqual([1, 1, 1]);
  });
});

describe("the setup probe's judgement", () => {
  const good = { outside: "ENETUNREACH", host: "ENETUNREACH", dns: "EAI_AGAIN", vm: { "172.17.0.1": "ENETUNREACH", "172.30.0.1": "EHOSTUNREACH" }, proxyOutside: "HTTP/1.1 403 Forbidden", proxyLoopback: "HTTP/1.1 403 Forbidden", proxyHost: "HTTP/1.1 403 Forbidden", proxyPrivate: "HTTP/1.1 403 Forbidden" };
  const decided = [{ orchestratorProxy: 1 as const, host: PROBE_PRIVATE_HOST, port: 443, allowed: false, reason: "resolves to a local or private address (192.168.5.2)" }];
  it("passes only when nothing but the proxy is reachable and the proxy refuses", () => {
    expect(judgeEnvProbe(good, 0, decided)).toBeUndefined();
    expect(judgeEnvProbe({ ...good, outside: "TIMEOUT" }, 0, decided)).toBeUndefined();
    expect(judgeEnvProbe({ ...good, outside: "CONNECTED" }, 0, decided)).toMatch(/reached the internet directly/);
    expect(judgeEnvProbe({ ...good, host: "CONNECTED" }, 0, decided)).toMatch(/reached this computer/);
    expect(judgeEnvProbe(good, 1, decided)).toMatch(/1 connection\(s\) to the canary/);
    expect(judgeEnvProbe({ ...good, dns: "RESOLVED 93.184.215.14" }, 0, decided)).toMatch(/resolved an outside name/);
    expect(judgeEnvProbe({ ...good, proxyLoopback: "HTTP/1.1 200 Connection Established" }, 0, decided)).toMatch(/did not refuse this computer's loopback/);
  });

  it("a refused connection means a host answered; the Docker VM must not answer on any of its addresses (review finding 5)", () => {
    // ECONNREFUSED is an answer: the host is reachable, only the port is closed.
    expect(judgeEnvProbe({ ...good, outside: "ECONNREFUSED" }, 0, decided)).toMatch(/reached the internet directly/);
    expect(judgeEnvProbe({ ...good, host: "ECONNREFUSED" }, 0, decided)).toMatch(/reached this computer/);
    // The private network's own gateway (an engine that ignores the isolated mode) answers on the VM's SSH port.
    expect(judgeEnvProbe({ ...good, vm: { ...good.vm, "172.18.0.1": "CONNECTED" } }, 0, decided)).toMatch(/reached the Docker VM at 172\.18\.0\.1:22 \(CONNECTED\)/);
    expect(judgeEnvProbe({ ...good, vm: { "172.17.0.1": "ECONNREFUSED" } }, 0, decided)).toMatch(/reached the Docker VM at 172\.17\.0\.1:22/);
    expect(judgeEnvProbe({ ...good, vm: {} }, 0, decided)).toMatch(/no address of the Docker VM to try/);
  });

  it("the proxy's private-address rule must be the one that refused the listed name that resolves to the host (review finding 5)", () => {
    expect(judgeEnvProbe({ ...good, proxyPrivate: "HTTP/1.1 502 Bad Gateway" }, 0, decided)).toMatch(/did not refuse a listed name that resolves to this computer/);
    // A 403 for another reason (the list, the port) does not show the rule works.
    expect(judgeEnvProbe(good, 0, [{ ...decided[0], reason: "not on the list of registries" }])).toMatch(/private-address rule did not refuse/);
    expect(judgeEnvProbe(good, 0, [])).toMatch(/private-address rule did not refuse/);
  });
});

// Each docker command of the stand-in is a Node process (about 30 per run): on a busy machine a run takes seconds.
describe("with a stand-in for Docker (server/testing/fake-docker.mjs)", { timeout: 30_000 }, () => {
  const FAKE = new URL("../testing/fake-docker.mjs", import.meta.url).pathname;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok: () => boolean, ms = 10_000) => {
    for (const t0 = Date.now(); !ok(); await sleep(20)) if (Date.now() - t0 > ms) throw new Error("timed out waiting");
  };
  /** A runner on the stand-in, a workspace to copy, and where a run's copy goes. */
  function setup(o: { prepare?: string[][] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "orc-env-fake-"));
    const ws = join(dir, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "README.md"), "a change\n");
    const root = join(dir, "root");
    const environments = new PreparedEnvironments({ root, docker: FAKE, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCKER_CONFIG: join(dir, "docker") } });
    const runner = new EnvironmentChecks({ environments, fallback: () => stub() });
    const events: AdapterEvent[] = [];
    runner.onEvent((e) => events.push(e));
    const stage = (a: CheckAssignment) => join(root, "p1", "runs", a.attemptId);
    const ended = (a: CheckAssignment) => until(() => events.some((e) => e.attemptId === a.attemptId && (e.type === "completed" || e.type === "failed" || e.type === "stopped")));
    return { dir, ws, root, runner, events, stage, ended, plan: { ...plan, prepare: o.prepare ?? [] } };
  }

  for (const how of ["killed", "past its time limit"] as const) {
    it(`a run ${how}: its copy goes only after the container that mounts it is gone (review finding 4)`, async () => {
      const { dir, ws, runner, stage, plan: p } = setup();
      const a = assignment(ws, { commands: [{ id: "test", label: "beat", kind: "check", argv: ["fake-beat"], timeoutMs: 60_000 }], runTimeoutMs: how === "killed" ? 60_000 : 1500, environment: { plan: p, project: "p1" } });
      runner.start(a);
      await until(() => existsSync(join(stage(a), "work", "beat")));
      if (how === "killed") runner.kill(a.attemptId);
      // The stand-in's container beats into the copy for 500 ms after its kill, making the folder again if it is gone.
      await until(() => !existsSync(stage(a)));
      await sleep(900);
      expect(existsSync(stage(a))).toBe(false);
      removeTree(dir);
    });
  }

  it("a step's own container still runs when the step ends: the copy goes only after it is gone (review finding 4)", async () => {
    const { dir, ws, root, plan: p } = setup();
    const docker = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCKER_CONFIG: join(dir, "docker") };
    const environments = new PreparedEnvironments({ root, docker: FAKE, env: docker });
    const run = join(root, "p1", "runs", "ev-1");
    const out = await environments.withPrepared({ attemptId: "ev-1", workspace: ws, sha: "f".repeat(40), environment: { plan: p, project: "p1" }, logDir: join(dir, "logs") }, async (c) => {
      // A preview the step started, tracked, and whose removal failed: it still beats into the copy.
      const name = "orc-env-preview-1-abc";
      c.track(name);
      await runDocker(c.docker, phaseArgs({ name, image: c.image, work: c.work, argv: ["fake-beat"], phase: { kind: "preview", port: 8000 }, imageEnv: c.imageEnv }), { env: c.denv, timeoutMs: 10_000 });
      await until(() => existsSync(join(c.work, "beat")));
    });
    expect(out.ok).toBe(true);
    await until(() => !existsSync(run));
    await sleep(900);
    expect(existsSync(run)).toBe(false);
    removeTree(dir);
  });

  it("a command that fills the mounted folders past the disk limit is stopped, with the reason (review finding 11)", async () => {
    const { dir, ws, root, ended, events } = setup();
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCKER_CONFIG: join(dir, "docker") };
    const environments = new PreparedEnvironments({ root, docker: FAKE, env, diskBytes: 1024 * 1024, diskCheckMs: 100 });
    const runner = new EnvironmentChecks({ environments, fallback: () => stub() });
    runner.onEvent((e) => events.push(e));
    const a = assignment(ws, {
      commands: [
        { id: "fill", label: "fill", kind: "check", argv: ["fake-fill", String(3 * 1024 * 1024)], timeoutMs: 8000 },
        { id: "next", label: "next", kind: "check", argv: ["fake-exit", "0"], timeoutMs: 8000 },
      ],
      environment: { plan: { ...plan, prepare: [] }, project: "p1" },
    });
    const t0 = Date.now();
    runner.start(a);
    await ended(a);
    const done = events.find((e) => e.attemptId === a.attemptId && e.type === "completed") as Extract<AdapterEvent, { type: "completed" }> | undefined;
    const results = (done?.checks as { results: { id: string; status: string; excerpt: string }[] } | undefined)?.results ?? [];
    expect(results.map((r) => `${r.id}:${r.status}`)).toEqual(["fill:failed", "next:failed"]);
    expect(results[0].excerpt).toMatch(/the copy and the cache \(\/work and \/cache\) passed the environment's disk limit of 1\.0 MB/);
    expect(results[1].excerpt).toMatch(/Not run: the copy and the cache/);
    // Well before the command's own 8 s limit.
    expect(Date.now() - t0).toBeLessThan(6000);
    removeTree(dir);
  });

  it("records where the prepare commands came from, and \"none\" when nothing was prepared (review finding 8)", async () => {
    const { dir, ws, runner, events, ended } = setup();
    const record = async (prepare: string[][], prepareFrom: "setting" | "checks" | "none") => {
      const a = assignment(ws, { commands: [{ id: "test", label: "test", kind: "check", argv: ["fake-exit", "0"], timeoutMs: 8000 }], environment: { plan: { ...plan, prepare, prepareFrom }, project: "p1" } });
      runner.start(a);
      await ended(a);
      const done = events.find((e) => e.attemptId === a.attemptId && e.type === "completed") as Extract<AdapterEvent, { type: "completed" }>;
      return (done.checks as { environment: Record<string, unknown>; results: { id: string; status: string }[] });
    };
    const none = await record([], "none");
    expect(none.environment).toMatchObject({ ran: "container", prepare: "none", prepareMs: 0 });
    expect(none.environment.prepareFrom).toBeUndefined();
    expect(none.results.map((r) => `${r.id}:${r.status}`)).toEqual(["test:passed"]);
    const checks = await record([["fake-exit", "0"]], "checks");
    expect(checks.environment).toMatchObject({ ran: "container", prepare: "ran", prepareFrom: "checks" });
    expect(checks.results.map((r) => `${r.id}:${r.status}`)).toEqual(["env-prepare-1:passed", "test:passed"]);
    removeTree(dir);
  });

  it("a project cache past half the disk limit starts again empty before a prepare (review finding 11)", async () => {
    const { dir, ws, root, ended, events } = setup();
    const environments = new PreparedEnvironments({ root, docker: FAKE, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCKER_CONFIG: join(dir, "docker") }, diskBytes: 1024 * 1024 });
    const runner = new EnvironmentChecks({ environments, fallback: () => stub() });
    runner.onEvent((e) => events.push(e));
    mkdirSync(join(root, "p1", "cache", "xdg"), { recursive: true });
    writeFileSync(join(root, "p1", "cache", "xdg", "old"), Buffer.alloc(600 * 1024));
    const a = assignment(ws, { commands: [{ id: "test", label: "test", kind: "check", argv: ["fake-exit", "0"], timeoutMs: 8000 }], environment: { plan: { ...plan, prepare: [["fake-exit", "0"]] }, project: "p1" } });
    runner.start(a);
    await ended(a);
    expect(existsSync(join(root, "p1", "cache", "xdg", "old"))).toBe(false);
    expect(events.map((e) => (e.type === "activity" ? e.note : ""))).toContainEqual(expect.stringMatching(/^Emptied the project's cache folder \(0\.6 MB, more than half the disk limit of 1\.0 MB\)/));
    expect(events.find((e) => e.attemptId === a.attemptId && e.type === "completed")).toBeDefined();
    removeTree(dir);
  });
});
