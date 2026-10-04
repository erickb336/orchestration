// The import of an existing repository (ORC-032) in words: what the five screens (Start, Reading, Review, Baseline
// and After) say, as pure functions of the state, so they can be tested without a browser. The facts come from
// src/domain/studio/import.ts and, until unit 1's phase B lands, from ./phaseB.ts (its stand-ins).

import type { EnvironmentFound } from "../../api";
import { fmtUsd } from "../../domain/spend";
import { importParts, importRuns, importStatus, testId } from "../../domain/studio/import";
import type { ImportRule, ImportSource, ImportStep, RepoSize, StudioArtifact } from "../../domain/studio/types";
import type { CheckCommand, Device, ProjectDomain, State } from "../../domain/types";
import type { StepItem, StepMark } from "../kit";
import { answerEffect, answerOf, arguesForChange, baselineStatus, casesOf, changeRequests, effectOf, importOptions, importQuestions, importSpend, ruleConfidence, type AnswerEffect, type BaselineGap, type BaselineStatus, type ChangeRequest, type Confidence, type ImportOption, type ImportQuestion } from "./phaseB";

export { answerEffect, answerOf, baselineStatus, casesOf, changeRequests, effectOf, importOptions, importQuestions, importSpend, ruleConfidence };
export type { AnswerEffect, BaselineGap, BaselineStatus, ChangeRequest, Confidence, ImportOption, ImportQuestion };

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const shortCommit = (sha: string) => sha.slice(0, 7);

/** The product's name in sentences: the project's name, without the sample's mark (a chip says that). */
export const productName = (s: State) => s.project.name.replace(/\s*\(sample\)$/, "");

/** Which import screen Vision shows: none (the studio), the reading (also once stopped), or the review. */
export function importScreen(s: State): "none" | "reading" | "review" {
  const st = importStatus(s);
  return st === "reading" || st === "stopped" ? "reading" : st === "review" ? "review" : "none";
}

/** The import's address in Vision: the baseline Lock in. */
export const BASELINE_HASH = "#/vision/baseline";

// ---------- 1 · Start ----------

/**
 * What the Start screen reads of a repository before anything runs: GET /api/import/start?path=<absolute path>, or
 * ?sample=tally in the demo (the service writes the invented sample repository and answers for it). Read only. Unit 2
 * builds the route (server/http.ts); this is the shape the screen reads.
 */
export interface ImportStartInfo {
  /** A git repository with at least one commit; else why not. */
  ok: boolean;
  reason?: string;
  /** The absolute path: for the sample, the repository the service wrote. */
  path: string;
  sample?: true;
  /** The commit the import would read: HEAD. */
  commit: string;
  branch?: string;
  /** Counted at the commit: files, not tests (C7). */
  size: RepoSize;
  /** What the repository holds that the counts leave out: "a README", "a pyproject". */
  holds: string[];
  /** Each kind of product, proposed from the repository's files (a data table), with why. */
  kinds: { domain: ProjectDomain; found: boolean; because: string }[];
  devices: { device: Device; found: boolean; because: string }[];
  /** How it runs (C1), each proposed with why. */
  environment: EnvironmentFound;
  testCommand?: { argv: string[]; because: string };
  testReport?: { path: string; because: string };
}

export const startInfoUrl = (q: { path: string } | { sample: "tally" }) => `/api/import/start?${"sample" in q ? `sample=${q.sample}` : `path=${encodeURIComponent(q.path)}`}`;

/** "✓ Found" line: what the repository is, at which commit, and what the import leaves out (C7). */
export function foundLine(info: ImportStartInfo): string {
  const holds = info.holds.length ? `, ${info.holds.length === 1 ? info.holds[0] : `${info.holds.slice(0, -1).join(", ")} and ${info.holds.at(-1)}`}` : "";
  return `a git repository${info.branch ? ` on ${info.branch}` : ""}: ${count(info.size.sourceFiles, "source file")}, ${count(info.size.testFiles, "test file")}${holds}. The import reads the last commit, ${shortCommit(info.commit)}${info.branch ? ` on ${info.branch}` : ""}. Changes you have not committed are left out.`;
}

