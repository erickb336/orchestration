// What the project's agent runs cost, estimated in dollars at the providers' published API prices
// (src/domain/prices.json, pinned and dated), the factory's budget stop, and whether a PE call stays within the
// budgets. Pure: derived from state only.

import pricesJson from "./prices.json";
import type { BudgetEstimate, StudioRun } from "./studio/types";
import { type Attempt, type FindingDecision, type LeadRun, type PeCall, type ProviderId, type Runner, type State, type Subagent, isProvider } from "./types";

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
 * `simulated`: the fake runtime ran it (a studio run records it); no agent ran, so it spent nothing: a known $0.
 * `unknown`: the run has no recorded cost (no reported cost, and no usage or no price to work one out);
 * unknown, never zero.
 */
export type RunCost = { basis: "reported" | "priced" | "not-started" | "simulated"; usd: number; estimated: true } | { basis: "unknown"; usd: null; estimated: true; reason: NoCostReason };

/** A task step's run, a lead run, or a studio run (Vision's). */
type Run = Attempt | LeadRun | StudioRun;

/** Where a run stands: a studio run's status, the others' outcome. */
const outcomeOf = (r: Run) => ("status" in r ? r.status : r.outcome);

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
  if (outcomeOf(r) !== "failed" && outcomeOf(r) !== "stopped") return false;
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
  if ("simulated" in run && run.simulated) return { basis: "simulated", usd: 0, estimated: true };
  const { provider, model } = ranOn(run);
  return priced(provider, model, u, prices);
}

/** Tokens at the model's published price; unknown without usage or without a price. */
function priced(provider: Runner, model: string, u: Usage | undefined, prices: readonly ModelPrice[]): RunCost {
  if (u?.inputTokens === undefined || u.outputTokens === undefined) return { basis: "unknown", usd: null, estimated: true, reason: "no-usage" };
  const price = prices.find((p) => p.provider === provider && p.model === model);
  if (!price) return { basis: "unknown", usd: null, estimated: true, reason: "no-price" };
  const cached = Math.min(Math.max(u.cachedInputTokens ?? 0, 0), u.inputTokens);
  const input = (u.inputTokens - cached) * price.inputPerMTok + cached * (price.cachedInputPerMTok ?? price.inputPerMTok);
  return { basis: "priced", usd: (input + u.outputTokens * price.outputPerMTok) / 1_000_000, estimated: true };
}

type Usage = Attempt["usage"];

/**
 * One subagent's cost (ORC-031), priced like a run: its reported cost, else its tokens at its model's price (the
 * parent's model when it reports none). A refused one never ran, and a simulated parent's helpers did not either: a
 * known $0. Without usage or a price, unknown, never zero.
 */
export function subagentUsd(parent: Run, sub: Subagent, prices: readonly ModelPrice[] = PRICES): RunCost {
  if (sub.ended === "refused") return { basis: "not-started", usd: 0, estimated: true };
  if ("simulated" in parent && parent.simulated) return { basis: "simulated", usd: 0, estimated: true };
  if (sub.usage?.costUsd !== undefined) return { basis: "reported", usd: sub.usage.costUsd, estimated: true };
  const on = ranOn(parent);
  return priced(on.provider, sub.model ?? on.model, sub.usage, prices);
}

/** What a run's subagents cost, as its page shows it. */
export interface SubagentsCost {
  /** Estimated dollars of the subagents with a figure. */
  usd: number;
  /** Of `usd`, the part already inside the parent run's own cost (Claude reports one total for the session). */
  inParentUsd: number;
  /** Subagents with no recorded cost, the unlisted ones included: unknown, never zero. */
  unknown: number;
}

export function subagentsCost(r: Run, prices: readonly ModelPrice[] = PRICES): SubagentsCost {
  const out: SubagentsCost = { usd: 0, inParentUsd: 0, unknown: r.subagents?.unlisted ?? 0 };
  for (const sub of r.subagents?.items ?? []) {
    const c = subagentUsd(r, sub, prices);
    if (c.basis === "unknown") out.unknown++;
    else {
      out.usd += c.usd;
      if (sub.usageInParent) out.inParentUsd += c.usd;
    }
  }
  return out;
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
  /** Finished runs with no recorded cost: unknown, never zero. The budget stop counts each at its run limit (`budgetStop`). */
  unknown: UnknownCost[];
}

/**
 * The building spend: every finished agent run of the project, the lead's and the studio's included (a new
 * project starts with none, so this is everything since its first Vision round, and Vision's work counts: spec
 * r5). Check runs are the service's own and cost nothing; running work is counted when it finishes, and a
 * studio run still queued has not run.
 */
