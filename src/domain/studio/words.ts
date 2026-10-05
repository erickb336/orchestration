// The project's words and the fixed sentence patterns of a flow's rules (ORC-029 pass 4d, decisions 6 and 7).
//
// The owner and the agents must mean the same thing by each word, and an undecided case becomes a special case in
// code. So the data round makes the project's dictionary (each term with one meaning and the words it replaces), and
// the flows round writes its rules in EARS's five sentence patterns and its acceptance examples in Gherkin's form, so
// an edge case shows as an "If …, then …" rule or as a missing one.
//
// Both files are a designer's output, so they are checked at import (server/studio/artifacts.ts calls these parsers);
// what passes is recorded on the artifact version as typed data. Pure.

import { CONTROL_RE, oneLine } from "../model/textSafety";
import type { DictionaryEntry, FlowExample, FlowRule, RulePattern } from "./types";

/** A dictionary artifact's one file. */
export const DICTIONARY_FILE = "dictionary.json";
/** A flow variant's rules, beside its entry. */
export const RULES_FILE = "rules.json";

export const MAX_TERMS = 100;
export const MAX_TERM = 40;
export const MAX_MEANING = 300;
export const MAX_AVOID = 8;
export const MAX_RULES = 60;
export const MAX_EXAMPLES = 30;
export const MAX_RULE_TEXT = 400;
/** The most existing tests one rule names (ORC-032), and the longest test id ("suite::name"). */
export const MAX_RULE_TESTS = 20;
export const MAX_TEST_ID = 500;
/** The most problems one refusal lists: the designer's next run fixes them together. */
const MAX_ERRORS = 8;

/** What a parser gives: the checked value, or every problem it found (at most 8), each one line. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
/** One line of an agent's text: control and invisible characters removed, whitespace collapsed. */
const line = (x: string) => oneLine(x.replace(CONTROL_G, ""));
const show = (x: string, max = 60) => JSON.stringify(x.length > max ? `${x.slice(0, max - 1)}…` : x);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const done = <T>(errors: string[], value: T): Parsed<T> => (errors.length ? { ok: false, errors: errors.slice(0, MAX_ERRORS) } : { ok: true, value });

// ---------- the dictionary ----------

/** A term or an avoided word: letters, digits, spaces, "-", "'" and ".", starting with a letter or a digit. */
const WORD = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} '’.-]*$/u;
/** Words are compared without case ("Trip plan" and "trip plan" are one word); `line` has already collapsed their spaces. */
export const sameWord = (w: string) => w.toLowerCase();

/**
 * A dictionary.json: a list of 1 to 100 `{ "term", "meaning", "avoid" }`. A term is a word or a short phrase (at
 * most 40 characters), its meaning one line (at most 300), and `avoid` up to 8 words it replaces (it may be left
 * out). No term twice; an avoided word is not a term, and is avoided under one term only, so each word the check
 * reports has one replacement.
 */
