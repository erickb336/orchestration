// The change order (ORC-029 pass 5, screen 4) in words: after a Lock in, the lead's updates to the factory's tasks,
// one line each, with the PE review of each line's work and what the owner can do (Undo, or Apply and Dismiss under
// "ask me first"). The facts are the domain's (src/domain/model/changeOrderUpdates.ts): the lines, their steering
// rows, what is outstanding and the record when it closed. This module only words them. Pure.

import * as M from "../../domain/model";
import { lastObjection, MAX_PE_REVIEW_ROUNDS } from "../../domain/peReview";
import type { BlueprintItem, ChangeOrder, ChangeOrderLineKind } from "../../domain/studio/types";
import type { PeReviewState, State, Task } from "../../domain/types";
import type { ConfirmOptions, Tone } from "../kit";
import { fmtTime } from "../common";
import { droppedPartsWords, itemName } from "../studio/draftView";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "a", "a and b", "a, b and c". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const capital = (x: string) => (x ? `${x[0].toUpperCase()}${x.slice(1)}` : x);

/** Where a change order's screen is: under Tasks, as it adjusts the factory's tasks. */
export const changeOrderHref = (rev: number) => `#/tasks/change-order/${rev}`;

export const KIND_WORD: Record<ChangeOrderLineKind, { word: string; tone: Tone }> = {
  "update-spec": { word: "Updated", tone: "work" },
  "new-task": { word: "New", tone: "done" },
  revise: { word: "Revision", tone: "work" },
  retire: { word: "Retired", tone: "neutral" },
};

/** What a line's state and its work's PE review say: a short label for a pill, and a sentence when it needs one. */
export interface StateWords {
  word: string;
  tone: Tone;
  detail?: string;
}

/** The PE review of a line's work (an updated spec, a revision task or a new task), in words. */
export function peReviewWords(r: PeReviewState | undefined): StateWords {
  if (!r) return { word: "No PE review", tone: "neutral", detail: "PE review of new work was off when it applied, so it does not wait for the PE." };
  if (r.overruled) return { word: "You overruled the PE", tone: "neutral", detail: `Your reason: "${r.overruled.why}"` };
  if (r.status === "agreed") return { word: "PE agreed", tone: "done" };
  if (r.status === "ended") return r.ended?.by === "service" ? { word: "PE review could not finish · needs you", tone: "you", detail: `${capital(r.ended.why)}. Open the task to start it without the PE's review, or cancel it.` } : { word: "PE review off", tone: "neutral", detail: "You turned PE review of new work off, so it did not wait for the PE." };
  if (r.status === "objected") return { word: "PE objects · needs you", tone: "you", detail: `The PE: "${lastObjection(r)}" Open the task to overrule the objection, edit the task, or cancel it.` };
  const last = r.rounds.at(-1);
  if (last && last.verdict !== "feasible") return { word: "PE asks a change", tone: "work", detail: `The PE: "${lastObjection(r)}" The lead revises it (round ${r.rounds.length} of ${MAX_PE_REVIEW_ROUNDS}).` };
  return { word: "PE reviewing", tone: "work", detail: "It waits for the PE's review, then starts." };
}

/** One line of the change order, as the screen shows it. */
export interface LineWords {
  changeId: string;
  /** The steering change set that carries the line: Undo, Apply and Dismiss name it. */
  changeSetId: string;
  kind: { word: string; tone: Tone };
  /** What it does, in the design's words, without a first word that repeats the kind ("T-012 → builds Trip plan v2"). */
  text: string;
  /** The task the line's work is (the updated or retired task, or the task it made), with its title. */
  task?: { id: string; title: string };
  /** The lead's reason. */
  why: string;
  /** Its state: the PE review of its work once it applied, or that it waits for you, or that you undid it. */
  state?: StateWords;
  /** When and by whom: "Applied by the lead, Oct 2, 2:41 PM." */
  when: string;
  /** Why the service left it as is the last time you asked (Undo or Apply). */
  left?: string;
  /** What you can do: Undo an applied line; Apply or Dismiss a line that waits for your go-ahead (only while open). */
  actions: "undo" | "apply" | "none";
  /** Undo cancels a task the line made: ask first. */
  undoConfirm?: ConfirmOptions;
}

/** The kind word the words start with, which the chip already says. A revision's words name the task it made. */
const LEADING: Record<ChangeOrderLineKind, string> = { "update-spec": "Updated ", "new-task": "New ", retire: "Retired ", revise: "" };

