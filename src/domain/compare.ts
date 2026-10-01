// ORC-018: comparing patterns on their recorded outcomes (design §3). Pure: rows are derived from
// `TaskOutcome` and `deliveryOutcome`, never stored. Nothing here ranks patterns or declares a winner.
//
// Interface first: the lead fixed these types and the measure table so the UI (B2) and the domain (B1)
// could be built at the same time. B1 replaces the stubs below with the implementation.

import type { ChosenBy, State } from "./types";

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
  { id: "firstPassChecks", label: "Checks passed first time", unit: "rate", help: "The final checks passed with no repair round. Missing when the final checks did not run.", defaultVisible: true },
  { id: "failedCheckRuns", label: "Failed check runs", unit: "count", help: "Check runs with a failing command. Missing when no check ran.", defaultVisible: false },
  { id: "reviewComplete", label: "Reviews covering every file", unit: "rate", help: "The share of code reviews that reported covering every changed file. Missing when no review was required.", defaultVisible: false },
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

/** Design §3.1: one row per settled task with an outcome (service-owned and internal tasks excluded). */
export function compareRows(_state: State): CompareRow[] {
  throw new Error("ORC-018 B1: compareRows is not implemented yet");
}

/** Design §3.3–3.4: filter, then group by pattern id and hash (or id only when merged). */
export function groupRows(_state: State, _rows: CompareRow[], _filter: CompareFilter): CompareGroup[] {
  throw new Error("ORC-018 B1: groupRows is not implemented yet");
}

/** Design §3.5: RFC 4180 CSV with every measure. */
export function toCSV(_rows: CompareRow[]): string {
  throw new Error("ORC-018 B1: toCSV is not implemented yet");
}

/** Design §3.5. */
export function toJSON(_rows: CompareRow[], _filter: CompareFilter, _simulated: boolean, _generatedAt: string): string {
  throw new Error("ORC-018 B1: toJSON is not implemented yet");
}
