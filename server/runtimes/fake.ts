// Fake runtime (simulated). It implements the same adapter contract as the real Claude and Codex
// adapters, so the scheduler exercises one path for both. Its "processes" live only in this
// service's memory; they vanish when the service stops, which lets restart reconciliation be tested
// honestly. It advances only when the scheduler calls tick(). No agent executes. A studio designer run writes a
// sample prototype into its staging folder (server/studio/sample.ts), which the service imports like a real one, and
// a revision marks the variants its brief names; a studio PE run answers with simulated verdicts on the version it
// was given.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AckMode } from "../../src/api";
import { schemaMismatch, withNulls, type JsonSchema } from "../../src/domain/model/leadReplySchema";
import { DOCUMENT_KINDS, type StudioArtifactKind } from "../../src/domain/studio/types";
import { NEUTRAL_FINDING, PLANNING_IDEAS, breakdownItems, neutralSummary, scriptedFinding, scriptedSummary } from "../../src/domain/demoScript";
import { DEVICES, type CatalogModel, type Device, type LeadTrigger, type OutputDef, type ProviderId, type State } from "../../src/domain/types";
import type { CapabilityMap } from "../../src/runtime/adapter";
import { TERMINAL_BRIEF, addDictionarySample, addFlowRules, askedKinds, asksForRules, designerAsk, fakePeAnswer, reviseSample, variantsToRevise, writeSamplePrototype, writeTerminalSample } from "../studio/sample";
import { TALLY_FIXTURE } from "../studio/import";
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
  lead?: LeadTrigger;
  /** The lead envelope, kept so a simulated message run can steer from what it was shown. */
  prompt?: string;
  /** The output schema a lead run's answer must match, when the service gave one. */
  outputSchema?: Record<string, unknown>;
  /** ORC-022: notes handed to this run, each acknowledged after `ticks` more ticks (a simulated delay). */
  notes?: { id: string; ticks: number }[];
  /**
   * ORC-029: a studio run's working directory: a designer's staging folder, where it writes the sample prototype when
   * it completes, or the folder of the version a PE run reviews (read only).
   */
  studio?: string;
  /** ORC-029: a studio run's role: the designer hands in a sample, the PE answers with verdicts. */
  studioRole?: "designer" | "pe";
}

/** ORC-022: how many ticks a simulated run takes to acknowledge a note (about two seconds in the service). */
export const NOTE_ACK_TICKS = 2;

/**
 * The most ticks a simulated lead run takes, whatever the steps' pace (fewer when steps are faster): a reply, not a
 * step of work. At a step's pace a note the owner sent through the lead reached a coder that had just finished, in
 * most tries (ORC-030 QA, Q-14).
 */
export const LEAD_TICKS = 2;

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

const FOCUS_ORDER = ["experience", "data", "flows"] as const;
const FOCUS_WORDS: Record<string, string> = { "what exists": "material", "the experience": "experience", "the data": "data", "the flows": "flows" };

/**
 * ORC-029 pass 4: a simulated studio block, built only from the lead's studio brief in the envelope (a reply in
 * Vision). When no round is open it plans the next one and asks for one designer run and one question, so the demo
 * shows the loop: the next focus in order (the experience, then the data, then the flows). While a round is open, or
 * the import is under way (ORC-032: the import makes round 0), it plans nothing. Every text says it is simulated.
 */
