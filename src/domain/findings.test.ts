// Structured findings, the derived counts, decisions and their routing, carry-forward,
// the lead's decisions, and the Checks steps that skip while checks are off. Pure domain tests.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as F from "./findings";
import * as M from "./model";
import { needsYouItems } from "./needsYou";
import { buildSeed } from "./seed";
import { buildingSpend, maintenanceEstimate, pastBudget } from "./spend";
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

/** A fresh seed with every sample task held, plus one user task on the Change flow (S1 → C1 → S2 → S3 → C2 → S4). */
function withTask(opts: { autopilot?: boolean; route?: "lead" | "pe" | "user"; author?: "user" | "lead" } = {}): { s: State; id: string } {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  if (opts.autopilot) s = M.applyAutopilot(s, "main", at(0));
  if (opts.route) s = F.setTriageRouting(s, opts.route, at(0));
  const r = M.createTask(s, { title: "Change", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
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
  const done = M.reportCompletion(s, a.id, [], at(t), outputs);
  return st.role === "code_reviewer" ? securityClean(done, id, t) : done;
}

/** The security review runs beside the code review. These tests are about the code review, so once it completes the security review is dispatched and completed clean. */
function securityClean(s: State, id: string, t: number): State {
  let next = M.dispatchEligible(s, at(t));
  for (const a of running(next, id)) if (step(next, id, a.stepId).role === "security_reviewer") next = M.reportCompletion(next, a.id, [], at(t), [{ name: "findings", summary: "no security findings", findings: [], openFindings: 0 }]);
  return next;
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
    expect(task(s, w.id).steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "SR1", "S3", "C2", "S4"]);
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

describe("derived counts", () => {
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
    s = securityClean(s, w.id, 4);
    const art = M.acceptedOutput(s, task(s, w.id), "S2", "findings")!;
    expect(art.findings).toBeUndefined();
    expect([F.fixable(s, art), F.undecided(s, art), F.unresolved(s, art)]).toEqual([2, 0, 2]);
    expect(s.decisions).toEqual([]);
    s = go(s, 5);
    expect(running(s, w.id)[0].stepId).toBe("S3"); // the repair runs as before
  });
});

