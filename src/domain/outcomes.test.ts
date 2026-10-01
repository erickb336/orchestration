// ORC-016 step 3: outcome records, pure. `computeOutcome` over states driven through the real domain
// operations: a Change task with checks on, mixed providers (Claude reports cost, Codex tokens only), a
// decision by the user, two repair rounds over three iterations, coverage complete and incomplete with a
// retry, an edit, a pin, final checks passed or accepted while failing, a best-of choice, and the pattern
// fields after a change and on a task from before patterns.

import { describe, expect, it } from "vitest";
import * as C from "./checks";
import * as F from "./findings";
import * as M from "./model";
import { captureOutcomes, computeOutcome } from "./outcomes";
import { buildSeed } from "./seed";
import { DEFAULT_CHECKS, isProvider, type CheckRunRecord, type Finding, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const go = (s: State, t: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(t)), at(t), { checksHeld: false });

let n = 0;
function finding(over: Partial<Finding> = {}): Finding {
  n += 1;
  return { id: `F${n}`, key: `key${n}`.padEnd(12, "0"), source: "review", severity: "error", action: "auto-fix", title: `Finding ${n}`, detail: "what is wrong", ...over };
}
function record(sha: string, status: "passed" | "failed" = "passed"): CheckRunRecord {
  return { sha, configRev: 1, sandbox: "codex", touchedInputs: [], results: [{ id: "test", label: "test", kind: "check", status, ...(status === "failed" ? { exitCode: 1 } : { exitCode: 0 }), durationMs: 1000, excerpt: status === "failed" ? "1 failing" : "", bytes: 0, truncated: false }], durationMs: 1000 };
}

/** The seed with every sample task held and checks on (one check command), plus one task of yours. */
function withTask(patternId = "change"): { s: State; id: string } {
  const s0 = buildSeed(T0, { inFlightRuns: false });
  for (const t of s0.tasks) t.hold = true;
  s0.project.checks = { ...structuredClone(DEFAULT_CHECKS), enabled: true, rev: 1, commands: [{ id: "test", label: "test", kind: "check", argv: ["npm", "test"] }] };
  const r = M.createTask(s0, { title: "Mine", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId }, at(0));
  return { s: r.state, id: r.newId };
}

type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number };
/** Complete the running attempt on `stepId` (the only one, unless named) with every declared output. */
function finish(s: State, id: string, t: number, o: { stepId?: string; findings?: Finding[]; openFindings?: number; reviewedPaths?: string[]; ref?: string; check?: CheckRunRecord; usage?: Usage; actualModel?: string } = {}): State {
  const a = o.stepId ? running(s, id).find((x) => x.stepId === o.stepId)! : running(s, id)[0];
  const st = step(s, id, a.stepId);
  const outputs = st.outputs.map((d) => ({
    name: d.name,
    summary: `${d.name} at ${t}`,
    ...(d.kind === "review-findings" ? (o.findings !== undefined ? { findings: o.findings } : { openFindings: o.openFindings ?? 0 }) : {}),
    ...(d.kind === "review-findings" && o.reviewedPaths ? { reviewedPaths: o.reviewedPaths } : {}),
    ...(d.kind === "code-change" ? { ref: `${(o.ref ?? SHA).slice(0, 12)} on orchestration/run` } : {}),
    ...(d.kind === "check-results" ? { checkRun: o.check ?? record(SHA), findings: C.findingsFromRun(o.check ?? record(SHA)) } : {}),
  }));
  return M.reportCompletion(s, a.id, [], at(t), outputs, { ...(o.usage ? { usage: o.usage } : {}), ...(o.actualModel ? { actualModel: o.actualModel } : {}) });
}
const scope = (s: State, id: string, paths: string[]) => M.reportRunContext(s, running(s, id)[0].id, { scope: { from: SHA2, to: SHA, paths, total: paths.length } });
const codexUsage = { inputTokens: 1000, outputTokens: 200 };
const claudeUsage = { inputTokens: 500, outputTokens: 100, costUsd: 0.25 };

