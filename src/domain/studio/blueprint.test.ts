// ORC-029 2c, the blueprint: the owner's approvals (one artifact or a whole round) make revisions; open items stay
// listed for the pre-flight, which Start the factory compares (the blueprint revision) and confirms; task specs cite
// items; a revision while building is a change order that follows the project's change-order setting; the lead
// never approves.

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
const MANUAL: FactorySettings = { autonomy: "manual", merge: "user", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };
const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};
const approve = (s: State, artifactId: string, version: number, variant?: string) => run(s, "approveArtifact", { artifactId, version, ...(variant ? { variant } : {}) }, at(50)).state;
/** Round 1 with the Trip plan screen (three variants) that the PE agreed to. */
function agreedTripPlan(s = fresh()) {
  const r = openRound(s, "experience", at(1));
  const a = addScreen(r.state, r.n, at(2));
  return { s: peAgrees(a.state, a.id, 1, ["A", "B", "C"], at(3)), id: a.id };
}
/** A single-take screen in the open round, agreed by the PE. */
function agreedScreen(s: State, round: number, title: string, sec: number) {
  const a = addScreen(s, round, at(sec), { title, variants: [] });
  return { s: peAgrees(a.state, a.id, 1, [], at(sec)), id: a.id };
}
function nextRound(s: State, sec: number) {
  const cur = S.currentRound(s)!;
  return openRound(runCommand(s, "closeRound", { round: cur.n }, at(sec)).state, "experience", at(sec));
}
/** A task of the owner's whose spec cites these blueprint items. */
function taskCiting(s: State, refs: string[], sec: number): { s: State; id: string } {
  const c = run<{ newId: string }>(s, "createTask", { title: `Build ${refs.join(" ")}`, area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at(sec));
  const t = c.state.tasks.find((x) => x.id === c.result.newId)!;
  const content: SpecContent = { ...M.currentSpec(t).content, blueprintRefs: refs };
  return { s: run(c.state, "editSpec", { taskId: t.id, expectedRev: 1, content, reason: "Cites the blueprint" }, at(sec)).state, id: t.id };
}

describe("approving into the blueprint", () => {
  it("approving one artifact makes a revision on the current vision; its item keeps its id across versions", () => {
    let { s, id } = agreedTripPlan();
    expect(B.blueprintRev(s)).toBe(0);
    s = feedback(s, id, 1, { mark: "keep", pickedVariant: "B" }, at(4));
    s = approve(s, id, 1);
    const item = B.blueprintItems(s)[0];
    expect(s.blueprint.revisions).toEqual([{ rev: 1, at: at(50), visionRev: 1, reason: "approved Trip plan v1 (Timeline)", items: [{ id: item.id, kind: "screen", title: "Trip plan", artifactId: id, version: 1, variant: "B", status: "approved" }] }]);
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "vision", message: "Blueprint r1: approved Trip plan v1 (Timeline)" });
    // A later version, another variant: the same item, a new revision on the vision as it now stands.
    s = M.editVision(s, 1, "Weekend trips for a small group of friends, offline on the trail.", "", "offline", at(5));
    const v2 = addScreen(nextRound(s, 6).state, 2, at(7), { artifactId: id });
    s = peAgrees(v2.state, id, 2, ["A", "B", "C"], at(8));
    s = approve(s, id, 2, "C");
    expect(B.currentBlueprint(s)).toMatchObject({ rev: 2, visionRev: 2, items: [{ id: item.id, version: 2, variant: "C", status: "approved" }] });
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
    expect(B.blueprintItems(approve(o, t.id, 3, "A"))[0]).toMatchObject({ variant: "A", status: "approved" });
    const objection = S.openObjections(o, S.getArtifact(o, t.id, 3))[0];
    o = run(o, "overruleObjection", { verdictId: objection.id, why: "The group pays for the forecasts." }, at(9)).state;
    expect(B.blueprintItems(approve(o, t.id, 3, "B"))[0]).toMatchObject({ variant: "B", status: "approved" });
  });

  it("a single take needs no pick; an artifact that replaces another takes over its item", () => {
    const r = openRound(fresh(), "experience", at(1));
    const first = agreedScreen(r.state, 1, "Invite sheet", 2);
    let s = approve(first.s, first.id, 1);
    const item = B.blueprintItems(s)[0];
    expect(item).toEqual({ id: item.id, kind: "screen", title: "Invite sheet", artifactId: first.id, version: 1, status: "approved" });
    const r2 = nextRound(s, 3);
    const merged = addScreen(r2.state, 2, at(4), { title: "Invite and join sheet", variants: [], supersedes: first.id });
    s = approve(peAgrees(merged.state, merged.id, 1, [], at(5)), merged.id, 1);
    expect(B.blueprintItems(s)).toEqual([{ id: item.id, kind: "screen", title: "Invite and join sheet", artifactId: merged.id, version: 1, status: "approved" }]);
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
    const items = B.blueprintItems(s);
    expect(items.map((i) => [i.title, i.status])).toEqual([
      ["Trail search", "approved"],
      ["Invite sheet", "open"],
      ["Group page", "approved"],
      ["Trip plan", "open"],
      ["Offline banner", "open"],
    ]);
    expect(B.currentBlueprint(s)?.reason).toBe("approved round 1: 2 approved, 3 still open");
    expect(B.openBlueprintItems(s).map((o) => [o.item.title, o.why])).toEqual([
      ["Invite sheet", "you marked it Change"],
      ["Trip plan", "your pick between its variants is open"],
      ["Offline banner", "waiting for PE review"],
    ]);
    // The owner picks; the item is ready for approval, then approved.
    s = feedback(s, plan.id, 1, { mark: "keep", pickedVariant: "C" }, at(11));
    expect(B.openBlueprintItems(s).find((o) => o.item.title === "Trip plan")?.why).toBe("ready for your approval");
    s = approve(s, plan.id, 1);
    expect(B.blueprintItems(s).find((i) => i.title === "Trip plan")).toMatchObject({ variant: "C", status: "approved" });
    // A new version of an approved screen marked Change in round 2: approving round 2 keeps the approved version.
    const r2 = nextRound(s, 12);
    const search2 = addScreen(r2.state, 2, at(13), { artifactId: search.id, variants: [] });
    s = feedback(peAgrees(search2.state, search.id, 2, [], at(14)), search.id, 2, { mark: "change" }, at(15));
    expect(() => run(s, "approveRound", { round: 2 }, at(16))).toThrow("Round 2 is already in the blueprint as it stands.");
    expect(B.blueprintItems(s).find((i) => i.title === "Trail search")).toMatchObject({ version: 1, status: "approved" });
    expect(() => run(s, "approveRound", { round: 7 }, at(16))).toThrow("There is no round 7.");
    expect(() => run(openRound(fresh(), "experience", at(1)).state, "approveRound", { round: 1 }, at(2))).toThrow("Round 1 has no artifacts to approve.");
  });
});

