#!/usr/bin/env node
// A stand-in for the `gh` CLI, for tests of server/github.ts. It never contacts anything.
//
//   FAKE_GH_LOG     file to append one JSON line per invocation: argv, stdin, cwd and selected environment
//   FAKE_GH_SCRIPT  JSON file: [{ "match": "<substring of the argv joined by spaces>", "stdout": "",
//                   "stderr": "", "code": 0, "sleepMs": 0 }, …]; the first matching rule answers.
//                   "$GH_TOKEN" in stderr is replaced by the variable's value, to test redaction.
//   FAKE_GH_REPO    "owner/name": the one repository this fake serves. A call that names another one
//                   (by -R, in a repos/<owner>/<name> path, or in a GraphQL repository(...) selector)
//                   fails like GitHub would: "Not Found (HTTP 404)", exit 1.
// Without a matching rule it prints nothing and exits 0.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  const env = {};
  for (const k of ["GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "GH_SPINNER_DISABLED", "NO_COLOR", "GIT_TERMINAL_PROMPT", "GH_DEBUG", "GH_REPO", "GH_HOST", "GIT_TRACE", "GIT_CURL_VERBOSE", "GIT_DIR"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ argv, stdin, cwd: process.cwd(), env })}\n`);
  const script = process.env.FAKE_GH_SCRIPT && existsSync(process.env.FAKE_GH_SCRIPT) ? JSON.parse(readFileSync(process.env.FAKE_GH_SCRIPT, "utf8")) : [];
  const line = argv.join(" ");
  const served = process.env.FAKE_GH_REPO;
  if (served) {
    const named = [];
    const r = argv.indexOf("-R");
    if (r >= 0) named.push(argv[r + 1]);
    for (const a of argv) {
      const m = /^repos\/([^/]+\/[^/]+)/.exec(a);
      if (m) named.push(m[1]);
    }
    const q = /repository\(owner:\\?"([^"\\]+)\\?",\s*name:\\?"([^"\\]+)\\?"\)/.exec(stdin);
    if (q) named.push(`${q[1]}/${q[2]}`);
    if (named.some((n) => n !== served)) {
      process.stderr.write("gh: Not Found (HTTP 404)\n");
      process.exit(1);
    }
  }
  const rule = script.find((r) => line.includes(r.match)) ?? {};
  const answer = () => {
    if (rule.stdout) process.stdout.write(rule.stdout);
    if (rule.stderr) process.stderr.write(String(rule.stderr).replace("$GH_TOKEN", process.env.GH_TOKEN ?? ""));
    process.exit(rule.code ?? 0);
  };
  if (rule.sleepMs) setTimeout(answer, rule.sleepMs);
  else answer();
});
