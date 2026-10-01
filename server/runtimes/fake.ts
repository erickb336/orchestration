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
  stepId?: string;
  taskId?: string;
  interruptAt?: number;
  /** Lead runs answer with a reply (and, when planning, one proposal) instead of step outputs. */
  lead?: "planning" | "message" | "decisions";
  /** The lead envelope, kept so a simulated message run can steer from what it was shown. */
  prompt?: string;
}

/** Words that make the simulated lead treat a message as a change of direction. */
const DIRECTION_RE = /\bfocus\b| vs |\binstead\b|rather than/i;

/**
 * ORC-009: a simulated steering block, built only from the envelope: the newest message that reads
 * like a change of direction becomes the focus (labelled simulated), and the lowest-priority open task
 * whose "may:" list includes defer is deferred. Nothing else is touched.
 */
export function fakeSteer(prompt: string): Record<string, unknown> | undefined {
  const section = /## Messages to answer now\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? "";
  const messages = section
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(/^\(sent from [^)]*\) /, ""));
  const direction = [...messages].reverse().find((m) => DIRECTION_RE.test(m));
  if (!direction) return undefined;
  const focus = `(Simulated) ${direction.length > 200 ? `${direction.slice(0, 199)}…` : direction}`;
  let candidate: { id: string; priority: number } | undefined;
  for (const m of prompt.matchAll(/^- (\S+) \[[^\]]*\] P(\d+).*· may: ([^·\n]*)/gm)) {
    if (!m[3].split(",").some((a) => a.trim() === "defer")) continue;
    const p = Number(m[2]);
    if (!candidate || p > candidate.priority) candidate = { id: m[1], priority: p };
  }
  return {
    focus,
    reason: "(Simulated) Taken from your message; a real lead would weigh the board.",
    tasks: candidate ? [{ id: candidate.id, defer: true, why: "(Simulated) lowest-priority work that no longer fits the focus" }] : [],
  };
}

/** The newest message the lead must answer, from the envelope. */
function newestMessage(prompt: string): string | undefined {
  const section = /## Messages to answer now\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? "";
  const messages = section
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(/^\(sent from [^)]*\) /, ""));
  return messages[messages.length - 1];
}

/** How many simulated shaping replies the conversation in the envelope already holds. */
function exchanges(prompt: string): number {
  const convo = /## Conversation \(most recent last\)\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? "";
  return (convo.match(/\(Simulated lead\) Here is what I understand/g) ?? []).length;
}

/**
 * ORC-012: a simulated vision draft, built only from the envelope while the project is shaping. The newest
 * message becomes the problem statement and every other part is a marked assumption, as a real lead's
 * living draft would be from the first exchange; it is labelled simulated throughout.
 */
export function fakeVision(prompt: string): Record<string, unknown> | undefined {
  if (!/^Project stage: shaping$/m.test(prompt)) return undefined;
  const last = newestMessage(prompt);
  if (!last) return undefined;
  const short = last.length > 300 ? `${last.slice(0, 299)}…` : last;
  const n = exchanges(prompt) + 1;
  return {
    text: [
      `(Simulated draft, exchange ${n}) Problem: ${short}`,
      "Who it is for: you first (assumption: confirm or change).",
      "Outcome: what your message asks for, delivered in small verifiable steps; success is that you use it and it holds up (assumption).",
      "Scope: the smallest slice that shows the outcome; out of scope: anything your message did not ask for (assumption).",
      "Constraints: none stated yet (assumption: none).",
      "Risks: the problem is broader than one message shows (assumption).",
      "First milestone: one thing you can try yourself within a day (assumption).",
      "",
      "A real lead grounds each line in your answers, the vision documents and the repository, and improves the draft every turn.",
    ].join("\n"),
    focus: `(Simulated) ${short.length > 120 ? `${short.slice(0, 119)}…` : short}`,
    reason: n === 1 ? "(Simulated) A first living draft from your message; the assumptions are yours to confirm or change." : `(Simulated) Improved after ${n} exchanges; a real lead would fold your answers in.`,
  };
}