/** The form on Start: the kinds, the devices, how it runs, the budget and the helpers. */
export interface StartDraft {
  name: string;
  domains: ProjectDomain[];
  devices: Device[];
  /** The environment: the dev container (confirmed with its digest), an image, or none. */
  environment: { devcontainer: { file: string; sha256: string } } | { image: string; prepare: string[][] } | null;
  /** The test command, as one line; "" for none. */
  testCommand: string;
  testReport: string;
  budget: string;
  helpers: boolean;
  helperCap: number;
}

/** The form as Start fills it from what the repository shows: each kind, device and how-it-runs value that was found. */
export function startDraft(info: ImportStartInfo): StartDraft {
  const dc = info.environment.devcontainer;
  const p = info.environment.proposal;
  return {
    name: info.path.replace(/\/+$/, "").split("/").at(-1) ?? "",
    domains: info.kinds.filter((k) => k.found).map((k) => k.domain),
    devices: info.devices.filter((d) => d.found).map((d) => d.device),
    environment: dc?.sha256 && !dc.refused ? { devcontainer: { file: dc.file, sha256: dc.sha256 } } : p ? { image: p.image, prepare: p.prepare } : null,
    testCommand: info.testCommand ? argvLine(info.testCommand.argv) : "",
    testReport: info.testReport?.path ?? "",
    budget: "3",
    helpers: false,
    helperCap: 2,
  };
}

/** An argument list as one line; an argument with a space keeps its quotes. */
export const argvLine = (argv: readonly string[]) => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
/** One line back to arguments: spaces split, quotes keep an argument whole. */
export const splitLine = (line: string) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** How it runs, each part complete or missing, and what a missing part means (C1, Q3 A). */
export function howItRuns(d: StartDraft): { complete: boolean; missing: string[]; effect?: string } {
  const missing = [!d.environment ? "the environment" : "", !d.testCommand.trim() ? "the test command" : "", !d.testReport.trim() ? "the test report's path" : ""].filter(Boolean);
  if (!missing.length) return { complete: true, missing };
  const noEnv = !d.environment;
  return {
    complete: false,
    missing,
    effect: noEnv
      ? "Without an environment, the import never runs your code: the tests do not run, nothing is recorded, and every rule is read from the code (inferred)."
      : "Without a test command and its report, the tests do not run: every rule is read from the code (inferred). The CLI and the screens are still recorded in the environment.",
  };
}

/** Why Start cannot start yet, or undefined. */
export function startBlocker(d: StartDraft): string | undefined {
  if (!d.name.trim()) return "Give the project a name.";
  if (!d.domains.length) return "Choose at least one kind of product.";
  if (!d.devices.length) return "Choose at least one device.";
  const usd = Number(d.budget);
  if (!d.budget.trim() || !Number.isFinite(usd) || usd <= 0) return "The import budget is a positive number of dollars.";
  return undefined;
}

/** The check command the test command makes: one "check", as Settings › Quality › Checks keeps it. */
export const testCheck = (line: string): CheckCommand => ({ id: "tests", label: "Tests", kind: "check", argv: splitLine(line) });

// ---------- 2 · Reading ----------

/** The import's budget line: "$0.74 spent of the $3.00 import budget. The estimate: $0.43–$2.07." */
export function spendWords(s: State): { spent: number; budget: number; estimate: [number, number]; line: string; unknown?: string; atBudget: boolean } {
  const imp = s.studio.import!;
  const sp = importSpend(s);
  const [lo, hi] = imp.estimate.usd;
  return {
    spent: sp.usd,
    budget: imp.budgetUsd,
    estimate: [lo, hi],
    line: `${fmtUsd(sp.usd)} spent of the ${fmtUsd(imp.budgetUsd)} import budget. The estimate: ${fmtUsd(lo)}–${fmtUsd(hi)}.`,
    ...(sp.unknown ? { unknown: `${count(sp.unknown, "run")} recorded no cost, so the spend can be higher.` } : {}),
    atBudget: sp.usd >= imp.budgetUsd,
  };
}

const RUN_MARK = (r: { status: string } | undefined): StepMark => (!r ? "waiting" : r.status === "completed" ? "done" : r.status === "failed" ? "fail" : r.status === "queued" ? "waiting" : "running");
const RUN_STATE: Record<string, string> = { queued: "queued", running: "running", stopping: "stopping", failed: "failed", stopped: "stopped" };

/**
 * The reading, in order (C2): the tests, then the rules, then the parts, then the recording; the words at the same
 * time. Each step's state in words, from the import's records and its runs.
 */
