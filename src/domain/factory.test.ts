// ORC-029 pass 2b, domain level: the stage boundary. Every project begins in Vision (shaping); the device scope is
// chosen there; only the owner's Start the factory moves a project to building, with their agreement recorded and
// the factory's settings applied through the usual setters. There is no way back (pass 5): Vision stays open while the
// factory runs. Nothing else starts the factory: no steering change, no field of the lead's output, no planning or
// dispatch, however long Autopilot runs.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as D from "./delivery";
import * as F from "./findings";
import * as M from "./model";
import { buildSeed } from "./seed";
import * as B from "./studio/blueprint";
import { inVision, startFactoryArgs, startFactoryAsOwner } from "./testing/factory";
import { ControlError, StaleWriteError, type FactorySettings, type State } from "./types";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const quiet = () => buildSeed(T0, { inFlightRuns: false });
/** A new project of the user's own, with a written vision. */
const fresh = (vision = "Weekend trips for a small group of friends.") => M.initProject(quiet(), { name: "Trips", repoPath: "/tmp/trips", vision, focus: "" }, at(0));
const MANUAL: FactorySettings = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };
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
    expect(s.studio).toEqual({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [], runs: [] });
    expect(s.blueprint).toEqual({ revisions: [], draft: { rev: 0, items: [] }, changeOrders: [] });
  });

  it("the device scope is chosen in Vision: at least one, each once, in a fixed order; Vision stays open, so it changes while building too", () => {
    const s = runCommand(fresh(), "setDevices", { devices: ["terminal", "desktop", "terminal"] }, at(1)).state;
    expect(s.project.devices).toEqual(["desktop", "terminal"]);
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "vision", message: "Device scope: desktop, terminal" });
    expect(() => runCommand(s, "setDevices", { devices: [] }, at(2))).toThrow(/at least one device/);
    expect(() => runCommand(s, "setDevices", { devices: ["tablet"] }, at(2))).toThrow(/unknown device tablet/);
    expect(() => runCommand(s, "setDevices", { devices: "desktop" }, at(2))).toThrow(/devices must be an array/);
    const building = startFactoryAsOwner(s, at(3), MANUAL);
    expect(runCommand(building, "setDevices", { devices: ["mobile"] }, at(4)).state.project).toMatchObject({ stage: "building", devices: ["mobile"] });
  });
});

