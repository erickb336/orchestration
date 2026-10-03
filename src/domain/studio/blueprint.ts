// The blueprint (ORC-029 2c): what the owner approved from the studio, versioned, which the factory builds from.
//
// Only the owner's approvals make a revision: one artifact (`approveArtifact`) or a whole round (`approveRound`).
// The lead never approves. Items keep their ids across revisions and are never removed, so a task spec can cite them
// (`blueprintRefs`). An item the owner could not approve as it stands (no variant picked, marked Change, PE review
// unfinished, an objection not overruled) is listed as open, and the pre-flight names it. A revision made while
// building is a change order listing the tasks whose current spec cites a changed item.

import { currentSpec, currentVision, draft, event, nextId } from "../model/core";
import { newWorkReview } from "../peReview";
import { ControlError, StaleWriteError, type State } from "../types";
import { artifactName, currentFeedback, latestArtifacts, latestVersion, openObjections, peReview, readyForOwner, versionsOf } from "./studio";
import type { BlueprintItem, BlueprintRevision, ChangeOrder, DictionaryEntry, StudioArtifact } from "./types";

/** The current blueprint revision; undefined until the owner first approves something. */
export function currentBlueprint(s: State): BlueprintRevision | undefined {
  return s.blueprint.revisions.at(-1);
}

/** The current blueprint revision number: 0 while nothing is approved. Start the factory compares it (compare-and-set). */
export function blueprintRev(s: State): number {
  return currentBlueprint(s)?.rev ?? 0;
}

