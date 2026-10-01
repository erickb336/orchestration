// ORC-018: comparing patterns on their recorded outcomes (design §3). Pure: rows are derived from
// `TaskOutcome` and `deliveryOutcome`, never stored. Nothing here ranks patterns or declares a winner.
//
// Interface first: the lead fixed these types and the measure table so the UI (B2) and the domain (B1)
// could be built at the same time. B1 replaces the stubs below with the implementation.

import { currentSpec } from "./model";
import { deliveryOutcome } from "./outcomes";
import { findPattern } from "./patterns";
import { isProvider, type ChosenBy, type State, type Task, type TaskOutcome } from "./types";

export type MeasureId =
  | "timeToDone"
  | "agentTime"
  | "runs"
  | "inputTokens"
  | "outputTokens"
  | "cost"
  | "repairRounds"
  | "findingsRaised"
  | "errorsRaised"
  | "openAtEnd"
  | "firstPassChecks"
  | "failedCheckRuns"
  | "reviewComplete"
  | "humanTouches"
  | "landed"
  | "sentBack"
  | "timeToLanded";

export type MeasureUnit = "duration" | "count" | "tokens" | "usd" | "rate";

export interface MeasureDef {
  id: MeasureId;
  label: string;
  unit: MeasureUnit;
  /** One or two sentences: what it counts and when a task does not report it. Shown as the column's help. */
  help: string;
  /** Shown before the user chooses measures (design §3.2). */
  defaultVisible: boolean;
}

/** Design §3.2, in display order. */
export const MEASURES: MeasureDef[] = [
  { id: "timeToDone", label: "Time to done", unit: "duration", help: "From the first run to done or cancelled, including any time waiting for you. Missing when no run started.", defaultVisible: true },
  { id: "agentTime", label: "Agent time", unit: "duration", help: "The sum of the agents' run times; the service's check runs are not included.", defaultVisible: false },
  { id: "runs", label: "Agent runs", unit: "count", help: "Every agent run of the task, including repeats and repairs.", defaultVisible: true },
  { id: "inputTokens", label: "Input tokens", unit: "tokens", help: "Input tokens of every run. Missing when any run did not report usage.", defaultVisible: false },
  { id: "outputTokens", label: "Output tokens", unit: "tokens", help: "Output tokens of every run. Missing when any run did not report usage.", defaultVisible: false },
  { id: "cost", label: "Cost", unit: "usd", help: "The providers' own cost estimate. Missing when any provider reported no cost (Codex reports tokens only).", defaultVisible: true },
  { id: "repairRounds", label: "Repair rounds", unit: "count", help: "Completed runs of repair steps, loop rounds included.", defaultVisible: true },
  { id: "findingsRaised", label: "Findings raised", unit: "count", help: "Structured findings raised by reviews and checks, of every severity.", defaultVisible: false },
  { id: "errorsRaised", label: "Errors raised", unit: "count", help: "Findings of severity error raised by reviews and checks.", defaultVisible: false },
  { id: "openAtEnd", label: "Open at the end", unit: "count", help: "Blocking findings still open in the accepted review and check outputs when the task finished.", defaultVisible: true },
  { id: "firstPassChecks", label: "Checks passed first time", unit: "rate", help: "Every check run passed, so no failing check needed a repair, and the final checks passed. Missing when the final checks did not run.", defaultVisible: true },
  { id: "failedCheckRuns", label: "Failed check runs", unit: "count", help: "Check runs with a failing command. Missing when no check ran.", defaultVisible: false },
  { id: "reviewComplete", label: "Reviews covered every file", unit: "rate", help: "Every code review of the task reported covering every changed file. Missing when no review was required.", defaultVisible: false },
  { id: "humanTouches", label: "Your interventions", unit: "count", help: "Artifacts you edited, decisions you made, and candidates you chose.", defaultVisible: false },
  { id: "landed", label: "Landed", unit: "rate", help: "The work reached the base branch. Missing when there was nothing to deliver.", defaultVisible: true },
  { id: "sentBack", label: "Sent back", unit: "rate", help: "Landed work you sent back as a fix or a revert. Missing when it did not land.", defaultVisible: true },
  { id: "timeToLanded", label: "Time to landed", unit: "duration", help: "From the first run to landing on the base branch. Missing when it did not land.", defaultVisible: false },
];

/** Fewer rows than this: "too few to compare" (design §3.3). */
export const TOO_FEW = 5;

export interface CompareRow {
  taskId: string;
  title: string;
  area: string;
  result: "done" | "cancelled";
  settledAt: string;
  pattern: { id: string; name: string; hash: string; source: string; chosenBy: ChosenBy; experimental: boolean };
  /** The task changed pattern after runs had started (`patternChanges > 0 || runsBeforePattern > 0`). */
  changedPattern: boolean;
  /** Absent = not reported. Rates are 0 or 1. */
  m: Partial<Record<MeasureId, number>>;
  /** The project is the sample: these outcomes are simulated. */
  simulated: boolean;
}

