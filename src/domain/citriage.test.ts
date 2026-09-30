// ORC-013 step 3, pure: CI triage for pull requests (design §7). The classification of a failing
// required check, the bounded re-run of a GitHub-cancelled job as a recorded intent (budget spent at
// intent, observed after an interruption, never sent twice), the wait for the new run, the attention a
// person gets instead of a fix task (a review bot's verdict, a skipped check, an exhausted re-run), the
// user's Fix this PR, and the "no CI" declaration. Nothing here contacts GitHub or starts a process.

import { describe, expect, it } from "vitest";
import * as D from "./delivery";
import * as M from "./model";
import { buildSeed } from "./seed";
import { reviewedChange } from "./testing/reviewed";
import type { CheckObs, PrDelivery, State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ms = (s: number) => T0 + s * 1000;
const seed = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const SHA_A = "a".repeat(40);
const HEAD = "c".repeat(40);
const HEAD2 = "f".repeat(40);
const MERGE = "d".repeat(40);
const ID = "EX-006";
const URL = "https://github.com/o/r/actions/runs/1";
/** A check run as parseChecks reports it: a GitHub Actions job with an id (re-runnable when cancelled). */
const job = (conclusion: string | null, o: { name?: string; required?: boolean; app?: string; jobId?: number; startedAt?: string; kind?: "run" | "status" } = {}): CheckObs => ({
  name: o.name ?? "check",
  required: o.required ?? true,
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  conclusion,
  url: URL,
  kind: o.kind ?? "run",
  app: o.app ?? "github-actions",
  ...(o.kind === "status" ? {} : { jobId: o.jobId ?? 101, startedAt: o.startedAt ?? "2026-09-30T11:50:00Z" }),
});
/** A check with no job id: as the ORC-008 tests describe it, not re-runnable. */
const bare = (conclusion: string | null, name = "check"): CheckObs => ({ name, required: true, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion });
const observation = (over: Partial<D.PrObservation> = {}): D.PrObservation => ({
  number: 12,
  state: "OPEN",
  isDraft: false,
  crossRepo: false,
  url: "https://github.com/o/r/pull/12",
  headRef: "orchestration/sample/pr/EX-006-1",
  headSha: HEAD,
  baseRef: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  labels: [],
  checks: [job("SUCCESS")],
  checksFor: HEAD,
  ...over,
});
const prOf = (s: State, id = ID): PrDelivery => task(s, id).integration!.pr!;
const CHANGED = { files: 1, additions: 1, deletions: 0, paths: ["a.txt"], protectedHits: [] as string[], workflowHits: [] as string[] };
const preflight = (s: State, second: number, requiredChecks = ["check"]) =>
  D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks, autoMergeBlockers: requiredChecks.length ? [] : ["no required check"], posture: [] }, at(second));

