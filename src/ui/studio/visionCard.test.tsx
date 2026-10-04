// ORC-030 C1 (the owner's choice: the vision text lives in Vision): the card "The vision" at the top of Vision holds the
// text, its focus, its editor, the lead's draft and questions, and, one click away, its history, documents and what is
// clear. Home keeps one line of it, with Open Vision. While the factory runs, the editor edits the draft's vision text
// (draftVisionText, ORC-029 pass 5), not the text in force, and says so: the edit waits for the owner's Lock in, and
// the factory builds from the text in force until then. In Vision, an edit goes into force at once.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import { inVision } from "../../domain/testing/factory";
import { at, tallyImport } from "../../domain/testing/import";
import { lockInArgs } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { HISTORY_HASH, historyRequested, parseRoute } from "../route";
import { preflightScene } from "../preflight/preflightScene";
import { renderScreen, visible } from "../testStore";
import { Studio } from "./Studio";
import { VisionCard, VisionLine, isLongText, revisionMeta, visionDraftWords, visionLine } from "./VisionCard";

const card = (s: State) => {
  const html = renderScreen(<VisionCard />, s);
  return { html, text: visible(html) };
};

describe("the vision at the top of Vision", () => {
  it("comes first in Vision, above the draft bar and the studio: the text, its focus, Edit, and History, Documents and What is clear", () => {
    const { s } = preflightScene();
    const html = renderScreen(<Studio />, s);
    const at = (needle: string) => html.indexOf(needle);
    expect(at(">The vision<")).toBeGreaterThan(0);
    expect(at(">The vision<")).toBeLessThan(at("st-draftbar"));
    expect(at("st-draftbar")).toBeLessThan(at('aria-label="Rounds and artifacts"'));
    const { text } = card(s);
    expect(text).toMatch(/^The vision r1, by you, \S+ ago Edit Weekend trips for a small group of friends\. Focus: Plan a trip together History 1 /);
    expect(text).toContain("Documents 0 Vision documents (0)");
    // The lead reported 6 of the 9 areas clear (the fixture's coverage); it shows while in Vision.
    expect(text).toContain("What is clear: 6 of 9");
  });

  it("a text not written yet says so, and Edit is Write the vision", () => {
    const blank = M.initProject(buildSeed(Date.parse("2026-10-02T09:00:00Z"), { inFlightRuns: false }), { name: "Blank", repoPath: "/tmp/blank", vision: "", focus: "" }, "2026-10-02T09:00:00.000Z");
    const { text } = card(blank);
    expect(text).toContain("Write the vision");
    expect(text).toContain("Not written yet. Tell the lead what you want to build, or write it yourself.");
  });

  it("an imported project in review: the card names no author for an empty text, and the lead's draft comes from the import (UX-R2-2)", () => {
    const s = tallyImport("review").s;
    const review = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(200));
    const drafted = M.completeLeadRun(review.state, review.runId, { reply: "tally splits shared costs.", proposals: [], vision: { text: "tally splits shared costs.", focus: "What the product is today", reason: "A first draft from the import" } }, at(201));
    const { text } = card(drafted);
    expect(text).toMatch(/^The vision Write the vision The lead drafted a vision \S+( \S+)? ago · from the import /);
    expect(text).toContain("Not written yet. The lead's draft above comes from the import: accept it, edit it, or write your own.");
    expect(text).not.toContain("by you");
    expect(text).not.toContain("messages");
  });

  it("a long text shows its first lines, with Show all", () => {
    expect(isLongText("One line.")).toBe(false);
    expect(isLongText("1\n2\n3\n4\n5")).toBe(true);
    expect(isLongText("x".repeat(400))).toBe(true);
    const { s, at } = blueprintScene();
    const v = M.currentVision(s);
    const long = runCommand(inVision(s, at(400)), "editVision", { expectedRev: v.rev, text: "Weekend trips.\nFor friends.\nWith maps.\nOffline.\nShared lists.", focus: v.focus, reason: "Longer" }, at(401)).state;
    const { html, text } = card(long);
    expect(html).toContain('class="vision-text st-vision__clamp"');
    expect(text).toContain("Show all");
  });

  it("the history: every revision, newest first; a link to the history opens Vision with it shown", () => {
    const { s, at } = blueprintScene();
    const v = M.currentVision(s);
    const edited = runCommand(inVision(s, at(400)), "editVision", { expectedRev: v.rev, text: "Weekend trips for friends.", focus: "Offline first", reason: "Shorter" }, at(401)).state;
    const { html } = card(edited);
    expect(html).toContain('aria-label="Vision history"');
    const from = html.indexOf('aria-label="Vision history"');
    expect(visible(html.slice(html.indexOf(">", from) + 1))).toMatch(/^r2 user Shorter · focus: “Offline first” .* r1 /);
    expect(revisionMeta(M.currentVision(edited))).toMatch(/^r2, by you, /);
    expect(parseRoute(HISTORY_HASH)).toEqual({ page: "vision" });
    expect(historyRequested(HISTORY_HASH)).toBe(true);
  });
});

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
    const { html, text } = card(saved);
    expect(text).toContain(
      `Edit the draft's text Your edit of the vision text waits in the draft. "Packing is shared". It goes into force with your next Lock in. Until then the factory builds from the text in force. Lock in… In the draft: Weekend trips for friends, with one shared packing list. In force (r${v.rev}), what the factory builds from: Weekend trips for a small group of friends.`,
    );
    expect(html).toContain('href="#/vision/lock-in"');
    // After the Lock in, the text is in force and the draft holds none.
    const locked = runCommand(saved, "lockIn", lockInArgs(saved), at(401)).state;
    expect(visionDraftWords(locked)).toEqual({ building: true, text: "Weekend trips for friends, with one shared packing list." });
    expect(card(locked).text).toContain("Edit Weekend trips for friends, with one shared packing list. Focus:");
    expect(card(locked).text).not.toContain("waits in the draft");
    // While the factory runs, What is clear (a question of the vision's first rounds) is not shown.
    expect(card(locked).text).not.toContain("What is clear");
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

