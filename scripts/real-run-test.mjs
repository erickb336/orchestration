// Milestone 3 real-run test. Runs a Codex worker and a Claude worker CONCURRENTLY against a throwaway
// git repository, pauses and resumes each and then the whole project, lets both finish, and writes an
// evidence file. It uses your own credentials from the environment and costs a small amount of usage.
//
//   node scripts/real-run-test.mjs           real Claude + Codex (needs credentials, see below)
//   node scripts/real-run-test.mjs --fake    the same scenario against the fake runtime (no cost)
//
// Credentials: Claude needs ANTHROPIC_API_KEY (or Bedrock/Vertex/Foundry settings). Codex uses your
// local Codex sign-in (`npx codex login`) or OPENAI_API_KEY / CODEX_API_KEY. Nothing is printed or
// stored except whether each provider reported itself ready.
//
// Limits: 12 turns, 5 minutes, $0.50 (Claude) per attempt; Claude uses the "haiku" alias.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FAKE = process.argv.includes("--fake");
const PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5399);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { "Content-Type": "application/json", "X-Orchestration-Client": "1" };
const t0 = Date.now();
const evidence = { mode: FAKE ? "fake" : "real", startedAt: new Date().toISOString(), steps: [], checks: {}, ok: false };
/** Every Milestone 3 exit condition is an explicit check; PASSED requires all of them. */
const check = (name, ok, detail = null) => {
  evidence.checks[name] = { ok: !!ok, detail };
  log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
};
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const record = (name, data = {}) => {
  evidence.steps.push({ name, atMs: Date.now() - t0, ...data });
  log(`${name}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- throwaway repository and service ----------

// Kept inside this checkout's gitignored evidence/ folder, not the system temp directory: Codex
// workers may not write shared temp locations, and the test's own files must be out of their reach.
const work = resolve(import.meta.dirname, "..", "evidence", `work-${evidence.startedAt.replace(/[:.]/g, "-")}`);
mkdirSync(work, { recursive: true });
const repo = join(work, "repo");
mkdirSync(repo);
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "greeting.js"), 'export function greet(name) {\n  return `Hello, ${name}`;\n}\n');
writeFileSync(join(repo, "README.md"), "# Greeting\n\nA tiny module used to test Orchestrator.\n");
git("add", "-A");
git("-c", "user.name=Orchestration test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "Initial commit");
evidence.repo = repo;

const service = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: { ...process.env, ORCHESTRATION_PORT: String(PORT), ORCHESTRATION_DB: join(work, "orchestration.db"), ORCHESTRATION_RUNTIME: FAKE ? "fake" : "real" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serviceLog = [];
service.stdout.on("data", (d) => serviceLog.push(String(d)));
service.stderr.on("data", (d) => serviceLog.push(String(d)));

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
  return json;
}
const cmd = (name, args = {}) => api("/api/commands", { name, args, idempotencyKey: randomUUID() });
const state = () => api("/api/state");
const active = (s, taskId) => s.state.attempts.filter((a) => a.taskId === taskId && (a.outcome === "running" || a.outcome === "stopping"));
const task = (s, id) => s.state.tasks.find((t) => t.id === id);

async function until(what, pred, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const s = await state();
    const v = pred(s);
    if (v) return { s, v, waitedMs: Date.now() - start };
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for: ${what}`);
    await sleep(500);
  }
}

