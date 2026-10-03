// ORC-029, PE review of new work in the factory: the hooks of 2e, switched on in pass 5. With PE review of new work
// on, the lead's proposals, a Goal's breakdown (before its child tasks exist) and a Feature's design (before a coder
// builds it) wait for the PE ("waiting for PE review"). The PE answers in pass 4e's shape: feasible releases the
// work; a change sends it back to the lead (a proposal) or to the step that made it (a breakdown, a design); after
// three rounds, or when the lead leaves a proposal as it is, it goes to Needs you with the objection, and the owner's
// overrule is recorded. Only the service records a verdict; nothing in the lead's output can. Code changes are never
// PE-reviewed. And the pre-flight counts the probes whose evidence is not in yet as open items.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as F from "./findings";
import * as M from "./model";
import { needsYouItems, needsYouOf } from "./needsYou";
import * as P from "./peReview";
import { buildSeed } from "./seed";
import * as R from "./studio/runs";
import { inVision, startFactoryArgs } from "./testing/factory";
import { ControlError, StaleWriteError, type State } from "./types";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
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
 * unless `review: false` (the sample started building before the setting existed, so it loads with it off).
 */
function factory(opts: { review?: boolean; involvement?: "autopilot" | "checkin" } = {}): State {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  s = M.applyAutopilot(s, "main", at(0));
  if (opts.involvement === "checkin") s = M.setAutonomy(s, { ...s.project.autonomy, holdLeadProposals: true }, at(0));
  s.project.autonomy = { ...s.project.autonomy, maxOpenProposals: 50, maxProposalsPerCycle: 10 };
  if (opts.review !== false) s = runCommand(s, "setPeReviewsNewWork", { on: true }, at(0)).state;
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

/** One lead run through the real path, with this output. Returns the tasks it created. */
function leadRun(s0: State, out: Record<string, unknown>, sec = 1, trigger: "planning" | "pe-review" = "planning"): { s: State; created: string[] } {
  const r = M.startLeadRun(s0, { provider: "claude", model: "m", trigger }, at(sec));
  const s = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], ...out } as never, at(sec + 1));
  return { s, created: s.conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds ?? [] };
}
const leadPlans = (s0: State, out: Record<string, unknown>, sec = 1) => leadRun(s0, out, sec, "planning");
/** The lead revises a proposal the PE sent back, in a run started for it. */
const leadRevises = (s0: State, id: string, sec: number, over: Record<string, unknown> = {}) =>
  leadRun(s0, { proposals: [proposal(M.currentSpec(task(s0, id)).content.title, { outcome: "Offline maps, with a 200 MB tile cache", revises: id, ...over })] }, sec, "pe-review").s;

/** Promote and dispatch, as the scheduler does on every tick. */
const go = (s: State, sec: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(sec)), at(sec));
const running = (s: State, id: string) => M.activeAttempts(s, id).length;
const CHANGE = "Cap the tile cache at 200 MB.";

/**
 * One PE verdict as its run would send it: on a proposal (`taskId`) or on what a step made (`stepId`), naming what it
 * read; on a later round it checks each earlier ask, met when it agrees and not met when it asks again.
 */
