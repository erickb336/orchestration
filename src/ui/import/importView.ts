// The import of an existing repository (ORC-032) in words: what the five screens (Start, Reading, Review, Baseline
// and After) say, as pure functions of the state, so they can be tested without a browser. The facts come from
// src/domain/studio/import.ts (the review, the answers, the baseline), spend.ts (the import's spend and stop) and
// itemStatus.ts (a baseline item's status).

import type { ImportStartInfo } from "../../api";
import { PRICES, estimateUsd, fmtUsd, importSpend, importStop } from "../../domain/spend";
import { projectPause } from "../../domain/places";
import { PREVIEW_PORTS } from "../../domain/studio/evidence";
import {
  answerEffect,
  changeRequests,
  citedSources,
  importHold,
  importParts,
  importQuestions,
  importRuns,
  importStatus,
  itemAnswerEffect,
  ruleConfidence,
  testId,
  unansweredQuestions,
  type AnswerEffect,
  type ChangeRequest,
  type Confidence,
  type ImportOption,
  type ImportTarget,
} from "../../domain/studio/import";
import type { ImportProjectStart, ImportRule, ImportSource, ImportStep, StudioArtifact } from "../../domain/studio/types";
import { DEVICES, PROJECT_DOMAINS, type Device, type ProjectDomain, type State, type TestCaseResult } from "../../domain/types";
import type { StepItem, StepMark } from "../kit";
import { kindWord } from "../studio/studioView";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortCommit = (sha: string) => sha.slice(0, 7);

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

/** A repository the Start screen found (src/api.ts, ImportStartInfo: what the routes read before anything runs). */
export type FoundRepository = Extract<ImportStartInfo, { ok: true }>;

/** Where the Start screen reads a repository: the demo's sample, or the path the owner gave. */
export const startInfoRequest = (q: { path: string } | "demo"): { url: string; method: "GET" | "POST" } => (q === "demo" ? { url: "/api/import/demo", method: "POST" } : { url: `/api/import/start?path=${encodeURIComponent(q.path)}`, method: "GET" });

/** "✓ Found" line: what the repository is, at which commit, and what the import leaves out (C7). */
export function foundLine(info: FoundRepository): string {
  return `a git repository${info.branch ? ` on ${info.branch}` : ""}: ${count(info.size.sourceFiles, "source file")} and ${count(info.size.testFiles, "test file")}. The import reads the last commit, ${shortCommit(info.commit)}${info.branch ? ` on ${info.branch}` : ""}. Changes you have not committed are left out.`;
}

/** Why the repository shows a kind of product or a device: the files that show it; undefined when none does. */
export const foundBecause = (info: FoundRepository, match: (d: FoundRepository["domains"][number]) => boolean) => info.domains.filter(match).map((d) => d.because).join("; ") || undefined;

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
  /** For a screen product on a desktop or a phone: what serves the app, as one line, and its port ("" for none). */
  preview: string;
  port: string;
  budget: string;
  /** Who reads the repository (Q5): Claude by default; Codex only if you pick it. */
  readsOn: "claude" | "codex";
  helpers: boolean;
  helperCap: number;
}

/** Who reads the repository, in words (Q5, CR-5): each choice, and the warning that comes with Codex. */
export const READS_ON = {
  claude: { label: "Claude", hint: "Recommended. Its reads stay in a read-only copy of the repository." },
  codex: { label: "Codex", hint: "Its reads are not confined to the repository." },
  warning: "Codex's reads are not confined to the repository: a text in the repository can steer it to read other files on this computer. Pick Codex only for a repository you trust.",
} as const;

/** Whether the product has screens the capture opens in a browser: a screen product on a desktop or a phone. */
export const hasPages = (d: Pick<StartDraft, "domains" | "devices">) => d.domains.includes("screen") && d.devices.some((x) => x !== "terminal");

/** The preview setting Start sends (setPreview), or undefined when it has no command or the product has no pages. */
export function previewSetting(d: StartDraft): { preview: string[]; port: number } | undefined {
  return hasPages(d) && d.preview.trim() ? { preview: splitLine(d.preview), port: Number(d.port) } : undefined;
}

