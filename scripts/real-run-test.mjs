// Real-run test of the runtime adapters. In Vision, it runs one studio round first (the lead opens it, a designer
// makes an artifact, the PE reviews it, and the test approves it into the draft as the owner would), then starts the
// factory with the pre-flight's own command. Then it runs a Codex worker and a Claude worker CONCURRENTLY against a
// throwaway git repository, pauses and resumes each and then the whole project, sends a note to each
// running worker, lets both finish, and writes an evidence file. It uses your own credentials from the
// environment and costs a small amount of usage.
//
//   npm run test:real            real Claude + Codex (needs credentials, see below)
//   npm run test:integration     the same scenario against the fake runtime (no cost; CI runs it)
//
// Both run it under tsx (`node --import tsx`), so its checks use the domain's own rules (which findings still need a
// fix, which wait for a decision) rather than a copy of them.
//
// A real run also writes docs/real-runs/<time>.json: the evidence without local paths or the service log,
// meant to be committed so the repository shows what real models did (ORC-027).
//
// Credentials: Claude needs ANTHROPIC_API_KEY (or Bedrock/Vertex/Foundry settings), or your own subscription
// token with ORCHESTRATION_CLAUDE_AUTH=subscription (see docs/real-agents.md). Codex uses your
// local Codex sign-in (`npx codex login`) or OPENAI_API_KEY / CODEX_API_KEY. Nothing is printed or
// stored except whether each provider reported itself ready.
//
// Limits: 12 turns, 5 minutes, $0.50 (Claude) per attempt; Claude uses the "haiku" alias.
//
// Flow: the built-in Investigation flow, the smallest of the six that still runs a worker on each
// provider at once (one task's first step pinned to Codex, the other's to Claude), then a reviewer, a revise
// round while the review finds something (up to three), and the lead: no code change, no checks. If a review asks
// for a decision, the test answers "fix" as the owner would, and records it. Nothing is written into the data
// directory before the service starts; the script says which flow it uses.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { leaksIn, scrubHomePaths } from "./recordLeaks.mjs";

