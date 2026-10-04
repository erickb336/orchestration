// ORC-032, the import of an existing repository: its five screens (Start, Reading, Review, Baseline and After) and the
// header, as the reader sees them, on tally's import at each stage (src/domain/testing/import.ts, sample data built
// through the real commands). The plan's changes: C1 (how it runs), C5 (changes to design), C7 (Start's words), C8
// (parts listed, not confirmed), C9 (round 0), C10 (the vision draft), C15 (Correct on any item).

import { describe, expect, it } from "vitest";
import * as B from "../../domain/studio/blueprint";
import { itemFactoryStatus } from "../../domain/studio/itemStatus";
import { PROTOTYPE_ANSWERS, at, baselineArgs, tallyImport, type ImportOptions } from "../../domain/testing/import";
import { run } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { ImportHome } from "../Overview";
import { importPlaces } from "../placesView";
import { ItemDetail, Reality } from "../studio/Reality";
import { renderScreen, testService, visible } from "../testStore";
import { BaselineLockIn } from "./BaselineLockIn";
import { ImportPanel } from "./ImportPanel";
import { ImportReview } from "./ImportReview";
import { TALLY_START_INFO } from "./importScene";
import { UNANSWERED_TEXT, startBlocker, startDraft, type FoundRepository } from "./importView";
import { StartForm } from "./StartImport";

const svc = testService({ prototypePort: 5320 });
const text = (node: React.ReactElement, s: State) => visible(renderScreen(node, s, svc));
const stage = (st: Parameters<typeof tallyImport>[0], o?: ImportOptions) => tallyImport(st, o).s;
/** The prototype's example without the misreading: Currency is a change, and nothing waits for a fix. */
const CHANGE = [
  { on: { rule: "R13" }, option: "source-2" },
  { on: { rule: "R14" }, option: "keep" },
  { on: { rule: "R15" }, option: "confirm" },
  { on: { rule: "R16" }, option: "confirm" },
];
/** Every answer keeps the code: nothing to change. */
const KEEP_ALL = [
  { on: { rule: "R13" }, option: "keep" },
  { on: { rule: "R14" }, option: "keep" },
  { on: { rule: "R15" }, option: "confirm" },
  { on: { rule: "R16" }, option: "confirm" },
  { on: { rule: "R17" }, option: "confirm" },
];

describe("1 · Start (C1, C7)", () => {
  const start = (info: FoundRepository) => text(<StartForm info={info} />, stage("started"));

  it("says what it found and which commit it reads, prefills the kinds and the devices with their reasons, and shows the estimate beside the budget", () => {
    const t = start(TALLY_START_INFO);
    expect(t).toContain("✓ Found a git repository on main: 14 source files and 5 test files. The import reads the last commit, c0ffee0 on main. Changes you have not committed are left out.");
    expect(t).toContain("Screen product prefilled Found: tally/__main__.py: a command-line entry.");
    expect(t).toContain("Infrastructure Not found.");
    expect(t).toContain("Terminal prefilled Demos of a command-line tool in a terminal. Found: tally/__main__.py: a command-line entry.");
    expect(t).toContain("Desktop Screens at 1280 pixels wide. Not found.");
    expect(t).toContain("$0 the estimate $3.00, the budget The estimate: about $0.43–$2.07.");
    expect(t).toContain("No file in your repository changes, and the vision stays on this computer.");
    expect(t).not.toContain("Nothing is written into the repository");
  });

  it("how it runs is complete when the environment, the test command and its report are all prefilled", () => {
    expect(start(TALLY_START_INFO)).toContain("How it runs complete");
    expect(startDraft(TALLY_START_INFO)).toMatchObject({ testCommand: "python3 -m pytest --junitxml=reports/junit.xml", testReport: "reports/junit.xml", domains: ["screen", "code"], devices: ["terminal"], name: "tally" });
  });

  it("says what is missing and what that means: no tests without a test command, no run at all without an environment", () => {
    const { testReport: _r, ...noTests } = TALLY_START_INFO;
    const t = start(noTests);
    expect(t).toContain("How it runs missing the test command, the test report's path");
    expect(t).toContain("Without a test command and its report, the tests do not run: every rule is read from the code (inferred). The CLI and the screens are still recorded in the environment.");
    // A check command the repository suggests fills the test command; the report's path stays missing.
    const suggested = start({ ...noTests, checks: [{ id: "unit", label: "Unit tests", kind: "check", argv: ["python3", "-m", "unittest"] }] });
    expect(suggested).toContain("How it runs missing the test report's path");
    const { proposal: _p, ...noEnv } = TALLY_START_INFO;
    const n = start(noEnv);
    expect(n).toContain("How it runs missing the environment");
    expect(n).toContain("Without an environment, the import never runs your code: the tests do not run, nothing is recorded, and every rule is read from the code (inferred).");
  });

  it("does not start without a name, a kind, a device or a positive budget", () => {
    const d = startDraft(TALLY_START_INFO);
    expect(startBlocker(d)).toBeUndefined();
    expect(startBlocker({ ...d, budget: "0" })).toBe("The import budget is a positive number of dollars.");
    expect(startBlocker({ ...d, domains: [] })).toBe("Choose at least one kind of product.");
    expect(startBlocker({ ...d, devices: [] })).toBe("Choose at least one device.");
    expect(startBlocker({ ...d, name: " " })).toBe("Give the project a name.");
  });
});

