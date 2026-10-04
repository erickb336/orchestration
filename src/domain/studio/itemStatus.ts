// Where each part of the design stands in the factory (ORC-029 pass 5, screen 5 "Design and reality"). Pure, from
// the state only: the blueprint in force and its draft, the tasks that cite the item, the work that landed, the rule
// results of the checks of landed work (ruleResults.ts), the evidence the service captured (evidence.ts), and the UX
// review of that evidence with the decisions on its findings (findings.ts). The app words it; this module says only
// the facts.
//
// The statuses, the first that applies:
// 1. "in-force": a dictionary. It is not built: every agent's brief and the writing check use it.
// 2. "fails-a-check": a rule or an example of the item has a failing test; or the UX review of the landed work (see
//    "The landed work's evidence") has an open difference for the item.
// 3. "in-the-draft": the owner's draft changes or drops the item. The factory keeps the version in force until a Lock in.
// 4. "being-built": a task that builds this version is running, or finished and not landed yet. A task that still
//    builds an earlier version does not count: it is listed with `thisVersion: false`.
// 5. Work that built this version landed (the lead's decision, 2026-10-03, and the owner's answer, r14: the checks
//    decide), and the checks prove it, by kind:
//    - a flow or a contract: every rule and example has a passing test ("No test" and "skipped" are never a proof);
//    - a screen: the landed work's evidence is captured on each of the design's devices, with no warning, and the UX
//      review of that evidence has no open difference;
//    - a terminal demo or a TUI: the landed work's recording is captured, with no warning;
//    then "built-and-verified". Otherwise "built-not-verified", with the first gap (`NotVerified`). An interface, an
//    algorithm or a topology has no check yet, so it is never verified.
// 6. "designed": in force, and nothing has built this version yet (no task, or only tasks not started).
//
// A baseline item (ORC-032, 2.4): the version in force reproduces the code as it is today, and the import's baseline
// Lock in put it there. The repository at the import's commit built it, so after the draft (3) it is built: verified
// when every rule has a passing test (the import's baseline run, or later landed checks) and, for a screen, a
// terminal demo or a TUI, the import's capture recorded it with no failure. Once a newer version is in force, the
// rules above apply to it.
//
// Which version a task builds: the spec it builds from (the current spec, or for landed work the spec in force when it
// landed) was written at or after this version of the item came into force, or before it, for an earlier version.
//
// The landed work's evidence. The evidence record (evidence.ts) shows the landed work only when it is of the current
// design version, from the task that landed last of those that built this version, at the commit that landed.
//
// A difference. The UX review step reports each difference from the approved prototype as a finding (U3,
// server/factoryLink.ts). The UX review of an evidence record is the newest version of a UX review step's output whose
// run took that evidence artifact as its input (a person's edit keeps the evidence of the version it edits). Each of its
// blocking findings (an error or a warning that is not information only, findings.ts) is a difference. A finding
// that names blueprint items by id ("bi-3") is a difference of those items; one that names none is a difference of
// every item the evidence captured. A difference is explained only when the owner accepted it ("accept" by the
// owner, or carried from the owner's earlier "accept"); every other one is open: no decision, an open one, "fix",
// "follow-up", or an "accept" by the lead or the PE. Information-only findings are notes, never differences.

import { sameSha } from "../checks";
import { decisionFor, isBlocking } from "../findings";
import { currentSpec } from "../model/core";
import { estimatedParts, sumOfParts, type PartsSum } from "../spend";
import type { Artifact, Finding, FindingDecision, State, Task } from "../types";
import { blueprintItems, citedArtifact, draftChanges, itemIdsIn } from "./blueprint";
import { CAPTURE_DEVICES, isCapturedKind, itemEvidence, type CaptureDevice, type ItemEvidence, type NoEvidence, type NoRunYet } from "./evidence";
import { landedChangeSha, ruleResults, TESTED_KINDS, type ItemRuleResults } from "./ruleResults";
import { isAsIs } from "./studio";
import type { BlueprintItem, ImportPartCapture } from "./types";

export type ItemFactoryStatus = "designed" | "in-the-draft" | "being-built" | "built-not-verified" | "built-and-verified" | "fails-a-check" | "in-force";

/** A task that cites the item: not started, running, finished (not landed), or landed. */
export type CitingTaskState = "queued" | "running" | "finished" | "landed";

export interface CitingTask {
  taskId: string;
  title: string;
  state: CitingTaskState;
  /** Its spec came after this version of the item came into force: it builds this version, not an earlier one. */
  thisVersion: boolean;
  /** When it landed, for landed work. */
  landedAt?: string;
}

