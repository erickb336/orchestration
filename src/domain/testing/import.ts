// Test fixture (pure): the import of "tally", an invented CLI that splits shared costs (ORC-032, the prototype's
// sample data), built through the real commands, as the owner and the service send them. For the domain's tests, the
// server's and the UI's (units 2 and 3), and a seeded browser pass. Sample data, not a real repository: every run is
// simulated. Not used by the application.
//
// tally at commit c0ffee…: 3 terminal demos (tally add, tally split, tally report), an algorithm (Splitting), a
// contract (The ledger) and the words. 22 tests, all pass by default. 17 rules: R1–R12 named by passing tests
// (confirmed), R13 with a passing test that the README contradicts (a conflict), R14 read from the code that the
// README contradicts (a conflict, no test), R15–R17 read from the code, no test, each important (guesses).

import { buildSeed } from "../seed";
import { baselineSummary, importFixesDue } from "../studio/import";
import { summaryDigest } from "../studio/blueprint";
import * as R from "../studio/runs";
import * as S from "../studio/studio";
import { setSubagentProviders } from "../subagents";
import type { ImportAnswer, ImportProjectStart, ImportStep } from "../studio/types";
import type { State, TestCaseResult } from "../types";
import { run, sha } from "./studio";

export const T0 = Date.parse("2026-10-03T09:00:00Z");
export const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** The commit the import reads: HEAD of tally's main. */
export const TALLY_COMMIT = "c0ffee".padEnd(40, "0");
/** What the Start screen counted at that commit. */
export const TALLY_SIZE = { sourceFiles: 14, testFiles: 5, kb: 38 };

type RuleDef = { id: string; part: PartKey; title: string; text: string; tests: string[]; sources?: { from: "test" | "code" | "docs"; ref: string; says: string; differs?: true }[]; important?: string };

/** The 17 rules of tally, as the reader gives them; each test id is "file::name". */
export const TALLY_RULES: RuleDef[] = [
  { id: "R1", part: "add", title: "What an expense records", text: "When you add an expense, the CLI shall record its amount, payer, people, note and date.", tests: ["test_add.py::test_records_expense", "test_add.py::test_records_date"] },
  { id: "R2", part: "add", title: "An amount that is not a number", text: 'If the amount is not a number, then the CLI shall stop with "Amount must be a number".', tests: ["test_add.py::test_rejects_text", "test_add.py::test_rejects_empty", "test_add.py::test_rejects_symbols"] },
  { id: "R3", part: "add", title: "A payer outside the group", text: 'If the payer is not in the group, then the CLI shall stop with "Unknown person".', tests: ["test_add.py::test_unknown_payer"] },
  { id: "R4", part: "add", title: "Who shares a cost by default", text: "When you leave out --for, the CLI shall split the cost among everyone in the group.", tests: ["test_add.py::test_default_everyone", "test_add.py::test_default_after_join"] },
  { id: "R5", part: "ledger", title: "Money in whole cents", text: "The ledger shall keep money in whole cents.", tests: ["test_money.py::test_whole_cents", "test_money.py::test_no_floats"] },
  { id: "R6", part: "split", title: "Each person's balance", text: "When you run tally split, the CLI shall show each person's balance.", tests: ["test_split.py::test_balances", "test_split.py::test_balances_sum_to_zero"] },
  { id: "R7", part: "splitting", title: "The fewest payments", text: "The split shall suggest the fewest payments that settle everyone.", tests: ["test_split.py::test_fewest_payments", "test_split.py::test_settles_all"] },
  { id: "R8", part: "split", title: "When everyone is even", text: 'If everyone is even, then the CLI shall say "Everyone is even".', tests: ["test_split.py::test_even"] },
  { id: "R9", part: "report", title: "The order of the report", text: "When you run tally report, the CLI shall list each expense by date, oldest first.", tests: ["test_report.py::test_by_date"] },
  { id: "R10", part: "report", title: "A report from a date", text: "When you give --since, the report shall show only the expenses from that date on.", tests: ["test_report.py::test_since", "test_report.py::test_since_empty"] },
  { id: "R11", part: "ledger", title: "A missing ledger", text: "If the ledger file is missing, then the CLI shall start an empty ledger.", tests: ["test_ledger.py::test_missing"] },
  { id: "R12", part: "ledger", title: "A damaged ledger", text: "If the ledger file is damaged, then the CLI shall stop and change nothing.", tests: ["test_ledger.py::test_damaged_untouched", "test_ledger.py::test_damaged_message"] },
  {
    id: "R13",
    part: "add",
    title: "Currency",
    text: "The ledger shall keep one currency per group, set in .tally.json.",
    tests: ["test_add.py::test_rejects_other_currency"],
    sources: [
      { from: "test", ref: "test_add.py::test_rejects_other_currency", says: "one currency per group" },
      { from: "docs", ref: "README.md, Currency", says: "a currency on each expense", differs: true },
    ],
  },
  {
    id: "R14",
    part: "report",
    title: "CSV reports",
    text: "When you give --format csv, the report shall print the expenses as CSV.",
    tests: [],
    sources: [
      { from: "code", ref: "tally/report.py", says: "--format csv" },
      { from: "docs", ref: "README.md, Reports", says: "--csv", differs: true },
    ],
  },
  { id: "R15", part: "splitting", title: "Rounding", text: "If a cost does not split evenly, then the split shall give the extra cent to the first person in the split.", tests: [], important: "It decides who pays the extra cent." },
  { id: "R16", part: "ledger", title: "Refunds", text: "If the amount is below zero, then the CLI shall record a refund.", tests: [], important: "It changes what a negative amount means in the ledger." },
  { id: "R17", part: "ledger", title: "Where the ledger lives", text: "The ledger shall live in .tally.json in the folder where you run tally.", tests: [], important: "It decides which ledger each command reads and writes." },
];

