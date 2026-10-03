// ORC-029 pass 5 (5b): the lead adjusts the factory after a Lock in. A change order starts a lead run; its answer
// gives one update per touched task (a spec update, a revision task, a retirement) and new tasks for the new work. Each
// update is one line of the change order and one row of the reply's change set, so the owner undoes each line alone.
// Refused updates are named; PE review holds updated and new work; "ask me first" holds the updates for the owner's
// go-ahead; the change order closes with what was done per line, in the design's words.

import { describe, expect, it } from "vitest";
import { runCommand } from "../commands";
import * as M from "../model";
import { needsYouItems } from "../needsYou";
import { at, changeOrdered, startTask, T0, taskCiting } from "../testing/changeOrders";
import { run } from "../testing/studio";
import type { State } from "../types";

const proposal = (title: string, refs?: string[]) => ({
  title,
  outcome: `${title} is built as the blueprint shows.`,
  options: [
    { id: "A", name: "Build it", approach: "Build what the approved prototype shows." },
    { id: "B", name: "Defer", approach: "Wait." },
  ],
  recommendedOptionId: "A",
  rationale: "The user locked it in.",
  acceptance: ["The screen matches the approved prototype."],
  ...(refs ? { blueprintRefs: refs } : {}),
});

/** A change-order run, started and answered with this block (and nothing else). */
function answer(s: State, block: unknown, sec: number) {
  expect(M.leadDue(s, Date.parse(at(sec)), 600)).toBe("change-order");
  const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "change-order" }, at(sec));
  const done = M.completeLeadRun(r.state, r.runId, { reply: "", proposals: [], changeOrder: block } as never, at(sec + 1));
  return { s: done, runId: r.runId, setId: `cs-${r.runId}` };
}
const order = (s: State) => s.blueprint.changeOrders.at(-1)!;
/** The Needs-you entry's detail for the change order, if it waits for you. */
const needsDetail = (s: State) => {
  const e = needsYouItems(s, T0).find((i) => i.key === `change-order-${order(s).rev}`);
  return e?.kind === "open" ? e.detail : undefined;
};
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const rowsOf = (s: State, setId: string) => s.steering.find((x) => x.id === setId)!.changes;

/** The lead's full answer to `changeOrdered`: one update per touched task, and one new task. */
function fullAnswer(f: ReturnType<typeof changeOrdered>) {
  return {
    rev: order(f.s).rev,
    updates: [
      { action: "update-spec", task: f.tasks.queued, why: "Day list first, the map below it.", proposal: proposal("Trip list screen", [f.ids.plan, f.ids.list]) },
      { action: "revise", task: f.tasks.running, why: "The map moves below the days.", proposal: proposal("Move the trip plan map below the days", [f.ids.plan]) },
      { action: "retire", task: f.tasks.retiring, why: "You dropped Reminders.", proposal: null },
      { action: "revise", task: f.tasks.early, why: "The early plan shows the map first.", proposal: proposal("Revise the early trip plan", [f.ids.plan]) },
      { action: "new-task", task: null, why: "One shared list per trip.", proposal: proposal("Packing list screen", [f.ids.packing]) },
    ],
  };
}

describe("the lead's run after a Lock in", () => {
  it("an open change order starts a lead run, shown it; one completed answer starts no other", () => {
    const f = changeOrdered();
    expect(order(f.s)).toMatchObject({
      status: "open",
      handler: "lead",
      tasks: [
        { taskId: f.tasks.running, handling: "finish-then-revise" },
        { taskId: f.tasks.queued, handling: "update-spec" },
        { taskId: f.tasks.retiring, handling: "retire" },
        { taskId: f.tasks.early, handling: "plan-revision" },
      ],
      newWork: [f.ids.packing],
    });
    expect(M.changeOrdersDueForLead(f.s).map((c) => c.rev)).toEqual([order(f.s).rev]);
    const r = M.startLeadRun(f.s, { provider: "claude", model: "m", trigger: "change-order" }, at(20));
    expect(order(r.state).leadRunId).toBe(r.runId);
    expect(r.state.events.at(-1)!.message).toMatch(/^Lead change order run /);
    // A completed answer that gives nothing still answers it: what it left goes to you, and no new run starts.
    const done = M.completeLeadRun(r.state, r.runId, { reply: "Nothing to change.", proposals: [] } as never, at(21));
    expect(M.leadDue(done, Date.parse(at(22)), 600)).toBeNull();
    expect(order(done).notes).toEqual(["the lead's answer gave no updates for it"]);
    expect(needsDetail(done)).toMatch(new RegExp(`Not handled: ${f.tasks.running}, ${f.tasks.queued}, ${f.tasks.retiring}, ${f.tasks.early} and Packing list v1 \\(no task yet\\)\\.$`));
    expect(done.conversation.at(-1)!.rejected).toEqual([`Change order r${order(done).rev}: the lead's answer gave no updates for it`]);
  });

  it("a run that ended without completing leaves the change order due for the next one", () => {
    const f = changeOrdered();
    const r = M.startLeadRun(f.s, { provider: "claude", model: "m", trigger: "change-order" }, at(20));
    expect(M.changeOrdersDueForLead(r.state)).toEqual([]);
    const lost = M.reportLeadStopped(r.state, r.runId, at(21), true);
    expect(M.changeOrdersDueForLead(lost).map((c) => c.rev)).toEqual([order(f.s).rev]);
  });
});

