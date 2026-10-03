// Where each part of the design stands in the factory (ORC-029 pass 5, screen 5 "Design and reality"). Pure, from
// the state only: the blueprint in force and its draft, the tasks that cite the item, the work that landed, and the
// rule results of the checks of landed work (ruleResults.ts). The app words it; this module says only the facts.
//
// The statuses, the first that applies:
// 1. "in-force": a dictionary. It is not built: every agent's brief and the writing check use it.
// 2. "fails-a-check": a rule or an example of the item has a failing test.
// 3. "in-the-draft": the owner's draft changes or drops the item. The factory keeps the version in force until a Lock in.
// 4. "being-built": a task that cites the item is running, or finished and not landed yet; or work that built this
//    version landed, and the checks do not prove it (see 5).
// 5. "built-and-verified": work that built this version landed, and the checks prove it: every rule and example of
//    the item has a passing test. "No test" and "skipped" are never a proof (the owner's answer, r14: the checks
//    decide). A screen's or a CLI's proof is its captured evidence beside the prototype, which the factory does not
//    record yet, so such an item is not verified yet.
// 6. "designed": in force, and nothing has built this version yet (no task, or only tasks not started).
//
// Which version a task builds: the spec it builds from (the current spec, or for landed work the spec in force when it
// landed) was written at or after this version of the item came into force, or before it, for an earlier version.

import { currentSpec } from "../model/core";
import type { State, Task } from "../types";
import { blueprintItems, draftChanges } from "./blueprint";
import { ruleResults, type ItemRuleResults } from "./ruleResults";
import type { BlueprintItem } from "./types";

export type ItemFactoryStatus = "designed" | "in-the-draft" | "being-built" | "built-and-verified" | "fails-a-check" | "in-force";

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

export interface ItemFactoryView {
  item: BlueprintItem;
  status: ItemFactoryStatus;
  /** Since when this version (and variant) of the item is in force. */
  since: string;
  /** The tasks that cite the item, in the board's order; cancelled tasks are left out. */
  tasks: CitingTask[];
  /** Its rules and examples with their test results, for a flow or a contract with rules. */
  rules?: ItemRuleResults;
  /** The owner's draft changes the item (to the draft's version) or drops it. */
  draft?: { change: "changed"; item: BlueprintItem } | { change: "dropped" };
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
  const view = { item, since, tasks, ...(rules ? { rules } : {}), ...(draft ? { draft } : {}) };
  const landedHere = tasks.some((t) => t.state === "landed" && t.thisVersion);
  const status: ItemFactoryStatus =
    item.kind === "dictionary"
      ? "in-force"
      : rules && rules.counts.failed > 0
        ? "fails-a-check"
        : draft
          ? "in-the-draft"
          : tasks.some((t) => t.state === "running" || t.state === "finished")
            ? "being-built"
            : landedHere
              ? rules?.allPass
                ? "built-and-verified"
                : "being-built"
              : "designed";
  return { ...view, status };
}

/** Every approved item in force, in the blueprint's order, with where it stands. Dropped and open items are left out. */
export function blueprintFactoryStatus(s: State): ItemFactoryView[] {
  return blueprintItems(s)
    .filter((i) => i.status === "approved")
    .map((i) => itemFactoryStatus(s, i.id)!)
    .filter(Boolean);
}
