// Spec revisions and option choices, and follow-up tasks for finished work.

import * as C from "../checks";
import { customRef, findFlow, flowRef } from "../flows";
import { reopenPeReviewInto } from "../peReview";
import { instantiate, toDef, validatePipeline } from "../pipeline";
import { validateBlueprintRefs } from "../studio/blueprint";
import { type Actor, type SpecContent, type State, type StepDef, type Task, type FlowRef, ControlError, StaleWriteError } from "../types";
import { activeAttempts, assertOpen, currentSpec, draft, event, findStep, getTask, isSettled, requestStop, touch } from "./core";

export function editSpec(
  state: State,
  taskId: string,
  expectedRev: number,
  content: SpecContent,
  reason: string,
  actor: Actor,
  now: string,
): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Editing");
  const prev = currentSpec(t);
  if (prev.rev !== expectedRev) throw new StaleWriteError(expectedRev, prev.rev);
  if (!reason.trim()) throw new ControlError("A revision needs a reason.");

  const next = structuredClone(content);
  if (!next.options.some((o) => o.id === next.selectedOptionId)) throw new ControlError("Selected option does not exist.");
  if (next.blueprintRefs !== undefined) next.blueprintRefs = validateBlueprintRefs(s, next.blueprintRefs);

  if (actor === "user") {
    // The recommendation belongs to the agent; user edits preserve it.
    next.recommendedOptionId = prev.content.recommendedOptionId;
    if (!next.options.some((o) => o.id === next.recommendedOptionId)) {
      throw new ControlError("The agent's recommended option cannot be removed; keep it for the decision record.");
    }
  }
  const selectionChanged = next.selectedOptionId !== prev.content.selectedOptionId;
  if (selectionChanged) next.decidedBy = actor;
  if (next.selectedOptionId !== next.recommendedOptionId && next.decidedBy === "user" && !next.overrideReason.trim()) {
    throw new ControlError("Choosing an option other than the recommendation requires an override reason.");
  }
  if (next.selectedOptionId === next.recommendedOptionId) next.overrideReason = "";

  const rev = prev.rev + 1;
  t.specs.push({ rev, at: now, author: actor, reason, content: next });
  if (t.legacySpecUnavailable && t.lifecycle !== "done") {
    t.legacySpecUnavailable = false; // a written spec now exists; the task may run
  }
  touch(t, now);
  if (selectionChanged) {
    t.decisionAt = now;
    const opt = next.options.find((o) => o.id === next.selectedOptionId)!;
    event(s, now, actor, "decision", `Selected option ${opt.id} (${opt.name}) in r${rev}${actor === "user" ? `; override: ${next.overrideReason}` : ""}`, t.id);
  }
  event(s, now, actor, "spec", `Spec r${rev}: ${reason}`, t.id);
  // The owner's change to work the PE objected to is reviewed again (a new review); the lead's edit is not.
  if (actor === "user") reopenPeReviewInto(s, t, rev, now);

  if (t.lifecycle === "active") {
    const active = activeAttempts(s, t.id);
    for (const a of active) requestStop(s, a, "revision", now);
    // Results produced under the old revision need revalidation against the new one.
    for (const st of t.steps) {
      if (isSettled(st)) {
        st.state = "pending";
        st.invalidatedBy = `spec r${rev}`;
      }
    }
    if (active.length) event(s, now, "system", "control", `Integration frozen until ${active.length} run${active.length === 1 ? "" : "s"} on r${prev.rev} stop${active.length === 1 ? "s" : ""}; r${rev} runs after reconciliation`, t.id);
  }
  return s;
}

export function overrideSelection(state: State, taskId: string, expectedRev: number, optionId: string, reason: string, now: string): State {
  const t = getTask(state, taskId);
  const content = structuredClone(currentSpec(t).content);
  content.selectedOptionId = optionId;
  content.overrideReason = reason;
  return editSpec(state, taskId, expectedRev, content, `User selected option ${optionId}`, "user", now);
}

