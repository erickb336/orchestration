// ORC-013 step 1: review coverage. A clean code review must account for every changed file the
// service showed it; otherwise it runs once more with the gap named, then blocks. Only complete
// coverage counts as clean evidence for the merge gate.

import { describe, expect, it } from "vitest";
import { coverageCounts, coverageLabel, coverageOf, gapText, normalizePath } from "./coverage";
import * as D from "./delivery";
import * as M from "./model";
import { buildSeed } from "./seed";
import { reviewedChange } from "./testing/reviewed";
import type { Attempt, Finding, State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const SHA = "a".repeat(40);
const BASE = "b".repeat(40);

describe("normalisation and the comparison", () => {
  it("normalises paths and refuses absolute ones and .. segments", () => {
    expect(normalizePath(" ./src//a.ts ")).toBe("src/a.ts");
    expect(normalizePath("src\\b.ts")).toBe("src\\b.ts"); // a backslash is part of the name, never a separator (review 1, finding 2)
    expect(normalizePath("/etc/passwd")).toBeUndefined();
    expect(normalizePath("../x")).toBeUndefined();
    expect(normalizePath("a/../x")).toBeUndefined();
    expect(normalizePath("C:/x")).toBeUndefined();
    expect(normalizePath("a\0b")).toBeUndefined();
    expect(normalizePath("")).toBeUndefined();
    expect(normalizePath("Src/A.ts")).toBe("Src/A.ts"); // case-sensitive, kept as is
  });

  it("complete, missing, extra, unproven and not-required", () => {
    const scope = { from: BASE, to: SHA, paths: ["a.ts", "b.ts"], total: 2 };
    expect(coverageOf(scope, ["a.ts", "./b.ts"])).toMatchObject({ state: "complete", changed: 2, reviewed: 2, missing: [], extra: [], to: SHA });
    expect(coverageOf(scope, ["a.ts"])).toMatchObject({ state: "incomplete", missing: ["b.ts"], extra: [] });
    expect(coverageOf(scope, ["a.ts", "b.ts", "c.ts"])).toMatchObject({ state: "incomplete", missing: [], extra: ["c.ts"] });
    expect(coverageOf(scope, ["a.ts", "b.ts", "/abs", "../up"])).toMatchObject({ state: "complete" }); // invalid entries are ignored
    expect(coverageOf({ from: BASE, to: SHA, paths: Array.from({ length: 301 }, (_, i) => `f${i}`), total: 301 }, [])).toMatchObject({ state: "unproven" });
    expect(coverageOf({ from: BASE, to: SHA, paths: ["a"], total: 600 }, ["a"])).toMatchObject({ state: "unproven" }); // recorded paths are a prefix of the set
    expect(coverageOf(undefined, ["a.ts"])).toMatchObject({ state: "not-required" });
    expect(coverageCounts(coverageOf(scope, ["a.ts", "b.ts"]))).toBe(true);
    expect(coverageCounts(coverageOf(scope, ["a.ts"]))).toBe(false);
    expect(coverageCounts(coverageOf({ ...scope, total: 400 }, []))).toBe(false);
    expect(coverageCounts(undefined)).toBe(false);
    expect(gapText(coverageOf(scope, ["a.ts"]))).toBe("did not account for 1 changed file (b.ts)");
    expect(coverageLabel(coverageOf(scope, ["a.ts", "b.ts"]))).toBe("Covered 2 of 2 changed files");
    expect(coverageLabel(coverageOf(scope, ["a.ts"]))).toBe("Did not cover 1: b.ts");
  });
});

/** A user task from the Change template with the sample tasks held; S1 done; the review S2 running with a recorded scope. */
function reviewRunning(): { s: State; id: string; review: Attempt } {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  const r = M.createTask(s, { title: "Change", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
  s = r.state;
  const id = r.newId;
  const go = (t: number) => (s = M.dispatchEligible(M.leadPromoteProposals(s, at(t)), at(t)));
  go(1);
  const impl = running(s, id)[0];
  s = M.reportCompletion(s, impl.id, [], at(2), [
    { name: "change", summary: "done", ref: `${SHA.slice(0, 12)} on orchestration/x` },
    { name: "handoff", summary: "notes" },
  ]);
  go(3);
  const review = running(s, id)[0];
  expect(review.stepId).toBe("S2");
  s = M.reportRunContext(s, review.id, { scope: { from: BASE, to: SHA, paths: ["a.ts", "b.ts"], total: 2 } });
  // ORC-021: the security review beside S2 is completed clean; these tests are about the code review's coverage.
  for (const a of running(s, id)) if (step(s, id, a.stepId).role === "security_reviewer") s = M.reportCompletion(s, a.id, [], at(3), [{ name: "findings", summary: "no security findings", findings: [] }]);
  return { s, id, review: running(s, id)[0] };
}

const clean = (reviewedPaths: string[]) => [{ name: "findings", summary: "clean", findings: [] as Finding[], reviewedPaths }];

describe("the rule in reportCompletion", () => {
  it("records the scope on the attempt before the run reports, and a complete clean review is accepted", () => {
    const { s, id, review } = reviewRunning();
    expect(review.scope).toEqual({ from: BASE, to: SHA, paths: ["a.ts", "b.ts"], total: 2 });
    const done = M.reportCompletion(s, review.id, [], at(4), clean(["b.ts", "a.ts"]));
    const art = M.acceptedOutput(done, task(done, id), "S2", "findings")!;
    expect(art.pathCoverage).toMatchObject({ state: "complete", to: SHA, changed: 2, reviewed: 2 });
    expect(step(done, id, "S2").coverageRetries).toBeUndefined();
  });

  it("an incomplete clean review is not accepted: requeued once with the gap, then blocked; no artifact is recorded", () => {
    const { s, id, review } = reviewRunning();
    let next = M.reportCompletion(s, review.id, [], at(4), clean(["a.ts"]));
    expect(next.attempts.find((a) => a.id === review.id)).toMatchObject({ outcome: "failed", note: expect.stringMatching(/did not account for 1 changed file \(b\.ts\).*runs again/) });
    expect(step(next, id, "S2")).toMatchObject({ state: "pending", coverageRetries: 1, coverageGap: { missing: ["b.ts"], extra: [] } });
    expect(next.artifacts.some((a) => a.taskId === id && a.stepId === "S2")).toBe(false);
    next = M.dispatchEligible(next, at(5));
    const again = running(next, id)[0];
    expect(again.stepId).toBe("S2");
    next = M.reportRunContext(next, again.id, { scope: { from: BASE, to: SHA, paths: ["a.ts", "b.ts"], total: 2 } });
    next = M.reportCompletion(next, again.id, [], at(6), clean(["a.ts", "c.ts"]));
    expect(step(next, id, "S2")).toMatchObject({ state: "blocked", blockedReason: expect.stringMatching(/^Last run failed: the clean review did not cover b\.ts, c\.ts \(twice\)/) });
    expect(next.artifacts.some((a) => a.taskId === id && a.stepId === "S2")).toBe(false);
    // The blocked step is a normal failed step: Retry runs it again, and a complete review then clears the gap.
    next = M.dispatchEligible(M.retryStep(next, id, "S2", at(7)), at(8));
    const third = running(next, id)[0];
    next = M.reportRunContext(next, third.id, { scope: { from: BASE, to: SHA, paths: ["a.ts", "b.ts"], total: 2 } });
    next = M.reportCompletion(next, third.id, [], at(9), clean(["a.ts", "b.ts"]));
    expect(step(next, id, "S2")).toMatchObject({ state: "done" });
    expect(step(next, id, "S2").coverageGap).toBeUndefined();
  });

  it("a review with blocking findings is accepted whatever its coverage, with the computed state", () => {
    const { s, id, review } = reviewRunning();
    const f: Finding = { id: "F1", key: "k".repeat(12), source: "review", severity: "error", action: "auto-fix", title: "bug", detail: "" };
    const done = M.reportCompletion(s, review.id, [], at(4), [{ name: "findings", summary: "one", findings: [f], reviewedPaths: ["a.ts"] }]);
    const art = M.acceptedOutput(done, task(done, id), "S2", "findings")!;
    expect(art.pathCoverage).toMatchObject({ state: "incomplete", missing: ["b.ts"] });
    expect(art.openFindings).toBe(1);
  });

  it("a code review of a real change that got no changed-path set is unproven (review 1, finding 7); a simulated change or a UX review is not required to list paths", () => {
    const { s, id, review } = reviewRunning();
    const noScope = { ...s, attempts: s.attempts.map((a) => (a.id === review.id ? { ...a, scope: undefined } : a)) };
    const done = M.reportCompletion(noScope, review.id, [], at(4), clean([]));
    expect(M.acceptedOutput(done, task(done, id), "S2", "findings")!.pathCoverage).toMatchObject({ state: "unproven" });
    // The simulated runtime names its changes "sim-…": there is nothing to prove there.
    const simulated = { ...noScope, artifacts: noScope.artifacts.map((x) => (x.kind === "code-change" ? { ...x, ref: `sim-${x.attemptId} (simulated)` } : x)) };
    const doneSim = M.reportCompletion(simulated, review.id, [], at(4), clean([]));
    expect(M.acceptedOutput(doneSim, task(doneSim, id), "S2", "findings")!.pathCoverage).toMatchObject({ state: "not-required" });
    const ux = { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, steps: t.steps.map((x) => (x.id === "S2" ? { ...x, role: "ux_reviewer" as const } : x)) } : t)) };
    const doneUx = M.reportCompletion(ux, review.id, [], at(4), clean([]));
    expect(M.acceptedOutput(doneUx, task(doneUx, id), "S2", "findings")!.pathCoverage).toMatchObject({ state: "not-required" });
  });

  it("above 300 changed files the review is unproven: accepted, and it counts for runIf, never as clean gate evidence", () => {
    const { s, id, review } = reviewRunning();
    const big = M.reportRunContext(s, review.id, { scope: { from: BASE, to: SHA, paths: Array.from({ length: 301 }, (_, i) => `f${i}.ts`), total: 301 } });
    const done = M.reportCompletion(big, review.id, [], at(4), clean([]));
    expect(M.acceptedOutput(done, task(done, id), "S2", "findings")!.pathCoverage).toMatchObject({ state: "unproven", changed: 301 });
    expect(step(M.dispatchEligible(done, at(5)), id, "S3").state).toBe("skipped");
  });
});