describe("the lead's answer: one line per update", () => {
  it("applies a spec update, a revision that waits for the running task, a retirement and a new task, each in the design's words", () => {
    const f = changeOrdered();
    const { s, setId } = answer(f.s, fullAnswer(f), 20);
    const co = order(s);
    const made = co.lines!.filter((l) => l.madeTaskId).map((l) => l.madeTaskId!);
    expect(co.lines!.map((l) => [l.kind, l.words])).toEqual([
      ["update-spec", `Updated ${f.tasks.queued} → builds Trip plan v2`],
      ["revise", `New ${made[0]} revises ${f.tasks.running} once it lands → builds Trip plan v2`],
      ["retire", `Retired ${f.tasks.retiring}: builds only the dropped Reminders screen`],
      ["revise", `New ${made[1]} revises ${f.tasks.early} → builds Trip plan v2`],
      ["new-task", `New ${made[2]} → builds Packing list v1`],
    ]);
    // The queued task's spec is the lead's revision, citing what it builds; its acceptance comes from the version in force.
    expect(M.currentSpec(task(s, f.tasks.queued))).toMatchObject({ rev: 3, author: "lead", reason: `Change order r${co.rev}: Day list first, the map below it.`, content: { blueprintRefs: [f.ids.plan, f.ids.list] } });
    // The revision waits for the running task, which keeps running.
    expect(task(s, made[0]).dependsOn).toEqual([f.tasks.running]);
    expect(task(s, f.tasks.running).lifecycle).toBe("active");
    expect(task(s, f.tasks.retiring)).toMatchObject({ lifecycle: "cancelled", cancelledBy: "lead", dropped: { changeSetId: setId } });
    expect(M.currentSpec(task(s, made[2])).content.blueprintRefs).toEqual([f.ids.packing]);
    // Each line is one row of the reply's change set, applied by the lead.
    expect(rowsOf(s, setId).map((c) => [c.id, c.kind, c.status, c.appliedBy])).toEqual(co.lines!.map((l, i) => [`${setId}.${i + 1}`, l.kind, "applied", "lead"]));
    expect(co.lines!.map((l) => l.changeId)).toEqual(rowsOf(s, setId).map((c) => c.id));
    expect(s.conversation.at(-1)).toMatchObject({ author: "lead", changeSetId: setId });
  });

  it("closes once every touched task is handled and the new work is planned, with what was done per line", () => {
    const f = changeOrdered();
    const { s } = answer(f.s, fullAnswer(f), 20);
    const co = order(s);
    expect(co.status).toBe("done");
    expect(co.closed).toEqual({ at: at(21), record: co.lines!.map((l) => l.words) });
    expect(s.events.some((e) => e.message === `Change order r${co.rev} closed: ${co.lines!.map((l) => l.words).join("; ")}`)).toBe(true);
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order"))).toEqual([]);
  });

  it("names each update the domain refuses, keeps the rest, and leaves what is not handled to you (Needs you)", () => {
    const f = changeOrdered();
    const rev = order(f.s).rev;
    const { s } = answer(
      f.s,
      {
        rev,
        updates: [
          { action: "update-spec", task: f.tasks.running, why: "x", proposal: proposal("Trip plan screen", [f.ids.plan]) },
          { action: "retire", task: "T-404", why: "x", proposal: null },
          { action: "retire", task: f.tasks.retiring, why: "You dropped Reminders.", proposal: null },
          { action: "retire", task: f.tasks.retiring, why: "again", proposal: null },
          { action: "new-task", task: null, why: "x", proposal: proposal("Unrelated screen", [f.ids.list]) },
          { action: "revise", task: f.tasks.queued, why: "x", proposal: proposal("Revise the list") },
          { action: "grow", task: f.tasks.queued, why: "x" },
        ],
      },
      20,
    );
    const notes = [
      `${f.tasks.running} is running: only a queued task's spec is updated; plan a revision task instead ("revise")`,
      `T-404: not a task change order r${rev} touches`,
      `${f.tasks.retiring}: one update per task`,
      `"Unrelated screen": a new task cites at least one item change order r${rev} adds or changes (${f.ids.packing}, ${f.ids.plan})`,
      `${f.tasks.queued} has not started: update its spec instead ("update-spec")`,
      'update #7: "action" is one of update-spec, revise, retire, new-task',
    ];
    const left = `not handled: ${f.tasks.running}, ${f.tasks.queued}, ${f.tasks.early} and Packing list v1 (no task yet)`;
    const co = order(s);
    // Shape problems come first (read), then what the task as it is now refuses (checked), then what is left.
    expect(co.notes).toEqual([notes[1], notes[2], notes[5], notes[0], notes[3], notes[4], left]);
    expect(co.lines!.map((l) => l.kind)).toEqual(["retire"]);
    expect(s.conversation.at(-1)!.rejected).toEqual(co.notes!.map((n) => `Change order r${rev}: ${n}`));
    expect(co.status).toBe("open");
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order"))).toEqual([
      { kind: "open", key: `change-order-${rev}`, what: `Change order: blueprint r${rev}`, detail: `You changed the blueprint: Packing list (v1), Trip plan (v2); dropped Reminders (v1). It touches ${f.tasks.running}, ${f.tasks.queued}, ${f.tasks.retiring}, ${f.tasks.early}. Not handled: ${f.tasks.running}, ${f.tasks.queued}, ${f.tasks.early} and Packing list v1 (no task yet).`, action: "Open", href: `#/tasks/change-order/${rev}` },
    ]);
    // You close it as it stands: what is left is recorded as not handled.
    const closed = runCommand(s, "closeChangeOrder", { rev }, at(30)).state;
    expect(order(closed).closed!.record).toEqual([`Retired ${f.tasks.retiring}: builds only the dropped Reminders screen`, `${f.tasks.running}: not handled`, `${f.tasks.queued}: not handled`, `${f.tasks.early}: not handled`, "Packing list v1: not planned"]);
    expect(() => runCommand(closed, "closeChangeOrder", { rev }, at(31))).toThrow(`Change order r${rev} is already closed.`);
  });

  it("an answer for another change order, or from a run not shown one, changes nothing", () => {
    const f = changeOrdered();
    const wrong = answer(f.s, { rev: 99, updates: fullAnswer(f).updates }, 20).s;
    expect(order(wrong).lines).toBeUndefined();
    expect(order(wrong).notes![0]).toBe("the answer named change order r99, not r" + order(f.s).rev + "; nothing was changed");
    const m = M.startLeadRun(M.postMessage(f.s, "Hello", at(20)), { provider: "claude", model: "m", trigger: "message" }, at(20));
    const done = M.completeLeadRun(m.state, m.runId, { reply: "Hi.", proposals: [], changeOrder: fullAnswer(f) } as never, at(21));
    expect(order(done)).toEqual(order(f.s));
    expect(done.conversation.at(-1)!.rejected).toEqual(["Change order this run was not asked to answer a change order; nothing was changed"]);
  });
});

