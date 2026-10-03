// The service a trial runs against, and the record it leaves: started on a throwaway database, driven through its HTTP
// API as a client would, polled, and stopped; then the evidence written to evidence/ and, for a real run, a record to
// docs/real-runs without local paths, the service log or anything shaped like a credential (scripts/recordLeaks.mjs).
//
// Used by the factory trial (scripts/factory-trial.mjs). The studio trial (scripts/studio-trial.mjs) and the
// real-run test (scripts/real-run-test.mjs) still carry their own copies of these parts; they can move here.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { leaksIn, scrubHomePaths } from "./recordLeaks.mjs";

const HEADERS = { "Content-Type": "application/json", "X-Orchestration-Client": "1" };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const minutes = (n) => n * 60_000;

/** Which Orchestrator code ran: the commit, and whether the checkout had uncommitted changes. */
export function orchestratorVersion(root) {
  const at = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { commit: at("rev-parse", "--short=12", "HEAD"), uncommittedChanges: at("status", "--porcelain", "--untracked-files=no") !== "" };
  } catch {
    return null;
  }
}

/**
 * Start the service (server/main.ts under tsx) on `dbPath`, listening on `port` and the prototype server on
 * `prototypePort`, in the fake or the real runtime. Returns the client: `api`, `cmd` (a command, with a fresh
 * idempotency key), `state`, `until` (poll the state), `ready` (health, then the providers' health) and `stop`.
 */
export function startService({ root, port, prototypePort, dbPath, fake }) {
  const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    cwd: root,
    env: { ...process.env, ORCHESTRATION_PORT: String(port), ORCHESTRATION_PROTOTYPE_PORT: String(prototypePort), ORCHESTRATION_DB: dbPath, ORCHESTRATION_RUNTIME: fake ? "fake" : "real" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;

  async function api(path, body) {
    const res = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
    return json;
  }
  const cmd = (name, args = {}) => api("/api/commands", { name, args, idempotencyKey: randomUUID() });
  const state = () => api("/api/state");

  /**
   * Poll the state until `pred` returns something truthy. `guard(state)` runs on each poll first (the spend cap).
   * Throws when the service stops or the time runs out.
   */
  async function until(what, pred, { timeoutMs, pollMs = 1000, guard } = {}) {
    const start = Date.now();
    for (;;) {
      const s = await state();
      if (guard) await guard(s.state);
      const v = await pred(s);
      if (v) return { s, v, waitedMs: Date.now() - start };
      if (child.exitCode !== null) throw new Error(`The service stopped while waiting for: ${what}`);
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${what}`);
      await sleep(pollMs);
    }
  }

  /** The service answers, and every provider reported its health. Returns the first full response. */
  async function ready() {
    for (let i = 0; ; i++) {
      try {
        await api("/api/health");
        break;
      } catch {
        if (i > 60 || child.exitCode !== null) throw new Error(`The service did not start:\n${log.join("")}`);
        await sleep(500);
      }
    }
    return (await until("provider health checks", (x) => Object.values(x.service.providers).every((p) => p.health), { timeoutMs: 30_000 })).s;
  }

  async function stop() {
    child.kill("SIGTERM");
    await sleep(500);
  }

  return { child, log, base, api, cmd, state, until, ready, stop };
}

function gitEmail() {
  try {
    return execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The evidence as committed to docs/real-runs: without the service log, every local path as <work>, <orchestrator> or ~. */
export function publicRecord(evidence, { work, root }) {
  const { serviceLog: _omitted, ...rest } = evidence;
  return scrubHomePaths(JSON.stringify(rest, null, 2).replaceAll(work, "<work>").replaceAll(root, "<orchestrator>").replaceAll(homedir(), "~"));
}

/**
 * Write the evidence to evidence/<name>-<mode>-<stamp>.json (in full, with the service log's last lines), then, when
 * `recordable`, the record for the repository: docs/real-runs/<stamp>.json for a real run; for a fake run, beside the
 * evidence. A record that still holds a path, a name or a key-like string stays in evidence/ for a person to fix.
 * Returns what it wrote, for the console.
 */
export function keepEvidence({ evidence, serviceLog, work, root, name, fake, recordable }) {
  evidence.finishedAt = new Date().toISOString();
  evidence.serviceLog = serviceLog.join("").split("\n").filter(Boolean).slice(-80);
  const dir = join(root, "evidence");
  mkdirSync(dir, { recursive: true });
  const stamp = evidence.startedAt.replace(/[:.]/g, "-");
  const file = join(dir, `${name}-${fake ? "fake" : "real"}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  const lines = [`${evidence.ok ? "PASSED" : "NOT PASSED"}: evidence written to ${file}`, `The throwaway project, its database and its files are kept in ${work}`];
  if (!recordable) return lines;
  const text = publicRecord(evidence, { work, root }) + "\n";
  const leaks = leaksIn(text, [
    { what: "your user name", value: userInfo().username },
    { what: "this computer's name", value: hostname() },
    { what: "your git email", value: gitEmail() },
  ]);
  if (leaks.length) {
    const held = join(dir, `${name}-record-NOT-COMMITTED-${stamp}.json`);
    writeFileSync(held, text);
    lines.push(`The record was NOT written to docs/real-runs: it contains ${leaks.join(", ")}. Fix it by hand: ${held}`);
  } else if (fake) {
    const kept = join(dir, `${name}-record-fake-${stamp}.json`);
    writeFileSync(kept, text);
    lines.push(`The record as it would be committed (fake runs are not): ${kept}`);
  } else {
    const records = join(root, "docs", "real-runs");
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, `${stamp}.json`), text);
    lines.push(`Record for the repository (no local paths, no service log): ${join(records, `${stamp}.json`)}`);
  }
  return lines;
}
