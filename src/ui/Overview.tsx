import { useState } from "react";
import * as D from "../domain/delivery";
import * as F from "../domain/findings";
import * as C from "../domain/checks";
import * as M from "../domain/model";
import { diffLines } from "../domain/diff";
import { useStore } from "./store";
import { ProviderMark, ROLE_LABEL, fmtTime, involvementOf, isSimulated, relTime, selectionText } from "./common";
import { PrChip } from "./Delivery";
import { DecisionQueue } from "./Findings";
import { Conversation } from "./Conversation";
import { Onboarding } from "./Onboarding";
import { liveText, needsYouOf, progressByArea, type AreaProgress } from "./progress";
import { OpenDraft, ShapingPanel } from "./Shaping";
import { RevisionDocs, VisionDocsList } from "./VisionDocs";
import { PROVIDERS, isProvider, type Attempt, type ProviderId, type State, type Task, type VisionRevision } from "../domain/types";

/** Who made a vision revision and from what, in a few words. */
export function revisionSource(v: VisionRevision): string {
  if (v.source?.undoOf) return `${v.author} · undo of the lead's change`;
  if (v.source?.draftId) return `${v.author} · accepted the lead's draft`;
  if (v.source?.docsAdded) return `${v.author} · attached ${v.source.docsAdded.length} document${v.source.docsAdded.length === 1 ? "" : "s"}${v.source.docsRemoved?.length ? " (replacing earlier copies)" : ""}`;
  if (v.source?.docAdded) return `${v.author} · ${v.source.docRemoved ? "replaced a document" : "attached a document"}`;
  if (v.source?.docRemoved) return `${v.author} · removed a document`;
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
        {isSimulated(v) && (
          <span className="chip" title="Written by the fake runtime's lead, not by a model">
            simulated
          </span>
        )}
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
                {r.reason} {isSimulated(r) && <span className="chip">simulated</span>} <span className="muted">· focus: “{r.focus}” · {fmtTime(r.at)}</span> <RevisionDocs state={state} rev={r} />
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
  const outcomes = state.tasks.filter((t) => t.lifecycle === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  // ORC-012: while shaping, the panel replaces the Vision card; a draft the lead sent while building shows on the card.
  const shaping = state.project.stage === "shaping";

  return (
    <>
      <h1>Overview</h1>
      <ModeSummary state={state} />
      <Onboarding />
      <ProgressByArea state={state} />
      <div className="grid-2">
        <div>
          <NeedsYouCard state={state} />
          {shaping ? (
            <ShapingPanel />
          ) : (
          <section className="card" aria-labelledby="vision-h">
            <h2 id="vision-h">Vision</h2>
            <VisionProvenance state={state} />
            {!editing && <OpenDraft />}
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
            <VisionDocsList />
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
            <p className="muted small" style={{ marginTop: "0.6rem" }}>
              Viewing does not approve or pause anything.
            </p>
          </section>

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
                          <span className="pill work transition">Stopping</span>
                        ) : a.progress > 0 ? (
                          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={a.progress} aria-label={`${a.id} simulated progress`}>
                            <div style={{ transform: `scaleX(${Math.max(0, Math.min(100, a.progress)) / 100})` }} />
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

/**
 * ORC-017 §3.3: one row per area. Name and "done of total"; a bar with one segment per task (done, agents
 * working, needs you, the rest); the live line. Each row is a button that opens the board filtered to the area.
 */
function ProgressByArea({ state }: { state: State }) {
  const rows = progressByArea(state);
  return (
    <section className="card" aria-labelledby="progress-h" data-tour="progress">
      <h2 id="progress-h">Progress by area</h2>
      {rows.length === 0 ? (
        <p className="area-empty">No tasks yet. Areas appear here as tasks are created.</p>
      ) : (
        <ul className="areas">
          {rows.map((r) => (
            <li key={r.area}>
              <AreaRow row={r} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AreaRow({ row: r }: { row: AreaProgress }) {
  const open = () => (location.hash = `#/tasks?area=${encodeURIComponent(r.area)}`);
  const widths = { done: r.buckets.done, work: r.buckets.work, you: r.buckets.you, rest: r.buckets.rest };
  const shown = r.live.slice(0, 2);
  const more = r.live.length - shown.length;
  return (
    <button type="button" className="area-row" onClick={open} title={`Open the board filtered to ${r.area}`}>
      <span>
        <span className="area-name">{r.area}</span>
        <span className="area-count">
          {r.done} of {r.total} done
        </span>
      </span>
      <span className="area-bar" role="img" aria-label={r.label}>
        {(["done", "work", "you", "rest"] as const).map((b) => (widths[b] > 0 ? <span key={b} className={b} style={{ width: `${(widths[b] / r.total) * 100}%` }} /> : null))}
      </span>
      <span className="area-live">
        {shown.length === 0 && <span>Idle</span>}
        {shown.map((a, i) => (
          <span key={`${a.taskId}-${a.stepId}-${i}`} className="agent">
            <ProviderMark provider={a.provider} />
            <span className="verb">{liveText(a)}</span> <i title={a.title}>{a.title}</i>
          </span>
        ))}
        {more > 0 && <span>+{more} more</span>}
        {r.needsYou > 0 && (
          <span className="needs">
            {r.needsYou} need{r.needsYou === 1 ? "s" : ""} you
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * ORC-017 §3.4: everything that waits for you, one line each with one control that opens the right place.
 * Reuses the delivery, findings and task derivations; nothing new is stored.
 */
function NeedsYouCard({ state }: { state: State }) {
  const nowMs = Date.now();
  const gh = state.project.github;
  const ghProblem = gh?.problem && (state.project.prDelivery.enabled || D.openPrTasks(state).length > 0) ? gh.problem : undefined;
  const myDecisions = F.openDecisions(state, "user").length;
  const leadDecisions = F.openDecisions(state, "lead").length;
  const items: { key: string; task?: Task; what: string; detail?: string; action: string; href: string }[] = [];
  if (ghProblem) items.push({ key: "gh", what: "GitHub delivery is stopped", detail: ghProblem.message, action: "Settings", href: "#/settings" });
  if (gh?.autoMergePaused) items.push({ key: "auto", what: "automatic merging is paused", detail: `${gh.autoMergePaused.reason}. ${gh.autoMergePaused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again."}`, action: "Review", href: "#/review" });
  for (const t of [...state.tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    const n = needsYouOf(state, t, nowMs);
    if (!n) continue;
    const pr = t.integration?.pr;
    items.push({ key: t.id, task: t, what: n.what, detail: n.what === "look at the pull request" ? pr?.attention?.message : undefined, action: n.action, href: n.href });
  }
  return (
    <section className="card" aria-labelledby="needs-h" data-tour="needs-you">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 id="needs-h">Needs you</h2>
        {items.length > 0 && <span className="chip you">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="needs-empty">Nothing needs you. Agents keep working within your settings.</p>
      ) : (
        <ul className="needs-list">
          {items.map((it) => (
            <li key={it.key}>
              <span className="who">
                <span className="what">
                  <strong>Needs you:</strong> {it.what}
                </span>
                {it.task ? (
                  <span className="t" title={M.currentSpec(it.task).content.title}>
                    <span className="mono muted">{it.task.id}</span> {M.currentSpec(it.task).content.title} {it.task.integration?.pr && <PrChip state={state} task={it.task} />}
                  </span>
                ) : (
                  <span className="t">{it.detail}</span>
                )}
                {it.task && it.detail && <span className="muted small">{it.detail}</span>}
              </span>
              <a className="button-link act" href={it.href}>
                {it.action}
              </a>
            </li>
          ))}
        </ul>
      )}
      {leadDecisions > 0 && (
        <p className="muted small" style={{ margin: "0.5rem 0 0" }}>
          The lead is deciding {leadDecisions} finding{leadDecisions === 1 ? "" : "s"}. You can take any of them over from the task page.
        </p>
      )}
      {myDecisions > 0 && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary className="small">
            Decide {myDecisions === 1 ? "the finding" : `the ${myDecisions} findings`} here
          </summary>
          <p className="muted small" style={{ margin: "0.3rem 0" }}>
            Fix it, accept it as it is, or follow it up as a separate task.
          </p>
          <DecisionQueue state={state} showLead={false} />
        </details>
      )}
    </section>
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
  // ORC-013: whether the service runs the project's checks, and whether it can right now.
  const checks = state.project.checks;
  const checksText = !C.checksOn(checks)
    ? "checks off"
    : C.checksHeld(state)
      ? "checks waiting: sandbox unavailable"
      : `checks on (${checks.commands.filter((c) => c.kind === "check").length} command${checks.commands.filter((c) => c.kind === "check").length === 1 ? "" : "s"}, ${checks.sandbox === "codex" ? "sandboxed" : "no sandbox"})`;
  // ORC-017 §3.5: the long involvement sentence sits behind a disclosure; what is paused or shaping stays in view.
  return (
    <p className="mode-line" aria-live="polite">
      <span className={mode === "manual" ? "chip strong" : "pill work"}>{pill}</span>
      <span>
        {checksText}
        {paused ? " · project paused" : ""}
        {!paused && state.project.stage === "shaping" ? ` · ${M.SHAPING_LABEL.toLowerCase()}` : ""}
      </span>
      <details className="how inline">
        <summary>How this works</summary> {text}.
      </details>
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
  // ORC-013: service runs (checks) use no model tokens and are not counted.
  const rows: { provider: ProviderId; model: string; at: string; usage?: Usage; lead: boolean }[] = [
    ...state.attempts.flatMap((a) => (isProvider(a.snapshot.provider) ? [{ provider: a.snapshot.provider, model: a.actualModel ?? a.snapshot.model, at: a.endedAt ?? a.startedAt, usage: a.usage, lead: false }] : [])),
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