const AREA: Record<PartKey, string> = { add: "tally add", split: "tally split", report: "tally report", splitting: "splitting", ledger: "the ledger" };

/**
 * The rules as the reader hands them in, each with its sources (a test's, else the code's), and the cases they name.
 * `failing`: these tests fail. `noTests`: the tests did not run, so no rule names one; the code is a source of each
 * rule, and a test the reader read stays a source (the review does not cite it).
 */
export function tallyReading(o: { failing?: string[]; noTests?: boolean } = {}) {
  const code = (r: RuleDef) => ({ from: "code" as const, ref: "tally/cli.py", says: r.text });
  return {
    rules: TALLY_RULES.map((r) => {
      const sources = r.sources ?? [r.tests.length ? { from: "test" as const, ref: r.tests[0], says: r.text } : code(r)];
      return {
        id: r.id,
        area: AREA[r.part],
        title: r.title,
        text: r.text,
        tests: o.noTests ? [] : r.tests,
        sources: o.noTests && !sources.some((x) => x.from === "code") ? [...sources, code(r)] : sources,
        ...(r.important ? { important: r.important } : {}),
      };
    }),
    cases: o.noTests ? [] : tallyCases(o.failing),
  };
}

/** The 22 cases of the baseline report that the rules name; those in `failing` fail. */
export function tallyCases(failing: string[] = []): TestCaseResult[] {
  return TALLY_RULES.flatMap((r) => r.tests).map((id) => {
    const [suite, name] = id.split("::");
    return failing.includes(id) ? { suite, name, status: "failed" as const, message: "AssertionError: the output differs" } : { suite, name, status: "passed" as const };
  });
}

type PartKey = "add" | "split" | "report" | "splitting" | "ledger";
const DEMO = (title: string, key: PartKey) => ({ kind: "terminal-demo", title, devices: ["terminal"], variants: [{ id: "a", label: "As it is today", entry: `${key}/demo.tape` }], files: [{ path: `${key}/demo.tape`, sha256: sha("1") }, { path: `${key}/rules.json`, sha256: sha("2") }] });
const DOC = (kind: string, title: string, key: PartKey) => ({ kind, title, devices: [], variants: [{ id: "a", label: "As it is today", entry: `${key}/${key}.md` }], files: [{ path: `${key}/${key}.md`, sha256: sha("3") }, { path: `${key}/rules.json`, sha256: sha("4") }] });

/** The 5 parts with rules, as the parts designer hands them in, each with the repository files it came from. */
export const TALLY_PARTS: Record<PartKey, Record<string, unknown> & { provenance: string[] }> = {
  add: { ...DEMO("tally add", "add"), provenance: ["tally/cli.py", "tally/ledger.py"] },
  split: { ...DEMO("tally split", "split"), provenance: ["tally/cli.py", "tally/settle.py"] },
  report: { ...DEMO("tally report", "report"), provenance: ["tally/cli.py", "tally/report.py"] },
  splitting: { ...DOC("algorithm", "Splitting", "splitting"), provenance: ["tally/settle.py", "tally/money.py"] },
  ledger: { ...DOC("contract", "The ledger", "ledger"), provenance: ["tally/ledger.py"] },
};

