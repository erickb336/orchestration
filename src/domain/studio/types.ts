// The vision studio and the blueprint (ORC-029, docs/design/ORC-029-pass2-design.md section 2c).
//
// In Vision the lead runs rounds: a designer makes artifacts (screens, terminal demos, contracts, flow maps), the PE
// judges each option's feasibility before the owner sees it, and the owner marks, pins and picks. What the owner
// approves becomes the blueprint, versioned, which the factory builds from; a blueprint revision after the factory
// started that touches a task is a change order. The rules live in studio.ts (rounds, artifacts, feedback, PE review, probes) and
// blueprint.ts (approval, open items, change orders, task specs' references). The containers exist from state
// format 19.

import type { Device, PeReviewState, ProviderId } from "../types";

/** What a round is about. Round 0 is what the owner brought (material); then the experience, the data crossing each boundary, and the flows. */
export type RoundFocus = "material" | "experience" | "data" | "flows";
export const ROUND_FOCUSES: RoundFocus[] = ["material", "experience", "data", "flows"];

/** One exchange of the studio: the lead's message, the round's artifacts, and the owner's answer. At most one round is open at a time. */
export interface Round {
  /** 0 is what the owner brought; the lead's rounds count from 1. */
  n: number;
  focus: RoundFocus;
  openedAt: string;
  closedAt?: string;
  /** The lead run that opened it. */
  leadRunId?: string;
  /** What the round explores, then what came of it, in the lead's words. */
  summary: string;
}

export type StudioArtifactKind = "screen" | "terminal-demo" | "tui" | "contract" | "flow" | "material" | "evidence";
export const STUDIO_ARTIFACT_KINDS: StudioArtifactKind[] = ["screen", "terminal-demo", "tui", "contract", "flow", "material", "evidence"];
/** Kinds the PE does not review: what the owner brought, and a probe's evidence. They reach the owner at once, and a verdict on one is refused. */
export const UNGATED_KINDS: StudioArtifactKind[] = ["material", "evidence"];

/** One option of an artifact: its id, its label, and its entry file when it has one. */
export interface StudioVariant {
  id: string;
  label: string;
  entry?: string;
}

/** Who made an artifact version: the owner (what they brought), or an agent's run. */
export type StudioMaker = { role: "user" } | { role: "lead" | "designer" | "pe" | "probe"; provider: ProviderId; model: string; attemptId: string };
export const STUDIO_AGENT_ROLES = ["lead", "designer", "pe", "probe"] as const;

/**
 * A prototype, terminal demo, contract, flow map, material or evidence. One record per version: `id` names the
 * artifact across its versions, and (`id`, `version`) one version. A revision is a new version, in the same round
 * (the designer answering the PE) or a later one (answering the owner); it carries the owner's open pins forward.
 */
export interface StudioArtifact {
  id: string;
  /** The round this version was made in. */
  round: number;
  version: number;
  /** Another artifact this one replaces (a new take, or variants merged): approving it takes over that artifact's blueprint item. */
  supersedes?: string;
  kind: StudioArtifactKind;
  title: string;
  /**
   * Options side by side for an open choice; none or one is a single take. `entry` is the variant's entry file (a
   * page, a tape, a .cast or .ans), one of `files`, as the designer named it in studio.json; what the owner brought has none.
   */
  variants: StudioVariant[];
  /**
   * Relative to the version's folder, `artifacts/<id>/v<version>/` in the project's studio workspace (pass 3). Provider-neutral
   * files: the canvas shows them the same whoever made them.
   */
  files: { path: string; sha256: string }[];
  /** The device sizes it is designed for, within the project's device scope; none for a contract or a flow. */
  devices: Device[];
  madeBy: StudioMaker;
  at: string;
  /** A screen's screenshots, which the service takes after import (pass 3). Absent when this service takes none. */
  shots?: ArtifactShots;
  /** How a terminal demo or TUI is shown, which the service settles after import (pass 3). Absent when this service records none. */
  demo?: ArtifactDemo;
}

/** One screenshot: a variant on a device, relative to the version's folder (`shots/<variant>-<device>.png`). */
export interface ArtifactShot {
  variant: string;
  device: Device;
  path: string;
}

/**
 * The screenshots of a screen version, for its history and for the PE: each variant on each of its devices.
 * pending: being taken; taken: at least one (`failed` names any that were not, and why); skipped: none, and why
 * (no Chrome, say).
 */
