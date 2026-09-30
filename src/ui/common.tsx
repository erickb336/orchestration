import { useCallback, useEffect, useState } from "react";
import * as M from "../domain/model";
import { PROVIDERS, type Autonomy, type ModelSelection, type ProviderId, type RoleId, type State, type Task } from "../domain/types";

export const ROLE_LABEL: Record<RoleId, string> = {
  lead: "Lead",
  designer: "Designer",
  coder: "Coder",
  code_reviewer: "Code reviewer",
  ux_reviewer: "UX reviewer",
};

export const COLUMN_LABEL: Record<M.Column, string> = {
  proposed: "Proposed",
  ready: "Ready",
  running: "Running",
  reviewing: "Reviewing",
  paused: "Paused",
  deferred: "Deferred",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function selectionText(sel: ModelSelection) {
  return `${M.providerLabel(sel.provider)} · ${sel.model}`;
}

export function StatePill({ state, task }: { state: State; task: Task }) {
  const label = M.stateLabel(state, task);
  const col = M.column(state, task);
  const transitional = label === "Pausing" || label === "Cancelling" || label.startsWith("Stopping");
  const cls = label === "Control failure" ? "failure" : label === "Pausing" ? "paused" : label.includes("deferred after this step") ? "deferred" : col;
  return <span className={`pill ${cls}${transitional ? " transition" : ""}`}>{label}</span>;
}

/** The role/provider currently working, or next up. Shows actual run models, not current defaults. */
export function currentWork(state: State, task: Task): { role: RoleId; provider?: ProviderId; text: string; live: boolean } | null {
  const active = M.activeAttempts(state, task.id);
  if (active.length) {
    const a = active[0];
    const st = task.steps.find((x) => x.id === a.stepId)!;
    return { role: st.role, provider: a.snapshot.provider, text: `${selectionText(a.snapshot)}${active.length > 1 ? ` +${active.length - 1}` : ""}`, live: true };
  }
  if (task.lifecycle === "done" || task.lifecycle === "cancelled") return null;
  const next = task.steps.find((st) => st.state === "pending" || st.state === "paused" || st.state === "blocked");
  if (!next) return null;
  const r = M.resolveStep(state, task, next);
  return { role: next.role, provider: r.ok ? r.selection.provider : undefined, text: r.ok ? `next: ${selectionText(r.selection)}` : "next: unresolved", live: false };
}

export function latestEvent(state: State, taskId: string) {
  for (let i = state.events.length - 1; i >= 0; i--) if (state.events[i].taskId === taskId) return state.events[i];
  return undefined;
}

export function hasNewDecision(state: State, task: Task) {
  return task.decisionAt > state.project.lastVisitAt;
}

const INHERIT = "__inherit__";

/** Provider/model picker. `allowInherit` adds an "Inherited" choice whose resolved value is shown. */
export function ModelPicker({
  state,
  value,
  onChange,
  allowInherit,
  inheritLabel,
  label,
  disabled,
}: {
  state: State;
  value: ModelSelection | null;
  onChange: (v: ModelSelection | null) => void;
  allowInherit?: boolean;
  inheritLabel?: string;
  label: string;
  disabled?: boolean;
}) {
  const enc = (v: ModelSelection | null) => (v ? `${v.provider}::${v.model}` : INHERIT);
  return (
    <select
      aria-label={label}
      disabled={disabled}
      value={enc(value)}
      onChange={(e) => {
        if (e.target.value === INHERIT) return onChange(null);
        const [provider, model] = e.target.value.split("::");
        onChange({ provider: provider as ModelSelection["provider"], model });
      }}
    >
      {allowInherit && <option value={INHERIT}>{inheritLabel ?? "Inherited"}</option>}
      {PROVIDERS.map((p) => (
        <optgroup key={p} label={`${M.providerLabel(p)}${state.project.enabledProviders.includes(p) ? "" : " (disabled)"}`}>
          <option value={`${p}::auto`}>{M.providerLabel(p)} · Auto (lead chooses)</option>
          {state.project.catalog[p].map((m) => (
            <option key={m.id} value={`${p}::${m.id}`}>
              {M.providerLabel(p)} · {m.id}
            </option>
          ))}
        </optgroup>
      ))}
      {value && value.model !== "auto" && !state.project.catalog[value.provider].some((m) => m.id === value.model) && (
        <option value={enc(value)}>{selectionText(value)} (not in catalog)</option>
      )}
    </select>
  );
}

// ---- how involved the user is (derived from autonomy settings) ----

export type Involvement = "autopilot" | "checkin" | "manual" | "custom";

/** `prDelivery`: pull-request delivery is on, which counts as a delivery mode like the local branch. */
export function involvementOf(a: Autonomy, prDelivery = false): Involvement {
  if (!a.enabled) return "manual";
  if (a.holdLeadProposals) return "checkin";
  if (a.autoDeliver.enabled || prDelivery) return "autopilot";
  return "custom";
}

/** Full setAutonomy arguments from the current settings plus a change. */
export function autonomyArgs(a: Autonomy, patch: Partial<Autonomy>): Autonomy {
  return { ...a, ...patch };
}

// ---- per-browser view preferences (storage may be unavailable; never required) ----

export const PREF_ONBOARDING_DISMISSED = "orchestration.onboarding.dismissed";
export const PREF_INVOLVEMENT_CHOSEN = "orchestration.involvement.chosen";
/** ORC-012: the user chose "Start building now" on the Get started list (shaping is recorded in the project itself). */
export const PREF_STAGE_CHOSEN = "orchestration.stage.chosen";
export const PREF_NOTIFY = "orchestration.notify";
/** The `at` of the newest lead reply this browser has shown (the Lead button counts newer ones). */
export const PREF_LEAD_SEEN = "orchestration.lead.seenAt";

/** Fallback when browser storage is blocked: the preference lasts for this page only. */
const memoryPrefs = new Map<string, string | null>();

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryPrefs.get(key) ?? null;
  }
}

export function writePref(key: string, value: string | null) {
  memoryPrefs.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: memoryPrefs keeps it for this page */
  }
  window.dispatchEvent(new CustomEvent("orchestration-pref", { detail: key }));
}

/** A per-browser preference that re-renders when it changes in this tab or another. */
export function usePref(key: string): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState(() => readPref(key));
  useEffect(() => {
    const sync = () => setValue(readPref(key));
    window.addEventListener("orchestration-pref", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("orchestration-pref", sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);
  const set = useCallback(
    (v: string | null) => {
      setValue(v);
      writePref(key, v);
    },
    [key],
  );
  return [value, set];
}

/** What the user confirms before automatic merging continues after the base branch failed. */
export function resumeAutoMergeText(reason?: string): string {
  return [
    "Resume automatic merging?",
    "",
    `It was paused because ${reason ?? "the check on the base branch failed after a merge the app made"}.`,
    "Once you resume, the app merges pull requests by itself again, under your GitHub account, including the ones already open and waiting. Nothing was reverted: if the base branch is still failing, more work lands on top of it.",
    "The count of failures that keeps it paused starts over.",
  ].join("\n");
}
