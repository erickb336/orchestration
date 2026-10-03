// ORC-029 2c and pass 5, the blueprint: the owner's approvals (one artifact or a whole round) and drops change the
// draft only; the version in force moves only at the owner's Lock in, which puts the whole draft into force with its
// summary (Start the factory is the first Lock in); open items stay in the draft; task specs cite items in force; a
// Lock in while building is a change order that lists the dropped items and each touched task's handling (r14); the
// lead never approves, drops, discards or locks in.

import { describe, expect, it } from "vitest";
import { InvalidCommandError, runCommand } from "../commands";
import * as M from "../model";
import { needsYouItems } from "../needsYou";
import { buildSeed } from "../seed";
import { startFactoryArgs, startFactoryAsOwner } from "../testing/factory";
import { addScreen, feedback, openRound, peAgrees, pePass, run } from "../testing/studio";
import { StaleWriteError, type FactorySettings, type SpecContent, type State } from "../types";
import * as B from "./blueprint";
import * as S from "./studio";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
const MANUAL: FactorySettings = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };
const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};
const approve = (s: State, artifactId: string, version: number, variant?: string) => run(s, "approveArtifact", { artifactId, version, ...(variant ? { variant } : {}) }, at(50)).state;
const lockIn = (s: State, sec: number, draftRev = s.blueprint.draft.rev) => run(s, "lockIn", { draftRev }, at(sec)).state;
const drop = (s: State, itemId: string, sec: number) => run(s, "dropBlueprintItem", { itemId }, at(sec)).state;
const itemOf = (s: State, artifactId: string) => B.draftItems(s).find((i) => i.artifactId === artifactId)!;
/** Round 1 with the Trip plan screen (three variants) that the PE agreed to. */
function agreedTripPlan(s = fresh()) {
  const r = openRound(s, "experience", at(1));
  const a = addScreen(r.state, r.n, at(2));
  return { s: peAgrees(a.state, a.id, 1, ["A", "B", "C"], at(3)), id: a.id };
}
/** A single-take screen in the open round, agreed by the PE (with its estimate, when given). */
function agreedScreen(s: State, round: number, title: string, sec: number, budget?: object) {
  const a = addScreen(s, round, at(sec), { title, variants: [] });
  return { s: pePass(a.state, a.id, a.version, [{ verdict: "feasible", ...(budget ? { budget } : {}) }], at(sec)), id: a.id };
}
/** A new version of a single-take screen in the next round, agreed by the PE (with its estimate, when given). */
function revised(s: State, artifactId: string, sec: number, budget?: object) {
  const r = nextRound(s, sec);
  const v = addScreen(r.state, r.n, at(sec), { artifactId, title: S.latestVersion(s, artifactId)!.title, variants: [] });
  return { s: pePass(v.state, artifactId, v.version, [{ verdict: "feasible", ...(budget ? { budget } : {}) }], at(sec)), version: v.version };
}
function nextRound(s: State, sec: number) {
  const cur = S.currentRound(s)!;
  return openRound(runCommand(s, "closeRound", { round: cur.n }, at(sec)).state, "experience", at(sec));
}
/** A task of the owner's whose spec cites these blueprint items (in force). */
function taskCiting(s: State, refs: string[], sec: number, title = `Build ${refs.join(" ")}`): { s: State; id: string } {
  const c = run<{ newId: string }>(s, "createTask", { title, area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at(sec));
  const t = c.state.tasks.find((x) => x.id === c.result.newId)!;
  const content: SpecContent = { ...M.currentSpec(t).content, blueprintRefs: refs };
  return { s: run(c.state, "editSpec", { taskId: t.id, expectedRev: 1, content, reason: "Cites the blueprint" }, at(sec)).state, id: t.id };
}
/** The owner's go-ahead: the task starts (its first step runs). */
const started = (s: State, taskId: string, sec: number) => M.dispatchEligible(M.leadPromoteProposals(M.startHeldTask(s, taskId, at(sec)), at(sec)), at(sec));
/** A fixture: the task's work is finished (landed). Landing runs the whole flow and delivery, which this file does not test. */
function landed(s: State, taskId: string): State {
  const next = structuredClone(s);
  next.tasks.find((t) => t.id === taskId)!.lifecycle = "done";
  return next;
}

describe("approving into the draft", () => {
  it("an approval changes the draft only; the version in force moves at Lock in; an item keeps its id across versions", () => {
    let { s, id } = agreedTripPlan();
    expect(B.blueprintRev(s)).toBe(0);
    s = feedback(s, id, 1, { mark: "keep", pickedVariant: "B" }, at(4));
    s = approve(s, id, 1);
    const item = B.draftItems(s)[0];
    expect(item).toEqual({ id: item.id, kind: "screen", title: "Trip plan", artifactId: id, version: 1, variant: "B", status: "approved" });
    expect(s.blueprint.draft.rev).toBe(1);
    expect(s.blueprint.revisions).toEqual([]);
    expect(B.blueprintItems(s)).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "vision", message: "The draft: approved Trip plan v1 (Timeline)" });
    // Start the factory is the first Lock in: the draft's change goes into force, with the summary recorded.
    s = startFactoryAsOwner(s, at(5), MANUAL);
    expect(s.blueprint.revisions).toEqual([{ rev: 1, at: at(5), visionRev: 1, reason: "locked in: added Trip plan v1", items: [item], lockIn: { by: "user", summary: expect.objectContaining({ draftRev: 1, inForceRev: 0 }) } }]);
    expect(B.hasDraft(s)).toBe(false);
    // A later version, another variant, on the vision as it now stands: the draft changes; the factory keeps v1.
    s = M.editVision(s, 1, "Weekend trips for a small group of friends, offline on the trail.", "", "offline", at(6));
    const v2 = addScreen(nextRound(s, 7).state, 2, at(8), { artifactId: id });
    s = approve(peAgrees(v2.state, id, 2, ["A", "B", "C"], at(9)), id, 2, "C");
    expect(B.draftItems(s)).toEqual([{ ...item, version: 2, variant: "C" }]);
    expect(B.blueprintItems(s)).toEqual([item]);
    expect(B.draftChanges(s).changed).toEqual([{ item: { ...item, version: 2, variant: "C" }, replaces: item }]);
    s = lockIn(s, 10);
    expect(B.currentBlueprint(s)).toMatchObject({ rev: 2, visionRev: 2, reason: "locked in: changed Trip plan v1 → v2", items: [{ id: item.id, version: 2, variant: "C", status: "approved" }] });
    expect(s.blueprint.revisions[0].items[0]).toMatchObject({ version: 1, variant: "B" });
  });

  it("is refused while PE review is unfinished, without a pick, on a dropped artifact, on an objection not overruled, on a version that moved on, and twice", () => {
    const r = openRound(fresh(), "experience", at(1));
    const pending = addScreen(r.state, r.n, at(2));
    expect(() => approve(pending.state, pending.id, 1)).toThrow("Trip plan v1 cannot be approved yet: waiting for PE review.");
    let { s, id } = agreedTripPlan();
    expect(() => approve(s, id, 1)).toThrow("Trip plan v1 cannot be approved yet: your pick between its variants is open.");
    expect(() => approve(s, id, 1, "D")).toThrow("Trip plan has no variant D.");
    expect(() => approve(feedback(s, id, 1, { mark: "drop" }, at(4)), id, 1, "A")).toThrow("Trip plan v1 cannot be approved yet: you marked it Drop.");
    s = approve(s, id, 1, "A");
    expect(() => approve(s, id, 1, "A")).toThrow("Trip plan v1 is already approved in the blueprint.");
    const moved = addScreen(nextRound(s, 5).state, 2, at(6), { artifactId: id }).state;
    expect(failure(() => approve(moved, id, 1, "B"))).toBeInstanceOf(StaleWriteError);
    // Three passes that still object to B: A can be approved; B only once the owner overrules the objection.
    let o = openRound(fresh(), "experience", at(1)).state;
    const t = addScreen(o, 1, at(2));
    o = t.state;
    for (const v of [1, 2, 3]) {
      if (v > 1) o = addScreen(o, 1, at(2 + v), { artifactId: t.id }).state;
      o = pePass(o, t.id, v, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "not-feasible", reasons: "Hourly forecasts cost too much." }, { variant: "C", verdict: "feasible" }], at(2 + v));
    }
    expect(() => approve(o, t.id, 3, "B")).toThrow("Trip plan v3 cannot be approved yet: the PE objects to Timeline (Hourly forecasts cost too much.); overrule the objection to approve it.");
    expect(B.draftItems(approve(o, t.id, 3, "A"))[0]).toMatchObject({ variant: "A", status: "approved" });
    const objection = S.openObjections(o, S.getArtifact(o, t.id, 3))[0];
    o = run(o, "overruleObjection", { verdictId: objection.id, why: "The group pays for the forecasts." }, at(9)).state;
    expect(B.draftItems(approve(o, t.id, 3, "B"))[0]).toMatchObject({ variant: "B", status: "approved" });
  });

  it("a single take needs no pick; an artifact that replaces another takes over its item", () => {
    const r = openRound(fresh(), "experience", at(1));
    const first = agreedScreen(r.state, 1, "Invite sheet", 2);
    let s = approve(first.s, first.id, 1);
    const item = B.draftItems(s)[0];
    expect(item).toEqual({ id: item.id, kind: "screen", title: "Invite sheet", artifactId: first.id, version: 1, status: "approved" });
    const r2 = nextRound(s, 3);
    const merged = addScreen(r2.state, 2, at(4), { title: "Invite and join sheet", variants: [], supersedes: first.id });
    s = approve(peAgrees(merged.state, merged.id, 1, [], at(5)), merged.id, 1);
    expect(B.draftItems(s)).toEqual([{ id: item.id, kind: "screen", title: "Invite and join sheet", artifactId: merged.id, version: 1, status: "approved" }]);
  });

  it("approving a round approves what can be approved as it stands and lists the rest as open, leaves dropped work out, and never reopens an approved item", () => {
    let s = openRound(fresh(), "experience", at(1)).state;
    const search = agreedScreen(s, 1, "Trail search", 2);
    const invite = agreedScreen(search.s, 1, "Invite sheet", 3);
    const group = agreedScreen(invite.s, 1, "Group page", 4);
    const old = agreedScreen(group.s, 1, "Old home", 5);
    const plan = addScreen(old.s, 1, at(6)); // three variants
    s = peAgrees(plan.state, plan.id, 1, ["A", "B", "C"], at(7));
    const offline = addScreen(s, 1, at(8), { title: "Offline banner", variants: [] }); // not reviewed yet
    s = offline.state;
    s = feedback(s, invite.id, 1, { mark: "change", note: "The link should be renewable." }, at(9));
    s = feedback(s, old.id, 1, { mark: "drop" }, at(9));
    s = run(s, "approveRound", { round: 1 }, at(10)).state;
    expect(B.draftItems(s).map((i) => [i.title, i.status])).toEqual([
      ["Trail search", "approved"],
      ["Invite sheet", "open"],
      ["Group page", "approved"],
      ["Trip plan", "open"],
      ["Offline banner", "open"],
    ]);
    expect(B.blueprintItems(s)).toEqual([]);
    expect(s.events.at(-1)?.message).toBe("The draft: approved round 1: 2 approved, 3 still open");
    expect(B.openBlueprintItems(s).map((o) => [o.item.title, o.why])).toEqual([
      ["Invite sheet", "you marked it Change"],
      ["Trip plan", "your pick between its variants is open"],
      ["Offline banner", "waiting for PE review"],
    ]);
    // The owner picks; the item is ready for approval, then approved.
    s = feedback(s, plan.id, 1, { mark: "keep", pickedVariant: "C" }, at(11));
    expect(B.openBlueprintItems(s).find((o) => o.item.title === "Trip plan")?.why).toBe("ready for your approval");
    s = approve(s, plan.id, 1);
    expect(itemOf(s, plan.id)).toMatchObject({ variant: "C", status: "approved" });
    // A new version of an approved screen marked Change in round 2: approving round 2 keeps the approved version.
    const r2 = nextRound(s, 12);
    const search2 = addScreen(r2.state, 2, at(13), { artifactId: search.id, variants: [] });
    s = feedback(peAgrees(search2.state, search.id, 2, [], at(14)), search.id, 2, { mark: "change" }, at(15));
    expect(() => run(s, "approveRound", { round: 2 }, at(16))).toThrow("Round 2 is already in the blueprint as it stands.");
    expect(itemOf(s, search.id)).toMatchObject({ version: 1, status: "approved" });
    expect(() => run(s, "approveRound", { round: 7 }, at(16))).toThrow("There is no round 7.");
    expect(() => run(openRound(fresh(), "experience", at(1)).state, "approveRound", { round: 1 }, at(2))).toThrow("Round 1 has no artifacts to approve.");
  });
});