export type ArtifactShots =
  | { status: "pending" }
  | { status: "taken"; at: string; shots: ArtifactShot[]; failed: { variant: string; device: Device; error: string }[] }
  | { status: "skipped"; at: string; reason: string };

/**
 * How one variant of a terminal demo or TUI is shown. Paths are relative to the version's folder.
 * recorded: VHS recorded its tape in the sandbox, into `recording/<variant>/` (WebM, GIF and a text transcript, as the
 * tape asked); recorded-with-errors: recorded, but its transcript shows a failure the designer did not mean to show
 * (`reason`: the first failing line); hand-written: the designer's .cast or .ans files, not recorded (`reason`: why
 * its tape was not, when it had one); not-recorded: neither, and why.
 */
export type VariantDemo =
  | { variant: string; status: "recorded"; tape: string; webm?: string; gif?: string; txt?: string }
  | { variant: string; status: "recorded-with-errors"; tape: string; webm?: string; gif?: string; txt?: string; reason: string }
  | { variant: string; status: "hand-written"; files: string[]; reason?: string }
  | { variant: string; status: "not-recorded"; reason: string };

/** A terminal demo's or TUI's variants as shown: pending while the service records them. */
export type ArtifactDemo = { status: "pending" } | { status: "done"; at: string; variants: VariantDemo[] };

export type Mark = "keep" | "change" | "drop";

/**
 * A comment pinned to a point: `x` and `y` are fractions (0 to 1) of the shown artifact's width and height.
 * `selector` describes the element clicked, as the prototype's pin script reported it: the prototype's own text, a
 * description only, shown as text and never as markup.
 */
export interface Pin {
  x: number;
  y: number;
  variant?: string;
  text: string;
  selector?: string;
}

/**
 * The owner's marks, pins and picks on one artifact version. The owner's only. Records are kept in order; the last
 * one for a version is its current feedback, and its pins are the version's open pins.
 */
export interface Feedback {
  artifactId: string;
  version: number;
  mark: Mark | null;
  pickedVariant?: string;
  pins: Pin[];
  note: string;
  at: string;
  /** Set on the record a revision starts with: the open pins of this earlier version, carried forward. Not an answer of the owner's. */
  carriedFrom?: number;
}

export type Verdict = "feasible" | "feasible-if" | "not-feasible";
export const VERDICTS: Verdict[] = ["feasible", "feasible-if", "not-feasible"];

/** A cost estimate: dollar ranges, low to high, and what they are based on (recorded runs, price lists, a probe). */
export interface BudgetEstimate {
  buildUsd?: [number, number];
  maintenanceUsdPerMonth?: [number, number];
  basis: string;
}

/**
 * The PE's verdict on one artifact version: on one variant, or on the whole artifact when `variant` is absent. The
 * verdicts of one review make one pass; passes count from 1 within the round the version was made in, up to 3.
 * A not-feasible verdict is an objection; it is never dropped, and only the owner overrules it.
 */
export interface PeVerdict {
  id: string;
  artifactId: string;
  version: number;
  variant?: string;
  pass: number;
  verdict: Verdict;
  reasons: string;
  /** The change that makes it feasible (feasible-if), or the evidence that would change the verdict (not-feasible). */
  change?: string;
  budget?: BudgetEstimate;
  at: string;
  /** The owner overruled this objection, and why. */
  overruled?: { at: string; why: string };
  /** The PE's run that made it, with its provider and model (the service's record; absent on verdicts recorded otherwise). */
  by?: { provider: ProviderId; model: string; runId: string };
  /**
   * Set on each verdict of a pass the service made the last of its round before the three passes are used: the
   * designer cannot revise in answer to the PE yet (ORC-029 pass 4), so the pass's objections go to the owner now.
   */
  lastPass?: true;
}

export type ProbeStatus = "queued" | "running" | "done" | "failed";

/** A small Vision task that brings evidence for PE review. Its run's spend counts in the building budget. */
export interface Probe {
  id: string;
  askedBy: "pe";
  question: string;
  status: ProbeStatus;
  at: string;
  /** The run doing it, once running. */
  attemptId?: string;
  /** The evidence artifact it produced, once done. */
  result?: string;
  /** Why it failed. */
  failure?: string;
}

