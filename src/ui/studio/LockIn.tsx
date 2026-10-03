// The Lock in summary (ORC-029 pass 5, screen 3), `#/vision/lock-in`: before a Lock in, one screen says what it does:
// what changes, the tasks it touches, the new work, the budgets, and what stays open. Only you lock in, and your
// agreement is recorded with this summary. The Lock in names the draft revision this screen showed; when the draft
// changes while you read, the screen says so, shows the new summary, and clears your agreement.

import { useEffect, useState } from "react";
import * as B from "../../domain/studio/blueprint";
import { Banner, ButtonLink, Button, Card, Checkbox, Chip, EmptyState, Row, Rows } from "../kit";
import { changeOrderHref } from "../changeOrder/changeOrderView";
import { useStore } from "../store";
import { ChangeLines } from "./Draft";
import { lockInBlocker } from "./draftView";
import { lockInRequest, lockInWords, whoActsNext } from "./lockInView";
import "./studio.css";

export function LockInPage() {
  const { state, send, disabled } = useStore();
  const rev = B.draftRev(state);
  /** The draft revision this screen shows, which the Lock in names. */
  const [seen, setSeen] = useState(rev);
  const [agreed, setAgreed] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The Lock in this screen made: its revision. */
  const [done, setDone] = useState<number | null>(null);
  // The draft changed under the summary (another tab, a round approval, a refused stale Lock in): show the new one.
  useEffect(() => {
    if (rev === seen || busy || done !== null) return;
    setSeen(rev);
    setAgreed(false);
    setStale(true);
  }, [rev, seen, busy, done]);

  const w = lockInWords(state);
  const blocker = lockInBlocker(state);
  const submit = async () => {
    if (!agreed || busy || seen !== rev) return;
    const req = lockInRequest(seen);
    setBusy(true);
    const r = await send(req.name, req.args);
    if (r.ok) setDone(w.rev);
    setBusy(false);
  };

  return (
    <div className="k-stack st-lockin">
      <header>
        <p className="small muted no-margin">
          <a href="#/vision">Vision</a> › Review and lock in
        </p>
        <h1 className="no-margin">{done !== null ? `Lock in ${done}` : `Lock in ${w.rev} · the summary`}</h1>
      </header>
      {done !== null ? (
        <Done rev={done} />
      ) : (
        <>
          {stale && (
            <Banner tone="you" title="The draft changed while you read the summary.">
              This is the new summary. Read it again, and agree again to lock it in.
            </Banner>
          )}
          <div className="st-lockin__grid">
            <Card title={w.changes ? w.heading : "Nothing to lock in"} className="st-lockin__sum">
              {w.changes === 0 ? (
                <EmptyState title="The draft has no change to put into force.">{blocker}</EmptyState>
              ) : (
                <>
                  <section aria-labelledby="li-changes">
                    <h3 id="li-changes">What changes</h3>
                    <ChangeLines lines={w.changeLines} label="What changes" />
                  </section>
                  <section aria-labelledby="li-tasks">
                    <h3 id="li-tasks">The tasks it touches</h3>
                    {w.tasks.length ? (
                      <Rows label="The tasks it touches">
                        {w.tasks.map((t) => (
                          <Row as="li" key={t.taskId} id={t.taskId} title={t.title} href={`#/task/${encodeURIComponent(t.taskId)}`} meta={<><Chip tone={t.tag.tone}>{t.tag.word}</Chip><span>{t.state}</span></>}>
                            <p className="small no-margin">{t.why}</p>
                          </Row>
                        ))}
                      </Rows>
                    ) : (
                      <p className="small muted">No task cites what changes.</p>
                    )}
                  </section>
                  <section aria-labelledby="li-new">
                    <h3 id="li-new">New work</h3>
                    <p className="small">{w.newWork ?? "None: every added part has a task already, or nothing is added."}</p>
                  </section>
                  <section aria-labelledby="li-budgets">
                    <h3 id="li-budgets">The budgets</h3>
                    <ul className="st-lockin__list small">
                      <li>{w.building}</li>
                      <li>
                        {w.estimate.total}
                        {w.estimate.lines.length > 0 && (
                          <ul>
                            {w.estimate.lines.map((l) => (
                              <li key={l}>{l}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                      <li>{w.maintenance}</li>
                    </ul>
                  </section>
                </>
              )}
              <section aria-labelledby="li-open">
                <h3 id="li-open">What stays open</h3>
                {w.openLines.length ? <ChangeLines lines={w.openLines} label="What stays open" /> : <p className="small muted">Nothing: every part of the draft is settled.</p>}
              </section>
              {w.changes > 0 && <Agree words={w.agreement} button={w.button} agreed={agreed} onAgree={(v) => (setAgreed(v), setStale(false))} blocker={disabled ? "The service is offline." : blocker} busy={busy} onLockIn={() => void submit()} />}
            </Card>
            <Card title="Who acts next (your settings)" as="h3" className="st-lockin__side">
              <ul className="st-lockin__list small">
                {whoActsNext(state).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="small no-margin">
                <a href="#/settings">Change them in Settings</a>
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/** Your agreement, then Lock in; or, in Vision, where Start the factory is the first Lock in, a way there. */
function Agree({ words, button, agreed, onAgree, blocker, busy, onLockIn }: { words: string; button: string; agreed: boolean; onAgree: (v: boolean) => void; blocker: string | undefined; busy: boolean; onLockIn: () => void }) {
  const { state } = useStore();
  if (state.project.stage === "shaping") {
    return (
      <Banner tone="info" title="In Vision, Start the factory is your first Lock in." actions={<ButtonLink size="small" variant="primary" href="#/overview">Go to Start the factory</ButtonLink>}>
        It puts these changes into force, with the settings it shows you on Home.
      </Banner>
    );
  }
  return (
    <div className="k-stack k-stack--tight st-lockin__agree">
      <Checkbox label={words} checked={agreed} onChange={(e) => onAgree(e.target.checked)} disabled={!!blocker} />
      <div className="k-actions">
        <Button variant="primary" disabled={!agreed || !!blocker} disabledReason={blocker ?? (!agreed ? "Tick the box first: your agreement is recorded with this summary." : undefined)} showReason={!!blocker} loading={busy} onClick={onLockIn}>
          {busy ? "Locking in…" : button}
        </Button>
        <ButtonLink variant="quiet" href="#/vision">
          Not yet
        </ButtonLink>
      </div>
    </div>
  );
}

/** After the Lock in: what is in force now, and what the lead does next. */
function Done({ rev }: { rev: number }) {
  const { state } = useStore();
  const order = state.blueprint.changeOrders.find((c) => c.rev === rev);
  return (
    <Banner
      tone="done"
      title={`Locked in, as Lock in ${rev}.`}
      actions={
        <>
          {order ? (
            <ButtonLink size="small" variant="primary" href={changeOrderHref(order.rev)}>
              Open change order {order.rev}
            </ButtonLink>
          ) : (
            <ButtonLink size="small" href="#/tasks">
              Open the tasks
            </ButtonLink>
          )}
          <ButtonLink size="small" variant="quiet" href="#/vision">
            Back to the studio
          </ButtonLink>
        </>
      }
    >
      The factory now builds from Lock in {rev}.{" "}
      {order
        ? order.handler === "user"
          ? `The lead plans the updates to the tasks as change order ${rev}. Each update waits for your go-ahead there.`
          : `The lead adjusts the tasks as change order ${rev}. You can undo each update there.`
        : B.blueprintRev(state) >= rev
          ? "No task cites what changed and nothing new is to be built, so there is no change order."
          : ""}
    </Banner>
  );
}
