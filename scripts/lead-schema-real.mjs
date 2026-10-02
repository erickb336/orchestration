// Real check of the lead's output schema (ORC-029 pass 4): one tiny lead-shaped run per provider, through the real
// runtime adapters, with the lead's reply schema as the run's output schema. It shows that:
// - each provider accepts the schema, and the answer arrives as JSON that matches it;
// - the run leaves nothing in the user's own history: no new Codex session file with originator "orchestration" in
//   ~/.codex/sessions, and no new folder for the run's working folder in ~/.claude/projects (read-only listings,
//   before and after; nothing there is changed);
// - a note sent as the run starts reaches it (Codex: turn/steer on the ephemeral thread; Claude: the input stream).
// Costs a little usage on each provider.
//
//   node --import tsx scripts/lead-schema-real.mjs [--claude-model claude-sonnet-5-5] [--codex-model gpt-6.1-sol] [--only claude|codex]
//
// Claude on the owner's subscription: run it in an interactive shell with ORCHESTRATION_CLAUDE_AUTH=subscription.
// Codex uses its own sign-in. Nothing is printed except each provider's status, the answer, the usage and the checks;
// the answer is a model's reply to the prompt below, never a credential. Limits: 4 turns, 3 minutes, $0.25 (Claude).

import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const { ClaudeAdapter } = await import("../server/runtimes/claude.ts");
const { CodexAdapter } = await import("../server/runtimes/codex.ts");
const { parseLeadOutput } = await import("../server/envelope.ts");
const { LEAD_REPLY_SCHEMA, schemaMismatch } = await import("../src/domain/model/leadReplySchema.ts");
const Spend = await import("../src/domain/spend.ts");

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const only = option("--only", undefined);
const models = { claude: option("--claude-model", "claude-sonnet-5-5"), codex: option("--codex-model", "gpt-6.1-sol") };

// A lead-shaped request that fills nested and nullable fields: questions with an area, coverage, and a studio block.
const PROMPT = `# Lead run schema-check (reply to the user)
You are the lead of the project "Notes". There is no code yet, and you need not read any file.

## Messages to answer now
- I want a tiny app to keep short notes on my phone.

## Required final output
Your final answer is one JSON object, as the output schema defines. Put your whole message to the user in "reply" (two sentences at most). The schema names every field; give null for a field you leave out. Propose no tasks ("proposals": []), do not steer, and draft no vision. Ask exactly one question in "questions" (area "scope", with two options). Report "coverage" with "intent" as "partial" and every other area null. In "studio", open a round with focus "experience", ask for one designer run (kinds ["screen"], 1 variant, devices ["mobile"], a one-sentence brief), and leave the rest null.`;
const NOTE = "A note from the user: end the reply with the words 'note received'.";

// --- the user's own history, read only --------------------------------------------------------------------------

const codexSessions = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
const claudeProjects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** The session files under ~/.codex/sessions. */
const codexFiles = () => (existsSync(codexSessions) ? readdirSync(codexSessions, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).map(String) : []);
/** A session file's originator, from its first line (the session's metadata). */
function originatorOf(file) {
  const fd = openSync(join(codexSessions, file), "r");
  try {
    const buf = Buffer.alloc(65_536);
    const first = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8").split("\n")[0];
    const meta = JSON.parse(first);
    return meta.payload?.originator ?? meta.originator ?? "(none)";
  } catch {
    return "(unreadable)";
  } finally {
    closeSync(fd);
  }
}
/** The folders under ~/.claude/projects (one per working folder a session ran in). */
const claudeFolders = () => (existsSync(claudeProjects) ? readdirSync(claudeProjects) : []);

function historySnapshot() {
  return { codex: new Set(codexFiles()), claude: new Set(claudeFolders()) };
}
/** What the run added to the user's own history. Other new entries (the user's own sessions meanwhile) are counted only. */
function historyAdded(before, workFolder) {
  const newCodex = codexFiles().filter((f) => !before.codex.has(f));
  const originators = newCodex.map(originatorOf);
  const newClaude = claudeFolders().filter((f) => !before.claude.has(f));
  const name = basename(workFolder);
  return {
    codexFromOrchestrator: originators.filter((o) => o === "orchestration").length,
    codexOther: originators.filter((o) => o !== "orchestration").length,
    claudeForThisRun: newClaude.filter((f) => f.includes(name)).length,
    claudeOther: newClaude.filter((f) => !f.includes(name)).length,
  };
}

// --- one run ---------------------------------------------------------------------------------------------------

