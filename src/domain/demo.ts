// ORC-017 §5: the demo state, "Weekend Trips (sample)". Separate from `buildSeed()`, the test fixture,
// which stays unchanged. The fake service starts from this state and Reset sample data restores it.
//
// How it is built: the project and its task specs are written here; every run record is created the
// way dispatch creates it (an attempt with a resolved provider and a snapshot), and everything that
// follows goes through the real domain functions: completions (`reportCompletion`, which makes the
// artifacts, the decisions, the loop iterations and the child tasks), the pause and its acknowledgment,
// the pull-request head, publication, observation, merge and landing, the review-later marks, and the
// lead's replies with their steering. So the state is what the service would have written, and every
// simulated thing is labelled by the records themselves (simulated runs, pull requests and check runs)
// rather than by text inside titles and summaries.

import * as C from "./checks";
import * as D from "./delivery";
import * as M from "./model";
import { DEMO_SCRIPT, HISTORY, HISTORY_SENT_BACK, type HistoryFix, type HistoryTask } from "./demoScript";
import { computeOutcome } from "./outcomes";
import { builtInCatalog, builtInOrInternal, patternHash, patternRef } from "./patterns";
import { instantiate, toDef } from "./pipeline";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_CHECKS,
  DEFAULT_PR_DELIVERY,
  DEFAULT_RUN_LIMITS,
  type Actor,
  type Attempt,
  type CheckObs,
  type CheckRunRecord,
  type ChosenBy,
  type EventKind,
  type Finding,
  type ModelSelection,
  type Runner,
  type SpecContent,
  type SpecOption,
  type State,
  type Step,
  type StepDef,
  type Task,
  type VisionDoc,
} from "./types";

export const DEMO_PROJECT_ID = "sample";
export const DEMO_PROJECT_NAME = "Weekend Trips (sample)";
export const DEMO_REPO_PATH = "~/code/weekend-trips";

/** Minutes in a day, for the builder's minutes-ago clock. */
const DAY = 1440;
/**
 * The project was created 31 days before now (ORC-018 §7): the history runs from day 30 to day 9, the
 * current story (WT-001 onwards) takes the last three days, and the activity log stays in time order.
 */
const T_PROJECT = 31 * DAY;
/** The history's pull-request numbers start here; the current story's are 991 and up. */
const HISTORY_PR_FROM = 900;

/** The sample model ids are kept (they are honest); the labels say what they are. */
export const DEMO_CATALOG = {
  claude: [
    { id: "claude-sample-large", label: "Claude large (sample model)" },
    { id: "claude-sample-fast", label: "Claude fast (sample model)" },
  ],
  codex: [
    { id: "codex-sample-large", label: "Codex large (sample model)" },
    { id: "codex-sample-fast", label: "Codex fast (sample model)" },
  ],
};
const CLAUDE: ModelSelection = { provider: "claude", model: "claude-sample-large" };
const CLAUDE_FAST: ModelSelection = { provider: "claude", model: "claude-sample-fast" };
const CODEX: ModelSelection = { provider: "codex", model: "codex-sample-large" };

/** The one vision document: a field note written for the demo. The copy on disk is written by the service at start. */
export const DEMO_DOC_TEXT = `# Trail research: weekend hikes near the city

Field notes from four weekends, written for whoever plans the app. Nothing here is a requirement yet;
it is what happened and what people said afterwards.

## Where we hiked

- Ridge Loop (14 km, 620 m up). No signal from the trailhead onwards. Two of us lost the group at the
  junction after the second creek because the map tiles had never loaded.
- Lakeshore Path (9 km, flat). Patchy signal. Good for families; the parking lot fills by 9:30 on Saturdays.
- Pine Saddle (18 km, 900 m up). No signal at all. Water only at the hut, 11 km in.
- Quarry Trail (6 km). Signal everywhere; the only hike where the group chat worked.

## What went wrong

- Plans lived in three chats. Nobody knew who was actually coming until the parking lot.
- Packing: two people brought stoves, nobody brought a first-aid kit (Ridge Loop).
- The map app we used showed a blank grid without signal. We navigated by a photo of the trailhead sign.
- One friend uses VoiceOver. The map pins read "pin 1, pin 2"; the distances were unlabelled numbers.

## What people asked for

1. The map must work with no signal. Download the trail before leaving.
2. One place to see who is coming.
3. A packing list the group can tick off together, suggested from the trail length and the forecast.
4. Fewer screens. "I want to open it at the trailhead and see the one thing I need."

## Constraints

- Phones only; nobody plans a hike on a laptop.
- Battery matters: no background location tracking.
- Keep personal data minimal; friends should not need an account to see a plan.

## What we used, and dropped

- A group chat for the plan: fine until the day; useless at the trailhead.
- A shared spreadsheet for packing: nobody opened it on a phone.
- Two map apps: both needed a download step nobody remembered to do.

## Open questions

- Miles or kilometres? The group is split; the phone's region setting is probably the right default.
- How far around a trail should offline tiles extend? 20 km felt right on Pine Saddle.
- Do we need weather at all, or is a link to the forecast enough?
`;
/** SHA-256 of DEMO_DOC_TEXT (UTF-8). A test checks it; the service stores the copy under this name. */
export const DEMO_DOC_HASH = "8abdeec6a297352e028d87999b343ab8468e4b33a5ecdd1cdbdad73c818f571f";

