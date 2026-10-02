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
  /** Where the provider publishes one. Not used yet: no runtime reports cached input apart from the rest. */
  cachedInputPerMTok?: number;
  /** The provider's pricing page. */
  source: string;
  /** The date the price was read from `source` (YYYY-MM-DD). */
  checked: string;
  note?: string;
}

export const PRICES: readonly ModelPrice[] = pricesJson as ModelPrice[];

/**
 * One run's cost. Every figure is an estimate: a cost the runtime reports (Claude) is computed by the
 * runtime at list prices and is not billed on a subscription, and no run records how it was billed.
 * `unpriced`: no reported cost and no price for the model, or no usage at all; unknown, never zero.
 */
export type RunCost = { basis: "reported" | "priced"; usd: number; estimated: true } | { basis: "unpriced"; usd: null; estimated: true };

/** A task step's run or a lead run. */
type Run = Attempt | LeadRun;

/** The provider and the model a run ran on: the model the runtime reported, else the one it was started with. */
function ranOn(r: Run): { provider: Runner; model: string } {
  const started = "snapshot" in r ? r.snapshot : r;
  return { provider: started.provider, model: r.actualModel ?? started.model };
}

/**
 * A run's cost: the runtime's reported cost when there is one, otherwise its tokens at the model's price.
 * Every input token is priced at the full input price, since the runtimes report cached input inside the
 * input count: for a run that read from a cache, the figure is an upper bound.
 */
export function estimateUsd(run: Run, prices: readonly ModelPrice[]): RunCost {
  const u = run.usage;
  if (u?.costUsd !== undefined) return { basis: "reported", usd: u.costUsd, estimated: true };
  const { provider, model } = ranOn(run);
  const price = prices.find((p) => p.provider === provider && p.model === model);
  if (!price || u?.inputTokens === undefined || u.outputTokens === undefined) return { basis: "unpriced", usd: null, estimated: true };
  return { basis: "priced", usd: (u.inputTokens * price.inputPerMTok + u.outputTokens * price.outputPerMTok) / 1_000_000, estimated: true };
}

export interface Spend {
  /** Estimated dollars of the finished runs that have a figure. Unpriced runs are not in it. */
  usd: number;
  /** Finished runs counted. */
  runs: number;
  /** Finished runs whose cost is unknown. */
  unpriced: { runId: string; provider: Runner; model: string }[];
}

/**
 * The building spend: every finished agent run of the project, the lead's included (a new project
 * starts with none, so this is everything since its first Vision round). Check runs are the service's
 * own and cost nothing; running work is counted when it finishes.
 */
export function buildingSpend(s: State, prices: readonly ModelPrice[] = PRICES): Spend {
  const out: Spend = { usd: 0, runs: 0, unpriced: [] };
  const runs: Run[] = [...s.attempts.filter((a) => isProvider(a.snapshot.provider)), ...s.leadRuns];
  for (const r of runs) {
    if (r.outcome === "running" || r.outcome === "stopping") continue;
    out.runs++;
    const c = estimateUsd(r, prices);
    if (c.basis === "unpriced") out.unpriced.push({ runId: r.id, ...ranOn(r) });
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
