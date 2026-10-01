// ORC-018 B1 §5.3: one settled task as a trace, pure. Deterministic ids, the resource, the task span, one
// `invoke_agent` span per finished agent attempt and one `orc.checks` span per check run, with the
// attributes of the table; and the never-included list, checked with sentinels planted in the fixture.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import * as C from "./checks";
import * as M from "./model";
import { captureOutcomes } from "./outcomes";
import { buildSeed } from "./seed";
import { buildTaskTrace, GEN_AI, spanIdFor, traceIdFor, type SpanRecord } from "./trace";
import { DEFAULT_CHECKS, type CheckRunRecord, type Finding, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ns = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const go = (s: State, t: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(t)), at(t), { checksHeld: false });
const hex = (x: string) => bytesToHex(sha256(utf8ToBytes(x)));
const SHA = "a".repeat(40);
const SENTINELS = {
  spec: "SENTINEL-SPEC-TEXT",
  approach: "SENTINEL-APPROACH",
  artifact: "SENTINEL-ARTIFACT-SUMMARY",
  repo: "SENTINEL-REPO-PATH",
  vision: "SENTINEL-VISION",
  workspace: "SENTINEL-WORKSPACE",
  branch: "SENTINEL-BRANCH",
  commit: "SENTINEL-COMMIT",
  user: "SENTINEL-USER",
  note: "SENTINEL-NOTE",
  prompt: "SENTINEL-PURPOSE",
};

function record(sha: string, status: "passed" | "failed"): CheckRunRecord {
  return { sha, configRev: 1, sandbox: "codex", touchedInputs: [], results: [{ id: "test", label: "test", kind: "check", status, exitCode: status === "failed" ? 1 : 0, durationMs: 1000, excerpt: status === "failed" ? "1 failing" : "", bytes: 0, truncated: false }, { id: "lint", label: "lint", kind: "check", status: "passed", exitCode: 0, durationMs: 500, excerpt: "", bytes: 0, truncated: false }], durationMs: 1500 };
}
function finding(): Finding {
  return { id: "F1", key: "key1".padEnd(12, "0"), source: "review", severity: "error", action: "auto-fix", title: "Finding", detail: "what is wrong" };
}
/** Complete the running attempt with every declared output; summaries carry the artifact sentinel. */
function finish(s: State, id: string, t: number, o: { findings?: Finding[]; check?: CheckRunRecord; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }; actualModel?: string } = {}): State {
  const a = running(s, id)[0];
  const st = task(s, id).steps.find((x) => x.id === a.stepId)!;
  const outputs = st.outputs.map((d) => ({
    name: d.name,
    summary: `${SENTINELS.artifact} ${d.name} at ${t}`,
    ...(d.kind === "review-findings" ? { findings: o.findings ?? [], reviewedPaths: ["a.ts"] } : {}),
    ...(d.kind === "code-change" ? { ref: `${SENTINELS.commit} on ${SENTINELS.branch}` } : {}),
    ...(d.kind === "check-results" ? { checkRun: o.check ?? record(SHA, "passed"), findings: C.findingsFromRun(o.check ?? record(SHA, "passed")) } : {}),
  }));
  return M.reportCompletion(s, a.id, [], at(t), outputs, { ...(o.usage ? { usage: o.usage } : {}), ...(o.actualModel ? { actualModel: o.actualModel } : {}) });
}

/**
 * A Change task with checks on: S1 (Codex, usage and actual model) → C1 fails a check → S2 (Claude, one
 * finding, a session id) → S3 fails (`error.type`) → retried S3 is still running when the task is
 * cancelled. Sentinels sit in the spec, the vision, the repository path, the workspace, the artifacts,
 * the code reference and the run's note.
 */
