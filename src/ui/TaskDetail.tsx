import { useEffect, useState } from "react";
import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import { diffLines, specToLines } from "../domain/diff";
import { MAX_NOTE_LENGTH, ROLES, type Artifact, type Attempt, type Note, type State, type Step, type Task } from "../domain/types";
import { newIdOf, useStore } from "./store";
import { checkLogUrl } from "../api";
import * as C from "../domain/checks";
import { ModelPicker, Pill, ROLE_LABEL, StatePill, fmtTime, relTime, selectionText, useNarrow, type Tone } from "./common";
import { canSendNote, noteSourceLabel, noteStatusLabel, noteTone } from "./notes";
import { DeliveryCard } from "./Delivery";
import { CheckResults, CoverageChip, DecisionControls, DecisionQueue, FindingsList } from "./Findings";
import { SpecEditor } from "./SpecEditor";
import { childrenOfArtifact, copyGroup, isSettledTask, notChosen, stepChips } from "./fanout";
import { useLeadContext } from "./LeadDrawer";
import { FlowPicker } from "./FlowPicker";
import { PIPELINE_CHANGED_MESSAGE, changeConsequences, earlierFlowLabel, flowLineParts, principlesText, revisionFlowLabel, sameFlow } from "./flowView";
import { stepPrinciples } from "../domain/principles";

export function TaskDetail({ id }: { id: string }) {
  const { state } = useStore();
  const [editing, setEditing] = useState(false);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) {
    return (
      <div className="card">
        <p>No task {id}.</p>
        <a href="#/tasks">Back to tasks</a>
      </div>
    );
  }
  const spec = M.currentSpec(task);
  const c = spec.content;

  return (
    <>
      <a href="#/tasks">← Tasks</a>
      <div className="detail-head" style={{ marginTop: "0.5rem" }}>
        <div className="titles">
          <div className="row">
            <span className="mono muted">{task.id}</span>
            <StatePill state={state} task={task} />
            <span className="chip">P{task.priority}</span>
            <span className="chip">{c.area}</span>
            <span className="chip">spec r{spec.rev}</span>
            {task.legacySpecUnavailable && <span className="chip">legacy spec unavailable</span>}
            <span className="chip">{task.specs[0]?.author === "lead" ? "Proposed by the lead" : "Created by you"}</span>
            {task.parentTaskId && (
              <span className="chip">
                part of <a href={`#/task/${encodeURIComponent(task.parentTaskId)}`}>{task.parentTaskId}</a>
              </span>
            )}
            {task.followUpOf && (
              <span className="chip">
                follow-up of <a href={`#/task/${task.followUpOf}`}>{task.followUpOf}</a>
              </span>
            )}
          </div>
          <h1 style={{ marginTop: "0.35rem" }}>{c.title}</h1>
        </div>
        <Controls state={state} task={task} editing={editing} onEdit={() => setEditing(true)} />
      </div>

      <StatusBanners state={state} task={task} onEdit={editing ? undefined : () => setEditing(true)} />
      {task.lifecycle === "done" && <DeliveryCard state={state} task={task} />}

      {editing ? (
        <SpecEditor key={task.id} task={task} onClose={() => setEditing(false)} />
      ) : (
        <div className="grid-2">
          <div>
            <OutcomeCard task={task} />
            <ChildTasksCard state={state} task={task} />
            <OptionsCard task={task} />
            <DetailsCard task={task} />
            <StepsCard state={state} task={task} />
          </div>
          <div>
            <ArtifactsCard state={state} task={task} />
            <RunsCard state={state} task={task} />
            <TaskActivity state={state} task={task} />
            <RevisionsCard key={task.specs.length} task={task} />
          </div>
        </div>
      )}
    </>
  );
}

function Controls({ state, task, editing, onEdit }: { state: State; task: Task; editing: boolean; onEdit: () => void }) {
  const { send, disabled } = useStore();
  const lead = useLeadContext();
  const [prio, setPrio] = useState(String(task.priority));
  useEffect(() => setPrio(String(task.priority)), [task.priority]);
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const provenance = M.priorityProvenance(state, task);
  const askLead = (
    <button onClick={() => lead.openLead({ taskId: task.id })} title="Your message carries this task as context">
      Ask the lead about this task
    </button>
  );
  if (!open) {
    return (
      <div className="controls">
        {askLead}
        {task.lifecycle === "done" && (
          <button
            disabled={disabled}
            onClick={async () => {
              const newId = newIdOf(await send("createFollowUp", { taskId: task.id }));
              if (newId) location.hash = `#/task/${encodeURIComponent(newId)}`;
            }}
          >
            Create follow-up
          </button>
        )}
      </div>
    );
  }
  const pausing = task.hold && M.activeAttempts(state, task.id).some((a) => a.outcome === "stopping");
  return (
    <div className="controls">
      {task.hold ? (
        <button className="primary" onClick={() => void send("resumeTask", { taskId: task.id })} disabled={disabled || pausing} title={pausing ? "Waiting for runs to acknowledge stopping" : undefined}>
          Resume
        </button>
      ) : (
        <button className="primary" disabled={disabled} onClick={() => void send("pauseTask", { taskId: task.id })}>
          Pause
        </button>
      )}
      {task.holdBeforeStart && task.lifecycle !== "active" && (
        <button disabled={disabled} onClick={() => void send("startHeldTask", { taskId: task.id })}>
          Release hold before start
        </button>
      )}
      <button onClick={onEdit} disabled={editing}>
        Edit spec
      </button>
      {askLead}
      <span className="row" style={{ gap: "0.3rem" }}>
        <label className="row" style={{ gap: "0.3rem" }}>
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Priority
          </span>
          <input type="number" min={1} value={prio} onChange={(e) => setPrio(e.target.value)} style={{ width: "4rem" }} />
          <button className="small" disabled={disabled || Number(prio) === task.priority} onClick={() => void send("setPriority", { taskId: task.id, priority: Number(prio) })}>
            Set
          </button>
        </label>
        <span className="provenance">
          {provenance.kind === "user" && (
            <>
              set by you ·{" "}
              <button className="link" disabled={disabled} onClick={() => void send("setPriorityPin", { taskId: task.id, pinned: false })}>
                Let the lead reorder this
              </button>
            </>
          )}
          {provenance.kind === "lead" && (
            <>
              set by the lead (was P{provenance.was}) ·{" "}
              <button className="link" disabled={disabled} onClick={() => void send("undoSteering", { changeSetId: provenance.changeSetId, changeId: provenance.changeId })}>
                Undo
              </button>{" "}
              ·{" "}
              <button className="link" disabled={disabled} title="The lead may not reorder it again" onClick={() => void send("setPriorityPin", { taskId: task.id, pinned: true })}>
                Keep P{task.priority}
              </button>
            </>
          )}
          {provenance.kind === "auto" && (
            <>
              Auto: the lead may reorder it when you steer ·{" "}
              <button className="link" disabled={disabled} title="The lead may not reorder it" onClick={() => void send("setPriorityPin", { taskId: task.id, pinned: true })}>
                Pin P{task.priority}
              </button>
            </>
          )}
          {provenance.kind === "child" && `Runs at ${provenance.rootId}'s priority (P${provenance.priority}); Set pins its own`}
        </span>
      </span>
      <label className="row" style={{ gap: "0.3rem", fontSize: "0.85rem" }} title="The lead may not defer this task when you steer">
        <input type="checkbox" checked={!!task.userSet?.run} disabled={disabled} onChange={(e) => void send("setRunPin", { taskId: task.id, pinned: e.target.checked })} />
        Keep running whatever the focus
      </label>
      <button
        className="danger"
        disabled={disabled}
        onClick={() => {
          if (confirm(`Cancel ${task.id}? Running work is stopped; the spec and partial artifacts are kept.`)) void send("cancelTask", { taskId: task.id });
        }}
      >
        Cancel task
      </button>
    </div>
  );
}

