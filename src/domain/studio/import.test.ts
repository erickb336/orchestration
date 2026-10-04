// ORC-032, the import of an existing repository into Vision: its commands, as the owner and the service send them,
// on tally (an invented CLI, sample data). The derivations (confidence, questions, answers' effects, statuses, rule
// results, spend) have their own describe blocks below.

import { describe, expect, it } from "vitest";
import { InvalidCommandError, SERVICE_COMMANDS, runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import { budgetStop, buildingSpend, importSpend, importStop } from "../spend";
import { PROBE_KEY, setResearchHelpers, setSubagentProviders } from "../subagents";
import { startFactoryAsOwner } from "../testing/factory";
import { TALLY_COMMIT, TALLY_SIZE, at, T0, tallyCases, tallyImport, tallyReading } from "../testing/import";
import { peAgrees, run } from "../testing/studio";
import { ControlError, type State } from "../types";
import * as B from "./blueprint";
import * as I from "./import";
import { itemFactoryStatus, restOfBuild } from "./itemStatus";
import { ruleResults } from "./ruleResults";
import * as R from "./runs";
import * as S from "./studio";

const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};
/** A new project with the kind of product chosen, ready to start an import. */
const ready = (): State => {
  let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "tally (sample)", repoPath: "/tmp/tally", vision: "", focus: "" }, at(0));
  s = run(s, "setDomains", { domains: ["code"] }, at(0)).state;
  return s;
};
const START = { commit: TALLY_COMMIT, branch: "main", budgetUsd: 3, helpers: null, size: TALLY_SIZE };

