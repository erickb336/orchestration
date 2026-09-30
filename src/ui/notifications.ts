// Opt-in browser notifications (per browser, only while a page is open). The page compares each new
// state from the service with the previous one and notifies once per new event. Nothing is sent on
// the first load, after a project reset or replacement, or while the preference is off.

import { useEffect, useRef } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { State } from "../domain/types";
import { PREF_NOTIFY, readPref, writePref } from "./common";
import { describeChange, setTitle } from "./steering";
import { useStore } from "./store";

export interface NotifyEvent {
  /** Unique per event: the same key never notifies twice in one page. */
  key: string;
  title: string;
  body: string;
  taskId?: string;
}

/** More events than this in one update collapse into a single summary notification. */
const MAX_INDIVIDUAL = 4;

function taskTitle(s: State, id: string) {
  const t = s.tasks.find((x) => x.id === id);
  return t ? `${id} ${M.currentSpec(t).content.title}` : id;
}

function clip(text: string, n = 180) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/**
 * Events that happened between two states of the same project: task done, delivery to the user's
 * branch, a pull request that is ready for the user or needs them, a pull request merged or closed on
 * GitHub, a GitHub problem, a step that now waits for a person, a failed lead run, a control failure,
 * an integration conflict, and new lead replies. Every key names a transition, never a poll or a
 * retry. Pure, so it can be tested without a browser.
 */
