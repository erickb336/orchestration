// The lead's updates for a change order (ORC-029 pass 5, screen 4; spec r10 and r14).
//
// After a Lock in while building, the change order lists what changed and the tasks it touches (blueprint.ts). A lead
// run answers it (trigger "change-order"): its brief lists the change order (server/envelope.ts), and the reply's
// "changeOrder" block gives one update per touched task and the new tasks for the new work. The block is the lead's
// output, so untrusted data: each update is checked here against the state now, and an update the domain refuses is
// named in a note under the reply and on the change order.
//
// Each accepted update is one line of the change order and one row of the run's steering change set (ORC-009), so the
// owner undoes each line alone, or all of them, with steering's Undo:
// - update-spec: a queued task's spec, revised by the lead to build the versions in force. A PE objection or an
//   unfinished review that waits for the owner refuses it. Undo writes the spec before back, with its PE review as it was.
// - revise: a new task that revises a running or landed task and waits for it to land (r14: the running task keeps
//   running). Undo cancels the new task while it has not started.
// - retire: a queued task the Lock in agreed to retire (it builds only dropped parts), dropped as steering drops one.
//   As in steering, PE review that is not settled keeps the task, and the owner's task or a task the owner changed is
//   only suggested. Undo reopens it.
// - new-task: a new task for the new work. Undo cancels it while it has not started.
// The change order's handler says who gives the go-ahead: "lead", each update applies at once; "user" ("ask me
// first"), each waits as a suggestion until the owner applies it (steering's Apply) or dismisses it. With PE review of
// new work on, an updated spec, a revision task and a new task wait for the PE before they start, as all new work does
// (src/domain/peReview.ts); a retirement starts nothing.
//
// The change order closes when every touched task is handled and the new work is planned (`outstanding`), and records
// what was done per line, in the design's words. One completed lead run answers a change order: what it leaves goes to
// the owner (Needs you), who applies or dismisses lines, cancels a task, or closes the change order as it stands.

import { PE_OBJECTS_HOLD, PE_UNFINISHED_HOLD, newWorkReview, peReviewHold, peReviewKeeps } from "../peReview";
import { blueprintItems, HANDLING_WORDS } from "../studio/blueprint";
import { CHANGE_ORDER_LINE_KINDS, type BlueprintItem, type ChangeOrder, type ChangeOrderLine, type ChangeOrderLineKind } from "../studio/types";
import { ControlError, type LeadRun, type SteeringChange, type SteeringChangeSet, type State, type Task } from "../types";
import { cancelInto, dropInto, openDependent, reopenDropped, started, userTouched } from "./controls";
import { currentSpec, currentVision, draft, event, getTask, isOpen } from "./core";
import { type LeadProposal, ownersChoiceLeftOut, proposeTask, refusedAcceptance, refusedAcceptanceNote, specUpdateOf, validateProposal } from "./leadOutput";
import { editSpecInto } from "./specs";
import { CONTROL_RE, oneLine } from "./textSafety";

/** The most updates one answer gives; the rest are named in one note. */
export const MAX_CHANGE_ORDER_UPDATES = 20;
const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const refsOf = (t: Task) => currentSpec(t).content.blueprintRefs ?? [];
const isDelivery = (t: Task) => !!(t.reviewTarget || t.deliverInto || t.checkTarget);
const queued = (s: State, t: Task) => (t.lifecycle === "proposed" || t.lifecycle === "ready") && !started(s, t);

// ---------- when the lead answers ----------

/** Whether a lead run answered the change order (it completed) or is answering it now. */
function answeredOrUnderWay(s: State, co: ChangeOrder): boolean {
  const r = co.leadRunId ? s.leadRuns.find((x) => x.id === co.leadRunId) : undefined;
  return !!r && (r.outcome === "running" || r.outcome === "stopping" || r.outcome === "completed");
}

/** Whether the lead's completed run answered it. */
export function leadAnswered(s: State, co: ChangeOrder): boolean {
  return !!co.leadRunId && s.leadRuns.some((r) => r.id === co.leadRunId && r.outcome === "completed");
}

/**
 * Open change orders a lead run should answer now, oldest first: while building, with something left to handle, and
 * no run shown it yet (or the one shown it ended without completing). A completed run does not start another.
 */
export function changeOrdersDueForLead(s: State): ChangeOrder[] {
  if (s.project.stage !== "building") return [];
  return s.blueprint.changeOrders.filter((co) => co.status === "open" && !answeredOrUnderWay(s, co) && !isSettled(outstanding(s, co)));
}

/** A change-order run starts: it is shown the oldest change order due, which its brief lists. Mutates the draft. */
export function showChangeOrderInto(s: State, leadRunId: string) {
  const co = changeOrdersDueForLead(s)[0];
  if (co) co.leadRunId = leadRunId;
}

