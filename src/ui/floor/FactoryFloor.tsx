// The factory floor (ORC-029 pass 6, screen 8 of the pass 1 prototype): Home after the start, under Needs you. The open
// change orders the lead is answering, the two budgets, one line per area with each task at its station, and the
// trade-off calls the PE made within budget, each with Reverse and its reasons. The words are floorView.ts's.

import { useState } from "react";
import { changeOrderHref, changeOrderLine } from "../changeOrder/changeOrderView";
import { Banner, Button, ButtonLink, Card, Chip, Disclosure, EmptyState, Field, Input, Row, Rows, StatePill } from "../kit";
import { cx } from "../kit/cx";
import { useStore } from "../store";
import * as V from "./floorView";
import "./floor.css";
import type { State } from "../../domain/types";

/** The floor, in the order the owner reads it after Needs you. */
export function FactoryFloor() {
  const { state } = useStore();
  return (
    <>
      <ChangeOrdersInMotion state={state} />
      <Budgets state={state} />
      <Lines state={state} />
      <PeCalls state={state} />
    </>
  );
}

// ---------- change orders ----------

/** Each open change order the lead is answering, with the way to its screen. One that waits for you is under Needs you. */
function ChangeOrdersInMotion({ state }: { state: State }) {
  return (
    <>
      {V.changeOrdersInMotion(state).map((co) => {
        const l = changeOrderLine(state, co);
        return (
          <Banner
            key={co.rev}
            tone="info"
            title={l.title}
            actions={
              <ButtonLink size="small" href={changeOrderHref(co.rev)}>
                Open the change order
              </ButtonLink>
            }
          >
            {l.text} The tasks it touches are marked below.
          </Banner>
        );
      })}
    </>
  );
}

// ---------- the two budgets ----------

function Budgets({ state }: { state: State }) {
  const w = V.budgetWords(state);
  const b = w.building;
  return (
    <div className="k-grid-2 ff-budgets">
      <Card
        title="Building budget"
        actions={
          <ButtonLink size="small" variant="quiet" href="#/settings/project">
            Change
          </ButtonLink>
        }
      >
        <p className="ff-figure">{b.spent}</p>
        {b.unknown && <p className="small no-margin">{b.unknown}</p>}
        <p className="small no-margin">{b.estimate}</p>
        {b.committed && <p className="small muted no-margin">{b.committed}</p>}
        <p className="ff-stop small">
          <StatePill tone={b.stop.tone}>{b.stop.word}</StatePill>
          <span className="muted">{b.stop.text}</span>
        </p>
      </Card>
      <Card title="Maintenance budget, estimated">
        <p className="ff-figure">{w.maintenance.estimate}</p>
        <p className="small muted no-margin">{w.maintenance.basis}</p>
      </Card>
    </div>
  );
}

// ---------- one line per area ----------

const STATION_WORD: Record<V.Station, string> = { waiting: "waiting", building: "building", review: "review", checks: "checks", evidence: "evidence", finished: "finished", landed: "landed" };

