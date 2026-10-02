// Claude runtime adapter, built on the pinned @anthropic-ai/claude-agent-sdk.
//
// One `query()` per attempt with streaming input: the assignment envelope is the first
// message of an input stream that stays open while the run lasts, and notes are pushed onto it as
// user messages. The adapter never touches the store: it turns the SDK message stream into
// AdapterEvents. Every option used here was checked against the installed sdk.d.ts of the pinned
// version (the streaming and note fields against 0.3.285).
//
// Worktree containment is enforced twice, independently:
//   1. a PreToolUse hook, which the CLI runs before EVERY tool call regardless of permission mode, and
//   2. `canUseTool`, which answers every permission prompt (permissionMode "default" prompts for edits
//      and for reads outside the working directory).
// Both apply the same guard: the tool must be on the role's allowlist, and every path argument must
// resolve (following symlinks, including through not-yet-existing parents) inside the worktree.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CatalogModel } from "../../src/domain/types";
import { truncate as oneLine } from "../../src/domain/text";
import type { CapabilityMap } from "../../src/runtime/adapter";
import { homedir } from "node:os";
import { withoutGitHubTokens } from "../redact";
import type { AdapterEvent, Assignment, Connection, ProviderHealth, RuntimeAdapter, Usage } from "./types";

// ---------------------------------------------------------------------------------------------
// Public types and constants

/** The handle a query returns: an async stream of SDK messages plus the control methods we use. */
interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  interrupt?: () => Promise<unknown>;
}

/** Signature-compatible with the SDK's `query` (narrowed to the streaming-input form we use). */
export type ClaudeQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQueryHandle;

export interface ClaudeAdapterOptions {
  /** Replacement for the SDK's `query` (tests). When omitted, the SDK is imported lazily on first use. */
  query?: ClaudeQueryFn;
  /** Replacement for the lazy SDK import (tests: simulate a missing SDK). */
  loadSdk?: () => Promise<{ query: ClaudeQueryFn }>;
  /** Environment for credential detection and the child process. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** How long an interrupt may take to be confirmed before the process is aborted. Default 15000. */
  interruptGraceMs?: number;
  /** After an abort, how long to wait for the stream to settle before reporting "killed" anyway. Default 5000. */
  killSettleMs?: number;
  /**
   * After a turn ends with a note still unacknowledged, how long to wait for the next turn to
   * acknowledge it before the note is reported not-delivered and the run completes. Default 90000.
   */
  noteAckGraceMs?: number;
  /** Adds Bash for write access. Off by default: shell commands cannot be path-contained. */
  allowShell?: boolean;
  /** Where the user's Claude Code MCP servers are configured. Default: ~/.claude.json. */
  claudeConfigPath?: string;
  log?: (msg: string) => void;
}

/** MCP tool names are `mcp__<server>__<tool>`; the server part is normalized by Claude Code. */
function mcpServerOf(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(toolName);
  return m?.[1];
}
const normalizeServer = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

export const CLAUDE_AUTH_MESSAGE =
  "Claude could not sign in. Set ANTHROPIC_API_KEY (or Bedrock, Vertex, or Foundry credentials), or opt in to your own subscription token with ORCHESTRATION_CLAUDE_AUTH=subscription and CLAUDE_CODE_OAUTH_TOKEN (see the README), then restart the service.";

/**
 * Opt-in: the user's own Claude subscription token (`claude setup-token`) for their personal use.
 * Anthropic's Agent SDK docs say third-party apps may not offer claude.ai login unless approved, so
 * this is never a default: it needs both variables, and Settings quotes the rule when it is on.
 */
const CLAUDE_AUTH_SWITCH = "ORCHESTRATION_CLAUDE_AUTH";
const CLAUDE_SUBSCRIPTION_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
const ANTHROPIC_RULE =
  "Anthropic's Agent SDK docs say tools built on it may not offer claude.ai login unless Anthropic approved it; using your own token here is your decision.";

function claudeAuthMode(env: NodeJS.ProcessEnv): "subscription" | "default" {
  return env[CLAUDE_AUTH_SWITCH]?.trim().toLowerCase() === "subscription" ? "subscription" : "default";
}

/**
 * The environment a Claude worker or lead run receives. Exactly one way of signing in is passed on:
 * in subscription mode the token (API key and cloud-provider flags removed), otherwise everything
 * except the token, so a token set for other scripts is never used by accident. GitHub tokens are
 * always removed: only the service talks to GitHub.
 */
export function claudeWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = withoutGitHubTokens(env);
  if (claudeAuthMode(env) === "subscription") {
    delete out.ANTHROPIC_API_KEY;
    delete out.ANTHROPIC_AUTH_TOKEN;
    for (const [flag] of CLOUD_PROVIDER_FLAGS) delete out[flag];
  } else delete out[CLAUDE_SUBSCRIPTION_TOKEN];
  return out;
}

const CLAUDE_MODEL_ALIASES: CatalogModel[] = [
  { id: "sonnet", label: "Claude Sonnet (latest alias)" },
  { id: "opus", label: "Claude Opus (latest alias)" },
  { id: "haiku", label: "Claude Haiku (latest alias)" },
];