describe("the import's commands (phase A)", () => {
  it("the owner starts it: pinned to the commit, with its budget and the estimate, and round 0 As it is today opened", () => {
    const s = run(ready(), "startImport", START, at(1)).state;
    expect(s.studio.import).toEqual({
      id: s.studio.import!.id,
      commit: TALLY_COMMIT,
      branch: "main",
      startedAt: at(1),
      budgetUsd: 3,
      estimate: I.importEstimate(TALLY_SIZE),
      helpers: null,
      readsOn: "claude",
      checks: { status: "pending" },
      answers: [],
    });
    expect(s.studio.rounds).toEqual([{ n: 0, focus: "material", openedAt: at(1), summary: "As it is today: what the repository does at commit c0ffee0 on main." }]);
    expect(I.importStatus(s)).toBe("reading");
    expect(s.events.at(-1)!.message).toBe("Import started: commit c0ffee0 on main, with a budget of $3.00 (the estimate: $0.43–$2.07); round 0, As it is today, opened");
  });

  it("the estimate is a formula of the files read, with its basis; it grows with the size", () => {
    expect(I.importEstimate({ sourceFiles: 14, testFiles: 5, kb: 38 }).usd).toEqual([0.43, 2.07]);
    expect(I.importEstimate({ sourceFiles: 300, testFiles: 120, kb: 1000 }).usd).toEqual([1.17, 13.89]);
    expect(I.importEstimate({ sourceFiles: 14, testFiles: 5, kb: 38 }).basis).toBe(
      "14 source files, 5 test files (38 KB). The runs of recorded real imports of small repositories, plus the files read 1 to 4 times by 3 readers at Claude's published prices. There is no basis above about 50 files. An estimate, not a bill.",
    );
  });

  it("refuses a start outside a new project in Vision, before the kind of product, with a short commit, twice, or with helpers no provider tracks", () => {
    const sample = buildSeed(T0, { inFlightRuns: false });
    expect(failure(() => run(sample, "startImport", START, at(1))).message).toBe("The import starts a new project, in Vision.");
    const noKind = M.initProject(sample, { name: "x", repoPath: "/tmp/x", vision: "", focus: "" }, at(0));
    expect(failure(() => run(noKind, "startImport", START, at(1))).message).toBe("Choose the kind of product first: screen, code or infrastructure.");
    expect(failure(() => run(ready(), "startImport", { ...START, commit: "c0ffee0" }, at(1))).message).toBe("The commit is a full commit id: 40 or 64 lowercase hex characters.");
    expect(failure(() => run(ready(), "startImport", { ...START, budgetUsd: 0 }, at(1))).message).toBe("The import budget is a positive number of dollars.");
    const started = run(ready(), "startImport", START, at(1)).state;
    expect(failure(() => run(started, "startImport", START, at(2))).message).toBe("This project has an import already. To import again, start a new project.");
    const withRound = run(ready(), "openRound", { focus: "experience" }, at(1)).state;
    expect(failure(() => run(withRound, "startImport", START, at(2))).message).toBe("The import starts a new project, and this one has Vision rounds already. Start a new project in Settings.");
    expect(failure(() => run(ready(), "startImport", { ...START, helpers: 2 }, at(1))).message).toBe("No provider tracks helper agents yet, so the rules reader cannot start them.");
    expect(failure(() => run(ready(), "startImport", { ...START, readsOn: "gemini" }, at(1)))).toBeInstanceOf(InvalidCommandError);
  });

  it("the service's records are service commands: a client cannot send them; the owner's are ordinary commands", () => {
    for (const name of ["recordImportChecks", "recordImportRules", "recordImportCapture", "stopImport"]) expect(SERVICE_COMMANDS.has(name)).toBe(true);
    for (const name of ["startImport", "setImportBudget", "answerImport", "lockInBaseline"]) expect(SERVICE_COMMANDS.has(name)).toBe(false);
  });

  it("goes from reading to review once the reading and the capture are in and no run of it is under way, then to locked in", () => {
    expect(I.importStatus(tallyImport("parts").s)).toBe("reading");
    const review = tallyImport("review");
    expect(I.importStatus(review.s)).toBe("review");
    expect(review.s.studio.import!.checks).toEqual({ status: "read", at: at(10), counts: { passed: 22, failed: 0, skipped: 0, error: 0 }, reportFile: "checks/junit.xml", simulated: true });
    expect(review.s.studio.import!.reading!.rules.map((r) => r.id)).toEqual(Array.from({ length: 17 }, (_, i) => `R${i + 1}`));
    expect(review.s.studio.import!.reading!.cases).toHaveLength(22);
    // Every part is as is at the import's commit (C11), and carries its rules with the tests they name.
    const parts = I.importParts(review.s);
    expect(parts.map((a) => [a.kind, a.title, a.provenance!.commit])).toEqual([
      ["dictionary", "Words", TALLY_COMMIT],
      ["terminal-demo", "tally add", TALLY_COMMIT],
      ["terminal-demo", "tally split", TALLY_COMMIT],
      ["terminal-demo", "tally report", TALLY_COMMIT],
      ["algorithm", "Splitting", TALLY_COMMIT],
      ["contract", "The ledger", TALLY_COMMIT],
    ]);
    expect(parts[2].rules![0].rules.map((r) => [r.id, r.tests])).toEqual([
      ["R6", ["test_split.py::test_balances", "test_split.py::test_balances_sum_to_zero"]],
      ["R8", ["test_split.py::test_even"]],
    ]);
    const base = tallyImport("baseline");
    expect(I.importStatus(base.s)).toBe("locked-in");
    expect(base.s.blueprint.revisions.map((r) => [r.rev, r.lockIn?.baseline])).toEqual([[1, { importId: base.importId, commit: TALLY_COMMIT }]]);
    expect(B.blueprintItems(base.s).map((i) => [i.title, i.version, i.status])).toEqual([
      ["Words", 1, "approved"],
      ["tally add", 1, "approved"],
      ["tally split", 1, "approved"],
      ["tally report", 1, "approved"],
      ["Splitting", 1, "approved"],
      // The owner said the reader misread R16: the designer's fix made v2, which the baseline holds.
      ["The ledger", 2, "approved"],
    ]);
    expect(base.s.studio.rounds[0].closedAt).toBe(at(120));
    expect(base.s.project.stage).toBe("shaping");
  });

  it("a reproduction in a project with an import shows the import's commit, and no other", () => {
    const sc = tallyImport("read");
    const designer = { role: "designer", provider: "claude", model: "m", attemptId: "run-x" };
    const part = { round: 0, kind: "algorithm", title: "Rounding", devices: [], variants: [{ id: "a", label: "As is", entry: "r.md" }], files: [{ path: "r.md", sha256: "e".repeat(64) }], madeBy: designer };
    expect(failure(() => run(sc.s, "addStudioArtifact", { ...part, provenance: { files: ["tally/money.py"], commit: "d".repeat(40) } }, at(41))).message).toBe("The import reads commit c0ffee0; a reproduction shows that commit, not dddddddddddd.");
    const ok = run<{ artifactId: string }>(sc.s, "addStudioArtifact", { ...part, provenance: { files: ["tally/money.py"] } }, at(41));
    expect(S.getArtifact(ok.state, ok.result.artifactId, 1).provenance).toEqual({ asIs: true, files: ["tally/money.py"], commit: TALLY_COMMIT });
  });

  it("the rules are checked against the baseline run: a test the report does not have is refused, and so is a test when the tests did not run", () => {
    const checked = tallyImport("checked");
    const reading = tallyReading();
    const unknown = { ...reading, rules: reading.rules.map((r) => (r.id === "R3" ? { ...r, tests: ["test_add.py::test_unknown_payer", "test_add.py::test_gone"] } : r)) };
    expect(failure(() => run(checked.s, "recordImportRules", { importId: checked.importId, ...unknown }, at(25))).message).toBe('Not in the baseline report: "test_add.py::test_gone".');
    const extra = { ...reading, cases: [...reading.cases, { suite: "test_x.py", name: "test_y", status: "passed" }] };
    expect(failure(() => run(checked.s, "recordImportRules", { importId: checked.importId, ...extra }, at(25))).message).toBe('The import keeps only the cases its rules name; no rule names "test_x.py::test_y".');
    const notRun = tallyImport("checked", { checks: "not-run" });
    expect(failure(() => run(notRun.s, "recordImportRules", { importId: notRun.importId, ...reading }, at(25))).message).toBe("The import's tests did not run, so no rule can name a test.");
    const started = tallyImport("started");
    expect(failure(() => run(started.s, "recordImportRules", { importId: started.importId, ...reading }, at(25))).message).toBe("The rules reader reads the baseline report: record the import's checks first.");
    // A reading that fits no pattern, or names no source, is refused at the boundary with every problem named.
    const bad = { rules: [{ id: "R1", area: "x", text: "tally adds things", tests: [], sources: [] }], cases: [] };
    expect(failure(() => run(checked.s, "recordImportRules", { importId: checked.importId, ...bad }, at(25))).message).toBe('the reading: rule R1 fits no pattern: "tally adds things"; rule R1: "sources" is a list of 1 to 5 { "from", "ref", "says" }');
  });

  it("the capture says for each screen, terminal demo and TUI what it recorded, or why nothing, and which way it ran", () => {
    const sc = tallyImport("parts");
    const cast = (id: string) => ({ artifactId: id, version: 1, status: "captured", files: [{ path: `${id}/demo.cast`, type: "cast", bytes: 10, sha256: "c".repeat(64) }] });
    const capture = (parts: object[], path?: object) => run(sc.s, "recordImportCapture", { importId: sc.importId, capture: { parts, ...(path ? { path } : {}) } }, at(60));
    const all = [cast(sc.parts.add!), cast(sc.parts.split!), cast(sc.parts.report!)];
    expect(failure(() => capture(all.slice(0, 2))).message).toBe("The capture leaves out tally report: it says for each part what it recorded, or why nothing.");
    expect(failure(() => capture([...all, cast(sc.parts.splitting!)])).message).toBe(`${sc.parts.splitting} is not a screen, terminal demo or TUI of the import.`);
    expect(failure(() => capture(all, { via: "recorder", image: "x" })).message).toBe('The capture\'s path is { "via": "environment", "from", "image" }.');
    const ok = capture(all, { via: "environment", from: "setting", image: "python:3.13@sha256:abc", prepare: "ran" }).state;
    expect(ok.studio.import!.capture).toMatchObject({ at: at(60), path: { via: "environment", from: "setting", image: "python:3.13@sha256:abc", prepare: "ran" } });
    expect(I.importStatus(ok)).toBe("review");
  });

  it("a late or repeated report changes nothing", () => {
    const sc = tallyImport("review");
    const again = (name: string, args: object) => expect(run(sc.s, name, { importId: sc.importId, ...args }, at(70)).state).toBe(sc.s);
    again("recordImportChecks", { result: { status: "not-run", reason: "late" } });
    again("recordImportRules", tallyReading());
    again("recordImportCapture", { capture: { parts: [] } });
    expect(tallyCases()).toHaveLength(22);
  });

  it("the service stops it: its queued runs fail, its running runs are asked to stop, and nothing new starts", () => {
    const sc = tallyImport("checked");
    const words = run<{ runId: string }>(sc.s, "startStudioRun", { kind: "designer", round: 0, brief: "The words.", importStep: "words" }, at(20));
    const s = run(words.state, "stopImport", { importId: sc.importId, reason: "The reader failed twice." }, at(21)).state;
    expect(I.importStatus(s)).toBe("stopped");
    expect(s.studio.runs.find((r) => r.id === words.result.runId)).toMatchObject({ status: "failed", note: "not started: the import stopped" });
    expect(failure(() => run(s, "startStudioRun", { kind: "reader", round: 0, brief: "The rules.", importStep: "rules" }, at(22))).message).toBe("The import stopped: The reader failed twice..");
    expect(run(s, "stopImport", { importId: sc.importId, reason: "again" }, at(23)).state).toBe(s);
  });

  it("a reader run reads only for the import, in round 0, as the rules step", () => {
    const sc = tallyImport("checked");
    expect(failure(() => run(sc.s, "startStudioRun", { kind: "reader", round: 0, brief: "Read." }, at(20))).message).toBe("A reader run reads a repository for its import: it names the import's step.");
    expect(failure(() => run(sc.s, "startStudioRun", { kind: "designer", round: 0, brief: "Read.", importStep: "rules" }, at(20))).message).toBe("The import's rules step is a reader's run, not a designer's.");
    const r = run<{ runId: string }>(sc.s, "startStudioRun", { kind: "reader", round: 0, brief: "Read.", importStep: "rules" }, at(20));
    expect(r.state.studio.runs.at(-1)).toMatchObject({ id: r.result.runId, kind: "reader", importStep: "rules", provider: "claude", status: "queued" });
  });

  it("the owner's answers are kept in order; each names a rule or a part of the import", () => {
    const sc = tallyImport("review");
    const s = run(sc.s, "answerImport", { answers: [{ on: { rule: "R15" }, option: "confirm" }, { on: { part: sc.parts.add }, option: "correct", correction: "change", text: "Show the split per person." }] }, at(100)).state;
    expect(s.studio.import!.answers).toEqual([
      { on: { rule: "R15" }, option: "confirm", at: at(100) },
      { on: { part: sc.parts.add }, option: "correct", correction: "change", text: "Show the split per person.", at: at(100) },
    ]);
    expect(failure(() => run(sc.s, "answerImport", { answers: [{ on: { rule: "R99" }, option: "confirm" }] }, at(100))).message).toBe('The import has no rule "R99".');
    expect(failure(() => run(sc.s, "answerImport", { answers: [{ on: { rule: "R15" }, option: "correct" }] }, at(100))).message).toBe('"Correct" says whether tally should do something else or the reader misread it; no other option does.');
    expect(failure(() => run(tallyImport("checked").s, "answerImport", { answers: [{ on: { rule: "R1" }, option: "confirm" }] }, at(100))).message).toBe("The import is still reading: there is nothing to answer yet.");
  });

  it("the owner may change the import budget while it goes on", () => {
    const sc = tallyImport("read");
    expect(run(sc.s, "setImportBudget", { budgetUsd: 5 }, at(30)).state.studio.import!.budgetUsd).toBe(5);
    expect(failure(() => run(tallyImport("baseline").s, "setImportBudget", { budgetUsd: 5 }, at(130))).message).toBe("The import is locked in: it is the baseline.");
    expect(failure(() => runCommand(sc.s, "setImportBudget", { budgetUsd: -1 }, at(30)))).toBeInstanceOf(ControlError);
  });
});

