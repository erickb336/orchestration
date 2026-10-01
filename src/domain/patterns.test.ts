// ORC-016 step 1: the pure pattern resolver. Base patterns and variants, files of yours replacing built-ins
// (and the built-in kept when yours is broken), the pattern rules, the derived flags and audience, the
// hashes and who may use what. No files are read here: the built-ins are compiled in.

import { describe, expect, it } from "vitest";
import { BUILT_IN_FILES } from "./builtInPatterns";
import { INTERNAL_PATTERN_IDS } from "./internalPatterns";
import { builtInCatalog, eligible, fileHash, patternHash, patternSummary, resolveCatalog, type PatternFile, type RawPattern } from "./patterns";
import { buildSeed } from "./seed";
import type { Pattern, StepDef } from "./types";

const raw = (id: string, over: Record<string, unknown>): RawPattern => ({ id, name: id, description: `${id} description`, whenToUse: `when ${id}`, ...over }) as RawPattern;
const local = (id: string, over: Record<string, unknown>, ext = "json"): PatternFile => ({ file: `~/.orchestration/patterns/${id}.${ext}`, source: "local", raw: raw(id, over) });
const resolve = (...locals: PatternFile[]) => resolveCatalog([...BUILT_IN_FILES, ...locals]);
const byId = (r: { patterns: Pattern[] }, id: string) => r.patterns.find((p) => p.id === id);
const builtIn = (id: string) => builtInCatalog().patterns.find((p) => p.id === id)!;

