// The words of Settings that depend on numbers. The involvement card says the numbers each mode really
// sets; the count of open lead proposals is said truthfully (a count over the limit is explained, never "8 of 5");
// the checks summary is one line; and the consent texts are in-page confirmations.

import { describe, expect, it } from "vitest";
import { AUTOPILOT } from "../domain/types";
import { AUTOPILOT_NUMBERS, CONFIRM_CHECKS_ON, CONFIRM_NO_SANDBOX, checksSummary, confirmAutoMerge, confirmNewProject, confirmResumeAutoMerge, factorySettingsText, involvementText, proposalsLine } from "./settingsText";
import { resumeAutoMergeText } from "./common";
import { initProjectConfirm } from "./stageChoice";

const nums = (interval: number, perCycle: number, maxOpen: number, retries: number, hours: { start: string; end: string } | null = null) => ({ interval, perCycle, maxOpen, retries, hours });
const pr = { mode: "pr" as const, branch: "main", merge: "hold" as const };

describe("proposalsLine", () => {
  it("under the limit it is a plain count against the limit", () => {
    expect(proposalsLine(3, 0, 5)).toBe("Open lead proposals: 3 of at most 5.");
    expect(proposalsLine(5, 0, 5)).toBe("Open lead proposals: 5 of at most 5.");
  });

  it("over the limit it says why, and what planning does about it", () => {
    expect(proposalsLine(8, 0, 5)).toBe("Open lead proposals: 8, over the limit of 5, so planning proposes nothing new until fewer are open.");
    expect(proposalsLine(8, 0, 5)).not.toMatch(/8 of 5/);
  });

  it("deferred proposals are counted apart, with the cap that stops planning", () => {
    expect(proposalsLine(2, 1, 5)).toBe("Open lead proposals: 2 of at most 5. Deferred lead proposals: 1 proposal of at most 5; they do not count as open.");
    expect(proposalsLine(2, 5, 5)).toBe("Open lead proposals: 2 of at most 5. Deferred lead proposals: 5 proposals, at the limit of 5; they do not count as open, but planning stops until the lead drops some.");
  });
});

describe("involvementText (each mode with the numbers it sets)", () => {
  it("Autopilot's own numbers are the preset the applyAutopilot command sets", () => {
    expect(AUTOPILOT_NUMBERS).toEqual({ interval: AUTOPILOT.planningIntervalMinutes, perCycle: AUTOPILOT.maxProposalsPerCycle, maxOpen: AUTOPILOT.maxOpenProposals, retries: AUTOPILOT.autoRetry });
    expect(involvementText("autopilot", { ...AUTOPILOT_NUMBERS, hours: null }, pr)).toBe(
      "The lead plans every 30 minutes, up to 5 tasks per plan and at most 15 open. Work starts without waiting for you. A failed step is retried once before it waits for you. Pull requests wait for you to merge.",
    );
  });

  it("says the numbers actually set, not the preset: 60, 3 and 5 stay 60, 3 and 5", () => {
    const t = involvementText("checkin", nums(60, 3, 5, 0), pr);
    expect(t).toBe("The lead plans every 60 minutes, up to 3 tasks per plan and at most 5 open. Each task it proposes waits for your go-ahead; after that it runs by itself. A failed step waits for you.");
    expect(t).not.toMatch(/30 minutes|15 open/);
  });

  it("names working hours, singulars and the delivery the mode leads to", () => {
    expect(involvementText("autopilot", nums(1, 1, 1, 2, { start: "09:00", end: "18:00" }), { mode: "local", branch: "release", merge: "hold" })).toBe(
      "The lead plans every 1 minute between 09:00 and 18:00, up to 1 task per plan and at most 1 open. Work starts without waiting for you. A failed step is retried twice before it waits for you. Finished work is delivered to release, fast-forward only.",
    );
    expect(involvementText("autopilot", nums(30, 5, 15, 1), { ...pr, merge: "auto" })).toMatch(/Pull requests merge automatically after an independent review and passing checks\.$/);
    expect(involvementText("autopilot", nums(30, 5, 15, 1), { mode: "off", branch: "main", merge: "hold" })).toMatch(/delivered to the branch below, fast-forward only\.$/);
  });

  it("Manual plans nothing, so it carries no numbers", () => {
    expect(involvementText("manual", nums(60, 3, 5, 0), pr)).toBe("The lead works only when you message it. Tasks you create still run; nothing new is planned.");
  });
});

