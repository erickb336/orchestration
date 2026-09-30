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
  /** Desired state: project-wide pause. */
  hold: boolean;
  lastVisitAt: string;
  templates: WorkflowTemplate[];
}

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
  createdAt: string;
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
  | "failed";

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
  version: 3;
  seq: number;
  project: Project;
  tasks: Task[];
  attempts: Attempt[];
  artifacts: Artifact[];
  events: ActivityEvent[];
}

export class StaleWriteError extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(`Stale write: edited revision ${expected}, current is ${actual}. Reload and reconcile.`);
    this.name = "StaleWriteError";
  }
}

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}
