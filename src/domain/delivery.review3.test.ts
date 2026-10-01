// ORC-008 step 3, findings of the independent review. Regression tests, pure:
//   1. independence is judged against everyone who authored a change on the pull request;
//   2. a user's edit of a summary does not make them the author, and an unknown author fails closed;
//   3. a dedicated review the user cancelled is not started again;
//   4. an observation is as old as the read of GitHub, not as its arrival;
//   6. a prepared base update is not pushed once the pull request stops being the merge candidate;
//   8. ensureReview respects a pause.

import { describe, expect, it } from "vitest";
import * as D from "./delivery";
import * as M from "./model";
import { buildSeed } from "./seed";
import { reviewedChange, type ReviewedOptions } from "./testing/reviewed";
import type { CheckObs, PrDelivery, ProviderId, State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ms = (s: number) => T0 + s * 1000;
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HEAD = "c".repeat(40);
const HEAD2 = "f".repeat(40);
const ID = "EX-006";
const FIX = `${ID}-F1`;
const CHANGED = { files: 1, additions: 1, deletions: 0, paths: ["a.txt"], protectedHits: [] as string[], workflowHits: [] as string[] };
const check = (conclusion: string | null): CheckObs => ({ name: "check", required: true, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion });
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
  checks: [check("SUCCESS")],
  checksFor: HEAD,
  ...over,
});
const prOf = (s: State, id = ID): PrDelivery => task(s, id).integration!.pr!;
const reviewTasks = (s: State) => s.tasks.filter((t) => t.reviewTarget?.taskId === ID);
const PREFLIGHT = { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] };