describe("Home's line of the vision", () => {
  it("is the first line of the text, cut to about one line, with Open Vision", () => {
    const { s, at } = blueprintScene();
    const v = M.currentVision(s);
    expect(visionLine(s)).toBe("Weekend trips for a small group of friends.");
    const long = runCommand(inVision(s, at(400)), "editVision", { expectedRev: v.rev, text: `\n${"Plan a trip with friends and keep it in one place. ".repeat(5)}\nSecond line.`, focus: "", reason: "Long" }, at(401)).state;
    expect(visionLine(long).length).toBeLessThanOrEqual(140);
    expect(visionLine(long).endsWith("…")).toBe(true);
    const html = renderScreen(<VisionLine />, s);
    expect(visible(html)).toBe("Vision Weekend trips for a small group of friends. Open Vision");
    expect(html).toContain('<a href="#/vision" class="k-btn k-btn--small">Open Vision</a>');
  });

  it("says when the lead drafted a new vision, which waits for you in Vision", () => {
    const s = inVision(buildSeed(Date.parse("2026-10-02T09:00:00Z"), { inFlightRuns: false }), "2026-10-02T09:00:00.000Z");
    const asked = M.postMessage(s, "Hikers who lose signal.", "2026-10-02T09:01:00.000Z");
    const run = M.startLeadRun(asked, { provider: "claude", model: "auto", trigger: "message" }, "2026-10-02T09:02:00.000Z");
    const question = { question: "Who is this for first?", why: "The first users decide the first milestone.", area: "audience", options: ["Just you", "A small team"] };
    const drafted = M.completeLeadRun(run.state, run.runId, { reply: "A draft.", proposals: [], vision: { text: "Hikers plan trips offline.", focus: "Offline", reason: "From your message" }, questions: [question] }, "2026-10-02T09:03:00.000Z");
    expect(M.openVisionDraft(drafted)).toBeDefined();
    expect(visible(renderScreen(<VisionLine />, drafted))).toContain("The lead drafted a new vision Open Vision");
    // In Vision, the draft itself is in the card, to accept, edit or dismiss; the lead's questions are one click away.
    const { html, text } = card(drafted);
    expect(text).toContain("The lead drafted a vision");
    expect(text).toContain("Accept as r2");
    expect(html).toMatch(/<details class="k-disc"><summary class="k-disc__summary">The lead&#x27;s questions<span class="k-count">1<\/span><\/summary>/);
    expect(text).toContain("Who is this for first?");
  });
});