/** The change order a lead run was shown, if any. */
export function changeOrderShownTo(s: State, leadRunId: string): ChangeOrder | undefined {
  return s.blueprint.changeOrders.find((co) => co.leadRunId === leadRunId);
}

// ---------- the design's words ----------

/** "Trip plan v4", "Packing list v1 · B". */
function itemName(s: State, id: string): string {
  const i = blueprintItems(s).find((x) => x.id === id);
  return i ? `${i.title} v${i.version}${i.variant ? ` · ${i.variant}` : ""}` : id;
}

/** "Reminders flow": a dropped part, by its title and kind. */
function droppedName(s: State, id: string): string {
  const i = blueprintItems(s).find((x) => x.id === id);
  return i ? `${i.title} ${i.kind}` : id;
}

/** "a", "a and b", "a, b and c". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The dropped items a task cites now, as the version in force has them. */
function droppedRefs(s: State, t: Task | undefined): string[] {
  if (!t) return [];
  const dropped = new Set(blueprintItems(s).filter((i) => i.status === "dropped").map((i) => i.id));
  return refsOf(t).filter((r) => dropped.has(r));
}

/**
 * What a line does, in the design's words, from the state now (pass 5, screen 4): "Updated T-012 → builds Trip plan
 * v4", "New T-021 revises T-012 once it lands → builds Trip plan v4", "Retired T-009: builds only the dropped
 * Reminders flow", "New T-022 → builds Packing list v1 · B".
 */
function lineWords(s: State, co: ChangeOrder, line: Pick<ChangeOrderLine, "kind" | "taskId" | "madeTaskId" | "items" | "why">): string {
  const t = line.taskId ? s.tasks.find((x) => x.id === line.taskId) : undefined;
  const changed = line.items.filter((id) => co.changedItems.includes(id));
  const dropped = droppedRefs(s, t);
  const builds = changed.length ? ` → builds ${listed(changed.map((id) => itemName(s, id)))}` : "";
  const leaves = dropped.length ? ` → takes out the dropped ${listed(dropped.map((id) => droppedName(s, id)))}` : "";
  const made = line.madeTaskId ? `New ${line.madeTaskId}` : "A new task";
  switch (line.kind) {
    case "update-spec":
      return `Updated ${line.taskId}${builds || (dropped.length ? ` → no longer builds the dropped ${listed(dropped.map((id) => droppedName(s, id)))}` : `: ${line.why}`)}`;
    case "revise":
      return `${made} revises ${line.taskId}${t?.lifecycle === "done" ? "" : " once it lands"}${builds || leaves}`;
    case "retire":
      return `Retired ${line.taskId}${t && dropped.length && dropped.length === refsOf(t).length ? `: builds only the dropped ${listed(dropped.map((id) => droppedName(s, id)))}` : `: ${line.why}`}`;
    case "new-task":
      return `${made}${builds || `: ${line.why}`}`;
  }
}

// ---------- reading the lead's block ----------

/** One update as read from the block, before it is checked against the task as it is now. */
interface Update {
  kind: ChangeOrderLineKind;
  taskId?: string;
  why: string;
  proposal?: LeadProposal;
}

/** Read the block's updates, each on its own: a bad entry is named and the others stand. Pure. */
function readUpdates(co: ChangeOrder, raw: Record<string, unknown>): { updates: Update[]; notes: string[] } {
  const notes: string[] = [];
  const updates: Update[] = [];
  if (!Array.isArray(raw.updates)) return { updates, notes: ['"updates" must be a list; nothing was changed'] };
  const extra = raw.updates.length - MAX_CHANGE_ORDER_UPDATES;
  if (extra > 0) notes.push(`${extra} more update${extra === 1 ? "" : "s"} ignored: at most ${MAX_CHANGE_ORDER_UPDATES} in one answer`);
  const touched = new Set(co.tasks.map((x) => x.taskId));
  const seen = new Set<string>();
  raw.updates.slice(0, MAX_CHANGE_ORDER_UPDATES).forEach((u: unknown, i: number) => {
    const at = `update #${i + 1}`;
    if (!isObj(u)) return void notes.push(`${at}: not an object`);
    const kind = u.action as ChangeOrderLineKind;
    if (!CHANGE_ORDER_LINE_KINDS.includes(kind)) return void notes.push(`${at}: "action" is one of ${CHANGE_ORDER_LINE_KINDS.join(", ")}`);
    if (u.why !== undefined && u.why !== null && typeof u.why !== "string") return void notes.push(`${at}: "why" must be text`);
    const why = typeof u.why === "string" ? oneLine(u.why.replace(CONTROL_G, "")).slice(0, 300) : "";
    const task = u.task === undefined || u.task === null ? undefined : u.task;
    if (kind === "new-task") {
      if (task !== undefined) return void notes.push(`${at}: a new task names no touched task; give "task": null`);
    } else {
      if (typeof task !== "string" || !ID_RE.test(task)) return void notes.push(`${at}: ${kind} names the task it changes in "task"`);
      if (!touched.has(task)) return void notes.push(`${task}: not a task change order r${co.rev} touches`);
      if (seen.has(task)) return void notes.push(`${task}: one update per task`);
      seen.add(task);
    }
    const proposal = u.proposal === undefined || u.proposal === null ? undefined : u.proposal;
    if (kind !== "retire" && !isObj(proposal)) return void notes.push(`${task ?? at}: ${kind} needs the whole proposal in "proposal"`);
    updates.push({ kind, ...(typeof task === "string" ? { taskId: task } : {}), why, ...(kind !== "retire" ? { proposal: proposal as unknown as LeadProposal } : {}) });
  });
  return { updates, notes };
}

