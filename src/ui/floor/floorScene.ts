// Test fixture (pure): a factory floor with work in four areas, for the tests of Home after the start and for a seeded
// browser pass (scripts/floor-browser-pass.mjs). Not used by the application.
//
// Built on the pass 5 change-order factory (src/domain/testing/changeOrders.ts) through the real commands:
// - Trips: "Trip plan screen" runs (building), "Trip list screen" waits for the owner's go-ahead, "Outing reminders"
//   waits, and "Early trip plan" finished; change order 2 (the lead has not answered it yet) touches all four;
// - Sharing: "Invite sheet" is in review, after the PE accepted a finding as is (a trade-off call within budget);
//   "Join from an invite" landed;
// - CLI: "trips plan and share" finished its first step and waits at the checks;
// - Offline: "Offline maps" waits for the owner's go-ahead.
// Budgets: building $40, maintenance $50 a month; the PE's pre-flight estimate (a fixture: nothing writes it yet) is
// $9–$16 to build and $25–$35 a month. Each finished run costs $1.10.

import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import { landTask } from "../../domain/testing/blueprintScene";
import { at, changeOrdered } from "../../domain/testing/changeOrders";
import type { OutputReport } from "../../domain/model/runs";
import type { Finding, State } from "../../domain/types";

export interface FloorScene {
  s: State;
  tasks: { invite: string; joined: string; cli: string; offline: string; running: string; queued: string; retiring: string; early: string };
  /** The PE's call on the Invite sheet's finding. */
  decisionId: string;
}

const create = (s: State, title: string, area: string, hold: boolean, sec: number) => {
  const r = M.createTask(s, { title, area, outcome: `${title} works.`, benefit: "", whyNow: "", approach: "Build it.", acceptance: ["It works."], priority: 2, holdBeforeStart: hold, flowId: "change" }, at(sec));
  return { s: r.state, id: r.newId };
};

/** Complete every running step of the task, a review with these findings. */
function finishRunning(s0: State, taskId: string, sec: number, findings: Finding[] = []): State {
  let s = s0;
  for (const a of M.activeAttempts(s, taskId)) {
    const st = s.tasks.find((t) => t.id === taskId)!.steps.find((x) => x.id === a.stepId)!;
    const outputs: OutputReport[] = st.outputs.map((o) =>
      o.kind === "review-findings" ? { name: o.name, summary: "review", findings: st.role === "code_reviewer" ? findings : [], openFindings: 0 } : { name: o.name, summary: `${o.name} done` },
    );
    s = M.reportCompletion(s, a.id, [], at(sec), outputs);
  }
  return s;
}

const go = (s: State, sec: number) => M.dispatchEligible(M.leadPromoteProposals(s, at(sec)), at(sec));

export function floorScene(): FloorScene {
  const co = changeOrdered("lead");
  // The budgets are set last, once every finished run has its cost: a run with no recorded cost stops new work.
  let s = F.setTriageRouting(co.s, "pe", at(19));

  // Sharing: the Invite sheet is implemented, then reviewed with one finding that asks for a decision.
  const invite = create(s, "Invite sheet", "Sharing", false, 20);
  s = go(invite.s, 21);
  s = go(finishRunning(s, invite.id, 22), 23);
  const finding: Finding = { id: "F1", key: "invite-expiry", source: "review", severity: "warning", action: "ask-user", title: "Invite links never expire", detail: "A link shared in a group chat keeps working for anyone who has it.", why: "Expiry costs a renewal flow; the trip is private by link anyway." };
  s = finishRunning(s, invite.id, 24, [finding]);
  // The PE's call, within budget: accept it as is (a lead decision run with the PE's brief).
  const decisionId = s.decisions.find((d) => d.taskId === invite.id)!.id;
  const lead = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(24));
  s = M.completeLeadRun(
    lead.state,
    lead.runId,
    { reply: "ok", proposals: [], decisions: [{ id: decisionId, decision: "accept", why: "The link is private to the group, and expiry needs a renewal flow nobody asked for. A link can be withdrawn by hand.", cost: { buildUsd: [0, 0], maintenanceUsdPerMonth: [0, 0], basis: "Nothing is built or run" } }] } as never,
    at(25),
    { usage: { costUsd: 0.4 } },
  );
  s = go(s, 26);

  const joined = create(s, "Join from an invite", "Sharing", false, 27);
  s = landTask(joined.s, joined.id, at(40));

  // CLI: implemented, waiting at its checks.
  const cli = create(s, "trips plan and share", "CLI", false, 28);
  s = finishRunning(go(cli.s, 29), cli.id, 30);

  // Offline: waits for the owner's go-ahead.
  const offline = create(s, "Offline maps", "Offline", true, 31);
  s = structuredClone(offline.s);
  for (const r of [...s.attempts, ...s.leadRuns]) if (r.outcome !== "running" && r.outcome !== "stopping") r.usage ??= { costUsd: 1.1 };
  s.project.factoryStarts.at(-1)!.estimate = { buildUsd: [9, 16], maintenanceUsdPerMonth: [25, 35], basis: "The PE's pre-flight: similar screens, and storage for 1,000 users" };
  s = M.setBudgets(s, { buildingUsd: 40, maintenanceUsdPerMonth: 50 }, at(32));
  return { s, tasks: { invite: invite.id, joined: joined.id, cli: cli.id, offline: offline.id, ...co.tasks }, decisionId };
}
