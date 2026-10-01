// How the server tests build pipelines that flows do not offer: the domain's test-only `setPipeline`
// (src/domain/testing/pipelines.ts) applied through the store, so the rest of a scheduler test works as before.

import { setPipeline } from "../../src/domain/testing/pipelines";
import type { StepDef } from "../../src/domain/types";
import type { Store } from "../store";

/**
 * Replace a task's pipeline with `steps` at its current revision, or at `expectedRev` when a test asserts
 * the revision it expects (a stale one throws `StaleWriteError`). `store.update` rethrows the domain error
 * after rolling back, so `expect(() => setTestPipeline(…)).toThrow(/…/)` works for refusals.
 */
export function setTestPipeline(store: Store, taskId: string, steps: StepDef[], now = new Date().toISOString(), reason = "test pipeline", expectedRev?: number) {
  return store.update((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    return setPipeline(s, taskId, expectedRev ?? t.pipelineRev, steps, reason, "user", now);
  }, now);
}