async function main() {
  for (let i = 0; ; i++) {
    try {
      await api("/api/health");
      break;
    } catch {
      if (i > 60 || service.exitCode !== null) throw new Error(`The service did not start:\n${serviceLog.join("")}`);
      await sleep(500);
    }
  }
  let s = await state();
  record("service started", { runtime: s.service.runtime, providers: Object.fromEntries(Object.entries(s.service.providers).map(([p, i]) => [p, i.label])) });

  // Provider readiness (no model run is started by this check).
  ({ s } = await until("provider health checks", (x) => Object.values(x.service.providers).every((p) => p.health), 30000));
  const health = Object.fromEntries(Object.entries(s.service.providers).map(([p, i]) => [p, { status: i.health.status, detail: i.health.detail }]));
  record("provider health", health);
  const notReady = Object.entries(health).filter(([, h]) => h.status !== "ready");
  if (notReady.length) {
    for (const [p, h] of notReady) console.error(`\n${p} is ${h.status}: ${h.detail}`);
    throw new Error("Configure the providers above, then run this test again.");
  }

  // A fresh fake-mode database seeds the sample project, whose runs start at once: stop them first
  // (a new project is refused while runs are active). A real-mode database starts empty.
  if (s.state.attempts.some((a) => a.outcome === "running" || a.outcome === "stopping")) {
    await cmd("pauseProject");
    await until("sample runs stopped", (x) => x.state.attempts.every((a) => a.outcome !== "running" && a.outcome !== "stopping"), 60000);
  }

  // Project, limits, and a one-step coder pipeline for a cheap test.
  await cmd("initProject", { name: "Real-run test", repoPath: repo, vision: "Keep the greeting module small and correct.", focus: "Real-run test" });
  await cmd("setRunLimits", { maxTurns: 12, timeoutMinutes: 5, maxBudgetUsd: 0.5 });
  await cmd("saveTemplate", {
    template: {
      id: "one-step",
      name: "One coder step",
      description: "Real-run test",
      builtIn: false,
      rev: 0,
      steps: [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }],
    },
    expectedRev: null,
  });
  s = await state();
  const codexModel = FAKE ? s.state.project.catalog.codex[0].id : "auto";
  const claudeModel = FAKE ? s.state.project.catalog.claude[0].id : "haiku";
  const create = async (title, outcome, approach) =>
    (await cmd("createTask", { title, area: "Test", outcome, benefit: "Exercise the runtime", whyNow: "", approach, acceptance: ["The change is small and correct"], priority: 1, holdBeforeStart: true, templateId: "one-step" }))
      .result.newId;
  const codexTask = await create("Add shout()", "greeting.js exports shout(s) returning the input uppercased with a trailing '!'.", "Add the function next to greet(); keep the file style.");
  const claudeTask = await create("Document usage", "README.md has a short Usage section showing greet().", "Add a 'Usage' section with one code example.");
  await cmd("setStepSelection", { taskId: codexTask, stepId: "S1", selection: { provider: "codex", model: codexModel } });
  await cmd("setStepSelection", { taskId: claudeTask, stepId: "S1", selection: { provider: "claude", model: claudeModel } });
  await cmd("startHeldTask", { taskId: codexTask });
  await cmd("startHeldTask", { taskId: claudeTask });
  record("tasks created", { codexTask, claudeTask, codexModel, claudeModel });

  // 1. Concurrency: both providers running at the same moment.
  ({ s } = await until("both workers running concurrently", (x) => active(x, codexTask).length && active(x, claudeTask).length, 60000));
  check("Claude and Codex ran concurrently", active(s, codexTask)[0]?.snapshot.provider === "codex" && active(s, claudeTask)[0]?.snapshot.provider === "claude");
  record("concurrent runs observed", {
    codex: active(s, codexTask).map((a) => ({ id: a.id, provider: a.snapshot.provider, model: a.snapshot.model, workspace: a.snapshot.workspace })),
    claude: active(s, claudeTask).map((a) => ({ id: a.id, provider: a.snapshot.provider, model: a.snapshot.model, workspace: a.snapshot.workspace })),
  });

  // 2. Pause each worker, confirm the stop, then resume it.
  for (const [label, id] of [
    ["codex", codexTask],
    ["claude", claudeTask],
  ]) {
    s = await state();
    const running = active(s, id)[0];
    if (!running) {
      check(`${label}: pause exercised`, false, "the run finished before it could be paused; run the test again");
      continue;
    }
    await cmd("pauseTask", { taskId: id });
    const after = await state();
    const shown = taskLabel(after, id);
    record(`${label}: pause requested`, { run: running.id, label: shown });
    const { s: done, waitedMs } = await until(`${label} stop confirmed`, (x) => {
      const a = x.state.attempts.find((y) => y.id === running.id);
      return (a.outcome !== "running" && a.outcome !== "stopping") || task(x, id).controlFailure ? a : null;
    }, 90000);
    const a = done.state.attempts.find((y) => y.id === running.id);
    record(`${label}: stop outcome`, { run: a.id, outcome: a.outcome, confirmedAfterMs: waitedMs, controlFailure: task(done, id).controlFailure?.message ?? null, note: a.note ?? null });
    check(`${label}: Pausing shown until the runtime confirmed the stop`, shown === "Pausing" && a.outcome === "stopped", { shown, outcome: a.outcome, confirmedAfterMs: waitedMs });
    await cmd("resumeTask", { taskId: id });
    const { s: resumed } = await until(`${label} redispatched after resume`, (x) => active(x, id).find((y) => y.id !== running.id) || task(x, id).lifecycle === "done", 60000);
    const fresh = active(resumed, id)[0];
    record(`${label}: resumed`, { newRun: fresh?.id ?? null, freshWorkspace: fresh ? fresh.snapshot.workspace !== running.snapshot.workspace : null });
    check(`${label}: resume dispatched a fresh attempt`, !!fresh && fresh.id !== running.id);
  }

  // 3. Project pause reaches both providers.
  s = await state();
  const before = s.state.attempts.filter((a) => a.outcome === "running").map((a) => a.id);
  const providersRunning = new Set(s.state.attempts.filter((a) => before.includes(a.id)).map((a) => a.snapshot.provider));
  await cmd("pauseProject");
  record("project pause requested", { runningRuns: before });
  const { s: paused, waitedMs } = await until("all runs stopped after project pause", (x) => x.state.attempts.every((a) => a.outcome !== "running" && a.outcome !== "stopping"), 120000);
  record("project pause confirmed", {
    confirmedAfterMs: waitedMs,
    runs: before.map((id) => {
      const a = paused.state.attempts.find((y) => y.id === id);
      return { id, provider: a.snapshot.provider, outcome: a.outcome };
    }),
  });
  check(
    "project pause reached both providers and every run confirmed stopping",
    providersRunning.has("claude") && providersRunning.has("codex") && before.every((id) => paused.state.attempts.find((y) => y.id === id).outcome === "stopped"),
    { providersRunning: [...providersRunning] },
  );
  await cmd("resumeProject");
  record("project resumed");

  // 4. Let both finish.
  const { s: final } = await until("both tasks done or blocked", (x) => [codexTask, claudeTask].every((id) => ["done"].includes(task(x, id).lifecycle) || task(x, id).steps.some((st) => st.state === "blocked")), 600000);
  for (const [label, id] of [
    ["codex", codexTask],
    ["claude", claudeTask],
  ]) {
    const t = task(final, id);
    const runs = final.state.attempts.filter((a) => a.taskId === id).map((a) => ({ id: a.id, provider: a.snapshot.provider, model: a.snapshot.model, actualModel: a.actualModel ?? null, outcome: a.outcome, usage: a.usage ?? null, note: a.note ?? null }));
    const art = final.state.artifacts.find((a) => a.taskId === id && a.name === "change");
    let commit = null;
    if (art?.ref && !FAKE) {
      const sha = art.ref.split(" ")[0];
      commit = { ref: art.ref, files: git("show", "--name-only", "--format=", sha).split("\n").filter(Boolean) };
    }
    record(`${label}: result`, { lifecycle: t.lifecycle, blocked: t.steps.find((st) => st.state === "blocked")?.blockedReason ?? null, runs, artifact: art ? { summary: art.summary, ref: art.ref ?? null } : null, commit });
  }
  for (const [label, id] of [
    ["codex", codexTask],
    ["claude", claudeTask],
  ]) {
    const art = final.state.artifacts.find((a) => a.taskId === id && a.name === "change");
    check(`${label}: task completed with a recorded change`, task(final, id).lifecycle === "done" && !!art && (FAKE || !!art.ref));
  }
  check("managed repository main branch untouched", git("rev-list", "--count", "main") === "1" && git("status", "--porcelain") === "");
  evidence.ok = Object.values(evidence.checks).length >= 9 && Object.values(evidence.checks).every((c) => c.ok);
}

function taskLabel(s, id) {
  const t = task(s, id);
  const stopping = s.state.attempts.some((a) => a.taskId === id && a.outcome === "stopping");
  return stopping ? "Pausing" : t.hold ? "Paused" : t.lifecycle;
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  evidence.error = e instanceof Error ? e.message : String(e);
  console.error(`\nFAILED: ${evidence.error}`);
  exitCode = 1;
} finally {
  service.kill("SIGTERM");
  await sleep(500);
  evidence.finishedAt = new Date().toISOString();
  evidence.serviceLog = serviceLog.join("").split("\n").filter(Boolean).slice(-80);
  const dir = resolve(import.meta.dirname, "..", "evidence");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `real-run-${evidence.mode}-${evidence.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`\n${evidence.ok ? "PASSED" : "NOT PASSED"}: evidence written to ${file}`);
  console.log(`Throwaway repository and worktrees kept for inspection in ${work}`);
  process.exit(exitCode || (evidence.ok ? 0 : 1));
}
