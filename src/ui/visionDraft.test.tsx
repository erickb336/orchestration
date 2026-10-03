// ORC-029 pass 5: the vision editor on Home (Focus › Vision and history). While the factory runs, it edits the draft's
// vision text (draftVisionText), not the text in force, and says so: the edit waits for the owner's Lock in, and the
// factory builds from the text in force until then. In Vision, an edit goes into force at once, as before.

import { describe, expect, it } from "vitest";
import { runCommand } from "../domain/commands";
import * as M from "../domain/model";
import { blueprintScene } from "../domain/testing/blueprintScene";
import { inVision } from "../domain/testing/factory";
import { lockInArgs } from "../domain/testing/studio";
import type { State } from "../domain/types";
import { Overview, visionDraftWords } from "./Overview";
import { renderScreen, visible } from "./testStore";

const details = (s: State) => {
  const html = renderScreen(<Overview />, s);
  const from = html.indexOf(">", html.indexOf('class="k-stack k-stack--tight vision-details"')) + 1;
  return visible(html.slice(from, html.indexOf("<h3", from)));
};

describe("the vision editor while the factory runs", () => {
  it("edits the draft's text: what it saves waits in the draft, and the text in force stays", () => {
    const { s, at } = blueprintScene();
    const v = M.currentVision(s);
    expect(visionDraftWords(s)).toEqual({ building: true, text: "Weekend trips for a small group of friends." });
    // The editor saves its text against the revision in force; while building, it lands in the draft.
    const saved = runCommand(s, "editVision", { expectedRev: v.rev, text: "Weekend trips for friends, with one shared packing list.", focus: v.focus, reason: "Packing is shared" }, at(400)).state;
    expect(M.currentVision(saved).text).toBe("Weekend trips for a small group of friends.");
    expect(visionDraftWords(saved)).toEqual({
      building: true,
      text: "Weekend trips for friends, with one shared packing list.",
      waiting: '"Packing is shared". It goes into force with your next Lock in. Until then the factory builds from the text in force.',
    });
    // Both texts show, each labelled, with the way to the Lock in; the button edits the draft's text.
    expect(details(saved)).toBe(
      `Your edit of the vision text waits in the draft. "Packing is shared". It goes into force with your next Lock in. Until then the factory builds from the text in force. Review and lock in In the draft: Weekend trips for friends, with one shared packing list. In force (r${v.rev}), what the factory builds from: Weekend trips for a small group of friends. Edit the draft's text`,
    );
    expect(renderScreen(<Overview />, saved)).toContain('href="#/vision/lock-in"');
    // After the Lock in, the text is in force and the draft holds none.
    const locked = runCommand(saved, "lockIn", lockInArgs(saved), at(401)).state;
    expect(visionDraftWords(locked)).toEqual({ building: true, text: "Weekend trips for friends, with one shared packing list." });
    expect(details(locked)).toContain(`Weekend trips for friends, with one shared packing list. Edit vision What changed from r${v.rev}: Locked in: Packing is shared`);
    expect(details(locked)).not.toContain("waits in the draft");
  });

  it("in Vision, an edit goes into force at once and nothing waits", () => {
    const { s, at } = blueprintScene();
    const shaping = inVision(s, at(400));
    const v = M.currentVision(shaping);
    const saved = runCommand(shaping, "editVision", { expectedRev: v.rev, text: "Weekend trips for friends.", focus: v.focus, reason: "Shorter" }, at(401)).state;
    expect(visionDraftWords(saved)).toEqual({ building: false, text: "Weekend trips for friends." });
    expect(M.currentVision(saved).rev).toBe(v.rev + 1);
  });
});
