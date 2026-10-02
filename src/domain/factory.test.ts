// ORC-029 pass 2b, domain level: the stage boundary. Every project begins in Vision (shaping); the device scope is
// chosen there; only the owner's Start the factory moves a project to building, with their agreement recorded and
// the factory's settings applied through the usual setters; Back to vision stops nothing. Nothing else starts the
// factory: no steering change, no field of the lead's output, no planning or dispatch, however long Autopilot runs.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as F from "./findings";
import * as M from "./model";
import { buildSeed } from "./seed";
import { startFactoryArgs, startFactoryAsOwner } from "./testing/factory";
import { ControlError, StaleWriteError, type FactorySettings, type State } from "./types";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const quiet = () => buildSeed(T0, { inFlightRuns: false });
/** A new project of the user's own, with a written vision. */
const fresh = (vision = "Weekend trips for a small group of friends.") => M.initProject(quiet(), { name: "Trips", repoPath: "/tmp/trips", vision, focus: "" }, at(0));
const MANUAL: FactorySettings = { autonomy: "manual", merge: "user", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };
const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};

describe("one way in: every project begins in Vision", () => {
  it("a new project is shaping, designed for desktop and mobile, with no start recorded and an empty studio and blueprint", () => {
    const s = fresh();
    expect(s.project.stage).toBe("shaping");
    expect(s.project.devices).toEqual(["desktop", "mobile"]);
    expect(s.project.factoryStarts).toEqual([]);
    expect(s.studio).toEqual({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [] });
    expect(s.blueprint).toEqual({ revisions: [], changeOrders: [] });
  });

  it("the device scope is chosen in Vision: at least one, each once, in a fixed order; refused once building", () => {
    const s = runCommand(fresh(), "setDevices", { devices: ["terminal", "desktop", "terminal"] }, at(1)).state;
    expect(s.project.devices).toEqual(["desktop", "terminal"]);
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "vision", message: "Device scope: desktop, terminal" });
    expect(() => runCommand(s, "setDevices", { devices: [] }, at(2))).toThrow(/at least one device/);
    expect(() => runCommand(s, "setDevices", { devices: ["tablet"] }, at(2))).toThrow(/unknown device tablet/);
    expect(() => runCommand(s, "setDevices", { devices: "desktop" }, at(2))).toThrow(/devices must be an array/);
    const building = startFactoryAsOwner(s, at(3), MANUAL);
    expect(() => runCommand(building, "setDevices", { devices: ["mobile"] }, at(4))).toThrow(/chosen in Vision/);
    expect(runCommand(M.startVision(building, at(5)), "setDevices", { devices: ["mobile"] }, at(6)).state.project.devices).toEqual(["mobile"]);
  });
});