/** In the factory: Trail search and Invite sheet locked in at Start the factory (blueprint r1). */
function locked() {
  let s = openRound(fresh(), "experience", at(1)).state;
  const search = agreedScreen(s, 1, "Trail search", 2);
  const invite = agreedScreen(search.s, 1, "Invite sheet", 3);
  s = startFactoryAsOwner(run(invite.s, "approveRound", { round: 1 }, at(4)).state, at(5), MANUAL);
  const [searchItem, inviteItem] = B.blueprintItems(s).map((i) => i.id);
  return { s, search: search.id, invite: invite.id, searchItem, inviteItem };
}

describe("dropping an item, and discarding the draft", () => {
  it("a drop changes the draft only; the item keeps its id with the status dropped, in force too once locked in, and specs may still cite it", () => {
    const { s: base, inviteItem, searchItem } = locked();
    let s = drop(base, inviteItem, 6);
    expect(B.draftItems(s).find((i) => i.id === inviteItem)).toMatchObject({ title: "Invite sheet", status: "dropped" });
    expect(B.blueprintItems(s).find((i) => i.id === inviteItem)?.status).toBe("approved");
    expect(B.draftChanges(s).dropped.map((i) => [i.id, i.status])).toEqual([[inviteItem, "approved"]]);
    expect(s.events.at(-1)?.message).toBe("The draft: dropped Invite sheet v1");
    expect(() => drop(s, inviteItem, 7)).toThrow("Invite sheet v1 is already dropped.");
    expect(() => drop(s, "bi-404", 7)).toThrow("There is no blueprint item bi-404.");
    s = lockIn(s, 8);
    expect(B.blueprintItems(s).map((i) => [i.id, i.status])).toEqual([
      [searchItem, "approved"],
      [inviteItem, "dropped"],
    ]);
    expect(B.currentBlueprint(s)?.reason).toBe("locked in: dropped Invite sheet v1");
    expect(B.validateBlueprintRefs(s, [inviteItem])).toEqual([inviteItem]);
    // Approving the round again leaves the dropped item dropped; approving the artifact on its own brings it back, with its id.
    const invite = B.draftItems(s).find((i) => i.id === inviteItem)!.artifactId;
    expect(() => run(s, "approveRound", { round: 1 }, at(9))).toThrow("Round 1 is already in the blueprint as it stands.");
    s = approve(s, invite, 1);
    expect(B.draftItems(s).find((i) => i.id === inviteItem)?.status).toBe("approved");
    expect(B.draftChanges(s).added.map((i) => i.id)).toEqual([inviteItem]);
  });

  it("discarding puts the draft back to the version in force, on the draft revision the owner saw; refused with no draft", () => {
    const { s: base, search, inviteItem } = locked();
    const changed = revised(drop(base, inviteItem, 6), search, 7);
    let s = approve(changed.s, search, changed.version);
    expect(B.hasDraft(s)).toBe(true);
    const seen = s.blueprint.draft.rev;
    expect(failure(() => run(s, "discardDraft", { draftRev: seen - 1 }, at(9)))).toBeInstanceOf(StaleWriteError);
    s = run(s, "discardDraft", { draftRev: seen }, at(9)).state;
    expect(B.draftItems(s)).toEqual(B.blueprintItems(s));
    expect(s.blueprint.draft.rev).toBe(seen + 1);
    expect(B.hasDraft(s)).toBe(false);
    expect(s.events.at(-1)?.message).toBe("The draft: discarded; it is the version in force (r1) again");
    expect(() => run(s, "discardDraft", { draftRev: seen + 1 }, at(10))).toThrow("There is no draft to discard: it is the version in force.");
    // The studio's work stays: the new version is there to approve again.
    expect(S.latestVersion(s, search)?.version).toBe(changed.version);
  });
});