describe("factorySettingsText (what Start building records with your agreement)", () => {
  const points = { changeOrders: "lead", startEachTask: false } as const;
  it("names the mode, the delivery with who merges, and who decides findings", () => {
    expect(factorySettingsText({ autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { ...points, tradeoffs: "user" } })).toBe(
      "The factory starts on Manual; delivery off: finished work stays on the integration branch for you to merge; findings that need a decision come to you.",
    );
    expect(factorySettingsText({ autonomy: "autopilot", delivery: { mode: "pr", branch: "main", merge: "auto" }, pausePoints: { ...points, tradeoffs: "pe" } })).toBe(
      "The factory starts on Autopilot; pull requests against main, merged automatically after an independent review and passing checks; the PE decides findings that need a decision, within budget (the lead's runs decide for it until the PE runs its own).",
    );
    expect(factorySettingsText({ autonomy: "checkin", delivery: { mode: "pr", branch: "develop", merge: "user" }, pausePoints: { ...points, tradeoffs: "lead", startEachTask: true } })).toBe(
      "The factory starts on Check-in; pull requests against develop, which you merge; the lead decides findings that need a decision.",
    );
    expect(factorySettingsText({ autonomy: "autopilot", delivery: { mode: "local", branch: "release", merge: "auto" }, pausePoints: { ...points, tradeoffs: "user" } })).toMatch(/; finished work goes to release by itself, fast-forward only;/);
  });
});

describe("checksSummary", () => {
  it("is one line: on or off, and how many commands", () => {
    expect(checksSummary(true, [{ kind: "check" }, { kind: "check" }])).toBe("On · 2 commands");
    expect(checksSummary(true, [{ kind: "prepare" }])).toBe("On · 1 command");
    expect(checksSummary(false, [])).toBe("Off · no commands");
  });
});

describe("the in-page confirmations", () => {
  it("turning checks on and running without a sandbox say what they mean, with a verb on the button", () => {
    expect(CONFIRM_CHECKS_ON.title).toBe("Turn checks on?");
    expect(CONFIRM_CHECKS_ON.text).toMatch(/does not stop that code from reading your files/);
    expect(CONFIRM_CHECKS_ON.primaryLabel).toBe("Turn checks on");
    expect(CONFIRM_NO_SANDBOX.danger).toBe(true);
    expect(CONFIRM_NO_SANDBOX.text).toMatch(/read and write anywhere you can/);
  });

  it("automatic merging names the open pull requests it applies to, the conditions and the warnings", () => {
    const c = confirmAutoMerge({ turningOn: true, following: ["#12", "#13"], unprotected: [], reviewer: "other-provider", warnings: ["Watch the first merges."] });
    expect(c.title).toBe("Merge pull requests automatically?");
    expect(c.primaryLabel).toBe("Merge automatically");
    expect(c.text).toMatch(/the 2 pull requests already open \(#12, #13\): they will merge by themselves too/);
    expect(c.text).toMatch(/by another provider than the one that wrote the change/);
    expect(c.text).toMatch(/Before you confirm:\n- Watch the first merges\.$/);
  });

  it("loosening it says what changes: files no longer protected, a higher daily cap", () => {
    const c = confirmAutoMerge({ turningOn: false, following: [], unprotected: ["package.json"], cap: { from: 20, to: 40 }, reviewer: "any-agent", warnings: [] });
    expect(c.title).toBe("Save these changes to automatic merging?");
    expect(c.text).toMatch(/^No longer protected: package\.json\./);
    expect(c.text).toMatch(/The daily limit goes from 20 to 40 automatic merges\./);
    expect(c.text).toMatch(/\(by any agent\)/);
  });

  it("the resume and new-project confirmations keep their text, with the question as the title", () => {
    const r = confirmResumeAutoMerge(resumeAutoMergeText("the base branch failed"));
    expect(r.title).toBe("Resume automatic merging?");
    expect(r.text).toMatch(/^It was paused because the base branch failed\./);
    const n = confirmNewProject("Trips", initProjectConfirm("Trips", 1));
    expect(n.title).toBe('Start a new project "Trips"?');
    expect(n.text).toMatch(/^The current board and history are replaced\. The 1 vision document attached/);
    expect(n.danger).toBe(true);
  });
});
