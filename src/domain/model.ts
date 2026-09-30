// State transitions for tasks, specs, steps, and runs.
// Every operation is pure: it returns a new State and never mutates its input.
// Operations are applied one at a time, which serializes races such as
// pause-vs-completion: whichever is applied first determines the outcome.

import { downstreamOf, instantiate, structuralKey, toDef, validatePipeline } from "./pipeline";
import {
  type ActivityEvent,
  type Actor,
  type Artifact,
  type Attempt,
  type CatalogModel,
  type RunLimits,
  type WorkerEnvironment,
  type ConsumedInput,
  type EventKind,
  type ModelSelection,
  type ProviderId,
  type RoleId,
  type SelectionSource,
  type SpecContent,
  type State,
  type Step,
  type StepDef,
  type Task,
  type WorkflowTemplate,
  ControlError,
  REVIEW_ROLES,
  autoModelDefaults,
  StaleWriteError,
} from "./types";

// ---------- helpers ----------

function draft(state: State): State {
  return structuredClone(state);
}

function nextId(s: State, prefix: string): string {
  s.seq += 1;
  return `${prefix}-${s.seq}`;
}

function log(s: State, e: Omit<ActivityEvent, "id">) {
  s.events.push({ id: nextId(s, "ev"), ...e });
}

function getTask(s: State, taskId: string): Task {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new ControlError(`Unknown task ${taskId}`);
  return t;
}

function getStep(t: Task, stepId: string): Step {
  const st = t.steps.find((x) => x.id === stepId);
  if (!st) throw new ControlError(`Unknown step ${stepId} on ${t.id}`);
  return st;
}

function findStep(t: Task, stepId: string): Step | undefined {
  return t.steps.find((x) => x.id === stepId);
}

/** Done or skipped: the step's contribution is settled and it satisfies dependencies. */
export function isSettled(st: Step) {
  return st.state === "done" || st.state === "skipped";
}

function event(s: State, now: string, actor: Actor, kind: EventKind, message: string, taskId?: string) {
  log(s, { at: now, actor, kind, message, taskId });
}

export function currentSpec(t: Task) {
  return t.specs[t.specs.length - 1];
}

export function currentVision(s: State) {
  return s.project.visions[s.project.visions.length - 1];
}

export function isActive(a: Attempt) {
  return a.outcome === "running" || a.outcome === "stopping";
}

export function activeAttempts(s: State, taskId?: string) {
  return s.attempts.filter((a) => isActive(a) && (taskId === undefined || a.taskId === taskId));
}

function assertOpen(t: Task, what: string) {
  if (t.lifecycle === "done") throw new ControlError(`${t.id} is done. ${what} would rewrite delivered work; create a follow-up task instead.`);
  if (t.lifecycle === "cancelled") throw new ControlError(`${t.id} is cancelled.`);
}

function requestStop(s: State, a: Attempt, reason: NonNullable<Attempt["stopReason"]>, now: string) {
  if (a.outcome !== "running") return;
  a.outcome = "stopping";
  a.stopRequestedAt = now;
  a.stopReason = reason;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  if (st) st.state = "stopping";
  event(s, now, "system", "control", `Stop requested for ${a.id} (${reason}); awaiting runtime acknowledgment`, t.id);
}

/** Where a step lands once its run has stopped. */
function settleStoppedStep(s: State, t: Task, st: Step | undefined) {
  if (!st) return; // removed by a pipeline edit
  if (t.lifecycle === "cancelled" || t.hold || s.project.hold) st.state = "paused";
  else st.state = "pending";
}

function touch(t: Task, now: string) {
  t.updatedAt = now;
}

// ---------- model resolution ----------

export type Resolution =
  | { ok: true; selection: ModelSelection; source: SelectionSource; reason: string }
  | { ok: false; reason: string };

/** Resolution order: step pin → task role override → project role default → project default. */
export function resolveStep(s: State, t: Task, st: Step): Resolution {
  const p = s.project;
  let selection: ModelSelection;
  let source: SelectionSource;
  if (st.selection) [selection, source] = [st.selection, "step"];
  else if (t.roleOverrides[st.role]) [selection, source] = [t.roleOverrides[st.role]!, "task-role"];
  else if (p.roleDefaults[st.role]) [selection, source] = [p.roleDefaults[st.role]!, "project-role"];
  else [selection, source] = [p.defaultSelection, "project-default"];

  if (!p.enabledProviders.includes(selection.provider)) {
    return { ok: false, reason: `${providerLabel(selection.provider)} is not enabled. Enable it in Settings or choose another provider for this step.` };
  }
  const catalog = p.catalog[selection.provider];
  if (selection.model === "auto") {
    if (catalog.length === 0) return { ok: false, reason: `No models available for ${providerLabel(selection.provider)}.` };
    return {
      ok: true,
      selection: { provider: selection.provider, model: catalog[0].id },
      source,
      reason: `Auto: ${catalog[0].id}, the first model in the ${providerLabel(selection.provider)} catalog`,
    };
  }
  if (!catalog.some((m) => m.id === selection.model)) {
    return { ok: false, reason: `Model ${selection.model} is not in the ${providerLabel(selection.provider)} catalog.` };
  }
  return { ok: true, selection, source, reason: sourceLabel(source) };
}

export function providerLabel(p: ProviderId) {
  return p === "claude" ? "Claude" : "Codex";
}

export function sourceLabel(src: SelectionSource) {
  switch (src) {
    case "step":
      return "Pinned on this step";
    case "task-role":
      return "Task role override";
    case "project-role":
      return "Project role default";
    case "project-default":
      return "Project default";
  }
}

// ---------- derived presentation state ----------

