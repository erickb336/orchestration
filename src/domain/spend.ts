// What the project's agent runs cost, estimated in dollars at the providers' published API prices
// (src/domain/prices.json, pinned and dated), the factory's budget stop, and whether a PE call stays within the
// budgets. Pure: derived from state only.

import pricesJson from "./prices.json";
import { covers } from "./studio/studio";
import { type BlueprintItem, type BudgetEstimate, type ItemEstimate, type StudioRun, type UsdRange, KIND_RULES } from "./studio/types";
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

/**
 * Why a run has no full record of its cost: its model has no price; no usage was recorded for it; or it ended with a
 * model request open, whose usage the provider never reported (Codex reports a request's usage when it completes).
 */
export type NoCostReason = "no-price" | "no-usage" | "open-request";

/**
 * One run's cost. Every figure is an estimate: a cost the runtime reports (Claude) is computed by the
 * runtime at list prices and is not billed on a subscription, and no run records how it was billed.
 * `not-started`: the run ended before its runtime started it, so nothing ran: a known $0 (see `neverStarted`).
 * `simulated`: the fake runtime ran it (a studio run records it); no agent ran, so it spent nothing: a known $0.
 * `unknown`: the run has no full record of its cost (no reported cost, and no usage or no price to work one out, or a
 * model request with no usage report); unknown, never zero. `recordedUsd`: for an open request, what the requests
 * that completed cost.
 */
export type RunCost =
  | { basis: "reported" | "priced" | "not-started" | "simulated"; usd: number; estimated: true }
  | { basis: "unknown"; usd: null; estimated: true; reason: NoCostReason; recordedUsd?: number };

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
  return u === undefined || (u.costUsd === undefined && !u.inputTokens && !u.outputTokens && !u.openRequest);
}

/**
 * A run's cost: the runtime's reported cost when there is one (Claude's), otherwise its tokens at the model's price.
 * The input read from the provider's prompt cache (`cachedInputTokens`, part of `inputTokens`; Codex reports it)
 * is priced at the cached-input price where one is published, and the rest of the input at the full price.
 * Claude reports its cache reads and writes only inside its input count, so were its reported cost missing, its
 * input would all be priced at the full price: too high for cache reads, too low for cache writes.
 * A run that ended with a model request open (`openRequest`, Codex) is unknown, never $0, whatever completed before it.
 */
export function estimateUsd(run: Run, prices: readonly ModelPrice[]): RunCost {
  const u = run.usage;
  if (u?.costUsd !== undefined) return { basis: "reported", usd: u.costUsd, estimated: true };
  if (neverStarted(run)) return { basis: "not-started", usd: 0, estimated: true };
  if ("simulated" in run && run.simulated) return { basis: "simulated", usd: 0, estimated: true };
  const { provider, model } = ranOn(run);
  const c = priced(provider, model, u, prices);
  return c.basis === "priced" && u?.openRequest ? { basis: "unknown", usd: null, estimated: true, reason: "open-request", recordedUsd: c.usd } : c;
}

/** Tokens at the model's published price; unknown without usage or without a price. No tokens cost $0 at any price. */
function priced(provider: Runner, model: string, u: Usage | undefined, prices: readonly ModelPrice[]): RunCost {
  if (u?.inputTokens === undefined || u.outputTokens === undefined) return { basis: "unknown", usd: null, estimated: true, reason: "no-usage" };
  if (u.inputTokens === 0 && u.outputTokens === 0) return { basis: "priced", usd: 0, estimated: true };
  const price = prices.find((p) => p.provider === provider && p.model === model);
  return price ? { basis: "priced", usd: tokensAt(price, u), estimated: true } : { basis: "unknown", usd: null, estimated: true, reason: "no-price" };
}

