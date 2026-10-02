// The check of the lead's text against the controlled-English style, pure: which text is checked (the reply and the
// questions, as the owner reads them), the compact record kept on the lead run, and the record the lead's next run is
// told about. Running Vale is vale.ts's job; the feedback's wording is the envelope's (server/envelope.ts).

import type { LeadRun, ProseCheck, ProseExample, ProseRuleCount, State } from "../../src/domain/types";
import type { ProseChecker, ValeAlert, ValeOutcome } from "./vale";

/** The style's sentence marks (vale/styles/STE80/Sentence.yml): counted, never reported as a broken rule. */
export const SENTENCE_MARK = "STE80.Sentence";
export const MAX_RULES = 12;
export const MAX_EXAMPLES = 5;
export const MAX_SENTENCE = 200;
const MAX_MATCH = 60;
const MAX_WHAT = 120;

/** A text to check, and where each part of it starts: "reply" at line 1, then "question 1", "question 2" and so on. */
export interface ProseDoc {
  text: string;
  parts: { name: string; firstLine: number }[];
}

/** The lead's output as the parser returns it; the questions are untrusted and read defensively. */
interface LeadText {
  reply: string;
  questions?: unknown;
  studio?: unknown;
}

const strings = (q: unknown): string[] => {
  if (!q || typeof q !== "object") return [];
  const { question, why } = q as { question?: unknown; why?: unknown };
  return [question, why].filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.replace(/\r\n?/g, "\n").trim().replace(/\n{2,}/g, "\n"));
};

/**
 * One text to check from named parts, in order, each its own paragraph: what the record's examples point into
 * ("reply line 2"). Parts with no text are left out; undefined when none has any. The lead's reply is one; a studio
 * run's text (server/studio/) is another.
 */
export function proseDoc(blocks: readonly { name: string; text: string }[]): ProseDoc | undefined {
  const kept = blocks.map((b) => ({ name: b.name, text: b.text.replace(/\r\n?/g, "\n").trim() })).filter((b) => b.text);
  if (!kept.length) return undefined;
  const parts: ProseDoc["parts"] = [];
  let line = 1;
  for (const b of kept) {
    parts.push({ name: b.name, firstLine: line });
    line += b.text.split("\n").length + 1;
  }
  return { text: kept.map((b) => b.text).join("\n\n"), parts };
}

/**
 * The text the owner reads from a lead reply: the reply, then each question with its reason (the reply's own
 * questions, then the studio round's), one paragraph each. Undefined when there is no text. Options are labels, not
 * sentences, and are not checked.
 */
export function leadDoc(out: LeadText): ProseDoc | undefined {
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  const studioQuestions = out.studio && typeof out.studio === "object" ? (out.studio as { questions?: unknown }).questions : undefined;
  const questions = [...list(out.questions), ...list(studioQuestions)].map(strings).filter((q) => q.length);
  return proseDoc([{ name: "reply", text: out.reply }, ...questions.map((q, i) => ({ name: `question ${i + 1}`, text: q.join("\n") }))]);
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Where a line of the document is: its part and the line within it. */
function placeOf(doc: ProseDoc, line: number): { part: string; line: number } {
  let at = doc.parts[0];
  for (const p of doc.parts) if (p.firstLine <= line) at = p;
  return { part: at.name, line: line - at.firstLine + 1 };
}

/**
 * The compact record of one check: the sentences checked and how many had no alert, each broken rule with its count
 * (errors first, then by count), and examples: the first alert of each broken rule, then later ones in text order, at
 * most 5, each with the sentence it is in. An alert counts against the sentence it starts in, so a long paragraph
 * counts against its first sentence.
 */
export function proseRecord(doc: ProseDoc, outcome: ValeOutcome, at: string): ProseCheck {
  if (!outcome.checked) return { status: "not-checked", at, reason: outcome.reason };
  const marks = outcome.alerts.filter((a) => a.rule === SENTENCE_MARK);
  const alerts = outcome.alerts.filter((a): a is ValeAlert & { level: "error" | "warning" } => a.rule !== SENTENCE_MARK && a.level !== "suggestion");
  const before = (m: ValeAlert, a: ValeAlert) => m.line < a.line || (m.line === a.line && m.col <= a.col);
  const sentenceOf = (a: ValeAlert) => {
    let found = -1;
    marks.forEach((m, i) => {
      if (before(m, a)) found = i;
    });
    return found;
  };
  const flagged = new Set(alerts.map(sentenceOf).filter((i) => i >= 0));
  const byRule = new Map<string, ProseRuleCount>();
  for (const a of alerts) {
    const r = byRule.get(a.rule) ?? { rule: a.rule, level: a.level, what: clip(a.what || a.rule, MAX_WHAT), count: 0 };
    r.count++;
    byRule.set(a.rule, r);
  }
  const rules = [...byRule.values()].sort((x, y) => (x.level === y.level ? y.count - x.count : x.level === "error" ? -1 : 1)).slice(0, MAX_RULES);
  const example = (a: ValeAlert): ProseExample => {
    const i = sentenceOf(a);
    const sentence = clip(i >= 0 ? marks[i].match : a.match, MAX_SENTENCE);
    const match = clip(a.match, MAX_MATCH);
    return { rule: a.rule, ...placeOf(doc, a.line), sentence, ...(match && match.length < sentence.length && !match.endsWith("…") ? { match } : {}) };
  };
  const firsts = rules.map((r) => alerts.find((a) => a.rule === r.rule)!);
  const rest = alerts.filter((a) => !firsts.includes(a));
  const examples = [...firsts, ...rest].slice(0, MAX_EXAMPLES).map(example);
  return { status: "checked", at, vale: outcome.vale, sentences: marks.length, passed: marks.length - flagged.size, rules, examples };
}

/** Check one text; undefined when there is none. */
export function checkDoc(doc: ProseDoc | undefined, check: ProseChecker, at: string): ProseCheck | undefined {
  return doc ? proseRecord(doc, check(doc.text), at) : undefined;
}

/** Check the text of a lead reply; undefined when it has none. */
export function checkLeadText(out: LeadText, check: ProseChecker, at: string): ProseCheck | undefined {
  return checkDoc(leadDoc(out), check, at);
}

/** The state with the record on the lead run, when the run completed (a run stopped or gone keeps none). */
export function withLeadProse(s: State, runId: string, check: ProseCheck): State {
  if (!s.leadRuns.some((r) => r.id === runId && r.outcome === "completed")) return s;
  return { ...s, leadRuns: s.leadRuns.map((r): LeadRun => (r.id === runId ? { ...r, prose: check } : r)) };
}

/**
 * The record of the lead's last reply before `runId`: the newest completed run before it that has one. The lead's
 * next run is told what it broke; undefined when no reply was checked yet.
 */
export function lastLeadProse(s: State, runId: string): ProseCheck | undefined {
  const end = s.leadRuns.findIndex((r) => r.id === runId);
  const runs = end < 0 ? s.leadRuns : s.leadRuns.slice(0, end);
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].outcome === "completed" && runs[i].prose) return runs[i].prose;
  return undefined;
}
