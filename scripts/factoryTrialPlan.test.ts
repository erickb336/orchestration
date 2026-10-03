// The factory trial's judgments (scripts/factoryTrialPlan.mjs): R3's todo test, as Node's JUnit reporter writes it,
// reads "failed" through the service's own parser; the rule results and item statuses follow the plan or say how not.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carriesTag } from "../src/domain/studio/ruleResults";
import type { ItemRuleResults, RuleResult } from "../src/domain/studio/ruleResults";
import type { ItemFactoryView } from "../src/domain/studio/itemStatus";
import { parseJUnit } from "../server/testReport";
import { r3FailsOnPurpose, renderR3Test, rulesAsPlanned, runLimitUsd, statusesAsPlanned } from "./factoryTrialPlan.mjs";

/** A real report of Node 22's built-in JUnit reporter: R1 passes, R3 is a failing todo test, E1 is skipped. */
const NODE_JUNIT = readFileSync(join(import.meta.dirname, "..", "server", "fixtures", "junit", "node-test.xml"), "utf8");
const clean = (t: string, cap: number) => t.slice(0, cap);

describe("R3 fails on purpose", () => {
  it("a failing todo test (which does not fail Node's run) reads failed through the service's parser", () => {
    const parsed = parseJUnit(NODE_JUNIT, clean);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(r3FailsOnPurpose({ exitCode: 0, cases: parsed.cases, tag: "[bi-3 R3]", carriesTag })).toMatchObject({ ok: true });
  });

  it("is not on purpose when the run failed, when R3 passed or was only skipped, or when another test failed", () => {
    const parsed = parseJUnit(NODE_JUNIT, clean);
    if (!parsed.ok) throw new Error(parsed.reason);
    const judge = (exitCode: number, cases = parsed.cases) => r3FailsOnPurpose({ exitCode, cases, tag: "[bi-3 R3]", carriesTag }).ok;
    expect(judge(1)).toBe(false);
    // A todo test that passes: Node writes only <skipped type="todo">, which is never a pass, and not the planned failure either.
    expect(judge(0, parsed.cases.map((c) => (c.name.includes("R3") ? { ...c, status: "skipped" as const } : c)))).toBe(false);
    expect(judge(0, parsed.cases.map((c) => ({ ...c, status: "failed" as const })))).toBe(false);
    expect(judge(0, parsed.cases.filter((c) => !c.name.includes("R3")))).toBe(false);
  });

  it("the fixture's template becomes the test with the flow's tag", () => {
    const template = readFileSync(join(import.meta.dirname, "fixtures", "factory-trial", "r3.test.js"), "utf8");
    const test = renderR3Test(template, "bi-12");
    expect(test).toContain('test("[bi-12 R3] ');
    expect(test).toContain("todo:");
    expect(test).not.toContain("{{");
    expect(() => renderR3Test(template, "R3")).toThrow(/not a blueprint item id/);
  });
});

const line = (id: string, status: RuleResult["status"], taskId = "WT-1"): RuleResult => ({ kind: id.startsWith("E") ? "example" : "rule", id, text: `${id} text`, tag: `[bi-3 ${id}]`, status, tests: status === "no-test" ? 0 : 1, ...(status === "no-test" ? {} : { from: { taskId, sha: "abc", landedAt: "t", artifactId: "a-1" } }) });
const results = (lines: RuleResult[]): ItemRuleResults => ({ itemId: "bi-3", title: "Splitting a bill", kind: "flow", artifactId: "sa-3", version: 1, results: lines, counts: { passed: 0, failed: 0, skipped: 0, "no-test": 0 }, allPass: false });

describe("the plan's judgments", () => {
  it("rule results: R1, R2 and E1 pass and R3 fails, all from the task's own landed work", () => {
    expect(rulesAsPlanned(results([line("R1", "passed"), line("R2", "passed"), line("R3", "failed"), line("E1", "passed")]), "WT-1").ok).toBe(true);
    // A missing test, a passing R3, a result from other work, and no results at all each say why.
    const noTest = rulesAsPlanned(results([line("R1", "passed"), line("R2", "no-test"), line("R3", "failed"), line("E1", "passed")]), "WT-1");
    expect(noTest).toMatchObject({ ok: false, detail: { notAsPlanned: ["R2 is no-test, planned passed"] } });
    expect(rulesAsPlanned(results([line("R1", "passed"), line("R2", "passed"), line("R3", "passed"), line("E1", "passed")]), "WT-1").ok).toBe(false);
    expect(rulesAsPlanned(results([line("R1", "passed", "WT-9"), line("R2", "passed"), line("R3", "failed"), line("E1", "passed")]), "WT-1")).toMatchObject({ ok: false, detail: { fromOtherWork: ["R1"] } });
    expect(rulesAsPlanned(undefined, "WT-1").ok).toBe(false);
  });

  it("item statuses: the screen and the CLI built and verified, the flow failing a check", () => {
    const view = (id: string, kind: string, status: string) => ({ item: { id, kind }, status }) as unknown as ItemFactoryView;
    const ids = ["bi-1", "bi-2", "bi-3"];
    expect(statusesAsPlanned([view("bi-1", "screen", "built-and-verified"), view("bi-2", "terminal-demo", "built-and-verified"), view("bi-3", "flow", "fails-a-check")], ids).ok).toBe(true);
    const notYet = statusesAsPlanned([view("bi-1", "screen", "being-built"), view("bi-2", "terminal-demo", "built-and-verified"), view("bi-3", "flow", "fails-a-check")], ids);
    expect(notYet).toEqual({ ok: false, detail: ["bi-1 screen: being-built (planned built-and-verified)", "bi-2 terminal-demo: built-and-verified", "bi-3 flow: fails-a-check"] });
    expect(statusesAsPlanned([undefined], ["bi-1"]).ok).toBe(false);
  });

  it("each run's limit is a fifth of the cap, at most $0.50, so three reviews at once leave room under it", () => {
    expect(runLimitUsd(2)).toBe(0.4);
    expect(runLimitUsd(5)).toBe(0.5);
    expect(runLimitUsd(1)).toBe(0.2);
    expect(3 * runLimitUsd(2)).toBeLessThan(2);
  });
});
