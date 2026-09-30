// Runtime adapter contract (PROJECT_SPEC.md "Architecture recommendation").
// Milestone 1 only implements a simulated runtime; the Claude Agent SDK and Codex App Server
// adapters arrive in Milestone 3 and must publish verified capability maps.

import type { ProviderId, RunSnapshot } from "../domain/types";

export type CapabilityStatus = "supported" | "unsupported" | "unverified" | "simulated";

export interface CapabilityMap {
  start: CapabilityStatus;
  streamEvents: CapabilityStatus;
  steer: CapabilityStatus;
  interrupt: CapabilityStatus;
  resume: CapabilityStatus;
  usageReporting: CapabilityStatus;
  childAgentTracking: CapabilityStatus;
}

export type RuntimeEvent =
  | { type: "progress"; attemptId: string; progress: number }
  | { type: "completed"; attemptId: string; artifacts: string[] }
  | { type: "stopped"; attemptId: string }
  | { type: "failed"; attemptId: string; message: string };

export interface RuntimeAdapter {
  readonly provider: ProviderId;
  readonly label: string;
  readonly capabilities: CapabilityMap;
  start(attemptId: string, snapshot: RunSnapshot, assignment: string): Promise<void>;
  requestInterrupt(attemptId: string): Promise<void>;
  steer?(attemptId: string, message: string): Promise<void>;
  status(attemptId: string): Promise<"running" | "stopped" | "unknown">;
  onEvent(listener: (e: RuntimeEvent) => void): () => void;
}

/** What the prototype displays for each provider. Nothing here is a live runtime. */
export const PROTOTYPE_CAPABILITIES: Record<ProviderId, { adapter: string; capabilities: CapabilityMap }> = {
  claude: {
    adapter: "Claude Agent SDK (planned, Milestone 3)",
    capabilities: { start: "simulated", streamEvents: "simulated", steer: "unverified", interrupt: "simulated", resume: "unverified", usageReporting: "unverified", childAgentTracking: "unverified" },
  },
  codex: {
    adapter: "Codex App Server (planned, Milestone 3)",
    capabilities: { start: "simulated", streamEvents: "simulated", steer: "unverified", interrupt: "simulated", resume: "unverified", usageReporting: "unverified", childAgentTracking: "unverified" },
  },
};
