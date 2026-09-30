// ORC-008 step 3, pure: independent review coverage, the dedicated review task, bounded repair, the
// automatic merge gate (items 9 to 12), the merge queue of one, the base update, and the pause when the
// base branch fails. Also the step 2 review findings that live in the domain. Nothing here touches git
// or GitHub. Each "mutation check" names the guard whose removal makes that test fail.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as D from "./delivery";
import * as M from "./model";
import { validatePipeline } from "./pipeline";
import { buildSeed } from "./seed";
import { BUILT_IN_TEMPLATES, INTERNAL_TEMPLATE_IDS, PROJECT_TEMPLATES, templateSteps } from "./templates";
import { reviewedChange, type ReviewedOptions } from "./testing/reviewed";
import type { CheckObs, PrDelivery, ProviderId, State, Task } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ms = (s: number) => T0 + s * 1000;
const seed = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HEAD = "c".repeat(40);
const HEAD2 = "f".repeat(40);
const MERGE = "d".repeat(40);
const ID = "EX-006";
const check = (conclusion: string | null, name = "check", required = true): CheckObs => ({ name, required, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion });
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
const CHANGED = { files: 1, additions: 1, deletions: 0, paths: ["a.txt"], protectedHits: [] as string[], workflowHits: [] as string[] };

/** Pull-request delivery on, the repository checked as `me`, its base fetched; every other open task held. */
function prMode(merge: "hold" | "auto" = "hold"): State {
  let s = D.setDeliveryMode(seed(), { mode: "pr" }, at(0));
  s.attempts = [];
  for (const t of s.tasks) if (t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
  s = D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(1));
  s = D.reportBaseFetched(s, SHA_A, at(2));
  return merge === "auto" ? D.setPrDelivery(s, { merge: "auto" }, at(2)) : s;
}

/** A task whose one-step pipeline wrote the commit on Codex and had no review at all. */
function unreviewedChange(s: State, id: string, sha: string): State {
  const next = reviewedChange(s, id, sha, at(2), { writer: "codex" });
  task(next, id).steps = task(next, id).steps.filter((x) => x.role === "coder");
  next.attempts = next.attempts.filter((a) => a.id !== `fx-review-${id}`);
  next.artifacts = next.artifacts.filter((a) => a.id !== `fx-findings-${id}`);
  return next;
}

/** A done task with its head prepared as a pull request. `review: null`: its pipeline had no review at all. */
function built(s: State, id = ID, sha = HEAD, review: ReviewedOptions | null = {}, changed: Partial<PrDelivery["changed"]> = {}): State {
  const next = review ? reviewedChange(s, id, sha, at(2), review) : unreviewedChange(s, id, sha);
  task(next, id).lifecycle = "done";
  task(next, id).hold = false;
  task(next, id).integration = { status: "pending" };
  return D.reportPrHead(next, id, { n: 1, sha, baseSha: SHA_A, changed: { ...CHANGED, ...changed } }, at(3));
}

/** …published and observed once, `second` seconds in. */
function opened(s: State, id = ID, number = 12, second = 20, obs: Partial<D.PrObservation> = {}): State {
  const op = D.nextPrOp(s, ms(second - 10))!;
  expect(op).toMatchObject({ kind: "publish", taskId: id });
  const begun = D.beginPrOp(s, op, at(second - 10));
  expect(begun.started).toBe(true);
  const open = D.reportPrOp(begun.state, { op, published: { number, url: `https://github.com/o/r/pull/${number}` } }, at(second - 9));
  return D.reportObservations(open, { prs: [observation({ number, headSha: prOf(open, id).headSha, checksFor: prOf(open, id).headSha, url: `https://github.com/o/r/pull/${number}`, ...obs })], commits: [] }, at(second));
}
const autoOpen = (review: ReviewedOptions | null = {}, obs: Partial<D.PrObservation> = {}) => opened(built(prMode("auto"), ID, HEAD, review), ID, 12, 20, obs);
const gate = (s: State, second = 21, byUser = false) => D.prGate(s, task(s, ID), ms(second), { byUser });
const item = (s: State, id: D.GateItem["id"], second = 21, byUser = false) => gate(s, second, byUser).items.find((i) => i.id === id)!;
const see = (s: State, second: number, over: Partial<D.PrObservation> = {}) => D.reportObservations(s, { prs: [observation({ headSha: prOf(s).headSha, checksFor: prOf(s).headSha, ...over })], commits: [] }, at(second));
/** The repository was checked and the base fetched moments before `second`, so neither is what is planned then. */
const fresh = (s: State, second: number) => D.reportBaseFetched(D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(second - 2)), SHA_A, at(second - 1));
/** Written by Codex; the task's own review ran on an earlier change, so nothing has reviewed this one. */
const UNREVIEWED: ReviewedOptions = { writer: "codex", sawTheChange: false };
const reviewTasks = (s: State, id = ID) => s.tasks.filter((t) => t.reviewTarget?.taskId === id);
const repairTasks = (s: State, id = ID) => s.tasks.filter((t) => t.deliverInto?.taskId === id);

/** Dispatch and finish every run of a task until it is done. Reviews report `findings`. Returns the state. */
function runToDone(s0: State, id: string, second: number, findings = 0): State {
  let s = s0;
  for (let i = 0; i < 12 && task(s, id).lifecycle !== "done"; i++) {
    s = M.dispatchEligible(M.leadPromoteProposals(s, at(second)), at(second));
    for (const a of M.activeAttempts(s, id)) {
      const st = task(s, id).steps.find((x) => x.id === a.stepId)!;
      s = M.reportCompletion(s, a.id, [], at(second), st.outputs.map((o) => ({ name: o.name, summary: `${o.name} summary`, ...(o.kind === "review-findings" ? { openFindings: findings } : {}) })));
    }
  }
  return s;
}

/**
 * A fresh task on the built-in "change" pipeline, run to the end with the real domain functions: every
 * coder run records the next commit, every review reports `findings(round)`. The last commit is its
 * final change.
 */
function changeTask(s0: State, findings: (round: number) => number, reviewer: ProviderId = "claude"): { state: State; id: string; final: string } {
  let s = M.setRoleDefault(s0, "coder", { provider: "codex", model: "auto" }, at(3));
  s = M.setRoleDefault(s, "code_reviewer", { provider: reviewer, model: "auto" }, at(3));
  const r = runCommand(s, "createTask", { title: "Loop", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, templateId: "change" }, at(3));
  s = r.state;
  const id = (r.result as { newId: string }).newId;
  let commits = 0;
  let round = 0;
  let final = "";
  for (let i = 0; i < 40 && task(s, id).lifecycle !== "done"; i++) {
    s = M.dispatchEligible(M.leadPromoteProposals(s, at(4 + i)), at(4 + i));
    for (const a of M.activeAttempts(s, id)) {
      const st = task(s, id).steps.find((x) => x.id === a.stepId)!;
      // As the scheduler does for a code review: the changed-path set of the change it reads is recorded before it reports.
      if (st.role === "code_reviewer") {
        const change = a.snapshot.inputs.map((x) => s.artifacts.find((y) => y.id === x.artifactId)!).filter((y) => y.kind === "code-change").sort((x, y) => x.createdAt.localeCompare(y.createdAt)).pop();
        if (change?.ref) s = M.reportRunContext(s, a.id, { scope: { from: SHA_A, to: change.ref.split(" ")[0], paths: ["a.txt"], total: 1 } });
      }
      const outputs = st.outputs.map((o) => {
        if (o.kind === "code-change") {
          final = `${String(++commits).padStart(2, "0")}${"e".repeat(38)}`;
          return { name: o.name, summary: "change", ref: `${final.slice(0, 12)} on b` };
        }
        return { name: o.name, summary: o.name, ...(o.kind === "review-findings" ? { openFindings: findings(round++), reviewedPaths: ["a.txt"] } : {}) };
      });
      s = M.reportCompletion(s, a.id, [], at(4 + i), outputs);
    }
  }
  expect(task(s, id).lifecycle).toBe("done");
  return { state: s, id, final };
}
const prFor = (s: State, id: string, sha: string) => D.reportPrHead(s, id, { n: 1, sha, baseSha: SHA_A, changed: CHANGED }, at(60));

describe("the delivery-review template", () => {
  it("is built in, internal, one independent code review, and exempt from the no-inputs warning only for a review task", () => {
    const tpl = BUILT_IN_TEMPLATES.find((t) => t.id === "delivery-review")!;
    expect(tpl.steps).toEqual([{ id: "S1", purpose: "Review the change for merge", role: "code_reviewer", dependsOn: [], inputs: [], outputs: [{ name: "findings", kind: "review-findings" }], independentOf: "writer" }]);
    expect(INTERNAL_TEMPLATE_IDS).toContain("delivery-review");
    expect(PROJECT_TEMPLATES.some((t) => t.id === "delivery-review")).toBe(false);
    expect(() => runCommand(M.saveTemplate(seed(), structuredClone(tpl), null, at(1)), "createTask", { title: "t", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: [], priority: 1, holdBeforeStart: false, templateId: "delivery-review" }, at(2))).toThrow(/used by the service only/);
    expect(validatePipeline(tpl.steps).map((i) => i.severity)).toEqual(["warning"]);
    expect(validatePipeline(tpl.steps, { reviewTarget: true })).toEqual([]);
    // The exemption is for that case only.
    expect(validatePipeline(templateSteps("change").map((d) => (d.role === "code_reviewer" ? { ...d, inputs: [] } : d)), { reviewTarget: false }).some((i) => i.severity === "warning")).toBe(true);
  });
});

