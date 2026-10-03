// `npm run qa` (ORC-030, step 1): every QA journey in scripts/qa/, then the screen inventory, in a real browser at 1280
// and 375 wide, simulated (the fake runtime: no paid run, no Docker).
//
// It builds the UI once (QA_DIST), runs the scripts QA_JOBS at a time (default 3), each on its own ten ports from
// ORCHESTRATION_TEST_PORT (default 5950), and writes each script's output to evidence/qa/<journey>/run.log. At the end
// it prints one line per script and writes evidence/qa/summary.json. It exits 1 when a script fails.
//
// Run all:   npm run qa
// Run some:  npm run qa -- new-project notes

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE, ROOT, buildApp, removeApp } from "./harness.mjs";

const ALL = ["new-project", "vision-round", "lock-in", "preflight", "task-delivery", "change-order", "budget-stop", "pause-resume", "notes", "settings", "screens"];
const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const unknown = asked.filter((a) => !ALL.includes(a));
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Choose from: ${ALL.join(", ")}.`);
  process.exit(2);
}
const names = (asked.length ? asked : ALL).filter((n) => existsSync(join(ROOT, "scripts", "qa", `${n}.mjs`)));
const jobs = Math.max(1, Number(process.env.QA_JOBS ?? 3));
const base = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5950);

console.log(`Building the UI once…`);
const dist = await buildApp();
mkdirSync(EVIDENCE, { recursive: true });

const results = [];
const queue = [...names];
async function worker(slot) {
  for (let name = queue.shift(); name; name = queue.shift()) {
    const t0 = Date.now();
    // Ten ports a slot: a script may start a second service on its port + 2 (preflight) or use four (budget-stop).
    const port = base + slot * 10;
    const out = [];
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", join("scripts", "qa", `${name}.mjs`)], {
        cwd: ROOT,
        env: { ...process.env, QA_DIST: dist, ORCHESTRATION_TEST_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => out.push(String(d)));
      child.stderr.on("data", (d) => out.push(String(d)));
      child.on("exit", (c) => resolve(c ?? 1));
    });
    const dir = join(EVIDENCE, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.log"), out.join(""));
    let checks = null;
    try {
      const r = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
      checks = { passed: r.checks - r.failed, total: r.checks };
    } catch {
      // The inventory writes index.json, not result.json.
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    results.push({ name, ok: code === 0, code, checks, secs });
    console.log(`${code === 0 ? "✓" : "✗"} ${name}${checks ? `: ${checks.passed} of ${checks.total} checks` : ""} (${secs}s, ${join(dir, "run.log")})`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, (_, i) => worker(i)));
removeApp();

const order = (r) => names.indexOf(r.name);
results.sort((a, b) => order(a) - order(b));
writeFileSync(join(EVIDENCE, "summary.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} scripts passed. Screenshots and logs: ${EVIDENCE}`);
if (failed.length) {
  console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
