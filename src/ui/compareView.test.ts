// ORC-018 §4: the Compare page's own helpers, against hand-made rows and groups that match the domain's types.

import { describe, expect, it } from "vitest";
import { MEASURES, TOO_FEW, type CompareGroup, type MeasureStat } from "../domain/compare";
import { fixtureGroups, fixtureMergedGroups, fixtureRows, groupOf } from "./compareFixture";
import {
  CHOSEN_BY_LABEL,
  MISSING_TITLE,
  STRIP,
  areaOptions,
  cellText,
  chosenByOptions,
  columnScale,
  dateBounds,
  defaultMeasureIds,
  dotX,
  encodeMeasures,
  exportFilename,
  fmtCount,
  fmtDuration,
  fmtRate,
  fmtTokens,
  fmtUsd,
  fmtValue,
  groupCount,
  measureDef,
  readStoredMeasures,
  sideBySideLines,
  sourceText,
  versionChip,
} from "./compareView";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("formatting", () => {
  it("durations read as seconds, minutes and seconds, hours and minutes, or days and hours", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(42_000)).toBe("42s");
    expect(fmtDuration(4 * MIN + 12_000)).toBe("4m 12s");
    expect(fmtDuration(4 * MIN + 5_000)).toBe("4m 05s");
    expect(fmtDuration(HOUR + 5 * MIN)).toBe("1h 05m");
    expect(fmtDuration(23 * HOUR + 59 * MIN)).toBe("23h 59m");
    expect(fmtDuration(2 * 24 * HOUR + 3 * HOUR)).toBe("2d 03h");
    expect(fmtDuration(-5)).toBe("0s");
    expect(fmtDuration(Number.NaN)).toBe("0s");
  });

  it("cost reads as dollars with two decimals and thousands separators", () => {
    expect(fmtUsd(0.42)).toBe("$0.42");
    expect(fmtUsd(0.005)).toBe("$0.01");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(0)).toBe("$0.00");
  });

  it("rates read as 'count of n (percent)'", () => {
    expect(fmtRate(7, 9)).toBe("7 of 9 (78%)");
    expect(fmtRate(0, 4)).toBe("0 of 4 (0%)");
    expect(fmtRate(0, 0)).toBe("—");
  });

  it("tokens carry thousands separators and counts keep one decimal only between two whole numbers", () => {
    expect(fmtTokens(12345)).toBe("12,345");
    expect(fmtTokens(1234567.4)).toBe("1,234,567");
    expect(fmtCount(2)).toBe("2");
    expect(fmtCount(1.5)).toBe("1.5");
    expect(fmtCount(1234)).toBe("1,234");
  });

  it("a row's value follows its measure's unit; a rate is yes or no", () => {
    expect(fmtValue("duration", 90_000)).toBe("1m 30s");
    expect(fmtValue("usd", 2)).toBe("$2.00");
    expect(fmtValue("tokens", 1000)).toBe("1,000");
    expect(fmtValue("count", 3)).toBe("3");
    expect(fmtValue("rate", 1)).toBe("yes");
    expect(fmtValue("rate", 0)).toBe("no");
  });

  it("names the export by date", () => {
    expect(exportFilename("csv", new Date(2026, 9, 1, 15))).toBe("orchestrator-compare-2026-10-01.csv");
    expect(exportFilename("json", new Date(2026, 0, 9))).toBe("orchestrator-compare-2026-01-09.json");
  });
});

const stat = (values: number[], of: number, extra: Partial<MeasureStat> = {}): MeasureStat => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, of, tooFew: sorted.length < TOO_FEW, values: sorted, ...extra };
};