const oneStep: StepDef[] = [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }];
const reviewed: StepDef[] = [
  ...oneStep,
  { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
];

describe("resolution", () => {
  it("the built-in catalog resolves every file with no errors, sorted by order", () => {
    const c = builtInCatalog();
    expect(c.errors).toEqual([]);
    expect(c.patterns.map((p) => p.id)).toEqual(["change", "change-cross-review", "feature", "feature-design-gate", "bugfix", "investigation", "design", "goal", "goal-plan-gate", "change-best-of-two", "change-lean"]);
    expect(c.patterns.every((p) => p.source === "built-in" && p.file === `patterns/${p.id}.json` && p.chain[0].id === p.id)).toBe(true);
    // The catalog in the seed is this one.
    expect(buildSeed(Date.parse("2026-09-30T12:00:00Z")).patterns.patterns.map((p) => p.id)).toEqual(c.patterns.map((p) => p.id));
  });

  it("a variant extends its base and overrides one field; null removes an optional field; null on a required field is an error", () => {
    const cross = builtIn("change-cross-review");
    const change = builtIn("change");
    expect(cross.steps.find((s) => s.id === "S2")!.independentOf).toBe("writer");
    expect(cross.steps.map((s) => ({ ...s, independentOf: undefined }))).toEqual(change.steps.map((s) => ({ ...s, independentOf: undefined })));
    expect(cross.chain.map((c) => c.id)).toEqual(["change-cross-review", "change"]);
    expect(cross.chain[1]).toEqual(change.chain[0]);
    const gate = builtIn("feature-design-gate");
    expect(gate.steps[0].gate).toBe(true);
    const noGate = resolve(local("feature-plain", { extends: "feature-design-gate", stepOverrides: { S1: { gate: null } } }));
    expect(noGate.errors).toEqual([]);
    expect(byId(noGate, "feature-plain")!.steps).toEqual(builtIn("feature").steps);
    expect(byId(noGate, "feature-plain")!.hash).toBe(builtIn("feature").hash);
    expect(byId(noGate, "feature-plain")!.chain.map((c) => c.id)).toEqual(["feature-plain", "feature-design-gate", "feature"]);
    const bad = resolve(local("no-purpose", { extends: "change", stepOverrides: { S1: { purpose: null } } }));
    expect(byId(bad, "no-purpose")).toBeUndefined();
    expect(bad.errors).toEqual([expect.objectContaining({ file: "~/.orchestration/patterns/no-purpose.json", id: "no-purpose", message: expect.stringMatching(/stepOverrides\.S1\.purpose: null removes an optional field only/), effect: "skipped" })]);
  });

  it("an unknown override step, an unknown base and a top-level mix of steps and extends are errors", () => {
    expect(resolve(local("xx", { extends: "change", stepOverrides: { S9: { gate: true } } })).errors[0].message).toMatch(/base pattern has no step S9/);
    expect(resolve(local("xx", { extends: "nope", stepOverrides: { S1: { gate: true } } })).errors[0].message).toMatch(/extends "nope", which is not a pattern in the catalog/);
    expect(resolve(local("xx", { extends: "change", steps: oneStep })).errors[0].message).toMatch(/not both/);
  });

  it("a cycle a → b → a is an error on both; an extends chain deeper than 3 is an error", () => {
    const cycle = resolve(local("aa", { extends: "bb", stepOverrides: { S1: { gate: true } } }), local("bb", { extends: "aa", stepOverrides: { S1: { gate: true } } }));
    expect(byId(cycle, "aa")).toBeUndefined();
    expect(byId(cycle, "bb")).toBeUndefined();
    expect(cycle.errors.map((e) => e.id).sort()).toEqual(["aa", "bb"]);
    expect(cycle.errors.every((e) => /cycle/.test(e.message))).toBe(true);
    // A file of yours extending its own id is a cycle too; the built-in stays.
    const self = resolve(local("change", { extends: "change", stepOverrides: { S1: { gate: true } } }));
    expect(byId(self, "change")!.source).toBe("built-in");
    expect(self.errors[0]).toMatchObject({ id: "change", effect: "built-in kept" });
    const v = (n: number, base: string) => local(`v${n}`, { extends: base, stepOverrides: { S1: { purpose: `Implement v${n}` } } });
    const deep = resolve(v(1, "change"), v(2, "v1"), v(3, "v2"), v(4, "v3"));
    expect(byId(deep, "v3")!.chain).toHaveLength(4);
    expect(byId(deep, "v4")).toBeUndefined();
    expect(deep.errors).toEqual([expect.objectContaining({ id: "v4", message: expect.stringMatching(/deeper than 3/) })]);
  });
});

describe("your files", () => {
  it("a file of yours with a built-in's id replaces it and is marked as such", () => {
    const r = resolve(local("change", { steps: reviewed }));
    const p = byId(r, "change")!;
    expect(r.errors).toEqual([]);
    expect(p).toMatchObject({ source: "local", replacesBuiltIn: true, file: "~/.orchestration/patterns/change.json" });
    expect(p.steps).toEqual(reviewed);
    expect(r.patterns.filter((x) => x.id === "change")).toHaveLength(1);
  });

  it("a broken file of yours that replaces feature leaves the built-in in effect, with the error listed as built-in kept", () => {
    const broken = local("feature", { steps: [{ ...oneStep[0], dependsOn: ["S9"] }] });
    const r = resolve(broken);
    const feature = byId(r, "feature")!;
    expect(feature.source).toBe("built-in");
    expect(feature.replacesBuiltIn).toBeUndefined();
    expect(feature.steps).toEqual(builtIn("feature").steps);
    expect(feature.hash).toBe(builtIn("feature").hash);
    expect(r.errors).toEqual([expect.objectContaining({ file: "~/.orchestration/patterns/feature.json", id: "feature", message: expect.stringMatching(/S1 depends on S9/), effect: "built-in kept" })]);
    // A variant that extends the failed id extends the built-in.
    const withVariant = resolve(broken, local("feature-x", { extends: "feature", stepOverrides: { S1: { gate: true } } }));
    expect(byId(withVariant, "feature-x")!.steps).toEqual(builtIn("feature-design-gate").steps);
    expect(byId(withVariant, "feature-x")!.chain[1]).toMatchObject({ id: "feature", source: "built-in" });
  });

  it("duplicate ids among your files skip both; a misnamed file fails alone and never knocks out the correctly named one (step 1 review, finding 3)", () => {
    const dup = resolve(local("mine", { steps: reviewed }), local("mine", { steps: reviewed }, "jsonc"));
    expect(byId(dup, "mine")).toBeUndefined();
    expect(dup.errors).toHaveLength(2);
    expect(dup.errors.map((e) => e.file).sort()).toEqual(["~/.orchestration/patterns/mine.json", "~/.orchestration/patterns/mine.jsonc"]);
    const misnamed: PatternFile = { file: "~/.orchestration/patterns/other.json", source: "local", raw: raw("mine", { steps: reviewed }) };
    expect(resolve(misnamed).errors[0].message).toMatch(/named "other" but declares the id "mine"/);
    // The misnamed file is checked before ids are grouped: mine.json loads, other.json alone is listed.
    const both = resolve(local("mine", { steps: reviewed }), misnamed);
    expect(byId(both, "mine")).toMatchObject({ source: "local", file: "~/.orchestration/patterns/mine.json" });
    expect(both.errors).toEqual([expect.objectContaining({ file: "~/.orchestration/patterns/other.json", id: "mine", effect: "skipped", message: expect.stringMatching(/named "other" but declares the id "mine"/) })]);
    // A misnamed file declaring a built-in's id leaves that built-in in effect.
    const overBuiltIn: PatternFile = { file: "~/.orchestration/patterns/other.json", source: "local", raw: raw("change", { steps: reviewed }) };
    expect(resolve(overBuiltIn).errors[0]).toMatchObject({ id: "change", effect: "built-in kept" });
    expect(byId(resolve(overBuiltIn), "change")!.source).toBe("built-in");
  });

  it("a file of yours that extends its own built-in id is a variant of that built-in (step 1 review, finding 6)", () => {
    const r = resolve(local("change", { extends: "change", stepOverrides: { S2: { independentOf: "writer" } } }));
    expect(r.errors).toEqual([]);
    const p = byId(r, "change")!;
    expect(p).toMatchObject({ source: "local", replacesBuiltIn: true, audience: "standard" });
    expect(p.steps).toEqual(builtIn("change-cross-review").steps);
    expect(p.chain.map((c) => [c.id, c.source])).toEqual([
      ["change", "local"],
      ["change", "built-in"],
    ]);
    // Variants of "change" now build on the file of yours.
    expect(byId(r, "change-cross-review")!.chain.map((c) => [c.id, c.source])).toEqual([
      ["change-cross-review", "built-in"],
      ["change", "local"],
      ["change", "built-in"],
    ]);
    // Without a built-in of that id there is nothing to extend; a cycle through another file is still a cycle.
    expect(resolve(local("solo", { extends: "solo", stepOverrides: {} })).errors[0].message).toMatch(/extends "solo", its own id, but there is no built-in "solo" to extend/);
    const viaOther = resolve(local("feature", { extends: "feature-x", stepOverrides: {} }), local("feature-x", { extends: "feature", stepOverrides: {} }));
    expect(byId(viaOther, "feature")!.source).toBe("built-in");
    expect(viaOther.errors.map((e) => e.id).sort()).toEqual(["feature", "feature-x"]);
  });

  it("the ids of the service's own pipelines are refused", () => {
    for (const id of INTERNAL_PATTERN_IDS) {
      const r = resolve(local(id, { steps: reviewed }));
      expect(byId(r, id)).toBeUndefined();
      expect(r.errors[0]).toMatchObject({ id, effect: "skipped", message: expect.stringMatching(/the service owns/) });
    }
  });
});

describe("pattern rules", () => {
  it("F1: a step id that looks like an expansion is refused", () => {
    expect(resolve(local("xx", { steps: [{ ...oneStep[0], id: "S1-c2" }] })).errors[0].message).toMatch(/S1-c2: step ids ending in -c<n>, -i<n> or -r<k>-fix, -r<k>-review, -r<k>-checks are reserved/);
    expect(resolve(local("xx", { steps: [{ ...oneStep[0], id: "S1-i3" }] })).errors[0].message).toMatch(/reserved/);
  });

  it("F1: a step id that looks like a check round is refused (review L5); a plain id with -r stays allowed", () => {
    for (const id of ["C2-r1-checks", "C2-r12-review", "C2-r1-fix"]) expect(resolve(local("xx", { steps: [{ ...oneStep[0], id }] })).errors[0]?.message, id).toMatch(/reserved/);
    for (const id of ["S1-review", "C2-r1", "S1-rename"]) expect(resolve(local("xx", { steps: [{ ...oneStep[0], id }] })).errors, id).toEqual([]);
  });

  it("F3: best of N without experimental is refused; with experimental and a hypothesis it loads", () => {
    const bestOf: StepDef[] = [
      { ...oneStep[0], parallel: { count: 2, mode: "best-of" } },
      { id: "S2", purpose: "Choose", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
    ];
    const refused = resolve(local("two", { steps: bestOf }));
    expect(byId(refused, "two")).toBeUndefined();
    expect(refused.errors[0].message).toMatch(/S1 runs as best of 2, so the pattern must say "experimental": true/);
    const ok = resolve(local("two", { steps: bestOf, experimental: true, hypothesis: "two beat one" }));
    expect(ok.errors).toEqual([]);
    expect(byId(ok, "two")).toMatchObject({ experimental: true, audience: "user-only", flags: expect.objectContaining({ bestOf: true }) });
  });

  it("F4: a Checks step cannot be the one that chooses among candidates", () => {
    const steps: StepDef[] = [
      { ...oneStep[0], parallel: { count: 2, mode: "best-of" } },
      { id: "C1", purpose: "Checks", role: "checks", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings" } },
      { id: "S2", purpose: "Review", role: "code_reviewer", dependsOn: ["C1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
    ];
    expect(resolve(local("xx", { steps, experimental: true, hypothesis: "h" })).errors[0].message).toMatch(/C1 chooses among S1's candidates, so it cannot be a Checks step/);
  });

  it("F5: a file of yours for change or bugfix must stay standard and change code; otherwise the built-in is kept", () => {
    const unreviewed = resolve(local("change", { steps: oneStep }));
    expect(byId(unreviewed, "change")!.source).toBe("built-in");
    expect(unreviewed.errors[0]).toMatchObject({ id: "change", effect: "built-in kept", message: expect.stringMatching(/service creates fix tasks from "change", so it must be a standard pattern/) });
    const noCode = resolve(local("bugfix", { steps: [{ id: "S1", purpose: "Investigate", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "report", kind: "report" }] }] }));
    expect(byId(noCode, "bugfix")!.source).toBe("built-in");
    expect(noCode.errors[0].message).toMatch(/must produce a code change/);
    const paused = resolve(local("change", { extends: "change", stepOverrides: { S1: { gate: true } } }));
    // A variant of the built-in it replaces (step 1 review, finding 6) that pauses fails F5 like a full file would.
    expect(byId(paused, "change")!.source).toBe("built-in");
    expect(paused.errors[0]).toMatchObject({ id: "change", effect: "built-in kept", message: expect.stringMatching(/must be a standard pattern/) });
    const gated = resolve(local("change", { steps: builtIn("change").steps.map((s) => (s.id === "S1" ? { ...s, gate: true as const } : s)) }));
    expect(gated.errors[0].message).toMatch(/must be a standard pattern/);
    expect(byId(gated, "change")!.source).toBe("built-in");
  });

  it("checks.only is refused with the message about check commands", () => {
    const steps: StepDef[] = [...reviewed, { id: "C1", purpose: "Checks", role: "checks", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings", only: ["lint"] } }];
    expect(resolve(local("xx", { steps })).errors[0].message).toMatch(/C1\.checks\.only: check commands belong to each project; patterns run every configured check/);
  });
});

describe("effective review (step 1 review, finding 1)", () => {
  const checks = (id: string, after: string): StepDef => ({ id, purpose: "Checks", role: "checks", dependsOn: [after], inputs: [{ step: after, output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings" } });
  const variant = (over: Record<string, unknown>) => byId(resolve(local("quiet", { extends: "change", stepOverrides: over })), "quiet")!;

  it("a review that may be skipped (runIf) is not a review: the variant is user-only and the lead cannot choose it", () => {
    const p = variant({ S2: { runIf: [{ step: "C1", output: "checks" }] } });
    expect(p.flags.unreviewed).toBe(true);
    expect(p.audience).toBe("user-only");
    // The repair S3 loses its review too: the loop no longer returns through an unconditional one.
    expect(p.warnings).toEqual(["No independent code review: S1's code change is not read by a code reviewer that always runs (a review with runIf may be skipped); S3's code change is not read by a code reviewer that always runs."]);
    expect(eligible(p, "lead")).toBe(false);
    expect(eligible(p, "default")).toBe(false);
  });

  it("an unconditional coder step after the review whose change nobody reads, and code from a reviewer, lead or designer, are unreviewed", () => {
    const afterReview: StepDef[] = [...reviewed, { id: "S3", purpose: "Polish", role: "coder", dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "change", kind: "code-change" }] }];
    const p = byId(resolve(local("polish", { steps: afterReview })), "polish")!;
    expect(p.flags.unreviewed).toBe(true);
    expect(p.warnings).toContain("No independent code review: S3's code change is not read by a code reviewer that always runs.");
    for (const role of ["code_reviewer", "ux_reviewer", "lead", "designer"] as const) {
      const steps: StepDef[] = [...reviewed, { id: "S3", purpose: "Tweak", role, dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "change", kind: "code-change" }] }, { id: "S4", purpose: "Review again", role: "code_reviewer", dependsOn: ["S3"], inputs: [{ step: "S3", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] }];
      const q = byId(resolve(local("tweak", { steps })), "tweak")!;
      expect(q.flags.unreviewed, role).toBe(true);
      const word = role === "code_reviewer" ? "code reviewer" : role === "ux_reviewer" ? "UX reviewer" : role;
      expect(q.warnings.some((w) => w.includes(`S3 changes code as a ${word}; only coder steps may change code`)), role).toBe(true);
    }
  });

  it("a repair inside a loop is reviewed by the next iteration's unconditional review; one whose loop review has runIf is not", () => {
    const loop: StepDef[] = [oneStep[0], checks("C1", "S1"), { ...reviewed[1], dependsOn: ["S1", "C1"] }, { id: "S3", purpose: "Repair", role: "coder", dependsOn: ["S2"], inputs: [{ step: "S1", output: "change" }, { step: "S2", output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S2", output: "findings" }], iterate: { from: "C1", max: 3 } }];
    const good = resolve(local("loop", { steps: loop }));
    expect(good.errors).toEqual([]);
    expect(byId(good, "loop")).toMatchObject({ audience: "standard", flags: expect.objectContaining({ unreviewed: false }) });
    const skippable = loop.map((s) => (s.id === "S2" ? { ...s, runIf: [{ step: "C1", output: "checks" }] } : s));
    const worse = resolve(local("loop", { steps: skippable }));
    expect(worse.errors).toEqual([]);
    const bad = byId(worse, "loop")!;
    expect(bad.flags.unreviewed).toBe(true);
    expect(bad.warnings.some((w) => /S1's code change is not read by a code reviewer that always runs \(a review with runIf may be skipped\); S3's code change is not read/.test(w))).toBe(true);
    // The built-ins' repair steps all sit in such loops.
    for (const id of ["change", "change-lean", "feature", "bugfix", "change-best-of-two"]) expect(builtIn(id).flags.unreviewed, id).toBe(false);
  });

  it("a file of yours for change or bugfix that loses its effective review is refused and the built-in kept, so the service never uses it", () => {
    const r = resolve(local("change", { extends: "change", stepOverrides: { S2: { runIf: [{ step: "C1", output: "checks" }] } } }));
    expect(byId(r, "change")).toMatchObject({ source: "built-in", audience: "standard" });
    expect(r.errors).toEqual([expect.objectContaining({ id: "change", effect: "built-in kept", message: expect.stringMatching(/the service creates fix tasks from "change", so it must be a standard pattern/) })]);
  });

  it("steps 2–3 review, finding 3: the loop exemption needs max ≥ 2, the reviewer before the coder, the coder's change as the newest in the body and a runIf on the reviewer's findings; a reviewer must report review-findings", () => {
    const review = (id: string, after: string[], inputs: { step: string; output: string }[], kind: "review-findings" | "report" = "review-findings"): StepDef => ({ id, purpose: "Code review", role: "code_reviewer", dependsOn: after, inputs, outputs: [{ name: kind === "report" ? "notes" : "findings", kind }] });
    const repair = (id: string, after: string[], over: Partial<StepDef> = {}): StepDef => ({ id, purpose: "Repair", role: "coder", dependsOn: after, inputs: [{ step: "S1", output: "change" }, { step: "S2", output: "findings" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S2", output: "findings" }], ...over });
    const unreviewedOf = (name: string, steps: StepDef[]) => {
      const r = resolve(local(name, { steps }));
      expect(r.errors, name).toEqual([]);
      return byId(r, name)!;
    };
    // Repro (a): a loop that runs once never reviews the repair; the same shape with max 2 does.
    const once = unreviewedOf("once", [oneStep[0], review("S2", ["S1"], [{ step: "S1", output: "change" }]), repair("S3", ["S2"], { iterate: { from: "S2", max: 1 } })]);
    expect(once.flags.unreviewed).toBe(true);
    expect(once.warnings.some((w) => /S3's code change is not read by a code reviewer that always runs/.test(w))).toBe(true);
    const twice = unreviewedOf("twice", [oneStep[0], review("S2", ["S1"], [{ step: "S1", output: "change" }]), repair("S3", ["S2"], { iterate: { from: "S2", max: 2 } })]);
    expect(twice).toMatchObject({ audience: "standard", flags: expect.objectContaining({ unreviewed: false }) });
    // Repro (b): a reviewer that reports only a report is not a review. (In a loop, the graph rules already refuse a runIf on a report.)
    const reportOnly = unreviewedOf("report-only", [oneStep[0], review("S2", ["S1"], [{ step: "S1", output: "change" }], "report")]);
    expect(reportOnly.flags.unreviewed).toBe(true);
    expect(reportOnly.audience).toBe("user-only");
    expect(reportOnly.warnings.some((w) => /S1's code change is not read by a code reviewer that always runs/.test(w))).toBe(true);
    const reportThenFindings = unreviewedOf("report-then-findings", [oneStep[0], review("S2", ["S1"], [{ step: "S1", output: "change" }], "report"), review("S3", ["S2"], [{ step: "S1", output: "change" }])]);
    expect(reportThenFindings.flags.unreviewed).toBe(false); // S3 is the review; S2's report does not count either way
    // A repair that always runs (no runIf on the reviewer's findings) leaves its last change unreviewed.
    const always = unreviewedOf("always", [oneStep[0], review("S2", ["S1"], [{ step: "S1", output: "change" }]), repair("S3", ["S2"], { runIf: undefined, iterate: { from: "S2", max: 3 } })]);
    expect(always.flags.unreviewed).toBe(true);
    // The repair must be the newest change in the body: a later coder in the loop takes the next iteration's review instead.
    const notNewest = unreviewedOf("not-newest", [
      oneStep[0],
      review("S2", ["S1"], [{ step: "S1", output: "change" }]),
      repair("S3", ["S2"]),
      { id: "S4", purpose: "Polish", role: "coder", dependsOn: ["S3"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S2", output: "findings" }], iterate: { from: "S2", max: 3 } },
    ]);
    expect(notNewest.warnings.some((w) => /S3's code change is not read/.test(w))).toBe(true);
    expect(notNewest.warnings.some((w) => /S4's code change is not read/.test(w))).toBe(false);
    // The reviewer must come before the coder in the body: one after it is the direct case, which needs it to read that change.
    const after = unreviewedOf("after", [oneStep[0], { ...repair("S2", ["S1"], { inputs: [{ step: "S1", output: "change" }], runIf: undefined }) }, review("S3", ["S2"], [{ step: "S1", output: "change" }]), { id: "S4", purpose: "More", role: "coder", dependsOn: ["S3"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "change", kind: "code-change" }], runIf: [{ step: "S3", output: "findings" }], iterate: { from: "S3", max: 3 } }]);
    expect(after.warnings.some((w) => /S2's code change is not read/.test(w))).toBe(true); // S3 reads S1, not S2
    expect(after.warnings.some((w) => /S4's code change is not read/.test(w))).toBe(false); // the next iteration's S3 reads S4's change
    // The built-ins keep their audience.
    for (const p of builtInCatalog().patterns) expect([p.id, p.audience]).toEqual([p.id, p.experimental || p.flags.pausesForYou ? "user-only" : "standard"]);
    for (const id of ["change", "change-lean", "change-cross-review", "feature", "feature-design-gate", "bugfix", "change-best-of-two"]) expect(builtIn(id).flags.unreviewed, id).toBe(false);
  });
});

describe("flags and audience", () => {
  it("every built-in carries the flags and audience of the catalog table", () => {
    const expected: Record<string, Partial<Pattern["flags"]> & { audience: Pattern["audience"]; experimental?: true }> = {
      change: { audience: "standard" },
      "change-cross-review": { audience: "standard" },
      feature: { audience: "standard" },
      "feature-design-gate": { audience: "user-only", pausesForYou: true },
      bugfix: { audience: "standard" },
      investigation: { audience: "standard" },
      design: { audience: "standard" },
      goal: { audience: "standard", breaksDown: true },
      "goal-plan-gate": { audience: "user-only", pausesForYou: true, breaksDown: true },
      "change-best-of-two": { audience: "user-only", experimental: true, bestOf: true, needsProviders: ["claude", "codex"] },
      "change-lean": { audience: "user-only", experimental: true },
    };
    for (const [id, want] of Object.entries(expected)) {
      const p = builtIn(id);
      const { audience, experimental, ...flags } = want;
      expect(p.audience, id).toBe(audience);
      expect(p.experimental, id).toBe(experimental);
      expect(p.flags, id).toEqual({ breaksDown: false, pausesForYou: false, unreviewed: false, bestOf: false, needsProviders: [], ...flags });
      if (experimental) expect(p.hypothesis!.length, id).toBeGreaterThan(20);
      expect(p.warnings, id).toEqual([]);
    }
    const unreviewed = byId(resolve(local("quick", { steps: oneStep })), "quick")!;
    expect(unreviewed).toMatchObject({ audience: "user-only", flags: expect.objectContaining({ unreviewed: true }) });
    expect(unreviewed.warnings.some((w) => /No independent code review/.test(w))).toBe(true);
  });

  it("eligibility: the lead, the project default and breakdown items get standard patterns only; children never break down", () => {
    const ids = (who: "lead" | "child" | "default") =>
      builtInCatalog()
        .patterns.filter((p) => eligible(p, who))
        .map((p) => p.id);
    expect(ids("lead")).toEqual(["change", "change-cross-review", "feature", "bugfix", "investigation", "design", "goal"]);
    expect(ids("default")).toEqual(ids("lead"));
    expect(ids("child")).toEqual(["change", "change-cross-review", "feature", "bugfix", "investigation", "design"]);
    expect(eligible(builtIn("change-best-of-two"), "lead")).toBe(false);
    expect(eligible(builtIn("feature-design-gate"), "lead")).toBe(false);
    // A standard file of yours is the lead's to use; the experimental flag keeps one of yours away from it.
    const mine = resolve(local("mine", { steps: builtIn("change").steps }), local("exp", { steps: builtIn("change").steps, experimental: true, hypothesis: "h" }));
    expect(eligible(byId(mine, "mine")!, "lead")).toBe(true);
    expect(eligible(byId(mine, "exp")!, "lead")).toBe(false);
  });
});

describe("hashes", () => {
  it("the pattern hash follows what runs: stable across key order and whitespace, changed by a purpose, not by a description", () => {
    const a = builtIn("change");
    const reordered = a.steps.map((s) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(s).reverse()))) as StepDef);
    expect(patternHash(reordered)).toBe(a.hash);
    expect(patternHash(a.steps.map((s) => (s.id === "S1" ? { ...s, purpose: "Implement carefully" } : s)))).not.toBe(a.hash);
    const described = byId(resolve(local("change", { steps: a.steps, description: "Another description" })), "change")!;
    expect(described.hash).toBe(a.hash);
    expect(described.chain[0].fileHash).not.toBe(a.chain[0].fileHash);
  });

  it("each chain fileHash changes when any field of that file changes, and not with key order", () => {
    const file = BUILT_IN_FILES.find((f) => f.raw.id === "change")!.raw;
    const same = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(file).reverse()))) as RawPattern;
    expect(fileHash(same)).toBe(fileHash(file));
    expect(fileHash({ ...file, order: 11 })).not.toBe(fileHash(file));
    expect(fileHash({ ...file, $comment: "edited" })).not.toBe(fileHash(file));
    const cross = builtIn("change-cross-review");
    expect(cross.chain[1].fileHash).toBe(builtIn("change").chain[0].fileHash);
    // A variant's own hash of what runs differs from its base's.
    expect(cross.hash).not.toBe(builtIn("change").hash);
  });
});

describe("summaries", () => {
  it("patternSummary names every step with its markers", () => {
    expect(patternSummary(builtIn("change").steps)).toBe(
      // ORC-017: the verify purpose is a plain description; its instruction to agents moved to the lead's role brief (server/envelope.ts).
      "S1 Implement → C1 Run the project's checks (run by the service) → S2 Code review → S3 Repair review findings and failing checks (if findings, repeats) → C2 Final checks (run by the service) → S4 Verify and integrate",
    );
    expect(patternSummary(builtIn("goal-plan-gate").steps)).toContain("S1 Plan the goal and break it into independent tasks (breakdown, pauses for you)");
    expect(patternSummary(builtIn("change-best-of-two").steps)).toContain("S1 Implement (parallel ×2 best of)");
    expect(patternSummary(builtIn("change-cross-review").steps)).toContain("S2 Code review (reviewed by the other provider)");
  });
});
