// Codex runtime adapter over the pinned Codex CLI app-server (JSON-RPC over stdio).
//
// Process model: one `codex app-server` child per attempt, in its own process group, so that a kill
// also reaches the native binary the npm wrapper spawns and any command it is running. Protocol
// shapes come from ./codex-protocol (generated from the pinned CLI; see its README.md).
//
// Flow per attempt: initialize -> initialized -> thread/start -> [started] -> turn/start -> ...
// item/completed notes -> turn/completed -> exactly one terminal event -> child terminated.
// ORC-022: a note mid-run is a `turn/steer` on that turn (expectedTurnId pins it); the app-server's
// answer decides delivered or not-delivered.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { CatalogModel, ProviderId } from "../../src/domain/types";
import type { CapabilityMap } from "../../src/runtime/adapter";
import type { InitializeParams } from "./codex-protocol/InitializeParams";
import type { ServerNotification } from "./codex-protocol/ServerNotification";
import type { ServerRequest } from "./codex-protocol/ServerRequest";
import type { GetAccountResponse } from "./codex-protocol/v2/GetAccountResponse";
import type { ModelListResponse } from "./codex-protocol/v2/ModelListResponse";
import type { SandboxPolicy } from "./codex-protocol/v2/SandboxPolicy";
import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { ThreadStartParams } from "./codex-protocol/v2/ThreadStartParams";
import type { TurnError } from "./codex-protocol/v2/TurnError";
import type { TurnStartParams } from "./codex-protocol/v2/TurnStartParams";
import type { TurnSteerParams } from "./codex-protocol/v2/TurnSteerParams";
import { killGroup, trackLive } from "../processes";
import { redact, withoutGitHubTokens } from "../redact";
import { JsonRpcConnection, RpcClosedError, RpcError } from "./codexRpc";
import type { AdapterEvent, Assignment, Connection, ProviderHealth, RuntimeAdapter, Usage } from "./types";

/** The @openai/codex version the generated protocol types were produced from. */
export const PINNED_CODEX_VERSION = "0.159.2";

/**
 * Extra CLI arguments for every app-server we start. Both verified against 0.159.2:
 * `agents.enabled` is a typed boolean config field (rejected with "expected a boolean" for a string
 * under --strict-config), and `multi_agent` is a known feature flag (`codex features list` shows it
 * false with `--disable multi_agent`). Together they keep native subagents off.
 */
