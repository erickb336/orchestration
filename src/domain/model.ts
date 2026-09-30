// State transitions for tasks, specs, steps, and runs.
// Every operation is pure: it returns a new State and never mutates its input.
// Operations are applied one at a time, which serializes races such as
// pause-vs-completion: whichever is applied first determines the outcome.

import { recordLanded, undeliveredTasks } from "./delivery";
import { downstreamOf, instantiate, structuralKey, toDef, validatePipeline } from "./pipeline";
import { INTERNAL_TEMPLATE_IDS } from "./templates";
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
  type InputRef,
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
  DEFAULT_PR_DELIVERY,
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
    case "independence":
      return "Independent of the writer";
    case "project-role":
      return "Project role default";
    case "project-default":
      return "Project default";
  }
}

// ---------- derived presentation state ----------

export type Column = "proposed" | "ready" | "running" | "reviewing" | "paused" | "blocked" | "done" | "cancelled";
export const BOARD_COLUMNS: Column[] = ["proposed", "ready", "running", "reviewing", "paused", "blocked", "done"];

/** A finished task whose pull request was closed without merging (pull-request delivery only). */
function closedPr(s: State, d: Task | undefined): number | "unopened" | undefined {
  const i = d?.integration;
  if (!s.project.prDelivery.enabled || d?.lifecycle !== "done" || i?.status !== "integrated" || i.pr?.phase !== "closed") return undefined;
  return i.pr.number ?? "unopened";
}
const closedText = (id: string, n: number | "unopened") => (n === "unopened" ? `${id}'s pull request was abandoned before it was opened` : `${id}'s PR #${n} was closed without merging`);

/**
 * Is a prerequisite's work available to the tasks that depend on it? Without pull-request delivery:
 * when it is done. With it: when its code is in the base new work starts from, which means its pull
 * request merged and the base was fetched afterwards (or it had nothing to deliver, or it was
 * integrated before pull-request delivery was switched on).
 */
export function prerequisiteReady(s: State, d: Task | undefined): boolean {
  if (d?.lifecycle !== "done") return false;
  if (!s.project.prDelivery.enabled) return true;
  const i = d.integration;
  if (!i || i.status === "not-needed") return true;
  if (i.status !== "integrated") return false;
  if (!i.pr) return true;
  const fetchedAt = s.project.github?.base?.fetchedAt;
  return !!i.landed && !!fetchedAt && fetchedAt >= i.landed.at;
}

export function blockedReason(s: State, t: Task): string | undefined {
  for (const dep of t.dependsOn) {
    const d = s.tasks.find((x) => x.id === dep);
    if (d?.lifecycle === "cancelled") return `Prerequisite ${dep} was cancelled`;
    const closed = closedPr(s, d);
    if (closed !== undefined) return `${closedText(dep, closed)}. Deliver ${dep} again, or remove the prerequisite.`;
  }
  const st = t.steps.find((x) => x.state === "blocked");
  if (st) return `${st.id}: ${st.blockedReason ?? "blocked"}`;
  if (waitingForChildren(s, t)) {
    for (const c of childTasks(s, t)) {
      if (!isOpen(c)) continue;
      const dep = c.dependsOn.find((d) => s.tasks.find((x) => x.id === d)?.lifecycle === "cancelled");
      if (dep) return `Child ${c.id} cannot start: its prerequisite ${dep} was cancelled. Cancel ${c.id} or remove the prerequisite.`;
    }
    for (const c of childTasks(s, t)) {
      const closed = closedPr(s, c);
      if (closed !== undefined) return `Child ${closedText(c.id, closed)}. Deliver ${c.id} again.`;
    }
  }
  return undefined;
}

/** A pending step that is ready except that it waits for this task's child tasks to finish. */
export function waitingForChildren(s: State, t: Task): Step | undefined {
  if (childrenSettled(s, t)) return undefined;
  return t.steps.find((x) => x.state === "pending" && x.waitForChildren && x.dependsOn.every((d) => isSettled(getStep(t, d))));
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
  if (t.lifecycle === "active" && active.length === 0 && waitingForChildren(s, t)) {
    const open = childTasks(s, t).filter(isOpen).length;
    if (open === 0) return "Waiting for child pull requests to merge";
    return `Waiting for ${open} child task${open === 1 ? "" : "s"}`;
  }
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
  return t.dependsOn.find((d) => !prerequisiteReady(s, s.tasks.find((x) => x.id === d)));
}