/** The form as Start fills it from what the repository shows: each kind, device and how-it-runs value that was found. */
export function startDraft(info: FoundRepository): StartDraft {
  const dc = info.devcontainer;
  const p = info.proposal;
  const test = info.testReport?.command ?? info.checks.find((c) => c.kind === "check");
  return {
    name: info.path.replace(/\/+$/, "").split("/").at(-1) ?? "",
    domains: PROJECT_DOMAINS.filter((d) => info.domains.some((x) => x.domain === d)),
    devices: DEVICES.filter((d) => info.domains.some((x) => x.device === d)),
    environment: dc?.sha256 && !dc.refused ? { devcontainer: { file: dc.file, sha256: dc.sha256 } } : p ? { image: p.image, prepare: p.prepare } : null,
    testCommand: test ? argvLine(test.argv) : "",
    testReport: info.testReport?.path ?? "",
    preview: "",
    port: "",
    budget: "3",
    readsOn: "claude",
    helpers: false,
    helperCap: 2,
  };
}

/** An argument list as one line; an argument with a space keeps its quotes. */
export const argvLine = (argv: readonly string[]) => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
/** One line back to arguments: spaces split, quotes keep an argument whole. */
const splitLine = (line: string) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

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
  const p = previewSetting(d);
  if (p && !(Number.isInteger(p.port) && p.port >= PREVIEW_PORTS.min && p.port <= PREVIEW_PORTS.max)) return `The preview's port is a number from ${PREVIEW_PORTS.min} to ${PREVIEW_PORTS.max}.`;
  return undefined;
}

/**
 * Everything Start sends, as one command (`startImport`, CR-5 and QA-F3): the new project on the repository it read,
 * the kinds and devices, how it runs, who reads it, the budget and the helpers. The service checks it all before any
 * change, so a refusal leaves the project you have as it was.
 */
export function startArgs(info: FoundRepository, d: StartDraft): ImportProjectStart {
  const env = d.environment && ("devcontainer" in d.environment ? { prepare: [], hosts: [], devcontainer: d.environment.devcontainer } : { image: d.environment.image, prepare: d.environment.prepare, hosts: [] });
  const preview = previewSetting(d);
  return {
    name: d.name.trim(),
    repoPath: info.path,
    commit: info.commit,
    ...(info.branch ? { branch: info.branch } : {}),
    size: info.size,
    domains: d.domains,
    devices: d.devices,
    ...(env ? { environment: env } : {}),
    ...(preview ? { preview } : {}),
    ...(d.testCommand.trim() ? { tests: { argv: splitLine(d.testCommand), ...(d.testReport.trim() ? { report: d.testReport.trim() } : {}) } } : {}),
    readsOn: d.readsOn,
    budgetUsd: Number(d.budget),
    helpers: d.helpers ? d.helperCap : null,
  };
}

// ---------- 2 · Reading ----------

/** The import's budget line: "$0.74 spent of the $3.00 import budget. The estimate: $0.43–$2.07." */
export function spendWords(s: State): { spent: number; budget: number; estimate: [number, number]; line: string; unknown?: string; stop?: string } {
  const imp = s.studio.import!;
  const sp = importSpend(s);
  const [lo, hi] = imp.estimate.usd;
  const stop = importStop(s);
  return {
    spent: sp.usd,
    budget: imp.budgetUsd,
    estimate: [lo, hi],
    line: `${fmtUsd(sp.usd)} spent of the ${fmtUsd(imp.budgetUsd)} import budget. The estimate: ${fmtUsd(lo)}–${fmtUsd(hi)}.`,
    ...(sp.unknown.length ? { unknown: `${count(sp.unknown.length, "run")} recorded no cost, so the spend can be higher.` } : {}),
    ...(stop ? { stop: stop.why } : {}),
  };
}

/** What each step of the import cost so far, from its runs' costs (a simulated run is a known $0); the lead's replies apart. */
export function spendByStep(s: State): { step: ImportStep | "lead"; usd: number }[] {
  const imp = s.studio.import!;
  const end = imp.lockedInAt ?? "￿";
  const runs = [...importRuns(s).map((r) => ({ step: r.importStep!, r })), ...s.leadRuns.filter((r) => r.startedAt >= imp.startedAt && r.startedAt < end).map((r) => ({ step: "lead" as const, r }))];
  const out = new Map<ImportStep | "lead", number>();
  for (const { step, r } of runs) {
    const c = estimateUsd(r, PRICES);
    out.set(step, (out.get(step) ?? 0) + (c.usd ?? c.recordedUsd ?? 0));
  }
  return [...out].map(([step, usd]) => ({ step, usd }));
}

/**
 * Why the import does not go on now, or undefined while it does: you paused the project (pausing until its runs
 * confirm the stop), its spend reached the import budget, or it stopped. `pill` is the import's state in a few words;
 * `step` is what a held step says. The reading, Home and the header read this one source.
 */
