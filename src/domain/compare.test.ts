// ORC-018 B1: comparing patterns, pure (design §2–§3). `deliveryOutcome` over every delivery status; the
// measures and their "missing when" rules (a missing value is never zero); the quantiles at small n;
// "too few"; grouping by version, merged on request; every filter; and the RFC 4180 CSV.

import { describe, expect, it } from "vitest";
import { compareRows, csvField, DEFAULT_FILTER, filterRows, groupRows, MEASURES, measureStat, measuresOf, quantile, toCSV, toJSON, TOO_FEW, type CompareRow } from "./compare";
import { deliveryOutcome } from "./outcomes";
import { buildSeed } from "./seed";
import type { Landed, State, Task, TaskOutcome } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** A full outcome with quiet defaults: one Codex run with usage, no findings, final checks passed, one complete review. */
function outcome(over: DeepPartial<TaskOutcome> = {}): TaskOutcome {
  const base: TaskOutcome = {
    v: 1,
    result: "done",
    settledAt: at(100),
    pattern: { id: "change", name: "Change", source: "built-in", hash: "h1", chosenBy: "lead" },
    patternChanges: 0,
    runsBeforePattern: 0,
    createdAt: at(0),
    firstRunAt: at(10),
    wallMs: 90_000,
    agentMs: 60_000,
    runs: [{ role: "coder", runner: "codex", model: "codex-x", runs: 2, completed: 2, failed: 0, stopped: 0, lost: 0, discarded: 0, ms: 60_000, inputTokens: 1000, outputTokens: 200, costUsd: null }],
    usage: [{ provider: "codex", inputTokens: 1000, outputTokens: 200, costUsd: 0.5, runsWithoutUsage: 0 }],
    repair: { rounds: 0, iterations: 0, finalCheckRounds: 0 },
    findings: { raised: { error: 1, warning: 2, info: 0 }, byAction: { "auto-fix": 1, "ask-user": 2, "no-op": 0 }, summaryOnly: 0, openAtEnd: 1 },
    decisions: { total: 1, byUser: 1, byLead: 0, fix: 1, accept: 0, followUp: 0, superseded: 0, open: 0 },
    checks: { runs: 2, failedRuns: 1, finalPassed: true, acceptedFailing: false },
    coverage: { reviews: 2, complete: 1, incomplete: 1, unproven: 0, retries: 0 },
    human: { artifactEdits: 1, pinnedSteps: 0, candidateChoices: 1 },
  };
  // A nested override merges into the default, except `pattern`, which replaces it (a legacy pattern has no hash).
  const merged = { ...base, ...over } as TaskOutcome;
  for (const k of ["repair", "findings", "decisions", "checks", "coverage", "human"] as const) {
    if (over[k]) (merged as unknown as Record<string, unknown>)[k] = { ...(base[k] as object), ...(over[k] as object) };
  }
  return merged;
}

function landed(over: Partial<Landed> = {}): Landed {
  return { at: at(200), via: "pr", target: "o/r main", commit: "c".repeat(40), by: "app", flags: [], status: "unreviewed", notes: [], followUps: [], ...over };
}

/** A settled task of the seed (EX-006, done) with the given outcome (`null`: none) and integration. */
function task(over: Partial<Task> = {}, o: TaskOutcome | null = outcome()): Task {
  const s = buildSeed(T0, { inFlightRuns: false });
  const t = structuredClone(s.tasks.find((x) => x.id === "EX-006")!);
  delete t.integration;
  return { ...t, ...(o ? { outcome: o } : {}), ...over };
}