function pe(s: State, target: { taskId: string; stepId?: string }, verdict: "feasible" | "feasible-if" | "not-feasible", sec: number, over: Record<string, unknown> = {}): State {
  const t = task(s, target.taskId);
  const st = target.stepId === undefined ? undefined : step(s, t.id, target.stepId);
  const review = st ? st.peReview! : t.peReview!;
  const earlier = P.earlierAsksOf(review).map((x) => ({ ask: x.id, met: verdict === "feasible" }));
  const read = st ? { version: P.reviewedVersion(s, t, st) } : { specRev: M.currentSpec(t).rev };
  return runCommand(s, "recordPeReview", { ...target, verdict, reasons: `${verdict}: the reasons`, ...(verdict === "feasible-if" ? { change: CHANGE } : {}), ...(earlier.length ? { earlier } : {}), ...read, ...over }, at(sec)).state;
}

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

  it("feasible releases it under the usual involvement rules: at once on Autopilot, after your go-ahead on Check-in", () => {
    const auto = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const agreed = pe(auto.s, { taskId: auto.created[0] }, "feasible", 10, { reasons: "Fits the blueprint and the budget." });
    expect(task(agreed, auto.created[0]).peReview).toEqual({ status: "agreed", rounds: [{ at: at(10), verdict: "feasible", reasons: "Fits the blueprint and the budget.", specRev: 1 }] });
    expect(agreed.events.at(-1)!.message).toBe(`PE review of ${auto.created[0]}: agreed (Fits the blueprint and the budget.); it starts under your involvement setting`);
    expect(running(go(agreed, 11), auto.created[0])).toBe(1);

    const checkin = leadPlans(factory({ involvement: "checkin" }), { proposals: [proposal("Offline maps")] });
    const id = checkin.created[0];
    expect(M.stateLabel(go(checkin.s, 5), task(checkin.s, id))).toBe("Waiting for PE review");
    expect(needsYouOf(checkin.s, task(checkin.s, id))).toBeUndefined(); // PE review first, then your go-ahead
    let s = go(pe(checkin.s, { taskId: id }, "feasible", 10), 11);
    expect(running(s, id)).toBe(0);
    expect(M.stateLabel(s, task(s, id))).toBe("Waits for you");
    expect(needsYouOf(s, task(s, id))?.what).toBe("choose an option");
    s = go(M.startHeldTask(s, id, at(12)), 13);
    expect(running(s, id)).toBe(1);
  });

  it("a change goes to the lead, which revises the proposal in a run of its own; the PE checks its ask on the revision and agrees", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    let s = pe(planned, { taskId: id }, "feasible-if", 10, { openCases: [{ text: "Should the cache follow the trip or the device?", why: "It decides what syncs." }] });
    expect(task(s, id).peReview!.status).toBe("pending");
    expect(s.events.at(-1)!.message).toBe(`PE review of ${id}: asks for a change (feasible-if: the reasons); round 1 of 3; the lead revises it; 1 question for you, through the lead`);
    expect(P.proposalsToRevise(s).map((t) => t.id)).toEqual([id]);
    // The lead is due for the revision, without autonomy's planning caps.
    expect(M.leadDue(s, T0 + 20_000, 12 * 60)).toBe("pe-review");
    expect(P.newWorkReviewsDue(s)).toEqual([]); // nothing for the PE until the lead revises
    s = leadRevises(s, id, 20);
    expect(M.currentSpec(task(s, id))).toMatchObject({ rev: 2, author: "lead", reason: "Revised for the PE (round 1 asked for a change)", content: { outcome: "Offline maps, with a 200 MB tile cache" } });
    expect(s.conversation.at(-1)!.text).toBe("ok");
    expect(P.newWorkReviewsDue(s)).toEqual([{ taskId: id, specRev: 2 }]);
    expect(M.stateLabel(s, task(s, id))).toBe("Waiting for PE review");
    // The second round checks the earlier ask ("r1") first.
    expect(() => pe(s, { taskId: id }, "feasible", 30, { earlier: [] })).toThrow("leaves out earlier ask r1");
    s = pe(s, { taskId: id }, "feasible", 30);
    expect(task(s, id).peReview).toMatchObject({ status: "agreed", rounds: [{ verdict: "feasible-if", specRev: 1 }, { verdict: "feasible", specRev: 2, earlier: [{ ask: "r1", met: true }] }] });
    expect(running(go(s, 31), id)).toBe(1);
  });

  it("a later round that grows the asks is refused (pass 4e): a new change answers an ask not met, or a risk the revision created", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    const s = leadRevises(pe(planned, { taskId: id }, "feasible-if", 10), id, 20);
    const grows = failure(() => pe(s, { taskId: id }, "feasible-if", 30, { earlier: [{ ask: "r1", met: true }], change: "Also add trip sharing." }));
    expect(grows).toBeInstanceOf(ControlError);
    expect(grows.message).toContain("it finds every earlier ask met");
    const fromRevision = pe(s, { taskId: id }, "feasible-if", 30, { earlier: [{ ask: "r1", met: true }], fromRevision: true, change: "The 200 MB cap needs an eviction order." });
    expect(task(fromRevision, id).peReview!.rounds.at(-1)).toMatchObject({ verdict: "feasible-if", fromRevision: true });
  });

  it("after three rounds, or when the lead leaves it as it was, it goes to Needs you with the objection, never dropped", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps"), proposal("Trip export")] });
    const [id, other] = created;
    let s = pe(planned, { taskId: id }, "not-feasible", 10);
    s = leadRevises(s, id, 11);
    s = pe(s, { taskId: id }, "not-feasible", 13);
    s = leadRevises(s, id, 14, { outcome: "Offline maps, smaller" });
    expect([task(s, id).peReview!.status, M.stateLabel(s, task(s, id)), needsYouOf(s, task(s, id))]).toEqual(["pending", "Waiting for PE review", undefined]);
    s = pe(s, { taskId: id }, "not-feasible", 16, { reasons: "No limit after three rounds: the cache grows without bound." });
    expect(task(s, id).peReview).toMatchObject({ status: "objected", rounds: [{ verdict: "not-feasible" }, { verdict: "not-feasible" }, { verdict: "not-feasible" }] });
    expect(M.stateLabel(s, task(s, id))).toBe("The PE objects: needs you");
    expect(needsYouItems(s, T0).find((i) => i.key === id)).toMatchObject({ kind: "open", what: "answer the PE's objection", detail: "No limit after three rounds: the cache grows without bound.", href: `#/task/${id}` });
    expect(running(go(s, 17), id)).toBe(0);
    expect(() => pe(s, { taskId: id }, "feasible", 18)).toThrow(`PE review of ${id} is finished (objected).`);
    expect(task(go(s, 3600 * 24), id).lifecycle).not.toBe("cancelled");
    // The lead is shown the other proposal's change and answers without revising it: the objection is yours.
    s = pe(s, { taskId: other }, "feasible-if", 20);
    const left = leadRun(s, { reply: "The PE is wrong about export." } as never, 21, "pe-review").s;
    expect(task(left, other).peReview!.status).toBe("objected");
    expect(left.conversation.at(-1)!.rejected).toContain(`${other}: not revised, so the PE's objection goes to you`);
    expect(needsYouOf(left, task(left, other))?.what).toBe("answer the PE's objection");
    expect(M.leadDue(left, T0 + 60_000, 12 * 60)).not.toBe("pe-review");
  });

  it("only work the PE sent back can be revised: a revises naming any other task is refused and changes nothing", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    const s = leadRun(planned, { proposals: [proposal("Offline maps", { revises: id })] }, 5, "pe-review").s;
    expect(M.currentSpec(task(s, id)).rev).toBe(1);
    expect(s.conversation.at(-1)!.rejected).toEqual([`"Offline maps": ${id} is not work the PE sent back for revision`]);
  });

  it("the owner overrules the objection, recorded, and the work is released; refused while the review is still going, twice, or without a reason", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    const overrule = (s: State, why: string, sec: number) => runCommand(s, "overrulePeReview", { taskId: id, why }, at(sec)).state;
    expect(() => overrule(planned, "Go.", 9)).toThrow(`PE review of ${id} is still going; it reaches you if the PE still asks for a change after 3 rounds.`);
    const s0 = pe(planned, { taskId: id }, "feasible-if", 10);
    let s = leadRun(s0, {}, 11, "pe-review").s; // the lead leaves it as it was
    expect(() => overrule(s, "  ", 13)).toThrow("Say why you overrule the objection.");
    s = overrule(s, "Phones clear the cache themselves; ship it.", 13);
    expect(task(s, id).peReview).toMatchObject({ status: "objected", overruled: { at: at(13), why: "Phones clear the cache themselves; ship it." } });
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "decision", message: `You overruled the PE's objection to ${id}: Phones clear the cache themselves; ship it.` });
    expect(needsYouOf(s, task(s, id))).toBeUndefined();
    expect(running(go(s, 14), id)).toBe(1);
    expect(() => overrule(s, "Again.", 15)).toThrow("You already overruled this objection.");
  });

  it("a revision that keeps the owner's option id but rewrites its approach is refused; one that keeps it as it is applies (pass 6 review finding 6)", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    const cur = M.currentSpec(task(planned, id));
    let s = M.editSpec(planned, id, cur.rev, { ...cur.content, selectedOptionId: "B", decidedBy: "user", overrideReason: "Not this month." }, "my call", "user", at(5));
    s = pe(s, { taskId: id }, "feasible-if", 10);
    const rev = M.currentSpec(task(s, id)).rev;
    const options = [
      { id: "A", name: "Do it", approach: "one way" },
      { id: "B", name: "Defer", approach: "Ship it next week instead" },
    ];
    const refused = leadRevises(s, id, 20, { options });
    expect(M.currentSpec(task(refused, id)).rev).toBe(rev);
    expect(refused.conversation.at(-1)!.rejected?.join("\n")).toContain("keep option B (Defer) as it is: the user chose it");
    const kept = leadRevises(s, id, 20);
    expect(M.currentSpec(task(kept, id))).toMatchObject({ rev: rev + 1, content: { selectedOptionId: "B", decidedBy: "user", outcome: "Offline maps, with a 200 MB tile cache" } });
  });

  it("your edit of work the PE objects to starts a new review with a fresh count of rounds; the objection stays on the record (review finding 5)", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    let s = leadRun(pe(planned, { taskId: id }, "feasible-if", 10), {}, 11, "pe-review").s;
    const rounds = task(s, id).peReview!.rounds;
    const edit = (s0: State, actor: "user" | "lead", sec: number) => M.editSpec(s0, id, M.currentSpec(task(s0, id)).rev, { ...M.currentSpec(task(s0, id)).content, outcome: "Offline maps, with a 200 MB cache" }, "cap the cache", actor, at(sec));
    // The lead's edit does not reopen it: an objection that reached you is yours to answer.
    expect(task(edit(s, "lead", 19), id).peReview!.status).toBe("objected");
    s = edit(s, "user", 20);
    expect(task(s, id).peReview).toEqual({ status: "pending", rounds: [], earlier: [{ rounds, closedAt: at(20), specRev: 2 }] });
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "decision", taskId: id, message: "Your edit (spec r2) starts a new PE review of the work the PE objected to; the objection stays on the record" });
    expect(M.stateLabel(s, task(s, id))).toBe("Waiting for PE review");
    s = pe(s, { taskId: id }, "feasible", 22); // a fresh count: no earlier asks to check
    expect(running(go(s, 23), id)).toBe(1);
  });

  it("a verdict reads the current spec: one on a revision since replaced is stale, and one that names none is refused", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    const edited = M.editSpec(planned, id, 1, { ...M.currentSpec(task(planned, id)).content, outcome: "Offline maps, with a size limit" }, "a correction", "lead", at(5));
    expect(failure(() => runCommand(edited, "recordPeReview", { taskId: id, verdict: "feasible", reasons: "Fine.", specRev: 1 }, at(6)))).toBeInstanceOf(StaleWriteError);
    expect(() => runCommand(edited, "recordPeReview", { taskId: id, verdict: "feasible", reasons: "Fine." }, at(6))).toThrow(`A verdict on ${id} names the spec revision the PE read.`);
    expect(() => runCommand(edited, "recordPeReview", { taskId: id, verdict: "feasible", reasons: " ", specRev: 2 }, at(6))).toThrow("The verdict's reasons is empty.");
    expect(() => runCommand(edited, "recordPeReview", { taskId: id, verdict: "feasible-if", reasons: "x", specRev: 2 }, at(6))).toThrow("Feasible-if states the change that makes it feasible.");
    expect(() => runCommand(edited, "recordPeReview", { verdict: "feasible", reasons: "x" }, at(6))).toThrow("name the work: taskId");
    expect(task(pe(edited, { taskId: id }, "feasible", 6), id).peReview!.rounds[0].specRev).toBe(2);
  });
});

