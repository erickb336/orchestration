// The blueprint (ORC-029 2c, pass 5): what the owner approved from the studio, versioned, which the factory builds from.
//
// Two places hold it. The version in force is the newest revision: the factory builds from it, and task specs cite
// its items (`blueprintRefs`). The draft is the owner's working copy: approvals (one artifact, `approveArtifact`, or a
// whole round, `approveRound`) and drops (`dropBlueprintItem`) change only the draft, and the factory never reads it.
// The owner's Lock in (`lockIn`) puts the draft's changes into force as a new revision, with the summary the owner
// agreed to; Start the factory is the first Lock in. Open items stay in the draft. The lead never approves, drops,
// discards or locks in.
//
// Items keep their ids across revisions and are never removed from what is in force: a dropped item keeps its id with
// the status "dropped", so a spec that cites it stays valid. An item the owner could not approve as it stands (no
// variant picked, marked Change, PE review unfinished, an objection not overruled) is open, and the pre-flight and
// the Lock in summary name it. A Lock in while building that touches a task or brings new work is a change order.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { buildingSpend, maintenanceEstimate } from "../spend";
import { currentSpec, currentVision, draft, event, nextId } from "../model/core";
import { pushVision } from "../model/vision";
import { newWorkReview } from "../peReview";
import { ControlError, StaleWriteError, type Finding, type State, type Task } from "../types";
import { artifactName, covers, currentFeedback, latestArtifacts, latestVersion, openObjections, peReview, readyForOwner, versionsOf } from "./studio";
import type { BlueprintItem, BlueprintRevision, ChangeOrder, DictionaryEntry, DraftVision, ItemEstimate, LockInSummary, StudioArtifact, TaskHandling, TouchedTask, TouchedTaskState, UsdRange } from "./types";

// ---------- the version in force ----------

/** The revision in force; undefined until the first Lock in (or, before pass 5, the first approval). */
export function currentBlueprint(s: State): BlueprintRevision | undefined {
  return s.blueprint.revisions.at(-1);
}

/** The revision number in force: 0 while nothing is. */
export function blueprintRev(s: State): number {
  return currentBlueprint(s)?.rev ?? 0;
}

/** Every item in force: approved, open (from before pass 5) and dropped. */
export function blueprintItems(s: State): BlueprintItem[] {
  return currentBlueprint(s)?.items ?? [];
}

// ---------- the draft ----------

/** The draft's revision: Lock in and Start the factory name the one their summary showed (compare-and-set). */
export function draftRev(s: State): number {
  return s.blueprint.draft.rev;
}

/** Every item of the draft: approved, open and dropped. */
export function draftItems(s: State): BlueprintItem[] {
  return s.blueprint.draft.items;
}

/** The variant an approval is about: the one named, or the only one. Several variants and none named is a pick still open. */
function chosenVariant(a: StudioArtifact, variant: string | undefined): string | undefined {
  return a.variants.length === 1 ? a.variants[0].id : variant;
}

/** Why the owner cannot approve this version with this variant as it stands, or undefined when they can. */
function approvalBlocker(s: State, a: StudioArtifact, variant: string | undefined): string | undefined {
  if (!readyForOwner(s, a)) return peReview(s, a).status === "waiting" ? "waiting for PE review" : "the designer is revising it after PE review";
  if (currentFeedback(s, a.id, a.version)?.mark === "drop") return "you marked it Drop";
  const v = chosenVariant(a, variant);
  if (a.variants.length > 1 && v === undefined) return "your pick between its variants is open";
  // A term or a rule marked Change or Drop waits for the next version, which makes the change (pass 4d).
  const rows = (currentFeedback(s, a.id, a.version)?.rows ?? []).filter((r) => r.mark !== "keep" && (r.variant === undefined || r.variant === v));
  if (rows.length) return `you marked ${rows.length} ${a.dictionary ? "term" : "rule"}${rows.length === 1 ? "" : "s"} Change or Drop (${rows.slice(0, 3).map((r) => `"${r.row}"`).join(", ")}${rows.length > 3 ? ", …" : ""}); the next version makes the change, or clear those marks to approve this one`;
  const objection = openObjections(s, a).find((o) => o.variant === undefined || o.variant === v);
  if (objection) return `the PE objects${objection.variant ? ` to ${a.variants.find((x) => x.id === objection.variant)?.label ?? objection.variant}` : ""} (${objection.reasons.split("\n")[0]}); overrule the objection to approve it`;
  return undefined;
}