/**
 * Why work that built this version landed and the checks do not prove it: the first gap, as a fact.
 * - rules-unproved: rules or examples with no test, or a skipped one;
 * - no-rules: a flow or a contract with no rules or examples to test;
 * - kind-not-checked: an interface, an algorithm or a topology, which no check proves yet;
 * - no-evidence: the service captured nothing of it (no capture ran, or one ran and says why, with its log);
 * - evidence-not-landed: only work that has not landed has evidence;
 * - evidence-older-design: the evidence shows an earlier design version;
 * - evidence-earlier-work: the evidence is of a task that landed before the last one that built this version;
 * - evidence-earlier-commit: the evidence is of a commit before the one that landed (a repair came after it);
 * - evidence-missing-device: a screen with no screenshot on one of the design's devices;
 * - evidence-warning: the capture has a warning (a page error, a failure in the recording);
 * - no-ux-review: no UX review compared the screen's evidence with the design.
 */
export type NotVerified =
  | { why: "rules-unproved"; noTest: number; skipped: number }
  | { why: "no-rules" }
  | { why: "kind-not-checked" }
  | { why: "no-evidence"; reason: NoEvidence | "no-run"; detail?: string; log?: string }
  | { why: "evidence-not-landed" }
  | { why: "evidence-older-design"; version: number }
  | { why: "evidence-earlier-work"; taskId: string; landedTaskId: string }
  | { why: "evidence-earlier-commit"; commit: string; landedCommit: string }
  | { why: "evidence-missing-device"; devices: CaptureDevice[] }
  | { why: "evidence-warning"; warning: string }
  | { why: "no-ux-review" };

/** One difference the UX review reported for the item: a blocking finding, with its decision. */
export interface UxDifference {
  findingId: string;
  title: string;
  detail: string;
  severity: Finding["severity"];
  action: Finding["action"];
  /** "explained": the owner accepted it. "open": anything else. */
  state: "open" | "explained";
  decision?: { id: string; status: FindingDecision["status"]; by?: FindingDecision["decidedBy"]; followUpTaskId?: string };
}

/** The UX review of the item's evidence record: its differences, and its information-only notes. */
export interface UxReviewOfItem {
  taskId: string;
  artifactId: string;
  at: string;
  differences: UxDifference[];
  notes: { findingId: string; title: string }[];
  /** The evidence it compared is the landed work's: its open differences fail a check. */
  ofLandedWork: boolean;
}

export interface ItemFactoryView {
  item: BlueprintItem;
  status: ItemFactoryStatus;
  /** Since when this version (and variant) of the item is in force. */
  since: string;
  /** The tasks that cite the item, in the board's order; cancelled tasks are left out. */
  tasks: CitingTask[];
  /** Its rules and examples with their test results, for a flow or a contract with rules. */
  rules?: ItemRuleResults;
  /** What the service captured of it, for a screen, a terminal demo or a TUI. */
  evidence?: ItemEvidence | NoRunYet;
  /** The UX review of that evidence, when one compared it. */
  uxReview?: UxReviewOfItem;
  /** "built-not-verified": the first gap the checks leave. */
  notVerified?: NotVerified;
  /** The owner's draft changes the item (to the draft's version) or drops it. */
  draft?: { change: "changed"; item: BlueprintItem } | { change: "dropped" };
  /** A baseline item (ORC-032): the import that built it, at its commit, and what its capture recorded of the part. */
  baseline?: { importId: string; commit: string; capture?: ImportPartCapture };
}

const sameVersion = (a: BlueprintItem, b: BlueprintItem) => a.artifactId === b.artifactId && a.version === b.version && a.variant === b.variant;

/** The time of the oldest revision in the unbroken run, up to the one in force, that holds this version approved. */
function versionSince(s: State, item: BlueprintItem): string {
  let since = s.blueprint.revisions.at(-1)?.at ?? "";
  for (let i = s.blueprint.revisions.length - 1; i >= 0; i--) {
    const rev = s.blueprint.revisions[i];
    const it = rev.items.find((x) => x.id === item.id);
    if (!it || it.status !== "approved" || !sameVersion(it, item)) break;
    since = rev.at;
  }
  return since;
}

/** The spec a task builds from: for landed work, the one in force when it landed. */
function specBuilt(t: Task) {
  const landedAt = t.integration?.landed?.at;
  return (landedAt ? t.specs.filter((x) => x.at <= landedAt).at(-1) : undefined) ?? currentSpec(t);
}

