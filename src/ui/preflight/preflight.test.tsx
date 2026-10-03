// ORC-029 pass 6, unit 6a: the pre-flight, Start the factory's screen. It shows the blueprint by focus with PE review
// on each approved item and what is still open (named and confirmed, never a block); the first Lock in's summary;
// what the factory will do; and how it runs, set here. Start the factory sends the revisions and the open items the
// screen showed, with the settings chosen on it, and the domain records them. An empty vision blocks. There is no DOM
// test environment here, so the screen is rendered through react-dom/server, and its choices are the pure functions
// in preflightView.ts that the controls call.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import { ControlError, StaleWriteError, type FactorySettings, type State } from "../../domain/types";
import { fmtTime } from "../common";
import { renderScreen, visible } from "../testStore";
import { Preflight, type PreflightProps } from "./Preflight";
import { StartFactoryLink } from "./StartFactoryLink";
import { preflightScene } from "./preflightScene";
import * as V from "./preflightView";

const page = (state: State, over: Partial<PreflightProps> = {}) => {
  const props: PreflightProps = { state, settings: M.currentFactorySettings(state), agreed: false, stale: false, busy: false, offline: false, simulated: false, onSettings: () => {}, onAgree: () => {}, onStart: () => {}, ...over };
  const html = renderScreen(<Preflight {...props} />, state);
  return { html, text: visible(html) };
};
/** The Start the factory button's tag: whether it waits, and why. */
const startButton = (html: string) => html.match(/<button[^>]*>Start the factory<\/button>/)?.[0] ?? "";
/** Start the factory as the screen sends it, through the command table. */
const start = (s: State, seen: V.Seen, settings: FactorySettings, at: string) => {
  const c = V.startFactoryCommand(seen, settings);
  return runCommand(s, c.name, c.args, at).state;
};