/** The proposal with its citations: the lead's own, or by default the touched task's that are approved in force. */
function withRefs(s: State, p: LeadProposal, t: Task | undefined): LeadProposal {
  if (p.blueprintRefs !== undefined || !t) return p;
  const approved = new Set(blueprintItems(s).filter((i) => i.status === "approved").map((i) => i.id));
  return { ...p, blueprintRefs: refsOf(t).filter((r) => approved.has(r)) };
}

/** A task's state in a refusal: "is running", "has landed", "is cancelled". */
function stateWords(t: Task): string {
  return t.lifecycle === "active" ? "is running" : t.lifecycle === "done" ? "has landed" : t.lifecycle === "cancelled" ? "is cancelled" : "has started";
}

/**
 * Why this update cannot apply to the task as it is now, or undefined. The same check runs when the lead answers and
 * when the owner gives the go-ahead later, so a line never applies to a task that moved on. What only the owner may do
 * is refused here: a PE objection or an unfinished review that waits for the owner stays (finding 2), and a task is
 * retired only where the Lock in agreed it, never under PE review (finding 1).
 */
function whyNot(s: State, co: ChangeOrder, u: Update, now: string): string | undefined {
  const t = u.taskId ? s.tasks.find((x) => x.id === u.taskId) : undefined;
  if (u.taskId && !t) return `${u.taskId}: unknown task`;
  if (t && isDelivery(t)) return `${t.id}: a delivery task; only you change it`;
  const proposal = u.proposal && withRefs(s, u.proposal, t);
  switch (u.kind) {
    case "update-spec": {
      if (!queued(s, t!)) return `${t!.id} ${stateWords(t!)}: only a queued task's spec is updated; ${t!.lifecycle === "cancelled" ? "nothing is left to change" : 'plan a revision task instead ("revise")'}`;
      // Only the owner's edit reopens work the PE objected to (reopenPeReviewInto); the lead's update would clear it.
      const hold = peReviewHold(t!.peReview);
      if (hold === PE_OBJECTS_HOLD) return `${t!.id}: the PE objects to it; only you edit it, overrule the objection or cancel it`;
      if (hold === PE_UNFINISHED_HOLD) return `${t!.id}: its PE review could not finish; only you edit it, start it or cancel it`;
      return prefixed(t!.id, validateProposal(s, proposal!, now, "lead", t!.id));
    }
    case "revise":
      if (t!.lifecycle === "cancelled") return `${t!.id} is cancelled: nothing is left to revise`;
      if (queued(s, t!)) return `${t!.id} has not started: update its spec instead ("update-spec")`;
      return prefixed(t!.id, validateProposal(s, proposal!, now));
    case "retire": {
      if (!queued(s, t!)) return `${t!.id} ${stateWords(t!)}: only a queued task is retired; ${t!.lifecycle === "cancelled" ? "it is already gone" : 'plan a revision task instead ("revise")'}`;
      const handling = co.tasks.find((x) => x.taskId === t!.id)!.handling;
      if (handling !== "retire") return `${t!.id}: the Lock in agreed "${HANDLING_WORDS[handling]}", not "${HANDLING_WORDS.retire}"`;
      if (t!.parentTaskId) return `${t!.id} is a child task of ${t!.parentTaskId}: only you cancel it`;
      // Steering's rule for a drop (ORC-009): PE review that is not settled keeps the task, and only the owner cancels it.
      const keeps = peReviewKeeps(t!.peReview);
      if (keeps) return `${t!.id}: ${keeps}`;
      const dep = openDependent(s, t!, "drop");
      if (dep) return `${t!.id} is kept: ${dep.id} depends on it`;
      return undefined;
    }
    case "new-task": {
      const why = validateProposal(s, proposal!, now);
      if (why) return `"${String(proposal!.title).slice(0, 80)}": ${why}`;
      const refs = proposal!.blueprintRefs ?? [];
      if (!refs.some((r) => co.changedItems.includes(r))) return `"${String(proposal!.title).slice(0, 80)}": a new task cites at least one item change order r${co.rev} adds or changes (${co.changedItems.join(", ")})`;
      return undefined;
    }
  }
}

