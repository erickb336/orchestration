// ORC-013 step 1: structured findings, the derived counts, decisions and their routing, carry-forward,
// the lead's decisions, and the Checks steps that skip while checks are off. Pure domain tests.

import { describe, expect, it } from "vitest";
import * as F from "./findings";
import * as M from "./model";
import { buildSeed } from "./seed";
import { ControlError, type Artifact, type Finding, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;

let n = 0;
/** A structured finding as the parser would hand it to the domain. */
function finding(over: Partial<Finding> = {}): Finding {
  n += 1;
  return { id: `F${n}`, key: `key${n}`.padEnd(12, "0"), source: "review", severity: "error", action: "auto-fix", title: `Finding ${n}`, detail: "what is wrong", ...over };
}

/** A fresh seed with every sample task held, plus one user task from the Change template (S1 → C1 → S2 → S3 → C2 → S4). */
function withTask(opts: { autopilot?: boolean; author?: "user" | "lead" } = {}): { s: State; id: string } {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  if (opts.autopilot) s = M.applyAutopilot(s, "main", at(0));
  const r = M.createTask(s, { title: "Change", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }, at(0));
  s = r.state;
  if (opts.author === "lead") task(s, r.newId).specs[0].author = "lead";
  return { s, id: r.newId };
}

/** Promote and dispatch. */
const go = (s: State, t: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(t)), at(t));

/** Complete the running step with the given review findings (structured, next to a wrong worker count that must be ignored) or a plain output. */
function finish(s: State, id: string, t: number, findings?: Finding[], reviewedPaths?: string[]): State {
  const [a] = running(s, id);
  const st = step(s, id, a.stepId);
  const outputs = st.outputs.map((o) => (o.kind === "review-findings" ? { name: o.name, summary: "review", findings: findings ?? [], openFindings: 0, ...(reviewedPaths ? { reviewedPaths } : {}) } : { name: o.name, summary: `${o.name} at ${t}` }));
  return M.reportCompletion(s, a.id, [], at(t), outputs);
}

/** Drive the task through S1 (implement) and S2 (review) with the given findings; C1 skips because checks are off. */
function reviewed(findings: Finding[], opts: Parameters<typeof withTask>[0] = {}): { s: State; id: string; art: Artifact } {
  const w = withTask(opts);
  let s = go(w.s, 1);
  expect(running(s, w.id)[0].stepId).toBe("S1");
  s = finish(s, w.id, 2);
  s = go(s, 3);
  expect(step(s, w.id, "C1").state).toBe("skipped");
  expect(running(s, w.id)[0].stepId).toBe("S2");
  s = finish(s, w.id, 4, findings);
  const art = M.acceptedOutput(s, task(s, w.id), "S2", "findings")!;
  return { s, id: w.id, art };
}

describe("the Checks steps while checks are off", () => {
  it("every code-changing built-in carries a Checks step in the loop and a Final checks step, both skipped with the reason", () => {
    const w = withTask();
    let s = go(w.s, 1);
    expect(task(s, w.id).steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "S3", "C2", "S4"]);
    expect(step(s, w.id, "S3").iterate).toEqual({ from: "C1", max: 3 });
    s = finish(s, w.id, 2);
    s = go(s, 3);
    expect(step(s, w.id, "C1").state).toBe("skipped");
    expect(s.events.some((e) => e.message === "Skipped C1: checks are off for this project (Settings → Checks)")).toBe(true);
    expect(M.resolveStep(s, task(s, w.id), step(s, w.id, "C1"))).toEqual({ ok: false, reason: "run by the service" });
  });

  it("a task with Checks steps is still promoted to Ready (the service, not a provider, runs them)", () => {
    const w = withTask();
    expect(task(M.leadPromoteProposals(w.s, at(1)), w.id).lifecycle).toBe("ready");
  });
});

