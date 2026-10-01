// ORC-016 step 4: the pure helpers behind the pattern picker, the task page's pattern line, the Change
// pattern panel and Settings → Patterns. The components only render what these return.

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { builtInCatalog } from "../domain/patterns";
import { buildSeed } from "../domain/seed";
import type { Pattern, PatternRef, RetiredTemplate, State } from "../domain/types";
import {
  EXAMPLE_VARIANT,
  PIPELINE_CHANGED_MESSAGE,
  audienceText,
  catalogSummary,
  changeConsequences,
  defaultPatternNote,
  disabledProviders,
  earlierPatternLabel,
  errorLocation,
  hashTitle,
  patternAtRev,
  patternFlagChips,
  patternGroupOf,
  patternGroups,
  patternLineParts,
  patternLineText,
  patternOptionLabel,
  patternRefDetail,
  retiredTemplateJson,
  revisionPatternLabel,
  samePattern,
  shortHash,
  sourceLabel,
} from "./patternView";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const catalog = builtInCatalog().patterns;
const builtIn = (id: string) => catalog.find((p) => p.id === id)!;
const yours = (over: Partial<Pattern>): Pattern => ({ ...structuredClone(builtIn("change")), id: "mine", name: "Mine", source: "local", file: "~/.orchestration/patterns/mine.json", ...over });

describe("groups and labels", () => {
  it("puts experiments, patterns that pause and unreviewed ones in their own groups, and everything else under Standard", () => {
    expect(patternGroupOf(builtIn("change"))).toBe("standard");
    expect(patternGroupOf(builtIn("feature-design-gate"))).toBe("pauses");
    expect(patternGroupOf(builtIn("change-best-of-two"))).toBe("experiments");
    expect(patternGroupOf(builtIn("change-lean"))).toBe("experiments");
    const unreviewed = yours({ flags: { ...builtIn("change").flags, unreviewed: true }, audience: "user-only" });
    expect(patternGroupOf(unreviewed)).toBe("unreviewed");
    // An experiment that also pauses is an experiment first: the label the user chose for it wins.
    expect(patternGroupOf(yours({ experimental: true, hypothesis: "h", flags: { ...builtIn("change").flags, pausesForYou: true } }))).toBe("experiments");
  });

  it("lists the groups in a fixed order, drops empty ones and keeps the catalog order inside each", () => {
    const groups = patternGroups(catalog);
    expect(groups.map((g) => g.label)).toEqual(["Standard", "Pauses for you", "Experiments"]);
    expect(groups[0].patterns.map((p) => p.id)).toEqual(["change", "change-cross-review", "feature", "bugfix", "investigation", "design", "goal"]);
    expect(groups[1].patterns.map((p) => p.id)).toEqual(["feature-design-gate", "goal-plan-gate"]);
    expect(groups[2].patterns.map((p) => p.id)).toEqual(["change-best-of-two", "change-lean"]);
    expect(patternGroups([])).toEqual([]);
    expect(patternGroups([builtIn("goal-plan-gate")]).map((g) => g.id)).toEqual(["pauses"]);
  });

  it("labels options and sources: a file of yours says so, and one that replaces a built-in says that too", () => {
    expect(patternOptionLabel(builtIn("change"))).toBe("Change");
    expect(patternOptionLabel(yours({}))).toBe("Mine (yours)");
    expect(patternOptionLabel(yours({ replacesBuiltIn: true }))).toBe("Mine (yours, replaces built-in)");
    expect(sourceLabel("built-in")).toBe("built-in");
    expect(sourceLabel("local")).toBe("yours");
    expect(sourceLabel("local", true)).toBe("yours, replaces built-in");
    expect(sourceLabel("internal")).toBe("internal");
    expect(sourceLabel("legacy")).toBe("from before patterns");
    expect(sourceLabel("custom")).toBe("custom pipeline");
    expect(shortHash("0123456789abcdef")).toBe("01234567");
    expect(shortHash(undefined)).toBe("");
  });

  it("shows flag chips in a fixed order: experiment, pauses, no review, breaks down, yours", () => {
    expect(patternFlagChips(builtIn("change"))).toEqual([]);
    expect(patternFlagChips(builtIn("change-best-of-two")).map((c) => c.text)).toEqual(["experiment"]);
    expect(patternFlagChips(builtIn("goal-plan-gate")).map((c) => c.text)).toEqual(["pauses for you", "breaks down into child tasks"]);
    const everything = yours({ experimental: true, hypothesis: "h", replacesBuiltIn: true, flags: { breaksDown: true, pausesForYou: true, unreviewed: true, bestOf: false, needsProviders: [] } });
    expect(patternFlagChips(everything).map((c) => c.text)).toEqual(["experiment", "pauses for you", "no independent review", "breaks down into child tasks", "yours, replaces built-in"]);
    for (const c of patternFlagChips(everything)) expect(c.title.length).toBeGreaterThan(10);
  });

  it("says in one sentence who may choose a pattern", () => {
    expect(audienceText(builtIn("change"))).toMatch(/^Standard: the lead and breakdowns may choose it/);
    expect(audienceText(builtIn("change-lean"))).toBe("Yours to choose: it is an experiment, so the lead never picks it.");
    expect(audienceText(builtIn("feature-design-gate"))).toBe("Yours to choose: it pauses for you, so the lead never picks it.");
    expect(audienceText(yours({ audience: "user-only", flags: { ...builtIn("change").flags, unreviewed: true } }))).toBe("Yours to choose: it has no independent code review, so the lead never picks it.");
  });

  it("names the providers a best-of pattern needs that are not enabled", () => {
    const bestOf = builtIn("change-best-of-two");
    expect(bestOf.flags.needsProviders).toEqual(["claude", "codex"]);
    expect(disabledProviders(bestOf, ["claude", "codex"])).toEqual([]);
    expect(disabledProviders(bestOf, ["claude"])).toEqual(["codex"]);
    expect(disabledProviders(builtIn("change"), [])).toEqual([]);
  });
});

