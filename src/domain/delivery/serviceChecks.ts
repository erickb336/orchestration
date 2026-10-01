// The service's own checks on a pull request's change, run as a dedicated check task.

import * as C from "../checks";
import * as M from "../model";
import { internalFlow, flowRef } from "../flows";
import { instantiate, toDef } from "../pipeline";
import { type PrDelivery, type SpecContent, type State, type Task } from "../types";
import { event, getTask, sha12 } from "./core";
import { refreshAttention } from "./gate";
import { PR_LIMITS, prName, prTask } from "./pr";
import { mayStartWork } from "./review";

/** The dedicated check tasks of this pull request: for the change it holds now, or (`anySha`) any change of this delivery. */
export function checkTasksFor(s: State, t: Task, pr: PrDelivery, anySha = false): Task[] {
  return s.tasks.filter((x) => x.checkTarget?.taskId === t.id && x.checkTarget.n === pr.n && (anySha || x.checkTarget.sha === pr.changeSha));
}

/** Create the dedicated check task for the change the pull request holds. Mutates the draft `s`. */
function startChecks(s: State, t: Task, pr: PrDelivery, now: string): string {
  const h = sha12(pr.changeSha);
  const ids = new Set(s.tasks.map((x) => x.id));
  let k = 1;
  while (ids.has(`${t.id}-CK${k}`)) k++;
  const id = `${t.id}-CK${k}`;
  // ORC-016: the dedicated check pipeline is the service's own; no flow file can replace it.
  const checks = internalFlow("delivery-checks");
  const defs = checks.steps.map(toDef);
  const flow = flowRef(checks, "service");
  const content: SpecContent = structuredClone(M.currentSpec(t).content);
  const title = content.title;
  content.title = `Checks for merge: ${title}`;
  content.whyNow = `The change ${h} of ${t.id} has no service-check result under the current check settings. A pull request merges only once the project's checks passed on exactly its change.`;
  content.benefit = "The project's own checks run on the change before it reaches the base branch.";
  const selected = content.options.find((o) => o.id === content.selectedOptionId);
  if (selected) selected.approach = `The service runs the project's checks on ${h} of ${t.id}. No agent is involved.`;
  s.tasks.push({
    id,
    priority: t.priority,
    lifecycle: "ready",
    hold: false,
    holdBeforeStart: false,
    specs: [{ rev: 1, at: now, author: "system", reason: `Service checks on ${t.id} (${h}) before it merges into ${pr.base}`, content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    checkTarget: { taskId: t.id, n: pr.n, sha: pr.changeSha },
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "system", reason: "Created from the Delivery checks flow", steps: defs.map(toDef), flow }],
    flow,
    flowSince: 1,
  });
  pr.counters.checks = (pr.counters.checks ?? 0) + 1;
  event(s, now, "system", "integration", `Check run ${id} created for ${prName(pr)} at ${h}: no service-check result for this change under the current settings`, t.id);
  return id;
}

/**
 * Make sure one dedicated check run exists when the change needs one (§6.9): checks are on, the
 * change has no result under the current settings, no check task for it is open, fewer than the cap
 * were started, and nothing is paused. A failed result is a repair's job, never another run's.
 */
export function ensureChecks(state: State, taskId: string, now: string): State {
  const { task, pr } = prTask(state, taskId);
  if (pr.phase !== "built" && pr.phase !== "open") return state;
  if (!C.checksOn(state.project.checks) || !mayStartWork(state, pr)) return state;
  const ev = C.checkEvidence(state, pr.changeSha);
  if (ev.ok || ev.attemptId) return state;
  if (checkTasksFor(state, task, pr).some((x) => x.lifecycle !== "cancelled" && x.lifecycle !== "done")) return state;
  if ((pr.counters.checks ?? 0) >= PR_LIMITS.checks) return state;
  const s = structuredClone(state);
  const t = getTask(s, taskId);
  startChecks(s, t, t.integration!.pr!, now);
  refreshAttention(s, t, now);
  return s;
}
