// ORC-029 pass 5, screen 1: the header's two places, side by side on every screen. Vision says whether a draft waits
// and what it holds, or when the last Lock in was; the Factory whether it started, runs (with its agents), is paused by
// you, or stopped at the budget. Each is a link: Vision opens the studio, the Factory opens the tasks.

import { describe, expect, it } from "vitest";
import { runCommand } from "../domain/commands";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import { blueprintScene } from "../domain/testing/blueprintScene";
import { lockInAsOwner } from "../domain/testing/studio";
import type { State } from "../domain/types";
import { Places } from "./App";
import { factoryPlaceWords, visionPlaceWords } from "./placesView";
import { renderScreen, visible } from "./testStore";

const places = (s: State) => {
  const html = renderScreen(<Places />, s);
  return { html, text: visible(html) };
};

describe("the header's places", () => {
  it("with a draft and the factory running: both places, each a link to where it says", () => {
    const { s } = blueprintScene();
    const { html, text } = places(s);
    expect(text).toBe("Vision · draft, 3 changes Factory running · 1 agent");
    expect(html).toContain('href="#/vision" title="3 changes in the draft wait for your Lock in. 1 open item stays in the draft until you settle it. The factory builds from the version in force."');
    expect(html).toContain('href="#/tasks" title="1 agent working. Open the tasks."');
    // The draft waits for you (amber); the factory's agents work (blue, pulsing).
    expect(html).toContain('class="k-pill k-pill--you k-pill--link" href="#/vision"');
    expect(html).toContain('class="k-pill k-pill--work k-pill--pulse k-pill--link" href="#/tasks"');
  });

  it("after the Lock in: locked in, and when; a draft with only an open item; a new project with no draft and no factory", () => {
    const sc = blueprintScene();
    const locked = lockInAsOwner(sc.s, sc.at(400));
    expect(visionPlaceWords({ state: "locked-in", rev: 2, at: sc.at(400) }, Date.parse(sc.at(520))).text).toBe("Vision · locked in 2m ago");
    expect(places(locked).text.startsWith("Vision · draft, 1 open item ")).toBe(true); // Trip map stays open in the draft
    const discarded = runCommand(locked, "discardDraft", { draftRev: locked.blueprint.draft.rev }, sc.at(410)).state;
    expect(places(discarded).text).toMatch(/^Vision · locked in \S+ ago Factory running · 1 agent$/);
    const fresh = M.initProject(buildSeed(Date.parse(sc.at(0)), { inFlightRuns: false }), { name: "New", repoPath: "/tmp/new", vision: "", focus: "" }, sc.at(0));
    expect(places(fresh).text).toBe("Vision · no draft Factory not started");
  });

  it("the factory pausing until its runs confirm, then paused by you; stopped at the budget; running with no agent at work", () => {
    const { s, at } = blueprintScene();
    const pausing = runCommand(s, "pauseProject", {}, at(400)).state;
    expect(places(pausing).text.endsWith("Factory pausing · 1 run stopping")).toBe(true);
    const paused = M.activeAttempts(pausing).reduce((x, a) => M.acknowledgeStop(x, a.id, at(401)), pausing);
    const p = places(paused);
    expect(p.text.endsWith("Factory paused · by you")).toBe(true);
    expect(p.html).toContain("k-pill__pause");
    expect(factoryPlaceWords({ state: "budget-stop", why: "The building spend reached the $40.00 budget" }, "Idle")).toEqual({ text: "Factory stopped at the budget · needs you", tone: "you", title: "The building spend reached the $40.00 budget" });
    expect(factoryPlaceWords({ state: "running", agents: 0 }, "Idle")).toEqual({ text: "Factory running · idle", tone: "neutral", title: "Idle. Open the tasks." });
    expect(factoryPlaceWords({ state: "running", agents: 4 }, "3 agents working, 1 stopping").text).toBe("Factory running · 4 agents");
  });
});