describe("Undo, line by line", () => {
  it("each line can be undone alone, and the others stay", () => {
    const f = changeOrdered();
    const a = answer(f.s, fullAnswer(f), 20);
    const lines = order(a.s).lines!;
    const undo = (s: State, i: number, sec: number) => M.undoSteering(s, a.setId, lines[i].changeId, at(sec));
    // The spec update: the spec before comes back (as your revision), with its PE review as it was.
    const before = task(f.s, f.tasks.queued);
    let r = undo(a.s, 0, 30);
    expect(r.result).toEqual({ undone: [lines[0].changeId], left: [] });
    expect(M.currentSpec(task(r.state, f.tasks.queued))).toMatchObject({ rev: 4, author: "user", content: M.currentSpec(before).content });
    expect(task(r.state, f.tasks.queued).peReview).toEqual(before.peReview);
    expect(rowsOf(r.state, a.setId).map((c) => c.status)).toEqual(["undone", "applied", "applied", "applied", "applied"]);
    // The revision task: cancelled, as it has not started. The running task runs on.
    r = undo(r.state, 1, 31);
    expect(task(r.state, lines[1].madeTaskId!).lifecycle).toBe("cancelled");
    expect(task(r.state, f.tasks.running).lifecycle).toBe("active");
    // The retirement: the task is back, queued.
    r = undo(r.state, 2, 32);
    expect(task(r.state, f.tasks.retiring)).toMatchObject({ lifecycle: task(f.s, f.tasks.retiring).lifecycle, dropped: undefined });
    // The new task: cancelled.
    r = undo(r.state, 4, 33);
    expect(task(r.state, lines[4].madeTaskId!).lifecycle).toBe("cancelled");
    expect(rowsOf(r.state, a.setId).map((c) => c.status)).toEqual(["undone", "undone", "undone", "applied", "undone"]);
    expect(task(r.state, lines[3].madeTaskId!).lifecycle).toBe("proposed");
    // A second Undo of the same line says so.
    expect(undo(r.state, 0, 34).result.left).toEqual([{ id: lines[0].changeId, why: "already undone" }]);
  });

  it("Undo leaves a line as is when the work moved on: a spec changed since, or a new task that started", () => {
    const f = changeOrdered();
    const a = answer(f.s, fullAnswer(f), 20);
    const lines = order(a.s).lines!;
    const t = task(a.s, f.tasks.queued);
    const edited = run(a.s, "editSpec", { taskId: t.id, expectedRev: 3, content: { ...M.currentSpec(t).content, outcome: "Changed by hand." }, reason: "mine" }, at(30)).state;
    expect(M.undoSteering(edited, a.setId, lines[0].changeId, at(31)).result.left).toEqual([{ id: lines[0].changeId, why: "its spec changed since (now r4)" }]);
    // The new task started (the PE agreed, and you gave the go-ahead): Undo would stop work, so you cancel it yourself.
    const id = lines[4].madeTaskId!;
    const agreed = runCommand(a.s, "recordPeReview", { taskId: id, specRev: 1, verdict: "feasible", reasons: "Fits." }, at(30)).state;
    const begun = startTask(agreed, id, 31);
    expect(task(begun, id).lifecycle).toBe("active");
    expect(M.undoSteering(begun, a.setId, lines[4].changeId, at(32)).result.left).toEqual([{ id: lines[4].changeId, why: `${id} has started; cancel it yourself` }]);
  });
});

