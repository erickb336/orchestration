// Test fixture (pure): a finished task whose own pipeline wrote a change and reviewed exactly that
// change. Used by the domain and notification tests that are about GitHub's side of the merge gate,
// so the independent review is already settled there. Not used by the application.

import { notRequired } from "../coverage";
import { instantiate } from "../pipeline";
import type { ConsumedInput, ProviderId, RunSnapshot, State } from "../types";

export interface ReviewedOptions {
  writer?: ProviderId;
  reviewer?: ProviderId;
  /** Open findings the review reported. */
  findings?: number;
  /** false: the review ran, but on an earlier change, so it never saw this one. */
  sawTheChange?: boolean;
  /** Open findings the security review reported (ORC-021). */
  security?: number;
  /** false: the security review ran on an earlier change. Defaults to `sawTheChange`. */
  securitySaw?: boolean;
  /** true: no security review at all, as in a pipeline from before ORC-021. */
  noSecurity?: boolean;
}

/**
 * Give `taskId` a pipeline as the Change flow runs it (implement; a code review and a security review beside
 * it, on the same input), all done, for the commit `sha`.
 */
export function reviewedChange(state: State, taskId: string, sha: string, at: string, o: ReviewedOptions = {}): State {
  const s = structuredClone(state);
  const t = s.tasks.find((x) => x.id === taskId)!;
  const snap = (provider: ProviderId, inputs: ConsumedInput[] = []): RunSnapshot => ({ provider, model: `${provider}-model`, source: "project-role", routingReason: "fixture", specRev: 1, stepRev: 1, visionRev: 1, workspace: "", pipelineRev: 1, purpose: "", inputs });
  t.steps = instantiate([
    { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] },
    { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
    ...(o.noSecurity ? [] : [{ id: "SR1", purpose: "Security review", role: "security_reviewer" as const, dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" as const }] }]),
  ]).map((st) => ({ ...st, state: "done" as const }));
  s.attempts = s.attempts.filter((a) => a.taskId !== taskId);
  s.artifacts = s.artifacts.filter((a) => a.taskId !== taskId);
  const change = `fx-change-${taskId}`;
  const seen = o.sawTheChange === false ? `fx-earlier-${taskId}` : change;
  const secSeen = (o.securitySaw ?? o.sawTheChange) === false ? `fx-earlier-${taskId}` : change;
  s.attempts.push(
    { id: `fx-write-${taskId}`, taskId, stepId: "S1", snapshot: snap(o.writer ?? "codex"), startedAt: at, endedAt: at, outcome: "completed", progress: 100, artifacts: [] },
    { id: `fx-review-${taskId}`, taskId, stepId: "S2", snapshot: snap(o.reviewer ?? "claude", [{ step: "S1", output: "change", artifactId: seen, version: 1 }]), startedAt: at, endedAt: at, outcome: "completed", progress: 100, artifacts: [] },
  );
  s.artifacts.push(
    { id: change, taskId, stepId: "S1", attemptId: `fx-write-${taskId}`, name: "change", kind: "code-change", version: 1, summary: "the change", ref: `${sha.slice(0, 12)} on orchestration/fixture`, createdAt: at },
    {
      id: `fx-findings-${taskId}`,
      taskId,
      stepId: "S2",
      attemptId: `fx-review-${taskId}`,
      name: "findings",
      kind: "review-findings",
      version: 1,
      summary: o.findings ? "a finding that must be fixed" : "no findings",
      openFindings: o.findings ?? 0,
      // ORC-013: "reviewed exactly this change" includes accounting for every changed file of it.
      pathCoverage: { state: "complete", from: "0".repeat(40), to: o.sawTheChange === false ? "1".repeat(40) : sha, changed: 1, reviewed: 1, missing: [], extra: [] },
      createdAt: at,
    },
  );
  if (!o.noSecurity) {
    s.attempts.push({ id: `fx-sec-${taskId}`, taskId, stepId: "SR1", snapshot: snap(o.reviewer ?? "claude", [{ step: "S1", output: "change", artifactId: secSeen, version: 1 }]), startedAt: at, endedAt: at, outcome: "completed", progress: 100, artifacts: [] });
    // Path coverage is the code review's proof; a security review's coverage is "not required", as the engine records it.
    s.artifacts.push({ id: `fx-secfindings-${taskId}`, taskId, stepId: "SR1", attemptId: `fx-sec-${taskId}`, name: "findings", kind: "review-findings", version: 1, summary: o.security ? "a token is written to the log" : "no security findings", openFindings: o.security ?? 0, pathCoverage: notRequired(), createdAt: at });
  }
  return s;
}
