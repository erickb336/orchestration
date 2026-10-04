// ORC-029 pass 5, screen 2: Vision with a draft. A bar at the top of the studio, one line since ORC-030 C1 ("Draft · 3
// changes · 1 open"): Show opens the draft's changes since the last Lock in (added, changed with what it replaces,
// dropped, open) and Discard the draft; Lock in… (Start the factory… in Vision) puts it into force. With an empty draft,
// the bar's main button is Ask the lead for a round. Each artifact in the left column says "in the draft" or "in
// force", and a changed artifact shows the draft's version beside the version in force.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import * as S from "../../domain/studio/studio";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import { addScreen, lockInArgs, openRound, peAgrees, run } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { renderScreen, testService, visible } from "../testStore";
import { blueprintPlace, discardConfirm, draftHeading, draftLines, lockInBlocker } from "./draftView";
import { Studio } from "./Studio";

const studio = (s: State) => {
  const html = renderScreen(<Studio />, s, testService({ prototypePort: 5320 }));
  return { html, text: visible(html) };
};
const place = (s: State, artifactId: string, version: number) => blueprintPlace(s, S.versionsOf(s, artifactId).find((a) => a.version === version)!);

describe("the draft bar", () => {
  it("is one line: the count of changes and open items, Show (the list, each change with what it replaces or why it stays), and Lock in…", () => {
    const { s } = blueprintScene();
    expect(draftLines(s).map((l) => `${l.kind}: ${l.name} (${l.note})`)).toEqual([
      "added: Packing list v1 (new; no task builds it yet)",
      "changed: Trip plan v2 (replaces v1)",
      "dropped: Reminders v1 (it leaves the design)",
      "open: Trip map v1 (you marked it Change. It stays out of the Lock in)",
    ]);
    expect(draftHeading(s)).toEqual({ title: "Draft · 3 changes · 1 open", since: expect.stringMatching(/^Since Lock in 1 \(.*\)\. The factory builds from Lock in 1, never from the draft\.$/) });
    const { html, text } = studio(s);
    // One line until Show: the list and Discard the draft are behind it.
    expect(text).toContain("Draft · 3 changes · 1 open Show Lock in…");
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="st-draft-list"[^>]*>Show<\/button>/);
    expect(text).not.toContain("Discard the draft");
    expect(text).not.toContain("Added Packing list v1");
    expect(html).toContain('<a href="#/vision/lock-in" class="k-btn k-btn--primary k-btn--small">Lock in…</a>');
    expect(text).not.toContain("Nothing is in the draft");
  });

  it("a vision text edited while the factory runs is a change in the bar, with why, until the Lock in; Discard takes it too", () => {
    const { s, at } = blueprintScene();
    const v = s.project.visions.at(-1)!;
    const edited = runCommand(s, "editVision", { expectedRev: v.rev, text: "Weekend trips for friends, with one shared packing list.", focus: v.focus, reason: "Packing is shared" }, at(400)).state;
    expect(draftLines(edited)[0]).toEqual({ kind: "changed", itemId: "vision-text", name: "Vision text", note: '"Packing is shared"; it goes into force with the Lock in' });
    expect(studio(edited).text).toContain("Draft · 4 changes · 1 open Show");
    expect(draftLines(edited).map((l) => `${l.kind} ${l.name}`).slice(0, 2)).toEqual(["changed Vision text", "added Packing list v1"]);
    expect(discardConfirm(edited).text).toBe("Your 4 changes and 1 open item since Lock in 1 go. The draft becomes Lock in 1 again. The artifacts, your marks and your notes stay.");
    // Only the text in the draft: the bar is there, with one change.
    const only = runCommand(runCommand(s, "discardDraft", { draftRev: s.blueprint.draft.rev }, at(401)).state, "editVision", { expectedRev: v.rev, text: "Weekend trips for friends.", focus: v.focus, reason: "Shorter" }, at(402)).state;
    expect(draftHeading(only).title).toBe("Draft · 1 change");
    expect(lockInBlocker(only)).toBeUndefined();
    expect(studio(only).text).toContain("Draft · 1 change Show Lock in…");
  });

  it("without a draft, while the factory runs: what the factory builds from, and Ask the lead for a round (ORC-030 a-vision-empty)", () => {
    const { s } = blueprintScene();
    const none = runCommand(s, "discardDraft", { draftRev: s.blueprint.draft.rev }, "2026-10-02T10:00:00.000Z").state;
    const { html, text } = studio(none);
    expect(text).not.toContain("Draft ·");
    expect(text).not.toContain("Lock in…");
    expect(text).toContain("Nothing is in the draft. The factory builds from Lock in 1. A part you mark Keep goes into the draft when you send it. Ask the lead for a round");
    expect(html).toMatch(/<button[^>]*class="k-btn k-btn--primary k-btn--small"[^>]*>Ask the lead for a round<\/button>/);
    // The factory runs: there is no Start the factory.
    expect(text).not.toContain("Start the factory…");
  });

  it("Discard the draft asks first and names what goes; a draft with only open items has nothing to lock in", () => {
    const { s, at } = blueprintScene();
    expect(discardConfirm(s)).toEqual({ title: "Discard the draft?", text: "Your 3 changes and 1 open item since Lock in 1 go. The draft becomes Lock in 1 again. The artifacts, your marks and your notes stay.", primaryLabel: "Discard the draft", danger: true });
    expect(lockInBlocker(s)).toBeUndefined();
    const locked = runCommand(s, "lockIn", lockInArgs(s), at(400)).state;
    expect(draftHeading(locked).title).toBe("Draft · 1 open");
    expect(lockInBlocker(locked)).toBe("There is nothing to lock in: the draft holds only open items, which stay in the draft.");
  });

  it("in Vision, before the first Lock in: the bar says Start the factory is the first one, and leads to its pre-flight", () => {
    const fresh = M.initProject(buildSeed(Date.parse("2026-10-02T09:00:00Z"), { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, "2026-10-02T09:00:00.000Z");
    const r = openRound(fresh, "experience", "2026-10-02T09:01:00.000Z");
    // With nothing in the draft yet, the main button is Ask the lead for a round; Start the factory… is a quiet link.
    const empty = studio(r.state);
    expect(empty.text).toContain("Nothing is in the draft yet. A part you mark Keep goes into the draft when you send it. Start the factory is your first Lock in. Ask the lead for a round Start the factory…");
    expect(empty.html).toMatch(/<button[^>]*class="k-btn k-btn--primary k-btn--small"[^>]*>Ask the lead for a round<\/button>/);
    expect(empty.html).toMatch(/<a href="#\/vision\/pre-flight" class="k-btn k-btn--quiet k-btn--small">Start the factory…<\/a>/);
    const a = addScreen(r.state, r.n, "2026-10-02T09:02:00.000Z", { variants: [{ id: "A", label: "Map first", entry: "trip-plan/index.html" }] });
    const s = run(peAgrees(a.state, a.id, 1, [], "2026-10-02T09:03:00.000Z"), "approveArtifact", { artifactId: a.id, version: 1 }, "2026-10-02T09:04:00.000Z").state;
    expect(draftHeading(s)).toEqual({ title: "Draft · 1 change", since: "Nothing is locked in yet. Start the factory is your first Lock in." });
    expect(lockInBlocker(s)).toBe("In Vision, Start the factory is your first Lock in.");
    expect(place(s, a.id, 1)).toBe("in the draft");
    const { html, text } = studio(s);
    expect(text).toContain("Draft · 1 change Show Start the factory…");
    expect(html).toMatch(/<a href="#\/vision\/pre-flight" class="k-btn k-btn--primary k-btn--small">Start the factory…<\/a>/);
    expect(html).not.toContain("Lock in…");
    expect(html).not.toContain("Ask the lead for a round");
  });
});

describe("the artifacts in the draft and in force", () => {
  it("each version says where it stands in the blueprint; the left column shows it", () => {
    const { s, artifacts } = blueprintScene();
    expect(place(s, artifacts.plan, 2)).toBe("in the draft");
    expect(place(s, artifacts.plan, 1)).toBe("in force");
    expect(place(s, artifacts.packing, 1)).toBe("in the draft");
    expect(place(s, artifacts.map, 1)).toBe("open");
    expect(place(s, artifacts.words, 1)).toBe("in force");
    const reminders = S.latestArtifacts(s).find((a) => a.title === "Reminders")!;
    expect(blueprintPlace(s, reminders)).toBe("dropped");
    // Round 4 is open, so the left column lists its artifacts.
    expect(studio(s).text).toContain("Trip plan screen · v2 in the draft");
  });

  it("a changed artifact shows the draft's version beside the version in force, with the work on it; another version does not", () => {
    const { s, tasks } = blueprintScene();
    const { html, text } = studio(s); // round 4's first artifact: Trip plan v2, which replaces v1
    expect(html).toContain('aria-label="v2, in the draft"');
    expect(html).toContain('aria-label="v1, in force"');
    expect(text).toContain(`v1 · in force (Lock in 1) ${tasks.plan} running`);
    // Both versions are framed: the draft's to mark, the one in force to look at.
    expect(html.match(/<iframe /g)).toHaveLength(2);
    const after = runCommand(s, "lockIn", lockInArgs(s), "2026-10-02T10:00:00.000Z").state;
    expect(studio(after).html).not.toContain('aria-label="v1, in force"');
  });
});