function scenario(): { s: State; id: string; settledAt: string } {
  const s0 = buildSeed(T0, { inFlightRuns: false });
  for (const t of s0.tasks) t.hold = true;
  s0.project.checks = { ...structuredClone(DEFAULT_CHECKS), enabled: true, rev: 1, commands: [{ id: "test", label: "test", kind: "check", argv: ["npm", "test"] }] };
  s0.project.repoPath = `/Users/someone/${SENTINELS.repo}`;
  s0.project.visions[s0.project.visions.length - 1].text = `${SENTINELS.vision} the vision`;
  const created = M.createTask(s0, { title: "Export traces", area: "Observability", outcome: SENTINELS.spec, benefit: "b", whyNow: "", approach: SENTINELS.approach, acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }, at(0));
  const id = created.newId;
  let s = M.dispatchEligible(M.leadPromoteProposals(created.state, at(1)), at(1), { checksHeld: false, workspaceFor: (_t, _st, a) => `/tmp/${SENTINELS.workspace}/${a}` });
  expect(running(s, id)[0].stepId).toBe("S1");
  s = finish(s, id, 2, { usage: { inputTokens: 1000, outputTokens: 200 }, actualModel: "codex-x" });
  s = go(s, 3);
  expect(running(s, id)[0].stepId).toBe("C1");
  s = finish(s, id, 4, { check: record(SHA, "failed") });
  s = go(s, 5);
  expect(running(s, id)[0].stepId).toBe("S2");
  const review = running(s, id)[0];
  s = structuredClone(s);
  const r = s.attempts.find((a) => a.id === review.id)!;
  r.sessionId = "claude-session-42";
  r.note = SENTINELS.note;
  s = M.reportRunContext(s, review.id, { scope: { from: "b".repeat(40), to: SHA, paths: ["a.ts"], total: 1 } });
  s = finish(s, id, 6, { findings: [finding()], usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.25 } });
  s = go(s, 7);
  expect(running(s, id)[0].stepId).toBe("S3");
  s = M.reportRunFailed(s, running(s, id)[0].id, `boom ${SENTINELS.note}`, at(8));
  s = M.retryStep(s, id, "S3", at(9));
  s = go(s, 9);
  expect(running(s, id)[0].stepId).toBe("S3");
  s = structuredClone(s);
  for (const a of s.attempts) a.snapshot.purpose = `${SENTINELS.prompt} ${a.snapshot.purpose}`;
  // Cancel with S3 still running: it is stopping, with no end, at settle.
  const before = s;
  const next = M.cancelTask(s, id, at(10));
  const settled = captureOutcomes(before, next, at(10));
  expect(task(settled, id).outcome).toBeDefined();
  return { s: settled, id, settledAt: at(10) };
}

/** Serialise with bigints as strings, for searching. */
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