/** tally's words, from the README and the names in the code. */
export const TALLY_WORDS = [
  { term: "expense", meaning: "One cost that one person paid for some people in the group.", avoid: ["cost item"] },
  { term: "payer", meaning: "The person who paid an expense.", avoid: [] },
  { term: "group", meaning: "The people who share costs in one ledger.", avoid: [] },
  { term: "balance", meaning: "What a person paid minus their share. Above zero: others owe them.", avoid: [] },
  { term: "settle up", meaning: "The payments that bring every balance to zero.", avoid: [] },
  { term: "ledger", meaning: "The file that holds a group's expenses.", avoid: [] },
];

/** What the Start screen sends for tally: the `startImport` command's arguments, with no environment or test command. */
export const TALLY_START: ImportProjectStart = {
  name: "tally (sample)",
  repoPath: "/tmp/tally",
  commit: TALLY_COMMIT,
  branch: "main",
  size: TALLY_SIZE,
  domains: ["screen", "code"],
  devices: ["terminal"],
  budgetUsd: 3,
  helpers: null,
};

/** How far the import has got: started; its tests recorded; its rules read; its parts in; in review; answered; locked in. */
export type ImportStage = "started" | "checked" | "read" | "parts" | "review" | "answered" | "baseline";
const STAGES: ImportStage[] = ["started", "checked", "read", "parts", "review", "answered", "baseline"];

export interface ImportOptions {
  /** The baseline run: all 22 pass (default), these test ids fail, or it did not run (no Docker). */
  checks?: { failing: string[] } | "not-run";
  /** The rules reader's helper cap, or null (default). */
  helpers?: number | null;
  /** The owner's answers at "answered" (default: the prototype's example, `PROTOTYPE_ANSWERS`). */
  answers?: Omit<ImportAnswer, "at">[];
}

/**
 * The prototype's example answers: CSV keeps the code; Currency takes the README (a change); Rounding confirmed;
 * Refunds corrected as a misread; Where the ledger lives not answered.
 */
export const PROTOTYPE_ANSWERS: Omit<ImportAnswer, "at">[] = [
  { on: { rule: "R14" }, option: "keep" },
  { on: { rule: "R13" }, option: "source-2" },
  { on: { rule: "R15" }, option: "confirm" },
  { on: { rule: "R16" }, option: "correct", correction: "misread", text: "A negative amount is an error today; tally add stops." },
];

export interface ImportScene {
  s: State;
  importId: string;
  /** The parts' artifact ids, once in. */
  parts: Partial<Record<PartKey | "words", string>>;
  /** The import's studio runs by step, once asked for. */
  runs: Partial<Record<ImportStep, string>>;
}

const SIM = { simulated: ["claude", "codex"] as ("claude" | "codex")[] };

/** Ask for an import run and start it (simulated); a fix names the part it revises. */
function startRun(s: State, step: ImportStep, sec: number, artifactId?: string): { s: State; id: string } {
  const r = R.requestStudioRun(s, { kind: step === "rules" ? "reader" : "designer", round: 0, brief: `The import's ${step}.`, importStep: step, ...(artifactId ? { artifactId } : {}) }, at(sec));
  return { s: R.dispatchStudioRuns(r.state, at(sec), SIM).state, id: r.runId };
}

/**
 * tally's import, through the real commands, up to `stage` (default: in review). A new project "tally (sample)", a
 * screen and code product on the terminal, a $3 budget. Seconds from T0: started 1, checks 10, rules and words 20–30,
 * parts 40–50, capture 60, answers 100, a designer's fix of each part the owner said was misread 105–107 (with the
 * default answers: The ledger, v2), the baseline Lock in 120.
 */
