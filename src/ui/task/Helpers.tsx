// Helper agents (ORC-031): a run's helpers (the provider's own subagents) under Details › Runs, and the setting
// "Let research steps start helpers" beside a research step's model. The words live in src/ui/helpersView.ts.

import type { StudioRun } from "../../domain/studio/types";
import { DEFAULT_SUBAGENT_CAP, type Attempt, type LeadRun, type State } from "../../domain/types";
import { CAP_CHOICES, allowanceLine, helperLine, helperSetting, helpersLine, helpersUnseen, unlistedLine } from "../helpersView";
import { Actions, Button, Checkbox, Field, Select } from "../kit";
import { useStore } from "../store";

/** What the run was allowed, its helpers' count, most at once and cost, and each helper; Mark as seen where none was allowed. */
export function RunHelpers({ run }: { run: Attempt | LeadRun | StudioRun }) {
  const { send, disabled } = useStore();
  const line = helpersLine(run);
  const items = run.subagents?.items ?? [];
  const more = unlistedLine(run);
  return (
    <div className="k-stack k-stack--tight">
      <span>{allowanceLine(run)}</span>
      {line && <span>{line}</span>}
      {items.length > 0 && (
        <ul className="plain" aria-label={`Helpers of ${run.id}`}>
          {items.map((h) => (
            <li key={h.id}>{helperLine(run, h)}</li>
          ))}
        </ul>
      )}
      {more && <span className="muted">{more}</span>}
      {helpersUnseen(run) && (
        <Actions>
          <Button size="small" disabled={disabled} title="It leaves Needs you; the record stays on the run" onClick={() => void send("markSubagentsSeen", { runId: run.id })}>
            Mark as seen
          </Button>
        </Actions>
      )}
    </div>
  );
}

/** The setting for one research step, for every task that runs it in this project. */
export function HelpersSetting({ state, settingKey }: { state: State; settingKey: string }) {
  const { send, disabled } = useStore();
  const v = helperSetting(state, settingKey);
  if (!v) return null;
  const on = v.cap !== null;
  return (
    <div className="k-stack k-stack--tight">
      <Checkbox
        label="Let research steps start helpers"
        hint={`For ${v.label} in every task of this project. Helpers are the provider's own subagents; they read only, like the step. ${v.why}`}
        checked={on}
        disabled={disabled || (!on && !v.canTurnOn)}
        onChange={(e) => void send("setResearchHelpers", { step: v.key, cap: e.target.checked ? DEFAULT_SUBAGENT_CAP : null })}
      />
      {on && (
        <Field label="Helpers per run, at most" width="short">
          <Select value={String(v.cap)} disabled={disabled} options={CAP_CHOICES.map((n) => ({ value: String(n), label: String(n) }))} onChange={(e) => void send("setResearchHelpers", { step: v.key, cap: Number(e.target.value) })} />
        </Field>
      )}
    </div>
  );
}
