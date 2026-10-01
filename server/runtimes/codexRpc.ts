// Minimal JSON-RPC client for the Codex app-server stdio transport.
//
// Wire format (verified against @openai/codex 0.159.2, see codex-protocol/README.md):
// one JSON object per line, JSON-RPC 2.0 semantics WITHOUT the "jsonrpc" field. Requests are
// {id, method, params}; responses {id, result} or {id, error}; notifications {method, params}.
// The server also sends requests to the client (approvals), which must be answered by id.

import type { Readable, Writable } from "node:stream";
import type { ClientNotification } from "./codex-protocol/ClientNotification";
import type { ClientRequest } from "./codex-protocol/ClientRequest";
import type { RequestId } from "./codex-protocol/RequestId";
import type { ServerNotification } from "./codex-protocol/ServerNotification";
import type { ServerRequest } from "./codex-protocol/ServerRequest";
import type { InitializeResponse } from "./codex-protocol/InitializeResponse";
import type { CommandExecResponse } from "./codex-protocol/v2/CommandExecResponse";
import type { CommandExecTerminateResponse } from "./codex-protocol/v2/CommandExecTerminateResponse";
import type { GetAccountResponse } from "./codex-protocol/v2/GetAccountResponse";
import type { ModelListResponse } from "./codex-protocol/v2/ModelListResponse";
import type { ThreadStartResponse } from "./codex-protocol/v2/ThreadStartResponse";
import type { TurnInterruptResponse } from "./codex-protocol/v2/TurnInterruptResponse";
import type { TurnSteerResponse } from "./codex-protocol/v2/TurnSteerResponse";
import type { TurnStartResponse } from "./codex-protocol/v2/TurnStartResponse";

export type ClientMethod = ClientRequest["method"];
export type ParamsOf<M extends ClientMethod> = Extract<ClientRequest, { method: M }>["params"];
/** Response types for the methods this project calls (the generated tree has no method->response map). */
interface ResponseMap {
  initialize: InitializeResponse;
  "thread/start": ThreadStartResponse;
  "turn/start": TurnStartResponse;
  "turn/interrupt": TurnInterruptResponse;
  "turn/steer": TurnSteerResponse;
  "account/read": GetAccountResponse;
  "model/list": ModelListResponse;
  // ORC-013: the check runner's sandboxed commands.
  "command/exec": CommandExecResponse;
  "command/exec/terminate": CommandExecTerminateResponse;
}
export type ResultOf<M extends ClientMethod> = M extends keyof ResponseMap ? ResponseMap[M] : unknown;
export type NotificationOf<M extends ServerNotification["method"]> = Extract<ServerNotification, { method: M }>;

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Raised for pending requests when the connection closes before they are answered. */
export class RpcClosedError extends Error {
  constructor(readonly method: string) {
    super(`Codex app-server closed the connection before answering ${method}`);
    this.name = "RpcClosedError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(readonly method: string, ms: number) {
    super(`Codex app-server did not answer ${method} within ${Math.round(ms / 1000)}s`);
    this.name = "RpcTimeoutError";
  }
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RpcHandlers {
  onNotification?: (n: ServerNotification) => void;
  /** Must eventually call `respond` or `respondError` with the request id. */
  onServerRequest?: (r: ServerRequest) => void;
  /** A line that is not JSON or not a recognisable message. Never contains more than a short prefix. */
  onGarbage?: (preview: string) => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<RequestId, Pending>();
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: RpcHandlers = {},
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("end", () => this.close());
    input.on("close", () => this.close());
    // EPIPE when the child dies mid-write: treat as closed rather than crashing the service.
    output.on("error", () => this.close());
  }

  get isClosed() {
    return this.closed;
  }

  request<M extends ClientMethod>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>> {
    if (this.closed) return Promise.reject(new RpcClosedError(method));
    const id = this.nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const p: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs && timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.write({ id, method, params });
    });
  }

  notify(method: ClientNotification["method"]) {
    this.write({ method });
  }

  respond(id: RequestId, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }

  /** Reject every pending request. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new RpcClosedError(p.method));
    }
  }

  private write(msg: unknown) {
    if (this.closed) return;
    try {
      this.output.write(JSON.stringify(msg) + "\n");
    } catch {
      this.close();
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.onGarbage?.(line.slice(0, 80));
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const hasId = typeof msg.id === "string" || typeof msg.id === "number";
    if (typeof msg.method === "string") {
      if (hasId) this.handlers.onServerRequest?.(msg as unknown as ServerRequest);
      else this.handlers.onNotification?.(msg as unknown as ServerNotification);
      return;
    }
    if (hasId) {
      const id = msg.id as RequestId;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error && typeof msg.error === "object") {
        const e = msg.error as { code?: number; message?: string; data?: unknown };
        p.reject(new RpcError(p.method, e.code, String(e.message ?? "unknown error"), e.data));
      } else p.resolve(msg.result);
      return;
    }
    this.handlers.onGarbage?.(line.slice(0, 80));
  }
}