describe("deliveryOutcome", () => {
  it("is not-delivered without an integration record or while pending", () => {
    expect(deliveryOutcome(task())).toEqual({ status: "not-delivered", flags: [] });
    expect(deliveryOutcome(task({ integration: { status: "pending" } }))).toEqual({ status: "not-delivered", flags: [] });
  });

  it("reads integrated, an open pull request, conflict and not-needed from the integration", () => {
    expect(deliveryOutcome(task({ integration: { status: "integrated", at: at(150) } })).status).toBe("integrated");
    expect(deliveryOutcome(task({ integration: { status: "conflict" } })).status).toBe("conflict");
    expect(deliveryOutcome(task({ integration: { status: "not-needed" } })).status).toBe("not-needed");
    const pr = (phase: "built" | "open" | "merged" | "closed", observed?: "OPEN" | "CLOSED" | "MERGED") =>
      task({ integration: { status: "integrated", pr: { phase, ...(observed ? { observed: { state: observed } } : {}) } as unknown as NonNullable<Task["integration"]>["pr"] } });
    expect(deliveryOutcome(pr("open")).status).toBe("pr-open");
    expect(deliveryOutcome(pr("built")).status).toBe("pr-open");
    // Closed from the app, or observed CLOSED on GitHub, and not landed: closed.
    expect(deliveryOutcome(pr("closed")).status).toBe("closed");
    expect(deliveryOutcome(pr("open", "CLOSED")).status).toBe("closed");
  });

  it("landed by the app, with time to landed from the first run", () => {
    const d = deliveryOutcome(task({ integration: { status: "integrated", landed: landed({ flags: ["checks-not-run"] }) } }));
    expect(d).toEqual({ status: "landed", landedAt: at(200), landedBy: "app", via: "pr", timeToLandedMs: 190_000, flags: ["checks-not-run"] });
  });

  it("landed by a person, through local delivery", () => {
    const d = deliveryOutcome(task({ integration: { status: "integrated", landed: landed({ by: "person", via: "local", mergedBy: "someone" }) } }));
    expect(d).toMatchObject({ status: "landed", landedBy: "person", via: "local" });
    expect(JSON.stringify(d)).not.toContain("someone");
  });

  it("has no time to landed without a first run", () => {
    const d = deliveryOutcome(task({ integration: { status: "integrated", landed: landed() } }, outcome({ firstRunAt: undefined, wallMs: undefined })));
    expect(d.status).toBe("landed");
    expect(d.timeToLandedMs).toBeUndefined();
  });

  it("sent back as a fix, as a revert, and revert wins when both exist", () => {
    const fix = landed({ status: "sent-back", followUps: [{ taskId: "F1", kind: "fix" }] });
    expect(deliveryOutcome(task({ integration: { status: "integrated", landed: fix } })).sentBack).toBe("fix");
    const revert = landed({ status: "sent-back", followUps: [{ taskId: "R1", kind: "revert" }] });
    expect(deliveryOutcome(task({ integration: { status: "integrated", landed: revert } })).sentBack).toBe("revert");
    const both = landed({ status: "sent-back", followUps: [{ taskId: "F1", kind: "fix" }, { taskId: "R1", kind: "revert" }] });
    expect(deliveryOutcome(task({ integration: { status: "integrated", landed: both } })).sentBack).toBe("revert");
    // The status alone (no follow-up recorded) still counts as sent back.
    expect(deliveryOutcome(task({ integration: { status: "integrated", landed: landed({ status: "sent-back" }) } })).sentBack).toBe("fix");
    expect(deliveryOutcome(task({ integration: { status: "integrated", landed: landed({ status: "reviewed" }) } })).sentBack).toBeUndefined();
  });
});

