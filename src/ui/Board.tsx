// The Tasks page (ORC-025 pass 4, T1–T7): every task once, as a list or a board. "Needs you" comes first, in the
// list and on the board; each card says in one plain line what is happening; a finished task is Done with at most
// one result chip. New task starts with "Describe it to the lead"; writing the spec yourself is one click away.

import { useEffect, useMemo, useState } from "react";
import * as M from "../domain/model";
import { effectiveDefault } from "../domain/flows";
import type { State, Task } from "../domain/types";
import { ProviderMark } from "./common";
import { FlowPicker } from "./FlowPicker";
import { Actions, Button, ButtonLink, Card, Checkbox, Chip, EmptyState, Field, Input, SegmentedControl, Select, SimulatedChip, StatePill, Textarea } from "./kit";
import { useLeadContext } from "./LeadDrawer";
import { OTHER_AREA, areaOf, serviceOwned } from "./progress";
import { ShapingBanner } from "./Shaping";
import { newIdOf, useStore } from "./store";
import { GROUPS, GROUP_LABEL, cardLine, cardState, groupOf, lineText, type Group } from "./tasksView";
import "./tasks.css";

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

const taskHref = (id: string) => `#/task/${encodeURIComponent(id)}`;

// ---------- New task (T5) ----------

/** Describe it to the lead first: one message ("Create a task: …") through the conversation. The spec form is the second way. */
function NewTask({ onClose }: { onClose: () => void }) {
  const { send, disabled, service } = useStore();
  const lead = useLeadContext();
  const [mode, setMode] = useState<"describe" | "spec">("describe");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (mode === "spec") return <SpecForm onClose={onClose} onDescribe={() => setMode("describe")} />;
  return (
    <Card title="New task" className="tl-new">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim() || busy) return;
          setBusy(true);
          const r = await send("postMessage", { text: `Create a task: ${text.trim()}` });
          setBusy(false);
          if (r.ok) {
            setText("");
            onClose();
            // The reply arrives in the conversation, the one place it is drawn.
            lead.openLead();
          }
        }}
      >
        <Field
          label="Describe it to the lead"
          hint={
            service?.runtime === "fake"
              ? "What should be true when it is done, and why. In the demo the simulated lead replies, but it does not create tasks."
              : "What should be true when it is done, and why. The lead writes the spec, picks the flow and adds the task within your settings, then replies in the conversation."
          }
        >
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="For example: let people join a trip without making an account" autoFocus />
        </Field>
        <Actions>
          <Button type="submit" variant="primary" disabled={disabled || !text.trim()} loading={busy}>
            Send to the lead
          </Button>
          <Button variant="quiet" onClick={() => setMode("spec")}>
            Write the spec yourself
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </Actions>
      </form>
    </Card>
  );
}

/** Today's form: you write the outcome and approach; the steps come from the flow you choose. */
function SpecForm({ onClose, onDescribe }: { onClose: () => void; onDescribe: () => void }) {
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
    <Field label={required ? label : `${label} (optional)`}>
      {multi ? <Textarea value={f[k]} onChange={(e) => set(k, e.target.value)} required={required} rows={3} /> : <Input type="text" value={f[k]} onChange={(e) => set(k, e.target.value)} required={required} />}
    </Field>
  );
  return (
    <Card title="New task" className="tl-new">
      <form
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
            location.hash = taskHref(id);
          }
        }}
      >
        <p className="meta muted">The steps come from the flow you choose. &ldquo;Wait for my go-ahead&rdquo; is on, so you can read the spec before anything runs.</p>
        {text("title", "Title", true)}
        {text("outcome", "Outcome (what should be true when done)", true, true)}
        {text("approach", "Approach", true, true)}
        <Field label="Acceptance checks (one per line, optional)">
          <Textarea value={f.acceptance} onChange={(e) => set("acceptance", e.target.value)} rows={3} />
        </Field>
        {text("benefit", "User benefit")}
        {text("area", "Area")}
        {text("whyNow", "Why now")}
        <FlowPicker flows={flows} value={f.flowId} onChange={(v) => set("flowId", v)} />
        <Field label="Priority" width="medium" hint="A number you choose is kept: the lead may not change it.">
          <Select value={f.priority} onChange={(e) => set("priority", e.target.value)} options={[{ value: "auto", label: "Auto (P3; the lead may reorder it)" }, ...Array.from({ length: 9 }, (_, i) => ({ value: String(i + 1), label: `P${i + 1}` }))]} />
        </Field>
        <Checkbox checked={f.holdBeforeStart} onChange={(e) => set("holdBeforeStart", e.target.checked)} label="Wait for my go-ahead" hint="Nothing starts until you press Start" />
        <Actions>
          <Button type="submit" variant="primary" disabled={disabled || !flows.length}>
            Create task
          </Button>
          <Button variant="quiet" onClick={onDescribe}>
            Describe it to the lead instead
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </Actions>
      </form>
    </Card>
  );
}