async function runOnce(provider, adapter) {
  const health = await adapter.health();
  console.log(`\n== ${provider} (${models[provider]}): ${health.status}${health.status === "ready" ? "" : ` (${health.detail})`}`);
  if (health.status !== "ready") return { provider, ok: false, why: health.detail };
  const dir = mkdtempSync(join(tmpdir(), `lead-schema-${provider}-`));
  const before = historySnapshot();
  const attemptId = `schema-check-${provider}-${Date.now()}`;
  let note;
  const done = new Promise((resolve) => {
    const off = adapter.onEvent((e) => {
      if (e.attemptId !== attemptId) return;
      if (e.type === "activity") console.log(`  activity: ${e.note.slice(0, 160)}`);
      // The note goes as soon as the provider has accepted the run (Codex holds it until the turn exists).
      if (e.type === "started") adapter.note(attemptId, { id: "note-1", text: NOTE });
      if (e.type === "note") note = e;
      if (e.type === "completed" || e.type === "failed" || e.type === "stopped") {
        off();
        resolve(e);
      }
    });
  });
  const started = Date.now();
  adapter.start({
    attemptId,
    taskId: "LEAD",
    stepId: "LEAD",
    role: "lead",
    provider,
    model: models[provider],
    workspace: { path: dir, access: "read" },
    environment: "isolated",
    connections: [],
    prompt: PROMPT,
    outputs: [],
    outputSchema: LEAD_REPLY_SCHEMA,
    limits: { maxTurns: 4, timeoutMs: 180_000, maxBudgetUsd: 0.25 },
  });
  const e = await done;
  // Session files are written as the run goes; a short wait lets a late write land before the second listing.
  await new Promise((r) => setTimeout(r, 2000));
  const added = historyAdded(before, dir);
  rmSync(dir, { recursive: true, force: true });
  const tookMs = Date.now() - started;
  const noHistory = added.codexFromOrchestrator === 0 && added.claudeForThisRun === 0;
  console.log(`  note: ${note ? `${note.outcome}${note.reason ? ` (${note.reason})` : ""}${note.heldForTurn ? ", held until the turn existed" : ""}` : "no outcome"}`);
  console.log(`  history: ${added.codexFromOrchestrator} new Codex session file(s) from Orchestrator, ${added.claudeForThisRun} new Claude project folder(s) for this run; other new entries meanwhile: ${added.codexOther} Codex, ${added.claudeOther} Claude`);
  if (e.type !== "completed") {
    console.log(`  ${e.type}: ${e.message ?? e.how}`);
    return { provider, ok: false, why: e.message ?? e.how, usage: e.usage, tookMs };
  }
  let parsed;
  let wholeTextIsJson = false;
  try {
    parsed = JSON.parse(e.finalText);
    wholeTextIsJson = true;
  } catch {
    /* reported below */
  }
  const strict = wholeTextIsJson ? (schemaMismatch(LEAD_REPLY_SCHEMA, parsed) ?? "matches") : "not JSON";
  const out = parseLeadOutput(e.finalText);
  const cost = Spend.estimateUsd({ provider, model: e.model ?? models[provider], usage: e.usage, outcome: "completed" }, Spend.PRICES);
  console.log(`  final text (${e.finalText.length} chars), the whole text is JSON: ${wholeTextIsJson}`);
  console.log(`  ${e.finalText}`);
  console.log(`  strict schema check (no fields filled in): ${strict}`);
  console.log(`  parseLeadOutput problem: ${out.problem ? JSON.stringify(out.problem) : "none"}`);
  console.log(`  model: ${e.model ?? "?"}; usage: ${JSON.stringify(e.usage ?? {})}; cost: ${cost.usd === null ? "unknown" : `$${cost.usd.toFixed(4)}`} (${cost.basis}); took ${Math.round(tookMs / 1000)}s`);
  const why = !wholeTextIsJson || strict !== "matches" || out.problem ? "the answer did not match" : !noHistory ? "the run left history" : note?.outcome !== "delivered" ? "the note was not delivered" : undefined;
  return { provider, ok: !why, why, usage: e.usage, cost, tookMs };
}

const results = [];
if (only !== "codex") {
  const claude = new ClaudeAdapter({ log: () => {} });
  results.push(await runOnce("claude", claude));
  await claude.shutdown();
}
if (only !== "claude") {
  const codex = new CodexAdapter({ log: () => {} });
  results.push(await runOnce("codex", codex));
  await codex.shutdown();
}
console.log(`\n== result: ${results.map((r) => `${r.provider} ${r.ok ? "PASS" : `FAIL (${r.why})`}`).join("; ")}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
