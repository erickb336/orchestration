import { useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { diffLines } from "../domain/diff";
import { useStore } from "./store";
import { ROLE_LABEL, fmtTime, involvementOf, relTime, selectionText } from "./common";
import { PrChip } from "./Delivery";
import { Conversation } from "./Conversation";
import { Onboarding } from "./Onboarding";
import { PROVIDERS, type Attempt, type ProviderId, type State, type VisionRevision } from "../domain/types";

/** Who made a vision revision and from what, in a few words. */
function revisionSource(v: VisionRevision): string {
  if (v.source?.undoOf) return `${v.author} · undo of the lead's change`;
  if (v.source?.changeSetId) return v.author === "lead" ? "lead · from your message" : `${v.author} · applied the lead's suggestion`;
  return v.author;
}

/** The revision chip, Undo for a lead focus change, a diff against the previous revision, and the history. */
function VisionProvenance({ state }: { state: State }) {
  const { send, disabled } = useStore();
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const visions = state.project.visions;
  const v = visions[visions.length - 1];
  const prev = visions.length > 1 ? visions[visions.length - 2] : undefined;
  const change = M.currentFocusChange(state);
  const msg = v.source?.messageIds?.[0];
  const diff = prev ? diffLines([`Focus: ${prev.focus}`, ...prev.text.split("\n")], [`Focus: ${v.focus}`, ...v.text.split("\n")]).filter((d) => d.kind !== "same") : [];
  return (
    <>
      <div className="row" style={{ gap: "0.4rem", marginBottom: "0.4rem" }}>
        <span className="chip">
          r{v.rev} · {revisionSource(v)} · {fmtTime(v.at)}
        </span>
        {msg && (
          <button className="link" style={{ fontSize: "0.85rem" }} onClick={() => document.getElementById(`msg-${msg}`)?.scrollIntoView({ block: "center" })}>
            Show the message
          </button>
        )}
        {change && (
          <button
            className="small"
            disabled={disabled || busy}
            onClick={async () => {
              setBusy(true);
              await send("undoSteering", { changeSetId: change.set.id, changeId: change.change.id });
              setBusy(false);
            }}
          >
            Undo the lead's focus change
          </button>
        )}
        {visions.length > 1 && (
          <button className="link" style={{ fontSize: "0.85rem" }} onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}>
            {showHistory ? "Hide history" : `History (${visions.length})`}
          </button>
        )}
      </div>
      {prev && diff.length > 0 && (
        <details style={{ marginBottom: "0.5rem" }}>
          <summary className="muted" style={{ fontSize: "0.85rem" }}>
            What changed from r{prev.rev}: {v.reason}
          </summary>
          <div className="diff" aria-label={`Differences between r${prev.rev} and r${v.rev}`}>
            {diff.map((d, i) => (
              <div key={i} className={d.kind}>
                {d.text}
              </div>
            ))}
          </div>
        </details>
      )}
      {showHistory && (
        <ul className="events" style={{ marginBottom: "0.6rem" }}>
          {[...visions].reverse().map((r) => (
            <li key={r.rev}>
              <span className="mono">r{r.rev}</span>
              <span className="actor">{revisionSource(r)}</span>
              <span>
                {r.reason} <span className="muted">· focus: “{r.focus}” · {fmtTime(r.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Overview() {
  const { state, send, disabled, status, service } = useStore();
  const vision = M.currentVision(state);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // The vision revision the draft started from; saving against it lets the service reject a stale draft.
  const [baseRev, setBaseRev] = useState(vision.rev);
  const staleDraft = editing && !saving && vision.rev !== baseRev;
  const [text, setText] = useState(vision.text);
  const [focus, setFocus] = useState(vision.focus);
  const [reason, setReason] = useState("");
  const since = state.project.lastVisitAt;

  const decisions = state.events.filter((e) => e.at > since && e.kind === "decision").length;
  const newProposals = state.tasks.filter((t) => t.createdAt > since || (t.lifecycle === "proposed" && t.updatedAt > since)).length;
  const completed = state.events.filter((e) => e.at > since && e.kind === "integration" && e.message.includes("Done")).length;
  const blocked = state.tasks.filter((t) => M.column(state, t) === "blocked").length;
  const active = M.activeAttempts(state);
  const unreviewed = D.unreviewedCount(state);
  const nowMs = Date.now();
  const gh = state.project.github;
  // A pull request the app is already fixing does not wait for you.
  const prNeeds = D.trackedPrTasks(state).filter((t) => (t.integration!.pr!.attention && !D.openRepair(state, t.integration!.pr!)) || D.prReady(state, t, nowMs));
  const flagged = D.landedTasks(state).filter((t) => t.integration!.landed!.status === "unreviewed" && t.integration!.landed!.flags.length > 0);
  const ghProblem = gh?.problem && (state.project.prDelivery.enabled || D.openPrTasks(state).length > 0) ? gh.problem : undefined;
  const outcomes = state.tasks.filter((t) => t.lifecycle === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);

  return (
    <>
      <h1>Overview</h1>
      <ModeSummary state={state} />
      <Onboarding />
      <div className="grid-2">
        <div>
          <section className="card" aria-labelledby="vision-h">
            <h2 id="vision-h">Vision</h2>
            <VisionProvenance state={state} />
            {editing ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (saving) return;
                  setSaving(true);
                  // A 409 keeps the form open with the draft; the notice explains the conflict.
                  const r = await send("editVision", { expectedRev: baseRev, text, focus, reason });
                  setSaving(false);
                  if (r.ok) {
                    setEditing(false);
                    setReason("");
                  }
                }}
              >
                {staleDraft && (
                  <div className="banner danger" role="alert">
                    The vision changed to r{vision.rev} ({vision.author}: {vision.reason}) while you were editing. Your draft is kept.{" "}
                    <button type="button" className="small" onClick={() => setBaseRev(vision.rev)}>
                      Save over r{vision.rev} anyway
                    </button>{" "}
                    <button
                      type="button"
                      className="small"
                      onClick={() => {
                        setText(vision.text);
                        setFocus(vision.focus);
                        setBaseRev(vision.rev);
                      }}
                    >
                      Discard draft and load r{vision.rev}
                    </button>
                  </div>
                )}
                <label className="field">
                  <span>Vision</span>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} />
                </label>
                <label className="field">
                  <span>Current focus</span>
                  <input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
                </label>
                <label className="field">
                  <span>Reason for change (recorded)</span>
                  <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
                </label>
                <div className="row">
                  <button type="submit" className="primary" disabled={disabled || saving || staleDraft}>
                    Save as r{vision.rev + 1}
                  </button>
                  <button type="button" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p>{vision.text}</p>
                <p>
                  <span className="muted">Current focus:</span> {vision.focus}
                </p>
                <button
                  onClick={() => {
                    setText(vision.text);
                    setFocus(vision.focus);
                    setBaseRev(vision.rev);
                    setEditing(true);
                  }}
                >
                  Edit vision
                </button>
              </>
            )}
          </section>

          <section className="card" aria-labelledby="since-h">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 id="since-h">Since your last visit</h2>
              <span className="muted">{relTime(since)}</span>
            </div>
            <div className="stat-row">
              <div className="stat">
                <b>{decisions}</b>decisions
              </div>
              <div className="stat">
                <b>{newProposals}</b>new proposals
              </div>
              <div className="stat">
                <b>{completed}</b>completed
              </div>
              <div className="stat">
                <b>{blocked}</b>blocked now
              </div>
            </div>
            <p className="muted" style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
              Viewing does not approve or pause anything.
            </p>
          </section>

          {(prNeeds.length > 0 || flagged.length > 0 || ghProblem || gh?.autoMergePaused) && (
            <section className="card" aria-labelledby="needs-h">
              <h2 id="needs-h">Needs you</h2>
              <ul className="plain">
                {ghProblem && (
                  <li>
                    <span className="chip danger">GitHub</span> {ghProblem.message} <a href="#/settings">Settings</a>
                  </li>
                )}
                {gh?.autoMergePaused && (
                  <li>
                    <span className="chip danger">paused</span> Automatic merging is paused: {gh.autoMergePaused.reason}. {gh.autoMergePaused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again."}{" "}
                    <a href="#/review">Review</a>
                  </li>
                )}
                {prNeeds.map((t) => (
                  <li key={t.id}>
                    <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title} <PrChip state={state} task={t} />
                    {t.integration!.pr!.attention && <div className="muted" style={{ fontSize: "0.85rem" }}>{t.integration!.pr!.attention.message}</div>}
                  </li>
                ))}
                {flagged.map((t) => (
                  <li key={t.id}>
                    <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> {M.currentSpec(t).content.title} <span className="chip danger">landed, flagged</span>
                  </li>
                ))}
              </ul>
              <p style={{ margin: "0.5rem 0 0" }}>
                <a href="#/review">Open Review</a>
              </p>
            </section>
          )}

          <section className="card" aria-labelledby="outcomes-h">
            <h2 id="outcomes-h">Latest outcomes</h2>
            {(unreviewed > 0 || D.landedTasks(state).length > 0) && (
              <p>
                Landed, not reviewed: <strong>{unreviewed}</strong> · <a href="#/review">Review</a>
              </p>
            )}
            {outcomes.length === 0 && <p className="muted">Nothing delivered yet.</p>}
            <ul className="plain">
              {outcomes.map((t) => (
                <li key={t.id}>
                  <a href={`#/task/${t.id}`}>{t.id}</a> {M.currentSpec(t).content.title} <span className="muted">· {relTime(t.updatedAt)}</span>{" "}
                  {t.integration?.delivered?.status === "delivered" && <span className="chip done">delivered</span>}
                  {t.integration?.pr && <PrChip state={state} task={t} />}
                  {(t.integration?.status === "conflict" || t.integration?.delivered?.status === "conflict") && <span className="chip danger">conflict</span>}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div>
          <Conversation />

          <section className="card" aria-labelledby="team-h">
            <h2 id="team-h">Team now</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Worker slots: {active.length} of {state.project.workerLimit} in use. {service.runtime === "real" ? "Runs are live Claude and Codex agents." : "Runs are simulated."}
            </p>
            {active.length === 0 && <p className="muted">No active runs.</p>}
            <table>
              <tbody>
                {active.map((a) => {
                  const t = state.tasks.find((x) => x.id === a.taskId)!;
                  const st = t.steps.find((x) => x.id === a.stepId)!;
                  return (
                    <tr key={a.id}>
                      <td>
                        <a href={`#/task/${t.id}`}>{t.id}</a> {st.id}
                        <div className="muted" style={{ fontSize: "0.8rem" }}>
                          {ROLE_LABEL[st.role]} · {selectionText(a.snapshot)}
                        </div>
                      </td>
                      <td style={{ width: "40%" }}>
                        {a.outcome === "stopping" ? (
                          <span className="pill paused transition">Stopping</span>
                        ) : a.progress > 0 ? (
                          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={a.progress} aria-label={`${a.id} simulated progress`}>
                            <div style={{ width: `${a.progress}%` }} />
                          </div>
                        ) : (
                          <span className="muted" style={{ fontSize: "0.8rem" }}>
                            {a.activity ?? "Starting…"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <UsageCard state={state} />

          <section className="card" aria-labelledby="svc-h">
            <h2 id="svc-h">Service</h2>
            <dl className="kv">
              <dt>Status</dt>
              <dd>{status === "online" ? "Online" : status === "connecting" ? "Connecting…" : "Offline — showing the last known state"}</dd>
              <dt>Started</dt>
              <dd>{fmtTime(service.startedAt)}</dd>
              <dt>Scheduler role</dt>
              <dd>{service.scheduler === "active" ? "Active — this instance holds the scheduler lease" : "Observer — another service instance holds the scheduler lease"}</dd>
              <dt>Runtime</dt>
              <dd>
                {service.runtime === "real"
                  ? `Real: ${Object.values(service.providers)
                      .map((p) => p.label)
                      .join(", ")}`
                  : "Fake runtime (simulated). Start with ORCHESTRATION_RUNTIME=real to run Claude and Codex."}
              </dd>
              <dt>Database</dt>
              <dd className="mono">{service.dbPath}</dd>
              <dt>Repository</dt>
              <dd className="mono">{state.project.repoPath}</dd>
              <dt>Scheduler</dt>
              <dd>
                {state.project.autonomy.enabled
                  ? `Autonomous planning on: every ${state.project.autonomy.planningIntervalMinutes} min${state.project.autonomy.operatingHours ? ` between ${state.project.autonomy.operatingHours.start} and ${state.project.autonomy.operatingHours.end}` : ""}, while this service runs`
                  : "Autonomous planning off; the lead runs only when you message it"}
                {service.runtime === "fake" ? " (simulated)" : ""}. Nothing runs while this service is stopped or the computer sleeps.
              </dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}

/** One line saying how much runs without the user, with a link to change it. */
function ModeSummary({ state }: { state: State }) {
  const a = state.project.autonomy;
  const prMode = state.project.prDelivery.enabled;
  const mode = involvementOf(a, prMode);
  const paused = state.project.hold;
  const pr = state.project.prDelivery;
  let pill: string;
  let text: string;
  switch (mode) {
    case "autopilot":
      pill = "Autopilot on";
      text = prMode ? `opening verified work as GitHub pull requests into ${pr.remote}/${pr.base}, ${pr.merge === "auto" ? "merged automatically after an independent review and passing required checks" : "held for you to merge"}` : `delivering verified work to ${a.autoDeliver.branch}`;
      break;
    case "checkin":
      pill = "Check-in";
      text = "the lead plans on its own; each task it proposes waits for you to release it";
      break;
    case "manual":
      pill = "Manual";
      text = "the lead works when you message it or add tasks";
      break;
    default:
      pill = "Custom";
      text = `lead planning on${a.autoDeliver.enabled ? `, delivering to ${a.autoDeliver.branch}` : ", work stays on the integration branch"}`;
  }
  // Manual and check-in say nothing about delivery by themselves: name the mode when it is on.
  if (mode === "manual" || mode === "checkin") {
    if (prMode) text += `; finished work is opened as GitHub pull requests into ${pr.remote}/${pr.base}, ${pr.merge === "auto" ? "merged automatically after an independent review and passing required checks" : "held for you"}`;
    else if (a.autoDeliver.enabled) text += `; finished work is delivered to ${a.autoDeliver.branch}`;
  }
  return (
    <p className="mode-line" aria-live="polite">
      <span className={mode === "manual" ? "chip strong" : "pill running"}>{pill}</span>
      <span>
        {text}
        {paused ? " · project paused" : ""}
      </span>
      <a href="#/settings">Change</a>
    </p>
  );
}

type Usage = NonNullable<Attempt["usage"]>;
interface Tally {
  runs: number;
  reported: number;
  input: number;
  output: number;
  cost: number;
  costRuns: number;
}
const emptyTally = (): Tally => ({ runs: 0, reported: 0, input: 0, output: 0, cost: 0, costRuns: 0 });

function add(t: Tally, u: Usage | undefined) {
  t.runs += 1;
  if (!u) return;
  if (u.inputTokens !== undefined || u.outputTokens !== undefined) t.reported += 1;
  t.input += u.inputTokens ?? 0;
  t.output += u.outputTokens ?? 0;
  if (u.costUsd !== undefined) {
    t.cost += u.costUsd;
    t.costRuns += 1;
  }
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const fmtCost = (t: Tally) => (t.costRuns ? `$${t.cost.toFixed(2)}` : "—");

/** Token use and provider-reported cost per provider and model, plus how busy each provider is now. */
function UsageCard({ state }: { state: State }) {
  const [range, setRange] = useState<"today" | "all">("today");
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const inRange = (iso: string) => range === "all" || Date.parse(iso) >= startOfToday.getTime();

  // Workers and lead runs, each with the model the provider reported when known.
  const rows: { provider: ProviderId; model: string; at: string; usage?: Usage; lead: boolean }[] = [
    ...state.attempts.map((a) => ({ provider: a.snapshot.provider, model: a.actualModel ?? a.snapshot.model, at: a.endedAt ?? a.startedAt, usage: a.usage, lead: false })),
    ...state.leadRuns.map((r) => ({ provider: r.provider, model: r.actualModel ?? r.model, at: r.endedAt ?? r.startedAt, usage: r.usage, lead: true })),
  ].filter((r) => inRange(r.at));

  const byProvider = new Map<ProviderId, Tally>();
  const byModel = new Map<string, { provider: ProviderId; model: string; t: Tally }>();
  const total = emptyTally();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, emptyTally());
    add(byProvider.get(r.provider)!, r.usage);
    const key = `${r.provider}\u0000${r.model}`;
    if (!byModel.has(key)) byModel.set(key, { provider: r.provider, model: r.model, t: emptyTally() });
    add(byModel.get(key)!.t, r.usage);
    add(total, r.usage);
  }
  const models = [...byModel.values()].sort((a, b) => b.t.input + b.t.output - (a.t.input + a.t.output));

  const active = M.activeAttempts(state);
  const lead = M.activeLeadRun(state);
  const p = state.project;

  return (
    <section className="card" aria-labelledby="usage-h">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="usage-h">Usage</h2>
        <span className="row" role="group" aria-label="Usage period" style={{ gap: "0.25rem" }}>
          {(["today", "all"] as const).map((r) => (
            <button key={r} className="small" aria-pressed={range === r} onClick={() => setRange(r)} style={range === r ? { fontWeight: 650 } : undefined}>
              {r === "today" ? "Today" : "All time"}
            </button>
          ))}
        </span>
      </div>

      <h3 style={{ fontSize: "0.9rem", margin: "0.3rem 0" }}>Running now</h3>
      <table className="usage-table" style={{ fontSize: "0.88rem" }}>
        <tbody>
          {PROVIDERS.map((pr) => {
            const n = active.filter((a) => a.snapshot.provider === pr).length;
            const limit = p.providerLimits?.[pr] ?? p.workerLimit;
            const enabled = p.enabledProviders.includes(pr);
            return (
              <tr key={pr}>
                <td>{M.providerLabel(pr)}</td>
                <td className="num">
                  {n} of {Math.min(limit, p.workerLimit)} worker slots
                </td>
                <td className="muted">{!enabled ? "not enabled" : limit === 0 ? "limit 0: no runs" : lead?.provider === pr ? "+ lead run" : ""}</td>
              </tr>
            );
          })}
          <tr>
            <td>All workers</td>
            <td className="num">
              {active.length} of {p.workerLimit}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: "0.8rem", margin: "0.3rem 0 0.8rem" }}>
        Each provider is limited by its own setting and by the total worker limit. <a href="#/settings">Change limits</a>
      </p>

      <h3 style={{ fontSize: "0.9rem", margin: "0.3rem 0" }}>{range === "today" ? "Today" : "All time"}</h3>
      {rows.length === 0 ? (
        <p className="muted">No runs {range === "today" ? "today" : "yet"}.</p>
      ) : (
        <div className="table-wrap">
          <table className="usage-table" style={{ fontSize: "0.88rem" }}>
            <thead>
              <tr>
                <th>Provider / model</th>
                <th className="num">Runs</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.filter((pr) => byProvider.has(pr)).map((pr) => {
                const t = byProvider.get(pr)!;
                return (
                  <UsageRows key={pr} label={<strong>{M.providerLabel(pr)}</strong>} t={t}>
                    {models
                      .filter((m) => m.provider === pr)
                      .map((m) => (
                        <UsageRow key={m.model} label={<span className="mono" style={{ paddingLeft: "0.8rem" }}>{m.model}</span>} t={m.t} />
                      ))}
                  </UsageRows>
                );
              })}
              <UsageRow label={<strong>Total</strong>} t={total} />
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: "0.8rem", marginBottom: 0 }}>
        Includes worker and lead runs. Cost is the provider's estimate; Codex reports tokens only.
        {total.runs > total.reported ? ` ${total.runs - total.reported} run(s) reported no token counts.` : ""}
      </p>
    </section>
  );
}

function UsageRow({ label, t }: { label: React.ReactNode; t: Tally }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{t.runs}</td>
      <td className="num">{t.reported ? fmtTokens(t.input) : "—"}</td>
      <td className="num">{t.reported ? fmtTokens(t.output) : "—"}</td>
      <td className="num">{fmtCost(t)}</td>
    </tr>
  );
}

function UsageRows({ label, t, children }: { label: React.ReactNode; t: Tally; children: React.ReactNode }) {
  return (
    <>
      <UsageRow label={label} t={t} />
      {children}
    </>
  );
}