describe("measuresOf", () => {
  it("reads every measure from a complete outcome", () => {
    const t = task({ integration: { status: "integrated", landed: landed({ status: "sent-back", followUps: [{ taskId: "F1", kind: "fix" }] }) } });
    expect(measuresOf(t, t.outcome!)).toEqual({
      timeToDone: 90_000,
      agentTime: 60_000,
      runs: 2,
      inputTokens: 1000,
      outputTokens: 200,
      cost: 0.5,
      repairRounds: 0,
      findingsRaised: 3,
      errorsRaised: 1,
      openAtEnd: 1,
      firstPassChecks: 1,
      failedCheckRuns: 1,
      reviewComplete: 0.5,
      humanTouches: 3,
      landed: 1,
      sentBack: 1,
      timeToLanded: 190_000,
    });
  });

  it("leaves a measure out, never zero, when the outcome did not report it", () => {
    const noRun = measuresOf(task(), outcome({ firstRunAt: undefined, wallMs: undefined }));
    expect(noRun.timeToDone).toBeUndefined();
    expect("timeToDone" in noRun).toBe(false);

    // A provider row with runs that reported no usage: tokens and cost are unknown.
    const partial = measuresOf(task(), outcome({ usage: [{ provider: "codex", inputTokens: 1000, outputTokens: 200, costUsd: 0.5, runsWithoutUsage: 0 }, { provider: "claude", inputTokens: 10, outputTokens: 1, costUsd: 0.1, runsWithoutUsage: 1 }] }));
    expect(partial.inputTokens).toBeUndefined();
    expect(partial.outputTokens).toBeUndefined();
    expect(partial.cost).toBeUndefined();

    // Codex reports tokens only: the tokens are known, the cost is not.
    const noCost = measuresOf(task(), outcome({ usage: [{ provider: "codex", inputTokens: 1000, outputTokens: 200, costUsd: null, runsWithoutUsage: 0 }, { provider: "claude", inputTokens: 10, outputTokens: 1, costUsd: 0.1, runsWithoutUsage: 0 }] }));
    expect(noCost).toMatchObject({ inputTokens: 1010, outputTokens: 201 });
    expect(noCost.cost).toBeUndefined();

    const noChecks = measuresOf(task(), outcome({ checks: { runs: 0, failedRuns: 0, finalPassed: null, acceptedFailing: false } }));
    expect(noChecks.firstPassChecks).toBeUndefined();
    expect(noChecks.failedCheckRuns).toBeUndefined();

    expect(measuresOf(task(), outcome({ coverage: { reviews: 0, complete: 0, incomplete: 0, unproven: 0, retries: 0 } })).reviewComplete).toBeUndefined();

    // Nothing to deliver: no landed rate; not landed: no sent-back rate and no time to landed.
    const notNeeded = measuresOf(task({ integration: { status: "not-needed" } }), outcome());
    expect(notNeeded.landed).toBeUndefined();
    const open = measuresOf(task({ integration: { status: "integrated" } }), outcome());
    expect(open.landed).toBe(0);
    expect(open.sentBack).toBeUndefined();
    expect(open.timeToLanded).toBeUndefined();
  });

  it("checks passed first time needs a pass with no repair round", () => {
    expect(measuresOf(task(), outcome({ repair: { rounds: 1 } })).firstPassChecks).toBe(0);
    expect(measuresOf(task(), outcome({ checks: { finalPassed: false } })).firstPassChecks).toBe(0);
    expect(measuresOf(task(), outcome()).firstPassChecks).toBe(1);
  });

  it("counts agent runs only, not the service's check runs", () => {
    const o = outcome({ runs: [...outcome().runs, { role: "checks", runner: "service", model: "checks", runs: 3, completed: 3, failed: 0, stopped: 0, lost: 0, discarded: 0, ms: 1, inputTokens: 0, outputTokens: 0, costUsd: null }] });
    expect(measuresOf(task(), o).runs).toBe(2);
  });
});

