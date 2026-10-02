// The studio trial (ORC-029 pass 3e): one Vision round with a designer agent and the PE, against a throwaway
// project, and a record of what happened.
//
//   npm run trial:studio -- --fake           the simulated designer and PE (no cost; what CI and the coder run)
//   npm run trial:studio                     a real Claude designer and the PE on Codex (costs money; the lead runs it)
//   npm run trial:studio -- --cap-usd 3      the estimated Claude spend it may reach (default 5)
//   npm run trial:studio -- --designer-model claude-sonnet-4-5    the designer's model (default: the catalog's first)
//   npm run trial:studio -- --fake --lead    the lead runs the round from the owner's message (pass 4), simulated
//
// A sibling of scripts/real-run-test.mjs rather than a mode of it: that scenario is the factory (tasks, flows, notes,
// pause and resume, with exactly its own checks), and this one is Vision (rounds, artifacts, the PE, the prototype
// server). They share the service start, the polling and the record's scrubbing (scripts/recordLeaks.mjs).
//
// What it does:
// 1. Starts the service on a throwaway database and repository, with the built UI (it builds it if dist/ is missing).
// 2. Creates a project in Vision with desktop, mobile and terminal devices, a building budget of the cap plus a
//    Codex allowance (--codex-usd, default 2: the service starts no new run past it), and a maintenance budget the
//    PE judges against.
// 3. Acts as the lead until pass 4 builds the lead's studio loop: it opens round 1 and asks for two designer runs on
//    Claude, one after the other, by writing the service's own commands to the database (a client cannot send them):
//    the Weekend Trips trip plan in 2-3 variants for desktop and mobile, then a terminal demo of the `trips` CLI and
//    its TUI. Before each it estimates the Claude spend so far and stops starting runs at the cap; each run's own
//    limit (Claude's maxBudgetUsd) is what is left of the cap, at most $2.
// 4. Waits for the imports, the screenshots and recordings, the PE's runs and the designer's revisions the PE asks for,
//    which the service starts itself.
// 5. Checks: the prototype is served sandboxed (in Chrome, a fetch from inside the framed prototype to the app's API
//    fails), the screenshots exist, each terminal variant was recorded or says why not, the PE's verdicts were
//    recorded, the owner can then send feedback, the project is still in Vision, and the Claude spend stayed under
//    the cap.
// 6. Writes the evidence to evidence/ and, for a real run, a record to docs/real-runs/ without local paths, the
//    service log or anything shaped like a credential (the same check as the factory scenario).
//
// With --lead (pass 4), the lead runs the studio instead of the script. Two projects, one after the other:
// - a short idea in a repository with no code: the owner's message asks the lead to start, and the lead opens round 1
//   on the experience and asks for designer runs through its studio block;
// - "as it is today" on a tiny repository with one existing screen (scripts/fixtures/studio-existing): the lead
//   opens round 0 and the designer reproduces the screen, labelled "as is" with the files it came from.
// Each checks that the round's lead message and questions are stored, that the designer runs came from the lead's
// block, and that the PE reviewed what they made; then the sandbox, the owner's feedback, the stage and the cap.
//
// The cap (review finding 8): Claude's spend counts each run with no recorded cost at its run limit, never as $0
// (scripts/trialSpend.mjs). In the fake runtime nothing is spent.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { leaksIn, scrubHomePaths } from "./recordLeaks.mjs";
import { claudeSpend as claudeSpendOf } from "./trialSpend.mjs";

