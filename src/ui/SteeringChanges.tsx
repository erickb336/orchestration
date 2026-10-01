// The change list under a lead reply. The service wrote it; the lead's prose never is the
// record. Every row shows the task's live state, and every control is a keyed, compare-and-set command.
// The list folds into one line under the reply ("2 changes, 1 note · Undo all") that opens to
// the rows, so the conversation reads first. The fold line carries Undo (all) and Apply (all); each row keeps its own.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { diffLines } from "../domain/diff";
import * as M from "../domain/model";
import type { State, SteeringChange, SteeringChangeSet } from "../domain/types";
import { useStore } from "./store";
import { isSimulated, relTime, taskTone } from "./common";
import { Button, SimulatedChip, StatePill, useConfirm } from "./kit";
import { changeGroups, foldActions, foldSummary, noteStatusLabel, noteTargetLabel, noteTone, undoable } from "./notes";

type Act = { name: "undoSteering" | "applySteering" | "dismissSteering" | "rerunWithNote"; args: object };
type Ask = ReturnType<typeof useConfirm>;

/** One line that opens to what it summarises; `actions` sit on the line itself. */
export function Fold({ summary, actions, children }: { summary: string; actions?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  // Opened under the newest reply, the list would start below the fold of the conversation: bring it into view.
  useEffect(() => {
    if (open) body.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <div className="fold">
      <div className="fold-line">
        <Button variant="quiet" size="small" className="fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {summary}
        </Button>
        {actions && (
          <>
            <span className="muted" aria-hidden="true">
              ·
            </span>
            {actions}
          </>
        )}
      </div>
      <div id={id} ref={body} className="fold-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export function SteeringChanges({ set }: { set: SteeringChangeSet }) {
  const { state, service, send, disabled } = useStore();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, a: Act) => {
    setBusy(key);
    await send(a.name, a.args);
    setBusy(null);
  };
  const off = disabled || busy !== null;
  // The drawer's top line says "simulated" once for the whole demo; a simulated set seen outside the demo says it here.
  const simChip = isSimulated(set) && service.runtime !== "fake" ? <SimulatedChip title="Simulated: written by the demo's lead, not by a model." /> : null;

  if (set.refused) {
    return (
      <p className="fold-line muted small" role="note">
        The lead asked for changes, but none were applied: {set.refused}. {simChip}
      </p>
    );
  }
  const g = changeGroups(set);
  const actions = foldActions(set);
  const applyAll = async () => {
    const drops = g.suggested.filter((c) => c.kind === "drop");
    if (drops.length && !(await confirmDrops(confirm, state, drops))) return;
    void run("apply-all", { name: "applySteering", args: { changeSetId: set.id } });
  };
  return (
    <Fold
      summary={foldSummary(set)}
      actions={
        (actions.undo || actions.apply || simChip) && (
          <>
            {actions.undo && (
              <Button size="small" variant="quiet" disabled={off} title={g.notes.length ? "A sent note stays sent" : undefined} onClick={() => void run("undo-all", { name: "undoSteering", args: { changeSetId: set.id } })}>
                {actions.undo}
              </Button>
            )}
            {actions.apply && (
              <Button size="small" variant="quiet" disabled={off} onClick={() => void applyAll()}>
                {actions.apply}
              </Button>
            )}
            {simChip}
          </>
        )
      }
    >
      {set.heldBecause && g.suggested.length > 0 && (
        <p className="muted small fold-note" role="status">
          Held as suggestions: {lowerFirst(set.heldBecause)}
        </p>
      )}
      {set.notes.map((n, i) => (
        <p key={i} className="muted small fold-note">
          {n}
        </p>
      ))}
      <Section title="Changed" rows={[...g.changes, ...g.notes]} state={state}>
        {(c) =>
          undoable(c) && (
            <Button size="small" disabled={off} onClick={() => void run(c.id, { name: "undoSteering", args: { changeSetId: set.id, changeId: c.id } })}>
              Undo
            </Button>
          )
        }
      </Section>
      <Section title="Suggested" rows={g.suggested} state={state}>
        {(c) => (
          <>
            {c.kind === "note" && c.rerun && c.noteId && c.taskId && c.stepId ? (
              <Button
                size="small"
                disabled={off}
                title="The same as Rerun on the task page, with the note written into the new run's instructions"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Rerun ${c.stepId} with this note?`,
                    text: "Results of steps that depend on it will need revalidation, and any of them still running will be stopped.",
                    primaryLabel: "Rerun",
                  });
                  if (ok) void run(c.id, { name: "rerunWithNote", args: { taskId: c.taskId, stepId: c.stepId, noteId: c.noteId } });
                }}
              >
                Rerun with this note
              </Button>
            ) : (
              <Button
                size="small"
                disabled={off}
                onClick={async () => {
                  if (c.kind === "drop" && !(await confirmDrops(confirm, state, [c]))) return;
                  void run(c.id, { name: "applySteering", args: { changeSetId: set.id, changeId: c.id } });
                }}
              >
                {c.kind === "note" ? "Send" : "Apply"}
              </Button>
            )}
            <Button size="small" variant="quiet" disabled={off} onClick={() => void run(`${c.id}-dismiss`, { name: "dismissSteering", args: { changeSetId: set.id, changeId: c.id } })}>
              Dismiss
            </Button>
          </>
        )}
      </Section>
      <Section title="Not applied" rows={g.notApplied} state={state} />
      <Section title="Undone or dismissed" rows={g.resolved} state={state} struck />
    </Fold>
  );
}

const lowerFirst = (s: string) => (s ? `${s[0].toLowerCase()}${s.slice(1)}` : s);

function Section({ title, rows, state, struck, children }: { title: string; rows: SteeringChange[]; state: State; struck?: boolean; children?: (c: SteeringChange) => ReactNode }) {
  if (!rows.length) return null;
  return (
    <div className="changes-section">
      <h4 className="changes-title">{title}</h4>
      <ul className="changes-list">
        {rows.map((c) => (
          <Row key={c.id} state={state} c={c} struck={struck}>
            {children?.(c)}
          </Row>
        ))}
      </ul>
    </div>
  );
}

/**
 * A drop the user applies is an ordinary cancel, with no undo: say what each one stops and blocks first.
 * "Apply all" confirms its drops the same way, in one dialog.
 */
async function confirmDrops(confirm: Ask, state: State, rows: SteeringChange[]): Promise<boolean> {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const c of rows) {
    const t = state.tasks.find((x) => x.id === c.taskId);
    if (!t) continue;
    ids.push(t.id);
    const running = M.activeAttempts(state, t.id).length;
    const dependents = state.tasks.filter((x) => x.lifecycle !== "done" && x.lifecycle !== "cancelled" && x.dependsOn.includes(t.id)).map((x) => x.id);
    lines.push([`${t.id}: ${M.currentSpec(t).content.title}.`, running ? `${running} run${running === 1 ? " is" : "s are"} stopped (shown as Cancelling until confirmed).` : "", dependents.length ? `${dependents.join(", ")} would be blocked.` : ""].filter(Boolean).join(" "));
  }
  if (!lines.length) return false;
  return confirm({
    title: `Cancel ${ids.join(", ")}?`,
    text: [...lines, "A cancel cannot be undone. The spec and partial artifacts are kept."].join("\n"),
    primaryLabel: ids.length === 1 ? "Cancel the task" : "Cancel the tasks",
    cancelLabel: "Keep",
    danger: true,
  });
}

/** What became of a row, in a few words, when that is not plain from its group. */
function statusNote(state: State, c: SteeringChange): string | undefined {
  const resolved = c.resolvedAt ? relTime(c.resolvedAt) : undefined;
  if (c.status === "undone") return `undone by you${resolved ? ` ${resolved}` : ""}`;
  if (c.status === "dismissed") return `dismissed${resolved ? ` ${resolved}` : ""}`;
  if (c.status === "superseded") return "superseded by a later reply";
  if (c.status === "applied" && c.kind === "note") {
    // A note settled before it reached any run was recorded, not sent.
    const note = c.noteId ? M.noteOf(state, c.noteId) : undefined;
    return note?.status === "not-delivered" && !note.attemptId ? `recorded${c.appliedBy === "user" ? " by you" : ""}; it did not reach an agent` : `sent${c.appliedBy === "user" ? " by you" : ""}; no Undo: a sent note cannot be unsent`;
  }
  if (c.status === "applied" && c.appliedBy === "user") return `applied by you${resolved ? ` ${resolved}` : ""}`;
  return undefined;
}

function Row({ state, c, struck, children }: { state: State; c: SteeringChange; struck?: boolean; children?: ReactNode }) {
  const t = c.taskId ? state.tasks.find((x) => x.id === c.taskId) : undefined;
  const note = c.kind === "note" && c.noteId ? M.noteOf(state, c.noteId) : undefined;
  const after = statusNote(state, c);
  // A sent note's own note repeats its status chip ("queued: the step has not started"); other rows say why they were left as is.
  const why = c.note && !(c.kind === "note" && c.status === "applied") ? c.note : undefined;
  const taskLink = t ? <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> : <span className="mono">{c.taskId ?? "?"}</span>;
  // A note row reads "Note to WT-007 S2 (Coder · Claude): "…"" and shows the note's live status.
  const what =
    c.kind === "note" ? (
      <>
        Note to {t ? <a href={`#/task/${encodeURIComponent(t.id)}`}>{noteTargetLabel(state, c.taskId, c.stepId)}</a> : <span className="mono">{noteTargetLabel(state, c.taskId, c.stepId)}</span>}: “{String(c.after ?? "")}”
      </>
    ) : c.kind === "focus" ? (
      "Focus"
    ) : (
      <>
        {taskLink}
        {t && <span className="muted"> {M.currentSpec(t).content.title}</span>}
        {": "}
        {c.kind === "priority" && `P${String(c.before ?? "?")} → P${String(c.after ?? "?")} (next free slot; running work continues)`}
        {c.kind === "defer" && "Deferred (after its current step)"}
        {c.kind === "undefer" && "Runs again (deferral lifted)"}
        {c.kind === "drop" && (c.appliedBy === "user" ? "Cancelled" : "Dropped (had not started)")}
        {c.kind === "invalid" && "an entry the service could not read"}
      </>
    );
  return (
    <li className={`change${struck ? " struck" : ""}`}>
      <div className="change-line">
        <span className="change-what">{what}</span>
        {note && (
          <StatePill tone={noteTone(note)} pulse={note.status === "sending"}>
            {noteStatusLabel(note)}
          </StatePill>
        )}
        {t && c.kind !== "note" && <StatePill {...taskTone(state, t)}>{M.stateLabel(state, t)}</StatePill>}
        {children && <span className="change-actions">{children}</span>}
      </div>
      {(after || why) && (
        <div className="muted small">
          {after}
          {after && why ? " — " : ""}
          {why}
        </div>
      )}
      {c.kind === "focus" && <FocusDiff before={String(c.before ?? "")} after={String(c.after ?? "")} />}
      {c.why && <div className="muted small change-why">“{c.why}”</div>}
    </li>
  );
}

export function FocusDiff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before.split("\n"), after.split("\n"));
  return (
    <div className="diff focus-diff" aria-label="Focus change">
      {lines.map((d, i) => (
        <div key={i} className={d.kind}>
          {d.text}
        </div>
      ))}
    </div>
  );
}