describe("PE review of the updates", () => {
  it("with PE review of new work on, the updated spec and each new task wait for the PE; the change order shows each line's review", () => {
    const f = changeOrdered();
    expect(f.s.project.peReviewsNewWork).toBe(true);
    const a = answer(f.s, fullAnswer(f), 20);
    const views = M.changeOrderLines(a.s, order(a.s));
    expect(views.map((v) => [v.line.kind, v.status, v.review?.status])).toEqual([
      ["update-spec", "applied", "pending"],
      ["revise", "applied", "pending"],
      ["retire", "applied", undefined],
      ["revise", "applied", "pending"],
      ["new-task", "applied", "pending"],
    ]);
    // None of them starts while the PE reviews it: the owner's go-ahead alone does not release it.
    const updated = f.tasks.queued;
    const go = startTask(a.s, updated, 30);
    expect(task(go, updated).lifecycle).not.toBe("active");
    // The PE agrees on the updated spec: it may start.
    const agreed = runCommand(go, "recordPeReview", { taskId: updated, specRev: 3, verdict: "feasible", reasons: "Fits." }, at(31)).state;
    expect(M.changeOrderLines(agreed, order(agreed))[0].review?.status).toBe("agreed");
    expect(task(startTask(agreed, updated, 32), updated).lifecycle).toBe("active");
  });

  it("with PE review of new work off, nothing waits for the PE", () => {
    const f = changeOrdered();
    const off = runCommand(f.s, "setPeReviewsNewWork", { on: false }, at(19)).state;
    const a = answer(off, fullAnswer(f), 20);
    expect(M.changeOrderLines(a.s, order(a.s)).map((v) => v.review?.status)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("ask me first: the updates wait for your go-ahead", () => {
  it("the lead's updates are suggestions; nothing changes until you apply a line; dismissing one settles it too", () => {
    const f = changeOrdered("user");
    expect(order(f.s).handler).toBe("user");
    const a = answer(f.s, fullAnswer(f), 20);
    const lines = order(a.s).lines!;
    expect(rowsOf(a.s, a.setId).map((c) => [c.status, c.note])).toEqual(lines.map(() => ["suggested", "waits for your go-ahead (change orders: ask me first)"]));
    expect(lines.map((l) => l.words)).toEqual([`Updated ${f.tasks.queued} → builds Trip plan v2`, `A new task revises ${f.tasks.running} once it lands → builds Trip plan v2`, `Retired ${f.tasks.retiring}: builds only the dropped Reminders screen`, `A new task revises ${f.tasks.early} → builds Trip plan v2`, "A new task → builds Packing list v1"]);
    // Nothing changed yet.
    expect(a.s.tasks.length).toBe(f.s.tasks.length);
    expect(M.currentSpec(task(a.s, f.tasks.queued)).rev).toBe(2);
    expect(task(a.s, f.tasks.retiring).lifecycle).not.toBe("cancelled");
    expect(needsDetail(a.s)).toMatch(/ 5 of the lead's updates wait for your go-ahead\.$/);
    // Your go-ahead on one line applies it now; the others still wait.
    let s = M.applySteering(a.s, a.setId, lines[0].changeId, at(30)).state;
    expect(M.currentSpec(task(s, f.tasks.queued))).toMatchObject({ rev: 3, author: "lead" });
    expect(rowsOf(s, a.setId)[0]).toMatchObject({ status: "applied", appliedBy: "user", before: 2, after: 3 });
    expect(order(s).lines![0].proposal).toBeUndefined();
    // Apply all the rest but the new task, which you dismiss: the change order closes.
    s = M.dismissSteering(s, a.setId, lines[4].changeId, at(31)).state;
    s = M.applySteering(s, a.setId, undefined, at(32)).state;
    const co = order(s);
    const made = co.lines!.filter((l) => l.madeTaskId).map((l) => l.madeTaskId!);
    expect(co.status).toBe("done");
    expect(co.closed!.record).toEqual([
      `Updated ${f.tasks.queued} → builds Trip plan v2`,
      `New ${made[0]} revises ${f.tasks.running} once it lands → builds Trip plan v2`,
      `Retired ${f.tasks.retiring}: builds only the dropped Reminders screen`,
      `New ${made[1]} revises ${f.tasks.early} → builds Trip plan v2`,
      "Dismissed by you: A new task → builds Packing list v1",
    ]);
  });

  it("a line applies only to the task as it is when you give the go-ahead", () => {
    const f = changeOrdered("user");
    const a = answer(f.s, fullAnswer(f), 20);
    const line = order(a.s).lines![2];
    const cancelled = runCommand(a.s, "cancelTask", { taskId: f.tasks.retiring }, at(30)).state;
    const r = M.applySteering(cancelled, a.setId, line.changeId, at(31));
    expect(r.result.left).toEqual([{ id: line.changeId, why: `${f.tasks.retiring} is cancelled: only a queued task is retired; it is already gone` }]);
  });
});

describe("the change order's state as the owner and the scheduler see it", () => {
  it("a task you cancel and new work another task plans settle what the lead left: the scheduler closes it", () => {
    const f = changeOrdered();
    const rev = order(f.s).rev;
    const early = fullAnswer(f).updates[3];
    let s = answer(f.s, { rev, updates: [early] }, 20).s;
    expect(M.outstanding(s, order(s))).toEqual({ tasks: [f.tasks.running, f.tasks.queued, f.tasks.retiring], items: [f.ids.packing] });
    for (const id of [f.tasks.running, f.tasks.queued, f.tasks.retiring]) s = runCommand(s, "cancelTask", { taskId: id }, at(30)).state;
    expect(M.settleChangeOrders(s, at(31))).toBe(s); // the new work is not planned yet
    s = taskCiting(s, [f.ids.packing], "Packing list by hand", 32).s;
    const closed = M.settleChangeOrders(s, at(33));
    expect(order(closed).closed).toEqual({
      at: at(33),
      record: [order(s).lines![0].words, `${f.tasks.running}: cancelled`, `${f.tasks.queued}: cancelled`, `${f.tasks.retiring}: cancelled`, `Packing list v1: planned in ${closed.tasks.at(-1)!.id}`],
    });
  });

  it("you cannot close it while the lead is answering it", () => {
    const f = changeOrdered();
    const r = M.startLeadRun(f.s, { provider: "claude", model: "m", trigger: "change-order" }, at(20));
    expect(() => runCommand(r.state, "closeChangeOrder", { rev: order(f.s).rev }, at(21))).toThrow(`The lead is answering change order r${order(f.s).rev}; close it once its answer is in.`);
  });
});