export function detectEvents(prev: State, next: State): NotifyEvent[] {
  if (prev.project.id !== next.project.id) return [];
  const out: NotifyEvent[] = [];
  const prevTasks = new Map(prev.tasks.map((t) => [t.id, t]));
  // A failed run that will be retried automatically does not need a person yet.
  const retrying = new Set(M.autoRetryCandidates(next).map((c) => `${c.taskId}/${c.stepId}`));

  for (const t of next.tasks) {
    const p = prevTasks.get(t.id);
    if (!p) continue; // new tasks are not events on their own (the lead reply announces proposals)
    const name = taskTitle(next, t.id);

    if (t.lifecycle === "done" && p.lifecycle !== "done")
      out.push({ key: `done:${t.id}:${t.updatedAt}`, title: "Task done", body: name, taskId: t.id });

    // Keyed on what changed, never on when it was tried: a retry with the same outcome is not an event.
    const d = t.integration?.delivered;
    const pd = p.integration?.delivered;
    if (d && (d.status !== pd?.status || d.message !== pd?.message)) {
      const title = d.status === "delivered" ? "Work delivered" : d.status === "conflict" ? "Delivery conflict" : "Delivery waiting";
      // `at` moves only when the outcome changes, so an outcome that comes back after a different one notifies again.
      out.push({ key: `deliver:${t.id}:${d.status}:${d.at}:${d.message}`, title, body: clip(`${name}: ${d.message}`), taskId: t.id });
    }

    // Pull requests. Readiness is judged at the time of each state's own observation of GitHub.
    const pr = D.livePr(t);
    const ppr = D.livePr(p);
    if (pr) {
      const n = pr.number ? `PR #${pr.number}` : "Pull request";
      const sim = pr.simulated ? " (simulated)" : "";
      const at = (x: typeof pr) => Date.parse(x.observed?.at ?? next.project.github?.observedAt ?? t.updatedAt);
      if (D.prReady(next, t, at(pr)) && !(ppr && ppr.headSha === pr.headSha && D.prReady(prev, p, at(ppr))))
        out.push({ key: `pr-ready:${t.id}:${pr.headSha}`, title: `${n} is ready for you${sim}`, body: clip(`${name}: required checks passed and the independent review is clean. Merge it in Orchestrator or on GitHub.`), taskId: t.id });
      if (pr.attention && (pr.attention.code !== ppr?.attention?.code || pr.attention.headSha !== ppr?.attention?.headSha)) {
        // While the app's own fix task is working on it, it is news, not a request.
        const fixing = !!D.openRepair(next, pr);
        out.push({ key: `pr-needs-you:${t.id}:${pr.attention.code}:${pr.attention.headSha ?? ""}`, title: fixing ? `${n} is being fixed${sim}` : `${n} needs you${sim}`, body: clip(`${name}: ${pr.attention.message}`), taskId: t.id });
      }
      if (pr.phase === "merged" && ppr?.phase !== "merged") {
        const by = t.integration?.landed?.by === "person" ? ` by ${t.integration.landed.mergedBy ?? "a person"}` : "";
        out.push({ key: `pr-merged:${t.id}:${pr.n}`, title: `${n} merged${by}; review it when you like${sim}`, body: name, taskId: t.id });
      }
      if (pr.phase === "closed" && ppr?.phase !== "closed") out.push({ key: `pr-closed:${t.id}:${pr.n}`, title: `${n} was closed without merging${sim}`, body: name, taskId: t.id });
    }
    const mc = t.integration?.landed?.mainCheck;
    if (mc?.state === "failure" && p.integration?.landed?.mainCheck?.state !== "failure")
      out.push({ key: `main-check:${t.id}:${t.integration!.landed!.commit}`, title: `Check failed on ${t.integration!.landed!.target} after ${t.integration!.landed!.pr ? `PR #${t.integration!.landed!.pr.number}` : "a delivery"}`, body: name, taskId: t.id });

    if (t.integration?.status === "conflict" && p.integration?.status !== "conflict")
      out.push({ key: `conflict:${t.id}:${t.integration.at ?? t.updatedAt}`, title: "Integration conflict", body: clip(`${name}: ${t.integration.message ?? "the change could not be merged"}`), taskId: t.id });

    if (t.controlFailure && t.controlFailure.at !== p.controlFailure?.at)
      out.push({ key: `control:${t.id}:${t.controlFailure.at}`, title: "Control failure", body: clip(`${name}: ${t.controlFailure.message}`), taskId: t.id });

    for (const st of t.steps) {
      if (st.state !== "blocked") continue;
      const before = p.steps.find((x) => x.id === st.id);
      if (before?.state === "blocked" && before.blockedReason === st.blockedReason) continue;
      if (retrying.has(`${t.id}/${st.id}`)) continue;
      const runs = next.attempts.filter((a) => a.taskId === t.id && a.stepId === st.id).length;
      out.push({
        key: `blocked:${t.id}:${st.id}:${runs}:${st.blockedReason ?? ""}`,
        title: st.blockedReason?.startsWith("Last run failed") ? "Run failed" : "Step blocked",
        body: clip(`${name} · ${st.id}: ${st.blockedReason ?? "waiting for you"}`),
        taskId: t.id,
      });
    }
  }

  // ORC-013: a finding newly routed to the user (created for them, sent to them, or suggested by the lead) is one event; polling is not.
  const prevDecisions = new Map((prev.decisions ?? []).map((d) => [d.id, d]));
  for (const d of next.decisions ?? []) {
    if (d.status !== "open" || d.routedTo !== "user") continue;
    const before = prevDecisions.get(d.id);
    if (before && before.status === "open" && before.routedTo === "user" && !!before.suggestion === !!d.suggestion) continue;
    out.push({
      key: `decision:${d.id}:${d.suggestion ? "suggested" : "open"}`,
      title: d.suggestion ? "The lead suggests a fix; yours to decide" : "A finding needs your decision",
      body: clip(`${taskTitle(next, d.taskId)} · ${d.finding.title}${d.finding.why ? ` — ${d.finding.why}` : ""}`),
      taskId: d.taskId,
    });
  }

  // ORC-013: the checks sandbox became unavailable (keyed on that observation, never on polling); check steps wait until it is ready.
  const ch = next.project.checksHealth;
  if (ch?.status === "unavailable" && next.project.checks?.enabled && (prev.project.checksHealth?.status !== "unavailable" || prev.project.checksHealth.checkedAt !== ch.checkedAt) && (prev.project.checksHealth?.status !== "unavailable"))
    out.push({ key: `checks-sandbox:${ch.status}:${ch.checkedAt}`, title: "The checks sandbox is not available", body: clip(`${ch.detail} Check steps wait until it is ready, or until you choose to run without a sandbox (Settings → Checks).`) });

  const paused = next.project.github?.autoMergePaused;
  if (paused && paused.since !== prev.project.github?.autoMergePaused?.since)
    out.push({ key: `auto-merge-paused:${paused.since}`, title: "Automatic merging is paused", body: clip(`${paused.reason}. ${paused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again."}`), ...(paused.taskId ? { taskId: paused.taskId } : {}) });

  const problem = next.project.github?.problem;
  if (problem && (problem.code !== prev.project.github?.problem?.code || problem.since !== prev.project.github?.problem?.since))
    out.push({ key: `github:${problem.code}:${problem.since}`, title: problem.code === "auth" ? "GitHub delivery stopped: sign-in needed" : "GitHub delivery stopped", body: clip(problem.message) });

  const prevRuns = new Map(prev.leadRuns.map((r) => [r.id, r.outcome]));
  for (const r of next.leadRuns) {
    if (r.outcome === "failed" && prevRuns.get(r.id) !== "failed")
      out.push({ key: `leadfail:${r.id}`, title: "Lead run failed", body: clip(r.note ?? "The lead could not respond. Your messages stay pending.") });
  }

  const seen = new Set(prev.conversation.map((m) => m.id));
  for (const m of next.conversation) {
    if (m.author !== "lead" || seen.has(m.id)) continue;
    const proposed = m.proposedTaskIds?.length ?? 0;
    // ORC-009: a reply that steered says what changed instead of the generic "Lead replied".
    const set = m.changeSetId ? next.steering.find((cs) => cs.id === m.changeSetId) : undefined;
    if (set && !set.refused && set.changes.length) {
      const rows = set.changes.filter((c) => c.status === "applied" || c.status === "suggested").slice(0, 3);
      out.push({ key: `steer:${set.id}`, title: setTitle(set), body: clip((rows.length ? rows : set.changes.slice(0, 3)).map(describeChange).join(" · ")) });
      continue;
    }
    out.push({
      key: `msg:${m.id}`,
      title: proposed ? `Lead replied and proposed ${proposed} task${proposed === 1 ? "" : "s"}` : "Lead replied",
      body: clip(m.text),
      taskId: proposed === 1 ? m.proposedTaskIds![0] : undefined,
    });
  }
  return out;
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** On only when this browser opted in and the site may show notifications. */
export function notificationsOn(): boolean {
  return readPref(PREF_NOTIFY) === "1" && notificationsSupported() && Notification.permission === "granted";
}

/** Ask for permission and remember the choice. Returns the resulting permission. */
export async function enableNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  writePref(PREF_NOTIFY, permission === "granted" ? "1" : null);
  return permission;
}

export function disableNotifications() {
  writePref(PREF_NOTIFY, null);
}

function show(e: NotifyEvent) {
  try {
    const n = new Notification(e.title, { body: e.body, tag: e.key });
    n.onclick = () => {
      window.focus();
      if (e.taskId) location.hash = `#/task/${encodeURIComponent(e.taskId)}`;
      else location.hash = "#/overview";
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker; nothing else to do */
  }
}

/** Watch the store and notify for new events while enabled. Mount once, in the app shell. */
export function useBrowserNotifications() {
  const { state } = useStore();
  const prev = useRef<State | null>(null);
  const fired = useRef(new Set<string>());

  useEffect(() => {
    const before = prev.current;
    prev.current = state;
    if (!before || before === state || !notificationsOn()) return;
    const events = detectEvents(before, state).filter((e) => !fired.current.has(e.key));
    for (const e of events) fired.current.add(e.key);
    if (events.length > MAX_INDIVIDUAL) {
      const tasks = new Set(events.map((e) => e.taskId).filter(Boolean));
      show({ key: `batch:${events[0].key}`, title: `${events.length} updates`, body: clip(events.map((e) => e.title).join(" · ")), taskId: tasks.size === 1 ? [...tasks][0] : undefined });
    } else events.forEach(show);
  }, [state]);
}