// ---------- phase B: the derivations ----------

/** The import of a scene, cloned, for a pure derivation's input. */
const importOf = (s: State) => structuredClone(s.studio.import!);
const ruleOf = (s: State, id: string) => s.studio.import!.reading!.rules.find((r) => r.id === id)!;
const itemOf = (s: State, title: string) => B.blueprintItems(s).find((i) => i.title === title)!;
/** The baseline Lock in's arguments for the summary as it stands. */
const baselineArgsOf = (s: State) => ({ draftRev: I.baselineSummary(s).draftRev, summaryDigest: B.summaryDigest(I.baselineSummary(s)) });

describe("a rule's confidence (2.3), derived from the baseline run and the sources, never the reader's claim", () => {
  it("row 1: a test the rule names failed or ended with an error: a conflict, and it wins over every other row", () => {
    const sc = tallyImport("review", { checks: { failing: ["test_split.py::test_even", "test_add.py::test_rejects_other_currency"] } });
    expect(I.ruleConfidence(importOf(sc.s), ruleOf(sc.s, "R8"))).toEqual({ level: "conflict", why: "test-fails", test: { suite: "test_split.py", name: "test_even", status: "failed", message: "AssertionError: the output differs" } });
    // R13's README differs too; the failing test decides.
    expect(I.ruleConfidence(importOf(sc.s), ruleOf(sc.s, "R13"))).toMatchObject({ level: "conflict", why: "test-fails" });
    const errored = importOf(sc.s);
    errored.reading!.cases = errored.reading!.cases.map((c) => (c.name === "test_unknown_payer" ? { ...c, status: "error" as const } : c));
    expect(I.ruleConfidence(errored, ruleOf(sc.s, "R3"))).toMatchObject({ level: "conflict", why: "test-fails", test: { name: "test_unknown_payer", status: "error" } });
  });

  it("row 2: two sources say different things: a conflict, with the source that differs", () => {
    const { s } = tallyImport("review");
    expect(I.ruleConfidence(importOf(s), ruleOf(s, "R13"))).toEqual({ level: "conflict", why: "sources-differ", source: { from: "docs", ref: "README.md, Currency", says: "a currency on each expense", differs: true } });
    expect(I.ruleConfidence(importOf(s), ruleOf(s, "R14"))).toMatchObject({ level: "conflict", why: "sources-differ", source: { says: "--csv" } });
  });

  it("row 3: it names at least one test, and every one passed: confirmed", () => {
    const { s } = tallyImport("review");
    expect(I.ruleConfidence(importOf(s), ruleOf(s, "R1"))).toEqual({ level: "confirmed", tests: 2 });
    expect(I.ruleConfidence(importOf(s), ruleOf(s, "R2"))).toEqual({ level: "confirmed", tests: 3 });
  });

  it("row 4: no test, only skipped tests, or no baseline run: inferred", () => {
    const { s } = tallyImport("review");
    expect(I.ruleConfidence(importOf(s), ruleOf(s, "R15"))).toEqual({ level: "inferred", why: "no-test" });
    const skipped = importOf(s);
    skipped.reading!.cases = skipped.reading!.cases.map((c) => (c.suite === "test_ledger.py" ? { ...c, status: "skipped" as const } : c));
    expect(I.ruleConfidence(skipped, ruleOf(s, "R11"))).toEqual({ level: "inferred", why: "skipped" });
    const notRun = tallyImport("review", { checks: "not-run" }).s;
    expect(I.ruleConfidence(importOf(notRun), ruleOf(notRun, "R1"))).toEqual({ level: "inferred", why: "no-baseline-run" });
  });
});

