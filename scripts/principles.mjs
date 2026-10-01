// Compile principles/*.md into src/domain/builtInPrinciples.json, the copy the app imports
// (nothing can import Markdown: the server runs through tsx, the UI through Vite). The files are the
// source of truth; `npm test` runs this first and then checks that the two agree. Run through tsx so the
// parser is the domain's own: `node --import tsx scripts/principles.mjs`.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRINCIPLE_IDS, parsePrincipleFile } from "../src/domain/principleFiles.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "principles");
const OUT = join(ROOT, "src/domain/builtInPrinciples.json");

/** Every principles/*.md parsed, in table order; an id the table lacks, or a file the table names that is missing, is an error. */
export function compilePrinciples(dir = DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
  const parsed = files.map((f) => parsePrincipleFile(`principles/${f}`, readFileSync(join(dir, f), "utf8")));
  const extra = parsed.filter((p) => !PRINCIPLE_IDS.includes(p.id)).map((p) => p.id);
  if (extra.length) throw new Error(`principles/: ${extra.join(", ")} not in PRINCIPLE_IDS (src/domain/principles.ts)`);
  const missing = PRINCIPLE_IDS.filter((id) => !parsed.some((p) => p.id === id));
  if (missing.length) throw new Error(`principles/: no file for ${missing.join(", ")}`);
  return PRINCIPLE_IDS.map((id) => parsed.find((p) => p.id === id));
}

/** The JSON text, stable so that an unchanged set writes nothing. */
export const compiledText = (principles) => `${JSON.stringify(principles, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = compiledText(compilePrinciples());
  let current;
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = undefined;
  }
  if (current === text) process.exit(0);
  writeFileSync(OUT, text);
  console.log(`principles: wrote ${OUT.slice(ROOT.length)} from ${PRINCIPLE_IDS.length} files`);
}
