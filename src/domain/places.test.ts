// ORC-029 pass 5, screen 1: the header's two places. Vision says whether a draft waits and what it holds, or when the
// version in force was locked in; the Factory says whether it started, runs (with how many agents), is paused by the
// owner, or stopped at the budget.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as M from "./model";
import { factoryPlace, projectPause, visionPlace } from "./places";
import { buildSeed } from "./seed";
import { startFactoryAsOwner } from "./testing/factory";
import { addScreen, openRound, peAgrees, run } from "./testing/studio";
import type { FactorySettings, State } from "./types";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
const MANUAL: FactorySettings = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };
/** A single-take screen in round 1, agreed by the PE when `agreed`. */
function screen(s: State, title: string, sec: number, agreed = true) {
  const r = s.studio.rounds.length ? { state: s, n: 1 } : openRound(s, "experience", at(sec));
  const a = addScreen(r.state, r.n, at(sec), { title, variants: [] });
  return { s: agreed ? peAgrees(a.state, a.id, 1, [], at(sec)) : a.state, id: a.id };
}

describe("the Vision place", () => {
  it("no draft; a draft with its changes and open items; locked in, with the revision and when", () => {
    let s = fresh();
    expect(visionPlace(s)).toEqual({ state: "no-draft" });
    const search = screen(s, "Trail search", 1);
    s = run(search.s, "approveArtifact", { artifactId: search.id, version: 1 }, at(2)).state;
    expect(visionPlace(s)).toEqual({ state: "draft", changes: 1, openItems: 0 });
    const banner = screen(s, "Offline banner", 3, false); // waiting for PE review: open
    s = run(banner.s, "approveRound", { round: 1 }, at(4)).state;
    expect(visionPlace(s)).toEqual({ state: "draft", changes: 1, openItems: 1 });
    s = startFactoryAsOwner(s, at(5), MANUAL);
    // The change is in force; the open item stays in the draft.
    expect(visionPlace(s)).toEqual({ state: "draft", changes: 0, openItems: 1 });
    s = runCommand(s, "discardDraft", { draftRev: s.blueprint.draft.rev }, at(6)).state;
    expect(visionPlace(s)).toEqual({ state: "locked-in", rev: 1, at: at(5) });
    // A vision text edited after the start waits in the draft: one change (pass 5, r10).
    s = runCommand(s, "editVision", { expectedRev: 1, text: "Weekend trips, offline on the trail.", focus: "", reason: "offline" }, at(7)).state;
    expect(visionPlace(s)).toEqual({ state: "draft", changes: 1, openItems: 0 });
  });
});

describe("the Factory place", () => {
  it("not started in Vision; running with its agents; pausing until every run confirms, then paused by the owner; stopped at the budget", () => {
    let s = fresh();
    expect(factoryPlace(s)).toEqual({ state: "not-started" });
    s = startFactoryAsOwner(s, at(1), MANUAL);
    expect(factoryPlace(s)).toEqual({ state: "running", agents: 0 });
    const c = run<{ newId: string }>(s, "createTask", { title: "Plan a trip", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at(2));
    s = M.dispatchEligible(M.leadPromoteProposals(M.startHeldTask(c.state, c.result.newId, at(3)), at(3)), at(3));
    expect(factoryPlace(s)).toEqual({ state: "running", agents: 1 });
    // Pausing: the run was asked to stop and has not confirmed; paused once it has (Q-10: the pill said paused at once).
    const pausing = M.pauseProject(s, at(4));
    expect(factoryPlace(pausing)).toEqual({ state: "pausing", stopping: 1 });
    expect(projectPause(pausing)).toEqual({ state: "pausing", stopping: 1 });
    const paused = M.acknowledgeStop(pausing, M.activeAttempts(pausing)[0].id, at(4));
    expect(factoryPlace(paused)).toEqual({ state: "paused" });
    expect(projectPause(paused)).toEqual({ state: "paused" });
    expect(projectPause(s)).toBeUndefined();
    // A finished run that cost $5, against a $5 building budget.
    const spent: State = { ...s, leadRuns: [{ id: "lead-1", trigger: "message", provider: "claude", model: "claude-sample-large", startedAt: at(2), endedAt: at(3), outcome: "completed", messageIds: [], usage: { costUsd: 5 } }] };
    const stopped = runCommand(spent, "setBudgets", { buildingUsd: 5, maintenanceUsdPerMonth: null }, at(5)).state;
    expect(factoryPlace(stopped)).toEqual({ state: "budget-stop", why: "The building budget is reached: $5.00 of $5.00" });
    // The owner's pause is named first (its run still stopping).
    expect(factoryPlace(M.pauseProject(stopped, at(6)))).toEqual({ state: "pausing", stopping: 1 });
  });
});
