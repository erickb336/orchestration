// A hand-made Compare fixture for the UI's own tests: rows and groups that match `src/domain/compare.ts`'s
// types, built here so the page can be tested before (and apart from) the domain's `compareRows` and
// `groupRows`. The statistics are computed by the small helper below, for the fixture only; the domain's
// implementation is the one that counts.

import { MEASURES, TOO_FEW, type CompareGroup, type CompareRow, type MeasureId, type MeasureStat } from "../domain/compare";

const T0 = Date.parse("2026-09-28T12:00:00Z");
const daysAgo = (d: number) => new Date(T0 - d * 86_400_000).toISOString();

/** A small deterministic sequence, so the fixture has spread without randomness. */
function seq(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

/** R type 7 quantile, as the domain specifies (design §3.3). */
function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

function statOf(values: number[], of: number, rate: boolean): MeasureStat {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const base: MeasureStat = { n, of, tooFew: n < TOO_FEW, values: sorted };
  if (rate) return { ...base, count: sorted.filter((v) => v === 1).length };
  if (n === 0) return base;
  if (n === 1) return { ...base, median: sorted[0], min: sorted[0], max: sorted[0] };
  return { ...base, median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75), min: sorted[0], max: sorted[n - 1] };
}

/** Builds a group from its rows, as the domain would. */
export function groupOf(o: { key: string; patternId: string; name: string; hashes: string[]; currentHash?: string; source?: string; experimental?: boolean; rows: CompareRow[] }): CompareGroup {
  const stats = Object.fromEntries(
    MEASURES.map((m) => [
      m.id,
      statOf(
        o.rows.map((r) => r.m[m.id]).filter((v): v is number => v !== undefined),
        o.rows.length,
        m.unit === "rate",
      ),
    ]),
  ) as Record<MeasureId, MeasureStat>;
  return { key: o.key, patternId: o.patternId, name: o.name, hashes: o.hashes, currentHash: o.currentHash, source: o.source ?? "built-in", experimental: o.experimental ?? false, rows: o.rows, tooFew: o.rows.length < TOO_FEW, stats };
}

export interface RowShape {
  /** Typical time to done, in minutes; agent time is about 60% of it. */
  minutes: number;
  runs: number;
  repair: number;
  open: number;
  /** Share of rows that pass the final checks first time, and that land. */
  firstPass: number;
  landed: number;
  /** Share of rows that report a cost (Codex-only tasks report tokens only). */
  costReported: number;
}

export function rowsOf(prefix: string, start: number, count: number, pattern: CompareRow["pattern"], area: string, shape: RowShape, seed: number): CompareRow[] {
  const next = seq(seed);
  const rows: CompareRow[] = [];
  for (let i = 0; i < count; i++) {
    const r = next();
    const wall = Math.round(shape.minutes * 60_000 * (0.6 + r * 0.9));
    const agent = Math.round(wall * (0.5 + next() * 0.3));
    const runs = shape.runs + Math.round(next() * 2);
    const repair = Math.max(0, Math.round(shape.repair + (next() - 0.5) * 2));
    const open = Math.max(0, Math.round(shape.open + (next() - 0.6) * 2));
    const inTok = Math.round(40_000 + next() * 90_000);
    const outTok = Math.round(inTok * (0.15 + next() * 0.1));
    const firstPass = next() < shape.firstPass ? 1 : 0;
    const landed = next() < shape.landed ? 1 : 0;
    const costReported = next() < shape.costReported;
    const m: CompareRow["m"] = {
      timeToDone: wall,
      agentTime: agent,
      runs,
      inputTokens: inTok,
      outputTokens: outTok,
      repairRounds: repair,
      findingsRaised: open + 1 + Math.round(next() * 3),
      errorsRaised: Math.round(next() * 2),
      openAtEnd: open,
      firstPassChecks: firstPass,
      failedCheckRuns: firstPass ? 0 : 1,
      reviewComplete: next() < 0.85 ? 1 : 0,
      humanTouches: Math.round(next() * 2),
      landed,
      ...(landed ? { sentBack: next() < 0.15 ? 1 : 0, timeToLanded: wall + Math.round(next() * 3_600_000) } : {}),
      ...(costReported ? { cost: Math.round((inTok * 3 + outTok * 15) / 1_000_000 * 100) / 100 } : {}),
    };
    rows.push({
      taskId: `${prefix}-${String(start + i).padStart(3, "0")}`,
      title: `${pattern.name === "Bug fix" ? "Fix" : "Add"} sample change ${start + i} to the ${area.toLowerCase()} screen`,
      area,
      result: "done",
      settledAt: daysAgo(30 - i),
      pattern,
      changedPattern: false,
      m,
      simulated: true,
    });
  }
  return rows;
}