/** Pull-request delivery on (auto by default), the repository checked, the base fetched, every other open task held. */
function prMode(o: { merge?: "hold" | "auto"; requiredChecks?: string[]; cfg?: Partial<Parameters<typeof D.setPrDelivery>[1]> } = {}): State {
  let s = D.setDeliveryMode(seed(), { mode: "pr" }, at(0));
  s.attempts = [];
  for (const t of s.tasks) if (t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
  s = preflight(s, 1, o.requiredChecks ?? ["check"]);
  s = D.reportBaseFetched(s, SHA_A, at(2));
  return D.setPrDelivery(s, { merge: o.merge ?? "auto", ...(o.cfg ?? {}) }, at(2));
}
/** A done task, reviewed clean on the other provider, with its head prepared as a pull request. */
function built(s: State, id = ID, sha = HEAD): State {
  const next = reviewedChange(s, id, sha, at(2), {});
  task(next, id).lifecycle = "done";
  task(next, id).hold = false;
  task(next, id).integration = { status: "pending" };
  return D.reportPrHead(next, id, { n: 1, sha, baseSha: SHA_A, changed: { ...CHANGED } }, at(3));
}
/** …published as #12 and observed once at second 20 with these checks. */
function opened(s: State, obs: Partial<D.PrObservation> = {}): State {
  const op = D.nextPrOp(s, ms(10))!;
  expect(op).toMatchObject({ kind: "publish", taskId: ID });
  const begun = D.beginPrOp(s, op, at(10));
  expect(begun.started).toBe(true);
  const open = D.reportPrOp(begun.state, { op, published: { number: 12, url: "https://github.com/o/r/pull/12" } }, at(11));
  return D.reportObservations(open, { prs: [observation(obs)], commits: [] }, at(20));
}
const cancelled = (o: Parameters<typeof prMode>[0] = {}, obs: Partial<D.PrObservation> = {}) => opened(built(prMode(o)), { checks: [job("CANCELLED")], ...obs });
const gate = (s: State, second = 21, byUser = false) => D.prGate(s, task(s, ID), ms(second), { byUser });
const item = (s: State, id: D.GateItem["id"], second = 21, byUser = false) => gate(s, second, byUser).items.find((i) => i.id === id)!;
const see = (s: State, second: number, over: Partial<D.PrObservation> = {}, ctx?: Parameters<typeof D.reportObservations>[3]) => D.reportObservations(s, { prs: [observation(over)], commits: [] }, at(second), ctx);
/** The repository was checked and the base fetched moments before `second`, so neither is what is planned then. */
const fresh = (s: State, second: number) => D.reportBaseFetched(preflight(s, second - 2, s.project.github!.requiredChecks), SHA_A, at(second - 1));
const plan = (s: State, second: number) => D.nextPrOp(fresh(s, second), ms(second));
const repairTasks = (s: State, id = ID) => s.tasks.filter((t) => t.deliverInto?.taskId === id);
/** Plan, record the intent and return the state with the re-run in flight. */
function rerunBegun(s0: State, second = 30): { state: State; op: Extract<D.PrOp, { kind: "rerun" }> } {
  const s = fresh(s0, second);
  const op = D.nextPrOp(s, ms(second));
  expect(op).toMatchObject({ kind: "rerun", taskId: ID, n: 1, headSha: HEAD, jobs: [{ check: "check", jobId: 101 }] });
  const begun = D.beginPrOp(s, op!, at(second));
  expect(begun.started).toBe(true);
  return { state: begun.state, op: op as Extract<D.PrOp, { kind: "rerun" }> };
}

describe("triageCheck (§7.2)", () => {
  it("classifies by app, then by conclusion: bot, provider (cancelled), not-run (skipped, neutral, stale), else code", () => {
    const cfg = prMode().project.prDelivery;
    expect(D.triageCheck(cfg, job("FAILURE", { app: "coderabbitai" }))).toBe("bot");
    expect(D.triageCheck(cfg, job("CANCELLED", { app: "greptile-apps" }))).toBe("bot"); // whatever the conclusion
    expect(D.triageCheck(cfg, job("FAILURE", { app: "ci-bot", kind: "status" }))).toBe("code"); // a status context by an unknown login
    expect(D.triageCheck(cfg, job("CANCELLED"))).toBe("provider");
    expect(D.triageCheck(cfg, job("CANCELLED", { app: "circleci" }))).toBe("provider");
    for (const c of ["SKIPPED", "NEUTRAL", "STALE"]) expect(D.triageCheck(cfg, job(c)), c).toBe("not-run");
    for (const c of ["FAILURE", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE", "SOMETHING_NEW"]) expect(D.triageCheck(cfg, job(c)), c).toBe("code");
    // The bot list is the user's setting.
    const custom = D.setPrDelivery(prMode(), { reviewBotApps: ["my-linter"] }, at(3)).project.prDelivery;
    expect(D.triageCheck(custom, job("FAILURE", { app: "my-linter" }))).toBe("bot");
    expect(D.triageCheck(custom, job("FAILURE", { app: "coderabbitai" }))).toBe("code");
  });

  it("review M4: a cancelled or skipped job is the code's when another job of the same workflow run failed, when it was cancelled again after its re-run, or when it ran to GitHub's job limit (mutation check)", () => {
    const cfg = prMode().project.prDelivery;
    const inRun = (conclusion: string | null, name: string, runId: number, o: Parameters<typeof job>[1] = {}): CheckObs => ({ ...job(conclusion, { name, ...o }), runId });
    // A fail-fast matrix: one leg failed, GitHub cancelled the other leg of the same run.
    const legs = [inRun("FAILURE", "test (18)", 7, { jobId: 1 }), inRun("CANCELLED", "test (20)", 7, { jobId: 2 })];
    expect(D.triageCheck(cfg, legs[1], { all: legs })).toBe("code");
    expect(D.codeWhy(legs[1], { all: legs })).toBe("another job of the same workflow run failed");
    // An aggregator skipped because a job it needs failed.
    const agg = [inRun("FAILURE", "unit", 8, { jobId: 3 }), inRun("SKIPPED", "all-green", 8, { jobId: 4 })];
    expect(D.triageCheck(cfg, agg[1], { all: agg })).toBe("code");
    // Another workflow run's failure says nothing about this run; a cancelled sibling says nothing either; a status context is never a sibling.
    expect(D.triageCheck(cfg, inRun("CANCELLED", "b", 9), { all: [inRun("FAILURE", "a", 10), inRun("CANCELLED", "b", 9)] })).toBe("provider");
    expect(D.triageCheck(cfg, inRun("CANCELLED", "b", 9), { all: [inRun("CANCELLED", "a", 9), inRun("CANCELLED", "b", 9)] })).toBe("provider");
    expect(D.triageCheck(cfg, inRun("SKIPPED", "b", 9), { all: [inRun("SKIPPED", "b", 9), { ...job("FAILURE", { name: "ctx", kind: "status" }), runId: 9 }] })).toBe("not-run");
    expect(D.triageCheck(cfg, job("CANCELLED"), { all: [job("CANCELLED"), job("FAILURE", { name: "other" })] })).toBe("provider"); // no run id: nothing is known
    // Cancelled again after its re-run.
    expect(D.triageCheck(cfg, job("CANCELLED"), { reran: true })).toBe("code");
    expect(D.codeWhy(job("CANCELLED"), { reran: true })).toBe("cancelled again after its re-run");
    expect(D.triageCheck(cfg, job("SKIPPED"), { reran: true })).toBe("not-run"); // only a cancellation is "again"
    // Ran to GitHub's default job limit (the workflow's own timeout-minutes is not in the API: documented in JOB_TIMEOUT_MS).
    const long = { ...job("CANCELLED", { startedAt: "2026-09-30T00:00:00Z" }), completedAt: "2026-09-30T05:58:00Z" };
    expect(D.triageCheck(cfg, long)).toBe("code");
    expect(D.codeWhy(long)).toBe("ran to GitHub's 360-minute job limit");
    expect(D.triageCheck(cfg, { ...long, completedAt: "2026-09-30T04:00:00Z" })).toBe("provider");
    expect(D.triageCheck(cfg, { ...job("CANCELLED"), completedAt: "2026-09-30T05:58:00Z", startedAt: undefined })).toBe("provider"); // no timing: nothing is known
    // A bot's verdict stays a bot's, whatever the siblings say; a plain failure needs no reason.
    expect(D.triageCheck(cfg, job("CANCELLED", { app: "coderabbitai" }), { reran: true })).toBe("bot");
    expect(D.codeWhy(job("FAILURE"))).toBeUndefined();
    // Through the gate: a fail-fast leg on the head starts the fix task for the leg that failed and the leg GitHub cancelled; no re-run.
    const s = opened(built(prMode({ requiredChecks: ["test (18)", "test (20)"] })), { checks: legs });
    expect(item(s, "checks")).toMatchObject({ state: "blocked", code: "checks-failed" });
    expect(item(s, "checks").detail).toContain("test (20): cancelled (the code: another job of the same workflow run failed, github-actions");
    expect(D.repairCause(s, task(s, ID))).toEqual({ kind: "checks", checks: [{ name: "test (18)", url: URL }, { name: "test (20)", url: URL }] });
    expect(plan(s, 30)?.kind).not.toBe("rerun");
    expect(repairTasks(D.advanceDelivery(s, at(22)))).toHaveLength(1);
  });

  it("review L7: the gate never says a re-run is impossible when one is planned or waiting; each reason is the true one", () => {
    // Another required check still running: the re-run waits for it (a wait, not a block).
    const running = cancelled({}, { checks: [job("CANCELLED"), job(null, { name: "lint", jobId: 102 })] });
    expect(item(running, "checks")).toMatchObject({ state: "waiting" });
    expect(item(running, "checks").detail).toMatch(/^GitHub cancelled check on cccccccccccc\. It is re-run once lint has finished \(0 of 1 per check used on this head\)\./);
    expect(item(running, "checks").detail).not.toMatch(/cannot be re-run/);
    // The per-pull-request cap.
    const capped = structuredClone(cancelled());
    prOf(capped).counters.reruns = 5;
    expect(item(capped, "checks")).toMatchObject({ state: "blocked", code: "ci-infra" });
    expect(item(capped, "checks").detail).toMatch(/^GitHub cancelled check on cccccccccccc, and the 5 re-runs of this pull request are used\. Re-run it on GitHub, or merge it yourself\./);
    // No app, no job id, another app, re-runs off.
    expect(item(cancelled({}, { checks: [bare("CANCELLED")] }), "checks").detail).toMatch(/; this check has no re-run\./);
    expect(item(cancelled({}, { checks: [{ ...job("CANCELLED"), jobId: undefined }] }), "checks").detail).toMatch(/; GitHub reported no job id to re-run\./);
    expect(item(cancelled({}, { checks: [job("CANCELLED", { app: "circleci" })] }), "checks").detail).toMatch(/; circleci has no re-run\./);
    expect(item(cancelled({ cfg: { rerunBudget: 0 } }), "checks").detail).toMatch(/; re-runs are off \(Settings → Delivery\)\./);
    // Paused: the re-run is still the plan (the pause is the gate's own "Not paused" item), so it says so.
    const paused = M.pauseProject(cancelled(), at(20));
    expect(item(paused, "checks")).toMatchObject({ state: "waiting" });
    expect(item(paused, "checks").detail).toMatch(/It is re-run \(0 of 1 per check used on this head\)/);
    expect(item(paused, "not-paused").ok).toBe(false);
    // Two cancelled jobs, one of them without a job id: the one that cannot be re-run is named.
    const mixed = cancelled({}, { checks: [job("CANCELLED"), { ...job("CANCELLED", { name: "lint" }), jobId: undefined }] });
    expect(item(mixed, "checks").detail).toMatch(/^GitHub cancelled lint on cccccccccccc; GitHub reported no job id to re-run\./);
    for (const s of [running, capped, paused, mixed]) expect(item(s, "checks").detail).not.toMatch(/cannot be re-run/);
  });
});

describe("re-running a cancelled job (§7.3)", () => {
  it("is planned only when every failed required check is a re-runnable provider failure with budget left; the gate waits meanwhile", () => {
    const s = cancelled();
    expect(item(s, "checks")).toMatchObject({ state: "waiting" });
    expect(item(s, "checks").detail).toMatch(/GitHub cancelled check on cccccccccccc\. It is re-run \(0 of 1 per check used on this head\)/);
    expect(prOf(s).attention).toBeUndefined();
    expect(plan(s, 30)).toMatchObject({ kind: "rerun", jobs: [{ check: "check", jobId: 101 }] });
    expect(D.opMutates(plan(s, 30)!)).toBe(true);
    // Not re-runnable: a status context, another app, no job id, or re-runs switched off.
    expect(item(cancelled({}, { checks: [job("CANCELLED", { kind: "status" })] }), "checks")).toMatchObject({ state: "blocked", code: "ci-infra" });
    expect(item(cancelled({}, { checks: [job("CANCELLED", { app: "circleci" })] }), "checks")).toMatchObject({ state: "blocked", code: "ci-infra" });
    expect(item(cancelled({}, { checks: [bare("CANCELLED")] }), "checks")).toMatchObject({ state: "blocked", code: "ci-infra" });
    const off = cancelled({ cfg: { rerunBudget: 0 } });
    expect(item(off, "checks")).toMatchObject({ state: "blocked", code: "ci-infra" });
    expect(item(off, "checks").detail).toContain("re-runs are off");
    expect(plan(off, 30)?.kind).not.toBe("rerun");
    // Not settled: a pending required check.
    expect(plan(cancelled({}, { checks: [job("CANCELLED"), job(null, { name: "lint" })] }), 30)?.kind).not.toBe("rerun");
    // Two cancelled jobs go in one operation.
    expect(plan(cancelled({}, { checks: [job("CANCELLED"), job("CANCELLED", { name: "lint", jobId: 102 })] }), 30)).toMatchObject({ kind: "rerun", jobs: [{ check: "check", jobId: 101 }, { check: "lint", jobId: 102 }] });
  });

  it("a code failure suppresses re-runs for the head (mutation check), and the fix task lists only the code failure", () => {
    const s = cancelled({}, { checks: [job("CANCELLED"), job("FAILURE", { name: "lint", jobId: 102 })] });
    expect(item(s, "checks")).toMatchObject({ state: "blocked", code: "checks-failed" });
    expect(item(s, "checks").detail).toContain("check: cancelled (cancelled by GitHub, github-actions, https://github.com/o/r/actions/runs/1)");
    expect(item(s, "checks").detail).toContain("lint: failure (the code, github-actions");
    expect(plan(s, 30)?.kind).not.toBe("rerun");
    expect(D.repairCause(s, task(s, ID))).toEqual({ kind: "checks", checks: [{ name: "lint", url: URL }] });
    // Automatic repair starts for the code failure, once; a cancelled check alone starts none.
    expect(repairTasks(D.advanceDelivery(s, at(22)))).toHaveLength(1);
    expect(repairTasks(D.advanceDelivery(cancelled(), at(22)))).toHaveLength(0);
  });

  it("a pause, a hold, a foreign head and a pending head each block the plan; the intent re-checks them", () => {
    const s = cancelled();
    expect(D.nextPrOp(fresh(M.pauseProject(s, at(29)), 30), ms(30))).toBeUndefined();
    expect(plan(D.holdPr(s, ID, "later", at(29)), 30)?.kind).not.toBe("rerun");
    const op = plan(s, 30)!;
    expect(D.beginPrOp(M.pauseProject(fresh(s, 30), at(30)), op, at(30)).started).toBe(false);
    expect(D.beginPrOp(D.holdPr(fresh(s, 30), ID, undefined, at(30)), op, at(30)).started).toBe(false);
    // The head changed after planning: the jobs no longer match, nothing starts.
    const moved = structuredClone(fresh(s, 30));
    prOf(moved).headSha = HEAD2;
    expect(D.beginPrOp(moved, op, at(30)).started).toBe(false);
  });

  it("the budget is spent when the intent is recorded, before anything is sent (Q11, mutation check); it is per check per head and at most 5 per pull request", () => {
    const { state: s, op } = rerunBegun(cancelled());
    const pr = prOf(s);
    expect(pr.op).toMatchObject({ id: op.id, kind: "rerun", headSha: HEAD });
    expect(pr.ciReruns).toEqual({ headSha: HEAD, used: [{ check: "check", jobId: 101, at: at(30), opId: op.id }] });
    expect(pr.counters.reruns).toBe(1);
    expect(s.events.at(-1)!.message).toMatch(/Re-running check on PR #12 \(cccccccccccc\): GitHub cancelled it\. 1 of 5 re-runs used for this pull request; no fix task is started/);
    expect(s.project.github!.mutations!.count).toBe(2); // the publish and this one: a write like any other
    expect(D.prIntentLine(pr)).toMatch(/Asking GitHub to run check again on PR #12/);
    expect(D.prLabel(s, task(s, ID), ms(31))).toEqual({ text: "PR #12 re-running check", tone: "plain" });
    // Nothing else starts while the intent is recorded; a second intent for the same op is refused.
    expect(D.nextPrOp(fresh(s, 40), ms(40))?.kind).not.toBe("rerun");
    expect(D.beginPrOp(fresh(s, 40), { ...op, id: "again" }, at(40)).started).toBe(false);
    // The result: the observation right after the request still shows the cancelled run; the op is over, the check waits.
    // That read never counts toward the wait (review L8): GitHub has had no time to publish the new run.
    const after = D.reportPrOp(s, { op, observed: { prs: [observation({ checks: [job("CANCELLED")] })], commits: [], at: at(31) } }, at(31));
    expect(prOf(after).op).toBeUndefined();
    expect(prOf(after).ciReruns!.used[0].seen).toBeUndefined();
    expect(item(after, "checks", 32)).toMatchObject({ state: "waiting" });
    expect(item(after, "checks", 32).detail).toMatch(/Re-running check on cccccccccccc \(GitHub had cancelled it\); waiting for the new run/);
    expect(D.prLabel(after, task(after, ID), ms(32))!.text).toBe("PR #12 re-running check");
    // The budget for this head is spent: no second re-run of the same cancelled run, ever.
    expect(plan(after, 40)?.kind).not.toBe("rerun");
    // Five per pull request over its life.
    const capped = structuredClone(cancelled());
    prOf(capped).counters.reruns = 5;
    expect(item(capped, "checks")).toMatchObject({ state: "blocked", code: "ci-infra" });
    expect(plan(capped, 30)?.kind).not.toBe("rerun");
    // With a budget of 2 the same name may be re-run once more after the wait is over (two reads after the driver's own).
    const two = rerunBegun(cancelled({ cfg: { rerunBudget: 2 } })).state;
    const own2 = see(two, 31, { checks: [job("CANCELLED")] }, { opId: two.tasks.find((t) => t.id === ID)!.integration!.pr!.op!.id });
    const seen2 = see(see(own2, 32, { checks: [job("CANCELLED")] }), 33, { checks: [job("CANCELLED")] });
    expect(plan(seen2, 40)).toMatchObject({ kind: "rerun", jobs: [{ check: "check", jobId: 101 }] });
  });

  it("the wait for the new run lasts at most 2 observations after the driver's own read, or 5 minutes; then the check is judged as observed and needs a person", () => {
    const { state: s, op } = rerunBegun(cancelled());
    const one = see(s, 31, { checks: [job("CANCELLED")] }, { opId: op.id });
    expect(prOf(one).ciReruns!.used[0].seen).toBeUndefined(); // the driver's own read (review L8, mutation check)
    expect(item(one, "checks", 32)).toMatchObject({ state: "waiting" });
    // One later observation still showing the same run: still waiting. Two: judged.
    const mid = see(one, 32, { checks: [job("CANCELLED")] });
    expect(prOf(mid).ciReruns!.used[0].seen).toBe(1);
    expect(item(mid, "checks", 33)).toMatchObject({ state: "waiting" });
    const two = see(mid, 33, { checks: [job("CANCELLED")] });
    expect(prOf(two).ciReruns!.used[0].seen).toBe(2);
    expect(item(two, "checks", 34)).toMatchObject({ state: "blocked", code: "ci-infra" });
    expect(item(two, "checks", 34).detail).toMatch(/GitHub cancelled check on cccccccccccc, and its re-run is used \(1 of 1\)\. Re-run it on GitHub, or merge it yourself\./);
    expect(prOf(two).attention).toMatchObject({ code: "ci-infra" });
    expect(repairTasks(D.advanceDelivery(two, at(35)))).toHaveLength(0);
    // Or five minutes, whichever comes first.
    expect(item(one, "checks", 31 + 5 * 60 + 1)).toMatchObject({ state: "blocked", code: "ci-infra" });
    // A new run that appears (another job id) is judged at once: green makes the name green, and the gate says it was re-run.
    const green = see(one, 32, { checks: [job("SUCCESS", { jobId: 102, startedAt: "2026-09-30T12:00:31Z" })] });
    expect(item(green, "checks", 33)).toMatchObject({ state: "ok" });
    expect(item(green, "checks", 33).detail).toMatch(/check passed on cccccccccccc\. check was re-run after GitHub cancelled it\./);
    expect(prOf(green).attention).toBeUndefined();
    // A new run cancelled again after its re-run is the code's (review M4): a fix task, not a person, and no second re-run.
    const again = see(one, 32, { checks: [job("CANCELLED", { jobId: 102, startedAt: "2026-09-30T12:00:31Z" })] });
    expect(item(again, "checks", 33)).toMatchObject({ state: "blocked", code: "checks-failed" });
    expect(item(again, "checks", 33).detail).toBe(`check: cancelled (the code: cancelled again after its re-run, github-actions, ${URL})`);
    expect(D.repairCause(again, task(again, ID))).toEqual({ kind: "checks", checks: [{ name: "check", url: URL }] });
    expect(repairTasks(D.advanceDelivery(again, at(34)))).toHaveLength(1);
    expect(plan(again, 40)?.kind).not.toBe("rerun");
    // With budget left (2), a second cancellation is still the provider's and takes the second re-run first.
    const { state: b2, op: op2 } = rerunBegun(cancelled({ cfg: { rerunBudget: 2 } }));
    const after2 = D.reportPrOp(b2, { op: op2, observed: { prs: [observation({ checks: [job("CANCELLED")] })], commits: [], at: at(31) } }, at(31));
    const again2 = see(after2, 32, { checks: [job("CANCELLED", { jobId: 102, startedAt: "2026-09-30T12:00:31Z" })] });
    expect(item(again2, "checks", 33)).toMatchObject({ state: "waiting" });
    expect(item(again2, "checks", 33).detail).toMatch(/It is re-run \(1 of 2 per check used on this head\)/);
    expect(plan(again2, 40)).toMatchObject({ kind: "rerun", jobs: [{ check: "check", jobId: 102 }] });
  });

  it("an interrupted re-run is observed after its timeout and grace, never sent again; a refused request ends the wait at once", () => {
    const { state: s, op } = rerunBegun(cancelled());
    // No result arrives (a crash). Before the grace time nothing is planned for it; after it, an observation.
    const later = D.OP_TIMEOUT_MS.rerun / 1000 + D.PR_LIMITS.graceMs / 1000;
    expect(D.nextPrOp(fresh(s, 30 + 10), ms(30 + 10))?.kind).not.toBe("rerun");
    expect(D.nextPrOp(fresh(s, 30 + later + 1), ms(30 + later + 1))).toMatchObject({ kind: "observe", prs: [{ taskId: ID, number: 12 }] });
    const reconciled = see(s, 30 + later + 2, { checks: [job("CANCELLED")] });
    expect(prOf(reconciled).op).toBeUndefined();
    expect(prOf(reconciled).ciReruns!.used).toHaveLength(1);
    expect(plan(reconciled, 30 + later + 10)?.kind).not.toBe("rerun"); // the budget stayed spent
    // GitHub refused the request (a definite failure): the wait is over at once, the budget stays spent, the event says so.
    const refused = D.reportPrOp(s, { op, actError: { code: "rejected", message: "HTTP 403: Resource not accessible" }, observed: { prs: [observation({ checks: [job("CANCELLED")] })], commits: [], at: at(31) } }, at(31));
    expect(prOf(refused).op).toBeUndefined();
    expect(prOf(refused).ciReruns!.used[0].seen).toBe(D.PR_LIMITS.rerunObservations);
    expect(prOf(refused).ciReruns!.used[0].refused).toBe("HTTP 403: Resource not accessible"); // review L9: the record says GitHub refused it, never "re-ran"
    expect(item(refused, "checks", 32)).toMatchObject({ state: "blocked", code: "ci-infra" });
    expect(refused.events.some((e) => /the re-run of check was not accepted by GitHub \(HTTP 403/.test(e.message))).toBe(true);
    // A network failure is not definite: the intent stays until the grace time, then it is observed.
    const flaky = D.reportPrOp(s, { op, error: { code: "network", message: "could not resolve host" } }, at(31));
    expect(prOf(flaky).op).toMatchObject({ kind: "rerun" });
    expect(D.nextPrOp(fresh(flaky, 30 + later + 1), ms(30 + later + 1))).toMatchObject({ kind: "observe" });
  });

  it("a new head resets the re-run budget", () => {
    const { state: s, op } = rerunBegun(cancelled());
    const judged = see(see(see(s, 31, { checks: [job("CANCELLED")] }, { opId: op.id }), 32, { checks: [job("CANCELLED")] }), 33, { checks: [job("CANCELLED")] });
    expect(item(judged, "checks", 34)).toMatchObject({ state: "blocked", code: "ci-infra" });
    // A fix is pushed onto the pull request (the head moves): the old head's re-runs are forgotten.
    const pending = structuredClone(fresh(judged, 40));
    prOf(pending).pendingHead = { sha: HEAD2, changeSha: HEAD2, changeTaskId: "EX-006-F1", changeAuthor: "codex", baseSha: SHA_A, kind: "repair" };
    delete prOf(pending).attention;
    const push = D.nextPrOp(pending, ms(40));
    expect(push).toMatchObject({ kind: "push", headSha: HEAD });
    const begun = D.beginPrOp(pending, push!, at(40));
    expect(begun.started).toBe(true);
    const moved = D.reportPrOp(begun.state, { op: push!, pushed: { sha: HEAD2 } }, at(41));
    expect(prOf(moved).headSha).toBe(HEAD2);
    expect(prOf(moved).ciReruns).toBeUndefined();
    const cancelledAgain = see(moved, 50, { headSha: HEAD2, checksFor: HEAD2, checks: [job("CANCELLED", { jobId: 201 })] });
    expect(plan(cancelledAgain, 60)).toMatchObject({ kind: "rerun", headSha: HEAD2, jobs: [{ check: "check", jobId: 201 }] });
  });
});

describe("checks that need a person (§7.2)", () => {
  it("a review bot's failing check is bot-check: no automatic repair, no re-run; the user's Fix this PR passes its name and link only", () => {
    const s = opened(built(prMode()), { checks: [job("FAILURE", { app: "coderabbitai", jobId: 55 })] });
    expect(item(s, "checks")).toMatchObject({ state: "blocked", code: "bot-check" });
    expect(item(s, "checks").detail).toMatch(/^The review bot coderabbitai reports failure on cccccccccccc\. A bot's opinion is not fixed automatically\. Read it on GitHub, then merge, or choose Fix this PR\./);
    expect(prOf(s).attention).toMatchObject({ code: "bot-check" });
    expect(D.prLabel(s, task(s, ID), ms(21))).toEqual({ text: "PR #12 bot check · needs you", tone: "danger" });
    expect(D.repairCause(s, task(s, ID))).toBeUndefined();
    expect(repairTasks(D.advanceDelivery(s, at(22)))).toHaveLength(0);
    expect(plan(s, 30)?.kind).not.toBe("rerun");
    expect(D.repairCause(s, task(s, ID), { byUser: true })).toEqual({ kind: "checks", checks: [{ name: "check", url: URL }] });
    const fixed = D.repairPr(s, ID, at(23));
    expect(repairTasks(fixed.state).map((t) => t.id)).toEqual([fixed.newId]);
    expect(M.currentSpec(task(fixed.state, fixed.newId)).content.scopeIncluded[0]).toBe(`Make the required check "check" pass (${URL}). Find the cause in the code; do not weaken tests, CI or build scripts.`);
    // A bot check whose link is not on github.com is passed by name alone.
    const elsewhere = opened(built(prMode()), { checks: [{ ...job("FAILURE", { app: "coderabbitai" }), url: "https://evil.example/x" }] });
    expect(D.repairCause(elsewhere, task(elsewhere, ID), { byUser: true })).toEqual({ kind: "checks", checks: [{ name: "check" }] });
  });

  it("a skipped, neutral or stale required check is checks-skipped: no fix task, not even the user's (mutation check)", () => {
    for (const c of ["SKIPPED", "NEUTRAL", "STALE"]) {
      const s = opened(built(prMode()), { checks: [job(c)] });
      expect(item(s, "checks"), c).toMatchObject({ state: "blocked", code: "checks-skipped" });
      expect(item(s, "checks").detail, c).toMatch(/^The required check check did not run on cccccccccccc, so nothing shows this head passes\. Re-run it on GitHub, or merge it yourself\./);
      expect(D.repairCause(s, task(s, ID)), c).toBeUndefined();
      expect(D.repairCause(s, task(s, ID), { byUser: true }), c).toBeUndefined();
      expect(repairTasks(D.advanceDelivery(s, at(22))), c).toHaveLength(0);
      expect(() => D.repairPr(s, ID, at(23)), c).toThrow(/A cancelled or skipped check is re-run on GitHub, not fixed/);
      expect(plan(s, 30)?.kind, c).not.toBe("rerun");
    }
    // Precedence when several classes fail: code first (a fix is needed anyway), then a bot, then a skipped check, then a cancelled one.
    expect(item(opened(built(prMode()), { checks: [job("SKIPPED"), job("FAILURE", { name: "lint", jobId: 102 })] }), "checks").code).toBe("checks-failed");
    expect(item(opened(built(prMode()), { checks: [job("SKIPPED"), job("FAILURE", { name: "bot", app: "coderabbitai", jobId: 103 })] }), "checks").code).toBe("bot-check");
    expect(item(opened(built(prMode()), { checks: [job("SKIPPED"), job("CANCELLED", { name: "build", jobId: 104 })] }), "checks").code).toBe("checks-skipped");
  });

  it("ci-infra: a cancelled check that cannot be re-run needs a person and no fix task", () => {
    const s = opened(built(prMode()), { checks: [bare("CANCELLED")] });
    expect(prOf(s).attention).toMatchObject({ code: "ci-infra" });
    expect(D.repairCause(s, task(s, ID), { byUser: true })).toBeUndefined();
    expect(repairTasks(D.advanceDelivery(s, at(22)))).toHaveLength(0);
    expect(D.needsYou(s, ms(22))).toBe(1);
  });
});

describe("the user's no-CI declaration (§7.4)", () => {
  const noCi = (declared: boolean, obs: Partial<D.PrObservation> = {}) => opened(built(prMode({ merge: "hold", requiredChecks: [], cfg: { noCi: declared } })), { checks: [], ...obs });

  it("with zero checks, the user's Merge works; automatic merging is still blocked (mutation check); without the declaration an empty list is never green (mutation check)", () => {
    const s = noCi(true);
    expect(item(s, "checks", 21, true)).toMatchObject({ state: "ok" });
    expect(item(s, "checks", 21, true).detail).toBe("No CI: you declared this repository has no CI, and GitHub reports no check on cccccccccccc.");
    expect(D.prReady(s, task(s, ID), ms(21))).toBe(true);
    expect(prOf(s).attention).toBeUndefined();
    const requested = D.requestPrMerge(s, ID, HEAD, at(21));
    expect(D.prGate(requested, task(requested, ID), ms(22), { byUser: true }).status).toBe("ready");
    // Automatically: blocked, and never a candidate.
    const auto = D.setPrPolicy(s, ID, "auto", at(21));
    expect(item(auto, "checks", 22, false)).toMatchObject({ state: "blocked", code: "checks-missing" });
    expect(item(auto, "checks", 22, false).detail).toContain("Automatic merging still needs a required check");
    expect(D.mergeCandidate(auto)).toBeUndefined();
    expect(D.nextPrOp(fresh(auto, 40), ms(40))?.kind).not.toBe("merge");
    // Without the declaration nothing changes: an empty list is never green, for anyone.
    const plain = noCi(false);
    expect(item(plain, "checks", 21, true)).toMatchObject({ state: "blocked", code: "checks-missing" });
    expect(D.prReady(plain, task(plain, ID), ms(21))).toBe(false);
    const plainRequested = D.requestPrMerge(plain, ID, HEAD, at(21));
    expect(D.prGate(plainRequested, task(plainRequested, ID), ms(22), { byUser: true }).status).toBe("blocked");
    // The posture says so, and the setting is the user's.
    expect(s.project.github!.posture.find((p) => p.id === "no-ci")).toMatchObject({ status: "warn", label: "You declared no CI." });
    expect(plain.project.github!.posture.some((p) => p.id === "no-ci")).toBe(false);
    expect(D.setPrDelivery(s, { noCi: false }, at(30)).project.github!.posture.some((p) => p.id === "no-ci")).toBe(false);
  });

  it("checks GitHub does report are honoured as required: a failing one blocks, a running one waits, a cancelled one is re-run", () => {
    expect(item(noCi(true, { checks: [job("FAILURE", { name: "ci/x", required: false })] }), "checks", 21, true)).toMatchObject({ state: "blocked", code: "checks-failed" });
    expect(item(noCi(true, { checks: [job(null, { name: "ci/x", required: false })] }), "checks", 21, true)).toMatchObject({ state: "waiting" });
    const ok = noCi(true, { checks: [job("SUCCESS", { name: "ci/x", required: false })] });
    expect(item(ok, "checks", 21, true)).toMatchObject({ state: "ok" });
    expect(item(ok, "checks", 21, true).detail).toContain("No check is required; these are the checks GitHub reported.");
    const cancelledOne = D.setPrPolicy(noCi(true, { checks: [job("CANCELLED", { name: "ci/x", required: false })] }), ID, "auto", at(21));
    expect(plan(cancelledOne, 30)).toMatchObject({ kind: "rerun", jobs: [{ check: "ci/x", jobId: 101 }] });
  });

  it("a merge with the declaration and nothing reported lands without the clean-gate flag, and the base's check is not watched", () => {
    const s = D.requestPrMerge(noCi(true), ID, HEAD, at(21));
    const merged = see(s, 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "me", mergedAt: at(29), checks: [] });
    const landed = task(merged, ID).integration!.landed!;
    expect(landed.flags).toEqual([]);
    expect(landed.mainCheck).toMatchObject({ state: "unknown" });
    expect(landed.checks).toEqual([]);
    // Watched when checks were reported on the head.
    const withChecks = see(D.requestPrMerge(noCi(true, { checks: [job("SUCCESS", { name: "ci/x", required: false })] }), ID, HEAD, at(21)), 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "me", mergedAt: at(29), checks: [job("SUCCESS", { name: "ci/x", required: false })] });
    expect(task(withChecks, ID).integration!.landed!.mainCheck).toMatchObject({ state: "pending" });
  });
});

describe("the settings (§7.5)", () => {
  it("validates the re-run budget, the bot list and the declaration; the event says what changed", () => {
    const s = prMode();
    expect(() => D.setPrDelivery(s, { rerunBudget: 4 }, at(3))).toThrow(/between 0 and 3/);
    expect(() => D.setPrDelivery(s, { rerunBudget: -1 }, at(3))).toThrow(/between 0 and 3/);
    expect(() => D.setPrDelivery(s, { rerunBudget: 1.5 }, at(3))).toThrow(/between 0 and 3/);
    expect(() => D.setPrDelivery(s, { reviewBotApps: Array.from({ length: 11 }, (_, i) => `bot-${i}`) }, at(3))).toThrow(/At most 10 review bots/);
    expect(() => D.setPrDelivery(s, { reviewBotApps: ["Not A Slug"] }, at(3))).toThrow(/GitHub app slug/);
    expect(() => D.setPrDelivery(s, { reviewBotApps: ["-leading"] }, at(3))).toThrow(/GitHub app slug/);
    expect(() => D.setPrDelivery(s, { noCi: "yes" as unknown as boolean }, at(3))).toThrow(/noCi must be true or false/);
    const next = D.setPrDelivery(s, { rerunBudget: 0, reviewBotApps: [" coderabbitai ", "", "my-bot"], noCi: true }, at(3));
    expect(next.project.prDelivery).toMatchObject({ rerunBudget: 0, reviewBotApps: ["coderabbitai", "my-bot"], noCi: true });
    expect(next.events.at(-1)!.message).toMatch(/you declared this repository has no CI .*; a check GitHub cancelled is re-run never/);
    expect(D.setPrDelivery(next, { rerunBudget: 0, reviewBotApps: ["coderabbitai", "my-bot"], noCi: true }, at(4))).toBe(next);
  });
});
