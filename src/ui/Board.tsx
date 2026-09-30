import { useMemo, useState } from "react";
import * as M from "../domain/model";
import { PROVIDERS, ROLES, type State, type Task } from "../domain/types";
import { useStore } from "./store";
import { COLUMN_LABEL, ROLE_LABEL, StatePill, currentWork, hasNewDecision, latestEvent, relTime } from "./common";

type View = "list" | "board";
type Sort = "priority" | "activity";

function usePref<T extends string>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* ignore */
    }
  };
  return [v, set] as const;
}

export function Board() {
  const { state, apply } = useStore();
  const [view, setView] = usePref<View>("orchestration.view", "list");
  const [sort, setSort] = usePref<Sort>("orchestration.sort", "priority");
  const [area, setArea] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [provider, setProvider] = useState("");
  const [changed, setChanged] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const areas = useMemo(() => [...new Set(state.tasks.map((t) => M.currentSpec(t).content.area))].sort(), [state.tasks]);

  const filtered = state.tasks
    .filter((t) => {
      const work = currentWork(state, t);
      if (area && M.currentSpec(t).content.area !== area) return false;
      if (status && M.column(state, t) !== status) return false;
      if (role && work?.role !== role) return false;
      if (provider && !involvesProvider(state, t, provider)) return false;
      if (changed && t.updatedAt <= state.project.lastVisitAt) return false;
      return true;
    })
    .sort((a, b) => (sort === "priority" ? a.priority - b.priority : b.updatedAt.localeCompare(a.updatedAt)));

  const byColumn = (c: M.Column) => filtered.filter((t) => M.column(state, t) === c);
  const cancelled = byColumn("cancelled");
  const newCount = state.tasks.filter((t) => hasNewDecision(state, t)).length;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <h1>Tasks</h1>
        {newCount > 0 && (
          <span className="row">
            <span className="muted">{newCount} decision(s) since your last visit.</span>
            <button className="small" onClick={() => apply(M.markVisited)} title="Only updates what counts as new; does not approve or pause anything">
              Mark all seen
            </button>
          </span>
        )}
      </div>
      <div className="toolbar" role="search">
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>
            List
          </button>
          <button aria-pressed={view === "board"} onClick={() => setView("board")}>
            Board
          </button>
        </div>
        <label>
          Area
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">All</option>
            {areas.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {M.BOARD_COLUMNS.map((c) => (
              <option key={c} value={c}>
                {COLUMN_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All</option>
            {ROLES.filter((r) => r !== "lead").map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {M.providerLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={changed} onChange={(e) => setChanged(e.target.checked)} />
          Changed since last visit
        </label>
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="priority">Priority</option>
            <option value="activity">Latest activity</option>
          </select>
        </label>
      </div>

      {filtered.length === 0 && <p className="muted">No tasks match these filters.</p>}

      {view === "list" ? (
        M.BOARD_COLUMNS.map((c) => {
          const items = byColumn(c);
          if (!items.length) return null;
          return (
            <section className="group" key={c} aria-labelledby={`g-${c}`}>
              <div className="group-head">
                <h2 id={`g-${c}`}>{COLUMN_LABEL[c]}</h2>
                <span className="chip">{items.length}</span>
              </div>
              {items.map((t) => (
                <TaskCard key={t.id} state={state} task={t} />
              ))}
            </section>
          );
        })
      ) : (
        <div className="board">
          {M.BOARD_COLUMNS.map((c) => (
            <section className="col" key={c} aria-label={COLUMN_LABEL[c]}>
              <div className="group-head">
                <h2>{COLUMN_LABEL[c]}</h2>
                <span className="chip">{byColumn(c).length}</span>
              </div>
              {byColumn(c).map((t) => (
                <TaskCard key={t.id} state={state} task={t} />
              ))}
            </section>
          ))}
        </div>
      )}

      {cancelled.length > 0 && (
        <section className="group">
          <button className="link" onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}>
            {showHistory ? "Hide" : "Show"} cancelled ({cancelled.length})
          </button>
          {showHistory && cancelled.map((t) => <TaskCard key={t.id} state={state} task={t} />)}
        </section>
      )}
    </>
  );
}

function involvesProvider(state: State, t: Task, provider: string) {
  if (currentWork(state, t)?.provider === provider) return true;
  return state.attempts.some((a) => a.taskId === t.id && a.snapshot.provider === provider);
}

function TaskCard({ state, task }: { state: State; task: Task }) {
  const c = M.currentSpec(task).content;
  const selected = c.options.find((o) => o.id === c.selectedOptionId);
  const work = currentWork(state, task);
  const ev = latestEvent(state, task.id);
  const open = () => (location.hash = `#/task/${encodeURIComponent(task.id)}`);
  return (
    <div
      className="task-row"
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      aria-label={`${task.id} ${c.title}`}
    >
      <div className="prio">P{task.priority}</div>
      <div>
        <div className="row" style={{ gap: "0.4rem" }}>
          <span className="mono muted">{task.id}</span>
          <span className="title">{c.title}</span>
          {hasNewDecision(state, task) && <span className="badge-new">New decision</span>}
        </div>
        <div className="benefit">{c.benefit}</div>
        <div className="meta">
          <span className="chip">{c.area}</span>
          {selected && (
            <span className="chip strong" title={selected.approach}>
              Approach {selected.id}: {selected.name}
              {c.selectedOptionId !== c.recommendedOptionId ? " (user override)" : ""}
            </span>
          )}
          <span className="chip">spec r{M.currentSpec(task).rev}</span>
          {task.legacySpecUnavailable && <span className="chip">legacy spec unavailable</span>}
        </div>
      </div>
      <div className="side">
        <StatePill state={state} task={task} />
        {work && (
          <span className="chip">
            {ROLE_LABEL[work.role]} · {work.text}
          </span>
        )}
        {ev && (
          <span className="activity">
            {relTime(ev.at)} — {ev.message}
          </span>
        )}
      </div>
    </div>
  );
}
