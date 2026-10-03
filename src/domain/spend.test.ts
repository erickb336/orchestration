// ORC-029 pass 2a: the building budget, estimated in dollars at the providers' published prices. What one run
// cost (reported, priced, or unknown and never zero), the project's spend, and the budget stop: at the budget
// nothing new starts and running work finishes, the owner is asked under Needs you, and raising the budget or
// continuing past it starts work again.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as M from "./model";
import { needsYouItems } from "./needsYou";
import { buildSeed } from "./seed";
import { budgetStop, buildingSpend, estimateUsd, pastBudget, PRICES, unrecordedWords, type ModelPrice } from "./spend";
import * as R from "./studio/runs";
import type { StudioRun } from "./studio/types";
import type { Attempt, LeadRun, State } from "./types";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const running = (s: State, id?: string) => M.activeAttempts(s, id);

/** A price list of the test's own, so the arithmetic does not depend on the pinned prices. */
const LIST: ModelPrice[] = [
  { provider: "codex", model: "gpt-test", inputPerMTok: 2, outputPerMTok: 10, source: "https://example.test/pricing", checked: "2026-10-01" },
  { provider: "claude", model: "claude-test-20260101", inputPerMTok: 1, outputPerMTok: 5, source: "https://example.test/pricing", checked: "2026-10-01" },
];

function attempt(over: { provider: "claude" | "codex" | "service"; model: string; actualModel?: string; usage?: Attempt["usage"]; outcome?: Attempt["outcome"] }): Attempt {
  const { provider, model, ...rest } = over;
  return {
    id: "run-1",
    taskId: "T-1",
    stepId: "S1",
    snapshot: { provider, model, source: "project-role", routingReason: "", specRev: 1, stepRev: 1, visionRev: 1, workspace: "/w", pipelineRev: 1, purpose: "", inputs: [] },
    startedAt: at(0),
    progress: 100,
    artifacts: [],
    outcome: "completed",
    ...rest,
  };
}

/** Finish the seed's running Codex step (EX-001) as `model` with the given usage. */
function finishCodexRun(s: State, model: string, usage: Attempt["usage"], sec = 1): State {
  const a = running(s, "EX-001")[0];
  const st = s.tasks.find((t) => t.id === a.taskId)!.steps.find((x) => x.id === a.stepId)!;
  const started = M.reportRunStarted(s, a.id, { actualModel: model });
  return M.reportCompletion(started, a.id, [], at(sec), st.outputs.map((o) => ({ name: o.name, summary: "done" })), { usage });
}

/**
 * The sample project with EX-004 released and one priced Codex run finished. Room for six agents and six Claude
 * runs, so EX-004 starts on the next dispatch below the budget beside EX-001's next steps. The sample's finished runs
 * record no usage: each is given a recorded cost of 1 cent, so the stop here is about reaching the budget only (runs
 * with no recorded cost have their own tests).
 */
function spentProject(): State {
  let s = M.setWorkerLimit(buildSeed(T0), 6, at(0));
  s = M.setProviderLimit(s, "claude", 6, at(0));
  s = { ...s, attempts: s.attempts.map((a) => (a.outcome === "running" ? a : { ...a, usage: { ...a.usage, costUsd: 0.01 } })) };
  return finishCodexRun(M.startHeldTask(s, "EX-004", at(0)), "gpt-6.1-sol", { inputTokens: 35_118, outputTokens: 330 });
}

