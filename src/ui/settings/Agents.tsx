// ORC-025 pass 5, Settings › Agents: the providers and their status, the lead's model, the model per role, how
// many agents run at once, and the limits of each run. Settings wait for Save; Check again acts at once. The
// providers' capability table and sample models are diagnostics, in Advanced.

import { useState } from "react";
import * as M from "../../domain/model";
import { PROVIDERS, ROLES, type ModelSelection, type ProviderId, type RoleId } from "../../domain/types";
import { Button, Checkbox, Field, Input, StatePill } from "../kit";
import { ROLE_LABEL } from "../common";
import { useStore } from "../store";
import { intIn, numIn, sendInOrder, useDraft } from "./draft";
import { ModelField, SettingsCard, SettingsSection } from "./parts";
import type { SectionId } from "./sections";

const WORKER_ROLES = ROLES.filter((r) => r !== "lead") as Exclude<RoleId, "lead">[];

type AgentsDraft = {
  enabled: Record<ProviderId, boolean>;
  lead: ModelSelection;
  projectDefault: ModelSelection;
  roles: Record<string, ModelSelection | null>;
  workerLimit: string;
  limits: Record<ProviderId, string>;
  turns: string;
  minutes: string;
  budget: string;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function AgentsSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, service, send, disabled, refreshHealth } = useStore();
  const p = state.project;
  const real = service.runtime === "real";
  const [checking, setChecking] = useState(false);
  const live: AgentsDraft = {
    enabled: Object.fromEntries(PROVIDERS.map((pr) => [pr, p.enabledProviders.includes(pr)])) as Record<ProviderId, boolean>,
    lead: p.leadSelection,
    projectDefault: p.defaultSelection,
    roles: Object.fromEntries(WORKER_ROLES.map((r) => [r, p.roleDefaults[r] ?? null])),
    workerLimit: String(p.workerLimit),
    limits: Object.fromEntries(PROVIDERS.map((pr) => [pr, String(p.providerLimits?.[pr] ?? p.workerLimit)])) as Record<ProviderId, string>,
    turns: String(p.runLimits.maxTurns),
    minutes: String(p.runLimits.timeoutMinutes),
    budget: String(p.runLimits.maxBudgetUsd),
  };
  const draft = useDraft(live);
  const v = draft.value;
  const enabledList = PROVIDERS.filter((pr) => v.enabled[pr]);

  const errors = {
    lead: !v.enabled[v.lead.provider] ? `${M.providerLabel(v.lead.provider)} is not enabled: enable it, or choose another model for the lead.` : undefined,
    workerLimit: intIn(v.workerLimit, 1, 16) === undefined ? "Between 1 and 16." : undefined,
    ...Object.fromEntries(PROVIDERS.map((pr) => [`limit-${pr}`, intIn(v.limits[pr], 0, 16) === undefined ? "Between 0 and 16." : undefined])),
    turns: intIn(v.turns, 1, 500) === undefined ? "Between 1 and 500." : undefined,
    minutes: numIn(v.minutes, 1, 240) === undefined ? "Between 1 and 240 minutes." : undefined,
    budget: numIn(v.budget, 0.01, 1000) === undefined ? "Between $0.01 and $1000." : undefined,
  } as Record<string, string | undefined>;
  const invalid = Object.values(errors).find(Boolean);

  const save = async (begin: () => void) => {
    begin();
    const turningOn = PROVIDERS.filter((pr) => v.enabled[pr] && !live.enabled[pr]);
    const turningOff = PROVIDERS.filter((pr) => !v.enabled[pr] && live.enabled[pr]);
    const roles = WORKER_ROLES.filter((r) => !same(v.roles[r], live.roles[r]));
    const limits = PROVIDERS.filter((pr) => v.limits[pr] !== live.limits[pr]);
    const runLimitsChanged = draft.changed.has("turns") || draft.changed.has("minutes") || draft.changed.has("budget");
    // A provider is enabled before a model of it is chosen, and disabled only after the choices that leave it.
    return sendInOrder([
      ...turningOn.map((pr) => () => send("setProviderEnabled", { provider: pr, enabled: true })),
      () => (draft.changed.has("lead") ? send("setLeadSelection", { selection: v.lead }) : null),
      () => (draft.changed.has("projectDefault") ? send("setProjectDefault", { selection: v.projectDefault }) : null),
      ...roles.map((role) => () => send("setRoleDefault", { role, selection: v.roles[role] })),
      ...turningOff.map((pr) => () => send("setProviderEnabled", { provider: pr, enabled: false })),
      () => (draft.changed.has("workerLimit") ? send("setWorkerLimit", { limit: Number(v.workerLimit) }) : null),
      ...limits.map((pr) => () => send("setProviderLimit", { provider: pr, limit: Number(v.limits[pr]) })),
      () => (runLimitsChanged ? send("setRunLimits", { maxTurns: Number(v.turns), timeoutMinutes: Number(v.minutes), maxBudgetUsd: Number(v.budget) }) : null),
    ]);
  };

  return (
    <SettingsSection id="agents" title="Agents" help="Which providers and models do the work, and how many agents run at once. Changes here wait for Save; Check again acts at once." current={current} draft={draft} invalid={invalid} onSave={save} onDirty={onDirty}>
      <SettingsCard
        id="providers"
        title="Providers"
        help={
          real
            ? "Status comes from this computer; checking never starts a model run. Claude needs an Anthropic API key (or Bedrock or Vertex credentials); Codex uses your Codex sign-in or API key."
            : "In the demo no provider is connected; every run is simulated."
        }
        actions={
          <Button
            size="small"
            disabled={disabled || checking}
            loading={checking}
            onClick={async () => {
              setChecking(true);
              await refreshHealth();
              setChecking(false);
            }}
          >
            {checking ? "Checking…" : "Check again"}
          </Button>
        }
      >
        {PROVIDERS.map((pr) => {
          const info = service.providers[pr];
          const h = info?.health;
          return (
            <Checkbox
              key={pr}
              checked={v.enabled[pr]}
              onChange={(e) => draft.set({ enabled: { ...v.enabled, [pr]: e.target.checked } })}
              label={
                <span className="s-list__title">
                  {M.providerLabel(pr)}
                  {h ? (
                    <StatePill tone={h.status === "ready" ? "done" : h.status === "not-configured" ? "you" : "fail"}>{h.status === "ready" ? "Ready" : h.status === "not-configured" ? "Not configured" : "Unavailable"}</StatePill>
                  ) : (
                    <StatePill tone="neutral">Checking…</StatePill>
                  )}
                </span>
              }
              hint={(real ? [info?.label, h?.detail].filter(Boolean).join(" · ") : h?.detail) || undefined}
            />
          );
        })}
      </SettingsCard>

      <SettingsCard id="models" title="Models" help="Changes apply to steps not yet started that you have not pinned; a step that is running keeps its model.">
        <div className="s-fields s-fields--wide">
          <ModelField
            state={state}
            label="The lead"
            hint="Answers you, plans, and runs the lead's steps such as verification. Changing it stops a lead run in progress first."
            value={v.lead}
            enabled={enabledList}
            onChange={(sel) => sel && draft.set({ lead: sel })}
          />
          <ModelField state={state} label="Project default" hint="For every role below that uses it." value={v.projectDefault} enabled={enabledList} onChange={(sel) => sel && draft.set({ projectDefault: sel })} />
          {WORKER_ROLES.map((role) => (
            <ModelField
              key={role}
              state={state}
              label={ROLE_LABEL[role]}
              value={v.roles[role]}
              inheritLabel={role === "security_reviewer" ? "Same as the code reviewer" : "Project default"}
              enabled={enabledList}
              onChange={(sel) => draft.set({ roles: { ...v.roles, [role]: sel } })}
            />
          ))}
        </div>
        {errors.lead && <p className="s-error">{errors.lead}</p>}
      </SettingsCard>

      <SettingsCard id="agents-at-once" title="Agents at once" help="How many agents work at the same time. Each provider is also capped by the total; 0 stops new runs on that provider.">
        <div className="s-fields">
          <Field label="All agents" error={errors.workerLimit}>
            <Input type="number" min={1} max={16} value={v.workerLimit} onChange={(e) => draft.set({ workerLimit: e.target.value })} />
          </Field>
          {PROVIDERS.map((pr) => (
            <Field key={pr} label={`${M.providerLabel(pr)} at most`} error={errors[`limit-${pr}`]}>
              <Input type="number" min={0} max={16} value={v.limits[pr]} onChange={(e) => draft.set({ limits: { ...v.limits, [pr]: e.target.value } })} />
            </Field>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard id="run-limits" title="Run limits" help="Applied to every run. A run that reaches the time limit is stopped; turn and spend limits apply to Claude, and Codex runs are bounded by the time limit.">
        <div className="s-fields">
          <Field label="Turns at most" error={errors.turns}>
            <Input type="number" min={1} max={500} value={v.turns} onChange={(e) => draft.set({ turns: e.target.value })} />
          </Field>
          <Field label="Time limit (minutes)" error={errors.minutes}>
            <Input type="number" min={1} max={240} value={v.minutes} onChange={(e) => draft.set({ minutes: e.target.value })} />
          </Field>
          <Field label="Claude budget per run (USD)" error={errors.budget}>
            <Input type="number" min={0.01} max={1000} step={0.5} value={v.budget} onChange={(e) => draft.set({ budget: e.target.value })} />
          </Field>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