const prefixed = (id: string, why: string | undefined) => (why ? `${id}: ${why}` : undefined);

/**
 * Why the lead's update waits for the owner's go-ahead whatever the change order's handler, or undefined: the lead
 * never does what only the owner may (ORC-009: a choice the owner made by hand is never overridden; the lead's change
 * to it is a suggestion). The owner's own task, or a task the owner changed, is cancelled only by the owner; an update
 * that leaves out the option the owner chose overrules the owner. The owner's go-ahead satisfies it. Run after `whyNot`.
 */
function ownersCall(s: State, u: Update): string | undefined {
  const t = u.taskId ? getTask(s, u.taskId) : undefined;
  if (u.kind === "retire") {
    if (t!.specs[0]?.author !== "lead") return "your task: only you cancel it";
    if (userTouched(t!)) return "you changed this task";
  }
  if (u.kind === "update-spec") {
    const chosen = ownersChoiceLeftOut(currentSpec(t!).content, u.proposal!);
    if (chosen) return `you chose option ${chosen.id} (${chosen.name}); the update leaves it out`;
  }
  return undefined;
}

// ---------- applying a line ----------

/** The steering change set a line's row is in: `${changeSetId}.${n}`. */
const setIdOf = (changeId: string) => changeId.slice(0, changeId.lastIndexOf("."));

/**
 * Apply one line now, on a draft: the lead's at once, or the owner's go-ahead later (`by`). Checks it against the task
 * as it is now first. Records on the line its status and what Undo needs, and on its steering row, while its set is in
 * the log, what changed. Returns why it did not apply.
 */
function applyLineInto(s: State, co: ChangeOrder, line: ChangeOrderLine, row: SteeringChange | undefined, now: string, by: "lead" | "user"): string | undefined {
  const u: Update = { kind: line.kind, ...(line.taskId ? { taskId: line.taskId } : {}), why: line.why, ...(line.proposal ? { proposal: line.proposal as unknown as LeadProposal } : {}) };
  const why = whyNot(s, co, u, now);
  if (why) return why;
  const t = line.taskId ? getTask(s, line.taskId) : undefined;
  const proposal = u.proposal && withRefs(s, u.proposal, t);
  const reason = `Change order r${co.rev}${line.why ? `: ${line.why}` : ""}`;
  // What changed, for the row (steering's change list shows it).
  let before: SteeringChange["before"] = null;
  let after: SteeringChange["after"] = null;
  try {
    switch (line.kind) {
      case "update-spec": {
        const prev = currentSpec(t!);
        const earlier = t!.peReview;
        editSpecInto(s, t!, prev.rev, specUpdateOf(s, prev.content, proposal!), reason, "lead", now);
        // The updated spec is new work: it waits for the PE before it starts, and the earlier review stays on the record.
        // A review under way keeps its rounds: the PE reviews the update as its next round, so the cap of rounds holds.
        const fresh = earlier?.status === "pending" ? undefined : newWorkReview(s);
        if (fresh) t!.peReview = { ...fresh, ...(earlier ? { earlier: [...(earlier.earlier ?? []), { rounds: earlier.rounds, closedAt: now, specRev: prev.rev }] } : {}) };
        line.before = { specRev: prev.rev, ...(earlier ? { peReview: structuredClone(earlier) } : {}) };
        line.specRevs = [currentSpec(t!).rev];
        line.items = refsOf(t!);
        before = prev.rev;
        after = currentSpec(t!).rev;
        break;
      }
      case "revise":
      case "new-task": {
        const hold = !s.project.autonomy.enabled || s.project.autonomy.holdLeadProposals;
        const id = proposeTask(s, proposal!, now, hold);
        const made = getTask(s, id);
        // A revision builds on the task it revises: it starts once that task lands (r14: a running task finishes first).
        if (line.kind === "revise") made.dependsOn = [line.taskId!];
        line.madeTaskId = id;
        line.items = refsOf(made);
        after = id;
        if (row && line.kind === "new-task") row.taskId = id;
        break;
      }
      case "retire":
        before = t!.lifecycle;
        dropInto(s, t!, setIdOf(line.changeId), line.why || `change order r${co.rev}`, now, line.changeId);
        after = "cancelled";
        break;
    }
  } catch (e) {
    if (e instanceof ControlError) return `${line.taskId ?? "the new task"}: ${e.message}`;
    throw e;
  }
  delete line.proposal;
  line.words = lineWords(s, co, line);
  Object.assign(line, { status: "applied", appliedBy: by, resolvedAt: now });
  if (row) Object.assign(row, { before, after });
  return undefined;
}