function prMode(merge: "hold" | "auto" = "auto"): State {
  let s = D.setDeliveryMode(buildSeed(T0, { inFlightRuns: false }), { mode: "pr" }, at(0));
  s.attempts = [];
  for (const t of s.tasks) if (t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
  s = D.reportBaseFetched(D.reportPreflight(s, PREFLIGHT, at(1)), SHA_A, at(2));
  return merge === "auto" ? D.setPrDelivery(s, { merge: "auto" }, at(2)) : s;
}
/** The task's own pipeline wrote the commit and reviewed it (or reviewed an earlier one). Prepared as a pull request. */
function built(s: State, review: ReviewedOptions = {}, mutate: (s: State) => void = () => {}): State {
  const next = reviewedChange(s, ID, HEAD, at(2), review);
  mutate(next);
  task(next, ID).lifecycle = "done";
  task(next, ID).hold = false;
  task(next, ID).integration = { status: "pending" };
  return D.reportPrHead(next, ID, { n: 1, sha: HEAD, baseSha: SHA_A, changed: CHANGED }, at(3));
}
function opened(s: State, obs: Partial<D.PrObservation> = {}): State {
  const op = D.nextPrOp(s, ms(10))!;
  expect(op).toMatchObject({ kind: "publish", taskId: ID });
  const open = D.reportPrOp(D.beginPrOp(s, op, at(10)).state, { op, published: { number: 12, url: "https://github.com/o/r/pull/12" } }, at(11));
  return D.reportObservations(open, { prs: [observation(obs)], commits: [] }, at(20));
}
/** Run an open task to its end with the real domain functions: every coder run records `sha`, every review is clean. */
function runToDone(s0: State, id: string, second: number, sha?: string): State {
  let s = s0;
  for (let i = 0; i < 12 && task(s, id).lifecycle !== "done"; i++) {
    s = M.dispatchEligible(M.leadPromoteProposals(s, at(second + i)), at(second + i));
    for (const a of M.activeAttempts(s, id)) {
      const st = task(s, id).steps.find((x) => x.id === a.stepId)!;
      s = M.reportCompletion(s, a.id, [], at(second + i), st.outputs.map((o) => ({ name: o.name, summary: o.name, ...(o.kind === "code-change" ? { ref: `${sha!.slice(0, 12)} on b` } : {}), ...(o.kind === "review-findings" ? { openFindings: 0 } : {}) })));
    }
  }
  expect(task(s, id).lifecycle).toBe("done");
  return s;
}
/** Push the pending head of the pull request, and see it on GitHub with green checks. */
function pushed(s: State, second: number): State {
  const push = D.nextPrOp(s, ms(second))!;
  expect(push).toMatchObject({ kind: "push", taskId: ID });
  const after = D.reportPrOp(D.beginPrOp(s, push, at(second)).state, { op: push, pushed: { sha: prOf(s).pendingHead!.sha } }, at(second + 1));
  return D.reportObservations(after, { prs: [observation({ headSha: prOf(after).headSha, checksFor: prOf(after).headSha })], commits: [] }, at(second + 2));
}
/** Codex wrote the change, nothing reviewed it, its required check failed: a dedicated review is pending and one fix task exists. */
function redWithFix(): State {
  const s = D.advanceDelivery(opened(D.advanceDelivery(built(prMode(), { writer: "codex", sawTheChange: false }), at(4)), { checks: [check("FAILURE")] }), at(22));
  expect(reviewTasks(s).map((t) => t.id)).toEqual([`${ID}-RV1`]);
  expect(task(s, FIX).deliverInto).toMatchObject({ taskId: ID });
  return s;
}
const fixReady = (s: State) => {
  const done = structuredClone(s);
  task(done, FIX).lifecycle = "done";
  task(done, FIX).integration = { status: "pending" };
  return D.reportRepairHead(done, FIX, { n: 1, sha: HEAD2, baseSha: SHA_A, changed: CHANGED, descends: true }, at(50));
};

describe("finding 1: independence is judged against every author of the pull request", () => {
  it("a fix from another provider does not make the first provider independent of its own work: X's code never merges on X's review alone", () => {
    // Codex wrote the original. Claude writes the fix, and Codex reviews the fix task's change.
    const s = fixReady(reviewedChange(redWithFix(), FIX, HEAD2, at(30), { writer: "claude", reviewer: "codex" }));
    expect(prOf(s).pendingHead).toMatchObject({ changeAuthor: "claude", changeAuthors: ["codex", "claude"], kind: "repair" });
    const after = D.advanceDelivery(pushed(s, 52), at(56));
    const pr = prOf(after);
    // The newest commit is Claude's, and the author set still names Codex.
    expect(pr).toMatchObject({ headSha: HEAD2, changeSha: HEAD2, changeTaskId: FIX, changeAuthor: "claude", changeAuthors: ["codex", "claude"] });
    // The pending review of the original change was cancelled with the old head…
    expect(task(after, `${ID}-RV1`)).toMatchObject({ lifecycle: "cancelled", cancelledBy: "system" });
    // …and the only review of the new head is Codex's: not independent of Codex's own commits.
    expect(pr.review.ok).toBe(false);
    expect(D.reviewView(after, task(after, ID)).state).toBe("blocked");
    expect(pr.review.reason).toMatch(/Codex and Claude each wrote part of this pull request/);
    expect(pr.review.reason).toMatch(/no provider reviews its own work/);
    // No provider is left that wrote none of it: it needs the user. Nothing is started, nothing merges.
    expect(reviewTasks(after).filter((t) => t.lifecycle !== "cancelled")).toEqual([]);
    expect(pr.attention).toMatchObject({ code: "review-blocked" });
    expect(D.mergeCandidate(after)).toBeUndefined();
    expect(D.prGate(after, task(after, ID), ms(57), { byUser: false }).status).toBe("blocked");
    expect(D.nextPrOp(after, ms(57))?.kind).not.toBe("merge");
    expect(D.beginPrOp(after, { id: "m", kind: "merge", taskId: ID, n: 1, headSha: HEAD2 }, at(57)).started).toBe(false);
    expect(D.needsYou(after, ms(57))).toBe(1);
    // Never self-review: asking for a dedicated review is refused, not run on a provider that wrote part of it.
    expect(() => D.requestPrReview(after, ID, at(58))).toThrow(/each wrote part of this pull request/);
    // The user's ways out: merge it themselves, or let any agent count.
    const mine = D.requestPrMerge(after, ID, HEAD2, at(58));
    expect(D.prGate(mine, task(mine, ID), ms(58), { byUser: true }).status).toBe("ready");
    expect(prOf(D.setPrDelivery(after, { reviewer: "any-agent" }, at(58))).review.ok).toBe(true);
  });

  it("a fix by the same provider keeps one author, and a review by the other provider covers the whole pull request", () => {
    const s = D.advanceDelivery(pushed(fixReady(reviewedChange(redWithFix(), FIX, HEAD2, at(30), { writer: "codex", reviewer: "claude" })), 52), at(56));
    expect(prOf(s)).toMatchObject({ changeAuthor: "codex", changeAuthors: ["codex"], review: { ok: true, source: "pipeline", taskId: FIX, forSha: HEAD2, provider: "claude" } });
    expect(D.mergeCandidate(s)!.id).toBe(ID);
  });

  for (const how of ["a role-default change", "a per-step pin"] as const) {
    it(`${how} makes the fix task's coder differ from the original coder: both are authors`, () => {
      let s = redWithFix();
      // The fix task exists (Codex is the coder default, Claude the reviewer). Then the choice changes.
      if (how === "a role-default change") s = M.setRoleDefault(s, "coder", { provider: "claude", model: "auto" }, at(24));
      else for (const st of task(s, FIX).steps.filter((x) => x.role === "coder")) s = M.setStepSelection(s, FIX, st.id, { provider: "claude", model: "auto" }, at(24));
      s = M.setRoleDefault(s, "code_reviewer", { provider: "codex", model: "auto" }, at(24));
      for (const t of s.tasks) if (t.reviewTarget) t.hold = true; // only the fix runs
      s = runToDone(s, FIX, 25, HEAD2);
      const coders = s.attempts.filter((a) => a.taskId === FIX && task(s, FIX).steps.find((x) => x.id === a.stepId)?.role === "coder");
      expect(new Set(coders.map((a) => a.snapshot.provider))).toEqual(new Set<ProviderId>(["claude"]));
      const after = D.advanceDelivery(pushed(D.reportRepairHead(s, FIX, { n: 1, sha: HEAD2, baseSha: SHA_A, changed: CHANGED, descends: true }, at(50)), 52), at(56));
      expect(prOf(after)).toMatchObject({ changeAuthor: "claude", changeAuthors: ["codex", "claude"] });
      // The fix task's own review ran on Codex and saw the final change: it still does not count.
      expect(prOf(after).review.ok).toBe(false);
      expect(D.reviewView(after, task(after, ID)).state).toBe("blocked");
      expect(D.mergeCandidate(after)).toBeUndefined();
    });
  }

  it("a repair round inside one task on another provider is an author too", () => {
    // The task's first coder run was Codex's; a later run of the same step, on Claude, made the final commit.
    const s = built(prMode(), { writer: "codex", reviewer: "codex" }, (x) => {
      const first = x.artifacts.find((a) => a.id === `fx-change-${ID}`)!;
      const run = x.attempts.find((a) => a.id === `fx-write-${ID}`)!;
      first.ref = `${SHA_B.slice(0, 12)} on b`;
      x.attempts.push({ ...run, id: "later-run", snapshot: { ...run.snapshot, provider: "claude" } });
      x.artifacts.push({ ...first, id: "later-change", attemptId: "later-run", version: 2, ref: `${HEAD.slice(0, 12)} on b`, createdAt: at(3) });
      // Codex's review saw exactly the final change.
      x.attempts.find((a) => a.id === `fx-review-${ID}`)!.snapshot.inputs[0] = { step: "S1", output: "change", artifactId: "later-change", version: 2 };
    });
    expect(M.finalChange(s, task(s, ID))!.id).toBe("later-change");
    expect(prOf(s)).toMatchObject({ changeAuthor: "claude" });
    expect(new Set(prOf(s).changeAuthors)).toEqual(new Set(["codex", "claude"]));
    expect(prOf(s).review.ok).toBe(false);
  });

  it("a dedicated review never resolves to a provider that wrote part of the pull request", () => {
    const s = D.advanceDelivery(built(prMode(), { writer: "codex", sawTheChange: false }), at(4));
    const rv = reviewTasks(s)[0];
    // One author: the other provider, chosen for independence (the reviewer default is the writer's).
    const codexDefault = M.setRoleDefault(s, "code_reviewer", { provider: "codex", model: "auto" }, at(5));
    expect(M.resolveStep(codexDefault, rv, rv.steps[0])).toMatchObject({ ok: true, selection: { provider: "claude" }, source: "independence" });
    // Both wrote part of it: whatever the default is, nothing resolves and nothing is substituted.
    for (const reviewer of ["claude", "codex"] as const) {
      const both = M.setRoleDefault(structuredClone(s), "code_reviewer", { provider: reviewer, model: "auto" }, at(5));
      prOf(both).changeAuthors = ["codex", "claude"];
      const r = M.resolveStep(both, task(both, rv.id), task(both, rv.id).steps[0]);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/No agent's review would be independent: Codex and Claude each wrote part of this change/);
      const dispatched = M.dispatchEligible(both, at(6));
      expect(M.activeAttempts(dispatched, rv.id)).toEqual([]);
    }
    // A record from before the set was kept names its newest author alone.
    const legacy = structuredClone(s);
    delete prOf(legacy).changeAuthors;
    expect(M.prAuthors(prOf(legacy))).toEqual(["codex"]);
  });
});

describe("finding 2: who the author is", () => {
  const edit = (x: State, ref: string | undefined) =>
    x.artifacts.push({ ...x.artifacts.find((a) => a.id === `fx-change-${ID}`)!, id: "edited", attemptId: "edit", version: 2, summary: "a better summary", author: "user", editReason: "clearer", ...(ref ? { ref } : {}), createdAt: at(2) });

  it("an edit of the summary alone leaves the commit with the run that made it", () => {
    const s = built(prMode(), { writer: "codex", reviewer: "codex" }, (x) => edit(x, undefined));
    expect(M.finalChange(s, task(s, ID))!.id).toBe("edited");
    expect(prOf(s)).toMatchObject({ changeAuthor: "codex", changeAuthors: ["codex"] });
    // Not a pass: Codex is still the author, so Codex's review is not independent and Codex is not asked again.
    const next = D.advanceDelivery(M.setRoleDefault(s, "code_reviewer", { provider: "codex", model: "auto" }, at(3)), at(4));
    expect(prOf(next).review.ok).toBe(false);
    const rv = reviewTasks(next)[0];
    expect(M.writersOf(next, rv, rv.steps[0])).toEqual(["codex"]);
    expect(M.resolveStep(next, rv, rv.steps[0])).toMatchObject({ ok: true, selection: { provider: "claude" }, source: "independence" });
    // The same commit written out in full is still the same commit.
    expect(prOf(built(prMode(), { writer: "codex" }, (x) => edit(x, HEAD))).changeAuthor).toBe("codex");
  });

  it("the user is the author only when their edit supplied another commit; the runs before it stay authors", () => {
    const s = built(prMode(), { writer: "codex", reviewer: "codex" }, (x) => edit(x, HEAD.slice(0, 7) === SHA_B.slice(0, 7) ? HEAD : SHA_B));
    // (the fixture's pull request head is HEAD; what matters here is who is recorded as the author)
    expect(prOf(s).changeAuthor).toBe("user");
    expect(new Set(prOf(s).changeAuthors)).toEqual(new Set(["codex", "user"]));
    expect(M.independentProviders(prOf(s).changeAuthors!)).toEqual(["claude"]);
    // A change only the user wrote constrains nobody.
    expect(M.independentProviders(["user"])).toEqual(["claude", "codex"]);
  });

  it("an unknown author fails closed: no agent's review counts, none is started, and it needs the user", () => {
    const s = built(prMode(), { writer: "codex", reviewer: "claude" }, (x) => {
      // The run that wrote the commit is not on record; the user later edited the summary, and the
      // review saw exactly that version. (Before the fix both facts made the author "user".)
      x.attempts = x.attempts.filter((a) => a.id !== `fx-write-${ID}`);
      edit(x, undefined);
      for (const id of [`fx-review-${ID}`, `fx-sec-${ID}`]) x.attempts.find((a) => a.id === id)!.snapshot.inputs[0] = { step: "S1", output: "change", artifactId: "edited", version: 2 };
    });
    expect(M.finalChange(s, task(s, ID))!.id).toBe("edited");
    expect(prOf(s)).toMatchObject({ changeAuthor: "unknown", changeAuthors: ["unknown"] });
    // The task's own clean review, by either provider, is not shown to be independent.
    expect(prOf(s).review.ok).toBe(false);
    const next = D.advanceDelivery(opened(s), at(22));
    expect(D.reviewView(next, task(next, ID)).state).toBe("blocked");
    expect(prOf(next).review.reason).toMatch(/not on record/);
    expect(reviewTasks(next)).toEqual([]);
    expect(prOf(next).attention).toMatchObject({ code: "review-blocked" });
    expect(D.mergeCandidate(next)).toBeUndefined();
    expect(D.prGate(next, task(next, ID), ms(23), { byUser: false }).status).toBe("blocked");
    // With no change on record at all the author is unknown too, never "user".
    const none = built(prMode(), {}, (x) => {
      x.artifacts = x.artifacts.filter((a) => a.taskId !== ID);
    });
    expect(prOf(none).changeAuthor).toBe("unknown");
    // The user may let any agent count.
    expect(prOf(D.setPrDelivery(next, { reviewer: "any-agent" }, at(24))).review.ok).toBe(true);
  });
});

describe("finding 3: a dedicated review the user cancelled", () => {
  it("leaves the pull request waiting for the user; the service does not start another", () => {
    const s = opened(D.advanceDelivery(built(prMode(), { writer: "codex", sawTheChange: false }), at(4)));
    const cancelled = M.cancelTask(s, `${ID}-RV1`, at(21));
    expect(task(cancelled, `${ID}-RV1`).cancelledBy).toBe("user");
    let after = cancelled;
    for (let i = 0; i < 5; i++) after = D.advanceDelivery(after, at(22 + i));
    expect(reviewTasks(after).map((t) => t.id)).toEqual([`${ID}-RV1`]);
    expect(prOf(after).counters.reviews).toBe(1);
    const v = D.reviewView(after, task(after, ID));
    expect(v).toMatchObject({ state: "blocked", reviewTaskId: `${ID}-RV1` });
    expect(v.evidence.reason).toMatch(/was cancelled by you, so no other is started\. Ask for a review, or merge it yourself\./);
    expect(prOf(after).attention).toMatchObject({ code: "review-blocked" });
    expect(D.needsYou(after, ms(30))).toBe(1);
    expect(D.prLabel(after, task(after, ID), ms(30))!.text).toBe("PR #12 needs you");
    // Ask for a review…
    const asked = D.requestPrReview(after, ID, at(31));
    expect(reviewTasks(asked).map((t) => t.id)).toEqual([`${ID}-RV1`, `${ID}-RV2`]);
    expect(D.reviewView(asked, task(asked, ID)).state).toBe("pending");
    expect(prOf(asked).attention).toBeUndefined();
    // …or merge it yourself.
    const mine = D.requestPrMerge(after, ID, HEAD, at(31));
    expect(D.prGate(mine, task(mine, ID), ms(31), { byUser: true }).status).toBe("ready");
    // A review the service cancelled itself is not the user's word.
    const bySystem = M.cancelTask(s, `${ID}-RV1`, at(21), { actor: "system", reason: "test" });
    expect(D.reviewView(bySystem, task(bySystem, ID)).state).toBe("missing");
  });
});

describe("finding 4: an observation is as old as the read of GitHub", () => {
  it("is stamped with the read time the driver recorded, so a late result is not fresh enough to merge on", () => {
    const base = opened(built(prMode(), { writer: "codex", reviewer: "claude" }));
    // Read at second 30, applied only at second 60 (the operation was slow, or the service was busy).
    const late = D.reportBaseFetched(D.reportPreflight(D.reportObservations(base, { at: at(30), prs: [observation()], commits: [] }, at(60)), PREFLIGHT, at(60)), SHA_A, at(60));
    expect(prOf(late).observed!.at).toBe(at(30));
    expect(late.project.github!.observedAt).toBe(at(60));
    expect(D.prGate(late, task(late, ID), ms(61), { byUser: false }).status).toBe("ready");
    expect(D.nextPrOp(late, ms(63))).toMatchObject({ kind: "observe" }); // looked at again first, never merged on the old read
    expect(D.beginPrOp(late, { id: "m", kind: "merge", taskId: ID, n: 1, headSha: HEAD }, at(63)).started).toBe(false);
    // The same result stamped when it was read moments ago is fresh.
    const fresh = D.reportObservations(late, { at: at(62), prs: [observation()], commits: [] }, at(63));
    expect(D.nextPrOp(fresh, ms(65))).toMatchObject({ kind: "merge" });
    // A stamp can never claim a read that lies in the future; without one the arrival time is used.
    expect(prOf(D.reportObservations(base, { at: at(999), prs: [observation()], commits: [] }, at(40))).observed!.at).toBe(at(40));
    expect(prOf(D.reportObservations(base, { prs: [observation()], commits: [] }, at(40))).observed!.at).toBe(at(40));
  });
});

describe("finding 6: a prepared base update and a pull request that stops being the merge candidate", () => {
  const UPDATE = "9".repeat(40);
  function prepared(): State {
    const s = D.reportBaseFetched(opened(built(prMode(), { writer: "codex", reviewer: "claude" })), SHA_B, at(22));
    const op = D.nextPrOp(s, ms(24))!;
    expect(op).toMatchObject({ kind: "update", taskId: ID });
    const updated = D.reportPrOp(s, { op, updated: { sha: UPDATE, baseSha: SHA_B } }, at(25));
    expect(prOf(updated)).toMatchObject({ pendingHead: { sha: UPDATE, kind: "update" }, counters: { baseUpdates: 1 } });
    return updated;
  }

  it("is dropped, not pushed, when the pull request is switched to hold (for it alone, or for the project)", () => {
    expect(D.nextPrOp(prepared(), ms(28))).toMatchObject({ kind: "push" });
    for (const held of [D.setPrPolicy(prepared(), ID, "hold", at(26)), D.setPrDelivery(prepared(), { merge: "hold" }, at(26)), D.holdPr(prepared(), ID, undefined, at(26))]) {
      expect(prOf(held).pendingHead).toBeUndefined();
      expect(prOf(held).counters.baseUpdates).toBe(0); // never pushed: it does not count
      expect(held.events.some((e) => e.message.includes("was dropped and not pushed"))).toBe(true);
      expect(D.nextPrOp(held, ms(28))?.kind).not.toBe("push");
      expect(prOf(held).headSha).toBe(HEAD);
    }
  });

  it("is refused inside the transaction too, and dropped by the next cycle, when the switch lands after planning", () => {
    const s = prepared();
    const push = D.nextPrOp(s, ms(28))!;
    const switched = structuredClone(s);
    prOf(switched).policy = "hold"; // the switch, however it arrived
    expect(D.beginPrOp(switched, push, at(28)).started).toBe(false);
    expect(D.nextPrOp(switched, ms(28))?.kind).not.toBe("push");
    expect(prOf(D.advanceDelivery(switched, at(29))).pendingHead).toBeUndefined();
    // A fix waiting to be pushed is not an update: it is kept.
    const fix = structuredClone(switched);
    prOf(fix).pendingHead!.kind = "repair";
    expect(prOf(D.advanceDelivery(fix, at(29))).pendingHead).toBeDefined();
    // The candidate's own update is untouched by the cycle.
    expect(prOf(D.advanceDelivery(s, at(29))).pendingHead).toMatchObject({ sha: UPDATE });
  });
});

describe("finding 8: ensureReview is what the service calls", () => {
  it("creates nothing while the project is paused, the pull request is held, or delivery is off", () => {
    const s = built(prMode(), { writer: "codex", sawTheChange: false });
    const paused = M.pauseProject(s, at(4));
    expect(D.ensureReview(paused, ID, at(5))).toBe(paused);
    const held = D.holdPr(s, ID, undefined, at(4));
    expect(D.ensureReview(held, ID, at(5))).toBe(held);
    const off = D.setDeliveryMode(s, { mode: "off" }, at(4));
    expect(D.ensureReview(off, ID, at(5))).toBe(off);
    // The cycle and the function agree: one review, by either way.
    expect(reviewTasks(D.ensureReview(s, ID, at(5))).map((t) => t.id)).toEqual([`${ID}-RV1`]);
    expect(reviewTasks(D.advanceDelivery(s, at(5))).map((t) => t.id)).toEqual([`${ID}-RV1`]);
    expect(reviewTasks(D.ensureReview(M.resumeProject(paused, at(6)), ID, at(7)))).toHaveLength(1);
  });
});

describe("ORC-009 review finding 1: the review and fix tasks of a pull request are not steerable", () => {
  it("a message run in PR auto mode that defers the review or reprioritizes the fix is rejected; a deferred review is reported as such", () => {
    const s0 = redWithFix();
    const rv = `${ID}-RV1`;
    for (const id of [rv, FIX]) for (const action of ["priority", "defer", "undefer", "drop"] as const) expect(M.steerPermission(s0, task(s0, id), action, "apply", 1)).toEqual({ v: "reject", why: "delivery task: not steerable" });
    let s = M.postMessage(s0, "defer the review, it can wait", at(60));
    const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(61));
    s = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], steer: { tasks: [{ id: rv, defer: true }, { id: FIX, priority: 1 }] } }, at(62));
    expect(s.steering[0].changes.map((c) => [c.taskId, c.status, c.note])).toEqual([
      [rv, "rejected", "delivery task: not steerable"],
      [FIX, "rejected", "delivery task: not steerable"],
    ]);
    expect(task(s, rv).deferral).toBeUndefined();
    expect(task(s, FIX).priority).toBe(task(s0, FIX).priority);
    expect(D.reviewView(s, task(s, ID))).toMatchObject({ state: "pending", reviewTaskId: rv });
    // A deferral reached by any other path is reported as what it is, never as "queued".
    const deferred = structuredClone(s);
    task(deferred, rv).deferral = { by: "user", at: at(63), reason: "test" };
    const v = D.reviewView(deferred, task(deferred, ID));
    expect(v).toMatchObject({ state: "blocked", reviewTaskId: rv });
    expect(v.evidence.reason).toMatch(new RegExp(`The independent review ${rv} of [0-9a-f]{12} is deferred, so it does not run`));
  });
});