describe("buildTaskTrace", () => {
  const { s, id, settledAt } = scenario();
  const trace = buildTaskTrace(s, task(s, id), settledAt, { serviceVersion: "0.1.0-test" });
  const byName = (n: string) => trace.spans.filter((x) => x.name === n);
  const root = trace.spans[0];

  it("derives the trace and span ids from the project, task and settle, so a resend is the same trace", () => {
    expect(trace.traceId).toBe(hex(`orc-trace|sample|${id}|${settledAt}`).slice(0, 32));
    expect(trace.traceId).toBe(traceIdFor("sample", id, settledAt));
    expect(root.spanId).toBe(hex(`${trace.traceId}|task`).slice(0, 16));
    expect(root.spanId).toBe(spanIdFor(trace.traceId, "task"));
    for (const sp of trace.spans.slice(1)) expect(sp.spanId).toBe(hex(`${trace.traceId}|${sp.attributes["orc.attempt.id"]}`).slice(0, 16));
    expect(new Set(trace.spans.map((x) => x.spanId)).size).toBe(trace.spans.length);
    expect(buildTaskTrace(s, task(s, id), settledAt, { serviceVersion: "0.1.0-test" })).toEqual(trace);
    expect(buildTaskTrace(s, task(s, id), at(11)).traceId).not.toBe(trace.traceId);
  });

  it("describes the resource: service name and version, the project id, and orc.simulated for the sample only", () => {
    expect(trace.resource).toEqual({ "service.name": "orchestrator", "service.version": "0.1.0-test", "orc.project.id": "sample", "orc.simulated": true });
    const real = structuredClone(s);
    real.project.sample = false;
    real.project.id = "p-real";
    const t2 = buildTaskTrace(real, task(real, id), settledAt);
    expect(t2.resource).toEqual({ "service.name": "orchestrator", "service.version": "unknown", "orc.project.id": "p-real" });
    expect(t2.traceId).not.toBe(trace.traceId);
  });

  it("has a task root span from creation to settle with the task, pattern, outcome and delivery attributes", () => {
    const t = task(s, id);
    expect(root).toMatchObject({ name: `task ${id}`, kind: "INTERNAL", traceId: trace.traceId, status: { code: "UNSET" } });
    expect(root.parentSpanId).toBeUndefined();
    expect(root.startTimeUnixNano).toBe(ns(t.outcome!.createdAt));
    expect(root.endTimeUnixNano).toBe(ns(settledAt));
    expect(root.attributes).toMatchObject({
      "orc.task.id": id,
      "orc.task.title": "Export traces",
      "orc.task.area": "Observability",
      "orc.task.result": "cancelled",
      "orc.pattern.id": "change",
      "orc.pattern.name": "Change",
      "orc.pattern.hash": t.outcome!.pattern.hash,
      "orc.pattern.source": "built-in",
      "orc.pattern.experimental": false,
      "orc.pattern.chosen_by": "user",
      "orc.outcome.time_to_done_ms": 9_000,
      "orc.outcome.runs": 4,
      "orc.outcome.repair_rounds": 0,
      "orc.outcome.findings_raised": 2,
      "orc.outcome.errors_raised": 2,
      "orc.outcome.findings.error": 2,
      "orc.outcome.findings.warning": 0,
      "orc.outcome.findings.info": 0,
      "orc.outcome.failed_check_runs": 1,
      "orc.outcome.review_complete": true,
      "orc.outcome.human_touches": 0,
      "orc.delivery.status": "not-delivered",
    });
    expect(root.attributes["orc.outcome.agent_time_ms"]).toBe(t.outcome!.agentMs);
    // Tokens and cost: the failed S3 run reported no usage, so neither is known; a missing number is absent, never 0.
    expect(root.attributes["orc.outcome.input_tokens"]).toBeUndefined();
    expect(root.attributes["orc.outcome.cost_usd"]).toBeUndefined();
    expect("orc.outcome.cost_usd" in root.attributes).toBe(false);
    // The final checks never ran, nothing landed: no first-pass rate, landed is false, no sent-back or time to landed.
    expect(root.attributes["orc.outcome.first_pass_checks"]).toBeUndefined();
    expect(root.attributes["orc.outcome.landed"]).toBe(false);
    expect(root.attributes["orc.outcome.sent_back"]).toBeUndefined();
    expect(root.attributes["orc.delivery.landed_by"]).toBeUndefined();
  });

  it("records landed, sent-back delivery and the landed rate on the task span", () => {
    const s2 = structuredClone(s);
    const t = task(s2, id);
    t.integration = { status: "integrated", landed: { at: at(20), via: "pr", target: SENTINELS.branch, commit: SENTINELS.commit, by: "person", mergedBy: SENTINELS.user, flags: [], status: "sent-back", notes: [], followUps: [{ taskId: "R", kind: "revert" }] } };
    const tr = buildTaskTrace(s2, t, settledAt);
    expect(tr.spans[0].attributes).toMatchObject({ "orc.outcome.landed": true, "orc.outcome.sent_back": true, "orc.outcome.time_to_landed_ms": Date.parse(at(20)) - Date.parse(t.outcome!.firstRunAt!), "orc.delivery.status": "landed", "orc.delivery.landed_by": "person", "orc.delivery.sent_back": "revert" });
    const text = json(tr);
    for (const k of ["branch", "commit", "user"] as const) expect(text, k).not.toContain(SENTINELS[k]);
  });

  it("makes one invoke_agent CLIENT span per finished agent attempt, with the GenAI attributes, and leaves the running one out", () => {
    const attempts = s.attempts.filter((a) => a.taskId === id);
    expect(attempts).toHaveLength(5); // S1, C1, S2, S3 (failed), S3 (stopping)
    expect(attempts.filter((a) => !a.endedAt)).toHaveLength(1);
    expect(trace.spans).toHaveLength(5); // task + 4 finished attempts
    for (const sp of trace.spans.slice(1)) expect(sp.parentSpanId).toBe(root.spanId);
    const [coder, reviewer, repair] = byName("invoke_agent coder").concat(byName("invoke_agent code_reviewer")).sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1)) as [SpanRecord, SpanRecord, SpanRecord];
    const s1 = attempts.find((a) => a.stepId === "S1")!;
    expect(coder).toMatchObject({ name: "invoke_agent coder", kind: "CLIENT", startTimeUnixNano: ns(s1.startedAt), endTimeUnixNano: ns(s1.endedAt!), status: { code: "UNSET" } });
    expect(coder.attributes).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "codex-sample-large",
      "gen_ai.response.model": "codex-x",
      "gen_ai.agent.name": "coder",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 200,
      "orc.step.id": "S1",
      "orc.attempt.id": s1.id,
      "orc.attempt.outcome": "completed",
    });
    const s2 = attempts.find((a) => a.stepId === "S2")!;
    expect(reviewer.attributes).toMatchObject({ "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-sample-large", "gen_ai.agent.name": "code_reviewer", "gen_ai.conversation.id": "claude-session-42", "gen_ai.usage.input_tokens": 500, "gen_ai.usage.output_tokens": 100, "orc.cost.usd": 0.25, "orc.step.id": "S2", "orc.attempt.id": s2.id });
    expect(reviewer.attributes["gen_ai.response.model"]).toBeUndefined();
    const failed = attempts.find((a) => a.stepId === "S3" && a.outcome === "failed")!;
    expect(repair).toMatchObject({ name: "invoke_agent coder", status: { code: "ERROR", message: "failed" }, endTimeUnixNano: ns(failed.endedAt!) });
    expect(repair.attributes).toMatchObject({ "error.type": "failed", "orc.attempt.outcome": "failed", "orc.attempt.id": failed.id });
    expect(repair.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("makes an orc.checks INTERNAL span per check run, in error when a check failed", () => {
    const [checks] = byName("orc.checks");
    const c1 = s.attempts.find((a) => a.taskId === id && a.stepId === "C1")!;
    expect(checks).toMatchObject({ kind: "INTERNAL", parentSpanId: root.spanId, startTimeUnixNano: ns(c1.startedAt), endTimeUnixNano: ns(c1.endedAt!), status: { code: "ERROR", message: "1 check failed" } });
    expect(checks.attributes).toEqual({ "orc.step.id": "C1", "orc.attempt.id": c1.id, "orc.checks.passed": 1, "orc.checks.failed": 1, "orc.checks.sandbox": "codex", "orc.attempt.outcome": "completed" });
    expect(Object.keys(checks.attributes).some((k) => k.startsWith("gen_ai."))).toBe(false);
  });

  it("never includes spec text, artifacts, paths, branches, commits, the vision, notes, purposes or user names", () => {
    const text = json(trace);
    for (const [what, sentinel] of Object.entries(SENTINELS)) expect(text, what).not.toContain(sentinel);
    // The fixture really planted them where the spans' sources live.
    expect(json(task(s, id).specs)).toContain(SENTINELS.spec);
    expect(json(s.artifacts.filter((a) => a.taskId === id))).toContain(SENTINELS.artifact);
    expect(json(s.artifacts.filter((a) => a.taskId === id))).toContain(SENTINELS.commit);
    expect(s.project.repoPath).toContain(SENTINELS.repo);
    expect(json(s.project.visions)).toContain(SENTINELS.vision);
    expect(json(s.attempts.filter((a) => a.taskId === id))).toContain(SENTINELS.workspace);
    expect(json(s.attempts.filter((a) => a.taskId === id))).toContain(SENTINELS.note);
    expect(json(s.attempts.filter((a) => a.taskId === id))).toContain(SENTINELS.prompt);
  });

  it("uses the pinned GenAI names", () => {
    expect(GEN_AI.providerName).toBe("gen_ai.provider.name");
    expect(Object.values(GEN_AI)).not.toContain("gen_ai.system");
  });

  it("refuses a task without an outcome", () => {
    const open = s.tasks.find((t) => !t.outcome)!;
    expect(() => buildTaskTrace(s, open, settledAt)).toThrow(/no outcome/);
  });
});
