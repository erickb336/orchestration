// Subagents in read-only research steps (ORC-031, unit 31a): the setting "Let research steps start helpers", what a
// run may start (resolved at dispatch), and the run's record of what the runtime reported: count, most at once, what
// each was asked, how it ended. A provider whose adapter does not track subagents can never have them turned on.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as M from "./model";
import { buildSeed } from "./seed";
import { RESEARCH_RUN_KINDS, type StudioRun } from "./studio/types";
import { PROBE_KEY, allowSubagentsForStudioRun, markSubagentsSeen, reportSubagent, researchSteps, setResearchHelpers, setSubagentProviders, slippedThrough } from "./subagents";
import { ControlError, MAX_SUBAGENTS_LISTED, MAX_SUBAGENT_ASK, type ProviderId, type State } from "./types";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** The sample project with nothing running, and the providers that track subagents. */
function project(tracking: ProviderId[] = ["claude", "codex"]): State {
  return setSubagentProviders(buildSeed(T0, { inFlightRuns: false }), tracking, at(0));
}

/** An Investigation task, dispatched: its evidence step (S1, research, a coder's role) runs. */
function investigation(s: State): { state: State; runId: string } {
  const made = M.createTask(s, { title: "Why is sync slow", area: "Sync", outcome: "A cause", benefit: "b", whyNow: "", approach: "a", acceptance: ["a cause with evidence"], priority: 1, holdBeforeStart: false, flowId: "investigation" }, at(1));
  const next = M.dispatchEligible(M.leadPromoteProposals(made.state, at(2)), at(2));
  const run = next.attempts.find((a) => a.taskId === made.newId && a.stepId === "S1");
  if (!run) throw new Error("S1 did not start");
  return { state: next, runId: run.id };
}

const run = (s: State, id: string) => s.attempts.find((a) => a.id === id)!;

describe("the setting: Let research steps start helpers", () => {
  it("names each research step: Investigation's evidence step and the studio's probes", () => {
    expect(researchSteps(project()).map((r) => r.key)).toEqual(["investigation/S1", PROBE_KEY]);
    expect(RESEARCH_RUN_KINDS).toEqual(["probe"]);
  });

  it("is off for every step in a new project, and a run then may start none", () => {
    const s = project();
    expect(s.project.researchHelpers).toEqual({});
    const { state, runId } = investigation(s);
    expect(run(state, runId).snapshot.allowSubagents).toBeUndefined();
  });

  it("turns on with a cap per run, and only a research step's run gets it", () => {
    const s = runCommand(project(), "setResearchHelpers", { step: "investigation/S1", cap: 3 }, at(1)).state;
    expect(s.project.researchHelpers).toEqual({ "investigation/S1": { cap: 3 } });
    const { state, runId } = investigation(s);
    expect(run(state, runId).snapshot.allowSubagents).toEqual({ cap: 3 });
    // Off again: the next run starts none.
    const off = runCommand(state, "setResearchHelpers", { step: "investigation/S1", cap: null }, at(3)).state;
    expect(off.project.researchHelpers).toEqual({});
  });

  it("refuses a step that is not research, and a cap out of range", () => {
    const s = project();
    expect(() => setResearchHelpers(s, "change/S1", 3, at(1))).toThrow("is not a research step");
    expect(() => setResearchHelpers(s, "investigation/S2", 3, at(1))).toThrow("is not a research step");
    for (const cap of [0, 11, 2.5]) expect(() => setResearchHelpers(s, "investigation/S1", cap, at(1)), String(cap)).toThrow("whole number from 1 to 10");
  });

  it("cannot be turned on while no provider tracks subagents (both are unsupported today)", () => {
    const s = project([]);
    expect(() => setResearchHelpers(s, "investigation/S1", 3, at(1))).toThrow(ControlError);
    expect(() => setResearchHelpers(s, PROBE_KEY, 3, at(1))).toThrow("No provider tracks helper agents yet");
    // Turning it off is always allowed.
    expect(setResearchHelpers(s, "investigation/S1", null, at(1))).toBe(s);
  });

  it("has no effect on a provider that does not track subagents: its runs start none", () => {
    // Only Claude tracks them; the evidence step's coder runs on the provider the project chose for coders.
    const on = setResearchHelpers(project(["claude", "codex"]), "investigation/S1", 2, at(1));
    const { state, runId } = investigation(on);
    const provider = run(state, runId).snapshot.provider as ProviderId;
    const other: ProviderId = provider === "claude" ? "codex" : "claude";
    const narrowed = setSubagentProviders(on, [other], at(1));
    const again = investigation(narrowed);
    expect(run(again.state, again.runId).snapshot.allowSubagents).toBeUndefined();
    // The stored setting stays: it applies again once the provider tracks them.
    expect(narrowed.project.researchHelpers).toEqual({ "investigation/S1": { cap: 2 } });
  });

  it("gives a probe's run the probes' cap, and no other studio run any", () => {
    const s = setResearchHelpers(project(["claude"]), PROBE_KEY, 4, at(1));
    expect(allowSubagentsForStudioRun(s, { kind: "probe", provider: "claude" })).toEqual({ cap: 4 });
    expect(allowSubagentsForStudioRun(s, { kind: "probe", provider: "codex" })).toBeUndefined();
    expect(allowSubagentsForStudioRun(s, { kind: "pe", provider: "claude" })).toBeUndefined();
    expect(allowSubagentsForStudioRun(s, { kind: "designer", provider: "claude" })).toBeUndefined();
  });

  it("a new project starts with it off, and keeps which providers track subagents", () => {
    const s = setResearchHelpers(project(["claude"]), "investigation/S1", 3, at(1));
    const fresh = M.initProject(s, { name: "New", repoPath: "/tmp/new", vision: "v", focus: "f" }, at(2));
    expect(fresh.project.researchHelpers).toEqual({});
    expect(fresh.project.subagentProviders).toEqual(["claude"]);
  });
});

