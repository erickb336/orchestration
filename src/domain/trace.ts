// ORC-018 §5.3: one settled task as an OpenTelemetry trace, pure. A task span, one `invoke_agent` span per
// finished agent attempt and one `orc.checks` span per service check run, with deterministic ids so the
// same settle always makes the same trace (a resend after a crash is the same trace to a viewer).
//
// Only what is listed here leaves the computer: ids, the title and area, pattern provenance, the outcome's
// numbers, delivery status, roles, models, session ids, timings and usage. Never spec text, prompts,
// outputs, artifacts, findings, file or repository paths, branch names, commits, the vision, user names or
// credentials (design §5.3). The attribute names follow the GenAI semantic conventions pinned in
// @opentelemetry/semantic-conventions 1.43.0 (`gen_ai.provider.name`, not the older `gen_ai.system`); the
// server's tests check each literal against the package's own exports.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { measuresOf, type MeasureId } from "./compare";
import { currentSpec } from "./model";
import { deliveryOutcome, roleOfAttempt } from "./outcomes";
import { isProvider, type Attempt, type ProviderId, type State, type Task } from "./types";

export type AttributeValue = string | number | boolean;
export type SpanKindName = "INTERNAL" | "CLIENT";
export type SpanStatusName = "UNSET" | "OK" | "ERROR";

/** A plain span record; `server/telemetry.ts` adapts it to the SDK's `ReadableSpan`. Times are nanoseconds since the epoch. */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKindName;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, AttributeValue>;
  status: { code: SpanStatusName; message?: string };
}

export interface TaskTrace {
  traceId: string;
  /** `service.name`, `service.version`, `orc.project.id`, and `orc.simulated` for the sample project. */
  resource: Record<string, AttributeValue>;
  /** The task span first, then the attempts in start order. */
  spans: SpanRecord[];
}

export interface TraceOptions {
  /** `service.version`: the app's package version (the server reads package.json). */
  serviceVersion?: string;
}

// GenAI semantic conventions (incubating), as pinned.
export const GEN_AI = {
  operationName: "gen_ai.operation.name",
  invokeAgent: "invoke_agent",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  agentName: "gen_ai.agent.name",
  conversationId: "gen_ai.conversation.id",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  errorType: "error.type",
  serviceName: "service.name",
  serviceVersion: "service.version",
} as const;

/** ORC-016 design §10.4: the sign-in path is not recorded, so Claude is `anthropic` and Codex is `openai`. */
export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: "anthropic", codex: "openai" };

/** The task span's `orc.outcome.*` attribute for each measure (design §3.2): durations in ms, cost in USD, rates as booleans. */
const OUTCOME_ATTRS: Record<MeasureId, { name: string; boolean?: true }> = {
  timeToDone: { name: "orc.outcome.time_to_done_ms" },
  agentTime: { name: "orc.outcome.agent_time_ms" },
  runs: { name: "orc.outcome.runs" },
  inputTokens: { name: "orc.outcome.input_tokens" },
  outputTokens: { name: "orc.outcome.output_tokens" },
  cost: { name: "orc.outcome.cost_usd" },
  repairRounds: { name: "orc.outcome.repair_rounds" },
  findingsRaised: { name: "orc.outcome.findings_raised" },
  errorsRaised: { name: "orc.outcome.errors_raised" },
  openAtEnd: { name: "orc.outcome.open_at_end" },
  firstPassChecks: { name: "orc.outcome.first_pass_checks", boolean: true },
  failedCheckRuns: { name: "orc.outcome.failed_check_runs" },
  reviewComplete: { name: "orc.outcome.review_complete" },
  humanTouches: { name: "orc.outcome.human_touches" },
  landed: { name: "orc.outcome.landed", boolean: true },
  sentBack: { name: "orc.outcome.sent_back", boolean: true },
  timeToLanded: { name: "orc.outcome.time_to_landed_ms" },
};

const hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));
/** The first 32 hex characters of sha256("orc-trace|" + projectId + "|" + taskId + "|" + settledAt). */
export const traceIdFor = (projectId: string, taskId: string, settledAt: string) => hex(`orc-trace|${projectId}|${taskId}|${settledAt}`).slice(0, 32);
/** The first 16 hex characters of sha256(traceId + "|" + part), where `part` is "task" or an attempt id. */
export const spanIdFor = (traceId: string, part: string) => hex(`${traceId}|${part}`).slice(0, 16);
const nanos = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;