describe("where coverage counts (reviewCoverage, the gate)", () => {
  function prState(coverage: "complete" | "incomplete" | "legacy" | "not-required" | "unproven" | "user", findings = 0): { s: State; id: string } {
    let s = D.setDeliveryMode(buildSeed(T0, { inFlightRuns: false }), { mode: "pr" }, at(0));
    s.attempts = [];
    s = D.reportBaseFetched(D.reportPreflight(s, { ok: true, repo: "o/r", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(1)), BASE, at(2));
    s = reviewedChange(s, "EX-006", SHA, at(2), { findings });
    const art = s.artifacts.find((a) => a.taskId === "EX-006" && a.kind === "review-findings")!;
    if (coverage === "legacy") delete art.pathCoverage;
    else if (coverage === "incomplete") art.pathCoverage = { state: "incomplete", from: BASE, to: SHA, changed: 2, reviewed: 1, missing: ["b.ts"], extra: [] };
    else if (coverage === "not-required") art.pathCoverage = { state: "not-required", changed: 0, reviewed: 0, missing: [], extra: [] };
    else if (coverage === "unproven") art.pathCoverage = { state: "unproven", from: BASE, to: SHA, changed: 400, reviewed: 0, missing: [], extra: [] };
    else if (coverage === "user") {
      art.author = "user";
      delete art.pathCoverage;
    }
    task(s, "EX-006").integration = { status: "pending" };
    s = D.reportPrHead(s, "EX-006", { n: 1, sha: SHA, baseSha: BASE, changed: { files: 2, additions: 1, deletions: 0, paths: ["a.ts", "b.ts"], protectedHits: [], workflowHits: [] } }, at(3));
    return { s, id: "EX-006" };
  }

  it("a complete clean review is evidence; incomplete, unproven and legacy records are not (a dedicated review is started); user edits count, flagged", () => {
    expect(D.reviewCoverage(prState("complete").s, task(prState("complete").s, "EX-006"))).toMatchObject({ ok: true, source: "pipeline" });
    expect(D.reviewCoverage(prState("not-required").s, task(prState("not-required").s, "EX-006"))).toMatchObject({ ok: true, source: "pipeline" });
    for (const c of ["incomplete", "unproven", "legacy"] as const) {
      const { s } = prState(c);
      const ev = D.reviewCoverage(s, task(s, "EX-006"));
      expect(ev.ok, c).toBe(false);
      expect(ev.reason, c).toMatch(/did not list the files it covered|One dedicated review|No review saw/);
      const ensured = D.ensureReview(s, "EX-006", at(4));
      expect(ensured.tasks.some((t) => t.reviewTarget?.taskId === "EX-006"), c).toBe(true);
    }
    const u = prState("user");
    expect(D.reviewCoverage(u.s, task(u.s, "EX-006"))).toMatchObject({ ok: true, clearedByUser: true });
  });

  it("findings are evidence whatever the coverage: the gate stays blocked and a repair can be started", () => {
    const { s } = prState("incomplete", 1);
    const ev = D.reviewCoverage(s, task(s, "EX-006"));
    expect(ev).toMatchObject({ ok: false, source: "pipeline", reason: expect.stringMatching(/1 open finding/) });
    expect(D.repairCause(s, task(s, "EX-006"))).toMatchObject({ kind: "findings" });
  });

  it("mutation check: a complete record for another commit is not evidence for this one", () => {
    const { s } = prState("complete");
    const art = s.artifacts.find((a) => a.taskId === "EX-006" && a.kind === "review-findings")!;
    art.pathCoverage!.to = "c".repeat(40);
    expect(D.reviewCoverage(s, task(s, "EX-006")).ok).toBe(false);
  });
});
