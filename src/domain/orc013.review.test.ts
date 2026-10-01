// The harder cases of findings, decisions and coverage (pure domain): decisions kept across a summary
// edit, accepted findings, retried decisions runs, the lead-fix rule in pull-request mode, coverage
// without a scope, pruning and superseding, and smaller items. The git-based case (special characters in
// paths) is in server/orc013.review.test.ts.

import { describe, expect, it } from "vitest";
import { normalizePath } from "./coverage";
import * as D from "./delivery";
import * as F from "./findings";
import * as M from "./model";
import { buildSeed } from "./seed";
import { builtInCatalog } from "./flows";
import { DEFAULT_PR_DELIVERY, type Finding, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
let n = 0;
function finding(over: Partial<Finding> = {}): Finding {
  n += 1;
  return { id: `F${n}`, key: `key${n}`.padEnd(12, "0"), source: "review", severity: "error", action: "auto-fix", title: `Finding ${n}`, detail: "what is wrong", ...over };
}
/** A Change task whose coder finished at SHA; the review S2 is running with a recorded scope. */
function reviewRunning(o: { author?: "user" | "lead" } = {}): { s: State; id: string; review: string } {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  const r = M.createTask(s, { title: "Change", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
  s = r.state;
  if (o.author === "lead") task(s, r.newId).specs[0].author = "lead";
  s = M.dispatchEligible(M.leadPromoteProposals(s, at(1)), at(1));
  s = M.reportCompletion(s, running(s, r.newId)[0].id, [], at(2), [{ name: "change", summary: "done", ref: `${SHA.slice(0, 12)} on b` }, { name: "handoff", summary: "h" }]);
  s = M.dispatchEligible(s, at(3));
  const review = running(s, r.newId)[0].id;
  s = M.reportRunContext(s, review, { scope: { from: SHA2, to: SHA, paths: ["a.ts"], total: 1 } });
  // The security review beside S2 is completed clean; these tests are about the code review.
  for (const a of running(s, r.newId)) if (step(s, r.newId, a.stepId).role === "security_reviewer") s = M.reportCompletion(s, a.id, [], at(3), [{ name: "findings", summary: "no security findings", findings: [] }]);
  return { s, id: r.newId, review };
}
const report = (s: State, run: string, t: number, findings: Finding[], paths = ["a.ts"]) => M.reportCompletion(s, run, [], at(t), [{ name: "findings", summary: "r", findings, reviewedPaths: paths }]);

describe("editing a structured review's summary keeps its decisions", () => {
  it("the decisions move to the edited version; nothing waits on the lead for a finding with no record; the repair sees them", () => {
    const { s: s0, id, review } = reviewRunning();
    let s = report(s0, review, 4, [finding({ action: "ask-user", title: "Accepted one" }), finding({ action: "ask-user", title: "Open one" })]);
    const art = M.acceptedOutput(s, task(s, id), "S2", "findings")!;
    const [d1, d2] = F.decisionsOf(s, id).reverse();
    s = F.decideFinding(s, d1.id, "accept", "fine", at(5));
    expect(F.undecided(s, art)).toBe(1);
    const edited = M.editArtifact(s, art.id, { summary: "edited summary", reason: "clarity" }, at(6));
    const v2 = M.acceptedOutput(edited, task(edited, id), "S2", "findings")!;
    expect(v2.id).not.toBe(art.id);
    expect(v2.findings).toEqual(art.findings);
    // No duplicate records, and the same two decisions now belong to v2.
    expect(F.decisionsOf(edited, id)).toHaveLength(2);
    expect(F.decisionFor(edited, v2, v2.findings![0])).toMatchObject({ id: d1.id, status: "accept" });
    expect(F.decisionFor(edited, v2, v2.findings![1])).toMatchObject({ id: d2.id, status: "open", routedTo: "user" });
    expect(F.undecided(edited, v2)).toBe(1);
    expect(F.fixable(edited, v2)).toBe(0);
    expect(M.stateLabel(edited, task(edited, id))).toBe("Needs you: decide 1 finding");
    // Never "the lead" for a finding without a record.
    const stripped = { ...edited, decisions: [] };
    expect(F.awaitingDecision(stripped, task(stripped, id))).toEqual({ count: 2, lead: 0, user: 2 });
    // Deciding the open one lets the repair run, and the repair's envelope decisions include both.
    const decided = F.decideFinding(edited, d2.id, "fix", undefined, at(7));
    const next = M.dispatchEligible(decided, at(8));
    expect(running(next, id)[0]?.stepId).toBe("S3");
    expect(F.decisionsForStep(next, task(next, id), step(next, id, "S3")).map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
  });
});

describe("a finding the user accepted is not fixed in the next round", () => {
  it("an auto-fix finding with the key of an accepted decision is settled: not fixable, not unresolved, carried with a record; the reviewer gets every settled decision of the task", () => {
    const { s: s0, id, review } = reviewRunning();
    const key = "abcdefabcdef";
    let s = report(s0, review, 4, [finding({ action: "ask-user", key, title: "Debatable" })]);
    s = F.decideFinding(s, F.decisionsOf(s, id)[0].id, "accept", "by design", at(5));
    s = M.dispatchEligible(s, at(6)); // S3 skipped (nothing fixable), C2 skipped (checks off), S4 running
    expect(step(s, id, "S3").state).toBe("skipped");
    // A later review round reports the same finding as auto-fix.
    s = M.rerunStep(M.acknowledgeStop(M.pauseTask(s, id, at(7)), running(s, id)[0].id, at(8)), id, "S2", at(9));
    s = M.resumeTask(s, id, at(10));
    s = M.dispatchEligible(s, at(11));
    const again = running(s, id)[0];
    expect(again.stepId).toBe("S2");
    s = M.reportRunContext(s, again.id, { scope: { from: SHA2, to: SHA, paths: ["a.ts"], total: 1 } });
    s = report(s, again.id, 12, [finding({ action: "auto-fix", key, title: "Debatable" })]);
    const art = M.acceptedOutput(s, task(s, id), "S2", "findings")!;
    expect(art.findings![0].action).toBe("auto-fix");
    expect(F.decisionFor(s, art, art.findings![0])).toMatchObject({ status: "accept", decidedBy: "carried" });
    expect(F.fixable(s, art)).toBe(0);
    expect(F.unresolved(s, art)).toBe(0);
    expect(F.settledByKey(s, task(s, id), art.findings![0])).toBe(true);
    const next = M.dispatchEligible(s, at(13));
    expect(step(next, id, "S3").state).toBe("skipped");
    expect(next.events.some((e) => e.message.includes("decided as before"))).toBe(true);
  });
});

describe("a failed or lost decisions run is retried", () => {
  it("decisions routed before a run that failed are due again; a completed run settles them", () => {
    const { s: s0, id, review } = reviewRunning();
    let s: State = { ...s0, project: { ...s0.project, triage: { askUserBy: "lead" as const } } };
    s = report(s, review, 4, [finding({ action: "ask-user" })]);
    expect(F.decisionsDueForLead(s)).toHaveLength(1);
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(5));
    expect(F.decisionsDueForLead(r.state)).toHaveLength(0); // shown to a run in progress
    const failed = M.reportLeadFailed(r.state, r.runId, "boom", at(6));
    expect(F.decisionsDueForLead(failed)).toHaveLength(1);
    const lost = M.reportLeadStopped(r.state, r.runId, at(6), true);
    expect(F.decisionsDueForLead(lost)).toHaveLength(1);
    const ok = M.completeLeadRun(r.state, r.runId, { reply: "later", proposals: [] }, at(6));
    expect(F.decisionsDueForLead(ok)).toHaveLength(0);
    expect(M.leadDue(failed, T0 + 60 * 60_000, 600)).toBe("decisions");
    void id;
  });
});

describe("the lead-fix-on-a-user-spec rule holds in pull-request mode", () => {
  it("a repair or review task authored by the system resolves to the user's task: the lead's fix becomes a suggestion", () => {
    const { s: s0, id, review } = reviewRunning();
    let s: State = { ...s0, project: { ...s0.project, triage: { askUserBy: "lead" as const } } };
    s = report(s, review, 4, [finding({ action: "ask-user" })]);
    // Pretend this task is a repair of a user-authored task (as pull-request delivery creates them).
    const owner = M.createTask(s, { title: "Owner", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at(5));
    s = owner.state;
    task(s, id).specs[0].author = "system";
    task(s, id).deliverInto = { taskId: owner.newId, n: 1, mergeBase: false };
    expect(F.owningTask(s, task(s, id)).id).toBe(owner.newId);
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(6));
    const out = M.completeLeadRun(r.state, r.runId, { reply: "", proposals: [], decisions: [{ id: s.decisions[0].id, decision: "fix", why: "small" }] }, at(7));
    expect(out.decisions[0]).toMatchObject({ status: "open", routedTo: "user", suggestion: { decision: "fix", why: "small" } });
    // On a lead-authored owner the fix applies.
    task(s, owner.newId).specs[0].author = "lead";
    const r2 = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(8));
    expect(M.completeLeadRun(r2.state, r2.runId, { reply: "", proposals: [], decisions: [{ id: s.decisions[0].id, decision: "fix", why: "small" }] }, at(9)).decisions[0].status).toBe("fix");
  });
});

describe("coverage without a scope, and changes too large to prove", () => {
  it("a code review of a real change with no recorded scope is unproven: accepted for runIf, never clean gate evidence", () => {
    const { s: s0, id, review } = reviewRunning();
    const noScope = { ...s0, attempts: s0.attempts.map((a) => (a.id === review ? { ...a, scope: undefined } : a)) };
    const s = report(noScope, review, 4, []);
    const art = M.acceptedOutput(s, task(s, id), "S2", "findings")!;
    expect(art.pathCoverage!.state).toBe("unproven");
    expect(M.dispatchEligible(s, at(5)).tasks.find((t) => t.id === id)!.steps.find((x) => x.id === "S3")!.state).toBe("skipped");
  });

  it("a pull request whose change touches more than 300 files starts no dedicated review and says why", () => {
    let s = buildSeed(T0, { inFlightRuns: false });
    s = D.setDeliveryMode({ ...s, tasks: s.tasks.map((t) => (t.id === "EX-006" ? { ...t, lifecycle: "done" as const, integration: { status: "pending" as const } } : t)) }, { mode: "pr" }, at(0));
    s = D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(1));
    const big = D.reportPrHead(s, "EX-006", { n: 1, sha: SHA, baseSha: SHA2, changed: { files: 301, additions: 1, deletions: 0, paths: [], protectedHits: [], workflowHits: [] } }, at(2));
    const v = D.reviewView(big, task(big, "EX-006"));
    expect(v.state).toBe("too-large");
    expect(v.evidence.reason).toMatch(/touches 301 files, too many for a review to show it covered them all \(the limit is 300\)\. No review is started; look at it and merge it yourself\./);
    const after = D.ensureReview(big, "EX-006", at(3));
    expect(after.tasks.some((t) => t.reviewTarget)).toBe(false);
    expect(D.prGate(after, task(after, "EX-006"), T0 + 5000, { byUser: false }).items.find((i) => i.id === "review")).toMatchObject({ state: "blocked", code: "review-blocked" });
    const small = D.reportPrHead(s, "EX-006", { n: 1, sha: SHA, baseSha: SHA2, changed: { files: 3, additions: 1, deletions: 0, paths: [], protectedHits: [], workflowHits: [] } }, at(2));
    expect(D.ensureReview(small, "EX-006", at(3)).tasks.some((t) => t.reviewTarget)).toBe(true);
  });
});

describe("pruning and superseding", () => {
  it("the cap never drops a decision a repair or the gate may still read; decided ones of landed or cancelled tasks go first", () => {
    const { s: s0, id, review } = reviewRunning();
    let s = report(s0, review, 4, [finding({ action: "ask-user" })]);
    s = F.decideFinding(s, F.decisionsOf(s, id)[0].id, "accept", undefined, at(5));
    const mine = F.decisionsOf(s, id)[0];
    // 2000 decided decisions of a cancelled task fill the record; the active task's decision survives the cap.
    const filler = Array.from({ length: F.MAX_DECISIONS }, (_, i) => ({ ...mine, id: `fd-filler-${i}`, taskId: "EX-005", createdAt: at(1) }));
    const crowded: State = { ...s, decisions: [...filler, mine], tasks: s.tasks.map((t) => (t.id === "EX-005" ? { ...t, lifecycle: "cancelled" as const } : t)) };
    // Another accepted artifact on the active task triggers pruning.
    const more = report({ ...crowded, attempts: crowded.attempts.map((a) => (a.id === review ? { ...a, outcome: "running" as const } : a)) }, review, 6, [finding({ action: "ask-user" })]);
    expect(more.decisions.length).toBeLessThanOrEqual(F.MAX_DECISIONS);
    expect(more.decisions.some((d) => d.id === mine.id)).toBe(true);
    // With nothing droppable, the cap yields: an active task's decided decisions are kept.
    const active: State = { ...s, decisions: Array.from({ length: F.MAX_DECISIONS + 5 }, (_, i) => ({ ...mine, id: `fd-a-${i}` })) };
    const kept = report({ ...active, attempts: active.attempts.map((a) => (a.id === review ? { ...a, outcome: "running" as const } : a)) }, review, 7, [finding({ action: "ask-user" })]);
    expect(kept.decisions.filter((d) => d.id.startsWith("fd-a-"))).toHaveLength(F.MAX_DECISIONS + 5);
  });

  it("open decisions of a cancelled task, and of an artifact a later run replaced, are closed as superseded and leave every list", () => {
    const { s: s0, id, review } = reviewRunning();
    let s = report(s0, review, 4, [finding({ action: "ask-user" })]);
    const d = F.decisionsOf(s, id)[0];
    expect(F.openDecisions(s, "user")).toHaveLength(1);
    const cancelled = M.cancelTask(s, id, at(5));
    expect(cancelled.decisions.find((x) => x.id === d.id)).toMatchObject({ status: "superseded", why: `${id} was cancelled` });
    expect(F.openDecisions(cancelled, "user")).toEqual([]);
    expect(F.decisionsDueForLead({ ...cancelled, project: { ...cancelled.project, triage: { askUserBy: "lead" } } })).toEqual([]);
    expect(F.decisionLabel(cancelled.decisions.find((x) => x.id === d.id)!)).toMatch(/^no longer open/);
    // A rerun of the review replaces the artifact: the open decision on the old one is superseded; the new report gets its own.
    s = M.rerunStep(M.acknowledgeStop(M.pauseTask(s, id, at(5)), running(s, id)[0]?.id ?? "", at(6)), id, "S2", at(7));
    s = M.resumeTask(s, id, at(8));
    s = M.dispatchEligible(s, at(9));
    const again = running(s, id).find((a) => a.stepId === "S2")!;
    s = M.reportRunContext(s, again.id, { scope: { from: SHA2, to: SHA, paths: ["a.ts"], total: 1 } });
    s = report(s, again.id, 10, [finding({ action: "ask-user", title: "Another" })]);
    expect(s.decisions.find((x) => x.id === d.id)!.status).toBe("superseded");
    expect(F.openDecisions(s, "user")).toHaveLength(1);
    expect(F.openDecisions(s, "user")[0].finding.title).toBe("Another");
  });
});

describe("smaller items", () => {
  it("the default protected paths cover AGENTS.md and CLAUDE.md anywhere; unmodified built-ins keep matching descriptions", () => {
    expect(DEFAULT_PR_DELIVERY.protectedPaths).toEqual(expect.arrayContaining(["**/AGENTS.md", "**/CLAUDE.md"]));
    for (const p of ["AGENTS.md", "docs/AGENTS.md", "a/b/CLAUDE.md"]) expect(DEFAULT_PR_DELIVERY.protectedPaths.some((g) => D.matchGlob(g, p)), p).toBe(true);
    expect(DEFAULT_PR_DELIVERY.protectedPaths.some((g) => D.matchGlob(g, "src/agents.ts"))).toBe(false);
    for (const b of builtInCatalog()) expect(b.description.length).toBeGreaterThan(0);
  });

  it("a backslash is part of a path name", () => {
    expect(normalizePath("docs/we\\ird.md")).toBe("docs/we\\ird.md");
    expect(normalizePath('docs/quo"te.md')).toBe('docs/quo"te.md');
    expect(normalizePath("docs/café.md")).toBe("docs/café.md");
  });

  it("the lead reply keeps a snapshot of its decisions; follow-up room counts once; severity is in the key; an accepted finding on an incomplete review does not end the loop clean", () => {
    const { s: s0, id, review } = reviewRunning();
    let s: State = { ...s0, project: { ...s0.project, triage: { askUserBy: "lead" as const }, autonomy: { ...s0.project.autonomy, maxOpenProposals: 20 } } };
    s = report(s, review, 4, [finding({ action: "ask-user", title: "One" }), finding({ action: "ask-user", title: "Two" })]);
    const [d1, d2] = F.decisionsOf(s, id).reverse();
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(5));
    let out = M.completeLeadRun(r.state, r.runId, { reply: "", proposals: [], decisions: [{ id: d1.id, decision: "accept", why: "fine" }, { id: d2.id, decision: "follow-up", why: "later" }] }, at(6));
    const msg = out.conversation.at(-1)!;
    expect(msg.leadDecisions).toEqual([
      { id: d1.id, taskId: id, what: "decided", status: "accept", why: "fine" },
      { id: d2.id, taskId: id, what: "decided", status: "follow-up", why: "later" },
    ]);
    const changed = F.decideFinding(out, d1.id, "reopen", "no", at(7));
    expect(changed.conversation.at(-1)!.leadDecisions![0]).toEqual({ id: d1.id, taskId: id, what: "decided", status: "accept", why: "fine" }); // the snapshot stands
    // Follow-up room: a limit of exactly two more open proposals is filled by two follow-ups in one run (each counted once).
    const cap = { ...s, project: { ...s.project, autonomy: { ...s.project.autonomy, maxOpenProposals: M.openLeadProposals(s).length + 2 } } };
    const r2 = M.startLeadRun(cap, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(8));
    out = M.completeLeadRun(r2.state, r2.runId, { reply: "", proposals: [], decisions: [{ id: d1.id, decision: "follow-up", why: "a" }, { id: d2.id, decision: "follow-up", why: "b" }] }, at(9));
    expect(out.decisions.filter((d) => d.status === "follow-up")).toHaveLength(2);
    expect(out.conversation.at(-1)!.rejected ?? []).toEqual([]);
    // An incomplete clean review with an accepted finding: the coverage rule still applies (it is not clean).
    const { s: t0, id: id2, review: rv2 } = reviewRunning();
    let t = report(t0, rv2, 4, [finding({ action: "ask-user", key: "keykeykeykey", title: "K" })]);
    t = F.decideFinding(t, F.decisionsOf(t, id2)[0].id, "accept", undefined, at(5));
    t = M.dispatchEligible(t, at(6));
    t = M.rerunStep(M.acknowledgeStop(M.pauseTask(t, id2, at(7)), running(t, id2)[0].id, at(8)), id2, "S2", at(9));
    t = M.resumeTask(t, id2, at(10));
    t = M.dispatchEligible(t, at(11));
    const rerun = running(t, id2)[0];
    t = M.reportRunContext(t, rerun.id, { scope: { from: SHA2, to: SHA, paths: ["a.ts", "b.ts"], total: 2 } });
    t = report(t, rerun.id, 12, [finding({ action: "ask-user", key: "keykeykeykey", title: "K" })], ["a.ts"]);
    expect(t.attempts.find((a) => a.id === rerun.id)!.outcome).toBe("failed");
    expect(step(t, id2, "S2")).toMatchObject({ state: "pending", coverageRetries: 1, coverageGap: { missing: ["b.ts"], extra: [], to: SHA } });
    // The gap is bound to the change: a different change starts over.
    const other = { ...t, tasks: t.tasks.map((x) => (x.id === id2 ? { ...x, steps: x.steps.map((y) => (y.id === "S2" ? { ...y, coverageGap: { missing: ["z"], extra: [], to: SHA2 }, coverageRetries: 1 } : y)) } : x)) };
    const again = M.dispatchEligible(other, at(13));
    const run3 = running(again, id2)[0];
    let u = M.reportRunContext(again, run3.id, { scope: { from: SHA2, to: SHA, paths: ["a.ts", "b.ts"], total: 2 } });
    u = report(u, run3.id, 14, [], ["a.ts"]);
    expect(step(u, id2, "S2")).toMatchObject({ state: "pending", coverageRetries: 1, coverageGap: { missing: ["b.ts"], to: SHA } });
  });
});
