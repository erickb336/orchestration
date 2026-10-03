// ORC-029 pass 5 (5b), spec r10 "Edits collect in a draft": after the start, an edit of the vision text (the owner's,
// or a lead draft the owner accepts) goes into the blueprint's draft, and the owner's Lock in puts it into force with
// the blueprint. The factory keeps reading the vision in force until then. Before the start, nothing changes.

import { describe, expect, it } from "vitest";
import { runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import * as B from "../studio/blueprint";
import { at, changeOrdered, T0 } from "../testing/changeOrders";
import { startFactoryAsOwner } from "../testing/factory";
import { addScreen, openRound, pePass, run } from "../testing/studio";
import type { State } from "../types";

const VISION = "Weekend trips for a small group of friends.";
const NEW_TEXT = "Weekend trips for a small group of friends, offline on the trail.";
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: VISION, focus: "Plan a trip" }, at(0));
/** The factory started from one approved screen. */
function building(): State {
  const r = openRound(fresh(), "experience", at(1));
  const a = addScreen(r.state, r.n, at(2), { title: "Trip plan", variants: [] });
  const s = run(pePass(a.state, a.id, 1, [{ verdict: "feasible" }], at(2)), "approveArtifact", { artifactId: a.id, version: 1 }, at(3)).state;
  return startFactoryAsOwner(s, at(4));
}
const edit = (s: State, text: string, focus: string, sec: number) => runCommand(s, "editVision", { expectedRev: M.currentVision(s).rev, text, focus, reason: "offline matters" }, at(sec)).state;

describe("the vision text and the draft", () => {
  it("before the start, an edit goes into force at once, as before", () => {
    const s = edit(fresh(), NEW_TEXT, "Plan a trip", 1);
    expect(M.currentVision(s)).toMatchObject({ rev: 2, text: NEW_TEXT });
    expect(s.blueprint.draft.vision).toBeUndefined();
  });

  it("after the start, an edit of the text stays in the draft until Lock in: the factory keeps the text in force", () => {
    const base = building();
    const draftRev = base.blueprint.draft.rev;
    let s = edit(base, NEW_TEXT, "Plan a trip", 10);
    expect(M.currentVision(s)).toMatchObject({ rev: 1, text: VISION });
    expect(s.blueprint.draft).toMatchObject({ rev: draftRev + 1, vision: { text: NEW_TEXT, reason: "offline matters", at: at(10) } });
    expect(M.draftVisionText(s)).toBe(NEW_TEXT);
    expect(B.hasDraft(s)).toBe(true);
    expect(s.events.at(-1)!.message).toBe("The draft: the vision text changed (offline matters); it goes into force at your Lock in");
    expect(B.lockInSummary(s).changes.vision).toEqual({ text: NEW_TEXT, reason: "offline matters", replacesRev: 1 });
    // A vision change alone is a change to lock in; it touches no task, so it makes no change order.
    s = runCommand(s, "lockIn", { draftRev: s.blueprint.draft.rev }, at(11)).state;
    expect(M.currentVision(s)).toMatchObject({ rev: 2, author: "user", text: NEW_TEXT, focus: "Plan a trip", reason: "Locked in: offline matters" });
    expect(B.currentBlueprint(s)).toMatchObject({ rev: 2, visionRev: 2, reason: "locked in: changed the vision text", lockIn: { summary: { changes: { vision: { replacesRev: 1 } } } } });
    expect(s.blueprint.draft.vision).toBeUndefined();
    expect(B.hasDraft(s)).toBe(false);
    expect(s.blueprint.changeOrders).toEqual([]);
  });

  it("a focus change applies at once, while the text waits; an edit that changes nothing is refused", () => {
    let s = building();
    s = edit(s, NEW_TEXT, "Offline first", 10);
    expect(M.currentVision(s)).toMatchObject({ rev: 2, text: VISION, focus: "Offline first" });
    expect(M.draftVisionText(s)).toBe(NEW_TEXT);
    expect(() => edit(s, NEW_TEXT, "Offline first", 11)).toThrow("Nothing changed: the text is the draft's, and the focus is the one in force.");
    // Writing the text in force again clears the draft's text.
    s = edit(s, VISION, "Offline first", 12);
    expect(s.blueprint.draft.vision).toBeUndefined();
    expect(B.hasDraft(s)).toBe(false);
  });

  it("an approval keeps the draft's text, a discard drops it, and the Lock in takes the text and the items together", () => {
    const f = changeOrdered();
    // After the change order of the fixture: a new text, then a new screen approved into the draft.
    let s = edit(f.s, NEW_TEXT, "", 30);
    const r = openRound(runCommand(s, "closeRound", { round: 2 }, at(31)).state, "experience", at(31));
    const a = addScreen(r.state, r.n, at(32), { title: "Weather", variants: [] });
    s = run(pePass(a.state, a.id, 1, [{ verdict: "feasible" }], at(32)), "approveArtifact", { artifactId: a.id, version: 1 }, at(33)).state;
    expect(s.blueprint.draft.vision?.text).toBe(NEW_TEXT);
    expect(runCommand(s, "discardDraft", { draftRev: s.blueprint.draft.rev }, at(34)).state.blueprint.draft.vision).toBeUndefined();
    s = runCommand(s, "lockIn", { draftRev: s.blueprint.draft.rev }, at(35)).state;
    expect(B.currentBlueprint(s)!.reason).toBe("locked in: added Weather v1; changed the vision text");
    expect(B.currentBlueprint(s)!.visionRev).toBe(M.currentVision(s).rev);
    expect(M.currentVision(s).text).toBe(NEW_TEXT);
  });

  it("a lead's vision draft the owner accepts while building goes into the draft, with its source", () => {
    const base = M.postMessage(building(), "Make it work offline on the trail.", at(10));
    const r = M.startLeadRun(base, { provider: "claude", model: "m", trigger: "message" }, at(10));
    let s = M.completeLeadRun(r.state, r.runId, { reply: "Drafted.", proposals: [], vision: { text: NEW_TEXT, reason: "Your message" } } as never, at(11));
    const d = M.openVisionDraft(s)!;
    expect(d).toMatchObject({ text: NEW_TEXT, status: "open" });
    s = runCommand(s, "acceptVisionDraft", { draftId: d.id, expectedRev: 1 }, at(12)).state;
    expect(M.currentVision(s).rev).toBe(1);
    expect(s.blueprint.draft.vision).toMatchObject({ text: NEW_TEXT, reason: `Accepted the lead's draft (${d.id}): Your message`, source: { draftId: d.id, leadRunId: r.runId } });
    expect(s.visionDrafts.find((x) => x.id === d.id)).toMatchObject({ status: "accepted" });
    // The lead's next draft is compared with the draft's text: the same text is nothing to decide.
    const again = M.startLeadRun(M.postMessage(s, "Again?", at(13)), { provider: "claude", model: "m", trigger: "message" }, at(13));
    const same = M.completeLeadRun(again.state, again.runId, { reply: "Same.", proposals: [], vision: { text: NEW_TEXT } } as never, at(14));
    expect(same.conversation.at(-1)!.rejected).toEqual(["Vision draft: the draft is the same as the current vision"]);
  });
});
