// What stands between the task and its next step, one banner each: a stop in progress, a
// prerequisite, a pause, a deferral, a conflict. A banner carries a button only where that button is the
// answer (Retry stop, Run now, Retry integration); Pause, Resume and Start live in the header and under
// Needs you. The decisions that need you are not here either (NeedsYou.tsx).

import type { ReactNode } from "react";
import * as C from "../../domain/checks";
import * as D from "../../domain/delivery";
import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import type { State, Task } from "../../domain/types";
import { relTime } from "../common";
import { heldByBudget } from "../../domain/model/presentation";
import { budgetStop } from "../../domain/spend";
import { Banner, Button, ButtonLink } from "../kit";
import { useStore } from "../store";
import { droppedPartsWords } from "../studio/draftView";
import { isOpenTask, leadDecisions } from "./needsYouItems";

export function StatusBanners({ state, task, onEdit }: { state: State; task: Task; onEdit?: () => void }) {
  const { send, disabled } = useStore();
  const active = M.activeAttempts(state, task.id);
  const stopping = active.filter((a) => a.outcome === "stopping");
  const current = M.currentSpec(task).rev;
  const executingRevs = [...new Set(active.map((a) => a.snapshot.specRev))];
  const blocked = M.blockedReason(state, task);
  const waiting = M.waitingOn(state, task);
  const open = isOpenTask(task);
  const out: ReactNode[] = [];

  if (task.legacySpecUnavailable && open)
    out.push(
      <Banner
        key="legacy"
        tone="you"
        title="Imported without a spec."
        actions={
          onEdit && (
            <Button size="small" onClick={onEdit}>
              Edit spec
            </Button>
          )
        }
      >
        Write a spec before this task can run; until then it is never started.
      </Banner>,
    );
  if (task.controlFailure)
    out.push(
      <Banner
        key="cf"
        tone="fail"
        title="Control failure."
        actions={
          <Button size="small" disabled={disabled} onClick={() => void send("retryStop", { taskId: task.id })}>
            Retry stop
          </Button>
        }
      >
        {task.controlFailure.message}
      </Banner>,
    );
  else if (stopping.length) {
    // "The change is saved" is true only of a step that writes code; a stopping review or design has no change to save.
    const changesCode = stopping.some((a) => task.steps.find((st) => st.id === a.stepId)?.outputs.some((o) => o.kind === "code-change"));
    out.push(
      <Banner key="stop" title={`${M.stopLabel(state, task)}…`}>
        {changesCode ? "The change is saved. " : ""}Waiting for {stopping.length === 1 ? "the agent" : `${stopping.length} agents`} to acknowledge the stop; nothing new starts and nothing merges until {stopping.length === 1 ? "it does" : "they do"}.
        {changesCode ? " Partial changes are checkpointed." : ""}
      </Banner>,
    );
  }
  if (executingRevs.length && executingRevs.some((r) => r !== current))
    out.push(
      <Banner key="rev" tone="you">
        Runs are still on spec r{executingRevs.join(", r")}; the spec is now r{current}. Their results will not integrate.
      </Banner>,
    );
  if (blocked)
    out.push(
      <Banner key="blk" tone="fail" title="Blocked.">
        {blocked}
      </Banner>,
    );
  else if (waiting && task.lifecycle !== "done")
    out.push(
      <Banner key="wait">
        {M.waitingDetail(state, waiting) ? (
          <>
            {M.waitingDetail(state, waiting)} (<a href={`#/task/${waiting}`}>{waiting}</a>). With pull-request delivery, a task starts only once its prerequisite's code is in the base it starts from.
          </>
        ) : (
          <>
            Waiting on <a href={`#/task/${waiting}`}>{waiting}</a> to finish. Unfinished results of a prerequisite are never used.
          </>
        )}
      </Banner>,
    );
  const lead = open ? leadDecisions(state, task) : [];
  if (lead.length)
    out.push(
      <Banner key="lead-decisions">
        {F.agentsDecidingLabel(lead)} on this task. You can take any of them over under Details › Outputs (Send to me).
      </Banner>,
    );
  const heldWriters = open ? D.writersHeld(state) : undefined;
  if (heldWriters && task.steps.some((st) => st.state === "pending" && st.role === "coder"))
    out.push(
      <Banner key="writers">
        Coder steps are {heldWriters}. Nothing is blocked; they start once the base has been fetched.
      </Banner>,
    );
  if (task.steps.some((st) => st.state === "pending" && st.role === "checks") && C.checksOn(state.project.checks) && C.checksHeld(state) && open)
    out.push(
      <Banner key="sandbox">
        {C.HELD_LABEL}. Nothing runs without the sandbox.
      </Banner>,
    );
  if (task.hold && !stopping.length && task.holdReason)
    out.push(
      <Banner key="hold" tone="you" title={`Paused for review: ${task.holdReason}.`}>
        Read or edit the outputs under Details, then Resume.
      </Banner>,
    );
  else if (task.hold && !stopping.length)
    out.push(
      <Banner key="hold">
        {task.pausedWith ? (
          <>
            Paused with <a href={`#/task/${task.pausedWith}`}>{task.pausedWith}</a>. Resuming {task.pausedWith} resumes this task too, or resume it on its own.
          </>
        ) : (
          "Paused by you. Edits keep it paused; it runs again only after you resume it."
        )}
      </Banner>,
    );
  // The roadmap's hold and the user's hold before start are different things and shown as such.
  if (task.heldForShaping && task.lifecycle !== "active")
    out.push(
      <Banner key="hfs">
        Planned in Vision: it waits until you start the factory{M.waitingOn(state, task) ? ` and on ${M.waitingOn(state, task)}` : ""}, then {M.startFactoryPlan(state).release ? "starts on Autopilot" : "waits for your go-ahead"} (your involvement setting at the moment you start the factory decides). Changing "Wait for my go-ahead" under More takes it out of the roadmap's wait.{" "}
        <a href="#/vision">Work on the vision</a>
      </Banner>,
    );
  // Only the building budget holds it: say why, and where to raise the budget or continue past it (ORC-030 Q-24).
  const stop = heldByBudget(state, task) ? budgetStop(state) : undefined;
  if (stop)
    out.push(
      <Banner
        key="budget"
        tone="you"
        title="The building budget holds it."
        actions={
          <ButtonLink size="small" href="#/settings/project/budgets">
            Budgets
          </ButtonLink>
        }
      >
        {stop.why}. Nothing new starts until you raise the budget or continue past it.
      </Banner>,
    );
  // A task that builds a part you dropped (a retirement you undid, say): nothing stops it, so say so (ORC-030 Q-13).
  const dropped = open ? droppedPartsWords(state, task) : undefined;
  if (dropped)
    out.push(
      <Banner key="dropped" tone="you" title="It builds a part you dropped.">
        {dropped.names} left the design{dropped.at}. If it should not be built, cancel this task under More, or edit its spec.
      </Banner>,
    );
  // A deferral is not a pause. The running step finishes and its result is kept; then nothing new starts.
  const deferral = open ? M.deferredBy(state, task) : undefined;
  if (deferral) {
    const own = deferral.task.id === task.id;
    const set = deferral.deferral.changeSetId ? state.steering.find((cs) => cs.id === deferral.deferral.changeSetId) : undefined;
    const row = set?.changes.find((c) => c.kind === "defer" && c.taskId === deferral.task.id && c.status === "applied" && c.appliedBy === "lead");
    const runningNow = active.some((a) => a.outcome === "running");
    const title = `${own ? (deferral.deferral.by === "lead" ? "Deferred by the lead from your message" : "Deferred by you") : `Deferred with ${deferral.task.id}`}${deferral.deferral.reason ? `: ${deferral.deferral.reason.trim().replace(/\.+$/, "")}` : ""}.`;
    out.push(
      <Banner
        key="deferral"
        title={title}
        actions={
          own && (
            <>
              <Button size="small" disabled={disabled} onClick={() => void send("undeferTask", { taskId: task.id })} title="Lift the deferral and keep this task running whatever the focus">
                Run now
              </Button>
              {row && set && (
                <Button size="small" variant="quiet" disabled={disabled} onClick={() => void send("undoSteering", { changeSetId: set.id, changeId: row.id })}>
                  Undo
                </Button>
              )}
            </>
          )
        }
      >
        {runningNow ? "This step finishes and its result is kept, then nothing new starts." : "Nothing new starts on this task until it runs again."}
        {task.holdBeforeStart && task.lifecycle !== "active" ? " It also still waits for your go-ahead." : ""}
        {!own && (
          <>
            {" "}
            Run <a href={`#/task/${encodeURIComponent(deferral.task.id)}`}>{deferral.task.id}</a> now to continue.
          </>
        )}
      </Banner>,
    );
  }
  if (task.lifecycle === "done") {
    const integ = task.integration;
    if (integ?.status === "conflict")
      out.push(
        <Banner
          key="integ"
          tone="fail"
          title="Integration conflict."
          actions={
            <Button size="small" disabled={disabled} onClick={() => void send("retryIntegration", { taskId: task.id })}>
              Retry integration
            </Button>
          }
        >
          {integ.message ?? integ.ref ?? "The change could not be merged"}. The lead sees this in its next planning run; resolve it by merging the branch yourself or by a follow-up task, then retry.
        </Banner>,
      );
    if (integ?.delivered?.status === "conflict")
      out.push(
        <Banner key="deliver" tone="fail" title="Delivery conflict.">
          {integ.delivered.message} The work stays on the integration branch; a follow-up task or a manual merge resolves it.
        </Banner>,
      );
    else if (integ?.delivered && integ.delivered.status !== "delivered")
      out.push(
        <Banner key="delivered">
          Not landed yet: {integ.delivered.message} <span className="muted">· {relTime(integ.delivered.at)}</span>
        </Banner>,
      );
  }
  if (task.lifecycle === "cancelled")
    out.push(
      <Banner key="cancelled">Cancelled{task.cancelledBy === "lead" ? " by the lead" : task.cancelledBy === "user" ? " by you" : ""}. The spec and the outputs so far are kept; nothing runs on it again.</Banner>,
    );
  if (!out.length) return null;
  return <div className="k-stack k-stack--tight">{out}</div>;
}