/** Every item of the current blueprint, approved and open. */
export function blueprintItems(s: State): BlueprintItem[] {
  return currentBlueprint(s)?.items ?? [];
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

/** The blueprint item that stands for this artifact: its own, or the one of the artifact it replaces. */
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

/** Append a revision on a draft state; while building, one that touches a task is also a change order. */
function pushRevision(s: State, items: BlueprintItem[], reason: string, now: string) {
  const before = blueprintItems(s);
  const rev = blueprintRev(s) + 1;
  s.blueprint.revisions.push({ rev, at: now, visionRev: currentVision(s).rev, reason, items });
  event(s, now, "user", "vision", `Blueprint r${rev}: ${reason}`);
  if (s.project.stage !== "building") return;
  const was = new Map(before.map((i) => [i.id, JSON.stringify(i)]));
  const changedItems = items.filter((i) => was.get(i.id) !== JSON.stringify(i)).map((i) => i.id);
  const affectedTasks = s.tasks.filter((t) => t.lifecycle !== "cancelled" && (currentSpec(t).content.blueprintRefs ?? []).some((r) => changedItems.includes(r))).map((t) => t.id);
  // Nothing to update: a change order would wait for an update that never comes, so the revision is only recorded.
  if (!affectedTasks.length) return void event(s, now, "system", "vision", `No change order for blueprint r${rev}: no task cites the changed items`);
  const handler = s.project.changeOrders;
  // The lead's updates for it wait for PE review when the project has it on (2e).
  const peReview = newWorkReview(s);
  s.blueprint.changeOrders.push({ rev, at: now, changedItems, affectedTasks, status: "open", handler, ...(peReview ? { peReview } : {}) });
  event(
    s,
    now,
    "system",
    "vision",
    `Change order for blueprint r${rev}: it touches ${affectedTasks.join(", ")}; ${handler === "user" ? "it waits for you before the lead updates tasks" : "the lead updates the affected tasks"}${peReview ? ", once the PE agrees with the updates" : ""}`,
  );
}

/**
 * The owner approves one artifact version into the blueprint: a new revision. `version` is the one they saw
 * (compare-and-set). With several variants, the one approved is `variant`, or else the owner's pick. Refused while
 * PE review is unfinished, for a dropped artifact, without a pick, or on an objection not overruled.
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
  const items = blueprintItems(s);
  const item = itemFor(s, items, latest, chosenVariant(latest, variant), "approved");
  if (same(items.find((i) => i.id === item.id), item)) throw new ControlError(`${artifactName(latest)} is already approved in the blueprint.`);
  const label = item.variant ? ` (${latest.variants.find((v) => v.id === item.variant)!.label})` : "";
  pushRevision(s, upsert(items, item), `approved ${artifactName(latest)}${label}`, now);
  return s;
}

/**
 * The owner approves a whole round: a new revision with the newest version of each artifact made in that round.
 * Each is approved where it can be as it stands (with the owner's pick); otherwise it is listed as open, unless it is
 * already approved at an earlier version, which stays. What the owner marked Change is open; Drop is left out.
 */
export function approveRound(state: State, n: number, now: string): State {
  if (!state.studio.rounds.some((r) => r.n === n)) throw new ControlError(`There is no round ${n}.`);
  const arts = latestArtifacts(state).filter((a) => a.round === n);
  if (!arts.length) throw new ControlError(`Round ${n} has no artifacts to approve.`);
  const s = draft(state);
  let items = blueprintItems(s);
  let approved = 0;
  let open = 0;
  for (const a of arts) {
    const fb = currentFeedback(s, a.id, a.version);
    if (fb?.mark === "drop") continue;
    const why = fb?.mark === "change" ? "you marked it Change" : approvalBlocker(s, a, fb?.pickedVariant);
    const existing = itemOf(items, a);
    if (why && existing?.status === "approved") continue;
    const item = itemFor(s, items, a, chosenVariant(a, fb?.pickedVariant), why ? "open" : "approved");
    if (same(existing, item)) continue;
    items = upsert(items, item);
    if (why) open++;
    else approved++;
  }
  if (!approved && !open) throw new ControlError(`Round ${n} is already in the blueprint as it stands.`);
  pushRevision(s, items, `approved round ${n}: ${approved} approved${open ? `, ${open} still open` : ""}`, now);
  return s;
}

/** The project's dictionary: the approved blueprint item, its version, and its terms. */
export interface DictionaryInForce {
  item: BlueprintItem;
  artifact: StudioArtifact;
  entries: DictionaryEntry[];
}

/**
 * The project's dictionary (pass 4d, decision 6): the dictionary version the owner approved into the blueprint, and
 * only that one; a version still in review, unapproved or open is not in force. With two dictionaries approved, the
 * one approved last is in force. Undefined until the owner approves one.
 */
export function dictionaryInForce(s: State): DictionaryInForce | undefined {
  const approved = blueprintItems(s).filter((i) => i.kind === "dictionary" && i.status === "approved");
  if (!approved.length) return undefined;
  // When this item's current version was approved: the first revision that holds it as it is now.
  const approvedIn = (i: BlueprintItem) => s.blueprint.revisions.findIndex((r) => r.items.some((x) => same(x, i)));
  const item = approved.reduce((a, b) => (approvedIn(b) >= approvedIn(a) ? b : a));
  const artifact = versionsOf(s, item.artifactId).find((a) => a.version === item.version);
  return artifact?.dictionary ? { item, artifact, entries: artifact.dictionary } : undefined;
}

/** An open item of the blueprint and what keeps it open now. */
export interface OpenItem {
  item: BlueprintItem;
  why: string;
}

/** The blueprint's open items, each with what keeps it open as the studio stands now. The pre-flight lists them. */
export function openBlueprintItems(s: State): OpenItem[] {
  return blueprintItems(s)
    .filter((i) => i.status === "open")
    .map((item) => {
      const a = latestVersion(s, item.artifactId)!;
      const mark = currentFeedback(s, a.id, a.version)?.mark;
      const why = mark === "change" ? "you marked it Change" : (approvalBlocker(s, a, currentFeedback(s, a.id, a.version)?.pickedVariant) ?? "ready for your approval");
      return { item, why };
    });
}

/**
 * A task spec's references to blueprint items, checked against the blueprint: every id must name an item (items are
 * never removed, so a reference stays valid). Repeats are dropped.
 */
export function validateBlueprintRefs(s: State, refs: string[]): string[] {
  const known = new Set(blueprintItems(s).map((i) => i.id));
  const unknown = refs.filter((r) => !known.has(r));
  if (unknown.length) throw new ControlError(`Not in the blueprint: ${[...new Set(unknown)].join(", ")}.`);
  return [...new Set(refs)];
}

/** The most blueprint items one task cites. */
export const MAX_BLUEPRINT_REFS = 20;

/**
 * Why the lead's citations cannot stand, or undefined (pass 5, the factory link): each must name an approved item of
 * the blueprint. An open item is not a design the owner approved, so the factory does not build from it.
 */
export function leadRefsProblem(s: State, refs: unknown): string | undefined {
  if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string")) return '"blueprintRefs" must be a list of blueprint item ids';
  if (refs.length > MAX_BLUEPRINT_REFS) return `it cites ${refs.length} blueprint items; at most ${MAX_BLUEPRINT_REFS}`;
  const items = blueprintItems(s);
  const unknown = refs.filter((r) => !items.some((i) => i.id === r));
  if (unknown.length) return `not in the blueprint: ${[...new Set(unknown)].join(", ")}`;
  const open = refs.filter((r) => items.some((i) => i.id === r && i.status === "open"));
  if (open.length) return `${[...new Set(open)].join(", ")} ${open.length === 1 ? "is" : "are"} still open in the blueprint, not approved; cite only approved items`;
  return undefined;
}

/** A cited item's version as approved: the artifact it stands for, at the approved version. */
export function citedArtifact(s: State, item: BlueprintItem): StudioArtifact | undefined {
  return versionsOf(s, item.artifactId).find((a) => a.version === item.version);
}

/**
 * The acceptance a spec takes from the blueprint items it cites (pass 5): each rule and each example of a cited flow
 * (the approved variant's, or the only one's), tagged with its id, and one line for each cited contract. The tag is
 * the rule's or the example's id ("[R3] When …"), which the acceptance tests name; the item follows each line.
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
    for (const r of rules.rules) lines.push(`[${r.id}] ${r.text} ${from}`);
    for (const e of rules.examples) lines.push(`[${e.id}] ${e.text} ${from}`);
  }
  return lines;
}

/** Open change orders, oldest first; with `handler`, only those waiting for the owner or marked for the lead. */
export function openChangeOrders(s: State, handler?: ChangeOrder["handler"]): ChangeOrder[] {
  return s.blueprint.changeOrders.filter((c) => c.status === "open" && (handler === undefined || c.handler === handler));
}
