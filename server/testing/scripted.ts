// A controllable runtime adapter for tests: tests decide when runs finish, fail, or confirm stops.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogModel, LeadQuestion, ProviderId } from "../../src/domain/types";
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
  /** false: the runtime accepts the run but does not report it started (the provider never got going). */
  reportsStart = true;
  start(a: Assignment) {
    this.runs.set(a.attemptId, a);
    this.started.push(a);
    if (this.reportsStart) this.emit({ type: "started", attemptId: a.attemptId, sessionId: `${this.provider}-session-${a.attemptId}`, model: `${a.model}-actual` });
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
  /** ORC-022: scripted runs acknowledge nothing unless a test says so. */
  note(attemptId: string, note: { id: string; text: string }) {
    this.notes.push({ attemptId, ...note });
  }
  readonly notes: { attemptId: string; id: string; text: string }[] = [];
  async shutdown() {
    this.runs.clear();
  }
  emit(e: AdapterEvent) {
    if (e.type === "completed" || e.type === "failed" || e.type === "stopped") this.runs.delete(e.attemptId);
    for (const l of this.listeners) l(e);
  }
  /**
   * Finish a worker run, optionally writing a file first, reporting every declared output. A review
   * reports `findings` as a legacy count (the default, 0) or, with `structured`, as a findings list;
   * like a well-behaved reviewer it lists the changed files the envelope named as `reviewedPaths`
   * unless `reviewedPaths` overrides that (ORC-013).
   */
  finish(id: string, opts: { write?: [string, string]; findings?: number; structured?: unknown[]; reviewedPaths?: string[]; omit?: string; items?: unknown[] } = {}) {
    const a = this.runs.get(id)!;
    if (opts.write) writeFileSync(join(a.workspace.path, opts.write[0]), opts.write[1]);
    const outputs: Record<string, unknown> = {};
    for (const o of a.outputs) {
      if (o.name === opts.omit) continue;
      outputs[o.name] =
        o.kind === "review-findings"
          ? { summary: `${o.name} by ${this.provider}`, ...(opts.structured ? { findings: opts.structured } : { openFindings: opts.findings ?? 0 }), reviewedPaths: opts.reviewedPaths ?? changedFilesIn(a.prompt) }
          : o.kind === "breakdown"
            ? { summary: `${o.name} by ${this.provider}`, items: opts.items ?? [] }
            : { summary: `${o.name} by ${this.provider}` };
    }
    this.emit({ type: "completed", attemptId: id, finalText: `All done.\n\`\`\`json\n${JSON.stringify({ outputs })}\n\`\`\``, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, model: `${a.model}-actual` });
  }
  /**
   * Answer a lead run with a reply, proposals, (ORC-009) a steering block and (ORC-012) a vision draft plus
   * coverage and questions, all raw and validated by the service. Each block is written only when given.
   */
  reply(id: string, reply: string, proposals: unknown[] = [], steer?: unknown, vision?: unknown, extra: { coverage?: unknown; questions?: unknown } = {}) {
    const block: Record<string, unknown> = { reply, proposals };
    if (steer !== undefined) block.steer = steer;
    if (vision !== undefined) block.vision = vision;
    if (extra.coverage !== undefined) block.coverage = extra.coverage;
    if (extra.questions !== undefined) block.questions = extra.questions;
    this.emit({ type: "completed", attemptId: id, finalText: `${reply}\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`` });
  }
  /** A reply with no JSON block at all. */
  replyText(id: string, text: string) {
    this.emit({ type: "completed", attemptId: id, finalText: text });
  }
}

/** ORC-013: the changed files a review envelope asks the reviewer to account for (the JSON array under that heading), or none. */
export function changedFilesIn(prompt: string): string[] {
  const section = /## Changed files you must account for\n[\s\S]*?\n(\[[\s\S]*?\])\n/.exec(prompt);
  if (!section) return [];
  try {
    const v: unknown = JSON.parse(section[1]);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A valid steering block (tests override fields). */
export function steer(over: Record<string, unknown> = {}) {
  return {
    focus: "Get every app building and running locally end to end; deployment automation waits.",
    reason: "You asked to focus on local builds over automating deployment.",
    tasks: [] as unknown[],
    ...over,
  };
}

/** Steering items in the lead's output shape. */
export const st = {
  priority: (id: string, priority: number, why = "serves the focus") => ({ id, priority, why }),
  defer: (id: string, why = "no longer fits the focus") => ({ id, defer: true, why }),
  undefer: (id: string, why = "fits the focus again") => ({ id, defer: false, why }),
  drop: (id: string, why = "my proposal no longer fits") => ({ id, drop: true, why }),
};

/** A valid vision draft (tests override fields). */
export function visionDraft(over: Record<string, unknown> = {}) {
  return {
    text: "Problem: every app must build and run locally with one command.\nFor: the developer.\nGoals: a working local setup; clear failures.\nNon-goals: deployment automation.\nDone when: `npm start` runs every app.",
    focus: "Get every app running locally",
    reason: "Drafted from what you told me about local builds.",
    ...over,
  };
}

/** Valid lead questions (tests override or slice). */
export function questions(): LeadQuestion[] {
  return [
    { question: "Who is this for first?", why: "The first users decide the first milestone.", area: "audience", options: ["Just you", "A small team", "Anyone"] },
    { question: "How will you know it worked?", why: "A measure keeps the scope honest.", area: "outcome" },
    { question: "What must it not do?", why: "Non-goals keep the scope in check.", area: "scope", options: ["No sync", "No accounts"] },
  ];
}

/** A valid coverage block (tests override fields). */
export function coverage(over: Record<string, unknown> = {}) {
  return { intent: "clear", audience: "partial", problem: "clear", outcome: "open", scope: "partial", constraints: "open", risks: "open", priorities: "open", material: "open", ...over };
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
    flowId: "change",
    priority: 2,
    ...over,
  };
}

// ---------- ORC-013: a controllable check runner for scheduler tests ----------

import type { CheckAssignment, CheckRunner } from "../checks";
import type { CheckResult, ChecksHealth } from "../../src/domain/types";

/** Tests decide when a check run completes, fails or confirms a stop, and what its results are. Nothing is spawned. */
export class ScriptedChecks implements CheckRunner {
  readonly simulated = false;
  runs = new Map<string, CheckAssignment>();
  started: CheckAssignment[] = [];
  interrupts: string[] = [];
  probes: ("codex" | "none")[] = [];
  health: ChecksHealth["status"] = "ready";
  private listeners = new Set<(e: AdapterEvent) => void>();
  start(a: CheckAssignment) {
    if (this.runs.has(a.attemptId)) return;
    this.runs.set(a.attemptId, a);
    this.started.push(a);
    this.emit({ type: "started", attemptId: a.attemptId });
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
  async probe(sandbox: "codex" | "none"): Promise<ChecksHealth> {
    this.probes.push(sandbox);
    return { sandbox, status: this.health, detail: this.health === "ready" ? "scripted: ready" : "scripted: the sandbox is unavailable", checkedAt: new Date().toISOString(), ...(this.health !== "ready" ? { probes: { writeOutside: "allowed" as const, network: "unknown" as const } } : {}) };
  }
  /** ORC-022: scripted runs acknowledge nothing unless a test says so. */
  note(attemptId: string, note: { id: string; text: string }) {
    this.notes.push({ attemptId, ...note });
  }
  readonly notes: { attemptId: string; id: string; text: string }[] = [];
  async shutdown() {
    this.runs.clear();
  }
  emit(e: AdapterEvent) {
    if (e.type === "completed" || e.type === "failed" || e.type === "stopped") this.runs.delete(e.attemptId);
    for (const l of this.listeners) l(e);
  }
  /** Complete a run: every planned command passes unless `fail` names it (exit 1) or `timeout` names it. */
  finish(id: string, o: { fail?: string[]; timeout?: string[]; excerpt?: string } = {}) {
    const a = this.runs.get(id)!;
    const results: CheckResult[] = a.commands.map((c) => {
      const failed = o.fail?.includes(c.id);
      const timedOut = o.timeout?.includes(c.id);
      return { id: c.id, label: c.label, kind: c.kind, status: timedOut ? "timed-out" : failed ? "failed" : "passed", ...(timedOut ? {} : { exitCode: failed ? 1 : 0 }), durationMs: 1500, excerpt: failed || timedOut ? (o.excerpt ?? `${c.label}: 1 failing`) : "", bytes: 0, truncated: false };
    });
    this.emit({ type: "completed", attemptId: id, finalText: "", checks: { sha: a.target, results, durationMs: 1500 * results.length, sandbox: a.sandbox } });
  }
  /** Confirm a stop request. */
  stopped(id: string) {
    this.emit({ type: "stopped", attemptId: id, how: "interrupted" });
  }
  fail(id: string, message: string) {
    this.emit({ type: "failed", attemptId: id, message });
  }
}