/**
 * The rich scenario. Round 1: S1 (Codex, tokens only) → C1 fails one check → S2 (Claude, cost) raises an
 * error, an ask-user warning and an info, coverage complete → the user decides "fix" → S3 repairs.
 * Round 2: C1-i2 passes → S2-i2 finds one more with incomplete coverage → S3-i2 repairs (no usage reported).
 * Round 3: C1-i3 passes → S2-i3 reports clean but misses a file (retried), then clean and complete → S3-i3
 * skipped → C2 repeats C1-i3's passing result → S4 (the lead) verifies. One edit and one pin along the way.
 */
function richScenario(): { s: State; id: string } {
  let { s, id } = withTask("change");
  s = go(s, 1);
  expect(running(s, id)[0].stepId).toBe("S1");
  s = finish(s, id, 2, { usage: codexUsage, actualModel: "codex-x" });
  s = M.editArtifact(s, s.artifacts.find((a) => a.taskId === id && a.name === "handoff")!.id, { summary: "clearer handoff", reason: "clarity" }, at(2));
  s = M.setStepSelection(s, id, "S4", { provider: "claude", model: "claude-sample-large" }, at(2));
  s = go(s, 3);
  expect(running(s, id)[0].stepId).toBe("C1");
  s = finish(s, id, 4, { check: record(SHA, "failed") });
  s = go(s, 5);
  expect(running(s, id)[0].stepId).toBe("S2");
  s = scope(s, id, ["a.ts"]);
  s = finish(s, id, 6, { findings: [finding(), finding({ severity: "warning", action: "ask-user", why: "widens the task" }), finding({ severity: "info", action: "no-op" })], reviewedPaths: ["a.ts"], usage: claudeUsage });
  const d = s.decisions.find((x) => x.taskId === id && x.status === "open")!;
  s = go(s, 7);
  expect(running(s, id)).toHaveLength(0); // S3 waits for the decision
  s = F.decideFinding(s, d.id, "fix", "do it", at(7));
  s = go(s, 8);
  expect(running(s, id)[0].stepId).toBe("S3");
  s = finish(s, id, 9, { ref: SHA2, usage: codexUsage, actualModel: "codex-x" });
  expect(task(s, id).steps.map((x) => x.id)).toContain("S3-i2");
  s = go(s, 10);
  expect(running(s, id)[0].stepId).toBe("C1-i2");
  s = finish(s, id, 11, { check: record(SHA2) });
  s = go(s, 12);
  expect(running(s, id)[0].stepId).toBe("S2-i2");
  s = scope(s, id, ["a.ts", "b.ts"]);
  s = finish(s, id, 13, { findings: [finding()], reviewedPaths: ["a.ts"], usage: claudeUsage });
  expect(s.artifacts.filter((a) => a.taskId === id && a.stepId === "S2-i2")[0].pathCoverage?.state).toBe("incomplete");
  s = go(s, 14);
  expect(running(s, id)[0].stepId).toBe("S3-i2");
  s = finish(s, id, 15, { ref: SHA2, actualModel: "codex-x" }); // no usage reported
  s = go(s, 16);
  expect(running(s, id)[0].stepId).toBe("C1-i3");
  s = finish(s, id, 17, { check: record(SHA2) });
  s = go(s, 18);
  expect(running(s, id)[0].stepId).toBe("S2-i3");
  s = scope(s, id, ["a.ts", "b.ts"]);
  s = finish(s, id, 19, { findings: [], reviewedPaths: ["a.ts"], usage: claudeUsage }); // clean but a file missing: not accepted
  expect(step(s, id, "S2-i3")).toMatchObject({ state: "pending", coverageRetries: 1 });
  s = go(s, 20);
  s = scope(s, id, ["a.ts", "b.ts"]);
  s = finish(s, id, 21, { findings: [], reviewedPaths: ["a.ts", "b.ts"], usage: claudeUsage });
  s = go(s, 22);
  expect(step(s, id, "S3-i3").state).toBe("skipped");
  // C2 checks the same commit and settings C1-i3 just checked, so it completes at once with a copy of that result.
  expect(step(s, id, "C2").state).toBe("done");
  expect(s.attempts.find((a) => a.taskId === id && a.stepId === "C2")!.snapshot.checks?.reusedFrom).toBeDefined();
  s = go(s, 23);
  expect(running(s, id)[0].stepId).toBe("S4");
  s = finish(s, id, 24, { usage: claudeUsage });
  expect(task(s, id).lifecycle).toBe("done");
  return { s, id };
}

