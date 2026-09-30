// Opt-in browser notifications (per browser, only while a page is open). The page compares each new
// state from the service with the previous one and notifies once per new event. Nothing is sent on
// the first load, after a project reset or replacement, or while the preference is off.

import { useEffect, useRef } from "react";
import * as M from "../domain/model";
import type { State } from "../domain/types";
import { PREF_NOTIFY, readPref, writePref } from "./common";
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
 * branch, a step that now waits for a person, a failed lead run, a control failure, an integration
 * conflict, and new lead replies. Pure, so it can be tested without a browser.
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
      out.push({ key: `deliver:${t.id}:${d.status}:${d.message}`, title, body: clip(`${name}: ${d.message}`), taskId: t.id });
    }

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

  const prevRuns = new Map(prev.leadRuns.map((r) => [r.id, r.outcome]));
  for (const r of next.leadRuns) {
    if (r.outcome === "failed" && prevRuns.get(r.id) !== "failed")
      out.push({ key: `leadfail:${r.id}`, title: "Lead run failed", body: clip(r.note ?? "The lead could not respond. Your messages stay pending.") });
  }

  const seen = new Set(prev.conversation.map((m) => m.id));
  for (const m of next.conversation) {
    if (m.author !== "lead" || seen.has(m.id)) continue;
    const proposed = m.proposedTaskIds?.length ?? 0;
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
