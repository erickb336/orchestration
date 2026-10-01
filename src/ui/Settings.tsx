import { useEffect, useState } from "react";
import { SENT_SUMMARY } from "../domain/telemetry";
import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as M from "../domain/model";
import { AUTOPILOT, PROVIDERS, ROLES, STEERING_MODES, type Autonomy, type SteeringMode } from "../domain/types";
import { effectiveDefault, eligible } from "../domain/patterns";
import type { PatternsReloadResponse } from "../api";
import { PatternPicker, PatternSteps } from "./PatternPicker";
import { EXAMPLE_VARIANT, catalogSummary, defaultPatternNote, errorLocation, patternFlagChips, retiredTemplateJson, shortHash, sourceLabel } from "./patternView";
import { ChecksSettings } from "./ChecksSettings";
import { DeliverySettings } from "./DeliverySettings";
import type { CapabilityMap } from "../runtime/adapter";
import { useStore } from "./store";
import { ModelPicker, PREF_INVOLVEMENT_CHOSEN, PREF_NOTIFY, ROLE_LABEL, autonomyArgs, fmtTime, involvementOf, relTime, usePref } from "./common";
import { disableNotifications, enableNotifications, notificationsSupported } from "./notifications";
import { StageControl } from "./Shaping";
import { initProjectConfirm, newProjectStage } from "./stageChoice";
import { confirmedFor, LANGFUSE_ENDPOINT, PHOENIX_ENDPOINT, backfillCount, endpointProblem, hostOf, needsRemoteConfirm, statusLine } from "./telemetryView";

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
      <InvolvementCard />
      <div className="grid-2">
        <div>
          <section className="card" aria-labelledby="proj-h">
            <h2 id="proj-h">Project</h2>
            <StageControl />
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
                <input type="number" min={1} max={16} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: "5rem" }} />
                <button disabled={disabled || Number(limit) === p.workerLimit} onClick={() => void send("setWorkerLimit", { limit: Number(limit) })}>
                  Save
                </button>
              </div>
            </label>
            <ProviderLimits />
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
          <Patterns />
        </div>

        <div>
          <Providers />
          <ChecksSettings />
          <DeliverySettings />
          <SteeringCard />
          <AutonomyCard />
          <NotificationsCard />
          <DataCard />
          <TracesCard />
          <RunLimitsCard />
          {service.runtime === "real" && <ProjectSetup />}
        </div>
      </div>
    </>
  );
}