export function buildingSpend(s: State, prices: readonly ModelPrice[] = PRICES): Spend {
  const out: Spend = { usd: 0, runs: 0, unknown: [] };
  const runs: Run[] = [...s.attempts.filter((a) => isProvider(a.snapshot.provider)), ...s.leadRuns, ...s.studio.runs];
  for (const r of runs) {
    const o = outcomeOf(r);
    if (o === "running" || o === "stopping" || o === "queued") continue;
    out.runs++;
    const c = estimateUsd(r, prices);
    if (c.basis === "unknown") out.unknown.push({ runId: r.id, ...ranOn(r), reason: c.reason });
    else out.usd += c.usd;
    addSubagents(out, r, prices);
  }
  return out;
}

/**
 * A finished run's subagents (ORC-031) count apart from it where its own usage does not include theirs (Codex's
 * sub-threads may report apart); where it does (Claude's session total), they are already in the run's cost. One with
 * no recorded cost is unknown, like a run; so is each unlisted one, whose usage was not kept.
 */
function addSubagents(out: Spend, r: Run, prices: readonly ModelPrice[]) {
  const rec = r.subagents;
  if (!rec) return;
  const on = ranOn(r);
  for (const sub of rec.items) {
    if (sub.usageInParent) continue;
    const c = subagentUsd(r, sub, prices);
    if (c.basis === "unknown") out.unknown.push({ runId: `${r.id} helper ${sub.id}`, provider: on.provider, model: sub.model ?? on.model, reason: c.reason });
    else out.usd += c.usd;
  }
  for (let i = 0; i < (rec.unlisted ?? 0); i++) out.unknown.push({ runId: `${r.id} unlisted helper ${i + 1}`, provider: on.provider, model: on.model, reason: "no-usage" });
}

/**
 * The most one run on this provider may spend, or undefined when it has no limit. Claude's is its spend cap, the
 * project's run limit (a run does not record its own, so one started under another limit counts at today's). Codex
 * has no spend cap.
 */
export const runLimitUsd = (s: State, provider: Runner): number | undefined => (provider === "claude" ? s.project.runLimits.maxBudgetUsd : undefined);

/** Why nothing new starts at the building budget. */
export interface BudgetStop {
  budgetUsd: number;
  spend: Spend;
  /** The spend with each run of no recorded cost counted at its run limit; null when one has no limit, so the spend cannot be checked. */
  countedUsd: number | null;
  /** Why, in one line for the owner. */
  why: string;
}

/**
 * The building budget is reached, or the spend cannot be checked against it: nothing new starts until the owner raises
 * it or continues past it. Undefined while no building budget is set, below it, or after the owner chose to continue
 * past this amount. A finished run with no recorded cost is unknown, never $0 (review finding 4): it counts at its run
 * limit, the most it could have spent (the rule of the studio trial, scripts/trialSpend.mjs); a run with no limit
 * cannot be counted, so the stop holds new runs and says why.
 */
export function budgetStop(s: State, prices: readonly ModelPrice[] = PRICES): BudgetStop | undefined {
  const budgetUsd = s.project.budgets.buildingUsd;
  if (budgetUsd === null || s.project.budgetContinued?.buildingUsd === budgetUsd) return undefined;
  const spend = buildingSpend(s, prices);
  const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;
  const unlimited = spend.unknown.filter((u) => runLimitUsd(s, u.provider) === undefined).length;
  if (unlimited) return { budgetUsd, spend, countedUsd: null, why: `The building spend cannot be checked against the ${fmtUsd(budgetUsd)} budget: ${runs(unlimited)} with no recorded cost ${unlimited === 1 ? "has" : "have"} no spend limit` };
  const countedUsd = spend.unknown.reduce((usd, u) => usd + runLimitUsd(s, u.provider)!, spend.usd);
  if (countedUsd < budgetUsd) return undefined;
  const counted = spend.unknown.length ? `, counting ${runs(spend.unknown.length)} with no recorded cost at the ${fmtUsd(s.project.runLimits.maxBudgetUsd)} run limit` : "";
  return { budgetUsd, spend, countedUsd, why: `The building budget is reached: ${fmtUsd(countedUsd)} of ${fmtUsd(budgetUsd)}${counted}` };
}

/** "$12.34". */
export const fmtUsd = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * The PE calls that stand: decisions whose outcome is the PE's call, whoever took it (the PE within budget, or the
 * owner, who took a call that went to them). A call the owner reversed or reopened does not stand.
 */
function standingPeCalls(s: State): (FindingDecision & { pe: PeCall })[] {
  return s.decisions.filter((d): d is FindingDecision & { pe: PeCall } => !!d.pe && d.status === d.pe.decision);
}