/** The item that stands for this artifact: its own, or the one of the artifact it replaces. */
function itemOf(items: BlueprintItem[], a: StudioArtifact): BlueprintItem | undefined {
  return items.find((i) => i.artifactId === a.id) ?? (a.supersedes ? items.find((i) => i.artifactId === a.supersedes) : undefined);
}

function itemFor(s: State, items: BlueprintItem[], a: StudioArtifact, variant: string | undefined, status: BlueprintItem["status"]): BlueprintItem {
  const v = a.variants.length > 1 ? variant : undefined;
  return { id: itemOf(items, a)?.id ?? nextId(s, "bi"), kind: a.kind, title: a.title, artifactId: a.id, version: a.version, ...(v !== undefined ? { variant: v } : {}), status };
}

const same = (a: BlueprintItem | undefined, b: BlueprintItem) => !!a && JSON.stringify(a) === JSON.stringify(b);

/** Put `item` in place of the item with its id, or add it. */
function upsert(items: BlueprintItem[], item: BlueprintItem): BlueprintItem[] {
  return items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item];
}

/** Change the draft's items on a draft state: a new draft revision, and the owner's event. The draft's vision text stays. */
function changeDraft(s: State, items: BlueprintItem[], what: string, now: string) {
  s.blueprint.draft = { ...s.blueprint.draft, rev: s.blueprint.draft.rev + 1, items };
  event(s, now, "user", "vision", `The draft: ${what}`);
}

/**
 * The owner approves one artifact version into the draft. `version` is the one they saw (compare-and-set). With
 * several variants, the one approved is `variant`, or else the owner's pick. Refused while PE review is unfinished,
 * for a dropped artifact, without a pick, or on an objection not overruled. Nothing changes in force until Lock in.
 */
export function approveArtifact(state: State, input: { artifactId: string; version: number; variant?: string }, now: string): State {
  const latest = latestVersion(state, input.artifactId);
  if (!latest) throw new ControlError(`Unknown studio artifact ${input.artifactId}.`);
  if (!versionsOf(state, input.artifactId).some((a) => a.version === input.version)) throw new ControlError(`${latest.title} has no version ${input.version}.`);
  if (latest.version !== input.version) throw new StaleWriteError(input.version, latest.version);
  const variant = input.variant ?? currentFeedback(state, latest.id, latest.version)?.pickedVariant;
  if (variant !== undefined && !latest.variants.some((v) => v.id === variant)) throw new ControlError(`${latest.title} has no variant ${variant}.`);
  const why = approvalBlocker(state, latest, variant);
  if (why) throw new ControlError(`${artifactName(latest)} cannot be approved yet: ${why}.`);
  const s = draft(state);
  const items = draftItems(s);
  const item = itemFor(s, items, latest, chosenVariant(latest, variant), "approved");
  if (same(items.find((i) => i.id === item.id), item)) throw new ControlError(`${artifactName(latest)} is already approved in the blueprint.`);
  const label = item.variant ? ` (${latest.variants.find((v) => v.id === item.variant)!.label})` : "";
  changeDraft(s, upsert(items, item), `approved ${artifactName(latest)}${label}`, now);
  return s;
}

/**
 * The owner approves a whole round into the draft: the newest version of each artifact made in that round. Each is
 * approved where it can be as it stands (with the owner's pick); otherwise it is listed as open, unless it is already
 * approved at an earlier version, which stays. What the owner marked Change is open; Drop is left out. An item the
 * owner dropped stays dropped: only approving that artifact on its own brings it back.
 */
