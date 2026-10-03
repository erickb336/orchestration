// Vision with a draft (ORC-029 pass 5, screen 2), as pure functions over the state: the draft's changes since the
// last Lock in, each with what it replaces; where an artifact version stands in the blueprint ("in the draft" or
// "in force"); and, for a changed item, the version in force to show beside the draft's. The facts come from
// src/domain/studio/blueprint.ts.

import * as B from "../../domain/studio/blueprint";
import * as S from "../../domain/studio/studio";
import type { BlueprintItem, StudioArtifact } from "../../domain/studio/types";
import type { State } from "../../domain/types";
import type { Tone } from "../kit";
import { fmtTime } from "../common";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The variant's label of an item, when it names one. */
function variantLabel(s: State, item: BlueprintItem): string | undefined {
  if (item.variant === undefined) return undefined;
  return B.citedArtifact(s, item)?.variants.find((v) => v.id === item.variant)?.label ?? item.variant;
}

/** "Trip plan v2" or "Trip plan v2, Day list first": an item at its version, with its variant when it has several. */
export function itemName(s: State, item: BlueprintItem): string {
  const v = variantLabel(s, item);
  return `${item.title} v${item.version}${v ? `, ${v}` : ""}`;
}

export type DraftChangeKind = "added" | "changed" | "dropped" | "open";

/** One line of the draft bar: its kind, the item as the draft has it, and what it replaces or why it stays. */
export interface DraftLine {
  kind: DraftChangeKind;
  itemId: string;
  name: string;
  note: string;
}

export const CHANGE_WORD: Record<DraftChangeKind, string> = { added: "Added", changed: "Changed", dropped: "Dropped", open: "Open" };
export const CHANGE_TONE: Record<DraftChangeKind, Tone> = { added: "done", changed: "work", dropped: "fail", open: "you" };

/** The draft line of a vision text that differs from the text in force: it has no blueprint item, so it has this id. */
export const VISION_LINE_ID = "vision-text";

/** How many changes a Lock in of the draft puts into force: each added, changed and dropped item, and a new vision text. */
export function draftChangeCount(s: State): number {
  const c = B.draftChanges(s);
  return c.added.length + c.changed.length + c.dropped.length + (c.vision ? 1 : 0);
}

/**
 * The draft's changes since the last Lock in, then its open items: the vision text when it changed (pass 5: after the
 * start an edit of the text waits in the draft), then added, changed, dropped and open items, in that order.
 */
export function draftLines(s: State): DraftLine[] {
  const c = B.draftChanges(s);
  const newWork = new Set(B.lockInSummary(s).newWork);
  const why = new Map(B.openBlueprintItems(s).map((o) => [o.item.id, o.why]));
  const inForce = new Map(B.blueprintItems(s).map((i) => [i.id, i]));
  return [
    ...(c.vision ? [{ kind: "changed" as const, itemId: VISION_LINE_ID, name: "Vision text", note: `"${c.vision.reason}"; it goes into force with the Lock in` }] : []),
    ...c.added.map((i) => ({ kind: "added" as const, itemId: i.id, name: itemName(s, i), note: newWork.has(i.id) ? "new; no task builds it yet" : "new" })),
    ...c.changed.map(({ item, replaces }) => {
      const v = variantLabel(s, replaces);
      return { kind: "changed" as const, itemId: item.id, name: itemName(s, item), note: `replaces v${replaces.version}${v && v !== variantLabel(s, item) ? `, ${v}` : ""}` };
    }),
    ...c.dropped.map((i) => ({ kind: "dropped" as const, itemId: i.id, name: itemName(s, i), note: "it leaves the design" })),
    ...c.open.map((i) => {
      const f = inForce.get(i.id);
      const keeps = f?.status === "approved" ? `, and the agents keep v${f.version}` : "";
      return { kind: "open" as const, itemId: i.id, name: itemName(s, i), note: `${why.get(i.id) ?? "not settled"}. It stays out of the Lock in${keeps}` };
    }),
  ];
}

/** The draft bar's heading and the line under it: since which Lock in, and what the factory builds from. */
export function draftHeading(s: State): { title: string; since: string } {
  const c = B.draftChanges(s);
  const changes = draftChangeCount(s);
  const title = `Draft · ${[changes ? count(changes, "change") : "", c.open.length ? count(c.open.length, "open item") : ""].filter(Boolean).join(", ")}`;
  const rev = B.blueprintRev(s);
  const since = rev
    ? `Since Lock in ${rev} (${fmtTime(B.currentBlueprint(s)!.at)}). The factory builds from Lock in ${rev}, never from the draft.`
    : "Nothing is locked in yet. Start the factory is your first Lock in.";
  return { title, since };
}

