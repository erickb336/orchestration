// ORC-018 §5.2: the trace export. Each settled task is sent once, as one OTLP/HTTP protobuf request, to the
// endpoint the user configured (Settings → Traces), through the OpenTelemetry JS SDK's exporter. The
// bookkeeping is the store's `trace_exports` table, one row per (task, settle), outside the state.
//
// The exporter runs in the scheduler's loop on the lease holder only (`Scheduler` calls `pass`). Nothing
// is sent while the export is off. Headers (for example Langfuse's key) are parsed once at start from
// OTEL_EXPORTER_OTLP_HEADERS by `parseOtlpHeaders`; they are never logged, stored or exposed, and the
// status says only whether the variable was set. A failure backs off by 1, 5, 15 and 30 minutes; after
// 6 tries the row is `failed` until "Retry failed". A row is marked `sent` in the same tick as the SDK's
// success callback; a crash between the send and the mark resends the same trace with the same ids
// (`buildTaskTrace`), which viewers treat as the same trace.

import { readFileSync } from "node:fs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { TelemetryStatus } from "../src/api";
import { buildTaskTrace, type SpanKindName, type SpanStatusName, type TaskTrace } from "../src/domain/trace";
import type { State } from "../src/domain/types";
import type { Store } from "./store";

/** Minutes before the next try after the 1st, 2nd, 3rd and later failures. */
export const BACKOFF_MINUTES = [1, 5, 15, 30];
/** A row is `failed` after this many tries. */
export const MAX_TRIES = 6;
/** Rows sent per pass, one request each. */
export const BATCH = 20;
export const TIMEOUT_MS = 10_000;

/**
 * The headers the OTLP exporter would read from the environment by itself (review L2): the general
 * OTEL_EXPORTER_OTLP_HEADERS, overridden key by key by the traces-specific OTEL_EXPORTER_OTLP_TRACES_HEADERS,
 * as the OpenTelemetry specification orders them. Passing both explicitly keeps `headersFromEnv` and the
 * redaction of error messages truthful.
 */
export function otlpHeadersFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  return { ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) };
}

