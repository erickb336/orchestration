// Client of the local Orchestration service (see docs/tasks/ORC-003.md and src/api.ts).
// The service owns state. The UI loads it, follows the change stream, and requests changes as
// named commands. When the service is unreachable the last known state stays visible, marked stale,
// and controls are disabled. Only pure view preferences live in browser storage.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CLIENT_HEADER, type AckMode, type CommandError, type CommandOk, type CommandRequest, type ServiceInfo, type StatePayload } from "../api";
import type { CommandName } from "../domain/commands";
import type { State } from "../domain/types";

export type Notice = { kind: "error" | "stale" | "info"; message: string };
export type ConnectionStatus = "connecting" | "online" | "offline";
export type SendResult = { ok: true; result?: unknown } | { ok: false };

const POST_HEADERS = { "Content-Type": "application/json", [CLIENT_HEADER]: "1" };
const UNREACHABLE = "The Orchestration service is unreachable, so this change was not confirmed. Check the state again once it reconnects.";
const MAX_RECONNECT_DELAY = 10_000;
/** The service sends a ping every 5 s; silence this long means the connection is dead even if it looks open. */
const STREAM_SILENCE_MS = 12_000;

function idempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The service's structured error body, or null when the response is not one (for example a proxy error page). */
async function readError(res: Response): Promise<CommandError | null> {
  try {
    const body = (await res.json()) as Partial<CommandError>;
    return typeof body.error === "string" ? (body as CommandError) : null;
  } catch {
    return null;
  }
}

function isPayload(v: unknown): v is StatePayload {
  const p = v as StatePayload;
  return !!p && typeof p === "object" && typeof p.version === "number" && !!p.state && !!p.service;
}

