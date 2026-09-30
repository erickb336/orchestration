import { useEffect, useState } from "react";
import * as M from "../domain/model";
import { PROVIDERS, ROLES, type WorkflowTemplate } from "../domain/types";
import { BUILT_IN_TEMPLATES, isModifiedBuiltIn } from "../domain/templates";
import { PipelineEditor } from "./PipelineEditor";
import type { CapabilityMap } from "../runtime/adapter";
import { useStore } from "./store";
import { ModelPicker, ROLE_LABEL, fmtTime, relTime } from "./common";

const CAP_LABEL: Record<keyof CapabilityMap, string> = {
  start: "Start",
  streamEvents: "Stream events",
  steer: "Live steering",
  interrupt: "Interrupt",
  resume: "Resume",
  usageReporting: "Usage reporting",
  childAgentTracking: "Child-agent tracking",
};

export function Settings() {
  const { state, service, send, disabled } = useStore();
  const p = state.project;
  const [repo, setRepo] = useState(p.repoPath);
  const [limit, setLimit] = useState(String(p.workerLimit));
  // Follow the live value when it changes elsewhere (another tab, a new project, the service).
  useEffect(() => setRepo(p.repoPath), [p.repoPath]);
  useEffect(() => setLimit(String(p.workerLimit)), [p.workerLimit]);
  return (
    <>
      <h1>Settings</h1>
      <div className="grid-2">
        <div>
          <section className="card" aria-labelledby="proj-h">
            <h2 id="proj-h">Project</h2>
            <label className="field">
              <span>Managed repository path</span>
              <div className="row">
                <input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} style={{ flex: 1 }} />
                <button disabled={disabled || repo === p.repoPath} onClick={() => void send("setRepoPath", { repoPath: repo })}>
                  Save
                </button>
              </div>
            </label>
            <label className="field">
              <span>Total worker limit</span>
              <div className="row">
                <input type="number" min={1} max={8} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: "5rem" }} />
                <button disabled={disabled || Number(limit) === p.workerLimit} onClick={() => void send("setWorkerLimit", { limit: Number(limit) })}>
                  Save
                </button>
              </div>
            </label>
          </section>

          <section className="card" aria-labelledby="defaults-h">
            <h2 id="defaults-h">Model defaults</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Changes apply to steps not yet dispatched that you haven't pinned. Runs already dispatched keep the configuration they started with.
            </p>
            <dl className="kv">
              <dt>Project default</dt>
              <dd>
                <ModelPicker state={state} label="Project default model" value={p.defaultSelection} disabled={disabled} onChange={(v) => v && void send("setProjectDefault", { selection: v })} />
              </dd>
              {ROLES.map((role) => (
                <div key={role} style={{ display: "contents" }}>
                  <dt>{ROLE_LABEL[role]}</dt>
                  <dd>
                    <ModelPicker
                      state={state}
                      label={`Default for ${ROLE_LABEL[role]}`}
                      value={p.roleDefaults[role] ?? null}
                      allowInherit
                      inheritLabel="Use project default"
                      disabled={disabled}
                      onChange={(v) => void send("setRoleDefault", { role, selection: v })}
                    />
                  </dd>
                </div>
              ))}
            </dl>
            <h3 style={{ marginTop: "1rem" }}>Lead agent</h3>
            <label className="field">
              <span>Conversation and planning</span>
              <ModelPicker state={state} label="Lead agent model" value={p.leadSelection} disabled={disabled} onChange={(v) => v && void send("setLeadSelection", { selection: v })} />
            </label>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: 0 }}>
              The lead answers the conversation and proposes tasks. Switching stops an active lead run first; the next run uses the new lead. Setting it also sets the Lead default above, which applies to lead-owned
              steps such as verification.
            </p>
          </section>
          <Templates />
        </div>

        <div>
          <Providers />
          <AutonomyCard />
          <RunLimitsCard />
          {service.runtime === "real" && <ProjectSetup />}
        </div>
      </div>
    </>
  );
}