function lineWords(s: State, co: ChangeOrder, v: M.ChangeOrderLineView): LineWords {
  const { line } = v;
  // The line keeps where it stands; the steering row that carries it (`${changeSetId}.${n}`) keeps the service's notes
  // while its set is in the steering log.
  const set = s.steering.find((x) => x.id === line.changeId.slice(0, line.changeId.lastIndexOf(".")));
  const row = set?.changes.find((c) => c.id === line.changeId);
  const work: Task | undefined = v.workTaskId ? s.tasks.find((t) => t.id === v.workTaskId) : undefined;
  const lead = LEADING[line.kind];
  const text = lead && line.words.startsWith(lead) ? line.words.slice(lead.length) : line.words;
  const at = (iso: string | undefined) => (iso ? `, ${fmtTime(iso)}` : "");
  let state: StateWords | undefined;
  let when: string;
  switch (v.status) {
    case "applied":
      when = line.appliedBy === "user" ? `Applied by you${at(line.resolvedAt)}.` : `Applied by the lead${at(line.resolvedAt)}.`;
      if (line.kind !== "retire") state = peReviewWords(v.review);
      break;
    case "suggested": {
      // The pill says it waits, or that it was not applied; this says what that means, and why it waits for you when
      // the lead may not do it ("your task: only you cancel it").
      when = co.status === "open" ? "Nothing changed yet." : "You closed the change order as it stood.";
      const why = row?.note?.split("; ").find((p) => p && !p.startsWith("left as is on ") && !p.startsWith("waits for your go-ahead"));
      state = { word: co.status === "open" ? "Waits for your go-ahead" : "Not applied", tone: co.status === "open" ? "you" : "neutral", ...(why && co.status === "open" ? { detail: `The lead may not do it alone: ${why}.` } : {}) };
      break;
    }
    case "undone": {
      when = `Undone by you${at(line.resolvedAt)}.`;
      // A retirement you undid brings the task back, and it still builds what you dropped (Q-13).
      const dropped = line.kind === "retire" && work && work.lifecycle !== "cancelled" && work.lifecycle !== "done" ? droppedPartsWords(s, work) : undefined;
      state = { word: "Undone", tone: dropped ? "you" : "neutral", ...(dropped && work ? { detail: `${work.id} is back, and it builds ${dropped.names}, which you dropped${dropped.at}. Open it to cancel it or edit its spec.` } : {}) };
      break;
    }
    case "dismissed":
      when = `Dismissed by you${at(line.resolvedAt)}.`;
      state = { word: "Dismissed", tone: "neutral" };
      break;
    case "refused":
      when = "The service did not apply it.";
      state = { word: "Not applied", tone: "neutral" };
      break;
  }
  // The service's last "left as is" reason, kept on the row: "left as is on undo: T-021 has started; cancel it yourself".
  const left = row?.note
    ?.split("; ")
    .filter((p) => p.startsWith("left as is on "))
    .map((p) => capital(p.replace(/^left as is on (undo|apply): /, "")))
    .at(-1);
  const cancels = (line.kind === "new-task" || line.kind === "revise") && work;
  return {
    changeId: line.changeId,
    changeSetId: set?.id ?? line.changeId.slice(0, line.changeId.lastIndexOf(".")),
    kind: KIND_WORD[line.kind],
    text,
    ...(work ? { task: { id: work.id, title: M.currentSpec(work).content.title } } : {}),
    why: line.why,
    ...(state ? { state } : {}),
    when,
    ...(left ? { left } : {}),
    actions: v.status === "applied" ? "undo" : v.status === "suggested" && co.status === "open" ? "apply" : "none",
    ...(cancels && v.status === "applied"
      ? { undoConfirm: { title: `Undo ${work.id}?`, text: `Undo cancels ${work.id}, which the lead made for this change order. It has not started, so no work is lost. A cancelled task cannot be opened again.`, primaryLabel: `Undo and cancel ${work.id}` } }
      : {}),
  };
}

/** The change order's state as one pill: closed, waiting for you, the lead answering it, or waiting for the lead. */
function statusWords(s: State, co: ChangeOrder): StateWords {
  if (co.status === "done") return { word: "Closed", tone: "done" };
  if (M.changeOrderNeeds(s, co)) return { word: "Waits for you", tone: "you" };
  const r = co.leadRunId ? s.leadRuns.find((x) => x.id === co.leadRunId) : undefined;
  if (r && (r.outcome === "running" || r.outcome === "stopping")) return { word: "The lead is answering", tone: "work" };
  return { word: "Waits for the lead", tone: "neutral" };
}