describe("one run's cost", () => {
  it("uses the cost the runtime reported, over its tokens", () => {
    const a = attempt({ provider: "claude", model: "sonnet", actualModel: "claude-test-20260101", usage: { costUsd: 0.0288, inputTokens: 15_601, outputTokens: 1_268 } });
    expect(estimateUsd(a, LIST)).toEqual({ basis: "reported", usd: 0.0288, estimated: true });
  });

  it("prices the tokens of the model the runtime reported, not the alias it was started with", () => {
    const a = attempt({ provider: "codex", model: "auto", actualModel: "gpt-test", usage: { inputTokens: 35_118, outputTokens: 330 } });
    // 35,118 × $2 + 330 × $10, per million tokens.
    expect(estimateUsd(a, LIST)).toEqual({ basis: "priced", usd: 0.073536, estimated: true });
    expect(estimateUsd(attempt({ provider: "claude", model: "claude-test-20260101", usage: { inputTokens: 1_000_000, outputTokens: 100_000 } }), LIST)).toEqual({ basis: "priced", usd: 1.5, estimated: true });
  });

  it("prices input read from the cache at the cached-input price where one is published, and the rest of the input at the full price", () => {
    const cachedList: ModelPrice[] = [{ ...LIST[0], cachedInputPerMTok: 0.2 }];
    // 1,000,000 input tokens of which 800,000 cached: 200,000 × $2 + 800,000 × $0.20 + 100,000 × $10, per million.
    const a = attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 } });
    expect(estimateUsd(a, cachedList)).toEqual({ basis: "priced", usd: 1.56, estimated: true });
    // No cached-input price: every input token at the full price.
    expect(estimateUsd(a, LIST)).toEqual({ basis: "priced", usd: 3, estimated: true });
    // A cached count above the input count cannot make the input cheaper than all of it cached.
    const over = attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 0 } });
    expect(estimateUsd(over, cachedList).usd).toBeCloseTo(0.2, 10);
    // The pinned Codex prices publish one.
    expect(PRICES.filter((p) => p.provider === "codex").every((p) => p.cachedInputPerMTok !== undefined)).toBe(true);
  });

  it("an unknown model, a model of another provider, or a run with no usage has no recorded cost: unknown, never zero, with the reason", () => {
    const tokens = { inputTokens: 1000, outputTokens: 100 };
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-unknown", usage: tokens }), LIST)).toEqual({ basis: "unknown", usd: null, estimated: true, reason: "no-price" });
    expect(estimateUsd(attempt({ provider: "claude", model: "gpt-test", usage: tokens }), LIST)).toMatchObject({ basis: "unknown", reason: "no-price" });
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test" }), LIST)).toMatchObject({ basis: "unknown", reason: "no-usage" });
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 1000 } }), LIST)).toMatchObject({ basis: "unknown", reason: "no-usage" });
  });

  it("a run that failed or was stopped before its runtime started it (no session, no model, no tokens) is a known $0; any other run with no usage stays unknown", () => {
    const zero = { basis: "not-started", usd: 0, estimated: true };
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test", outcome: "failed" }), LIST)).toEqual(zero);
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-unknown", outcome: "stopped" }), LIST)).toEqual(zero);
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test", outcome: "failed", usage: { inputTokens: 0, outputTokens: 0 } }), LIST)).toEqual(zero);
    // The runtime reported the start: it may have used tokens nobody recorded.
    expect(estimateUsd({ ...attempt({ provider: "codex", model: "gpt-test", outcome: "failed" }), sessionId: "thr-1" }, LIST)).toMatchObject({ basis: "unknown", reason: "no-usage" });
    expect(estimateUsd(attempt({ provider: "codex", model: "auto", actualModel: "gpt-test", outcome: "stopped" }), LIST)).toMatchObject({ basis: "unknown", reason: "no-usage" });
    // A completed run ran; a lost run's process may have run unobserved.
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test", outcome: "completed" }), LIST)).toMatchObject({ basis: "unknown", reason: "no-usage" });
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test", outcome: "lost" }), LIST)).toMatchObject({ basis: "unknown", reason: "no-usage" });
    // Recorded tokens are priced, whatever the start says.
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test", outcome: "failed", usage: { inputTokens: 500_000, outputTokens: 0 } }), LIST)).toMatchObject({ basis: "priced", usd: 1 });
    const lead: LeadRun = { id: "lead-1", trigger: "message", provider: "codex", model: "gpt-test", startedAt: at(0), endedAt: at(1), outcome: "failed", messageIds: [] };
    expect(estimateUsd(lead, LIST)).toEqual(zero);
    expect(estimateUsd({ ...lead, outcome: "lost" }, LIST)).toMatchObject({ basis: "unknown" });
  });

  it("a studio run the fake runtime ran spent nothing: a known $0, not an unknown cost; the same run on a real runtime is unknown", () => {
    const run = { id: "studio-1", kind: "pe", round: 1, provider: "codex", model: "gpt-test", status: "completed", brief: "Review it.", askedAt: at(0), workspace: "staging/studio-1", sessionId: "thr-1" } as StudioRun;
    expect(estimateUsd({ ...run, simulated: true }, LIST)).toEqual({ basis: "simulated", usd: 0, estimated: true });
    expect(estimateUsd(run, LIST)).toMatchObject({ basis: "unknown", reason: "no-usage" });
  });

  it("a stopped run keeps the usage reported with the stop, a worker's and the lead's", () => {
    const s = buildSeed(T0);
    const [run] = running(s, "EX-001");
    const paused = M.pauseTask(s, "EX-001", at(1));
    expect(paused.attempts.find((a) => a.id === run.id)?.outcome).toBe("stopping");
    const stopped = M.acknowledgeStop(paused, run.id, at(2), { usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    expect(stopped.attempts.find((a) => a.id === run.id)).toMatchObject({ outcome: "stopped", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
    const { state: withLead, runId } = M.startLeadRun(buildSeed(T0, { inFlightRuns: false }), { provider: "claude", model: "claude-test-20260101", trigger: "message" }, at(0));
    const leadStopped = M.reportLeadStopped(withLead, runId, at(1), false, { costUsd: 0.3 });
    expect(leadStopped.leadRuns.find((r) => r.id === runId)).toMatchObject({ outcome: "failed", usage: { costUsd: 0.3 } });
  });

  it("prices a lead run the same way", () => {
    const r: LeadRun = { id: "lead-1", trigger: "message", provider: "codex", model: "gpt-test", startedAt: at(0), endedAt: at(1), outcome: "completed", messageIds: [], usage: { inputTokens: 500_000, outputTokens: 0 } };
    expect(estimateUsd(r, LIST)).toEqual({ basis: "priced", usd: 1, estimated: true });
  });
});

describe("the building spend", () => {
  it("sums the project's finished agent and lead runs, lists the ones with no recorded cost, and leaves out running work and check runs", () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    s.attempts = [
      { ...attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 1_000_000, outputTokens: 0 } }), id: "run-a" },
      { ...attempt({ provider: "claude", model: "sonnet", usage: { costUsd: 0.5 } }), id: "run-b" },
      { ...attempt({ provider: "codex", model: "gpt-mystery", usage: { inputTokens: 10, outputTokens: 10 } }), id: "run-c" },
      { ...attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 9_000_000, outputTokens: 0 }, outcome: "running" }), id: "run-d" },
      { ...attempt({ provider: "service", model: "checks" }), id: "run-e" },
    ];
    s.leadRuns = [{ id: "lead-1", trigger: "planning", provider: "claude", model: "claude-test-20260101", startedAt: at(0), endedAt: at(1), outcome: "failed", messageIds: [], usage: { inputTokens: 1_000_000, outputTokens: 0 } }];
    expect(buildingSpend(s, LIST)).toEqual({ usd: 3.5, runs: 4, unknown: [{ runId: "run-c", provider: "codex", model: "gpt-mystery", reason: "no-price", countedUsd: 0.00012 }] });
  });

  it("counts Vision's studio runs (spec r5): finished ones priced like any run, queued and running ones not yet, and one refused before it started as a known $0", () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    s.attempts = [];
    s.leadRuns = [];
    const studio = (id: string, status: StudioRun["status"], over: Partial<StudioRun> = {}): StudioRun => ({ id, kind: "designer", round: 1, provider: "codex", model: "gpt-test", status, brief: "b", askedAt: at(0), workspace: `staging/${id}`, ...over });
    s.studio.runs = [
      studio("studio-1", "completed", { usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
      studio("studio-2", "stopped", { provider: "claude", model: "sonnet", sessionId: "sess", usage: { costUsd: 0.25 } }),
      studio("studio-3", "failed", { note: "not started: round 1 was closed" }),
      studio("studio-4", "lost", { sessionId: "thr-4" }),
      studio("studio-5", "queued", { usage: { costUsd: 99 } }),
      studio("studio-6", "running", { usage: { costUsd: 99 } }),
    ];
    expect(buildingSpend(s, LIST)).toEqual({ usd: 2.25, runs: 4, unknown: [{ runId: "studio-4", provider: "codex", model: "gpt-test", reason: "no-usage", countedUsd: null }] });
  });

  it("a designer run's spend reaches the building budget, and then no studio run starts until the owner raises it", () => {
    let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
    s = runCommand(s, "openRound", { focus: "experience" }, at(1)).state;
    const ask = (st: State, sec: number) => runCommand(st, "startStudioRun", { kind: "designer", round: 1, brief: "Make the trip plan." }, at(sec)) as { state: State; result: { runId: string } };
    const first = ask(s, 2);
    s = R.dispatchStudioRuns(first.state, at(3)).state;
    s = R.completeStudioRun(s, first.result.runId, at(4), { summary: "1 artifact", usage: { costUsd: 2 } });
    s = runCommand(s, "setBudgets", { buildingUsd: 2, maintenanceUsdPerMonth: null }, at(5)).state;
    expect(budgetStop(s)).toMatchObject({ budgetUsd: 2, spend: { usd: 2, runs: 1 } });
    const second = ask(s, 6);
    expect(R.dispatchStudioRuns(second.state, at(7)).started).toEqual([]);
    const raised = runCommand(second.state, "setBudgets", { buildingUsd: 3, maintenanceUsdPerMonth: null }, at(8)).state;
    expect(R.dispatchStudioRuns(raised, at(9)).started).toEqual([second.result.runId]);
  });
});

