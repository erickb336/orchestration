// Rule results (ORC-029 pass 5, "Evidence of what the factory built"): each rule and example of a flow or a contract
// in the blueprint, beside the result of the acceptance tests that carry its tag. The results come from the JUnit
// reports of the checks of landed work (server/testReport.ts reads them into `CheckRunRecord.tests`). Pure, from
// state only: the app's "Design and reality" and the lead's brief read the same answer.
//
// The tag. An acceptance test names what it proves with "[<item id> <rule id>]", for example "[bi-12 R3]": the
// blueprint item's id and the id of the rule or example in its rules.json. Item ids are stable across revisions and
// never removed, and a rules.json gives each id once, so a tag names one line of one item. Go writes a subtest's
// spaces as "_", so "[bi-12_R3]" is the same tag.
//
// Where a result comes from, for each tag: the landed task that landed last whose final change has a check run that
// read a test report, that ran after this line's current text came into the blueprint, and that has a test with the
// tag. All its tests with the tag decide: a failure or an error makes "failed" (with its message); else a skipped test
// makes "skipped"; else "passed". No such run: "no-test". "skipped" and "no-test" are never a pass.
//
// A report of more than 400 tests is cut (server/testReport.ts): failing tagged tests are kept first, and the report
// lists the tags that lost a test (`droppedTags`). In that run a tag that lost a test is "failed" when a kept test with
// it failed, else "no-test" with the reason: a left-out test may have failed or been skipped, so it is never a pass.
// The run still decides for that tag, so an older run's result does not stand in for it. `truncated` alone is not
// used: it is also true when only untagged tests were left out, and then every tag's result is whole.
//
// Known limit: a landed task does not hold the tests of a task that landed while it was being built, so the newest
// run that has the tag decides, not the newest run. A later change that deletes a test therefore leaves the earlier
// result standing; the code review judges a deleted acceptance test.
//
// An imported repository (ORC-032, 2.4). Its own tests carry no tags, and the import may not rename them, so a rule
// may name the tests that prove it (`FlowRule.tests`, by id "suite::name"): such a test proves the line as a tag
// would. The import's baseline run is one more run, older than any landed one, with the cases its rules name; it
// ran before the baseline Lock in, and it counts at the time of that Lock in, which put the lines into force.

import { sameSha } from "../checks";
import * as M from "../model";
import type { Artifact, State, Task, TestCaseResult, TestReport } from "../types";
import { blueprintItems, ruleTag } from "./blueprint";
import { testId } from "./import";
import { versionsOf } from "./studio";
import type { BlueprintItem, StudioArtifact, StudioArtifactKind, VariantRules } from "./types";

// ---------- tags ----------

const TAG_RE = /\[(bi-\d{1,9})[ _]([A-Za-z0-9_-]{1,20})\]/g;

export { ruleTag };

/** Every tag in a test's name or suite, written as `ruleTag` writes it. */
export function tagsIn(text: string): string[] {
  return [...text.matchAll(TAG_RE)].map((m) => ruleTag(m[1], m[2]));
}

/** Does this test carry the tag, in its name or its suite (a describe block's title)? */
export const carriesTag = (c: Pick<TestCaseResult, "name" | "suite">, tag: string) => tagsIn(c.name).includes(tag) || tagsIn(c.suite).includes(tag);

// ---------- an item's rules and examples ----------

/**
 * Kinds that only their rules and examples check: a flow or a contract with none is not verified ("no-rules",
 * itemStatus.ts). Any part may carry rules (ORC-032 D1), and tests prove the rules of every part that has them.
 */
export const TESTED_KINDS: readonly StudioArtifactKind[] = ["flow", "contract"];

/** One rule or example of a blueprint item, with its tag, and the existing tests a rule names (ORC-032). */
export interface RuleLine {
  kind: "rule" | "example";
  id: string;
  text: string;
  tag: string;
  named?: string[];
}