describe("Lock in: the owner's, on the summary they saw", () => {
  it("is refused in Vision (Start the factory is the first), on a stale draft revision, and with nothing to put into force", () => {
    const { s: agreed, id } = agreedTripPlan();
    const vision = approve(agreed, id, 1, "A");
    expect(() => lockIn(vision, 10)).toThrow("In Vision, Start the factory is your first Lock in.");
    const { s: base, search } = locked();
    expect(() => lockIn(base, 10)).toThrow("There is nothing to lock in: the draft is the version in force.");
    // Only an open item in the draft: nothing to lock in, and it stays.
    const pending = addScreen(nextRound(base, 6).state, 2, at(7), { title: "Offline banner", variants: [] });
    const open = run(pending.state, "approveRound", { round: 2 }, at(8)).state;
    expect(B.draftChanges(open).open.map((i) => i.title)).toEqual(["Offline banner"]);
    expect(() => lockIn(open, 9)).toThrow("There is nothing to lock in: the draft holds only open items, which stay in the draft.");
    // A change: the summary names the draft revision; a Lock in on an older one is refused.
    const changed = revised(open, search, 10);
    const s = approve(changed.s, search, changed.version);
    const summary = B.lockInSummary(s);
    expect(summary.draftRev).toBe(s.blueprint.draft.rev);
    expect(failure(() => lockIn(s, 11, summary.draftRev - 1))).toBeInstanceOf(StaleWriteError);
    expect(() => runCommand(s, "lockIn", { draftRev: "3" }, at(11))).toThrow(InvalidCommandError);
    expect(() => runCommand(s, "lockIn", {}, at(11))).toThrow(InvalidCommandError);
  });

  it("puts the whole draft into force as one revision with the owner's agreement and the summary; open items stay in the draft", () => {
    const { s: base, search, searchItem, inviteItem } = locked();
    const pending = addScreen(nextRound(base, 6).state, 2, at(7), { title: "Offline banner", variants: [] });
    let s = run(pending.state, "approveRound", { round: 2 }, at(8)).state;
    const changed = revised(s, search, 9);
    s = drop(approve(changed.s, search, changed.version), inviteItem, 10);
    const summary = B.lockInSummary(s);
    s = lockIn(s, 11);
    const rev = B.currentBlueprint(s)!;
    expect(rev).toMatchObject({ rev: 2, at: at(11), reason: `locked in: changed Trail search v1 → v${changed.version}; dropped Invite sheet v1`, lockIn: { by: "user", summary } });
    expect(rev.items.map((i) => [i.id, i.title, i.version, i.status])).toEqual([
      [searchItem, "Trail search", changed.version, "approved"],
      [inviteItem, "Invite sheet", 1, "dropped"],
    ]);
    expect(s.events.find((e) => e.message.startsWith("Lock in r2"))?.message).toBe(`Lock in r2: changed Trail search v1 → v${changed.version}; dropped Invite sheet v1; 1 open item stays in the draft`);
    // The open item is not in force, and the draft still holds it: the header shows it.
    expect(rev.items.some((i) => i.title === "Offline banner")).toBe(false);
    expect(B.draftChanges(s)).toMatchObject({ added: [], changed: [], dropped: [], open: [{ title: "Offline banner", status: "open" }] });
    expect(B.hasDraft(s)).toBe(true);
  });
});

