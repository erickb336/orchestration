// Settings › Advanced: the developer forms and the diagnostics, out of the way of the settings
// you use. Pull-request options beyond the basics, what the app found on GitHub, the checks sandbox, the agents'
// environment (real mode), the providers' capabilities, data import and export, and Usage and service.
// Settings wait for Save; Check again, Download, Import, Remove, the housekeeping checkbox and Clean up now act at
// once (the intro says so).

import { useState } from "react";
import * as M from "../../domain/model";
import { PROVIDERS, type ProviderId, type WorkerEnvironment } from "../../domain/types";
import type { CapabilityMap } from "../../runtime/adapter";
import { Banner, Button, ButtonLink, Checkbox, Chip, Field, SimulatedChip, Textarea, useConfirm } from "../kit";
import { GitHubCard, PullRequestOptionsCard, livePrOptions, prOptionsErrors, prOptionsSteps, type PrOptionsDraft } from "../DeliverySettings";
import { SandboxCard, liveSandbox, sandboxErrors, sandboxProblem, sandboxSteps, type SandboxDraft } from "../ChecksSettings";
import { DiagnosticsCard } from "../Diagnostics";
import { useStore } from "../store";
import { sendInOrder, useDraft } from "./draft";
import { Choice, SettingsCard, SettingsSection } from "./parts";
import type { SectionId } from "./sections";

type EnvDraft = { env: Record<ProviderId, WorkerEnvironment>; connections: Record<ProviderId, string[]> };
type AdvancedDraft = PrOptionsDraft & SandboxDraft & EnvDraft;

// Which of the section's fields belong to which save (a Record of every key, so a new field cannot be left out).
const PR_FIELDS: Record<keyof PrOptionsDraft, true> = { maxOpen: true, reviewer: true, update: true, repair: true, localOk: true, perDay: true, paths: true, rerunBudget: true, bots: true, noCi: true };
const SANDBOX_FIELDS: Record<keyof SandboxDraft, true> = { sandbox: true, prepareNetwork: true, commandTimeout: true, runTimeout: true, maxConcurrent: true, inputs: true, passEnv: true };
const PR_KEYS = Object.keys(PR_FIELDS) as (keyof PrOptionsDraft)[];
const SANDBOX_KEYS = Object.keys(SANDBOX_FIELDS) as (keyof SandboxDraft)[];

const pick = <K extends string>(changed: ReadonlySet<string>, keys: readonly K[]) => new Set(keys.filter((k) => changed.has(k)));

const CAP_LABEL: Record<keyof CapabilityMap, string> = {
  start: "Start",
  streamEvents: "Stream events",
  steer: "Live steering",
  interrupt: "Interrupt",
  resume: "Resume",
  usageReporting: "Usage reporting",
  childAgentTracking: "Child-agent tracking",
};

export function AdvancedSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, service, send } = useStore();
  const confirm = useConfirm();
  const real = service.runtime === "real";
  const p = state.project;
  const live: AdvancedDraft = {
    ...livePrOptions(state),
    ...liveSandbox(state),
    env: Object.fromEntries(PROVIDERS.map((pr) => [pr, p.workerEnvironment[pr]])) as Record<ProviderId, WorkerEnvironment>,
    connections: Object.fromEntries(PROVIDERS.map((pr) => [pr, [...p.workerConnections[pr]]])) as Record<ProviderId, string[]>,
  };
  const draft = useDraft(live);
  const v = draft.value;
  const prChanged = pick(draft.changed as ReadonlySet<string>, PR_KEYS);
  const sandboxChanged = pick(draft.changed as ReadonlySet<string>, SANDBOX_KEYS);
  const invalid =
    (prChanged.size ? Object.values(prOptionsErrors(v)).find(Boolean) : undefined) ??
    (sandboxChanged.size ? (Object.values(sandboxErrors(v)).find(Boolean) ?? sandboxProblem(state, v)) : undefined);

  const save = async (begin: () => void) => {
    const pr = await prOptionsSteps(state, real, v, prChanged, send, confirm);
    if (!pr) return false;
    begin();
    const envs = PROVIDERS.filter((x) => v.env[x] !== live.env[x]);
    const conns = PROVIDERS.filter((x) => JSON.stringify(v.connections[x]) !== JSON.stringify(live.connections[x]));
    return sendInOrder([
      ...pr,
      ...sandboxSteps(state, v, sandboxChanged, send),
      ...envs.map((x) => () => send("setWorkerEnvironment", { provider: x, environment: v.env[x] })),
      ...conns.map((x) => () => send("setWorkerConnections", { provider: x, names: v.connections[x] })),
    ]);
  };

  return (
    <SettingsSection
      id="advanced"
      title="Advanced"
      help="Developer settings and diagnostics. Most changes here wait for Save. These act at once: Check again, Download, Import, Remove, the housekeeping checkbox and Clean up now."
      current={current}
      draft={draft}
      invalid={invalid}
      onSave={save}
      onDirty={onDirty}
    >
      <PullRequestOptionsCard v={v} set={draft.set} />
      <GitHubCard />
      <SandboxCard v={v} set={draft.set} confirm={confirm} />
      {real && <AgentEnvironmentCard v={v} set={draft.set} />}
      <CapabilitiesCard />
      <DataCard />
      <DiagnosticsCard />
    </SettingsSection>
  );
}

