// A measure for the playground: how much of the agents' real text passes the controlled-English style (vale/).
// It reads the real-run records in docs/real-runs/*.json and takes the lead's messages to the owner (with their
// questions), the lead's briefs, and the PE's verdicts (their reasons, changes and open cases, one answer per PE run).
// It checks each one as the service does (server/prose/, server/studio/pe.ts), and prints the share of sentences
// with no alert, by kind and by rule. The designer's documents are the other studio text the service checks; the
// records keep none of their text, so the report says how many there were. A report: it never fails.
//
//   node --import tsx scripts/prose-measure.mjs            the summary
//   node --import tsx scripts/prose-measure.mjs --verbose  also each alert, with its sentence, to judge false positives

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_KINDS } from "../src/domain/studio/types.ts";
import { leadDoc, proseRecord } from "../server/prose/record.ts";
import { runVale } from "../server/prose/vale.ts";
import { peDoc } from "../server/studio/pe.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "docs/real-runs");
const verbose = process.argv.includes("--verbose");
const VERDICTS = ["feasible", "feasible-if", "not-feasible"];

/** The lead's texts in one record: every `lead.message` (with its questions) and every lead step's brief. */
export function leadTexts(record) {
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.lead && typeof o.lead.message === "string") {
      const questions = (Array.isArray(o.lead.questions) ? o.lead.questions : []).map((q) => ({ question: q.text ?? q.question, why: q.reason ?? q.why }));
      found.push({ kind: "message", doc: leadDoc({ reply: o.lead.message, questions }) });
    }
    if (o.brief && typeof o.brief.summary === "string") found.push({ kind: "brief", doc: leadDoc({ reply: o.brief.summary, questions: [] }) });
    for (const v of Object.values(o)) walk(v);
  };
  walk(record);
  return found;
}

/**
 * The PE's answers in one record: its verdicts (objects with a verdict word and reasons), grouped by the PE run that
 * made them, as the service checks one answer. A verdict with no run is its own answer.
 */
export function peTexts(record) {
  const runs = new Map();
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (VERDICTS.includes(o.verdict) && typeof o.reasons === "string") {
      const run = o.by?.runId ?? `${o.artifact ?? ""}/${o.variant ?? ""}`;
      const openCases = (Array.isArray(o.openCases) ? o.openCases : []).filter((c) => typeof c?.text === "string").map((c) => ({ text: c.text, ...(typeof c.why === "string" ? { why: c.why } : {}) }));
      runs.set(run, [...(runs.get(run) ?? []), { variant: o.variant ?? undefined, verdict: o.verdict, reasons: o.reasons, ...(typeof o.change === "string" ? { change: o.change } : {}), ...(openCases.length ? { openCases } : {}) }]);
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(record);
  return [...runs.values()].map((verdicts) => ({ kind: "pe", doc: peDoc(verdicts) }));
}

/** The designer's document artifacts a record names (kind contract, flow, interface, algorithm or topology). */
function designerDocuments(record) {
  let n = 0;
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (DOCUMENT_KINDS.includes(o.kind) && typeof o.title === "string") n++;
    for (const v of Object.values(o)) walk(v);
  };
  walk(record);
  return n;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const seen = new Set();
const texts = [];
let documents = 0;
for (const f of files) {
  const record = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  documents += designerDocuments(record);
  for (const t of [...leadTexts(record), ...peTexts(record)]) {
    if (!t.doc) continue;
    const key = `${t.kind}\n${t.doc.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push({ file: f, ...t });
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const KINDS = { message: "Lead messages and questions", brief: "Lead briefs", pe: "PE verdicts (reasons, changes, open cases)" };
const totals = Object.fromEntries(Object.keys(KINDS).map((k) => [k, { texts: 0, sentences: 0, passed: 0 }]));
const rules = new Map();
let vale = "";
for (const t of texts) {
  const outcome = runVale(t.doc.text);
  if (!outcome.checked) {
    console.log(`Not checked: ${outcome.reason}.`);
    process.exit(0);
  }
  vale = outcome.vale;
  const rec = proseRecord(t.doc, outcome, new Date().toISOString());
  const sum = totals[t.kind];
  sum.texts++;
  sum.sentences += rec.sentences;
  sum.passed += rec.passed;
  for (const r of rec.rules) rules.set(`${r.level} ${r.rule}: ${r.what}`, (rules.get(`${r.level} ${r.rule}: ${r.what}`) ?? 0) + r.count);
  console.log(`${t.file} ${t.kind}: ${rec.passed} of ${rec.sentences} sentences pass${rec.rules.length ? ` (${rec.rules.map((r) => `${r.rule.replace("STE80.", "")} ${r.count}`).join(", ")})` : ""}`);
  if (verbose) {
    for (const a of outcome.alerts.filter((x) => x.level !== "suggestion")) {
      const mark = outcome.alerts.filter((x) => x.rule === "STE80.Sentence" && (x.line < a.line || (x.line === a.line && x.col <= a.col))).pop();
      console.log(`    ${a.rule.replace("STE80.", "")} [${a.match.slice(0, 50)}] in: ${(mark?.match ?? a.match).replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
}
const all = Object.values(totals).reduce((x, y) => ({ sentences: x.sentences + y.sentences, passed: x.passed + y.passed }), { sentences: 0, passed: 0 });
console.log(`\nVale ${vale}, the STE80 style, ${files.length} records in docs/real-runs.`);
for (const [k, label] of Object.entries(KINDS)) console.log(`${label}: ${totals[k].texts} texts, ${totals[k].passed} of ${totals[k].sentences} sentences pass (${pct(totals[k].passed, totals[k].sentences)}).`);
console.log(`Designer documents: ${documents} in the records, which keep none of their text, so none was checked.`);
console.log(`All: ${all.passed} of ${all.sentences} sentences pass (${pct(all.passed, all.sentences)}).`);
console.log("Alerts by rule:");
for (const [k, n] of [...rules.entries()].sort((a, b) => b[1] - a[1])) console.log(`- ${k} ${n}`);
