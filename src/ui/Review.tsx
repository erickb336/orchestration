// The Results page (`#/review` still opens it). First the pull requests that wait for you, each with
// its verdict line, Merge and Keep for me, and "Why it's ready" (the PrPanel in Delivery.tsx); then New results: work that
// landed and you have not marked as seen, with one Mark as seen and one Send back… per item and its details in
// place. Pull requests still on their way, and closed ones, come last. The landed list never blocks anything, and an
// item counts as seen only through Mark as seen, never by opening it.

import { useState } from "react";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import type { State, Task } from "../domain/types";
import { fmtTime, relTime } from "./common";
import { ChangeView, LandedChips, PrChip, PrPanel, SendBackForm, Verdict } from "./Delivery";
import { DELIVERY_CONFIRM, LANDED_FLAG_LABEL, landedVerdict, landedWhere, landedWho } from "./deliveryView";
import { Actions, Banner, Button, ButtonLink, Card, Chip, Disclosure, EmptyState, Row, Rows, SegmentedControl, SimulatedChip, useConfirm } from "./kit";
import { BULK_LIMIT, FILTER_LABEL, FILTER_TITLE, bulkLabel, emptyText, matchesFilter, prLists, reviewsLine, showBulk, type ResultsFilter } from "./resultsView";
import { useStore } from "./store";
import { ResultsTabs } from "./studio/Reality";
import { ago } from "./tasksView";
import "./task/task.css";
import "./results.css";

const taskHref = (t: Task) => `#/task/${encodeURIComponent(t.id)}`;
const titleOf = (t: Task) => M.currentSpec(t).content.title;
const FILTERS: ResultsFilter[] = ["new", "all", "sent-back"];

export function Review() {
  const { state, service, send, disabled } = useStore();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<ResultsFilter>("new");
  const now = Date.now();
  const gh = state.project.github;
  const mode = D.deliveryMode(state);
  const prs = prLists(state, now);
  const showGitHub = mode === "pr" || prs.problems.length + prs.ready.length + prs.onTheirWay.length > 0;
  const landed = D.landedTasks(state);
  const fresh = landed.filter((t) => t.integration!.landed!.status === "unreviewed");
  const shown = landed.filter((t) => matchesFilter(t.integration!.landed!, filter));
  const others = [...prs.onTheirWay, ...prs.closed];
  const empty = emptyText(state, filter, service.runtime);

  return (
    <div className="k-stack r-page">
      <h1>Results</h1>
      <ResultsTabs value="work" />

      {showGitHub && gh?.problem && (
        <Banner
          tone="fail"
          title="GitHub delivery is stopped."
          actions={
            <Button size="small" disabled={disabled} loading={!!gh.recheck} onClick={() => void send("recheckGitHub")}>
              {gh.recheck ? "Checking…" : "Check again"}
            </Button>
          }
        >
          {gh.problem.message} <span className="muted">Since {fmtTime(gh.problem.since)}; it is checked again by itself.</span>
        </Banner>
      )}
      {showGitHub && state.project.hold && <Banner>Paused: watching GitHub only; nothing will be pushed, opened, merged or commented.</Banner>}
      {showGitHub && gh?.autoMergePaused && (
        <Banner
          tone="fail"
          title="Automatic merging is paused."
          actions={
            <Button
              size="small"
              disabled={disabled}
              onClick={async () => {
                if (await confirm(DELIVERY_CONFIRM.resumeAutoMerge(gh.autoMergePaused?.reason))) void send("resumeAutoMerge");
              }}
            >
              Resume automatic merging
            </Button>
          }
        >
          {gh.autoMergePaused.reason}. {gh.autoMergePaused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again, or when you resume it."} Nothing is reverted automatically: send the
          landed item back as a fix or a revert below if it should be undone.
        </Banner>
      )}

      {prs.problems.length > 0 && (
        <Card title="Pull requests that need you" count={prs.problems.length} countTone="you">
          <Rows label="Pull requests that need you">
            {prs.problems.map((t) => (
              <PrRow key={t.id} state={state} task={t} />
            ))}
          </Rows>
        </Card>
      )}

      {showGitHub && (
        <Card title="Ready to merge" count={prs.ready.length} countTone={prs.ready.length ? "you" : "neutral"}>
          {prs.ready.length === 0 ? (
            <EmptyState title="No pull request is waiting for you.">{others.length ? "The ones still on their way are listed at the end of this page." : undefined}</EmptyState>
          ) : (
            <Rows label="Pull requests ready to merge">
              {prs.ready.map((t) => (
                <PrRow key={t.id} state={state} task={t} />
              ))}
            </Rows>
          )}
          {gh && !gh.simulated && (
            <p className="small muted r-foot">
              The app opens and watches pull requests only while this service is running.{gh.observedAt ? ` GitHub was last read ${relTime(gh.observedAt)}.` : ""}
            </p>
          )}
        </Card>
      )}

      <Card
        title={FILTER_TITLE[filter]}
        count={shown.length}
        actions={
          landed.length > 0 && (
            <>
              {filter === "new" && showBulk(fresh.length) && (
                <Button
                  size="small"
                  variant="quiet"
                  disabled={disabled}
                  onClick={async () => {
                    const ids = fresh.slice(0, BULK_LIMIT).map((t) => t.id);
                    const ok = await confirm({ title: `Mark ${ids.length} results as seen?`, text: "This only records that you looked at them. Nothing is merged, reverted or sent anywhere.", primaryLabel: "Mark as seen" });
                    if (ok) void send("markLandedReviewed", { taskIds: ids, reviewed: true });
                  }}
                >
                  {bulkLabel(fresh.length)}
                </Button>
              )}
              <SegmentedControl<ResultsFilter> label="Show" size="small" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f, label: FILTER_LABEL[f] }))} />
            </>
          )
        }
      >
        {shown.length === 0 ? (
          <EmptyState title={empty.title}>{empty.text}</EmptyState>
        ) : (
          <Rows label={FILTER_TITLE[filter]}>
            {shown.map((t) => (
              <LandedRow key={t.id} state={state} task={t} filter={filter} nowMs={now} />
            ))}
          </Rows>
        )}
      </Card>

      {others.length > 0 && (
        <Card title="Other pull requests" count={others.length}>
          <Rows label="Other pull requests">
            {prs.onTheirWay.map((t) => (
              <Row key={t.id} as="li" id={t.id} title={titleOf(t)} href={taskHref(t)} meta={<PrChip state={state} task={t} />}>
                {/* One you kept stays open, so "Let it continue" is where you look for it. */}
                <Disclosure label="Details" className="r-details" defaultOpen={!!t.integration?.pr?.userHold}>
                  <PrPanel state={state} task={t} />
                </Disclosure>
              </Row>
            ))}
            {prs.closed.map((t) => (
              <Row
                key={t.id}
                as="li"
                id={t.id}
                title={titleOf(t)}
                href={taskHref(t)}
                meta={
                  <>
                    <PrChip state={state} task={t} />
                    <span>A closed pull request is never reopened; delivering again opens a new one.</span>
                  </>
                }
                actions={
                  mode === "pr" && (
                    <Button size="small" disabled={disabled} onClick={() => void send("redeliver", { taskIds: [t.id] })}>
                      Deliver again
                    </Button>
                  )
                }
              />
            ))}
          </Rows>
        </Card>
      )}
    </div>
  );
}