describe("the Lock in summary", () => {
  it("names what changes (added, changed with what it replaces, dropped), the new work, and what stays open", () => {
    const { s: base, search, searchItem, inviteItem } = locked();
    const changed = revised(base, search, 6);
    let s = approve(changed.s, search, changed.version);
    const packing = agreedScreen(s, S.currentRound(s)!.n, "Packing list", 7);
    s = approve(packing.s, packing.id, 1);
    const banner = addScreen(s, S.currentRound(s)!.n, at(8), { title: "Offline banner", variants: [] });
    s = drop(run(banner.state, "approveRound", { round: S.currentRound(s)!.n }, at(8)).state, inviteItem, 9);
    const summary = B.lockInSummary(s);
    const packingItem = itemOf(s, packing.id).id;
    expect(summary.inForceRev).toBe(1);
    expect(summary.changes).toEqual({
      added: [{ id: packingItem, kind: "screen", title: "Packing list", artifactId: packing.id, version: 1, status: "approved" }],
      changed: [{ item: { id: searchItem, kind: "screen", title: "Trail search", artifactId: search, version: changed.version, status: "approved" }, replaces: { id: searchItem, kind: "screen", title: "Trail search", artifactId: search, version: 1, status: "approved" } }],
      dropped: [{ id: inviteItem, kind: "screen", title: "Invite sheet", artifactId: expect.any(String), version: 1, status: "approved" }],
    });
    // No task cites anything yet: every added item is new work, and no task is touched.
    expect(summary.newWork).toEqual([packingItem]);
    expect(summary.tasks).toEqual([]);
    expect(summary.stillOpen).toEqual([{ item: expect.objectContaining({ title: "Offline banner", status: "open" }), why: "waiting for PE review" }]);
  });

  it("lists each task that cites a changed, added or dropped item, with its state and what happens to it (r14)", () => {
    const { s: base, search, searchItem, inviteItem } = locked();
    let s = base;
    const queued = taskCiting(s, [searchItem], 6, "Search, not started");
    const running = taskCiting(queued.s, [searchItem], 7, "Search, building");
    const done = taskCiting(running.s, [searchItem], 8, "Search, landed");
    const retire = taskCiting(done.s, [inviteItem], 9, "Invite only, not started");
    const finish = taskCiting(retire.s, [inviteItem], 10, "Invite only, building");
    const both = taskCiting(finish.s, [searchItem, inviteItem], 11, "Search and invite, not started");
    const cancelled = taskCiting(both.s, [searchItem], 12, "Cancelled");
    s = runCommand(cancelled.s, "cancelTask", { taskId: cancelled.id }, at(12)).state;
    s = landed(started(started(s, running.id, 13), finish.id, 13), done.id);
    const changed = revised(s, search, 14);
    s = drop(approve(changed.s, search, changed.version), inviteItem, 15);
    const tasks = B.lockInSummary(s).tasks.map((t) => [t.title, t.state, t.items, t.handling]);
    expect(tasks).toEqual([
      ["Search, not started", "queued", [searchItem], "update-spec"],
      ["Search, building", "running", [searchItem], "finish-then-revise"],
      ["Search, landed", "landed", [searchItem], "plan-revision"],
      ["Invite only, not started", "queued", [inviteItem], "retire"],
      ["Invite only, building", "running", [inviteItem], "finish-then-revise"],
      ["Search and invite, not started", "queued", [searchItem, inviteItem], "update-spec"],
    ]);
    expect(B.HANDLING_WORDS).toMatchObject({ "finish-then-revise": "it finishes, then the lead revises it" });
  });

  it("states the budgets: the spend and maintenance so far, the PE's estimate of each added or changed item, or none (never $0)", () => {
    const { s: base, search } = locked();
    let s = runCommand(base, "setBudgets", { buildingUsd: 40, maintenanceUsdPerMonth: 10 }, at(6)).state;
    const estimate = { buildUsd: [1, 2], maintenanceUsdPerMonth: [0.4, 0.8], basis: "The providers' price lists" };
    const changed = revised(s, search, 7, estimate);
    s = approve(changed.s, search, changed.version);
    const searchItem = itemOf(s, search).id;
    expect(B.lockInSummary(s).budgets).toEqual({
      building: { budgetUsd: 40, spentUsd: 0, unknownRuns: 0 },
      // No start estimate yet (the pre-flight's, pass 6): not estimated, never $0.
      maintenance: { budgetUsdPerMonth: 10, estimateUsdPerMonth: null },
      items: [{ itemId: searchItem, estimate }],
      itemsTotal: { buildUsd: [1, 2], maintenanceUsdPerMonth: [0.4, 0.8] },
    });
    // A new item the PE gave no figure for: "no estimate" for it, and so for the total.
    const packing = agreedScreen(s, S.currentRound(s)!.n, "Packing list", 8);
    s = approve(packing.s, packing.id, 1);
    const budgets = B.lockInSummary(s).budgets;
    expect(budgets.items).toEqual([
      { itemId: itemOf(s, packing.id).id, estimate: null },
      { itemId: searchItem, estimate },
    ]);
    expect(budgets.itemsTotal).toEqual({ buildUsd: null, maintenanceUsdPerMonth: null });
  });
});