describe("the task page", () => {
  const ref = (over: Partial<PatternRef>): PatternRef => ({ id: "change", name: "Change", source: "built-in", hash: "abcdef0123456789", chosenBy: "user", ...over });

  it("writes the pattern line as 'Pattern: <name> (hash, source)', and legacy and custom pipelines truthfully", () => {
    expect(patternLineText(ref({}))).toBe("Pattern: Change");
    expect(patternRefDetail(ref({}))).toBe("(abcdef01, built-in)");
    expect(patternRefDetail(ref({ source: "local" }))).toBe("(abcdef01, yours)");
    expect(patternRefDetail(ref({ source: "internal", id: "revert", name: "Revert" }))).toBe("(abcdef01, internal)");
    expect(patternLineParts(ref({ source: "legacy", id: "feature", name: "Feature", hash: undefined }))).toEqual({ prefix: "From before patterns: ", name: "Feature" });
    expect(patternRefDetail(ref({ source: "legacy", hash: undefined }))).toBe("");
    expect(patternLineParts(ref({ source: "custom", id: "custom", name: "Custom pipeline", hash: undefined }))).toEqual({ prefix: "", name: "Custom pipeline" });
    expect(patternLineText(ref({ source: "custom", id: "custom", name: "Custom pipeline", hash: undefined }))).toBe("Custom pipeline");
  });

  it("puts the full hash and every file of the extends chain in the hash tooltip", () => {
    const p = builtIn("feature-design-gate");
    const title = hashTitle({ hash: p.hash, chain: p.chain });
    expect(title.split("\n")[0]).toBe(`Content hash ${p.hash}`);
    expect(title).toContain("patterns/feature-design-gate.json (built-in, ");
    expect(title).toContain("patterns/feature.json (built-in, ");
    expect(hashTitle({})).toBe("Content hash (none)");
  });

  it("finds the pattern in effect at a pipeline revision, skipping expansions, and labels earlier-pattern artifacts with it", () => {
    const feature = ref({ id: "feature", name: "Feature" });
    const change = ref({});
    const task = {
      pattern: change,
      pipelineHistory: [
        { rev: 1, at: at(0), author: "user" as const, reason: "Created from the Feature pattern", steps: [], pattern: feature },
        { rev: 2, at: at(1), author: "system" as const, reason: "Expanded S3 into 2 copies", steps: [] },
        { rev: 3, at: at(2), author: "user" as const, reason: "Pattern changed from Feature to Change", steps: [], pattern: change },
      ],
    };
    expect(patternAtRev(task, 1)?.name).toBe("Feature");
    expect(patternAtRev(task, 2)?.name).toBe("Feature");
    expect(patternAtRev(task, 3)?.name).toBe("Change");
    expect(patternAtRev(task, 0)).toBeUndefined();
    expect(earlierPatternLabel(task, 2)).toBe("earlier pattern (r2, Feature)");
    expect(earlierPatternLabel(task, 0)).toBe("earlier pattern (r0)");
    expect(revisionPatternLabel(task.pipelineHistory[0])).toBe("Feature · abcdef01");
    expect(revisionPatternLabel(task.pipelineHistory[1])).toBeUndefined();
    expect(revisionPatternLabel({ pattern: ref({ source: "legacy", hash: undefined }) })).toBe("Change");
  });

  it("knows when choosing a pattern would change nothing: same id, hash and source", () => {
    const change = builtIn("change");
    expect(samePattern(ref({ hash: change.hash }), change)).toBe(true);
    expect(samePattern(ref({ hash: "0000" }), change)).toBe(false);
    expect(samePattern(ref({ hash: change.hash, source: "local" }), change)).toBe(false);
    expect(samePattern(ref({ hash: change.hash }), builtIn("feature"))).toBe(false);
  });
});

