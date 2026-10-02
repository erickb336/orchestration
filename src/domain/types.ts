// Core domain types. Pure data: no UI, storage, or runtime dependencies.

import type { Blueprint, BudgetEstimate, Studio } from "./studio/types";

export type ProviderId = "claude" | "codex";
export const PROVIDERS: ProviderId[] = ["claude", "codex"];

/** `security_reviewer` reviews a change for security beside the code review; its findings count like the code review's. */
export type RoleId = "lead" | "designer" | "coder" | "code_reviewer" | "security_reviewer" | "ux_reviewer" | "checks";
/** Agent roles: they have role defaults, task role overrides and a resolved provider. */
export const ROLES: RoleId[] = ["lead", "designer", "coder", "code_reviewer", "security_reviewer", "ux_reviewer"];
/** Roles the service runs itself; never resolved to a provider. */
const SERVICE_ROLES: RoleId[] = ["checks"];
/** What a step definition may use. */
export const STEP_ROLES: RoleId[] = [...ROLES, ...SERVICE_ROLES];
/** Roles whose findings gate repairs and merges. */
export const REVIEW_ROLES: RoleId[] = ["code_reviewer", "security_reviewer", "ux_reviewer"];

/** Who runs an attempt: a provider's agent, or the service itself (check runs). */
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
   * Where a revision came from when it was not typed by hand. A lead focus change names its
   * change set, run and the user's messages; an Undo names the set it undid; an applied suggestion
   * names its set only. An accepted vision draft names the draft, its run and messages.
   * A document attached or removed names it (`docAdded` / `docRemoved`; a replacement names both).
   * A batch of documents attached as one revision lists them (`docsAdded`, the copies they replaced in
   * `docsRemoved`) and the batch the client named.
   */
  source?: { changeSetId?: string; leadRunId?: string; messageIds?: string[]; undoOf?: string; draftId?: string; docAdded?: string; docRemoved?: string; docsAdded?: string[]; docsRemoved?: string[]; batchId?: string };
  /**
   * The vision documents that applied at this revision (ids into `Project.visionDocs`), so
   * history stays truthful. Absent on revisions from before documents existed: none applied.
   */
  docIds?: string[];
  /**
   * The text of this revision was written by the simulated lead (the fake runtime): a lead focus
   * change from such a run, or a draft from one that the user accepted. Set by the store from the lead
   * run's runtime, never from the text itself. Absent on revisions a person or a real lead wrote.
   */
  simulated?: true;
}

// ---------- vision documents ----------

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
   * Uploaded but not attached yet: it waits for its batch's `attachVisionDocs`, which
   * attaches every file of one Add, drop or folder as one vision revision. Absent once attached. A
   * staged record whose batch never commits is dropped after an hour.
   */
  stagedAt?: string;
}

// ---------- shaping the vision with the lead first ----------

/**
 * "shaping" (Vision): the user and the lead shape the vision; no worker step runs and no planning run starts.
 * Every project begins here. "building" (Factory): everything runs as usual; only the owner's `startFactory`
 * gets here.
 */
export type ProjectStage = "shaping" | "building";

/** What the product is designed and shown for: the device scope, chosen in Vision. */
export type Device = "desktop" | "mobile" | "terminal";
export const DEVICES: Device[] = ["desktop", "mobile", "terminal"];

/** How the factory runs, set by the owner when they start it (and changeable later through the usual settings). */
export interface FactorySettings {
  /** Autopilot: nothing waits for a person. Check-in: the lead plans, and its tasks wait for your go-ahead. Manual: the lead does not plan. */
  autonomy: "autopilot" | "checkin" | "manual";
  /** How finished work is delivered, and who merges it. The start applies it as given; nothing else changes it. */
  delivery: FactoryDelivery;
  pausePoints: {
    /**
     * Findings that ask for a decision: the PE decides (within budget), or you do. "lead" is the lead's route a project
     * may already have (ORC-013): the start keeps whichever route the owner leaves in place.
     */
    tradeoffs: "lead" | "pe" | "user";
    /** A blueprint change after the start: the lead updates the affected tasks, or asks you first. */
    changeOrders: "lead" | "user";
    /** New tasks wait for your go-ahead before they start. */
    startEachTask: boolean;
  };
}