/** Real mode: what each provider's agents may use from your own setup. */
function AgentEnvironmentCard({ v, set }: { v: EnvDraft; set: (p: Partial<EnvDraft>) => void }) {
  const { service } = useStore();
  return (
    <SettingsCard
      id="agent-environment"
      title="Agent environment"
      help="Either way, an agent's own edits stay in its worktree and native sub-agents stay off. Connections (MCP servers) and plugins run with your permissions and are not sandboxed; allow only ones you trust. Applies to runs started after the change."
    >
      {PROVIDERS.map((provider) => {
        const found = service.providers[provider]?.connections;
        const allowed = v.connections[provider];
        const names = [...new Set([...(found ?? []).map((c) => c.name), ...allowed])].sort();
        const toggle = (name: string, on: boolean) => set({ connections: { ...v.connections, [provider]: on ? [...allowed, name] : allowed.filter((n) => n !== name) } });
        const label = M.providerLabel(provider);
        return (
          <fieldset key={provider} className="s-choices s-gap">
            <legend className="k-field__label">{label}</legend>
            <Choice name={`env-${provider}`} checked={v.env[provider] === "isolated"} onChange={() => set({ env: { ...v.env, [provider]: "isolated" } })} label="Isolated" description="Only the connections chosen below.">
              <div className="s-card-help">
                From your own {label} configuration ({provider === "claude" ? "~/.claude.json" : "config.toml"}){found === null ? ": could not be read, so isolated runs get none." : names.length === 0 ? ": none configured." : ":"}
              </div>
              {names.map((n) => {
                const f = found?.find((c) => c.name === n);
                return (
                  <Checkbox
                    key={n}
                    checked={allowed.includes(n)}
                    onChange={(e) => toggle(n, e.target.checked)}
                    label={
                      <span className="s-list__title">
                        <span className="s-mono">{n}</span>
                        {!f && <Chip>not found</Chip>}
                        {f && !f.enabled && <Chip>off in your config</Chip>}
                      </span>
                    }
                  />
                );
              })}
            </Choice>
            <Choice
              name={`env-${provider}`}
              checked={v.env[provider] === "local"}
              onChange={() => set({ env: { ...v.env, [provider]: "local" } })}
              label="Use my local setup"
              description={`My ${label} settings, plugins and all MCP servers.${provider === "codex" ? " Codex agents can read files outside their worktree; their writes and network access are sandboxed." : ""}`}
            />
          </fieldset>
        );
      })}
    </SettingsCard>
  );
}

