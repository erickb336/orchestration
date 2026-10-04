// ORC-032 R1-A, what the import's screens read from the domain (the contract part B builds on): the import's stop and
// what it holds (QA-F1), round 0's lead message (UX-4), each question's title (UX-7), a review sent with everything
// open (UX-3), and no test cited when the tests did not run (UX-10). On tally (sample data).

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { at, baselineArgs, tallyImport, tallyReading } from "../testing/import";
import { run } from "../testing/studio";
import type { State } from "../types";
import * as I from "./import";
import * as R from "./runs";

const SIM = { simulated: ["claude", "codex"] as ("claude" | "codex")[] };
const due = (s: State) => M.leadDue(s, Date.parse(at(500)), 600);
/** The import spent $1 on its first run: at a $0.50 budget, it is at its stop. */
const spent = (s: State): State => {
  const x = structuredClone(s);
  x.studio.runs[0].usage = { costUsd: 1 } as never;
  return x;
};

describe("the import's stop, at every stage before the baseline (QA-F1)", () => {
  it("in review it holds the lead's message on round 0; a raise lets the lead write it", () => {
    let s = run(spent(tallyImport("review").s), "setImportBudget", { budgetUsd: 0.5 }, at(150)).state;
    const hold = I.importHold(s)!;
    expect(hold.stop).toMatchObject({ budgetUsd: 0.5, countedUsd: 1 });
    expect(hold.holds).toEqual([{ step: "review" }]);
    expect(due(s)).toBeNull();
    s = run(s, "setImportBudget", { budgetUsd: 5 }, at(151)).state;
    expect(I.importHold(s)).toBeUndefined();
    expect(due(s)).toBe("message");
  });

  it("on the Baseline screen it holds a fix the owner asked for; a raise starts it", () => {
    const sc = tallyImport("answered");
    let s = run(spent(sc.s), "setImportBudget", { budgetUsd: 0.5 }, at(150)).state;
    // The lead's reply answered the review; the fix of The ledger (a misread) waits at the stop.
    const lead = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(151));
    s = M.completeLeadRun(lead.state, lead.runId, { reply: "I read tally.", proposals: [] }, at(152));
    const [fix] = I.importFixesDue(s);
    s = R.requestStudioRun(s, { kind: "designer", round: 0, artifactId: fix.artifactId, brief: "Fix it.", importStep: "fix" }, at(153)).state;
    expect(R.dispatchStudioRuns(s, at(154), SIM).started).toEqual([]);
    expect(I.importHold(s)!.holds).toEqual([{ step: "fix", artifactId: sc.parts.ledger }]);
    expect(I.baselineBlocker(s)).toBe("A part waits for its fix: The ledger. The baseline holds the fixed version.");
    s = run(s, "setImportBudget", { budgetUsd: 5 }, at(155)).state;
    expect(R.dispatchStudioRuns(s, at(156), SIM).started).toHaveLength(1);
  });

  it("holds nothing after the baseline: the building budget counts from there", () => {
    const s = spent(tallyImport("baseline").s);
    expect(I.importHold(s)).toBeUndefined();
    expect(() => run(s, "setImportBudget", { budgetUsd: 5 }, at(150))).toThrow("The import is locked in: it is the baseline.");
  });
});

describe("the lead's reply to the import's review is round 0's message (UX-4)", () => {
  it("is recorded on round 0 in the review, and stays after the Lock in", () => {
    const { s } = tallyImport("review");
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(200));
    const done = M.completeLeadRun(r.state, r.runId, { reply: "I read tally at commit c0ffee0: 17 rules, 2 conflicts.", proposals: [] }, at(201));
    expect(done.studio.rounds.find((x) => x.n === 0)!.lead).toEqual({ message: "I read tally at commit c0ffee0: 17 rules, 2 conflicts.", questions: [] });
    const answered = run(done, "answerImport", { answers: [] }, at(202)).state;
    expect(I.importStatus(answered)).toBe("review");
  });

  it("is recorded when the reply ends after the Lock in", () => {
    const sc = tallyImport("answered", { answers: [] });
    const r = M.startLeadRun(sc.s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(110));
    const locked = run(r.state, "lockInBaseline", baselineArgs(r.state), at(111)).state;
    expect(I.importStatus(locked)).toBe("locked-in");
    const done = M.completeLeadRun(locked, r.runId, { reply: "The baseline is in force.", proposals: [] }, at(112));
    expect(done.studio.rounds.find((x) => x.n === 0)!.lead?.message).toBe("The baseline is in force.");
  });

  it("a reply to the owner's message in review is the conversation's, not round 0's", () => {
    let s = run(tallyImport("review").s, "postMessage", { text: "Why is Currency a conflict?" }, at(200)).state;
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(201));
    s = M.completeLeadRun(r.state, r.runId, { reply: "The README names a currency on each expense.", proposals: [] }, at(202));
    expect(s.studio.rounds.find((x) => x.n === 0)!.lead).toBeUndefined();
  });
});