// ---------- the page ----------

const STATUS_OPTIONS = [{ value: "", label: "All" }, ...GROUPS.map((g) => ({ value: g, label: GROUP_LABEL[g] }))];

export function Board() {
  const { state, disabled } = useStore();
  const [view, setView] = usePref<View>("orchestration.view", "list");
  const [sort, setSort] = usePref<Sort>("orchestration.sort", "priority");
  // The area filter lives in the URL (`#/tasks?area=…`), so the Overview's progress rows can open it.
  const [area, setAreaState] = useState(() => areaFromHash(typeof location === "undefined" ? "" : location.hash));
  useEffect(() => {
    const on = () => setAreaState(areaFromHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const setArea = (a: string) => {
    setAreaState(a);
    history.replaceState(null, "", a ? `#/tasks?area=${encodeURIComponent(a)}` : "#/tasks");
  };
  const [status, setStatus] = useState<Group | "">("");
  const [showCancelled, setShowCancelled] = useState(false);
  const [creating, setCreating] = useState(false);

  const areas = useMemo(() => [...new Set(state.tasks.map(areaOf))].sort((a, b) => (a === OTHER_AREA ? 1 : b === OTHER_AREA ? -1 : a.localeCompare(b))), [state.tasks]);
  const now = Date.now();
  const groupById = new Map(state.tasks.map((t) => [t.id, groupOf(state, t, now)]));
  const group = (t: Task) => groupById.get(t.id)!;

  const filtered = state.tasks
    // The same tasks Progress by area counts: the service's own merge checks and reviews are listed under every area.
    .filter((t) => !area || (areaOf(t) === area && !serviceOwned(t)))
    .filter((t) => !status || group(t) === status)
    .sort((a, b) => (sort === "priority" ? a.priority - b.priority || a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt)));
  const inGroup = (g: Group | "cancelled") => filtered.filter((t) => group(t) === g);
  const cancelled = inGroup("cancelled");
  const shownGroups = GROUPS.filter((g) => !status || g === status);
  const listed = filtered.length - cancelled.length;

  return (
    <>
      <div className="tl-head">
        <h1>Tasks</h1>
        <Button size="small" disabled={disabled} aria-expanded={creating} onClick={() => setCreating(!creating)}>
          New task
        </Button>
        <ButtonLink size="small" variant="quiet" href="#/activity" title="Every event, newest first">
          All activity
        </ButtonLink>
      </div>
      {creating && <NewTask onClose={() => setCreating(false)} />}
      <ShapingBanner />
      <div className="tl-toolbar" role="search" aria-label="Filter tasks">
        <SegmentedControl<View>
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "list", label: "List" },
            { value: "board", label: "Board" },
          ]}
        />
        <Field label="Area">
          <Select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">All</option>
            {areas.map((a) => (
              <option key={a}>{a}</option>
            ))}
            {area && !areas.includes(area) && <option value={area}>{area} (no tasks)</option>}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Group | "")} options={STATUS_OPTIONS} />
        </Field>
        <Field label="Sort">
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            options={[
              { value: "priority", label: "Priority" },
              { value: "activity", label: "Latest activity" },
            ]}
          />
        </Field>
      </div>

      {area && (
        <p className="meta muted tl-note">
          Showing the area <strong>{area}</strong>.{" "}
          <button className="link" onClick={() => setArea("")}>
            Show every area
          </button>
        </p>
      )}
      {listed === 0 &&
        (state.tasks.length === 0 ? (
          <EmptyState title="No tasks yet.">Press New task and describe one to the lead.</EmptyState>
        ) : (
          <EmptyState title="No tasks match these filters." />
        ))}

      {listed > 0 &&
        (view === "list" ? (
          shownGroups.map((g) => {
            const items = inGroup(g);
            if (!items.length) return null;
            return (
              <section className={`tl-group${g === "needs-you" ? " tl-group--you" : ""}`} key={g} aria-labelledby={`g-${g}`}>
                <div className="tl-group__head">
                  <h2 id={`g-${g}`}>{GROUP_LABEL[g]}</h2>
                  <Chip tone={g === "needs-you" ? "you" : "neutral"}>{items.length}</Chip>
                </div>
                {items.map((t) => (
                  <TaskCard key={t.id} state={state} task={t} nowMs={now} />
                ))}
              </section>
            );
          })
        ) : (
          // T4: the columns share the page's width; an empty one is narrow and keeps its name. Past the width the board scrolls inside itself, never the page.
          <div className="tl-board board" role="list" aria-label="Board">
            {shownGroups.map((g) => {
              const items = inGroup(g);
              return (
                <section key={g} role="listitem" className={`tl-col${items.length ? "" : " tl-col--empty"}${g === "needs-you" ? " tl-col--you" : ""}`} aria-label={`${GROUP_LABEL[g]}: ${items.length || "empty"}`}>
                  <div className="tl-col__head">
                    <h2>{GROUP_LABEL[g]}</h2>
                    {items.length > 0 && <Chip tone={g === "needs-you" ? "you" : "neutral"}>{items.length}</Chip>}
                  </div>
                  {items.map((t) => (
                    <TaskCard key={t.id} state={state} task={t} nowMs={now} />
                  ))}
                </section>
              );
            })}
          </div>
        ))}

      {cancelled.length > 0 && (
        <section className="tl-group" aria-label="Cancelled tasks">
          <Button size="small" variant="quiet" onClick={() => setShowCancelled(!showCancelled)} aria-expanded={showCancelled}>
            {showCancelled ? "Hide" : "Show"} cancelled ({cancelled.length})
          </Button>
          {showCancelled && cancelled.map((t) => <TaskCard key={t.id} state={state} task={t} nowMs={now} />)}
        </section>
      )}
    </>
  );
}