/** The project's estimated maintenance, in dollars a month (the high ends). */
export interface MaintenanceEstimate {
  /** The newest factory start's estimate (the PE's pre-flight, pass 6); null while none was made: not yet estimated, never $0. */
  startUsd: number | null;
  /** What the PE calls that stand add. */
  callsUsd: number;
}

/** The newest factory start's maintenance estimate, and what each PE call that stands adds to it. */
export function maintenanceEstimate(s: State): MaintenanceEstimate {
  let callsUsd = 0;
  for (const d of standingPeCalls(s)) callsUsd += d.pe.cost?.maintenanceUsdPerMonth?.[1] ?? 0;
  return { startUsd: s.project.factoryStarts.at(-1)?.estimate?.maintenanceUsdPerMonth?.[1] ?? null, callsUsd };
}

/**
 * What the PE calls that stand commit to the building spend before their work has run: the high end of each stated
 * build cost, for a fix no run has carried yet (`usedBy` empty), and for a follow-up whose task has not started. Once
 * the work has run, its runs count in `buildingSpend` instead, so nothing is counted twice.
 */
export function committedBuildUsd(s: State): number {
  let usd = 0;
  for (const d of standingPeCalls(s)) {
    const more = d.pe.cost?.buildUsd?.[1] ?? 0;
    if (more <= 0) continue;
    if (d.status === "fix" && d.usedBy.length === 0) usd += more;
    else if (d.status === "follow-up") {
      const t = s.tasks.find((x) => x.id === d.followUpTaskId);
      if (t && (t.lifecycle === "proposed" || t.lifecycle === "ready") && !s.attempts.some((a) => a.taskId === t.id)) usd += more;
    }
  }
  return usd;
}

/**
 * Why a PE call with this stated cost is not the PE's to make, or undefined when it stays within the budgets. Spending
 * past a budget is never the PE's call (ORC-029): the high end of each stated range counts, and while a budget is set
 * the call must state its figure for it (0 is a figure), since a cost not stated is unknown, never zero.
 * - Building: what was spent, plus what the PE calls that stand commit before their work has run, plus this call. A run
 *   with no recorded cost makes the spend unknown, so a call that adds any building cost goes to the owner.
 * - Maintenance: the pre-flight's estimate, plus the PE calls that stand, plus this call. While the pre-flight has made no
 *   estimate, the maintenance is unknown, so a call that adds any maintenance cost goes to the owner.
 * - A call that adds nothing passes even when the spend is already past the budget (the owner continued past it).
 */
export function pastBudget(s: State, cost: BudgetEstimate | undefined, prices: readonly ModelPrice[] = PRICES): string | undefined {
  const b = s.project.budgets;
  const why: string[] = [];
  if (b.buildingUsd !== null) {
    const more = cost?.buildUsd?.[1];
    const spend = buildingSpend(s, prices);
    const committed = committedBuildUsd(s);
    const total = spend.usd + committed;
    const unknown = spend.unknown.length;
    if (more === undefined) why.push(`it states no building cost, and the building budget is ${fmtUsd(b.buildingUsd)}`);
    else if (more > 0 && total + more > b.buildingUsd)
      why.push(`up to ${fmtUsd(more)} more would take the building spend to ${fmtUsd(total + more)}, past the ${fmtUsd(b.buildingUsd)} budget (${fmtUsd(spend.usd)} spent${committed ? `, up to ${fmtUsd(committed)} committed to PE calls whose work has not run` : ""})`);
    else if (more > 0 && unknown)
      why.push(`${unknown} run${unknown === 1 ? " has" : "s have"} no recorded cost, so the building spend is unknown, and up to ${fmtUsd(more)} more cannot be checked against the ${fmtUsd(b.buildingUsd)} budget`);
  }
  if (b.maintenanceUsdPerMonth !== null) {
    const more = cost?.maintenanceUsdPerMonth?.[1];
    const m = maintenanceEstimate(s);
    if (more === undefined) why.push(`it states no maintenance cost, and the maintenance budget is ${fmtUsd(b.maintenanceUsdPerMonth)} a month`);
    else if (more > 0 && m.startUsd === null) why.push(`the project's maintenance is not yet estimated, so up to ${fmtUsd(more)} more a month cannot be checked against the ${fmtUsd(b.maintenanceUsdPerMonth)} budget`);
    else if (more > 0 && m.startUsd! + m.callsUsd + more > b.maintenanceUsdPerMonth)
      why.push(`up to ${fmtUsd(more)} more a month would take the maintenance estimate to ${fmtUsd(m.startUsd! + m.callsUsd + more)}, past the ${fmtUsd(b.maintenanceUsdPerMonth)} budget`);
  }
  return why.length ? why.join("; ") : undefined;
}