function citingState(t: Task): CitingTaskState | undefined {
  if (t.lifecycle === "cancelled") return undefined;
  if (t.integration?.landed) return "landed";
  if (t.lifecycle === "done") return "finished";
  return t.lifecycle === "active" ? "running" : "queued";
}

function citingTasks(s: State, item: BlueprintItem, since: string): CitingTask[] {
  const out: CitingTask[] = [];
  for (const t of s.tasks) {
    const state = citingState(t);
    const spec = specBuilt(t);
    if (!state || !(spec.content.blueprintRefs ?? []).includes(item.id)) continue;
    const landedAt = t.integration?.landed?.at;
    out.push({ taskId: t.id, title: currentSpec(t).content.title, state, thisVersion: spec.at >= since, ...(state === "landed" && landedAt ? { landedAt } : {}) });
  }
  return out;
}

// ---------- the UX review of an evidence record ----------

/** The evidence artifact a review artifact's run took as its input; a person's edit keeps the one of the version it edits. */
function reviewedEvidence(s: State, art: Artifact, depth = 0): string | undefined {
  if (art.author === "user") {
    if (depth > 20) return undefined;
    let prev: Artifact | undefined;
    for (const x of s.artifacts) if (x.taskId === art.taskId && x.stepId === art.stepId && x.name === art.name && x.version < art.version && (!prev || x.version > prev.version)) prev = x;
    return prev && reviewedEvidence(s, prev, depth + 1);
  }
  const run = s.attempts.find((a) => a.id === art.attemptId);
  return run?.snapshot.inputs.find((i) => s.artifacts.some((x) => x.id === i.artifactId && x.kind === "evidence"))?.artifactId;
}

/** A UX review step's output: a review-findings artifact of a step whose role is the UX reviewer. */
function isUxReview(s: State, t: Task, art: Artifact): boolean {
  if (art.kind !== "review-findings" || art.taskId !== t.id) return false;
  const run = s.attempts.find((a) => a.id === art.attemptId);
  return (run?.snapshot.role ?? t.steps.find((st) => st.id === art.stepId)?.role) === "ux_reviewer";
}

/** The owner accepted it: "accept" by the owner, or carried from the owner's earlier "accept". */
function ownerAccepted(s: State, d: FindingDecision | undefined): boolean {
  for (let i = 0; d && i < 20; i++) {
    if (d.status !== "accept") return false;
    if (d.decidedBy === "user") return true;
    if (d.decidedBy !== "carried" || !d.carriedFrom) return false;
    const from: string = d.carriedFrom;
    d = s.decisions.find((x) => x.id === from);
  }
  return false;
}

/** The blueprint items a finding names by id; none means it is about every item the evidence captured. */
function namedItems(s: State, f: Finding): Set<string> {
  const known = new Set(blueprintItems(s).map((i) => i.id));
  return new Set(itemIdsIn(`${f.title}\n${f.detail}`).filter((id) => known.has(id)));
}

function uxReviewOf(s: State, ev: ItemEvidence, ofLandedWork: boolean): UxReviewOfItem | undefined {
  const t = s.tasks.find((x) => x.id === ev.from.taskId);
  if (!t) return undefined;
  let review: Artifact | undefined;
  for (const art of s.artifacts) {
    if (!isUxReview(s, t, art) || reviewedEvidence(s, art) !== ev.from.artifactId) continue;
    if (!review || art.version > review.version || (art.version === review.version && art.createdAt > review.createdAt)) review = art;
  }
  if (!review) return undefined;
  const differences: UxDifference[] = [];
  const notes: UxReviewOfItem["notes"] = [];
  for (const f of review.findings ?? []) {
    const named = namedItems(s, f);
    if (named.size && !named.has(ev.itemId)) continue;
    if (!isBlocking(f)) {
      notes.push({ findingId: f.id, title: f.title });
      continue;
    }
    const d = decisionFor(s, review, f);
    differences.push({
      findingId: f.id,
      title: f.title,
      detail: f.detail,
      severity: f.severity,
      action: f.action,
      state: ownerAccepted(s, d) ? "explained" : "open",
      ...(d ? { decision: { id: d.id, status: d.status, ...(d.decidedBy ? { by: d.decidedBy } : {}), ...(d.followUpTaskId ? { followUpTaskId: d.followUpTaskId } : {}) } } : {}),
    });
  }
  // A summary-only review (from before structured findings) counts its open findings as differences it does not name.
  if (!review.findings && (review.openFindings ?? 0) > 0) differences.push({ findingId: "", title: `${review.openFindings} open finding${review.openFindings === 1 ? "" : "s"}`, detail: review.summary, severity: "warning", action: "ask-user", state: "open" });
  return { taskId: t.id, artifactId: review.id, at: review.createdAt, differences, notes, ofLandedWork };
}