describe("Start the factory: the first Lock in", () => {
  it("compares the draft revision the pre-flight showed, names the draft's open items beside the open areas, and locks the draft in", () => {
    const { s: agreed } = agreedTripPlan();
    const before = startFactoryArgs(agreed, MANUAL);
    expect(before).toMatchObject({ draftRev: 0, visionRev: 1 });
    const search = agreedScreen(agreed, 1, "Trail search", 9);
    let s = run(search.s, "approveRound", { round: 1 }, at(10)).state; // Trip plan is open: no variant picked
    const open = itemOf(s, S.latestArtifacts(s)[0].id);
    expect(open.status).toBe("open");
    expect(failure(() => runCommand(s, "startFactory", before, at(11)))).toBeInstanceOf(StaleWriteError);
    const areas = M.openAreas(s);
    expect(M.preflightOpenItems(s)).toEqual([...areas, open.id]);
    const args = startFactoryArgs(s, MANUAL);
    expect(() => runCommand(s, "startFactory", { ...args, acceptOpen: areas }, at(11))).toThrow(`Still open and not confirmed: ${open.id}. Confirm them to start, or close them first.`);
    s = runCommand(s, "startFactory", args, at(11)).state;
    expect(s.project.factoryStarts).toEqual([{ at: at(11), by: "user", blueprintRev: 1, visionRev: 1, settings: MANUAL, openItems: [...areas, open.id] }]);
    expect(B.currentBlueprint(s)).toMatchObject({ rev: 1, reason: "locked in: added Trail search v1", lockIn: { by: "user", summary: { draftRev: args.draftRev, inForceRev: 0 } } });
    // The open item stays in the draft, and the start made no change order (no task was building).
    expect(B.blueprintItems(s).map((i) => i.title)).toEqual(["Trail search"]);
    expect(B.draftChanges(s).open.map((i) => i.id)).toEqual([open.id]);
    expect(s.blueprint.changeOrders).toEqual([]);
    expect(s.events.at(-1)?.message).toBe(`Building started: you agreed to vision r1 and blueprint r1 with 9 open areas confirmed (${areas.join(", ")}) and 1 open blueprint item confirmed (Trip plan)`);
  });

  it("with nothing approved, starts with nothing in force: no revision", () => {
    const s = startFactoryAsOwner(fresh(), at(1), MANUAL);
    expect(s.project.factoryStarts[0].blueprintRev).toBe(0);
    expect(s.blueprint.revisions).toEqual([]);
  });
});