/** What each provider's adapter can do, and its models: diagnostics. */
function CapabilitiesCard() {
  const { state, service } = useStore();
  const real = service.runtime === "real";
  return (
    <SettingsCard id="capabilities" title="Provider capabilities" help={real ? "What each adapter on this computer reports it can do, and its models." : "In the demo these describe the simulation, not a real provider."}>
      <div className="s-tables">
        {PROVIDERS.map((prov) => {
          const info = service.providers[prov];
          return (
            <table key={prov} className="s-table">
              <caption className="sr-only">{M.providerLabel(prov)}</caption>
              <thead>
                <tr>
                  <th colSpan={2}>
                    {M.providerLabel(prov)} {!real && <SimulatedChip />}
                  </th>
                </tr>
              </thead>
              <tbody>
                {info &&
                  (Object.keys(CAP_LABEL) as (keyof CapabilityMap)[]).map((k) => (
                    <tr key={k}>
                      <td>{CAP_LABEL[k]}</td>
                      <td>{info.capabilities[k]}</td>
                    </tr>
                  ))}
                <tr>
                  <td>{real ? "Models" : "Sample models"}</td>
                  <td className="s-mono">{state.project.catalog[prov].map((m) => m.id).join(", ") || "none"}</td>
                </tr>
              </tbody>
            </table>
          );
        })}
      </div>
    </SettingsCard>
  );
}

/** Export, import, and workspace cleanup: actions, each with its own button. */
function DataCard() {
  const { service, send, disabled, postJson } = useStore();
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<{ imported: string[]; skipped: string[] } | null>(null);
  const [pruned, setPruned] = useState<number | null>(null);
  const [pruning, setPruning] = useState(false);
  const real = service.runtime === "real";
  const runImport = async () => {
    setBusy(true);
    const r = await send("importMarkdown", { markdown });
    setBusy(false);
    if (r.ok) {
      const res = r.result as { imported?: string[]; skipped?: string[] } | undefined;
      setImported({ imported: res?.imported ?? [], skipped: res?.skipped ?? [] });
      setMarkdown("");
    }
  };
  return (
    <SettingsCard id="data" title="Data" help="Take the board out as Markdown, bring tasks in from a Markdown table, and clean up finished workspaces.">
      <h4 className="s-sub">Export</h4>
      <p className="s-card-help">Every task with its state, chosen approach and delivery status.</p>
      <ButtonLink size="small" href="/api/export.md" download="orchestration-board.md">
        Download board (Markdown)
      </ButtonLink>

      <h4 className="s-sub">Import</h4>
      <Field
        label="Markdown task table"
        hint='An ID column and a Title (or Task, or Outcome) column. Existing IDs are skipped; finished rows arrive as done tasks marked "legacy spec unavailable", and open rows wait for a spec before they run.'
      >
        <Textarea value={markdown} onChange={(e) => setMarkdown(e.target.value)} placeholder={"| ID | Title | Status |\n| --- | --- | --- |\n| T-1 | Example task | Done |"} rows={4} />
      </Field>
      <Button size="small" disabled={disabled || busy || !markdown.trim()} loading={busy} onClick={() => void runImport()}>
        {busy ? "Importing…" : "Import"}
      </Button>
      {imported && (
        <p role="status" className="s-note">
          Imported {imported.imported.length}, skipped {imported.skipped.length}.
          {imported.imported.length > 0 && (
            <>
              {" "}
              {imported.imported.map((id, i) => (
                <span key={id}>
                  {i > 0 && ", "}
                  <a href={`#/task/${encodeURIComponent(id)}`}>{id}</a>
                </span>
              ))}
            </>
          )}
          {imported.skipped.length > 0 && <> (already on the board: {imported.skipped.join(", ")})</>}
        </p>
      )}

      <h4 className="s-sub">Cleanup</h4>
      {real ? (
        <>
          <p className="s-card-help">Removes the worktrees of finished runs. Active runs are never touched and branches are kept, so every recorded change stays reachable.</p>
          <div className="s-inline">
            <Button
              size="small"
              disabled={disabled || pruning}
              loading={pruning}
              onClick={async () => {
                setPruning(true);
                setPruned(null);
                const r = await postJson("/api/maintenance/prune", {});
                setPruning(false);
                if (r.ok) {
                  const removed = (r.body as { removed?: unknown } | null)?.removed;
                  setPruned(typeof removed === "number" ? removed : 0);
                }
              }}
            >
              {pruning ? "Removing…" : "Remove finished workspaces"}
            </Button>
            {pruned !== null && (
              <span role="status" className="muted small">
                Removed {pruned} workspace{pruned === 1 ? "" : "s"}.
              </span>
            )}
          </div>
        </>
      ) : (
        <Banner tone="info">Available when real agents run; the sample project has no workspaces.</Banner>
      )}
    </SettingsCard>
  );
}