/** Why a finished prerequisite is still waited on (pull-request delivery), in plain words. */
export function waitingDetail(s: State, depId: string): string | undefined {
  const d = s.tasks.find((x) => x.id === depId);
  if (d?.lifecycle !== "done" || prerequisiteReady(s, d)) return undefined;
  const i = d.integration;
  const pr = i?.status === "integrated" ? i.pr : undefined;
  if (pr && i?.landed) return `${depId}'s pull request merged; waiting for the next fetch of ${pr.remote}/${pr.base}`;
  if (pr) return pr.number ? `Waiting for ${depId}'s PR #${pr.number} to merge` : `Waiting for ${depId}'s pull request to be opened and merged`;
  return `Waiting for ${depId}'s pull request to be prepared`;
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

export interface FollowUpOptions {
  /** Default true: the follow-up waits for the user's release before its first dispatch. */
  holdBeforeStart?: boolean;
  /** The pipeline to run. Default: the origin's pipeline as it was before any expansion. */
  steps?: StepDef[];
  author?: Actor;
  /** Default: the origin task (already done, so it never delays the follow-up). */
  dependsOn?: string[];
  /** Extra task fields, for example `revertOf` or `deliverInto`. */
  fields?: Partial<Task>;
}

/** The origin's pipeline before any loop iteration or parallel copy was added to it. */
function unexpandedSteps(t: Task): StepDef[] {
  const expanded = (d: StepDef) => !!d.copyOf || d.iteration !== undefined;
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
  const defs = (opts.steps ? structuredClone(opts.steps) : unexpandedSteps(t)).map(toDef);
  const errors = validatePipeline(defs).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`The follow-up's pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);
  const steps = instantiate(defs);
  // A copied pipeline keeps the models the user pinned on its steps.
  if (!opts.steps) for (const st of steps) st.selection = structuredClone(findStep(t, st.id)?.selection ?? null);
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
    pipelineHistory: [{ rev: 1, at: now, author, reason: opts.steps ? `Follow-up to ${t.id}` : `Copied from ${t.id}`, steps: defs }],
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

// ---------- task controls ----------

function holdTask(s: State, t: Task, now: string, with_?: string) {
  t.hold = true; // persist the hold before interrupting anything
  if (with_) t.pausedWith = with_;
  touch(t, now);
  const active = activeAttempts(s, t.id);
  const why = with_ ? ` with ${with_}` : "";
  event(s, now, "user", "control", active.length ? `Pause requested${why}; hold saved, interrupting ${active.length} run(s)` : `Paused${why}; hold saved and excluded from dispatch`, t.id);
  for (const a of active) requestStop(s, a, "pause", now);
}

const isOpen = (t: Task) => t.lifecycle !== "done" && t.lifecycle !== "cancelled";

/** Pausing a task also pauses its unfinished child tasks (and theirs); resuming it resumes them. */
export function pauseTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Pausing");
  if (t.hold) return s;
  holdTask(s, t, now);
  for (const d of descendants(s, t)) if (isOpen(d) && !d.hold) holdTask(s, d, now, t.id);
  return s;
}

export function resumeTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Resuming");
  if (!t.hold) throw new ControlError(`${t.id} has no hold to clear.`);
  t.hold = false;
  t.holdReason = undefined;
  t.pausedWith = undefined;
  for (const st of t.steps) if (st.state === "paused") st.state = "pending";
  // Breakdowns reviewed at a gate (or edited while paused): create their children now, from the latest version.
  const pending = t.pendingBreakdowns ?? [];
  t.pendingBreakdowns = undefined;
  for (const pb of pending) applyBreakdown(s, t, pb.stepId, pb.output, now);
  touch(t, now);
  const note = s.project.hold ? " Project is still paused, so nothing will dispatch until it resumes." : " It is not running until dispatched.";
  event(s, now, "user", "control", `Hold cleared; requeued.${note}`, t.id);
  // Child tasks paused together with this one (or with one of its ancestors) resume with it.
  const above = new Set([t.id]);
  for (let cur = t, i = 0; cur.parentTaskId && i < 10; i++) {
    above.add(cur.parentTaskId);
    const p = s.tasks.find((x) => x.id === cur.parentTaskId);
    if (!p) break;
    cur = p;
  }
  for (const d of descendants(s, t)) {
    if (!d.pausedWith || !above.has(d.pausedWith) || !isOpen(d)) continue;
    d.hold = false;
    d.pausedWith = undefined;
    for (const st of d.steps) if (st.state === "paused") st.state = "pending";
    touch(d, now);
    event(s, now, "user", "control", `Resumed with ${t.id}`, d.id);
  }
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
  // Unfinished child tasks exist only for this task's goal: cancel them too.
  const children = descendants(s, t).filter(isOpen);
  for (const c of children) {
    c.lifecycle = "cancelled";
    touch(c, now);
    const runs = activeAttempts(s, c.id);
    event(s, now, "user", "control", `Cancelled with ${t.id}${runs.length ? `; stopping ${runs.length} run(s)` : ""}`, c.id);
    for (const a of runs) requestStop(s, a, "cancel", now);
  }
  const gone = new Set([t.id, ...children.map((c) => c.id)]);
  for (const d of s.tasks.filter((x) => isOpen(x) && !gone.has(x.id))) {
    const dep = d.dependsOn.find((x) => gone.has(x));
    if (dep) event(s, now, "system", "blocked", `Blocked: prerequisite ${dep} was cancelled`, d.id);
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
  /**
   * Set while writers have no base to start from (pull-request delivery before the first fetch):
   * coder steps that continue no earlier change are not dispatched. Nothing is blocked or failed.
   */
  holdWriters?: string;
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
    // Parallel steps become their copies the first time they are ready to run.
    for (const st of [...t.steps]) {
      if (st.parallel && !st.copyOf && st.state === "pending" && st.dependsOn.every((d) => isSettled(getStep(t, d)))) expandParallel(s, t, st, now);
    }
    for (const st of [...t.steps]) {
      if (activeAttempts(s).length >= s.project.workerLimit) break;
      if (st.state !== "pending") continue;
      const depsDone = st.dependsOn.every((d) => isSettled(getStep(t, d)));
      if (!depsDone) continue;
      if (st.waitForChildren && !childrenSettled(s, t)) continue;
      if (awaitingChoice(s, t, st)) continue;
      if (opts.holdWriters && st.role === "coder" && !consumedInputs(s, t, st).some((i) => s.artifacts.find((x) => x.id === i.artifactId)?.kind === "code-change")) continue;
      if ((st.iteration ?? 1) > 1 && st.dependsOn.length && st.dependsOn.every((d) => getStep(t, d).state === "skipped")) {
        // The previous iteration ended without work to repeat (for example after a re-run came back clean).
        st.state = "skipped";
        st.invalidatedBy = undefined;
        touch(t, now);
        event(s, now, "lead", "dispatch", `Skipped ${st.id}: the previous iteration ended clean`, t.id);
        continue;
      }
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
  /** Breakdown outputs: the work items that become child tasks. */
  items?: unknown[];
  /** Durable reference, e.g. "<sha> on orchestration/run-12". */
  ref?: string;
}

export interface RunReport {
  usage?: Attempt["usage"];
  actualModel?: string;
  /** For a step that compared best-of candidates: the step id of the chosen copy. */
  chosen?: string;
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
        ...(def.kind === "breakdown" ? { items: structuredClone(rep.items ?? []) } : {}),
      };
      s.artifacts.push(art);
      produced.push(`${def.name} v${version}`);
    }
    event(s, now, "runtime", "runtime", `${st.id} completed by ${providerLabel(a.snapshot.provider)} · ${a.snapshot.model}${produced.length ? `; produced ${produced.join(", ")}` : ""}`, t.id);
    // Best-of: record which candidate this step chose (default: the first completed copy).
    recordBestOfChoice(s, t, st, run.chosen, now);
    // Breakdown outputs become child tasks; loops append their next iteration.
    const breakdowns = st.outputs.filter((d) => d.kind === "breakdown");
    const gated = (st.gate || t.reviewEveryStep) && t.steps.some((x) => !isSettled(x));
    if (breakdowns.length && gated) {
      // Children are created when the person resumes, from the (possibly edited) latest version.
      t.pendingBreakdowns = breakdowns.map((d) => ({ stepId: st.id, output: d.name }));
    } else if (breakdowns.length) {
      for (const def of breakdowns) applyBreakdown(s, t, st.id, def.name, now);
    } else if (st.iterate) expandIteration(s, t, st, now);
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
    // After a best-of choice, only the chosen candidate goes further.
    const member = findStep(t, r.step);
    const group = member?.copyOf;
    if (group && t.bestOf?.[group] && t.bestOf[group] !== r.step && st.id !== chooserOf(t, group)) continue;
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
  const old = new Map(t.steps.map((st) => [st.id, st]));
  // `copyOf` and `iteration` are set by the service when it expands steps: they carry over from the
  // existing step, and a client can neither add nor drop them.
  defs = defs.map((d) => {
    const prev = old.get(d.id);
    const n: StepDef = { ...d };
    delete n.copyOf;
    delete n.iteration;
    if (prev?.copyOf) n.copyOf = prev.copyOf;
    if (prev?.iteration && prev.iteration > 1) n.iteration = prev.iteration;
    return n;
  });
  const errors = validatePipeline(defs).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`Pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);
  for (const d of defs) {
    const prev = old.get(d.id);
    if (prev?.copyOf === prev?.id && prev?.parallel && JSON.stringify(prev.parallel) !== JSON.stringify(d.parallel ?? null)) {
      throw new ControlError(`${d.id} already runs as ${prev.parallel.count} parallel agents, so its parallel setting cannot change. Add a new step instead.`);
    }
  }

  const retired = new Set(t.pipelineHistory.flatMap((p) => p.steps.map((x) => x.id)).filter((id) => !t.steps.some((st) => st.id === id)));
  const reused = defs.filter((d) => retired.has(d.id)).map((d) => d.id);
  if (reused.length) throw new ControlError(`Step ID ${reused.join(", ")} belonged to a removed step; new steps need new IDs so their history stays separate.`);

  const rev = t.pipelineRev + 1;
  const changed = new Set<string>();
  for (const d of defs) {
    const prev = old.get(d.id);
    if (!prev || structuralKey(prev) !== structuralKey(d)) changed.add(d.id);
  }
  // Parallel copies are separate steps but do the leader's work: a changed leader changes and re-runs
  // them too (unless the person edited that copy in the same revision).
  defs = defs.map((d) => {
    const leader = d.copyOf && d.copyOf !== d.id && changed.has(d.copyOf) ? defs.find((x) => x.id === d.copyOf) : undefined;
    if (!leader) return d;
    changed.add(d.id);
    const prev = old.get(d.id);
    if (prev && structuralKey(prev) !== structuralKey(d)) return d;
    const suffix = / \(copy \d+ of \d+\)$/.exec(d.purpose)?.[0] ?? "";
    const synced: StepDef = { ...toDef(leader), id: d.id, purpose: `${leader.purpose}${suffix}`, copyOf: d.copyOf };
    delete synced.parallel;
    return synced;
  });
  const syncErrors = validatePipeline(defs).filter((i) => i.severity === "error");
  if (syncErrors.length) {
    throw new ControlError(`Parallel copies follow their step's changes, and here that makes the pipeline invalid: ${syncErrors.map((e) => e.message).join(" ")} Update the steps that read the copies too.`);
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
    // The new definition is the whole truth: optional settings it leaves out are removed.
    for (const k of ["runIf", "gate", "iterate", "parallel", "waitForChildren", "copyOf", "iteration"] as const) if (def[k] === undefined) delete st[k];
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
  // Delivery to GitHub is a choice made per project and repository: a new project starts with it off
  // and with nothing observed about the previous repository.
  s.project.prDelivery = structuredClone(DEFAULT_PR_DELIVERY);
  delete s.project.github;
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

/** Lead-proposed tasks (including child tasks from breakdowns) that are not finished yet: the autonomy cap counts these. */
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
  if (!tpl || INTERNAL_TEMPLATE_IDS.includes(tpl.id)) return `unknown template "${p.templateId}"`;
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

function proposeTask(s: State, p: LeadProposal, now: string, hold: boolean, fixedId?: string): string {
  let n = s.tasks.length + 1;
  const ids = new Set(s.tasks.map((x) => x.id));
  while (ids.has(`T-${String(n).padStart(3, "0")}`)) n++;
  const id = fixedId ?? `T-${String(n).padStart(3, "0")}`;
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
  // The two delivery modes are never on together.
  if (a.autoDeliver.enabled && state.project.prDelivery.enabled) throw new ControlError("Pull-request delivery is on; switch the delivery mode instead.");
  const s = draft(state);
  const before = state.project.autonomy.autoDeliver;
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
  const after = s.project.autonomy.autoDeliver;
  if (after.enabled && (!before.enabled || after.branch !== before.branch)) {
    // The baseline and the last result describe the previous branch; work integrated while delivery
    // was off (or while it went to another branch) is queued.
    if (after.branch !== before.branch && s.project.delivery) s.project.delivery = { pending: s.project.delivery.pending };
    if (undeliveredTasks(s).length) s.project.delivery = { ...(s.project.delivery ?? {}), pending: true };
  }
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
  // A closed pull request stays on the record so the next one takes the next number.
  t.integration = { status: "pending", at: now, message, ...(t.integration.pr ? { pr: t.integration.pr } : {}) };
  if (!repeated) event(s, now, "system", "blocked", `Integration is waiting: ${message}. It will be retried.`, t.id);
  return s;
}

/** Try a conflicted integration again (for example after resolving the conflict on the user's branch). */
export function retryIntegration(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done" || t.integration?.status !== "conflict") throw new ControlError(`${taskId} has no integration conflict to retry.`);
  t.integration = { status: "pending", ...(t.integration.pr ? { pr: t.integration.pr } : {}) };
  event(s, now, "user", "integration", "Integration will be retried", t.id);
  return s;
}

/**
 * The task's final code change: the latest accepted change of a step that is done now. Skipped or
 * re-run steps contribute nothing, even if they produced a change earlier.
 */
export function finalChange(s: State, t: Task): Artifact | undefined {
  const unchosen = (stepId: string) => {
    const g = findStep(t, stepId)?.copyOf;
    if (!g) return false;
    // Without a recorded choice, only the first candidate counts (never "whichever finished last").
    return t.bestOf?.[g] ? t.bestOf[g] !== stepId : findStep(t, g)?.parallel?.mode === "best-of" && stepId !== g;
  };
  const changes: Artifact[] = [];
  for (const st of t.steps) {
    if (st.state !== "done" || unchosen(st.id)) continue;
    for (const o of st.outputs) {
      if (o.kind !== "code-change") continue;
      const a = acceptedOutput(s, t, st.id, o.name);
      if (a?.ref) changes.push(a);
    }
  }
  return changes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
}

export function reportIntegration(state: State, taskId: string, result: Integration, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  if (t.lifecycle !== "done" || t.integration?.status !== "pending") return s;
  const closed = t.integration.pr;
  // A conflict keeps the earlier (closed) pull request on the record, so a retry takes the next number.
  t.integration = { ...result, at: now, ...(result.status === "conflict" && !result.pr && closed ? { pr: closed } : {}) };
  // A prepared pull-request head is not on the integration branch: local delivery has nothing to do for it.
  const pr = result.pr;
  if (result.status === "integrated" && !pr && s.project.autonomy.autoDeliver.enabled) s.project.delivery = { ...(s.project.delivery ?? {}), pending: true };
  const msg =
    result.status === "integrated"
      ? pr
        ? `Prepared pull request branch ${pr.branch} (${pr.headSha.slice(0, 12)})`
        : `Integrated into the integration branch (${result.ref})`
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
 * Record a delivery attempt. Delivered: every integrated task not yet delivered is marked delivered
 * and gets its review-later item. Blocked (the branch was reset or rewritten, or foreign commits would
 * be added): automatic delivery is switched off and the user decides. Tasks delivered as pull requests
 * are never touched. A retry with the same outcome leaves the tasks as they were, so it is not a new event.
 */
export function reportDeliveryResult(state: State, result: { status: "delivered" | "skipped" | "conflict" | "blocked"; message: string; sha?: string }, now: string): State {
  const s = draft(state);
  const prev = s.project.delivery ?? { pending: true };
  const changed = prev.status !== result.status || prev.message !== result.message;
  const branch = s.project.autonomy.autoDeliver.branch;
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
    const i = t.integration;
    if (i?.status !== "integrated" || i.pr || i.delivered?.status === "delivered") continue;
    if (i.delivered?.status !== result.status || i.delivered.message !== result.message) i.delivered = { status: result.status, at: now, message: result.message };
    // Work integrated before its merge commit was recorded cannot be shown later, so it is not listed.
    if (result.status === "delivered" && i.sha) recordLanded(s, t, { via: "local", target: branch, commit: i.sha, by: "app" }, now);
  }
  if (changed) event(s, now, "lead", result.status === "delivered" ? "integration" : "blocked", `Delivery to ${branch}: ${result.message}`);
  return s;
}

/**
 * Local delivery stopped because the branch no longer contains what was delivered before. Forget that
 * baseline: the next delivery starts from the branch as it is now. Turning delivery back on is a
 * separate choice.
 */
export function resetDeliveryBaseline(state: State, now: string): State {
  if (state.project.prDelivery.enabled) throw new ControlError("Pull-request delivery is on; the baseline belongs to local branch delivery.");
  const s = draft(state);
  s.project.delivery = { pending: true };
  event(s, now, "user", "config", `Delivery baseline reset: the next delivery to ${s.project.autonomy.autoDeliver.branch} starts from the branch as it is now`);
  return s;
}

/**
 * The autopilot preset: planning on, no holds, one automatic retry, automatic delivery to the given
 * branch. It never turns on publishing or automatic merging: while pull-request delivery is on, the
 * delivery mode and its settings are left exactly as they are.
 */
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
      autoDeliver: state.project.prDelivery.enabled ? { ...a.autoDeliver, enabled: false } : { enabled: true, branch },
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
  change: { summary: string; openFindings?: number; ref?: string; items?: unknown[]; reason: string },
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
  if (change.items !== undefined && (base.kind !== "breakdown" || !Array.isArray(change.items) || change.items.length > 50)) throw new ControlError("Items can be edited only on breakdowns (at most 50).");
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
    ...(base.kind === "breakdown" ? { items: structuredClone(change.items ?? base.items ?? []) } : {}),
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
  if (base.kind === "breakdown" && st.state === "done") {
    // Child tasks follow the edited breakdown: now, or when the task resumes if it is paused.
    const pb = { stepId: st.id, output: base.name };
    const already = (t.pendingBreakdowns ?? []).some((x) => x.stepId === pb.stepId && x.output === pb.output);
    if (t.hold) {
      if (!already) t.pendingBreakdowns = [...(t.pendingBreakdowns ?? []), pb];
    } else if (!already) applyBreakdown(s, t, st.id, base.name, now);
  }
  return s;
}

// ---------- fan-out: parallel copies, iteration, breakdowns into child tasks ----------

const baseId = (id: string) => id.replace(/-(c\d+|i\d+)$/, "");
const uniqueRefs = (refs: InputRef[]) => refs.filter((r, i) => refs.findIndex((x) => x.step === r.step && x.output === r.output) === i);

function steplist(t: Task): StepDef[] {
  return t.steps.map(toDef);
}

function recordRevision(s: State, t: Task, reason: string, now: string) {
  t.pipelineRev += 1;
  t.pipelineHistory.push({ rev: t.pipelineRev, at: now, author: "lead", reason, steps: steplist(t) });
  event(s, now, "lead", "pipeline", `Pipeline r${t.pipelineRev}: ${reason}`, t.id);
}

/** Replace a parallel step by its copies: siblings with the same inputs; readers of it read all copies. */
function expandParallel(s: State, t: Task, st: Step, now: string) {
  const p = st.parallel!;
  const ids = [st.id, ...Array.from({ length: p.count - 1 }, (_, i) => `${st.id}-c${i + 2}`)];
  if (ids.some((id, i) => i > 0 && t.steps.some((x) => x.id === id))) return; // already expanded
  const at = t.steps.indexOf(st);
  const assign = (i: number): ModelSelection | null => {
    const pv = p.providers?.length ? p.providers[i % p.providers.length] : undefined;
    if (!pv || st.selection?.provider === pv) return st.selection;
    return { provider: pv, model: "auto" };
  };
  st.copyOf = st.id;
  if (p.providers?.length && !st.selection) st.selection = assign(0);
  const copies: Step[] = ids.slice(1).map((id, i) => ({
    ...structuredClone(st),
    id,
    purpose: `${st.purpose} (copy ${i + 2} of ${p.count})`,
    selection: assign(i + 1),
    revision: 1,
    state: t.hold ? "paused" : "pending",
    parallel: undefined,
    copyOf: st.id,
  }));
  for (const c of copies) delete c.parallel;
  t.steps.splice(at + 1, 0, ...copies);
  // Everything that depended on or read the original now depends on / reads every copy.
  for (const d of t.steps) {
    if (ids.includes(d.id)) continue;
    if (d.dependsOn.includes(st.id)) d.dependsOn = [...new Set([...d.dependsOn, ...ids.slice(1)])];
    const addCopies = (refs: InputRef[] | undefined) =>
      refs?.flatMap((r) => (r.step === st.id ? [r, ...ids.slice(1).map((id) => ({ step: id, output: r.output }))] : [r]));
    d.inputs = addCopies(d.inputs)!;
    if (d.runIf) d.runIf = addCopies(d.runIf);
  }
  recordRevision(s, t, `${st.id} runs as ${p.count} parallel ${p.mode === "best-of" ? "candidates (best of)" : "copies"}`, now);
}

/** The first later step that reads a best-of group: it makes the choice. */
function chooserOf(t: Task, group: string): string | undefined {
  const members = new Set(t.steps.filter((x) => x.copyOf === group).map((x) => x.id));
  return t.steps.find((x) => !members.has(x.id) && x.inputs.some((r) => members.has(r.step)))?.id;
}

/**
 * A best-of choice changed: every step that received the old choice (each reader of the group other
 * than the comparing step, and everything after those readers or after the comparison) is
 * revalidated, and runs among them are stopped.
 */
function revalidateChoice(s: State, t: Task, group: string, pick: string, now: string): string[] {
  const chooser = chooserOf(t, group);
  const members = new Set(t.steps.filter((x) => x.copyOf === group).map((x) => x.id));
  const after = new Set(t.steps.filter((d) => d.id !== chooser && !members.has(d.id) && d.inputs.some((r) => members.has(r.step))).map((d) => d.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of t.steps) {
      if (after.has(d.id) || d.id === chooser || members.has(d.id)) continue;
      if ((chooser && d.dependsOn.includes(chooser)) || d.dependsOn.some((x) => after.has(x))) {
        after.add(d.id);
        grew = true;
      }
    }
  }
  const redo: string[] = [];
  for (const d of t.steps) {
    if (!after.has(d.id) || !isSettled(d)) continue;
    d.state = t.hold ? "paused" : "pending";
    d.invalidatedBy = `choice changed to ${pick}`;
    redo.push(d.id);
  }
  for (const a of activeAttempts(s, t.id)) {
    if (!after.has(a.stepId)) continue;
    const d = findStep(t, a.stepId);
    if (d) d.revision += 1;
    requestStop(s, a, "revision", now);
    redo.push(a.stepId);
  }
  return redo;
}

/** A person's choice stands until that candidate produces a new run result (their own edits do not count). */
function userChoiceStands(s: State, t: Task, group: string): boolean {
  const at = t.bestOfByUser?.[group];
  const pick = t.bestOf?.[group];
  if (!at || !pick || findStep(t, pick)?.state !== "done") return false;
  return !s.artifacts.some((a) => a.taskId === t.id && a.stepId === pick && a.author !== "user" && a.createdAt > at);
}

/**
 * Record the comparing step's choice. Every completion of the comparing step decides again (a re-run
 * may choose differently), except where a person's choice still stands.
 */
function recordBestOfChoice(s: State, t: Task, st: Step, chosen: string | undefined, now: string) {
  for (const g of new Set(t.steps.filter((x) => x.copyOf).map((x) => x.copyOf!))) {
    const leader = findStep(t, g);
    if (leader?.parallel?.mode !== "best-of" || chooserOf(t, g) !== st.id) continue;
    const members = t.steps.filter((x) => x.copyOf === g && x.state === "done").map((x) => x.id);
    if (userChoiceStands(s, t, g)) {
      if (chosen && chosen !== t.bestOf![g]) event(s, now, "lead", "decision", `${st.id} preferred ${chosen}; keeping your choice of ${t.bestOf![g]}`, t.id);
      continue;
    }
    if (t.bestOfByUser?.[g]) {
      const { [g]: _, ...rest } = t.bestOfByUser;
      t.bestOfByUser = rest;
    }
    const pick = chosen && members.includes(chosen) ? chosen : members[0];
    if (!pick) continue;
    const previous = t.bestOf?.[g];
    t.bestOf = { ...(t.bestOf ?? {}), [g]: pick };
    const why = chosen && chosen !== pick ? ` (reported "${chosen}", not a candidate)` : chosen ? "" : " (no choice reported; took the first)";
    const redo = previous && previous !== pick ? revalidateChoice(s, t, g, pick, now) : [];
    event(s, now, "lead", "decision", `${st.id} chose ${pick} among ${members.join(", ")}${why}${previous && previous !== pick ? `; was ${previous}` : ""}${redo.length ? `; re-running ${redo.join(", ")}` : ""}`, t.id);
  }
}

/**
 * Append the next iteration of a loop body (the steps from `iterate.from` to `st`). New steps depend
 * on the previous iteration; inputs that came from outside the body are re-pointed to the previous
 * iteration's newest output of the same kind (for example the repaired change instead of the first
 * one). Steps after the loop also wait for, and read, the new iteration.
 */
function expandIteration(s: State, t: Task, st: Step, now: string) {
  const it = st.iterate!;
  const n = (st.iteration ?? 1) + 1;
  if (n > it.max) return;
  const from = t.steps.findIndex((x) => x.id === it.from);
  const to = t.steps.indexOf(st);
  if (from < 0 || from > to) return;
  const body = t.steps.slice(from, to + 1);
  const idMap = new Map(body.map((b) => [b.id, `${baseId(b.id)}-i${n}`]));
  if ([...idMap.values()].some((id) => t.steps.some((x) => x.id === id))) return;
  // Newest producer in the finished iteration for each artifact kind.
  const producerOfKind = new Map<string, InputRef>();
  for (const b of body) for (const o of b.outputs) producerOfKind.set(o.kind, { step: b.id, output: o.name });
  const kindOf = (r: InputRef) => findStep(t, r.step)?.outputs.find((o) => o.name === r.output)?.kind;
  const remap = (r: InputRef): InputRef => {
    if (idMap.has(r.step)) return { step: idMap.get(r.step)!, output: r.output };
    const k = kindOf(r);
    return (k && producerOfKind.get(k)) || r;
  };
  const copies: Step[] = body.map((b, i) => {
    const c: Step = {
      ...structuredClone(b),
      id: idMap.get(b.id)!,
      purpose: `${b.purpose.replace(/ \(iteration \d+\)$/, "")} (iteration ${n})`,
      revision: 1,
      state: t.hold ? "paused" : "pending",
      iteration: n,
      // Inside the body keep the structure; anything that depended on work before the loop now
      // depends on the previous iteration's end, so it reads the newest outputs.
      dependsOn: i === 0 ? [st.id] : [...new Set(b.dependsOn.map((d) => idMap.get(d) ?? st.id))],
      inputs: uniqueRefs(b.inputs.map(remap)),
      runIf: b.runIf && uniqueRefs(b.runIf.map(remap)),
      invalidatedBy: undefined,
      blockedReason: undefined,
      autoRetries: 0,
    };
    if (!c.runIf) delete c.runIf;
    delete c.parallel; // copies of copies are already explicit steps
    if (b === st) c.iterate = { from: idMap.get(it.from)!, max: it.max };
    else delete c.iterate;
    return c;
  });
  const before = structuredClone(t.steps);
  delete st.iterate; // the loop continues from the new last step
  t.steps.splice(to + 1, 0, ...copies);
  const last = copies[copies.length - 1].id;
  for (const d of t.steps) {
    if (idMap.has(d.id) || copies.some((c) => c.id === d.id)) continue;
    if (d.dependsOn.includes(st.id)) d.dependsOn = [...new Set([...d.dependsOn, last])];
    const extra = d.inputs.filter((r) => idMap.has(r.step)).map((r) => ({ step: idMap.get(r.step)!, output: r.output }));
    if (extra.length) d.inputs = [...d.inputs, ...extra];
  }
  const issues = validatePipeline(steplist(t)).filter((i) => i.severity === "error");
  if (issues.length) {
    // Never leave an invalid pipeline behind: restore it exactly and record why.
    t.steps = before;
    event(s, now, "system", "blocked", `Could not add iteration ${n}: ${issues[0].message}`, t.id);
    return;
  }
  recordRevision(s, t, `Iteration ${n} of ${body.map((b) => b.id).join(" → ")}`, now);
}

export function childTasks(s: State, t: Task): Task[] {
  return s.tasks.filter((x) => x.parentTaskId === t.id);
}

/** Children are settled when none is open and, with pull-request delivery, their work is in the base. */
export function childrenSettled(s: State, t: Task): boolean {
  return childTasks(s, t).every((c) => !isOpen(c) && (c.lifecycle === "cancelled" || prerequisiteReady(s, c)));
}

/** Every task created, directly or through its children, by breakdowns of `t`. */
export function descendants(s: State, t: Task): Task[] {
  const out: Task[] = [];
  const seen = new Set([t.id]);
  const stack = [t.id];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of s.tasks) {
      if (c.parentTaskId !== id || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      stack.push(c.id);
    }
  }
  return out;
}

