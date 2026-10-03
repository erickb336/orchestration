// Test helpers (pure): a factory with a change order that touches a running, a queued, a retiring and a landed task,
// and brings new work (ORC-029 pass 5, 5b). Not used by the application.

import { runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import * as B from "../studio/blueprint";
import type { FactorySettings, SpecContent, State } from "../types";
import { startFactoryAsOwner } from "./factory";
import { addScreen, feedback, lockInArgs, openRound, pePass, run } from "./studio";

export const T0 = Date.parse("2026-10-02T12:00:00Z");
export const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const MANUAL: FactorySettings = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };

/** A single-take screen in the open round, agreed by the PE. */
function screen(s: State, round: number, title: string, sec: number) {
  const a = addScreen(s, round, at(sec), { title, variants: [] });
  return { s: pePass(a.state, a.id, a.version, [{ verdict: "feasible" }], at(sec)), id: a.id };
}

/** A task of the owner's whose spec cites these blueprint items. */
export function taskCiting(s: State, refs: string[], title: string, sec: number): { s: State; id: string } {
  const c = run<{ newId: string }>(s, "createTask", { title, area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at(sec));
  const t = c.state.tasks.find((x) => x.id === c.result.newId)!;
  const content: SpecContent = { ...M.currentSpec(t).content, blueprintRefs: refs };
  return { s: run(c.state, "editSpec", { taskId: t.id, expectedRev: 1, content, reason: "Cites the blueprint" }, at(sec)).state, id: t.id };
}

/** The owner's go-ahead: the task starts (its first step runs). */
export const startTask = (s: State, taskId: string, sec: number) => M.dispatchEligible(M.leadPromoteProposals(M.startHeldTask(s, taskId, at(sec)), at(sec)), at(sec));

const item = (s: State, artifactId: string) => B.blueprintItems(s).find((i) => i.artifactId === artifactId)!.id;

/**
 * The factory runs from blueprint r1: Trip plan, Trip list and Reminders. Four tasks cite them: one runs (Trip plan),
 * one is queued (Trip list, citing Trip plan too), one is queued and builds only Reminders, and one has landed (an early
 * Trip plan, a fixture: landing runs the whole flow). The owner revises Trip plan (v2, after their note on v1), drops
 * Reminders and adds Packing list, and locks it in: a change order that touches all four tasks and brings one new item.
 */
export function changeOrdered(handler: "lead" | "user" = "lead") {
  let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
  s = openRound(s, "experience", at(1)).state;
  const plan = screen(s, 1, "Trip plan", 2);
  const list = screen(plan.s, 1, "Trip list", 3);
  const remind = screen(list.s, 1, "Reminders", 4);
  s = startFactoryAsOwner(run(remind.s, "approveRound", { round: 1 }, at(5)).state, at(6), { ...MANUAL, pausePoints: { ...MANUAL.pausePoints, changeOrders: handler } });
  const ids = { plan: item(s, plan.id), list: item(s, list.id), remind: item(s, remind.id) };
  const running = taskCiting(s, [ids.plan], "Trip plan screen", 7);
  const queued = taskCiting(running.s, [ids.plan, ids.list], "Trip list screen", 8);
  const retiring = taskCiting(queued.s, [ids.remind], "Outing reminders", 9);
  const early = taskCiting(retiring.s, [ids.plan], "Early trip plan", 10);
  s = startTask(early.s, running.id, 11);
  s = structuredClone(s);
  s.tasks.find((t) => t.id === early.id)!.lifecycle = "done";
  // The owner's draft: Trip plan v2 (after their note on v1), Reminders dropped, Packing list added. Then Lock in.
  s = feedback(s, plan.id, 1, { mark: "change", note: "Day list first, the map below it." }, at(12));
  s = openRound(runCommand(s, "closeRound", { round: 1 }, at(12)).state, "experience", at(12)).state;
  const v2 = addScreen(s, 2, at(13), { artifactId: plan.id, title: "Trip plan", variants: [] });
  s = run(pePass(v2.state, plan.id, 2, [{ verdict: "feasible" }], at(13)), "approveArtifact", { artifactId: plan.id, version: 2 }, at(14)).state;
  s = run(s, "dropBlueprintItem", { itemId: ids.remind }, at(15)).state;
  const packing = screen(s, 2, "Packing list", 16);
  s = run(packing.s, "approveArtifact", { artifactId: packing.id, version: 1 }, at(17)).state;
  s = runCommand(s, "lockIn", lockInArgs(s), at(18)).state;
  return { s, ids: { ...ids, packing: item(s, packing.id) }, tasks: { running: running.id, queued: queued.id, retiring: retiring.id, early: early.id } };
}

/** A lead proposal (spec content) as the lead's change order block gives it, citing `refs`. */
export const leadProposal = (title: string, refs?: string[]) => ({
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

/** The lead's full answer to `changeOrdered`: a spec update, two revisions, a retirement and a new task. */
export function fullAnswer(f: ReturnType<typeof changeOrdered>) {
  return {
    rev: f.s.blueprint.changeOrders.at(-1)!.rev,
    updates: [
      { action: "update-spec", task: f.tasks.queued, why: "Day list first, the map below it.", proposal: leadProposal("Trip list screen", [f.ids.plan, f.ids.list]) },
      { action: "revise", task: f.tasks.running, why: "The map moves below the days.", proposal: leadProposal("Move the trip plan map below the days", [f.ids.plan]) },
      { action: "retire", task: f.tasks.retiring, why: "You dropped Reminders.", proposal: null },
      { action: "revise", task: f.tasks.early, why: "The early plan shows the map first.", proposal: leadProposal("Revise the early trip plan", [f.ids.plan]) },
      { action: "new-task", task: null, why: "One shared list per trip.", proposal: leadProposal("Packing list screen", [f.ids.packing]) },
    ],
  };
}

/** A change-order lead run, started at `sec` and completed a second later with this block. */
export function answerChangeOrder(s: State, block: unknown, sec: number): { s: State; runId: string; setId: string } {
  const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "change-order" }, at(sec));
  const done = M.completeLeadRun(r.state, r.runId, { reply: "", proposals: [], changeOrder: block } as never, at(sec + 1));
  return { s: done, runId: r.runId, setId: `cs-${r.runId}` };
}