describe("compareRows", () => {
  function state(tasks: Task[]): State {
    const s = buildSeed(T0, { inFlightRuns: false });
    s.tasks = tasks;
    return s;
  }

  it("makes one row per settled task with an outcome, and none for service-owned or internal tasks", () => {
    const s = state([
      task({ id: "A" }),
      task({ id: "open" }, null),
      task({ id: "review", reviewTarget: { taskId: "A", n: 1, headSha: "h", baseSha: "b" } }),
      task({ id: "check", checkTarget: { taskId: "A", n: 1, sha: "h" } }),
      task({ id: "fix", deliverInto: { taskId: "A", n: 1, mergeBase: false } }),
      task({ id: "revert" }, outcome({ pattern: { id: "revert", name: "Revert", source: "internal", hash: "x", chosenBy: "service" } })),
    ]);
    expect(compareRows(s).map((r) => r.taskId)).toEqual(["A"]);
  });

  it("carries the pattern at settle, the spec's title and area, and the sample flag", () => {
    const s = state([task({ id: "A" }, outcome({ pattern: { id: "lean", name: "Lean", source: "local", hash: "h9", chosenBy: "user", experimental: true } }))]);
    const [r] = compareRows(s);
    expect(r).toMatchObject({ taskId: "A", result: "done", settledAt: at(100), simulated: true, changedPattern: false });
    expect(r.title).toBe(s.tasks[0].specs[s.tasks[0].specs.length - 1].content.title);
    expect(r.pattern).toEqual({ id: "lean", name: "Lean", hash: "h9", source: "local", chosenBy: "user", experimental: true });
    s.project.sample = false;
    expect(compareRows(s)[0].simulated).toBe(false);
  });

  it("marks tasks that changed pattern after runs started", () => {
    const s = state([task({ id: "A" }, outcome({ patternChanges: 1 })), task({ id: "B" }, outcome({ runsBeforePattern: 2 })), task({ id: "C" })]);
    expect(compareRows(s).map((r) => [r.taskId, r.changedPattern])).toEqual([
      ["A", true],
      ["B", true],
      ["C", false],
    ]);
  });

  it("groups legacy and custom pipelines without a hash as Custom pipelines", () => {
    const s = state([task({ id: "L" }, outcome({ pattern: { id: "change", name: "Change", source: "legacy", chosenBy: "migration" } })), task({ id: "C" }, outcome({ pattern: { id: "custom", name: "Custom pipeline", source: "custom", chosenBy: "user" } }))]);
    const rows = compareRows(s);
    expect(rows.map((r) => r.pattern.id)).toEqual(["custom", "custom"]);
    expect(rows.map((r) => r.pattern.name)).toEqual(["Custom pipelines", "Custom pipelines"]);
    expect(groupRows(s, rows, { ...DEFAULT_FILTER })).toHaveLength(1);
  });
});

/** A row with the given measures; everything else is plain. */
function row(id: string, m: CompareRow["m"], over: Partial<Omit<CompareRow, "m">> = {}): CompareRow {
  return { taskId: id, title: `Task ${id}`, area: "A", result: "done", settledAt: at(100), pattern: { id: "change", name: "Change", hash: "h1", source: "built-in", chosenBy: "lead", experimental: false }, changedPattern: false, m, simulated: false, ...over };
}

describe("statistics", () => {
  it("interpolates quantiles as R type 7", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(quantile([10, 20], 0.5)).toBe(15);
  });

  it("n = 0: nothing but the counts", () => {
    const st = measureStat("timeToDone", [row("a", {}), row("b", {})]);
    expect(st).toEqual({ n: 0, of: 2, tooFew: true, values: [] });
  });

  it("n = 1: min and max, no quantiles", () => {
    const st = measureStat("runs", [row("a", { runs: 3 }), row("b", {})]);
    expect(st).toEqual({ n: 1, of: 2, min: 3, max: 3, tooFew: true, values: [3] });
    expect(st.median).toBeUndefined();
  });

  it("n = 2: the median halfway, the quartiles a quarter of the way", () => {
    const st = measureStat("runs", [row("a", { runs: 2 }), row("b", { runs: 6 })]);
    expect(st).toMatchObject({ n: 2, of: 2, median: 4, q1: 3, q3: 5, min: 2, max: 6, tooFew: true });
  });

  it("n = 5 is enough to compare", () => {
    const st = measureStat("cost", [1, 5, 2, 4, 3].map((v, i) => row(String(i), { cost: v })));
    expect(st).toMatchObject({ n: 5, of: 5, median: 3, q1: 2, q3: 4, min: 1, max: 5, tooFew: false });
    expect(st.values).toEqual([1, 5, 2, 4, 3]);
  });

  it("counts a rate's ones and never averages a missing value as zero", () => {
    const rows = [row("a", { landed: 1 }), row("b", { landed: 0 }), row("c", { landed: 1 }), row("d", {})];
    const st = measureStat("landed", rows);
    expect(st).toEqual({ n: 3, of: 4, count: 2, tooFew: true, values: [1, 0, 1] });
    expect(st.median).toBeUndefined();
  });

  it(`a measure with n < ${TOO_FEW} is too few even in a big group`, () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(String(i), i < 4 ? { cost: i } : {}));
    const st = measureStat("cost", rows);
    expect(st).toMatchObject({ n: 4, of: 8, tooFew: true });
    expect(measureStat("runs", rows.map((r, i) => ({ ...r, m: { runs: i } }))).tooFew).toBe(false);
  });
});