// The service's and the domain's own code, through tsx (the npm script starts node with it).
const loaded = await Promise.all([
  import("../server/store.ts"),
  import("../server/studio/runs.ts"),
  import("../src/domain/studio/studio.ts"),
  import("../src/domain/studio/runs.ts"),
  import("../src/domain/spend.ts"),
]).catch((e) => {
  console.error(`Run this with \`npm run trial:studio\` (node --import tsx): ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
const [{ Store }, { startDesignerRun }, S, R, Spend] = loaded;

const args = process.argv.slice(2);
const FAKE = args.includes("--fake");
const LEAD = args.includes("--lead");
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const CAP_USD = Number(option("--cap-usd", "5"));
const CODEX_USD = Number(option("--codex-usd", "2"));
const DESIGNER_MODEL = option("--designer-model", "auto");
if (!(CAP_USD > 0) || !(CODEX_USD >= 0)) {
  console.error("--cap-usd must be a positive number of dollars, and --codex-usd zero or more.");
  process.exit(2);
}
/** PASSED needs exactly this many checks, all passing: a check that silently stopped running fails the trial. */
const EXPECTED_CHECKS = 9; // The same count with --lead: two per project, then the reproduction, the sandbox, feedback, the stage and the cap.
/** A run is not started with less than this left of the cap: it could do nothing useful. */
const MIN_RUN_USD = 0.5;

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5399);
const PROTOTYPE_PORT = Number(process.env.ORCHESTRATION_PROTOTYPE_PORT ?? PORT + 1);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { "Content-Type": "application/json", "X-Orchestration-Client": "1" };
const t0 = Date.now();
const evidence = { scenario: "studio-trial", mode: FAKE ? "fake" : "real", lead: LEAD, startedAt: new Date().toISOString(), orchestrator: orchestratorVersion(), capUsd: CAP_USD, steps: [], checks: {}, ok: false };
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const check = (name, ok, detail = null) => {
  evidence.checks[name] = { ok: !!ok, detail };
  log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
};
const record = (name, data = {}) => {
  evidence.steps.push({ name, atMs: Date.now() - t0, ...data });
  log(`${name}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (n) => n * 60_000;

function orchestratorVersion() {
  const at = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { commit: at("rev-parse", "--short=12", "HEAD"), uncommittedChanges: at("status", "--porcelain", "--untracked-files=no") !== "" };
  } catch {
    return null;
  }
}

// ---------- the built UI, a throwaway repository, and the service ----------

if (!existsSync(join(ROOT, "dist", "index.html"))) {
  log("Building the UI (dist/ is missing)…");
  const built = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// Inside this checkout's gitignored evidence/ folder, out of the agents' reach (they write only their staging folders).
const work = join(ROOT, "evidence", `studio-${evidence.mode}${LEAD ? "-lead" : ""}-${evidence.startedAt.replace(/[:.]/g, "-")}`);
mkdirSync(work, { recursive: true });
const repo = join(work, "repo");
mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "# Weekend Trips\n\nPlan weekend trips with a small group of friends: where to go, who is in, the day plan, and what it costs each.\n");
git("add", "-A");
git("-c", "user.name=Orchestration test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "Initial commit");
const dbPath = join(work, "orchestration.db");

const service = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
  cwd: ROOT,
  env: { ...process.env, ORCHESTRATION_PORT: String(PORT), ORCHESTRATION_PROTOTYPE_PORT: String(PROTOTYPE_PORT), ORCHESTRATION_DB: dbPath, ORCHESTRATION_RUNTIME: FAKE ? "fake" : "real", ORCHESTRATION_STATIC: join(ROOT, "dist") },
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
const cmd = (name, a = {}) => api("/api/commands", { name, args: a, idempotencyKey: randomUUID() });
const state = () => api("/api/state");

async function until(what, pred, timeoutMs, pollMs = 1000) {
  const start = Date.now();
  for (;;) {
    const s = await state();
    const v = await pred(s);
    if (v) return { s, v, waitedMs: Date.now() - start };
    if (service.exitCode !== null) throw new Error(`The service stopped while waiting for: ${what}`);
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${what}`);
    await sleep(pollMs);
  }
}

// ---------- what the trial asks for ----------

const VISION = [
  "Weekend Trips: a small group of friends plans a weekend away together.",
  "One person proposes a trip; the others say whether they are in; the group sees the day plan, the places and what it costs each.",
  "It runs in the browser on desktop and phones, and as a `trips` command-line tool for the organiser.",
  "Scale: groups of 2 to 12 friends, a few trips a month. Free to use; hosting should stay under $10 a month.",
].join("\n");
const SCREEN_BRIEF = [
  "Round 1 is about the experience. Make the trip plan screen of Weekend Trips: the place, the dates, who is going, the day-by-day plan and the cost each.",
  "Make 2 or 3 variants that differ in a real choice (for example map first, or day by day first), each for desktop and for mobile, as plain HTML and CSS pages with a little script if needed.",
  "Hand in one artifact of kind screen.",
].join("\n");
const TERMINAL_BRIEF = [
  "Round 1 is about the experience. Make a terminal demo of `trips`, the Weekend Trips CLI for the organiser: `trips plan` lists the weekend's ideas and `trips pick <n>` shows one day plan.",
  "Record it with a VHS tape at 80x24, with a small node script that prints the planned output. Also make the TUI that `trips` opens with no arguments, in two layouts as .ans text frames.",
  "Hand in a terminal-demo artifact and a tui artifact, both for the terminal.",
].join("\n");

/**
 * The run limits the trial set (Claude's maxBudgetUsd): each run it started with its own, and the largest set so far
 * for the runs the service started (the lead's, the PE's). A run with no recorded cost counts at its limit.
 */
const runLimits = new Map();
const limitsSet = [];
function setLimit(usd) {
  limitsSet.push(usd);
  return cmd("setRunLimits", { maxTurns: 80, timeoutMinutes: 20, maxBudgetUsd: usd });
}
/** Claude's estimated spend so far, every run of the project included; each with no recorded cost counted at its run limit (review finding 8). */
function claudeSpend(s) {
  return claudeSpendOf(s, { estimate: (r) => Spend.estimateUsd(r, Spend.PRICES), limitOf: (r) => runLimits.get(r.id) ?? (limitsSet.length ? Math.max(...limitsSet) : 2), simulated: FAKE });
}
const money = (n) => `$${n.toFixed(2)}`;
const ended = (r) => !!r && ["completed", "failed", "stopped", "lost"].includes(r.status ?? r.outcome);
/**
 * The designer's artifacts are imported and their screenshots and recordings made. The PE's loop (pass 4): a version it
 * asks changes on is revised and reviewed again until it reaches the owner. Each artifact is settled there, or when
 * nothing more happens on its own: the PE's runs ended without a verdict, or the budget stop.
 */
const settled = (x) => {
  const latest = S.latestArtifacts(x).filter((a) => a.madeBy.role === "designer");
  if (!latest.length || S.pendingMedia(x).length) return false;
  return latest.every((a) => S.readyForOwner(x, a) || !!Spend.budgetStop(x) || (S.peReview(x, a).status === "waiting" && !R.peRunDue(x, a) && R.peRunsOf(x, a.id, a.version).every(ended)));
};

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
  let { s } = await until("provider health checks", (x) => Object.values(x.service.providers).every((p) => p.health), 30_000);
  const health = Object.fromEntries(Object.entries(s.service.providers).map(([p, i]) => [p, i.health.status]));
  record("service started", { runtime: s.service.runtime, health, prototypePort: s.service.prototypePort ?? null });
  const notReady = Object.entries(s.service.providers).filter(([, i]) => i.health.status !== "ready");
  if (notReady.length) throw new Error(`A provider is not ready: ${notReady.map(([p, i]) => `${p} is ${i.health.status}: ${i.health.detail}`).join(" ")} Configure it, then run the trial again.`);
  if (s.service.prototypePort !== PROTOTYPE_PORT) throw new Error(`The prototype server is not listening on ${PROTOTYPE_PORT}; free the port or set ORCHESTRATION_PROTOTYPE_PORT.`);

  // A fresh fake database seeds the sample project, whose runs start at once: stop them first.
  if (s.state.attempts.some((a) => a.outcome === "running" || a.outcome === "stopping")) {
    await cmd("pauseProject");
    await until("sample runs stopped", (x) => x.state.attempts.every((a) => a.outcome !== "running" && a.outcome !== "stopping"), 60_000);
  }
  if (LEAD) return leadTrial();

  // The project, as the owner sets it up: in Vision, its devices, its budgets.
  await cmd("initProject", { name: "Weekend Trips (studio trial)", repoPath: repo, vision: VISION, focus: "Studio trial" });
  await cmd("setDevices", { devices: ["desktop", "mobile", "terminal"] });
  await cmd("setBudgets", { buildingUsd: CAP_USD + CODEX_USD, maintenanceUsdPerMonth: 10 });
  s = (await state()).state;
  record("project created", { stage: s.project.stage, devices: s.project.devices, budgets: s.project.budgets, peDefault: s.project.roleDefaults.pe ?? "the other provider than the designer's" });

  // The lead's stand-in: the service's own commands, written to the database the service uses.
  const lead = new Store(dbPath);
  const leadCmd = (name, a) => lead.command(name, a, `studio-trial-${randomUUID()}`, new Date().toISOString()).result;
  const round = leadCmd("openRound", { focus: "experience", summary: "The trip plan on desktop and mobile, and the trips CLI in a terminal (studio trial)." }).n;
  record("round opened", { round });

  const designerRuns = [];
  for (const [what, brief] of [
    ["the trip plan screens", SCREEN_BRIEF],
    ["the trips CLI and its TUI", TERMINAL_BRIEF],
  ]) {
    s = (await state()).state;
    const spent = claudeSpend(s).usd;
    const left = CAP_USD - spent;
    if (left < MIN_RUN_USD) {
      record(`not started: ${what}`, { reason: `the estimated Claude spend (${money(spent)}) leaves less than ${money(MIN_RUN_USD)} of the ${money(CAP_USD)} cap` });
      continue;
    }
    const runBudget = Math.min(2, Math.floor(left * 100) / 100);
    await setLimit(runBudget);
    const runId = startDesignerRun(lead, { round, brief, selection: { provider: "claude", model: DESIGNER_MODEL } }, new Date().toISOString(), `studio-trial-${randomUUID()}`);
    runLimits.set(runId, runBudget);
    designerRuns.push(runId);
    record(`designer run asked for: ${what}`, { run: runId, spentSoFar: money(spent), runLimit: money(runBudget) });
    const { s: done, waitedMs } = await until(`the designer run for ${what}`, (x) => ended(x.state.studio.runs.find((r) => r.id === runId)), FAKE ? minutes(2) : minutes(25), FAKE ? 500 : 5000);
    const r = done.state.studio.runs.find((x) => x.id === runId);
    record(`designer run ended: ${what}`, { run: runId, status: r.status, model: r.actualModel ?? r.model, usage: r.usage ?? null, note: r.note ?? null, tookMs: waitedMs });
  }
  lead.close();

  // The service makes the screenshots and recordings, then asks the PE; wait for all of it.
  ({ s } = await until("screenshots, recordings, PE review and the designer's revisions", (x) => settled(x.state), FAKE ? minutes(4) : minutes(30), FAKE ? 500 : 5000));
  const st = s.state;
  const artifacts = S.latestArtifacts(st).filter((a) => a.madeBy.role === "designer");
  evidence.runs = st.studio.runs.map((r) => ({ id: r.id, kind: r.kind, provider: r.provider, model: r.actualModel ?? r.model, status: r.status, usage: r.usage ?? null, estimatedUsd: Spend.estimateUsd(r, Spend.PRICES).usd, simulated: !!r.simulated, note: r.note ?? null, artifact: r.artifactId ? `${r.artifactId} v${r.baseVersion}` : null }));
  evidence.artifacts = artifacts.map((a) => ({ id: a.id, version: a.version, kind: a.kind, title: a.title, devices: a.devices, variants: a.variants, files: a.files.length, shots: a.shots ?? null, demo: a.demo ?? null, peReview: S.peReview(st, a).status }));
  evidence.verdicts = st.studio.verdicts.map((v) => ({ artifact: `${v.artifactId} v${v.version}`, variant: v.variant ?? null, verdict: v.verdict, reasons: v.reasons, change: v.change ?? null, budget: v.budget ?? null, by: v.by ?? null }));
  record("studio settled", { artifacts: artifacts.map((a) => `${a.title} v${a.version} (${a.kind}, ${a.variants.length} variant${a.variants.length === 1 ? "" : "s"})`) });

  const screens = artifacts.filter((a) => a.kind === "screen");
  const terminals = artifacts.filter((a) => a.kind === "terminal-demo" || a.kind === "tui");
  check(
    "both designer runs completed: a screen in 2-3 variants for desktop and mobile, and a terminal demo or TUI",
    designerRuns.length === 2 && designerRuns.every((id) => st.studio.runs.find((r) => r.id === id)?.status === "completed") && screens.some((a) => a.variants.length >= 2 && a.variants.length <= 3 && a.devices.includes("desktop") && a.devices.includes("mobile")) && terminals.length > 0,
    { runs: designerRuns.map((id) => st.studio.runs.find((r) => r.id === id)?.status ?? "not started"), screens: screens.map((a) => `${a.variants.length} variants, ${a.devices.join("+")}`), terminals: terminals.map((a) => a.kind) },
  );

  // Served sandboxed: in Chrome, the studio frames the prototype, and a fetch from inside it to the app's API fails.
  check("the prototype is served sandboxed: a fetch from inside it to the app's API fails, in Chrome", ...(await sandboxCheck(screens[0])));

  // The screenshots: every variant on each of its screen devices, served to the app.
  const shotResults = [];
  for (const a of screens) {
    const expected = a.variants.length * a.devices.filter((d) => d === "desktop" || d === "mobile").length;
    const taken = a.shots?.status === "taken" ? a.shots.shots : [];
    const served = await Promise.all(taken.map(async (x) => (await fileType(a, x.path)) === "image/png"));
    shotResults.push({ artifact: a.title, status: a.shots?.status ?? "none", taken: taken.length, expected, served: served.filter(Boolean).length, note: S.shotsNote(a) ?? null });
  }
  check("the screenshots exist: each variant on each device, served as PNG", shotResults.length > 0 && shotResults.every((r) => r.status === "taken" && r.taken === r.expected && r.served === r.expected), shotResults);

  // The recordings: each terminal variant recorded in the sandbox, or labelled with why not.
  const demoResults = [];
  for (const a of terminals) {
    for (const v of a.demo?.status === "done" ? a.demo.variants : []) {
      // A variant with a tape is recorded, or says why not; one made of hand-written frames only has nothing to record.
      const entry = a.variants.find((x) => x.id === v.variant)?.entry ?? "";
      const folder = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
      const hasTape = entry.endsWith(".tape") || a.files.some((f) => f.path.endsWith(".tape") && folder(f.path) === folder(entry));
      const media = v.status === "recorded" ? await fileType(a, v.webm ?? v.gif ?? v.txt) : null;
      const ok = v.status === "recorded" ? !!media : v.status === "not-recorded" ? !!v.reason : !hasTape || !!v.reason;
      demoResults.push({ artifact: a.title, variant: v.variant, status: v.status, served: media, reason: v.status === "recorded" ? null : (v.reason ?? (hasTape ? null : "hand-written frames, with no tape to record")), ok });
    }
    if (a.demo?.status !== "done") demoResults.push({ artifact: a.title, status: a.demo?.status ?? "none", ok: false });
  }
  check("each terminal variant was recorded in the sandbox, or says why it was not", demoResults.length > 0 && demoResults.every((r) => r.ok), demoResults);

  // The PE: a verdict on every variant of every artifact, from its own runs.
  const peRuns = st.studio.runs.filter((r) => r.kind === "pe");
  const reviewed = artifacts.map((a) => ({ artifact: a.title, review: S.peReview(st, a).status, verdicts: st.studio.verdicts.filter((v) => v.artifactId === a.id && v.version === a.version).map((v) => `${v.variant ?? "all"}: ${v.verdict}`) }));
  check(
    "the PE's verdicts were recorded on every artifact, by the PE's own runs",
    artifacts.length > 0 && reviewed.every((r) => r.review === "agreed" || r.review === "objections") && peRuns.some((r) => r.status === "completed"),
    { reviewed, peRuns: peRuns.map((r) => `${r.provider} ${r.status}`) },
  );
  check(
    "the PE ran on the other provider than the designer's (the default)",
    peRuns.length > 0 && peRuns.every((r) => r.provider !== "claude"),
    peRuns.map((r) => `${r.id}: ${r.provider} · ${r.actualModel ?? r.model}`),
  );

  // Once the PE agreed, or its objections came to the owner, the owner can answer.
  const answers = [];
  for (const a of artifacts) {
    try {
      await cmd("sendFeedback", { entries: [{ artifactId: a.id, version: a.version, mark: "keep", ...(a.variants.length > 1 ? { pickedVariant: a.variants[0].id } : {}), pins: [], note: "Studio trial: the owner's answer." }] });
      answers.push({ artifact: a.title, sent: true });
    } catch (e) {
      answers.push({ artifact: a.title, sent: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  check("the owner can send feedback on every artifact the PE reviewed", answers.length > 0 && answers.every((x) => x.sent), answers);

  const after = (await state()).state;
  check("the project is still in Vision, with no factory start", after.project.stage === "shaping" && after.project.factoryStarts.length === 0, { stage: after.project.stage });

  capCheck(claudeSpend(after), 0, Spend.buildingSpend(after).usd);
  verdict();
}

/** The cap's check: Claude's spend, `carried` from earlier projects of this trial, with each run of no recorded cost at its run limit. */
function capCheck(spend, carried, buildingUsd) {
  const usd = carried + spend.usd;
  evidence.spend = { claudeUsd: Number(usd.toFixed(4)), claudeRunsWithoutCost: spend.unknown.length, buildingUsd: Number(buildingUsd.toFixed(4)) };
  check(`the estimated Claude spend stayed under the ${money(CAP_USD)} cap, each run with no recorded cost counted at its run limit`, usd <= CAP_USD, {
    claude: money(usd),
    withoutCost: spend.unknown.map((u) => `${u.id} at ${money(u.countedUsd)}`),
    ...(FAKE ? { note: "simulated runs record no usage and spend nothing" } : {}),
  });
}

function verdict() {
  evidence.ok = Object.keys(evidence.checks).length === EXPECTED_CHECKS && Object.values(evidence.checks).every((c) => c.ok);
  if (Object.keys(evidence.checks).length !== EXPECTED_CHECKS) log(`✗ ${Object.keys(evidence.checks).length} checks ran; PASSED needs exactly ${EXPECTED_CHECKS}`);
}

// ---------- --lead: the lead runs the studio from the owner's message (pass 4) ----------

const IDEA = "Weekend Trips: a small group of friends plans a weekend away: who is in, the day plan, and what it costs each. It runs in the browser on desktop and phones.";
const IDEA_MESSAGE = "Here is my idea: a small app for friends to plan a weekend away together. Please start the first round of the studio.";
const AS_IS_VISION = "Trip board: friends see the weekends they are planning, who is in, and what each costs. It exists today as one small web page; the next version should make planning a weekend together easy.";
const AS_IS_MESSAGE = "This is my old trip board app. Start from what it does today, then we will change it.";

/**
 * One project of the lead's trial: the owner sets it up and sends one message; the lead replies with its studio block;
 * the trial waits for the designer runs the block asked for, their imports, screenshots and the PE. Returns what
 * happened, or null when the cap left too little to start.
 */
async function leadProject(key, { repoPath, vision, message, carried }) {
  await cmd("initProject", { name: `Weekend Trips (studio trial, ${key})`, repoPath, vision, focus: "Studio trial" });
  await cmd("setDevices", { devices: ["desktop", "mobile"] });
  await cmd("setBudgets", { buildingUsd: CAP_USD + CODEX_USD, maintenanceUsdPerMonth: 10 });
  const left = CAP_USD - carried;
  if (left < MIN_RUN_USD) {
    record(`not started: ${key}`, { reason: `the estimated Claude spend (${money(carried)}) leaves less than ${money(MIN_RUN_USD)} of the ${money(CAP_USD)} cap` });
    return null;
  }
  // Every run the service starts here (the lead's, the designer's) has at most a quarter of what is left.
  await setLimit(Math.max(MIN_RUN_USD, Math.min(2, Math.floor((left / 4) * 100) / 100)));
  const s0 = (await state()).state;
  record("project created", { phase: key, stage: s0.project.stage, devices: s0.project.devices, domains: s0.project.domains, runLimit: money(s0.project.runLimits.maxBudgetUsd) });
  await cmd("postMessage", { text: message });
  const { s: replied, waitedMs } = await until(`${key}: the lead's reply`, (x) => ended(x.state.leadRuns.at(-1)), FAKE ? minutes(2) : minutes(25), FAKE ? 500 : 5000);
  const lead = replied.state.leadRuns.at(-1);
  const round = replied.state.studio.rounds.at(-1);
  const asked = replied.state.studio.runs.filter((r) => r.fromLead?.leadRunId === lead.id);
  const reply = replied.state.conversation.filter((m) => m.author === "lead").at(-1);
  record(`lead replied: ${key}`, { run: lead.id, outcome: lead.outcome, provider: lead.provider, model: lead.actualModel ?? lead.model, usage: lead.usage ?? null, tookMs: waitedMs, notes: reply?.rejected ?? [] });
  if (round) record("round opened", { phase: key, round: round.n, focus: round.focus, summary: round.summary, by: round.leadRunId ?? null, lead: round.lead ?? null });
  record(`designer runs asked for by the lead: ${key}`, { runs: asked.map((r) => ({ id: r.id, round: r.round, provider: r.provider, fromLead: r.fromLead, brief: r.brief })) });
  let st = replied.state;
  if (asked.length) {
    ({ s: { state: st } } = await until(`${key}: the designer runs, their imports and PE review`, (x) => asked.every((r) => ended(x.state.studio.runs.find((y) => y.id === r.id))) && (settled(x.state) || !S.latestArtifacts(x.state).some((a) => a.madeBy.role === "designer")), FAKE ? minutes(4) : minutes(40), FAKE ? 500 : 5000));
  }
  const artifacts = S.latestArtifacts(st).filter((a) => a.madeBy.role === "designer");
  evidence.projects = [
    ...(evidence.projects ?? []),
    {
      phase: key,
      round: round ? { n: round.n, focus: round.focus, summary: round.summary, lead: round.lead ?? null } : null,
      runs: st.studio.runs.map((r) => ({ id: r.id, kind: r.kind, provider: r.provider, model: r.actualModel ?? r.model, status: r.status, usage: r.usage ?? null, simulated: !!r.simulated, note: r.note ?? null, fromLead: r.fromLead ?? null })),
      artifacts: artifacts.map((a) => ({ id: a.id, version: a.version, round: a.round, kind: a.kind, title: a.title, variants: a.variants.length, devices: a.devices, provenance: a.provenance ?? null, peReview: S.peReview(st, a).status })),
      verdicts: st.studio.verdicts.map((v) => ({ artifact: `${v.artifactId} v${v.version}`, variant: v.variant ?? null, verdict: v.verdict, reasons: v.reasons, by: v.by ?? null })),
    },
  ];
  return { key, lead, round, asked: asked.map((r) => st.studio.runs.find((y) => y.id === r.id)), artifacts, state: st, spend: claudeSpend(st) };
}

/** Whether the PE reviewed every one of these artifacts through its own runs, and the owner may now see them. */
const reviewed = (st, artifacts) => artifacts.length > 0 && artifacts.every((a) => S.readyForOwner(st, a) && st.studio.verdicts.some((v) => v.artifactId === a.id && v.version === a.version && v.by));

async function leadTrial() {
  const fixture = join(ROOT, "scripts", "fixtures", "studio-existing");
  const fixtureFiles = readdirSync(fixture).sort();
  const existing = join(work, "existing");
  mkdirSync(existing);
  for (const f of fixtureFiles) copyFileSync(join(fixture, f), join(existing, f));
  const g = (...a) => execFileSync("git", ["-C", existing, ...a], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("-c", "user.name=Orchestration test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "The trip board as it is");

  const idea = await leadProject("a short idea", { repoPath: repo, vision: IDEA, message: IDEA_MESSAGE, carried: 0 });
  const carried = idea ? idea.spend.usd : 0;
  const asIs = await leadProject("as it is today", { repoPath: existing, vision: AS_IS_VISION, message: AS_IS_MESSAGE, carried });

  const plan = (p, n, focus) => !!p?.round && p.round.n === n && p.round.focus === focus && p.round.leadRunId === p.lead.id && !!p.round.lead?.message.trim() && p.round.lead.questions.length > 0;
  const fromBlock = (p) => !!p && p.asked.length > 0 && p.asked.every((r) => r?.status === "completed" && r.fromLead?.leadRunId === p.lead.id);
  const roundOf = (p) => (p?.round ? { n: p.round.n, focus: p.round.focus, summary: p.round.summary, questions: p.round.lead?.questions ?? [] } : null);
  check("a short idea: the lead opened round 1 on the experience, its message and questions stored on the round", plan(idea, 1, "experience"), roundOf(idea));
  check(
    "a short idea: the designer runs came from the lead's block, and the PE reviewed what they made",
    fromBlock(idea) && reviewed(idea.state, idea.artifacts),
    idea ? { runs: idea.asked.map((r) => `${r?.id} ${r?.status}`), artifacts: idea.artifacts.map((a) => `${a.title} v${a.version}: ${S.peReview(idea.state, a).status}`) } : "not started",
  );
  check("as it is today: the lead opened round 0 on the existing repository, its message and questions stored on the round", plan(asIs, 0, "material") && /as it is today/i.test(asIs.round.summary), roundOf(asIs));
  const reproduced = asIs ? asIs.artifacts.filter((a) => a.round === 0) : [];
  check(
    "as it is today: the designer runs came from the lead's block, and each reproduction is labelled as is with the fixture's files it came from",
    fromBlock(asIs) && reproduced.length > 0 && reproduced.every((a) => a.provenance?.asIs && a.provenance.files.length > 0 && a.provenance.files.every((f) => fixtureFiles.includes(f))) && reproduced.some((a) => a.provenance.files.includes("index.html")),
    reproduced.map((a) => ({ artifact: `${a.title} v${a.version}`, kind: a.kind, provenance: a.provenance ?? null })),
  );
  check("as it is today: the PE reviewed the reproduction", !!asIs && reviewed(asIs.state, reproduced), reproduced.map((a) => `${a.title}: ${asIs ? S.peReview(asIs.state, a).status : "none"}`));
  check("the reproduced screen is served sandboxed: a fetch from inside it to the app's API fails, in Chrome", ...(await sandboxCheck(reproduced.find((a) => a.kind === "screen"))));

  // The owner answers the reproduction, as they would in the studio.
  const answers = [];
  for (const a of reproduced) {
    try {
      await cmd("sendFeedback", { entries: [{ artifactId: a.id, version: a.version, mark: "keep", pins: [], note: "Studio trial: that is how it works today." }] });
      answers.push({ artifact: a.title, sent: true });
    } catch (e) {
      answers.push({ artifact: a.title, sent: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  check("the owner can send feedback on every reproduction the PE reviewed", answers.length > 0 && answers.every((x) => x.sent), answers);

  const after = (await state()).state;
  const stages = [idea?.state, after].filter(Boolean).map((x) => ({ project: x.project.name, stage: x.project.stage, starts: x.project.factoryStarts.length }));
  check("both projects stayed in Vision, with no factory start", stages.length === 2 && stages.every((x) => x.stage === "shaping" && x.starts === 0), stages);
  capCheck(claudeSpend(after), carried, Spend.buildingSpend(after).usd);
  verdict();
}

/** The type a version's file is served as through the app's own route, or null when it is not served. */
async function fileType(a, path) {
  if (!path) return null;
  const res = await fetch(`${BASE}/api/studio/file?artifact=${encodeURIComponent(a.id)}&version=${a.version}&path=${encodeURIComponent(path)}`);
  await res.arrayBuffer();
  return res.ok ? res.headers.get("content-type") : null;
}

/**
 * Open the studio in Chrome on the screen artifact, find its frame, and from inside the framed prototype try to read
 * the app's state. Returns the check's [ok, detail]. Also saves a screenshot of the studio in the evidence folder.
 */
async function sandboxCheck(screen) {
  if (!screen) return [false, "no screen artifact to frame"];
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return [false, "playwright-core is not installed"];
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
  } catch {
    return [false, "no Chrome found (set CHROME_PATH)"];
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${BASE}/#/vision`, { waitUntil: "load" });
    await page.getByRole("list", { name: /Artifacts of round/ }).getByRole("button", { name: new RegExp(screen.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    const frameEl = page.locator(`iframe[src*="p-${screen.id}-v${screen.version}.localhost:${PROTOTYPE_PORT}"]`);
    await frameEl.waitFor({ timeout: 20_000 });
    const sandbox = await frameEl.getAttribute("sandbox");
    const frame = await (await frameEl.elementHandle()).contentFrame();
    await frame.waitForLoadState("load");
    const inside = await frame.evaluate(async (url) => {
      const origin = self.origin;
      try {
        const r = await fetch(url);
        return { origin, reached: true, status: r.status };
      } catch (e) {
        return { origin, reached: false, error: String(e) };
      }
    }, `${BASE}/api/state`);
    await page.screenshot({ path: join(work, "studio-1280.png") });
    const ok = sandbox === "allow-scripts" && inside.origin === "null" && (!inside.reached || inside.status >= 400);
    return [ok, { sandbox, frameOrigin: inside.origin, fetch: inside.reached ? `answered ${inside.status}` : `failed: ${inside.error}` }];
  } catch (e) {
    return [false, `the browser check failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`];
  } finally {
    await browser.close();
  }
}

/** The evidence as committed to docs/real-runs: without the service log, every local path as <work>, <orchestrator> or ~. */
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
  const dir = join(ROOT, "evidence");
  mkdirSync(dir, { recursive: true });
  const stamp = evidence.startedAt.replace(/[:.]/g, "-");
  const file = join(dir, `studio-trial-${evidence.mode}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`\n${evidence.ok ? "PASSED" : "NOT PASSED"}: evidence written to ${file}`);
  console.log(`The throwaway project, its database and the studio screenshot are kept in ${work}`);
  // The record for the repository is checked before it is written: one that still holds a path, a name or a
  // key-like string stays in evidence/ for a person to fix. A fake run's record stays in evidence/ too.
  if (evidence.steps.some((st) => st.name === "round opened")) {
    const text = publicRecord(evidence) + "\n";
    const leaks = leaksIn(text, [
      { what: "your user name", value: userInfo().username },
      { what: "this computer's name", value: hostname() },
      { what: "your git email", value: gitEmail() },
    ]);
    if (leaks.length) {
      const held = join(dir, `studio-record-NOT-COMMITTED-${stamp}.json`);
      writeFileSync(held, text);
      console.log(`The record was NOT written to docs/real-runs: it contains ${leaks.join(", ")}. Fix it by hand: ${held}`);
    } else if (FAKE) {
      const kept = join(dir, `studio-record-fake-${stamp}.json`);
      writeFileSync(kept, text);
      console.log(`The record as it would be committed (fake runs are not): ${kept}`);
    } else {
      const records = join(ROOT, "docs", "real-runs");
      mkdirSync(records, { recursive: true });
      writeFileSync(join(records, `${stamp}.json`), text);
      console.log(`Record for the repository (no local paths, no service log): ${join(records, `${stamp}.json`)}`);
    }
  }
  process.exit(exitCode || (evidence.ok ? 0 : 1));
}
