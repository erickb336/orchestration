// Core domain types. Pure data: no UI, storage, or runtime dependencies.

export type ProviderId = "claude" | "codex";
export const PROVIDERS: ProviderId[] = ["claude", "codex"];

export type RoleId = "lead" | "designer" | "coder" | "code_reviewer" | "ux_reviewer" | "checks";
/** Agent roles: they have role defaults, task role overrides and a resolved provider. */
export const ROLES: RoleId[] = ["lead", "designer", "coder", "code_reviewer", "ux_reviewer"];
/** ORC-013: roles the service runs itself; never resolved to a provider. */
export const SERVICE_ROLES: RoleId[] = ["checks"];
/** What a step definition may use. */
export const STEP_ROLES: RoleId[] = [...ROLES, ...SERVICE_ROLES];
export const REVIEW_ROLES: RoleId[] = ["code_reviewer", "ux_reviewer"];

/** ORC-013: who runs an attempt: a provider's agent, or the service itself (check runs). */
export type Runner = ProviderId | "service";
export const isProvider = (r: Runner | string): r is ProviderId => r === "claude" || r === "codex";

export type Actor = "user" | "lead" | "runtime" | "system";

/** A provider/model choice. model "auto" lets the lead pick from the enabled allowlist. */
export interface ModelSelection {
  provider: ProviderId;
  model: string;
}

export interface CatalogModel {
  id: string;
  label: string;
}

export interface VisionRevision {
  rev: number;
  at: string;
  author: Actor;
  text: string;
  focus: string;
  reason: string;
  /**
   * ORC-009: where a revision came from when it was not typed by hand. A lead focus change names its
   * change set, run and the user's messages; an Undo names the set it undid; an applied suggestion
   * names its set only. ORC-012: an accepted vision draft names the draft, its run and messages.
   * ORC-014: a document attached or removed names it (`docAdded` / `docRemoved`; a replacement names both).
   * ORC-014 review 9: a batch of documents attached as one revision lists them (`docsAdded`, the copies
   * they replaced in `docsRemoved`) and the batch the client named.
   */
  source?: { changeSetId?: string; leadRunId?: string; messageIds?: string[]; undoOf?: string; draftId?: string; docAdded?: string; docRemoved?: string; docsAdded?: string[]; docsRemoved?: string[]; batchId?: string };
  /**
   * ORC-014: the vision documents that applied at this revision (ids into `Project.visionDocs`), so
   * history stays truthful. Absent on revisions from before documents existed: none applied.
   */
  docIds?: string[];
}

// ---------- vision documents (ORC-014) ----------

/**
 * A file the user attached to the vision. The state holds metadata only; the content is a copy stored
 * by hash under the service's data directory, never in a repository or worktree. Never removed from
 * the registry: an old revision may still refer to it.
 */
export interface VisionDoc {
  /** `doc-${seq}` */
  id: string;
  /** The file name (the last path segment). */
  name: string;
  /** Relative path with `/` separators, as attached (a folder upload keeps its structure). */
  path: string;
  /** Bytes. */
  size: number;
  /** SHA-256 of the content, hex: the stored copy's name. */
  hash: string;
  /** Readable as text (valid UTF-8 without NUL bytes, and not a known binary format): its content reaches the lead and designers. */
  text: boolean;
  addedAt: string;
  /**
   * ORC-014 review 9: uploaded but not attached yet: it waits for its batch's `attachVisionDocs`, which
   * attaches every file of one Add, drop or folder as one vision revision. Absent once attached. A
   * staged record whose batch never commits is dropped after an hour.
   */
  stagedAt?: string;
}

// ---------- shaping the vision with the lead first (ORC-012) ----------

/**
 * "shaping": the user and the lead shape the vision; no worker step runs and no planning run starts.
 * "building": everything runs as usual.
 */
export type ProjectStage = "shaping" | "building";
export const PROJECT_STAGES: ProjectStage[] = ["shaping", "building"];

/** The areas a vision needs to cover; the lead reports how clear each is and asks about the open ones. */
export type ShapingArea = "intent" | "audience" | "problem" | "outcome" | "scope" | "constraints" | "risks" | "priorities" | "material";
export const SHAPING_AREAS: ShapingArea[] = ["intent", "audience", "problem", "outcome", "scope", "constraints", "risks", "priorities", "material"];
export const SHAPING_AREA_LABEL: Record<ShapingArea, string> = {
  intent: "Intent and why now",
  audience: "Who it is for",
  problem: "The problem and today's workaround",
  outcome: "Desired outcome and how success is measured",
  scope: "Scope, in and out",
  constraints: "Constraints: technical, time, budget, platforms",
  risks: "Risks and unknowns",
  priorities: "Priorities and the first milestone",
  material: "Existing material",
};
export type CoverageState = "clear" | "partial" | "open";
export const COVERAGE_STATES: CoverageState[] = ["clear", "partial", "open"];
/** The lead's reading of how clear each area is, as of one reply. Areas it did not name are open. */
export type Coverage = Partial<Record<ShapingArea, CoverageState>>;

/** A targeted question from the lead, with why it matters and (optionally) options the user can pick from. */
export interface LeadQuestion {
  question: string;
  why: string;
  area?: ShapingArea;
  options?: string[];
}

/** A vision the lead drafted from the conversation. A suggestion: it becomes the vision only when the user accepts it. */
export interface VisionDraft {
  /** `vd-${leadRunId}` */
  id: string;
  at: string;
  leadRunId: string;
  /** The user's messages the drafting run answered. */
  messageIds: string[];
  text: string;
  focus: string;
  /** The lead's reason (plain text, one line, at most 500 characters). */
  reason: string;
  /** The vision revision the lead saw when it drafted. */
  basedOnVisionRev: number;
  status: "open" | "accepted" | "dismissed" | "superseded";
  resolvedAt?: string;
  /** accepted: the revision the user created from it. */
  visionRev?: number;
}

// ---------- steering by conversation (ORC-009) ----------

/** How far the lead may go when the user gives direction in the conversation. */
export type SteeringMode = "apply" | "apply-own" | "suggest";
export const STEERING_MODES: SteeringMode[] = ["apply", "apply-own", "suggest"];

