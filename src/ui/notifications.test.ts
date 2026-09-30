// Notification events are keyed on what changed, never on when something was retried (ORC-008 §14).

import { describe, expect, it } from "vitest";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import { reviewedChange } from "../domain/testing/reviewed";
import type { State } from "../domain/types";
import { detectEvents } from "./notifications";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const SHA_A = "a".repeat(40);

/** The sample project with EX-006 integrated and local delivery on. */
function deliverOn(): State {
  const s = buildSeed(T0, { inFlightRuns: false });
  task(s, "EX-006").integration = { status: "integrated", at: at(0), ref: "aaaaaaaaaaaa on orchestration/sample/integration", sha: SHA_A };
  return M.setAutonomy(s, { ...s.project.autonomy, autoDeliver: { enabled: true, branch: "main" } }, at(1));
}

describe("notifications: local delivery", () => {
  const deliveryEvents = (a: State, b: State) => detectEvents(a, b).filter((e) => e.key.startsWith("deliver:"));

  it("an identical retry produces no event; each change of outcome produces exactly one", () => {
    const s0 = deliverOn();
    const waiting = { status: "skipped" as const, message: "main is checked out with uncommitted changes; delivery waits until it is clean." };
    const s1 = M.reportDeliveryResult(s0, waiting, at(2));
    expect(deliveryEvents(s0, s1).map((e) => e.key)).toEqual([`deliver:EX-006:skipped:${at(2)}:${waiting.message}`]);

    // The same result a minute later, and again: the task's record is untouched, so nothing fires.
    const s2 = M.reportDeliveryResult(s1, waiting, at(62));
    const s3 = M.reportDeliveryResult(s2, waiting, at(122));
    expect(task(s2, "EX-006").integration?.delivered).toEqual(task(s1, "EX-006").integration?.delivered);
    expect(deliveryEvents(s1, s2)).toEqual([]);
    expect(deliveryEvents(s2, s3)).toEqual([]);
    expect(s3.events.filter((e) => e.message.startsWith("Delivery to main")).length).toBe(1);

    const s4 = M.reportDeliveryResult(s3, { status: "delivered", message: "main fast-forwarded to aaaaaaaaaaaa.", sha: SHA_A }, at(182));
    const fired = deliveryEvents(s3, s4);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ title: "Work delivered", taskId: "EX-006" });
    expect(deliveryEvents(s4, M.markVisited(s4, at(200)))).toEqual([]);
  });
});

describe("notifications: an outcome that comes back", () => {
  it("the same delivery outcome after a different one notifies again, under a new key", () => {
    const keys = new Set<string>();
    const fire = (a: State, b: State) => detectEvents(a, b).filter((e) => e.key.startsWith("deliver:") && !keys.has(e.key) && keys.add(e.key));
    const waiting = { status: "skipped" as const, message: "main is checked out with uncommitted changes; delivery waits until it is clean." };
    const conflict = { status: "conflict" as const, message: "main has changes that conflict with integrated work; nothing was delivered." };
    const s0 = deliverOn();
    const s1 = M.reportDeliveryResult(s0, waiting, at(2));
    const s2 = M.reportDeliveryResult(s1, conflict, at(62));
    const s3 = M.reportDeliveryResult(s2, waiting, at(400)); // waiting again, with the very same message
    const s4 = M.reportDeliveryResult(s3, waiting, at(460)); // …and an identical retry of it
    expect(fire(s0, s1)).toHaveLength(1);
    expect(fire(s1, s2)).toHaveLength(1);
    expect(fire(s2, s3)).toHaveLength(1); // was swallowed when the key held only status and message
    expect(fire(s3, s4)).toHaveLength(0);
    expect(keys.size).toBe(3);
  });
});

