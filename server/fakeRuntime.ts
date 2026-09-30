// Fake runtime for Milestone 2. It stands behind the same boundary a real adapter will: the
// scheduler starts runs, requests interrupts, and receives events. Its "processes" live only in
// this service's memory, so they disappear when the service stops, which lets restart
// reconciliation be exercised honestly. No agent executes.

import type { AckMode } from "../src/api";
import type { RuntimeEvent } from "../src/runtime/adapter";

export interface FakeRuntimeConfig {
  ackMode: AckMode;
  ackDelayMs: number;
  progressPerTick: number;
}

interface Proc {
  progress: number;
  interruptAt?: number;
}

function jitter(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 7);
}

export class FakeRuntime {
  readonly kind = "fake" as const;
  config: FakeRuntimeConfig;
  private procs = new Map<string, Proc>();

  constructor(config: Partial<FakeRuntimeConfig> = {}) {
    this.config = { ackMode: "normal", ackDelayMs: 2500, progressPerTick: 5, ...config };
  }

  has(attemptId: string) {
    return this.procs.has(attemptId);
  }

  start(attemptId: string, progress = 0) {
    if (!this.procs.has(attemptId)) this.procs.set(attemptId, { progress });
  }

  /** Idempotent: repeated requests keep the first request time. */
  requestInterrupt(attemptId: string, nowMs: number) {
    const p = this.procs.get(attemptId);
    if (p && p.interruptAt === undefined) p.interruptAt = nowMs;
  }

  status(attemptId: string): "running" | "stopping" | "absent" {
    const p = this.procs.get(attemptId);
    if (!p) return "absent";
    return p.interruptAt === undefined ? "running" : "stopping";
  }

  /** Advance every process by one tick and report what happened. */
  tick(nowMs: number): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    for (const [id, p] of this.procs) {
      if (p.interruptAt !== undefined) {
        if (this.config.ackMode === "normal" && nowMs - p.interruptAt >= this.config.ackDelayMs) {
          this.procs.delete(id);
          out.push({ type: "stopped", attemptId: id });
        }
        continue;
      }
      p.progress = Math.min(100, p.progress + this.config.progressPerTick + jitter(id));
      if (p.progress >= 100) {
        this.procs.delete(id);
        out.push({ type: "completed", attemptId: id, artifacts: [] });
      } else out.push({ type: "progress", attemptId: id, progress: p.progress });
    }
    return out;
  }

  ids(): string[] {
    return [...this.procs.keys()];
  }

  /** Terminate one process immediately, without reporting anything. */
  kill(attemptId: string) {
    this.procs.delete(attemptId);
  }

  /** Drop every process (service shutdown, sample reset, or loss of the scheduler lease). */
  clear() {
    this.procs.clear();
  }

  size() {
    return this.procs.size;
  }
}