describe("derived counts (Q7, Q8)", () => {
  it("fixable, undecided and unresolved over actions, severities and decisions; the open count is computed, never taken from the worker", () => {
    const fs = [
      finding({ severity: "error", action: "auto-fix" }), // F1 fixable, unresolved
      finding({ severity: "warning", action: "ask-user" }), // F2 undecided
      finding({ severity: "info", action: "auto-fix" }), // F3 not blocking
      finding({ severity: "error", action: "no-op" }), // F4 not blocking
      finding({ severity: "warning", action: "ask-user" }), // F5 undecided
    ];
    const { s, art } = reviewed(fs);
    expect(art.openFindings).toBe(3); // F1, F2, F5: the service's count, not the worker's
    expect(F.fixable(s, art)).toBe(1);
    expect(F.undecided(s, art)).toBe(2);
    expect(F.unresolved(s, art)).toBe(3);
    const ds = F.decisionsOf(s, art.taskId);
    expect(ds.map((d) => d.findingId).sort()).toEqual([fs[1].id, fs[4].id].sort());
    expect(ds.every((d) => d.status === "open" && d.routedTo === "user")).toBe(true);
    let next = F.decideFinding(s, ds.find((d) => d.findingId === fs[1].id)!.id, "fix", "do it", at(5));
    expect([F.fixable(next, art), F.undecided(next, art), F.unresolved(next, art)]).toEqual([2, 1, 3]);
    next = F.decideFinding(next, ds.find((d) => d.findingId === fs[4].id)!.id, "accept", undefined, at(6));
    expect([F.fixable(next, art), F.undecided(next, art), F.unresolved(next, art)]).toEqual([2, 0, 2]);
    expect(F.acceptedFindings(next, art)).toEqual([`${fs[4].id} ${fs[4].title}`]);
  });

  it("summary-only findings keep their openFindings semantics and create no decisions", () => {
    const w = withTask();
    let s = go(w.s, 1);
    s = finish(s, w.id, 2);
    s = go(s, 3);
    const [a] = running(s, w.id);
    s = M.reportCompletion(s, a.id, [], at(4), [{ name: "findings", summary: "one thing", openFindings: 2 }]);
    const art = M.acceptedOutput(s, task(s, w.id), "S2", "findings")!;
    expect(art.findings).toBeUndefined();
    expect([F.fixable(s, art), F.undecided(s, art), F.unresolved(s, art)]).toEqual([2, 0, 2]);
    expect(s.decisions).toEqual([]);
    s = go(s, 5);
    expect(running(s, w.id)[0].stepId).toBe("S3"); // the repair runs as before
  });
});

describe("runIf and the repair's wait (Q8)", () => {
  it("counts only fixable findings: a repair with only ask-user findings waits (neither dispatched nor skipped), runs on fix, skips on accept", () => {
    const { s: s0, id } = reviewed([finding({ action: "ask-user" })]);
    let s = go(s0, 5);
    expect(running(s, id)).toHaveLength(0);
    expect(step(s, id, "S3").state).toBe("pending");
    expect(M.stateLabel(s, task(s, id))).toBe("Waiting for a decision on 1 finding (you)");
    const d = s.decisions[0];
    const accepted = go(F.decideFinding(s, d.id, "accept", "fine as it is", at(6)), 7);
    expect(step(accepted, id, "S3").state).toBe("skipped");
    expect(accepted.events.some((e) => e.message === "Skipped S3: nothing to fix in C1.checks, S2.findings")).toBe(true);
    const fixed = go(F.decideFinding(s, d.id, "fix", undefined, at(6)), 7);
    expect(running(fixed, id)[0].stepId).toBe("S3");
  });

  it("an auto-fix finding next to an undecided one still waits: the repair must not start before the decision", () => {
    const { s: s0, id } = reviewed([finding({ action: "auto-fix" }), finding({ action: "ask-user" })]);
    const s = go(s0, 5);
    expect(running(s, id)).toHaveLength(0);
    expect(step(s, id, "S3").state).toBe("pending");
  });

  it("a finding without a blocking severity needs no decision and does not hold the repair", () => {
    const { s: s0, id } = reviewed([finding({ severity: "info", action: "ask-user" })]);
    const s = go(s0, 5);
    expect(s.decisions).toEqual([]);
    expect(step(s, id, "S3").state).toBe("skipped");
  });
});