export function readingSteps(s: State): (StepItem & { step: ImportStep | "checks" | "capture" })[] {
  const imp = s.studio.import!;
  const latest = (step: ImportStep) => importRuns(s, step).at(-1);
  const who = (step: ImportStep) => {
    const r = latest(step);
    if (!r) return undefined;
    const by = `${r.kind === "reader" ? "Reader" : "Designer"} · ${r.provider === "claude" ? "Claude" : "Codex"}`;
    return step === "rules" && imp.helpers ? `${by} · up to ${count(imp.helpers, "helper")}, read-only` : by;
  };
  const runState = (step: ImportStep, done: string | undefined) => {
    const r = latest(step);
    if (done) return { mark: "done" as const, state: done };
    if (!r) return { mark: "waiting" as const, state: "not started" };
    return { mark: RUN_MARK(r), state: r.status === "completed" ? "done" : (RUN_STATE[r.status] ?? r.status) };
  };
  const c = imp.checks;
  const checks: StepItem = {
    id: "checks",
    name: "The tests",
    who: "the service",
    ...(c.status === "pending"
      ? { mark: "running" as const, state: "running your test command in the environment" }
      : c.status === "not-run"
        ? { mark: "skipped" as const, state: `not run: ${c.reason}` }
        : { mark: "done" as const, state: testsLine(c.counts) }),
  };
  const reading = imp.reading;
  const withTest = reading ? reading.rules.filter((r) => r.tests.length).length : 0;
  const parts = importParts(s).filter((a) => a.kind !== "dictionary");
  const words = importParts(s).find((a) => a.kind === "dictionary");
  const cap = imp.capture;
  const recorded = cap?.parts.filter((p) => p.status === "captured").length ?? 0;
  return [
    { ...checks, step: "checks" },
    { id: "rules", step: "rules", name: "The rules", who: who("rules"), ...runState("rules", reading ? `${count(reading.rules.length, "rule")}: ${withTest} from the tests, ${reading.rules.length - withTest} from the code and the docs` : undefined) },
    { id: "parts", step: "parts", name: "The parts", who: who("parts"), ...runState("parts", parts.length && latest("parts")?.status === "completed" ? `${count(parts.length, "part")}: ${parts.map((p) => p.title).join(", ")}` : undefined) },
    {
      id: "capture",
      step: "capture",
      name: "The recording",
      who: "the service",
      ...(cap
        ? { mark: recorded ? ("done" as const) : ("skipped" as const), state: cap.parts.length ? `${recorded} of ${cap.parts.length} recorded${cap.simulated ? " (simulated)" : ""}${recorded < cap.parts.length ? `: ${cap.parts.find((p) => p.status === "none")?.detail ?? ""}` : ""}` : "nothing to record" }
        : { mark: "waiting" as const, state: latest("parts")?.status === "completed" ? "recording the parts in the environment" : "after the parts" }),
    },
    { id: "words", step: "words", name: "The words (at the same time)", who: who("words"), ...runState("words", words ? `${count(words.dictionary?.length ?? 0, "word")}` : undefined) },
  ];
}

/** "22 read, all pass", "22 read: 21 pass, 1 fails". */
export function testsLine(c: Record<"passed" | "failed" | "skipped" | "error", number>): string {
  const total = c.passed + c.failed + c.skipped + c.error;
  if (total === c.passed) return `${total} read, all pass`;
  return `${total} read: ${[c.passed ? `${c.passed} pass` : "", c.failed ? `${c.failed} ${c.failed === 1 ? "fails" : "fail"}` : "", c.error ? `${c.error} ended with an error` : "", c.skipped ? `${c.skipped} skipped` : ""].filter(Boolean).join(", ")}`;
}

// ---------- 3 · Review ----------

/** A rule's confidence in words, for its chip and the legend. */
export const CONFIDENCE_WORDS: Record<Confidence, { word: string; tone: "fail" | "you" | "done"; means: string }> = {
  conflict: { word: "conflict", tone: "fail", means: "Two sources disagree, or a test fails." },
  inferred: { word: "inferred", tone: "you", means: "Read from the code. Nothing proves it." },
  confirmed: { word: "confirmed", tone: "done", means: "Every test it names passes." },
};

const FROM_WORD: Record<ImportSource["from"], string> = { test: "The test", code: "The code", docs: "The docs" };

