// Real check of the lead's output schema (ORC-029 pass 4): one tiny lead-shaped run per provider, through the real
// runtime adapters, with the lead's reply schema as the run's output schema. It shows that each provider accepts the
// schema and that the answer arrives as JSON that matches it. Costs a little usage on each provider.
//
//   node --import tsx scripts/lead-schema-real.mjs [--claude-model claude-sonnet-5-5] [--codex-model gpt-6.1-sol] [--only claude|codex]
//
// Claude on the owner's subscription: run it in an interactive shell with ORCHESTRATION_CLAUDE_AUTH=subscription.
// Codex uses its own sign-in. Nothing is printed except each provider's status, the answer, the usage and the checks;
// the answer is a model's reply to the prompt below, never a credential. Limits: 4 turns, 3 minutes, $0.25 (Claude).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function runOnce(provider, adapter) {
  const health = await adapter.health();
  console.log(`\n== ${provider} (${models[provider]}): ${health.status}${health.status === "ready" ? "" : ` (${health.detail})`}`);
  if (health.status !== "ready") return { provider, ok: false, why: health.detail };
  const dir = mkdtempSync(join(tmpdir(), `lead-schema-${provider}-`));
  const attemptId = `schema-check-${provider}-${Date.now()}`;
  const done = new Promise((resolve) => {
    const off = adapter.onEvent((e) => {
      if (e.attemptId !== attemptId) return;
      if (e.type === "activity") console.log(`  activity: ${e.note.slice(0, 160)}`);
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
  rmSync(dir, { recursive: true, force: true });
  const tookMs = Date.now() - started;
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
  return { provider, ok: wholeTextIsJson && strict === "matches" && !out.problem, usage: e.usage, cost, tookMs };
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
console.log(`\n== result: ${results.map((r) => `${r.provider} ${r.ok ? "PASS" : `FAIL (${r.why ?? "the answer did not match"})`}`).join("; ")}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