/**
 * The card (T2, T7): the id, the title, a short state, and one plain line about what is happening, with the
 * provider mark while an agent works and the step bar beside it. A finished task's line carries its one result
 * chip. The whole card opens the task (its title is the link, stretched over the card).
 */
export function TaskCard({ state, task, nowMs = Date.now() }: { state: State; task: Task; nowMs?: number }) {
  const c = M.currentSpec(task).content;
  const pill = cardState(state, task, nowMs);
  const line = cardLine(state, task, nowMs);
  // Only a line about work happening now has the work tone: an agent, or the service's checks, runs on the task.
  const live = line.tone === "work";
  return (
    <article className="tl-card" aria-label={`${task.id} ${c.title}`}>
      <div className="tl-card__head">
        <div className="tl-card__idline">
          <span className="tl-card__id">{task.id}</span>
          <span title="Priority">P{task.priority}</span>
          {task.parentTaskId && (
            <span>
              part of <a href={taskHref(task.parentTaskId)}>{task.parentTaskId}</a>
            </span>
          )}
          {task.reviewTarget && <span title={`An independent review of ${task.reviewTarget.taskId}'s pull request, created by the service`}>Pull request review · {task.reviewTarget.taskId}</span>}
          {task.deliverInto && <span title={`A fix whose result is pushed onto ${task.deliverInto.taskId}'s pull request`}>Pull request fix · {task.deliverInto.taskId}</span>}
        </div>
        <a className="tl-card__title" href={taskHref(task.id)}>
          {c.title}
        </a>
      </div>
      <div className="tl-card__state">
        <StatePill tone={pill.tone} paused={pill.paused} pulse={pill.pulse}>
          {pill.label}
        </StatePill>
      </div>
      {(line.text || line.chip) && (
        <p className={`tl-card__line tl-card__line--${line.tone}`} title={lineText(line)}>
          {line.chip && (
            <Chip tone={line.chip.kind === "pr" ? "you" : "done"} strong={line.chip.kind === "pr"}>
              {line.chip.label}
            </Chip>
          )}
          {line.text && (
            <span className="tl-card__words">
              {line.provider && (
                <>
                  <ProviderMark provider={line.provider} />{" "}
                </>
              )}
              {line.text}
            </span>
          )}
          {line.chip?.simulated && <SimulatedChip title={line.chip.kind === "pr" ? "Simulated pull request: nothing was sent to GitHub." : "Simulated merge: nothing was sent to GitHub."} />}
        </p>
      )}
      {live && <StepBar task={task} />}
      <div className="tl-card__foot">
        <Chip>{areaOf(task)}</Chip>
      </div>
    </article>
  );
}

/** One segment per pipeline step, from the task's real step states: done, agents working, failed, or not yet. */
function StepBar({ task }: { task: Task }) {
  return (
    <div className="tl-stepbar" aria-hidden="true">
      {task.steps.map((st) => (
        <span key={st.id} className={st.state === "done" ? "done" : st.state === "running" || st.state === "stopping" ? "work" : st.state === "blocked" ? "fail" : undefined} />
      ))}
    </div>
  );
}