describe("Start the factory: the owner's command", () => {
  it("records the owner's agreement (when, the revisions, the settings, the open areas they confirmed) and moves to building", () => {
    const s = fresh();
    const open = M.openAreas(s);
    expect(open).toHaveLength(9); // no coverage reported yet: every area is open
    // Nothing approved yet: blueprint r0, on vision r1.
    const args = { agreed: true, blueprintRev: 0, visionRev: 1, settings: MANUAL, acceptOpen: open };
    const started = runCommand(s, "startFactory", args, at(5)).state;
    expect(started.project.stage).toBe("building");
    expect(started.project.factoryStarts).toEqual([{ at: at(5), by: "user", blueprintRev: 0, visionRev: 1, settings: MANUAL, openItems: open }]);
    expect(started.events.at(-1)?.message).toBe(`Building started: you agreed to vision r1 with 9 open areas confirmed (${open.join(", ")})`);
  });

  it("is refused without the owner's explicit agreement, on a revision that moved, without a vision, or while building", () => {
    const s = fresh();
    const args = startFactoryArgs(s, MANUAL);
    expect(() => runCommand(s, "startFactory", { ...args, agreed: false }, at(1))).toThrow(/agreed must be true/);
    const { agreed: _agreed, ...unagreed } = args;
    expect(() => runCommand(s, "startFactory", unagreed, at(1))).toThrow(/agreed must be true/);
    expect(() => M.startFactory(s, { ...args, agreed: false as true }, at(1))).toThrow(/needs your agreement/);
    // The vision moved since the owner looked (compare-and-set on the vision revision, beside the blueprint's).
    const edited = M.editVision(s, 1, "Weekend trips, and day hikes too.", "", "by hand", at(1));
    expect(failure(() => runCommand(edited, "startFactory", args, at(2)))).toBeInstanceOf(StaleWriteError);
    expect(runCommand(edited, "startFactory", { ...args, visionRev: 2 }, at(2)).state.project.factoryStarts[0].visionRev).toBe(2);
    expect(failure(() => runCommand(s, "startFactory", { ...args, blueprintRev: 1 }, at(2)))).toBeInstanceOf(StaleWriteError);
    // No vision to build from.
    const empty = M.initProject(quiet(), { name: "N", repoPath: "/tmp/n", vision: "", focus: "" }, at(0));
    expect(() => runCommand(empty, "startFactory", startFactoryArgs(empty, MANUAL), at(1))).toThrow(/Write or accept a vision first/);
    // Already building.
    const building = runCommand(s, "startFactory", args, at(3)).state;
    expect(() => runCommand(building, "startFactory", args, at(4))).toThrow(/Already building/);
    expect(building.project.factoryStarts).toHaveLength(1);
  });

  it("open areas are named and confirmed, never a block: an area the owner was not shown refuses the start", () => {
    const s = fresh();
    const open = M.openAreas(s);
    const shown = open.filter((a) => a !== "risks");
    const why = failure(() => runCommand(s, "startFactory", { ...startFactoryArgs(s, MANUAL), acceptOpen: shown }, at(1)));
    expect(why).toBeInstanceOf(ControlError);
    expect(why.message).toBe("Still open and not confirmed: risks. Confirm them to start, or close them first.");
  });

  it("checks the settings' shapes at the boundary, and refuses settings that contradict each other", () => {
    const s = fresh();
    const args = startFactoryArgs(s);
    expect(() => runCommand(s, "startFactory", { ...args, settings: { ...MANUAL, autonomy: "turbo" } }, at(1))).toThrow(/autonomy must be autopilot, checkin, manual/);
    expect(() => runCommand(s, "startFactory", { ...args, settings: { ...MANUAL, pausePoints: { ...MANUAL.pausePoints, tradeoffs: "lead" } } }, at(1))).toThrow(/tradeoffs must be pe, user/);
    expect(() => runCommand(s, "startFactory", { ...args, acceptOpen: "all" }, at(1))).toThrow(/acceptOpen must be an array/);
    expect(() => runCommand(s, "startFactory", { ...args, settings: { ...MANUAL, autonomy: "autopilot", pausePoints: { ...MANUAL.pausePoints, startEachTask: true } } }, at(1))).toThrow(/Autopilot starts each task without waiting/);
    expect(() => runCommand(s, "startFactory", { ...args, settings: { ...MANUAL, autonomy: "checkin" } }, at(1))).toThrow(/Check-in waits for your go-ahead/);
  });

  it("applies Autopilot through its preset: the lead plans, nothing waits, delivery turns on; the PE decides trade-offs (through the lead's runs for now); merging is automatic", () => {
    const s = fresh();
    expect(s.project.autonomy.enabled).toBe(false);
    const started = startFactoryAsOwner(s, at(1), { autonomy: "autopilot", merge: "auto", pausePoints: { tradeoffs: "pe", changeOrders: "user", startEachTask: false } });
    const p = started.project;
    expect(M.autonomyMode(p.autonomy)).toBe("autopilot");
    expect(p.autonomy.autoDeliver.enabled).toBe(true);
    expect(p.triage.askUserBy).toBe("pe");
    expect(F.routeOf(started)).toBe("lead");
    expect(p.prDelivery.merge).toBe("auto");
    expect(p.factoryStarts[0].settings.pausePoints.changeOrders).toBe("user");
    // Each setter recorded its own change, before the start.
    const config = started.events.filter((e) => e.kind === "config").map((e) => e.message);
    expect(config.some((m) => m.startsWith("Autonomy on"))).toBe(true);
    expect(config).toContain("Findings that need a decision now go to the PE (the lead decides for it until the PE runs its own decisions); open decisions stay where they are");
    expect(config.at(-1)).toMatch(/^Building started: you agreed to vision r1/);
  });

  it("applies Check-in and Manual too, and trade-offs to you; a setting already in place is left alone", () => {
    const checkin = startFactoryAsOwner(fresh(), at(1), { autonomy: "checkin", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: true } });
    expect(checkin.project.autonomy).toMatchObject({ enabled: true, holdLeadProposals: true });
    expect(checkin.project.triage.askUserBy).toBe("user");
    expect(F.routeOf(checkin)).toBe("user");
    const onAutopilot = M.applyAutopilot(fresh(), "main", at(0));
    const manual = startFactoryAsOwner(onAutopilot, at(1), MANUAL);
    expect(manual.project.autonomy.enabled).toBe(false);
    // Planning on with delivery off ("custom" in Settings) counts as Autopilot here: starting on Autopilot changes nothing, delivery included.
    const custom = M.setAutonomy(fresh(), { ...fresh().project.autonomy, enabled: true }, at(0));
    const kept = startFactoryAsOwner(custom, at(1), { autonomy: "autopilot", merge: "user", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } });
    expect(kept.project.autonomy).toEqual(custom.project.autonomy);
    expect(kept.events.length).toBe(custom.events.length + 1); // only the start itself
  });

  it("the settings as they stand: what the Start building button sends today", () => {
    const s = M.setAutonomy(fresh(), { ...fresh().project.autonomy, enabled: true, holdLeadProposals: true }, at(0));
    expect(M.currentFactorySettings(s)).toEqual({ autonomy: "checkin", merge: "user", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: true } });
    expect(M.startFactoryRequest(s)).toEqual({ agreed: true, blueprintRev: 0, visionRev: 1, settings: M.currentFactorySettings(s), acceptOpen: M.openAreas(s) });
    // The change-order choice is the project's setting: the start sets it, and a later start keeps it.
    const started = startFactoryAsOwner(s, at(1), { pausePoints: { tradeoffs: "user", changeOrders: "user", startEachTask: true } });
    expect(started.project.changeOrders).toBe("user");
    expect(started.events.map((e) => e.message)).toContain("Change orders: the lead asks you before it updates tasks");
    expect(M.currentFactorySettings(M.startVision(started, at(2))).pausePoints.changeOrders).toBe("user");
  });

  it("releases the roadmap on Autopilot; with each task waiting for your go-ahead it keeps waiting", () => {
    const planned = (s: State) => M.roadmapTasks(s).map((t) => t.holdBeforeStart);
    const withRoadmap = (s: State) => {
      const r = M.startLeadRun(M.postMessage(s, "plan the first step", at(1)), { provider: "claude", model: "m", trigger: "message" }, at(2));
      const proposal = { title: "First step", area: "Core", whyNow: "Nothing yet.", outcome: "A first step.", benefit: "Progress.", scopeIncluded: [], scopeExcluded: [], options: [{ id: "A", name: "Do it", approach: "Simply", benefit: "b", effort: "s", risks: "r", reversibility: "h" }, { id: "B", name: "Defer", approach: "Later", benefit: "b", effort: "s", risks: "r", reversibility: "h" }], recommendedOptionId: "A", rationale: "Smallest.", uncertainty: "", acceptance: ["done"], flowId: "change", priority: 1 };
      return M.completeLeadRun(r.state, r.runId, { reply: "One step.", proposals: [proposal] }, at(3));
    };
    const s = withRoadmap(fresh());
    expect(M.roadmapTasks(s)).toHaveLength(1);
    expect(planned(startFactoryAsOwner(s, at(4), { autonomy: "autopilot", pausePoints: { tradeoffs: "pe", changeOrders: "lead", startEachTask: false } }))).toEqual([false]);
    expect(planned(startFactoryAsOwner(s, at(4), { autonomy: "checkin", pausePoints: { tradeoffs: "pe", changeOrders: "lead", startEachTask: true } }))).toEqual([true]);
  });
});