export interface ImportHalt {
  kind: "pausing" | "paused" | "budget" | "stopped";
  pill: string;
  step: string;
}
export function importHalt(s: State): ImportHalt | undefined {
  const imp = s.studio.import;
  if (!imp || imp.lockedInAt) return undefined;
  if (imp.stopped) return { kind: "stopped", pill: "stopped", step: "stopped" };
  const pause = projectPause(s);
  if (pause) return pause.state === "paused" ? { kind: "paused", pill: "paused by you", step: "paused" } : { kind: "pausing", pill: "pausing", step: "pausing" };
  if (importStop(s)) return { kind: "budget", pill: "waits at its budget", step: "waits at the import budget" };
  return undefined;
}

const RUN_MARK = (r: { status: string } | undefined): StepMark => (!r ? "waiting" : r.status === "completed" ? "done" : r.status === "failed" ? "fail" : r.status === "queued" ? "waiting" : "running");
const RUN_STATE: Record<string, string> = { queued: "queued", running: "running", stopping: "stopping", failed: "failed", stopped: "stopped" };

/**
 * The reading, in order (C2): the tests, then the rules, then the parts, then the recording; the words at the same
 * time. Each step's state in words, from the import's records and its runs. While the import is halted, a step under
 * way or queued says why it waits (paused, stopped, at the budget); at the budget, a run already running goes on.
 */
export function readingSteps(s: State): StepItem[] {
  const imp = s.studio.import!;
  const halt = importHalt(s);
  const held = <T extends { mark: StepMark; state: string }>(st: T, queued = false): T | { mark: "waiting"; state: string } =>
    halt && st.mark !== "done" && st.mark !== "skipped" && st.mark !== "fail" && (queued || (st.mark === "running" && halt.kind !== "budget")) ? { mark: "waiting", state: halt.step } : st;
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
    return held({ mark: RUN_MARK(r), state: r.status === "completed" ? "done" : (RUN_STATE[r.status] ?? r.status) }, r.status === "queued" || r.status === "stopped");
  };
  const c = imp.checks;
  const reading = imp.reading;
  const withTest = reading ? reading.rules.filter((r) => r.tests.length).length : 0;
  const parts = importParts(s).filter((a) => a.kind !== "dictionary");
  const words = importParts(s).find((a) => a.kind === "dictionary");
  const cap = imp.capture;
  const recorded = cap?.parts.filter((p) => p.status === "captured").length ?? 0;
  return [
    {
      id: "checks",
      name: "The tests",
      who: "the service",
      ...(c.status === "pending" ? held({ mark: "running" as const, state: "running your test command in the environment" }) : c.status === "not-run" ? { mark: "skipped" as const, state: `not run: ${c.reason}` } : { mark: "done" as const, state: testsLine(c.counts) }),
    },
    { id: "rules", name: "The rules", who: who("rules"), ...runState("rules", reading ? `${count(reading.rules.length, "rule")}: ${withTest} from the tests, ${reading.rules.length - withTest} from the code and the docs` : undefined) },
    // The Words is a part too, as the baseline and the lead count it (UX-R2-3): one count everywhere.
    { id: "parts", name: "The parts", who: who("parts"), ...runState("parts", parts.length && latest("parts")?.status === "completed" ? `${count(parts.length + (words ? 1 : 0), "part")}: ${[...parts, ...(words ? [words] : [])].map((p) => p.title).join(", ")}` : undefined) },
    {
      id: "capture",
      name: "The recording",
      who: "the service",
      ...(cap
        ? { mark: recorded ? ("done" as const) : ("skipped" as const), state: cap.parts.length ? `${recorded} of ${cap.parts.length} recorded${cap.simulated ? " (simulated)" : ""}${recorded < cap.parts.length ? `: ${cap.parts.find((p) => p.status === "none")?.detail ?? ""}` : ""}` : "nothing to record" }
        : latest("parts")?.status === "completed"
          ? held({ mark: "waiting" as const, state: "recording the parts in the environment" }, halt?.kind !== "budget")
          : { mark: "waiting" as const, state: "after the parts" }),
    },
    { id: "words", name: "The words (at the same time)", who: who("words"), ...runState("words", words ? count(words.dictionary?.length ?? 0, "word") : undefined) },
  ];
}

type PillTone = "done" | "work" | "neutral" | "fail" | "you";
const HALT_TONE: Record<ImportHalt["kind"], PillTone> = { stopped: "fail", budget: "you", paused: "neutral", pausing: "work" };

/** The import's state pill on the reading and on Home: why it waits, else `busy` while it reads. */
export function importPill(s: State, busy: string): { text: string; tone: PillTone; pulse: boolean; paused: boolean } {
  const halt = importHalt(s);
  return halt ? { text: halt.pill, tone: HALT_TONE[halt.kind], pulse: false, paused: halt.kind === "paused" || halt.kind === "pausing" } : { text: busy, tone: "work", pulse: true, paused: false };
}

