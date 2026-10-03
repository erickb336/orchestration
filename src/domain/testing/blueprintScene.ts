// Test fixture (pure): the Weekend Trips blueprint of the pass 5 prototype, built through the real commands, for the
// tests of the draft, Lock in and "Design and reality" screens and for a seeded browser pass. Not used by the
// application.
//
// In force (Start the factory was the first Lock in): Trip plan (screen), Trip data (contract), Words (dictionary),
// Join flow (5 rules, 1 example), Share costs (2 rules) and Reminders (flow). The factory:
// - "Trip plan screen" cites Trip plan and runs;
// - "Join by link" cites Join flow and landed; one rule's test fails, one example has no test;
// - "Share costs" cites Share costs and landed; every rule passes;
// - "Trip data API" cites Trip data and landed;
// - "Outing reminders" cites Reminders and waits for its go-ahead.
// The draft (round 4): Trip plan v2 (changed), Packing list v1 (added, with the PE's estimate), Reminders dropped, and
// Trip map v1 open (the owner marked it Change).

import * as M from "../model";
import { buildSeed } from "../seed";
import type { State, TestCaseResult, TestReport } from "../types";
import { reviewedChange } from "./reviewed";
import { DESIGNER, lockInAsOwner, openRound, peAgrees, pePass, run, sha } from "./studio";

export interface BlueprintScene {
  s: State;
  /** The blueprint item ids. */
  items: { plan: string; data: string; words: string; join: string; costs: string; reminders: string; packing: string };
  /** The artifact ids. */
  artifacts: { plan: string; words: string; packing: string; join: string; map: string };
  tasks: { plan: string; join: string; costs: string; data: string; reminders: string };
  at: (sec: number) => string;
}