/** The tokens' dollars at one price: cached input at the cached-input price where one is published. */
function tokensAt(price: Pick<ModelPrice, "inputPerMTok" | "outputPerMTok" | "cachedInputPerMTok">, u: Usage & {}): number {
  const inputTokens = u.inputTokens ?? 0;
  const cached = Math.min(Math.max(u.cachedInputTokens ?? 0, 0), inputTokens);
  const input = (inputTokens - cached) * price.inputPerMTok + cached * (price.cachedInputPerMTok ?? price.inputPerMTok);
  return (input + (u.outputTokens ?? 0) * price.outputPerMTok) / 1_000_000;
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
  /** Subagents of a run still under way that have not ended: their cost comes when they end. */
  running: number;
}

export function subagentsCost(r: Run, prices: readonly ModelPrice[] = PRICES): SubagentsCost {
  const out: SubagentsCost = { usd: 0, inParentUsd: 0, unknown: r.subagents?.unlisted ?? 0, running: 0 };
  const live = ["running", "stopping"].includes(outcomeOf(r));
  for (const sub of r.subagents?.items ?? []) {
    if (live && !sub.ended) {
      out.running++;
      continue;
    }
    const c = subagentUsd(r, sub, prices);
    if (c.basis === "unknown") out.unknown++;
    else {
      out.usd += c.usd;
      if (sub.usageInParent) out.inParentUsd += c.usd;
    }
  }
  return out;
}

/**
 * A finished run's cost with no full record, and why, with what the budgets count for it beyond the recorded spend
 * (`countedUsd`): an estimate, or null when nothing bounds it. Unknown, never zero.
 * - open-request: one model request the provider never reported, at the dearest finished run on the same model so far
 *   (a run has at least one whole request), or at the run limit before there is one;
 * - no-price: the run's tokens at the dearest price its provider has in the list; null if it has none;
 * - no-usage: a Claude run at its run limit, its spend cap (a run does not record its own, so one started under
 *   another limit counts at today's); null for a Codex run, which has no spend cap.
 */
export interface UnknownCost {
  runId: string;
  provider: Runner;
  model: string;
  reason: NoCostReason;
  countedUsd: number | null;
}

export interface Spend {
  /** Estimated dollars of what the finished runs recorded. The costs with no full record are not in it. */
  usd: number;
  /** Finished runs counted. */
  runs: number;
  /** Finished runs' costs with no full record: unknown, never zero, each with what the budgets count for it. */
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
  const finished: Run[] = [...s.attempts.filter((a) => isProvider(a.snapshot.provider)), ...s.leadRuns, ...s.studio.runs].filter((r) => !["running", "stopping", "queued"].includes(outcomeOf(r)));
  const costs = finished.map((r) => estimateUsd(r, prices));
  // The dearest finished run on each model with a full record: the estimate of one request its provider did not report.
  const dearest = new Map<string, number>();
  finished.forEach((r, i) => {
    const c = costs[i];
    const key = modelKey(ranOn(r));
    if (c.basis === "reported" || c.basis === "priced") dearest.set(key, Math.max(dearest.get(key) ?? 0, c.usd));
  });
  const openRequestUsd = (r: Run) => dearest.get(modelKey(ranOn(r))) || s.project.runLimits.maxBudgetUsd;
  finished.forEach((r, i) => {
    out.runs++;
    const c = costs[i];
    if (c.basis !== "unknown") out.usd += c.usd;
    else {
      out.usd += c.recordedUsd ?? 0;
      const on = ranOn(r);
      const counted =
        c.reason === "open-request" ? openRequestUsd(r) : c.reason === "no-price" ? atDearestPrice(on.provider, r.usage, prices) : on.provider === "claude" ? s.project.runLimits.maxBudgetUsd : null;
      out.unknown.push({ runId: r.id, ...on, reason: c.reason, countedUsd: counted !== null && c.reason === "no-price" && r.usage?.openRequest ? counted + openRequestUsd(r) : counted });
    }
    addSubagents(out, r, prices);
  });
  return out;
}

const modelKey = (on: { provider: Runner; model: string }) => `${on.provider}\n${on.model}`;