/** Dispatch-only: no new step starts on this task or its descendants. Never a hold; nothing is interrupted. */
export interface Deferral {
  by: "lead" | "user";
  at: string;
  reason: string;
  /** The change set that deferred it (lead deferrals and applied suggestions). */
  changeSetId?: string;
}

export type SteerAction = "priority" | "defer" | "undefer" | "drop";
export type SteeringValue = string | number | Deferral | null;

export interface SteeringChange {
  /** `${setId}.${n}` */
  id: string;
  /** "invalid": an entry the service could not read as one of the four actions (always rejected). */
  kind: "focus" | "priority" | "defer" | "undefer" | "drop" | "invalid";
  taskId?: string;
  /** focus text | priority | deferral | lifecycle */
  before: SteeringValue;
  after: SteeringValue;
  /** The lead's reason (plain text, at most 300 characters). */
  why: string;
  status: "applied" | "suggested" | "skipped" | "rejected" | "undone" | "dismissed" | "superseded";
  /** Service reason: why suggested, skipped or rejected; "left as is on undo: …". */
  note?: string;
  appliedBy?: "lead" | "user";
  /** focus: the revision created (applied) or based on (suggested). */
  visionRev?: number;
  /** undo / apply / dismiss / supersede time */
  resolvedAt?: string;
}

/** What one lead reply changed, suggested, skipped or rejected. Written by the service, never by the lead's prose. */
export interface SteeringChangeSet {
  /** `cs-${leadRunId}` */
  id: string;
  leadRunId: string;
  messageIds: string[];
  at: string;
  /** The project's steering mode in force at completion. */
  mode: SteeringMode;
  basedOnVisionRev: number;
  reason: string;
  /** The whole block was refused (a planning run, a run from before steering existed, not an object). */
  refused?: string;
  /** Newer direction arrived while the lead worked: every applicable item became a suggestion. */
  heldBecause?: string;
  /** Set-level notes (reason ignored, tasks not a list, …). */
  notes: string[];
  changes: SteeringChange[];
}

export interface Project {
  /** Stable id; namespaces branches and worktrees so a new project never collides with an old one. */
  id: string;
  /** The built-in sample project: never dispatched to real agents. */
  sample: boolean;
  name: string;
  /** Managed repository path; user-configured. */
  repoPath: string;
  visions: VisionRevision[];
  /** ORC-014: every document ever attached to the vision (the current set is the current revision's `docIds`). */
  visionDocs: VisionDoc[];
  enabledProviders: ProviderId[];
  /** Sample catalog per provider. A real catalog comes from the connected provider. */
  catalog: Record<ProviderId, CatalogModel[]>;
  defaultSelection: ModelSelection;
  roleDefaults: Partial<Record<RoleId, ModelSelection>>;
  leadSelection: ModelSelection;
  workerLimit: number;
  /** Concurrent runs per provider (each also bounded by workerLimit). */
  providerLimits: Record<ProviderId, number>;
  /** Bounds applied to every real run attempt. */
  runLimits: RunLimits;
  autonomy: Autonomy;
  /** ORC-009: apply the lead's steering, apply it to the lead's own work only, or only suggest. Default "apply". */
  steeringMode: SteeringMode;
  /** ORC-012: shaping (talk it through with the lead; nothing runs) or building (everything runs). */
  stage: ProjectStage;
  /** ORC-012 review 8: when the current shaping session began; coverage reported before it is not reused. */
  shapingSince?: string;
  /** ORC-013: the project's own check commands, run by the service. Desired state; only the user's `setChecks` writes it. */
  checks: ChecksConfig;
  /** ORC-013: the checks sandbox as last probed. Observed; written only by the service. */
  checksHealth?: ChecksHealth;
  /** ORC-013: who decides `ask-user` findings: the lead (Autopilot's default) or the user. */
  triage: { askUserBy: "lead" | "user" };
  /** ORC-013: give every run the repository's AGENTS.md and CLAUDE.md from the trusted base as labelled project conventions. */
  conventions: { include: boolean };
  /** Last planning run start (for the planning interval). */
  lastPlanningAt?: string;
  /** Automatic delivery state: retried until the delivery branch contains all integrated work. */
  delivery?: {
    pending: boolean;
    /** Commit last delivered; the branch must still contain it (detects resets and rewrites). */
    lastSha?: string;
    lastAttemptAt?: string;
    status?: "delivered" | "skipped" | "conflict" | "blocked";
    message?: string;
  };
  /** Desired state: deliver finished work as GitHub pull requests. Off by default; never on together with autoDeliver. */
  prDelivery: PrDeliveryConfig;
  /** Observed state of the GitHub connection. Written only by the service; never holds a secret. */
  github?: GitHubStatus;
  workerEnvironment: Record<ProviderId, WorkerEnvironment>;
  /** MCP servers (by name, from the user's own provider config) isolated workers may use. */
  workerConnections: Record<ProviderId, string[]>;
  /** Desired state: project-wide pause. */
  hold: boolean;
  lastVisitAt: string;
  templates: WorkflowTemplate[];
}

/**
 * What a worker process sees of the user's own tool setup.
 * "isolated": no user settings, MCP servers, plugins, or web tools (default).
 * "local": the user's Claude/Codex configuration, including MCP servers and plugins.
 * In both, file edits stay in the worktree and native sub-agents stay disabled.
 */
export type WorkerEnvironment = "isolated" | "local";

export interface RunLimits {
  maxTurns: number;
  timeoutMinutes: number;
  /** Claude only; Codex does not expose a spend cap. */
  maxBudgetUsd: number;
}

/** Provider-neutral model defaults for a new project: "auto" resolves against the live catalog. */
export function autoModelDefaults(): Pick<Project, "defaultSelection" | "leadSelection" | "roleDefaults"> {
  return {
    defaultSelection: { provider: "claude", model: "auto" },
    leadSelection: { provider: "claude", model: "auto" },
    roleDefaults: {
      lead: { provider: "claude", model: "auto" },
      designer: { provider: "claude", model: "auto" },
      coder: { provider: "codex", model: "auto" },
      code_reviewer: { provider: "claude", model: "auto" },
      ux_reviewer: { provider: "claude", model: "auto" },
    },
  };
}