/**
 * The standard `key=value,key2=value2` form of OTEL_EXPORTER_OTLP_HEADERS, URL-decoded (the specification
 * percent-encodes values). Pairs without a key are skipped. The result is held in memory only.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  for (const pair of raw.split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const key = decode(pair.slice(0, i).trim());
    const value = decode(pair.slice(i + 1).trim());
    if (key) out[key] = value;
  }
  return out;
}

/** The app's version for `service.version`, from package.json next to this directory; "unknown" if it cannot be read. */
export function appVersion(): string {
  try {
    return String((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

// ---- the adapter to the SDK v2 `ReadableSpan` (design §5.3) ----

// Numeric values of the `@opentelemetry/api` enums, which the SDK's ReadableSpan carries: SpanKind, SpanStatusCode, TraceFlags.
const SPAN_KIND: Record<SpanKindName, number> = { INTERNAL: 0, CLIENT: 2 };
const STATUS_CODE: Record<SpanStatusName, number> = { UNSET: 0, OK: 1, ERROR: 2 };
const SAMPLED = 1;

const hrTime = (nanos: bigint): [number, number] => [Number(nanos / 1_000_000_000n), Number(nanos % 1_000_000_000n)];
const hrDiff = (a: bigint, b: bigint): [number, number] => hrTime(b > a ? b - a : 0n);

/** Plain span records as the SDK's exporter reads them: `parentSpanContext`, `instrumentationScope` and a shared `resource`. */
export function toReadableSpans(trace: TaskTrace, scopeVersion: string): ReadableSpan[] {
  const resource: Resource = resourceFromAttributes(trace.resource);
  const instrumentationScope = { name: "orchestrator", version: scopeVersion };
  return trace.spans.map((s) => ({
    name: s.name,
    kind: SPAN_KIND[s.kind],
    spanContext: () => ({ traceId: s.traceId, spanId: s.spanId, traceFlags: SAMPLED }),
    ...(s.parentSpanId ? { parentSpanContext: { traceId: s.traceId, spanId: s.parentSpanId, traceFlags: SAMPLED } } : {}),
    startTime: hrTime(s.startTimeUnixNano),
    endTime: hrTime(s.endTimeUnixNano),
    status: { code: STATUS_CODE[s.status.code], ...(s.status.message ? { message: s.status.message } : {}) },
    attributes: { ...s.attributes },
    links: [],
    events: [],
    duration: hrDiff(s.startTimeUnixNano, s.endTimeUnixNano),
    ended: true,
    resource,
    instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }));
}

// ---- the exporter ----

export interface TelemetryOptions {
  /** Parsed once at start from OTEL_EXPORTER_OTLP_HEADERS. Never logged, stored or exposed. */
  headers?: Record<string, string>;
  serviceVersion?: string;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

export class TelemetryExporter {
  private readonly store: Store;
  private readonly headers: Record<string, string>;
  private readonly serviceVersion: string;
  private readonly log: (msg: string) => void;
  private readonly timeoutMs: number;
  private current: { url: string; exporter: OTLPTraceExporter } | undefined;
  private inFlight: Promise<void> | undefined;
  /** The state as of `seen.version` (review L1): a pass with no new state and nothing due reads and writes nothing. */
  private seen: { version: number; state: State } | undefined;

  constructor(store: Store, opts: TelemetryOptions = {}) {
    this.store = store;
    this.headers = { ...(opts.headers ?? {}) };
    this.serviceVersion = opts.serviceVersion ?? "unknown";
    this.log = opts.log ?? (() => {});
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /** Whether any header came from the environment. The headers themselves are never reported. */
  get headersFromEnv(): boolean {
    return Object.keys(this.headers).length > 0;
  }

  /** ORC-018 §5.2: what the Settings section shows, read from the table. `unqueued` is what "Send finished tasks" would queue (review M1). */
  status(state: State): TelemetryStatus {
    const known = this.store.traceExportKeys();
    const unqueued = settles(state).filter((k) => !known.has(`${k.taskId}|${k.settledAt}`)).length;
    return { enabled: !!state.project.telemetry?.enabled, ...this.store.traceExportCounts(), unqueued, headersFromEnv: this.headersFromEnv };
  }

  /**
   * One pass of the loop: queue the tasks that settled after `enabledAt` and have no row yet, then send
   * at most 20 due rows, one request per task. Never throws and never overlaps itself; a pass started
   * while one is in flight joins it.
   */
  pass(nowMs: number): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(nowMs)
      .catch((e) => this.log(`Traces: pass failed: ${this.redact(message(e))}`))
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  /** Resolves once the pass in flight, if any, has finished. */
  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  /** "Send finished tasks": queue every settled task with an outcome that has no row, whatever `enabledAt` says. Returns how many were queued. */
  backfill(): number {
    return this.store.queueTraceExports(settles(this.store.read().state));
  }

  /** "Retry failed": failed rows become pending and due now. Returns how many. */
  retryFailed(): number {
    const n = this.store.retryFailedTraceExports();
    if (n) this.store.emit();
    return n;
  }

  async shutdown() {
    const cur = this.current;
    this.current = undefined;
    await cur?.exporter.shutdown().catch(() => undefined);
  }

  private async run(nowMs: number) {
    // The state is read and the queue updated only when the state changed since the last pass (review L1);
    // otherwise a pass costs one version read and, while the export is on, one count of due rows.
    const version = this.store.version();
    const changedState = this.seen?.version !== version;
    if (changedState) this.seen = this.store.read();
    const state = this.seen!.state;
    const cfg = state.project.telemetry;
    if (!cfg?.enabled || !cfg.endpoint) return;
    if (changedState && cfg.enabledAt) {
      const since = cfg.enabledAt;
      this.store.queueTraceExports(settles(state).filter((k) => k.settledAt > since));
    }
    if (!this.store.dueTraceExportCount(nowMs)) return;
    const due = this.store.dueTraceExports(nowMs, BATCH);
    if (!due.length) return;
    let changed = false;
    for (const row of due) {
      const t = state.tasks.find((x) => x.id === row.taskId);
      // The task settled again since this row was queued (or is gone): its newer settle has its own row.
      if (!t?.outcome || t.outcome.settledAt !== row.settledAt) {
        this.store.dropTraceExport(row.taskId, row.settledAt);
        changed = true;
        continue;
      }
      try {
        const spans = toReadableSpans(buildTaskTrace(state, t, row.settledAt, { serviceVersion: this.serviceVersion }), this.serviceVersion);
        await this.send(cfg.endpoint, spans);
        // Marked in the same tick as the SDK's success callback resolved; nothing else runs in between.
        this.store.markTraceExport(row.taskId, row.settledAt, { status: "sent", sentAt: new Date(nowMs).toISOString() });
      } catch (e) {
        const tries = row.tries + 1;
        const error = this.redact(message(e)).slice(0, 500);
        const at = new Date(nowMs).toISOString();
        if (tries >= MAX_TRIES) this.store.markTraceExport(row.taskId, row.settledAt, { status: "failed", tries, nextAt: null, error, at });
        else this.store.markTraceExport(row.taskId, row.settledAt, { status: "pending", tries, nextAt: nowMs + BACKOFF_MINUTES[Math.min(tries, BACKOFF_MINUTES.length) - 1] * 60_000, error, at });
        this.log(`Traces: ${row.taskId} could not be sent (try ${tries} of ${MAX_TRIES}${tries >= MAX_TRIES ? ", giving up until Retry failed" : ""}): ${error}`);
      }
      changed = true;
    }
    if (changed) this.store.emit();
  }

  /** The SDK exporter for the configured endpoint; a new one when the endpoint changes. */
  private exporterFor(url: string): OTLPTraceExporter {
    if (this.current?.url === url) return this.current.exporter;
    const old = this.current;
    // Requests go out one at a time (`run` awaits each send); the SDK's own concurrency limit is left at its
    // default, because it releases a finished export's slot only after the result callback has run.
    this.current = { url, exporter: new OTLPTraceExporter({ url, headers: { ...this.headers }, timeoutMillis: this.timeoutMs }) };
    void old?.exporter.shutdown().catch(() => undefined);
    return this.current.exporter;
  }

  private send(url: string, spans: ReadableSpan[]): Promise<void> {
    const exporter = this.exporterFor(url);
    return new Promise<void>((resolve, reject) => {
      // ExportResultCode.SUCCESS is 0 (@opentelemetry/core).
      exporter.export(spans, (result: { code: number; error?: Error }) => (result.code === 0 ? resolve() : reject(result.error ?? new Error("The exporter reported a failure"))));
    });
  }

  /** A header value must never reach a log or the table, whatever a response echoes back. */
  private redact(text: string): string {
    let out = text;
    for (const v of Object.values(this.headers)) if (v.length >= 4) out = out.split(v).join("[redacted]");
    return out;
  }
}

/** Every settle on record: tasks with an outcome, keyed by the settle it describes. */
function settles(state: State): { taskId: string; settledAt: string }[] {
  return state.tasks.filter((t) => t.outcome).map((t) => ({ taskId: t.id, settledAt: t.outcome!.settledAt }));
}

/** The SDK's OTLPExporterError carries the HTTP status as `code`, with the status text as its message. */
const message = (e: unknown) => {
  if (!(e instanceof Error)) return String(e);
  const code = (e as { code?: unknown }).code;
  return typeof code === "number" ? `${e.message} (HTTP ${code})` : e.message;
};
