// The lead conversation and lead runs: when the lead is due, starting, stopping and failing a run, where a
// user message stands, and the lead's settings (autonomy, the lead's model, the Autopilot preset).

import { undeliveredTasks } from "../delivery";
import * as F from "../findings";
import {
  type Attempt,
  type Autonomy,
  type LeadRun,
  type LeadTrigger,
  type Message,
  type ModelSelection,
  type ProviderId,
  type State,
  type Task,
  ControlError,
  AUTOPILOT,
} from "../types";
import { currentVision, draft, event, getTask, isOpen, nextId } from "./core";
import { deferredBy } from "./presentation";
import { providerLabel } from "./resolution";

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
function leadTriggerLabel(trigger: LeadTrigger): string {
  return trigger === "planning" ? "planning" : trigger === "decisions" ? "decisions" : "reply";
}

export function requestLeadStop(s: State, r: LeadRun, reason: string, now: string) {
  if (r.outcome !== "running") return;
  r.outcome = "stopping";
  r.stopRequestedAt = now;
  event(s, now, "system", "control", `Stop requested for lead run ${r.id} (${reason}); awaiting runtime acknowledgment`);
}

export function getLeadRun(s: State, id: string): LeadRun | undefined {
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

export function reportLeadStopTimeout(state: State, runId: string, now: string): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (!r || r.outcome !== "stopping" || r.note?.startsWith("Control failure")) return s;
  r.note = "Control failure: the runtime has not acknowledged the stop request.";
  event(s, now, "system", "control", `Control failure: lead run ${r.id} did not acknowledge stop in time`);
  return s;
}

type MessageStatusKind = "answered" | "working" | "restarting" | "stopping-planning" | "queued-behind-reply" | "project-paused" | "blocked" | "retry-wait" | "starting";

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
