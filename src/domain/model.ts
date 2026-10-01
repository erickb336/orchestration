// State transitions for tasks, specs, steps, and runs.
// Every operation is pure: it returns a new State and never mutates its input.
// Operations are applied one at a time, which serializes races such as
// pause-vs-completion: whichever is applied first determines the outcome.

import * as C from "./checks";
import { coverageOf as pathCoverageOf, gapText, notRequired } from "./coverage";
import { prBaseRef, recordLanded, undeliveredTasks } from "./delivery";
import * as F from "./findings";
import { isInternalPatternId } from "./internalPatterns";
import { childDefault, customRef, effectiveDefault, eligible, eligibleIds, findPattern, patternRef, servicePattern } from "./patterns";
import { downstreamOf, instantiate, structuralKey, toDef, validatePipeline } from "./pipeline";
import {
  type ActivityEvent,
  type Actor,
  type Artifact,
  type Attempt,
  type CatalogModel,
  type ChangeAuthor,
  type CheckRunRecord,
  type Deferral,
  type PrDelivery,
  type RunLimits,
  type Autonomy,
  type Integration,
  type LeadRun,
  type LeadTrigger,
  type Message,
  type SpecOption,
  type SteerAction,
  type SteeringChange,
  type SteeringChangeSet,
  type SteeringMode,
  type VisionRevision,
  type WorkerEnvironment,
  type InputRef,
  type ConsumedInput,
  type EventKind,
  type ModelSelection,
  type Coverage,
  type CoverageState,
  type Finding,
  type LeadQuestion,
  type ProjectStage,
  type ShapingArea,
  type ProviderId,
  type RoleId,
  type Runner,
  type SelectionSource,
  type SpecContent,
  type State,
  type Step,
  type StepDef,
  type Task,
  type VisionDoc,
  type VisionDraft,
  type ChosenBy,
  type Pattern,
  type PatternCatalog,
  type PatternRef,
  ControlError,
  COVERAGE_STATES,
  REVIEW_ROLES,
  SHAPING_AREAS,
  autoModelDefaults,
  AUTOPILOT,
  DEFAULT_CHECKS,
  DEFAULT_PR_DELIVERY,
  isProvider,
  StaleWriteError,
} from "./types";

// ---------- helpers ----------

function draft(state: State): State {
  return structuredClone(state);
}

/** The next generated id for a draft state (mutates `s.seq`). Shared with the findings module (ORC-013). */
export function nextId(s: State, prefix: string): string {
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

/** Record an activity event on a draft state. Shared with the findings module (ORC-013). */
export function event(s: State, now: string, actor: Actor, kind: EventKind, message: string, taskId?: string) {
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

/** ORC-013: active runs of agents (a provider's worker). Service runs (checks) count against their own limit. */
export function activeAgentAttempts(s: State) {
  return s.attempts.filter((a) => isActive(a) && isProvider(a.snapshot.provider));
}

/** ORC-013: active check runs (run by the service), bounded by `checks.maxConcurrent`. */
export function activeServiceAttempts(s: State) {
  return s.attempts.filter((a) => isActive(a) && a.snapshot.provider === "service");
}

/**
 * ORC-013 §6.10: the check settings changed, so every active check run is stopped for revision and its
 * step's revision bumped, so a late result is discarded and the step runs again with the new settings.
 * Mutates the draft; returns how many runs were asked to stop.
 */
export function stopServiceRuns(s: State, now: string): number {
  let n = 0;
  for (const a of activeServiceAttempts(s)) {
    if (a.outcome !== "running") continue;
    const t = getTask(s, a.taskId);
    const st = findStep(t, a.stepId);
    if (st) st.revision += 1;
    requestStop(s, a, "revision", now);
    n++;
  }
  return n;
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
  // Review finding 4: a finished task's deferral is spent; its children must not inherit it.
  t.deferral = undefined;
}

function touch(t: Task, now: string) {
  t.updatedAt = now;
}

// ---------- model resolution ----------

export type Resolution =
  | { ok: true; selection: ModelSelection; source: SelectionSource; reason: string }
  | { ok: false; reason: string };

/** The commit a code-change artifact names ("<sha> on <branch>", or the hash a person typed). */
const commitOf = (a: Artifact) => a.ref?.trim().split(" ")[0] ?? "";
const sameCommit = (a: Artifact, b: Artifact) => {
  const [x, y] = [commitOf(a).toLowerCase(), commitOf(b).toLowerCase()];
  return x === y || (x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x)));
};

/**
 * Who wrote the commit a code-change artifact names. A version a person edited is theirs only when the
 * edit supplied another commit; an edit of the summary alone leaves the commit with the run that made
 * it. A run that is not on record is "unknown", never "user": nothing is assumed about it.
 */
export function artifactAuthor(s: State, art: Artifact): ChangeAuthor {
  let made = art;
  if (art.author === "user") {
    const run = s.artifacts
      .filter((a) => a.taskId === art.taskId && a.stepId === art.stepId && a.name === art.name && a.version < art.version && a.author !== "user")
      .sort((a, b) => a.version - b.version)
      .pop();
    if (!run) return commitOf(art) ? "user" : "unknown";
    if (!sameCommit(run, art)) return "user";
    made = run;
  }
  const p = s.attempts.find((a) => a.id === made.attemptId)?.snapshot.provider;
  return p && isProvider(p) ? p : "unknown";
}

/** Everyone who authored a change a pull request holds. Records from before the set was kept name only the newest author. */
export const prAuthors = (pr: PrDelivery): ChangeAuthor[] => (pr.changeAuthors?.length ? pr.changeAuthors : [pr.changeAuthor]);

/** The providers whose review counts as independent of these authors: none of them wrote any of it. Empty when an author is unknown. */
export function independentProviders(authors: ChangeAuthor[]): ProviderId[] {
  if (authors.includes("unknown")) return [];
  return (["claude", "codex"] as ProviderId[]).filter((p) => !authors.includes(p));
}

/** "Claude", "Claude and Codex", "you and Codex", "an unknown author". */
export function authorsLabel(authors: ChangeAuthor[]): string {
  const names = [...new Set(authors)].map((a) => (a === "user" ? "you" : a === "unknown" ? "an unknown author" : providerLabel(a)));
  return names.length <= 1 ? (names[0] ?? "an unknown author") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The provider that wrote the change a step reviews: the pull request's newest change for a dedicated
 * review task, else the newest code change among the step's inputs. "user" when a person supplied it.
 */
export function writerOf(s: State, t: Task, st: StepDef): ChangeAuthor | undefined {
  if (t.reviewTarget) {
    const pr = s.tasks.find((x) => x.id === t.reviewTarget!.taskId)?.integration?.pr;
    return pr && pr.n === t.reviewTarget.n ? pr.changeAuthor : undefined;
  }
  let best: Artifact | undefined;
  for (const i of consumedInputs(s, t, st)) {
    const art = s.artifacts.find((x) => x.id === i.artifactId);
    if (art?.kind === "code-change" && (!best || art.createdAt > best.createdAt)) best = art;
  }
  return best ? artifactAuthor(s, best) : undefined;
}

/**
 * Everyone a step's review must be independent of. For a dedicated review task that is every author of
 * the pull request (the task's own coder runs and every fix pushed onto it), not only the newest.
 */
export function writersOf(s: State, t: Task, st: StepDef): ChangeAuthor[] {
  if (t.reviewTarget) {
    const pr = s.tasks.find((x) => x.id === t.reviewTarget!.taskId)?.integration?.pr;
    return pr && pr.n === t.reviewTarget.n ? prAuthors(pr) : [];
  }
  const w = writerOf(s, t, st);
  return w ? [w] : [];
}

/**
 * Resolution order: step pin → task role override → independence → project role default → project
 * default. Independence applies to a step marked `independentOf: "writer"` while the project asks for
 * a reviewer from another provider: when the default would be one of the writers' own providers, a
 * provider that wrote none of the change is chosen, and when that one is not enabled, or none exists,
 * the step does not resolve. Nothing is ever substituted, no provider reviews its own work, and a pin
 * or override the user set always wins (the merge gate then reports a review that is not independent).
 */
export function resolveStep(s: State, t: Task, st: Step): Resolution {
  const p = s.project;
  // ORC-013: a Checks step is run by the service, never by a provider; dispatch never asks for it.
  if (st.role === "checks") return { ok: false, reason: "run by the service" };
  let selection: ModelSelection;
  let source: SelectionSource;
  let independence: string | undefined;
  const fallback = (): [ModelSelection, SelectionSource] => (p.roleDefaults[st.role] ? [p.roleDefaults[st.role]!, "project-role"] : [p.defaultSelection, "project-default"]);
  if (st.selection) [selection, source] = [st.selection, "step"];
  else if (t.roleOverrides[st.role]) [selection, source] = [t.roleOverrides[st.role]!, "task-role"];
  else {
    [selection, source] = fallback();
    // A person's own commit constrains nobody: any agent is independent of it.
    const writers = (st.independentOf === "writer" && p.prDelivery.reviewer === "other-provider" ? writersOf(s, t, st) : []).filter((w) => w !== "user");
    if (writers.includes("unknown") || writers.includes(selection.provider)) {
      const free = independentProviders(writers);
      if (free.length === 0) {
        const why = writers.includes("unknown") ? "who wrote this change is not on record" : `${authorsLabel(writers)} each wrote part of this change`;
        return { ok: false, reason: `No agent's review would be independent: ${why}, and no provider reviews its own work. Merge it yourself, or let any agent count as the reviewer (Settings → Delivery). Nothing was substituted.` };
      }
      const other = free[0];
      if (!p.enabledProviders.includes(other)) {
        return { ok: false, reason: `Independent review needs ${providerLabel(other)}, which is not enabled. Enable it in Settings, or let any agent count as the reviewer (Settings → Delivery). Nothing was substituted.` };
      }
      [selection, source] = [{ provider: other, model: "auto" }, "independence"];
      independence = `${providerLabel(other)}: other provider than the writer (${authorsLabel(writers)})`;
    }
  }

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
      reason: independence ?? `Auto: ${catalog[0].id}, the first model in the ${providerLabel(selection.provider)} catalog`,
    };
  }
  if (!catalog.some((m) => m.id === selection.model)) {
    return { ok: false, reason: `Model ${selection.model} is not in the ${providerLabel(selection.provider)} catalog.` };
  }
  return { ok: true, selection, source, reason: sourceLabel(source) };
}

export function providerLabel(p: Runner) {
  return p === "claude" ? "Claude" : p === "codex" ? "Codex" : "Service";
}

