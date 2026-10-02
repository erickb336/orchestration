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
/** Kinds the PE does not hold back from the owner: what the owner brought, and a probe's evidence. The PE may still judge them. */
export const UNGATED_KINDS: StudioArtifactKind[] = ["material", "evidence"];

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
  /** Options side by side for an open choice; none or one is a single take. */
  variants: { id: string; label: string }[];
  /** Relative to the project's studio workspace. Provider-neutral files: the canvas shows them the same whoever made them. */
  files: { path: string; sha256: string }[];
  /** The device sizes it is designed for, within the project's device scope; none for a contract or a flow. */
  devices: Device[];
  madeBy: StudioMaker;
  at: string;
}

export type Mark = "keep" | "change" | "drop";

/** A comment pinned to a point: `x` and `y` are fractions (0 to 1) of the shown artifact's width and height. */
export interface Pin {
  x: number;
  y: number;
  variant?: string;
  text: string;
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

export interface Studio {
  rounds: Round[];
  artifacts: StudioArtifact[];
  feedback: Feedback[];
  verdicts: PeVerdict[];
  probes: Probe[];
}

export interface Blueprint {
  revisions: BlueprintRevision[];
  changeOrders: ChangeOrder[];
}

export const emptyStudio = (): Studio => ({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [] });
export const emptyBlueprint = (): Blueprint => ({ revisions: [], changeOrders: [] });