describe("the pre-flight and Start the factory", () => {
  it("compares the blueprint revision (0 while empty) and names the blueprint's open items beside the open areas", () => {
    const { s: agreed, id } = agreedTripPlan();
    const before = startFactoryArgs(agreed, MANUAL);
    expect(before).toMatchObject({ blueprintRev: 0, visionRev: 1 });
    let s = run(agreed, "approveRound", { round: 1 }, at(10)).state; // Trip plan is open: no variant picked
    const open = B.blueprintItems(s)[0];
    expect(failure(() => runCommand(s, "startFactory", before, at(11)))).toBeInstanceOf(StaleWriteError);
    const areas = M.openAreas(s);
    expect(M.preflightOpenItems(s)).toEqual([...areas, open.id]);
    const args = startFactoryArgs(s, MANUAL);
    expect(() => runCommand(s, "startFactory", { ...args, acceptOpen: areas }, at(11))).toThrow(`Still open and not confirmed: ${open.id}. Confirm them to start, or close them first.`);
    s = runCommand(s, "startFactory", args, at(11)).state;
    expect(s.project.factoryStarts).toEqual([{ at: at(11), by: "user", blueprintRev: 1, visionRev: 1, settings: MANUAL, openItems: [...areas, open.id] }]);
    expect(s.events.at(-1)?.message).toBe(`Building started: you agreed to vision r1 and blueprint r1 with 9 open areas confirmed (${areas.join(", ")}) and 1 open blueprint item confirmed (Trip plan)`);
    expect(id).toBe(open.artifactId);
  });
});

describe("task specs cite blueprint items", () => {
  it("each reference must name an item of the blueprint; a repeat is kept once", () => {
    const { s: agreed, id } = agreedTripPlan();
    const s = approve(agreed, id, 1, "A");
    const item = B.blueprintItems(s)[0];
    const cited = taskCiting(s, [item.id, item.id], 20);
    expect(M.currentSpec(cited.s.tasks.find((t) => t.id === cited.id)!).content.blueprintRefs).toEqual([item.id]);
    expect(() => taskCiting(s, [item.id, "bi-404"], 21)).toThrow("Not in the blueprint: bi-404.");
    const t = cited.s.tasks.find((x) => x.id === cited.id)!;
    expect(() => runCommand(cited.s, "editSpec", { taskId: t.id, expectedRev: 2, content: { ...M.currentSpec(t).content, blueprintRefs: item.id }, reason: "r" }, at(22))).toThrow(InvalidCommandError);
  });
});

