// Tasks created by this task's breakdown steps (a Goal), each with its state.

import * as M from "../../domain/model";
import type { Artifact, State, Task } from "../../domain/types";
import { taskTone } from "../common";
import { childrenOfArtifact, isSettledTask } from "../fanout";
import { Card, Chip, Disclosure, EmptyState, Row, Rows, StatePill } from "../kit";

export function ChildLink({ state, child }: { state: State; child: Task }) {
  const tone = taskTone(state, child);
  return (
    <>
      <span className="k-row__id">{child.id}</span>
      <a href={`#/task/${encodeURIComponent(child.id)}`}>{M.currentSpec(child).content.title}</a>{" "}
      <StatePill tone={tone.tone} paused={tone.paused} pulse={tone.pulse}>
        {M.stateLabel(state, child)}
      </StatePill>
    </>
  );
}

export function ChildTasksCard({ state, task }: { state: State; task: Task }) {
  const all = M.childTasks(state, task);
  // Children of a breakdown made under an earlier flow stay listed, labelled; the new steps never wait for or reuse them.
  const children = all.filter((c) => !M.childFromEarlierFlow(state, task, c));
  const earlier = all.filter((c) => M.childFromEarlierFlow(state, task, c));
  const plansBreakdown = task.steps.some((st) => st.outputs.some((o) => o.kind === "breakdown"));
  if (!all.length && !plansBreakdown) return null;
  const finished = children.filter(isSettledTask);
  const cancelled = children.filter((c) => c.lifecycle === "cancelled").length;
  return (
    <Card title="Child tasks" className="t-children" actions={children.length > 0 && <Chip>{`${finished.length} of ${children.length} finished${cancelled ? ` (${cancelled} cancelled)` : ""}`}</Chip>}>
      {!children.length ? (
        <EmptyState title={`None yet${earlier.length ? " under the current flow" : ""}.`}>When a breakdown step completes, each item it lists becomes a child task here.</EmptyState>
      ) : (
        <Rows label={`Child tasks of ${task.id}`}>
          {children.map((c) => (
            <Row key={c.id} as="li" title={<ChildLink state={state} child={c} />} />
          ))}
        </Rows>
      )}
      {earlier.length > 0 && (
        <Disclosure label="From an earlier flow" count={earlier.length}>
          <p className="meta muted">Created by a breakdown before this task's flow changed. They stay on the record; the current steps do not wait for them or plan from them.</p>
          <Rows label={`Child tasks of ${task.id} from an earlier flow`}>
            {earlier.map((c) => (
              <Row key={c.id} as="li" title={<ChildLink state={state} child={c} />} meta={<Chip title="Its breakdown was made under a flow this task has since left">from an earlier flow</Chip>} />
            ))}
          </Rows>
        </Disclosure>
      )}
    </Card>
  );
}

/** The child tasks one breakdown version created. */
export function BreakdownChildren({ state, task, artifact }: { state: State; task: Task; artifact: Artifact }) {
  const children = childrenOfArtifact(state, task, artifact);
  if (!children.length) return <p className="muted small">{artifact.author === "user" ? "Your edit did not create child tasks." : "No child tasks came from this version."}</p>;
  return (
    <div className="small">
      Created {children.length} child task{children.length === 1 ? "" : "s"}:
      <ul className="plain">
        {children.map((c) => (
          <li key={c.id}>
            <ChildLink state={state} child={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}
