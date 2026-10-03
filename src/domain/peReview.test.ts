// ORC-029 2e, PE review of new work in the factory: the domain hooks. With PE review of new work on, the lead's
// proposals and breakdown items wait for the PE's agreement before they start ("waiting for PE review"); an agreement
// releases them under the usual involvement rules; an objection after three rounds goes to Needs you, and the owner's
// overrule is recorded. Only the service records a verdict; nothing in the lead's output can. Code changes are never
// PE-reviewed. And the pre-flight counts the probes whose evidence is not in yet as open items.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as F from "./findings";
import * as M from "./model";
import { needsYouItems, needsYouOf } from "./needsYou";
import { buildSeed } from "./seed";
import { inVision, startFactoryArgs } from "./testing/factory";
import { ControlError, StaleWriteError, type State } from "./types";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};

/**
 * The sample project, building, on Autopilot (or Check-in), with its own tasks held. PE review of new work is on
 * unless `review: false`: pass 5 turns it on with the PE's review runs, so these tests set it as that will.
 */
function factory(opts: { review?: boolean; involvement?: "autopilot" | "checkin" } = {}): State {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  s = M.applyAutopilot(s, "main", at(0));
  if (opts.involvement === "checkin") s = M.setAutonomy(s, { ...s.project.autonomy, holdLeadProposals: true }, at(0));
  s.project.autonomy = { ...s.project.autonomy, maxOpenProposals: 50, maxProposalsPerCycle: 10 };
  if (opts.review !== false) s.project.peReviewsNewWork = true;
  return s;
}

const proposal = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  area: "Core",
  whyNow: "now",
  outcome: `${title} works`,
  benefit: "b",
  scopeIncluded: [],
  scopeExcluded: [],
  options: [
    { id: "A", name: "Do it", approach: "one way", benefit: "", effort: "", risks: "", reversibility: "" },
    { id: "B", name: "Defer", approach: "not now", benefit: "", effort: "", risks: "", reversibility: "" },
  ],
  recommendedOptionId: "A",
  rationale: "because",
  uncertainty: "",
  acceptance: ["it works"],
  flowId: "change",
  priority: 1,
  ...over,
});

/** One planning run of the lead's, through the real path, with this output. Returns the tasks it created. */
function leadPlans(s0: State, out: Record<string, unknown>, sec = 1): { s: State; created: string[] } {
  const r = M.startLeadRun(s0, { provider: "claude", model: "m", trigger: "planning" }, at(sec));
  const s = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], ...out } as never, at(sec + 1));
  return { s, created: s.conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds ?? [] };
}

/** Promote and dispatch, as the scheduler does on every tick. */
const go = (s: State, sec: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(sec)), at(sec));
const running = (s: State, id: string) => M.activeAttempts(s, id).length;
const verdict = (s: State, taskId: string, v: "agree" | "object", reasons: string, sec: number) => runCommand(s, "recordPeReview", { taskId, verdict: v, reasons, specRev: M.currentSpec(task(s, taskId)).rev }, at(sec)).state;

