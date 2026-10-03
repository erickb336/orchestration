// ORC-029 pass 5: each rule and example of an approved flow, beside the result of the tests that carry its tag, from
// the JUnit reports of the checks of landed work. Tags map to rules; several tests for one tag must all pass; "No test"
// and "skipped" are never a pass; the newest landed run that has a tag decides; only landed work, on its own change,
// counts; a test that ran before a rule's text changed proves the older text.

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { buildSeed } from "../seed";
import { DESIGNER, addScreen, lockInAsOwner, openRound, peAgrees, run, sha } from "../testing/studio";
import { reviewedChange } from "../testing/reviewed";
import type { State, TestCaseResult, TestReport } from "../types";
import * as R from "./ruleResults";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));

const RULES = [
  { id: "R1", text: "When a friend opens the link, the app shall show the trip and a Join button." },
  { id: "R2", text: "When a friend joins, the app shall add them to the list of who is in." },
  { id: "R4", text: "If the link has expired, then the app shall ask the friend to get a new link." },
  { id: "R5", text: "The app shall never show other trips to a friend who joins by link." },
];
const EXAMPLES = [{ id: "E1", text: "Given a full trip, when a friend opens the link, then the page says the trip is full." }];

/** The Join flow, with its rules, approved and locked in (`artifactId`: a new version of it, in a new round). */
function approvedFlow(s: State, sec: number, rules = RULES, artifactId?: string): { s: State; itemId: string; artifactId: string } {
  const r = openRound(artifactId ? run(s, "closeRound", { round: s.studio.rounds.at(-1)!.n }, at(sec)).state : s, "flows", at(sec));
  const a = addScreen(r.state, r.n, at(sec + 1), {
    kind: "flow",
    title: "Join flow",
    variants: [{ id: "A", label: "Join by link", entry: "join/flow.md" }],
    files: [
      { path: "join/flow.md", sha256: sha("b") },
      { path: "join/rules.json", sha256: sha("c") },
    ],
    devices: [],
    madeBy: DESIGNER,
    rules: [{ variant: "A", path: "join/rules.json", rules, examples: EXAMPLES }],
    ...(artifactId ? { artifactId } : {}),
  });
  const agreed = peAgrees(a.state, a.id, a.version, [], at(sec + 2));
  const approved = lockInAsOwner(run(agreed, "approveArtifact", { artifactId: a.id, version: a.version }, at(sec + 3)).state, at(sec + 3));
  const item = approved.blueprint.revisions.at(-1)!.items.find((i) => i.artifactId === a.id)!;
  return { s: approved, itemId: item.id, artifactId: a.id };
}

const report = (cases: [string, TestCaseResult["status"], string?][]): TestReport => {
  const counts = { passed: 0, failed: 0, skipped: 0, error: 0 };
  for (const [, st] of cases) counts[st]++;
  return { status: "read", path: "reports/junit.xml", cases: cases.map(([name, status, message]) => ({ name, suite: "tests/join.test.ts", status, ...(message ? { message } : {}) })), counts, truncated: false };
};

/** The commit of the n-th task's final change: "01" repeated, "02" repeated, … */
const shaOf = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

/**
 * A new task that landed at `sec`: its final change is the n-th commit (the Change flow's fixture), and a service check
 * run on exactly that change, at `checkSec` (default 5 s before), read `tests`. `landed: false` leaves it integrated,
 * not landed. The task's id is the state's newest task.
 */