describe("cellText", () => {
  it("shows a dash with the title when no row reported the measure", () => {
    const c = cellText(measureDef("cost"), stat([], 6));
    expect(c).toMatchObject({ main: "—", missing: true, title: MISSING_TITLE });
    expect(c.spread).toBeUndefined();
  });

  it("shows the median, the q1–q3 spread and 'n of m reported'", () => {
    const c = cellText(measureDef("timeToDone"), stat([4 * MIN, 10 * MIN, 30 * MIN], 5, { median: 10 * MIN, q1: 7 * MIN, q3: 20 * MIN, min: 4 * MIN, max: 30 * MIN }));
    expect(c.main).toBe("10m 00s");
    expect(c.spread).toBe("7m 00s–20m 00s");
    expect(c.reported).toBe("3 of 5 reported");
    expect(c.title).toContain("median 10m 00s");
    expect(c.title).toContain("middle half 7m 00s–20m 00s");
    expect(c.title).toContain("from 4m 00s to 30m 00s");
    expect(c.title).toContain("(3 of 5 reported)");
    expect(c.missing).toBe(false);
  });

  it("has no spread for a single value and no 'reported' note when every row reported", () => {
    const c = cellText(measureDef("runs"), stat([3], 1, { median: 3, min: 3, max: 3 }));
    expect(c.main).toBe("3");
    expect(c.spread).toBeUndefined();
    expect(c.reported).toBeUndefined();
    expect(c.title).toBe("Agent runs: median 3; 1 task");
  });

  it("shows a rate as 'count of n' with the percentage as its spread", () => {
    const c = cellText(measureDef("landed"), stat([1, 1, 1, 1, 1, 1, 1, 0, 0], 9, { count: 7 }));
    expect(c.main).toBe("7 of 9");
    expect(c.spread).toBe("78%");
    expect(c.title).toBe("Landed: 7 of 9 (78%)");
    const partial = cellText(measureDef("sentBack"), stat([0, 0, 1], 9, { count: 1 }));
    expect(partial.main).toBe("1 of 3");
    expect(partial.reported).toBe("3 of 9 reported");
    expect(partial.title).toContain("; 3 of 9 reported");
  });
});

describe("the shared scale and the dots", () => {
  const groups = fixtureGroups();

  it("spans every group's values for one column", () => {
    const sc = columnScale(groups, "timeToDone")!;
    const all = groups.flatMap((g) => g.stats.timeToDone.values);
    expect(sc.min).toBe(Math.min(...all));
    expect(sc.max).toBe(Math.max(...all));
    for (const g of groups) {
      for (const x of dotX(g.stats.timeToDone.values, sc)) {
        expect(x).toBeGreaterThanOrEqual(STRIP.pad);
        expect(x).toBeLessThanOrEqual(STRIP.width - STRIP.pad);
      }
    }
  });

  it("has no scale when no group reported the measure, and centres equal values", () => {
    const empty = groupOf({ key: "k", patternId: "p", name: "P", hashes: ["h"], rows: [] });
    expect(columnScale([empty], "cost")).toBeUndefined();
    expect(dotX([5, 5, 5], { min: 5, max: 5 })).toEqual([48, 48, 48]);
    expect(dotX([0, 50, 100], { min: 0, max: 100 })).toEqual([4, 48, 92]);
  });
});

describe("the chosen measures", () => {
  it("defaults to the design's list, with cost replaced by input tokens when no row reports a cost", () => {
    const rows = fixtureRows();
    expect(defaultMeasureIds(rows)).toEqual(["timeToDone", "runs", "cost", "repairRounds", "openAtEnd", "firstPassChecks", "landed", "sentBack"]);
    const noCost = rows.map((r) => ({ ...r, m: Object.fromEntries(Object.entries(r.m).filter(([k]) => k !== "cost")) }));
    expect(defaultMeasureIds(noCost)).toEqual(["timeToDone", "runs", "inputTokens", "repairRounds", "openAtEnd", "firstPassChecks", "landed", "sentBack"]);
  });

  it("reads the stored choice, drops unknown ids, keeps the display order, and ignores what it cannot parse", () => {
    expect(readStoredMeasures(null)).toBeNull();
    expect(readStoredMeasures("not json")).toBeNull();
    expect(readStoredMeasures('{"a":1}')).toBeNull();
    expect(readStoredMeasures('["cost","bogus","timeToDone",3]')).toEqual(["timeToDone", "cost"]);
    expect(readStoredMeasures("[]")).toEqual([]);
  });

  it("writes the choice in display order", () => {
    expect(encodeMeasures(["landed", "runs"])).toBe('["runs","landed"]');
    expect(readStoredMeasures(encodeMeasures(MEASURES.map((m) => m.id)))).toEqual(MEASURES.map((m) => m.id));
  });
});

