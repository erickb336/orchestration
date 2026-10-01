// ORC-013 step 2: the check runner with real child processes (DirectChecks, the "no sandbox" path, and
// everything the sandboxed path shares with it): pass, fail, timeout with a grandchild that must be gone,
// a failed prepare, capped and redacted output, the log file, the stop semantics, and the environment a
// command sees. No sandbox, no model, no network; every command is this Node running a small script.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_ENV_COPIED, DirectChecks, EXCERPT_HEAD, EXCERPT_TAIL, OUTPUT_CAP, checkEnv, excerptOf, headOf, pruneCheckLogs, type CheckAssignment, type CheckRunner } from "./checks";
import { killGroup } from "./processes";
import type { AdapterEvent } from "./runtimes/types";

let dir: string;
const node = process.execPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-checks-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A script file the command runs (the allowlist is the domain's concern; the runner runs what it is given). */
function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}
const cmd = (id: string, argv: string[], o: Partial<CheckAssignment["commands"][number]> = {}) => ({ id, label: id, kind: "check" as const, argv, timeoutMs: 10_000, ...o });
function assignment(commands: CheckAssignment["commands"], o: Partial<CheckAssignment> = {}): CheckAssignment {
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  return { attemptId: "run-1", taskId: "T-1", stepId: "C1", workspace: ws, target: "a".repeat(40), commands, runTimeoutMs: 30_000, sandbox: "none", prepareNetwork: false, env: checkEnv(process.env, { passEnv: [] }, { tmp: join(dir, "tmp"), cache: join(dir, "cache") }), tmpDir: join(dir, "tmp"), cacheDir: join(dir, "cache"), logDir: join(dir, "logs", "run-1"), ...o };
}
/** Start a run and wait for its terminal event, collecting every event. */
function runToEnd(runner: CheckRunner, a: CheckAssignment, during?: (events: AdapterEvent[]) => void): Promise<AdapterEvent[]> {
  return new Promise((resolve) => {
    const events: AdapterEvent[] = [];
    runner.onEvent((e) => {
      events.push(e);
      if (e.type === "completed" || e.type === "failed" || e.type === "stopped") resolve(events);
      else during?.(events);
    });
    runner.start(a);
  });
}
const completed = (events: AdapterEvent[]) => events.find((e): e is Extract<AdapterEvent, { type: "completed" }> => e.type === "completed")!;