/**
 * Delivery as the factory runs it, and who merges.
 * - off: finished work stays on the integration branch, and you merge it;
 * - local: each finished task is fast-forwarded onto `branch` automatically;
 * - pr: GitHub pull requests against `branch` (their base), merged by you or automatically.
 * A combination that contradicts itself (local delivery that you merge, or automatic merging with delivery off) is
 * refused, never adjusted.
 */
export interface FactoryDelivery {
  mode: "off" | "local" | "pr";
  /** The branch it delivers to: local delivery's branch, or the pull requests' base. None while delivery is off. */
  branch?: string;
  merge: "user" | "auto";
}

/** The owner's agreement that started the factory: who, when, what they agreed to, and how it runs. */
export interface FactoryStart {
  at: string;
  by: "user";
  /** The blueprint revision agreed to; 0 when nothing was approved yet. */
  blueprintRev: number;
  /** The vision revision agreed to: the blueprint stands on the vision, which changes on its own. */
  visionRev: number;
  settings: FactorySettings;
  /** What was still open, named to the owner and confirmed: the vision's open areas, then the blueprint's open items and the unfinished probes (by id). */
  openItems: string[];
  /** The pre-flight's budget estimates, once the PE makes them. */
  estimate?: { buildUsd?: [number, number]; maintenanceUsdPerMonth?: [number, number]; basis: string };
}

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
  /** Drafted by the simulated lead (the fake runtime). Carried onto the revision when the draft is accepted. */
  simulated?: true;
}

// ---------- steering by conversation ----------

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
type SteeringValue = string | number | Deferral | null;

export interface SteeringChange {
  /** `${setId}.${n}` */
  id: string;
  /** "invalid": an entry the service could not read as one of the actions (always rejected). "note": a note to a running stage. */
  kind: "focus" | "priority" | "defer" | "undefer" | "drop" | "note" | "invalid";
  taskId?: string;
  /** Notes: the step the note is addressed to. */
  stepId?: string;
  /** focus text | priority | deferral | lifecycle | note text */
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
  /** Notes: the `Note` record once the note was sent ("applied" means sent; the row shows the note's live status). */
  noteId?: string;
  /** Notes: what the lead asked for when the step had already finished ("report" when absent). */
  ifFinished?: "report" | "rerun";
  /** Notes: a suggested rerun of the finished step with the note (the row offers "Rerun with this note"). */
  rerun?: true;
}

// ---------- notes to a running stage ----------

/**
 * Desired state apart from observed state. "queued": accepted, waiting for a run of the step. "sending":
 * handed to the runtime (or bound to a run that is starting), not yet acknowledged. "delivered": the runtime
 * acknowledged it (`via` says how). "not-delivered": it reached no agent; `reason` says why.
 */
type NoteStatus = "queued" | "sending" | "delivered" | "not-delivered";

/** Who sent a note: the lead (from a reply to the user's messages, as a row of its change set) or the user directly. */
export type NoteSource = { by: "lead"; leadRunId: string; changeSetId: string; changeId: string; messageIds: string[] } | { by: "user" };

/** A short instruction for the agent running one step of one task. It never changes the spec, the pipeline, a pin or a setting. */
export interface Note {
  /** `note-${seq}` */
  id: string;
  taskId: string;
  stepId: string;
  /** The run it went to, once known. A result for another run is ignored. */
  attemptId?: string;
  /** 1–500 characters, one paragraph. */
  text: string;
  from: NoteSource;
  at: string;
  status: NoteStatus;
  /** "live": pushed into a running agent. "start": written into the instructions of the step's next run. */
  via?: "live" | "start";
  /** not-delivered: why. */
  reason?: string;
  /** When it was handed to the runtime or bound to a starting run. */
  sentAt?: string;
  /** When it was delivered or found undeliverable. */
  settledAt?: string;
  /** The note arrived while the agent was still starting, and the runtime held it until the agent's turn began (Codex). */
  heldForTurn?: true;
  /** The acknowledgment (or the note itself) came from the fake runtime. The UI labels it. */
  simulated?: true;
}