export function approveRound(state: State, n: number, now: string): State {
  if (!state.studio.rounds.some((r) => r.n === n)) throw new ControlError(`There is no round ${n}.`);
  const arts = latestArtifacts(state).filter((a) => a.round === n);
  if (!arts.length) throw new ControlError(`Round ${n} has no artifacts to approve.`);
  const s = draft(state);
  let items = draftItems(s);
  let approved = 0;
  let open = 0;
  for (const a of arts) {
    const fb = currentFeedback(s, a.id, a.version);
    if (fb?.mark === "drop") continue;
    const why = fb?.mark === "change" ? "you marked it Change" : approvalBlocker(s, a, fb?.pickedVariant);
    const existing = itemOf(items, a);
    if (existing?.status === "dropped") continue;
    if (why && existing?.status === "approved") continue;
    const item = itemFor(s, items, a, chosenVariant(a, fb?.pickedVariant), why ? "open" : "approved");
    if (same(existing, item)) continue;
    items = upsert(items, item);
    if (why) open++;
    else approved++;
  }
  if (!approved && !open) throw new ControlError(`Round ${n} is already in the blueprint as it stands.`);
  changeDraft(s, items, `approved round ${n}: ${approved} approved${open ? `, ${open} still open` : ""}`, now);
  return s;
}

/**
 * The owner drops an item from the draft, so its part leaves the design. The item is never deleted: it keeps its id
 * with the status "dropped", because task specs cite item ids. Refused for an unknown item and for one already dropped.
 */
export function dropBlueprintItem(state: State, itemId: string, now: string): State {
  const item = draftItems(state).find((i) => i.id === itemId);
  if (!item) throw new ControlError(`There is no blueprint item ${itemId}.`);
  if (item.status === "dropped") throw new ControlError(`${item.title} v${item.version} is already dropped.`);
  const s = draft(state);
  changeDraft(s, upsert(draftItems(s), { ...item, status: "dropped" }), `dropped ${item.title} v${item.version}`, now);
  return s;
}

/** The draft's changes against the version in force, and its open items. */
export interface DraftChanges {
  added: BlueprintItem[];
  changed: { item: BlueprintItem; replaces: BlueprintItem }[];
  /** The items as they are in force, which the draft drops. */
  dropped: BlueprintItem[];
  open: BlueprintItem[];
  /** The draft's vision text, when it differs from the text in force (an edit after the start). */
  vision?: DraftVision;
}

/**
 * The draft against the version in force, item by item:
 * - approved in the draft and not approved in force (absent, open or dropped): added;
 * - approved in both and different: changed, replacing the one in force;
 * - dropped in the draft and approved or open in force: dropped;
 * - open in the draft: open (it stays in the draft; the factory keeps what is in force).
 * Anything else (the same in both, or dropped before it ever was in force) is no change.
 */
export function draftChanges(s: State): DraftChanges {
  const inForce = new Map(blueprintItems(s).map((i) => [i.id, i]));
  const out: DraftChanges = { added: [], changed: [], dropped: [], open: [] };
  for (const d of draftItems(s)) {
    const f = inForce.get(d.id);
    if (d.status === "open") out.open.push(d);
    else if (d.status === "approved") {
      if (f?.status !== "approved") out.added.push(d);
      else if (!same(f, d)) out.changed.push({ item: d, replaces: f });
    } else if (f && f.status !== "dropped") out.dropped.push(f);
  }
  const vision = s.blueprint.draft.vision;
  if (vision && vision.text !== currentVision(s).text) out.vision = vision;
  return out;
}

const hasChange = (c: DraftChanges) => c.added.length + c.changed.length + c.dropped.length > 0 || !!c.vision;

/** Whether the draft holds anything to show: a change, or an open item. */
export function hasDraft(s: State): boolean {
  const c = draftChanges(s);
  return hasChange(c) || c.open.length > 0;
}

/**
 * The owner discards the draft: it becomes the version in force again, its changes and open items gone. `draftRev`
 * is the draft revision they saw (compare-and-set). Refused when there is no draft. The studio's artifacts, marks and
 * feedback stay; only the approvals and drops since the last Lock in go.
 */
