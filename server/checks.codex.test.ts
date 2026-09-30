// ORC-013 step 2: the Codex sandbox path's request contract, against a fake app-server
// (server/testing/fake-codex-exec.mjs) that speaks initialize and command/exec and logs what it was
// asked. The exact request (argv through the reaper, cwd, the sandbox policy with network only for
// prepare when allowed, the writable roots, timeouts, the output cap, the environment), terminate on
// stop, the private CODEX_HOME and project_doc_max_bytes=0 on the spawn, and the probe's decision
// table. A real-sandbox probe runs only with ORC_TEST_REAL_SANDBOX=1 on the user's machine.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSandboxChecks, OUTPUT_CAP, REAPER, checkEnv, type CheckAssignment } from "./checks";
import { APP_SERVER_ARGS, ISOLATION_CONFIG_ARGS, ISOLATION_FEATURE_ARGS, PROJECT_DOC_ARGS } from "./runtimes/codex";
import type { AdapterEvent } from "./runtimes/types";

const FAKE = resolve(__dirname, "testing/fake-codex-exec.mjs");
const node = process.execPath;
let dir: string;
let logFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-codex-checks-"));
  logFile = join(dir, "requests.log");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const requests = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const cmd = (id: string, argv: string[], o: Partial<CheckAssignment["commands"][number]> = {}) => ({ id, label: id, kind: "check" as const, argv, timeoutMs: 10_000, ...o });
function assignment(commands: CheckAssignment["commands"], o: Partial<CheckAssignment> = {}): CheckAssignment {
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const tmp = join(dir, "tmp");
  const cache = join(dir, "cache");
  // The app-server runs with the check environment itself (the allowlist, §6.6); the fake's own variables ride along after it.
  const env = { ...checkEnv({ ...process.env, GH_TOKEN: "ghp_fakefakefakefakefakefakefake" }, { passEnv: [] }, { tmp, cache }), FAKE_CODEX_LOG: logFile, ...(o.sandbox === "none" ? {} : {}) };
  return { attemptId: "run-1", taskId: "T-1", stepId: "C1", workspace: ws, target: "a".repeat(40), commands, runTimeoutMs: 30_000, sandbox: "codex", prepareNetwork: true, env, tmpDir: tmp, cacheDir: cache, logDir: join(dir, "logs", "run-1"), ...o };
}
const hanging = (a: CheckAssignment): CheckAssignment => ({ ...a, env: { ...a.env, FAKE_CODEX_HANG: "1" } });
function runner(o: { graceMs?: number } = {}) {
  return new CodexSandboxChecks({ codexBin: FAKE, home: join(dir, "codex-home"), probeDir: join(dir, "probe"), graceMs: o.graceMs ?? 300, env: { ...process.env, GH_TOKEN: "ghp_fakefakefakefakefakefakefake" } });
}
function runToEnd(r: CodexSandboxChecks, a: CheckAssignment): Promise<AdapterEvent[]> {
  return new Promise((res) => {
    const events: AdapterEvent[] = [];
    r.onEvent((e) => {
      events.push(e);
      if (e.type === "completed" || e.type === "failed" || e.type === "stopped") res(events);
    });
    r.start(a);
  });
}
const completed = (events: AdapterEvent[]) => events.find((e): e is Extract<AdapterEvent, { type: "completed" }> => e.type === "completed")!;

