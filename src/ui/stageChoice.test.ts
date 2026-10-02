// The new-project confirmation says what happens to attached documents.

import { describe, expect, it } from "vitest";
import { initProjectConfirm } from "./stageChoice";

describe("the new-project form", () => {
  it("the confirmation says clearly that attached documents are removed with the project", () => {
    expect(initProjectConfirm("Next", 0)).toBe('Start a new project "Next"? The current board and history are replaced.');
    expect(initProjectConfirm("Next", 1)).toContain("The 1 vision document attached to the current project is removed too, and its copy is deleted from disk");
    expect(initProjectConfirm("Next", 3)).toContain("The 3 vision documents attached to the current project are removed too, and their copies are deleted from disk; attach them again to the new project if you still need them.");
  });
});