describe("reviewCoverage (design §9.1)", () => {
  it("Codex writes and Claude reviews the final change clean: the task's own review counts, with no extra run", () => {
    const s = built(prMode(), ID, HEAD, { writer: "codex", reviewer: "claude" });
    expect(prOf(s).review).toMatchObject({ ok: true, source: "pipeline", forSha: HEAD, provider: "claude", taskId: ID, attemptId: `fx-review-${ID}`, artifactIds: [`fx-findings-${ID}`] });
    expect(D.reviewCoverage(s, task(s, ID))).toEqual(prOf(s).review);
    const after = D.advanceDelivery(s, at(4));
    expect(reviewTasks(after)).toEqual([]);
    expect(after).toEqual(s); // nothing to do: nothing changes
  });

  it("the same provider as the writer is not independent; under \"any agent\" it counts", () => {
    const s = built(prMode(), ID, HEAD, { writer: "codex", reviewer: "codex" });
    expect(prOf(s).review).toMatchObject({ ok: false, source: "pipeline", provider: "codex" });
    expect(prOf(s).review.reason).toMatch(/done by Codex, the provider that wrote the change/);
    expect(D.reviewView(s, task(s, ID)).state).toBe("not-independent");
    const any = D.setPrDelivery(s, { reviewer: "any-agent" }, at(4));
    expect(prOf(any).review).toMatchObject({ ok: true, source: "pipeline", provider: "codex" });
    // A change the user supplied counts any agent as independent.
    const byUser = structuredClone(s);
    prOf(byUser).changeAuthor = "user";
    prOf(byUser).changeAuthors = ["user"];
    expect(D.reviewCoverage(byUser, task(byUser, ID)).ok).toBe(true);
  });

  it("mutation check (coverage rule): a repair loop that runs out leaves its last repair unreviewed, and the finished task proves nothing", () => {
    const r = changeTask(prMode(), () => 1); // findings open every round
    const t = task(r.state, r.id);
    // The confirmed defect: three repairs ran, the last one was never reviewed, and the task is done.
    expect(t.steps.filter((x) => x.role === "coder" && x.state === "done")).toHaveLength(4);
    expect(t.steps.filter((x) => x.role === "code_reviewer" && x.state === "done")).toHaveLength(3);
    const s = prFor(r.state, r.id, r.final);
    expect(prOf(s, r.id).review).toMatchObject({ ok: false, source: "none", forSha: r.final });
    expect(prOf(s, r.id).review.reason).toBe(`No review saw the final change ${r.final.slice(0, 12)}.`);
    expect(D.reviewView(s, task(s, r.id)).state).toBe("missing");
    // The same pipeline with a repair that is reviewed clean is covered by that later review.
    const fixed = changeTask(prMode(), (round) => (round === 0 ? 2 : 0));
    const ok = prFor(fixed.state, fixed.id, fixed.final);
    expect(prOf(ok, fixed.id).review).toMatchObject({ ok: true, source: "pipeline", provider: "claude", forSha: fixed.final });
    // …and one that came back clean at once is covered by the first review.
    const clean = changeTask(prMode(), () => 0);
    expect(prOf(prFor(clean.state, clean.id, clean.final), clean.id).review.ok).toBe(true);
  });

  it("open findings on the final change are not a pass; findings a person cleared pass and are flagged", () => {
    const s = built(prMode(), ID, HEAD, { findings: 2 });
    expect(prOf(s).review).toMatchObject({ ok: false, source: "pipeline" });
    expect(prOf(s).review.reason).toMatch(/2 open findings/);
    expect(D.reviewView(s, task(s, ID)).state).toBe("findings");
    // The user edited the findings to zero while the task was open: a newer version, by them.
    const cleared = structuredClone(s);
    cleared.artifacts.push({ ...cleared.artifacts.find((a) => a.id === `fx-findings-${ID}`)!, id: "edited", attemptId: "edit", version: 2, openFindings: 0, author: "user", editReason: "not a real problem" });
    expect(D.reviewCoverage(cleared, task(cleared, ID))).toMatchObject({ ok: true, clearedByUser: true, artifactIds: ["edited"] });
    // It lands flagged.
    const open = opened(D.advanceDelivery(cleared, at(4)));
    const merged = see(open, 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" });
    expect(task(merged, ID).integration!.landed!.flags).toEqual(["findings-cleared-by-user"]);
  });

  it("a review that ran on an earlier change does not cover the final one", () => {
    const s = built(prMode(), ID, HEAD, { sawTheChange: false });
    expect(prOf(s).review).toMatchObject({ ok: false, source: "none" });
    // …nor does a change whose commit is not the pull request's.
    const other = structuredClone(built(prMode()));
    prOf(other).changeSha = HEAD2;
    expect(D.reviewCoverage(other, task(other, ID)).ok).toBe(false);
  });

  it("a dedicated review counts only for the change it read: an older change, or a run that read another commit, never", () => {
    let s = D.advanceDelivery(built(prMode(), ID, HEAD, UNREVIEWED), at(4));
    const [rv] = reviewTasks(s);
    expect(rv.reviewTarget).toEqual({ taskId: ID, n: 1, headSha: HEAD, baseSha: SHA_A });
    expect(D.reviewView(s, task(s, ID))).toMatchObject({ state: "pending", reviewTaskId: rv.id });
    s = runToDone(s, rv.id, 5);
    expect(s.attempts.find((a) => a.taskId === rv.id)!.snapshot).toMatchObject({ reviewedSha: HEAD, provider: "claude" });
    const done = D.advanceDelivery(s, at(6));
    expect(prOf(done).review).toMatchObject({ ok: true, source: "dedicated", forSha: HEAD, taskId: rv.id, provider: "claude" });
    // The pull request now holds another change: the evidence is for the old one and no longer passes.
    const moved = structuredClone(done);
    prOf(moved).changeSha = HEAD2;
    expect(D.reviewCoverage(moved, task(moved, ID)).ok).toBe(false);
    expect(item(opened(moved), "review", 21).ok).toBe(false);
    // A run that read another commit than the one under review proves nothing (mutation check: reviewedSha).
    const elsewhere = structuredClone(s);
    elsewhere.attempts.find((a) => a.taskId === rv.id)!.snapshot.reviewedSha = SHA_B;
    expect(D.reviewView(elsewhere, task(elsewhere, ID)).state).toBe("missing");
    expect(D.reviewCoverage(elsewhere, task(elsewhere, ID)).reason).toMatch(/did not read/);
  });
});

describe("the independence rung in resolveStep (design §9.2)", () => {
  /** A dedicated review of a change Codex wrote, with the reviewer default set to `reviewer`. */
  function reviewOf(reviewer: ProviderId): { state: State; rv: Task } {
    let s = M.setRoleDefault(prMode(), "code_reviewer", { provider: reviewer, model: "auto" }, at(2));
    s = D.advanceDelivery(built(s, ID, HEAD, UNREVIEWED), at(4));
    return { state: s, rv: reviewTasks(s)[0] };
  }

  it("the default reviewer is the writer's provider: the other provider is chosen, and recorded as chosen for independence", () => {
    const { state, rv } = reviewOf("codex");
    expect(prOf(state).changeAuthor).toBe("codex");
    const r = M.resolveStep(state, rv, rv.steps[0]);
    expect(r).toMatchObject({ ok: true, selection: { provider: "claude" }, source: "independence", reason: "Claude: other provider than the writer (Codex)" });
    expect(M.sourceLabel("independence")).toBe("Independent of the writer");
    // The service never writes a pin: the system's choice and a user's pin stay distinguishable.
    expect(rv.steps[0].selection).toBeNull();
    // When the default already is the other provider, it is simply the role default.
    const other = reviewOf("claude");
    expect(M.resolveStep(other.state, other.rv, other.rv.steps[0])).toMatchObject({ ok: true, selection: { provider: "claude" }, source: "project-role" });
    // "Any agent": no rung.
    const any = D.setPrDelivery(state, { reviewer: "any-agent" }, at(5));
    expect(M.resolveStep(any, rv, rv.steps[0])).toMatchObject({ ok: true, selection: { provider: "codex" }, source: "project-role" });
  });

  it("mutation check (no substitution): with the other provider disabled the step does not resolve, blocks, and the pull request says so", () => {
    const { state, rv } = reviewOf("codex");
    const only = M.setProviderEnabled(state, "claude", false, at(5));
    const r = M.resolveStep(only, task(only, rv.id), task(only, rv.id).steps[0]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^Independent review needs Claude, which is not enabled\./);
    const dispatched = M.dispatchEligible(only, at(6));
    expect(M.activeAttempts(dispatched, rv.id)).toEqual([]); // nothing ran on Codex instead
    expect(task(dispatched, rv.id).steps[0]).toMatchObject({ state: "blocked" });
    const seen = D.advanceDelivery(dispatched, at(7));
    expect(D.reviewView(seen, task(seen, ID)).state).toBe("blocked");
    expect(prOf(seen).attention).toMatchObject({ code: "review-blocked" });
    expect(prOf(seen).attention!.message).toMatch(/Independent review needs Claude/);
    expect(reviewTasks(seen)).toHaveLength(1); // no second review is started for the same change
    // The user's way out: enable the provider, or let any agent count.
    const enabled = M.dispatchEligible(M.setProviderEnabled(seen, "claude", true, at(8)), at(9));
    expect(M.activeAttempts(enabled, rv.id)[0].snapshot).toMatchObject({ provider: "claude", source: "independence" });
    const any = M.dispatchEligible(D.setPrDelivery(seen, { reviewer: "any-agent" }, at(8)), at(9));
    expect(M.activeAttempts(any, rv.id)[0].snapshot).toMatchObject({ provider: "codex", source: "project-role" });
  });

  it("a user's pin wins; when it is the writer's provider the review runs there and is reported as not independent", () => {
    const { state, rv } = reviewOf("claude");
    const pinned = M.setStepSelection(state, rv.id, "S1", { provider: "codex", model: "auto" }, at(5));
    expect(M.resolveStep(pinned, task(pinned, rv.id), task(pinned, rv.id).steps[0])).toMatchObject({ ok: true, selection: { provider: "codex" }, source: "step" });
    const done = D.advanceDelivery(runToDone(pinned, rv.id, 6), at(7));
    const v = D.reviewView(done, task(done, ID));
    expect(v.state).toBe("blocked");
    expect(v.evidence.reason).toMatch(/does not count as independent/);
    expect(prOf(done).review.ok).toBe(false);
    expect(prOf(done).attention).toMatchObject({ code: "review-blocked" });
    expect(reviewTasks(done)).toHaveLength(1); // nothing is substituted and no second review is started
    // The user asks for a new one after removing the pin's cause.
    const again = D.requestPrReview(done, ID, at(8));
    expect(reviewTasks(again)).toHaveLength(2);
    expect(() => D.requestPrReview(again, ID, at(9))).toThrow(/already reviewing/);
  });

  it("a review step of an ordinary pipeline marked independent follows the writer of its input", () => {
    const s = reviewedChange(M.setRoleDefault(prMode(), "code_reviewer", { provider: "codex", model: "auto" }, at(2)), ID, HEAD, at(2), { writer: "codex" });
    const t = task(s, ID);
    const st = { ...t.steps[1], independentOf: "writer" as const };
    expect(M.writerOf(s, t, st)).toBe("codex");
    expect(M.resolveStep(s, t, st)).toMatchObject({ ok: true, selection: { provider: "claude" }, source: "independence" });
    expect(M.resolveStep(s, t, t.steps[1])).toMatchObject({ selection: { provider: "codex" } }); // unmarked: unchanged
  });
});

describe("ensureReview (design §9.2)", () => {
  it("exactly one dedicated review, an ordinary ready task with the independence rule, and none for open findings", () => {
    const s0 = built(prMode(), ID, HEAD, null);
    const s = D.advanceDelivery(s0, at(4));
    const [rv] = reviewTasks(s);
    expect(reviewTasks(s)).toHaveLength(1);
    expect(rv).toMatchObject({ id: `${ID}-RV1`, lifecycle: "ready", hold: false, holdBeforeStart: false, dependsOn: [], priority: task(s, ID).priority });
    expect(rv.specs[0]).toMatchObject({ author: "system" });
    expect(rv.steps).toHaveLength(1);
    expect(rv.steps[0]).toMatchObject({ role: "code_reviewer", purpose: `Review ${ID} for merge into main at ${HEAD.slice(0, 12)}`, independentOf: "writer", inputs: [] });
    expect(prOf(s)).toMatchObject({ reviewTaskIds: [rv.id], counters: { reviews: 1 } });
    expect(M.currentSpec(rv).content.title).toMatch(/^Review for merge: /);
    // Asking again, or advancing again, never makes a second one for the same change.
    expect(D.ensureReview(s, ID, at(5))).toBe(s);
    expect(reviewTasks(D.advanceDelivery(D.advanceDelivery(s, at(5)), at(6)))).toHaveLength(1);
    expect(D.ensureReview(s0, ID, at(4)).tasks.filter((t) => t.reviewTarget)).toHaveLength(1);
    // It is never the lead's proposal, whoever proposed the task it reviews.
    const lead = structuredClone(s);
    task(lead, rv.id).specs[0].author = "lead";
    expect(M.openLeadProposals(lead).map((t) => t.id)).not.toContain(rv.id);
    // Open findings are not a reason for another review: they go to repair.
    const findings = D.advanceDelivery(built(prMode(), ID, HEAD, { findings: 1 }), at(4));
    expect(reviewTasks(findings)).toEqual([]);
    expect(prOf(findings).attention).toMatchObject({ code: "review-findings" });
  });

  it("nothing is created while the project or the pull request is paused, or while pull-request delivery is off", () => {
    const s = built(prMode(), ID, HEAD, null);
    expect(reviewTasks(D.advanceDelivery(M.pauseProject(s, at(4)), at(5)))).toEqual([]);
    expect(reviewTasks(D.advanceDelivery(D.holdPr(s, ID, undefined, at(4)), at(5)))).toEqual([]);
    expect(reviewTasks(D.advanceDelivery(D.setDeliveryMode(s, { mode: "off" }, at(4)), at(5)))).toEqual([]);
    expect(reviewTasks(D.advanceDelivery(M.resumeProject(M.pauseProject(s, at(4)), at(5)), at(6)))).toHaveLength(1);
  });

  it("bounded: after three dedicated reviews the service stops and says so; the user may still ask", () => {
    let s = D.advanceDelivery(built(prMode(), ID, HEAD, null), at(4));
    for (let k = 1; k <= 3; k++) {
      expect(reviewTasks(s)).toHaveLength(k);
      // The review finishes, but its run read another commit: the change is still unreviewed.
      s = runToDone(s, `${ID}-RV${k}`, 4 + k);
      s.attempts.find((a) => a.taskId === `${ID}-RV${k}`)!.snapshot.reviewedSha = SHA_B;
      s = D.advanceDelivery(s, at(5 + k));
    }
    expect(reviewTasks(s)).toHaveLength(3);
    expect(prOf(s).counters.reviews).toBe(3);
    expect(D.reviewView(s, task(s, ID)).state).toBe("limit");
    expect(prOf(s).attention).toMatchObject({ code: "review-limit" });
    expect(reviewTasks(D.requestPrReview(s, ID, at(20)))).toHaveLength(4);
  });

  it("a hold-mode pull request is ready only with green checks and a clean independent review; the user's own merge does not wait for the review", () => {
    const s = opened(D.advanceDelivery(built(prMode(), ID, HEAD, null), at(4)));
    expect(D.prReady(s, task(s, ID), ms(21))).toBe(false);
    expect(item(s, "review", 21, true)).toMatchObject({ ok: false, state: "waiting", advisory: true });
    expect(s.events.filter((e) => e.message.includes("is ready for you"))).toEqual([]);
    // The user can merge anyway: their Merge replaces the agent review, never GitHub's checks.
    const asked = D.requestPrMerge(s, ID, HEAD, at(21));
    expect(gate(asked, 21, true).status).toBe("ready");
    expect(D.nextPrOp(asked, ms(23))).toMatchObject({ kind: "merge" });
    // The review finishes clean between two reads of GitHub: ready, announced once.
    const done = D.advanceDelivery(runToDone(s, `${ID}-RV1`, 22), at(23));
    expect(D.prReady(done, task(done, ID), ms(24))).toBe(true);
    expect(D.advanceDelivery(done, at(25)).events.filter((e) => e.message.includes("is ready for you"))).toHaveLength(1);
  });
});

describe("the automatic gate: items 9 to 12 (design §9.5)", () => {
  it("ready only when the policy is auto, the review is clean for this exact change, the checks passed on this exact head, and nothing is paused", () => {
    const s = autoOpen();
    expect(prOf(s)).toMatchObject({ policy: "auto", policySource: "project" });
    expect(gate(s).items.map((i) => i.id)).toEqual(["policy", "not-paused", "github", "ours", "head", "checks", "mergeable", "no-stop", "review", "paths", "auto", "up-to-date", "attempts"]);
    expect(gate(s).items.filter((i) => !i.ok)).toEqual([]);
    expect(gate(s).status).toBe("ready");
    expect(D.mergeCandidate(s)?.id).toBe(ID);
    // The same pull request held by policy is never ready without the user.
    expect(gate(D.setPrPolicy(s, ID, "hold", at(21))).status).toBe("waiting");
    // Paused project, or a hold on this one: not ready, and not the candidate.
    expect(gate(M.pauseProject(s, at(21))).status).toBe("waiting");
    expect(D.mergeCandidate(M.pauseProject(s, at(21)))).toBeUndefined();
    expect(gate(D.holdPr(s, ID, undefined, at(21))).status).toBe("waiting");
    expect(D.mergeCandidate(D.holdPr(s, ID, undefined, at(21)))).toBeUndefined();
  });

  it("6 and 7 still bind: a required check that is failing, skipped, neutral, missing, running or for another commit; UNKNOWN; no required check", () => {
    for (const c of ["FAILURE", "SKIPPED", "NEUTRAL", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]) {
      const s = autoOpen({}, { checks: [check(c)] });
      expect(item(s, "checks"), c).toMatchObject({ state: "blocked", code: "checks-failed" });
      expect(gate(s).status, c).toBe("blocked");
    }
    expect(gate(autoOpen({}, { checks: [] })).status).toBe("waiting");
    expect(gate(autoOpen({}, { checks: [check(null)] })).status).toBe("waiting");
    expect(gate(autoOpen({}, { checksFor: SHA_B })).status).toBe("waiting"); // results for another commit
    expect(gate(autoOpen({}, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).status).toBe("waiting");
    expect(gate(autoOpen({}, { mergeStateStatus: "BEHIND" })).status).toBe("waiting"); // it is brought up to date, not merged
    const none = D.reportPreflight(autoOpen(), { ok: true, repo: "o/r", login: "me", requiredChecks: [], autoMergeBlockers: ["no required check"], posture: [] }, at(21));
    expect(D.prGate(none, task(none, ID), ms(22), { byUser: false }).status).toBe("blocked");
    expect(item(D.reportObservations(none, { prs: [observation({ checks: [] })], commits: [] }, at(22)), "checks", 23)).toMatchObject({ state: "blocked", code: "checks-missing" });
  });

  it("9: the review. Pending waits; open findings, a blocked review and the limit block; evidence for another change never passes", () => {
    const pending = opened(D.advanceDelivery(built(prMode("auto"), ID, HEAD, null), at(4)));
    expect(item(pending, "review")).toMatchObject({ ok: false, state: "waiting" });
    expect(gate(pending).status).toBe("waiting");
    expect(D.mergeCandidate(pending)).toBeUndefined();
    expect(D.nextPrOp(pending, ms(23))).toBeUndefined();
    const findings = autoOpen({ findings: 1 });
    expect(item(findings, "review")).toMatchObject({ state: "blocked", code: "review-findings" });
    const same = autoOpen({ writer: "codex", reviewer: "codex" });
    expect(item(same, "review").ok).toBe(false);
    // Mutation check (SHA binding): recorded evidence that names another change does not pass.
    const stale = structuredClone(autoOpen());
    prOf(stale).review.forSha = SHA_B;
    expect(item(stale, "review").ok).toBe(false);
    expect(gate(stale).status).toBe("waiting");
    expect(D.mergeCandidate(stale)).toBeUndefined();
    // …nor does evidence that was recorded as clean when the facts no longer say so.
    const lied = structuredClone(pending);
    prOf(lied).review = { ok: true, source: "pipeline", reason: "x", forSha: HEAD, artifactIds: [] };
    expect(item(lied, "review").ok).toBe(false);
  });

  it("10: protected paths and local workers turn automatic merging off for that pull request; the user can still merge", () => {
    const s = opened(built(prMode("auto"), ID, HEAD, {}, { protectedHits: ["package.json"], paths: ["package.json"] }));
    expect(item(s, "paths")).toMatchObject({ state: "blocked", code: "protected-path" });
    expect(prOf(s).attention).toMatchObject({ code: "protected-path" });
    expect(D.mergeCandidate(s)).toBeUndefined();
    expect(gate(D.requestPrMerge(s, ID, HEAD, at(21)), 21, true).status).toBe("ready");
    const local = M.setWorkerEnvironment(autoOpen(), "codex", "local", at(21));
    expect(item(local, "paths")).toMatchObject({ state: "blocked", code: "local-workers" });
    expect(item(D.setPrDelivery(local, { allowLocalWorkers: true }, at(22)), "paths").ok).toBe(true);
  });

  it("11: unavailable in the repository, paused, or past the daily cap", () => {
    const s = autoOpen();
    const blockers = D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", requiredChecks: ["check"], autoMergeBlockers: ["1 approving review(s) required"], posture: [] }, at(21));
    expect(item(blockers, "auto", 22)).toMatchObject({ state: "blocked", code: "auto-unavailable" });
    const paused = structuredClone(s);
    paused.project.github!.autoMergePaused = { since: at(20), reason: "the check on o/r main is failing after PR #9", sticky: false };
    expect(item(paused, "auto")).toMatchObject({ ok: false, state: "waiting" });
    expect(gate(paused).status).toBe("waiting");
    expect(D.nextPrOp(paused, ms(23))).toBeUndefined();
    const spent = structuredClone(s);
    spent.project.github!.autoMerges = { day: at(21).slice(0, 10), count: 20 };
    expect(item(spent, "auto")).toMatchObject({ state: "blocked", code: "limit" });
    spent.project.github!.autoMerges = { day: "2026-09-29", count: 20 }; // yesterday's count
    expect(item(spent, "auto").ok).toBe(true);
    expect(item(D.setPrDelivery(s, { maxAutoMergesPerDay: 0 }, at(21)), "auto")).toMatchObject({ state: "blocked", code: "limit" });
  });

  it("12: up to date. A moved base waits for the update, a stale fetch waits for a fresh one, three updates are the limit, a conflict blocks", () => {
    const s = autoOpen();
    const moved = D.reportBaseFetched(s, SHA_B, at(22));
    expect(item(moved, "up-to-date", 23)).toMatchObject({ ok: false, state: "waiting" });
    expect(gate(moved, 23).status).toBe("waiting");
    expect(item(s, "up-to-date", 2 + 121)).toMatchObject({ ok: false, state: "waiting" }); // fetched more than 2 minutes ago
    const limit = structuredClone(moved);
    prOf(limit).counters.baseUpdates = 3;
    expect(item(limit, "up-to-date", 23)).toMatchObject({ state: "blocked", code: "limit" });
    expect(D.nextPrOp(limit, ms(24))).toBeUndefined();
    const conflict = structuredClone(moved);
    prOf(conflict).baseConflict = { baseSha: SHA_B, headSha: HEAD, files: ["a.txt"] };
    expect(item(conflict, "up-to-date", 23)).toMatchObject({ state: "blocked", code: "conflict" });
    // Switched off: the repository's own rule decides.
    expect(item(D.setPrDelivery(moved, { updateBeforeMerge: false }, at(23)), "up-to-date", 24).ok).toBe(true);
  });

  it("a user merge skips items 9 to 12 and nothing else", () => {
    const s = D.requestPrMerge(opened(built(prMode("auto"), ID, HEAD, { findings: 3 }, { protectedHits: ["package.json"] })), ID, HEAD, at(21));
    expect(gate(s, 21, true).status).toBe("ready");
    expect(gate(s, 21, true).items.map((i) => i.id)).toEqual(["policy", "not-paused", "github", "ours", "head", "checks", "mergeable", "no-stop", "review", "attempts"]);
    // GitHub's side still binds the user.
    expect(gate(D.requestPrMerge(see(s, 22, { checks: [check("SKIPPED")] }), ID, HEAD, at(23)), 23, true).status).toBe("blocked");
  });
});

describe("the merge queue of one (design §6.4)", () => {
  const both = (s: State, second: number, a: Partial<D.PrObservation> = {}, b: Partial<D.PrObservation> = {}) =>
    D.reportObservations(s, { prs: [observation({ number: 12, headSha: HEAD, checksFor: HEAD, ...a }), observation({ number: 13, headSha: HEAD2, checksFor: HEAD2, url: "https://github.com/o/r/pull/13", ...b })], commits: [] }, at(second));

  /** Two pull requests, EX-006 older than EX-005, both reviewed, open and green. */
  function twoOpen(): State {
    let s = built(prMode("auto"), ID, HEAD);
    s = reviewedChange(s, "EX-005", HEAD2, at(2));
    Object.assign(task(s, "EX-005"), { lifecycle: "done", hold: false, integration: { status: "pending" } });
    s = D.reportPrHead(s, "EX-005", { n: 1, sha: HEAD2, baseSha: SHA_A, changed: CHANGED }, at(4));
    // EX-006 is opened first and its check is still running, so the second one is opened next.
    s = opened(s, ID, 12, 20, { checks: [check(null)] });
    const op = D.nextPrOp(s, ms(24))!;
    expect(op).toMatchObject({ kind: "publish", taskId: "EX-005" });
    s = D.reportPrOp(D.beginPrOp(s, op, at(24)).state, { op, published: { number: 13, url: "https://github.com/o/r/pull/13" } }, at(25));
    return both(s, 30);
  }

  it("only the oldest is the candidate; the other waits behind it and says so; a blocked candidate drops out so the next proceeds", () => {
    const s = twoOpen();
    expect(D.autoQueue(s).map((t) => t.id)).toEqual([ID, "EX-005"]);
    expect(D.mergeCandidate(s)!.id).toBe(ID);
    expect(D.queueAhead(s, task(s, "EX-005"))!.id).toBe(ID);
    const behind = D.prGate(s, task(s, "EX-005"), ms(31), { byUser: false });
    expect(behind.items.find((i) => i.id === "up-to-date")).toMatchObject({ ok: false, state: "waiting" });
    expect(behind.items.find((i) => i.id === "up-to-date")!.detail).toMatch(/^Waiting behind PR #12/);
    expect(D.prLabel(s, task(s, "EX-005"), ms(31))!.text).toBe("PR #13 queued behind #12");
    expect(D.nextPrOp(D.reportBaseFetched(s, SHA_A, at(32)), ms(33))).toMatchObject({ kind: "merge", taskId: ID, headSha: HEAD });
    // Only the candidate may be merged, even if another is planned by mistake (mutation check: the intent re-check).
    const wrong: D.PrOp = { id: "w", kind: "merge", taskId: "EX-005", n: 1, headSha: HEAD2 };
    expect(D.beginPrOp(s, wrong, at(33)).started).toBe(false);
    // The candidate's required check fails: it drops out, and the next one is merged.
    const red = both(s, 60, { checks: [check("FAILURE")] });
    expect(prOf(red).attention).toMatchObject({ code: "checks-failed" });
    expect(D.mergeCandidate(red)!.id).toBe("EX-005");
    expect(D.nextPrOp(D.reportBaseFetched(red, SHA_A, at(61)), ms(62))).toMatchObject({ kind: "merge", taskId: "EX-005" });
  });

  it("the merge is planned only on a fresh observation and a fresh base, records its intent first, and counts against the daily cap", () => {
    const s = autoOpen();
    expect(D.nextPrOp(s, ms(23))).toMatchObject({ kind: "merge", taskId: ID, n: 1, headSha: HEAD });
    expect(D.nextPrOp(s, ms(20 + 16))).toMatchObject({ kind: "observe" }); // GitHub is read again first
    const op = D.nextPrOp(s, ms(23))!;
    const begun = D.beginPrOp(s, op, at(23));
    expect(begun.started).toBe(true);
    expect(prOf(begun.state)).toMatchObject({ op: { kind: "merge", headSha: HEAD }, lastMergeIntent: { headSha: HEAD, auto: true } });
    expect(begun.state.project.github!.autoMerges).toEqual({ day: at(23).slice(0, 10), count: 1 });
    expect(prOf(begun.state).phase).toBe("open"); // nothing is "merged" from an intent
    // A hold or a pause that lands between planning and the intent stops it.
    expect(D.beginPrOp(D.holdPr(s, ID, undefined, at(22)), op, at(23)).started).toBe(false);
    expect(D.beginPrOp(M.pauseProject(s, at(22)), op, at(23)).started).toBe(false);
    expect(D.beginPrOp(D.setPrPolicy(s, ID, "hold", at(22)), op, at(23)).started).toBe(false);
    expect(D.beginPrOp(see(s, 22, { checks: [check(null)] }), op, at(23)).started).toBe(false);
    // Merged only from the observation, and attributed to the app's automatic merge.
    const merged = D.reportPrOp(begun.state, { op, observed: { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "me" })], commits: [] } }, at(24));
    expect(task(merged, ID).integration).toMatchObject({ pr: { phase: "merged" }, landed: { by: "app", commit: MERGE, flags: [], mainCheck: { state: "pending" }, review: { ok: true, forSha: HEAD } } });
    expect(merged.events.some((e) => e.message.includes("merged into main by Orchestrator, automatically"))).toBe(true);
    expect(D.mergeBody(begun.state, task(begun.state, ID))).toMatch(/^Merged automatically by Orchestrator/);
  });

  it("mutation check (stale base): after a merge, the next pull request does not merge until the base was fetched again and it was brought up to date", () => {
    const s = twoOpen();
    const op = D.nextPrOp(D.reportBaseFetched(s, SHA_A, at(32)), ms(33))!;
    const begun = D.beginPrOp(D.reportBaseFetched(s, SHA_A, at(32)), op, at(33)).state;
    // The first merged; the base the app fetched a moment ago no longer is the base.
    const merged = D.reportPrOp(begun, { op, observed: { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "me" })], commits: [] } }, at(34));
    const next = both(merged, 36);
    expect(D.mergeCandidate(next)!.id).toBe("EX-005");
    const g = D.prGate(next, task(next, "EX-005"), ms(37), { byUser: false });
    expect(g.status).toBe("waiting");
    expect(g.items.find((i) => i.id === "up-to-date")!.detail).toMatch(/changed after it was last fetched/);
    expect(D.nextPrOp(next, ms(37))).toMatchObject({ kind: "fetch" }); // not a merge
    expect(D.beginPrOp(next, { id: "m", kind: "merge", taskId: "EX-005", n: 1, headSha: HEAD2 }, at(37)).started).toBe(false);
    // Fetched: the base moved, so it is brought up to date first, never merged as it is.
    const fetched = D.reportBaseFetched(next, MERGE, at(38));
    expect(D.nextPrOp(fetched, ms(41))).toMatchObject({ kind: "update", taskId: "EX-005", baseSha: MERGE });
  });

  it("a project pause allows only reads, whatever is ready", () => {
    const s = M.pauseProject(autoOpen(), at(22));
    expect(D.nextPrOp(s, ms(23))).toBeUndefined();
    expect(D.nextPrOp(s, ms(20 + 301))).toMatchObject({ kind: "observe" });
    expect(D.nextPrOp(D.reportBaseFetched(s, SHA_B, at(23)), ms(24))).toBeUndefined(); // no base update either
  });
});