describe("decisions: routing, the user's decisions, follow-ups, reopen", () => {
  it("routes to the user by default and to the lead on Autopilot; setTriageRouting changes only later decisions; routeDecision moves one", () => {
    const { s: a } = reviewed([finding({ action: "ask-user" })]);
    expect(a.decisions[0].routedTo).toBe("user");
    const { s: b } = reviewed([finding({ action: "ask-user" })], { autopilot: true });
    expect(b.project.triage.askUserBy).toBe("lead");
    expect(b.decisions[0].routedTo).toBe("lead");
    const moved = F.routeDecision(b, b.decisions[0].id, "user", at(9));
    expect(moved.decisions[0].routedTo).toBe("user");
    const re = F.setTriageRouting(moved, "user", at(10));
    expect(re.project.triage.askUserBy).toBe("user");
    expect(re.decisions[0].routedTo).toBe("user");
    expect(() => F.routeDecision(F.decideFinding(re, re.decisions[0].id, "accept", undefined, at(11)), re.decisions[0].id, "lead", at(12))).toThrow(/decided/);
  });

  it("follow-up creates a held task of yours seeded from the finding and counts as accepted here; reopen opens it again and keeps usedBy", () => {
    const { s: s0, id, art } = reviewed([finding({ action: "ask-user", title: "Needs a schema change", file: "src/db.ts", line: 7 })]);
    const d = s0.decisions[0];
    let s = F.decideFinding(s0, d.id, "follow-up", "later", at(5));
    const fu = s.decisions[0];
    expect(fu.status).toBe("follow-up");
    const t = task(s, fu.followUpTaskId!);
    expect(t.specs[0].author).toBe("user");
    expect(t.holdBeforeStart).toBe(true);
    expect(M.currentSpec(t).content.title).toBe("Needs a schema change");
    expect(M.currentSpec(t).content.whyNow).toContain("(src/db.ts:7)");
    expect(F.unresolved(s, art)).toBe(0);
    expect(F.fixable(s, art)).toBe(0);
    s = go(s, 6);
    expect(step(s, id, "S3").state).toBe("skipped");
    expect(() => F.decideFinding(s, d.id, "follow-up", undefined, at(7))).toThrow(/already follows up/);
    s = M.reportRunContext({ ...s, decisions: s.decisions.map((x) => ({ ...x, usedBy: ["run-9"] })) }, "none", {});
    const re = F.decideFinding(s, d.id, "reopen", undefined, at(8));
    expect(re.decisions[0]).toMatchObject({ status: "open", routedTo: "user", usedBy: ["run-9"] });
    expect(re.decisions[0].decidedBy).toBeUndefined();
    expect(() => F.decideFinding(re, d.id, "reopen", undefined, at(9))).toThrow(/already open/);
    expect(() => F.decideFinding(re, d.id, "fix", "x".repeat(301), at(9))).toThrow(/300/);
    expect(() => F.decideFinding(re, "fd-none", "fix", undefined, at(9))).toThrow(ControlError);
  });

  it("carries a decision forward by key to the next round, labelled, and from a pull request's origin task to its repair", () => {
    const key = "abcdefabcdef";
    const { s: s0, id } = reviewed([finding({ action: "ask-user", key, title: "Same thing" })]);
    let s = F.decideFinding(s0, s0.decisions[0].id, "accept", "not for this task", at(5));
    s = go(s, 6); // S3 skipped: nothing to fix → C2 skipped → S4 verify dispatched
    expect(running(s, id)[0].stepId).toBe("S4");
    // A second review round on this task (a re-run of S2) reports the same finding.
    s = M.rerunStep(M.acknowledgeStop(M.pauseTask(s, id, at(7)), running(s, id)[0].id, at(8)), id, "S2", at(9));
    s = M.resumeTask(s, id, at(10));
    s = go(s, 11);
    expect(running(s, id)[0].stepId).toBe("S2");
    s = finish(s, id, 12, [finding({ action: "ask-user", key, title: "Same thing" })]);
    const carried = s.decisions[s.decisions.length - 1];
    expect(carried).toMatchObject({ status: "accept", decidedBy: "carried", carriedFrom: s0.decisions[0].id, why: "not for this task" });
    expect(s.events.some((e) => e.message.includes("decided as before"))).toBe(true);
    // The repair (deliverInto the origin) inherits the origin's decisions too.
    const rep = withTask();
    task(rep.s, rep.id).deliverInto = { taskId: id, n: 1, mergeBase: false };
    let r = { ...rep.s, decisions: structuredClone(s.decisions) };
    r = go(r, 20);
    r = finish(r, rep.id, 21);
    r = go(r, 22);
    r = finish(r, rep.id, 23, [finding({ action: "ask-user", key, title: "Same thing" })]);
    expect(r.decisions[r.decisions.length - 1]).toMatchObject({ taskId: rep.id, status: "accept", decidedBy: "carried" });
    expect(step(go(r, 24), rep.id, "S3").state).toBe("skipped");
  });

  it("editArtifact refuses an open-count edit on structured findings; a summary edit carries the findings over", () => {
    const { s, art } = reviewed([finding({ action: "auto-fix" })]);
    expect(() => M.editArtifact(s, art.id, { summary: "edited", reason: "r", openFindings: 0 }, at(5))).toThrow(/decide each finding/);
    const e = M.editArtifact(s, art.id, { summary: "edited", reason: "r" }, at(5));
    const v2 = M.latestArtifact(e, task(e, art.taskId), "S2", "findings")!;
    expect(v2.author).toBe("user");
    expect(v2.findings).toEqual(art.findings);
    expect(v2.openFindings).toBe(1);
    expect(v2.pathCoverage).toEqual(art.pathCoverage);
  });
});

