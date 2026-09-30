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
  type Autonomy,
  type Integration,
  type LeadRun,
  type LeadTrigger,
  type Message,
  type SpecOption,
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
  AUTOPILOT,
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

function finishTask(t: Task) {
  t.lifecycle = "done";
  t.integration = { status: "pending" };
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
  t.holdReason = undefined;
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
  const lead = activeLeadRun(s);
  if (lead && lead.outcome === "running") requestLeadStop(s, lead, "project paused", now);
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
  // The lead role default and the project lead are one choice: keep them from diverging.
  if (role === "lead" && selection) return setLeadSelection(state, selection, now);
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
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new ControlError("Worker limit must be between 1 and 16.");
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
    if (t.lifecycle !== "proposed" || t.hold || t.legacySpecUnavailable) continue;
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
    if (t.hold || t.holdBeforeStart || t.controlFailure || t.legacySpecUnavailable) continue;
    if (waitingOn(s, t) || blockedReason(s, t)) continue;
    // Reconcile before redispatch: nothing new while any run on this task is still stopping.
    if (activeAttempts(s, t.id).some((a) => a.outcome === "stopping")) continue;
    const spec = currentSpec(t);
    if (t.lifecycle === "active" && t.steps.every(isSettled) && activeAttempts(s, t.id).length === 0) {
      finishTask(t);
      touch(t, now);
      event(s, now, "lead", "integration", `All steps settled on spec r${spec.rev}; task Done, queued for integration`, t.id);
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
      if (r.ok && activeAttempts(s).filter((x) => x.snapshot.provider === r.selection.provider).length >= (s.project.providerLimits?.[r.selection.provider] ?? s.project.workerLimit)) continue;
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
    st.autoRetries = 0;
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
    // Optional review gate: stop here so a person can read or edit this step's output before the pipeline continues.
    const more = t.steps.some((x) => !isSettled(x));
    if ((st.gate || t.reviewEveryStep) && more && !t.hold) {
      t.hold = true;
      t.holdReason = `Review ${st.id} (${st.purpose}) before the pipeline continues`;
      event(s, now, "lead", "control", `Paused for review after ${st.id}; edit its artifacts if needed, then resume`, t.id);
    }
  }
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);

  if (t.lifecycle === "active" && t.steps.every(isSettled) && activeAttempts(s, t.id).length === 0 && !t.hold && !s.project.hold) {
    finishTask(t);
    event(s, now, "lead", "integration", `All steps settled on spec r${currentSpec(t).rev}; task Done, queued for integration`, t.id);
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
  const fromRun = run && s.artifacts.find((x) => x.attemptId === run.id && x.name === output);
  // A person's later edit of this output supersedes the run's version.
  let edited: Artifact | undefined;
  for (const x of s.artifacts) {
    if (x.taskId === t.id && x.stepId === stepId && x.name === output && x.author === "user" && (!fromRun || x.version > fromRun.version) && (!edited || x.version > edited.version)) edited = x;
  }
  return edited ?? fromRun;
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
    if (!def.gate) delete st.gate;
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
  if (activeAttempts(state).length || activeLeadRun(state)) throw new ControlError("Stop all active runs (pause the project and wait for Paused) before starting a new project.");
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
  s.conversation = [];
  s.leadRuns = [];
  s.project.lastPlanningAt = undefined;
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

// ---------- lead conversation and runs ----------

export function activeLeadRun(s: State): LeadRun | undefined {
  return s.leadRuns.find((r) => r.outcome === "running" || r.outcome === "stopping");
}

/** User messages not yet answered by a completed lead run (and not being answered right now). */
export function pendingMessages(s: State): Message[] {
  const covered = new Set(s.leadRuns.filter((r) => r.outcome === "completed" || r.outcome === "running").flatMap((r) => r.messageIds));
  return s.conversation.filter((m) => m.author === "user" && !covered.has(m.id));
}

/** Lead-proposed tasks that are not finished yet (the autonomy cap counts these). */
export function openLeadProposals(s: State): Task[] {
  return s.tasks.filter((t) => t.specs[0]?.author === "lead" && t.lifecycle !== "done" && t.lifecycle !== "cancelled");
}

export function postMessage(state: State, text: string, now: string): State {
  const body = text.trim();
  if (!body) throw new ControlError("Write a message first.");
  if (body.length > 8000) throw new ControlError("Messages are limited to 8000 characters.");
  const s = draft(state);
  s.conversation.push({ id: nextId(s, "msg"), at: now, author: "user", text: body });
  return s;
}

function inHours(hours: Autonomy["operatingHours"], localMinutes: number): boolean {
  if (!hours) return true;
  const m = (hhmm: string) => {
    const [h, mi] = hhmm.split(":").map(Number);
    return h * 60 + mi;
  };
  const a = m(hours.start);
  const b = m(hours.end);
  return a <= b ? localMinutes >= a && localMinutes < b : localMinutes >= a || localMinutes < b; // overnight windows
}

/**
 * Should the lead run now, and why? Messages always wake it (unless the project is paused);
 * planning needs autonomy on, operating hours, the interval (or a completion since the last plan),
 * and room under the open-proposal cap.
 */
export function leadDue(s: State, nowMs: number, localMinutes: number): LeadTrigger | null {
  if (s.project.hold || activeLeadRun(s)) return null;
  // Back off after failed or lost lead runs (rate limits, credentials, time limits): 1, 2, 4… minutes,
  // and after three in a row wait for a new message from the user instead of retrying on its own.
  let streak = 0;
  for (let i = s.leadRuns.length - 1; i >= 0 && (s.leadRuns[i].outcome === "failed" || s.leadRuns[i].outcome === "lost"); i--) streak++;
  if (streak) {
    const lastEnd = s.leadRuns[s.leadRuns.length - 1].endedAt ?? s.leadRuns[s.leadRuns.length - 1].startedAt;
    const newMessage = s.conversation.some((m) => m.author === "user" && m.at > lastEnd);
    if (streak >= 3 && !newMessage) return null;
    if (!newMessage && nowMs - Date.parse(lastEnd) < Math.min(60, 2 ** (streak - 1)) * 60_000) return null;
  }
  if (pendingMessages(s).length) return "message";
  const a = s.project.autonomy;
  if (!a.enabled || !inHours(a.operatingHours, localMinutes)) return null;
  if (openLeadProposals(s).length >= a.maxOpenProposals) return null;
  const last = s.project.lastPlanningAt ? Date.parse(s.project.lastPlanningAt) : 0;
  // Completions, integration conflicts, and blocked work since the last plan wake the lead sooner.
  const completedSince = s.tasks.some(
    (t) => t.updatedAt > (s.project.lastPlanningAt ?? "") && (t.lifecycle === "done" || t.integration?.status === "conflict" || t.steps.some((st) => st.state === "blocked")),
  );
  // Never more than 48 planning runs in 24 hours, whatever else wakes the lead.
  const dayAgo = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  if (s.leadRuns.filter((r) => r.trigger === "planning" && r.startedAt > dayAgo).length >= 48) return null;
  const wakeGap = Math.max(5, a.planningIntervalMinutes / 4) * 60_000;
  if (nowMs - last >= a.planningIntervalMinutes * 60_000 || (completedSince && nowMs - last >= wakeGap)) return "planning";
  return null;
}

export function startLeadRun(state: State, init: { provider: ProviderId; model: string; trigger: LeadTrigger }, now: string): { state: State; runId: string } {
  if (activeLeadRun(state)) throw new ControlError("A lead run is already active.");
  const s = draft(state);
  const id = nextId(s, "lead");
  s.leadRuns.push({ id, trigger: init.trigger, provider: init.provider, model: init.model, startedAt: now, outcome: "running", messageIds: pendingMessages(s).map((m) => m.id) });
  if (init.trigger === "planning") s.project.lastPlanningAt = now;
  event(s, now, "lead", "dispatch", `Lead ${init.trigger === "planning" ? "planning" : "reply"} run ${id} started on ${providerLabel(init.provider)} · ${init.model}`);
  return { state: s, runId: id };
}

function requestLeadStop(s: State, r: LeadRun, reason: string, now: string) {
  if (r.outcome !== "running") return;
  r.outcome = "stopping";
  r.stopRequestedAt = now;
  event(s, now, "system", "control", `Stop requested for lead run ${r.id} (${reason}); awaiting runtime acknowledgment`);
}

function getLeadRun(s: State, id: string): LeadRun | undefined {
  return s.leadRuns.find((r) => r.id === id);
}

export function reportLeadStarted(state: State, runId: string, info: { sessionId?: string; actualModel?: string }): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (r && (r.outcome === "running" || r.outcome === "stopping")) Object.assign(r, info.sessionId ? { sessionId: info.sessionId } : {}, info.actualModel ? { actualModel: info.actualModel } : {});
  return s;
}

