// The import of an existing repository into Vision (ORC-032, docs/design/ORC-032-design.md). Pure: each operation
// returns a new State.
//
// The steps. The owner starts the import on the new-project screen (`startImport`), pinned to the repository's HEAD
// (C11), with its own budget. The service then runs the project's tests once (`recordImportChecks`), the rules reader
// turns the tests and the code into rules (`recordImportRules`), a designer reproduces the parts with their rules
// (`addStudioArtifact`, round 0, as is), a designer collects the words, and the service records each part in the
// project's environment (`recordImportCapture`). The owner answers the review (`answerImport`) and locks the baseline
// in (`lockInBaseline`): blueprint revision 1, in force and built.
//
// Who calls what. The owner: startImport, setImportBudget, answerImport, lockInBaseline. The service, from its own
// runs (SERVICE_COMMANDS): recordImportChecks, recordImportRules, recordImportCapture, stopImport. The lead only
// writes the review's message.

import { draft, event, nextId } from "../model/core";
import { CONTROL_RE, oneLine } from "../model/textSafety";
import { PRICES, fmtUsd } from "../spend";
import { canAllowSubagents } from "../subagents";
import { ControlError, MAX_SUBAGENT_CAP, type ProviderId, type State, type TestCaseResult } from "../types";
import { blueprintItems, draftItems, lockInSummary, putDraftInForce, assertSummarySeen, type SummarySeen } from "./blueprint";
import { NO_EVIDENCE, isCapturedKind, type EvidenceFile } from "./evidence";
import { isInsidePath, latestArtifacts } from "./studio";
import { IMPORT_SOURCE_KINDS, isUnderWay, type BlueprintItem, type ImportAnswer, type ImportCapture, type ImportChecks, type ImportEstimate, type ImportPartCapture, type ImportRule, type ImportSource, type ProjectImport, type RepoSize, type StudioArtifact, type StudioRun, type UsdRange } from "./types";
import { MAX_RULE_TESTS, MAX_RULE_TEXT, MAX_TEST_ID, type Parsed, rulePattern } from "./words";

// ---------- bounds (C14) ----------

/** The import budget a new import starts with, in dollars (the owner's decision). */
export const DEFAULT_IMPORT_BUDGET_USD = 3;
/** The most rules one import records. */
export const MAX_IMPORT_RULES = 300;
/** The most test cases one import keeps in the state: the cases its rules name. The full report stays a file. */
export const MAX_IMPORT_CASES = 1000;
/** The most sources one rule has. */
export const MAX_RULE_SOURCES = 5;
/** The most questions one review asks (Q4): conflicts first, then important guesses. */
export const MAX_IMPORT_QUESTIONS = 10;
const MAX_ERRORS = 8;

const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
/** One line of an agent's or the service's text: control and invisible characters removed, whitespace collapsed. */
const line = (x: string) => oneLine(x.replace(CONTROL_G, ""));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const show = (x: string, max = 60) => JSON.stringify(x.length > max ? `${x.slice(0, max - 1)}…` : x);
const short = (sha: string) => sha.slice(0, 7);

// ---------- lookups ----------

/** The project's import, if it has one. */
export const currentImport = (s: State): ProjectImport | undefined => s.studio.import;

function getImport(s: State, importId?: string): ProjectImport {
  const imp = s.studio.import;
  if (!imp) throw new ControlError("This project has no import.");
  if (importId !== undefined && imp.id !== importId) throw new ControlError(`This project's import is ${imp.id}, not ${importId}.`);
  return imp;
}

/** A test's id, as rules name it: "suite::name", as the JUnit report gives them. */
export const testId = (c: Pick<TestCaseResult, "suite" | "name">) => `${c.suite}::${c.name}`;

/** The studio runs of the import, oldest first; with `step`, only that step's. */
export const importRuns = (s: State, step?: StudioRun["importStep"]): StudioRun[] => s.studio.runs.filter((r) => r.importStep !== undefined && (step === undefined || r.importStep === step));

/** The parts of the import: the newest version of each designer's artifact in round 0 (as is: reproductions and the words). */
export const importParts = (s: State): StudioArtifact[] => latestArtifacts(s).filter((a) => a.round === 0 && !!a.provenance);

/**
 * Where the import stands, derived: stopped, locked in, in review once the reading and the capture are recorded and
 * none of its words, rules or parts runs is under way, else reading. Undefined without an import.
 */