export type Column = "proposed" | "ready" | "running" | "reviewing" | "paused" | "blocked" | "done" | "cancelled";
export const BOARD_COLUMNS: Column[] = ["proposed", "ready", "running", "reviewing", "paused", "blocked", "done"];

export function blockedReason(s: State, t: Task): string | undefined {
  for (const dep of t.dependsOn) {
    const d = s.tasks.find((x) => x.id === dep);
    if (d?.lifecycle === "cancelled") return `Prerequisite ${dep} was cancelled`;
  }
  const st = t.steps.find((x) => x.state === "blocked");
  if (st) return `${st.id}: ${st.blockedReason ?? "blocked"}`;
  return undefined;
}

export function column(s: State, t: Task): Column {
  if (t.lifecycle === "cancelled") return "cancelled";
  if (t.lifecycle === "done") return "done";
  const active = activeAttempts(s, t.id);
  if (active.length) {
    const allReview = active.every((a) => {
      const st = findStep(t, a.stepId);
      return !!st && REVIEW_ROLES.includes(st.role);
    });
    return allReview ? "reviewing" : "running";
  }
  if (blockedReason(s, t)) return "blocked";
  if (t.hold) return "paused";
  if (t.lifecycle === "proposed") return "proposed";
  // Started but idle: paused by the project hold, otherwise queued for its next step.
  if (t.lifecycle === "active" && s.project.hold) return "paused";
  return "ready";
}

/** A short truthful state label that distinguishes desired from observed state. */
export function stateLabel(s: State, t: Task): string {
  const col = column(s, t);
  const active = activeAttempts(s, t.id);
  const stopping = active.filter((a) => a.outcome === "stopping");
  if (t.controlFailure) return "Control failure";
  if (stopping.length) return stopLabel(s, t);
  if (col === "cancelled") return "Cancelled";
  if (col === "done") return "Done";
  if (col === "blocked") return "Blocked";
  if (col === "paused") return t.hold ? "Paused" : "Paused (project)";
  if (t.lifecycle === "active" && active.length === 0) return "Queued for next step";
  if (col === "proposed" && waitingOn(s, t)) return `Waiting on ${waitingOn(s, t)}`;
  if (col === "ready" && t.holdBeforeStart) return "Held before start";
  if (col === "ready" && s.project.hold) return "Ready (project paused)";
  if (col === "ready" && waitingOn(s, t)) return `Waiting on ${waitingOn(s, t)}`;
  return col[0].toUpperCase() + col.slice(1);
}

/** Why runs on this task are stopping, derived from the stop requests and current desired state. */
export function stopLabel(s: State, t: Task): string {
  if (t.lifecycle === "cancelled") return "Cancelling";
  if (t.hold || s.project.hold) return "Pausing";
  const reasons = new Set(activeAttempts(s, t.id).filter((a) => a.outcome === "stopping").map((a) => a.stopReason));
  if (reasons.has("revision")) return "Stopping for revision";
  if (reasons.has("model-change")) return "Stopping for model change";
  // A pause was lifted before the runtime acknowledged it; the run must still stop before redispatch.
  return "Stopping (resume pending)";
}

export function waitingOn(s: State, t: Task): string | undefined {
  return t.dependsOn.find((d) => s.tasks.find((x) => x.id === d)?.lifecycle !== "done");
}

// ---------- spec edits ----------

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
  touch(t, now);
  if (selectionChanged) {
    t.decisionAt = now;
    const opt = next.options.find((o) => o.id === next.selectedOptionId)!;
    event(s, now, actor, "decision", `Selected option ${opt.id} (${opt.name}) in r${rev}${actor === "user" ? `; override: ${next.overrideReason}` : ""}`, t.id);
  }
  event(s, now, actor, "spec", `Spec r${rev}: ${reason}`, t.id);

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
    if (active.length) event(s, now, "system", "control", `Integration frozen until ${active.length} run(s) on r${prev.rev} stop; r${rev} runs after reconciliation`, t.id);
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

export function createFollowUp(state: State, taskId: string, now: string): { state: State; newId: string } {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done") throw new ControlError("Follow-ups are for completed tasks; edit open tasks directly.");
  const newId = `${t.id.replace(/-F\d+$/, "")}-F${s.tasks.filter((x) => x.followUpOf === t.id).length + 1}`;
  const content = structuredClone(currentSpec(t).content);
  content.title = `Follow-up: ${content.title}`;
  s.tasks.push({
    id: newId,
    priority: t.priority,
    lifecycle: "proposed",
    hold: false,
    holdBeforeStart: true,
    specs: [{ rev: 1, at: now, author: "user", reason: `Follow-up to delivered ${t.id} r${currentSpec(t).rev}`, content }],
    steps: t.steps.map((st) => ({ ...structuredClone(st), state: "pending", revision: 1, invalidatedBy: undefined, blockedReason: undefined })),
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "user", reason: `Copied from ${t.id}`, steps: t.steps.map(toDef) }],
    roleOverrides: structuredClone(t.roleOverrides),
    dependsOn: [t.id],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    followUpOf: t.id,
  });
  event(s, now, "user", "spec", `Created follow-up ${newId} from delivered ${t.id}`, newId);
  return { state: s, newId };
}

// ---------- task controls ----------

export function pauseTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Pausing");
  if (t.hold) return s;
  t.hold = true; // persist the hold before interrupting anything
  touch(t, now);
  const active = activeAttempts(s, t.id);
  event(s, now, "user", "control", active.length ? `Pause requested; hold saved, interrupting ${active.length} run(s)` : "Paused; hold saved and excluded from dispatch", t.id);
  for (const a of active) requestStop(s, a, "pause", now);
  return s;
}