// ---------- the checks of landed work, by kind ----------

/** The devices a screen is designed for, within the project's device scope (as the studio shows it). */
export function screenDevices(s: State, item: BlueprintItem): CaptureDevice[] {
  const a = citedArtifact(s, item);
  return CAPTURE_DEVICES.filter((d) => s.project.devices.includes(d) && (!a || a.devices.length === 0 || a.devices.includes(d)));
}

/** The gap in the landed work's evidence, or none when the evidence is the landed work's and complete. */
function evidenceGap(s: State, item: BlueprintItem, ev: ItemEvidence | NoRunYet, last: CitingTask): NotVerified | undefined {
  if (ev.status === "no-run") return { why: "no-evidence", reason: "no-run" };
  const landedOf = landedWork(s, ev, last);
  if (landedOf) return landedOf;
  if (ev.status === "none") return { why: "no-evidence", reason: ev.reason, detail: ev.detail, ...(ev.log ? { log: ev.log } : {}) };
  if (item.kind === "screen") {
    const missing = screenDevices(s, item).filter((d) => !ev.files.some((f) => f.type === "png" && f.device === d));
    if (missing.length) return { why: "evidence-missing-device", devices: missing };
  }
  if (ev.warnings?.length) return { why: "evidence-warning", warning: ev.warnings[0] };
  return undefined;
}

/** Undefined when the record shows the landed work: this design version, the last landed task, its landed commit. */
function landedWork(s: State, ev: ItemEvidence, last: CitingTask): NotVerified | undefined {
  if (!ev.from.landed) return { why: "evidence-not-landed" };
  if (!ev.current) return { why: "evidence-older-design", version: ev.design.version };
  if (ev.from.taskId !== last.taskId) return { why: "evidence-earlier-work", taskId: ev.from.taskId, landedTaskId: last.taskId };
  const t = s.tasks.find((x) => x.id === last.taskId);
  const landed = t && landedChangeSha(s, t);
  if (!landed || !sameSha(ev.commit, landed)) return { why: "evidence-earlier-commit", commit: ev.commit, landedCommit: landed ?? "" };
  return undefined;
}

/**
 * The gap the rules leave: some have no passing test; or a flow or a contract has none (its rules are its only check).
 * Undefined when every rule passes, or when the item has no rules and other checks prove it.
 */
function rulesGap(item: BlueprintItem, rules: ItemRuleResults | undefined): NotVerified | undefined {
  if (rules) return rules.allPass ? undefined : { why: "rules-unproved", noTest: rules.counts["no-test"], skipped: rules.counts.skipped };
  return TESTED_KINDS.includes(item.kind) ? { why: "no-rules" } : undefined;
}

/** The first gap the checks leave in landed work on this version; undefined when they prove it. */
function notVerified(s: State, item: BlueprintItem, last: CitingTask, rules: ItemRuleResults | undefined, ev: ItemEvidence | NoRunYet | undefined, ux: UxReviewOfItem | undefined): NotVerified | undefined {
  const r = rulesGap(item, rules);
  if (r || TESTED_KINDS.includes(item.kind)) return r;
  if (!isCapturedKind(item.kind) || !ev) return rules ? undefined : { why: "kind-not-checked" };
  const gap = evidenceGap(s, item, ev, last);
  if (gap) return gap;
  if (item.kind === "screen" && !ux) return { why: "no-ux-review" };
  return undefined;
}

/**
 * The first gap the checks leave in a baseline item (ORC-032, 2.4); undefined when they prove it: its rules, then for
 * a screen, a terminal demo or a TUI the import's capture of it (recorded, on each device for a screen, no warning).
 */
function baselineGap(s: State, item: BlueprintItem, rules: ItemRuleResults | undefined, cap: ImportPartCapture | undefined): NotVerified | undefined {
  const r = rulesGap(item, rules);
  if (r || TESTED_KINDS.includes(item.kind)) return r;
  if (!isCapturedKind(item.kind)) return rules ? undefined : { why: "kind-not-checked" };
  if (!cap) return { why: "no-evidence", reason: "no-run" };
  if (cap.status === "none") return { why: "no-evidence", reason: cap.reason, detail: cap.detail, ...(cap.log ? { log: cap.log } : {}) };
  if (item.kind === "screen") {
    const missing = screenDevices(s, item).filter((d) => !cap.files.some((f) => f.type === "png" && f.device === d));
    if (missing.length) return { why: "evidence-missing-device", devices: missing };
  }
  return cap.warnings?.length ? { why: "evidence-warning", warning: cap.warnings[0] } : undefined;
}

