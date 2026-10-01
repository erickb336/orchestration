// ORC-018 B1 §5.2: the trace exporter against an in-process OTLP/HTTP receiver on loopback. The protobuf
// body is decoded here with a small reader (no extra dependency): one trace per settled task with the
// right parent links, times and attributes; nothing sent when off; headers from the environment only; a
// 500 then a 200 gives one retry; a restart on the same database sends no duplicates; backfill queues
// older tasks; an observer instance sends nothing; and the pinned convention names.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC,
  GEN_AI_PROVIDER_NAME_VALUE_OPENAI,
} from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_ERROR_TYPE, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_HEADER, type ServiceInfo } from "../src/api";
import * as M from "../src/domain/model";
import { GEN_AI, PROVIDER_NAMES, spanIdFor, traceIdFor } from "../src/domain/trace";
import { createHttpServer } from "./http";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { BACKOFF_MINUTES, BATCH, MAX_TRIES, TIMEOUT_MS, TelemetryExporter, otlpHeadersFromEnv, parseOtlpHeaders } from "./telemetry";

// ---- a minimal protobuf reader for ExportTraceServiceRequest ----

type Field = { n: number; wt: number; v: Uint8Array | bigint };
function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (b < 0x80) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const n = tag >>> 3;
    const wt = tag & 7;
    if (wt === 0) out.push({ n, wt, v: varint() });
    else if (wt === 1) {
      out.push({ n, wt, v: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wt === 2) {
      const len = Number(varint());
      out.push({ n, wt, v: buf.subarray(i, i + len) });
      i += len;
    } else if (wt === 5) {
      out.push({ n, wt, v: buf.subarray(i, i + 4) });
      i += 4;
    } else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}
const str = (v: Uint8Array) => Buffer.from(v).toString("utf8");
const hex = (v: Uint8Array) => Buffer.from(v).toString("hex");
const fixed64 = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true);
const double = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true);
type Attr = string | number | boolean | Attr[] | Record<string, unknown>;
function anyValue(buf: Uint8Array): Attr {
  for (const f of fields(buf)) {
    switch (f.n) {
      case 1:
        return str(f.v as Uint8Array);
      case 2:
        return (f.v as bigint) !== 0n;
      case 3:
        return Number(BigInt.asIntN(64, f.v as bigint));
      case 4:
        return double(f.v as Uint8Array);
      case 5:
        return fields(f.v as Uint8Array).map((x) => anyValue(x.v as Uint8Array));
      case 6:
        return keyValues(f.v as Uint8Array);
      case 7:
        return hex(f.v as Uint8Array);
    }
  }
  throw new Error("empty AnyValue");
}
function keyValues(buf: Uint8Array): Record<string, Attr> {
  const out: Record<string, Attr> = {};
  // Resource.attributes, KeyValueList.values and the span attribute list all carry KeyValue at field 1.
  for (const kv of fields(buf).filter((f) => f.n === 1 && f.wt === 2)) {
    let key = "";
    let value: Attr = "";
    for (const f of fields(kv.v as Uint8Array)) {
      if (f.n === 1) key = str(f.v as Uint8Array);
      if (f.n === 2) value = anyValue(f.v as Uint8Array);
    }
    out[key] = value;
  }
  return out;
}
interface DecodedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  start: bigint;
  end: bigint;
  attributes: Record<string, Attr>;
  status: { code: number; message?: string };
}
function span(buf: Uint8Array): DecodedSpan {
  const s: DecodedSpan = { traceId: "", spanId: "", name: "", kind: 0, start: 0n, end: 0n, attributes: {}, status: { code: 0 } };
  const attrs: Uint8Array[] = [];
  for (const f of fields(buf)) {
    if (f.n === 1) s.traceId = hex(f.v as Uint8Array);
    else if (f.n === 2) s.spanId = hex(f.v as Uint8Array);
    else if (f.n === 4) s.parentSpanId = hex(f.v as Uint8Array);
    else if (f.n === 5) s.name = str(f.v as Uint8Array);
    else if (f.n === 6) s.kind = Number(f.v as bigint);
    else if (f.n === 7) s.start = fixed64(f.v as Uint8Array);
    else if (f.n === 8) s.end = fixed64(f.v as Uint8Array);
    else if (f.n === 9) attrs.push(f.v as Uint8Array);
    else if (f.n === 15) {
      for (const g of fields(f.v as Uint8Array)) {
        if (g.n === 2) s.status.message = str(g.v as Uint8Array);
        if (g.n === 3) s.status.code = Number(g.v as bigint);
      }
    }
  }
  // Attributes are repeated KeyValue messages: wrap them as one KeyValue list for the reader above.
  s.attributes = keyValues(Buffer.concat(attrs.map((a) => Buffer.concat([Buffer.from([0x0a, ...lenVarint(a.length)]), Buffer.from(a)]))));
  return s;
}
function lenVarint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}
interface DecodedRequest {
  resourceSpans: { resource: Record<string, Attr>; scopeSpans: { scope: { name: string; version?: string }; spans: DecodedSpan[] }[] }[];
}
function decodeRequest(body: Buffer): DecodedRequest {
  const resourceSpans: DecodedRequest["resourceSpans"] = [];
  for (const rs of fields(body).filter((f) => f.n === 1)) {
    const entry: DecodedRequest["resourceSpans"][number] = { resource: {}, scopeSpans: [] };
    for (const f of fields(rs.v as Uint8Array)) {
      if (f.n === 1) entry.resource = keyValues(f.v as Uint8Array);
      if (f.n === 2) {
        const ss: DecodedRequest["resourceSpans"][number]["scopeSpans"][number] = { scope: { name: "" }, spans: [] };
        for (const g of fields(f.v as Uint8Array)) {
          if (g.n === 1) for (const h of fields(g.v as Uint8Array)) (h.n === 1 ? (ss.scope.name = str(h.v as Uint8Array)) : h.n === 2 ? (ss.scope.version = str(h.v as Uint8Array)) : undefined);
          if (g.n === 2) ss.spans.push(span(g.v as Uint8Array));
        }
        entry.scopeSpans.push(ss);
      }
    }
    resourceSpans.push(entry);
  }
  return { resourceSpans };
}
/** Every span of a request, in order. */
const spansOf = (r: DecodedRequest) => r.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
// OTLP enum values: SpanKind (INTERNAL 1, CLIENT 3) and StatusCode (UNSET 0, ERROR 2) as the protobuf writes them.
const PB = { INTERNAL: 1, CLIENT: 3, UNSET: 0, ERROR: 2 };