export function reportLeadActivity(state: State, runId: string, note: string): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (r && (r.outcome === "running" || r.outcome === "stopping")) r.activity = note.slice(0, 200);
  return s;
}

/** The lead run is confirmed stopped (pause, lead switch) or its process is gone. Its messages stay pending. */
export function reportLeadStopped(state: State, runId: string, now: string, lost = false): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (!r || (r.outcome !== "running" && r.outcome !== "stopping")) return s;
  r.outcome = lost ? "lost" : r.outcome === "stopping" ? "stopped" : "failed";
  r.endedAt = now;
  if (r.outcome === "failed") r.note = "The lead run stopped without a stop request (for example its time limit).";
  event(s, now, "runtime", "runtime", `Lead run ${r.id} ${r.outcome}`);
  if (r.outcome === "failed" || r.outcome === "lost") {
    s.conversation.push({ id: nextId(s, "msg"), at: now, author: "system", text: `The lead run ended without a reply (${r.outcome}). Your messages are still pending and will be answered by the next run.` });
  }
  return s;
}

export function reportLeadFailed(state: State, runId: string, message: string, now: string, usage?: Attempt["usage"]): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (!r || (r.outcome !== "running" && r.outcome !== "stopping")) return s;
  const wasStopping = r.outcome === "stopping";
  r.outcome = wasStopping ? "stopped" : "failed";
  r.endedAt = now;
  r.note = message;
  if (usage) r.usage = usage;
  event(s, now, "runtime", "blocked", `Lead run ${r.id} failed: ${message}`);
  if (!wasStopping) s.conversation.push({ id: nextId(s, "msg"), at: now, author: "system", text: `The lead could not respond: ${message}` });
  return s;
}