/** ORC-012: three simulated questions with reasons and options, and a simulated coverage that improves per exchange. */
export function fakeShaping(prompt: string): { questions: Record<string, unknown>[]; coverage: Record<string, string> } | undefined {
  if (!/^Project stage: shaping$/m.test(prompt)) return undefined;
  const n = exchanges(prompt) + 1;
  const questions = [
    { question: "(Simulated) Who is this for first: you, a small team, or anyone?", why: "(Simulated) The first users decide the first milestone. I'd suggest you first, so it is usable soon.", area: "audience", options: ["Just me (recommended)", "A small team", "Anyone"] },
    { question: "(Simulated) How will you know it worked?", why: "(Simulated) A measure keeps the scope honest.", area: "outcome", options: ["I use it daily", "A first user does", "A number improves"] },
    { question: "(Simulated) What must it not do in the first version?", why: "(Simulated) Non-goals keep the scope in check.", area: "scope" },
  ];
  const coverage: Record<string, string> =
    n === 1
      ? { intent: "partial", audience: "open", problem: "partial", outcome: "open", scope: "open", constraints: "open", risks: "open", priorities: "open", material: "open" }
      : { intent: "clear", audience: "partial", problem: "clear", outcome: "partial", scope: "partial", constraints: "open", risks: "open", priorities: "partial", material: "open" };
  return { questions, coverage };
}

/** A simulated lead reply in the required JSON shape. Planning runs propose one small task; message runs may steer or draft the vision. */
export function fakeLeadText(attemptId: string, trigger: "planning" | "message" | "decisions", prompt = ""): string {
  const proposals =
    trigger === "planning"
      ? [
          {
            title: `Simulated improvement ${attemptId}`,
            area: "Simulation",
            whyNow: "Simulated planning run: demonstrates a lead-authored task flowing through its pipeline.",
            outcome: "A small, verifiable improvement is delivered (simulated).",
            benefit: "Shows the autonomous loop end to end without cost.",
            scopeIncluded: ["One small change"],
            scopeExcluded: ["Anything else"],
            options: [
              { id: "A", name: "Small change", approach: "Make the smallest useful change", benefit: "Quick", effort: "Small", risks: "Low", reversibility: "High" },
              { id: "B", name: "Defer", approach: "Do nothing now", benefit: "No cost", effort: "None", risks: "No improvement", reversibility: "N/A" },
            ],
            recommendedOptionId: "A",
            rationale: "Smallest step that exercises the loop.",
            uncertainty: "Simulated; no real evidence.",
            acceptance: ["The simulated change completes review"],
            templateId: "change",
            priority: 5,
          },
        ]
      : [];
  const steer = trigger === "message" ? fakeSteer(prompt) : undefined;
  const vision = trigger === "message" ? fakeVision(prompt) : undefined;
  const shaping = trigger === "message" ? fakeShaping(prompt) : undefined;
  // ORC-013: the simulated lead accepts every finding routed to it, labelled; a real lead weighs each one.
  const decisions = decisionIds(prompt).map((id) => ({ id, decision: "accept", why: "(Simulated) Accepted as it is; in live mode a real lead weighs the finding against the task's outcome and the vision." }));
  const reply =
    trigger === "planning"
      ? "(Simulated lead) I reviewed the board and proposed one small task."
      : vision
        ? `(Simulated lead) Here is what I understand: ${newestMessage(prompt) ?? "your message"} (assumption: that is the whole problem). I drafted a living vision from it with marked assumptions, and I have three questions with suggested answers. Accept, edit or dismiss the draft; answer what you can. In live mode a real lead grounds all of this in your answers and the repository.`
        : steer
          ? "(Simulated lead) Noted the new direction. The service lists below what changed; in live mode a real lead weighs the board first."
          : decisions.length && trigger === "decisions"
            ? "(Simulated lead) I went through the findings waiting for me and accepted them as they are; the service lists each decision below. In live mode a real lead weighs each one."
            : "(Simulated lead) Noted. In live mode the lead answers here using the board and the repository.";
  return `${reply}\n\n\`\`\`json\n${JSON.stringify({ reply, proposals, ...(steer ? { steer } : {}), ...(vision ? { vision } : {}), ...(shaping ?? {}), ...(decisions.length ? { decisions } : {}) }, null, 2)}\n\`\`\`\n`;
}