export function resumeTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Resuming");
  if (!t.hold) throw new ControlError(`${t.id} has no hold to clear.`);
  t.hold = false;
  for (const st of t.steps) if (st.state === "paused") st.state = "pending";
  touch(t, now);
  const note = s.project.hold ? " Project is still paused, so nothing will dispatch until it resumes." : " It is not running until dispatched.";
  event(s, now, "user", "control", `Hold cleared; requeued.${note}`, t.id);
  return s;
}

export function startHeldTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Starting");
  t.holdBeforeStart = false;
  touch(t, now);
  event(s, now, "user", "control", "Hold-before-start released; eligible for dispatch", t.id);
  return s;
}

export function setHoldBeforeStart(state: State, taskId: string, value: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Changing hold");
  t.holdBeforeStart = value;
  touch(t, now);
  event(s, now, "user", "control", value ? "Hold before start enabled" : "Hold before start removed", t.id);
  return s;
}

export function cancelTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Cancelling");
  t.lifecycle = "cancelled";
  touch(t, now);
  const active = activeAttempts(s, t.id);
  event(s, now, "user", "control", `Cancelled; spec and partial artifacts retained${active.length ? `; stopping ${active.length} run(s)` : ""}`, t.id);
  for (const a of active) requestStop(s, a, "cancel", now);
  for (const d of s.tasks.filter((x) => x.dependsOn.includes(t.id) && x.lifecycle !== "done" && x.lifecycle !== "cancelled")) {
    event(s, now, "system", "blocked", `Blocked: prerequisite ${t.id} was cancelled`, d.id);
  }
  return s;
}

export function setPriority(state: State, taskId: string, priority: number, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Reprioritizing");
  if (!Number.isInteger(priority) || priority < 1) throw new ControlError("Priority must be a positive integer.");
  const old = t.priority;
  t.priority = priority;
  touch(t, now);
  event(s, now, "user", "control", `Priority P${old} → P${priority}`, t.id);
  return s;
}

export function pauseProject(state: State, now: string): State {
  const s = draft(state);
  if (s.project.hold) return s;
  s.project.hold = true;
  const active = activeAttempts(s);
  event(s, now, "user", "control", `Project paused; dispatch and integration frozen${active.length ? `; interrupting ${active.length} run(s)` : ""}`);
  for (const a of active) requestStop(s, a, "project-pause", now);
  return s;
}

export function resumeProject(state: State, now: string): State {
  const s = draft(state);
  if (!s.project.hold) return s;
  s.project.hold = false;
  let kept = 0;
  for (const t of s.tasks) {
    if (t.lifecycle === "done" || t.lifecycle === "cancelled") continue;
    if (t.hold) {
      kept++;
      continue;
    }
    for (const st of t.steps) if (st.state === "paused") st.state = "pending";
  }
  event(s, now, "user", "control", `Project resumed${kept ? `; ${kept} task hold(s) preserved` : ""}`);
  return s;
}

// ---------- step configuration ----------

export function setStepSelection(state: State, taskId: string, stepId: string, selection: ModelSelection | null, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Changing step models");
  const st = getStep(t, stepId);
  if (st.state === "done") throw new ControlError(`${stepId} already completed; its selection is historical. Rerun the step to use a different model.`);
  st.selection = selection ? { ...selection } : null;
  st.revision += 1;
  if (st.state === "blocked") {
    st.state = "pending";
    st.blockedReason = undefined;
  }
  touch(t, now);
  const desc = selection ? `${providerLabel(selection.provider)} · ${selection.model}` : "inherited default";
  event(s, now, "user", "config", `${stepId} set to ${desc} (step config r${st.revision})`, t.id);
  const running = activeAttempts(s, t.id).filter((a) => a.stepId === stepId);
  for (const a of running) requestStop(s, a, "model-change", now);
  if (running.length) event(s, now, "system", "control", `${stepId}: new attempt starts only after the previous run acknowledges stopping`, t.id);
  return s;
}

export function setTaskRoleOverride(state: State, taskId: string, role: RoleId, selection: ModelSelection | null, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Changing role overrides");
  if (selection) t.roleOverrides[role] = { ...selection };
  else delete t.roleOverrides[role];
  unblockConfigSteps(s);
  touch(t, now);
  event(s, now, "user", "config", `Task ${role} override ${selection ? `set to ${providerLabel(selection.provider)} · ${selection.model}` : "cleared"}`, t.id);
  return s;
}

export function setRoleDefault(state: State, role: RoleId, selection: ModelSelection | null, now: string): State {
  const s = draft(state);
  if (selection) s.project.roleDefaults[role] = { ...selection };
  else delete s.project.roleDefaults[role];
  unblockConfigSteps(s);
  event(s, now, "user", "config", `Project ${role} default ${selection ? `set to ${providerLabel(selection.provider)} · ${selection.model}` : "cleared"}; affects undispatched unpinned steps only`);
  return s;
}

export function setProviderEnabled(state: State, provider: ProviderId, enabled: boolean, now: string): State {
  const s = draft(state);
  const set = new Set(s.project.enabledProviders);
  if (enabled) set.add(provider);
  else set.delete(provider);
  s.project.enabledProviders = [...set];
  unblockConfigSteps(s);
  event(s, now, "user", "config", `${providerLabel(provider)} ${enabled ? "enabled" : "disabled"}`);
  return s;
}

export function setWorkerLimit(state: State, limit: number, now: string): State {
  const s = draft(state);
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new ControlError("Worker limit must be between 1 and 8.");
  s.project.workerLimit = limit;
  event(s, now, "user", "config", `Worker limit set to ${limit}`);
  return s;
}

