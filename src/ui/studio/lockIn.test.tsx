// ORC-029 pass 5, screen 3: the Lock in summary. What changes; the tasks it touches and what happens to each; the new
// work; the budgets (no estimate is "no estimate", never $0); what stays open; the agreement; and "Lock in N changes",
// which names the draft revision and the digest of the summary the screen showed, so a draft, a task or a budget that
// changed meanwhile is refused.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as B from "../../domain/studio/blueprint";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import { addScreen, lockInArgs, peAgrees, run, sha } from "../../domain/testing/studio";
import { StaleWriteError, type State } from "../../domain/types";
import { renderScreen, visible } from "../testStore";
import { LockInPage } from "./LockIn";
import { lockInRequest, lockInWords } from "./lockInView";

const page = (s: State) => {
  const html = renderScreen(<LockInPage />, s);
  return { html, text: visible(html) };
};

describe("the Lock in summary", () => {
  it("says what changes, the tasks it touches and their handling, the new work, the budgets and what stays open", () => {
    const { s, tasks } = blueprintScene();
    const { text } = page(s);
    expect(text).toContain("Lock in 2 · the summary");
    expect(text).toContain("3 changes go into force What changes Added Packing list v1 (new; no task builds it yet) Changed Trip plan v2 (replaces v1) Dropped Reminders v1 (it leaves the design)");
    expect(text).toContain(`${tasks.plan} Trip plan screen Finish, then revise running It cites Trip plan v1 → v2. It finishes, then the lead revises it. No work is lost.`);
    expect(text).toContain(`${tasks.reminders} Outing reminders Retire not started It cites Reminders v1, which leaves the design. It builds only parts that leave the design, and it has not started: it is retired. Nothing is lost.`);
    expect(text).toContain("New work Packing list v1 has no task yet. The lead plans its tasks after the Lock in, and the PE reviews them before they start.");
    expect(text).toContain("What stays open Open Trip map v1 (you marked it Change. It stays out of the Lock in)");
    expect(text).toContain("I read the summary. Put these 3 changes into force, and let the lead adjust the tasks.");
    expect(text).toContain("Lock in 3 changes");
  });

  it("the budgets: the spend against the budget, the PE's estimate per change, and no estimate where the PE gave none, never $0", () => {
    const { s } = blueprintScene();
    const w = lockInWords(s);
    expect(w.building).toBe("Building: $9.90 spent of $40.00. The factory stops and asks you at $40.00.");
    expect(w.estimate).toEqual({ total: "No total estimate: 1 change has no estimate from the PE.", lines: ["Packing list v1: building $3–$5, maintenance $0.40–$0.80 a month.", "Trip plan v2: no estimate."] });
    expect(w.maintenance).toBe("Maintenance: no estimate yet. The budget is $10.00 a month.");
    expect(page(s).text).not.toMatch(/\$0(?:\.00)?\b(?!\.)/);
    // With the PE's estimate on every change, the total is their sum.
    const est = structuredClone(s);
    const plan2 = B.draftChanges(est).changed[0].item;
    est.studio.verdicts.push({ ...est.studio.verdicts.find((v) => v.artifactId === plan2.artifactId && v.version === plan2.version)!, id: "pv-est", budget: { buildUsd: [2, 4], basis: "a layout change" } });
    expect(lockInWords(est).estimate.total).toBe("The PE's estimate to build these changes: $5–$9.");
  });

  it("Lock in names the draft revision and the summary the screen showed: it succeeds, records that summary; once the draft, a task or a budget changes, it is refused", () => {
    const { s, at, tasks } = blueprintScene();
    const shown = lockInWords(s);
    const req = lockInRequest(shown);
    expect(req).toEqual({ name: "lockIn", args: { draftRev: s.blueprint.draft.rev, summaryDigest: B.summaryDigest(B.lockInSummary(s)) } });
    // Review finding 13: a touched task cancelled, or a budget set, while the owner reads; the draft is the same.
    const cancelled = runCommand(s, "cancelTask", { taskId: tasks.reminders }, at(399)).state;
    const budgeted = runCommand(s, "setBudgets", { buildingUsd: 50, maintenanceUsdPerMonth: 10 }, at(399)).state;
    for (const changed of [cancelled, budgeted]) {
      expect(changed.blueprint.draft.rev).toBe(s.blueprint.draft.rev);
      expect(() => runCommand(changed, req.name, req.args, at(400))).toThrow(/^The Lock in summary changed since you read it/);
    }
    const locked = runCommand(s, req.name, req.args, at(400)).state;
    expect(B.blueprintRev(locked)).toBe(shown.rev);
    expect(locked.blueprint.revisions.at(-1)!.lockIn).toEqual({ by: "user", summary: B.lockInSummary(s) });
    // The draft moves on (another approval) after the screen showed it: the same request is refused as stale.
    const r = addScreen(s, s.studio.rounds.at(-1)!.n, at(401), { title: "Weather", variants: [{ id: "A", label: "Forecast", entry: "weather/index.html" }], files: [{ path: "weather/index.html", sha256: sha("7") }] });
    const moved = run(peAgrees(r.state, r.id, 1, [], at(402)), "approveArtifact", { artifactId: r.id, version: 1 }, at(403)).state;
    expect(() => runCommand(moved, req.name, req.args, at(404))).toThrow(StaleWriteError);
    // The new summary says so: one more change.
    expect(lockInWords(moved).heading).toBe("4 changes go into force");
  });

  it("with only open items there is nothing to lock in, and the open item is listed; in Vision, Start the factory is the first Lock in", () => {
    const { s, at } = blueprintScene();
    const locked = runCommand(s, "lockIn", lockInArgs(s), at(400)).state;
    const open = page(locked).text;
    expect(open).toContain("Nothing to lock in The draft has no change to put into force. There is nothing to lock in: the draft holds only open items, which stay in the draft.");
    expect(open).toContain("What stays open Open Trip map v1");
    expect(open).not.toContain("I read the summary.");
    const vision = structuredClone(s);
    vision.project.stage = "shaping";
    const v = page(vision);
    expect(v.text).toContain("In Vision, Start the factory is your first Lock in. It puts these changes into force, with the settings you choose on its pre-flight. Start the factory…");
    expect(v.html).toMatch(/<a href="#\/vision\/pre-flight"[^>]*>Start the factory…<\/a>/);
    expect(v.html).not.toContain('type="checkbox"');
  });

  it("a vision text in the draft is one more change: the summary names it and shows the text against the one in force", () => {
    const { s, at } = blueprintScene();
    const v = s.project.visions.at(-1)!;
    const edited = runCommand(s, "editVision", { expectedRev: v.rev, text: `${v.text}\nEach friend packs from one shared list.`, focus: v.focus, reason: "Packing is shared" }, at(400)).state;
    const { html, text } = page(edited);
    expect(text).toContain('4 changes go into force What changes Changed Vision text ("Packing is shared"; it goes into force with the Lock in) Added Packing list v1');
    expect(text).toContain(`The vision text: your draft against r${v.rev}, the text in force The lead and the agents read the new text from this Lock in on. Weekend trips for a small group of friends. Each friend packs from one shared list.`);
    expect(html).toContain('<div class="add">Each friend packs from one shared list.</div>');
    expect(text).toContain("Put these 4 changes into force");
    // A draft that changes only the vision text can be locked in, and says there is nothing new to build.
    const only = runCommand(runCommand(s, "discardDraft", { draftRev: s.blueprint.draft.rev }, at(401)).state, "editVision", { expectedRev: v.rev, text: "Weekend trips for friends.", focus: v.focus, reason: "Shorter" }, at(402)).state;
    const w = lockInWords(only);
    expect([w.heading, w.button, w.estimate.total]).toEqual(["1 change goes into force", "Lock in 1 change", "Nothing new to build: the Lock in only changes the vision text."]);
    expect(page(only).text).not.toContain("Nothing to lock in");
  });

  it("the Lock in button waits for the agreement", () => {
    const { s } = blueprintScene();
    const { html } = page(s);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*title="Tick the box first: your agreement is recorded with this summary\."[^>]*>Lock in 3 changes<\/button>/);
  });
});
