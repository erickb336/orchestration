// ORC-029 pass 3a, studio runs in the domain: asked for in Vision (queued), dispatched only in Vision and never while
// paused or at the budget, stopped with the runtime's acknowledgment, asked for again after a pause, and their
// results refused once stale. Driven through the command table as the service sends them.

import { describe, expect, it } from "vitest";
import { runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import { startFactoryAsOwner } from "../testing/factory";
import { buildingSpend } from "../spend";
import { addScreen, openRound, peAgrees, run } from "../testing/studio";
import type { State } from "../types";
import * as R from "./runs";
import * as S from "./studio";

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

  it("in round 0 (as it is today), the designer reproduces the existing code and the PE reviews what it made, as in any round", () => {
    const zero = openRound(fresh(), "material", at(1));
    const d = ask(zero.state, { round: 0, brief: "Reproduce the trip list as it is today." });
    expect(runOf(d.state, d.result.runId)).toMatchObject({ kind: "designer", round: 0, status: "queued" });
    const a = addScreen(d.state, 0, at(3), { title: "Trip list (as is)", variants: [{ id: "a", label: "As it is today" }], provenance: { files: ["src/TripList.tsx"] } });
    const pe = R.askForPeReviews(a.state, at(4));
    expect(R.peRunsOf(pe, a.id, 1)).toEqual([expect.objectContaining({ kind: "pe", round: 0, status: "queued", provider: "codex" })]);
  });

  it("a revision names the artifact and the version it revises", () => {
    const { s, n } = inRound();
    const a = addScreen(s, n, at(2));
    const r = ask(a.state, { round: n, artifactId: a.id }, 3);
    expect(runOf(r.state, r.result.runId)).toMatchObject({ artifactId: a.id, baseVersion: 1 });
  });

  it("is refused outside Vision, outside an open lead round, for an unknown artifact, without a brief, and for probes until pass 4", () => {
    const { s, n } = inRound();
    expect(() => ask(startFactoryAsOwner(s, at(2)), { round: n })).toThrow("Studio runs happen in Vision. Go back to vision first.");
    expect(() => ask(s, { round: 2 })).toThrow("There is no round 2.");
    expect(() => ask(run(s, "closeRound", { round: n }, at(2)).state, { round: n })).toThrow("Round 1 is closed.");
    expect(() => ask(s, { round: n, artifactId: "sa-99" })).toThrow("Unknown studio artifact sa-99.");
    expect(() => ask(s, { round: n, brief: " \u0007 " })).toThrow("The brief is empty.");
    expect(() => ask(s, { round: n, kind: "probe" })).toThrow("Probe runs cannot be asked for yet; they come in ORC-029 pass 4.");
    expect(() => ask(s, { round: n, kind: "pe" })).toThrow("A PE run names the artifact it reviews.");
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

  it("after Start the factory, studio runs still finishing count toward Agents at once and each provider's limit: task runs wait for their place", () => {
    const { s: base, n } = inRound();
    const newTask = (s: State, title: string, sec: number) => M.createTask(s, { title, area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(sec));
    const tasks = (s: State, sec: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(sec)), at(sec));
    const taskRuns = (s: State) => M.activeAttempts(s).map((a) => `${a.taskId} ${a.snapshot.provider}`);

    // Agents at once: two, both taken by studio runs (one per provider) when the owner starts the factory.
    const t1 = newTask(M.setWorkerLimit(base, 2, at(1)), "Plan a trip", 2);
    const t2 = newTask(t1.state, "Share a plan", 2);
    const c = ask(t2.state, { round: n }, 3);
    const x = ask(c.state, { round: n, selection: { provider: "codex", model: "auto" } }, 3);
    const studio = dispatch(x.state, 4);
    expect(studio.started).toEqual([c.result.runId, x.result.runId]);
    const building = tasks(startFactoryAsOwner(studio.state, at(5)), 6);
    expect(taskRuns(building)).toEqual([]);
    // One studio run finishes: one task run takes its place, and no more.
    const one = tasks(R.completeStudioRun(building, x.result.runId, at(7), { summary: "Trip plan v1" }), 8);
    // (The Change flow's first step, planning, runs on Codex.)
    expect(taskRuns(one)).toEqual([`${t1.newId} codex`]);
    expect(M.activeAttempts(one).length + R.activeStudioRuns(one).length).toBe(2);

    // A provider's limit: Codex's one place is taken by a studio run, so a Codex task run waits while Agents at once has room.
    const limited = M.setProviderLimit(M.setWorkerLimit(base, 3, at(1)), "codex", 1, at(1));
    const t3 = newTask(limited, "Plan a trip", 2);
    const x2 = ask(t3.state, { round: n, selection: { provider: "codex", model: "auto" } }, 3);
    const running = dispatch(x2.state, 4);
    const waiting = tasks(startFactoryAsOwner(running.state, at(5)), 6);
    expect(taskRuns(waiting)).toEqual([]);
    expect(taskRuns(tasks(R.completeStudioRun(waiting, x2.result.runId, at(7), { summary: "Trip plan v1" }), 8))).toEqual([`${t3.newId} codex`]);
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

describe("the PE's runs (pass 3)", () => {
  /** Round 1 with the designer's Trip plan (three variants, made on Claude) just imported. */
  function imported() {
    const { s, n } = inRound();
    const a = addScreen(s, n, at(2));
    return { s: a.state, id: a.id, n };
  }
  const peRuns = (s: State) => s.studio.runs.filter((r) => r.kind === "pe");

  it("once a version is imported the service asks the PE, on the other provider than the designer's, to review it in its round", () => {
    const { s, id } = imported();
    const asked = R.askForPeReviews(s, at(3));
    expect(peRuns(asked)).toEqual([
      {
        id: expect.any(String),
        kind: "pe",
        round: 1,
        artifactId: id,
        baseVersion: 1,
        provider: "codex",
        model: "codex-sample-large",
        status: "queued",
        brief: "PE review of Trip plan v1: feasibility, scale, longevity and budget, a verdict for each variant.",
        askedAt: at(3),
        workspace: expect.stringMatching(/^staging\//),
      },
    ]);
    expect(asked.events.at(-1)).toMatchObject({ actor: "system", kind: "vision", message: `PE run ${peRuns(asked)[0].id} asked for in round 1, reviewing Trip plan v1, on Codex · codex-sample-large` });
    // Asked once: the next cycle changes nothing.
    expect(R.askForPeReviews(asked, at(4))).toBe(asked);
  });

  it("the project's PE role default chooses it; with the other provider off, the designer's own reviews, and the record says it is not independent", () => {
    const { s } = imported();
    const chosen = runCommand(s, "setRoleDefault", { role: "pe", selection: { provider: "claude", model: "auto" } }, at(3)).state;
    expect(peRuns(R.askForPeReviews(chosen, at(4)))[0]).toMatchObject({ provider: "claude", model: "claude-sample-large" });
    const codexOff = runCommand(s, "setProviderEnabled", { provider: "codex", enabled: false }, at(3)).state;
    const asked = R.askForPeReviews(codexOff, at(4));
    expect(peRuns(asked)[0]).toMatchObject({ provider: "claude" });
    expect(asked.events.at(-1)!.message).toMatch(/on Claude · claude-sample-large \(on the designer's own provider: Codex is not enabled, so this review is not independent\)$/);
  });

  it("waits for the screenshots and the recording; never for what the owner brought, a closed round, an older version, outside Vision, or a version already reviewed", () => {
    const { s, id, n } = imported();
    const pending = S.startArtifactMedia(s, id, 1);
    expect(peRuns(R.askForPeReviews(pending, at(3)))).toEqual([]);
    const shot = S.recordArtifactMedia(pending, id, 1, { shots: { status: "skipped", at: at(3), reason: "no Chrome found" } }, at(3));
    expect(peRuns(R.askForPeReviews(shot, at(4)))).toHaveLength(1);
    expect(peRuns(R.askForPeReviews(run(s, "closeRound", { round: n }, at(3)).state, at(4)))).toEqual([]);
    expect(peRuns(R.askForPeReviews(startFactoryAsOwner(s, at(3)), at(4)))).toEqual([]);
    expect(peRuns(R.askForPeReviews(peAgrees(s, id, 1, ["A", "B", "C"], at(3)), at(4)))).toEqual([]);
    // Only the newest version is reviewed.
    const v2 = addScreen(s, n, at(3), { artifactId: id });
    expect(peRuns(R.askForPeReviews(v2.state, at(4))).map((r) => r.baseVersion)).toEqual([2]);
    const brought = openRound(fresh(), "material", at(1));
    const material = addScreen(brought.state, 0, at(2), { kind: "material", title: "Sketch", variants: [], devices: [], madeBy: { role: "user" } });
    expect(peRuns(R.askForPeReviews(material.state, at(3)))).toEqual([]);
  });

  it("a run under way or finished needs no other; one that failed or was lost is asked again once, then no more", () => {
    const { s, id } = imported();
    const first = R.askForPeReviews(s, at(3));
    const runId = peRuns(first)[0].id;
    const going = dispatch(first, 4).state;
    expect(R.askForPeReviews(going, at(5))).toBe(going);
    const failed = R.reportStudioRunFailed(going, runId, "The PE's answer had no verdicts.", at(6));
    const again = R.askForPeReviews(failed, at(7));
    expect(peRuns(again).map((r) => r.status)).toEqual(["failed", "queued"]);
    const lost = R.reportStudioRunStopped(dispatch(again, 8).state, peRuns(again)[1].id, at(9), { lost: true });
    expect(R.askForPeReviews(lost, at(10))).toBe(lost);
    expect(R.peRunDue(lost, S.latestVersion(lost, id)!)).toBe(false);
  });

  it("a pause stops it and asks for it again, like any studio run", () => {
    const { s } = imported();
    const asked = R.askForPeReviews(s, at(3));
    const runId = peRuns(asked)[0].id;
    const stopped = R.reportStudioRunStopped(M.pauseProject(dispatch(asked, 4).state, at(5)), runId, at(6));
    expect(peRuns(stopped).map((r) => [r.status, r.retryOf])).toEqual([
      ["stopped", undefined],
      ["queued", runId],
    ]);
    expect(R.askForPeReviews(stopped, at(7))).toBe(stopped);
  });

  it("counts in the building budget and waits at it, like every studio run", () => {
    const { s } = imported();
    const asked = R.askForPeReviews(s, at(3));
    const first = peRuns(asked)[0];
    const done = R.completeStudioRun(dispatch(asked, 4).state, first.id, at(5), { summary: "3 verdicts", usage: { costUsd: 0.7 } });
    expect(buildingSpend(done)).toMatchObject({ usd: 0.7, runs: 1 });
    // A second version's review waits, queued, while the budget is reached.
    const v2 = addScreen(done, 1, at(6), { artifactId: first.artifactId });
    const atBudget = runCommand(R.askForPeReviews(v2.state, at(7)), "setBudgets", { buildingUsd: 0.5, maintenanceUsdPerMonth: null }, at(7)).state;
    expect(peRuns(atBudget).at(-1)).toMatchObject({ baseVersion: 2, status: "queued" });
    expect(dispatch(atBudget, 8).started).toEqual([]);
  });

  it("says why the PE cannot be asked when no provider can run it", () => {
    const { s, id } = imported();
    const chosen = runCommand(s, "setRoleDefault", { role: "pe", selection: { provider: "codex", model: "auto" } }, at(3)).state;
    const off = runCommand(chosen, "setProviderEnabled", { provider: "codex", enabled: false }, at(3)).state;
    expect(R.askForPeReviews(off, at(4))).toBe(off);
    expect(R.peRunBlocker(off, S.latestVersion(off, id)!)).toBe("Codex is not enabled. Enable it in Settings or choose another provider for the PE.");
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