function jitter(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 7);
}

/** ORC-013: the decisions the envelope lists as waiting for the lead ("- fd-12 on T-003 …"). */
function decisionIds(prompt: string): string[] {
  const section = /## Decisions waiting for you[^\n]*\n([\s\S]*?)\n## /.exec(prompt)?.[1] ?? "";
  return [...section.matchAll(/^- (fd-\d+) on /gm)].map((m) => m[1]);
}

/**
 * The final message a well-behaved worker would send: a JSON output block for every declared output.
 * ORC-013: a simulated review reports structured findings. The first round of a task's own review
 * finds one auto-fix finding, so the repair loop is visible once; the repaired round and every
 * dedicated pull-request review are clean. Deterministic, so a demo never waits on chance.
 */
export function fakeFinalText(attemptId: string, outputs: OutputDef[], stepId = "", taskId = ""): string {
  const block: Record<string, { summary: string; openFindings?: number; findings?: unknown[]; reviewedPaths?: string[] }> = {};
  for (const o of outputs) {
    if (o.kind === "review-findings") {
      const found = !/-i\d+$/.test(stepId) && !/-RV\d+$/.test(taskId) && !/-c\d+$/.test(stepId) ? 1 : 0;
      block[o.name] = {
        summary: found ? "1 finding (simulated)" : "No blocking findings (simulated)",
        findings: found ? [{ severity: "warning", action: "auto-fix", title: "Simulated finding: a small defect the repair step fixes", detail: "(Simulated) In live mode a real reviewer names the file, the line and the smallest fix.", file: "src/simulated.ts", line: 1 }] : [],
        reviewedPaths: [],
      };
    } else if (o.kind === "code-change") block[o.name] = { summary: "Simulated change; no files were touched" };
    else if (o.kind === "breakdown") {
      // First pass proposes two small items; later iterations report the goal as met.
      const items = /-i\d+$/.test(stepId)
        ? []
        : [
            { title: `Simulated part A (${attemptId})`, outcome: "Part A done (simulated)", approach: "Small change", acceptance: ["Part A verified"], templateId: "change", priority: 3 },
            { title: `Simulated part B (${attemptId})`, outcome: "Part B done (simulated)", approach: "Small change", acceptance: ["Part B verified"], templateId: "change", priority: 3, dependsOn: [0] },
          ];
      block[o.name] = { summary: items.length ? "Split into two parts (simulated)" : "Goal met (simulated)", items } as never;
    }
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
    if (a.role === "lead" && a.stepId === "LEAD") {
      if (this.procs.has(a.attemptId)) return;
      this.procs.set(a.attemptId, { progress: 0, outputs: [], lead: /^# Lead run \S+ \(planning\)/.test(a.prompt) ? "planning" : /^# Lead run \S+ \(decisions on findings\)/.test(a.prompt) ? "decisions" : "message", prompt: a.prompt });
      this.emit({ type: "started", attemptId: a.attemptId });
      return;
    }
    this.startAt(a.attemptId, a.outputs, 0);
    const p = this.procs.get(a.attemptId);
    if (p) {
      p.stepId = a.stepId;
      p.taskId = a.taskId;
    }
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
        this.emit({ type: "completed", attemptId: id, finalText: p.lead ? fakeLeadText(id, p.lead, p.prompt) : fakeFinalText(id, p.outputs, p.stepId, p.taskId) });
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
