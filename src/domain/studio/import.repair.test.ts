// ORC-032 repair round 1 (the domain's findings of the first review): each test reproduces one finding on tally
// (sample data), as the reviewer's probe did, and holds its fix.

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { startFactoryAsOwner } from "../testing/factory";
import { at, tallyImport } from "../testing/import";
import { addScreen, pePass, run, sha } from "../testing/studio";
import type { State } from "../types";
import { blueprintItems } from "./blueprint";
import * as I from "./import";
import { itemFactoryStatus } from "./itemStatus";
import { applyStudioBlock } from "./lead";
import * as S from "./studio";

const visionWritten = (s: State): State => run(s, "editVision", { expectedRev: M.currentVision(s).rev, text: "tally splits shared costs.", focus: "today", reason: "test" }, at(200)).state;

describe("CR-1: Start the factory waits for the import's baseline", () => {
  it("is refused while an import has no baseline, in review or still reading; it is allowed after the baseline", () => {
    for (const stage of ["read", "review", "answered"] as const) {
      const s = visionWritten(tallyImport(stage).s);
      expect(M.startFactoryBlocker(s)).toBe("The import is not locked in yet: lock its baseline in first, in Vision.");
      expect(() => startFactoryAsOwner(s, at(201))).toThrow("The import is not locked in yet: lock its baseline in first, in Vision.");
    }
    const base = visionWritten(tallyImport("baseline").s);
    expect(M.startFactoryBlocker(base)).toBeUndefined();
  });
});

describe("CR-3: round 0 stays open until the import's baseline, so no later round opens before it", () => {
  it("refuses the lead's closeRound and openRound in review, with a note; the import goes on", () => {
    let s = run(tallyImport("review").s, "postMessage", { text: "Looks right to me." }, at(200)).state;
    const started = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(201));
    const lr = started.state.leadRuns.find((x) => x.id === started.runId)!;
    const out = applyStudioBlock(started.state, lr, { closeRound: { summary: "Round 0 is done." }, openRound: { focus: "experience", summary: "Next" } }, at(202));
    expect(out.notes).toEqual(["closeRound: Round 0 is the import's: it closes with the baseline Lock in.", "openRound: Round 0 is still open; close it first."]);
    s = out.state;
    expect(s.studio.rounds.map((r) => [r.n, !!r.closedAt])).toEqual([[0, false]]);
    expect(I.importStatus(s)).toBe("review");
    // The service's commands refuse the same, and a stopped import's round 0 stays open too.
    expect(() => run(tallyImport("review").s, "closeRound", { round: 0 }, at(150))).toThrow("Round 0 is the import's: it closes with the baseline Lock in.");
    const stopped = run(tallyImport("read").s, "stopImport", { importId: tallyImport("read").importId, reason: "test" }, at(150)).state;
    expect(() => run(stopped, "closeRound", { round: 0 }, at(151))).toThrow("Round 0 is the import's: it closes with the baseline Lock in.");
  });

  it("lets the lead open round 1 once the baseline is in force (it closed round 0)", () => {
    const s = run(tallyImport("baseline").s, "openRound", { focus: "experience" }, at(150)).state;
    expect(s.studio.rounds.map((r) => [r.n, !!r.closedAt])).toEqual([
      [0, true],
      [1, false],
    ]);
  });
});

describe("CR-7: a baseline part's capture counts only for the version it recorded", () => {
  it("a terminal demo fixed after the capture is built, not verified: the capture shows an earlier version", () => {
    const sc = tallyImport("baseline", { answers: [{ on: { rule: "R1" }, option: "correct", correction: "misread", text: "It records the time too." }] });
    const add = blueprintItems(sc.s).find((i) => i.title === "tally add")!;
    expect(add.version).toBe(2);
    const view = itemFactoryStatus(sc.s, add.id)!;
    expect(view.status).toBe("built-not-verified");
    expect(view.notVerified).toEqual({ why: "evidence-older-design", version: 1 });
    // A part the fix did not touch keeps its capture.
    const split = blueprintItems(sc.s).find((i) => i.title === "tally split")!;
    expect(itemFactoryStatus(sc.s, split.id)!.status).toBe("built-and-verified");
  });
});

describe("CR-8: a stored pass-4 reproduction, from a project with no import, is never sent back for a revision", () => {
  it("ends PE review at the PE's first pass that asks for a change: no designer can revise it", () => {
    const z = tallyImport("started").s;
    const a = addScreen(z, 0, at(2), { title: "Trip list (as is)", variants: [{ id: "a", label: "As it is today", entry: "a/index.html" }], files: [{ path: "a/index.html", sha256: sha("a") }], devices: ["terminal"], provenance: { files: ["src/TripList.tsx"] } });
    const legacy = structuredClone(a.state);
    delete legacy.studio.import;
    delete legacy.studio.artifacts.find((x) => x.id === a.id)!.provenance!.commit;
    const s = pePass(legacy, a.id, 1, [{ verdict: "feasible-if", reasons: "The list matches.", change: "The code sorts by date." }], at(3));
    const v1 = s.studio.artifacts.find((x) => x.id === a.id)!;
    expect(S.peReview(s, v1)).toMatchObject({ status: "ended", ended: "earlier-rule", pass: 1 });
    expect(S.revisionDue(s, v1)).toBe(false);
    expect(S.readyForOwner(s, v1)).toBe(true);
  });
});

describe("R2-1: an owner's message in the review is not the lead's review reply", () => {
  it("after the lead answers the message, the review reply is still due, and it writes round 0's message", () => {
    let s = run(tallyImport("review").s, "postMessage", { text: "What does R16 mean?" }, at(200)).state;
    const asked = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(201));
    s = M.completeLeadRun(asked.state, asked.runId, { reply: "R16 is the refund rule.", proposals: [] }, at(202));
    expect(s.studio.rounds[0].lead).toBeUndefined();
    expect(I.importReviewWaits(s)).toBe(true);
    expect(M.leadDue(s, Date.parse(at(203)), 600)).toBe("message");
    const review = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(204));
    s = M.completeLeadRun(review.state, review.runId, { reply: "tally splits shared costs; 17 rules.", proposals: [] }, at(205));
    expect(s.studio.rounds[0].lead).toEqual({ message: "tally splits shared costs; 17 rules.", questions: [] });
    expect(I.importReviewWaits(s)).toBe(false);
  });
});