describe("computeOutcome", () => {
  it("records runs by role, runner and model, usage per provider, repairs, findings, decisions, checks, coverage and human touches", () => {
    const { s, id } = richScenario();
    const t = task(s, id);
    const o = computeOutcome(s, t, at(25));
    const attempts = s.attempts.filter((a) => a.taskId === id);
    const dur = (xs: typeof attempts) => xs.reduce((ms, a) => ms + Date.parse(a.endedAt!) - Date.parse(a.startedAt), 0);
    expect(o).toMatchObject({ v: 1, result: "done", settledAt: at(25), createdAt: at(0), firstRunAt: at(1), wallMs: 24_000, patternChanges: 0, runsBeforePattern: 0 });
    expect(o.pattern).toEqual(t.pattern);
    expect(o.agentMs).toBe(dur(attempts.filter((a) => isProvider(a.snapshot.provider))));
    const row = (role: string, runner: string) => o.runs.find((r) => r.role === role && r.runner === runner)!;
    expect(o.runs.map((r) => [r.role, r.runner, r.model])).toEqual([
      ["coder", "codex", "codex-x"],
      ["checks", "service", "checks"],
      ["code_reviewer", "claude", "claude-sample-large"],
      ["lead", "claude", "claude-sample-large"],
    ]);
    expect(row("coder", "codex")).toMatchObject({ runs: 3, completed: 3, failed: 0, inputTokens: 2000, outputTokens: 400, costUsd: null });
    expect(row("checks", "service")).toMatchObject({ runs: 4, completed: 4, inputTokens: 0, costUsd: null });
    expect(row("code_reviewer", "claude")).toMatchObject({ runs: 4, completed: 3, failed: 1, inputTokens: 2000, outputTokens: 400, costUsd: 1 });
    expect(row("lead", "claude")).toMatchObject({ runs: 1, completed: 1, costUsd: 0.25 });
    expect(row("coder", "codex").ms).toBe(dur(attempts.filter((a) => a.snapshot.provider === "codex")));
    expect(o.usage).toEqual([
      { provider: "codex", inputTokens: 2000, outputTokens: 400, costUsd: null, runsWithoutUsage: 1 },
      { provider: "claude", inputTokens: 2500, outputTokens: 500, costUsd: 1.25, runsWithoutUsage: 0 },
    ]);
    expect(o.repair).toEqual({ rounds: 2, iterations: 3, finalCheckRounds: 0 });
    // Raised by runs: C1's failed check (error, auto-fix), S2's three, S2-i2's one; nothing summary-only; the last round left nothing open.
    expect(o.findings).toEqual({ raised: { error: 3, warning: 1, info: 1 }, byAction: { "auto-fix": 3, "ask-user": 1, "no-op": 1 }, summaryOnly: 0, openAtEnd: 0 });
    expect(o.decisions).toEqual({ total: 1, byUser: 1, byLead: 0, fix: 1, accept: 0, followUp: 0, superseded: 0, open: 0 });
    expect(o.checks).toEqual({ runs: 4, failedRuns: 1, finalPassed: true, acceptedFailing: false });
    expect(o.coverage).toEqual({ reviews: 3, complete: 2, incomplete: 1, unproven: 0, retries: 1 });
    expect(o.human).toEqual({ artifactEdits: 1, pinnedSteps: 1, candidateChoices: 0 });
    expect(o.bestOf).toBeUndefined();
    // The record is about 1–2 KB and holds no artifact text.
    expect(JSON.stringify(o).length).toBeLessThan(3000);
  });

  it("summary-only findings, final checks accepted while failing, and the decision the user took", () => {
    let { s, id } = withTask("change");
    s = go(s, 1);
    s = finish(s, id, 2, { usage: codexUsage });
    s = go(s, 3);
    s = finish(s, id, 4); // C1 passes
    s = go(s, 5);
    s = finish(s, id, 6, { openFindings: 2, usage: claudeUsage }); // a summary-only review
    s = go(s, 7);
    expect(running(s, id)[0].stepId).toBe("S3");
    s = finish(s, id, 8, { ref: SHA2, usage: codexUsage });
    s = go(s, 9);
    s = finish(s, id, 10, { check: record(SHA2) }); // C1-i2
    s = go(s, 11);
    s = finish(s, id, 12, { openFindings: 0, usage: claudeUsage }); // S2-i2 clean
    // The check settings changed since the loop's last run, so the Final checks step cannot repeat C1-i2's result and runs.
    s = { ...s, project: { ...s.project, checks: { ...s.project.checks, rev: 2 } } };
    s = go(s, 13);
    expect(step(s, id, "S3-i2").state).toBe("skipped");
    expect(running(s, id)[0].stepId).toBe("C2");
    s = finish(s, id, 14, { check: record(SHA2, "failed") });
    expect(step(s, id, "C2").state).toBe("blocked");
    const d = s.decisions.find((x) => x.taskId === id && x.kind === "final-checks")!;
    s = F.decideFinding(s, d.id, "accept", "known flake", at(15));
    s = go(s, 16);
    expect(running(s, id)[0].stepId).toBe("S4");
    s = finish(s, id, 17, { usage: claudeUsage });
    expect(task(s, id).lifecycle).toBe("done");
    const o = computeOutcome(s, task(s, id), at(18));
    expect(o.checks).toEqual({ runs: 3, failedRuns: 1, finalPassed: false, acceptedFailing: true });
    expect(o.findings).toMatchObject({ summaryOnly: 2, raised: { error: 1, warning: 0, info: 0 } }); // the failed final check is one structured error
    expect(o.findings.openAtEnd).toBe(1); // the accepted failing check stays on the record as unresolved
    expect(o.decisions).toEqual({ total: 1, byUser: 1, byLead: 0, fix: 0, accept: 1, followUp: 0, superseded: 0, open: 0 });
    expect(o.repair).toEqual({ rounds: 1, iterations: 2, finalCheckRounds: 0 });
  });

  it("best-of groups: the candidates, and a choice a person made", () => {
    let { s, id } = withTask("change-best-of-two");
    s = go(s, 1);
    expect(running(s, id).map((a) => a.stepId).sort()).toEqual(["S1", "S1-c2"]);
    s = finish(s, id, 2, { stepId: "S1", usage: claudeUsage });
    s = finish(s, id, 3, { stepId: "S1-c2", ref: SHA2, usage: codexUsage });
    s = go(s, 4);
    expect(running(s, id)[0].stepId).toBe("S2");
    s = M.reportCompletion(s, running(s, id)[0].id, [], at(5), [{ name: "comparison", summary: "S1 is better" }], { chosen: "S1", usage: claudeUsage });
    expect(task(s, id).bestOf).toEqual({ S1: "S1" });
    s = M.chooseCandidate(s, id, "S1", "S1-c2", at(6));
    const o = computeOutcome(s, task(s, id), at(7));
    expect(o.bestOf).toEqual({ groups: 1, candidates: 2, chosenByUser: 1 });
    expect(o.human.candidateChoices).toBe(1);
    expect(o.runs.filter((r) => r.role === "coder").map((r) => [r.runner, r.runs])).toEqual([
      ["claude", 1],
      ["codex", 1],
    ]);
  });

  it("after a pattern change: patternChanges, runsBeforePattern and the pattern in effect; a task from before patterns reads as legacy", () => {
    let { s, id } = withTask("change");
    s = go(s, 1);
    s = finish(s, id, 2, { usage: codexUsage });
    s = go(s, 3);
    s = finish(s, id, 4); // C1
    s = M.pauseTask(s, id, at(5));
    s = M.changePattern(s, id, task(s, id).pipelineRev, "bugfix", "", at(6));
    s = M.resumeTask(s, id, at(7));
    s = go(s, 8);
    expect(running(s, id)[0]).toMatchObject({ stepId: "S1", snapshot: { pipelineRev: task(s, id).patternSince } });
    s = finish(s, id, 9, { usage: codexUsage });
    const cancelled = M.cancelTask(s, id, at(10));
    const o = computeOutcome(cancelled, task(cancelled, id), at(10));
    expect(o).toMatchObject({ result: "cancelled", patternChanges: 1, runsBeforePattern: 2, pattern: { id: "bugfix", chosenBy: "user" } });
    expect(o.runs.find((r) => r.role === "coder")!.runs).toBe(2);
    // A task from before patterns: its record names the legacy reference, and every run counts as the pattern's.
    const legacy = structuredClone(s);
    const lt = task(legacy, id);
    lt.patternSince = 0;
    lt.pattern = { id: "change", name: "Change", source: "legacy", chosenBy: "migration" };
    for (const r of lt.pipelineHistory) delete r.pattern;
    const lo = computeOutcome(legacy, lt, at(10));
    expect(lo).toMatchObject({ pattern: { source: "legacy" }, patternChanges: 0, runsBeforePattern: 0 });
    // Older attempts without a role stamp take it from the pipeline revision they ran on.
    const unstamped = structuredClone(s);
    for (const a of unstamped.attempts) delete a.snapshot.role;
    expect(computeOutcome(unstamped, task(unstamped, id), at(10)).runs.map((r) => r.role).sort()).toEqual(["checks", "coder"]);
  });
});

