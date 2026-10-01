// What the task is for: the outcome, the benefit, and the chosen approach with the
// lead's reason, said once.

import * as M from "../../domain/model";
import type { SpecContent, Task } from "../../domain/types";
import { Card } from "../kit";

/** "Approach: Guest link — a guest link that keeps a name… Chosen by the lead: a guest link is one tap…" */
export function approachLine(c: SpecContent): string | undefined {
  const sel = c.options.find((o) => o.id === c.selectedOptionId);
  if (!sel) return undefined;
  const rec = c.options.find((o) => o.id === c.recommendedOptionId);
  const approach = sel.approach.trim().replace(/\.+$/, "");
  const head = `Approach: ${sel.name}${approach && approach !== sel.name ? ` — ${approach}` : ""}.`;
  const overridden = c.selectedOptionId !== c.recommendedOptionId;
  if (overridden) {
    const reason = c.overrideReason.trim();
    return `${head} Chosen by you over the lead's recommendation${rec ? ` (${rec.name})` : ""}${reason ? `: ${reason}` : "."}`;
  }
  const why = c.rationale.trim();
  const by = c.decidedBy === "user" ? "Chosen by you, as the lead recommended" : "Chosen by the lead";
  return `${head} ${by}${why ? `: ${why}` : "."}`;
}

export function PurposeCard({ task }: { task: Task }) {
  const c = M.currentSpec(task).content;
  const line = approachLine(c);
  return (
    <Card title="What it's for">
      <p>{c.outcome}</p>
      {c.benefit && <p className="muted">{c.benefit}</p>}
      {line && <p className="meta muted">{line}</p>}
    </Card>
  );
}
