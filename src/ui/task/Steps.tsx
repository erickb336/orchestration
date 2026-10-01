// The task's steps as a plain list: name, who works on it, and the state in words. The running step keeps
// "Send a note" and its notes; a blocked step keeps Retry. Models, run ids and
// context sit under Details.

import { useState } from "react";
import * as M from "../../domain/model";
import { MAX_NOTE_LENGTH, type Note, type State, type Step, type Task } from "../../domain/types";
import { ROLE_LABEL, fmtTime, relTime } from "../common";
import { flowLineText } from "../flowView";
import { Actions, Button, Card, Chip, Field, SimulatedChip, StatePill, StepList, Textarea, type StepItem } from "../kit";
import { canSendNote, noteSourceLabel, noteStatusLabel, noteTone } from "../notes";
import { useStore } from "../store";
import { stepWords } from "./stepWords";
import { isOpenTask } from "./needsYouItems";

/** "Feature flow" for one of the six flows; the longer line for a pipeline from before flows or a custom one. */
export function flowChip(ref: Task["flow"]): string {
  return ref.source === "built-in" ? `${ref.name} flow` : flowLineText(ref);
}

export function StepsCard({ state, task }: { state: State; task: Task }) {
  const open = isOpenTask(task);
  const steps: StepItem[] = task.steps.map((st) => {
    const w = stepWords(state, task, st);
    const action = open ? <StepAction state={state} task={task} st={st} /> : null;
    return {
      id: st.id,
      name: (
        <>
          {w.name}
          {w.round && (
            <>
              {" "}
              <Chip>round {w.round}</Chip>
            </>
          )}
        </>
      ),
      who: w.who,
      state: w.state,
      mark: w.mark,
      action,
    };
  });
  return (
    <Card title="Steps" className="t-steps" actions={<Chip strong>{flowChip(task.flow)}</Chip>}>
      <StepList label={`Steps of ${task.id}`} steps={steps} />
    </Card>
  );
}

/** What the person can do on this step right now: Retry when blocked; Send a note while it runs; the notes waiting for it. */
function StepAction({ state, task, st }: { state: State; task: Task; st: Step }) {
  const { send, disabled } = useStore();
  const queued = M.queuedNotes(state, task.id, st.id);
  // The notes the running agent was given (sent, delivered), so a note you just sent is in view.
  const active = M.activeAttempts(state, task.id).find((a) => a.stepId === st.id);
  const live = active ? M.notesOfRun(state, active.id) : [];
  const retry = st.state === "blocked" && (
    <Actions>
      <Button size="small" aria-label={`Retry ${st.id}`} disabled={disabled} onClick={() => void send("retryStep", { taskId: task.id, stepId: st.id })}>
        Retry
      </Button>
    </Actions>
  );
  const note = <SendNote state={state} task={task} st={st} />;
  return (
    <>
      {retry}
      {note}
      {live.length > 0 && <NotesList notes={live} label={`Notes to the agent running ${st.id}`} />}
      {queued.length > 0 && (
        <div className="small">
          <span className="muted">Waiting for its next run:</span>
          <NotesList notes={queued} label={`Notes waiting for ${st.id}`} />
        </div>
      )}
    </>
  );
}

/**
 * The "Send a note" control on a running agent step (never a Checks step), and the one-paragraph
 * form it opens. The note is guidance within the spec; the service decides which run gets it.
 */
function SendNote({ state, task, st }: { state: State; task: Task; st: Step }) {
  const { send, disabled, service } = useStore();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // An open form with a draft stays when the run ends meanwhile, so the text is not lost; Send waits for a run.
  const can = canSendNote(state, task, st.id);
  if (!can && !(open && text)) return null;
  const length = text.replace(/\s+/g, " ").trim().length;
  const tooLong = length > MAX_NOTE_LENGTH;
  if (!open)
    return (
      <Actions>
        <Button size="small" aria-label={`Send a note to ${st.id}`} disabled={disabled} title="A short instruction for the running agent; it reaches it at its next step and is kept on the record" onClick={() => setOpen(true)}>
          Send a note
        </Button>
      </Actions>
    );
  const hint = !can
    ? `${st.id} is no longer running, so this note cannot reach it. Ask the lead to rerun ${st.id} with it, or cancel.`
    : `One paragraph, ${length}/${MAX_NOTE_LENGTH}. Guidance within the spec; the agent keeps its work so far.${service.runtime === "fake" ? " In the demo the agent acknowledges after a moment." : ""}`;
  return (
    <form
      className="t-note-form"
      aria-label={`Note to ${st.id}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!can || !length || tooLong || busy) return;
        setBusy(true);
        const r = await send("sendNote", { taskId: task.id, stepId: st.id, text });
        setBusy(false);
        if (r.ok) {
          setText("");
          setOpen(false);
        }
      }}
    >
      <Field label={`Note to the ${ROLE_LABEL[st.role].toLowerCase()} ${can ? "running" : "of"} ${st.id}`} hint={hint} error={tooLong ? `Notes are limited to ${MAX_NOTE_LENGTH} characters.` : undefined}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={3} placeholder="For example: skip the README; I will write it." />
      </Field>
      <Actions>
        <Button type="submit" size="small" variant="primary" disabled={disabled || busy || !can || !length || tooLong} loading={busy}>
          {busy ? "Sending…" : "Send"}
        </Button>
        <Button
          size="small"
          variant="quiet"
          onClick={() => {
            setOpen(false);
            setText("");
          }}
        >
          Cancel
        </Button>
      </Actions>
    </form>
  );
}

/** Notes, each with its status, its source and its time; "simulated" in the demo. */
export function NotesList({ notes, label }: { notes: Note[]; label: string }) {
  const { state } = useStore();
  if (!notes.length) return null;
  return (
    <ul className="t-notes" aria-label={label}>
      {notes.map((n) => (
        <li key={n.id}>
          <div className="t-notes__head">
            <StatePill tone={noteTone(n)} pulse={n.status === "sending"}>
              {noteStatusLabel(n)}
            </StatePill>
            {n.simulated && <SimulatedChip title="Written by the demo's lead, or acknowledged by a simulated run; no agent read it." />}
            <span>
              {noteSourceLabel(state, n)} ·{" "}
              <time dateTime={n.at} title={fmtTime(n.at)}>
                {relTime(n.at)}
              </time>
            </span>
          </div>
          <div className="t-notes__text">“{n.text}”</div>
        </li>
      ))}
    </ul>
  );
}