export type ImportStatus = "reading" | "review" | "locked-in" | "stopped";
export function importStatus(s: State): ImportStatus | undefined {
  const imp = s.studio.import;
  if (!imp) return undefined;
  if (imp.stopped) return "stopped";
  if (imp.lockedInAt) return "locked-in";
  const busy = importRuns(s).some((r) => r.importStep !== "fix" && isUnderWay(r));
  return imp.reading && imp.capture && !busy ? "review" : "reading";
}

/** The import goes on: it has started and is neither stopped nor locked in. */
const going = (imp: ProjectImport) => !imp.stopped && !imp.lockedInAt;

function assertGoing(imp: ProjectImport) {
  if (imp.stopped) throw new ControlError(`The import stopped: ${imp.stopped.reason}`);
  if (imp.lockedInAt) throw new ControlError("The import is locked in: it is the baseline.");
}

// ---------- the estimate ----------

/** What one import costs apart from what it reads, from the recorded real runs (docs/real-runs/), low to high. */
const BASE_USD: UsdRange = [0.4, 1.6];
const READERS = 3;
const TOKENS_PER_KB = 256;

/**
 * The import's cost before it starts (C6: a formula, no agent run): a base for its runs (the words, the rules, the
 * parts, the lead's replies and up to two fixes), from the recorded real runs on small repositories; plus what its
 * three readers read, each 1 to 4 times, at Claude's published input prices (src/domain/prices.json). An estimate,
 * not a bill.
 */
export function importEstimate(size: RepoSize): ImportEstimate {
  const claude = PRICES.filter((p) => p.provider === "claude").map((p) => p.inputPerMTok);
  const tokens = size.kb * TOKENS_PER_KB * READERS;
  const lo = BASE_USD[0] + (tokens * Math.min(...claude)) / 1_000_000;
  const hi = BASE_USD[1] + (tokens * 4 * Math.max(...claude)) / 1_000_000;
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    usd: [round(lo), round(hi)],
    basis: `${size.sourceFiles} source file${size.sourceFiles === 1 ? "" : "s"}, ${size.testFiles} test file${size.testFiles === 1 ? "" : "s"} (${Math.round(size.kb)} KB). The runs of recorded real imports of small repositories, plus the files read 1 to 4 times by 3 readers at Claude's published prices. There is no basis above about 50 files. An estimate, not a bill.`,
  };
}

// ---------- the owner starts it ----------

export interface ImportStart {
  commit: string;
  branch?: string;
  budgetUsd: number;
  /** The rules reader's helper cap, or null: off. */
  helpers: number | null;
  size: RepoSize;
  /** Who reads the repository (Q5); absent: Claude. */
  readsOn?: ProviderId;
}

const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The owner starts the import of the project's repository (the new-project screen), after initProject and the kind of
 * product. It opens round 0, "As it is today", and pins the import to `commit`, the HEAD the screen showed (the
 * service checks it against the repository). Refused outside Vision, in a project with rounds or an import already,
 * before the kind of product is chosen, and with helpers while no provider tracks them.
 */