export interface LeadProposal {
  title: string;
  area: string;
  whyNow: string;
  outcome: string;
  benefit: string;
  scopeIncluded: string[];
  scopeExcluded: string[];
  options: SpecOption[];
  recommendedOptionId: string;
  rationale: string;
  uncertainty: string;
  acceptance: string[];
  templateId: string;
  priority: number;
}

export interface LeadOutput {
  reply: string;
  proposals: LeadProposal[];
}

/** Check a proposal against the spec requirements. Returns a reason when it cannot become a task. */
export function validateProposal(s: State, p: LeadProposal): string | undefined {
  // Lead output is untrusted data: check types before anything else.
  const isStr = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (!p || typeof p !== "object") return "not an object";
  if (!isStr(p.title, 200) || !isStr(p.outcome, 4000)) return "a title (≤200 chars) and an outcome (≤4000 chars) are required";
  for (const k of ["area", "whyNow", "benefit", "uncertainty"] as const) if (p[k] !== undefined && (typeof p[k] !== "string" || p[k].length > 4000)) return `"${k}" must be text (≤4000 chars)`;
  if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 4) return "it needs two to four options (include deferring when only one approach is sensible)";
  if (p.options.some((o) => !o || typeof o !== "object" || !["string", "number"].includes(typeof o.id) || !isStr(o.name, 200) || !isStr(o.approach, 4000))) return "every option needs an id, a name, and an approach";
  const ids = new Set(p.options.map((o) => String(o.id)));
  if (ids.size !== p.options.length) return "option ids must be unique";
  if (!ids.has(String(p.recommendedOptionId))) return "the recommended option is not among the options";
  if (!isStr(p.rationale, 4000)) return "the decision needs a rationale";
  if (!Array.isArray(p.acceptance) || !p.acceptance.some((x) => typeof x === "string" && x.trim()) || p.acceptance.length > 30) return "it needs one to thirty acceptance checks";
  for (const k of ["scopeIncluded", "scopeExcluded"] as const) if (p[k] !== undefined && (!Array.isArray(p[k]) || p[k].length > 30)) return `"${k}" must be a list`;
  if (typeof p.templateId !== "string") return "templateId must be text";
  const tpl = s.project.templates.find((t) => t.id === p.templateId);
  if (!tpl) return `unknown template "${p.templateId}"`;
  if (s.tasks.some((t) => t.lifecycle !== "cancelled" && currentSpec(t).content.title.trim().toLowerCase() === (p.title as string).trim().toLowerCase())) return "a task with this title already exists";
  return undefined;
}

