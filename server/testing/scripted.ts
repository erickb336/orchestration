// A controllable runtime adapter for tests: tests decide when runs finish, fail, or confirm stops.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogModel, ProviderId } from "../../src/domain/types";
import type { AdapterEvent, Assignment, Connection, ProviderHealth, RuntimeAdapter } from "../runtimes/types";

export class ScriptedAdapter implements RuntimeAdapter {
  readonly label = "Scripted test adapter";
  readonly capabilities = {
    start: "supported",
    streamEvents: "supported",
    steer: "unsupported",
    interrupt: "supported",
    resume: "unsupported",
    usageReporting: "supported",
    childAgentTracking: "unsupported",
  } as const;
  runs = new Map<string, Assignment>();
  started: Assignment[] = [];
  interrupts: string[] = [];
  healthStatus: ProviderHealth["status"] = "ready";
  connectionsList: Connection[] | null = [];
  private listeners = new Set<(e: AdapterEvent) => void>();
  readonly provider: ProviderId;

  constructor(provider: ProviderId) {
    this.provider = provider;
  }
  async health(): Promise<ProviderHealth> {
    return { status: this.healthStatus, detail: this.healthStatus === "ready" ? "ok" : `${this.provider} needs credentials`, checkedAt: new Date().toISOString() };
  }
  async listModels(): Promise<CatalogModel[] | null> {
    return null;
  }
  async listConnections(): Promise<Connection[] | null> {
    return this.connectionsList;
  }
  start(a: Assignment) {
    this.runs.set(a.attemptId, a);
    this.started.push(a);
    this.emit({ type: "started", attemptId: a.attemptId, sessionId: `${this.provider}-session-${a.attemptId}`, model: `${a.model}-actual` });
  }
  interrupt(id: string) {
    if (!this.interrupts.includes(id)) this.interrupts.push(id);
  }
  kill(id: string) {
    this.runs.delete(id);
  }
  has(id: string) {
    return this.runs.has(id);
  }
  ids() {
    return [...this.runs.keys()];
  }
  onEvent(l: (e: AdapterEvent) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  async shutdown() {
    this.runs.clear();
  }
  emit(e: AdapterEvent) {
    if (e.type === "completed" || e.type === "failed" || e.type === "stopped") this.runs.delete(e.attemptId);
    for (const l of this.listeners) l(e);
  }
  /** Finish a worker run, optionally writing a file first, reporting every declared output. */
  finish(id: string, opts: { write?: [string, string]; findings?: number; omit?: string; items?: unknown[]; chosen?: string } = {}) {
    const a = this.runs.get(id)!;
    if (opts.write) writeFileSync(join(a.workspace.path, opts.write[0]), opts.write[1]);
    const outputs: Record<string, unknown> = {};
    for (const o of a.outputs) {
      if (o.name === opts.omit) continue;
      outputs[o.name] =
        o.kind === "review-findings"
          ? { summary: `${o.name} by ${this.provider}`, openFindings: opts.findings ?? 0 }
          : o.kind === "breakdown"
            ? { summary: `${o.name} by ${this.provider}`, items: opts.items ?? [] }
            : { summary: `${o.name} by ${this.provider}` };
    }
    const block = opts.chosen ? { outputs, chosen: opts.chosen } : { outputs };
    this.emit({ type: "completed", attemptId: id, finalText: `All done.\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\``, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, model: `${a.model}-actual` });
  }
  /** Answer a lead run with a reply and proposals (raw objects, validated by the service). */
  reply(id: string, reply: string, proposals: unknown[] = []) {
    this.emit({ type: "completed", attemptId: id, finalText: `${reply}\n\`\`\`json\n${JSON.stringify({ reply, proposals })}\n\`\`\`` });
  }
}

/** A complete, valid lead proposal (tests override fields). */
export function proposal(over: Record<string, unknown> = {}) {
  return {
    title: "Add a greeting",
    area: "Core",
    whyNow: "The module has no greeting yet.",
    outcome: "greet() exists.",
    benefit: "Users can greet.",
    scopeIncluded: ["greet()"],
    scopeExcluded: ["i18n"],
    options: [
      { id: "A", name: "Add greet()", approach: "One function", benefit: "Simple", effort: "Small", risks: "Low", reversibility: "High" },
      { id: "B", name: "Defer", approach: "Do nothing", benefit: "No cost", effort: "None", risks: "No greeting", reversibility: "N/A" },
    ],
    recommendedOptionId: "A",
    rationale: "Smallest useful step.",
    uncertainty: "None significant.",
    acceptance: ["greet() returns a greeting"],
    templateId: "change",
    priority: 2,
    ...over,
  };
}
