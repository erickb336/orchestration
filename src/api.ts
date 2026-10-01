// HTTP contract between the local service and the UI. See docs/tasks/ORC-003.md.

import type { CommandName } from "./domain/commands";
import type { AttachResult } from "./domain/model";
import type { CheckCommand, ProviderId, State } from "./domain/types";
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

interface ProviderInfo {
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

/** Body of GET /api/change?task=<id>: what a landed task changed, relative to the commit before it. */
export interface ChangeResponse {
  taskId: string;
  /** The landed commit, read from the task's record (a request never names a commit). */
  commit: string;
  target: string;
  /** `git diff --stat --patch` output. */
  diff: string;
  /** True when the diff was cut at the size limit. */
  truncated: boolean;
}

/** A 404 from GET /api/change. `url` is the pull request, when the commit can still be seen there. */
export interface ChangeError extends CommandError {
  url?: string;
}

/**
 * Body of POST /api/vision-docs (ORC-014): one file per request. The service checks it, records it with
 * the `stageVisionDoc` command under the given idempotency key, then keeps a copy by content hash outside
 * any repository. Nothing is attached yet: the client attaches every file of one Add, drop or folder as
 * one vision revision with the `attachVisionDocs` command (review 9). Rejections come back as a
 * CommandError with a plain reason.
 */
export interface VisionDocUpload {
  /** Relative path, folder structure included (a folder upload keeps its paths). */
  path: string;
  /** The file's bytes, base64-encoded. At most 2 MB decoded. */
  content: string;
  idempotencyKey: string;
}

export interface VisionDocUploadOk {
  version: number;
  /** The staged document, to name in `attachVisionDocs`; for "unchanged", the document already attached. */
  docId: string;
  /** "unchanged": the same file (path and content) is attached already; there is nothing to commit. */
  status: "staged" | "unchanged";
  /** The document at the same path this one will replace when its batch commits. */
  replaces?: string;
}

/** Result of the `attachVisionDocs` command: the revision created, if any, and one row per staged document sent. */
export type AttachVisionDocsResult = AttachResult;

/** ORC-013: body of GET /api/checks/suggest: the commands the repository's files suggest, read at `ref`. Nothing is saved until the user chooses them. */
export interface CheckSuggestions {
  commands: CheckCommand[];
  /** The trusted base the files were read at ("" when nothing was read). */
  ref: string;
  /** Why there is nothing to suggest, when the list is empty. */
  reason?: string;
}

/** ORC-013: where the full (redacted) log of one check of one run is served from. */
export function checkLogUrl(attemptId: string, checkId: string): string {
  return `/api/checks/log?run=${encodeURIComponent(attemptId)}&check=${encodeURIComponent(checkId)}`;
}
