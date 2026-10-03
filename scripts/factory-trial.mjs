// The factory trial (ORC-029 pass 5, unit 5f): one Feature task builds a small sample end to end, and the record shows
// pass 5's evidence of what the factory built. The proof of docs/design/ORC-029-pass5-design.md ("The proof").
//
//   npm run trial:factory -- --fake           the simulated runtime (no cost; what CI and the coder run)
//   npm run trial:factory                     real Claude and Codex agents (costs money; the lead runs it)
//   npm run trial:factory -- --cap-usd 3      the estimated Claude spend it may reach (default 2)
//   npm run trial:factory -- --codex-usd 2    the Codex allowance in the building budget (default 2)
//   npm run trial:factory -- --run-usd 0.4    each Claude run's limit (default: a fifth of the cap, at most $0.50)
//   npm run trial:factory -- --claude-model claude-sonnet-5-5    the Claude roles' model (default: the catalog's first)
//
// A sibling of scripts/studio-trial.mjs: that trial is Vision (rounds, the designer, the PE), and this one is the
// factory. They share the spend cap (scripts/trialSpend.mjs); this one starts the service and keeps its record through
// scripts/trialService.mjs, and judges what it saw with scripts/factoryTrialPlan.mjs.
//
// What it does:
// 1. Copies the fixture (scripts/fixtures/factory-trial/repo: Split, a page, a CLI and a frozen core) into a throwaway
//    repository, and starts the service on a throwaway database.
// 2. Puts a blueprint in force without the studio's agents, to keep the trial cheap. The script stands in for the
//    designer and the lead, and every stand-in step is labelled in the record (`standIns`): it hands in the fixture's
//    designs (a screen with its prototype, a terminal demo, and a flow with 3 EARS rules and 1 example) through the
//    service's own import check and commands, as the owner's, and closes the round, which ends PE review in the studio
//    without a PE run. The owner then approves the three items and starts the factory (the first Lock in).
// 3. Writes R3's test with the flow's item id in its tag, and checks the fixture before any agent runs: `npm test`
//    exits 0 and its JUnit report, read by the service's parser, records R3 as failed.
// 4. Sets the checks (`npm test`, the JUnit report at reports/junit.xml), the preview (`npm run preview` on 4173, the
//    CLI entry bin/split.js), the environment the evidence runs in (the table's Node image, `npm ci`; ORC-030 C3
//    removed the recorder's own install), local delivery to main, and PE review of new work (on for a new project).
// 5. Creates one Feature task as the owner, citing the three items, and starts it. Its design step waits for a PE run.
// 6. Waits until the task landed (the fake runtime: finished and integrated), answering each decision put to the
//    owner with "fix", as the owner would, and recording each answer.
// 7. Checks what the factory recorded (see CHECKS) and writes the record.
//
// R3 fails on purpose (scripts/fixtures/factory-trial/README.md): the core drops the leftover cents, the spec tells
// the agents to leave it and R3's test as they are, and the test is a todo test, which fails without failing the run.
// So the task lands, while the rule results show R3 failing and the flow reads "fails a check". This is more reliable
// than adding a failing test after the task lands: rule results come only from the checks of the landed change, and a
// test added later is not in that change.
//
// The cap: Claude's spend counts each run with no recorded cost at its run limit (scripts/trialSpend.mjs). On every
// poll, when the spend plus each Claude run under way at its limit reaches the cap, the trial pauses the project and
// records that it did; nothing more starts. Each run's limit is small enough that the three reviews that run at once
// fit under the cap with the spend before them.

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLANNED_RULES, PLANNED_STATUSES, r3FailsOnPurpose, renderR3Test, rulesAsPlanned, runLimitUsd, statusesAsPlanned } from "./factoryTrialPlan.mjs";
import { claudeExposure, claudeSpend } from "./trialSpend.mjs";
import { keepEvidence, minutes, orchestratorVersion, startService } from "./trialService.mjs";