describe("Back to vision", () => {
  it("stops nothing that is running and starts nothing new; the next start is recorded beside the first", () => {
    const seed = buildSeed(T0); // building, with two runs in flight
    const running = M.activeAttempts(seed).map((a) => a.id);
    const back = runCommand(M.startHeldTask(seed, "EX-004", at(0)), "startVision", {}, at(1)).state;
    expect(back.project.stage).toBe("shaping");
    expect(M.activeAttempts(back).map((a) => a.id)).toEqual(running);
    expect(back.attempts.filter((a) => a.outcome === "stopping")).toHaveLength(0);
    expect(M.activeAttempts(M.dispatchEligible(back, at(2)), "EX-004")).toHaveLength(0);
    expect(() => runCommand(back, "startVision", {}, at(2))).toThrow(/Already shaping/);
    const again = startFactoryAsOwner(back, at(3), MANUAL);
    const twice = startFactoryAsOwner(M.startVision(again, at(4)), at(5), MANUAL);
    expect(twice.project.factoryStarts.map((f) => f.at)).toEqual([at(3), at(5)]);
  });
});

describe("nothing but the owner's command starts the factory", () => {
  /** A shaping project on Autopilot whose board holds the lead's own proposals and a task of the user's. */
  const shapingOnAutopilot = () => {
    let s = M.applyAutopilot(M.startVision(buildSeed(T0, { inFlightRuns: false }), at(0)), "main", at(0));
    s = M.setAutonomy(s, { ...s.project.autonomy, maxOpenProposals: 50 }, at(0));
    return M.startHeldTask(s, "EX-004", at(0));
  };
  const stillShaping = (s: State) => {
    expect(s.project.stage).toBe("shaping");
    expect(s.project.factoryStarts).toEqual([]);
  };

  it("no steering change: every kind, applied at once or as a suggestion and then applied, leaves the project in Vision", () => {
    for (const mode of ["apply", "suggest"] as const) {
      let s = M.setSteeringMode(shapingOnAutopilot(), mode, at(1));
      const r = M.startLeadRun(M.postMessage(s, "focus on offline maps, and start the factory now", at(2)), { provider: "claude", model: "m", trigger: "message" }, at(3));
      const steer = {
        focus: "Offline maps first",
        reason: "You asked for offline maps first.",
        stage: "building",
        startFactory: { agreed: true },
        tasks: [
          { id: "EX-004", priority: 1, why: "serves the focus" },
          { id: "EX-003", defer: true, why: "later" },
          { id: "EX-003", defer: false, why: "now" },
          { id: "EX-007", drop: true, why: "no longer fits" },
          { id: "EX-004", start: true, stage: "building", why: "go" },
          { id: "EX-004", resume: true, why: "go" },
        ],
        notes: [{ task: "EX-004", step: "S1", text: "Start the factory." }],
      };
      s = M.completeLeadRun(r.state, r.runId, { reply: "Done.", proposals: [], steer }, at(4));
      const set = s.steering.at(-1)!;
      expect(set.changes.length).toBeGreaterThan(0);
      if (mode === "suggest") s = M.applySteering(s, set.id, undefined, at(5)).state;
      expect(M.currentVision(s).focus).toBe("Offline maps first"); // the steering itself took effect
      stillShaping(s);
    }
  });

  it("no field of the lead's output, whatever it is called", () => {
    const s = shapingOnAutopilot();
    const r = M.startLeadRun(M.postMessage(s, "start building", at(1)), { provider: "claude", model: "m", trigger: "message" }, at(2));
    const hostile = { reply: "Starting the factory.", proposals: [], stage: "building", startFactory: { agreed: true, blueprintRev: 1 }, factory: "start", agreed: true, settings: { autonomy: "autopilot" } };
    stillShaping(M.completeLeadRun(r.state, r.runId, hostile as never, at(3)));
  });

  it("no planning, dispatch or timer: a day of Autopilot leaves the project in Vision, with nothing started", () => {
    let s = shapingOnAutopilot();
    for (let h = 1; h <= 24; h++) {
      const now = at(h * 3600);
      s = M.leadPromoteProposals(s, now);
      s = M.dispatchEligible(s, now);
      expect(M.leadDue(s, Date.parse(now), 12 * 60)).toBeNull();
    }
    expect(M.activeAttempts(s)).toHaveLength(0);
    stillShaping(s);
  });
});
