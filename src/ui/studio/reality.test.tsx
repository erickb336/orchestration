// ORC-029 pass 5, screen 5: Design and reality, the list with evidence. One row per blueprint item in force (name,
// kind, version, factory status, tasks, rule results, evidence thumbnails); beside it the chosen item: on each device
// the approved design beside the built screenshot, the demo beside the built recording, each built side captioned
// from its evidence record (commit, design version, time, "not the current design version"), or why there is none
// with the log excerpt; the UX review's differences; or each rule of a flow with its test result.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import { itemFactoryStatus } from "../../domain/studio/itemStatus";
import { blueprintScene, citingTask, landTask, testReport } from "../../domain/testing/blueprintScene";
import { builtBy, captured, capturedAs, decisionOn, landedCommit, realityBase, realityScene, shotFile } from "../../domain/testing/realityScene";
import { lockInAsOwner } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { Review } from "../Review";
import { renderScreen, testService, visible } from "../testStore";
import { ItemDetail, Reality } from "./Reality";
import { gapWords, statusWhy } from "./realityView";

const svc = testService({ prototypePort: 5320 });
const rowHtml = (s: State) => {
  const html = renderScreen(<Reality />, s, svc);
  const list = html.slice(html.indexOf('aria-label="Parts of the design"'), html.indexOf('class="st-reality__detail"'));
  return [...list.matchAll(/<button[^>]*class="st-bprow"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
};
const rows = (s: State) => rowHtml(s).map(visible);
const detailHtml = (s: State, itemId: string) => renderScreen(<ItemDetail view={itemFactoryStatus(s, itemId)!} />, s, svc);
const detail = (s: State, itemId: string) => visible(detailHtml(s, itemId));
const why = (s: State, id: string) => statusWhy(itemFactoryStatus(s, id)!);

describe("Design and reality", () => {
  it("lists each item in force with its kind, version, status, tasks and rule results; a dropped item is named, not listed", () => {
    const sc = blueprintScene();
    expect(rows(sc.s)).toEqual([
      `Trip plan v1 screen in the draft ${sc.tasks.plan} running design`,
      `Trip data v1 contract built, not verified ${sc.tasks.data} landed`,
      "Words v1 dictionary in force no task yet",
      `Join flow v1 flow fails a check ${sc.tasks.join} landed Tests: 4 of 6 pass · 1 fails · 1 no test`,
      `Share costs v1 flow built and verified ${sc.tasks.costs} landed Tests: 2 of 2 pass`,
      `Reminders v1 flow in the draft ${sc.tasks.reminders} not started Tests: 0 of 1 pass · 1 no test`,
    ]);
    const locked = lockInAsOwner(sc.s, sc.at(400));
    expect(rows(locked).map((r) => r.match(/^.*? v\d+/)![0])).toEqual(["Trip plan v2", "Trip data v1", "Words v1", "Join flow v1", "Share costs v1", "Packing list v1"]);
    expect(visible(renderScreen(<Reality />, locked, svc))).toContain("Dropped, so not listed: Reminders v1.");
    expect(rows(locked)[0]).toBe(`Trip plan v2 screen designed ${sc.tasks.plan} running (from before v2) design`);
  });

  it("a row shows the evidence thumbnails: the design, and the built screenshot or recording once captured", () => {
    const sc = realityScene();
    const html = rowHtml(sc.s);
    const at = (title: string) => html.find((r) => visible(r).startsWith(title))!;
    // A screen with evidence: the design, and the built screenshot from the evidence record, served by the app.
    expect(visible(at("Trip plan v2"))).toBe(`Trip plan v2 screen fails a check ${sc.tasks.plan} landed (from before v2) · ${sc.built.plan} landed design built`);
    expect(at("Trip plan v2")).toContain(`<img src="/api/studio/file?evidence=${encodeURIComponent(sc.s.artifacts.find((a) => a.id === sc.evidence.plan)!.attemptId)}&amp;path=${encodeURIComponent(`${sc.items.plan}/desktop.png`)}"`);
    // A terminal demo: its built GIF. A screen with no evidence shows only the design. A flow has no thumbnails.
    expect(at("trips CLI v1")).toContain(encodeURIComponent(`${sc.items.cli}/demo.gif`));
    expect(visible(at("Trip summary v1"))).toMatch(/ design$/);
    expect(at("Join flow v1")).not.toContain("st-thumbs");
  });

  it("a screen: on each device the approved design beside the built screenshot, captioned from its evidence record, with the UX review's difference", () => {
    const sc = realityScene();
    const html = detailHtml(sc.s, sc.items.plan);
    const t = visible(html);
    const commit = landedCommit(sc.s, sc.built.plan).slice(0, 7);
    expect(t).toContain(`Trip plan v2 fails a check screen The UX review of ${sc.built.plan} found 1 open difference from the design.`);
    expect(t).toMatch(new RegExp(`Desktop Design · v2, approved .* Built · commit ${commit} · design v2 · .* differs: 1 open built · ${commit}`));
    expect(t).toMatch(/Mobile Design · v2, approved.* Built · commit \w{7} · design v2 · .* differs: 1 open/);
    expect(html.match(/<iframe src="http:\/\/p-/g)).toHaveLength(2); // the design, framed on desktop and on mobile
    expect(html).toContain(`alt="Trip plan as built, desktop, commit ${commit}"`);
    expect(html).toContain(encodeURIComponent(`${sc.items.plan}/mobile.png`));
    expect(t).toContain(`The UX review (${sc.built.plan}) differs F1 ${sc.items.plan}: the map comes first; the design puts it below the days On desktop and mobile the built screen shows the map above the day list. Trip plan v2 puts the day list first and the map below it. open: waits for a decision`);
    expect(t).not.toContain("not the current design version");
    // The owner accepts it: explained, and the screen is built and verified.
    const accepted = runCommand(sc.s, "decideFinding", { decisionId: decisionOn(sc.s, sc.reviews.plan, "F1").id, decision: "accept" }, sc.at(900)).state;
    expect(detail(accepted, sc.items.plan)).toContain(`Trip plan v2 built and verified screen ${sc.built.plan} landed. Its screenshots are of the landed commit, and the UX review found no open difference from the design (1 difference you accepted).`);
    expect(detail(accepted, sc.items.plan)).toContain("matches the design");
    expect(detail(accepted, sc.items.plan)).toContain("accepted F1");
  });

  it("evidence of an older design version says so; without evidence, the reason from the record and its log", () => {
    const b = realityBase();
    const v1 = { ...capturedAs(b.s, b.items.plan, [shotFile(b.items.plan, "desktop"), shotFile(b.items.plan, "mobile")]), artifactId: b.artifacts.plan, version: 1 };
    const old = captured(b.s, b.tasks.plan, [v1], b.at(440));
    const built = builtBy(old.s, b, "Trip plan: day list first", [b.items.plan], 620);
    const t = detail(built.s, b.items.plan);
    expect(t).toContain(`${built.taskId} landed. The checks do not prove it yet: the evidence shows design v1, not the current design version.`);
    expect(t).toMatch(/Built · commit \w{7} · design v1 · .* not the current design version \(v2 is in force\)/);
    const sc = realityScene();
    const summary = detail(sc.s, sc.items.summary);
    expect(summary).toContain(`Trip summary v1 built, not verified screen ${sc.built.summary} landed. The checks do not prove it yet: the preview did not start, so there is no evidence.`);
    expect(summary).toContain("No evidence yet: the preview did not start. Port 4173 did not open within 60 s. > trips@0.1.0 preview > vite preview --port 4173 Error: Cannot find module 'vite'");
    expect(detailHtml(sc.s, sc.items.summary)).toContain('<pre class="st-reality__log" aria-label="The end of the capture&#x27;s log">');
    // Said once, beside the design on its first device, not on each device.
    expect(summary.match(/No evidence yet/g)).toHaveLength(1);
    expect(summary).toContain("Desktop Design · v1, approved");
    expect(summary).not.toContain("Mobile Design");
  });

  it("a terminal demo: the approved demo beside the built recording", () => {
    const sc = realityScene();
    const html = detailHtml(sc.s, sc.items.cli);
    expect(visible(html)).toContain(`trips CLI v1 built and verified terminal-demo ${sc.built.cli} landed, and its recording is of the landed commit. Demo · v1, approved`);
    expect(visible(html)).toMatch(/Built · commit \w{7} · design v1 · .* trips CLI as built — recorded/);
    expect(html).toContain(encodeURIComponent(`${sc.items.cli}/demo.gif`));
  });

  it("a terminal demo recorded in the project's environment: its asciicast is drawn, not its plain transcript (unit E2)", () => {
    const sc = realityScene();
    const cli = sc.items.cli;
    const files = [{ path: `${cli}/demo.cast`, type: "cast" as const, bytes: 400, sha256: "c".repeat(64) }, { path: `${cli}/demo.txt`, type: "txt" as const, bytes: 80, sha256: "d".repeat(64) }];
    const { s } = captured(sc.s, sc.built.cli, [capturedAs(sc.s, cli, files)], sc.at(800));
    const html = visible(detailHtml(s, cli));
    expect(html).toContain("Reading the recording…");
    expect(html).not.toContain("Reading the transcript…");
  });

  it("a flow: each rule and example with its test result, a failing test's message, and why a line has no test", () => {
    const sc = blueprintScene();
    const t = detail(sc.s, sc.items.join);
    expect(t).toContain(`Join flow v1 fails a check flow 1 rule or example has a failing test, in the checks of ${sc.tasks.join}.`);
    expect(t).toContain('R1 When a friend opens the link, the app shall show the trip and a "Join" button. passes');
    expect(t).toContain(`R4 If the link has expired, then the app shall show "Ask the organizer for a new link". fails [${sc.items.join} R4] asks for a new link: expected an empty page to show 'Ask the organizer for a new link'`);
    expect(t).toContain(`E1 Given a full trip, when a friend opens the link, then the page says the trip is full. No test No test in the checks of landed work carries [${sc.items.join} E1].`);
    expect(t).not.toContain("No evidence yet"); // a flow's evidence is its tests
  });

  it("says why each item stands where it does", () => {
    const sc = blueprintScene();
    expect(why(sc.s, sc.items.costs)).toBe(`${sc.tasks.costs} landed, and every rule and example has a passing test.`);
    expect(why(sc.s, sc.items.data)).toBe(`${sc.tasks.data} landed. The checks do not prove it yet: the contract has no rules or examples to test.`);
    expect(why(sc.s, sc.items.words)).toBe("A dictionary is not built. It is in force: every agent's brief and the writing check use it.");
    expect(why(sc.s, sc.items.reminders)).toBe("Your draft drops it. The factory keeps it until you lock in the draft.");
    const locked = lockInAsOwner(sc.s, sc.at(400));
    expect(why(locked, sc.items.packing)).toBe("Locked in. No task builds it yet: the lead plans its tasks.");
    expect(why(locked, sc.items.plan)).toBe(`Locked in. ${sc.tasks.plan} builds an earlier version; nothing builds v2 yet.`);
    // Landed work whose rules have no test, or a skipped one, is not proved.
    const tag = (line: string) => `[${sc.items.join} ${line}]`;
    const fix = citingTask(sc.s, "Fix the expired link", [sc.items.join], sc.at(400));
    const skipped = landTask(fix.s, fix.taskId, sc.at(450), testReport([[`${tag("R4")} asks for a new link`, "passed"], [`${tag("E1")} a full trip`, "skipped", "needs a full trip fixture"]]));
    expect(why(skipped, sc.items.join)).toBe(`${sc.tasks.join}, ${fix.taskId} landed. The checks do not prove it yet: 1 test was skipped.`);
    expect(detail(skipped, sc.items.join)).toContain(`E1 Given a full trip, when a friend opens the link, then the page says the trip is full. skipped [${sc.items.join} E1] a full trip: needs a full trip fixture`);
  });

  it("words each gap the checks leave", () => {
    expect(gapWords({ why: "rules-unproved", noTest: 2, skipped: 0 }, "flow")).toBe("2 rules or examples have no test");
    expect(gapWords({ why: "rules-unproved", noTest: 1, skipped: 2 }, "flow")).toBe("1 rule or example has no test, and 2 tests were skipped");
    expect(gapWords({ why: "kind-not-checked" }, "interface")).toBe("no check proves an interface yet");
    expect(gapWords({ why: "no-evidence", reason: "not-set-up" }, "screen")).toBe("capture is not set up, so there is no evidence");
    expect(gapWords({ why: "no-evidence", reason: "no-run" }, "screen")).toBe("no capture has run for it, so there is no evidence");
    expect(gapWords({ why: "evidence-not-landed" }, "screen")).toBe("only work that has not landed has evidence");
    expect(gapWords({ why: "evidence-earlier-work", taskId: "T-003", landedTaskId: "T-007" }, "screen")).toBe("the evidence is of T-003, and T-007 landed after it");
    expect(gapWords({ why: "evidence-earlier-commit", commit: "ab".repeat(20), landedCommit: "cd".repeat(6) }, "screen")).toBe("the evidence is of commit abababa, not of the commit that landed (cdcdcdc)");
    expect(gapWords({ why: "evidence-missing-device", devices: ["mobile"] }, "screen")).toBe("no screenshot on mobile");
    expect(gapWords({ why: "evidence-warning", warning: "TypeError: days is undefined." }, "screen")).toBe("the capture has a warning: TypeError: days is undefined");
    expect(gapWords({ why: "no-ux-review" }, "screen")).toBe("the UX review has not compared it with the design");
  });

  it("before anything is locked in it says so; Results has the two views, each its own address", () => {
    const fresh = M.initProject(buildSeed(Date.parse("2026-10-02T09:00:00Z"), { inFlightRuns: false }), { name: "New", repoPath: "/tmp/new", vision: "", focus: "" }, "2026-10-02T09:00:00.000Z");
    expect(visible(renderScreen(<Reality />, fresh, svc))).toContain("Nothing is locked in yet. Each part of the design shows here once it is in force: Start the factory is your first Lock in.");
    const results = renderScreen(<Review />, fresh, svc);
    expect(results).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Delivered work</);
    expect(results).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Design and reality</);
    const paused = runCommand(blueprintScene().s, "pauseProject", {}, "2026-10-02T11:00:00.000Z").state;
    expect(rows(paused)).toHaveLength(6); // a pause changes no status
  });
});
