// The rest of the task page, a click away: the spec and its options, the outputs,
// the runs, the activity, the revisions and the models. Each section renders only while open, so the page
// stays short and the ids and internals stay out of the main view.

import { useState } from "react";
import { diffLines, specToLines } from "../../domain/diff";
import type { State, Task } from "../../domain/types";
import { ACTOR_LABEL, activityHash, eventText } from "../activityView";
import { fmtTime, relTime } from "../common";
import { revisionFlowLabel } from "../flowView";
import { Card, Chip, Disclosure, Field, Select } from "../kit";
import { ModelsSection } from "./Models";
import { isOpenTask } from "./needsYouItems";
import { OutputsSection } from "./Outputs";
import { RunsSection } from "./Runs";
import { SpecSection } from "./SpecSection";

export type DetailsSectionId = "spec" | "outputs" | "runs" | "activity" | "revisions" | "models";
export const DETAILS_ID = "details";

export function DetailsCard({ state, task, open, onToggle, chooseAtTop, decideAbove, onEdit }: { state: State; task: Task; open: Record<DetailsSectionId, boolean>; onToggle: (id: DetailsSectionId, open: boolean) => void; chooseAtTop: boolean; decideAbove: () => void; onEdit?: () => void }) {
  const outputs = state.artifacts.filter((a) => a.taskId === task.id).length;
  const runs = state.attempts.filter((a) => a.taskId === task.id).length;
  const events = state.events.filter((e) => e.taskId === task.id).length;
  const revisions = task.specs.length + Math.max(0, task.pipelineHistory.length - 1);
  return (
    <Card id={DETAILS_ID} title="Details" className="t-details">
      <Disclosure label="Spec and options" open={open.spec} onToggle={(o) => onToggle("spec", o)}>
        {open.spec && <SpecSection task={task} chooseAtTop={chooseAtTop} onEdit={onEdit} />}
      </Disclosure>
      <Disclosure label="Outputs" count={outputs} open={open.outputs} onToggle={(o) => onToggle("outputs", o)}>
        {open.outputs && <OutputsSection state={state} task={task} decideAbove={decideAbove} />}
      </Disclosure>
      <Disclosure label="Runs" count={runs} open={open.runs} onToggle={(o) => onToggle("runs", o)}>
        {open.runs && <RunsSection state={state} task={task} />}
      </Disclosure>
      <Disclosure label="Activity" count={events} open={open.activity} onToggle={(o) => onToggle("activity", o)}>
        {open.activity && <TaskActivity state={state} task={task} />}
      </Disclosure>
      <Disclosure label="Revisions" count={revisions} open={open.revisions} onToggle={(o) => onToggle("revisions", o)}>
        {open.revisions && <RevisionsSection key={task.specs.length} task={task} />}
      </Disclosure>
      {isOpenTask(task) && (
        <Disclosure label="Models" open={open.models} onToggle={(o) => onToggle("models", o)}>
          {open.models && <ModelsSection state={state} task={task} />}
        </Disclosure>
      )}
    </Card>
  );
}

/** How many of the task's events its page shows; the Activity page has them all. */
const SHOWN_EVENTS = 25;

/** The task's newest events, in the Activity page's words, and the way to all of them there. */
function TaskActivity({ state, task }: { state: State; task: Task }) {
  const all = state.events.filter((e) => e.taskId === task.id);
  const evs = all.slice(-SHOWN_EVENTS).reverse();
  if (!evs.length) return <p className="muted">Nothing yet.</p>;
  return (
    <div className="k-stack k-stack--tight">
      <ul className="t-events">
        {evs.map((e) => (
          <li key={e.id}>
            <span className="muted" title={fmtTime(e.at)}>
              {relTime(e.at)}
            </span>
            <span className="muted">{ACTOR_LABEL[e.actor]}</span>
            <span>{eventText(e.message)}</span>
          </li>
        ))}
      </ul>
      <p className="small no-margin">
        {all.length > evs.length ? `The newest ${evs.length} of ${all.length}. ` : ""}
        <a href={activityHash(task.id)}>All activity for this task</a>
      </p>
    </div>
  );
}

/** The spec's revisions with a comparison of any two, and the pipeline's revisions. */
function RevisionsSection({ task }: { task: Task }) {
  const revs = task.specs;
  const [from, setFrom] = useState(Math.max(1, revs.length - 1));
  const [to, setTo] = useState(revs.length);
  const a = revs.find((r) => r.rev === from);
  const b = revs.find((r) => r.rev === to);
  const diff = a && b ? diffLines(specToLines(a.content), specToLines(b.content)) : [];
  const changed = diff.filter((d) => d.kind !== "same");
  const options = revs.map((r) => ({ value: String(r.rev), label: `r${r.rev}` }));
  return (
    <div className="k-stack k-stack--tight">
      <h3 className="meta">Spec</h3>
      <ul className="t-events">
        {[...revs].reverse().map((r) => (
          <li key={r.rev}>
            <span className="mono">r{r.rev}</span>
            <span className="muted">{r.author}</span>
            <span>
              {r.reason} <span className="muted">· {fmtTime(r.at)}</span>
            </span>
          </li>
        ))}
      </ul>
      {revs.length > 1 && (
        <>
          <div className="t-inline">
            <Field label="Compare" width="short">
              <Select value={String(from)} onChange={(e) => setFrom(Number(e.target.value))} options={options} />
            </Field>
            <Field label="with" width="short">
              <Select value={String(to)} onChange={(e) => setTo(Number(e.target.value))} options={options} />
            </Field>
            <span className="muted small">{changed.length ? `${changed.length} changed line${changed.length === 1 ? "" : "s"}` : "No differences"}</span>
          </div>
          {changed.length > 0 && (
            <div className="diff" aria-label={`Differences between r${from} and r${to}`}>
              {diff.map((d, i) => (
                <div key={i} className={d.kind}>
                  {d.text}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {task.pipelineHistory.length > 1 && (
        <>
          <h3 className="meta">Steps</h3>
          <ul className="t-events">
            {[...task.pipelineHistory].reverse().map((p) => (
              <li key={p.rev}>
                <span className="mono">r{p.rev}</span>
                <span className="muted">{p.author}</span>
                <span>
                  {p.reason} {revisionFlowLabel(p) && <Chip>{revisionFlowLabel(p)}</Chip>} <span className="muted">· {p.steps.length} steps · {fmtTime(p.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
