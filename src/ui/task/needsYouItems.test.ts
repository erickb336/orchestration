// What a task needs from you, each thing once, for the top of the task page.

import { describe, expect, it } from "vitest";
import { buildDemo } from "../../domain/demo";
import type { State } from "../../domain/types";
import { CONFIRM } from "./confirms";
import { leadDecisions, needsYouCount, needsYouItems, waitsForGoAhead } from "./needsYouItems";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

/** WT-005's pull request as the fake GitHub reports it once opened, seen and clean. */
export function openCleanPr(s: State, nowMs = T0, id = "WT-005", number = 1000): State {
  const next = structuredClone(s);
  const pr = task(next, id).integration!.pr!;
  pr.phase = "open";
  pr.number = number;
  pr.url = `https://github.com/o/r/pull/${number}`;
  pr.observed = {
    at: new Date(nowMs).toISOString(),
    state: "OPEN",
    isDraft: false,
    crossRepo: false,
    headSha: pr.headSha,
    baseRef: pr.base,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    labels: [],
    checks: (next.project.github?.requiredChecks ?? []).map((name) => ({ name, required: true, status: "COMPLETED", conclusion: "SUCCESS" })),
    checksFor: pr.headSha,
  };
  return next;
}

describe("needsYouItems", () => {
  it("a finding routed to you is a decision; the lead's own findings are not yours", () => {
    const s = buildDemo(T0);
    const items = needsYouItems(s, task(s, "WT-007"), T0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "decisions" });
    expect(items[0].kind === "decisions" && items[0].decisions.map((d) => d.finding.title)).toEqual(["Read distances in miles or kilometres?"]);
    expect(needsYouCount(items)).toBe(1);
    expect(leadDecisions(s, task(s, "WT-007"))).toEqual([]);
    const moved = structuredClone(s);
    moved.decisions.find((d) => d.taskId === "WT-007" && d.status === "open")!.routedTo = "lead";
    expect(needsYouItems(moved, task(moved, "WT-007"), T0)).toEqual([]);
    expect(leadDecisions(moved, task(moved, "WT-007"))).toHaveLength(1);
  });

  it("a task waiting for the go-ahead asks for the choice when the spec has options, else for the go-ahead alone", () => {
    const s = buildDemo(T0);
    expect(waitsForGoAhead(task(s, "WT-004.3"))).toBe(true);
    expect(needsYouItems(s, task(s, "WT-004.3"), T0)).toEqual([{ kind: "choose", optionIds: ["A", "B"], selected: "A", recommended: "A" }]);
    const one = structuredClone(s);
    const t = task(one, "WT-004.3");
    t.specs[t.specs.length - 1].content.options.pop();
    expect(needsYouItems(one, t, T0)).toEqual([{ kind: "go-ahead" }]);
    expect(needsYouItems(s, task(s, "WT-002"), T0)).toEqual([]);
    expect(waitsForGoAhead(task(s, "WT-001"))).toBe(false);
  });

  it("a pull request that is ready to merge, or stopped on a problem, needs you; one still being prepared does not", () => {
    const s = buildDemo(T0);
    expect(needsYouItems(s, task(s, "WT-005"), T0)).toEqual([]);
    const ready = openCleanPr(s);
    expect(needsYouItems(ready, task(ready, "WT-005"), T0 + 1000)).toEqual([{ kind: "pr", ready: true }]);
    const stuck = structuredClone(ready);
    task(stuck, "WT-005").integration!.pr!.attention = { code: "conflict", message: "It conflicts with main.", at: new Date(T0).toISOString() } as never;
    const items = needsYouItems(stuck, task(stuck, "WT-005"), T0 + 1000);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "pr", problem: "It conflicts with main." });
  });

  it("failing final checks are a decision of their own, before the findings", () => {
    const s = structuredClone(buildDemo(T0));
    const t = task(s, "WT-007");
    const c2 = t.steps.find((st) => st.id === "C2")!;
    c2.state = "blocked";
    c2.blockedReason = "Checks failed on the final change: test";
    const items = needsYouItems(s, t, T0);
    expect(items.map((i) => i.kind)).toEqual(["final-checks", "decisions"]);
    expect(items[0]).toMatchObject({ kind: "final-checks", stepId: "C2", reason: "Checks failed on the final change: test" });
    expect(needsYouCount(items)).toBe(2);
  });

  it("the confirmations say what happens and what is kept", () => {
    expect(CONFIRM.cancelTask("WT-007")).toMatchObject({ title: "Cancel WT-007?", primaryLabel: "Cancel task", cancelLabel: "Keep it", danger: true });
    expect(CONFIRM.cancelTask("WT-007").text).toMatch(/spec and the outputs so far are kept/);
    expect(CONFIRM.createFollowUp("WT-001")).toMatchObject({ title: "Create a follow-up of WT-001?", primaryLabel: "Create follow-up" });
    expect(CONFIRM.createFollowUp("WT-001").text).toMatch(/waits for your go-ahead/);
    expect(CONFIRM.rerunStep("S1", "Implement").title).toBe("Rerun S1 (Implement)?");
    expect(CONFIRM.changeModelWhileRunning("S1").text).toMatch(/checkpointed/);
    expect(CONFIRM.acceptFailingChecks()).toMatchObject({ danger: true, primaryLabel: "Accept failing checks" });
    expect(CONFIRM.discardDraft(2)).toMatchObject({ title: "Discard your draft?", text: "Your edits since r2 are lost. The spec stays as it is.", danger: true });
  });
});