describe("the pre-flight", () => {
  it("shows the blueprint by focus with PE review on each approved item, and names what is still open", () => {
    const { text } = page(preflightScene().s);
    expect(text).toContain("The blueprint The experience · 2 approved Trip plan v1 PE: agreed Packing list v1 PE: agreed Inputs and outputs · 2 approved Trip data v1 PE: agreed Words v1 PE: not reviewed Flows · 1 approved Join flow v1 PE: agreed");
    expect(text).toContain(
      'Still open Open Areas of the vision not clear yet: "Constraints: technical, time, budget, platforms" and "Risks and unknowns". Open Trip map v1: you marked it Change. It stays in the draft. Open A PE probe is still running: Can the trip plan load offline on the trail? None of these stops the start.',
    );
  });

  it("holds the first Lock in's summary, from the Lock in screen's parts", () => {
    const { text } = page(preflightScene().s);
    expect(text).toContain("Your first Lock in Start the factory is your first Lock in. It puts the draft into force as Lock in 1, and records this summary with your agreement. The open items stay in the draft.");
    expect(text).toContain("What changes Added Trip plan v1 (new; no task builds it yet) Added Packing list v1 (new; no task builds it yet) Added Trip data v1");
    expect(text).toContain("New work Trip plan v1, Packing list v1, Trip data v1, Words v1, Join flow v1 have no task yet.");
  });

  it("says what the factory will do: the planned tasks by flow, the agents, the limits, and the budgets beside the PE's estimate (no estimate, never $0)", () => {
    const { s } = preflightScene();
    const { text } = page(s);
    expect(text).toContain("The tasks 2 planned tasks: 1 Feature and 1 Change. T-001 Packing list Feature Starts when the factory starts T-002 Join by link Change Starts when the factory starts");
    expect(text).toContain("Claude · auto: the lead, the designer, the code reviewer, the security reviewer and the UX reviewer. Codex · auto: the coder. The PE: the other provider than the one that made the work, so its review is independent.");
    expect(text).toContain("Up to 3 agents at once (Claude at most 3 and Codex at most 3). Each run stops at 40 turns or 20 minutes; a Claude run also stops at $2.00.");
    expect(text).toContain("Building: $0.00 spent of $40.00. The factory stops and asks you at $40.00.");
    expect(text).toContain("No total estimate: 4 changes have no estimate from the PE. Trip plan v1: no estimate. Packing list v1: building $3–$5, maintenance $0.40–$0.80 a month.");
    expect(text).toContain("Maintenance: no estimate yet. The budget is $10.00 a month.");
    // On Check-in, the same tasks wait for your go-ahead.
    expect(page(s, { settings: V.chooseAutonomy(M.currentFactorySettings(s), "checkin") }).text).toContain("T-001 Packing list Feature Waits for your go-ahead");
    // With nothing planned, the lead plans after the start.
    const empty = M.initProject(s, { name: "Empty", repoPath: "/tmp/empty", vision: "A to-do list.", focus: "" }, preflightScene().at(500));
    expect(page(empty).text).toContain("No task is planned yet. After the start, the lead plans the tasks from the blueprint, and the PE reviews them before they start.");
    expect(page(empty).text).toContain("Nothing is approved yet. The factory builds from the vision text alone.");
  });

  it("an empty vision blocks: it says why, and Start the factory and the agreement wait", () => {
    const { s, at } = preflightScene();
    const blank = M.initProject(s, { name: "Blank", repoPath: "/tmp/blank", vision: "", focus: "" }, at(401));
    const { html, text } = page(blank, { agreed: true });
    expect(text).toContain("The factory cannot start yet. Write or accept a vision first. Shape the vision");
    expect(startButton(html)).toContain('aria-disabled="true"');
    expect(html).toContain('<span class="k-btn-reason"');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"[^>]*\/><span class="k-check__text">I have reviewed the blueprint/);
    expect(() => start(blank, V.seenNow(blank), M.currentFactorySettings(blank), at(402))).toThrow(ControlError);
    // The way in from Home says it too; with a vision it does not.
    expect(visible(renderScreen(<StartFactoryLink />, blank))).toBe("Start the factory… Write or accept a vision first.");
    expect(visible(renderScreen(<StartFactoryLink />, s))).toBe("Start the factory…");
  });

  it("Start the factory waits for the agreement, and for the service", () => {
    const { s } = preflightScene();
    expect(startButton(page(s).html)).toContain('title="Tick the box first: your agreement is recorded with the start."');
    expect(startButton(page(s, { agreed: true }).html)).not.toContain("aria-disabled");
    expect(startButton(page(s, { agreed: true, offline: true }).html)).toContain('title="The service is offline."');
    expect(page(s).text).toContain("I have reviewed the blueprint and want the factory to build it, with the open items above as they are.");
  });

  it("the start names every open item the screen showed: the domain accepts them as confirmed and records them", () => {
    const { s, at, probeId } = preflightScene();
    const seen = V.seenNow(s);
    const trip = s.blueprint.draft.items.find((i) => i.title === "Trip map")!.id;
    expect(seen.open).toEqual(["constraints", "risks", trip, probeId]);
    const b = start(s, seen, M.currentFactorySettings(s), at(400));
    expect(b.project.stage).toBe("building");
    expect(b.project.factoryStarts.at(-1)).toMatchObject({ by: "user", blueprintRev: 1, visionRev: 1, openItems: ["constraints", "risks", trip, probeId] });
    // Without an open item, the domain refuses: the screen's command never leaves one out.
    const c = V.startFactoryCommand({ ...seen, open: seen.open.slice(1) }, M.currentFactorySettings(s));
    expect(() => runCommand(s, c.name, c.args, at(400))).toThrow("Still open and not confirmed: constraints");
  });

  it("a stale request: the draft or what is open moved since the screen showed it; the old request is refused, and the screen says so", () => {
    const { s, at, probeId } = preflightScene();
    const seen = V.seenNow(s);
    const x = M.currentFactorySettings(s);
    // Another approval moves the draft: refused as stale.
    const map = s.studio.artifacts.find((a) => a.title === "Trip map")!.id;
    const moved = runCommand(runCommand(s, "sendFeedback", { entries: [{ artifactId: map, version: 1, mark: null, pins: [], note: "", rows: [] }] }, at(400)).state, "approveArtifact", { artifactId: map, version: 1 }, at(401)).state;
    expect(V.sameSeen(V.seenNow(moved), seen)).toBe(false);
    expect(() => start(moved, seen, x, at(402))).toThrow(StaleWriteError);
    // A new probe opens without a new draft revision: the screen sees it, and the old request is refused.
    const probe = runCommand(s, "addProbe", { question: "Can two friends edit one list at once?" }, at(403)).state;
    expect(V.sameSeen(V.seenNow(probe), seen)).toBe(false);
    expect(() => start(probe, seen, x, at(404))).toThrow(/Still open and not confirmed: probe-/);
    // A probe that finishes changes what is open too.
    const done = runCommand(s, "setProbeStatus", { probeId, status: "failed", failure: "no device" }, at(405)).state;
    expect(V.sameSeen(V.seenNow(done), seen)).toBe(false);
    // A budget set while the owner reads changes the Lock in summary the start records (review finding 13).
    const budgeted = runCommand(s, "setBudgets", { buildingUsd: 55, maintenanceUsdPerMonth: 12 }, at(406)).state;
    expect([budgeted.blueprint.draft.rev, V.sameSeen(V.seenNow(budgeted), seen)]).toEqual([s.blueprint.draft.rev, false]);
    expect(() => start(budgeted, seen, x, at(407))).toThrow(/^The Lock in summary changed since you read it/);
    expect(page(moved, { stale: true }).text).toContain("The draft, the vision, the summary or what is open changed while you read. This is the new pre-flight. Read it again, and agree again to start the factory.");
    expect(page(s).text).not.toContain("changed while you read");
  });

  it("after the start, it says what was recorded and links to the factory floor", () => {
    const { s, at } = preflightScene();
    const b = start(s, V.seenNow(s), V.chooseAutonomy(M.currentFactorySettings(s), "checkin"), at(400));
    const { html, text } = page(b);
    expect(text).toContain(
      `The factory started. Started by you, ${fmtTime(at(400))}, from Lock in 1 and vision r1. Recorded with your agreement: the Lock in summary, how the factory runs, the 4 open items you accepted. The factory starts on Check-in;`,
    );
    expect(html).toMatch(/<a href="#\/overview"[^>]*>Go to the factory floor<\/a>/);
    expect(text).not.toContain("I have reviewed the blueprint");
    expect(visible(renderScreen(<StartFactoryLink />, b))).toBe("");
    // A project already in the factory with no recorded start (seeded, or from before the pre-flight) says so.
    const seeded = buildSeed(Date.parse("2026-10-02T09:00:00Z"), { inFlightRuns: false });
    expect(seeded.project.factoryStarts).toEqual([]);
    expect(page(seeded).text).toBe("Vision › Start the factory The factory is running. No start is recorded: this project was in the factory before the pre-flight existed. Vision stays open while the factory runs, and each later change goes through Lock in. Go to the factory floor Open Vision");
  });
});

