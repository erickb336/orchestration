import * as M from "../domain/model";
import { PROVIDERS, type ModelSelection, type ProviderId, type RoleId, type State, type Task } from "../domain/types";

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
  const cls = label === "Control failure" ? "failure" : label === "Pausing" ? "paused" : col;
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