describe("runIf and the repair's wait", () => {
  it("counts only fixable findings: a repair with only ask-user findings waits (neither dispatched nor skipped), runs on fix, skips on accept", () => {
    const { s: s0, id } = reviewed([finding({ action: "ask-user" })]);
    let s = go(s0, 5);
    expect(running(s, id)).toHaveLength(0);
    expect(step(s, id, "S3").state).toBe("pending");
    expect(M.stateLabel(s, task(s, id))).toBe("Needs you: decide 1 finding");
    const d = s.decisions[0];
    const accepted = go(F.decideFinding(s, d.id, "accept", "fine as it is", at(6)), 7);
    expect(step(accepted, id, "S3").state).toBe("skipped");
    expect(accepted.events.some((e) => e.message === "Skipped S3: nothing to fix in C1.checks, S2.findings, SR1.findings")).toBe(true);
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
  it("routes to the user by default, to the PE on Autopilot and to the lead when chosen; setTriageRouting changes only later decisions; routeDecision moves one", () => {
    const { s: a } = reviewed([finding({ action: "ask-user" })]);
    expect(a.decisions[0].routedTo).toBe("user");
    const { s: pe } = reviewed([finding({ action: "ask-user" })], { autopilot: true });
    expect([pe.project.triage.askUserBy, pe.decisions[0].routedTo]).toEqual(["pe", "pe"]);
    const { s: b } = reviewed([finding({ action: "ask-user" })], { autopilot: true, route: "lead" });
    expect(b.project.triage.askUserBy).toBe("lead");
    expect(b.decisions[0].routedTo).toBe("lead");
    const moved = F.routeDecision(b, b.decisions[0].id, "user", at(9));
    expect(moved.decisions[0].routedTo).toBe("user");
    const re = F.setTriageRouting(moved, "user", at(10));
    expect(re.project.triage.askUserBy).toBe("user");
    expect(re.decisions[0].routedTo).toBe("user");
    expect(() => F.routeDecision(F.decideFinding(re, re.decisions[0].id, "accept", undefined, at(11)), re.decisions[0].id, "lead", at(12))).toThrow(/decided/);
  });

  it("one decision moves between the lead and you only: a decision reaches the PE through the project's route, never one by one (review finding 9)", () => {
    const { s } = reviewed([finding({ action: "ask-user" })]);
    const id = s.decisions[0].id;
    expect(() => F.routeDecision(s, id, "pe" as never, at(9))).toThrow("Send a decision to the lead or to you.");
    expect(() => runCommand(s, "routeDecision", { decisionId: id, to: "pe" }, at(9))).toThrow("to must be lead or user");
    expect(F.routeDecision(s, id, "lead", at(9)).events.at(-1)!.message).toBe(`${id} sent to the lead`);
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

describe("the lead's decisions (applyLeadDecisions)", () => {
  function leadCase(fs: Finding[], author: "user" | "lead" = "lead") {
    const { s, id, art } = reviewed(fs, { autopilot: true, route: "lead", author });
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(5));
    return { s: r.state, id, art, runId: r.runId };
  }
  const complete = (s: State, runId: string, decisions: unknown) => M.completeLeadRun(s, runId, { reply: "ok", proposals: [], decisions }, at(6));

  it("leadDue returns decisions when a finding routed to the lead is open, without autonomy or planning caps; a run that left it open does not start another", () => {
    const { s } = reviewed([finding({ action: "ask-user" })], { autopilot: true, route: "lead" });
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
    const fresh = reviewed([finding({ action: "ask-user" })], { autopilot: true, route: "lead", author: "lead" });
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
  it("Autopilot routes decisions to the PE; the sample project starts with checks off, decisions to the user and conventions on", () => {
    const s = buildSeed(T0);
    expect(s.version).toBe(19);
    expect(s.project.checks.enabled).toBe(false);
    expect(s.project.triage).toEqual({ askUserBy: "user" });
    expect(s.project.conventions).toEqual({ include: true });
    expect(s.decisions).toEqual([]);
    expect(M.applyAutopilot(s, "main", at(1)).project.triage.askUserBy).toBe("pe");
    // Sample tasks that already ran past their Checks steps show them skipped, as the service would.
    expect(task(s, "EX-006").steps.filter((x) => x.role === "checks").map((x) => x.state)).toEqual(["skipped", "skipped"]);
  });
});

describe("the PE's route (ORC-029 2d)", () => {
  /** Findings that ask for a decision, on Autopilot (the PE's route), with the budgets given; a decision run started. */
  /** Every finished run so far has a recorded cost ($0): a run with none makes the building spend unknown. */
  function priced(s0: State): State {
    const s = structuredClone(s0);
    for (const r of [...s.attempts, ...s.leadRuns]) if (r.outcome !== "running" && r.outcome !== "stopping") r.usage ??= { costUsd: 0 };
    return s;
  }
  function peCase(n: number, budgets: { buildingUsd: number | null; maintenanceUsdPerMonth: number | null }, author: "user" | "lead" = "lead") {
    const fs = Array.from({ length: n }, () => finding({ action: "ask-user" }));
    const { s: s0, id, art } = reviewed(fs, { autopilot: true, author });
    expect(s0.decisions.map((d) => d.routedTo)).toEqual(fs.map(() => "pe"));
    const r = M.startLeadRun(M.setBudgets(priced(s0), budgets, at(5)), { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(5));
    return { s: r.state, id, art, runId: r.runId };
  }
  /** The pre-flight estimated the maintenance at `usd` a month (the PE's pre-flight, pass 6, makes this estimate). */
  function estimated(s0: State, usd: number): State {
    const s = structuredClone(s0);
    s.project.factoryStarts.push({ at: at(1), by: "user", blueprintRev: 0, visionRev: 1, settings: M.startFactoryRequest(s).settings, openItems: [], estimate: { maintenanceUsdPerMonth: [0, usd], basis: "The pre-flight" } });
    return s;
  }
  /** The decision run completes, with its own cost recorded. */
  const complete = (s: State, runId: string, decisions: unknown) => M.completeLeadRun(s, runId, { reply: "ok", proposals: [], decisions }, at(6), { usage: { costUsd: 0 } });
  const zero = { buildUsd: [0, 0], maintenanceUsdPerMonth: [0, 0], basis: "Nothing is built or run" };

  it("a call within the budgets is the PE's: recorded with its reasons, its cost, and the lead run that made it with the PE's brief", () => {
    const { s: s0, runId, art } = peCase(2, { buildingUsd: 20, maintenanceUsdPerMonth: 10 });
    const s = estimated(s0, 0);
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "accept", why: "It holds at the stated scale.", cost: zero },
      { id: d2.id, decision: "fix", why: "Small, and it keeps the schema stable.", cost: { buildUsd: [1, 4], maintenanceUsdPerMonth: [0, 2], basis: "Two recent repair runs" } },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "accept", decidedBy: "pe", leadRunId: runId, why: "It holds at the stated scale.", pe: { decision: "accept", why: "It holds at the stated scale.", cost: zero, by: "lead-run", leadRunId: runId, at: at(6) } });
    expect(out.decisions[1]).toMatchObject({ status: "fix", decidedBy: "pe", pe: { decision: "fix", cost: { buildUsd: [1, 4], maintenanceUsdPerMonth: [0, 2], basis: "Two recent repair runs" } } });
    expect(out.decisions.map((d) => d.pe?.pastBudget)).toEqual([undefined, undefined]);
    expect(F.fixable(out, art)).toBe(1);
    expect(F.decisionLabel(out.decisions[1])).toBe("decided: fix, by the PE (a lead run with the PE's brief): Small, and it keeps the schema stable.");
    expect(out.events.map((e) => e.message)).toContain(`${d2.id}: fix for ${d2.findingId} "${d2.finding.title}" as the PE (lead run ${runId}, with the PE's brief; build $1.00–$4.00, maintenance $0.00–$2.00 a month (Two recent repair runs)) — Small, and it keeps the schema stable.`);
    // With no budget set, a call that states no cost is taken, and the record says it stated none.
    const free = peCase(1, { buildingUsd: null, maintenanceUsdPerMonth: null });
    const taken = complete(free.s, free.runId, [{ id: free.s.decisions[0].id, decision: "accept", why: "Fine as it is." }]).decisions[0];
    expect(taken).toMatchObject({ status: "accept", decidedBy: "pe" });
    expect(taken.pe?.cost).toBeUndefined();
  });

  it("never past a budget: a call that would take the building spend or the maintenance estimate past a budget goes to the owner, even on Autopilot", () => {
    const { s: s0, runId, art } = peCase(5, { buildingUsd: 5, maintenanceUsdPerMonth: 10 });
    const s = estimated(s0, 0);
    const [d1, d2, d3, d4, d5] = s.decisions;
    expect(M.autonomyMode(s.project.autonomy)).toBe("autopilot");
    const out = complete(s, runId, [
      { id: d1.id, decision: "fix", why: "Rebuild the table.", cost: { buildUsd: [2, 8], maintenanceUsdPerMonth: [0, 0], basis: "Similar migrations" } },
      { id: d2.id, decision: "accept", why: "Keep the hosted index.", cost: { buildUsd: [0, 0], maintenanceUsdPerMonth: [4, 6], basis: "The provider's price list" } },
      { id: d3.id, decision: "follow-up", why: "Add a second index.", cost: { buildUsd: [0, 1], maintenanceUsdPerMonth: [3, 5], basis: "The provider's price list" } },
      { id: d4.id, decision: "accept", why: "Fine.", cost: { maintenanceUsdPerMonth: [0, 0], basis: "Nothing runs" } },
      { id: d5.id, decision: "accept", why: "Fine.", cost: { buildUsd: [3, 1], maintenanceUsdPerMonth: [0, 0], basis: "?" } },
    ]);
    const by = (id: string) => out.decisions.find((d) => d.id === id)!;
    // Past the building budget: the owner's, with the PE's call kept; nothing is fixed.
    expect(by(d1.id)).toMatchObject({ status: "open", routedTo: "user", leadRunId: runId, pe: { decision: "fix", pastBudget: "up to $8.00 more would take the building spend to $8.00, past the $5.00 budget ($0.00 spent)" } });
    expect(F.fixable(out, art)).toBe(0);
    // Within budget, the maintenance call stands and counts in the estimate; the next one would pass the budget.
    expect(by(d2.id)).toMatchObject({ status: "accept", decidedBy: "pe" });
    expect(by(d3.id)).toMatchObject({ status: "open", routedTo: "user", pe: { decision: "follow-up", pastBudget: "up to $5.00 more a month would take the maintenance estimate to $11.00, past the $10.00 budget" } });
    expect(by(d3.id).followUpTaskId).toBeUndefined();
    // No figure for a budget that is set, or a figure that cannot be read: unknown is never zero.
    expect(by(d4.id).pe?.pastBudget).toBe("it states no building cost, and the building budget is $5.00");
    expect(by(d5.id).pe?.pastBudget).toBe("its budget effect could not be read (The building estimate is a range of dollars, low to high.)");
    expect(by(d4.id).routedTo).toBe("user");
    // Each is a decision for the owner under Needs you.
    const needs = needsYouItems(out, T0 + 60_000).filter((i) => i.kind === "finding").map((i) => i.key);
    expect(needs).toEqual(expect.arrayContaining([d1.id, d3.id, d4.id, d5.id]));
    expect(needs).not.toContain(d2.id);
    expect(out.events.map((e) => e.message)).toContain(`${d1.id}: the PE would fix ${d1.findingId} "${d1.finding.title}", but up to $8.00 more would take the building spend to $8.00, past the $5.00 budget ($0.00 spent); spending past a budget is yours to decide`);
  });

  it("counts what was spent: once spending is past the budget, a call that adds nothing still stands and one that adds anything is the owner's", () => {
    const { s: s0, runId } = peCase(2, { buildingUsd: 5, maintenanceUsdPerMonth: null });
    const s = structuredClone(s0);
    s.attempts.find((a) => a.outcome === "completed" && a.snapshot.provider !== "service")!.usage = { costUsd: 7 };
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "accept", why: "Nothing to build.", cost: { buildUsd: [0, 0], basis: "Accepting builds nothing" } },
      { id: d2.id, decision: "fix", why: "A small fix.", cost: { buildUsd: [0, 1], basis: "One repair run" } },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "accept", decidedBy: "pe" });
    expect(out.decisions[1]).toMatchObject({ status: "open", routedTo: "user", pe: { pastBudget: "up to $1.00 more would take the building spend to $8.00, past the $5.00 budget ($7.00 spent)" } });
  });

  it("a run with no recorded cost and no spend limit makes the building spend unknown, never $0: a call that adds any building cost goes to the owner (review finding 2)", () => {
    const { s: s0, runId } = peCase(3, { buildingUsd: 50, maintenanceUsdPerMonth: null });
    const s = structuredClone(s0);
    const run = s.attempts.find((a) => a.outcome === "completed" && a.snapshot.provider !== "service")!;
    delete run.usage;
    // A Claude run counts at its run limit, its spend cap (B-02); a Codex run has none, so nothing bounds it.
    expect(buildingSpend({ ...s, attempts: s.attempts.map((a) => (a.id === run.id ? { ...a, snapshot: { ...a.snapshot, provider: "claude" } } : a)) }).unknown).toMatchObject([{ countedUsd: 2 }]);
    run.snapshot.provider = "codex";
    expect(buildingSpend(s).unknown).toMatchObject([{ countedUsd: null }]);
    const [d1, d2, d3] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "accept", why: "Nothing to build.", cost: { buildUsd: [0, 0], basis: "Accepting builds nothing" } },
      { id: d2.id, decision: "fix", why: "A small fix.", cost: { buildUsd: [0, 1], basis: "One repair run" } },
      { id: d3.id, decision: "accept", why: "Fine.", cost: { maintenanceUsdPerMonth: [0, 0], basis: "Nothing runs" } },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "accept", decidedBy: "pe" });
    expect(out.decisions[1]).toMatchObject({ status: "open", routedTo: "user", pe: { pastBudget: "1 run has no recorded cost and no spend limit, so up to $1.00 more cannot be checked against the $50.00 budget" } });
    expect(out.decisions[2].pe?.pastBudget).toBe("it states no building cost, and the building budget is $50.00");
  });

  it("the building check is cumulative: the PE calls that stand count at their high end until their work has run, and then only its recorded cost does (review finding 3)", () => {
    const { s, runId } = peCase(2, { buildingUsd: 10, maintenanceUsdPerMonth: null });
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "fix", why: "The first fix.", cost: { buildUsd: [4, 8], basis: "Similar repairs" } },
      { id: d2.id, decision: "fix", why: "The second fix.", cost: { buildUsd: [4, 8], basis: "Similar repairs" } },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "fix", decidedBy: "pe", usedBy: [] });
    expect(out.decisions[1]).toMatchObject({
      status: "open",
      routedTo: "user",
      pe: { pastBudget: "up to $8.00 more would take the building spend to $16.00, past the $10.00 budget ($0.00 spent, up to $8.00 committed to PE calls whose work has not run)" },
    });
    // The repair that carried the first fix has run: its recorded $3 counts, not the $8 the PE stated.
    const ran = structuredClone(out);
    const repair = ran.attempts.find((a) => a.outcome === "completed" && a.snapshot.provider !== "service")!;
    repair.usage = { costUsd: 3 };
    ran.decisions[0].usedBy = [repair.id];
    expect(pastBudget(ran, { buildUsd: [0, 7], basis: "x" })).toBeUndefined();
    expect(pastBudget(ran, { buildUsd: [0, 8], basis: "x" })).toBe("up to $8.00 more would take the building spend to $11.00, past the $10.00 budget ($3.00 spent)");
  });

  it("a PE follow-up counts as committed until its task starts; the owner's taking of a PE call counts too (review finding 3)", () => {
    const { s, runId } = peCase(2, { buildingUsd: 10, maintenanceUsdPerMonth: null });
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "follow-up", why: "Its own task.", cost: { buildUsd: [2, 5], basis: "Similar tasks" } },
      { id: d2.id, decision: "fix", why: "Rebuild it.", cost: { buildUsd: [6, 9], basis: "Similar work" } },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "follow-up", decidedBy: "pe" });
    expect(out.decisions[1]).toMatchObject({ status: "open", routedTo: "user" });
    expect(pastBudget(out, { buildUsd: [0, 6], basis: "x" })).toContain("($0.00 spent, up to $5.00 committed to PE calls whose work has not run)");
    // The owner takes the PE's call past the budget: it stands, and counts.
    const taken = F.decideFinding(out, d2.id, "fix", undefined, at(7));
    expect(pastBudget(taken, { buildUsd: [0, 1], basis: "x" })).toBe("up to $1.00 more would take the building spend to $15.00, past the $10.00 budget ($0.00 spent, up to $14.00 committed to PE calls whose work has not run)");
    // Once the follow-up's task has started, its runs count when they finish, not the PE's figure.
    const started = structuredClone(taken);
    started.attempts.push({ ...structuredClone(started.attempts[0]), id: "run-follow-up", taskId: out.decisions[0].followUpTaskId!, outcome: "running" });
    expect(pastBudget(started, { buildUsd: [0, 1], basis: "x" })).toBeUndefined();
  });

  it("the maintenance estimate keeps a PE call the owner took: $80 stands, the owner takes $50, and $15 more goes to the owner (review finding 4)", () => {
    const { s: s0, runId } = peCase(3, { buildingUsd: null, maintenanceUsdPerMonth: 100 });
    const s = estimated(s0, 0);
    const [d1, d2, d3] = s.decisions;
    const cost = (lo: number, hi: number) => ({ maintenanceUsdPerMonth: [lo, hi], basis: "The provider's price list" });
    const out = complete(s, runId, [
      { id: d1.id, decision: "accept", why: "Keep the hosted index.", cost: cost(60, 80) },
      { id: d2.id, decision: "accept", why: "Keep the second index.", cost: cost(40, 50) },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "accept", decidedBy: "pe" });
    expect(out.decisions[1]).toMatchObject({ status: "open", routedTo: "user", pe: { pastBudget: "up to $50.00 more a month would take the maintenance estimate to $130.00, past the $100.00 budget" } });
    const taken = F.decideFinding(out, d2.id, "accept", "Worth it.", at(7));
    const r = M.startLeadRun(taken, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(8));
    const next = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], decisions: [{ id: d3.id, decision: "accept", why: "Small.", cost: cost(10, 15) }] }, at(9), { usage: { costUsd: 0 } });
    expect(next.decisions[2]).toMatchObject({ status: "open", routedTo: "user", pe: { pastBudget: "up to $15.00 more a month would take the maintenance estimate to $145.00, past the $100.00 budget" } });
    // A call the owner reversed no longer counts.
    const reversed = F.decideFinding(taken, d2.id, "fix", "Drop the second index instead.", at(10));
    expect(pastBudget(reversed, { buildUsd: [0, 0], maintenanceUsdPerMonth: [0, 20], basis: "x" })).toBeUndefined();
  });

  it("while the pre-flight has not estimated the maintenance, it is unknown, never $0: a call that adds any maintenance cost goes to the owner", () => {
    const { s, runId } = peCase(2, { buildingUsd: null, maintenanceUsdPerMonth: 100 });
    expect(s.project.factoryStarts.at(-1)?.estimate).toBeUndefined();
    expect(maintenanceEstimate(s)).toEqual({ startUsd: null, callsUsd: 0 });
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "accept", why: "Nothing runs.", cost: { maintenanceUsdPerMonth: [0, 0], basis: "Nothing runs" } },
      { id: d2.id, decision: "accept", why: "A small index.", cost: { maintenanceUsdPerMonth: [1, 2], basis: "The provider's price list" } },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "accept", decidedBy: "pe" });
    expect(out.decisions[1]).toMatchObject({ status: "open", routedTo: "user", pe: { pastBudget: "the project's maintenance is not yet estimated, so up to $2.00 more a month cannot be checked against the $100.00 budget" } });
    // Once estimated, the same call is within the budget.
    expect(pastBudget(estimated(out, 10), { maintenanceUsdPerMonth: [1, 2], basis: "x" })).toBeUndefined();
    expect(maintenanceEstimate(estimated(F.decideFinding(out, d2.id, "accept", undefined, at(7)), 10))).toEqual({ startUsd: 10, callsUsd: 2 });
  });

  it("a fix suggestion names the PE only when the PE made it, not when an earlier PE call stays on the record (review finding 9)", () => {
    const { s, runId } = peCase(1, { buildingUsd: null, maintenanceUsdPerMonth: null }, "user");
    const [d1] = s.decisions;
    const out = complete(s, runId, [{ id: d1.id, decision: "fix", why: "Small.", cost: zero }]);
    expect(F.decisionLabel(out.decisions[0])).toBe("suggested fix by the PE, waiting for the user: Small.");
    // You reopen it and send it to the lead, whose run suggests the fix: the suggestion is the lead's.
    const sent = F.routeDecision(F.decideFinding(out, d1.id, "reopen", undefined, at(7)), d1.id, "lead", at(8));
    const r = M.startLeadRun(sent, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(9));
    const next = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], decisions: [{ id: d1.id, decision: "fix", why: "The lead would fix it." }] }, at(10), { usage: { costUsd: 0 } });
    expect(next.decisions[0]).toMatchObject({ suggestion: { leadRunId: r.runId }, pe: { leadRunId: runId } });
    expect(F.decisionLabel(next.decisions[0])).toBe("suggested fix by the lead, waiting for the user: The lead would fix it.");
    expect(F.currentPeCall(next.decisions[0])).toBeUndefined();
    expect(F.currentPeCall(out.decisions[0])).toBe(out.decisions[0].pe);
  });

  it("the owner reverses a PE call as they reverse the lead's, and takes a call past a budget; the PE's call stays on the record", () => {
    const { s, runId, art } = peCase(2, { buildingUsd: 5, maintenanceUsdPerMonth: null });
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "accept", why: "Leave it.", cost: { buildUsd: [0, 0], basis: "Nothing is built" } },
      { id: d2.id, decision: "fix", why: "Rebuild it.", cost: { buildUsd: [6, 9], basis: "Similar work" } },
    ]);
    const reversed = F.decideFinding(out, d1.id, "fix", "I want it fixed.", at(7));
    expect(reversed.decisions[0]).toMatchObject({ status: "fix", decidedBy: "user", why: "I want it fixed.", pe: { decision: "accept", why: "Leave it.", leadRunId: runId } });
    expect(reversed.decisions[0].leadRunId).toBeUndefined();
    expect(F.fixable(reversed, art)).toBe(1);
    expect(reversed.events.at(-1)!.message).toBe(`${d1.id}: fix for ${d1.findingId} "${d1.finding.title}" (reversing the PE's call: accept) — I want it fixed.`);
    const reopened = F.decideFinding(out, d1.id, "reopen", undefined, at(7));
    expect(reopened.decisions[0]).toMatchObject({ status: "open", routedTo: "user" });
    expect(reopened.events.at(-1)!.message).toBe(`${d1.id} reopened (reversing the PE's call: accept)`);
    // The call past the budget is the owner's to take; the record keeps what the PE would have done and why it did not.
    const taken = F.decideFinding(out, d2.id, "accept", undefined, at(8));
    expect(taken.decisions[1]).toMatchObject({ status: "accept", decidedBy: "user", pe: { decision: "fix", pastBudget: expect.stringContaining("past the $5.00 budget") } });
  });

  it("a PE fix on a spec the user wrote is a suggestion for the user, as the lead's is; ask-user hands it over", () => {
    const { s, runId } = peCase(2, { buildingUsd: null, maintenanceUsdPerMonth: null }, "user");
    const [d1, d2] = s.decisions;
    const out = complete(s, runId, [
      { id: d1.id, decision: "fix", why: "Small.", cost: zero },
      { id: d2.id, decision: "ask-user", why: "It changes what you asked for." },
    ]);
    expect(out.decisions[0]).toMatchObject({ status: "open", routedTo: "user", suggestion: { decision: "fix", leadRunId: runId }, pe: { decision: "fix" } });
    expect(F.decisionLabel(out.decisions[0])).toBe("suggested fix by the PE, waiting for the user: Small.");
    expect(out.decisions[1]).toMatchObject({ status: "open", routedTo: "user", why: "It changes what you asked for." });
    expect(out.events.map((e) => e.message)).toContain(`${d2.id} sent to you by the PE: It changes what you asked for.`);
  });
});

