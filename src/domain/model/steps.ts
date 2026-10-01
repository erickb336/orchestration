// Which model runs each step: step pins, task role overrides, project defaults, enabled providers, and the
// limits on runs at once.

import { type ModelSelection, type ProviderId, type RoleId, type State, ControlError } from "../types";
import { activeAttempts, assertOpen, draft, event, getStep, getTask, requestStop, touch } from "./core";
import { setLeadSelection } from "./lead";
import { providerLabel } from "./resolution";

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

export function setProjectDefault(state: State, selection: ModelSelection, now: string): State {
  const s = draft(state);
  s.project.defaultSelection = { ...selection };
  unblockConfigSteps(s);
  event(s, now, "user", "config", `Project default set to ${providerLabel(selection.provider)} · ${selection.model}`);
  return s;
}

export function setProviderLimit(state: State, provider: ProviderId, limit: number, now: string): State {
  if (!Number.isInteger(limit) || limit < 0 || limit > 16) throw new ControlError("Provider limit must be between 0 and 16.");
  const s = draft(state);
  s.project.providerLimits[provider] = limit;
  event(s, now, "user", "config", `${providerLabel(provider)} concurrent runs limited to ${limit}`);
  return s;
}