/** The spans of one settled task. The task must carry an outcome; `settledAt` names the settle being exported. */
export function buildTaskTrace(state: State, task: Task, settledAt: string, opts: TraceOptions = {}): TaskTrace {
  const o = task.outcome;
  if (!o) throw new Error(`${task.id} has no outcome to export`);
  const traceId = traceIdFor(state.project.id, task.id, settledAt);
  const resource: Record<string, AttributeValue> = {
    [GEN_AI.serviceName]: "orchestrator",
    [GEN_AI.serviceVersion]: opts.serviceVersion ?? "unknown",
    "orc.project.id": state.project.id,
    ...(state.project.sample ? { "orc.simulated": true } : {}),
  };

  // The task span: created (or first run) → settled.
  const spec = currentSpec(task)?.content;
  const attrs: Record<string, AttributeValue> = {
    "orc.task.id": task.id,
    "orc.task.title": spec?.title ?? task.id,
    "orc.task.area": spec?.area ?? "",
    "orc.task.result": o.result,
    "orc.pattern.id": o.pattern.id,
    "orc.pattern.name": o.pattern.name,
    ...(o.pattern.hash ? { "orc.pattern.hash": o.pattern.hash } : {}),
    "orc.pattern.source": o.pattern.source,
    "orc.pattern.experimental": !!o.pattern.experimental,
    "orc.pattern.chosen_by": o.pattern.chosenBy,
  };
  const m = measuresOf(task, o);
  for (const [id, def] of Object.entries(OUTCOME_ATTRS) as [MeasureId, (typeof OUTCOME_ATTRS)[MeasureId]][]) {
    const v = m[id];
    if (v === undefined) continue;
    attrs[def.name] = def.boolean ? v === 1 : v;
  }
  for (const [severity, n] of Object.entries(o.findings.raised)) attrs[`orc.outcome.findings.${severity}`] = n;
  const d = deliveryOutcome(task);
  attrs["orc.delivery.status"] = d.status;
  if (d.landedBy) attrs["orc.delivery.landed_by"] = d.landedBy;
  if (d.sentBack) attrs["orc.delivery.sent_back"] = d.sentBack;
  const taskSpanId = spanIdFor(traceId, "task");
  const spans: SpanRecord[] = [
    {
      traceId,
      spanId: taskSpanId,
      name: `task ${task.id}`,
      kind: "INTERNAL",
      startTimeUnixNano: nanos(o.createdAt || o.firstRunAt || settledAt),
      endTimeUnixNano: nanos(settledAt),
      attributes: attrs,
      status: { code: "UNSET" },
    },
  ];

  // One child span per finished attempt; a run still active at settle has no end and is left out.
  const attempts = state.attempts.filter((a) => a.taskId === task.id && a.endedAt).sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  for (const a of attempts) spans.push(isProvider(a.snapshot.provider) ? agentSpan(task, a, traceId, taskSpanId) : checkSpan(state, a, traceId, taskSpanId));
  return { traceId, resource, spans };
}

function agentSpan(task: Task, a: Attempt, traceId: string, parentSpanId: string): SpanRecord {
  const role = roleOfAttempt(task, a);
  const failed = a.outcome === "failed" || a.outcome === "lost";
  const attributes: Record<string, AttributeValue> = {
    [GEN_AI.operationName]: GEN_AI.invokeAgent,
    [GEN_AI.providerName]: PROVIDER_NAMES[a.snapshot.provider as ProviderId],
    [GEN_AI.requestModel]: a.snapshot.model,
    ...(a.actualModel ? { [GEN_AI.responseModel]: a.actualModel } : {}),
    [GEN_AI.agentName]: role,
    ...(a.sessionId ? { [GEN_AI.conversationId]: a.sessionId } : {}),
    ...(a.usage?.inputTokens !== undefined ? { [GEN_AI.inputTokens]: a.usage.inputTokens } : {}),
    ...(a.usage?.outputTokens !== undefined ? { [GEN_AI.outputTokens]: a.usage.outputTokens } : {}),
    ...(a.usage?.costUsd !== undefined ? { "orc.cost.usd": a.usage.costUsd } : {}),
    "orc.step.id": a.stepId,
    "orc.attempt.id": a.id,
    "orc.attempt.outcome": a.outcome,
    ...(failed ? { [GEN_AI.errorType]: a.outcome } : {}),
  };
  return {
    traceId,
    spanId: spanIdFor(traceId, a.id),
    parentSpanId,
    name: `${GEN_AI.invokeAgent} ${role}`,
    kind: "CLIENT",
    startTimeUnixNano: nanos(a.startedAt),
    endTimeUnixNano: nanos(a.endedAt!),
    attributes,
    status: failed ? { code: "ERROR", message: a.outcome } : { code: "UNSET" },
  };
}

function checkSpan(state: State, a: Attempt, traceId: string, parentSpanId: string): SpanRecord {
  const run = state.artifacts.find((x) => x.attemptId === a.id && x.checkRun)?.checkRun;
  const results = run?.results ?? [];
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "timed-out").length;
  const sandbox = run?.sandbox ?? a.snapshot.checks?.sandbox;
  const error = failed > 0 || a.outcome === "failed" || a.outcome === "lost";
  return {
    traceId,
    spanId: spanIdFor(traceId, a.id),
    parentSpanId,
    name: "orc.checks",
    kind: "INTERNAL",
    startTimeUnixNano: nanos(a.startedAt),
    endTimeUnixNano: nanos(a.endedAt!),
    attributes: {
      "orc.step.id": a.stepId,
      "orc.attempt.id": a.id,
      "orc.checks.passed": passed,
      "orc.checks.failed": failed,
      ...(sandbox ? { "orc.checks.sandbox": sandbox } : {}),
      "orc.attempt.outcome": a.outcome,
      ...(a.outcome === "failed" || a.outcome === "lost" ? { [GEN_AI.errorType]: a.outcome } : {}),
    },
    status: error ? { code: "ERROR", message: failed > 0 ? `${failed} check${failed === 1 ? "" : "s"} failed` : a.outcome } : { code: "UNSET" },
  };
}