/** A Goal task of the owner's, its plan step run and completed with these items. */
function goalPlanned(s0: State, items: { title: string }[]) {
  const goal = M.createTask(s0, { title: "Trips offline", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "goal" }, at(1));
  let s = go(goal.state, 2);
  const [plan] = M.activeAttempts(s, goal.newId);
  const full = items.map((i) => ({ outcome: `${i.title} works`, approach: "small", acceptance: ["ok"], ...i }));
  s = M.reportCompletion(s, plan.id, [], at(3), [{ name: "plan", summary: "the plan", items: full }]);
  return { s, id: goal.newId, stepId: plan.stepId };
}

describe("a Goal's breakdown waits for PE review before its child tasks exist", () => {
  it("no child exists, and nothing after the plan starts, until the PE agrees; then the children start with no review of their own", () => {
    const { s: planned, id, stepId } = goalPlanned(factory(), [{ title: "Tile cache" }, { title: "Cache limit" }]);
    expect(task(planned, id).peReview).toBeUndefined(); // yours: the task itself is never PE-reviewed
    expect(step(planned, id, stepId).peReview).toEqual({ status: "pending", rounds: [] });
    expect(M.childTasks(planned, task(planned, id))).toEqual([]);
    expect(planned.events.find((e) => e.taskId === id && e.message.includes("waits for PE review"))!.message).toBe(`${stepId}'s breakdown waits for PE review before its child tasks are created`);
    let s = go(planned, 4);
    expect(running(s, id)).toBe(0); // S2 waits for the children, which do not exist yet
    expect(M.stateLabel(s, task(s, id))).toBe(`Waiting for PE review of ${stepId}'s breakdown`);
    expect(P.newWorkReviewsDue(s)).toEqual([{ taskId: id, stepId, version: 1 }]);
    s = pe(s, { taskId: id, stepId }, "feasible", 5);
    const children = M.childTasks(s, task(s, id));
    expect(children.map((c) => [M.currentSpec(c).content.title, c.peReview])).toEqual([
      ["Tile cache", undefined],
      ["Cache limit", undefined],
    ]);
    s = go(s, 6);
    expect(children.map((c) => running(s, c.id))).toEqual([1, 1]);
  });

  it("a change sends the plan back to its step, which runs again with it; the PE agrees to the revision and the children follow it", () => {
    const { s: planned, id, stepId } = goalPlanned(factory(), [{ title: "Tile cache" }]);
    let s = pe(planned, { taskId: id, stepId }, "feasible-if", 5);
    expect(step(s, id, stepId).state).toBe("pending");
    expect(s.events.filter((e) => e.taskId === id).at(-2)!.message).toMatch(new RegExp(`^Rerun ${stepId} \\(the PE asks for a change, round 1 of 3\\)`));
    expect(M.stateLabel(s, task(s, id))).toBe(`${stepId} revises its breakdown for the PE`);
    s = go(s, 6);
    const [again] = M.activeAttempts(s, id);
    expect(again.stepId).toBe(stepId);
    s = M.reportCompletion(s, again.id, [], at(7), [{ name: "plan", summary: "the plan, with a cache limit", items: [{ title: "Tile cache", outcome: "o", approach: "a", acceptance: ["ok"] }, { title: "Cache limit", outcome: "o", approach: "a", acceptance: ["ok"] }] }]);
    expect(step(s, id, stepId).peReview).toMatchObject({ status: "pending", rounds: [{ verdict: "feasible-if", version: 1 }] });
    expect(P.newWorkReviewsDue(s)).toEqual([{ taskId: id, stepId, version: 2 }]);
    // A verdict on the first version is stale.
    expect(failure(() => runCommand(s, "recordPeReview", { taskId: id, stepId, verdict: "feasible", reasons: "x", version: 1, earlier: [{ ask: "r1", met: true }] }, at(8)))).toBeInstanceOf(StaleWriteError);
    s = pe(s, { taskId: id, stepId }, "feasible", 8);
    expect(M.childTasks(s, task(s, id)).map((c) => M.currentSpec(c).content.title)).toEqual(["Tile cache", "Cache limit"]);
  });

  it("a breakdown with no items is no new work: the Goal goes on without the PE", () => {
    const { s, id, stepId } = goalPlanned(factory(), []);
    expect(step(s, id, stepId).peReview).toBeUndefined();
  });

  it("your edit of a breakdown the PE objects to is reviewed again; its children wait for the PE", () => {
    const { s: planned, id, stepId } = goalPlanned(factory(), [{ title: "Tile cache" }]);
    let s = planned;
    for (const sec of [5, 7, 9]) {
      s = pe(s, { taskId: id, stepId }, "not-feasible", sec);
      if (step(s, id, stepId).state === "pending") {
        s = go(s, sec);
        s = M.reportCompletion(s, M.activeAttempts(s, id)[0].id, [], at(sec + 1), [{ name: "plan", summary: "again", items: [{ title: "Tile cache", outcome: "o", approach: "a", acceptance: ["ok"] }] }]);
      }
    }
    expect(step(s, id, stepId).peReview!.status).toBe("objected");
    expect(needsYouOf(s, task(s, id))?.what).toBe("answer the PE's objection");
    expect(M.stateLabel(s, task(s, id))).toBe(`The PE objects to ${stepId}'s breakdown: needs you`);
    const art = M.acceptedOutput(s, task(s, id), stepId, "plan")!;
    s = M.editArtifact(s, art.id, { summary: "smaller", items: [{ title: "Tile cache, 50 MB", outcome: "o", approach: "a", acceptance: ["ok"] }], reason: "a smaller cache" }, at(20));
    expect(step(s, id, stepId).peReview).toMatchObject({ status: "pending", rounds: [], earlier: [{ version: art.version + 1 }] });
    expect(M.childTasks(s, task(s, id))).toEqual([]);
    s = pe(s, { taskId: id, stepId }, "feasible", 21);
    expect(M.childTasks(s, task(s, id)).map((c) => M.currentSpec(c).content.title)).toEqual(["Tile cache, 50 MB"]);
  });
});

