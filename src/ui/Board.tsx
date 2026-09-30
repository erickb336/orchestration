import { useMemo, useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { INTERNAL_TEMPLATE_IDS } from "../domain/templates";
import { PROVIDERS, ROLES, type State, type Task } from "../domain/types";
import { newIdOf, useStore } from "./store";
import { PrChip } from "./Delivery";
import { COLUMN_LABEL, ROLE_LABEL, StatePill, currentWork, hasNewDecision, latestEvent, relTime } from "./common";
import { isSettledTask, pipelineSummary } from "./fanout";

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

function NewTaskForm({ onClose }: { onClose: () => void }) {
  const { state, send, disabled } = useStore();
  const templates = state.project.templates.filter((t) => !INTERNAL_TEMPLATE_IDS.includes(t.id));
  const [f, setF] = useState({
    title: "",
    area: "",
    outcome: "",
    benefit: "",
    whyNow: "",
    approach: "",
    acceptance: "",
    priority: "3",
    templateId: templates.find((t) => t.id === "change")?.id ?? templates[0]?.id ?? "",
    holdBeforeStart: true,
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const tpl = templates.find((t) => t.id === f.templateId);
  const text = (k: "title" | "area" | "outcome" | "benefit" | "whyNow" | "approach", label: string, required = false, multi = false) => (
    <label className="field">
      <span>
        {label}
        {required ? "" : " (optional)"}
      </span>
      {multi ? <textarea value={f[k]} onChange={(e) => set(k, e.target.value)} required={required} /> : <input type="text" value={f[k]} onChange={(e) => set(k, e.target.value)} required={required} />}
    </label>
  );
  return (
    <form
      className="card"
      aria-labelledby="new-task-h"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await send("createTask", {
          title: f.title,
          area: f.area,
          outcome: f.outcome,
          benefit: f.benefit,
          whyNow: f.whyNow,
          approach: f.approach,
          acceptance: f.acceptance.split("\n"),
          priority: Number(f.priority) || 3,
          holdBeforeStart: f.holdBeforeStart,
          templateId: f.templateId,
        });
        const id = newIdOf(r);
        if (id) {
          onClose();
          location.hash = `#/task/${encodeURIComponent(id)}`;
        }
      }}
    >
      <h2 id="new-task-h">New task</h2>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        You write the outcome and approach; the pipeline comes from a template and can be edited afterwards. Hold before start is on by default so you can review the spec and pipeline before anything runs.
      </p>
      {text("title", "Title", true)}
      {text("outcome", "Outcome (what should be true when done)", true, true)}
      {text("approach", "Approach", true, true)}
      <label className="field">
        <span>Acceptance checks (one per line)</span>
        <textarea value={f.acceptance} onChange={(e) => set("acceptance", e.target.value)} />
      </label>
      {text("benefit", "User benefit")}
      {text("area", "Area")}
      {text("whyNow", "Why now")}
      <div className="row">
        <label className="field">
          <span>Pipeline template</span>
          <select value={f.templateId} onChange={(e) => set("templateId", e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <input type="number" min={1} value={f.priority} onChange={(e) => set("priority", e.target.value)} style={{ width: "5rem" }} />
        </label>
      </div>
      {tpl && (
        <p className="mono muted" style={{ fontSize: "0.78rem" }}>
          {pipelineSummary(tpl.steps)}
        </p>
      )}
      <label className="row" style={{ fontSize: "0.9rem", marginBottom: "0.8rem" }}>
        <input type="checkbox" checked={f.holdBeforeStart} onChange={(e) => set("holdBeforeStart", e.target.checked)} />
        Hold before start
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={disabled || !templates.length}>
          Create task
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Board() {
  const { state, send, disabled } = useStore();
  const [view, setView] = usePref<View>("orchestration.view", "list");
  const [sort, setSort] = usePref<Sort>("orchestration.sort", "priority");
  const [area, setArea] = useState("");
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [provider, setProvider] = useState("");
  const [changed, setChanged] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [creating, setCreating] = useState(false);

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
        <span className="row">
          <h1 style={{ margin: 0 }}>Tasks</h1>
          <button className="small" disabled={disabled} onClick={() => setCreating(true)}>
            New task
          </button>
        </span>
        {newCount > 0 && (
          <span className="row">
            <span className="muted">{newCount} decision(s) since your last visit.</span>
            <button className="small" disabled={disabled} onClick={() => void send("markVisited")} title="Only updates what counts as new; does not approve or pause anything">
              Mark all seen
            </button>
          </span>
        )}
      </div>
      {creating && <NewTaskForm onClose={() => setCreating(false)} />}
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
  const children = M.childTasks(state, task);
  const childrenDone = children.filter(isSettledTask).length;
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
          {task.specs[0]?.author === "lead" && (
            <span className="chip" title="Proposed by the lead">
              lead
            </span>
          )}
          {task.parentTaskId && (
            <span className="chip">
              part of{" "}
              <a href={`#/task/${encodeURIComponent(task.parentTaskId)}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {task.parentTaskId}
              </a>
            </span>
          )}
          {children.length > 0 && (
            <span className="chip" title={`${childrenDone} of ${children.length} child tasks finished`}>
              {children.length} child task{children.length === 1 ? "" : "s"}
              {childrenDone < children.length ? ` · ${childrenDone} finished` : " · all finished"}
            </span>
          )}
          {task.reviewTarget && (
            <span className="chip" title={`An independent review of ${task.reviewTarget.taskId}'s pull request at ${task.reviewTarget.headSha.slice(0, 12)}, created by the service`}>
              PR review · {task.reviewTarget.taskId}
            </span>
          )}
          {task.deliverInto && (
            <span className="chip" title={`A fix whose result is pushed onto ${task.deliverInto.taskId}'s pull request, created ${task.specs[0]?.author === "user" ? "by you" : "by the service"}`}>
              PR repair · {task.deliverInto.taskId}
            </span>
          )}
          {task.lifecycle === "done" && <IntegrationChip state={state} task={task} />}
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

function IntegrationChip({ state, task }: { state: State; task: Task }) {
  const i = task.integration;
  // Work delivered as a pull request: its own chip says what is wanted, in flight and observed.
  if (i?.pr && i.status !== "conflict") return <PrChip state={state} task={task} />;
  switch (i?.status) {
    case "integrated":
      // A fix that was pushed onto another task's pull request lands with that pull request.
      if (D.deliveredInto(task)) return <span className="chip done">pushed onto {task.deliverInto!.taskId}'s PR</span>;
      if (i.landed) return <span className="chip done">{i.landed.status === "unreviewed" ? "delivered · review" : "delivered"}</span>;
      return <span className="chip done">integrated</span>;
    case "conflict":
      return <span className="chip danger">integration conflict</span>;
    case "pending":
      return <span className="chip">{D.deliveryMode(state) === "pr" ? "preparing pull request" : "integrating"}</span>;
    default:
      return null;
  }
}
