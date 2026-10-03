// The Lock in summary (ORC-029 pass 5, screen 3) in words: what changes, the tasks it touches and what happens to
// each, the new work, the budgets, and what stays open. The facts are the domain's `lockInSummary`, which the Lock in
// records as the owner's agreement; this module only words them. An unknown cost is "no estimate", never $0.

import * as B from "../../domain/studio/blueprint";
import type { BlueprintItem, TaskHandling, TouchedTaskState } from "../../domain/studio/types";
import type { State } from "../../domain/types";
import type { Tone } from "../kit";
import { draftLines, itemName, type DraftLine } from "./draftView";
import { usdRange } from "./studioView";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

export const HANDLING_TAG: Record<TaskHandling, { word: string; tone: Tone }> = {
  "update-spec": { word: "Update", tone: "work" },
  "finish-then-revise": { word: "Finish, then revise", tone: "work" },
  "plan-revision": { word: "Revise", tone: "work" },
  retire: { word: "Retire", tone: "neutral" },
};
const STATE_WORDS: Record<TouchedTaskState, string> = { queued: "not started", running: "running", landed: "landed" };
/** What happens to a touched task (the owner's answer, r14), as a sentence. */
const HANDLING_SENTENCE: Record<TaskHandling, string> = {
  "update-spec": "It has not started: the lead updates its spec first.",
  "finish-then-revise": "It finishes, then the lead revises it. No work is lost.",
  "plan-revision": "Its work landed: the lead plans a revision.",
  retire: "It builds only parts that leave the design, and it has not started: it is retired. Nothing is lost.",
};

export interface TouchedTaskLine {
  taskId: string;
  title: string;
  state: string;
  tag: { word: string; tone: Tone };
  why: string;
}

export interface LockInWords {
  /** The draft revision this summary describes: Lock in names it. */
  draftRev: number;
  /** The revision the Lock in makes. */
  rev: number;
  /** How many changes go into force (added, changed and dropped). */
  changes: number;
  heading: string;
  changeLines: DraftLine[];
  tasks: TouchedTaskLine[];
  newWork: string | undefined;
  building: string;
  estimate: { lines: string[]; total: string };
  maintenance: string;
  openLines: DraftLine[];
  agreement: string;
  button: string;
}