export function fakeStudio(prompt: string): Record<string, unknown> | undefined {
  // The simulated lead runs the studio in Vision only: while the factory runs it gets the studio brief too (pass 5), but
  // it cannot tell a message about the design from one about the work, so it opens no round there.
  if (!/^Project stage: shaping$/m.test(prompt) || !/^## The studio$/m.test(prompt) || !/^- No round is open\./m.test(prompt)) return undefined;
  if (/^The import of the repository at commit \S+ is (reading|in review):/m.test(prompt)) return undefined;
  const scope = (/^Devices \(the user's scope\): ([^\n]*)\.$/m.exec(prompt)?.[1] ?? "desktop").split(", ");
  const screens = scope.filter((d) => d === "desktop" || d === "mobile");
  const done = [...prompt.matchAll(/^- Round \d+ \(([^)]*)\), closed/gm)].map((m) => FOCUS_WORDS[m[1]]);
  const focus = FOCUS_ORDER.find((f) => !done.includes(f));
  if (!focus) return undefined;
  const run =
    focus === "experience"
      ? screens.length
        ? { brief: "Simulated lead: make the main screen of the vision in two takes that differ in a real choice.", kinds: ["screen"], variants: 2, devices: screens }
        : { brief: "Simulated lead: make a terminal demo of the main command.", kinds: ["terminal-demo"], variants: 1, devices: ["terminal"] }
      : focus === "data"
        ? { brief: "Simulated lead: describe the product's things and how they relate, with a worked example, and propose the project's dictionary.", kinds: ["contract", "dictionary"], variants: 1, devices: [] }
        : { brief: "Simulated lead: decide every case of the main flow, as a table of cases and outcomes.", kinds: ["flow"], variants: 1, devices: [] };
  const summary = {
    experience: "The experience (simulated): the main screen, in two takes.",
    data: "The data (simulated): the product's things and how they relate.",
    flows: "The flows (simulated): every case of the main flow, decided.",
  }[focus];
  // The owner chooses the domains in the app; the brief tells the lead not to ask about them.
  const question = { question: "Is anything missing from this round? (simulated)", why: "A case the design leaves open becomes special-casing in code.", options: ["Nothing is missing", "Yes: see my note"] };
  return { openRound: { focus, summary }, designerRuns: [run], questions: [question] };
}

/**
 * ORC-032: the simulated lead's message once the import is in review, built only from its envelope's import line: what
 * the import found, that the questions wait in Vision, and a vision draft of the product as it is today. Labelled
 * simulated. Undefined when the import is not in review.
 */
export function fakeImportReview(prompt: string): { reply: string; vision: Record<string, unknown> } | undefined {
  const m = /^The import of the repository at commit (\S+) is in review: ([^\n]*)$/m.exec(prompt);
  if (!m) return undefined;
  const found = m[2].replace(/\.$/, "");
  return {
    reply: `I read the repository at commit ${m[1]} as it is today: ${found}. The questions wait in Vision, round 0: answer the conflicts and the guesses that matter, then lock the baseline in (simulated).`,
    vision: {
      text: [`(Simulated draft) What the product is today, from the import at commit ${m[1]}: ${found}.`, "", "The simulation wrote this from the import's counts alone; it reads no code."].join("\n"),
      focus: "What the product is today",
      reason: "A first draft from the import, for you to accept on the Baseline screen.",
    },
  };
}

/** One of the owner's marks the lead's studio brief lists since its last reply. */
interface StudioMark {
  id: string;
  title: string;
  version: number;
  /** "change", "keep", "drop" or "no mark". */
  mark: string;
  note?: string;
}

/** The owner's marks, picks and notes since the lead's last reply: "- art-1 "Trip plan" v2: change; picked a; note: "…"". */
function studioMarks(prompt: string): StudioMark[] {
  const section = /^The user's marks, picks, pins and notes since your last reply[^\n]*\n([\s\S]*?)\n\n/m.exec(prompt)?.[1] ?? "";
  return [...section.matchAll(/^- (\S+) "([^"\n]*)" v(\d+): ([^;\n]+)(.*)$/gm)].map(([, id, title, version, mark, rest]) => {
    const note = /note: "(.*)"$/.exec(rest)?.[1];
    return { id, title, version: Number(version), mark, ...(note ? { note } : {}) };
  });
}

/**
 * ORC-030 QA (Q-07): the simulated lead answers the owner's marks, as the README's loop has it. Each part marked Change
 * gets one designer run that makes its next version (`revises`), briefed with the owner's note; Keep and Drop need
 * nothing from the designer. Only in an open round, where designer runs go. Read only from the envelope.
 */
