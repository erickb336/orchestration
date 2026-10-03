// The vision studio and the blueprint (ORC-029, docs/design/ORC-029-pass2-design.md section 2c).
//
// In Vision the lead runs rounds: a designer makes artifacts (screens, terminal demos, contracts, flow maps), the PE
// judges each option's feasibility before the owner sees it, and the owner marks, pins and picks. What the owner
// approves becomes the blueprint, versioned, which the factory builds from; a blueprint revision after the factory
// started that touches a task is a change order. The rules live in studio.ts (rounds, artifacts, feedback, PE review, probes) and
// blueprint.ts (approval, open items, change orders, task specs' references). The containers exist from state
// format 19.

import type { Device, GivenPrinciple, PeReviewState, ProseCheck, ProviderId } from "../types";

/**
 * What a round is about. Round 0 is what already exists (material): what the owner brought, and for an existing
 * repository the designer's "as is" reproductions of it ("as it is today"). Then the experience, the data crossing
 * each boundary, and the flows.
 */
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
  /**
   * The lead's latest message about this round and its questions to the owner, from the studio block of its newest
   * reply that addressed the round (pass 4). The owner answers in the conversation, with their feedback.
   */
  lead?: RoundLead;
}

/** The lead's message for a round, and its questions (ORC-012's: the question, why it matters, options to pick). */
export interface RoundLead {
  message: string;
  questions: RoundQuestion[];
}

export interface RoundQuestion {
  text: string;
  reason?: string;
  options?: string[];
}

/**
 * What an artifact is. A screen product's: screens, terminal demos and TUIs. A code product's (r9): its `interface`
 * (names, signatures, the error model, usage examples as a caller writes them) and its core `algorithm`s and
 * primitives (pseudo-code, a worked trace, invariants, cost). An infrastructure system's: its `topology` (what talks to
 * what, failure and recovery, scale and cost). Any domain's `contract`s (what crosses a boundary, with examples) and
 * `flow`s (journeys, sequences, and tables of cases and outcomes; a flow may carry its rules, `rules.json`). The
 * project's `dictionary` (pass 4d): its words, each with one meaning and the words it replaces. The owner's
 * `material`, and a probe's `evidence`.
 */
export type StudioArtifactKind = "screen" | "terminal-demo" | "tui" | "contract" | "flow" | "interface" | "algorithm" | "topology" | "dictionary" | "material" | "evidence";

/** Who makes an artifact of a kind: the designer, the owner (what they bring into round 0), or a probe's run (its evidence). */
export type KindMaker = "designer" | "owner" | "probe";

/**
 * The rules of one artifact kind: who makes it, whether the PE reviews it, and whether it waits for the owner's mark.
 * The studio reads these here, from no list of its own. How a kind is shown (`DOCUMENT_KINDS`, the viewer) is apart.
 * - `maker`: who makes it. The lead asks the designer only for the designer's kinds.
 * - `peReviews`: whether the PE reviews each version before the owner sees it. When it does not, its review is
 *   "not-reviewed" (`peReview`, studio.ts): the version reaches the owner at once, the PE gives it no verdict, and the
 *   designer never revises it for the PE. `why` says why, in words that follow "The PE does not review it: ", for the
 *   owner and the lead alike.
 * - `ownerMark`: "asked": the version waits for the owner's mark (on a table: a mark on each row), and it counts as
 *   waiting for them until then. "optional": the owner may mark it, and nothing waits for the mark.
 */
export type KindRule = { maker: KindMaker; ownerMark: "asked" | "optional" } & ({ peReviews: true } | { peReviews: false; why: string });

/**
 * One row for each kind (the type refuses a kind without one). The dictionary goes to the owner with no PE review
 * (the lead's decision, 2026-10-02): the PE judges feasibility, scale, longevity and budget, and a word list raises
 * none of them. The owner still marks its terms.
 */
