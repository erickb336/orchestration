// Run a task on another flow. Opened from the header's More menu while the task is open and not
// service-owned. The panel shows the picker, what the change does (which steps start over, which pins stay,
// what is closed) and an optional note. The pipeline revision is the one the panel was opened on; if it moves
// meanwhile, the panel asks you to review again instead of sending a stale request.

import { useState } from "react";
import * as M from "../../domain/model";
import type { State, Task } from "../../domain/types";
import { FlowPicker } from "../FlowPicker";
import { PIPELINE_CHANGED_MESSAGE, changeConsequences, sameFlow } from "../flowView";
import { Actions, Banner, Button, Field, Input } from "../kit";
import { useStore } from "../store";

/** True when the task can take another flow at all (service-owned tasks keep theirs). */
export function canChangeFlow(task: Task): boolean {
  return !(task.reviewTarget || task.checkTarget || task.revertOf || task.deliverInto);
}

export function ChangeFlow({ state, task, onClose }: { state: State; task: Task; onClose: () => void }) {
  const { send, disabled } = useStore();
  const [openedRev, setOpenedRev] = useState(task.pipelineRev);
  const [flowId, setFlowId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // A child task may not take a flow that breaks down again.
  const choices = state.flows.filter((p) => !(task.parentTaskId && p.breaksDown));
  const chosen = choices.find((p) => p.id === flowId);
  const preview = chosen ? M.flowChangePreview(state, task, chosen) : undefined;
  const same = chosen ? sameFlow(task.flow, chosen) : false;
  const moved = task.pipelineRev !== openedRev;
  const canUse = !!chosen && !!preview?.allowed && !same && !moved && !busy && !disabled;
  return (
    <div className="t-panel" role="group" aria-labelledby="chg-flow-h">
      <h3 id="chg-flow-h">Change flow</h3>
      <p className="meta muted">
        The steps start over from the flow you choose. Work done so far stays on the record, labelled "earlier flow", and is never used again. A provider or model pin stays on a step with the same id and role.
        {task.hold ? " The task stays paused until you resume it." : ""}
      </p>
      {moved && (
        <Banner
          tone="you"
          actions={
            <Button size="small" onClick={() => setOpenedRev(task.pipelineRev)}>
              Review again
            </Button>
          }
        >
          {PIPELINE_CHANGED_MESSAGE}
        </Banner>
      )}
      <FlowPicker flows={choices} value={flowId} onChange={setFlowId} label="New flow" disabled={disabled || busy} />
      {chosen &&
        (same ? (
          <p className="meta muted">This task already runs {chosen.name} at this version; nothing would change.</p>
        ) : preview && !preview.allowed ? (
          <Banner tone="fail">{preview.why}</Banner>
        ) : preview ? (
          <ul className="plain meta" aria-label="What this change does">
            {changeConsequences(preview).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null)}
      <Field label="Note (optional; recorded on the pipeline revision)">
        <Input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled || busy} />
      </Field>
      <Actions>
        <Button
          variant="primary"
          disabled={!canUse}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            const r = await send("changeFlow", { taskId: task.id, expectedRev: openedRev, flowId, note: note.trim() });
            setBusy(false);
            if (r.ok) onClose();
          }}
        >
          Use {chosen?.name ?? "flow"}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </Actions>
    </div>
  );
}