// The service's and the domain's own code, through tsx (the npm script starts node with it).
const loaded = await Promise.all([
  import("../server/store.ts"),
  import("../server/studio/artifacts.ts"),
  import("../server/studio/container.ts"),
  import("../server/testReport.ts"),
  import("../src/domain/model.ts"),
  import("../src/domain/spend.ts"),
  import("../src/domain/checks.ts"),
  import("../src/domain/peReview.ts"),
  import("../src/domain/studio/blueprint.ts"),
  import("../src/domain/studio/studio.ts"),
  import("../src/domain/studio/types.ts"),
  import("../src/domain/studio/ruleResults.ts"),
  import("../src/domain/studio/itemStatus.ts"),
  import("../src/domain/studio/evidence.ts"),
  import("../src/domain/types.ts"),
  import("../src/domain/environment.ts"),
]).catch((e) => {
  console.error(`Run this with \`npm run trial:factory\` (node --import tsx): ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
const [{ Store }, A, Recorder, { parseJUnit }, M, Spend, C, P, B, S, ST, RR, IS, E, T, Env] = loaded;

const args = process.argv.slice(2);
const FAKE = args.includes("--fake");
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const CAP_USD = Number(option("--cap-usd", "2"));
const CODEX_USD = Number(option("--codex-usd", "2"));
const RUN_USD = Number(option("--run-usd", String(runLimitUsd(CAP_USD))));
const CLAUDE_MODEL = option("--claude-model", "auto");
const TIMEOUT_MIN = Number(option("--timeout-minutes", FAKE ? "15" : "120"));
if (!(CAP_USD > 0) || !(CODEX_USD >= 0) || !(RUN_USD > 0) || RUN_USD > CAP_USD || !(TIMEOUT_MIN > 0)) {
  console.error("--cap-usd and --run-usd are positive dollars (the run limit at most the cap), --codex-usd zero or more, --timeout-minutes positive.");
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "scripts", "fixtures", "factory-trial");
const PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5399);
const PROTOTYPE_PORT = Number(process.env.ORCHESTRATION_PROTOTYPE_PORT ?? PORT + 1);

// What the owner sets up: the project, its checks and preview, and the factory's settings.
const VISION = [
  "Split: friends split a restaurant bill. One person enters the total and the number of people; each sees what they pay.",
  "It runs as a web page on desktop and phones, and as a `split` command for the one who paid.",
  "Scale: a handful of people per bill. Free to use; no server state.",
].join("\n");
const TEST_REPORT = "reports/junit.xml";
const CHECK_COMMANDS = [{ id: "test", label: "Tests", kind: "check", argv: ["npm", "test"] }];
const PREVIEW = { preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/split.js" };
/** Evidence runs only in the project's environment: the proposal table's Node image, as the owner would confirm it. */
const ENVIRONMENT = { image: Env.IMAGE_TABLE.find((r) => r.label === "Node").image, prepare: [["npm", "ci"]] };
/** The files the trial keeps as they are: the frozen core and R3's test. A change that edits them asks the owner. */
const FROZEN = ["public/split.js", "test/rules-r3.test.js"];
const SETTINGS = { autonomy: "manual", delivery: { mode: "local", branch: "main", merge: "auto" }, pausePoints: { tradeoffs: "user", changeOrders: "user", startEachTask: false } };
/** Decisions the trial answers "fix" for the owner, at most. One more means the task is stuck. */
const MAX_ANSWERS = 4;

const CHECKS = {
  fixture: "the fixture's R3 test fails on purpose: npm test exits 0, and its JUnit report, read by the service's parser, records R3 as failed",
  blueprint: "the blueprint in force holds the screen with its prototype, the CLI's terminal demo, and the flow with 3 EARS rules and 1 example, locked in by Start the factory",
  settings: "the checks (npm test, with the JUnit report at reports/junit.xml), the preview (npm run preview on port 4173, the CLI entry bin/split.js) and the environment (the Node image, npm ci) are set, and the checks sandbox is ready",
  task: "one Feature task cites the three items, and its acceptance carries the tag of each rule and of the example",
  pe: "the PE reviewed the design before the coder started: a PE run agreed to S1's design, and S2 started after its verdict",
  finished: "the task finished: each step done or skipped, and its work integrated",
  landed: "the task's work landed on main (local delivery)",
  evidenceStep: "the Capture evidence step ran after the checks and recorded the screen and the CLI",
  evidenceFiles: "the evidence of the landed commit: a PNG of the built page on desktop and on mobile, and a GIF of the CLI, served by the app",
  rules: "the rule results from the landed work's checks: R1, R2 and E1 pass, and R3 fails",
  statuses: "the item statuses: the screen and the CLI built and verified, the flow failing a check",
  cap: "the estimated Claude spend stayed under the cap, each run with no recorded cost counted at its run limit",
};
/** What the fake runtime cannot show, and why: these checks are skipped there, and said so. */
const FAKE_SKIPS = {
  landed: "the fake runtime uses no git worktrees, so nothing is delivered to a branch",
  evidenceFiles: "the fake runtime starts no container: each item's evidence is recorded as simulated",
  rules: "the simulated checks run no command, so no JUnit report is read and every rule reads No test",
  statuses: "they come from landed work, its rule results and its captured evidence, which the fake runtime has none of",
};
const EXPECTED_CHECKS = Object.keys(CHECKS).length - (FAKE ? Object.keys(FAKE_SKIPS).length : 0);

const t0 = Date.now();
const evidence = {
  scenario: "factory-trial",
  mode: FAKE ? "fake" : "real",
  startedAt: new Date().toISOString(),
  orchestrator: orchestratorVersion(ROOT),
  capUsd: CAP_USD,
  codexUsd: CODEX_USD,
  runLimitUsd: RUN_USD,
  plan: { rules: PLANNED_RULES, statuses: PLANNED_STATUSES, r3: "R3 fails on purpose: the frozen core drops the leftover cents, and R3's test is a todo test, which fails without failing npm test." },
  standIns: [],
  steps: [],
  checks: {},
  skipped: {},
  ok: false,
};
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const check = (key, ok, detail = null) => {
  evidence.checks[CHECKS[key]] = { ok: !!ok, detail };
  log(`${ok ? "✓" : "✗"} ${CHECKS[key]}${detail ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
};
/** A check the fake runtime cannot make: skipped in --fake, with the reason; made otherwise. */
const realCheck = (key, judge) => {
  if (FAKE) {
    evidence.skipped[CHECKS[key]] = FAKE_SKIPS[key];
    log(`– skipped: ${CHECKS[key]} (${FAKE_SKIPS[key]})`);
    return;
  }
  return judge();
};
const record = (name, data = {}) => {
  evidence.steps.push({ name, atMs: Date.now() - t0, ...data });
  log(`${name}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ""}`);
};
/** A step the script takes in place of an agent or the service's studio, labelled as such in the record. */
const standIn = (forWhom, what, data = {}) => {
  evidence.standIns.push({ for: forWhom, what, ...data });
  record(`stand-in for ${forWhom}: ${what}`, data);
};
const money = (n) => `$${n.toFixed(2)}`;

// ---------- the throwaway repository and the service ----------

// Inside this checkout's gitignored evidence/ folder, out of the agents' reach (they write only their own worktrees).
const work = join(ROOT, "evidence", `factory-${evidence.mode}-${evidence.startedAt.replace(/[:.]/g, "-")}`);
mkdirSync(work, { recursive: true });
const repo = join(work, "repo");
cpSync(join(FIXTURE, "repo"), repo, { recursive: true });
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const commit = (message) => git("-c", "user.name=Orchestration test", "-c", "user.email=test@localhost", "commit", "-q", "-m", message);
git("init", "-q", "-b", "main");
git("add", "-A");
commit("Split before the factory trial");
const dbPath = join(work, "orchestration.db");
const svc = startService({ root: ROOT, port: PORT, prototypePort: PROTOTYPE_PORT, dbPath, fake: FAKE });
const { cmd, state } = svc;

// ---------- the spend cap ----------

const spendOpts = { estimate: (r) => Spend.estimateUsd(r, Spend.PRICES), limitOf: () => RUN_USD, simulated: FAKE };
/** Set once the trial paused the project at the cap: then nothing more starts, and the trial stops waiting. */
let capPause = null;
async function capGuard(st) {
  if (capPause || st.project.sample || st.project.hold) return;
  const exposure = claudeExposure(st, spendOpts);
  if (exposure.usd < CAP_USD) return;
  await cmd("pauseProject");
  const running = [...st.attempts.filter((a) => a.outcome === "running" || a.outcome === "stopping").map((a) => `${a.id} ${a.taskId} ${a.stepId} on ${a.snapshot.provider}`), ...st.leadRuns.filter((r) => r.outcome === "running").map((r) => `${r.id} lead on ${r.provider}`), ...st.studio.runs.filter((r) => ["queued", "running", "stopping"].includes(r.status)).map((r) => `${r.id} ${r.kind} ${r.status} on ${r.provider}`)];
  capPause = { claudeUsd: money(exposure.usd), cap: money(CAP_USD), runsUnderWay: running };
  evidence.capPause = capPause;
  record("paused at the cap: the spend so far and the Claude runs under way, each at its limit, reach the cap", capPause);
}
const until = (what, pred, timeoutMs, pollMs = FAKE ? 500 : 5000) => svc.until(what, pred, { timeoutMs, pollMs, guard: capGuard });

// ---------- the trial ----------

async function main() {
  let s = await svc.ready();
  const health = Object.fromEntries(Object.entries(s.service.providers).map(([p, i]) => [p, i.health.status]));
  record("service started", { runtime: s.service.runtime, health });
  const notReady = Object.entries(s.service.providers).filter(([, i]) => i.health.status !== "ready");
  if (notReady.length) throw new Error(`A provider is not ready: ${notReady.map(([p, i]) => `${p} is ${i.health.status}: ${i.health.detail}`).join(" ")} Configure it, then run the trial again.`);
  if (!FAKE) {
    // The capture of evidence needs Docker and the recorder's image: found out now, before any money is spent.
    const rec = await Recorder.probeRecorder();
    record("recorder checked", { ok: rec.ok, detail: rec.ok ? `image ${Recorder.RECORDER_IMAGE}` : rec.detail });
    if (!rec.ok) throw new Error(`The recorder is not available (${rec.detail}). Start Docker and run \`npm run recorder:build\`, then run the trial again.`);
  }
  // A fresh fake database seeds the sample project, whose runs start at once: stop them first.
  if (s.state.attempts.some((a) => a.outcome === "running" || a.outcome === "stopping")) {
    await cmd("pauseProject");
    await svc.until("sample runs stopped", (x) => x.state.attempts.every((a) => a.outcome !== "running" && a.outcome !== "stopping"), { timeoutMs: 60_000 });
  }

  // The project, as the owner sets it up: in Vision, its devices, its budgets and each run's limit.
  await cmd("initProject", { name: "Split (factory trial)", repoPath: repo, vision: VISION, focus: "Factory trial" });
  await cmd("setDevices", { devices: ["desktop", "mobile", "terminal"] });
  // The building budget bounds Codex too (the service starts no run past it). Real runs only: the fake runtime's task
  // runs record no cost and no "simulated" mark, so a budget could not be judged and would stop all new work.
  if (!FAKE) await cmd("setBudgets", { buildingUsd: CAP_USD + CODEX_USD, maintenanceUsdPerMonth: 5 });
  await cmd("setRunLimits", { maxTurns: 60, timeoutMinutes: 20, maxBudgetUsd: RUN_USD });
  if (CLAUDE_MODEL !== "auto") {
    for (const role of ["lead", "designer", "code_reviewer", "ux_reviewer"]) await cmd("setRoleDefault", { role, selection: { provider: "claude", model: CLAUDE_MODEL } });
    await cmd("setLeadSelection", { selection: { provider: "claude", model: CLAUDE_MODEL } });
  }
  s = (await state()).state;
  record("project created", { stage: s.project.stage, devices: s.project.devices, budgets: s.project.budgets, runLimits: s.project.runLimits, peReviewsNewWork: s.project.peReviewsNewWork, roleDefaults: s.project.roleDefaults });

  const items = await blueprintInDraft();
  await fixtureCheck(items.flow);
  await setUp();

  // Start the factory as the owner does: the agreement on what the pre-flight shows, and the settings. The first Lock in.
  s = (await state()).state;
  await cmd("startFactory", { ...M.startFactoryRequest(s), settings: SETTINGS });
  s = (await state()).state;
  record("factory started", { stage: s.project.stage, start: s.project.factoryStarts.at(-1), blueprintRev: B.blueprintRev(s) });
  checkBlueprint(s, items);
  checkSettings(s);

  const taskId = await feature(items);
  const done = await build(taskId);
  await judge(done, taskId, items);
}

/**
 * The blueprint's draft, without the studio's agents. In place of the lead: open round 1, and close it once the designs
 * are in. In place of the designer: hand in the fixture's designs as the owner's, through the service's import check
 * (readStaged) and its commands, each version written where the studio keeps it, with its screenshots asked for as an
 * import does. Closing the round ends PE review in the studio with no PE run (the record says "the round closed").
 * The project is paused meanwhile, so no studio run starts; a PE run asked for before the close is refused when it
 * would start ("round 1 was closed"). Then the owner approves each item into the draft.
 */
async function blueprintInDraft() {
  await cmd("pauseProject");
  const studio = new Store(dbPath);
  const now = () => new Date().toISOString();
  const serviceCmd = (name, a) => studio.command(name, a, `factory-trial-${randomUUID()}`, now()).result;
  try {
    const round = serviceCmd("openRound", { focus: "experience", summary: "Split's page, its CLI and the flow of splitting a bill (factory trial)." }).n;
    standIn("the lead", "opened round 1", { round });
    const staged = A.readStaged(join(FIXTURE, "design"), ST.DESIGNER_KINDS);
    const projectId = studio.read().state.project.id;
    const root = A.studioRoot(work, projectId);
    const made = {};
    for (const a of staged) {
      const r = serviceCmd("addStudioArtifact", {
        round,
        kind: a.kind,
        title: a.title,
        variants: a.variants.map((v) => ({ id: v.id, label: v.label, entry: v.entry })),
        files: a.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
        devices: a.devices,
        madeBy: { role: "user" },
        ...(a.rules ? { rules: a.rules } : {}),
      });
      A.writeVersion(root, { artifactId: r.artifactId, version: r.version, kind: a.kind, title: a.title, devices: a.devices, variants: a.variants, files: a.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })) }, a.files);
      // As an import does: the screenshots of a screen, and a terminal demo's frames, made once the project resumes.
      studio.update((st) => S.startArtifactMedia(st, r.artifactId, r.version), now());
      made[a.kind] = r;
      standIn("the designer", `handed in ${a.kind} "${a.title}" as the owner's`, { artifact: `${r.artifactId} v${r.version}`, files: a.files.map((f) => f.path), ...(a.rules ? { rules: a.rules[0].rules.map((x) => `${x.id} ${x.pattern}`), examples: a.rules[0].examples.map((x) => x.id) } : {}) });
    }
    serviceCmd("closeRound", { round, summary: "The designs are in (factory trial)." });
    standIn("the lead", "closed round 1, which ends PE review of its designs in the studio with no PE run", { round });
  } finally {
    studio.close();
  }
  let s = (await state()).state;
  for (const a of S.latestArtifacts(s).filter((x) => x.round === 1)) await cmd("approveArtifact", { artifactId: a.id, version: a.version });
  await cmd("resumeProject");
  s = (await state()).state;
  const draft = B.draftItems(s);
  const id = (kind) => draft.find((i) => i.kind === kind && i.status === "approved")?.id;
  const items = { screen: id("screen"), cli: id("terminal-demo"), flow: id("flow") };
  record("the owner approved the three items into the draft", { items, draftRev: B.draftRev(s), peReview: S.latestArtifacts(s).filter((x) => x.round === 1).map((a) => `${a.title}: ${S.peReview(s, a).status}${S.peReview(s, a).ended ? ` (${S.peReview(s, a).ended})` : ""}`) });
  if (!items.screen || !items.cli || !items.flow) throw new Error(`The draft lacks an approved item: ${JSON.stringify(items)}`);
  return items;
}