describe("captureOutcomes (P11)", () => {
  it("records a task that settled between two states once, replaces it when a reopened task settles again, and leaves everything else alone", () => {
    const { s, id } = richScenario();
    const prev = { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, lifecycle: "active" as const } : t)) };
    // Nothing settled: the very same state comes back.
    expect(captureOutcomes(s, s, at(30))).toBe(s);
    expect(captureOutcomes(prev, prev, at(30))).toBe(prev);
    const captured = captureOutcomes(prev, s, at(30));
    expect(captured).not.toBe(s);
    expect(task(captured, id).outcome).toEqual(computeOutcome(s, task(s, id), at(30)));
    expect(task(s, id).outcome).toBeUndefined(); // the input is not mutated
    // Already settled on both sides: nothing is written, so a later write never touches the record.
    expect(captureOutcomes(captured, captured, at(31))).toBe(captured);
    // A different task with the same id (a replaced state) is not the same task.
    const replaced = { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, createdAt: at(999) } : t)) };
    expect(captureOutcomes(prev, replaced, at(30))).toBe(replaced);
    // Reopened and settled again: the record is replaced.
    const reopened = { ...captured, tasks: captured.tasks.map((t) => (t.id === id ? { ...t, lifecycle: "ready" as const } : t)) };
    const again = captureOutcomes(reopened, { ...reopened, tasks: reopened.tasks.map((t) => (t.id === id ? { ...t, lifecycle: "cancelled" as const } : t)) }, at(40));
    expect(task(again, id).outcome).toMatchObject({ result: "cancelled", settledAt: at(40) });
  });
});
