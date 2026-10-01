// Test helpers (pure): pipelines the six flows do not offer. No command reaches `setPipeline`; the tests
// use it to build the shapes they need (one step, a custom loop, a pipeline with an unknown check), and the
// task's flow then becomes "Custom pipeline". Not used by the application.

import * as C from "../checks";
import { builtInCatalog, customRef, internalFlow, isInternalFlowId } from "../flows";
import * as M from "../model";
import { downstreamOf, instantiate, structuralKey, toDef, validatePipeline } from "../pipeline";
import { ControlError, StaleWriteError, type Actor, type State, type Step, type StepDef } from "../types";

const { draft, getTask, assertOpen, requestStop, touch } = M.testingInternals;

/** The steps of a built-in or internal flow, cloned. */
export function flowSteps(id: string): StepDef[] {
  const p = builtInCatalog().find((x) => x.id === id);
  if (p) return structuredClone(p.steps);
  if (isInternalFlowId(id)) return internalFlow(id).steps;
  throw new Error(`Unknown flow ${id}`);
}

/**
 * Replace a task's pipeline with a new revision. Unchanged steps keep their state and runs. Changed or
 * removed steps stop any active run; changed steps and everything downstream of a change are revalidated.
 * Explicit model pins survive for steps that keep their ID.
 */
export function setPipeline(state: State, taskId: string, expectedRev: number, defs: StepDef[], reason: string, actor: Actor, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Editing the pipeline");
  if (t.pipelineRev !== expectedRev) throw new StaleWriteError(expectedRev, t.pipelineRev);
  if (!reason.trim()) throw new ControlError("A pipeline revision needs a reason.");
  const old = new Map(t.steps.map((st) => [st.id, st]));
  // `iteration` is set by the service when it expands a loop: it carries over from the existing step, and
  // a client can neither add nor drop it.
  defs = defs.map((d) => {
    const prev = old.get(d.id);
    const n: StepDef = { ...d };
    delete n.iteration;
    if (prev?.iteration && prev.iteration > 1) n.iteration = prev.iteration;
    return n;
  });
  const errors = validatePipeline(defs, { checkIds: C.configuredCheckIds(state.project.checks) }).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`Pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);

  const retired = new Set(t.pipelineHistory.flatMap((p) => p.steps.map((x) => x.id)).filter((id) => !t.steps.some((st) => st.id === id)));
  const reused = defs.filter((d) => retired.has(d.id)).map((d) => d.id);
  if (reused.length) throw new ControlError(`Step ID ${reused.join(", ")} belonged to a removed step; new steps need new IDs so their history stays separate.`);

  const rev = t.pipelineRev + 1;
  const changed = new Set<string>();
  for (const d of defs) {
    const prev = old.get(d.id);
    if (!prev || structuralKey(prev) !== structuralKey(d)) changed.add(d.id);
  }
  const removed = t.steps.filter((st) => !defs.some((d) => d.id === st.id)).map((st) => st.id);
  const affected = new Set([...changed, ...downstreamOf(defs, changed)]);

  // Stop runs on removed or affected steps while the old steps still exist.
  const stopped = new Set<string>();
  for (const a of M.activeAttempts(s, t.id)) {
    if (removed.includes(a.stepId) || affected.has(a.stepId)) {
      requestStop(s, a, "revision", now);
      stopped.add(a.stepId);
    }
  }

  t.steps = defs.map((d) => {
    const prev = old.get(d.id);
    const def = toDef(d);
    if (!prev) return { ...instantiate([def])[0], state: t.hold ? "paused" : "pending" };
    const st: Step = { ...prev, ...def };
    // The new definition is the whole truth: optional settings it leaves out are removed.
    for (const k of ["runIf", "iterate", "waitForChildren", "independentOf", "iteration", "principles"] as const) if (def[k] === undefined) delete st[k];
    if (!affected.has(d.id)) return st;
    st.revision = prev.revision + 1;
    if (stopped.has(d.id)) st.state = "stopping";
    else if (M.isSettled(prev) || prev.state === "blocked") {
      st.state = t.hold ? "paused" : "pending";
      if (M.isSettled(prev)) st.invalidatedBy = `pipeline r${rev}`;
      st.blockedReason = undefined;
    }
    return st;
  });
  t.pipelineRev = rev;
  const custom = customRef(actor === "lead" ? "lead" : actor === "user" ? "user" : "service");
  t.pipelineHistory.push({ rev, at: now, author: actor, reason, steps: defs.map(toDef), flow: custom });
  t.flow = custom;
  touch(t, now);
  const parts = [changed.size && `changed ${[...changed].join(", ")}`, removed.length && `removed ${removed.join(", ")}`].filter(Boolean);
  M.event(s, now, actor, "pipeline", `Pipeline r${rev}: ${reason}${parts.length ? ` (${parts.join("; ")})` : ""}`, t.id);
  if (stopped.size) M.event(s, now, "system", "control", `Stopping ${stopped.size} run(s) affected by pipeline r${rev} before redispatch`, t.id);
  return s;
}
