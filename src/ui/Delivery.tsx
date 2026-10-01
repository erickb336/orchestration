// Delivery views shared by the Results page, the board and the task page.
//   - The pull-request panel (ORC-025 R2): one verdict line ("Pull request #1000 · Code ✓ Security ✓ Checks ✓ ·
//     6 files, +167 −12"), Merge and Keep for me, and the full merge checklist, the facts GitHub reports and the
//     rarer actions behind "Why it's ready". Desired, in-flight and observed state stay apart in that disclosure.
//   - The landed section: what landed with the agent reviews in one line, what changed, Mark as seen and Send
//     back, and your notes behind a disclosure. Showing an item never changes it.

import { useEffect, useState } from "react";
import type { ChangeError, ChangeResponse } from "../api";
import * as D from "../domain/delivery";
import { diffLineClasses } from "../domain/diff";
import * as M from "../domain/model";
import type { Landed, PrDelivery, State, Task } from "../domain/types";
import { ROLE_LABEL, fmtTime, relTime } from "./common";
import { DELIVERY_CONFIRM, LANDED_FLAG_LABEL, LANDED_STATUS_LABEL, VERDICT_MARK, VERDICT_WORD, changesText, gateLabel, landedVerdict, landedWhere, landedWho, prVerdict, type VerdictPart } from "./deliveryView";
import { Actions, Banner, Button, ButtonLink, Checkbox, Chip, Disclosure, Field, SimulatedChip, Textarea, useConfirm, type Tone } from "./kit";
import { newIdOf, useStore } from "./store";

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
        <p className="muted small">
          The changes are larger than the viewer shows; the rest is cut off. The full change is commit <span className="mono">{change.commit.slice(0, 12)}</span> in the repository.
        </p>
      )}
    </>
  );
}

const LABEL_TONE: Record<D.PrLabel["tone"], Tone> = { plain: "neutral", strong: "work", done: "done", danger: "fail" };

/** The board chip for a task delivered as a pull request, with one small "simulated" mark beside it in the demo. */
export function PrChip({ state, task }: { state: State; task: Task }) {
  const label = D.prLabel(state, task, Date.now());
  if (!label) return null;
  return (
    <>
      <Chip tone={LABEL_TONE[label.tone]} strong={label.tone === "strong"}>
        {label.text}
      </Chip>
      {label.simulated && <SimulatedChip title="Simulated pull request: nothing was sent to GitHub." />}
    </>
  );
}