/** Tokens at the dearest price the provider has in the list, input, cached input and output each; null when it has none. */
function atDearestPrice(provider: Runner, u: Usage | undefined, prices: readonly ModelPrice[]): number | null {
  const mine = prices.filter((p) => p.provider === provider);
  if (!mine.length || !u) return null;
  const top = (f: (p: ModelPrice) => number) => Math.max(...mine.map(f));
  return tokensAt({ inputPerMTok: top((p) => p.inputPerMTok), outputPerMTok: top((p) => p.outputPerMTok), cachedInputPerMTok: top((p) => p.cachedInputPerMTok ?? p.inputPerMTok) }, u);
}

/**
 * A finished run's subagents (ORC-031) count apart from it where its own usage does not include theirs (Codex's
 * sub-threads may report apart); where it does (Claude's session total), they are already in the run's cost. One with
 * no recorded cost is unknown, like a run; so is each unlisted one, whose usage was not kept. Neither has an estimate.
 */
function addSubagents(out: Spend, r: Run, prices: readonly ModelPrice[]) {
  const rec = r.subagents;
  if (!rec) return;
  const on = ranOn(r);
  for (const sub of rec.items) {
    if (sub.usageInParent) continue;
    const c = subagentUsd(r, sub, prices);
    if (c.basis === "unknown") out.unknown.push({ runId: `${r.id} helper ${sub.id}`, provider: on.provider, model: sub.model ?? on.model, reason: c.reason, countedUsd: null });
    else out.usd += c.usd;
  }
  for (let i = 0; i < (rec.unlisted ?? 0); i++) out.unknown.push({ runId: `${r.id} unlisted helper ${i + 1}`, provider: on.provider, model: on.model, reason: "no-usage", countedUsd: null });
}

/** The spend the budgets count: the recorded spend and each cost with no full record at its estimate; null when one has none. */
export function countedSpend(spend: Spend): number | null {
  if (spend.unknown.some((u) => u.countedUsd === null)) return null;
  return spend.unknown.reduce((usd, u) => usd + u.countedUsd!, spend.usd);
}

/** What the estimates in the counted spend add. */
const estimatedUsd = (spend: Spend) => spend.unknown.reduce((usd, u) => usd + (u.countedUsd ?? 0), 0);

/** Why nothing new starts at the building budget. */
export interface BudgetStop {
  budgetUsd: number;
  spend: Spend;
  /** The counted spend (`countedSpend`); null when a cost has nothing to count it at, so the spend cannot be checked. */
  countedUsd: number | null;
  /** Why, in one line for the owner. */
  why: string;
}

const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;

/**
 * The building budget is reached, or the spend cannot be checked against it: nothing new starts until the owner raises
 * it or continues past it. Undefined while no building budget is set, below it, or after the owner chose to continue
 * past this amount. A cost with no full record is unknown, never $0 (review finding 4): it counts at its estimate
 * (`UnknownCost`); one with nothing to count it at holds new runs, and the stop says why.
 */
export function budgetStop(s: State, prices: readonly ModelPrice[] = PRICES): BudgetStop | undefined {
  const budgetUsd = s.project.budgets.buildingUsd;
  if (budgetUsd === null || s.project.budgetContinued?.buildingUsd === budgetUsd) return undefined;
  const spend = buildingSpend(s, prices);
  const countedUsd = countedSpend(spend);
  if (countedUsd === null) {
    const n = spend.unknown.filter((u) => u.countedUsd === null).length;
    return { budgetUsd, spend, countedUsd, why: `The building spend cannot be checked against the ${fmtUsd(budgetUsd)} budget: ${runs(n)} with no recorded cost ${n === 1 ? "has" : "have"} no spend limit` };
  }
  if (countedUsd < budgetUsd) return undefined;
  const n = spend.unknown.length;
  const estimate = n ? `, of which ${fmtUsd(estimatedUsd(spend))} is an estimate for ${n} unrecorded cost${n === 1 ? "" : "s"}` : "";
  return { budgetUsd, spend, countedUsd, why: `The building budget is reached: ${fmtUsd(countedUsd)} of ${fmtUsd(budgetUsd)}${estimate}` };
}

/**
 * The costs with no full record, in one line for the owner, or undefined when there is none: "2 unrecorded costs count
 * at an estimate of $0.15." A cost with nothing to count it at makes the spend unknown.
 */