function fakeMarksAnswer(prompt: string, marks: StudioMark[]): { text: string; studio?: Record<string, unknown> } {
  const open = /^- Round \d+ \([^)]*\), open:/m.test(prompt);
  const scope = (/^Devices \(the user's scope\): ([^\n]*)\.$/m.exec(prompt)?.[1] ?? "").split(", ");
  const changed = open ? marks.filter((m) => m.mark === "change").slice(0, 3) : [];
  const designerRuns = changed.map((m) => {
    // The part's line under the open round: "  - art-1 "Trip plan" v2 · screen · 2 variants: a …, b … · desktop, mobile · PE agreed".
    const parts = (new RegExp(`^ {2}- ${m.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} "[^"\\n]*" v\\d+ · (.*)$`, "m").exec(prompt)?.[1] ?? "").split(" · ");
    const variants = Number(/^(\d+) variants:/.exec(parts.find((p) => /^\d+ variants:/.test(p)) ?? "")?.[1] ?? 1);
    const devices = (parts.find((p) => p.split(", ").every((d) => DEVICES.includes(d as Device))) ?? "").split(", ").filter((d) => scope.includes(d));
    const why = m.note ? ` The owner's note: ${m.note}` : "";
    return { brief: `Simulated lead: make the next version of ${m.title}, as the owner marked it Change.${why}`, revises: m.id, variants: Math.min(Math.max(variants, 1), 3), devices: DOCUMENT_KINDS.includes(parts[0] as StudioArtifactKind) ? [] : devices };
  });
  const others = marks.filter((m) => !changed.includes(m) && m.mark !== "no mark");
  const word = (m: StudioMark) => (m.mark === "keep" ? "stays as it is" : m.mark === "drop" ? "is dropped" : "waits for a round to change it in");
  const text = [
    ...changed.map((m) => `I asked the designer for the next version of ${m.title}${m.note ? ", with your note" : ""}.`),
    ...(others.length ? [`Noted your marks: ${others.map((m) => `${m.title} ${word(m)}`).join("; ")}.`] : []),
  ].join(" ");
  return { text: text || "Noted your feedback.", ...(designerRuns.length ? { studio: { designerRuns } } : {}) };
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
 * ORC-029 pass 5: the simulated lead's revisions of the work the PE sent back, read only from the envelope's "Work the
 * PE sent back" section: for each task, its title as it was and "revises" naming it, with the outcome noting the change.
 * The simulated lead makes no real change: the stand-in proposal only says it made one.
 */
export function fakeRevisions(prompt: string): Record<string, unknown>[] {
  const at = prompt.indexOf("\n## Work the PE sent back (");
  if (at < 0) return [];
  const section = prompt.slice(at + 1).split("\n## ")[0];
  return [...section.matchAll(/^- (\S+) "([^"\n]*)" \(spec r\d+\), round \d+ of \d+: /gm)].map(([, id, title]) => ({
    title,
    area: null,
    whyNow: "The PE asked for a change before the work starts.",
    outcome: `${title}, with the change the PE asked for (simulated revision).`,
    benefit: null,
    scopeIncluded: ["The change the PE asked for"],
    scopeExcluded: ["Anything the PE did not ask for"],
    options: [
      { id: "A", name: "As revised", approach: "Make the change the PE asked for, and nothing else", benefit: "The PE's concern is met", effort: "Small", risks: "Low", reversibility: "High" },
      { id: "B", name: "Defer", approach: "Do nothing now", benefit: "No cost", effort: "None", risks: "No improvement", reversibility: "N/A" },
    ],
    recommendedOptionId: "A",
    rationale: "The PE's change, made as asked (simulated: no real evidence).",
    uncertainty: "Simulated; no real evidence.",
    acceptance: ["The change completes review"],
    flowId: null,
    priority: null,
    revises: id,
  }));
}

/** A simulated proposal for a change order's update: the whole proposal, labelled as simulated. */
function fakeChangeProposal(title: string, refs: string[], outcome: string): Record<string, unknown> {
  return {
    title,
    area: null,
    whyNow: "The owner locked in a change to the design.",
    outcome: `${outcome} (simulated: no agent read the design).`,
    benefit: null,
    scopeIncluded: ["What the locked-in design changed"],
    scopeExcluded: ["Anything the design did not change"],
    options: [
      { id: "A", name: "Build the change", approach: "Build what the version in force shows", benefit: "The factory builds the design in force", effort: "Small", risks: "Low", reversibility: "High" },
      { id: "B", name: "Defer", approach: "Do nothing now", benefit: "No cost", effort: "None", risks: "The factory builds an old design", reversibility: "N/A" },
    ],
    recommendedOptionId: "A",
    rationale: "The owner's Lock in changed what this builds (simulated: no real evidence).",
    uncertainty: "Simulated; no real evidence.",
    acceptance: ["It matches the version in force"],
    flowId: null,
    priority: null,
    blueprintRefs: refs,
    revises: null,
  };
}

/**
 * ORC-029 pass 5 (5b): the simulated lead's answer to the change order its brief lists, read only from the brief. Each
 * touched task gets the update the brief names: one spec update, one revision task, one retirement (and as many of
 * each as the change order has); each new item gets one new task. Undefined when the brief lists no change order.
 */
