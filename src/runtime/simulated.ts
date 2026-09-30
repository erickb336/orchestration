// Simulated runtime for the Milestone 1 prototype. It stands in for the lead's scheduler
// and for provider runtimes, and it feeds reports through the same domain operations a real
// adapter will use. Nothing here executes an agent.

import * as M from "../domain/model";
import type { State } from "../domain/types";

export type AckMode = "normal" | "never";

export interface SimConfig {
  /** How long a simulated run takes to acknowledge a stop request. */
  ackDelayMs: number;
  /** "never" simulates an unresponsive runtime to exercise control-failure handling. */
  ackMode: AckMode;
  /** After this long without acknowledgment, report a control failure. */
  ackTimeoutMs: number;
  /** Progress added per tick to each running attempt. */
  progressPerTick: number;
}

export const DEFAULT_SIM: SimConfig = { ackDelayMs: 2500, ackMode: "normal", ackTimeoutMs: 8000, progressPerTick: 5 };

/** Deterministic per-attempt jitter so runs don't finish in lockstep. */
function jitter(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 7);
}

export function simulateTick(state: State, nowMs: number, cfg: SimConfig): State {
  const now = new Date(nowMs).toISOString();
  let s = M.leadPromoteProposals(state, now);
  s = M.dispatchEligible(s, now);

  for (const a of s.attempts) {
    if (a.outcome === "running") {
      const next = a.progress + cfg.progressPerTick + jitter(a.id);
      s = next >= 100 ? M.reportCompletion(s, a.id, [], now, simulatedOutputs(s, a.taskId, a.stepId, a.id)) : M.reportProgress(s, a.id, next);
    } else if (a.outcome === "stopping" && a.stopRequestedAt) {
      const elapsed = nowMs - Date.parse(a.stopRequestedAt);
      if (cfg.ackMode === "normal" && elapsed >= cfg.ackDelayMs) s = M.acknowledgeStop(s, a.id, now);
      else if (elapsed >= cfg.ackTimeoutMs) s = M.reportStopTimeout(s, a.id, now);
    }
  }
  return s;
}

/** Simulated outputs for every artifact the step declares. Reviews find one issue about half the time. */
function simulatedOutputs(s: State, taskId: string, stepId: string, attemptId: string): M.OutputReport[] {
  const t = s.tasks.find((x) => x.id === taskId)!;
  const st = t.steps.find((x) => x.id === stepId);
  if (!st) return [];
  return st.outputs.map((o) => {
    switch (o.kind) {
      case "review-findings": {
        const found = jitter(attemptId) % 2;
        return { name: o.name, summary: found ? "1 open finding (simulated)" : "No blocking findings (simulated)", openFindings: found };
      }
      case "code-change":
        return { name: o.name, summary: `Commit on ${taskId}-${stepId} branch (simulated)` };
      case "design":
        return { name: o.name, summary: "Flow, states, and copy (simulated)" };
      case "verification":
        return { name: o.name, summary: "Acceptance checks pass on the final change (simulated)" };
      case "handoff":
        return { name: o.name, summary: "Notes for the next worker (simulated)" };
      default:
        return { name: o.name, summary: `${o.kind} (simulated)` };
    }
  });
}
