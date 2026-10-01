// Which flow a task runs: the flow a new task gets, changing a task's flow, the default flow and the
// flow list.

import * as C from "../checks";
import * as F from "../findings";
import { isInternalFlowId } from "../internalFlows";
import { eligible, eligibleIds, findFlow, flowRef, serviceFlow } from "../flows";
import { instantiate, toDef, validatePipeline } from "../pipeline";
import { type ModelSelection, type State, type StepDef, type Task, type Flow, ControlError, StaleWriteError } from "../types";
import { activeAttempts, draft, event, getTask, isOpen, isSettled, touch } from "./core";
import { descendants } from "./fanout";

/** The flow a task may be created from by its id: one of the six, never an internal one. */
export function creationFlow(s: State, flowId: string): Flow {
  if (isInternalFlowId(flowId)) {
    throw new ControlError(flowId === "revert" ? "The Revert flow is used by Send back only." : `The ${flowId === "delivery-review" ? "Delivery review" : "Delivery checks"} flow is used by the service only.`);
  }
  const p = findFlow(s, flowId) ?? (flowId === "change" || flowId === "bugfix" ? serviceFlow(s, flowId) : undefined);
  if (!p) throw new ControlError(`Unknown flow ${flowId}`);
  return p;
}

/** Who asks for a flow change. The lead has no verb for it yet; when it gets one, the child rule applies to it as well. */
type FlowChanger = "user" | "lead";

/**
 * A task the service made for pull-request delivery: a dedicated review of a pull request, a check run of
 * its change, a fix pushed onto it, or a revert of a landed commit (Send back). Its pipeline is the service's
 * (an internal flow, never changeable), and it is not the product's own work on the board or in progress.
 */
export const serviceOwned = (t: Task) => !!(t.reviewTarget || t.checkTarget || t.revertOf || t.deliverInto);

/**
 * Why a task's flow cannot change right now, or undefined. Preconditions 1, 2, 5 and 6 of §7.1: open,
 * not service-owned, no open child task, and either never run or confirmed Paused (held, with no attempt
 * still running or stopping). With `p`, also precondition 4: a child task may not take a flow that breaks down.
 */
export function flowChangeBlocker(s: State, t: Task, p?: Flow, by: FlowChanger = "user"): string | undefined {
  if (t.lifecycle === "done") return "Done tasks keep the pipeline they ran. Create a follow-up and choose its flow there.";
  if (t.lifecycle === "cancelled") return `${t.id} is cancelled.`;
  if (serviceOwned(t)) return "This task's pipeline is set by pull-request delivery.";
  if (p) {
    if (t.parentTaskId && p.breaksDown) return `${p.name} breaks down into child tasks, which a child task cannot do.`;
    if (by === "lead" && !eligible(p, t.parentTaskId ? "child" : "lead")) return `flow "${p.id}" is not available to the lead; choose one of: ${eligibleIds(s, t.parentTaskId ? "child" : "lead").join(", ")}`;
  }
  if (descendants(s, t).some(isOpen)) return "It has child tasks; cancel them or let them finish first.";
  if (s.attempts.some((a) => a.taskId === t.id)) {
    const active = activeAttempts(s, t.id);
    if (!t.hold) return "Pause the task first; flows change only before a task starts or while it is paused.";
    if (active.length) return "Wait until it shows Paused.";
  }
  return undefined;
}

interface PinPlan {
  kept: string[];
  dropped: { step: string; why: "role changed" | "no such step" }[];
  /** The pin each new step takes: the old step's, when a step with the same id has the same role. */
  selectionFor: (id: string) => ModelSelection | null;
}

function pinPlan(t: Task, steps: StepDef[]): PinPlan {
  const kept: string[] = [];
  const dropped: PinPlan["dropped"] = [];
  const keep = new Map<string, ModelSelection>();
  for (const old of t.steps) {
    if (!old.selection) continue;
    const next = steps.find((d) => d.id === old.id);
    if (!next) dropped.push({ step: old.id, why: "no such step" });
    else if (next.role !== old.role) dropped.push({ step: old.id, why: "role changed" });
    else {
      kept.push(old.id);
      keep.set(old.id, old.selection);
    }
  }
  return { kept, dropped, selectionFor: (id) => (keep.has(id) ? { ...keep.get(id)! } : null) };
}

/** What changing `t` to flow `p` would do (pure; shared by the UI and the pipeline event). */
export function flowChangePreview(s: State, t: Task, p: Flow, by: FlowChanger = "user"): { allowed: boolean; why?: string; redo: string[]; pinsKept: string[]; pinsDropped: PinPlan["dropped"]; artifactsKept: number; decisionsClosed: number } {
  const why = flowChangeBlocker(s, t, p, by);
  const pins = pinPlan(t, p.steps);
  return {
    allowed: !why,
    ...(why ? { why } : {}),
    redo: t.steps.filter(isSettled).map((st) => st.id),
    pinsKept: pins.kept,
    pinsDropped: pins.dropped,
    artifactsKept: s.artifacts.filter((a) => a.taskId === t.id).length,
    decisionsClosed: s.decisions.filter((d) => d.taskId === t.id && d.status === "open").length,
  };
}