export function fakeChangeOrder(prompt: string): { rev: number; updates: Record<string, unknown>[] } | undefined {
  const head = /^## Change order r(\d+): /m.exec(prompt);
  if (!head) return undefined;
  const rev = Number(head[1]);
  const section = prompt.slice(head.index + 3).split("\n## ")[0];
  const updates: Record<string, unknown>[] = [];
  const tasks = section.matchAll(/^- (\S+) "([^"\n]*)" \[[^\]\n]*\]: cites (.*?)\. Planned at the Lock in: [^\n]*\. Your update: "(update-spec|revise|retire)"\.$(?:\n {2}The user chose option ("[^"\n]*") of this task: name ("(?:[^"\\\n]|\\.)*"), approach ("(?:[^"\\\n]|\\.)*")\.)?/gm);
  for (const [, task, title, cites, action, chosenId, chosenName, chosenApproach] of tasks) {
    const approved = [...cites.matchAll(/(\S+) \((?:changed|added|unchanged)\)/g)].map((m) => m[1]);
    if (action === "retire") updates.push({ action, task, why: "Simulated: it builds only parts the owner dropped.", proposal: null });
    else if (action === "update-spec") {
      const proposal = fakeChangeProposal(title, approved, `${title}, as the version in force shows`);
      // The simulated lead keeps the option the owner chose as it is, as its brief asks.
      if (chosenId) {
        const kept = { id: JSON.parse(chosenId) as string, name: JSON.parse(chosenName) as string, approach: JSON.parse(chosenApproach) as string };
        proposal.options = [kept, ...(proposal.options as { id: string }[]).filter((o) => o.id !== kept.id)];
      }
      updates.push({ action, task, why: "Simulated: its spec now builds the version in force.", proposal });
    }
    else updates.push({ action, task, why: "Simulated: a revision builds the change on top of the work.", proposal: fakeChangeProposal(`Revise ${title} (change order r${rev})`, approved, `${title} changed as the version in force shows`) });
  }
  for (const [, item, title] of section.matchAll(/^- (\S+) \S+ "([^"\n]*)" v\d+[^\n]*: no task cites it yet\. Your update: "new-task", citing \S+\.$/gm)) {
    updates.push({ action: "new-task", task: null, why: "Simulated: the owner added it, and no task builds it yet.", proposal: fakeChangeProposal(`Build ${title} (change order r${rev})`, [item], `${title}, as the version in force shows`) });
  }
  return { rev, updates };
}

/**
 * ORC-029 pass 5: a simulated PE's verdict on new work in the factory, read only from its envelope. A proposal the lead
 * has not revised yet gets one change and one open case, so the loop shows the lead revising and a question going to
 * the owner; a revision gets feasible, with each earlier ask met; a breakdown or a design gets feasible at once.
 */
export function fakeNewWorkPeAnswer(prompt: string): string {
  const reasons = "Simulated: the fake runtime's PE, not an agent. It judged nothing about feasibility, scale, longevity or budget;";
  const asks = [...prompt.matchAll(/^- `(r\d+)`, round \d+, /gm)].map((m) => m[1]);
  const proposal = /^# PE review run \S+: new work in the factory, a task the lead proposes/m.test(prompt);
  const verdict = asks.length
    ? { earlier: asks.map((ask) => ({ ask, met: true })), verdict: "feasible", reasons: `${reasons} it finds each earlier ask met.` }
    : proposal
      ? {
          verdict: "feasible-if",
          reasons: `${reasons} it asks for a change on the lead's first take, so the loop shows the lead revising.`,
          change: "Simulated: a stand-in change, which the simulated lead makes in a revision.",
          openCases: [{ text: "Simulated: should this work wait for the friends' confirmations, or start at once?", why: "Simulated: a stand-in question, so an open case goes to the owner through the lead." }],
        }
      : { verdict: "feasible", reasons: `${reasons} it agrees so the work can go on.` };
  return `Simulated PE review of new work: no agent read it.\n\n\`\`\`json\n${JSON.stringify({ verdicts: [verdict] }, null, 2)}\n\`\`\`\n`;
}

/**
 * A simulated lead reply in the required JSON shape, as text: the reply, then the object in a fenced JSON block (what a
 * lead sends when its runtime applies no output schema).
 */
