import { useEffect, useMemo, useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { effectiveDefault } from "../domain/flows";
import { PROVIDERS, ROLES, type State, type Task } from "../domain/types";
import { newIdOf, useStore } from "./store";
import { PrChip } from "./Delivery";
import { COLUMN_LABEL, ProviderMark, ROLE_LABEL, StatePill, currentWork, hasNewDecision, isSimulated, latestEvent, relTime } from "./common";
import { isSettledTask } from "./fanout";
import { useLeadContext } from "./LeadDrawer";
import { FlowPicker } from "./FlowPicker";
import { OTHER_AREA, areaOf, liveAgents, needsYouOf, serviceOwned } from "./progress";
import { ShapingBanner } from "./Shaping";
import { FocusDiff } from "./SteeringChanges";

/** ORC-017 §3.3: the board reads `#/tasks?area=<name>`; a row on the Overview's progress list sets it. */
export function areaFromHash(hash: string): string {
  const q = hash.indexOf("?");
  if (q < 0) return "";
  try {
    return new URLSearchParams(hash.slice(q + 1)).get("area") ?? "";
  } catch {
    return "";
  }
}

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
  // ORC-021: the six flows; the service's own pipelines are never among them.
  const flows = state.flows;
  const [f, setF] = useState({
    title: "",
    area: "",
    outcome: "",
    benefit: "",
    whyNow: "",
    approach: "",
    acceptance: "",
    // "auto": priority 3, not pinned, so the lead may reorder it when you steer. A number is your choice and stays.
    priority: "auto",
    flowId: effectiveDefault(state).id,
    holdBeforeStart: true,
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
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
          priority: f.priority === "auto" ? 3 : Number(f.priority) || 3,
          priorityPinned: f.priority !== "auto",
          holdBeforeStart: f.holdBeforeStart,
          flowId: f.flowId,
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
        You write the outcome and approach; the pipeline comes from the flow you choose. You can pin a provider and model for each step on the task page. Hold before start is on by default so you can review the spec before anything runs.
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
      <FlowPicker flows={flows} value={f.flowId} onChange={(v) => set("flowId", v)} />
      <label className="field">
        <span>Priority</span>
        <select value={f.priority} onChange={(e) => set("priority", e.target.value)}>
          <option value="auto">Auto (P3; the lead may reorder it)</option>
          {Array.from({ length: 9 }, (_, i) => (
            <option key={i + 1} value={String(i + 1)}>
              P{i + 1} (pinned: the lead may not change it)
            </option>
          ))}
        </select>
      </label>
      <label className="row" style={{ fontSize: "0.9rem", marginBottom: "0.8rem" }}>
        <input type="checkbox" checked={f.holdBeforeStart} onChange={(e) => set("holdBeforeStart", e.target.checked)} />
        Hold before start
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={disabled || !flows.length}>
          Create task
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** ORC-009: the current focus when the lead set it from your message, with a diff and Undo. */
function FocusBanner() {
  const { state, send, disabled } = useStore();
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const v = M.currentVision(state);
  const change = M.currentFocusChange(state);
  if (!change) return null;
  const msg = change.set.messageIds[0];
  return (
    <div className="banner neutral focus-banner" role="note">
      <span>
        <strong>Focus r{v.rev}</strong> · set by the lead from your message · {relTime(v.at)}:
      </span>
      {(isSimulated(v) || isSimulated(change.set)) && (
        <span className="chip" title="Set by the fake runtime's lead, not by a model">
          simulated
        </span>
      )}
      <span className="quote">“{v.focus}”</span>
      <span className="row" style={{ gap: "0.3rem", marginLeft: "auto" }}>
        <button className="small" onClick={() => setShowDiff(!showDiff)} aria-expanded={showDiff}>
          What changed
        </button>
        <button
          className="small"
          disabled={disabled || busy}
          onClick={async () => {
            setBusy(true);
            await send("undoSteering", { changeSetId: change.set.id, changeId: change.change.id });
            setBusy(false);
          }}
        >
          Undo
        </button>
        <a className="button-link" style={{ padding: "0.15rem 0.55rem", fontSize: "0.85rem" }} href="#/overview" title={msg ? `Set from message ${msg}` : undefined}>
          History
        </a>
      </span>
      {showDiff && (
        <div style={{ flexBasis: "100%" }}>
          <FocusDiff before={String(change.change.before ?? "")} after={String(change.change.after ?? "")} />
          {change.set.reason && <div className="muted" style={{ fontSize: "0.82rem" }}>Reason: {change.set.reason}</div>}
        </div>
      )}
    </div>
  );
}

export function Board() {
  const { state, send, disabled } = useStore();
  const lead = useLeadContext();
  const [view, setView] = usePref<View>("orchestration.view", "list");
  const [sort, setSort] = usePref<Sort>("orchestration.sort", "priority");
  // The area filter lives in the URL (`#/tasks?area=…`), so the Overview's progress rows can open it.
  const [area, setAreaState] = useState(() => areaFromHash(location.hash));
  useEffect(() => {
    const on = () => setAreaState(areaFromHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const setArea = (a: string) => {
    setAreaState(a);
    history.replaceState(null, "", a ? `#/tasks?area=${encodeURIComponent(a)}` : "#/tasks");
  };
  const [status, setStatus] = useState("");
  const [role, setRole] = useState("");
  const [provider, setProvider] = useState("");
  const [changed, setChanged] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [creating, setCreating] = useState(false);

  const areas = useMemo(() => [...new Set(state.tasks.map(areaOf))].sort((a, b) => (a === OTHER_AREA ? 1 : b === OTHER_AREA ? -1 : a.localeCompare(b))), [state.tasks]);

  const filtered = state.tasks
    .filter((t) => {
      const work = currentWork(state, t);
      // The same tasks Progress by area counts: the service's own merge checks and reviews are listed under every area.
      if (area && (areaOf(t) !== area || serviceOwned(t))) return false;
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
          <button className="small" disabled={disabled} onClick={() => lead.openLead({ placeholder: "Tell the lead what to focus on…" })} title="Message the lead: it can change the focus, reorder and defer work, and drop its own unstarted proposals">
            Steer
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
      <ShapingBanner />
      <FocusBanner />
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
            {area && !areas.includes(area) && <option value={area}>{area} (no tasks)</option>}
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

      {area && (
        <p className="muted meta" style={{ margin: "-0.5rem 0 0.75rem" }}>
          Showing the area <strong>{area}</strong>, as Progress by area counts it; the service&apos;s own merge checks and reviews are listed under every area.{" "}
          <button className="link" onClick={() => setArea("")}>
            Show every area
          </button>
        </p>
      )}
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
        <>
          {M.BOARD_COLUMNS.some((c) => byColumn(c).length === 0) && (
            <p className="muted meta board-empty">
              Empty: {M.BOARD_COLUMNS.filter((c) => byColumn(c).length === 0).map((c) => COLUMN_LABEL[c]).join(", ")}
            </p>
          )}
        <div className="board">
          {M.BOARD_COLUMNS.filter((c) => byColumn(c).length > 0).map((c) => (
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
        </>
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

/**
 * ORC-017 §3.2: the card. Id and title; the state and what needs you; the work line with the provider mark,
 * the step purpose, "step 3 of 6" and the step bar while an agent works; the area and the last activity.
 * The spec revision, the approach, the role and the priority provenance live on the task page.
 */
function TaskCard({ state, task }: { state: State; task: Task }) {
  const c = M.currentSpec(task).content;
  const work = currentWork(state, task);
  const ev = latestEvent(state, task.id);
  const open = () => (location.hash = `#/task/${encodeURIComponent(task.id)}`);
  const children = M.currentChildren(state, task);
  const childrenDone = children.filter(isSettledTask).length;
  const needs = needsYouOf(state, task);
  const agents = liveAgents(state, task);
  const live = agents[0];
  const liveStep = live ? task.steps.findIndex((st) => st.id === live.stepId) : -1;
  // "next: …" for an idle open task says who is up next; the live line says who works now.
  const next = !live && work && !work.live ? work : undefined;
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
      <div className="head">
        <div className="idline">
          <span className="mono">{task.id}</span>
          <span className="prio" title="Priority">
            P{task.priority}
          </span>
          {task.parentTaskId && (
            <span>
              part of{" "}
              <a href={`#/task/${encodeURIComponent(task.parentTaskId)}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {task.parentTaskId}
              </a>
            </span>
          )}
          {task.reviewTarget && <span title={`An independent review of ${task.reviewTarget.taskId}'s pull request at ${task.reviewTarget.headSha.slice(0, 12)}, created by the service`}>PR review · {task.reviewTarget.taskId}</span>}
          {task.deliverInto && <span title={`A fix whose result is pushed onto ${task.deliverInto.taskId}'s pull request, created ${task.specs[0]?.author === "user" ? "by you" : "by the service"}`}>PR repair · {task.deliverInto.taskId}</span>}
          {task.legacySpecUnavailable && <span className="chip">legacy spec unavailable</span>}
          {hasNewDecision(state, task) && <span className="badge-new">New decision</span>}
        </div>
        <div className="title">{c.title}</div>
      </div>
      <div className="state">
        <StatePill state={state} task={task} />
        {needs && (
          <span className="needs-badge" title={`Open the task: ${needs.what}`}>
            Needs you: {needs.what}
          </span>
        )}
        {task.lifecycle === "done" && <IntegrationChip state={state} task={task} />}
      </div>
      {(live || next || children.length > 0) && (
        <div className="work">
          {live && (
            <>
              <div className="work-line">
                <ProviderMark provider={live.provider} />
                <span>{M.providerLabel(live.provider)}</span>
                <span className="purpose">· {live.purpose}</span>
                {agents.length > 1 && <span className="muted">· +{agents.length - 1} more</span>}
              </div>
              <div className="step-row">
                <StepBar task={task} />
                {liveStep >= 0 && (
                  <span className="muted num">
                    step {liveStep + 1} of {task.steps.length}
                  </span>
                )}
              </div>
            </>
          )}
          {next && (
            <div className="work-line">
              <span className="muted">
                {ROLE_LABEL[next.role]} · {next.text}
              </span>
            </div>
          )}
          {children.length > 0 && (
            <div className="work-line">
              <span className="muted" title={`${childrenDone} of ${children.length} child tasks finished`}>
                {children.length} child task{children.length === 1 ? "" : "s"}
                {childrenDone < children.length ? ` · ${childrenDone} finished` : " · all finished"}
              </span>
            </div>
          )}
        </div>
      )}
      <div className="foot">
        <span className="chip">{areaOf(task)}</span>
        {ev && (
          <span className="activity" title={`${relTime(ev.at)} — ${ev.message}`}>
            {relTime(ev.at)} — {ev.message}
          </span>
        )}
      </div>
    </div>
  );
}

/** One 4 px segment per pipeline step, from the task's real step states: done, agents working, or neutral. */
function StepBar({ task }: { task: Task }) {
  return (
    <div className="stepbar" aria-hidden="true">
      {task.steps.map((st) => (
        <span key={st.id} className={st.state === "done" ? "done" : st.state === "running" || st.state === "stopping" ? "work" : st.state === "blocked" ? "fail" : ""} title={`${st.id} ${st.purpose}: ${st.state}`} />
      ))}
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