/** Apply a completed lead run: its reply, and each valid proposal as a new lead-authored task. */
export function completeLeadRun(state: State, runId: string, out: LeadOutput, now: string, run: RunReport = {}): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (!r || (r.outcome !== "running" && r.outcome !== "stopping")) return s;
  if (r.outcome === "stopping") {
    // Finished after a stop request: keep the reply for the record, but create nothing.
    r.outcome = "stopped";
    r.endedAt = now;
    r.note = `Finished after a stop request; its proposals were not applied. Reply: ${String(out.reply).slice(0, 2000)}`;
    return s;
  }
  r.outcome = "completed";
  r.endedAt = now;
  if (run.usage) r.usage = run.usage;
  if (run.actualModel) r.actualModel = run.actualModel;
  const limit = Math.max(1, s.project.autonomy.maxProposalsPerCycle);
  const openRoom = Math.max(0, s.project.autonomy.maxOpenProposals - openLeadProposals(s).length);
  // With autonomy off, proposals from a conversation still become tasks, but they wait for the user.
  const hold = !s.project.autonomy.enabled || s.project.autonomy.holdLeadProposals;
  const created: string[] = [];
  const rejected: string[] = [];
  const label = (p: unknown) => {
    const t = p && typeof p === "object" ? (p as { title?: unknown }).title : undefined;
    return typeof t === "string" ? t.slice(0, 80) : "(untitled)";
  };
  for (const [i, p] of out.proposals.entries()) {
    if (i >= limit) {
      rejected.push(`"${label(p)}": more than ${limit} proposals in one run`);
      continue;
    }
    if (created.length >= openRoom) {
      rejected.push(`"${label(p)}": the limit of ${s.project.autonomy.maxOpenProposals} open lead proposals is reached`);
      continue;
    }
    try {
      const why = validateProposal(s, p);
      if (why) {
        rejected.push(`"${label(p)}": ${why}`);
        continue;
      }
      created.push(proposeTask(s, p, now, hold));
    } catch (err) {
      rejected.push(`"${label(p)}": invalid (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  s.conversation.push({
    id: nextId(s, "msg"),
    at: now,
    author: "lead",
    text: out.reply.trim() || (created.length ? "I proposed new work; see the linked tasks." : "No reply."),
    leadRunId: r.id,
    ...(created.length ? { proposedTaskIds: created } : {}),
    ...(rejected.length ? { rejected } : {}),
  });
  event(s, now, "lead", "spec", `Lead run ${r.id} replied${created.length ? ` and proposed ${created.join(", ")}` : ""}${rejected.length ? `; ${rejected.length} proposal(s) rejected` : ""}`);
  return s;
}

function proposeTask(s: State, p: LeadProposal, now: string, hold: boolean): string {
  let n = s.tasks.length + 1;
  const ids = new Set(s.tasks.map((x) => x.id));
  while (ids.has(`T-${String(n).padStart(3, "0")}`)) n++;
  const id = `T-${String(n).padStart(3, "0")}`;
  const tpl = s.project.templates.find((t) => t.id === p.templateId)!;
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => String(x).trim()).filter(Boolean) : []);
  const content: SpecContent = {
    title: p.title.trim().slice(0, 200),
    area: (p.area ?? "").trim().slice(0, 60) || "General",
    whyNow: (p.whyNow ?? "").trim(),
    outcome: p.outcome.trim(),
    benefit: (p.benefit ?? "").trim(),
    successCriteria: [],
    scopeIncluded: list(p.scopeIncluded),
    scopeExcluded: list(p.scopeExcluded),
    options: p.options.map((o) => ({
      id: String(o.id).slice(0, 10),
      name: String(o.name),
      approach: String(o.approach),
      benefit: String(o.benefit ?? ""),
      effort: String(o.effort ?? ""),
      risks: String(o.risks ?? ""),
      reversibility: String(o.reversibility ?? ""),
    })),
    recommendedOptionId: String(p.recommendedOptionId).slice(0, 10),
    selectedOptionId: String(p.recommendedOptionId).slice(0, 10),
    decidedBy: "lead",
    rationale: p.rationale.trim(),
    uncertainty: (p.uncertainty ?? "").trim(),
    overrideReason: "",
    acceptance: list(p.acceptance),
    validationPlan: "",
    rollback: "Discard the orchestration branch; delivery to your branch happens only if you turned it on.",
    effort: "small",
  };
  const defs = structuredClone(tpl.steps);
  s.tasks.push({
    id,
    priority: Number.isFinite(p.priority) ? Math.min(99, Math.max(1, Math.round(p.priority))) : 5,
    lifecycle: "proposed",
    hold: false,
    holdBeforeStart: hold,
    specs: [{ rev: 1, at: now, author: "lead", reason: "Proposed by the lead", content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "lead", reason: `Lead applied the ${tpl.name} template`, steps: defs.map(toDef) }],
  });
  event(s, now, "lead", "decision", `Proposed ${id}: ${content.title} (selected option ${content.selectedOptionId})`, id);
  return id;
}

export function requestLeadRunStop(state: State, runId: string, reason: string, now: string): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (r) requestLeadStop(s, r, reason, now);
  return s;
}

export function reportLeadStopTimeout(state: State, runId: string, now: string): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (!r || r.outcome !== "stopping" || r.note?.startsWith("Control failure")) return s;
  r.note = "Control failure: the runtime has not acknowledged the stop request.";
  event(s, now, "system", "control", `Control failure: lead run ${r.id} did not acknowledge stop in time`);
  return s;
}

export function setAutonomy(state: State, a: Autonomy, now: string): State {
  const ok = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!ok(a.planningIntervalMinutes, 5, 24 * 60) || !ok(a.maxProposalsPerCycle, 1, 10) || !ok(a.maxOpenProposals, 1, 50)) {
    throw new ControlError("Autonomy limits out of range: interval 5–1440 minutes, 1–10 proposals per cycle, 1–50 open proposals.");
  }
  if (a.operatingHours && (!hhmm.test(a.operatingHours.start) || !hhmm.test(a.operatingHours.end))) throw new ControlError('Operating hours must be "HH:MM".');
  if (a.operatingHours && a.operatingHours.start === a.operatingHours.end) throw new ControlError("Operating hours need different start and end times (leave them off for any time).");
  if (!ok(a.autoRetry, 0, 5)) throw new ControlError("Automatic retries must be between 0 and 5.");
  if (a.autoDeliver.enabled && !/^[A-Za-z0-9._/-]{1,100}$/.test(a.autoDeliver.branch)) throw new ControlError("Choose a valid branch name for delivery.");
  const s = draft(state);
  s.project.autonomy = {
    enabled: !!a.enabled,
    planningIntervalMinutes: Math.round(a.planningIntervalMinutes),
    maxProposalsPerCycle: Math.round(a.maxProposalsPerCycle),
    maxOpenProposals: Math.round(a.maxOpenProposals),
    holdLeadProposals: !!a.holdLeadProposals,
    operatingHours: a.operatingHours ? { ...a.operatingHours } : null,
    autoRetry: Math.round(a.autoRetry),
    autoDeliver: { enabled: !!a.autoDeliver.enabled, branch: a.autoDeliver.branch.trim() || "main" },
  };
  const planning = activeLeadRun(s);
  if (!a.enabled && planning?.trigger === "planning") requestLeadStop(s, planning, "autonomy turned off", now);
  event(
    s,
    now,
    "user",
    "config",
    `Autonomy ${a.enabled ? `on: planning every ${s.project.autonomy.planningIntervalMinutes} min, ≤${s.project.autonomy.maxProposalsPerCycle} proposals per cycle, ≤${s.project.autonomy.maxOpenProposals} open${a.operatingHours ? `, ${a.operatingHours.start}–${a.operatingHours.end}` : ""}` : "off"}`,
  );
  return s;
}

/** Change who leads. An active lead run is stopped first; the next run uses the new selection. */
export function setLeadSelection(state: State, selection: ModelSelection, now: string): State {
  const cur = state.project.leadSelection;
  if (cur.provider === selection.provider && cur.model === selection.model && state.project.roleDefaults.lead?.model === selection.model) return state;
  if (!state.project.enabledProviders.includes(selection.provider)) throw new ControlError(`${providerLabel(selection.provider)} is not enabled.`);
  if (selection.model !== "auto" && !state.project.catalog[selection.provider].some((m) => m.id === selection.model)) {
    throw new ControlError(`Model ${selection.model} is not in the ${providerLabel(selection.provider)} catalog.`);
  }
  const s = draft(state);
  s.project.leadSelection = { ...selection };
  s.project.roleDefaults.lead = { ...selection };
  const r = activeLeadRun(s);
  if (r) requestLeadStop(s, r, "lead changed", now);
  event(s, now, "user", "config", `Lead set to ${providerLabel(selection.provider)} · ${selection.model}${r ? `; stopping ${r.id} first` : ""}`);
  return s;
}

// ---------- integration ----------

/** The next done task waiting for integration, oldest first. */
export function nextIntegration(s: State, nowMs = Date.now()): Task | undefined {
  // A pending task that hit an environment error waits a minute before the next attempt.
  const ready = (t: Task) => !t.integration?.at || nowMs - Date.parse(t.integration.at) >= 60_000;
  return s.tasks.filter((t) => t.lifecycle === "done" && t.integration?.status === "pending" && ready(t)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
}

/** Integration could not run for an environmental reason: keep it pending and retry later. */
export function reportIntegrationError(state: State, taskId: string, message: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.integration?.status !== "pending") return state;
  const repeated = t.integration.message === message;
  t.integration = { status: "pending", at: now, message };
  if (!repeated) event(s, now, "system", "blocked", `Integration is waiting: ${message}. It will be retried.`, t.id);
  return s;
}

/** Try a conflicted integration again (for example after resolving the conflict on the user's branch). */
export function retryIntegration(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done" || t.integration?.status !== "conflict") throw new ControlError(`${taskId} has no integration conflict to retry.`);
  t.integration = { status: "pending" };
  event(s, now, "user", "integration", "Integration will be retried", t.id);
  return s;
}

/** The task's final accepted code change (latest by time), if it produced one. */
export function finalChange(s: State, t: Task): Artifact | undefined {
  return s.artifacts.filter((a) => a.taskId === t.id && a.kind === "code-change" && a.ref).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
}

export function reportIntegration(state: State, taskId: string, result: Integration, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done" || t.integration?.status !== "pending") return s;
  t.integration = { ...result, at: now };
  if (result.status === "integrated" && s.project.autonomy.autoDeliver.enabled) s.project.delivery = { ...(s.project.delivery ?? {}), pending: true };
  const msg =
    result.status === "integrated"
      ? `Integrated into the integration branch (${result.ref})`
      : result.status === "conflict"
        ? `Integration conflict: ${result.message}`
        : "Nothing to integrate (no code change)";
  event(s, now, "lead", result.status === "conflict" ? "blocked" : "integration", msg, t.id);
  return s;
}

// ---------- automatic retries ----------

/** Failures a retry cannot fix: missing credentials, configuration, or unusable workspaces. */
const NOT_RETRYABLE = /API key|not signed in|not enabled|not in the .* catalog|not available|isolation|git metadata|not a git repository|time limit|usage limit|rate limit|quota|budget/i;

/** Steps blocked by a failed run that may be retried automatically now (bounded per step). */
export function autoRetryCandidates(s: State, nowMs = Date.now()): { taskId: string; stepId: string }[] {
  const max = s.project.autonomy.autoRetry;
  if (!max || s.project.hold) return [];
  const out: { taskId: string; stepId: string }[] = [];
  for (const t of s.tasks) {
    if (t.lifecycle === "done" || t.lifecycle === "cancelled" || t.hold) continue;
    for (const st of t.steps) {
      if (st.state !== "blocked" || !st.blockedReason?.startsWith("Last run failed")) continue;
      if ((st.autoRetries ?? 0) >= max || NOT_RETRYABLE.test(st.blockedReason)) continue;
      // Back off: 1, 2, 4 … minutes after the failed run ended.
      const last = s.attempts.filter((a) => a.taskId === t.id && a.stepId === st.id && a.endedAt).pop();
      if (last?.endedAt && nowMs - Date.parse(last.endedAt) < 2 ** (st.autoRetries ?? 0) * 60_000) continue;
      out.push({ taskId: t.id, stepId: st.id });
    }
  }
  return out;
}

export function autoRetryStep(state: State, taskId: string, stepId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  const st = getStep(t, stepId);
  if (st.state !== "blocked") return state;
  st.autoRetries = (st.autoRetries ?? 0) + 1;
  st.state = "pending";
  const reason = st.blockedReason;
  st.blockedReason = undefined;
  touch(t, now);
  event(s, now, "lead", "control", `Automatic retry ${st.autoRetries}/${s.project.autonomy.autoRetry} of ${stepId} after: ${reason}`, t.id);
  return s;
}

/** Is a delivery attempt due now? Failed attempts wait: 1 minute when skipped, 5 when conflicting. */
export function deliveryDue(s: State, nowMs: number): boolean {
  const d = s.project.delivery;
  if (!s.project.autonomy.autoDeliver.enabled || !d?.pending || s.project.hold) return false;
  if (!d.lastAttemptAt) return true;
  const wait = d.status === "conflict" ? 5 * 60_000 : 60_000;
  return nowMs - Date.parse(d.lastAttemptAt) >= wait;
}

/**
 * Record a delivery attempt. Delivered: every integrated task not yet delivered is marked delivered.
 * Blocked (the branch was reset or rewritten, or foreign commits would be added): automatic delivery
 * is switched off and the user decides.
 */
export function reportDeliveryResult(state: State, result: { status: "delivered" | "skipped" | "conflict" | "blocked"; message: string; sha?: string }, now: string): State {
  const s = draft(state);
  const prev = s.project.delivery ?? { pending: true };
  const changed = prev.status !== result.status || prev.message !== result.message;
  s.project.delivery = {
    ...prev,
    pending: result.status !== "delivered" && result.status !== "blocked",
    lastAttemptAt: now,
    status: result.status,
    message: result.message,
    ...(result.status === "delivered" && result.sha ? { lastSha: result.sha } : {}),
  };
  if (result.status === "blocked") s.project.autonomy.autoDeliver = { ...s.project.autonomy.autoDeliver, enabled: false };
  for (const t of s.tasks) {
    if (t.integration?.status !== "integrated" || t.integration.delivered?.status === "delivered") continue;
    t.integration.delivered = { status: result.status, at: now, message: result.message };
  }
  if (changed) event(s, now, "lead", result.status === "delivered" ? "integration" : "blocked", `Delivery to ${s.project.autonomy.autoDeliver.branch}: ${result.message}`);
  return s;
}

/** The autopilot preset: planning on, no holds, one automatic retry, automatic delivery to the given branch. */
export function applyAutopilot(state: State, branch: string, now: string): State {
  const a = state.project.autonomy;
  return setAutonomy(
    state,
    {
      enabled: true,
      planningIntervalMinutes: AUTOPILOT.planningIntervalMinutes,
      maxProposalsPerCycle: AUTOPILOT.maxProposalsPerCycle,
      maxOpenProposals: AUTOPILOT.maxOpenProposals,
      holdLeadProposals: false,
      operatingHours: a.operatingHours,
      autoRetry: AUTOPILOT.autoRetry,
      autoDeliver: { enabled: true, branch },
    },
    now,
  );
}

// ---------- Markdown import / export ----------

/** Board as Markdown, for repository visibility. The service's database remains the source of truth. */
export function exportMarkdown(s: State): string {
  const rows = [...s.tasks]
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((t) => {
      const c = currentSpec(t).content;
      const sel = c.options.find((o) => o.id === c.selectedOptionId);
      const cell = (x: string) => x.replace(/\|/g, "\\|").replace(/\n/g, " ");
      return `| ${t.id} | ${cell(c.title)} | ${stateLabel(s, t)} | P${t.priority} | ${cell(sel ? `${sel.id}: ${sel.name}` : "—")} | ${t.integration?.status ?? "—"} | ${t.specs[0].author} |`;
    });
  const v = currentVision(s);
  return `# ${s.project.name}

Generated by Orchestration on ${new Date().toISOString()}. Exported for visibility; edit tasks in Orchestration.

## Vision (r${v.rev})

${v.text}

Current focus: ${v.focus}

## Tasks

| ID | Title | State | Priority | Selected approach | Integration | Author |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}

/**
 * Import a Markdown task table once, preserving IDs. Recognises a header row containing "ID" and a
 * title-like column ("Title", "Task", "Outcome"), and optionally "State"/"Status". Rows whose state
 * reads done become done tasks with "legacy spec unavailable"; all others become held proposals that
 * cannot run until a spec is written. Existing IDs are skipped.
 */
export function importMarkdown(state: State, markdown: string, now: string): { state: State; imported: string[]; skipped: string[] } {
  const lines = markdown.split(/\r?\n/).filter((l) => l.trim().startsWith("|"));
  const split = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  const s = draft(state);
  const imported: string[] = [];
  const skipped: string[] = [];
  let header: string[] | null = null;
  for (const line of lines) {
    const cells = split(line);
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.includes("id") && lower.some((c) => ["title", "task", "outcome", "proposed outcome"].includes(c))) {
      header = lower;
      continue;
    }
    if (!header) continue;
    const col = (...names: string[]) => header!.findIndex((h) => names.includes(h));
    const linkText = (c: string | undefined) => (c ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const id = linkText(cells[col("id")]).replace(/[^A-Za-z0-9._-]/g, "");
    const title = linkText(cells[col("title", "task", "outcome", "proposed outcome")]);
    const prioCell = Number.parseInt(linkText(cells[col("priority")]), 10);
    const stateCell = (cells[col("state", "status")] ?? "").toLowerCase();
    if (!id || !title) continue;
    // IDs become part of git branch names and must not collide with the lead's reserved id.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/.test(id) || id.endsWith(".lock") || id.toUpperCase() === "LEAD" || id.length > 40) {
      skipped.push(`${id} (invalid id)`);
      continue;
    }
    if (s.tasks.some((t) => t.id === id)) {
      skipped.push(id);
      continue;
    }
    const done = /\b(done|complete|completed|shipped)\b/.test(stateCell);
    const content: SpecContent = {
      title: title.slice(0, 200),
      area: "Imported",
      whyNow: "",
      outcome: title,
      benefit: "",
      successCriteria: [],
      scopeIncluded: [],
      scopeExcluded: [],
      options: [{ id: "A", name: "Legacy", approach: "Imported from a Markdown board; no specification was recorded.", benefit: "", effort: "", risks: "", reversibility: "" }],
      recommendedOptionId: "A",
      selectedOptionId: "A",
      decidedBy: "user",
      rationale: "Legacy spec unavailable.",
      uncertainty: "",
      overrideReason: "",
      acceptance: [],
      validationPlan: "",
      rollback: "",
      effort: "small",
    };
    const defs = structuredClone(s.project.templates.find((t) => t.id === "change")?.steps ?? []);
    s.tasks.push({
      id,
      priority: Number.isFinite(prioCell) && prioCell > 0 ? Math.min(99, prioCell) : 5,
      lifecycle: done ? "done" : "proposed",
      hold: false,
      holdBeforeStart: !done,
      specs: [{ rev: 1, at: now, author: "user", reason: "Imported from Markdown", content }],
      steps: instantiate(defs).map((st) => (done ? { ...st, state: "done" as const } : st)),
      roleOverrides: {},
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
      decisionAt: now,
      pipelineRev: 1,
      pipelineHistory: [{ rev: 1, at: now, author: "user", reason: "Imported", steps: defs.map(toDef) }],
      legacySpecUnavailable: true,
      ...(done ? { integration: { status: "not-needed" as const } } : {}),
    });
    imported.push(id);
  }
  if (!imported.length && !skipped.length) throw new ControlError("No task table found. Expected a Markdown table with an ID column and a Title (or Task/Outcome) column.");
  event(s, now, "user", "spec", `Imported ${imported.length} task(s) from Markdown${skipped.length ? `; skipped existing ${skipped.join(", ")}` : ""}. Open imported tasks need a spec before they run.`);
  return { state: s, imported, skipped };
}

// ---------- human review and editing of artifacts ----------

export function setReviewEveryStep(state: State, taskId: string, value: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Changing review mode");
  t.reviewEveryStep = value;
  touch(t, now);
  event(s, now, "user", "control", value ? "Step-by-step review on: the task pauses after every step" : "Step-by-step review off", t.id);
  return s;
}

export function setProviderLimit(state: State, provider: ProviderId, limit: number, now: string): State {
  if (!Number.isInteger(limit) || limit < 0 || limit > 16) throw new ControlError("Provider limit must be between 0 and 16.");
  const s = draft(state);
  s.project.providerLimits[provider] = limit;
  event(s, now, "user", "config", `${providerLabel(provider)} concurrent runs limited to ${limit}`);
  return s;
}

/**
 * A person edits (or replaces) a step's output. The edit becomes a new version that later steps
 * receive; every step downstream that already used an earlier version is revalidated (stopped if
 * running, requeued if done), which re-submits the work through the rest of the pipeline.
 */
export function editArtifact(
  state: State,
  artifactId: string,
  change: { summary: string; openFindings?: number; ref?: string; reason: string },
  now: string,
): State {
  const s = draft(state);
  const base = s.artifacts.find((a) => a.id === artifactId);
  if (!base) throw new ControlError(`Unknown artifact ${artifactId}`);
  const t = getTask(s, base.taskId);
  assertOpen(t, "Editing an artifact");
  const st = getStep(t, base.stepId);
  if (!change.reason.trim()) throw new ControlError("Say why you changed it; the reason goes to the next steps.");
  if (!change.summary.trim()) throw new ControlError("The artifact cannot be empty.");
  if (base.kind === "review-findings" && (!Number.isInteger(change.openFindings) || change.openFindings! < 0)) throw new ControlError("Review findings need a number of open findings.");
  if (change.ref?.trim() && !/^[0-9a-f]{7,40}$/i.test(change.ref.trim())) throw new ControlError("Use a commit hash (7–40 hex characters) for your own change.");
  const version = Math.max(...s.artifacts.filter((a) => a.taskId === t.id && a.stepId === st.id && a.name === base.name).map((a) => a.version)) + 1;
  const art: Artifact = {
    id: nextId(s, "art"),
    taskId: t.id,
    stepId: st.id,
    attemptId: "edit",
    name: base.name,
    kind: base.kind,
    version,
    summary: change.summary.slice(0, 20000),
    createdAt: now,
    author: "user",
    editReason: change.reason.trim(),
    ...(base.kind === "review-findings" ? { openFindings: change.openFindings } : {}),
    ...(change.ref?.trim() ? { ref: change.ref.trim() } : base.ref ? { ref: base.ref } : {}),
  };
  s.artifacts.push(art);
  // Re-submit: everything downstream of this step that consumed it (directly or transitively).
  const downstream = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of t.steps) {
      if (downstream.has(d.id)) continue;
      if (d.dependsOn.includes(st.id) || d.dependsOn.some((x) => downstream.has(x))) {
        downstream.add(d.id);
        grew = true;
      }
    }
  }
  for (const d of t.steps) {
    if (!downstream.has(d.id)) continue;
    if (isSettled(d)) {
      d.state = t.hold ? "paused" : "pending";
      d.invalidatedBy = `edited ${st.id}.${base.name}`;
    }
  }
  for (const a of activeAttempts(s, t.id)) {
    if (!downstream.has(a.stepId)) continue;
    const d = findStep(t, a.stepId);
    if (d) d.revision += 1;
    requestStop(s, a, "revision", now);
  }
  touch(t, now);
  event(s, now, "user", "spec", `Edited ${st.id}.${base.name} (v${version}): ${art.editReason}${downstream.size ? `; re-submitting ${[...downstream].join(", ")}` : ""}`, t.id);
  return s;
}
