// ORC-029 pass 5, screen 5: Design and reality, the list with evidence. One row per blueprint item in force (name,
// kind, version, factory status, tasks, rule results); beside it the chosen item: the approved design beside a slot for
// what the factory built (none is captured yet), or each rule of a flow with its test result.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import { itemFactoryStatus } from "../../domain/studio/itemStatus";
import { blueprintScene, citingTask, landTask, testReport } from "../../domain/testing/blueprintScene";
import { lockInAsOwner } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { Review } from "../Review";
import { renderScreen, testService, visible } from "../testStore";
import { ItemDetail, Reality } from "./Reality";
import { statusWhy } from "./realityView";

const svc = testService({ prototypePort: 5320 });
const rows = (s: State) => {
  const html = renderScreen(<Reality />, s, svc);
  const list = html.slice(html.indexOf('aria-label="Parts of the design"'), html.indexOf('class="st-reality__detail"'));
  return [...list.matchAll(/<button[^>]*class="st-bprow"[^>]*>(.*?)<\/button>/g)].map((m) => visible(m[1]));
};
const detail = (s: State, itemId: string) => visible(renderScreen(<ItemDetail view={itemFactoryStatus(s, itemId)!} />, s, svc));

describe("Design and reality", () => {
  it("lists each item in force with its kind, version, status, tasks and rule results; a dropped item is named, not listed", () => {
    const sc = blueprintScene();
    expect(rows(sc.s)).toEqual([
      `Trip plan v1 screen in the draft ${sc.tasks.plan} running`,
      `Trip data v1 contract being built ${sc.tasks.data} landed`,
      "Words v1 dictionary in force no task yet",
      `Join flow v1 flow fails a check ${sc.tasks.join} landed Tests: 4 of 6 pass · 1 fails · 1 no test`,
      `Share costs v1 flow built and verified ${sc.tasks.costs} landed Tests: 2 of 2 pass`,
      `Reminders v1 flow in the draft ${sc.tasks.reminders} not started Tests: 0 of 1 pass · 1 no test`,
    ]);
    const locked = lockInAsOwner(sc.s, sc.at(400));
    expect(rows(locked).map((r) => r.match(/^.*? v\d+/)![0])).toEqual(["Trip plan v2", "Trip data v1", "Words v1", "Join flow v1", "Share costs v1", "Packing list v1"]);
    expect(visible(renderScreen(<Reality />, locked, svc))).toContain("Dropped, so not listed: Reminders v1.");
    expect(rows(locked)[0]).toBe(`Trip plan v2 screen being built ${sc.tasks.plan} running (from before v2)`);
  });

  it("a screen: the approved design beside the slot for what was built, which says no evidence is captured yet", () => {
    const sc = blueprintScene();
    const html = renderScreen(<ItemDetail view={itemFactoryStatus(sc.s, sc.items.plan)!} />, sc.s, svc);
    expect(visible(html)).toContain("Trip plan v1 in the draft screen Your draft changes it to v2. The factory builds v1 until you lock in the draft. Design · v1, approved");
    expect(html).toContain('<iframe src="http://p-');
    expect(visible(html)).toContain("Built No evidence yet: the factory has not captured this part.");
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
    const why = (s: State, id: string) => statusWhy(itemFactoryStatus(s, id)!);
    expect(why(sc.s, sc.items.costs)).toBe(`${sc.tasks.costs} landed, and every rule and example has a passing test.`);
    expect(why(sc.s, sc.items.data)).toBe(`${sc.tasks.data} landed. The checks do not prove it yet: the factory has not captured evidence for this part.`);
    expect(why(sc.s, sc.items.words)).toBe("A dictionary is not built. It is in force: every agent's brief and the writing check use it.");
    expect(why(sc.s, sc.items.reminders)).toBe("Your draft drops it. The factory keeps it until you lock in the draft.");
    const locked = lockInAsOwner(sc.s, sc.at(400));
    expect(why(locked, sc.items.packing)).toBe("Locked in. No task builds it yet: the lead plans its tasks.");
    expect(why(locked, sc.items.plan)).toBe(`${sc.tasks.plan} builds it now.`);
    // Landed work whose rules have no test, or a skipped one, is not proved.
    const tag = (line: string) => `[${sc.items.join} ${line}]`;
    const fix = citingTask(sc.s, "Fix the expired link", [sc.items.join], sc.at(400));
    const skipped = landTask(fix.s, fix.taskId, sc.at(450), testReport([[`${tag("R4")} asks for a new link`, "passed"], [`${tag("E1")} a full trip`, "skipped", "needs a full trip fixture"]]));
    expect(why(skipped, sc.items.join)).toBe(`${sc.tasks.join}, ${fix.taskId} landed. The checks do not prove it yet: 1 test was skipped.`);
    expect(detail(skipped, sc.items.join)).toContain(`E1 Given a full trip, when a friend opens the link, then the page says the trip is full. skipped [${sc.items.join} E1] a full trip: needs a full trip fixture`);
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
