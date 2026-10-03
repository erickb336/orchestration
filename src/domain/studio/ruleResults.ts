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

import { sameSha } from "../checks";
import * as M from "../model";
import type { Artifact, State, Task, TestCaseResult, TestReport } from "../types";
import { blueprintItems, ruleTag } from "./blueprint";
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

/** Kinds whose rules and examples are proved by tests. */
export const TESTED_KINDS: readonly StudioArtifactKind[] = ["flow", "contract"];

/** One rule or example of a blueprint item, with its tag. */
export interface RuleLine {
  kind: "rule" | "example";
  id: string;
  text: string;
  tag: string;
}

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
  return [...r.rules.map((x) => ({ kind: "rule" as const, id: x.id, text: x.text })), ...r.examples.map((x) => ({ kind: "example" as const, id: x.id, text: x.text }))].map((l) => ({ ...l, tag: ruleTag(item.id, l.id) }));
}

/**
 * The items in force that tests prove (flows and contracts with rules), with their lines; with `ids`, only those
 * items (a task spec's `blueprintRefs`), in that order. A dropped item has no rules to prove (pass 5).
 */
export function testedItems(s: State, ids?: readonly string[]): { item: BlueprintItem; lines: RuleLine[] }[] {
  const items = blueprintItems(s).filter((i) => i.status !== "dropped");
  const chosen = ids ? ids.map((id) => items.find((i) => i.id === id)).filter((i): i is BlueprintItem => !!i) : items;
  return chosen.filter((item) => TESTED_KINDS.includes(item.kind)).map((item) => ({ item, lines: itemRuleLines(s, item) })).filter((x) => x.lines.length > 0);
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

export interface RuleResult extends RuleLine {
  status: RuleStatus;
  /** The tests with the tag in the run the result comes from; 0 for "no-test". */
  tests: number;
  /** failed: the first failing test and its message; skipped: the first skipped test and its reason; no-test: why there is none. */
  message?: string;
  /** The landed work the result comes from. Absent for "no-test", except when that run left out a test with the tag. */
  from?: { taskId: string; sha: string; landedAt: string; artifactId: string; simulated?: true };
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

const MESSAGE_CAP = 300;
const clipped = (t: string) => (t.length > MESSAGE_CAP ? `${t.slice(0, MESSAGE_CAP - 1)}…` : t);

/** The result of one line from one run's tests that carry its tag (at least one). */
function fromCases(line: RuleLine, run: LandedTestRun, cases: TestCaseResult[]): RuleResult {
  const from = { taskId: run.taskId, sha: run.sha, landedAt: run.landedAt, artifactId: run.artifact.id, ...(run.simulated ? { simulated: true as const } : {}) };
  const bad = cases.find((c) => c.status === "failed" || c.status === "error");
  if (bad) return { ...line, status: "failed", tests: cases.length, message: clipped(`${bad.name}: ${bad.message || (bad.status === "error" ? "the test stopped with an error" : "the test failed")}`), from };
  const skipped = cases.find((c) => c.status === "skipped");
  if (skipped) return { ...line, status: "skipped", tests: cases.length, message: clipped(`${skipped.name}: ${skipped.message || "skipped"}`), from };
  return { ...line, status: "passed", tests: cases.length, from };
}

/** Did this run's report leave out a test with the tag (a report of more than 400 tests)? */
function leftOut(run: LandedTestRun, tag: string): boolean {
  const d = run.report.droppedTags;
  return d === "unlisted" || !!d?.includes(tag);
}

/** The result of a line whose tag lost a test in this run: failed when a kept test failed, else not known. */
function cutFrom(line: RuleLine, run: LandedTestRun, cases: TestCaseResult[]): RuleResult {
  if (cases.some((c) => c.status === "failed" || c.status === "error")) return fromCases(line, run, cases);
  const total = Object.values(run.report.counts).reduce((a, b) => a + b, 0);
  const from = { taskId: run.taskId, sha: run.sha, landedAt: run.landedAt, artifactId: run.artifact.id, ...(run.simulated ? { simulated: true as const } : {}) };
  return { ...line, status: "no-test", tests: 0, message: `The newest checks with ${line.tag} wrote ${total} tests, more than the service keeps, and left out some with this tag: the result is not known.`, from };
}

/** Why a line has no test: no report was ever read, its tests ran before its current text, or no test carries its tag. */
function noTest(s: State, line: RuleLine, runs: LandedTestRun[]): RuleResult {
  const message = !runs.length
    ? s.project.checks.testReport
      ? "No landed work has a test report yet."
      : "The check settings name no test report, so no test result is read (Settings → Checks)."
    : runs.some((r) => r.report.cases.some((c) => carriesTag(c, line.tag)))
      ? `The tests that carry ${line.tag} ran before this text was approved, and no later landed checks have one.`
      : `No test in the checks of landed work carries ${line.tag}.`;
  return { ...line, status: "no-test", tests: 0, message };
}

function resultsFor(s: State, item: BlueprintItem, lines: RuleLine[], runs: LandedTestRun[]): ItemRuleResults {
  const results = lines.map((line) => {
    const since = lineSince(s, item.id, line) ?? "";
    for (const run of runs) {
      if (run.artifact.createdAt < since) continue;
      const cases = run.report.cases.filter((c) => carriesTag(c, line.tag));
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
  return x && resultsFor(s, x.item, x.lines, landedTestRuns(s));
}

/** The rule results of every flow and contract with rules in the current blueprint, in the blueprint's order. */
export function blueprintRuleResults(s: State): ItemRuleResults[] {
  const runs = landedTestRuns(s);
  return testedItems(s).map((x) => resultsFor(s, x.item, x.lines, runs));
}