describe("notifications: pull requests", () => {
  const HEAD = "c".repeat(40);
  const obs = (over: Partial<D.PrObservation> = {}): D.PrObservation => ({
    number: 7,
    state: "OPEN",
    isDraft: false,
    crossRepo: false,
    url: "https://github.com/o/r/pull/7",
    headRef: "b",
    headSha: HEAD,
    baseRef: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    labels: [],
    checks: [{ name: "check", required: true, status: "COMPLETED", conclusion: "SUCCESS" }],
    checksFor: HEAD,
    ...over,
  });
  /** EX-006 as an open pull request #7 whose required check is still running. */
  function open(): State {
    let s = D.setDeliveryMode(buildSeed(T0, { inFlightRuns: false }), { mode: "pr" }, at(0));
    s.attempts = [];
    s = D.reportBaseFetched(D.reportPreflight(s, { ok: true, repo: "o/r", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(1)), SHA_A, at(2));
    // Its own pipeline reviewed exactly this change, clean, on the other provider.
    s = reviewedChange(s, "EX-006", HEAD, at(2));
    task(s, "EX-006").integration = { status: "pending" };
    s = D.reportPrHead(s, "EX-006", { n: 1, sha: HEAD, baseSha: SHA_A, changed: { files: 1, additions: 1, deletions: 0, paths: ["a"], protectedHits: [], workflowHits: [] } }, at(3));
    const op = D.nextPrOp(s, T0 + 10_000)!;
    s = D.reportPrOp(D.beginPrOp(s, op, at(10)).state, { op, published: { number: 7, url: "https://github.com/o/r/pull/7" } }, at(11));
    return D.reportObservations(s, { prs: [obs({ checks: [] })], commits: [] }, at(20));
  }
  const see = (s: State, second: number, over: Partial<D.PrObservation> = {}) => D.reportObservations(s, { prs: [obs(over)], commits: [] }, at(second));
  const prEvents = (a: State, b: State) => detectEvents(a, b).filter((e) => /^(pr-|main-check|github:)/.test(e.key));

  it("ready for you fires once for a head, not once per poll", () => {
    const s0 = open();
    expect(prEvents(s0, see(s0, 30, { checks: [] }))).toEqual([]);
    const s1 = see(s0, 140);
    expect(prEvents(s0, s1)).toEqual([expect.objectContaining({ key: `pr-ready:EX-006:${HEAD}`, title: "PR #7 is ready for you", taskId: "EX-006" })]);
    const s2 = see(s1, 260);
    const s3 = see(s2, 380);
    expect(prEvents(s1, s2)).toEqual([]);
    expect(prEvents(s2, s3)).toEqual([]);
    expect(s3.events.filter((e) => e.message.includes("is ready for you"))).toHaveLength(1);
  });

  it("needs you fires once per reason and head; merged and closed fire once", () => {
    const s0 = open();
    const red = see(s0, 140, { checks: [{ name: "check", required: true, status: "COMPLETED", conclusion: "FAILURE" }] });
    expect(prEvents(s0, red).map((e) => e.key)).toEqual([`pr-needs-you:EX-006:checks-failed:${HEAD}`]);
    expect(prEvents(red, see(red, 260, { checks: [{ name: "check", required: true, status: "COMPLETED", conclusion: "FAILURE" }] }))).toEqual([]);
    // A re-run that passes makes it ready: one event, of the other kind.
    const green = see(red, 380);
    expect(prEvents(red, green).map((e) => e.key)).toEqual([`pr-ready:EX-006:${HEAD}`]);
    const merged = see(green, 500, { state: "MERGED", mergeCommit: "d".repeat(40), mergedBy: "octocat" });
    expect(prEvents(green, merged)).toEqual([expect.objectContaining({ key: "pr-merged:EX-006:1", title: "PR #7 merged by octocat; review it when you like" })]);
    expect(prEvents(merged, M.markVisited(merged, at(501)))).toEqual([]);
    const closed = see(s0, 140, { state: "CLOSED" });
    expect(prEvents(s0, closed).map((e) => e.key)).toEqual(["pr-closed:EX-006:1"]);
    // The check on the base failing after the merge.
    const broke = D.reportObservations(merged, { prs: [], commits: [{ oid: "d".repeat(40), checks: [{ name: "check", required: false, status: "COMPLETED", conclusion: "FAILURE" }] }] }, at(560));
    expect(prEvents(merged, broke).map((e) => e.key)).toEqual([`main-check:EX-006:${"d".repeat(40)}`]);
  });

  it("a GitHub problem fires once, not once per failed check of the repository", () => {
    const s0 = open();
    const down = D.reportPrOp(s0, { op: { id: "x", kind: "observe", prs: [], commits: [] }, error: { code: "auth", message: "HTTP 401" } }, at(30));
    expect(prEvents(s0, down)).toEqual([expect.objectContaining({ key: `github:auth:${at(30)}`, title: "GitHub delivery stopped: sign-in needed" })]);
    const still = D.reportPreflight(down, { ok: false, problem: { code: "auth", message: "sign in" }, requiredChecks: [], autoMergeBlockers: [], posture: [] }, at(400));
    expect(prEvents(down, still)).toEqual([]);
  });

  it("automatic merging paused fires once, keyed on when the pause began", () => {
    const merged = see(open(), 140, { state: "MERGED", mergeCommit: "d".repeat(40), mergedBy: "octocat" });
    const paused = structuredClone(merged);
    paused.project.github!.autoMergePaused = { since: at(200), reason: "the check on o/r main is failing after PR #7", sticky: false, taskId: "EX-006" };
    const keys = (a: State, b: State) => detectEvents(a, b).filter((e) => e.key.startsWith("auto-merge-paused")).map((e) => e.key);
    expect(keys(merged, paused)).toEqual([`auto-merge-paused:${at(200)}`]);
    expect(keys(paused, M.markVisited(paused, at(201)))).toEqual([]);
    const sticky = structuredClone(paused);
    sticky.project.github!.autoMergePaused = { since: at(400), reason: "again", sticky: true };
    expect(keys(paused, sticky)).toEqual([`auto-merge-paused:${at(400)}`]);
    expect(detectEvents(merged, paused).find((e) => e.key.startsWith("auto-merge-paused"))).toMatchObject({ title: "Automatic merging is paused", taskId: "EX-006" });
  });
});