/** "4 updates: 2 applied, 2 waiting for PE review", or why there is none yet. */
function summaryLine(s: State, co: ChangeOrder, lines: M.ChangeOrderLineView[]): string {
  if (!lines.length) {
    if (M.leadAnswered(s, co)) return "No updates: the lead's answer gave none";
    const r = co.leadRunId ? s.leadRuns.find((x) => x.id === co.leadRunId) : undefined;
    if (r && (r.outcome === "running" || r.outcome === "stopping")) return "No updates yet: the lead is answering it now";
    return co.status === "open" ? "No updates yet: the lead's next run answers it" : "No updates";
  }
  const n = { applied: 0, pe: 0, objects: 0, waiting: 0, notApplied: 0, undone: 0, dismissed: 0 };
  for (const v of lines) {
    if (v.status === "applied") {
      const r = v.review;
      if (r?.status === "pending") n.pe++;
      else if (r && !r.overruled && (r.status === "objected" || (r.status === "ended" && r.ended?.by === "service"))) n.objects++;
      else n.applied++;
    } else if (v.status === "suggested") {
      if (co.status === "open") n.waiting++;
      else n.notApplied++;
    }
    else if (v.status === "undone") n.undone++;
    else if (v.status === "dismissed") n.dismissed++;
    else if (v.status === "refused") n.notApplied++;
  }
  const parts = [
    n.applied ? `${n.applied} applied` : "",
    n.pe ? `${n.pe} waiting for PE review` : "",
    n.objects ? `${n.objects} with a PE objection for you` : "",
    n.waiting ? `${n.waiting} waiting for your go-ahead` : "",
    n.notApplied ? `${n.notApplied} not applied` : "",
    n.undone ? `${n.undone} undone` : "",
    n.dismissed ? `${n.dismissed} dismissed` : "",
  ].filter(Boolean);
  return `${count(lines.length, "update")}: ${parts.join(", ")}`;
}