function Providers() {
  const { state, service, send, disabled, refreshHealth } = useStore();
  const p = state.project;
  const [checking, setChecking] = useState(false);
  const real = service.runtime === "real";
  return (
    <section className="card" aria-labelledby="prov-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="prov-h">Providers</h2>
        <button
          className="small"
          disabled={disabled || checking}
          onClick={async () => {
            setChecking(true);
            await refreshHealth();
            setChecking(false);
          }}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        {real
          ? "Status comes from the adapters on this machine. Checking never starts a model run. Claude needs an Anthropic API key (or Bedrock/Vertex credentials); Codex uses your local Codex sign-in or API key."
          : "Fake runtime: no provider is connected and capabilities describe the simulation. Start the service with ORCHESTRATION_RUNTIME=real to run Claude and Codex."}
      </p>
      {PROVIDERS.map((prov) => {
        const info = service.providers[prov];
        const enabled = p.enabledProviders.includes(prov);
        const h = info?.health;
        const tone = h?.status === "ready" ? "done" : h?.status === "not-configured" ? "paused" : "blocked";
        return (
          <div key={prov} style={{ marginBottom: "1rem" }}>
            <label className="row">
              <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => void send("setProviderEnabled", { provider: prov, enabled: e.target.checked })} />
              <strong>{M.providerLabel(prov)}</strong>
              {h ? <span className={`pill ${tone}`}>{h.status === "ready" ? "Ready" : h.status === "not-configured" ? "Not configured" : "Unavailable"}</span> : <span className="chip">checking…</span>}
            </label>
            <div className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.4rem" }}>
              {info?.label}
              {h && <div>{h.detail}</div>}
            </div>
            {real && <WorkerEnvironmentControls provider={prov} />}
            <table>
              <tbody>
                {info &&
                  (Object.keys(CAP_LABEL) as (keyof CapabilityMap)[]).map((k) => (
                    <tr key={k}>
                      <td>{CAP_LABEL[k]}</td>
                      <td>
                        <span className="chip">{info.capabilities[k]}</span>
                      </td>
                    </tr>
                  ))}
                <tr>
                  <td>{real ? "Models" : "Sample models"}</td>
                  <td className="mono">{p.catalog[prov].map((m) => m.id).join(", ") || "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}

function WorkerEnvironmentControls({ provider }: { provider: (typeof PROVIDERS)[number] }) {
  const { state, service, send, disabled } = useStore();
  const env = state.project.workerEnvironment[provider];
  const allowed = state.project.workerConnections[provider];
  const found = service.providers[provider]?.connections;
  const names = [...new Set([...(found ?? []).map((c) => c.name), ...allowed])].sort();
  const toggle = (name: string, on: boolean) => void send("setWorkerConnections", { provider, names: on ? [...allowed, name] : allowed.filter((n) => n !== name) });
  return (
    <fieldset className="option-edit" style={{ margin: "0.3rem 0 0.6rem" }} disabled={disabled}>
      <legend>Worker environment</legend>
      <label className="row" style={{ gap: "0.35rem" }}>
        <input type="radio" name={`env-${provider}`} checked={env === "isolated"} onChange={() => void send("setWorkerEnvironment", { provider, environment: "isolated" })} />
        Isolated: only the connections selected below
      </label>
      <label className="row" style={{ gap: "0.35rem" }}>
        <input type="radio" name={`env-${provider}`} checked={env === "local"} onChange={() => void send("setWorkerEnvironment", { provider, environment: "local" })} />
        Use my local setup: my {M.providerLabel(provider)} settings, plugins, and all MCP servers
      </label>
      {env === "isolated" && (
        <div style={{ marginTop: "0.4rem" }}>
          <div className="muted" style={{ fontSize: "0.82rem" }}>
            Connections from your own {M.providerLabel(provider)} configuration{provider === "claude" ? " (~/.claude.json)" : " (config.toml)"}:
          </div>
          {found === null && <div className="muted" style={{ fontSize: "0.82rem" }}>Could not read them; isolated runs get none.</div>}
          {names.length === 0 && found !== null && <div className="muted" style={{ fontSize: "0.82rem" }}>None configured.</div>}
          <div className="row">
            {names.map((n) => {
              const f = found?.find((c) => c.name === n);
              return (
                <label key={n} className="row" style={{ gap: "0.25rem" }}>
                  <input type="checkbox" checked={allowed.includes(n)} onChange={(e) => toggle(n, e.target.checked)} />
                  <span className="mono">{n}</span>
                  {!f && <span className="chip">not found</span>}
                  {f && !f.enabled && <span className="chip">off in your config</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.4rem" }}>
        Either way, the worker's own file edits stay inside its worktree and native sub-agents stay off. Connections (MCP servers) and plugins are separate programs running with your permissions and are not
        sandboxed; allow only ones you trust with automated use.{provider === "codex" ? " Codex workers can read files outside their worktree; their writes and network access are sandboxed." : ""} Applies to runs
        started after the change.
      </div>
    </fieldset>
  );
}

function AutonomyCard() {
  const { state, send, disabled } = useStore();
  const a = state.project.autonomy;
  const lastPlanning = state.project.lastPlanningAt;
  const openProposals = M.openLeadProposals(state).length;
  const [enabled, setEnabled] = useState(a.enabled);
  const [interval, setIntervalMinutes] = useState(String(a.planningIntervalMinutes));
  const [perCycle, setPerCycle] = useState(String(a.maxProposalsPerCycle));
  const [maxOpen, setMaxOpen] = useState(String(a.maxOpenProposals));
  const [hold, setHold] = useState(a.holdLeadProposals);
  const [limitHours, setLimitHours] = useState(a.operatingHours !== null);
  const [start, setStart] = useState(a.operatingHours?.start ?? "09:00");
  const [end, setEnd] = useState(a.operatingHours?.end ?? "18:00");
  // Follow the live values when they change elsewhere (another tab, the service).
  const hoursKey = a.operatingHours ? `${a.operatingHours.start}-${a.operatingHours.end}` : "";
  useEffect(() => {
    setEnabled(a.enabled);
    setIntervalMinutes(String(a.planningIntervalMinutes));
    setPerCycle(String(a.maxProposalsPerCycle));
    setMaxOpen(String(a.maxOpenProposals));
    setHold(a.holdLeadProposals);
    setLimitHours(a.operatingHours !== null);
    if (a.operatingHours) {
      setStart(a.operatingHours.start);
      setEnd(a.operatingHours.end);
    }
  }, [a.enabled, a.planningIntervalMinutes, a.maxProposalsPerCycle, a.maxOpenProposals, a.holdLeadProposals, hoursKey]);

  const hours = limitHours ? { start, end } : null;
  const changed =
    enabled !== a.enabled ||
    Number(interval) !== a.planningIntervalMinutes ||
    Number(perCycle) !== a.maxProposalsPerCycle ||
    Number(maxOpen) !== a.maxOpenProposals ||
    hold !== a.holdLeadProposals ||
    (hours ? `${hours.start}-${hours.end}` : "") !== hoursKey;
  const n = Number(perCycle) > 0 ? Number(perCycle) : a.maxProposalsPerCycle;
  return (
    <section className="card" aria-labelledby="autonomy-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="autonomy-h" style={{ margin: 0 }}>
          Autonomy
        </h2>
        <span className={a.enabled ? "pill running" : "chip"}>{a.enabled ? "On" : "Off"}</span>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.4rem" }}>
        Off by default. When on, the lead may propose up to {n} task{n === 1 ? "" : "s"} per planning run; they run through their pipelines without further prompting unless held. The lead never edits existing tasks or
        your pinned choices.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send("setAutonomy", {
            enabled,
            planningIntervalMinutes: Number(interval),
            maxProposalsPerCycle: Number(perCycle),
            maxOpenProposals: Number(maxOpen),
            holdLeadProposals: hold,
            operatingHours: hours,
          });
        }}
      >
        <fieldset className="plain-fieldset" disabled={disabled}>
          <label className="row field" style={{ gap: "0.4rem" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <strong>Let the lead plan and propose tasks on its own</strong>
          </label>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <label className="field">
              <span>Planning interval (minutes)</span>
              <input type="number" min={5} max={1440} value={interval} onChange={(e) => setIntervalMinutes(e.target.value)} style={{ width: "6rem" }} />
            </label>
            <label className="field">
              <span>Max proposals per run</span>
              <input type="number" min={1} max={10} value={perCycle} onChange={(e) => setPerCycle(e.target.value)} style={{ width: "6rem" }} />
            </label>
            <label className="field">
              <span>Max open lead proposals</span>
              <input type="number" min={1} max={50} value={maxOpen} onChange={(e) => setMaxOpen(e.target.value)} style={{ width: "6rem" }} />
            </label>
          </div>
          <label className="row field" style={{ gap: "0.4rem" }}>
            <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} />
            Hold lead proposals before start (each waits for you to release it)
          </label>
          <div className="row" style={{ gap: "0.4rem", marginBottom: "0.8rem" }}>
            <label className="row" style={{ gap: "0.4rem" }}>
              <input type="checkbox" checked={limitHours} onChange={(e) => setLimitHours(e.target.checked)} />
              Only between
            </label>
            <input type="time" aria-label="Operating hours start" value={start} disabled={!limitHours} onChange={(e) => setStart(e.target.value)} required={limitHours} />
            <span className="muted">and</span>
            <input type="time" aria-label="Operating hours end" value={end} disabled={!limitHours} onChange={(e) => setEnd(e.target.value)} required={limitHours} />
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              (this machine's local time)
            </span>
          </div>
          <button type="submit" disabled={!changed}>
            Save autonomy
          </button>
        </fieldset>
      </form>
      <p className="muted" style={{ fontSize: "0.82rem", margin: "0.6rem 0 0" }}>
        Open lead proposals: {openProposals} of {a.maxOpenProposals}. Planning waits while the project is paused.{" "}
        {lastPlanning ? (
          <>
            Last planning run: <span title={fmtTime(lastPlanning)}>{relTime(lastPlanning)}</span>.
          </>
        ) : (
          "No planning run yet."
        )}{" "}
        Your messages are answered whether or not autonomy is on.
      </p>
    </section>
  );
}

function RunLimitsCard() {
  const { state, send, disabled } = useStore();
  const l = state.project.runLimits;
  const [turns, setTurns] = useState(String(l.maxTurns));
  const [minutes, setMinutes] = useState(String(l.timeoutMinutes));
  const [budget, setBudget] = useState(String(l.maxBudgetUsd));
  useEffect(() => {
    setTurns(String(l.maxTurns));
    setMinutes(String(l.timeoutMinutes));
    setBudget(String(l.maxBudgetUsd));
  }, [l.maxTurns, l.timeoutMinutes, l.maxBudgetUsd]);
  const changed = Number(turns) !== l.maxTurns || Number(minutes) !== l.timeoutMinutes || Number(budget) !== l.maxBudgetUsd;
  return (
    <section className="card" aria-labelledby="limits-h">
      <h2 id="limits-h">Run limits</h2>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Applied to every run attempt. A run that reaches the time limit is interrupted. Turn and spend limits are enforced only where the provider supports them (Claude); Codex runs are bounded by the time limit.
      </p>
      <div className="row">
        <label className="field">
          <span>Max turns</span>
          <input type="number" min={1} value={turns} onChange={(e) => setTurns(e.target.value)} style={{ width: "6rem" }} />
        </label>
        <label className="field">
          <span>Time limit (minutes)</span>
          <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: "6rem" }} />
        </label>
        <label className="field">
          <span>Claude budget (USD)</span>
          <input type="number" min={0.01} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: "6rem" }} />
        </label>
      </div>
      <button disabled={disabled || !changed} onClick={() => void send("setRunLimits", { maxTurns: Number(turns), timeoutMinutes: Number(minutes), maxBudgetUsd: Number(budget) })}>
        Save limits
      </button>
    </section>
  );
}

function ProjectSetup() {
  const { state, service, send, disabled } = useStore();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [vision, setVision] = useState("");
  const [focus, setFocus] = useState("");
  const repoOk = service.repo?.ok;
  return (
    <section className="card" aria-labelledby="setup-h">
      <h2 id="setup-h">Project</h2>
      <p style={{ fontSize: "0.9rem" }}>
        Repository: <span className="mono">{state.project.repoPath}</span>{" "}
        {repoOk ? <span className="pill done">Ready{service.repo?.branch ? ` (${service.repo.branch})` : ""}</span> : <span className="pill blocked">Not usable</span>}
      </p>
      {!repoOk && service.repo?.reason && <div className="banner danger">{service.repo.reason}</div>}
      <details open={!repoOk}>
        <summary>Start a new project</summary>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Replaces the board with an empty project for the repository below. Refused while any run is active. The repository must be a git repository with at least one commit; agents work in separate worktrees and never
          edit its working tree or merge into its branches.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!confirm(`Start a new project "${name}"? The current board and history are replaced.`)) return;
            await send("initProject", { name, repoPath: repo, vision, focus });
          }}
        >
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Repository path (absolute)</span>
            <input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/path/to/your/repo" required />
          </label>
          <label className="field">
            <span>Vision</span>
            <textarea value={vision} onChange={(e) => setVision(e.target.value)} required />
          </label>
          <label className="field">
            <span>Current focus</span>
            <input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
          </label>
          <button type="submit" className="primary" disabled={disabled}>
            Start project
          </button>
        </form>
      </details>
    </section>
  );
}

function Templates() {
  const { state, send, disabled } = useStore();
  // baseRev: the template revision the draft started from; null for a new template.
  const [draft, setDraft] = useState<{ tpl: WorkflowTemplate; baseRev: number | null } | null>(null);
  const editing = draft?.tpl ?? null;
  const setEditing = (tpl: WorkflowTemplate) => setDraft((d) => (d ? { ...d, tpl } : d));
  const templates = state.project.templates;
  const missingBuiltIns = BUILT_IN_TEMPLATES.filter((b) => !templates.some((t) => t.id === b.id));

  if (editing) {
    return (
      <section className="card" aria-labelledby="tpl-h">
        <h2 id="tpl-h">{draft!.baseRev !== null ? `Edit template: ${editing.name}` : "New template"}</h2>
        <PipelineEditor
          initial={editing.steps}
          saveLabel="Save template"
          requireReason={false}
          saveBlocked={disabled ? "The service is offline" : undefined}
          header={
            <>
              <label className="field">
                <span>Name</span>
                <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
              <label className="field">
                <span>When to use it</span>
                <input type="text" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </label>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Templates describe kinds of work, not a specific app. Saving never changes existing task pipelines.
              </p>
            </>
          }
          onSave={async (steps) => {
            // A 409 (someone else saved this template first) keeps the draft open; the notice explains it.
            const r = await send("saveTemplate", { template: { ...editing, steps }, expectedRev: draft!.baseRev });
            if (r.ok) setDraft(null);
          }}
          onCancel={() => setDraft(null)}
        />
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="tpl-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="tpl-h">Workflow templates</h2>
        <button
          className="small"
          onClick={() =>
            setDraft({
              baseRev: null,
              tpl: {
              id: `custom-${Date.now().toString(36)}`,
              name: "",
              description: "",
              builtIn: false,
              rev: 0,
              steps: [{ id: "S1", purpose: "", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }],
              },
            })
          }
        >
          New template
        </button>
      </div>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Starting pipelines for any project goal. A task's pipeline can be replaced from a template while editing it.
      </p>
      {templates.length === 0 && <p className="muted">No templates.</p>}
      <ul className="events">
        {templates.map((t) => (
          <li key={t.id} style={{ gridTemplateColumns: "1fr auto" }}>
            <span>
              <strong>{t.name}</strong> {t.builtIn && <span className="chip">{isModifiedBuiltIn(t) ? "built-in, edited" : "built-in"}</span>}
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {t.description}
              </div>
              <div className="mono muted" style={{ fontSize: "0.78rem" }}>
                {t.steps.map((st) => `${st.id} ${st.purpose}${st.runIf?.length ? " (if findings)" : ""}`).join(" → ")}
              </div>
            </span>
            <span className="row" style={{ alignItems: "flex-start" }}>
              <button className="small" onClick={() => setDraft({ tpl: structuredClone(t), baseRev: t.rev })}>
                Edit
              </button>
              <button className="small" onClick={() => setDraft({ tpl: { ...structuredClone(t), id: `custom-${Date.now().toString(36)}`, name: `${t.name} copy`, builtIn: false, rev: 0 }, baseRev: null })}>
                Duplicate
              </button>
              {isModifiedBuiltIn(t) && (
                <button
                  className="small"
                  disabled={disabled}
                  onClick={() => {
                    const b = BUILT_IN_TEMPLATES.find((x) => x.id === t.id)!;
                    if (confirm(`Reset "${t.name}" to the built-in version?`)) void send("saveTemplate", { template: structuredClone(b), expectedRev: t.rev });
                  }}
                >
                  Reset
                </button>
              )}
              <button
                className="small danger"
                disabled={disabled}
                onClick={() => {
                  if (confirm(`Delete the "${t.name}" template? Task pipelines already created from it are unchanged.`)) void send("deleteTemplate", { templateId: t.id });
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {missingBuiltIns.length > 0 && (
        <button className="small" style={{ marginTop: "0.5rem" }} disabled={disabled} onClick={() => void send("restoreBuiltInTemplates")}>
          Restore {missingBuiltIns.length} deleted built-in template(s)
        </button>
      )}
    </section>
  );
}