describe("DirectChecks (§6.5.3, and what §6.5.2 shares)", () => {
  it("runs the commands in order through the reaper, records exit codes, durations and output, and writes one 0600 log per command", async () => {
    const pass = script("pass.js", 'console.log("all good"); console.error("warned");');
    const fail = script("fail.js", 'console.log("1 failing"); process.exit(3);');
    const runner = new DirectChecks();
    const events = await runToEnd(runner, assignment([cmd("ok", [node, pass]), cmd("bad", [node, fail]), cmd("after", [node, pass])]));
    const c = completed(events);
    expect(c.checks).toMatchObject({ sha: "a".repeat(40), sandbox: "none" });
    expect(c.checks!.results.map((r) => [r.id, r.status, r.exitCode])).toEqual([
      ["ok", "passed", 0],
      ["bad", "failed", 3],
      ["after", "passed", 0],
    ]);
    expect(c.checks!.results[0].excerpt).toBe("all good\n--- stderr ---\nwarned\n");
    expect(c.checks!.results[0]).toMatchObject({ bytes: 16, truncated: false, log: "run-1/ok" });
    expect(c.checks!.results[1].excerpt).toBe("1 failing\n");
    expect(c.checks!.results.every((r) => r.durationMs >= 0)).toBe(true);
    expect(events.filter((e) => e.type === "activity").map((e) => (e as { note: string }).note)).toEqual([`Running ok (${node} ${pass})`, `Running bad (${node} ${fail})`, `Running after (${node} ${pass})`]);
    const log = join(dir, "logs", "run-1", "ok.log");
    expect(readFileSync(log, "utf8")).toBe("all good\n--- stderr ---\nwarned\n");
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "logs", "run-1")).mode & 0o777).toBe(0o700);
    expect(runner.has("run-1")).toBe(false);
    expect(runner.simulated).toBe(false);
  });

  it("a failed prepare leaves the checks not-run; a timed-out command is ended with its whole process group, and its grandchild is gone (mutation check: the group kill)", async () => {
    const install = script("install.js", 'console.error("npm ERR! 404"); process.exit(1);');
    const runner = new DirectChecks({ graceMs: 500 });
    const a1 = await runToEnd(runner, assignment([cmd("install", [node, install], { kind: "prepare" }), cmd("test", [node, install])]));
    expect(completed(a1).checks!.results.map((r) => [r.id, r.status])).toEqual([
      ["install", "failed"],
      ["test", "not-run"],
    ]);
    // A command that starts a grandchild and hangs: the runner ends the group at the time limit.
    const pidFile = join(dir, "grandchild.pid");
    const hang = script("hang.js", `const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`);
    const t0 = Date.now();
    const a2 = await runToEnd(new DirectChecks({ graceMs: 300 }), assignment([cmd("hang", [node, hang], { timeoutMs: 1500 }), cmd("next", [node, install])], { attemptId: "run-2", logDir: join(dir, "logs", "run-2") }));
    const r = completed(a2).checks!.results;
    expect(r[0]).toMatchObject({ id: "hang", status: "timed-out" });
    expect(r[0].durationMs).toBeGreaterThanOrEqual(1400);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r[1].status).toBe("failed"); // the next command still ran: a timeout is one result, not the end of the run
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 400));
    expect(() => process.kill(pid, 0)).toThrow(); // the grandchild died with the group
  });

  it("the whole run's time limit fails the run with the 'time limit' wording (never retried automatically), and ends the command", async () => {
    const hang = script("hang2.js", "setInterval(() => {}, 1000);");
    const events = await runToEnd(new DirectChecks({ graceMs: 200 }), assignment([cmd("hang", [node, hang], { timeoutMs: 60_000 })], { runTimeoutMs: 800 }));
    expect(events.at(-1)).toMatchObject({ type: "failed", message: "Checks reached their 0-minute time limit." });
    expect(events.filter((e) => e.type === "failed" || e.type === "completed" || e.type === "stopped")).toHaveLength(1);
  });

  it("output is capped at 1 MiB per stream in the log, excerpted to 2 KB + 6 KB in the state, and redacted (a fake token, a PEM key and a secret-named value from the service's environment)", async () => {
    const big = script("big.js", `const line = "x".repeat(99) + "\\n"; for (let i = 0; i < 12000; i++) process.stdout.write(line); process.stdout.write("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end\\n-----BEGIN RSA PRIVATE KEY-----\\nMIIEow\\n-----END RSA PRIVATE KEY-----\\nhunter2hunter2 tail\\n");`);
    const runner = new DirectChecks({ env: { ...process.env, MY_SECRET_THING: "hunter2hunter2" } });
    const events = await runToEnd(runner, assignment([cmd("big", [node, big])]));
    const r = completed(events).checks!.results[0];
    expect(r.status).toBe("passed");
    expect(r.bytes).toBeGreaterThan(OUTPUT_CAP); // what the command produced, cap included
    expect(r.truncated).toBe(true);
    expect(r.excerpt.length).toBeLessThan(EXCERPT_HEAD + EXCERPT_TAIL + 100);
    expect(r.excerpt).toContain("[… ");
    const log = readFileSync(join(dir, "logs", "run-1", "big.log"), "utf8");
    expect(log.length).toBeLessThanOrEqual(OUTPUT_CAP);
    // The first MiB of stdout is what is kept, so the secrets printed at the end are cut with the cap; a short run shows the redaction itself.
    const small = script("small.js", `process.stdout.write("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end\\n-----BEGIN RSA PRIVATE KEY-----\\nMIIEow\\n-----END RSA PRIVATE KEY-----\\nhunter2hunter2 tail\\n");`);
    const e2 = await runToEnd(runner, assignment([cmd("small", [node, small])], { attemptId: "run-3", logDir: join(dir, "logs", "run-3") }));
    const r2 = completed(e2).checks!.results[0];
    expect(r2.excerpt).toBe("token *** end\n***\n*** tail\n");
    expect(readFileSync(join(dir, "logs", "run-3", "small.log"), "utf8")).toBe("token *** end\n***\n*** tail\n");
    expect(excerptOf("a".repeat(EXCERPT_HEAD + EXCERPT_TAIL))).toHaveLength(EXCERPT_HEAD + EXCERPT_TAIL);
    expect(excerptOf("a".repeat(EXCERPT_HEAD) + "M" + "b".repeat(EXCERPT_TAIL))).toBe(`${"a".repeat(EXCERPT_HEAD)}\n[… 1 bytes …]\n${"b".repeat(EXCERPT_TAIL)}`);
  });

  it("interrupt gives exactly one stopped event and ends the command; kill gives no event at all; start is idempotent", async () => {
    const hang = script("hang3.js", "setInterval(() => {}, 1000);");
    const runner = new DirectChecks({ graceMs: 200 });
    const events: AdapterEvent[] = [];
    runner.onEvent((e) => events.push(e));
    const a = assignment([cmd("hang", [node, hang])]);
    runner.start(a);
    runner.start(a);
    expect(runner.ids()).toEqual(["run-1"]);
    await new Promise((res) => setTimeout(res, 300));
    runner.interrupt("run-1");
    runner.interrupt("run-1");
    await new Promise((res) => setTimeout(res, 1500));
    expect(events.filter((e) => e.type === "stopped")).toEqual([{ type: "stopped", attemptId: "run-1", how: "interrupted" }]);
    expect(events.some((e) => e.type === "completed" || e.type === "failed")).toBe(false);
    expect(runner.has("run-1")).toBe(false);
    // kill: forgotten at once, silently.
    const events2: AdapterEvent[] = [];
    const r2 = new DirectChecks({ graceMs: 200 });
    r2.onEvent((e) => events2.push(e));
    r2.start(assignment([cmd("hang", [node, hang])], { attemptId: "run-9" }));
    await new Promise((res) => setTimeout(res, 300));
    r2.kill("run-9");
    expect(r2.has("run-9")).toBe(false);
    await new Promise((res) => setTimeout(res, 800));
    expect(events2.filter((e) => e.type !== "activity")).toEqual([]);
    await r2.shutdown();
  });

  it("the command environment is the allowlist plus what the service sets: no tokens, no SSH agent, no NODE_OPTIONS, CI=1 and the private TMPDIR (mutation check: the allowlist)", async () => {
    const dump = script("env.js", "console.log(JSON.stringify(process.env));");
    const base = { ...process.env, GH_TOKEN: "ghp_fakefakefakefakefakefakefake", GITHUB_TOKEN: "x", ANTHROPIC_API_KEY: "sk-ant-fake", OPENAI_API_KEY: "sk-fake", CLAUDE_CODE_OAUTH_TOKEN: "t", SSH_AUTH_SOCK: "/tmp/fake.sock", NODE_OPTIONS: "--max-old-space-size=1", AWS_SECRET_ACCESS_KEY: "aws", ORCHESTRATION_DB: "/x", GIT_DIR: "/y", npm_config_registry: "http://evil", DYLD_INSERT_LIBRARIES: "/z", LD_PRELOAD: "/w", MY_TOOL_HOME: "/tool", HOME: process.env.HOME ?? "/home/x" };
    const env = checkEnv(base, { passEnv: ["MY_TOOL_HOME", "GH_TOKEN", "NODE_OPTIONS"] }, { tmp: join(dir, "tmp"), cache: join(dir, "cache") });
    const events = await runToEnd(new DirectChecks({ env: base }), assignment([cmd("env", [node, dump])], { env }));
    const seen = JSON.parse(completed(events).checks!.results[0].excerpt) as Record<string, string>;
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "AWS_SECRET_ACCESS_KEY", "ORCHESTRATION_DB", "GIT_DIR", "npm_config_registry", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]) expect(seen[k], k).toBeUndefined();
    expect(seen).toMatchObject({ CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", TMPDIR: join(dir, "tmp"), XDG_CACHE_HOME: join(dir, "cache"), npm_config_cache: join(dir, "cache", "npm"), npm_config_update_notifier: "false", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", MY_TOOL_HOME: "/tool", HOME: base.HOME, PATH: process.env.PATH });
    for (const k of Object.keys(seen)) expect(CHECK_ENV_COPIED.includes(k) || ["CI", "NO_COLOR", "FORCE_COLOR", "TERM", "TMPDIR", "XDG_CACHE_HOME", "npm_config_cache", "npm_config_update_notifier", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "MY_TOOL_HOME", "__CF_USER_TEXT_ENCODING"].includes(k), k).toBe(true);
  });

  it("a worktree that is not at the target is refused before anything runs; a plain directory is trusted to the scheduler's check", async () => {
    const ws = join(dir, "repo");
    mkdirSync(ws);
    const git = (...args: string[]) => spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(ws, "a.txt"), "a");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    const head = git("rev-parse", "HEAD").stdout.trim();
    expect(headOf(ws)).toBe(head);
    const wt = join(dir, "wt");
    git("worktree", "add", "-q", "--detach", wt, head);
    expect(headOf(wt)).toBe(head);
    expect(headOf(join(dir, "nowhere"))).toBeUndefined();
    const marker = join(dir, "ran.txt");
    const touch = script("touch.js", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    const runner = new DirectChecks();
    const events = await runToEnd(runner, assignment([cmd("touch", [node, touch])], { workspace: wt, target: "b".repeat(40) }));
    expect(events.at(-1)).toMatchObject({ type: "failed", message: `the workspace is not at ${"b".repeat(12)} (it is at ${head.slice(0, 12)}); nothing was run` });
    expect(existsSync(marker)).toBe(false);
    const ok = await runToEnd(runner, assignment([cmd("touch", [node, touch])], { attemptId: "run-2", workspace: wt, target: head, logDir: join(dir, "logs", "run-2") }));
    expect(completed(ok).checks!.results[0].status).toBe("passed");
    expect(existsSync(marker)).toBe(true);
    // No sandbox: the probe says so and reports ready.
    expect(await runner.probe("none")).toMatchObject({ sandbox: "none", status: "ready", detail: expect.stringMatching(/No sandbox: checks run with your permissions/) });
    expect((await runner.probe("codex")).status).toBe("unavailable");
  });

  it("arguments reach the program exactly as given: no shell ever expands, splits or interprets them (mutation check: no shell)", async () => {
    const echo = script("args.js", "console.log(JSON.stringify(process.argv.slice(2)));");
    const events = await runToEnd(new DirectChecks(), assignment([cmd("args", [node, echo, "$HOME", "a b", "*", "x;echo y", "`id`", "$(id)"])]));
    expect(JSON.parse(completed(events).checks!.results[0].excerpt)).toEqual(["$HOME", "a b", "*", "x;echo y", "`id`", "$(id)"]);
  });

  it("prunes logs older than 14 days, then the oldest until the total is under the size cap", () => {
    const root = join(dir, "check-logs");
    const mk = (project: string, run: string, ageDays: number, bytes = 10) => {
      const d = join(root, project, run);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "test.log"), "x".repeat(bytes));
      const t = new Date(Date.now() - ageDays * 24 * 60 * 60_000);
      const { utimesSync } = require("node:fs") as typeof import("node:fs");
      utimesSync(join(d, "test.log"), t, t);
      utimesSync(d, t, t);
    };
    mk("p", "run-old", 20);
    mk("p", "run-new", 1);
    mk("q", "run-mid", 5);
    expect(pruneCheckLogs(root)).toBe(1);
    expect(existsSync(join(root, "p", "run-old"))).toBe(false);
    expect(existsSync(join(root, "p", "run-new"))).toBe(true);
    expect(existsSync(join(root, "q", "run-mid"))).toBe(true);
    expect(pruneCheckLogs(join(dir, "missing"))).toBe(0);
  });
});

