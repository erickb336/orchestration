// ORC-029 pass 5, screen 5: where each blueprint item stands in the factory, from the state only. A dictionary is in
// force; a failing rule fails a check; a draft change puts it in the draft; running work is being built; landed work on
// this version is built and verified only when every rule passes ("No test" and "skipped" never do); work that built
// an earlier version does not count for the version in force; nothing started is designed.

import { describe, expect, it } from "vitest";
import { runCommand } from "../commands";
import { blueprintScene, citingTask, landTask, testReport } from "../testing/blueprintScene";
import { lockInAsOwner } from "../testing/studio";
import type { State } from "../types";
import { blueprintFactoryStatus, itemFactoryStatus } from "./itemStatus";

const statuses = (s: State) => Object.fromEntries(blueprintFactoryStatus(s).map((v) => [`${v.item.title} v${v.item.version}`, v.status]));
const status = (s: State, id: string) => itemFactoryStatus(s, id)!.status;

describe("an item's factory status", () => {
  it("in the prototype's scene: each status, with the tasks that cite the item and their states", () => {
    const { s, items, tasks } = blueprintScene();
    expect(statuses(s)).toEqual({
      "Trip plan v1": "in-the-draft", // the draft changes it to v2; T-001 builds v1 meanwhile
      "Trip data v1": "being-built", // landed, and a contract has no rules to prove it
      "Words v1": "in-force",
      "Join flow v1": "fails-a-check", // R4's test fails
      "Share costs v1": "built-and-verified",
      "Reminders v1": "in-the-draft", // the draft drops it
    });
    const plan = itemFactoryStatus(s, items.plan)!;
    expect(plan.tasks).toEqual([{ taskId: tasks.plan, title: "Trip plan screen", state: "running", thisVersion: true }]);
    expect(plan.draft).toMatchObject({ change: "changed", item: { id: items.plan, version: 2 } });
    expect(itemFactoryStatus(s, items.reminders)!.draft).toEqual({ change: "dropped" });
    expect(itemFactoryStatus(s, items.join)!.rules!.counts).toEqual({ passed: 4, failed: 1, skipped: 0, "no-test": 1 });
    // The draft's added item is not in force, and an unknown id has no status.
    expect(itemFactoryStatus(s, items.packing)).toBeUndefined();
    expect(itemFactoryStatus(s, "bi-404")).toBeUndefined();
  });

  it("after the Lock in: the dropped item leaves the list, the new one is designed, and running work on the old version still builds", () => {
    const sc = blueprintScene();
    const s = lockInAsOwner(sc.s, sc.at(400));
    expect(statuses(s)).toEqual({
      "Trip plan v2": "being-built",
      "Trip data v1": "being-built",
      "Words v1": "in-force",
      "Join flow v1": "fails-a-check",
      "Share costs v1": "built-and-verified",
      "Packing list v1": "designed",
    });
    // T-001's spec is from before v2 came into force: it builds the earlier version.
    expect(itemFactoryStatus(s, sc.items.plan)!.tasks).toEqual([{ taskId: sc.tasks.plan, title: "Trip plan screen", state: "running", thisVersion: false }]);
    expect(itemFactoryStatus(s, sc.items.plan)!.since).toBe(sc.at(400));
  });

  it("work that built an earlier version does not build this one; new work on this version that landed is built, and a screen is not verified without evidence", () => {
    const sc = blueprintScene();
    let s = lockInAsOwner(sc.s, sc.at(400));
    s = landTask(s, sc.tasks.plan, sc.at(500));
    expect(status(s, sc.items.plan)).toBe("designed");
    expect(itemFactoryStatus(s, sc.items.plan)!.tasks).toEqual([{ taskId: sc.tasks.plan, title: "Trip plan screen", state: "landed", thisVersion: false, landedAt: sc.at(500) }]);
    const revision = citingTask(s, "Trip plan: day list first", [sc.items.plan], sc.at(510));
    expect(status(revision.s, sc.items.plan)).toBe("designed"); // queued: not started
    s = landTask(revision.s, revision.taskId, sc.at(600));
    expect(status(s, sc.items.plan)).toBe("being-built");
  });

  it('"No test" and "skipped" never make an item built and verified; every rule and example passing does', () => {
    const sc = blueprintScene();
    const tag = (line: string) => `[${sc.items.join} ${line}]`;
    const rules = (e1: "passed" | "skipped" | undefined) =>
      testReport([
        [`${tag("R1")} shows the trip`, "passed"],
        [`${tag("R2")} adds the friend`, "passed"],
        [`${tag("R3")} says the trip is full`, "passed"],
        [`${tag("R4")} asks for a new link`, "passed"],
        [`${tag("R5")} never shows other trips`, "passed"],
        ...(e1 ? [[`${tag("E1")} a full trip`, e1] as [string, "passed" | "skipped"]] : []),
      ]);
    let fix = citingTask(sc.s, "Fix the expired link", [sc.items.join], sc.at(400));
    let s = landTask(fix.s, fix.taskId, sc.at(450), rules(undefined));
    expect(itemFactoryStatus(s, sc.items.join)!.rules!.counts).toEqual({ passed: 5, failed: 0, skipped: 0, "no-test": 1 });
    expect(status(s, sc.items.join)).toBe("being-built");
    fix = citingTask(s, "Test the full trip", [sc.items.join], sc.at(460));
    s = landTask(fix.s, fix.taskId, sc.at(470), rules("skipped"));
    expect(status(s, sc.items.join)).toBe("being-built");
    fix = citingTask(s, "Unskip the full trip", [sc.items.join], sc.at(480));
    s = landTask(fix.s, fix.taskId, sc.at(490), rules("passed"));
    expect(status(s, sc.items.join)).toBe("built-and-verified");
  });

  it("finished work that has not landed is still being built; a cancelled task is left out", () => {
    const sc = blueprintScene();
    const done = structuredClone(sc.s);
    const t = done.tasks.find((x) => x.id === sc.tasks.reminders)!;
    t.lifecycle = "done";
    // Discard the draft first, so the drop does not decide the status.
    const discard = (s: State) => runCommand(s, "discardDraft", { draftRev: s.blueprint.draft.rev }, sc.at(400)).state;
    expect(status(discard(sc.s), sc.items.reminders)).toBe("designed");
    expect(status(discard(done), sc.items.reminders)).toBe("being-built");
    expect(itemFactoryStatus(done, sc.items.reminders)!.tasks).toEqual([{ taskId: sc.tasks.reminders, title: "Outing reminders", state: "finished", thisVersion: true }]);
    t.lifecycle = "cancelled";
    expect(itemFactoryStatus(done, sc.items.reminders)!.tasks).toEqual([]);
    expect(status(discard(done), sc.items.reminders)).toBe("designed");
  });
});