export function discardDraft(state: State, seenRev: number, now: string): State {
  const rev = draftRev(state);
  if (seenRev !== rev) throw new StaleWriteError(seenRev, rev);
  if (!hasDraft(state)) throw new ControlError("There is no draft to discard: it is the version in force.");
  const s = draft(state);
  // The draft's vision text goes too: the vision in force stands.
  delete s.blueprint.draft.vision;
  changeDraft(s, structuredClone(blueprintItems(s)), `discarded; it is the version in force${blueprintRev(s) ? ` (r${blueprintRev(s)})` : ""} again`, now);
  return s;
}

// ---------- the Lock in summary ----------

/** A task's state for the summary: not started, started, or finished. Undefined for a cancelled task. */
function taskState(t: Task): TouchedTaskState | undefined {
  if (t.lifecycle === "cancelled") return undefined;
  return t.lifecycle === "active" ? "running" : t.lifecycle === "done" ? "landed" : "queued";
}

/** What happens to a touched task (r14). Only a task not started yet that builds only dropped items is retired. */
function handlingOf(state: TouchedTaskState, onlyDropped: boolean): TaskHandling {
  if (state === "running") return "finish-then-revise";
  if (state === "landed") return "plan-revision";
  return onlyDropped ? "retire" : "update-spec";
}

const refsOf = (t: Task) => currentSpec(t).content.blueprintRefs ?? [];

/** The PE's newest estimate on the item's version (and variant), or null: no estimate. */
function peEstimate(s: State, item: BlueprintItem): ItemEstimate {
  const v = s.studio.verdicts.filter((x) => x.artifactId === item.artifactId && x.version === item.version && covers(x, item.variant) && x.budget).at(-1);
  return { itemId: item.id, estimate: v?.budget ? structuredClone(v.budget) : null };
}

/** The sum of one range over the estimates; null when there is none, or one has no figure for it. */
function sumRange(estimates: ItemEstimate[], pick: (e: NonNullable<ItemEstimate["estimate"]>) => UsdRange | undefined): UsdRange | null {
  if (!estimates.length) return null;
  let lo = 0;
  let hi = 0;
  for (const e of estimates) {
    const r = e.estimate ? pick(e.estimate) : undefined;
    if (!r) return null;
    lo += r[0];
    hi += r[1];
  }
  return [lo, hi];
}

/** The open items of the draft, each with what keeps it open now (the pre-flight and the Lock in summary list them). */
export interface OpenItem {
  item: BlueprintItem;
  why: string;
}

/** The draft's open items, each with what keeps it open as the studio stands now. */
export function openBlueprintItems(s: State): OpenItem[] {
  return draftItems(s)
    .filter((i) => i.status === "open")
    .map((item) => {
      const a = latestVersion(s, item.artifactId)!;
      const mark = currentFeedback(s, a.id, a.version)?.mark;
      const why = mark === "change" ? "you marked it Change" : (approvalBlocker(s, a, currentFeedback(s, a.id, a.version)?.pickedVariant) ?? "ready for your approval");
      return { item, why };
    });
}

/**
 * What a Lock in of the draft would do now (pass 5, screen 3):
 * - the changes: added, changed (with the version each replaces), and dropped;
 * - the tasks it touches: those whose current spec cites an added, changed or dropped item, with their state and
 *   what happens to each (r14): queued, the lead updates its spec; running, it finishes and then the lead revises it;
 *   landed, the lead plans a revision; queued and building only dropped items, it is retired;
 * - the new work: added items no task cites;
 * - the budgets: the spend and the maintenance estimate so far, and the PE's estimate of each added or changed item
 *   (null where the PE gave none: never $0);
 * - what stays open: the draft's open items, with what the factory keeps meanwhile.
 */