function depth(s: State, t: Task): number {
  let d = 0;
  let cur: Task | undefined = t;
  while (cur?.parentTaskId && d < 10) {
    d++;
    cur = s.tasks.find((x) => x.id === cur!.parentTaskId);
  }
  return d;
}

function rootOf(s: State, t: Task): Task {
  let cur = t;
  for (let i = 0; cur.parentTaskId && i < 10; i++) {
    const p = s.tasks.find((x) => x.id === cur.parentTaskId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/** At most this many child tasks (all levels, not counting cancelled ones) come from one task you created. */
export const MAX_CHILD_TASKS = 100;
export const MAX_ITEMS_PER_BREAKDOWN = 20;

/** Readers of a best-of group other than the comparing step wait until a candidate is chosen. */
function awaitingChoice(s: State, t: Task, st: Step): boolean {
  for (const r of st.inputs) {
    const g = findStep(t, r.step)?.copyOf;
    if (!g || findStep(t, g)?.parallel?.mode !== "best-of") continue;
    const chooser = chooserOf(t, g);
    if (st.copyOf === g || chooser === st.id) continue;
    // Wait for a choice, and while the comparing step re-runs, for its new one (a person's choice stands).
    if (!t.bestOf?.[g]) return true;
    if (!userChoiceStands(s, t, g) && findStep(t, chooser ?? "")?.state !== "done") return true;
  }
  return false;
}

/** Create (or reconcile) the child tasks of a breakdown output, then continue its loop if it has one. */
function applyBreakdown(s: State, t: Task, stepId: string, output: string, now: string) {
  const st = findStep(t, stepId);
  const art = st && acceptedOutput(s, t, stepId, output);
  if (!st || !art) return;
  const linked = createChildren(s, t, st, art.items ?? [], now, art.id);
  if (st.iterate && linked > 0) expandIteration(s, t, st, now);
}

const hasBreakdown = (steps: StepDef[]) => steps.some((x) => x.outputs.some((o) => o.kind === "breakdown"));

/**
 * Turn breakdown items into child tasks of `t`. Items use the lead-proposal shape; `approach` alone is
 * enough (the options become "as planned" vs deferring). Items may depend on earlier items by index
 * (0-based) or title. Children follow the same autonomy holds as lead proposals.
 *
 * A newer version of the same step's breakdown (a re-run or an edit) reconciles instead of adding a
 * second batch: children whose title is still listed are kept, unstarted ones that are no longer
 * listed are cancelled, and started ones are kept and reported. Returns how many children the
 * breakdown now has.
 */
function createChildren(s: State, t: Task, st: Step, items: unknown[], now: string, artifactId: string): number {
  if (depth(s, t) >= 2) {
    event(s, now, "system", "blocked", `${st.id}: breakdowns are limited to two levels; no child tasks were created`, t.id);
    return 0;
  }
  const a = s.project.autonomy;
  const holdBeforeStart = !a.enabled || a.holdLeadProposals;
  const root = rootOf(s, t);
  const earlier = childTasks(s, t).filter((c) => c.parentStepId === st.id && c.parentArtifactId !== artifactId && c.lifecycle !== "cancelled");
  const started = (c: Task) => c.lifecycle === "active" || c.lifecycle === "done" || s.attempts.some((x) => x.taskId === c.id);
  const titleOf = (c: Task) => currentSpec(c).content.title.trim().toLowerCase();
  const linked: { id: string; title: string; kept?: boolean }[] = [];
  const rejected: string[] = [];
  const resolveDeps = (raw: unknown) =>
    (Array.isArray(raw) ? raw : [])
      .map((d) => (typeof d === "number" ? linked[d]?.id : linked.find((c) => c.title.toLowerCase() === String(d).toLowerCase())?.id))
      .filter((x): x is string => !!x);
  for (const [i, raw] of items.slice(0, MAX_ITEMS_PER_BREAKDOWN).entries()) {
    try {
      const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const title = typeof it.title === "string" ? it.title.trim() : "";
      const same = title && earlier.find((c) => titleOf(c) === title.toLowerCase() && !linked.some((l) => l.id === c.id));
      if (same) {
        same.parentArtifactId = artifactId;
        if (!started(same)) same.dependsOn = resolveDeps(it.dependsOn);
        linked.push({ id: same.id, title: currentSpec(same).content.title, kept: true });
        continue;
      }
      const approach = typeof it.approach === "string" ? it.approach : "";
      const p = {
        ...it,
        options: Array.isArray(it.options)
          ? it.options
          : [
              { id: "A", name: "As planned", approach, benefit: "", effort: "", risks: "", reversibility: "" },
              { id: "B", name: "Defer", approach: "Do not do this now", benefit: "", effort: "", risks: "", reversibility: "" },
            ],
        recommendedOptionId: typeof it.recommendedOptionId === "string" ? it.recommendedOptionId : "A",
        rationale: typeof it.rationale === "string" && it.rationale.trim() ? it.rationale : `Part of ${t.id}'s breakdown (${st.id}).`,
        templateId: typeof it.templateId === "string" ? it.templateId : "change",
        priority: typeof it.priority === "number" ? it.priority : t.priority,
      } as unknown as LeadProposal;
      const why = validateProposal(s, p);
      if (why) {
        rejected.push(`#${i + 1}: ${why}`);
        continue;
      }
      const tpl = s.project.templates.find((x) => x.id === p.templateId)!;
      if (hasBreakdown(tpl.steps)) {
        rejected.push(`#${i + 1}: child tasks cannot break down further (template "${tpl.name}"); use a template without breakdown steps`);
        continue;
      }
      if (descendants(s, root).filter((x) => x.lifecycle !== "cancelled").length >= MAX_CHILD_TASKS) {
        rejected.push(`#${i + 1}: ${root.id} already has ${MAX_CHILD_TASKS} child tasks, the limit per task`);
        continue;
      }
      let k = childTasks(s, t).length + 1;
      while (s.tasks.some((x) => x.id === `${t.id}.${k}`)) k++;
      const id = proposeTask(s, p, now, holdBeforeStart, `${t.id}.${k}`);
      const child = getTask(s, id);
      child.parentTaskId = t.id;
      child.parentStepId = st.id;
      child.parentArtifactId = artifactId;
      if (t.hold) {
        child.hold = true;
        child.pausedWith = t.pausedWith ?? t.id;
      }
      child.dependsOn = resolveDeps(it.dependsOn);
      linked.push({ id, title: String(p.title) });
    } catch (err) {
      rejected.push(`#${i + 1}: invalid (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (items.length > MAX_ITEMS_PER_BREAKDOWN) rejected.push(`${items.length - MAX_ITEMS_PER_BREAKDOWN} item(s) beyond the limit of ${MAX_ITEMS_PER_BREAKDOWN} per breakdown`);
  // Children of an earlier version that the new version no longer lists.
  const dropped = earlier.filter((c) => !linked.some((l) => l.id === c.id));
  const cancelled: string[] = [];
  const keptStarted: string[] = [];
  for (const c of dropped) {
    if (started(c)) {
      keptStarted.push(c.id);
      continue;
    }
    c.lifecycle = "cancelled";
    touch(c, now);
    cancelled.push(c.id);
    event(s, now, "lead", "control", `Cancelled: no longer in ${t.id}'s breakdown (${st.id})`, c.id);
  }
  const fresh = linked.filter((l) => !l.kept).map((l) => l.id);
  const kept = linked.filter((l) => l.kept).map((l) => l.id);
  const parts = [
    `${st.id} broke the work into ${linked.length} child task(s)${fresh.length ? `; new: ${fresh.join(", ")}` : ""}`,
    kept.length && `kept ${kept.join(", ")}`,
    cancelled.length && `cancelled ${cancelled.join(", ")} (no longer listed)`,
    keptStarted.length && `${keptStarted.join(", ")} already started and no longer listed; cancel them if they are not needed`,
    holdBeforeStart && fresh.length && "new ones wait for you to start them (autonomy settings)",
    rejected.length && `rejected ${rejected.join("; ")}`,
  ].filter(Boolean);
  event(s, now, "lead", "spec", parts.join("; "), t.id);
  return linked.length;
}

/**
 * A person picks (or changes) the best-of candidate. If the comparing step already used an earlier
 * choice, everything after it is revalidated so later steps work from the new choice.
 */
export function chooseCandidate(state: State, taskId: string, group: string, stepId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Choosing a candidate");
  const leader = findStep(t, group);
  if (leader?.parallel?.mode !== "best-of") throw new ControlError(`${group} is not a best-of step.`);
  const member = findStep(t, stepId);
  if (member?.copyOf !== group) throw new ControlError(`${stepId} is not a candidate of ${group}.`);
  if (member.state !== "done") throw new ControlError(`${stepId} has not finished; choose a finished candidate.`);
  const previous = t.bestOf?.[group];
  t.bestOfByUser = { ...(t.bestOfByUser ?? {}), [group]: now };
  if (previous === stepId) {
    touch(t, now);
    event(s, now, "user", "decision", `Confirmed ${stepId} for ${group}`, t.id);
    return s;
  }
  t.bestOf = { ...(t.bestOf ?? {}), [group]: stepId };
  if (previous) revalidateChoice(s, t, group, stepId, now);
  touch(t, now);
  event(s, now, "user", "decision", `Chose ${stepId} for ${group}${previous ? ` (was ${previous})` : ""}`, t.id);
  return s;
}