const CLAUDE_CAPABILITIES: CapabilityMap = {
  start: "supported",
  streamEvents: "supported",
  // Notes go onto the input stream and count as delivered only on the CLI's uuid acknowledgment; verified against a
  // real model run (ORC-027, docs/real-runs/2026-10-02T02-22-16-079Z.json: acknowledged live in 7.7 s, report followed it).
  steer: "supported",
  // Confirmed by the message stream ending after interrupt(); falls back to aborting the process.
  interrupt: "supported",
  resume: "unverified",
  usageReporting: "supported",
  // Native subagents are disabled (Agent/Task tool disallowed, built-in agents off).
  childAgentTracking: "unsupported",
};

const READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const WRITE_TOOLS = ["Write", "Edit"] as const;
/** Always removed from the model's context. "Agent" is the subagent tool; "Task" is its legacy name. */
const ALWAYS_DISALLOWED = ["Agent", "Task", "WebFetch", "WebSearch", "NotebookEdit"];
const FILE_PATH_TOOLS = new Set(["Read", "Write", "Edit"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
const MUTATING_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** Environment variables that select a cloud provider instead of an Anthropic API key. */
const CLOUD_PROVIDER_FLAGS: Array<[string, string]> = [
  ["CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"],
  ["CLAUDE_CODE_USE_VERTEX", "Google Vertex AI"],
  ["CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry"],
  ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "Claude Platform on AWS"],
];

const ACTIVITY_MAX = 140;
/** How many ended attempt ids are remembered, so a late note is answered "the run had finished". */
const ENDED_MAX = 500;

// ---------------------------------------------------------------------------------------------
// Tool policy and workspace guard (exported for tests)

interface ToolPolicy {
  /** Base set of built-in tools (`Options.tools`). */
  tools: string[];
  /** Removed from the model's context even if something else would enable them (`Options.disallowedTools`). */
  disallowedTools: string[];
}

export function toolPolicy(access: "read" | "write", allowShell = false): ToolPolicy {
  const tools: string[] = [...READ_TOOLS];
  if (access === "write") {
    tools.push(...WRITE_TOOLS);
    if (allowShell) tools.push("Bash");
  }
  const disallowedTools = [...ALWAYS_DISALLOWED];
  if (access === "read") disallowedTools.push(...WRITE_TOOLS);
  if (!tools.includes("Bash")) disallowedTools.push("Bash");
  return { tools, disallowedTools };
}

type GuardVerdict = { ok: true } | { ok: false; reason: string };

function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** realpath of the nearest existing ancestor, with the missing tail re-appended (for new files). */
function realpathNearest(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * The containment guard shared by the PreToolUse hook and canUseTool. `workspace` is the worktree
 * path as given; it is resolved with realpath so symlinked parents (e.g. /tmp on macOS) compare correctly.
 */
export function createWorkspaceGuard(workspace: string, allowedTools: readonly string[], mcp: "any" | readonly string[] = []) {
  const mcpAllowed = mcp === "any" ? "any" : new Set(mcp.map(normalizeServer));
  const root = path.resolve(workspace);
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    realRoot = root;
  }
  const allowed = new Set(allowedTools);

  const checkPath = (raw: unknown, mutating: boolean): GuardVerdict => {
    if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "Missing path argument." };
    if (raw.includes("\0")) return { ok: false, reason: "Invalid path." };
    const lexical = path.resolve(root, raw);
    // Lexical check first (catches ../ escapes even when the target does not exist) ...
    if (!isInside(lexical, root) && !isInside(lexical, realRoot)) {
      return { ok: false, reason: `Path is outside this assignment's worktree: ${raw}` };
    }
    // ... then the real location, which catches symlinks inside the worktree pointing out of it.
    const real = realpathNearest(lexical);
    if (!isInside(real, realRoot)) {
      return { ok: false, reason: `Path resolves outside this assignment's worktree (symlink): ${raw}` };
    }
    if (mutating) {
      // Any `.git` component, compared case-insensitively (macOS and Windows file systems ignore case):
      // git metadata is what the service's own git calls read, so agents must never write it.
      const parts = [...path.relative(root, lexical).split(/[\\/]/), ...path.relative(realRoot, real).split(/[\\/]/)];
      if (parts.some((p) => p.toLowerCase() === ".git")) return { ok: false, reason: "Writing to .git is not permitted." };
    }
    return { ok: true };
  };

  return function guard(toolName: string, input: unknown): GuardVerdict {
    // Connections (MCP tools) act on external services, not the worktree; only allowed servers pass.
    const server = mcpServerOf(toolName);
    if (server !== undefined) {
      if (mcpAllowed === "any" || mcpAllowed.has(normalizeServer(server))) return { ok: true };
      return { ok: false, reason: `Connection "${server}" is not allowed for this assignment.` };
    }
    if (!allowed.has(toolName)) {
      return { ok: false, reason: `Tool "${toolName}" is not permitted for this assignment.` };
    }
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const mutating = MUTATING_TOOLS.has(toolName);
    if (FILE_PATH_TOOLS.has(toolName)) return checkPath(args.file_path, mutating);
    if (SEARCH_TOOLS.has(toolName)) {
      if (args.path !== undefined && args.path !== null && args.path !== "") {
        const v = checkPath(args.path, false);
        if (!v.ok) return v;
      }
      if (toolName === "Glob") {
        const pattern = args.pattern;
        if (typeof pattern !== "string") return { ok: false, reason: "Missing glob pattern." };
        if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
          return { ok: false, reason: "Glob patterns must be relative to the worktree and must not contain '..'." };
        }
      }
      return { ok: true };
    }
    // Bash (only when allowShell) cannot be path-checked; cwd is the worktree. Anything else on the
    // allowlist without a known path argument is allowed as-is.
    return { ok: true };
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

const truncate = (s: string, max = ACTIVITY_MAX) => oneLine(s, max);

function redact(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]");
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : "Unknown error";
}

