// The Activity page (`#/activity`, reached from Tasks › All activity): every event, newest first, filtered by task
// (`#/activity?task=WT-001`) and by kind. The log is the service's own record; who acted and the role names are
// said in words.

import { useEffect, useState } from "react";
import type { EventKind } from "../domain/types";
import { ACTOR_LABEL, KINDS, KIND_LABEL, activityHash, eventText, filterEvents, taskFromHash, taskOptions } from "./activityView";
import { fmtTime, relTime } from "./common";
import { Button, Card, EmptyState, Field, Select } from "./kit";
import { useStore } from "./store";
// The filter bar is the Tasks page's (tl-toolbar).
import "./tasks.css";

const KIND_OPTIONS = [{ value: "", label: "Everything" }, ...KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))];

export function Activity() {
  const { state, service } = useStore();
  const [kind, setKind] = useState<EventKind | "">("");
  const [limit, setLimit] = useState(60);
  const [taskId, setTaskState] = useState(() => taskFromHash(typeof location === "undefined" ? "" : location.hash));
  useEffect(() => {
    const on = () => setTaskState(taskFromHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const setTask = (id: string) => {
    setTaskState(id);
    history.replaceState(null, "", activityHash(id));
  };
  const tasks = taskOptions(state);
  const events = filterEvents(state.events, taskId, kind);
  return (
    <div className="k-stack">
      <h1>Activity</h1>
      <div className="tl-toolbar" role="search" aria-label="Filter activity">
        <Field label="Task">
          <Select value={taskId} onChange={(e) => setTask(e.target.value)}>
            <option value="">All tasks</option>
            {tasks.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
            {taskId && !tasks.some((t) => t.value === taskId) && <option value={taskId}>{taskId}</option>}
          </Select>
        </Field>
        <Field label="Show">
          <Select value={kind} onChange={(e) => setKind(e.target.value as EventKind | "")} options={KIND_OPTIONS} />
        </Field>
      </div>
      <Card>
        {events.length === 0 ? (
          <EmptyState title="Nothing here yet." />
        ) : (
          <ul className="events" aria-label="Events, newest first">
            {events.slice(0, limit).map((e) => (
              <li key={e.id}>
                <span className="muted" title={fmtTime(e.at)}>
                  {relTime(e.at)}
                </span>
                <span className="actor">{ACTOR_LABEL[e.actor] ?? e.actor}</span>
                <span>
                  {e.taskId && !taskId && (
                    <>
                      <a href={`#/task/${encodeURIComponent(e.taskId)}`} className="mono">
                        {e.taskId}
                      </a>{" "}
                    </>
                  )}
                  {eventText(e.message)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {events.length > limit && (
          <Button size="small" variant="quiet" onClick={() => setLimit(limit + 100)}>
            Show more
          </Button>
        )}
      </Card>
      {service.runtime !== "real" && <p className="small muted">In the demo, what the agents report is simulated.</p>}
    </div>
  );
}
