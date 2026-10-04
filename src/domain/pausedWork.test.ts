// Resume starts from the paused work's changes (ORC-030 C4, the owner's choice). The domain's part: a writer's
// changes are kept on its step once the runtime confirmed the stop of a pause, the step's next run starts from them,
// and they never outlive the work they belong to (finished, rerun, cancelled, or no longer fitting the spec or the inputs).

import { describe, expect, it } from "vitest";
import * as M from "./model";
import type { RunReport } from "./model";
import { buildSeed } from "./seed";
import type { State } from "./types";

const T0 = Date.parse("2026-09-29T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const lastEvent = (s: State, id: string) => s.events.filter((e) => e.taskId === id).at(-1)!.message;
const WORK: NonNullable<RunReport["pausedWork"]> = { commit: "c0ffee0000000000000000000000000000000001", base: "ba5e000000000000000000000000000000000001", files: ["src/empty.ts", "src/empty.test.ts"], total: 2 };

/** Report a run as finished with every output its step declares. */
const complete = (s: State, attemptId: string, t: string) => {
  const a = s.attempts.find((x) => x.id === attemptId)!;
  const st = step(s, a.taskId, a.stepId);
  return M.reportCompletion(s, attemptId, [], t, st.outputs.map((o) => ({ name: o.name, summary: "test" })));
};

/** EX-001's implementation (S2, a coder) paused, the stop confirmed with `work`. */
function pausedWith(work: RunReport["pausedWork"]) {
  let s = M.pauseTask(buildSeed(T0), "EX-001", at(0));
  const [a] = running(s, "EX-001");
  expect(a.stepId).toBe("S2");
  s = M.acknowledgeStop(s, a.id, at(3), { pausedWork: work });
  return { s, paused: a.id };
}

describe("a paused writer's changes", () => {
  it("are kept on the step once the stop is confirmed, and the next run starts from them; finishing the step clears them", () => {
    let s = M.pauseTask(buildSeed(T0), "EX-001", at(0));
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined(); // never before the confirmation
    const [a] = running(s, "EX-001");
    s = M.acknowledgeStop(s, a.id, at(3), { pausedWork: WORK });
    expect(step(s, "EX-001", "S2").pausedWork).toEqual({ attemptId: a.id, ...WORK, at: at(3) });
    expect(lastEvent(s, "EX-001")).toContain(`${a.id}'s changes to 2 files are kept`);
    s = M.resumeTask(s, "EX-001", at(4));
    s = M.dispatchEligible(s, at(5));
    const [next] = running(s, "EX-001");
    expect(next.id).not.toBe(a.id);
    expect(next.snapshot.startedFrom).toEqual({ attemptId: a.id, ...WORK, at: at(3) });
    expect(s.events.find((e) => e.message.startsWith(`Dispatched S2`) && e.message.includes(next.id))!.message).toContain(`from the changes of the paused run ${a.id}`);
    s = complete(s, next.id, at(6));
    expect(step(s, "EX-001", "S2").state).toBe("done");
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined();
  });

  it("a project pause keeps them too; a run that failed keeps them for the retry", () => {
    let s = M.pauseProject(buildSeed(T0), at(0));
    const a = running(s, "EX-001")[0];
    s = M.acknowledgeStop(s, a.id, at(3), { pausedWork: WORK });
    expect(step(s, "EX-001", "S2").pausedWork?.attemptId).toBe(a.id);
    s = M.resumeProject(s, at(4));
    s = M.dispatchEligible(s, at(5));
    const first = running(s, "EX-001")[0];
    expect(first.snapshot.startedFrom?.commit).toBe(WORK.commit);
    s = M.reportRunFailed(s, first.id, "the provider returned an error", at(6));
    expect(step(s, "EX-001", "S2").pausedWork?.attemptId).toBe(a.id);
    s = M.retryStep(s, "EX-001", "S2", at(7));
    s = M.dispatchEligible(s, at(8));
    expect(running(s, "EX-001")[0].snapshot.startedFrom?.attemptId).toBe(a.id);
  });

  it("a run that changed nothing, a stop that is not a pause and a read-only step keep nothing", () => {
    expect(step(pausedWith(null).s, "EX-001", "S2").pausedWork).toBeUndefined();
    expect(step(pausedWith(undefined).s, "EX-001", "S2").pausedWork).toBeUndefined();
    // Cancel: the task is over.
    let s = M.cancelTask(buildSeed(T0), "EX-001", at(0));
    s = M.acknowledgeStop(s, s.attempts.find((x) => x.taskId === "EX-001" && x.outcome === "stopping")!.id, at(1), { pausedWork: WORK });
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined();
    // A spec edit stops the run for a revision: its work was for the old spec.
    s = buildSeed(T0);
    const t = task(s, "EX-001");
    const spec = M.currentSpec(t);
    s = M.editSpec(s, "EX-001", spec.rev, { ...spec.content, outcome: "Something else" }, "changed my mind", "user", at(0));
    const r = s.attempts.find((x) => x.taskId === "EX-001" && x.outcome === "stopping")!;
    expect(r.stopReason).toBe("revision");
    s = M.acknowledgeStop(s, r.id, at(1), { pausedWork: WORK });
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined();
    // EX-002's running step is a code review: read-only, whatever the report says.
    s = M.pauseTask(buildSeed(T0), "EX-002", at(0));
    const review = running(s, "EX-002")[0];
    s = M.acknowledgeStop(s, review.id, at(1), { pausedWork: WORK });
    expect(step(s, "EX-002", review.stepId).pausedWork).toBeUndefined();
  });

  it("a run that changed nothing after starting from paused work lets go of it", () => {
    let { s, paused } = pausedWith(WORK);
    s = M.dispatchEligible(M.resumeTask(s, "EX-001", at(4)), at(5));
    const next = running(s, "EX-001")[0];
    expect(next.snapshot.startedFrom?.attemptId).toBe(paused);
    s = M.pauseTask(s, "EX-001", at(6));
    s = M.acknowledgeStop(s, next.id, at(7), { pausedWork: null });
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined();
  });

  it("a result that finishes after the pause request is kept as paused work too, never integrated", () => {
    let s = M.pauseTask(buildSeed(T0), "EX-001", at(0));
    const [a] = running(s, "EX-001");
    const st = step(s, "EX-001", "S2");
    s = M.reportCompletion(s, a.id, [], at(1), st.outputs.map((o) => ({ name: o.name, summary: "late" })), { pausedWork: WORK });
    expect(s.attempts.find((x) => x.id === a.id)!.outcome).toBe("stopped");
    expect(s.artifacts.some((x) => x.attemptId === a.id)).toBe(false);
    expect(step(s, "EX-001", "S2").pausedWork?.attemptId).toBe(a.id);
  });

  it("the paused run's late result never lands", () => {
    let { s, paused } = pausedWith(WORK);
    const before = step(s, "EX-001", "S2");
    s = complete(s, paused, at(5));
    expect(s.attempts.find((x) => x.id === paused)!.outcome).toBe("stopped");
    expect(step(s, "EX-001", "S2")).toEqual(before);
    expect(s.artifacts.some((x) => x.attemptId === paused)).toBe(false);
  });
});

describe("paused work that no longer fits", () => {
  it("a spec edit while paused: the next run starts from the base, and the record says why", () => {
    let { s, paused } = pausedWith(WORK);
    const spec = M.currentSpec(task(s, "EX-001"));
    s = M.editSpec(s, "EX-001", spec.rev, { ...spec.content, outcome: "Something else" }, "changed my mind", "user", at(4));
    s = M.dispatchEligible(M.resumeTask(s, "EX-001", at(5)), at(6));
    const next = running(s, "EX-001").find((x) => x.stepId === "S2");
    // The edit invalidated the design (S1) too: it runs again first, and S2 waits for it.
    expect(next).toBeUndefined();
    expect(step(s, "EX-001", "S2").pausedWork?.attemptId).toBe(paused);
    const design = running(s, "EX-001").find((x) => x.stepId === "S1")!;
    s = complete(s, design.id, at(7));
    s = M.dispatchEligible(s, at(8));
    const impl = running(s, "EX-001").find((x) => x.stepId === "S2")!;
    expect(impl.snapshot.startedFrom).toBeUndefined();
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined();
    expect(s.events.some((e) => e.message.includes(`starts from the base`) && e.message.includes(`${paused}'s changes no longer fit`) && e.message.includes("the spec changed"))).toBe(true);
  });

  it("an edit of the step's input while paused: the next run starts from the base", () => {
    let { s, paused } = pausedWith(WORK);
    const design = s.artifacts.filter((x) => x.taskId === "EX-001" && x.stepId === "S1").at(-1)!;
    s = M.editArtifact(s, design.id, { summary: "One empty state only", reason: "simpler" }, at(4));
    s = M.dispatchEligible(M.resumeTask(s, "EX-001", at(5)), at(6));
    const impl = running(s, "EX-001").find((x) => x.stepId === "S2")!;
    expect(impl.snapshot.startedFrom).toBeUndefined();
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined();
    expect(lastEventMatching(s, paused)).toContain("its inputs changed");
  });

  it("a rerun of the step it depends on clears it at once; so does Cancel", () => {
    let { s } = pausedWith(WORK);
    s = M.rerunStep(s, "EX-001", "S1", at(4));
    expect(step(s, "EX-001", "S2").pausedWork).toBeUndefined();
    ({ s } = pausedWith(WORK));
    s = M.cancelTask(s, "EX-001", at(4));
    expect(task(s, "EX-001").steps.every((x) => x.pausedWork === undefined)).toBe(true);
  });
});

function lastEventMatching(s: State, attemptId: string): string {
  return s.events.filter((e) => e.message.includes(`${attemptId}'s changes`)).at(-1)?.message ?? "";
}
