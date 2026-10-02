// `npm run lint:prose`: a report on how the owner's documents (PRODUCT.md, README.md, docs/tasks/*.md and
// docs/design/*.md) meet the controlled-English style (vale/, principles/write-controlled-english.md). One summary
// line per file, then the totals. It never fails: the exit code is 0, with or without Vale, and CI does not run it as
// a check (ORC-030 can decide from the report). `--alerts` lists each alert under its file.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { proseRecord } from "../server/prose/record.ts";
import { findVale, runVale } from "../server/prose/vale.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const showAlerts = process.argv.includes("--alerts");
const inDir = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md")).sort().map((f) => `${dir}/${f}`);
const files = ["PRODUCT.md", "README.md", ...inDir("docs/tasks"), ...inDir("docs/design")];

const bin = findVale();
if (!bin) {
  console.log("Not checked: Vale was not found. Install it (brew install vale, version 3.24.0) to get this report.");
  process.exit(0);
}
const short = (rule) => rule.replace(/^STE80\./, "");
const totals = { files: 0, sentences: 0, passed: 0, errors: 0, warnings: 0 };
const byRule = new Map();
let version = "";
for (const file of files) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const outcome = runVale(text, { bin, maxChars: Infinity, timeoutMs: 60_000 });
  if (!outcome.checked) {
    console.log(`${file}: not checked (${outcome.reason})`);
    continue;
  }
  version = outcome.vale;
  const rec = proseRecord({ text, parts: [{ name: file, firstLine: 1 }] }, outcome, new Date().toISOString());
  const count = (level) => rec.rules.filter((r) => r.level === level).reduce((n, r) => n + r.count, 0);
  const errors = count("error");
  const warnings = count("warning");
  totals.files++;
  totals.sentences += rec.sentences;
  totals.passed += rec.passed;
  totals.errors += errors;
  totals.warnings += warnings;
  for (const r of rec.rules) byRule.set(r.rule, { ...r, count: (byRule.get(r.rule)?.count ?? 0) + r.count });
  const pct = rec.sentences ? Math.round((100 * rec.passed) / rec.sentences) : 100;
  console.log(`${file}: ${rec.passed} of ${rec.sentences} sentences pass (${pct}%); ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}${rec.rules.length ? ` (${rec.rules.map((r) => `${short(r.rule)} ${r.count}`).join(", ")})` : ""}`);
  if (showAlerts) for (const a of outcome.alerts.filter((x) => x.level !== "suggestion")) console.log(`  ${a.line}:${a.col} ${a.level} ${short(a.rule)}: ${a.match.replace(/\s+/g, " ").slice(0, 100)}`);
}
const pct = totals.sentences ? Math.round((100 * totals.passed) / totals.sentences) : 100;
console.log(`\nVale ${version}, the STE80 style: ${totals.files} documents, ${totals.passed} of ${totals.sentences} sentences pass (${pct}%); ${totals.errors} errors, ${totals.warnings} warnings.`);
for (const r of [...byRule.values()].sort((a, b) => b.count - a.count)) console.log(`- ${r.what.replace(/\.$/, "")} (${r.level}): ${r.count}`);
console.log("A report only: nothing fails.");