export const DEFAULT_RUN_LIMITS: RunLimits = { maxTurns: 40, timeoutMinutes: 20, maxBudgetUsd: 2 };

export interface SpecOption {
  id: string;
  name: string;
  approach: string;
  benefit: string;
  effort: string;
  risks: string;
  reversibility: string;
}

export interface SpecContent {
  title: string;
  area: string;
  whyNow: string;
  outcome: string;
  benefit: string;
  successCriteria: string[];
  scopeIncluded: string[];
  scopeExcluded: string[];
  options: SpecOption[];
  recommendedOptionId: string;
  selectedOptionId: string;
  decidedBy: Actor;
  rationale: string;
  uncertainty: string;
  /** Required when the selection differs from the recommendation. */
  overrideReason: string;
  acceptance: string[];
  validationPlan: string;
  rollback: string;
  effort: "small" | "medium" | "large";
}

export interface SpecRevision {
  rev: number;
  at: string;
  author: Actor;
  reason: string;
  content: SpecContent;
}

export type StepState =
  | "pending" // not yet dispatched (or requeued)
  | "running"
  | "stopping" // stop requested, awaiting runtime acknowledgment
  | "paused" // stopped by a hold; will not redispatch until resumed
  | "done"
  | "skipped" // run-if condition was false; satisfies dependencies
  | "blocked"
  | "pipeline";

export type ArtifactKind = "brief" | "design" | "plan" | "code-change" | "review-findings" | "verification" | "report" | "handoff" | "breakdown" | "check-results";
export const ARTIFACT_KINDS: ArtifactKind[] = ["brief", "design", "plan", "breakdown", "code-change", "review-findings", "verification", "report", "handoff", "check-results"];

// ---------- ORC-013: structured findings, coverage and service checks ----------

export type Severity = "error" | "warning" | "info";
export const SEVERITIES: Severity[] = ["error", "warning", "info"];
/**
 * What a finding asks for. "auto-fix": the repair loop fixes it. "ask-user": someone decides first (the
 * remedy would widen the task, or the finding questions what was asked). "no-op": information only.
 * A finding reported without an action is treated as "ask-user".
 */
export type FindingAction = "auto-fix" | "ask-user" | "no-op";
export const FINDING_ACTIONS: FindingAction[] = ["auto-fix", "ask-user", "no-op"];

/** One finding of a review (or, later, of a service check run). Validated by the service; ids are unique within the artifact. */
export interface Finding {
  /** "F1".."F50" */
  id: string;
  /** 12 hex characters: sha256(source | file | normalised title). The carry-forward identity across rounds. */
  key: string;
  source: "review" | "check";
  severity: Severity;
  action: FindingAction;
  /** The worker omitted or misspelled the action or severity, so the service chose the default. */
  defaulted?: true;
  /** ≤200 characters */
  title: string;
  /** ≤1200 characters; for checks the output tail (untrusted text) */
  detail: string;
  /** Repository-relative, normalised, ≤300 characters */
  file?: string;
  /** 1..10^7 */
  line?: number;
  /** ask-user: what a person has to decide (≤300 characters) */
  why?: string;
  /** source "check": the command */
  checkId?: string;
}

/** Whether a code review accounted for every changed file of the change it was shown. */
export interface PathCoverage {
  /** "not-required": no changed-path set was recorded for the run (nothing under review). "unproven": too many files to show. */
  state: "complete" | "incomplete" | "unproven" | "not-required";
  /** Full SHAs of the diff the reviewer was shown. */
  from?: string;
  to?: string;
  /** Size of the service's changed-path set. */
  changed: number;
  /** Valid reported paths. */
  reviewed: number;
  /** ≤50 each */
  missing: string[];
  extra: string[];
}

export interface CheckResult {
  id: string;
  label: string;
  kind: "prepare" | "check";
  status: "passed" | "failed" | "timed-out" | "not-run";
  exitCode?: number;
  durationMs: number;
  /** Redacted: the first 2 KB and the last 6 KB of stdout, then stderr. */
  excerpt: string;
  bytes: number;
  truncated: boolean;
  /** "<attemptId>/<checkId>": the full redacted log (≤1 MiB) kept outside the state. */
  log?: string;
}

export interface CheckRunRecord {
  /** Full SHA the worktree was verified at. */
  sha: string;
  configRev: number;
  sandbox: "codex" | "none";
  simulated?: true;
  /** The attempt whose run of the same sha and configRev this repeats. */
  reusedFrom?: string;
  /** Protected check inputs the change touched (≤20). */
  touchedInputs: string[];
  results: CheckResult[];
  durationMs: number;
}

/**
 * A decision someone has to take on an `ask-user` finding (or on failing final checks). Routed to the
 * lead or the user by the project's triage setting; recorded, shown on the task, and given to later
 * repairs and reviews.
 */
export interface FindingDecision {
  /** "fd-<seq>" */
  id: string;
  taskId: string;
  artifactId: string;
  findingId: string;
  key: string;
  kind: "finding" | "final-checks";
  finding: Pick<Finding, "source" | "severity" | "title" | "detail" | "file" | "line" | "why" | "checkId">;
  routedTo: "lead" | "user";
  /** When it was last routed to its current decider. A lead run for decisions starts only for decisions routed after the lead's last run. */
  routedAt?: string;
  status: "open" | "fix" | "accept" | "follow-up";
  /** A lead "fix" on a spec the user wrote: recorded, not applied; the decision stays open for the user. */
  suggestion?: { decision: "fix"; why: string; leadRunId: string; at: string };
  decidedBy?: "lead" | "user" | "carried";
  decidedAt?: string;
  /** ≤300 characters */
  why?: string;
  leadRunId?: string;
  followUpTaskId?: string;
  /** The decision this one repeats (the same finding decided earlier on this task or its origin task). */
  carriedFrom?: string;
  /** Repair attempts whose envelope carried this decision; a later change applies to later repairs only. */
  usedBy: string[];
  createdAt: string;
}