/** The import that put this item's version into force as the baseline, with its capture of the part; else undefined. */
function baselineOf(s: State, item: BlueprintItem): ItemFactoryView["baseline"] {
  const imp = s.studio.import;
  if (!imp?.lockedInAt || !isAsIs(s, item)) return undefined;
  const capture = imp.capture?.parts.find((p) => p.artifactId === item.artifactId);
  return { importId: imp.id, commit: imp.commit, ...(capture ? { capture } : {}) };
}

/** Where one item in force stands in the factory; undefined when the version in force has no item with this id. */
export function itemFactoryStatus(s: State, itemId: string): ItemFactoryView | undefined {
  const item = blueprintItems(s).find((i) => i.id === itemId);
  if (!item) return undefined;
  const since = versionSince(s, item);
  const tasks = citingTasks(s, item, since);
  const rules = ruleResults(s, item.id);
  const c = draftChanges(s);
  const changed = c.changed.find((x) => x.item.id === item.id);
  const draft = changed ? { change: "changed" as const, item: changed.item } : c.dropped.some((i) => i.id === item.id) ? { change: "dropped" as const } : undefined;

  // The landed work on this version: the task that landed last decides.
  const landedHere = tasks.filter((t) => t.state === "landed" && t.thisVersion);
  const last = landedHere.reduce<CitingTask | undefined>((a, t) => (!a || (t.landedAt ?? "") > (a.landedAt ?? "") ? t : a), undefined);
  const evidence = isCapturedKind(item.kind) ? itemEvidence(s, item.id) : undefined;
  const ofLandedWork = !!last && !!evidence && evidence.status !== "no-run" && !landedWork(s, evidence, last);
  const uxReview = evidence && evidence.status !== "no-run" ? uxReviewOf(s, evidence, ofLandedWork) : undefined;
  const openDifference = !!uxReview?.ofLandedWork && uxReview.differences.some((d) => d.state === "open");
  // A baseline item was built by the repository at the import's commit (ORC-032); other items, by landed work.
  const baseline = baselineOf(s, item);
  const gap = baseline ? baselineGap(s, item, rules, baseline.capture) : last ? notVerified(s, item, last, rules, evidence, uxReview) : undefined;

  const status: ItemFactoryStatus =
    item.kind === "dictionary"
      ? "in-force"
      : (rules && rules.counts.failed > 0) || openDifference
        ? "fails-a-check"
        : draft
          ? "in-the-draft"
          : baseline
            ? gap
              ? "built-not-verified"
              : "built-and-verified"
            : tasks.some((t) => t.thisVersion && (t.state === "running" || t.state === "finished"))
              ? "being-built"
              : last
                ? gap
                  ? "built-not-verified"
                  : "built-and-verified"
                : "designed";
  return {
    item,
    status,
    since,
    tasks,
    ...(rules ? { rules } : {}),
    ...(evidence ? { evidence } : {}),
    ...(uxReview ? { uxReview } : {}),
    ...(status === "built-not-verified" && gap ? { notVerified: gap } : {}),
    ...(draft ? { draft } : {}),
    ...(baseline ? { baseline } : {}),
  };
}

/**
 * The PE's estimate to build the rest (B-03): its building estimates summed over the parts it estimates
 * (`estimatedParts`) that no landed work has built in this version yet. Work that runs or waits counts in full; landed
 * work counts in the building spend instead. Nothing left to build is a known $0; a part with no estimate makes no total.
 */
export function restOfBuild(s: State): PartsSum {
  const built = (id: string) => !!itemFactoryStatus(s, id)?.tasks.some((t) => t.state === "landed" && t.thisVersion);
  return sumOfParts(
    s,
    estimatedParts(s).filter((i) => !built(i.id)),
    (e) => e.buildUsd,
  );
}

/** Every approved item in force, in the blueprint's order, with where it stands. Dropped and open items are left out. */
export function blueprintFactoryStatus(s: State): ItemFactoryView[] {
  return blueprintItems(s)
    .filter((i) => i.status === "approved")
    .map((i) => itemFactoryStatus(s, i.id)!)
    .filter(Boolean);
}
