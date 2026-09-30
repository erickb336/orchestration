// HTTP contract between the local service and the UI. See docs/tasks/ORC-003.md.

import type { CommandName } from "./domain/commands";
import type { State } from "./domain/types";

export const CLIENT_HEADER = "X-Orchestration-Client";

export type AckMode = "normal" | "never";

export interface ServiceInfo {
  startedAt: string;
  /** "active" when this service instance holds the scheduler lease; "observer" otherwise. */
  scheduler: "active" | "observer";
  /** Milestone 2 ships only the fake runtime; real adapters arrive in Milestone 3. */
  runtime: "fake";
  sim: { auto: boolean; ackMode: AckMode };
  dbPath: string;
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
