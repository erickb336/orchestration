// What the task is for: the outcome, the benefit, and the chosen approach with the
// lead's reason, said once. A spec you wrote says "Your spec" (ORC-030 a-words-verified): the lead recommended nothing.

import * as M from "../../domain/model";
import type { SpecContent, Task } from "../../domain/types";
import { Card } from "../kit";

/** You wrote the spec: its first revision is yours (Tasks › New task › Write the spec yourself). */
export const specWrittenByYou = (task: Task) => task.specs[0]?.author === "user";

/**
 * "Approach: Guest link — a guest link that keeps a name… Chosen by the lead: a guest link is one tap…". For a spec you
 * wrote (`yours`), "Approach: … Your spec." while your own approach is the one selected.
 */
export function approachLine(c: SpecContent, yours = false): string | undefined {
  const sel = c.options.find((o) => o.id === c.selectedOptionId);
  if (!sel) return undefined;
  const rec = c.options.find((o) => o.id === c.recommendedOptionId);
  const approach = sel.approach.trim().replace(/\.+$/, "");
  const overridden = c.selectedOptionId !== c.recommendedOptionId;
  if (yours && !overridden) return `Approach: ${approach || sel.name}. Your spec.`;
  const head = `Approach: ${sel.name}${approach && approach !== sel.name ? ` — ${approach}` : ""}.`;
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
  const line = approachLine(c, specWrittenByYou(task));
  return (
    <Card title="What it's for">
      <p>{c.outcome}</p>
      {c.benefit && <p className="muted">{c.benefit}</p>}
      {line && <p className="meta muted">{line}</p>}
    </Card>
  );
}