export function parseDictionary(raw: unknown): Parsed<DictionaryEntry[]> {
  if (!Array.isArray(raw)) return { ok: false, errors: [`${DICTIONARY_FILE} is a list of { "term", "meaning", "avoid" }`] };
  if (!raw.length || raw.length > MAX_TERMS) return { ok: false, errors: [`${DICTIONARY_FILE} has between 1 and ${MAX_TERMS} terms; it has ${raw.length}`] };
  const errors: string[] = [];
  const word = (v: unknown) => (typeof v === "string" ? line(v) : "");
  const okWord = (w: string) => !!w && w.length <= MAX_TERM && WORD.test(w);
  const entries = raw.map((e, i): DictionaryEntry => {
    const at = `term ${i + 1}`;
    if (!isObj(e)) {
      errors.push(`${at} is not { "term", "meaning", "avoid" }`);
      return { term: "", meaning: "", avoid: [] };
    }
    const term = word(e.term);
    const where = term ? `${at} (${show(term)})` : at;
    if (!okWord(term)) errors.push(`${where}: "term" is 1 to ${MAX_TERM} characters: letters, digits, spaces, "-", "'" and ".", starting with a letter or a digit`);
    const meaning = typeof e.meaning === "string" ? line(e.meaning) : "";
    if (!meaning || meaning.length > MAX_MEANING) errors.push(`${where}: "meaning" is one line of 1 to ${MAX_MEANING} characters`);
    const given = e.avoid === undefined || e.avoid === null ? [] : e.avoid;
    if (!Array.isArray(given) || given.length > MAX_AVOID) {
      errors.push(`${where}: "avoid" is a list of at most ${MAX_AVOID} words`);
      return { term, meaning, avoid: [] };
    }
    const avoid: string[] = [];
    for (const a of given) {
      const w = word(a);
      if (!okWord(w)) errors.push(`${where}: the avoided word ${show(typeof a === "string" ? a : JSON.stringify(a) ?? "")} is not 1 to ${MAX_TERM} characters of letters, digits, spaces, "-", "'" and "."`);
      else if (sameWord(w) === sameWord(term)) errors.push(`${where}: it avoids itself`);
      else if (avoid.some((x) => sameWord(x) === sameWord(w))) errors.push(`${where}: it avoids ${show(w)} twice`);
      else avoid.push(w);
    }
    return { term, meaning, avoid };
  });
  const termAt = new Map<string, number>();
  entries.forEach((e, i) => {
    if (!e.term) return;
    const first = termAt.get(sameWord(e.term));
    if (first !== undefined) errors.push(`term ${i + 1} (${show(e.term)}) is also term ${first + 1}: list each term once`);
    else termAt.set(sameWord(e.term), i);
  });
  const avoidedAt = new Map<string, number>();
  entries.forEach((e, i) => {
    for (const w of e.avoid) {
      const term = termAt.get(sameWord(w));
      const other = avoidedAt.get(sameWord(w));
      if (term !== undefined) errors.push(`term ${i + 1} (${show(e.term)}): the avoided word ${show(w)} is also a term (term ${term + 1}); a word is either used or avoided`);
      else if (other !== undefined) errors.push(`term ${i + 1} (${show(e.term)}): the avoided word ${show(w)} is also avoided under ${show(entries[other].term)}; each avoided word has one term to use instead`);
      else avoidedAt.set(sameWord(w), i);
    }
  });
  return done(errors, entries);
}

// ---------- rules and examples ----------

/** Each pattern: its name for the owner, its form, and how a rule's text is matched (without case; the final period is optional). */
export const PATTERNS: readonly { pattern: RulePattern; name: string; form: string; re: RegExp }[] = [
  { pattern: "always", name: "Always", form: "The <system> shall <response>.", re: /^the\s+\S.*?\s+shall\s+\S.*?\.?$/i },
  { pattern: "event", name: "Event", form: "When <trigger>, the <system> shall <response>.", re: /^when\s+\S.*?,\s*the\s+\S.*?\s+shall\s+\S.*?\.?$/i },
  { pattern: "state", name: "State", form: "While <state>, the <system> shall <response>.", re: /^while\s+\S.*?,\s*the\s+\S.*?\s+shall\s+\S.*?\.?$/i },
  { pattern: "unwanted", name: "Unwanted", form: "If <unwanted condition>, then the <system> shall <response>.", re: /^if\s+\S.*?,\s*then\s+the\s+\S.*?\s+shall\s+\S.*?\.?$/i },
  { pattern: "optional", name: "Optional", form: "Where <feature is included>, the <system> shall <response>.", re: /^where\s+\S.*?,\s*the\s+\S.*?\s+shall\s+\S.*?\.?$/i },
];
/** The pattern's name for the owner: "Event", "Unwanted"… */
export const PATTERN_NAME: Record<RulePattern, string> = Object.fromEntries(PATTERNS.map((p) => [p.pattern, p.name])) as Record<RulePattern, string>;

/** An acceptance example's form (Gherkin's). */
export const EXAMPLE_FORM = "Given <context>, when <action>, then <result>.";
const EXAMPLE_RE = /^given\s+\S.*?,\s*when\s+\S.*?,\s*then\s+\S.*?\.?$/i;

/** The pattern a rule's text fits, or undefined when it fits none. */
export function rulePattern(text: string): RulePattern | undefined {
  const t = line(text);
  return PATTERNS.find((p) => p.re.test(t))?.pattern;
}

/** Whether an example's text fits "Given <context>, when <action>, then <result>." */
export const isExample = (text: string): boolean => EXAMPLE_RE.test(line(text));