/**
 * Replace a task's pipeline with another flow, before it has run or once it shows Paused. The
 * pipeline starts over: every step is new, with a revision above any the id ever had, so no earlier run
 * can report into it (G1), and `flowSince` moves to this revision (G2, G3). Artifacts and attempts
 * stay as the record; open decisions are closed; pins carry over on steps with the same id and role.
 * `by`: the user (the command) or, later, the lead.
 */
export function changeFlow(state: State, taskId: string, expectedRev: number, flowId: string, note: string, now: string, by: FlowChanger = "user"): State {
  const t0 = getTask(state, taskId);
  const early = flowChangeBlocker(state, t0);
  if (early) throw new ControlError(early);
  if (t0.pipelineRev !== expectedRev) throw new StaleWriteError(expectedRev, t0.pipelineRev);
  const p = creationFlow(state, flowId);
  const why = flowChangeBlocker(state, t0, p, by);
  if (why) throw new ControlError(why);
  const errors = validatePipeline(p.steps, { checkIds: C.configuredCheckIds(state.project.checks) }).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`Pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);
  if (t0.flow.id === p.id && t0.flow.hash === p.hash && t0.flow.source === p.source) return state;

  const s = draft(state);
  const t = getTask(s, taskId);
  const preview = flowChangePreview(s, t, p, by);
  const rev = t.pipelineRev + 1;
  const defs = structuredClone(p.steps).map(toDef);
  const pins = pinPlan(t, defs);
  // Every revision an id ever had on this task: its current step's, and every attempt's snapshot (G1).
  const highest = new Map<string, number>();
  for (const st of t.steps) highest.set(st.id, Math.max(highest.get(st.id) ?? 0, st.revision));
  for (const a of s.attempts) if (a.taskId === t.id) highest.set(a.stepId, Math.max(highest.get(a.stepId) ?? 0, a.snapshot.stepRev));
  t.steps = instantiate(defs).map((st) => ({ ...st, revision: 1 + (highest.get(st.id) ?? 0), state: t.hold ? ("paused" as const) : ("pending" as const), selection: pins.selectionFor(st.id) }));
  const before = t.flow;
  const ref = flowRef(p, by);
  t.pipelineRev = rev;
  t.flowSince = rev;
  t.flow = ref;
  t.pipelineHistory.push({ rev, at: now, author: by, reason: `Flow changed from ${before.name} to ${p.name}${note.trim() ? `: ${note.trim()}` : ""}`, steps: defs, flow: ref });
  // These belong to the old steps. The hold itself stays.
  delete t.pendingBreakdowns;
  delete t.checkRounds;
  delete t.holdReason;
  F.supersedeDecisions(s, t.id, now, { reason: "the task's flow changed" });
  touch(t, now);
  const parts = [
    preview.redo.length ? `${preview.redo.length} completed step${preview.redo.length === 1 ? "" : "s"} start${preview.redo.length === 1 ? "s" : ""} over` : "nothing had run",
    ...(preview.pinsKept.length ? [`pins kept: ${preview.pinsKept.join(", ")}`] : []),
    ...(preview.pinsDropped.length ? [`dropped: ${preview.pinsDropped.map((d) => `${d.step} (${d.why})`).join(", ")}`] : []),
  ];
  event(s, now, by, "pipeline", `Pipeline r${rev}: flow ${before.name} → ${p.name}; ${parts.join("; ")}`, t.id);
  return s;
}

/** The project default flow, used by the lead's proposals and breakdown items when they name none. Any of the six. */
export function setDefaultFlow(state: State, flowId: string, now: string): State {
  if (isInternalFlowId(flowId)) throw new ControlError(`"${flowId}" is a pipeline the service owns; it cannot be the default.`);
  const p = findFlow(state, flowId);
  if (!p) throw new ControlError(`Unknown flow ${flowId}.`);
  const s = draft(state);
  if (s.project.defaultFlowId === flowId) return s;
  s.project.defaultFlowId = flowId;
  event(s, now, "user", "config", `Default flow: ${p.name} (${p.id})`);
  return s;
}

const flowsKey = (flows: Flow[]) => JSON.stringify(flows.map((p) => [p.id, p.hash]));

/**
 * Replace the flows with the built-in catalog the server compiled in. Never a command: only the server
 * calls it, at start, through `store.update`. It changes no task (tasks own copies of their steps), and it
 * records an event only when the set of flows (id, hash) changed, which happens when a flow file changed.
 */
export function setFlows(state: State, flows: Flow[], now: string): State {
  const s = draft(state);
  const changed = flowsKey(s.flows) !== flowsKey(flows);
  s.flows = structuredClone(flows);
  if (changed) event(s, now, "system", "config", `Flows loaded: ${flows.map((f) => f.name).join(", ")}`);
  return s;
}