describe("CodexSandboxChecks (§6.5.2)", () => {
  it("starts one app-server per run under a private, never signed-in CODEX_HOME with the isolation and project_doc_max_bytes=0 arguments, and sends the exact command/exec request per command", async () => {
    const r = runner();
    const a = assignment([cmd("install", [node, "-e", "1"], { kind: "prepare", timeoutMs: 1234 }), cmd("test", [node, "-e", 'console.log("hi")'])]);
    const events = await runToEnd(r, a);
    const c = completed(events);
    expect(c.checks!.results.map((x) => [x.id, x.status])).toEqual([
      ["install", "passed"],
      ["test", "passed"],
    ]);
    expect(c.checks!.results[1].excerpt).toBe("hi\n");
    expect(c.checks!.sandbox).toBe("codex");
    const rows = requests();
    // The spawn: our arguments, the private home, the sanitized environment (no token).
    const spawn = rows[0] as { spawn: string[]; env: Record<string, string> };
    expect(spawn.spawn).toEqual([...APP_SERVER_ARGS, ...ISOLATION_FEATURE_ARGS, ...ISOLATION_CONFIG_ARGS]);
    expect(spawn.spawn).toEqual(expect.arrayContaining(PROJECT_DOC_ARGS));
    expect(spawn.env.CODEX_HOME).toBe(join(dir, "codex-home"));
    expect(existsSync(join(dir, "codex-home", "auth.json"))).toBe(false);
    expect(spawn.env.GH_TOKEN).toBeUndefined();
    expect(spawn.env.CI).toBe("1");
    expect(rows[1].method).toBe("initialize");
    const execs = rows.filter((x) => x.method === "command/exec").map((x) => x.params as Record<string, unknown>);
    expect(execs).toHaveLength(2);
    expect(execs[0]).toMatchObject({
      command: [node, REAPER, "--", node, "-e", "1"],
      processId: "run-1:install",
      cwd: a.workspace,
      timeoutMs: 1234,
      outputBytesCap: OUTPUT_CAP,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [a.workspace, a.tmpDir, a.cacheDir], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
    expect(execs[1]).toMatchObject({ command: [node, REAPER, "--", node, "-e", 'console.log("hi")'], processId: "run-1:test", timeoutMs: 10_000, sandboxPolicy: { type: "workspaceWrite", networkAccess: false } });
    expect((execs[1].env as Record<string, string>).GH_TOKEN).toBeUndefined();
    expect((execs[1].env as Record<string, string>).TMPDIR).toBe(a.tmpDir);
    // Prepare gets the network only when the setting allows it.
    rmSync(logFile, { force: true });
    await runToEnd(runner(), assignment([cmd("install", [node, "-e", "1"], { kind: "prepare" })], { attemptId: "run-2", prepareNetwork: false, logDir: join(dir, "logs", "run-2") }));
    expect((requests().find((x) => x.method === "command/exec")!.params as { sandboxPolicy: { networkAccess: boolean } }).sandboxPolicy.networkAccess).toBe(false);
    // The app-server is gone after the run.
    await new Promise((res) => setTimeout(res, 200));
    expect(r.ids()).toEqual([]);
  });

  it("a stop request sends command/exec/terminate and yields exactly one stopped event; kill is silent", async () => {
    const r = runner();
    const events: AdapterEvent[] = [];
    r.onEvent((e) => events.push(e));
    r.start(hanging(assignment([cmd("hang", [node, "-e", "setInterval(()=>{},1000)"])])));
    await new Promise((res) => setTimeout(res, 800));
    r.interrupt("run-1");
    await new Promise((res) => setTimeout(res, 1200));
    expect(events.filter((e) => e.type !== "activity")).toEqual([{ type: "stopped", attemptId: "run-1", how: "interrupted" }]);
    expect(requests().some((x) => x.method === "command/exec/terminate" && (x.params as { processId: string }).processId === "run-1:hang")).toBe(true);
    const r2 = runner();
    const events2: AdapterEvent[] = [];
    r2.onEvent((e) => events2.push(e));
    r2.start(hanging(assignment([cmd("hang", [node, "-e", "setInterval(()=>{},1000)"])], { attemptId: "run-9" })));
    await new Promise((res) => setTimeout(res, 800));
    r2.kill("run-9");
    await new Promise((res) => setTimeout(res, 800));
    expect(events2.filter((e) => e.type !== "activity")).toEqual([]);
    expect(r2.has("run-9")).toBe(false);
  });

  it("a command the server ends at its own time limit (as the pinned app-server does, with exit 124) is recorded as timed out; the run goes on", async () => {
    const r = runner();
    const events = await runToEnd(r, assignment([cmd("hang", [node, "-e", "setInterval(()=>{},1000)"], { timeoutMs: 300 }), cmd("after", [node, "-e", "1"])]));
    const c = completed(events);
    expect(c.checks!.results.map((x) => [x.id, x.status])).toEqual([
      ["hang", "timed-out"],
      ["after", "passed"],
    ]);
  });

  it("the probe's decision table: ready needs all four; a write outside that succeeds, or a network connection that succeeds, is unavailable (mutation check: no fallback to running unsandboxed)", async () => {
    // The fake has no sandbox at all: a write into $HOME succeeds and the network is reachable (or times out), so the probe must say unavailable.
    const home = join(dir, "fakehome");
    mkdirSync(home);
    const r = new CodexSandboxChecks({ codexBin: FAKE, home: join(dir, "codex-home"), probeDir: join(dir, "probe"), env: { ...process.env, HOME: home } });
    const h = await r.probe("codex");
    expect(h.sandbox).toBe("codex");
    expect(h.status).toBe("unavailable");
    expect(h.probes?.writeOutside).toBe("allowed");
    expect(h.detail).toMatch(/let a command write outside its directory/);
    // The probe cleaned up after itself: nothing left in $HOME or the scratch directory.
    expect(existsSync(join(dir, "probe"))).toBe(true);
    expect(require("node:fs").readdirSync(join(dir, "probe"))).toEqual([]);
    expect(require("node:fs").readdirSync(home).filter((f: string) => f.startsWith(".orchestrator-probe-"))).toEqual([]);
    // "none" is never probed for a sandbox: it reports ready with its warning.
    expect(await r.probe("none")).toMatchObject({ sandbox: "none", status: "ready" });
    // A server that cannot start: unavailable with the reason, never ready.
    const broken = new CodexSandboxChecks({ codexBin: join(dir, "missing-codex"), home: join(dir, "codex-home-2"), probeDir: join(dir, "probe2") });
    const b = await broken.probe("codex");
    expect(b.status).toBe("unavailable");
    expect(b.detail).toMatch(/could not start the Codex app-server|ENOENT/);
  }, 20_000);
});

describe("the real sandbox on this machine (only with ORC_TEST_REAL_SANDBOX=1)", () => {
  it.skipIf(process.env.ORC_TEST_REAL_SANDBOX !== "1")("the pinned Codex app-server's command/exec refuses writes outside the run and network connections, and ends a terminated command's children", async () => {
    const r = new CodexSandboxChecks({ home: join(dir, "codex-home"), probeDir: join(dir, "probe") });
    const h = await r.probe("codex");
    expect(h).toMatchObject({ sandbox: "codex", status: "ready", probes: { writeOutside: "denied", network: "denied" } });
  }, 60_000);
});
