// The pull request's title and body, and the merge commit's subject and body.

import * as M from "../model";
import { clip } from "../text";
import { type State, type Task } from "../types";
import { sha12 } from "./core";
import { requiredCheckNames } from "./gate";
import { prMarker } from "./pr";

export function prTitle(t: Task): string {
  return clip(`${t.id}: ${M.currentSpec(t).content.title}`, 200);
}

/** Public text: the repository may be public. The caller redacts it before it leaves the machine. */
export function prBody(s: State, t: Task): string {
  const pr = t.integration!.pr!;
  const c = M.currentSpec(t).content;
  const lines = [
    c.outcome,
    "",
    ...(c.acceptance.length ? ["Acceptance:", ...c.acceptance.map((a) => `- ${a}`), ""] : []),
    ...(pr.review.ok ? [`Automated review by Orchestrator (${pr.review.provider ? M.providerLabel(pr.review.provider) : "agent"}${pr.review.model ? ` · ${pr.review.model}` : ""}), not a human review: 0 open findings on ${sha12(pr.changeSha)}.`, ""] : []),
    "Opened by Orchestrator using this GitHub account.",
  ];
  return `${clip(lines.join("\n"), 5800)}\n\n${prMarker(s.project.id, t.id, pr.n)}`;
}

export function mergeSubject(t: Task): string {
  const pr = t.integration!.pr!;
  return clip(`${t.id}: ${M.currentSpec(t).content.title} (#${pr.number})`, 200);
}

export function mergeBody(s: State, t: Task): string {
  const pr = t.integration!.pr!;
  const checks = requiredCheckNames(s, pr);
  const byUser = pr.mergeRequested?.headSha === pr.headSha;
  const reviewer = pr.review.provider ? ` (${M.providerLabel(pr.review.provider)}${pr.review.model ? ` · ${pr.review.model}` : ""})` : "";
  return [
    byUser ? `Merged from Orchestrator at the user's request, for head ${sha12(pr.headSha)}.` : `Merged automatically by Orchestrator, for head ${sha12(pr.headSha)}.`,
    checks.length ? `Required checks passed on that head: ${checks.join(", ")}.` : "",
    pr.review.ok ? `Automated review by Orchestrator${reviewer}, not a human review: 0 open findings on ${sha12(pr.changeSha)}.` : "",
    pr.headSha !== pr.changeSha ? `The head is the reviewed change ${sha12(pr.changeSha)} with ${pr.base} (${sha12(pr.baseSha)}) merged into it by Orchestrator.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