export function startImport(state: State, input: ImportStart, now: string): State {
  if (state.project.stage !== "shaping") throw new ControlError("The import starts a new project, in Vision.");
  if (state.studio.import) throw new ControlError("This project has an import already. To import again, start a new project.");
  if (state.studio.rounds.length || state.studio.artifacts.length || state.blueprint.revisions.length || state.blueprint.draft.items.length) throw new ControlError("The import starts a new project, and this one has Vision rounds already. Start a new project in Settings.");
  if (!state.project.domains.length) throw new ControlError("Choose the kind of product first: screen, code or infrastructure.");
  if (!COMMIT_RE.test(input.commit)) throw new ControlError("The commit is a full commit id: 40 or 64 lowercase hex characters.");
  const branch = input.branch === undefined ? undefined : line(input.branch);
  if (branch !== undefined && (!branch || branch.length > 200)) throw new ControlError("The branch is a name of 1 to 200 characters.");
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) throw new ControlError("The import budget is a positive number of dollars.");
  if (input.helpers !== null) {
    if (!Number.isInteger(input.helpers) || input.helpers < 1 || input.helpers > MAX_SUBAGENT_CAP) throw new ControlError(`The helpers' cap is a whole number from 1 to ${MAX_SUBAGENT_CAP}.`);
    if (!canAllowSubagents(state)) throw new ControlError("No provider tracks helper agents yet, so the rules reader cannot start them.");
  }
  const { sourceFiles, testFiles, kb } = input.size;
  if (![sourceFiles, testFiles].every((n) => Number.isInteger(n) && n >= 0) || !Number.isFinite(kb) || kb < 0) throw new ControlError("The repository's size is whole numbers of files and a number of kilobytes.");
  const readsOn = input.readsOn ?? "claude";
  if (!state.project.enabledProviders.includes(readsOn)) throw new ControlError(`${readsOn === "claude" ? "Claude" : "Codex"} reads the repository, and it is not enabled. Enable it in Settings${readsOn === "claude" ? ", or pick Codex to read it" : ""}.`);
  const s = draft(state);
  const imp: ProjectImport = {
    id: nextId(s, "import"),
    commit: input.commit,
    ...(branch ? { branch } : {}),
    startedAt: now,
    budgetUsd: input.budgetUsd,
    estimate: importEstimate({ sourceFiles, testFiles, kb }),
    helpers: input.helpers,
    readsOn,
    checks: { status: "pending" },
    answers: [],
  };
  s.studio.import = imp;
  const where = `commit ${short(imp.commit)}${branch ? ` on ${branch}` : ""}`;
  s.studio.rounds.push({ n: 0, focus: "material", openedAt: now, summary: `As it is today: what the repository does at ${where}.` });
  event(s, now, "user", "vision", `Import started: ${where}, with a budget of ${fmtUsd(imp.budgetUsd)} (the estimate: ${fmtUsd(imp.estimate.usd[0])}–${fmtUsd(imp.estimate.usd[1])}); round 0, As it is today, opened`);
  return s;
}

/** The owner changes the import budget, for example at its stop. Refused once the import is locked in or stopped. */
export function setImportBudget(state: State, budgetUsd: number, now: string): State {
  const imp = getImport(state);
  assertGoing(imp);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new ControlError("The import budget is a positive number of dollars.");
  if (budgetUsd === imp.budgetUsd) return state;
  const s = draft(state);
  s.studio.import!.budgetUsd = budgetUsd;
  event(s, now, "user", "config", `Import budget: ${fmtUsd(budgetUsd)} (was ${fmtUsd(imp.budgetUsd)})`);
  return s;
}

// ---------- the service records what its runs found ----------

/** The baseline test run as the service reports it: read, with the report's counts and file, or not run, and why. */
export type ImportChecksResult = { status: "read"; counts: Record<TestCaseResult["status"], number>; reportFile: string; simulated?: true } | { status: "not-run"; reason: string };

/**
 * Record the baseline test run (the service). Only while the import goes on and its checks are pending: a late or
 * repeated report changes nothing.
 */
export function recordImportChecks(state: State, input: { importId: string; result: ImportChecksResult }, now: string): State {
  const imp = getImport(state, input.importId);
  if (!going(imp) || imp.checks.status !== "pending") return state;
  const r = input.result;
  let checks: ImportChecks;
  if (r.status === "read") {
    const counts = { passed: r.counts.passed, failed: r.counts.failed, skipped: r.counts.skipped, error: r.counts.error };
    if (!Object.values(counts).every((n) => Number.isInteger(n) && n >= 0)) throw new ControlError("The report's counts are whole numbers.");
    if (!isInsidePath(r.reportFile)) throw new ControlError(`${show(line(r.reportFile))} is not a file path inside the import's folder.`);
    checks = { status: "read", at: now, counts, reportFile: r.reportFile, ...(r.simulated ? { simulated: true as const } : {}) };
  } else {
    const reason = line(r.reason).slice(0, 500);
    if (!reason) throw new ControlError("A baseline run that did not run says why.");
    checks = { status: "not-run", at: now, reason };
  }
  const s = draft(state);
  s.studio.import!.checks = checks;
  const total = checks.status === "read" ? Object.values(checks.counts).reduce((a, b) => a + b, 0) : 0;
  event(s, now, "system", "vision", checks.status === "read" ? `The import's tests: ${total} read, ${checks.counts.passed} pass${checks.simulated ? " (simulated)" : ""}` : `The import's tests did not run: ${checks.reason}. Every rule is inferred.`);
  return s;
}