/** Configuration changed; let the next dispatch re-resolve blocked steps. */
function unblockConfigSteps(s: State) {
  for (const t of s.tasks) {
    if (t.lifecycle === "done" || t.lifecycle === "cancelled") continue;
    for (const st of t.steps) if (st.state === "blocked") {
      st.state = "pending";
      st.blockedReason = undefined;
    }
  }
}

/** Clear a blocked step so the next dispatch tries it again with current configuration. */
export function retryStep(state: State, taskId: string, stepId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Retrying");
  const st = getStep(t, stepId);
  if (st.state !== "blocked") throw new ControlError(`${stepId} is not blocked.`);
  st.state = t.hold ? "paused" : "pending";
  st.blockedReason = undefined;
  touch(t, now);
  event(s, now, "user", "control", `Retry ${stepId}; eligible for the next dispatch`, t.id);
  return s;
}

export function rerunStep(state: State, taskId: string, stepId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Rerunning");
  const st = getStep(t, stepId);
  if (st.state !== "done") throw new ControlError(`${stepId} has not completed.`);
  st.state = "pending";
  st.invalidatedBy = undefined;
  const invalid = new Set([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of t.steps) {
      if (!invalid.has(d.id) && d.dependsOn.some((x) => invalid.has(x))) {
        invalid.add(d.id);
        changed = true;
        if (isSettled(d)) {
          d.state = "pending";
          d.invalidatedBy = stepId;
        }
      }
    }
  }
  // Downstream work in flight was built on the old upstream output: stop it, and bump its
  // step revision so a late completion is discarded rather than integrated.
  for (const a of activeAttempts(s, t.id)) {
    if (a.stepId === stepId || !invalid.has(a.stepId)) continue;
    const d = findStep(t, a.stepId);
    if (!d) continue;
    d.revision += 1;
    d.invalidatedBy = stepId;
    requestStop(s, a, "revision", now);
  }
  touch(t, now);
  const downstream = [...invalid].filter((x) => x !== stepId);
  event(s, now, "user", "control", `Rerun ${stepId}${downstream.length ? `; downstream ${downstream.join(", ")} need revalidation` : ""}`, t.id);
  return s;
}

// ---------- vision ----------

export function editVision(state: State, expectedRev: number, text: string, focus: string, reason: string, now: string): State {
  const s = draft(state);
  const v = currentVision(s);
  if (v.rev !== expectedRev) throw new StaleWriteError(expectedRev, v.rev);
  s.project.visions.push({ rev: v.rev + 1, at: now, author: "user", text, focus, reason });
  event(s, now, "user", "vision", `Vision r${v.rev + 1}: ${reason}`);
  return s;
}

export function markVisited(state: State, now: string): State {
  const s = draft(state);
  s.project.lastVisitAt = now;
  return s;
}

// ---------- lead and runtime reports (driven by the simulated runtime in M1) ----------

/** The lead promotes proposals whose dependencies and assignments resolve. */
export function leadPromoteProposals(state: State, now: string): State {
  const s = draft(state);
  if (s.project.hold) return s;
  for (const t of s.tasks) {
    if (t.lifecycle !== "proposed" || t.hold) continue;
    if (blockedReason(s, t) || waitingOn(s, t)) continue;
    const unresolved = t.steps.map((st) => resolveStep(s, t, st)).find((r) => !r.ok);
    if (unresolved) continue;
    t.lifecycle = "ready";
    touch(t, now);
    event(s, now, "lead", "control", "Moved to Ready: spec published, assignments resolved", t.id);
  }
  return s;
}

export interface DispatchOptions {
  /** Providers that cannot run work right now, with an actionable reason (observed health). */
  unavailable?: Partial<Record<ProviderId, string>>;
  /** Providers whose status is not known yet: their steps wait without being blocked. */
  deferred?: ProviderId[];
  /** Where an attempt's workspace will live (recorded in the immutable run snapshot). */
  workspaceFor?: (taskId: string, stepId: string, attemptId: string) => string;
}