export interface CompareFilter {
  /** Empty: every area. */
  areas: string[];
  results: ("done" | "cancelled")[];
  /** Empty: whoever chose. */
  chosenBy: ChosenBy[];
  from?: string;
  to?: string;
  includeChanged: boolean;
  mergeVersions: boolean;
}

export const DEFAULT_FILTER: CompareFilter = { areas: [], results: ["done"], chosenBy: [], includeChanged: false, mergeVersions: false };

/** One measure over a group. Numbers: median and quantiles (R type 7). Rates: `count` of rows equal to 1. */
export interface MeasureStat {
  /** Rows that reported the measure. */
  n: number;
  /** Rows in the group. */
  of: number;
  median?: number;
  q1?: number;
  q3?: number;
  min?: number;
  max?: number;
  /** Rates only. */
  count?: number;
  /** n < TOO_FEW. */
  tooFew: boolean;
  /** Every reported value, for the dot strip. */
  values: number[];
}

export interface CompareGroup {
  /** `${id}@${hash}`, or `${id}` when versions are merged. */
  key: string;
  patternId: string;
  name: string;
  /** The hashes in the group (one unless merged). */
  hashes: string[];
  /** The hash that equals the pattern's current file, if any is in the group. */
  currentHash?: string;
  source: string;
  experimental: boolean;
  rows: CompareRow[];
  /** rows.length < TOO_FEW. */
  tooFew: boolean;
  stats: Record<MeasureId, MeasureStat>;
}

// ---------- rows (§3.1, §3.2) ----------

/** Tasks the service owns: dedicated reviews, check runs and repairs pushed onto a pull request. */
const serviceOwned = (t: Task) => !!(t.reviewTarget || t.checkTarget || t.deliverInto);

/** Design §3.2: every measure of one outcome. Absent means "not reported"; a missing value is never zero. */
export function measuresOf(t: Task, o: TaskOutcome): Partial<Record<MeasureId, number>> {
  const m: Partial<Record<MeasureId, number>> = {};
  const set = (id: MeasureId, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) m[id] = v;
  };
  set("timeToDone", o.wallMs);
  set("agentTime", o.agentMs);
  set("runs", o.runs.filter((r) => isProvider(r.runner)).reduce((n, r) => n + r.runs, 0));
  // Tokens and cost: a provider row with runs that reported no usage makes the sum unknown, not smaller.
  if (o.usage.every((u) => u.runsWithoutUsage === 0)) {
    set("inputTokens", o.usage.reduce((n, u) => n + u.inputTokens, 0));
    set("outputTokens", o.usage.reduce((n, u) => n + u.outputTokens, 0));
    if (o.usage.every((u) => u.costUsd !== null)) set("cost", o.usage.reduce((n, u) => n + (u.costUsd ?? 0), 0));
  }
  set("repairRounds", o.repair.rounds);
  set("findingsRaised", Object.values(o.findings.raised).reduce((n, v) => n + v, 0));
  set("errorsRaised", o.findings.raised.error ?? 0);
  set("openAtEnd", o.findings.openAtEnd);
  // Every check run passed, so no failing check needed a repair (review L5: a review-driven repair does not count against it).
  if (o.checks.finalPassed !== null) set("firstPassChecks", o.checks.finalPassed && o.checks.failedRuns === 0 ? 1 : 0);
  if (o.checks.runs > 0) set("failedCheckRuns", o.checks.failedRuns);
  // A task counts when every one of its code reviews covered every changed file (review M2: 0 or 1, like the other rates).
  if (o.coverage.reviews > 0) set("reviewComplete", o.coverage.complete === o.coverage.reviews ? 1 : 0);
  set("humanTouches", o.human.artifactEdits + o.decisions.byUser + o.human.candidateChoices);
  const d = deliveryOutcome(t);
  if (d.status !== "not-needed") set("landed", d.status === "landed" ? 1 : 0);
  if (d.status === "landed") {
    set("sentBack", d.sentBack !== undefined ? 1 : 0);
    set("timeToLanded", d.timeToLandedMs);
  }
  return m;
}

/** Design §3.1: one row per settled task with an outcome (service-owned and internal tasks excluded). */
export function compareRows(state: State): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const t of state.tasks) {
    const o = t.outcome;
    if (!o || serviceOwned(t) || o.pattern.source === "internal") continue;
    const p = o.pattern;
    // Legacy and custom pipelines have no hash: one "Custom pipelines" group holds them all.
    const pattern: CompareRow["pattern"] = p.hash
      ? { id: p.id, name: p.name, hash: p.hash, source: p.source, chosenBy: p.chosenBy, experimental: !!p.experimental }
      : { id: "custom", name: "Custom pipelines", hash: "", source: p.source, chosenBy: p.chosenBy, experimental: !!p.experimental };
    const spec = currentSpec(t)?.content;
    rows.push({
      taskId: t.id,
      title: spec?.title ?? t.id,
      area: spec?.area ?? "",
      result: o.result,
      settledAt: o.settledAt,
      pattern,
      changedPattern: o.patternChanges > 0 || o.runsBeforePattern > 0,
      m: measuresOf(t, o),
      simulated: !!state.project.sample,
    });
  }
  return rows;
}

// ---------- statistics (§3.3) ----------

