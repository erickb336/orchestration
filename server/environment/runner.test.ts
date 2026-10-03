// The environment runner without Docker: it hands a run to the host sandbox with the reason, the host sandbox records
// that reason, and the facade routes a run with an environment to it. The probe's judgement, on what a client saw.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckRunners, DirectChecks, type CheckAssignment, type CheckRunner } from "../checks";
import type { AdapterEvent } from "../runtimes/types";
import { EnvironmentChecks } from "./runner";
import { PreparedEnvironments, judgeEnvProbe } from "./prepared";
import { removeTree } from "./copy";

const plan = { source: { from: "setting" as const, image: "python:3.13@sha256:" + "a".repeat(64) }, prepare: [["make"]], hosts: ["pypi.org"] };

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
  const good = { outside: "ENETUNREACH", host: "ENETUNREACH", dns: "EAI_AGAIN", proxyOutside: "HTTP/1.1 403 Forbidden", proxyLoopback: "HTTP/1.1 403 Forbidden", proxyHost: "HTTP/1.1 403 Forbidden" };
  it("passes only when nothing but the proxy is reachable and the proxy refuses", () => {
    expect(judgeEnvProbe(good, 0)).toBeUndefined();
    expect(judgeEnvProbe({ ...good, outside: "CONNECTED" }, 0)).toMatch(/reached the internet directly/);
    expect(judgeEnvProbe({ ...good, outside: "TIMEOUT" }, 0)).toMatch(/reached the internet directly/);
    expect(judgeEnvProbe({ ...good, host: "CONNECTED" }, 0)).toMatch(/reached this computer/);
    expect(judgeEnvProbe(good, 1)).toMatch(/1 connection\(s\) to the canary/);
    expect(judgeEnvProbe({ ...good, dns: "RESOLVED 93.184.215.14" }, 0)).toMatch(/resolved an outside name/);
    expect(judgeEnvProbe({ ...good, proxyLoopback: "HTTP/1.1 200 Connection Established" }, 0)).toMatch(/did not refuse this computer's loopback/);
  });
});
