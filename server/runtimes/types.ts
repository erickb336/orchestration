// The runtime adapter contract (ORC-004 fixed interface). One adapter per provider; the scheduler
// owns dispatch and state, adapters own processes. Adapters never touch the store: they emit events,
// which the scheduler applies inside lease-checked transactions.

import type { CatalogModel, CheckResult, OutputDef, ProviderId, RoleId } from "../../src/domain/types";
import type { CapabilityMap } from "../../src/runtime/adapter";

/** ORC-013: what a service check run (server/checks.ts) reports when it completes. */
export interface CheckRunReport {
  /** The commit the workspace was at. */
  sha: string;
  results: CheckResult[];
  durationMs: number;
  sandbox: "codex" | "none";
  simulated?: true;
}

interface AssignmentLimits {
  /** Maximum agent turns (Claude) / tool-loop iterations where supported. */
  maxTurns: number;
  /** Wall-clock limit; the adapter interrupts, then kills, when exceeded. */
  timeoutMs: number;
  /** Spend cap where the provider supports one (Claude `maxBudgetUsd`). */
  maxBudgetUsd?: number;
}

export interface Assignment {
  attemptId: string;
  taskId: string;
  stepId: string;
  role: RoleId;
  provider: ProviderId;
  /** Concrete model id resolved before dispatch (never "auto"). */
  model: string;
  workspace: {
    /** Absolute path of this attempt's git worktree. The agent's cwd. */
    path: string;
    /** "write": may edit files in the worktree. "read": must not modify anything. */
    access: "write" | "read";
  };
  /**
   * "isolated": no user settings, MCP servers, plugins, or web tools. "local": the user's own
   * provider configuration (user-level settings, MCP servers, plugins). In both, the worker's own
   * file edits are confined to the worktree and native sub-agents are disabled. MCP servers and
   * plugins are separate programs running with the user's permissions: they are not sandboxed.
   */
  environment: "isolated" | "local";
  /** Isolated runs only: MCP servers from the user's own config that this run may use. */
  connections: string[];
  /** The complete assignment envelope, including the output contract. */
  prompt: string;
  /** Declared outputs the final message must report. */
  outputs: OutputDef[];
  limits: AssignmentLimits;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type AdapterEvent =
  /** The provider accepted the run. `sessionId` is the provider's own id (thread/session). */
  | { type: "started"; attemptId: string; sessionId?: string; model?: string }
  /** Optional numeric progress, for runtimes that can estimate it (only the fake runtime does). */
  | { type: "progress"; attemptId: string; percent: number }
  /** A meaningful milestone for the activity feed (tool used, file changed, message). Keep it short. */
  | { type: "activity"; attemptId: string; note: string }
  /** The run finished normally. `finalText` is the agent's last message (contains the output block); "" for a check run, which reports `checks`. */
  | { type: "completed"; attemptId: string; finalText: string; usage?: Usage; model?: string; checks?: CheckRunReport }
  /** The run is confirmed not running after an interrupt or kill. */
  | { type: "stopped"; attemptId: string; how: "interrupted" | "killed"; usage?: Usage }
  /** The run ended without a usable result (provider error, auth failure, limit reached, crash). */
  | { type: "failed"; attemptId: string; message: string; usage?: Usage }
  /**
   * ORC-022: the outcome of `note()` for one note. "delivered" only on the runtime's acknowledgment
   * (Codex: `turn/steer` accepted; Claude: an assistant message names the note's uuid). Never terminal for the run.
   */
  | { type: "note"; attemptId: string; noteId: string; outcome: "delivered" | "not-delivered"; reason?: string };

/** An MCP server found in the user's own provider configuration (never includes its settings or secrets). */
export interface Connection {
  name: string;
  /** Whether the user's own configuration has it enabled. */
  enabled: boolean;
}

export interface ProviderHealth {
  status: "ready" | "not-configured" | "unavailable";
  /** One or two sentences a user can act on, e.g. how to configure credentials. Never contains secrets. */
  detail: string;
  checkedAt: string;
}

export interface RuntimeAdapter {
  readonly provider: ProviderId;
  /** Human-readable adapter name and pinned version, e.g. "Codex app-server 0.159.2". */
  readonly label: string;
  readonly capabilities: CapabilityMap;

  /** Check credentials/binary availability without starting a run. Must not throw. */
  health(): Promise<ProviderHealth>;
  /** MCP servers in the user's own configuration, or null if they cannot be listed. Must not throw. */
  listConnections?(): Promise<Connection[] | null>;
  /** Models available to this account, or null if the provider cannot list them. Must not throw. */
  listModels(): Promise<CatalogModel[] | null>;

  /** Begin a run. Returns immediately; progress arrives as events. Starting an id twice is a no-op. */
  start(assignment: Assignment): void;
  /**
   * Request a graceful stop. Idempotent. The adapter must eventually emit exactly one terminal event
   * for the attempt: `stopped` (confirmed), or `completed`/`failed` if the run ended first. If the
   * provider does not confirm within its grace period the adapter kills the process and emits
   * `stopped` with how: "killed".
   */
  interrupt(attemptId: string): void;
  /**
   * ORC-022: deliver a note to the live run of `attemptId`. Must not throw; exactly one "note" event
   * for `note.id` follows (also when there is no such run: "not-delivered").
   */
  note(attemptId: string, note: { id: string; text: string }): void;
  /** Terminate immediately and forget the run WITHOUT emitting further events (orphan cleanup). */
  kill(attemptId: string): void;

  /** Whether the adapter currently has a live run for this attempt. */
  has(attemptId: string): boolean;
  ids(): string[];

  /** Subscribe to events. Returns an unsubscribe function. */
  onEvent(listener: (e: AdapterEvent) => void): () => void;

  /** Stop all runs (kill) and release resources. */
  shutdown(): Promise<void>;
}