/** One command the service runs as a check. Never a shell string: argv only. */
export interface CheckCommand {
  /** /^[a-z][a-z0-9-]{0,23}$/, unique */
  id: string;
  /** ≤60 */
  label: string;
  /** prepare commands run first, in order */
  kind: "prepare" | "check";
  /** 1–32 items, each 1–400 characters, no NUL or newline */
  argv: string[];
  /** 1–60; default commandTimeoutMinutes */
  timeoutMinutes?: number;
}

export interface ChecksConfig {
  enabled: boolean;
  /** +1 on every change; recorded per run */
  rev: number;
  /** ≤8, ≤2 of them prepare */
  commands: CheckCommand[];
  sandbox: "codex" | "none";
  /** prepare commands may use the network (still write-limited) */
  prepareNetwork: boolean;
  /** 1–60 */
  commandTimeoutMinutes: number;
  /** 1–120 */
  runTimeoutMinutes: number;
  /** 1–3 */
  maxConcurrent: number;
  /** ≤30 globs: files the checks depend on; a change that edits them becomes an ask-user finding */
  protectedInputs: string[];
  /** ≤20 variable names passed through to commands, none secret-named */
  passEnv: string[];
}

export const DEFAULT_CHECKS: ChecksConfig = {
  enabled: false,
  rev: 0,
  commands: [],
  sandbox: "codex",
  prepareNetwork: true,
  commandTimeoutMinutes: 10,
  runTimeoutMinutes: 30,
  maxConcurrent: 1,
  protectedInputs: [
    ".github/**",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock*",
    "tsconfig*.json",
    "vitest.config.*",
    "vite.config.*",
    "jest.config.*",
    "eslint.config.*",
    ".eslintrc*",
    "Makefile",
    "pyproject.toml",
    "setup.cfg",
    "tox.ini",
    "Cargo.toml",
    "go.mod",
  ],
  passEnv: [],
};

/** Observed: whether the checks sandbox works on this machine. Written only by the service. */
export interface ChecksHealth {
  sandbox: "codex" | "none";
  status: "ready" | "unavailable" | "unverified";
  detail: string;
  checkedAt: string;
  recheck?: true;
  probes?: { writeOutside: "denied" | "allowed" | "unknown"; network: "denied" | "allowed" | "unknown" };
}

/** Evidence of service checks for a pull request's change, bound to the exact commit and settings revision. */
export interface CheckEvidence {
  ok: boolean;
  forSha: string;
  reason: string;
  configRev?: number;
  attemptId?: string;
  taskId?: string;
  sandbox?: "codex" | "none";
  acceptedByUser?: true;
}

/** Review-bot GitHub app slugs treated as opinions, not code failures (unverified defaults). */
export const DEFAULT_REVIEW_BOTS = ["coderabbitai", "greptile-apps"];

/** An artifact a step produces. Name is unique within the step. */
export interface OutputDef {
  name: string;
  kind: ArtifactKind;
}

/** A reference to an upstream step's output. */
export interface InputRef {
  step: string;
  output: string;
}

/** Structural definition of a step, shared by templates and task pipelines. */
export interface StepDef {
  id: string;
  purpose: string;
  role: RoleId;
  dependsOn: string[];
  inputs: InputRef[];
  outputs: OutputDef[];
  /** Run only if any referenced review-findings artifact has open findings; otherwise skip. */
  runIf?: InputRef[];
  /** Pause the task after this step completes, so a person can review or edit its artifacts. */
  gate?: boolean;
  /**
   * Loop: set on the LAST step of a loop body that starts at `from`. When this step completes
   * (and, for a breakdown step, created new child tasks), the service appends the next iteration of
   * the body as new steps, up to `max` iterations. A loop ends early when its last step is skipped
   * (for example a repair with no open findings).
   */
  iterate?: { from: string; max: number };
  /**
   * Run this step as `count` parallel agents. "copies": every copy's output goes forward (review
   * findings are summed). "best-of": the next step that reads them must choose one; only the chosen
   * copy's work goes further. `providers` assigns copies round-robin (e.g. one Claude, one Codex).
   */
  parallel?: { count: number; mode: "copies" | "best-of"; providers?: ProviderId[] };
  /** Do not start this step until every child task created by this task's breakdowns has settled. */
  waitForChildren?: boolean;
  /** A review that must run on another provider than the one that wrote the change under review. */
  independentOf?: "writer";
  /** Set by expansion: the parallel group (original step id) this copy belongs to. */
  copyOf?: string;
  /** Set by expansion: which loop iteration this step belongs to (first = 1). */
  iteration?: number;
  /**
   * ORC-013, role "checks" only. "findings": failing commands become auto-fix findings for the repair
   * step. "block": the step blocks and opens a decision (a Final checks step). `only` limits the step
   * to some command ids; prepare commands always run.
   */
  checks?: { onFail: "findings" | "block"; only?: string[] };
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  /** Bumps on every save; guards against overwriting a newer edit. */
  rev: number;
  steps: StepDef[];
}

/** An accepted output of a completed run. Immutable; a rerun produces a new version. */
export interface Artifact {
  id: string;
  taskId: string;
  stepId: string;
  attemptId: string;
  name: string;
  kind: ArtifactKind;
  version: number;
  summary: string;
  /**
   * For review-findings: number of unresolved findings. Structured artifacts: the service-computed
   * blocking count (error or warning findings with action auto-fix or ask-user); the worker's number is ignored.
   */
  openFindings?: number;
  /** ORC-013: structured findings. Absent on summary-only (legacy) artifacts, which keep `openFindings` semantics. */
  findings?: Finding[];
  /** ORC-013: code reviews of a change: whether the review accounted for every changed file. */
  pathCoverage?: PathCoverage;
  /** ORC-013: check-results artifacts. */
  checkRun?: CheckRunRecord;
  /** A durable reference, e.g. the commit SHA and branch holding a code change. */
  ref?: string;
  createdAt: string;
  /** Breakdown artifacts: the work items (each becomes a child task). */
  items?: unknown[];
  /** "user" when a person edited or replaced this output (attemptId is then "edit"). */
  author?: "user";
  /** Why the person changed it. */
  editReason?: string;
}