/** Does this test prove the line: it carries the line's tag, or the line names it. */
const proves = (c: TestCaseResult, line: RuleLine) => carriesTag(c, line.tag) || !!line.named?.includes(testId(c));

/** The rules of the item's variant (the one approved, or the only one), from the artifact version the item names. */
function itemRules(s: State, item: BlueprintItem): VariantRules | undefined {
  const a: StudioArtifact | undefined = versionsOf(s, item.artifactId).find((x) => x.version === item.version);
  if (!a?.rules?.length) return undefined;
  const variant = item.variant ?? a.variants[0]?.id;
  return a.rules.find((r) => r.variant === variant);
}

/** The rules, then the examples, of a blueprint item, each with its tag. Empty for an item with no rules.json. */
export function itemRuleLines(s: State, item: BlueprintItem): RuleLine[] {
  const r = itemRules(s, item);
  if (!r) return [];
  return [
    ...r.rules.map((x) => ({ kind: "rule" as const, id: x.id, text: x.text, ...(x.tests?.length ? { named: x.tests } : {}) })),
    ...r.examples.map((x) => ({ kind: "example" as const, id: x.id, text: x.text })),
  ].map((l) => ({ ...l, tag: ruleTag(item.id, l.id) }));
}

/**
 * The items in force that tests prove (any part with rules or examples, ORC-032 D1), with their lines; with `ids`,
 * only those items (a task spec's `blueprintRefs`), in that order. A dropped item has no rules to prove (pass 5).
 */
export function testedItems(s: State, ids?: readonly string[]): { item: BlueprintItem; lines: RuleLine[] }[] {
  const items = blueprintItems(s).filter((i) => i.status !== "dropped");
  const chosen = ids ? ids.map((id) => items.find((i) => i.id === id)).filter((i): i is BlueprintItem => !!i) : items;
  return chosen.map((item) => ({ item, lines: itemRuleLines(s, item) })).filter((x) => x.lines.length > 0);
}

/**
 * Since when the blueprint has held this line with this text: the time of the oldest revision in the unbroken run of
 * revisions, up to the current one, whose version of the item has it. A test run before then proves an older text.
 */
function lineSince(s: State, itemId: string, line: RuleLine): string | undefined {
  let since: string | undefined;
  for (let i = s.blueprint.revisions.length - 1; i >= 0; i--) {
    const rev = s.blueprint.revisions[i];
    const it = rev.items.find((x) => x.id === itemId);
    if (!it || !itemRuleLines(s, it).some((l) => l.kind === line.kind && l.id === line.id && l.text === line.text)) break;
    since = rev.at;
  }
  return since;
}

// ---------- the checks of landed work ----------

/** A landed task's check run on its final change that read a test report. */
export interface LandedTestRun {
  taskId: string;
  /** The final change's commit, as the check run recorded it. */
  sha: string;
  landedAt: string;
  /** The check-results artifact. */
  artifact: Artifact;
  report: Extract<TestReport, { status: "read" }>;
  simulated: boolean;
}

/** The commit a landed task's checks are judged on: the pull request's change, else the task's final change (as recordLanded does). */
export function landedChangeSha(s: State, t: Task): string | undefined {
  return t.integration?.pr?.changeSha ?? M.finalChange(s, t)?.ref?.split(" ")[0];
}

/**
 * For each landed task, the newest service check run on exactly its final change that read a test report (a person's
 * edit of a check result is not a run). Newest landed first.
 */
