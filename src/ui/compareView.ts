// ORC-018 §4: the pure helpers behind the Compare page. Formatting, the shared scale of a column's dot
// strips, the stored choice of measures, the version chip and the side-by-side lines. The components only
// render what these return; nothing here ranks a pattern or calls a difference meaningful.

import { MEASURES, TOO_FEW, type CompareGroup, type CompareRow, type MeasureDef, type MeasureId, type MeasureStat, type MeasureUnit } from "../domain/compare";
import type { ChosenBy, PatternRef } from "../domain/types";
import { sourceLabel } from "./patternView";

/** The source chip, worded as the rest of the UI words pattern sources ("built-in", "yours"). */
export const sourceText = (source: string): string => sourceLabel(source as PatternRef["source"]);

/** The browser keeps the chosen measures here (design §4), as a JSON array of ids. */
export const MEASURES_KEY = "orc.compare.measures";

/** The dot strip: 96 × 14, dots inset so a dot at the extreme still fits. */
export const STRIP = { width: 96, height: 14, pad: 4, dotRadius: 2.5 };

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "42s", "4m 12s", "1h 05m", "2d 03h". Negative or non-finite values read as zero. */
export function fmtDuration(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad2(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad2(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${pad2(h % 24)}h`;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "$0.42", "$1,234.50". */
export function fmtUsd(n: number): string {
  return USD.format(Number.isFinite(n) ? n : 0);
}

/** Tokens, with thousands separators; a median between two counts is rounded. */
export function fmtTokens(n: number): string {
  return INT.format(Number.isFinite(n) ? Math.round(n) : 0);
}

/** A count: whole numbers as they are, a median between two counts with one decimal ("1.5"). */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? INT.format(n) : n.toFixed(1);
}

/** "7 of 9 (78%)"; "—" when nothing reported. */
export function fmtRate(count: number, n: number): string {
  if (n <= 0) return "—";
  return `${count} of ${n} (${Math.round((count / n) * 100)}%)`;
}

/** One number in a measure's unit. Rates are 0 or 1 on a row: "yes" or "no". */
export function fmtValue(unit: MeasureUnit, v: number): string {
  switch (unit) {
    case "duration":
      return fmtDuration(v);
    case "usd":
      return fmtUsd(v);
    case "tokens":
      return fmtTokens(v);
    case "rate":
      return v >= 1 ? "yes" : "no";
    default:
      return fmtCount(v);
  }
}

export const measureDef = (id: MeasureId): MeasureDef => MEASURES.find((m) => m.id === id)!;

export interface CellText {
  /** The median, or "7 of 9" for a rate, or "—" when no task reported it. */
  main: string;
  /** The q1–q3 spread, or the percentage for a rate; absent with one value or none. */
  spread?: string;
  /** "3 of 9 reported", when not every row in the group reported the measure. */
  reported?: string;
  /** For the cell's title: the numbers in words. */
  title: string;
  missing: boolean;
}

export const MISSING_TITLE = "No task in this group reported it";

/** What one cell of the groups table shows (design §4). */
export function cellText(def: MeasureDef, stat: MeasureStat): CellText {
  if (stat.n === 0) return { main: "—", title: MISSING_TITLE, missing: true };
  const reported = stat.n < stat.of ? `${stat.n} of ${stat.of} reported` : undefined;
  if (def.unit === "rate") {
    const count = stat.count ?? 0;
    const pct = `${Math.round((count / stat.n) * 100)}%`;
    return { main: `${count} of ${stat.n}`, spread: pct, reported, title: `${def.label}: ${fmtRate(count, stat.n)}${reported ? `; ${reported}` : ""}`, missing: false };
  }
  const f = (v: number) => fmtValue(def.unit, v);
  const median = stat.median ?? stat.values[0] ?? 0;
  const spread = stat.q1 !== undefined && stat.q3 !== undefined ? `${f(stat.q1)}–${f(stat.q3)}` : undefined;
  const range = stat.min !== undefined && stat.max !== undefined && stat.n > 1 ? `; from ${f(stat.min)} to ${f(stat.max)}` : "";
  const title = `${def.label}: median ${f(median)}${spread ? `; middle half ${spread}` : ""}${range}; ${stat.n} task${stat.n === 1 ? "" : "s"}${reported ? ` (${reported})` : ""}`;
  return { main: f(median), spread, reported, title, missing: false };
}

export interface Scale {
  min: number;
  max: number;
}

/** One scale per column, across every group, so dots in different rows are comparable (design §4). */
export function columnScale(groups: CompareGroup[], id: MeasureId): Scale | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const g of groups) {
    for (const v of g.stats[id]?.values ?? []) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min <= max ? { min, max } : undefined;
}

/** The x of each value on the strip; one value, or all equal, sits in the middle. */
export function dotX(values: number[], scale: Scale, width = STRIP.width, pad = STRIP.pad): number[] {
  const span = scale.max - scale.min;
  const inner = width - 2 * pad;
  return values.map((v) => (span > 0 ? pad + ((v - scale.min) / span) * inner : width / 2));
}

/** Design §3.2: the default measures, with cost replaced by input tokens when no row reports a cost. */
export function defaultMeasureIds(rows: CompareRow[]): MeasureId[] {
  const anyCost = rows.some((r) => r.m.cost !== undefined);
  return MEASURES.filter((m) => m.defaultVisible).map((m) => (m.id === "cost" && !anyCost ? "inputTokens" : m.id));
}

const isMeasureId = (x: unknown): x is MeasureId => typeof x === "string" && MEASURES.some((m) => m.id === x);

/** The stored choice, or null when there is none or it cannot be read. Unknown ids are dropped; the display order is MEASURES'. */
export function readStoredMeasures(raw: string | null): MeasureId[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const ids = new Set(parsed.filter(isMeasureId));
    return MEASURES.filter((m) => ids.has(m.id)).map((m) => m.id);
  } catch {
    return null;
  }
}

export function encodeMeasures(ids: MeasureId[]): string {
  return JSON.stringify(MEASURES.filter((m) => ids.includes(m.id)).map((m) => m.id));
}

export const CHOSEN_BY_LABEL: Record<ChosenBy, string> = {
  user: "You",
  lead: "The lead",
  breakdown: "A breakdown",
  default: "The project default",
  service: "The service",
  "follow-up": "A follow-up",
  migration: "Before patterns",
};
const CHOSEN_BY_ORDER: ChosenBy[] = ["lead", "user", "breakdown", "default", "follow-up", "migration", "service"];

/** Who chose a pattern, among the rows, in a fixed order. */
export function chosenByOptions(rows: CompareRow[]): ChosenBy[] {
  const present = new Set(rows.map((r) => r.pattern.chosenBy));
  return CHOSEN_BY_ORDER.filter((c) => present.has(c));
}

/** The areas among the rows, sorted. */
export function areaOptions(rows: CompareRow[]): string[] {
  return [...new Set(rows.map((r) => r.area))].sort((a, b) => a.localeCompare(b));
}

/** Date inputs give "YYYY-MM-DD"; the filter wants ISO bounds on settledAt: local midnight at the start, the end of the day at the end. */
export function dateBounds(from: string, to: string): { from?: string; to?: string } {
  const parse = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]) } : null;
  };
  const f = parse(from);
  const t = parse(to);
  const out: { from?: string; to?: string } = {};
  if (f) out.from = new Date(f.y, f.mo, f.d, 0, 0, 0, 0).toISOString();
  if (t) out.to = new Date(t.y, t.mo, t.d, 23, 59, 59, 999).toISOString();
  return out;
}

export interface VersionChip {
  text: string;
  title: string;
}

/** The version chip: a short hash with "current" or "older", or "mixes N versions" for a merged group. */
export function versionChip(g: Pick<CompareGroup, "hashes" | "currentHash">): VersionChip {
  if (g.hashes.length > 1) {
    const current = g.currentHash ? ` One of them (${g.currentHash.slice(0, 8)}) is the pattern's current content.` : "";
    return { text: `mixes ${g.hashes.length} versions`, title: `Versions merged by choice: ${g.hashes.map((h) => h.slice(0, 8) || "no hash").join(", ")}.${current}` };
  }
  const hash = g.hashes[0] ?? "";
  if (!hash) return { text: "no version", title: "A pipeline without a content hash: made before patterns, or built by hand." };
  const short = hash.slice(0, 8);
  return g.currentHash === hash
    ? { text: `${short} · current`, title: `Content hash ${hash}: the same as the pattern file now in the catalog.` }
    : { text: `${short} · older`, title: `Content hash ${hash}: the pattern file has changed since, or is no longer in the catalog.` };
}

export const TOO_FEW_TEXT = "too few to compare";
export const TOO_FEW_LINE = "Too few tasks to compare this";

export interface SideLine {
  def: MeasureDef;
  a: MeasureStat;
  b: MeasureStat;
  /** Either side rests on fewer than TOO_FEW rows (design §4). */
  tooFew: boolean;
  /** The scale both strips share. */
  scale?: Scale;
}

/** One line per visible measure for the side-by-side panel. */
export function sideBySideLines(a: CompareGroup, b: CompareGroup, measures: MeasureId[]): SideLine[] {
  return measures.map((id) => {
    const def = measureDef(id);
    const sa = a.stats[id];
    const sb = b.stats[id];
    return { def, a: sa, b: sb, tooFew: sa.n < TOO_FEW || sb.n < TOO_FEW, scale: columnScale([a, b], id) };
  });
}

/** "orchestrator-compare-2026-10-01.csv" */
export function exportFilename(kind: "csv" | "json", at: Date): string {
  return `orchestrator-compare-${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}.${kind}`;
}

/** The n shown beside a group: rows in it, and how many of those are cancelled when any are. */
export function groupCount(g: CompareGroup): string {
  const cancelled = g.rows.filter((r) => r.result === "cancelled").length;
  return `${g.rows.length} task${g.rows.length === 1 ? "" : "s"}${cancelled ? ` (${cancelled} cancelled)` : ""}`;
}

/** The settled date of a row, short. */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
