// ORC-025 pass 4: the Activity page's words, apart from React. The log stays the service's own record; only what is
// cheap to say plainly changes: who acted, the role names ("Code reviewer", not "code_reviewer"), the kinds of event,
// and the task filter `#/activity?task=WT-001`.

import * as M from "../domain/model";
import type { ActivityEvent, Actor, EventKind, RoleId, State } from "../domain/types";
import { ROLE_LABEL } from "./common";

/** Who acted, in words. "runtime" events are the agents' own reports; "system" is the Orchestrator service. */
export const ACTOR_LABEL: Record<Actor, string> = { user: "You", lead: "Lead", runtime: "Agent", system: "Service" };

/** The kinds of event the Show filter offers, in plain words. */
export const KIND_LABEL: Record<EventKind, string> = {
  decision: "Decisions",
  spec: "Spec changes",
  control: "Pause, resume and other controls",
  dispatch: "Agents started",
  runtime: "Agent reports",
  integration: "Delivery",
  blocked: "Blocked work",
  config: "Settings changes",
  vision: "Vision and focus",
  pipeline: "Step changes",
};
export const KINDS = Object.keys(KIND_LABEL) as EventKind[];

const ROLE_IDS = Object.keys(ROLE_LABEL) as RoleId[];
// The snake_case ids anywhere; the one-word ids only where the log names a role, in parentheses: "Dispatched S1 (coder)".
const SNAKE = new RegExp(`\\b(${ROLE_IDS.filter((r) => r.includes("_")).join("|")})\\b`, "g");
const PAREN = new RegExp(`\\((${ROLE_IDS.join("|")})\\)`, "g");

/** An event's message with role ids in words: "Dispatched S3 (code_reviewer) to Claude" → "Dispatched S3 (Code reviewer) to Claude". */
export function eventText(message: string): string {
  return message.replace(PAREN, (_, r: string) => `(${ROLE_LABEL[r as RoleId]})`).replace(SNAKE, (r) => ROLE_LABEL[r as RoleId]);
}

/** The task filter in the URL: `#/activity?task=WT-001`. */
export function taskFromHash(hash: string): string {
  const q = hash.indexOf("?");
  if (q < 0) return "";
  try {
    return new URLSearchParams(hash.slice(q + 1)).get("task") ?? "";
  } catch {
    return "";
  }
}

export function activityHash(taskId: string): string {
  return taskId ? `#/activity?task=${encodeURIComponent(taskId)}` : "#/activity";
}

/** The events to show, newest first, by task and kind. An empty value means any. */
export function filterEvents(events: ActivityEvent[], taskId: string, kind: EventKind | ""): ActivityEvent[] {
  return events.filter((e) => (!taskId || e.taskId === taskId) && (!kind || e.kind === kind)).reverse();
}

/** The tasks the task filter offers: those that appear in the log, by id, with their titles when they still exist. */
export function taskOptions(state: State): { value: string; label: string }[] {
  const ids = [...new Set(state.events.map((e) => e.taskId).filter((x): x is string => !!x))];
  ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return ids.map((id) => {
    const t = state.tasks.find((x) => x.id === id);
    const title = t ? M.currentSpec(t).content.title : "";
    return { value: id, label: title ? `${id} ${title.length > 48 ? `${title.slice(0, 47)}…` : title}` : id };
  });
}
