// Delivery views shared by the Review page and the task page. This file holds the landed section:
// what landed, the agent review, the changes, the user's notes, and the explicit actions
// (mark reviewed, leave a note, send back). Showing an item never changes it.

import { useEffect, useState } from "react";
import type { ChangeError, ChangeResponse } from "../api";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { Landed, LandedFlag, State, Task } from "../domain/types";
import { ROLE_LABEL, fmtTime, relTime } from "./common";
import { newIdOf, useStore } from "./store";

const FLAG_LABEL: Record<LandedFlag, string> = {
  "main-check-failed": "check failed after landing",
  "merged-without-clean-gate": "merged without a clean gate",
  "findings-cleared-by-user": "findings cleared by you",
  "protected-paths": "touches protected files",
};

const STATUS_LABEL: Record<Landed["status"], string> = { unreviewed: "Not reviewed", reviewed: "Reviewed", "sent-back": "Sent back" };

type ChangeResult = { ok: true; change: ChangeResponse } | { ok: false; error: string; url?: string };

/** What a landed task changed. The service reads the commit from the task's own record. */
export async function fetchChange(taskId: string): Promise<ChangeResult> {
  try {
    const res = await fetch(`/api/change?task=${encodeURIComponent(taskId)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    const body = (await res.json()) as Partial<ChangeResponse & ChangeError>;
    if (res.ok && typeof body.diff === "string") return { ok: true, change: body as ChangeResponse };
    return { ok: false, error: typeof body.error === "string" ? body.error : `The service answered ${res.status}.`, url: body.url };
  } catch {
    return { ok: false, error: "The Orchestration service is unreachable, so the changes could not be loaded." };
  }
}

/** A line's class from its first character; file and hunk headers are muted. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "same";
}

/** The diff of a landed change, loaded when shown. */
export function ChangeView({ taskId }: { taskId: string }) {
  const [result, setResult] = useState<ChangeResult | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    void fetchChange(taskId).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [taskId]);
  if (!result) return <p className="muted">Loading changes…</p>;
  if (!result.ok)
    return (
      <p className="muted" role="status">
        {result.error}{" "}
        {result.url && (
          <a href={result.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        )}
      </p>
    );
  const { change } = result;
  if (!change.diff.trim()) return <p className="muted">This commit changed no files.</p>;
  return (
    <>
      <div className="diff code" aria-label={`Changes in ${change.commit.slice(0, 12)}`} tabIndex={0}>
        {change.diff.split("\n").map((line, i) => (
          <div key={i} className={lineClass(line)}>
            {line || " "}
          </div>
        ))}
      </div>
      {change.truncated && (
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>
          The changes are larger than the viewer shows; the rest is cut off. The full change is commit <span className="mono">{change.commit.slice(0, 12)}</span> in the repository.
        </p>
      )}
    </>
  );
}

/** Status and flags of a landed item, as chips. */
export function LandedChips({ landed }: { landed: Landed }) {
  return (
    <>
      <span className={landed.status === "unreviewed" ? "chip strong" : landed.status === "reviewed" ? "chip done" : "chip"}>{STATUS_LABEL[landed.status]}</span>
      {landed.simulated && <span className="chip">simulated</span>}
      {landed.flags.map((f) => (
        <span key={f} className="chip danger">
          {FLAG_LABEL[f]}
        </span>
      ))}
    </>
  );
}

/** One landed item: summary first, then the review, the changes, notes and actions. */
export function LandedSection({ state, task }: { state: State; task: Task }) {
  const { send, disabled } = useStore();
  const landed = task.integration?.landed;
  const [showChanges, setShowChanges] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  if (!landed) return null;
  const spec = M.currentSpec(task).content;
  const reviews = D.landedReviews(state, task);
  const change = M.finalChange(state, task);
  const where = landed.via === "pr" ? `pull request${landed.pr ? ` #${landed.pr.number}` : ""} into ${landed.target}` : `local delivery to ${landed.target}`;
  const who = landed.by === "app" ? "Orchestration" : (landed.mergedBy ?? "a person");

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>{spec.outcome}</p>
      <dl className="kv">
        <dt>Landed</dt>
        <dd>
          <span title={fmtTime(landed.at)}>{relTime(landed.at)}</span> by {who}, {where}
          {landed.simulated ? " (simulated)" : ""}
        </dd>
        <dt>Commit</dt>
        <dd className="mono">{landed.commit.slice(0, 12)}</dd>
        <dt>Agent review</dt>
        <dd>
          {reviews.length === 0 && <span className="muted">No agent review ran on this task.</span>}
          {reviews.map((r) => (
            <details key={r.artifactId}>
              <summary>
                {r.stepId} {ROLE_LABEL[r.role]}
                {r.provider ? ` · ${M.providerLabel(r.provider)} · ${r.model}` : ""} ·{" "}
                <span className={r.openFindings ? "chip danger" : "chip done"}>
                  {r.openFindings} open finding{r.openFindings === 1 ? "" : "s"}
                </span>
                {r.editedByUser && <span className="chip edited"> edited by you</span>}
              </summary>
              <p style={{ whiteSpace: "pre-wrap", margin: "0.3rem 0 0.5rem" }}>{r.summary}</p>
            </details>
          ))}
        </dd>
        {landed.checks && landed.checks.length > 0 && (
          <>
            <dt>Checks at merge</dt>
            <dd>{landed.checks.map((c) => `${c.name}: ${(c.conclusion ?? c.status).toLowerCase()}`).join(" · ")}</dd>
          </>
        )}
        {landed.mainCheck && (
          <>
            <dt>Check after landing</dt>
            <dd>{landed.mainCheck.state === "pending" ? "still running" : landed.mainCheck.state === "success" ? "passed" : landed.mainCheck.state === "failure" ? "failed" : "not known"}</dd>
          </>
        )}
        {change && (
          <>
            <dt>What changed</dt>
            <dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{change.summary}</dd>
          </>
        )}
        {landed.followUps.length > 0 && (
          <>
            <dt>Sent back as</dt>
            <dd>
              {landed.followUps.map((f) => {
                const ft = state.tasks.find((x) => x.id === f.taskId);
                return (
                  <div key={f.taskId}>
                    {f.kind === "revert" ? "Revert" : "Fix"}: <a href={`#/task/${encodeURIComponent(f.taskId)}`}>{f.taskId}</a>{" "}
                    <span className="muted">{ft ? M.stateLabel(state, ft) : "no longer in this project"}</span>
                  </div>
                );
              })}
            </dd>
          </>
        )}
      </dl>

      <div className="controls">
        {landed.status === "reviewed" ? (
          <button disabled={disabled} onClick={() => void send("markLandedReviewed", { taskIds: [task.id], reviewed: false })}>
            Mark not reviewed
          </button>
        ) : (
          <button className="primary" disabled={disabled} onClick={() => void send("markLandedReviewed", { taskIds: [task.id], reviewed: true })}>
            Mark reviewed
          </button>
        )}
        <button aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}>
          {showChanges ? "Hide changes" : "Show changes"}
        </button>
        <button aria-expanded={sendingBack} onClick={() => setSendingBack(!sendingBack)}>
          Send back…
        </button>
        {landed.pr && !landed.simulated && (
          <a className="button-link" href={landed.pr.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        )}
      </div>

      {showChanges && <ChangeView taskId={task.id} />}
      {sendingBack && <SendBackForm state={state} task={task} landed={landed} onDone={() => setSendingBack(false)} />}

      <div>
        <h3>Your notes</h3>
        {landed.notes.length === 0 && (
          <p className="muted" style={{ fontSize: "0.88rem" }}>
            No notes yet.
          </p>
        )}
        <ul className="plain">
          {landed.notes.map((n) => (
            <li key={n.id}>
              <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.text}</span>{" "}
              <span className="muted" title={fmtTime(n.at)}>
                · {relTime(n.at)}
              </span>
              {n.comment && (
                <span className="chip" style={{ marginLeft: "0.4rem" }}>
                  {n.comment.status === "posted" ? "posted on GitHub" : n.comment.status === "pending" ? "waiting to post on GitHub" : "not posted on GitHub"}
                </span>
              )}
            </li>
          ))}
        </ul>
        <form
          style={{ marginTop: "0.5rem" }}
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await send("addLandedNote", { taskId: task.id, text: note, postToGitHub: false });
            if (r.ok) setNote("");
          }}
        >
          <label className="field">
            <span>Add a note</span>
            <textarea value={note} maxLength={D.MAX_NOTE_CHARS} onChange={(e) => setNote(e.target.value)} style={{ minHeight: "3rem" }} />
          </label>
          <button type="submit" className="small" disabled={disabled || !note.trim()}>
            Save note
          </button>{" "}
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Notes stay in Orchestration. A note does not mark the item reviewed.
          </span>
        </form>
      </div>
    </div>
  );
}