/** Caps on notes: per lead reply, per run, and in the state (settled notes of finished tasks are pruned first). */
export const MAX_NOTES_PER_REPLY = 3;
export const MAX_NOTES_PER_RUN = 10;
export const MAX_NOTES = 2000;
export const MAX_NOTE_LENGTH = 500;

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
  /** The reply that carried this set came from the simulated lead (the fake runtime). Set by the store from the run's runtime. */
  simulated?: true;
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
  /** Every document ever attached to the vision (the current set is the current revision's `docIds`). */
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
  /** Apply the lead's steering, apply it to the lead's own work only, or only suggest. Default "apply". */
  steeringMode: SteeringMode;
  /** Shaping (talk it through with the lead; nothing runs) or building (everything runs). */
  stage: ProjectStage;
  /** The device scope: what is designed and shown. Set in Vision; at least one. */
  devices: Device[];
  /** Every Start the factory, oldest first: the owner's recorded agreements. Projects building before ORC-029 have none. */
  factoryStarts: FactoryStart[];
  /**
   * Who acts first on a change order (a blueprint revision while building): the lead updates the affected tasks, or
   * it waits for you (Needs you). A pause point of the factory's settings; set by Start the factory and by
   * `setChangeOrders`, and read when a change order is made. The other pause points live in their own settings.
   */
  changeOrders: "lead" | "user";
  /**
   * PE review of new work in the factory (ORC-029 2e): while true, the lead's proposals and breakdown items made while
   * building, and the lead's updates for a change order, wait for the PE's agreement before they start. Absent (off)
   * until the PE's review runs exist (pass 5), so nothing waits for a review nobody runs.
   */
  peReviewsNewWork?: boolean;
  /** When the current shaping session began; coverage reported before it is not reused. */
  shapingSince?: string;
  /** The project's own check commands, run by the service. Desired state; only the user's `setChecks` writes it. */
  checks: ChecksConfig;
  /** The checks sandbox as last probed. Observed; written only by the service. */
  checksHealth?: ChecksHealth;
  /**
   * Who decides `ask-user` findings: the lead (Autopilot's default), the PE, or the user. Until the PE runs its
   * own decisions (ORC-029), a decision routed to the PE goes to the lead's decision runs.
   */
  triage: { askUserBy: "lead" | "pe" | "user" };
  /** The owner's budgets, in dollars; null until set. Only `setBudgets` writes them. */
  budgets: Budgets;
  /**
   * The owner chose to continue past the building budget they had set (`continuePastBudget`). It lasts while
   * the building budget stays at that amount and the project stays building.
   */
  budgetContinued?: { at: string; buildingUsd: number; spentUsd: number };
  /** Give every run the repository's AGENTS.md and CLAUDE.md from the trusted base as labelled project conventions. */
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
  /**
   * The flow used when a lead proposal or a breakdown item names none, and when nothing else
   * chooses. Any of the six; when it is not in the catalog, `effectiveDefault` falls back to "change"
   * without rewriting this field.
   */
  defaultFlowId: string;
}

/**
 * The owner's budgets. Building: the estimated agent spend to build the project, at the providers'
 * published prices; at it, nothing new starts. Maintenance: the estimated monthly cost of running it.
 */
export interface Budgets {
  buildingUsd: number | null;
  maintenanceUsdPerMonth: number | null;
}

export const NO_BUDGETS: Budgets = { buildingUsd: null, maintenanceUsdPerMonth: null };

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

/**
 * Provider-neutral model defaults for a new project: "auto" resolves against the live catalog. The
 * security reviewer has no default of its own here: without one it follows the code reviewer's.
 */
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

/** The project role default that applies to a role: its own, or for the security reviewer the code reviewer's when it has none. */
export function roleDefaultFor(p: Pick<Project, "roleDefaults">, role: RoleId): ModelSelection | undefined {
  return p.roleDefaults[role] ?? (role === "security_reviewer" ? p.roleDefaults.code_reviewer : undefined);
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
  /** The blueprint items this task builds (ORC-029), by id; each must be in the blueprint. A change order lists the tasks citing a changed item. */
  blueprintRefs?: string[];
}

interface SpecRevision {
  rev: number;
  at: string;
  author: Actor;
  reason: string;
  content: SpecContent;
}