describe("the Change pattern panel", () => {
  it("turns a preview into plain sentences: nothing run, pins, decisions and artifacts", () => {
    expect(changeConsequences({ redo: [], pinsKept: [], pinsDropped: [], artifactsKept: 0, decisionsClosed: 0 })).toEqual(["Nothing has run yet, so the pipeline is simply replaced.", "No step has a provider or model pin."]);
    expect(changeConsequences({ redo: ["S1"], pinsKept: ["S1"], pinsDropped: [], artifactsKept: 1, decisionsClosed: 1 })).toEqual([
      "1 completed step starts over (S1); their results stay on the record and are not used again.",
      "Pins kept: S1.",
      "1 open decision is closed.",
      '1 artifact is kept, labelled "earlier pattern".',
    ]);
    expect(
      changeConsequences({
        redo: ["S1", "C1", "S2"],
        pinsKept: [],
        pinsDropped: [
          { step: "S2", why: "role changed" },
          { step: "S6", why: "no such step" },
        ],
        artifactsKept: 4,
        decisionsClosed: 2,
      }),
    ).toEqual([
      "3 completed steps start over (S1, C1, S2); their results stay on the record and are not used again.",
      "Pins dropped: S2 (role changed), S6 (no such step).",
      "2 open decisions are closed.",
      '4 artifacts are kept, labelled "earlier pattern".',
    ]);
    expect(PIPELINE_CHANGED_MESSAGE).toBe("The pipeline changed while you were choosing; review again.");
  });

  it("matches the domain's preview for a real task (Bug fix → Change): a pin on S1 (coder in both) stays and one on S2 (coder → reviewer) is dropped", () => {
    const s0 = buildSeed(T0, { inFlightRuns: false });
    for (const t of s0.tasks) t.hold = true;
    const r = M.createTask(s0, { title: "Mine", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "bugfix" }, at(0));
    let s: State = r.state;
    const pin = { provider: "claude" as const, model: "claude-sample-large" };
    s = M.setStepSelection(s, r.newId, "S1", pin, at(1));
    s = M.setStepSelection(s, r.newId, "S2", pin, at(2));
    const t = s.tasks.find((x) => x.id === r.newId)!;
    const preview = M.patternChangePreview(s, t, builtIn("change"));
    expect(preview.allowed).toBe(true);
    expect(changeConsequences(preview)).toEqual(["Nothing has run yet, so the pipeline is simply replaced.", "Pins kept: S1.", "Pins dropped: S2 (role changed)."]);
  });
});