/** A source's name: "The test", "The code", or the document it is in ("README.md"). */
export function sourceName(x: ImportSource): string {
  return x.from === "docs" ? x.ref.split(",")[0].trim() || FROM_WORD.docs : FROM_WORD[x.from];
}

/** A source as the question's table shows it: where, and what it says (with a test's result). */
export function sourceRow(s: State, rule: ImportRule, x: ImportSource): { where: string; says: string } {
  const c = x.from === "test" ? casesOf(s, rule).find((k) => testId(k) === x.ref) : undefined;
  const result = c ? ` · ${c.status === "passed" ? "passes" : c.status === "skipped" ? "skipped" : "fails"}` : "";
  return { where: x.from === "docs" ? x.ref : `${FROM_WORD[x.from]}, ${x.ref}`, says: `${x.says}${result}` };
}

/** An option with its label and what it does, in the product's name. */
export interface OptionWords {
  id: string;
  label: string;
  detail: string;
}

export function optionWords(s: State, q: ImportQuestion): OptionWords[] {
  const name = productName(s);
  const rule = q.rule;
  return importOptions(s, rule).map((o) => {
    if (o.id === "keep") {
      const k = rule.sources.findIndex((_, i) => !arguesForChange(s, rule, i));
      const label = k >= 0 ? `${sourceName(rule.sources[k])}: ${rule.sources[k].says}` : "The code, as it is";
      return { id: o.id, label, detail: `${name} stays as it is, and this goes into the baseline.` };
    }
    if (o.source) {
      const x = rule.sources[o.source - 1];
      return { id: o.id, label: `${sourceName(x)}: ${x.says}`, detail: `${name} must change. The baseline keeps what ${name} does today, and this becomes a change to design.` };
    }
    if (o.id === "neither") return { id: o.id, label: "Neither", detail: "Write what is right. It becomes a change to design." };
    if (o.id === "confirm") return { id: o.id, label: "Confirm", detail: "It goes into the baseline as it is." };
    return { id: o.id, label: "Correct", detail: "Say what is wrong." };
  });
}

/** The two choices of "Correct" (C15), on a guess or on a confirmed rule or part. */
export const CORRECTIONS = (name: string) =>
  [
    { value: "change", label: `${name} should do something else`, hint: "A change to design. The baseline keeps what it does today." },
    { value: "misread", label: `${name} does something else today`, hint: "The reader misread the code. A designer fixes the part before the baseline." },
  ] as const;

/** One answer before it is sent: the option, and for "correct" and "neither" the owner's words. */
export interface DraftAnswer {
  option?: string;
  correction?: "change" | "misread";
  text?: string;
}
export type ReviewDraft = Record<string, DraftAnswer>;
export const ruleKey = (id: string) => `rule:${id}`;
export const partKey = (id: string) => `part:${id}`;
const onOf = (key: string) => (key.startsWith("rule:") ? { rule: key.slice(5) } : { part: key.slice(5) });

/** The answer shown for a rule or a part: the one not sent yet, else the one that counts. */
export function shownAnswer(s: State, draft: ReviewDraft, key: string): DraftAnswer | undefined {
  if (key in draft) return draft[key];
  const a = answerOf(s, onOf(key));
  return a ? { option: a.option, ...(a.correction ? { correction: a.correction } : {}), ...(a.text ? { text: a.text } : {}) } : undefined;
}

/** What the shown answer does: open while none, else its effect (a correction with no kind yet is a change). */
export function shownEffect(s: State, draft: ReviewDraft, key: string): AnswerEffect {
  const a = shownAnswer(s, draft, key);
  if (!a?.option) return "open";
  return effectOf(s, onOf(key), { option: a.option, correction: a.option === "correct" ? (a.correction ?? "change") : undefined });
}

/** What an answer does, in a sentence under the question. Empty while it is open. */
export function effectSentence(s: State, q: ImportQuestion | undefined, a: DraftAnswer | undefined, effect: AnswerEffect): string {
  const name = productName(s);
  const label = q && a?.option ? (optionWords(s, q).find((o) => o.id === a.option)?.label ?? a.option) : a?.option === "correct" ? CORRECTIONS(name)[0].label : "";
  switch (effect) {
    case "open":
      return "";
    case "kept":
      return a?.option === "confirm" ? "Confirmed. It goes into the baseline as it is." : `Your answer: ${label}. ${name} stays as it is, and this goes into the baseline.`;
    case "fixed":
      return `Your answer: ${name} does something else today. A designer fixes the part from your words, and it goes into the baseline as you wrote.`;
    case "change":
      return `Your answer: ${a?.option === "correct" ? CORRECTIONS(name)[0].label : label}. The baseline keeps what ${name} does today. Your change becomes a change to design.`;
  }
}