export function lockInSummary(s: State): LockInSummary {
  const c = draftChanges(s);
  const touched = new Set([...c.added.map((i) => i.id), ...c.changed.map((x) => x.item.id), ...c.dropped.map((i) => i.id)]);
  const inForce = new Map(blueprintItems(s).map((i) => [i.id, i]));
  const droppedAfter = (id: string) => c.dropped.some((i) => i.id === id) || inForce.get(id)?.status === "dropped";
  const tasks: TouchedTask[] = [];
  for (const t of s.tasks) {
    const state = taskState(t);
    const refs = refsOf(t);
    const items = refs.filter((r) => touched.has(r));
    if (!state || !items.length) continue;
    tasks.push({ taskId: t.id, title: currentSpec(t).content.title, state, items, handling: handlingOf(state, refs.every(droppedAfter)) });
  }
  const cited = new Set(s.tasks.filter((t) => t.lifecycle !== "cancelled").flatMap(refsOf));
  const estimates = [...c.added, ...c.changed.map((x) => x.item)].map((i) => peEstimate(s, i));
  const spend = buildingSpend(s);
  const m = maintenanceEstimate(s);
  const why = new Map(openBlueprintItems(s).map((o) => [o.item.id, o.why]));
  return {
    draftRev: draftRev(s),
    inForceRev: blueprintRev(s),
    changes: { added: c.added, changed: c.changed, dropped: c.dropped, ...(c.vision ? { vision: { text: c.vision.text, reason: c.vision.reason, replacesRev: currentVision(s).rev } } : {}) },
    tasks,
    newWork: c.added.filter((i) => !cited.has(i.id)).map((i) => i.id),
    budgets: {
      building: { budgetUsd: s.project.budgets.buildingUsd, spentUsd: spend.usd, unknownRuns: spend.unknown.length },
      maintenance: { budgetUsdPerMonth: s.project.budgets.maintenanceUsdPerMonth, estimateUsdPerMonth: m.startUsd === null ? null : m.startUsd + m.callsUsd },
      items: estimates,
      itemsTotal: { buildUsd: sumRange(estimates, (e) => e.buildUsd), maintenanceUsdPerMonth: sumRange(estimates, (e) => e.maintenanceUsdPerMonth) },
    },
    stillOpen: c.open.map((item) => ({ item, why: why.get(item.id) ?? "open", ...(inForce.has(item.id) ? { inForce: inForce.get(item.id)! } : {}) })),
  };
}

// ---------- Lock in ----------

/**
 * The digest of a Lock in summary: SHA-256 of its RFC 8785 canonical JSON, as hex. Pure, and the same in the app and
 * the service, so the app sends the digest of the summary it showed and the Lock in compares it with the summary it
 * would record.
 */
export function summaryDigest(summary: LockInSummary): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalize(summary) ?? "null")));
}

/** What the owner saw before a Lock in: the draft revision and the digest of the summary (compare-and-set). */
export interface SummarySeen {
  draftRev: number;
  summaryDigest: string;
}

/**
 * Refuse a Lock in whose summary is not the one the owner saw: the draft, a touched task's state or handling, the new
 * work or the budgets changed since. The record then holds exactly what the owner agreed to.
 */
export function assertSummarySeen(s: State, seen: SummarySeen): void {
  const rev = draftRev(s);
  if (seen.draftRev !== rev) throw new StaleWriteError(seen.draftRev, rev);
  if (seen.summaryDigest !== summaryDigest(lockInSummary(s)))
    throw new StaleWriteError(rev, rev, "The Lock in summary changed since you read it (a task, its handling, the budgets or the draft). Read the new summary, and agree again.");
}

