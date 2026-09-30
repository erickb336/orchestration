import { useEffect, useState } from "react";
import * as M from "../domain/model";
import { StoreContext, useAppStore, useStore } from "./store";
import { Board } from "./Board";
import { TaskDetail } from "./TaskDetail";
import { Overview } from "./Overview";
import { Activity } from "./Activity";
import { Settings } from "./Settings";

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

export function App() {
  const store = useAppStore();
  return (
    <StoreContext.Provider value={store}>
      <Shell />
    </StoreContext.Provider>
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
  const { sim, setSim, tick, reset, isScheduler } = useStore();
  return (
    <div className="sim-banner" role="note">
      <strong>SIMULATED EXECUTION</strong>
      <span>No agents are running. Tasks and runs are sample data; state is stored in this browser only.</span>
      {!isScheduler && <span>(Simulation clock runs in another open tab.)</span>}
      <span className="spacer" />
      <button onClick={() => setSim({ auto: !sim.auto })} aria-pressed={sim.auto}>
        {sim.auto ? "Pause simulation clock" : "Run simulation clock"}
      </button>
      <button onClick={tick} disabled={sim.auto}>
        Step
      </button>
      <label>
        <span className="sr-only">Simulated stop acknowledgment</span>
        <select value={sim.ackMode} onChange={(e) => setSim({ ackMode: e.target.value as "normal" | "never" })}>
          <option value="normal">Runtime acknowledges stops</option>
          <option value="never">Runtime ignores stops (test failure)</option>
        </select>
      </label>
      <button
        onClick={() => {
          if (confirm("Replace all prototype data with the sample project?")) reset();
        }}
      >
        Reset sample data
      </button>
    </div>
  );
}

function ProjectControl() {
  const { state, apply } = useStore();
  const stopping = M.activeAttempts(state).filter((a) => a.outcome === "stopping").length;
  const running = M.activeAttempts(state).filter((a) => a.outcome === "running").length;
  const status = state.project.hold ? (stopping ? `Pausing — ${stopping} run(s) still stopping` : "Project paused") : `${running} simulated run(s) active`;
  return (
    <div className="right">
      <span className="muted" aria-live="polite">
        {status}
      </span>
      {state.project.hold ? (
        <button className="primary" onClick={() => apply(M.resumeProject)}>
          Resume project
        </button>
      ) : (
        <button className="primary" onClick={() => apply(M.pauseProject)}>
          Pause project
        </button>
      )}
    </div>
  );
}