export function dispatchEligible(state: State, now: string, opts: DispatchOptions = {}): State {
  const s = draft(state);
  if (s.project.hold) return s;
  const vision = currentVision(s);
  const tasks = [...s.tasks].sort((a, b) => a.priority - b.priority);
  for (const t of tasks) {
    if (activeAttempts(s).length >= s.project.workerLimit) break;
    if (t.lifecycle !== "ready" && t.lifecycle !== "active") continue;
    if (t.hold || t.holdBeforeStart || t.controlFailure) continue;
    if (waitingOn(s, t) || blockedReason(s, t)) continue;
    // Reconcile before redispatch: nothing new while any run on this task is still stopping.
    if (activeAttempts(s, t.id).some((a) => a.outcome === "stopping")) continue;
    const spec = currentSpec(t);
    if (t.lifecycle === "active" && t.steps.every(isSettled) && activeAttempts(s, t.id).length === 0) {
      t.lifecycle = "done";
      touch(t, now);
      event(s, now, "lead", "integration", `Integrated spec r${spec.rev} (simulated); task Done`, t.id);
      continue;
    }
    for (const st of t.steps) {
      if (activeAttempts(s).length >= s.project.workerLimit) break;
      if (st.state !== "pending") continue;
      const depsDone = st.dependsOn.every((d) => isSettled(getStep(t, d)));
      if (!depsDone) continue;
      if (st.runIf?.length) {
        const open = st.runIf.reduce((n, r) => n + (acceptedOutput(s, t, r.step, r.output)?.openFindings ?? 0), 0);
        if (open === 0) {
          st.state = "skipped";
          st.invalidatedBy = undefined;
          touch(t, now);
          event(s, now, "lead", "dispatch", `Skipped ${st.id}: no open findings in ${st.runIf.map((r) => `${r.step}.${r.output}`).join(", ")}`, t.id);
          continue;
        }
      }
      const r = resolveStep(s, t, st);
      if (r.ok && opts.deferred?.includes(r.selection.provider)) continue;
      const down = r.ok ? opts.unavailable?.[r.selection.provider] : undefined;
      if (!r.ok || down) {
        // Never substitute another provider: block with the reason and let the user act.
        const reason = r.ok ? `${providerLabel(r.selection.provider)} is not available: ${down}` : r.reason;
        st.state = "blocked";
        st.blockedReason = reason;
        event(s, now, "system", "blocked", `${st.id} blocked: ${reason}`, t.id);
        continue;
      }
      const attemptId = nextId(s, "run");
      const a: Attempt = {
        id: attemptId,
        taskId: t.id,
        stepId: st.id,
        snapshot: {
          provider: r.selection.provider,
          model: r.selection.model,
          source: r.source,
          routingReason: r.reason,
          specRev: spec.rev,
          stepRev: st.revision,
          visionRev: vision.rev,
          workspace: opts.workspaceFor ? opts.workspaceFor(t.id, st.id, attemptId) : `${s.project.repoPath}/.orchestration/worktrees/${t.id}-${st.id}`,
          pipelineRev: t.pipelineRev,
          environment: s.project.workerEnvironment[r.selection.provider],
          connections: [...s.project.workerConnections[r.selection.provider]],
          purpose: st.purpose,
          inputs: consumedInputs(s, t, st),
        },
        startedAt: now,
        outcome: "running",
        progress: 0,
        artifacts: [],
      };
      s.attempts.push(a);
      st.state = "running";
      if (t.lifecycle === "ready") t.lifecycle = "active";
      touch(t, now);
      event(s, now, "lead", "dispatch", `Dispatched ${st.id} (${st.role}) to ${providerLabel(a.snapshot.provider)} · ${a.snapshot.model} as ${a.id} on spec r${spec.rev}`, t.id);
    }
  }
  return s;
}

export function reportProgress(state: State, attemptId: string, progress: number): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (a && isActive(a)) a.progress = Math.max(0, Math.min(100, progress));
  return s;
}

/** The runtime acknowledges that a run it was asked to stop has stopped. */
export function acknowledgeStop(state: State, attemptId: string, now: string): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || a.outcome !== "stopping") return s;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  a.outcome = "stopped";
  a.endedAt = now;
  a.artifacts.push(`checkpoint: partial work left in ${a.snapshot.workspace}`);
  settleStoppedStep(s, t, st);
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  event(s, now, "runtime", "runtime", `${a.id} acknowledged stop; partial work checkpointed`, t.id);
  return s;
}

/**
 * Reconciliation found no live process for an active run (for example after the service restarted).
 * A run that was stopping is treated as stopped; a running one is marked lost. Neither is completed,
 * and the step is requeued (or stays paused under a hold) so the next dispatch starts a fresh attempt.
 */
export function reportRunLost(state: State, attemptId: string, reason: string, now: string): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  const t = getTask(s, a.taskId);
  const wasStopping = a.outcome === "stopping";
  a.outcome = wasStopping ? "stopped" : "lost";
  a.endedAt = now;
  a.note = `${reason}; no result was produced or integrated`;
  a.artifacts.push(`checkpoint: partial work left in ${a.snapshot.workspace}`);
  settleStoppedStep(s, t, findStep(t, a.stepId));
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  event(s, now, "system", "runtime", `${a.id} ${wasStopping ? "confirmed stopped" : "lost"} during reconciliation: ${reason}`, t.id);
  return s;
}

/** The runtime accepted the run. */
export function reportRunStarted(state: State, attemptId: string, info: { sessionId?: string; actualModel?: string }): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  if (info.sessionId) a.sessionId = info.sessionId;
  if (info.actualModel) a.actualModel = info.actualModel;
  return s;
}

/** A meaningful milestone from the runtime. Updates the run's activity; not written to the event log. */
export function reportActivity(state: State, attemptId: string, note: string): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (a && isActive(a)) a.activity = note.slice(0, 200);
  return s;
}

/**
 * The run ended without a usable result (provider error, authentication, limits, crash). Nothing is
 * integrated. The step is blocked with the reason so a person decides whether to retry, change the
 * model, or edit the work; the scheduler never retries or switches providers on its own.
 */
export function reportRunFailed(state: State, attemptId: string, message: string, now: string, run: RunReport = {}): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  const wasStopping = a.outcome === "stopping";
  a.outcome = "failed";
  a.endedAt = now;
  a.note = message;
  if (run.usage) a.usage = run.usage;
  if (run.actualModel) a.actualModel = run.actualModel;
  if (st) {
    if (wasStopping) settleStoppedStep(s, t, st);
    else {
      st.state = "blocked";
      st.blockedReason = `Last run failed: ${message}`;
    }
  }
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  event(s, now, "runtime", wasStopping ? "runtime" : "blocked", `${a.id} failed: ${message}`, t.id);
  return s;
}

export function reportStopTimeout(state: State, attemptId: string, now: string): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || a.outcome !== "stopping") return s;
  const t = getTask(s, a.taskId);
  if (t.controlFailure) return s;
  t.controlFailure = { at: now, message: `${a.id} has not acknowledged the stop request. Integration stays frozen; the run may still be working.` };
  event(s, now, "system", "control", `Control failure: ${a.id} did not acknowledge stop in time`, t.id);
  return s;
}

export function retryStop(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  t.controlFailure = undefined;
  for (const a of activeAttempts(s, t.id)) if (a.outcome === "stopping") a.stopRequestedAt = now;
  event(s, now, "user", "control", "Retrying stop request", t.id);
  return s;
}