export const KIND_RULES: Record<StudioArtifactKind, KindRule> = {
  screen: { maker: "designer", peReviews: true, ownerMark: "asked" },
  "terminal-demo": { maker: "designer", peReviews: true, ownerMark: "asked" },
  tui: { maker: "designer", peReviews: true, ownerMark: "asked" },
  contract: { maker: "designer", peReviews: true, ownerMark: "asked" },
  flow: { maker: "designer", peReviews: true, ownerMark: "asked" },
  interface: { maker: "designer", peReviews: true, ownerMark: "asked" },
  algorithm: { maker: "designer", peReviews: true, ownerMark: "asked" },
  topology: { maker: "designer", peReviews: true, ownerMark: "asked" },
  dictionary: { maker: "designer", peReviews: false, why: "it is a word list, and the PE judges feasibility, scale, longevity and budget", ownerMark: "asked" },
  material: { maker: "owner", peReviews: false, why: "it is source material, not a design", ownerMark: "optional" },
  evidence: { maker: "probe", peReviews: false, why: "it is a probe's evidence for the PE, not a design", ownerMark: "optional" },
};

/** Every kind, in the table's order. */
export const STUDIO_ARTIFACT_KINDS = Object.keys(KIND_RULES) as StudioArtifactKind[];
/** What a designer's manifest may hold: the owner brings material, and a probe's run makes evidence. */
export const DESIGNER_KINDS = STUDIO_ARTIFACT_KINDS.filter((k) => KIND_RULES[k].maker === "designer");
/** Kinds that are documents: plain files (Markdown with code blocks and tables, `.mmd` Mermaid), shown without a device frame. */
export const DOCUMENT_KINDS: StudioArtifactKind[] = ["contract", "flow", "interface", "algorithm", "topology"];

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
  /**
   * An "as is" artifact (pass 4): the designer's reproduction of what the existing repository already does, in round
   * 0 ("as it is today"), with the repository files it came from (paths relative to the repository's root, each a file
   * the repository tracks, checked at import). Absent on everything else.
   */
  provenance?: Provenance;
  /** A screen's screenshots, which the service takes after import (pass 3). Absent when this service takes none. */
  shots?: ArtifactShots;
  /** How a terminal demo or TUI is shown, which the service settles after import (pass 3). Absent when this service records none. */
  demo?: ArtifactDemo;
  /** A dictionary's terms, as its `dictionary.json` gave them, checked at import (pass 4d). Only on a dictionary. */
  dictionary?: DictionaryEntry[];
  /** A flow's rules and examples, from the `rules.json` beside a variant's entry, checked at import (pass 4d). Only on a flow, and only for the variants that have one. */
  rules?: VariantRules[];
  /**
   * The end of PE review of this version, when the service recorded it because no other record shows it: no enabled
   * provider could run the next step, or the version was reviewed under pass 3's rule (recorded at the upgrade).
   * Every other end is read from the verdicts, the runs and the round (studio.ts, `peReview`).
   */
  reviewEnd?: { reason: RecordedEnd; at: string; note?: string };
}

/**
 * Why PE review of a version ended before the PE agreed. The version then goes to the owner with what the PE still
 * asks for and objects to (studio.ts, the loop rule).
 * - passes: the PE made its last pass in the round;
 * - as-is: the version reproduces the code as it is today (round 0): the designer does not revise it for the PE;
 * - round-closed: its round closed first (a round closed before the lead's close waited for PE review);
 * - no-revision: the designer's runs revising it ended without a new version, twice;
 * - no-review: the PE's runs on it ended without a verdict, twice;
 * - no-provider: no enabled provider could run the next step (the PE or the designer's revision);
 * - earlier-rule: the PE reviewed it under pass 3's rule, one pass and no revision (recorded at the upgrade).
 */
export type LoopEnd = "passes" | "as-is" | "round-closed" | "no-revision" | "no-review" | "no-provider" | "earlier-rule";
/** The ends the service records on the version (`reviewEnd`), because no other record shows them. */
export type RecordedEnd = Extract<LoopEnd, "no-provider" | "earlier-rule">;

/**
 * One word of the project's dictionary (pass 4d, decision 6): the term the product and its agents use, its one
 * meaning, and the words it replaces. The dictionary the owner approved into the blueprint is the project's: every
 * agent gets its words, and the prose check reports an avoided word (words.ts).
 */
export interface DictionaryEntry {
  term: string;
  meaning: string;
  avoid: string[];
}

/**
 * The five sentence patterns of EARS (Easy Approach to Requirements Syntax; Mavin et al., 2009) a flow's rule fits:
 * always "The <system> shall <response>."; event "When <trigger>, …"; state "While <state>, …"; unwanted
 * "If <unwanted condition>, then …"; optional "Where <feature is included>, …".
 */