/** A consumed input, recorded in the run snapshot. */
export interface ConsumedInput {
  step: string;
  output: string;
  artifactId: string;
  version: number;
}

export interface Step extends StepDef {
  /** Explicit user selection (pinned). null means inherited. */
  selection: ModelSelection | null;
  /** Configuration revision; bumps on any selection change. */
  revision: number;
  state: StepState;
  blockedReason?: string;
  /** Set when an upstream rerun invalidated this step's earlier result. */
  invalidatedBy?: string;
  /** Automatic retries used since the step last succeeded. */
  autoRetries?: number;
  /** ORC-013: clean code reviews that did not account for every changed file are run again once with the gap named. */
  coverageRetries?: number;
  coverageGap?: { missing: string[]; extra: string[] };
}

export type SelectionSource = "step" | "task-role" | "independence" | "project-role" | "project-default" | "service";

/** Immutable configuration captured at dispatch. Never rewritten. */
export interface RunSnapshot {
  /** The provider that ran it; "service" for a check run (ORC-013). */
  provider: Runner;
  model: string;
  source: SelectionSource;
  routingReason: string;
  specRev: number;
  stepRev: number;
  visionRev: number;
  workspace: string;
  pipelineRev: number;
  /** The worker environment the run was started with (absent on runs from before the setting existed). */
  environment?: WorkerEnvironment;
  /** Connections (MCP servers) an isolated run was allowed to use. */
  connections?: string[];
  /** The instruction the worker received for this step. */
  purpose: string;
  /** Exactly the upstream artifact versions this run received as context. */
  inputs: ConsumedInput[];
  /** A dedicated delivery review: the commit its read-only worktree was detached at. */
  reviewedSha?: string;
  /** ORC-013: a service check run: the settings and commands it was started with. */
  checks?: {
    configRev: number;
    sandbox: "codex" | "none";
    target: { artifactId: string; ref: string };
    commands: { id: string; label: string; kind: "prepare" | "check"; argv: string[]; timeoutMs: number }[];
    reusedFrom?: string;
  };
}

export type AttemptOutcome =
  | "running"
  | "stopping"
  | "stopped" // acknowledged stop; partial work checkpointed
  | "completed" // result accepted
  | "discarded" // result arrived for a superseded revision; not integrated
  | "failed"
  | "lost"; // the run's process no longer exists (for example after a service restart)

export interface Attempt {
  id: string;
  taskId: string;
  stepId: string;
  snapshot: RunSnapshot;
  startedAt: string;
  endedAt?: string;
  outcome: AttemptOutcome;
  progress: number; // 0..100, simulated
  /** When stop was requested (for ack timeout). */
  stopRequestedAt?: string;
  stopReason?: "pause" | "revision" | "cancel" | "model-change" | "project-pause";
  artifacts: string[];
  note?: string;
  /** Provider session/thread id, for evidence and diagnostics. */
  sessionId?: string;
  /** The model the provider reported actually running (may differ from an alias in the snapshot). */
  actualModel?: string;
  /** Latest meaningful milestone reported by the runtime. */
  activity?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /**
   * ORC-013: the changed-path set of the change a review run was shown, recorded by the service before
   * the run could report anything. `paths` holds at most 500; `total` is the real count.
   */
  scope?: { from: string; to: string; paths: string[]; total: number };
  /** ORC-013: the repository instruction files the run was given as project conventions, as evidence. */
  conventions?: { file: string; blob: string; bytes: number; truncated: boolean }[];
}

export type Lifecycle = "proposed" | "ready" | "active" | "done" | "cancelled";

export interface ControlFailure {
  at: string;
  message: string;
}

export interface Task {
  id: string;
  priority: number; // 1 = highest
  lifecycle: Lifecycle;
  /** Desired state: user hold. Only the user clears it. */
  hold: boolean;
  /** Guaranteed review opportunity before first dispatch. */
  holdBeforeStart: boolean;
  specs: SpecRevision[];
  steps: Step[];
  roleOverrides: Partial<Record<RoleId, ModelSelection>>;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  /** Last spec decision (selection) change; drives the "new decision" badge. */
  decisionAt: string;
  controlFailure?: ControlFailure;
  /** Set when the task is done: whether its work reached the integration branch. */
  integration?: Integration;
  /** Pause after every step for review (optional step-by-step mode). */
  reviewEveryStep?: boolean;
  /** Set when a breakdown step of another task created this task. */
  parentTaskId?: string;
  /** The breakdown step and artifact that created this task. */
  parentStepId?: string;
  parentArtifactId?: string;
  /** Breakdowns waiting at a review gate: children are created from the latest version on resume. */
  pendingBreakdowns?: { stepId: string; output: string }[];
  /** Best-of groups: the copy (step id) chosen by the step that compared them. */
  bestOf?: Record<string, string>;
  /** Best-of groups a person chose (group → when). A later comparison does not override them. */
  bestOfByUser?: Record<string, string>;
  /** Set when this task was paused because an ancestor was paused; resuming that ancestor resumes it. */
  pausedWith?: string;
  /** Why the task is held, when a review gate (not a person) paused it. */
  holdReason?: string;
  followUpOf?: string;
  /** A repair whose final commit is pushed onto that task's pull request instead of opening its own. */
  deliverInto?: { taskId: string; n: number; mergeBase: boolean };
  /** A dedicated review of that task's pull request at exactly this head. */
  reviewTarget?: { taskId: string; n: number; headSha: string; baseSha: string };
  /** A revert of that task's landed commit: the first writer's worktree starts with the revert prepared. */
  revertOf?: { taskId: string; commit: string };
  /** Who cancelled the task. A dedicated review the user cancelled is not started again by the service. */
  cancelledBy?: Actor;
  /** ORC-009: explicit user choices the lead must not override (ISO time the user made them). */
  userSet?: { priority?: string; run?: string };
  /** ORC-009, dispatch-only: no new step starts on this task or its descendants. Never a hold. */
  deferral?: Deferral;
  /** ORC-009: the lead dropped (cancelled) its own unstarted proposal; what reopen restores. */
  dropped?: { changeSetId: string; lifecycle: "proposed" | "ready"; at: string };
  /** ORC-012: proposed while shaping (the roadmap). Held until the user starts building; released then on Autopilot. */
  fromShaping?: boolean;
  /**
   * ORC-012 review 2: the roadmap's own hold, distinct from the user's `holdBeforeStart`. Set on
   * proposals made while shaping; cleared by Start building (which then applies the involvement
   * setting) and by any hold change the user makes on the task.
   */
  heldForShaping?: boolean;
  /** ORC-013: a dedicated check run of that task's pull-request change at exactly this commit. */
  checkTarget?: { taskId: string; n: number; sha: string };
  /** ORC-013: repair rounds added after failing final checks (at most 2). */
  checkRounds?: number;
  pipelineRev: number;
  pipelineHistory: PipelineRevision[];
  legacySpecUnavailable?: boolean;
}

