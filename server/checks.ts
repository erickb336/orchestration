// ORC-013 §6.5: the check runners. A check run is an attempt like an agent's (the scheduler dispatches
// it, stops it, reconciles it and applies its report), but the service runs it itself: every command
// is an argv vector from the user's settings, started through the reaper (server/check-reaper.mjs),
// never through a shell.
//
//   CodexSandboxChecks  the default: each command runs through the pinned Codex app-server's
//                       `command/exec` in a workspaceWrite sandbox (no network outside prepare, writes
//                       only in the run's worktree, its temp and its cache), under a private CODEX_HOME.
//   DirectChecks        only when the user chose "no sandbox": the same reaper, spawned by the service.
//   SimulatedChecks     the fake runtime: nothing is spawned; the record says so.
//   CheckRunners        the facade the scheduler talks to; it routes each run by its sandbox.
//
// Output is redacted and capped (an excerpt in the state, the full log in a file), the command
// environment is built from an allowlist (§6.6), and every run ends with exactly one terminal event.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server as NetServer } from "node:net";
import { blockedEnvName, hardenedInstall, isRebuild, networkRefusal, yarnrcRefusal } from "../src/domain/checks";
import type { CheckResult, ChecksConfig, ChecksHealth } from "../src/domain/types";
import { killGroup, trackLive } from "./processes";
import { SECRET_NAME, redact } from "./redact";
import type { CommandExecParams } from "./runtimes/codex-protocol/v2/CommandExecParams";
import type { CommandExecResponse } from "./runtimes/codex-protocol/v2/CommandExecResponse";
import type { SandboxPolicy } from "./runtimes/codex-protocol/v2/SandboxPolicy";
import { APP_SERVER_ARGS, ISOLATION_CONFIG_ARGS, ISOLATION_FEATURE_ARGS, defaultCodexPath } from "./runtimes/codex";
import { JsonRpcConnection, RpcClosedError } from "./runtimes/codexRpc";
import type { AdapterEvent, CheckRunReport } from "./runtimes/types";

export type { CheckRunReport };

// ---------- the contract (§6.5.1) ----------

interface PlannedCheck {
  id: string;
  label: string;
  kind: "prepare" | "check";
  argv: string[];
  timeoutMs: number;
  /** A prepare command that never gets the network: a rebuild step, or a download that is not on the allowlist (H1). */
  offline?: true;
  /** Why the network was refused to this prepare command, when the settings would have allowed it. */
  offlineReason?: string;
  /** Variables set for this one command on top of the run's environment (the "no scripts" settings). */
  env?: Record<string, string>;
}

/**
 * H1: repository code never runs while the network is on. The network goes only to npm, pnpm and yarn
 * installs with every hook that runs repository code switched off (the flags, re-added here whatever
 * the settings say, and this environment); a rebuild command (the offline way to run install scripts)
 * and every other prepare command run offline. The result is what the runner starts.
 */
export const NO_SCRIPTS_ENV: Record<string, string> = {
  // npm and pnpm read npm_config_*; Yarn Berry reads YARN_ENABLE_SCRIPTS (documented); Yarn classic reads YARN_IGNORE_SCRIPTS (best effort).
  npm_config_ignore_scripts: "true",
  YARN_ENABLE_SCRIPTS: "0",
  YARN_IGNORE_SCRIPTS: "true",
  // Both yarns: never run the repository's own copy of yarn (.yarnrc.yml yarnPath, .yarnrc yarn-path).
  YARN_IGNORE_PATH: "1",
};
/** Yarn's own configuration files in the copy the install runs in, as `yarnrcRefusal` reads them. */
type YarnRc = { yarnrcYml?: string; yarnrc?: string };
function hardenCommand(c: PlannedCheck, a: Pick<CheckAssignment, "prepareNetwork">, rc: YarnRc = {}): PlannedCheck {
  if (c.kind !== "prepare") return c;
  if (c.offline || isRebuild(c.argv)) return { ...c, offline: true };
  if (!a.prepareNetwork) return c;
  // An allowlisted install gets its flags re-added and contradictions dropped whatever the settings say;
  // anything else (bun, every other program, a yarn whose own configuration runs repository code) runs offline.
  const argv = hardenedInstall(c.argv);
  const why = networkRefusal(argv) ?? (argv[0] === "yarn" ? yarnrcRefusal(rc) : undefined);
  if (why) return { ...c, argv, offline: true, offlineReason: why };
  return { ...c, argv, env: { ...(c.env ?? {}), ...NO_SCRIPTS_ENV } };
}
/** Does this command get the network: only a hardened prepare command on the allowlist, when the settings allow it. */
const networkFor = (c: PlannedCheck, a: Pick<CheckAssignment, "prepareNetwork">) => c.kind === "prepare" && a.prepareNetwork && !c.offline && !isRebuild(c.argv) && networkRefusal(c.argv) === undefined;

/** Yarn's configuration files from the copy, read just before a yarn install runs there (at most 64 KB each). */
function readYarnRc(workspace: string): YarnRc {
  const read = (name: string) => {
    try {
      return readFileSync(join(workspace, name), "utf8").slice(0, 64 * 1024);
    } catch {
      return undefined;
    }
  };
  const yml = read(".yarnrc.yml");
  const rc = read(".yarnrc");
  return { ...(yml !== undefined ? { yarnrcYml: yml } : {}), ...(rc !== undefined ? { yarnrc: rc } : {}) };
}

export interface CheckAssignment {
  attemptId: string;
  taskId: string;
  stepId: string;
  /** A worktree detached at `target` (verified by the scheduler's prepare; verified again here when it can be read). */
  workspace: string;
  /** Full SHA. */
  target: string;
  commands: PlannedCheck[];
  runTimeoutMs: number;
  sandbox: "codex" | "none";
  prepareNetwork: boolean;
  /** The command environment, built by `checkEnv` (§6.6). */
  env: Record<string, string>;
  tmpDir: string;
  cacheDir: string;
  /** Where the full logs of this run go (one file per command). */
  logDir: string;
}