// The domain's rules, and the pre-flight's command, loaded through tsx (the npm scripts start node with it).
const domain = await Promise.all([
  import("../src/domain/findings.ts"),
  import("../src/domain/model.ts"),
  import("../src/domain/studio/studio.ts"),
  import("../src/domain/studio/blueprint.ts"),
  import("../src/domain/studio/types.ts"),
  import("../src/ui/preflight/preflightView.ts"),
]).catch((e) => {
  console.error(`Run this with \`npm run test:real\` or \`npm run test:integration\` (node --import tsx): ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
const [F, M, S, B, ST, PF] = domain;

const FAKE = process.argv.includes("--fake");
/** PASSED needs exactly this many checks, all passing: a check that silently stopped running fails the test. */
const EXPECTED_CHECKS = 17;
const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5399);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { "Content-Type": "application/json", "X-Orchestration-Client": "1" };
const t0 = Date.now();
const evidence = { mode: FAKE ? "fake" : "real", startedAt: new Date().toISOString(), orchestrator: orchestratorVersion(), steps: [], checks: {}, ok: false };
/** Every exit criterion of the runtime-integrations milestone (docs/PROJECT_SPEC.md) is an explicit check; PASSED requires all of them. */
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

/** Which Orchestrator code ran: the commit, and whether the checkout had uncommitted changes. */
function orchestratorVersion() {
  const at = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { commit: at("rev-parse", "--short=12", "HEAD"), uncommittedChanges: at("status", "--porcelain", "--untracked-files=no") !== "" };
  } catch {
    return null;
  }
}

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

// The flow every task in this test runs. Investigation: S1 investigate and gather evidence (coder) → S2 review the
// evidence for gaps (code reviewer) → S3 revise the report while S2 finds something (coder, up to three rounds) →
// S4 propose a follow-up spec (lead). One task's S1 is pinned to Codex and the other's to Claude, so both providers
// run at once; the reviewer, the revise step and the lead follow the project's role defaults.
const FLOW_ID = "investigation";

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

async function until(what, pred, timeoutMs, pollMs = 500) {
  const start = Date.now();
  for (;;) {
    const s = await state();
    const v = await pred(s);
    if (v) return { s, v, waitedMs: Date.now() - start };
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for: ${what}`);
    await sleep(pollMs);
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

  // Project and limits. The project begins in Vision. Before the start, one studio round (ORC-029 pass 6): the owner
  // chooses the kind of product (greeting.js is a code product, so the designer makes its interface) and asks the lead
  // for one small round; the lead opens it and asks for a designer run, the PE reviews what the designer made, and the
  // test approves the round into the draft, as the owner would. Then the factory starts the way the owner starts it:
  // the pre-flight's own command, naming what the pre-flight showed (the draft and vision revisions, the Lock in
  // summary's digest, every open item). Settings: Manual (the lead plans nothing), each task waits for a go-ahead (the
  // scenario starts both itself), decisions on findings come to the owner (the scenario answers them), delivery off
  // (finished work stays on the integration branch, and you merge it).
  await cmd("initProject", { name: "Real-run test", repoPath: repo, vision: "Keep the greeting module small and correct.", focus: "Real-run test" });
  s = await state();
  const createdInVision = s.state.project.stage === "shaping" && s.state.project.factoryStarts.length === 0;
  await studioRound();
  s = await state();
  const settings = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "user", startEachTask: true } };
  const seen = PF.seenNow(s.state);
  const start = PF.startFactoryCommand(seen, settings);
  await cmd(start.name, start.args);
  s = await state();
  const starts = s.state.project.factoryStarts;
  const inForce = B.currentBlueprint(s.state);
  check(
    "the factory started only from the pre-flight's command, with its record and the Lock in summary it showed",
    createdInVision &&
      s.state.project.stage === "building" &&
      starts.length === 1 &&
      starts[0].by === "user" &&
      starts[0].blueprintRev === (inForce?.rev ?? 0) &&
      starts[0].visionRev === seen.visionRev &&
      JSON.stringify(starts[0].settings) === JSON.stringify(settings) &&
      JSON.stringify(starts[0].openItems) === JSON.stringify(seen.open) &&
      !!inForce?.lockIn &&
      B.summaryDigest(inForce.lockIn.summary) === seen.summaryDigest,
    { createdIn: createdInVision ? "shaping" : s.state.project.stage, start: starts[0] ?? null, blueprintRev: inForce?.rev ?? null, itemsInForce: B.blueprintItems(s.state).map((i) => `${i.title} v${i.version} (${i.status})`) },
  );
  await cmd("setRunLimits", { maxTurns: 12, timeoutMinutes: 5, maxBudgetUsd: 0.5 });
  s = await state();
  const flow = s.state.flows.find((p) => p.id === FLOW_ID);
  // Investigation since ORC-028: investigate, review, revise the report while the review finds something, the lead's spec.
  check(`the built-in ${FLOW_ID} flow is loaded with its four steps`, !!flow && flow.source === "built-in" && flow.steps.map((st) => st.role).join(",") === "coder,code_reviewer,coder,lead", flow ? { name: flow.name, steps: flow.steps.map((st) => `${st.id} ${st.purpose}`), hash: flow.hash.slice(0, 8) } : null);
  if (!flow) throw new Error(`The built-in ${FLOW_ID} flow is not in the state`);
  log(`Flow: ${flow.name} (${FLOW_ID}): ${flow.steps.map((st) => `${st.id} ${st.purpose} (${st.role})`).join(" → ")}`);
  const codexModel = FAKE ? s.state.project.catalog.codex[0].id : "auto";
  const claudeModel = FAKE ? s.state.project.catalog.claude[0].id : "haiku";
  const create = async (title, outcome, approach) =>
    (await cmd("createTask", { title, area: "Test", outcome, benefit: "Exercise the runtime", whyNow: "", approach, acceptance: ["The report names the files it read"], priority: 1, holdBeforeStart: true, flowId: FLOW_ID })).result.newId;
  const codexTask = await create("Where would shout() go?", "A short report says where a shout(s) function belongs in greeting.js and what tests it needs.", "Read greeting.js and report; change no file.");
  const claudeTask = await create("What is missing from the README?", "A short report lists what the README should say about greet().", "Read README.md and greeting.js and report; change no file.");
  await cmd("setStepSelection", { taskId: codexTask, stepId: "S1", selection: { provider: "codex", model: codexModel } });
  await cmd("setStepSelection", { taskId: claudeTask, stepId: "S1", selection: { provider: "claude", model: claudeModel } });
  await cmd("startHeldTask", { taskId: codexTask });
  await cmd("startHeldTask", { taskId: claudeTask });
  s = await state();
  check(
    "both tasks record the flow they run (id, hash, source)",
    [codexTask, claudeTask].every((id) => task(s, id).flow.id === FLOW_ID && task(s, id).flow.hash === flow.hash && task(s, id).flow.source === "built-in" && task(s, id).flow.chosenBy === "user"),
    { flow: FLOW_ID, hash: flow.hash.slice(0, 8) },
  );
  record("tasks created", { codexTask, claudeTask, codexModel, claudeModel, flow: FLOW_ID });

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

  // 4. A note to each running worker (ORC-022). After the project resumes, each task's first step starts a fresh
  // run; a note to it counts only once that runtime acknowledges it (Claude: the SDK replays the message; Codex:
  // turn/steer answers). Whether the report then answers the note is recorded, not checked: following a note is
  // the model's choice, and greeting.js has three lines whether or not the report says so.
  // The note goes as soon as the run is dispatched (polled every 100 ms), as early as a person could send one: Codex
  // may not have started its turn yet, and then holds the note until it has. The note's outcome says whether it was
  // held (`heldForTurn`), as the runtime reported it; whether that happens depends on timing, so it is recorded, not
  // checked.
  const NOTE = "Also say in your report how many lines greeting.js has.";
  const sent = [];
  for (const [label, id] of [
    ["codex", codexTask],
    ["claude", claudeTask],
  ]) {
    const { s: live } = await until(`${label} first step running again`, (x) => active(x, id).find((a) => a.stepId === "S1") || task(x, id).steps.find((st) => st.id === "S1").state === "done", 60000, 100);
    const run = active(live, id).find((a) => a.stepId === "S1");
    if (!run) {
      check(`${label}: a note reached the running worker and its runtime acknowledged it`, false, "the first step finished before a note could be sent");
      continue;
    }
    // The step can finish between the poll above and this command, which then refuses the note: a failed check,
    // not an aborted scenario.
    let result;
    try {
      ({ result } = await cmd("sendNote", { taskId: id, stepId: "S1", text: NOTE }));
    } catch (e) {
      check(`${label}: a note reached the running worker and its runtime acknowledged it`, false, `the note was refused: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    sent.push({ label, id, noteId: result.noteId, run: run.id });
    record(`${label}: note sent`, { note: result.noteId, run: run.id });
  }
  for (const n of sent) {
    const { v: note } = await until(`${n.label} note settled`, (x) => {
      const found = x.state.notes.find((y) => y.id === n.noteId);
      return found && (found.status === "delivered" || found.status === "not-delivered") ? found : null;
      // A note settles by the end of its run at the latest: the 5-minute run limit, plus Claude's 90 s wait for an
      // acknowledgment after the turn, plus a margin.
    }, 7 * 60000);
    // From the service's own timestamps: sent (handed to the runtime) to settled (acknowledged or refused).
    const settledAfterMs = note.sentAt && note.settledAt ? Date.parse(note.settledAt) - Date.parse(note.sentAt) : null;
    record(`${n.label}: note settled`, { note: note.id, status: note.status, via: note.via ?? null, run: note.attemptId ?? null, heldForTurn: note.heldForTurn ?? false, reason: note.reason ?? null, settledAfterMs });
    check(`${n.label}: a note reached the running worker and its runtime acknowledged it`, note.status === "delivered" && note.via === "live" && note.attemptId === n.run, { status: note.status, via: note.via ?? null, heldForTurn: note.heldForTurn ?? false, settledAfterMs, reason: note.reason ?? null });
  }

  // 5. Let both finish: the reviewer, the revise step and the lead run with the project's role defaults. A review
  // finding that asks for a decision stops a task at Needs you (by default); the test answers "fix", as an owner who
  // wants the report right would, and records each answer, so a question never hangs the run.
  const answered = [];
  const { s: final } = await until("both tasks done or blocked", async (x) => {
    for (const id of [codexTask, claudeTask]) {
      if (!F.awaitingDecision(x.state, task(x, id))) continue;
      for (const d of x.state.decisions.filter((y) => y.taskId === id && y.status === "open" && y.routedTo === "user")) {
        await cmd("decideFinding", { decisionId: d.id, decision: "fix", note: "Answered by the integration test: fix it." });
        answered.push({ task: id, decision: d.id });
        record("decision answered: fix", { task: id, decision: d.id });
      }
    }
    return [codexTask, claudeTask].every((id) => task(x, id).lifecycle === "done" || task(x, id).steps.some((st) => st.state === "blocked"));
  }, 900000);
  for (const [label, id] of [
    ["codex", codexTask],
    ["claude", claudeTask],
  ]) {
    const t = task(final, id);
    const runs = final.state.attempts.filter((a) => a.taskId === id).map((a) => ({ id: a.id, step: a.stepId, provider: a.snapshot.provider, model: a.snapshot.model, actualModel: a.actualModel ?? null, outcome: a.outcome, usage: a.usage ?? null, note: a.note ?? null }));
    const report = newest(final, id, "report");
    const brief = newest(final, id, "brief");
    // A hint only, not a check: does the report of the run that received the note give greeting.js's line count, as
    // the note asked? (The final report may be a revision, made after a review pointed the gap out.)
    const noted = sent.find((n) => n.id === id);
    const notedReport = noted && final.state.artifacts.find((a) => a.attemptId === noted.run && a.name === "report");
    const answersNote = (r) => (r ? /\b(3|three)\b[^.\n]{0,20}\blines?\b/i.test(r.summary) : null);
    const reviews = final.state.artifacts.filter((a) => a.taskId === id && a.kind === "review-findings").map((a) => ({ step: a.stepId, toFix: F.fixable(final.state, a), findings: (a.findings ?? []).map((f) => `${f.severity}/${f.action}: ${f.title}`) }));
    record(`${label}: result`, {
      lifecycle: t.lifecycle,
      blocked: t.steps.find((st) => st.state === "blocked")?.blockedReason ?? null,
      steps: t.steps.map((st) => `${st.id}:${st.state}`),
      runs,
      reviews,
      decisionsAnswered: answered.filter((a) => a.task === id).length,
      notedReport: notedReport ? { step: notedReport.stepId, summary: notedReport.summary, answersNote: answersNote(notedReport) } : null,
      finalReport: report && report !== notedReport ? { step: report.stepId, summary: report.summary, answersNote: answersNote(report) } : null,
      brief: brief ? { summary: brief.summary } : null,
    });
  }
  // 6. No review finding dropped (ORC-028). The lead's run of 2026-10-01 ended an Investigation as Done with an open
  // auto-fix warning, because that flow's review fed no repair. Every conditional (repair) step whose review found
  // something that needed a fix must have run, not been skipped.
  for (const [label, id] of [
    ["codex", codexTask],
    ["claude", claudeTask],
  ]) {
    const t = task(final, id);
    // What dispatch itself uses: blocking findings to fix (auto-fix, or decided "fix"), not accepted or followed up.
    const toFix = (ref) => {
      const art = M.acceptedOutput(final.state, t, ref.step, ref.output);
      return art ? F.fixable(final.state, art) : 0;
    };
    const repairs = t.steps.filter((st) => st.runIf?.length);
    const dropped = repairs.filter((st) => st.state === "skipped" && st.runIf.some((r) => toFix(r) > 0)).map((st) => st.id);
    // The loop's limit: after its last round the last revision is not reviewed again; the lead's step reads it.
    const last = repairs.find((st) => st.iterate);
    const limitReached = !!last && last.state === "done" && (last.iteration ?? 1) >= last.iterate.max;
    check(`${label}: review findings that needed a fix were revised, not dropped`, repairs.length > 0 && dropped.length === 0, {
      revised: repairs.filter((st) => st.state === "done").map((st) => st.id),
      skippedClean: repairs.filter((st) => st.state === "skipped").map((st) => st.id),
      dropped,
      limitReached,
    });
  }
  for (const [label, id] of [
    ["codex", codexTask],
    ["claude", claudeTask],
  ]) {
    const report = newest(final, id, "report");
    const brief = newest(final, id, "brief");
    check(`${label}: task completed with a recorded report and brief`, task(final, id).lifecycle === "done" && !!report && !!brief);
  }
  check("managed repository main branch untouched, and nothing committed by the investigation", git("rev-list", "--count", "main") === "1" && git("status", "--porcelain") === "");
  evidence.ok = Object.values(evidence.checks).length === EXPECTED_CHECKS && Object.values(evidence.checks).every((c) => c.ok);
  if (Object.values(evidence.checks).length !== EXPECTED_CHECKS) log(`✗ ${Object.values(evidence.checks).length} checks ran; PASSED needs exactly ${EXPECTED_CHECKS}`);
}

/** What the owner asks the lead for in Vision: one small round, so the real run stays short and cheap. */
const STUDIO_ASK = "Start the studio with one small round on greeting.js as it is today: one designer run, one artifact, one take. Keep it short.";

/**
 * Vision before the start: the owner's kind of product and message, the lead's round, the designer's artifact and the
 * PE's review, then the owner's approval of the round into the draft. One check; the details go into the evidence.
 */
async function studioRound() {
  await cmd("setDomains", { domains: ["code"] });
  await cmd("postMessage", { text: STUDIO_ASK });
  // Settled: the lead's message run is over, no studio run is under way, and what the round made is ready for the
  // owner (its PE review is over). A round that made nothing settles too, so the check can say so.
  const made = (x) => {
    const round = x.state.studio.rounds.at(-1);
    return { round, artifacts: round ? S.latestArtifacts(x.state).filter((a) => a.round === round.n) : [] };
  };
  const { s: designed } = await until(
    "the studio round: the lead's round, the designer's artifact and the PE's review",
    (x) => {
      const leadDone = x.state.leadRuns.some((r) => r.trigger === "message") && !x.state.leadRuns.some((r) => r.outcome === "running" || r.outcome === "stopping");
      const quiet = leadDone && !x.state.studio.runs.some(ST.isUnderWay);
      return quiet && made(x).artifacts.every((a) => S.readyForOwner(x.state, a));
    },
    20 * 60000,
    1000,
  );
  const { round, artifacts } = made(designed);
  const runs = designed.state.studio.runs.filter((r) => (round && r.round === round.n) || artifacts.some((a) => a.id === r.artifactId));
  const designers = runs.filter((r) => r.kind === "designer");
  const pe = runs.filter((r) => r.kind === "pe");
  const verdicts = designed.state.studio.verdicts.filter((v) => artifacts.some((a) => a.id === v.artifactId && a.version === v.version));
  record("studio round settled", {
    round: round ? { n: round.n, focus: round.focus, openedByLead: !!round.leadRunId } : null,
    artifacts: artifacts.map((a) => ({ id: a.id, kind: a.kind, title: a.title, version: a.version, pe: S.peReview(designed.state, a).status })),
    designerRuns: designers.map((r) => ({ id: r.id, provider: r.provider, model: r.model, status: r.status })),
    peRuns: pe.map((r) => ({ id: r.id, provider: r.provider, model: r.model, status: r.status })),
    verdicts: verdicts.map((v) => `${v.verdict}: ${v.reasons.slice(0, 160)}`),
  });
  if (round) await cmd("approveRound", { round: round.n });
  const after = await state();
  const items = B.draftItems(after.state).filter((i) => artifacts.some((a) => a.id === i.artifactId));
  check(
    "Vision: the lead opened a round, a designer made an artifact, the PE reviewed it, and the owner approved it into the draft",
    !!round?.leadRunId && artifacts.length > 0 && designers.some((r) => r.status === "completed") && pe.some((r) => r.status === "completed") && verdicts.length > 0 && items.some((i) => i.status === "approved"),
    { draft: items.map((i) => `${i.title} v${i.version} (${i.status})`), openItems: B.openBlueprintItems(after.state).map((o) => `${o.item.title}: ${o.why}`) },
  );
}

/** The evidence as committed to docs/real-runs: the service log is left out (it can hold anything a process printed),
 *  and every local path becomes <work> (this run's throwaway folder) or ~ (the home directory). */
function publicRecord(e) {
  const { serviceLog: _omitted, ...rest } = e;
  return scrubHomePaths(JSON.stringify(rest, null, 2).replaceAll(work, "<work>").replaceAll(ROOT, "<orchestrator>").replaceAll(homedir(), "~"));
}

function gitEmail() {
  try {
    return execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** A task's newest artifact by output name (the revised report, when the review asked for one). */
function newest(s, taskId, name) {
  return s.state.artifacts.filter((a) => a.taskId === taskId && a.name === name).at(-1);
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
  // A real run that reached its agents leaves a record for the repository, passed or not. It is checked before it
  // is written: one that still holds a path, a name or a key-like string stays in evidence/ for a person to fix.
  if (!FAKE && evidence.steps.some((st) => st.name === "tasks created")) {
    const text = publicRecord(evidence) + "\n";
    const name = `${evidence.startedAt.replace(/[:.]/g, "-")}.json`;
    const leaks = leaksIn(text, [
      { what: "your user name", value: userInfo().username },
      { what: "this computer's name", value: hostname() },
      { what: "your git email", value: gitEmail() },
    ]);
    if (leaks.length) {
      const held = join(dir, `record-NOT-COMMITTED-${name}`);
      writeFileSync(held, text);
      console.log(`The record was NOT written to docs/real-runs: it contains ${leaks.join(", ")}. Fix it by hand: ${held}`);
    } else {
      const records = join(ROOT, "docs", "real-runs");
      mkdirSync(records, { recursive: true });
      writeFileSync(join(records, name), text);
      console.log(`Record for the repository (no local paths, no service log): ${join(records, name)}`);
    }
  }
  process.exit(exitCode || (evidence.ok ? 0 : 1));
}
