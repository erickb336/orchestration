// ORC-029 pass 5, screen 4: the change order. After a Lock in, the lead's updates to the factory's tasks, one row each:
// its kind, what it does in the design's words, why, the PE review of its work, and Undo (or Apply and Dismiss under
// "ask me first"). Then the tasks it did not touch, the notes on what the domain refused, Close it as it stands when it
// waits for you, and its record once closed. It is reached from the Lock in, the header, Needs you and Tasks.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { needsYouItems } from "../../domain/needsYou";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import { answerChangeOrder, at, changeOrdered, fullAnswer, leadProposal, T0 } from "../../domain/testing/changeOrders";
import { lockInArgs, run } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { Board } from "../Board";
import { fmtTime } from "../common";
import { parseRoute, tabOf } from "../route";
import { renderScreen, visible } from "../testStore";
import { StatusBanners } from "../task/Banners";
import { ChangeOrderPage } from "./ChangeOrder";
import { changeOrderWords } from "./changeOrderView";

const order = (s: State) => s.blueprint.changeOrders.at(-1)!;
const page = (s: State, rev = order(s).rev) => {
  const html = renderScreen(<ChangeOrderPage rev={rev} />, s);
  return { html, text: visible(html), rows: html.split('<li class="k-row co-row">').slice(1).map((x) => visible(x.slice(0, x.indexOf("</li>")))) };
};
const count = (text: string, needle: string) => text.split(needle).length - 1;
/** The time the screen shows for a fixture second. */
const t = (sec: number) => fmtTime(at(sec));