/** A Feature task of the owner's, its design step run and completed. */
function featureDesigned(s0: State) {
  const f = M.createTask(s0, { title: "Trip home", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "feature" }, at(1));
  let s = go(f.state, 2);
  const [design] = M.activeAttempts(s, f.newId);
  s = M.reportCompletion(s, design.id, [], at(3), [{ name: "design", summary: "the trip home: one screen, three states" }]);
  return { s, id: f.newId, stepId: design.stepId };
}

describe("a Feature's design waits for PE review before it is built", () => {
  it("the implement step waits until the PE agrees; then it starts", () => {
    const { s: designed, id, stepId } = featureDesigned(factory());
    expect(step(designed, id, stepId).peReview).toEqual({ status: "pending", rounds: [] });
    let s = go(designed, 4);
    expect(running(s, id)).toBe(0);
    expect(M.stateLabel(s, task(s, id))).toBe(`Waiting for PE review of ${stepId}'s design`);
    expect(needsYouOf(s, task(s, id))).toBeUndefined();
    s = go(pe(s, { taskId: id, stepId }, "feasible", 5), 6);
    expect(M.activeAttempts(s, id).map((a) => a.snapshot.role)).toEqual(["coder"]);
    // With PE review off, the design is built at once.
    const off = featureDesigned(factory({ review: false }));
    expect(step(off.s, off.id, off.stepId).peReview).toBeUndefined();
    expect(M.activeAttempts(go(off.s, 4), off.id).map((a) => a.snapshot.role)).toEqual(["coder"]);
  });

  it("three rounds of changes go to Needs you; your overrule releases the design to be built", () => {
    const { s: designed, id, stepId } = featureDesigned(factory());
    let s = designed;
    for (const sec of [5, 7, 9]) {
      s = pe(s, { taskId: id, stepId }, "feasible-if", sec);
      if (step(s, id, stepId).state === "pending") {
        s = go(s, sec);
        expect(M.activeAttempts(s, id).map((a) => a.stepId)).toEqual([stepId]);
        s = M.reportCompletion(s, M.activeAttempts(s, id)[0].id, [], at(sec + 1), [{ name: "design", summary: `revised at ${sec}` }]);
      }
    }
    expect(step(s, id, stepId).peReview).toMatchObject({ status: "objected", rounds: [{ version: 1 }, { version: 2 }, { version: 3 }] });
    expect(needsYouItems(s, T0).find((i) => i.key === id)).toMatchObject({ what: "answer the PE's objection", detail: `feasible-if: the reasons The change it asks for: ${CHANGE}` });
    expect(running(go(s, 12), id)).toBe(0);
    s = runCommand(s, "overrulePeReview", { taskId: id, stepId, why: "The cache size is a setting; build it." }, at(13)).state;
    expect(M.activeAttempts(go(s, 14), id).map((a) => a.snapshot.role)).toEqual(["coder"]);
  });

  it("a design-only flow's design is not built, so it is not PE-reviewed", () => {
    const d = M.createTask(factory(), { title: "Explore", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "design" }, at(1));
    let s = go(d.state, 2);
    s = M.reportCompletion(s, M.activeAttempts(s, d.newId)[0].id, [], at(3), [{ name: "design", summary: "an exploration" }]);
    expect(task(s, d.newId).steps.map((x) => x.peReview)).toEqual(task(s, d.newId).steps.map(() => undefined));
  });
});