const HELD_STEP: Record<ImportStep, string> = { words: "the words", rules: "the rules", parts: "the parts", fix: "a fix" };

/** What the import's stop holds, in a sentence: "It holds the fix of The ledger and the lead's message for round 0."; undefined when it holds nothing. */
export function heldLine(s: State): string | undefined {
  const holds = importHold(s)?.holds ?? [];
  if (!holds.length) return undefined;
  const words = holds.map((h) => (h.step === "review" ? "the lead's message for round 0" : h.step === "fix" && h.artifactId ? `the fix of ${s.studio.artifacts.find((a) => a.id === h.artifactId)?.title ?? "a part"}` : HELD_STEP[h.step]));
  return `It holds ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0]}.`;
}

/** Home's sentence while the import waits at its budget: "The import budget is reached: $3.20 of $3.00. Raise it in Vision to go on." */
export function budgetStopLine(s: State): string | undefined {
  const stop = importHalt(s)?.kind === "budget" ? spendWords(s).stop : undefined;
  return stop ? `${stop}. Raise it in Vision to go on.` : undefined;
}

/**
 * The state of the three cards under the steps, from the same steps: done; reading, designing or recording while its
 * step runs; else why it waits (paused, stopped, at the budget), or "waiting" before it starts.
 */
export function readingCards(s: State): Record<"rules" | "parts" | "words", { pill: string; tone: PillTone }> {
  const halt = importHalt(s);
  const by = new Map(readingSteps(s).map((x) => [x.id, x]));
  const card = (mark: StepMark | undefined, busy: string) =>
    mark === "done" || mark === "skipped" ? { pill: "done", tone: "done" as const } : mark === "running" ? { pill: busy, tone: "work" as const } : mark === "fail" ? { pill: "failed", tone: "fail" as const } : halt ? { pill: halt.pill, tone: HALT_TONE[halt.kind] } : { pill: "waiting", tone: "neutral" as const };
  // The parts' card covers the designer, then the recording, which the service goes on with at the budget.
  const recording = by.get("capture")!.mark;
  const capturing = recording === "waiting" && (!halt || halt.kind === "budget");
  return {
    rules: card(by.get("rules")?.mark, "reading"),
    parts: by.get("parts")?.mark !== "done" ? card(by.get("parts")?.mark, "designing") : capturing ? { pill: "recording", tone: "work" } : card(recording, "recording"),
    words: card(by.get("words")?.mark, "reading"),
  };
}

/** The line under the reading about round 0: when it opens, or nothing once the import stopped. */
export function roundZeroLine(s: State): string | undefined {
  const halt = importHalt(s);
  if (halt?.kind === "stopped") return undefined;
  if (halt?.kind === "paused" || halt?.kind === "pausing") return "The reading is paused. When you resume it and it ends, round 0, As it is today, opens here.";
  if (halt?.kind === "budget") return "The reading waits at its budget. When you raise the budget and the reading ends, round 0, As it is today, opens here.";
  return "When the reading ends, round 0, As it is today, opens here. It asks you only what the code cannot answer.";
}

/** "22 read, all pass", "22 read: 21 pass, 1 fails". */
function testsLine(c: Record<"passed" | "failed" | "skipped" | "error", number>): string {
  const total = c.passed + c.failed + c.skipped + c.error;
  if (total === c.passed) return `${total} read, all pass`;
  return `${total} read: ${[c.passed ? `${c.passed} pass` : "", c.failed ? `${c.failed} ${c.failed === 1 ? "fails" : "fail"}` : "", c.error ? `${c.error} ended with an error` : "", c.skipped ? `${c.skipped} skipped` : ""].filter(Boolean).join(", ")}`;
}

// ---------- 3 · Review ----------

/** A rule's confidence in words, for its chip and the legend. */
export const CONFIDENCE_WORDS: Record<Confidence["level"], { word: string; tone: "fail" | "you" | "done"; means: string }> = {
  conflict: { word: "conflict", tone: "fail", means: "Two sources disagree, or a test fails." },
  inferred: { word: "inferred", tone: "you", means: "Read from the code. Nothing proves it." },
  confirmed: { word: "confirmed", tone: "done", means: "Every test it names passes." },
};

/** The import's rule by its id. */
export const ruleOf = (s: State, id: string): ImportRule | undefined => s.studio.import?.reading?.rules.find((r) => r.id === id);