describe("costs the providers do not report: a paused Codex run, a model with no price (B-02)", () => {
  /** What the Codex adapter reports for a run that ended with its first model request open, and for one that made none. */
  const NO_REQUEST = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const OPEN_REQUEST = { ...NO_REQUEST, openRequest: true as const };
  /** A finished Codex run on gpt-test, as the runtime reported it (it started: a session and a model). */
  const codex = (id: string, outcome: Attempt["outcome"], usage?: Attempt["usage"], model = "gpt-test"): Attempt => ({ ...attempt({ provider: "codex", model, actualModel: model, usage, outcome }), id, sessionId: `thr-${id}` });
  /** A full run on gpt-test: 35,000 input tokens and 300 output tokens, $0.073. */
  const FULL = { inputTokens: 35_000, outputTokens: 300 };
  function withRuns(attempts: Attempt[], buildingUsd: number | null = 40): State {
    const s = buildSeed(T0, { inFlightRuns: false });
    s.attempts = attempts;
    s.leadRuns = [];
    return M.setBudgets(s, { buildingUsd, maintenanceUsdPerMonth: null }, at(1));
  }

  it("a run that made no model request is a known $0, even on a model with no price", () => {
    expect(estimateUsd(codex("run-a", "stopped", NO_REQUEST), LIST)).toEqual({ basis: "priced", usd: 0, estimated: true });
    expect(estimateUsd(codex("run-a", "stopped", NO_REQUEST, "gpt-unpriced"), LIST)).toEqual({ basis: "priced", usd: 0, estimated: true });
  });

  it("a run that ended with a model request open is never $0: the request has no record, whatever was recorded before it", () => {
    expect(estimateUsd(codex("run-a", "stopped", OPEN_REQUEST), LIST)).toEqual({ basis: "unknown", usd: null, estimated: true, reason: "open-request", recordedUsd: 0 });
    expect(estimateUsd(codex("run-a", "failed", { ...FULL, openRequest: true }), LIST)).toEqual({ basis: "unknown", usd: null, estimated: true, reason: "open-request", recordedUsd: 0.073 });
  });

  it("the budget counts an open request at the dearest finished run on its model, else at the run limit; the recorded part counts as spent", () => {
    const paused = withRuns([codex("run-full", "completed", FULL), codex("run-paused", "stopped", { ...FULL, openRequest: true }), codex("run-early", "stopped", OPEN_REQUEST)]);
    expect(buildingSpend(paused, LIST)).toEqual({
      usd: 0.146,
      runs: 3,
      unknown: [
        { runId: "run-paused", provider: "codex", model: "gpt-test", reason: "open-request", countedUsd: 0.073 },
        { runId: "run-early", provider: "codex", model: "gpt-test", reason: "open-request", countedUsd: 0.073 },
      ],
    });
    // With no finished run on the model yet, the run limit is the estimate: the most the owner lets one run spend.
    const first = withRuns([codex("run-early", "stopped", OPEN_REQUEST)]);
    expect(buildingSpend(first, LIST).unknown).toEqual([{ runId: "run-early", provider: "codex", model: "gpt-test", reason: "open-request", countedUsd: 2 }]);
  });

  it("the real run's pause (run-1038, run-1046): two Codex runs stopped early no longer hold new work; they count at an estimate until the budget is reached", () => {
    const s = withRuns([codex("run-1035", "completed", FULL), codex("run-1038", "stopped", OPEN_REQUEST), codex("run-1046", "stopped", OPEN_REQUEST)]);
    expect(budgetStop(s, LIST)).toBeUndefined();
    // $0.073 spent and two open requests at $0.073 each: $0.219 counted.
    expect(budgetStop(M.setBudgets(s, { buildingUsd: 0.2, maintenanceUsdPerMonth: null }, at(2)), LIST)).toMatchObject({
      countedUsd: expect.closeTo(0.219, 10),
      why: "The building budget is reached: $0.22 of $0.20, of which $0.15 is an estimate for 2 unrecorded costs",
    });
  });

  it("a model with no price counts at the dearest price its provider has in the list, never $0", () => {
    const s = withRuns([codex("run-x", "completed", { inputTokens: 1_000_000, outputTokens: 100_000 }, "gpt-unpriced")]);
    // 1,000,000 × $2 + 100,000 × $10 per million: gpt-test's price, the dearest Codex price in the list.
    expect(buildingSpend(s, LIST).unknown).toEqual([{ runId: "run-x", provider: "codex", model: "gpt-unpriced", reason: "no-price", countedUsd: 3 }]);
    expect(budgetStop(s, LIST)).toBeUndefined();
    expect(budgetStop(M.setBudgets(s, { buildingUsd: 2, maintenanceUsdPerMonth: null }, at(2)), LIST)).toMatchObject({ countedUsd: 3 });
    // A provider with no price at all in the list: nothing to count it at, so the spend cannot be checked.
    expect(buildingSpend(s, LIST.filter((p) => p.provider !== "codex")).unknown).toEqual([{ runId: "run-x", provider: "codex", model: "gpt-unpriced", reason: "no-price", countedUsd: null }]);
  });

  it("a Codex run with no usage report at all (lost by the service) still cannot be counted: the stop holds new work and names the run", () => {
    const s = withRuns([codex("run-lost", "lost")]);
    expect(budgetStop(s, LIST)).toMatchObject({ countedUsd: null, why: "The building spend cannot be checked against the $40.00 budget: 1 run with no recorded cost has no spend limit" });
    const stopItem = needsYouItems(s, T0).find((i) => i.key === "budget");
    expect(stopItem).toMatchObject({ kind: "open", detail: "Estimated at the providers' published prices. Nothing new starts; running work finishes. Raise the budget, or continue past it. Not counted: run-lost (codex · gpt-test, no usage recorded)." });
  });

  it("costs counted at an estimate need nothing from the owner: no Needs-you item of their own (D-3)", () => {
    const s = withRuns([codex("run-1035", "completed", FULL), codex("run-1038", "stopped", OPEN_REQUEST), codex("run-x", "completed", FULL, "gpt-unpriced")]);
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("budget"))).toEqual([]);
  });

  it("a PE call is checked against the spend with each open request at its estimate: within budget it stays the PE's, past it the owner's", () => {
    const s = withRuns([codex("run-1035", "completed", FULL), codex("run-1038", "stopped", OPEN_REQUEST)], 1);
    const cost = (hi: number) => ({ buildUsd: [0, hi] as [number, number], basis: "Two repair runs" });
    expect(pastBudget(s, cost(0.5), LIST)).toBeUndefined();
    // $0.073 spent, $0.073 estimated, and up to $0.86 more: $1.006, past $1.
    expect(pastBudget(s, cost(0.86), LIST)).toBe("up to $0.86 more would take the building spend to $1.01, past the $1.00 budget ($0.07 spent, $0.07 estimated for unrecorded costs)");
    // A run nothing bounds still sends any building cost to the owner.
    expect(pastBudget(withRuns([codex("run-lost", "lost")], 1), cost(0.01), LIST)).toBe("1 run has no recorded cost and no spend limit, so up to $0.01 more cannot be checked against the $1.00 budget");
  });
});

