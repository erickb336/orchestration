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

export type ArtifactKind = "brief" | "design" | "plan" | "code-change" | "review-findings" | "verification" | "report" | "handoff" | "breakdown";
export const ARTIFACT_KINDS: ArtifactKind[] = ["brief", "design", "plan", "breakdown", "code-change", "review-findings", "verification", "report", "handoff"];

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
}

export type SelectionSource = "step" | "task-role" | "independence" | "project-role" | "project-default";

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
  /** A dedicated delivery review: the commit its read-only worktree was detached at. */
  reviewedSha?: string;
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
  version: 10;
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
  | "publish-failed";

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
  counters: { mergeAttempts: number; baseUpdates: number; repairs: number; reviews: number; failures: number };
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
}

export type LandedFlag = "main-check-failed" | "merged-without-clean-gate" | "findings-cleared-by-user" | "protected-paths";

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