describe("Settings → Patterns", () => {
  it("notes a stored default that is no longer a standard pattern, and says nothing otherwise", () => {
    const standard = catalog.filter((p) => p.audience === "standard");
    expect(defaultPatternNote("change", standard, builtIn("change"))).toBeUndefined();
    expect(defaultPatternNote("gone", standard, builtIn("change"))).toBe('Using Change: "gone" is no longer a standard pattern in the catalog.');
    expect(defaultPatternNote("change-lean", standard, builtIn("change"))).toBe('Using Change: "change-lean" is no longer a standard pattern in the catalog.');
  });

  it("locates a load error at file:line:column when the position is known", () => {
    expect(errorLocation({ file: "~/.orchestration/patterns/x.jsonc", line: 3, column: 14 })).toBe("~/.orchestration/patterns/x.jsonc:3:14");
    expect(errorLocation({ file: "~/.orchestration/patterns/x.jsonc", line: 3 })).toBe("~/.orchestration/patterns/x.jsonc:3:1");
    expect(errorLocation({ file: "~/.orchestration/patterns/x.jsonc" })).toBe("~/.orchestration/patterns/x.jsonc");
  });

  it("summarises the catalog with the count of yours and of files with errors", () => {
    expect(catalogSummary({ patterns: catalog, errors: [] })).toBe("11 patterns");
    expect(catalogSummary({ patterns: [...catalog, yours({})], errors: [{ file: "a" }, { file: "a" }, { file: "b" }] })).toBe("12 patterns (1 yours); 2 files with errors");
    expect(catalogSummary({ patterns: [yours({})], errors: [{ file: "a" }] })).toBe("1 pattern (1 yours); 1 file with errors");
  });

  it("builds the pattern file a retired template would become, leaving out copyOf, iteration and checks.only, and making best-of an experiment", () => {
    const steps = structuredClone(builtIn("change").steps);
    steps[1].checks = { onFail: "findings", only: ["lint"] };
    steps[0].copyOf = "S1";
    steps[0].parallel = { count: 2, mode: "best-of" };
    const t: RetiredTemplate = { id: "my-flow", name: "My flow", description: "Mine", steps, kind: "custom", retiredAt: at(0), exportError: "A file named x already exists; yours was kept." };
    const json = retiredTemplateJson(t);
    const parsed = JSON.parse(json) as { id: string; name: string; experimental?: boolean; hypothesis?: string; steps: { copyOf?: string; checks?: { only?: string[] } }[]; $schema: string; whenToUse: string };
    expect(parsed.$schema).toBe("./pattern.schema.json");
    expect(parsed.id).toBe("my-flow");
    expect(parsed.name).toBe("My flow");
    expect(parsed.experimental).toBe(true);
    expect(parsed.hypothesis).toContain("best-of");
    expect(parsed.steps[0].copyOf).toBeUndefined();
    expect(parsed.steps[1].checks).toEqual({ onFail: "findings" });
    expect(parsed.whenToUse).toContain("Edit this file");
    expect(json.endsWith("\n")).toBe(true);
    // An edited built-in takes the "-yours" id and name unless the export already chose one.
    const edited = retiredTemplateJson({ ...t, id: "feature", name: "Feature", kind: "edited-built-in", steps: builtIn("feature").steps });
    expect(JSON.parse(edited)).toMatchObject({ id: "feature-yours", name: "Feature (yours)" });
    expect(JSON.parse(retiredTemplateJson({ ...t, exportedId: "my-flow-yours-2" }))).toMatchObject({ id: "my-flow-yours-2" });
  });

  it("keeps the example variant in step with the README: it extends bugfix and gates S1", () => {
    expect(EXAMPLE_VARIANT).toContain('"extends": "bugfix"');
    expect(EXAMPLE_VARIANT).toContain('"S1": { "gate": true }');
    expect(EXAMPLE_VARIANT).toContain('"id": "bugfix-pause-after-repro"');
  });
});
