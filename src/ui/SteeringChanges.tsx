// ORC-009: the change list under a lead reply. The service wrote it; the lead's prose never is the
// record. Every row shows the task's live state, and every control is a keyed, compare-and-set command.

import { useState } from "react";
import { diffLines } from "../domain/diff";
import * as M from "../domain/model";
import type { State, SteeringChange, SteeringChangeSet } from "../domain/types";
import { useStore } from "./store";
import { relTime } from "./common";

type Act = { name: "undoSteering" | "applySteering" | "dismissSteering" | "postMessage"; args: object };

export function SteeringChanges({ set }: { set: SteeringChangeSet }) {
  const { state, send, disabled } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, a: Act) => {
    setBusy(key);
    await send(a.name, a.args);
    setBusy(null);
  };
  const changed = set.changes.filter((c) => c.status === "applied");
  const suggested = set.changes.filter((c) => c.status === "suggested");
  const notChanged = set.changes.filter((c) => c.status === "skipped" || c.status === "rejected");
  const resolved = set.changes.filter((c) => c.status === "undone" || c.status === "dismissed" || c.status === "superseded");
  const off = disabled || busy !== null;
  // Review finding 13: "Ask again" only while the held rows are still open, and never during a lead run
  // (the run in progress already answers the newest message).
  const leadBusy = !!M.activeLeadRun(state);
  // Review finding 3: a drop the user applies is an ordinary cancel with no undo, so it is never Undo-able here.
  const undoable = (c: SteeringChange) => !(c.kind === "drop" && c.appliedBy === "user");
  const applyAll = () => {
    const drops = suggested.filter((c) => c.kind === "drop");
    if (drops.length && !confirmDrops(state, drops)) return;
    void run("apply-all", { name: "applySteering", args: { changeSetId: set.id } });
  };

  if (set.refused) {
    return (
      <div className="msg-extra changes" role="note">
        <div className="banner neutral" style={{ margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
          The lead sent a steering block, but it was not applied: {set.refused}.
        </div>
      </div>
    );
  }
  return (
    <div className="msg-extra changes">
      {set.heldBecause && (
        <div className="banner" style={{ margin: "0.3rem 0", fontSize: "0.85rem" }} role="status">
          Held: {set.heldBecause}{" "}
          {suggested.length > 0 && (
            <button
              className="small"
              disabled={off || leadBusy}
              title={leadBusy ? "The lead is working; its reply decides these" : undefined}
              onClick={() => void run("ask", { name: "postMessage", args: { text: "Please re-apply your last steering." } })}
            >
              Ask again
            </button>
          )}
        </div>
      )}
      {(notChanged.length > 0 || (suggested.length > 0 && !set.heldBecause)) && (
        <div className="muted" style={{ fontSize: "0.82rem", margin: "0.2rem 0" }}>
          Some changes the lead described were not applied. This list, not the reply, is what happened.
        </div>
      )}
      {set.notes.map((n, i) => (
        <div key={i} className="muted" style={{ fontSize: "0.82rem" }}>
          {n}
        </div>
      ))}
      {changed.length > 0 && (
        <Section title="Changed" action={changed.filter(undoable).length > 1 ? <button className="small" disabled={off} onClick={() => void run("undo-all", { name: "undoSteering", args: { changeSetId: set.id } })}>Undo all</button> : undefined}>
          {changed.map((c) => (
            <Row key={c.id} state={state} c={c}>
              {undoable(c) && (
                <button className="small" disabled={off} onClick={() => void run(c.id, { name: "undoSteering", args: { changeSetId: set.id, changeId: c.id } })}>
                  Undo
                </button>
              )}
            </Row>
          ))}
        </Section>
      )}
      {suggested.length > 0 && (
        <Section title="Suggested" action={suggested.length > 1 ? <button className="small" disabled={off} onClick={applyAll}>Apply all</button> : undefined}>
          {suggested.map((c) => (
            <Row key={c.id} state={state} c={c}>
              <button
                className="small"
                disabled={off}
                onClick={() => {
                  if (c.kind === "drop" && !confirmDrops(state, [c])) return;
                  void run(c.id, { name: "applySteering", args: { changeSetId: set.id, changeId: c.id } });
                }}
              >
                Apply
              </button>
              <button className="small" disabled={off} onClick={() => void run(`${c.id}-dismiss`, { name: "dismissSteering", args: { changeSetId: set.id, changeId: c.id } })}>
                Dismiss
              </button>
            </Row>
          ))}
        </Section>
      )}
      {notChanged.length > 0 && (
        <Section title="Not changed">
          {notChanged.map((c) => (
            <Row key={c.id} state={state} c={c} />
          ))}
        </Section>
      )}
      {resolved.length > 0 && (
        <Section title="Undone or dismissed">
          {resolved.map((c) => (
            <Row key={c.id} state={state} c={c} struck />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="changes-section">
      <div className="row" style={{ justifyContent: "space-between", gap: "0.3rem" }}>
        <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 600 }}>
          {title}
        </span>
        {action}
      </div>
      <ul className="plain changes-list">{children}</ul>
    </div>
  );
}

/**
 * A drop the user applies is an ordinary cancel, with no undo: say what each one stops and blocks first.
 * Review finding 3: "Apply all" confirms its drops the same way, in one dialog.
 */
function confirmDrops(state: State, rows: SteeringChange[]): boolean {
  const lines: string[] = [];
  for (const c of rows) {
    const t = state.tasks.find((x) => x.id === c.taskId);
    if (!t) continue;
    const running = M.activeAttempts(state, t.id).length;
    const dependents = state.tasks.filter((x) => x.lifecycle !== "done" && x.lifecycle !== "cancelled" && x.dependsOn.includes(t.id)).map((x) => x.id);
    lines.push([`Cancel ${t.id}?`, running ? `${running} run(s) are stopped (shown as Cancelling until confirmed).` : "", dependents.length ? `${dependents.join(", ")} would be blocked.` : ""].filter(Boolean).join(" "));
  }
  if (!lines.length) return false;
  return confirm([...lines, "A cancel cannot be undone. The spec and partial artifacts are kept."].join("\n"));
}

function Row({ state, c, struck, children }: { state: State; c: SteeringChange; struck?: boolean; children?: React.ReactNode }) {
  const t = c.taskId ? state.tasks.find((x) => x.id === c.taskId) : undefined;
  const resolved = c.resolvedAt ? relTime(c.resolvedAt) : undefined;
  const statusNote =
    c.status === "undone"
      ? `undone by you${resolved ? ` ${resolved}` : ""}`
      : c.status === "dismissed"
        ? `dismissed${resolved ? ` ${resolved}` : ""}`
        : c.status === "superseded"
          ? "superseded by a later reply"
          : c.status === "applied" && c.appliedBy === "user"
            ? `applied by you${resolved ? ` ${resolved}` : ""}`
            : undefined;
  return (
    <li className={`change${struck ? " struck" : ""}`}>
      <div className="row" style={{ gap: "0.35rem", alignItems: "baseline" }}>
        <span className="change-what">
          {c.kind === "focus" ? (
            "Focus"
          ) : (
            <>
              {t ? <a href={`#/task/${encodeURIComponent(t.id)}`}>{t.id}</a> : <span className="mono">{c.taskId ?? "?"}</span>}
              {t && <span className="muted"> {M.currentSpec(t).content.title}</span>}
            </>
          )}
          {": "}
          {c.kind === "priority" && `P${String(c.before ?? "?")} → P${String(c.after ?? "?")} (next free slot; running work continues)`}
          {c.kind === "defer" && "Deferred (after its current step)"}
          {c.kind === "undefer" && "Runs again (deferral lifted)"}
          {c.kind === "drop" && (c.appliedBy === "user" ? "Cancelled" : "Dropped (had not started)")}
          {c.kind === "invalid" && "an entry the service could not read"}
        </span>
        {t && <span className="chip">{M.stateLabel(state, t)}</span>}
        {statusNote && <span className="muted" style={{ fontSize: "0.8rem" }}>{statusNote}</span>}
        {c.note && c.status !== "undone" && c.status !== "applied" && <span className="muted" style={{ fontSize: "0.8rem" }}>— {c.note}</span>}
        {c.note && (c.status === "applied" || c.status === "undone") && <span className="muted" style={{ fontSize: "0.8rem" }}>— {c.note}</span>}
        {children && <span className="row" style={{ gap: "0.3rem", marginLeft: "auto" }}>{children}</span>}
      </div>
      {c.kind === "focus" && <FocusDiff before={String(c.before ?? "")} after={String(c.after ?? "")} />}
      {c.why && (
        <div className="muted change-why" style={{ fontSize: "0.82rem" }}>
          “{c.why}”
        </div>
      )}
    </li>
  );
}

export function FocusDiff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before.split("\n"), after.split("\n"));
  return (
    <div className="diff" style={{ fontSize: "0.78rem", margin: "0.2rem 0" }} aria-label="Focus change">
      {lines.map((d, i) => (
        <div key={i} className={d.kind}>
          {d.text}
        </div>
      ))}
    </div>
  );
}