/** The runtime reports that a run finished. Stale or interrupted results are never integrated. */
export interface OutputReport {
  name: string;
  summary: string;
  openFindings?: number;
  /** Durable reference, e.g. "<sha> on orchestration/run-12". */
  ref?: string;
}

export interface RunReport {
  usage?: Attempt["usage"];
  actualModel?: string;
}

export function reportCompletion(state: State, attemptId: string, artifacts: string[], now: string, outputs: OutputReport[] = [], run: RunReport = {}): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  a.endedAt = now;
  a.progress = 100;
  a.artifacts.push(...artifacts);
  if (run.usage) a.usage = run.usage;
  if (run.actualModel) a.actualModel = run.actualModel;

  const stale = !st || a.snapshot.specRev !== currentSpec(t).rev || a.snapshot.stepRev !== st.revision;
  if (stale) {
    a.outcome = "discarded";
    a.note = st
      ? `Result for spec r${a.snapshot.specRev}/step r${a.snapshot.stepRev} arrived after a newer revision; not integrated`
      : `${a.stepId} was removed from the pipeline; result not integrated`;
    settleStoppedStep(s, t, st);
    event(s, now, "runtime", "integration", `${a.id} finished on superseded revision; result discarded, not integrated`, t.id);
  } else if (a.outcome === "stopping" || t.hold || s.project.hold || t.lifecycle === "cancelled") {
    a.outcome = "stopped";
    a.note = "Finished after a stop request; kept as a checkpoint, not integrated";
    settleStoppedStep(s, t, st);
    event(s, now, "runtime", "runtime", `${a.id} finished after stop request; kept as checkpoint, not integrated`, t.id);
  } else {
    const missing = st.outputs.filter((d) => !outputs.some((o) => o.name === d.name)).map((d) => d.name);
    if (missing.length) {
      // Accepting a partial result would hand downstream steps a mix of old and new context.
      a.outcome = "failed";
      a.note = `Finished without declared outputs: ${missing.join(", ")}; not accepted`;
      st.state = "blocked";
      st.blockedReason = `Last run did not produce ${missing.join(", ")}. Retry the step or edit its outputs.`;
      event(s, now, "runtime", "blocked", `${a.id} finished without ${missing.join(", ")}; result not accepted, ${st.id} blocked`, t.id);
      touch(t, now);
      return s;
    }
    a.outcome = "completed";
    st.state = "done";
    st.invalidatedBy = undefined;
    const produced: string[] = [];
    for (const def of st.outputs) {
      const rep = outputs.find((o) => o.name === def.name)!;
      const version = s.artifacts.filter((x) => x.taskId === t.id && x.stepId === st.id && x.name === def.name).length + 1;
      const art: Artifact = {
        id: nextId(s, "art"),
        taskId: t.id,
        stepId: st.id,
        attemptId: a.id,
        name: def.name,
        kind: def.kind,
        version,
        summary: rep.summary,
        createdAt: now,
        ...(rep.ref ? { ref: rep.ref } : {}),
        ...(def.kind === "review-findings" ? { openFindings: rep.openFindings ?? 0 } : {}),
      };
      s.artifacts.push(art);
      produced.push(`${def.name} v${version}`);
    }
    event(s, now, "runtime", "runtime", `${st.id} completed by ${providerLabel(a.snapshot.provider)} · ${a.snapshot.model}${produced.length ? `; produced ${produced.join(", ")}` : ""}`, t.id);
  }
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);

  if (t.lifecycle === "active" && t.steps.every(isSettled) && activeAttempts(s, t.id).length === 0 && !t.hold && !s.project.hold) {
    t.lifecycle = "done";
    event(s, now, "lead", "integration", `Integrated spec r${currentSpec(t).rev} (simulated); task Done`, t.id);
  }
  return s;
}

export function setProjectDefault(state: State, selection: ModelSelection, now: string): State {
  const s = draft(state);
  s.project.defaultSelection = { ...selection };
  unblockConfigSteps(s);
  event(s, now, "user", "config", `Project default set to ${providerLabel(selection.provider)} · ${selection.model}`);
  return s;
}

export function setRepoPath(state: State, repoPath: string, now: string): State {
  const s = draft(state);
  if (!repoPath.trim()) throw new ControlError("Repository path cannot be empty.");
  s.project.repoPath = repoPath.trim();
  event(s, now, "user", "config", `Managed repository set to ${s.project.repoPath}; affects runs not yet dispatched`);
  return s;
}

// ---------- artifacts ----------

export function latestArtifact(s: State, t: Task, stepId: string, output: string): Artifact | undefined {
  let best: Artifact | undefined;
  for (const x of s.artifacts) if (x.taskId === t.id && x.stepId === stepId && x.name === output && (!best || x.version > best.version)) best = x;
  return best;
}

/**
 * The output a step's current accepted run produced. Only a done step has one; skipped, pending,
 * or re-running steps contribute nothing, even if older versions exist.
 */
export function acceptedOutput(s: State, t: Task, stepId: string, output: string): Artifact | undefined {
  const st = findStep(t, stepId);
  if (!st || st.state !== "done") return undefined;
  let run: Attempt | undefined;
  for (const a of s.attempts) if (a.taskId === t.id && a.stepId === stepId && a.outcome === "completed") run = a;
  return run && s.artifacts.find((x) => x.attemptId === run.id && x.name === output);
}

