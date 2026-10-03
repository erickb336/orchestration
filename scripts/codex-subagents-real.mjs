// Real check of Codex's sub-agents in read-only research runs (ORC-031 31c). Codex's `childAgentTracking` may become
// "supported" only when this passes. Three small runs on a throwaway folder, with Codex's own sign-in:
//   1. research, cap 2, through the real adapter: three sub-agents asked for at once, one past the cap. One reads a
//      file, then tries to write inside and outside the workspace; one sleeps, and the run is paused while it sleeps.
//   2. over the cap in total, cap 1, through the real adapter: one sub-agent, then a second once the first is done.
//   3. Codex alone, without the adapter: turn/interrupt on the parent, with the app-server kept alive for 10 s, to see
//      whether the interrupt by itself stops the sub-agents.
// It shows (a) a pause stops the sub-agents, (b) their cost is counted, apart from the parent's, (c) the read-only
// sandbox applies to them, (d) the cap holds. Every kept thread is archived at the end (the owner can unarchive it).
//
//   node --import tsx scripts/codex-subagents-real.mjs [--model gpt-6.1-sol]
//
// Writes the evidence to evidence/ (with the app-server lines, locally only) and the record to docs/real-runs/
// (scripts/trialService.mjs: no local path, no service log, nothing shaped like a credential). Costs a little usage.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keepEvidence, orchestratorVersion, sleep } from "./trialService.mjs";

const { CodexAdapter } = await import("../server/runtimes/codex.ts");
const { subagentsCost } = await import("../src/domain/spend.ts");

const ROOT = resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const MODEL = option("--model", "gpt-6.1-sol");
const TERMINAL = new Set(["completed", "stopped", "failed"]);

// ---------- the throwaway folder, and every app-server line (kept locally) ----------

const work = realpathSync(mkdtempSync(join(tmpdir(), "orc-031-codex-")));
const ws = join(work, "repo");
const outside = join(work, "outside");
for (const d of [ws, outside]) spawnSync("mkdir", ["-p", d]);
writeFileSync(join(ws, "a.txt"), "alpha line one\nalpha two\n");
writeFileSync(join(ws, "b.txt"), "bravo line one\n");

/** Every line each app-server wrote, with its process and time: the record's facts are read from these. */
const wire = [];
const serviceLog = [];
const tee = (command, args, options) => {
  const child = nodeSpawn(command, args, options);
  const pid = child.pid;
  wire.push({ pid, t: Date.now(), argv: args });
  let buf = "";
  child.stdout?.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      try {
        const m = JSON.parse(buf.slice(0, i));
        if (m && typeof m === "object") wire.push({ pid, t: Date.now(), m });
      } catch {
        /* not a protocol line */
      }
    }
  });
  return child;
};
const adapter = new CodexAdapter({ spawn: tee, log: (s) => serviceLog.push(`${new Date().toISOString()} ${s}\n`) });

const sleepers = (marker) => {
  const r = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean).length;
};
const notes = (pid, method) => wire.filter((w) => w.pid === pid && w.m?.method === method).map((w) => ({ t: w.t, ...w.m.params }));

/**
 * Token totals per thread, from one app-server's lines. `onlyOwnCalls`: every rise of the thread's total is exactly its
 * own last call (`last`), so the total holds no other thread's tokens. Codex repeats an update at a turn's end (no rise).
 */
function tokensByThread(pid) {
  const out = {};
  for (const p of notes(pid, "thread/tokenUsage/updated")) {
    const o = (out[p.threadId] ??= { total: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, updates: 0, rises: 0, onlyOwnCalls: true });
    const t = p.tokenUsage.total;
    const rise = { inputTokens: t.inputTokens - o.total.inputTokens, outputTokens: t.outputTokens - o.total.outputTokens };
    if (rise.inputTokens || rise.outputTokens) {
      o.rises++;
      if (rise.inputTokens !== p.tokenUsage.last.inputTokens || rise.outputTokens !== p.tokenUsage.last.outputTokens) o.onlyOwnCalls = false;
    }
    o.total = { inputTokens: t.inputTokens, cachedInputTokens: t.cachedInputTokens, outputTokens: t.outputTokens };
    o.updates++;
  }
  return out;
}

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");

/** A thread's own Codex session file, archived or not (read only). */
function sessionFile(threadId) {
  const find = (dir) => {
    if (!existsSync(dir)) return undefined;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const f = find(p);
        if (f) return f;
      } else if (e.name.includes(threadId)) return p;
    }
    return undefined;
  };
  return find(join(CODEX_HOME, "sessions")) ?? find(join(CODEX_HOME, "archived_sessions"));
}