export interface PipelineRevision {
  rev: number;
  at: string;
  author: Actor;
  reason: string;
  steps: StepDef[];
}

export type EventKind =
  | "spec"
  | "decision"
  | "control"
  | "dispatch"
  | "runtime"
  | "integration"
  | "config"
  | "vision"
  | "blocked"
  | "pipeline";

export interface ActivityEvent {
  id: string;
  at: string;
  actor: Actor;
  kind: EventKind;
  taskId?: string;
  message: string;
}

export interface State {
  version: 14;
  seq: number;
  project: Project;
  tasks: Task[];
  attempts: Attempt[];
  artifacts: Artifact[];
  events: ActivityEvent[];
  conversation: Message[];
  leadRuns: LeadRun[];
  /** ORC-009: the last 200 steering change sets; events keep the full record. */
  steering: SteeringChangeSet[];
  /** ORC-012: the last 50 vision drafts; accepted ones live on as vision revisions. */
  visionDrafts: VisionDraft[];
  /** ORC-013: decisions on findings (at most 2000; decided ones of settled tasks are pruned first, open ones never). */
  decisions: FindingDecision[];
}

/** One entry in the lead conversation. */
export interface Message {
  id: string;
  at: string;
  author: "user" | "lead" | "system";
  text: string;
  /** For lead messages: the run that wrote it. */
  leadRunId?: string;
  /** Tasks the lead proposed in this message. */
  proposedTaskIds?: string[];
  /** Proposals the service rejected, with reasons. */
  rejected?: string[];
  /** ORC-009, lead messages: the steering change set this reply carried. */
  changeSetId?: string;
  /** ORC-012, lead messages: the vision draft this reply carried. */
  visionDraftId?: string;
  /** ORC-012, lead messages: the questions this reply asked (validated; at most 5). */
  questions?: LeadQuestion[];
  /** ORC-009, user messages: the task page the message was sent from. */
  taskId?: string;
}

/** ORC-013: "decisions": a run started because findings routed to the lead wait for its decision. */
export type LeadTrigger = "message" | "planning" | "decisions";

/** A run of the lead agent. Separate from task attempts: at most one is active at a time. */
export interface LeadRun {
  id: string;
  trigger: LeadTrigger;
  provider: ProviderId;
  model: string;
  startedAt: string;
  endedAt?: string;
  outcome: "running" | "stopping" | "stopped" | "completed" | "failed" | "lost";
  /** User messages this run answers. */
  messageIds: string[];
  stopRequestedAt?: string;
  activity?: string;
  sessionId?: string;
  actualModel?: string;
  usage?: Attempt["usage"];
  note?: string;
  /** ORC-009: the vision revision the run started from. Absent on runs from before steering existed (they cannot steer). */
  visionRev?: number;
  /** ORC-009: the change set this run's reply produced. */
  changeSetId?: string;
  /** ORC-012: the coverage this run reported (message runs only; the latest one stands). */
  coverage?: Coverage;
}

/** Bounds on the lead's own initiative. Off until the user turns it on. */
export interface Autonomy {
  enabled: boolean;
  /** Minimum time between planning runs (task completions may wake the lead sooner). */
  planningIntervalMinutes: number;
  maxProposalsPerCycle: number;
  /** No planning while this many lead-proposed tasks are still unfinished. */
  maxOpenProposals: number;
  /** Lead proposals wait for the user's release before their first dispatch. */
  holdLeadProposals: boolean;
  /** Local-time window "HH:MM"–"HH:MM" for autonomous planning; null = any time. */
  operatingHours: { start: string; end: string } | null;
  /** Automatic retries of a failed step before it waits for a person (0 = always wait). */
  autoRetry: number;
  /**
   * Deliver integrated work to a branch of the user's repository automatically. The service merges
   * that branch into the integration branch first, so delivery is a fast-forward; it only updates a
   * checked-out branch when the working tree is clean.
   */
  autoDeliver: { enabled: boolean; branch: string };
}

export const DEFAULT_AUTONOMY: Autonomy = {
  enabled: false,
  planningIntervalMinutes: 60,
  maxProposalsPerCycle: 3,
  maxOpenProposals: 5,
  holdLeadProposals: false,
  operatingHours: null,
  autoRetry: 0,
  autoDeliver: { enabled: false, branch: "main" },
};

/** Everything runs without waiting for a person; every control still works when you want to step in. */
export const AUTOPILOT: Omit<Autonomy, "operatingHours" | "autoDeliver"> & { autoDeliverEnabled: true } = {
  enabled: true,
  planningIntervalMinutes: 30,
  maxProposalsPerCycle: 5,
  maxOpenProposals: 15,
  holdLeadProposals: false,
  autoRetry: 1,
  autoDeliverEnabled: true,
};

