// The Codex sandbox path's request contract, against a fake app-server
// (server/testing/fake-codex-exec.mjs) that speaks initialize and command/exec and logs what it was
// asked. The exact request (argv through the reaper, cwd, the sandbox policy with network only for
// prepare when allowed, the writable roots, timeouts, the output cap, the environment), terminate on
// stop, the private CODEX_HOME and project_doc_max_bytes=0 on the spawn, and the probe's decision
// table. A real-sandbox probe runs only with ORC_TEST_REAL_SANDBOX=1 on the user's machine.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NETWORK_RULE } from "../src/domain/checks";
import { CodexSandboxChecks, NO_SCRIPTS_ENV, OUTPUT_CAP, REAPER, checkEnv, probeVerdict, type CheckAssignment } from "./checks";
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
  // The app-server runs with the check environment itself (the allowlist); the fake's own variables ride along after it.
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

describe("CodexSandboxChecks", () => {
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
    // A prepare command that is not an allowlisted download runs offline, and the record says so.
    expect(execs[0]).toMatchObject({
      command: [node, REAPER, "--", node, "-e", "1"],
      processId: "run-1:install",
      cwd: a.workspace,
      timeoutMs: 1234,
      outputBytesCap: OUTPUT_CAP,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [a.workspace, a.tmpDir, a.cacheDir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
    expect((events.find((e) => e.type === "activity" && /Running install/.test(e.note)) as { note: string }).note).toBe(`Running install (${node} -e 1) offline: ${NETWORK_RULE}.`);
    expect(c.checks!.results[0].excerpt).toBe(`[The network was refused for this command: ${NETWORK_RULE}.]\n`);
    expect(execs[1]).toMatchObject({ command: [node, REAPER, "--", node, "-e", 'console.log("hi")'], processId: "run-1:test", timeoutMs: 10_000, sandboxPolicy: { type: "workspaceWrite", networkAccess: false } });
    expect((execs[1].env as Record<string, string>).GH_TOKEN).toBeUndefined();
    expect((execs[1].env as Record<string, string>).TMPDIR).toBe(a.tmpDir);
    // An allowlisted download gets the network only when the setting allows it.
    const b = { attemptId: "x", workspace: a.workspace, env: a.env, tmpDir: a.tmpDir, cacheDir: a.cacheDir };
    const install = { id: "i", label: "i", kind: "prepare" as const, argv: ["npm", "ci", "--ignore-scripts"], timeoutMs: 1000 };
    expect((CodexSandboxChecks.execParams({ ...b, prepareNetwork: true }, install).sandboxPolicy as { networkAccess: boolean }).networkAccess).toBe(true);
    expect((CodexSandboxChecks.execParams({ ...b, prepareNetwork: false }, install).sandboxPolicy as { networkAccess: boolean }).networkAccess).toBe(false);
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

describe("a run meant for the project's environment that comes to this computer (B-05)", () => {
  // The last probe found the checks run in the environment, so it did not probe this computer's sandbox.
  const handed = () => assignment([cmd("test", [node, "-e", `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "ran"))}, "")`])], { hostUnverified: true, hostReason: "Docker is not running" });

  it("probes the sandbox first: one that is not ready runs no command, and the run says why", async () => {
    // The fake app-server has no sandbox at all, so its probe fails.
    const home = join(dir, "fakehome");
    mkdirSync(home);
    const r = new CodexSandboxChecks({ codexBin: FAKE, home: join(dir, "codex-home"), probeDir: join(dir, "probe"), env: { ...process.env, HOME: home } });
    const events = await runToEnd(r, handed());
    expect(events.at(-1)).toMatchObject({ type: "failed", message: expect.stringMatching(/^The checks cannot run: the project's environment did not take them \(Docker is not running\), and this computer's sandbox is not ready: The sandbox let a command write outside its directory/) });
    expect(existsSync(join(dir, "ran"))).toBe(false);
  }, 20_000);

  it("runs once the probe passes", async () => {
    const r = runner();
    r.probe = async (sandbox) => ({ sandbox, status: "ready", detail: "verified", checkedAt: new Date().toISOString() });
    const events = await runToEnd(r, handed());
    expect(completed(events).checks!.results.map((x) => [x.id, x.status])).toEqual([["test", "passed"]]);
    expect(existsSync(join(dir, "ran"))).toBe(true);
  });
});

describe("the real sandbox on this machine (only with ORC_TEST_REAL_SANDBOX=1)", () => {
  it.skipIf(process.env.ORC_TEST_REAL_SANDBOX !== "1")("the pinned Codex app-server's command/exec refuses writes outside the run and network connections, and ends a terminated command's children", async () => {
    const r = new CodexSandboxChecks({ home: join(dir, "codex-home"), probeDir: join(dir, "probe") });
    const h = await r.probe("codex");
    expect(h).toMatchObject({ sandbox: "codex", status: "ready", probes: { writeOutside: "denied", network: "denied" } });
  }, 60_000);
});

describe("running checks safely in the sandbox path: installs, forged results and probes", () => {
  const base = () => {
    const a = assignment([]);
    return { attemptId: a.attemptId, workspace: a.workspace, prepareNetwork: true, env: a.env, tmpDir: a.tmpDir, cacheDir: a.cacheDir };
  };
  const planned = (argv: string[], kind: "prepare" | "check" = "prepare", extra: object = {}) => ({ id: "c", label: "c", kind, argv, timeoutMs: 1000, ...extra });

  it("an install that may use the network is run with --ignore-scripts and the no-scripts environment; a rebuild step never gets the network; a check never does (mutation check)", async () => {
    const b = base();
    const npm = CodexSandboxChecks.execParams(b, planned(["npm", "ci"]));
    expect(npm.command.slice(-3)).toEqual(["npm", "ci", "--ignore-scripts"]);
    expect(npm.env).toMatchObject(NO_SCRIPTS_ENV);
    expect(NO_SCRIPTS_ENV.YARN_IGNORE_PATH).toBe("1");
    expect((npm.sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(true);
    // Already flagged: not doubled; pnpm gets --ignore-pnpmfile too; Yarn Berry's own flag is recognised; contradictions are dropped.
    const pnpm = CodexSandboxChecks.execParams(b, planned(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]));
    expect(pnpm.command.filter((x) => x === "--ignore-scripts")).toHaveLength(1);
    expect(pnpm.command.slice(-5)).toEqual(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]);
    expect(CodexSandboxChecks.execParams(b, planned(["yarn", "install", "--immutable", "--mode=skip-build"])).command).not.toContain("--ignore-scripts");
    const contradicted = CodexSandboxChecks.execParams(b, planned(["npm", "ci", "--ignore-scripts", "--no-ignore-scripts", "--ignore-scripts=false"]));
    expect(contradicted.command.slice(-3)).toEqual(["npm", "ci", "--ignore-scripts"]);
    expect((contradicted.sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(true);
    // Not on the allowlist: bun, and every other setup command, run offline whatever the settings say (mutation check: the allowlist).
    for (const argv of [["bun", "install", "--frozen-lockfile", "--ignore-scripts"], ["make", "deps"], ["bundle", "install"], ["python3", "-m", "pip", "install", "-e", "."], ["uv", "sync"], ["cargo", "fetch"]]) {
      const p = CodexSandboxChecks.execParams(b, planned(argv));
      expect((p.sandboxPolicy as { networkAccess?: boolean }).networkAccess, argv.join(" ")).toBe(false);
      expect(p.command.slice(-argv.length), argv.join(" ")).toEqual(argv);
      expect((p.env as Record<string, string>).npm_config_ignore_scripts, argv.join(" ")).toBeUndefined();
    }
    // A yarn whose own configuration runs repository JavaScript is refused the network, read from the copy the install runs in.
    const ws2 = join(dir, "ws-yarn");
    mkdirSync(ws2, { recursive: true });
    writeFileSync(join(ws2, ".yarnrc.yml"), "yarnPath: .yarn/releases/yarn-4.0.0.cjs\nnodeLinker: node-modules\n");
    const yarnrc = CodexSandboxChecks.execParams({ ...b, workspace: ws2 }, planned(["yarn", "install", "--immutable", "--mode=skip-build"]));
    expect((yarnrc.sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
    writeFileSync(join(ws2, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    expect((CodexSandboxChecks.execParams({ ...b, workspace: ws2 }, planned(["yarn", "install", "--immutable", "--mode=skip-build"])).sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(true);
    writeFileSync(join(ws2, ".yarnrc"), 'yarn-path "./.yarn/releases/yarn-1.22.19.cjs"\n');
    expect((CodexSandboxChecks.execParams({ ...b, workspace: ws2 }, planned(["yarn", "install", "--ignore-scripts"])).sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
    // The offline way to run install scripts: no network, no flag, no no-scripts environment.
    const rebuild = CodexSandboxChecks.execParams(b, planned(["npm", "rebuild"]));
    expect((rebuild.sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
    expect(rebuild.command).not.toContain("--ignore-scripts");
    expect((rebuild.env as Record<string, string>).npm_config_ignore_scripts).toBeUndefined();
    expect((CodexSandboxChecks.execParams(b, planned(["node", "scripts/setup.js"], "prepare", { offline: true })).sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
    // With the network off for prepare, nothing is added and nothing gets the network.
    const off = CodexSandboxChecks.execParams({ ...b, prepareNetwork: false }, planned(["npm", "ci"]));
    expect((off.sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
    expect(off.command.slice(-2)).toEqual(["npm", "ci"]);
    // A check command never gets the network, whatever the settings say.
    expect((CodexSandboxChecks.execParams(b, planned(["npm", "test"], "check")).sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
    // Through the fake app-server: a prepare command that is not an allowlisted download runs offline, without the no-scripts environment, and its record says why.
    const ev = await runToEnd(runner(), assignment([cmd("setup", [node, "-e", 'console.log("ran")'], { kind: "prepare" }), cmd("test", [node, "-e", "1"])]));
    const execs = requests().filter((x) => x.method === "command/exec").map((x) => x.params as { env: Record<string, string>; sandboxPolicy: { networkAccess: boolean } });
    expect(execs[0].env.npm_config_ignore_scripts).toBeUndefined();
    expect((execs[0].sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
    expect(completed(ev).checks!.results[0]).toMatchObject({ status: "passed", excerpt: `[The network was refused for this command: ${NETWORK_RULE}.]\nran\n` });
    expect(execs[1].env.npm_config_ignore_scripts).toBeUndefined();
    expect((execs[1].sandboxPolicy as { networkAccess?: boolean }).networkAccess).toBe(false);
  });

  it("a command that forges a status file, prints '3 failing' and kills the reaper or its leader is recorded as failed (mutation check: the reaper's own exit status)", async () => {
    const forge = (who: "leader" | "reaper") => {
      const p = join(dir, `forge-${who}.js`);
      writeFileSync(
        p,
        `const fs = require("node:fs"); const { execFileSync } = require("node:child_process");
         fs.writeFileSync(require("node:path").join(process.env.TMPDIR, "k.status"), JSON.stringify({ code: 0 }));
         fs.writeSync(1, "3 failing\\n");
         const leader = process.ppid;
         const target = ${who === "leader" ? "leader" : 'Number(execFileSync("ps", ["-o", "ppid=", "-p", String(leader)], { encoding: "utf8" }).trim())'};
         setTimeout(() => { process.kill(target, "SIGKILL"); setInterval(() => {}, 1000); }, 150);`,
      );
      return p;
    };
    for (const who of ["leader", "reaper"] as const) {
      const a = assignment([cmd("k", [node, forge(who)])], { attemptId: `run-${who}`, logDir: join(dir, "logs", `run-${who}`) });
      mkdirSync(a.tmpDir, { recursive: true });
      const r = completed(await runToEnd(runner(), a)).checks!.results[0];
      expect(r.status, who).toBe("failed");
      expect(r.exitCode, who).not.toBe(0);
      expect(r.excerpt, who).toContain("3 failing");
      expect(r.excerpt, who).toMatch(/the check process was killed/i);
    }
  }, 20_000);

  it("the probe requires this machine's own loopback to be refused; a sandbox that lets a command reach it is unavailable (mutation check: no fallback)", async () => {
    // The fake has no sandbox. A read-only $HOME makes the write-outside probe an honest EACCES refusal, so the probe reaches the loopback step,
    // where the fake connects: not ready, and it says why.
    const home = join(dir, "rohome");
    mkdirSync(home, { mode: 0o500 });
    const r = new CodexSandboxChecks({ codexBin: FAKE, home: join(dir, "codex-home"), probeDir: join(dir, "probe"), env: { ...process.env, HOME: home } });
    const h = await r.probe("codex");
    expect(h.probes).toMatchObject({ writeOutside: "denied", loopback: "allowed" });
    expect(h.status).toBe("unavailable");
    expect(h.detail).toMatch(/does not block your own machine: a command reached this computer's loopback address/);
    expect(Date.parse(h.checkedAt)).toBeLessThanOrEqual(Date.now());
    expect(require("node:fs").readdirSync(join(dir, "probe"))).toEqual([]);
  }, 20_000);

  it("only an explicit refusal (EPERM or EACCES) is a denial; an unreachable network, a refused connection, a timeout or a killed command proves nothing", () => {
    expect(probeVerdict("DENIED EPERM\n", 3, "CONNECTED")).toBe("denied");
    expect(probeVerdict("DENIED EACCES\n", 3, "WROTE")).toBe("denied");
    expect(probeVerdict("DENIED ENETUNREACH\n", 3, "CONNECTED")).toBe("unknown");
    expect(probeVerdict("DENIED EHOSTUNREACH\n", 3, "CONNECTED")).toBe("unknown");
    expect(probeVerdict("DENIED ECONNREFUSED\n", 3, "CONNECTED")).toBe("unknown");
    expect(probeVerdict("DENIED ENOENT\n", 3, "WROTE")).toBe("unknown");
    expect(probeVerdict("TIMEOUT\n", 4, "CONNECTED")).toBe("unknown");
    expect(probeVerdict("", undefined, "CONNECTED")).toBe("unknown");
    expect(probeVerdict("DENIED EPERM\n", 137, "CONNECTED")).toBe("unknown");
    expect(probeVerdict("CONNECTED\n", 0, "CONNECTED")).toBe("allowed");
  });
});