// ---- the receiver ----

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}
class Receiver {
  requests: Received[] = [];
  /** Status codes to answer with, in order; 200 once exhausted. */
  statuses: number[] = [];
  /** Hold every response (never answer), to exercise the timeout. */
  hang = false;
  private server: Server;
  private pending: (() => void)[] = [];
  url = "";
  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
        if (this.hang) {
          this.pending.push(() => res.destroy());
          return;
        }
        const status = this.statuses.shift() ?? 200;
        res.writeHead(status, { "Content-Type": "application/x-protobuf" });
        res.end();
      });
    });
  }
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/traces`;
  }
  async stop() {
    for (const p of this.pending.splice(0)) p();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  decoded(i: number) {
    return decodeRequest(this.requests[i].body);
  }
}

// ---- fixtures ----

const T0 = Date.parse("2026-09-30T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
let dir: string;
let dbPath: string;
let receiver: Receiver;
const opened: Store[] = [];
const exporters: TelemetryExporter[] = [];
let key = 0;
const k = () => `k-${++key}`;
const open = () => {
  const s = new Store(dbPath);
  opened.push(s);
  return s;
};
const exporter = (store: Store, opts: ConstructorParameters<typeof TelemetryExporter>[1] = {}) => {
  const e = new TelemetryExporter(store, { serviceVersion: "0.1.0-test", ...opts });
  exporters.push(e);
  return e;
};
const turnOn = (store: Store, nowMs: number, endpoint = receiver.url, allowRemote = false) => store.command("setTelemetry", { config: { enabled: true, endpoint, allowRemote }, expectedRev: store.read().state.project.telemetry?.rev ?? 0 }, k(), iso(nowMs));
const create = (store: Store, title: string, nowMs: number) => (store.command("createTask", { title, area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }, k(), iso(nowMs)).result as { newId: string }).newId;
/** A task created and cancelled at `nowMs`: settled, with an outcome. */
const settle = (store: Store, title: string, nowMs: number) => {
  const id = create(store, title, nowMs);
  store.command("cancelTask", { taskId: id }, k(), iso(nowMs));
  return id;
};
/** A task whose first step ran (Codex, with usage) before it was cancelled. Every seed task is held so only this one dispatches. */
const settleWithRun = (store: Store, title: string, nowMs: number) => {
  const id = create(store, title, nowMs);
  store.update((s) => {
    const next = M.dispatchEligible(M.leadPromoteProposals(s, iso(nowMs + 1000)), iso(nowMs + 1000));
    const a = M.activeAttempts(next, id)[0];
    const st = next.tasks.find((t) => t.id === id)!.steps.find((x) => x.id === a.stepId)!;
    return M.reportCompletion(next, a.id, [], iso(nowMs + 5000), st.outputs.map((o) => ({ name: o.name, summary: `${o.name} done`, ...(o.kind === "code-change" ? { ref: `${"c".repeat(40)} on orchestration/run` } : {}) })), { usage: { inputTokens: 1000, outputTokens: 200 }, actualModel: "codex-x" });
  }, iso(nowMs + 5000));
  store.command("cancelTask", { taskId: id }, k(), iso(nowMs + 6000));
  return id;
};
const outcomeOf = (store: Store, id: string) => store.read().state.tasks.find((t) => t.id === id)!.outcome!;
const holdSeedTasks = (store: Store) =>
  store.update((s) => {
    const next = structuredClone(s);
    for (const t of next.tasks) t.hold = true;
    return next;
  }, iso(T0));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-otel-"));
  dbPath = join(dir, "test.db");
  receiver = new Receiver();
  await receiver.start();
});
afterEach(async () => {
  for (const e of exporters.splice(0)) await e.shutdown();
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* closed */
    }
  }
  await receiver.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("otlpHeadersFromEnv (review L2)", () => {
  it("reads the general and the traces-specific variable, the traces-specific one winning key by key", () => {
    expect(otlpHeadersFromEnv({})).toEqual({});
    expect(otlpHeadersFromEnv({ OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2" })).toEqual({ a: "1", b: "2" });
    expect(otlpHeadersFromEnv({ OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Basic%20x" })).toEqual({ Authorization: "Basic x" });
    expect(otlpHeadersFromEnv({ OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "b=3" })).toEqual({ a: "1", b: "3" });
  });
});

describe("review fixes", () => {
  it("M1: the status counts settles with no row, even when rows outnumber tasks (a task that settled twice)", () => {
    const store = open();
    const a = settle(store, "a", T0);
    settle(store, "b", T0);
    // Task a has a row for its current settle and one for an older settle that was superseded; b has none.
    store.queueTraceExports([{ taskId: a, settledAt: outcomeOf(store, a).settledAt }, { taskId: a, settledAt: iso(T0 - 60 * MIN) }]);
    const e = exporter(store);
    expect(e.status(store.read().state)).toMatchObject({ pending: 2, unqueued: 1 });
  });

  it("L1: a pass with no new state and nothing due neither reads the state nor writes the queue", async () => {
    const store = open();
    turnOn(store, T0);
    const e = exporter(store);
    await e.pass(T0 + MIN);
    const read = vi.spyOn(store, "read");
    const queue = vi.spyOn(store, "queueTraceExports");
    await e.pass(T0 + 2 * MIN);
    await e.pass(T0 + 3 * MIN);
    expect(read).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    // A new settle changes the state: the next pass reads it, queues the task and sends it.
    settle(store, "new", T0 + 4 * MIN);
    await e.pass(T0 + 5 * MIN);
    expect(read).toHaveBeenCalledTimes(1);
    expect(receiver.requests).toHaveLength(1);
  });

  it("L11: the status shows the most recent error, whether its row is failed or still pending", () => {
    const store = open();
    const x = settle(store, "x", T0);
    const y = settle(store, "y", T0);
    const sx = outcomeOf(store, x).settledAt;
    const sy = outcomeOf(store, y).settledAt;
    store.queueTraceExports([{ taskId: x, settledAt: sx }, { taskId: y, settledAt: sy }]);
    store.markTraceExport(y, sy, { status: "pending", tries: 1, nextAt: T0 + 30 * MIN, error: "older error", at: iso(T0 + MIN) });
    store.markTraceExport(x, sx, { status: "failed", tries: MAX_TRIES, nextAt: null, error: "newest error", at: iso(T0 + 2 * MIN) });
    expect(store.traceExportCounts().lastError).toBe("newest error");
  });
});

describe("parseOtlpHeaders", () => {
  it("reads key=value pairs separated by commas, URL-decoded and trimmed", () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("")).toEqual({});
    expect(parseOtlpHeaders("Authorization=Basic%20cGs6c2s=,x-scope=a%2Cb")).toEqual({ Authorization: "Basic cGs6c2s=", "x-scope": "a,b" });
    expect(parseOtlpHeaders(" a = 1 , b=2=3 ,novalue,=x")).toEqual({ a: "1", b: "2=3" });
    expect(parseOtlpHeaders("Authorization=Basic abc")).toEqual({ Authorization: "Basic abc" });
    expect(parseOtlpHeaders("bad=%E0%A4%A")).toEqual({ bad: "%E0%A4%A" });
  });
});

describe("the trace exporter", () => {
  it("sends nothing while the export is off, and queues nothing", async () => {
    const store = open();
    settle(store, "quiet", T0);
    const e = exporter(store);
    await e.pass(T0 + MIN);
    expect(receiver.requests).toHaveLength(0);
    // Review M1: the settled task with no row is what "Send finished tasks" would queue.
    expect(e.status(store.read().state)).toEqual({ enabled: false, pending: 0, sent: 0, failed: 0, unqueued: 1, headersFromEnv: false });
  });

  it("sends one trace per task settled after the export went on, as OTLP protobuf with the right spans", async () => {
    const store = open();
    holdSeedTasks(store);
    const before = settle(store, "before", T0);
    turnOn(store, T0 + MIN);
    const id = settleWithRun(store, "after", T0 + 2 * MIN);
    const e = exporter(store);
    await e.pass(T0 + 3 * MIN);

    expect(receiver.requests).toHaveLength(1);
    const req = receiver.requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/traces");
    expect(req.headers["content-type"]).toBe("application/x-protobuf");
    const decoded = receiver.decoded(0);
    expect(decoded.resourceSpans).toHaveLength(1);
    expect(decoded.resourceSpans[0].resource).toEqual({ "service.name": "orchestrator", "service.version": "0.1.0-test", "orc.project.id": "sample", "orc.simulated": true });
    expect(decoded.resourceSpans[0].scopeSpans[0].scope).toEqual({ name: "orchestrator", version: "0.1.0-test" });
    const spans = spansOf(decoded);
    expect(spans).toHaveLength(2);
    const o = outcomeOf(store, id);
    const traceId = traceIdFor("sample", id, o.settledAt);
    const [root, run] = spans;
    expect(root).toMatchObject({ traceId, spanId: spanIdFor(traceId, "task"), name: `task ${id}`, kind: PB.INTERNAL, status: { code: PB.UNSET } });
    expect(root.parentSpanId).toBeUndefined();
    expect(root.start).toBe(BigInt(Date.parse(o.createdAt)) * 1_000_000n);
    expect(root.end).toBe(BigInt(Date.parse(o.settledAt)) * 1_000_000n);
    expect(root.attributes).toMatchObject({ "orc.task.id": id, "orc.task.title": "after", "orc.task.result": "cancelled", "orc.pattern.id": "change", "orc.outcome.runs": 1, "orc.outcome.input_tokens": 1000, "orc.outcome.output_tokens": 200, "orc.delivery.status": "not-delivered" });
    const a = store.read().state.attempts.find((x) => x.taskId === id)!;
    expect(run).toMatchObject({ traceId, spanId: spanIdFor(traceId, a.id), parentSpanId: root.spanId, name: "invoke_agent coder", kind: PB.CLIENT, start: BigInt(Date.parse(a.startedAt)) * 1_000_000n, end: BigInt(Date.parse(a.endedAt!)) * 1_000_000n });
    expect(run.attributes).toMatchObject({ "gen_ai.operation.name": "invoke_agent", "gen_ai.provider.name": "openai", "gen_ai.request.model": "codex-sample-large", "gen_ai.response.model": "codex-x", "gen_ai.agent.name": "coder", "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 200, "orc.attempt.id": a.id });

    // Bookkeeping: the settle is `sent`; the task settled before the export went on has no row at all.
    expect(store.traceExport(id, o.settledAt)).toMatchObject({ status: "sent", tries: 0, sentAt: iso(T0 + 3 * MIN), lastError: null });
    expect(store.traceExport(before, outcomeOf(store, before).settledAt)).toBeUndefined();
    expect(e.status(store.read().state)).toEqual({ enabled: true, pending: 0, sent: 1, failed: 0, unqueued: 1, lastSentAt: iso(T0 + 3 * MIN), headersFromEnv: false });
    // Another pass sends nothing more.
    await e.pass(T0 + 4 * MIN);
    expect(receiver.requests).toHaveLength(1);
  });

  it(`sends at most ${BATCH} per pass, one request per task`, async () => {
    const store = open();
    turnOn(store, T0);
    for (let i = 0; i < BATCH + 3; i++) settle(store, `t${i}`, T0 + MIN + i * 1000);
    const e = exporter(store);
    await e.pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(BATCH);
    expect(e.status(store.read().state)).toMatchObject({ pending: 3, sent: BATCH });
    await e.pass(T0 + 3 * MIN);
    expect(receiver.requests).toHaveLength(BATCH + 3);
    for (let i = 0; i < receiver.requests.length; i++) expect(spansOf(receiver.decoded(i))).toHaveLength(1);
    expect(new Set(receiver.requests.map((_r, i) => spansOf(receiver.decoded(i))[0].traceId)).size).toBe(BATCH + 3);
  });

  it("takes headers from the environment variable only, and never exposes them", async () => {
    const store = open();
    turnOn(store, T0);
    settle(store, "with headers", T0 + MIN);
    const headers = parseOtlpHeaders("Authorization=Basic%20cGstMTIzOnNrLTQ1Ng==,x-langfuse-project=p1");
    const e = exporter(store, { headers });
    await e.pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0].headers.authorization).toBe("Basic cGstMTIzOnNrLTQ1Ng==");
    expect(receiver.requests[0].headers["x-langfuse-project"]).toBe("p1");
    const status = e.status(store.read().state);
    expect(status.headersFromEnv).toBe(true);
    expect(JSON.stringify(status)).not.toContain("cGstMTIzOnNrLTQ1Ng");
    expect(JSON.stringify(store.read().state)).not.toContain("cGstMTIzOnNrLTQ1Ng");
    // A header value that a receiver echoes back in an error is redacted before it is kept.
    const logged: string[] = [];
    const store2 = open();
    const e2 = exporter(store2, { headers, log: (m) => logged.push(m) });
    expect(JSON.stringify(logged)).not.toContain("cGstMTIzOnNrLTQ1Ng");
    expect(e2.headersFromEnv).toBe(true);
  });

  it("sends no header that did not come from the environment", async () => {
    const store = open();
    turnOn(store, T0);
    settle(store, "plain", T0 + MIN);
    await exporter(store).pass(T0 + 2 * MIN);
    expect(receiver.requests[0].headers.authorization).toBeUndefined();
    expect(Object.keys(receiver.requests[0].headers).filter((h) => h.startsWith("x-"))).toEqual([]);
  });

  it("backs off after a 500 and retries once it is due: a 500 then a 200 is one retry, then sent", async () => {
    const store = open();
    turnOn(store, T0);
    const id = settle(store, "flaky", T0 + MIN);
    const settledAt = outcomeOf(store, id).settledAt;
    receiver.statuses = [500];
    const logged: string[] = [];
    const e = exporter(store, { log: (m) => logged.push(m) });
    await e.pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(1);
    const row = store.traceExport(id, settledAt)!;
    expect(row).toMatchObject({ status: "pending", tries: 1, nextAt: T0 + 2 * MIN + BACKOFF_MINUTES[0] * MIN });
    expect(row.lastError).toMatch(/500/);
    expect(e.status(store.read().state)).toMatchObject({ pending: 1, sent: 0, failed: 0 });
    expect(e.status(store.read().state).lastError).toMatch(/500/);
    expect(logged.some((m) => m.includes(id) && m.includes("try 1 of 6"))).toBe(true);
    // Not due yet: nothing is sent.
    await e.pass(T0 + 2 * MIN + 30_000);
    expect(receiver.requests).toHaveLength(1);
    // Due: the retry succeeds and the row is sent.
    await e.pass(T0 + 3 * MIN + 1000);
    expect(receiver.requests).toHaveLength(2);
    expect(store.traceExport(id, settledAt)).toMatchObject({ status: "sent", tries: 1, lastError: null });
    expect(spansOf(receiver.decoded(1))[0].traceId).toBe(spansOf(receiver.decoded(0))[0].traceId);
    expect(e.status(store.read().state)).toMatchObject({ pending: 0, sent: 1, failed: 0, lastSentAt: iso(T0 + 3 * MIN + 1000) });
    expect(e.status(store.read().state).lastError).toBeUndefined();
  });

  it(`backs off 1, 5, 15, 30 and 30 minutes, is failed after ${MAX_TRIES} tries, and Retry failed queues it again`, async () => {
    const store = open();
    turnOn(store, T0);
    const id = settle(store, "down", T0 + MIN);
    const settledAt = outcomeOf(store, id).settledAt;
    receiver.statuses = Array(MAX_TRIES).fill(500);
    const e = exporter(store);
    let now = T0 + 2 * MIN;
    const expectedBackoff = [1, 5, 15, 30, 30];
    for (let i = 0; i < MAX_TRIES - 1; i++) {
      await e.pass(now);
      expect(receiver.requests).toHaveLength(i + 1);
      expect(store.traceExport(id, settledAt)).toMatchObject({ status: "pending", tries: i + 1, nextAt: now + expectedBackoff[i] * MIN });
      now = store.traceExport(id, settledAt)!.nextAt!;
    }
    await e.pass(now);
    expect(receiver.requests).toHaveLength(MAX_TRIES);
    expect(store.traceExport(id, settledAt)).toMatchObject({ status: "failed", tries: MAX_TRIES, nextAt: null });
    expect(e.status(store.read().state)).toMatchObject({ pending: 0, sent: 0, failed: 1 });
    await e.pass(now + 60 * MIN);
    expect(receiver.requests).toHaveLength(MAX_TRIES); // failed rows are not retried by themselves
    expect(e.retryFailed()).toBe(1);
    expect(store.traceExport(id, settledAt)).toMatchObject({ status: "pending", tries: 0, nextAt: null });
    await e.pass(now + 61 * MIN);
    expect(receiver.requests).toHaveLength(MAX_TRIES + 1);
    expect(store.traceExport(id, settledAt)).toMatchObject({ status: "sent" });
    expect(e.retryFailed()).toBe(0);
  });

  it("gives up on a request after the timeout and backs off like any failure", async () => {
    expect(TIMEOUT_MS).toBe(10_000);
    const store = open();
    turnOn(store, T0);
    const id = settle(store, "slow", T0 + MIN);
    receiver.hang = true;
    const e = exporter(store, { timeoutMs: 300 });
    await e.pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(1);
    const row = store.traceExport(id, outcomeOf(store, id).settledAt)!;
    expect(row).toMatchObject({ status: "pending", tries: 1 });
    expect(row.lastError).toBeTruthy();
  });

  it("sends no duplicate after a restart: a new store and exporter on the same database", async () => {
    const store = open();
    turnOn(store, T0);
    const id = settle(store, "once", T0 + MIN);
    const settledAt = outcomeOf(store, id).settledAt;
    await exporter(store).pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(1);
    store.close();

    const again = open();
    const e2 = exporter(again);
    await e2.pass(T0 + 3 * MIN);
    await e2.pass(T0 + 4 * MIN);
    expect(receiver.requests).toHaveLength(1);
    expect(again.traceExport(id, settledAt)).toMatchObject({ status: "sent" });
    expect(e2.status(again.read().state)).toMatchObject({ sent: 1, pending: 0 });
    // A task settled after the restart is sent once.
    settle(again, "later", T0 + 5 * MIN);
    await e2.pass(T0 + 6 * MIN);
    expect(receiver.requests).toHaveLength(2);
  });

  it("drops a queued settle that no longer matches the task's outcome", async () => {
    const store = open();
    turnOn(store, T0);
    const id = settle(store, "stale", T0 + MIN);
    store.queueTraceExports([{ taskId: id, settledAt: iso(T0 - MIN) }, { taskId: "T-nope", settledAt: iso(T0) }]);
    const e = exporter(store);
    await e.pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(1);
    expect(store.traceExport(id, iso(T0 - MIN))).toBeUndefined();
    expect(store.traceExport("T-nope", iso(T0))).toBeUndefined();
    expect(e.status(store.read().state)).toMatchObject({ pending: 0, sent: 1, failed: 0 });
  });

  it("backfill queues every settled task with an outcome that has no row, whatever enabledAt says", async () => {
    const store = open();
    const a = settle(store, "old 1", T0);
    const b = settle(store, "old 2", T0 + 1000);
    turnOn(store, T0 + MIN);
    const e = exporter(store);
    await e.pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(0);
    expect(e.backfill()).toBe(2);
    expect(e.backfill()).toBe(0);
    await e.pass(T0 + 3 * MIN);
    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests.map((_r, i) => spansOf(receiver.decoded(i))[0].attributes["orc.task.id"]).sort()).toEqual([a, b].sort());
    expect(e.status(store.read().state)).toMatchObject({ sent: 2, pending: 0 });
    // A done seed task without an outcome (settled before outcomes existed) is never queued.
    expect(store.read().state.tasks.some((t) => t.lifecycle === "done" && !t.outcome)).toBe(true);
  });

  it("runs on the scheduler lease holder only: an observer instance sends nothing", async () => {
    const store = open();
    turnOn(store, T0);
    const first = settle(store, "held", T0 + MIN);
    const config = defaultFakeConfig();
    const adapters = () => ({ claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
    const eA = exporter(store);
    const eB = exporter(store);
    const a = new Scheduler(store, adapters(), { leaseMs: 60_000, telemetry: eA });
    const b = new Scheduler(store, adapters(), { leaseMs: 60_000, telemetry: eB });
    a.auto = false;
    b.auto = false;
    try {
      // A takes the lease (60 s) and exports; B ticks while that lease is live, so it stays an observer.
      const t = T0 + 2 * MIN;
      a.tick(t);
      expect(a.active).toBe(true);
      await eA.idle();
      expect(receiver.requests).toHaveLength(1);
      expect(store.traceExport(first, outcomeOf(store, first).settledAt)).toMatchObject({ status: "sent" });

      const second = settle(store, "second", t + 10_000);
      for (let i = 0; i < 3; i++) b.tick(t + 20_000 + i * 1000);
      expect(b.active).toBe(false);
      await eB.idle();
      expect(receiver.requests).toHaveLength(1);
      expect(store.traceExport(second, outcomeOf(store, second).settledAt)).toBeUndefined();

      a.tick(t + 30_000);
      await eA.idle();
      expect(receiver.requests).toHaveLength(2);
      expect(spansOf(receiver.decoded(1))[0].attributes["orc.task.id"]).toBe(second);
      // The exporter alone would send: the gate is the scheduler's.
      const third = settle(store, "third", t + 40_000);
      await eB.pass(t + 45_000);
      expect(receiver.requests).toHaveLength(3);
      expect(spansOf(receiver.decoded(2))[0].attributes["orc.task.id"]).toBe(third);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("stops sending once the export is turned off, and sends only new settles when it is turned on again", async () => {
    const store = open();
    turnOn(store, T0);
    settle(store, "one", T0 + MIN);
    const e = exporter(store);
    await e.pass(T0 + 2 * MIN);
    expect(receiver.requests).toHaveLength(1);
    store.command("setTelemetry", { config: { enabled: false, endpoint: receiver.url, allowRemote: false }, expectedRev: 1 }, k(), iso(T0 + 3 * MIN));
    const whileOff = settle(store, "while off", T0 + 4 * MIN);
    await e.pass(T0 + 5 * MIN);
    expect(receiver.requests).toHaveLength(1);
    turnOn(store, T0 + 6 * MIN);
    const after = settle(store, "after", T0 + 7 * MIN);
    await e.pass(T0 + 8 * MIN);
    expect(receiver.requests).toHaveLength(2);
    expect(spansOf(receiver.decoded(1))[0].attributes["orc.task.id"]).toBe(after);
    expect(store.traceExport(whileOff, outcomeOf(store, whileOff).settledAt)).toBeUndefined();
  });
});

describe("the telemetry endpoints", () => {
  let base = "";
  let close = () => {};
  let store: Store;
  let e: TelemetryExporter;
  beforeEach(async () => {
    store = open();
    e = exporter(store);
    const fakeConfig = defaultFakeConfig();
    const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", fakeConfig), codex: new FakeAdapter("codex", fakeConfig) });
    const probe = createHttpServer({ store, scheduler, fakeConfig, telemetry: e, startedAt: iso(T0), allowedHosts: [] });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createHttpServer({ store, scheduler, fakeConfig, telemetry: e, startedAt: iso(T0), allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    base = `http://127.0.0.1:${port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
    };
  });
  afterEach(() => close());
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = { [CLIENT_HEADER]: "1" }) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (r: Response) => r.json() as Promise<any>;

  it("reports the export's status in ServiceInfo, without any header", async () => {
    settle(store, "x", T0);
    const info = (await j(await fetch(base + "/api/state"))).service as ServiceInfo;
    expect(info.telemetry).toEqual({ enabled: false, pending: 0, sent: 0, failed: 0, unqueued: 1, headersFromEnv: false });
    const text = JSON.stringify(await j(await fetch(base + "/api/health")));
    expect(text).toContain('"headersFromEnv":false');
  });

  it("backfill needs the export on, then queues the older settles; retry re-queues failed rows", async () => {
    settle(store, "old", T0);
    const off = await post("/api/telemetry/backfill");
    expect(off.status).toBe(400);
    expect(await j(off)).toMatchObject({ kind: "control", error: expect.stringMatching(/Turn on Send traces first/) });
    turnOn(store, T0 + MIN);
    const on = await post("/api/telemetry/backfill");
    expect(on.status).toBe(200);
    expect(await j(on)).toMatchObject({ queued: 1, service: { telemetry: { enabled: true, pending: 1, sent: 0 } } });
    expect(await j(await post("/api/telemetry/backfill"))).toMatchObject({ queued: 0 });
    receiver.statuses = Array(MAX_TRIES).fill(500);
    let now = T0 + 2 * MIN;
    for (let i = 0; i < MAX_TRIES; i++) {
      await e.pass(now);
      now += 31 * MIN;
    }
    expect(e.status(store.read().state)).toMatchObject({ failed: 1 });
    const retry = await post("/api/telemetry/retry");
    expect(retry.status).toBe(200);
    expect(await j(retry)).toMatchObject({ retried: 1, service: { telemetry: { pending: 1, failed: 0 } } });
    await e.pass(now);
    expect(receiver.requests).toHaveLength(MAX_TRIES + 1);
    expect((await j(await fetch(base + "/api/state"))).service.telemetry).toMatchObject({ sent: 1, pending: 0, failed: 0 });
  });

  it("has the same protections as other POSTs: the client header, the origin, and the method", async () => {
    turnOn(store, T0);
    expect((await post("/api/telemetry/backfill", {}, {})).status).toBe(403);
    expect((await post("/api/telemetry/retry", {}, { [CLIENT_HEADER]: "1", Origin: "http://evil.example" })).status).toBe(403);
    expect((await fetch(base + "/api/telemetry/retry")).status).toBe(404); // GET: not a route
    expect((await fetch(base + "/api/telemetry/backfill", { method: "POST", headers: { [CLIENT_HEADER]: "1" } })).status).toBe(415);
  });

  it("applies setTelemetry through the command endpoint and answers 409 to a stale revision", async () => {
    const ok = await post("/api/commands", { name: "setTelemetry", args: { config: { enabled: true, endpoint: receiver.url, allowRemote: false }, expectedRev: 0 }, idempotencyKey: k() });
    expect(ok.status).toBe(200);
    const stale = await post("/api/commands", { name: "setTelemetry", args: { config: { enabled: false, endpoint: receiver.url, allowRemote: false }, expectedRev: 0 }, idempotencyKey: k() });
    expect(stale.status).toBe(409);
    expect(await j(stale)).toMatchObject({ kind: "stale" });
    const remote = await post("/api/commands", { name: "setTelemetry", args: { config: { enabled: true, endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces", allowRemote: false }, expectedRev: 1 }, idempotencyKey: k() });
    expect(remote.status).toBe(400);
    expect(await j(remote)).toMatchObject({ kind: "control", error: expect.stringMatching(/not this computer/) });
  });
});

describe("the pinned semantic conventions", () => {
  it("name the attributes the trace uses (gen_ai.provider.name exists in 1.43.0; gen_ai.system is not used)", () => {
    expect(GEN_AI.operationName).toBe(ATTR_GEN_AI_OPERATION_NAME);
    expect(GEN_AI.invokeAgent).toBe(GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT);
    expect(GEN_AI.providerName).toBe(ATTR_GEN_AI_PROVIDER_NAME);
    expect(GEN_AI.requestModel).toBe(ATTR_GEN_AI_REQUEST_MODEL);
    expect(GEN_AI.responseModel).toBe(ATTR_GEN_AI_RESPONSE_MODEL);
    expect(GEN_AI.agentName).toBe(ATTR_GEN_AI_AGENT_NAME);
    expect(GEN_AI.conversationId).toBe(ATTR_GEN_AI_CONVERSATION_ID);
    expect(GEN_AI.inputTokens).toBe(ATTR_GEN_AI_USAGE_INPUT_TOKENS);
    expect(GEN_AI.outputTokens).toBe(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS);
    expect(GEN_AI.errorType).toBe(ATTR_ERROR_TYPE);
    expect(GEN_AI.serviceName).toBe(ATTR_SERVICE_NAME);
    expect(GEN_AI.serviceVersion).toBe(ATTR_SERVICE_VERSION);
    expect(PROVIDER_NAMES).toEqual({ claude: GEN_AI_PROVIDER_NAME_VALUE_ANTHROPIC, codex: GEN_AI_PROVIDER_NAME_VALUE_OPENAI });
  });
});