describe("how the factory runs, set on the pre-flight", () => {
  const base = (): FactorySettings => ({ autonomy: "autopilot", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "pe", changeOrders: "lead", startEachTask: false } });

  it("the mode: Check-in waits before each task and asks you about trade-offs; Autopilot never waits and the PE decides; Manual keeps the wait", () => {
    const checkin = V.chooseAutonomy(base(), "checkin");
    expect(checkin).toEqual({ ...base(), autonomy: "checkin", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: true } });
    expect(V.chooseAutonomy(checkin, "manual").pausePoints).toEqual({ tradeoffs: "user", changeOrders: "lead", startEachTask: true });
    expect(V.chooseAutonomy(checkin, "autopilot").pausePoints).toEqual({ tradeoffs: "pe", changeOrders: "lead", startEachTask: false });
    // Choosing the mode it has changes nothing, even a trade-off route you set.
    const asked = V.chooseTradeoffs(base(), true);
    expect(V.chooseAutonomy(asked, "autopilot")).toBe(asked);
  });

  it("each pause point: trade-offs, change orders, before each task (which is the mode), and before merging (pull requests only)", () => {
    expect(V.chooseTradeoffs(base(), true).pausePoints.tradeoffs).toBe("user");
    expect(V.chooseTradeoffs({ ...base(), pausePoints: { ...base().pausePoints, tradeoffs: "user" } }, false).pausePoints.tradeoffs).toBe("pe");
    expect(V.chooseChangeOrders(base(), true).pausePoints.changeOrders).toBe("user");
    expect(V.chooseWaitBeforeEachTask(base(), true)).toMatchObject({ autonomy: "checkin", pausePoints: { startEachTask: true } });
    expect(V.chooseWaitBeforeEachTask(V.chooseAutonomy(base(), "checkin"), false)).toMatchObject({ autonomy: "autopilot", pausePoints: { startEachTask: false } });
    const manual = V.chooseAutonomy(base(), "manual");
    expect(V.chooseWaitBeforeEachTask(manual, true)).toBe(manual);
    expect(V.chooseMerge(base(), "auto")).toEqual(base());
    const pr: FactorySettings = { ...base(), delivery: { mode: "pr", branch: "main", merge: "user" } };
    expect(V.chooseMerge(pr, "auto").delivery).toEqual({ mode: "pr", branch: "main", merge: "auto" });
  });

  it("the controls show the choice, and say why one cannot change", () => {
    const { s } = preflightScene();
    const manual = page(s, { settings: V.chooseAutonomy(M.currentFactorySettings(s), "manual") });
    expect(manual.html).toMatch(/aria-checked="true"[^>]*>Manual<\/button>/);
    expect(manual.text).toContain("Before each task starts: wait for my go-ahead On Manual nothing starts until you start it.");
    expect(manual.html).toMatch(/<input disabled=""[^>]*checked=""\/><span class="k-check__text">Before each task starts/);
    // Delivery is off: you merge, and the other choice waits for pull requests.
    expect(manual.html).toMatch(/aria-checked="false"[^>]*disabled=""[^>]*>Merges automatically<\/button>/);
    expect(manual.text).toContain("Who merges You merge Merges automatically Delivery is off: finished work stays on the integration branch, and you merge it.");
    expect(page(s).text).toContain("At the building budget: it always stops and asks you It stops at $40.00 and asks you before it spends more.");
    const noBudget = runCommand(s, "setBudgets", { buildingUsd: null, maintenanceUsdPerMonth: 10 }, preflightScene().at(400)).state;
    expect(page(noBudget).text).toContain("No building budget is set, so the factory does not stop for cost.");
  });

  it("every combination the screen can make starts the factory, and the start records it as chosen", () => {
    const { s, at } = preflightScene();
    const pr = runCommand(s, "setDeliveryMode", { mode: "pr" }, at(399)).state;
    const seen = V.seenNow(pr);
    let x = M.currentFactorySettings(pr);
    expect(x.delivery).toEqual({ mode: "pr", branch: "main", merge: "user" });
    let n = 0;
    for (const mode of ["autopilot", "checkin", "manual"] as const)
      for (const tradeoffs of [true, false])
        for (const changeOrders of [true, false])
          for (const merge of ["user", "auto"] as const) {
            x = V.chooseMerge(V.chooseChangeOrders(V.chooseTradeoffs(V.chooseAutonomy(x, mode), tradeoffs), changeOrders), merge);
            const b = start(pr, seen, x, at(400 + n++));
            expect(b.project.factoryStarts.at(-1)!.settings).toEqual(x);
            expect(M.currentFactorySettings(b)).toEqual(x);
          }
    expect(n).toBe(24);
  });
});