describe("Start the factory: the owner's command", () => {
  it("records the owner's agreement (when, the revisions, the settings, the open areas they confirmed) and moves to building", () => {
    const s = fresh();
    const open = M.openAreas(s);
    expect(open).toHaveLength(9); // no coverage reported yet: every area is open
    // Nothing approved yet: draft r0, on vision r1.
    const args = { agreed: true, draftRev: 0, summaryDigest: B.summaryDigest(B.lockInSummary(s)), visionRev: 1, settings: MANUAL, acceptOpen: open };
    const started = runCommand(s, "startFactory", args, at(5)).state;
    expect(started.project.stage).toBe("building");
    expect(started.project.factoryStarts).toEqual([{ at: at(5), by: "user", blueprintRev: 0, visionRev: 1, settings: MANUAL, openItems: open }]);
    expect(started.events.at(-1)?.message).toBe(`The factory started: you agreed to vision r1 with 9 open areas confirmed (${open.join(", ")})`);
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
    expect(failure(() => runCommand(s, "startFactory", { ...args, draftRev: 1 }, at(2)))).toBeInstanceOf(StaleWriteError);
    expect(() => runCommand(s, "startFactory", { ...args, draftRev: "0" }, at(2))).toThrow(/draftRev must be a number/);
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
    expect(() => runCommand(s, "startFactory", { ...args, settings: { ...MANUAL, pausePoints: { ...MANUAL.pausePoints, tradeoffs: "anyone" } } }, at(1))).toThrow(/tradeoffs must be lead, pe, user/);
    expect(() => runCommand(s, "startFactory", { ...args, acceptOpen: "all" }, at(1))).toThrow(/acceptOpen must be an array/);
    expect(() => runCommand(s, "startFactory", { ...args, settings: { ...MANUAL, autonomy: "autopilot", pausePoints: { ...MANUAL.pausePoints, startEachTask: true } } }, at(1))).toThrow(/Autopilot starts each task without waiting/);
    expect(() => runCommand(s, "startFactory", { ...args, settings: { ...MANUAL, autonomy: "checkin" } }, at(1))).toThrow(/Check-in waits for your go-ahead/);
  });

  it("applies Autopilot's planning: the lead plans, nothing waits; delivery and the PE's route as chosen; pull requests merge automatically", () => {
    const s = fresh();
    expect(s.project.autonomy.enabled).toBe(false);
    const started = startFactoryAsOwner(s, at(1), { autonomy: "autopilot", delivery: { mode: "pr", branch: "main", merge: "auto" }, pausePoints: { tradeoffs: "pe", changeOrders: "user", startEachTask: false } });
    const p = started.project;
    expect(M.autonomyMode(p.autonomy)).toBe("autopilot");
    expect(p.autonomy).toMatchObject({ planningIntervalMinutes: 30, maxProposalsPerCycle: 5, maxOpenProposals: 15, autoRetry: 1, autoDeliver: { enabled: false } });
    expect(p.prDelivery).toMatchObject({ enabled: true, base: "main", merge: "auto" });
    expect(p.triage.askUserBy).toBe("pe");
    expect([F.routeOf(started), F.routeOf(started, "final-checks")]).toEqual(["pe", "lead"]);
    expect(p.factoryStarts[0].settings.pausePoints.changeOrders).toBe("user");
    // Each setter recorded its own change, before the start.
    const config = started.events.filter((e) => e.kind === "config").map((e) => e.message);
    expect(config.some((m) => m.startsWith("Autonomy on"))).toBe(true);
    expect(config).toContain("Findings that need a decision now go to the PE (the lead decides for it until the PE runs its own decisions); open decisions stay where they are");
    expect(config.at(-1)).toMatch(/^The factory started: you agreed to vision r1/);
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
    const kept = startFactoryAsOwner(custom, at(1), { autonomy: "autopilot", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } });
    expect(kept.project.autonomy).toEqual(custom.project.autonomy);
    expect(kept.events.length).toBe(custom.events.length + 1); // only the start itself
  });

  it("keeps the owner's decision route: only settings that choose another route change it (review finding 2)", () => {
    const routing = (before: State, after: State) => after.events.slice(before.events.length).map((e) => e.message).filter((m) => m.startsWith("Findings that need a decision"));
    // The owner sent findings to the lead before starting; the Start building button sends the settings as they stand.
    const lead = F.setTriageRouting(fresh(), "lead", at(0));
    const kept = runCommand(lead, "startFactory", startFactoryArgs(lead), at(1)).state;
    expect(kept.project.triage.askUserBy).toBe("lead");
    expect(kept.project.factoryStarts[0].settings.pausePoints.tradeoffs).toBe("lead");
    expect(routing(lead, kept)).toEqual([]);
    // Starting on Autopilot from Manual applies Autopilot's planning, not its route: the lead's and yours are kept.
    const autopilot = { autonomy: "autopilot", pausePoints: { changeOrders: "lead", startEachTask: false } } as const;
    const fromLead = startFactoryAsOwner(lead, at(1), { ...autopilot, pausePoints: { ...autopilot.pausePoints, tradeoffs: "lead" } });
    expect([M.autonomyMode(fromLead.project.autonomy), fromLead.project.triage.askUserBy, routing(lead, fromLead)]).toEqual(["autopilot", "lead", []]);
    const yours = fresh();
    const fromYou = startFactoryAsOwner(yours, at(1), { ...autopilot, pausePoints: { ...autopilot.pausePoints, tradeoffs: "user" } });
    expect([M.autonomyMode(fromYou.project.autonomy), fromYou.project.triage.askUserBy, routing(yours, fromYou)]).toEqual(["autopilot", "user", []]);
    // A route the owner chooses is applied and recorded.
    const toPe = startFactoryAsOwner(lead, at(1), { pausePoints: { tradeoffs: "pe", changeOrders: "lead", startEachTask: false } });
    expect(toPe.project.triage.askUserBy).toBe("pe");
    expect(routing(lead, toPe)).toEqual(["Findings that need a decision now go to the PE (the lead decides for it until the PE runs its own decisions); open decisions stay where they are"]);
  });

  it("leaves delivery as the settings say: starting on Autopilot from Manual or Check-in turns nothing on, and the record matches the project (review finding 3)", () => {
    const checkin = M.setAutonomy(fresh(), { ...fresh().project.autonomy, enabled: true, holdLeadProposals: true }, at(0));
    for (const s of [fresh(), checkin]) {
      expect(M.currentFactorySettings(s).delivery).toEqual({ mode: "off", merge: "user" });
      const started = startFactoryAsOwner(s, at(1), { autonomy: "autopilot", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } });
      expect(M.autonomyMode(started.project.autonomy)).toBe("autopilot");
      expect([D.deliveryMode(started), started.project.autonomy.autoDeliver.enabled, started.project.prDelivery.enabled]).toEqual(["off", false, false]);
      expect(started.project.factoryStarts[0].settings.delivery).toEqual({ mode: "off", merge: "user" });
      expect(M.currentFactorySettings(started).delivery).toEqual({ mode: "off", merge: "user" });
      expect(started.events.slice(s.events.length).some((e) => e.message.startsWith("Delivery mode"))).toBe(false);
    }
  });

  it("applies the delivery chosen, and afterwards the project says what the record says", () => {
    const local = startFactoryAsOwner(fresh(), at(1), { delivery: { mode: "local", branch: "release", merge: "auto" } });
    expect([local.project.autonomy.autoDeliver, local.project.prDelivery.enabled]).toEqual([{ enabled: true, branch: "release" }, false]);
    expect(local.events.map((e) => e.message)).toContain("Delivery mode: local branch release (fast-forward only)");
    const yours = startFactoryAsOwner(fresh(), at(1), { delivery: { mode: "pr", branch: "develop", merge: "user" } });
    expect([yours.project.prDelivery.enabled, yours.project.prDelivery.base, yours.project.prDelivery.merge, yours.project.autonomy.autoDeliver.enabled]).toEqual([true, "develop", "hold", false]);
    const auto = startFactoryAsOwner(fresh(), at(1), { delivery: { mode: "pr", branch: "main", merge: "auto" } });
    expect(auto.project.prDelivery.merge).toBe("auto");
    // Turning delivery off from local delivery.
    const off = startFactoryAsOwner(M.applyAutopilot(fresh(), "main", at(0)), at(1), MANUAL);
    expect(D.deliveryMode(off)).toBe("off");
    for (const s of [local, yours, auto, off]) expect(M.currentFactorySettings(s).delivery).toEqual(s.project.factoryStarts[0].settings.delivery);
  });

  it("refuses delivery that contradicts itself, with a clear message, and changes nothing", () => {
    const s = fresh();
    const start = (delivery: unknown) => () => runCommand(s, "startFactory", { ...startFactoryArgs(s), settings: { ...MANUAL, delivery } }, at(1));
    expect(start({ mode: "local", branch: "release", merge: "user" })).toThrow("Local delivery fast-forwards release without waiting for you; choose pull requests to merge yourself, or turn delivery off.");
    expect(start({ mode: "off", merge: "auto" })).toThrow("With delivery off nothing merges automatically: finished work stays on the integration branch for you. Choose local delivery or pull requests to merge automatically.");
    expect(start({ mode: "off", branch: "main", merge: "user" })).toThrow("Delivery is off, so there is no branch to deliver to; leave the branch out, or choose local delivery or pull requests.");
    expect(start({ mode: "pr", merge: "user" })).toThrow("Name the branch to deliver to.");
    expect(start({ mode: "local", branch: "-x", merge: "auto" })).toThrow("Choose a valid branch name for delivery.");
    expect(start({ mode: "pr", branch: "a b", merge: "auto" })).toThrow("Choose a valid base branch name.");
    expect(start({ mode: "branch", merge: "auto" })).toThrow(/mode must be off, local, pr/);
    expect(start(undefined)).toThrow(/settings.delivery must be an object/);
  });

  it("the settings as they stand: what the Start building button sends today", () => {
    const s = M.setAutonomy(fresh(), { ...fresh().project.autonomy, enabled: true, holdLeadProposals: true }, at(0));
    expect(M.currentFactorySettings(s)).toEqual({ autonomy: "checkin", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: true } });
    // It names the Lock in summary the pre-flight shows, by its digest.
    expect(M.startFactoryRequest(s)).toEqual({ agreed: true, draftRev: 0, summaryDigest: B.summaryDigest(B.lockInSummary(s)), visionRev: 1, settings: M.currentFactorySettings(s), acceptOpen: M.openAreas(s) });
    // The change-order choice is the project's setting: the start sets it, and a later start keeps it.
    const started = startFactoryAsOwner(s, at(1), { pausePoints: { tradeoffs: "user", changeOrders: "user", startEachTask: true } });
    expect(started.project.changeOrders).toBe("user");
    expect(started.events.map((e) => e.message)).toContain("Change orders: the lead asks you before it updates tasks");
    expect(M.currentFactorySettings(started).pausePoints.changeOrders).toBe("user");
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

describe("no way back from the factory (pass 5)", () => {
  it("there is no Back to vision command: the factory keeps building, and only Pause stops new work", () => {
    const seed = buildSeed(T0); // building, with two runs in flight
    const running = M.activeAttempts(seed).map((a) => a.id);
    expect(() => runCommand(seed, "startVision", {}, at(1))).toThrow("Unknown command startVision");
    const paused = runCommand(M.startHeldTask(seed, "EX-004", at(0)), "pauseProject", {}, at(1)).state;
    expect(paused.project).toMatchObject({ stage: "building", hold: true });
    expect(M.activeAttempts(M.dispatchEligible(paused, at(2)), "EX-004")).toHaveLength(0);
    expect(M.activeAttempts(seed).map((a) => a.id)).toEqual(running);
  });
});

describe("nothing but the owner's command starts the factory", () => {
  /** A shaping project on Autopilot whose board holds the lead's own proposals and a task of the user's. */
  const shapingOnAutopilot = () => {
    let s = M.applyAutopilot(inVision(buildSeed(T0, { inFlightRuns: false }), at(0)), "main", at(0));
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
