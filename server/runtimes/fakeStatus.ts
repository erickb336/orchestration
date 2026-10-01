// ORC-025 (L3): the demo's simulated lead answers questions about the board from the service's state, instead of
// "Noted. In live mode…": what is running, what needs you, what landed, and how one task or area is going. The
// words come from the derivations Home shows (src/domain/needsYou.ts and areaProgress.ts), so the demo lead and
// the Needs-you card never disagree. Read-only: nothing here changes state. Only the fake runtime uses it; a real
// lead answers from its envelope and the repository.

import { areaOf, liveAgents, progressByArea, type LiveAgent } from "../../src/domain/areaProgress";
import * as D from "../../src/domain/delivery";
import * as F from "../../src/domain/findings";
import * as M from "../../src/domain/model";
import { needsYouItems, optionsLine, type NeedsYouEntry } from "../../src/domain/needsYou";
import type { State, Task } from "../../src/domain/types";

export type StatusQuestion =
  | { kind: "overview" }
  | { kind: "needs-you" }
  | { kind: "landed" }
  | { kind: "task"; taskId: string; asked: boolean }
  | { kind: "area"; area: string; asked: boolean };

const NEEDS_RE = /\bneeds? (?:me|my|you)\b|\bneed from me\b|\bwaiting (?:on|for) me\b|\bmy (?:attention|input|decision|go-ahead)\b|\bfor me to (?:do|decide)\b|\bwhat should i\b|\bblocked on me\b/i;
const LANDED_RE = /\b(?:landed|shipped|merged|delivered|finished)\b|\bwhat(?:'s| is| got)? done\b|\bresults\b/i;
const OVERVIEW_RE = /\bgoing on\b|\bhappening\b|\bstatus\b|\bprogress\b|\bwhere (?:are|do) (?:we|things)\b|\bhow are (?:things|we)\b|\bwhat(?:'s| is| are) (?:running|working)\b|\bwho(?:'s| is) working\b|\bupdate\b|\bsummar(?:y|ise|ize)\b|\bcatch me up\b|\boverview\b/i;
/** A question about one task or area: "how is …", "what is WT-2 doing", "where is …", "status of …". */
const ABOUT_RE = /\bhow(?:'s| is| are)\b|\bwhat(?:'s| is| are)\b[^?.!]*\bdoing\b|\bwhere(?:'s| is| are)\b|\bstatus\b|\bprogress\b|\bgoing\b|\bupdate\b/i;
const ASKS_RE = /\?\s*$|^\s*(?:how|what|where|who|when|is|are|any|anything|can you|could you|tell me|give me|show me)\b/i;
const ID_RE = /\b([A-Za-z]{1,6}-\d{1,4}(?:\.\d+)?)\b/g;
const STOP = new Set(
  "what whats going doing about with that this there their they them then than have from your mine need needs work working task tasks status still keep please thanks thank could would should will want make made does done right today update again also just some more much very well into over under after before when where which while being been were here lead agent agents coder designer reviewer tell know think things thing".split(" "),
);

/** The tasks a person thinks of as the product's work: not cancelled, not the service's own delivery tasks. */
const productTasks = (s: State) => s.tasks.filter((t) => t.lifecycle !== "cancelled" && !M.serviceOwned(t));
const titleOf = (t: Task) => M.currentSpec(t).content.title;
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4 && !STOP.has(w)));

/** The task or area a message names: a task id, an area's name, else the one task whose title shares the most words with it. */
function reference(state: State, text: string): { kind: "task"; taskId: string } | { kind: "area"; area: string } | undefined {
  const tasks = productTasks(state);
  for (const m of text.matchAll(ID_RE)) {
    const id = m[1].toUpperCase();
    if (state.tasks.some((t) => t.id === id)) return { kind: "task", taskId: id };
  }
  const lower = text.toLowerCase();
  const areas = [...new Set(tasks.map(areaOf))].filter((a) => a.length >= 3 && lower.includes(a.toLowerCase())).sort((a, b) => b.length - a.length);
  if (areas.length) return { kind: "area", area: areas[0] };
  const asked = words(text);
  let best: { task: Task; score: number } | undefined;
  let tie = false;
  for (const t of tasks) {
    const score = [...words(titleOf(t))].filter((w) => asked.has(w)).length;
    if (!score) continue;
    if (!best || score > best.score) {
      best = { task: t, score };
      tie = false;
    } else if (score === best.score) tie = true;
  }
  if (best && !tie) return { kind: "task", taskId: best.task.id };
  return undefined;
}