/** The confirmation before Discard the draft: what goes, what stays, and what the draft becomes. */
export function discardConfirm(s: State): { title: string; text: string; primaryLabel: string; danger: true } {
  const c = B.draftChanges(s);
  const changes = draftChangeCount(s);
  const what = [changes ? count(changes, "change") : "", c.open.length ? count(c.open.length, "open item") : ""].filter(Boolean).join(" and ");
  const rev = B.blueprintRev(s);
  return {
    title: "Discard the draft?",
    text: `Your ${what} since ${rev ? `Lock in ${rev}` : "the start"} go. The draft becomes ${rev ? `Lock in ${rev}` : "empty"} again. The artifacts, your marks and your notes stay.`,
    primaryLabel: "Discard the draft",
    danger: true,
  };
}

/** Why the owner cannot lock in now, or undefined. In Vision, Start the factory is the first Lock in. */
export function lockInBlocker(s: State): string | undefined {
  if (s.project.stage === "shaping") return "In Vision, Start the factory is your first Lock in.";
  const c = B.draftChanges(s);
  if (draftChangeCount(s) === 0) return c.open.length ? "There is nothing to lock in: the draft holds only open items, which stay in the draft." : "There is nothing to lock in: the draft is the version in force.";
  return undefined;
}

/** The item that stands for an artifact: its own, or the one of the artifact it replaces. */
const itemFor = (items: BlueprintItem[], a: StudioArtifact) => items.find((i) => i.artifactId === a.id) ?? (a.supersedes ? items.find((i) => i.artifactId === a.supersedes) : undefined);
const isVersion = (i: BlueprintItem | undefined, a: StudioArtifact) => !!i && i.artifactId === a.id && i.version === a.version;

/**
 * Where this version stands in the blueprint, for the studio's left column:
 * - "in force": the version in force, and the draft keeps it;
 * - "in the draft": the draft approves it, and it is not in force yet;
 * - "dropped": the draft drops it;
 * - "open": the draft holds it open;
 * - undefined: neither the draft nor the version in force has this version.
 */
export type BlueprintPlace = "in force" | "in the draft" | "dropped" | "open";
/** What each place means, for the chip's title. */
export const BLUEPRINT_PLACE_TITLE: Record<BlueprintPlace, string> = {
  "in force": "The factory builds from this version.",
  "in the draft": "You approved it. It goes into force at your next Lock in.",
  dropped: "Your draft drops it. It leaves the design at your next Lock in.",
  open: "Not settled yet. It stays out of the Lock in.",
};

/** The draft waits for your Lock in (amber, as the header's Vision place); what is in force is settled. */
export const PLACE_TONE: Record<BlueprintPlace, Tone> = { "in force": "neutral", "in the draft": "you", dropped: "fail", open: "you" };

export function blueprintPlace(s: State, a: StudioArtifact): BlueprintPlace | undefined {
  const d = itemFor(B.draftItems(s), a);
  const f = d ? B.blueprintItems(s).find((i) => i.id === d.id) : itemFor(B.blueprintItems(s), a);
  if (d && isVersion(d, a)) {
    if (d.status === "open") return "open";
    if (d.status === "dropped") return f && f.status !== "dropped" ? "dropped" : undefined;
    return f?.status === "approved" && JSON.stringify(f) === JSON.stringify(d) ? "in force" : "in the draft";
  }
  return f?.status === "approved" && isVersion(f, a) ? "in force" : undefined;
}

/**
 * For a version that the draft puts in place of another (a changed item): the item in force and its artifact version,
 * to show beside this one. Undefined for any other version.
 */
export function inForceBeside(s: State, a: StudioArtifact): { item: BlueprintItem; artifact: StudioArtifact; rev: number } | undefined {
  const changed = B.draftChanges(s).changed.find((x) => isVersion(x.item, a));
  if (!changed) return undefined;
  const artifact = S.versionsOf(s, changed.replaces.artifactId).find((v) => v.version === changed.replaces.version);
  return artifact ? { item: changed.replaces, artifact, rev: B.blueprintRev(s) } : undefined;
}