export function fakeLeadText(attemptId: string, trigger: LeadTrigger, prompt = "", board?: State, nowMs = Date.now()): string {
  const out = fakeLeadReply(attemptId, trigger, prompt, board, nowMs);
  return `${String(out.reply)}\n\n\`\`\`json\n${JSON.stringify(out, null, 2)}\n\`\`\`\n`;
}

/**
 * A simulated lead reply: the object a lead sends. Planning runs propose one small task; message runs may steer
 * or draft the vision. ORC-025 (L3): a message run that only asks about the board ("what needs me?", "how is
 * offline maps going?") is answered from `board`, the service's state now (fakeStatus.ts); without it (unit tests
 * of the text alone), the reply says what the demo lead can do.
 */
export function fakeLeadReply(attemptId: string, trigger: LeadTrigger, prompt = "", board?: State, nowMs = Date.now()): Record<string, unknown> {
  void attemptId; // never part of any title or text
  // ORC-029 pass 5: the work the PE sent back, which the run was shown whatever started it, revised as asked.
  const revisions = fakeRevisions(prompt);
  const proposals = [...(trigger === "planning" ? [fakePlanningProposal(prompt)] : []), ...revisions];
  // A message that carries the owner's marks is answered by them (Q-07): no steer, vision draft or questions from it.
  const marks = trigger === "message" ? studioMarks(prompt) : [];
  // ORC-032: once the import is in review, the lead's message says what it found, with a vision draft of the product today.
  const review = trigger === "message" && !marks.length ? fakeImportReview(prompt) : undefined;
  const answer = marks.length ? fakeMarksAnswer(prompt, marks) : review ? { text: review.reply, studio: undefined } : undefined;
  const steer = trigger === "message" && !answer ? fakeSteer(prompt) : undefined;
  const vision = review?.vision ?? (trigger === "message" && !answer ? fakeVision(prompt) : undefined);
  const shaping = trigger === "message" && !answer ? fakeShaping(prompt) : undefined;
  const studio = trigger === "message" ? (answer?.studio ?? fakeStudio(prompt)) : undefined;
  // ORC-029 pass 5 (5b): a run started for a change order answers it with an update per touched task.
  const changeOrder = trigger === "change-order" ? fakeChangeOrder(prompt) : undefined;
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
  // ORC-029 pass 4: what the simulated lead asked of the studio, said after the rest of the reply.
  const round = studio?.openRound as { focus: string } | undefined;
  const studioLine = round
    ? ` I opened a round on the ${round.focus} and asked the designer for one run, with one question beside it (simulated).`
    : "";
  // The reply carries the simulated chip; the text says only what happened.
  const replyText = changeOrder
    ? `I answered change order r${changeOrder.rev} with ${changeOrder.updates.length} update${changeOrder.updates.length === 1 ? "" : "s"}, one for each task it touches and each new item. The list under this reply shows what the service applied.`
    : trigger === "pe-review"
      ? `I revised ${revisions.length === 1 ? "the task" : `the ${revisions.length} tasks`} the PE sent back, making the change it asked for; the PE reviews ${revisions.length === 1 ? "it" : "them"} again.`
      : trigger === "planning"
      ? "I reviewed the board and proposed one small task."
      : answer
        ? answer.text
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
  const reply = `${replyText}${studioLine}`;
  return { reply, proposals, ...(steer ? { steer } : {}), ...(vision ? { vision } : {}), ...(shaping ?? {}), ...(decisions.length ? { decisions } : {}), ...(studio ? { studio } : {}), ...(changeOrder ? { changeOrder } : {}) };
}

/**
 * The simulated lead's answer under an output schema, as a constrained model gives it: the object with every field the
 * schema names (null where the lead left it out), as JSON. An object the schema refuses fails the run, so the simulated
 * loop proves the schema accepts what the simulated lead sends.
 */
export function fakeLeadAnswer(reply: Record<string, unknown>, schema: Record<string, unknown>): { ok: true; json: string } | { ok: false; why: string } {
  const answer = withNulls(schema as JsonSchema, reply);
  const why = schemaMismatch(schema as JsonSchema, answer);
  return why ? { ok: false, why } : { ok: true, json: JSON.stringify(answer) };
}

// ---------- the simulated designer's documents (ORC-029 pass 4) ----------

/** The document kind a designer's brief asks for, when every kind it names is a document ("The lead asks for: contract; …"). */
export function documentAsk(brief: string): StudioArtifactKind | undefined {
  // The project's dictionary is handed in beside a document, not instead of one (pass 4d).
  const kinds = (askedKinds(brief) as StudioArtifactKind[]).filter((k) => k !== "dictionary");
  return kinds.length && kinds.every((k) => DOCUMENT_KINDS.includes(k)) ? kinds[0] : undefined;
}