type StepState =
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

// ---------- structured findings, coverage and service checks ----------

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
 * lead, the PE or the user by the project's triage setting; recorded, shown on the task, and given to later
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
  /** "pe": the PE decides, within budget. Until the PE runs its own decisions (ORC-029 pass 4), the lead's decision runs decide for it with the PE's brief. */
  routedTo: "lead" | "pe" | "user";
  /** When it was last routed to its current decider. A lead run for decisions starts only for decisions routed after the lead's last run. */
  routedAt?: string;
  /** "superseded": its task was cancelled, or a later run replaced the artifact while it was still open. */
  status: "open" | "fix" | "accept" | "follow-up" | "superseded";
  /** A lead "fix" on a spec the user wrote: recorded, not applied; the decision stays open for the user. */
  suggestion?: { decision: "fix"; why: string; leadRunId: string; at: string };
  decidedBy?: "lead" | "pe" | "user" | "carried";
  decidedAt?: string;
  /** ≤300 characters */
  why?: string;
  leadRunId?: string;
  /** The PE's call on a decision routed to it (ORC-029 2d), kept when the owner reverses or takes it. */
  pe?: PeCall;
  followUpTaskId?: string;
  /** The decision this one repeats (the same finding decided earlier on this task or its origin task). */
  carriedFrom?: string;
  /** Repair attempts whose envelope carried this decision; a later change applies to later repairs only. */
  usedBy: string[];
  createdAt: string;
}

/**
 * Where PE review of one piece of new work stands (ORC-029 2e): a lead proposal, a breakdown item, or the lead's
 * updates for a change order.
 * - pending: held from starting, "waiting for PE review"; an objection before the last round keeps it pending while
 *   the lead revises it;
 * - agreed: released under the usual involvement rules;
 * - objected: the PE still objected after three rounds, so it waits for the owner (Needs you) with the objection,
 *   until the owner overrules it (recorded). It is never dropped.
 * Only the service records the PE's verdicts (`recordPeReview`), and only the owner overrules.
 */
export interface PeReviewState {
  status: "pending" | "agreed" | "objected";
  /** The PE's verdicts, oldest first: one per round, at most three. `specRev` is the task spec revision it read. */
  rounds: { at: string; verdict: "agree" | "object"; reasons: string; specRev?: number }[];
  overruled?: { at: string; why: string };
}

/**
 * The PE's call on one decision: what it chose, why, and its budget effect as it stated it (what the call adds to the
 * building spend and to the monthly maintenance, as dollar ranges with their basis). The PE does not run its own
 * decisions yet (ORC-029 pass 4): `by: "lead-run"` says a lead decision run made the call with the PE's brief, and
 * `leadRunId` names it. `pastBudget` says why the call went to the owner instead of applying: it would have taken the
 * building spend (with the calls that stand but have not run) or the maintenance estimate past a budget, it stated no
 * figure for a budget that is set, or what it adds cannot be checked because the spend so far is unknown.
 */