export function unrecordedWords(spend: Spend): string | undefined {
  const n = spend.unknown.length;
  if (!n) return undefined;
  const none = spend.unknown.filter((u) => u.countedUsd === null).length;
  if (none) return `${runs(none)} ${none === 1 ? "has" : "have"} no recorded cost and no spend limit, so the spend cannot be checked.${n > none ? ` ${n - none} more unrecorded cost${n - none === 1 ? " counts" : "s count"} at an estimate of ${fmtUsd(estimatedUsd(spend))}.` : ""}`;
  return `${n} unrecorded cost${n === 1 ? " counts" : "s count"} at an estimate of ${fmtUsd(estimatedUsd(spend))}: ${whyUnrecorded(spend.unknown)}.`;
}

/** "a model request Codex did not report; model gpt-x has no price". */
function whyUnrecorded(unknown: UnknownCost[]): string {
  const open = unknown.filter((u) => u.reason === "open-request").length;
  const models = [...new Set(unknown.filter((u) => u.reason === "no-price").map((u) => u.model))];
  const noUsage = unknown.filter((u) => u.reason === "no-usage").length;
  return [
    ...(open ? [`${open === 1 ? "a model request" : `${open} model requests`} the provider did not report, each at the dearest run on its model`] : []),
    ...(models.length ? [`${models.length === 1 ? "model" : "models"} ${models.join(", ")} ${models.length === 1 ? "has" : "have"} no price, so the dearest price of its provider applies`] : []),
    ...(noUsage ? [`${runs(noUsage)} with no usage, each at the run limit`] : []),
  ].join("; ");
}

/** "$12.34". */
export const fmtUsd = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * The PE calls that stand: decisions whose outcome is the PE's call, whoever took it (the PE within budget, or the
 * owner, who took a call that went to them). A call the owner reversed or reopened does not stand.
 */
function standingPeCalls(s: State): (FindingDecision & { pe: PeCall })[] {
  return s.decisions.filter(isStandingPeCall);
}

/** A PE call that stands: the budgets count it (`maintenanceEstimate`, `committedBuildUsd`), so its record is kept. */
export const isStandingPeCall = (d: FindingDecision): d is FindingDecision & { pe: PeCall } => !!d.pe && d.status === d.pe.decision;

// ---------- the PE's estimates of the approved parts (B-03) ----------

/** The PE's newest estimate on the item's version (and variant), from its review of that version; null: no estimate (never $0). */
export function itemEstimate(s: State, item: BlueprintItem): ItemEstimate {
  const v = s.studio.verdicts.filter((x) => x.artifactId === item.artifactId && x.version === item.version && covers(x, item.variant) && x.budget).at(-1);
  return { itemId: item.id, estimate: v?.budget ? structuredClone(v.budget) : null };
}

/**
 * The parts the factory builds and the PE estimates: the approved items in force, but not a word list (the PE does not
 * review one) and not a reproduction of the code as it is today (it exists already).
 */
export function estimatedParts(s: State): BlueprintItem[] {
  const asIs = (i: BlueprintItem) => s.studio.artifacts.some((a) => a.id === i.artifactId && a.version === i.version && a.provenance);
  return (s.blueprint.revisions.at(-1)?.items ?? []).filter((i) => i.status === "approved" && KIND_RULES[i.kind].peReviews && !asIs(i));
}

/** One range of the PE's estimates summed over some parts: null while a part has no figure for it (`missing`). */
export interface PartsSum {
  usd: UsdRange | null;
  parts: number;
  missing: number;
}

export function sumOfParts(s: State, parts: BlueprintItem[], pick: (e: BudgetEstimate) => UsdRange | undefined): PartsSum {
  let lo = 0;
  let hi = 0;
  let missing = 0;
  for (const part of parts) {
    const e = itemEstimate(s, part).estimate;
    const r = e ? pick(e) : undefined;
    if (!r) missing++;
    else [lo, hi] = [lo + r[0], hi + r[1]];
  }
  return { usd: missing ? null : [lo, hi], parts: parts.length, missing };
}