describe("a lead proposal waits for PE review", () => {
  it("a pending proposal never dispatches, on Autopilot, however long it waits; with PE review off it starts as before", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const [id] = created;
    expect(task(planned, id).peReview).toEqual({ status: "pending", rounds: [] });
    expect(task(planned, id).holdBeforeStart).toBe(false); // Autopilot: PE review is the only wait
    expect(planned.events.find((e) => e.taskId === id && e.message.startsWith("Proposed"))!.message).toBe(`Proposed ${id}: Offline maps (selected option A); waiting for PE review`);
    let s = planned;
    for (let h = 1; h <= 24; h++) s = go(s, h * 3600);
    expect(running(s, id)).toBe(0);
    expect(M.stateLabel(s, task(s, id))).toBe("Waiting for PE review");
    expect(needsYouOf(s, task(s, id))).toBeUndefined(); // the PE's to answer, not yours
    const off = leadPlans(factory({ review: false }), { proposals: [proposal("Offline maps")] });
    expect(task(off.s, off.created[0]).peReview).toBeUndefined();
    expect(running(go(off.s, 3600), off.created[0])).toBe(1);
  });

  it("an agreement releases it under the usual involvement rules: at once on Autopilot, after your go-ahead on Check-in", () => {
    const auto = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const agreed = verdict(auto.s, auto.created[0], "agree", "Fits the blueprint and the budget.", 10);
    expect(task(agreed, auto.created[0]).peReview).toEqual({ status: "agreed", rounds: [{ at: at(10), verdict: "agree", reasons: "Fits the blueprint and the budget.", specRev: 1 }] });
    expect(agreed.events.at(-1)!.message).toBe(`PE review of ${auto.created[0]}: agreed (Fits the blueprint and the budget.); it starts under your involvement setting`);
    expect(running(go(agreed, 11), auto.created[0])).toBe(1);

    const checkin = leadPlans(factory({ involvement: "checkin" }), { proposals: [proposal("Offline maps")] });
    const id = checkin.created[0];
    expect(M.stateLabel(go(checkin.s, 5), task(checkin.s, id))).toBe("Waiting for PE review");
    expect(needsYouOf(checkin.s, task(checkin.s, id))).toBeUndefined(); // PE review first, then your go-ahead
    let s = go(verdict(checkin.s, id, "agree", "Fine.", 10), 11);
    expect(running(s, id)).toBe(0);
    expect(M.stateLabel(s, task(s, id))).toBe("Waiting for your go-ahead");
    expect(needsYouOf(s, task(s, id))?.what).toBe("choose an option");
    s = go(M.startHeldTask(s, id, at(12)), 13);
    expect(running(s, id)).toBe(1);
  });

  it("an objection keeps it waiting while the lead revises it; after three rounds it goes to Needs you with the objection, never dropped", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    let s = verdict(planned, id, "object", "The tile cache has no size limit.", 10);
    expect(task(s, id).peReview!.status).toBe("pending");
    expect(s.events.at(-1)!.message).toBe(`PE review of ${id}: objects (The tile cache has no size limit.); round 1 of 3; the lead revises it`);
    s = verdict(s, id, "object", "Still no limit.", 11);
    expect([task(s, id).peReview!.status, M.stateLabel(s, task(s, id)), needsYouOf(s, task(s, id))]).toEqual(["pending", "Waiting for PE review", undefined]);
    s = verdict(s, id, "object", "No limit after three rounds: the cache grows without bound.", 12);
    expect(task(s, id).peReview).toMatchObject({ status: "objected", rounds: [{ verdict: "object" }, { verdict: "object" }, { verdict: "object" }] });
    expect(M.stateLabel(s, task(s, id))).toBe("The PE objects: needs you");
    expect(needsYouItems(s, T0).find((i) => i.key === id)).toMatchObject({ kind: "open", what: "answer the PE's objection", detail: "No limit after three rounds: the cache grows without bound.", href: `#/task/${id}` });
    expect(running(go(s, 13), id)).toBe(0);
    // The review is over: no fourth verdict, and the work stays until you decide.
    expect(() => verdict(s, id, "agree", "Changed my mind.", 14)).toThrow(`PE review of ${id} is finished (objected).`);
    expect(task(go(s, 3600 * 24), id).lifecycle).not.toBe("cancelled");
  });

  it("the owner overrules the objection, recorded, and the work is released; refused while the review is still going, twice, or without a reason", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    const overrule = (s: State, why: string, sec: number) => runCommand(s, "overrulePeReview", { taskId: id, why }, at(sec)).state;
    expect(() => overrule(planned, "Go.", 9)).toThrow(`PE review of ${id} is still going; it reaches you if the PE still objects after 3 rounds.`);
    let s = planned;
    for (const sec of [10, 11, 12]) s = verdict(s, id, "object", "The cache grows without bound.", sec);
    expect(() => overrule(s, "  ", 13)).toThrow("Say why you overrule the objection.");
    s = overrule(s, "Phones clear the cache themselves; ship it.", 13);
    expect(task(s, id).peReview).toMatchObject({ status: "objected", overruled: { at: at(13), why: "Phones clear the cache themselves; ship it." } });
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "decision", message: `You overruled the PE's objection to ${id}: Phones clear the cache themselves; ship it.` });
    expect(needsYouOf(s, task(s, id))).toBeUndefined();
    expect(running(go(s, 14), id)).toBe(1);
    expect(() => overrule(s, "Again.", 15)).toThrow("You already overruled this objection.");
  });

  it("your edit of work the PE objects to starts a new review with a fresh count of rounds; the objection stays on the record (review finding 5)", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps"), proposal("Trip export")] });
    const [id, other] = created;
    const objectThrice = (s0: State, taskId: string, sec: number) => [0, 1, 2].reduce((s, i) => verdict(s, taskId, "object", "The cache grows without bound.", sec + i), s0);
    let s = objectThrice(planned, id, 10);
    const rounds = task(s, id).peReview!.rounds;
    const edit = (s0: State, taskId: string, actor: "user" | "lead", sec: number) => M.editSpec(s0, taskId, M.currentSpec(task(s0, taskId)).rev, { ...M.currentSpec(task(s0, taskId)).content, outcome: "Offline maps, with a 200 MB cache" }, "cap the cache", actor, at(sec));
    // The lead's edit does not reopen it: an objection after three rounds is yours to answer.
    expect(task(edit(s, id, "lead", 19), id).peReview!.status).toBe("objected");
    s = edit(s, id, "user", 20);
    expect(task(s, id).peReview).toEqual({ status: "pending", rounds: [], earlier: [{ rounds, closedAt: at(20), specRev: 2 }] });
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "decision", taskId: id, message: "Your edit (spec r2) starts a new PE review of the work the PE objected to; the objection stays on the record" });
    expect(M.stateLabel(s, task(s, id))).toBe("Waiting for PE review");
    expect(needsYouOf(s, task(s, id))).toBeUndefined();
    // A fresh count: an objection is round 1 of 3 again, and an agreement releases the work.
    s = verdict(s, id, "object", "Still too big.", 21);
    expect(s.events.at(-1)!.message).toContain("round 1 of 3; the lead revises it");
    s = verdict(s, id, "agree", "200 MB is fine.", 22);
    expect(running(go(s, 23), id)).toBe(1);
    // An objection you overruled is settled: your edit does not reopen it.
    let o = runCommand(objectThrice(planned, other, 30), "overrulePeReview", { taskId: other, why: "Ship it." }, at(33)).state;
    o = edit(o, other, "user", 34);
    expect(task(o, other).peReview).toMatchObject({ status: "objected", overruled: { why: "Ship it." } });
  });

  it("a verdict reads the current spec: one on a revision the lead replaced is stale, and one that names none is refused", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    const edited = M.editSpec(planned, id, 1, { ...M.currentSpec(task(planned, id)).content, outcome: "Offline maps, with a size limit" }, "revised for the PE", "lead", at(5));
    expect(failure(() => runCommand(edited, "recordPeReview", { taskId: id, verdict: "agree", reasons: "Fine.", specRev: 1 }, at(6)))).toBeInstanceOf(StaleWriteError);
    expect(() => runCommand(edited, "recordPeReview", { taskId: id, verdict: "agree", reasons: "Fine." }, at(6))).toThrow(`A verdict on ${id} names the spec revision the PE read.`);
    expect(() => runCommand(edited, "recordPeReview", { taskId: id, verdict: "agree", reasons: " ", specRev: 2 }, at(6))).toThrow("A verdict states its reasons.");
    expect(() => runCommand(edited, "recordPeReview", { verdict: "agree", reasons: "x" }, at(6))).toThrow("name the work: taskId, or changeOrder");
    expect(task(verdict(edited, id, "agree", "Fine.", 6), id).peReview!.rounds[0].specRev).toBe(2);
  });
});