describe("task specs cite items in force", () => {
  it("each reference must name an item in force, never one only in the draft; a repeat is kept once", () => {
    const { s: base, searchItem } = locked();
    const cited = taskCiting(base, [searchItem, searchItem], 20);
    expect(M.currentSpec(cited.s.tasks.find((t) => t.id === cited.id)!).content.blueprintRefs).toEqual([searchItem]);
    expect(() => taskCiting(base, [searchItem, "bi-404"], 21)).toThrow("Not in the blueprint: bi-404.");
    const packing = agreedScreen(base, S.currentRound(base)!.n, "Packing list", 22);
    const drafted = approve(packing.s, packing.id, 1);
    expect(() => taskCiting(drafted, [itemOf(drafted, packing.id).id], 23)).toThrow(`Not in the blueprint: ${itemOf(drafted, packing.id).id}.`);
    const t = cited.s.tasks.find((x) => x.id === cited.id)!;
    expect(() => runCommand(cited.s, "editSpec", { taskId: t.id, expectedRev: 2, content: { ...M.currentSpec(t).content, blueprintRefs: searchItem }, reason: "r" }, at(22))).toThrow(InvalidCommandError);
  });
});

describe("change orders: a Lock in while building", () => {
  /** In the factory: tasks citing Trail search and Invite sheet; one citing Trail search is cancelled. */
  function planned() {
    const l = locked();
    const t1 = taskCiting(l.s, [l.searchItem], 6);
    const t2 = taskCiting(t1.s, [l.inviteItem], 7);
    const t3 = taskCiting(t2.s, [l.searchItem, l.inviteItem], 8);
    const s = runCommand(t3.s, "cancelTask", { taskId: t3.id }, at(8)).state;
    return { ...l, s, tasks: [t1.id, t2.id, t3.id] };
  }
  /** A revision of Trail search approved into the draft, then locked in. */
  const reviseSearch = (s: State, searchId: string, sec: number) => {
    const v = revised(s, searchId, sec);
    return lockIn(approve(v.s, searchId, v.version), sec);
  };

  it("lists the changed and dropped items, each touched task with its planned handling, and the new work; it is marked for the lead", () => {
    const { s: base, search, searchItem, inviteItem, tasks } = planned();
    const v = revised(base, search, 10);
    let s = drop(approve(v.s, search, v.version), inviteItem, 11);
    const packing = agreedScreen(s, S.currentRound(s)!.n, "Packing list", 12);
    s = approve(packing.s, packing.id, 1);
    const packingItem = itemOf(s, packing.id).id;
    s = lockIn(s, 13);
    const rev = B.blueprintRev(s);
    expect(s.blueprint.changeOrders).toEqual([
      { rev, at: at(13), changedItems: [packingItem, searchItem], droppedItems: [inviteItem], tasks: [{ taskId: tasks[0], handling: "update-spec" }, { taskId: tasks[1], handling: "retire" }], newWork: [packingItem], status: "open", handler: "lead" },
    ]);
    expect(s.events.at(-1)).toMatchObject({ actor: "system", message: `Change order for blueprint r${rev}: it touches ${tasks[0]} (the lead updates its spec), ${tasks[1]} (retired); 1 new item to plan; the lead updates the affected tasks` });
    expect(B.openChangeOrders(s, "lead").map((c) => c.rev)).toEqual([rev]);
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order"))).toEqual([]);
  });

  it("a Lock in that touches no task and adds nothing is no change order: only an event, and nothing waits under Needs you (review finding 8)", () => {
    const { s: base, search, tasks } = planned();
    let s = runCommand(runCommand(base, "setChangeOrders", { who: "user" }, at(9)).state, "cancelTask", { taskId: tasks[0] }, at(9)).state;
    s = reviseSearch(s, search, 10);
    const rev = B.blueprintRev(s);
    expect(s.blueprint.changeOrders).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({ actor: "system", kind: "vision", message: `No change order for blueprint r${rev}: no task cites the changed items, and nothing new is to be built` });
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order"))).toEqual([]);
  });

  it("new work alone is a change order: the lead plans its tasks", () => {
    const { s: base } = planned();
    const packing = agreedScreen(base, S.currentRound(base)!.n, "Packing list", 10);
    const s = lockIn(approve(packing.s, packing.id, 1), 11);
    expect(s.blueprint.changeOrders).toMatchObject([{ changedItems: [itemOf(s, packing.id).id], droppedItems: [], tasks: [], newWork: [itemOf(s, packing.id).id] }]);
  });

  it("with change orders set to you, it waits under Needs you; an open one keeps the handler it was made with", () => {
    const { s: base, search, inviteItem, tasks } = planned();
    let s = reviseSearch(base, search, 10);
    const leads = B.blueprintRev(s);
    s = runCommand(s, "setChangeOrders", { who: "user" }, at(20)).state;
    expect(s.project.changeOrders).toBe("user");
    expect(M.currentFactorySettings(s).pausePoints.changeOrders).toBe("user");
    const v = revised(s, search, 30);
    s = lockIn(drop(approve(v.s, search, v.version), inviteItem, 30), 30);
    const yours = B.blueprintRev(s);
    expect(s.blueprint.changeOrders.map((c) => [c.rev, c.handler])).toEqual([
      [leads, "lead"],
      [yours, "user"],
    ]);
    const waiting = needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order"));
    expect(waiting).toEqual([
      { kind: "open", key: `change-order-${yours}`, what: `Change order: blueprint r${yours}`, detail: `You changed the blueprint: Trail search (v${v.version}); dropped Invite sheet (v1). It touches ${tasks[0]}, ${tasks[1]}. You asked to look before the lead updates tasks.`, action: "Open", href: "#/tasks" },
    ]);
    expect(() => runCommand(s, "setChangeOrders", { who: "pe" }, at(40))).toThrow(InvalidCommandError);
  });

  it("setting change orders to what they already are records nothing (review finding 9)", () => {
    const s = planned().s;
    expect(s.project.changeOrders).toBe("lead");
    expect(runCommand(s, "setChangeOrders", { who: "lead" }, at(10)).state).toBe(s);
    const yours = runCommand(s, "setChangeOrders", { who: "user" }, at(11)).state;
    expect(yours.events.length).toBe(s.events.length + 1);
    expect(runCommand(yours, "setChangeOrders", { who: "user" }, at(12)).state.events).toEqual(yours.events);
  });

  it("with PE review of new work on, the lead's updates wait for the PE; an objection after three rounds waits under Needs you, and your overrule is recorded (2e)", () => {
    const { s: base, search } = planned();
    let s = reviseSearch(base, search, 10);
    expect(s.blueprint.changeOrders[0].peReview).toBeUndefined(); // off until the PE's review runs exist (pass 5)
    s.project.peReviewsNewWork = true;
    s = reviseSearch(s, search, 20);
    const rev = B.blueprintRev(s);
    const order = () => s.blueprint.changeOrders.find((c) => c.rev === rev)!;
    expect(order().peReview).toEqual({ status: "pending", rounds: [] });
    expect(s.events.at(-1)!.message).toMatch(/the lead updates the affected tasks, once the PE agrees with the updates$/);
    const object = (st: State, sec: number) => runCommand(st, "recordPeReview", { changeOrder: rev, verdict: "object", reasons: "The new search breaks saved trails." }, at(sec)).state;
    for (const sec of [31, 32]) s = object(s, sec);
    expect(order().peReview!.status).toBe("pending");
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order-pe"))).toEqual([]);
    s = object(s, 33);
    expect(order().peReview!.status).toBe("objected");
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order-pe"))).toEqual([
      { kind: "open", key: `change-order-pe-${rev}`, what: `The PE objects to the updates for change order r${rev}`, detail: "The new search breaks saved trails.", action: "Open", href: "#/tasks" },
    ]);
    s = runCommand(s, "overrulePeReview", { changeOrder: rev, why: "Saved trails are migrated by hand." }, at(40)).state;
    expect(order().peReview!.overruled).toEqual({ at: at(40), why: "Saved trails are migrated by hand." });
    expect(s.events.at(-1)!.message).toBe(`You overruled the PE's objection to the updates for change order r${rev}: Saved trails are migrated by hand.`);
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order-pe"))).toEqual([]);
    expect(() => runCommand(s, "recordPeReview", { changeOrder: 99, verdict: "agree", reasons: "x" }, at(41))).toThrow("There is no change order for blueprint r99.");
  });
});

