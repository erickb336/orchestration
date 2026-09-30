// HTTP contract between the local service and the UI. See docs/tasks/ORC-003.md.

import type { CommandName } from "./domain/commands";
import type { ProviderId, State } from "./domain/types";
import type { CapabilityMap } from "./runtime/adapter";

export const CLIENT_HEADER = "X-Orchestration-Client";

export type AckMode = "normal" | "never";

export interface ServiceInfo {
  startedAt: string;
  /** "active" when this service instance holds the scheduler lease; "observer" otherwise. */
  scheduler: "active" | "observer";
  /** "fake": simulated runs only. "real": Claude and Codex agents run on this machine. */
  runtime: "fake" | "real";
  /** Simulation controls; meaningful only when runtime is "fake". */
  sim: { auto: boolean; ackMode: AckMode };
  dbPath: string;
  providers: Record<ProviderId, ProviderInfo>;
  /** Why the lead cannot run right now, if anything (shown in the conversation). */
  leadBlocked?: string;
  /** Real mode: whether the configured repository can host worktrees, and why not. */
  repo?: { ok: boolean; reason?: string; branch?: string };
}

export interface ProviderInfo {
  label: string;
  capabilities: CapabilityMap;
  health?: { status: "ready" | "not-configured" | "unavailable"; detail: string; checkedAt: string };
  /** MCP servers in the user's own provider configuration (names only); null if they could not be listed. */
  connections?: { name: string; enabled: boolean }[] | null;
}

/** Body of GET /api/state and of each `state` event on GET /api/stream. */
export interface StatePayload {
  version: number;
  state: State;
  service: ServiceInfo;
}

export interface CommandRequest {
  name: CommandName;
  args?: unknown;
  /** Unique per user intent; a retry with the same key is applied at most once. */
  idempotencyKey: string;
}

export interface CommandOk {
  version: number;
  result?: unknown;
}

export interface CommandError {
  error: string;
  kind: "stale" | "control" | "invalid" | "forbidden" | "internal";
}