export interface PeCall {
  decision: "fix" | "accept" | "follow-up";
  why: string;
  cost?: BudgetEstimate;
  by: "lead-run";
  leadRunId: string;
  at: string;
  pastBudget?: string;
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
  /** When the pending recheck was asked for: a probe that began earlier does not clear it. */
  requestedAt?: string;
  /** `loopback`: a connection to this machine's own 127.0.0.1 and ::1 (where the service listens) must be refused too. */
  probes?: { writeOutside: "denied" | "allowed" | "unknown"; network: "denied" | "allowed" | "unknown"; loopback?: "denied" | "allowed" | "unknown" };
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

/** Structural definition of a step, shared by flows and task pipelines. */
export interface StepDef {
  id: string;
  purpose: string;
  role: RoleId;
  dependsOn: string[];
  inputs: InputRef[];
  outputs: OutputDef[];
  /** Run only if any referenced review-findings artifact has open findings; otherwise skip. */
  runIf?: InputRef[];
  /**
   * Loop: set on the LAST step of a loop body that starts at `from`. When this step completes
   * (and, for a breakdown step, created new child tasks), the service appends the next iteration of
   * the body as new steps, up to `max` iterations. A loop ends early when its last step is skipped
   * (for example a repair with no open findings).
   */
  iterate?: { from: string; max: number };
  /** Do not start this step until every child task created by this task's breakdowns has settled. */
  waitForChildren?: boolean;
  /** A review that must run on another provider than the one that wrote the change under review. */
  independentOf?: "writer";
  /** Set by expansion: which loop iteration this step belongs to (first = 1). */
  iteration?: number;
  /**
   * Role "checks" only. "findings": failing commands become auto-fix findings for the repair
   * step. "block": the step blocks and opens a decision (a Final checks step). `only` limits the step
   * to some command ids; prepare commands always run.
   */
  checks?: { onFail: "findings" | "block"; only?: string[] };
  /**
   * The working principles the step's agent receives, by id (files in principles/), added to its
   * instructions under "Principles for this step". Absent on steps copied before principles existed and
   * on steps that get none (checks steps, for example).
   */
  principles?: string[];
}

/** One principle a run was given, as its snapshot records it. */
export interface GivenPrinciple {
  id: string;
  /** SHA-256 of the principle's body as the run received it. */
  hash: string;
  /** Set when the service added the principle by itself (attack the premise): why, for example 'added: check `test` failed again after S3'. */
  added?: string;
}

// ---------- flows ----------

/**
 * Who chose a task's flow. "default": nothing named one, so the project default applied. "service":
 * a pipeline the service created (fix, revert, delivery review or checks). "follow-up": copied or
 * re-applied from the origin task. "migration": recorded for tasks from before flows existed.
 */
export type ChosenBy = "user" | "lead" | "breakdown" | "default" | "service" | "follow-up" | "migration";

/** Every flow a task can be created from is one of the six files in the repository's flows/ folder. */
type FlowSource = "built-in";

/** One of the six flows, resolved from its file: Change, Bug fix, Feature, Design, Investigation or Goal. */
export interface Flow {
  id: string;
  name: string;
  description: string;
  /** The "use it for" line shown in the picker and in the lead's instructions. */
  whenToUse: string;
  source: FlowSource;
  /** SHA-256 of the canonical steps: what runs. Names, descriptions and comments do not count. Recorded on tasks, never shown. */
  hash: string;
  steps: StepDef[];
  /** An output has the kind `breakdown`: the flow creates child tasks, so a breakdown item may not use it. */
  breaksDown: boolean;
}

/**
 * What a task ran. Recorded on each pipeline revision that applied a flow, and as the task's current
 * one. "internal": a service-owned pipeline. "legacy": made from a template, before templates were
 * retired. "local": from a personal file in ~/.orchestration/patterns, which are no longer read; kept on
 * tasks that ran one.
 * "custom": built by the internal `setPipeline` (tests).
 */
export interface FlowRef {
  id: string;
  name: string;
  source: FlowSource | "internal" | "legacy" | "local" | "custom";
  /** Absent for legacy and custom pipelines. */
  hash?: string;
  chosenBy: ChosenBy;
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
  /** Structured findings. Absent on summary-only (legacy) artifacts, which keep `openFindings` semantics. */
  findings?: Finding[];
  /** Code reviews of a change: whether the review accounted for every changed file. */
  pathCoverage?: PathCoverage;
  /** Check-results artifacts. */
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
  /**
   * The task's pipeline revision when this version was made. Below the task's `flowSince`, the
   * artifact belongs to an earlier flow: kept for the record, never edited or consumed again. Absent on
   * older artifacts, which take it from their attempt's snapshot (an edit from the version it edited).
   */
  pipelineRev?: number;
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
  /** Clean code reviews that did not account for every changed file are run again once with the gap named. */
  coverageRetries?: number;
  /** The gap, bound to the change (`to`) it was found on; a different change starts the count over. */
  coverageGap?: { missing: string[]; extra: string[]; to?: string };
}

export type SelectionSource = "step" | "task-role" | "independence" | "project-role" | "project-default" | "service";

/** Immutable configuration captured at dispatch. Never rewritten. */
export interface RunSnapshot {
  /** The provider that ran it; "service" for a check run. */
  provider: Runner;
  model: string;
  source: SelectionSource;
  routingReason: string;
  specRev: number;
  stepRev: number;
  visionRev: number;
  workspace: string;
  pipelineRev: number;
  /** The step's role at dispatch. Absent on older attempts, which take it from the pipeline revision named by `pipelineRev`. */
  role?: RoleId;
  /** The worker environment the run was started with (absent on runs from before the setting existed). */
  environment?: WorkerEnvironment;
  /** Connections (MCP servers) an isolated run was allowed to use. */
  connections?: string[];
  /** The instruction the worker received for this step. */
  purpose: string;
  /** Exactly the upstream artifact versions this run received as context. */
  inputs: ConsumedInput[];
  /** The principles the run was given, in table order, with any automatic one and its reason. Absent on older runs and on check runs. */
  principles?: GivenPrinciple[];
  /** A dedicated delivery review: the commit its read-only worktree was detached at. */
  reviewedSha?: string;
  /** A service check run: the settings and commands it was started with. */
  checks?: {
    configRev: number;
    sandbox: "codex" | "none";
    target: { artifactId: string; ref: string };
    /** `offline`: a prepare command that runs install scripts in the copy and never gets the network. */
    commands: { id: string; label: string; kind: "prepare" | "check"; argv: string[]; timeoutMs: number; offline?: true }[];
    reusedFrom?: string;
  };
}

type AttemptOutcome =
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
  /** `cachedInputTokens`: of `inputTokens`, those read from the provider's prompt cache (Codex reports them). */
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; costUsd?: number };
  /**
   * The changed-path set of the change a review run was shown, recorded by the service before
   * the run could report anything. `paths` holds at most 500; `total` is the real count.
   */
  scope?: { from: string; to: string; paths: string[]; total: number };
  /** The repository instruction files the run was given as project conventions, as evidence. */
  conventions?: { file: string; blob: string; bytes: number; truncated: boolean }[];
}