describe("the change order screen", () => {
  it("before the lead answers: what the Lock in changed, and that the lead's next run answers it", () => {
    const f = changeOrdered();
    const { text } = page(f.s);
    expect(text).toBe(`Tasks › Change order 2 Change order 2 · from Lock in 2 Made ${t(18)}. Lock in 2: Trip plan v1 → v2; added Packing list v1; dropped Reminders v1. No updates yet: the lead's next run answers it Waits for the lead`);
  });

  it("applied lines show the PE review of their work, agreed, reviewing or asking a change, and each has Undo", () => {
    const f = changeOrdered();
    const a = answerChangeOrder(f.s, fullAnswer(f), 20);
    const [revision, , newTask] = order(a.s).lines!.filter((l) => l.madeTaskId).map((l) => l.madeTaskId!);
    let s = runCommand(a.s, "recordPeReview", { taskId: f.tasks.queued, specRev: 3, verdict: "feasible", reasons: "Fits." }, at(30)).state;
    s = runCommand(s, "recordPeReview", { taskId: newTask, specRev: 1, verdict: "feasible-if", reasons: "One list is shared.", change: "Store items per trip, not per person." }, at(31)).state;
    const { html, text, rows } = page(s);
    expect(text).toContain("5 updates: 2 applied, 3 waiting for PE review Closed the lead · Claude");
    const applied = `Applied by the lead, ${t(21)}.`;
    expect(rows).toEqual([
      `Updated T-002 → builds Trip plan v2 PE agreed T-002 Trip list screen ${applied} The lead: “Day list first, the map below it.” Undo`,
      `Revision New ${revision} revises T-001 once it lands → builds Trip plan v2 PE reviewing ${revision} Move the trip plan map below the days ${applied} The lead: “The map moves below the days.” It waits for the PE's review, then starts. Undo`,
      `Retired T-003: builds only the dropped Reminders screen T-003 Outing reminders ${applied} The lead: “You dropped Reminders.” Undo`,
      `Revision New T-006 revises T-004 → builds Trip plan v2 PE reviewing T-006 Revise the early trip plan ${applied} The lead: “The early plan shows the map first.” It waits for the PE's review, then starts. Undo`,
      `New ${newTask} → builds Packing list v1 PE asks a change ${newTask} Packing list screen ${applied} The lead: “One shared list per trip.” The PE: "One list is shared. The change it asks for: Store items per trip, not per person." The lead revises it (round 1 of 3). Undo`,
    ]);
    expect(html).toContain(`<a href="#/task/${newTask}">`);
    // Undo of a task the lead made cancels it, so it asks first; Undo of a spec update does not.
    const lines = changeOrderWords(s, order(s)).lines;
    expect(lines[0].undoConfirm).toBeUndefined();
    expect(lines[4].undoConfirm).toEqual({ title: `Undo ${newTask}?`, text: `Undo cancels ${newTask}, which the lead made for this change order. It has not started, so no work is lost. A cancelled task cannot be opened again.`, primaryLabel: `Undo and cancel ${newTask}` });
    // Every task is handled, so it closed at once: its record sits behind a disclosure, as it says what the rows say.
    expect(text).toContain(`Closed ${t(21)} The record: what was done when it closed 5 The rows above show each update as it is now. Updated T-002 → builds Trip plan v2`);
    expect(html).toContain('<details class="k-disc"><summary class="k-disc__summary">The record');
    expect(text).not.toContain("Close it as it stands");
  });

  it("an update the domain refused is named in the notes; what is left waits for you, with Close it as it stands; closed, its record shows", () => {
    const f = changeOrdered();
    const block = { rev: 2, updates: [{ action: "update-spec", task: f.tasks.running, why: "x", proposal: leadProposal("Trip plan screen", [f.ids.plan]) }, { action: "retire", task: f.tasks.retiring, why: "You dropped Reminders.", proposal: null }] };
    const s = answerChangeOrder(f.s, block, 20).s;
    const { text } = page(s);
    expect(text).toContain("It waits for you. Not handled: T-001, T-002, T-004 and Packing list v1 (no task yet). Close it as it stands, or message the lead. Close it as it stands 1 update: 1 applied Waits for you the lead · Claude");
    // The note on what was not handled when the answer came in is the banner's now.
    expect(text).toContain(`Notes on the lead's answer 1 The service checks each update against the tasks as they are now. It refused these updates, or the lead left these out. T-001 is running: only a queued task's spec is updated; plan a revision task instead ("revise")`);
    expect(order(s).notes).toHaveLength(2);
    expect(changeOrderWords(s, order(s)).waits!.confirm).toEqual({
      title: "Close change order 2 as it stands?",
      text: 'What is not handled is recorded as "not handled", and the factory goes on as it is. You can still message the lead about it.',
      primaryLabel: "Close it as it stands",
    });
    // Closed as it stands: the record says what was not handled, so it shows open.
    const closed = runCommand(s, "closeChangeOrder", { rev: 2 }, at(30)).state;
    const c = page(closed);
    expect(c.text).not.toContain("It waits for you.");
    expect(c.text).toContain(`Closed ${t(30)} The record: what was done when it closed 5 The rows above show each update as it is now. Retired T-003: builds only the dropped Reminders screen T-001: not handled T-002: not handled T-004: not handled Packing list v1: not planned`);
    expect(c.html).toContain('<details class="k-disc" open=""><summary class="k-disc__summary">The record');
  });

  it("ask me first: each update waits for your go-ahead with Apply and Dismiss; applied, it shows its PE review and Undo; closed, the rest is not applied", () => {
    const f = changeOrdered("user");
    const a = answerChangeOrder(f.s, fullAnswer(f), 20);
    const before = page(a.s);
    expect(before.text).toContain("It waits for you. 5 of the lead's updates wait for your go-ahead. Apply or dismiss each update below that waits for you, or close it as it stands.");
    expect(before.text).toContain("5 updates: 5 waiting for your go-ahead Waits for you");
    expect(before.rows[0]).toBe("Updated T-002 → builds Trip plan v2 Waits for your go-ahead T-002 Trip list screen Nothing changed yet. The lead: “Day list first, the map below it.” Apply Dismiss");
    expect(before.rows[4]).toBe("New A new task → builds Packing list v1 Waits for your go-ahead Nothing changed yet. The lead: “One shared list per trip.” Apply Dismiss");
    expect([count(before.text, "Apply Dismiss"), count(before.text, "Undo")]).toEqual([5, 0]);
    // Your go-ahead on the spec update: it applies, and waits for the PE.
    const lines = order(a.s).lines!;
    const applied = M.applySteering(a.s, a.setId, lines[0].changeId, at(30)).state;
    expect(page(applied).rows[0]).toBe(`Updated T-002 → builds Trip plan v2 PE reviewing T-002 Trip list screen Applied by you, ${t(30)}. The lead: “Day list first, the map below it.” It waits for the PE's review, then starts. Undo`);
    expect(page(applied).text).toContain("5 updates: 1 waiting for PE review, 4 waiting for your go-ahead");
    // You dismiss one and close the rest as it stands: they are not applied, and nothing is left to do on them.
    const dismissed = M.dismissSteering(applied, a.setId, lines[4].changeId, at(31)).state;
    const closed = page(runCommand(dismissed, "closeChangeOrder", { rev: 2 }, at(32)).state);
    expect(closed.rows[1]).toBe("Revision A new task revises T-001 once it lands → builds Trip plan v2 Not applied You closed the change order as it stood. The lead: “The map moves below the days.”");
    expect(closed.rows[4]).toBe(`New A new task → builds Packing list v1 Dismissed Dismissed by you, ${t(31)}. The lead: “One shared list per trip.”`);
    expect(count(closed.text, "Apply")).toBe(0);
    expect(closed.text).toContain("5 updates: 1 waiting for PE review, 3 not applied, 1 dismissed Closed");
    expect(closed.text).toContain("Not applied: A new task revises T-004 → builds Trip plan v2 Dismissed by you: A new task → builds Packing list v1 T-001: not handled T-003: not handled T-004: not handled");
  });

  it("a line the lead may not do alone waits for you and says why; its state stays after the steering log drops its set", () => {
    const f = changeOrdered("lead", "user");
    const a = answerChangeOrder(f.s, { rev: 2, updates: [fullAnswer(f).updates[2]] }, 20);
    const row = "Retired T-003: builds only the dropped Reminders screen Waits for your go-ahead T-003 Outing reminders Nothing changed yet. The lead: “You dropped Reminders.” The lead may not do it alone: your task: only you cancel it. Apply Dismiss";
    expect(page(a.s).rows[0]).toBe(row);
    expect(page(a.s).text).toContain("Apply or dismiss each update below that waits for you, or close it as it stands.");
    // The log keeps the newest 200 sets: without its set, the line keeps its state and Apply; only the reason goes.
    const evicted = { ...a.s, steering: a.s.steering.filter((x) => x.id !== a.setId) };
    expect(page(evicted).rows[0]).toBe(row.replace(" The lead may not do it alone: your task: only you cancel it.", ""));
  });

  it("an Undo the service left as is says why on the line", () => {
    const f = changeOrdered();
    const a = answerChangeOrder(f.s, fullAnswer(f), 20);
    const task = a.s.tasks.find((x) => x.id === f.tasks.queued)!;
    const edited = run(a.s, "editSpec", { taskId: task.id, expectedRev: 3, content: { ...M.currentSpec(task).content, outcome: "Changed by hand." }, reason: "mine" }, at(30)).state;
    const left = M.undoSteering(edited, a.setId, order(a.s).lines![0].changeId, at(31)).state;
    expect(page(left).rows[0]).toBe(`Updated T-002 → builds Trip plan v2 PE reviewing T-002 Trip list screen Applied by the lead, ${t(21)}. The lead: “Day list first, the map below it.” It waits for the PE's review, then starts. Left as is: Its spec changed since (now r4) Undo`);
  });

  it("after Undo of a retirement, the line and the task's page say that the task builds a part you dropped (ORC-030 Q-13)", () => {
    const f = changeOrdered();
    const a = answerChangeOrder(f.s, fullAnswer(f), 20);
    const retired = order(a.s).lines!.find((l) => l.kind === "retire")!;
    const back = M.undoSteering(a.s, a.setId, retired.changeId, at(30)).state;
    expect(back.tasks.find((x) => x.id === f.tasks.retiring)!.lifecycle).not.toBe("cancelled");
    expect(page(back).rows[2]).toBe(
      `Retired T-003: builds only the dropped Reminders screen Undone T-003 Outing reminders Undone by you, ${t(30)}. The lead: “You dropped Reminders.” T-003 is back, and it builds Reminders v1, which you dropped at Lock in 2. Open it to cancel it or edit its spec.`,
    );
    const task = back.tasks.find((x) => x.id === f.tasks.retiring)!;
    const banner = visible(renderScreen(<StatusBanners state={back} task={task} />, back));
    expect(banner).toBe("It builds a part you dropped. Reminders v1 left the design at Lock in 2. If it should not be built, cancel this task under More, or edit its spec.");
    // Before the Undo the task is retired: nothing is said on it.
    const cancelled = a.s.tasks.find((x) => x.id === f.tasks.retiring)!;
    expect(visible(renderScreen(<StatusBanners state={a.s} task={cancelled} />, a.s))).not.toContain("you dropped");
  });

  it("names the tasks it did not touch in one line", () => {
    const sc = blueprintScene();
    const s = runCommand(sc.s, "lockIn", lockInArgs(sc.s), sc.at(400)).state;
    expect(page(s).text).toContain(`Not changed: ${sc.tasks.join} Join by link, ${sc.tasks.costs} Share costs, ${sc.tasks.data} Trip data API. They cite nothing that changed.`);
  });

  it("a change order that does not exist says so", () => {
    expect(page(changeOrdered().s, 9).text).toBe("Tasks › Change order 9 There is no change order 9. A Lock in while the factory runs makes a change order when it touches a task or brings new work. Open the tasks");
  });
});

describe("the ways to a change order", () => {
  it("has its address under Tasks", () => {
    expect(parseRoute("#/tasks/change-order/3")).toEqual({ page: "change-order", rev: 3 });
    expect(tabOf(parseRoute("#/tasks/change-order/3"))).toBe("tasks");
    expect(parseRoute("#/tasks/change-order/none")).toEqual({ page: "tasks" });
  });

  it("Needs you and the Tasks page link to an open one that waits for you", () => {
    const f = changeOrdered();
    const s = answerChangeOrder(f.s, { rev: 2, updates: [] }, 20).s;
    expect(needsYouItems(s, T0).find((i) => i.key === "change-order-2")).toMatchObject({ action: "Open", href: "#/tasks/change-order/2" });
    const board = renderScreen(<Board />, s);
    expect(visible(board)).toContain("Change order 2 · from Lock in 2 Not handled: T-001, T-002, T-003, T-004 and Packing list v1 (no task yet). Open it");
    expect(board).toContain('href="#/tasks/change-order/2"');
    // Closed, it leaves the Tasks page.
    expect(visible(renderScreen(<Board />, runCommand(s, "closeChangeOrder", { rev: 2 }, at(30)).state))).not.toContain("Change order 2");
  });
});