describe("the run's record of subagents", () => {
  /** A research run allowed `cap` helpers. */
  function allowed(cap = 3) {
    return investigation(setResearchHelpers(project(), "investigation/S1", cap, at(1)));
  }
  const started = (id: string, asked = `Search ${id}`) => ({ phase: "started" as const, id, asked, model: "claude-haiku-test", usageInParent: true });
  const ended = (id: string, how: "completed" | "failed" | "stopped" = "completed") => ({ phase: "ended" as const, id, how, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.02 } });

  it("records each start and end: count, most at once, what it was asked, model, usage and how it ended", () => {
    let { state, runId } = allowed();
    state = reportSubagent(state, runId, started("a"), at(10));
    state = reportSubagent(state, runId, started("b"), at(11));
    state = reportSubagent(state, runId, ended("a"), at(12));
    state = reportSubagent(state, runId, started("c"), at(13));
    state = reportSubagent(state, runId, ended("b", "failed"), at(14));
    const rec = run(state, runId).subagents!;
    expect(rec.count).toBe(3);
    expect(rec.mostAtOnce).toBe(2);
    expect(rec.items.map((i) => [i.id, i.ended ?? "running"])).toEqual([
      ["a", "completed"],
      ["b", "failed"],
      ["c", "running"],
    ]);
    expect(rec.items[0]).toMatchObject({ asked: "Search a", model: "claude-haiku-test", startedAt: at(10), endedAt: at(12), usage: { costUsd: 0.02 }, usageInParent: true });
    // Allowed and within the cap: nothing for the owner.
    expect(slippedThrough(state)).toEqual([]);
  });

  it("keeps the first 300 characters of what it was asked", () => {
    let { state, runId } = allowed();
    state = reportSubagent(state, runId, started("a", "x".repeat(MAX_SUBAGENT_ASK + 50)), at(10));
    const item = run(state, runId).subagents!.items[0];
    expect(item.asked).toHaveLength(MAX_SUBAGENT_ASK);
    expect(item.askedCut).toBe(true);
  });

  it("changes nothing for a report repeated for the same id", () => {
    let { state, runId } = allowed();
    state = reportSubagent(reportSubagent(state, runId, started("a"), at(10)), runId, ended("a"), at(11));
    expect(reportSubagent(state, runId, started("a"), at(12))).toBe(state);
    expect(reportSubagent(state, runId, ended("a", "failed"), at(12))).toBe(state);
  });

  it("records a refusal over the cap without counting it as a start", () => {
    let { state, runId } = allowed(1);
    state = reportSubagent(state, runId, started("a"), at(10));
    state = reportSubagent(state, runId, { phase: "refused", id: "b", asked: "One more search" }, at(11));
    const rec = run(state, runId).subagents!;
    expect(rec.count).toBe(1);
    expect(rec.items.map((i) => i.ended ?? "running")).toEqual(["running", "refused"]);
    expect(state.events.at(-1)!.message).toContain("refused, over the cap of 1");
  });

  it("counts an end whose start was never reported, with its usage apart from the parent's", () => {
    let { state, runId } = allowed();
    state = reportSubagent(state, runId, ended("ghost"), at(10));
    const rec = run(state, runId).subagents!;
    expect(rec.count).toBe(1);
    expect(rec.mostAtOnce).toBe(1);
    expect(rec.items[0]).toMatchObject({ id: "ghost", ended: "completed", usageInParent: false, usage: { costUsd: 0.02 } });
  });

  it("lists the first 100 and keeps counting past them", () => {
    let { state, runId } = allowed(10);
    for (let i = 0; i < MAX_SUBAGENTS_LISTED + 5; i++) state = reportSubagent(state, runId, started(`h${i}`), at(10 + i));
    const rec = run(state, runId).subagents!;
    expect(rec.count).toBe(MAX_SUBAGENTS_LISTED + 5);
    expect(rec.items).toHaveLength(MAX_SUBAGENTS_LISTED);
    expect(rec.unlisted).toBe(5);
  });

  it("records a start past the cap and says so in the activity log", () => {
    let { state, runId } = allowed(1);
    state = reportSubagent(reportSubagent(state, runId, started("a"), at(10)), runId, started("b"), at(11));
    expect(run(state, runId).subagents!.count).toBe(2);
    expect(state.events.at(-1)!.message).toContain("started 2 helper agents, over its cap of 1");
  });

  it("records on lead runs and studio runs too, and ignores a run that does not exist", () => {
    let s = project();
    const lead = M.startLeadRun(s, { provider: "claude", model: s.project.catalog.claude[0].id, trigger: "message" }, at(1));
    s = reportSubagent(lead.state, lead.runId, started("a"), at(2));
    expect(s.leadRuns.find((r) => r.id === lead.runId)!.subagents!.count).toBe(1);
    const studio: StudioRun = { id: "studio-1", kind: "pe", provider: "claude", model: "m", status: "running", brief: "b", askedAt: at(1), workspace: "staging/studio-1" };
    s = { ...s, studio: { ...s.studio, runs: [studio] } };
    s = reportSubagent(s, "studio-1", started("a"), at(3));
    expect(s.studio.runs[0].subagents!.count).toBe(1);
    expect(reportSubagent(s, "run-none", started("a"), at(4))).toBe(s);
  });
});

describe("a subagent where none is allowed", () => {
  const started = { phase: "started" as const, id: "x", asked: "Look around", usageInParent: true };

  it("is counted, shown on its run, and listed until the owner marks it as seen", () => {
    const { state, runId } = investigation(project());
    const s = reportSubagent(state, runId, started, at(10));
    expect(run(s, runId).subagents!.count).toBe(1);
    expect(s.events.at(-1)).toMatchObject({ kind: "blocked", message: expect.stringContaining("started a helper agent where none is allowed") });
    const [item] = slippedThrough(s);
    expect(item).toMatchObject({ runId, count: 1, href: `#/task/${run(s, runId).taskId}` });
    const seen = runCommand(s, "markSubagentsSeen", { runId }, at(11)).state;
    expect(slippedThrough(seen)).toEqual([]);
    expect(run(seen, runId).subagents!.seenAt).toBe(at(11));
    expect(() => markSubagentsSeen(state, runId, at(12))).toThrow("reported no helper agents");
  });
});