/** The review's counts: what needs you, what is confirmed, what is not asked, and how many you answered. */
export function reviewCounts(s: State, draft: ReviewDraft) {
  const rules = s.studio.import?.reading?.rules ?? [];
  const qs = importQuestions(s);
  const conflicts = qs.filter((q) => q.kind === "conflict").length;
  const guesses = qs.length - conflicts;
  const confirmed = rules.filter((r) => ruleConfidence(s, r) === "confirmed").length;
  const asked = new Set(qs.map((q) => q.rule.id));
  const notAsked = rules.filter((r) => ruleConfidence(s, r) !== "confirmed" && !asked.has(r.id)).length;
  const answered = qs.filter((q) => shownEffect(s, draft, ruleKey(q.rule.id)) !== "open").length;
  return { questions: qs.length, conflicts, guesses, confirmed, notAsked, answered };
}

/** "2 conflicts and 3 guesses need you; 12 rules are confirmed." */
export function needLine(c: ReturnType<typeof reviewCounts>): { need: string; rest: string } {
  const need = c.questions ? `${[c.conflicts ? count(c.conflicts, "conflict") : "", c.guesses ? count(c.guesses, "guess", "guesses") : ""].filter(Boolean).join(" and ")} ${c.questions === 1 ? "needs" : "need"} you;` : "Nothing needs you;";
  return { need, rest: ` ${count(c.confirmed, "rule")} ${c.confirmed === 1 ? "is" : "are"} confirmed.` };
}

/** The line under the answers: how many are answered, and what happens to the rest if you send now. */
export function answeredLine(c: ReturnType<typeof reviewCounts>): { bold: string; rest?: string } {
  const left = c.questions - c.answered;
  if (!c.questions) return { bold: "There is nothing to answer." };
  if (!left) return { bold: `All ${c.questions} answered.` };
  return { bold: `${c.answered} of ${c.questions} answered.`, rest: `${left} ${left === 1 ? "stays" : "stay"} open if you send now.` };
}

export const UNANSWERED_TEXT = 'An unanswered question goes into the baseline as the code has it, marked "not confirmed", and stays open in Vision.';

/** How a part is listed in the review (C8): recorded from the running code, or read from the code with its rules' tests. */
export function partLine(s: State, a: StudioArtifact): string {
  const name = productName(s);
  if (a.kind === "dictionary") return `${count(a.dictionary?.length ?? 0, "word")}, from the README, the docs and the names in the code.`;
  const cap = s.studio.import?.capture?.parts.find((p) => p.artifactId === a.id);
  const rules = partRules(s, a);
  const passing = rules.filter((r) => ruleConfidence(s, r) === "confirmed" || (casesOf(s, r).length && casesOf(s, r).every((c) => c.status === "passed"))).length;
  const tests = rules.length ? ` Its rules: ${passing} of ${rules.length} have a passing test.` : "";
  if (cap?.status === "captured") return `Recorded from the running ${a.kind === "screen" ? "app" : "CLI"}${s.studio.import?.capture?.simulated ? " (simulated)" : ""}.${tests}`;
  if (cap?.status === "none") return `Read from the code: not recorded, because ${cap.detail.replace(/\.$/, "").replace(/^[A-Z]/, (c) => c.toLowerCase())}.${tests}`;
  return `Read from the code: ${a.provenance?.files.join(", ") || name}.${tests}`;
}

/** The rules a part places, as the reading holds them. */
export function partRules(s: State, a: StudioArtifact): ImportRule[] {
  const ids = new Set((a.rules ?? []).flatMap((v) => v.rules.map((r) => r.id)));
  return (s.studio.import?.reading?.rules ?? []).filter((r) => ids.has(r.id));
}