describe("the PE's runs on new work", () => {
  it("the service asks for one PE run per piece of new work, on the other provider than the maker's, only while building", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    let s = P.askForNewWorkReviews(planned, at(5));
    const runs = s.studio.runs.filter((r) => r.review);
    expect(runs.map((r) => ({ kind: r.kind, review: r.review, provider: r.provider, status: r.status, round: r.round }))).toEqual([{ kind: "pe", review: { taskId: id, specRev: 1 }, provider: "codex", status: "queued", round: undefined }]);
    expect(P.askForNewWorkReviews(s, at(6))).toBe(s); // one under way: nothing more
    s = R.dispatchStudioRuns(s, at(7)).state;
    expect(s.studio.runs.find((r) => r.review)!.status).toBe("running");
    // Before the factory starts, nothing is asked for new work.
    const vision = inVision(planned, at(8));
    expect(P.askForNewWorkReviews(vision, at(9))).toBe(vision);
  });

  it("a run whose work moved on is stale: it never starts, and its verdict is not recorded", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps")] });
    const id = created[0];
    let s = P.askForNewWorkReviews(planned, at(5));
    s = M.editSpec(s, id, 1, { ...M.currentSpec(task(s, id)).content, outcome: "changed" }, "a correction", "lead", at(6));
    s = R.dispatchStudioRuns(s, at(7)).state;
    expect(s.studio.runs.find((r) => r.review)).toMatchObject({ status: "failed", note: `not started: ${id}'s spec is r2 now, not r1` });
  });

  it("when the PE cannot run, or its runs end twice without a verdict, the work goes to you; your overrule starts it", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps"), proposal("Trip export")] });
    const [id, other] = created;
    let s = P.askForNewWorkReviews(planned, at(5));
    for (const sec of [6, 8]) {
      s = R.dispatchStudioRuns(s, at(sec)).state;
      for (const r of R.activeStudioRuns(s)) s = R.reportStudioRunFailed(s, r.id, "the provider timed out", at(sec));
      s = P.askForNewWorkReviews(s, at(sec + 1));
    }
    expect(task(s, id).peReview).toMatchObject({ status: "ended", ended: { by: "service", why: "the PE's runs on it ended 2 times without a verdict" } });
    expect(needsYouItems(s, T0).find((i) => i.key === id)).toMatchObject({ what: "decide without the PE's review", detail: "the PE's runs on it ended 2 times without a verdict" });
    expect(M.stateLabel(s, task(s, id))).toBe("PE review could not finish: needs you");
    s = runCommand(s, "overrulePeReview", { taskId: id, why: "Start it; I checked it myself." }, at(20)).state;
    expect(running(go(s, 21), id)).toBe(1);
    // No enabled provider can run the PE: the review ends at once, with the reason.
    const none = structuredClone(planned);
    none.project.roleDefaults.pe = { provider: "codex", model: "auto" };
    none.project.enabledProviders = ["claude"];
    const ended = P.askForNewWorkReviews(none, at(30));
    expect(task(ended, other).peReview).toMatchObject({ status: "ended", ended: { by: "service" } });
    expect(task(ended, other).peReview!.ended!.why).toMatch(/^the PE cannot run: /);
  });
});

