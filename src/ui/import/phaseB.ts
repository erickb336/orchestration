// STAND-INS for unit 1, phase B of ORC-032 (the import's derivations, src/domain/studio/import.ts and itemStatus.ts).
// Unit 3 (the UI) started in parallel with phase B, so the screens read these until it lands. Each function follows
// the PE plan's rules (sections 2.3 and 2.4) and names the domain function that replaces it. At integration: delete
// this file and import the domain's functions in importView.ts (its only importer). Pure, from the state only.

import { PRICES, estimateUsd } from "../../domain/spend";
import { importParts, importRuns, testId } from "../../domain/studio/import";
import type { ImportAnswer, ImportRule, ImportStep, StudioArtifact } from "../../domain/studio/types";
import { isCapturedKind } from "../../domain/studio/evidence";
import type { State, TestCaseResult } from "../../domain/types";

/** A rule's confidence (plan 2.3), derived, never the reader's claim. Replaced by the domain's `ruleConfidence`. */
export type Confidence = "conflict" | "confirmed" | "inferred";

/** The baseline report's cases a rule names, in its order; a case the reading does not hold is left out. */
export function casesOf(s: State, rule: ImportRule): TestCaseResult[] {
  const cases = s.studio.import?.reading?.cases ?? [];
  return rule.tests.map((id) => cases.find((c) => testId(c) === id)).filter((c): c is TestCaseResult => !!c);
}

const failing = (c: TestCaseResult) => c.status === "failed" || c.status === "error";

/** The first case of the table that applies wins: a failing test, sources that differ, every test passes, else inferred. */
export function ruleConfidence(s: State, rule: ImportRule): Confidence {
  const cases = casesOf(s, rule);
  if (cases.some(failing) || rule.sources.some((x) => x.differs)) return "conflict";
  return cases.length > 0 && cases.length === rule.tests.length && cases.every((c) => c.status === "passed") ? "confirmed" : "inferred";
}

/** A question of the review: every conflict, then every important guess, at most 10 (Q4). Replaced by `importQuestions`. */
export interface ImportQuestion {
  rule: ImportRule;
  kind: "conflict" | "guess";
}

export const MAX_QUESTIONS = 10;

export function importQuestions(s: State): ImportQuestion[] {
  const rules = s.studio.import?.reading?.rules ?? [];
  const conflicts = rules.filter((r) => ruleConfidence(s, r) === "conflict").map((rule) => ({ rule, kind: "conflict" as const }));
  const guesses = rules.filter((r) => ruleConfidence(s, r) === "inferred" && r.important).map((rule) => ({ rule, kind: "guess" as const }));
  return [...conflicts, ...guesses].slice(0, MAX_QUESTIONS);
}

/**
 * One option of a question. `keeps`: the code stays as it is. For a conflict: "keep" (what the code does), then
 * "source-<k>" for each source that says otherwise (a source that differs, or a failing test), then "neither". For a
 * guess: "confirm" and "correct". Replaced by the domain's `importOptions`.
 */
export interface ImportOption {
  id: string;
  keeps: boolean;
  /** The source the option takes (1-based), for "source-<k>". */
  source?: number;
}

/** Whether a source says something other than what the code does: it differs, or it is a test that fails. */
export function arguesForChange(s: State, rule: ImportRule, k: number): boolean {
  const x = rule.sources[k];
  if (x.differs) return true;
  return x.from === "test" && casesOf(s, rule).some((c) => testId(c) === x.ref && failing(c));
}

export function importOptions(s: State, rule: ImportRule): ImportOption[] {
  if (ruleConfidence(s, rule) !== "conflict") return [{ id: "confirm", keeps: true }, { id: "correct", keeps: false }];
  const other = rule.sources.map((_, k) => k).filter((k) => arguesForChange(s, rule, k));
  return [{ id: "keep", keeps: true }, ...other.map((k) => ({ id: `source-${k + 1}`, keeps: false, source: k + 1 })), { id: "neither", keeps: false }];
}

/** What an answer does (plan 2.3): kept, a change to design, a fix of the reading, or open (no answer). */
export type AnswerEffect = "kept" | "change" | "fixed" | "open";

type On = ImportAnswer["on"];
const sameOn = (a: On, b: On) => ("rule" in a && "rule" in b && a.rule === b.rule) || ("part" in a && "part" in b && a.part === b.part);

/** The answer that counts on a rule or a part: the newest. */
export function answerOf(s: State, on: On): ImportAnswer | undefined {
  return s.studio.import?.answers.filter((a) => sameOn(a.on, on)).at(-1);
}