/** What the Lock in changed, from the summary the owner agreed to: "Trip plan v1 → v2; added Packing list v1; dropped Reminders v1". */
function lockInChanges(s: State, co: ChangeOrder): string {
  const rev = s.blueprint.revisions.find((r) => r.rev === co.rev);
  const c = rev?.lockIn?.summary.changes;
  if (!c) {
    const items = rev?.items ?? [];
    const name = (id: string) => {
      const i = items.find((x) => x.id === id);
      return i ? itemName(s, i) : id;
    };
    return [co.changedItems.length ? `changed or added ${listed(co.changedItems.map(name))}` : "", co.droppedItems.length ? `dropped ${listed(co.droppedItems.map(name))}` : ""].filter(Boolean).join("; ");
  }
  const named = (xs: BlueprintItem[]) => listed(xs.map((i) => itemName(s, i)));
  return [
    ...c.changed.map((x) => `${itemName(s, x.replaces)} → v${x.item.version}`),
    c.added.length ? `added ${named(c.added)}` : "",
    c.dropped.length ? `dropped ${named(c.dropped)}` : "",
    c.vision ? "changed the vision text" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** The tasks it did not touch: open or landed tasks from before it that cite the design, and none of what changed. */
function untouched(s: State, co: ChangeOrder): string | undefined {
  const touched = new Set([...co.tasks.map((t) => t.taskId), ...(co.lines ?? []).flatMap((l) => (l.madeTaskId ? [l.madeTaskId] : []))]);
  const rest = s.tasks.filter((t) => t.lifecycle !== "cancelled" && t.createdAt <= co.at && !touched.has(t.id) && (M.currentSpec(t).content.blueprintRefs ?? []).length > 0);
  if (!rest.length) return undefined;
  const shown = rest.slice(0, 8).map((t) => `${t.id} ${M.currentSpec(t).content.title}`);
  const more = rest.length - shown.length;
  return `Not changed: ${shown.join(", ")}${more > 0 ? ` and ${count(more, "more task")}` : ""}. ${rest.length === 1 ? "It cites" : "They cite"} nothing that changed.`;
}

export interface ChangeOrderWords {
  rev: number;
  /** "Change order 3 · from Lock in 3". */
  heading: string;
  /** "Made Oct 2, 2:40 PM. Lock in 3: Trip plan v1 → v2; added Packing list v1; dropped Reminders v1." */
  context: string;
  status: StateWords;
  /** Who answers it: "the lead · Claude", once a lead run was shown it. */
  lead?: { word: string; simulated: boolean };
  summary: string;
  lines: LineWords[];
  untouched?: string;
  /** What the lead's answer left out or the domain refused. */
  notes: string[];
  /** When the domain says it waits for the owner: what waits, and Close it as it stands. */
  waits?: { words: string; confirm: ConfirmOptions };
  /**
   * A closed change order: when, and what was done per line, in the design's words. `adds`: the record says more than
   * the rows (a task not handled, the new work planned elsewhere, a line you undid or dismissed), so it shows open.
   */
  closed?: { when: string; record: string[]; adds: boolean };
  /** The other change orders, newest first. */
  others: { rev: number; href: string; status: string }[];
}

export function changeOrderWords(s: State, co: ChangeOrder): ChangeOrderWords {
  const views = M.changeOrderLines(s, co);
  const r = co.leadRunId ? s.leadRuns.find((x) => x.id === co.leadRunId) : undefined;
  const set = co.lines?.length ? s.steering.find((x) => co.lines![0].changeId.startsWith(`${x.id}.`)) : undefined;
  const needs = M.changeOrderNeeds(s, co);
  const changes = lockInChanges(s, co);
  const notTouched = untouched(s, co);
  return {
    rev: co.rev,
    heading: `Change order ${co.rev} · from Lock in ${co.rev}`,
    context: `Made ${fmtTime(co.at)}${changes ? `. Lock in ${co.rev}: ${changes}` : ""}.`,
    status: statusWords(s, co),
    ...(r ? { lead: { word: `the lead · ${M.providerLabel(r.provider)}`, simulated: !!set?.simulated } } : {}),
    summary: summaryLine(s, co, views),
    lines: views.map((v) => lineWords(s, co, v)),
    ...(notTouched ? { untouched: notTouched } : {}),
    // What the answer left "not handled" was true when it came in; what is left now is the banner's (`waits`) and,
    // once closed, the record's. Under "ask me first" that note even names the tasks whose updates wait for you.
    notes: (co.notes ?? []).filter((n) => !n.startsWith("not handled: ")),
    ...(needs
      ? {
          waits: {
            words: `${capital(needs.words)}.`,
            confirm: {
              title: `Close change order ${co.rev} as it stands?`,
              text: `What is not handled is recorded as "not handled", and the factory goes on as it is.${needs.waiting ? ` ${count(needs.waiting, "update")} that ${needs.waiting === 1 ? "waits" : "wait"} for your go-ahead ${needs.waiting === 1 ? "is" : "are"} not applied.` : ""} You can still message the lead about it.`,
              primaryLabel: "Close it as it stands",
            },
          },
        }
      : {}),
    ...(co.status === "done" && co.closed ? { closed: { when: fmtTime(co.closed.at), record: co.closed.record, adds: co.closed.record.some((r) => !(co.lines ?? []).some((l) => l.words === r)) } } : {}),
    others: [...s.blueprint.changeOrders]
      .filter((x) => x.rev !== co.rev)
      .sort((a, b) => b.rev - a.rev)
      .map((x) => ({ rev: x.rev, href: changeOrderHref(x.rev), status: x.status === "done" ? "closed" : "open" })),
  };
}

/** An open change order in one line, for the Tasks page: what waits for you, or else its updates so far. */
export function changeOrderLine(s: State, co: ChangeOrder): { title: string; text: string; tone: "you" | "info" } {
  const w = changeOrderWords(s, co);
  return { title: w.heading, text: w.waits ? w.waits.words : `${w.summary}.`, tone: w.waits ? "you" : "info" };
}

/** The change orders the Tasks page names: every open one, newest first. */
export const openChangeOrdersNewestFirst = (s: State) => s.blueprint.changeOrders.filter((c) => c.status === "open").sort((a, b) => b.rev - a.rev);

/**
 * Where the header's Factory place leads: the newest open change order, if any, else the tasks. `title` is the place's
 * own title ("1 agent working. Open the tasks."); with a change order open, its last sentence names the change order.
 */
export function factoryPlaceLink(s: State, title: string): { href: string; title: string } {
  const co = openChangeOrdersNewestFirst(s)[0];
  if (!co) return { href: "#/tasks", title };
  return { href: changeOrderHref(co.rev), title: `${title.replace(/\s*Open the tasks\.$/, "")} Open change order ${co.rev}.`.trim() };
}