function StatusBanners({ state, task, onEdit }: { state: State; task: Task; onEdit?: () => void }) {
  const { send, disabled, service } = useStore();
  const active = M.activeAttempts(state, task.id);
  const stopping = active.filter((a) => a.outcome === "stopping");
  const current = M.currentSpec(task).rev;
  const executingRevs = [...new Set(active.map((a) => a.snapshot.specRev))];
  const blocked = M.blockedReason(state, task);
  const waiting = M.waitingOn(state, task);
  const out: React.ReactNode[] = [];

  if (task.legacySpecUnavailable && task.lifecycle !== "done" && task.lifecycle !== "cancelled")
    out.push(
      <div className="banner" role="status" key="legacy">
        <strong>Imported without a spec.</strong> Write a spec (Edit spec) before this task can run; until then it is never dispatched.{" "}
        {onEdit && (
          <button className="small" onClick={onEdit}>
            Edit spec
          </button>
        )}
      </div>,
    );
  if (task.controlFailure)
    out.push(
      <div className="banner danger" role="alert" key="cf">
        <strong>Control failure.</strong> {task.controlFailure.message}{" "}
        <button className="small" disabled={disabled} onClick={() => void send("retryStop", { taskId: task.id })}>
          Retry stop
        </button>
      </div>,
    );
  else if (stopping.length)
    out.push(
      <div className="banner" role="status" key="stop">
        <strong>{M.stopLabel(state, task)}.</strong> The change is saved. Waiting for{" "}
        {stopping.length} run(s) to acknowledge stopping; no new work is dispatched and nothing integrates until they do. Partial changes will be checkpointed.
      </div>,
    );
  if (executingRevs.length && executingRevs.some((r) => r !== current))
    out.push(
      <div className="banner" key="rev">
        Runs are still on spec r{executingRevs.join(", r")}; current is r{current}. Their results will not integrate.
      </div>,
    );
  else if (executingRevs.length && !stopping.length)
    out.push(
      <div className="banner neutral" key="exec">
        Executing spec r{current}{service.runtime === "real" ? "" : " (simulated)"}.
      </div>,
    );
  if (blocked)
    out.push(
      <div className="banner danger" key="blk">
        <strong>Blocked.</strong> {blocked}
      </div>,
    );
  else if (waiting && task.lifecycle !== "done")
    out.push(
      <div className="banner neutral" key="wait">
        {M.waitingDetail(state, waiting) ? (
          <>
            {M.waitingDetail(state, waiting)} (<a href={`#/task/${waiting}`}>{waiting}</a>). With pull-request delivery, a task starts only once its prerequisite's code is in the base it starts from.
          </>
        ) : (
          <>
            Waiting on prerequisite <a href={`#/task/${waiting}`}>{waiting}</a>. Unfinished results from prerequisites are never used.
          </>
        )}
      </div>,
    );
  // ORC-013: findings that wait for a decision. A step that would read them is neither started nor skipped.
  const awaiting = task.lifecycle === "active" ? F.awaitingDecision(state, task) : undefined;
  const myDecisions = F.openDecisions(state, "user").filter((d) => d.taskId === task.id);
  const leadDecisions = F.openDecisions(state, "lead").filter((d) => d.taskId === task.id);
  if (awaiting || myDecisions.length || leadDecisions.length)
    out.push(
      <div className="banner review" role="status" key="decisions">
        <strong>{awaiting ? `${F.awaitingLabel(awaiting)}.` : "Findings need a decision."}</strong>{" "}
        {myDecisions.length ? "Decide each finding below; the repair fixes only what is decided “Fix” or marked auto-fix." : ""}
        {leadDecisions.length ? ` The lead is deciding ${leadDecisions.length} finding${leadDecisions.length === 1 ? "" : "s"}; you can take any of them over from the artifact below.` : ""}
        {myDecisions.length > 0 && (
          <div style={{ marginTop: "0.4rem" }}>
            <DecisionQueue state={state} taskId={task.id} showLead={false} />
          </div>
        )}
      </div>,
    );
  // ORC-013 §6.7: a Final checks step whose run did not pass waits for a decision: a repair round, or the user's acceptance.
  const finalChecks = task.steps.filter((st) => st.role === "checks" && st.state === "blocked" && st.blockedReason?.startsWith("Checks failed"));
  for (const st of finalChecks) {
    const d = state.decisions.find((x) => x.kind === "final-checks" && x.taskId === task.id && x.status === "open" && state.artifacts.find((a) => a.id === x.artifactId)?.stepId === st.id);
    out.push(
      <div className="banner danger" role="alert" key={`final-${st.id}`}>
        <strong>Checks failed on the final change.</strong> {st.blockedReason}{" "}
        {d ? (
          <>
            {d.routedTo === "lead" && d.status === "open" ? <span className="muted">The lead is deciding whether to add a repair round; only you can accept failing checks. </span> : null}
            <DecisionControls decision={d} />
          </>
        ) : (
          <span className="muted">The decision is recorded on the artifact below.</span>
        )}
      </div>,
    );
  }
  const heldWriters = task.lifecycle !== "done" && task.lifecycle !== "cancelled" ? D.writersHeld(state) : undefined;
  if (heldWriters && task.steps.some((st) => st.state === "pending" && st.role === "coder"))
    out.push(
      <div className="banner neutral" role="status" key="writers">
        Coder steps are {heldWriters}. Nothing is blocked; they start once the base has been fetched.
      </div>,
    );
  if (task.hold && !stopping.length && task.holdReason)
    out.push(
      <div className="banner review" role="status" key="hold">
        <strong>Paused for review:</strong> {task.holdReason}. Read or edit the artifacts below, then Resume.{" "}
        {task.lifecycle !== "done" && task.lifecycle !== "cancelled" && (
          <button className="small primary" disabled={disabled} onClick={() => void send("resumeTask", { taskId: task.id })}>
            Resume
          </button>
        )}
      </div>,
    );
  else if (task.hold && !stopping.length)
    out.push(
      <div className="banner neutral" key="hold">
        {task.pausedWith ? (
          <>
            Paused with <a href={`#/task/${task.pausedWith}`}>{task.pausedWith}</a>. Resuming {task.pausedWith} resumes this task too, or resume it on its own.
          </>
        ) : (
          "Paused by you. Edits keep it paused; it runs again only after you resume it."
        )}
      </div>,
    );
  // ORC-012 review 2: the roadmap's hold and the user's hold before start are different things and shown as such.
  if (task.heldForShaping && task.lifecycle !== "active")
    out.push(
      <div className="banner neutral" key="hfs">
        Planned while shaping: it waits until you start building{M.waitingOn(state, task) ? ` and on ${M.waitingOn(state, task)}` : ""}, then {M.startBuildingPlan(state).release ? "starts on Autopilot" : "waits for your release"} (your involvement setting at the moment you start building decides). Changing its hold below takes it out of the roadmap hold.{" "}
        <a href="#/overview">Shape the vision</a>
      </div>,
    );
  if (task.holdBeforeStart && task.lifecycle !== "active")
    out.push(
      <div className="banner neutral" key="hbs">
        Held before start: this task will not be dispatched until you release it.
      </div>,
    );
  // ORC-009: a deferral is not a pause. The running step finishes and its result is kept; then nothing new starts.
  const deferral = task.lifecycle !== "done" && task.lifecycle !== "cancelled" ? M.deferredBy(state, task) : undefined;
  if (deferral) {
    const own = deferral.task.id === task.id;
    const set = deferral.deferral.changeSetId ? state.steering.find((cs) => cs.id === deferral.deferral.changeSetId) : undefined;
    const row = set?.changes.find((c) => c.kind === "defer" && c.taskId === deferral.task.id && c.status === "applied" && c.appliedBy === "lead");
    const runningNow = active.some((a) => a.outcome === "running");
    out.push(
      <div className="banner neutral" role="status" key="deferral">
        <strong>
          {own ? (deferral.deferral.by === "lead" ? "Deferred by the lead from your message" : "Deferred by you") : `Deferred with ${deferral.task.id}`}
          {deferral.deferral.reason ? `: ${deferral.deferral.reason}` : ""}.
        </strong>{" "}
        {runningNow ? "This step finishes and its result is kept, then nothing new starts." : "Nothing new starts on this task until it runs again."}
        {task.holdBeforeStart && task.lifecycle !== "active" ? " It also still needs its hold before start released." : ""}{" "}
        {own ? (
          <button className="small" disabled={disabled} onClick={() => void send("undeferTask", { taskId: task.id })} title="Lift the deferral and keep this task running whatever the focus">
            Run now
          </button>
        ) : (
          <>
            Run <a href={`#/task/${encodeURIComponent(deferral.task.id)}`}>{deferral.task.id}</a> now to continue.
          </>
        )}{" "}
        {own && row && set && (
          <button className="small" disabled={disabled} onClick={() => void send("undoSteering", { changeSetId: set.id, changeId: row.id })}>
            Undo
          </button>
        )}{" "}
        {runningNow && !task.hold && (
          <button className="small" disabled={disabled} onClick={() => void send("pauseTask", { taskId: task.id })} title="Interrupt the running step now; it shows Pausing until the runtime confirms">
            Pause now
          </button>
        )}
      </div>,
    );
  }
  if (task.lifecycle === "done") {
    const integ = task.integration;
    if (integ?.status === "conflict")
      out.push(
        <div className="banner danger" role="alert" key="integ">
          <strong>Integration conflict:</strong> {integ.message ?? integ.ref ?? "the change could not be merged"}. The lead sees this in its next planning run; resolve it by merging the branch yourself or by a
          follow-up task, then retry.{" "}
          <button className="small" disabled={disabled} onClick={() => void send("retryIntegration", { taskId: task.id })}>
            Retry integration
          </button>
        </div>,
      );
    out.push(
      <div className="banner neutral" key="done">
        Delivered on spec r{current}. The delivered spec is read-only; create a follow-up to change it.
        {integ && integ.status !== "conflict" && (
          <div style={{ marginTop: "0.3rem" }}>
            {integ.status === "pending" && (integ.message ? `Integration is waiting: ${integ.message}. It retries automatically.` : "Waiting for integration.")}
            {integ.status === "integrated" && (
              <>
                {integ.pr ? "Prepared as a pull request branch" : "Integrated into the integration branch"}
                {integ.ref ? ": " : "."}
                {integ.ref && <span className="mono">{integ.ref}</span>}
                {integ.at && <span className="muted"> · {relTime(integ.at)}</span>}
              </>
            )}
            {integ.status === "not-needed" && (task.legacySpecUnavailable ? "Imported as done; its original spec and changes are not recorded here." : "Nothing to integrate (no code change).")}
          </div>
        )}
        {integ?.delivered && integ.delivered.status !== "conflict" && (
          <div style={{ marginTop: "0.3rem" }}>
            {integ.delivered.status === "delivered" ? "Delivered to your branch: " : "Not delivered yet: "}
            {integ.delivered.message} <span className="muted">· {relTime(integ.delivered.at)}</span>
          </div>
        )}
      </div>,
    );
    if (integ?.delivered?.status === "conflict")
      out.push(
        <div className="banner danger" role="alert" key="deliver">
          <strong>Delivery conflict:</strong> {integ.delivered.message} The work stays on the integration branch; a follow-up task or a manual merge resolves it.
        </div>,
      );
  }
  return <>{out}</>;
}