/**
 * The rules reader's output (untrusted): `{ rules, cases }`, checked at the boundary. 1 to 300 rules, each with an id
 * (letters, digits, "-" and "_", each once), what it is about, its text in one of EARS's patterns, up to 20 test ids,
 * 1 to 5 sources and, for a guess that matters, why; and the cases of the baseline report that the rules name, each
 * once (at most 1,000). Every problem is named, at most 8.
 */
export function parseImportReading(raw: unknown): Parsed<{ rules: ImportRule[]; cases: TestCaseResult[] }> {
  if (!isObj(raw) || !Array.isArray(raw.rules) || !Array.isArray(raw.cases)) return { ok: false, errors: ['The reading is { "rules": [...], "cases": [...] }'] };
  if (!raw.rules.length || raw.rules.length > MAX_IMPORT_RULES) return { ok: false, errors: [`The reading has between 1 and ${MAX_IMPORT_RULES} rules; it has ${raw.rules.length}`] };
  if (raw.cases.length > MAX_IMPORT_CASES) return { ok: false, errors: [`The reading names at most ${MAX_IMPORT_CASES} test cases; it names ${raw.cases.length}`] };
  const errors: string[] = [];
  const text = (v: unknown, max: number, what: string, optional = false): string | undefined => {
    if (optional && v === undefined) return undefined;
    const t = typeof v === "string" ? line(v) : "";
    if (!t || t.length > max) errors.push(`${what} is one line of 1 to ${max} characters`);
    return t;
  };
  const ids = new Set<string>();
  const rules: ImportRule[] = [];
  raw.rules.forEach((v, i) => {
    if (!isObj(v)) return void errors.push(`rule ${i + 1} is not an object`);
    const id = typeof v.id === "string" ? v.id.trim() : "";
    const at = `rule ${id || i + 1}`;
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) errors.push(`rule ${i + 1}: the id ${show(id)} is 1 to 20 letters, digits, "-" and "_"`);
    else if (ids.has(id)) errors.push(`${at}: the id is used twice`);
    ids.add(id);
    const area = text(v.area, 80, `${at}: "area"`) ?? "";
    const t = text(v.text, MAX_RULE_TEXT, `${at}: "text"`) ?? "";
    const pattern = rulePattern(t);
    if (t && !pattern) errors.push(`${at} fits no pattern: ${show(t, 120)}`);
    const tests = Array.isArray(v.tests) ? v.tests : v.tests === undefined ? [] : null;
    if (!tests || tests.length > MAX_RULE_TESTS || !tests.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_TEST_ID)) errors.push(`${at}: "tests" is a list of at most ${MAX_RULE_TESTS} test ids`);
    else if (new Set(tests).size !== tests.length) errors.push(`${at} names a test twice`);
    const sources: ImportSource[] = [];
    if (!Array.isArray(v.sources) || !v.sources.length || v.sources.length > MAX_RULE_SOURCES) errors.push(`${at}: "sources" is a list of 1 to ${MAX_RULE_SOURCES} { "from", "ref", "says" }`);
    else
      v.sources.forEach((x, k) => {
        const where = `${at}, source ${k + 1}`;
        if (!isObj(x) || !IMPORT_SOURCE_KINDS.includes(x.from as ImportSource["from"])) return void errors.push(`${where}: "from" is test, code or docs`);
        if (x.differs !== undefined && typeof x.differs !== "boolean") errors.push(`${where}: "differs" is true or false`);
        sources.push({ from: x.from as ImportSource["from"], ref: text(x.ref, 300, `${where}: "ref"`) ?? "", says: text(x.says, 300, `${where}: "says"`) ?? "", ...(x.differs === true ? { differs: true as const } : {}) });
      });
    const important = text(v.important, 300, `${at}: "important"`, true);
    if (pattern) rules.push({ id, area, text: t, pattern, tests: (tests as string[] | null) ?? [], sources, ...(important ? { important } : {}) });
  });
  const cases: TestCaseResult[] = [];
  const caseIds = new Set<string>();
  raw.cases.forEach((v, i) => {
    if (!isObj(v) || typeof v.name !== "string" || typeof v.suite !== "string" || !["passed", "failed", "skipped", "error"].includes(v.status as string)) return void errors.push(`case ${i + 1} is not { "name", "suite", "status" }`);
    const c: TestCaseResult = { name: v.name.slice(0, 300), suite: v.suite.slice(0, 200), status: v.status as TestCaseResult["status"], ...(typeof v.message === "string" && v.message ? { message: line(v.message).slice(0, 300) } : {}) };
    if (caseIds.has(testId(c))) errors.push(`case ${show(testId(c))} is listed twice`);
    caseIds.add(testId(c));
    cases.push(c);
  });
  return errors.length ? { ok: false, errors: errors.slice(0, MAX_ERRORS) } : { ok: true, value: { rules, cases } };
}

