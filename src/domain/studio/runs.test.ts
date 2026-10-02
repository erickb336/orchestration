// ORC-029 pass 3a, studio runs in the domain: asked for in Vision (queued), dispatched only in Vision and never while
// paused or at the budget, stopped with the runtime's acknowledgment, asked for again after a pause, and their
// results refused once stale. Driven through the command table as the service sends them.

import { describe, expect, it } from "vitest";
import { runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import { startFactoryAsOwner } from "../testing/factory";
import { addScreen, openRound, run } from "../testing/studio";
import type { State } from "../types";
import * as R from "./runs";

const T0 = Date.parse("2026-10-02T09:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
/** Vision with round 1 (the experience) open. */
function inRound(): { s: State; n: number } {
  const r = openRound(fresh(), "experience", at(1));
  return { s: r.state, n: r.n };
}
const ask = (s: State, args: Record<string, unknown>, sec = 2) => run<{ runId: string }>(s, "startStudioRun", { kind: "designer", brief: "Make the trip plan.", ...args }, at(sec));
const runOf = (s: State, id: string) => R.getStudioRun(s, id)!;
const dispatch = (s: State, sec: number, opts: R.StudioDispatchOptions = {}) => R.dispatchStudioRuns(s, at(sec), opts);

describe("asking for a studio run", () => {
  it("queues a designer run in an open round of Vision, with the designer's provider and model resolved and recorded", () => {
    const { s, n } = inRound();
    const r = ask(s, { round: n });
    expect(runOf(r.state, r.result.runId)).toEqual({
      id: r.result.runId,
      kind: "designer",
      round: 1,
      provider: "claude",
      model: "claude-sample-large",
      status: "queued",
      brief: "Make the trip plan.",
      askedAt: at(2),
      workspace: `staging/${r.result.runId}`,
    });
    // "auto" resolves to the catalog's first model; an explicit choice is kept.
    const codex = ask(r.state, { round: n, selection: { provider: "codex", model: "auto" } }, 3);
    expect(runOf(codex.state, codex.result.runId)).toMatchObject({ provider: "codex", model: "codex-sample-large" });
  });

  it("a revision names the artifact and the version it revises", () => {
    const { s, n } = inRound();
    const a = addScreen(s, n, at(2));
    const r = ask(a.state, { round: n, artifactId: a.id }, 3);
    expect(runOf(r.state, r.result.runId)).toMatchObject({ artifactId: a.id, baseVersion: 1 });
  });

  it("is refused outside Vision, outside an open lead round, for an unknown artifact, without a brief, and for the PE and probes until pass 4", () => {
    const { s, n } = inRound();
    expect(() => ask(startFactoryAsOwner(s, at(2)), { round: n })).toThrow("Studio runs happen in Vision. Go back to vision first.");
    expect(() => ask(s, { round: 2 })).toThrow("There is no round 2.");
    expect(() => ask(run(s, "closeRound", { round: n }, at(2)).state, { round: n })).toThrow("Round 1 is closed.");
    const zero = openRound(fresh(), "material", at(1));
    expect(() => ask(zero.state, { round: 0 })).toThrow(/Round 0 holds what the owner brought/);
    expect(() => ask(s, { round: n, artifactId: "sa-99" })).toThrow("Unknown studio artifact sa-99.");
    expect(() => ask(s, { round: n, brief: " \u0007 " })).toThrow("The brief is empty.");
    expect(() => ask(s, { round: n, kind: "pe" })).toThrow(/the PE's and probes' runs come in ORC-029 pass 4/);
    expect(() => ask(s, { round: n, selection: { provider: "codex", model: "gpt-nope" } })).toThrow("Model gpt-nope is not in the Codex catalog.");
  });
});

describe("dispatch", () => {
  it("starts queued runs in Vision; product task steps never start in Vision", () => {
    const { s: base, n } = inRound();
    const task = M.createTask(base, { title: "Plan a trip", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(2));
    const s = ask(task.state, { round: n }, 3);
    const tasks = M.dispatchEligible(M.leadPromoteProposals(s.state, at(4)), at(4));
    expect(M.activeAttempts(tasks)).toEqual([]);
    const d = dispatch(tasks, 4, { simulated: ["claude"] });
    expect(d.started).toEqual([s.result.runId]);
    expect(runOf(d.state, s.result.runId)).toMatchObject({ status: "running", startedAt: at(4), simulated: true });
    // The same task starts once the owner starts the factory.
    const building = startFactoryAsOwner(s.state, at(5));
    expect(M.activeAttempts(M.dispatchEligible(M.leadPromoteProposals(building, at(6)), at(6))).map((a) => a.taskId)).toEqual([task.newId]);
  });

  it("waits, queued, while the project is paused, outside Vision, or at the building budget", () => {
    const { s: base, n } = inRound();
    const { state: s, result } = ask(base, { round: n });
    const paused = M.pauseProject(s, at(3));
    expect(dispatch(paused, 4)).toEqual({ state: paused, started: [] });
    // Started the factory with the run still queued: it waits until the project is back in Vision.
    const building = startFactoryAsOwner(s, at(3));
    expect(dispatch(building, 4).started).toEqual([]);
    expect(dispatch(M.startVision(building, at(5)), 6).started).toEqual([result.runId]);
    // At the building budget nothing new starts, studio runs included; raising it lets them start.
    const spent = { ...s, leadRuns: [{ id: "lead-1", trigger: "message" as const, provider: "claude" as const, model: "claude-sample-large", startedAt: at(2), endedAt: at(3), outcome: "completed" as const, messageIds: [], usage: { costUsd: 5 } }] };
    const atBudget = runCommand(spent, "setBudgets", { buildingUsd: 5, maintenanceUsdPerMonth: null }, at(3)).state;
    expect(dispatch(atBudget, 4).started).toEqual([]);
    expect(dispatch(runCommand(atBudget, "setBudgets", { buildingUsd: 6, maintenanceUsdPerMonth: null }, at(4)).state, 5).started).toEqual([result.runId]);
  });

  it("refuses a run whose round closed or whose artifact was revised before it started; fails one whose provider is unavailable; waits on one not yet checked", () => {
    const { s: base, n } = inRound();
    const a = addScreen(base, n, at(2));
    const closed = ask(a.state, { round: n }, 3);
    const d1 = dispatch(run(closed.state, "closeRound", { round: n }, at(4)).state, 5);
    expect(runOf(d1.state, closed.result.runId)).toMatchObject({ status: "failed", endedAt: at(5), note: "not started: round 1 was closed" });

    const revising = ask(a.state, { round: n, artifactId: a.id }, 3);
    const revised = addScreen(revising.state, n, at(4), { artifactId: a.id });
    expect(runOf(dispatch(revised.state, 5).state, revising.result.runId)).toMatchObject({ status: "failed", note: "not started: Trip plan has a newer version (v2) than the one it revises (v1)" });

    const q = ask(a.state, { round: n }, 3);
    expect(runOf(dispatch(q.state, 4, { unavailable: { claude: "not signed in" } }).state, q.result.runId)).toMatchObject({ status: "failed", note: "Claude is not available: not signed in" });
    expect(dispatch(q.state, 4, { deferred: ["claude"] }).started).toEqual([]);
  });

  it("shares the worker limits with task runs", () => {
    const { s: base, n } = inRound();
    const limited = M.setProviderLimit(M.setWorkerLimit(base, 2, at(1)), "claude", 1, at(1));
    const c1 = ask(limited, { round: n }, 2);
    const c2 = ask(c1.state, { round: n }, 2);
    const x1 = ask(c2.state, { round: n, selection: { provider: "codex", model: "auto" } }, 3);
    const x2 = ask(x1.state, { round: n, selection: { provider: "codex", model: "auto" } }, 3);
    const d = dispatch(x2.state, 4);
    // One Claude run (its provider's limit of one), then one Codex run, and the worker limit of two is reached.
    expect(d.started).toEqual([c1.result.runId, x1.result.runId]);
    expect(R.activeStudioRuns(d.state).map((r) => r.id)).toEqual([c1.result.runId, x1.result.runId]);
  });
});

describe("pause, stop and stale results", () => {
  /** A designer run dispatched and started by its runtime. */
  function running() {
    const { s: base, n } = inRound();
    const r = ask(base, { round: n });
    const d = dispatch(r.state, 3);
    return { s: R.reportStudioRunStarted(d.state, r.result.runId, { sessionId: "sess-1", actualModel: "claude-sample-large-2" }), id: r.result.runId, n };
  }

  it("pausing asks the run to stop; once the runtime confirms, it is asked for again and runs when the project resumes", () => {
    const { s, id } = running();
    const paused = M.pauseProject(s, at(4));
    expect(runOf(paused, id)).toMatchObject({ status: "stopping", stopRequestedAt: at(4), requeue: true });
    // Nothing changes until the runtime confirms the stop.
    expect(dispatch(paused, 5).started).toEqual([]);
    const stopped = R.reportStudioRunStopped(paused, id, at(6), { usage: { costUsd: 0.12 } });
    const again = stopped.studio.runs.at(-1)!;
    expect(runOf(stopped, id)).toMatchObject({ status: "stopped", endedAt: at(6), usage: { costUsd: 0.12 } });
    expect(again).toEqual({ id: again.id, kind: "designer", round: 1, provider: "claude", model: "claude-sample-large", status: "queued", brief: "Make the trip plan.", askedAt: at(6), workspace: `staging/${again.id}`, retryOf: id });
    expect(dispatch(stopped, 7).started).toEqual([]);
    expect(dispatch(M.resumeProject(stopped, at(8)), 9).started).toEqual([again.id]);
  });

  it("a stop the runtime does not confirm in time is a visible control failure", () => {
    const { s, id } = running();
    const late = R.reportStudioStopTimeout(M.pauseProject(s, at(4)), id, at(60));
    expect(runOf(late, id)).toMatchObject({ status: "stopping", note: "Control failure: the runtime has not acknowledged the stop request." });
    expect(late.events.at(-1)!.message).toBe(`Control failure: Designer run ${id} did not acknowledge stop in time`);
  });

  it("a run the runtime ended without a stop request failed; a run whose process is gone is lost; neither is asked for again", () => {
    const { s, id } = running();
    expect(runOf(R.reportStudioRunStopped(s, id, at(5)), id)).toMatchObject({ status: "failed", note: "The runtime stopped it without a stop request (for example its time limit)." });
    const lost = R.reportStudioRunStopped(s, id, at(5), { lost: true });
    expect(runOf(lost, id).status).toBe("lost");
    expect(lost.studio.runs).toHaveLength(1);
  });

  it("a report for a run that is no longer active changes nothing", () => {
    const { s, id } = running();
    const done = R.completeStudioRun(s, id, at(5), { summary: "1 artifact", usage: { costUsd: 0.4 } });
    expect(runOf(done, id)).toMatchObject({ status: "completed", endedAt: at(5), usage: { costUsd: 0.4 }, actualModel: "claude-sample-large-2" });
    for (const late of [R.completeStudioRun(done, id, at(6), { summary: "again" }), R.reportStudioRunFailed(done, id, "late", at(6)), R.reportStudioRunStopped(done, id, at(6)), R.reportStudioRunStarted(done, id, { sessionId: "other" })]) {
      expect(late).toBe(done);
    }
  });

  it("a result is stale once its round is closed or its artifact was revised by another run", () => {
    const { s, id, n } = running();
    expect(R.staleReason(s, runOf(s, id))).toBeUndefined();
    expect(R.staleReason(run(s, "closeRound", { round: n }, at(5)).state, runOf(s, id))).toBe("round 1 was closed");
  });

  it("a new project is refused while a studio run is active", () => {
    const { s } = running();
    expect(() => M.initProject(s, { name: "Other", repoPath: "/tmp/other", vision: "", focus: "" }, at(5))).toThrow("Stop all active runs (pause the project and wait for Paused) before starting a new project.");
  });
});

describe("the placeholder brief", () => {
  it("is labelled, and built from the vision and the round's focus only", () => {
    const { s, n } = inRound();
    expect(R.placeholderBrief(s, n)).toBe(
      [
        "PLACEHOLDER BRIEF. The lead's studio brief comes in ORC-029 pass 4; this one is built from the vision and the round's focus only.",
        "",
        "Round 1 is about the experience: the screens and how they feel to use.",
        "Make two variants that differ in a real choice, each for every device in the project's scope.",
        "",
        "The vision:",
        "Weekend trips for a small group of friends.",
      ].join("\n"),
    );
  });
});