describe("the base update (design §8)", () => {
  it("the candidate, and only it, is brought up to date: built locally, pushed as a fast-forward, then re-checked; the review is not repeated", () => {
    const s = D.reportBaseFetched(autoOpen(), SHA_B, at(22));
    const op = D.nextPrOp(s, ms(24))!;
    expect(op).toEqual({ id: op.id, kind: "update", taskId: ID, n: 1, headSha: HEAD, baseSha: SHA_B });
    expect(D.opMutates(op)).toBe(false); // local: nothing is sent anywhere yet
    const UPDATE = "9".repeat(40);
    const updated = D.reportPrOp(s, { op, updated: { sha: UPDATE, baseSha: SHA_B } }, at(25));
    expect(prOf(updated)).toMatchObject({ headSha: HEAD, pendingHead: { sha: UPDATE, changeSha: HEAD, baseSha: SHA_B, kind: "update" }, counters: { baseUpdates: 1 } });
    expect(item(updated, "head", 26)).toMatchObject({ ok: false, state: "waiting" });
    expect(D.nextPrOp(updated, ms(27))).not.toMatchObject({ kind: "merge" });
    const push = D.nextPrOp(updated, ms(28))!;
    expect(push).toMatchObject({ kind: "push", taskId: ID, headSha: HEAD });
    expect(D.opMutates(push)).toBe(true);
    const begun = D.beginPrOp(updated, push, at(28));
    expect(begun.started).toBe(true);
    expect(prOf(begun.state).op).toMatchObject({ kind: "push" });
    // A push that reports another commit than the pending head records nothing.
    expect(prOf(D.reportPrOp(begun.state, { op: push, pushed: { sha: SHA_A } }, at(29))).headSha).toBe(HEAD);
    const pushed = D.reportPrOp(begun.state, { op: push, pushed: { sha: UPDATE } }, at(29));
    expect(prOf(pushed)).toMatchObject({ headSha: UPDATE, changeSha: HEAD, baseSha: SHA_B, counters: { mergeAttempts: 0 } });
    expect(prOf(pushed).pendingHead).toBeUndefined();
    expect(prOf(pushed).observed).toBeUndefined(); // what GitHub showed belonged to the old head
    // The reviewed change is unchanged, so the review still counts and no new one is started.
    expect(prOf(pushed).review).toMatchObject({ ok: true, forSha: HEAD });
    expect(reviewTasks(D.advanceDelivery(pushed, at(30)))).toEqual([]);
    // Check results for the old head are not results for the new one: no merge until they pass on it.
    const old = D.reportObservations(pushed, { prs: [observation({ headSha: UPDATE, checksFor: HEAD })], commits: [] }, at(31));
    expect(gate(old, 32).status).toBe("waiting");
    const running = D.reportObservations(pushed, { prs: [observation({ headSha: UPDATE, checksFor: UPDATE, checks: [check(null)] })], commits: [] }, at(31));
    expect(D.nextPrOp(D.reportBaseFetched(running, SHA_B, at(32)), ms(33))).toBeUndefined();
    const green = D.reportBaseFetched(D.reportObservations(pushed, { prs: [observation({ headSha: UPDATE, checksFor: UPDATE })], commits: [] }, at(31)), SHA_B, at(32));
    expect(D.nextPrOp(green, ms(33))).toMatchObject({ kind: "merge", headSha: UPDATE });
    expect(D.mergeBody(green, task(green, ID))).toMatch(/reviewed change cccccccccccc with main \(bbbbbbbbbbbb\) merged into it by Orchestrator/);
  });

  it("a stale update result changes nothing; a conflict is recorded for that base and head, blocks, and clears when the base moves again", () => {
    const s = D.reportBaseFetched(autoOpen(), SHA_B, at(22));
    const op = D.nextPrOp(s, ms(24))!;
    // The head moved meanwhile: the result is for another head.
    const moved = structuredClone(s);
    prOf(moved).headSha = HEAD2;
    expect(D.reportPrOp(moved, { op, updated: { sha: "9".repeat(40), baseSha: SHA_B } }, at(25))).toBe(moved);
    const conflict = D.reportPrOp(s, { op, conflict: { files: ["a.txt", "b.txt"] } }, at(25));
    expect(prOf(conflict).baseConflict).toEqual({ baseSha: SHA_B, headSha: HEAD, files: ["a.txt", "b.txt"] });
    expect(prOf(conflict).pendingHead).toBeUndefined();
    expect(prOf(conflict).attention).toMatchObject({ code: "conflict" });
    expect(D.mergeCandidate(conflict)).toBeUndefined();
    expect(D.nextPrOp(conflict, ms(27))).toBeUndefined(); // not tried again for the same base
    expect(D.repairCause(conflict, task(conflict, ID))).toEqual({ kind: "conflict", files: ["a.txt", "b.txt"] });
  });

  it("a held pull request is never updated by the app", () => {
    const s = D.reportBaseFetched(opened(built(prMode("hold"))), SHA_B, at(22));
    expect(D.nextPrOp(s, ms(24))).toBeUndefined();
    expect(item(opened(built(prMode("hold")), ID, 12, 20, { mergeStateStatus: "BEHIND" }), "mergeable", 21, true)).toMatchObject({ state: "blocked", code: "github-blocked" });
  });
});