export function useServiceStore() {
  const [payload, setPayload] = useState<StatePayload | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [loadFailed, setLoadFailed] = useState(false);
  // Last moment the shown state was known to be current: the last payload, or when the connection dropped.
  const [confirmedAt, setConfirmedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [connectNonce, setConnectNonce] = useState(0);
  const current = useRef<StatePayload | null>(null);
  const statusRef = useRef<ConnectionStatus>("connecting");

  const goOnline = useCallback(() => {
    statusRef.current = "online";
    setStatus("online");
  }, []);
  const goOffline = useCallback(() => {
    if (statusRef.current === "online") setConfirmedAt(Date.now());
    statusRef.current = "offline";
    setStatus("offline");
  }, []);

  /** Adopt a payload unless it is older than what we have. A restarted service instance is always adopted. */
  const adopt = useCallback((p: StatePayload) => {
    const cur = current.current;
    if (cur && p.service.startedAt === cur.service.startedAt && p.version < cur.version) return;
    current.current = p;
    setPayload(p);
    setConfirmedAt(Date.now());
    setLoadFailed(false);
  }, []);

  const fetchState = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/state", { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error(`GET /api/state returned ${res.status}`);
      const body: unknown = await res.json();
      if (!isPayload(body)) throw new Error("GET /api/state returned an unexpected body");
      adopt(body);
      return true;
    } catch {
      goOffline();
      return false;
    }
  }, [adopt, goOffline]);

  // Initial load and the change stream. EventSource reconnects by itself after a dropped connection,
  // but gives up for good on an HTTP error (for example the dev proxy's 5xx while the service is down),
  // so a closed stream is reopened here with backoff. Every (re)open re-fetches state.
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: number | undefined;
    let disposed = false;
    let delay = 1000;
    let lastHeard = Date.now();

    const reconnectLater = () => {
      es?.close();
      es = null;
      window.clearTimeout(timer);
      timer = window.setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY);
    };

    const connect = () => {
      if (disposed) return;
      lastHeard = Date.now();
      const source = new EventSource("/api/stream");
      es = source;
      source.addEventListener("open", () => {
        delay = 1000;
        lastHeard = Date.now();
        goOnline();
        void fetchState();
      });
      source.addEventListener("ping", () => {
        lastHeard = Date.now();
        if (statusRef.current !== "online") {
          goOnline();
          void fetchState();
        }
      });
      source.addEventListener("state", (e) => {
        try {
          const p: unknown = JSON.parse((e as MessageEvent<string>).data);
          if (isPayload(p)) {
            lastHeard = Date.now();
            adopt(p);
            goOnline();
          }
        } catch {
          /* ignore a malformed event; the next one or a re-fetch corrects it */
        }
      });
      source.addEventListener("error", () => {
        goOffline();
        if (source.readyState === EventSource.CLOSED && !disposed) reconnectLater();
      });
    };

    // Watchdog: a stream that stays "open" but silent is treated as offline and reopened.
    const watchdog = window.setInterval(() => {
      if (disposed || !es || Date.now() - lastHeard < STREAM_SILENCE_MS) return;
      goOffline();
      reconnectLater();
    }, 2000);

    void fetchState().then((ok) => {
      if (!ok && !disposed && !current.current) setLoadFailed(true);
    });
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(watchdog);
      es?.close();
    };
  }, [connectNonce, adopt, fetchState, goOnline, goOffline]);

  /** Reopen the connection now (Retry buttons). */
  const retry = useCallback(() => {
    setLoadFailed(false);
    if (!current.current) {
      statusRef.current = "connecting";
      setStatus("connecting");
    }
    setConnectNonce((n) => n + 1);
  }, []);

  /**
   * Request a change. Each call is one user intent with its own idempotency key; failures are never
   * retried automatically. On success the state is refreshed before this resolves, so callers that
   * close an editor afterwards show the result right away.
   */
  const send = useCallback(
    async (name: CommandName, args?: object): Promise<SendResult> => {
      const body: CommandRequest = { name, args, idempotencyKey: idempotencyKey() };
      let res: Response;
      try {
        res = await fetch("/api/commands", { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
      } catch {
        goOffline();
        setNotice({ kind: "error", message: UNREACHABLE });
        return { ok: false };
      }
      if (res.ok) {
        let ok: Partial<CommandOk> = {};
        try {
          ok = (await res.json()) as CommandOk;
        } catch {
          /* no body: refresh below */
        }
        if (typeof ok.version !== "number" || (current.current?.version ?? -1) < ok.version) await fetchState();
        return { ok: true, result: ok.result };
      }
      const err = await readError(res);
      if (!err) {
        // Not an answer from the service (for example the dev proxy while the service is down).
        goOffline();
        setNotice({ kind: "error", message: UNREACHABLE });
        return { ok: false };
      }
      setNotice({ kind: res.status === 409 || err.kind === "stale" ? "stale" : "error", message: err.error });
      return { ok: false };
    },
    [fetchState, goOffline],
  );

  const postSim = useCallback(
    async (path: string, body: object): Promise<boolean> => {
      let res: Response;
      try {
        res = await fetch(path, { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
      } catch {
        goOffline();
        setNotice({ kind: "error", message: UNREACHABLE });
        return false;
      }
      if (!res.ok) {
        const err = await readError(res);
        if (!err) goOffline();
        setNotice({ kind: "error", message: err ? err.error : UNREACHABLE });
        return false;
      }
      await fetchState();
      return true;
    },
    [fetchState, goOffline],
  );

  const setSim = useCallback((patch: { auto?: boolean; ackMode?: AckMode }) => postSim("/api/sim", patch), [postSim]);
  /** Re-check provider credentials and binaries now (never starts a model run). */
  const refreshHealth = useCallback(() => postSim("/api/health/refresh", {}), [postSim]);
  const step = useCallback(() => postSim("/api/sim/step", {}), [postSim]);
  const reset = useCallback(async () => {
    const ok = await postSim("/api/sim/reset", {});
    if (ok) setNotice({ kind: "info", message: "Sample data restored." });
    return ok;
  }, [postSim]);

  return {
    state: payload?.state ?? null,
    version: payload?.version ?? null,
    service: payload?.service ?? null,
    status,
    /** True while commands cannot be sent: controls that change state should be disabled. */
    disabled: status !== "online",
    loadFailed,
    confirmedAt,
    retry,
    send,
    setSim,
    refreshHealth,
    step,
    reset,
    notice,
    setNotice,
  };
}

export type ServiceStore = ReturnType<typeof useServiceStore>;
/** The store once the first state has loaded; the Shell only renders then. */
export type Store = ServiceStore & { state: State; version: number; service: ServiceInfo };

export const StoreContext = createContext<ServiceStore | null>(null);

export function useServiceContext(): ServiceStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext missing");
  return s;
}

export function useStore(): Store {
  const s = useServiceContext();
  if (!s.state || !s.service || s.version === null) throw new Error("useStore used before the service state loaded");
  return s as Store;
}

/** The `newId` result of createFollowUp / createFollowUpWithSpec. */
export function newIdOf(r: SendResult): string | null {
  if (!r.ok) return null;
  const id = (r.result as { newId?: unknown } | undefined)?.newId;
  return typeof id === "string" ? id : null;
}