/** The change order and the line a steering row carries. */
export function lineOf(s: State, changeId: string): { co: ChangeOrder; line: ChangeOrderLine } | undefined {
  for (const co of s.blueprint.changeOrders) {
    const line = co.lines?.find((l) => l.changeId === changeId);
    if (line) return { co, line };
  }
  return undefined;
}

// ---------- the lead's answer ----------

/**
 * A completed lead run's answer to the change order it was shown, on a draft (completeLeadRun). `raw` is the reply's
 * "changeOrder" block as found. Each accepted update becomes a line of the change order and a row of the run's change
 * set (`set`, made here when the reply has none, or when the reply's steering block was refused); with handler "lead"
 * it applies now, with "user" it waits for the owner. Returns the reply's set (the one with the rows, when the answer
 * gave any) and the notes for the reply: refused updates, and what the answer left out. A run shown no change order
 * changes nothing.
 */
export function answerChangeOrderInto(s: State, r: LeadRun, raw: unknown, set: SteeringChangeSet | undefined, now: string, simulated?: true): { set?: SteeringChangeSet; notes: string[] } {
  const co = changeOrderShownTo(s, r.id);
  const given = raw !== undefined && raw !== null;
  if (!co) return { set, notes: given ? ["this run was not asked to answer a change order; nothing was changed"] : [] };
  const notes: string[] = [];
  // A refused set says that nothing under the reply applied (review finding 10): it never carries a row. The rows go
  // into a set made when the first one is kept, which takes the refused set's place and keeps its refusal as a note.
  let rows = set && !set.refused ? set : undefined;
  const setId = set?.id ?? `cs-${r.id}`;
  const finish = () => {
    co.notes = [...(co.notes ?? []), ...notes];
    settleChangeOrdersInto(s, now);
    return { set: rows ?? set, notes: notes.map((n) => `r${co.rev}: ${n}`) };
  };
  if (co.status !== "open") return { set, notes: given ? [`r${co.rev} is closed; nothing was changed`] : [] };
  if (!given) {
    notes.push("the lead's answer gave no updates for it");
    return finish();
  }
  if (!isObj(raw)) {
    notes.push("the change order block was not an object; nothing was changed");
    return finish();
  }
  if (raw.rev !== co.rev) {
    notes.push(`the answer named change order r${String(raw.rev).slice(0, 12)}, not r${co.rev}; nothing was changed`);
    return finish();
  }
  const read = readUpdates(co, raw);
  notes.push(...read.notes);
  const askFirst = co.handler === "user";
  for (const u of read.updates) {
    const refused = whyNot(s, co, u, now);
    if (refused) {
      notes.push(refused);
      continue;
    }
    const row: SteeringChange = { id: `${setId}.${(rows?.changes.length ?? 0) + 1}`, kind: u.kind, ...(u.taskId ? { taskId: u.taskId } : {}), before: null, after: null, why: u.why, status: "suggested" };
    const items = u.proposal ? (withRefs(s, u.proposal, u.taskId ? getTask(s, u.taskId) : undefined).blueprintRefs ?? []) : [];
    const line: ChangeOrderLine = { changeId: row.id, status: "suggested", kind: u.kind, ...(u.taskId ? { taskId: u.taskId } : {}), items, words: "", why: u.why, ...(u.proposal ? { proposal: structuredClone(u.proposal) as unknown as Record<string, unknown> } : {}) };
    const owners = ownersCall(s, u);
    if (askFirst || owners) {
      line.words = lineWords(s, co, line);
      row.note = owners ?? "waits for your go-ahead (change orders: ask me first)";
    } else {
      const why = applyLineInto(s, co, line, row, now, "lead");
      if (why) {
        notes.push(why);
        continue;
      }
      row.status = "applied";
      row.appliedBy = "lead";
    }
    rows ??= newSet(s, r, co, now, simulated);
    rows.changes.push(row);
    co.lines = [...(co.lines ?? []), line];
    // The lead's acceptance lines its spec leaves out (a line under a rule's tag), named for the lead and the owner.
    if (u.proposal) notes.push(...refusedAcceptance(s, withRefs(s, u.proposal, u.taskId ? getTask(s, u.taskId) : undefined)).map((l) => `${u.taskId ?? `"${String(u.proposal!.title).slice(0, 80)}"`}: ${refusedAcceptanceNote(l)}`));
  }
  // What the lead left without a line: named for the owner, who handles it.
  const left = outstanding(s, co);
  if (!isSettled(left)) notes.push(`not handled: ${outstandingWords(s, left)}`);
  const lines = co.lines ?? [];
  const n = (status: ChangeOrderLine["status"]) => lines.filter((l) => l.status === status).length;
  const counts = [n("applied") ? `${n("applied")} applied` : "", n("suggested") ? `${n("suggested")} waiting for your go-ahead` : ""].filter(Boolean).join(", ");
  event(s, now, "lead", "vision", `Lead run ${r.id} answered change order r${co.rev}: ${lines.length ? `${lines.length} update${lines.length === 1 ? "" : "s"} (${counts})` : "no update"}${notes.length ? `; ${notes.length} note${notes.length === 1 ? "" : "s"}` : ""}${rows ? ` (${rows.id})` : ""}`);
  return finish();
}

