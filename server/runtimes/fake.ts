// Fake runtime (simulated). It implements the same adapter contract as the real Claude and Codex
// adapters, so the scheduler exercises one path for both. Its "processes" live only in this
// service's memory; they vanish when the service stops, which lets restart reconciliation be tested
// honestly. It advances only when the scheduler calls tick(). No agent executes. A studio designer run writes a
// sample prototype into its staging folder (server/studio/sample.ts), which the service imports like a real one.

import type { AckMode } from "../../src/api";
import { NEUTRAL_FINDING, PLANNING_IDEAS, breakdownItems, neutralSummary, scriptedFinding, scriptedSummary } from "../../src/domain/demoScript";
import type { CatalogModel, OutputDef, ProviderId, State } from "../../src/domain/types";
import type { CapabilityMap } from "../../src/runtime/adapter";
import { writeSamplePrototype } from "../studio/sample";
import { statusAnswer, statusQuestion } from "./fakeStatus";
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
  /** The task's title, read from the envelope: names the parts of a goal when the story has none. */
  title?: string;
  interruptAt?: number;
  /** Lead runs answer with a reply (and, when planning, one proposal) instead of step outputs. */
  lead?: "planning" | "message" | "decisions";
  /** The lead envelope, kept so a simulated message run can steer from what it was shown. */
  prompt?: string;
  /** ORC-022: notes handed to this run, each acknowledged after `ticks` more ticks (a simulated delay). */
  notes?: { id: string; ticks: number }[];
  /** ORC-029: a studio designer run's staging folder, where it writes the sample prototype when it completes. */
  studio?: string;
}

/** ORC-022: how many ticks a simulated run takes to acknowledge a note (about two seconds in the service). */
export const NOTE_ACK_TICKS = 2;

/** Words that make the simulated lead treat a message as a change of direction. */
const DIRECTION_RE = /\bfocus\b| vs |\binstead\b|rather than/i;

// ORC-017: the fake runtime's text carries no "(Simulated)" prefix where a record already labels it: the run
// record (runtime "simulated"), the structured `simulated` flag on a focus change or a change set, and the
// banner on every page. Neutral fallbacks keep "(simulated)" where nothing else would label the text.

/**
 * ORC-022: a message that asks to pass something on to a coder or designer ("tell the coder on WT-002 to skip
 * the README"). It stays within one sentence; a dot followed by a digit (a child task id, "WT-004.2") is not a stop.
 */
const NOTE_RE = /\b(?:tell|ask|remind|let)\b(?:[^.?!]|\.(?=\d))*?\b(coder|designer)\b(?:[^.?!]|\.(?=\d))*?\b(?:to|that):?\s+((?:[^.?!]|\.(?=\d))+)/i;

/**
 * ORC-022: a simulated note, built only from the envelope: the newest message that asks to tell a coder or
 * designer something becomes a note to that role's running (else pending) step of the task the message
 * names, or of the first task on the board that has one. Nothing is sent to any other role.
 */
export function fakeNote(prompt: string, messages: string[]): { task: string; step: string; text: string } | undefined {
  const message = [...messages].reverse().find((m) => NOTE_RE.test(m));
  const m = message ? NOTE_RE.exec(message) : null;
  if (!m) return undefined;
  const role = m[1].toLowerCase();
  const text = m[2].trim();
  if (!text) return undefined;
  const named = /\b([A-Z]{1,6}-\d{1,4}(?:\.\d+)?)\b/.exec(message!)?.[1];
  // "- WT-002 [Running] … · steps: S1 coder running (Codex, run-12), S2 code_reviewer pending (Claude)" (child lines are indented).
  const lines = [...prompt.matchAll(/^(?:- |  child )(\S+) \[[^\]]*\].*· steps: ([^\n]*)$/gm)].map((x) => ({ id: x[1], steps: x[2] }));
  const pick = (line: { id: string; steps: string }) => {
    const steps = [...line.steps.matchAll(/(\S+) (\S+) (running|pending|paused|stopping) \(/g)].map((x) => ({ id: x[1], role: x[2], state: x[3] }));
    return steps.find((st) => st.role === role && st.state === "running") ?? steps.find((st) => st.role === role && st.state !== "stopping");
  };
  for (const line of lines) {
    if (named && line.id !== named) continue;
    const st = pick(line);
    if (st) return { task: line.id, step: st.id, text: `${text[0].toUpperCase()}${text.slice(1)}`.slice(0, 500) };
  }
  return undefined;
}