interface FollowUpOptions {
  /** Default true: the follow-up waits for the user's release before its first dispatch. */
  holdBeforeStart?: boolean;
  /** The pipeline to run. Default: the origin's current flow from the catalog, else a copy of its pipeline before any expansion. */
  steps?: StepDef[];
  /** The provenance of `steps` when the service supplies them. Default: a custom pipeline. */
  flow?: FlowRef;
  author?: Actor;
  /** Default: the origin task (already done, so it never delays the follow-up). */
  dependsOn?: string[];
  /** Extra task fields, for example `revertOf` or `deliverInto`. */
  fields?: Partial<Task>;
}

/** The origin's pipeline before any loop iteration was added to it. */
function unexpandedSteps(t: Task): StepDef[] {
  const expanded = (d: StepDef) => d.iteration !== undefined;
  const clean = [...t.pipelineHistory].reverse().find((r) => r.steps.length > 0 && !r.steps.some(expanded));
  return structuredClone(clean ? clean.steps : t.steps.map(toDef));
}

export function createFollowUp(state: State, taskId: string, now: string, opts: FollowUpOptions = {}): { state: State; newId: string } {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done") throw new ControlError("Follow-ups are for completed tasks; edit open tasks directly.");
  // <root>-F<k>: one past the highest follow-up number of this root, so a follow-up of a follow-up
  // never reuses an id.
  const root = t.id.replace(/-F\d+$/, "");
  const ids = new Set(s.tasks.map((x) => x.id));
  let k = 1;
  for (const id of ids) {
    const m = id.startsWith(`${root}-F`) ? /^\d+$/.exec(id.slice(root.length + 2)) : null;
    if (m) k = Math.max(k, Number(m[0]) + 1);
  }
  while (ids.has(`${root}-F${k}`)) k++;
  const newId = `${root}-F${k}`;
  const author = opts.author ?? "user";
  // Fresh steps: expanded -iN and -cN copies are never copied, and nothing carries run state over.
  // The origin's flow is re-applied from the current catalog when it is still there (so a follow-up
  // takes up an updated flow); legacy, custom and internal pipelines are copied as they were.
  let defs: StepDef[];
  let flow: FlowRef;
  let reason: string;
  if (opts.steps) {
    defs = structuredClone(opts.steps).map(toDef);
    flow = opts.flow ? structuredClone(opts.flow) : customRef("follow-up");
    reason = `Follow-up to ${t.id}`;
  } else {
    const current = t.flow.source === "built-in" ? findFlow(state, t.flow.id) : undefined;
    if (current) {
      defs = structuredClone(current.steps).map(toDef);
      flow = flowRef(current, "follow-up");
      reason = `Created from the ${current.name} flow (follow-up to ${t.id})`;
    } else {
      defs = unexpandedSteps(t).map(toDef);
      flow = { ...structuredClone(t.flow), chosenBy: "follow-up" };
      reason = `Copied from ${t.id}`;
    }
  }
  const errors = validatePipeline(defs, { checkIds: C.configuredCheckIds(state.project.checks) }).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`The follow-up's pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);
  const steps = instantiate(defs);
  // A copied or re-applied pipeline keeps the models the user pinned on steps with the same id and role.
  if (!opts.steps) {
    for (const st of steps) {
      const prev = findStep(t, st.id);
      st.selection = prev && prev.role === st.role ? structuredClone(prev.selection) : null;
    }
  }
  const content = structuredClone(currentSpec(t).content);
  content.title = `Follow-up: ${content.title}`;
  s.tasks.push({
    id: newId,
    priority: t.priority,
    lifecycle: "proposed",
    hold: false,
    holdBeforeStart: opts.holdBeforeStart ?? true,
    specs: [{ rev: 1, at: now, author, reason: `Follow-up to delivered ${t.id} r${currentSpec(t).rev}`, content }],
    steps,
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author, reason, steps: defs, flow }],
    flow,
    flowSince: 1,
    roleOverrides: structuredClone(t.roleOverrides),
    dependsOn: opts.dependsOn ? [...opts.dependsOn] : [t.id],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    followUpOf: t.id,
    ...structuredClone(opts.fields ?? {}),
  });
  event(s, now, author, "spec", `Created follow-up ${newId} from delivered ${t.id}`, newId);
  return { state: s, newId };
}