describe("the review's questions: every conflict, then every important guess, at most 10, conflicts first (Q4)", () => {
  it("tally asks about its 2 conflicts and 3 important guesses, in the rules' order; confirmed rules are listed, not asked", () => {
    const { s } = tallyImport("review");
    const q = I.importQuestions(importOf(s));
    expect(q.asked.map((x) => [x.ruleId, x.kind])).toEqual([
      ["R13", "conflict"],
      ["R14", "conflict"],
      ["R15", "guess"],
      ["R16", "guess"],
      ["R17", "guess"],
    ]);
    expect(q.notAsked).toEqual([]);
  });

  it("past 10, the rest are not asked: they go in as the code has them and stay open; the order is stable and conflicts come first", () => {
    const { s } = tallyImport("review");
    const many = importOf(s);
    // 12 more important guesses before the conflicts in the rules' order: R1–R12 lose their tests.
    many.reading!.rules = many.reading!.rules.map((r) => (Number(r.id.slice(1)) <= 12 ? { ...r, tests: [], important: "It matters." } : r));
    const q = I.importQuestions(many);
    expect(q.asked.map((x) => x.ruleId)).toEqual(["R13", "R14", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
    expect(q.notAsked.map((x) => x.ruleId)).toEqual(["R9", "R10", "R11", "R12", "R15", "R16", "R17"]);
    expect(I.importQuestions(structuredClone(many))).toEqual(q);
  });

  it("each question's options: a conflict keeps the code or takes the source that differs, or neither; a guess is confirmed or corrected", () => {
    const { s } = tallyImport("review");
    const q = I.importQuestions(importOf(s)).asked;
    expect(q[0].options).toEqual([
      { id: "keep", keeps: true, label: "The test: one currency per group" },
      { id: "source-2", keeps: false, label: "The docs: a currency on each expense" },
      { id: "neither", keeps: false, label: "Neither", needsText: true },
    ]);
    expect(q[1].options.map((o) => o.label)).toEqual(["The code: --format csv", "The docs: --csv", "Neither"]);
    expect(q[2].options).toEqual([
      { id: "confirm", keeps: true, label: "Confirm" },
      { id: "correct", keeps: false, label: "Correct", needsText: true },
    ]);
    const failing = tallyImport("review", { checks: { failing: ["test_split.py::test_even"] } }).s;
    expect(I.importQuestions(importOf(failing)).asked[0].options).toEqual([
      { id: "keep", keeps: true, label: "The code: as it is today" },
      { id: "test", keeps: false, label: "The test: test_split.py::test_even" },
      { id: "neither", keeps: false, label: "Neither", needsText: true },
    ]);
    // C15: "Correct" on a confirmed rule or on a part offers the same two choices as on a guess.
    expect(I.importOptions(s, { rule: "R1" }).map((o) => o.id)).toEqual(["confirm", "correct"]);
    expect(I.importOptions(s, { part: I.importParts(s)[1].id }).map((o) => o.id)).toEqual(["confirm", "correct"]);
  });

  it("an answer names one of its item's options, and Neither and Correct come with the owner's words", () => {
    const { s } = tallyImport("review");
    const refusal = (a: object) => failure(() => run(s, "answerImport", { answers: [a] }, at(100))).message;
    expect(refusal({ on: { rule: "R15" }, option: "source-2" })).toBe('R15 has no option "source-2": confirm, correct.');
    expect(refusal({ on: { rule: "R13" }, option: "neither" })).toBe("Neither needs your words: what is right.");
    expect(refusal({ on: { rule: "R15" }, option: "correct", correction: "change" })).toBe("Correct needs your words: what is right.");
  });
});

describe("what an answer does (2.3)", () => {
  it("keeps the code, asks for a change, fixes a misreading, or stays open; the newest answer on an item counts", () => {
    const sc = tallyImport("answered");
    const imp = sc.s.studio.import!;
    expect(["R13", "R14", "R15", "R16", "R17"].map((id) => I.itemAnswerEffect(imp, { rule: id }))).toEqual(["change", "kept", "kept", "fixed", "open"]);
    const later = run(sc.s, "answerImport", { answers: [{ on: { rule: "R13" }, option: "keep" }] }, at(101)).state;
    expect(I.itemAnswerEffect(later.studio.import!, { rule: "R13" })).toBe("kept");
  });

  it("a change waits as a change request on its part, open while no newer version of the part exists; the baseline keeps what the code does", () => {
    const sc = tallyImport("answered");
    expect(I.changeRequests(sc.s).map((c) => [c.on, c.artifactId, c.open, c.text])).toEqual([[{ rule: "R13" }, sc.parts.add, true, "The docs: a currency on each expense"]]);
    const base = tallyImport("baseline");
    expect(itemOf(base.s, "tally add").version).toBe(1);
    // The lead's round designs it: once a newer version of the part exists, the request is closed, and still listed.
    const r1 = run<{ n: number }>(base.s, "openRound", { focus: "experience" }, at(130));
    const v1 = S.getArtifact(r1.state, base.parts.add!, 1);
    const designed = run(r1.state, "addStudioArtifact", { artifactId: v1.id, round: r1.result.n, kind: v1.kind, title: v1.title, devices: ["terminal"], variants: v1.variants, files: v1.files, madeBy: { role: "designer", provider: "claude", model: "m", attemptId: "run-r1" } }, at(131)).state;
    expect(I.changeRequests(designed).map((c) => [c.on, c.open])).toEqual([[{ rule: "R13" }, false]]);
  });

  it("a misreading before the Lock in is fixed: the part's next version waits for a designer's fix, and the baseline holds that version", () => {
    const sc = tallyImport("answered");
    expect(I.importFixesDue(sc.s).map((f) => [f.artifactId, f.text])).toEqual([[sc.parts.ledger, "A negative amount is an error today; tally add stops."]]);
    expect(failure(() => run(sc.s, "lockInBaseline", { draftRev: 0, summaryDigest: "x" }, at(110))).message).toBe("A part waits for its fix: The ledger. The baseline holds the fixed version.");
    const fix = run<{ runId: string }>(sc.s, "startStudioRun", { kind: "designer", round: 0, artifactId: sc.parts.ledger, brief: "Fix R16.", importStep: "fix" }, at(105));
    expect(I.importFixesDue(fix.state)).toEqual([]);
    expect(I.baselineBlocker(fix.state)).toBe("A part waits for its fix: The ledger. The baseline holds the fixed version.");
    const started = R.dispatchStudioRuns(fix.state, at(105), { simulated: ["claude"] }).state;
    const v1 = S.getArtifact(started, sc.parts.ledger!, 1);
    const v2 = run(started, "addStudioArtifact", { artifactId: sc.parts.ledger, round: 0, kind: v1.kind, title: v1.title, devices: [], variants: v1.variants, files: v1.files, madeBy: { role: "designer", provider: "claude", model: "m", attemptId: fix.result.runId }, provenance: { files: ["tally/ledger.py"] }, rules: [{ variant: "a", path: "ledger/rules.json", rules: [{ id: "R16", text: "If the amount is below zero, then the CLI shall stop." }] }] }, at(106)).state;
    const done = R.completeStudioRun(v2, fix.result.runId, at(107), { summary: "fixed" });
    expect(I.importFixesDue(done)).toEqual([]);
    const locked = run(done, "lockInBaseline", baselineArgsOf(done), at(120)).state;
    expect(itemOf(locked, "The ledger").version).toBe(2);
  });

  it("after the Lock in, every answer that is not a keep is a change (Q6, C15), and an open question can still be answered", () => {
    const base = tallyImport("baseline");
    const s = run(base.s, "answerImport", { answers: [{ on: { rule: "R17" }, option: "confirm" }, { on: { rule: "R12" }, option: "correct", correction: "change", text: "Keep a backup." }, { on: { rule: "R9" }, option: "correct", correction: "misread", text: "Newest first." }] }, at(130)).state;
    const imp = s.studio.import!;
    expect(["R17", "R12", "R9", "R16"].map((id) => I.itemAnswerEffect(imp, { rule: id }))).toEqual(["kept", "change", "change", "fixed"]);
    expect(I.importFixesDue(s)).toEqual([]);
    expect(I.changeRequests(s).map((c) => (c.on as { rule: string }).rule)).toEqual(["R13", "R12", "R9"]);
  });
});

describe("the baseline Lock in (C4): the owner's, in Vision, once, on the summary the owner saw", () => {
  it("is refused while the import reads, after it stopped, outside Vision, and once a revision is in force", () => {
    const parts = tallyImport("parts").s;
    expect(failure(() => run(parts, "lockInBaseline", baselineArgsOf(parts), at(110))).message).toBe("The import is still reading: the baseline waits for the review.");
    const review = tallyImport("review");
    const stopped = run(review.s, "stopImport", { importId: review.importId, reason: "The owner left." }, at(105)).state;
    expect(failure(() => run(stopped, "lockInBaseline", baselineArgsOf(stopped), at(110))).message).toBe("The import stopped: The owner left.");
    const building = structuredClone(review.s);
    building.project.stage = "building";
    expect(failure(() => run(building, "lockInBaseline", baselineArgsOf(building), at(110))).message).toBe("The baseline is your first Lock in, in Vision.");
    const base = tallyImport("baseline").s;
    expect(failure(() => run(base, "lockInBaseline", baselineArgsOf(base), at(130))).message).toBe("The baseline is the first Lock in, and the blueprint has one already.");
  });

  it("compares and sets: a summary shown before the draft changed is refused", () => {
    const sc = tallyImport("review");
    const seen = baselineArgsOf(sc.s);
    const changed = run(sc.s, "approveArtifact", { artifactId: sc.parts.add, version: 1 }, at(105)).state;
    expect(failure(() => run(changed, "lockInBaseline", seen, at(110))).name).toBe("StaleWriteError");
    expect(run(changed, "lockInBaseline", baselineArgsOf(changed), at(110)).state.blueprint.revisions[0].lockIn!.baseline).toEqual({ importId: sc.importId, commit: TALLY_COMMIT });
  });
});

describe("the summary and the rest of the build leave the baseline's items out (2.4)", () => {
  it("the baseline summary adds every part, with no new work and no PE estimate; after it, nothing is left to build", () => {
    const { s } = tallyImport("review");
    const summary = I.baselineSummary(s);
    expect(summary.changes.added.map((i) => i.title)).toEqual(["Words", "tally add", "tally split", "tally report", "Splitting", "The ledger"]);
    expect(summary.newWork).toEqual([]);
    expect(summary.budgets.items).toEqual([]);
    expect(restOfBuild(tallyImport("baseline").s)).toEqual({ usd: [0, 0], parts: 0, missing: 0 });
  });
});

describe("where a baseline item stands in Design and reality (2.4)", () => {
  const view = (s: State, title: string) => itemFactoryStatus(s, itemOf(s, title).id)!;
  const TITLES = ["Words", "tally add", "tally split", "tally report", "Splitting", "The ledger"];

  it("in force, built and verified, or built and not verified with the first gap; built by the repository at the import's commit", () => {
    const { s, importId, parts } = tallyImport("baseline");
    expect(TITLES.map((t) => [t, view(s, t).status, view(s, t).notVerified])).toEqual([
      ["Words", "in-force", undefined],
      ["tally add", "built-and-verified", undefined],
      ["tally split", "built-and-verified", undefined],
      ["tally report", "built-not-verified", { why: "rules-unproved", noTest: 1, skipped: 0 }],
      ["Splitting", "built-not-verified", { why: "rules-unproved", noTest: 1, skipped: 0 }],
      ["The ledger", "built-not-verified", { why: "rules-unproved", noTest: 2, skipped: 0 }],
    ]);
    expect(view(s, "tally add").baseline).toEqual({ importId, commit: TALLY_COMMIT, capture: { artifactId: parts.add, version: 1, status: "captured", files: [{ path: `${parts.add}/demo.cast`, type: "cast", bytes: 2048, sha256: "c".repeat(64) }] } });
    expect(view(s, "Splitting").baseline).toEqual({ importId, commit: TALLY_COMMIT });
  });

  it("fails a check when a test a rule names failed", () => {
    const { s } = tallyImport("baseline", { checks: { failing: ["test_split.py::test_even"] } });
    expect(view(s, "tally split").status).toBe("fails-a-check");
    expect(view(s, "tally split").rules!.results.find((r) => r.id === "R8")).toMatchObject({ status: "failed", message: "test_even: AssertionError: the output differs" });
  });

  it("a recorded kind with no recording or with a warning is not verified, and a document with no rules is not checked", () => {
    const { s, parts } = tallyImport("baseline");
    const edited = structuredClone(s);
    const cap = edited.studio.import!.capture!.parts;
    cap[0] = { artifactId: parts.add!, version: 1, status: "none", reason: "capture-failed", detail: "The tape stopped at line 3." };
    cap[1] = { ...(cap[1] as Extract<(typeof cap)[number], { status: "captured" }>), warnings: ["The demo printed an error."] };
    delete edited.studio.artifacts.find((a) => a.id === parts.splitting)!.rules;
    expect(view(edited, "tally add").notVerified).toEqual({ why: "no-evidence", reason: "capture-failed", detail: "The tape stopped at line 3." });
    expect(view(edited, "tally split").notVerified).toEqual({ why: "evidence-warning", warning: "The demo printed an error." });
    expect(view(edited, "Splitting").notVerified).toEqual({ why: "kind-not-checked" });
    // Without Docker nothing ran: every rule is inferred, and nothing was recorded.
    const notRun = tallyImport("baseline", { checks: "not-run" }).s;
    expect(view(notRun, "tally split").notVerified).toEqual({ why: "rules-unproved", noTest: 2, skipped: 0 });
  });

  it("once a newer version of a part is in force, the factory's rules apply: designed until a task builds it", () => {
    const sc = tallyImport("baseline");
    let s = M.editVision(sc.s, 1, "tally splits shared costs in a group.", "", "The import's draft", at(130));
    const r1 = run<{ n: number }>(s, "openRound", { focus: "experience" }, at(131));
    const v1 = S.getArtifact(r1.state, sc.parts.report!, 1);
    const v2 = run(r1.state, "addStudioArtifact", { artifactId: v1.id, round: r1.result.n, kind: v1.kind, title: v1.title, devices: ["terminal"], variants: v1.variants, files: v1.files, madeBy: { role: "designer", provider: "claude", model: "m", attemptId: "run-r1" } }, at(132)).state;
    s = run(peAgrees(v2, v1.id, 2, ["a"], at(133)), "approveArtifact", { artifactId: v1.id, version: 2 }, at(134)).state;
    s = startFactoryAsOwner(s, at(135));
    const report = view(s, "tally report");
    expect([report.item.version, report.status, report.baseline]).toEqual([2, "designed", undefined]);
    expect(view(s, "tally add").status).toBe("built-and-verified");
  });
});

describe("rule results: the baseline run proves a rule by the tests it names (2.4)", () => {
  it("a test proves a line by its id, with no tag; the baseline run counts at the Lock in time; a line with no test says why", () => {
    const { s, importId } = tallyImport("baseline");
    const add = ruleResults(s, itemOf(s, "tally add").id)!;
    expect(add.results.map((x) => [x.id, x.status, x.tests])).toEqual([
      ["R1", "passed", 2],
      ["R2", "passed", 3],
      ["R3", "passed", 1],
      ["R4", "passed", 2],
      ["R13", "passed", 1],
    ]);
    expect(add.results[0].from).toEqual({ importId, sha: TALLY_COMMIT, at: at(120), simulated: true });
    const report = ruleResults(s, itemOf(s, "tally report").id)!;
    expect(report.results.find((x) => x.id === "R14")).toMatchObject({ status: "no-test", tests: 0, message: `No test proves it yet: the import's tests name none, and no landed checks carry [${itemOf(s, "tally report").id} R14].` });
    const notRun = tallyImport("baseline", { checks: "not-run" }).s;
    expect(ruleResults(notRun, itemOf(notRun, "tally add").id)!.results[0]).toMatchObject({ status: "no-test", message: "The import's tests did not run: Docker is not available on this computer, so the tests did not run." });
  });
});

describe("the import's spend and its stop (2.5)", () => {
  /** The scene with its import's runs real, not simulated, each at this reported cost (or with no usage: null). */
  const priced = (s0: State, usd: number | null) => {
    const s = structuredClone(s0);
    for (const r of s.studio.runs) {
      if (!r.importStep) continue;
      delete r.simulated;
      if (usd === null) delete r.usage;
      else r.usage = { costUsd: usd };
    }
    return s;
  };

  it("splits at the baseline Lock in: the runs asked before it are the import's, those after it the building's", () => {
    const base = priced(tallyImport("baseline").s, 0.5);
    expect([importSpend(base).usd, importSpend(base).runs, buildingSpend(base).usd]).toEqual([2, 4, 0]); // the words, the rules, the parts and one fix, at $0.50 each
    const later = structuredClone(base);
    later.leadRuns.push({ id: "lead-after", trigger: "message", provider: "claude", model: "m", startedAt: at(130), endedAt: at(131), outcome: "completed", messageIds: [], usage: { costUsd: 0.2 } } as unknown as State["leadRuns"][number]);
    expect([importSpend(later).usd, buildingSpend(later).usd]).toEqual([2, 0.2]);
    // A project that started from an idea has no import spend: all of it is building.
    expect(importSpend(buildSeed(T0, { inFlightRuns: false }))).toEqual({ usd: 0, runs: 0, unknown: [] });
  });

  it("at the import budget, the import's runs wait; raising it starts them again; the building budget plays no part", () => {
    const s = priced(tallyImport("read").s, 1.6);
    expect(importStop(s)).toMatchObject({ budgetUsd: 3, countedUsd: 3.2, why: "The import budget is reached: $3.20 of $3.00" });
    const withBuilding = run(s, "setBudgets", { buildingUsd: 1, maintenanceUsdPerMonth: null }, at(39)).state;
    expect(budgetStop(withBuilding)).toBeUndefined();
    const asked = R.requestStudioRun(withBuilding, { kind: "designer", round: 0, brief: "The parts.", importStep: "parts" }, at(40)).state;
    expect(R.dispatchStudioRuns(asked, at(40), { simulated: ["claude"] }).started).toEqual([]);
    const raised = run(asked, "setImportBudget", { budgetUsd: 5 }, at(41)).state;
    expect(R.dispatchStudioRuns(raised, at(41), { simulated: ["claude"] }).started).toHaveLength(1);
    expect(importStop(priced(tallyImport("baseline").s, 1.6))).toBeUndefined();
  });

  it("an unknown cost counts as today: a Claude run with no recorded usage counts at the run limit, never $0", () => {
    const s = priced(tallyImport("read").s, null);
    expect(importSpend(s).unknown.map((u) => [u.reason, u.countedUsd])).toEqual([
      ["no-usage", 2],
      ["no-usage", 2],
    ]);
    expect(importStop(s)?.why).toBe("The import budget is reached: $4.00 of $3.00, of which $4.00 is an estimate for 2 unrecorded costs");
  });
});

describe("the reader's helpers (ORC-031): the import's own cap, never the probes' setting", () => {
  it("a reader run may start helpers only under the cap the owner set on the import", () => {
    const reader = (s: State) => {
      const r = R.requestStudioRun(s, { kind: "reader", round: 0, brief: "The rules.", importStep: "rules" }, at(20));
      return R.dispatchStudioRuns(r.state, at(20), { simulated: ["claude"] }).state.studio.runs.find((x) => x.id === r.runId)!;
    };
    expect(reader(tallyImport("checked", { helpers: 2 }).s).allowSubagents).toEqual({ cap: 2 });
    const probesOnly = setResearchHelpers(setSubagentProviders(tallyImport("checked").s, ["claude"], at(15)), PROBE_KEY, 5, at(15));
    expect(reader(probesOnly).allowSubagents).toBeUndefined();
  });
});

describe("no PE review of the import's parts (C6)", () => {
  it("a part reaches the owner at once, and the service asks for no PE run on it", () => {
    const { s, parts } = tallyImport("review");
    const add = S.getArtifact(s, parts.add!, 1);
    expect(S.peReview(s, add)).toEqual({ status: "not-reviewed", why: "it reproduces the code as it is today, which its tests and its recording check" });
    expect(R.askForPeReviews(s, at(70)).studio.runs.filter((r) => r.kind === "pe")).toEqual([]);
  });
});