/** "added Packing list v1; changed Trip plan v3 → v4; dropped Reminders flow v1". */
function changeWords(c: LockInSummary["changes"]): string {
  const name = (i: BlueprintItem) => `${i.title} v${i.version}`;
  return [
    c.added.length ? `added ${c.added.map(name).join(", ")}` : "",
    c.changed.length ? `changed ${c.changed.map((x) => `${x.replaces.title} v${x.replaces.version} → v${x.item.version}`).join(", ")}` : "",
    c.dropped.length ? `dropped ${c.dropped.map(name).join(", ")}` : "",
    c.vision ? "changed the vision text" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Put the draft's changes into force on a draft state, as a new revision recording the owner's agreement and the
 * summary: approved items replace or join those in force, dropped items stay in force as "dropped", and open items
 * leave in force what was there (they stay in the draft). The draft's revision moves on. While building, a Lock in
 * that touches a task or brings new work is also a change order. The caller checked that the draft has a change.
 * Called by `lockIn` and by Start the factory (the first Lock in), nothing else.
 */
export function putDraftInForce(s: State, now: string): void {
  const summary = lockInSummary(s);
  // The draft's vision text goes into force first, so the revision stands on it (pass 5, r10). The focus in force stays.
  const dv = s.blueprint.draft.vision;
  if (summary.changes.vision && dv) {
    pushVision(s, { author: "user", text: dv.text, focus: currentVision(s).focus, reason: `Locked in: ${dv.reason}`, ...(dv.source ? { source: { ...dv.source, messageIds: [...dv.source.messageIds] } } : {}), ...(dv.simulated ? { simulated: true as const } : {}) }, now);
  }
  const byId = new Map(draftItems(s).map((i) => [i.id, i]));
  const dropped = new Set(summary.changes.dropped.map((i) => i.id));
  const kept = blueprintItems(s).map((f) => {
    const d = byId.get(f.id);
    if (dropped.has(f.id)) return { ...f, status: "dropped" as const };
    return d?.status === "approved" ? d : f;
  });
  const known = new Set(kept.map((i) => i.id));
  const items = [...kept, ...summary.changes.added.filter((i) => !known.has(i.id))];
  const rev = blueprintRev(s) + 1;
  const reason = `locked in: ${changeWords(summary.changes)}`;
  s.blueprint.revisions.push({ rev, at: now, visionRev: currentVision(s).rev, reason, items: structuredClone(items), lockIn: { by: "user", summary } });
  // The draft moves on; its vision text is in force now, so it holds none.
  s.blueprint.draft = { rev: s.blueprint.draft.rev + 1, items: s.blueprint.draft.items };
  const open = summary.stillOpen.length;
  event(s, now, "user", "vision", `Lock in r${rev}: ${changeWords(summary.changes)}${open ? `; ${open} open item${open === 1 ? " stays" : "s stay"} in the draft` : ""}`);
  if (s.project.stage !== "building") return;
  const tasks = summary.tasks.map((t) => ({ taskId: t.taskId, handling: t.handling }));
  // Nothing to adjust: a change order would wait for an update that never comes, so the Lock in is only recorded.
  if (!tasks.length && !summary.newWork.length) return void event(s, now, "system", "vision", `No change order for blueprint r${rev}: no task cites the changed items, and nothing new is to be built`);
  const handler = s.project.changeOrders;
  const changedItems = [...summary.changes.added, ...summary.changes.changed.map((x) => x.item)].map((i) => i.id);
  s.blueprint.changeOrders.push({ rev, at: now, changedItems, droppedItems: [...dropped], tasks, newWork: summary.newWork, status: "open", handler });
  const plan = [tasks.length ? `it touches ${tasks.map((t) => `${t.taskId} (${HANDLING_WORDS[t.handling]})`).join(", ")}` : "", summary.newWork.length ? `${summary.newWork.length} new item${summary.newWork.length === 1 ? "" : "s"} to plan` : ""].filter(Boolean).join("; ");
  // With PE review of new work on, an updated spec and each new task wait for the PE before they start (2e).
  const pe = newWorkReview(s) ? "; updated and new work waits for the PE before it starts" : "";
  event(s, now, "system", "vision", `Change order for blueprint r${rev}: ${plan}; ${handler === "user" ? "the lead's updates wait for your go-ahead" : "the lead updates the affected tasks, and you can undo each update"}${pe}`);
}

/** What happens to a touched task, in words. */
export const HANDLING_WORDS: Record<TaskHandling, string> = {
  "update-spec": "the lead updates its spec",
  "finish-then-revise": "it finishes, then the lead revises it",
  "plan-revision": "the lead plans a revision",
  retire: "retired",
};

/**
 * Lock in: the owner's command, never the lead's, a setting's or Autopilot's. It puts the whole draft into force as
 * a new blueprint revision and records the owner's agreement with the summary. `seen` is the draft revision and the
 * digest of the summary the owner saw (compare-and-set, `assertSummarySeen`). Refused in Vision, where Start the factory is the first Lock in, and when the
 * draft has no change (open items alone stay in the draft). The store allows only this command and Start the factory
 * to make a blueprint revision.
 */
export function lockIn(state: State, seen: SummarySeen, now: string): State {
  if (state.project.stage !== "building") throw new ControlError("In Vision, Start the factory is your first Lock in.");
  assertSummarySeen(state, seen);
  const c = draftChanges(state);
  if (!hasChange(c)) throw new ControlError(c.open.length ? "There is nothing to lock in: the draft holds only open items, which stay in the draft." : "There is nothing to lock in: the draft is the version in force.");
  const s = draft(state);
  putDraftInForce(s, now);
  return s;
}

// ---------- the project's dictionary ----------

/** The project's dictionary: the approved blueprint item, its version, and its terms. */
export interface DictionaryInForce {
  item: BlueprintItem;
  artifact: StudioArtifact;
  entries: DictionaryEntry[];
}

/**
 * The approved dictionary among these items; with two approved, the one approved last: the newest to come into the
 * revisions as it is now, and one that no revision holds as it is (a change in the draft) is newer than any.
 */
function dictionaryAmong(s: State, items: BlueprintItem[]): DictionaryInForce | undefined {
  const approved = items.filter((i) => i.kind === "dictionary" && i.status === "approved");
  if (!approved.length) return undefined;
  const approvedIn = (i: BlueprintItem) => {
    const k = s.blueprint.revisions.findIndex((r) => r.items.some((x) => same(x, i)));
    return k < 0 ? s.blueprint.revisions.length : k;
  };
  const item = approved.reduce((a, b) => (approvedIn(b) >= approvedIn(a) ? b : a));
  const artifact = versionsOf(s, item.artifactId).find((a) => a.version === item.version);
  return artifact?.dictionary ? { item, artifact, entries: artifact.dictionary } : undefined;
}

/**
 * The dictionary in force (pass 4d, decision 6): the dictionary version locked in, which the factory's agents get. A
 * version still in review, unapproved, open, dropped or only in the draft is not in force. Undefined until one is.
 */
export function dictionaryInForce(s: State): DictionaryInForce | undefined {
  return dictionaryAmong(s, blueprintItems(s));
}

/**
 * The draft's dictionary: the newest words the owner approved, which the studio works with (the lead, the designer,
 * the PE and the writing check of their text). The same as the one in force while the draft does not change it.
 */
export function dictionaryInDraft(s: State): DictionaryInForce | undefined {
  return dictionaryAmong(s, draftItems(s));
}

// ---------- task specs and change orders ----------

/**
 * A task spec's references to blueprint items, checked against the version in force (the factory never builds from
 * the draft): every id must name an item in force (items in force are never removed, so a reference stays valid).
 * Repeats are dropped.
 */
export function validateBlueprintRefs(s: State, refs: string[]): string[] {
  const known = new Set(blueprintItems(s).map((i) => i.id));
  const unknown = refs.filter((r) => !known.has(r));
  if (unknown.length) throw new ControlError(`Not in the blueprint: ${[...new Set(unknown)].join(", ")}.`);
  return [...new Set(refs)];
}

/** The most blueprint items one task cites. */
export const MAX_BLUEPRINT_REFS = 20;

/** Why a cited id is not one the factory may build from: the words for each place an id can be other than approved and in force. */
const NOT_BUILDABLE = {
  unknown: "not in the blueprint",
  draft: "only in the draft: the owner has not locked it in yet",
  open: "still open, not approved",
  dropped: "dropped from the blueprint",
} as const;

/**
 * Why the lead's citations cannot stand, or undefined (pass 5, the factory link): each must name an item approved in
 * the version in force. An open item is not a design the owner approved, and the draft is not in force until the
 * owner's Lock in, so the factory builds from neither.
 */
export function leadRefsProblem(s: State, refs: unknown): string | undefined {
  if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string")) return '"blueprintRefs" must be a list of blueprint item ids';
  if (refs.length > MAX_BLUEPRINT_REFS) return `it cites ${refs.length} blueprint items; at most ${MAX_BLUEPRINT_REFS}`;
  const inForce = new Map(blueprintItems(s).map((i) => [i.id, i.status]));
  const inDraft = new Set(draftItems(s).map((i) => i.id));
  const place = (id: string): keyof typeof NOT_BUILDABLE | undefined => {
    const status = inForce.get(id);
    if (status === "approved") return undefined;
    if (status === "open" || status === "dropped") return status;
    return inDraft.has(id) ? "draft" : "unknown";
  };
  const problems = new Map<keyof typeof NOT_BUILDABLE, string[]>();
  for (const id of new Set(refs)) {
    const p = place(id);
    if (p) problems.set(p, [...(problems.get(p) ?? []), id]);
  }
  if (!problems.size) return undefined;
  return `${[...problems].map(([p, ids]) => `${ids.join(", ")}: ${NOT_BUILDABLE[p]}`).join("; ")}; cite only items approved in the blueprint in force`;
}

/** A cited item's version as approved: the artifact it stands for, at the approved version. */
export function citedArtifact(s: State, item: BlueprintItem): StudioArtifact | undefined {
  return versionsOf(s, item.artifactId).find((a) => a.version === item.version);
}

/** The blueprint item ids a text names, for example a review finding's "[bi-3] …" (pass 5): one reader for them all. */
export function itemIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\bbi-\d{1,9}\b/g)].map((m) => m[0]))];
}