/**
 * ORC-009: a simulated steering block, built only from the envelope: the newest message that reads
 * like a change of direction becomes the focus, and the lowest-priority open task whose "may:" list
 * includes defer is deferred. ORC-022: a message that asks to tell a coder or designer something becomes
 * one note. Nothing else is touched.
 */
export function fakeSteer(prompt: string): Record<string, unknown> | undefined {
  const section = /## Messages to answer now\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? "";
  const messages = section
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(/^\(sent from [^)]*\) /, ""));
  const direction = [...messages].reverse().find((m) => DIRECTION_RE.test(m));
  const note = fakeNote(prompt, messages);
  if (!direction && !note) return undefined;
  const out: Record<string, unknown> = { reason: "Taken from your message.", tasks: [] };
  if (direction) {
    out.focus = direction.length > 200 ? `${direction.slice(0, 199)}…` : direction;
    let candidate: { id: string; priority: number } | undefined;
    for (const m of prompt.matchAll(/^- (\S+) \[[^\]]*\] P(\d+).*· may: ([^·\n]*)/gm)) {
      if (!m[3].split(",").some((a) => a.trim() === "defer")) continue;
      const p = Number(m[2]);
      if (!candidate || p > candidate.priority) candidate = { id: m[1], priority: p };
    }
    if (candidate) out.tasks = [{ id: candidate.id, defer: true, why: "The lowest-priority work that no longer fits the focus." }];
  }
  if (note) out.notes = [note];
  return out;
}

/** The task's title as the worker envelope states it ("## Task WT-004 (spec r1): Share a trip plan with friends"). */
export function taskTitleIn(prompt: string): string | undefined {
  return /^## Task \S+ \(spec r\d+\): (.+)$/m.exec(prompt)?.[1]?.trim() || undefined;
}

/** The newest message the lead must answer, from the envelope. */
function newestMessage(prompt: string): string | undefined {
  return newestMessageLine(prompt)?.text;
}

/** The newest message the lead must answer, with the task page it was sent from ("- (sent from WT-007 "…" [Running]) text"). */
function newestMessageLine(prompt: string): { text: string; fromTaskId?: string } | undefined {
  const section = /## Messages to answer now\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? "";
  const line = section
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .pop();
  if (!line) return undefined;
  const from = /^\(sent from (\S+) [^)]*\) /.exec(line.slice(2));
  return { text: line.slice(2).replace(/^\(sent from [^)]*\) /, ""), ...(from ? { fromTaskId: from[1] } : {}) };
}

