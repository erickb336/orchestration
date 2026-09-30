// Fake runtime (simulated). It implements the same adapter contract as the real Claude and Codex
// adapters, so the scheduler exercises one path for both. Its "processes" live only in this
// service's memory; they vanish when the service stops, which lets restart reconciliation be tested
// honestly. It advances only when the scheduler calls tick(). No agent executes.

import type { AckMode } from "../../src/api";
import type { CatalogModel, OutputDef, ProviderId } from "../../src/domain/types";
import type { CapabilityMap } from "../../src/runtime/adapter";
import type { AdapterEvent, Assignment, ProviderHealth, RuntimeAdapter } from "./types";

export interface FakeRuntimeConfig {
  ackMode: AckMode;
  ackDelayMs: number;
  progressPerTick: number;
}

interface Proc {
  progress: number;
  outputs: OutputDef[];
  interruptAt?: number;
}

function jitter(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 7);
}

/** The final message a well-behaved worker would send: a JSON output block for every declared output. */
export function fakeFinalText(attemptId: string, outputs: OutputDef[]): string {
  const block: Record<string, { summary: string; openFindings?: number }> = {};
  for (const o of outputs) {
    if (o.kind === "review-findings") {
      const found = jitter(attemptId) % 2;
      block[o.name] = { summary: found ? "1 open finding (simulated)" : "No blocking findings (simulated)", openFindings: found };
    } else if (o.kind === "code-change") block[o.name] = { summary: "Simulated change; no files were touched" };
    else block[o.name] = { summary: `${o.kind} (simulated)` };
  }
  return `Done (simulated).\n\n\`\`\`json\n${JSON.stringify({ outputs: block }, null, 2)}\n\`\`\`\n`;
}

const CAPABILITIES: CapabilityMap = {
  start: "simulated",
  streamEvents: "simulated",
  steer: "unsupported",
  interrupt: "simulated",
  resume: "unsupported",
  usageReporting: "unsupported",
  childAgentTracking: "unsupported",
};

/** Shared by the fake adapters of both providers so the simulation controls apply to all runs. */
export function defaultFakeConfig(): FakeRuntimeConfig {
  return { ackMode: "normal", ackDelayMs: 2500, progressPerTick: 5 };
}

export class FakeAdapter implements RuntimeAdapter {
  readonly provider: ProviderId;
  readonly label = "Fake runtime (simulated)";
  readonly capabilities = CAPABILITIES;
  config: FakeRuntimeConfig;
  private procs = new Map<string, Proc>();
  private listeners = new Set<(e: AdapterEvent) => void>();
  private catalog: CatalogModel[];

  constructor(provider: ProviderId, config: FakeRuntimeConfig = defaultFakeConfig(), catalog: CatalogModel[] = []) {
    this.provider = provider;
    this.config = config;
    this.catalog = catalog;
  }

  private emit(e: AdapterEvent) {
    for (const l of this.listeners) l(e);
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready", detail: "Fake runtime: runs are simulated and no agent executes.", checkedAt: new Date().toISOString() };
  }

  async listModels(): Promise<CatalogModel[] | null> {
    return this.catalog.length ? this.catalog : null;
  }

  start(a: Assignment) {
    this.startAt(a.attemptId, a.outputs, 0);
  }

  /** Start with a given progress (tests and restart scenarios). */
  startAt(attemptId: string, outputs: OutputDef[], progress: number) {
    if (this.procs.has(attemptId)) return;
    this.procs.set(attemptId, { progress, outputs });
    this.emit({ type: "started", attemptId });
  }

  /** Idempotent: repeated requests keep the first request time. */
  interrupt(attemptId: string) {
    const p = this.procs.get(attemptId);
    if (p && p.interruptAt === undefined) p.interruptAt = Date.now();
  }

  /** Interrupt with an explicit clock (scheduler passes its cycle time). */
  interruptAt(attemptId: string, nowMs: number) {
    const p = this.procs.get(attemptId);
    if (p && p.interruptAt === undefined) p.interruptAt = nowMs;
  }

  kill(attemptId: string) {
    this.procs.delete(attemptId);
  }

  has(attemptId: string) {
    return this.procs.has(attemptId);
  }

  ids(): string[] {
    return [...this.procs.keys()];
  }

  status(attemptId: string): "running" | "stopping" | "absent" {
    const p = this.procs.get(attemptId);
    if (!p) return "absent";
    return p.interruptAt === undefined ? "running" : "stopping";
  }

  onEvent(listener: (e: AdapterEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Advance every process by one tick; events are emitted synchronously. */
  tick(nowMs: number) {
    for (const [id, p] of [...this.procs]) {
      if (p.interruptAt !== undefined) {
        if (this.config.ackMode === "normal" && nowMs - p.interruptAt >= this.config.ackDelayMs) {
          this.procs.delete(id);
          this.emit({ type: "stopped", attemptId: id, how: "interrupted" });
        }
        continue;
      }
      p.progress = Math.min(100, p.progress + this.config.progressPerTick + jitter(id));
      if (p.progress >= 100) {
        this.procs.delete(id);
        this.emit({ type: "completed", attemptId: id, finalText: fakeFinalText(id, p.outputs) });
      } else this.emit({ type: "progress", attemptId: id, percent: p.progress });
    }
  }

  clear() {
    this.procs.clear();
  }

  size() {
    return this.procs.size;
  }

  async shutdown() {
    this.procs.clear();
  }
}
