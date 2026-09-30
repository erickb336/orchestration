// ORC-008 step 1, pure: the data model defaults, delivery-mode exclusivity, the review-later queue,
// and the follow-up fixes. Nothing here touches git or GitHub. (Notification keys: src/ui/notifications.test.ts.)

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as D from "./delivery";
import * as M from "./model";
import { buildEmptyProject, buildSeed } from "./seed";
import { BUILT_IN_TEMPLATES, templateSteps } from "./templates";
import { ControlError, DEFAULT_PR_DELIVERY, type Integration, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const seed = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const autonomy = (s: State, deliver: boolean) => ({ ...s.project.autonomy, autoDeliver: { enabled: deliver, branch: "main" } });

/** Fixture: a done task whose work is on the integration branch (as the scheduler records it). */
function integrated(s: State, id: string, integration: Partial<Integration> = {}): State {
  const next = structuredClone(s);
  const t = task(next, id);
  t.lifecycle = "done";
  t.integration = { status: "integrated", at: at(0), ref: `${SHA_A.slice(0, 12)} on orchestration/sample/integration`, sha: SHA_A, ...integration };
  return next;
}

/** EX-006 delivered to main by local delivery: it has a landed item. */
function landedState(): State {
  let s = integrated(seed(), "EX-006");
  s = M.setAutonomy(s, autonomy(s, true), at(1));
  return M.reportDeliveryResult(s, { status: "delivered", message: "main fast-forwarded to aaaaaaaaaaaa.", sha: SHA_A }, at(2));
}

/** Drive a task's single running attempt to completion. */
function finish(s: State, taskId: string, t: number, findings = 0): State {
  const [a] = M.activeAttempts(s, taskId);
  const st = task(s, taskId).steps.find((x) => x.id === a.stepId)!;
  const outputs = st.outputs.map((o) => ({ name: o.name, summary: `${o.name} at ${t}`, openFindings: o.kind === "review-findings" ? findings : undefined }));
  return M.reportCompletion(s, a.id, [], at(t), outputs);
}

describe("data model", () => {
  it("a new project is format 10 with pull-request delivery off and nothing observed", () => {
    for (const s of [seed(), buildEmptyProject(T0)]) {
      expect(s.version).toBe(10);
      expect(s.project.prDelivery).toEqual(DEFAULT_PR_DELIVERY);
      expect(s.project.prDelivery).toMatchObject({ enabled: false, merge: "hold" });
      expect(s.project.github).toBeUndefined();
      expect(s.tasks.some((t) => t.integration?.pr || t.integration?.landed)).toBe(false);
    }
  });

  it("starting a new project turns pull-request delivery off and forgets what was observed", () => {
    let s = D.setDeliveryMode(seed(), { mode: "pr" }, at(0));
    s.attempts = []; // no active runs
    s = M.initProject(s, { name: "N", repoPath: "/tmp/n", vision: "v", focus: "f" }, at(1));
    expect(s.project.prDelivery).toEqual(DEFAULT_PR_DELIVERY);
    expect(s.project.github).toBeUndefined();
  });

  it("the revert template is built in and valid", () => {
    expect(BUILT_IN_TEMPLATES.some((t) => t.id === "revert")).toBe(true);
    expect(templateSteps("revert").map((s) => s.role)).toEqual(["coder", "code_reviewer", "lead"]);
  });
});

describe("delivery mode", () => {
  const both = (s: State) => s.project.autonomy.autoDeliver.enabled && s.project.prDelivery.enabled;

  it("sets the two modes together, never both, and never turns on automatic merging", () => {
    let s = seed();
    expect(D.deliveryMode(s)).toBe("off");
    s = D.setDeliveryMode(s, { mode: "local", branch: "main" }, at(1));
    expect(D.deliveryMode(s)).toBe("local");
    expect(s.project.prDelivery.enabled).toBe(false);
    s = D.setDeliveryMode(s, { mode: "pr" }, at(2));
    expect(D.deliveryMode(s)).toBe("pr");
    expect(s.project.autonomy.autoDeliver.enabled).toBe(false);
    expect(s.project.github).toMatchObject({ ok: false, recheck: true });
    expect(s.project.prDelivery.merge).toBe("hold");
    s = D.setDeliveryMode(s, { mode: "local" }, at(3));
    expect(both(s)).toBe(false);
    expect(D.deliveryMode(s)).toBe("local");
    s = D.setDeliveryMode(s, { mode: "off" }, at(4));
    expect(D.deliveryMode(s)).toBe("off");
    expect(both(s)).toBe(false);
  });

  it("setAutonomy refuses local delivery while pull-request delivery is on", () => {
    const s = D.setDeliveryMode(seed(), { mode: "pr" }, at(1));
    expect(() => M.setAutonomy(s, autonomy(s, true), at(2))).toThrow(/switch the delivery mode/);
    expect(both(M.setAutonomy(s, { ...autonomy(s, false), enabled: true }, at(2)))).toBe(false);
  });

  it("the autopilot preset never turns on publishing or automatic merging", () => {
    const off = M.applyAutopilot(seed(), "main", at(1));
    expect(off.project.autonomy.autoDeliver).toEqual({ enabled: true, branch: "main" });
    expect(off.project.prDelivery).toEqual(DEFAULT_PR_DELIVERY);

    const pr = D.setDeliveryMode(seed(), { mode: "pr" }, at(1));
    const next = M.applyAutopilot(pr, "release", at(2));
    expect(next.project.autonomy.enabled).toBe(true);
    expect(next.project.autonomy.autoDeliver.enabled).toBe(false);
    expect(next.project.prDelivery).toEqual(pr.project.prDelivery);
    expect(next.project.prDelivery.merge).toBe("hold");
  });

  it("turning local delivery on queues work that was integrated while delivery was off", () => {
    const s = integrated(seed(), "EX-006");
    expect(M.deliveryDue(s, T0)).toBe(false);
    const on = D.setDeliveryMode(s, { mode: "local", branch: "main" }, at(1));
    expect(on.project.delivery?.pending).toBe(true);
    expect(M.deliveryDue(on, T0 + 1000)).toBe(true);
    // Nothing waiting: nothing queued.
    expect(D.setDeliveryMode(seed(), { mode: "local", branch: "main" }, at(1)).project.delivery?.pending).toBeFalsy();
  });

  it("changing the delivery branch forgets the old branch's baseline", () => {
    let s = landedState();
    expect(s.project.delivery?.lastSha).toBe(SHA_A);
    s = D.setDeliveryMode(s, { mode: "local", branch: "release" }, at(3));
    expect(s.project.autonomy.autoDeliver.branch).toBe("release");
    expect(s.project.delivery?.lastSha).toBeUndefined();
    expect(() => D.setDeliveryMode(s, { mode: "local", branch: "bad branch" }, at(4))).toThrow(ControlError);
  });

  it("resetDeliveryBaseline clears the baseline after a blocked delivery and queues a new attempt", () => {
    let s = landedState();
    s = M.reportDeliveryResult(s, { status: "blocked", message: "main no longer contains work delivered earlier." }, at(10));
    expect(s.project.autonomy.autoDeliver.enabled).toBe(false);
    expect(s.project.delivery).toMatchObject({ status: "blocked", lastSha: SHA_A, pending: false });
    s = M.resetDeliveryBaseline(s, at(11));
    expect(s.project.delivery).toEqual({ pending: true });
    expect(s.project.autonomy.autoDeliver.enabled).toBe(false); // turning delivery back on stays the user's choice
    expect(() => M.resetDeliveryBaseline(D.setDeliveryMode(s, { mode: "pr" }, at(12)), at(13))).toThrow(/Pull-request delivery is on/);
  });

  it("the command cannot switch pull-request delivery on in this build", () => {
    expect(() => runCommand(seed(), "setDeliveryMode", { mode: "pr" }, at(1))).toThrow(/not available/);
    expect(() => runCommand(seed(), "setDeliveryMode", { mode: "sideways" }, at(1))).toThrow(/mode must be/);
    expect(D.deliveryMode(runCommand(seed(), "setDeliveryMode", { mode: "local", branch: "main" }, at(1)).state)).toBe("local");
  });
});

describe("landed: local delivery", () => {
  it("a delivery creates one unreviewed item per newly delivered task, with the full merge commit", () => {
    let s = integrated(integrated(seed(), "EX-006"), "EX-005", { sha: SHA_B });
    s = M.setAutonomy(s, autonomy(s, true), at(1));
    s = M.reportDeliveryResult(s, { status: "delivered", message: "main fast-forwarded.", sha: SHA_B }, at(2));
    expect(task(s, "EX-006").integration?.landed).toEqual({ at: at(2), via: "local", target: "main", commit: SHA_A, by: "app", flags: [], status: "unreviewed", notes: [], followUps: [] });
    expect(task(s, "EX-005").integration?.landed?.commit).toBe(SHA_B);
    expect(D.unreviewedCount(s)).toBe(2);
    expect(D.landedTasks(s).map((t) => t.id).sort()).toEqual(["EX-005", "EX-006"]);

    // A later delivery adds nothing for tasks that already landed.
    const before = structuredClone(task(s, "EX-006").integration);
    const again = M.reportDeliveryResult(s, { status: "delivered", message: "main already contains all integrated work.", sha: SHA_B }, at(60));
    expect(task(again, "EX-006").integration).toEqual(before);
    expect(D.unreviewedCount(again)).toBe(2);
  });

  it("nothing lands until the delivery succeeds, and nothing is backfilled", () => {
    let s = integrated(seed(), "EX-006");
    // Delivered before this feature existed: marked delivered, no merge commit recorded.
    s = integrated(s, "EX-005", { sha: undefined, delivered: { status: "delivered", at: at(-100), message: "earlier" } });
    // Integrated before the merge commit was recorded, delivered now: it cannot be shown, so it is not listed.
    s = integrated(s, "EX-004", { sha: undefined });
    s = M.setAutonomy(s, autonomy(s, true), at(1));
    const skipped = M.reportDeliveryResult(s, { status: "skipped", message: "main is checked out with uncommitted changes." }, at(2));
    expect(D.landedTasks(skipped)).toHaveLength(0);
    const done = M.reportDeliveryResult(skipped, { status: "delivered", message: "ok", sha: SHA_A }, at(70));
    expect(D.landedTasks(done).map((t) => t.id)).toEqual(["EX-006"]);
    expect(task(done, "EX-004").integration?.delivered?.status).toBe("delivered");
  });

  it("local delivery never marks a pull-request task delivered or landed", () => {
    let s = integrated(seed(), "EX-006");
    const pr = { branch: "orchestration/sample/pr/EX-005-1", headSha: SHA_B } as Integration["pr"];
    s = integrated(s, "EX-005", { sha: SHA_B, pr });
    expect(D.undeliveredTasks(s).map((t) => t.id)).toEqual(["EX-006"]);
    s = M.setAutonomy(s, autonomy(s, true), at(1));
    s = M.reportDeliveryResult(s, { status: "delivered", message: "ok", sha: SHA_A }, at(2));
    expect(task(s, "EX-005").integration?.delivered).toBeUndefined();
    expect(task(s, "EX-005").integration?.landed).toBeUndefined();
  });

  it("reportIntegration stores the merge commit and words a pull-request head truthfully", () => {
    const pending = (s: State) => {
      const n = structuredClone(s);
      task(n, "EX-006").integration = { status: "pending" };
      return M.setAutonomy(n, autonomy(n, true), at(0));
    };
    const local = M.reportIntegration(pending(seed()), "EX-006", { status: "integrated", ref: "aaaaaaaaaaaa on x", sha: SHA_A }, at(1));
    expect(task(local, "EX-006").integration).toMatchObject({ status: "integrated", sha: SHA_A, at: at(1) });
    expect(local.project.delivery?.pending).toBe(true);
    expect(local.events.at(-1)!.message).toContain("Integrated into the integration branch");

    const pr = { branch: "orchestration/sample/pr/EX-006-1", headSha: SHA_B } as Integration["pr"];
    const viaPr = M.reportIntegration(pending(seed()), "EX-006", { status: "integrated", ref: "bbbbbbbbbbbb on pr", sha: SHA_B, pr }, at(1));
    expect(viaPr.project.delivery?.pending).toBeFalsy();
    expect(viaPr.events.at(-1)!.message).toBe("Prepared pull request branch orchestration/sample/pr/EX-006-1 (bbbbbbbbbbbb)");
  });
});

describe("landed: the queue never blocks and changes only by explicit commands", () => {
  it("visiting, dispatching and delivering again never change an item's status", () => {
    let s = landedState();
    const item = () => structuredClone(task(s, "EX-006").integration!.landed);
    const before = item();
    s = M.markVisited(s, at(5));
    s = M.dispatchEligible(M.leadPromoteProposals(s, at(6)), at(6));
    s = M.reportDeliveryResult(s, { status: "delivered", message: "again", sha: SHA_A }, at(7));
    expect(item()).toEqual(before);
    expect(D.unreviewedCount(s)).toBe(1);
  });

  it("an unreviewed item changes nothing about dispatch", () => {
    const withItem = landedState();
    const without = structuredClone(withItem);
    delete task(without, "EX-006").integration!.landed;
    const run = (s: State) => M.dispatchEligible(M.leadPromoteProposals(s, at(9)), at(9));
    const ids = (s: State) => M.activeAttempts(s).map((a) => `${a.taskId}/${a.stepId}`);
    expect(ids(run(withItem))).toEqual(ids(run(without)));
    expect(ids(run(withItem)).length).toBeGreaterThan(0);
  });

  it("markLandedReviewed is the only way to reviewed, and back", () => {
    let s = landedState();
    s = D.markLandedReviewed(s, ["EX-006"], true, at(5));
    expect(task(s, "EX-006").integration!.landed).toMatchObject({ status: "reviewed", statusAt: at(5) });
    expect(D.unreviewedCount(s)).toBe(0);
    s = D.markLandedReviewed(s, ["EX-006"], false, at(6));
    expect(D.unreviewedCount(s)).toBe(1);
    expect(() => D.markLandedReviewed(s, ["EX-001"], true, at(7))).toThrow(/has not landed/);
    expect(() => D.markLandedReviewed(s, [], true, at(7))).toThrow(ControlError);
    expect(() => D.markLandedReviewed(s, Array.from({ length: 101 }, () => "EX-006"), true, at(7))).toThrow(/At most 100/);
  });

  it("a note is recorded at once, never marks the item reviewed, and cannot be posted for local work", () => {
    let s = landedState();
    s = D.addLandedNote(s, "EX-006", "  Check the timezone handling.  ", false, at(5));
    const l = task(s, "EX-006").integration!.landed!;
    expect(l.notes).toHaveLength(1);
    expect(l.notes[0]).toMatchObject({ text: "Check the timezone handling.", at: at(5) });
    expect(l.notes[0].comment).toBeUndefined();
    expect(l.status).toBe("unreviewed");
    expect(() => D.addLandedNote(s, "EX-006", "post it", true, at(6))).toThrow(/pull request/);
    expect(() => D.addLandedNote(s, "EX-006", "   ", false, at(6))).toThrow(/Write a note/);
    expect(() => D.addLandedNote(s, "EX-006", "x".repeat(4001), false, at(6))).toThrow(/4000/);
  });

  it("needsYou counts flagged unreviewed items and GitHub problems, not plain unreviewed work", () => {
    let s = landedState();
    expect(D.needsYou(s)).toBe(0);
    s = structuredClone(s);
    task(s, "EX-006").integration!.landed!.flags = ["main-check-failed"];
    expect(D.needsYou(s)).toBe(1);
    s = D.markLandedReviewed(s, ["EX-006"], true, at(5));
    expect(D.needsYou(s)).toBe(0);
  });
});

describe("landed: send back", () => {
  it("a fix is a linked bug-fix task seeded with the note and the open findings; it starts unless held", () => {
    let s = landedState();
    // The sample's EX-006 review recorded one open finding.
    expect(D.landedReviews(s, task(s, "EX-006")).map((f) => [f.stepId, f.openFindings, f.provider])).toEqual([["S2", 1, "claude"]]);
    const r = D.sendBackLanded(s, { taskId: "EX-006", kind: "fix", note: "Exported dates are an hour off in summer.", holdBeforeStart: false }, at(5));
    s = r.state;
    expect(r.newId).toBe("EX-006-F1");
    const fix = task(s, r.newId);
    expect(fix).toMatchObject({ followUpOf: "EX-006", holdBeforeStart: false, dependsOn: ["EX-006"], lifecycle: "proposed" });
    expect(fix.revertOf).toBeUndefined();
    expect(fix.steps.map((x) => x.id)).toEqual(templateSteps("bugfix").map((x) => x.id));
    expect(fix.steps.every((x) => x.state === "pending")).toBe(true);
    const c = M.currentSpec(fix).content;
    expect(c.title).toMatch(/^Fix: /);
    expect(c.outcome).toBe("Exported dates are an hour off in summer.");
    expect(c.scopeIncluded.join("\n")).toContain("Open review finding (S2, 1 open)");
    // Linked both ways; the origin is sent back, which is not "reviewed".
    const l = task(s, "EX-006").integration!.landed!;
    expect(l.status).toBe("sent-back");
    expect(l.followUps).toEqual([{ taskId: "EX-006-F1", kind: "fix" }]);
    expect(l.notes.map((n) => n.text)).toEqual(["Exported dates are an hour off in summer."]);
    expect(D.unreviewedCount(s)).toBe(0);
    // Its prerequisite is already done, so it is promoted and dispatched like any task.
    for (const other of s.tasks) if (other.id !== "EX-006-F1") other.hold = true; // keep the worker slots free
    s = M.dispatchEligible(M.leadPromoteProposals(s, at(6)), at(6));
    expect(M.activeAttempts(s, "EX-006-F1").map((a) => a.stepId)).toEqual(["S1"]);

    expect(() => D.sendBackLanded(landedState(), { taskId: "EX-006", kind: "fix", note: " ", holdBeforeStart: false }, at(5))).toThrow(/what needs fixing/);
    expect(() => D.sendBackLanded(seed(), { taskId: "EX-006", kind: "fix", note: "x", holdBeforeStart: false }, at(5))).toThrow(/has not landed/);
  });

  it("a revert task names the landed commit; a second revert is rejected while one is open", () => {
    let s = landedState();
    const r = D.sendBackLanded(s, { taskId: "EX-006", kind: "revert", note: "", holdBeforeStart: true }, at(5));
    s = r.state;
    const rv = task(s, r.newId);
    expect(rv.revertOf).toEqual({ taskId: "EX-006", commit: SHA_A });
    expect(rv.holdBeforeStart).toBe(true);
    expect(rv.steps.map((x) => x.role)).toEqual(["coder", "code_reviewer", "lead"]);
    expect(rv.steps[0].purpose).toContain(`revert of ${SHA_A.slice(0, 12)}`);
    expect(M.currentSpec(rv).content.title).toMatch(/^Revert: /);
    expect(task(s, "EX-006").integration!.landed!.followUps).toEqual([{ taskId: r.newId, kind: "revert" }]);
    // Held before start: not dispatched.
    const held = M.dispatchEligible(M.leadPromoteProposals(s, at(6)), at(6));
    expect(M.activeAttempts(held, r.newId)).toHaveLength(0);

    expect(() => D.sendBackLanded(s, { taskId: "EX-006", kind: "revert", note: "", holdBeforeStart: false }, at(7))).toThrow(new RegExp(`${r.newId} is already reverting`));
    // Once that revert is cancelled, another may be created, with a new id.
    const cancelled = M.cancelTask(s, r.newId, at(8));
    const second = D.sendBackLanded(cancelled, { taskId: "EX-006", kind: "revert", note: "again", holdBeforeStart: false }, at(9));
    expect(second.newId).toBe("EX-006-F2");
    // A fix is still allowed next to an open revert.
    expect(D.sendBackLanded(s, { taskId: "EX-006", kind: "fix", note: "also fix", holdBeforeStart: false }, at(7)).newId).toBe("EX-006-F2");
  });

  it("uses the project's own (edited) template when it has one", () => {
    const s = landedState();
    const tpl = s.project.templates.find((t) => t.id === "revert")!;
    tpl.steps[0].purpose = "Undo it carefully";
    const r = D.sendBackLanded(s, { taskId: "EX-006", kind: "revert", note: "", holdBeforeStart: false }, at(5));
    expect(task(r.state, r.newId).steps[0].purpose).toBe(`Undo it carefully (revert of ${SHA_A.slice(0, 12)})`);
  });
});

describe("createFollowUp", () => {
  /** A Change task driven through one repair round, so its pipeline holds -i2 iteration steps. */
  function expandedDoneTask(): { state: State; id: string } {
    let s = seed();
    s.attempts = [];
    const r = M.createTask(s, { title: "Loop", area: "", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, steps: templateSteps("change"), templateName: "Change" }, at(0));
    s = r.state;
    const id = r.newId;
    for (const other of s.tasks) if (other.id !== id) other.hold = true;
    const go = (t: number) => (s = M.dispatchEligible(M.leadPromoteProposals(s, at(t)), at(t)));
    go(1);
    s = finish(s, id, 2); // S1 implement
    go(3);
    s = finish(s, id, 4, 1); // S2 review: one finding
    go(5);
    s = finish(s, id, 6); // S3 repair → next iteration is added
    go(7);
    s = finish(s, id, 8, 0); // S2-i2 review: clean
    go(9); // S3-i2 skipped, S4 verify dispatched
    s = finish(s, id, 10);
    go(11);
    expect(task(s, id).lifecycle).toBe("done");
    expect(task(s, id).steps.some((x) => /-i2$/.test(x.id))).toBe(true);
    return { state: s, id };
  }

  it("copies the pipeline as it was before expansion: no -iN or -cN steps, all pending", () => {
    const { state, id } = expandedDoneTask();
    const r = M.createFollowUp(state, id, at(20));
    const f = task(r.state, r.newId);
    expect(f.steps.map((x) => x.id)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(f.steps.find((x) => x.id === "S3")!.iterate).toEqual({ from: "S2", max: 3 }); // the loop is whole again
    expect(f.steps.every((x) => x.state === "pending" && x.iteration === undefined && !x.copyOf)).toBe(true);
    expect(f.pipelineHistory[0].steps.map((x) => x.id)).toEqual(["S1", "S2", "S3", "S4"]);
  });

  it("keeps the models the user pinned on the copied steps", () => {
    const { state, id } = expandedDoneTask();
    const s = structuredClone(state);
    task(s, id).steps.find((x) => x.id === "S1")!.selection = { provider: "claude", model: "claude-sample-fast" };
    const r = M.createFollowUp(s, id, at(20));
    expect(task(r.state, r.newId).steps.find((x) => x.id === "S1")!.selection).toEqual({ provider: "claude", model: "claude-sample-fast" });
  });

  it("a follow-up of a follow-up gets a new id, never a duplicate", () => {
    let s = seed();
    const f1 = M.createFollowUp(s, "EX-006", at(1));
    expect(f1.newId).toBe("EX-006-F1");
    s = structuredClone(f1.state);
    task(s, "EX-006-F1").lifecycle = "done";
    const f2 = M.createFollowUp(s, "EX-006-F1", at(2)); // was EX-006-F1 again before the fix
    expect(f2.newId).toBe("EX-006-F2");
    const f3 = M.createFollowUp(f2.state, "EX-006", at(3));
    expect(f3.newId).toBe("EX-006-F3");
    const ids = f3.state.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(task(f3.state, "EX-006-F2").followUpOf).toBe("EX-006-F1");
  });

  it("holds before start by default and honours the option", () => {
    const s = seed();
    expect(task(M.createFollowUp(s, "EX-006", at(1)).state, "EX-006-F1").holdBeforeStart).toBe(true);
    const r = M.createFollowUp(s, "EX-006", at(1), { holdBeforeStart: false, steps: templateSteps("bugfix"), author: "system", dependsOn: [], fields: { revertOf: { taskId: "EX-006", commit: SHA_A } } });
    const f = task(r.state, r.newId);
    expect(f).toMatchObject({ holdBeforeStart: false, dependsOn: [], revertOf: { taskId: "EX-006", commit: SHA_A } });
    expect(f.specs[0].author).toBe("system");
    expect(f.steps.map((x) => x.id)).toEqual(templateSteps("bugfix").map((x) => x.id));
  });
});
