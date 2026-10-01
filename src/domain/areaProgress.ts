// Progress by area, for Home: each area's tasks in one bucket each (needs you, agents working, done, or the
// rest), and the agents working right now. Derived from state only; nothing here is stored.

import * as M from "./model";
import { needsYouOf } from "./needsYou";
import type { Runner, State, Step, Task } from "./types";

/** The group for tasks whose spec names no area. */
export const OTHER_AREA = "Other";

export type Bucket = "done" | "work" | "you" | "rest";

/** The spec's area, trimmed; empty means "Other". */
export function areaOf(task: Task): string {
  return M.currentSpec(task).content.area.trim() || OTHER_AREA;
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
    case "security_reviewer":
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

/** Every agent (or service run) working on a task right now; two runs of one provider doing the same thing on one task are listed once. */
export function liveAgents(state: State, task: Task): LiveAgent[] {
  const title = M.currentSpec(task).content.title;
  const seen = new Set<string>();
  return M.activeAttempts(state, task.id).flatMap((a) => {
    const st = task.steps.find((x) => x.id === a.stepId);
    if (!st) return [];
    const verb = verbOf(st, a.outcome === "stopping");
    const key = `${a.snapshot.provider}|${verb}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ taskId: task.id, title, provider: a.snapshot.provider, verb, stepId: st.id, purpose: st.purpose }];
  });
}

export interface AreaProgress {
  area: string;
  /** Tasks in the area that were not cancelled. */
  total: number;
  /** Tasks whose pipeline finished. */
  done: number;
  /** Tasks with an agent or service run active ("in progress"; the header's count is agents only). */
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
  /** The tasks in the "rest" bucket by what they are doing, for the label. */
  restKinds: Record<RestKind, number>;
  /** The counts in words, for the bar's aria-label. */
  label: string;
}

export type RestKind = "paused" | "deferred" | "waiting" | "notStarted";

/** Why a task in the "rest" bucket is not moving: paused by you, deferred, waiting (started, nothing running), or not started. */
function restKindOf(state: State, task: Task): RestKind {
  if (M.column(state, task) === "paused") return "paused";
  if (M.deferredBy(state, task)) return "deferred";
  if (task.lifecycle === "active") return "waiting";
  return "notStarted";
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
  if (p.working) parts.push(`${p.working} in progress`);
  if (p.needsYou) parts.push(`${p.needsYou} need${p.needsYou === 1 ? "s" : ""} you`);
  const k = p.restKinds;
  if (k.paused) parts.push(`${k.paused} paused`);
  if (k.deferred) parts.push(`${k.deferred} deferred`);
  if (k.waiting) parts.push(`${k.waiting} waiting`);
  if (k.notStarted) parts.push(`${k.notStarted} not started`);
  return parts.join(", ");
}

/**
 * One entry per area, in display order: areas with agents working or something that needs you first,
 * then by the most recent activity, then by name. Cancelled tasks and the service's own delivery tasks
 * are left out; tasks with no area are grouped as "Other".
 */
export function progressByArea(state: State, nowMs = Date.now()): AreaProgress[] {
  const groups = new Map<string, Task[]>();
  const tasks = state.tasks.filter((t) => t.lifecycle !== "cancelled" && !M.serviceOwned(t)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const t of tasks) {
    const area = areaOf(t);
    const list = groups.get(area);
    if (list) list.push(t);
    else groups.set(area, [t]);
  }
  const out: AreaProgress[] = [];
  for (const [area, list] of groups) {
    const buckets: Record<Bucket, number> = { done: 0, work: 0, you: 0, rest: 0 };
    const restKinds: Record<RestKind, number> = { paused: 0, deferred: 0, waiting: 0, notStarted: 0 };
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
      if (b === "rest") restKinds[restKindOf(state, t)]++;
      if (t.lifecycle === "done") done++;
      const agents = liveAgents(state, t);
      if (agents.length) working++;
      live.push(...agents);
      if (needsYouOf(state, t, nowMs)) needsYou++;
      if (t.updatedAt > lastActivity) lastActivity = t.updatedAt;
    }
    const p = { area, total: list.length, done, working, needsYou, buckets, segments, live, lastActivity, restKinds };
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