/**
 * What a message asks about the board, or nothing when it asks nothing the demo lead can answer (the caller keeps
 * its other simulated behaviour). A message that names a task or an area answers with that task or area, whatever
 * it asks ("how is offline maps going?", "what does WT-007 need from me?"); one that names it but asks nothing
 * ("put offline maps first") gets its state too, and the reply says nothing changed. `fromTaskId`: the task page
 * the message was sent from, which "how is this going?" is about.
 */
export function statusQuestion(state: State, text: string, fromTaskId?: string): StatusQuestion | undefined {
  const ref = reference(state, text);
  const asks = ASKS_RE.test(text) || ABOUT_RE.test(text);
  if (ref) return { ...ref, asked: asks || NEEDS_RE.test(text) };
  if (NEEDS_RE.test(text)) return { kind: "needs-you" };
  if (LANDED_RE.test(text) && asks) return { kind: "landed" };
  if (OVERVIEW_RE.test(text)) return { kind: "overview" };
  if (asks && fromTaskId && state.tasks.some((t) => t.id === fromTaskId)) return { kind: "task", taskId: fromTaskId, asked: true };
  if (asks) return { kind: "overview" };
  return undefined;
}

// ---------- the answers ----------

const quote = (t: Task) => `“${titleOf(t)}”`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "3h ago", "2d ago", "just now". */
function ago(iso: string, nowMs: number): string {
  const m = Math.round((nowMs - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Agents only (the service's check runs are not agents), as Home's header counts them. */
function agentsAt(state: State, tasks: Task[]): { agent: LiveAgent; task: Task }[] {
  return tasks.flatMap((task) => liveAgents(state, task).filter((a) => a.provider !== "service").map((agent) => ({ agent, task })));
}

/** "Codex is implementing “Show a clear offline state on the map”"; `it` names the task as "it" in a task's own answer. */
function doing(a: LiveAgent, task: Task, it = false): string {
  const who = M.providerLabel(a.provider);
  const what = it ? "it" : quote(task);
  if (a.verb === "stopping") return `${who} is stopping on ${what}`;
  if (a.verb === "working on") return `${who} is working on ${what}`;
  return `${who} is ${a.verb} ${what}`;
}

/** One thing that needs you, in Home's words: "decide a finding on “…”: the finding". */
function needLine(e: NeedsYouEntry, withTask = true): string {
  switch (e.kind) {
    case "merge":
      return `merge the pull request${withTask ? ` for ${quote(e.task)}` : ""}`;
    case "choose":
      return `choose an option${withTask ? ` for ${quote(e.task)}` : ""} (${optionsLine(e.options)})`;
    case "finding":
      return `decide a finding${withTask ? ` on ${quote(e.task)}` : ""}: ${e.decision.finding.title}`;
    case "start":
      return `give the go-ahead${withTask ? ` for ${quote(e.task)}` : ""}`;
    default:
      return e.task && withTask ? `${e.what} for ${quote(e.task)}` : e.what;
  }
}

function runningSentence(state: State, tasks: Task[]): string {
  const live = agentsAt(state, tasks);
  if (!live.length) return "No agent is working right now.";
  const shown = live.slice(0, 4).map(({ agent, task }) => doing(agent, task));
  const more = live.length > 4 ? ` and ${live.length - 4} more` : "";
  return `${live.length === 1 ? "One agent is" : `${live.length} agents are`} working: ${list(shown)}${more}.`;
}

function needsSentence(items: NeedsYouEntry[]): string {
  if (!items.length) return "Nothing needs you.";
  const shown = items.slice(0, 3).map((e) => needLine(e));
  const more = items.length > 3 ? `, and ${items.length - 3} more on Home` : "";
  return sentence(`${items.length === 1 ? "One thing needs" : `${items.length} things need`} you: ${shown.join("; ")}${more}`);
}

/** Root tasks that landed, newest first. */
function landed(state: State): Task[] {
  return productTasks(state)
    .filter((t) => t.integration?.landed)
    .sort((a, b) => b.integration!.landed!.at.localeCompare(a.integration!.landed!.at));
}

function overview(state: State, nowMs: number): string {
  const tasks = productTasks(state);
  const items = needsYouItems(state, nowMs);
  const last = landed(state)[0];
  const lastLine = last ? ` Last landed: ${quote(last)}, ${ago(last.integration!.landed!.at, nowMs)}.` : "";
  return `${runningSentence(state, tasks)} ${needsSentence(items)}${lastLine}`;
}

function needsYou(state: State, nowMs: number): string {
  const items = needsYouItems(state, nowMs);
  const lead = F.openDecisions(state, "lead").length;
  const leadLine = lead ? `\nI am deciding ${plural(lead, "finding")} myself; you can take any of them over from the task page.` : "";
  if (!items.length) return `Nothing needs you right now. Agents keep working within your settings.${leadLine}`;
  const lines = items.map((e) => `- ${cap(needLine(e))}${e.task ? ` (${e.task.id})` : ""}`);
  return `${items.length === 1 ? "One thing needs" : `${items.length} things need`} you:\n${lines.join("\n")}\nEach is on Home under Needs you.${leadLine}`;
}

function landedAnswer(state: State, nowMs: number): string {
  const done = landed(state);
  const merges = needsYouItems(state, nowMs).filter((e) => e.kind === "merge");
  const waiting = merges.length ? ` ${list(merges.map((e) => quote(e.task)))} ${merges.length === 1 ? "waits" : "wait"} for you to merge ${merges.length === 1 ? "its pull request" : "their pull requests"}.` : "";
  if (!done.length) return `Nothing has landed yet.${waiting}`;
  const shown = done.slice(0, 3).map((t) => `${quote(t)} (${ago(t.integration!.landed!.at, nowMs)})`);
  const unseen = D.unreviewedCount(state);
  return `Landed most recently: ${list(shown)}.${unseen ? ` ${plural(unseen, "result")} ${unseen === 1 ? "is" : "are"} new for you in Results.` : ""}${waiting}`;
}

function taskAnswer(state: State, task: Task, nowMs: number): string {
  const parts: string[] = [`${quote(task)} (${task.id}): ${M.stateLabel(state, task)}.`];
  const live = agentsAt(state, [task, ...M.childTasks(state, task)]);
  if (live.length) parts.push(`${cap(list(live.map(({ agent, task: t }) => doing(agent, t, t.id === task.id))))}.`);
  const kids = M.childTasks(state, task).filter((k) => k.lifecycle !== "cancelled");
  if (kids.length) parts.push(`${kids.filter((k) => k.lifecycle === "done").length} of ${plural(kids.length, "part")} done.`);
  const mine = needsYouItems(state, nowMs).filter((e) => e.task && (e.task.id === task.id || e.task.parentTaskId === task.id));
  if (mine.length) parts.push(sentence(`It needs you: ${mine.map((e) => needLine(e, e.task!.id !== task.id)).join("; ")}`));
  const l = task.integration?.landed;
  if (l) parts.push(`It landed ${ago(l.at, nowMs)}.`);
  return parts.join(" ");
}

function areaAnswer(state: State, area: string, nowMs: number): string {
  const row = progressByArea(state, nowMs).find((r) => r.area === area);
  if (!row) return `Nothing on the board is in ${area}.`;
  const tasks = productTasks(state).filter((t) => areaOf(t) === area);
  const live = agentsAt(state, tasks);
  const needs = needsYouItems(state, nowMs).filter((e) => e.task && areaOf(e.task) === area);
  return [`${row.label}.`, live.length ? `${cap(list(live.map(({ agent, task }) => doing(agent, task))))}.` : "", needs.length ? sentence(`It needs you: ${needs.map((e) => needLine(e)).join("; ")}`) : ""].filter(Boolean).join(" ");
}

const cap = (s: string) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);
/** A full stop, unless the text already ends a sentence (a finding's title may be a question). */
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);

/** The simulated lead's answer to a status question, from the state now. Short and plain; it changes nothing. */
export function statusAnswer(state: State, q: StatusQuestion, nowMs: number): string {
  switch (q.kind) {
    case "overview":
      return overview(state, nowMs);
    case "needs-you":
      return needsYou(state, nowMs);
    case "landed":
      return landedAnswer(state, nowMs);
    case "task": {
      const t = state.tasks.find((x) => x.id === q.taskId);
      return asked(q.asked, t ? taskAnswer(state, t, nowMs) : `${q.taskId} is not on the board.`);
    }
    case "area":
      return asked(q.asked, areaAnswer(state, q.area, nowMs));
  }
}

/** A message that named a task or area without asking anything gets its state, and is told that nothing changed. */
function asked(yes: boolean, answer: string): string {
  return yes ? answer : `I changed nothing. ${answer} To change direction, tell me what to focus on.`;
}