/** The effect of an answer (or of none). A misread after the baseline Lock in is a change (Q6). Replaced by `answerEffect`. */
export function effectOf(s: State, on: On, answer: Pick<ImportAnswer, "option" | "correction"> & { at?: string } | undefined): AnswerEffect {
  if (!answer) return "open";
  if (answer.option === "correct") {
    const locked = s.studio.import?.lockedInAt;
    return answer.correction === "misread" && (!locked || !answer.at || answer.at < locked) ? "fixed" : "change";
  }
  if (answer.option === "confirm") return "kept";
  const rule = "rule" in on ? s.studio.import?.reading?.rules.find((r) => r.id === on.rule) : undefined;
  return rule && importOptions(s, rule).find((o) => o.id === answer.option)?.keeps ? "kept" : "change";
}

export const answerEffect = (s: State, on: On): AnswerEffect => effectOf(s, on, answerOf(s, on));

/**
 * The owner's change requests (C5): every answer whose effect is a change, while no newer version of its part exists.
 * Derived, not stored. Replaced by the domain's `changeRequests`.
 */
export interface ChangeRequest {
  on: On;
  answer: ImportAnswer;
  /** The part it changes. */
  part?: StudioArtifact;
}

export function changeRequests(s: State): ChangeRequest[] {
  const imp = s.studio.import;
  if (!imp) return [];
  const parts = importParts(s);
  const out: ChangeRequest[] = [];
  const seen = new Set<string>();
  for (const a of [...imp.answers].reverse()) {
    const key = "rule" in a.on ? `rule:${a.on.rule}` : `part:${a.on.part}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (effectOf(s, a.on, a) !== "change") continue;
    const ruleId = "rule" in a.on ? a.on.rule : undefined;
    const part = ruleId ? parts.find((p) => p.rules?.some((v) => v.rules.some((r) => r.id === ruleId))) : parts.find((p) => p.id === (a.on as { part: string }).part);
    // A newer version of the part than the one in the baseline answers it.
    const newer = part && s.studio.artifacts.some((x) => x.id === part.id && x.version > part.version && x.at > a.at);
    if (!newer) out.push({ on: a.on, answer: a, ...(part ? { part } : {}) });
  }
  return out.reverse();
}

/**
 * The import's spend (plan 2.5): its runs, and the lead's runs from its start to the baseline Lock in. A simulated run
 * is a known $0; a cost with no record is counted apart. Replaced by the domain's `importSpend`.
 */
export interface ImportSpend {
  usd: number;
  /** Runs with no full record of their cost: unknown, never zero. */
  unknown: number;
  byStep: Partial<Record<ImportStep | "lead", number>>;
}

export function importSpend(s: State): ImportSpend {
  const imp = s.studio.import;
  const out: ImportSpend = { usd: 0, unknown: 0, byStep: {} };
  if (!imp) return out;
  const end = imp.lockedInAt ?? "￿";
  const lead = s.leadRuns.filter((r) => r.startedAt >= imp.startedAt && r.startedAt <= end);
  const runs: { step: ImportStep | "lead"; cost: ReturnType<typeof estimateUsd> }[] = [
    ...importRuns(s).filter((r) => r.status !== "queued").map((r) => ({ step: r.importStep!, cost: estimateUsd(r, PRICES) })),
    ...lead.map((r) => ({ step: "lead" as const, cost: estimateUsd(r, PRICES) })),
  ];
  for (const { step, cost } of runs) {
    if (cost.basis === "unknown") out.unknown++;
    const usd = cost.usd ?? cost.recordedUsd ?? 0;
    out.usd += usd;
    out.byStep[step] = (out.byStep[step] ?? 0) + usd;
  }
  return out;
}

/** The status of a part of the baseline (plan 2.4). Replaced by a step in the domain's `itemFactoryStatus`. */
export type BaselineStatus = "in-force" | "fails-a-check" | "built-and-verified" | "built-not-verified";
export type BaselineGap = { why: "rules-unproved"; noTest: number; skipped: number } | { why: "no-evidence"; detail: string } | { why: "kind-not-checked" };

export function baselineStatus(s: State, part: StudioArtifact): { status: BaselineStatus; gap?: BaselineGap } {
  if (part.kind === "dictionary") return { status: "in-force" };
  const rules = (s.studio.import?.reading?.rules ?? []).filter((r) => part.rules?.some((v) => v.rules.some((x) => x.id === r.id)));
  const results = rules.map((r) => casesOf(s, r));
  if (results.some((cs) => cs.some(failing))) return { status: "fails-a-check" };
  const noTest = results.filter((cs) => !cs.length).length;
  const skipped = results.filter((cs) => cs.length && !cs.every((c) => c.status === "passed")).length;
  if (noTest || skipped) return { status: "built-not-verified", gap: { why: "rules-unproved", noTest, skipped } };
  if (isCapturedKind(part.kind)) {
    const cap = s.studio.import?.capture?.parts.find((p) => p.artifactId === part.id);
    if (!cap || cap.status !== "captured") return { status: "built-not-verified", gap: { why: "no-evidence", detail: cap?.status === "none" ? cap.detail : "Nothing was recorded." } };
  } else if (!rules.length) return { status: "built-not-verified", gap: { why: "kind-not-checked" } };
  return { status: "built-and-verified" };
}