const SIM_REPO = "simulated/repository";
const SIM_LOGIN = "simulated-user";
const SIM_BASE = "sim-base";
const SIM_CHECK: CheckObs = { name: "simulated-check", required: true, status: "COMPLETED", conclusion: "SUCCESS" };
const CHECK_COMMANDS = [
  { id: "test", label: "test", kind: "check" as const, argv: ["npm", "test"] },
  { id: "lint", label: "lint", kind: "check" as const, argv: ["npm", "run", "lint"] },
];
const PASS_EXCERPTS: Record<string, string> = {
  test: "Test Files  12 passed (12)\n     Tests  142 passed (142)\n  Duration  17.8s",
  lint: "✔ No problems found (0 errors, 0 warnings)",
};

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** FNV-1a over the text, twice, as 12 hex characters: a deterministic finding key (pure, no crypto). */
function hash12(text: string): string {
  const fnv = (input: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const a = fnv(text);
  return `${a}${fnv(`${text}|${a}`).slice(0, 4)}`;
}

/** A deterministic 40-character hex "commit" for a sample change (no repository exists). */
function fakeSha(label: string): string {
  let out = "";
  for (let i = 0; out.length < 40; i++) out += hash12(`${label}#${i}`);
  return out.slice(0, 40);
}

function opt(id: string, name: string, approach: string, benefit: string, effort: string, risks: string, reversibility: string): SpecOption {
  return { id, name, approach, benefit, effort, risks, reversibility };
}

function spec(partial: Partial<SpecContent> & Pick<SpecContent, "title" | "area" | "outcome" | "benefit" | "options">): SpecContent {
  return {
    whyNow: "",
    successCriteria: [],
    scopeIncluded: [],
    scopeExcluded: [],
    recommendedOptionId: partial.options[0].id,
    selectedOptionId: partial.options[0].id,
    decidedBy: "lead",
    rationale: "",
    uncertainty: "",
    overrideReason: "",
    acceptance: [],
    validationPlan: "",
    rollback: "Discard the orchestration branch; nothing reaches main except through a pull request you merge.",
    effort: "small",
    ...partial,
  };
}

/** A review finding in the shape the service records (the key is the carry-forward identity). */
function finding(id: string, f: Omit<Finding, "id" | "key" | "source">): Finding {
  return { id, key: hash12(`review|${f.file ?? ""}|${f.title.toLowerCase().replace(/\s+/g, " ").trim()}`), source: "review", ...f };
}

type CodeChange = { sha: string; paths: string[]; files: number; additions: number; deletions: number };

/** Tokens a run reports; the cost follows from the provider (see `usageOf`). */
type Tokens = { input: number; output: number };

/**
 * mulberry32, seeded by a task's id: every duration and token count of the history is the same on every
 * build, so the captures are stable (ORC-018 §7: no Math.random at build time).
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (id: string) => parseInt(hash12(id).slice(0, 8), 16);

/** Usage as the adapters report it: Claude reports a cost; Codex reports tokens only (design §7). */
function usageOf(provider: Runner, t: Tokens): NonNullable<Attempt["usage"]> {
  if (provider === "claude") return { inputTokens: t.input, outputTokens: t.output, costUsd: Math.round(t.input * 0.0003 + t.output * 0.0015) / 100 };
  return { inputTokens: t.input, outputTokens: t.output };
}

/**
 * The Bug fix pattern as it was before the fix step wrote a handoff for the reviewer: the same steps with
 * S2's `handoff` output and S3's reading of it removed. Its hash differs from the catalog's, so the one
 * history task that ran it shows the Compare page's version grouping (ORC-018 §7).
 */
export function olderBugfixSteps(): StepDef[] {
  const steps = structuredClone(builtInOrInternal("bugfix").steps).map(toDef);
  for (const st of steps) {
    if (st.id === "S2") st.outputs = st.outputs.filter((o) => o.name !== "handoff");
    st.inputs = st.inputs.filter((r) => !(r.step === "S2" && r.output === "handoff"));
  }
  return steps;
}

/**
 * Builds the demo state chronologically. Minutes-ago timestamps keep the story relative to "now"; every
 * helper asserts that the real domain function accepted what it was given, so a demo that drifts from
 * the service's rules fails to build instead of showing an impossible state.
 */
class DemoBuilder {
  s: State;

  constructor(private readonly nowMs: number) {
    this.s = this.baseState();
  }

  /** ISO time `m` minutes before now (fractions are seconds). */
  at(m: number): string {
    return new Date(this.nowMs - Math.round(m * 60_000)).toISOString();
  }

  private task(id: string): Task {
    const t = this.s.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`demo: unknown task ${id}`);
    return t;
  }

  private step(id: string, stepId: string): Step {
    const st = this.task(id).steps.find((x) => x.id === stepId);
    if (!st) throw new Error(`demo: ${id} has no step ${stepId}`);
    return st;
  }

  private event(m: number, actor: Actor, kind: EventKind, message: string, taskId?: string) {
    M.event(this.s, this.at(m), actor, kind, message, taskId);
  }

  // ---------- the project ----------

  private baseState(): State {
    const at = (m: number) => this.at(m);
    const doc: VisionDoc = { id: "doc-1", name: "trail-research.md", path: "trail-research.md", size: utf8Length(DEMO_DOC_TEXT), hash: DEMO_DOC_HASH, text: true, addedAt: at(T_PROJECT + 36) };
    const leadRunId = "lead-1001";
    const draftId = `vd-${leadRunId}`;
    const visionText =
      "Weekend Trips helps a small group of friends plan a weekend hike together: pick a trail, share the plan, pack the right things, and keep the map working with no signal. It should feel calm and dependable on a phone at a trailhead. Fewer, clearer screens beat more features.";
    const draftReason = "Drafted from the shaping conversation and the trail research note";
    return {
      version: 15,
      seq: 1001,
      project: {
        id: DEMO_PROJECT_ID,
        sample: true,
        name: DEMO_PROJECT_NAME,
        repoPath: DEMO_REPO_PATH,
        // r1: the draft the simulated lead wrote while shaping, accepted by the user; the flag says where the text came from.
        visions: [
          {
            rev: 1,
            at: at(T_PROJECT + 20),
            author: "user",
            text: visionText,
            focus: "Trip sharing first.",
            reason: `Accepted the lead's draft (${draftId}): ${draftReason}`,
            source: { draftId, leadRunId, messageIds: [] },
            docIds: [doc.id],
            simulated: true,
          },
        ],
        visionDocs: [doc],
        enabledProviders: ["claude", "codex"],
        catalog: structuredClone(DEMO_CATALOG),
        defaultSelection: { ...CLAUDE },
        roleDefaults: { designer: { ...CLAUDE }, lead: { ...CLAUDE }, coder: { ...CODEX }, code_reviewer: { ...CLAUDE }, ux_reviewer: { ...CLAUDE_FAST } },
        leadSelection: { ...CLAUDE },
        workerLimit: 3,
        providerLimits: { claude: 3, codex: 3 },
        runLimits: { ...DEFAULT_RUN_LIMITS },
        autonomy: { ...DEFAULT_AUTONOMY, autoDeliver: { ...DEFAULT_AUTONOMY.autoDeliver } },
        steeringMode: "apply",
        stage: "building",
        shapingSince: at(T_PROJECT + 40),
        checks: structuredClone(DEFAULT_CHECKS),
        triage: { askUserBy: "user" },
        conventions: { include: true },
        prDelivery: structuredClone(DEFAULT_PR_DELIVERY),
        workerEnvironment: { claude: "isolated", codex: "isolated" },
        workerConnections: { claude: [], codex: [] },
        hold: false,
        lastVisitAt: at(240),
        defaultPatternId: "change",
      },
      tasks: [],
      attempts: [],
      artifacts: [],
      conversation: [],
      // The shaping run: coverage of all nine areas, and the draft the user accepted as r1.
      leadRuns: [
        {
          id: leadRunId,
          trigger: "message",
          provider: "claude",
          model: CLAUDE.model,
          startedAt: at(T_PROJECT + 34),
          endedAt: at(T_PROJECT + 32),
          outcome: "completed",
          messageIds: [],
          coverage: { intent: "clear", audience: "clear", problem: "clear", outcome: "clear", scope: "clear", constraints: "clear", risks: "clear", priorities: "clear", material: "clear" },
        },
      ],
      steering: [],
      visionDrafts: [{ id: draftId, at: at(T_PROJECT + 32), leadRunId, messageIds: [], text: visionText, focus: "Trip sharing first.", reason: draftReason, basedOnVisionRev: 0, status: "accepted", resolvedAt: at(T_PROJECT + 20), visionRev: 1, simulated: true }],
      decisions: [],
      // ORC-016: the built-in catalog until the server loads the files (it replaces this at start).
      patterns: builtInCatalog(),
      retiredTemplates: [],
      events: [
        { id: "ev-1", at: at(T_PROJECT + 40), actor: "system", kind: "config", message: `${DEMO_PROJECT_NAME} created; shaping the vision with the lead` },
        { id: "ev-2", at: at(T_PROJECT + 32), actor: "lead", kind: "vision", message: `Lead run ${leadRunId} drafted the vision (${draftId}) from the shaping conversation: ${draftReason}. It waits for you to accept, edit or dismiss it.` },
        { id: "ev-3", at: at(T_PROJECT + 20), actor: "user", kind: "vision", message: `Vision r1 by you: accepted the lead's draft ${draftId}` },
      ],
    };
  }

  /** Delivery as pull requests held for you, the project's checks on, and the simulated GitHub checked (all through the real commands). */
  private settings() {
    this.event(T_PROJECT + 18, "user", "config", "Building started");
    this.s = D.setDeliveryMode(this.s, { mode: "pr" }, this.at(T_PROJECT + 17));
    this.preflight(T_PROJECT + 17);
    this.s = D.reportBaseFetched(this.s, SIM_BASE, this.at(T_PROJECT + 16));
    this.s = C.setChecks(
      this.s,
      { ...structuredClone(DEFAULT_CHECKS), enabled: true, commands: CHECK_COMMANDS.map((c) => ({ ...c, argv: [...c.argv] })) },
      false,
      this.at(T_PROJECT + 15),
    );
    this.checksReady(T_PROJECT + 14);
  }

  private preflight(m: number) {
    this.s = D.reportPreflight(
      this.s,
      {
        ok: true,
        simulated: true,
        repo: SIM_REPO,
        login: SIM_LOGIN,
        requiredChecks: [SIM_CHECK.name],
        autoMergeBlockers: [],
        posture: [{ id: "simulated", status: "unverified", label: "Simulated GitHub", detail: "The fake runtime never contacts GitHub. Pull requests, checks and merges shown here are simulated." }],
      },
      this.at(m),
    );
  }

  private checksReady(m: number) {
    this.s = C.reportChecksHealth(this.s, { sandbox: "codex", status: "ready", detail: "Simulated: no command runs and nothing is spawned.", checkedAt: this.at(m) }, this.at(m));
  }

  // ---------- tasks ----------

  private addTask(id: string, priority: number, content: SpecContent, patternId: string, m: number, o: { author?: "lead" | "user"; chosenBy?: ChosenBy; dependsOn?: string[]; steps?: StepDef[] } = {}): Task {
    const pattern = builtInOrInternal(patternId);
    // `o.steps`: an earlier version of the pattern, recorded with the hash of what actually ran.
    const defs = (o.steps ?? structuredClone(pattern.steps)).map(toDef);
    const author = o.author ?? "lead";
    const ref = { ...patternRef(pattern, o.chosenBy ?? author), ...(o.steps ? { hash: patternHash(defs) } : {}) };
    const t: Task = {
      id,
      priority,
      lifecycle: "proposed",
      hold: false,
      holdBeforeStart: false,
      specs: [{ rev: 1, at: this.at(m), author, reason: author === "lead" ? "Initial spec published by lead" : "Created by you", content }],
      steps: instantiate(defs),
      pipelineRev: 1,
      pipelineHistory: [{ rev: 1, at: this.at(m), author, reason: `Created from the ${pattern.name} pattern`, steps: defs, pattern: ref }],
      pattern: ref,
      patternSince: 1,
      roleOverrides: {},
      dependsOn: o.dependsOn ?? [],
      createdAt: this.at(m),
      updatedAt: this.at(m),
      decisionAt: this.at(m),
    };
    this.s.tasks.push(t);
    return t;
  }

  /** The lead's promotion, as `leadPromoteProposals` records it. */
  private promote(ids: string[], m: number) {
    for (const id of ids) {
      const t = this.task(id);
      if (t.lifecycle !== "proposed") throw new Error(`demo: ${id} is not proposed`);
      t.lifecycle = "ready";
      t.updatedAt = this.at(m);
      this.event(m, "lead", "control", "Moved to Ready: spec published, assignments resolved", id);
    }
  }

  /** Dispatch a step the way the scheduler does: the provider resolved by the real rules, a snapshot, an event. */
  private dispatch(id: string, stepId: string, m: number, o: { scope?: NonNullable<Attempt["scope"]> } = {}): string {
    const t = this.task(id);
    const st = this.step(id, stepId);
    if (st.state !== "pending") throw new Error(`demo: ${id} ${stepId} is ${st.state}, not pending`);
    if (!st.dependsOn.every((d) => M.isSettled(this.step(id, d)))) throw new Error(`demo: ${id} ${stepId} has unsettled prerequisites`);
    const spec = M.currentSpec(t);
    const vision = M.currentVision(this.s);
    const attemptId = M.nextId(this.s, "run");
    const workspace = `${DEMO_REPO_PATH}/.orchestration/worktrees/${id}-${stepId}`;
    let a: Attempt;
    if (st.role === "checks") {
      const cfg = this.s.project.checks;
      const target = C.checkTargetOf(this.s, t, st);
      if (!target) throw new Error(`demo: ${id} ${stepId} has nothing to check`);
      a = {
        id: attemptId,
        taskId: id,
        stepId,
        snapshot: {
          provider: "service",
          model: "checks",
          source: "service",
          routingReason: "Run by the service (sandboxed)",
          specRev: spec.rev,
          stepRev: st.revision,
          visionRev: vision.rev,
          workspace,
          pipelineRev: t.pipelineRev,
          role: st.role,
          purpose: st.purpose,
          inputs: M.consumedInputs(this.s, t, st),
          checks: { configRev: cfg.rev, sandbox: cfg.sandbox, target, commands: C.commandsFor(cfg, st) },
        },
        startedAt: this.at(m),
        outcome: "running",
        progress: 0,
        artifacts: [],
      };
      this.event(m, "lead", "dispatch", `Dispatched ${stepId} (checks) to the service as ${attemptId} on ${target.ref.slice(0, 12)} with settings r${cfg.rev}`, id);
    } else {
      const r = M.resolveStep(this.s, t, st);
      if (!r.ok) throw new Error(`demo: ${id} ${stepId} does not resolve: ${r.reason}`);
      a = {
        id: attemptId,
        taskId: id,
        stepId,
        snapshot: {
          provider: r.selection.provider,
          model: r.selection.model,
          source: r.source,
          routingReason: r.reason,
          specRev: spec.rev,
          stepRev: st.revision,
          visionRev: vision.rev,
          workspace,
          pipelineRev: t.pipelineRev,
          role: st.role,
          environment: "isolated",
          connections: [],
          purpose: st.purpose,
          inputs: M.consumedInputs(this.s, t, st),
        },
        startedAt: this.at(m),
        outcome: "running",
        progress: 0,
        artifacts: [],
        ...(o.scope ? { scope: o.scope } : {}),
      };
      this.event(m, "lead", "dispatch", `Dispatched ${stepId} (${st.role}) to ${M.providerLabel(a.snapshot.provider)} · ${a.snapshot.model} as ${attemptId} on spec r${spec.rev}`, id);
    }
    this.s.attempts.push(a);
    st.state = "running";
    if (t.lifecycle === "ready") t.lifecycle = "active";
    t.updatedAt = this.at(m);
    return attemptId;
  }

  /**
   * The run's result, accepted by the real `reportCompletion` (artifacts, decisions, loops and children follow
   * from it). `tokens` becomes the usage the run's provider would report (a cost from Claude only).
   */
  private complete(attemptId: string, m: number, outputs: M.OutputReport[], run: M.RunReport = {}, tokens?: Tokens) {
    const before = this.s.attempts.find((x) => x.id === attemptId);
    if (!before) throw new Error(`demo: unknown attempt ${attemptId}`);
    const report = tokens ? { ...run, usage: usageOf(before.snapshot.provider, tokens) } : run;
    this.s = M.reportCompletion(this.s, attemptId, [], this.at(m), outputs, report);
    const a = this.s.attempts.find((x) => x.id === attemptId)!;
    if (a.outcome !== "completed") throw new Error(`demo: ${attemptId} (${a.taskId} ${a.stepId}) was not accepted: ${a.note ?? a.outcome}`);
  }

  /** A conditional step with nothing to do settles by skipping, as dispatch records it. */
  private skip(id: string, stepId: string, m: number) {
    const st = this.step(id, stepId);
    if (st.state !== "pending") throw new Error(`demo: ${id} ${stepId} is ${st.state}, not pending`);
    if (!st.runIf?.length) throw new Error(`demo: ${id} ${stepId} has no condition to skip on`);
    st.state = "skipped";
    this.task(id).updatedAt = this.at(m);
    this.event(m, "lead", "dispatch", `Skipped ${stepId}: nothing to fix in ${st.runIf.map((r) => `${r.step}.${r.output}`).join(", ")}`, id);
  }

  /** A coder step: the change (named by its commit and branch, as the service records it) and, when the step has one, the handoff. */
  private change(id: string, stepId: string, startM: number, endM: number, change: CodeChange, summary: string, handoff?: string, tokens?: Tokens): CodeChange {
    const attemptId = this.dispatch(id, stepId, startM);
    const st = this.step(id, stepId);
    const outputs: M.OutputReport[] = [{ name: "change", summary, ref: `${change.sha.slice(0, 12)} on orchestration/${DEMO_PROJECT_ID}/${id}/${stepId}/${attemptId}` }];
    if (st.outputs.some((o) => o.name === "handoff")) outputs.push({ name: "handoff", summary: handoff ?? "Nothing beyond the change itself." });
    this.complete(attemptId, endM, outputs, {}, tokens);
    return change;
  }

  /** A service check run on the newest change the step reads: passing, or with the named commands failing. */
  private checks(id: string, stepId: string, startM: number, endM: number, failing: { id: string; excerpt: string }[] = []) {
    const attemptId = this.dispatch(id, stepId, startM);
    const a = this.s.attempts.find((x) => x.id === attemptId)!;
    const plan = a.snapshot.checks!;
    const results = plan.commands.map((c) => {
      const fail = failing.find((f) => f.id === c.id);
      return { id: c.id, label: c.label, kind: c.kind, status: fail ? ("failed" as const) : ("passed" as const), exitCode: fail ? 1 : 0, durationMs: c.id === "test" ? 17_800 : 6_200, excerpt: fail?.excerpt ?? PASS_EXCERPTS[c.id] ?? "ok", bytes: 0, truncated: false };
    });
    const record: CheckRunRecord = { sha: plan.target.ref, configRev: plan.configRev, sandbox: "codex", simulated: true, touchedInputs: [], results, durationMs: results.reduce((n, r) => n + r.durationMs, 0) };
    const name = this.step(id, stepId).outputs[0].name;
    this.complete(attemptId, endM, [{ name, summary: C.runSummary(record), checkRun: record, findings: C.findingsFromRun(record, plan.commands) }]);
  }

  /** A review step. A code review is handed the change's file list and accounts for every file (complete coverage); findings are structured. */
  private review(id: string, stepId: string, startM: number, endM: number, change: CodeChange | undefined, summary: string, findings: Finding[] = [], tokens?: Tokens) {
    const st = this.step(id, stepId);
    const scope = change && st.role === "code_reviewer" ? { from: SIM_BASE, to: change.sha, paths: [...change.paths], total: change.paths.length } : undefined;
    const attemptId = this.dispatch(id, stepId, startM, scope ? { scope } : {});
    this.complete(attemptId, endM, [{ name: st.outputs[0].name, summary, findings, ...(scope ? { reviewedPaths: [...scope.paths] } : {}) }], {}, tokens);
  }

  /** Any other single-output step (a design, a plan, a report, the lead's verification). */
  private output(id: string, stepId: string, startM: number, endM: number, summary: string, extra: Partial<M.OutputReport> = {}, run: M.RunReport = {}, tokens?: Tokens) {
    const attemptId = this.dispatch(id, stepId, startM);
    this.complete(attemptId, endM, [{ name: this.step(id, stepId).outputs[0].name, summary, ...extra }], run, tokens);
  }

  // ---------- pull requests on the simulated GitHub ----------

  private prOp(id: string, kind: "publish" | "merge") {
    const pr = D.livePr(this.task(id));
    if (!pr) throw new Error(`demo: ${id} has no pull request`);
    return { id: `prop-${this.s.seq + 1}`, kind, taskId: id, n: pr.n, headSha: pr.headSha } as const;
  }

  private observation(id: string, m: number, state: "OPEN" | "MERGED" | "CLOSED", number: number): D.Observations {
    const pr = D.livePr(this.task(id))!;
    const merged = state === "MERGED";
    return {
      at: this.at(m),
      prs: [
        {
          number,
          state,
          isDraft: false,
          crossRepo: false,
          url: `simulated://pr/${number}`,
          headRef: pr.branch,
          headSha: pr.headSha,
          baseRef: pr.base,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          labels: [],
          checks: [{ ...SIM_CHECK }],
          checksFor: pr.headSha,
          ...(merged ? { mergedAt: this.at(m), mergeCommit: `sim-merge-${number}`, mergedBy: SIM_LOGIN } : {}),
          ...(state === "CLOSED" ? { closedBy: SIM_LOGIN } : {}),
        },
      ],
      commits: [],
      rateRemaining: 5000,
    };
  }

  /** You merged it on GitHub yourself: the next read sees it merged with no merge sent by the app, so it landed "by a person". */
  private mergedOnGitHub(id: string, m: number) {
    const pr = D.livePr(this.task(id))!;
    const number = pr.number!;
    this.s = D.reportObservations(this.s, this.observation(id, m, "MERGED", number), this.at(m), { requested: [{ taskId: id, number }], repo: SIM_REPO });
    const t = this.task(id);
    if (t.integration?.pr?.phase !== "merged" || t.integration.landed?.by !== "person") throw new Error(`demo: ${id} was not landed by a person`);
    if (t.integration.landed.flags.length) throw new Error(`demo: ${id} landed with flags ${t.integration.landed.flags.join(", ")}`);
    this.s = D.reportObservations(this.s, { at: this.at(m - 1), prs: [], commits: [{ oid: t.integration.landed.commit, checks: [{ ...SIM_CHECK }] }], rateRemaining: 5000 }, this.at(m - 1), { repo: SIM_REPO });
  }

  /** You closed it on GitHub without merging: the task stays done, its work never landed. */
  private closedOnGitHub(id: string, m: number) {
    const pr = D.livePr(this.task(id))!;
    const number = pr.number!;
    this.s = D.reportObservations(this.s, this.observation(id, m, "CLOSED", number), this.at(m), { requested: [{ taskId: id, number }], repo: SIM_REPO });
    const t = this.task(id);
    if (t.integration?.pr?.phase !== "closed" || t.integration.landed) throw new Error(`demo: ${id}'s pull request was not closed`);
  }

  /** The finished task's final commit becomes a pull-request head (what integration does in pull-request mode). */
  private prHead(id: string, m: number, change: CodeChange) {
    this.s = D.reportPrHead(this.s, id, { n: 1, sha: change.sha, baseSha: SIM_BASE, simulated: true, changed: { files: change.files, additions: change.additions, deletions: change.deletions, paths: [...change.paths], protectedHits: [], workflowHits: [] } }, this.at(m));
    const pr = D.livePr(this.task(id));
    if (pr?.phase !== "built") throw new Error(`demo: ${id}'s pull request was not built`);
    if (!pr.review.ok) throw new Error(`demo: ${id}'s review does not count: ${pr.review.reason}`);
  }

  /** Publish (intent, then the result), then one observation: open, checks passed, held for you. */
  private openPr(id: string, m: number, number: number) {
    const op = this.prOp(id, "publish");
    const begun = D.beginPrOp(this.s, op, this.at(m));
    if (!begun.started) throw new Error(`demo: publishing ${id} did not start`);
    this.s = D.reportPrOp(begun.state, { op, published: { number, url: `simulated://pr/${number}` } }, this.at(m - 0.05));
    this.s = D.reportObservations(this.s, this.observation(id, m - 0.2, "OPEN", number), this.at(m - 0.2), { requested: [{ taskId: id, number }], repo: SIM_REPO });
    const pr = D.livePr(this.task(id));
    if (pr?.phase !== "open" || pr.number !== number || pr.attention) throw new Error(`demo: ${id}'s pull request is not open and clean (${pr?.attention?.message ?? pr?.phase})`);
  }

  /** You chose Merge; the app merged it at your request; it landed and is listed for review. */
  private mergePr(id: string, requestM: number, mergeM: number) {
    const pr = D.livePr(this.task(id))!;
    const number = pr.number!;
    this.s = D.requestPrMerge(this.s, id, pr.headSha, this.at(requestM));
    this.preflight(mergeM + 0.5); // the repository check is repeated every six hours; the gate wants a recent one
    this.s = D.reportObservations(this.s, this.observation(id, mergeM + 0.1, "OPEN", number), this.at(mergeM + 0.1), { requested: [{ taskId: id, number }], repo: SIM_REPO });
    const op = this.prOp(id, "merge");
    const begun = D.beginPrOp(this.s, op, this.at(mergeM));
    if (!begun.started) throw new Error(`demo: merging ${id} did not start (${JSON.stringify(D.prGate(this.s, this.task(id), Date.parse(this.at(mergeM)), { byUser: true }).items.filter((i) => !i.ok))})`);
    this.s = D.reportPrOp(begun.state, { op, observed: this.observation(id, mergeM - 0.05, "MERGED", number) }, this.at(mergeM - 0.05));
    const t = this.task(id);
    if (t.integration?.pr?.phase !== "merged" || !t.integration.landed) throw new Error(`demo: ${id} did not land`);
    if (t.integration.landed.flags.length) throw new Error(`demo: ${id} landed with flags ${t.integration.landed.flags.join(", ")}`);
    // The base branch's check after the merge.
    this.s = D.reportObservations(this.s, { at: this.at(mergeM - 1), prs: [], commits: [{ oid: t.integration.landed.commit, checks: [{ ...SIM_CHECK }] }], rateRemaining: 5000 }, this.at(mergeM - 1), { repo: SIM_REPO });
  }

  // ---------- the lead ----------

  private say(text: string, m: number): string {
    this.s = M.postMessage(this.s, text, this.at(m));
    return this.s.conversation[this.s.conversation.length - 1].id;
  }

  /** A simulated lead reply: the real run record, completed with the flag the fake runtime's replies carry. */
  private leadReplies(startM: number, endM: number, reply: string, steer?: Record<string, unknown>) {
    const r = M.startLeadRun(this.s, { provider: CLAUDE.provider, model: CLAUDE.model, trigger: "message" }, this.at(startM));
    this.s = M.completeLeadRun(r.state, r.runId, { reply, proposals: [], ...(steer ? { steer } : {}) }, this.at(endM), { simulated: true });
    const run = this.s.leadRuns.find((x) => x.id === r.runId)!;
    if (run.outcome !== "completed") throw new Error(`demo: lead run ${r.runId} is ${run.outcome}`);
    return r.runId;
  }

  // ---------- the story ----------

  build() {
    this.settings();
    this.history(); // ORC-018 §7: WT-101…WT-124 and two fixes sent back, settled 30 to 9 days ago
    this.specs();
    this.offlineMapsTileCache(); // WT-001: failed check → finding → repair → merged, in Review
    this.largerTapTargets(); // WT-008: merged, reviewed
    this.tripSharingGoal(); // WT-004 and its children; WT-004.1 merged and reviewed
    this.fasterTrailSearch(); // WT-011: the best-of experiment, merged, in Review
    const fix = this.bugReproduced(); // WT-009: reproduced; the fix starts
    this.voiceOver(); // WT-007: UX review raised a finding that needs you; the code review runs at start
    this.pauseFix(fix); // WT-009: paused by you, acknowledged by the runtime
    this.packingListAndConversation(); // WT-005's pull request, the steering exchange, WT-004.3's options
    // The repository and sandbox checks are recent, so nothing is re-probed at start.
    this.preflight(30);
    this.checksReady(30);
    this.s = D.reportBaseFetched(this.s, SIM_BASE, this.at(5));
    return this.s;
  }

  private specs() {
    const T = 4300;
    this.addTask(
      "WT-001",
      5,
      spec({
        title: "Cache trail map tiles for offline use",
        area: "Offline maps",
        whyNow: "At most trailheads the map shows a blank grid: tiles are fetched on demand and there is no signal.",
        outcome: "Tiles a person has looked at stay on the phone and show without a connection.",
        benefit: "The map works where hikes start.",
        scopeIncluded: ["A tile cache on disk", "Eviction when the cache is full"],
        scopeExcluded: ["Downloading an area in advance (WT-003)"],
        options: [
          opt("A", "On-disk cache with a size cap", "Keep every tile the map shows, up to 200 MB, evicting the least recently used", "Works without a decision from the person", "Small", "A full cache evicts tiles still wanted", "High"),
          opt("B", "Unbounded cache", "Keep every tile", "Nothing is ever lost", "Small", "Fills the phone", "High"),
        ],
        rationale: "A cap keeps the phone usable; least-recently-used eviction keeps the current area.",
        acceptance: ["A tile shown once shows again with no connection", "The cache never exceeds 200 MB", "The oldest-used tile is evicted first"],
        validationPlan: "Unit tests for the cache; a manual flight-mode walk-through.",
      }),
      "change",
      T,
    );
    this.addTask(
      "WT-002",
      1,
      spec({
        title: "Show a clear offline state on the map",
        area: "Offline maps",
        whyNow: "With no signal the map looks the same as online, so nobody knows whether it is current.",
        outcome: "The map says when it is offline and how old the cached tiles are.",
        benefit: "You always know whether the map is current.",
        scopeIncluded: ["An offline banner with the age of the cache"],
        scopeExcluded: ["Fetching anything while offline"],
        options: [
          opt("A", "Banner with the cache age", "A small banner at the top of the map while offline", "Clear and quiet", "Small", "Covers a little of the map", "High"),
          opt("B", "Grey the map", "Desaturate the map while offline", "Very visible", "Small", "Harder to read at a trailhead", "High"),
        ],
        rationale: "A banner says what is wrong without making the map worse to read.",
        acceptance: ["Banner shows within two seconds of losing the connection", "It names the age of the cache", "It hides when the connection returns"],
        validationPlan: "Component tests; a manual flight-mode check.",
      }),
      "change",
      T,
    );
    this.addTask(
      "WT-003",
      4,
      spec({
        title: "Download a trail area before you leave",
        area: "Offline maps",
        whyNow: "A cache only holds what someone looked at; the first visit to a trail happens with no signal.",
        outcome: "A trail's map can be saved on the phone from home, with its size shown first.",
        benefit: "The whole trail works offline, not only the parts someone scrolled over.",
        scopeIncluded: ["A download button on the trail page", "Progress and a size estimate"],
        scopeExcluded: ["Downloading whole regions"],
        options: [
          opt("A", "Download by trail", "One button on the trail page saves the tiles 20 km around the route", "One decision: this trail", "Medium", "Long trails are large downloads", "High"),
          opt("B", "Download by map rectangle", "Draw a rectangle on the map to save", "Full control over what is saved", "Medium", "Fiddly on a phone; easy to miss part of the route", "High"),
        ],
        rationale: "People plan a trail, not a rectangle; the trail page is where the decision happens.",
        uncertainty: "Whether 20 km around the route is the right margin; the research note says it felt right once.",
        acceptance: ["A trail's tiles download with progress", "The size is shown before the download starts", "The trail shows offline afterwards"],
        validationPlan: "Download a trail at home; walk it in flight mode.",
        effort: "medium",
      }),
      "feature",
      T,
    );
    this.addTask(
      "WT-004",
      2,
      spec({
        title: "Share a trip plan with friends",
        area: "Trip sharing",
        whyNow: "Plans live in three chats and nobody knows who is coming until the parking lot.",
        outcome: "One trip page that friends can open, answer and join without an account.",
        benefit: "One place for the plan and the people.",
        scopeIncluded: ["Invite links", "Who is coming", "Joining without an account"],
        scopeExcluded: ["Chat", "Notifications"],
        options: [
          opt("A", "Links and a guest list", "Shareable links, an attendee list and guest access, built as separate parts", "Each part ships on its own", "Large", "Three parts to coordinate", "Medium"),
          opt("B", "Accounts for everyone", "Friends sign up and are invited by email", "Known identities", "Large", "Nobody signs up for one hike", "Medium"),
        ],
        rationale: "The research note is clear: friends will not create an account to see one hike.",
        acceptance: ["A friend with the link sees the plan", "The organiser sees who is coming"],
        validationPlan: "Each part has its own acceptance; the goal is checked once all have landed.",
        effort: "large",
      }),
      "goal",
      T,
    );
    this.addTask(
      "WT-005",
      5,
      spec({
        title: "Suggest a packing list from trail length and weather",
        area: "Packing lists",
        whyNow: "Two stoves and no first-aid kit: packing is decided from memory.",
        outcome: "A new trip starts with a packing list that fits its length and the forecast.",
        benefit: "The obvious things are on the list before anyone thinks of them.",
        scopeIncluded: ["Rules from trail length and the forecast", "A list the organiser can edit"],
        scopeExcluded: ["Shared check-off (WT-006)"],
        options: [
          opt("A", "Rules from length and forecast", "A fixed set of rules: distance, elevation, rain, cold", "Predictable and explainable", "Small", "Rules miss unusual trips", "High"),
          opt("B", "Learn from past trips", "Suggest what the group packed before", "Fits the group", "Large", "Nothing to learn from yet", "Medium"),
        ],
        rationale: "There is no history to learn from; rules work from the first trip.",
        acceptance: ["A 6 km dry trip suggests a short list", "An 18 km trip in rain adds shell, spare layer and more water", "The organiser can remove or add items"],
        validationPlan: "Rule tests for short, long, wet and cold trips.",
      }),
      "change",
      T,
    );
    this.addTask(
      "WT-006",
      6,
      spec({
        title: "Check items off together",
        area: "Packing lists",
        whyNow: "A list one person owns does not stop two people bringing stoves.",
        outcome: "Everyone on the trip can tick items off the same list and see who took what.",
        benefit: "The group packs once, together.",
        scopeIncluded: ["Shared check-off with the name of who took the item"],
        scopeExcluded: ["Assigning items to people in advance"],
        options: [
          opt("A", "Live shared check-off", "Check-offs sync through the trip record", "Everyone sees the same list", "Medium", "Conflicting edits", "High"),
          opt("B", "Per-person copies", "Each person has their own list", "No sync", "Small", "Does not solve double packing", "High"),
        ],
        rationale: "The point is one list for the group.",
        acceptance: ["A check-off shows for everyone within seconds", "Two people checking at once both see every change"],
        validationPlan: "Two-device manual test; sync unit tests.",
      }),
      "change",
      T,
    );
    this.addTask(
      "WT-007",
      3,
      spec({
        title: "Make the trail map readable with VoiceOver",
        area: "Accessibility",
        whyNow: "A friend who uses VoiceOver hears \"pin 1, pin 2\" and unlabelled numbers.",
        outcome: "VoiceOver reads the trail name, distance, elevation and the next waypoint from the map.",
        benefit: "The map works for everyone in the group.",
        scopeIncluded: ["Accessibility labels for pins and distances", "A rotor for waypoints"],
        scopeExcluded: ["Audio navigation"],
        options: [
          opt("A", "Labels and a waypoint rotor", "Label every map element; add a rotor that steps through waypoints", "Uses what VoiceOver users already know", "Medium", "Dense maps read slowly", "High"),
          opt("B", "A separate text view", "A list view of the trail instead of the map", "Simple", "Medium", "Two screens to keep in step", "Medium"),
        ],
        rationale: "Making the map itself readable keeps one screen for everyone.",
        acceptance: ["Each pin reads its trail name and distance", "The waypoint rotor steps through the route in order"],
        validationPlan: "A manual VoiceOver pass on a long trail; label tests.",
        effort: "medium",
      }),
      "feature",
      T,
    );
    this.addTask(
      "WT-008",
      7,
      spec({
        title: "Larger tap targets on the trip page",
        area: "Accessibility",
        whyNow: "Several controls on the trip page are under 30 pt; with gloves on they are missed.",
        outcome: "Every control on the trip page is at least 44 pt with 8 pt between controls.",
        benefit: "Usable with cold hands and gloves.",
        options: [
          opt("A", "Resize in place", "Enlarge controls and spacing without changing the layout", "Small, safe", "Small", "Some rows grow taller", "High"),
          opt("B", "Redesign the page", "A new layout with fewer controls", "Cleaner", "Medium", "Out of proportion to the problem", "Medium"),
        ],
        rationale: "A size fix does not need a redesign.",
        acceptance: ["No control under 44 pt", "The page still fits the largest Dynamic Type size"],
        validationPlan: "Layout tests at three text sizes.",
      }),
      "change",
      T,
    );
    this.addTask(
      "WT-009",
      8,
      spec({
        title: "Never lose a trip plan if the app closes mid-edit",
        area: "Reliability",
        whyNow: "A plan being edited is lost when the system closes the app; it happened twice while hiking.",
        outcome: "An interrupted edit is restored when the app opens again.",
        benefit: "Nothing typed at a trailhead is lost.",
        options: [
          opt("A", "Save a draft on every edit", "Write the draft to local storage on each change; offer to restore on launch", "Nothing is lost", "Small", "Stale drafts need clearing", "High"),
          opt("B", "Autosave the plan itself", "Save the real plan on every keystroke", "No restore step", "Small", "Half-typed plans are shared", "Medium"),
        ],
        rationale: "A draft is restored, not shared: half-typed plans never reach friends.",
        acceptance: ["Killing the app mid-edit keeps the draft", "The draft is cleared after a save"],
        validationPlan: "Reproduce first (kill during an edit), then verify the reproduction passes.",
      }),
      "bugfix",
      T,
    );
    this.addTask(
      "WT-010",
      9,
      spec({
        title: "Weather alerts for the trip day",
        area: "Reliability",
        whyNow: "Groups check the forecast in three apps the night before.",
        outcome: "The trip page shows a weather alert for its day when the forecast calls for one.",
        benefit: "One place to see whether the day is still on.",
        options: [
          opt("A", "Alert from the forecast service", "Fetch the forecast once a day and show an alert on the trip page", "Simple", "Small", "Needs a connection", "High"),
          opt("B", "Push notifications", "Notify everyone when the forecast changes", "Proactive", "Medium", "Permissions; noise", "Medium"),
        ],
        rationale: "Start with the page; notifications can follow.",
        acceptance: ["An alert shows for a trip day with a warning", "It hides when the forecast is stale"],
        validationPlan: "Tests with recorded forecasts.",
      }),
      "change",
      T,
    );
    this.event(T, "lead", "spec", "Published specs for WT-001…WT-010 from vision r1");
    this.promote(["WT-001", "WT-002", "WT-003", "WT-004", "WT-005", "WT-006", "WT-007", "WT-008", "WT-009", "WT-010"], 4299);
    // Your own experiment: two implementations compared before review.
    this.addTask(
      "WT-011",
      10,
      spec({
        title: "Faster trail search",
        area: "Reliability",
        whyNow: "Searching 5,000 trails takes a visible moment on an older phone.",
        outcome: "Search results appear as you type.",
        benefit: "Finding a trail is instant.",
        options: [opt("A", "Index the trails", "Build an index at startup and search it", "Fast", "Small", "Which index is a judgment call", "High"), opt("B", "Defer", "Leave search as it is", "No cost", "None", "Stays slow", "High")],
        rationale: "Two agents try an index each; the better one goes forward.",
        acceptance: ["Results for 5,000 trails within 50 ms"],
        validationPlan: "A timed test on the 5,000-trail fixture.",
      }),
      "change-best-of-two",
      4250,
      { author: "user", chosenBy: "user" },
    );
    this.event(4250, "user", "spec", "Created WT-011: Faster trail search (Change, best of two implementations pattern, experimental)", "WT-011");
    this.promote(["WT-011"], 4249);
  }

  /** WT-001: the check fails, becomes a finding, is repaired; the loop runs once more clean; merged at your request; in Review. */
  private offlineMapsTileCache() {
    const id = "WT-001";
    const first = this.change(id, "S1", 4200, 4140, { sha: fakeSha("WT-001 S1"), paths: ["src/map/tileCache.ts", "src/map/tileCache.test.ts", "src/map/MapView.tsx", "src/map/tiles.ts", "src/storage/disk.ts", "src/storage/disk.test.ts"], files: 6, additions: 214, deletions: 18 }, "Tile cache with a 200 MB cap and least-recently-used eviction (+214 −18, 6 files)", "Eviction runs when the cache passes the cap; the cap is a constant for now.");
    this.checks(id, "C1", 4139, 4137, [{ id: "test", excerpt: "FAIL  src/map/tileCache.test.ts > tile-cache evicts oldest first\nAssertionError: expected 3, got 4\n ❯ src/map/tileCache.test.ts:48:31\n\n Test Files  1 failed | 11 passed (12)\n      Tests  1 failed | 141 passed (142)" }]);
    this.review(id, "S2", 4136, 4110, first, "1 finding: eviction runs on the main thread. The failing test is the cache's eviction order; the repair should take both.", [
      finding("F1", { severity: "warning", action: "auto-fix", title: "Tile eviction runs on the main thread", detail: "Move the eviction pass to the background queue; on a 200 MB cache it blocks the map for about 300 ms.", file: "src/map/tileCache.ts", line: 112 }),
    ]);
    const repaired = this.change(id, "S3", 4109, 4080, { sha: fakeSha("WT-001 S3"), paths: ["src/map/tileCache.ts", "src/map/tileCache.test.ts"], files: 2, additions: 31, deletions: 9 }, "Evicts the least recently used tile first and runs eviction off the main thread (+31 −9, 2 files)");
    // The loop's second round, appended by the service when S3 completed.
    this.checks(id, "C1-i2", 4079, 4077);
    this.review(id, "S2-i2", 4076, 4060, repaired, "No findings: the eviction order is covered by the test, and eviction runs off the main thread.");
    this.skip(id, "S3-i2", 4059);
    this.checks(id, "C2", 4058, 4056);
    this.output(id, "S4", 4055, 4045, "The tile cache holds 200 MB and evicts least recently used first; checks passed on the final change.");
    this.prHead(id, 4044, repaired);
    this.openPr(id, 4043, 991);
    this.mergePr(id, 3900, 3899);
  }

  /** WT-008: a plain change, merged at your request, reviewed. */
  private largerTapTargets() {
    const id = "WT-008";
    const change = this.change(id, "S1", 3800, 3740, { sha: fakeSha("WT-008 S1"), paths: ["src/trip/TripPage.tsx", "src/trip/Controls.tsx", "src/trip/TripPage.test.tsx"], files: 3, additions: 54, deletions: 21 }, "Trip page controls are at least 44 pt tall with 8 pt between them (+54 −21, 3 files)", "Checked with the largest Dynamic Type size; nothing clips.");
    this.checks(id, "C1", 3739, 3737);
    this.review(id, "S2", 3736, 3715, change, "No findings: the targets meet the platform minimum and the layout tests cover three text sizes.");
    this.skip(id, "S3", 3714);
    this.checks(id, "C2", 3713, 3711);
    this.output(id, "S4", 3710, 3700, "Tap targets on the trip page meet the 44 pt minimum; checks passed on the final change.");
    this.prHead(id, 3699, change);
    this.openPr(id, 3698, 994);
    this.mergePr(id, 3600, 3599);
    this.s = D.markLandedReviewed(this.s, [id], true, this.at(3500));
  }

  /** WT-004: the goal's plan became three child tasks; WT-004.1 landed and is reviewed; .2 and .3 wait. */
  private tripSharingGoal() {
    const id = "WT-004";
    const script = DEMO_SCRIPT[id];
    this.output(id, "S1", 3000, 2950, script.outputs!.plan, { items: structuredClone(script.breakdown!.S1) });
    for (const c of ["WT-004.1", "WT-004.2", "WT-004.3"]) this.task(c); // created by the breakdown
    // You asked Claude to write the trip-sharing parts and Codex to review them (the project's defaults are the other way round).
    for (const c of ["WT-004.1", "WT-004.2"]) {
      this.s = M.setTaskRoleOverride(this.s, c, "coder", { ...CLAUDE }, this.at(2941));
      this.s = M.setTaskRoleOverride(this.s, c, "code_reviewer", { ...CODEX }, this.at(2941));
    }
    this.s = M.startHeldTask(this.s, "WT-004.1", this.at(2940));
    this.promote(["WT-004.1"], 2939);
    const child = "WT-004.1";
    const change = this.change(child, "S1", 2900, 2840, { sha: fakeSha("WT-004.1 S1"), paths: ["src/trip/invite.ts", "src/trip/invite.test.ts", "src/trip/TripPage.tsx", "src/server/links.ts"], files: 4, additions: 132, deletions: 4 }, "Signed invite links that expire after 7 days (+132 −4, 4 files)", "Links are signed with the trip key; expiry is checked when the link is opened.");
    this.checks(child, "C1", 2839, 2837);
    this.review(child, "S2", 2836, 2815, change, "No findings: the signature and the expiry are covered by tests, and the link format is documented.");
    this.skip(child, "S3", 2814);
    this.checks(child, "C2", 2813, 2811);
    this.output(child, "S4", 2810, 2800, "A link opens the trip and an expired link says so; checks passed on the final change.");
    this.prHead(child, 2799, change);
    this.openPr(child, 2798, 997);
    this.mergePr(child, 2700, 2699);
    this.s = D.markLandedReviewed(this.s, [child], true, this.at(2600));
  }

  /** WT-011: two implementations, one per provider; the comparison chose Claude's; merged at your request; in Review. */
  private fasterTrailSearch() {
    const id = "WT-011";
    // The user chose Codex as the reviewer, since Claude's candidate was likely to win.
    this.s = M.setTaskRoleOverride(this.s, id, "code_reviewer", { ...CODEX }, this.at(2501));
    this.expandBestOf(id, "S1", 2500);
    // Both candidates start together; Codex's finishes first.
    const claude: CodeChange = { sha: fakeSha("WT-011 S1"), paths: ["src/search/index.ts", "src/search/search.ts", "src/search/search.test.ts"], files: 3, additions: 84, deletions: 18 };
    const codex: CodeChange = { sha: fakeSha("WT-011 S1-c2"), paths: ["src/search/index.ts", "src/search/regionIndex.ts", "src/search/search.ts", "src/search/search.test.ts"], files: 4, additions: 121, deletions: 18 };
    const runClaude = this.dispatch(id, "S1", 2500);
    const runCodex = this.dispatch(id, "S1-c2", 2500);
    this.complete(runCodex, 2440, [
      { name: "change", summary: "Trail search with two indexes: one by name, one by region (+121 −18, 4 files)", ref: `${codex.sha.slice(0, 12)} on orchestration/${DEMO_PROJECT_ID}/${id}/S1-c2/${runCodex}` },
      { name: "handoff", summary: "Two indexes built at startup; the region index answers map searches too." },
    ]);
    this.complete(runClaude, 2430, [
      { name: "change", summary: "Trail search over one prefix index on normalised names (+84 −18, 3 files)", ref: `${claude.sha.slice(0, 12)} on orchestration/${DEMO_PROJECT_ID}/${id}/S1/${runClaude}` },
      { name: "handoff", summary: "One index built at startup; diacritics and case are normalised once." },
    ]);
    this.output(id, "S2", 2429, 2410, "Both pass; S1 is simpler (one index instead of two) and 30 ms faster on the 5,000-trail fixture (simulated).", {}, { chosen: "S1" });
    this.checks(id, "C1", 2409, 2407);
    this.review(id, "S3", 2406, 2385, claude, "No findings: the index is rebuilt when trails change, and the timing test guards the 50 ms budget.");
    this.skip(id, "S4", 2384);
    this.checks(id, "C2", 2383, 2381);
    this.output(id, "S5", 2380, 2370, "Search over 5,000 trails answers within 50 ms; checks passed on the final change.");
    this.prHead(id, 2369, claude);
    this.openPr(id, 2368, 999);
    this.mergePr(id, 2300, 2299);
  }

  /** The parallel step becomes its candidates the way dispatch expands it (one per provider), recorded as a pipeline revision. */
  private expandBestOf(id: string, stepId: string, m: number) {
    const t = this.task(id);
    const st = this.step(id, stepId);
    const p = st.parallel;
    if (!p || p.mode !== "best-of") throw new Error(`demo: ${id} ${stepId} is not a best-of step`);
    const ids = [st.id, ...Array.from({ length: p.count - 1 }, (_, i) => `${st.id}-c${i + 2}`)];
    const assign = (i: number): ModelSelection | null => {
      const pv = p.providers?.length ? p.providers[i % p.providers.length] : undefined;
      if (!pv || st.selection?.provider === pv) return st.selection;
      return { provider: pv, model: "auto" };
    };
    st.copyOf = st.id;
    if (p.providers?.length && !st.selection) st.selection = assign(0);
    const copies: Step[] = ids.slice(1).map((cid, i) => {
      const c: Step = { ...structuredClone(st), id: cid, purpose: `${st.purpose} (copy ${i + 2} of ${p.count})`, selection: assign(i + 1), revision: M.nextRevisionFor(this.s, t, cid), state: "pending", copyOf: st.id };
      delete c.parallel;
      return c;
    });
    t.steps.splice(t.steps.indexOf(st) + 1, 0, ...copies);
    for (const d of t.steps) {
      if (ids.includes(d.id)) continue;
      if (d.dependsOn.includes(st.id)) d.dependsOn = [...new Set([...d.dependsOn, ...ids.slice(1)])];
      const addCopies = (refs: Step["inputs"] | undefined) => refs?.flatMap((r) => (r.step === st.id ? [r, ...ids.slice(1).map((cid) => ({ step: cid, output: r.output }))] : [r]));
      d.inputs = addCopies(d.inputs)!;
      if (d.runIf) d.runIf = addCopies(d.runIf);
    }
    t.pipelineRev += 1;
    t.pipelineHistory.push({ rev: t.pipelineRev, at: this.at(m), author: "lead", reason: `${st.id} runs as ${p.count} parallel candidates (best of)`, steps: t.steps.map(toDef) });
    this.event(m, "lead", "pipeline", `Pipeline r${t.pipelineRev}: ${st.id} runs as ${p.count} parallel candidates (best of)`, id);
  }

  /** WT-007: designed and implemented; the UX review asks you about units; the code review is next (it starts when the service does). */
  private voiceOver() {
    const id = "WT-007";
    this.output(id, "S1", 400, 350, DEMO_SCRIPT[id].outputs!.design);
    this.change(id, "S2", 349, 260, { sha: fakeSha("WT-007 S2"), paths: ["src/map/Pins.tsx", "src/map/MapView.tsx", "src/map/a11y.ts", "src/map/a11y.test.ts", "src/map/WaypointRotor.tsx", "src/trail/distance.ts"], files: 6, additions: 142, deletions: 11 }, DEMO_SCRIPT[id].outputs!["S2.change"], DEMO_SCRIPT[id].outputs!["S2.handoff"]);
    this.checks(id, "C1", 259, 257);
    this.review(id, "S4", 256, 230, undefined, "1 finding needs a decision: the unit distances are read in.", [
      finding("F1", {
        severity: "warning",
        action: "ask-user",
        title: "Read distances in miles or kilometres?",
        detail: "Distances are read in the phone's unit setting. The research note says the group is split; a fixed unit may be what some expect.",
        why: "It changes what every VoiceOver user hears, and it is a product choice, not a defect. Recommendation: follow the phone's region setting.",
        file: "src/trail/distance.ts",
        line: 12,
      }),
    ]);
    const d = this.s.decisions.find((x) => x.taskId === id && x.status === "open");
    if (!d || d.routedTo !== "user") throw new Error("demo: WT-007's finding did not become a decision for you");
  }

  /** WT-009: the defect was reproduced and the fix started. */
  private bugReproduced(): string {
    const id = "WT-009";
    this.output(id, "S1", 500, 450, DEMO_SCRIPT[id].outputs!.reproduction);
    return this.dispatch(id, "S2", 449);
  }

  /** WT-009: the fix was running when you paused it; the runtime acknowledged. */
  private pauseFix(run: string) {
    const id = "WT-009";
    this.s = M.pauseTask(this.s, id, this.at(125));
    this.event(125, "user", "control", "Paused: holding until offline maps lands", id);
    this.s = M.acknowledgeStop(this.s, run, this.at(120));
    const a = this.s.attempts.find((x) => x.id === run)!;
    if (a.outcome !== "stopped" || this.step(id, "S2").state !== "paused") throw new Error("demo: WT-009's pause was not acknowledged");
  }

  /** WT-005 finishes and its pull request is built (the service publishes it at start); meanwhile the steering exchange and WT-004.3's options. */
  private packingListAndConversation() {
    const id = "WT-005";
    const change = this.change(id, "S1", 110, 60, { sha: fakeSha("WT-005 S1"), paths: ["src/packing/rules.ts", "src/packing/rules.test.ts", "src/packing/suggest.ts", "src/packing/suggest.test.ts", "src/trip/NewTrip.tsx", "src/trip/weather.ts"], files: 6, additions: 167, deletions: 12 }, "Suggests a packing list from the trail length and the forecast for the trip day (+167 −12, 6 files)", "Rules live in packing/rules.ts; the forecast is the one already fetched for the trip.");
    this.checks(id, "C1", 59, 57);
    const review = this.dispatch(id, "S2", 56, { scope: { from: SIM_BASE, to: change.sha, paths: [...change.paths], total: change.paths.length } });
    // WT-004.3: the lead added the second option and asked you to choose, because the choice changes what data is kept.
    this.revisePackingDecision();
    // The steering exchange: offline maps ahead of sharing; one task deferred, with Undo.
    this.say("Most of our hikes have no signal at the trailhead. Can we put offline maps ahead of sharing?", 47);
    this.leadReplies(47, 45, "Done. Offline maps is now the focus. I deferred “Weather alerts for the trip day”, since it needs a connection anyway. Everything else keeps its order.", {
      focus: "Offline maps first: the map must work with no signal.",
      reason: "Most trailheads have no signal, so the map must work before sharing matters.",
      tasks: [{ id: "WT-010", defer: true, why: "It needs a connection anyway, and offline maps comes first." }],
    });
    const set = this.s.steering[0];
    if (!set || !set.changes.some((c) => c.kind === "focus" && c.status === "applied") || !set.changes.some((c) => c.kind === "defer" && c.taskId === "WT-010" && c.status === "applied")) throw new Error("demo: the steering exchange was not applied");
    this.complete(review, 35, [{ name: "findings", summary: "No findings: the rules are covered by tests for short, long, wet and cold trips.", findings: [], reviewedPaths: [...change.paths] }]);
    // You released the second trip-sharing part; it starts when a slot frees.
    this.s = M.startHeldTask(this.s, "WT-004.2", this.at(35));
    this.promote(["WT-004.2"], 34.9);
    this.skip(id, "S3", 34);
    this.checks(id, "C2", 33, 31);
    this.output(id, "S4", 30, 22, "A new trip gets a packing list that fits its length and weather; checks passed on the final change.");
    this.prHead(id, 21, change);
    this.say("Thanks. Keep the VoiceOver work going, though.", 12);
    this.leadReplies(12, 10, "It is still running: Claude is reviewing “Make the trail map readable with VoiceOver”. One finding needs your decision: whether distances are read in miles or kilometres.");
  }

  // ---------- the history (ORC-018 §7) ----------

  /**
   * The earlier tasks, one after another, each in a slot of about twenty hours: created and promoted by the
   * lead, run through its pattern, verified, delivered as a pull request you merged (or closed), and marked
   * reviewed. A send-back from the Review list creates its fix task, which runs in the next slot. Every
   * outcome is `computeOutcome` on the state at settle, as the store records it.
   */
  private history() {
    const first = 30 * DAY + 30;
    const lastStart = 9 * DAY + 360;
    const n = HISTORY.length + HISTORY_SENT_BACK.length;
    const slot = (first - lastStart) / (n - 1);
    let k = 0;
    for (const h of HISTORY) {
      this.historyTask(h, first - k * slot, 20 + k);
      k++;
      for (const sb of HISTORY_SENT_BACK.filter((x) => x.after === h.id)) {
        this.historyFix(sb, first - k * slot);
        k++;
      }
    }
    if (k !== n) throw new Error("demo: a send-back names a task that is not in the history");
  }

  private historyTask(h: HistoryTask, start: number, priority: number) {
    const id = h.id;
    const bug = h.pattern === "bugfix";
    const content = spec({
      title: h.title,
      area: h.area,
      whyNow: h.whyNow,
      outcome: h.outcome,
      benefit: h.benefit,
      options: [opt("A", h.option[0], h.option[1], h.benefit, "Small", bug ? "The fix is narrow; nothing else changes" : "Nothing beyond the change itself", "High"), opt("B", h.alternative[0], h.alternative[1], h.alternative[2], "Medium", h.alternative[3], "High")],
      rationale: h.rationale,
      acceptance: h.acceptance,
      validationPlan: bug ? "Reproduce first; the verification runs the reproduction again." : "Tests for each acceptance criterion; a manual check on a phone.",
    });
    this.addTask(id, priority, content, h.pattern, start, h.olderVersion ? { steps: olderBugfixSteps() } : {});
    this.event(start, "lead", "spec", `Published spec for ${id} from vision r1: ${h.title}`, id);
    this.promote([id], start - 1);
    // You asked Claude to write a few of the cross-reviewed changes; the pattern then has Codex review them.
    if (h.claudeWrites) this.s = M.setTaskRoleOverride(this.s, id, "coder", { ...CLAUDE }, this.at(start - 1.5));
    this.historyPipeline(id, h, start - 2, HISTORY_PR_FROM + HISTORY.indexOf(h));
  }

  /** You sent a landed change back as a fix from the Review list; the fix task (a Bug fix pipeline) runs at once. */
  private historyFix(sb: (typeof HISTORY_SENT_BACK)[number], start: number) {
    const r = D.sendBackLanded(this.s, { taskId: sb.origin, kind: "fix", note: sb.note, holdBeforeStart: false }, this.at(start));
    this.s = r.state;
    const id = r.newId;
    if (id !== `${sb.origin}-F1`) throw new Error(`demo: the fix of ${sb.origin} is ${id}`);
    if (this.task(sb.origin).integration?.landed?.status !== "sent-back") throw new Error(`demo: ${sb.origin} was not sent back`);
    this.promote([id], start - 1);
    this.historyPipeline(id, sb.fix, start - 2, HISTORY_PR_FROM + HISTORY.length + HISTORY_SENT_BACK.indexOf(sb));
  }

  /**
   * One task through its pattern. The steps are found by role, so Change, its cross-reviewed variant and
   * Bug fix (both versions) run through the same code: the implementation (a reproduction first for a bug),
   * the checks, then review rounds (each repair appends the loop's next round, as the service does) until
   * the review is clean, the final checks, the verification, and the delivery.
   */
  private historyPipeline(id: string, w: HistoryFix | HistoryTask, start: number, prNumber: number) {
    const h = w as Partial<HistoryTask> & HistoryFix;
    const rnd = seeded(seedOf(id));
    const between = (lo: number, hi: number) => Math.round((lo + (hi - lo) * rnd()) * 10) / 10;
    const bug = this.task(id).pattern.id === "bugfix";
    // Cross-review runs a little longer: the reviewer reads work from the other provider's conventions.
    const slow = this.task(id).pattern.id === "change-cross-review" ? 1.15 : 1;
    const tokens = (lo: [number, number], hi: [number, number]): Tokens => ({ input: Math.round(between(lo[0], lo[1]) / 100) * 100, output: Math.round(between(hi[0], hi[1]) / 100) * 100 });
    const codeChange = (label: string, paths: string[], size: "large" | "small"): CodeChange => {
      const additions = Math.round(size === "large" ? between(40, 220) : between(6, 40));
      return { sha: fakeSha(label), paths: [...paths], files: paths.length, additions, deletions: Math.round(additions * between(0.05, 0.35)) };
    };
    const sized = (text: string, c: CodeChange) => `${text} (+${c.additions} −${c.deletions}, ${c.files} file${c.files === 1 ? "" : "s"})`;

    const t = this.task(id);
    const impl = t.steps.filter((st) => st.role === "coder" && !st.runIf?.length);
    const c1 = t.steps.find((st) => st.role === "checks" && st.checks?.onFail === "findings");
    const rev = t.steps.find((st) => st.role === "code_reviewer");
    const rep = t.steps.find((st) => st.role === "coder" && !!st.runIf?.length);
    const c2 = t.steps.find((st) => st.role === "checks" && st.checks?.onFail === "block");
    const ver = t.steps.find((st) => st.role === "lead");
    if (!c1 || !rev || !rep || !c2 || !ver || !impl.length) throw new Error(`demo: ${id}'s pattern has not the steps the history expects`);

    // The implementation: a reproduction first for a bug, then the change.
    let m = start;
    let change: CodeChange | undefined;
    for (const st of impl) {
      if (st.outputs[0].kind === "report") {
        if (!h.reproduction) throw new Error(`demo: ${id} needs a reproduction`);
        const d = between(8, 18);
        this.output(id, st.id, m, m - d, h.reproduction, {}, {}, tokens([30_000, 70_000], [1_500, 5_000]));
        m -= d + 1;
      } else {
        const d = (bug ? between(15, 35) : between(45, 90)) * slow;
        const c = codeChange(`${id} ${st.id}`, h.files, "large");
        change = this.change(id, st.id, m, m - d, c, sized(h.change, c), h.handoff || undefined, tokens([60_000, 180_000], [4_000, 16_000]));
        m -= d + 1;
      }
    }
    if (!change) throw new Error(`demo: ${id} made no change`);

    // The project's checks; a failing test becomes an error finding the repair fixes.
    const f = h.failingTest;
    this.checks(id, c1.id, m, m - 2, f ? [{ id: "test", excerpt: `FAIL  ${f.file} > ${f.name}\n${f.message}\n ❯ ${f.file}:${Math.round(between(20, 90))}:${Math.round(between(5, 40))}\n\n Test Files  1 failed | 11 passed (12)\n      Tests  1 failed | 141 passed (142)` }] : []);
    m -= 3;

    // Review rounds. A round with findings is repaired, and the service appends the loop's next round.
    let round = 0;
    let ids = { c1: c1.id, rev: rev.id, rep: rep.id };
    for (;;) {
      const r = h.rounds[round];
      const d = (bug ? between(8, 16) : between(15, 30)) * slow;
      if (!r) {
        const clean = round === 0 ? (slow > 1 ? "the change matches the handoff, and every changed file was read." : "the change does what the spec says, and the tests cover it.") : "the repair answers the earlier round, and every changed file was read.";
        this.review(id, ids.rev, m, m - d, change, `No findings: ${clean}`, [], tokens([50_000, 130_000], [2_000, 8_000]));
        m -= d + 1;
        this.skip(id, ids.rep, m);
        m -= 1;
        break;
      }
      const findings = r.findings.map((x, i) => finding(`F${i + 1}`, { severity: "warning", action: "auto-fix", title: x.title, detail: x.detail, ...(x.file ? { file: x.file } : {}), ...(x.line ? { line: x.line } : {}) }));
      const summary = `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${findings.map((x) => x.title.replace(/\.$/, "")).join("; ")}.${round === 0 && f ? " The failing test is the checks' own finding; the repair should take both." : ""}`;
      this.review(id, ids.rev, m, m - d, change, summary, findings, tokens([50_000, 130_000], [2_000, 8_000]));
      m -= d + 1;
      if (h.cancelled) {
        // You cancelled while the repair ran; the runtime acknowledged the stop. The outcome is the store's capture at cancel.
        const run = this.dispatch(id, ids.rep, m);
        const cm = m - between(6, 14);
        this.s = M.cancelTask(this.s, id, this.at(cm));
        this.event(cm - 0.1, "user", "control", `Cancelled: ${h.cancelled}`, id);
        this.s = M.acknowledgeStop(this.s, run, this.at(cm - 0.5));
        const a = this.s.attempts.find((x) => x.id === run)!;
        if (a.outcome !== "stopped" || this.task(id).lifecycle !== "cancelled") throw new Error(`demo: ${id} was not cancelled and stopped`);
        this.task(id).outcome = computeOutcome(this.s, this.task(id), this.at(cm));
        return;
      }
      const rd = (bug ? between(8, 20) : between(12, 30)) * slow;
      const repaired = codeChange(`${id} ${ids.rep}`, r.paths ?? [h.files[0]], "small");
      change = this.change(id, ids.rep, m, m - rd, repaired, sized(r.repair, repaired), undefined, tokens([40_000, 100_000], [2_000, 8_000]));
      m -= rd + 1;
      round++;
      ids = { c1: `${c1.id}-i${round + 1}`, rev: `${rev.id}-i${round + 1}`, rep: `${rep.id}-i${round + 1}` };
      this.checks(id, ids.c1, m, m - 2);
      m -= 3;
    }

    // Final checks and the lead's verification; the task is done, and the store captures its outcome.
    this.checks(id, c2.id, m, m - 2);
    m -= 3;
    const vd = bug ? between(4, 8) : between(6, 12);
    this.output(id, ver.id, m, m - vd, `${h.verified}; checks passed on the final change.`, {}, {}, tokens([15_000, 40_000], [1_000, 3_000]));
    m -= vd;
    if (this.task(id).lifecycle !== "done") throw new Error(`demo: ${id} is ${this.task(id).lifecycle}, not done`);
    this.task(id).outcome = computeOutcome(this.s, this.task(id), this.at(m));

    // Delivery: the pull request is built and opened; you merge it later (in the app, or on GitHub), or close it.
    m -= 1;
    this.prHead(id, m, change);
    this.preflight(m - 0.5); // the repository check is repeated every six hours; the gate wants a recent one
    this.openPr(id, m - 1, prNumber);
    m -= 1.5;
    const wait = bug ? between(30, 180) : between(60, 480);
    if (h.delivery === "github-close") {
      this.closedOnGitHub(id, m - wait);
      return;
    }
    if (h.delivery === "github-merge") this.mergedOnGitHub(id, m - wait);
    else this.mergePr(id, m - wait, m - wait - 1);
    m -= wait + 2;
    this.s = D.markLandedReviewed(this.s, [id], true, this.at(m - between(30, 240)));
  }

  private revisePackingDecision() {
    const id = "WT-004.3";
    const t = this.task(id);
    const prev = M.currentSpec(t).content;
    const content: SpecContent = {
      ...structuredClone(prev),
      options: [
        opt("A", "Guest link", "A guest link that keeps a name and the link id for 30 days", "One tap to join; the name stays on the attendee list", "Small", "Keeps a name and a link id for 30 days", "High"),
        opt("B", "One-time code", "A six-digit code typed on each visit; nothing is stored", "Nothing is kept", "Small", "Friends re-enter the code on every visit", "High"),
      ],
      recommendedOptionId: "A",
      selectedOptionId: "A",
      rationale: "A guest link is one tap and keeps the attendee list meaningful.",
      uncertainty: "It changes what data is kept: a guest link stores a name and a link id for 30 days; a code stores nothing. Your call before it starts.",
    };
    this.s = M.editSpec(this.s, id, 1, content, "Added the one-time code option and asked you to choose: it changes what data is kept", "lead", this.at(50));
    // The lead's question is a decision for you: it shows as new until you look at it.
    this.task(id).decisionAt = this.at(50);
  }
}

/** The last build, by clock: the state is a pure function of `nowMs`, and tests build the same clock many times. */
let lastBuild: { nowMs: number; state: State } | undefined;

/**
 * The demo state: "Weekend Trips (sample)" at the start of a demo, with no run in flight (the service's
 * scheduler dispatches the three running steps itself). Deterministic for a given clock. With the history
 * (ORC-018 §7) a build takes about a second, so the last one is kept and a copy returned; `cache: false`
 * builds afresh (the determinism test compares the two).
 */
export function buildDemo(nowMs: number = Date.now(), o: { cache?: boolean } = {}): State {
  if (o.cache === false) return new DemoBuilder(nowMs).build();
  if (lastBuild?.nowMs !== nowMs) lastBuild = { nowMs, state: new DemoBuilder(nowMs).build() };
  return structuredClone(lastBuild.state);
}
