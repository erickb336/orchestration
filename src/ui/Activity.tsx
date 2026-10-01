import { useState } from "react";
import type { EventKind } from "../domain/types";
import { useStore } from "./store";
import { fmtTime, relTime } from "./common";

const KINDS: { kind: EventKind | ""; label: string }[] = [
  { kind: "", label: "All" },
  { kind: "decision", label: "Decisions" },
  { kind: "spec", label: "Spec revisions" },
  { kind: "control", label: "Controls" },
  { kind: "dispatch", label: "Dispatch" },
  { kind: "runtime", label: "Agent runs" },
  { kind: "integration", label: "Integration" },
  { kind: "blocked", label: "Blockers" },
  { kind: "config", label: "Configuration" },
  { kind: "vision", label: "Vision" },
];

export function Activity() {
  const { state, service } = useStore();
  const [kind, setKind] = useState<EventKind | "">("");
  const [limit, setLimit] = useState(60);
  const events = state.events.filter((e) => !kind || e.kind === kind).reverse();
  return (
    <>
      <h1>Activity</h1>
      <div className="toolbar">
        <label>
          Show
          <select value={kind} onChange={(e) => setKind(e.target.value as EventKind | "")}>
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">Append-only. {service.runtime === "real" ? "Events marked runtime come from the Claude and Codex agents." : "Events marked runtime come from the simulated agents."}</span>
      </div>
      <section className="card">
        <ul className="events">
          {events.slice(0, limit).map((e) => (
            <li key={e.id} style={e.at > state.project.lastVisitAt ? { fontWeight: 520 } : undefined}>
              <span className="muted" title={fmtTime(e.at)}>
                {relTime(e.at)}
              </span>
              <span className="actor">{e.actor}</span>
              <span>
                {e.taskId && (
                  <a href={`#/task/${e.taskId}`} className="mono" style={{ marginRight: "0.4rem" }}>
                    {e.taskId}
                  </a>
                )}
                {e.message}
              </span>
            </li>
          ))}
        </ul>
        {events.length > limit && (
          <button className="small" style={{ marginTop: "0.6rem" }} onClick={() => setLimit(limit + 100)}>
            Show more
          </button>
        )}
      </section>
    </>
  );
}
