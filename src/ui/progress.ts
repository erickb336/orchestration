// ORC-017 §3.3: progress by area, derived from task state only. Nothing here is stored. Also the one
// place that says what a task is waiting on the user for (§3.2 "Needs you" badge, §3.4 list), so the
// board, the Overview and the progress rows agree.

import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import type { Runner, State, Step, Task } from "../domain/types";

/** The group for tasks whose spec names no area. */
export const OTHER_AREA = "Other";

export type Bucket = "done" | "work" | "you" | "rest";

export interface NeedsYou {
  /** What waits, in a few words: "merge PR", "choose an option", "decide a finding". */
  what: string;
  /** The one control that opens the right place. */
  action: string;
  href: string;
}

/** The spec's area, trimmed; empty means "Other". */
export function areaOf(task: Task): string {
  return M.currentSpec(task).content.area.trim() || OTHER_AREA;
}

/** Tasks the service made for delivery (dedicated reviews, fixes pushed onto a pull request, check runs) are not the product's work. */
function serviceOwned(t: Task): boolean {
  return !!t.reviewTarget || !!t.deliverInto || !!t.checkTarget;
}

const taskHref = (t: Task) => `#/task/${encodeURIComponent(t.id)}`;

/**
 * What a task waits on the user for, or nothing. Reuses the derivations the Review page and the task page
 * use; the most pressing item wins when several apply.
 */
export function needsYouOf(state: State, task: Task, nowMs = Date.now()): NeedsYou | undefined {
  const href = taskHref(task);
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const i = task.integration;
  const pr = i?.pr;
  if (pr && i?.status === "integrated" && (pr.phase === "built" || pr.phase === "open")) {
    if (pr.attention && !D.openRepair(state, pr)) return { what: "look at the pull request", action: "Open", href };
    if (D.prReady(state, task, nowMs)) return { what: "merge PR", action: "Merge", href: "#/review" };
  }
  if (i?.landed?.status === "unreviewed" && i.landed.flags.length) return { what: "review flagged work", action: "Review", href: "#/review" };
  if (task.controlFailure) return { what: "retry the stop", action: "Open", href };
  if (task.steps.some((st) => st.role === "checks" && st.state === "blocked" && st.blockedReason?.startsWith("Checks failed"))) return { what: "decide on failing checks", action: "Decide", href };
  if (F.openDecisions(state, "user").some((d) => d.taskId === task.id)) return { what: "decide a finding", action: "Decide", href };
  if (open && task.hold && task.holdReason) return { what: "review the step", action: "Open", href };
  if (open && task.holdBeforeStart && task.lifecycle !== "active" && !task.heldForShaping && !task.hold && !M.deferredBy(state, task)) {
    return { what: M.currentSpec(task).content.options.length > 1 ? "choose an option" : "release it", action: "Open", href };
  }
  return undefined;
}

export interface LiveAgent {
  taskId: string;
  title: string;
  provider: Runner;
  /** "implementing", "reviewing", "designing", "verifying", "planning", "running checks", "stopping". */
  verb: string;
  stepId: string;
  purpose: string;
}

function verbOf(step: Step, stopping: boolean): string {
  if (stopping) return "stopping";
  switch (step.role) {
    case "coder":
      return "implementing";
    case "designer":
      return "designing";
    case "code_reviewer":
    case "ux_reviewer":
      return "reviewing";
    case "checks":
      return "running checks";
    case "lead":
      return step.outputs.some((o) => o.kind === "breakdown") ? "planning" : "verifying";
    default:
      return "working on";
  }
}

/** Every agent (or service run) working on a task right now. */
export function liveAgents(state: State, task: Task): LiveAgent[] {
  const title = M.currentSpec(task).content.title;
  return M.activeAttempts(state, task.id).flatMap((a) => {
    const st = task.steps.find((x) => x.id === a.stepId);
    if (!st) return [];
    return [{ taskId: task.id, title, provider: a.snapshot.provider, verb: verbOf(st, a.outcome === "stopping"), stepId: st.id, purpose: st.purpose }];
  });
}