describe("2 · Reading (C2)", () => {
  it("shows the steps in order, each with its state, and the spend against the import budget with the estimate", () => {
    const t = text(<ImportPanel />, stage("started"));
    expect(t).toContain("reading · 0 of 5 steps done $0.00 spent of the $3.00 import budget. The estimate: $0.43–$2.07.");
    expect(t).toContain("running: The tests the service · running your test command in the environment ○ waiting: The rules not started ○ waiting: The parts not started ○ waiting: The recording the service · after the parts ○ waiting: The words (at the same time) not started");
    expect(t).toContain("Pause the import");
  });

  it("each step says what it found once done: the tests, the rules, the parts, then the recording", () => {
    expect(text(<ImportPanel />, stage("read"))).toContain("✓ done: The tests the service · 22 read, all pass ✓ done: The rules Reader · Claude · 17 rules: 13 from the tests, 4 from the code and the docs ○ waiting: The parts not started");
    const parts = text(<ImportPanel />, stage("parts"));
    expect(parts).toContain("✓ done: The parts Designer · Claude · 5 parts: tally add, tally split, tally report, Splitting, The ledger ○ waiting: The recording the service · recording the parts in the environment");
    expect(parts).toContain("reading · 4 of 5 steps done");
  });

  it("without Docker, the tests are skipped with the reason", () => {
    expect(text(<ImportPanel />, stage("read", { checks: "not-run" }))).toContain("– skipped: The tests the service · not run: Docker is not available on this computer, so the tests did not run");
  });

  it("a paused project offers Resume; a stopped import says why and that nothing more runs", () => {
    const paused = run(stage("read"), "pauseProject", {}, at(30)).state;
    expect(text(<ImportPanel />, paused)).toContain("Resume the import");
    const sc = tallyImport("read");
    const stopped = run(sc.s, "stopImport", { importId: sc.importId, reason: "the rules reader's output was refused twice" }, at(31)).state;
    const t = text(<ImportPanel />, stopped);
    expect(t).toContain("The import stopped: the rules reader's output was refused twice Nothing more runs for it.");
    expect(t).not.toContain("Pause the import");
  });
});