describe("security review of step 2 (M3): nothing a command started outlives the run", () => {
  it("a command that exits but leaves a child that traps SIGTERM: the reaper ends its group before it exits, and the command's own exit code is kept (mutation check: the reaper's final SIGKILL)", async () => {
    const pidA = join(dir, "trap-a.pid");
    const pidB = join(dir, "trap-b.pid");
    // The grandchild writes its pid only once its SIGTERM handler is installed, and the command waits for that before it exits.
    // A: the leftover does not hold the output pipe (stdio ignored). B: it does (inherited), so "close" waits for it.
    const trap = script("trap.js", 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');
    const leaver = (pidFile: string, stdio: string) =>
      script(
        `leaver-${stdio}.js`,
        `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const c = spawn(process.execPath, [${JSON.stringify(trap)}, ${JSON.stringify(pidFile)}], { stdio: ${JSON.stringify(stdio)} }); c.unref(); const t0 = Date.now(); while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); console.log("done"); process.exit(0);`,
      );
    const t0 = Date.now();
    const events = await runToEnd(new DirectChecks({ graceMs: 300 }), assignment([cmd("a", [node, leaver(pidA, "ignore")]), cmd("b", [node, leaver(pidB, "inherit")])]));
    const [a, b] = completed(events).checks!.results;
    expect(a).toMatchObject({ id: "a", status: "passed", exitCode: 0 });
    expect(b).toMatchObject({ id: "b", status: "passed", exitCode: 0 });
    expect(a.excerpt).toContain("done");
    expect(Date.now() - t0).toBeLessThan(9000);
    await new Promise((res) => setTimeout(res, 300));
    for (const f of [pidA, pidB]) {
      const pid = Number(readFileSync(f, "utf8"));
      expect(() => process.kill(pid, 0), f).toThrow(); // gone, although it ignored SIGTERM
    }
    // A command ended by a signal is still recorded as such (no status file says otherwise).
    const killed = script("selfkill.js", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);");
    const r = completed(await runToEnd(new DirectChecks({ graceMs: 300 }), assignment([cmd("k", [node, killed])], { attemptId: "run-k", logDir: join(dir, "logs", "run-k") }))).checks!.results[0];
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(143);
  }, 20_000);

  it("review L10: killGroup signals nothing once the leader has exited (its pid, and so the group id, may be reused); leftovers are the reaper's business", async () => {
    const pidFile = join(dir, "orphan.pid");
    const leader = spawn(node, ["-e", `const c = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(process.argv[1], String(c.pid)); c.unref();`, pidFile], { detached: true, stdio: "ignore" });
    await new Promise((r) => leader.once("exit", r));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow(); // it outlived its leader
    killGroup(leader, "SIGTERM");
    killGroup(leader, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).not.toThrow(); // untouched: the group id is no longer known to be the leader's
    process.kill(pid, "SIGKILL");
    // A live leader's group is still signalled.
    const live = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    killGroup(live, "SIGKILL");
    await new Promise((r) => live.once("exit", r));
    expect(live.signalCode).toBe("SIGKILL");
  });
});

describe("review finding M5: the exit status comes from the reaper alone, never from anything the command can write", () => {
  /**
   * The command forges a status file where the old reaper wrote it, prints a test-runner-looking line,
   * and then kills either the group leader (its parent) or the reaper itself (its grandparent).
   */
  const forge = (who: "leader" | "reaper") =>
    script(
      `forge-${who}.js`,
      `const fs = require("node:fs"); const { execFileSync } = require("node:child_process");
       fs.writeFileSync(require("node:path").join(process.env.TMPDIR, "k.status"), JSON.stringify({ code: 0 }));
       fs.writeSync(1, "3 failing\\n");
       const leader = process.ppid;
       const target = ${who === "leader" ? "leader" : 'Number(execFileSync("ps", ["-o", "ppid=", "-p", String(leader)], { encoding: "utf8" }).trim())'};
       setTimeout(() => { process.kill(target, "SIGKILL"); setInterval(() => {}, 1000); }, 150);`,
    );

  it("a command that writes a fake status, prints '3 failing' and kills the reaper is recorded as failed (mutation check: the reaper's own exit status)", async () => {
    mkdirSync(join(dir, "tmp"), { recursive: true });
    for (const who of ["leader", "reaper"] as const) {
      const events = await runToEnd(new DirectChecks({ graceMs: 300 }), assignment([cmd("k", [node, forge(who)])], { attemptId: `run-${who}`, logDir: join(dir, "logs", `run-${who}`) }));
      const r = completed(events).checks!.results[0];
      expect(r.status, who).toBe("failed");
      expect(r.exitCode, who).not.toBe(0);
      expect(r.excerpt, who).toContain("3 failing");
      expect(r.excerpt, who).toMatch(/the check process was killed/i);
      expect(existsSync(join(dir, "tmp", "k.status")), who).toBe(true); // the forged file is simply never read
    }
  }, 20_000);

  it("a command ended by a signal reports 128 plus the signal; the reaper's exit is the command's own code otherwise", async () => {
    const killed = script("selfkill2.js", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);");
    const events = await runToEnd(new DirectChecks({ graceMs: 300 }), assignment([cmd("k", [node, killed]), cmd("seven", [node, "-e", "process.exit(7)"])]));
    const [k, seven] = completed(events).checks!.results;
    expect(k).toMatchObject({ status: "failed", exitCode: 143 });
    expect(seven).toMatchObject({ status: "failed", exitCode: 7 });
    expect(k.excerpt).not.toMatch(/check process was killed/);
  });
});