export function sourceLabel(src: SelectionSource) {
  switch (src) {
    case "service":
      return "Run by the service";
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

export type Column = "proposed" | "ready" | "running" | "reviewing" | "paused" | "deferred" | "blocked" | "done" | "cancelled";
export const BOARD_COLUMNS: Column[] = ["proposed", "ready", "running", "reviewing", "paused", "deferred", "blocked", "done"];

/**
 * ORC-009: the deferral that applies to a task: its own, or the nearest ancestor's (walking at most
 * 10 levels). Children are never written, so a root and all its children defer together and one Undo
 * touches one field.
 */
export function deferredBy(s: State, t: Task): { task: Task; deferral: Deferral } | undefined {
  let cur: Task | undefined = t;
  for (let i = 0; cur && i <= 10; i++) {
    // Review finding 4: a done or cancelled ancestor's deferral no longer applies, so a deferred root
    // that finishes does not strand its open children (finishTask clears the deferral as well).
    if (cur.deferral && isOpen(cur)) return { task: cur, deferral: cur.deferral };
    if (!cur.parentTaskId) return undefined;
    cur = s.tasks.find((x) => x.id === cur!.parentTaskId);
  }
  return undefined;
}

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
  // ORC-009: deferred work is idle by design, never "Paused" (a pause is something the runtime confirmed).
  if (deferredBy(s, t)) return "deferred";
  if (t.lifecycle === "proposed") return "proposed";
  // Started but idle: paused by the project hold, otherwise queued for its next step.
  if (t.lifecycle === "active" && s.project.hold) return "paused";
  return "ready";
}

/** "Deferred by lead", "Deferred by you", or "Deferred with T-4" when the deferral comes from an ancestor. */
export function deferredLabel(s: State, t: Task): string | undefined {
  const d = deferredBy(s, t);
  if (!d) return undefined;
  if (d.task.id !== t.id) return `Deferred with ${d.task.id}`;
  return d.deferral.by === "lead" ? "Deferred by lead" : "Deferred by you";
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
  // ORC-009: a deferred task keeps working until its current step ends; then nothing new starts.
  if ((col === "running" || col === "reviewing") && deferredBy(s, t)) return `${col === "running" ? "Running" : "Reviewing"} · deferred after this step`;
  if (col === "deferred") return deferredLabel(s, t)!;
  if (t.lifecycle === "active" && active.length === 0 && waitingForChildren(s, t)) {
    const open = childTasks(s, t).filter(isOpen).length;
    if (open === 0) return "Waiting for child pull requests to merge";
    return `Waiting for ${open} child task${open === 1 ? "" : "s"}`;
  }
  // ORC-013: a repair that would read undecided findings waits for the decision; nothing is blocked.
  const awaiting = t.lifecycle === "active" && active.length === 0 ? F.awaitingDecision(s, t) : undefined;
  if (awaiting) return F.awaitingLabel(awaiting);
  // ORC-013 §6.5.4: a Checks step that would start next waits while the sandbox is not ready; nothing runs unsandboxed by itself.
  if (t.lifecycle === "active" && active.length === 0 && C.checksHeld(s) && t.steps.some((st) => st.state === "pending" && st.role === "checks" && st.dependsOn.every((d) => isSettled(getStep(t, d))))) return C.HELD_LABEL;
  // ORC-012: while shaping, a step that would start next waits for Start building; nothing is paused.
  if (t.lifecycle === "active" && active.length === 0) return s.project.stage === "shaping" ? "Next step waits (shaping)" : "Queued for next step";
  if (col === "proposed" && waitingOn(s, t)) return waitingLabel(s, t);
  // ORC-012 review 2: the roadmap's own hold is named as such; the user's hold before start stays its own label.
  // ORC-014 review 11: what follows Start building is decided by the involvement setting at that moment,
  // so the label reads it now; a dependency wait is shown under the shaping hold too.
  if (col === "ready" && t.heldForShaping) {
    const dep = waitingOn(s, t);
    return `Planned; waits until you start building${dep ? ` and on ${dep}` : ""}, then ${startBuildingPlan(s).release ? "starts on Autopilot" : "waits for your release (your involvement setting)"}`;
  }
  if (col === "ready" && t.holdBeforeStart) return "Held before start";
  if (col === "ready" && s.project.hold) return "Ready (project paused)";
  // ORC-012 review 13: a dependency wait is shown before the stage, with shaping noted.
  if (col === "ready" && waitingOn(s, t)) return waitingLabel(s, t);
  if (col === "ready" && s.project.stage === "shaping") return "Ready (shaping)";
  return col[0].toUpperCase() + col.slice(1);
}

/** "Waiting on T-x", or "Waiting on T-x (deferred)" when the prerequisite itself is deferred; "(shaping)" while nothing would start anyway. */
function waitingLabel(s: State, t: Task): string {
  const dep = waitingOn(s, t)!;
  const d = s.tasks.find((x) => x.id === dep);
  return `Waiting on ${dep}${d && deferredBy(s, d) ? " (deferred)" : ""}${s.project.stage === "shaping" ? " (shaping)" : ""}`;
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
  /** The pipeline to run. Default: the origin's current pattern from the catalog, else a copy of its pipeline before any expansion. */
  steps?: StepDef[];
  /** ORC-016: the provenance of `steps` when the service supplies them. Default: a custom pipeline. */
  pattern?: PatternRef;
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
  // ORC-016: the origin's pattern is re-applied from the current catalog when it is still there (so a
  // follow-up takes up an updated pattern); legacy, custom and internal pipelines are copied as they were.
  let defs: StepDef[];
  let pattern: PatternRef;
  let reason: string;
  if (opts.steps) {
    defs = structuredClone(opts.steps).map(toDef);
    pattern = opts.pattern ? structuredClone(opts.pattern) : customRef("follow-up");
    reason = `Follow-up to ${t.id}`;
  } else {
    const current = t.pattern.source === "built-in" || t.pattern.source === "local" ? findPattern(state, t.pattern.id) : undefined;
    if (current) {
      defs = structuredClone(current.steps).map(toDef);
      pattern = patternRef(current, "follow-up");
      reason = `Created from the ${current.name} pattern (follow-up to ${t.id})`;
    } else {
      defs = unexpandedSteps(t).map(toDef);
      pattern = { ...structuredClone(t.pattern), chosenBy: "follow-up" };
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
    pipelineHistory: [{ rev: 1, at: now, author, reason, steps: defs, pattern }],
    pattern,
    patternSince: 1,
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

/** ORC-012 review 2: any hold change the user makes on a roadmap task takes the task out of the shaping hold; the user's choice then stands. */
function takeOverShapingHold(s: State, t: Task, now: string) {
  if (!t.heldForShaping) return;
  delete t.heldForShaping;
  event(s, now, "user", "control", "No longer held by the roadmap: your hold setting decides when it starts", t.id);
}

export function startHeldTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Starting");
  takeOverShapingHold(s, t, now);
  t.holdBeforeStart = false;
  touch(t, now);
  event(s, now, "user", "control", `Hold-before-start released; eligible for dispatch${s.project.stage === "shaping" ? " once you start building" : ""}`, t.id);
  return s;
}

export function setHoldBeforeStart(state: State, taskId: string, value: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Changing hold");
  takeOverShapingHold(s, t, now);
  t.holdBeforeStart = value;
  touch(t, now);
  event(s, now, "user", "control", value ? "Hold before start enabled" : "Hold before start removed", t.id);
  return s;
}

/** Cancel a task. `by`: the service cancels its own review and fix tasks when their pull request moves on. */
export function cancelTask(state: State, taskId: string, now: string, by?: { actor: Actor; reason: string }): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Cancelling");
  cancelInto(s, t, now, by);
  return s;
}

function cancelInto(s: State, t: Task, now: string, by?: { actor: Actor; reason: string }) {
  t.lifecycle = "cancelled";
  t.cancelledBy = by?.actor ?? "user";
  touch(t, now);
  const active = activeAttempts(s, t.id);
  event(s, now, by?.actor ?? "user", "control", `Cancelled${by ? ` (${by.reason})` : ""}; spec and partial artifacts retained${active.length ? `; stopping ${active.length} run(s)` : ""}`, t.id);
  for (const a of active) requestStop(s, a, "cancel", now);
  // Review 1 (10): nothing on a cancelled task waits for a decision any more.
  F.supersedeDecisions(s, t.id, now, { reason: `${t.id} was cancelled` });
  // Unfinished child tasks exist only for this task's goal: cancel them too.
  const children = descendants(s, t).filter(isOpen);
  for (const c of children) {
    c.lifecycle = "cancelled";
    c.cancelledBy = by?.actor ?? "user";
    touch(c, now);
    const runs = activeAttempts(s, c.id);
    event(s, now, "user", "control", `Cancelled with ${t.id}${runs.length ? `; stopping ${runs.length} run(s)` : ""}`, c.id);
    for (const a of runs) requestStop(s, a, "cancel", now);
    F.supersedeDecisions(s, c.id, now, { reason: `${c.id} was cancelled with ${t.id}` });
  }
  const gone = new Set([t.id, ...children.map((c) => c.id)]);
  for (const d of s.tasks.filter((x) => isOpen(x) && !gone.has(x.id))) {
    const dep = d.dependsOn.find((x) => gone.has(x));
    if (dep) event(s, now, "system", "blocked", `Blocked: prerequisite ${dep} was cancelled`, d.id);
  }
}

/** Write a priority. The user's own command also pins it (ORC-009); the lead's write names its change set. */
function writePriority(s: State, t: Task, priority: number, actor: "user" | "lead", now: string, detail?: string) {
  const old = t.priority;
  t.priority = priority;
  touch(t, now);
  event(s, now, actor, "control", `Priority P${old} → P${priority}${actor === "lead" ? " by lead" : ""}${detail ? ` (${detail})` : ""}`, t.id);
}

export function setPriority(state: State, taskId: string, priority: number, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Reprioritizing");
  if (!Number.isInteger(priority) || priority < 1) throw new ControlError("Priority must be a positive integer.");
  writePriority(s, t, priority, "user", now);
  (t.userSet ??= {}).priority = now;
  return s;
}

// ---------- ORC-009: pins, deferral, drop ----------

/** Pin the priority ("the lead may not reorder this"), or let the lead reorder it again. */
export function setPriorityPin(state: State, taskId: string, pinned: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Pinning");
  if (pinned) (t.userSet ??= {}).priority = now;
  else if (t.userSet) delete t.userSet.priority;
  touch(t, now);
  event(s, now, "user", "control", pinned ? `Priority P${t.priority} pinned; the lead may not reorder it` : "Priority unpinned; the lead may reorder it", t.id);
  return s;
}

/** "Keep running whatever the focus": the lead may not defer this task. Pinning a deferred task lifts its deferral (review finding 11). */
export function setRunPin(state: State, taskId: string, pinned: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Pinning");
  if (pinned) (t.userSet ??= {}).run = now;
  else if (t.userSet) delete t.userSet.run;
  touch(t, now);
  event(s, now, "user", "control", pinned ? "Keeps running whatever the focus; the lead may not defer it" : "The lead may defer this task again", t.id);
  if (pinned && t.deferral) clearDeferral(s, t, "user", now, "keeps running whatever the focus");
  return s;
}

/** Defer: nothing new starts on the task or its descendants. The running step, if any, finishes and its result is kept. */
function deferInto(s: State, t: Task, d: Deferral, now: string, detail?: string) {
  t.deferral = { ...d };
  touch(t, now);
  const running = activeAttempts(s, t.id).length;
  event(s, now, d.by, "control", `Deferred by ${d.by === "lead" ? "lead" : "you"}${detail ? ` (${detail})` : ""}: ${d.reason}${running ? "; the current step finishes first" : ""}`, t.id);
}

function clearDeferral(s: State, t: Task, actor: "user" | "lead", now: string, detail?: string) {
  t.deferral = undefined;
  touch(t, now);
  event(s, now, actor, "control", `Deferral lifted by ${actor === "lead" ? "lead" : "you"}${detail ? ` (${detail})` : ""}; eligible for dispatch again`, t.id);
}

/** Run now: clear the task's own deferral and keep it running whatever the focus. */
export function undeferTask(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Running");
  const d = deferredBy(s, t);
  if (!d) throw new ControlError(`${t.id} is not deferred.`);
  if (d.task.id !== t.id) throw new ControlError(`Deferred with ${d.task.id}: run ${d.task.id} now instead.`);
  clearDeferral(s, t, "user", now);
  (t.userSet ??= {}).run = now;
  return s;
}

/**
 * The lead drops (cancels) its own unstarted proposal. Only `steerPermission` allows it: a lead-authored
 * root that is proposed or ready, with no attempts, no descendants, no open dependent and untouched by
 * the user. Nothing runs, so nothing is stopped; Undo (reopen) restores it.
 */
function dropInto(s: State, t: Task, changeSetId: string, why: string, now: string, detail?: string) {
  const previous = t.lifecycle as "proposed" | "ready";
  t.lifecycle = "cancelled";
  t.cancelledBy = "lead";
  t.dropped = { changeSetId, lifecycle: previous, at: now };
  touch(t, now);
  event(s, now, "lead", "control", `Dropped by lead${detail ? ` (${detail})` : ""}: ${why}; Undo restores it`, t.id);
}

/** Reopen a dropped proposal. Returns why it was left as is, or undefined on success. */
function reopenDropped(s: State, t: Task, changeSetId: string, now: string): string | undefined {
  if (t.lifecycle !== "cancelled") return `${t.id} is ${t.lifecycle}`;
  if (!t.dropped || t.dropped.changeSetId !== changeSetId) return "it was not dropped by this change";
  if (s.attempts.some((a) => a.taskId === t.id)) return "it has run since";
  const title = currentSpec(t).content.title.trim().toLowerCase();
  if (s.tasks.some((x) => x.id !== t.id && x.lifecycle !== "cancelled" && currentSpec(x).content.title.trim().toLowerCase() === title)) return "a task with this title was created since";
  t.lifecycle = t.dropped.lifecycle;
  t.dropped = undefined;
  t.cancelledBy = undefined;
  (t.userSet ??= {}).run = now;
  touch(t, now);
  event(s, now, "user", "control", `Reopened: the lead's drop (${changeSetId}) was undone`, t.id);
  return undefined;
}

/** Started work: the lead may reorder or defer it, but never drop it. Same predicate as createChildren. */
function started(s: State, t: Task): boolean {
  return t.lifecycle === "active" || t.lifecycle === "done" || s.attempts.some((a) => a.taskId === t.id) || s.tasks.some((c) => c.parentTaskId === t.id);
}

/** The user changed something on this task by hand: the lead may not drop it. */
function userTouched(t: Task): boolean {
  if (t.userSet?.priority || t.userSet?.run) return true;
  if (t.hold && !t.holdReason && !t.pausedWith) return true;
  if (t.specs.some((r) => r.author === "user") || t.pipelineHistory.some((r) => r.author === "user")) return true;
  if (t.steps.some((st) => st.selection !== null)) return true;
  return Object.keys(t.roleOverrides).length > 0;
}

/** A user hold (not a review gate, not inherited from an ancestor). */
const userHold = (t: Task) => t.hold && !t.holdReason && !t.pausedWith;

/**
 * The dependency guard: an open task outside `t`'s tree that depends on a member of the tree. A drop
 * would leave it Blocked whenever it runs again, so for a drop every open dependent counts (review
 * finding 2); a deferral only leaves a not-deferred dependent waiting silently, so a dependent that is
 * already deferred does not keep a deferral back.
 */
function openDependent(s: State, t: Task, action: "defer" | "drop"): Task | undefined {
  const tree = new Set([t.id, ...descendants(s, t).map((d) => d.id)]);
  return s.tasks.find((x) => isOpen(x) && !tree.has(x.id) && (action === "drop" || !deferredBy(s, x)) && x.dependsOn.some((d) => tree.has(d)));
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

/** Configuration changed; let the next dispatch re-resolve blocked steps. A Checks step resolves no provider, so it stays as it is. */
function unblockConfigSteps(s: State) {
  for (const t of s.tasks) {
    if (t.lifecycle === "done" || t.lifecycle === "cancelled") continue;
    for (const st of t.steps) if (st.state === "blocked" && st.role !== "checks") {
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

/**
 * Append a vision revision. The user's edits and the lead's focus changes (ORC-009) both go through here.
 * ORC-014: the document set carries forward unless the revision changes it, so every revision records
 * exactly which documents applied.
 */
function pushVision(s: State, v: Pick<VisionRevision, "author" | "text" | "focus" | "reason" | "source" | "docIds">, now: string, message?: string): VisionRevision {
  const prev = currentVision(s);
  const docIds = v.docIds ?? prev.docIds;
  const rev: VisionRevision = { rev: prev.rev + 1, at: now, author: v.author, text: v.text, focus: v.focus, reason: v.reason, ...(v.source ? { source: v.source } : {}), ...(docIds ? { docIds: [...docIds] } : {}) };
  s.project.visions.push(rev);
  event(s, now, v.author, "vision", message ?? `Vision r${rev.rev}: ${v.reason}`);
  return rev;
}

export function editVision(state: State, expectedRev: number, text: string, focus: string, reason: string, now: string): State {
  const s = draft(state);
  const v = currentVision(s);
  if (v.rev !== expectedRev) throw new StaleWriteError(expectedRev, v.rev);
  // ORC-012 review 6: a project never builds without a vision. Clearing it is possible while shaping.
  if (s.project.stage === "building" && !text.trim()) throw new ControlError("The vision cannot be empty while building. Go back to shaping to clear it.");
  pushVision(s, { author: "user", text, focus, reason }, now);
  return s;
}

/** ORC-009: how far the lead may go when the user gives direction. Its own setting, never part of Autonomy. */
export function setSteeringMode(state: State, mode: SteeringMode, now: string): State {
  if (mode !== "apply" && mode !== "apply-own" && mode !== "suggest") throw new ControlError("Unknown steering mode.");
  const s = draft(state);
  s.project.steeringMode = mode;
  event(s, now, "user", "config", `Steering by conversation: ${steeringModeLabel(mode)}`);
  return s;
}

export function steeringModeLabel(mode: SteeringMode): string {
  return mode === "apply" ? "the lead applies changes; undo any of them" : mode === "apply-own" ? "the lead applies changes to its own proposals and suggests changes to your tasks" : "the lead only suggests changes";
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
    // ORC-009: a deferred proposal stays proposed until the deferral is lifted.
    if (deferredBy(s, t)) continue;
    if (blockedReason(s, t) || waitingOn(s, t)) continue;
    // ORC-013: a Checks step is run by the service and never resolves to a provider.
    const unresolved = t.steps.filter((st) => st.role !== "checks").map((st) => resolveStep(s, t, st)).find((r) => !r.ok);
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
  /** Tasks whose first writer must wait for a fresh base (a revert, before the base was fetched again). */
  staleBase?: (t: Task) => boolean;
  /** ORC-013: the checks sandbox is not ready: Checks steps wait, labelled, and nothing falls back to running unsandboxed. */
  checksHeld?: boolean;
}

/**
 * ORC-009: the dispatch order. A child runs at its root's priority tier unless the user pinned its own
 * priority; inside a tier, a task's own priority orders it (so breakdown items keep their order within
 * a tree). Nothing is written to children: the cascade is derived.
 */
export function dispatchRank(s: State, t: Task): [number, number] {
  const tier = t.parentTaskId && !t.userSet?.priority ? rootOf(s, t).priority : t.priority;
  return [tier, t.priority];
}

export function dispatchEligible(state: State, now: string, opts: DispatchOptions = {}): State {
  const s = draft(state);
  if (s.project.hold) return s;
  const vision = currentVision(s);
  // ORC-012: while shaping no worker step starts, on any task. Like a deferral (and unlike a hold),
  // running work finishes and its result is accepted, settled tasks become Done, and nothing is paused.
  const shaping = s.project.stage === "shaping";
  // ORC-013: Final checks steps that repeat an earlier run of the same commit and settings complete in this same transaction.
  const reused: { attemptId: string; outputs: OutputReport[] }[] = [];
  // A stable sort: tasks the lead did not name keep their relative (creation) order.
  const tasks = s.tasks.map((t) => ({ t, rank: dispatchRank(s, t) })).sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map((x) => x.t);
  for (const t of tasks) {
    if (activeAgentAttempts(s).length >= s.project.workerLimit) break;
    if (t.lifecycle !== "ready" && t.lifecycle !== "active") continue;
    if (t.hold || t.holdBeforeStart || t.heldForShaping || t.controlFailure || t.legacySpecUnavailable) continue;
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
    // ORC-009: deferral is checked only here, after the finish branch, so a deferred task whose work is
    // complete (including steps settled by skipping) still becomes Done and is queued for integration.
    // It is not a hold: the running step's result is accepted by reportCompletion as usual. Below, a
    // conditional step with nothing to do still settles by skipping; only starting work is withheld.
    const deferred = shaping || !!deferredBy(s, t);
    // Parallel steps become their copies the first time they are ready to run.
    if (!deferred) {
      for (const st of [...t.steps]) {
        if (st.parallel && !st.copyOf && st.state === "pending" && st.dependsOn.every((d) => isSettled(getStep(t, d)))) expandParallel(s, t, st, now);
      }
    }
    for (const st of [...t.steps]) {
      if (activeAgentAttempts(s).length >= s.project.workerLimit) break;
      if (st.state !== "pending") continue;
      const depsDone = st.dependsOn.every((d) => isSettled(getStep(t, d)));
      if (!depsDone) continue;
      if (st.waitForChildren && !childrenSettled(s, t)) continue;
      if (awaitingChoice(s, t, st)) continue;
      if ((opts.holdWriters || opts.staleBase?.(t)) && st.role === "coder" && !consumedInputs(s, t, st).some((i) => s.artifacts.find((x) => x.id === i.artifactId)?.kind === "code-change")) continue;
      if ((st.iteration ?? 1) > 1 && st.dependsOn.length && st.dependsOn.every((d) => getStep(t, d).state === "skipped")) {
        // The previous iteration ended without work to repeat (for example after a re-run came back clean).
        st.state = "skipped";
        st.invalidatedBy = undefined;
        touch(t, now);
        event(s, now, "lead", "dispatch", `Skipped ${st.id}: the previous iteration ended clean`, t.id);
        continue;
      }
      // ORC-013: a Checks step is run by the service, never by a provider. While checks are off for the
      // project it settles by skipping, so the pipeline continues (a settle-by-skip is allowed even
      // while deferred or shaping, as for a condition with nothing to do).
      if (st.role === "checks") {
        const cfg = s.project.checks ?? DEFAULT_CHECKS;
        if (!C.checksOn(cfg)) {
          st.state = "skipped";
          st.invalidatedBy = undefined;
          touch(t, now);
          event(s, now, "lead", "dispatch", `Skipped ${st.id}: checks are off for this project (Settings → Checks)`, t.id);
          continue;
        }
        const target = C.checkTargetOf(s, t, st);
        if (!target) {
          st.state = "skipped";
          st.invalidatedBy = undefined;
          touch(t, now);
          event(s, now, "lead", "dispatch", `Skipped ${st.id}: nothing to check: no code change reached this step`, t.id);
          continue;
        }
        // M2: a step that would run no check command never counts as passing; it blocks and says why.
        const missing = C.missingChecks(cfg, st);
        if (missing.length || !C.commandsFor(cfg, st).some((c) => c.kind === "check")) {
          const reason = missing.length ? `this step names checks that do not exist: ${missing.join(", ")}. Fix the pipeline, or the check settings.` : "this step runs no check command: every check it names was removed from the settings.";
          st.state = "blocked";
          st.blockedReason = reason;
          touch(t, now);
          event(s, now, "system", "blocked", `${st.id} blocked: ${reason}`, t.id);
          continue;
        }
        if (deferred) continue; // settling by skipping is allowed while deferred or shaping; starting is not
        // The sandbox is not ready: the step waits, labelled; nothing ever falls back to running unsandboxed (Q3).
        if (opts.checksHeld ?? C.checksHeld(s)) continue;
        if (activeServiceAttempts(s).length >= cfg.maxConcurrent) continue;
        const targetSha = target.ref;
        const reuse = st.checks?.onFail === "block" ? C.reusableRun(s, t, st, targetSha) : undefined;
        const attemptId = nextId(s, "run");
        const a: Attempt = {
          id: attemptId,
          taskId: t.id,
          stepId: st.id,
          snapshot: {
            provider: "service",
            model: "checks",
            source: "service",
            routingReason: reuse ? `Same commit and settings as ${reuse.attempt.stepId}'s run ${reuse.attempt.id}; not run again` : `Run by the service (${cfg.sandbox === "codex" ? "sandboxed" : "no sandbox"})`,
            specRev: spec.rev,
            stepRev: st.revision,
            visionRev: vision.rev,
            workspace: opts.workspaceFor ? opts.workspaceFor(t.id, st.id, attemptId) : `${s.project.repoPath}/.orchestration/worktrees/${t.id}-${st.id}`,
            pipelineRev: t.pipelineRev,
            purpose: st.purpose,
            inputs: consumedInputs(s, t, st),
            checks: { configRev: cfg.rev, sandbox: cfg.sandbox, target, commands: C.commandsFor(cfg, st), ...(reuse ? { reusedFrom: reuse.attempt.id } : {}) },
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
        event(s, now, "lead", "dispatch", `Dispatched ${st.id} (checks) to the service as ${a.id} on ${targetSha.slice(0, 12)} with settings r${cfg.rev}${reuse ? `; same commit and settings as ${reuse.attempt.id}, not run again` : ""}`, t.id);
        // Reuse (a Final checks step whose commit the loop already checked with these settings): it completes in this same transaction with a copy of that result.
        if (reuse) {
          const record: CheckRunRecord = { ...structuredClone(reuse.artifact.checkRun!), reusedFrom: reuse.attempt.id };
          const findings = reuse.artifact.findings ? structuredClone(reuse.artifact.findings) : undefined;
          reused.push({ attemptId, outputs: [{ name: st.outputs[0].name, summary: C.runSummary(record), checkRun: record, ...(findings ? { findings } : {}) }] });
        }
        continue;
      }
      // ORC-013: a step conditioned on findings waits, neither dispatched nor skipped, while an
      // ask-user finding it would read is undecided. Deferral, holds and pauses apply as usual.
      if (F.stepAwaitsDecision(s, t, st)) continue;
      if (st.runIf?.length) {
        // Only what a repair may do counts: auto-fix findings and those someone decided to fix.
        const open = st.runIf.reduce((n, r) => {
          const art = acceptedOutput(s, t, r.step, r.output);
          return n + (art ? F.fixable(s, art) : 0);
        }, 0);
        if (open === 0) {
          st.state = "skipped";
          st.invalidatedBy = undefined;
          touch(t, now);
          event(s, now, "lead", "dispatch", `Skipped ${st.id}: nothing to fix in ${st.runIf.map((r) => `${r.step}.${r.output}`).join(", ")}`, t.id);
          continue;
        }
      }
      if (deferred) continue; // ORC-009: nothing new starts on a deferred task; ORC-012: nor on any task while shaping
      const r = resolveStep(s, t, st);
      if (r.ok && opts.deferred?.includes(r.selection.provider)) continue;
      if (r.ok && activeAgentAttempts(s).filter((x) => x.snapshot.provider === r.selection.provider).length >= (s.project.providerLimits?.[r.selection.provider] ?? s.project.workerLimit)) continue;
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
          // A dedicated delivery review reads a worktree detached at exactly this commit.
          ...(t.reviewTarget ? { reviewedSha: t.reviewTarget.headSha } : {}),
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
  let out: State = s;
  for (const r of reused) out = reportCompletion(out, r.attemptId, [], now, r.outputs);
  return out;
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
  /** Legacy review findings: the worker's count. Ignored when `findings` is present (the service computes it). */
  openFindings?: number;
  /** ORC-013: structured findings, already validated by the parser. */
  findings?: Finding[];
  /** ORC-013: the changed files the reviewer says it judged (normalised by the parser). */
  reviewedPaths?: string[];
  /** ORC-013: a service check run (step 2). */
  checkRun?: Artifact["checkRun"];
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
    // ORC-013 §5.3: a code review that reports nothing must account for every changed file the
    // service showed it. Otherwise it is not accepted: once more with the gap named, then blocked.
    const reviewCoverage = new Map<string, ReturnType<typeof pathCoverageOf>>();
    // Review 1 (7): a code review that read a real change but got no changed-path set is "unproven", never "not-required".
    const readsRealChange = a.snapshot.inputs.some((i) => {
      const art = s.artifacts.find((x) => x.id === i.artifactId);
      return art?.kind === "code-change" && !!art.ref && !art.ref.startsWith("sim-");
    });
    for (const def of st.outputs) {
      if (def.kind !== "review-findings") continue;
      const rep = outputs.find((o) => o.name === def.name)!;
      const cov = st.role !== "code_reviewer" ? notRequired() : a.scope || !readsRealChange ? pathCoverageOf(a.scope, rep.reviewedPaths ?? []) : { state: "unproven" as const, changed: 0, reviewed: (rep.reviewedPaths ?? []).length, missing: [], extra: [] };
      reviewCoverage.set(def.name, cov);
      // Review 1 (14): a finding an earlier round settled (accepted, followed up) does not make this report "not clean".
      const open = rep.findings ? rep.findings.filter((f) => F.isBlocking(f) && !F.settledByKey(s, t, f)).length : (rep.openFindings ?? 0);
      if (open > 0 || cov.state !== "incomplete") continue;
      // Review 1 (12): the gap and its retry belong to one change; a different change starts over.
      if (st.coverageGap && st.coverageGap.to !== cov.to) {
        delete st.coverageGap;
        delete st.coverageRetries;
      }
      const gap = gapText(cov);
      a.outcome = "failed";
      const files = [...cov.missing, ...cov.extra].slice(0, 10).join(", ");
      if (!st.coverageRetries) {
        st.coverageRetries = 1;
        st.coverageGap = { missing: [...cov.missing], extra: [...cov.extra], ...(cov.to ? { to: cov.to } : {}) };
        settleStoppedStep(s, t, st); // pending, or paused under a hold
        a.note = `Reported no findings but ${gap}; not accepted. It runs again with those files named.`;
        event(s, now, "runtime", "runtime", `${a.id} reported no findings but ${gap}; ${st.id} runs again with those files named`, t.id);
      } else {
        st.state = "blocked";
        st.blockedReason = `Last run failed: the clean review did not cover ${files} (twice). Retry it, or edit its findings to accept it.`;
        a.note = `Reported no findings but ${gap} (twice); not accepted.`;
        event(s, now, "runtime", "blocked", `${a.id} reported no findings but ${gap} (twice); ${st.id} blocked`, t.id);
      }
      if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
      touch(t, now);
      return s;
    }
    a.outcome = "completed";
    st.state = "done";
    st.invalidatedBy = undefined;
    st.autoRetries = 0;
    delete st.coverageGap;
    delete st.coverageRetries;
    const produced: string[] = [];
    for (const def of st.outputs) {
      const rep = outputs.find((o) => o.name === def.name)!;
      const version = s.artifacts.filter((x) => x.taskId === t.id && x.stepId === st.id && x.name === def.name).length + 1;
      // Structured findings: the open count is computed here from the findings, never taken from the worker.
      const findings = def.kind === "review-findings" && rep.findings ? structuredClone(rep.findings) : undefined;
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
        ...(def.kind === "review-findings" ? { openFindings: findings ? F.blockingCount(findings) : (rep.openFindings ?? 0), ...(findings ? { findings } : {}), pathCoverage: reviewCoverage.get(def.name) ?? notRequired() } : {}),
        ...(def.kind === "check-results" && rep.checkRun ? { checkRun: structuredClone(rep.checkRun), ...(rep.findings ? { findings: structuredClone(rep.findings), openFindings: F.blockingCount(rep.findings) } : {}) } : {}),
        ...(def.kind === "breakdown" ? { items: structuredClone(rep.items ?? []) } : {}),
      };
      // Review 1 (10): open decisions on the version this run replaces cannot be acted on any more; decided ones are the record (and carry forward).
      for (const old of s.artifacts) if (old.taskId === t.id && old.stepId === st.id && old.name === def.name) F.supersedeDecisions(s, t.id, now, { artifactId: old.id, reason: `${st.id} ran again and produced ${def.name} v${version}` });
      s.artifacts.push(art);
      produced.push(`${def.name} v${version}`);
      // ORC-013 §4.4: every blocking ask-user finding becomes a decision, routed as the project is set.
      if (art.findings) F.createDecisions(s, t, art, now);
      // ORC-013 §6.7: a Final checks step whose run did not pass blocks the task and opens a decision.
      // The result stays on the record. The reason never starts with "Last run failed", so automatic
      // retry leaves it alone; only a repair round (lead or user) or the user's acceptance ends it.
      if (def.kind === "check-results" && st.checks?.onFail === "block" && art.checkRun && !C.allPassed(art.checkRun)) {
        const d = C.openFinalChecksDecision(s, t, st, art, now);
        st.state = "blocked";
        st.blockedReason = `Checks failed on the final change ${art.checkRun.sha.slice(0, 12)}: ${C.failedResults(art.checkRun).map((r) => r.label).join(", ")}. A decision is needed (${d.id}).`;
      }
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
 *
 * Internal (ORC-016): no command reaches this. Tests use it to build pipelines that patterns do not
 * offer; the task's pattern then becomes "Custom pipeline".
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
  const errors = validatePipeline(defs, { checkIds: C.configuredCheckIds(state.project.checks) }).filter((i) => i.severity === "error");
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
    for (const k of ["runIf", "gate", "iterate", "parallel", "waitForChildren", "independentOf", "copyOf", "iteration"] as const) if (def[k] === undefined) delete st[k];
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
  const custom = customRef(actor === "lead" ? "lead" : actor === "user" ? "user" : "service");
  t.pipelineHistory.push({ rev, at: now, author: actor, reason, steps: defs.map(toDef), pattern: custom });
  t.pattern = custom;
  touch(t, now);
  const parts = [changed.size && `changed ${[...changed].join(", ")}`, removed.length && `removed ${removed.join(", ")}`].filter(Boolean);
  event(s, now, actor, "pipeline", `Pipeline r${rev}: ${reason}${parts.length ? ` (${parts.join("; ")})` : ""}`, t.id);
  if (stopped.size) event(s, now, "system", "control", `Stopping ${stopped.size} run(s) affected by pipeline r${rev} before redispatch`, t.id);
  return s;
}

// ---------- pipeline patterns (ORC-016) ----------

/** The pattern a task may be created from by its id: a catalog pattern, never an internal one. */
export function creationPattern(s: State, patternId: string): Pattern {
  if (isInternalPatternId(patternId)) {
    throw new ControlError(patternId === "revert" ? "The Revert pattern is used by Send back only." : `The ${patternId === "delivery-review" ? "Delivery review" : "Delivery checks"} pattern is used by the service only.`);
  }
  const p = findPattern(s, patternId) ?? (patternId === "change" || patternId === "bugfix" ? servicePattern(s, patternId) : undefined);
  if (!p) throw new ControlError(`Unknown pattern ${patternId}`);
  return p;
}

/**
 * The project default pattern, used by the lead's proposals and breakdown items when they name none.
 * It must be standard: experiments, patterns that pause for you and unreviewed ones are yours to choose per task.
 */
export function setDefaultPattern(state: State, patternId: string, now: string): State {
  if (isInternalPatternId(patternId)) throw new ControlError(`"${patternId}" is a pipeline the service owns; it cannot be the default.`);
  const p = findPattern(state, patternId);
  if (!p) throw new ControlError(`Unknown pattern ${patternId}.`);
  if (!eligible(p, "default")) throw new ControlError(`"${p.name}" cannot be the default: the default is also used by the lead and by breakdowns, so it must be a standard pattern.`);
  const s = draft(state);
  if (s.project.defaultPatternId === patternId) return s;
  s.project.defaultPatternId = patternId;
  event(s, now, "user", "config", `Default pattern: ${p.name} (${p.id})`);
  return s;
}

const catalogKey = (c: PatternCatalog) =>
  JSON.stringify({ p: c.patterns.map((p) => [p.id, p.source, p.hash]), e: c.errors.map((e) => [e.file, e.message, e.line ?? null, e.column ?? null, e.effect]) });

/**
 * Replace the catalog with what the server loaded from files. Never a command: only the server calls it,
 * through `store.update`. It changes no task (tasks own copies of their steps), and it records an event only
 * when the set of patterns (id, source, hash) or the errors changed.
 */
export function setPatternCatalog(state: State, catalog: PatternCatalog, now: string): State {
  const s = draft(state);
  const changed = catalogKey(s.patterns) !== catalogKey(catalog);
  s.patterns = structuredClone(catalog);
  if (changed) {
    const yours = catalog.patterns.filter((p) => p.source === "local").length;
    const bad = new Set(catalog.errors.map((e) => e.file)).size;
    event(s, now, "system", "config", `Patterns loaded: ${catalog.patterns.length}${yours ? ` (${yours} yours)` : ""}${bad ? `; ${bad} file${bad === 1 ? " has" : "s have"} errors` : ""}`);
  }
  return s;
}

/** Record the outcome of writing a retired template as a pattern file (server, at start). Never a command. */
export function recordTemplateExport(state: State, templateId: string, result: { exportedTo: string; exportedId: string; stripped: string[] } | { exportError: string }, now: string): State {
  const s = draft(state);
  const t = s.retiredTemplates.find((x) => x.id === templateId && !x.exportedTo && !x.exportError);
  if (!t) return s;
  if ("exportError" in result) {
    t.exportError = result.exportError;
    event(s, now, "system", "config", `Template "${t.name}" from before patterns could not be saved as a pattern file: ${result.exportError}`);
  } else {
    t.exportedTo = result.exportedTo;
    t.exportedId = result.exportedId;
    if (result.stripped.length) t.stripped = [...result.stripped];
    event(s, now, "system", "config", `Template "${t.name}" from before patterns saved as ${result.exportedTo}${result.stripped.length ? ` (left out: ${result.stripped.join("; ")})` : ""}; choose Reload in Settings → Patterns to use it`);
  }
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
 * active, so no live work is orphaned by the replacement. ORC-012: `stage` defaults to building (the
 * vision is then required); a project that starts by shaping may leave the vision empty.
 */
export function initProject(state: State, init: { name: string; repoPath: string; vision: string; focus: string; stage?: ProjectStage }, now: string): State {
  if (activeAttempts(state).length || activeLeadRun(state)) throw new ControlError("Stop all active runs (pause the project and wait for Paused) before starting a new project.");
  const stage: ProjectStage = init.stage ?? "building";
  if (stage !== "shaping" && stage !== "building") throw new ControlError("Unknown project stage.");
  if (!init.name.trim() || !init.repoPath.trim()) throw new ControlError("Name and repository path are required.");
  if (stage === "building" && !init.vision.trim()) throw new ControlError("A vision is required to start building. Choose to shape it with the lead first, or write it now.");
  const s = draft(state);
  s.project.id = `p-${Date.parse(now).toString(36)}-${s.seq.toString(36)}`;
  s.project.sample = false;
  s.project.name = init.name.trim();
  s.project.repoPath = init.repoPath.trim();
  // A new project starts from provider-neutral defaults, never another project's model choices.
  Object.assign(s.project, autoModelDefaults());
  s.project.visions = [{ rev: 1, at: now, author: "user", text: init.vision.trim(), focus: init.focus.trim(), reason: stage === "shaping" ? "Project created; the vision is shaped with the lead first" : "Project created" }];
  // ORC-014: documents belong to the project they were attached to; a new project starts with none.
  s.project.visionDocs = [];
  s.project.stage = stage;
  if (stage === "shaping") s.project.shapingSince = now;
  else delete s.project.shapingSince;
  s.project.hold = false;
  s.project.lastVisitAt = now;
  // Delivery to GitHub is a choice made per project and repository: a new project starts with it off
  // and with nothing observed about the previous repository.
  s.project.prDelivery = structuredClone(DEFAULT_PR_DELIVERY);
  delete s.project.github;
  // ORC-013: checks are off until the user turns them on for this repository, and nothing has been probed for it.
  s.project.checks = structuredClone(DEFAULT_CHECKS);
  delete s.project.checksHealth;
  // ORC-016: the catalog is machine-level and stays; the default pattern is a project choice.
  s.project.defaultPatternId = "change";
  s.decisions = [];
  s.tasks = [];
  s.attempts = [];
  s.artifacts = [];
  s.events = [];
  s.conversation = [];
  s.leadRuns = [];
  // Review finding 6: an old project's change sets must not rewrite a new project's task with the same id.
  s.steering = [];
  s.visionDrafts = [];
  s.project.lastPlanningAt = undefined;
  event(s, now, "user", "vision", `Project "${s.project.name}" created for ${s.project.repoPath}${stage === "shaping" ? "; shaping the vision first" : ""}`);
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
  /** ORC-016: the catalog pattern the pipeline comes from. Any pattern but an internal one; nothing else supplies steps. */
  patternId: string;
  /** Default "user". The service passes "service" for the follow-ups it creates. */
  chosenBy?: ChosenBy;
  /** ORC-009: the user chose the priority (not the form's default): the lead may not reorder it. */
  priorityPinned?: boolean;
}

/**
 * A user-authored task. Its spec records one approach decided by the user and says so; the lead
 * has not proposed alternatives (the spec allows a single option when that is stated).
 */
export function createTask(state: State, t: NewTask, now: string): { state: State; newId: string } {
  if (!t.title.trim() || !t.outcome.trim() || !t.approach.trim()) throw new ControlError("Title, outcome, and approach are required.");
  const pattern = creationPattern(state, t.patternId);
  const errors = validatePipeline(pattern.steps, { checkIds: C.configuredCheckIds(state.project.checks) }).filter((i) => i.severity === "error");
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
  const defs = structuredClone(pattern.steps).map(toDef);
  const ref = patternRef(pattern, t.chosenBy ?? "user");
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
    pipelineHistory: [{ rev: 1, at: now, author: "user", reason: `Created from the ${pattern.name} pattern`, steps: defs, pattern: ref }],
    pattern: ref,
    patternSince: 1,
    ...(t.priorityPinned ? { userSet: { priority: now } } : {}),
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

/**
 * Lead-proposed tasks (including child tasks from breakdowns) that are not finished yet: the autonomy
 * cap counts these. ORC-009: deferred work is not counted here, so old-focus work does not block
 * planning for the new focus; `deferredLeadRoots` bounds it separately.
 */
export function openLeadProposals(s: State): Task[] {
  // Review and fix tasks the service creates for a pull request are never the lead's proposals.
  return s.tasks.filter((t) => t.specs[0]?.author === "lead" && t.lifecycle !== "done" && t.lifecycle !== "cancelled" && !t.reviewTarget && !t.deliverInto && !t.checkTarget && !deferredBy(s, t));
}

/** ORC-009: lead-authored open roots with their own deferral. Planning stops when these reach the open cap too. */
export function deferredLeadRoots(s: State): Task[] {
  return s.tasks.filter((t) => t.specs[0]?.author === "lead" && isOpen(t) && !t.parentTaskId && !!t.deferral && !t.reviewTarget && !t.deliverInto && !t.checkTarget);
}

/** Pull-request codes that wake the lead when they are new. */
const LEAD_WAKE_CODES = new Set(["checks-failed", "review-findings", "conflict", "foreign-push"]);

/**
 * Did delivery produce something the lead should see since `since`: a pull request that newly needs
 * attention for a failed check, review findings, a conflict or a foreign push; a pull request a person
 * closed; a failed check on the base branch; or a new note on landed work?
 */
export function deliveryNews(s: State, since: string): boolean {
  return s.tasks.some((t) => {
    const i = t.integration;
    const pr = i?.status === "integrated" ? i.pr : undefined;
    if (pr?.attention && LEAD_WAKE_CODES.has(pr.attention.code) && pr.attention.since > since) return true;
    // Closed on GitHub by a person: a close the user asked the app for is marked `closedByRequest`.
    if (pr?.phase === "closed" && pr.observed?.state === "CLOSED" && !pr.closedByRequest && pr.observed.at > since) return true;
    const l = i?.landed;
    if (l?.mainCheck?.state === "failure" && l.mainCheck.at > since) return true;
    return !!l?.notes.some((n) => n.at > since);
  });
}

/**
 * A user message. ORC-009: it may carry the task page it was sent from, and it stops a planning run in
 * progress so it is answered next (a reply run is not stopped; see `stopLeadReply`).
 */
export function postMessage(state: State, text: string, now: string, taskId?: string): State {
  const body = text.trim();
  if (!body) throw new ControlError("Write a message first.");
  if (body.length > 8000) throw new ControlError("Messages are limited to 8000 characters.");
  if (taskId !== undefined) getTask(state, taskId);
  const s = draft(state);
  s.conversation.push({ id: nextId(s, "msg"), at: now, author: "user", text: body, ...(taskId ? { taskId } : {}) });
  const r = activeLeadRun(s);
  if (r && r.outcome === "running" && r.messageIds.length === 0) requestLeadStop(s, r, "your message takes priority over planning", now);
  return s;
}

/** "Answer together now": stop the reply run in progress so its messages and the newer ones are answered by one run. */
export function stopLeadReply(state: State, now: string): State {
  const r = activeLeadRun(state);
  if (!r || r.outcome !== "running" || r.messageIds.length === 0) throw new ControlError("Nothing to interrupt: no reply is being written.");
  const s = draft(state);
  requestLeadStop(s, getLeadRun(s, r.id)!, "answer together now", now);
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
  // ORC-013: findings routed to the lead hold work up, so a decision run needs neither autonomy,
  // operating hours nor room under the planning caps (the failure backoff above still applies). Only
  // decisions no lead run has been shown yet start one: a run that left a decision open does not
  // start another by itself (every later run still lists it, and the user can take it over).
  if (F.decisionsDueForLead(s).length) return "decisions";
  // ORC-012: while shaping the lead only answers messages; planning is off until the user starts building.
  if (s.project.stage === "shaping") return null;
  const a = s.project.autonomy;
  if (!a.enabled || !inHours(a.operatingHours, localMinutes)) return null;
  // ORC-009: deferred lead work does not count toward the open cap, but it cannot pile up without limit either.
  if (openLeadProposals(s).length >= a.maxOpenProposals || deferredLeadRoots(s).length >= a.maxOpenProposals) return null;
  const last = s.project.lastPlanningAt ? Date.parse(s.project.lastPlanningAt) : 0;
  // Completions, integration conflicts, and blocked work since the last plan wake the lead sooner.
  // Delivery wakes it too: a pull request that needs attention, one a person closed, a failed check on
  // the base branch, or a new note on landed work. The same caps apply.
  const completedSince =
    s.tasks.some((t) => t.updatedAt > (s.project.lastPlanningAt ?? "") && (t.lifecycle === "done" || t.integration?.status === "conflict" || t.steps.some((st) => st.state === "blocked"))) ||
    deliveryNews(s, s.project.lastPlanningAt ?? "");
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
  // visionRev is a precondition recorded by the server: steering is refused if the vision moved meanwhile.
  s.leadRuns.push({ id, trigger: init.trigger, provider: init.provider, model: init.model, startedAt: now, outcome: "running", messageIds: pendingMessages(s).map((m) => m.id), visionRev: currentVision(s).rev });
  if (init.trigger === "planning") s.project.lastPlanningAt = now;
  event(s, now, "lead", "dispatch", `Lead ${leadTriggerLabel(init.trigger)} run ${id} started on ${providerLabel(init.provider)} · ${init.model}`);
  return { state: s, runId: id };
}

/** "planning", "reply", or "decisions" (ORC-013: a run started to decide findings routed to the lead). */
export function leadTriggerLabel(trigger: LeadTrigger): string {
  return trigger === "planning" ? "planning" : trigger === "decisions" ? "decisions" : "reply";
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
  /** ORC-016: the pattern to run. Absent: the project default. */
  patternId?: string;
  /** The name from before patterns, accepted as an alias of `patternId`. */
  templateId?: string;
  priority: number;
}

/** The pattern a proposal or breakdown item names, when it names one. */
const namedPattern = (p: LeadProposal): unknown => (p.patternId !== undefined ? p.patternId : p.templateId);

export interface LeadOutput {
  reply: string;
  proposals: LeadProposal[];
  /** ORC-009: the steering block as found in the JSON (untrusted; validated here). Absent or null: none. */
  steer?: unknown;
  /** ORC-012: the vision draft as found in the JSON (untrusted; validated here). Absent or null: none. */
  vision?: unknown;
  /** ORC-012: the lead's coverage of the vision's areas, as found (untrusted; validated here). */
  coverage?: unknown;
  /** ORC-012: the lead's questions to the user, as found (untrusted; validated here). */
  questions?: unknown;
  /** ORC-013: the lead's decisions on findings routed to it, as found (untrusted; validated in the findings module). */
  decisions?: unknown;
  /** Why the output could not be read (no JSON block): recorded on the run and shown under the reply. */
  problem?: string;
}

/** How long a dropped title stays off limits to planning (ORC-009). */
const DROP_GUARD_MS = 7 * 24 * 60 * 60_000;

/**
 * Check a proposal against the spec requirements. Returns a reason when it cannot become a task.
 * `who`: a lead proposal, or a breakdown item ("child": its pattern may not break down again).
 */
export function validateProposal(s: State, p: LeadProposal, now?: string, who: "lead" | "child" = "lead"): string | undefined {
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
  // ORC-016: the pattern is validated as untrusted data; the lead and breakdowns may use standard patterns only.
  const named = namedPattern(p);
  if (named !== undefined && typeof named !== "string") return "patternId must be text";
  const patternId = named ?? (who === "child" ? childDefault(s) : effectiveDefault(s)).id;
  const pattern = findPattern(s, patternId);
  if (!pattern || !eligible(pattern, "lead")) return `pattern "${patternId}" is not available to the lead; choose one of: ${eligibleIds(s, who).join(", ")}`;
  if (who === "child" && pattern.flags.breaksDown) return `child tasks cannot break down further (pattern "${pattern.name}"); use a pattern without breakdown steps: ${eligibleIds(s, "child").join(", ")}`;
  const title = (p.title as string).trim().toLowerCase();
  if (s.tasks.some((t) => t.lifecycle !== "cancelled" && currentSpec(t).content.title.trim().toLowerCase() === title)) return "a task with this title already exists";
  // ORC-009: work the lead dropped when the focus changed is not proposed again for a week.
  const nowMs = now ? Date.parse(now) : Date.now();
  const dropped = s.tasks.find((t) => t.lifecycle === "cancelled" && t.dropped && nowMs - Date.parse(t.dropped.at) < DROP_GUARD_MS && currentSpec(t).content.title.trim().toLowerCase() === title);
  if (dropped) return `dropped when the focus changed on ${dropped.dropped!.at.slice(0, 10)}; the user can restore it`;
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
    r.note = `Finished after a stop request; its proposals and steering were not applied. Reply: ${String(out.reply).slice(0, 2000)}`;
    return s;
  }
  r.outcome = "completed";
  r.endedAt = now;
  if (run.usage) r.usage = run.usage;
  if (run.actualModel) r.actualModel = run.actualModel;
  const rejected: string[] = [];
  if (out.problem) {
    r.note = out.problem;
    rejected.push("The reply had no machine-readable block, so nothing was changed.");
  }
  // ORC-009: steering, before the proposals so they are created under the new focus and after the
  // deferrals and drops that make room. Two guards make it apply once: the run-outcome guard above and
  // the change-set id.
  let set: SteeringChangeSet | undefined;
  if (out.steer !== undefined && out.steer !== null && !s.steering.some((cs) => cs.id === `cs-${r.id}`)) {
    set = steerFromRun(s, r, out.steer, now);
    s.steering.push(set);
    if (s.steering.length > 200) s.steering.splice(0, s.steering.length - 200);
    r.changeSetId = set.id;
  }
  // ORC-012: a vision draft. Never applied: it is recorded as a suggestion for the user to accept, edit
  // or dismiss. The run-outcome guard above and the draft id (one per run) make it record once.
  let visionDraft: VisionDraft | undefined;
  if (out.vision !== undefined && out.vision !== null && !s.visionDrafts.some((d) => d.leadRunId === r.id)) {
    const v = validateVisionDraft(s, r, out.vision);
    if (v.ok) visionDraft = draftFromRun(s, r, v.draft, now);
    else rejected.push(`Vision draft: ${v.why}`);
  }
  // ORC-012: coverage lives on the run (the latest stands); questions live on the reply. Both come only
  // from runs that answer the user; anything unreadable is left out with a note.
  let questions: LeadQuestion[] = [];
  if (out.coverage !== undefined && out.coverage !== null) {
    const c = validateCoverage(r, out.coverage);
    rejected.push(...c.notes.map((n) => `Coverage: ${n}`));
    // ORC-012 review 8: a block with no valid entry reports nothing; the previous coverage stands.
    if (c.ok && Object.keys(c.coverage).length === 0) rejected.push("Coverage: no valid entries; the previous coverage stands");
    else if (c.ok) r.coverage = c.coverage;
  }
  if (out.questions !== undefined && out.questions !== null) {
    const q = validateQuestions(r, out.questions);
    questions = q.questions;
    rejected.push(...q.notes.map((n) => `Questions: ${n}`));
  }
  // ORC-013: decisions on findings routed to the lead, after steering and before the proposals (a
  // follow-up decision proposes a task under the same caps). The run-outcome guard makes it apply once.
  if (out.decisions !== undefined && out.decisions !== null) rejected.push(...F.applyLeadDecisions(s, r, out.decisions, now));
  const decided = F.leadRunDecisions(s, r.id);
  const limit = Math.max(1, s.project.autonomy.maxProposalsPerCycle);
  const maxOpen = s.project.autonomy.maxOpenProposals;
  const openRoom = Math.max(0, maxOpen - openLeadProposals(s).length);
  // Review finding 15: the bound on deferred lead work applies to message runs as it does to planning.
  const deferredLead = deferredLeadRoots(s).length;
  // With autonomy off, proposals from a conversation still become tasks, but they wait for the user.
  // ORC-012: while shaping every proposal is the roadmap: held by its own flag until the user starts
  // building (review 2); the hold before start follows the involvement setting as for any lead proposal.
  const shaping = s.project.stage === "shaping";
  const hold = !s.project.autonomy.enabled || s.project.autonomy.holdLeadProposals;
  const created: string[] = [];
  const label = (p: unknown) => {
    const t = p && typeof p === "object" ? (p as { title?: unknown }).title : undefined;
    return typeof t === "string" ? t.slice(0, 80) : "(untitled)";
  };
  for (const [i, p] of out.proposals.entries()) {
    if (i >= limit) {
      rejected.push(`"${label(p)}": more than ${limit} proposals in one run`);
      continue;
    }
    if (deferredLead >= maxOpen) {
      rejected.push(`"${label(p)}": ${deferredLead} deferred lead proposals reached the limit of ${maxOpen}; drop those that no longer fit first`);
      continue;
    }
    if (created.length >= openRoom) {
      rejected.push(`"${label(p)}": the limit of ${s.project.autonomy.maxOpenProposals} open lead proposals is reached`);
      continue;
    }
    try {
      const why = validateProposal(s, p, now);
      if (why) {
        rejected.push(`"${label(p)}": ${why}`);
        continue;
      }
      created.push(proposeTask(s, p, now, hold, undefined, shaping));
    } catch (err) {
      rejected.push(`"${label(p)}": invalid (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // A completed message run decides the held suggestions, and its rows supersede older ones for the same target.
  if (r.messageIds.length) supersedeSuggestions(s, set, now);
  const applied = set?.changes.filter((c) => c.status === "applied").length ?? 0;
  const suggested = set?.changes.filter((c) => c.status === "suggested").length ?? 0;
  s.conversation.push({
    id: nextId(s, "msg"),
    at: now,
    author: "lead",
    text:
      out.reply.trim() ||
      (visionDraft
        ? "I drafted the vision; see below."
        : questions.length
          ? "I have a few questions; see below."
          : applied
            ? "I made the changes listed below."
            : suggested
              ? "I suggest the changes listed below."
              : decided.length
                ? "I went through the findings that were waiting for me; see below."
                : created.length
                  ? "I proposed new work; see the linked tasks."
                  : "No reply."),
    leadRunId: r.id,
    ...(created.length ? { proposedTaskIds: created } : {}),
    ...(rejected.length ? { rejected } : {}),
    ...(set ? { changeSetId: set.id } : {}),
    ...(visionDraft ? { visionDraftId: visionDraft.id } : {}),
    ...(questions.length ? { questions } : {}),
    // Review 1 (14): what this reply decided, as recorded now; the user's later changes do not rewrite it.
    ...(decided.length ? { leadDecisions: decided.map(({ decision: d, what }) => ({ id: d.id, taskId: d.taskId, what, status: d.status, ...(d.why || d.suggestion?.why ? { why: d.why ?? d.suggestion?.why } : {}) })) } : {}),
  });
  event(
    s,
    now,
    "lead",
    "spec",
    `Lead run ${r.id} replied${visionDraft ? " and drafted the vision" : ""}${decided.length ? ` and went through ${decided.length} decision${decided.length === 1 ? "" : "s"}` : ""}${created.length ? ` and proposed ${created.join(", ")}${shaping ? " (roadmap, held while shaping)" : ""}` : ""}${rejected.length ? `; ${rejected.length} item(s) rejected` : ""}`,
  );
  return s;
}

// ---------- ORC-013: the trusted base, and what the service recorded about a run before it started ----------

/**
 * The commit whose files the service trusts: the fetched remote base with pull-request delivery on,
 * the delivery branch with local delivery on, else HEAD of the user's repository. Never a worktree,
 * which agents write.
 */
export function trustedBaseRef(s: State): string {
  const p = s.project;
  if (p.prDelivery.enabled && p.github?.base) return prBaseRef(p.id);
  if (p.autonomy.autoDeliver.enabled) return `refs/heads/${p.autonomy.autoDeliver.branch}`;
  return "HEAD";
}

export interface RunContext {
  /** The changed-path set a review run was shown. */
  scope?: NonNullable<Attempt["scope"]>;
  /** The repository instruction files the run was given as project conventions. */
  conventions?: NonNullable<Attempt["conventions"]>;
  /** Decisions the run's envelope carried, so a later change applies only to later repairs. */
  decisions?: string[];
}

/** Record what the service gave a run (queued before the run starts; applied only while the run is active). The snapshot stays immutable. */
export function reportRunContext(state: State, attemptId: string, ctx: RunContext): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  if (ctx.scope) a.scope = { from: ctx.scope.from, to: ctx.scope.to, paths: ctx.scope.paths.slice(0, 500), total: ctx.scope.total };
  if (ctx.conventions) a.conventions = ctx.conventions.map((c) => ({ ...c }));
  for (const id of ctx.decisions ?? []) {
    const d = s.decisions.find((x) => x.id === id);
    if (d && !d.usedBy.includes(attemptId)) d.usedBy.push(attemptId);
  }
  return s;
}

/**
 * Create a lead-authored task from a validated proposal on a draft state. Shared with the findings module
 * (ORC-013 follow-ups). `who`: who named the pattern when the proposal names one; the project default
 * (or the child default for breakdown items) applies otherwise, recorded as chosen by "default".
 */
export function proposeTask(s: State, p: LeadProposal, now: string, hold: boolean, fixedId?: string, fromShaping = false, who: "lead" | "breakdown" = "lead"): string {
  let n = s.tasks.length + 1;
  const ids = new Set(s.tasks.map((x) => x.id));
  while (ids.has(`T-${String(n).padStart(3, "0")}`)) n++;
  const id = fixedId ?? `T-${String(n).padStart(3, "0")}`;
  const named = namedPattern(p);
  const pattern = typeof named === "string" ? findPattern(s, named)! : who === "breakdown" ? childDefault(s) : effectiveDefault(s);
  const ref = patternRef(pattern, typeof named === "string" ? who : "default");
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
  const defs = structuredClone(pattern.steps).map(toDef);
  s.tasks.push({
    id,
    priority: Number.isFinite(p.priority) ? Math.min(99, Math.max(1, Math.round(p.priority))) : 5,
    lifecycle: "proposed",
    hold: false,
    holdBeforeStart: hold,
    ...(fromShaping ? { heldForShaping: true } : {}),
    specs: [{ rev: 1, at: now, author: "lead", reason: "Proposed by the lead", content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    ...(fromShaping ? { fromShaping: true } : {}),
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "lead", reason: `Created from the ${pattern.name} pattern`, steps: defs, pattern: ref }],
    pattern: ref,
    patternSince: 1,
  });
  event(s, now, "lead", "decision", `Proposed ${id}: ${content.title} (selected option ${content.selectedOptionId})${fromShaping ? "; planned while shaping, waits for Start building" : ""}`, id);
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

// ---------- ORC-009: steering by conversation ----------
//
// A lead reply to the user's messages may carry a `steer` block: a new focus, and per root task a
// priority, a deferral or a drop. The lead's output is untrusted data. The service validates every item,
// checks it against `steerPermission` using the state at apply time, applies what is allowed in the same
// transaction that records the reply, and writes the authoritative change list. The lead never pauses,
// stops, resumes or releases anything, and never touches done tasks, delivery, specs, pins or settings.

export type SteerVerdict =
  | { v: "apply"; note?: string }
  | { v: "suggest"; why: string }
  /** Valid, but a rule keeps the current value. */
  | { v: "skip"; why: string }
  /** Not steerable. */
  | { v: "reject"; why: string }
  /** Nothing would change: not recorded. */
  | { v: "noop" };

/** The single source of what the lead may do to a task: it fills the envelope and enforces at apply time. */
export function steerPermission(s: State, t: Task | undefined, action: SteerAction, mode: SteeringMode, value?: number): SteerVerdict {
  // 1. Not steerable.
  if (!t) return { v: "reject", why: "unknown task" };
  if (t.lifecycle === "done" || t.lifecycle === "cancelled") return { v: "reject", why: `${t.id} is ${t.lifecycle}` };
  // Review finding 1: the review and fix tasks the service creates for a pull request belong to delivery
  // (ORC-008), which steering never touches: no priority, deferral or drop, whatever the mode.
  if (t.reviewTarget || t.deliverInto || t.checkTarget) return { v: "reject", why: "delivery task: not steerable" };
  if (t.parentTaskId) return { v: "reject", why: `child of ${t.parentTaskId}: steer ${rootOf(s, t).id}` };
  // 2. Nothing would change.
  if (action === "priority" && value === t.priority) return { v: "noop" };
  if (action === "defer" && t.deferral) return { v: "noop" };
  if (action === "undefer" && !t.deferral) return { v: "noop" };
  // 3. Valid, but the current value is kept: only the user decides when paused or failing work runs, and
  //    a drop or a deferral never leaves another open task waiting or blocked.
  if (action === "defer" && t.hold) return { v: "skip", why: userHold(t) ? "paused by you" : "paused for review" };
  if (action === "defer" && t.controlFailure) return { v: "skip", why: "needs your attention (control failure)" };
  if (action === "defer" || action === "drop") {
    const dep = openDependent(s, t, action);
    if (dep) return { v: "skip", why: `kept: ${dep.id} depends on it` };
  }
  // 4. A user choice or the mode turns it into a suggestion.
  const own = t.specs[0]?.author === "lead";
  let verdict: SteerVerdict;
  switch (action) {
    case "priority":
      if (t.userSet?.priority) verdict = { v: "suggest", why: `you set P${t.priority}` };
      else if (mode === "apply-own" && !own) verdict = { v: "suggest", why: "your task: suggest-only (Settings)" };
      else verdict = { v: "apply", ...(t.holdBeforeStart && t.lifecycle !== "active" ? { note: "still waits for your release" } : {}) };
      break;
    case "defer":
      if (t.userSet?.run) verdict = { v: "suggest", why: "you asked it to keep running" };
      else if (mode === "apply-own" && !own) verdict = { v: "suggest", why: "your task: suggest-only (Settings)" };
      else verdict = { v: "apply" };
      break;
    case "undefer":
      verdict = t.deferral!.by === "user" ? { v: "suggest", why: "you deferred it" } : { v: "apply" };
      break;
    case "drop":
      if (!own) verdict = { v: "suggest", why: "your task: only you cancel it" };
      else if (started(s, t)) verdict = { v: "suggest", why: "it has started; cancelling stops its work" };
      else if (userTouched(t)) verdict = { v: "suggest", why: "you changed this task" };
      else verdict = { v: "apply" };
      break;
  }
  // 5. Only suggest.
  if (mode === "suggest" && verdict.v === "apply") return { v: "suggest", why: "only suggest (Settings)" };
  return verdict;
}

const STEER_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
export const MAX_STEER_ITEMS = 20;
// Control characters other than newline and tab (those are whitespace, collapsed by `oneLine`).
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/**
 * ORC-012 review 5 and ORC-014 review 3: characters that show nothing but change how text reads or is
 * matched. Text the lead supplies (drafts, questions, options, coverage, steering reasons and the focus)
 * and document text in envelopes lose: C1 controls, the zero-width space, bidi embeddings and overrides
 * (U+202A–202E) and isolates (U+2066–2069), the word joiner, the byte-order mark, and tag characters
 * outside a valid emoji tag sequence. Legitimate text keeps what it needs: ZWJ inside emoji sequences
 * and between letters, ZWNJ between letters (Persian, Devanagari), LRM/RLM, variation selectors, and
 * emoji tag sequences (U+1F3F4, tags, U+E007F: subdivision flags). Text the user typed is never altered.
 */
const HOSTILE_RE = /[\u0080-\u009F\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
/** A valid emoji tag sequence is kept whole; any other tag character goes. */
const TAG_RE = /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu;
const JOINER_RE = /[\u200C\u200D]/gu;
const LETTER_RE = /[\p{L}\p{M}]/u;
const EMOJI_BEFORE_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F]/u;
const EMOJI_AFTER_RE = /\p{Extended_Pictographic}/u;
/** Nothing visible: whitespace and the invisible characters legitimate text may keep. */
const ONLY_INVISIBLE_RE = /^[\s\u200C-\u200F\uFE0E\uFE0F]*$/u;

const codePointBefore = (x: string, i: number): string => {
  if (i <= 0) return "";
  const lo = x.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) return x.slice(i - 2, i);
  return x[i - 1];
};
const codePointAfter = (x: string, i: number): string => {
  const cp = x.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
};

/** Remove hostile invisible characters, keeping the joiners and marks legitimate text needs. Reports how many were removed. */
export function stripHostile(x: string): { text: string; removed: number } {
  let removed = 0;
  let out = x.replace(HOSTILE_RE, () => {
    removed += 1;
    return "";
  });
  out = out.replace(TAG_RE, (_m, seq: string | undefined) => {
    if (seq) return seq;
    removed += 1;
    return "";
  });
  out = out.replace(JOINER_RE, (m, offset: number, whole: string) => {
    const before = codePointBefore(whole, offset);
    const after = codePointAfter(whole, offset + 1);
    const betweenLetters = LETTER_RE.test(before) && LETTER_RE.test(after);
    const inEmoji = m === "\u200D" && (EMOJI_BEFORE_RE.test(before) || EMOJI_AFTER_RE.test(after));
    if (betweenLetters || inEmoji) return m;
    removed += 1;
    return "";
  });
  return { text: out, removed };
}
export const stripInvisible = (x: string) => stripHostile(x).text;
/** Text with nothing visible in it counts as empty. */
const visibleOrEmpty = (x: string) => (ONLY_INVISIBLE_RE.test(x) ? "" : x);
/**
 * Review finding 8: every text the lead supplies (focus, reason, why) is one line of plain text. The
 * focus is printed verbatim in every later envelope, so newlines would give injected text a persistent
 * channel; control characters are rejected outright by `CONTROL_RE`, invisible ones are stripped.
 */
const oneLine = (x: string) => visibleOrEmpty(stripInvisible(x).replace(/\s+/g, " ").trim());

export interface SteerItem {
  id: string;
  action: SteerAction;
  value?: number;
  why: string;
}

export interface ValidatedSteer {
  refused?: string;
  /** Absent: no focus change, or one equal to the current focus (a no-op, not recorded). */
  focus?: { ok: true; value: string } | { ok: false; why: string };
  reason: string;
  notes: string[];
  items: ({ ok: true; item: SteerItem } | { ok: false; kind: SteeringChange["kind"]; taskId?: string; why: string; reason: string })[];
}

/** What action an entry names, for a rejected row's kind. */
function guessKind(it: Record<string, unknown> | undefined): SteeringChange["kind"] {
  if (!it) return "invalid";
  const keys = ["priority", "defer", "drop"].filter((k) => it[k] !== undefined);
  if (keys.length !== 1) return "invalid";
  if (keys[0] === "priority") return "priority";
  if (keys[0] === "drop") return "drop";
  return it.defer === false ? "undefer" : "defer";
}

/**
 * Strict, per-item validation of the lead's steering block. Each entry is checked on its own, so one
 * bad entry never discards the others (the H2 pattern). Pure: nothing is applied here.
 */
export function validateSteer(s: State, r: LeadRun, steer: unknown): ValidatedSteer {
  const out: ValidatedSteer = { reason: "From your message", notes: [], items: [] };
  // Permission is decided by the messages the run answers, never by its trigger.
  if (r.messageIds.length === 0) return { ...out, refused: "planning runs cannot steer" };
  if (r.visionRev === undefined) return { ...out, refused: "started before steering existed" };
  if (!steer || typeof steer !== "object" || Array.isArray(steer)) return { ...out, refused: "the steering block was not an object" };
  const b = steer as Record<string, unknown>;
  if (b.focus !== undefined && b.focus !== null) {
    if (typeof b.focus !== "string") out.focus = { ok: false, why: "focus must be text" };
    else if (CONTROL_RE.test(b.focus)) out.focus = { ok: false, why: "focus contains control characters" };
    else {
      const f = oneLine(b.focus);
      if (f.length < 1 || f.length > 500) out.focus = { ok: false, why: "focus must be 1–500 characters" };
      else if (f !== oneLine(currentVision(s).focus)) out.focus = { ok: true, value: f };
    }
  }
  if (typeof b.reason === "string" && !CONTROL_RE.test(b.reason) && oneLine(b.reason) && oneLine(b.reason).length <= 500) out.reason = oneLine(b.reason);
  else if (b.reason !== undefined && b.reason !== null) out.notes.push("reason ignored: not plain text of at most 500 characters");
  if (b.tasks !== undefined && b.tasks !== null) {
    if (!Array.isArray(b.tasks)) out.notes.push("tasks ignored: not a list");
    else {
      // Review finding 5: entries past the cap are counted in one note, never one persisted row each.
      const extra = b.tasks.length - MAX_STEER_ITEMS;
      if (extra > 0) out.notes.push(`${extra} more entr${extra === 1 ? "y" : "ies"} ignored: at most ${MAX_STEER_ITEMS} changes in one reply`);
      const seen = new Set<string>();
      b.tasks.slice(0, MAX_STEER_ITEMS).forEach((raw: unknown) => {
        const it = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
        const id = typeof it?.id === "string" && STEER_ID_RE.test(it.id) ? it.id : undefined;
        // The copy kept on a rejected row is plain text too: control characters stripped, one line, capped.
        const why = typeof it?.why === "string" ? oneLine(it.why.replace(new RegExp(CONTROL_RE.source, "g"), "")).slice(0, 300) : "";
        const fail = (reason: string) => out.items.push({ ok: false, kind: guessKind(it), ...(id ? { taskId: id } : {}), why, reason });
        try {
          if (!it) return fail("not an object");
          if (!id) return fail("id must be 1–40 letters, digits, dots, dashes or underscores");
          const keys = ["priority", "defer", "drop"].filter((k) => it[k] !== undefined);
          if (keys.length !== 1) return fail("give exactly one of priority, defer, drop");
          if (it.why !== undefined && it.why !== null && (typeof it.why !== "string" || it.why.length > 300)) return fail("why must be text of at most 300 characters");
          if (typeof it.why === "string" && CONTROL_RE.test(it.why)) return fail("why contains control characters");
          let action: SteerAction;
          let value: number | undefined;
          if (keys[0] === "priority") {
            if (typeof it.priority !== "number" || !Number.isInteger(it.priority) || it.priority < 1 || it.priority > 99) return fail("priority must be a whole number 1–99");
            action = "priority";
            value = it.priority;
          } else if (keys[0] === "defer") {
            if (typeof it.defer !== "boolean") return fail("defer must be true or false");
            action = it.defer ? "defer" : "undefer";
          } else {
            if (it.drop !== true) return fail("drop must be true");
            action = "drop";
          }
          if (seen.has(id)) return fail("one change per task per reply");
          seen.add(id);
          out.items.push({ ok: true, item: { id, action, ...(value !== undefined ? { value } : {}), why } });
        } catch (err) {
          fail(`invalid (${err instanceof Error ? err.message : String(err)})`);
        }
      });
    }
  }
  return out;
}

/** Validate and apply a completed message run's steering block; returns the authoritative change set. */
function steerFromRun(s: State, r: LeadRun, steer: unknown, now: string): SteeringChangeSet {
  const setId = `cs-${r.id}`;
  const v = validateSteer(s, r, steer);
  const set: SteeringChangeSet = { id: setId, leadRunId: r.id, messageIds: [...r.messageIds], at: now, mode: s.project.steeringMode, basedOnVisionRev: r.visionRev ?? currentVision(s).rev, reason: v.reason, notes: v.notes, changes: [] };
  if (v.refused) {
    set.refused = v.refused;
    event(s, now, "system", "control", `Lead run ${r.id}: steering refused (${v.refused})`);
    return set;
  }
  // Newer direction wins: the run is completed now, so its own messages are covered; anything still
  // pending was posted while it worked. A vision edit meanwhile also holds the set.
  const newer = pendingMessages(s).length > 0;
  // ORC-014 review 2: only a change to the text or focus holds the set. Documents attached or removed
  // meanwhile are noted truthfully, and the focus still applies.
  const visionMoved = visionContentMovedSince(s, r.visionRev);
  if (newer) set.heldBecause = "You sent another message while the lead was working; its next reply decides.";
  else if (visionMoved) set.heldBecause = "You edited the vision while the lead was working.";
  if (!visionMoved && currentVision(s).rev !== r.visionRev) set.notes.push("Your vision documents changed while the lead was working; its reply may not reflect them.");
  const held = !!set.heldBecause;
  const mode = s.project.steeringMode;
  const from = r.messageIds.join(", ");
  const rows: SteeringChange[] = [];
  const row = (c: Omit<SteeringChange, "id">): SteeringChange => {
    const full = { id: `${setId}.${rows.length + 1}`, ...c };
    rows.push(full);
    return full;
  };

  // Focus first, so the task changes and the new proposals follow it.
  const cur = currentVision(s);
  if (v.focus) {
    if (!v.focus.ok) row({ kind: "focus", before: cur.focus, after: null, why: v.reason, status: "rejected", note: v.focus.why });
    else if (visionMoved) row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "rejected", note: `you edited the vision (now r${cur.rev}); your edit stands` });
    // Review finding 7: an undone change cannot be redone. Task rows are guarded by the pins Undo sets;
    // a focus has no pin, so a focus the user undid can only be suggested again.
    else if (undoneFocus(s, v.focus.value)) row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "suggested", note: "you undid this focus", visionRev: r.visionRev });
    else if (held || mode === "suggest") row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "suggested", note: held ? "held: newer direction" : "only suggest (Settings)", visionRev: r.visionRev });
    else {
      const rev = pushVision(s, { author: "lead", text: cur.text, focus: v.focus.value, reason: v.reason, source: { changeSetId: setId, leadRunId: r.id, messageIds: [...r.messageIds] } }, now, `Focus r${cur.rev + 1} by lead from your message ${from} (${setId}): ${v.reason}`);
      row({ kind: "focus", before: cur.focus, after: v.focus.value, why: v.reason, status: "applied", appliedBy: "lead", visionRev: rev.rev });
    }
  }

  // Task items, in array order. No-ops are not recorded; the rest get rows now so their ids follow the
  // order the lead gave, even when the dependency-guard retry pass applies some of them later.
  const pending: { item: SteerItem; change: SteeringChange }[] = [];
  for (const entry of v.items) {
    if (!entry.ok) {
      row({ kind: entry.kind, ...(entry.taskId ? { taskId: entry.taskId } : {}), before: null, after: null, why: entry.why, status: "rejected", note: entry.reason });
      continue;
    }
    const { item } = entry;
    const t = s.tasks.find((x) => x.id === item.id);
    if (t && steerPermission(s, t, item.action, mode, item.value).v === "noop") continue;
    const kind: SteeringChange["kind"] = item.action;
    const before: SteeringChange["before"] = !t ? null : item.action === "priority" ? t.priority : item.action === "defer" ? null : item.action === "undefer" ? structuredClone(t.deferral ?? null) : t.lifecycle;
    const after: SteeringChange["after"] = item.action === "priority" ? (item.value ?? null) : item.action === "defer" ? { by: "lead", at: now, reason: item.why, changeSetId: setId } : item.action === "undefer" ? null : "cancelled";
    pending.push({ item, change: row({ kind, taskId: item.id, before, after, why: item.why, status: "skipped" }) });
  }
  // Each item is checked against the current state, including the items already applied in this run.
  // Items kept only by the dependency guard are re-checked after the others, until none more apply, so
  // the lead may defer or drop both a prerequisite and its dependent in either order.
  const decide = (p: { item: SteerItem; change: SteeringChange }): boolean => {
    const { item, change } = p;
    const t = s.tasks.find((x) => x.id === item.id);
    let verdict = steerPermission(s, t, item.action, mode, item.value);
    if (held && verdict.v === "apply") verdict = { v: "suggest", why: "held: newer direction" };
    if (verdict.v === "skip" && verdict.why.startsWith("kept:")) {
      change.status = "skipped";
      change.note = verdict.why;
      return false;
    }
    if (verdict.v === "noop") {
      change.status = "skipped";
      change.note = "nothing to change";
    } else if (verdict.v === "reject" || verdict.v === "skip" || verdict.v === "suggest") {
      change.status = verdict.v === "reject" ? "rejected" : verdict.v === "skip" ? "skipped" : "suggested";
      change.note = verdict.why;
    } else {
      const task = t!;
      const detail = `${change.id}, from ${from}`;
      if (item.action === "priority") writePriority(s, task, item.value!, "lead", now, `${detail}${item.why ? `: ${item.why}` : ""}`);
      else if (item.action === "defer") deferInto(s, task, { by: "lead", at: now, reason: item.why, changeSetId: setId }, now, change.id);
      else if (item.action === "undefer") clearDeferral(s, task, "lead", now, `${change.id}${item.why ? `: ${item.why}` : ""}`);
      else dropInto(s, task, setId, item.why, now, change.id);
      change.status = "applied";
      change.appliedBy = "lead";
      // Review finding 12: a row applied on the retry pass drops its "kept: …" note from the first pass.
      if (verdict.note) change.note = verdict.note;
      else delete change.note;
    }
    return true;
  };
  let queue = pending.filter((p) => !decide(p));
  for (let pass = 0; queue.length && pass < MAX_STEER_ITEMS; pass++) {
    const again = queue.filter((p) => !decide(p));
    if (again.length === queue.length) break;
    queue = again;
  }

  set.changes = rows;
  const count = (st: SteeringChange["status"], kind?: SteeringChange["kind"]) => rows.filter((c) => c.status === st && (!kind || c.kind === kind)).length;
  const parts = [
    count("applied", "focus") && "focus changed",
    count("applied", "priority") && `${count("applied", "priority")} reprioritized`,
    count("applied", "defer") && `${count("applied", "defer")} deferred`,
    count("applied", "undefer") && `${count("applied", "undefer")} deferral(s) lifted`,
    count("applied", "drop") && `${count("applied", "drop")} dropped`,
  ].filter(Boolean);
  const rest = [count("suggested") && `${count("suggested")} suggestion(s)`, count("skipped") && `${count("skipped")} kept`, count("rejected") && `${count("rejected")} rejected`].filter(Boolean);
  event(s, now, "lead", "control", `Lead run ${r.id} steered from ${from}: ${parts.length ? parts.join(", ") : "nothing applied"}${rest.length ? `; ${rest.join(", ")}` : ""} (${setId})${set.heldBecause ? ` — held: ${set.heldBecause}` : ""}`);
  return set;
}

/**
 * Older suggestions are superseded by a held set's successor, or by a later row for the same target.
 * Review finding 10: only a reply that decided something supersedes. A reply without a steering block,
 * or whose block was refused, leaves the held suggestions for the next one; and only rows the service
 * accepted (applied or suggested) count as a decision on their target.
 */
function supersedeSuggestions(s: State, set: SteeringChangeSet | undefined, now: string) {
  if (!set || set.refused) return;
  const accepted = set.changes.filter((x) => x.status === "applied" || x.status === "suggested");
  for (const cs of s.steering) {
    if (cs.id === set.id) continue;
    for (const c of cs.changes) {
      if (c.status !== "suggested") continue;
      const sameTarget = accepted.some((x) => (x.kind === "focus" ? c.kind === "focus" : x.taskId !== undefined && x.taskId === c.taskId));
      if (cs.heldBecause || sameTarget) {
        c.status = "superseded";
        c.resolvedAt = now;
      }
    }
  }
}

/**
 * ORC-014 review 2: attaching or removing a document creates a vision revision without touching the
 * text or focus. Compare-and-set on the lead's focus changes, and the "you edited the vision" hold,
 * therefore compare the text and focus, never the raw revision number: a document-only change
 * invalidates nothing.
 */
export function visionContentMovedSince(s: State, rev: number | undefined): boolean {
  const then = rev === undefined ? undefined : s.project.visions.find((v) => v.rev === rev);
  if (!then) return true;
  const cur = currentVision(s);
  return cur.text !== then.text || cur.focus !== then.focus;
}

/** Review finding 7: did the user undo a lead focus change to exactly this text? Then it is only suggested again. */
function undoneFocus(s: State, focus: string): boolean {
  return s.steering.some((cs) => cs.changes.some((c) => c.kind === "focus" && c.status === "undone" && oneLine(String(c.after ?? "")) === focus));
}

/** Replace the "left as is on <op>: …" segment of a row's note (review finding 12: failed undos must not pile up). */
function leftNote(note: string | undefined, op: "undo" | "apply", why: string): string {
  const prefix = `left as is on ${op}:`;
  const parts = (note ?? "").split("; ").filter((p) => p && !p.startsWith(prefix));
  parts.push(`${prefix} ${why}`);
  return parts.join("; ");
}

function getChangeSet(s: State, changeSetId: string): SteeringChangeSet {
  const set = s.steering.find((x) => x.id === changeSetId);
  if (!set) throw new ControlError(`Unknown change set ${changeSetId}`);
  return set;
}

function getChange(set: SteeringChangeSet, changeId: string): SteeringChange {
  const c = set.changes.find((x) => x.id === changeId);
  if (!c) throw new ControlError(`Unknown change ${changeId}`);
  return c;
}

export interface UndoResult {
  undone: string[];
  left: { id: string; why: string }[];
}

/** Revert one applied row, compare-and-set. Returns why it was left as is, or undefined when undone. */
function undoRow(s: State, set: SteeringChangeSet, c: SteeringChange, now: string): string | undefined {
  const t = c.taskId ? s.tasks.find((x) => x.id === c.taskId) : undefined;
  switch (c.kind) {
    case "focus": {
      const cur = currentVision(s);
      if (visionContentMovedSince(s, c.visionRev)) return `the vision changed since (now r${cur.rev})`;
      pushVision(s, { author: "user", text: cur.text, focus: String(c.before ?? ""), reason: `Undid the lead's focus change (${set.id})`, source: { undoOf: set.id } }, now);
      return undefined;
    }
    case "priority": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.priority !== c.after) return `you changed it since (now P${t.priority})`;
      writePriority(s, t, Number(c.before), "user", now, `undo of ${c.id}`);
      (t.userSet ??= {}).priority = now; // the lead cannot redo what the user reversed
      return undefined;
    }
    case "defer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.deferral?.changeSetId !== set.id) return "it was run or deferred again since";
      clearDeferral(s, t, "user", now, `undo of ${c.id}`);
      (t.userSet ??= {}).run = now;
      return undefined;
    }
    case "undefer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.deferral) return "it was deferred again since";
      const before = c.before as Deferral | null;
      if (!before || typeof before !== "object") return "the earlier deferral is not on record";
      // Review finding 7: restored as the user's deferral, so the lead can only suggest lifting it again.
      t.deferral = { ...structuredClone(before), by: "user", at: now };
      touch(t, now);
      event(s, now, "user", "control", `Deferral restored by you (undo of ${c.id}); the lead may only suggest lifting it`, t.id);
      return undefined;
    }
    case "drop":
      if (!t) return "task not found";
      // A drop the user applied went through the ordinary cancel, which has no undo.
      if (c.appliedBy === "user") return "you cancelled it; a cancel cannot be undone";
      return reopenDropped(s, t, set.id, now);
    default:
      return "not applied";
  }
}

/** Undo one row, or every applied row of a reply in reverse order. Compare-and-set: anything changed since is left alone and reported. */
export function undoSteering(state: State, changeSetId: string, changeId: string | undefined, now: string): { state: State; result: UndoResult } {
  const s = draft(state);
  const set = getChangeSet(s, changeSetId);
  const rows = changeId ? [getChange(set, changeId)] : [...set.changes].reverse();
  const result: UndoResult = { undone: [], left: [] };
  let noted = false; // a row's note changed: a new reason, not a repeat of the last failed undo
  for (const c of rows) {
    if (c.status === "undone") {
      result.left.push({ id: c.id, why: "already undone" });
      continue;
    }
    if (c.status !== "applied") {
      if (changeId) result.left.push({ id: c.id, why: "not applied" });
      continue;
    }
    const why = undoRow(s, set, c, now);
    if (why) {
      const note = leftNote(c.note, "undo", why);
      if (note !== c.note) noted = true;
      c.note = note;
      result.left.push({ id: c.id, why });
    } else {
      c.status = "undone";
      c.resolvedAt = now;
      result.undone.push(c.id);
    }
  }
  // Review finding 12: a repeated failed undo neither grows the note nor logs another event.
  if (result.undone.length || noted) {
    event(s, now, "user", "control", `Undid ${result.undone.length} of the lead's change(s) (${set.id})${result.left.length ? `; ${result.left.length} left as is` : ""}`);
  }
  return { state: s, result };
}

export interface ApplyResult {
  applied: string[];
  left: { id: string; why: string }[];
}

/** Apply one suggested row as the user. Returns why it was left as is, or undefined when applied. */
function applyRow(s: State, set: SteeringChangeSet, c: SteeringChange, now: string): string | undefined {
  const t = c.taskId ? s.tasks.find((x) => x.id === c.taskId) : undefined;
  switch (c.kind) {
    case "focus": {
      const cur = currentVision(s);
      if (visionContentMovedSince(s, c.visionRev)) return `the vision changed since (now r${cur.rev})`;
      const rev = pushVision(s, { author: "user", text: cur.text, focus: String(c.after ?? ""), reason: `Applied the lead's suggestion (${set.id}): ${c.why || set.reason}`, source: { changeSetId: set.id } }, now);
      c.visionRev = rev.rev;
      return undefined;
    }
    case "priority": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.priority !== c.before) return `the priority changed since (now P${t.priority})`;
      writePriority(s, t, Number(c.after), "user", now, `applied ${c.id}`);
      (t.userSet ??= {}).priority = now;
      return undefined;
    }
    case "defer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (t.parentTaskId) return `child of ${t.parentTaskId}`;
      if (t.deferral) return "it is already deferred";
      deferInto(s, t, { by: "user", at: now, reason: c.why || set.reason, changeSetId: set.id }, now, `applied ${c.id}`);
      c.after = structuredClone(t.deferral!);
      return undefined;
    }
    case "undefer": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      if (!t.deferral || JSON.stringify(t.deferral) !== JSON.stringify(c.before)) return "the deferral changed since";
      clearDeferral(s, t, "user", now, `applied ${c.id}`);
      (t.userSet ??= {}).run = now;
      return undefined;
    }
    case "drop": {
      if (!t) return "task not found";
      if (!isOpen(t)) return `${t.id} is ${t.lifecycle}`;
      cancelInto(s, t, now);
      return undefined;
    }
    default:
      return "not a suggestion";
  }
}

/** Apply one suggestion, or every suggestion of a reply, as the user. Compare-and-set against the recorded `before`. */
export function applySteering(state: State, changeSetId: string, changeId: string | undefined, now: string): { state: State; result: ApplyResult } {
  const s = draft(state);
  const set = getChangeSet(s, changeSetId);
  const rows = changeId ? [getChange(set, changeId)] : set.changes.filter((c) => c.status === "suggested");
  const result: ApplyResult = { applied: [], left: [] };
  for (const c of rows) {
    if (c.status !== "suggested") {
      result.left.push({ id: c.id, why: c.status === "applied" ? "already applied" : `not a suggestion (${c.status})` });
      continue;
    }
    const why = applyRow(s, set, c, now);
    if (why) {
      c.note = leftNote(c.note, "apply", why);
      result.left.push({ id: c.id, why });
    } else {
      c.status = "applied";
      c.appliedBy = "user";
      c.resolvedAt = now;
      result.applied.push(c.id);
    }
  }
  if (result.applied.length) event(s, now, "user", "control", `Applied ${result.applied.length} of the lead's suggestion(s) (${set.id})${result.left.length ? `; ${result.left.length} left as is` : ""}`);
  return { state: s, result };
}

/** Dismiss one suggestion, or every suggestion of a reply. The lead sees dismissed rows in its next envelope. */
export function dismissSteering(state: State, changeSetId: string, changeId: string | undefined, now: string): { state: State; result: { dismissed: string[] } } {
  const s = draft(state);
  const set = getChangeSet(s, changeSetId);
  const rows = changeId ? [getChange(set, changeId)] : set.changes.filter((c) => c.status === "suggested");
  const dismissed: string[] = [];
  for (const c of rows) {
    if (c.status !== "suggested") continue;
    c.status = "dismissed";
    c.resolvedAt = now;
    dismissed.push(c.id);
  }
  if (dismissed.length) event(s, now, "user", "control", `Dismissed ${dismissed.length} of the lead's suggestion(s) (${set.id})`);
  return { state: s, result: { dismissed } };
}

/** Suggestions nobody has applied, dismissed or superseded yet. */
export function openSuggestions(s: State): { set: SteeringChangeSet; change: SteeringChange }[] {
  const out: { set: SteeringChangeSet; change: SteeringChange }[] = [];
  for (const set of s.steering) for (const change of set.changes) if (change.status === "suggested") out.push({ set, change });
  return out;
}

/** The lead's applied focus change behind the current vision, when it still stands (for Undo on the banner and the Vision card). */
export function currentFocusChange(s: State): { set: SteeringChangeSet; change: SteeringChange } | undefined {
  const v = currentVision(s);
  const id = v.source?.changeSetId;
  if (v.author !== "lead" || !id) return undefined;
  const set = s.steering.find((x) => x.id === id);
  const change = set?.changes.find((c) => c.kind === "focus" && c.status === "applied" && c.visionRev === v.rev);
  return set && change ? { set, change } : undefined;
}

export type PriorityProvenance = { kind: "user" } | { kind: "lead"; was: number; changeSetId: string; changeId: string } | { kind: "auto" } | { kind: "child"; rootId: string; priority: number };

/** Who set a task's priority: you (pinned), the lead (while its value still holds), nobody (auto), or its root for a child. */
export function priorityProvenance(s: State, t: Task): PriorityProvenance {
  if (t.parentTaskId && !t.userSet?.priority) {
    const root = rootOf(s, t);
    return { kind: "child", rootId: root.id, priority: root.priority };
  }
  if (t.userSet?.priority) return { kind: "user" };
  for (let i = s.steering.length - 1; i >= 0; i--) {
    const set = s.steering[i];
    for (let j = set.changes.length - 1; j >= 0; j--) {
      const c = set.changes[j];
      if (c.kind !== "priority" || c.taskId !== t.id || c.appliedBy !== "lead" || (c.status !== "applied" && c.status !== "undone")) continue;
      return c.status === "applied" && c.after === t.priority ? { kind: "lead", was: Number(c.before), changeSetId: set.id, changeId: c.id } : { kind: "auto" };
    }
  }
  return { kind: "auto" };
}

export type MessageStatusKind = "answered" | "working" | "restarting" | "stopping-planning" | "queued-behind-reply" | "project-paused" | "blocked" | "retry-wait" | "starting";

/**
 * Where a user message stands, derived only from state. It never assumes a message reached a running
 * lead: a message posted during a run is pending until a run that lists it completes.
 */
export function messageStatus(s: State, m: Message, opts: { blocked?: string; nowMs: number }): { kind: MessageStatusKind; text: string } {
  if (m.author !== "user") return { kind: "answered", text: "" };
  if (s.leadRuns.some((r) => r.outcome === "completed" && r.messageIds.includes(m.id))) return { kind: "answered", text: "Answered" };
  const active = activeLeadRun(s);
  const failure = active?.note?.startsWith("Control failure") ? ` ${active.note}` : "";
  // Review finding 9: a lead run stopping under a project pause is stopping because of the pause, not to
  // answer anything. The pause is checked first, and the stop texts below name no reason for the stop.
  if (s.project.hold) return { kind: "project-paused", text: `Project paused; ${active?.outcome === "stopping" ? "the lead run is stopping and " : ""}the lead answers after you resume.${failure}` };
  if (active?.outcome === "running" && active.messageIds.includes(m.id)) return { kind: "working", text: "The lead is working on this…" };
  if (active?.outcome === "stopping" && active.messageIds.includes(m.id)) return { kind: "restarting", text: `The current reply is stopping; the next lead run answers this together with your newer message.${failure}` };
  if (active?.outcome === "stopping") {
    if (active.messageIds.length === 0) return { kind: "stopping-planning", text: `The planning run is stopping; the next lead run answers you.${failure}` };
    return { kind: "restarting", text: `The current reply is stopping; the next lead run answers this too.${failure}` };
  }
  if (active?.outcome === "running") return { kind: "queued-behind-reply", text: "Queued behind the current reply." };
  if (opts.blocked) return { kind: "blocked", text: `The lead can't run: ${opts.blocked}` };
  let streak = 0;
  for (let i = s.leadRuns.length - 1; i >= 0 && (s.leadRuns[i].outcome === "failed" || s.leadRuns[i].outcome === "lost"); i--) streak++;
  if (streak) {
    const last = s.leadRuns[s.leadRuns.length - 1];
    const lastEnd = last.endedAt ?? last.startedAt;
    const newMessage = s.conversation.some((x) => x.author === "user" && x.at > lastEnd);
    if (!newMessage) {
      if (streak >= 3) return { kind: "retry-wait", text: `The lead failed ${streak} times in a row; send a new message to retry.` };
      const remaining = Math.min(60, 2 ** (streak - 1)) * 60_000 - (opts.nowMs - Date.parse(lastEnd));
      if (remaining > 0) return { kind: "retry-wait", text: `The last lead run ${last.outcome === "lost" ? "was lost" : "failed"}; retrying in about ${Math.max(1, Math.ceil(remaining / 60_000))} min.` };
    }
  }
  return { kind: "starting", text: "Waiting for the lead to start…" };
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

// ---------- ORC-012: shaping the vision with the lead first ----------
//
// A project is shaping or building. While shaping, the lead answers messages and may draft the vision
// and propose a first roadmap, but no worker step is dispatched and no planning run starts. A draft is
// a suggestion: the vision changes only when the user accepts it. Start building needs a vision and
// releases the roadmap on Autopilot; going back to shaping stops nothing that is running.

export const MAX_VISION_TEXT = 8000;
export const MAX_VISION_FOCUS = 300;
const MAX_VISION_DRAFTS = 50;

/** The one line shown wherever new work would otherwise be expected to start. Never "Paused". */
export const SHAPING_LABEL = "Shaping: new work waits until you start building";

/** Why Start building is refused, or undefined when it is allowed. */
export function startBuildingBlocker(s: State): string | undefined {
  if (s.project.stage === "building") return "Already building.";
  if (!currentVision(s).text.trim()) return "Write or accept a vision first.";
  return undefined;
}

/** Roadmap proposals made while shaping that have not started yet, in board order. */
export function roadmapTasks(s: State): Task[] {
  return s.tasks.filter((t) => t.fromShaping && (t.lifecycle === "proposed" || t.lifecycle === "ready")).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/** The draft the user has not yet accepted or dismissed (at most one: a newer draft supersedes it). */
export function openVisionDraft(s: State): VisionDraft | undefined {
  for (let i = s.visionDrafts.length - 1; i >= 0; i--) if (s.visionDrafts[i].status === "open") return s.visionDrafts[i];
  return undefined;
}

/**
 * ORC-014 review 11: what Start building would do now. It uses the involvement setting at the moment it
 * runs, never one recorded earlier, and lifts only the roadmap's own hold: `roadmap` are the planned
 * tasks it releases or hands to the user's release; `userHeld` are planned tasks whose hold the user
 * took over, which keep waiting for the user either way.
 */
export function startBuildingPlan(s: State): { release: boolean; roadmap: Task[]; userHeld: Task[] } {
  const a = s.project.autonomy;
  const open = roadmapTasks(s);
  return { release: a.enabled && !a.holdLeadProposals, roadmap: open.filter((t) => t.heldForShaping), userHeld: open.filter((t) => !t.heldForShaping && t.holdBeforeStart) };
}

/**
 * Start building. Refused without a vision. On Autopilot (autonomy on and lead proposals not held) the
 * roadmap starts; with check-in or "only when I ask" it keeps waiting for the user, as lead proposals do.
 */
export function startBuilding(state: State, now: string): State {
  const why = startBuildingBlocker(state);
  if (why) throw new ControlError(why);
  const s = draft(state);
  s.project.stage = "building";
  const { release } = startBuildingPlan(s);
  const released: string[] = [];
  // Review 2: only the roadmap's own hold is lifted. A task the user held before start (which took it
  // out of the roadmap hold) keeps that hold; the involvement setting decides the rest.
  for (const t of s.tasks) {
    if (!t.heldForShaping) continue;
    delete t.heldForShaping;
    if (t.lifecycle !== "proposed" && t.lifecycle !== "ready") continue;
    t.holdBeforeStart = !release;
    touch(t, now);
    if (release) {
      released.push(t.id);
      event(s, now, "user", "control", "Released from the roadmap: building started on Autopilot", t.id);
    } else event(s, now, "user", "control", "Building started; this planned task waits for your release (your involvement setting)", t.id);
  }
  const waiting = roadmapTasks(s).filter((t) => t.holdBeforeStart).length;
  event(s, now, "user", "config", `Building started${released.length ? `; roadmap released: ${released.join(", ")}` : waiting ? `; ${waiting} planned task(s) wait for your release` : ""}`);
  return s;
}

/** Back to shaping: nothing running is stopped and nothing new starts. Available at any time. */
export function startShaping(state: State, now: string): State {
  if (state.project.stage === "shaping") throw new ControlError("Already shaping.");
  const s = draft(state);
  s.project.stage = "shaping";
  // Review 8: a new shaping session; coverage the lead reported in an earlier one is not reused.
  s.project.shapingSince = now;
  const running = activeAttempts(s).length;
  event(s, now, "user", "config", `Shaping the vision; new work waits until you start building${running ? ` (${running} running step(s) finish normally)` : ""}`);
  return s;
}

/** Control characters other than tab and newline, and invisible characters (review 5), removed from every text the lead drafts. */
const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
const cleanText = (x: string) => visibleOrEmpty(stripInvisible(x.replace(CONTROL_G, "")).replace(/\r\n?/g, "\n").trim());
const cleanLine = (x: string) => oneLine(x.replace(CONTROL_G, ""));
/** ORC-014 review 3: text the user typed is never altered beyond newline normalization and trimming; joiners and marks stay. */
const userText = (x: string) => x.replace(/\r\n?/g, "\n").trim();
const userLine = (x: string) => x.replace(/\s+/g, " ").trim();

export type ValidatedVisionDraft = { ok: true; draft: { text: string; focus: string; reason: string } } | { ok: false; why: string };

/**
 * Strict validation of the lead's vision draft (untrusted data). Only runs that answer the user's
 * messages may draft. The text keeps its newlines; the focus is one line; both are capped and cleaned.
 * A draft identical to the current vision is refused as nothing to decide.
 */
export function validateVisionDraft(s: State, r: LeadRun, vision: unknown): ValidatedVisionDraft {
  if (r.messageIds.length === 0) return { ok: false, why: "planning runs cannot draft the vision" };
  if (!vision || typeof vision !== "object" || Array.isArray(vision)) return { ok: false, why: "the draft was not an object" };
  const v = vision as Record<string, unknown>;
  if (typeof v.text !== "string") return { ok: false, why: "the draft needs a text" };
  if (v.text.length > MAX_VISION_TEXT * 2) return { ok: false, why: `the text is over ${MAX_VISION_TEXT} characters` };
  const text = cleanText(v.text);
  if (!text) return { ok: false, why: "the text is empty" };
  if (text.length > MAX_VISION_TEXT) return { ok: false, why: `the text is over ${MAX_VISION_TEXT} characters` };
  const cur = currentVision(s);
  let focus = cur.focus;
  if (v.focus !== undefined && v.focus !== null) {
    if (typeof v.focus !== "string") return { ok: false, why: "the focus must be text" };
    focus = cleanLine(v.focus);
    if (focus.length > MAX_VISION_FOCUS) return { ok: false, why: `the focus is over ${MAX_VISION_FOCUS} characters` };
  }
  let reason = "Drafted from your messages";
  if (v.reason !== undefined && v.reason !== null) {
    if (typeof v.reason !== "string") return { ok: false, why: "the reason must be text" };
    reason = cleanLine(v.reason).slice(0, 500) || reason;
  }
  if (text === cur.text.trim() && focus === oneLine(cur.focus)) return { ok: false, why: "the draft is the same as the current vision" };
  return { ok: true, draft: { text, focus, reason } };
}

/** Record a validated draft as an open suggestion; an older open draft is superseded. Nothing is applied. */
function draftFromRun(s: State, r: LeadRun, d: { text: string; focus: string; reason: string }, now: string): VisionDraft {
  for (const old of s.visionDrafts) {
    if (old.status !== "open") continue;
    old.status = "superseded";
    old.resolvedAt = now;
  }
  // ORC-012 review 3: the revision the run saw, not the one current at completion, so a vision that moved
  // meanwhile is shown as moved and Accept never silently replaces it.
  const draft: VisionDraft = { id: `vd-${r.id}`, at: now, leadRunId: r.id, messageIds: [...r.messageIds], text: d.text, focus: d.focus, reason: d.reason, basedOnVisionRev: r.visionRev ?? currentVision(s).rev, status: "open" };
  s.visionDrafts.push(draft);
  if (s.visionDrafts.length > MAX_VISION_DRAFTS) s.visionDrafts.splice(0, s.visionDrafts.length - MAX_VISION_DRAFTS);
  event(s, now, "lead", "vision", `Lead run ${r.id} drafted the vision (${draft.id}) from your message ${r.messageIds.join(", ")}: ${d.reason}. It waits for you to accept, edit or dismiss it.`);
  return draft;
}

export const MAX_QUESTIONS = 5;
export const MAX_QUESTION_LENGTH = 300;
export const MAX_QUESTION_WHY = 200;
export const MAX_QUESTION_OPTIONS = 4;
export const MAX_OPTION_LENGTH = 120;

const isArea = (v: unknown): v is ShapingArea => typeof v === "string" && (SHAPING_AREAS as string[]).includes(v);
const isCoverageState = (v: unknown): v is CoverageState => typeof v === "string" && (COVERAGE_STATES as string[]).includes(v);

/**
 * Strict validation of the lead's coverage block: only the known areas and states are kept; everything
 * else is ignored with a note. Only runs that answer the user may report coverage.
 */
export function validateCoverage(r: LeadRun, raw: unknown): { ok: true; coverage: Coverage; notes: string[] } | { ok: false; notes: string[] } {
  if (r.messageIds.length === 0) return { ok: false, notes: ["planning runs cannot report coverage"] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, notes: ["the coverage block was not an object"] };
  const notes: string[] = [];
  const coverage: Coverage = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isArea(k)) {
      notes.push(`unknown area "${cleanLine(k).slice(0, 40)}" ignored`);
      continue;
    }
    if (!isCoverageState(v)) {
      notes.push(`${k}: "${typeof v === "string" ? cleanLine(v).slice(0, 40) : typeof v}" is not clear, partial or open; ignored`);
      continue;
    }
    coverage[k] = v;
  }
  return { ok: true, coverage, notes };
}


/**
 * Strict validation of the lead's questions: at most 5, each at most 300 characters with a reason of at
 * most 200 and at most 4 options of at most 120, control characters removed. An entry over a cap or of the
 * wrong shape is left out with a note; the rest stand. Only runs that answer the user may ask.
 */
export function validateQuestions(r: LeadRun, raw: unknown): { questions: LeadQuestion[]; notes: string[] } {
  if (r.messageIds.length === 0) return { questions: [], notes: ["planning runs cannot ask the user"] };
  if (!Array.isArray(raw)) return { questions: [], notes: ["the questions block was not a list"] };
  const notes: string[] = [];
  const questions: LeadQuestion[] = [];
  const extra = raw.length - MAX_QUESTIONS;
  if (extra > 0) notes.push(`${extra} more ignored: at most ${MAX_QUESTIONS} questions in one reply`);
  raw.slice(0, MAX_QUESTIONS).forEach((entry: unknown, i: number) => {
    const n = `#${i + 1}`;
    const it = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
    if (!it) return notes.push(`${n} ignored: not an object`);
    if (typeof it.question !== "string" || !cleanLine(it.question)) return notes.push(`${n} ignored: the question must be text`);
    const question = cleanLine(it.question);
    if (question.length > MAX_QUESTION_LENGTH) return notes.push(`${n} ignored: the question is over ${MAX_QUESTION_LENGTH} characters`);
    let why = "";
    if (it.why !== undefined && it.why !== null) {
      if (typeof it.why !== "string") return notes.push(`${n} ignored: why must be text`);
      why = cleanLine(it.why);
      if (why.length > MAX_QUESTION_WHY) return notes.push(`${n} ignored: why is over ${MAX_QUESTION_WHY} characters`);
    }
    const q: LeadQuestion = { question, why };
    if (it.area !== undefined && it.area !== null) {
      if (isArea(it.area)) q.area = it.area;
      else notes.push(`${n}: unknown area ignored`);
    }
    if (it.options !== undefined && it.options !== null) {
      if (!Array.isArray(it.options)) notes.push(`${n}: options ignored: not a list`);
      else {
        const more = it.options.length - MAX_QUESTION_OPTIONS;
        if (more > 0) notes.push(`${n}: ${more} more option(s) ignored: at most ${MAX_QUESTION_OPTIONS}`);
        const options: string[] = [];
        for (const o of it.options.slice(0, MAX_QUESTION_OPTIONS)) {
          if (typeof o !== "string" || !cleanLine(o)) {
            notes.push(`${n}: an option was ignored: not text`);
            continue;
          }
          const text = cleanLine(o);
          if (text.length > MAX_OPTION_LENGTH) {
            notes.push(`${n}: an option was ignored: over ${MAX_OPTION_LENGTH} characters`);
            continue;
          }
          // Review 10: the same option twice is one option.
          if (options.includes(text)) {
            notes.push(`${n}: a repeated option was ignored`);
            continue;
          }
          options.push(text);
        }
        if (options.length) q.options = options;
      }
    }
    questions.push(q);
  });
  return { questions, notes };
}

/**
 * The coverage as it stands: from the newest completed run that reported one, with every area it did
 * not name counted as open. Undefined until a run has reported coverage.
 */
export function coverageOf(s: State): Record<ShapingArea, CoverageState> | undefined {
  const since = s.project.shapingSince;
  for (let i = s.leadRuns.length - 1; i >= 0; i--) {
    const r = s.leadRuns[i];
    // Review 8: coverage from an earlier shaping session (before this one began) is not reused.
    if (since && r.startedAt < since) break;
    const c = r.coverage;
    if (r.outcome !== "completed" || !c) continue;
    const out = {} as Record<ShapingArea, CoverageState>;
    for (const a of SHAPING_AREAS) out[a] = c[a] ?? "open";
    return out;
  }
  return undefined;
}

/** Areas still open by the latest coverage; every area while none was reported (review 8). Informational: never a block. */
export function openAreas(s: State): ShapingArea[] {
  const c = coverageOf(s);
  return c ? SHAPING_AREAS.filter((a) => c[a] === "open") : [...SHAPING_AREAS];
}

/** The newest lead questions the user has not written back since (the panel offers inline answers to these). */
export function latestQuestions(s: State): { message: Message; questions: LeadQuestion[] } | undefined {
  for (let i = s.conversation.length - 1; i >= 0; i--) {
    const m = s.conversation[i];
    if (m.author === "user") return undefined;
    if (m.author === "lead") return m.questions?.length ? { message: m, questions: m.questions } : undefined;
  }
  return undefined;
}

/** One user message from the inline answers: each answered question followed by its answer; unanswered ones are skipped. */
export function answersMessage(questions: LeadQuestion[], answers: string[]): string {
  const parts: string[] = [];
  questions.forEach((q, i) => {
    const a = (answers[i] ?? "").trim();
    if (a) parts.push(`Q: ${q.question}\nA: ${a}`);
  });
  return parts.join("\n\n");
}

function getVisionDraft(s: State, draftId: string): VisionDraft {
  const d = s.visionDrafts.find((x) => x.id === draftId);
  if (!d) throw new ControlError(`Unknown vision draft ${draftId}`);
  return d;
}

/**
 * Accept a draft, as drafted or with the user's edits: a user-authored vision revision that records the
 * draft. Compare-and-set on the vision revision, like a hand edit.
 */
export function acceptVisionDraft(state: State, draftId: string, expectedRev: number, edits: { text?: string; focus?: string } | undefined, now: string): State {
  const d = getVisionDraft(state, draftId);
  if (d.status !== "open") throw new ControlError(d.status === "accepted" ? "This draft was already accepted." : d.status === "dismissed" ? "This draft was dismissed." : "A newer draft replaced this one.");
  const cur = currentVision(state);
  if (cur.rev !== expectedRev) throw new StaleWriteError(expectedRev, cur.rev);
  const edited = edits?.text !== undefined || edits?.focus !== undefined;
  const text = edits?.text !== undefined ? userText(edits.text) : d.text;
  const focus = edits?.focus !== undefined ? userLine(edits.focus) : d.focus;
  if (!text) throw new ControlError("The vision cannot be empty.");
  if (text.length > MAX_VISION_TEXT) throw new ControlError(`The vision is limited to ${MAX_VISION_TEXT} characters.`);
  if (focus.length > MAX_VISION_FOCUS) throw new ControlError(`The focus is limited to ${MAX_VISION_FOCUS} characters.`);
  // Review 9: accepting what already stands would record a revision that changes nothing.
  if (text === cur.text.trim() && focus === oneLine(cur.focus)) throw new ControlError("Nothing differs from the current vision; change the text or dismiss the draft.");
  const s = draft(state);
  const draftRec = getVisionDraft(s, draftId);
  const rev = pushVision(
    s,
    { author: "user", text, focus, reason: `${edited ? "Accepted the lead's draft with edits" : "Accepted the lead's draft"} (${d.id}): ${d.reason}`, source: { draftId: d.id, leadRunId: d.leadRunId, messageIds: [...d.messageIds] } },
    now,
    `Vision r${cur.rev + 1} by you: accepted the lead's draft ${d.id}${edited ? " with edits" : ""}`,
  );
  draftRec.status = "accepted";
  draftRec.resolvedAt = now;
  draftRec.visionRev = rev.rev;
  return s;
}

/** Dismiss a draft. The vision is unchanged; the lead sees the dismissal in its next envelope. */
export function dismissVisionDraft(state: State, draftId: string, now: string): State {
  const d = getVisionDraft(state, draftId);
  if (d.status !== "open") throw new ControlError(`This draft is already ${d.status}.`);
  const s = draft(state);
  const rec = getVisionDraft(s, draftId);
  rec.status = "dismissed";
  rec.resolvedAt = now;
  event(s, now, "user", "vision", `Dismissed the lead's vision draft ${d.id}; the vision is unchanged`);
  return s;
}

// ---------- ORC-014: vision documents ----------
//
// Files the user attaches to the vision. The state keeps metadata; the service keeps a copy of each
// file by content hash outside any repository. Attaching or removing one creates a user-authored
// vision revision that records the resulting set, so history says which documents applied when. A
// document is never removed from the registry: an old revision may still refer to it.

export const MAX_VISION_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_VISION_DOCS = 200;
export const MAX_VISION_DOCS_BYTES = 20 * 1024 * 1024;
const MAX_VISION_DOC_PATH = 512;
const HOSTILE_PATH_RE = /[\u0080-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

/** Bytes as people read them: "1.2 KB", "3.4 MB". */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)} KB`;
  return `${n} B`;
}

/**
 * A safe relative path for a document, or why the given one is refused. Separators are normalized to
 * `/`, `.` segments dropped; `..` segments, absolute paths (POSIX, Windows drive or UNC), empty names,
 * control characters and over-long paths are refused. The result never leaves the documents directory
 * when joined under it, because no segment is `..` and none is absolute.
 */
export function visionDocPath(given: string): { ok: true; path: string } | { ok: false; why: string } {
  // ORC-014 review 9: one spelling per name, so the same name in two encodings replaces rather than duplicates.
  const raw = typeof given === "string" ? given.normalize("NFC") : "";
  if (!raw.trim()) return { ok: false, why: "The file needs a name." };
  if (raw.length > MAX_VISION_DOC_PATH) return { ok: false, why: `The path is over ${MAX_VISION_DOC_PATH} characters.` };
  if (CONTROL_RE.test(raw) || raw.includes("\n") || raw.includes("\t")) return { ok: false, why: "The path contains control characters." };
  // Reviews 3 and 8: a name is the user's, so it is refused rather than altered when it carries characters that
  // reorder or hide text (line and paragraph separators, bidi controls, tag characters, other invisible ones).
  if (HOSTILE_PATH_RE.test(raw)) return { ok: false, why: "The name contains invisible or bidirectional control characters." };
  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return { ok: false, why: "Absolute paths are not allowed; attach the file with a relative path." };
  const segments = unified.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (!segments.length) return { ok: false, why: "The file needs a name." };
  if (segments.some((seg) => seg === ".." || /^\.+$/.test(seg))) return { ok: false, why: 'Paths with ".." are not allowed.' };
  if (segments.some((seg) => seg.trim() !== seg)) return { ok: false, why: "A path segment starts or ends with whitespace." };
  return { ok: true, path: segments.join("/") };
}

/** The documents a revision recorded, in the order they were attached; ids no longer in the registry are skipped (never expected). */
export function visionDocsOf(s: State, rev: VisionRevision): VisionDoc[] {
  if (!rev.docIds?.length) return [];
  const byId = new Map(s.project.visionDocs.map((d) => [d.id, d]));
  return rev.docIds.map((id) => byId.get(id)).filter((d): d is VisionDoc => !!d);
}

/** The current document set: what the lead and designers read. */
export function currentVisionDocs(s: State): VisionDoc[] {
  return visionDocsOf(s, currentVision(s));
}

export const visionDocsBytes = (docs: VisionDoc[]) => docs.reduce((n, d) => n + d.size, 0);

/** Files whose text is not extracted yet, so the interface says so when one is attached. */
export function isOfficeDoc(doc: Pick<VisionDoc, "name">): boolean {
  return /\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf|pages|key|numbers)$/i.test(doc.name);
}

export interface VisionDocInput {
  path: string;
  size: number;
  hash: string;
  text: boolean;
}

/** ORC-014 review 9: a staged record whose batch never committed is dropped after this long. */
export const STAGED_DOC_TTL_MS = 60 * 60 * 1000;

/** Documents uploaded but not yet attached (waiting for their batch). */
export function stagedVisionDocs(s: State): VisionDoc[] {
  return s.project.visionDocs.filter((d) => d.stagedAt);
}

/** Drop staged records older than the TTL, except those named: their batch never committed. */
function pruneStaged(s: State, now: string, keep: Set<string> = new Set()) {
  const cutoff = Date.parse(now) - STAGED_DOC_TTL_MS;
  s.project.visionDocs = s.project.visionDocs.filter((d) => !d.stagedAt || keep.has(d.id) || Date.parse(d.stagedAt) >= cutoff);
}

/** A set with more documents applied in order, each replacing the one at its path. */
function withDocs(set: VisionDoc[], more: VisionDoc[]): VisionDoc[] {
  const out = [...set];
  for (const d of more) {
    const i = out.findIndex((x) => x.path === d.path);
    if (i >= 0) out[i] = d;
    else out.push(d);
  }
  return out;
}

/** Why a document on top of `set` would break the project's caps, or undefined. A replacement at an existing path takes that document's place. */
function capReason(set: VisionDoc[], input: { path: string; size: number }): string | undefined {
  const others = set.filter((d) => d.path !== input.path);
  if (others.length + 1 > MAX_VISION_DOCS) return `The vision already has ${MAX_VISION_DOCS} documents; remove one first.`;
  const total = visionDocsBytes(others) + input.size;
  if (total > MAX_VISION_DOCS_BYTES) return `Attaching ${input.path} (${fmtBytes(input.size)}) would bring the documents to ${fmtBytes(total)}; the limit is ${fmtBytes(MAX_VISION_DOCS_BYTES)} per project.`;
  return undefined;
}

/**
 * Why staging this file would be refused, or undefined when it is admitted: the path, the size, the hash,
 * and the caps against the current set with the documents already staged for the next batch applied.
 * The endpoint asks before anything is written; `stageVisionDoc` asks again inside the transaction, and
 * `attachVisionDocs` decides for the batch as a whole. The same file again (same path and content) is
 * admitted: it is reported as unchanged, never as an error.
 */
export function visionDocAdmission(s: State, input: VisionDocInput): string | undefined {
  const p = visionDocPath(input.path);
  if (!p.ok) return p.why;
  if (!Number.isInteger(input.size) || input.size < 0) return "The size must be a whole number of bytes.";
  if (input.size === 0) return "The file is empty.";
  if (input.size > MAX_VISION_DOC_BYTES) return `The file is ${fmtBytes(input.size)}; the limit is ${fmtBytes(MAX_VISION_DOC_BYTES)} per file.`;
  if (!/^[a-f0-9]{64}$/.test(input.hash)) return "The content hash must be a lowercase SHA-256 hex string.";
  const current = currentVisionDocs(s);
  const same = current.find((d) => d.path === p.path);
  if (same && same.hash === input.hash) return undefined;
  return capReason(withDocs(current, stagedVisionDocs(s)), { path: p.path, size: input.size });
}

export interface StagedDoc {
  docId: string;
  /** "unchanged": the same file is attached already (`docId` is that document); nothing to commit. */
  status: "staged" | "unchanged";
  /** The document at the same path this one will replace when its batch commits. */
  replaces?: string;
}

/**
 * ORC-014 review 9: record one uploaded file, without a revision. The endpoint stores the copy once this
 * succeeds; `attachVisionDocs` then attaches the batch as one revision. Staging the same file twice
 * before the commit reuses the record.
 */
export function stageVisionDoc(state: State, input: VisionDocInput, now: string): { state: State; result: StagedDoc } {
  const why = visionDocAdmission(state, input);
  if (why) throw new ControlError(why);
  const path = (visionDocPath(input.path) as { ok: true; path: string }).path;
  const s = draft(state);
  pruneStaged(s, now);
  const current = currentVisionDocs(s);
  const same = current.find((d) => d.path === path);
  if (same && same.hash === input.hash) return { state: s, result: { docId: same.id, status: "unchanged" } };
  const already = stagedVisionDocs(s).find((d) => d.path === path && d.hash === input.hash);
  if (already) return { state: s, result: { docId: already.id, status: "staged", ...(same ? { replaces: same.id } : {}) } };
  const doc: VisionDoc = { id: nextId(s, "doc"), name: path.slice(path.lastIndexOf("/") + 1), path, size: input.size, hash: input.hash, text: input.text, addedAt: now, stagedAt: now };
  s.project.visionDocs.push(doc);
  return { state: s, result: { docId: doc.id, status: "staged", ...(same ? { replaces: same.id } : {}) } };
}

export interface AttachedDoc {
  /** The staged document's id as sent. */
  docId: string;
  path: string;
  /** "unchanged": the same file was attached already (see `attachedAs`); "refused": `why` says what cap it broke. */
  status: "added" | "replaced" | "unchanged" | "refused";
  /** For "unchanged": the document already in the set. */
  attachedAs?: string;
  /** For "replaced": the earlier document at the same path, kept by earlier revisions. */
  replaced?: string;
  why?: string;
}

export interface AttachResult {
  /** The revision created, when at least one document was added or replaced. */
  revision?: number;
  docs: AttachedDoc[];
}

/** Up to three names, then "and N more". */
function nameList(paths: string[]): string {
  const shown = paths.slice(0, 3);
  const more = paths.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/**
 * ORC-014 review 9: attach a batch of staged documents as ONE user-authored vision revision ("Attached N
 * documents"). Files are applied in the order given; each is checked against the caps on top of the ones
 * before it, so a batch that overflows attaches what fits and reports the rest by name. A file whose
 * path and content are attached already is reported unchanged. The revision records the whole resulting
 * set (one list per revision: linear in the number of documents, and every revision stays self-contained).
 */
export function attachVisionDocs(state: State, docIds: string[], batchId: string | undefined, now: string): { state: State; result: AttachResult } {
  const ids = [...new Set(docIds)];
  if (!ids.length) throw new ControlError("Nothing to attach: the batch names no documents.");
  for (const id of ids) if (!state.project.visionDocs.some((x) => x.id === id)) throw new ControlError(`Unknown document ${id}.`);
  const s = draft(state);
  const cur = currentVision(s);
  let set = visionDocsOf(s, cur);
  const rows: AttachedDoc[] = [];
  const added: VisionDoc[] = [];
  const removed: string[] = [];
  const drop = new Set<string>();
  const all = ids.map((id) => s.project.visionDocs.find((x) => x.id === id)!);
  const batch = all.filter((d) => d.stagedAt);
  // Two clients uploading the same file share one staged record: the second commit finds it attached
  // already and reports it unchanged; one attached and replaced or removed since must be uploaded again.
  for (const d of all) {
    if (d.stagedAt) continue;
    if (set.some((x) => x.id === d.id)) rows.push({ docId: d.id, path: d.path, status: "unchanged", attachedAs: d.id });
    else rows.push({ docId: d.id, path: d.path, status: "refused", why: "it was attached earlier and has since been replaced or removed; attach it again" });
  }
  for (const d of batch) {
    const later = batch.find((x) => x !== d && x.path === d.path && batch.indexOf(x) > batch.indexOf(d));
    if (later) {
      rows.push({ docId: d.id, path: d.path, status: "refused", why: `a later file in the same batch has the same path (${later.id})` });
      drop.add(d.id);
      continue;
    }
    const same = set.find((x) => x.path === d.path);
    if (same && same.hash === d.hash) {
      rows.push({ docId: d.id, path: d.path, status: "unchanged", attachedAs: same.id });
      drop.add(d.id);
      continue;
    }
    const why = capReason(set, d);
    if (why) {
      rows.push({ docId: d.id, path: d.path, status: "refused", why });
      drop.add(d.id);
      continue;
    }
    delete d.stagedAt;
    d.addedAt = now;
    set = withDocs(set, [d]);
    added.push(d);
    if (same) {
      removed.push(same.id);
      rows.push({ docId: d.id, path: d.path, status: "replaced", replaced: same.id });
    } else rows.push({ docId: d.id, path: d.path, status: "added" });
  }
  s.project.visionDocs = s.project.visionDocs.filter((d) => !drop.has(d.id));
  pruneStaged(s, now, new Set(ids));
  if (!added.length) return { state: s, result: { docs: rows } };
  const docIdsNow = set.map((d) => d.id);
  const n = added.length;
  const unreadable = added.filter((d) => !d.text).length;
  const reason = `Attached ${n} document${n === 1 ? "" : "s"}: ${nameList(added.map((d) => d.path))}${removed.length ? ` (${removed.length} replaced ${removed.length === 1 ? "an earlier copy" : "earlier copies"})` : ""}${unreadable ? ` (${unreadable} not readable as text; the lead sees ${unreadable === 1 ? "its name" : "their names"} only)` : ""}`;
  const rev = pushVision(
    s,
    { author: "user", text: cur.text, focus: cur.focus, reason, source: { docsAdded: added.map((d) => d.id), ...(removed.length ? { docsRemoved: removed } : {}), ...(batchId ? { batchId } : {}) }, docIds: docIdsNow },
    now,
    `Vision r${cur.rev + 1}: attached ${n} document${n === 1 ? "" : "s"} (${docIdsNow.length} in total, ${fmtBytes(visionDocsBytes(set))})`,
  );
  return { state: s, result: { revision: rev.rev, docs: rows } };
}

/**
 * Stage and attach one document in one step (tests and single-file callers). A file at a path already
 * in the set replaces the older one in the current set only; the same file again is refused as
 * already attached.
 */
export function addVisionDoc(state: State, input: VisionDocInput, now: string): { state: State; docId: string; replaced?: string } {
  const staged = stageVisionDoc(state, input, now);
  if (staged.result.status === "unchanged") throw new ControlError(`${(visionDocPath(input.path) as { ok: true; path: string }).path} is already attached (the same content).`);
  const r = attachVisionDocs(staged.state, [staged.result.docId], undefined, now);
  const row = r.result.docs[0];
  if (row.status === "refused") throw new ControlError(row.why ?? "Refused.");
  return { state: r.state, docId: row.docId, ...(row.replaced ? { replaced: row.replaced } : {}) };
}

/** Remove a document from the current set. Its record and stored copy stay: earlier revisions refer to them. */
export function removeVisionDoc(state: State, docId: string, now: string): State {
  const doc = state.project.visionDocs.find((d) => d.id === docId);
  if (!doc) throw new ControlError(`Unknown document ${docId}.`);
  const cur = currentVision(state);
  if (!cur.docIds?.includes(docId)) throw new ControlError(`${doc.path} is not attached to the current vision (r${cur.rev}).`);
  const s = draft(state);
  const docIds = cur.docIds.filter((id) => id !== docId);
  pushVision(s, { author: "user", text: cur.text, focus: cur.focus, reason: `Removed ${doc.path}`, source: { docRemoved: doc.id }, docIds }, now, `Vision r${cur.rev + 1}: removed ${doc.path} (${docIds.length} document${docIds.length === 1 ? "" : "s"} left; earlier revisions keep it)`);
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
        : result.message
          ? `Not delivered: ${result.message}`
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
  // ORC-012 review 1: no delivery work starts while shaping.
  if (!s.project.autonomy.autoDeliver.enabled || !d?.pending || s.project.hold || s.project.stage === "shaping") return false;
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
    // A fix pushed onto another task's pull request is delivered there, never by local delivery.
    if (i?.status !== "integrated" || i.pr || t.deliverInto || i.delivered?.status === "delivered") continue;
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
  const next = setAutonomy(
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
  // ORC-013: on Autopilot the lead decides ask-user findings, so work does not wait for a person. It
  // never turns checks on or changes the sandbox.
  return F.setTriageRouting(next, "lead", now);
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

Generated by Orchestrator on ${new Date().toISOString()}. Exported for visibility; edit tasks in Orchestrator.

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
    // ORC-016: imported tasks run the project default pattern.
    const pattern = effectiveDefault(s);
    const defs = structuredClone(pattern.steps).map(toDef);
    const ref = patternRef(pattern, "default");
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
      pipelineHistory: [{ rev: 1, at: now, author: "user", reason: `Imported; created from the ${pattern.name} pattern`, steps: defs, pattern: ref }],
      pattern: ref,
      patternSince: 1,
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
  // ORC-013: structured findings are decided one by one; the summary can still be edited and the findings carry over.
  if (base.kind === "review-findings" && base.findings && change.openFindings !== undefined) throw new ControlError("These findings are listed one by one: decide each finding instead of editing the open count.");
  if (base.kind === "review-findings" && !base.findings && (!Number.isInteger(change.openFindings) || change.openFindings! < 0)) throw new ControlError("Review findings need a number of open findings.");
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
    ...(base.kind === "review-findings" && !base.findings ? { openFindings: change.openFindings } : {}),
    ...(base.kind === "review-findings" && base.findings ? { openFindings: base.openFindings, findings: structuredClone(base.findings) } : {}),
    ...(base.kind === "review-findings" && base.pathCoverage ? { pathCoverage: structuredClone(base.pathCoverage) } : {}),
    ...(base.kind === "check-results" && base.checkRun ? { checkRun: structuredClone(base.checkRun), ...(base.findings ? { findings: structuredClone(base.findings), openFindings: base.openFindings } : {}) } : {}),
    ...(base.kind === "breakdown" ? { items: structuredClone(change.items ?? base.items ?? []) } : {}),
    ...(change.ref?.trim() ? { ref: change.ref.trim() } : base.ref ? { ref: base.ref } : {}),
  };
  s.artifacts.push(art);
  // Review 1 (1): the findings carry over with their decisions, which now belong to the new version (the same
  // findings under a new artifact id); any blocking ask-user finding still without a record gets one, so
  // nothing waits on a record that does not exist.
  if (art.findings) {
    for (const d of s.decisions) if (d.artifactId === base.id) d.artifactId = art.id;
    F.createDecisions(s, t, art, now);
  }
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
        // ORC-016: the item's pattern (templateId is the old name); absent, the child default applies.
        ...(it.patternId !== undefined ? { patternId: it.patternId } : it.templateId !== undefined ? { patternId: it.templateId } : {}),
        priority: typeof it.priority === "number" ? it.priority : t.priority,
      } as unknown as LeadProposal;
      const why = validateProposal(s, p, now, "child");
      if (why) {
        rejected.push(`#${i + 1}: ${why}`);
        continue;
      }
      if (descendants(s, root).filter((x) => x.lifecycle !== "cancelled").length >= MAX_CHILD_TASKS) {
        rejected.push(`#${i + 1}: ${root.id} already has ${MAX_CHILD_TASKS} child tasks, the limit per task`);
        continue;
      }
      let k = childTasks(s, t).length + 1;
      while (s.tasks.some((x) => x.id === `${t.id}.${k}`)) k++;
      const id = proposeTask(s, p, now, holdBeforeStart, `${t.id}.${k}`, false, "breakdown");
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