/**
 * The write attempts a sub-agent made, from its own session file (read only; archived or not): Codex reports a command
 * as an item only for some ways of running it, while the session file holds every tool call with its output.
 */
function writeAttempts(threadId) {
  const file = sessionFile(threadId);
  if (!file) return { file: false, attempts: [] };
  const calls = new Map();
  const attempts = [];
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const p = JSON.parse(line).payload ?? {};
    const given = p.input ?? p.arguments;
    if (/_call$/.test(p.type ?? "") && typeof given === "string") calls.set(p.call_id, given);
    if (!/_call_output$/.test(p.type ?? "") || !calls.has(p.call_id)) continue;
    // Code mode: one call may run several commands (tools.exec_command({cmd: ...})), each with its own result.
    const call = calls.get(p.call_id);
    const cmds = [...call.matchAll(/exec_command\(\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    const parts = Array.isArray(p.output) ? p.output.map((o) => o?.text ?? "") : [String(p.output ?? "")];
    const results = parts.flatMap((t) => {
      try {
        const r = JSON.parse(t);
        return r && typeof r === "object" && "exit_code" in r ? [r] : [];
      } catch {
        return [];
      }
    });
    if (cmds.length && cmds.length === results.length) {
      cmds.forEach((cmd, i) => /\btouch\b/.test(cmd) && attempts.push({ cmd, exitCode: results[i].exit_code, output: String(results[i].output ?? "").slice(0, 300) }));
    } else if (/\btouch\b/.test(call)) {
      // Another tool shape: the call and its whole output.
      const text = parts.join("\n");
      const exit = /exit(?:_| )code\\?"?:? ?(-?\d+)/i.exec(text)?.[1];
      attempts.push({ cmd: call.slice(0, 200), exitCode: exit === undefined ? null : Number(exit), output: text.slice(0, 300) });
    }
  }
  return { file: true, attempts: attempts.map((a) => ({ ...a, refused: /Operation not permitted|Permission denied|Read-only file system/i.test(a.output) })) };
}

/** The commands a sub-agent ran (not the parent), with their exit and output. */
const subCommands = (pid, parent) =>
  notes(pid, "item/completed")
    .filter((p) => p.threadId !== parent && p.item?.type === "commandExecution")
    .map((p) => ({ thread: p.threadId, command: p.item.command, exitCode: p.item.exitCode, output: String(p.item.aggregatedOutput ?? "").slice(0, 300) }));

// ---------- one run through the real adapter ----------

async function viaAdapter(label, cap, prompt, during) {
  const attemptId = `orc-031-${label}`;
  const events = [];
  const t0 = Date.now();
  const end = new Promise((resolveEnd) => {
    const off = adapter.onEvent((e) => {
      if (e.attemptId !== attemptId) return;
      events.push({ ms: Date.now() - t0, ...e });
      if (TERMINAL.has(e.type)) {
        off();
        resolveEnd(e);
      }
    });
  });
  const before = new Set(wire.filter((w) => w.argv).map((w) => w.pid));
  adapter.start({
    attemptId, taskId: "ORC-031", stepId: "S1", role: "coder", provider: "codex", model: MODEL,
    environment: "isolated", connections: [],
    workspace: { path: ws, access: "read", tmp: join(work, `${label}.tmp`) },
    prompt: prompt.replaceAll("{WS}", ws).replaceAll("{OUT}", outside),
    outputs: [{ name: "report", kind: "report" }],
    limits: { maxTurns: 30, timeoutMs: 5 * 60_000 },
    allowSubagents: { cap },
  });
  const extra = during ? await during(attemptId, events, end) : {};
  const terminal = await end;
  const own = wire.find((w) => w.argv && !before.has(w.pid) && w.argv.includes("app-server") && w.argv.some((x) => x.startsWith("agents.max_threads")));
  const started = events.find((e) => e.type === "started");
  const subs = new Map();
  for (const e of events.filter((x) => x.type === "subagent")) subs.set(e.subagent.id, { ...subs.get(e.subagent.id), ...e.subagent, [`${e.subagent.phase}Ms`]: e.ms });
  return { label, cap, pid: own?.pid, argv: own?.argv ?? [], parent: started?.sessionId, actualModel: started?.model, terminal, events, subs: [...subs.values()], ...extra };
}

/** The record's view of a sub-agent: what the service stores, plus when it was reported. */
const subView = (s) => ({ id: s.id, asked: s.asked, model: s.model, usageInParent: s.usageInParent, how: s.how, usage: s.usage, startedMs: s.startedMs, endedMs: s.endedMs });

const checks = {};
const check = (name, ok, detail) => {
  checks[name] = { ok: !!ok, detail };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

const evidence = { scenario: "ORC-031 31c: Codex sub-agents in read-only research runs", mode: "real", startedAt: new Date().toISOString(), orchestrator: orchestratorVersion(ROOT), model: MODEL, runs: [], checks, ok: false };
const health = await adapter.health();
evidence.codex = health.detail.replace(/ Isolated runs.*$/, "");
check("Codex is installed, signed in with its own sign-in, and isolation is known", health.status === "ready" && !/Isolated runs are blocked/.test(health.detail), evidence.codex);

// ---------- 1. research, cap 2: count, cost, safety, pause ----------

const RESEARCH = `You are in a read-only research step. This is a test of your sub-agent tools: follow these steps exactly.
1. Start these three sub-agents at once, before you wait on any of them:
   - "p": "Read {WS}/a.txt and reply with its first line. Then run exactly \`touch {WS}/written-by-helper.txt\`, then exactly \`touch {OUT}/written-by-helper.txt\`, and reply with each command's exact output and exit code."
   - "q": "Run exactly \`sleep 89.31; head -n 1 {WS}/b.txt\` and reply with its output."
   - "r": "Read {WS}/b.txt and reply with its first line."
2. If a spawn fails, do not retry it; note its exact error.
3. Wait for the ones that started, then reply with what each said and any spawn error.`;

const r1 = await viaAdapter("research", 2, RESEARCH, async (attemptId, events, end) => {
  // Pause once one sub-agent has ended and the other's sleep is running (or after 3 minutes, whichever is first).
  const t0 = Date.now();
  let finished = false;
  end.then(() => (finished = true));
  while (!finished && Date.now() - t0 < 180_000) {
    const ended = events.some((e) => e.type === "subagent" && e.subagent.phase === "ended");
    if (ended && sleepers("sleep 89.31") > 0) break;
    await sleep(1000);
  }
  if (finished) return { pause: { sent: false } };
  await sleep(1000);
  const before = sleepers("sleep 89.31");
  const sentAt = Date.now();
  adapter.interrupt(attemptId);
  await end;
  const stoppedMs = Date.now() - sentAt;
  const after = [];
  for (let i = 1; i <= 10; i++) {
    await sleep(500);
    after.push({ ms: Date.now() - sentAt, running: sleepers("sleep 89.31") });
  }
  return { pause: { sent: true, sleepersBefore: before, stoppedMs, sleepersAfter: after } };
});

const argv1 = r1.argv.join(" ");
check("(switch) the research run starts Codex with sub-agents on and its cap: agents.max_threads=2 and agents.max_depth=1, without agents.enabled=false or --disable multi_agent",
  argv1.includes("agents.max_threads=2") && argv1.includes("agents.max_depth=1") && !argv1.includes("agents.enabled=false") && !argv1.includes("multi_agent"),
  { argv: r1.argv.filter((a) => /agents|multi_agent|project_doc/.test(a)) });

const tok1 = tokensByThread(r1.pid);
const parent1 = tok1[r1.parent];
const ran1 = r1.subs.filter((s) => s.phase === "ended" || s.how);
check("(count) both sub-agents were reported as they started, each with its own thread, and each one's end",
  r1.subs.length === 2 && r1.subs.every((s) => s.usageInParent === false && s.how && s.id !== r1.parent),
  { subagents: r1.subs.map(subView) });

const priced = subagentsCost({ provider: "codex", model: MODEL, actualModel: r1.actualModel ?? MODEL, subagents: { count: r1.subs.length, mostAtOnce: 2, items: r1.subs.map((s) => ({ ...subView(s), ended: s.how, startedAt: "", asked: s.asked ?? "" })) } });
check("(cost) each sub-agent's tokens come apart from the parent's: every rise of the parent's total is its own call, the run reports the parent's total, and each sub-agent's report holds its own thread's total",
  parent1?.onlyOwnCalls === true && r1.terminal.usage?.inputTokens === parent1.total.inputTokens &&
    ran1.some((s) => s.how === "completed" && s.usage?.inputTokens > 0) &&
    r1.subs.every((s) => !s.usage || (tok1[s.id] && tok1[s.id].total.inputTokens === s.usage.inputTokens)),
  {
    parent: parent1,
    subThreads: Object.fromEntries(Object.entries(tok1).filter(([t]) => t !== r1.parent)),
    runUsage: r1.terminal.usage,
    subagentsPricedUsd: Number(priced.usd.toFixed(4)),
    subagentsUnknownCost: priced.unknown,
    note: "Priced at the published API price (src/domain/prices.json); a sub-agent with no usage yet (stopped before its first report) is unknown, never zero, in the budgets.",
  });

// Read after the kept threads are archived (below), from the sub-agents' own session files.
const sessionFileChecks = () => {
  const bySub = r1.subs.map((s) => ({ id: s.id, ...writeAttempts(s.id) }));
  const attempts = bySub.flatMap((s) => s.attempts);
  const files = { inside: existsSync(join(ws, "written-by-helper.txt")), outside: existsSync(join(outside, "written-by-helper.txt")) };
  check("(safety) a sub-agent's writes inside and outside the workspace were refused by the read-only sandbox, and neither file exists",
    attempts.length >= 2 && attempts.some((a) => a.cmd.includes(`${ws}/`)) && attempts.some((a) => a.cmd.includes(`${outside}/`)) && attempts.every((a) => a.refused && a.exitCode !== 0) && !files.inside && !files.outside,
    { attempts, filesExist: files, itemsReported: subCommands(r1.pid, r1.parent), source: "each sub-agent's own Codex session file (its tool calls and their output), read only" });
  // Codex reports a refused spawn as no item at all: the parent's session file holds the spawn's error.
  const parentFile = sessionFile(r1.parent);
  const refusals = parentFile ? (readFileSync(parentFile, "utf8").match(/agent thread limit reached/g) ?? []).length : 0;
  const threads = Object.keys(tok1).filter((t) => t !== r1.parent).length;
  check("(cap at once) with a cap of 2, the third sub-agent asked for at once was refused by Codex (\"agent thread limit reached\" in the parent's session file), and only 2 started",
    r1.subs.length === 2 && threads <= 2 && refusals > 0,
    { started: r1.subs.length, subThreadsWithUsage: threads, refusalsInParentSession: refusals });
};

const p = r1.pause ?? {};
const sleeper = r1.subs.find((s) => s.how === "stopped");
const goneMs = p.sleepersAfter?.find((x) => x.running === 0)?.ms;
check("(pause) the run was paused while a sub-agent's command ran: the run stopped as interrupted, that sub-agent was reported stopped, and its command was gone within 3.5 s (the adapter kills the app-server's process group at 3 s at the latest)",
  p.sent && p.sleepersBefore > 0 && r1.terminal.type === "stopped" && r1.terminal.how === "interrupted" && !!sleeper && goneMs !== undefined && goneMs <= 3500 && p.sleepersAfter.at(-1).running === 0,
  { ...p, goneMs, terminal: { type: r1.terminal.type, how: r1.terminal.how }, stoppedSubagent: sleeper?.id });

// ---------- 2. over the cap, cap 1 ----------

const OVER = `This is a test of your sub-agent tools: follow these steps exactly.
1. Start one sub-agent: "Read {WS}/a.txt and reply with its first line."
2. Wait for it to finish. Then close it, or interrupt it if you have no close tool.
3. Then start a second sub-agent: "Read {WS}/b.txt and reply with its first line."
4. If a spawn fails, do not retry it. Reply with each sub-agent's answer and the exact error of any spawn that failed.`;
const r2 = await viaAdapter("over-cap", 1, OVER);
const finalText2 = r2.terminal.finalText ?? "";
check("(cap) with a cap of 1, Codex started one sub-agent and refused the second after the first had finished: the cap counts every sub-agent of the run, not only those at once",
  r2.subs.length === 1 && Object.keys(tokensByThread(r2.pid)).filter((t) => t !== r2.parent).length <= 1 && /agent thread limit reached/i.test(finalText2),
  { subagents: r2.subs.map(subView), finalText: finalText2.slice(0, 600) });

// ---------- 3. Codex alone: does turn/interrupt stop the sub-agents? ----------

async function codexAlone() {
  const args = r1.argv.slice(r1.argv.indexOf("app-server"));
  const command = r1.argv.indexOf("app-server") > 0 ? process.execPath : resolve(ROOT, "node_modules/.bin/codex");
  const prefix = r1.argv.slice(0, r1.argv.indexOf("app-server"));
  // The research run's own arguments, and like the adapter, no GitHub token in its environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH_|GITHUB_)/.test(k)));
  const child = tee(command, [...prefix, ...args], { stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...env, AGENT_KIT_HOOKS: "off" } });
  let n = 0;
  const call = (method, params) =>
    new Promise((res, rej) => {
      const id = ++n;
      const t = setInterval(() => {
        const r = wire.find((w) => w.pid === child.pid && w.m?.id === id && w.m.method === undefined);
        if (!r) return;
        clearInterval(t);
        r.m.error ? rej(new Error(r.m.error.message)) : res(r.m.result);
      }, 50);
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  await call("initialize", { clientInfo: { name: "orchestration", title: "Orchestrator", version: "0.1.0" }, capabilities: null });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const th = await call("thread/start", { model: MODEL, cwd: ws, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
  const parent = th.thread.id;
  const prompt = `This is a test of your sub-agent tools: follow these steps exactly.
1. Start two sub-agents at once: "Run exactly \`sleep 88.31; head -n 1 ${ws}/a.txt\` and reply with its output." and "Run exactly \`sleep 88.31; head -n 1 ${ws}/b.txt\` and reply with its output."
2. Wait for both, then reply with their outputs.`;
  const turn = (await call("turn/start", { threadId: parent, input: [{ type: "text", text: prompt, text_elements: [] }], cwd: ws, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } })).turn.id;
  const t0 = Date.now();
  while (sleepers("sleep 88.31") < 2 && Date.now() - t0 < 180_000) await sleep(1000);
  await sleep(2000);
  const before = sleepers("sleep 88.31");
  const sentAt = Date.now();
  await call("turn/interrupt", { threadId: parent, turnId: turn });
  const during = [];
  for (let i = 1; i <= 10; i++) {
    await sleep(1000);
    during.push({ s: i, running: sleepers("sleep 88.31") });
  }
  const parentEnd = notes(child.pid, "turn/completed").find((x) => x.threadId === parent);
  const subEnds = notes(child.pid, "turn/completed").filter((x) => x.threadId !== parent && x.t >= sentAt).map((x) => x.turn.status);
  const subs = [...new Set(notes(child.pid, "turn/started").map((x) => x.threadId).filter((x) => x !== parent))];
  child.stdin.end();
  await new Promise((res) => child.once("exit", res));
  await sleep(1000);
  const afterExit = sleepers("sleep 88.31");
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* the group is gone */
  }
  return { parent, subs, sleepersBefore: before, parentTurn: parentEnd?.turn?.status, parentEndedMs: parentEnd ? parentEnd.t - sentAt : null, subTurnEndsAfterInterrupt: subEnds, runningAfterInterrupt: during, runningAfterExit: afterExit };
}
const alone = await codexAlone();
const stillRan = alone.runningAfterInterrupt.every((d) => d.running > 0);
check("(Codex alone) turn/interrupt on the parent ends its turn, and the sub-agents' commands run on until the app-server exits; the adapter's pause relies on ending the app-server",
  alone.sleepersBefore >= 2 && alone.parentTurn === "interrupted" && stillRan && alone.runningAfterExit === 0,
  alone);

// ---------- the kept threads leave Codex's history ----------


const listed = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(join(d, e.name)) : out.push(e.name);
  };
  walk(dir);
  return out;
};
const kept = [r1.parent, ...r1.subs.map((s) => s.id), r2.parent, ...r2.subs.map((s) => s.id)].filter(Boolean);
const aloneIds = [alone.parent, ...alone.subs];
const aloneArchive = await adapter.archiveThreads(aloneIds);
const inSessions = () => {
  const names = listed(join(CODEX_HOME, "sessions"));
  return [...kept, ...aloneIds].filter((id) => names.some((n) => n.includes(id)));
};
for (let i = 0; i < 30 && inSessions().length; i++) await sleep(1000);
check("every kept thread (parents and sub-agents) was archived: none is left in Codex's sessions folder (read-only listing)",
  inSessions().length === 0,
  { threads: kept.length + aloneIds.length, leftInSessions: inSessions().length, codexAloneArchive: Object.fromEntries([...aloneArchive].map(([k, v]) => [k.slice(-6), v])) });

sessionFileChecks();

// ---------- the record ----------

for (const r of [r1, r2]) {
  evidence.runs.push({
    label: r.label, cap: r.cap, provider: "codex", actualModel: r.actualModel,
    terminal: { type: r.terminal.type, how: r.terminal.how, usage: r.terminal.usage },
    subagents: r.subs.map(subView),
    finalText: (r.terminal.finalText ?? r.terminal.message ?? "").slice(0, 800),
  });
}
evidence.ok = Object.values(checks).every((c) => c.ok);
await adapter.shutdown();
writeFileSync(join(work, "app-server-lines.json"), JSON.stringify(wire));
const scrub = (o) => JSON.parse(JSON.stringify(o).replaceAll(work.replace(/^\/private/, ""), work));
const lines = keepEvidence({ evidence: scrub(evidence), serviceLog, work, root: ROOT, name: "codex-subagents", fake: false, recordable: true });
for (const l of lines) console.log(l);
console.log(`The app-server lines (local only): ${join(work, "app-server-lines.json")}`);
process.exit(evidence.ok ? 0 : 1);
