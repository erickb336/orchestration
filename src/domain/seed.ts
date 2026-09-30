// Sample data for the prototype. Clearly labeled as sample content in the UI;
// it is not imported from any real repository.

import { instantiate, toDef } from "./pipeline";
import { BUILT_IN_TEMPLATES, templateSteps } from "./templates";
import { DEFAULT_AUTONOMY, DEFAULT_RUN_LIMITS, autoModelDefaults, type Artifact, type Attempt, type ConsumedInput, type SpecContent, type SpecOption, type State, type Task } from "./types";

type SampleOutput = { name: string; summary: string; openFindings?: number };

const minutesAgo = (base: number, m: number) => new Date(base - m * 60_000).toISOString();

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
    rollback: "Revert the task branch before integration.",
    effort: "small",
    ...partial,
  };
}

export interface SeedOptions {
  /**
   * Include runs that appear to be executing. Pure domain tests use them; the service does not,
   * because no runtime process would exist for them. The service's scheduler dispatches those
   * steps itself instead.
   */
  inFlightRuns?: boolean;
}

export function buildSeed(nowMs: number = Date.now(), { inFlightRuns = true }: SeedOptions = {}): State {
  const at = (m: number) => minutesAgo(nowMs, m);
  const tasks: Task[] = [];
  const attempts: Attempt[] = [];
  const artifacts: Artifact[] = [];

  const task = (id: string, priority: number, content: SpecContent, template: string, extra: Partial<Task> = {}): Task => {
    const defs = templateSteps(template);
    const t: Task = {
      id,
      priority,
      lifecycle: "proposed",
      hold: false,
      holdBeforeStart: false,
      specs: [{ rev: 1, at: at(600), author: "lead", reason: "Initial spec published by lead", content }],
      steps: instantiate(defs),
      pipelineRev: 1,
      pipelineHistory: [{ rev: 1, at: at(600), author: "lead", reason: `Lead applied the ${template} template`, steps: defs.map(toDef) }],
      roleOverrides: {},
      dependsOn: [],
      createdAt: at(600),
      updatedAt: at(600),
      decisionAt: at(600),
      ...extra,
    };
    tasks.push(t);
    return t;
  };

  const latest = (t: Task, step: string, output: string) =>
    artifacts.filter((x) => x.taskId === t.id && x.stepId === step && x.name === output).sort((a, b) => b.version - a.version)[0];

  const run = (
    t: Task,
    stepId: string,
    provider: "claude" | "codex",
    model: string,
    startedMin: number,
    outcome: Attempt["outcome"],
    progress: number,
    outputs: SampleOutput[] = [],
  ): Attempt => {
    const st = t.steps.find((x) => x.id === stepId)!;
    const inputs: ConsumedInput[] = [];
    for (const r of st.inputs) {
      const src = t.steps.find((x) => x.id === r.step);
      const art = src?.state === "done" ? latest(t, r.step, r.output) : undefined;
      if (art) inputs.push({ step: r.step, output: r.output, artifactId: art.id, version: art.version });
    }
    const a: Attempt = {
      id: `run-${attempts.length + 1}`,
      taskId: t.id,
      stepId,
      snapshot: {
        provider,
        model,
        source: st.selection ? "step" : "project-role",
        routingReason: st.selection ? "Pinned on this step" : "Project role default",
        specRev: t.specs[t.specs.length - 1].rev,
        stepRev: st.revision,
        visionRev: 1,
        workspace: `~/code/example-notes/.orchestration/worktrees/${t.id}-${stepId}`,
        pipelineRev: t.pipelineRev,
        purpose: st.purpose,
        inputs,
      },
      startedAt: at(startedMin),
      outcome,
      progress,
      artifacts: [],
      ...(outcome === "completed" ? { endedAt: at(Math.max(0, startedMin - 20)) } : {}),
    };
    attempts.push(a);
    st.state = outcome === "completed" ? "done" : outcome === "running" ? "running" : st.state;
    if (outcome === "completed") {
      for (const def of st.outputs) {
        const o = outputs.find((x) => x.name === def.name);
        if (!o) continue;
        artifacts.push({
          id: `art-${artifacts.length + 1}`,
          taskId: t.id,
          stepId,
          attemptId: a.id,
          name: def.name,
          kind: def.kind,
          version: (latest(t, stepId, def.name)?.version ?? 0) + 1,
          summary: o.summary,
          createdAt: a.endedAt!,
          ...(def.kind === "review-findings" ? { openFindings: o.openFindings ?? 0 } : {}),
        });
      }
    }
    return a;
  };

  // EX-001: running implementation after a completed design step.
  const ex1 = task(
    "EX-001",
    1,
    spec({
      title: "Make empty library screens explain the next action",
      area: "Library",
      whyNow: "Sample: a user with no saved items or no search matches sees a blank list and no guidance.",
      outcome: "Empty libraries and empty searches explain what happened and offer one next action.",
      benefit: "New users know how to add their first item; searchers know how to widen a search.",
      successCriteria: ["Empty library and empty search are distinguishable", "Primary action works from both states"],
      scopeIncluded: ["Library list empty state", "Search results empty state"],
      scopeExcluded: ["Onboarding flow", "Populated-list layout changes"],
      options: [
        opt("A", "Contextual empty states", "One message and one primary action per empty state", "Clear next step, minimal change", "Small", "Does not teach the full workflow", "High"),
        opt("B", "Guided onboarding", "Multi-screen first-run sequence", "More instruction for first-time users", "Large", "Adds screens and setup time", "Medium"),
        opt("C", "Leave unchanged", "No change", "None", "None", "Confusion remains", "N/A"),
      ],
      rationale: "A local explanation and one action fits the product's essential-feature direction.",
      uncertainty: "Unknown how often users hit empty search vs empty library; usage evidence could favor B.",
      acceptance: ["Empty library and empty search are distinguished", "Main action works", "Populated states unchanged", "Keyboard and screen reader checks pass"],
      validationPlan: "Component tests for each state; manual keyboard and screen reader pass.",
    }),
    "feature",
    { lifecycle: "active", updatedAt: at(4), decisionAt: at(600) },
  );
  run(ex1, "S1", "claude", "claude-sample-large", 180, "completed", 100, [
    { name: "design", summary: "Two empty states (no items; no search matches), each with one message and one primary action (sample)" },
  ]);
  if (inFlightRuns) run(ex1, "S2", "codex", "codex-sample-large", 30, "running", 45);

  // EX-002: under review by the other provider.
  const ex2 = task(
    "EX-002",
    2,
    spec({
      title: "Report backup failures instead of failing silently",
      area: "Storage",
      whyNow: "Sample: backup write errors are caught and ignored, so users may believe data is saved.",
      outcome: "A failed backup is visible to the user with a retry.",
      benefit: "Users can trust that their records are saved.",
      options: [
        opt("A", "Inline banner with retry", "Show a persistent banner until a backup succeeds", "Visible and actionable", "Small", "Banner fatigue if failures are frequent", "High"),
        opt("B", "System notification", "Notify via OS notifications", "Visible outside the app", "Medium", "Permission prompt; easy to dismiss", "High"),
      ],
      rationale: "Banner keeps the failure in context without new permissions.",
      uncertainty: "Failure frequency in real use is unknown.",
      acceptance: ["Simulated write failure shows banner", "Retry succeeds clears banner", "No data loss on failure"],
      validationPlan: "Fault-injection unit test; manual retry check.",
    }),
    "change",
    { lifecycle: "active", updatedAt: at(2) },
  );
  run(ex2, "S1", "codex", "codex-sample-large", 240, "completed", 100, [
    { name: "change", summary: "Backup write errors surface a persistent banner with Retry (sample diff, +42 −6)" },
    { name: "handoff", summary: "Fault injection test added; retry path not yet tested offline (sample)" },
  ]);
  if (inFlightRuns) run(ex2, "S2", "claude", "claude-sample-large", 12, "running", 60);

  task(
    "EX-003",
    4,
    spec({
      title: "Investigate slow search on large libraries",
      area: "Search",
      whyNow: "Sample: search latency grows noticeably above a few thousand items.",
      outcome: "A measured explanation of where search time goes and a follow-on implementation spec.",
      benefit: "Search stays responsive as libraries grow.",
      options: [
        opt("A", "Profile then decide", "Measure with a synthetic 10k-item library before choosing a fix", "Avoids guessing", "Small", "Adds a step before a fix", "High"),
        opt("B", "Defer", "Wait for user reports", "No cost now", "None", "Problem may worsen unnoticed", "High"),
      ],
      rationale: "Only one sensible approach; compared against deferring.",
      uncertainty: "Implementation details are intentionally unresolved until profiling completes.",
      acceptance: ["Profile captured at 1k and 10k items", "Follow-on spec published"],
      validationPlan: "Attach profile output.",
      effort: "small",
    }),
    "investigation",
    { updatedAt: at(8), decisionAt: at(8) },
  );

  task(
    "EX-004",
    3,
    spec({
      title: "Add a quick-capture shortcut",
      area: "Capture",
      whyNow: "Sample: capturing a note takes three taps from the home screen.",
      outcome: "A note can be captured in one action from anywhere in the app.",
      benefit: "Faster everyday logging.",
      options: [
        opt("A", "Floating capture button", "Persistent button on main screens", "Discoverable", "Small", "Covers content", "High"),
        opt("B", "Keyboard shortcut only", "Global shortcut", "No visual clutter", "Small", "Not discoverable; no touch support", "High"),
      ],
      rationale: "Discoverability matters more than clutter for this audience.",
      uncertainty: "Button placement needs design review against existing controls.",
      acceptance: ["Capture reachable in one action", "Button does not obscure primary content"],
      validationPlan: "UX review on small and large viewports.",
    }),
    "feature",
    { lifecycle: "ready", holdBeforeStart: true, updatedAt: at(50) },
  );

  task(
    "EX-005",
    5,
    spec({
      title: "Rewrite onboarding copy",
      area: "Onboarding",
      whyNow: "Sample: first-run copy uses internal terminology.",
      outcome: "First-run copy uses plain language.",
      benefit: "New users understand the app faster.",
      options: [
        opt("A", "Copy-only rewrite", "Replace strings, keep layout", "Low risk", "Small", "Limited impact", "High"),
        opt("B", "Copy and layout", "Rework screens too", "Bigger improvement", "Medium", "Overlaps EX-001", "Medium"),
      ],
      rationale: "Avoid overlapping EX-001's empty-state work.",
      uncertainty: "",
      acceptance: ["No internal terms remain in first-run screens"],
      validationPlan: "Copy review.",
    }),
    "design",
    { lifecycle: "ready", hold: true, updatedAt: at(90) },
  );

  task(
    "EX-007",
    6,
    spec({
      title: "Sync settings between devices",
      area: "Settings",
      whyNow: "Sample: settings must be reconfigured on every device.",
      outcome: "Settings follow the user across devices.",
      benefit: "Less setup repetition.",
      options: [
        opt("A", "Reuse backup channel", "Sync settings through the existing backup store", "No new service", "Medium", "Depends on reliable backups (EX-002)", "High"),
        opt("B", "Defer", "Keep per-device settings", "No cost", "None", "Repetition remains", "High"),
      ],
      rationale: "Reuses the backup path once failures are visible.",
      uncertainty: "Conflict behavior when two devices change the same setting.",
      acceptance: ["Setting changed on one device appears on another after sync"],
      validationPlan: "Two-profile manual test.",
      effort: "medium",
    }),
    "change",
    { lifecycle: "proposed", dependsOn: ["EX-002"], updatedAt: at(120) },
  );

  // EX-006: completed, with a user override and revision history.
  const ex6Content = spec({
    title: "Export notes as Markdown",
    area: "Export",
    whyNow: "Sample: users asked to move notes into other tools.",
    outcome: "Any note or the whole library exports to Markdown files.",
    benefit: "Users own their data in a portable format.",
    options: [
      opt("A", "Single zip export", "One archive of Markdown files", "One action", "Small", "Large archives for big libraries", "High"),
      opt("B", "Per-note export", "Export from each note", "Fine-grained", "Small", "Tedious for whole library", "High"),
    ],
    rationale: "Whole-library export is the common need.",
    uncertainty: "Attachment handling.",
    acceptance: ["Exported files open in a Markdown editor", "Front matter preserves titles and dates"],
    validationPlan: "Round-trip test on sample library.",
  });
  const ex6 = task("EX-006", 7, ex6Content, "change", { lifecycle: "done", updatedAt: at(1500), decisionAt: at(2200) });
  ex6.specs[0].at = at(2400);
  ex6.createdAt = at(2400);
  ex6.specs.push({
    rev: 2,
    at: at(2200),
    author: "user",
    reason: "User selected option B",
    content: { ...structuredClone(ex6Content), selectedOptionId: "B", decidedBy: "user", overrideReason: "I mostly export single notes to share them." },
  });
  run(ex6, "S1", "codex", "codex-sample-fast", 2100, "completed", 100, [
    { name: "change", summary: "Per-note Markdown export with front matter (sample diff, +88)" },
    { name: "handoff", summary: "Attachments are linked, not embedded (sample)" },
  ]);
  run(ex6, "S2", "claude", "claude-sample-large", 1900, "completed", 100, [{ name: "findings", summary: "1 finding: exported dates lose their timezone (sample)", openFindings: 1 }]);
  run(ex6, "S3", "codex", "codex-sample-fast", 1700, "completed", 100, [{ name: "change", summary: "Dates exported in ISO 8601 with offset (sample diff, +3 −1)" }]);
  run(ex6, "S4", "claude", "claude-sample-large", 1550, "completed", 100, [{ name: "verification", summary: "Round-trip test passes on the repaired change; finding resolved (sample)" }]);

  return {
    version: 9,
    seq: 1000,
    project: {
      id: "sample",
      sample: true,
      name: "Example Notes (sample)",
      repoPath: "~/code/example-notes",
      visions: [
        {
          rev: 1,
          at: at(3000),
          author: "user",
          text: "Keep everyday note taking fast and trustworthy. Prefer fewer, clearer screens over more features.",
          focus: "Make daily logging simpler",
          reason: "Initial vision",
        },
      ],
      enabledProviders: ["claude", "codex"],
      catalog: {
        claude: [
          { id: "claude-sample-large", label: "Claude sample large" },
          { id: "claude-sample-fast", label: "Claude sample fast" },
        ],
        codex: [
          { id: "codex-sample-large", label: "Codex sample large" },
          { id: "codex-sample-fast", label: "Codex sample fast" },
        ],
      },
      defaultSelection: { provider: "claude", model: "claude-sample-large" },
      roleDefaults: {
        designer: { provider: "claude", model: "claude-sample-large" },
        lead: { provider: "claude", model: "claude-sample-large" },
        coder: { provider: "codex", model: "codex-sample-large" },
        code_reviewer: { provider: "claude", model: "claude-sample-large" },
        ux_reviewer: { provider: "claude", model: "claude-sample-fast" },
      },
      leadSelection: { provider: "claude", model: "claude-sample-large" },
      workerLimit: 3,
      providerLimits: { claude: 3, codex: 3 },
      runLimits: { ...DEFAULT_RUN_LIMITS },
      autonomy: { ...DEFAULT_AUTONOMY },
      workerEnvironment: { claude: "isolated", codex: "isolated" },
      workerConnections: { claude: [], codex: [] },
      hold: false,
      lastVisitAt: at(60),
      templates: structuredClone(BUILT_IN_TEMPLATES),
    },
    tasks,
    attempts,
    artifacts,
    conversation: [],
    leadRuns: [],
    events: [
      { id: "ev-1", at: at(600), actor: "lead", kind: "spec", message: "Published specs for EX-001…EX-007 from vision r1", taskId: undefined },
      { id: "ev-2", at: at(2200), actor: "user", kind: "decision", taskId: "EX-006", message: "Selected option B (Per-note export); override: I mostly export single notes to share them." },
      { id: "ev-3", at: at(1500), actor: "lead", kind: "integration", taskId: "EX-006", message: "Integrated spec r2 (simulated); task Done" },
      { id: "ev-4", at: at(90), actor: "user", kind: "control", taskId: "EX-005", message: "Paused; hold saved and excluded from dispatch" },
      ...(inFlightRuns
        ? [
            { id: "ev-5", at: at(30), actor: "lead" as const, kind: "dispatch" as const, taskId: "EX-001", message: "Dispatched S2 (coder) to Codex · codex-sample-large as run-2 on spec r1" },
            { id: "ev-6", at: at(12), actor: "lead" as const, kind: "dispatch" as const, taskId: "EX-002", message: "Dispatched S2 (code_reviewer) to Claude · claude-sample-large as run-4 on spec r1" },
          ]
        : []),
      { id: "ev-7", at: at(8), actor: "lead", kind: "spec", taskId: "EX-003", message: "Spec r1: proposed investigation" },
    ],
  };
}

/**
 * A new, empty project for real runs: no sample tasks (sample runs must never reach a real agent)
 * and no repository until the user configures one.
 */
export function buildEmptyProject(nowMs: number = Date.now()): State {
  const sample = buildSeed(nowMs, { inFlightRuns: false });
  const now = new Date(nowMs).toISOString();
  return {
    ...sample,
    project: {
      ...sample.project,
      id: `p-${nowMs.toString(36)}`,
      sample: false,
      name: "New project",
      repoPath: "",
      // Real catalogs replace the sample ones at startup; "auto" resolves to each provider's first
      // listed model, so no sample model id survives into a real project.
      ...autoModelDefaults(),
      visions: [{ rev: 1, at: now, author: "system", text: "", focus: "", reason: "Empty project; set it up in Settings" }],
      lastVisitAt: now,
    },
    tasks: [],
    attempts: [],
    artifacts: [],
    events: [{ id: "ev-1", at: now, actor: "system", kind: "vision", message: "Empty project created. Configure the repository and vision in Settings." }],
  };
}