describe("filters", () => {
  it("lists who chose, in a fixed order, and the areas sorted", () => {
    const rows = fixtureRows();
    expect(chosenByOptions(rows)).toEqual(["lead", "user"]);
    expect(CHOSEN_BY_LABEL.lead).toBe("The lead");
    expect(areaOptions(rows)).toEqual(["Offline maps", "Reliability", "Trip sharing"]);
  });

  it("turns date inputs into local-day bounds on settledAt, and leaves an empty side open", () => {
    const b = dateBounds("2026-09-01", "2026-09-30");
    expect(Date.parse(b.from!)).toBe(new Date(2026, 8, 1).getTime());
    expect(Date.parse(b.to!)).toBe(new Date(2026, 8, 30, 23, 59, 59, 999).getTime());
    expect(dateBounds("", "2026-09-30").from).toBeUndefined();
    expect(dateBounds("garbage", "")).toEqual({});
  });
});

describe("groups", () => {
  it("chips the version as current or older, or as mixing versions when merged", () => {
    const [change, , bugfix, older] = fixtureGroups();
    expect(versionChip(change).text).toBe("3f1c9a7e · current");
    expect(versionChip(bugfix).text).toBe("9e7d5c3b · current");
    expect(versionChip(older)).toMatchObject({ text: "0c1d2e3f · older" });
    expect(versionChip(older).title).toContain("has changed since");
    const merged = fixtureMergedGroups()[2];
    expect(versionChip(merged).text).toBe("mixes 2 versions");
    expect(versionChip(merged).title).toContain("9e7d5c3b");
    expect(versionChip({ hashes: [""] }).text).toBe("no version");
  });

  it("counts the group's tasks, naming the cancelled ones", () => {
    const g = fixtureGroups()[0];
    expect(groupCount(g)).toBe("9 tasks");
    const one = groupOf({ key: "k", patternId: "p", name: "P", hashes: ["h"], rows: [g.rows[0]] });
    expect(groupCount(one)).toBe("1 task");
    const withCancelled = groupOf({ key: "k", patternId: "p", name: "P", hashes: ["h"], rows: [g.rows[0], { ...g.rows[1], result: "cancelled" }] });
    expect(groupCount(withCancelled)).toBe("2 tasks (1 cancelled)");
  });

  it("words sources as the rest of the UI does", () => {
    expect(sourceText("built-in")).toBe("built-in");
    expect(sourceText("local")).toBe("yours");
  });
});

describe("side by side", () => {
  it("has one line per visible measure, a shared scale, and marks a line when either side has too few", () => {
    const [change, cross, , older] = fixtureGroups();
    const lines = sideBySideLines(change, cross, ["timeToDone", "cost", "landed"]);
    expect(lines.map((l) => l.def.id)).toEqual(["timeToDone", "cost", "landed"]);
    expect(lines[0].tooFew).toBe(false);
    expect(lines[0].scale).toEqual(columnScale([change, cross], "timeToDone"));
    const few = sideBySideLines(change, older, ["timeToDone"]);
    expect(few[0].tooFew).toBe(true);
    expect(few[0].b.n).toBeLessThan(TOO_FEW);
  });

  it("flags too few per measure, not only per group: a cost most rows did not report", () => {
    const g: CompareGroup = groupOf({ key: "k", patternId: "p", name: "P", hashes: ["h"], rows: fixtureGroups()[0].rows.map((r, i) => ({ ...r, m: i < 3 ? r.m : Object.fromEntries(Object.entries(r.m).filter(([k]) => k !== "cost")) })) });
    expect(g.tooFew).toBe(false);
    const [line] = sideBySideLines(g, fixtureGroups()[1], ["cost"]);
    expect(line.tooFew).toBe(true);
  });
});
