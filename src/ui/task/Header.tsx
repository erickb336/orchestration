// ORC-025 pass 3 (P5): the task page's header: where it sits, its title and state, and its controls in one
// place: Pause or Resume, Message the lead, and a More menu with the rarer ones (Edit spec, Priority, Keep
// running whatever the focus, Change flow, Review every step, Wait for my go-ahead, Cancel task).

import { useEffect, useState } from "react";
import * as M from "../../domain/model";
import type { State, Task } from "../../domain/types";
import { taskTone } from "../common";
import { flowLineText } from "../flowView";
import { Actions, Button, Field, Input, StatePill, useConfirm } from "../kit";
import { useLeadContext } from "../LeadDrawer";
import { newIdOf, useStore } from "../store";
import { ChangeFlow, canChangeFlow } from "./ChangeFlow";
import { CONFIRM } from "./confirms";
import { MoreMenu, type MenuItem } from "./MoreMenu";
import { isOpenTask } from "./needsYouItems";

type Panel = "priority" | "flow" | null;

export function TaskHeader({ state, task, editing, onEdit }: { state: State; task: Task; editing: boolean; onEdit: () => void }) {
  const { send, disabled } = useStore();
  const lead = useLeadContext();
  const confirm = useConfirm();
  const [panel, setPanel] = useState<Panel>(null);
  const c = M.currentSpec(task).content;
  const open = isOpenTask(task);
  const tone = taskTone(state, task);
  const pausing = task.hold && M.activeAttempts(state, task.id).some((a) => a.outcome === "stopping");
  const flowBlocker = open ? M.flowChangeBlocker(state, task) : undefined;
  // The panels belong to an open task; they close with it.
  useEffect(() => {
    if (!open || editing) setPanel(null);
  }, [open, editing]);

  const items: MenuItem[] = [
    { id: "edit", label: "Edit spec", onSelect: onEdit, disabled: editing },
    { id: "priority", label: `Priority…`, hint: `P${task.priority}: ${priorityHint(state, task)}`, onSelect: () => setPanel("priority") },
    {
      kind: "check",
      id: "run-pin",
      label: "Keep running whatever the focus",
      hint: "The lead may not defer this task when you message it",
      checked: !!task.userSet?.run,
      disabled,
      onSelect: () => void send("setRunPin", { taskId: task.id, pinned: !task.userSet?.run }),
    },
    { id: "sep1", kind: "sep" },
    ...(canChangeFlow(task) ? [{ id: "flow", label: "Change flow…", hint: `Now: ${flowLineText(task.flow)}`, onSelect: () => setPanel("flow"), disabled: disabled || !!flowBlocker, disabledReason: flowBlocker } satisfies MenuItem] : []),
    {
      kind: "check",
      id: "review-every-step",
      label: "Review every step",
      hint: "Pause after every step so you can read or edit its outputs",
      checked: !!task.reviewEveryStep,
      disabled,
      onSelect: () => void send("setReviewEveryStep", { taskId: task.id, value: !task.reviewEveryStep }),
    },
    {
      kind: "check",
      id: "hold-before-start",
      label: "Wait for my go-ahead",
      hint: "Nothing starts until you press Start",
      checked: task.holdBeforeStart,
      disabled: disabled || task.lifecycle === "active",
      disabledReason: task.lifecycle === "active" ? "The task has started" : undefined,
      onSelect: () => void send("setHoldBeforeStart", { taskId: task.id, value: !task.holdBeforeStart }),
    },
    { id: "sep2", kind: "sep" },
    {
      id: "cancel",
      label: "Cancel task",
      danger: true,
      disabled,
      onSelect: async () => {
        if (await confirm(CONFIRM.cancelTask(task.id))) void send("cancelTask", { taskId: task.id });
      },
    },
  ];

  return (
    <header className="t-head">
      <p className="t-head__meta">
        <a href="#/tasks">← Tasks</a>
        <span aria-hidden="true">·</span>
        <span className="k-row__id">{task.id}</span>
        <span>{flowLineText(task.flow).replace(/^Flow: /, "")}</span>
        {c.area && (
          <>
            <span aria-hidden="true">·</span>
            <span>{c.area}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span title={priorityHint(state, task)}>P{task.priority}</span>
        {task.parentTaskId && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              part of <a href={`#/task/${encodeURIComponent(task.parentTaskId)}`}>{task.parentTaskId}</a>
            </span>
          </>
        )}
        {task.followUpOf && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              follow-up of <a href={`#/task/${encodeURIComponent(task.followUpOf)}`}>{task.followUpOf}</a>
            </span>
          </>
        )}
      </p>
      <div className="t-head__title">
        <h1>{c.title}</h1>
        <StatePill tone={tone.tone} paused={tone.paused} pulse={tone.pulse}>
          {M.stateLabel(state, task)}
        </StatePill>
        <div className="t-head__actions">
          {open &&
            (task.hold ? (
              <Button variant="primary" disabled={disabled || pausing} disabledReason={pausing ? "Waiting for the agent to acknowledge the stop" : undefined} onClick={() => void send("resumeTask", { taskId: task.id })}>
                Resume
              </Button>
            ) : (
              <Button disabled={disabled} onClick={() => void send("pauseTask", { taskId: task.id })}>
                Pause
              </Button>
            ))}
          <Button onClick={() => lead.openLead({ taskId: task.id })} title="Your message carries this task as context">
            Message the lead about this task
          </Button>
          {task.lifecycle === "done" && (
            <Button
              disabled={disabled}
              onClick={async () => {
                if (!(await confirm(CONFIRM.createFollowUp(task.id)))) return;
                const newId = newIdOf(await send("createFollowUp", { taskId: task.id }));
                if (newId) location.hash = `#/task/${encodeURIComponent(newId)}`;
              }}
            >
              Create follow-up
            </Button>
          )}
          {open && !editing && <MoreMenu items={items} menuLabel={`More for ${task.id}`} />}
        </div>
      </div>
      {panel === "priority" && <PriorityPanel state={state} task={task} onClose={() => setPanel(null)} />}
      {panel === "flow" && <ChangeFlow state={state} task={task} onClose={() => setPanel(null)} />}
    </header>
  );
}

