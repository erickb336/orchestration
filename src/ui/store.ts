// Prototype state container. Browser localStorage stands in for the Milestone 2 service;
// the UI labels it as such. All changes go through pure domain operations, applied one at a time.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { buildSeed } from "../domain/seed";
import { StaleWriteError, type State } from "../domain/types";
import { DEFAULT_SIM, simulateTick, type SimConfig } from "../runtime/simulated";

const STATE_KEY = "orchestration.prototype.state.v1";
const SIM_KEY = "orchestration.prototype.sim.v1";

let replacedOldData = false;

function loadState(): State {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as State;
      if (parsed.version === 3) return parsed;
      replacedOldData = true;
    }
  } catch {
    /* fall through to seed */
  }
  return buildSeed();
}

/** The latest state any tab has written, or null if storage is unavailable or unreadable. */
function readStored(): State | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as State;
    return parsed.version === 3 ? parsed : null;
  } catch {
    return null;
  }
}

function loadSim(): SimConfig & { auto: boolean } {
  try {
    const raw = localStorage.getItem(SIM_KEY);
    if (raw) return { ...DEFAULT_SIM, auto: true, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SIM, auto: true };
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: prototype keeps working in memory */
  }
}

export type Notice = { kind: "error" | "stale" | "info"; message: string };

export function useAppStore() {
  const [state, setState] = useState<State>(loadState);
  const [sim, setSimState] = useState(loadSim);
  const [notice, setNotice] = useState<Notice | null>(() =>
    replacedOldData ? { kind: "info", message: "Prototype data format changed (pipelines and artifacts), so sample data was restored." } : null,
  );
  const ref = useRef(state);

  const commit = useCallback((next: State) => {
    ref.current = next;
    setState(next);
    save(STATE_KEY, next);
  }, []);

  /**
   * Apply a domain operation to the freshest stored state, so a write from another tab is never
   * overwritten by this tab's older copy. Expected-revision checks inside operations still reject
   * drafts based on older revisions. Returns true on success; errors surface as a notice.
   */
  const apply = useCallback(
    (op: (s: State, now: string) => State): boolean => {
      try {
        commit(op(readStored() ?? ref.current, new Date().toISOString()));
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setNotice({ kind: e instanceof StaleWriteError ? "stale" : "error", message });
        return false;
      }
    },
    [commit],
  );

  const setSim = useCallback((patch: Partial<typeof sim>) => {
    setSimState((prev) => {
      const next = { ...prev, ...patch };
      save(SIM_KEY, { auto: next.auto, ackMode: next.ackMode });
      return next;
    });
  }, []);

  const tick = useCallback(() => apply((s) => simulateTick(s, Date.now(), sim)), [apply, sim]);

  // Only one tab runs the simulated scheduler, mirroring the single project scheduler lease.
  const [isScheduler, setIsScheduler] = useState(() => !("locks" in navigator));
  useEffect(() => {
    if (!("locks" in navigator)) return;
    const release = new AbortController();
    navigator.locks
      .request("orchestration-scheduler", { signal: release.signal }, () => {
        setIsScheduler(true);
        return new Promise<void>((resolve) => release.signal.addEventListener("abort", () => resolve()));
      })
      .catch(() => {
        /* aborted on unmount */
      });
    return () => {
      release.abort();
      setIsScheduler(false);
    };
  }, []);

  useEffect(() => {
    if (!sim.auto || !isScheduler) return;
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [sim.auto, isScheduler, tick]);

  // Another tab changed the stored state: adopt it, so expected-revision checks catch stale drafts.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STATE_KEY || !e.newValue) return;
      try {
        const next = JSON.parse(e.newValue) as State;
        ref.current = next;
        setState(next);
      } catch {
        /* ignore malformed writes */
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Record the visit when the page is hidden, so "since your last visit" means the previous session.
  useEffect(() => {
    const onHide = () => {
      const next = structuredClone(readStored() ?? ref.current);
      next.project.lastVisitAt = new Date().toISOString();
      save(STATE_KEY, next);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const reset = useCallback(() => {
    commit(buildSeed());
    setNotice({ kind: "info", message: "Sample data restored." });
  }, [commit]);

  return { state, apply, sim, setSim, tick, reset, notice, setNotice, isScheduler };
}

export type Store = ReturnType<typeof useAppStore>;
export const StoreContext = createContext<Store | null>(null);
export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext missing");
  return s;
}