describe("3 · Review (C5, C8, C9, C15)", () => {
  it("is round 0, As it is today; it asks the 2 conflicts and the 3 important guesses, and lists the confirmed rules and the parts", () => {
    const t = text(<ImportReview />, stage("review"));
    expect(t).toContain("Round 0 · As it is today · from the import of tally at commit c0ffee0");
    expect(t).toContain("2 conflicts and 3 guesses need you; 12 rules are confirmed. 0 of 5 answered");
    expect(t).toContain("Conflicts 2");
    expect(t).toContain("Inferred, important 3");
    expect(t).toContain("12 confirmed rules, each with its passing tests");
    expect(t).toContain(`0 of 5 answered. 5 stay open if you send now.`);
    expect(t).toContain(UNANSWERED_TEXT);
    expect(t).not.toContain("Round 1");
  });

  it("each conflict offers the code, the source that differs, and Neither, each with what it does", () => {
    const t = text(<ImportReview />, stage("review"));
    expect(t).toContain("Which is right? The code: --format csv tally stays as it is, and this goes into the baseline. The docs: --csv tally must change. The baseline keeps what tally does today, and this becomes a change to design. Neither Write what is right. It becomes a change to design.");
    expect(t).toContain("The test: one currency per group tally stays as it is");
  });

  it("parts are listed as recorded from the running CLI or read from the code, with their rules' tests (C8)", () => {
    const t = text(<ImportReview />, stage("review"));
    expect(t).toContain("tally add terminal demo Recorded from the running CLI (simulated). Its rules: 5 of 5 have a passing test.");
    expect(t).toContain("Splitting algorithm Read from the code: tally/settle.py, tally/money.py. Its rules: 1 of 2 have a passing test.");
    const noDocker = text(<ImportReview />, stage("review", { checks: "not-run" }));
    expect(noDocker).toContain("tally add terminal demo Read from the code: not recorded, because docker is not available on this computer, so nothing was recorded.");
  });

  it("the counts and the effects follow the answers: kept, a change to design, a fix of the reading, and open", () => {
    const t = text(<ImportReview />, stage("answered"));
    expect(t).toContain("4 of 5 answered");
    expect(t).toContain("Your answer: The docs: a currency on each expense. The baseline keeps what tally does today. Your change becomes a change to design.");
    expect(t).toContain("Your answer: The code: --format csv. tally stays as it is, and this goes into the baseline.");
    expect(t).toContain("Confirmed. It goes into the baseline as it is.");
    expect(t).toContain("Your answer: tally does something else today. A designer fixes the part from your words, and it goes into the baseline as you wrote.");
    expect(t).toContain("4 of 5 answered. 1 stays open if you send now.");
    expect(t).toContain("4 answers are recorded.");
  });

  it("a test that fails makes its rule a conflict: the code as it is, or the test (Q2)", () => {
    const t = text(<ImportReview />, stage("review", { checks: { failing: ["test_add.py::test_unknown_payer"] } }));
    expect(t).toContain("3 conflicts and 3 guesses need you; 11 rules are confirmed.");
    expect(t).toContain('The test, test_add.py::test_unknown_payer If the payer is not in the group, then the CLI shall stop with "Unknown person". · fails');
    expect(t).toContain("The code: as it is today tally stays as it is, and this goes into the baseline. The test: test_add.py::test_unknown_payer tally must change.");
  });

  it("Correct on a confirmed rule offers the two choices, and says what each does (C15)", () => {
    const answers = [...PROTOTYPE_ANSWERS, { on: { rule: "R1" }, option: "correct", correction: "change" as const, text: "Record the currency too." }];
    const t = text(<ImportReview />, stage("answered", { answers }));
    expect(t).toContain("R1 When you add an expense, the CLI shall record its amount, payer, people, note and date. test_add.py::test_records_expense +1 more · all pass Close What is wrong tally should do something else A change to design. The baseline keeps what it does today. tally does something else today The reader misread the code. A designer fixes the part before the baseline.");
    expect(t).toContain("Your answer: tally should do something else. The baseline keeps what tally does today. Your change becomes a change to design.");
  });
});

