// ORC-032, the import of an existing repository into Vision: its commands, as the owner and the service send them,
// on tally (an invented CLI, sample data). The derivations (confidence, questions, answers' effects, statuses, rule
// results, spend) have their own describe blocks below.

import { describe, expect, it } from "vitest";
import { InvalidCommandError, SERVICE_COMMANDS, runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import { TALLY_COMMIT, TALLY_SIZE, at, T0, tallyCases, tallyImport, tallyReading } from "../testing/import";
import { run } from "../testing/studio";
import { ControlError, type State } from "../types";
import * as B from "./blueprint";
import * as I from "./import";
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
      ["The ledger", 1, "approved"],
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
