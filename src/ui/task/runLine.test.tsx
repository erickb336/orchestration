// The run line under Details › Runs (ORC-030 C4): a run that started from a paused run's changes says so on its line,
// and inside it names the paused run and the files; a run that started from the base says nothing about it.

import { describe, expect, it } from "vitest";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import type { State } from "../../domain/types";
import { renderScreen, visible } from "../testStore";
import { RunsSection } from "./Runs";

const T0 = Date.parse("2026-10-03T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

/** EX-001's implementation paused with `files` changed, then resumed and dispatched again. */
function resumed(work: { files: string[]; total: number; simulated?: true }): { state: State; paused: string } {
  let s = M.pauseTask(buildSeed(T0), "EX-001", at(0));
  const paused = M.activeAttempts(s, "EX-001")[0].id;
  s = M.acknowledgeStop(s, paused, at(3), { pausedWork: { commit: work.simulated ? `sim-${paused}` : "c0ffee0000000000000000000000000000000001", base: "ba5e000000000000000000000000000000000001", ...work } });
  s = M.dispatchEligible(M.resumeTask(s, "EX-001", at(4)), at(5));
  return { state: s, paused };
}

describe("the run line", () => {
  it("says a run started from the paused run's changes, and names the run and the files inside", () => {
    const { state, paused } = resumed({ files: ["src/empty.ts", "src/empty.test.ts"], total: 2 });
    const t = visible(renderScreen(<RunsSection state={state} task={task(state, "EX-001")} />, state));
    expect(t).toContain("started from the paused run's changes");
    expect(t).toContain(`Started from the changes of the paused run ${paused}: 2 files (src/empty.ts, src/empty.test.ts)`);
    // Once: the paused run's own line does not say it.
    expect(t.split("started from the paused run's changes").length - 1).toBe(1);
  });

  it("labels simulated paused work as simulated", () => {
    const { state, paused } = resumed({ files: [], total: 0, simulated: true });
    const t = visible(renderScreen(<RunsSection state={state} task={task(state, "EX-001")} />, state));
    expect(t).toContain("started from the paused run's changes (simulated)");
    expect(t).toContain(`Started from the changes of the paused run ${paused} (simulated: no file changed)`);
  });

  it("a run that started from the base says nothing about it", () => {
    const s = buildSeed(T0);
    const t = visible(renderScreen(<RunsSection state={s} task={task(s, "EX-001")} />, s));
    expect(t).not.toContain("paused run");
  });
});
