import { useState } from "react";
import * as M from "../domain/model";
import { useStore } from "./store";
import { ROLE_LABEL, fmtTime, relTime, selectionText } from "./common";

export function Overview() {
  const { state, apply } = useStore();
  const vision = M.currentVision(state);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(vision.text);
  const [focus, setFocus] = useState(vision.focus);
  const [reason, setReason] = useState("");
  const since = state.project.lastVisitAt;

  const decisions = state.events.filter((e) => e.at > since && e.kind === "decision").length;
  const newProposals = state.tasks.filter((t) => t.createdAt > since || (t.lifecycle === "proposed" && t.updatedAt > since)).length;
  const completed = state.events.filter((e) => e.at > since && e.kind === "integration" && e.message.includes("Done")).length;
  const blocked = state.tasks.filter((t) => M.column(state, t) === "blocked").length;
  const active = M.activeAttempts(state);
  const outcomes = state.tasks.filter((t) => t.lifecycle === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);

  return (
    <>
      <h1>Overview</h1>
      <div className="grid-2">
        <div>
          <section className="card" aria-labelledby="vision-h">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 id="vision-h">Vision</h2>
              <span className="chip">
                r{vision.rev} · {vision.author} · {fmtTime(vision.at)}
              </span>
            </div>
            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (apply((s, now) => M.editVision(s, vision.rev, text, focus, reason, now))) {
                    setEditing(false);
                    setReason("");
                  }
                }}
              >
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
                  <button type="submit" className="primary">
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

          <section className="card" aria-labelledby="outcomes-h">
            <h2 id="outcomes-h">Latest outcomes</h2>
            {outcomes.length === 0 && <p className="muted">Nothing delivered yet.</p>}
            <ul className="plain">
              {outcomes.map((t) => (
                <li key={t.id}>
                  <a href={`#/task/${t.id}`}>{t.id}</a> {M.currentSpec(t).content.title} <span className="muted">· {relTime(t.updatedAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div>
          <section className="card" aria-labelledby="lead-h">
            <h2 id="lead-h">Lead</h2>
            <p>
              {selectionText(state.project.leadSelection)} <span className="chip">simulated</span>
            </p>
            <div className="banner neutral" style={{ marginBottom: 0 }}>
              The lead conversation arrives with the runtime integrations (Milestone 3). In this prototype, direction is recorded through vision revisions and task edits.
            </div>
          </section>

          <section className="card" aria-labelledby="team-h">
            <h2 id="team-h">Team now</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Worker slots: {active.length} of {state.project.workerLimit} in use. Runs are simulated.
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
                        ) : (
                          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={a.progress} aria-label={`${a.id} simulated progress`}>
                            <div style={{ width: `${a.progress}%` }} />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="card" aria-labelledby="svc-h">
            <h2 id="svc-h">Service</h2>
            <dl className="kv">
              <dt>Service</dt>
              <dd>Not built yet — this browser tab runs the simulation (Milestone 2 adds a local service)</dd>
              <dt>Persistence</dt>
              <dd>This browser's local storage only</dd>
              <dt>Repository</dt>
              <dd className="mono">{state.project.repoPath}</dd>
              <dt>Scheduler</dt>
              <dd>None installed; no unattended runs</dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}