/** A rule's tests in a line: "test_add.py::test_records_expense +1 more · passes". */
export function testsTag(s: State, rule: ImportRule): string | undefined {
  const cases = casesOf(s, rule);
  if (!cases.length) return undefined;
  const bad = cases.find((c) => c.status !== "passed");
  return `${testId(cases[0])}${cases.length > 1 ? ` +${cases.length - 1} more` : ""} · ${bad ? (bad.status === "skipped" ? "skipped" : "fails") : cases.length > 1 ? "all pass" : "passes"}`;
}

// ---------- 4 · Baseline ----------

export const STATUS_WORDS: Record<BaselineStatus, string> = { "in-force": "in force", "fails-a-check": "fails a check", "built-and-verified": "built and verified", "built-not-verified": "built, not verified" };

/** "tests 4 of 5 pass · 1 no test": a part's rules in one line; undefined without rules. */
export function testsOfPart(s: State, a: StudioArtifact): string | undefined {
  const rules = partRules(s, a);
  if (!rules.length) return undefined;
  const results = rules.map((r) => casesOf(s, r));
  const pass = results.filter((cs) => cs.length && cs.every((c) => c.status === "passed")).length;
  const fail = results.filter((cs) => cs.some((c) => c.status === "failed" || c.status === "error")).length;
  const none = results.filter((cs) => !cs.length).length;
  return [`${pass} of ${rules.length} pass`, fail ? `${fail} ${fail === 1 ? "fails" : "fail"}` : "", none ? `${none} no test` : ""].filter(Boolean).join(" · ");
}

/** The baseline's parts, as Lock in 1 puts them into force: name, kind, status and its tests. */
export function baselineRows(s: State): { id: string; title: string; version: number; kind: string; status: BaselineStatus; tests?: string }[] {
  return importParts(s).map((a) => ({ id: a.id, title: a.title, version: a.version, kind: a.kind.replace("-", " "), status: baselineStatus(s, a).status, ...(testsOfPart(s, a) ? { tests: testsOfPart(s, a) } : {}) }));
}

/** The facts the baseline Lock in records, following the answers you sent. Each is a bold lead and the rest. */
export function baselineFacts(s: State): { bold: string; rest: string }[] {
  const imp = s.studio.import!;
  const name = productName(s);
  const rules = imp.reading?.rules ?? [];
  const parts = importParts(s);
  const verified = rules.filter((r) => casesOf(s, r).length && casesOf(s, r).every((c) => c.status === "passed")).length;
  const failing = rules.filter((r) => casesOf(s, r).some((c) => c.status === "failed" || c.status === "error")).length;
  const noTest = rules.filter((r) => !casesOf(s, r).length);
  const by = (e: AnswerEffect) => noTest.filter((r) => answerEffect(s, { rule: r.id }) === e).length;
  const kept = by("kept") + by("fixed");
  const facts = [{ bold: `${count(parts.length, "part")} and their ${count(rules.length, "rule")}`, rest: ` go into force as ${name} is today. They count as built.` }];
  if (imp.checks.status === "not-run") facts.push({ bold: "The tests did not run:", rest: ` ${imp.checks.reason}. Every rule is read from the code, and no part is recorded.` });
  else facts.push({ bold: `${count(verified, "rule")} ${verified === 1 ? "is" : "are"} verified:`, rest: ` ${verified === 1 ? "its tests pass" : "their tests pass"}.` });
  if (failing) facts.push({ bold: `${count(failing, "rule")} ${failing === 1 ? "fails its test" : "fail their tests"}:`, rest: ` the part reads "fails a check".` });
  if (noTest.length) {
    const parts2 = [kept ? `${kept} you confirmed` : "", by("change") ? `${by("change")} you want changed` : "", by("open") ? `${by("open")} not answered` : ""].filter(Boolean);
    facts.push({ bold: `${count(noTest.length, "rule")} ${noTest.length === 1 ? "has" : "have"} no test:`, rest: ` ${parts2.join(", ")}. They go in as ${name} does them today.` });
  }
  const changes = changeRequests(s).length;
  facts.push(
    changes
      ? { bold: "The factory has nothing to build now.", rest: ` Your ${count(changes, "change")} to design ${changes === 1 ? "waits" : "wait"} for the lead's next round.` }
      : { bold: "The factory has nothing to build.", rest: " It starts when you change the design." },
  );
  return facts;
}