// ---------- the simulated import of tally (ORC-032) ----------

/**
 * tally's parts as the simulated parts designer hands them in, from the bundled fixture (server/studio/fixtures/tally/
 * parts): each with its kind, its entry, the repository files it came from, and the rules' area it holds.
 */
const TALLY_PARTS = [
  { key: "add", area: "tally add", kind: "terminal-demo", title: "tally add", entry: "add/demo.tape", devices: ["terminal"], provenance: ["tally/cli.py", "tally/ledger.py"] },
  { key: "split", area: "tally split", kind: "terminal-demo", title: "tally split", entry: "split/demo.tape", devices: ["terminal"], provenance: ["tally/cli.py", "tally/settle.py"] },
  { key: "report", area: "tally report", kind: "terminal-demo", title: "tally report", entry: "report/demo.tape", devices: ["terminal"], provenance: ["tally/cli.py", "tally/report.py"] },
  { key: "splitting", area: "splitting", kind: "algorithm", title: "Splitting", entry: "splitting/splitting.md", devices: [], provenance: ["tally/settle.py", "tally/money.py"] },
  { key: "ledger", area: "the ledger", kind: "contract", title: "The ledger", entry: "ledger/ledger.md", devices: [], provenance: ["tally/ledger.py"] },
] as const;

/**
 * The simulated rules reader's answer: tally's 17 rules (the fixture's reading.json), each naming only the tests its
 * envelope lists, so none when the tests did not run. It reads no code.
 */
export function fakeReaderAnswer(prompt: string): string {
  const listed = new Set([...prompt.matchAll(/^- (\S+::\S+)$/gm)].map((m) => m[1]));
  const { rules } = JSON.parse(readFileSync(join(TALLY_FIXTURE, "reading.json"), "utf8")) as { rules: { tests: string[] }[] };
  const out = rules.map((r) => ({ ...r, tests: r.tests.filter((t) => listed.has(t)) }));
  return `Read the repository's tests and code (simulated: the fake runtime gives tally's rules).\n\n\`\`\`json\n${JSON.stringify({ rules: out }, null, 2)}\n\`\`\`\n`;
}

/**
 * The simulated import designer: tally's words (one dictionary), or its parts, each with the rules its envelope lists
 * for it placed once, unchanged (a rule of an area no part has goes to the first part). Copied from the bundled
 * fixture, with provenance, as a designer agent would write them. Returns its final message.
 */
export function writeImportSample(staging: string, prompt: string): string {
  const parts = join(TALLY_FIXTURE, "parts");
  const manifest = (artifacts: Record<string, unknown>[]) => writeFileSync(join(staging, "studio.json"), `${JSON.stringify({ artifacts }, null, 2)}\n`);
  if (/^## The import: the words$/m.test(prompt)) {
    writeFileSync(join(staging, "dictionary.json"), readFileSync(join(parts, "words", "dictionary.json")));
    manifest([{ kind: "dictionary", title: "Words", devices: [], variants: [{ id: "a", label: "As it is today", entry: "dictionary.json" }], files: ["dictionary.json"], provenance: ["README.md", "tally/cli.py"] }]);
    return "Collected tally's words from the README and the code (simulated sample).";
  }
  const section = /^The rules the reader found \(\d+\):\n((?:- .*\n?)*)/m.exec(prompt)?.[1] ?? "";
  const rules = [...section.matchAll(/^- (\S+) \((.*?)\): (.*?)(?: \[tests: ([^\]]*)\])?$/gm)].map(([, id, area, text, tests]) => ({ id, area, text, tests: tests ? tests.split(", ") : [] }));
  const artifacts = TALLY_PARTS.map((p, i) => {
    const mine = rules.filter((r) => r.area === p.area || (i === 0 && !TALLY_PARTS.some((x) => x.area === r.area)));
    const folder = p.entry.split("/")[0];
    mkdirSync(join(staging, folder), { recursive: true });
    writeFileSync(join(staging, p.entry), readFileSync(join(parts, p.entry)));
    const files: string[] = [p.entry];
    if (mine.length) {
      writeFileSync(join(staging, folder, "rules.json"), `${JSON.stringify({ rules: mine.map((r) => ({ id: r.id, text: r.text, ...(r.tests.length ? { tests: r.tests } : {}) })) }, null, 2)}\n`);
      files.push(`${folder}/rules.json`);
    }
    return { kind: p.kind, title: p.title, devices: p.devices, variants: [{ id: "a", label: "As it is today", entry: p.entry }], files, provenance: p.provenance };
  });
  manifest(artifacts);
  return `Reproduced tally's ${artifacts.length} parts as the code has them today, with the reader's ${rules.length} rules (simulated sample).`;
}

