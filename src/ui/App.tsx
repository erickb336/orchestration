import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { StoreContext, useServiceContext, useServiceStore, useStore } from "./store";
import { Board } from "./Board";
import { TaskDetail } from "./TaskDetail";
import { Overview } from "./Overview";
import { Activity } from "./Activity";
import { Review } from "./Review";
import { Settings } from "./Settings";
import { PREF_LEAD_SEEN, relTime, usePref } from "./common";
import { LeadDrawer, LeadDrawerContext, type LeadContext } from "./LeadDrawer";
import { useBrowserNotifications } from "./notifications";

type Route = { page: "overview" | "tasks" | "review" | "activity" | "settings" } | { page: "task"; id: string };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "task" && parts[1]) return { page: "task", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "overview" || parts[0] === "review" || parts[0] === "activity" || parts[0] === "settings") return { page: parts[0] };
  return { page: "tasks" };
}

function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** Re-render periodically so relative times stay truthful. */
function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function App() {
  const store = useServiceStore();
  return (
    <StoreContext.Provider value={store}>
      <Gate />
    </StoreContext.Provider>
  );
}

/** Nothing to show until the service has answered once. */
function Gate() {
  const { state, loadFailed, retry } = useServiceContext();
  if (state) return <Shell />;
  return (
    <main>
      <section className="card connect" aria-live="polite">
        <h1>Orchestrator</h1>
        {loadFailed ? (
          <>
            <p>
              The Orchestrator service is not running. Start it with <code>npm run dev</code> (development) or <code>npm start</code>.
            </p>
            <button className="primary" onClick={retry}>
              Retry
            </button>
          </>
        ) : (
          <p className="muted">Connecting to the Orchestrator service…</p>
        )}
      </section>
    </main>
  );
}