/** "Code ✓ Security ✓ Checks ✓", each part a chip in the colour of its state, with the reason as its title. */
export function Verdict({ parts }: { parts: VerdictPart[] }) {
  return (
    <>
      {parts.map((p) => (
        <Chip key={p.label} tone={p.state === "ok" ? "done" : p.state === "fail" ? "fail" : "neutral"} title={`${p.label}: ${VERDICT_WORD[p.state]}. ${p.detail}`}>
          {p.label} {VERDICT_MARK[p.state]}
          <span className="sr-only"> {VERDICT_WORD[p.state]}</span>
        </Chip>
      ))}
    </>
  );
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
 * One task's pull request: the verdict line, Merge and Keep for me, and everything else behind one disclosure.
 * A Merge click names the head commit shown there.
 */
export function PrPanel({ state, task }: { state: State; task: Task }) {
  const { send, disabled } = useStore();
  const confirm = useConfirm();
  const [showChanges, setShowChanges] = useState(false);
  const integration = task.integration;
  const pr = integration?.pr;
  if (!integration || !pr) return null;
  if (integration.status !== "integrated")
    return (
      <p className="muted meta">
        {integration.status === "conflict"
          ? "The change could not be prepared as a pull request; see the conflict above."
          : `A new pull request (number ${pr.n + 1} for this task) is being prepared. The earlier one${pr.number ? `, PR #${pr.number},` : ""} stays closed.`}
      </p>
    );
  const now = Date.now();
  const verdict = prVerdict(state, task, now)!;
  const live = pr.phase === "built" || pr.phase === "open";
  const cfg = state.project.prDelivery;
  const gh = state.project.github;
  const auto = pr.policy === "auto";
  const byUser = !auto || pr.mergeRequested?.headSha === pr.headSha;
  const intent = D.prIntentLine(pr);
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
  // ORC-025: the service's own check runs on this change, named so the checklist's evidence has a visible source.
  const checkTasks = state.tasks.filter((x) => x.checkTarget?.taskId === task.id && x.checkTarget.n === pr.n);
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
  const fixButton = canFix && (
    <Button
      size="small"
      disabled={disabled}
      title="One fix task; its result is pushed onto this pull request and reviewed again"
      onClick={async () => {
        if (await confirm(DELIVERY_CONFIRM.fixPr(causeText, pr.headSha, pr.counters.repairs, D.PR_LIMITS.repairs))) void send("repairPr", { taskId: task.id });
      }}
    >
      Fix this PR
    </Button>
  );
  return (
    <div className="k-stack k-stack--tight">
      {pr.attention && (
        <Banner tone="fail" title="Needs you." actions={fixButton}>
          {pr.attention.message}
        </Banner>
      )}
      {live && !prOn && (
        <Banner>
          {pr.phase === "built"
            ? "Pull-request delivery is off, so this pull request was prepared but never opened: nothing was pushed. Switch the delivery mode back on to open it, or abandon it and deliver the work through the current mode."
            : "Pull-request delivery is off. This pull request is only watched: nothing is pushed, merged or commented. Merge or close it on GitHub, or switch the delivery mode back on."}
        </Banner>
      )}
      {auto && live && paused && (
        <Banner
          title="Automatic merging is paused."
          actions={
            <Button
              size="small"
              disabled={disabled}
              onClick={async () => {
                if (await confirm(DELIVERY_CONFIRM.resumeAutoMerge(paused.reason))) void send("resumeAutoMerge");
              }}
            >
              Resume automatic merging
            </Button>
          }
        >
          {paused.reason}. {paused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again, or when you resume it."} Nothing is reverted automatically. You can merge this one yourself.
        </Banner>
      )}
      <p className="t-verdict">
        <span className="t-verdict__name">{verdict.name}</span>
        {pr.phase === "merged" && <Chip tone="done">landed</Chip>}
        {pr.phase === "closed" && <Chip tone="fail">closed without merging</Chip>}
        {verdict.parts.length > 0 && (
          <>
            <span className="t-verdict__sep" aria-hidden="true">
              ·
            </span>
            <Verdict parts={verdict.parts} />
          </>
        )}
        <span className="t-verdict__sep" aria-hidden="true">
          ·
        </span>
        <span className="muted">{verdict.changes}</span>
        {pr.simulated && <SimulatedChip title="Simulated pull request: nothing was sent to GitHub." />}
      </p>
      {intent && <p className="meta muted">{intent}</p>}
      {pr.userHold && !pr.attention && <p className="meta muted">Kept for you{pr.userHold.reason ? ` (${pr.userHold.reason})` : ""}: nothing is pushed, merged or commented until you let it continue.</p>}
      <Actions>
        {canAskMerge && (
          <Button
            variant="primary"
            disabled={disabled}
            title={`Merges exactly ${h12}, and only once GitHub's required checks and rules pass for it`}
            onClick={async () => {
              if (await confirm(DELIVERY_CONFIRM.merge(pr))) void send("requestPrMerge", { taskId: task.id, headSha: pr.headSha });
            }}
          >
            {refused ? "Try merging again" : auto ? "Merge myself" : "Merge"}
          </Button>
        )}
        {live &&
          (pr.userHold ? (
            <Button disabled={disabled} title={auto ? "It goes back to merging by itself once the checklist holds" : "It goes back to waiting for your Merge"} onClick={() => void send("releasePr", { taskId: task.id })}>
              {auto ? "Let it merge" : "Let it continue"}
            </Button>
          ) : (
            <Button disabled={disabled} title="Nothing is pushed, merged or commented on this pull request until you let it continue" onClick={() => void send("holdPr", { taskId: task.id })}>
              Keep for me
            </Button>
          ))}
        {!pr.attention && fixButton}
        {pr.phase === "closed" && !integration.landed && (
          <Button
            disabled={disabled}
            title={prOn ? "Opens a new pull request; the closed one is never reopened" : "Pull-request delivery is off: the work goes through the current delivery mode instead"}
            onClick={() => void send("redeliver", { taskIds: [task.id] })}
          >
            {prOn ? "Deliver again" : "Deliver through the current mode"}
          </Button>
        )}
        {live && !pr.simulated && (
          <Button variant="quiet" aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}>
            {showChanges ? "Hide changes" : "Show changes"}
          </Button>
        )}
        {onGitHub && (
          <ButtonLink variant="quiet" href={pr.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </ButtonLink>
        )}
      </Actions>
      {showChanges && live && <ChangeView taskId={task.id} />}
      <Disclosure label={gateLabel(verdict.status)}>
        {verdict.gate.length > 0 && pr.phase === "open" && (
          <ul className="t-checklist" aria-label={byUser ? "Before this pull request can merge" : "Before this pull request merges by itself"}>
            {verdict.gate.map((it) => (
              <li key={it.id} className={it.ok ? "ok" : it.state === "blocked" ? "blocked" : undefined}>
                <span className="t-check" aria-hidden="true">
                  {it.ok ? "✓" : it.state === "blocked" ? "!" : "…"}
                </span>
                <span>
                  <span className="t-check-label">{it.label}</span>
                  <span className="sr-only">{it.ok ? " (met)" : it.state === "blocked" ? " (blocked)" : " (waiting)"}</span>
                  {it.advisory && <span className="muted"> (shown for you; your own merge does not wait for it)</span>}
                  <div className="t-check-detail">{it.detail}</div>
                </span>
              </li>
            ))}
          </ul>
        )}
        <dl className="t-kv">
          <dt>You</dt>
          <dd>
            {auto ? "Merges automatically after an independent review and passing required checks, for exactly the commit shown." : "You merge it, here or on GitHub."}{" "}
            <span className="muted">{pr.policySource === "user" ? "Your choice for this pull request." : "The project's setting."}</span>
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
          <dt>GitHub</dt>
          <dd>
            {pr.number ? `PR #${pr.number}: ` : ""}
            {pr.phase === "merged" ? `merged${pr.observed?.mergedBy ? ` by ${pr.observed.mergedBy}` : ""}` : pr.phase === "closed" ? `closed without merging${pr.observed?.closedBy ? ` by ${pr.observed.closedBy}` : ""}` : observedLine(pr)}
          </dd>
          <dt>Branch</dt>
          <dd className="mono">
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
            {changesText(pr)}
            {pr.changed.workflowHits.length > 0 && <div>Changes CI workflow files: {pr.changed.workflowHits.slice(0, 5).join(", ")}</div>}
            {pr.changed.protectedHits.length > 0 && <div>Touches protected files: {pr.changed.protectedHits.slice(0, 5).join(", ")}</div>}
          </dd>
          <dt>Independent review</dt>
          <dd>
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
                Review task <a href={`#/task/${encodeURIComponent(x.id)}`}>{x.id}</a>{" "}
                <span className="muted">
                  {M.stateLabel(state, x)}
                  {x.reviewTarget?.headSha !== pr.changeSha ? " · for an earlier change, not counted" : ""}
                </span>
              </div>
            ))}
            {repairs.map((x) => (
              <div key={x.id}>
                Fix task <a href={`#/task/${encodeURIComponent(x.id)}`}>{x.id}</a> <span className="muted">{M.stateLabel(state, x)}</span>
              </div>
            ))}
          </dd>
          {checkTasks.length > 0 && (
            <>
              <dt>Service checks</dt>
              <dd>
                {checkTasks.map((x) => (
                  <div key={x.id}>
                    Check task <a href={`#/task/${encodeURIComponent(x.id)}`}>{x.id}</a>{" "}
                    <span className="muted">
                      {M.stateLabel(state, x)}
                      {x.checkTarget?.sha !== pr.changeSha ? " · for an earlier change, not counted" : ""}
                    </span>
                  </div>
                ))}
              </dd>
            </>
          )}
          {reruns.length > 0 && (
            <>
              <dt>Re-runs</dt>
              <dd>
                {reruns.map((u) => (
                  <div key={`${u.opId}:${u.check}`}>
                    {u.refused ? (
                      <>
                        GitHub refused the re-run of {u.check} asked for at {fmtTime(u.at)} (job {u.jobId}): <span className="muted">{u.refused}</span>
                      </>
                    ) : (
                      <>
                        Re-ran {u.check} at {fmtTime(u.at)}: GitHub had cancelled it (job {u.jobId}).{" "}
                        <span className="muted">{pr.op?.id === u.opId ? "Sent; waiting for GitHub to report the new run." : (u.seen ?? 0) >= D.PR_LIMITS.rerunObservations ? "The new run did not appear; judged by what GitHub shows." : ""}</span>
                      </>
                    )}
                  </div>
                ))}
                <div className="muted">
                  {reruns.length} on this head ({cfg.rerunBudget} per check per head); {pr.counters.reruns ?? 0} of {D.PR_LIMITS.reruns} re-runs used for this pull request over all its heads.
                </div>
              </dd>
            </>
          )}
          {pr.message && live && (
            <>
              <dt>Last problem</dt>
              <dd>{pr.message}</dd>
            </>
          )}
        </dl>
        {live && (
          <Actions className="t-list__foot">
            {prOn &&
              !elsewhere &&
              !pr.foreignHead &&
              !pr.closeRequested &&
              (auto ? (
                <Button size="small" disabled={disabled} title="This pull request waits for your Merge instead of merging by itself" onClick={() => void send("setPrPolicy", { taskId: task.id, policy: "hold" })}>
                  You merge this one
                </Button>
              ) : (
                <Button
                  size="small"
                  disabled={disabled}
                  title="Only chooses who merges: the same checks still have to pass for this exact commit"
                  onClick={async () => {
                    if (await confirm(DELIVERY_CONFIRM.mergeAutomatically(pr))) void send("setPrPolicy", { taskId: task.id, policy: "auto" });
                  }}
                >
                  Merge this one automatically
                </Button>
              ))}
            {pr.policySource === "user" && pr.policy !== cfg.merge && (
              <Button size="small" disabled={disabled} onClick={() => void send("setPrPolicy", { taskId: task.id, policy: null })}>
                Follow the project setting
              </Button>
            )}
            {canAskReview && (
              <Button size="small" disabled={disabled} title="One dedicated review task for the change this pull request holds now" onClick={() => void send("requestPrReview", { taskId: task.id })}>
                Ask for a review
              </Button>
            )}
            {pr.changed.workflowHits.length > 0 && !pr.workflowPushAllowed && (
              <Button
                size="small"
                disabled={disabled}
                onClick={async () => {
                  if (await confirm(DELIVERY_CONFIRM.allowWorkflowChange())) void send("allowWorkflowPush", { taskId: task.id });
                }}
              >
                Allow workflow change
              </Button>
            )}
            {!pr.closeRequested && (
              <Button
                size="small"
                variant="danger"
                disabled={disabled}
                onClick={async () => {
                  if (await confirm(DELIVERY_CONFIRM.closePr(pr))) void send("closePr", { taskId: task.id });
                }}
              >
                {pr.phase === "open" ? "Close pull request" : "Abandon delivery"}
              </Button>
            )}
          </Actions>
        )}
      </Disclosure>
    </div>
  );
}

