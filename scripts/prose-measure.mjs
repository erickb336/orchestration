// A measure for the playground: how much of the lead's real text passes the controlled-English style (vale/).
// It reads the real-run records in docs/real-runs/*.json, takes the lead's messages to the owner (with their
// questions) and the lead's briefs, checks each one as the service checks a lead reply (server/prose/), and prints the
// share of sentences with no alert, by kind and by rule. A report: it never fails.
//
//   node --import tsx scripts/prose-measure.mjs            the summary
//   node --import tsx scripts/prose-measure.mjs --verbose  also each alert, with its sentence, to judge false positives

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { leadDoc, proseRecord } from "../server/prose/record.ts";
import { runVale } from "../server/prose/vale.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "docs/real-runs");
const verbose = process.argv.includes("--verbose");

/** The lead's texts in one record: every `lead.message` (with its questions) and every lead step's brief. */
export function leadTexts(record) {
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.lead && typeof o.lead.message === "string") {
      const questions = (Array.isArray(o.lead.questions) ? o.lead.questions : []).map((q) => ({ question: q.text ?? q.question, why: q.reason ?? q.why }));
      found.push({ kind: "message", reply: o.lead.message, questions });
    }
    if (o.brief && typeof o.brief.summary === "string") found.push({ kind: "brief", reply: o.brief.summary, questions: [] });
    for (const v of Object.values(o)) walk(v);
  };
  walk(record);
  return found;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const seen = new Set();
const texts = [];
for (const f of files) {
  for (const t of leadTexts(JSON.parse(readFileSync(join(DIR, f), "utf8")))) {
    const key = `${t.reply}\n${JSON.stringify(t.questions)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push({ file: f, ...t });
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const totals = { message: { texts: 0, sentences: 0, passed: 0 }, brief: { texts: 0, sentences: 0, passed: 0 } };
const rules = new Map();
let vale = "";
for (const t of texts) {
  const doc = leadDoc(t);
  if (!doc) continue;
  const outcome = runVale(doc.text);
  if (!outcome.checked) {
    console.log(`Not checked: ${outcome.reason}.`);
    process.exit(0);
  }
  vale = outcome.vale;
  const rec = proseRecord(doc, outcome, new Date().toISOString());
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
const all = { texts: totals.message.texts + totals.brief.texts, sentences: totals.message.sentences + totals.brief.sentences, passed: totals.message.passed + totals.brief.passed };
console.log(`\nVale ${vale}, the STE80 style, ${files.length} records in docs/real-runs.`);
console.log(`Lead messages and questions: ${totals.message.texts} texts, ${totals.message.passed} of ${totals.message.sentences} sentences pass (${pct(totals.message.passed, totals.message.sentences)}).`);
console.log(`Lead briefs: ${totals.brief.texts} texts, ${totals.brief.passed} of ${totals.brief.sentences} sentences pass (${pct(totals.brief.passed, totals.brief.sentences)}).`);
console.log(`All: ${all.passed} of ${all.sentences} sentences pass (${pct(all.passed, all.sentences)}).`);
console.log("Alerts by rule:");
for (const [k, n] of [...rules.entries()].sort((a, b) => b[1] - a[1])) console.log(`- ${k} ${n}`);