/**
 * Record the rules reader's output (the service, from the reader's run), checked against the baseline run: every test
 * a rule names is one of `cases`, and every case is named; without a baseline run, no rule names a test. Only while
 * the import goes on, after its checks and before any reading: a late or repeated report changes nothing.
 */
export function recordImportRules(state: State, input: { importId: string; runId?: string; rules: ImportRule[]; cases: TestCaseResult[] }, now: string): State {
  const imp = getImport(state, input.importId);
  if (!going(imp) || imp.reading) return state;
  if (imp.checks.status === "pending") throw new ControlError("The rules reader reads the baseline report: record the import's checks first.");
  const known = new Set(input.cases.map(testId));
  const named = new Set(input.rules.flatMap((r) => r.tests));
  if (imp.checks.status !== "read" && named.size) throw new ControlError("The import's tests did not run, so no rule can name a test.");
  const unknown = [...named].filter((id) => !known.has(id));
  if (unknown.length) throw new ControlError(`Not in the baseline report: ${unknown.slice(0, 5).map((x) => show(x, 80)).join(", ")}${unknown.length > 5 ? ", …" : ""}.`);
  const unnamed = input.cases.filter((c) => !named.has(testId(c)));
  if (unnamed.length) throw new ControlError(`The import keeps only the cases its rules name; no rule names ${show(testId(unnamed[0]), 80)}.`);
  if (imp.checks.status === "read") {
    const counts = imp.checks.counts;
    for (const st of ["passed", "failed", "skipped", "error"] as const) {
      const n = input.cases.filter((c) => c.status === st).length;
      if (n > counts[st]) throw new ControlError(`The cases name ${n} ${st} tests; the baseline report has ${counts[st]}.`);
    }
  }
  const s = draft(state);
  s.studio.import!.reading = { at: now, ...(input.runId ? { runId: input.runId } : {}), rules: structuredClone(input.rules), cases: structuredClone(input.cases) };
  const withTest = input.rules.filter((r) => r.tests.length).length;
  event(s, now, "system", "vision", `The import's rules: ${input.rules.length} read, ${withTest} from the tests, ${input.rules.length - withTest} from the code and docs`);
  return s;
}

/** The capture as the service reports it (untrusted shape, from its own run): checked by `parseImportCapture`. */
export type ImportCaptureInput = Omit<ImportCapture, "at">;

const EVIDENCE_TYPES: readonly EvidenceFile["type"][] = ["png", "gif", "webm", "txt", "cast"];