/** Who set the priority and what the lead may do with it, in a few words. */
function priorityHint(state: State, task: Task): string {
  const p = M.priorityProvenance(state, task);
  switch (p.kind) {
    case "user":
      return "set by you";
    case "lead":
      return `set by the lead (was P${p.was})`;
    case "child":
      return `runs at ${p.rootId}'s priority (P${p.priority})`;
    default:
      return "the lead may reorder it when you message it";
  }
}

/** Set the priority and say who holds it; opened from the More menu. */
function PriorityPanel({ state, task, onClose }: { state: State; task: Task; onClose: () => void }) {
  const { send, disabled } = useStore();
  const [prio, setPrio] = useState(String(task.priority));
  useEffect(() => setPrio(String(task.priority)), [task.priority]);
  const provenance = M.priorityProvenance(state, task);
  const n = Number(prio);
  return (
    <form
      className="t-panel"
      aria-labelledby="prio-h"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && Number.isInteger(n) && n >= 1 && n !== task.priority) void send("setPriority", { taskId: task.id, priority: n });
      }}
    >
      <h3 id="prio-h">Priority</h3>
      <div className="t-inline">
        <Field label="Priority" width="short" labelHidden>
          <Input type="number" min={1} value={prio} onChange={(e) => setPrio(e.target.value)} />
        </Field>
        <Button type="submit" size="small" disabled={disabled || !Number.isInteger(n) || n < 1 || n === task.priority}>
          Set
        </Button>
        <Button size="small" variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="small muted">
        {provenance.kind === "user" && (
          <>
            Set by you: the lead may not reorder it.{" "}
            <Button size="small" variant="quiet" disabled={disabled} onClick={() => void send("setPriorityPin", { taskId: task.id, pinned: false })}>
              Let the lead reorder this
            </Button>
          </>
        )}
        {provenance.kind === "lead" && (
          <Actions>
            <span>Set by the lead (was P{provenance.was}).</span>
            <Button size="small" variant="quiet" disabled={disabled} onClick={() => void send("undoSteering", { changeSetId: provenance.changeSetId, changeId: provenance.changeId })}>
              Undo
            </Button>
            <Button size="small" variant="quiet" disabled={disabled} title="The lead may not reorder it again" onClick={() => void send("setPriorityPin", { taskId: task.id, pinned: true })}>
              Keep P{task.priority}
            </Button>
          </Actions>
        )}
        {provenance.kind === "auto" && (
          <>
            The lead may reorder it when you message it.{" "}
            <Button size="small" variant="quiet" disabled={disabled} title="The lead may not reorder it" onClick={() => void send("setPriorityPin", { taskId: task.id, pinned: true })}>
              Pin P{task.priority}
            </Button>
          </>
        )}
        {provenance.kind === "child" && `Runs at ${provenance.rootId}'s priority (P${provenance.priority}); Set gives it its own.`}
      </div>
    </form>
  );
}