/**
 * The items a fix for a review finding on `task` cites, so the fix counts for those items when it lands: the task's
 * approved items that the finding names, or all of them when it names none.
 */
export function followUpRefs(s: State, task: Task, finding: Pick<Finding, "title" | "detail">): string[] {
  const approved = new Set(blueprintItems(s).filter((i) => i.status === "approved").map((i) => i.id));
  const cited = (currentSpec(task).content.blueprintRefs ?? []).filter((r) => approved.has(r));
  const named = itemIdsIn(`${finding.title}\n${finding.detail}`).filter((id) => cited.includes(id));
  return named.length ? named : cited;
}

/** The tag a test carries for one rule or example of a blueprint item: "[bi-12 R3]" (one name for it everywhere). */
export const ruleTag = (itemId: string, lineId: string) => `[${itemId} ${lineId}]`;

/**
 * The acceptance a spec takes from the blueprint items it cites (pass 5): each rule and each example of a cited flow
 * (the approved variant's, or the only one's), with its tag, and one line for each cited contract. The tag
 * ("[bi-12 R3] When …") is the one the acceptance tests carry (ruleResults.ts); the item follows each line.
 */
export function blueprintAcceptance(s: State, refs: readonly string[]): string[] {
  const lines: string[] = [];
  for (const id of refs) {
    const item = blueprintItems(s).find((i) => i.id === id);
    const a = item && citedArtifact(s, item);
    if (!item || !a) continue;
    const from = `(${item.kind} "${item.title}", ${item.id})`;
    if (item.kind === "contract") lines.push(`[${item.id}] What crosses the boundary matches the approved contract "${item.title}" v${item.version}, with its examples.`);
    const rules = a.rules?.find((r) => r.variant === (item.variant ?? a.variants[0]?.id)) ?? (a.rules?.length === 1 ? a.rules[0] : undefined);
    if (!rules) continue;
    for (const r of rules.rules) lines.push(`${ruleTag(item.id, r.id)} ${r.text} ${from}`);
    for (const e of rules.examples) lines.push(`${ruleTag(item.id, e.id)} ${e.text} ${from}`);
  }
  return lines;
}

/** Open change orders, oldest first; with `handler`, only those whose updates wait for the owner's go-ahead or apply at once. */
export function openChangeOrders(s: State, handler?: ChangeOrder["handler"]): ChangeOrder[] {
  return s.blueprint.changeOrders.filter((c) => c.status === "open" && (handler === undefined || c.handler === handler));
}
