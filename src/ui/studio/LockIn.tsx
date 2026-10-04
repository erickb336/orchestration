// The Lock in summary (ORC-029 pass 5, screen 3), `#/vision/lock-in`: before a Lock in, one screen says what it does:
// what changes, the tasks it touches, the new work, the budgets, and what stays open. Only you lock in, and your
// agreement is recorded with this summary. The Lock in names the draft revision and the digest of the summary this
// screen showed; when the summary changes while you read (the draft, a task, the budgets), the screen says so, shows
// the new summary, and clears your agreement.

import { useEffect, useState } from "react";
import * as B from "../../domain/studio/blueprint";
import { Banner, ButtonLink, Button, Card, Checkbox, Chip, Disclosure, EmptyState, Row, Rows } from "../kit";
import { changeOrderHref } from "../changeOrder/changeOrderView";
import { PREFLIGHT_HASH } from "../preflight/preflightView";
import { useStore } from "../store";
import { ChangeLines } from "./Draft";
import { lockInBlocker } from "./draftView";
import { lockInRequest, lockInWords, whoActsNext, type LockInWords } from "./lockInView";
import "./studio.css";

export function LockInPage() {
  const { state, send, disabled } = useStore();
  const w = lockInWords(state);
  /** The summary this screen shows (its draft revision and digest), which the Lock in names. */
  const [seen, setSeen] = useState<B.SummarySeen>({ draftRev: w.draftRev, summaryDigest: w.summaryDigest });
  const [agreed, setAgreed] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The Lock in this screen made: its revision. */
  const [done, setDone] = useState<number | null>(null);
  // The summary changed under the owner (another tab, a round approval, a task, a budget, a refused stale Lock in):
  // show the new one.
  useEffect(() => {
    if (w.summaryDigest === seen.summaryDigest || busy || done !== null) return;
    setSeen({ draftRev: w.draftRev, summaryDigest: w.summaryDigest });
    setAgreed(false);
    setStale(true);
  }, [w.draftRev, w.summaryDigest, seen, busy, done]);

  const blocker = lockInBlocker(state);
  const submit = async () => {
    if (!agreed || busy || seen.summaryDigest !== w.summaryDigest) return;
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
          <a href="#/vision">Vision</a> › Lock in
        </p>
        <h1 className="no-margin">{done !== null ? `Lock in ${done}` : w.title}</h1>
      </header>
      {done !== null ? (
        <Done rev={done} />
      ) : (
        <>
          {stale && (
            <Banner tone="you" title="The summary changed while you read it.">
              This is the new summary. Read it again, and agree again to lock it in.
            </Banner>
          )}
          <div className="st-lockin__grid">
            <Card title={w.changes ? w.heading : "Nothing to lock in"} className="st-lockin__sum">
              {w.changes === 0 ? (
                <EmptyState title="The draft has no change to put into force.">{blocker}</EmptyState>
              ) : (
                <>
                  <LockInChanges w={w} />
                  <LockInTasks w={w} />
                  <LockInNewWork w={w} />
                  <LockInBudgets w={w} />
                </>
              )}
              <LockInStaysOpen w={w} />
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

// ---------- the summary's parts, shared with the pre-flight (Start the factory is the first Lock in) ----------

/** What changes: each change, and the vision text against the text in force when the draft changes it. */
export function LockInChanges({ w }: { w: LockInWords }) {
  return (
    <section aria-labelledby="li-changes">
      <h3 id="li-changes">What changes</h3>
      <ChangeLines lines={w.changeLines} label="What changes" />
      {w.vision && (
        <Disclosure label={`The vision text: your draft against r${w.vision.replacesRev}, the text in force`} className="st-lockin__vision">
          <p className="small muted no-margin">The lead and the agents read the new text from this Lock in on.</p>
          <div className="diff" aria-label={`The vision text: your draft against r${w.vision.replacesRev}`}>
            {w.vision.diff.map((d, i) => (
              <div key={i} className={d.kind}>
                {d.text}
              </div>
            ))}
          </div>
        </Disclosure>
      )}
    </section>
  );
}

/** The tasks it touches, and what happens to each. */
export function LockInTasks({ w }: { w: LockInWords }) {
  return (
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
  );
}

/** The new work: added parts that no task builds yet. */
export function LockInNewWork({ w }: { w: LockInWords }) {
  return (
    <section aria-labelledby="li-new">
      <h3 id="li-new">New work</h3>
      <p className="small">{w.newWork ?? "None: every added part has a task already, or nothing is added."}</p>
    </section>
  );
}

/** The budgets: the spend against the building budget, the PE's estimate of the changes, and maintenance. */
export function LockInBudgets({ w, title = "The budgets" }: { w: LockInWords; title?: string }) {
  return (
    <section aria-labelledby="li-budgets">
      <h3 id="li-budgets">{title}</h3>
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
  );
}

/** What stays open: the draft's open items, which stay out of the Lock in. */
export function LockInStaysOpen({ w }: { w: LockInWords }) {
  return (
    <section aria-labelledby="li-open">
      <h3 id="li-open">What stays open</h3>
      {w.openLines.length ? <ChangeLines lines={w.openLines} label="What stays open" /> : <p className="small muted">Nothing: every part of the draft is settled.</p>}
    </section>
  );
}

/** Your agreement, then Lock in; or, in Vision, where Start the factory is the first Lock in, a way there. */
function Agree({ words, button, agreed, onAgree, blocker, busy, onLockIn }: { words: string; button: string; agreed: boolean; onAgree: (v: boolean) => void; blocker: string | undefined; busy: boolean; onLockIn: () => void }) {
  const { state } = useStore();
  if (state.project.stage === "shaping") {
    return (
      <Banner tone="info" title="In Vision, Start the factory is your first Lock in." actions={<ButtonLink size="small" variant="primary" href={PREFLIGHT_HASH}>Start the factory…</ButtonLink>}>
        It puts these changes into force, with the settings you choose on its pre-flight.
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
