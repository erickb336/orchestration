import { useCallback, useEffect, useRef, useState } from "react";
import * as M from "../domain/model";
import { PROVIDERS, type Autonomy, type ModelSelection, type RoleId, type Runner, type State, type Task } from "../domain/types";

export const ROLE_LABEL: Record<RoleId, string> = {
  lead: "Lead",
  designer: "Designer",
  pe: "PE",
  coder: "Coder",
  code_reviewer: "Code reviewer",
  security_reviewer: "Security reviewer",
  ux_reviewer: "UX reviewer",
  checks: "Checks",
  evidence: "Evidence",
};

export const COLUMN_LABEL: Record<M.Column, string> = {
  proposed: "Proposed",
  ready: "Ready",
  running: "Running",
  // An agent is reviewing. "Results" is where you look at what landed.
  reviewing: "In review",
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

/** "Claude · model"; a service run (checks) reads "Service · checks". */
export function selectionText(sel: { provider: Runner; model: string }) {
  return `${M.providerLabel(sel.provider)} · ${sel.model}`;
}

/** The four state hues, and neutral for everything else. */
export type Tone = "work" | "you" | "fail" | "done" | "neutral";

/**
 * One shape for every status. A dot in the tone's colour, pulsing only while agents work; a
 * two-bar pause mark instead of the dot for a pause. The label is always text: colour never stands alone.
 */
export function Pill({ tone, paused, pulse, title, children }: { tone: Tone; paused?: boolean; pulse?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <span className={`pill has-mark ${tone}${paused ? " paused" : ""}${pulse && tone === "work" ? " pulse" : ""}`} title={title}>
      {paused ? (
        <svg className="pill-pause" viewBox="0 0 8 9" aria-hidden="true" focusable="false">
          <rect x="0.5" y="0.5" width="2.4" height="8" rx="0.6" fill="currentColor" />
          <rect x="5.1" y="0.5" width="2.4" height="8" rx="0.6" fill="currentColor" />
        </svg>
      ) : (
        <span className="pill-dot" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

/** The tone of a task's state: agents working, failed, done, or neutral (proposed, ready, paused, deferred, cancelled). */
export function taskTone(state: State, task: Task): { tone: Tone; paused: boolean; pulse: boolean } {
  const label = M.stateLabel(state, task);
  const col = M.column(state, task);
  if (label === "Control failure" || col === "blocked") return { tone: "fail", paused: false, pulse: false };
  // Pausing, Stopping and Cancelling: the agent is still working until the runtime acknowledges, so the dot keeps pulsing.
  if (col === "running" || col === "reviewing") return { tone: "work", paused: false, pulse: true };
  if (col === "done") return { tone: "done", paused: false, pulse: false };
  if (col === "paused") return { tone: "neutral", paused: true, pulse: false };
  return { tone: "neutral", paused: false, pulse: false };
}

/**
 * The provider mark. An authored monogram ("C" for Claude, "X" for Codex) in a 14 px rounded square,
 * drawn in the text colour. Never a brand logo. A service run has no mark.
 */
export function ProviderMark({ provider }: { provider: Runner | undefined }) {
  if (provider !== "claude" && provider !== "codex") return null;
  return (
    <svg className="pmark" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" />
      {provider === "claude" ? (
        <path d="M9.6 5.1A2.6 2.6 0 0 0 7.2 4C5.6 4 4.5 5.3 4.5 7s1.1 3 2.7 3a2.6 2.6 0 0 0 2.4-1.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** The fake runtime's lead records `simulated: true` on the vision revisions and steering change sets it writes. */
export const isSimulated = (x: unknown): boolean => !!(x as { simulated?: boolean } | undefined)?.simulated;

/**
 * False until the app's first page is on the screen. A screen that opens with that page came with the page load (a
 * reload, an address typed in), not with a move between screens: it keeps the reader's place (QA36-2).
 */
let pageShown = false;
const PLACE_KEY = "orchestration.place";

/**
 * The shell calls this, with `online` true once the live connection is open. The first effect runs after the effects
 * of the first page's screens, so they see `false`. The browser cannot put a reload back at its place: the page shows
 * only after the service answers, and the "Connecting" banner above it then goes away. So the page keeps its place
 * itself, by address, for this tab, and goes back to it when the banner is gone.
 */
export function usePageShown(online: boolean) {
  useEffect(() => {
    pageShown = true;
    const keep = () => {
      try {
        sessionStorage.setItem(PLACE_KEY, JSON.stringify({ hash: location.hash, y: Math.round(window.scrollY) }));
      } catch {
        // No storage (a private window, blocked site data): the page opens at its top.
      }
    };
    window.addEventListener("pagehide", keep);
    return () => window.removeEventListener("pagehide", keep);
  }, []);
  const placed = useRef(false);
  useEffect(() => {
    if (!online || placed.current) return;
    placed.current = true;
    try {
      const place = JSON.parse(sessionStorage.getItem(PLACE_KEY) ?? "null") as { hash: string; y: number } | null;
      if (place?.hash === location.hash) window.scrollTo(0, place.y);
    } catch {
      // No storage: the page stays where it is.
    }
  }, [online]);
}

/**
 * Put focus on a heading as its screen or panel opens (UX30-1): the reader starts at what it is. Focus moves only from
 * the page itself (the body, where focus falls when the control that caused the move goes away) or from inside the
 * heading's `main`. A server update never takes focus from the lead drawer or a field (R33-1). `top` scrolls the page
 * to its top first, for a screen that replaces another; without it, focus scrolls the heading into view, for a panel
 * that opens inside a page.
 */
export function focusHeading(heading: HTMLElement | null, top: boolean) {
  if (!heading) return;
  const active = document.activeElement;
  if (active && active !== document.body && !(heading.closest("main") ?? document.body).contains(active)) return;
  if (top) window.scrollTo(0, 0);
  heading.tabIndex = -1;
  heading.focus({ preventScroll: top });
}

/**
 * A ref for a screen's heading. When a move between screens opens the screen, the page goes to its top and focus goes
 * to the heading. When the screen opens with the page load, nothing moves.
 */
export function useScreenHeading<T extends HTMLElement = HTMLHeadingElement>() {
  const ref = useRef<T>(null);
  // Read at the first render, so that StrictMode's second run of the effect is not taken for a move.
  const [moved] = useState(() => pageShown);
  useEffect(() => {
    if (moved) focusHeading(ref.current, true);
  }, [moved]);
  return ref;
}

/** True below `query` (phones by default); follows the viewport. */
export function useNarrow(query = "(max-width: 767px)") {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!("matchMedia" in window)) return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
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