type Lifecycle = "proposed" | "ready" | "active" | "done" | "cancelled";

interface ControlFailure {
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
  /** Explicit user choices the lead must not override (ISO time the user made them). */
  userSet?: { priority?: string; run?: string };
  /** Dispatch-only: no new step starts on this task or its descendants. Never a hold. */
  deferral?: Deferral;
  /** The lead dropped (cancelled) its own unstarted proposal; what reopen restores. */
  dropped?: { changeSetId: string; lifecycle: "proposed" | "ready"; at: string };
  /** Proposed while shaping (the roadmap). Held until the user starts building; released then on Autopilot. */
  fromShaping?: boolean;
  /**
   * The roadmap's own hold, distinct from the user's `holdBeforeStart`. Set on
   * proposals made while shaping; cleared by Start building (which then applies the involvement
   * setting) and by any hold change the user makes on the task.
   */
  heldForShaping?: boolean;
  /**
   * PE review of new work in the factory (ORC-029 2e): a lead proposal or a breakdown item waits for the PE's
   * agreement before it starts. Set when it is created, while the project has PE review of new work on; never on a
   * task you create, a delivery task or anything else that changes code (those keep the code and security reviews).
   */
  peReview?: PeReviewState;
  /** A dedicated check run of that task's pull-request change at exactly this commit. */
  checkTarget?: { taskId: string; n: number; sha: string };
  /** Repair rounds added after failing final checks (at most 2). */
  checkRounds?: number;
  pipelineRev: number;
  pipelineHistory: PipelineRevision[];
  legacySpecUnavailable?: boolean;
  /** The flow the current pipeline came from. */
  flow: FlowRef;
  /** The pipeline revision that applied the current flow; 0 for tasks from before flows. */
  flowSince: number;
}