function landed(s0: State, sec: number, tests: TestReport | undefined, o: { checkSha?: string; checkSec?: number; landed?: boolean; author?: "user"; simulated?: boolean } = {}): State {
  const c = run<{ newId: string }>(s0, "createTask", { title: `Work ${sec}`, area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at(sec - 30));
  const taskId = c.result.newId;
  const changeSha = shaOf(c.state.tasks.length);
  const s = reviewedChange(c.state, taskId, changeSha, at(sec - 20));
  const t = s.tasks.find((x) => x.id === taskId)!;
  t.lifecycle = "done";
  t.integration = {
    status: "integrated",
    at: at(sec),
    sha: "f".repeat(40),
    ...(o.landed === false ? {} : { landed: { at: at(sec), via: "local" as const, target: "main", commit: "f".repeat(40), by: "app" as const, flags: [], status: "unreviewed" as const, notes: [], followUps: [], ...(o.simulated ? { simulated: true } : {}) } }),
  };
  s.artifacts.push({
    id: `chk-${taskId}-${sec}`,
    taskId,
    stepId: "C2",
    attemptId: `fx-check-${taskId}`,
    name: "final",
    kind: "check-results",
    version: 1,
    summary: "checks",
    createdAt: at(o.checkSec ?? sec - 5),
    ...(o.author ? { author: o.author } : {}),
    checkRun: { sha: o.checkSha ?? changeSha, configRev: 1, sandbox: "codex", touchedInputs: [], results: [], durationMs: 1, ...(tests ? { tests } : {}) },
  });
  return s;
}

const newest = (s: State) => s.tasks.at(-1)!.id;
const statuses = (s: State, itemId: string) => Object.fromEntries(R.ruleResults(s, itemId)!.results.map((r) => [r.id, r.status]));

describe("tags", () => {
  it("a tag is the item's id and the line's id in brackets; Go's '_' for the space is the same tag; anything else is not a tag", () => {
    expect(R.ruleTag("bi-12", "R3")).toBe("[bi-12 R3]");
    expect(R.tagsIn("join flow > [bi-12 R3] shows the trip")).toEqual(["[bi-12 R3]"]);
    expect(R.tagsIn("TestJoin/[bi-12_R3]_shows_the_trip")).toEqual(["[bi-12 R3]"]);
    expect(R.tagsIn("test_join[bi-12 R3]")).toEqual(["[bi-12 R3]"]);
    expect(R.tagsIn("[bi-12 R3] and [bi-7 edge_case-2] in one test")).toEqual(["[bi-12 R3]", "[bi-7 edge_case-2]"]);
    for (const no of ["[bi-12R3]", "[BI-12 R3]", "[bi-12  R3]", "[bi-x R3]", "bi-12 R3", "[bp-12 R3]", "[bi-12 R3 extra]"]) expect(R.tagsIn(no), no).toEqual([]);
  });
});

describe("rule results per blueprint item", () => {
  it("maps each rule and example of the approved flow to the tests that carry its tag: passed, failed with its message, skipped, or no test", () => {
    const f = approvedFlow(fresh(), 1);
    const tag = (id: string) => `[${f.itemId} ${id}]`;
    const s = landed(f.s, 100, report([
      [`join flow > ${tag("R1")} shows the trip`, "passed"],
      [`join flow > ${tag("R2")} adds the friend`, "passed"],
      [`join flow > ${tag("R4")} asks for a new link`, "failed", "expected 'an empty page' to be 'Ask the organizer for a new link'"],
      [`join flow > ${tag("R5")} never shows other trips`, "skipped"],
      ["join flow > formats a date with no tag", "failed", "unrelated"],
    ]));
    const res = R.ruleResults(s, f.itemId)!;
    const from = { taskId: newest(s), sha: shaOf(s.tasks.length), landedAt: at(100), artifactId: `chk-${newest(s)}-100` };
    expect(res).toEqual({
      itemId: f.itemId,
      title: "Join flow",
      kind: "flow",
      artifactId: f.artifactId,
      version: 1,
      results: [
        { kind: "rule", id: "R1", text: RULES[0].text, tag: tag("R1"), status: "passed", tests: 1, from },
        { kind: "rule", id: "R2", text: RULES[1].text, tag: tag("R2"), status: "passed", tests: 1, from },
        { kind: "rule", id: "R4", text: RULES[2].text, tag: tag("R4"), status: "failed", tests: 1, message: `join flow > ${tag("R4")} asks for a new link: expected 'an empty page' to be 'Ask the organizer for a new link'`, from },
        { kind: "rule", id: "R5", text: RULES[3].text, tag: tag("R5"), status: "skipped", tests: 1, message: `join flow > ${tag("R5")} never shows other trips: skipped`, from },
        { kind: "example", id: "E1", text: EXAMPLES[0].text, tag: tag("E1"), status: "no-test", tests: 0, message: `No test in the checks of landed work carries ${tag("E1")}.` },
      ],
      counts: { passed: 2, failed: 1, skipped: 1, "no-test": 1 },
      allPass: false,
    });
    expect(R.blueprintRuleResults(s)).toEqual([res]);
  });

  it("several tests may carry one tag (in their names or their describe block): all of them must pass; one skipped among passing ones is skipped", () => {
    const f = approvedFlow(fresh(), 1);
    const tag = (id: string) => `[${f.itemId} ${id}]`;
    const s = landed(f.s, 100, {
      ...report([
        [`${tag("R1")} shows the trip`, "passed"],
        [`${tag("R1")} shows the Join button`, "passed"],
        [`${tag("R2")} adds the friend`, "passed"],
        [`${tag("R2")} keeps the friend after a reload`, "error", "TypeError: list is undefined"],
        [`${tag("R5")} hides trip A`, "passed"],
        [`${tag("R5")} hides trip B`, "skipped", "not built yet"],
      ]),
    });
    // A tag on a describe block reaches every test in it (jest-junit puts it in the suite too).
    const run4 = s.artifacts.at(-1)!.checkRun!.tests as Extract<TestReport, { status: "read" }>;
    run4.cases.push({ name: "asks for a new link", suite: `join ${tag("R4")}`, status: "passed" }, { name: "keeps the old link out", suite: `join ${tag("R4")}`, status: "passed" });
    const res = R.ruleResults(s, f.itemId)!;
    expect(res.results.map((r) => [r.id, r.status, r.tests, r.message])).toEqual([
      ["R1", "passed", 2, undefined],
      ["R2", "failed", 2, `${tag("R2")} keeps the friend after a reload: TypeError: list is undefined`],
      ["R4", "passed", 2, undefined],
      ["R5", "skipped", 2, `${tag("R5")} hides trip B: not built yet`],
      ["E1", "no-test", 0, `No test in the checks of landed work carries ${tag("E1")}.`],
    ]);
  });

  it('"No test" and "skipped" are never a pass: only every line passing is all-pass', () => {
    const f = approvedFlow(fresh(), 1);
    const tag = (id: string) => `[${f.itemId} ${id}]`;
    const all = (over: Record<string, TestCaseResult["status"] | undefined>) =>
      report(["R1", "R2", "R4", "R5", "E1"].filter((id) => over[id] !== undefined || !(id in over)).map((id) => [`${tag(id)} t`, over[id] ?? "passed"]));
    const pass = R.ruleResults(landed(f.s, 100, all({})), f.itemId)!;
    expect(pass).toMatchObject({ allPass: true, counts: { passed: 5, failed: 0, skipped: 0, "no-test": 0 } });
    const skipped = R.ruleResults(landed(f.s, 100, all({ E1: "skipped" })), f.itemId)!;
    expect(skipped).toMatchObject({ allPass: false, counts: { passed: 4, skipped: 1 } });
    const missing = R.ruleResults(landed(f.s, 100, all({ E1: undefined })), f.itemId)!;
    expect(missing).toMatchObject({ allPass: false, counts: { passed: 4, "no-test": 1 } });
    // Nothing landed yet: every line is "no-test", and the reason says whether the settings name a report at all.
    const none = R.ruleResults(f.s, f.itemId)!;
    expect(none.allPass).toBe(false);
    expect(none.results.map((r) => [r.status, r.message])).toEqual(Array(5).fill(["no-test", "The check settings name no test report, so no test result is read (Settings → Checks)."]));
    const named = structuredClone(f.s);
    named.project.checks.testReport = "reports/junit.xml";
    expect(R.ruleResults(named, f.itemId)!.results[0].message).toBe("No landed work has a test report yet.");
  });

  it("the newest landed run that carries a tag decides; a later landed run without the tag (built before the tests landed) does not hide it", () => {
    const f = approvedFlow(fresh(), 1);
    const tag = (id: string) => `[${f.itemId} ${id}]`;
    let s = landed(f.s, 100, report([[`${tag("R4")} asks for a new link`, "failed", "shows an empty page"], [`${tag("R1")} shows the trip`, "passed"]]));
    const first = newest(s);
    s = landed(s, 200, report([[`${tag("R4")} asks for a new link`, "passed"]]));
    const fix = newest(s);
    s = landed(s, 300, report([["formats a date", "passed"]]));
    const res = R.ruleResults(s, f.itemId)!;
    expect(res.results.find((r) => r.id === "R4")).toMatchObject({ status: "passed", from: { taskId: fix, landedAt: at(200) } });
    expect(res.results.find((r) => r.id === "R1")).toMatchObject({ status: "passed", from: { taskId: first } });
    // A later landed run that breaks it again decides.
    s = landed(s, 400, report([[`${tag("R4")} asks for a new link`, "failed", "shows an empty page again"]]));
    expect(R.ruleResults(s, f.itemId)!.results.find((r) => r.id === "R4")).toMatchObject({ status: "failed", message: `${tag("R4")} asks for a new link: shows an empty page again`, from: { taskId: newest(s) } });
  });

  it("only the checks of landed work count, on exactly its final change: not work that has not landed, another commit, a person's edit, a report not read; simulated work is labelled", () => {
    const f = approvedFlow(fresh(), 1);
    const passing = report([[`[${f.itemId} R1] shows the trip`, "passed"]]);
    const r1 = (s: State) => R.ruleResults(s, f.itemId)!.results[0];
    expect(r1(landed(f.s, 100, passing, { landed: false })).status).toBe("no-test");
    expect(r1(landed(f.s, 100, passing, { checkSha: "e".repeat(40) })).status).toBe("no-test");
    expect(r1(landed(f.s, 100, passing, { author: "user" })).status).toBe("no-test");
    expect(r1(landed(f.s, 100, { status: "refused", path: "reports/junit.xml", reason: "reports/junit.xml declares <!DOCTYPE" })).status).toBe("no-test");
    expect(r1(landed(f.s, 100, undefined)).status).toBe("no-test");
    // The change's commit as a code-change names it (12 characters) and as the check run records it (40) is one commit.
    const ok = landed(f.s, 100, passing);
    expect(r1(ok)).toMatchObject({ status: "passed", from: { taskId: newest(ok), sha: shaOf(ok.tasks.length) } });
    expect(r1(landed(f.s, 100, passing, { simulated: true })).from).toMatchObject({ simulated: true });
  });

  it("a test that ran before a line's current text was approved proves the older text; an unchanged line keeps its result", () => {
    const f = approvedFlow(fresh(), 1);
    const tag = (id: string) => `[${f.itemId} ${id}]`;
    let s = landed(f.s, 100, report([[`${tag("R1")} shows the trip`, "passed"], [`${tag("R4")} asks for a new link`, "passed"]]));
    // The owner approves v2 at 203: R4 says something else now, R1 is the same.
    const changed = RULES.map((r) => (r.id === "R4" ? { ...r, text: "If the link has expired, then the app shall offer to ask the organizer for a new link." } : r));
    const v2 = approvedFlow(s, 200, changed, f.artifactId);
    expect(v2.itemId).toBe(f.itemId);
    s = v2.s;
    expect(statuses(s, f.itemId)).toMatchObject({ R1: "passed", R4: "no-test" });
    expect(R.ruleResults(s, f.itemId)!.results.find((r) => r.id === "R4")!.message).toBe(`The tests that carry ${tag("R4")} ran before this text was approved, and no later landed checks have one.`);
    expect(R.ruleResults(s, f.itemId)!.version).toBe(2);
    // A run after the approval proves the new text.
    s = landed(s, 300, report([[`${tag("R4")} offers a new link`, "passed"]]));
    expect(statuses(s, f.itemId)).toMatchObject({ R1: "passed", R4: "passed" });
  });

  it("only flows and contracts with rules have rule results; other items and unknown ids have none", () => {
    const f = approvedFlow(fresh(), 1);
    const screen = addScreen(f.s, f.s.studio.rounds.at(-1)!.n, at(10), { title: "Trip plan", variants: [] });
    const s = lockInAsOwner(run(peAgrees(screen.state, screen.id, 1, [], at(11)), "approveArtifact", { artifactId: screen.id, version: 1 }, at(12)).state, at(12));
    expect(R.blueprintRuleResults(s).map((x) => x.title)).toEqual(["Join flow"]);
    // A dropped flow has no rules to prove once the drop is locked in.
    const dropped = lockInAsOwner(run(s, "dropBlueprintItem", { itemId: f.itemId }, at(13)).state, at(13));
    expect(R.blueprintRuleResults(dropped)).toEqual([]);
    const screenItem = s.blueprint.revisions.at(-1)!.items.find((i) => i.artifactId === screen.id)!;
    expect(R.ruleResults(s, screenItem.id)).toBeUndefined();
    expect(R.ruleResults(s, "bi-999")).toBeUndefined();
    expect(R.testedItems(s, [screenItem.id, f.itemId]).map((x) => x.lines.map((l) => l.tag))).toEqual([[`[${f.itemId} R1]`, `[${f.itemId} R2]`, `[${f.itemId} R4]`, `[${f.itemId} R5]`, `[${f.itemId} E1]`]]);
  });
});