/** Merging a finished task's work into the project's integration branch. */
export interface Integration {
  status: "pending" | "integrated" | "conflict" | "not-needed";
  at?: string;
  /** Merge commit on the integration branch, or the conflict description. */
  ref?: string;
  message?: string;
  /** Automatic delivery to the user's branch, when enabled. */
  delivered?: { status: "delivered" | "skipped" | "conflict" | "blocked"; at: string; message: string };
  /** Full SHA of the merge commit on the integration branch (local integration). */
  sha?: string;
  /** Pull-request delivery of this task, when that mode built one. */
  pr?: PrDelivery;
  /** The review-later item: present once the work reached its target branch. Never backfilled. */
  landed?: Landed;
}

// ---------- pull-request delivery and the review-later queue (ORC-008) ----------

/** Desired: Project.prDelivery. */
export interface PrDeliveryConfig {
  /** Never true together with autonomy.autoDeliver.enabled. */
  enabled: boolean;
  /** /^[A-Za-z0-9._-]{1,100}$/ */
  remote: string;
  /** /^[A-Za-z0-9._/-]{1,100}$/ */
  base: string;
  merge: "hold" | "auto";
  reviewer: "other-provider" | "any-agent";
  /** An auto-merge candidate is brought up to date with the base first. */
  updateBeforeMerge: boolean;
  /** Auto mode only, bounded. */
  autoRepair: boolean;
  /** Globs; a touched path turns auto into hold. At most 20 entries of at most 200 characters. */
  protectedPaths: string[];
  /** Auto is unavailable while an enabled provider's workerEnvironment is "local", unless this is set. */
  allowLocalWorkers: boolean;
  /** 1–20 */
  maxOpenPrs: number;
  /** 0–100 */
  maxAutoMergesPerDay: number;
  /** ORC-013: re-runs of a GitHub Actions job GitHub cancelled, per check name per head (0–3). */
  rerunBudget: number;
  /** ORC-013: GitHub app slugs whose failing checks are a bot's opinion, never fixed automatically (≤10). */
  reviewBotApps: string[];
  /** ORC-013: the user declares the repository has no CI; their own Merge then works with zero checks. */
  noCi: boolean;
}

export const DEFAULT_PR_DELIVERY: PrDeliveryConfig = {
  enabled: false,
  remote: "origin",
  base: "main",
  merge: "hold",
  reviewer: "other-provider",
  updateBeforeMerge: true,
  autoRepair: true,
  protectedPaths: [".github/**", "package.json", "tsconfig*.json", "vitest.config.*", "vite.config.*"],
  allowLocalWorkers: false,
  maxOpenPrs: 5,
  maxAutoMergesPerDay: 20,
  rerunBudget: 1,
  reviewBotApps: [...DEFAULT_REVIEW_BOTS],
  noCi: false,
};

export interface PostureItem {
  id: string;
  status: "ok" | "warn" | "fail" | "unverified";
  label: string;
  detail: string;
}

/** Observed: Project.github. */
export interface GitHubStatus {
  simulated?: boolean;
  /** Set by recheckGitHub (and by switching pull-request delivery on): run the read-only preflight now. */
  recheck?: boolean;
  checkedAt?: string;
  /** false: no GitHub operation except preflight. */
  ok: boolean;
  problem?: {
    code: "gh-missing" | "gh-old" | "git-old" | "auth" | "remote" | "permission" | "rate-limit" | "network";
    message: string;
    since: string;
    retryAt?: string;
  };
  /** "owner/name", parsed from the remote URL. */
  repo?: string;
  login?: string;
  ghVersion?: string;
  /** From the rules and protection APIs, never hard-coded. */
  requiredChecks: string[];
  /** Empty: auto mode is available. */
  autoMergeBlockers: string[];
  posture: PostureItem[];
  /** Value of refs/orchestration/<pid>/base. */
  base?: { sha: string; fetchedAt: string };
  observedAt?: string;
  rateRemaining?: number;
  lastMutationAt?: string;
  mutations?: { hour: string; count: number };
  autoMerges?: { day: string; count: number };
  /** Times (at most 24 h old) a merge made by the app was followed by a failed check on the base branch. */
  mainBreaks?: string[];
  autoMergePaused?: { since: string; reason: string; sticky: boolean; taskId?: string };
  /** The base branch requires a merge queue: `gh pr merge` would enqueue or enable GitHub's own auto-merge, so the app never merges here. */
  mergeQueue?: boolean;
  /** false: the repository does not allow merge commits, the only way the app merges. */
  mergeCommitsAllowed?: boolean;
  /** Fetches of the base that failed in a row. A passing repository check does not reset it; a fetch that works does. */
  fetchFailures?: { count: number; since: string; nextAt: string; message: string };
}

export interface CheckObs {
  name: string;
  required: boolean;
  status: string;
  conclusion: string | null;
  url?: string;
  /** ORC-013: a check run or a status context. */
  kind?: "run" | "status";
  /** ORC-013: the check suite's app slug, or the status creator's login. */
  app?: string;
  /** ORC-013: the check run's database id (a GitHub Actions job id when app is "github-actions"). */
  jobId?: number;
  runId?: number;
  startedAt?: string;
}

export type PrAttentionCode =
  | "foreign-commits"
  | "workflow-change"
  | "remote-diverged"
  | "foreign-push"
  | "draft"
  | "base-changed"
  | "checks-failed"
  | "checks-missing"
  | "checks-timeout"
  | "non-required-failing"
  | "review-findings"
  | "review-blocked"
  | "review-limit"
  | "conflict"
  | "approval-required"
  | "github-blocked"
  | "changes-requested"
  | "hold-label"
  | "merge-rejected"
  | "protected-path"
  | "local-workers"
  | "auto-unavailable"
  | "limit"
  | "repo-changed"
  | "publish-failed"
  // ORC-013
  | "findings-decision"
  | "bot-check"
  | "ci-infra"
  | "checks-skipped"
  | "service-checks";

/** Per task: Integration.pr. Desired state, intent and observed state are separate fields. */
/**
 * Who wrote a change. "user": a person supplied the commit. "unknown": the run that produced it is not
 * on record; nothing is assumed about it, so no agent's review counts as independent of it.
 */
export type ChangeAuthor = ProviderId | "user" | "unknown";