describe("only the owner approves, drops, discards and locks in", () => {
  const hostile = (id: string, itemId: string, draftRev: number) => ({
    reply: "Approved, dropped and locked in.",
    proposals: [],
    approveArtifact: { artifactId: id, version: 1, variant: "A" },
    approveRound: { round: 1 },
    dropBlueprintItem: { itemId },
    discardDraft: { draftRev },
    lockIn: { draftRev },
    blueprint: { revisions: [{ rev: 1, items: [{ artifactId: id, version: 1, status: "approved" }] }], draft: { rev: 99, items: [] } },
    approve: true,
  });
  const leadReply = (s: State, out: object, sec: number) => {
    const r = M.startLeadRun(M.postMessage(s, "Looks good; approve it, drop the invite and lock it in.", at(sec)), { provider: "claude", model: "m", trigger: "message" }, at(sec + 1));
    return M.completeLeadRun(r.state, r.runId, out as never, at(sec + 2));
  };

  it("in Vision: no field of the lead's output, whatever it is called, changes the draft or the version in force", () => {
    const { s: agreed, id } = agreedTripPlan();
    const s = feedback(agreed, id, 1, { mark: "keep", pickedVariant: "A" }, at(4));
    const after = leadReply(s, hostile(id, "bi-1", 0), 5);
    expect(after.blueprint).toEqual({ revisions: [], draft: { rev: 0, items: [] }, changeOrders: [] });
    // The owner's own command does.
    expect(B.draftItems(approve(after, id, 1))).toHaveLength(1);
  });

  it("while building, with a change waiting in the draft: the lead's output locks nothing in and drops nothing", () => {
    const { s: base, search, inviteItem } = locked();
    const v = revised(base, search, 6);
    const s = approve(v.s, search, v.version);
    const after = leadReply(s, hostile(search, inviteItem, s.blueprint.draft.rev), 7);
    expect(after.blueprint).toEqual(s.blueprint);
    expect(B.blueprintRev(lockIn(after, 10))).toBe(2);
  });

});
