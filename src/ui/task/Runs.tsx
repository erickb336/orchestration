// Details › Runs: every attempt, newest first, with its snapshot, the context it received, its commands and
// usage; Rerun on the last completed run of a finished step. This is where run ids and revision numbers live (P3).

import * as M from "../../domain/model";
import type { Attempt, State, Task } from "../../domain/types";
import { checkLogUrl } from "../../api";
import { fmtTime, selectionText } from "../common";
import { principlesText } from "../flowView";
import { Actions, Button, Chip, Disclosure, useConfirm } from "../kit";
import { useStore } from "../store";
import { CONFIRM } from "./confirms";
import { isOpenTask } from "./needsYouItems";
import { NotesList } from "./Steps";
import { lastCompletedRun, stepName } from "./stepWords";

const OUTCOME_WORD: Partial<Record<Attempt["outcome"], string>> = { stopped: "stopped (checkpointed)" };

export function RunsSection({ state, task }: { state: State; task: Task }) {
  const { service, send, disabled } = useStore();
  const confirm = useConfirm();
  const runs = state.attempts.filter((a) => a.taskId === task.id).reverse();
  const open = isOpenTask(task);
  const stepOf = (id: string) => task.steps.find((s) => s.id === id);
  return (
    <div className="k-stack k-stack--tight">
      {!runs.length && <p className="muted">No runs yet.</p>}
      {runs.map((a) => {
        const notes = M.notesOfRun(state, a.id);
        const st = stepOf(a.stepId);
        const canRerun = open && st?.state === "done" && lastCompletedRun(state, task, st)?.id === a.id;
        return (
          <Disclosure
            key={a.id}
            label={
              <>
                {a.stepId} {st ? stepName(st) : ""} · {selectionText(a.snapshot)} · <strong>{OUTCOME_WORD[a.outcome] ?? a.outcome}</strong>
                {notes.length > 0 && <Chip title="Notes sent to this run; listed inside">{`${notes.length} note${notes.length === 1 ? "" : "s"}`}</Chip>}
              </>
            }
          >
            {(a.outcome === "running" || a.outcome === "stopping") && a.activity && <p className="small muted">{a.activity}</p>}
            {notes.length > 0 && (
              <div className="small">
                <span className="muted">Notes to this run:</span>
                <NotesList notes={notes} label={`Notes to ${a.id}`} />
              </div>
            )}
            <dl className="t-kv">
              <dt>Run</dt>
              <dd className="mono">{a.id}</dd>
              <dt>Snapshot</dt>
              <dd>
                spec r{a.snapshot.specRev} · step config r{a.snapshot.stepRev} · pipeline r{a.snapshot.pipelineRev} · vision r{a.snapshot.visionRev}
              </dd>
              <dt>Inputs</dt>
              <dd>
                {a.snapshot.inputs.length
                  ? a.snapshot.inputs.map((i) => `${i.step}.${i.output} v${i.version}${state.artifacts.find((x) => x.id === i.artifactId)?.author === "user" ? " (your edit)" : ""}`).join(", ")
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
                        <Chip>{c.kind}</Chip> <span className="mono">{c.argv.join(" ")}</span>
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
                  <dd>{a.snapshot.environment === "local" ? "Local setup (user settings, plugins, all MCP servers)" : `Isolated${a.snapshot.connections?.length ? `; connections: ${a.snapshot.connections.join(", ")}` : "; no connections"}`}</dd>
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
            {st && <RunContext state={state} task={task} stepId={st.id} run={a} />}
            {canRerun && st && (
              <Actions>
                <Button
                  size="small"
                  aria-label={`Rerun ${st.id}`}
                  disabled={disabled}
                  onClick={async () => {
                    if (await confirm(CONFIRM.rerunStep(st.id, st.purpose))) void send("rerunStep", { taskId: task.id, stepId: st.id });
                  }}
                >
                  Rerun {st.id}
                </Button>
              </Actions>
            )}
          </Disclosure>
        );
      })}
    </div>
  );
}

/** A step's declared inputs and outputs, and the context a run received (from its snapshot) or would receive now. */
export function RunContext({ state, task, stepId, run }: { state: State; task: Task; stepId: string; run?: Attempt }) {
  const st = task.steps.find((x) => x.id === stepId)!;
  const spec = run ? (task.specs.find((r) => r.rev === run.snapshot.specRev) ?? M.currentSpec(task)) : M.currentSpec(task);
  const visionRev = run ? run.snapshot.visionRev : M.currentVision(state).rev;
  const pipelineRev = run ? run.snapshot.pipelineRev : task.pipelineRev;
  const received = run ? run.snapshot.inputs : M.consumedInputs(state, task, st);
  const declared = run ? received.map((i) => ({ step: i.step, output: i.output })) : st.inputs;
  const summary = (id: string) => state.artifacts.find((a) => a.id === id);
  const stale = run ? M.staleInputs(state, task, run) : [];
  return (
    <Disclosure
      label={
        <>
          reads {st.inputs.length ? st.inputs.map((r) => `${r.step}.${r.output}`).join(", ") : "nothing upstream"} · produces {st.outputs.length ? st.outputs.map((o) => o.name).join(", ") : "nothing"}
          {st.runIf?.length ? ` · only if ${st.runIf.map((r) => `${r.step}.${r.output}`).join(" or ")} has findings to fix` : ""}
        </>
      }
    >
      <p className="small">
        <strong>{run ? `Context ${run.id} received` : "Context this step would receive now"}</strong>
      </p>
      <ul className="plain small">
        <li>Instruction: “{run ? run.snapshot.purpose : st.purpose}”</li>
        <li>
          Vision r{visionRev}, spec r{spec.rev} with selected option {spec.content.selectedOptionId} and {spec.content.acceptance.length} acceptance check{spec.content.acceptance.length === 1 ? "" : "s"}, pipeline r{pipelineRev}
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
                      <Chip strong>edited by you</Chip>
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
        {stale.length > 0 && <li className="muted">Used outdated {stale.map((i) => `${i.step}.${i.output} v${i.version}`).join(", ")}; newer versions exist.</li>}
      </ul>
    </Disclosure>
  );
}