describe("each question says what it asks (UX-7)", () => {
  it("takes the reader's title, else the rule's condition or what it does, never the area alone", () => {
    const imp = tallyImport("review").s.studio.import!;
    expect(I.importQuestions(imp).asked.map((q) => [q.ruleId, q.title])).toEqual([
      ["R13", "Currency"],
      ["R14", "CSV reports"],
      ["R15", "Rounding"],
      ["R16", "Refunds"],
      ["R17", "Where the ledger lives"],
    ]);
    expect(I.ruleTitle({ text: "If the amount is below zero, then the CLI shall record a refund." })).toBe("If the amount is below zero");
    expect(I.ruleTitle({ text: "The ledger shall live in .tally.json in the folder where you run tally." })).toBe("Live in .tally.json in the folder where you run tally");
    expect(I.ruleTitle({ text: "When you give --since and --format csv and --until at once, the report shall show only the rows between them." })).toBe("When you give --since and --format csv and --until at once");
    expect(I.ruleTitle({ text: "The CLI shall keep every expense that anyone in the group ever added, with its payer and its people and its date." })).toBe("Keep every expense that anyone in the group ever added,…");
  });

  it("checks the reader's title at the boundary: one line of at most 60 characters", () => {
    const one = (title: unknown) => I.parseImportReading({ rules: [{ id: "R1", area: "tally add", title, text: "The CLI shall add.", tests: [], sources: [{ from: "code", ref: "tally/cli.py", says: "adds" }] }], cases: [] });
    expect(one("Adding")).toMatchObject({ ok: true, value: { rules: [{ title: "Adding" }] } });
    expect(one("x".repeat(61))).toEqual({ ok: false, errors: ['rule R1: "title" is one line of 1 to 60 characters'] });
    const none = I.parseImportReading({ rules: [{ id: "R1", area: "tally add", text: "The CLI shall add.", tests: [], sources: [{ from: "code", ref: "tally/cli.py", says: "adds" }] }], cases: [] });
    expect(none.ok && none.value.rules[0].title).toBeUndefined();
  });
});

describe("the owner sends the review with everything open (UX-3)", () => {
  it("records the send: every item stays open, and the baseline may follow", () => {
    const { s } = tallyImport("review");
    expect(s.studio.import!.sentAt).toBeUndefined();
    const sent = run(s, "answerImport", { answers: [] }, at(150)).state;
    expect(sent.studio.import!.sentAt).toBe(at(150));
    expect(sent.studio.import!.answers).toEqual([]);
    expect(I.itemAnswerEffect(sent.studio.import!, { rule: "R16" })).toBe("open");
    expect(sent.events.at(-1)!.message).toBe("You sent the import's review with every question open");
    expect(I.baselineBlocker(sent)).toBeUndefined();
    expect(() => run(tallyImport("read").s, "answerImport", { answers: [] }, at(150))).toThrow("The import is still reading: there is nothing to answer yet.");
  });
});

describe("when the tests did not run, no conflict cites a test (UX-10)", () => {
  it("leaves a test's source out of the confidence and the options; the docs that differ stay a conflict", () => {
    const sc = tallyImport("review", { checks: "not-run" });
    const imp = structuredClone(sc.s.studio.import!);
    // The reader still cites a test file for Currency (R13), though the tests did not run.
    imp.reading!.rules.find((r) => r.id === "R13")!.sources = [
      { from: "test", ref: "test_add.py::test_rejects_other_currency", says: "one currency per group" },
      { from: "docs", ref: "README.md, Currency", says: "a currency on each expense", differs: true },
    ];
    const r13 = I.importQuestions(imp).asked.find((q) => q.ruleId === "R13")!;
    expect(r13.confidence).toMatchObject({ level: "conflict", why: "sources-differ", source: { from: "docs" } });
    expect(r13.options.map((o) => [o.id, o.label])).toEqual([
      ["keep", "The code: The ledger shall keep one currency per group, set in .tally.json."],
      ["source-2", "The docs: a currency on each expense"],
      ["neither", "Neither"],
    ]);
    // A test that differs, with no baseline run, makes no conflict.
    imp.reading!.rules.find((r) => r.id === "R13")!.sources = [{ from: "test", ref: "test_add.py::test_rejects_other_currency", says: "a currency on each expense", differs: true }];
    expect(I.ruleConfidence(imp, imp.reading!.rules.find((r) => r.id === "R13")!)).toEqual({ level: "inferred", why: "no-baseline-run" });
    // With a baseline run, the test is cited as before.
    const ran = tallyImport("review").s.studio.import!;
    expect(I.importQuestions(ran).asked.find((q) => q.ruleId === "R13")!.options[0].label).toBe("The test: one currency per group");
    expect(tallyReading({ noTests: true }).rules.every((r) => r.sources.every((x) => x.from !== "test"))).toBe(true);
  });
});
