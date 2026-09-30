// Delivery views shared by the Review page, the board and the task page.
//   - The pull-request panel: what you asked for (desired), what is being sent (intent) and what
//     GitHub reports (observed), kept apart, with the merge checklist and the explicit actions.
//   - The landed section: what landed, the agent review, the changes, the user's notes, and the
//     explicit actions (mark reviewed, leave a note, send back). Showing an item never changes it.

import { useEffect, useState } from "react";
import type { ChangeError, ChangeResponse } from "../api";
import * as D from "../domain/delivery";
import { diffLineClasses } from "../domain/diff";
import * as M from "../domain/model";
import type { Landed, LandedFlag, PrDelivery, State, Task } from "../domain/types";
import { ROLE_LABEL, fmtTime, relTime, resumeAutoMergeText } from "./common";
import { newIdOf, useStore } from "./store";

const FLAG_LABEL: Record<LandedFlag, string> = {
  "main-check-failed": "check failed after landing",
  "merged-without-clean-gate": "merged without a clean gate",
  "findings-cleared-by-user": "findings cleared by you",
  "protected-paths": "touches protected files",
  "checks-accepted-failing": "failing checks accepted by you",
  "checks-not-run": "no service checks ran",
  "findings-accepted": "findings accepted as is",
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
    return { ok: false, error: "The Orchestrator service is unreachable, so the changes could not be loaded." };
  }
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
  if (!change.diff.trim()) return <p className="muted">{change.truncated ? "The changes took too long to read; they are not shown." : "This commit changed no files."}</p>;
  const lines = change.diff.split("\n");
  const classes = diffLineClasses(lines);
  return (
    <>
      <div className="diff code" aria-label={`Changes in ${change.commit.slice(0, 12)}`} tabIndex={0}>
        {lines.map((line, i) => (
          <div key={i} className={classes[i]}>
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

const TONE_CLASS: Record<D.PrLabel["tone"], string> = { plain: "chip", strong: "chip strong", done: "chip done", danger: "chip danger" };

/** The board chip for a task delivered as a pull request. */
export function PrChip({ state, task }: { state: State; task: Task }) {
  const label = D.prLabel(state, task, Date.now());
  if (!label) return null;
  return <span className={TONE_CLASS[label.tone]}>{label.text}</span>;
}


function observedLine(pr: PrDelivery): string {
  const o = pr.observed;
  if (pr.phase === "built") return "Not opened yet: nothing has been pushed.";
  if (!o) return "Opened; GitHub has not been read since.";
  const checks = o.checks.length ? o.checks.map((c) => `${c.name} ${(c.conclusion ?? "running").toLowerCase().replace(/_/g, " ")}`).join(", ") : "no check has reported";
  const where = o.checksFor ? ` on ${o.checksFor.slice(0, 12)}` : "";
  return `${o.state.toLowerCase()} · ${checks}${where} · seen ${relTime(o.at)}`;
}

/**
 * One task's pull request: what you asked for, what is in flight and what GitHub reports, kept apart,
 * then the merge checklist and the actions. A Merge click names the head commit shown here.
 */
export function PrPanel({ state, task }: { state: State; task: Task }) {
  const { send, disabled } = useStore();
  const [showChanges, setShowChanges] = useState(false);
  const integration = task.integration;
  const pr = integration?.pr;
  if (!integration || !pr) return null;
  if (integration.status !== "integrated")
    return (
      <p className="muted" style={{ margin: 0 }}>
        {integration.status === "conflict"
          ? "The change could not be prepared as a pull request; see the conflict above."
          : `A new pull request (number ${pr.n + 1} for this task) is being prepared. The earlier one${pr.number ? `, PR #${pr.number},` : ""} stays closed.`}
      </p>
    );
  const now = Date.now();
  const live = pr.phase === "built" || pr.phase === "open";
  const cfg = state.project.prDelivery;
  const gh = state.project.github;
  const auto = pr.policy === "auto";
  // The user's own merge (hold, or a Merge click for this head) or the automatic gate: the same function the service uses.
  const byUser = !auto || pr.mergeRequested?.headSha === pr.headSha;
  const gate = live ? D.prGate(state, task, now, { byUser }) : null;
  const intent = D.prIntentLine(pr);
  const label = D.prLabel(state, task, now);
  const prOn = cfg.enabled;
  const h12 = pr.headSha.slice(0, 12);
  const elsewhere = !!gh?.repo && !!pr.repo && pr.repo !== gh.repo;
  const canAskMerge = pr.phase === "open" && prOn && !elsewhere && !pr.foreignHead && !pr.closeRequested && !pr.userHold && !pr.op && !pr.pendingHead && pr.mergeRequested?.headSha !== pr.headSha;
  const refused = pr.counters.mergeAttempts >= D.PR_LIMITS.mergeAttempts;
  const onGitHub = !pr.simulated && pr.url?.startsWith("https://github.com/");
  const review = live ? D.reviewView(state, task) : null;
  const linked = (ids: string[]) => ids.map((id) => state.tasks.find((x) => x.id === id)).filter((x): x is Task => !!x);
  const reviews = linked(pr.reviewTaskIds);
  const repairs = linked(pr.repairTaskIds);
  const fixing = live ? D.openRepair(state, pr) : undefined;
  const openReview = reviews.find((x) => x.lifecycle !== "done" && x.lifecycle !== "cancelled" && x.reviewTarget?.headSha === pr.changeSha);
  // The user's Fix this PR may also take on a review bot's failing check (by name and link); nothing automatic does.
  const cause = live && prOn && !elsewhere ? D.repairCause(state, task, { byUser: true }) : undefined;
  const canFix = !!cause && !fixing && !pr.foreignHead && pr.counters.repairs < D.PR_LIMITS.repairs && pr.pendingHead?.kind !== "repair";
  const canAskReview = live && prOn && !elsewhere && !openReview && !pr.foreignHead && review?.state !== "ok";
  const queue = auto && live ? D.autoQueue(state) : [];
  const place = queue.findIndex((x) => x.id === task.id);
  const paused = gh?.autoMergePaused;
  const causeText =
    cause?.kind === "checks"
      ? `the failed check${cause.checks.length === 1 ? "" : "s"} ${cause.checks.map((c) => c.name).join(", ")}`
      : cause?.kind === "service-checks"
        ? `the failed project check${cause.results.length === 1 ? "" : "s"} ${cause.results.map((c) => c.label).join(", ")}`
        : cause?.kind === "findings"
          ? "the open review findings"
          : `the conflict with ${pr.base}`;
  // ORC-013 §7.3: re-runs of GitHub-cancelled jobs on this head, as recorded when each was requested.
  const reruns = live && pr.ciReruns?.headSha === pr.headSha ? pr.ciReruns.used : [];
  return (
    <div className="stack">
      <div className="row">
        {label && <span className={TONE_CLASS[label.tone]}>{label.text}</span>}
        {pr.simulated && <span className="chip">simulated: nothing was sent to GitHub</span>}
      </div>
      {pr.attention && (
        <div className="banner danger" role="alert" style={{ margin: 0 }}>
          <strong>Needs you.</strong> {pr.attention.message}
        </div>
      )}
      {live && !prOn && (
        <div className="banner neutral" role="status" style={{ margin: 0 }}>
          {pr.phase === "built"
            ? "Pull-request delivery is off, so this pull request was prepared but never opened: nothing was pushed. Switch the delivery mode back on to open it, or abandon it and deliver the work through the current mode."
            : "Pull-request delivery is off. This pull request is only watched: nothing is pushed, merged or commented. Merge or close it on GitHub, or switch the delivery mode back on."}
        </div>
      )}
      {auto && live && paused && (
        <div className="banner neutral" role="status" style={{ margin: 0 }}>
          <strong>Automatic merging is paused:</strong> {paused.reason}. {paused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again, or when you resume it."} Nothing is reverted automatically. You can merge this one yourself.{" "}
          <button className="small" disabled={disabled} onClick={() => {
              if (confirm(resumeAutoMergeText(paused.reason))) void send("resumeAutoMerge");
            }}>
            Resume automatic merging
          </button>
        </div>
      )}
      <dl className="kv">
        <dt>You</dt>
        <dd>
          {auto ? "Merge automatically after an independent review and passing required checks, for exactly the commit shown." : "Hold and notify: you merge it, here or on GitHub."}{" "}
          <span className="muted">{pr.policySource === "user" ? "Your choice for this pull request." : "The project's setting."}</span>
          {pr.userHold ? ` Held by you${pr.userHold.reason ? ` (${pr.userHold.reason})` : ""}.` : ""}
        </dd>
        {auto && live && place >= 0 && (
          <>
            <dt>Merge queue</dt>
            <dd>
              {place === 0
                ? `First in line: the one pull request that is brought up to date with ${pr.base} and merged.`
                : `Waiting behind PR #${queue[0].integration!.pr!.number} (place ${place + 1} of ${queue.length}). Pull requests merge one at a time, so what lands is what the checks tested.`}
            </dd>
          </>
        )}
        {intent && (
          <>
            <dt>In flight</dt>
            <dd>{intent}</dd>
          </>
        )}
        <dt>GitHub{pr.simulated ? " (simulated)" : ""}</dt>
        <dd>
          {pr.number ? `PR #${pr.number}: ` : ""}
          {pr.phase === "merged" ? `merged${pr.observed?.mergedBy ? ` by ${pr.observed.mergedBy}` : ""}` : pr.phase === "closed" ? `closed without merging${pr.observed?.closedBy ? ` by ${pr.observed.closedBy}` : ""}` : observedLine(pr)}
        </dd>
        <dt>Branch</dt>
        <dd className="mono" style={{ overflowWrap: "anywhere" }}>
          {pr.branch} → {pr.base}
        </dd>
        <dt>Head commit</dt>
        <dd>
          <span className="mono">{h12}</span>
          {pr.headSha !== pr.changeSha && (
            <span className="muted">
              {" "}
              the reviewed change <span className="mono">{pr.changeSha.slice(0, 12)}</span> with {pr.base} (<span className="mono">{pr.baseSha.slice(0, 12)}</span>) merged into it by Orchestrator
            </span>
          )}
        </dd>
        <dt>Changes</dt>
        <dd>
          {pr.changed.files} file{pr.changed.files === 1 ? "" : "s"}, +{pr.changed.additions} −{pr.changed.deletions}
          {pr.changed.workflowHits.length > 0 && <div>Changes CI workflow files: {pr.changed.workflowHits.slice(0, 5).join(", ")}</div>}
          {pr.changed.protectedHits.length > 0 && <div>Touches protected files: {pr.changed.protectedHits.slice(0, 5).join(", ")}</div>}
        </dd>
        <dt>Independent review</dt>
        <dd>
          <span className={pr.review.ok ? "chip done" : review?.state === "pending" || review?.state === "missing" || review?.state === "not-independent" ? "chip" : "chip danger"}>
            {pr.review.ok ? "clean" : review?.state === "pending" ? "running" : review?.state === "findings" ? "open findings" : review?.state === "blocked" ? "cannot run" : review?.state === "limit" ? "limit reached" : "not reviewed yet"}
          </span>{" "}
          {pr.review.reason}
          {pr.review.ok && (
            <div className="muted">
              Automated review, not a human one. Reviewed commit <span className="mono">{(pr.review.forSha ?? pr.changeSha).slice(0, 12)}</span>
              {pr.review.provider ? ` · ${M.providerLabel(pr.review.provider)}${pr.review.model ? ` · ${pr.review.model}` : ""}` : ""} · written by {M.authorsLabel(M.prAuthors(pr))} ·{" "}
              {pr.review.source === "dedicated" ? "a dedicated review task" : "the task's own review step"}
              {pr.review.taskId && pr.review.taskId !== task.id ? (
                <>
                  {" "}
                  (<a href={`#/task/${encodeURIComponent(pr.review.taskId)}`}>{pr.review.taskId}</a>)
                </>
              ) : null}
            </div>
          )}
          {reviews.map((x) => (
            <div key={x.id}>
              Review task <a href={`#/task/${encodeURIComponent(x.id)}`}>{x.id}</a> <span className="muted">{M.stateLabel(state, x)}{x.reviewTarget?.headSha !== pr.changeSha ? " · for an earlier change, not counted" : ""}</span>
            </div>
          ))}
          {repairs.map((x) => (
            <div key={x.id}>
              Fix task <a href={`#/task/${encodeURIComponent(x.id)}`}>{x.id}</a> <span className="muted">{M.stateLabel(state, x)}</span>
            </div>
          ))}
        </dd>
        {reruns.length > 0 && (
          <>
            <dt>Re-runs</dt>
            <dd>
              {reruns.map((u) => (
                <div key={`${u.opId}:${u.check}`}>
                  Re-ran {u.check} at {fmtTime(u.at)}: GitHub had cancelled it (job {u.jobId}).{" "}
                  <span className="muted">{pr.op?.id === u.opId ? "Sent; waiting for GitHub to report the new run." : (u.seen ?? 0) >= D.PR_LIMITS.rerunObservations ? "The new run did not appear; judged by what GitHub shows." : ""}</span>
                </div>
              ))}
              <div className="muted">
                {reruns.length} of {D.PR_LIMITS.reruns} re-runs used for this pull request; {cfg.rerunBudget} per check per head.
              </div>
            </dd>
          </>
        )}
        {pr.message && live && (
          <>
            <dt>Last problem</dt>
            <dd style={{ overflowWrap: "anywhere" }}>{pr.message}</dd>
          </>
        )}
      </dl>

      {gate && pr.phase === "open" && (
        <ul className="checklist" aria-label={byUser ? "Before this pull request can merge" : "Before this pull request merges by itself"}>
          {gate.items.map((it) => (
            <li key={it.id} className={it.ok ? "done" : undefined}>
              <span className="check" aria-hidden="true">
                {it.ok ? "✓" : it.state === "blocked" ? "!" : "…"}
              </span>
              <span>
                <span className="label">{it.label}</span>
                <span className="sr-only">{it.ok ? " (met)" : it.state === "blocked" ? " (blocked)" : " (waiting)"}</span>
                {it.advisory && <span className="muted"> (shown for you; your own merge does not wait for it)</span>}
                <div className="detail muted">{it.detail}</div>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="controls">
        {canAskMerge && (
          <button
            className="primary"
            disabled={disabled}
            title="Merges exactly this commit, and only once GitHub's required checks and rules pass for it"
            onClick={() => {
              if (confirm(`Merge PR #${pr.number} at ${h12} into ${pr.base}? It merges only once GitHub's required checks and rules pass for that commit.`)) void send("requestPrMerge", { taskId: task.id, headSha: pr.headSha });
            }}
          >
            {refused ? `Try merging ${h12} again` : auto ? `Merge ${h12} myself` : `Merge ${h12}`}
          </button>
        )}
        {live && prOn && !elsewhere && !pr.foreignHead && !pr.closeRequested && (auto ? (
          <button disabled={disabled} onClick={() => void send("setPrPolicy", { taskId: task.id, policy: "hold" })}>
            Hold this one for me
          </button>
        ) : (
          <button
            disabled={disabled}
            title="Only chooses who merges: the same checks still have to pass for this exact commit"
            onClick={() => {
              if (
                confirm(
                  `Let PR ${pr.number ? `#${pr.number}` : "for this task"} merge by itself? It merges only when an independent review is clean for exactly this change, every required check passed on its head, GitHub reports it mergeable, and it touches no protected file. The app never bypasses branch rules.`,
                )
              )
                void send("setPrPolicy", { taskId: task.id, policy: "auto" });
            }}
          >
            Merge this one automatically
          </button>
        ))}
        {live && pr.policySource === "user" && pr.policy !== cfg.merge && (
          <button disabled={disabled} onClick={() => void send("setPrPolicy", { taskId: task.id, policy: null })}>
            Follow the project setting
          </button>
        )}
        {canFix && (
          <button
            disabled={disabled}
            title="One fix task; its result is pushed onto this pull request and reviewed again"
            onClick={() => {
              if (confirm(`Create a fix task for ${causeText}? An agent works on top of ${h12}; its result is pushed onto this pull request and reviewed again. ${pr.counters.repairs} of ${D.PR_LIMITS.repairs} fix tasks used.`)) void send("repairPr", { taskId: task.id });
            }}
          >
            Fix this PR
          </button>
        )}
        {canAskReview && (
          <button disabled={disabled} title="One dedicated review task for the change this pull request holds now" onClick={() => void send("requestPrReview", { taskId: task.id })}>
            Ask for a review
          </button>
        )}
        {live && (pr.userHold ? (
          <button disabled={disabled} onClick={() => void send("releasePr", { taskId: task.id })}>
            Release hold
          </button>
        ) : (
          <button disabled={disabled} onClick={() => void send("holdPr", { taskId: task.id })}>
            Hold
          </button>
        ))}
        {live && pr.changed.workflowHits.length > 0 && !pr.workflowPushAllowed && (
          <button
            disabled={disabled}
            onClick={() => {
              if (confirm("Allow this one delivery to push a change to CI workflow files? The checks that gate it run from those files.")) void send("allowWorkflowPush", { taskId: task.id });
            }}
          >
            Allow workflow change
          </button>
        )}
        {live && !pr.closeRequested && (
          <button
            disabled={disabled}
            onClick={() => {
              if (confirm(pr.phase === "open" ? `Close PR #${pr.number} without merging? The branch is kept; it is never reopened.` : "Abandon this delivery?")) void send("closePr", { taskId: task.id });
            }}
          >
            {pr.phase === "open" ? "Close pull request" : "Abandon delivery"}
          </button>
        )}
        {pr.phase === "closed" && !integration.landed && (
          <button
            disabled={disabled}
            title={prOn ? "Opens a new pull request; the closed one is never reopened" : "Pull-request delivery is off: the work goes through the current delivery mode instead"}
            onClick={() => void send("redeliver", { taskIds: [task.id] })}
          >
            {prOn ? "Deliver again" : "Deliver through the current mode"}
          </button>
        )}
        {live && !pr.simulated && (
          <button aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}>
            {showChanges ? "Hide changes" : "Show changes"}
          </button>
        )}
        {onGitHub && (
          <a className="button-link" href={pr.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        )}
      </div>
      {showChanges && live && <ChangeView taskId={task.id} />}
    </div>
  );
}

/** The delivery of a finished task on its own page: its pull request, and what landed. */
export function DeliveryCard({ state, task }: { state: State; task: Task }) {
  const integration = task.integration;
  if (!integration?.pr && !integration?.landed) return null;
  return (
    <section className="card" aria-labelledby="delivery-h">
      <h2 id="delivery-h">Delivery</h2>
      {integration.pr && <PrPanel state={state} task={task} />}
      {integration.landed && (
        <>
          <div className="row" style={{ marginTop: integration.pr ? "1rem" : 0 }}>
            <h3 style={{ margin: 0 }}>Landed</h3>
            <LandedChips landed={integration.landed} />
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <LandedSection state={state} task={task} />
          </div>
        </>
      )}
    </section>
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
  const [post, setPost] = useState(false);
  if (!landed) return null;
  // Offered only when the note would really be posted: never left "waiting" for a post that cannot happen.
  const postBlocked = D.cannotPostNote(state, task);
  const canPost = !postBlocked;
  const couldPost = landed.via === "pr" && !!landed.pr && !landed.simulated;
  const spec = M.currentSpec(task).content;
  const reviews = D.landedReviews(state, task);
  const change = M.finalChange(state, task);
  const where = landed.via === "pr" ? `pull request${landed.pr ? ` #${landed.pr.number}` : ""} into ${landed.target}` : `local delivery to ${landed.target}`;
  const who = landed.by === "app" ? "Orchestrator" : (landed.mergedBy ?? "a person");

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
        {landed.pr && !landed.simulated && landed.pr.url.startsWith("https://github.com/") && (
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
                <span className={n.comment.status === "failed" ? "chip danger" : "chip"} style={{ marginLeft: "0.4rem" }} title={n.comment.error}>
                  {n.comment.status === "posted" ? "posted on GitHub" : n.comment.status === "pending" ? (postBlocked ? "not posted: pull-request delivery is off" : "waiting to post on GitHub") : "not posted on GitHub"}
                </span>
              )}
              {n.comment?.status === "posted" && n.comment.url?.startsWith("https://github.com/") && (
                <>
                  {" "}
                  <a href={n.comment.url} target="_blank" rel="noreferrer">
                    comment
                  </a>
                </>
              )}
              {n.comment?.status === "failed" && (
                <>
                  {" "}
                  <button className="small" disabled={disabled} onClick={() => void send("retryLandedComment", { taskId: task.id, noteId: n.id })}>
                    Try posting again
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        <form
          style={{ marginTop: "0.5rem" }}
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await send("addLandedNote", { taskId: task.id, text: note, postToGitHub: canPost && post });
            if (r.ok) {
              setNote("");
              setPost(false);
            }
          }}
        >
          <label className="field">
            <span>Add a note</span>
            <textarea value={note} maxLength={D.MAX_NOTE_CHARS} onChange={(e) => setNote(e.target.value)} style={{ minHeight: "3rem" }} />
          </label>
          {couldPost && (
            <label style={{ display: "block", marginBottom: "0.4rem" }}>
              <input type="checkbox" checked={canPost && post} disabled={!canPost} onChange={(e) => setPost(e.target.checked)} /> Also post this note as a comment on PR #{landed.pr!.number}, under your GitHub account (public if the repository is
              public)
              {!canPost && <span className="muted"> Not available now: {postBlocked}</span>}
            </label>
          )}
          <button type="submit" className="small" disabled={disabled || !note.trim()}>
            Save note
          </button>{" "}
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            Notes stay in Orchestrator unless you choose to post one. A note does not mark the item reviewed.
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