/** What a refused line is told to fit: every rule pattern, and the example's form. */
export const PATTERNS_HELP = `A rule fits one of: ${PATTERNS.map((p) => `"${p.form}"`).join("; ")}. An example fits "${EXAMPLE_FORM}"`;

const ID = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * A rules.json: `{ "rules": [{ "id", "text", "tests"? }], "examples": [{ "id", "text" }] }`, with 1 to 60 rules, each
 * in one of EARS's five patterns and naming up to 20 existing tests (ORC-032; the import checks them against its
 * baseline report), and up to 30 examples (the list may be left out), each "Given …, when …, then …". Ids are
 * letters, digits, "-" and "_", each once across both lists. Each line that fits no pattern is named with its id;
 * then the patterns it may fit.
 */
export function parseRules(raw: unknown): Parsed<{ rules: FlowRule[]; examples: FlowExample[] }> {
  if (!isObj(raw) || !Array.isArray(raw.rules)) return { ok: false, errors: [`${RULES_FILE} is { "rules": [{ "id", "text" }], "examples": [{ "id", "text" }] }`] };
  const given = raw.examples === undefined || raw.examples === null ? [] : raw.examples;
  if (!Array.isArray(given)) return { ok: false, errors: [`"examples" in ${RULES_FILE} is a list of { "id", "text" }`] };
  if (!raw.rules.length || raw.rules.length > MAX_RULES) return { ok: false, errors: [`${RULES_FILE} has between 1 and ${MAX_RULES} rules; it has ${raw.rules.length}`] };
  if (given.length > MAX_EXAMPLES) return { ok: false, errors: [`${RULES_FILE} has at most ${MAX_EXAMPLES} examples; it has ${given.length}`] };
  const errors: string[] = [];
  let unfit = false;
  const ids = new Set<string>();
  const lineOf = (v: unknown, i: number, what: "rule" | "example"): { id: string; text: string } | undefined => {
    if (!isObj(v) || typeof v.id !== "string" || typeof v.text !== "string") {
      errors.push(`${what} ${i + 1} is not { "id", "text" }`);
      return undefined;
    }
    const id = v.id.trim();
    const text = line(v.text);
    if (!ID.test(id)) errors.push(`${what} ${i + 1}: the id ${show(id)} is 1 to 20 letters, digits, "-" and "_"`);
    else if (ids.has(id)) errors.push(`${what} ${id}: the id is used twice; give each rule and example its own`);
    ids.add(id);
    if (!text || text.length > MAX_RULE_TEXT) {
      errors.push(`${what} ${id || i + 1}: the text is one line of 1 to ${MAX_RULE_TEXT} characters`);
      return undefined;
    }
    return { id, text };
  };
  const rules: FlowRule[] = [];
  raw.rules.forEach((v, i) => {
    const r = lineOf(v, i, "rule");
    if (!r) return;
    // The existing tests that prove it (ORC-032): ids of the baseline report, which the import checks against it.
    const tests = (v as { tests?: unknown }).tests;
    if (tests !== undefined && (!Array.isArray(tests) || tests.length > MAX_RULE_TESTS || !tests.every((t) => typeof t === "string" && t.length > 0 && t.length <= MAX_TEST_ID) || new Set(tests).size !== tests.length)) {
      errors.push(`rule ${r.id}: "tests" is a list of at most ${MAX_RULE_TESTS} different test ids`);
      return;
    }
    const pattern = rulePattern(r.text);
    if (pattern) rules.push({ ...r, pattern, ...(tests?.length ? { tests: tests as string[] } : {}) });
    else {
      unfit = true;
      errors.push(`rule ${r.id} fits no pattern: ${show(r.text, 160)}`);
    }
  });
  const examples: FlowExample[] = [];
  given.forEach((v, i) => {
    const x = lineOf(v, i, "example");
    if (!x) return;
    if (isExample(x.text)) examples.push(x);
    else {
      unfit = true;
      errors.push(`example ${x.id} fits no pattern: ${show(x.text, 160)}`);
    }
  });
  if (!errors.length) return { ok: true, value: { rules, examples } };
  const listed = errors.slice(0, MAX_ERRORS);
  return { ok: false, errors: unfit ? [...listed, PATTERNS_HELP] : listed };
}
