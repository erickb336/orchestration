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
import type { BlueprintItem, BlueprintRevision, ChangeOrder, StudioArtifact } from "./types";

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

/** Append a revision on a draft state; while building, it is also a change order. */
function pushRevision(s: State, items: BlueprintItem[], reason: string, now: string) {
  const before = blueprintItems(s);
  const rev = blueprintRev(s) + 1;
  s.blueprint.revisions.push({ rev, at: now, visionRev: currentVision(s).rev, reason, items });
  event(s, now, "user", "vision", `Blueprint r${rev}: ${reason}`);
  if (s.project.stage !== "building") return;
  const was = new Map(before.map((i) => [i.id, JSON.stringify(i)]));
  const changedItems = items.filter((i) => was.get(i.id) !== JSON.stringify(i)).map((i) => i.id);
  const affectedTasks = s.tasks.filter((t) => t.lifecycle !== "cancelled" && (currentSpec(t).content.blueprintRefs ?? []).some((r) => changedItems.includes(r))).map((t) => t.id);
  const handler = s.project.changeOrders;
  // The lead's updates for it wait for PE review when the project has it on (2e).
  const peReview = newWorkReview(s);
  s.blueprint.changeOrders.push({ rev, at: now, changedItems, affectedTasks, status: "open", handler, ...(peReview ? { peReview } : {}) });
  event(
    s,
    now,
    "system",
    "vision",
    `Change order for blueprint r${rev}: ${affectedTasks.length ? `it touches ${affectedTasks.join(", ")}` : "no task cites the changed items"}; ${handler === "user" ? "it waits for you before the lead updates tasks" : "the lead updates the affected tasks"}${peReview ? ", once the PE agrees with the updates" : ""}`,
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

/** Open change orders, oldest first; with `handler`, only those waiting for the owner or marked for the lead. */
export function openChangeOrders(s: State, handler?: ChangeOrder["handler"]): ChangeOrder[] {
  return s.blueprint.changeOrders.filter((c) => c.status === "open" && (handler === undefined || c.handler === handler));
}