describe("4 · Baseline (C4, C5, C10)", () => {
  it("the facts follow the answers you sent: what is verified, what you kept, the changes to design, and what stays open", () => {
    const t = text(<BaselineLockIn />, stage("answered"));
    expect(t).toContain("Lock in 1 · the baseline");
    expect(t).toContain("6 parts and their 17 rules go into force as tally is today. They count as built. 13 rules are verified: their tests pass. 4 rules have no test: 3 you confirmed, 1 not answered. They go in as tally does them today. The factory has nothing to build now. Your 1 change to design waits for the lead's next round.");
    expect(t).toContain("you corrected If the amount is below zero, then the CLI shall record a refund. (R16 · was inferred · no test)");
    expect(t).toContain("Changes to design, not the baseline");
    expect(t).toContain("Change tally add: The docs: a currency on each expense");
    expect(t).toContain('Open the ledger: not answered. It goes in as the code has it, marked "not confirmed". The question stays in Vision.');
    expect(t).toContain("Import: $0.00 spent of $3.00. The estimate was $0.43–$2.07.");
  });

  it("each part says its kind, its rules' tests and whether the import recorded it", () => {
    const t = text(<BaselineLockIn />, stage("answered"));
    expect(t).toContain("Baseline tally add v1 (terminal demo; tests 5 of 5 pass; recorded)");
    expect(t).toContain("Baseline tally report v1 (terminal demo; tests 2 of 3 pass · 1 no test; recorded)");
    expect(t).toContain("Baseline Splitting v1 (algorithm; tests 1 of 2 pass · 1 no test)");
    expect(t).toContain("Baseline Words v1 (dictionary)");
    expect(text(<BaselineLockIn />, stage("answered", { checks: { failing: ["test_add.py::test_unknown_payer"] } }))).toContain("Baseline tally add v1 (terminal demo; tests 4 of 5 pass · 1 fails; recorded)");
  });

  it("a part you said the reader misread waits for its fix: the Lock in says so and waits", () => {
    const html = renderScreen(<BaselineLockIn />, stage("answered"), svc);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*title="A part waits for its fix: The ledger\. The baseline holds the fixed version\."[^>]*>Lock in the baseline<\/button>/);
    expect(visible(html)).toContain("A part waits for its fix: The ledger. The baseline holds the fixed version.");
  });

  it("with every answer keeping the code, nothing changes and nothing stays open", () => {
    const t = text(<BaselineLockIn />, stage("answered", { answers: KEEP_ALL }));
    expect(t).toContain("The factory has nothing to build. It starts when you change the design.");
    expect(t).toContain("What stays open Nothing. You answered every question.");
    expect(t).not.toContain("Changes to design, not the baseline");
  });

  it("the agreement gates the Lock in: the button waits for the box, with the reason", () => {
    const html = renderScreen(<BaselineLockIn />, stage("answered", { answers: CHANGE }), svc);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*title="Tick the box first: your agreement is recorded with this summary\."[^>]*>Lock in the baseline<\/button>/);
    expect(visible(html)).toContain("I have reviewed the baseline. It is what tally does today, with my answers.");
  });

  it("a stale summary is refused: the Lock in names the summary the screen showed, and a change since then fails it", () => {
    const sc = tallyImport("answered", { answers: CHANGE });
    const seen = baselineArgs(sc.s);
    // Another tab sets a building budget, so the summary changes.
    const changed = run(sc.s, "setBudgets", { buildingUsd: 25, maintenanceUsdPerMonth: 5 }, at(110)).state;
    expect(baselineArgs(changed).summaryDigest).not.toBe(seen.summaryDigest);
    expect(() => run(changed, "lockInBaseline", seen, at(111))).toThrow(/changed since you read it|draft/i);
    expect(run(changed, "lockInBaseline", baselineArgs(changed), at(112)).state.studio.import!.lockedInAt).toBe(at(112));
  });

  it("is not offered while the import reads; after the Lock in it says what is in force and where to look", () => {
    expect(text(<BaselineLockIn />, stage("read"))).toContain("The import is still reading.");
    expect(text(<BaselineLockIn />, stage("baseline"))).toContain("Locked in, as Lock in 1: the baseline. What tally does today is in force and built. The factory has nothing to build until you change the design. Open Design and reality Open Vision");
  });
});