const CHANGE_HASH = "3f1c9a7e5b2d4c6a8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";
const CROSS_HASH = "a8c2e4f6b1d3579024680ace13579bdf2468ace02468bdf13579ace02468bdf1";
const BUGFIX_HASH = "9e7d5c3b1a0f2e4d6c8b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d";
const BUGFIX_OLD = "0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d";

const change: CompareRow["pattern"] = { id: "change", name: "Change", hash: CHANGE_HASH, source: "built-in", chosenBy: "lead", experimental: false };
const cross: CompareRow["pattern"] = { id: "change-cross-review", name: "Change, reviewed by the other provider", hash: CROSS_HASH, source: "built-in", chosenBy: "user", experimental: true };
const bugfix: CompareRow["pattern"] = { id: "bugfix", name: "Bug fix", hash: BUGFIX_HASH, source: "built-in", chosenBy: "lead", experimental: false };
const bugfixOld: CompareRow["pattern"] = { ...bugfix, hash: BUGFIX_OLD };

/** Three patterns, one of them in two versions; cost reported on part of the rows (design §7). */
export function fixtureRows(): CompareRow[] {
  return [
    ...rowsOf("WT", 101, 9, change, "Offline maps", { minutes: 38, runs: 4, repair: 1, open: 1, firstPass: 0.6, landed: 0.9, costReported: 0.7 }, 11),
    ...rowsOf("WT", 111, 8, cross, "Trip sharing", { minutes: 46, runs: 5, repair: 1, open: 0.4, firstPass: 0.7, landed: 0.9, costReported: 0.5 }, 23),
    ...rowsOf("WT", 119, 5, bugfix, "Reliability", { minutes: 17, runs: 3, repair: 0.4, open: 0.3, firstPass: 0.8, landed: 1, costReported: 0.8 }, 37),
    // The older version ran on Codex only: no row reports a cost, so its cost cell is "—".
    ...rowsOf("WT", 124, 2, bugfixOld, "Reliability", { minutes: 21, runs: 3, repair: 0.6, open: 0.5, firstPass: 0.5, landed: 1, costReported: 0 }, 41),
  ];
}

/** The groups `groupRows` would make of `fixtureRows()` with the default filter: sorted by size, then by name. */
export function fixtureGroups(rows: CompareRow[] = fixtureRows()): CompareGroup[] {
  const by = (hash: string) => rows.filter((r) => r.pattern.hash === hash);
  return [
    groupOf({ key: `change@${CHANGE_HASH}`, patternId: "change", name: "Change", hashes: [CHANGE_HASH], currentHash: CHANGE_HASH, rows: by(CHANGE_HASH) }),
    groupOf({ key: `change-cross-review@${CROSS_HASH}`, patternId: "change-cross-review", name: "Change, reviewed by the other provider", hashes: [CROSS_HASH], currentHash: CROSS_HASH, experimental: true, rows: by(CROSS_HASH) }),
    groupOf({ key: `bugfix@${BUGFIX_HASH}`, patternId: "bugfix", name: "Bug fix", hashes: [BUGFIX_HASH], currentHash: BUGFIX_HASH, rows: by(BUGFIX_HASH) }),
    groupOf({ key: `bugfix@${BUGFIX_OLD}`, patternId: "bugfix", name: "Bug fix", hashes: [BUGFIX_OLD], rows: by(BUGFIX_OLD) }),
  ];
}

/** The same rows with the two Bug fix versions merged (filter.mergeVersions). */
export function fixtureMergedGroups(rows: CompareRow[] = fixtureRows()): CompareGroup[] {
  const groups = fixtureGroups(rows);
  const merged = groupOf({ key: "bugfix", patternId: "bugfix", name: "Bug fix", hashes: [BUGFIX_HASH, BUGFIX_OLD], currentHash: BUGFIX_HASH, rows: rows.filter((r) => r.pattern.id === "bugfix") });
  return [groups[0], groups[1], merged];
}