/** A pull request that waits for you: the task, then the PrPanel (verdict line, Merge, Keep for me, Why it's ready). */
function PrRow({ state, task }: { state: State; task: Task }) {
  return (
    <Row as="li" id={task.id} title={titleOf(task)} href={taskHref(task)} className="r-pr">
      <PrPanel state={state} task={task} />
    </Row>
  );
}

/**
 * One landed item: when it landed and what passed, what it changed, one Mark as seen (or Mark as new) and one
 * Send back…; its details expand in place, with the agent reviews in one line.
 */
function LandedRow({ state, task, filter, nowMs }: { state: State; task: Task; filter: ResultsFilter; nowMs: number }) {
  const { send, disabled } = useStore();
  const [sendingBack, setSendingBack] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const l = task.integration!.landed!;
  const verdict = landedVerdict(state, task);
  const change = M.finalChange(state, task);
  const github = l.pr && !l.simulated && l.pr.url.startsWith("https://github.com/") ? l.pr.url : undefined;
  return (
    <Row
      as="li"
      id={task.id}
      title={titleOf(task)}
      href={taskHref(task)}
      className="r-landed"
      meta={
        <>
          <span title={fmtTime(l.at)}>Landed {ago(l.at, nowMs)}</span>
          {verdict.length > 0 && <Verdict parts={verdict} />}
          {filter === "new" ? (
            <>
              {l.flags.map((f) => (
                <Chip key={f} tone="fail">
                  {LANDED_FLAG_LABEL[f]}
                </Chip>
              ))}
              {l.simulated && <SimulatedChip title="Simulated merge: nothing was sent to GitHub." />}
            </>
          ) : (
            <LandedChips landed={l} />
          )}
        </>
      }
      actions={
        <>
          {l.status === "reviewed" ? (
            <Button size="small" disabled={disabled} onClick={() => void send("markLandedReviewed", { taskIds: [task.id], reviewed: false })}>
              Mark as new
            </Button>
          ) : (
            <Button size="small" disabled={disabled} onClick={() => void send("markLandedReviewed", { taskIds: [task.id], reviewed: true })}>
              Mark as seen
            </Button>
          )}
          <Button size="small" variant="quiet" aria-expanded={sendingBack} onClick={() => setSendingBack(!sendingBack)}>
            Send back…
          </Button>
        </>
      }
    >
      {change && <p className="r-summary" title={change.summary}>{change.summary}</p>}
      <Disclosure label="Details" className="r-details">
        <div className="k-stack k-stack--tight">
          <p className="meta">
            By {landedWho(l)}, {landedWhere(l)} · commit <span className="mono">{l.commit.slice(0, 12)}</span>
          </p>
          <p className="meta">{reviewsLine(D.landedReviews(state, task))}</p>
          {l.checks && l.checks.length > 0 && <p className="meta muted">Checks at merge: {l.checks.map((c) => `${c.name} ${(c.conclusion ?? c.status).toLowerCase()}`).join(" · ")}</p>}
          {l.mainCheck && (
            <p className="meta">
              After landing:{" "}
              {l.mainCheck.state === "pending" ? "the check on the branch is still running." : l.mainCheck.state === "success" ? "the check on the branch passed." : l.mainCheck.state === "failure" ? "the check on the branch failed." : "the check on the branch is not known."}
            </p>
          )}
          {l.followUps.length > 0 && (
            <p className="meta">
              Sent back as{" "}
              {l.followUps.map((f, i) => {
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
            <Button size="small" variant="quiet" aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}>
              {showChanges ? "Hide changes" : "Show changes"}
            </Button>
            {github && (
              <ButtonLink size="small" variant="quiet" href={github} target="_blank" rel="noreferrer">
                Open on GitHub
              </ButtonLink>
            )}
            <ButtonLink size="small" variant="quiet" href={taskHref(task)}>
              Notes and the full record
            </ButtonLink>
          </Actions>
          {showChanges && <ChangeView taskId={task.id} />}
        </div>
      </Disclosure>
      {sendingBack && <SendBackForm state={state} task={task} landed={l} onDone={() => setSendingBack(false)} />}
    </Row>
  );
}