/** The upstream artifacts a step receives. Inputs from skipped or unfinished steps are absent. */
export function consumedInputs(s: State, t: Task, st: StepDef): ConsumedInput[] {
  const out: ConsumedInput[] = [];
  for (const r of st.inputs) {
    const art = acceptedOutput(s, t, r.step, r.output);
    if (art) out.push({ step: r.step, output: r.output, artifactId: art.id, version: art.version });
  }
  return out;
}

/** Inputs a completed run consumed that have since been superseded by a newer version. */
export function staleInputs(s: State, t: Task, a: Attempt): ConsumedInput[] {
  return a.snapshot.inputs.filter((i) => (latestArtifact(s, t, i.step, i.output)?.version ?? 0) > i.version);
}

// ---------- pipeline editing ----------

/**
 * Replace a task's pipeline with a new revision. Unchanged steps keep their state and runs.
 * Changed or removed steps stop any active run; changed steps and everything downstream of a
 * change are revalidated. Explicit model pins survive for steps that keep their ID.
 */
export function setPipeline(state: State, taskId: string, expectedRev: number, defs: StepDef[], reason: string, actor: Actor, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Editing the pipeline");
  if (t.pipelineRev !== expectedRev) throw new StaleWriteError(expectedRev, t.pipelineRev);
  if (!reason.trim()) throw new ControlError("A pipeline revision needs a reason.");
  const errors = validatePipeline(defs).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`Pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);

  const retired = new Set(t.pipelineHistory.flatMap((p) => p.steps.map((x) => x.id)).filter((id) => !t.steps.some((st) => st.id === id)));
  const reused = defs.filter((d) => retired.has(d.id)).map((d) => d.id);
  if (reused.length) throw new ControlError(`Step ID ${reused.join(", ")} belonged to a removed step; new steps need new IDs so their history stays separate.`);

  const rev = t.pipelineRev + 1;
  const old = new Map(t.steps.map((st) => [st.id, st]));
  const changed = new Set<string>();
  for (const d of defs) {
    const prev = old.get(d.id);
    if (!prev || structuralKey(prev) !== structuralKey(d)) changed.add(d.id);
  }
  const removed = t.steps.filter((st) => !defs.some((d) => d.id === st.id)).map((st) => st.id);
  const affected = new Set([...changed, ...downstreamOf(defs, changed)]);

  // Stop runs on removed or affected steps while the old steps still exist.
  const stopped = new Set<string>();
  for (const a of activeAttempts(s, t.id)) {
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
    if (!def.runIf) delete st.runIf;
    if (!affected.has(d.id)) return st;
    st.revision = prev.revision + 1;
    if (stopped.has(d.id)) st.state = "stopping";
    else if (isSettled(prev) || prev.state === "blocked") {
      st.state = t.hold ? "paused" : "pending";
      if (isSettled(prev)) st.invalidatedBy = `pipeline r${rev}`;
      st.blockedReason = undefined;
    }
    return st;
  });
  t.pipelineRev = rev;
  t.pipelineHistory.push({ rev, at: now, author: actor, reason, steps: defs.map(toDef) });
  touch(t, now);
  const parts = [changed.size && `changed ${[...changed].join(", ")}`, removed.length && `removed ${removed.join(", ")}`].filter(Boolean);
  event(s, now, actor, "pipeline", `Pipeline r${rev}: ${reason}${parts.length ? ` (${parts.join("; ")})` : ""}`, t.id);
  if (stopped.size) event(s, now, "system", "control", `Stopping ${stopped.size} run(s) affected by pipeline r${rev} before redispatch`, t.id);
  return s;
}

// ---------- workflow templates ----------

/** Save a template. `expectedRev` is the revision the edit started from, or null for a new template. */
export function saveTemplate(state: State, template: WorkflowTemplate, expectedRev: number | null, now: string): State {
  const s = draft(state);
  if (!template.name.trim()) throw new ControlError("A template needs a name.");
  const existing = s.project.templates.find((x) => x.id === template.id);
  if (expectedRev === null && existing) throw new ControlError(`A template with ID ${template.id} already exists.`);
  if (expectedRev !== null && !existing) throw new ControlError(`"${template.name}" was deleted while you were editing it.`);
  if (existing && existing.rev !== expectedRev) throw new StaleWriteError(expectedRev!, existing.rev);
  const errors = validatePipeline(template.steps).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`Template is invalid: ${errors.map((e) => e.message).join(" ")}`);
  const clean: WorkflowTemplate = { ...structuredClone(template), rev: (existing?.rev ?? 0) + 1, steps: template.steps.map(toDef) };
  const i = s.project.templates.findIndex((x) => x.id === template.id);
  if (i >= 0) s.project.templates[i] = clean;
  else s.project.templates.push(clean);
  event(s, now, "user", "config", `Template "${template.name}" ${i >= 0 ? "updated" : "created"}; existing task pipelines are unchanged`);
  return s;
}

export function deleteTemplate(state: State, templateId: string, now: string): State {
  const s = draft(state);
  const t = s.project.templates.find((x) => x.id === templateId);
  if (!t) throw new ControlError(`Unknown template ${templateId}`);
  s.project.templates = s.project.templates.filter((x) => x.id !== templateId);
  event(s, now, "user", "config", `Template "${t.name}" deleted; existing task pipelines are unchanged`);
  return s;
}

// ---------- real projects ----------

export function setRunLimits(state: State, limits: RunLimits, now: string): State {
  const s = draft(state);
  const ok = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  if (!ok(limits.maxTurns, 1, 500) || !ok(limits.timeoutMinutes, 1, 240) || !ok(limits.maxBudgetUsd, 0.01, 1000)) {
    throw new ControlError("Run limits out of range: turns 1–500, time 1–240 minutes, budget $0.01–$1000.");
  }
  s.project.runLimits = { maxTurns: Math.round(limits.maxTurns), timeoutMinutes: limits.timeoutMinutes, maxBudgetUsd: limits.maxBudgetUsd };
  event(s, now, "user", "config", `Run limits: ${s.project.runLimits.maxTurns} turns, ${limits.timeoutMinutes} min, $${limits.maxBudgetUsd} (Claude)`);
  return s;
}

export function setWorkerEnvironment(state: State, provider: ProviderId, environment: WorkerEnvironment, now: string): State {
  const s = draft(state);
  s.project.workerEnvironment[provider] = environment;
  event(
    s,
    now,
    "user",
    "config",
    `${providerLabel(provider)} workers: ${environment === "local" ? "use the local setup (settings, MCP servers, plugins)" : "isolated from the local setup"}; applies to runs started from now on`,
  );
  return s;
}

export function setWorkerConnections(state: State, provider: ProviderId, names: string[], now: string): State {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort();
  if (clean.some((n) => n.length > 100)) throw new ControlError("Connection names are too long.");
  const s = draft(state);
  s.project.workerConnections[provider] = clean;
  event(s, now, "user", "config", `${providerLabel(provider)} isolated workers may use: ${clean.length ? clean.join(", ") : "no connections"}; applies to runs started from now on`);
  return s;
}

/** Replace the provider's model catalog with the list the connected runtime reported. */
export function setCatalog(state: State, provider: ProviderId, models: CatalogModel[], now: string): State {
  const s = draft(state);
  if (JSON.stringify(s.project.catalog[provider]) === JSON.stringify(models)) return state;
  s.project.catalog[provider] = models;
  event(s, now, "system", "config", `${providerLabel(provider)} model catalog updated from the runtime (${models.length} models)`);
  return s;
}

/**
 * Start a real project: empty board, the given repository and vision. Refused while any run is
 * active, so no live work is orphaned by the replacement.
 */
export function initProject(state: State, init: { name: string; repoPath: string; vision: string; focus: string }, now: string): State {
  if (activeAttempts(state).length) throw new ControlError("Stop all active runs (pause the project and wait for Paused) before starting a new project.");
  if (!init.name.trim() || !init.repoPath.trim() || !init.vision.trim()) throw new ControlError("Name, repository path, and vision are required.");
  const s = draft(state);
  s.project.id = `p-${Date.parse(now).toString(36)}-${s.seq.toString(36)}`;
  s.project.sample = false;
  s.project.name = init.name.trim();
  s.project.repoPath = init.repoPath.trim();
  // A new project starts from provider-neutral defaults, never another project's model choices.
  Object.assign(s.project, autoModelDefaults());
  s.project.visions = [{ rev: 1, at: now, author: "user", text: init.vision.trim(), focus: init.focus.trim(), reason: "Project created" }];
  s.project.hold = false;
  s.project.lastVisitAt = now;
  s.tasks = [];
  s.attempts = [];
  s.artifacts = [];
  s.events = [];
  event(s, now, "user", "vision", `Project "${s.project.name}" created for ${s.project.repoPath}`);
  return s;
}

export interface NewTask {
  title: string;
  area: string;
  outcome: string;
  benefit: string;
  whyNow: string;
  acceptance: string[];
  approach: string;
  priority: number;
  holdBeforeStart: boolean;
  steps: StepDef[];
  templateName: string;
}

/**
 * A user-authored task. Its spec records one approach decided by the user and says so; the lead
 * has not proposed alternatives (the spec allows a single option when that is stated).
 */
export function createTask(state: State, t: NewTask, now: string): { state: State; newId: string } {
  if (!t.title.trim() || !t.outcome.trim() || !t.approach.trim()) throw new ControlError("Title, outcome, and approach are required.");
  const errors = validatePipeline(t.steps).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`Pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);
  const s = draft(state);
  let n = s.tasks.length + 1;
  const ids = new Set(s.tasks.map((x) => x.id));
  while (ids.has(`T-${String(n).padStart(3, "0")}`)) n++;
  const id = `T-${String(n).padStart(3, "0")}`;
  const content: SpecContent = {
    title: t.title.trim(),
    area: t.area.trim() || "General",
    whyNow: t.whyNow.trim(),
    outcome: t.outcome.trim(),
    benefit: t.benefit.trim(),
    successCriteria: [],
    scopeIncluded: [],
    scopeExcluded: [],
    options: [
      { id: "A", name: "As described", approach: t.approach.trim(), benefit: t.benefit.trim(), effort: "Unknown", risks: "Not assessed; user-authored", reversibility: "Changes stay on an orchestration branch until merged" },
      { id: "B", name: "Defer", approach: "Do not do this now", benefit: "No cost", effort: "None", risks: "The outcome is not delivered", reversibility: "N/A" },
    ],
    recommendedOptionId: "A",
    selectedOptionId: "A",
    decidedBy: "user",
    rationale: "User-authored task; the lead has not proposed alternatives.",
    uncertainty: "",
    overrideReason: "",
    acceptance: t.acceptance.map((x) => x.trim()).filter(Boolean),
    validationPlan: "",
    rollback: "Discard the orchestration branch.",
    effort: "small",
  };
  const defs = structuredClone(t.steps);
  s.tasks.push({
    id,
    priority: Math.max(1, Math.round(t.priority) || 1),
    lifecycle: "proposed",
    hold: false,
    holdBeforeStart: t.holdBeforeStart,
    specs: [{ rev: 1, at: now, author: "user", reason: "Task created by user", content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "user", reason: `Created from the ${t.templateName} template`, steps: defs.map(toDef) }],
  });
  event(s, now, "user", "spec", `Created ${id}: ${content.title}`, id);
  return { state: s, newId: id };
}