/**
 * The change set a change-order run's lines go into, when the reply has none it may use. A refused set of the reply
 * (its steering block was refused) gives it its place and its refusal, as a note. On the state and the run.
 */
function newSet(s: State, r: LeadRun, co: ChangeOrder, now: string, simulated?: true): SteeringChangeSet {
  const id = `cs-${r.id}`;
  const at = s.steering.findIndex((x) => x.id === id);
  const refused = at >= 0 ? s.steering[at].refused : undefined;
  const set: SteeringChangeSet = { id, leadRunId: r.id, messageIds: [...r.messageIds], at: now, mode: s.project.steeringMode, basedOnVisionRev: r.visionRev ?? currentVision(s).rev, reason: `Change order r${co.rev}`, notes: refused ? [`The lead's steering block was refused: ${refused}.`] : [], changes: [], ...(simulated ? { simulated: true as const } : {}) };
  if (at >= 0) s.steering[at] = set;
  else {
    s.steering.push(set);
    if (s.steering.length > 200) s.steering.splice(0, s.steering.length - 200);
  }
  r.changeSetId = set.id;
  return set;
}

// ---------- the owner's Undo, go-ahead and Dismiss ----------
// Steering's commands (steeringChanges.ts) call these for a row of a line kind, and `lineCommandInto` when the
// steering log no longer holds the line's set: the line itself carries its status and what Undo needs.

/** Undo one applied line, compare-and-set. Returns why it was left as is, or undefined when undone. Mutates the draft. */
function undoLineInto(s: State, line: ChangeOrderLine, now: string): string | undefined {
  const why = undoneInto(s, line, now);
  if (!why) Object.assign(line, { status: "undone", resolvedAt: now });
  return why;
}

function undoneInto(s: State, line: ChangeOrderLine, now: string): string | undefined {
  if (line.kind === "retire") {
    const t = s.tasks.find((x) => x.id === line.taskId);
    return t ? reopenDropped(s, t, setIdOf(line.changeId), now) : "task not found";
  }
  if (line.kind === "update-spec") {
    const t = s.tasks.find((x) => x.id === line.taskId);
    if (!t) return "task not found";
    if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
    if (!queued(s, t)) return `${t.id} started on the updated spec; edit its spec yourself`;
    // Compare-and-set: the spec is still the lead's for this line (its update, or a revision the PE asked for).
    const rev = currentSpec(t).rev;
    if (rev !== line.specRevs?.at(-1)) return `its spec changed since (now r${rev})`;
    const old = t.specs.find((x) => x.rev === line.before?.specRev);
    if (!old) return "the spec before is not on record";
    try {
      editSpecInto(s, t, rev, structuredClone(old.content), `Undid the lead's update for change order (${line.changeId})`, "user", now);
    } catch (e) {
      if (e instanceof ControlError) return e.message;
      throw e;
    }
    // The spec before goes back with its PE review as it was: the PE's verdict on that content stands.
    if (line.before?.peReview) t.peReview = structuredClone(line.before.peReview);
    else delete t.peReview;
    return undefined;
  }
  const t = s.tasks.find((x) => x.id === line.madeTaskId);
  if (!t) return "task not found";
  if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
  if (started(s, t)) return `${t.id} has started; cancel it yourself`;
  const dep = openDependent(s, t, "drop");
  if (dep) return `${dep.id} depends on it`;
  cancelInto(s, t, now, { actor: "user", reason: `undo of ${line.changeId}` });
  return undefined;
}

/**
 * The lead revised a task's spec for the PE (`fromRev` → `toRev`, leadOutput.ts): when the spec it revised is a change
 * order's applied update, or a revision of one, the line records the new revision (review finding 6). Undo then still
 * restores the spec before the update, and any other edit since, the owner's, keeps it as is. Mutates the draft.
 */
export function recordPeRevisionInto(s: State, taskId: string, fromRev: number, toRev: number) {
  for (const co of s.blueprint.changeOrders)
    for (const line of co.lines ?? []) if (line.kind === "update-spec" && line.taskId === taskId && line.status === "applied" && line.specRevs?.at(-1) === fromRev) line.specRevs.push(toRev);
}

/** Undo one applied row of a line kind. Returns why it was left as is, or undefined when undone. Mutates the draft. */
export function undoChangeOrderRow(s: State, c: SteeringChange, now: string): string | undefined {
  const found = lineOf(s, c.id);
  return found ? undoLineInto(s, found.line, now) : "its change order line is not on record";
}

