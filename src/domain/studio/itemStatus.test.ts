// ORC-029 pass 5, screen 5: where each blueprint item stands in the factory, from the state only. A dictionary is in
// force; a failing rule, or an open difference the UX review of the landed work found, fails a check; a draft change
// puts it in the draft; running work is being built; landed work on this version is built and verified only when the
// checks prove it (every rule passes; a screen's evidence of the landed commit on each device, compared by a UX review
// with no open difference; a terminal demo's recording), else built, not verified, with the first gap; work that built
// an earlier version does not count for the version in force; nothing started is designed.

import { describe, expect, it } from "vitest";
import { runCommand } from "../commands";
import * as M from "../model";
import { blueprintScene, citingTask, landTask, testReport } from "../testing/blueprintScene";
import { builtBy, captured, capturedAs, decisionOn, landedCommit, leadDecides, notCaptured, realityBase, realityScene, recordingFiles, shotFile, uxReviewed } from "../testing/realityScene";
import { lockInAsOwner } from "../testing/studio";
import type { State } from "../types";
import { blueprintFactoryStatus, itemFactoryStatus } from "./itemStatus";

const statuses = (s: State) => Object.fromEntries(blueprintFactoryStatus(s).map((v) => [`${v.item.title} v${v.item.version}`, v.status]));
const status = (s: State, id: string) => itemFactoryStatus(s, id)!.status;
const gap = (s: State, id: string) => itemFactoryStatus(s, id)!.notVerified;