function OutcomeCard({ task }: { task: Task }) {
  const c = M.currentSpec(task).content;
  const sel = c.options.find((o) => o.id === c.selectedOptionId);
  const rec = c.options.find((o) => o.id === c.recommendedOptionId);
  const overridden = c.selectedOptionId !== c.recommendedOptionId;
  return (
    <section className="card" aria-labelledby="outcome-h">
      <h2 id="outcome-h">Outcome</h2>
      <p>{c.outcome}</p>
      <p className="muted">{c.benefit}</p>
      {sel && (
        <div className="approach">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>
              Chosen approach {sel.id}: {sel.name}
            </strong>
            <span className="chip">decided by {c.decidedBy}</span>
          </div>
          <p style={{ margin: "0.3rem 0" }}>{sel.approach}</p>
          {overridden ? (
            <p className="muted" style={{ margin: 0 }}>
              Lead recommended {rec?.id}: {rec?.name}. Your override reason: “{c.overrideReason}”
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Lead's recommendation. {c.rationale}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function OptionsCard({ task }: { task: Task }) {
  const { send, disabled } = useStore();
  const spec = M.currentSpec(task);
  const c = spec.content;
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <section className="card" aria-labelledby="opt-h">
      <h2 id="opt-h">Options and tradeoffs</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Option</th>
              <th>Benefit</th>
              <th>Effort</th>
              <th>Costs and risks</th>
              <th>Reversibility</th>
              <th>
                <span className="sr-only">Decision</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {c.options.map((o) => (
              <tr key={o.id} className={o.id === c.selectedOptionId ? "selected" : undefined}>
                <td>
                  <strong>
                    {o.id}: {o.name}
                  </strong>
                  <div className="muted">{o.approach}</div>
                </td>
                <td>{o.benefit}</td>
                <td>{o.effort}</td>
                <td>{o.risks}</td>
                <td>{o.reversibility}</td>
                <td>
                  <div className="stack">
                    {o.id === c.recommendedOptionId && <span className="chip">Recommended</span>}
                    {o.id === c.selectedOptionId ? (
                      <span className="chip strong">Selected</span>
                    ) : (
                      open && (
                        <button className="small" onClick={() => setChoosing(o.id)}>
                          Choose
                        </button>
                      )
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {choosing && (
        <form
          className="stack"
          style={{ marginTop: "0.75rem" }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving) return;
            setSaving(true);
            const r =
              choosing === c.recommendedOptionId
                ? await send("editSpec", { taskId: task.id, expectedRev: spec.rev, content: { ...structuredClone(c), selectedOptionId: choosing }, reason: `User restored recommended option ${choosing}` })
                : await send("overrideSelection", { taskId: task.id, expectedRev: spec.rev, optionId: choosing, reason });
            setSaving(false);
            if (r.ok) {
              setChoosing(null);
              setReason("");
            }
          }}
        >
          {choosing !== c.recommendedOptionId && (
            <label className="field">
              <span>Why choose {choosing} over the lead's recommendation? (kept in the decision record)</span>
              <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required />
            </label>
          )}
          {task.lifecycle === "active" && <p className="muted">Saving creates a new revision and stops runs on the current revision first.</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={disabled || saving}>
              Select option {choosing} (new revision r{spec.rev + 1})
            </button>
            <button type="button" onClick={() => setChoosing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <dl className="kv" style={{ marginTop: "0.8rem" }}>
        <dt>Rationale</dt>
        <dd>{c.rationale || "—"}</dd>
        <dt>Uncertainty</dt>
        <dd>{c.uncertainty || "None recorded"}</dd>
      </dl>
    </section>
  );
}

function DetailsCard({ task }: { task: Task }) {
  const c = M.currentSpec(task).content;
  const list = (xs: string[]) => (xs.length ? <ul className="plain">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="muted">—</span>);
  return (
    <section className="card" aria-labelledby="det-h">
      <h2 id="det-h">Acceptance and scope</h2>
      <dl className="kv">
        <dt>Acceptance</dt>
        <dd>{list(c.acceptance)}</dd>
        <dt>Success</dt>
        <dd>{list(c.successCriteria)}</dd>
        <dt>Why now</dt>
        <dd>{c.whyNow || "—"}</dd>
        <dt>In scope</dt>
        <dd>{list(c.scopeIncluded)}</dd>
        <dt>Out of scope</dt>
        <dd>{list(c.scopeExcluded)}</dd>
        <dt>Validation</dt>
        <dd>{c.validationPlan || "—"}</dd>
        <dt>Rollback</dt>
        <dd>{c.rollback || "—"}</dd>
        <dt>Effort</dt>
        <dd>{c.effort}</dd>
        <dt>Depends on</dt>
        <dd>{task.dependsOn.length ? task.dependsOn.map((d) => <a key={d} href={`#/task/${d}`} style={{ marginRight: "0.5rem" }}>{d}</a>) : "—"}</dd>
      </dl>
    </section>
  );
}

/** ORC-021: "Flow: Change", or what a task from before flows ran ("From before flows: Feature", "Custom pipeline"). */
function FlowLine({ task }: { task: Task }) {
  const line = flowLineParts(task.flow);
  return (
    <div className="row" style={{ gap: "0.3rem", fontSize: "0.85rem" }}>
      <span>
        {line.prefix}
        <strong>{line.name}</strong>
      </span>
    </div>
  );
}

/**
 * ORC-021: run a task on another flow. The button is shown while the task is open and not service-owned;
 * it is disabled, with the reason, while the task is running or not yet confirmed Paused. The panel shows the
 * picker, what the change does (which steps start over, which pins stay, what is closed) and an optional note.
 * The pipeline revision is the one the panel was opened on; if it moves meanwhile, the panel asks you to
 * review again instead of sending a stale request.
 */
function ChangeFlow({ state, task }: { state: State; task: Task }) {
  const { send, disabled } = useStore();
  const [open, setOpen] = useState(false);
  const [openedRev, setOpenedRev] = useState(task.pipelineRev);
  const [flowId, setFlowId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (task.reviewTarget || task.checkTarget || task.revertOf || task.deliverInto) return null;
  // A child task may not take a flow that breaks down again.
  const choices = state.flows.filter((p) => !(task.parentTaskId && p.breaksDown));
  const blocker = M.flowChangeBlocker(state, task);
  if (!open) {
    return (
      <div className="row" style={{ gap: "0.4rem", fontSize: "0.85rem", marginBottom: "0.4rem" }}>
        <button
          className="small"
          disabled={disabled || !!blocker || !choices.length}
          title={blocker ?? "Run this task on another flow; the pipeline starts over and work done so far stays on the record"}
          onClick={() => {
            setOpenedRev(task.pipelineRev);
            setFlowId("");
            setNote("");
            setOpen(true);
          }}
        >
          Change flow
        </button>
        {blocker && <span className="muted">{blocker}</span>}
      </div>
    );
  }
  const chosen = choices.find((p) => p.id === flowId);
  const preview = chosen ? M.flowChangePreview(state, task, chosen) : undefined;
  const same = chosen ? sameFlow(task.flow, chosen) : false;
  const moved = task.pipelineRev !== openedRev;
  const canUse = !!chosen && !!preview?.allowed && !same && !moved && !busy && !disabled;
  return (
    <div className="flow-panel" role="group" aria-labelledby="chg-flow-h">
      <h3 id="chg-flow-h" style={{ marginBottom: "0.3rem" }}>
        Change flow
      </h3>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        The pipeline starts over from the flow you choose. Work done so far stays on the record, labelled "earlier flow", and is never used again. A provider or model pin stays on a step with the same id and role.
        {task.hold ? " The task stays paused until you resume it." : ""}
      </p>
      {moved && (
        <div className="banner neutral" role="status" style={{ marginBottom: "0.6rem" }}>
          {PIPELINE_CHANGED_MESSAGE}{" "}
          <button className="small" onClick={() => setOpenedRev(task.pipelineRev)}>
            Review again
          </button>
        </div>
      )}
      <FlowPicker flows={choices} value={flowId} onChange={setFlowId} label="New flow" disabled={disabled || busy} />
      {chosen &&
        (same ? (
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            This task already runs {chosen.name} at this version; nothing would change.
          </p>
        ) : preview && !preview.allowed ? (
          <p style={{ color: "var(--s-blocked)", fontSize: "0.85rem" }}>{preview.why}</p>
        ) : preview ? (
          <ul className="plain" style={{ fontSize: "0.85rem", marginBottom: "0.6rem" }} aria-label="What this change does">
            {changeConsequences(preview).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null)}
      <label className="field">
        <span>Note (optional; recorded on the pipeline revision)</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled || busy} style={{ width: "100%" }} />
      </label>
      <div className="row">
        <button
          className="primary"
          disabled={!canUse}
          onClick={async () => {
            setBusy(true);
            const r = await send("changeFlow", { taskId: task.id, expectedRev: openedRev, flowId, note: note.trim() });
            setBusy(false);
            if (r.ok) setOpen(false);
          }}
        >
          Use {chosen?.name ?? "flow"}
        </button>
        <button disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The runs a step row shows: the active run, or the last completed one for a done step. */
function stepRuns(state: State, task: Task, st: Step) {
  const lastRun = [...state.attempts].reverse().find((a) => a.taskId === task.id && a.stepId === st.id && a.outcome === "completed");
  const done = st.state === "done";
  const activeRun = M.activeAttempts(state, task.id).find((a) => a.stepId === st.id);
  const shownRun = activeRun ?? (done ? lastRun : undefined);
  return { lastRun, done, activeRun, shownRun, stale: shownRun ? M.staleInputs(state, task, shownRun) : [] };
}

/** The step's id and purpose, its markers, the best-of choice, and what it follows. */
function StepHead({ state, task, st }: { state: State; task: Task; st: Step }) {
  return (
    <>
      <strong>{st.id}</strong> {st.purpose}
      {st.gate && (
        <>
          {" "}
          <span className="chip" title="The task pauses after this step so you can review or edit its artifacts">
            gate
          </span>
        </>
      )}
      {stepChips(state, task, st).map((c) => (
        <span key={c.text}>
          {" "}
          <span className={`chip${c.strong ? " strong" : ""}`} title={c.title}>
            {c.text}
          </span>
        </span>
      ))}
      <BestOfChoice task={task} stepId={st.id} />
      <div className="muted small">
        {st.dependsOn.length ? `after ${st.dependsOn.join(", ")}` : "first"} · config r{st.revision}
      </div>
      <StepPrinciples state={state} task={task} st={st} />
    </>
  );
}

/**
 * ORC-024: the principles the step's agent gets: what its run recorded when it has one, else the step's
 * own set. An automatic one shows why it was added. Nothing for a step without principles (steps copied
 * before ORC-024, checks steps) or an older run that recorded none.
 */
function StepPrinciples({ state, task, st }: { state: State; task: Task; st: Step }) {
  const { shownRun } = stepRuns(state, task, st);
  const given = shownRun?.snapshot.principles ?? (shownRun ? [] : stepPrinciples(st).map((id) => ({ id })));
  if (!given.length) return null;
  return <div className="muted small">{principlesText(given)}</div>;
}

/** The context disclosure, plus the note about outdated inputs. */
function StepContext({ state, task, st }: { state: State; task: Task; st: Step }) {
  const { shownRun, stale } = stepRuns(state, task, st);
  return (
    <>
      <StepIO state={state} task={task} stepId={st.id} run={shownRun} />
      {stale.length > 0 && (
        <div className="small" style={{ color: "var(--st-you)" }}>
          Used outdated {stale.map((i) => `${i.step}.${i.output} v${i.version}`).join(", ")}; newer versions exist.
        </div>
      )}
    </>
  );
}

/** The provider and model: the picker for the next attempt, what ran, or how the service runs a Checks step. */
function StepModel({ state, task, st, open }: { state: State; task: Task; st: Step; open: boolean }) {
  const { send, disabled } = useStore();
  const r = M.resolveStep(state, task, st);
  const { lastRun, done, activeRun } = stepRuns(state, task, st);
  if (st.role === "checks") {
    // ORC-013: a Checks step is run by the service; it has no provider or model to choose.
    return (
      <>
        <span>Run by the service{C.checksOn(state.project.checks) ? ` · ${state.project.checks.sandbox === "codex" ? "sandboxed" : "no sandbox"}` : ""}</span>
        <div className="muted small">
          {C.checksOn(state.project.checks) ? (
            <>
              {st.checks?.onFail === "block" ? "Stops the task and asks for a decision when checks fail" : "Failing checks become findings for the repair step"}.
              {st.state === "pending" && C.checksHeld(state) ? ` ${C.HELD_LABEL}.` : ""}
              {activeRun ? ` Running as ${activeRun.id}${activeRun.activity ? `: ${activeRun.activity}` : ""}.` : lastRun && done ? ` Ran as ${lastRun.id}.` : ""}
            </>
          ) : (
            <>
              {st.state === "skipped" ? "Skipped: checks are off" : "Will be skipped: checks are off"} (<a href="#/settings">Settings</a>).
            </>
          )}
        </div>
      </>
    );
  }
  if (done && lastRun)
    return (
      <>
        <span>{selectionText(lastRun.snapshot)}</span>
        <div className="muted small">
          ran as {lastRun.id} · {M.sourceLabel(lastRun.snapshot.source).toLowerCase()}
        </div>
        {open && (
          <button
            className="small"
            style={{ marginTop: "0.3rem" }}
            aria-label={`Rerun ${st.id}`}
            disabled={disabled}
            onClick={() => {
              if (confirm(`Rerun ${st.id}? Results of steps that depend on it will need revalidation, and any of them still running will be stopped.`)) void send("rerunStep", { taskId: task.id, stepId: st.id });
            }}
          >
            Rerun
          </button>
        )}
      </>
    );
  if (st.state === "skipped") return <span className="muted">Not run: its condition had nothing to fix. Re-evaluated if an upstream step reruns.</span>;
  if (!open) return <span className="muted">{r.ok ? selectionText(r.selection) : "—"}</span>;
  return (
    <>
      {activeRun && (
        <div style={{ marginBottom: "0.3rem" }}>
          <strong>{selectionText(activeRun.snapshot)}</strong>
          <div className="muted small">
            {activeRun.outcome === "stopping" ? "stopping" : "running"} as {activeRun.id}; next attempt uses:
          </div>
        </div>
      )}
      <ModelPicker
        state={state}
        label={`Model for next attempt of ${st.id}`}
        value={st.selection}
        allowInherit
        inheritLabel={`Inherited${r.ok && st.selection === null ? `: ${selectionText(r.selection)}` : ""}`}
        disabled={disabled}
        onChange={(v) => {
          const running = st.state === "running";
          if (running && !confirm(`${st.id} is running. Changing its model stops the current run (checkpointed) before a new attempt starts. Continue?`)) return;
          void send("setStepSelection", { taskId: task.id, stepId: st.id, selection: v });
        }}
      />
      <div className="muted small">
        {st.selection ? (
          <>
            Pinned by you ·{" "}
            <button className="link" disabled={disabled} onClick={() => void send("setStepSelection", { taskId: task.id, stepId: st.id, selection: null })}>
              Reset to default
            </button>
          </>
        ) : r.ok ? (
          M.sourceLabel(r.source)
        ) : null}
      </div>
      {r.ok && r.selection.model !== (st.selection ?? r.selection).model && <div className="muted small">{r.reason}</div>}
      {!r.ok && <div className="small" style={{ color: "var(--st-fail)" }}>{r.reason}</div>}
    </>
  );
}

/** §3.1: the step's state as the one pill shape; its tone from the state. */
function StepStatePill({ st }: { st: Step }) {
  const tone: Tone = st.state === "running" || st.state === "stopping" ? "work" : st.state === "done" ? "done" : st.state === "blocked" ? "fail" : "neutral";
  return (
    <Pill tone={tone} paused={st.state === "paused"} pulse={st.state === "running"}>
      {st.state}
    </Pill>
  );
}

/** The state, why it is blocked or needs revalidation, and Retry. */
function StepStateCell({ st, task, open }: { st: Step; task: Task; open: boolean }) {
  const { send, disabled } = useStore();
  return (
    <>
      <StepStatePill st={st} />
      {st.invalidatedBy && <div className="muted small">{st.invalidatedBy.startsWith("edited ") ? `re-runs: you ${st.invalidatedBy}` : `revalidate: ${st.invalidatedBy} changed`}</div>}
      {st.blockedReason && (
        <div className="small" style={{ color: "var(--st-fail)" }}>
          {st.blockedReason}
        </div>
      )}
      {st.state === "blocked" && open && (
        <button className="small" style={{ marginTop: "0.3rem" }} aria-label={`Retry ${st.id}`} disabled={disabled} onClick={() => void send("retryStep", { taskId: task.id, stepId: st.id })}>
          Retry
        </button>
      )}
    </>
  );
}

/**
 * ORC-022: the secondary "Send a note" control on a running agent step (never a Checks step), and the
 * one-paragraph form it opens. The note is guidance within the spec; the service decides which run gets it.
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
  const id = `note-${task.id}-${st.id}`;
  if (!open)
    return (
      <button className="small" style={{ marginTop: "0.3rem" }} aria-label={`Send a note to ${st.id}`} disabled={disabled} title="A short instruction for the running agent; it reaches it at its next step and is kept on the record" onClick={() => setOpen(true)}>
        Send a note
      </button>
    );
  return (
    <form
      className="note-form stack"
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
      <label className="field" htmlFor={id} style={{ margin: 0 }}>
        <span>
          Note to the {ROLE_LABEL[st.role].toLowerCase()} {can ? "running" : "of"} {st.id}
        </span>
        <textarea id={id} value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={3} aria-describedby={`${id}-hint`} aria-invalid={tooLong} placeholder="For example: skip the README; I will write it." />
      </label>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span id={`${id}-hint`} className="muted small">
          {!can
            ? `${st.id} is no longer running, so this note cannot reach it. Ask the lead to rerun ${st.id} with it, or cancel.`
            : tooLong
              ? `Notes are limited to ${MAX_NOTE_LENGTH} characters.`
              : `One paragraph, ${length}/${MAX_NOTE_LENGTH}. Guidance within the spec; the agent keeps its work so far.`}
          {can && service.runtime === "fake" ? " Simulated: the fake runtime acknowledges after a moment." : ""}
        </span>
        <span className="row" style={{ gap: "0.3rem" }}>
          <button type="submit" className="small primary" disabled={disabled || busy || !can || !length || tooLong}>
            {busy ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            className="small"
            onClick={() => {
              setOpen(false);
              setText("");
            }}
          >
            Cancel
          </button>
        </span>
      </div>
    </form>
  );
}

/** ORC-022: notes, each with its status chip (Queued, Sending, Delivered, Delivered at start, Not delivered: reason), its source and its time; "simulated" in the demo. */
function NotesList({ notes, label }: { notes: Note[]; label: string }) {
  if (!notes.length) return null;
  return (
    <ul className="notes" aria-label={label}>
      {notes.map((n) => (
        <li key={n.id}>
          <div className="row" style={{ gap: "0.35rem", alignItems: "baseline" }}>
            <Pill tone={noteTone(n)} pulse={n.status === "sending"}>
              {noteStatusLabel(n)}
            </Pill>
            {n.simulated && (
              <span className="chip" title="Written by the fake runtime's lead, or acknowledged by a simulated run; no agent read it">
                simulated
              </span>
            )}
            <span className="muted">
              {noteSourceLabel(n)} ·{" "}
              <time dateTime={n.at} title={fmtTime(n.at)}>
                {relTime(n.at)}
              </time>
            </span>
          </div>
          <div className="note-text">“{n.text}”</div>
        </li>
      ))}
    </ul>
  );
}

/** ORC-022: under a step: Send a note while it runs, and the notes waiting for its next run. */
function StepNotes({ state, task, st }: { state: State; task: Task; st: Step }) {
  const queued = M.queuedNotes(state, task.id, st.id);
  return (
    <>
      <SendNote state={state} task={task} st={st} />
      {queued.length > 0 && (
        <div className="small" style={{ marginTop: "0.3rem" }}>
          <span className="muted">Waiting for its next run:</span>
          <NotesList notes={queued} label={`Notes waiting for ${st.id}`} />
        </div>
      )}
    </>
  );
}

function StepsCard({ state, task }: { state: State; task: Task }) {
  const { send, disabled, service } = useStore();
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const usedRoles = [...new Set(task.steps.map((s) => s.role))];
  // ORC-017 §3.9: below 700 px the table becomes a list, one block per step.
  const narrow = useNarrow("(max-width: 699px)");

  return (
    <section className="card" aria-labelledby="steps-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="steps-h">Pipeline</h2>
        <span className="row">
          {open && (
            <label className="row small" style={{ gap: "0.3rem" }} title="Pause the task after every step so you can read or edit its artifacts">
              <input type="checkbox" checked={!!task.reviewEveryStep} disabled={disabled} onChange={(e) => void send("setReviewEveryStep", { taskId: task.id, value: e.target.checked })} />
              Review every step
            </label>
          )}
          <span className="chip">pipeline r{task.pipelineRev}</span>
        </span>
      </div>
      <FlowLine task={task} />
      {open && <ChangeFlow state={state} task={task} />}
      <p className="muted small" style={{ marginBottom: "0.3rem" }}>
        The pipeline comes from the flow; the six flows live in the repository&apos;s flows/ folder and change through commits.
      </p>
      <details className="how">
        <summary>How this works</summary>
        <p>
          Each step receives the vision, the current spec, and only the upstream artifacts it reads. Models resolve step pin → task role override → project role default → project default. Completed steps show the model that
          actually ran. {service.runtime === "real" ? "Models come from each provider's catalog." : "Model catalog is sample data."}
        </p>
      </details>
      {narrow ? (
        <ol className="steps-list" aria-label="Pipeline steps">
          {task.steps.map((st) => (
            <li key={st.id}>
              <div>
                <StepHead state={state} task={task} st={st} />
              </div>
              <div className="step-rs">
                <span className="muted">{ROLE_LABEL[st.role]}</span>
                <StepStateCell st={st} task={task} open={open} />
              </div>
              <div className="step-model">
                <StepModel state={state} task={task} st={st} open={open} />
              </div>
              <StepNotes state={state} task={task} st={st} />
              <StepContext state={state} task={task} st={st} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="table-wrap">
          <table className="steps-table">
            <thead>
              <tr>
                <th>Step and context</th>
                <th>Role</th>
                <th>Provider and model</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {task.steps.map((st) => (
                <tr key={st.id}>
                  <td>
                    <StepHead state={state} task={task} st={st} />
                    <StepNotes state={state} task={task} st={st} />
                    <StepContext state={state} task={task} st={st} />
                  </td>
                  <td>{ROLE_LABEL[st.role]}</td>
                  <td>
                    <StepModel state={state} task={task} st={st} open={open} />
                  </td>
                  <td>
                    <StepStateCell st={st} task={task} open={open} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <details style={{ marginTop: "0.75rem" }}>
          <summary>Task role overrides</summary>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Apply to every unpinned step of this role in this task.
            {usedRoles.includes("security_reviewer") ? " The security reviewer has its own row: an override of the code reviewer does not change it." : ""}
          </p>
          <dl className="kv">
            {ROLES.filter((r) => usedRoles.includes(r)).map((role) => (
              <div key={role} style={{ display: "contents" }}>
                <dt>{ROLE_LABEL[role]}</dt>
                <dd>
                  <ModelPicker
                    state={state}
                    label={`Task override for ${ROLE_LABEL[role]}`}
                    value={task.roleOverrides[role] ?? null}
                    allowInherit
                    inheritLabel={role === "security_reviewer" && !state.project.roleDefaults.security_reviewer ? "Project default (the code reviewer's)" : "Project default"}
                    disabled={disabled}
                    onChange={(v) => void send("setTaskRoleOverride", { taskId: task.id, role, selection: v })}
                  />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {task.pipelineHistory.length > 1 && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary>Pipeline revisions ({task.pipelineHistory.length})</summary>
          <ul className="events">
            {[...task.pipelineHistory].reverse().map((p) => (
              <li key={p.rev}>
                <span className="mono">r{p.rev}</span>
                <span className="actor">{p.author}</span>
                <span>
                  {p.reason}{" "}
                  {revisionFlowLabel(p) && <span className="chip">{revisionFlowLabel(p)}</span>}{" "}
                  <span className="muted">· {p.steps.length} steps · {fmtTime(p.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <label className="row" style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
        <input
          type="checkbox"
          checked={task.holdBeforeStart}
          disabled={disabled || !open || task.lifecycle === "active"}
          onChange={(e) => void send("setHoldBeforeStart", { taskId: task.id, value: e.target.checked })}
        />
        Hold before start (guarantees a chance to review before the first dispatch)
      </label>
    </section>
  );
}

/** A step's declared inputs/outputs and the context a run received (from its snapshot) or would receive now. */
function StepIO({ state, task, stepId, run }: { state: State; task: Task; stepId: string; run?: Attempt }) {
  const st = task.steps.find((x) => x.id === stepId)!;
  const spec = run ? (task.specs.find((r) => r.rev === run.snapshot.specRev) ?? M.currentSpec(task)) : M.currentSpec(task);
  const visionRev = run ? run.snapshot.visionRev : M.currentVision(state).rev;
  const pipelineRev = run ? run.snapshot.pipelineRev : task.pipelineRev;
  const received = run ? run.snapshot.inputs : M.consumedInputs(state, task, st);
  const declared = run ? received.map((i) => ({ step: i.step, output: i.output })) : st.inputs;
  const summary = (id: string) => state.artifacts.find((a) => a.id === id);
  return (
    <details style={{ fontSize: "0.8rem", marginTop: "0.2rem" }}>
      <summary className="muted">
        reads {st.inputs.length ? st.inputs.map((r) => `${r.step}.${r.output}`).join(", ") : "nothing upstream"} · produces {st.outputs.length ? st.outputs.map((o) => o.name).join(", ") : "nothing"}
        {st.runIf?.length ? ` · only if ${st.runIf.map((r) => `${r.step}.${r.output}`).join(" or ")} has findings to fix` : ""}
      </summary>
      <div className="stack" style={{ padding: "0.3rem 0 0.2rem" }}>
        <div>
          <strong>{run ? `Context ${run.id} received` : "Context this step would receive now"}</strong>
        </div>
        <ul className="plain">
          <li>
            Instruction: “{run ? run.snapshot.purpose : st.purpose}”
          </li>
          <li>
            Vision r{visionRev}, spec r{spec.rev} with selected option {spec.content.selectedOptionId} and {spec.content.acceptance.length} acceptance check(s), pipeline r{pipelineRev}
          </li>
          {declared.map((r) => {
            const got = received.find((i) => i.step === r.step && i.output === r.output);
            const art = got && summary(got.artifactId);
            return (
              <li key={`${r.step}.${r.output}`}>
                <span className="mono">
                  {r.step}.{r.output}
                </span>{" "}
                {art ? (
                  <>
                    v{art.version}
                    {art.author === "user" && (
                      <>
                        {" "}
                        <span className="chip edited">edited by you</span>
                      </>
                    )}{" "}
                    — {art.summary}
                  </>
                ) : (
                  <span className="muted">{task.steps.find((x) => x.id === r.step)?.state === "skipped" ? "not produced (step skipped)" : "not available yet"}</span>
                )}
              </li>
            );
          })}
          {run && st.inputs.some((r) => !received.some((i) => i.step === r.step && i.output === r.output)) && (
            <li className="muted">
              Not received by this run:{" "}
              {st.inputs
                .filter((r) => !received.some((i) => i.step === r.step && i.output === r.output))
                .map((r) => `${r.step}.${r.output}`)
                .join(", ")}
            </li>
          )}
        </ul>
      </div>
    </details>
  );
}

function ArtifactsCard({ state, task }: { state: State; task: Task }) {
  const { service, disabled } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const arts = state.artifacts.filter((a) => a.taskId === task.id);
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const consumers = (id: string) => state.attempts.filter((a) => a.taskId === task.id && a.snapshot.inputs.some((i) => i.artifactId === id)).map((a) => a.id);
  return (
    <section className="card" aria-labelledby="arts-h">
      <h2 id="arts-h">Artifacts</h2>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Step outputs, versioned. Each version is kept as it was; editing one saves a new version that later steps use.{" "}
        {service.runtime === "real" ? "Code changes are commits on orchestration/* branches; nothing is merged for you." : "Contents are simulated."}
      </p>
      {!arts.length && <p className="muted">None yet.</p>}
      <ul className="events">
        {[...arts].reverse().map((a) => {
          const latest = M.latestArtifact(state, task, a.stepId, a.name);
          const used = consumers(a.id);
          const edited = a.author === "user";
          // ORC-016: work from before the task's flow changed is the record; it is never edited or consumed again.
          const earlier = M.fromEarlierFlow(state, task, a);
          return (
            <li key={a.id} className="artifact-row">
              <span className="mono">
                {a.stepId}.{a.name} v{a.version}
              </span>
              <span>
                <span className="chip">{a.kind}</span> {edited && <span className="chip edited">edited by you</span>}{" "}
                {earlier && (
                  <>
                    <span className="chip" title="Made before the task's flow changed; kept for the record, not used by the new steps and not editable">
                      {earlierFlowLabel(task, M.artifactPipelineRev(state, a))}
                    </span>{" "}
                  </>
                )}
                {notChosen(task, a.stepId) && (
                  <>
                    <span className="chip" title="Another candidate was chosen; this one's work stays visible and on its branch">
                      not chosen
                    </span>{" "}
                  </>
                )}
                <span style={{ whiteSpace: "pre-wrap" }}>{a.summary}</span>
                {a.kind === "breakdown" && <BreakdownChildren state={state} task={task} artifact={a} />}
                {a.ref && (
                  <div className="mono" style={{ fontSize: "0.78rem" }}>
                    {a.ref}
                  </div>
                )}
                {a.openFindings !== undefined && (
                  <span className="chip strong" style={{ marginLeft: "0.3rem" }} title={a.findings ? "Unresolved: auto-fix findings, and ask-user findings not yet accepted or followed up" : undefined}>
                    {a.findings ? F.unresolved(state, a) : a.openFindings} open
                  </span>
                )}
                {a.pathCoverage && (
                  <>
                    {" "}
                    <CoverageChip coverage={a.pathCoverage} />
                  </>
                )}
                {a.checkRun && <CheckResults run={a.checkRun} attemptId={a.attemptId} />}
                {a.findings && <FindingsList state={state} artifact={a} controls={latest?.id === a.id} />}
                {edited && a.editReason && <div style={{ fontSize: "0.82rem" }}>Why you changed it: “{a.editReason}”</div>}
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  {edited ? `edited ${relTime(a.createdAt)}` : `from ${a.attemptId}`}
                  {used.length ? ` · read by ${used.join(", ")}` : " · not read by any run yet"}
                  {latest && latest.version > a.version ? ` · superseded by v${latest.version}` : ""}
                </div>
                {open && !earlier && editingId !== a.id && (
                  <button className="small" style={{ marginTop: "0.3rem" }} aria-label={`Edit ${a.stepId}.${a.name} v${a.version}`} disabled={disabled} onClick={() => setEditingId(a.id)}>
                    Edit
                  </button>
                )}
                {open && !earlier && editingId === a.id && <ArtifactEditor state={state} task={task} artifactId={a.id} onClose={() => setEditingId(null)} />}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Edit or replace one artifact; saving creates the next version and re-submits every step downstream. */
function ArtifactEditor({ state, task, artifactId, onClose }: { state: State; task: Task; artifactId: string; onClose: () => void }) {
  const { send, disabled } = useStore();
  const found = state.artifacts.find((x) => x.id === artifactId);
  const [summary, setSummary] = useState(found?.summary ?? "");
  const [findings, setFindings] = useState(String(found?.openFindings ?? 0));
  const [ref, setRef] = useState("");
  const [items, setItems] = useState(JSON.stringify(found?.items ?? [], null, 2));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  if (!found) return null;
  const base = found;
  const latest = M.latestArtifact(state, task, base.stepId, base.name) ?? base;
  // ORC-013: structured findings are decided one by one; only the summary of such an artifact can be edited.
  const isFindings = base.kind === "review-findings" && !base.findings;
  const isStructured = base.kind === "review-findings" && !!base.findings;
  const isCode = base.kind === "code-change";
  const findingsOk = !isFindings || (/^\d+$/.test(findings.trim()) && Number(findings) >= 0);
  const isBreakdown = base.kind === "breakdown";
  let parsedItems: unknown[] | null = null;
  if (isBreakdown) {
    try {
      const v: unknown = JSON.parse(items);
      parsedItems = Array.isArray(v) ? v : null;
    } catch {
      parsedItems = null;
    }
  }
  const refOk = !isCode || !ref.trim() || /^[0-9a-f]{7,40}$/i.test(ref.trim());
  const canSave = !disabled && !saving && summary.trim() !== "" && reason.trim() !== "" && findingsOk && refOk && (!isBreakdown || parsedItems !== null);
  const readers = task.steps.filter((d) => d.inputs.some((r) => r.step === base.stepId && r.output === base.name)).map((d) => d.id);
  const idp = `edit-${artifactId}`;
  return (
    <form
      className="artifact-editor stack"
      aria-label={`Edit ${base.stepId}.${base.name}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSave) return;
        setSaving(true);
        const args: Record<string, unknown> = { artifactId, summary, reason };
        if (isFindings) args.openFindings = Number(findings);
        if (isCode && ref.trim()) args.ref = ref.trim();
        if (isBreakdown && parsedItems) args.items = parsedItems;
        const r = await send("editArtifact", args);
        setSaving(false);
        if (r.ok) onClose();
      }}
    >
      <p className="muted" style={{ fontSize: "0.82rem", margin: 0 }}>
        Saving creates v{latest.version + 1}; every later step that used this output re-runs on your version.
        {readers.length ? ` Read directly by ${readers.join(", ")}.` : ""}
        {latest.version > base.version ? ` You are starting from v${base.version}; the newest is v${latest.version}.` : ""}
      </p>
      <label className="field" htmlFor={`${idp}-summary`} style={{ margin: 0 }}>
        <span>{base.kind === "code-change" ? "Description of the change" : "Content"}</span>
        <textarea id={`${idp}-summary`} value={summary} onChange={(e) => setSummary(e.target.value)} required />
      </label>
      {isFindings && (
        <label className="field" style={{ margin: 0 }}>
          <span>Open findings</span>
          <input type="number" min={0} step={1} value={findings} onChange={(e) => setFindings(e.target.value)} style={{ width: "6rem" }} required />
          <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
            Steps that run only when there are open findings use this number. Set 0 to let them skip.
          </span>
        </label>
      )}
      {isStructured && (
        <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
          The findings are listed one by one and carry over unchanged: decide each finding on the artifact instead of editing a count.
        </p>
      )}
      {isCode && (
        <label className="field" style={{ margin: 0 }}>
          <span>Use this commit instead (optional)</span>
          <input type="text" className="mono" value={ref} placeholder={base.ref ?? "commit hash"} onChange={(e) => setRef(e.target.value)} aria-invalid={!refOk} />
          {!refOk && <span style={{ color: "var(--s-blocked)", fontSize: "0.8rem" }}>Use a commit hash (7–40 hex characters).</span>}
          <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
            Point it at your own commit to replace the worker's change. Leave empty to keep {base.ref ? <span className="mono">{base.ref}</span> : "the current reference"}.
          </span>
        </label>
      )}
      {isBreakdown && (
        <label className="field" style={{ margin: 0 }}>
          <span>Work items (each becomes a child task)</span>
          <textarea className="mono" style={{ minHeight: "10rem" }} value={items} onChange={(e) => setItems(e.target.value)} aria-invalid={parsedItems === null} />
          <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
            A JSON list of {`{ "title", "outcome", "approach", "acceptance": [...], "flowId", "priority", "dependsOn": [index] }`}.
            {task.pendingBreakdowns?.length ? " Child tasks are created from this list when you resume." : ""}
          </span>
          {parsedItems === null && <span style={{ color: "var(--s-blocked)", fontSize: "0.8rem" }}>Not a valid JSON list.</span>}
        </label>
      )}
      <label className="field" style={{ margin: 0 }}>
        <span>Why (required; the next steps see this)</span>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <div className="row">
        <button type="submit" className="primary small" disabled={!canSave}>
          {saving ? "Saving…" : `Save as v${latest.version + 1}`}
        </button>
        <button type="button" className="small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RunsCard({ state, task }: { state: State; task: Task }) {
  const { service } = useStore();
  const runs = state.attempts.filter((a) => a.taskId === task.id).reverse();
  return (
    <section className="card" aria-labelledby="runs-h">
      <h2 id="runs-h">Runs</h2>
      {!runs.length && <p className="muted">No runs yet.</p>}
      {runs.map((a) => {
        const notes = M.notesOfRun(state, a.id);
        return (
          <details key={a.id} className="stack" style={{ borderBottom: "1px solid var(--border)", padding: "0.4rem 0" }}>
            <summary>
              <span className="mono">{a.id}</span> · {a.stepId} · {selectionText(a.snapshot)} · <strong>{a.outcome}</strong>
              {notChosen(task, a.stepId) && a.outcome === "completed" && (
                <>
                  {" "}
                  <span className="chip">not chosen</span>
                </>
              )}
              {notes.length > 0 && (
                <>
                  {" "}
                  <span className="chip" title="Notes sent to this run; listed below">
                    {notes.length} note{notes.length === 1 ? "" : "s"}
                  </span>
                </>
              )}
              {(a.outcome === "running" || a.outcome === "stopping") && a.progress > 0 && (
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={a.progress} aria-label={`${a.id} simulated progress`} style={{ marginTop: "0.3rem" }}>
                  <div style={{ transform: `scaleX(${Math.max(0, Math.min(100, a.progress)) / 100})` }} />
                </div>
              )}
              {(a.outcome === "running" || a.outcome === "stopping") && a.activity && (
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  {a.activity}
                </div>
              )}
            </summary>
            {notes.length > 0 && (
              <div className="small">
                <span className="muted">Notes to this run:</span>
                <NotesList notes={notes} label={`Notes to ${a.id}`} />
              </div>
            )}
            <dl className="kv" style={{ fontSize: "0.82rem" }}>
              <dt>Snapshot</dt>
              <dd>
                spec r{a.snapshot.specRev} · step config r{a.snapshot.stepRev} · pipeline r{a.snapshot.pipelineRev} · vision r{a.snapshot.visionRev}
              </dd>
              <dt>Inputs</dt>
              <dd>
                {a.snapshot.inputs.length
                  ? a.snapshot.inputs
                      .map((i) => `${i.step}.${i.output} v${i.version}${state.artifacts.find((x) => x.id === i.artifactId)?.author === "user" ? " (your edit)" : ""}`)
                      .join(", ")
                  : "none"}
              </dd>
              <dt>Produced</dt>
              <dd>
                {state.artifacts
                  .filter((x) => x.attemptId === a.id)
                  .map((x) => `${x.name} v${x.version}`)
                  .join(", ") || "—"}
              </dd>
              <dt>Routing</dt>
              <dd>{a.snapshot.routingReason}</dd>
              {a.snapshot.principles && a.snapshot.principles.length > 0 && (
                <>
                  <dt>Principles</dt>
                  <dd>{principlesText(a.snapshot.principles).replace(/^Principles: /, "")}</dd>
                </>
              )}
              {a.snapshot.checks && (
                <>
                  <dt>Commands</dt>
                  <dd>
                    {a.snapshot.checks.commands.map((c) => (
                      <div key={c.id}>
                        <span className="chip">{c.kind}</span> <span className="mono">{c.argv.join(" ")}</span>
                        {state.artifacts.find((x) => x.attemptId === a.id)?.checkRun?.results.find((r) => r.id === c.id)?.log && service.runtime === "real" ? (
                          <>
                            {" · "}
                            <a href={checkLogUrl(a.id, c.id)} target="_blank" rel="noreferrer">
                              log
                            </a>
                          </>
                        ) : null}
                      </div>
                    ))}
                    <div className="muted">
                      on {a.snapshot.checks.target.ref.slice(0, 12)} · settings r{a.snapshot.checks.configRev} · {a.snapshot.checks.sandbox === "codex" ? "sandboxed" : "no sandbox"}
                      {a.snapshot.checks.reusedFrom ? ` · same as ${a.snapshot.checks.reusedFrom}` : ""}
                    </div>
                  </dd>
                </>
              )}
              {a.actualModel && a.actualModel !== a.snapshot.model && (
                <>
                  <dt>Model reported</dt>
                  <dd className="mono">{a.actualModel}</dd>
                </>
              )}
              {a.sessionId && (
                <>
                  <dt>Provider session</dt>
                  <dd className="mono">{a.sessionId}</dd>
                </>
              )}
              {a.usage && (
                <>
                  <dt>Usage</dt>
                  <dd>
                    {[
                      a.usage.inputTokens !== undefined && `${a.usage.inputTokens.toLocaleString()} input tokens`,
                      a.usage.outputTokens !== undefined && `${a.usage.outputTokens.toLocaleString()} output tokens`,
                      a.usage.costUsd !== undefined && `$${a.usage.costUsd.toFixed(4)} (provider estimate)`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "not reported"}
                  </dd>
                </>
              )}
              <dt>Workspace</dt>
              <dd className="mono">{a.snapshot.workspace}</dd>
              {a.snapshot.environment && (
                <>
                  <dt>Environment</dt>
                  <dd>
                    {a.snapshot.environment === "local"
                      ? "Local setup (user settings, plugins, all MCP servers)"
                      : `Isolated${a.snapshot.connections?.length ? `; connections: ${a.snapshot.connections.join(", ")}` : "; no connections"}`}
                  </dd>
                </>
              )}
              <dt>Started</dt>
              <dd>{fmtTime(a.startedAt)}</dd>
              {a.endedAt && (
                <>
                  <dt>Ended</dt>
                  <dd>{fmtTime(a.endedAt)}</dd>
                </>
              )}
              {a.note && (
                <>
                  <dt>Note</dt>
                  <dd>{a.note}</dd>
                </>
              )}
              <dt>Checkpoints</dt>
              <dd>{a.artifacts.length ? <ul className="plain">{a.artifacts.map((x, i) => <li key={i}>{x}</li>)}</ul> : "—"}</dd>
            </dl>
          </details>
        );
      })}
    </section>
  );
}

function TaskActivity({ state, task }: { state: State; task: Task }) {
  const evs = state.events.filter((e) => e.taskId === task.id).reverse().slice(0, 25);
  return (
    <section className="card" aria-labelledby="act-h">
      <h2 id="act-h">Activity</h2>
      <ul className="events">
        {evs.map((e) => (
          <li key={e.id}>
            <span className="muted" title={fmtTime(e.at)}>
              {relTime(e.at)}
            </span>
            <span className="actor">{e.actor}</span>
            <span>{e.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RevisionsCard({ task }: { task: Task }) {
  const revs = task.specs;
  const [from, setFrom] = useState(Math.max(1, revs.length - 1));
  const [to, setTo] = useState(revs.length);
  const a = revs.find((r) => r.rev === from);
  const b = revs.find((r) => r.rev === to);
  const diff = a && b ? diffLines(specToLines(a.content), specToLines(b.content)) : [];
  const changed = diff.filter((d) => d.kind !== "same");
  return (
    <section className="card" aria-labelledby="rev-h">
      <h2 id="rev-h">Revision history</h2>
      <ul className="events">
        {[...revs].reverse().map((r) => (
          <li key={r.rev}>
            <span className="mono">r{r.rev}</span>
            <span className="actor">{r.author}</span>
            <span>
              {r.reason} <span className="muted">· {fmtTime(r.at)}</span>
            </span>
          </li>
        ))}
      </ul>
      {revs.length > 1 && (
        <>
          <div className="row" style={{ margin: "0.75rem 0 0.5rem" }}>
            <label className="row" style={{ gap: "0.3rem" }}>
              Compare
              <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                {revs.map((r) => (
                  <option key={r.rev} value={r.rev}>
                    r{r.rev}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: "0.3rem" }}>
              with
              <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
                {revs.map((r) => (
                  <option key={r.rev} value={r.rev}>
                    r{r.rev}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">{changed.length ? `${changed.length} changed line(s)` : "No differences"}</span>
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
    </section>
  );
}

/** On the first member of a best-of group, which candidate the comparing step chose. */
function BestOfChoice({ task, stepId }: { task: Task; stepId: string }) {
  const { send, disabled } = useStore();
  const st = task.steps.find((x) => x.id === stepId);
  const g = st && copyGroup(task, st);
  if (!g || g.mode !== "best-of" || g.index !== 1) return null;
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const finished = g.members.filter((m) => m.state === "done");
  return (
    <div className="muted" style={{ fontSize: "0.8rem" }}>
      Best of {g.members.length} ({g.members.map((x) => x.id).join(", ")}):{" "}
      {g.chosen ? (
        <strong style={{ color: "var(--text)" }}>
          Chosen: {g.chosen}
          {g.byUser ? " (your choice; it stands until that candidate re-runs)" : ""}
        </strong>
      ) : (
        "the next step that reads them chooses one; only the chosen work goes further"
      )}
      {open && finished.length > 0 && (
        <span className="row" style={{ gap: "0.3rem", marginTop: "0.25rem" }}>
          <span>{g.chosen ? "Change to:" : "Or choose yourself:"}</span>
          {finished
            .filter((m) => m.id !== g.chosen)
            .map((m) => (
              <button key={m.id} className="small" disabled={disabled} onClick={() => void send("chooseCandidate", { taskId: task.id, group: m.copyOf, stepId: m.id })}>
                {m.id}
              </button>
            ))}
        </span>
      )}
    </div>
  );
}

function ChildLink({ state, child }: { state: State; child: Task }) {
  return (
    <span className="child-link">
      <a href={`#/task/${encodeURIComponent(child.id)}`} className="mono">
        {child.id}
      </a>{" "}
      {M.currentSpec(child).content.title} <StatePill state={state} task={child} />
    </span>
  );
}

/** Tasks created by this task's breakdown steps. */
function ChildTasksCard({ state, task }: { state: State; task: Task }) {
  const all = M.childTasks(state, task);
  // ORC-016: children of a breakdown made under an earlier flow stay listed, labelled; the new steps never wait for or reuse them.
  const children = all.filter((c) => !M.childFromEarlierFlow(state, task, c));
  const earlier = all.filter((c) => M.childFromEarlierFlow(state, task, c));
  const plansBreakdown = task.steps.some((st) => st.outputs.some((o) => o.kind === "breakdown"));
  if (!all.length && !plansBreakdown) return null;
  const finished = children.filter(isSettledTask);
  const cancelled = children.filter((c) => c.lifecycle === "cancelled").length;
  return (
    <section className="card" aria-labelledby="children-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="children-h">Child tasks</h2>
        {children.length > 0 && (
          <span className="chip">
            {finished.length} of {children.length} finished{cancelled ? ` (${cancelled} cancelled)` : ""}
          </span>
        )}
      </div>
      {!children.length ? (
        <p className="muted">None yet{earlier.length ? " under the current flow" : ""}. When a breakdown step completes, each item it lists becomes a child task here.</p>
      ) : (
        <ul className="plain stack">
          {children.map((c) => (
            <li key={c.id}>
              <ChildLink state={state} child={c} />
            </li>
          ))}
        </ul>
      )}
      {earlier.length > 0 && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary>
            From an earlier flow ({earlier.length})
          </summary>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "0.3rem 0" }}>
            Created by a breakdown before this task's flow changed. They stay on the record; the current steps do not wait for them or plan from them.
          </p>
          <ul className="plain stack">
            {earlier.map((c) => (
              <li key={c.id}>
                <ChildLink state={state} child={c} />{" "}
                <span className="chip" title="Its breakdown was made under a flow this task has since left">
                  from an earlier flow
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function BreakdownChildren({ state, task, artifact }: { state: State; task: Task; artifact: Artifact }) {
  const children = childrenOfArtifact(state, task, artifact);
  if (!children.length)
    return (
      <div className="muted" style={{ fontSize: "0.8rem" }}>
        {artifact.author === "user" ? "Your edit did not create child tasks." : "No child tasks came from this version."}
      </div>
    );
  return (
    <div style={{ fontSize: "0.85rem", margin: "0.3rem 0" }}>
      Created {children.length} child task{children.length === 1 ? "" : "s"}:
      <ul className="plain">
        {children.map((c) => (
          <li key={c.id}>
            <ChildLink state={state} child={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}