/** Send landed work back as a fix or a revert: a linked task through the normal pipeline. */
function SendBackForm({ state, task, landed, onDone }: { state: State; task: Task; landed: Landed; onDone: () => void }) {
  const { send, disabled } = useStore();
  const [kind, setKind] = useState<"fix" | "revert">("fix");
  const [note, setNote] = useState("");
  const [hold, setHold] = useState(false);
  const [busy, setBusy] = useState(false);
  const openRevert = D.openRevertOf(state, landed);
  const revertBlocked = landed.simulated ? "This item is simulated: there is no commit to revert." : openRevert ? `${openRevert.id} is already reverting this change.` : null;
  const blocked = kind === "revert" ? revertBlocked : !note.trim() ? "Say what needs fixing." : null;
  return (
    <form
      className="artifact-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || blocked) return;
        setBusy(true);
        const newId = newIdOf(await send("sendBackLanded", { taskId: task.id, kind, note, holdBeforeStart: hold }));
        setBusy(false);
        if (newId) {
          setNote("");
          onDone();
        }
      }}
    >
      <fieldset className="plain-fieldset">
        <legend style={{ fontWeight: 560, marginBottom: "0.3rem" }}>Send {task.id} back</legend>
        <label>
          <input type="radio" name={`kind-${task.id}`} checked={kind === "fix"} onChange={() => setKind("fix")} /> As a fix: a new task corrects the problem on top of what landed.
        </label>
        <label>
          <input type="radio" name={`kind-${task.id}`} checked={kind === "revert"} onChange={() => setKind("revert")} /> As a revert: a new task undoes commit{" "}
          <span className="mono">{landed.commit.slice(0, 12)}</span> and keeps later work.
        </label>
      </fieldset>
      <label className="field" style={{ marginTop: "0.5rem" }}>
        <span>{kind === "fix" ? "What needs fixing (becomes the task's specification)" : "Why (optional)"}</span>
        <textarea value={note} maxLength={D.MAX_NOTE_CHARS} onChange={(e) => setNote(e.target.value)} style={{ minHeight: "3.5rem" }} />
      </label>
      <label style={{ marginBottom: "0.5rem" }}>
        <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Hold the new task until I start it
      </label>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        The new task runs through the normal pipeline: it is reviewed and delivered like any other. Nothing is undone until that task lands.
      </p>
      <div className="row">
        <button type="submit" className="primary" disabled={disabled || busy || !!blocked}>
          {kind === "fix" ? "Create fix task" : "Create revert task"}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        {blocked && <span className="muted">{blocked}</span>}
      </div>
    </form>
  );
}