export type RulePattern = "always" | "event" | "state" | "unwanted" | "optional";
export const RULE_PATTERNS: RulePattern[] = ["always", "event", "state", "unwanted", "optional"];

/** A flow's rule (pass 4d, decision 7): its id, its text in one of EARS's patterns, and the pattern it fits. */
export interface FlowRule {
  id: string;
  text: string;
  pattern: RulePattern;
}

/** An acceptance example of a flow: "Given <context>, when <action>, then <result>." */
export interface FlowExample {
  id: string;
  text: string;
}

/** The rules of one variant of a flow: its `rules.json`, beside the variant's entry. */
export interface VariantRules {
  variant: string;
  /** The file, relative to the version's folder. */
  path: string;
  rules: FlowRule[];
  examples: FlowExample[];
}

/** Where an "as is" artifact came from: labelled as is, with the repository files the designer reproduced it from. */
export interface Provenance {
  asIs: true;
  files: string[];
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
 * The owner's mark on one row of a table (pass 4d): a term of a dictionary (`row` is the term), or a rule of a flow
 * (`row` is the rule's id, on `variant` when the flow has several). The same three marks as a whole artifact's.
 */
export interface RowMark {
  row: string;
  variant?: string;
  mark: Mark;
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
  /** Marks on the rows of a dictionary or of a flow's rules. Absent when there are none. Never carried to a revision. */
  rows?: RowMark[];
  note: string;
  at: string;
  /** Set on the record a revision starts with: the open pins of this earlier version, carried forward. Not an answer of the owner's. */
  carriedFrom?: number;
}

export type Verdict = "feasible" | "feasible-if" | "not-feasible";
export const VERDICTS: Verdict[] = ["feasible", "feasible-if", "not-feasible"];
/** A verdict in words: "feasible if changed". */
export const VERDICT_WORDS: Record<Verdict, string> = { feasible: "feasible", "feasible-if": "feasible if changed", "not-feasible": "not feasible" };

/** A cost estimate: dollar ranges, low to high, and what they are based on (recorded runs, price lists, a probe). */
export interface BudgetEstimate {
  buildUsd?: [number, number];
  maintenanceUsdPerMonth?: [number, number];
  basis: string;
}

/**
 * A product question the PE noticed while it judged a variant: a missing feature, an undecided edge case, a rule
 * nobody set. It is the owner's to decide, through the lead (its studio brief lists the open round's), and it never
 * sends the variant back to the designer. `why`: why it matters, in the PE's words.
 */
export interface OpenCase {
  text: string;
  why?: string;
}

/**
 * The PE's check, on a later pass in a round, of one change it asked for earlier in the round on this variant: `ask`
 * is the id of the earlier verdict that asked for it, and `met` whether this version meets it. A check that is not
 * met on a feasible verdict means the PE no longer asks for it.
 */
export interface AskCheck {
  ask: string;
  met: boolean;
}

/**
 * The PE's verdict on one artifact version: on one variant, or on the whole artifact when `variant` is absent. The
 * verdicts of one review make one pass; passes count from 1 within the round the version was made in, up to 3.
 * A not-feasible verdict is an objection; it is never dropped, and only the owner overrules it.
 *
 * Only `change` sends the variant back to the designer (with the verdict: feasible-if or not-feasible). On a later
 * pass the PE first checks each earlier ask (`earlier`), and a change then answers an ask that is not met, or a risk
 * the revision created (`fromRevision`), so the loop converges. Product questions are `openCases`, for the owner.
 * Verdicts stored before these three fields existed have none of them and read the same.
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
  /** On a later pass in the round: the PE's check of each change it asked for earlier on this variant. Absent on a first pass. */
  earlier?: AskCheck[];
  /** On a later pass: the change answers a risk that the revision itself created, not an earlier ask. */
  fromRevision?: true;
  /** Product questions for the owner. Absent when the PE raised none. */
  openCases?: OpenCase[];
  budget?: BudgetEstimate;
  at: string;
  /** The owner overruled this objection, and why. */
  overruled?: { at: string; why: string };
  /** The PE's run that made it, with its provider and model (the service's record; absent on verdicts recorded otherwise). */
  by?: { provider: ProviderId; model: string; runId: string };
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
 * Where an item stands: approved (the factory builds it), open (not settled: no pick, marked Change, PE review
 * unfinished, an objection not overruled), or dropped by the owner (the part left the design; pass 5).
 */
export type BlueprintItemStatus = "approved" | "open" | "dropped";

/**
 * One item of the blueprint: an artifact the owner approved at a version (and variant), one still open, or one the
 * owner dropped. An item keeps its id across revisions, so task specs can cite it (`blueprintRefs`); items are never
 * removed from what is in force, and a dropped item keeps its id with the status "dropped".
 */
export interface BlueprintItem {
  id: string;
  kind: StudioArtifactKind;
  title: string;
  artifactId: string;
  version: number;
  /** The variant approved, for an artifact with several. */
  variant?: string;
  status: BlueprintItemStatus;
}

/**
 * One revision of what the factory builds from: the vision revision it stands on and every item. The newest revision
 * is the version in force. Since pass 5 only the owner's Lock in makes one (Start the factory is the first Lock in);
 * before, each approval made one.
 */
export interface BlueprintRevision {
  rev: number;
  at: string;
  visionRev: number;
  reason: string;
  items: BlueprintItem[];
  /** The owner's Lock in that made it, with the summary they agreed to. Absent on revisions made by approvals before pass 5. */
  lockIn?: LockInRecord;
}

/**
 * The draft (pass 5, spec r10): the owner's working copy of the blueprint. Approvals and drops change it; the
 * factory never reads it. Its changes are not stored: they are the difference between its items and the version in
 * force (`draftChanges`, blueprint.ts). Lock in puts the changes into force; open items stay in the draft.
 * It is always present: with no difference from the version in force and no open item, there is no draft to show.
 */
export interface BlueprintDraft {
  /**
   * Bumped by every change to the draft and by every Lock in, never reset: a Lock in and Start the factory name the
   * revision their summary showed (compare-and-set), so a summary shown before any change is refused.
   */
  rev: number;
  /** Every item as the draft has it, in the order they came in: approved, open and dropped. */
  items: BlueprintItem[];
}

/** The owner's agreement recorded with a Lock in: who, and the summary they saw (when is the revision's `at`). */
export interface LockInRecord {
  by: "user";
  summary: LockInSummary;
}

/** A task's state as the Lock in summary says it: not started, started, or finished. */
export type TouchedTaskState = "queued" | "running" | "landed";

/**
 * What happens to a task that a Lock in touches (spec r14): queued, the lead updates its spec; running, it finishes
 * and then the lead revises it; landed, the lead plans a revision; queued and building only dropped items, it is
 * retired. A running or landed task that builds only dropped items is not retired: running work finishes (r14), and
 * built work needs a revision to take the part out.
 */
export type TaskHandling = "update-spec" | "finish-then-revise" | "plan-revision" | "retire";

/** A task whose current spec cites an item the Lock in adds, changes or drops. */
export interface TouchedTask {
  taskId: string;
  title: string;
  state: TouchedTaskState;
  /** The items it cites that the Lock in adds, changes or drops. */
  items: string[];
  handling: TaskHandling;
}

/** A dollar range, low to high. */
export type UsdRange = [number, number];

/** The PE's estimate for one item the Lock in adds or changes, from its verdict on that version; null: no estimate (never $0). */
export interface ItemEstimate {
  itemId: string;
  estimate: BudgetEstimate | null;
}

/**
 * What a Lock in does to the budgets. The building spend so far, with the runs that have no recorded cost counted
 * apart (never as $0); the maintenance estimate so far (null: not estimated yet). `items`: the PE's estimate for each
 * added or changed item. `itemsTotal` sums them, each range null when there is no item or one has no figure for it:
 * an unknown cost is never $0.
 */
export interface LockInBudgets {
  building: { budgetUsd: number | null; spentUsd: number; unknownRuns: number };
  maintenance: { budgetUsdPerMonth: number | null; estimateUsdPerMonth: number | null };
  items: ItemEstimate[];
  itemsTotal: { buildUsd: UsdRange | null; maintenanceUsdPerMonth: UsdRange | null };
}

/**
 * The summary before a Lock in (pass 5, screen 3): what changes, the tasks it touches and what happens to each, the
 * new work, the budgets, and what stays open. A pure function of the state (`lockInSummary`); the Lock in records it.
 */
export interface LockInSummary {
  /** The draft revision it describes: the Lock in names it (compare-and-set). */
  draftRev: number;
  /** The revision in force now, which the Lock in replaces; 0 before the first. */
  inForceRev: number;
  changes: {
    /** Approved in the draft, and not approved in force: new to the factory. */
    added: BlueprintItem[];
    /** Approved in both, at another version, variant or title: the draft's item, and the one in force it replaces. */
    changed: { item: BlueprintItem; replaces: BlueprintItem }[];
    /** Dropped in the draft: the items as they are in force, which leave the design. */
    dropped: BlueprintItem[];
  };
  tasks: TouchedTask[];
  /** The added items no task cites yet: the lead plans their tasks after the Lock in. */
  newWork: string[];
  budgets: LockInBudgets;
  /** The open items: they stay in the draft, and the factory keeps the version in force (`inForce`), if any. */
  stillOpen: { item: BlueprintItem; why: string; inForce?: BlueprintItem }[];
}

/**
 * A Lock in made while building, when it touches a task or brings new work: what changed, and what the lead does
 * about it. Who acts first follows the project's `changeOrders` setting: the lead adjusts the tasks, or it waits for
 * the owner (Needs you). At most one change order per revision, so `rev` identifies it.
 */
export interface ChangeOrder {
  rev: number;
  at: string;
  /** The items added or changed: what the factory builds anew. */
  changedItems: string[];
  /** The items dropped: what the factory no longer builds (pass 5). */
  droppedItems: string[];
  /** The tasks it touches, each with its planned handling (r14). The lead's updates follow it (a later unit). */
  tasks: { taskId: string; handling: TaskHandling }[];
  /** The added items no task cites yet: the lead plans their tasks. */
  newWork: string[];
  /** Open until handled; the handling (the lead's updates through steering, or the owner's answer) comes in pass 5. */
  status: "open" | "done";
  /** Who acts first: the project's `changeOrders` setting when the revision was made. */
  handler: "lead" | "user";
  /** PE review of the lead's updates for this change order (2e): the lead applies them once the PE agrees (pass 5). Set while the project has PE review of new work on. */
  peReview?: PeReviewState;
}

export type StudioRunKind = "designer" | "pe" | "probe";
export const STUDIO_RUN_KINDS: StudioRunKind[] = ["designer", "pe", "probe"];

/** queued → running → (stopping →) stopped, completed, failed or lost. A queued run waits for dispatch, which happens in Vision only. */
export type StudioRunStatus = "queued" | "running" | "stopping" | "stopped" | "completed" | "failed" | "lost";
/** A run under way: asked for and not ended (queued, running, or stopping until the runtime confirms the stop). */
export const isUnderWay = (r: { status: StudioRunStatus }) => r.status === "queued" || r.status === "running" || r.status === "stopping";

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
  /** What the run is asked to do: the lead's brief and what it asked for, or (asked by the service alone) a labelled placeholder. */
  brief: string;
  /** A designer run the lead asked for in its studio block (pass 4): the lead run, and the kinds, variants and devices it asked for. */
  fromLead?: { leadRunId: string; kinds: StudioArtifactKind[]; variants: number; devices: Device[] };
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
  /**
   * The principles its envelope gave it, in table order, each with the hash of its body: its role's fixed set
   * (STUDIO_PRINCIPLE_IDS), recorded at dispatch as a task run's snapshot records its own. Absent on runs from before.
   */
  principles?: GivenPrinciple[];
  /**
   * The check of what it wrote for the owner against the controlled-English style, as `LeadRun.prose`: the PE's
   * reasons, changes and open cases; the designer's documents. On the run, never on the verdict or the artifact: it
   * feeds the next run of the same role, and the owner sees no score. Absent on runs from before the check, on runs
   * with no such text, and on runs that did not complete.
   */
  prose?: ProseCheck;
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
  /** The versions in force, oldest first; the newest is the one the factory builds from. */
  revisions: BlueprintRevision[];
  /** The owner's working copy, which the factory never reads. */
  draft: BlueprintDraft;
  changeOrders: ChangeOrder[];
}

export const emptyStudio = (): Studio => ({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [], runs: [] });
export const emptyBlueprint = (): Blueprint => ({ revisions: [], draft: { rev: 0, items: [] }, changeOrders: [] });