/** Concurrent runs per provider; each is also bounded by the total worker limit. */
function ProviderLimits() {
  const { state, send, disabled } = useStore();
  const p = state.project;
  const current = (pr: (typeof PROVIDERS)[number]) => p.providerLimits?.[pr] ?? p.workerLimit;
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(PROVIDERS.map((pr) => [pr, String(current(pr))])));
  const key = PROVIDERS.map((pr) => current(pr)).join(",");
  // Follow the live values when they change elsewhere.
  useEffect(() => setDraft(Object.fromEntries(PROVIDERS.map((pr) => [pr, String(current(pr))]))), [key]);
  return (
    <div className="field">
      <span>Concurrent runs per provider</span>
      <div className="row" style={{ gap: "1rem" }}>
        {PROVIDERS.map((pr) => {
          const v = draft[pr] ?? "";
          const n = Number(v);
          const valid = v.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 16;
          return (
            <label key={pr} className="row" style={{ gap: "0.35rem" }}>
              <span style={{ fontSize: "0.85rem" }}>{M.providerLabel(pr)}</span>
              <input
                type="number"
                min={0}
                max={16}
                step={1}
                value={v}
                aria-label={`${M.providerLabel(pr)} concurrent runs`}
                onChange={(e) => setDraft((d) => ({ ...d, [pr]: e.target.value }))}
                style={{ width: "4.5rem" }}
              />
              <button className="small" disabled={disabled || !valid || n === current(pr)} onClick={() => void send("setProviderLimit", { provider: pr, limit: n })}>
                Save
              </button>
            </label>
          );
        })}
      </div>
      <span className="muted" style={{ display: "block", fontSize: "0.8rem", fontWeight: 400, marginTop: "0.25rem" }}>
        Raise these to keep both providers busy on large goals. Each is also capped by the total worker limit ({p.workerLimit}); 0 stops new runs on that provider.
      </span>
    </div>
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
        const tone = h?.status === "ready" ? "done" : h?.status === "not-configured" ? "attention" : "blocked";
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

/** The three ways to work with the team, from fully autonomous to fully on request. */
function InvolvementCard() {
  const { state, service, send, disabled } = useStore();
  const a = state.project.autonomy;
  const prMode = state.project.prDelivery.enabled;
  const mode = involvementOf(a, prMode);
  const [, setChosen] = usePref(PREF_INVOLVEMENT_CHOSEN);
  const defaultBranch = a.autoDeliver.enabled ? a.autoDeliver.branch : (service.repo?.branch ?? "main");
  const [branch, setBranch] = useState(defaultBranch);
  useEffect(() => setBranch(defaultBranch), [defaultBranch]);
  const simulated = service.runtime !== "real";

  const choose = async (args: object, name: "setAutonomy" | "applyAutopilot" = "setAutonomy") => {
    const r = await send(name, args);
    if (r.ok) setChosen("1");
  };
  const current = (m: typeof mode) =>
    mode === m ? (
      <span className="pill done" aria-label="current choice">
        Current
      </span>
    ) : null;

  return (
    <section className="card involvement" aria-labelledby="inv-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="inv-h" style={{ margin: 0 }}>
          How much should you be involved?
        </h2>
        {mode === "custom" && <span className="chip strong">Custom settings (see Advanced below)</span>}
      </div>
      <p className="muted meta" style={{ margin: "0.35rem 0 0.3rem" }}>
        Stepping in is always optional.
      </p>
      <details className="how" style={{ marginBottom: "0.8rem" }}>
        <summary>How this works</summary>
        <p>
          Whatever you choose, you can pause the project or any task, edit a spec, or message the lead at any time.
          {simulated ? " In the sample project every run is simulated." : ""}
        </p>
      </details>
      <div className="choices">
        <div className={`choice primary-choice${mode === "autopilot" ? " current" : ""}`}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Autopilot: runs end to end without you</h3>
            {current("autopilot")}
          </div>
          <ul className="plain choice-list">
            <li>
              The lead plans on its own every {AUTOPILOT.planningIntervalMinutes} minutes: up to {AUTOPILOT.maxProposalsPerCycle} new tasks per run, at most {AUTOPILOT.maxOpenProposals} open at once.
            </li>
            <li>Tasks the lead proposes start right away; nothing waits for your approval.</li>
            <li>A failed step is retried once automatically before it waits for you.</li>
            {prMode ? (
              <li>
                Verified work is opened as a GitHub pull request and {state.project.prDelivery.merge === "auto" ? "merged automatically after an independent review and passing required checks, as you chose in Delivery" : "held for you to merge"}. Autopilot itself never
                turns on publishing or automatic merging and does not change the <a href="#delivery">delivery mode</a>.
              </li>
            ) : (
              <li>
                Verified work is delivered to <strong className="mono">{branch || "your branch"}</strong>, only as a fast-forward and only when your working tree is clean. Otherwise it waits and the task says why.
              </li>
            )}
          </ul>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void choose({ branch: branch.trim() }, "applyAutopilot");
            }}
          >
            {!prMode && (
              <label className="row" style={{ gap: "0.35rem" }}>
                <span style={{ fontSize: "0.85rem" }}>Deliver to branch</span>
                <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} required aria-label="Branch to deliver verified work to" style={{ width: "10rem" }} />
              </label>
            )}
            <button type="submit" className="primary" disabled={disabled || !branch.trim() || (mode === "autopilot" && (prMode || branch.trim() === a.autoDeliver.branch))}>
              {mode === "autopilot" ? "Update autopilot" : "Turn on autopilot"}
            </button>
          </form>
        </div>

        <div className={`choice${mode === "checkin" ? " current" : ""}`}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Check in before work starts</h3>
            {current("checkin")}
          </div>
          <p className="muted choice-text">The lead plans on its own, but each task it proposes (and each child task a breakdown creates) waits for you to release it. Everything after that runs by itself.</p>
          <button disabled={disabled || mode === "checkin"} onClick={() => void choose(autonomyArgs(a, { enabled: true, holdLeadProposals: true }))}>
            Use check-in
          </button>
        </div>

        <div className={`choice${mode === "manual" ? " current" : ""}`}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Only when I ask</h3>
            {current("manual")}
          </div>
          <p className="muted choice-text">The lead answers your messages and runs the tasks you create or release. It does not plan new work on its own, and child tasks from breakdowns wait for you to start them.</p>
          <button disabled={disabled || mode === "manual"} onClick={() => void choose(autonomyArgs(a, { enabled: false }))}>
            Use manual
          </button>
        </div>
      </div>
      <TriageRouting />
    </section>
  );
}

/** ORC-013: who decides review findings whose fix would widen a task. Autopilot sets the lead; the user can change it. */
function TriageRouting() {
  const { state, send, disabled } = useStore();
  const to = state.project.triage?.askUserBy ?? "user";
  const open = F.openDecisions(state, "lead").length + F.openDecisions(state, "user").length;
  return (
    <div style={{ marginTop: "0.8rem", fontSize: "0.9rem" }}>
      <label className="row" style={{ gap: "0.4rem" }}>
        <span>Findings that need a decision go to:</span>
        <select aria-label="Who decides findings that need a decision" value={to} disabled={disabled} onChange={(e) => void send("setTriageRouting", { askUserBy: e.target.value })}>
          <option value="lead">the lead</option>
          <option value="user">me</option>
        </select>
      </label>
      <p className="muted" style={{ fontSize: "0.82rem", margin: "0.25rem 0 0" }}>
        A reviewer marks a finding "ask-user" when the smallest honest fix would widen the task or questions what was asked. The repair loop fixes only what is decided. Autopilot sets the lead; a lead "fix" on a spec you wrote comes back to you as a suggestion.
        {open ? ` Open decisions (${open}) stay where they are; move one from its task page.` : ""}
      </p>
    </div>
  );
}