/** The title the envelope's board gives a task ("- WT-002 [Ready] P1 "Show a clear offline state on the map" …"). */
function boardTitle(prompt: string, id: string): string | undefined {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:- |  child )${esc} \\[[^\\]]*\\][^"\\n]*"([^"\\n]*)"`, "m").exec(prompt)?.[1];
}

/** "the coder on “Show a clear offline state on the map”": who a simulated note went to, in the user's words. */
function noteRecipient(prompt: string, note: { task: string }): string {
  const message = newestMessage(prompt) ?? "";
  const role = NOTE_RE.exec(message)?.[1]?.toLowerCase() ?? "agent";
  const title = boardTitle(prompt, note.task);
  return `the ${role} on ${title ? `“${title}”` : note.task}`;
}

/** How many simulated shaping replies the conversation in the envelope already holds. */
function exchanges(prompt: string): number {
  const convo = /## Conversation \(most recent last\)\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? "";
  // Only the lead's own lines count; a user who quotes the phrase does not add an exchange.
  return (convo.match(/^Lead \([^)]*\): Here is what I understand/gm) ?? []).length;
}

/**
 * ORC-012: a simulated vision draft, built only from the envelope while the project is shaping. The newest
 * message becomes the problem statement and every other part is a marked assumption. The draft's body says it is
 * simulated and what the simulation did (nothing else labels a draft's text once it is the vision); the focus
 * and reason are labelled by the structured flag.
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
      "The simulation wrote this from your newest message alone: it restates the message and marks every other line as an assumption. It reads no document or code and does not carry earlier answers forward.",
    ].join("\n"),
    focus: short.length > 120 ? `${short.slice(0, 119)}…` : short,
    reason: n === 1 ? "A first living draft from your message; the assumptions are yours to confirm or change." : `Redrawn from your newest message after ${n} exchanges; the assumptions are yours to confirm or change.`,
  };
}

/** ORC-012: three simulated questions with reasons and options, and a simulated coverage that improves per exchange. */
function fakeShaping(prompt: string): { questions: Record<string, unknown>[]; coverage: Record<string, string> } | undefined {
  if (!/^Project stage: shaping$/m.test(prompt)) return undefined;
  const n = exchanges(prompt) + 1;
  const questions = [
    { question: "Who is this for first: you, a small team, or anyone?", why: "The first users decide the first milestone. I'd suggest you first, so it is usable soon.", area: "audience", options: ["Just me (recommended)", "A small team", "Anyone"] },
    { question: "How will you know it worked?", why: "A measure keeps the scope honest.", area: "outcome", options: ["I use it daily", "A first user does", "A number improves"] },
    { question: "What must it not do in the first version?", why: "Non-goals keep the scope in check.", area: "scope" },
  ];
  const coverage: Record<string, string> =
    n === 1
      ? { intent: "partial", audience: "open", problem: "partial", outcome: "open", scope: "open", constraints: "open", risks: "open", priorities: "open", material: "open" }
      : { intent: "clear", audience: "partial", problem: "clear", outcome: "partial", scope: "partial", constraints: "open", risks: "open", priorities: "partial", material: "open" };
  return { questions, coverage };
}

/**
 * The one task a simulated planning run proposes: the first idea of the story that is not on the board the
 * envelope shows, else a plain "Small improvement" numbered after the ones already there. Never a run id.
 */
export function fakePlanningProposal(prompt: string): Record<string, unknown> {
  const idea = PLANNING_IDEAS.find((i) => !prompt.toLowerCase().includes(i.title.toLowerCase()));
  const n = (prompt.match(/"Small improvement \d+"/g) ?? []).length + 1;
  const base = idea ?? {
    title: `Small improvement ${n}`,
    area: "Reliability",
    whyNow: "A planning run proposes one small, verifiable improvement so the loop can be seen end to end.",
    outcome: "One small improvement is delivered.",
    benefit: "Shows the autonomous loop end to end without cost.",
    approach: "Make the smallest useful change",
    acceptance: ["The change completes review"],
  };
  return {
    title: base.title,
    area: base.area,
    whyNow: base.whyNow,
    outcome: base.outcome,
    benefit: base.benefit,
    scopeIncluded: ["One small change"],
    scopeExcluded: ["Anything else"],
    options: [
      { id: "A", name: "As planned", approach: base.approach, benefit: "Quick", effort: "Small", risks: "Low", reversibility: "High" },
      { id: "B", name: "Defer", approach: "Do nothing now", benefit: "No cost", effort: "None", risks: "No improvement", reversibility: "N/A" },
    ],
    recommendedOptionId: "A",
    rationale: "The smallest step that moves the product (simulated planning: no real evidence).",
    uncertainty: "Simulated; no real evidence.",
    acceptance: base.acceptance,
    flowId: "change",
    priority: 5,
  };
}

/**
 * A simulated lead reply in the required JSON shape. Planning runs propose one small task; message runs may steer
 * or draft the vision. ORC-025 (L3): a message run that only asks about the board ("what needs me?", "how is
 * offline maps going?") is answered from `board`, the service's state now (fakeStatus.ts); without it (unit tests
 * of the text alone), the reply says what the demo lead can do.
 */
export function fakeLeadText(attemptId: string, trigger: "planning" | "message" | "decisions", prompt = "", board?: State, nowMs = Date.now()): string {
  void attemptId; // never part of any title or text
  const proposals = trigger === "planning" ? [fakePlanningProposal(prompt)] : [];
  const steer = trigger === "message" ? fakeSteer(prompt) : undefined;
  const vision = trigger === "message" ? fakeVision(prompt) : undefined;
  const shaping = trigger === "message" ? fakeShaping(prompt) : undefined;
  // ORC-013: the simulated lead accepts every finding routed to it; a real lead weighs each one.
  // ORC-029 2d: the decisions it takes as the PE state their cost; accepting adds none.
  const decisions = [
    ...decisionIds(prompt).map((id) => ({ id, decision: "accept", why: "Accepted as it is: the demo's lead accepts every finding it is asked to decide, without weighing it." })),
    ...decisionIds(prompt, "Decisions you make as the PE").map((id) => ({
      id,
      decision: "accept",
      why: "Accepted as it is: the demo's lead, deciding as the PE, accepts every finding without weighing it.",
      cost: { buildUsd: [0, 0], maintenanceUsdPerMonth: [0, 0], basis: "Accepting changes nothing, so nothing is built or run (simulated)" },
    })),
  ];
  const newest = newestMessageLine(prompt);
  const question = trigger === "message" && !vision && !steer && board && newest ? statusQuestion(board, newest.text, newest.fromTaskId) : undefined;
  const notes = (steer?.notes ?? []) as { task: string }[];
  // The reply carries the simulated chip; the text says only what happened.
  const reply =
    trigger === "planning"
      ? "I reviewed the board and proposed one small task."
      : vision
        ? `Here is what I understand: ${newestMessage(prompt) ?? "your message"} (assumption: that is the whole problem). I drafted a vision from your words with the assumptions marked, and three questions with suggested answers. Accept, edit or dismiss the draft, and answer what you can.`
        : // The envelope's rule for every lead: never claim a change in the reply; the service's list under it says what happened.
          steer && !steer.focus
          ? `I asked to pass your note on to ${notes.length ? noteRecipient(prompt, notes[0]) : "the agent"}. The line under this reply shows whether it was sent and has reached them.`
          : steer
            ? `Noted the new direction. I asked to make your words the focus${(steer.tasks as unknown[]).length ? " and to defer the lowest-priority work that no longer fits it" : ""}${notes.length ? `, and to pass your note on to ${noteRecipient(prompt, notes[0])}` : ""}. The line under this reply shows what the service applied.`
          : decisions.length && trigger === "decisions"
            ? "I accepted every finding that was waiting for me as it is, without weighing it; the service lists each decision below."
            : question && board
              ? statusAnswer(board, question, nowMs)
              : "Noted; I changed nothing. Ask me what is running, what needs you or how a task is going; tell me what to focus on; or ask me to tell the coder on a task something.";
  return `${reply}\n\n\`\`\`json\n${JSON.stringify({ reply, proposals, ...(steer ? { steer } : {}), ...(vision ? { vision } : {}), ...(shaping ?? {}), ...(decisions.length ? { decisions } : {}) }, null, 2)}\n\`\`\`\n`;
}

function jitter(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 7);
}

/** ORC-013: the decisions the envelope lists under a heading ("- fd-12 on T-003 …"): the lead's, or those it takes as the PE. */
function decisionIds(prompt: string, heading = "Decisions waiting for you"): string[] {
  const section = new RegExp(`## ${heading}[^\\n]*\\n([\\s\\S]*?)\\n## `).exec(prompt)?.[1] ?? "";
  return [...section.matchAll(/^- (fd-\d+) on /gm)].map((m) => m[1]);
}

/**
 * The final message a well-behaved worker would send: a JSON output block for every declared output.
 * ORC-017: the words come from the story's per-task script (`demoScript.ts`) and fall back to neutral
 * wording; a run id is never part of a title or a summary. ORC-013: a simulated review reports structured
 * findings. The first round of a task's own review finds one auto-fix finding, so the repair loop is
 * visible once; the repaired round and every dedicated pull-request review are clean. Deterministic, so a
 * demo never waits on chance. `title` is the task's title, for the parts of a goal the story does not name.
 */
export function fakeFinalText(attemptId: string, outputs: OutputDef[], stepId = "", taskId = "", title?: string): string {
  void attemptId; // never part of any title or summary
  const block: Record<string, { summary: string; openFindings?: number; findings?: unknown[]; reviewedPaths?: string[]; items?: unknown[] }> = {};
  for (const o of outputs) {
    const scripted = scriptedSummary(taskId, stepId, o.name);
    if (o.kind === "review-findings") {
      const found = !/-i\d+$/.test(stepId) && !/-RV\d+$/.test(taskId) && !/-c\d+$/.test(stepId) ? 1 : 0;
      const f = scriptedFinding(taskId, stepId) ?? NEUTRAL_FINDING;
      block[o.name] = {
        summary: scripted ?? neutralSummary(o.kind, { found }),
        findings: found ? [{ severity: "warning", action: "auto-fix", title: f.title, detail: f.detail, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}) }] : [],
        reviewedPaths: [],
      };
    } else if (o.kind === "breakdown") {
      // A first pass proposes the story's parts (or two neutral ones named after the goal); later iterations report the goal as met.
      const items = /-i\d+$/.test(stepId) ? [] : breakdownItems(taskId, stepId, title);
      block[o.name] = { summary: scripted ?? neutralSummary(o.kind, { items: items.length }), items };
    } else block[o.name] = { summary: scripted ?? neutralSummary(o.kind) };
  }
  return `Done (simulated).\n\n\`\`\`json\n${JSON.stringify({ outputs: block }, null, 2)}\n\`\`\`\n`;
}