describe("repair into the open pull request (design §9.3)", () => {
  const red = () => autoOpen({}, { checks: [{ ...check("FAILURE"), url: "https://github.com/o/r/actions/runs/1" }] });

  it("a failed required check in automatic mode creates one fix task for the same pull request, with names and links only", () => {
    const s = D.advanceDelivery(red(), at(22));
    const [fix] = repairTasks(s);
    expect(repairTasks(s)).toHaveLength(1);
    expect(fix).toMatchObject({ id: `${ID}-F1`, holdBeforeStart: false, dependsOn: [], deliverInto: { taskId: ID, n: 1, mergeBase: false }, followUpOf: ID });
    expect(fix.specs[0].author).toBe("system");
    expect(fix.steps.map((x) => x.id)).toEqual(templateSteps("change").map((x) => x.id));
    expect(M.currentSpec(fix).content.scopeIncluded).toEqual(['Make the required check "check" pass (https://github.com/o/r/actions/runs/1). Find the cause in the code; do not weaken tests, CI or build scripts.']);
    expect(prOf(s)).toMatchObject({ repairTaskIds: [fix.id], counters: { repairs: 1 }, attention: { code: "checks-failed" } });
    expect(prOf(s).attention!.message).toMatch(/EX-006-F1 is fixing it/);
    expect(D.openRepair(s, prOf(s))!.id).toBe(fix.id);
    expect(D.needsYou(s, ms(23))).toBe(0); // the app is fixing it: it does not wait for the user
    expect(D.prLabel(s, task(s, ID), ms(23))!.text).toBe("PR #12 being fixed");
    // One at a time, however often the cycle runs.
    expect(repairTasks(D.advanceDelivery(D.advanceDelivery(s, at(23)), at(24)))).toHaveLength(1);
    // It is never counted as the lead's proposal.
    const lead = structuredClone(s);
    task(lead, fix.id).specs[0].author = "lead";
    expect(M.openLeadProposals(lead).map((t) => t.id)).not.toContain(fix.id);
  });

  it("not automatic in hold mode, with automatic repair off, or while paused; the Fix this PR button does the same thing on request", () => {
    const hold = D.advanceDelivery(opened(built(prMode("hold")), ID, 12, 20, { checks: [check("FAILURE")] }), at(22));
    expect(repairTasks(hold)).toEqual([]);
    expect(prOf(hold).attention).toMatchObject({ code: "checks-failed" });
    expect(D.needsYou(hold, ms(23))).toBe(1);
    expect(repairTasks(D.advanceDelivery(D.setPrDelivery(red(), { autoRepair: false }, at(21)), at(22)))).toEqual([]);
    expect(repairTasks(D.advanceDelivery(M.pauseProject(red(), at(21)), at(22)))).toEqual([]);
    expect(() => D.createRepair(hold, ID, { kind: "checks", checks: [{ name: "check" }] }, at(23))).toThrow(/only for pull requests that merge automatically/);
    const r = runCommand(hold, "repairPr", { taskId: ID }, at(23));
    expect(r.result).toEqual({ newId: `${ID}-F1` });
    expect(task(r.state, `${ID}-F1`).specs[0].author).toBe("user");
    expect(() => D.repairPr(r.state, ID, at(24))).toThrow(/already fixing/);
    expect(() => D.repairPr(opened(built(prMode("hold"))), ID, at(23))).toThrow(/Nothing a fix task could cure/);
  });

  it("the fix is pushed onto the same pull request as a fast-forward; the change under review moves to it and older reviews are cancelled", () => {
    let s = D.advanceDelivery(red(), at(22));
    const fix = `${ID}-F1`;
    // A dedicated review of the old change is still running when the fix arrives.
    s = D.requestPrReview(s, ID, at(23));
    const oldReview = reviewTasks(s)[0].id;
    // The fix task's own pipeline wrote on Codex and reviewed on Claude.
    s = reviewedChange(s, fix, HEAD2, at(30));
    task(s, fix).lifecycle = "done";
    task(s, fix).integration = { status: "pending" };
    expect(D.repairTarget(s, task(s, fix))!.task.id).toBe(ID);
    // A fix that does not descend from the head is stale and is not delivered.
    const stale = D.reportRepairHead(s, fix, { n: 1, sha: HEAD2, baseSha: SHA_A, changed: CHANGED, descends: false }, at(31));
    expect(task(stale, fix).integration).toMatchObject({ status: "not-needed" });
    expect(prOf(stale).pendingHead).toBeUndefined();
    const ready = D.reportRepairHead(s, fix, { n: 1, sha: HEAD2, baseSha: SHA_A, changed: CHANGED, descends: true }, at(31));
    expect(prOf(ready).pendingHead).toEqual({ sha: HEAD2, changeSha: HEAD2, changeTaskId: fix, changeAuthor: "codex", changeAuthors: ["codex"], baseSha: SHA_A, kind: "repair" });
    expect(task(ready, fix).integration).toMatchObject({ status: "integrated", sha: HEAD2 });
    expect(task(ready, fix).integration!.pr).toBeUndefined(); // it opens no pull request of its own
    expect(D.deliveredInto(task(ready, fix))).toBe(true);
    expect(D.redeliverable(ready).map((t) => t.id)).not.toContain(fix);
    expect(D.undeliveredTasks(ready).map((t) => t.id)).not.toContain(fix);
    const push = D.nextPrOp(ready, ms(33))!;
    expect(push).toMatchObject({ kind: "push", taskId: ID, headSha: HEAD });
    const begun = D.beginPrOp(ready, push, at(33)).state;
    const pushed = D.reportPrOp(begun, { op: push, pushed: { sha: HEAD2 } }, at(34));
    expect(prOf(pushed)).toMatchObject({ headSha: HEAD2, changeSha: HEAD2, changeTaskId: fix, changeAuthor: "codex", number: 12 });
    // Coverage is re-evaluated against the fix task's own review, which saw the new change.
    expect(prOf(pushed).review).toMatchObject({ ok: true, source: "pipeline", taskId: fix, forSha: HEAD2 });
    // The review of the old change is cancelled: a late completion is stopped and can never count.
    expect(task(pushed, oldReview).lifecycle).toBe("cancelled");
    expect(pushed.events.some((e) => e.taskId === oldReview && e.actor === "system" && e.message.includes("holds a newer change"))).toBe(true);
    // A Merge click made for the old head is void once the head moves, and cannot be made while a fix waits.
    const asked = D.reportRepairHead(D.requestPrMerge(D.setPrPolicy(s, ID, "hold", at(30)), ID, HEAD, at(30)), fix, { n: 1, sha: HEAD2, baseSha: SHA_A, changed: CHANGED, descends: true }, at(31));
    expect(prOf(asked).mergeRequested).toMatchObject({ headSha: HEAD });
    expect(() => D.requestPrMerge(D.setPrPolicy(ready, ID, "hold", at(32)), ID, HEAD, at(32))).toThrow(/changed since you looked/);
    const clicked = D.reportPrOp(D.beginPrOp(asked, push, at(33)).state, { op: push, pushed: { sha: HEAD2 } }, at(34));
    expect(prOf(clicked).mergeRequested).toBeUndefined();
  });

  it("a fix that touches CI workflow files is not pushed until the user allows it again", () => {
    let s = D.advanceDelivery(red(), at(22));
    const fix = `${ID}-F1`;
    s = reviewedChange(s, fix, HEAD2, at(30));
    task(s, fix).lifecycle = "done";
    task(s, fix).integration = { status: "pending" };
    prOf(s).workflowPushAllowed = true; // an earlier permission, for the earlier head
    const ready = D.reportRepairHead(s, fix, { n: 1, sha: HEAD2, baseSha: SHA_A, changed: { ...CHANGED, workflowHits: [".github/workflows/ci.yml"], protectedHits: [".github/workflows/ci.yml"] }, descends: true }, at(31));
    expect(prOf(ready).workflowPushAllowed).toBeUndefined();
    expect(prOf(ready).attention).toMatchObject({ code: "workflow-change" });
    expect(D.nextPrOp(ready, ms(33))).toBeUndefined();
    expect(D.beginPrOp(ready, { id: "p", kind: "push", taskId: ID, n: 1, headSha: HEAD }, at(33)).started).toBe(false);
    expect(D.nextPrOp(D.allowWorkflowPush(ready, ID, at(34)), ms(35))).toMatchObject({ kind: "push" });
  });

  it("bounded: two fix tasks per pull request, then the user; open findings and conflicts are causes too", () => {
    let s = D.advanceDelivery(red(), at(22));
    s = D.advanceDelivery(M.cancelTask(s, `${ID}-F1`, at(23)), at(24));
    expect(repairTasks(s).map((t) => t.id)).toEqual([`${ID}-F1`, `${ID}-F2`]);
    s = D.advanceDelivery(M.cancelTask(s, `${ID}-F2`, at(25)), at(26));
    expect(repairTasks(s)).toHaveLength(2); // no third
    expect(prOf(s).counters.repairs).toBe(2);
    expect(prOf(s).attention!.message).toMatch(/2 fix tasks already ran, so it needs you/);
    expect(D.needsYou(s, ms(27))).toBe(1);
    expect(() => D.repairPr(s, ID, at(27))).toThrow(/2 fix tasks already ran/);
    // Findings: the summaries seed the specification.
    const findings = D.advanceDelivery(autoOpen({ findings: 2 }), at(22));
    expect(repairTasks(findings)).toHaveLength(1);
    expect(M.currentSpec(repairTasks(findings)[0]).content.scopeIncluded).toEqual(["Open review finding: a finding that must be fixed"]);
    expect(reviewTasks(findings)).toEqual([]);
    // Conflict: the fix starts with the merge of the base prepared.
    const conflict = D.advanceDelivery(autoOpen({}, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), at(22));
    expect(repairTasks(conflict)[0].deliverInto).toEqual({ taskId: ID, n: 1, mergeBase: true });
  });

  it("when the pull request merges, closes or is pushed to by someone else, its open review and fix tasks are cancelled", () => {
    const s = D.requestPrReview(D.advanceDelivery(red(), at(22)), ID, at(23));
    const open = (x: State) => x.tasks.filter((t) => (t.reviewTarget?.taskId === ID || t.deliverInto?.taskId === ID) && t.lifecycle !== "cancelled").map((t) => t.id);
    expect(open(s)).toEqual([`${ID}-F1`, `${ID}-RV1`]);
    expect(open(see(s, 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" }))).toEqual([]);
    expect(open(see(s, 30, { state: "CLOSED", closedBy: "octocat" }))).toEqual([]);
    const foreign = see(s, 30, { headSha: SHA_B, checksFor: SHA_B });
    expect(prOf(foreign).foreignHead).toMatchObject({ sha: SHA_B });
    expect(open(foreign)).toEqual([]);
    expect(repairTasks(D.advanceDelivery(foreign, at(31))).filter((t) => t.lifecycle !== "cancelled")).toEqual([]); // and none is started again
  });
});

describe("main is red: the pause and the breaker (design §9.6)", () => {
  /** PR #12 merged automatically by the app; its commit on the base is still being checked. */
  function landedByApp(): State {
    const s = autoOpen();
    const op = D.nextPrOp(s, ms(23))!;
    return D.reportPrOp(D.beginPrOp(s, op, at(23)).state, { op, observed: { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "me" })], commits: [] } }, at(24));
  }
  const mainCheck = (s: State, second: number, conclusion: string | null, oid = MERGE) => D.reportObservations(s, { prs: [], commits: [{ oid, checks: [check(conclusion)] }] }, at(second));

  it("one failure after a merge the app made pauses automatic merging, flags the item, and clears when the check passes again", () => {
    const red = mainCheck(landedByApp(), 90, "FAILURE");
    expect(task(red, ID).integration!.landed).toMatchObject({ mainCheck: { state: "failure" }, flags: ["main-check-failed"] });
    expect(red.project.github).toMatchObject({ autoMergePaused: { since: at(90), sticky: false, taskId: ID }, mainBreaks: [at(90)] });
    expect(red.project.github!.autoMergePaused!.reason).toBe("the check on o/r main is failing after PR #12");
    expect(D.needsYou(red, ms(91))).toBe(2); // the flagged item and the pause
    expect(red.events.filter((e) => e.message.startsWith("Automatic merging is paused"))).toHaveLength(1);
    // The failing commit is still watched, and nothing merges meanwhile.
    expect(D.nextPrOp(D.reportBaseFetched(red, MERGE, at(149)), ms(151))).toMatchObject({ kind: "observe", commits: [MERGE] });
    // A re-run passes: the pause ends by itself. The flag stays: it did fail.
    const green = mainCheck(red, 200, "SUCCESS");
    expect(green.project.github!.autoMergePaused).toBeUndefined();
    expect(task(green, ID).integration!.landed).toMatchObject({ mainCheck: { state: "success" }, flags: ["main-check-failed"] });
    expect(green.events.some((e) => e.message.startsWith("Automatic merging resumed"))).toBe(true);
    // A failure after a merge a person made pauses nothing.
    const person = see(autoOpen(), 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" });
    expect(mainCheck(person, 90, "FAILURE").project.github!.autoMergePaused).toBeUndefined();
  });

  it("two failures within a day keep it paused until the user resumes it; nothing is reverted", () => {
    let s = mainCheck(landedByApp(), 90, "FAILURE");
    s = D.resumeAutoMerge(mainCheck(s, 200, "SUCCESS"), at(201));
    expect(s.project.github!.mainBreaks).toBeUndefined(); // resuming clears the day's count
    // Without a resume in between, the count of the day stands.
    let twice = mainCheck(landedByApp(), 90, "FAILURE");
    twice = mainCheck(twice, 200, "SUCCESS");
    expect(twice.project.github).toMatchObject({ mainBreaks: [at(90)] });
    expect(twice.project.github!.autoMergePaused).toBeUndefined();
    // A second pull request lands by the app and breaks the base again.
    const second = structuredClone(twice);
    const t = task(second, "EX-005");
    t.lifecycle = "done";
    t.integration = { status: "integrated", at: at(300), landed: { at: at(300), via: "pr", target: "o/r main", commit: SHA_B, by: "app", pr: { number: 13, url: "https://github.com/o/r/pull/13", repo: "o/r" }, mainCheck: { state: "pending", at: at(300) }, flags: [], status: "unreviewed", notes: [], followUps: [] } };
    const sticky = mainCheck(second, 400, "FAILURE", SHA_B);
    expect(sticky.project.github).toMatchObject({ autoMergePaused: { sticky: true, taskId: "EX-005" }, mainBreaks: [at(90), at(400)] });
    // Green does not clear a sticky pause; only the user does.
    expect(mainCheck(sticky, 500, "SUCCESS", SHA_B).project.github!.autoMergePaused).toMatchObject({ sticky: true });
    const resumed = runCommand(sticky, "resumeAutoMerge", {}, at(600)).state;
    expect(resumed.project.github!.autoMergePaused).toBeUndefined();
    expect(resumed.project.github!.mainBreaks).toBeUndefined();
    expect(resumed.tasks.some((x) => x.revertOf)).toBe(false); // no automatic revert
    // A break more than a day old does not count.
    const old = structuredClone(twice);
    old.project.github!.mainBreaks = [at(-25 * 3600)];
    const later = structuredClone(old);
    Object.assign(task(later, "EX-005"), { lifecycle: "done", integration: t.integration });
    expect(mainCheck(later, 400, "FAILURE", SHA_B).project.github!.autoMergePaused).toMatchObject({ sticky: false });
  });
});

describe("the lead and delivery (design §11)", () => {
  it("a new attention for a failed check, findings, a conflict or a foreign push, a close by a person, a failed base check, or a new note wakes the lead", () => {
    const base = autoOpen();
    const since = at(21);
    expect(M.deliveryNews(base, since)).toBe(false);
    expect(M.deliveryNews(see(base, 30, { checks: [check("FAILURE")] }), since)).toBe(true);
    expect(M.deliveryNews(see(base, 30, { headSha: SHA_B }), since)).toBe(true); // foreign push
    expect(M.deliveryNews(see(base, 30, { isDraft: true }), since)).toBe(false); // needs the user, not the lead
    expect(M.deliveryNews(see(base, 30, { state: "CLOSED", closedBy: "octocat" }), since)).toBe(true);
    // A close the user asked the app for is not news.
    const asked = see(D.closePr(base, ID, at(25)), 30, { state: "CLOSED", closedBy: "me" });
    expect(prOf(asked)).toMatchObject({ phase: "closed", closedByRequest: true });
    expect(M.deliveryNews(asked, since)).toBe(false);
    const merged = see(base, 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" });
    expect(M.deliveryNews(merged, at(30))).toBe(false);
    expect(M.deliveryNews(D.reportObservations(merged, { prs: [], commits: [{ oid: MERGE, checks: [check("FAILURE")] }] }, at(90)), at(30))).toBe(true);
    expect(M.deliveryNews(D.addLandedNote(merged, ID, "look at this", false, at(95)), at(30))).toBe(true);
    // It wakes planning under the existing caps: autonomy on, and not before the wake gap.
    let s = see(base, 30, { checks: [check("FAILURE")] });
    s = M.setAutonomy(s, { ...s.project.autonomy, enabled: true, planningIntervalMinutes: 60, maxOpenProposals: 50 }, at(31));
    s.project.lastPlanningAt = at(21);
    expect(M.leadDue(s, ms(21 + 14 * 60), 12 * 60)).toBeNull();
    expect(M.leadDue(s, ms(21 + 16 * 60), 12 * 60)).toBe("planning");
    expect(M.leadDue(M.setAutonomy(s, { ...s.project.autonomy, enabled: false }, at(32)), ms(21 + 16 * 60), 12 * 60)).toBeNull();
  });
});

describe("settings and policy", () => {
  it("automatic merging is an explicit choice, applies to pull requests that follow the project, and never comes from a preset", () => {
    const s = opened(built(prMode("hold")));
    expect(prOf(s)).toMatchObject({ policy: "hold", policySource: "project" });
    const auto = D.setPrDelivery(s, { merge: "auto" }, at(22));
    expect(prOf(auto)).toMatchObject({ policy: "auto", policySource: "project" });
    expect(auto.events.at(-1)!.message).toMatch(/merge automatically after an independent review \(another provider than the writer\)/);
    // One the user set by hand keeps its own policy.
    const held = D.setPrDelivery(D.setPrPolicy(s, ID, "hold", at(21)), { merge: "auto" }, at(22));
    expect(prOf(held)).toMatchObject({ policy: "hold", policySource: "user" });
    expect(prOf(D.setPrPolicy(held, ID, null, at(23)))).toMatchObject({ policy: "auto", policySource: "project" });
    expect(prOf(D.setPrPolicy(s, ID, "auto", at(21)))).toMatchObject({ policy: "auto", policySource: "user" });
    // Presets and the delivery-mode switch never choose it.
    expect(M.applyAutopilot(s, "main", at(22)).project.prDelivery.merge).toBe("hold");
    expect(D.setDeliveryMode(D.setDeliveryMode(s, { mode: "off" }, at(22)), { mode: "pr" }, at(23)).project.prDelivery.merge).toBe("hold");
    // A Merge click does not survive the switch to automatic: the automatic gate decides from then on.
    expect(prOf(D.setPrPolicy(D.requestPrMerge(s, ID, HEAD, at(21)), ID, "auto", at(22))).mergeRequested).toBeUndefined();
  });
});

// ====================================================================================================
// Step 2 review findings that live in the domain
// ====================================================================================================

describe("step 2 review: H2, another repository", () => {
  it("after the remote names another repository, the app plans nothing for the old pull request and says why", () => {
    const s0 = D.requestPrMerge(opened(built(prMode("hold"))), ID, HEAD, at(21));
    expect(D.nextPrOp(s0, ms(23))).toMatchObject({ kind: "merge" });
    // The remote now points at o/other: the same number there is someone else's pull request.
    const s = D.reportBaseFetched(D.reportPreflight(s0, { ok: true, repo: "o/other", login: "me", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(22)), SHA_A, at(22));
    const moved = D.advanceDelivery(s, at(23));
    expect(prOf(moved).repo).toBe("o/r");
    expect(prOf(moved).attention).toMatchObject({ code: "repo-changed" });
    expect(item(moved, "github", 24, true)).toMatchObject({ state: "blocked", code: "repo-changed" });
    for (const second of [24, 60, 200, 400]) expect(D.nextPrOp(D.reportBaseFetched(moved, SHA_A, at(second - 1)), ms(second)), String(second)).toBeUndefined();
    for (const kind of ["merge", "close", "push"] as const) expect(D.beginPrOp(moved, { id: "x", kind, taskId: ID, n: 1, headSha: HEAD }, at(24)).started, kind).toBe(false);
    expect(() => D.requestPrMerge(D.setPrPolicy(moved, ID, "auto", at(24)), ID, HEAD, at(25))).toThrow(/does not merge it there/);
    // An observation of the other repository's #12 is never applied to this pull request.
    const foreign = D.reportObservations(moved, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "stranger" })], commits: [] }, at(30), { repo: "o/other" });
    expect(prOf(foreign).phase).toBe("open");
    expect(task(foreign, ID).integration!.landed).toBeUndefined();
    // Closing it here sends nothing there.
    const closed = D.closePr(moved, ID, at(31));
    expect(prOf(closed)).toMatchObject({ phase: "closed" });
    expect(prOf(closed).closeRequested).toBeUndefined();
    // Pointing the remote back makes it the app's pull request again.
    const back = D.advanceDelivery(D.reportPreflight(moved, { ok: true, repo: "o/r", login: "me", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(40)), at(41));
    expect(prOf(back).attention).toBeUndefined();
  });

  it("the repository is kept on the landed item; a note is posted only there", () => {
    const merged = see(opened(built(prMode("hold"))), 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" });
    expect(task(merged, ID).integration!.landed!.pr).toEqual({ number: 12, url: "https://github.com/o/r/pull/12", repo: "o/r" });
    expect(D.landedRepo(task(merged, ID))).toBe("o/r");
    const noted = D.addLandedNote(merged, ID, "please look", true, at(31));
    const moved = D.reportPreflight(noted, { ok: true, repo: "o/other", login: "me", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(32));
    expect(D.nextPrOp(D.reportBaseFetched(moved, SHA_A, at(99)), ms(100))).not.toMatchObject({ kind: "comment" });
    expect(() => D.addLandedNote(moved, ID, "again", true, at(33))).toThrow(/does not post there/);
  });
});

describe("step 2 review: M1, merge queues and merge commits", () => {
  it("a repository with a merge queue, or without merge commits, blocks the user's merge and the automatic one alike", () => {
    for (const facts of [{ mergeQueue: true }, { mergeCommitsAllowed: false }]) {
      const report = { ok: true, repo: "o/r", login: "me", requiredChecks: ["check"], autoMergeBlockers: [], posture: [], ...facts };
      const user = D.reportPreflight(D.requestPrMerge(opened(built(prMode("hold"))), ID, HEAD, at(21)), report, at(22));
      expect(item(user, "github", 23, true), JSON.stringify(facts)).toMatchObject({ state: "blocked", code: "github-blocked" });
      expect(gate(user, 23, true).status).toBe("blocked");
      expect(D.nextPrOp(user, ms(24))).toBeUndefined();
      expect(D.beginPrOp(user, { id: "m", kind: "merge", taskId: ID, n: 1, headSha: HEAD }, at(24)).started).toBe(false);
      const auto = D.reportPreflight(autoOpen(), report, at(22));
      expect(gate(auto, 23).status).toBe("blocked");
      expect(D.nextPrOp(auto, ms(24))).toBeUndefined();
    }
    // The facts are cleared when a later check no longer reports them.
    const gone = D.reportPreflight(D.reportPreflight(autoOpen(), { ok: true, repo: "o/r", requiredChecks: ["check"], autoMergeBlockers: [], posture: [], mergeQueue: true }, at(22)), { ok: true, repo: "o/r", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(23));
    expect(gone.project.github!.mergeQueue).toBeUndefined();
  });
});

describe("step 2 review: M2, a fetch that keeps failing", () => {
  it("is counted and backed off on its own; a passing repository check does not reset it; it is announced once", () => {
    let s = prMode();
    const fetch: D.PrOp = { id: "f", kind: "fetch" };
    s = D.reportPrOp(s, { op: fetch, error: { code: "unknown", message: "fatal: bad object" } }, at(100));
    expect(s.project.github).toMatchObject({ ok: false, fetchFailures: { count: 1, since: at(100), nextAt: at(160) }, problem: { code: "network", since: at(100) } });
    expect(D.nextPrOp(s, ms(159))).toBeUndefined();
    expect(D.nextPrOp(s, ms(161))).toMatchObject({ kind: "fetch" }); // the fetch itself is what is tried again
    // The user asks for a check; it passes. The fetch failure is still there, and the fetch is tried at once.
    const checked = D.reportPreflight(D.recheckGitHub(s, at(110)), { ok: true, repo: "o/r", login: "me", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(111));
    expect(checked.project.github).toMatchObject({ ok: false, fetchFailures: { count: 1 }, problem: { since: at(100) } });
    expect(D.nextPrOp(checked, ms(112))).toMatchObject({ kind: "fetch" });
    // It fails again, and again: the wait grows, the problem keeps its start, and there is one event.
    s = D.reportPrOp(s, { op: fetch, error: { code: "unknown", message: "fatal: bad object" } }, at(161));
    expect(s.project.github).toMatchObject({ fetchFailures: { count: 2, since: at(100), nextAt: at(161 + 120) }, problem: { since: at(100) } });
    s = D.reportPrOp(s, { op: fetch, error: { code: "unknown", message: "fatal: bad object" } }, at(300));
    expect(s.project.github!.fetchFailures).toMatchObject({ count: 3, nextAt: at(300 + 300) });
    expect(s.events.filter((e) => e.message.startsWith("GitHub delivery stopped"))).toHaveLength(1);
    expect(s.project.github!.problem!.message).not.toMatch(/gh auth login/);
    // A fetch that works ends it.
    const ok = D.reportBaseFetched(s, SHA_B, at(700));
    expect(ok.project.github).toMatchObject({ ok: true, base: { sha: SHA_B } });
    expect(ok.project.github!.fetchFailures).toBeUndefined();
    expect(ok.project.github!.problem).toBeUndefined();
  });

  it("git's own sign-in failing is not reported as a gh sign-in problem", () => {
    const s = D.reportPrOp(prMode(), { op: { id: "f", kind: "fetch" }, error: { code: "git", message: "git could not sign in to the remote: Permission denied (publickey). This is git's own sign-in for this remote (an SSH key or a credential helper), not gh's." } }, at(100));
    expect(s.project.github!.problem).toMatchObject({ code: "remote" });
    expect(s.project.github!.problem!.message).not.toMatch(/gh auth login/);
    expect(s.project.github!.problem!.message).toMatch(/not gh's/);
    // A real gh sign-in problem still says so.
    const auth = D.reportPrOp(opened(built(prMode())), { op: { id: "o", kind: "observe", prs: [], commits: [] }, error: { code: "auth", message: "HTTP 401" } }, at(100));
    expect(auth.project.github!.problem!.message).toMatch(/gh auth login/);
  });
});

describe("step 2 review: M3, merge attempts", () => {
  function sent(): { state: State; op: D.PrOp } {
    const s = D.requestPrMerge(opened(built(prMode("hold"))), ID, HEAD, at(21));
    const op = D.nextPrOp(s, ms(23))!;
    return { state: D.beginPrOp(s, op, at(23)).state, op };
  }
  const after = (code: D.OpErrorCode, from = sent()) => D.reportPrOp(from.state, { op: from.op, actError: { code, message: `gh: ${code}` }, observed: { prs: [observation()], commits: [] } }, at(24));

  it("only a refusal counts; a network, rate-limit or sign-in failure does not and is tried again", () => {
    expect(prOf(after("rejected")).counters.mergeAttempts).toBe(1);
    expect(prOf(after("head-mismatch")).counters.mergeAttempts).toBe(1);
    for (const code of ["rate-limit", "auth", "not-found"] as const) {
      const s = after(code);
      expect(prOf(s).counters.mergeAttempts, code).toBe(0);
      expect(prOf(s).op, code).toBeUndefined();
      expect(prOf(s).mergeRequested, code).toBeDefined();
    }
    // The outcome of a network failure or a timeout is unknown: the intent stays until the grace time.
    for (const code of ["network", "timeout", "unknown"] as const) {
      const s = after(code);
      expect(prOf(s).counters.mergeAttempts, code).toBe(0);
      expect(prOf(s).op, code).toMatchObject({ kind: "merge" });
      expect(D.prIntentLine(prOf(s)), code).toMatch(/^Merging PR #12 \(already sent to GitHub/);
    }
  });

  it("two refusals spend the request; a new, deliberate Merge starts the count over", () => {
    let s = after("rejected");
    expect(D.prIntentLine(prOf(s))).toMatch(/GitHub refused 1 of 2 attempts \(gh: rejected\); it is tried once more\./);
    const op = D.nextPrOp(D.reportObservations(s, { prs: [observation()], commits: [] }, at(24 + 61)), ms(24 + 62))!;
    expect(op).toMatchObject({ kind: "merge" });
    const state = D.beginPrOp(D.reportObservations(s, { prs: [observation()], commits: [] }, at(24 + 61)), op, at(24 + 62)).state;
    s = D.reportPrOp(state, { op, actError: { code: "rejected", message: "gh: rejected" }, observed: { prs: [observation()], commits: [] } }, at(24 + 63));
    expect(prOf(s)).toMatchObject({ counters: { mergeAttempts: 2 }, attention: { code: "merge-rejected" } });
    expect(prOf(s).mergeRequested).toBeUndefined(); // the spent request is withdrawn
    expect(D.nextPrOp(fresh(D.reportObservations(s, { prs: [observation()], commits: [] }, at(1000)), 1001), ms(1001))).toBeUndefined();
    const again = D.requestPrMerge(s, ID, HEAD, at(1002));
    expect(prOf(again)).toMatchObject({ counters: { mergeAttempts: 0 }, mergeRequested: { headSha: HEAD } });
    expect(prOf(again).attention).toBeUndefined();
  });
});

describe("step 2 review: M4, notes that cannot be posted", () => {
  it("a note is never left waiting for a post that will not happen", () => {
    const merged = see(opened(built(prMode("hold"))), 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" });
    expect(D.cannotPostNote(merged, task(merged, ID))).toBeUndefined();
    const off = D.setDeliveryMode(merged, { mode: "off" }, at(31));
    expect(D.cannotPostNote(off, task(off, ID))).toMatch(/Pull-request delivery is off/);
    expect(() => D.addLandedNote(off, ID, "post me", true, at(32))).toThrow(/Pull-request delivery is off/);
    expect(() => runCommand(off, "addLandedNote", { taskId: ID, text: "post me", postToGitHub: true }, at(32))).toThrow(/Pull-request delivery is off/);
    // Without posting it is just a note.
    expect(task(D.addLandedNote(off, ID, "keep me", false, at(32)), ID).integration!.landed!.notes.at(-1)).toMatchObject({ text: "keep me" });
    expect(task(D.addLandedNote(off, ID, "keep me", false, at(32)), ID).integration!.landed!.notes.at(-1)!.comment).toBeUndefined();
  });
});

describe("step 2 review: low findings", () => {
  it("L4: publishing is bounded; after six failures it waits for the user, and a release tries again", () => {
    let s = built(prMode("hold"));
    for (let k = 0; k < 6; k++) {
      const second = 10 + k * 1000;
      const op = D.nextPrOp(D.reportBaseFetched(s, SHA_A, at(second - 1)), ms(second))!;
      expect(op, String(k)).toMatchObject({ kind: "publish" });
      s = D.reportPrOp(D.beginPrOp(D.reportBaseFetched(s, SHA_A, at(second - 1)), op, at(second)).state, { op, error: { code: "unknown", message: "gh pr create failed" } }, at(second + 1));
    }
    expect(prOf(s)).toMatchObject({ counters: { failures: 6 }, attention: { code: "publish-failed" } });
    expect(D.nextPrOp(fresh(s, 9000), ms(9000))).toBeUndefined();
    const released = D.releasePr(D.holdPr(s, ID, undefined, at(9001)), ID, at(9002));
    expect(prOf(released)).toMatchObject({ counters: { failures: 0 } });
    expect(prOf(released).attention).toBeUndefined();
    expect(D.nextPrOp(fresh(released, 9010), ms(9010))).toMatchObject({ kind: "publish" });
  });

  it("L7: a revert in pull-request mode waits for a fetch of the base made after the work landed and after it was asked for", () => {
    const merged = see(opened(built(prMode("hold"))), 30, { state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" });
    const r = D.sendBackLanded(merged, { taskId: ID, kind: "revert", note: "", holdBeforeStart: false }, at(40));
    const revert = task(r.state, r.newId);
    expect(D.revertWaitsForBase(r.state, revert)).toBe(true); // the base was fetched before the merge
    const held = M.dispatchEligible(M.leadPromoteProposals(r.state, at(41)), at(41), { staleBase: (t) => D.revertWaitsForBase(r.state, t) });
    expect(M.activeAttempts(held, r.newId)).toEqual([]);
    expect(D.nextPrOp(r.state, ms(42))).toMatchObject({ kind: "fetch" }); // and the fetch is what happens next
    const fetched = D.reportBaseFetched(r.state, MERGE, at(43));
    expect(D.revertWaitsForBase(fetched, task(fetched, r.newId))).toBe(false);
    expect(M.activeAttempts(M.dispatchEligible(M.leadPromoteProposals(fetched, at(44)), at(44), { staleBase: (t) => D.revertWaitsForBase(fetched, t) }), r.newId)).toHaveLength(1);
    // Outside pull-request mode nothing waits.
    expect(D.revertWaitsForBase(D.setDeliveryMode(r.state, { mode: "off" }, at(41)), revert)).toBe(false);
  });

  it("L8: a pull request that was prepared but never opened is labelled truthfully after the mode is switched off, and its work can go through the current mode", () => {
    const off = D.setDeliveryMode(built(prMode("hold")), { mode: "off" }, at(5));
    expect(D.prLabel(off, task(off, ID), ms(6))!.text).toBe("PR not opened: delivery is off");
    expect(D.nextPrOp(off, ms(100))).toBeUndefined();
    const abandoned = D.closePr(off, ID, at(7));
    expect(prOf(abandoned).phase).toBe("closed");
    expect(D.redeliverable(abandoned).map((t) => t.id)).toEqual([ID]);
    expect(task(D.redeliver(abandoned, [ID], at(8)), ID).integration).toMatchObject({ status: "pending" });
  });

  it("L9: a closed pull request is still read, slowly and for a day, and one that was reopened and merged on GitHub lands", () => {
    const closed = see(opened(built(prMode("hold"))), 30, { state: "CLOSED", closedBy: "octocat" });
    expect(D.nextPrOp(D.reportBaseFetched(closed, SHA_A, at(399)), ms(400))).toBeUndefined(); // same ten-minute slot
    const op = D.nextPrOp(D.reportBaseFetched(closed, SHA_A, at(659)), ms(660))!;
    expect(op).toMatchObject({ kind: "observe", prs: [{ taskId: ID, number: 12 }] });
    // Still closed, or reopened: nothing changes and nothing is reopened or pushed.
    const still = D.reportObservations(closed, { prs: [observation({ state: "CLOSED" })], commits: [] }, at(661));
    expect(prOf(still).phase).toBe("closed");
    expect(prOf(D.reportObservations(closed, { prs: [observation({ state: "OPEN" })], commits: [] }, at(661))).phase).toBe("closed");
    const merged = D.reportObservations(closed, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" })], commits: [] }, at(661));
    expect(task(merged, ID).integration).toMatchObject({ pr: { phase: "merged" }, landed: { by: "person", mergedBy: "octocat", commit: MERGE } });
    // After a day it is no longer read.
    expect(D.nextPrOp(fresh(closed, 25 * 3600), ms(25 * 3600))).toBeUndefined();
  });

  it("L10: a merge GitHub reports only after the command seemed to fail is still attributed to the app", () => {
    const s = D.requestPrMerge(opened(built(prMode("hold"))), ID, HEAD, at(21));
    const op = D.nextPrOp(s, ms(23))!;
    const begun = D.beginPrOp(s, op, at(23)).state;
    // gh reported a refusal, and GitHub still showed it open: the intent is cleared…
    const failed = D.reportPrOp(begun, { op, actError: { code: "rejected", message: "gh: rejected" }, observed: { prs: [observation()], commits: [] } }, at(24));
    expect(prOf(failed).op).toBeUndefined();
    expect(prOf(failed).lastMergeIntent).toEqual({ at: at(23), headSha: HEAD, auto: false });
    // …but the merge had gone through. It is the app's, by the signed-in account, for that head.
    const late = D.reportObservations(failed, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "me" })], commits: [] }, at(60));
    expect(task(late, ID).integration!.landed).toMatchObject({ by: "app", mergedBy: "me" });
    // Someone else, or another head, is a person's merge.
    expect(task(D.reportObservations(failed, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "octocat" })], commits: [] }, at(60)), ID).integration!.landed!.by).toBe("person");
    expect(task(D.reportObservations(failed, { prs: [observation({ state: "MERGED", mergeCommit: MERGE, mergedBy: "me", headSha: SHA_B })], commits: [] }, at(60)), ID).integration!.landed!.by).toBe("person");
  });

  it("L11: the chip names what the pull request is actually waiting for", () => {
    const label = (s: State, second = 21) => D.prLabel(s, task(s, ID), ms(second))!.text;
    expect(label(opened(built(prMode("hold")), ID, 12, 20, { checks: [check(null)] }))).toBe("PR #12 checks");
    expect(label(opened(built(prMode("hold")), ID, 12, 20, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))).toBe("PR #12 waiting on GitHub");
    expect(label(opened(D.advanceDelivery(built(prMode("hold"), ID, HEAD, null), at(4))))).toBe("PR #12 review");
    expect(label(opened(built(prMode("hold"))))).toBe("PR #12 waiting for you");
    expect(label(M.pauseProject(opened(built(prMode("hold")), ID, 12, 20, { checks: [check(null)] }), at(21)))).toBe("PR #12 paused");
    expect(label(D.reportBaseFetched(autoOpen(), SHA_B, at(22)), 23)).toBe("PR #12 updating");
    expect(label(autoOpen())).toBe("PR #12 merging next");
    const paused = structuredClone(autoOpen());
    paused.project.github!.autoMergePaused = { since: at(20), reason: "r", sticky: true };
    expect(label(paused)).toBe("PR #12 auto-merge paused");
    expect(label(built(prMode("hold")))).toBe("PR preparing");
  });
});
