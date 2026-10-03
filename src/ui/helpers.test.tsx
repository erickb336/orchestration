// Helper agents on screen (ORC-031, unit 31a): a run's helpers under Details › Runs (count, most at once, cost and a
// list), the setting beside a research step's model, the notes hint for a running research step with helpers, and
// Home's Needs-you row for a helper that started where none is allowed. Rendered statically over a fake store.

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import { reportSubagent, setResearchHelpers, setSubagentProviders } from "../domain/subagents";
import type { ProviderId, State } from "../domain/types";
import { allowanceLine, helperSetting, helpersLine, NOTES_TO_PARENT_ONLY, notesReachParentOnly } from "./helpersView";
import { Overview } from "./Overview";
import { ModelsSection } from "./task/Models";
import { RunsSection } from "./task/Runs";
import { renderScreen, visible } from "./testStore";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** The sample project with an Investigation task whose evidence step (research) runs; `cap`: helpers allowed there. */
function investigation(tracking: ProviderId[], cap?: number): { state: State; taskId: string; runId: string } {
  let s = setSubagentProviders(buildSeed(T0, { inFlightRuns: false }), tracking, at(0));
  if (cap) s = setResearchHelpers(s, "investigation/S1", cap, at(0));
  const made = M.createTask(s, { title: "Why is sync slow", area: "Sync", outcome: "A cause", benefit: "b", whyNow: "", approach: "a", acceptance: ["a cause"], priority: 1, holdBeforeStart: false, flowId: "investigation" }, at(1));
  const next = M.dispatchEligible(M.leadPromoteProposals(made.state, at(2)), at(2));
  return { state: next, taskId: made.newId, runId: next.attempts.find((a) => a.taskId === made.newId && a.stepId === "S1")!.id };
}
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const run = (s: State, id: string) => s.attempts.find((a) => a.id === id)!;

describe("the run's helpers", () => {
  it("shows the cap, the count, the most at once, the cost and each helper", () => {
    let { state, taskId, runId } = investigation(["claude", "codex"], 3);
    state = reportSubagent(state, runId, { phase: "started", id: "a", asked: "Find where sync is called", model: "helper-model", usageInParent: true }, at(10));
    state = reportSubagent(state, runId, { phase: "started", id: "b", asked: "Read the sync tests", usageInParent: true }, at(11));
    state = reportSubagent(state, runId, { phase: "ended", id: "a", how: "completed", usage: { costUsd: 0.25 } }, at(12));
    expect(helpersLine(run(state, runId))).toBe("2 helpers · at most 2 at once · $0.25, in the run's cost; 1 still running");
    const t = visible(renderScreen(<RunsSection state={state} task={task(state, taskId)} />, state));
    expect(t).toContain("2 helpers");
    expect(t).toContain("At most 3 helpers per run, read-only like the step.");
    expect(t).toContain("Find where sync is called · completed · helper-model");
    expect(t).toContain("Read the sync tests · running");
    expect(t).not.toContain("Mark as seen");
  });

  it("says when none was allowed, and offers Mark as seen", () => {
    let { state, taskId, runId } = investigation([]);
    state = reportSubagent(state, runId, { phase: "started", id: "x", asked: "Look around", usageInParent: false }, at(10));
    expect(allowanceLine(run(state, runId))).toBe("None allowed: the provider should have switched helpers off for this run.");
    const t = visible(renderScreen(<RunsSection state={state} task={task(state, taskId)} />, state));
    expect(t).toContain("None allowed");
    expect(t).toContain("1 helper · at most 1 at once · 1 still running");
    expect(t).toContain("Mark as seen");
  });

  it("is listed on Home's Needs you with Open and Mark as seen", () => {
    let { state, runId } = investigation([]);
    state = reportSubagent(state, runId, { phase: "started", id: "x", asked: "Look around", usageInParent: false }, at(10));
    const t = visible(renderScreen(<Overview />, state));
    expect(t).toContain("A helper agent started where none is allowed:");
    expect(t).toContain(`${run(state, runId).taskId} S1's run ${runId} started a helper agent.`);
    expect(t).toContain("Mark as seen");
  });
});

describe("the setting beside a research step's model", () => {
  it("is off and cannot be turned on while no provider tracks helpers, and says why", () => {
    const { state, taskId } = investigation([]);
    const html = renderScreen(<ModelsSection state={state} task={task(state, taskId)} />, state);
    const t = visible(html);
    expect(t).toContain("Let research steps start helpers");
    expect(t).toContain("No provider tracks helper agents yet, so this stays off.");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*disabled=""/);
    // Only the research step has it.
    expect(t.split("Let research steps start helpers").length - 1).toBe(1);
  });

  it("shows the cap when on, and names the providers it applies to", () => {
    const { state, taskId } = investigation(["claude"], 4);
    expect(helperSetting(state, "investigation/S1")).toMatchObject({ cap: 4, canTurnOn: true, why: "It applies to runs on Claude. Runs on another provider start none." });
    const t = visible(renderScreen(<ModelsSection state={state} task={task(state, taskId)} />, state));
    expect(t).toContain("Helpers per run, at most");
    expect(t).toContain("For Investigation · S1 Investigate and gather evidence in every task of this project.");
  });
});

describe("notes to a running research step", () => {
  it("say that helpers do not receive them, only where the run may have helpers", () => {
    const allowed = investigation(["codex", "claude"], 2);
    const st = task(allowed.state, allowed.taskId).steps[0];
    expect(notesReachParentOnly(allowed.state, task(allowed.state, allowed.taskId), st)).toBe(true);
    expect(NOTES_TO_PARENT_ONLY).toBe("Helpers do not receive notes; the parent agent does.");
    const none = investigation([]);
    expect(notesReachParentOnly(none.state, task(none.state, none.taskId), task(none.state, none.taskId).steps[0])).toBe(false);
  });
});