/** The baseline report's cases a rule names, in its order. */
function ruleCases(s: State, rule: ImportRule): TestCaseResult[] {
  const cases = s.studio.import?.reading?.cases ?? [];
  return rule.tests.map((id) => cases.find((c) => testId(c) === id)).filter((c): c is TestCaseResult => !!c);
}

const FROM_WORD: Record<ImportSource["from"], string> = { test: "The test", code: "The code", docs: "The docs" };

/**
 * A question's sources as its table shows them: where, and what each says (with a test's result), then a line on its
 * tests when it names none. With the tests not run, it cites no test (UX-10) and says the tests did not run (QA3-F1).
 */
export function sourceRows(s: State, rule: ImportRule): { where: string; says: string }[] {
  const rows = citedSources(s.studio.import!, rule).map(({ source: x }) => {
    const c = x.from === "test" ? ruleCases(s, rule).find((k) => testId(k) === x.ref) : undefined;
    const result = c ? ` · ${c.status === "passed" ? "passes" : c.status === "skipped" ? "skipped" : "fails"}` : "";
    return { where: x.from === "docs" ? x.ref : `${FROM_WORD[x.from]}, ${x.ref}`, says: `${x.says}${result}` };
  });
  if (testsNotRun(s)) return [...rows, { where: "Tests", says: "The tests did not run." }];
  return rule.tests.length ? rows : [...rows, { where: "Tests", says: "No test covers it." }];
}

/** An option with its label (the domain's) and what it does. */
interface OptionWords {
  id: string;
  label: string;
  detail: string;
  needsText: boolean;
}

export function optionWords(s: State, options: readonly ImportOption[]): OptionWords[] {
  const name = productName(s);
  return options.map((o) => ({
    id: o.id,
    label: o.label,
    needsText: !!o.needsText,
    detail:
      o.id === "confirm"
        ? "It goes into the baseline as it is."
        : o.id === "correct"
          ? "Say what is wrong."
          : o.id === "neither"
            ? "Write what is right. It becomes a change to design."
            : o.keeps
              ? `${name} stays as it is, and this goes into the baseline.`
              : `${name} must change. The baseline keeps what ${name} does today, and this becomes a change to design.`,
  }));
}