describe("change orders", () => {
  /** In Vision: Trail search and Invite sheet approved; tasks citing them; one citing Trail search is cancelled. */
  function planned() {
    let s = openRound(fresh(), "experience", at(1)).state;
    const search = agreedScreen(s, 1, "Trail search", 2);
    const invite = agreedScreen(search.s, 1, "Invite sheet", 3);
    s = run(invite.s, "approveRound", { round: 1 }, at(4)).state;
    const [searchItem, inviteItem] = B.blueprintItems(s).map((i) => i.id);
    const t1 = taskCiting(s, [searchItem], 5);
    const t2 = taskCiting(t1.s, [inviteItem], 6);
    const t3 = taskCiting(t2.s, [searchItem, inviteItem], 7);
    s = runCommand(t3.s, "cancelTask", { taskId: t3.id }, at(8)).state;
    return { s, search: search.id, searchItem, tasks: [t1.id, t2.id, t3.id] };
  }
  /** A revision of Trail search in the next round, approved: a new blueprint revision. */
  const reviseSearch = (s: State, searchId: string, sec: number) => {
    const r = nextRound(s, sec);
    const v = addScreen(r.state, r.n, at(sec), { artifactId: searchId, title: "Trail search", variants: [] });
    const version = v.version;
    return approve(peAgrees(v.state, searchId, version, [], at(sec)), searchId, version);
  };

  it("in Vision a revision is no change order; while building it lists the tasks whose current spec cites a changed item, and is marked for the lead", () => {
    const { s: shaping, search, searchItem, tasks } = planned();
    expect(reviseSearch(shaping, search, 10).blueprint.changeOrders).toEqual([]);
    let s = startFactoryAsOwner(shaping, at(9), MANUAL);
    s = reviseSearch(s, search, 10);
    const rev = B.blueprintRev(s);
    expect(s.blueprint.changeOrders).toEqual([{ rev, at: at(50), changedItems: [searchItem], affectedTasks: [tasks[0]], status: "open", handler: "lead" }]);
    expect(s.events.at(-1)).toMatchObject({ actor: "system", message: `Change order for blueprint r${rev}: it touches ${tasks[0]}; the lead updates the affected tasks` });
    expect(B.openChangeOrders(s, "lead").map((c) => c.rev)).toEqual([rev]);
    expect(needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order"))).toEqual([]);
  });

  it("with change orders set to you, it waits under Needs you; an open one keeps the handler it was made with", () => {
    const { s: shaping, search, tasks } = planned();
    let s = startFactoryAsOwner(shaping, at(9), MANUAL);
    s = reviseSearch(s, search, 10);
    const leads = B.blueprintRev(s);
    s = runCommand(s, "setChangeOrders", { who: "user" }, at(20)).state;
    expect(s.project.changeOrders).toBe("user");
    expect(M.currentFactorySettings(s).pausePoints.changeOrders).toBe("user");
    s = reviseSearch(s, search, 30);
    const yours = B.blueprintRev(s);
    expect(s.blueprint.changeOrders.map((c) => [c.rev, c.handler])).toEqual([
      [leads, "lead"],
      [yours, "user"],
    ]);
    const waiting = needsYouItems(s, T0).filter((i) => i.key.startsWith("change-order"));
    expect(waiting).toEqual([
      { kind: "open", key: `change-order-${yours}`, what: `Change order: blueprint r${yours}`, detail: `You changed the blueprint: Trail search (v3). It touches ${tasks[0]}. You asked to look before the lead updates tasks.`, action: "Open", href: "#/tasks" },
    ]);
    expect(() => runCommand(s, "setChangeOrders", { who: "pe" }, at(40))).toThrow(InvalidCommandError);
  });
});

describe("only the owner approves", () => {
  it("no field of the lead's output, whatever it is called, makes a blueprint revision", () => {
    const { s: agreed, id } = agreedTripPlan();
    const s = feedback(agreed, id, 1, { mark: "keep", pickedVariant: "A" }, at(4));
    const r = M.startLeadRun(M.postMessage(s, "Looks good; approve it into the blueprint.", at(5)), { provider: "claude", model: "m", trigger: "message" }, at(6));
    const hostile = {
      reply: "Approved the Trip plan and round 1.",
      proposals: [],
      approveArtifact: { artifactId: id, version: 1, variant: "A" },
      approveRound: { round: 1 },
      blueprint: { revisions: [{ rev: 1, items: [{ artifactId: id, version: 1, status: "approved" }] }] },
      approve: true,
    };
    const after = M.completeLeadRun(r.state, r.runId, hostile as never, at(7));
    expect(after.blueprint).toEqual({ revisions: [], changeOrders: [] });
    // The owner's own command does.
    expect(B.blueprintRev(approve(after, id, 1))).toBe(1);
  });
});