/** The project's estimated maintenance, in dollars a month (the high ends). */
export interface MaintenanceEstimate {
  /**
   * The PE's monthly estimates summed over the approved parts (`estimatedParts`); null while no part is approved or one
   * has no monthly figure (`missing` of `parts`): not estimated, never $0.
   */
  partsUsd: number | null;
  parts: number;
  missing: number;
  /** What the PE calls that stand add. */
  callsUsd: number;
}

/** The PE's monthly estimates of the approved parts, and what each PE call that stands adds to them. */
export function maintenanceEstimate(s: State): MaintenanceEstimate {
  let callsUsd = 0;
  for (const d of standingPeCalls(s)) callsUsd += d.pe.cost?.maintenanceUsdPerMonth?.[1] ?? 0;
  const sum = sumOfParts(s, estimatedParts(s), (e) => e.maintenanceUsdPerMonth);
  return { partsUsd: sum.parts && sum.usd ? sum.usd[1] : null, parts: sum.parts, missing: sum.missing, callsUsd };
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
 * - Building: the counted spend (each cost with no full record at its estimate), plus what the PE calls that stand
 *   commit before their work has run, plus this call. A cost with nothing to count it at makes the spend unknown, so a
 *   call that adds any building cost goes to the owner.
 * - Maintenance: the PE's monthly estimates of the approved parts, plus the PE calls that stand, plus this call. While
 *   they make no estimate (no part, or a part with no figure), the maintenance is unknown, so a call that adds any
 *   maintenance cost goes to the owner.
 * - A call that adds nothing passes even when the spend is already past the budget (the owner continued past it).
 */
export function pastBudget(s: State, cost: BudgetEstimate | undefined, prices: readonly ModelPrice[] = PRICES): string | undefined {
  const b = s.project.budgets;
  const why: string[] = [];
  if (b.buildingUsd !== null) {
    const more = cost?.buildUsd?.[1];
    const spend = buildingSpend(s, prices);
    const counted = countedSpend(spend);
    const committed = committedBuildUsd(s);
    const none = spend.unknown.filter((u) => u.countedUsd === null).length;
    const estimated = estimatedUsd(spend);
    if (more === undefined) why.push(`it states no building cost, and the building budget is ${fmtUsd(b.buildingUsd)}`);
    else if (more > 0 && counted === null) why.push(`${runs(none)} ${none === 1 ? "has" : "have"} no recorded cost and no spend limit, so up to ${fmtUsd(more)} more cannot be checked against the ${fmtUsd(b.buildingUsd)} budget`);
    else if (more > 0 && counted! + committed + more > b.buildingUsd)
      why.push(
        `up to ${fmtUsd(more)} more would take the building spend to ${fmtUsd(counted! + committed + more)}, past the ${fmtUsd(b.buildingUsd)} budget (${fmtUsd(spend.usd)} spent${estimated ? `, ${fmtUsd(estimated)} estimated for unrecorded costs` : ""}${committed ? `, up to ${fmtUsd(committed)} committed to PE calls whose work has not run` : ""})`,
      );
  }
  if (b.maintenanceUsdPerMonth !== null) {
    const more = cost?.maintenanceUsdPerMonth?.[1];
    const m = maintenanceEstimate(s);
    if (more === undefined) why.push(`it states no maintenance cost, and the maintenance budget is ${fmtUsd(b.maintenanceUsdPerMonth)} a month`);
    else if (more > 0 && m.partsUsd === null) why.push(`the project's maintenance is not yet estimated, so up to ${fmtUsd(more)} more a month cannot be checked against the ${fmtUsd(b.maintenanceUsdPerMonth)} budget`);
    else if (more > 0 && m.partsUsd! + m.callsUsd + more > b.maintenanceUsdPerMonth)
      why.push(`up to ${fmtUsd(more)} more a month would take the maintenance estimate to ${fmtUsd(m.partsUsd! + m.callsUsd + more)}, past the ${fmtUsd(b.maintenanceUsdPerMonth)} budget`);
  }
  return why.length ? why.join("; ") : undefined;
}
