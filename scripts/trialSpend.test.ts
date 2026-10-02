// The studio trial's spend cap (review finding 8): a Claude run with no recorded cost counts at its run limit, never
// as $0; in the fake runtime nothing is spent.

import { describe, expect, it } from "vitest";
import { runCommand } from "../src/domain/commands";
import * as M from "../src/domain/model";
import { buildSeed } from "../src/domain/seed";
import { PRICES, estimateUsd } from "../src/domain/spend";
import * as R from "../src/domain/studio/runs";
import type { State } from "../src/domain/types";
import { claudeExposure, claudeSpend } from "./trialSpend.mjs";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** Three designer runs on Claude: one reported $0.30, one started and ended with no usage, one still queued. */
function studio(): { s: State; ids: string[] } {
  let s = runCommand(M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Trips.", focus: "" }, at(0)), "openRound", { focus: "experience" }, at(1)).state;
  const ids: string[] = [];
  for (const sec of [2, 3]) {
    const r = runCommand(s, "startStudioRun", { kind: "designer", round: 1, brief: "Make the trip plan." }, at(sec));
    s = r.state;
    ids.push((r.result as { runId: string }).runId);
  }
  s = R.dispatchStudioRuns(s, at(4)).state;
  s = R.completeStudioRun(s, ids[0], at(5), { usage: { costUsd: 0.3 }, summary: "done" });
  // It started (the runtime reported its session), then ended without reporting what it used.
  s = R.reportStudioRunStarted(s, ids[1], { sessionId: "claude-session-1" });
  s = R.reportStudioRunFailed(s, ids[1], "it ended", at(6));
  s = runCommand(s, "startStudioRun", { kind: "designer", round: 1, brief: "One more." }, at(7)).state;
  return { s, ids };
}
const estimate = (r: Parameters<typeof estimateUsd>[0]) => estimateUsd(r, PRICES);

describe("the studio trial's Claude spend", () => {
  it("counts a run with no recorded cost at its run limit, and a queued run not at all", () => {
    const { s, ids } = studio();
    const spend = claudeSpend(s, { estimate, limitOf: (r) => (r.id === ids[1] ? 1.5 : 2) });
    expect(spend.usd).toBeCloseTo(1.8);
    expect(spend.unknown).toEqual([{ id: ids[1], countedUsd: 1.5 }]);
  });

  it("the exposure adds each queued Claude run at its limit, so the trial can pause before the service starts one (review finding 9)", () => {
    const { s, ids } = studio();
    const queued = s.studio.runs.at(-1)!.id;
    const limitOf = (r: { id: string }) => (r.id === ids[1] ? 1.5 : 2);
    const x = claudeExposure(s, { estimate, limitOf });
    expect(x.usd).toBeCloseTo(0.3 + 1.5 + 2);
    expect(x.queued).toEqual([queued]);
    // Started, it has no cost yet: it still counts at its limit, once.
    const running = R.dispatchStudioRuns(s, at(8)).state;
    expect(R.getStudioRun(running, queued)!.status).toBe("running");
    expect(claudeExposure(running, { estimate, limitOf })).toMatchObject({ usd: expect.closeTo(3.8), queued: [] });
    // In the fake runtime it is the spend so far.
    expect(claudeExposure(s, { estimate, limitOf, simulated: true }).usd).toBeCloseTo(0.3);
  });

  it("in the fake runtime, a simulated run with no cost counts as $0, and is listed", () => {
    const { s, ids } = studio();
    expect(claudeSpend(s, { estimate, limitOf: () => 2, simulated: true })).toEqual({ usd: 0.3, unknown: [{ id: ids[1], countedUsd: 0 }] });
    const flagged = structuredClone(s);
    R.getStudioRun(flagged, ids[1])!.simulated = true;
    expect(claudeSpend(flagged, { estimate, limitOf: () => 2 }).usd).toBeCloseTo(0.3);
  });
});