describe("runs with no recorded cost, while a building budget is set", () => {
  const tokens = { inputTokens: 9_000_000, outputTokens: 9_000_000 };
  const codexRun = (id: string, model: string, usage?: Attempt["usage"]): Attempt => ({ ...attempt({ provider: "codex", model, usage }), id });
  /** The sample project with only the given finished runs. */
  function withRuns(attempts: Attempt[], leadRuns: LeadRun[] = []): State {
    const s = buildSeed(T0, { inFlightRuns: false });
    s.attempts = attempts;
    s.leadRuns = leadRuns;
    return s;
  }
  const budgetItems = (s: State) => needsYouItems(s, T0).filter((i) => i.key.startsWith("budget"));

  it("count at an estimate, never as $0: work on a model with no price reaches a budget far above the spend it recorded (review finding 4)", () => {
    const s = withRuns([codexRun("run-a", "gpt-x", tokens), codexRun("run-b", "gpt-x", tokens), codexRun("run-c", "gpt-x", tokens), codexRun("run-d", "gpt-6.1-sol", { inputTokens: 1000, outputTokens: 100 })]);
    // No building budget (a maintenance budget alone does not count runs): nothing to enforce, nothing to say.
    expect(budgetStop(s)).toBeUndefined();
    expect(budgetItems(M.setBudgets(s, { buildingUsd: null, maintenanceUsdPerMonth: 50 }, at(1)))).toEqual([]);
    // Each gpt-x run: 9,000,000 input and output tokens at the dearest Codex price in the list ($10 and $50 a million), $540.
    const set = M.setBudgets(s, { buildingUsd: 100, maintenanceUsdPerMonth: null }, at(1));
    expect(budgetStop(set)).toMatchObject({ countedUsd: expect.closeTo(1620.003, 6), why: "The building budget is reached: $1620.00 of $100.00, of which $1620.00 is an estimate for 3 unrecorded costs" });
    expect(budgetItems(set)).toEqual([expect.objectContaining({ key: "budget", what: "The building budget is reached: $1620.00 of $100.00, of which $1620.00 is an estimate for 3 unrecorded costs" })]);
    expect(unrecordedWords(buildingSpend(set))).toBe("3 unrecorded costs count at an estimate of $1620.00: model gpt-x has no price, so the dearest price of its provider applies.");
  });

  it("a run nothing bounds (a Codex run with no usage) holds new work; the stop names it, and the lead's lost run counts at the run limit", () => {
    const lead: LeadRun = { id: "lead-1", trigger: "message", provider: "claude", model: "claude-opus-5-5", startedAt: at(0), endedAt: at(1), outcome: "lost", messageIds: [], sessionId: "s-1" };
    const s = M.setBudgets(withRuns([codexRun("run-a", "gpt-x", { inputTokens: 2000, outputTokens: 200 }), codexRun("run-e", "gpt-6.1-sol")], [lead]), { buildingUsd: 100, maintenanceUsdPerMonth: null }, at(1));
    expect(budgetStop(s)).toMatchObject({ countedUsd: null, why: "The building spend cannot be checked against the $100.00 budget: 1 run with no recorded cost has no spend limit" });
    expect(budgetItems(s)).toEqual([
      expect.objectContaining({
        key: "budget",
        detail: "Estimated at the providers' published prices. Nothing new starts; running work finishes. Raise the budget, or continue past it. Not counted: run-e (codex · gpt-6.1-sol, no usage recorded).",
      }),
    ]);
    expect(unrecordedWords(buildingSpend(s))).toBe("1 run has no recorded cost and no spend limit, so the spend cannot be checked. 2 more unrecorded costs count at an estimate of $2.03.");
  });

  it("a task run of the fake runtime is a known $0: it never holds new work, however small the budget", () => {
    const sim: Attempt = { ...codexRun("run-s", "codex-sample-large"), simulated: true };
    const s = M.setBudgets(withRuns([sim, { ...sim, id: "run-t" }]), { buildingUsd: 0.01, maintenanceUsdPerMonth: null }, at(1));
    expect(budgetStop(s)).toBeUndefined();
    expect(budgetItems(s)).toEqual([]);
    // The same runs without the mark have no recorded cost: the stop holds new work.
    expect(budgetStop(M.setBudgets(withRuns([codexRun("run-s", "codex-sample-large")]), { buildingUsd: 0.01, maintenanceUsdPerMonth: null }, at(1)))).toBeDefined();
  });
});