/** The summary of a Lock in of the draft as it is now, in words. */
export function lockInWords(s: State): LockInWords {
  const sum = B.lockInSummary(s);
  const changes = sum.changes.added.length + sum.changes.changed.length + sum.changes.dropped.length;
  const byId = new Map<string, BlueprintItem>([...B.blueprintItems(s), ...B.draftItems(s)].map((i) => [i.id, i]));
  const name = (id: string) => (byId.get(id) ? itemName(s, byId.get(id)!) : id);
  const lines = draftLines(s);
  // What the Lock in does to each item a task cites: "Trip plan v1 → v2", "Reminders v1, which leaves the design".
  const change = new Map<string, string>([
    ...sum.changes.added.map((i) => [i.id, `${itemName(s, i)}, which is new`] as const),
    ...sum.changes.changed.map((x) => [x.item.id, `${itemName(s, x.replaces)} → v${x.item.version}`] as const),
    ...sum.changes.dropped.map((i) => [i.id, `${itemName(s, i)}, which leaves the design`] as const),
  ]);
  const tasks = sum.tasks.map((t) => ({
    taskId: t.taskId,
    title: t.title,
    state: STATE_WORDS[t.state],
    tag: HANDLING_TAG[t.handling],
    why: `It cites ${t.items.map((id) => change.get(id) ?? name(id)).join("; ")}. ${HANDLING_SENTENCE[t.handling]}`,
  }));
  const newWork = sum.newWork.length
    ? `${sum.newWork.map(name).join(", ")} ${sum.newWork.length === 1 ? "has" : "have"} no task yet. The lead plans ${sum.newWork.length === 1 ? "its" : "their"} tasks after the Lock in${s.project.peReviewsNewWork ? ", and the PE reviews them before they start" : ""}.`
    : undefined;
  const b = sum.budgets;
  const unknown = b.building.unknownRuns ? ` ${count(b.building.unknownRuns, "run")} ${b.building.unknownRuns === 1 ? "has" : "have"} no recorded cost, so the spend may be higher.` : "";
  const building = `Building: ${usd(b.building.spentUsd)} spent${b.building.budgetUsd === null ? ". No building budget is set." : ` of ${usd(b.building.budgetUsd)}. The factory stops and asks you at ${usd(b.building.budgetUsd)}.`}${unknown}`;
  const estimateLines = b.items.map((e) => {
    const n = name(e.itemId);
    if (!e.estimate) return `${n}: no estimate.`;
    const parts = [e.estimate.buildUsd ? `building ${usdRange(e.estimate.buildUsd)}` : "building: no estimate", e.estimate.maintenanceUsdPerMonth ? `maintenance ${usdRange(e.estimate.maintenanceUsdPerMonth, true)}` : "maintenance: no estimate"];
    return `${n}: ${parts.join(", ")}.`;
  });
  const missing = b.items.filter((e) => !e.estimate?.buildUsd).length;
  const total = !b.items.length
    ? "Nothing new to build: the Lock in only drops parts."
    : b.itemsTotal.buildUsd
      ? `The PE's estimate to build these changes: ${usdRange(b.itemsTotal.buildUsd)}.`
      : `No total estimate: ${count(missing, "change")} ${missing === 1 ? "has" : "have"} no estimate from the PE.`;
  const m = b.maintenance;
  const maintenance = [
    m.estimateUsdPerMonth === null ? "Maintenance: no estimate yet." : `Maintenance: ${usd(m.estimateUsdPerMonth)} a month.`,
    m.budgetUsdPerMonth === null ? "No maintenance budget is set." : `The budget is ${usd(m.budgetUsdPerMonth)} a month.`,
    b.itemsTotal.maintenanceUsdPerMonth ? `These changes add ${usdRange(b.itemsTotal.maintenanceUsdPerMonth, true)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const changesWord = count(changes, "change");
  return {
    draftRev: sum.draftRev,
    rev: sum.inForceRev + 1,
    changes,
    heading: `${changesWord} ${changes === 1 ? "goes" : "go"} into force`,
    changeLines: lines.filter((l) => l.kind !== "open"),
    tasks,
    newWork,
    building,
    estimate: { lines: estimateLines, total },
    maintenance,
    openLines: lines.filter((l) => l.kind === "open"),
    agreement: `I read the summary. Put ${changes === 1 ? "this change" : `these ${changes} changes`} into force, and let the lead adjust the tasks.`,
    button: `Lock in ${changesWord}`,
  };
}

/** The `lockIn` command for the summary the screen showed: it names that draft revision, so a changed draft is refused. */
export const lockInRequest = (shownDraftRev: number) => ({ name: "lockIn" as const, args: { draftRev: shownDraftRev } });

/** Who acts after the Lock in, from the project's settings. */
export function whoActsNext(s: State): string[] {
  const first = s.blueprint.revisions.find((r) => r.lockIn);
  return [
    s.project.changeOrders === "user" ? "Change orders wait for you: the lead asks you before it updates the tasks." : `Change orders: the lead updates the tasks this Lock in touches${s.project.peReviewsNewWork ? ", and the PE reviews the updates" : ""}.`,
    s.project.peReviewsNewWork ? "New tasks wait for PE review, then start." : "New tasks start without PE review.",
    s.project.budgets.buildingUsd === null ? "No building budget is set, so the factory does not stop for cost." : "At the building budget, the factory stops and asks you.",
    first ? `Start the factory was your first Lock in (Lock in ${first.rev}). Every later Lock in shows this summary.` : "Start the factory is your first Lock in. Every later Lock in shows this summary.",
  ];
}
