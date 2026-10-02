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

  it("an unknown model, a model of another provider, or a run with no usage is unpriced: unknown, never zero", () => {
    const tokens = { inputTokens: 1000, outputTokens: 100 };
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-unknown", usage: tokens }), LIST)).toEqual({ basis: "unpriced", usd: null, estimated: true });
    expect(estimateUsd(attempt({ provider: "claude", model: "gpt-test", usage: tokens }), LIST).basis).toBe("unpriced");
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test" }), LIST).basis).toBe("unpriced");
    expect(estimateUsd(attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 1000 } }), LIST).basis).toBe("unpriced");
  });

  it("prices a lead run the same way", () => {
    const r: LeadRun = { id: "lead-1", trigger: "message", provider: "codex", model: "gpt-test", startedAt: at(0), endedAt: at(1), outcome: "completed", messageIds: [], usage: { inputTokens: 500_000, outputTokens: 0 } };
    expect(estimateUsd(r, LIST)).toEqual({ basis: "priced", usd: 1, estimated: true });
  });
});

describe("the building spend", () => {
  it("sums the project's finished agent and lead runs, lists the unpriced ones, and leaves out running work and check runs", () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    s.attempts = [
      { ...attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 1_000_000, outputTokens: 0 } }), id: "run-a" },
      { ...attempt({ provider: "claude", model: "sonnet", usage: { costUsd: 0.5 } }), id: "run-b" },
      { ...attempt({ provider: "codex", model: "gpt-mystery", usage: { inputTokens: 10, outputTokens: 10 } }), id: "run-c" },
      { ...attempt({ provider: "codex", model: "gpt-test", usage: { inputTokens: 9_000_000, outputTokens: 0 }, outcome: "running" }), id: "run-d" },
      { ...attempt({ provider: "service", model: "checks" }), id: "run-e" },
    ];
    s.leadRuns = [{ id: "lead-1", trigger: "planning", provider: "claude", model: "claude-test-20260101", startedAt: at(0), endedAt: at(1), outcome: "failed", messageIds: [], usage: { inputTokens: 1_000_000, outputTokens: 0 } }];
    expect(buildingSpend(s, LIST)).toEqual({ usd: 3.5, runs: 4, unpriced: [{ runId: "run-c", provider: "codex", model: "gpt-mystery" }] });
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

  it("asks the owner under Needs you with the spend and the budget, and names the runs whose cost is unknown", () => {
    const s = spentProject();
    const spend = buildingSpend(s);
    // The sample's finished runs ran on sample models that have no price.
    expect(spend.unpriced.length).toBeGreaterThan(0);
    const budget = Math.floor(spend.usd * 100) / 100;
    const at2 = M.setBudgets(s, { buildingUsd: budget, maintenanceUsdPerMonth: null }, at(2));
    const [first] = needsYouItems(at2, T0);
    expect(first).toMatchObject({ kind: "open", key: "budget", what: `The building budget is reached: $${spend.usd.toFixed(2)} of $${budget.toFixed(2)}`, href: "#/settings/project" });
    expect(first.kind === "open" && first.detail).toBe(
      "Estimated at the providers' published prices. Nothing new starts; running work finishes. Raise the budget, or continue past it. " +
        "7 runs have no price, so their cost is unknown and not in the total: run-1 (claude · claude-sample-large), run-3 (codex · codex-sample-large), " +
        "run-5 (claude · claude-sample-fast), run-6 (codex · codex-sample-fast), run-7 (claude · claude-sample-large) and 2 more.",
    );
    // Below the budget there is nothing to ask.
    expect(needsYouItems(M.setBudgets(s, { buildingUsd: spend.usd + 1, maintenanceUsdPerMonth: null }, at(2)), T0).some((i) => i.key === "budget")).toBe(false);
    // An unpriced run is never counted as zero toward the stop either: with only unpriced runs, the spend is $0 and nothing stops.
    const unpricedOnly = finishCodexRun(M.startHeldTask(buildSeed(T0), "EX-004", at(0)), "gpt-unknown", { inputTokens: 9_000_000, outputTokens: 9_000_000 });
    expect(buildingSpend(unpricedOnly).usd).toBe(0);
    expect(buildingSpend(unpricedOnly).unpriced.map((u) => u.model)).toContain("gpt-unknown");
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
