// Test fixture (pure): a finished task whose own pipeline wrote a change and reviewed exactly that
// change. Used by the domain and notification tests that are about GitHub's side of the merge gate,
// so the independent review is already settled there. Not used by the application.

import { instantiate } from "../pipeline";
import type { ConsumedInput, ProviderId, RunSnapshot, State } from "../types";

export interface ReviewedOptions {
  writer?: ProviderId;
  reviewer?: ProviderId;
  /** Open findings the review reported. */
  findings?: number;
  /** false: the review ran, but on an earlier change, so it never saw this one. */
  sawTheChange?: boolean;
}

/** Give `taskId` a two-step pipeline (implement, code review), both done, for the commit `sha`. */
export function reviewedChange(state: State, taskId: string, sha: string, at: string, o: ReviewedOptions = {}): State {
  const s = structuredClone(state);
  const t = s.tasks.find((x) => x.id === taskId)!;
  const snap = (provider: ProviderId, inputs: ConsumedInput[] = []): RunSnapshot => ({ provider, model: `${provider}-model`, source: "project-role", routingReason: "fixture", specRev: 1, stepRev: 1, visionRev: 1, workspace: "", pipelineRev: 1, purpose: "", inputs });
  t.steps = instantiate([
    { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] },
    { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
  ]).map((st) => ({ ...st, state: "done" as const }));
  s.attempts = s.attempts.filter((a) => a.taskId !== taskId);
  s.artifacts = s.artifacts.filter((a) => a.taskId !== taskId);
  const change = `fx-change-${taskId}`;
  const seen = o.sawTheChange === false ? `fx-earlier-${taskId}` : change;
  s.attempts.push(
    { id: `fx-write-${taskId}`, taskId, stepId: "S1", snapshot: snap(o.writer ?? "codex"), startedAt: at, endedAt: at, outcome: "completed", progress: 100, artifacts: [] },
    { id: `fx-review-${taskId}`, taskId, stepId: "S2", snapshot: snap(o.reviewer ?? "claude", [{ step: "S1", output: "change", artifactId: seen, version: 1 }]), startedAt: at, endedAt: at, outcome: "completed", progress: 100, artifacts: [] },
  );
  s.artifacts.push(
    { id: change, taskId, stepId: "S1", attemptId: `fx-write-${taskId}`, name: "change", kind: "code-change", version: 1, summary: "the change", ref: `${sha.slice(0, 12)} on orchestration/fixture`, createdAt: at },
    { id: `fx-findings-${taskId}`, taskId, stepId: "S2", attemptId: `fx-review-${taskId}`, name: "findings", kind: "review-findings", version: 1, summary: o.findings ? "a finding that must be fixed" : "no findings", openFindings: o.findings ?? 0, createdAt: at },
  );
  return s;
}