describe("the setting: on for a new project, and the owner's to change", () => {
  it("a new project has PE review of new work on; the sample, which started before it existed, has it off", () => {
    const sample = buildSeed(T0, { inFlightRuns: false });
    expect(sample.project.peReviewsNewWork).toBe(false);
    expect(M.initProject(sample, { name: "Trips", repoPath: "/tmp/trips", vision: "v", focus: "" }, at(1)).project.peReviewsNewWork).toBe(true);
  });

  it("off releases the work the PE is still reviewing and its held breakdown, stops its runs, and keeps an objection that reached you", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps"), proposal("Trip export")] });
    const [pending, objected] = created;
    let s = leadRun(pe(planned, { taskId: objected }, "feasible-if", 2), {}, 3, "pe-review").s;
    const goal = goalPlanned(s, [{ title: "Tile cache" }]);
    s = P.askForNewWorkReviews(goal.s, at(4));
    s = R.dispatchStudioRuns(s, at(5)).state;
    s = runCommand(s, "setPeReviewsNewWork", { on: false }, at(6)).state;
    expect(task(s, pending).peReview).toMatchObject({ status: "ended", ended: { by: "owner", why: "you turned PE review of new work off" } });
    expect(running(go(s, 7), pending)).toBe(1);
    expect(M.childTasks(s, task(s, goal.id)).map((c) => M.currentSpec(c).content.title)).toEqual(["Tile cache"]);
    expect(task(s, objected).peReview!.status).toBe("objected");
    expect(needsYouOf(s, task(s, objected))?.what).toBe("answer the PE's objection");
    expect(s.studio.runs.filter((r) => r.review).map((r) => r.status)).not.toContain("running");
    expect(s.events.at(-1)!.message).toBe(`PE review of new work: off. New work starts without the PE; released ${pending}, ${goal.id} ${goal.stepId}. An objection that already reached you stays with you.`);
    expect(runCommand(s, "setPeReviewsNewWork", { on: false }, at(8)).state).toBe(s);
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

  it("steering only suggests the drop of a proposal the PE is reviewing or objects to; you apply it; once you overrule, or the PE agrees, the lead drops as before", () => {
    const { s: planned, created } = leadPlans(factory(), { proposals: [proposal("Offline maps"), proposal("Trip export"), proposal("Shared lists"), proposal("Map themes")] });
    const [pending, objects, overruled, agreed] = created;
    let s = pe(pe(planned, { taskId: objects }, "feasible-if", 10), { taskId: overruled }, "feasible-if", 11);
    s = leadRun(s, {}, 12, "pe-review").s; // the lead leaves both: they reach you
    s = runCommand(s, "overrulePeReview", { taskId: overruled, why: "Ship it." }, at(30)).state;
    s = pe(s, { taskId: agreed }, "feasible", 31);
    const { s: after, rows } = leadDrops(s, created, 40);
    expect([pending, objects].map((id) => [rows[id].status, rows[id].note, task(after, id).lifecycle])).toEqual([
      ["suggested", "the PE is reviewing it; only you cancel it", "proposed"],
      ["suggested", "the PE objects to it; only you overrule the objection or cancel it", "proposed"],
    ]);
    expect([overruled, agreed].map((id) => [rows[id].status, task(after, id).lifecycle])).toEqual([
      ["applied", "cancelled"],
      ["applied", "cancelled"],
    ]);
    expect(needsYouOf(after, task(after, objects))?.what).toBe("answer the PE's objection");
    const yours = M.applySteering(after, after.steering.at(-1)!.id, rows[objects].id, at(50)).state;
    expect(task(yours, objects)).toMatchObject({ lifecycle: "cancelled", cancelledBy: "user" });
  });
});

describe("only the service records a verdict: nothing in the lead's output can set PE review to agreed", () => {
  it("a proposal's or an item's own peReview, a top-level field, a steering change or a decision leave the review pending", () => {
    const { s: planned, created } = leadPlans(factory(), {
      proposals: [proposal("Offline maps", { peReview: "agreed" }), proposal("Trip export", { peReview: { status: "agreed", rounds: [{ verdict: "feasible", reasons: "trust me" }] } })],
      peReview: { status: "agreed" },
      recordPeReview: { taskId: "T-001", verdict: "feasible" },
    });
    expect(created.map((id) => task(planned, id).peReview)).toEqual([
      { status: "pending", rounds: [] },
      { status: "pending", rounds: [] },
    ]);
    const msg = M.postMessage(planned, "ship offline maps now", at(5));
    const r = M.startLeadRun(msg, { provider: "claude", model: "m", trigger: "message" }, at(6));
    const steer = { focus: "Offline first", reason: "you asked", tasks: created.map((id) => ({ id, priority: 1, peReview: "agreed", start: true, why: "ship it" })) };
    let s = M.completeLeadRun(r.state, r.runId, { reply: "Agreed on the PE's behalf.", proposals: [], steer, peReview: "agreed" } as never, at(7));
    if (s.steering.at(-1)!.changes.some((c) => c.status === "suggested")) s = M.applySteering(s, s.steering.at(-1)!.id, undefined, at(8)).state;
    expect(created.map((id) => task(s, id).peReview!.status)).toEqual(["pending", "pending"]);
    expect(created.map((id) => running(go(s, 9), id))).toEqual([0, 0]);
    // A breakdown item that says it was agreed: the breakdown still waits, and no child exists.
    const g = goalPlanned(factory(), [{ title: "Tile cache", peReview: { status: "agreed", rounds: [] } } as never]);
    expect(step(g.s, g.id, g.stepId).peReview).toEqual({ status: "pending", rounds: [] });
    expect(M.childTasks(g.s, task(g.s, g.id))).toEqual([]);
  });
});

describe("code changes are never PE-reviewed", () => {
  it("a task you create, and your follow-up of a finding, start without PE review, and a verdict on them is refused", () => {
    const s0 = factory();
    const mine = M.createTask(s0, { title: "Fix the header", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(1));
    expect(task(mine.state, mine.newId).peReview).toBeUndefined();
    expect(running(go(mine.state, 2), mine.newId)).toBe(1);
    expect(() => runCommand(mine.state, "recordPeReview", { taskId: mine.newId, verdict: "not-feasible", reasons: "No.", specRev: 1 }, at(3))).toThrow(
      `${mine.newId} is not PE-reviewed: only new work is (the lead's proposals, a Goal's breakdown, a Feature's design), while PE review of new work is on. Code changes keep the code and security reviews.`,
    );
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
