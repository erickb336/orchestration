import { useEffect, useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { AUTOPILOT, PROVIDERS, ROLES, type Autonomy, type WorkflowTemplate } from "../domain/types";
import { BUILT_IN_TEMPLATES, PROJECT_TEMPLATES, isModifiedBuiltIn } from "../domain/templates";
import { DeliverySettings } from "./DeliverySettings";
import { PipelineEditor } from "./PipelineEditor";
import { pipelineSummary } from "./fanout";
import type { CapabilityMap } from "../runtime/adapter";
import { useStore } from "./store";
import { ModelPicker, PREF_INVOLVEMENT_CHOSEN, PREF_NOTIFY, ROLE_LABEL, autonomyArgs, fmtTime, involvementOf, relTime, usePref } from "./common";
import { disableNotifications, enableNotifications, notificationsSupported } from "./notifications";

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
          <Templates />
        </div>

        <div>
          <Providers />
          <DeliverySettings />
          <AutonomyCard />
          <NotificationsCard />
          <DataCard />
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
      <p className="muted" style={{ fontSize: "0.88rem", margin: "0.35rem 0 0.8rem" }}>
        Stepping in is always optional: whatever you choose, you can pause the project or any task, edit a spec, or message the lead at any time.
        {simulated ? " In the sample project every run is simulated." : ""}
      </p>
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
    </section>
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
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.4rem" }}>
        Fine-tune the choice above. When planning is on, the lead may propose up to {n} task{n === 1 ? "" : "s"} per planning run; they run through their pipelines without further prompting unless held. The lead never
        edits existing tasks or your pinned choices.
      </p>
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
          Replaces the board with an empty project for the repository below. Refused while any run is active. The repository must be a git repository with at least one commit. Agents work in separate worktrees and never
          edit its working tree; your branches change only through automatic delivery, when you turn it on (fast-forward only).
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
  const missingBuiltIns = PROJECT_TEMPLATES.filter((b) => !templates.some((t) => t.id === b.id));

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
                {pipelineSummary(t.steps)}
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