describe("5 · After (Design and reality, Home)", () => {
  const item = (s: State, artifactId: string) => B.blueprintItems(s).find((i) => i.artifactId === artifactId)!.id;

  it("Design and reality lists each part of the baseline with its status from the import and its tests", () => {
    const t = text(<Reality />, stage("baseline"));
    expect(t).toContain("Lock in 1, the baseline · 6 parts.");
    expect(t).toContain("tally add v1 terminal-demo built and verified from the import Tests: 5 of 5 pass");
    expect(t).toContain("tally report v1 terminal-demo built, not verified from the import Tests: 2 of 3 pass · 1 no test");
    // The ledger is v2: the designer's fix of what the reader misread.
    expect(t).toContain("The ledger v2 contract built, not verified from the import Tests: 3 of 5 pass · 2 no test");
    expect(t).toContain("Words v1 dictionary in force from the import");
  });

  it("a part's detail says why, and gives each rule its test and your answer", () => {
    const sc = tallyImport("baseline");
    const id = item(sc.s, sc.parts.ledger!);
    const t = text(<ItemDetail view={itemFactoryStatus(sc.s, id)!} />, sc.s);
    expect(t).toContain("From the import, at commit c0ffee0. The checks do not prove it yet: 2 rules or examples have no test.");
    expect(t).toContain("R5 The ledger shall keep money in whole cents. passes test_money.py::test_whole_cents +1");
    expect(t).toContain("R16 If the amount is below zero, then the CLI shall record a refund. No test as you corrected it");
    expect(t).toContain("R17 The ledger shall live in .tally.json in the folder where you run tally. No test not confirmed");
    const add = text(<ItemDetail view={itemFactoryStatus(sc.s, item(sc.s, sc.parts.add!))!} />, sc.s);
    expect(add).toContain("From the import, at commit c0ffee0. Every rule has a passing test, and the running code was recorded.");
    expect(add).toContain("Recorded at commit c0ffee0 simulated");
    expect(add).toContain("R13 The ledger shall keep one currency per group, set in .tally.json. passes test_add.py::test_rejects_other_currency a change to design");
  });

  it("a part whose test fails reads fails a check", () => {
    const t = text(<Reality />, stage("baseline", { checks: { failing: ["test_add.py::test_unknown_payer"] } }));
    expect(t).toContain("tally add v1 terminal-demo fails a check from the import Tests: 4 of 5 pass · 1 fails");
  });

  it("Home: nothing to build until you change the design; the changes to design you asked for wait for a round", () => {
    expect(text(<ImportHome />, stage("baseline", { answers: KEEP_ALL }))).toBe("The factory All tasks Nothing to build: change the design in Vision to start work. Open Vision");
    expect(text(<ImportHome />, stage("baseline"))).toBe("The factory All tasks Nothing to build yet: 1 change to design waits. Ask the lead for a round in Vision, then start the factory. Open Vision Ask the lead for a round");
    expect(text(<ImportHome />, stage("review"))).toBe("The import needs you Round 0, As it is today, asks you 5 questions. Answer in Vision, then lock in the baseline. Answer in Vision");
  });
});

describe("the header while importing", () => {
  const words = (s: State) => {
    const p = importPlaces(s);
    return { home: p?.home?.text, vision: p?.vision?.text };
  };
  it("importing; then needs you and round 0 with what is open; after the baseline, nothing to build and the changes to design", () => {
    expect(words(stage("started"))).toEqual({ home: "importing", vision: "importing" });
    expect(words(stage("review"))).toEqual({ home: "1 needs you", vision: "round 0 · 5 need you" });
    expect(words(stage("answered"))).toEqual({ home: "1 needs you", vision: "round 0 · 1 needs you" });
    expect(words(stage("baseline"))).toEqual({ home: "nothing to build", vision: "1 change to design" });
    expect(words(stage("baseline", { answers: KEEP_ALL }))).toEqual({ home: "nothing to build", vision: undefined });
  });
});
