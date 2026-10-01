// Helpers every delivery module shares.

import { ControlError, type Landed, type State, type Task } from "../types";

export function getTask(s: State, taskId: string): Task {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new ControlError(`Unknown task ${taskId}`);
  return t;
}

export function event(s: State, now: string, actor: "user" | "system", kind: "integration" | "config" | "blocked", message: string, taskId?: string) {
  s.seq += 1;
  s.events.push({ id: `ev-${s.seq}`, at: now, actor, kind, taskId, message });
}

export function getLanded(s: State, taskId: string): { task: Task; landed: Landed } {
  const task = getTask(s, taskId);
  const landed = task.integration?.landed;
  if (!landed) throw new ControlError(`${taskId} has not landed, so it is not in the Review list.`);
  return { task, landed };
}

export const sha12 = (sha: string) => sha.slice(0, 12);

export const GITHUB_URL = /^https:\/\/github\.com\//;
