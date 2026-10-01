// The demo state, "Weekend Trips (sample)". Separate from `buildSeed()`, the test fixture,
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
//
// Every one of the six flows has a task in the story (WT-012 is the Investigation, WT-013 the
// Design), every finished code task has a security review beside each code review, and WT-004.1's security
// review found what its code review did not, repaired in the loop's second round.

import * as C from "./checks";
import * as D from "./delivery";
import * as M from "./model";
import { DEMO_SCRIPT, type ScriptFinding } from "./demoScript";
import { builtInCatalog, builtInOrInternal, flowRef } from "./flows";
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
  type SpecContent,
  type SpecOption,
  type State,
  type Step,
  type Task,
  type VisionDoc,
} from "./types";

const DEMO_PROJECT_ID = "sample";
export const DEMO_PROJECT_NAME = "Weekend Trips (sample)";
export const DEMO_REPO_PATH = "~/code/weekend-trips";

/** The sample model ids are kept (they are honest); the labels say what they are. */
const DEMO_CATALOG = {
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

/** The story's finding for a step (the fake runtime reports the same words if the step is rerun). */
function scripted(taskId: string, stepId: string, severity: Finding["severity"], action: Finding["action"]): Finding {
  const f: ScriptFinding | undefined = DEMO_SCRIPT[taskId]?.findings?.[stepId];
  if (!f) throw new Error(`demo: the script has no finding for ${taskId} ${stepId}`);
  return finding("F1", { severity, action, ...f });
}

type CodeChange = { sha: string; paths: string[]; files: number; additions: number; deletions: number };

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
    const doc: VisionDoc = { id: "doc-1", name: "trail-research.md", path: "trail-research.md", size: utf8Length(DEMO_DOC_TEXT), hash: DEMO_DOC_HASH, text: true, addedAt: at(4336) };
    const leadRunId = "lead-1001";
    const draftId = `vd-${leadRunId}`;
    const visionText =
      "Weekend Trips helps a small group of friends plan a weekend hike together: pick a trail, share the plan, pack the right things, and keep the map working with no signal. It should feel calm and dependable on a phone at a trailhead. Fewer, clearer screens beat more features.";
    const draftReason = "Drafted from the shaping conversation and the trail research note";
    return {
      version: 18,
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
            at: at(4320),
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
        shapingSince: at(4340),
        checks: structuredClone(DEFAULT_CHECKS),
        triage: { askUserBy: "user" },
        conventions: { include: true },
        prDelivery: structuredClone(DEFAULT_PR_DELIVERY),
        workerEnvironment: { claude: "isolated", codex: "isolated" },
        workerConnections: { claude: [], codex: [] },
        hold: false,
        lastVisitAt: at(240),
        defaultFlowId: "change",
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
          startedAt: at(4334),
          endedAt: at(4332),
          outcome: "completed",
          messageIds: [],
          coverage: { intent: "clear", audience: "clear", problem: "clear", outcome: "clear", scope: "clear", constraints: "clear", risks: "clear", priorities: "clear", material: "clear" },
        },
      ],
      steering: [],
      visionDrafts: [{ id: draftId, at: at(4332), leadRunId, messageIds: [], text: visionText, focus: "Trip sharing first.", reason: draftReason, basedOnVisionRev: 0, status: "accepted", resolvedAt: at(4320), visionRev: 1, simulated: true }],
      decisions: [],
      // The built-in catalog until the server loads the files (it replaces this at start).
      flows: builtInCatalog(),
      notes: [],
      events: [
        { id: "ev-1", at: at(4340), actor: "system", kind: "config", message: `${DEMO_PROJECT_NAME} created; shaping the vision with the lead` },
        { id: "ev-2", at: at(4332), actor: "lead", kind: "vision", message: `Lead run ${leadRunId} drafted the vision (${draftId}) from the shaping conversation: ${draftReason}. It waits for you to accept, edit or dismiss it.` },
        { id: "ev-3", at: at(4320), actor: "user", kind: "vision", message: `Vision r1 by you: accepted the lead's draft ${draftId}` },
      ],
    };
  }

  /** Delivery as pull requests held for you, the project's checks on, and the simulated GitHub checked (all through the real commands). */
  private settings() {
    this.event(4318, "user", "config", "Building started");
    this.s = D.setDeliveryMode(this.s, { mode: "pr" }, this.at(4317));
    this.preflight(4317);
    this.s = D.reportBaseFetched(this.s, SIM_BASE, this.at(4316));
    this.s = C.setChecks(
      this.s,
      { ...structuredClone(DEFAULT_CHECKS), enabled: true, commands: CHECK_COMMANDS.map((c) => ({ ...c, argv: [...c.argv] })) },
      false,
      this.at(4315),
    );
    this.checksReady(4314);
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

  private addTask(id: string, priority: number, content: SpecContent, flowId: string, m: number, o: { author?: "lead" | "user"; chosenBy?: ChosenBy; dependsOn?: string[] } = {}): Task {
    const flow = builtInOrInternal(flowId);
    const defs = structuredClone(flow.steps).map(toDef);
    const author = o.author ?? "lead";
    const ref = flowRef(flow, o.chosenBy ?? author);
    const t: Task = {
      id,
      priority,
      lifecycle: "proposed",
      hold: false,
      holdBeforeStart: false,
      specs: [{ rev: 1, at: this.at(m), author, reason: author === "lead" ? "Initial spec published by lead" : "Created by you", content }],
      steps: instantiate(defs),
      pipelineRev: 1,
      pipelineHistory: [{ rev: 1, at: this.at(m), author, reason: `Created from the ${flow.name} flow`, steps: defs, flow: ref }],
      flow: ref,
      flowSince: 1,
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
          // The demo's runs record their principles like real ones.
          principles: M.runPrinciples(this.s, t, st),
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

  /** The run's result, accepted by the real `reportCompletion` (artifacts, decisions, loops and children follow from it). */
  private complete(attemptId: string, m: number, outputs: M.OutputReport[], run: M.RunReport = {}) {
    this.s = M.reportCompletion(this.s, attemptId, [], this.at(m), outputs, run);
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
  private change(id: string, stepId: string, startM: number, endM: number, change: CodeChange, summary: string, handoff?: string): CodeChange {
    const attemptId = this.dispatch(id, stepId, startM);
    const st = this.step(id, stepId);
    const outputs: M.OutputReport[] = [{ name: "change", summary, ref: `${change.sha.slice(0, 12)} on orchestration/${DEMO_PROJECT_ID}/${id}/${stepId}/${attemptId}` }];
    if (st.outputs.some((o) => o.name === "handoff")) outputs.push({ name: "handoff", summary: handoff ?? "Nothing beyond the change itself." });
    this.complete(attemptId, endM, outputs);
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
  private review(id: string, stepId: string, startM: number, endM: number, change: CodeChange | undefined, summary: string, findings: Finding[] = []) {
    const st = this.step(id, stepId);
    const scope = change && st.role === "code_reviewer" ? { from: SIM_BASE, to: change.sha, paths: [...change.paths], total: change.paths.length } : undefined;
    const attemptId = this.dispatch(id, stepId, startM, scope ? { scope } : {});
    this.complete(attemptId, endM, [{ name: st.outputs[0].name, summary, findings, ...(scope ? { reviewedPaths: [...scope.paths] } : {}) }]);
  }

  /**
   * A code review and the security review beside it, dispatched together. The security review finishes
   * first (`secEndM`) with its findings (clean unless given some), then the code review (`endM`) with its own.
   */
  private reviews(id: string, codeStep: string, secStep: string, startM: number, secEndM: number, endM: number, change: CodeChange | undefined, summary: string, secSummary: string, findings: Finding[] = [], secFindings: Finding[] = []) {
    const st = this.step(id, codeStep);
    const scope = change ? { from: SIM_BASE, to: change.sha, paths: [...change.paths], total: change.paths.length } : undefined;
    const codeRun = this.dispatch(id, codeStep, startM, scope ? { scope } : {});
    const secRun = this.dispatch(id, secStep, startM);
    this.complete(secRun, secEndM, [{ name: "findings", summary: secSummary, findings: secFindings }]);
    this.complete(codeRun, endM, [{ name: st.outputs[0].name, summary, findings, ...(scope ? { reviewedPaths: [...scope.paths] } : {}) }]);
  }

  /** Any other single-output step (a design, a plan, a report, the lead's verification). */
  private output(id: string, stepId: string, startM: number, endM: number, summary: string, extra: Partial<M.OutputReport> = {}, run: M.RunReport = {}) {
    const attemptId = this.dispatch(id, stepId, startM);
    this.complete(attemptId, endM, [{ name: this.step(id, stepId).outputs[0].name, summary, ...extra }], run);
  }

  /** A finished task without a code change: the integration pass records that there is nothing to integrate, as the scheduler does. */
  private nothingToIntegrate(id: string, m: number) {
    const t = this.task(id);
    if (t.lifecycle !== "done" || t.integration?.status !== "pending") throw new Error(`demo: ${id} is not done and waiting for integration`);
    if (this.s.artifacts.some((a) => a.taskId === id && a.kind === "code-change")) throw new Error(`demo: ${id} has a code change to integrate`);
    this.s = M.reportIntegration(this.s, id, { status: "not-needed" }, this.at(m));
  }

  // ---------- pull requests on the simulated GitHub ----------

  private prOp(id: string, kind: "publish" | "merge") {
    const pr = D.livePr(this.task(id));
    if (!pr) throw new Error(`demo: ${id} has no pull request`);
    return { id: `prop-${this.s.seq + 1}`, kind, taskId: id, n: pr.n, headSha: pr.headSha } as const;
  }

  private observation(id: string, m: number, state: "OPEN" | "MERGED", number: number): D.Observations {
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
          ...(merged ? { mergedAt: this.at(m), mergeCommit: `sim-m${number}`, mergedBy: SIM_LOGIN } : {}),
        },
      ],
      commits: [],
      rateRemaining: 5000,
    };
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
    this.specs();
    this.offlineMapsTileCache(); // WT-001: failed check → finding → repair → merged, in Review
    this.largerTapTargets(); // WT-008: merged, reviewed
    this.laterSpecs(); // WT-012 and WT-013: an investigation and a design, published once the first changes had landed
    this.batteryInvestigation(); // WT-012: the evidence, a review of it, the lead's follow-up spec; nothing to integrate
    this.inviteScreenDesign(); // WT-013: the design, a UX finding revised away, the lead's brief; nothing to integrate
    this.tripSharingGoal(); // WT-004 and its children; WT-004.1's security finding repaired, merged and reviewed
    this.fasterTrailSearch(); // WT-011: your own Change task, merged, in Review
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
    // Your own task, on the default flow.
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
        rationale: "One index built at startup is the simplest thing that meets the budget.",
        acceptance: ["Results for 5,000 trails within 50 ms"],
        validationPlan: "A timed test on the 5,000-trail fixture.",
      }),
      "change",
      4250,
      { author: "user", chosenBy: "user" },
    );
    this.event(4250, "user", "spec", "Created WT-011: Faster trail search (Change flow)", "WT-011");
    this.promote(["WT-011"], 4249);
  }

  /** WT-001: the check fails, becomes a finding, is repaired; the loop runs once more clean; merged at your request; in Review. */
  private offlineMapsTileCache() {
    const id = "WT-001";
    const first = this.change(id, "S1", 4200, 4140, { sha: fakeSha("WT-001 S1"), paths: ["src/map/tileCache.ts", "src/map/tileCache.test.ts", "src/map/MapView.tsx", "src/map/tiles.ts", "src/storage/disk.ts", "src/storage/disk.test.ts"], files: 6, additions: 214, deletions: 18 }, "Tile cache with a 200 MB cap and least-recently-used eviction (+214 −18, 6 files)", "Eviction runs when the cache passes the cap; the cap is a constant for now.");
    this.checks(id, "C1", 4139, 4137, [{ id: "test", excerpt: "FAIL  src/map/tileCache.test.ts > tile-cache evicts oldest first\nAssertionError: expected 3, got 4\n ❯ src/map/tileCache.test.ts:48:31\n\n Test Files  1 failed | 11 passed (12)\n      Tests  1 failed | 141 passed (142)" }]);
    this.reviews(id, "S2", "SR1", 4136, 4112, 4110, first, "1 finding: eviction runs on the main thread. The failing test is the cache's eviction order; the repair should take both.", "No security findings: the cache writes only under its own directory, and tile URLs are not logged.", [
      finding("F1", { severity: "warning", action: "auto-fix", title: "Tile eviction runs on the main thread", detail: "Move the eviction pass to the background queue; on a 200 MB cache it blocks the map for about 300 ms.", file: "src/map/tileCache.ts", line: 112 }),
    ]);
    const repaired = this.change(id, "S3", 4109, 4080, { sha: fakeSha("WT-001 S3"), paths: ["src/map/tileCache.ts", "src/map/tileCache.test.ts"], files: 2, additions: 31, deletions: 9 }, "Evicts the least recently used tile first and runs eviction off the main thread (+31 −9, 2 files)");
    // The loop's second round, appended by the service when S3 completed.
    this.checks(id, "C1-i2", 4079, 4077);
    this.reviews(id, "S2-i2", "SR1-i2", 4076, 4062, 4060, repaired, "No findings: the eviction order is covered by the test, and eviction runs off the main thread.", "No security findings: the background eviction touches the same directory and nothing else.");
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
    this.reviews(id, "S2", "SR1", 3736, 3718, 3715, change, "No findings: the targets meet the platform minimum and the layout tests cover three text sizes.", "No security findings: layout only.");
    this.skip(id, "S3", 3714);
    this.checks(id, "C2", 3713, 3711);
    this.output(id, "S4", 3710, 3700, "Tap targets on the trip page meet the 44 pt minimum; checks passed on the final change.");
    this.prHead(id, 3699, change);
    this.openPr(id, 3698, 994);
    this.mergePr(id, 3600, 3599);
    this.s = D.markLandedReviewed(this.s, [id], true, this.at(3500));
  }

  /** The two specs the lead published once the first changes had landed: an investigation and a design, neither producing code. */
  private laterSpecs() {
    const T = 3481;
    this.addTask(
      "WT-012",
      8,
      spec({
        title: "Why does the map drain the battery on long hikes?",
        area: "Reliability",
        whyNow: "Two hikers came back from Pine Saddle with a flat phone. The research note says battery matters and rules out background tracking, so the cause has to be found before anything is changed.",
        outcome: "We know what drains the battery while the map is open on a long hike, with numbers, and have a spec for the fix.",
        benefit: "The fix is aimed at the real cause instead of a guess.",
        scopeIncluded: ["Record the map on a five-hour hike with the screen off and on", "Name the biggest drains with their share of the battery"],
        scopeExcluded: ["Any fix: that is the follow-up task this investigation proposes"],
        options: [
          opt("A", "Measure first", "Instrument the map's location and drawing code, record a long hike, and report what used the battery", "A fix aimed at the cause", "Small", "A day before any fix starts", "High"),
          opt("B", "Throttle the location now", "Poll the location less often without measuring", "A fix this week", "Small", "May fix the wrong thing: the drain may not be the location at all", "High"),
        ],
        rationale: "The cause is unknown; one measured hike is cheaper than a wrong fix.",
        acceptance: ["The report names each drain with its share of the battery", "The follow-up spec names one change and its expected saving"],
        validationPlan: "A reviewer checks the evidence for gaps before the spec is written.",
      }),
      "investigation",
      T,
    );
    this.addTask(
      "WT-013",
      2,
      spec({
        title: "Design the invite screen for a trip",
        area: "Trip sharing",
        whyNow: "Trip sharing is next, and its first part is the invite link. The screen that makes and shares the link should be settled before anyone builds it.",
        outcome: "A reviewed design for the invite screen: how a link is made, shared and renewed, with every state and its copy.",
        benefit: "The first trip-sharing part is built once, from a design, instead of being redone after review.",
        scopeIncluded: ["The flow: make a link, share it, see when it expires, make a new one", "The states: no link yet, link ready, link expired", "The copy for each state"],
        scopeExcluded: ["The attendee list (its own part of the goal)", "Implementation"],
        options: [
          opt("A", "One sheet from the trip page", "A Share button on the trip page opens a sheet with the link, its expiry, Copy and Share", "One tap from the plan to the link", "Small", "A sheet hides the plan while it is open", "High"),
          opt("B", "A separate invite page", "A full page reached from the trip menu", "Room for more settings later", "Small", "Another screen for one link; the research asks for fewer screens", "High"),
        ],
        rationale: "The research note asks for fewer screens; a sheet keeps the plan in view.",
        acceptance: ["Every state has its copy", "The UX review finds nothing open"],
        validationPlan: "A UX review of the design, with a revise round if it finds anything.",
      }),
      "design",
      T,
    );
    this.event(T, "lead", "spec", "Published specs for WT-012 and WT-013 from vision r1");
    this.promote(["WT-012", "WT-013"], 3480);
  }

  /** WT-012: an Investigation. The evidence (Codex), a review of it for gaps (Claude, one note that blocks nothing), the lead's follow-up spec; nothing to integrate. */
  private batteryInvestigation() {
    const id = "WT-012";
    const script = DEMO_SCRIPT[id].outputs!;
    this.output(id, "S1", 3470, 3390, script.report);
    this.review(id, "S2", 3389, 3370, undefined, script["S2.findings"], [scripted(id, "S2", "info", "no-op")]);
    this.output(id, "S3", 3369, 3355, script.brief);
    this.nothingToIntegrate(id, 3354);
  }

  /** WT-013: a Design. The design (Claude), a UX review with one finding, a revise round, a clean second review, the lead's brief; nothing to integrate. */
  private inviteScreenDesign() {
    const id = "WT-013";
    const script = DEMO_SCRIPT[id].outputs!;
    this.output(id, "S1", 3340, 3290, script["S1.design"]);
    this.review(id, "S2", 3289, 3270, undefined, script["S2.findings"], [scripted(id, "S2", "warning", "auto-fix")]);
    this.output(id, "S3", 3269, 3240, script["S3.design"]);
    // The loop's second round, appended by the service when S3 completed.
    this.review(id, "S2-i2", 3239, 3225, undefined, script["S2-i2.findings"]);
    this.skip(id, "S3-i2", 3224);
    this.output(id, "S4", 3223, 3210, script.brief);
    this.nothingToIntegrate(id, 3209);
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
    // WT-004.1: Codex's code review was clean; Claude's security review beside it found that a link opened any
    // trip, so the repair ran and the loop reviewed the repaired change again: the story shows what the security review adds.
    const child = "WT-004.1";
    const words = DEMO_SCRIPT[child].outputs!;
    const first = this.change(child, "S1", 2900, 2840, { sha: fakeSha("WT-004.1 S1"), paths: ["src/trip/invite.ts", "src/trip/invite.test.ts", "src/trip/TripPage.tsx", "src/server/links.ts"], files: 4, additions: 132, deletions: 4 }, words["S1.change"], words["S1.handoff"]);
    this.checks(child, "C1", 2839, 2837);
    this.reviews(
      child,
      "S2",
      "SR1",
      2836,
      2817,
      2815,
      first,
      "No findings: the signature and the expiry are covered by tests, and the link format is documented.",
      "1 finding: invite links are not scoped to the trip; a link for one trip opened another.",
      [],
      [scripted(child, "SR1", "error", "auto-fix")],
    );
    const repaired = this.change(child, "S3", 2814, 2790, { sha: fakeSha("WT-004.1 S3"), paths: ["src/server/links.ts", "src/trip/invite.test.ts"], files: 2, additions: 23, deletions: 6 }, words["S3.change"]);
    // The loop's second round, appended by the service when S3 completed.
    this.checks(child, "C1-i2", 2789, 2787);
    this.reviews(child, "S2-i2", "SR1-i2", 2786, 2772, 2770, repaired, "No findings: the trip check sits beside the expiry check, and the new test covers a link used on another trip.", "No security findings: a link now opens only the trip it was issued for, and the key still never reaches the client.");
    this.skip(child, "S3-i2", 2769);
    this.checks(child, "C2", 2768, 2766);
    this.output(child, "S4", 2765, 2755, words.verification);
    this.prHead(child, 2754, repaired);
    this.openPr(child, 2753, 997);
    this.mergePr(child, 2700, 2699);
    this.s = D.markLandedReviewed(this.s, [child], true, this.at(2600));
  }

  /** WT-011: your own Change task; implemented by Codex, reviewed clean, merged at your request; in Review. */
  private fasterTrailSearch() {
    const id = "WT-011";
    const change = this.change(id, "S1", 2500, 2430, { sha: fakeSha("WT-011 S1"), paths: ["src/search/index.ts", "src/search/search.ts", "src/search/search.test.ts"], files: 3, additions: 84, deletions: 18 }, "Trail search over one prefix index on normalised names (+84 −18, 3 files)", "One index built at startup; diacritics and case are normalised once.");
    this.checks(id, "C1", 2409, 2407);
    this.reviews(id, "S2", "SR1", 2406, 2388, 2385, change, "No findings: the index is rebuilt when trails change, and the timing test guards the 50 ms budget.", "No security findings: the search runs on local data and takes no input beyond the typed text.");
    this.skip(id, "S3", 2384);
    this.checks(id, "C2", 2383, 2381);
    this.output(id, "S4", 2380, 2370, "Search over 5,000 trails answers within 50 ms; checks passed on the final change.");
    this.prHead(id, 2369, change);
    this.openPr(id, 2368, 999);
    this.mergePr(id, 2300, 2299);
  }

  /** WT-007: designed and implemented; the UX review asks you about units; the code review is next (it starts when the service does). */
  private voiceOver() {
    const id = "WT-007";
    this.output(id, "S1", 400, 350, DEMO_SCRIPT[id].outputs!.design);
    this.change(id, "S2", 349, 260, { sha: fakeSha("WT-007 S2"), paths: ["src/map/Pins.tsx", "src/map/MapView.tsx", "src/map/a11y.ts", "src/map/a11y.test.ts", "src/map/WaypointRotor.tsx", "src/trail/distance.ts"], files: 6, additions: 142, deletions: 11 }, DEMO_SCRIPT[id].outputs!["S2.change"], DEMO_SCRIPT[id].outputs!["S2.handoff"]);
    this.checks(id, "C1", 259, 257);
    this.review(id, "S4", 256, 230, undefined, "1 finding for you to decide: the unit distances are read in.", [
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
    const security = this.dispatch(id, "SR1", 56);
    // WT-004.3: the lead added the second option and asked you to choose, because the choice changes what data is kept.
    this.revisePackingDecision();
    // The steering exchange: offline maps ahead of sharing; one task deferred, with Undo; and one note
    // to the coder of the offline banner. WT-002 is first in line and has not started, so the note waits for
    // its run and is delivered at its start when the service dispatches it.
    this.say("Most of our hikes have no signal at the trailhead. Can we put offline maps ahead of sharing? And tell whoever builds the offline banner to show the cache age in whole hours, not minutes.", 47);
    this.leadReplies(47, 45, "Done. Offline maps is now the focus. I deferred “Weather alerts for the trip day”, since it needs a connection anyway. Everything else keeps its order. I sent the coder of the offline banner a note about the cache age; it reaches them when that step runs.", {
      focus: "Offline maps first: the map must work with no signal.",
      reason: "Most trailheads have no signal, so the map must work before sharing matters.",
      tasks: [{ id: "WT-010", defer: true, why: "It needs a connection anyway, and offline maps comes first." }],
      notes: [{ task: "WT-002", step: "S1", text: "Show the age of the cached map in whole hours, not minutes; the owner asked for it." }],
    });
    const set = this.s.steering[0];
    if (!set || !set.changes.some((c) => c.kind === "focus" && c.status === "applied") || !set.changes.some((c) => c.kind === "defer" && c.taskId === "WT-010" && c.status === "applied")) throw new Error("demo: the steering exchange was not applied");
    const noteRow = set.changes.find((c) => c.kind === "note");
    const note = noteRow?.noteId ? this.s.notes.find((n) => n.id === noteRow.noteId) : undefined;
    if (noteRow?.status !== "applied" || note?.status !== "queued" || !note.simulated) throw new Error(`demo: the note to WT-002's coder was not queued (${noteRow?.status ?? "no row"}: ${noteRow?.note ?? ""})`);
    this.complete(security, 36, [{ name: "findings", summary: "No security findings: the forecast is the one already fetched for the trip; no new network call.", findings: [] }]);
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

/**
 * The demo state: "Weekend Trips (sample)" at the start of a demo, with no run in flight (the service's
 * scheduler dispatches the three running steps itself). Deterministic for a given clock.
 */
export function buildDemo(nowMs: number = Date.now()): State {
  return new DemoBuilder(nowMs).build();
}