describe("breakdown items wait for PE review too", () => {
  it("each child of a breakdown made while building waits for the PE; an agreed one starts", () => {
    const s0 = factory();
    const goal = M.createTask(s0, { title: "Trips offline", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "goal" }, at(1));
    expect(task(goal.state, goal.newId).peReview).toBeUndefined(); // yours: never PE-reviewed
    let s = go(goal.state, 2);
    const [plan] = M.activeAttempts(s, goal.newId);
    const items = [{ title: "Tile cache", outcome: "Tiles are cached", approach: "small", acceptance: ["ok"] }, { title: "Cache limit", outcome: "The cache has a limit", approach: "small", acceptance: ["ok"] }];
    s = M.reportCompletion(s, plan.id, [], at(3), [{ name: "plan", summary: "the plan", items }]);
    const children = M.childTasks(s, task(s, goal.newId)).map((c) => c.id);
    expect(children.map((c) => task(s, c).peReview?.status)).toEqual(["pending", "pending"]);
    s = go(verdict(s, children[0], "agree", "Fine.", 4), 5);
    expect(children.map((c) => running(s, c))).toEqual([1, 0]);
    expect(M.stateLabel(s, task(s, children[1]))).toBe("Waiting for PE review");
  });
});

describe("the lead never cancels work under PE review: a PE objection is never dropped (review finding 1)", () => {
  /** The lead answers a message by dropping these tasks. Returns the state and each drop's steering row. */
  function leadDrops(s0: State, ids: string[], sec: number) {
    const msg = M.postMessage(s0, "trim the plan", at(sec));
    const r = M.startLeadRun(msg, { provider: "claude", model: "m", trigger: "message" }, at(sec + 1));
    const steer = { reason: "you asked to trim it", tasks: ids.map((id) => ({ id, drop: true, why: "not needed" })) };
    const s = M.completeLeadRun(r.state, r.runId, { reply: "Trimmed.", proposals: [], steer } as never, at(sec + 2));
    return { s, rows: Object.fromEntries(s.steering.at(-1)!.changes.map((c) => [c.taskId!, c])) };
  }
  const objected = (s0: State, id: string, sec: number) => [0, 1, 2].reduce((s, i) => verdict(s, id, "object", "The cache grows without bound.", sec + i), s0);

  it("steering only suggests the drop of a proposal the PE is reviewing or objects to; you apply it; once you overrule, or the PE agrees, the lead drops as before", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps"), proposal("Trip export"), proposal("Shared lists"), proposal("Map themes")] });
    const [pending, objects, overruled, agreed] = created;
    let s = objected(planned, objects, 10);
    s = runCommand(objected(s, overruled, 20), "overrulePeReview", { taskId: overruled, why: "Ship it." }, at(30)).state;
    s = verdict(s, agreed, "agree", "Fine.", 31);
    const { s: after, rows } = leadDrops(s, created, 40);
    expect([pending, objects].map((id) => [rows[id].status, rows[id].note, task(after, id).lifecycle])).toEqual([
      ["suggested", "the PE is reviewing it; only you cancel it", "proposed"],
      ["suggested", "the PE objects to it; only you overrule the objection or cancel it", "proposed"],
    ]);
    expect([overruled, agreed].map((id) => [rows[id].status, task(after, id).lifecycle])).toEqual([
      ["applied", "cancelled"],
      ["applied", "cancelled"],
    ]);
    // The objection still reaches you, and applying the suggestion is your cancel.
    expect(needsYouOf(after, task(after, objects))?.what).toBe("answer the PE's objection");
    const yours = M.applySteering(after, after.steering.at(-1)!.id, rows[objects].id, at(50)).state;
    expect(task(yours, objects)).toMatchObject({ lifecycle: "cancelled", cancelledBy: "user" });
  });

  it("a re-run breakdown keeps an unlisted child the PE is reviewing or objects to, and reports it; a near-duplicate title does not replace it", () => {
    const s0 = factory();
    const goal = M.createTask(s0, { title: "Trips offline", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "goal" }, at(1));
    let s = go(goal.state, 2);
    const [plan] = M.activeAttempts(s, goal.newId);
    const item = (title: string) => ({ title, outcome: `${title} works`, approach: "small", acceptance: ["ok"] });
    s = M.reportCompletion(s, plan.id, [], at(3), [{ name: "plan", summary: "the plan", items: [item("Tile cache"), item("Cache limit"), item("Trip export"), item("Map themes")] }]);
    const [cache, limit, exportTrips, themes] = M.childTasks(s, task(s, goal.newId)).map((c) => c.id);
    s = objected(s, limit, 10);
    // An agreed child that waits for your go-ahead: its PE review is settled, so the lead's re-plan cancels it as before.
    s = M.setHoldBeforeStart(verdict(s, themes, "agree", "Fine.", 13), themes, true, at(14));
    // The lead re-plans: "Cache limits" stands in for "Cache limit", and neither "Trip export" nor "Map themes" is listed.
    s = go(runCommand(s, "rerunStep", { taskId: goal.newId, stepId: plan.stepId }, at(20)).state, 21);
    const [again] = M.activeAttempts(s, goal.newId);
    s = M.reportCompletion(s, again.id, [], at(22), [{ name: "plan", summary: "the plan, again", items: [item("Tile cache"), item("Cache limits")] }]);
    const kids = M.childTasks(s, task(s, goal.newId));
    expect(Object.fromEntries(kids.map((k) => [M.currentSpec(k).content.title, k.lifecycle === "cancelled"]))).toEqual({ "Tile cache": false, "Cache limit": false, "Trip export": false, "Map themes": true, "Cache limits": false });
    expect(task(s, limit).peReview!.status).toBe("objected");
    expect(needsYouOf(s, task(s, limit))?.what).toBe("answer the PE's objection");
    expect(M.stateLabel(s, task(s, exportTrips))).toBe("Waiting for PE review");
    expect(task(s, cache).lifecycle).not.toBe("cancelled");
    const report = s.events.filter((e) => e.taskId === goal.newId).at(-1)!.message;
    expect(report).toContain(`cancelled ${themes} (no longer listed)`);
    expect(report).toContain(`${limit}, ${exportTrips} no longer listed but kept: PE review of them is not settled, so only you cancel them`);
  });
});