/** The RuntimeAdapter contract, minus models and health. */
export interface CheckRunner {
  readonly simulated: boolean;
  /** Begin a run. Idempotent per attempt id; events follow. */
  start(a: CheckAssignment): void;
  /** Ask a run to stop: the command is ended, and exactly one terminal event (`stopped`) follows. */
  interrupt(attemptId: string): void;
  /** End a run and forget it without any further event (orphan cleanup, lease loss). */
  kill(attemptId: string): void;
  has(attemptId: string): boolean;
  ids(): string[];
  onEvent(l: (e: AdapterEvent) => void): () => void;
  /** Whether the sandbox works on this machine (§6.5.4). Never touches the repository. */
  probe(sandbox: "codex" | "none"): Promise<ChecksHealth>;
  shutdown(): Promise<void>;
}

// ---------- limits ----------

/** Per stream, in the log and in the app-server's own capture. */
export const OUTPUT_CAP = 1024 * 1024;
/** In the state: the first 2 KB and the last 6 KB. */
export const EXCERPT_HEAD = 2 * 1024;
export const EXCERPT_TAIL = 6 * 1024;
const TERM_GRACE_MS = 5_000;
/** After a command's own time limit, how long the app-server may take to answer before the runner ends it. */
const ANSWER_GRACE_MS = 15_000;
const EXIT_GRACE_MS = 3_000;
export const REAPER = fileURLToPath(new URL("./check-reaper.mjs", import.meta.url));

// ---------- the command environment (§6.6) ----------

/** Copied from the service's environment when present. */
export const CHECK_ENV_COPIED = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "VOLTA_HOME", "NVM_DIR", "ASDF_DATA_DIR", "DEVELOPER_DIR", "SDKROOT"];
/** Never present, whatever the settings say. */
const NEVER_PASSED = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "LD_PRELOAD"]);
/** Compared case-insensitively (L11): NPM_CONFIG_*, YARN_* and PNPM_* configure the package managers whatever their case. */
const NEVER_PREFIXES = ["AWS_", "DYLD_", "ORCHESTRATION_", "GIT_", "NPM_CONFIG_", "YARN_", "PNPM_"];

/** The environment a check command sees: an allowlist copied from `base`, plus what the service sets. Secrets never pass. */
export function checkEnv(base: NodeJS.ProcessEnv, cfg: Pick<ChecksConfig, "passEnv">, dirs: { tmp: string; cache: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...CHECK_ENV_COPIED, ...cfg.passEnv]) {
    const v = base[k];
    if (v === undefined) continue;
    // Defence in depth: the settings were validated, but nothing secret-looking or reserved ever passes.
    if (SECRET_NAME.test(k) || NEVER_PASSED.has(k) || NEVER_PREFIXES.some((p) => k.toUpperCase().startsWith(p)) || blockedEnvName(k)) continue;
    out[k] = v;
  }
  out.CI = "1";
  out.NO_COLOR = "1";
  out.FORCE_COLOR = "0";
  out.TERM = "dumb";
  out.TMPDIR = dirs.tmp;
  out.XDG_CACHE_HOME = dirs.cache;
  out.npm_config_cache = join(dirs.cache, "npm");
  out.npm_config_update_notifier = "false";
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_CONFIG_NOSYSTEM = "1";
  return out;
}

// ---------- output: redaction, excerpt and log (§6.5.2 step 4) ----------

interface Captured {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  capped: boolean;
  /** The command was ended by the runner (a stop request or the run's own limit). */
  ended: boolean;
  /** Bytes the command produced on both streams, including what the cap discarded (when known). */
  produced?: number;
  /** The check process (the reaper) was ended by this signal instead of reporting an exit (M5): the run is failed, whatever the output says. */
  killed?: string;
}

/** The excerpt kept in the state: the whole text when short, else its head, a gap marker and its tail. */
export function excerptOf(text: string): string {
  if (text.length <= EXCERPT_HEAD + EXCERPT_TAIL) return text;
  return `${text.slice(0, EXCERPT_HEAD)}\n[… ${text.length - EXCERPT_HEAD - EXCERPT_TAIL} bytes …]\n${text.slice(-EXCERPT_TAIL)}`;
}

function resultOf(c: PlannedCheck, cap: Captured, durationMs: number, env: NodeJS.ProcessEnv, logDir: string, attemptId: string): CheckResult {
  const stderr = `${cap.stderr}${cap.killed ? `${cap.stderr && !cap.stderr.endsWith("\n") ? "\n" : ""}The check process was killed (${cap.killed}); no exit status was reported.\n` : ""}`;
  const raw = `${cap.stdout}${stderr ? `${cap.stdout && !cap.stdout.endsWith("\n") ? "\n" : ""}--- stderr ---\n${stderr}` : ""}`;
  const text = redact(raw, env).slice(0, OUTPUT_CAP);
  let log: string | undefined;
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const file = join(logDir, `${c.id}.log`);
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
    log = `${attemptId}/${c.id}`;
  } catch {
    /* no log file: the excerpt still records the result */
  }
  // M5: the exit status is the reaper's own; a reaper ended by a signal reported none, so the command failed.
  const status: CheckResult["status"] = cap.timedOut ? "timed-out" : cap.exitCode === 0 && !cap.killed ? "passed" : "failed";
  return {
    id: c.id,
    label: c.label,
    kind: c.kind,
    status,
    ...(cap.exitCode !== undefined ? { exitCode: cap.exitCode } : {}),
    durationMs,
    excerpt: excerptOf(text),
    bytes: cap.produced ?? Buffer.byteLength(cap.stdout, "utf8") + Buffer.byteLength(cap.stderr, "utf8"),
    truncated: cap.capped || text.length > EXCERPT_HEAD + EXCERPT_TAIL,
    ...(log ? { log } : {}),
  };
}

