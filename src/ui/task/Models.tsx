// Details › Models: the provider and model of each step (a picker for the next attempt, what ran for a
// finished one, how the service runs a Checks step), and the task's role overrides.

import * as C from "../../domain/checks";
import * as M from "../../domain/model";
import { ROLES, type State, type Step, type Task } from "../../domain/types";
import { ModelPicker, ROLE_LABEL, selectionText } from "../common";
import { principlesText } from "../flowView";
import { Button, useConfirm } from "../kit";
import { cardHref } from "../settings/sections";
import { useStore } from "../store";
import { CONFIRM } from "./confirms";
import { isOpenTask } from "./needsYouItems";
import { lastCompletedRun, stepName } from "./stepWords";

export function ModelsSection({ state, task }: { state: State; task: Task }) {
  const { send, disabled, service } = useStore();
  const open = isOpenTask(task);
  const usedRoles = [...new Set(task.steps.map((s) => s.role))];
  return (
    <div className="k-stack">
      <p className="small muted">
        Each step runs on the provider and model resolved as: pinned on the step → this task's role override → the project's role default → the project default. Finished steps show the model that ran.{" "}
        {service.runtime === "real" ? "Models come from each provider's catalog." : "The model catalog is sample data."} The project's defaults are in{" "}
        <a href={cardHref("models")}>Settings › Agents</a>.
      </p>
      <div className="t-models">
        {task.steps.map((st) => (
          <StepModel key={st.id} state={state} task={task} st={st} open={open} />
        ))}
      </div>
      {open && (
        <div>
          <h3 className="meta">Task role overrides</h3>
          <p className="small muted">
            Apply to every unpinned step of this role in this task.
            {usedRoles.includes("security_reviewer") ? " The security reviewer has its own row: an override of the code reviewer does not change it." : ""}
          </p>
          <div className="t-models">
            {ROLES.filter((r) => usedRoles.includes(r)).map((role) => (
              <div key={role} className="t-models__step">
                <strong>{ROLE_LABEL[role]}</strong>
                <ModelPicker
                  state={state}
                  label={`Task override for ${ROLE_LABEL[role]}`}
                  value={task.roleOverrides[role] ?? null}
                  allowInherit
                  inheritLabel={role === "security_reviewer" && !state.project.roleDefaults.security_reviewer ? "Project default (the code reviewer's)" : "Project default"}
                  disabled={disabled}
                  onChange={(v) => void send("setTaskRoleOverride", { taskId: task.id, role, selection: v })}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One step: the picker for its next attempt, what ran, or how the service runs a Checks step; and the principles its agent gets. */
function StepModel({ state, task, st, open }: { state: State; task: Task; st: Step; open: boolean }) {
  const { send, disabled } = useStore();
  const confirm = useConfirm();
  const r = M.resolveStep(state, task, st);
  const activeRun = M.activeAttempts(state, task.id).find((a) => a.stepId === st.id);
  const lastRun = lastCompletedRun(state, task, st);
  const done = st.state === "done";
  const shownRun = activeRun ?? (done ? lastRun : undefined);
  // The principles the step's agent gets: what its run recorded when it has one, else the step's own set.
  const given = st.state === "skipped" ? [] : (shownRun?.snapshot.principles ?? (shownRun ? [] : M.runPrinciples(state, task, st)));
  const head = (
    <strong>
      {st.id} {stepName(st)} <span className="muted">· {ROLE_LABEL[st.role]}</span>
    </strong>
  );
  let body: React.ReactNode;
  if (st.role === "checks") {
    // A Checks step is run by the service; it has no provider or model to choose.
    body = (
      <span>
        Run by the service{C.checksOn(state.project.checks) ? ` · ${state.project.checks.sandbox === "codex" ? "sandboxed" : "no sandbox"}` : ""}.{" "}
        <span className="muted">
          {C.checksOn(state.project.checks) ? (
            <>
              {st.checks?.onFail === "block" ? "Stops the task and asks for a decision when checks fail" : "Failing checks become findings for the repair step"}.
              {activeRun ? ` Running as ${activeRun.id}.` : lastRun && done ? ` Ran as ${lastRun.id}.` : ""}
            </>
          ) : (
            <>
              {st.state === "skipped" ? "Skipped: checks are off" : "Will be skipped: checks are off"} (<a href={cardHref("checks")}>Settings › Quality › Checks</a>).
            </>
          )}
        </span>
      </span>
    );
  } else if (done && lastRun) {
    body = (
      <span>
        {selectionText(lastRun.snapshot)} <span className="muted">· ran as {lastRun.id} · {M.sourceLabel(lastRun.snapshot.source).toLowerCase()}</span>
      </span>
    );
  } else if (st.state === "skipped") {
    body = <span className="muted">Not run: its condition had nothing to fix. Re-evaluated if an upstream step reruns.</span>;
  } else if (!open) {
    body = <span className="muted">{r.ok ? selectionText(r.selection) : "—"}</span>;
  } else {
    body = (
      <>
        {activeRun && (
          <span>
            {selectionText(activeRun.snapshot)} <span className="muted">· {activeRun.outcome === "stopping" ? "stopping" : "running"} as {activeRun.id}; the next attempt uses:</span>
          </span>
        )}
        <ModelPicker
          state={state}
          label={`Model for next attempt of ${st.id}`}
          value={st.selection}
          allowInherit
          inheritLabel={`Inherited${r.ok && st.selection === null ? `: ${selectionText(r.selection)}` : ""}`}
          disabled={disabled}
          onChange={async (v) => {
            if (st.state === "running" && !(await confirm(CONFIRM.changeModelWhileRunning(st.id)))) return;
            void send("setStepSelection", { taskId: task.id, stepId: st.id, selection: v });
          }}
        />
        <span className="small muted">
          {st.selection ? (
            <>
              Pinned by you ·{" "}
              <Button size="small" variant="quiet" disabled={disabled} onClick={() => void send("setStepSelection", { taskId: task.id, stepId: st.id, selection: null })}>
                Reset to default
              </Button>
            </>
          ) : r.ok ? (
            M.sourceLabel(r.source)
          ) : null}
          {r.ok && r.selection.model !== (st.selection ?? r.selection).model ? ` · ${r.reason}` : ""}
        </span>
        {!r.ok && <span className="small k-field__error">{r.reason}</span>}
      </>
    );
  }
  return (
    <div className="t-models__step">
      {head}
      {body}
      {given.length > 0 && <span className="small muted">{principlesText(given)}</span>}
    </div>
  );
}
