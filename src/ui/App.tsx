import { useEffect, useState } from "react";
import * as M from "../domain/model";
import { StoreContext, useServiceContext, useServiceStore, useStore } from "./store";
import { Board } from "./Board";
import { TaskDetail } from "./TaskDetail";
import { Overview } from "./Overview";
import { Activity } from "./Activity";
import { Settings } from "./Settings";
import { relTime } from "./common";

type Route = { page: "overview" | "tasks" | "activity" | "settings" } | { page: "task"; id: string };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "task" && parts[1]) return { page: "task", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "overview" || parts[0] === "activity" || parts[0] === "settings") return { page: parts[0] };
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
        <h1>Orchestration</h1>
        {loadFailed ? (
          <>
            <p>
              The Orchestration service is not running. Start it with <code>npm run dev</code> (development) or <code>npm start</code>.
            </p>
            <button className="primary" onClick={retry}>
              Retry
            </button>
          </>
        ) : (
          <p className="muted">Connecting to the Orchestration service…</p>
        )}
      </section>
    </main>
  );
}

function Shell() {
  const route = useRoute();
  const { notice, setNotice } = useStore();
  const tab = route.page === "task" ? "tasks" : route.page;

  useEffect(() => {
    if (!notice || notice.kind === "stale") return;
    const id = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [notice, setNotice]);

  return (
    <>
      <SimBanner />
      <ConnectionBanner />
      <header className="top">
        <div className="brand">
          Orchestration
          <ProjectName />
        </div>
        <nav className="tabs" aria-label="Main">
          {(["overview", "tasks", "activity", "settings"] as const).map((p) => (
            <a key={p} href={`#/${p}`} aria-current={tab === p ? "page" : undefined}>
              {p[0].toUpperCase() + p.slice(1)}
            </a>
          ))}
        </nav>
        <ProjectControl />
      </header>
      <main>
        {route.page === "overview" && <Overview />}
        {route.page === "tasks" && <Board />}
        {route.page === "task" && <TaskDetail key={route.id} id={route.id} />}
        {route.page === "activity" && <Activity />}
        {route.page === "settings" && <Settings />}
      </main>
      {notice && (
        <div className="toast" role={notice.kind === "info" ? "status" : "alert"}>
          <span>{notice.message}</span>
          <button className="small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

function ProjectName() {
  const { state } = useStore();
  return <small>{state.project.name}</small>;
}

function SimBanner() {
  const { service, setSim, step, reset, disabled } = useStore();
  const { sim } = service;
  return (
    <div className="sim-banner" role="note">
      <strong>SIMULATED EXECUTION</strong>
      <span>Runs come from the service's fake runtime; no agents are running. Tasks and runs are sample data.</span>
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
  const { state, send, disabled } = useStore();
  const stopping = M.activeAttempts(state).filter((a) => a.outcome === "stopping").length;
  const running = M.activeAttempts(state).filter((a) => a.outcome === "running").length;
  const status = state.project.hold ? (stopping ? `Pausing — ${stopping} run(s) still stopping` : "Project paused") : `${running} simulated run(s) active`;
  return (
    <div className="right">
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
    </div>
  );
}