const JOIN_RULES = [
  { id: "R1", text: 'When a friend opens the link, the app shall show the trip and a "Join" button.', pattern: "event" },
  { id: "R2", text: "When a friend joins, the app shall add them to the list of who is in.", pattern: "event" },
  { id: "R3", text: 'While the trip is full, the app shall show "The trip is full".', pattern: "state" },
  { id: "R4", text: 'If the link has expired, then the app shall show "Ask the organizer for a new link".', pattern: "unwanted" },
  { id: "R5", text: "The app shall never show other trips to a friend who joins by link.", pattern: "always" },
];
const JOIN_EXAMPLES = [{ id: "E1", text: "Given a full trip, when a friend opens the link, then the page says the trip is full." }];
const COSTS_RULES = [
  { id: "R1", text: "When a cost is added, the app shall split it between the people it names.", pattern: "event" },
  { id: "R2", text: "If a split leaves a remainder cent, then the app shall give it to the organizer.", pattern: "unwanted" },
];
const WORDS = [
  { term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey"] },
  { term: "friend", meaning: "A person in the group, who joins by link.", avoid: ["member", "user"] },
];

const shaOf = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

/** A new task, held for the owner's go-ahead, whose spec (the lead's revision at `at`) cites `cites`. */
export function citingTask(s0: State, title: string, cites: string[], at: string): { s: State; taskId: string } {
  const c = run<{ newId: string }>(s0, "createTask", { title, area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at);
  const spec = M.currentSpec(c.state.tasks.find((x) => x.id === c.result.newId)!);
  return { s: M.editSpec(c.state, c.result.newId, spec.rev, { ...spec.content, blueprintRefs: cites }, "Cites the blueprint", "lead", at), taskId: c.result.newId };
}

/** A JUnit report the checks read: each test's name, its result, and a message. */
export function testReport(cases: [string, TestCaseResult["status"], string?][]): TestReport {
  const counts = { passed: 0, failed: 0, skipped: 0, error: 0 };
  for (const [, st] of cases) counts[st]++;
  return { status: "read", path: "reports/junit.xml", cases: cases.map(([name, status, message]) => ({ name, suite: "tests/acceptance.test.ts", status, ...(message ? { message } : {}) })), counts, truncated: false };
}

/**
 * The task's work lands at `at`: a reviewed change, the task done, the change on main, and (with `tests`) a check run
 * on exactly that change, 5 s before, that read the report. Each of its runs costs $1.10.
 */
export function landTask(s0: State, taskId: string, at: string, tests?: TestReport): State {
  const changeSha = shaOf(s0.tasks.findIndex((x) => x.id === taskId) + 1);
  const s = reviewedChange(s0, taskId, changeSha, new Date(Date.parse(at) - 20_000).toISOString());
  const t = s.tasks.find((x) => x.id === taskId)!;
  t.lifecycle = "done";
  t.holdBeforeStart = false;
  t.integration = { status: "integrated", at, sha: "f".repeat(40), landed: { at, via: "local", target: "main", commit: "f".repeat(40), by: "app", flags: [], status: "unreviewed", notes: [], followUps: [] } };
  if (tests) s.artifacts.push({ id: `chk-${taskId}-${at}`, taskId, stepId: "C2", attemptId: `fx-check-${taskId}`, name: "final", kind: "check-results", version: 1, summary: "checks", createdAt: new Date(Date.parse(at) - 5_000).toISOString(), checkRun: { sha: changeSha, configRev: 1, sandbox: "codex", touchedInputs: [], results: [], durationMs: 1, tests } });
  for (const a of s.attempts) if (a.taskId === taskId) a.usage ??= { costUsd: 1.1 };
  return s;
}

export function blueprintScene(t0 = Date.parse("2026-10-02T09:00:00Z")): BlueprintScene {
  const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
  let s = M.initProject(buildSeed(t0, { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/weekend-trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
  s = run(s, "setBudgets", { buildingUsd: 40, maintenanceUsdPerMonth: 10 }, at(1)).state;

  const add = (round: number, sec: number, args: Record<string, unknown>) => run<{ artifactId: string; version: number }>(s, "addStudioArtifact", { round, devices: [], madeBy: DESIGNER, ...args }, at(sec));
  const agreeAndApprove = (id: string, version: number, sec: number, pe = true) => {
    if (pe) s = peAgrees(s, id, version, [], at(sec));
    s = run(s, "approveArtifact", { artifactId: id, version }, at(sec + 1)).state;
  };
  const flow = (round: number, sec: number, title: string, dir: string, rules: object[], examples: object[]) => {
    const a = add(round, sec, { kind: "flow", title, variants: [{ id: "A", label: title, entry: `${dir}/flow.md` }], files: [{ path: `${dir}/flow.md`, sha256: sha("b") }, { path: `${dir}/rules.json`, sha256: sha("c") }], rules: [{ variant: "A", path: `${dir}/rules.json`, rules, examples }] });
    s = a.state;
    agreeAndApprove(a.result.artifactId, a.result.version, sec + 1);
    return a.result.artifactId;
  };

  // Rounds 1 to 3, approved, then locked in by Start the factory.
  let r = openRound(s, "experience", at(10));
  s = r.state;
  const plan = add(r.n, 11, { kind: "screen", title: "Trip plan", variants: [{ id: "A", label: "Map first", entry: "trip-plan/index.html" }], files: [{ path: "trip-plan/index.html", sha256: sha("a") }], devices: ["desktop", "mobile"] });
  s = plan.state;
  agreeAndApprove(plan.result.artifactId, 1, 12);
  s = run(s, "closeRound", { round: r.n }, at(14)).state;
  r = openRound(s, "data", at(20));
  s = r.state;
  const data = add(r.n, 21, { kind: "contract", title: "Trip data", variants: [{ id: "A", label: "Trip data", entry: "trip-data/contract.md" }], files: [{ path: "trip-data/contract.md", sha256: sha("d") }] });
  s = data.state;
  agreeAndApprove(data.result.artifactId, 1, 22);
  const words = add(r.n, 24, { kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("e") }], dictionary: WORDS });
  s = words.state;
  agreeAndApprove(words.result.artifactId, 1, 25, false); // the PE does not review a word list
  s = run(s, "closeRound", { round: r.n }, at(27)).state;
  r = openRound(s, "flows", at(30));
  s = r.state;
  const join = flow(r.n, 31, "Join flow", "join", JOIN_RULES, JOIN_EXAMPLES);
  flow(r.n, 34, "Share costs", "costs", COSTS_RULES, []);
  flow(r.n, 37, "Reminders", "reminders", [{ id: "R1", text: "When a trip is two days away, the app shall remind each friend.", pattern: "event" }], []);
  s = run(s, "closeRound", { round: r.n }, at(40)).state;
  s = lockInAsOwner(s, at(50));
  const item = (title: string) => s.blueprint.revisions.at(-1)!.items.find((i) => i.title === title)!.id;

  // The factory's tasks, each citing its item.
  const task = (title: string, cites: string, sec: number) => {
    const c = citingTask(s, title, [cites], at(sec));
    s = c.s;
    return c.taskId;
  };
  const land = (taskId: string, sec: number, tests?: TestReport) => void (s = landTask(s, taskId, at(sec), tests));
  const report = testReport;

  const items = { plan: item("Trip plan"), data: item("Trip data"), words: item("Words"), join: item("Join flow"), costs: item("Share costs"), reminders: item("Reminders"), packing: "" };
  const tag = (id: string, line: string) => `[${id} ${line}]`;
  const tasks = {
    plan: task("Trip plan screen", items.plan, 60),
    join: task("Join by link", items.join, 70),
    costs: task("Share costs", items.costs, 80),
    data: task("Trip data API", items.data, 90),
    reminders: task("Outing reminders", items.reminders, 100),
  };
  land(tasks.join, 200, report([
    [`${tag(items.join, "R1")} shows the trip and Join`, "passed"],
    [`${tag(items.join, "R2")} adds the friend`, "passed"],
    [`${tag(items.join, "R3")} says the trip is full`, "passed"],
    [`${tag(items.join, "R4")} asks for a new link`, "failed", "expected an empty page to show 'Ask the organizer for a new link'"],
    [`${tag(items.join, "R5")} never shows other trips`, "passed"],
  ]));
  land(tasks.costs, 210, report([
    [`${tag(items.costs, "R1")} splits a cost`, "passed"],
    [`${tag(items.costs, "R2")} gives the remainder cent to the organizer`, "passed"],
  ]));
  land(tasks.data, 220);
  // The Trip plan screen runs: started on the owner's go-ahead, then dispatched.
  s = M.dispatchEligible(M.leadPromoteProposals(M.startHeldTask(s, tasks.plan, at(230)), at(230)), at(230));

  // The draft, in round 4: Trip plan v2 changed, Packing list added (with the PE's estimate), Reminders dropped, Trip map open.
  r = openRound(s, "experience", at(300));
  s = r.state;
  const plan2 = add(r.n, 301, { kind: "screen", title: "Trip plan", artifactId: plan.result.artifactId, variants: [{ id: "A", label: "Day list first", entry: "trip-plan/index.html" }], files: [{ path: "trip-plan/index.html", sha256: sha("f") }], devices: ["desktop", "mobile"] });
  s = peAgrees(plan2.state, plan.result.artifactId, plan2.result.version, [], at(302));
  const packing = add(r.n, 303, { kind: "screen", title: "Packing list", variants: [{ id: "B", label: "Shared list", entry: "packing/index.html" }], files: [{ path: "packing/index.html", sha256: sha("9") }], devices: ["desktop", "mobile"] });
  s = pePass(packing.state, packing.result.artifactId, 1, [{ verdict: "feasible", budget: { buildUsd: [3, 5], maintenanceUsdPerMonth: [0.4, 0.8], basis: "storage of shared lists" } }], at(304));
  const map = add(r.n, 305, { kind: "screen", title: "Trip map", variants: [{ id: "A", label: "Full map", entry: "trip-map/index.html" }], files: [{ path: "trip-map/index.html", sha256: sha("8") }], devices: ["desktop", "mobile"] });
  s = peAgrees(map.state, map.result.artifactId, 1, [], at(306));
  s = run(s, "sendFeedback", { entries: [{ artifactId: map.result.artifactId, version: 1, mark: "change", pins: [], note: "Show the stops as a list too.", rows: [] }] }, at(307)).state;
  s = run(s, "approveRound", { round: r.n }, at(310)).state;
  s = run(s, "dropBlueprintItem", { itemId: items.reminders }, at(320)).state;
  items.packing = s.blueprint.draft.items.find((i) => i.title === "Packing list")!.id;

  return { s, items, artifacts: { plan: plan.result.artifactId, words: words.result.artifactId, packing: packing.result.artifactId, join, map: map.result.artifactId }, tasks, at };
}
