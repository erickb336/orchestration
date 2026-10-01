#!/usr/bin/env node
// A stand-in for `codex app-server`, for tests of server/checks.ts. It speaks the two
// requests the check runner sends, `initialize` and `command/exec` (plus `command/exec/terminate`), over
// the same line-delimited JSON-RPC wire, and runs each command for real, without any sandbox: it is
// the request contract that is under test, not the sandbox. It never contacts anything.
//
//   FAKE_CODEX_LOG   file to append one JSON line per request: method, params, and selected environment
//                    of this process (what the runner started it with)
//   FAKE_CODEX_HANG  "1": commands never answer until terminated (tests the watchdog and terminate)

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (row) => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(row)}\n`);
};
const env = {};
for (const k of ["CODEX_HOME", "GH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS", "CI", "TMPDIR", "HOME", "PATH"]) if (process.env[k] !== undefined) env[k] = process.env[k];
log({ spawn: process.argv.slice(2), env });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const running = new Map();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialized") return;
  log({ method: msg.method, params: msg.params });
  if (msg.method === "initialize") return send({ id: msg.id, result: { userAgent: "fake-codex-exec" } });
  if (msg.method === "command/exec/terminate") {
    const r = running.get(msg.params.processId);
    if (r) {
      try {
        process.kill(-r.child.pid, "SIGKILL");
      } catch {
        try {
          r.child.kill("SIGKILL");
        } catch {}
      }
    }
    return send({ id: msg.id, result: {} });
  }
  if (msg.method === "command/exec") {
    const p = msg.params;
    const [cmd, ...args] = p.command;
    const child = spawn(cmd, args, { cwd: p.cwd ?? process.cwd(), env: { ...process.env, ...(p.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    running.set(p.processId, { child });
    const hang = process.env.FAKE_CODEX_HANG === "1";
    let timer;
    if (p.timeoutMs && !hang) {
      timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, p.timeoutMs);
    }
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      running.delete(p.processId);
      const cap = p.outputBytesCap ?? 1024 * 1024;
      const stdout = Buffer.concat(out).toString("utf8").slice(0, cap);
      const stderr = Buffer.concat(err).toString("utf8").slice(0, cap);
      send({ id: msg.id, result: { exitCode: signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : (code ?? 1), stdout, stderr } });
    });
    return;
  }
  send({ id: msg.id, error: { code: -32601, message: `fake-codex-exec does not handle ${msg.method}` } });
});
rl.on("close", () => {
  for (const r of running.values()) {
    try {
      process.kill(-r.child.pid, "SIGKILL");
    } catch {}
  }
  process.exit(0);
});