const DOCUMENT_TEXT: Record<string, { title: string; md: string; mmd: string }> = {
  contract: {
    title: "Trip data (simulated sample)",
    md: "# Trip data\n\n> Simulated sample: the fake runtime made this, not a designer agent.\n\n| Thing | What it holds | How it relates |\n| --- | --- | --- |\n| Trip | the place, the dates, the cost each | has people and one plan |\n| Person | a name, in or out | joins trips |\n| Plan | days and stops | belongs to one trip |\n\n## A worked example\n\n```json\n{ \"trip\": \"Lake weekend\", \"people\": [\"AM\", \"JR\"], \"costEach\": 140 }\n```\n",
    mmd: "erDiagram\n  TRIP ||--o{ PERSON : has\n  TRIP ||--|| PLAN : has\n",
  },
  flow: {
    title: "Saying you are in (simulated sample)",
    md: "# Saying you are in\n\n> Simulated sample: the fake runtime made this, not a designer agent.\n\n| Case | Outcome |\n| --- | --- |\n| The trip has room | You are in; the cost each is shown again |\n| The trip is full | You join the waiting list |\n| The trip has started | You cannot join; the organiser is told |\n",
    mmd: "flowchart LR\n  ask[You say you are in] --> room{Room left?}\n  room -- yes --> in[You are in]\n  room -- no --> wait[Waiting list]\n",
  },
};