/** The owner's go-ahead on one row of a line kind that waits for it. Returns why it was left as is, or undefined when applied. Mutates the draft. */
export function applyChangeOrderRow(s: State, c: SteeringChange, now: string): string | undefined {
  const found = lineOf(s, c.id);
  return found ? applyLineInto(s, found.co, found.line, c, now, "user") : "its change order line is not on record";
}

/** The owner dismissed one row of a line kind that waited for the go-ahead. Mutates the draft. */
export function dismissChangeOrderRow(s: State, c: SteeringChange, now: string) {
  const found = lineOf(s, c.id);
  if (found?.line.status === "suggested") Object.assign(found.line, { status: "dismissed", resolvedAt: now });
}

/**
 * The owner's Undo, Apply or Dismiss of one line whose steering set the log no longer holds (it keeps the newest 200),
 * from the line's own record (review finding 7). Undefined when `changeId` names no line of set `changeSetId`; else
 * why it was left as is (`why`), or nothing when it was done. Mutates the draft; the caller settles the change orders.
 */
export function lineCommandInto(s: State, op: "undo" | "apply" | "dismiss", changeSetId: string, changeId: string, now: string): { why?: string } | undefined {
  const found = setIdOf(changeId) === changeSetId ? lineOf(s, changeId) : undefined;
  if (!found) return undefined;
  const { co, line } = found;
  let why: string | undefined;
  if (op === "undo") why = line.status === "undone" ? "already undone" : line.status !== "applied" ? "not applied" : undoLineInto(s, line, now);
  else if (line.status !== "suggested") why = line.status === "applied" ? "already applied" : `not a suggestion (${line.status})`;
  else if (op === "apply") why = applyLineInto(s, co, line, undefined, now, "user");
  else Object.assign(line, { status: "dismissed", resolvedAt: now });
  const done = op === "undo" ? "Undid" : op === "apply" ? "Applied" : "Dismissed";
  if (!why) event(s, now, "user", "control", `${done} the lead's update ${changeId} for change order r${co.rev}: ${line.words}`);
  return why ? { why } : {};
}

// ---------- closing ----------

/** What a change order still waits for: touched tasks not handled, and new-work items not planned. */
export interface Outstanding {
  tasks: string[];
  items: string[];
}
const isSettled = (o: Outstanding) => !o.tasks.length && !o.items.length;

/** A line the owner or the lead settled: applied, or undone or dismissed by the owner. A line that waits for the go-ahead is not. */
const settledLine = (line: ChangeOrderLine) => line.status === "applied" || line.status === "undone" || line.status === "dismissed";

/**
 * What is left to handle: a touched task is handled by a settled line for it, or when it is cancelled; a new-work item
 * is planned by a settled new-task line that cites it, or by any task not cancelled that cites it.
 */
export function outstanding(s: State, co: ChangeOrder): Outstanding {
  const lines = co.lines ?? [];
  const tasks = co.tasks
    .map((x) => x.taskId)
    .filter((id) => {
      if (lines.some((l) => l.taskId === id && settledLine(l))) return false;
      const t = s.tasks.find((x) => x.id === id);
      return !!t && t.lifecycle !== "cancelled";
    });
  const items = co.newWork.filter((id) => {
    if (lines.some((l) => l.kind === "new-task" && l.items.includes(id) && settledLine(l))) return false;
    return !s.tasks.some((t) => t.lifecycle !== "cancelled" && refsOf(t).includes(id));
  });
  return { tasks, items };
}

/** "T-012, T-014 and Packing list v1 (no task yet)". */
function outstandingWords(s: State, o: Outstanding): string {
  return listed([...o.tasks, ...o.items.map((id) => `${itemName(s, id)} (no task yet)`)]);
}

/** What was done per line when it closed, in the design's words, and how the rest was handled. */
function closingRecord(s: State, co: ChangeOrder, by: "service" | "user"): string[] {
  const record: string[] = [];
  for (const line of co.lines ?? []) {
    if (line.status === "applied") record.push(line.words);
    else if (line.status === "undone") record.push(`Undone by you: ${line.words}`);
    else if (line.status === "dismissed") record.push(`Dismissed by you: ${line.words}`);
    else if (line.status === "refused" || by === "user") record.push(`Not applied: ${line.words}`);
  }
  const lines = co.lines ?? [];
  for (const { taskId } of co.tasks) {
    if (lines.some((l) => l.taskId === taskId && settledLine(l))) continue;
    const t = s.tasks.find((x) => x.id === taskId);
    record.push(t?.lifecycle === "cancelled" ? `${taskId}: cancelled` : `${taskId}: not handled`);
  }
  for (const id of co.newWork) {
    if (lines.some((l) => l.kind === "new-task" && l.items.includes(id) && settledLine(l))) continue;
    const by = s.tasks.filter((t) => t.lifecycle !== "cancelled" && refsOf(t).includes(id)).map((t) => t.id);
    record.push(by.length ? `${itemName(s, id)}: planned in ${listed(by)}` : `${itemName(s, id)}: not planned`);
  }
  return record;
}

