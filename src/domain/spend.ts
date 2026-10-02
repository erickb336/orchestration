// What the project's agent runs cost, estimated in dollars at the providers' published API prices
// (src/domain/prices.json, pinned and dated), and the factory's budget stop. Pure: derived from state only.

import pricesJson from "./prices.json";
import { type Attempt, type LeadRun, type ProviderId, type Runner, type State, isProvider } from "./types";

/** One model's published API price, in dollars per million tokens, with where and when it was read. */
export interface ModelPrice {
  provider: ProviderId;
  /** The exact model id a runtime reports (`actualModel`), not an alias. */
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** The price of input read from the provider's prompt cache, where the provider publishes one: used for a run's `cachedInputTokens`. */
  cachedInputPerMTok?: number;
  /** The provider's pricing page. */
  source: string;
  /** The date the price was read from `source` (YYYY-MM-DD). */
  checked: string;
  note?: string;
}

export const PRICES: readonly ModelPrice[] = pricesJson as ModelPrice[];

/** Why a run has no recorded cost: its model has no price, or no usage was recorded for it. */
export type NoCostReason = "no-price" | "no-usage";

/**
 * One run's cost. Every figure is an estimate: a cost the runtime reports (Claude) is computed by the
 * runtime at list prices and is not billed on a subscription, and no run records how it was billed.
 * `not-started`: the run ended before its runtime started it, so nothing ran: a known $0 (see `neverStarted`).
 * `unknown`: the run has no recorded cost (no reported cost, and no usage or no price to work one out);
 * unknown, never zero.
 */
export type RunCost = { basis: "reported" | "priced" | "not-started"; usd: number; estimated: true } | { basis: "unknown"; usd: null; estimated: true; reason: NoCostReason };

/** A task step's run or a lead run. */
type Run = Attempt | LeadRun;

/** The provider and the model a run ran on: the model the runtime reported, else the one it was started with. */
function ranOn(r: Run): { provider: Runner; model: string } {
  const started = "snapshot" in r ? r.snapshot : r;
  return { provider: started.provider, model: r.actualModel ?? started.model };
}

/**
 * The run ended before its runtime started it, so it cost nothing. Read from the run's own fields:
 * - it failed or was stopped (a completed run ran; a lost run's process may have run unobserved);
 * - the runtime never reported its start: no session id and no model. Both real runtimes report them as the
 *   run starts and before any model request (Codex its thread id once the thread exists, before the turn that
 *   uses tokens; Claude its session id on the session's init, before the first request);
 * - and it recorded no tokens and no cost.
 * A run that started and then ended with no usage stays unknown: it may have used tokens nobody recorded.
 */
function neverStarted(r: Run): boolean {
  if (r.outcome !== "failed" && r.outcome !== "stopped") return false;
  if (r.sessionId !== undefined || r.actualModel !== undefined) return false;
  const u = r.usage;
  return u === undefined || (u.costUsd === undefined && !u.inputTokens && !u.outputTokens);
}

/**
 * A run's cost: the runtime's reported cost when there is one (Claude's), otherwise its tokens at the model's price.
 * The input read from the provider's prompt cache (`cachedInputTokens`, part of `inputTokens`; Codex reports it)
 * is priced at the cached-input price where one is published, and the rest of the input at the full price.
 * Claude reports its cache reads and writes only inside its input count, so were its reported cost missing, its
 * input would all be priced at the full price: too high for cache reads, too low for cache writes.
 */
export function estimateUsd(run: Run, prices: readonly ModelPrice[]): RunCost {
  const u = run.usage;
  if (u?.costUsd !== undefined) return { basis: "reported", usd: u.costUsd, estimated: true };
  if (neverStarted(run)) return { basis: "not-started", usd: 0, estimated: true };
  if (u?.inputTokens === undefined || u.outputTokens === undefined) return { basis: "unknown", usd: null, estimated: true, reason: "no-usage" };
  const { provider, model } = ranOn(run);
  const price = prices.find((p) => p.provider === provider && p.model === model);
  if (!price) return { basis: "unknown", usd: null, estimated: true, reason: "no-price" };
  const cached = Math.min(Math.max(u.cachedInputTokens ?? 0, 0), u.inputTokens);
  const input = (u.inputTokens - cached) * price.inputPerMTok + cached * (price.cachedInputPerMTok ?? price.inputPerMTok);
  return { basis: "priced", usd: (input + u.outputTokens * price.outputPerMTok) / 1_000_000, estimated: true };
}

/** A finished run with no recorded cost, and why. */
export interface UnknownCost {
  runId: string;
  provider: Runner;
  model: string;
  reason: NoCostReason;
}

export interface Spend {
  /** Estimated dollars of the finished runs that have a figure. Runs with no recorded cost are not in it. */
  usd: number;
  /** Finished runs counted. */
  runs: number;
  /** Finished runs with no recorded cost: unknown, never zero, so the budget cannot count them. */
  unknown: UnknownCost[];
}

/**
 * The building spend: every finished agent run of the project, the lead's included (a new project
 * starts with none, so this is everything since its first Vision round). Check runs are the service's
 * own and cost nothing; running work is counted when it finishes.
 */
export function buildingSpend(s: State, prices: readonly ModelPrice[] = PRICES): Spend {
  const out: Spend = { usd: 0, runs: 0, unknown: [] };
  const runs: Run[] = [...s.attempts.filter((a) => isProvider(a.snapshot.provider)), ...s.leadRuns];
  for (const r of runs) {
    if (r.outcome === "running" || r.outcome === "stopping") continue;
    out.runs++;
    const c = estimateUsd(r, prices);
    if (c.basis === "unknown") out.unknown.push({ runId: r.id, ...ranOn(r), reason: c.reason });
    else out.usd += c.usd;
  }
  return out;
}

/**
 * The building budget is reached: nothing new starts until the owner raises it or continues past it.
 * Undefined while no building budget is set, below it, or after the owner chose to continue past this amount.
 */
export function budgetStop(s: State, prices: readonly ModelPrice[] = PRICES): { budgetUsd: number; spend: Spend } | undefined {
  const budgetUsd = s.project.budgets.buildingUsd;
  if (budgetUsd === null || s.project.budgetContinued?.buildingUsd === budgetUsd) return undefined;
  const spend = buildingSpend(s, prices);
  return spend.usd >= budgetUsd ? { budgetUsd, spend } : undefined;
}

/** "$12.34". */
export const fmtUsd = (usd: number) => `$${usd.toFixed(2)}`;