/** A run's private temp directory: a sibling of its worktree (never inside it, so nothing is committed). */
export function runTmpDir(a: Assignment): string {
  const dir = `${a.workspace.path}.tmp`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Every app-server the service starts: native sub-agents off, and (ORC-013) the repository's own
 * instruction files never loaded by Codex itself (`project_doc_max_bytes=0`; the pinned 0.159.2
 * binary ships the key with a default of 32768). The worktree copy of AGENTS.md is agent-written;
 * the service passes the trusted base's copy in the envelope as labelled project conventions instead.
 */
export const PROJECT_DOC_ARGS = ["-c", "project_doc_max_bytes=0"];
export const APP_SERVER_ARGS = ["app-server", "-c", "agents.enabled=false", "--disable", "multi_agent", ...PROJECT_DOC_ARGS];

/**
 * Worker isolation, parity with the Claude adapter (no settings, no MCP, no sub-agents, no web):
 * the user's own Codex setup (plugins, apps, computer/browser use, memories, web search) must not be
 * available to orchestration workers. Verified against codex-cli 0.159.2 feature names; MCP servers
 * from config.toml are disabled individually because a table override merges rather than replaces.
 */
export const ISOLATION_FEATURE_ARGS = [
  "--disable",
  "plugins",
  "--disable",
  "apps",
  "--disable",
  "computer_use",
  "--disable",
  "browser_use",
  "--disable",
  "in_app_browser",
  "--disable",
  "memories",
];
export const ISOLATION_CONFIG_ARGS = ["-c", 'web_search="disabled"'];

/** `-c mcp_servers.<name>.enabled=false` for each server still enabled; names are TOML-quoted when needed. */
export function mcpDisableArgs(enabledNames: string[]): string[] {
  return enabledNames.flatMap((n) => ["-c", `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(n) ? n : JSON.stringify(n)}.enabled=false`]);
}

export const LOGIN_GUIDANCE =
  "Codex is not signed in. Run `npx codex login` (or `printenv OPENAI_API_KEY | npx codex login --with-api-key`) and restart the service.";

const CAPABILITIES: CapabilityMap = {
  start: "supported",
  streamEvents: "supported",
  // ORC-022: turn/steer is wired for notes and tested against the stub app-server; unverified against a real model run.
  steer: "unverified",
  interrupt: "supported",
  // thread/resume exists; threads are persisted by Codex, but resume is not wired or tested.
  resume: "unverified",
  usageReporting: "supported",
  // Native subagents are disabled at spawn; any that appear anyway are reported as activity only.
  childAgentTracking: "unsupported",
};

const NOTE_MAX = 140;
const DEFAULT_GRACE_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
/** After a non-retrying error notification, how long to wait for turn/completed before failing. */
const ERROR_SETTLE_MS = 5_000;
/** After closing stdin at the end of a run, how long before the process group is force-killed. */
const EXIT_GRACE_MS = 3_000;
/** How many ended attempt ids are remembered, so a late note is answered "the run had finished". */
const ENDED_MAX = 500;

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface CodexAdapterOptions {
  /** Path to the Codex CLI. Default: ./node_modules/.bin/codex, falling back to `codex` on PATH. A .js/.mjs path is run with this Node. */
  codexPath?: string;
  /** Environment for Codex processes. Default: this process's environment (so existing Codex auth works). */
  env?: NodeJS.ProcessEnv;
  /** How long an interrupt may take to be confirmed before the process is killed. Default 15s. */
  interruptGraceMs?: number;
  /** Timeout for health()/listModels() probes. Default 10s. */
  probeTimeoutMs?: number;
  spawn?: SpawnFn;
  log?: (msg: string) => void;
}

interface Run {
  a: Assignment;
  child: ChildProcess;
  rpc: JsonRpcConnection;
  threadId?: string;
  turnId?: string;
  model?: string;
  lastAgentText?: string;
  finalAnswerText?: string;
  usage?: Usage;
  interruptRequested: boolean;
  lastError?: string;
  stderrTail: string;
  done: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** ORC-022: ids of notes whose turn/steer is still unanswered. */
  notes: Set<string>;
}

function defaultCodexPath() {
  const local = resolve(process.cwd(), "node_modules/.bin/codex");
  return existsSync(local) ? local : "codex";
}

function truncate(s: string, max = NOTE_MAX) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

// Redaction is shared with the service's other child processes (see ../redact.ts).
export { redact };

function looksLikeAuthProblem(text: string) {
  return /unauthori[sz]ed|\b401\b|not logged in|not signed in|login required|authentication|invalid api key|api key/i.test(text);
}

function describeTurnError(err: TurnError | null | undefined): string | undefined {
  if (!err) return undefined;
  const info = err.codexErrorInfo;
  const msg = truncate(err.message || "unknown error", 300);
  if (info === "unauthorized" || looksLikeAuthProblem(err.message ?? "")) return `${LOGIN_GUIDANCE} (Codex said: ${msg})`;
  if (info === "usageLimitExceeded") return `The Codex account's usage limit was reached. (${msg})`;
  if (info === "rateLimitExceeded" || info === "serverOverloaded") return `Codex is rate limited or overloaded; retry later. (${msg})`;
  if (info === "contextWindowExceeded") return `The Codex context window was exceeded. (${msg})`;
  return `Codex turn failed: ${msg}`;
}

export class CodexAdapter implements RuntimeAdapter {
  readonly provider: ProviderId = "codex";
  readonly capabilities = CAPABILITIES;

  private readonly codexPath: string;
  /** MCP servers still enabled in the user's config after feature disables; null = not verified. */
  private configuredMcp: Connection[] | null = null;
  private isolationError = "Worker isolation has not been verified yet (no health check has run).";
  private readonly command: string;
  private readonly prefixArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly graceMs: number;
  private readonly probeTimeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly log: (msg: string) => void;
  private version: string;
  private readonly runs = new Map<string, Run>();
  /** Attempts that have ended (bounded), so a late note is answered "the run had finished", not "no such run". */
  private readonly ended = new Set<string>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  /** Short-lived probe processes (health, model list) still alive. */
  private readonly probes = new Set<ChildProcess>();

  constructor(opts: CodexAdapterOptions = {}) {
    this.codexPath = opts.codexPath ?? defaultCodexPath();
    this.env = opts.env ?? process.env;
    this.graceMs = opts.interruptGraceMs ?? DEFAULT_GRACE_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.log = opts.log ?? (() => {});
    let real = this.codexPath;
    try {
      real = realpathSync(this.codexPath);
    } catch {
      /* not a local path (e.g. "codex" on PATH) */
    }
    if (/\.(mjs|cjs|js)$/.test(real)) {
      this.command = process.execPath;
      this.prefixArgs = [real];
    } else {
      this.command = this.codexPath;
      this.prefixArgs = [];
    }
    this.version = PINNED_CODEX_VERSION;
    try {
      const pkg = JSON.parse(readFileSync(resolve(dirname(real), "../package.json"), "utf8"));
      if (pkg?.name === "@openai/codex" && typeof pkg.version === "string") this.version = pkg.version;
    } catch {
      /* keep the pinned version until health() reports the real one */
    }
  }

  get label() {
    return `Codex app-server ${this.version}`;
  }

  onEvent(listener: (e: AdapterEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  has(attemptId: string) {
    return this.runs.has(attemptId);
  }

  ids() {
    return [...this.runs.keys()];
  }

  // ---------------------------------------------------------------- runs

  start(a: Assignment): void {
    if (this.runs.has(a.attemptId)) return;
    let child: ChildProcess;
    try {
      // Isolation fails closed: an isolated run never starts unless the user's MCP servers are known.
      if (a.environment !== "local" && !this.configuredMcp) throw new Error(this.isolationError);
      child = this.spawnProcess(this.appServerArgs(a), false, { TMPDIR: runTmpDir(a), TMP: runTmpDir(a), TEMP: runTmpDir(a) });
    } catch (e) {
      // Keep the contract asynchronous: register, then fail on the next tick.
      const placeholder = { a, done: false, timers: new Set(), notes: new Set() } as unknown as Run;
      this.runs.set(a.attemptId, placeholder);
      setImmediate(() => this.finish(placeholder, { type: "failed", attemptId: a.attemptId, message: this.spawnFailure(e) }));
      return;
    }
    const run: Run = {
      a,
      child,
      rpc: undefined as unknown as JsonRpcConnection,
      interruptRequested: false,
      stderrTail: "",
      done: false,
      timers: new Set(),
      notes: new Set(),
    };
    run.rpc = new JsonRpcConnection(child.stdout!, child.stdin!, {
      onNotification: (n) => this.onNotification(run, n),
      onServerRequest: (r) => this.onServerRequest(run, r),
      onGarbage: () => this.log(`codex[${a.attemptId}]: ignored a non-protocol line on stdout`),
    });
    this.runs.set(a.attemptId, run);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      run.stderrTail = (run.stderrTail + d).slice(-2000);
    });
    child.on("error", (e) => this.finish(run, { type: "failed", attemptId: a.attemptId, message: this.spawnFailure(e), usage: run.usage }));
    let exited = false;
    const onGone = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      run.rpc.close();
      if (run.done) return;
      this.finish(run, { type: "failed", attemptId: a.attemptId, message: this.exitFailure(run, code, signal), usage: run.usage });
    };
    // "close" waits for stdio to drain (so stderr is complete); "exit" plus a short delay covers a
    // grandchild that keeps a pipe open.
    child.on("close", onGone);
    child.on("exit", (code, signal) => this.timer(run, () => onGone(code, signal), 250));

    if (Number.isFinite(a.limits.timeoutMs) && a.limits.timeoutMs > 0) {
      this.timer(run, () => {
        if (run.done) return;
        this.emit({ type: "activity", attemptId: a.attemptId, note: "Time limit reached" });
        this.interrupt(a.attemptId);
      }, a.limits.timeoutMs);
    }

    void this.drive(run);
  }

  private async drive(run: Run) {
    const { a, rpc } = run;
    try {
      await rpc.request("initialize", this.initializeParams());
      rpc.notify("initialized");
      if (run.done) return;

      const threadParams: ThreadStartParams = {
        model: a.model,
        cwd: a.workspace.path,
        approvalPolicy: "never",
        sandbox: a.workspace.access === "write" ? "workspace-write" : "read-only",
      };
      const thread = await rpc.request("thread/start", threadParams);
      if (run.done) return;
      run.threadId = thread.thread.id;
      run.model = thread.model || thread.thread.model || undefined;
      this.emit({ type: "started", attemptId: a.attemptId, sessionId: run.threadId, model: run.model });

      const sandboxPolicy: SandboxPolicy =
        a.workspace.access === "write"
          ? // Writable: the worktree and this run's private temp directory only. System temp directories
            // are shared with other runs and the service, so they are excluded.
            { type: "workspaceWrite", writableRoots: [a.workspace.path, runTmpDir(a)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: "readOnly", networkAccess: false };
      const turnParams: TurnStartParams = {
        threadId: run.threadId,
        input: [{ type: "text", text: a.prompt, text_elements: [] }],
        cwd: a.workspace.path,
        approvalPolicy: "never",
        sandboxPolicy,
      };
      const turn = await rpc.request("turn/start", turnParams);
      if (run.done) return;
      run.turnId ??= turn.turn.id;
    } catch (e) {
      if (run.done) return;
      // A closed connection means the process went away; the exit handler reports it with stderr.
      if (e instanceof RpcClosedError) return;
      this.finish(run, { type: "failed", attemptId: a.attemptId, message: this.requestFailure(e), usage: run.usage });
    }
  }

  /**
   * ORC-022: steer the run's live turn with the note (`turn/steer`, pinned to this run's thread and turn by
   * `expectedTurnId`, so it can never land in another turn). The app-server's answer is the outcome: a
   * response is delivered, an error (no active turn, turn mismatch, a non-steerable review or compact turn)
   * is not-delivered with its message. Exactly one "note" event follows, also when the run is not live.
   */
  note(attemptId: string, note: { id: string; text: string }): void {
    const settle = (outcome: "delivered" | "not-delivered", reason?: string) =>
      this.emit({ type: "note", attemptId, noteId: note.id, outcome, ...(reason !== undefined && { reason }) });
    const run = this.runs.get(attemptId);
    if (!run || run.done) return void queueMicrotask(() => settle("not-delivered", this.ended.has(attemptId) ? "the run had finished" : "no such run"));
    if (run.interruptRequested) return void queueMicrotask(() => settle("not-delivered", "the run is stopping"));
    if (!run.threadId || !run.turnId || !run.rpc || run.rpc.isClosed) return void queueMicrotask(() => settle("not-delivered", "the run has no active turn yet"));
    const params: TurnSteerParams = {
      threadId: run.threadId,
      expectedTurnId: run.turnId,
      input: [{ type: "text", text: note.text, text_elements: [] }],
    };
    run.notes.add(note.id);
    run.rpc.request("turn/steer", params).then(
      (res) => {
        if (!run.notes.delete(note.id)) return; // settled already (the run ended first)
        const steered = res?.turnId;
        if (steered !== undefined && steered !== run.turnId) return settle("not-delivered", `Codex steered turn ${steered}, not this run's turn`);
        settle("delivered");
      },
      (e: unknown) => {
        if (!run.notes.delete(note.id)) return;
        settle("not-delivered", this.noteFailure(e));
      },
    );
  }

  private noteFailure(e: unknown) {
    if (e instanceof RpcError) return `Codex refused the note: ${truncate(this.clean(e.message), 300)}`;
    if (e instanceof RpcClosedError) return "the run had finished";
    return truncate(`Codex app-server error: ${this.clean(e instanceof Error ? e.message : String(e))}`, 300);
  }

  /** ORC-022: report every note still awaiting the app-server's answer as not delivered. */
  private settleNotes(run: Run, reason: string) {
    for (const noteId of run.notes) {
      run.notes.delete(noteId);
      this.emit({ type: "note", attemptId: run.a.attemptId, noteId, outcome: "not-delivered", reason });
    }
  }

  private remember(attemptId: string) {
    this.ended.add(attemptId);
    for (const id of this.ended) {
      if (this.ended.size <= ENDED_MAX) break;
      this.ended.delete(id);
    }
  }

  interrupt(attemptId: string): void {
    const run = this.runs.get(attemptId);
    if (!run || run.done || run.interruptRequested) return;
    run.interruptRequested = true;
    if (!run.turnId || !run.threadId || !run.rpc || run.rpc.isClosed) {
      // Nothing to interrupt gracefully yet: stop the process outright.
      this.forceStop(run);
      return;
    }
    run.rpc.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch(() => {
      /* e.g. the turn already finished; its turn/completed decides the outcome */
    });
    this.timer(run, () => {
      if (run.done) return;
      this.log(`codex[${attemptId}]: interrupt not confirmed within ${this.graceMs}ms; killing`);
      this.forceStop(run);
    }, this.graceMs);
  }

  kill(attemptId: string): void {
    const run = this.runs.get(attemptId);
    if (!run) return;
    run.done = true;
    this.runs.delete(attemptId);
    this.clearTimers(run);
    // Forgotten silently, notes included (the service reconciles notes left "sending" when it restarts).
    run.notes.clear();
    this.remember(attemptId);
    if (run.child) {
      killGroup(run.child, "SIGKILL");
      run.rpc?.close();
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runs.keys()]) this.kill(id);
    for (const c of this.probes) killGroup(c, "SIGKILL");
  }

  private forceStop(run: Run) {
    if (run.child) killGroup(run.child, "SIGKILL");
    this.finish(run, { type: "stopped", attemptId: run.a.attemptId, how: "killed", usage: run.usage }, false);
  }

  /** Emit the single terminal event, forget the run, and end its process. */
  private finish(run: Run, e: AdapterEvent, gentle = true) {
    if (run.done) return;
    run.done = true;
    this.clearTimers(run);
    if (this.runs.get(run.a.attemptId) === run) this.runs.delete(run.a.attemptId);
    // Notes the app-server has not answered settle first: the run is over, so they were not delivered.
    this.settleNotes(run, e.type === "completed" ? "the turn completed before Codex answered" : e.type === "stopped" ? "the run was stopped first" : "the run failed first");
    this.remember(run.a.attemptId);
    this.emit(e);
    if (!run.child) return;
    if (gentle) {
      // The app-server exits on stdin EOF (verified on 0.159.2); force-kill if it lingers.
      try {
        run.child.stdin?.end();
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => killGroup(run.child, "SIGKILL"), EXIT_GRACE_MS);
      t.unref();
    } else killGroup(run.child, "SIGKILL");
    run.rpc?.close();
  }

  private onNotification(run: Run, n: ServerNotification) {
    if (run.done) return;
    const id = run.a.attemptId;
    switch (n.method) {
      case "turn/started":
        if (!run.threadId || n.params.threadId === run.threadId) run.turnId ??= n.params.turn.id;
        return;
      case "item/completed": {
        if (run.turnId && n.params.turnId !== run.turnId) return;
        this.onItem(run, n.params.item);
        return;
      }
      case "thread/tokenUsage/updated": {
        const t = n.params.tokenUsage.total;
        run.usage = { inputTokens: t.inputTokens, outputTokens: t.outputTokens };
        return;
      }
      case "model/rerouted":
        run.model = n.params.toModel;
        this.emit({ type: "activity", attemptId: id, note: truncate(`Codex rerouted the model to ${n.params.toModel}`) });
        return;
      case "error": {
        const msg = describeTurnError(n.params.error) ?? "Codex reported an error";
        if (n.params.willRetry) {
          this.emit({ type: "activity", attemptId: id, note: truncate(`Codex is retrying after an error: ${this.clean(n.params.error.message)}`) });
          return;
        }
        run.lastError = this.clean(msg);
        this.timer(run, () => {
          this.finish(run, { type: "failed", attemptId: id, message: run.lastError!, usage: run.usage });
        }, ERROR_SETTLE_MS);
        return;
      }
      case "turn/completed": {
        const { turn } = n.params;
        if (run.threadId && n.params.threadId !== run.threadId) return;
        if (run.turnId && turn.id !== run.turnId) return;
        if (turn.status === "completed") {
          const fromItems = [...turn.items].reverse().find((i): i is Extract<ThreadItem, { type: "agentMessage" }> => i.type === "agentMessage");
          const finalText = run.finalAnswerText ?? run.lastAgentText ?? fromItems?.text ?? "";
          this.finish(run, { type: "completed", attemptId: id, finalText, usage: run.usage, model: run.model });
        } else if (turn.status === "interrupted") {
          if (run.interruptRequested) this.finish(run, { type: "stopped", attemptId: id, how: "interrupted", usage: run.usage });
          else this.finish(run, { type: "failed", attemptId: id, message: "Codex interrupted the turn without being asked to.", usage: run.usage });
        } else if (turn.status === "failed") {
          const message = this.clean(describeTurnError(turn.error) ?? run.lastError ?? "Codex turn failed without an error message.");
          this.finish(run, { type: "failed", attemptId: id, message, usage: run.usage });
        }
        return;
      }
      default:
        return;
    }
  }

  private onItem(run: Run, item: ThreadItem) {
    const id = run.a.attemptId;
    const note = (s: string) => this.emit({ type: "activity", attemptId: id, note: truncate(this.clean(s)) });
    switch (item.type) {
      case "agentMessage":
        run.lastAgentText = item.text;
        if (item.phase === "final_answer") run.finalAnswerText = item.text;
        if (item.text.trim()) note(`Message: ${item.text}`);
        return;
      case "commandExecution": {
        const status = item.status === "completed" && item.exitCode !== null ? `exit ${item.exitCode}` : item.status;
        note(`Ran \`${item.command}\` (${status})`);
        return;
      }
      case "fileChange": {
        const paths = item.changes.map((c) => {
          const rel = relative(run.a.workspace.path, c.path);
          return rel && !rel.startsWith("..") ? rel : c.path;
        });
        note(`${item.status === "completed" ? "Changed" : `File change ${item.status}:`} ${paths.join(", ") || "(no files)"}`);
        return;
      }
      case "mcpToolCall":
        note(`Tool ${item.server}/${item.tool} (${item.status})`);
        return;
      case "webSearch":
        note("Web search");
        return;
      case "collabAgentToolCall":
      case "subAgentActivity":
        note("Native Codex subagent activity observed (not tracked by Orchestrator)");
        return;
      default:
        return;
    }
  }

  /** Approvals should not arrive with approval policy "never"; decline anything that does. */
  private onServerRequest(run: Run, r: ServerRequest) {
    const note = () =>
      !run.done && this.emit({ type: "activity", attemptId: run.a.attemptId, note: truncate(`Declined a Codex request (${r.method})`) });
    switch (r.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        run.rpc.respond(r.id, { decision: "decline" });
        note();
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        run.rpc.respond(r.id, { decision: { denied: { rejection: "Orchestrator runs unattended; approvals are declined." } } });
        note();
        return;
      case "item/permissions/requestApproval":
        run.rpc.respond(r.id, { permissions: {}, scope: "turn" });
        note();
        return;
      case "item/tool/requestUserInput":
        run.rpc.respond(r.id, { answers: {} });
        note();
        return;
      case "mcpServer/elicitation/request":
        run.rpc.respond(r.id, { action: "decline", content: null, _meta: null });
        note();
        return;
      case "item/tool/call":
        run.rpc.respond(r.id, { contentItems: [], success: false });
        note();
        return;
      default:
        run.rpc.respondError(r.id, -32601, `Orchestrator does not handle ${r.method}`);
        note();
    }
  }

  // ---------------------------------------------------------------- probes

  async health(): Promise<ProviderHealth> {
    const checkedAt = () => new Date().toISOString();
    try {
      const v = await this.probeVersion();
      if (!v.ok) return { status: "unavailable", detail: v.detail, checkedAt: checkedAt() };
      if (v.version) this.version = v.version;
      const iso = await this.refreshIsolation();
      const isolationNote = iso.ok ? "" : ` Isolated runs are blocked: ${iso.detail}`;
      let account: GetAccountResponse;
      try {
        account = await this.withAppServer((rpc) => rpc.request("account/read", { refreshToken: false }));
      } catch (e) {
        const msg = this.clean(e instanceof Error ? e.message : String(e));
        return { status: "unavailable", detail: truncate(`Codex CLI ${this.version} is installed but its app-server did not answer: ${msg}`, 300), checkedAt: checkedAt() };
      }
      if (account.account) {
        const how = account.account.type === "chatgpt" ? "ChatGPT login" : account.account.type === "apiKey" ? "API key" : "Amazon Bedrock";
        return { status: "ready", detail: `Codex CLI ${this.version} is signed in (${how}).${isolationNote}`, checkedAt: checkedAt() };
      }
      if (!account.requiresOpenaiAuth) {
        return { status: "ready", detail: `Codex CLI ${this.version} uses a model provider that needs no OpenAI sign-in.${isolationNote}`, checkedAt: checkedAt() };
      }
      const envKey = !!(this.env.OPENAI_API_KEY || this.env.CODEX_API_KEY);
      const detail = envKey
        ? "Codex is not signed in. An API key is set in the environment, but Codex does not report it as a login; run `printenv OPENAI_API_KEY | npx codex login --with-api-key` (or `npx codex login`) and restart the service."
        : LOGIN_GUIDANCE;
      return { status: "not-configured", detail, checkedAt: checkedAt() };
    } catch (e) {
      return { status: "unavailable", detail: truncate(`Codex health check failed: ${this.clean(String(e))}`, 300), checkedAt: checkedAt() };
    }
  }

  async listModels(): Promise<CatalogModel[] | null> {
    try {
      return await this.withAppServer(async (rpc) => {
        const out: CatalogModel[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
          const res: ModelListResponse = await rpc.request("model/list", { cursor });
          for (const m of res.data) {
            if (m.hidden) continue;
            // `model` is the slug thread/start accepts; `id` is the preset id (identical in practice).
            const id = m.model || m.id;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, label: m.displayName || id });
          }
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        return out;
      });
    } catch (e) {
      this.log(`codex: model/list failed: ${this.clean(e instanceof Error ? e.message : String(e))}`);
      return null;
    }
  }

  private async probeVersion(): Promise<{ ok: true; version?: string } | { ok: false; detail: string }> {
    return new Promise((done) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(["--version"], true);
      } catch (e) {
        done({ ok: false, detail: this.spawnFailure(e) });
        return;
      }
      let out = "";
      let settled = false;
      const settle = (r: { ok: true; version?: string } | { ok: false; detail: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        killGroup(child, "SIGKILL");
        done(r);
      };
      const t = setTimeout(() => settle({ ok: false, detail: `Codex CLI at ${this.codexPath} did not answer --version within ${Math.round(this.probeTimeoutMs / 1000)}s.` }), this.probeTimeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => (out += d));
      child.on("error", (e) => settle({ ok: false, detail: this.spawnFailure(e) }));
      child.on("close", (code) => {
        if (code !== 0) settle({ ok: false, detail: `Codex CLI at ${this.codexPath} failed to run (exit code ${code}). Reinstall with \`npm install\`.` });
        else settle({ ok: true, version: /(\d+\.\d+\.\d+[^\s]*)/.exec(out)?.[1] });
      });
    });
  }

  /** Run `fn` against a short-lived, initialized app-server; always terminates it. */
  private async withAppServer<T>(fn: (rpc: JsonRpcConnection) => Promise<T>): Promise<T> {
    const child = this.spawnProcess(this.appServerArgs(), true);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr = (stderr + d).slice(-1000)));
    const rpc = new JsonRpcConnection(child.stdout!, child.stdin!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failure = new Promise<never>((_, reject) => {
      child.on("error", (e) => reject(new Error(this.spawnFailure(e))));
      child.on("exit", (code) =>
        setTimeout(() => reject(new Error(`app-server exited (code ${code})${stderr.trim() ? `: ${truncate(stderr, 200)}` : ""}`)), 100),
      );
      timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(this.probeTimeoutMs / 1000)}s`)), this.probeTimeoutMs);
    });
    failure.catch(() => {});
    try {
      return await Promise.race([
        (async () => {
          await rpc.request("initialize", this.initializeParams());
          rpc.notify("initialized");
          return fn(rpc);
        })(),
        failure,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      rpc.close();
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      killGroup(child, "SIGKILL");
    }
  }

  // ---------------------------------------------------------------- helpers

  private spawnProcess(args: string[], probe = false, extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
    const child = this.spawnFn(this.command, [...this.prefixArgs, ...args], {
      // Codex processes never receive GitHub tokens: only the service talks to GitHub.
      env: { ...withoutGitHubTokens(this.env), ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so a kill reaches the native binary behind the npm wrapper.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    trackLive(child);
    if (probe) {
      this.probes.add(child);
      child.once("exit", () => this.probes.delete(child));
      child.once("error", () => this.probes.delete(child));
    }
    return child;
  }

  /**
   * App-server arguments. Native sub-agents are always off. Isolated (the default, and all probes):
   * the user's plugins/apps/computer use/memories/web search are off and every MCP server except the
   * run's allowed connections is disabled. Local: the user's own Codex setup applies.
   */
  private appServerArgs(a?: Assignment): string[] {
    if (a?.environment === "local") return [...APP_SERVER_ARGS];
    const allowed = new Set(a?.connections ?? []);
    const disable = (this.configuredMcp ?? []).filter((c) => c.enabled && !allowed.has(c.name)).map((c) => c.name);
    return [...APP_SERVER_ARGS, ...ISOLATION_FEATURE_ARGS, ...ISOLATION_CONFIG_ARGS, ...mcpDisableArgs(disable)];
  }

  /** MCP servers configured for Codex (plugin-provided servers excluded: plugins stay off when isolated). */
  async listConnections(): Promise<Connection[] | null> {
    // Reuse the list the last health check verified, so the UI and the isolation arguments agree.
    if (!this.configuredMcp) await this.refreshIsolation();
    return this.configuredMcp ? structuredClone(this.configuredMcp) : null;
  }

  /**
   * Find the MCP servers still enabled after the feature disables and prepare per-server overrides.
   * Fails closed: if the list cannot be read, the caller reports Codex as unavailable rather than
   * start workers that might inherit the user's MCP servers.
   */
  private async refreshIsolation(): Promise<{ ok: true } | { ok: false; detail: string }> {
    const r = await this.capture([...ISOLATION_FEATURE_ARGS, "mcp", "list", "--json"]);
    if (!r.ok) {
      this.configuredMcp = null;
      this.isolationError = `Could not verify worker isolation (reading Codex MCP servers failed: ${r.detail}).`;
      return { ok: false, detail: this.isolationError };
    }
    try {
      const list = JSON.parse(r.out) as { name: string; enabled: boolean }[];
      this.configuredMcp = list.map((x) => ({ name: String(x.name), enabled: !!x.enabled }));
      return { ok: true };
    } catch {
      this.configuredMcp = null;
      this.isolationError = "Could not verify worker isolation (unexpected `codex mcp list --json` output).";
      return { ok: false, detail: this.isolationError };
    }
  }

  /** Run the CLI with arguments and capture stdout (bounded by the probe timeout). */
  private capture(args: string[]): Promise<{ ok: true; out: string } | { ok: false; detail: string }> {
    return new Promise((done) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(args, true);
      } catch (e) {
        done({ ok: false, detail: this.spawnFailure(e) });
        return;
      }
      let out = "";
      let settled = false;
      const settle = (r: { ok: true; out: string } | { ok: false; detail: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        killGroup(child, "SIGKILL");
        done(r);
      };
      const t = setTimeout(() => settle({ ok: false, detail: `no answer within ${Math.round(this.probeTimeoutMs / 1000)}s` }), this.probeTimeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => (out += d));
      child.on("error", (e) => settle({ ok: false, detail: this.spawnFailure(e) }));
      child.on("close", (code) => (code === 0 ? settle({ ok: true, out }) : settle({ ok: false, detail: `exit code ${code}` })));
    });
  }

  private initializeParams(): InitializeParams {
    return { clientInfo: { name: "orchestration", title: "Orchestrator", version: "0.1.0" }, capabilities: null };
  }

  private spawnFailure(e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return `Codex CLI not found at ${this.codexPath}. Run \`npm install\` in the Orchestrator directory.`;
    return truncate(`Could not start the Codex CLI at ${this.codexPath}: ${this.clean(e instanceof Error ? e.message : String(e))}`, 300);
  }

  private requestFailure(e: unknown) {
    if (e instanceof RpcError) {
      const msg = truncate(this.clean(e.message), 300);
      if (looksLikeAuthProblem(e.message)) return `${LOGIN_GUIDANCE} (Codex said: ${msg})`;
      return `Codex rejected ${e.method}: ${msg}`;
    }
    return truncate(`Codex app-server error: ${this.clean(e instanceof Error ? e.message : String(e))}`, 300);
  }

  private exitFailure(run: Run, code: number | null, signal: NodeJS.Signals | null) {
    const tail = this.clean(run.stderrTail.trim().split("\n").slice(-3).join(" "));
    if (looksLikeAuthProblem(tail) || (run.lastError && looksLikeAuthProblem(run.lastError))) return LOGIN_GUIDANCE;
    if (run.lastError) return run.lastError;
    const how = signal ? `signal ${signal}` : `exit code ${code}`;
    return truncate(`Codex app-server exited unexpectedly (${how})${tail ? `: ${tail}` : "."}`, 300);
  }

  private clean(s: string) {
    return redact(s, this.env);
  }

  private timer(run: Run, fn: () => void, ms: number) {
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

  private emit(e: AdapterEvent) {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        this.log(`codex: event listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
