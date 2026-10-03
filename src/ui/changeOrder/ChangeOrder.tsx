// The change order (ORC-029 pass 5, screen 4), `#/tasks/change-order/<n>`: after a Lock in, the lead's updates to the
// factory's tasks, one row each, in the design's words: what it does, why, its work's PE review, and Undo (or Apply
// and Dismiss under "ask me first"). Then the tasks it did not touch, the notes on what the domain refused, Close it
// as it stands when it waits for you, and its record once closed. The words come from changeOrderView.ts; every
// control is the steering command on the line's row, or closeChangeOrder.

import { useState } from "react";
import { Banner, Button, ButtonLink, Card, Chip, Disclosure, EmptyState, Row, Rows, SimulatedChip, StatePill, useConfirm } from "../kit";
import { useStore } from "../store";
import { changeOrderHref, changeOrderLine, changeOrderWords, openChangeOrdersNewestFirst, type LineWords } from "./changeOrderView";
import "./changeOrder.css";

type Act = { name: "undoSteering" | "applySteering" | "dismissSteering"; args: { changeSetId: string; changeId: string } } | { name: "closeChangeOrder"; args: { rev: number } };

export function ChangeOrderPage({ rev }: { rev: number }) {
  const { state, service, send, disabled } = useStore();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const co = state.blueprint.changeOrders.find((c) => c.rev === rev);
  const crumbs = (
    <p className="small muted no-margin">
      <a href="#/tasks">Tasks</a> › Change order {rev}
    </p>
  );
  if (!co) {
    return (
      <div className="k-stack co-page">
        <header>{crumbs}</header>
        <EmptyState
          title={`There is no change order ${rev}.`}
          action={
            <ButtonLink size="small" href="#/tasks">
              Open the tasks
            </ButtonLink>
          }
        >
          A Lock in while the factory runs makes a change order when it touches a task or brings new work.
        </EmptyState>
      </div>
    );
  }
  const w = changeOrderWords(state, co);
  const off = disabled || busy !== null;
  const run = async (key: string, a: Act) => {
    setBusy(key);
    await send(a.name, a.args);
    setBusy(null);
  };
  const close = async () => {
    if (w.waits && (await confirm(w.waits.confirm))) void run("close", { name: "closeChangeOrder", args: { rev } });
  };
  const undo = async (l: LineWords) => {
    if (l.undoConfirm && !(await confirm(l.undoConfirm))) return;
    void run(l.changeId, { name: "undoSteering", args: { changeSetId: l.changeSetId, changeId: l.changeId } });
  };

  return (
    <div className="k-stack co-page">
      <header className="k-stack k-stack--tight">
        {crumbs}
        <h1 className="no-margin">{w.heading}</h1>
        <p className="small muted no-margin">{w.context}</p>
      </header>
      {w.waits && (
        <Banner
          tone="you"
          title="It waits for you."
          actions={
            <Button size="small" disabled={off} loading={busy === "close"} onClick={() => void close()}>
              Close it as it stands
            </Button>
          }
        >
          {w.waits.words} {w.lines.some((l) => l.actions === "apply") ? "Apply or dismiss each update below that waits for you, or close it as it stands." : "Close it as it stands, or message the lead."}
        </Banner>
      )}
      <Card
        title={w.summary}
        actions={
          <>
            <StatePill tone={w.status.tone}>{w.status.word}</StatePill>
            {w.lead && <Chip>{w.lead.word}</Chip>}
            {w.lead?.simulated && service.runtime !== "fake" && <SimulatedChip title="Simulated: written by the demo's lead, not by a model." />}
          </>
        }
      >
        {w.lines.length > 0 && (
          <Rows label="The lead's updates">
            {w.lines.map((l) => (
              <LineRow key={l.changeId} l={l} off={off} busy={busy === l.changeId} onUndo={() => void undo(l)} onApply={() => void run(l.changeId, { name: "applySteering", args: { changeSetId: l.changeSetId, changeId: l.changeId } })} onDismiss={() => void run(l.changeId, { name: "dismissSteering", args: { changeSetId: l.changeSetId, changeId: l.changeId } })} />
            ))}
          </Rows>
        )}
        {w.untouched && <p className="small muted no-margin">{w.untouched}</p>}
      </Card>
      {w.notes.length > 0 && (
        <Card title="Notes on the lead's answer" as="h2" count={w.notes.length}>
          <p className="small no-margin">The service checks each update against the tasks as they are now. It refused these updates, or the lead left these out.</p>
          <ul className="co-list small" aria-label="Notes on the lead's answer">
            {w.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Card>
      )}
      {w.closed && (
        <Card title={`Closed ${w.closed.when}`} as="h2">
          <Disclosure label="The record: what was done when it closed" count={w.closed.record.length} defaultOpen={w.closed.adds}>
            <p className="small no-margin">The rows above show each update as it is now.</p>
            <ul className="co-list small" aria-label="The record">
              {w.closed.record.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </Disclosure>
        </Card>
      )}
      {w.others.length > 0 && (
        <p className="small muted no-margin">
          Other change orders:{" "}
          {w.others.map((o, i) => (
            <span key={o.rev}>
              {i > 0 && " · "}
              <a href={o.href}>
                {o.rev} ({o.status})
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** One of the lead's updates: its kind and what it does, its state, the task, why, and what you can do. */
function LineRow({ l, off, busy, onUndo, onApply, onDismiss }: { l: LineWords; off: boolean; busy: boolean; onUndo: () => void; onApply: () => void; onDismiss: () => void }) {
  return (
    <Row
      as="li"
      className="co-row"
      title={
        <>
          <Chip tone={l.kind.tone}>{l.kind.word}</Chip> {l.text}
        </>
      }
      meta={
        <>
          {l.state && <StatePill tone={l.state.tone}>{l.state.word}</StatePill>}
          {l.task && <a href={`#/task/${encodeURIComponent(l.task.id)}`}>{`${l.task.id} ${l.task.title}`}</a>}
          <span>{l.when}</span>
        </>
      }
      actions={
        l.actions === "undo" ? (
          <Button size="small" variant="quiet" disabled={off} loading={busy} onClick={onUndo}>
            Undo
          </Button>
        ) : l.actions === "apply" ? (
          <>
            <Button size="small" disabled={off} loading={busy} onClick={onApply}>
              Apply
            </Button>
            <Button size="small" variant="quiet" disabled={off} onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        ) : undefined
      }
    >
      {l.why && <p className="small no-margin">The lead: “{l.why}”</p>}
      {l.state?.detail && <p className="small muted no-margin">{l.state.detail}</p>}
      {l.left && l.actions !== "none" && <p className="small no-margin co-left">Left as is: {l.left}</p>}
    </Row>
  );
}

/** On the Tasks page: each open change order in one line, with a way to it. */
export function ChangeOrderBanners() {
  const { state } = useStore();
  const open = openChangeOrdersNewestFirst(state);
  if (!open.length) return null;
  return (
    <>
      {open.map((co) => {
        const l = changeOrderLine(state, co);
        return (
          <Banner
            key={co.rev}
            tone={l.tone}
            title={l.title}
            actions={
              <ButtonLink size="small" href={changeOrderHref(co.rev)}>
                Open it
              </ButtonLink>
            }
          >
            {l.text}
          </Banner>
        );
      })}
    </>
  );
}