export interface PipelineRevision {
  rev: number;
  at: string;
  author: Actor;
  reason: string;
  steps: StepDef[];
  /** Set on revisions that applied a flow. Expansions and check rounds leave it unset. */
  flow?: FlowRef;
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
  version: 19;
  seq: number;
  project: Project;
  tasks: Task[];
  attempts: Attempt[];
  artifacts: Artifact[];
  events: ActivityEvent[];
  conversation: Message[];
  leadRuns: LeadRun[];
  /** The last 200 steering change sets; events keep the full record. */
  steering: SteeringChangeSet[];
  /** The last 50 vision drafts; accepted ones live on as vision revisions. */
  visionDrafts: VisionDraft[];
  /** Decisions on findings (at most 2000; decided ones of settled tasks are pruned first, open ones never). */
  decisions: FindingDecision[];
  /** The six built-in flows, machine-level like the files they come from. Only the server writes them (at start); initProject leaves them alone. */
  flows: Flow[];
  /** Notes sent to running stages (at most 2000; settled notes of finished tasks are pruned first). */
  notes: Note[];
  /** The vision studio (ORC-029): rounds, artifacts, the owner's feedback, the PE's verdicts and probes. */
  studio: Studio;
  /** What the factory builds from, versioned, and the change orders after the start (ORC-029). */
  blueprint: Blueprint;
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
  /** Lead messages: the steering change set this reply carried. */
  changeSetId?: string;
  /** Lead messages: the vision draft this reply carried. */
  visionDraftId?: string;
  /** Lead messages: the questions this reply asked (validated; at most 5). */
  questions?: LeadQuestion[];
  /** Lead messages: what this reply decided, suggested or handed over, as recorded then (a later change by the user does not rewrite it). */
  leadDecisions?: { id: string; taskId: string; what: "decided" | "suggested" | "handed-over"; status: string; why?: string }[];
  /** User messages: the task page the message was sent from. */
  taskId?: string;
}

/** "decisions": a run started because findings routed to the lead wait for its decision. */
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
  /** The vision revision the run started from. Absent on runs from before steering existed (they cannot steer). */
  visionRev?: number;
  /** The change set this run's reply produced. */
  changeSetId?: string;
  /** The coverage this run reported (message runs only; the latest one stands). */
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

// ---------- pull-request delivery and the review-later queue ----------

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
  /** Re-runs of a GitHub Actions job GitHub cancelled, per check name per head (0–3). */
  rerunBudget: number;
  /** GitHub app slugs whose failing checks are a bot's opinion, never fixed automatically (≤10). */
  reviewBotApps: string[];
  /** The user declares the repository has no CI; their own Merge then works with zero checks. */
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
  // The repository's instruction files, anywhere in the tree, are protected too.
  protectedPaths: [".github/**", "package.json", "tsconfig*.json", "vitest.config.*", "vite.config.*", "**/AGENTS.md", "**/CLAUDE.md"],
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
  /** A check run or a status context. */
  kind?: "run" | "status";
  /** The check suite's app slug, or the status creator's login. */
  app?: string;
  /** The check run's database id (a GitHub Actions job id when app is "github-actions"). */
  jobId?: number;
  runId?: number;
  /** The workflow the run belongs to (its id, or its name and the triggering event); supersession needs the same one. */
  workflowId?: number;
  workflowName?: string;
  event?: string;
  startedAt?: string;
  /** With `startedAt`, how long the job ran (a cancelled job that ran to GitHub's time limit failed on the code). */
  completedAt?: string;
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
  // findings, CI and the service's own checks
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
  op?: { id: string; kind: "publish" | "push" | "merge" | "close" | "rerun"; at: string; headSha: string };
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
  /** `reruns` and `checks` default to 0 on records from before they existed. */
  counters: { mergeAttempts: number; baseUpdates: number; repairs: number; reviews: number; failures: number; reruns?: number; checks?: number };
  /** Service-check evidence for `changeSha` under the current check settings. */
  checks?: CheckEvidence;
  /**
   * Re-runs of GitHub-cancelled jobs requested for the current head. `seen`: observations
   * since the request that still showed the cancelled run; after 2 (or 5 minutes) the check is
   * judged as observed.
   */
  ciReruns?: { headSha: string; used: { check: string; jobId: number; at: string; opId: string; seen?: number; refused?: string }[] };
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
  /** Findings someone decided to accept as they are (ids like "F2 title"); the review is clean apart from them. */
  accepted?: string[];
}

export type LandedFlag = "main-check-failed" | "merged-without-clean-gate" | "findings-cleared-by-user" | "protected-paths" | "checks-accepted-failing" | "checks-not-run" | "findings-accepted";

interface LandedNote {
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
