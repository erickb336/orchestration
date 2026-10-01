// ORC-017: the fake runtime's words come from the story and never claim a real run or name anything after a run.

import { describe, expect, it } from "vitest";
import { DEMO_SCRIPT, NEUTRAL_FINDING, PLANNING_IDEAS } from "../../src/domain/demoScript";
import type { OutputDef } from "../../src/domain/types";
import { parseLeadOutput, parseOutputs } from "../envelope";
import { fakeFinalText, fakeLeadText, fakePlanningProposal, fakeSteer, fakeVision, taskTitleIn } from "./fake";

const breakdown: OutputDef[] = [{ name: "plan", kind: "breakdown" }];
const review: OutputDef[] = [{ name: "findings", kind: "review-findings" }];
const change: OutputDef[] = [
  { name: "change", kind: "code-change" },
  { name: "handoff", kind: "handoff" },
];
const RUN = "run-1028";
const noRunIds = (text: string) => expect(text).not.toMatch(/\brun-\d+\b/);

describe("fake runtime text (ORC-017)", () => {
  it("breaks a scripted goal down into the story's parts, never 'Simulated part' or a run id", () => {
    const text = fakeFinalText(RUN, breakdown, "S1", "WT-004", "Share a trip plan with friends");
    const out = parseOutputs(text, breakdown);
    expect(out.problems).toEqual([]);
    const items = out.outputs[0].items as { title: string }[];
    expect(items.map((i) => i.title)).toEqual(DEMO_SCRIPT["WT-004"].breakdown!.S1.map((i) => i.title));
    expect(out.outputs[0].summary).toBe(DEMO_SCRIPT["WT-004"].outputs!.plan);
    expect(text).not.toMatch(/Simulated part/);
    noRunIds(text);
  });

  it("names the parts of an unscripted goal after the goal, and plainly without a title", () => {
    const withTitle = parseOutputs(fakeFinalText(RUN, breakdown, "S1", "T-009", "Plan the summer trips"), breakdown).outputs[0];
    expect((withTitle.items as { title: string }[]).map((i) => i.title)).toEqual(["Part 1 of Plan the summer trips", "Part 2 of Plan the summer trips"]);
    expect(withTitle.summary).toBe("Split into 2 parts (simulated)");
    const noTitle = parseOutputs(fakeFinalText(RUN, breakdown, "S1", "T-009"), breakdown).outputs[0];
    expect((noTitle.items as { title: string }[]).map((i) => i.title)).toEqual(["Part 1", "Part 2"]);
    // A later iteration reports the goal as met.
    const later = parseOutputs(fakeFinalText(RUN, breakdown, "S2-i2", "T-009", "Plan the summer trips"), breakdown).outputs[0];
    expect(later.items).toEqual([]);
    expect(later.summary).toBe("Goal met (simulated)");
    for (const t of [fakeFinalText(RUN, breakdown, "S1", "T-009", "Plan the summer trips"), fakeFinalText(RUN, breakdown, "S1", "T-009")]) {
      expect(t).not.toMatch(/Simulated part/);
      noRunIds(t);
    }
  });

  it("reads the task's title from the envelope", () => {
    expect(taskTitleIn("# Assignment run-3: WT-004 S1\n\n## Task WT-004 (spec r1): Share a trip plan with friends\nOutcome: x")).toBe("Share a trip plan with friends");
    expect(taskTitleIn("nothing here")).toBeUndefined();
  });

  it("uses the story's summaries and findings for a scripted task, and neutral wording otherwise", () => {
    const scripted = parseOutputs(fakeFinalText(RUN, change, "S1", "WT-002"), change).outputs;
    expect(scripted.map((o) => o.summary)).toEqual([DEMO_SCRIPT["WT-002"].outputs!["S1.change"], DEMO_SCRIPT["WT-002"].outputs!["S1.handoff"]]);
    const neutral = parseOutputs(fakeFinalText(RUN, change, "S1", "T-042"), change).outputs;
    expect(neutral.map((o) => o.summary)).toEqual(["Implemented the change (simulated)", "Notes for the reviewer (simulated)"]);
    expect(neutral.every((o) => !/no files were touched|Simulated change/.test(o.summary))).toBe(true);
    // A first review round reports one finding: the story's for a scripted task and step, the neutral one otherwise.
    const scriptedReview = parseOutputs(fakeFinalText(RUN, review, "S3", "WT-007"), review).outputs[0];
    expect(scriptedReview.findings![0]).toMatchObject({ title: DEMO_SCRIPT["WT-007"].findings!.S3.title, file: "src/map/Pins.tsx", line: 33, action: "auto-fix" });
    const neutralReview = parseOutputs(fakeFinalText(RUN, review, "S2", "T-042"), review).outputs[0];
    expect(neutralReview.findings![0]).toMatchObject({ title: NEUTRAL_FINDING.title });
    expect(neutralReview.findings![0].file).toBeUndefined();
    expect(neutralReview.summary).toBe("1 finding (simulated)");
    // The repaired round and a dedicated review are clean.
    expect(parseOutputs(fakeFinalText(RUN, review, "S2-i2", "T-042"), review).outputs[0].findings).toEqual([]);
    expect(parseOutputs(fakeFinalText(RUN, review, "S1", "T-042-RV1"), review).outputs[0].findings).toEqual([]);
    for (const t of [fakeFinalText(RUN, change, "S1", "T-042"), fakeFinalText(RUN, review, "S2", "T-042")]) {
      expect(t).not.toMatch(/Simulated finding|\(Simulated\)/);
      noRunIds(t);
    }
  });

  it("proposes the story's ideas when planning, skipping those on the board, and never a run id", () => {
    const first = fakePlanningProposal("## Open work\n- WT-002 [Ready] P1 \"Show a clear offline state on the map\"");
    expect(first.title).toBe(PLANNING_IDEAS[0].title);
    const second = fakePlanningProposal(`## Open work\n- T-001 [Ready] P5 "${PLANNING_IDEAS[0].title}"`);
    expect(second.title).toBe(PLANNING_IDEAS[1].title);
    const all = PLANNING_IDEAS.map((i) => `- T-00x [Ready] P5 "${i.title}"`).join("\n");
    expect(fakePlanningProposal(all).title).toBe("Small improvement 1");
    expect(fakePlanningProposal(`${all}\n- T-009 [Ready] P5 "Small improvement 1"`).title).toBe("Small improvement 2");
    const text = fakeLeadText(RUN, "planning", "# Lead run run-1028 (planning)\n## Open work\n");
    const out = parseLeadOutput(text);
    expect(out.proposals).toHaveLength(1);
    expect(out.reply).not.toMatch(/\(Simulated/);
    noRunIds(JSON.stringify(out.proposals));
    expect(text).not.toMatch(/Simulated improvement/);
  });

  it("steers from the user's words with no '(Simulated)' prefix: the structured flag labels the result", () => {
    const prompt = ["## Open work", '- T-001 [Ready] P5 "Low" area:General · by lead · may: priority, defer, drop', "", "## Messages to answer now", "- focus on offline maps instead of sharing", "", "## Rules for proposals", ""].join("\n");
    const steer = fakeSteer(prompt)!;
    expect(steer.focus).toBe("focus on offline maps instead of sharing");
    expect(String(steer.reason)).not.toMatch(/\(Simulated\)/);
    expect(steer.tasks).toEqual([{ id: "T-001", defer: true, why: "The lowest-priority work that no longer fits the focus." }]);
    expect(fakeSteer("## Messages to answer now\n- hello there\n\n## Rules\n")).toBeUndefined();
  });

  it("a simulated vision draft says what the simulation did, never what a real lead would do", () => {
    const shaping = (convo: string) => ["Project stage: shaping", "", "## Conversation (most recent last)", convo, "", "## Messages to answer now", "- A hiking planner that works offline", "", "## Rules", ""].join("\n");
    const first = fakeVision(shaping("User: hello"))!;
    const later = fakeVision(shaping("Lead (claude): Here is what I understand: hello"))!;
    for (const v of [first, later]) {
      const all = `${String(v.text)} ${String(v.reason)}`;
      expect(all).not.toMatch(/real lead|live mode|would fold|a real model/i);
      expect(String(v.text)).toMatch(/^\(Simulated draft, exchange \d\)/);
      expect(String(v.text)).toMatch(/The simulation wrote this from your newest message alone/);
    }
    expect(String(later.reason)).toBe("Redrawn from your newest message after 2 exchanges; the assumptions are yours to confirm or change.");
  });
});