describe("groupRows", () => {
  const s = buildSeed(T0, { inFlightRuns: false });
  const current = s.patterns.patterns.find((p) => p.id === "change")!.hash;
  const v1 = (id: string, m: CompareRow["m"] = {}, over: Partial<Omit<CompareRow, "m">> = {}) => row(id, m, { pattern: { id: "change", name: "Change", hash: current, source: "built-in", chosenBy: "lead", experimental: false }, ...over });
  const v0 = (id: string, m: CompareRow["m"] = {}, over: Partial<Omit<CompareRow, "m">> = {}) => row(id, m, { pattern: { id: "change", name: "Change (older)", hash: "old", source: "built-in", chosenBy: "lead", experimental: false }, settledAt: at(50), ...over });
  const bug = (id: string, m: CompareRow["m"] = {}, over: Partial<Omit<CompareRow, "m">> = {}) => row(id, m, { pattern: { id: "bugfix", name: "Bug fix", hash: "b1", source: "built-in", chosenBy: "user", experimental: false }, ...over });

  it("groups by pattern id and hash, marks the current version, and sorts by size then name", () => {
    const rows = [v1("1", { runs: 1 }), v1("2", { runs: 2 }), v0("3", { runs: 9 }), bug("4"), bug("5"), bug("6")];
    const groups = groupRows(s, rows, DEFAULT_FILTER);
    expect(groups.map((g) => [g.key, g.rows.length, g.tooFew])).toEqual([
      ["bugfix@b1", 3, true],
      [`change@${current}`, 2, true],
      ["change@old", 1, true],
    ]);
    const cur = groups.find((g) => g.key === `change@${current}`)!;
    expect(cur).toMatchObject({ patternId: "change", name: "Change", hashes: [current], currentHash: current, source: "built-in", experimental: false });
    expect(cur.stats.runs).toMatchObject({ n: 2, of: 2, median: 1.5 });
    const old = groups.find((g) => g.key === "change@old")!;
    expect(old.currentHash).toBeUndefined();
    expect(old.stats.runs).toMatchObject({ n: 1, of: 1, min: 9, max: 9 });
    expect(Object.keys(cur.stats).sort()).toEqual(MEASURES.map((d) => d.id).sort());
  });

  it("merges versions on request, listing the hashes it mixes, named after the newest row", () => {
    const rows = [v1("1", { runs: 1 }), v1("2", { runs: 2 }), v0("3", { runs: 9 })];
    const [g] = groupRows(s, rows, { ...DEFAULT_FILTER, mergeVersions: true });
    expect(g).toMatchObject({ key: "change", patternId: "change", name: "Change", hashes: [current, "old"], currentHash: current, tooFew: true });
    expect(g.rows.map((r) => r.taskId)).toEqual(["1", "2", "3"]);
    expect(g.stats.runs).toMatchObject({ n: 3, median: 2, min: 1, max: 9 });
  });

  it("sorts bigger groups first, then by name", () => {
    const rows = [v1("1"), bug("2"), bug("3"), v0("4", {}, { pattern: { id: "aaa", name: "Aaa", hash: "x", source: "local", chosenBy: "user", experimental: true } })];
    expect(groupRows(s, rows, DEFAULT_FILTER).map((g) => g.name)).toEqual(["Bug fix", "Aaa", "Change"]);
  });

  it("filters: results (done only by default), areas, chosenBy, a date range, and changed-pattern rows", () => {
    const rows = [
      v1("done"),
      v1("cancelled", {}, { result: "cancelled" }),
      v1("areaB", {}, { area: "B" }),
      bug("byUser"),
      v1("early", {}, { settledAt: at(-86_400 * 3) }),
      v1("late", {}, { settledAt: at(86_400 * 3) }),
      v1("changed", {}, { changedPattern: true }),
    ];
    const ids = (f: Partial<typeof DEFAULT_FILTER>) => filterRows(rows, { ...DEFAULT_FILTER, ...f }).map((r) => r.taskId);
    expect(ids({})).toEqual(["done", "areaB", "byUser", "early", "late"]);
    expect(ids({ results: ["done", "cancelled"] })).toContain("cancelled");
    expect(ids({ results: ["cancelled"] })).toEqual(["cancelled"]);
    expect(ids({ areas: ["B"] })).toEqual(["areaB"]);
    expect(ids({ areas: ["A", "B"] })).toHaveLength(5);
    expect(ids({ chosenBy: ["user"] })).toEqual(["byUser"]);
    expect(ids({ chosenBy: ["lead", "user"] })).toHaveLength(5);
    expect(ids({ from: "2026-09-29" })).toEqual(["done", "areaB", "byUser", "late"]);
    expect(ids({ to: "2026-09-30" })).toEqual(["done", "areaB", "byUser", "early"]); // a date-only bound covers its whole day
    expect(ids({ from: at(-3600), to: at(3600) })).toEqual(["done", "areaB", "byUser"]);
    expect(ids({ includeChanged: true })).toContain("changed");
    expect(groupRows(s, rows, { ...DEFAULT_FILTER, areas: ["nowhere"] })).toEqual([]);
  });
});