/** Quantile `p` of ascending `sorted` by linear interpolation between order statistics (R type 7). Needs two or more values. */
export function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

const unitOf = new Map(MEASURES.map((d) => [d.id, d.unit]));

/** One measure over the rows of a group: `n` reporting of `of`, the quantiles (n ≥ 2) or, for a rate, the count of ones. */
export function measureStat(id: MeasureId, rows: CompareRow[]): MeasureStat {
  const values = rows.map((r) => r.m[id]).filter((v): v is number => v !== undefined);
  const n = values.length;
  const stat: MeasureStat = { n, of: rows.length, tooFew: n < TOO_FEW, values };
  if (unitOf.get(id) === "rate") {
    stat.count = values.filter((v) => v === 1).length;
    return stat;
  }
  if (n === 0) return stat;
  const sorted = [...values].sort((a, b) => a - b);
  stat.min = sorted[0];
  stat.max = sorted[n - 1];
  if (n >= 2) {
    stat.median = quantile(sorted, 0.5);
    stat.q1 = quantile(sorted, 0.25);
    stat.q3 = quantile(sorted, 0.75);
  }
  return stat;
}

// ---------- filters and groups (§3.3, §3.4) ----------

/** A bound is compared at its own precision, so a date-only bound covers its whole day. */
const within = (settledAt: string, bound: string | undefined, side: "from" | "to") => {
  if (!bound) return true;
  const head = settledAt.slice(0, bound.length);
  return side === "from" ? head >= bound : head <= bound;
};

/** Design §3.4: the rows a filter keeps. */
export function filterRows(rows: CompareRow[], f: CompareFilter): CompareRow[] {
  return rows.filter(
    (r) =>
      (f.areas.length === 0 || f.areas.includes(r.area)) &&
      f.results.includes(r.result) &&
      (f.chosenBy.length === 0 || f.chosenBy.includes(r.pattern.chosenBy)) &&
      within(r.settledAt, f.from, "from") &&
      within(r.settledAt, f.to, "to") &&
      (f.includeChanged || !r.changedPattern),
  );
}

/** Design §3.3–3.4: filter, then group by pattern id and hash (or id only when merged). */
export function groupRows(state: State, rows: CompareRow[], filter: CompareFilter): CompareGroup[] {
  const kept = filterRows(rows, filter);
  const byKey = new Map<string, CompareRow[]>();
  for (const r of kept) {
    const key = filter.mergeVersions ? r.pattern.id : `${r.pattern.id}@${r.pattern.hash}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const groups: CompareGroup[] = [];
  for (const [key, list] of byKey) {
    // Newest first; the group's name, source and experiment flag follow its newest row.
    const sorted = [...list].sort((a, b) => (a.settledAt < b.settledAt ? 1 : a.settledAt > b.settledAt ? -1 : a.taskId < b.taskId ? -1 : 1));
    const newest = sorted[0];
    const hashes = [...new Set(sorted.map((r) => r.pattern.hash))];
    const live = findPattern(state, newest.pattern.id)?.hash;
    const stats = {} as Record<MeasureId, MeasureStat>;
    for (const d of MEASURES) stats[d.id] = measureStat(d.id, sorted);
    groups.push({
      key,
      patternId: newest.pattern.id,
      name: newest.pattern.name,
      hashes,
      ...(live && hashes.includes(live) ? { currentHash: live } : {}),
      source: newest.pattern.source,
      experimental: newest.pattern.experimental,
      rows: sorted,
      tooFew: sorted.length < TOO_FEW,
      stats,
    });
  }
  return groups.sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

// ---------- exports (§3.5) ----------

const CSV_HEAD = ["task_id", "title", "area", "result", "settled_at", "pattern_id", "pattern_name", "pattern_hash", "pattern_source", "chosen_by", "experimental", "changed_pattern", "simulated"];

/**
 * RFC 4180: a field with a comma, a quote or a line break is quoted, with quotes doubled; a missing value is
 * empty. Text that a spreadsheet would run as a formula (it starts with =, +, -, @, a tab or a carriage
 * return) gets a leading apostrophe (review L6): titles are written by agents. Numbers are never changed.
 */
export function csvField(v: string | number | boolean | undefined): string {
  if (v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Design §3.5: RFC 4180 CSV with every measure. */
export function toCSV(rows: CompareRow[]): string {
  const head = [...CSV_HEAD, ...MEASURES.map((d) => d.id)];
  const lines = [head.map(csvField).join(",")];
  for (const r of rows) {
    const cells = [r.taskId, r.title, r.area, r.result, r.settledAt, r.pattern.id, r.pattern.name, r.pattern.hash, r.pattern.source, r.pattern.chosenBy, r.pattern.experimental, r.changedPattern, r.simulated, ...MEASURES.map((d) => r.m[d.id])];
    lines.push(cells.map(csvField).join(","));
  }
  return lines.map((l) => `${l}\r\n`).join("");
}

/** Design §3.5. */
export function toJSON(rows: CompareRow[], filter: CompareFilter, simulated: boolean, generatedAt: string): string {
  return JSON.stringify({ generatedAt, filter, simulated, rows }, null, 2);
}