const CAPABILITIES: CapabilityMap = {
  start: "simulated",
  streamEvents: "simulated",
  // ORC-022: notes to a running simulated agent are acknowledged after a simulated delay.
  steer: "simulated",
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
  /** ORC-025 (L3): reads the service's state, so the simulated lead can answer "what needs me?" from the board. Read-only. */
  private board?: () => State;

  constructor(provider: ProviderId, config: FakeRuntimeConfig = defaultFakeConfig(), catalog: CatalogModel[] = [], board?: () => State) {
    this.provider = provider;
    this.config = config;
    this.catalog = catalog;
    this.board = board;
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
    if (a.studio) {
      if (this.procs.has(a.attemptId)) return;
      this.procs.set(a.attemptId, { progress: 0, outputs: [], studio: a.workspace.path });
      this.emit({ type: "started", attemptId: a.attemptId });
      return;
    }
    this.startAt(a.attemptId, a.outputs, 0);
    const p = this.procs.get(a.attemptId);
    if (p) {
      p.stepId = a.stepId;
      p.taskId = a.taskId;
      p.title = taskTitleIn(a.prompt);
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

  /**
   * ORC-022: a simulated agent takes the note and acknowledges it after a short delay (`NOTE_ACK_TICKS`). A
   * run that is stopping or gone answers "not delivered" at once; one that ends before the delay is up
   * answers so when it ends. Never throws; exactly one event per note.
   */
  note(attemptId: string, note: { id: string; text: string }): void {
    const p = this.procs.get(attemptId);
    if (!p || p.interruptAt !== undefined) {
      this.emit({ type: "note", attemptId, noteId: note.id, outcome: "not-delivered", reason: p ? "the run was stopping" : "the run had finished" });
      return;
    }
    (p.notes ??= []).push({ id: note.id, ticks: NOTE_ACK_TICKS });
  }

  /** Every note the run has not acknowledged yet is answered "not delivered" with the reason (the run ended or stopped first). */
  private dropNotes(attemptId: string, p: Proc, reason: string) {
    for (const n of p.notes ?? []) this.emit({ type: "note", attemptId, noteId: n.id, outcome: "not-delivered", reason });
    p.notes = [];
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
        // A stop request supersedes the notes: none is acknowledged once the run is stopping.
        this.dropNotes(id, p, "the run stopped first");
        if (this.config.ackMode === "normal" && nowMs - p.interruptAt >= this.config.ackDelayMs) {
          this.procs.delete(id);
          this.emit({ type: "stopped", attemptId: id, how: "interrupted" });
        }
        continue;
      }
      // ORC-022: notes are acknowledged before the run makes progress, so a note sent in time reaches the agent.
      for (const n of [...(p.notes ?? [])]) {
        n.ticks -= 1;
        if (n.ticks > 0) continue;
        p.notes = p.notes!.filter((x) => x.id !== n.id);
        this.emit({ type: "note", attemptId: id, noteId: n.id, outcome: "delivered" });
      }
      p.progress = Math.min(100, p.progress + this.config.progressPerTick + jitter(id));
      if (p.progress >= 100) {
        this.dropNotes(id, p, "the run ended first");
        this.procs.delete(id);
        if (p.studio !== undefined) {
          // A simulated designer writes the sample prototype and its studio.json, which the service imports as a real one's.
          try {
            writeSamplePrototype(p.studio);
          } catch (e) {
            this.emit({ type: "failed", attemptId: id, message: `The simulated designer could not write its sample: ${e instanceof Error ? e.message : String(e)}` });
            continue;
          }
          this.emit({ type: "completed", attemptId: id, finalText: "Made the trip plan in two variants, for desktop and mobile (simulated sample)." });
          continue;
        }
        this.emit({ type: "completed", attemptId: id, finalText: p.lead ? fakeLeadText(id, p.lead, p.prompt, p.lead === "message" ? this.board?.() : undefined, nowMs) : fakeFinalText(id, p.outputs, p.stepId, p.taskId, p.title) });
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