describe("the lead's decisions (applyLeadDecisions, Q9)", () => {
  function leadCase(fs: Finding[], author: "user" | "lead" = "lead") {
    const { s, id, art } = reviewed(fs, { autopilot: true, author });
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(5));
    return { s: r.state, id, art, runId: r.runId };
  }
  const complete = (s: State, runId: string, decisions: unknown) => M.completeLeadRun(s, runId, { reply: "ok", proposals: [], decisions }, at(6));

  it("leadDue returns decisions when a finding routed to the lead is open, without autonomy or planning caps; a run that left it open does not start another", () => {
    const { s } = reviewed([finding({ action: "ask-user" })], { autopilot: true });
    const off = M.setAutonomy(s, { ...s.project.autonomy, enabled: false }, at(5));
    expect(M.leadDue(off, T0 + 60_000, 12 * 60)).toBe("decisions");
    expect(M.leadDue(F.routeDecision(off, off.decisions[0].id, "user", at(5)), T0 + 60_000, 12 * 60)).toBeNull();
    // The lead saw it and decided nothing: no second run by itself; every later run still lists it.
    const r = M.startLeadRun(off, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(6));
    const idle = M.completeLeadRun(r.state, r.runId, { reply: "Not sure yet.", proposals: [] }, at(7));
    expect(idle.decisions[0].status).toBe("open");
    expect(M.leadDue(idle, T0 + 120_000, 12 * 60)).toBeNull();
    // Sent to the user and back to the lead after that run: due again.
    const back = F.routeDecision(F.routeDecision(idle, idle.decisions[0].id, "user", at(8)), idle.decisions[0].id, "lead", at(9));
    expect(M.leadDue(back, T0 + 120_000, 12 * 60)).toBe("decisions");
  });

  it("decides accept and fix with a reason, rejects an unknown id, the wrong route, a closed decision, a missing why and more than 20 entries", () => {
    const { s, runId, art } = leadCase([finding({ action: "ask-user" }), finding({ action: "ask-user" }), finding({ action: "ask-user" })]);
    const [d1, d2, d3] = s.decisions;
    const routed = F.routeDecision(s, d3.id, "user", at(5));
    const out = complete(routed, runId, [
      { id: d1.id, decision: "accept", why: "It is by design." },
      { id: d2.id, decision: "fix", why: "Small and in scope." },
      { id: d3.id, decision: "accept", why: "not mine" },
      { id: "fd-999", decision: "accept", why: "?" },
      { id: d1.id, decision: "fix", why: "again" },
      { decision: "accept", why: "no id" },
      { id: d2.id, decision: "maybe", why: "x" },
      ...Array.from({ length: 14 }, () => ({ id: "fd-0", decision: "accept", why: "pad" })),
    ]);
    const by = (id: string) => out.decisions.find((d) => d.id === id)!;
    expect(by(d1.id)).toMatchObject({ status: "accept", decidedBy: "lead", leadRunId: runId, why: "It is by design." });
    expect(by(d2.id)).toMatchObject({ status: "fix", decidedBy: "lead" });
    expect(by(d3.id).status).toBe("open");
    const msg = out.conversation[out.conversation.length - 1];
    expect(msg.rejected).toEqual(expect.arrayContaining([expect.stringMatching(/fd-999: not open or not yours/), expect.stringMatching(/not open or not yours/), expect.stringMatching(/not an object with an id/), expect.stringMatching(/must be fix, accept, follow-up or ask-user/), expect.stringMatching(/more than 20/)]));
    expect(F.leadRunDecisions(out, runId).map((x) => x.what)).toEqual(["decided", "decided"]);
    expect([F.fixable(out, art), F.unresolved(out, art)]).toEqual([1, 2]);
    expect(complete(s, runId, [{ id: d1.id, decision: "accept" }]).conversation.at(-1)!.rejected).toEqual([expect.stringMatching(/"why" is required/)]);
  });

  it("a lead fix on a spec the user wrote becomes a suggestion for the user and stays open; the user applies or declines it", () => {
    const { s, runId, art } = leadCase([finding({ action: "ask-user" })], "user");
    const out = complete(s, runId, [{ id: s.decisions[0].id, decision: "fix", why: "Small." }]);
    const d = out.decisions[0];
    expect(d).toMatchObject({ status: "open", routedTo: "user", suggestion: { decision: "fix", why: "Small.", leadRunId: runId } });
    expect(F.fixable(out, art)).toBe(0);
    expect(F.leadRunDecisions(out, runId)).toEqual([{ decision: d, what: "suggested" }]);
    const applied = F.decideFinding(out, d.id, "fix", "Small.", at(7));
    expect(applied.decisions[0]).toMatchObject({ status: "fix", decidedBy: "user" });
    expect(applied.decisions[0].suggestion).toBeUndefined();
  });

  it("ask-user hands the decision to the user; follow-up proposes a task under the open-proposal cap", () => {
    const { s, runId } = leadCase([finding({ action: "ask-user" }), finding({ action: "ask-user", title: "Bigger" })]);
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "ask-user", why: "It changes what you asked for." },
      { id: d2.id, decision: "follow-up", why: "Worth its own task.", title: "Do the bigger thing" },
    ]);
    expect(out.decisions.find((d) => d.id === d1.id)).toMatchObject({ status: "open", routedTo: "user", why: "It changes what you asked for." });
    const fu = out.decisions.find((d) => d.id === d2.id)!;
    expect(fu.status).toBe("follow-up");
    const t = task(out, fu.followUpTaskId!);
    expect(t.specs[0].author).toBe("lead");
    expect(M.currentSpec(t).content.title).toBe("Do the bigger thing");
    // At the cap, the follow-up is refused and the decision stays open.
    const fresh = reviewed([finding({ action: "ask-user" })], { autopilot: true, author: "lead" });
    const capped = { ...fresh.s, project: { ...fresh.s.project, autonomy: { ...fresh.s.project.autonomy, maxOpenProposals: 1 } } };
    const r2 = M.startLeadRun(capped, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(8));
    const at8 = M.completeLeadRun(r2.state, r2.runId, { reply: "", proposals: [], decisions: [{ id: capped.decisions[0].id, decision: "follow-up", why: "own task" }] }, at(9));
    expect(at8.decisions[0].status).toBe("open");
    expect(at8.conversation.at(-1)!.rejected).toEqual([expect.stringMatching(/follow-up refused/)]);
  });

  it("a lead accept on failing final checks is refused: only the user can accept failing checks", () => {
    const { s, runId } = leadCase([finding({ action: "ask-user" })]);
    const fc = { ...s, decisions: [{ ...s.decisions[0], kind: "final-checks" as const }] };
    const out = complete(fc, runId, [{ id: fc.decisions[0].id, decision: "accept", why: "good enough" }]);
    expect(out.decisions[0].status).toBe("open");
    expect(out.conversation.at(-1)!.rejected).toEqual([expect.stringMatching(/only the user can accept failing checks/)]);
    // The user's acceptance acts on the blocked Final checks step itself (checks.test.ts); a decision that names none is refused.
    expect(() => F.decideFinding(fc, fc.decisions[0].id, "accept", undefined, at(7))).toThrow(/does not belong to a Checks step/);
  });

  it("usedBy records the repair that carried a decision; a later change applies only to later repairs", () => {
    const { s: s0, id } = reviewed([finding({ action: "ask-user" })]);
    let s = F.decideFinding(s0, s0.decisions[0].id, "fix", undefined, at(5));
    s = go(s, 6);
    const repair = running(s, id)[0];
    expect(repair.stepId).toBe("S3");
    s = M.reportRunContext(s, repair.id, { decisions: [s.decisions[0].id] });
    expect(s.decisions[0].usedBy).toEqual([repair.id]);
    const changed = F.decideFinding(s, s.decisions[0].id, "accept", "changed my mind", at(7));
    expect(changed.decisions[0].usedBy).toEqual([repair.id]);
    expect(running(changed, id)[0].id).toBe(repair.id); // the running repair is not touched
    expect(changed.events.at(-1)!.message).toContain("applies to repairs that start later");
  });
});

describe("applyAutopilot and the sample project", () => {
  it("Autopilot routes decisions to the lead; the sample project starts with checks off, decisions to the user and conventions on", () => {
    const s = buildSeed(T0);
    expect(s.version).toBe(15);
    expect(s.project.checks.enabled).toBe(false);
    expect(s.project.triage).toEqual({ askUserBy: "user" });
    expect(s.project.conventions).toEqual({ include: true });
    expect(s.decisions).toEqual([]);
    expect(M.applyAutopilot(s, "main", at(1)).project.triage.askUserBy).toBe("lead");
    // Sample tasks that already ran past their Checks steps show them skipped, as the service would.
    expect(task(s, "EX-006").steps.filter((x) => x.role === "checks").map((x) => x.state)).toEqual(["skipped", "skipped"]);
  });
});