export function landedTestRuns(s: State): LandedTestRun[] {
  const out: LandedTestRun[] = [];
  for (const t of s.tasks) {
    const landed = t.integration?.landed;
    const sha = landed && landedChangeSha(s, t);
    if (!landed || !sha) continue;
    let best: Artifact | undefined;
    for (const art of s.artifacts) {
      if (art.kind !== "check-results" || art.author === "user" || !art.checkRun || art.checkRun.tests?.status !== "read" || !sameSha(art.checkRun.sha, sha)) continue;
      if (!best || art.createdAt > best.createdAt) best = art;
    }
    if (!best) continue;
    const run = best.checkRun!;
    out.push({ taskId: t.id, sha: run.sha, landedAt: landed.at, artifact: best, report: run.tests as LandedTestRun["report"], simulated: !!run.simulated || !!landed.simulated });
  }
  return out.sort((a, b) => b.landedAt.localeCompare(a.landedAt) || b.artifact.createdAt.localeCompare(a.artifact.createdAt));
}

// ---------- results ----------

export type RuleStatus = "passed" | "failed" | "skipped" | "no-test";

/** Where a result comes from: landed work's checks, or (ORC-032) the import's baseline run at its commit. */
export type ResultSource =
  | { taskId: string; sha: string; landedAt: string; artifactId: string; simulated?: true; importId?: never }
  | { importId: string; sha: string; at: string; simulated?: true; taskId?: never };

export interface RuleResult extends RuleLine {
  status: RuleStatus;
  /** The tests that prove the line in the run the result comes from; 0 for "no-test". */
  tests: number;
  /** failed: the first failing test and its message; skipped: the first skipped test and its reason; no-test: why there is none. */
  message?: string;
  /** The run the result comes from. Absent for "no-test", except when that run left out a test with the tag. */
  from?: ResultSource;
}

export interface ItemRuleResults {
  itemId: string;
  title: string;
  kind: StudioArtifactKind;
  artifactId: string;
  version: number;
  variant?: string;
  results: RuleResult[];
  counts: Record<RuleStatus, number>;
  /** Every rule and example has a passing test. "skipped" and "no-test" never count as a pass. */
  allPass: boolean;
}

/** A run whose tests can prove a line: a landed task's checks, or the import's baseline run. `at`: when it counts. */
interface ProvingRun {
  from: ResultSource;
  at: string;
  report: Pick<Extract<TestReport, { status: "read" }>, "cases" | "counts" | "droppedTags">;
}

const landedRun = (r: LandedTestRun): ProvingRun => ({
  from: { taskId: r.taskId, sha: r.sha, landedAt: r.landedAt, artifactId: r.artifact.id, ...(r.simulated ? { simulated: true as const } : {}) },
  at: r.artifact.createdAt,
  report: r.report,
});

/**
 * The import's baseline run (ORC-032), once the baseline is locked in and its tests were read: the cases its rules
 * name, counted at the time of the Lock in, which put the lines into force.
 */
function baselineRun(s: State): ProvingRun | undefined {
  const imp = s.studio.import;
  if (!imp?.lockedInAt || imp.checks.status !== "read" || !imp.reading) return undefined;
  return { from: { importId: imp.id, sha: imp.commit, at: imp.lockedInAt, ...(imp.checks.simulated ? { simulated: true as const } : {}) }, at: imp.lockedInAt, report: { cases: imp.reading.cases, counts: imp.checks.counts } };
}

/** Every run that can prove a line, newest first: landed work's checks, then the import's baseline run. */
function provingRuns(s: State): ProvingRun[] {
  const base = baselineRun(s);
  return [...landedTestRuns(s).map(landedRun), ...(base ? [base] : [])];
}

const MESSAGE_CAP = 300;
const clipped = (t: string) => (t.length > MESSAGE_CAP ? `${t.slice(0, MESSAGE_CAP - 1)}…` : t);

/** The result of one line from one run's tests that prove it (at least one). */
function fromCases(line: RuleLine, run: ProvingRun, cases: TestCaseResult[]): RuleResult {
  const from = run.from;
  const bad = cases.find((c) => c.status === "failed" || c.status === "error");
  if (bad) return { ...line, status: "failed", tests: cases.length, message: clipped(`${bad.name}: ${bad.message || (bad.status === "error" ? "the test stopped with an error" : "the test failed")}`), from };
  const skipped = cases.find((c) => c.status === "skipped");
  if (skipped) return { ...line, status: "skipped", tests: cases.length, message: clipped(`${skipped.name}: ${skipped.message || "skipped"}`), from };
  return { ...line, status: "passed", tests: cases.length, from };
}

