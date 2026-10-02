// The security reviewer. The role everywhere roles are enumerated, its provider and model
// (the code reviewer's unless configured), and the delivery gate: wherever the code review's findings
// gate a merge or start a repair, the security review's findings count the same way, in the task's own
// pipeline and in the dedicated delivery review. Pure; nothing here touches git or GitHub.

import { describe, expect, it } from "vitest";
import * as D from "./delivery";
import { builtInCatalog, internalFlow } from "./flows";
import * as M from "./model";
import { buildSeed } from "./seed";
import { reviewedChange } from "./testing/reviewed";
import { REVIEW_ROLES, ROLES, STEP_ROLES, autoModelDefaults, roleDefaultFor, type CheckObs, type PrDelivery, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ms = (s: number) => T0 + s * 1000;
const seed = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const SHA_A = "a".repeat(40);
const HEAD = "c".repeat(40);
const ID = "EX-006";
const CHANGED = { files: 1, additions: 1, deletions: 0, paths: ["a.txt"], protectedHits: [] as string[], workflowHits: [] as string[] };
const prOf = (s: State, id = ID): PrDelivery => task(s, id).integration!.pr!;
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

/** Pull-request delivery on, the repository checked, its base fetched; every other open task held. */
function prMode(merge: "hold" | "auto" = "hold"): State {
  let s = D.setDeliveryMode(seed(), { mode: "pr" }, at(0));
  s.attempts = [];
  for (const t of s.tasks) if (t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
  s = D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(1));
  s = D.reportBaseFetched(s, SHA_A, at(2));
  return merge === "auto" ? D.setPrDelivery(s, { merge: "auto" }, at(2)) : s;
}

interface Secured {
  /** Open findings of the code review (clean by default). */
  code?: number;
  /** Open findings of the security review (clean by default). */
  security?: number;
  /** false: the security review ran on an earlier change, so it never saw this one. */
  securitySaw?: boolean;
}

/**
 * A finished task whose pipeline wrote `sha` on Codex and reviewed exactly that change twice, as the Change
 * flow does: a code review (S2) and a security review (SR1) beside it, both on Claude.
 */
function secured(s0: State, id: string, sha: string, o: Secured = {}): State {
  return reviewedChange(s0, id, sha, at(2), { writer: "codex", reviewer: "claude", findings: o.code ?? 0, security: o.security ?? 0, ...(o.securitySaw === false ? { securitySaw: false } : {}) });
}

/** …done, with its head prepared as a pull request. */
function built(s: State, o: Secured = {}): State {
  const next = secured(s, ID, HEAD, o);
  task(next, ID).lifecycle = "done";
  task(next, ID).hold = false;
  task(next, ID).integration = { status: "pending" };
  return D.reportPrHead(next, ID, { n: 1, sha: HEAD, baseSha: SHA_A, changed: CHANGED }, at(3));
}

/** …published and observed once, with passing checks. */
function opened(s: State, second = 20): State {
  const op = D.nextPrOp(s, ms(second - 10))!;
  expect(op).toMatchObject({ kind: "publish", taskId: ID });
  const begun = D.beginPrOp(s, op, at(second - 10));
  expect(begun.started).toBe(true);
  const open = D.reportPrOp(begun.state, { op, published: { number: 12, url: "https://github.com/o/r/pull/12" } }, at(second - 9));
  return D.reportObservations(open, { prs: [observation({ headSha: prOf(open).headSha, checksFor: prOf(open).headSha })], commits: [] }, at(second));
}
const reviewTasks = (s: State) => s.tasks.filter((t) => t.reviewTarget?.taskId === ID);
const repairTasks = (s: State) => s.tasks.filter((t) => t.deliverInto?.taskId === ID);

/** Dispatch and finish every run of a task until it is done; each review role reports `findings[role]` open findings. */
function runToDone(s0: State, id: string, second: number, findings: Partial<Record<string, number>> = {}): State {
  let s = s0;
  for (let i = 0; i < 12 && task(s, id).lifecycle !== "done"; i++) {
    s = M.dispatchEligible(M.leadPromoteProposals(s, at(second)), at(second));
    for (const a of M.activeAttempts(s, id)) {
      const st = task(s, id).steps.find((x) => x.id === a.stepId)!;
      s = M.reportCompletion(s, a.id, [], at(second), st.outputs.map((o) => ({ name: o.name, summary: `${st.role}: ${findings[st.role] ? "findings" : "clean"}`, ...(o.kind === "review-findings" ? { openFindings: findings[st.role] ?? 0 } : {}) })));
    }
  }
  return s;
}

describe("the role", () => {
  it("is enumerated everywhere roles are: the type's lists (the label is checked with the UI helpers, the schema with the flow files), and it is a review role", () => {
    expect(ROLES).toEqual(["lead", "designer", "pe", "coder", "code_reviewer", "security_reviewer", "ux_reviewer"]);
    expect(STEP_ROLES).toContain("security_reviewer");
    // The PE (ORC-029) has a role default but runs only in the studio: no flow step uses it until pass 5.
    expect(STEP_ROLES).not.toContain("pe");
    expect(REVIEW_ROLES).toEqual(["code_reviewer", "security_reviewer", "ux_reviewer"]);
  });

  it("has the code reviewer's provider and model unless configured otherwise: project defaults, resolution, the Settings default", () => {
    const defaults = autoModelDefaults();
    expect(defaults.roleDefaults.security_reviewer).toBeUndefined();
    expect(roleDefaultFor(defaults, "security_reviewer")).toEqual(defaults.roleDefaults.code_reviewer);
    expect(roleDefaultFor({ roleDefaults: { code_reviewer: { provider: "codex", model: "x" }, security_reviewer: { provider: "claude", model: "y" } } }, "security_reviewer")).toEqual({ provider: "claude", model: "y" });
    expect(roleDefaultFor({ roleDefaults: {} }, "security_reviewer")).toBeUndefined();
    // On a Change task: SR1 resolves like S2 while the security reviewer has no default of its own.
    let s = seed();
    const r = M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
    s = r.state;
    const t = () => task(s, r.newId);
    const step = (id: string) => t().steps.find((x) => x.id === id)!;
    expect(step("SR1").role).toBe("security_reviewer");
    expect(M.resolveStep(s, t(), step("SR1"))).toMatchObject({ ok: true, selection: s.project.roleDefaults.code_reviewer, source: "project-role" });
    s = M.setRoleDefault(s, "code_reviewer", { provider: "codex", model: "codex-sample-fast" }, at(1));
    expect(M.resolveStep(s, t(), step("SR1"))).toMatchObject({ ok: true, selection: { provider: "codex", model: "codex-sample-fast" }, source: "project-role" });
    // Its own default wins once set; clearing it goes back to following the code reviewer.
    s = M.setRoleDefault(s, "security_reviewer", { provider: "claude", model: "claude-sample-fast" }, at(2));
    expect(M.resolveStep(s, t(), step("SR1"))).toMatchObject({ ok: true, selection: { provider: "claude", model: "claude-sample-fast" }, source: "project-role" });
    s = M.setRoleDefault(s, "security_reviewer", null, at(3));
    expect(M.resolveStep(s, t(), step("SR1"))).toMatchObject({ ok: true, selection: { provider: "codex", model: "codex-sample-fast" }, source: "project-role" });
    // A task role override and a step pin for the security reviewer apply like any role's; a code reviewer override does not carry over.
    s = M.setTaskRoleOverride(s, r.newId, "code_reviewer", { provider: "claude", model: "claude-sample-large" }, at(4));
    expect(M.resolveStep(s, t(), step("SR1"))).toMatchObject({ selection: { provider: "codex" }, source: "project-role" });
    s = M.setTaskRoleOverride(s, r.newId, "security_reviewer", { provider: "claude", model: "claude-sample-large" }, at(5));
    expect(M.resolveStep(s, t(), step("SR1"))).toMatchObject({ selection: { provider: "claude", model: "claude-sample-large" }, source: "task-role" });
    s = M.setStepSelection(s, r.newId, "SR1", { provider: "codex", model: "codex-sample-large" }, at(6));
    expect(M.resolveStep(s, t(), step("SR1"))).toMatchObject({ selection: { provider: "codex", model: "codex-sample-large" }, source: "step" });
  });
});

describe("the delivery gate counts the security review's findings like the code review's", () => {
  it("the task's own pipeline: open security findings block the merge and are what a repair fixes; both clean passes", () => {
    const findings = built(prMode(), { security: 1 });
    expect(prOf(findings).review).toMatchObject({ ok: false, source: "pipeline", forSha: HEAD });
    expect(prOf(findings).review.reason).toBe(`The review of ${HEAD.slice(0, 12)} reported 1 open finding.`);
    expect(prOf(findings).review.artifactIds).toEqual([`fx-findings-${ID}`, `fx-secfindings-${ID}`]);
    expect(D.reviewView(findings, task(findings, ID)).state).toBe("findings");
    expect(D.repairCause(findings, task(findings, ID))).toEqual({ kind: "findings", summaries: ["a token is written to the log"] });
    // No dedicated review is started for findings: they go to repair, and the pull request says so.
    const advanced = D.advanceDelivery(findings, at(4));
    expect(reviewTasks(advanced)).toEqual([]);
    expect(prOf(advanced).attention).toMatchObject({ code: "review-findings" });
    // Both reviews count together.
    const both = built(prMode(), { code: 2, security: 1 });
    expect(prOf(both).review.reason).toMatch(/3 open findings/);
    // Clean on both: the independent code review carries the evidence.
    const clean = built(prMode());
    expect(prOf(clean).review).toMatchObject({ ok: true, source: "pipeline", provider: "claude", attemptId: `fx-review-${ID}`, artifactIds: [`fx-findings-${ID}`, `fx-secfindings-${ID}`] });
    expect(D.reviewView(clean, task(clean, ID)).state).toBe("ok");
    // A security review that saw an earlier change says nothing about this one, either way (its findings are
    // not counted), and a clean code review alone is not a pass: the dedicated review runs.
    const stale = built(prMode(), { security: 1, securitySaw: false });
    expect(prOf(stale).review).toMatchObject({ ok: false, source: "none", reason: `No security review saw the final change ${HEAD.slice(0, 12)}.` });
    expect(D.reviewView(stale, task(stale, ID)).state).toBe("missing");
    const [dedicated] = reviewTasks(D.advanceDelivery(stale, at(4)));
    expect(dedicated.steps.map((st) => st.role)).toEqual(["code_reviewer", "security_reviewer"]);
    // An older pipeline with no security review at all is the same.
    const legacy = D.reportPrHead(reviewedChange(prMode(), ID, HEAD, at(2), { noSecurity: true }), ID, { n: 1, sha: HEAD, baseSha: SHA_A, changed: CHANGED }, at(3));
    expect(D.reviewView(legacy, task(legacy, ID)).state).toBe("missing");
    // Code findings still stand when the security review is missing: they go to repair, not to a new review.
    const codeOpen = built(prMode(), { code: 1, securitySaw: false });
    expect(D.reviewView(codeOpen, task(codeOpen, ID)).state).toBe("findings");
  });

  it("in automatic mode, open security findings hold item 9 of the gate and create one fix task seeded with the finding", () => {
    const s = opened(built(prMode("auto"), { security: 1 }));
    const gate = D.prGate(s, task(s, ID), ms(21), { byUser: false });
    expect(gate.items.find((i) => i.id === "review")).toMatchObject({ ok: false });
    expect(gate.items.find((i) => i.id === "checks")).toMatchObject({ ok: true });
    const repaired = D.advanceDelivery(s, at(22));
    expect(repairTasks(repaired)).toHaveLength(1);
    const fix = repairTasks(repaired)[0];
    expect(M.currentSpec(fix).content.scopeIncluded).toEqual(["Open review finding: a token is written to the log"]);
    expect(fix.flow).toMatchObject({ id: "change", chosenBy: "service" });
    expect(fix.steps.some((st) => st.role === "security_reviewer")).toBe(true); // the fix is reviewed for security again
    // Clean on both: the gate's review item passes and nothing is created.
    const clean = opened(built(prMode("auto")));
    expect(D.prGate(clean, task(clean, ID), ms(21), { byUser: false }).items.find((i) => i.id === "review")).toMatchObject({ ok: true });
    expect(repairTasks(D.advanceDelivery(clean, at(22)))).toEqual([]);
  });

  it("the dedicated delivery review runs a code review and a security review, both independent of the writer, both pinned to the commit; either one's findings gate the merge", () => {
    // A change Codex wrote whose own pipeline never reviewed it: the service starts the dedicated review.
    const s0 = built(prMode(), { securitySaw: false });
    const unreviewed = structuredClone(s0);
    task(unreviewed, ID).steps = task(unreviewed, ID).steps.filter((x) => x.role === "coder");
    unreviewed.attempts = unreviewed.attempts.filter((a) => a.taskId !== ID || a.stepId === "S1");
    unreviewed.artifacts = unreviewed.artifacts.filter((a) => a.taskId !== ID || a.stepId === "S1");
    let s = D.advanceDelivery(unreviewed, at(4));
    const [rv] = reviewTasks(s);
    expect(rv).toBeDefined();
    expect(rv.steps.map((st) => ({ id: st.id, role: st.role, independentOf: st.independentOf, purpose: st.purpose }))).toEqual([
      { id: "S1", role: "code_reviewer", independentOf: "writer", purpose: `Review ${ID} for merge into main at ${HEAD.slice(0, 12)}` },
      { id: "SR1", role: "security_reviewer", independentOf: "writer", purpose: `Security review of ${ID} for merge into main at ${HEAD.slice(0, 12)}` },
    ]);
    expect(rv.flow).toMatchObject({ id: "delivery-review", source: "internal", chosenBy: "service" });
    expect(rv.steps.map((st) => st.id)).toEqual(internalFlow("delivery-review").steps.map((st) => st.id));
    // Both resolve to the other provider than the writer: the code reviewer by its default, the security reviewer by following it.
    for (const st of rv.steps) expect(M.resolveStep(s, rv, st), st.id).toMatchObject({ ok: true, selection: { provider: "claude" } });
    // The security review alone reports findings: the merge is blocked on them.
    const withFindings = D.advanceDelivery(runToDone(s, rv.id, 5, { security_reviewer: 1 }), at(6));
    const runs = withFindings.attempts.filter((a) => a.taskId === rv.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((a) => a.snapshot.reviewedSha === HEAD && a.snapshot.provider === "claude")).toBe(true);
    const v = D.reviewView(withFindings, task(withFindings, ID));
    expect(v).toMatchObject({ state: "findings", reviewTaskId: rv.id });
    expect(v.evidence.reason).toMatch(/reported 1 open finding/);
    expect(prOf(withFindings).review.ok).toBe(false);
    expect(prOf(withFindings).attention).toMatchObject({ code: "review-findings" });
    expect(D.repairCause(withFindings, task(withFindings, ID))).toEqual({ kind: "findings", summaries: ["security_reviewer: findings"] });
    // Both clean: the dedicated review counts.
    const clean = D.advanceDelivery(runToDone(s, rv.id, 5), at(6));
    expect(prOf(clean).review).toMatchObject({ ok: true, source: "dedicated", forSha: HEAD, taskId: rv.id, provider: "claude" });
    expect(prOf(clean).review.artifactIds).toHaveLength(2);
    // A security review that read another commit than the one under review proves nothing about it.
    const elsewhere = structuredClone(clean);
    elsewhere.attempts.find((a) => a.taskId === rv.id && a.stepId === "SR1")!.snapshot.reviewedSha = SHA_A;
    expect(D.reviewView(elsewhere, task(elsewhere, ID)).state).toBe("missing");
  });

  it("the three flows that change code review every repair round for security too, and the lead's verification reads both reviews", () => {
    for (const id of ["change", "bugfix", "feature"]) {
      const flow = builtInCatalog().find((p) => p.id === id)!;
      const repair = flow.steps.find((st) => st.role === "coder" && st.iterate)!;
      const from = flow.steps.findIndex((st) => st.id === repair.iterate!.from);
      const body = flow.steps.slice(from, flow.steps.indexOf(repair) + 1);
      expect(body.map((st) => st.role), id).toEqual(expect.arrayContaining(["code_reviewer", "security_reviewer"]));
      const verify = flow.steps[flow.steps.length - 1];
      expect(verify.role, id).toBe("lead");
      expect(verify.inputs.map((r) => flow.steps.find((st) => st.id === r.step)!.role), id).toEqual(expect.arrayContaining(["code_reviewer", "security_reviewer"]));
    }
  });
});