/** The two choices of "Correct" (C15), on a guess or on a confirmed rule or part. */
export const CORRECTIONS = (name: string, lockedIn = false) =>
  [
    { value: "change", label: `${name} should do something else`, hint: "A change to design. The baseline keeps what it does today." },
    { value: "misread", label: `${name} does something else today`, hint: lockedIn ? "The reader misread the code. After the baseline, it becomes a change to design, and its task adds the missing test." : "The reader misread the code. A designer fixes the part before the baseline." },
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
export const targetOf = (key: string): ImportTarget => (key.startsWith("rule:") ? { rule: key.slice(5) } : { part: key.slice(5) });

/** The answer shown for a rule or a part: the one not sent yet, else the one that counts. */
export function shownAnswer(s: State, draft: ReviewDraft, key: string): DraftAnswer | undefined {
  if (key in draft) return draft[key];
  const on = JSON.stringify(targetOf(key));
  const a = s.studio.import?.answers.filter((x) => JSON.stringify(x.on) === on).at(-1);
  return a ? { option: a.option, ...(a.correction ? { correction: a.correction } : {}), ...(a.text ? { text: a.text } : {}) } : undefined;
}

/** What the shown answer does: open while none, else its effect (a correction with no kind yet is a change). */
export function shownEffect(s: State, a: DraftAnswer | undefined): AnswerEffect | "open" {
  if (!a?.option || !s.studio.import) return "open";
  // An answer you send now: after the baseline, a misreading is a change too (Q6).
  return answerEffect(s.studio.import, { on: { rule: "" }, option: a.option, ...(a.option === "correct" ? { correction: a.correction ?? "change" } : {}), at: s.studio.import.lockedInAt ?? "" });
}

/** What an answer does, in a sentence under the question. Empty while it is open. */
export function effectSentence(s: State, options: readonly ImportOption[], a: DraftAnswer | undefined): string {
  const name = productName(s);
  const effect = shownEffect(s, a);
  const label = a?.option === "correct" ? CORRECTIONS(name)[0].label : (options.find((o) => o.id === a?.option)?.label ?? "");
  switch (effect) {
    case "open":
      return "";
    case "kept":
      return a?.option === "confirm" ? "Confirmed. It goes into the baseline as it is." : `Your answer: ${label}. ${name} stays as it is, and this goes into the baseline.`;
    case "fixed":
      return `Your answer: ${name} does something else today. A designer fixes the part from your words, and it goes into the baseline as you wrote.`;
    case "change":
      if (a?.option === "correct" && a.correction === "misread") return `Your answer: ${name} does something else today. After the baseline, it becomes a change to design, and its task adds the missing test.`;
      return `Your answer: ${label}. The baseline keeps what ${name} does today. Your change becomes a change to design.`;
  }
}

/** The review's counts: what needs you, what is confirmed, what is not asked, and how many you answered. */
export function reviewCounts(s: State, draft: ReviewDraft) {
  const imp = s.studio.import!;
  const rules = imp.reading?.rules ?? [];
  const { asked, notAsked } = importQuestions(imp);
  const conflicts = asked.filter((q) => q.kind === "conflict").length;
  const confirmed = rules.filter((r) => ruleConfidence(imp, r).level === "confirmed").length;
  const answered = asked.filter((q) => shownEffect(s, shownAnswer(s, draft, ruleKey(q.ruleId))) !== "open").length;
  return { questions: asked.length, conflicts, guesses: asked.length - conflicts, confirmed, notAsked: notAsked.length, answered };
}

/** "2 conflicts and 3 guesses need you;" and " 12 rules are confirmed." */
export function needLine(c: ReturnType<typeof reviewCounts>): { need: string; rest: string } {
  const need = c.questions ? `${[c.conflicts ? count(c.conflicts, "conflict") : "", c.guesses ? count(c.guesses, "guess", "guesses") : ""].filter(Boolean).join(" and ")} ${c.questions === 1 ? "needs" : "need"} you;` : "Nothing needs you;";
  return { need, rest: ` ${count(c.confirmed, "rule")} ${c.confirmed === 1 ? "is" : "are"} confirmed.` };
}

/** The line in the send bar: how many are answered, and what happens to the rest if you send now. */
export function answeredLine(c: ReturnType<typeof reviewCounts>): { bold: string; rest?: string } {
  const left = c.questions - c.answered;
  if (!c.questions) return { bold: "There is nothing to answer." };
  if (!left) return { bold: `All ${c.questions} answered.` };
  return { bold: `${c.answered} of ${c.questions} answered.`, rest: `${left} ${left === 1 ? "stays" : "stay"} open if you send now.` };
}

export const UNANSWERED_TEXT = 'An unanswered question goes into the baseline as the code has it, marked "not confirmed", and stays open in Vision.';

/** The rules a part places, as the reading holds them. */
function partRules(s: State, a: StudioArtifact): ImportRule[] {
  const ids = new Set((a.rules ?? []).flatMap((v) => v.rules.map((r) => r.id)));
  return (s.studio.import?.reading?.rules ?? []).filter((r) => ids.has(r.id));
}

/** Every test a rule names passes (at least one). */
const verified = (s: State, r: ImportRule) => {
  const cs = ruleCases(s, r);
  return cs.length > 0 && cs.every((c) => c.status === "passed");
};

/** The import's tests did not run (no Docker, no environment, no test command): no rule has a result. */
export const testsNotRun = (s: State) => s.studio.import?.checks.status === "not-run";

/** How a part is listed in the review (C8): recorded from the running code, or read from the code, with its rules' tests. */
export function partLine(s: State, a: StudioArtifact): string {
  if (a.kind === "dictionary") return `${count(a.dictionary?.length ?? 0, "word")}, from the README, the docs and the names in the code.`;
  const cap = s.studio.import?.capture?.parts.find((p) => p.artifactId === a.id);
  const rules = partRules(s, a);
  const tests = !rules.length ? "" : testsNotRun(s) ? " The tests did not run." : ` Its rules: ${rules.filter((r) => verified(s, r)).length} of ${rules.length} have a passing test.`;
  if (cap?.status === "captured") return `Recorded from the running ${a.kind === "screen" ? "app" : "CLI"}${s.studio.import?.capture?.simulated ? " (simulated)" : ""}.${tests}`;
  if (cap?.status === "none") return `Read from the code: not recorded, because ${cap.detail.replace(/\.$/, "").replace(/^[A-Z]/, (c) => c.toLowerCase())}.${tests}`;
  return `Read from the code: ${a.provenance?.files.join(", ")}.${tests}`;
}

const PREVIEW_LINES = 6;

/**
 * The few lines a part's tile shows of it (UX-8, as the prototype): a recording's first lines of output, or a
 * document's first code block (its pseudo-code or data), else its first lines of text. Empty lines and headings are
 * left out.
 */
export function previewLines(kind: "transcript" | "document", text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  if (kind === "document") {
    const open = lines.findIndex((l) => l.trimStart().startsWith("```"));
    const close = open < 0 ? -1 : lines.findIndex((l, i) => i > open && l.trimStart().startsWith("```"));
    if (open >= 0 && close > open + 1) return lines.slice(open + 1, close).slice(0, PREVIEW_LINES);
  }
  return lines.filter((l) => l.trim() && !(kind === "document" && /^#|^\|?\s*-{3}/.test(l.trim()))).slice(0, PREVIEW_LINES);
}

/** A rule's tests in a line: "test_add.py::test_records_expense +1 more · all pass". */
export function testsTag(s: State, rule: ImportRule): string | undefined {
  const cases = ruleCases(s, rule);
  if (!cases.length) return undefined;
  const bad = cases.find((c) => c.status !== "passed");
  return `${testId(cases[0])}${cases.length > 1 ? ` +${cases.length - 1} more` : ""} · ${bad ? (bad.status === "skipped" ? "skipped" : "fails") : cases.length > 1 ? "all pass" : "passes"}`;
}

// ---------- 4 · Baseline ----------

/** "5 of 5 pass", "2 of 3 pass · 1 no test", "4 of 5 pass · 1 fails": a part's rules and the tests they name. */
function partTests(s: State, a: StudioArtifact): string | undefined {
  const rules = partRules(s, a);
  if (!rules.length) return undefined;
  if (testsNotRun(s)) return "not run";
  const cases = rules.map((r) => ruleCases(s, r));
  const fails = cases.filter((cs) => cs.some((c) => c.status === "failed" || c.status === "error")).length;
  const none = cases.filter((cs) => !cs.length).length;
  return [`${cases.filter((cs) => cs.length && cs.every((c) => c.status === "passed")).length} of ${rules.length} pass`, fails ? `${fails} ${fails === 1 ? "fails" : "fail"}` : "", none ? `${none} no test` : ""].filter(Boolean).join(" · ");
}

/** The baseline's parts: name, version and kind, its rules' tests, and whether the import recorded it. */
export function baselineRows(s: State): { id: string; title: string; version: number; facts: string }[] {
  return importParts(s).map((a) => {
    const cap = s.studio.import?.capture?.parts.find((p) => p.artifactId === a.id);
    const tests = partTests(s, a);
    return { id: a.id, title: a.title, version: a.version, facts: [kindWord(a.kind), tests ? `tests ${tests}` : "", cap ? (cap.status === "captured" ? "recorded" : "not recorded") : ""].filter(Boolean).join("; ") };
  });
}

/** The facts the baseline Lock in records, following the answers you sent: a bold lead and the rest of each. */
export function baselineFacts(s: State): { bold: string; rest: string }[] {
  const imp = s.studio.import!;
  const name = productName(s);
  const rules = imp.reading?.rules ?? [];
  const parts = importParts(s);
  const verifiedN = rules.filter((r) => verified(s, r)).length;
  const failing = rules.filter((r) => ruleCases(s, r).some((c) => c.status === "failed" || c.status === "error")).length;
  const noTest = rules.filter((r) => !ruleCases(s, r).length);
  const by = (e: AnswerEffect | "open") => noTest.filter((r) => itemAnswerEffect(imp, { rule: r.id }) === e).length;
  const kept = by("kept") + by("fixed");
  const facts = [{ bold: `${count(parts.length, "part")} and their ${count(rules.length, "rule")}`, rest: ` go into force as ${name} is today. They count as built.` }];
  if (imp.checks.status === "not-run") facts.push({ bold: "The tests did not run:", rest: ` ${imp.checks.reason}. Every rule is read from the code, and no part is recorded.` });
  else facts.push({ bold: `${count(verifiedN, "rule")} ${verifiedN === 1 ? "is" : "are"} verified:`, rest: ` ${verifiedN === 1 ? "its tests pass" : "their tests pass"}.` });
  if (failing) facts.push({ bold: `${count(failing, "rule")} ${failing === 1 ? "fails its test" : "fail their tests"}:`, rest: ` the part reads "fails a check".` });
  if (noTest.length) {
    const split = [kept ? `${kept} you confirmed` : "", by("change") ? `${by("change")} you want changed` : "", by("open") ? `${by("open")} not answered` : ""].filter(Boolean);
    // With the tests not run, a rule may name a test that did not run: it has no result, not "no test" (QA3-F1).
    const none = imp.checks.status === "not-run" ? "no test result" : "no test";
    facts.push({ bold: `${count(noTest.length, "rule")} ${noTest.length === 1 ? "has" : "have"} ${none}:`, rest: ` ${split.join(", ")}. They go in as ${name} does them today.` });
  }
  const changes = openChanges(s).length;
  facts.push(
    changes
      ? { bold: "The factory has nothing to build now.", rest: ` Your ${count(changes, "change")} to design ${changes === 1 ? "waits" : "wait"} for the lead's next round.` }
      : { bold: "The factory has nothing to build.", rest: " It starts when you change the design." },
  );
  return facts;
}

/**
 * What the Baseline screen says when the summary it shows changes, beside your agreement (which it clears): a change
 * from elsewhere (another tab, a fixed part) is news; your own Accept of the vision on this screen is not, and needs a
 * word only when it clears an agreement you gave.
 */
export function summaryChanged(o: { own: boolean; agreed: boolean }): { tone: "you" | "info"; title: string; text: string } | undefined {
  if (!o.own) return { tone: "you", title: "The summary changed while you read it.", text: "This is the new summary. Read it again, and agree again to lock it in." };
  return o.agreed ? { tone: "info", title: "You accepted the vision, so the summary changed.", text: "It now holds the vision. Agree again to lock it in." } : undefined;
}

/** The changes to design that wait (C5): open while no newer version of their part exists. */
export const openChanges = (s: State) => changeRequests(s).filter((c) => c.open);

/** A change request in a line: "tally add: The docs: a currency on each expense", or the owner's words. */
export function changeLine(s: State, c: ChangeRequest): string {
  const part = s.studio.artifacts.find((a) => a.id === c.artifactId);
  return `${part?.title ?? "A part"}: ${c.text}`;
}

/** The rules the owner kept or corrected that no test proves, or that two sources disagreed on. */
export function keptRules(s: State): { rule: ImportRule; chip: string; was: string }[] {
  const imp = s.studio.import!;
  return (imp.reading?.rules ?? [])
    .map((r) => ({ r, c: ruleConfidence(imp, r), e: itemAnswerEffect(imp, { rule: r.id }) }))
    .filter(({ r, c, e }) => (!ruleCases(s, r).length || c.level === "conflict") && (e === "kept" || e === "fixed"))
    .map(({ r, c, e }) => ({ rule: r, chip: e === "fixed" ? "you corrected" : "you confirmed", was: `${r.id} · was ${c.level === "conflict" ? "a conflict" : "inferred"}${testsNotRun(s) ? " · tests not run" : ruleCases(s, r).length ? "" : " · no test"}` }));
}

/** The questions not answered: they go in as the code has them, and stay open in Vision. */
export function openQuestions(s: State): ImportRule[] {
  const imp = s.studio.import!;
  return unansweredQuestions(imp)
    .map((q) => ruleOf(s, q.ruleId)!)
    .filter(Boolean);
}

// ---------- 5 · After ----------

/** The chip an import answer puts beside a rule in Design and reality; undefined when it was neither asked nor answered. */
export function answerChip(s: State, ruleId: string): { word: string; tone: "neutral" | "you" } | undefined {
  const imp = s.studio.import;
  if (!imp) return undefined;
  const e = itemAnswerEffect(imp, { rule: ruleId });
  if (e === "open") return importQuestions(imp).asked.some((q) => q.ruleId === ruleId) ? { word: "not confirmed", tone: "you" } : undefined;
  return { word: e === "kept" ? "you confirmed it" : e === "fixed" ? "as you corrected it" : "a change to design", tone: e === "change" ? "you" : "neutral" };
}

/** An imported part in Vision after the Lock in (UX-5): what it is, and how it changes. */
export function baselinePartLine(s: State): string {
  const imp = s.studio.import;
  return `What ${productName(s)} does today, at commit ${shortCommit(imp?.commit ?? "")}: in force and built since Lock in 1. To change it, ask the lead for a round.`;
}

/** "1 change to design waits for a round:", beside Ask the lead for a round. */
export const changesWaitLine = (n: number) => `${count(n, "change")} to design ${n === 1 ? "waits" : "wait"} for a round:`;

/** Home after the baseline: nothing to build, or the changes to design that wait. */
export function nothingToBuild(s: State): { bold: string; rest: string; changes: number } {
  const changes = openChanges(s).length;
  return changes
    ? { bold: "Nothing to build yet:", rest: ` ${count(changes, "change")} to design ${changes === 1 ? "waits" : "wait"}. Ask the lead for a round in Vision, then start the factory.`, changes }
    : { bold: "Nothing to build:", rest: " change the design in Vision to start work.", changes };
}

/** The message "Ask the lead for a round" sends: the changes to design, in the owner's words. */
export function roundRequest(s: State): string {
  return `Please open a round to design the changes I asked for in the import's review:\n${openChanges(s)
    .map((c) => `- ${changeLine(s, c)}`)
    .join("\n")}`;
}