/**
 * R3's test, with the flow's item id in its tag, committed to main before the factory starts. Then the check before any
 * agent runs: the fixture's test run passes, and its report records R3 as failed. A fixture that does not do so stops
 * the trial here, before anything is spent.
 */
async function fixtureCheck(flowItem) {
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "test", "rules-r3.test.js"), renderR3Test(readFileSync(join(FIXTURE, "r3-test.template.js"), "utf8"), flowItem));
  git("add", "-A");
  commit(`R3's test, deliberately left failing for the factory trial (${flowItem})`);
  const run = spawnSync("npm", ["test"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
  const report = join(repo, TEST_REPORT);
  const parsed = existsSync(report) ? parseJUnit(readFileSync(report, "utf8"), (t, cap) => t.slice(0, cap)) : { ok: false, reason: `npm test wrote no ${TEST_REPORT}` };
  rmSync(report, { force: true });
  const judged = parsed.ok ? r3FailsOnPurpose({ exitCode: run.status, cases: parsed.cases, tag: RR.ruleTag(flowItem, "R3"), carriesTag: RR.carriesTag }) : { ok: false, detail: { exitCode: run.status, report: parsed.reason } };
  check("fixture", judged.ok, judged.detail);
  if (!judged.ok) throw new Error(`The fixture does not fail R3 on purpose; nothing was started. npm test said:\n${(run.stdout ?? "") + (run.stderr ?? "")}`.slice(0, 4000));
}

/** The owner's settings: the checks with the test report, the preview, and the checks sandbox's probe. */
async function setUp() {
  await cmd("setChecks", {
    config: {
      enabled: true,
      commands: CHECK_COMMANDS,
      sandbox: "codex",
      prepareNetwork: true,
      commandTimeoutMinutes: 10,
      runTimeoutMinutes: 30,
      maxConcurrent: 1,
      protectedInputs: [...T.DEFAULT_CHECKS.protectedInputs, ...FROZEN],
      passEnv: [],
      testReport: TEST_REPORT,
    },
  });
  await cmd("setPreview", { preview: PREVIEW });
  await cmd("setEnvironment", { environment: ENVIRONMENT });
  const { s } = await until("the checks sandbox's probe", (x) => {
    const h = x.state.project.checksHealth;
    return !!h && !h.recheck && h.sandbox === "codex";
  }, minutes(3), 1000);
  const h = s.state.project.checksHealth;
  record("checks, preview and environment set", { checks: { commands: s.state.project.checks.commands.map((c) => c.argv.join(" ")), testReport: s.state.project.checks.testReport, protected: FROZEN }, preview: s.state.project.preview, environment: s.state.project.environment, sandbox: `${h.status}: ${h.detail}` });
  if (h.status !== "ready") throw new Error(`The checks sandbox is ${h.status}: ${h.detail}`);
}

function checkBlueprint(s, items) {
  const inForce = B.blueprintItems(s).filter((i) => i.status === "approved");
  const art = (id) => {
    const item = inForce.find((i) => i.id === id);
    return item && B.citedArtifact(s, item);
  };
  const screen = art(items.screen);
  const cli = art(items.cli);
  const flow = art(items.flow);
  const rules = flow?.rules?.[0];
  const start = s.project.factoryStarts.at(-1);
  check(
    "blueprint",
    s.project.stage === "building" && start?.by === "user" && start.blueprintRev === B.blueprintRev(s) && screen?.kind === "screen" && screen.variants[0]?.entry?.endsWith(".html") && cli?.kind === "terminal-demo" && flow?.kind === "flow" && rules?.rules.length === 3 && rules.rules.every((r) => !!r.pattern) && rules.examples.length === 1,
    {
      blueprintRev: B.blueprintRev(s),
      start: start ? { by: start.by, blueprintRev: start.blueprintRev } : null,
      items: inForce.map((i) => `${i.id} ${i.kind} "${i.title}" v${i.version}`),
      prototype: screen?.variants[0]?.entry ?? null,
      rules: rules ? [...rules.rules.map((r) => `${r.id} ${r.pattern}`), ...rules.examples.map((x) => x.id)] : null,
    },
  );
}

function checkSettings(s) {
  const c = s.project.checks;
  const p = s.project.preview;
  check(
    "settings",
    C.checksOn(c) && c.testReport === TEST_REPORT && c.commands.some((x) => x.kind === "check" && x.argv.join(" ") === "npm test") && p?.preview?.join(" ") === PREVIEW.preview.join(" ") && p.port === PREVIEW.port && p.cliEntry === PREVIEW.cliEntry && s.project.environment?.image === ENVIRONMENT.image && s.project.checksHealth?.status === "ready",
    { checks: c.commands.map((x) => `${x.id}: ${x.argv.join(" ")}`), testReport: c.testReport ?? null, preview: p ? E.previewWords(p) : null, environment: s.project.environment ? Env.environmentWords(s.project.environment) : null, sandbox: s.project.checksHealth?.status ?? null, delivery: s.project.autonomy.autoDeliver },
  );
}

/**
 * The Feature task, as the owner creates it (the lead path would cost a lead run and a PE review of the proposal):
 * its acceptance takes each rule and example of the flow with its tag, as a lead's proposal does, and says that R3
 * is left failing on purpose. It cites the three items, then starts.
 */
async function feature(items) {
  let s = (await state()).state;
  const refs = [items.screen, items.cli, items.flow];
  const acceptance = [
    ...B.blueprintAcceptance(s, refs),
    `${RR.ruleTag(items.flow, "R3")} is deliberately left failing for the factory trial: public/split.js drops the cents left over, and test/rules-r3.test.js tests R3 as a todo test, which fails without failing npm test. Leave both files as they are, and add no other test for R3.`,
    "The page and the CLI use split() and money() from public/split.js.",
    "When the page opens, it shows the share for 90.00 and 3 people, as the prototype does, so that a screenshot shows it.",
    "The capture plan's tape types `node bin/split.js 90 3` and `node bin/split.js 90 0`, and outputs a GIF.",
  ];
  const created = await cmd("createTask", {
    title: "Split a bill on the page and with the split command",
    area: "Split",
    outcome: "The page and the `split` command split a bill equally, as the approved screen, terminal demo and flow show.",
    benefit: "Friends see what each of them pays.",
    whyNow: "The factory trial: one Feature task, built end to end, with evidence beside the design.",
    approach: "Build on the existing page (public/index.html) and command (bin/split.js), with the core in public/split.js. Keep package.json, public/split.js and test/rules-r3.test.js as they are.",
    acceptance,
    priority: 1,
    holdBeforeStart: true,
    flowId: "feature",
  });
  const id = created.result.newId;
  s = (await state()).state;
  const spec = M.currentSpec(s.tasks.find((t) => t.id === id));
  await cmd("editSpec", { taskId: id, expectedRev: spec.rev, content: { ...spec.content, blueprintRefs: refs }, reason: "Cites the approved screen, terminal demo and flow (factory trial)" });
  await cmd("startHeldTask", { taskId: id });
  s = (await state()).state;
  const t = s.tasks.find((x) => x.id === id);
  const content = M.currentSpec(t).content;
  const tags = ["R1", "R2", "R3", "E1"].map((x) => RR.ruleTag(items.flow, x));
  record("task created and started", { task: id, flow: t.flow.id, steps: t.steps.map((st) => `${st.id} ${st.role}`), blueprintRefs: content.blueprintRefs });
  check("task", t.flow.id === "feature" && JSON.stringify(content.blueprintRefs) === JSON.stringify(refs) && tags.every((tag) => content.acceptance.some((a) => a.startsWith(tag))), { task: id, blueprintRefs: content.blueprintRefs ?? [], acceptance: content.acceptance });
  return id;
}

/** Why the task cannot go on by itself, or undefined. A decision put to the owner is answered before this is asked. */
function stuck(st, t, answered) {
  if (t.lifecycle === "cancelled") return "the task was cancelled";
  const budget = Spend.budgetStop(st);
  if (budget) return budget.why;
  const hold = P.taskReviewHold(t);
  if (hold && hold.hold !== P.PE_REVIEW_HOLD) return `${hold.step ? `${hold.step.id}: ` : ""}${hold.hold}`;
  const open = st.decisions.filter((d) => d.taskId === t.id && d.status === "open");
  if (open.some((d) => d.routedTo === "user") && answered >= MAX_ANSWERS) return `${open.length} decision(s) still open after ${MAX_ANSWERS} answers: ${open.map((d) => d.finding.title).join("; ")}`;
  const blocked = t.steps.find((x) => x.state === "blocked");
  if (blocked && !open.length) return `${blocked.id} is blocked: ${blocked.blockedReason ?? "no reason given"}`;
  const d = st.project.delivery;
  if (d?.status === "blocked" || d?.status === "conflict") return `delivery to main: ${d.message}`;
  if (t.integration?.status === "conflict") return `integration: ${t.integration.message ?? "conflict"}`;
  return undefined;
}

/**
 * Wait until the task landed (the fake runtime: finished and integrated), answering each decision put to the owner
 * with "fix", as an owner who wants the work right would, and recording the answer. Stops early when the trial paused
 * at the cap, or the task cannot go on by itself; then, as after a time-out, the checks still run on the state as it
 * is, so the record shows how far the task got and what it cost.
 */
async function build(id) {
  const answers = [];
  try {
    const { s, waitedMs } = await until(
      "the task to land",
      async (x) => {
        const t = x.state.tasks.find((y) => y.id === id);
        if (capPause) return true;
        for (const d of x.state.decisions.filter((y) => y.taskId === id && y.status === "open" && y.routedTo === "user")) {
          if (answers.length >= MAX_ANSWERS) break;
          await cmd("decideFinding", { decisionId: d.id, decision: "fix", note: "Answered by the factory trial, as the owner: fix it. Keep public/split.js and test/rules-r3.test.js as they are." });
          answers.push({ decision: d.id, kind: d.kind, finding: d.finding.title });
          record("decision answered for the owner: fix", { decision: d.id, kind: d.kind, finding: d.finding.title });
        }
        const why = stuck(x.state, t, answers.length);
        if (why) throw new Error(`The task cannot go on by itself: ${why}`);
        return FAKE ? t.lifecycle === "done" && t.integration?.status === "integrated" : !!t.integration?.landed;
      },
      minutes(TIMEOUT_MIN),
    );
    record(capPause ? "stopped waiting: paused at the cap" : FAKE ? "task finished and integrated" : "task landed", { tookMs: waitedMs });
    return capPause ? await stopRuns() : s.state;
  } catch (e) {
    evidence.error = e instanceof Error ? e.message : String(e);
    record("stopped waiting", { why: evidence.error });
    return await stopRuns();
  } finally {
    evidence.decisionsAnswered = answers;
  }
}

/** The trial stopped waiting early: pause the project, so nothing more runs or spends, and wait for the runs to stop. */
async function stopRuns() {
  const busy = (x) => x.attempts.some((a) => a.outcome === "running" || a.outcome === "stopping") || x.leadRuns.some((r) => r.outcome === "running" || r.outcome === "stopping") || x.studio.runs.some((r) => r.status === "running" || r.status === "stopping");
  try {
    if (!(await state()).state.project.hold) await cmd("pauseProject");
    const { s } = await svc.until("the runs to stop", (x) => !busy(x.state), { timeoutMs: minutes(3), pollMs: 1000 });
    record("project paused and its runs stopped");
    return s.state;
  } catch (e) {
    record("the runs did not all stop", { why: e instanceof Error ? e.message : String(e) });
    return (await state()).state;
  }
}

/** The checks of what the factory recorded, and the record's details. */
async function judge(st, id, items) {
  const t = st.tasks.find((x) => x.id === id);
  const ids = [items.screen, items.cli, items.flow];
  const attempts = st.attempts.filter((a) => a.taskId === id || a.taskId.startsWith(`${id}.`) || a.taskId.startsWith(`${id}-`));
  evidence.task = {
    id,
    lifecycle: t.lifecycle,
    steps: t.steps.map((x) => `${x.id} ${x.role}: ${x.state}${x.blockedReason ? ` (${x.blockedReason})` : ""}`),
    integration: t.integration ? { status: t.integration.status, landed: t.integration.landed ? { at: t.integration.landed.at, target: t.integration.landed.target, commit: t.integration.landed.commit, flags: t.integration.landed.flags, simulated: !!t.integration.landed.simulated } : null } : null,
    peReview: t.steps.filter((x) => x.peReview).map((x) => ({ step: x.id, status: x.peReview.status, rounds: x.peReview.rounds.map((r) => ({ at: r.at, verdict: r.verdict, reasons: r.reasons, change: r.change ?? null })) })),
  };
  evidence.runs = [
    ...attempts.map((a) => ({ id: a.id, step: a.stepId, role: t.steps.find((x) => x.id === a.stepId)?.role ?? null, provider: a.snapshot.provider, model: a.actualModel ?? a.snapshot.model, outcome: a.outcome, startedAt: a.startedAt, usage: a.usage ?? null, estimatedUsd: Spend.estimateUsd(a, Spend.PRICES).usd, note: a.note ?? null })),
    ...st.leadRuns.map((r) => ({ id: r.id, kind: "lead", trigger: r.trigger, provider: r.provider, model: r.actualModel ?? r.model, outcome: r.outcome, usage: r.usage ?? null, estimatedUsd: Spend.estimateUsd(r, Spend.PRICES).usd })),
    ...st.studio.runs.map((r) => ({ id: r.id, kind: r.kind, review: r.review ?? null, provider: r.provider, model: r.actualModel ?? r.model, status: r.status, usage: r.usage ?? null, estimatedUsd: Spend.estimateUsd(r, Spend.PRICES).usd, note: r.note ?? null })),
  ];

  // The PE reviewed the design before the coder started.
  const s1 = t.steps.find((x) => x.id === "S1");
  const peRuns = st.studio.runs.filter((r) => r.kind === "pe" && r.review?.taskId === id && r.review.stepId === "S1");
  const agreedAt = s1?.peReview?.status === "agreed" ? s1.peReview.rounds.at(-1)?.at : undefined;
  const coderStarts = st.attempts.filter((a) => a.taskId === id && a.stepId === "S2").map((a) => a.startedAt);
  check("pe", !!agreedAt && peRuns.some((r) => r.status === "completed") && coderStarts.length > 0 && coderStarts.every((x) => x >= agreedAt), {
    review: s1?.peReview ? { status: s1.peReview.status, rounds: s1.peReview.rounds.map((r) => `${r.verdict}${r.change ? `: ${r.change}` : ""}`) } : null,
    peRuns: peRuns.map((r) => `${r.id} ${r.provider} ${r.status}${r.simulated ? " (simulated)" : ""}`),
    agreedAt: agreedAt ?? null,
    coderStarted: coderStarts,
  });

  check("finished", t.lifecycle === "done" && t.steps.every((x) => x.state === "done" || x.state === "skipped") && t.integration?.status === "integrated", { lifecycle: t.lifecycle, integration: t.integration?.status ?? null, steps: evidence.task.steps });

  const landedSha = t.integration?.pr?.changeSha ?? M.finalChange(st, t)?.ref?.split(" ")[0];
  realCheck("landed", () => {
    const landed = t.integration?.landed;
    let onMain = false;
    try {
      onMain = !!landed && spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", landed.commit, "main"]).status === 0;
    } catch {
      onMain = false;
    }
    check("landed", !!landed && landed.target === "main" && onMain && !landed.simulated, landed ? { target: landed.target, commit: landed.commit, onMain, flags: landed.flags, change: landedSha ?? null } : "not landed");
  });

  // The Capture evidence step: after the checks, with a record for each cited screen and CLI.
  const evidenceArts = st.artifacts.filter((a) => a.taskId === id && a.kind === "evidence" && a.evidence && a.author !== "user");
  const firstChecks = st.artifacts.filter((a) => a.taskId === id && a.kind === "check-results" && a.checkRun).map((a) => a.createdAt).sort()[0];
  const evidenceRuns = st.attempts.filter((a) => a.taskId === id && a.snapshot.evidence);
  const lastRun = evidenceArts.at(-1)?.evidence;
  const recorded = lastRun ? [items.screen, items.cli].map((i) => lastRun.items.find((x) => x.itemId === i)) : [];
  evidence.evidenceRuns = evidenceArts.map((a) => ({ artifact: a.id, run: a.attemptId, sha: a.evidence.sha, simulated: !!a.evidence.simulated, items: a.evidence.items.map((i) => (i.status === "captured" ? { item: i.itemId, captured: i.files.map((f) => f.path), warnings: i.warnings ?? [] } : { item: i.itemId, none: i.reason, detail: i.detail })) }));
  check(
    "evidenceStep",
    !!firstChecks && evidenceRuns.length > 0 && evidenceRuns.every((a) => a.startedAt >= firstChecks) && recorded.length === 2 && recorded.every((i) => !!i && (FAKE ? i.status === "none" && i.reason === "simulated" : i.status === "captured")),
    { firstChecksAt: firstChecks ?? null, runs: evidenceRuns.map((a) => `${a.id} ${a.stepId} ${a.outcome} at ${a.startedAt}`), items: recorded.map((i) => (i ? `${i.itemId}: ${i.status === "captured" ? "captured" : `none, ${i.reason}`}` : "missing")) },
  );

  await realCheck("evidenceFiles", () => evidenceFiles(st, items, landedSha));

  realCheck("rules", () => {
    const r = rulesAsPlanned(RR.ruleResults(st, items.flow), id);
    evidence.ruleResults = r.detail;
    check("rules", r.ok, r.detail);
  });

  realCheck("statuses", () => {
    const r = statusesAsPlanned(ids.map((i) => IS.itemFactoryStatus(st, i)), ids);
    evidence.itemStatuses = r.detail;
    check("statuses", r.ok, r.detail);
  });

  const spend = claudeSpend(st, spendOpts);
  evidence.spend = { claudeUsd: Number(spend.usd.toFixed(4)), claudeRunsWithoutCost: spend.unknown.length, buildingUsd: Number(Spend.buildingSpend(st).usd.toFixed(4)) };
  check("cap", spend.usd <= CAP_USD, { claude: money(spend.usd), cap: money(CAP_USD), withoutCost: spend.unknown.map((u) => `${u.id} at ${money(u.countedUsd)}`), ...(capPause ? { pausedAtCap: capPause } : {}), ...(FAKE ? { note: "simulated runs record no usage and spend nothing" } : {}) });

  evidence.ok = Object.keys(evidence.checks).length === EXPECTED_CHECKS && Object.values(evidence.checks).every((c) => c.ok);
  if (Object.keys(evidence.checks).length !== EXPECTED_CHECKS) log(`✗ ${Object.keys(evidence.checks).length} checks ran; PASSED needs exactly ${EXPECTED_CHECKS}`);
}

/** The PNGs and the GIF of the landed commit, each as the app's file route serves it (real runs only). */
async function evidenceFiles(st, items, landedSha) {
  const served = async (ev, file) => {
    const res = await fetch(`${svc.base}/api/studio/file?evidence=${encodeURIComponent(ev.from.attemptId)}&path=${encodeURIComponent(file.path)}`);
    await res.arrayBuffer();
    return res.ok ? res.headers.get("content-type") : null;
  };
  const screen = E.itemEvidence(st, items.screen);
  const cli = E.itemEvidence(st, items.cli);
  const files = async (ev, type) => (ev?.status === "captured" ? await Promise.all(ev.files.filter((f) => f.type === type).map(async (f) => ({ path: f.path, device: f.device ?? null, bytes: f.bytes, servedAs: await served(ev, f) }))) : []);
  const pngs = await files(screen, "png");
  const gifs = await files(cli, "gif");
  const atLanded = (ev) => !!ev && "commit" in ev && !!landedSha && C.sameSha(ev.commit, landedSha);
  const detail = {
    landedChange: landedSha ?? null,
    screen: screen ? { status: screen.status, commit: screen.commit ?? null, landed: screen.from?.landed ?? null, files: pngs, ...(screen.status === "none" ? { reason: screen.reason, why: screen.detail } : {}) } : null,
    cli: cli ? { status: cli.status, commit: cli.commit ?? null, landed: cli.from?.landed ?? null, files: gifs, ...(cli.status === "none" ? { reason: cli.reason, why: cli.detail } : {}) } : null,
  };
  evidence.evidenceFiles = detail;
  check(
    "evidenceFiles",
    atLanded(screen) && atLanded(cli) && screen.from.landed && ["desktop", "mobile"].every((d) => pngs.some((f) => f.device === d && f.servedAs === "image/png")) && gifs.some((f) => f.servedAs === "image/gif"),
    detail,
  );
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  evidence.error = e instanceof Error ? e.message : String(e);
  console.error(`\nFAILED: ${evidence.error}`);
  exitCode = 1;
} finally {
  await svc.stop();
  // A record for the repository once the factory started; a fake run's stays in evidence/.
  const lines = keepEvidence({ evidence, serviceLog: svc.log, work, root: ROOT, name: "factory-trial", fake: FAKE, recordable: evidence.steps.some((x) => x.name === "factory started") });
  for (const l of lines) console.log(l);
  process.exit(exitCode || (evidence.ok ? 0 : 1));
}