describe("an item's factory status", () => {
  it("in the prototype's scene: each status, with the tasks that cite the item and their states", () => {
    const { s, items, tasks } = blueprintScene();
    expect(statuses(s)).toEqual({
      "Trip plan v1": "in-the-draft", // the draft changes it to v2; T-001 builds v1 meanwhile
      "Trip data v1": "built-not-verified", // landed, and a contract with no rules has nothing to prove it
      "Words v1": "in-force",
      "Join flow v1": "fails-a-check", // R4's test fails
      "Share costs v1": "built-and-verified",
      "Reminders v1": "in-the-draft", // the draft drops it
    });
    expect(gap(s, items.data)).toEqual({ why: "no-rules" });
    const plan = itemFactoryStatus(s, items.plan)!;
    expect(plan.tasks).toEqual([{ taskId: tasks.plan, title: "Trip plan screen", state: "running", thisVersion: true }]);
    expect(plan.draft).toMatchObject({ change: "changed", item: { id: items.plan, version: 2 } });
    expect(itemFactoryStatus(s, items.reminders)!.draft).toEqual({ change: "dropped" });
    expect(itemFactoryStatus(s, items.join)!.rules!.counts).toEqual({ passed: 4, failed: 1, skipped: 0, "no-test": 1 });
    // The draft's added item is not in force, and an unknown id has no status.
    expect(itemFactoryStatus(s, items.packing)).toBeUndefined();
    expect(itemFactoryStatus(s, "bi-404")).toBeUndefined();
  });

  it("after the Lock in: the dropped item leaves the list, the new one is designed, and running work on the old version does not build the new one", () => {
    const sc = blueprintScene();
    const s = lockInAsOwner(sc.s, sc.at(400));
    expect(statuses(s)).toEqual({
      // Review finding 15: T-001 still runs, but it builds v1, so nothing builds v2 yet.
      "Trip plan v2": "designed",
      "Trip data v1": "built-not-verified",
      "Words v1": "in-force",
      "Join flow v1": "fails-a-check",
      "Share costs v1": "built-and-verified",
      "Packing list v1": "designed",
    });
    // T-001's spec is from before v2 came into force: it builds the earlier version.
    expect(itemFactoryStatus(s, sc.items.plan)!.tasks).toEqual([{ taskId: sc.tasks.plan, title: "Trip plan screen", state: "running", thisVersion: false }]);
    expect(itemFactoryStatus(s, sc.items.plan)!.since).toBe(sc.at(400));
    // New work on v2 that runs is being built (as in the scene: started on the owner's go-ahead, then dispatched).
    const revision = citingTask(s, "Trip plan: day list first", [sc.items.plan], sc.at(410));
    const started = M.startHeldTask(revision.s, revision.taskId, sc.at(420));
    const d = M.dispatchEligible(M.leadPromoteProposals(started, sc.at(420)), sc.at(421));
    expect(M.activeAttempts(d, revision.taskId)).toHaveLength(1);
    expect(status(d, sc.items.plan)).toBe("being-built");
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
    expect(status(s, sc.items.plan)).toBe("built-not-verified");
    expect(gap(s, sc.items.plan)).toEqual({ why: "no-evidence", reason: "no-run" });
  });

  it('landed with "No test" or "skipped" is built, not verified, with the count; every rule and example passing is built and verified', () => {
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
    expect(status(s, sc.items.join)).toBe("built-not-verified");
    expect(gap(s, sc.items.join)).toEqual({ why: "rules-unproved", noTest: 1, skipped: 0 });
    fix = citingTask(s, "Test the full trip", [sc.items.join], sc.at(460));
    s = landTask(fix.s, fix.taskId, sc.at(470), rules("skipped"));
    expect(status(s, sc.items.join)).toBe("built-not-verified");
    expect(gap(s, sc.items.join)).toEqual({ why: "rules-unproved", noTest: 0, skipped: 1 });
    fix = citingTask(s, "Unskip the full trip", [sc.items.join], sc.at(480));
    s = landTask(fix.s, fix.taskId, sc.at(490), rules("passed"));
    expect(status(s, sc.items.join)).toBe("built-and-verified");
    expect(gap(s, sc.items.join)).toBeUndefined();
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

describe("a screen: the evidence of the landed commit, and the UX review of it", () => {
  /** Trip plan v2, built by a new task that landed at 700, captured on both devices at 690. */
  const screenBuilt = () => {
    const b = realityBase();
    const built = builtBy(b.s, b, "Trip plan: day list first", [b.items.plan], 620);
    const e = captured(built.s, built.taskId, [capturedAs(built.s, b.items.plan, [shotFile(b.items.plan, "desktop"), shotFile(b.items.plan, "mobile")])], b.at(690));
    return { b, taskId: built.taskId, s: e.s, evidenceId: e.evidenceId };
  };

  it("captured at the landed commit on each device, and the UX review clean: built and verified", () => {
    const { b, s, evidenceId, taskId } = screenBuilt();
    expect(gap(s, b.items.plan)).toEqual({ why: "no-ux-review" }); // captured, but nobody compared it yet
    const clean = uxReviewed(s, taskId, evidenceId, [], b.at(695));
    expect(status(clean.s, b.items.plan)).toBe("built-and-verified");
    const v = itemFactoryStatus(clean.s, b.items.plan)!;
    expect(v.evidence).toMatchObject({ status: "captured", current: true, commit: landedCommit(clean.s, taskId), design: { version: 2 }, from: { taskId, landed: true } });
    expect(v.uxReview).toMatchObject({ taskId, artifactId: clean.reviewId, differences: [], notes: [], ofLandedWork: true });
  });

  it("an open difference the UX review found fails a check, with the finding; only the owner's accept explains it", () => {
    const { b, s, evidenceId, taskId } = screenBuilt();
    const r = uxReviewed(s, taskId, evidenceId, [{ title: "The map comes first; the design puts it below the days" }], b.at(695));
    expect(status(r.s, b.items.plan)).toBe("fails-a-check");
    expect(itemFactoryStatus(r.s, b.items.plan)!.uxReview!.differences).toEqual([
      { findingId: "F1", title: "The map comes first; the design puts it below the days", detail: "The map comes first; the design puts it below the days", severity: "error", action: "ask-user", state: "open", decision: { id: decisionOn(r.s, r.reviewId, "F1").id, status: "open" } },
    ]);
    // The lead's accept is a decision, but the design is the owner's: the difference stays open.
    const byLead = leadDecides(r.s, r.reviewId, "F1", "accept", b.at(800));
    expect(status(byLead, b.items.plan)).toBe("fails-a-check");
    expect(itemFactoryStatus(byLead, b.items.plan)!.uxReview!.differences[0]).toMatchObject({ state: "open", decision: { status: "accept", by: "lead" } });
    // "fix" and "follow-up" leave the difference in what landed.
    const fix = runCommand(r.s, "decideFinding", { decisionId: decisionOn(r.s, r.reviewId, "F1").id, decision: "fix" }, b.at(800)).state;
    expect(status(fix, b.items.plan)).toBe("fails-a-check");
    const followUp = runCommand(r.s, "decideFinding", { decisionId: decisionOn(r.s, r.reviewId, "F1").id, decision: "follow-up" }, b.at(800)).state;
    expect(status(followUp, b.items.plan)).toBe("fails-a-check");
    expect(itemFactoryStatus(followUp, b.items.plan)!.uxReview!.differences[0].decision).toMatchObject({ status: "follow-up", by: "user", followUpTaskId: expect.any(String) });
    // The owner accepts it: explained, so the screen is built and verified.
    const accepted = runCommand(byLead, "decideFinding", { decisionId: decisionOn(byLead, r.reviewId, "F1").id, decision: "accept" }, b.at(810)).state;
    expect(status(accepted, b.items.plan)).toBe("built-and-verified");
    expect(itemFactoryStatus(accepted, b.items.plan)!.uxReview!.differences[0]).toMatchObject({ state: "explained", decision: { status: "accept", by: "user" } });
  });

  it("an auto-fix difference is open; an information-only finding is a note; a finding that names another item is not this item's", () => {
    const { b, s, evidenceId, taskId } = screenBuilt();
    const r = uxReviewed(s, taskId, evidenceId, [{ title: "The day list has no heading", action: "auto-fix", severity: "warning" }], b.at(695));
    expect(status(r.s, b.items.plan)).toBe("fails-a-check");
    const notes = uxReviewed(s, taskId, evidenceId, [{ title: "The map tiles load slowly", severity: "info", action: "no-op" }, { title: `${b.items.packing}: the list has no owner column` }], b.at(695));
    expect(status(notes.s, b.items.plan)).toBe("built-and-verified");
    expect(itemFactoryStatus(notes.s, b.items.plan)!.uxReview).toMatchObject({ differences: [], notes: [{ findingId: "F1", title: "The map tiles load slowly" }] });
  });

  it("an owner's accept carried to a later round still explains the difference", () => {
    const { b, s, evidenceId, taskId } = screenBuilt();
    const first = uxReviewed(s, taskId, evidenceId, [{ title: "The map is wider than in the design" }], b.at(691));
    const accepted = runCommand(first.s, "decideFinding", { decisionId: decisionOn(first.s, first.reviewId, "F1").id, decision: "accept" }, b.at(692)).state;
    const again = uxReviewed(accepted, taskId, evidenceId, [{ title: "The map is wider than in the design" }], b.at(695));
    expect(decisionOn(again.s, again.reviewId, "F1")).toMatchObject({ status: "accept", decidedBy: "carried" });
    expect(status(again.s, b.items.plan)).toBe("built-and-verified");
  });

  it("not verified, with the reason: no evidence, the preview not set up or not started, a missing device, a warning", () => {
    const b = realityBase();
    const built = builtBy(b.s, b, "Trip plan: day list first", [b.items.plan], 620);
    const with_ = (cap: Parameters<typeof captured>[2]) => captured(built.s, built.taskId, cap, b.at(690)).s;
    expect(gap(built.s, b.items.plan)).toEqual({ why: "no-evidence", reason: "no-run" });
    expect(gap(with_([notCaptured(built.s, b.items.plan, "not-set-up", "The project has no preview setting, so nothing ran. Only the owner sets one.")]), b.items.plan)).toEqual({ why: "no-evidence", reason: "not-set-up", detail: "The project has no preview setting, so nothing ran. Only the owner sets one." });
    expect(gap(with_([notCaptured(built.s, b.items.plan, "preview-did-not-start", "Port 4173 did not open within 60 s.", "Error: Cannot find module 'vite'\n")]), b.items.plan)).toEqual({ why: "no-evidence", reason: "preview-did-not-start", detail: "Port 4173 did not open within 60 s.", log: "Error: Cannot find module 'vite'" });
    expect(gap(with_([capturedAs(built.s, b.items.plan, [shotFile(b.items.plan, "desktop")], ["Not captured on mobile: timeout"])]), b.items.plan)).toEqual({ why: "evidence-missing-device", devices: ["mobile"] });
    expect(gap(with_([capturedAs(built.s, b.items.plan, [shotFile(b.items.plan, "desktop"), shotFile(b.items.plan, "mobile")], ["TypeError: days is undefined"])]), b.items.plan)).toEqual({ why: "evidence-warning", warning: "TypeError: days is undefined" });
    // The UX review of evidence that has a gap decides nothing: still not verified, never verified.
    const e = captured(built.s, built.taskId, [notCaptured(built.s, b.items.plan, "not-set-up", "nothing ran")], b.at(690));
    const r = uxReviewed(e.s, built.taskId, e.evidenceId, [], b.at(695));
    expect(status(r.s, b.items.plan)).toBe("built-not-verified");
  });

  it("evidence for an older design version, of earlier work, or of a commit before the landed one is not verified", () => {
    const b = realityBase();
    // The Trip plan screen task built v1 and landed at 450 with its evidence of v1; then v2's work landed with none.
    const v1Item = { ...capturedAs(b.s, b.items.plan, [shotFile(b.items.plan, "desktop"), shotFile(b.items.plan, "mobile")]), artifactId: b.artifacts.plan, version: 1 };
    const old = captured(b.s, b.tasks.plan, [v1Item], b.at(440));
    const built = builtBy(old.s, b, "Trip plan: day list first", [b.items.plan], 620);
    expect(status(built.s, b.items.plan)).toBe("built-not-verified");
    expect(gap(built.s, b.items.plan)).toEqual({ why: "evidence-older-design", version: 1 });
    // Two tasks built v2; the evidence is of the first, and the second landed after it.
    const first = builtBy(b.s, b, "Trip plan: day list first", [b.items.plan], 620);
    const e = captured(first.s, first.taskId, [capturedAs(first.s, b.items.plan, [shotFile(b.items.plan, "desktop"), shotFile(b.items.plan, "mobile")])], b.at(690));
    const reviewed = uxReviewed(e.s, first.taskId, e.evidenceId, [], b.at(695));
    expect(status(reviewed.s, b.items.plan)).toBe("built-and-verified");
    const second = builtBy(reviewed.s, b, "Trip plan: bigger map", [b.items.plan], 800);
    expect(gap(second.s, b.items.plan)).toEqual({ why: "evidence-earlier-work", taskId: first.taskId, landedTaskId: second.taskId });
    // A repair after the capture: the evidence is of a commit before the one that landed.
    const repaired = captured(first.s, first.taskId, [capturedAs(first.s, b.items.plan, [shotFile(b.items.plan, "desktop"), shotFile(b.items.plan, "mobile")])], b.at(690), { sha: "ab".repeat(20) });
    const r = uxReviewed(repaired.s, first.taskId, repaired.evidenceId, [{ title: "The map comes first" }], b.at(695));
    expect(gap(r.s, b.items.plan)).toEqual({ why: "evidence-earlier-commit", commit: "ab".repeat(20), landedCommit: landedCommit(r.s, first.taskId).slice(0, 12) });
    // Its UX review is shown with that evidence, but a difference in an earlier commit fails nothing.
    expect(status(r.s, b.items.plan)).toBe("built-not-verified");
    expect(itemFactoryStatus(r.s, b.items.plan)!.uxReview).toMatchObject({ ofLandedWork: false, differences: [{ state: "open" }] });
  });

  it("work in progress: its UX review is shown with its evidence, and its open difference fails nothing", () => {
    const b = realityBase();
    const c = citingTask(b.s, "Trip plan: day list first", [b.items.plan], b.at(620));
    const running = M.dispatchEligible(M.leadPromoteProposals(M.startHeldTask(c.s, c.taskId, b.at(630)), b.at(630)), b.at(630));
    const e = captured(running, c.taskId, [{ ...capturedAs(running, b.items.plan, [shotFile(b.items.plan, "desktop"), shotFile(b.items.plan, "mobile")]) }], b.at(690), { sha: "cd".repeat(20) });
    const r = uxReviewed(e.s, c.taskId, e.evidenceId, [{ title: "The map comes first" }], b.at(695));
    const v = itemFactoryStatus(r.s, b.items.plan)!;
    expect(v.status).toBe("being-built");
    expect(v.evidence).toMatchObject({ status: "captured", from: { taskId: c.taskId, landed: false } });
    expect(v.uxReview).toMatchObject({ ofLandedWork: false, differences: [{ title: "The map comes first", state: "open" }] });
  });
});

describe("a terminal demo, and the scene of the browser pass", () => {
  it("a terminal demo is verified by its recording at the landed commit; a recording with a failure is not; an open difference fails", () => {
    const b = realityBase();
    const built = builtBy(b.s, b, "trips CLI", [b.items.cli], 640);
    expect(gap(built.s, b.items.cli)).toEqual({ why: "no-evidence", reason: "no-run" });
    const rec = captured(built.s, built.taskId, [capturedAs(built.s, b.items.cli, recordingFiles(b.items.cli))], b.at(710));
    expect(status(rec.s, b.items.cli)).toBe("built-and-verified"); // no UX review is needed for a recording
    const failing = captured(built.s, built.taskId, [capturedAs(built.s, b.items.cli, recordingFiles(b.items.cli), ["The recording shows a failure: Error: no such trip"])], b.at(710));
    expect(gap(failing.s, b.items.cli)).toEqual({ why: "evidence-warning", warning: "The recording shows a failure: Error: no such trip" });
    const r = uxReviewed(rec.s, built.taskId, rec.evidenceId, [{ title: "The cost line is missing" }], b.at(715));
    expect(status(r.s, b.items.cli)).toBe("fails-a-check");
  });

  it("the browser pass's scene: each status of screen 5, with evidence", () => {
    const sc = realityScene();
    expect(statuses(sc.s)).toEqual({
      "Trip plan v2": "fails-a-check",
      "Trip data v1": "built-not-verified",
      "Words v1": "in-force",
      "Join flow v1": "fails-a-check",
      "Share costs v1": "built-and-verified",
      "Packing list v1": "built-and-verified",
      "trips CLI v1": "built-and-verified",
      "Trip summary v1": "built-not-verified",
    });
    expect(gap(sc.s, sc.items.summary)).toMatchObject({ why: "no-evidence", reason: "preview-did-not-start", log: expect.stringContaining("Cannot find module 'vite'") });
  });
});