describe("exports", () => {
  it("quotes fields with commas, quotes and line breaks, doubling quotes, with CRLF line ends", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a, b")).toBe('"a, b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("cr\rlf")).toBe('"cr\rlf"');
    expect(csvField(undefined)).toBe("");
    expect(csvField(0)).toBe("0");
    expect(csvField(true)).toBe("true");
  });

  it("writes a header, one line per row, every measure, and an empty cell for a missing measure", () => {
    const rows = [row("T-1", { timeToDone: 1000, cost: 0.25, landed: 1 }, { title: 'Fix "quotes", commas,\nand lines' }), row("T-2", { runs: 0 }, { title: "Plain", result: "cancelled", simulated: true, changedPattern: true })];
    const csv = toCSV(rows);
    const lines = csv.split("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines.at(-1)).toBe("");
    // Header, two records and the trailing line end; the bare newline inside the quoted title is not a record end.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(["task_id", "title", "area", "result", "settled_at", "pattern_id", "pattern_name", "pattern_hash", "pattern_source", "chosen_by", "experimental", "changed_pattern", "simulated", ...MEASURES.map((d) => d.id)].join(","));
    // The quoted title keeps its newline inside the record: the second record starts after the closing quote.
    const body = csv.slice(lines[0].length + 2);
    expect(body.startsWith(`T-1,"Fix ""quotes"", commas,\nand lines",A,done,${at(100)},change,Change,h1,built-in,lead,false,false,false,1000,,,,,0.25,,,,,,,,,1,,\r\n`)).toBe(true);
    expect(body.endsWith(`T-2,Plain,A,cancelled,${at(100)},change,Change,h1,built-in,lead,false,true,true,,,0,,,,,,,,,,,,,,\r\n`)).toBe(true);
    // A row has exactly one cell per column, even with the newline in the title.
    const cells = (line: string) => line.split(",").length;
    expect(cells(lines[0])).toBe(13 + MEASURES.length);
    expect(cells(body.split("\r\n")[1])).toBe(13 + MEASURES.length);
  });

  it("writes JSON with the filter, the sample flag and the rows", () => {
    const rows = [row("T-1", { runs: 2 })];
    const out = JSON.parse(toJSON(rows, { ...DEFAULT_FILTER, areas: ["A"] }, true, at(500)));
    expect(out).toEqual({ generatedAt: at(500), filter: { ...DEFAULT_FILTER, areas: ["A"] }, simulated: true, rows });
  });
});
