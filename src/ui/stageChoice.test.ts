// ORC-014 review 10: the first Get-started step can always be completed, "Start building now" asks for
// a vision first, the new-project stage follows the vision until chosen, and the confirmation says
// what happens to attached documents.

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import { initProjectConfirm, newProjectStage, stageStepDone, startNowBlocker } from "./stageChoice";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
/** An empty project of the user's own: it starts by shaping, with no vision, no tasks and no conversation. */
const empty = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Mine", repoPath: "/tmp/mine", vision: "", focus: "", stage: "shaping" }, at(0));

describe("the first step (review 10)", () => {
  it("is not done for an empty shaping project until the user chooses; choosing to keep shaping completes it; a written vision or a task completes it too", () => {
    const s = empty();
    expect(s.project.stage).toBe("shaping");
    expect(stageStepDone(s, null)).toBe(false);
    // "Shape the vision with the lead first" while already shaping: the choice is recorded, and the step is done.
    expect(stageStepDone(s, "1")).toBe(true);
    // A vision written or accepted counts as the choice being made.
    expect(stageStepDone(M.editVision(s, 1, "Ship it", "", "by hand", at(1)), null)).toBe(true);
    // A project with tasks made its choice long ago.
    expect(stageStepDone(buildSeed(T0, { inFlightRuns: false }), null)).toBe(true);
  });

  it("Start building now asks for a vision first while shaping with none, and needs nothing once a vision exists or while already building", () => {
    const s = empty();
    expect(startNowBlocker(s)).toBe("Write or accept a vision first.");
    expect(startNowBlocker(M.editVision(s, 1, "Ship it", "", "by hand", at(1)))).toBeUndefined();
    expect(startNowBlocker(buildSeed(T0, { inFlightRuns: false }))).toBeUndefined();
  });
});

describe("the new-project form (review 10)", () => {
  it("defaults the stage to shaping while the vision is empty and to building once it is written; an explicit choice stands", () => {
    expect(newProjectStage(null, "")).toBe("shaping");
    expect(newProjectStage(null, "   ")).toBe("shaping");
    expect(newProjectStage(null, "Ship the apps.")).toBe("building");
    expect(newProjectStage("shaping", "Ship the apps.")).toBe("shaping");
    expect(newProjectStage("building", "")).toBe("building");
  });

  it("the confirmation says clearly that attached documents are removed with the project", () => {
    expect(initProjectConfirm("Next", 0)).toBe('Start a new project "Next"? The current board and history are replaced.');
    expect(initProjectConfirm("Next", 1)).toContain("The 1 vision document attached to the current project is removed too, and its copy is deleted from disk");
    expect(initProjectConfirm("Next", 3)).toContain("The 3 vision documents attached to the current project are removed too, and their copies are deleted from disk; attach them again to the new project if you still need them.");
  });
});