const STEERING_CHOICES: Record<SteeringMode, { label: string; detail: string }> = {
  apply: { label: "Apply changes; undo any of them", detail: "The lead changes the focus, reorders and defers work, and drops its own unstarted proposals. Every change is listed under its reply with Undo." },
  "apply-own": { label: "Apply to the lead's own proposals; suggest for my tasks", detail: "Tasks you created only get suggestions, with Apply and Dismiss. The lead's own proposals change right away." },
  suggest: { label: "Only suggest", detail: "Nothing changes until you press Apply on a suggestion." },
};

/** ORC-009: how far the lead may go when the user gives direction in the conversation. Separate from Autonomy. */
function SteeringCard() {
  const { state, send, disabled } = useStore();
  const mode = state.project.steeringMode;
  return (
    <section className="card" aria-labelledby="steer-h">
      <h2 id="steer-h">When you steer the lead in conversation</h2>
      <p className="muted small" style={{ marginBottom: "0.3rem" }}>
        Whatever you choose: priorities and pauses you set by hand are never overridden (the lead's change becomes a suggestion), the lead never pauses, stops or resumes running work, and it never edits specs, pipelines, pins,
        delivery or settings.
      </p>
      <details className="how">
        <summary>How this works</summary>
        <p>The current choice is shown on the composer.</p>
      </details>
      <fieldset className="plain-fieldset" disabled={disabled}>
        {STEERING_MODES.map((m) => (
          <label key={m} className="choice-radio">
            <input type="radio" name="steering-mode" checked={mode === m} onChange={() => void send("setSteeringMode", { mode: m })} />
            <span>
              <strong>{STEERING_CHOICES[m].label}</strong>
              <span className="choice-desc">{STEERING_CHOICES[m].detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function AutonomyCard() {
  const { state, send, disabled } = useStore();
  const a = state.project.autonomy;
  const lastPlanning = state.project.lastPlanningAt;
  const openProposals = M.openLeadProposals(state).length;
  const deferredProposals = M.deferredLeadRoots(state).length;
  const [enabled, setEnabled] = useState(a.enabled);
  const [interval, setIntervalMinutes] = useState(String(a.planningIntervalMinutes));
  const [perCycle, setPerCycle] = useState(String(a.maxProposalsPerCycle));
  const [maxOpen, setMaxOpen] = useState(String(a.maxOpenProposals));
  const [hold, setHold] = useState(a.holdLeadProposals);
  const [limitHours, setLimitHours] = useState(a.operatingHours !== null);
  const [start, setStart] = useState(a.operatingHours?.start ?? "09:00");
  const [end, setEnd] = useState(a.operatingHours?.end ?? "18:00");
  const [retries, setRetries] = useState(String(a.autoRetry));
  // Follow the live values when they change elsewhere (another tab, the service, the choices above).
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
    setRetries(String(a.autoRetry));
  }, [a.enabled, a.planningIntervalMinutes, a.maxProposalsPerCycle, a.maxOpenProposals, a.holdLeadProposals, hoursKey, a.autoRetry]);

  const hours = limitHours ? { start, end } : null;
  const changed =
    enabled !== a.enabled ||
    Number(interval) !== a.planningIntervalMinutes ||
    Number(perCycle) !== a.maxProposalsPerCycle ||
    Number(maxOpen) !== a.maxOpenProposals ||
    hold !== a.holdLeadProposals ||
    (hours ? `${hours.start}-${hours.end}` : "") !== hoursKey ||
    Number(retries) !== a.autoRetry;
  const deliveryMode = D.deliveryMode(state);
  const n = Number(perCycle) > 0 ? Number(perCycle) : a.maxProposalsPerCycle;
  return (
    <section className="card" aria-labelledby="autonomy-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="autonomy-h" style={{ margin: 0 }}>
          Advanced: autonomy
        </h2>
        <span className={a.enabled ? "pill running" : "chip"}>{a.enabled ? "Lead planning on" : "Lead planning off"}</span>
      </div>
      <p className="muted small" style={{ marginTop: "0.4rem", marginBottom: "0.3rem" }}>
        Fine-tune the choice above.
      </p>
      <details className="how">
        <summary>How this works</summary>
        <p>
          When planning is on, the lead may propose up to {n} task{n === 1 ? "" : "s"} per planning run; they run through their pipelines without further prompting unless held. The lead never edits specs or your pinned choices. When
          you give direction in the conversation, it may change the focus, reorder and defer work, and drop its own unstarted proposals; every change is listed with Undo.
        </p>
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const next: Autonomy = {
            enabled,
            planningIntervalMinutes: Number(interval),
            maxProposalsPerCycle: Number(perCycle),
            maxOpenProposals: Number(maxOpen),
            holdLeadProposals: hold,
            operatingHours: hours,
            autoRetry: Number(retries),
            // The delivery mode has its own card; saving autonomy leaves it as it is.
            autoDeliver: a.autoDeliver,
          };
          void send("setAutonomy", next);
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
          <label className="field">
            <span>Automatic retries of a failed step</span>
            <span className="row" style={{ gap: "0.4rem", fontWeight: 400, fontSize: "0.9rem" }}>
              <input type="number" min={0} max={5} value={retries} onChange={(e) => setRetries(e.target.value)} style={{ width: "5rem" }} aria-label="Automatic retries of a failed step" />
              <span className="muted">0 means a failed step always waits for you (up to 5).</span>
            </span>
          </label>
          <div className="field">
            <span style={{ fontWeight: 400 }}>
              Delivery: <strong>{deliveryMode === "local" ? `local branch ${a.autoDeliver.branch}` : deliveryMode === "pr" ? (state.project.prDelivery.merge === "auto" ? "GitHub pull requests, merged automatically after review and checks" : "GitHub pull requests, held for you") : "off"}</strong>. <a href="#delivery">Change it in Delivery</a>.
            </span>
          </div>
          <button type="submit" disabled={!changed}>
            Save autonomy
          </button>
        </fieldset>
      </form>
      <p className="muted" style={{ fontSize: "0.82rem", margin: "0.6rem 0 0" }}>
        Open lead proposals: {openProposals} of {a.maxOpenProposals}
        {deferredProposals ? `; deferred lead proposals: ${deferredProposals} of at most ${a.maxOpenProposals} (they do not count as open, but planning stops when they reach the cap)` : ""}. Planning waits while the
        project is paused.{" "}
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

/** Opt-in, per-browser notifications while a page of this app is open. */
function NotificationsCard() {
  const [pref] = usePref(PREF_NOTIFY);
  const [message, setMessage] = useState<string | null>(null);
  const supported = notificationsSupported();
  const permission = supported ? Notification.permission : "denied";
  const on = pref === "1" && permission === "granted";
  return (
    <section className="card" aria-labelledby="notify-h">
      <h2 id="notify-h">Notifications</h2>
      <label className="row" style={{ gap: "0.4rem" }}>
        <input
          type="checkbox"
          checked={on}
          disabled={!supported}
          onChange={async (e) => {
            setMessage(null);
            if (!e.target.checked) return disableNotifications();
            const r = await enableNotifications();
            if (r === "denied") setMessage("Notifications are blocked for this site. Allow them in your browser's site settings, then turn this on again.");
            else if (r !== "granted") setMessage("Notifications were not allowed.");
          }}
        />
        <strong>Notify me in this browser</strong>
      </label>
      <p className="muted" style={{ fontSize: "0.85rem", margin: "0.4rem 0 0" }}>
        {supported
          ? "While a page of this app is open, you get one notification per event: a task done, work delivered, a pull request that is ready for you or needs you, a pull request merged or closed on GitHub, GitHub sign-in needed, a step that needs you or a run that failed, a control failure, an integration conflict, and lead replies. Clicking one opens the task. Notifications appear only while an Orchestrator page is open, and deliveries and merges happen only while the service is running. GitHub is not expected to notify you about pull requests opened with your own account, so the Review badge keeps the count."
          : "This browser does not support notifications."}
      </p>
      {message && (
        <div className="banner" role="status" style={{ margin: "0.5rem 0 0" }}>
          {message}
        </div>
      )}
    </section>
  );
}

/** Export, import, and workspace cleanup. */
function DataCard() {
  const { service, send, disabled, postJson } = useStore();
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<{ imported: string[]; skipped: string[] } | null>(null);
  const [pruned, setPruned] = useState<number | null>(null);
  const [pruning, setPruning] = useState(false);
  const real = service.runtime === "real";
  return (
    <section className="card" aria-labelledby="data-h">
      <h2 id="data-h">Data</h2>

      <h3>Export</h3>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        The whole board as a Markdown file: every task with its state, chosen approach, and delivery status.
      </p>
      <a className="button-link" href="/api/export.md" download="orchestration-board.md">
        Download board (Markdown)
      </a>

      <h3 style={{ marginTop: "1.1rem" }}>Import</h3>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Paste a Markdown task table with an ID column and a Title (or Task/Outcome) column. IDs are kept; tasks that already exist are skipped. Finished rows arrive as done tasks marked "legacy spec unavailable".
        Open rows wait until you (or the lead) write a spec with Edit spec; they never run before that.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await send("importMarkdown", { markdown });
          setBusy(false);
          if (r.ok) {
            const res = r.result as { imported?: string[]; skipped?: string[] } | undefined;
            setImported({ imported: res?.imported ?? [], skipped: res?.skipped ?? [] });
            setMarkdown("");
          }
        }}
      >
        <label className="field">
          <span className="sr-only">Markdown task table</span>
          <textarea value={markdown} onChange={(e) => setMarkdown(e.target.value)} placeholder="| ID | Title | Status |&#10;| --- | --- | --- |&#10;| T-1 | Example task | Done |" rows={5} />
        </label>
        <button type="submit" disabled={disabled || busy || !markdown.trim()}>
          {busy ? "Importing…" : "Import"}
        </button>
      </form>
      {imported && (
        <p role="status" style={{ fontSize: "0.9rem", margin: "0.5rem 0 0" }}>
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
          {imported.skipped.length > 0 && <span className="muted"> (already on the board: {imported.skipped.join(", ")})</span>}
        </p>
      )}

      <h3 style={{ marginTop: "1.1rem" }}>Cleanup</h3>
      {real ? (
        <>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Removes the workspaces (git worktrees) of runs that have finished. Active runs are never touched, and branches are kept, so every recorded change stays reachable.
          </p>
          <div className="row">
            <button
              disabled={disabled || pruning}
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
            </button>
            {pruned !== null && (
              <span role="status">
                Removed {pruned} workspace{pruned === 1 ? "" : "s"}.
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
          Available when real agents run (the sample project has no workspaces).
        </p>
      )}
    </section>
  );
}

/**
 * ORC-018 §5.4: the opt-in trace export. Off by default; what can leave the computer is listed beside the
 * switch, and a host other than loopback needs the confirmation before Save. Credentials never live here.
 */
function TracesCard() {
  const { state, service, send, disabled, postJson } = useStore();
  const cfg = state.project.telemetry;
  const status = service.telemetry;
  const [enabled, setEnabled] = useState(cfg?.enabled ?? false);
  const [endpoint, setEndpoint] = useState(cfg?.endpoint ?? "");
  // The confirmation belongs to the host it was given for (review M3): another host needs it again.
  const savedConfirmedHost = cfg?.allowRemote ? hostOf(cfg.endpoint) : undefined;
  const [confirmedHost, setConfirmedHost] = useState<string | undefined>(savedConfirmedHost);
  const [busy, setBusy] = useState<"backfill" | "retry" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Follow the live values when they change elsewhere (another tab, the service).
  const key = `${cfg?.enabled ?? false}|${cfg?.endpoint ?? ""}|${cfg?.allowRemote ?? false}|${cfg?.rev ?? 0}`;
  useEffect(() => {
    setEnabled(cfg?.enabled ?? false);
    setEndpoint(cfg?.endpoint ?? "");
    setConfirmedHost(cfg?.allowRemote ? hostOf(cfg.endpoint) : undefined);
  }, [key]);
  const host = hostOf(endpoint);
  const allowRemote = confirmedFor(confirmedHost, endpoint);
  const remote = needsRemoteConfirm(endpoint);
  const problem = endpointProblem(endpoint);
  const next = { enabled, endpoint: endpoint.trim(), allowRemote: remote && allowRemote };
  const changed = next.enabled !== (cfg?.enabled ?? false) || next.endpoint !== (cfg?.endpoint ?? "") || next.allowRemote !== (cfg?.allowRemote ?? false);
  const canSave = changed && !problem && (!remote || allowRemote);
  const pending = backfillCount(state.tasks, status);
  const run = async (what: "backfill" | "retry") => {
    setBusy(what);
    setNote(null);
    const r = await postJson(`/api/telemetry/${what}`, {});
    setBusy(null);
    if (!r.ok) return;
    const queued = (r.body as { queued?: unknown } | null)?.queued;
    setNote(typeof queued === "number" ? `${queued} task${queued === 1 ? "" : "s"} queued.` : what === "backfill" ? "Queued." : "Failed exports queued again.");
  };
  return (
    <section className="card" id="telemetry" aria-labelledby="telemetry-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="telemetry-h" style={{ margin: 0 }}>
          Traces
        </h2>
        <span className={cfg?.enabled ? "chip strong" : "chip"}>{cfg?.enabled ? "On" : "Off"}</span>
      </div>
      <p className="muted small" style={{ margin: "0.4rem 0 0.6rem" }}>
        Send each finished task as an OpenTelemetry trace to a viewer you run, such as Phoenix or Langfuse. Off by default.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSave) return;
          void send("setTelemetry", { config: next, expectedRev: cfg?.rev ?? 0 });
        }}
      >
        <fieldset className="plain-fieldset" disabled={disabled}>
          <label className="row field" style={{ gap: "0.4rem" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <strong>Send traces</strong>
          </label>
          <label className="field" style={{ marginBottom: "0.4rem" }}>
            <span>Endpoint (OTLP/HTTP traces)</span>
            <input type="text" value={endpoint} placeholder={PHOENIX_ENDPOINT} spellCheck={false} autoComplete="off" onChange={(e) => setEndpoint(e.target.value)} aria-describedby="telemetry-examples" />
          </label>
          <div className="row traces-examples" id="telemetry-examples">
            <span className="muted small">Examples:</span>
            <button type="button" className="small" onClick={() => setEndpoint(PHOENIX_ENDPOINT)}>
              Phoenix (local)
            </button>
            <button type="button" className="small" onClick={() => setEndpoint(LANGFUSE_ENDPOINT)}>
              Langfuse (local)
            </button>
          </div>
          {problem && changed && (
            <p className="small" role="status" style={{ color: "var(--st-fail)", margin: "0 0 0.6rem" }}>
              {problem}
            </p>
          )}
          {remote && (
            <label className="row field traces-remote" style={{ gap: "0.4rem" }}>
              <input type="checkbox" checked={allowRemote} onChange={(e) => setConfirmedHost(e.target.checked ? host : undefined)} />
              <span>
                Send to <strong>{host}</strong>: {SENT_SUMMARY} leave this computer.
              </span>
            </label>
          )}
          <button type="submit" disabled={!canSave} title={changed && remote && !allowRemote ? "Confirm what leaves this computer first" : undefined}>
            Save
          </button>
        </fieldset>
      </form>

      <h3 style={{ marginTop: "1rem" }}>What is sent</h3>
      <ul className="plain muted small traces-list">
        <li>One trace per task when it finishes or is cancelled: a task span with the id, title, area, result, the pattern (id, name, version, source) and the outcome numbers.</li>
        <li>One span per agent run: provider, model, role, the provider&apos;s session id, start and end, token counts and cost where the provider reported them.</li>
        <li>One span per check run: start and end, and whether it passed.</li>
        <li>Never prompts, outputs, code, paths or credentials.</li>
      </ul>
      <p className="muted small">
        Headers (for example a viewer&apos;s key) come only from <code>OTEL_EXPORTER_OTLP_HEADERS</code> (or <code>OTEL_EXPORTER_OTLP_TRACES_HEADERS</code>) in the shell that starts Orchestrator; they are never stored here. Set in that shell now:{" "}
        <strong>{status ? (status.headersFromEnv ? "yes" : "no") : "not reported yet"}</strong>.
      </p>

      <h3>Status</h3>
      <p className="small num" role="status" style={{ margin: "0 0 0.3rem" }}>
        {statusLine(status, status?.lastSentAt ? relTime(status.lastSentAt) : undefined)}
      </p>
      {status?.lastError && (
        <p className="small" style={{ margin: "0 0 0.5rem" }}>
          <span style={{ color: "var(--st-fail)", fontWeight: 560 }}>Last error:</span> {status.lastError}
        </p>
      )}
      <div className="row">
        <button
          disabled={disabled || busy !== null || !cfg?.enabled || pending === 0}
          title={!cfg?.enabled ? "Turn on Send traces and save first" : pending === 0 ? "Every finished task with an outcome has been sent or queued" : "Queue every finished task with an outcome that was not sent yet, once"}
          onClick={() => void run("backfill")}
        >
          {busy === "backfill" ? "Queueing…" : `Send finished tasks (${pending})`}
        </button>
        {(status?.failed ?? 0) > 0 && (
          <button disabled={disabled || busy !== null} onClick={() => void run("retry")} title="Queue the failed exports again">
            {busy === "retry" ? "Queueing…" : "Retry failed"}
          </button>
        )}
        {note && (
          <span role="status" className="small">
            {note}
          </span>
        )}
      </div>
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
  // ORC-012: shape the vision with the lead first (the vision may stay empty), or start building now.
  // ORC-014 review 10: until you choose, the stage follows the vision: shaping while it is empty, building once written.
  const [stageChoice, setStageChoice] = useState<"shaping" | "building" | null>(null);
  const stage = newProjectStage(stageChoice, vision);
  const docCount = M.currentVisionDocs(state).length;
  const repoOk = service.repo?.ok;
  return (
    <section className="card" aria-labelledby="setup-h">
      <h2 id="setup-h">Project</h2>
      <p style={{ fontSize: "0.9rem" }}>
        Repository: <span className="mono">{state.project.repoPath}</span>{" "}
        {repoOk ? <span className="pill done">Ready{service.repo?.branch ? ` (${service.repo.branch})` : ""}</span> : <span className="pill blocked">Not usable</span>}
      </p>
      {!repoOk && service.repo?.reason && <div className="banner danger">{service.repo.reason}</div>}
      <label className="row" style={{ gap: "0.4rem", fontSize: "0.9rem", alignItems: "flex-start" }}>
        <input type="checkbox" checked={state.project.conventions?.include ?? true} disabled={disabled} onChange={(e) => void send("setConventions", { include: e.target.checked })} style={{ marginTop: "0.25rem" }} />
        <span>
          Give every run the repository's AGENTS.md and CLAUDE.md as project conventions
          <span className="muted" style={{ display: "block", fontSize: "0.82rem" }}>
            Read from the trusted base (the fetched remote base, the delivery branch, or HEAD), never from a worktree agents write, and labelled so they never change a run's role. No worker loads them by itself: Claude runs without project settings, and Codex is
            started with <span className="mono">project_doc_max_bytes=0</span> (present in the pinned binary; that it suppresses AGENTS.md is not verified yet).
          </span>
        </span>
      </label>
      <details open={!repoOk}>
        <summary>Start a new project</summary>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Replaces the board with an empty project for the repository below; vision documents attached to the current project are removed with it. Refused while any run is active. The repository must be a git repository with at least one commit. Agents work in separate worktrees and never
          edit its working tree; your branches change only through automatic delivery, when you turn it on (fast-forward only).
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!confirm(initProjectConfirm(name, docCount))) return;
            await send("initProject", { name, repoPath: repo, vision, focus, stage });
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
          <fieldset className="plain-fieldset field">
            <legend className="field-legend" style={{ fontSize: "0.85rem", fontWeight: 560, marginBottom: "0.2rem" }}>
              How to begin
            </legend>
            <label className="choice-radio">
              <input type="radio" name="new-stage" checked={stage === "shaping"} onChange={() => setStageChoice("shaping")} />
              <span>
                <strong>Shape the vision with the lead first</strong>
                <span className="choice-desc">Talk it through; the lead drafts the vision and a first roadmap. Nothing runs until you start building. The vision below may stay empty.</span>
              </span>
            </label>
            <label className="choice-radio" style={{ marginBottom: 0 }}>
              <input type="radio" name="new-stage" checked={stage === "building"} onChange={() => setStageChoice("building")} />
              <span>
                <strong>Start building now</strong>
                <span className="choice-desc">Work runs as soon as there is a task. The vision is required.</span>
              </span>
            </label>
          </fieldset>
          <label className="field">
            <span>Vision{stage === "shaping" ? " (optional while shaping)" : ""}</span>
            <textarea value={vision} onChange={(e) => setVision(e.target.value)} required={stage === "building"} />
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

/**
 * ORC-016: the pattern catalog, read-only. Built-in patterns change through commits; a file of yours in
 * the patterns directory is picked up by Reload. The project default is the one setting here.
 */
function Patterns() {
  const { state, send, disabled, postJson } = useStore();
  const [reloading, setReloading] = useState(false);
  const [last, setLast] = useState<PatternsReloadResponse | null>(null);
  const catalog = state.patterns;
  const stored = state.project.defaultPatternId;
  const effective = effectiveDefault(state);
  const standard = catalog.patterns.filter((p) => eligible(p, "default"));
  const note = defaultPatternNote(stored, standard, effective);
  const retired = state.retiredTemplates;
  const localDir = catalog.localDir || "the patterns directory";
  return (
    <section className="card" aria-labelledby="pat-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="pat-h">Patterns</h2>
        <button
          className="small"
          disabled={disabled || reloading}
          title="Read the pattern files again. Tasks that already exist keep their steps."
          onClick={async () => {
            setReloading(true);
            const r = await postJson("/api/patterns/reload", {});
            setReloading(false);
            if (r.ok) setLast(r.body as PatternsReloadResponse);
          }}
        >
          {reloading ? "Reloading…" : "Reload patterns"}
        </button>
      </div>
      <p className="muted small" style={{ marginBottom: "0.3rem" }}>
        Every task runs one pattern from this catalog, chosen when the task is created or changed on the task page.
      </p>
      <details className="how">
        <summary>How this works</summary>
        <p>
          Nothing here edits a pattern: built-in ones live in the repository's <code>patterns/</code> directory and change through commits; yours live in <code>{localDir}</code> and are read at start and on Reload.
        </p>
        <p>Only standard patterns can be the default: experiments, patterns that pause for you and patterns without an independent review are yours to choose per task.</p>
      </details>
      <p className="muted small" role="status">
        {catalogSummary(catalog)}
        {catalog.loadedAt ? `, loaded ${relTime(catalog.loadedAt)}` : ""}.{last ? ` Last reload: ${last.patterns} patterns, ${last.errors} file error${last.errors === 1 ? "" : "s"}.` : ""}
      </p>

      <h3>Default pattern</h3>
      <p className="muted small">Used by the lead's proposals and by breakdowns when they name none, and preselected in New task.</p>
      <PatternPicker state={state} patterns={standard} value={standard.some((p) => p.id === stored) ? stored : effective.id} label="Default pattern" disabled={disabled} onChange={(id) => void send("setDefaultPattern", { patternId: id })} />
      {note && (
        <p className="muted" style={{ fontSize: "0.85rem" }} role="status">
          {note}
        </p>
      )}

      {catalog.errors.length > 0 && (
        <div className="banner danger" role="alert">
          <strong>
            {catalog.errors.length} pattern file error{catalog.errors.length === 1 ? "" : "s"}
          </strong>
          <ul className="plain" style={{ margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
            {catalog.errors.map((e, i) => (
              <li key={i}>
                <span className="mono">{errorLocation(e)}</span>
                {e.id ? ` (${e.id})` : ""}: {e.message}{" "}
                <span className="chip" title={e.effect === "built-in kept" ? "This file would replace a built-in pattern; the built-in stays in effect" : "The file is not in the catalog"}>
                  {e.effect}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: "0.8rem", margin: "0.3rem 0 0" }}>
            Fix the file and choose Reload. The app started anyway; a broken file never blocks it.
          </p>
        </div>
      )}

      <h3>Catalog ({catalog.patterns.length})</h3>
      <ul className="pattern-list">
        {catalog.patterns.map((p) => (
          <li key={p.id}>
            <div className="row" style={{ gap: "0.3rem" }}>
              <strong>{p.name}</strong>
              <span className="chip" title={`Loaded from ${p.file}`}>
                {sourceLabel(p.source, p.replacesBuiltIn)}
              </span>
              <span className="chip" title={p.audience !== "standard" ? "Only you can choose it" : p.flags.breaksDown ? "The lead may choose it; breakdowns may not, because it breaks down itself" : "The lead and breakdowns may choose it"}>
                {p.audience}
              </span>
              {patternFlagChips(p)
                .filter((c) => !c.text.startsWith("yours"))
                .map((c) => (
                  <span key={c.text} className="chip" title={c.title}>
                    {c.text}
                  </span>
                ))}
            </div>
            <div style={{ fontSize: "0.86rem", marginTop: "0.15rem" }}>{p.description}</div>
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              <strong>Use when:</strong> {p.whenToUse}
            </div>
            {p.experimental && p.hypothesis && (
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                <strong>Hypothesis:</strong> {p.hypothesis}
              </div>
            )}
            {p.warnings.length > 0 && (
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                Warnings: {p.warnings.join("; ")}
              </div>
            )}
            <div className="mono muted" style={{ fontSize: "0.78rem", overflowWrap: "anywhere" }} title={`Content hash ${p.hash}`}>
              {p.file} · {p.id} · {shortHash(p.hash)}
              {p.chain.length > 1 ? ` · extends ${p.chain.slice(1).map((c) => c.id).join(" → ")}` : ""}
            </div>
            <details>
              <summary className="muted" style={{ fontSize: "0.8rem", cursor: "pointer" }}>
                {p.steps.length} steps
              </summary>
              <PatternSteps steps={p.steps} />
            </details>
          </li>
        ))}
      </ul>

      {retired.length > 0 && (
        <details style={{ marginTop: "0.6rem" }}>
          <summary>Templates from before patterns ({retired.length})</summary>
          <p className="muted" style={{ fontSize: "0.85rem", margin: "0.3rem 0" }}>
            Custom and edited templates were retired when pipelines became patterns. Each is written once as a pattern file of yours when the service starts; no file is ever overwritten.
          </p>
          <ul className="plain">
            {retired.map((t) => (
              <li key={t.id} style={{ fontSize: "0.85rem" }}>
                <strong>{t.name}</strong> ({t.kind === "custom" ? "custom" : "edited built-in"}):{" "}
                {t.exportedTo ? (
                  <>
                    saved as <code>{t.exportedTo}</code>
                    {t.stripped?.length ? ` (left out: ${t.stripped.join("; ")})` : ""}
                  </>
                ) : t.exportError ? (
                  <>
                    <span style={{ color: "var(--s-blocked)" }}>{t.exportError}</span>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      The file it would have been, to copy into <code>{localDir}</code> yourself:
                    </div>
                    <pre className="pattern-json" tabIndex={0} aria-label={`Pattern file for ${t.name}`}>
                      {retiredTemplateJson(t)}
                    </pre>
                  </>
                ) : (
                  "saved as a pattern file at the next start"
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details style={{ marginTop: "0.6rem" }}>
        <summary>How patterns work</summary>
        <ul className="plain" style={{ fontSize: "0.85rem", margin: "0.3rem 0" }}>
          <li>
            Two folders: <code>patterns/</code> in the repository holds the built-in patterns, and <code>{localDir}</code> holds yours. Built-in patterns change through commits and pull requests. To add one of yours, drop a{" "}
            <code>.json</code> or <code>.jsonc</code> file there and choose Reload; a file with a built-in's id replaces that built-in.
          </li>
          <li>Each file is checked against the schema, then the pipeline graph rules, then the pattern rules. A file with an error is listed above and skipped; when it would replace a built-in, the built-in stays.</li>
          <li>
            A variant can be two lines: <code>extends</code> another pattern and <code>stepOverrides</code> fields of its existing steps. This one pauses Bug fix after the reproduction:
          </li>
        </ul>
        <pre className="pattern-json" tabIndex={0} aria-label="Example pattern file">
          {EXAMPLE_VARIANT}
        </pre>
        <ul className="plain" style={{ fontSize: "0.85rem", margin: "0.3rem 0" }}>
          <li>
            A pattern marked <code>experimental</code> must state its <code>hypothesis</code>. Experiments, patterns that pause for you and patterns without an independent review are yours to choose; the lead and breakdowns use
            standard patterns only.
          </li>
          <li>Every task records the pattern it ran: its id, its content hash and its source. A task created before a file changed keeps its steps and its hash.</li>
          <li>
            The README section "Adding or changing a pipeline pattern" has the field reference and the validation rules.
          </li>
        </ul>
      </details>
    </section>
  );
}