/**
 * One item of the blueprint: an artifact the owner approved at a version (and variant), or one still open. An item
 * keeps its id across revisions, so task specs can cite it (`blueprintRefs`); items are never removed.
 */
export interface BlueprintItem {
  id: string;
  kind: StudioArtifactKind;
  title: string;
  artifactId: string;
  version: number;
  /** The variant approved, for an artifact with several. */
  variant?: string;
  status: "approved" | "open";
}

/** One revision of what the factory builds from: the vision revision it stands on and every item. Made only by the owner's approvals. */
export interface BlueprintRevision {
  rev: number;
  at: string;
  visionRev: number;
  reason: string;
  items: BlueprintItem[];
}

/**
 * A blueprint revision made while building, with the tasks whose current spec cites a changed item. Who acts on it
 * first follows the project's `changeOrders` setting: the lead updates the tasks, or it waits for the owner (Needs
 * you). At most one change order per revision, so `rev` identifies it; a revision that touches no task makes none.
 */
export interface ChangeOrder {
  rev: number;
  at: string;
  changedItems: string[];
  affectedTasks: string[];
  /** Open until handled; the handling (the lead's updates through steering, or the owner's answer) comes in pass 5. */
  status: "open" | "done";
  /** Who acts first: the project's `changeOrders` setting when the revision was made. */
  handler: "lead" | "user";
  /** PE review of the lead's updates for this change order (2e): the lead applies them once the PE agrees (pass 5). Set while the project has PE review of new work on. */
  peReview?: PeReviewState;
}

export type StudioRunKind = "designer" | "pe" | "probe";
export const STUDIO_RUN_KINDS: StudioRunKind[] = ["designer", "pe", "probe"];
/** What a designer's manifest may hold: the owner brings material, and a probe's run makes evidence. */
export const DESIGNER_KINDS: StudioArtifactKind[] = ["screen", "terminal-demo", "tui", "contract", "flow"];

/** queued → running → (stopping →) stopped, completed, failed or lost. A queued run waits for dispatch, which happens in Vision only. */
export type StudioRunStatus = "queued" | "running" | "stopping" | "stopped" | "completed" | "failed" | "lost";

/**
 * One agent run of the studio (ORC-029 pass 3): a designer's, the PE's or a probe's, during Vision. Its own record,
 * like a lead run, never a task attempt: it touches no product branch. It writes only into its staging folder, and
 * what a designer run hands in is imported as artifact versions. Its usage counts in the building budget.
 */
export interface StudioRun {
  id: string;
  kind: StudioRunKind;
  round: number;
  /** The artifact a designer run revises: what it hands in is a new version of it. */
  artifactId?: string;
  /** The version it revises: the artifact's newest when the run was asked for. A result after a newer version is stale. */
  baseVersion?: number;
  /** Resolved when the run is asked for, never "auto". */
  provider: ProviderId;
  model: string;
  status: StudioRunStatus;
  /** What the run is asked to do. Until the lead writes studio briefs (pass 4), a labelled placeholder. */
  brief: string;
  askedAt: string;
  /** When it was dispatched; absent while queued. */
  startedAt?: string;
  endedAt?: string;
  /** Its staging folder, relative to the project's studio workspace (`<data>/studio/<projectId>/`): the one place it writes. */
  workspace: string;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; costUsd?: number };
  sessionId?: string;
  actualModel?: string;
  stopRequestedAt?: string;
  /** Pausing the project stopped it: once the stop is confirmed the run is asked for again, and it runs when the project resumes. */
  requeue?: true;
  /** The run this one repeats after a pause stopped it. */
  retryOf?: string;
  activity?: string;
  /** Why it failed or was refused, or a control failure. */
  note?: string;
  /** Run by the fake runtime: no agent made what it hands in. */
  simulated?: true;
}

export interface Studio {
  rounds: Round[];
  artifacts: StudioArtifact[];
  feedback: Feedback[];
  verdicts: PeVerdict[];
  probes: Probe[];
  runs: StudioRun[];
}

export interface Blueprint {
  revisions: BlueprintRevision[];
  changeOrders: ChangeOrder[];
}

export const emptyStudio = (): Studio => ({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [], runs: [] });
export const emptyBlueprint = (): Blueprint => ({ revisions: [], changeOrders: [] });
