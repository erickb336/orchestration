import type { SpecContent } from "./types";

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Render a spec as labeled lines so revisions can be compared field by field. */
export function specToLines(c: SpecContent): string[] {
  const out: string[] = [];
  const field = (label: string, v: string) => out.push(`${label}: ${v}`);
  const list = (label: string, vs: string[]) => vs.forEach((v) => out.push(`${label}: • ${v}`));
  field("Title", c.title);
  field("Area", c.area);
  field("Why now", c.whyNow);
  field("Outcome", c.outcome);
  field("Benefit", c.benefit);
  list("Success", c.successCriteria);
  list("In scope", c.scopeIncluded);
  list("Out of scope", c.scopeExcluded);
  for (const o of c.options) {
    field(`Option ${o.id}`, o.name);
    field(`Option ${o.id} approach`, o.approach);
    field(`Option ${o.id} benefit`, o.benefit);
    field(`Option ${o.id} effort`, o.effort);
    field(`Option ${o.id} risks`, o.risks);
    field(`Option ${o.id} reversibility`, o.reversibility);
  }
  field("Recommended", c.recommendedOptionId);
  field("Selected", c.selectedOptionId);
  field("Decided by", c.decidedBy);
  field("Rationale", c.rationale);
  field("Uncertainty", c.uncertainty);
  if (c.overrideReason) field("Override reason", c.overrideReason);
  list("Acceptance", c.acceptance);
  field("Validation", c.validationPlan);
  field("Rollback", c.rollback);
  field("Effort", c.effort);
  return out;
}

/** Line diff via longest common subsequence. Specs are small, so O(n·m) is fine. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}