/** Status and flags of a landed item, as chips. */
export function LandedChips({ landed }: { landed: Landed }) {
  return (
    <>
      <Chip tone={landed.status === "unreviewed" ? "you" : landed.status === "reviewed" ? "done" : "neutral"} strong={landed.status === "unreviewed"}>
        {LANDED_STATUS_LABEL[landed.status]}
      </Chip>
      {landed.simulated && <SimulatedChip title="Simulated: nothing was merged on GitHub." />}
      {landed.flags.map((f) => (
        <Chip key={f} tone="fail">
          {LANDED_FLAG_LABEL[f]}
        </Chip>
      ))}
    </>
  );
}

/**
 * One landed item: what landed and the agent reviews in one line, what changed, the actions, then the reviews and
 * your notes behind disclosures. `children` are lines the page adds between what changed and the actions (the
 * task page puts the lead's verification there).
 */
export function LandedSection({ state, task, children }: { state: State; task: Task; children?: React.ReactNode }) {
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
  const reviews = D.landedReviews(state, task);
  const change = M.finalChange(state, task);
  const verdict = landedVerdict(state, task);
  return (
    <div className="k-stack k-stack--tight">
      <p className="t-verdict">
        <span>
          Landed <span title={fmtTime(landed.at)}>{relTime(landed.at)}</span> by {landedWho(landed)}, {landedWhere(landed)}
        </span>
        {verdict.length > 0 && (
          <>
            <span className="t-verdict__sep" aria-hidden="true">
              ·
            </span>
            <Verdict parts={verdict} />
          </>
        )}
        {landed.mainCheck && (
          <Chip tone={landed.mainCheck.state === "success" ? "done" : landed.mainCheck.state === "failure" ? "fail" : "neutral"}>
            after landing: {landed.mainCheck.state === "pending" ? "check still running" : landed.mainCheck.state === "success" ? "check passed" : landed.mainCheck.state === "failure" ? "check failed" : "check not known"}
          </Chip>
        )}
      </p>
      {change && <p className="t-needs__text">{change.summary}</p>}
      {children}
      {landed.followUps.length > 0 && (
        <p className="meta">
          Sent back as{" "}
          {landed.followUps.map((f, i) => {
            const ft = state.tasks.find((x) => x.id === f.taskId);
            return (
              <span key={f.taskId}>
                {i > 0 ? ", " : ""}
                {f.kind === "revert" ? "a revert" : "a fix"}: <a href={`#/task/${encodeURIComponent(f.taskId)}`}>{f.taskId}</a> <span className="muted">({ft ? M.stateLabel(state, ft) : "no longer in this project"})</span>
              </span>
            );
          })}
        </p>
      )}
      <Actions>
        {landed.status === "reviewed" ? (
          <Button disabled={disabled} onClick={() => void send("markLandedReviewed", { taskIds: [task.id], reviewed: false })}>
            Mark as new
          </Button>
        ) : (
          <Button variant="primary" disabled={disabled} onClick={() => void send("markLandedReviewed", { taskIds: [task.id], reviewed: true })}>
            Mark as seen
          </Button>
        )}
        <Button variant="quiet" aria-expanded={sendingBack} onClick={() => setSendingBack(!sendingBack)}>
          Send back…
        </Button>
        <Button variant="quiet" aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}>
          {showChanges ? "Hide changes" : "Show changes"}
        </Button>
        {landed.pr && !landed.simulated && landed.pr.url.startsWith("https://github.com/") && (
          <ButtonLink variant="quiet" href={landed.pr.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </ButtonLink>
        )}
      </Actions>
      {sendingBack && <SendBackForm state={state} task={task} landed={landed} onDone={() => setSendingBack(false)} />}
      {showChanges && <ChangeView taskId={task.id} />}
      <Disclosure label="Agent reviews and checks" count={reviews.length}>
        {reviews.length === 0 && <p className="muted meta">No agent review ran on this task.</p>}
        {reviews.map((r) => (
          <div key={r.artifactId} className="t-decision">
            <p className="t-decision__title">
              {r.stepId} {ROLE_LABEL[r.role]}
              {r.provider ? ` · ${M.providerLabel(r.provider)} · ${r.model}` : ""}{" "}
              <Chip tone={r.openFindings ? "fail" : "done"}>
                {r.openFindings} open finding{r.openFindings === 1 ? "" : "s"}
              </Chip>{" "}
              {r.editedByUser && <Chip strong>edited by you</Chip>}
            </p>
            <p className="t-needs__text">{r.summary}</p>
          </div>
        ))}
        <dl className="t-kv">
          <dt>Commit</dt>
          <dd className="mono">{landed.commit.slice(0, 12)}</dd>
          {landed.checks && landed.checks.length > 0 && (
            <>
              <dt>Checks at merge</dt>
              <dd>{landed.checks.map((c) => `${c.name}: ${(c.conclusion ?? c.status).toLowerCase()}`).join(" · ")}</dd>
            </>
          )}
        </dl>
      </Disclosure>
      <Disclosure label="Your notes" count={landed.notes.length}>
        {landed.notes.length === 0 && <p className="muted meta">No notes yet.</p>}
        <ul className="t-list">
          {landed.notes.map((n) => (
            <li key={n.id}>
              <span className="t-notes__text">{n.text}</span>{" "}
              <span className="muted small" title={fmtTime(n.at)}>
                · {relTime(n.at)}
              </span>{" "}
              {n.comment && (
                <Chip tone={n.comment.status === "failed" ? "fail" : "neutral"} title={n.comment.error}>
                  {n.comment.status === "posted" ? "posted on GitHub" : n.comment.status === "pending" ? (postBlocked ? "not posted: pull-request delivery is off" : "waiting to post on GitHub") : "not posted on GitHub"}
                </Chip>
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
                  <Button size="small" disabled={disabled} onClick={() => void send("retryLandedComment", { taskId: task.id, noteId: n.id })}>
                    Try posting again
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        <form
          className="t-panel"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await send("addLandedNote", { taskId: task.id, text: note, postToGitHub: canPost && post });
            if (r.ok) {
              setNote("");
              setPost(false);
            }
          }}
        >
          <Field label="Add a note" hint="Notes stay in Orchestrator unless you choose to post one. A note does not mark the item as seen.">
            <Textarea value={note} maxLength={D.MAX_NOTE_CHARS} onChange={(e) => setNote(e.target.value)} rows={3} />
          </Field>
          {couldPost && (
            <Checkbox
              checked={canPost && post}
              disabled={!canPost}
              onChange={(e) => setPost(e.target.checked)}
              label={`Also post this note as a comment on PR #${landed.pr!.number}, under your GitHub account (public if the repository is public)`}
              hint={!canPost ? `Not available now: ${postBlocked}` : undefined}
            />
          )}
          <Actions>
            <Button type="submit" size="small" disabled={disabled || !note.trim()}>
              Save note
            </Button>
          </Actions>
        </form>
      </Disclosure>
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
      className="t-panel"
      aria-labelledby={`sendback-${task.id}`}
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
      <h3 id={`sendback-${task.id}`}>Send {task.id} back</h3>
      <fieldset className="plain-fieldset">
        <label className="choice-radio">
          <input type="radio" name={`kind-${task.id}`} checked={kind === "fix"} onChange={() => setKind("fix")} />
          <span>
            <strong>As a fix:</strong> a new task corrects the problem on top of what landed.
          </span>
        </label>
        <label className="choice-radio">
          <input type="radio" name={`kind-${task.id}`} checked={kind === "revert"} onChange={() => setKind("revert")} />
          <span>
            <strong>As a revert:</strong> a new task undoes commit <span className="mono">{landed.commit.slice(0, 12)}</span> and keeps later work.
          </span>
        </label>
      </fieldset>
      <Field label={kind === "fix" ? "What needs fixing (becomes the task's specification)" : "Why (optional)"} error={blocked && kind === "revert" ? blocked : undefined}>
        <Textarea value={note} maxLength={D.MAX_NOTE_CHARS} onChange={(e) => setNote(e.target.value)} rows={3} />
      </Field>
      <Checkbox checked={hold} onChange={(e) => setHold(e.target.checked)} label="Wait for my go-ahead" hint="Nothing starts on the new task until you press Start" />
      <p className="muted meta">The new task runs through the normal pipeline: it is reviewed and delivered like any other. Nothing is undone until that task lands.</p>
      <Actions>
        <Button type="submit" variant="primary" disabled={disabled || busy || !!blocked} disabledReason={blocked ?? undefined} loading={busy}>
          {kind === "fix" ? "Create fix task" : "Create revert task"}
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </Actions>
    </form>
  );
}