const notRun = (c: PlannedCheck): CheckResult => ({ id: c.id, label: c.label, kind: c.kind, status: "not-run", durationMs: 0, excerpt: "", bytes: 0, truncated: false });

// ---------- the workspace's commit (§6.10: the runner refuses a worktree that is not at the target) ----------

/** The commit a git worktree (or repository) is checked out at, read from its files; undefined when it cannot be told. */
export function headOf(workspace: string): string | undefined {
  try {
    const dotGit = join(workspace, ".git");
    if (!existsSync(dotGit)) return undefined;
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m) return undefined;
      gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(workspace, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return undefined;
    let common = gitDir;
    const commonFile = join(gitDir, "commondir");
    if (existsSync(commonFile)) {
      const c = readFileSync(commonFile, "utf8").trim();
      common = isAbsolute(c) ? c : resolve(gitDir, c);
    }
    const loose = join(common, ref);
    if (existsSync(loose)) {
      const sha = readFileSync(loose, "utf8").trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
    }
    const packed = join(common, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        const m = /^([0-9a-f]{40}) (.+)$/.exec(line);
        if (m && m[2] === ref) return m[1];
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------- the common run machinery ----------

interface Run {
  a: CheckAssignment;
  startedAt: number;
  results: CheckResult[];
  done: boolean;
  stopRequested: boolean;
  /** Ends the command in flight; the exec promise then settles. */
  current?: () => void;
  timers: Set<ReturnType<typeof setTimeout>>;
}

abstract class BaseChecks implements CheckRunner {
  abstract readonly simulated: boolean;
  protected readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  protected readonly log: (msg: string) => void;
  protected readonly baseEnv: NodeJS.ProcessEnv;

  constructor(o: { log?: (msg: string) => void; env?: NodeJS.ProcessEnv } = {}) {
    this.log = o.log ?? (() => {});
    this.baseEnv = o.env ?? process.env;
  }

  has(attemptId: string) {
    return this.runs.has(attemptId);
  }
  ids() {
    return [...this.runs.keys()];
  }
  onEvent(l: (e: AdapterEvent) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  protected emit(e: AdapterEvent) {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        this.log(`checks: event listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  start(a: CheckAssignment): void {
    if (this.runs.has(a.attemptId)) return;
    const run: Run = { a, startedAt: Date.now(), results: [], done: false, stopRequested: false, timers: new Set() };
    this.runs.set(a.attemptId, run);
    const head = headOf(a.workspace);
    if (head && head !== a.target) {
      setImmediate(() => this.finish(run, { type: "failed", attemptId: a.attemptId, message: `the workspace is not at ${a.target.slice(0, 12)} (it is at ${head.slice(0, 12)}); nothing was run` }));
      return;
    }
    void this.drive(run);
  }

  interrupt(attemptId: string): void {
    const run = this.runs.get(attemptId);
    if (!run || run.done) return;
    run.stopRequested = true;
    run.current?.();
    // Between commands nothing is in flight: the loop sees the flag at once. A command that will not die is force-killed by its own stop.
  }

  kill(attemptId: string): void {
    const run = this.runs.get(attemptId);
    if (!run) return;
    run.done = true;
    this.runs.delete(attemptId);
    this.clearTimers(run);
    run.current?.();
    this.cleanup(run);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runs.keys()]) this.kill(id);
  }

  abstract probe(sandbox: "codex" | "none"): Promise<ChecksHealth>;

  /** Run one command; resolves when it ended (never rejects). */
  protected abstract exec(run: Run, c: PlannedCheck): Promise<Captured>;
  /** Anything to end once the run is over (an app-server). */
  protected cleanup(_run: Run): void {}
  /** Before the first command (an app-server to start). Throws when the run cannot begin. */
  protected async prepare(_run: Run): Promise<void> {}

  private async drive(run: Run) {
    const { a } = run;
    try {
      await this.prepare(run);
    } catch (e) {
      this.finish(run, { type: "failed", attemptId: a.attemptId, message: redact(e instanceof Error ? e.message : String(e), this.baseEnv).slice(0, 300) });
      return;
    }
    if (run.done) return;
    this.timer(run, () => {
      if (run.done) return;
      const minutes = Math.round(a.runTimeoutMs / 60_000);
      run.current?.();
      this.finish(run, { type: "failed", attemptId: a.attemptId, message: `Checks reached their ${minutes}-minute time limit.` });
    }, a.runTimeoutMs);
    let prepareFailed = false;
    try {
      mkdirSync(a.tmpDir, { recursive: true, mode: 0o700 });
    } catch {
      /* the command reports it */
    }
    for (const planned of a.commands) {
      // What runs is the hardened command (H1); the record keeps the id and label the settings gave it.
      // Yarn's own configuration is read from the copy just before the install runs there.
      const c = hardenCommand(planned, a, planned.argv[0] === "yarn" ? readYarnRc(a.workspace) : {});
      if (run.done || run.stopRequested) break;
      if (prepareFailed) {
        run.results.push(notRun(c));
        continue;
      }
      // Only a sandbox can refuse the network; without one the reason is not claimed.
      const refused = a.sandbox === "codex" && c.offlineReason ? `The network was refused for this command: ${c.offlineReason}` : undefined;
      this.emit({ type: "activity", attemptId: a.attemptId, note: `Running ${c.label} (${c.argv.join(" ")})${refused ? ` offline: ${c.offlineReason}` : ""}`.slice(0, 200) });
      const t0 = Date.now();
      const cap0 = await this.exec(run, c);
      const cap = refused ? { ...cap0, stdout: `[${refused}]\n${cap0.stdout}` } : cap0;
      if (run.done) return;
      if (run.stopRequested || cap.ended) break;
      const r = resultOf(c, cap, Date.now() - t0, this.baseEnv, a.logDir, a.attemptId);
      run.results.push(r);
      if (c.kind === "prepare" && r.status !== "passed") prepareFailed = true;
    }
    if (run.done) return;
    if (run.stopRequested) {
      this.finish(run, { type: "stopped", attemptId: a.attemptId, how: "interrupted" });
      return;
    }
    const report: CheckRunReport = { sha: a.target, results: run.results, durationMs: Date.now() - run.startedAt, sandbox: a.sandbox, ...(this.simulated ? { simulated: true as const } : {}) };
    this.finish(run, { type: "completed", attemptId: a.attemptId, finalText: "", checks: report });
  }

  protected finish(run: Run, e: AdapterEvent) {
    if (run.done) return;
    run.done = true;
    this.clearTimers(run);
    if (this.runs.get(run.a.attemptId) === run) this.runs.delete(run.a.attemptId);
    this.emit(e);
    this.cleanup(run);
  }

  protected timer(run: Run, fn: () => void, ms: number) {
    const t = setTimeout(() => {
      run.timers.delete(t);
      fn();
    }, ms);
    run.timers.add(t);
  }

  private clearTimers(run: Run) {
    for (const t of run.timers) clearTimeout(t);
    run.timers.clear();
  }
}

// ---------- no sandbox (§6.5.3) ----------

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** The reaper's arguments: its options, then "--", then the command's argv exactly as given. */
function reaperArgs(argv: string[], o: { pidFile?: string } = {}): string[] {
  return [REAPER, ...(o.pidFile ? ["--pid-file", o.pidFile] : []), "--", ...argv];
}

/**
 * The verdict of a probe command that prints "DENIED <code>" and exits 3 when the sandbox refused it,
 * or `success` when it got through (L5): only an explicit refusal (EPERM or EACCES) is a denial. An
 * unreachable network, a missing directory or a timeout proves nothing and stays "unknown".
 */
export function probeVerdict(stdout: string, exitCode: number | undefined, success: string): "denied" | "allowed" | "unknown" {
  if (stdout.includes(success)) return "allowed";
  const m = /DENIED (E[A-Z]+)/.exec(stdout);
  return exitCode === 3 && m && (m[1] === "EPERM" || m[1] === "EACCES") ? "denied" : "unknown";
}

/** Start argv through the reaper (its own process group) and capture its output up to the cap. */
function spawnReaper(spawnFn: SpawnFn, argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; pidFile?: string }): { child: ChildProcess; done: Promise<Captured> } {
  const child = spawnFn(process.execPath, reaperArgs(argv, { pidFile: o.pidFile }), {
    cwd: o.cwd,
    env: o.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  trackLive(child);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let produced = 0;
  let capped = false;
  const take = (bufs: Buffer[], have: number, d: Buffer) => {
    produced += d.length;
    if (have >= OUTPUT_CAP) {
      capped = true;
      return have;
    }
    const room = OUTPUT_CAP - have;
    if (d.length > room) capped = true;
    bufs.push(d.subarray(0, room));
    return have + Math.min(room, d.length);
  };
  child.stdout?.on("data", (d: Buffer) => (outBytes = take(out, outBytes, d)));
  child.stderr?.on("data", (d: Buffer) => (errBytes = take(err, errBytes, d)));
  const done = new Promise<Captured>((resolveDone) => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      // M5: the exit status is the reaper's own (it exits with the command's code, or 128 plus the
      // signal). A reaper that was itself ended by a signal reported nothing: the run is failed.
      const killed = code === null && !error ? (signal ?? "signal") : undefined;
      resolveDone({ exitCode: code ?? undefined, stdout: Buffer.concat(out).toString("utf8"), stderr: `${Buffer.concat(err).toString("utf8")}${error ? `\n${error.message}` : ""}`, timedOut: false, capped, ended: false, produced, ...(killed ? { killed } : {}) });
    };
    child.on("error", (e) => settle(null, null, e));
    child.on("close", (code, signal) => settle(code, signal));
  });
  return { child, done };
}

export class DirectChecks extends BaseChecks {
  readonly simulated = false;
  private readonly spawnFn: SpawnFn;
  private readonly graceMs: number;

  constructor(o: { graceMs?: number; spawn?: SpawnFn; log?: (msg: string) => void; env?: NodeJS.ProcessEnv } = {}) {
    super(o);
    this.spawnFn = o.spawn ?? nodeSpawn;
    this.graceMs = o.graceMs ?? TERM_GRACE_MS;
  }

  protected async exec(run: Run, c: PlannedCheck): Promise<Captured> {
    const { a } = run;
    let started: ReturnType<typeof spawnReaper>;
    try {
      started = spawnReaper(this.spawnFn, c.argv, { cwd: a.workspace, env: { ...a.env, ...(c.env ?? {}) } });
    } catch (e) {
      return { exitCode: undefined, stdout: "", stderr: `could not start ${c.argv[0]}: ${e instanceof Error ? e.message : String(e)}`, timedOut: false, capped: false, ended: false };
    }
    const { child, done } = started;
    let timedOut = false;
    let ended = false;
    const end = () => {
      killGroup(child, "SIGTERM");
      const t = setTimeout(() => killGroup(child, "SIGKILL"), this.graceMs);
      t.unref();
    };
    run.current = () => {
      ended = true;
      end();
    };
    this.timer(run, () => {
      timedOut = true;
      end();
    }, c.timeoutMs);
    const cap = await done;
    run.current = undefined;
    return { ...cap, timedOut, ended };
  }

  async probe(sandbox: "codex" | "none"): Promise<ChecksHealth> {
    const checkedAt = new Date().toISOString();
    if (sandbox === "codex") return { sandbox, status: "unavailable", detail: "This runner has no Codex sandbox.", checkedAt };
    return { sandbox: "none", status: "ready", detail: "No sandbox: checks run with your permissions on this computer, as you chose. They can read, write and reach the network like you can.", checkedAt };
  }
}

// ---------- the Codex sandbox (§6.5.2) ----------

interface CodexSandboxOptions {
  /** Path to the Codex CLI. Default: ./node_modules/.bin/codex, falling back to `codex` on PATH. A .js/.mjs path is run with this Node. */
  codexBin?: string;
  /** A private CODEX_HOME for the check app-servers (mode 0700, never signed in). */
  home: string;
  /** Where probes get their scratch directories. Default: next to `home`. */
  probeDir?: string;
  graceMs?: number;
  spawn?: SpawnFn;
  log?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
}

interface Server {
  child: ChildProcess;
  rpc: JsonRpcConnection;
  stderrTail: string;
}

/** The server-side state of a run, kept outside `Run` so the base class stays neutral. */
const servers = new WeakMap<Run, Server>();

export class CodexSandboxChecks extends BaseChecks {
  readonly simulated = false;
  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly home: string;
  private readonly probeDir: string;
  private readonly spawnFn: SpawnFn;
  private readonly graceMs: number;

  constructor(o: CodexSandboxOptions) {
    super(o);
    const bin = o.codexBin ?? defaultCodexPath();
    if (/\.(mjs|cjs|js)$/.test(bin)) {
      this.command = process.execPath;
      this.prefixArgs = [bin];
    } else {
      this.command = bin;
      this.prefixArgs = [];
    }
    this.home = o.home;
    this.probeDir = o.probeDir ?? join(dirname(o.home), "checks-probe");
    this.spawnFn = o.spawn ?? nodeSpawn;
    this.graceMs = o.graceMs ?? TERM_GRACE_MS;
  }

  /** The exact arguments every check app-server is started with (tests assert them). */
  static serverArgs(): string[] {
    return [...APP_SERVER_ARGS, ...ISOLATION_FEATURE_ARGS, ...ISOLATION_CONFIG_ARGS];
  }

  /** Start and initialise an app-server for a run, with the command environment and the private home. */
  private async startServer(env: Record<string, string>, cwd: string): Promise<Server> {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
    const child = this.spawnFn(this.command, [...this.prefixArgs, ...CodexSandboxChecks.serverArgs()], {
      cwd,
      env: { ...env, CODEX_HOME: this.home },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    trackLive(child);
    const server: Server = { child, rpc: undefined as unknown as JsonRpcConnection, stderrTail: "" };
    server.rpc = new JsonRpcConnection(child.stdout!, child.stdin!, { onGarbage: () => this.log("checks: ignored a non-protocol line from the app-server") });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (server.stderrTail = (server.stderrTail + d).slice(-2000)));
    child.on("close", () => server.rpc.close());
    const failure = new Promise<never>((_, reject) => {
      child.on("error", (e) => reject(new Error(`could not start the Codex app-server: ${e.message}`)));
      child.on("exit", (code) => setTimeout(() => reject(new Error(`the Codex app-server exited (code ${code})${server.stderrTail.trim() ? `: ${server.stderrTail.trim().split("\n").slice(-2).join(" ").slice(0, 200)}` : ""}`)), 100));
    });
    failure.catch(() => {});
    await Promise.race([
      (async () => {
        await server.rpc.request("initialize", { clientInfo: { name: "orchestration-checks", title: "Orchestrator checks", version: "0.1.0" }, capabilities: null }, 20_000);
        server.rpc.notify("initialized");
      })(),
      failure,
    ]);
    return server;
  }

  private endServer(server: Server) {
    server.rpc.close();
    try {
      server.child.stdin?.end();
    } catch {
      /* ignore */
    }
    const t1 = setTimeout(() => killGroup(server.child, "SIGTERM"), EXIT_GRACE_MS);
    const t2 = setTimeout(() => killGroup(server.child, "SIGKILL"), EXIT_GRACE_MS + TERM_GRACE_MS);
    t1.unref();
    t2.unref();
    server.child.once("exit", () => {
      clearTimeout(t1);
      clearTimeout(t2);
    });
  }

  protected async prepare(run: Run): Promise<void> {
    const { a } = run;
    mkdirSync(a.tmpDir, { recursive: true, mode: 0o700 });
    mkdirSync(a.cacheDir, { recursive: true, mode: 0o700 });
    const server = await this.startServer(a.env, a.workspace);
    if (run.done) {
      this.endServer(server);
      return;
    }
    servers.set(run, server);
  }

  protected cleanup(run: Run): void {
    const server = servers.get(run);
    if (!server) return;
    servers.delete(run);
    this.endServer(server);
  }

  /**
   * The `command/exec` request for one command: argv through the reaper, the run's directories
   * writable, network only for an allowlisted download (never for a rebuild or anything else), when
   * allowed. The command is hardened here too (H1), whatever the caller passed, with yarn's own
   * configuration read from the copy the install runs in.
   */
  static execParams(a: Pick<CheckAssignment, "attemptId" | "workspace" | "prepareNetwork" | "env" | "tmpDir" | "cacheDir">, c0: PlannedCheck, o: { pidFile?: string } = {}): CommandExecParams {
    const c = hardenCommand(c0, a, c0.argv[0] === "yarn" ? readYarnRc(a.workspace) : {});
    const policy: SandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: [a.workspace, a.tmpDir, a.cacheDir],
      networkAccess: networkFor(c, a),
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    return {
      command: [process.execPath, ...reaperArgs(c.argv, { pidFile: o.pidFile })],
      processId: `${a.attemptId}:${c.id}`,
      cwd: a.workspace,
      env: { ...a.env, ...(c.env ?? {}) },
      timeoutMs: c.timeoutMs,
      outputBytesCap: OUTPUT_CAP,
      sandboxPolicy: policy,
    };
  }

  /** Run one command on a server. Resolves with what was captured; a stop or the watchdog ends it. */
  private async execOn(server: Server, params: CommandExecParams, c: PlannedCheck, hold: { current?: () => void; run?: Run }): Promise<Captured> {
    const t0 = Date.now();
    let timedOut = false;
    let ended = false;
    let killed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const terminate = () => {
      server.rpc.request("command/exec/terminate", { processId: params.processId! }).catch(() => {});
      const t = setTimeout(() => {
        killed = true;
        killGroup(server.child, "SIGKILL");
      }, this.graceMs);
      timers.push(t);
    };
    // The command's own limit is the server's; if it does not answer within the grace after it, the runner ends it.
    timers.push(
      setTimeout(() => {
        timedOut = true;
        terminate();
      }, c.timeoutMs + ANSWER_GRACE_MS),
    );
    hold.current = () => {
      ended = true;
      terminate();
    };
    let answer: CommandExecResponse | undefined;
    let error: string | undefined;
    try {
      answer = await server.rpc.request("command/exec", params);
    } catch (e) {
      error = e instanceof RpcClosedError ? (killed ? "the command was ended" : "the Codex app-server closed the connection") : e instanceof Error ? e.message : String(e);
    } finally {
      for (const t of timers) clearTimeout(t);
      hold.current = undefined;
    }
    const elapsed = Date.now() - t0;
    if (elapsed >= c.timeoutMs) timedOut = true;
    if (!answer) return { exitCode: undefined, stdout: "", stderr: error ?? "no answer", timedOut, capped: false, ended };
    // M5: the app-server reports the reaper's own exit status: the command's code, or 128 plus a signal
    // when the command died of one. The same shape is what a reaper killed from outside leaves, so a
    // signal-shaped status that the runner did not cause is recorded as the check process being killed.
    const reported = typeof answer.exitCode === "number" ? answer.exitCode : undefined;
    const bySignal = reported !== undefined && reported > 128 && !ended && !timedOut ? `signal ${reported - 128}` : undefined;
    return {
      exitCode: reported,
      stdout: answer.stdout ?? "",
      stderr: answer.stderr ?? "",
      timedOut,
      capped: (answer.stdout?.length ?? 0) >= OUTPUT_CAP || (answer.stderr?.length ?? 0) >= OUTPUT_CAP,
      ended,
      ...(bySignal ? { killed: bySignal } : {}),
    };
  }

  protected async exec(run: Run, c: PlannedCheck): Promise<Captured> {
    const server = servers.get(run);
    if (!server) return { exitCode: undefined, stdout: "", stderr: "no app-server for this run", timedOut: false, capped: false, ended: true };
    const hold: { current?: () => void } = {};
    const p = this.execOn(server, CodexSandboxChecks.execParams(run.a, c), c, hold);
    run.current = () => hold.current?.();
    const cap = await p;
    run.current = undefined;
    // A command the runner had to kill took the app-server with it: nothing else can run on it.
    if (server.rpc.isClosed && !cap.ended) return { ...cap, ended: false };
    return cap;
  }

  /**
   * The probe (§6.5.4): service-owned commands in a scratch directory, never the repository. A write
   * inside the writable root must work; a write into $HOME must be refused; a connection to this
   * machine's own loopback (where the service listens, H1) and to 1.1.1.1:443 must be refused; a
   * grandchild the reaper started must be gone after terminate. Only an explicit refusal counts (L5).
   * `checkedAt` is when the probe began, so a "Check again" asked for meanwhile is not lost.
   */
  async probe(sandbox: "codex" | "none"): Promise<ChecksHealth> {
    const checkedAt = new Date().toISOString();
    if (sandbox === "none") return { sandbox, status: "ready", detail: "No sandbox: checks run with your permissions on this computer, as you chose.", checkedAt };
    const rand = Math.random().toString(36).slice(2, 10);
    const scratch = join(this.probeDir, `probe-${rand}`);
    const tmp = join(scratch, "tmp");
    const cache = join(scratch, "cache");
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const env = checkEnv(this.baseEnv, { passEnv: [] }, { tmp, cache });
    const home = this.baseEnv.HOME ?? "";
    const outside = join(home, `.orchestrator-probe-${rand}`);
    const probes: NonNullable<ChecksHealth["probes"]> = { writeOutside: "unknown", network: "unknown", loopback: "unknown" };
    const listeners: NetServer[] = [];
    const cleanup = () => {
      for (const l of listeners) l.close();
      rmSync(scratch, { recursive: true, force: true });
      rmSync(outside, { force: true });
    };
    let server: Server | undefined;
    try {
      server = await this.startServer(env, scratch);
      const base = { attemptId: `probe-${rand}`, workspace: scratch, prepareNetwork: false, env, tmpDir: tmp, cacheDir: cache };
      const runIt = (id: string, argv: string[], pidFile?: string) => this.execOn(server!, CodexSandboxChecks.execParams(base, { id, label: id, kind: "check", argv, timeoutMs: 20_000 }, { pidFile }), { id, label: id, kind: "check", argv, timeoutMs: 20_000 }, {});
      const node = process.execPath;
      const unavailable = (detail: string): ChecksHealth => ({ sandbox, status: "unavailable", detail, checkedAt, probes });
      // 1. A write inside the writable root must succeed.
      const inside = await runIt("write-inside", [node, "-e", `require("node:fs").writeFileSync(process.argv[1], "ok")`, join(scratch, "inside.txt")]);
      if (inside.exitCode !== 0 || !existsSync(join(scratch, "inside.txt"))) {
        return unavailable(`A command could not write inside its own directory (exit ${inside.exitCode ?? "?"}): ${(inside.stderr || inside.stdout).trim().slice(0, 200) || "no output"}`);
      }
      // 2. A write outside (into $HOME) must be refused by the sandbox (EPERM or EACCES), not merely fail.
      const out = await runIt("write-outside", [node, "-e", `try { require("node:fs").writeFileSync(process.argv[1], "x"); console.log("WROTE") } catch (e) { console.log("DENIED " + e.code); process.exit(3) }`, outside]);
      probes.writeOutside = existsSync(outside) ? "allowed" : probeVerdict(out.stdout, out.exitCode, "WROTE");
      if (probes.writeOutside !== "denied") return unavailable(probes.writeOutside === "allowed" ? "The sandbox let a command write outside its directory; checks are held until it is fixed or you choose to run without a sandbox." : `Could not prove the sandbox blocks writes outside the run (${out.stdout.trim().slice(0, 60) || "no answer"}). Check again.`);
      // 3. This machine's own loopback must be refused: the service's control API listens there (H1).
      //    The probe listens itself, on 127.0.0.1 and ::1, so the answer does not depend on the service's port.
      const targets: { host: string; port: number }[] = [];
      for (const host of ["127.0.0.1", "::1"]) {
        const l = await new Promise<NetServer | undefined>((res) => {
          const srv = createServer();
          srv.once("error", () => res(undefined));
          srv.listen(0, host, () => res(srv));
        });
        if (!l) continue; // no such loopback on this machine: nothing to reach there
        listeners.push(l);
        targets.push({ host, port: (l.address() as { port: number }).port });
      }
      for (const t of targets) {
        const loop = await runIt(`loopback-${t.host === "::1" ? "v6" : "v4"}`, [node, "-e", `const s = require("node:net").connect(Number(process.argv[2]), process.argv[1]); s.on("connect", () => { console.log("CONNECTED"); process.exit(0) }); s.on("error", (e) => { console.log("DENIED " + e.code); process.exit(3) }); setTimeout(() => { console.log("TIMEOUT"); process.exit(4) }, 2000)`, t.host, String(t.port)]);
        const v = probeVerdict(loop.stdout, loop.exitCode, "CONNECTED");
        probes.loopback = probes.loopback === "allowed" || v === "allowed" ? "allowed" : probes.loopback === "unknown" && targets.indexOf(t) > 0 ? "unknown" : v;
        if (v !== "denied") break;
      }
      if (probes.loopback !== "denied") return unavailable(probes.loopback === "allowed" ? "The sandbox does not block your own machine: a command reached this computer's loopback address, where this service listens. Checks are held." : "Could not prove the sandbox blocks connections to this machine's own loopback address. Check again.");
      // 4. The network must be refused by the sandbox: an unreachable network or a timeout proves nothing.
      const net = await runIt("network", [node, "-e", `const s = require("node:net").connect(443, "1.1.1.1"); s.on("connect", () => { console.log("CONNECTED"); process.exit(0) }); s.on("error", (e) => { console.log("DENIED " + e.code); process.exit(3) }); setTimeout(() => { console.log("TIMEOUT"); process.exit(4) }, 2000)`]);
      probes.network = probeVerdict(net.stdout, net.exitCode, "CONNECTED");
      if (probes.network !== "denied") return unavailable(probes.network === "allowed" ? "The sandbox let a command open a network connection; checks are held." : `Could not prove the sandbox blocks the network (${net.stdout.trim().slice(0, 60) || "no answer"}: not a refusal). Check again with the network on.`);
      // 5. A grandchild the reaper started must be gone after terminate.
      const pidFile = join(scratch, "child.pid");
      const long = { id: "grandchild", label: "grandchild", kind: "check" as const, argv: [node, "-e", "setInterval(() => {}, 1000)"], timeoutMs: 20_000 };
      const hold: { current?: () => void } = {};
      const running = this.execOn(server, CodexSandboxChecks.execParams(base, long, { pidFile }), long, hold);
      let pid: number | undefined;
      for (let i = 0; i < 50 && pid === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const n = Number(readFileSync(pidFile, "utf8").trim());
          if (Number.isInteger(n) && n > 0) pid = n;
        } catch {
          /* not written yet */
        }
      }
      if (pid === undefined) {
        hold.current?.();
        await running;
        return { sandbox, status: "unavailable", detail: "The reaper did not report its child's pid within 5 s; termination could not be verified.", checkedAt, probes };
      }
      hold.current?.();
      await running;
      let gone = false;
      for (let i = 0; i < 30 && !gone; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          gone = true;
        }
      }
      if (!gone) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* raced */
        }
        return { sandbox, status: "unavailable", detail: "A process a check started survived the command's termination; the reaper could not end its group.", checkedAt, probes };
      }
      return { sandbox, status: "ready", detail: "Codex sandbox verified: writes outside the run's directories, connections to this machine's own loopback and network connections are refused, and terminated commands take their children with them.", checkedAt, probes };
    } catch (e) {
      return { sandbox, status: "unavailable", detail: redact(e instanceof Error ? e.message : String(e), this.baseEnv).slice(0, 300), checkedAt, probes };
    } finally {
      if (server) this.endServer(server);
      cleanup();
    }
  }
}

// ---------- the facade (§6.5.1) ----------

export class CheckRunners implements CheckRunner {
  readonly simulated = false;
  constructor(
    private readonly codex: CheckRunner,
    private readonly direct: CheckRunner,
  ) {}
  private for(a: CheckAssignment): CheckRunner {
    return a.sandbox === "codex" ? this.codex : this.direct;
  }
  private owner(id: string): CheckRunner | undefined {
    return this.codex.has(id) ? this.codex : this.direct.has(id) ? this.direct : undefined;
  }
  start(a: CheckAssignment) {
    if (this.owner(a.attemptId)) return;
    this.for(a).start(a);
  }
  interrupt(id: string) {
    this.owner(id)?.interrupt(id);
  }
  kill(id: string) {
    this.owner(id)?.kill(id);
  }
  has(id: string) {
    return !!this.owner(id);
  }
  ids() {
    return [...this.codex.ids(), ...this.direct.ids()];
  }
  onEvent(l: (e: AdapterEvent) => void) {
    const a = this.codex.onEvent(l);
    const b = this.direct.onEvent(l);
    return () => {
      a();
      b();
    };
  }
  probe(sandbox: "codex" | "none") {
    return sandbox === "codex" ? this.codex.probe(sandbox) : this.direct.probe(sandbox);
  }
  async shutdown() {
    await Promise.all([this.codex.shutdown(), this.direct.shutdown()]);
  }
}

// ---------- the simulated runner (§6.8) ----------

type SimulatedScript = (a: CheckAssignment, n: number) => CheckResult[];

/** The default story: in a task tree's first run the "test" command fails; every later run passes. */
function defaultSimulatedScript(a: CheckAssignment, n: number): CheckResult[] {
  return a.commands.map((c) => {
    const fail = n === 0 && c.id === "test";
    return {
      id: c.id,
      label: c.label,
      kind: c.kind,
      status: fail ? "failed" : "passed",
      exitCode: fail ? 1 : 0,
      durationMs: 1200,
      excerpt: fail ? "(simulated) 1 failing test" : `(simulated) ${c.label} passed`,
      bytes: 0,
      truncated: false,
    };
  });
}

interface SimProc {
  a: CheckAssignment;
  progress: number;
  interruptAt?: number;
}

/** Nothing is spawned; every record is marked simulated. Advances on the scheduler's clock like the fake adapters. */
export class SimulatedChecks implements CheckRunner {
  readonly simulated = true;
  private readonly procs = new Map<string, SimProc>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private readonly seen = new Map<string, number>();
  ackDelayMs = 2500;
  progressPerTick = 25;

  constructor(private readonly script: SimulatedScript = defaultSimulatedScript) {}

  private emit(e: AdapterEvent) {
    for (const l of [...this.listeners]) l(e);
  }
  start(a: CheckAssignment) {
    if (this.procs.has(a.attemptId)) return;
    this.procs.set(a.attemptId, { a, progress: 0 });
    this.emit({ type: "started", attemptId: a.attemptId });
  }
  interrupt(id: string) {
    const p = this.procs.get(id);
    if (p && p.interruptAt === undefined) p.interruptAt = Date.now();
  }
  interruptAt(id: string, nowMs: number) {
    const p = this.procs.get(id);
    if (p && p.interruptAt === undefined) p.interruptAt = nowMs;
  }
  kill(id: string) {
    this.procs.delete(id);
  }
  has(id: string) {
    return this.procs.has(id);
  }
  ids() {
    return [...this.procs.keys()];
  }
  onEvent(l: (e: AdapterEvent) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  /** Advance every run by one tick; events are emitted synchronously. */
  tick(nowMs: number) {
    for (const [id, p] of [...this.procs]) {
      if (p.interruptAt !== undefined) {
        if (nowMs - p.interruptAt >= this.ackDelayMs) {
          this.procs.delete(id);
          this.emit({ type: "stopped", attemptId: id, how: "interrupted" });
        }
        continue;
      }
      p.progress = Math.min(100, p.progress + this.progressPerTick);
      if (p.progress >= 100) {
        this.procs.delete(id);
        // The tree's root: child tasks (WT-004.2) and the service's own merge checks and reviews (WT-002-CK1, WT-002-RV1)
        // count as their root, so only a tree's very first check run fails, as the story intends.
        const root = p.a.taskId.replace(/\..*$/, "").replace(/(-(?:CK|RV)\d+)+$/, "");
        const n = this.seen.get(root) ?? 0;
        this.seen.set(root, n + 1);
        const results = this.script(p.a, n);
        this.emit({ type: "completed", attemptId: id, finalText: "", checks: { sha: p.a.target, results, durationMs: results.reduce((s, r) => s + r.durationMs, 0), sandbox: p.a.sandbox, simulated: true } });
      } else this.emit({ type: "progress", attemptId: id, percent: p.progress });
    }
  }
  async probe(sandbox: "codex" | "none"): Promise<ChecksHealth> {
    return { sandbox, status: "ready", detail: "Simulated: no command runs and nothing is spawned.", checkedAt: new Date().toISOString() };
  }
  async shutdown() {
    this.procs.clear();
  }
}

// ---------- logs (§6.6) ----------

const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const LOG_MAX_BYTES = 200 * 1024 * 1024;

/** Remove check logs older than 14 days, then the oldest runs until the total is under 200 MiB. Returns how many run directories went. */
export function pruneCheckLogs(root: string, nowMs = Date.now()): number {
  if (!existsSync(root)) return 0;
  const runs: { dir: string; mtime: number; bytes: number }[] = [];
  for (const project of readdirSync(root)) {
    const pdir = join(root, project);
    let entries: string[];
    try {
      if (!statSync(pdir).isDirectory()) continue;
      entries = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const run of entries) {
      const dir = join(pdir, run);
      try {
        if (!statSync(dir).isDirectory()) continue;
        let mtime = statSync(dir).mtimeMs;
        let bytes = 0;
        for (const f of readdirSync(dir)) {
          const st = statSync(join(dir, f));
          bytes += st.size;
          mtime = Math.max(mtime, st.mtimeMs);
        }
        runs.push({ dir, mtime, bytes });
      } catch {
        /* unreadable: left alone */
      }
    }
  }
  let removed = 0;
  let total = runs.reduce((s, r) => s + r.bytes, 0);
  runs.sort((a, b) => a.mtime - b.mtime);
  for (const r of runs) {
    if (nowMs - r.mtime <= LOG_MAX_AGE_MS && total <= LOG_MAX_BYTES) continue;
    rmSync(r.dir, { recursive: true, force: true });
    total -= r.bytes;
    removed++;
  }
  return removed;
}