/** The capture's shape: each part's artifact and version, then its files, or why it has none. Throws a ControlError. */
export function parseImportCapture(raw: unknown): ImportCaptureInput {
  if (!isObj(raw) || !Array.isArray(raw.parts)) throw new ControlError('The capture is { "parts": [...] }.');
  const parts = raw.parts.map((p, i): ImportPartCapture => {
    if (!isObj(p) || typeof p.artifactId !== "string" || !Number.isInteger(p.version)) throw new ControlError(`Part ${i + 1} of the capture names its artifact and version.`);
    const base = { artifactId: p.artifactId, version: p.version as number };
    if (p.status === "captured") {
      if (!Array.isArray(p.files) || !p.files.length) throw new ControlError(`Part ${i + 1}: a captured part names its files.`);
      const files = p.files.map((f): EvidenceFile => {
        if (!isObj(f) || typeof f.path !== "string" || !isInsidePath(f.path) || !EVIDENCE_TYPES.includes(f.type as EvidenceFile["type"]) || !Number.isInteger(f.bytes) || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new ControlError(`Part ${i + 1}: a file is { "path", "type", "bytes", "sha256" } inside the capture's folder.`);
        if (f.device !== undefined && f.device !== "desktop" && f.device !== "mobile") throw new ControlError(`Part ${i + 1}: a screenshot's device is desktop or mobile.`);
        return { path: f.path, type: f.type as EvidenceFile["type"], ...(f.device ? { device: f.device as "desktop" | "mobile" } : {}), bytes: f.bytes as number, sha256: f.sha256 };
      });
      const warnings = Array.isArray(p.warnings) ? p.warnings.filter((w): w is string => typeof w === "string").map((w) => line(w).slice(0, 300)).filter(Boolean) : [];
      return { ...base, status: "captured", files, ...(warnings.length ? { warnings } : {}) };
    }
    if (p.status !== "none" || !NO_EVIDENCE.includes(p.reason as (typeof NO_EVIDENCE)[number]) || typeof p.detail !== "string") throw new ControlError(`Part ${i + 1}: a part with no capture says why: { "status": "none", "reason", "detail" }.`);
    return { ...base, status: "none", reason: p.reason as (typeof NO_EVIDENCE)[number], detail: line(p.detail).slice(0, 300), ...(typeof p.log === "string" && p.log.trim() ? { log: p.log.trim().slice(-600) } : {}) };
  });
  return { parts, ...(raw.simulated === true ? { simulated: true as const } : {}), ...(isObj(raw.path) ? { path: raw.path as unknown as ImportCapture["path"] } : {}) };
}

/**
 * Record the import's capture (the service): every screen, terminal demo and TUI of round 0, once, at a version it
 * has. Only while the import goes on and before any capture: a late or repeated report changes nothing.
 */
export function recordImportCapture(state: State, input: { importId: string; capture: ImportCaptureInput }, now: string): State {
  const imp = getImport(state, input.importId);
  if (!going(imp) || imp.capture) return state;
  const captured = importParts(state).filter((a) => isCapturedKind(a.kind));
  const listed = input.capture.parts.map((p) => p.artifactId);
  if (new Set(listed).size !== listed.length) throw new ControlError("The capture lists each part once.");
  for (const p of input.capture.parts) {
    const a = captured.find((x) => x.id === p.artifactId);
    if (!a) throw new ControlError(`${p.artifactId} is not a screen, terminal demo or TUI of the import.`);
    if (p.version < 1 || p.version > a.version) throw new ControlError(`${a.title} has no version ${p.version}.`);
  }
  const missing = captured.filter((a) => !listed.includes(a.id));
  if (missing.length) throw new ControlError(`The capture leaves out ${missing.map((a) => a.title).join(", ")}: it says for each part what it recorded, or why nothing.`);
  const s = draft(state);
  s.studio.import!.capture = { at: now, ...structuredClone(input.capture) };
  const n = input.capture.parts.filter((p) => p.status === "captured").length;
  event(s, now, "system", "vision", `The import's capture: ${n} of ${input.capture.parts.length} part${input.capture.parts.length === 1 ? "" : "s"} recorded${input.capture.simulated ? " (simulated)" : ""}`);
  return s;
}

/**
 * The service stops the import, with the reason (a step that cannot go on). Its queued runs fail, and its running runs
 * are asked to stop. Only while it goes on: a second stop changes nothing.
 */
export function stopImport(state: State, input: { importId: string; reason: string }, now: string): State {
  const imp = getImport(state, input.importId);
  if (!going(imp)) return state;
  const reason = line(input.reason).slice(0, 500);
  if (!reason) throw new ControlError("A stopped import says why.");
  const s = draft(state);
  s.studio.import!.stopped = { at: now, reason };
  for (const r of s.studio.runs) {
    if (r.importStep === undefined) continue;
    if (r.status === "queued") Object.assign(r, { status: "failed", endedAt: now, note: "not started: the import stopped" });
    else if (r.status === "running") Object.assign(r, { status: "stopping", stopRequestedAt: now });
  }
  event(s, now, "system", "vision", `The import stopped: ${reason}`);
  return s;
}

// ---------- the owner answers ----------

export type ImportAnswerInput = Omit<ImportAnswer, "at">;

/**
 * The owner's answers on the import's rules and parts, sent together. Each names a rule of the reading or a part of
 * round 0, and an option; "correct" comes with its kind and the owner's words. The newest answer on an item counts.
 */
export function answerImport(state: State, answers: ImportAnswerInput[], now: string): State {
  const imp = getImport(state);
  if (imp.stopped) throw new ControlError(`The import stopped: ${imp.stopped.reason}`);
  if (!imp.reading) throw new ControlError("The import is still reading: there is nothing to answer yet.");
  if (!answers.length) throw new ControlError("Answer at least one question first.");
  const seen = new Set<string>();
  const records = answers.map((a): ImportAnswer => {
    const key = "rule" in a.on ? `rule:${a.on.rule}` : `part:${a.on.part}`;
    if ("rule" in a.on) {
      const id = a.on.rule;
      if (!imp.reading!.rules.some((r) => r.id === id)) throw new ControlError(`The import has no rule ${show(id, 30)}.`);
    } else {
      const id = a.on.part;
      if (!importParts(state).some((p) => p.id === id)) throw new ControlError(`${show(id, 30)} is not a part of the import.`);
    }
    if (seen.has(key)) throw new ControlError("Each rule or part is answered once in a send.");
    seen.add(key);
    const option = a.option.trim();
    if (!/^[a-z0-9-]{1,40}$/.test(option)) throw new ControlError(`${show(option, 40)} is not an option.`);
    if ((option === "correct") !== (a.correction !== undefined)) throw new ControlError('"Correct" says whether tally should do something else or the reader misread it; no other option does.');
    const text = a.text === undefined ? "" : a.text.replace(/\r\n?/g, "\n").trim();
    if (text.length > 2000) throw new ControlError("Your words are over 2000 characters.");
    return { on: "rule" in a.on ? { rule: a.on.rule } : { part: a.on.part }, option, ...(a.correction ? { correction: a.correction } : {}), ...(text ? { text } : {}), at: now };
  });
  const s = draft(state);
  s.studio.import!.answers.push(...records);
  event(s, now, "user", "vision", `Your answers on the import: ${records.length}`);
  return s;
}

// ---------- the baseline Lock in ----------

/** Whether a blueprint item stands for a reproduction of the code as it is today (an "as is" version). */
export function isAsIsItem(s: State, item: Pick<BlueprintItem, "artifactId" | "version">): boolean {
  return s.studio.artifacts.some((a) => a.id === item.artifactId && a.version === item.version && !!a.provenance);
}

/**
 * The state as the baseline Lock in would put it into force: the draft, with every part of round 0 the draft does not
 * hold yet added as approved, at its newest version. The draft's revision stays: the owner names it with the summary.
 */
function withBaseline(state: State): State {
  const s = structuredClone(state);
  const held = new Set(draftItems(s).map((i) => i.artifactId));
  for (const a of importParts(s)) {
    if (held.has(a.id)) continue;
    s.blueprint.draft.items.push({ id: nextId(s, "bi"), kind: a.kind, title: a.title, artifactId: a.id, version: a.version, ...(a.variants.length > 1 ? { variant: a.variants[0].id } : {}), status: "approved" });
  }
  return s;
}

/** The summary the Baseline screen shows: what the baseline Lock in puts into force. */
export const baselineSummary = (s: State) => lockInSummary(withBaseline(s));

/**
 * The baseline Lock in (C4): the owner's command, in Vision. It puts every part of the import into force as blueprint
 * revision 1, marked as the baseline, with the summary the owner saw (`seen`: compare-and-set), and closes round 0.
 */
export function lockInBaseline(state: State, seen: SummarySeen, now: string): State {
  const imp = getImport(state);
  const s = withBaseline(draft(state));
  assertSummarySeen(s, seen);
  putDraftInForce(s, now);
  const rev = s.blueprint.revisions.at(-1)!;
  rev.lockIn!.baseline = { importId: imp.id, commit: imp.commit };
  s.studio.import!.lockedInAt = now;
  const round = s.studio.rounds.find((r) => r.n === 0);
  if (round && !round.closedAt) round.closedAt = now;
  event(s, now, "user", "vision", `The baseline: r${rev.rev} puts ${blueprintItems(s).length} part${blueprintItems(s).length === 1 ? "" : "s"} of the import into force, as the repository is at commit ${short(imp.commit)}`);
  return s;
}

/** The part of round 0 whose rules place this rule, if any. */
export function partOfRule(s: State, ruleId: string): StudioArtifact | undefined {
  return importParts(s).find((a) => a.rules?.some((v) => v.rules.some((r) => r.id === ruleId)));
}