export interface PrDelivery {
  /** 1; +1 on redeliver (the branch suffix). */
  n: number;
  repo: string;
  remote: string;
  base: string;
  /** orchestration/<pid>/pr/<taskId>-<n> */
  branch: string;
  simulated?: boolean;
  /** Newest agent-authored commit: what the review must cover. */
  changeSha: string;
  /** Task whose final change is changeSha (the source task, or the latest repair). */
  changeTaskId: string;
  /** Who wrote changeSha: the provider of the run that produced it, the user, or unknown. */
  changeAuthor: ChangeAuthor;
  /**
   * Everyone who authored a change this pull request holds: the task's own coder runs and every fix
   * pushed onto it. A review counts as independent only when its provider is none of them. Absent on
   * records made before the set was kept (then it is `changeAuthor` alone).
   */
  changeAuthors?: ChangeAuthor[];
  /** What the app pushed: changeSha, or a service merge of the base into it. */
  headSha: string;
  /** Base tip contained in headSha. */
  baseSha: string;
  pendingHead?: { sha: string; changeSha: string; changeTaskId: string; changeAuthor: ChangeAuthor; changeAuthors?: ChangeAuthor[]; baseSha: string; kind: "update" | "repair" };
  /** paths: at most 50. */
  changed: { files: number; additions: number; deletions: number; paths: string[]; protectedHits: string[]; workflowHits: string[] };
  // desired
  policy: "hold" | "auto";
  policySource: "project" | "user";
  /** Cleared only by the user; survives project resume. */
  userHold?: { at: string; reason?: string };
  /** The user's Merge click, bound to the head they saw. */
  mergeRequested?: { at: string; headSha: string };
  /** The last merge the app sent for a head. Kept after the intent is cleared, so a merge GitHub reports late is still attributed to the app. */
  lastMergeIntent?: { at: string; headSha: string; auto: boolean };
  workflowPushAllowed?: boolean;
  closeRequested?: { at: string };
  /** The pull request was closed from the app at the user's request (not by someone on GitHub). */
  closedByRequest?: boolean;
  // intent
  phase: "built" | "open" | "merged" | "closed";
  op?: { id: string; kind: "publish" | "push" | "merge" | "close"; at: string; headSha: string };
  // observed and recorded
  number?: number;
  url?: string;
  observed?: {
    at: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    isDraft: boolean;
    crossRepo: boolean;
    headSha: string;
    baseRef: string;
    mergeable: string;
    mergeStateStatus: string;
    reviewDecision: string | null;
    labels: string[];
    checks: CheckObs[];
    checksFor: string;
    mergedAt?: string;
    mergeCommit?: string;
    mergedBy?: string;
    closedBy?: string;
  };
  review: ReviewEvidence;
  reviewTaskIds: string[];
  repairTaskIds: string[];
  /** Sticky: someone else pushed to the branch. */
  foreignHead?: { sha: string; at: string };
  /** The service could not merge this base tip into this head cleanly (a local check; nothing was pushed). */
  baseConflict?: { baseSha: string; headSha: string; files: string[] };
  attention?: { code: PrAttentionCode; message: string; headSha?: string; since: string };
  /** ORC-013: `reruns` and `checks` default to 0 on records from before they existed. */
  counters: { mergeAttempts: number; baseUpdates: number; repairs: number; reviews: number; failures: number; reruns?: number; checks?: number };
  /** ORC-013: service-check evidence for `changeSha` under the current check settings. */
  checks?: CheckEvidence;
  /** ORC-013: re-runs of GitHub-cancelled jobs requested for the current head. */
  ciReruns?: { headSha: string; used: { check: string; jobId: number; at: string; opId: string }[] };
  /** Backoff after a failed operation. */
  nextAt?: string;
  /** When headSha was first observed on GitHub (check timeouts). */
  headSince?: string;
  /** Last error, redacted, at most 300 characters. */
  message?: string;
}

export interface ReviewEvidence {
  ok: boolean;
  source: "pipeline" | "dedicated" | "none";
  reason: string;
  forSha?: string;
  taskId?: string;
  attemptId?: string;
  provider?: ProviderId;
  model?: string;
  artifactIds: string[];
  clearedByUser?: boolean;
  /** ORC-013: findings someone decided to accept as they are (ids like "F2 title"); the review is clean apart from them. */
  accepted?: string[];
}

export type LandedFlag = "main-check-failed" | "merged-without-clean-gate" | "findings-cleared-by-user" | "protected-paths" | "checks-accepted-failing" | "checks-not-run" | "findings-accepted";

export interface LandedNote {
  id: string;
  at: string;
  text: string;
  /** Present only when the user chose to post this note on the pull request. "posted" needs a URL. */
  comment?: { status: "pending" | "posted" | "failed"; url?: string; error?: string; attempts: number };
}

/**
 * Per task: Integration.landed, the review-later item. Informational: nothing reads it to decide
 * dispatch, integration or merging, and `status` changes only through the user's explicit commands.
 */
export interface Landed {
  at: string;
  via: "pr" | "local";
  /** "owner/name main" for a pull request; the branch name for local delivery. */
  target: string;
  /** Full SHA: GitHub's merge commit, or the task's merge commit on the integration branch. */
  commit: string;
  simulated?: boolean;
  by: "app" | "person";
  mergedBy?: string;
  /** `repo`: the repository the pull request lives in ("owner/name"); the app acts on it only there. */
  pr?: { number: number; url: string; repo?: string };
  /** As it stood at merge. */
  review?: ReviewEvidence;
  /** Required checks on the merged head. */
  checks?: CheckObs[];
  mainCheck?: { state: "pending" | "success" | "failure" | "unknown"; at: string; url?: string };
  flags: LandedFlag[];
  status: "unreviewed" | "reviewed" | "sent-back";
  statusAt?: string;
  notes: LandedNote[];
  followUps: { taskId: string; kind: "fix" | "revert" }[];
}

export class StaleWriteError extends Error {
  expected: number;
  actual: number;
  constructor(expected: number, actual: number) {
    super(`Stale write: edited revision ${expected}, current is ${actual}. Reload and reconcile.`);
    this.name = "StaleWriteError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}
