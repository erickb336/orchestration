// ORC-008 step 1, pure: the data model defaults, delivery-mode exclusivity, the review-later queue,
// and the follow-up fixes. Nothing here touches git or GitHub. (Notification keys: src/ui/notifications.test.ts.)

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as D from "./delivery";
import * as M from "./model";
import { diffLineClasses } from "./diff";
import { buildEmptyProject, buildSeed } from "./seed";
import { BUILT_IN_TEMPLATES, templateSteps } from "./templates";
import { reviewedChange, type ReviewedOptions } from "./testing/reviewed";
import { ControlError, DEFAULT_PR_DELIVERY, type CheckObs, type Integration, type PrDelivery, type State } from "./types";

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
  it("a new project is format 14 with pull-request delivery off and nothing observed", () => {
    for (const s of [seed(), buildEmptyProject(T0)]) {
      expect(s.version).toBe(14);
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
    // ORC-013: a Final checks step (run by the service) sits between the review and the verification.
    expect(templateSteps("revert").map((s) => s.role)).toEqual(["coder", "code_reviewer", "checks", "lead"]);
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

  it("the command switches pull-request delivery on, asks only for a read-only check, and never chooses automatic merging", () => {
    const on = runCommand(seed(), "setDeliveryMode", { mode: "pr" }, at(1)).state;
    expect(D.deliveryMode(on)).toBe("pr");
    expect(on.project.github).toMatchObject({ ok: false, recheck: true });
    expect(on.project.prDelivery.merge).toBe("hold");
    expect(D.nextPrOp(on, T0 + 2000)).toMatchObject({ kind: "preflight" });
    // Automatic merging is a separate, explicit choice: a command the user sends, never a side effect.
    expect(runCommand(on, "setPrDelivery", { config: { merge: "auto" } }, at(2)).state.project.prDelivery.merge).toBe("auto");
    expect(M.applyAutopilot(on, "main", at(2)).project.prDelivery).toMatchObject({ enabled: true, merge: "hold" });
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
    expect(rv.steps.map((x) => x.role)).toEqual(["coder", "code_reviewer", "checks", "lead"]);
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
    // The revert template is built in but not one of the project's pickable templates.
    expect(s.project.templates.some((t) => t.id === "revert")).toBe(false);
    expect(() => runCommand(M.saveTemplate(s, structuredClone(BUILT_IN_TEMPLATES.find((t) => t.id === "revert")!), null, at(4)), "createTask", { title: "t", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, templateId: "revert" }, at(5))).toThrow(/Send back only/);
    const tpl = structuredClone(BUILT_IN_TEMPLATES.find((t) => t.id === "revert")!);
    tpl.steps[0].purpose = "Undo it carefully";
    s.project.templates.push(tpl);
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
    // ORC-013: the Change template carries the Checks steps C1 (in the loop) and C2 (final).
    expect(f.steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "S3", "C2", "S4"]);
    expect(f.steps.find((x) => x.id === "S3")!.iterate).toEqual({ from: "C1", max: 3 }); // the loop is whole again
    expect(f.steps.every((x) => x.state === "pending" && x.iteration === undefined && !x.copyOf)).toBe(true);
    expect(f.pipelineHistory[0].steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "S3", "C2", "S4"]);
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

// ====================================================================================================
// Step 2: pull-request delivery, hold and notify (pure)
// ====================================================================================================

const HEAD = "c".repeat(40);
const MERGE = "d".repeat(40);
const ms = (s: number) => T0 + s * 1000;
const check = (conclusion: string | null, name = "check", required = true): CheckObs => ({ name, required, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion });
const observation = (over: Partial<D.PrObservation> = {}): D.PrObservation => ({
  number: 12,
  state: "OPEN",
  isDraft: false,
  crossRepo: false,
  url: "https://github.com/o/r/pull/12",
  headRef: "orchestration/sample/pr/EX-006-1",
  headSha: HEAD,
  baseRef: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  labels: [],
  checks: [check("SUCCESS")],
  checksFor: HEAD,
  ...over,
});
const prOf = (s: State, id = "EX-006"): PrDelivery => task(s, id).integration!.pr!;

/** Pull-request delivery on, the repository checked and its base fetched. */
function prMode(requiredChecks = ["check"]): State {
  let s = D.setDeliveryMode(seed(), { mode: "pr" }, at(0));
  s.attempts = [];
  // The sample's other open tasks are held, so nothing but the task under test asks for a fresh base.
  for (const t of s.tasks) if (t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
  s = D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks, autoMergeBlockers: [], posture: [] }, at(1));
  return D.reportBaseFetched(s, SHA_A, at(2));
}
/** The next operation at `second`, with the base just fetched (so the periodic fetch is not what is planned). */
const planned = (s: State, second: number) => D.nextPrOp(D.reportBaseFetched(s, SHA_A, at(second - 1)), ms(second));

/**
 * EX-006 done with its head prepared as a pull request (phase "built"). Its own pipeline reviewed
 * exactly that change, clean, on the other provider (`review: null` leaves the task without one).
 */
function built(s = prMode(), id = "EX-006", sha = HEAD, changed: Partial<PrDelivery["changed"]> = {}, review: ReviewedOptions | null = {}): State {
  const next = review ? reviewedChange(s, id, sha, at(2), review) : structuredClone(s);
  task(next, id).lifecycle = "done";
  task(next, id).integration = { status: "pending" };
  return D.reportPrHead(next, id, { n: 1, sha, baseSha: SHA_A, changed: { files: 1, additions: 1, deletions: 0, paths: ["a.txt"], protectedHits: [], workflowHits: [], ...changed } }, at(3));
}

/** …published as PR #12 and observed once at second 20. */
function opened(obs: Partial<D.PrObservation> = {}, s = built()): State {
  const op = D.nextPrOp(s, ms(10))!;
  expect(op.kind).toBe("publish");
  const begun = D.beginPrOp(s, op, at(10));
  expect(begun.started).toBe(true);
  const open = D.reportPrOp(begun.state, { op, published: { number: 12, url: "https://github.com/o/r/pull/12" } }, at(11));
  return D.reportObservations(open, { prs: [observation(obs)], commits: [], rateRemaining: 5000 }, at(20));
}
const gate = (s: State, atSecond = 21, byUser = true) => D.prGate(s, task(s, "EX-006"), ms(atSecond), { byUser });
const item = (s: State, id: D.GateItem["id"], atSecond = 21) => gate(s, atSecond).items.find((i) => i.id === id)!;
const requested = (s: State) => D.requestPrMerge(s, "EX-006", HEAD, at(21));

describe("pull-request settings", () => {
  it("validates ranges, keeps the mode, and asks for a new check when the remote or base changes", () => {
    const s = prMode();
    expect(() => D.setPrDelivery(s, { maxOpenPrs: 0 }, at(3))).toThrow(/between 1 and 20/);
    expect(() => D.setPrDelivery(s, { remote: "bad remote" }, at(3))).toThrow(/valid remote/);
    expect(() => D.setPrDelivery(s, { base: "bad branch" }, at(3))).toThrow(/valid base/);
    expect(() => D.setPrDelivery(s, { protectedPaths: Array.from({ length: 21 }, (_, i) => `p${i}`) }, at(3))).toThrow(/At most 20/);
    expect(() => D.setPrDelivery(s, { merge: "sometimes" } as never, at(3))).toThrow(/hold or auto/);
    expect(() => D.setPrDelivery(s, { remote: "-origin" }, at(3))).toThrow(/valid remote/); // never read as an option
    expect(() => D.setPrDelivery(s, { base: "-f" }, at(3))).toThrow(/valid base/);
    expect(D.setPrDelivery(s, {}, at(3))).toBe(s);
    const next = D.setPrDelivery(s, { base: "release", maxOpenPrs: 2, enabled: false } as never, at(3));
    expect(next.project.prDelivery).toMatchObject({ enabled: true, base: "release", maxOpenPrs: 2, merge: "hold" });
    expect(next.project.github).toMatchObject({ recheck: true });
    expect(next.project.github!.base).toBeUndefined(); // writers wait for the new base
    expect(D.writersHeld(next)).toBe("waiting for the first fetch of origin/release");
  });

  it("protected-path globs", () => {
    expect(D.matchGlob(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(D.matchGlob("package.json", "package.json")).toBe(true);
    expect(D.matchGlob("package.json", "web/package.json")).toBe(false);
    expect(D.matchGlob("**/package.json", "web/package.json")).toBe(true);
    expect(D.matchGlob("**/package.json", "package.json")).toBe(true);
    expect(D.matchGlob("tsconfig*.json", "tsconfig.server.json")).toBe(true);
    expect(D.matchGlob("tsconfig*.json", "src/tsconfig.json")).toBe(false);
    expect(D.matchGlob("vite.config.*", "vite.config.ts")).toBe(true);
    expect(D.matchGlob("a.b", "aXb")).toBe(false);
  });
});

describe("prGate (items 1–8 and 13)", () => {
  it("ready only with the user's merge request for this head, a required check passed on it, and GitHub reporting it clean", () => {
    const s = opened();
    expect(gate(s).status).toBe("waiting");
    expect(gate(s).items.filter((i) => !i.ok).map((i) => i.id)).toEqual(["policy"]);
    expect(D.prReady(s, task(s, "EX-006"), ms(21))).toBe(true);
    expect(D.needsYou(s, ms(21))).toBe(1);
    expect(gate(requested(s)).status).toBe("ready");
    // The review is shown to the user and does not gate their own merge.
    expect(gate(requested(s)).items.map((i) => i.id)).toEqual(["policy", "not-paused", "github", "ours", "head", "checks", "mergeable", "no-stop", "review", "attempts"]);
    expect(item(s, "review")).toMatchObject({ ok: true, advisory: true });
    // A pull request that is held never passes the automatic gate: its policy says the user merges.
    expect(gate(s, 21, false).status).toBe("waiting");
    expect(gate(s, 21, false).items[0]).toMatchObject({ id: "policy", ok: false });
    expect(D.mergeCandidate(s)).toBeUndefined();
  });

  it("1: a merge request for another head does not count, and cannot be made", () => {
    const s = opened();
    expect(() => D.requestPrMerge(s, "EX-006", SHA_B, at(21))).toThrow(/changed since you looked/);
    const stale = structuredClone(requested(s));
    prOf(stale).mergeRequested!.headSha = SHA_B;
    expect(item(stale, "policy").ok).toBe(false);
  });

  it("2: a project pause, a hold and a close request each stop it", () => {
    const s = requested(opened());
    expect(item(M.pauseProject(s, at(22)), "not-paused")).toMatchObject({ ok: false, state: "waiting" });
    expect(item(D.holdPr(s, "EX-006", "later", at(22)), "not-paused").detail).toContain("later");
    expect(item(D.closePr(s, "EX-006", at(22)), "not-paused").ok).toBe(false);
  });

  it("3: GitHub must be reachable and the repository check at most 6 hours old", () => {
    const s = requested(opened());
    expect(item(s, "github", 6 * 3600 + 10).ok).toBe(false);
    const broken = D.reportPrOp(s, { op: { id: "x", kind: "observe", prs: [], commits: [] }, error: { code: "auth", message: "HTTP 401" } }, at(22));
    expect(broken.project.github).toMatchObject({ ok: false, problem: { code: "auth" } });
    expect(item(broken, "github").ok).toBe(false);
    expect(gate(broken).status).toBe("waiting");
  });

  it("4: it must be the app's own open pull request: not a draft, not retargeted, not from another repository", () => {
    expect(item(opened({ isDraft: true }), "ours")).toMatchObject({ state: "blocked", code: "draft" });
    expect(item(opened({ baseRef: "release" }), "ours")).toMatchObject({ state: "blocked", code: "base-changed" });
    expect(item(opened({ crossRepo: true }), "ours")).toMatchObject({ state: "blocked" });
    expect(prOf(opened({ isDraft: true })).attention).toMatchObject({ code: "draft" });
  });

  it("5: another head on GitHub is a sticky hold", () => {
    const s = opened({ headSha: SHA_B, checksFor: SHA_B });
    expect(prOf(s).foreignHead).toEqual({ sha: SHA_B, at: at(20) });
    expect(prOf(s).attention).toMatchObject({ code: "foreign-push" });
    expect(gate(s).status).toBe("blocked");
    // Even if the branch is put back, the app does not act on it again.
    const back = D.reportObservations(s, { prs: [observation()], commits: [] }, at(200));
    expect(prOf(back).foreignHead).toEqual({ sha: SHA_B, at: at(20) });
    expect(gate(back).status).toBe("blocked");
    expect(D.nextPrOp(D.closePr(back, "EX-006", at(201)), ms(204))).toMatchObject({ kind: "close" }); // closing is still possible
  });

  it("6: required checks must have passed on exactly this head", () => {
    // ORC-013 §7.2: every non-success blocks; the reason names its class (a cancelled run with no job id cannot be re-run).
    const codes: Record<string, string> = { FAILURE: "checks-failed", ERROR: "checks-failed", TIMED_OUT: "checks-failed", ACTION_REQUIRED: "checks-failed", CANCELLED: "ci-infra", SKIPPED: "checks-skipped", NEUTRAL: "checks-skipped" };
    for (const [c, code] of Object.entries(codes)) {
      const s = opened({ checks: [check(c)] });
      expect(item(s, "checks"), c).toMatchObject({ ok: false, state: "blocked", code });
      expect(gate(requested(s)).status, c).toBe("blocked");
    }
    // Pending, then a timeout the user is told about.
    const pending = opened({ checks: [check(null)] });
    expect(item(pending, "checks")).toMatchObject({ ok: false, state: "waiting" });
    expect(item(pending, "checks", 20 + 61 * 60)).toMatchObject({ state: "blocked", code: "checks-timeout" });
    // Missing entirely.
    const missing = opened({ checks: [] });
    expect(item(missing, "checks")).toMatchObject({ ok: false, state: "waiting" });
    expect(item(missing, "checks", 20 + 16 * 60)).toMatchObject({ state: "blocked", code: "checks-missing" });
    // Results for another commit do not count.
    expect(item(opened({ checksFor: SHA_B }), "checks")).toMatchObject({ ok: false, state: "waiting" });
    // Another check passing is not the required one passing.
    expect(item(opened({ checks: [check("SUCCESS", "lint", false)] }), "checks").ok).toBe(false);
    // A check GitHub itself marks required counts even if the rules did not list it.
    expect(item(opened({ checks: [check("SUCCESS"), check("FAILURE", "extra", true)] }), "checks")).toMatchObject({ state: "blocked" });
    // A repository with no required check: the app does not merge.
    const none = opened({ checks: [check("SUCCESS", "lint", false)] }, built(prMode([])));
    expect(item(none, "checks")).toMatchObject({ ok: false, state: "blocked", code: "checks-missing" });
    expect(gate(requested(none)).status).toBe("blocked");
  });

  it("7: GitHub's own view decides too; UNKNOWN is never merged", () => {
    expect(item(opened({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }), "mergeable")).toMatchObject({ ok: false, state: "waiting" });
    expect(item(opened({ mergeStateStatus: "UNKNOWN" }), "mergeable")).toMatchObject({ ok: false, state: "waiting" });
    expect(item(opened({ mergeable: "UNKNOWN" }), "mergeable")).toMatchObject({ ok: false, state: "waiting" }); // even if the state still reads clean
    expect(D.nextPrOp(requested(opened({ mergeable: "UNKNOWN" })), ms(23))).toBeUndefined();
    expect(gate(requested(opened({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))).status).toBe("waiting");
    expect(item(opened({ mergeStateStatus: "HAS_HOOKS" }), "mergeable").ok).toBe(true);
    expect(item(opened({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), "mergeable")).toMatchObject({ state: "blocked", code: "conflict" });
    const unstable = opened({ mergeStateStatus: "UNSTABLE" });
    expect(item(unstable, "mergeable")).toMatchObject({ state: "waiting" });
    expect(item(unstable, "mergeable", 20 + 31 * 60)).toMatchObject({ state: "blocked", code: "non-required-failing" });
    expect(item(opened({ mergeStateStatus: "BEHIND" }), "mergeable")).toMatchObject({ state: "blocked", code: "github-blocked" });
    // BLOCKED while the checks run is just waiting; with green checks it is an approval the app cannot give.
    expect(item(opened({ mergeStateStatus: "BLOCKED", checks: [check(null)] }), "mergeable")).toMatchObject({ state: "waiting" });
    const approval = opened({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
    expect(item(approval, "mergeable")).toMatchObject({ state: "blocked", code: "approval-required" });
    expect(prOf(approval).attention!.message).toContain("require_extra_approval_for_unattributed_changes");
    const blocked = opened({ mergeStateStatus: "BLOCKED" });
    expect(item(blocked, "mergeable")).toMatchObject({ state: "waiting" });
    expect(item(blocked, "mergeable", 20 + 11 * 60)).toMatchObject({ state: "blocked", code: "github-blocked" });
  });

  it("8: requested changes and the orchestration:hold label stop it from any device", () => {
    expect(item(opened({ reviewDecision: "CHANGES_REQUESTED" }), "no-stop")).toMatchObject({ state: "blocked", code: "changes-requested" });
    expect(item(opened({ labels: ["orchestration:hold"] }), "no-stop")).toMatchObject({ state: "blocked", code: "hold-label" });
    expect(item(opened({ labels: ["bug"] }), "no-stop").ok).toBe(true);
  });

  it("13: two refused merges for a head, then the user", () => {
    const s = structuredClone(requested(opened()));
    prOf(s).counters.mergeAttempts = 2;
    expect(item(s, "attempts")).toMatchObject({ ok: false, state: "blocked", code: "merge-rejected" });
    expect(gate(s).status).toBe("blocked");
  });
});

describe("nextPrOp and beginPrOp", () => {
  it("nothing is planned while pull-request delivery is off and nothing is tracked", () => {
    expect(D.nextPrOp(seed(), T0)).toBeUndefined();
    expect(D.nextPrOp(D.setDeliveryMode(seed(), { mode: "local" }, at(0)), T0)).toBeUndefined();
  });

  it("order: repository check, first fetch, then publish; observation before writes; one merge only on a fresh observation", () => {
    let s = D.setDeliveryMode(seed(), { mode: "pr" }, at(0));
    s.attempts = [];
    for (const t of s.tasks) if (t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
    expect(D.nextPrOp(s, ms(1))).toMatchObject({ kind: "preflight" });
    s = D.reportPreflight(s, { ok: true, repo: "o/r", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(1));
    expect(D.nextPrOp(s, ms(2))).toMatchObject({ kind: "fetch" });
    s = D.reportBaseFetched(s, SHA_A, at(2));
    expect(D.nextPrOp(s, ms(3))).toBeUndefined();
    s = built(s);
    expect(D.nextPrOp(s, ms(4))).toMatchObject({ kind: "publish", taskId: "EX-006", n: 1, headSha: HEAD });

    const open = opened({}, s);
    // Just observed: nothing to do. Two minutes later: observe again.
    expect(D.nextPrOp(open, ms(25))).toBeUndefined();
    expect(D.nextPrOp(open, ms(20 + 121))).toMatchObject({ kind: "observe", prs: [{ taskId: "EX-006", number: 12 }] });
    // A merge request: on a fresh observation it merges; on an older one GitHub is read again first.
    const want = requested(open);
    expect(D.nextPrOp(want, ms(23))).toMatchObject({ kind: "merge", taskId: "EX-006", headSha: HEAD });
    expect(D.nextPrOp(want, ms(20 + 16))).toMatchObject({ kind: "observe" });
    expect(D.beginPrOp(want, D.nextPrOp(want, ms(23))!, at(20 + 16)).started).toBe(false); // too old by the time it would start
    // The gate not ready: the merge is not planned, only the faster observation.
    const red = requested(opened({ checks: [check(null)] }, s));
    expect(D.nextPrOp(red, ms(23))).toBeUndefined();
    expect(D.nextPrOp(red, ms(20 + 31))).toMatchObject({ kind: "observe" });
  });

  it("writes are paced (2 s apart, 200 an hour) and bounded by the open pull-request cap", () => {
    let s = built(built(prMode(), "EX-006"), "EX-005", SHA_B);
    const first = D.nextPrOp(s, ms(10))!;
    s = D.beginPrOp(s, first, at(10)).state;
    s = D.reportPrOp(s, { op: first, published: { number: 12, url: "https://github.com/o/r/pull/12" } }, at(10));
    s = D.reportObservations(s, { prs: [observation()], commits: [] }, at(10));
    expect(D.nextPrOp(s, ms(11))).toBeUndefined(); // 1 s after the last write
    const second = D.nextPrOp(s, ms(12))!;
    expect(second).toMatchObject({ kind: "publish" });
    expect(second.id).not.toBe(first.id);
    expect(D.beginPrOp(s, second, at(11)).started).toBe(false);
    const capped = D.setPrDelivery(s, { maxOpenPrs: 1 }, at(12));
    expect(D.nextPrOp(capped, ms(13))).toBeUndefined();
    expect(D.beginPrOp(capped, second, at(13)).started).toBe(false);
    const spent = structuredClone(s);
    spent.project.github!.mutations = { hour: at(12).slice(0, 13), count: 200 };
    expect(D.nextPrOp(spent, ms(12))).toBeUndefined();
    expect(D.beginPrOp(spent, second, at(12)).started).toBe(false);
  });

  it("a project pause allows only the read-only check, the fetch and observation", () => {
    const s = M.pauseProject(requested(opened()), at(22));
    expect(D.nextPrOp(s, ms(23))).toBeUndefined();
    expect(D.nextPrOp(s, ms(20 + 31))).toBeUndefined(); // observation slows to every 5 minutes
    expect(D.nextPrOp(s, ms(20 + 301))).toMatchObject({ kind: "observe" });
    expect(D.nextPrOp(M.pauseProject(built(), at(4)), ms(10))).toBeUndefined();
    // …and a publish planned just before the pause is refused when its intent would be recorded.
    const publish = D.nextPrOp(built(), ms(10))!;
    expect(publish.kind).toBe("publish");
    expect(D.beginPrOp(built(), publish, at(10)).started).toBe(true);
    expect(D.beginPrOp(M.pauseProject(built(), at(4)), publish, at(10)).started).toBe(false);
    const fresh = D.reportObservations(s, { prs: [observation()], commits: [] }, at(400));
    expect(D.nextPrOp(fresh, ms(401))).toBeUndefined();
    expect(D.nextPrOp(M.resumeProject(fresh, at(402)), ms(403))).toMatchObject({ kind: "merge" });
  });

  it("beginPrOp refuses when a hold, a pause or a new head landed after planning", () => {
    const s = requested(opened());
    const op = D.nextPrOp(s, ms(23))!;
    expect(op.kind).toBe("merge");
    expect(D.beginPrOp(s, op, at(23))).toMatchObject({ started: true });
    expect(D.beginPrOp(D.holdPr(s, "EX-006", undefined, at(23)), op, at(23))).toMatchObject({ started: false });
    expect(D.beginPrOp(M.pauseProject(s, at(23)), op, at(23))).toMatchObject({ started: false });
    expect(D.beginPrOp(D.closePr(s, "EX-006", at(23)), op, at(23))).toMatchObject({ started: false });
    expect(D.beginPrOp(D.setDeliveryMode(s, { mode: "off" }, at(23)), op, at(23))).toMatchObject({ started: false });
    expect(D.beginPrOp(D.reportObservations(s, { prs: [observation({ checks: [check("FAILURE")] })], commits: [] }, at(23)), op, at(23))).toMatchObject({ started: false });
    expect(D.beginPrOp(s, { ...op, headSha: SHA_B } as D.PrOp, at(23))).toMatchObject({ started: false });
    const refused = D.beginPrOp(M.pauseProject(s, at(23)), op, at(23));
    expect(refused.state.tasks.find((t) => t.id === "EX-006")!.integration!.pr!.op).toBeUndefined(); // no intent, so nothing starts
    // The recorded intent carries the head and counts as a write.
    const begun = D.beginPrOp(s, op, at(23)).state;
    expect(prOf(begun).op).toEqual({ id: op.id, kind: "merge", at: at(23), headSha: HEAD });
    expect(begun.project.github).toMatchObject({ lastMutationAt: at(23), mutations: { count: 2 } });
  });

  it("an interrupted intent is reconciled only after its timeout and grace time, and never by acting blindly", () => {
    const s = requested(opened());
    const op = D.nextPrOp(s, ms(23))!;
    const begun = D.beginPrOp(s, op, at(23)).state; // …and the service dies here
    const grace = (D.OP_TIMEOUT_MS.merge + D.PR_LIMITS.graceMs) / 1000;
    expect(D.nextPrOp(begun, ms(23 + 20))).toBeUndefined(); // an orphan may still be merging: wait
    expect(D.beginPrOp(begun, { ...op, id: "again" }, at(23 + 20)).started).toBe(false);
    expect(D.nextPrOp(begun, ms(23 + grace + 1))).toMatchObject({ kind: "observe" }); // look, do not merge again
    // Still inside the grace time an observation of OPEN proves nothing.
    const early = D.reportObservations(begun, { prs: [observation()], commits: [] }, at(23 + 40));
    expect(prOf(early).op).toBeDefined();
    // After it: still open means the merge did not happen. The intent is cleared. Nothing says GitHub
    // refused it, so it is not counted as a refusal and is tried again.
    const open = D.reportObservations(begun, { prs: [observation()], commits: [] }, at(23 + grace + 2));
    expect(prOf(open).op).toBeUndefined();
    expect(prOf(open).counters.mergeAttempts).toBe(0);
    expect(prOf(open).mergeRequested).toBeDefined();
    expect(task(open, "EX-006").integration!.landed).toBeUndefined();
    // Merged: it landed, and the intent shows the app asked for it.
    const merged = D.reportObservations(begun, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "me" })], commits: [] }, at(23 + grace + 2));
    expect(task(merged, "EX-006").integration).toMatchObject({ pr: { phase: "merged" }, landed: { by: "app", commit: MERGE, via: "pr", target: "o/r main" } });
  });

  it("a known problem allows only the repository check, backing off; a rate limit waits for its reset", () => {
    const s = opened();
    const failed = D.reportPrOp(s, { op: { id: "x", kind: "observe", prs: [], commits: [] }, error: { code: "auth", message: "HTTP 401" } }, at(30));
    // Nothing but the repository check, at most every 5 minutes (it was last checked at second 1).
    expect(D.nextPrOp(failed, ms(31))).toBeUndefined();
    expect(D.nextPrOp(requested(failed), ms(200))).toBeUndefined();
    expect(D.nextPrOp(failed, ms(302))).toMatchObject({ kind: "preflight" });
    const again = D.reportPreflight(failed, { ok: false, problem: { code: "auth", message: "sign in" }, requiredChecks: [], autoMergeBlockers: [], posture: [] }, at(302));
    expect(again.project.github!.problem!.since).toBe(at(30)); // one problem, not a new one per check
    expect(again.events.filter((e) => e.message.startsWith("GitHub delivery stopped"))).toHaveLength(1);
    expect(D.nextPrOp(again, ms(302 + 299))).toBeUndefined();
    expect(D.nextPrOp(again, ms(302 + 301))).toMatchObject({ kind: "preflight" });
    // The wait grows with the age of the problem, up to 30 minutes.
    const later = D.reportPreflight(again, { ok: false, problem: { code: "auth", message: "sign in" }, requiredChecks: [], autoMergeBlockers: [], posture: [] }, at(30 + 3 * 3600));
    expect(D.nextPrOp(later, ms(30 + 3 * 3600 + 29 * 60))).toBeUndefined();
    expect(D.nextPrOp(later, ms(30 + 3 * 3600 + 31 * 60))).toMatchObject({ kind: "preflight" });
    expect(D.nextPrOp(D.recheckGitHub(again, at(310)), ms(311))).toMatchObject({ kind: "preflight" }); // Check again
    const limited = D.reportPrOp(s, { op: { id: "x", kind: "observe", prs: [], commits: [] }, error: { code: "rate-limit", message: "limit", retryAt: at(900) } }, at(30));
    expect(D.nextPrOp(limited, ms(899))).toBeUndefined();
    expect(D.nextPrOp(limited, ms(901))).toMatchObject({ kind: "preflight" });
    const ok = D.reportPreflight(limited, { ok: true, repo: "o/r", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(902));
    expect(ok.project.github).toMatchObject({ ok: true });
    expect(ok.project.github!.problem).toBeUndefined();
    expect(ok.project.github!.base).toEqual({ sha: SHA_A, fetchedAt: at(2) }); // what was fetched is kept
  });
});

describe("observations are the only source of merged, closed and posted", () => {
  it("MERGED without a merge commit records nothing; with one it lands, by a person unless the app's intent existed", () => {
    const s = opened();
    const bare = D.reportObservations(s, { prs: [observation({ state: "MERGED" })], commits: [] }, at(30));
    expect(prOf(bare).phase).toBe("open");
    expect(task(bare, "EX-006").integration!.landed).toBeUndefined();
    const merged = D.reportObservations(s, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" })], commits: [] }, at(30));
    expect(task(merged, "EX-006").integration!.landed).toEqual({
      at: at(30),
      via: "pr",
      target: "o/r main",
      commit: MERGE,
      by: "person",
      mergedBy: "octocat",
      pr: { number: 12, url: "https://github.com/o/r/pull/12", repo: "o/r" },
      review: prOf(s).review,
      checks: [check("SUCCESS")],
      mainCheck: { state: "pending", at: at(30) },
      flags: [],
      status: "unreviewed",
      notes: [],
      followUps: [],
    });
    expect(D.unreviewedCount(merged)).toBe(1);
    // Merged past a failing check: flagged.
    const dirty = D.reportObservations(s, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, checks: [check("FAILURE")] })], commits: [] }, at(30));
    expect(task(dirty, "EX-006").integration!.landed!.flags).toEqual(["merged-without-clean-gate"]);
    expect(D.needsYou(dirty, ms(31))).toBe(1);
    // A later observation of the same pull request changes nothing (it is no longer watched).
    expect(D.reportObservations(merged, { prs: [observation({ state: "CLOSED" })], commits: [] }, at(40)).tasks).toEqual(merged.tasks);
    // What follows a merge: the base is fetched again, and only the check on the base is still watched.
    expect(D.nextPrOp(merged, ms(95))).toMatchObject({ kind: "fetch" });
    expect(planned(merged, 95)).toMatchObject({ kind: "observe", prs: [], commits: [MERGE] });
  });

  it("the check on the base after a merge is recorded; a failure is flagged; silence becomes unknown after two hours", () => {
    const merged = D.reportObservations(opened(), { prs: [observation({ state: "MERGED", mergeCommit: MERGE })], commits: [] }, at(30));
    const landed = (s: State) => task(s, "EX-006").integration!.landed!;
    const pending = D.reportObservations(merged, { prs: [], commits: [{ oid: MERGE, checks: [check(null)] }] }, at(90));
    expect(landed(pending).mainCheck).toEqual({ state: "pending", at: at(30) });
    expect(landed(D.reportObservations(merged, { prs: [], commits: [{ oid: MERGE, checks: [check("SUCCESS")] }] }, at(90))).mainCheck).toEqual({ state: "success", at: at(90) });
    const red = D.reportObservations(merged, { prs: [], commits: [{ oid: MERGE, checks: [check("FAILURE")] }] }, at(90));
    expect(landed(red)).toMatchObject({ mainCheck: { state: "failure" }, flags: ["main-check-failed"], status: "unreviewed" });
    expect(red.project.github!.autoMergePaused).toBeUndefined(); // the pause and breaker belong to automatic merging
    expect(landed(D.reportObservations(merged, { prs: [], commits: [] }, at(30 + 2 * 3600 + 1))).mainCheck!.state).toBe("unknown");
  });

  it("a comment is posted only with its address, tried three times, and can be tried again", () => {
    let s = D.reportObservations(opened(), { prs: [observation({ state: "MERGED", mergeCommit: MERGE })], commits: [] }, at(30));
    s = D.reportObservations(s, { prs: [], commits: [{ oid: MERGE, checks: [check("SUCCESS")] }] }, at(30)); // nothing left to watch
    s = D.addLandedNote(s, "EX-006", "Check the naming.", true, at(31));
    const noteId = task(s, "EX-006").integration!.landed!.notes[0].id;
    const note = (x: State) => task(x, "EX-006").integration!.landed!.notes[0].comment!;
    const op = planned(s, 40)!;
    expect(op).toMatchObject({ kind: "comment", taskId: "EX-006", noteId });
    expect(planned(M.pauseProject(s, at(39)), 40)).toBeUndefined();
    const begun = D.beginPrOp(s, op, at(40));
    expect(begun.started).toBe(true);
    expect(note(begun.state)).toEqual({ status: "pending", attempts: 1 });
    // No address: not posted.
    expect(note(D.reportPrOp(begun.state, { op, comment: { url: "" } }, at(41))).status).toBe("pending");
    expect(note(D.reportPrOp(begun.state, { op, comment: { url: "https://github.com/o/r/pull/12#issuecomment-1" } }, at(41)))).toEqual({ status: "posted", url: "https://github.com/o/r/pull/12#issuecomment-1", attempts: 1 });
    // Three failures, then it waits for the user.
    let f = begun.state;
    for (let i = 1; i <= 3; i++) {
      f = D.reportPrOp(f, { op, error: { code: "unknown", message: "boom" } }, at(41 + i * 1000));
      if (i < 3) {
        expect(note(f)).toMatchObject({ status: "pending", attempts: i });
        expect(planned(f, 42 + i * 1000)).toBeUndefined(); // backing off
        const next = planned(f, 41 + i * 1000 + 600)!;
        expect(next.kind).toBe("comment");
        f = D.beginPrOp(f, next, at(41 + i * 1000 + 600)).state;
      }
    }
    expect(note(f)).toEqual({ status: "failed", error: "boom", attempts: 3 });
    expect(planned(f, 10_000)).toBeUndefined();
    const retried = D.retryLandedComment(f, "EX-006", noteId, at(10_000));
    expect(note(retried)).toEqual({ status: "pending", attempts: 0 });
    expect(planned(retried, 10_001)).toMatchObject({ kind: "comment" });
    expect(() => D.retryLandedComment(retried, "EX-006", noteId, at(10_002))).toThrow(/still waiting/);
  });

  it("a recorded pull request address is always a github.com address", () => {
    const s = built();
    const op = D.nextPrOp(s, ms(10))!;
    const open = D.reportPrOp(D.beginPrOp(s, op, at(10)).state, { op, published: { number: 12, url: "javascript:alert(1)" } }, at(11));
    expect(prOf(open).url).toBe("https://github.com/o/r/pull/12");
    const draft = structuredClone(landedState());
    const t = task(draft, "EX-005");
    t.lifecycle = "done";
    t.integration = { status: "integrated" };
    D.recordLanded(draft, t, { via: "pr", target: "o/r main", commit: MERGE, by: "person", pr: { number: 3, url: "https://evil.example/pull/3" } }, at(9));
    expect(t.integration.landed!.pr).toEqual({ number: 3, url: "" });
  });
});

describe("dependencies in pull-request mode", () => {
  const dependent = (s: State) => {
    const r = M.createFollowUp(s, "EX-006", at(50), { holdBeforeStart: false });
    return { state: r.state, id: r.newId };
  };

  it("a dependent waits for the prerequisite's merge and the fetch after it", () => {
    const open = opened();
    const d = dependent(open);
    expect(M.waitingOn(d.state, task(d.state, d.id))).toBe("EX-006");
    expect(M.waitingDetail(d.state, "EX-006")).toBe("Waiting for EX-006's PR #12 to merge");
    expect(M.stateLabel(d.state, task(d.state, d.id))).toBe("Waiting on EX-006");
    expect(task(M.leadPromoteProposals(d.state, at(51)), d.id).lifecycle).toBe("proposed");
    const merged = D.reportObservations(d.state, { prs: [observation({ state: "MERGED", mergeCommit: MERGE })], commits: [] }, at(60));
    expect(M.waitingOn(merged, task(merged, d.id))).toBe("EX-006"); // merged, not fetched yet
    expect(M.waitingDetail(merged, "EX-006")).toMatch(/merged; waiting for the next fetch of origin\/main/);
    expect(D.nextPrOp(merged, ms(63))).toMatchObject({ kind: "fetch" });
    const fetched = D.reportBaseFetched(merged, MERGE, at(64));
    expect(M.waitingOn(fetched, task(fetched, d.id))).toBeUndefined();
    expect(task(M.leadPromoteProposals(fetched, at(65)), d.id).lifecycle).toBe("ready");
    // Without pull-request delivery, done is enough (unchanged behaviour).
    expect(M.waitingOn(D.setDeliveryMode(d.state, { mode: "off" }, at(51)), task(d.state, d.id))).toBeUndefined();
  });

  it("work integrated before pull-request delivery was switched on, and tasks with nothing to deliver, do not hold dependents", () => {
    const before = D.setDeliveryMode(integrated(seed(), "EX-006"), { mode: "pr" }, at(1));
    expect(M.prerequisiteReady(before, task(before, "EX-006"))).toBe(true);
    const none = integrated(prMode(), "EX-006", { status: "not-needed", sha: undefined, ref: undefined });
    expect(M.prerequisiteReady(none, task(none, "EX-006"))).toBe(true);
    const pending = integrated(prMode(), "EX-006", { status: "pending" });
    expect(M.prerequisiteReady(pending, task(pending, "EX-006"))).toBe(false);
    expect(M.waitingDetail(pending, "EX-006")).toBe("Waiting for EX-006's pull request to be prepared");
  });

  it("a closed pull request blocks dependents with the reason; delivering again clears it and takes the next number", () => {
    const closed = D.reportObservations(opened(), { prs: [observation({ state: "CLOSED", closedBy: "octocat" })], commits: [] }, at(30));
    expect(prOf(closed)).toMatchObject({ phase: "closed" });
    const d = dependent(closed);
    expect(M.blockedReason(d.state, task(d.state, d.id))).toBe("EX-006's PR #12 was closed without merging. Deliver EX-006 again, or remove the prerequisite.");
    expect(D.nextPrOp(d.state, ms(400))).toBeUndefined(); // a closed pull request is not watched, pushed or reopened
    expect(() => D.requestPrMerge(d.state, "EX-006", HEAD, at(31))).toThrow(/closed/);
    const again = D.redeliver(d.state, ["EX-006"], at(40));
    expect(task(again, "EX-006").integration).toMatchObject({ status: "pending", pr: { n: 1, phase: "closed" } });
    expect(M.blockedReason(again, task(again, d.id))).toBeUndefined();
    expect(D.livePr(task(again, "EX-006"))).toBeUndefined();
    const rebuilt = D.reportPrHead(again, "EX-006", { n: 2, sha: HEAD, baseSha: SHA_A, changed: { files: 1, additions: 1, deletions: 0, paths: ["a.txt"], protectedHits: [], workflowHits: [] } }, at(41));
    expect(prOf(rebuilt)).toMatchObject({ n: 2, phase: "built", branch: "orchestration/sample/pr/EX-006-2" });
    expect(prOf(rebuilt).number).toBeUndefined();
    // Not everything can be delivered again.
    expect(() => D.redeliver(opened(), ["EX-006"], at(40))).toThrow(/cannot be delivered again/);
    // With pull-request delivery off, closed work goes through the current mode instead of being stranded;
    // work that never had a pull request still needs the mode switched on.
    const off = D.setDeliveryMode(closed, { mode: "off" }, at(39));
    expect(task(D.redeliver(off, ["EX-006"], at(40)), "EX-006").integration).toMatchObject({ status: "pending" });
    expect(() => D.redeliver(D.setDeliveryMode(integrated(prMode(), "EX-005"), { mode: "off" }, at(39)), ["EX-005"], at(40))).toThrow(/while pull-request delivery is off/);
    // A conflict on the second attempt keeps the number, so a retry does not reuse branch 1.
    const conflict = M.reportIntegration(again, "EX-006", { status: "conflict", message: "conflicts with the base in a.txt" }, at(42));
    expect(task(M.retryIntegration(conflict, "EX-006", at(43)), "EX-006").integration).toMatchObject({ status: "pending", pr: { n: 1 } });
  });

  it("waitForChildren uses the same rule: a parent waits for its children's merges", () => {
    const s = structuredClone(opened());
    task(s, "EX-006").parentTaskId = "EX-001";
    expect(M.childrenSettled(s, task(s, "EX-001"))).toBe(false);
    const merged = D.reportBaseFetched(D.reportObservations(s, { prs: [observation({ state: "MERGED", mergeCommit: MERGE })], commits: [] }, at(60)), MERGE, at(61));
    expect(M.childrenSettled(merged, task(merged, "EX-001"))).toBe(true);
    expect(M.childrenSettled(D.setDeliveryMode(s, { mode: "off" }, at(21)), task(s, "EX-001"))).toBe(true);
  });

  it("writers that start from the base are not dispatched before the first fetch; nothing is blocked", () => {
    let s = D.setDeliveryMode(seed(), { mode: "pr" }, at(0));
    s.attempts = [];
    for (const t of s.tasks) for (const st of t.steps) if (st.state === "running") st.state = "pending";
    const r = M.createTask(s, { title: "Writes", area: "", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, steps: [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], templateName: "One step" }, at(1));
    const ready = M.leadPromoteProposals(r.state, at(1));
    for (const t of ready.tasks) if (t.id !== r.newId && t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
    expect(task(ready, r.newId).lifecycle).toBe("ready");
    expect(D.writersHeld(ready)).toBe("waiting for the first fetch of origin/main");
    const held = M.dispatchEligible(ready, at(2), { holdWriters: D.writersHeld(ready) });
    expect(M.activeAttempts(held, r.newId)).toHaveLength(0);
    expect(task(held, r.newId).steps[0]).toMatchObject({ state: "pending" });
    expect(task(held, r.newId).steps[0].blockedReason).toBeUndefined();
    expect(M.activeAttempts(M.dispatchEligible(ready, at(2)), r.newId)).toHaveLength(1); // the hold is what stopped it
    const fetched = D.reportBaseFetched(D.reportPreflight(ready, { ok: true, repo: "o/r", requiredChecks: [], autoMergeBlockers: [], posture: [] }, at(2)), SHA_A, at(3));
    expect(D.writersHeld(fetched)).toBeUndefined();
    expect(M.activeAttempts(M.dispatchEligible(fetched, at(4), { holdWriters: D.writersHeld(fetched) }), r.newId)).toHaveLength(1);
  });
});

describe("step 1 review findings (pure)", () => {
  it("setAutonomy forgets the baseline when the delivery branch changes and queues waiting work when delivery is switched on", () => {
    // Switched on through setAutonomy with integrated work waiting: it is queued.
    const waiting = integrated(seed(), "EX-006");
    const on = M.setAutonomy(waiting, autonomy(waiting, true), at(1));
    expect(on.project.delivery?.pending).toBe(true);
    expect(M.deliveryDue(on, T0 + 2000)).toBe(true);
    // Branch changed through setAutonomy: the old branch's baseline and result are gone.
    let s = landedState();
    s = integrated(s, "EX-005", { sha: SHA_B });
    expect(s.project.delivery).toMatchObject({ lastSha: SHA_A, pending: false });
    const moved = M.setAutonomy(s, { ...s.project.autonomy, autoDeliver: { enabled: true, branch: "release" } }, at(10));
    expect(moved.project.delivery?.lastSha).toBeUndefined();
    expect(moved.project.delivery?.status).toBeUndefined();
    expect(moved.project.delivery?.pending).toBe(true);
    // An unrelated autonomy change keeps the baseline.
    const same = M.setAutonomy(s, { ...s.project.autonomy, autoRetry: 2 }, at(10));
    expect(same.project.delivery).toEqual(s.project.delivery);
  });

  it("the changes viewer colours by position: --- and +++ are headers only before a file's first hunk", () => {
    const lines = [
      " a.sql | 4 ++--",
      " 1 file changed, 2 insertions(+), 2 deletions(-)",
      "",
      "diff --git a/a.sql b/a.sql",
      "index 1111111..2222222 100644",
      "--- a/a.sql",
      "+++ b/a.sql",
      "@@ -1,3 +1,3 @@",
      " select 1;",
      "-- a removed SQL comment",
      "--- a removed line that starts with two more dashes",
      "++ an added line that starts with a plus",
      "+++ another added line",
      "\\ No newline at end of file",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ];
    expect(diffLineClasses(lines)).toEqual(["same", "same", "same", "meta", "meta", "meta", "meta", "meta", "same", "del", "del", "add", "add", "meta", "meta", "meta", "meta", "meta", "meta", "add"]);
  });

  it("sending work back keeps its reason even when the item already holds the most notes", () => {
    const s = structuredClone(landedState());
    const l = task(s, "EX-006").integration!.landed!;
    l.notes = Array.from({ length: D.MAX_NOTES_PER_ITEM }, (_, i) => ({ id: `n${i}`, at: at(3), text: `note ${i}` }));
    expect(() => D.addLandedNote(s, "EX-006", "one more", false, at(4))).toThrow(/at most/);
    const r = D.sendBackLanded(s, { taskId: "EX-006", kind: "fix", note: "The reason must not be lost", holdBeforeStart: false }, at(5));
    expect(task(r.state, "EX-006").integration!.landed!.notes.at(-1)!.text).toBe("The reason must not be lost");
  });
});