function Shell() {
  const route = useRoute();
  const { notice, setNotice } = useStore();
  const tab = route.page === "task" ? "tasks" : route.page;
  useBrowserNotifications();

  // ORC-009: the Lead panel. It stays open across routes; on the Overview the inline conversation is used instead.
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadCtx, setLeadCtx] = useState<LeadContext>({});
  const leadButton = useRef<HTMLButtonElement>(null);
  const onOverview = route.page === "overview";
  const openLead = useCallback(
    (ctx: LeadContext = {}) => {
      setLeadCtx(ctx);
      if (location.hash.replace(/^#\/?/, "").split("/")[0] === "overview") {
        const inline = document.getElementById("lead-inline");
        inline?.scrollIntoView({ block: "start" });
        inline?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        return;
      }
      setLeadOpen(true);
    },
    [],
  );
  const closeLead = useCallback(() => {
    setLeadOpen(false);
    leadButton.current?.focus();
  }, []);
  const clearContext = useCallback(() => setLeadCtx({}), []);
  const leadApi = useMemo(() => ({ open: leadOpen, context: leadCtx, openLead, closeLead, clearContext }), [leadOpen, leadCtx, openLead, closeLead, clearContext]);

  useEffect(() => {
    if (!notice || notice.kind === "stale") return;
    const id = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [notice, setNotice]);

  return (
    <LeadDrawerContext.Provider value={leadApi}>
      <SimBanner />
      <ConnectionBanner />
      <header className="top">
        <div className="brand">
          Orchestrator
          <ProjectName />
        </div>
        <nav className="tabs" aria-label="Main">
          {(["overview", "tasks", "review", "activity", "settings"] as const).map((p) => (
            <a key={p} href={`#/${p}`} aria-current={tab === p ? "page" : undefined}>
              {p[0].toUpperCase() + p.slice(1)}
              {p === "review" && <ReviewBadge />}
            </a>
          ))}
        </nav>
        <div className="right">
          <LeadButton buttonRef={leadButton} open={leadOpen && !onOverview} onClick={() => (leadOpen && !onOverview ? closeLead() : openLead())} />
          <ProjectControl />
        </div>
      </header>
      <main className={leadOpen && !onOverview ? "with-lead" : undefined}>
        {route.page === "overview" && <Overview />}
        {route.page === "tasks" && <Board />}
        {route.page === "task" && <TaskDetail key={route.id} id={route.id} />}
        {route.page === "review" && <Review />}
        {route.page === "activity" && <Activity />}
        {route.page === "settings" && <Settings />}
      </main>
      {leadOpen && !onOverview && <LeadDrawer onClose={closeLead} />}
      {notice && (
        <div className="toast" role={notice.kind === "info" ? "status" : "alert"}>
          <span>{notice.message}</span>
          <button className="small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </LeadDrawerContext.Provider>
  );
}

/** The Lead button: a status dot (working, stopping planning, waiting, blocked) and a badge for unread replies plus open suggestions. */
function LeadButton({ buttonRef, open, onClick }: { buttonRef: React.RefObject<HTMLButtonElement | null>; open: boolean; onClick: () => void }) {
  const { state, service } = useStore();
  const [seenAt] = usePref(PREF_LEAD_SEEN);
  const now = useNow();
  const run = M.activeLeadRun(state);
  const pending = M.pendingMessages(state);
  const status = pending.length ? M.messageStatus(state, pending[pending.length - 1], { blocked: service.leadBlocked, nowMs: now }) : undefined;
  const unread = state.conversation.filter((m) => m.author === "lead" && (!seenAt || m.at > seenAt)).length;
  const suggestions = M.openSuggestions(state).length;
  const badge = unread + suggestions;
  const dot = status?.kind === "blocked" ? "blocked" : status?.kind === "stopping-planning" || status?.kind === "restarting" || run?.outcome === "stopping" ? "paused" : run ? "running" : pending.length ? "waiting" : undefined;
  const title = status ? (pending.length > 1 ? `${pending.length} messages waiting: ${status.text}` : status.text) : run ? "The lead is working" : "Message the lead";
  const parts = [unread ? `${unread} new repl${unread === 1 ? "y" : "ies"}` : "", suggestions ? `${suggestions} suggestion${suggestions === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  return (
    <button ref={buttonRef} className="lead-btn" onClick={onClick} aria-expanded={open} aria-haspopup="dialog" title={parts ? `${title} · ${parts}` : title}>
      {dot && <span className={`dot ${dot}`} aria-hidden="true" />}
      Lead
      {badge > 0 && (
        <span className="badge-new" aria-label={parts}>
          {badge}
        </span>
      )}
      <span className="sr-only">{title}</span>
    </button>
  );
}

/** What waits in the Review list. Persistent: it does not reset when the page is visited. */
function ReviewBadge() {
  const { state } = useStore();
  const needs = D.needsYou(state);
  const unreviewed = D.unreviewedCount(state);
  if (needs + unreviewed === 0) return null;
  const parts = [needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "", unreviewed ? `${unreviewed} landed, not reviewed` : ""].filter(Boolean).join(" · ");
  return (
    <span className="badge-new" style={{ marginLeft: "0.35rem" }} title={parts} aria-label={parts}>
      {needs + unreviewed}
    </span>
  );
}

function ProjectName() {
  const { state } = useStore();
  return <small>{state.project.name}</small>;
}

function SimBanner() {
  const { state, service, setSim, step, reset, disabled } = useStore();
  const { sim } = service;
  if (service.runtime === "real") {
    return (
      <div className="sim-banner live" role="note">
        <strong>LIVE EXECUTION</strong>
        <span>
          Claude and Codex agents run on this machine in isolated git worktrees and may incur usage costs.{" "}
          {state.project.prDelivery.enabled
            ? `Verified work is pushed to orchestration/* branches on ${state.project.prDelivery.remote} and opened as GitHub pull requests under your account; ${state.project.prDelivery.merge === "auto" ? "the app merges them itself after an independent review and passing required checks" : "you merge them"}.`
            : state.project.autonomy.autoDeliver.enabled
              ? `Verified work is delivered to ${state.project.autonomy.autoDeliver.branch} automatically (fast-forward only).`
              : "Results stay on orchestration/* branches until you merge them."}
        </span>
        {service.scheduler === "observer" && <span>(another service instance holds the scheduler)</span>}
      </div>
    );
  }
  return (
    <div className="sim-banner" role="note">
      <strong>SIMULATED EXECUTION</strong>
      <span>
        Runs come from the service's fake runtime; no agents are running. Tasks and runs are sample data.
        {state.project.prDelivery.enabled ? " Pull requests, checks and merges are simulated: nothing is sent to GitHub." : ""}
      </span>
      {service.scheduler === "observer" && <span>(another service instance holds the scheduler)</span>}
      <span className="spacer" />
      <button onClick={() => void setSim({ auto: !sim.auto })} aria-pressed={sim.auto} disabled={disabled}>
        {sim.auto ? "Pause simulation clock" : "Run simulation clock"}
      </button>
      <button onClick={() => void step()} disabled={disabled || sim.auto} title={sim.auto ? "Pause the simulation clock to step manually" : undefined}>
        Step
      </button>
      <label>
        <span className="sr-only">Simulated stop acknowledgment</span>
        <select value={sim.ackMode} disabled={disabled} onChange={(e) => void setSim({ ackMode: e.target.value as "normal" | "never" })}>
          <option value="normal">Runtime acknowledges stops</option>
          <option value="never">Runtime ignores stops (test failure)</option>
        </select>
      </label>
      <button
        disabled={disabled}
        onClick={() => {
          if (confirm("Replace all data in the service with the sample project?")) void reset();
        }}
      >
        Reset sample data
      </button>
    </div>
  );
}

function ConnectionBanner() {
  const { status, confirmedAt, retry } = useStore();
  const now = useNow();
  if (status === "online") return null;
  if (status === "connecting")
    return (
      <div className="conn-banner" role="status">
        Connecting to the service… controls are disabled until the live connection opens.
      </div>
    );
  const since = confirmedAt ? relTime(new Date(confirmedAt).toISOString(), now) : "an earlier session";
  return (
    <div className="conn-banner offline" role="alert">
      <strong>Service offline</strong> — showing the last known state from {since}; controls are disabled until it reconnects.
      <button className="small" onClick={retry}>
        Reconnect now
      </button>
    </div>
  );
}

function ProjectControl() {
  const { state, send, disabled, service } = useStore();
  // A stopping lead run counts too: the pause is not confirmed until the lead acknowledges as well.
  const stopping = M.activeAttempts(state).filter((a) => a.outcome === "stopping").length + (M.activeLeadRun(state)?.outcome === "stopping" ? 1 : 0);
  const running = M.activeAttempts(state).filter((a) => a.outcome === "running").length;
  const status = state.project.hold ? (stopping ? `Pausing — ${stopping} run(s) still stopping` : "Project paused") : `${running} ${service.runtime === "real" ? "" : "simulated "}run(s) active`;
  return (
    <>
      <span className="muted" aria-live="polite">
        {status}
      </span>
      {state.project.hold ? (
        <button className="primary" disabled={disabled} onClick={() => void send("resumeProject")}>
          Resume project
        </button>
      ) : (
        <button className="primary" disabled={disabled} onClick={() => void send("pauseProject")}>
          Pause project
        </button>
      )}
    </>
  );
}
