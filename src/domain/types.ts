// Core domain types. Pure data: no UI, storage, or runtime dependencies.

export type ProviderId = "claude" | "codex";
export const PROVIDERS: ProviderId[] = ["claude", "codex"];

export type RoleId = "lead" | "designer" | "coder" | "code_reviewer" | "ux_reviewer";
export const ROLES: RoleId[] = ["lead", "designer", "coder", "code_reviewer", "ux_reviewer"];
export const REVIEW_ROLES: RoleId[] = ["code_reviewer", "ux_reviewer"];

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

export type ArtifactKind = "brief" | "design" | "plan" | "code-change" | "review-findings" | "verification" | "report" | "handoff";
export const ARTIFACT_KINDS: ArtifactKind[] = ["brief", "design", "plan", "code-change", "review-findings", "verification", "report", "handoff"];

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
  /** For review-findings: number of unresolved findings. */
  openFindings?: number;
  /** A durable reference, e.g. the commit SHA and branch holding a code change. */
  ref?: string;
  createdAt: string;
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
}

export type SelectionSource = "step" | "task-role" | "project-role" | "project-default";

/** Immutable configuration captured at dispatch. Never rewritten. */
export interface RunSnapshot {
  provider: ProviderId;
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
  /** Why the task is held, when a review gate (not a person) paused it. */
  holdReason?: string;
  followUpOf?: string;
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
  version: 9;
  seq: number;
  project: Project;
  tasks: Task[];
  attempts: Attempt[];
  artifacts: Artifact[];
  events: ActivityEvent[];
  conversation: Message[];
  leadRuns: LeadRun[];
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
}

export type LeadTrigger = "message" | "planning";

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