describe("a follow-up of a finding cites the design parts it fixes (ORC-029 pass 5)", () => {
  /** Two approved screens in force, both cited by the reviewed task. */
  function withItems(s0: State, id: string): State {
    const s = structuredClone(s0);
    const item = (k: number) => ({ id: `bi-${k}`, kind: "screen" as const, title: `Screen ${k}`, artifactId: `sa-${k}`, version: 1, status: "approved" as const });
    s.blueprint.revisions.push({ rev: s.blueprint.revisions.length + 1, at: at(0), visionRev: 1, reason: "approved two screens", items: [item(1), item(2)] });
    M.currentSpec(task(s, id)).content.blueprintRefs = ["bi-1", "bi-2"];
    return s;
  }
  const refsOf = (s: State, taskId: string) => M.currentSpec(task(s, taskId)).content.blueprintRefs;

  it("your follow-up cites the parts the finding names, or every part the task cites when it names none", () => {
    const named = reviewed([finding({ action: "ask-user", title: "[bi-2] The map is above the days" })]);
    let s = F.decideFinding(withItems(named.s, named.id), named.s.decisions[0].id, "follow-up", undefined, at(5));
    expect(refsOf(s, s.decisions[0].followUpTaskId!)).toEqual(["bi-2"]);
    const none = reviewed([finding({ action: "ask-user", title: "The spacing is uneven" })]);
    s = F.decideFinding(withItems(none.s, none.id), none.s.decisions[0].id, "follow-up", undefined, at(5));
    expect(refsOf(s, s.decisions[0].followUpTaskId!)).toEqual(["bi-1", "bi-2"]);
  });

  it("the lead's follow-up does the same", () => {
    const { s: s0, id } = reviewed([finding({ action: "ask-user", title: "[bi-1] The header is missing" })], { autopilot: true, route: "lead", author: "lead" });
    const r = M.startLeadRun(withItems(s0, id), { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(5));
    const out = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], decisions: [{ id: s0.decisions[0].id, decision: "follow-up", why: "Its own task." }] }, at(6));
    const fu = out.decisions.find((d) => d.id === s0.decisions[0].id)!;
    expect(fu.status).toBe("follow-up");
    expect(refsOf(out, fu.followUpTaskId!)).toEqual(["bi-1"]);
  });
});