/** "Codex · implementing" (the task title follows it in the row). */
export function liveText(a: LiveAgent): string {
  return `${M.providerLabel(a.provider)} · ${a.verb}`;
}

export interface AreaProgress {
  area: string;
  /** Tasks in the area that were not cancelled. */
  total: number;
  /** Tasks whose pipeline finished. */
  done: number;
  /** Tasks with an agent or service run active. */
  working: number;
  /** Tasks that wait on the user. */
  needsYou: number;
  /** Each task in one bucket, for the bar: needs you, then agents working, then done, then the rest. */
  buckets: Record<Bucket, number>;
  /** The bar's segments in task order (priority, then id). */
  segments: Bucket[];
  live: LiveAgent[];
  /** The newest `updatedAt` among the area's tasks. */
  lastActivity: string;
  /** The counts in words, for the bar's aria-label. */
  label: string;
}

function bucketOf(state: State, task: Task, nowMs: number): Bucket {
  if (needsYouOf(state, task, nowMs)) return "you";
  if (M.activeAttempts(state, task.id).length) return "work";
  if (task.lifecycle === "done") return "done";
  return "rest";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function labelOf(p: Omit<AreaProgress, "label">): string {
  const parts = [`${p.area}: ${p.done} of ${plural(p.total, "task")} done`];
  if (p.working) parts.push(`${p.working} with agents working`);
  if (p.needsYou) parts.push(`${p.needsYou} need${p.needsYou === 1 ? "s" : ""} you`);
  const rest = p.buckets.rest;
  if (rest) parts.push(`${rest} not started`);
  return parts.join(", ");
}

/**
 * One entry per area, in display order: areas with agents working or something that needs you first,
 * then by the most recent activity, then by name. Cancelled tasks and the service's own delivery tasks
 * are left out; tasks with no area are grouped as "Other".
 */
export function progressByArea(state: State, nowMs = Date.now()): AreaProgress[] {
  const groups = new Map<string, Task[]>();
  const tasks = state.tasks.filter((t) => t.lifecycle !== "cancelled" && !serviceOwned(t)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const t of tasks) {
    const area = areaOf(t);
    const list = groups.get(area);
    if (list) list.push(t);
    else groups.set(area, [t]);
  }
  const out: AreaProgress[] = [];
  for (const [area, list] of groups) {
    const buckets: Record<Bucket, number> = { done: 0, work: 0, you: 0, rest: 0 };
    const segments: Bucket[] = [];
    let done = 0;
    let working = 0;
    let needsYou = 0;
    let lastActivity = "";
    const live: LiveAgent[] = [];
    for (const t of list) {
      const b = bucketOf(state, t, nowMs);
      buckets[b]++;
      segments.push(b);
      if (t.lifecycle === "done") done++;
      const agents = liveAgents(state, t);
      if (agents.length) working++;
      live.push(...agents);
      if (needsYouOf(state, t, nowMs)) needsYou++;
      if (t.updatedAt > lastActivity) lastActivity = t.updatedAt;
    }
    const p = { area, total: list.length, done, working, needsYou, buckets, segments, live, lastActivity };
    out.push({ ...p, label: labelOf(p) });
  }
  return out.sort((a, b) => {
    const ka = a.working || a.needsYou ? 0 : 1;
    const kb = b.working || b.needsYou ? 0 : 1;
    if (ka !== kb) return ka - kb;
    if (a.lastActivity !== b.lastActivity) return b.lastActivity.localeCompare(a.lastActivity);
    return a.area.localeCompare(b.area);
  });
}

/** How many agents work right now, for the header: counts every active run, service checks included. */
export function agentsWorking(state: State): number {
  // Agents only: the service's own check runs are not agents and have their own limit.
  return M.activeAgentAttempts(state).filter((a) => a.outcome === "running").length;
}