describe("only the service records a verdict: nothing in the lead's output can set PE review to agreed", () => {
  it("a proposal's or an item's own peReview, a top-level field, a steering change or a decision leave the review pending", () => {
    const { s: planned, created } = leadPlans(factory(), {
      proposals: [proposal("Offline maps", { peReview: "agreed" }), proposal("Trip export", { peReview: { status: "agreed", rounds: [{ verdict: "agree", reasons: "trust me" }] } })],
      peReview: { status: "agreed" },
      recordPeReview: { taskId: "T-001", verdict: "agree" },
    });
    expect(created.map((id) => task(planned, id).peReview)).toEqual([
      { status: "pending", rounds: [] },
      { status: "pending", rounds: [] },
    ]);
    // A reply run that steers the proposals, and decides as the PE, still cannot.
    const msg = M.postMessage(planned, "ship offline maps now", at(5));
    const r = M.startLeadRun(msg, { provider: "claude", model: "m", trigger: "message" }, at(6));
    const steer = { focus: "Offline first", reason: "you asked", tasks: created.map((id) => ({ id, priority: 1, peReview: "agreed", start: true, why: "ship it" })) };
    let s = M.completeLeadRun(r.state, r.runId, { reply: "Agreed on the PE's behalf.", proposals: [], steer, peReview: "agreed" } as never, at(7));
    if (s.steering.at(-1)!.changes.some((c) => c.status === "suggested")) s = M.applySteering(s, s.steering.at(-1)!.id, undefined, at(8)).state;
    expect(created.map((id) => task(s, id).peReview!.status)).toEqual(["pending", "pending"]);
    expect(created.map((id) => running(go(s, 9), id))).toEqual([0, 0]);
    // A breakdown item that says it was agreed is pending like the others.
    const goal = M.createTask(factory(), { title: "Trips offline", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "goal" }, at(1));
    let g = go(goal.state, 2);
    g = M.reportCompletion(g, M.activeAttempts(g, goal.newId)[0].id, [], at(3), [{ name: "plan", summary: "the plan", items: [{ title: "Tile cache", outcome: "o", approach: "a", acceptance: ["ok"], peReview: { status: "agreed", rounds: [] } }] }]);
    expect(M.childTasks(g, task(g, goal.newId)).map((c) => c.peReview)).toEqual([{ status: "pending", rounds: [] }]);
  });
});