function closeInto(s: State, co: ChangeOrder, now: string, by: "service" | "user") {
  const record = closingRecord(s, co, by);
  co.status = "done";
  co.closed = { at: now, record };
  event(s, now, by === "user" ? "user" : "system", "vision", `Change order r${co.rev} closed${by === "user" ? " by you, as it stands" : ""}: ${record.join("; ")}`);
}

/** Close each open change order with nothing left to handle, on a draft. */
export function settleChangeOrdersInto(s: State, now: string) {
  for (const co of s.blueprint.changeOrders) if (co.status === "open" && isSettled(outstanding(s, co))) closeInto(s, co, now, "service");
}

/**
 * Close each open change order with nothing left to handle (the scheduler, each cycle): the owner may handle a task by
 * hand, or another task may plan the new work. Returns the same state when nothing closes.
 */
export function settleChangeOrders(state: State, now: string): State {
  if (!state.blueprint.changeOrders.some((co) => co.status === "open" && isSettled(outstanding(state, co)))) return state;
  const s = draft(state);
  settleChangeOrdersInto(s, now);
  return s;
}

/**
 * The owner closes a change order as it stands: what is left is recorded as not handled, and lines that wait for the
 * go-ahead stay as suggestions. Refused while the lead is answering it.
 */
export function closeChangeOrder(state: State, rev: number, now: string): State {
  const co = state.blueprint.changeOrders.find((c) => c.rev === rev);
  if (!co) throw new ControlError(`There is no change order for blueprint r${rev}.`);
  if (co.status !== "open") throw new ControlError(`Change order r${rev} is already closed.`);
  const r = co.leadRunId ? state.leadRuns.find((x) => x.id === co.leadRunId) : undefined;
  if (r && (r.outcome === "running" || r.outcome === "stopping")) throw new ControlError(`The lead is answering change order r${rev}; close it once its answer is in.`);
  const s = draft(state);
  closeInto(s, s.blueprint.changeOrders.find((c) => c.rev === rev)!, now, "user");
  return s;
}

// ---------- what the owner and the screens read ----------

/** One line as the change order screen shows it: the line, where it stands, and the PE review of its work. */
export interface ChangeOrderLineView {
  line: ChangeOrderLine;
  /** Where it stands: applied, waiting for the go-ahead ("suggested"), undone, dismissed or refused. */
  status: ChangeOrderLine["status"];
  /** The PE review of the line's work (the updated task, or the task it made); absent when it has none. */
  review?: NonNullable<Task["peReview"]>;
  /** The task the line's work is: the updated or retired task, or the task it made. */
  workTaskId?: string;
}

/** The change order's lines as they stand now. */
export function changeOrderLines(s: State, co: ChangeOrder): ChangeOrderLineView[] {
  return (co.lines ?? []).map((line) => {
    const workTaskId = line.kind === "revise" || line.kind === "new-task" ? line.madeTaskId : line.taskId;
    const work = workTaskId ? s.tasks.find((t) => t.id === workTaskId) : undefined;
    return { line, status: line.status, ...(work?.peReview && line.kind !== "retire" ? { review: work.peReview } : {}), ...(workTaskId ? { workTaskId } : {}) };
  });
}

/** What waits for the owner on an open change order once the lead answered: lines for the go-ahead, and what is not handled. */
export function changeOrderNeeds(s: State, co: ChangeOrder): { waiting: number; left: Outstanding; words: string } | undefined {
  if (co.status !== "open" || !leadAnswered(s, co)) return undefined;
  const suggested = (co.lines ?? []).filter((l) => l.status === "suggested");
  const waiting = suggested.length;
  const left = outstanding(s, co);
  // What waits for the go-ahead is not "not handled": it has a line.
  const notHandled = { tasks: left.tasks.filter((id) => !suggested.some((l) => l.taskId === id)), items: left.items.filter((id) => !suggested.some((l) => l.kind === "new-task" && l.items.includes(id))) };
  const parts = [waiting ? `${waiting} of the lead's updates wait${waiting === 1 ? "s" : ""} for your go-ahead` : "", isSettled(notHandled) ? "" : `not handled: ${outstandingWords(s, notHandled)}`].filter(Boolean);
  return parts.length ? { waiting, left, words: parts.join("; ") } : undefined;
}

/** The items a change order names, as blueprint items in force (for the briefs and the screens). */
export function changeOrderItems(s: State, ids: string[]): BlueprintItem[] {
  return ids.flatMap((id) => blueprintItems(s).filter((i) => i.id === id));
}