describe("the owner's budgets", () => {
  it("setBudgets takes positive dollars or null for each, and refuses anything else", () => {
    const s = runCommand(buildSeed(T0), "setBudgets", { buildingUsd: 40, maintenanceUsdPerMonth: null }, at(1)).state;
    expect(s.project.budgets).toEqual({ buildingUsd: 40, maintenanceUsdPerMonth: null });
    expect(s.events.at(-1)?.message).toBe("Budgets: building $40.00, maintenance not set");
    expect(() => runCommand(s, "setBudgets", { buildingUsd: 0, maintenanceUsdPerMonth: null }, at(2))).toThrow(/positive amount/);
    expect(() => runCommand(s, "setBudgets", { buildingUsd: -5, maintenanceUsdPerMonth: 10 }, at(2))).toThrow(/positive amount/);
    expect(() => runCommand(s, "setBudgets", { buildingUsd: "40", maintenanceUsdPerMonth: null }, at(2))).toThrow(/buildingUsd must be a number/);
    expect(() => runCommand(s, "setBudgets", { buildingUsd: 40 }, at(2))).toThrow(/maintenanceUsdPerMonth must be a number/);
  });

  it("a new project starts with no budgets and nothing continued past", () => {
    let s = M.setBudgets(buildSeed(T0, { inFlightRuns: false }), { buildingUsd: 1, maintenanceUsdPerMonth: 2 }, at(1));
    s.project.budgetContinued = { at: at(1), buildingUsd: 1, spentUsd: 1 };
    s = M.initProject(s, { name: "N", repoPath: "/tmp/n", vision: "v", focus: "" }, at(2));
    expect(s.project.budgets).toEqual({ buildingUsd: null, maintenanceUsdPerMonth: null });
    expect(s.project.budgetContinued).toBeUndefined();
  });
});