/** Did this run's report leave out a test with the tag (a report of more than 400 tests)? */
function leftOut(run: ProvingRun, tag: string): boolean {
  const d = run.report.droppedTags;
  return d === "unlisted" || !!d?.includes(tag);
}

/** The result of a line whose tag lost a test in this run: failed when a kept test failed, else not known. */
function cutFrom(line: RuleLine, run: ProvingRun, cases: TestCaseResult[]): RuleResult {
  if (cases.some((c) => c.status === "failed" || c.status === "error")) return fromCases(line, run, cases);
  const total = Object.values(run.report.counts).reduce((a, b) => a + b, 0);
  return { ...line, status: "no-test", tests: 0, message: `The newest checks with ${line.tag} wrote ${total} tests, more than the service keeps, and left out some with this tag: the result is not known.`, from: run.from };
}

/**
 * Why a line has no test: in an imported project, the import's tests did not run, or neither they nor landed checks
 * prove it; else no report was ever read, its tests ran before its current text, or no test carries its tag.
 */
function noTest(s: State, line: RuleLine, runs: ProvingRun[]): RuleResult {
  const imp = s.studio.import?.lockedInAt ? s.studio.import : undefined;
  const landed = runs.filter((r) => r.from.taskId !== undefined);
  const message =
    imp && imp.checks.status === "not-run" && !landed.length
      ? `The import's tests did not run: ${imp.checks.reason}.`
      : landed.some((r) => r.report.cases.some((c) => carriesTag(c, line.tag)))
        ? `The tests that carry ${line.tag} ran before this text was approved, and no later landed checks have one.`
        : imp
          ? `No test proves it yet: the import's tests name none, and no landed checks carry ${line.tag}.`
          : !runs.length
            ? s.project.checks.testReport
              ? "No landed work has a test report yet."
              : "The check settings name no test report, so no test result is read (Settings → Checks)."
            : `No test in the checks of landed work carries ${line.tag}.`;
  return { ...line, status: "no-test", tests: 0, message };
}

function resultsFor(s: State, item: BlueprintItem, lines: RuleLine[], runs: ProvingRun[]): ItemRuleResults {
  const results = lines.map((line) => {
    const since = lineSince(s, item.id, line) ?? "";
    for (const run of runs) {
      if (run.at < since) continue;
      const cases = run.report.cases.filter((c) => proves(c, line));
      if (leftOut(run, line.tag)) return cutFrom(line, run, cases);
      if (cases.length) return fromCases(line, run, cases);
    }
    return noTest(s, line, runs);
  });
  const counts: Record<RuleStatus, number> = { passed: 0, failed: 0, skipped: 0, "no-test": 0 };
  for (const r of results) counts[r.status]++;
  return {
    itemId: item.id,
    title: item.title,
    kind: item.kind,
    artifactId: item.artifactId,
    version: item.version,
    ...(item.variant !== undefined ? { variant: item.variant } : {}),
    results,
    counts,
    allPass: results.length > 0 && counts.passed === results.length,
  };
}

/** The rule results of one blueprint item; undefined when it is not in the blueprint or has no rules. */
export function ruleResults(s: State, itemId: string): ItemRuleResults | undefined {
  const [x] = testedItems(s, [itemId]);
  return x && resultsFor(s, x.item, x.lines, provingRuns(s));
}

/** The rule results of every part with rules in the current blueprint, in the blueprint's order. */
export function blueprintRuleResults(s: State): ItemRuleResults[] {
  const runs = provingRuns(s);
  return testedItems(s).map((x) => resultsFor(s, x.item, x.lines, runs));
}