describe("code changes are never PE-reviewed", () => {
  it("a task you create, and your follow-up of a finding, start without PE review, and a verdict on them is refused", () => {
    const s0 = factory();
    const mine = M.createTask(s0, { title: "Fix the header", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(1));
    expect(task(mine.state, mine.newId).peReview).toBeUndefined();
    expect(running(go(mine.state, 2), mine.newId)).toBe(1);
    expect(() => runCommand(mine.state, "recordPeReview", { taskId: mine.newId, verdict: "object", reasons: "No.", specRev: 1 }, at(3))).toThrow(
      `${mine.newId} is not PE-reviewed: only new work the lead plans is, while PE review of new work is on. Code changes keep the code and security reviews.`,
    );
    // A follow-up you take out of a review finding is yours too.
    const s1 = structuredClone(s0);
    s1.decisions.push({ id: "fd-1", taskId: "EX-004", artifactId: "x", findingId: "F1", key: "k".repeat(12), kind: "finding", finding: { source: "review", severity: "error", title: "Split the module", detail: "The module is too big." }, routedTo: "user", status: "open", usedBy: [], createdAt: at(1) });
    const followed = F.decideFinding(s1, "fd-1", "follow-up", undefined, at(2));
    expect(task(followed, followed.decisions[0].followUpTaskId!).peReview).toBeUndefined();
  });

  it("the roadmap planned in Vision is not held for PE review when the factory starts", () => {
    let s = inVision(factory(), at(1));
    s = leadPlans(M.postMessage(s, "plan it", at(2)), { proposals: [proposal("First step")] }, 3).s;
    const [planned] = M.roadmapTasks(s);
    expect(planned.peReview).toBeUndefined();
    s = runCommand(s, "startFactory", startFactoryArgs(s), at(5)).state;
    expect(running(go(s, 6), planned.id)).toBe(1);
  });
});

describe("the pre-flight counts unfinished probes as open items", () => {
  it("a queued or running probe is listed and must be confirmed; a finished one is not; the start records it", () => {
    let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
    const probeId = (runCommand(s, "addProbe", { question: "Which forecast sources allow caching?" }, at(1)).result as { probeId: string }).probeId;
    s = runCommand(s, "addProbe", { question: "Which forecast sources allow caching?" }, at(1)).state;
    const areas = M.openAreas(s);
    expect(M.preflightOpenItems(s)).toEqual([...areas, probeId]);
    s = runCommand(s, "setProbeStatus", { probeId, status: "running", attemptId: "run-probe" }, at(2)).state;
    expect(M.preflightOpenItems(s)).toEqual([...areas, probeId]);
    const unconfirmed = failure(() => runCommand(s, "startFactory", { ...startFactoryArgs(s), acceptOpen: areas }, at(3)));
    expect(unconfirmed).toBeInstanceOf(ControlError);
    expect(unconfirmed.message).toBe(`Still open and not confirmed: ${probeId}. Confirm them to start, or close them first.`);
    const started = runCommand(s, "startFactory", startFactoryArgs(s), at(3)).state;
    expect(started.project.factoryStarts[0].openItems).toEqual([...areas, probeId]);
    expect(started.events.at(-1)!.message).toContain("and 1 unfinished probe confirmed (Which forecast sources allow caching?)");
    const failed = runCommand(s, "setProbeStatus", { probeId, status: "failed", failure: "No source answered" }, at(4)).state;
    expect(M.preflightOpenItems(failed)).toEqual(areas);
  });
});