const AUTH_PATTERN =
  /authentication[_ ]?(failed|error)|invalid[ _-]?(x-)?api[ _-]?key|x-api-key|api key|unauthori[sz]ed|not logged in|\/login|oauth_org_not_allowed|cloud_credential_error|credit balance/i;

function isAuthError(text: string): boolean {
  return AUTH_PATTERN.test(text);
}

const AUTH_ASSISTANT_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "cloud_credential_error"]);

function isTruthyFlag(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false" && t !== "no";
}

function sdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const main = require.resolve("@anthropic-ai/claude-agent-sdk");
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(main), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Usage from a result message. Input tokens include cache reads/writes (total input processed). */
function usageFromResult(msg: Rec): Usage {
  const usage: Usage = {};
  const cost = num(msg.total_cost_usd);
  if (cost !== undefined) usage.costUsd = cost;
  const modelUsage = asRec(msg.modelUsage);
  const entries = Object.values(modelUsage).map(asRec);
  if (entries.length > 0) {
    let input = 0;
    let output = 0;
    for (const m of entries) {
      input += (num(m.inputTokens) ?? 0) + (num(m.cacheReadInputTokens) ?? 0) + (num(m.cacheCreationInputTokens) ?? 0);
      output += num(m.outputTokens) ?? 0;
    }
    usage.inputTokens = input;
    usage.outputTokens = output;
  } else {
    const u = asRec(msg.usage);
    const input = num(u.input_tokens);
    if (input !== undefined) {
      usage.inputTokens = input + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
    }
    const output = num(u.output_tokens);
    if (output !== undefined) usage.outputTokens = output;
  }
  return usage;
}

/** Token totals added; the cost is the later figure (total_cost_usd is already cumulative). */
function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const out: Usage = {};
  const input = sum(a.inputTokens, b.inputTokens);
  if (input !== undefined) out.inputTokens = input;
  const output = sum(a.outputTokens, b.outputTokens);
  if (output !== undefined) out.outputTokens = output;
  const cost = b.costUsd ?? a.costUsd;
  if (cost !== undefined) out.costUsd = cost;
  return out;
}

function describeToolUse(name: string, input: Rec, workspace: string): string {
  const rel = (p: unknown) => {
    if (typeof p !== "string") return "?";
    const r = path.relative(workspace, path.resolve(workspace, p));
    return r === "" ? "." : r.startsWith("..") ? p : r;
  };
  switch (name) {
    case "Edit":
      return `Edited ${rel(input.file_path)}`;
    case "Write":
      return `Wrote ${rel(input.file_path)}`;
    case "Read":
      return `Read ${rel(input.file_path)}`;
    case "Glob":
      return `Listed files matching ${String(input.pattern ?? "")}`;
    case "Grep":
      return `Searched for "${String(input.pattern ?? "")}"`;
    case "Bash":
      return `Ran: ${String(input.command ?? "")}`;
    default:
      return `Used ${name}`;
  }
}

/**
 * A query's input stream. The envelope is pushed first and notes follow while the run lasts;
 * the SDK writes each message to the CLI as it arrives and closes the CLI's stdin once the stream ends.
 * The SDK is the only consumer, so one pending reader is enough.
 */
class InputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  closed = false;

  push(msg: SDKUserMessage) {
    if (this.closed) return;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value: msg, done: false });
    } else this.queue.push(msg);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const w = this.waiter;
    this.waiter = undefined;
    w?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const msg = this.queue.shift();
        if (msg) return Promise.resolve({ value: msg, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Adapter

interface Run {
  a: Assignment;
  abort: AbortController;
  handle?: ClaudeQueryHandle;
  /** The query's input; closed on every terminal path so the CLI exits. */
  input: InputStream;
  /** Notes sent and not yet acknowledged, keyed by the uuid they were sent with. */
  notes: Map<string, string>;
  /** The result of the last turn, kept while a note is outstanding; the run completes on it if no acknowledgment comes. */
  lastResult?: Extract<AdapterEvent, { type: "completed" }>;
  /** The CLI's last reported session state (`system/session_state_changed`); undefined if it never reported one. */
  sessionState?: string;
  /** The timer bounding the wait for that acknowledgment. */
  noteWait?: ReturnType<typeof setTimeout>;
  /** Summed per-turn `usage` of earlier turns (the fallback when a result has no modelUsage). */
  priorTurnUsage?: Usage;
  /** A terminal event was emitted (or the run was killed); nothing else may be emitted. */
  terminal: boolean;
  /** kill(): forget silently. */
  forgotten: boolean;
  interruptRequested: boolean;
  /** abort() was called after the grace period. */
  aborting: boolean;
  started: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  sessionId?: string;
  model?: string;
  lastMessageId?: string;
  lastText: string;
  sawAuthError: boolean;
  stderrTail: string;
  done: Promise<void>;
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly provider = "claude" as const;
  readonly label: string;
  readonly capabilities: CapabilityMap = CLAUDE_CAPABILITIES;

  private readonly injectedQuery?: ClaudeQueryFn;
  private readonly loadSdkFn: () => Promise<{ query: ClaudeQueryFn }>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly interruptGraceMs: number;
  private readonly killSettleMs: number;
  private readonly noteAckGraceMs: number;
  /** Whether writers get a shell (off by default). Read by the service for the GitHub posture warning. */
  readonly allowShell: boolean;
  private readonly claudeConfigPath: string;
  private readonly log: (msg: string) => void;
  private readonly runs = new Map<string, Run>();
  /** Attempts that have ended (bounded), so a late note is answered "the run had finished", not "no such run". */
  private readonly ended = new Set<string>();
  private readonly listeners = new Set<(e: AdapterEvent) => void>();
  private sdkPromise?: Promise<{ query: ClaudeQueryFn }>;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.injectedQuery = opts.query;
    this.loadSdkFn =
      opts.loadSdk ??
      (async () => {
        const mod = await import("@anthropic-ai/claude-agent-sdk");
        return { query: mod.query as unknown as ClaudeQueryFn };
      });
    this.env = opts.env ?? process.env;
    this.interruptGraceMs = opts.interruptGraceMs ?? 15000;
    this.killSettleMs = opts.killSettleMs ?? 5000;
    this.noteAckGraceMs = opts.noteAckGraceMs ?? 90_000;
    this.allowShell = opts.allowShell ?? false;
    this.claudeConfigPath = opts.claudeConfigPath ?? path.join(this.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
    this.log = opts.log ?? (() => {});
    this.label = `Claude Agent SDK ${sdkVersion()}`;
  }

  // --- events -------------------------------------------------------------------------------

  onEvent(listener: (e: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitRaw(e: AdapterEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.log(`[claude] event listener threw: ${errorText(err)}`);
      }
    }
  }

  private activity(run: Run, note: string) {
    if (run.terminal || run.forgotten) return;
    this.emitRaw({ type: "activity", attemptId: run.a.attemptId, note: truncate(note) });
  }

  /** Emit the single terminal event for a run. Later calls are ignored. */
  private finish(run: Run, e: AdapterEvent) {
    if (run.terminal || run.forgotten) return;
    run.terminal = true;
    this.clearTimers(run);
    // Notes still outstanding settle first: nothing acknowledged them, so nothing was delivered.
    this.settleNotes(run, e.type === "completed" ? "the run completed before the agent read it" : e.type === "stopped" ? "the run was stopped first" : "the run failed first");
    this.remember(run.a.attemptId);
    this.emitRaw(e);
    run.input.close();
  }

  /** Report every unacknowledged note of a run as not delivered. */
  private settleNotes(run: Run, reason: string) {
    for (const [uuid, noteId] of run.notes) {
      run.notes.delete(uuid);
      this.emitRaw({ type: "note", attemptId: run.a.attemptId, noteId, outcome: "not-delivered", reason });
    }
    this.clearNoteWait(run);
  }

  private remember(attemptId: string) {
    this.ended.add(attemptId);
    for (const id of this.ended) {
      if (this.ended.size <= ENDED_MAX) break;
      this.ended.delete(id);
    }
  }

  private clearTimers(run: Run) {
    for (const t of run.timers) clearTimeout(t);
    run.timers.clear();
    run.noteWait = undefined;
  }

  private clearNoteWait(run: Run) {
    if (!run.noteWait) return;
    clearTimeout(run.noteWait);
    run.timers.delete(run.noteWait);
    run.noteWait = undefined;
  }

  private timer(run: Run, ms: number, fn: () => void) {
    const t = setTimeout(() => {
      run.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    run.timers.add(t);
    return t;
  }

  // --- health / models ----------------------------------------------------------------------

  private loadSdk(): Promise<{ query: ClaudeQueryFn }> {
    if (this.injectedQuery) return Promise.resolve({ query: this.injectedQuery });
    if (!this.sdkPromise) {
      this.sdkPromise = this.loadSdkFn();
      // Allow a retry after a failed import (e.g. dependencies reinstalled).
      this.sdkPromise.catch(() => (this.sdkPromise = undefined));
    }
    return this.sdkPromise;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      try {
        await this.loadSdk();
      } catch (err) {
        return {
          status: "unavailable",
          detail: `The Claude Agent SDK could not be loaded (${truncate(redact(errorText(err)), 160)}). Reinstall dependencies with npm install.`,
          checkedAt,
        };
      }
      if (claudeAuthMode(this.env) === "subscription") {
        if (isTruthyFlag(this.env[CLAUDE_SUBSCRIPTION_TOKEN])) {
          return {
            status: "ready",
            detail: `${this.label} with your own Claude subscription (${CLAUDE_SUBSCRIPTION_TOKEN}; you opted in with ${CLAUDE_AUTH_SWITCH}=subscription). For personal use: runs count against your plan's usage limits, shared with your own Claude Code, and cost figures are estimates you are not billed for. ${ANTHROPIC_RULE} Any API key or cloud setting is not passed to workers. The token is checked on the first run.`,
            checkedAt,
          };
        }
        return {
          status: "not-configured",
          detail: `${CLAUDE_AUTH_SWITCH}=subscription is set, but ${CLAUDE_SUBSCRIPTION_TOKEN} is not. Run \`claude setup-token\`, set ${CLAUDE_SUBSCRIPTION_TOKEN} in the environment the service starts from, and restart it.`,
          checkedAt,
        };
      }
      if (isTruthyFlag(this.env.ANTHROPIC_API_KEY)) {
        return {
          status: "ready",
          detail: `${this.label} with ANTHROPIC_API_KEY. The key is checked on the first run.`,
          checkedAt,
        };
      }
      for (const [flag, name] of CLOUD_PROVIDER_FLAGS) {
        if (isTruthyFlag(this.env[flag])) {
          return {
            status: "ready",
            detail: `${this.label} using ${name} (${flag}). Cloud credentials are checked on the first run.`,
            checkedAt,
          };
        }
      }
      return {
        status: "not-configured",
        detail: isTruthyFlag(this.env[CLAUDE_SUBSCRIPTION_TOKEN])
          ? `${CLAUDE_SUBSCRIPTION_TOKEN} is set but not used. To run Claude on your own subscription (personal use), also set ${CLAUDE_AUTH_SWITCH}=subscription and restart. ${ANTHROPIC_RULE} Otherwise set ANTHROPIC_API_KEY (or Bedrock, Vertex, or Foundry credentials).`
          : `Claude workers need an Anthropic API key: set ANTHROPIC_API_KEY (or enable Bedrock, Vertex, or Foundry credentials) and restart the service. To use your own Claude subscription instead, see the README (opt-in, personal use).`,
        checkedAt,
      };
    } catch (err) {
      return { status: "unavailable", detail: `Claude health check failed: ${truncate(redact(errorText(err)))}`, checkedAt };
    }
  }

  /** User-scope MCP servers from Claude Code's config (names only are reported; configs stay in memory). */
  async listConnections(): Promise<Connection[] | null> {
    const all = this.readMcpConfigs();
    if (!all) return null;
    return Object.keys(all).map((name) => ({ name, enabled: all[name]?.disabled !== true }));
  }

  private readMcpConfigs(): Record<string, Record<string, unknown>> | null {
    const file = this.claudeConfigPath;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
      return j.mcpServers ?? {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      return null;
    }
  }

  private mcpConfigsFor(names: string[]): Record<string, McpServerConfig> {
    if (!names.length) return {};
    const all = this.readMcpConfigs() ?? {};
    const out: Record<string, McpServerConfig> = {};
    for (const n of names) if (all[n]) out[n] = all[n] as unknown as McpServerConfig;
    return out;
  }

  async listModels(): Promise<CatalogModel[] | null> {
    // The SDK's supportedModels() needs a live query (a spawned session), so we use a static alias list.
    return CLAUDE_MODEL_ALIASES.map((m) => ({ ...m }));
  }

  // --- lifecycle ----------------------------------------------------------------------------

  has(attemptId: string): boolean {
    const run = this.runs.get(attemptId);
    return !!run && !run.terminal && !run.forgotten;
  }

  ids(): string[] {
    return [...this.runs.values()].filter((r) => !r.terminal && !r.forgotten).map((r) => r.a.attemptId);
  }

  start(assignment: Assignment): void {
    if (this.runs.has(assignment.attemptId)) return;
    const run: Run = {
      a: assignment,
      abort: new AbortController(),
      terminal: false,
      forgotten: false,
      interruptRequested: false,
      aborting: false,
      started: false,
      timers: new Set(),
      input: new InputStream(),
      notes: new Map(),
      lastText: "",
      sawAuthError: false,
      stderrTail: "",
      done: Promise.resolve(),
    };
    this.runs.set(assignment.attemptId, run);
    // The envelope opens the input stream, shaped as the SDK shapes a string prompt; notes follow it.
    run.input.push({
      type: "user",
      session_id: "",
      message: { role: "user", content: [{ type: "text", text: assignment.prompt }] },
      parent_tool_use_id: null,
    });
    if (assignment.limits.timeoutMs > 0) {
      this.timer(run, assignment.limits.timeoutMs, () => {
        if (run.terminal || run.forgotten || run.interruptRequested) return;
        this.activity(run, "Time limit reached");
        this.interrupt(assignment.attemptId);
      });
    }
    run.done = this.drive(run).finally(() => {
      if (this.runs.get(assignment.attemptId) === run) this.runs.delete(assignment.attemptId);
    });
  }

  private buildOptions(run: Run): Options {
    const a = run.a;
    const local = a.environment === "local";
    const policy = toolPolicy(a.workspace.access, this.allowShell);
    // Isolated: only the allowed connections, configured from the user's own MCP definitions.
    const selected = local ? {} : this.mcpConfigsFor(a.connections);
    const guard = createWorkspaceGuard(a.workspace.path, policy.tools, local ? "any" : Object.keys(selected));

    const preToolUse: HookCallback = async (input) => {
      const i = input as unknown as Rec;
      if (i.hook_event_name !== "PreToolUse") return {};
      const name = String(i.tool_name ?? "");
      const verdict = guard(name, i.tool_input);
      if (verdict.ok) return {};
      this.activity(run, `Blocked ${name}: ${verdict.reason}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason,
        },
      };
    };

    const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
      const verdict = guard(toolName, input);
      if (verdict.ok) return { behavior: "allow", updatedInput: input };
      this.activity(run, `Blocked ${toolName}: ${verdict.reason}`);
      return { behavior: "deny", message: verdict.reason };
    };

    const options: Options = {
      cwd: a.workspace.path,
      model: a.model,
      maxTurns: a.limits.maxTurns,
      abortController: run.abort,
      // Isolated: no settings (hence no CLAUDE.md; the envelope is the context) and only the allowed
      // connections. Local: the user's own (user-level) Claude Code setup, including its MCP servers.
      // Project settings are never loaded: they live in the worktree, which agents can write, and
      // their hooks would run commands outside the workspace guard.
      ...(local ? { settingSources: ["user"] as "user"[] } : { settingSources: [], strictMcpConfig: true, mcpServers: selected }),
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: policy.tools,
      disallowedTools: policy.disallowedTools,
      // Non-interactive: edits and out-of-cwd access prompt, and every prompt is answered by canUseTool.
      permissionMode: "default",
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      // Env REPLACES the child environment (per sdk.d.ts), so pass everything through, plus our flags.
      // One way of signing in is passed on, and GitHub tokens are removed (see claudeWorkerEnv).
      env: {
        ...claudeWorkerEnv(this.env),
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
        CLAUDE_AGENT_SDK_CLIENT_APP: "orchestration/0.1.0",
        // The agent-kit plugin's hooks stay off: the envelope already gives each step its principles. Only a local
        // run loads the user's plugins, but every run gets it, so the rule is simple.
        AGENT_KIT_HOOKS: "off",
      },
      stderr: (data: string) => {
        run.stderrTail = (run.stderrTail + data).slice(-2000);
      },
    };
    if (a.limits.maxBudgetUsd !== undefined) options.maxBudgetUsd = a.limits.maxBudgetUsd;
    return options;
  }

  private async drive(run: Run): Promise<void> {
    const id = run.a.attemptId;
    let queryFn: ClaudeQueryFn;
    try {
      queryFn = (await this.loadSdk()).query;
    } catch (err) {
      if (run.interruptRequested) return this.finish(run, { type: "stopped", attemptId: id, how: "interrupted" });
      return this.finish(run, {
        type: "failed",
        attemptId: id,
        message: `The Claude Agent SDK could not be loaded: ${truncate(redact(errorText(err)), 200)}`,
      });
    }
    if (run.forgotten || run.terminal) return;
    // Interrupted before the provider was contacted: nothing is running, so the stop is confirmed.
    if (run.interruptRequested) return this.finish(run, { type: "stopped", attemptId: id, how: "interrupted" });

    try {
      run.handle = queryFn({ prompt: run.input, options: this.buildOptions(run) });
      for await (const msg of run.handle) {
        if (run.forgotten) break;
        if (run.terminal) continue; // drain so the CLI can finish writing its session, but stay silent
        this.handleMessage(run, msg);
      }
      this.onStreamEnd(run, undefined);
    } catch (err) {
      this.onStreamEnd(run, err);
    }
  }

  private handleMessage(run: Run, msg: SDKMessage) {
    const m = msg as unknown as Rec;
    const id = run.a.attemptId;
    switch (m.type) {
      case "system": {
        if (m.subtype === "session_state_changed" && typeof m.state === "string") run.sessionState = m.state;
        if (m.subtype === "init" && !run.started) {
          run.started = true;
          run.sessionId = typeof m.session_id === "string" ? m.session_id : undefined;
          run.model = typeof m.model === "string" ? m.model : undefined;
          const tools = Array.isArray(m.tools) ? (m.tools as unknown[]).map(String) : [];
          if (tools.includes("Agent") || tools.includes("Task")) {
            this.log(`[claude ${id}] warning: the session reports a subagent tool despite being disallowed`);
          }
          if (!run.terminal && !run.forgotten) {
            this.emitRaw({ type: "started", attemptId: id, sessionId: run.sessionId, model: run.model });
          }
        }
        return;
      }
      case "assistant": {
        if (typeof m.error === "string" && AUTH_ASSISTANT_ERRORS.has(m.error)) run.sawAuthError = true;
        if (m.parent_tool_use_id == null) this.acknowledge(run, m);
        const message = asRec(m.message);
        if (!run.model && typeof message.model === "string") run.model = message.model;
        const content = Array.isArray(message.content) ? (message.content as unknown[]).map(asRec) : [];
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === "tool_use") {
            this.activity(run, describeToolUse(String(block.name ?? "tool"), asRec(block.input), run.a.workspace.path));
          } else if (block.type === "text" && typeof block.text === "string") {
            texts.push(block.text);
          }
        }
        if (texts.length > 0 && m.parent_tool_use_id == null) {
          // Streamed messages may deliver one API message's blocks separately under the same id.
          const mid = typeof message.id === "string" ? message.id : undefined;
          if (mid !== undefined && mid === run.lastMessageId && run.lastText) run.lastText += `\n${texts.join("\n")}`;
          else run.lastText = texts.join("\n");
          run.lastMessageId = mid;
        }
        return;
      }
      case "result":
        this.acknowledge(run, m);
        this.handleResult(run, m);
        return;
      default:
        return;
    }
  }

  /**
   * The CLI echoes the client uuids a turn has consumed on its reply frames (`user_message_uuid`,
   * `user_message_uuids`): the turn's first top-level assistant message, and the result, whose list also
   * holds the messages folded into the turn between tool rounds. A note counts as delivered only when one
   * of those frames names its uuid; a write to the process is never enough.
   */
  private acknowledge(run: Run, m: Rec) {
    if (run.notes.size === 0) return;
    const named = Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as unknown[]) : [m.user_message_uuid];
    for (const uuid of named) {
      if (typeof uuid !== "string") continue;
      const noteId = run.notes.get(uuid);
      if (noteId === undefined) continue;
      run.notes.delete(uuid);
      this.emitRaw({ type: "note", attemptId: run.a.attemptId, noteId, outcome: "delivered" });
    }
    if (run.notes.size === 0) this.clearNoteWait(run);
  }

  private handleResult(run: Run, m: Rec) {
    const id = run.a.attemptId;
    // modelUsage and total_cost_usd are cumulative across a streaming session's turns (sdk.d.ts), so the
    // latest result holds the run's total; only the per-turn `usage` fallback is summed over earlier turns.
    let usage = usageFromResult(m);
    if (Object.keys(asRec(m.modelUsage)).length === 0) {
      usage = run.priorTurnUsage ? addUsage(run.priorTurnUsage, usage) : usage;
      run.priorTurnUsage = usage;
    }
    const terminalReason = typeof m.terminal_reason === "string" ? m.terminal_reason : undefined;
    const abortedReason = terminalReason === "aborted_streaming" || terminalReason === "aborted_tools";
    const stopped = () =>
      this.finish(run, { type: "stopped", attemptId: id, how: run.aborting ? "killed" : "interrupted", usage });

    if (m.subtype === "success") {
      const resultText = typeof m.result === "string" ? m.result : "";
      if (m.is_error === true) {
        if (run.interruptRequested) return stopped();
        const text = resultText || run.lastText;
        const auth = run.sawAuthError || m.api_error_status === 401 || isAuthError(text);
        return this.finish(run, {
          type: "failed",
          attemptId: id,
          message: auth ? CLAUDE_AUTH_MESSAGE : `Claude API error: ${truncate(redact(text || "unknown error"), 300)}`,
          usage,
        });
      }
      // After an interrupt, a success result marked as aborted means the stop took effect.
      if (run.interruptRequested && abortedReason) return stopped();
      // Otherwise the turn finished (possibly racing the interrupt).
      const completed: AdapterEvent = {
        type: "completed",
        attemptId: id,
        finalText: resultText.trim() !== "" ? resultText : run.lastText,
        usage,
        model: run.model ?? firstModel(m),
      };
      // A note sent but not yet acknowledged is queued in the CLI, which starts the next turn with
      // it. The run goes on and completes on a later result; this one is kept in case no acknowledgment
      // ever comes (the wait is bounded, see giveUpOnNotes).
      if (run.notes.size > 0) {
        run.lastResult = completed;
        this.activity(run, "The turn ended with a note outstanding; waiting for the next turn to take it up");
        this.clearNoteWait(run);
        run.noteWait = this.timer(run, this.noteAckGraceMs, () => this.giveUpOnNotes(run));
        return;
      }
      return this.finish(run, completed);
    }

    // Error subtypes.
    if (run.interruptRequested) return stopped();
    // A turn started by a note shares the run's turn and spend limits. When it hits one, the run had already
    // finished its work on the earlier turn: complete on that result (with the total usage) and say so, rather
    // than discarding finished work as a failure.
    if (run.lastResult && (m.subtype === "error_max_turns" || m.subtype === "error_max_budget_usd")) {
      this.activity(run, `The note's turn reached the ${m.subtype === "error_max_turns" ? "turn" : "spend"} limit; the run completes on the result it had before the note`);
      return this.finish(run, { ...run.lastResult, usage });
    }
    const errors = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String).filter(Boolean) : [];
    let message: string;
    switch (m.subtype) {
      case "error_max_turns":
        message = `Claude stopped: reached the turn limit (${run.a.limits.maxTurns} turns) before finishing.`;
        break;
      case "error_max_budget_usd":
        message = `Claude stopped: reached the spend limit${
          run.a.limits.maxBudgetUsd !== undefined ? ` ($${run.a.limits.maxBudgetUsd})` : ""
        } before finishing.`;
        break;
      case "error_during_execution": {
        const detail = errors.join("; ") || run.stderrTail;
        if (run.sawAuthError || isAuthError(detail)) message = CLAUDE_AUTH_MESSAGE;
        else message = `Claude run failed during execution${detail ? `: ${truncate(redact(detail), 300)}` : "."}`;
        break;
      }
      default:
        message = `Claude run ended with ${String(m.subtype)}${errors.length ? `: ${truncate(redact(errors.join("; ")), 300)}` : "."}`;
    }
    this.finish(run, { type: "failed", attemptId: id, message, usage });
  }

  /**
   * No turn acknowledged the outstanding notes within the grace period after the last turn ended.
   * They were not delivered, and the run completes on that turn's result. The session is then ended in
   * case it did start a turn after all, so nothing continues unreported.
   */
  private giveUpOnNotes(run: Run) {
    if (run.terminal || run.forgotten || !run.lastResult) return;
    // A turn is still running (the CLI says so), most likely the note's own turn before its first frame.
    // Completing now would read a worktree it is still editing; wait again. The run's time limit still applies.
    if (run.sessionState !== undefined && run.sessionState !== "idle") {
      this.activity(run, "A turn is still running; waiting for it to take up the note");
      run.noteWait = this.timer(run, this.noteAckGraceMs, () => this.giveUpOnNotes(run));
      return;
    }
    this.settleNotes(run, `the Claude session did not acknowledge the note within ${Math.round(this.noteAckGraceMs / 1000)}s of the turn ending`);
    this.finish(run, run.lastResult);
    try {
      run.abort.abort();
    } catch {
      /* ignore */
    }
  }

  /** The message stream finished (err undefined) or threw. */
  private onStreamEnd(run: Run, err: unknown) {
    if (run.forgotten || run.terminal) return;
    const id = run.a.attemptId;
    if (run.aborting) return this.finish(run, { type: "stopped", attemptId: id, how: "killed" });
    // The stream ending after interrupt() is the confirmation that nothing is running.
    if (run.interruptRequested) return this.finish(run, { type: "stopped", attemptId: id, how: "interrupted" });
    // The session ended after a turn whose notes were never acknowledged: those notes were not
    // delivered, and the run completes on that turn's result (its output block is the work done).
    if (run.lastResult) {
      this.settleNotes(run, "the Claude session ended before the agent read it");
      return this.finish(run, run.lastResult);
    }
    if (err === undefined) {
      return this.finish(run, { type: "failed", attemptId: id, message: "The Claude session ended without a result." });
    }
    const text = `${errorText(err)}\n${run.stderrTail}`;
    if (run.sawAuthError || isAuthError(text)) {
      return this.finish(run, { type: "failed", attemptId: id, message: CLAUDE_AUTH_MESSAGE });
    }
    this.finish(run, { type: "failed", attemptId: id, message: `Claude run failed: ${truncate(redact(errorText(err)), 300)}` });
  }

  /**
   * Push a note onto the run's input stream as a user message. `priority: "next"` lets the CLI
   * fold it into the running turn between tool rounds (or start the next turn with it), `client_composed`
   * keeps the text as written, and the uuid is what the CLI echoes back to acknowledge it (`acknowledge`).
   * The outcome arrives as one "note" event; until the acknowledgment the note is only sent, not delivered.
   */
  note(attemptId: string, note: { id: string; text: string }): void {
    const notDelivered = (reason: string) =>
      queueMicrotask(() => this.emitRaw({ type: "note", attemptId, noteId: note.id, outcome: "not-delivered", reason }));
    const run = this.runs.get(attemptId);
    if (!run || run.terminal || run.forgotten) return notDelivered(this.ended.has(attemptId) ? "the run had finished" : "no such run");
    if (run.interruptRequested) return notDelivered("the run is stopping");
    const uuid = randomUUID();
    run.notes.set(uuid, note.id);
    run.input.push({
      type: "user",
      message: { role: "user", content: note.text },
      parent_tool_use_id: null,
      uuid,
      priority: "next",
      client_composed: true,
    });
  }

  interrupt(attemptId: string): void {
    const run = this.runs.get(attemptId);
    if (!run || run.terminal || run.forgotten || run.interruptRequested) return;
    run.interruptRequested = true;
    // A stopping run acts on nothing more, and the input closes so the CLI exits once the turn stops.
    this.settleNotes(run, "the run was stopped first");
    run.input.close();
    // Not started yet: drive() sees the flag after the SDK loads and confirms the stop without a run.
    if (!run.handle) return;
    const fn = run.handle.interrupt;
    if (typeof fn !== "function") {
      this.escalate(run);
      return;
    }
    try {
      Promise.resolve(fn.call(run.handle)).catch((err) =>
        this.log(`[claude ${attemptId}] interrupt request failed: ${truncate(redact(errorText(err)))}`),
      );
    } catch (err) {
      this.log(`[claude ${attemptId}] interrupt request failed: ${truncate(redact(errorText(err)))}`);
    }
    this.timer(run, this.interruptGraceMs, () => this.escalate(run));
  }

  /** Grace period expired (or no interrupt method): abort the process and wait briefly for the stream to settle. */
  private escalate(run: Run) {
    if (run.terminal || run.forgotten || run.aborting) return;
    run.aborting = true;
    this.log(`[claude ${run.a.attemptId}] interrupt not confirmed; aborting the process`);
    try {
      run.abort.abort();
    } catch {
      /* ignore */
    }
    this.timer(run, this.killSettleMs, () => {
      if (run.terminal || run.forgotten) return;
      this.finish(run, { type: "stopped", attemptId: run.a.attemptId, how: "killed" });
      // The stream never settled: forget it so nothing it produces later is reported.
      run.forgotten = true;
      if (this.runs.get(run.a.attemptId) === run) this.runs.delete(run.a.attemptId);
    });
  }

  kill(attemptId: string): void {
    const run = this.runs.get(attemptId);
    if (!run) return;
    run.forgotten = true;
    this.clearTimers(run);
    // Forgotten silently, notes included (the service reconciles notes left "sending" when it restarts).
    run.notes.clear();
    run.input.close();
    this.remember(attemptId);
    try {
      run.abort.abort();
    } catch {
      /* ignore */
    }
    this.runs.delete(attemptId);
  }

  async shutdown(): Promise<void> {
    const pending = [...this.runs.values()];
    for (const run of pending) this.kill(run.a.attemptId);
    await Promise.race([
      Promise.allSettled(pending.map((r) => r.done)),
      new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
    ]);
  }
}

function firstModel(m: Rec): string | undefined {
  const keys = Object.keys(asRec(m.modelUsage));
  return keys[0];
}