/** Write a document sample (Markdown and Mermaid) and its studio.json into a run's staging folder, as a designer agent would. */
export function writeDocumentSample(staging: string, kind: StudioArtifactKind) {
  const text = DOCUMENT_TEXT[kind] ?? { ...DOCUMENT_TEXT.contract, title: `${kind[0].toUpperCase()}${kind.slice(1)} (simulated sample)` };
  mkdirSync(join(staging, "doc"), { recursive: true });
  writeFileSync(join(staging, "doc", "index.md"), text.md);
  writeFileSync(join(staging, "doc", "diagram.mmd"), text.mmd);
  const manifest = { artifacts: [{ kind, title: text.title, devices: [], variants: [{ id: "a", label: "A · As drafted", entry: "doc/index.md" }], files: ["doc/index.md", "doc/diagram.mmd"] }] };
  writeFileSync(join(staging, "studio.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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
      const lead: LeadTrigger = /^# Lead run \S+ \(planning\)/.test(a.prompt)
        ? "planning"
        : /^# Lead run \S+ \(decisions on findings\)/.test(a.prompt)
          ? "decisions"
          : /^# Lead run \S+ \(revisions for the PE\)/.test(a.prompt)
            ? "pe-review"
            : /^# Lead run \S+ \(change order\)/.test(a.prompt)
              ? "change-order"
              : "message";
      this.procs.set(a.attemptId, { progress: 0, outputs: [], lead, prompt: a.prompt, ...(a.outputSchema ? { outputSchema: a.outputSchema } : {}) });
      this.emit({ type: "started", attemptId: a.attemptId });
      return;
    }
    if (a.studio) {
      if (this.procs.has(a.attemptId)) return;
      this.procs.set(a.attemptId, { progress: 0, outputs: [], studio: a.workspace.path, studioRole: a.role === "pe" ? "pe" : "designer", prompt: a.prompt });
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
      const step = this.config.progressPerTick + jitter(id);
      p.progress = Math.min(100, p.progress + (p.lead ? Math.max(step, Math.ceil(100 / LEAD_TICKS)) : step));
      if (p.progress >= 100) {
        this.dropNotes(id, p, "the run ended first");
        this.procs.delete(id);
        if (p.studioRole === "pe" && /^# PE review run \S+: new work in the factory/.test(p.prompt ?? "")) {
          // ORC-029 pass 5: a simulated PE on new work in the factory answers from its envelope alone.
          this.emit({ type: "completed", attemptId: id, finalText: fakeNewWorkPeAnswer(p.prompt ?? "") });
          continue;
        }
        if (/^# Import reader run /.test(p.prompt ?? "")) {
          // ORC-032: the simulated rules reader answers with tally's rules, naming only the tests its envelope lists.
          this.emit({ type: "completed", attemptId: id, finalText: fakeReaderAnswer(p.prompt ?? "") });
          continue;
        }
        if (p.studio !== undefined && p.studioRole === "pe") {
          // A simulated PE reads the version's manifest and its envelope (its earlier asks), and answers as a real one
          // would: a verdict per variant, each with its checks of the earlier asks on a later pass.
          const answer = fakePeAnswer(p.studio, p.prompt ?? "");
          this.emit(answer.ok ? { type: "completed", attemptId: id, finalText: answer.text } : { type: "failed", attemptId: id, message: `The simulated PE could not read the version: ${answer.error}` });
          continue;
        }
        if (p.studio !== undefined && existsSync(p.studio) && readdirSync(p.studio).length) {
          // A revision: its staging folder starts with the files of the version it revises. The simulated designer
          // marks the variants its brief asks it to revise, and hands in that one artifact.
          const ask = designerAsk(p.prompt ?? "");
          try {
            this.emit({ type: "completed", attemptId: id, finalText: reviseSample(p.studio, { terminal: ask.terminal, variants: variantsToRevise(ask.brief) }) });
          } catch (e) {
            this.emit({ type: "failed", attemptId: id, message: `The simulated designer could not revise: ${e instanceof Error ? e.message : String(e)}` });
          }
          continue;
        }
        if (p.studio !== undefined && /^## The import: the (words|parts)$/m.test(p.prompt ?? "")) {
          // ORC-032: the simulated import designer hands in tally's words or its parts, with the reader's rules placed.
          try {
            this.emit({ type: "completed", attemptId: id, finalText: writeImportSample(p.studio, p.prompt ?? "") });
          } catch (e) {
            this.emit({ type: "failed", attemptId: id, message: `The simulated designer could not write tally's parts: ${e instanceof Error ? e.message : String(e)}` });
          }
          continue;
        }
        if (p.studio !== undefined) {
          // A simulated designer writes a sample and its studio.json, which the service imports as a real one's: the
          // trips CLI's terminal demo and TUI when its brief asks for one, else the trip plan's screens.
          const ask = designerAsk(p.prompt ?? "");
          const doc = documentAsk(ask.brief);
          const terminal = !doc && TERMINAL_BRIEF.test(ask.brief);
          // Pass 4d: the project's dictionary when the brief asks for one (alone, or with a document), and a flow's rules in a flows round.
          const kinds = askedKinds(ask.brief);
          const words = kinds.includes("dictionary");
          try {
            if (words && kinds.length === 1) addDictionarySample(p.studio);
            else {
              if (doc) writeDocumentSample(p.studio, doc);
              else if (terminal) writeTerminalSample(p.studio, ask.terminal);
              else writeSamplePrototype(p.studio);
              if (words) addDictionarySample(p.studio);
              if (doc === "flow" && asksForRules(p.prompt ?? "")) addFlowRules(p.studio);
            }
          } catch (e) {
            this.emit({ type: "failed", attemptId: id, message: `The simulated designer could not write its sample: ${e instanceof Error ? e.message : String(e)}` });
            continue;
          }
          this.emit({
            type: "completed",
            attemptId: id,
            finalText: words && kinds.length === 1
              ? "Made the project's dictionary (simulated sample)."
              : doc
              ? `Made a ${doc} document in Markdown and Mermaid${doc === "flow" && asksForRules(p.prompt ?? "") ? ", with its rules" : ""}${words ? ", and the project's dictionary" : ""} (simulated sample).`
              : terminal
                ? "Made a terminal demo of the trips CLI, and its TUI in two layouts (simulated sample)."
                : "Made the trip plan in two variants, for desktop and mobile (simulated sample).",
          });
          continue;
        }
        if (p.lead && p.outputSchema) {
          const answer = fakeLeadAnswer(fakeLeadReply(id, p.lead, p.prompt, p.lead === "message" ? this.board?.() : undefined, nowMs), p.outputSchema);
          if (answer.ok) this.emit({ type: "completed", attemptId: id, finalText: answer.json });
          else this.emit({ type: "failed", attemptId: id, message: `The simulated lead's answer does not match the output schema: ${answer.why}` });
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