describe("the budget stop", () => {
  it("below the budget work starts; at it nothing new starts, and the running step finishes and is accepted", () => {
    const s = spentProject();
    const spend = buildingSpend(s).usd;
    expect(spend).toBeGreaterThan(0);
    // Below the budget, the released task starts.
    expect(running(M.dispatchEligible(M.setBudgets(s, { buildingUsd: spend + 1, maintenanceUsdPerMonth: null }, at(2)), at(3)), "EX-004")).toHaveLength(1);
    // At it, nothing new starts, on any task.
    const stopped = M.setBudgets(s, { buildingUsd: spend, maintenanceUsdPerMonth: null }, at(2));
    const before = stopped.attempts.length;
    const after = M.dispatchEligible(stopped, at(3));
    expect(after.attempts.length).toBe(before);
    expect(running(after, "EX-004")).toHaveLength(0);
    // The Claude step that was already running is not stopped, and its result is accepted.
    const [claudeRun] = running(after, "EX-002");
    expect(claudeRun.outcome).toBe("running");
    const st = after.tasks.find((t) => t.id === "EX-002")!.steps.find((x) => x.id === claudeRun.stepId)!;
    const done = M.reportCompletion(after, claudeRun.id, [], at(4), st.outputs.map((o) => ({ name: o.name, summary: "done", ...(o.kind === "review-findings" ? { openFindings: 0 } : {}) })));
    expect(done.attempts.find((a) => a.id === claudeRun.id)!.outcome).toBe("completed");
  });

  it("asks the owner under Needs you with the spend and the budget", () => {
    const s = spentProject();
    const spend = buildingSpend(s);
    expect(spend.unknown).toEqual([]);
    const budget = Math.floor(spend.usd * 100) / 100;
    const at2 = M.setBudgets(s, { buildingUsd: budget, maintenanceUsdPerMonth: null }, at(2));
    const [first] = needsYouItems(at2, T0);
    expect(first).toMatchObject({ kind: "open", key: "budget", what: `The building budget is reached: $${spend.usd.toFixed(2)} of $${budget.toFixed(2)}`, href: "#/settings/project/budgets" });
    expect(first.kind === "open" && first.detail).toBe("Estimated at the providers' published prices. Nothing new starts; running work finishes. Raise the budget, or continue past it.");
    // Below the budget there is nothing to ask about the stop.
    expect(needsYouItems(M.setBudgets(s, { buildingUsd: spend.usd + 1, maintenanceUsdPerMonth: null }, at(2)), T0).some((i) => i.key === "budget")).toBe(false);
  });

  it("a run with no recorded cost counts at its run limit, never as $0: five lost studio runs reach a $0.01 budget, and no PE or revision run starts (review finding 4)", () => {
    let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
    s = runCommand(s, "openRound", { focus: "experience" }, at(1)).state;
    // Five designer runs on Claude start, and their processes are lost before any usage is reported.
    for (let i = 0; i < 5; i++) {
      const asked = runCommand(s, "startStudioRun", { kind: "designer", round: 1, brief: `Take ${i + 1}.` }, at(2)) as { state: State; result: { runId: string } };
      s = R.reportStudioRunStarted(R.dispatchStudioRuns(asked.state, at(2)).state, asked.result.runId, { sessionId: `claude-session-${i}` });
      s = R.reportStudioRunStopped(s, asked.result.runId, at(3), { lost: true });
    }
    expect(buildingSpend(s)).toMatchObject({ usd: 0, runs: 5 });
    s = runCommand(s, "setBudgets", { buildingUsd: 0.01, maintenanceUsdPerMonth: null }, at(4)).state;
    expect(budgetStop(s)).toMatchObject({ countedUsd: 10, why: "The building budget is reached: $10.00 of $0.01, of which $10.00 is an estimate for 5 unrecorded costs" });
    const next = runCommand(s, "startStudioRun", { kind: "designer", round: 1, brief: "One more." }, at(5)).state;
    expect(R.dispatchStudioRuns(next, at(6)).started).toEqual([]);
    // A budget above the five runs' limits lets work start again.
    expect(budgetStop(runCommand(s, "setBudgets", { buildingUsd: 10.01, maintenanceUsdPerMonth: null }, at(7)).state)).toBeUndefined();
  });

  it("runs with no recorded cost are never counted as zero: a Codex run with no price counts at its provider's dearest price, and Codex runs with no usage hold the stop", () => {
    const unknownOnly = finishCodexRun(M.startHeldTask(buildSeed(T0), "EX-004", at(0)), "gpt-unknown", { inputTokens: 9_000_000, outputTokens: 9_000_000 });
    expect(buildingSpend(unknownOnly).usd).toBe(0);
    // 9,000,000 input and output tokens at the dearest pinned Codex price ($10 and $50 a million): $540.
    expect(buildingSpend(unknownOnly).unknown).toContainEqual({ runId: expect.any(String), provider: "codex", model: "gpt-unknown", reason: "no-price", countedUsd: 540 });
    // The sample's finished Codex runs recorded no usage: no spend limit counts them.
    const budgeted = M.setBudgets(unknownOnly, { buildingUsd: 1, maintenanceUsdPerMonth: null }, at(2));
    expect(budgetStop(budgeted)).toMatchObject({ countedUsd: null, why: "The building spend cannot be checked against the $1.00 budget: 3 runs with no recorded cost have no spend limit" });
    expect(running(M.dispatchEligible(budgeted, at(3)), "EX-004")).toHaveLength(0);
    expect(needsYouItems(budgeted, T0).find((i) => i.key === "budget")).toMatchObject({ kind: "open", detail: expect.stringContaining("Not counted: run-3 (codex · codex-sample-large, no usage recorded), run-6") });
    // The owner may continue past it: work starts again.
    expect(budgetStop(M.continuePastBudget(budgeted, at(4)))).toBeUndefined();
  });

  it("raising the budget starts work again", () => {
    const s = spentProject();
    const spend = buildingSpend(s).usd;
    const stopped = M.dispatchEligible(M.setBudgets(s, { buildingUsd: spend, maintenanceUsdPerMonth: null }, at(2)), at(3));
    expect(running(stopped, "EX-004")).toHaveLength(0);
    const raised = M.dispatchEligible(M.setBudgets(stopped, { buildingUsd: spend * 2, maintenanceUsdPerMonth: null }, at(4)), at(5));
    expect(running(raised, "EX-004")).toHaveLength(1);
    expect(budgetStop(raised)).toBeUndefined();
  });

  it("continuing past the budget is the owner's recorded choice; it starts work again until the budget changes", () => {
    const s = spentProject();
    const spend = buildingSpend(s).usd;
    const stopped = M.setBudgets(s, { buildingUsd: spend, maintenanceUsdPerMonth: null }, at(2));
    const past = runCommand(stopped, "continuePastBudget", {}, at(3)).state;
    expect(past.project.budgetContinued).toEqual({ at: at(3), buildingUsd: spend, spentUsd: spend });
    expect(past.events.at(-1)).toMatchObject({ actor: "user", kind: "config" });
    expect(past.events.at(-1)?.message).toMatch(/^Continued past the building budget \(\$0\.14 of \$0\.14\)/);
    expect(running(M.dispatchEligible(past, at(4)), "EX-004")).toHaveLength(1);
    expect(needsYouItems(past, T0).some((i) => i.key === "budget")).toBe(false);
    // A new budget amount the spend has reached stops again.
    const lowered = M.setBudgets(past, { buildingUsd: spend / 2, maintenanceUsdPerMonth: null }, at(5));
    expect(running(M.dispatchEligible(lowered, at(6)), "EX-004")).toHaveLength(0);
  });

  it("changing the building budget ends continuing past it: set, continue, raise, then set it back, and the stop applies again", () => {
    const s = spentProject();
    const spend = buildingSpend(s).usd;
    const past = M.continuePastBudget(M.setBudgets(s, { buildingUsd: spend, maintenanceUsdPerMonth: null }, at(2)), at(3));
    const raised = M.setBudgets(past, { buildingUsd: spend * 2, maintenanceUsdPerMonth: null }, at(4));
    expect(raised.project.budgetContinued).toBeUndefined();
    expect(raised.events.at(-1)?.message).toBe(`Budgets: building ${`$${(spend * 2).toFixed(2)}`}, maintenance not set; continuing past the building budget ends`);
    // Back at the amount once continued past: the stop applies again, and the owner is asked again.
    const back = M.setBudgets(raised, { buildingUsd: spend, maintenanceUsdPerMonth: null }, at(5));
    expect(budgetStop(back)?.budgetUsd).toBe(spend);
    expect(running(M.dispatchEligible(back, at(6)), "EX-004")).toHaveLength(0);
    expect(needsYouItems(back, T0).some((i) => i.key === "budget")).toBe(true);
    // Changing only the maintenance budget leaves the building budget, and the choice to continue past it, as they were.
    const maintenance = M.setBudgets(past, { buildingUsd: spend, maintenanceUsdPerMonth: 5 }, at(4));
    expect(maintenance.project.budgetContinued).toEqual(past.project.budgetContinued);
    expect(budgetStop(maintenance)).toBeUndefined();
  });

  it("continuing past is refused while the budget is not reached, or not set", () => {
    const s = spentProject();
    expect(() => M.continuePastBudget(s, at(2))).toThrow(/not reached/);
    expect(() => M.continuePastBudget(M.setBudgets(s, { buildingUsd: 1000, maintenanceUsdPerMonth: null }, at(2)), at(3))).toThrow(/not reached/);
  });

  it("at the budget the lead's own planning stops too; your messages are still answered", () => {
    const s = M.applyAutopilot(spentProject(), "main", at(1));
    const late = T0 + 24 * 60 * 60_000;
    expect(M.leadDue(s, late, 12 * 60)).toBe("planning");
    const stopped = M.setBudgets(s, { buildingUsd: buildingSpend(s).usd, maintenanceUsdPerMonth: null }, at(2));
    expect(M.leadDue(stopped, late, 12 * 60)).toBeNull();
    expect(M.leadDue(M.postMessage(stopped, "How far are we?", at(3)), late, 12 * 60)).toBe("message");
  });

  it("the pinned price is what the stop uses: a run on a priced model counts its tokens", () => {
    const s = spentProject();
    const price = PRICES.find((p) => p.provider === "codex" && p.model === "gpt-6.1-sol")!;
    // The sample's seven finished runs at 1 cent each (spentProject), and the Codex run at the pinned price.
    expect(buildingSpend(s).usd).toBeCloseTo(0.07 + (35_118 * price.inputPerMTok + 330 * price.outputPerMTok) / 1_000_000, 10);
  });
});
