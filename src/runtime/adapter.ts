// What a runtime adapter says it can do, shown in Settings per provider and reported by GET /api/state.
// The adapter contract itself is server-side (server/runtimes/types.ts); this type is shared with the UI.

type CapabilityStatus = "supported" | "unsupported" | "unverified" | "simulated";

export interface CapabilityMap {
  start: CapabilityStatus;
  streamEvents: CapabilityStatus;
  steer: CapabilityStatus;
  interrupt: CapabilityStatus;
  resume: CapabilityStatus;
  usageReporting: CapabilityStatus;
  childAgentTracking: CapabilityStatus;
}