export function tallyImport(stage: ImportStage = "review", o: ImportOptions = {}): ImportScene {
  const upTo = (x: ImportStage) => STAGES.indexOf(stage) >= STAGES.indexOf(x);
  let s = buildSeed(T0, { inFlightRuns: false });
  // Helpers need a provider that tracks them (ORC-031): the service writes which at start.
  if (o.helpers) s = setSubagentProviders(s, ["claude"], at(0));
  s = run(s, "startImport", { ...TALLY_START, helpers: o.helpers ?? null }, at(1)).state;
  const importId = s.studio.import!.id;
  const scene: ImportScene = { s, importId, parts: {}, runs: {} };
  if (!upTo("checked")) return scene;
  const failing = o.checks && o.checks !== "not-run" ? o.checks.failing : [];
  const counts = { passed: 22 - failing.length, failed: failing.length, skipped: 0, error: 0 };
  const result = o.checks === "not-run" ? { status: "not-run", reason: "Docker is not available on this computer, so the tests did not run." } : { status: "read", counts, reportFile: "checks/junit.xml", simulated: true };
  s = run(s, "recordImportChecks", { importId, result }, at(10)).state;
  if (!upTo("read")) return { ...scene, s };

  // The words and the rules, at the same time.
  const words = startRun(s, "words", 20);
  const reader = startRun(words.s, "rules", 20);
  s = reader.s;
  s = run(s, "recordImportRules", { importId, runId: reader.id, ...tallyReading({ failing, noTests: o.checks === "not-run" }) }, at(25)).state;
  s = R.completeStudioRun(s, reader.id, at(25), { summary: "17 rules" });
  const designer = (st: State, id: string) => ({ role: "designer", provider: "claude", model: st.studio.runs.find((x) => x.id === id)!.model, attemptId: id });
  const dict = run<{ artifactId: string }>(s, "addStudioArtifact", { round: 0, kind: "dictionary", title: "Words", devices: [], variants: [{ id: "a", label: "As it is today", entry: "words/dictionary.json" }], files: [{ path: "words/dictionary.json", sha256: sha("5") }], madeBy: designer(s, words.id), provenance: { files: ["README.md", "tally/cli.py"] }, dictionary: TALLY_WORDS }, at(30));
  s = R.completeStudioRun(dict.state, words.id, at(30), { summary: "6 words" });
  const parts: ImportScene["parts"] = { words: dict.result.artifactId };
  const runs: ImportScene["runs"] = { words: words.id, rules: reader.id };
  if (!upTo("parts")) return { s, importId, parts, runs };

  // The parts, each with its rules, then the capture.
  const p = startRun(s, "parts", 40);
  s = p.s;
  runs.parts = p.id;
  for (const key of Object.keys(TALLY_PARTS) as PartKey[]) {
    const { provenance, ...def } = TALLY_PARTS[key];
    const rules = TALLY_RULES.filter((r) => r.part === key).map((r) => ({ id: r.id, text: r.text, ...(r.tests.length && o.checks !== "not-run" ? { tests: r.tests } : {}) }));
    const added = run<{ artifactId: string }>(s, "addStudioArtifact", { round: 0, ...def, madeBy: designer(s, p.id), provenance: { files: provenance }, rules: [{ variant: "a", path: `${key}/rules.json`, rules }] }, at(45));
    s = added.state;
    parts[key] = added.result.artifactId;
  }
  s = R.completeStudioRun(s, p.id, at(50), { summary: "5 parts" });
  if (!upTo("review")) return { s, importId, parts, runs };
  const recorded = (key: PartKey) => ({ artifactId: parts[key]!, version: 1, status: "captured", files: [{ path: `${parts[key]}/demo.cast`, type: "cast", bytes: 2048, sha256: sha("c") }] });
  const capture = o.checks === "not-run" ? { parts: (["add", "split", "report"] as PartKey[]).map((k) => ({ artifactId: parts[k]!, version: 1, status: "none", reason: "unavailable", detail: "Docker is not available on this computer, so nothing was recorded." })) } : { parts: (["add", "split", "report"] as PartKey[]).map(recorded), simulated: true };
  s = run(s, "recordImportCapture", { importId, capture }, at(60)).state;
  if (!upTo("answered")) return { s, importId, parts, runs };
  s = run(s, "answerImport", { answers: o.answers ?? PROTOTYPE_ANSWERS }, at(100)).state;
  if (!upTo("baseline")) return { s, importId, parts, runs };
  // Each part the owner said the reader misread gets a designer's fix: its next version, as is, with the same rules.
  for (const f of importFixesDue(s)) {
    const fix = startRun(s, "fix", 105, f.artifactId);
    const v = S.latestVersion(fix.s, f.artifactId)!;
    s = run(fix.s, "addStudioArtifact", { artifactId: v.id, round: 0, kind: v.kind, title: v.title, devices: v.devices, variants: v.variants, files: v.files, madeBy: designer(fix.s, fix.id), provenance: { files: v.provenance!.files }, ...(v.rules ? { rules: v.rules } : {}) }, at(106)).state;
    s = R.completeStudioRun(s, fix.id, at(107), { summary: "fixed" });
    runs.fix = fix.id;
  }
  return { s: lockInBaselineAsOwner(s, at(120)), importId, parts, runs };
}

/** The `lockInBaseline` arguments for the baseline summary as it stands, as the Baseline screen sends them. */
export function baselineArgs(s: State): { draftRev: number; summaryDigest: string } {
  const summary = baselineSummary(s);
  return { draftRev: summary.draftRev, summaryDigest: summaryDigest(summary) };
}

/** The owner's baseline Lock in, naming the summary as it stands. */
export const lockInBaselineAsOwner = (s: State, now: string): State => run(s, "lockInBaseline", baselineArgs(s), now).state;
