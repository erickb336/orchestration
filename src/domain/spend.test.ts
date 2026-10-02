// ORC-029 pass 2a: the building budget, estimated in dollars at the providers' published prices. What one run
// cost (reported, priced, or unknown and never zero), the project's spend, and the budget stop: at the budget
// nothing new starts and running work finishes, the owner is asked under Needs you, and raising the budget or
// continuing past it starts work again.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as M from "./model";
import { startFactoryAsOwner } from "./testing/factory";
import { needsYouItems } from "./needsYou";
import { buildSeed } from "./seed";
import { budgetStop, buildingSpend, estimateUsd, PRICES, type ModelPrice } from "./spend";
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
 * runs, so EX-004 starts on the next dispatch below the budget beside EX-001's next steps.
 */
function spentProject(): State {
  let s = M.setWorkerLimit(buildSeed(T0), 6, at(0));
  s = M.setProviderLimit(s, "claude", 6, at(0));
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
    expect(buildingSpend(s, LIST)).toEqual({ usd: 3.5, runs: 4, unknown: [{ runId: "run-c", provider: "codex", model: "gpt-mystery", reason: "no-price" }] });
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
    expect(buildingSpend(s, LIST)).toEqual({ usd: 2.25, runs: 4, unknown: [{ runId: "studio-4", provider: "codex", model: "gpt-test", reason: "no-usage" }] });
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
  const item = (s: State) => needsYouItems(s, T0).find((i) => i.key === "budget-unknown");

  it("are named under Needs you, apart from the stop: the budget cannot count them", () => {
    const s = withRuns([codexRun("run-a", "gpt-x", tokens), codexRun("run-b", "gpt-x", tokens), codexRun("run-c", "gpt-x", tokens), codexRun("run-d", "gpt-6.1-sol", { inputTokens: 1000, outputTokens: 100 })]);
    // No building budget (a maintenance budget alone does not count runs): nothing to enforce, nothing to say.
    expect(item(s)).toBeUndefined();
    expect(item(M.setBudgets(s, { buildingUsd: null, maintenanceUsdPerMonth: 50 }, at(1)))).toBeUndefined();
    // A budget far above the counted spend: the stop does not apply, but the owner is told.
    const set = M.setBudgets(s, { buildingUsd: 100, maintenanceUsdPerMonth: null }, at(1));
    expect(budgetStop(set)).toBeUndefined();
    expect(item(set)).toEqual({
      kind: "open",
      key: "budget-unknown",
      what: "3 runs have no recorded cost (model gpt-x has no price), so the building budget cannot count them",
      detail: "The budget's stop counts only runs with a recorded cost, so it can come late. Not counted: run-a (codex · gpt-x, no price), run-b (codex · gpt-x, no price), run-c (codex · gpt-x, no price).",
      action: "Settings",
      href: "#/settings/project",
    });
    // Once every run has a recorded cost there is nothing to say.
    expect(item(withRuns([codexRun("run-d", "gpt-6.1-sol", { inputTokens: 1000, outputTokens: 100 })]))).toBeUndefined();
  });

  it("names every model with no price and counts the runs with no usage, the lead's included; the first five runs are listed", () => {
    const lead: LeadRun = { id: "lead-1", trigger: "message", provider: "claude", model: "claude-opus-5-5", startedAt: at(0), endedAt: at(1), outcome: "lost", messageIds: [], sessionId: "s-1" };
    const s = withRuns(
      [codexRun("run-a", "gpt-x", tokens), codexRun("run-b", "gpt-y", tokens), codexRun("run-c", "gpt-x", tokens), codexRun("run-d", "gpt-z", tokens), codexRun("run-e", "gpt-6.1-sol")],
      [lead],
    );
    const one = item(M.setBudgets(s, { buildingUsd: 100, maintenanceUsdPerMonth: null }, at(1)));
    expect(one).toMatchObject({
      what: "6 runs have no recorded cost (models gpt-x, gpt-y and gpt-z have no price; no usage was recorded for 2), so the building budget cannot count them",
      detail:
        "The budget's stop counts only runs with a recorded cost, so it can come late. Not counted: run-a (codex · gpt-x, no price), run-b (codex · gpt-y, no price), " +
        "run-c (codex · gpt-x, no price), run-d (codex · gpt-z, no price), run-e (codex · gpt-6.1-sol, no usage recorded) and 1 more.",
    });
    const single = item(M.setBudgets(withRuns([], [lead]), { buildingUsd: 100, maintenanceUsdPerMonth: null }, at(1)));
    expect(single).toMatchObject({ what: "1 run has no recorded cost (no usage was recorded), so the building budget cannot count it" });
  });

  it("at the stop, both are asked: the stop first, then the runs it cannot count", () => {
    const s = withRuns([codexRun("run-a", "gpt-x", tokens), codexRun("run-d", "gpt-6.1-sol", { inputTokens: 1_000_000, outputTokens: 0 })]);
    const keys = needsYouItems(M.setBudgets(s, { buildingUsd: 2, maintenanceUsdPerMonth: null }, at(1)), T0).map((i) => i.key);
    expect(keys.slice(0, 2)).toEqual(["budget", "budget-unknown"]);
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

  it("asks the owner under Needs you with the spend and the budget, and says how many runs are not in the total", () => {
    const s = spentProject();
    const spend = buildingSpend(s);
    // The sample's finished runs recorded no usage.
    expect(spend.unknown).toHaveLength(7);
    const budget = Math.floor(spend.usd * 100) / 100;
    const at2 = M.setBudgets(s, { buildingUsd: budget, maintenanceUsdPerMonth: null }, at(2));
    const [first, second] = needsYouItems(at2, T0);
    expect(first).toMatchObject({ kind: "open", key: "budget", what: `The building budget is reached: $${spend.usd.toFixed(2)} of $${budget.toFixed(2)}`, href: "#/settings/project" });
    expect(first.kind === "open" && first.detail).toBe(
      "Estimated at the providers' published prices. Nothing new starts; running work finishes. Raise the budget, or continue past it. 7 runs with no recorded cost are not in the total.",
    );
    // The runs themselves are named by their own item, which stays while the budget is set.
    expect(second).toMatchObject({ kind: "open", key: "budget-unknown", what: "7 runs have no recorded cost (no usage was recorded), so the building budget cannot count them" });
    // Below the budget there is nothing to ask about the stop.
    expect(needsYouItems(M.setBudgets(s, { buildingUsd: spend.usd + 1, maintenanceUsdPerMonth: null }, at(2)), T0).some((i) => i.key === "budget")).toBe(false);
  });

  it("runs with no recorded cost are never counted as zero, and the owner is told the budget cannot count them", () => {
    const unknownOnly = finishCodexRun(M.startHeldTask(buildSeed(T0), "EX-004", at(0)), "gpt-unknown", { inputTokens: 9_000_000, outputTokens: 9_000_000 });
    expect(buildingSpend(unknownOnly).usd).toBe(0);
    expect(buildingSpend(unknownOnly).unknown).toContainEqual({ runId: expect.any(String), provider: "codex", model: "gpt-unknown", reason: "no-price" });
    // $9 of work on a model with no price: the $1 budget's stop cannot see it, so Needs you says so.
    const budgeted = M.setBudgets(unknownOnly, { buildingUsd: 1, maintenanceUsdPerMonth: null }, at(2));
    expect(budgetStop(budgeted)).toBeUndefined();
    expect(needsYouItems(budgeted, T0).find((i) => i.key === "budget-unknown")).toMatchObject({ kind: "open", what: expect.stringMatching(/^8 runs have no recorded cost \(model gpt-unknown has no price; no usage was recorded for 7\)/) });
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

  it("continuing past the budget is the owner's recorded choice; it starts work again until the budget changes or the project goes back to shaping", () => {
    const s = spentProject();
    const spend = buildingSpend(s).usd;
    const stopped = M.setBudgets(s, { buildingUsd: spend, maintenanceUsdPerMonth: null }, at(2));
    const past = runCommand(stopped, "continuePastBudget", {}, at(3)).state;
    expect(past.project.budgetContinued).toEqual({ at: at(3), buildingUsd: spend, spentUsd: spend });
    expect(past.events.at(-1)).toMatchObject({ actor: "user", kind: "config" });
    expect(past.events.at(-1)?.message).toMatch(/^Continued past the building budget \(\$0\.07 of \$0\.07\)/);
    expect(running(M.dispatchEligible(past, at(4)), "EX-004")).toHaveLength(1);
    expect(needsYouItems(past, T0).some((i) => i.key === "budget")).toBe(false);
    // A new budget amount the spend has reached stops again.
    const lowered = M.setBudgets(past, { buildingUsd: spend / 2, maintenanceUsdPerMonth: null }, at(5));
    expect(running(M.dispatchEligible(lowered, at(6)), "EX-004")).toHaveLength(0);
    // Going back to shaping ends it: the next start meets the stop again.
    const back = startFactoryAsOwner(M.startVision(past, at(5)), at(6));
    expect(back.project.budgetContinued).toBeUndefined();
    expect(budgetStop(back)?.budgetUsd).toBe(spend);
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
    expect(buildingSpend(s).usd).toBeCloseTo((35_118 * price.inputPerMTok + 330 * price.outputPerMTok) / 1_000_000, 10);
  });
});
