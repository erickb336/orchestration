// Details › Spec and options: the options table with their tradeoffs, the acceptance and scope, Edit spec and
// Choose. When the choice is the thing the task waits for, it is taken under Needs you and the table says so.

import * as M from "../../domain/model";
import type { Task } from "../../domain/types";
import { Actions, Button, Chip } from "../kit";
import { OptionChoice } from "./NeedsYou";
import { isOpenTask } from "./needsYouItems";

export function SpecSection({ task, chooseAtTop, onEdit }: { task: Task; chooseAtTop: boolean; onEdit?: () => void }) {
  const spec = M.currentSpec(task);
  const c = spec.content;
  const open = isOpenTask(task);
  const list = (xs: string[]) => (xs.length ? <ul className="plain">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="muted">—</span>);
  return (
    <div className="k-stack k-stack--tight">
      <Actions>
        <span className="small muted">
          Spec r{spec.rev} · {spec.author === "lead" ? "proposed by the lead" : "written by you"}
        </span>
        {open && onEdit && (
          <Button size="small" onClick={onEdit}>
            Edit spec
          </Button>
        )}
      </Actions>
      <h3 className="meta">Options and tradeoffs</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Option</th>
              <th>Benefit</th>
              <th>Effort</th>
              <th>Costs and risks</th>
              <th>Reversibility</th>
              <th>
                <span className="sr-only">Decision</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {c.options.map((o) => (
              <tr key={o.id} className={o.id === c.selectedOptionId ? "selected" : undefined}>
                <td>
                  <strong>
                    {o.id}: {o.name}
                  </strong>
                  <div className="muted">{o.approach}</div>
                </td>
                <td>{o.benefit}</td>
                <td>{o.effort}</td>
                <td>{o.risks}</td>
                <td>{o.reversibility}</td>
                <td>
                  <div className="k-stack k-stack--tight">
                    {o.id === c.recommendedOptionId && <Chip>Recommended</Chip>}
                    {o.id === c.selectedOptionId && <Chip tone="done">Selected</Chip>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && !chooseAtTop && c.options.length > 1 && <OptionChoice task={task} />}
      {chooseAtTop && <p className="small muted">Choose under Needs you, above.</p>}
      {c.uncertainty && (
        <p className="meta">
          <span className="muted">Uncertainty:</span> {c.uncertainty}
        </p>
      )}
      <h3 className="meta">Acceptance and scope</h3>
      <dl className="t-kv">
        <dt>Acceptance</dt>
        <dd>{list(c.acceptance)}</dd>
        <dt>Success</dt>
        <dd>{list(c.successCriteria)}</dd>
        <dt>Why now</dt>
        <dd>{c.whyNow || "—"}</dd>
        <dt>In scope</dt>
        <dd>{list(c.scopeIncluded)}</dd>
        <dt>Out of scope</dt>
        <dd>{list(c.scopeExcluded)}</dd>
        <dt>Validation</dt>
        <dd>{c.validationPlan || "—"}</dd>
        <dt>Rollback</dt>
        <dd>{c.rollback || "—"}</dd>
        <dt>Effort</dt>
        <dd>{c.effort}</dd>
        <dt>Depends on</dt>
        <dd>
          {task.dependsOn.length
            ? task.dependsOn.map((d, i) => (
                <span key={d}>
                  {i > 0 ? ", " : ""}
                  <a href={`#/task/${encodeURIComponent(d)}`}>{d}</a>
                </span>
              ))
            : "—"}
        </dd>
      </dl>
    </div>
  );
}