function Lines({ state }: { state: State }) {
  const lines = V.floorLines(state);
  return (
    <Card
      title="The factory"
      actions={
        <ButtonLink size="small" href="#/tasks">
          All tasks
        </ButtonLink>
      }
    >
      {lines.length === 0 ? (
        <EmptyState title="No tasks yet.">The lead plans the tasks from the blueprint. Each area gets its own line here.</EmptyState>
      ) : (
        <>
          <p className="small muted no-margin">One line per area. Each task moves along its steps: building, review, checks, evidence, landed.</p>
          <ul className="ff-lines">
            {lines.map((l) => (
              <li key={l.area} className="ff-line">
                <a className="ff-line__area" href={l.href} title={`Open the tasks of ${l.area}`}>
                  <b>{l.area}</b>
                  <span className="small muted">{l.counts}</span>
                </a>
                <ul className="ff-belt" aria-label={`${l.area}: ${l.counts}`}>
                  {l.tasks.map((t) => (
                    <li key={t.id}>
                      <a className={cx("ff-job", t.moving && "ff-job--moving", t.station === "landed" && "ff-job--landed", (t.needsYou || t.changeOrder !== undefined) && "ff-job--you")} href={t.href} title={t.line}>
                        <StatePill tone={t.tone} pulse={t.moving}>
                          {STATION_WORD[t.station]}
                        </StatePill>
                        <span className="ff-job__name">
                          <span className="mono">{t.id}</span> {t.title}
                        </span>
                        {t.changeOrder !== undefined && (
                          <Chip tone="you" title={`Change order ${t.changeOrder} touches this task`}>
                            change order
                          </Chip>
                        )}
                        {t.needsYou && (
                          <Chip tone="you" title={`It waits for you to ${t.needsYou}`}>
                            needs you
                          </Chip>
                        )}
                      </a>
                    </li>
                  ))}
                  {l.more > 0 && (
                    <li>
                      <a className="ff-job ff-job--more" href={l.href}>
                        +{l.more} more
                      </a>
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ---------- decided by the PE ----------

/** At most this many calls show; the rest are on the tasks' pages. */
const SHOWN_CALLS = 5;

function PeCalls({ state }: { state: State }) {
  const calls = V.peCalls(state);
  if (!calls.length) return null;
  const shown = calls.slice(0, SHOWN_CALLS);
  return (
    <Card title="Decided by the PE" count={calls.length}>
      <p className="small muted no-margin">Trade-off calls the PE made within your budget. A call that would go past a budget comes to you.</p>
      <Rows label="Decided by the PE">
        {shown.map((c) => (
          <PeCallRow key={c.decisionId} call={c} />
        ))}
      </Rows>
      {calls.length > shown.length && <p className="small muted no-margin">{calls.length - shown.length} more on the tasks' pages.</p>}
    </Card>
  );
}

/**
 * One PE call: the task, the finding and the call; Reverse asks why, then opens the decision again for you (it moves to
 * Needs you); "See the reasons" shows the PE's reasons and the call's cost.
 */
function PeCallRow({ call: c }: { call: V.PeCallWords }) {
  const { send, disabled } = useStore();
  const [reversing, setReversing] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const reverse = async () => {
    const cmd = V.reverseCommand(c.decisionId, why.trim());
    setBusy(true);
    const r = await send(cmd.name, cmd.args);
    setBusy(false);
    if (r.ok) {
      setReversing(false);
      setWhy("");
    }
  };
  return (
    <Row
      as="li"
      id={c.taskId}
      title={c.taskTitle}
      href={c.href}
      meta={
        <>
          <span className="k-row__what">{c.call}:</span>
          <span>{c.finding}</span>
          <span className="muted">· {c.when}</span>
        </>
      }
      actions={
        <>
          <Button size="small" disabled={disabled || busy || !!c.locked} aria-pressed={reversing ? true : undefined} title={c.locked ?? "Open the decision again: it comes to you under Needs you"} onClick={() => setReversing(true)}>
            Reverse
          </Button>
        </>
      }
    >
      <Disclosure label="See the reasons" className="ff-reasons">
        <p className="small no-margin">The PE: “{c.why}”</p>
        <p className="small muted no-margin">Cost: {c.cost}.</p>
      </Disclosure>
      {reversing && (
        <form
          className="needs-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (why.trim()) void reverse();
          }}
        >
          <Field label="Why do you reverse it? (kept in the decision record)" width="medium" hint="The decision opens again and comes to you under Needs you.">
            <Input type="text" value={why} onChange={(e) => setWhy(e.target.value)} autoFocus required />
          </Field>
          <div className="k-actions">
            <Button type="submit" size="small" variant="primary" disabled={disabled || busy || !why.trim()}>
              Reverse the call
            </Button>
            <Button size="small" variant="quiet" onClick={() => setReversing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Row>
  );
}
