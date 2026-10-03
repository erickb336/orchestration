// The header's two places (ORC-029 pass 5, screen 1; ORC-030 a-header-phone). Each place's state sits in its menu item:
// Vision says whether a draft waits and what it holds, or when the last Lock in was; Home says whether the factory
// started, runs (with its agents), is pausing or paused by you, or stopped at the budget. There is no row of pills, and
// the project's menu is named by the project. On a desktop the state follows the item's name; on a phone it sits under
// it, in fewer words (the CSS shows one of the two texts).

import { describe, expect, it } from "vitest";
import { runCommand } from "../domain/commands";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import { blueprintScene } from "../domain/testing/blueprintScene";
import { inVision } from "../domain/testing/factory";
import { lockInAsOwner } from "../domain/testing/studio";
import type { State } from "../domain/types";
import { Header, ProjectMenu } from "./App";
import { factoryPlaceState, visionPlaceState } from "./placesView";
import { renderScreen, visible } from "./testStore";

/** The header's Main navigation as text: each item's name and its state's desktop words (the phone's are hidden by CSS). */
const header = (s: State) => {
  const html = renderScreen(<Header tab="overview" leadOpen={false} onLead={() => {}} />, s);
  const nav = html.slice(html.indexOf('<nav class="tabs"'), html.indexOf("</nav>"));
  const items = [...nav.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map((m) => visible(m[1].replace(/<span class="tab-state__text tab-state__text--short">[^<]*<\/span>/g, "")));
  const phone = [...nav.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map((m) => visible(m[1].replace(/<span class="tab-state__text tab-state__text--long">[^<]*<\/span>/g, "")));
  return { html, items, phone };
};

describe("the header's places, in their menu items", () => {
  it("with a draft and the factory running: Home says the factory runs and with how many agents; Vision, the draft", () => {
    const { s } = blueprintScene();
    const h = header(s);
    expect(h.items).toEqual(["Home · factory running · 1 agent", "Vision · draft · 3 changes · 1 open", "Tasks", "Results", "Settings"]);
    expect(h.phone).toEqual(["Home · running", "Vision · draft 3", "Tasks", "Results", "Settings"]);
    expect(h.html).toContain('title="3 changes in the draft wait for your Lock in. 1 open item stays in the draft until you settle it. The factory builds from the version in force."');
    // The draft waits for you (amber); the factory's agents work (blue, pulsing).
    expect(h.html).toContain('class="tab-state tab-state--you"');
    expect(h.html).toContain('class="tab-state tab-state--work tab-state--pulse"');
    // No row of pills, and the header names the project once: its menu.
    expect(h.html).not.toContain("places");
    expect(h.html).not.toContain("k-pill");
    expect(h.html).toContain(`<span class="menu__label">${s.project.name}</span>`);
    // Results opens Design and reality first once anything is locked in (a-results-order).
    expect(h.html).toContain('href="#/results/design"');
  });

  it("after the Lock in: locked in, and when; a draft with only an open item; a new project with no draft and no factory", () => {
    const sc = blueprintScene();
    const locked = lockInAsOwner(sc.s, sc.at(400));
    expect(visionPlaceState({ state: "locked-in", rev: 2, at: sc.at(400) }, Date.parse(sc.at(520)))).toMatchObject({ text: "locked in 2m ago", short: "locked in" });
    expect(header(locked).items[1]).toBe("Vision · draft · 1 open item"); // Trip map stays open in the draft
    expect(header(locked).phone[1]).toBe("Vision · 1 open");
    const discarded = runCommand(locked, "discardDraft", { draftRev: locked.blueprint.draft.rev }, sc.at(410)).state;
    expect(header(discarded).items[1]).toMatch(/^Vision · locked in \S+ ago$/);
    const fresh = M.initProject(buildSeed(Date.parse(sc.at(0)), { inFlightRuns: false }), { name: "New", repoPath: "/tmp/new", vision: "", focus: "" }, sc.at(0));
    expect(header(fresh).items.slice(0, 2)).toEqual(["Home · factory not started", "Vision · no draft"]);
    expect(header(fresh).phone.slice(0, 2)).toEqual(["Home · not started", "Vision · no draft"]);
    expect(header(fresh).html).toContain('href="#/results"');
  });

  it("pausing until every run confirms, then paused by you, in Vision too; stopped at the budget; running with no agent at work", () => {
    const { s, at } = blueprintScene();
    const pausing = runCommand(s, "pauseProject", {}, at(400)).state;
    expect(header(pausing).items[0]).toBe("Home · project pausing · 1 run stopping");
    expect(header(pausing).phone[0]).toBe("Home · pausing");
    const paused = M.activeAttempts(pausing).reduce((x, a) => M.acknowledgeStop(x, a.id, at(401)), pausing);
    const p = header(paused);
    expect(p.items[0]).toBe("Home · project paused by you");
    expect(p.html).toContain("tab-state__pause");
    // In Vision, before the start, the pause is said there too (the pill beside the Project menu is gone).
    const vision = inVision(buildSeed(Date.parse(at(0)), { inFlightRuns: false }), at(1));
    const visionPaused = runCommand(vision, "pauseProject", {}, at(2)).state;
    expect(header(visionPaused).items[0]).toBe("Home · project paused by you");
    expect(factoryPlaceState({ state: "budget-stop", why: "The building budget is reached: $40.00 of $40.00" }, "Idle")).toEqual({
      text: "factory stopped at the budget",
      short: "stopped",
      tone: "you",
      title: "The building budget is reached: $40.00 of $40.00. Nothing new starts until you raise the budget or continue past it.",
    });
    expect(factoryPlaceState({ state: "running", agents: 0 }, "Idle")).toMatchObject({ text: "factory running · idle", short: "running", tone: "neutral", pulse: false });
    expect(factoryPlaceState({ state: "running", agents: 4 }, "3 agents working, 1 stopping")).toMatchObject({ text: "factory running · 4 agents", title: "The factory runs. 3 agents working, 1 stopping." });
  });

  it("the project's menu says Pausing… until every run confirms, then Project paused, with Resume project", () => {
    const running = buildSeed(Date.parse("2026-09-30T12:00:00Z"));
    expect(renderScreen(<ProjectMenu />, running)).toContain(">Pause project<");
    const pausing = M.pauseProject(running, "2026-09-30T12:00:01.000Z");
    const mid = visible(renderScreen(<ProjectMenu />, pausing));
    expect(mid).toContain("Pausing… 2 runs still stopping");
    expect(mid).toContain("Resume project");
    expect(mid).not.toContain("Project paused");
    const acknowledged = structuredClone(pausing);
    acknowledged.attempts = [];
    const done = visible(renderScreen(<ProjectMenu />, acknowledged));
    expect(done).toContain("Project paused");
    expect(done).toContain("Resume project");
  });
});