/** What a change request asks, in a line: "tally report: README.md: --csv", or the owner's words. */
export function changeLine(s: State, c: ChangeRequest): string {
  const rule = "rule" in c.on ? s.studio.import?.reading?.rules.find((r) => r.id === (c.on as { rule: string }).rule) : undefined;
  const what = rule ? rule.area : (c.part?.title ?? "A part");
  const k = c.answer.option.startsWith("source-") ? Number(c.answer.option.slice(7)) : 0;
  const x = rule && k ? rule.sources[k - 1] : undefined;
  return `${what}: ${x ? `${x.says}, as ${sourceName(x)} says` : (c.answer.text ?? "as you wrote")}`;
}

/** The rules the owner kept or corrected that no test proves yet: "you confirmed" or "you corrected". */
export function keptRules(s: State): { rule: ImportRule; chip: string; was: string }[] {
  return (s.studio.import?.reading?.rules ?? [])
    .filter((r) => !casesOf(s, r).length || ruleConfidence(s, r) === "conflict")
    .map((r) => ({ r, e: answerEffect(s, { rule: r.id }) }))
    .filter(({ e }) => e === "kept" || e === "fixed")
    .map(({ r, e }) => ({ rule: r, chip: e === "fixed" ? "you corrected" : "you confirmed", was: `${r.id} · was ${ruleConfidence(s, r) === "conflict" ? "a conflict" : "inferred"}${casesOf(s, r).length ? "" : " · no test"}` }));
}

/** The questions not answered: they go in as the code has them, and stay open in Vision. */
export const openQuestions = (s: State) => importQuestions(s).filter((q) => answerEffect(s, { rule: q.rule.id }) === "open");

// ---------- 5 · After ----------

/** The chip an import answer puts beside a rule in Design and reality; undefined when the rule was not asked or answered. */
export function answerChip(s: State, rule: ImportRule): { word: string; tone: "neutral" | "you" } | undefined {
  const asked = importQuestions(s).some((q) => q.rule.id === rule.id);
  const e = answerEffect(s, { rule: rule.id });
  if (e === "open") return asked ? { word: "not confirmed", tone: "you" } : undefined;
  return { word: e === "kept" ? "you confirmed it" : e === "fixed" ? "as you corrected it" : "a change to design", tone: e === "change" ? "you" : "neutral" };
}

/** Why a part of the baseline stands where it does, in one or two sentences. */
export function baselineWhy(s: State, a: StudioArtifact, st: { status: BaselineStatus; gap?: BaselineGap }): string {
  const at = `From the import, at commit ${shortCommit(s.studio.import!.commit)}.`;
  switch (st.status) {
    case "in-force":
      return "A dictionary is not built. It is in force: every agent's brief and the writing check use it.";
    case "fails-a-check":
      return `${at} A test that one of its rules names fails.`;
    case "built-and-verified":
      return `${at} Every rule has a passing test${a.kind === "screen" || a.kind === "terminal-demo" || a.kind === "tui" ? ", and the running code was recorded" : ""}.`;
    case "built-not-verified": {
      const g = st.gap!;
      const gap =
        g.why === "rules-unproved"
          ? [g.noTest ? `${count(g.noTest, "rule")} ${g.noTest === 1 ? "has" : "have"} no test` : "", g.skipped ? `${count(g.skipped, "rule")} only skipped tests` : ""].filter(Boolean).join(", and ")
          : g.why === "no-evidence"
            ? `it was not recorded: ${g.detail.replace(/\.$/, "")}`
            : "it has no rules for a test to prove";
      return `${at} The checks do not prove it yet: ${gap}.`;
    }
  }
}

/** Home and the header after the baseline: nothing to build, or the changes to design that wait. */
export function nothingToBuild(s: State): { bold: string; rest: string; changes: number } {
  const changes = changeRequests(s).length;
  return changes
    ? { bold: "Nothing to build yet:", rest: ` ${count(changes, "change")} to design ${changes === 1 ? "waits" : "wait"}. Ask the lead for a round in Vision, then start the factory.`, changes }
    : { bold: "Nothing to build:", rest: " change the design in Vision to start work.", changes };
}

/** The message "Ask the lead for a round" sends: the changes to design, in the owner's words. */
export function roundRequest(s: State): string {
  const lines = changeRequests(s).map((c) => `- ${changeLine(s, c)}`);
  return `Please open a round to design the changes I asked for in the import's review:\n${lines.join("\n")}`;
}
