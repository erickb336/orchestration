// What waits for the user ("Needs you"), derived from state only; nothing here is stored. This is the one place
// that decides it, so the task list, Home's Needs-you card, the progress rows and the demo lead's answers
// (server/runtimes/fakeStatus.ts) agree.

import * as D from "./delivery";
import { unconfirmedDevcontainer } from "./environment";
import * as F from "./findings";
import * as M from "./model";
import { changeOrderNeeds } from "./model/changeOrderUpdates";
import { lastObjection, PE_OBJECTS_HOLD, PE_REVIEW_HOLD, taskReviewHold } from "./peReview";
import { budgetStop, type UnknownCost } from "./spend";
import { blueprintItems, openChangeOrders } from "./studio/blueprint";
import { slippedThrough } from "./subagents";
import type { ChangeOrder } from "./studio/types";
import type { FindingDecision, PrDelivery, SpecOption, State, Task } from "./types";

export interface NeedsYou {
  /** What waits, in a few words: "merge PR", "choose an option", "decide a finding". */
  what: string;
  /** The one control that opens the right place. */
  action: string;
  href: string;
}

const taskHref = (t: Task) => `#/task/${encodeURIComponent(t.id)}`;

/**
 * What a task waits on the user for, or nothing. Reuses the derivations the Results page and the task page
 * use; the most pressing item wins when several apply.
 */
export function needsYouOf(state: State, task: Task, nowMs = Date.now()): NeedsYou | undefined {
  const href = taskHref(task);
  const open = task.lifecycle !== "done" && task.lifecycle !== "cancelled";
  const i = task.integration;
  const pr = i?.pr;
  if (pr && i?.status === "integrated" && (pr.phase === "built" || pr.phase === "open")) {
    if (pr.attention && !D.openRepair(state, pr)) return { what: PR_PROBLEM, action: "Open", href };
    if (D.prReady(state, task, nowMs)) return { what: "merge PR", action: "Merge", href: "#/results" };
  }
  if (i?.landed?.status === "unreviewed" && i.landed.flags.length) return { what: "look at flagged work", action: "Open", href: "#/results" };
  if (task.controlFailure) return { what: "retry the stop", action: "Open", href };
  if (task.steps.some((st) => st.role === "checks" && st.state === "blocked" && st.blockedReason?.startsWith("Checks failed"))) return { what: "decide on failing checks", action: "Decide", href };
  if (F.openDecisions(state, "user").some((d) => d.taskId === task.id)) return { what: "decide a finding", action: "Decide", href };
  if (open && task.hold && task.holdReason) return { what: "review the step", action: "Open", href };
  // PE review comes before your go-ahead: an objection after three rounds is yours, and so is a review that could not
  // finish; pending work is the PE's. The task's own review (a proposal) or a step's (a breakdown, a design).
  const review = open ? taskReviewHold(task)?.hold : undefined;
  if (review && review !== PE_REVIEW_HOLD) return { what: review === PE_OBJECTS_HOLD ? PE_OBJECTION : PE_UNFINISHED, action: "Open", href };
  if (review) return undefined;
  if (open && task.holdBeforeStart && task.lifecycle !== "active" && !task.heldForShaping && !task.hold && !M.deferredBy(state, task)) {
    return { what: M.currentSpec(task).content.options.length > 1 ? "choose an option" : "give the go-ahead", action: "Open", href };
  }
  return undefined;
}

/** The "what" of a pull request that stopped on a problem; Home shows the problem's message under it. */
export const PR_PROBLEM = "decide on the pull request";

/** The "what" of new work the PE still objects to after three rounds; Home shows the objection under it. */
export const PE_OBJECTION = "answer the PE's objection";
/** The "what" of new work whose PE review could not finish (the PE could not run); Home shows why under it. */
export const PE_UNFINISHED = "decide without the PE's review";

/** What the owner reads under a PE objection: the review that holds the task, and its objection or why it ended. */
function peDetail(task: Task): string | undefined {
  const r = taskReviewHold(task)?.review;
  return r ? lastObjection(r) : undefined;
}

/** One mark of the verdict line: "Code ✓", "Security ✓", "Checks ✓". */
export interface VerdictMark {
  label: "Code" | "Security" | "Checks";
  ok: boolean;
}

/**
 * The verdict line of a pull request, from the same merge gate the task page shows. A clean "review" item means
 * both a code review and a security review saw the final change (delivery/review.ts: a clean pipeline review needs
 * the security review too, and the dedicated review flow carries both). "Checks" covers GitHub's required checks
 * and, when the project runs its own, the service's checks.
 */
export function mergeVerdict(state: State, task: Task, nowMs: number): VerdictMark[] {
  const items = D.prGate(state, task, nowMs, { byUser: true }).items;
  const ok = (id: D.GateItem["id"]) => items.find((i) => i.id === id)?.ok ?? false;
  const service = items.find((i) => i.id === "service-checks");
  return [
    { label: "Code", ok: ok("review") },
    { label: "Security", ok: ok("review") },
    { label: "Checks", ok: ok("checks") && (!service || service.ok) },
  ];
}

/**
 * One thing that needs you on Home. The simple decisions are taken in place with the same commands the task page
 * uses: "merge" (Merge / Keep for me), "choose" (exactly two options), "finding" (Fix / Accept as is / Message the
 * lead), "start" (your go-ahead). Everything else is "open": one link to the place where it is decided.
 */
export type NeedsYouEntry =
  | { kind: "merge"; key: string; task: Task; pr: PrDelivery; verdict: VerdictMark[]; simulated: boolean }
  | { kind: "choose"; key: string; task: Task; options: SpecOption[]; recommendedId: string; specRev: number }
  | { kind: "finding"; key: string; task: Task; decision: FindingDecision }
  | { kind: "start"; key: string; task: Task }
  | { kind: "open"; key: string; task?: Task; what: string; detail?: string; action: string; href: string }
  /** A run whose agent started helpers where none is allowed (ORC-031): Open the run, or Mark as seen in place. */
  | { kind: "helpers"; key: string; task?: Task; runId: string; what: string; detail: string; action: string; href: string };

/** Whether Merge can be offered in place: the same conditions as the task page's Merge button, on a pull request that is ready. */
function mergeInPlace(state: State, task: Task, pr: PrDelivery, nowMs: number): boolean {
  return D.prReady(state, task, nowMs) && state.project.prDelivery.enabled && !mergeAsked(pr);
}

/** You already asked for the merge of this head: the service merges it; nothing is left for you to decide. */
const mergeAsked = (pr: PrDelivery) => pr.mergeRequested?.headSha === pr.headSha;

/** Everything that waits for you, in the order the Needs-you card shows it: project-wide problems first, then tasks by priority. */
export function needsYouItems(state: State, nowMs = Date.now()): NeedsYouEntry[] {
  const items: NeedsYouEntry[] = [];
  // The costs with no full record count at an estimate (spend.ts), which the budgets show: only the stop waits for you.
  const stop = budgetStop(state);
  if (stop) items.push({ kind: "open", key: "budget", what: stop.why, detail: budgetDetail(state, stop.spend.unknown), action: "Settings", href: "#/settings/project/budgets" });
  // A run's agent started the provider's own subagents where none is allowed (ORC-031): the owner knows, until they mark it as seen.
  for (const x of slippedThrough(state)) {
    const task = x.taskId ? state.tasks.find((t) => t.id === x.taskId) : undefined;
    items.push({ kind: "helpers", key: `helpers-${x.runId}`, ...(task ? { task } : {}), runId: x.runId, what: HELPER_SLIPPED_THROUGH, detail: helperDetail(state, x.runId, x.count), action: "Open", href: x.href });
  }
  // A change order the lead answered that still waits for you: its updates for your go-ahead ("ask me first"), or what
  // the lead left (pass 5). "Open" goes to the change order's screen (#/tasks/change-order/<rev>).
  for (const co of openChangeOrders(state)) {
    const needs = changeOrderNeeds(state, co);
    if (needs) items.push({ kind: "open", key: `change-order-${co.rev}`, what: `Change order: blueprint r${co.rev}`, detail: changeOrderDetail(state, co, needs.words), action: "Open", href: `#/tasks/change-order/${co.rev}` });
  }
  // A dev container that changed (or appeared) at the trusted base is not used until the owner confirms it.
  const dc = unconfirmedDevcontainer(state);
  if (dc) items.push({ kind: "open", key: "devcontainer", what: "the repository's dev container is not confirmed", detail: `${dc.file} at ${dc.sha.slice(0, 12)} chooses the image the checks and the evidence run in. It is not used until you confirm it (sha256 ${dc.sha256.slice(0, 12)}…): until then they use the image you confirmed, or run on this computer.`, action: "Settings", href: "#/settings/project/environment" });
  const gh = state.project.github;
  if (gh?.problem && (state.project.prDelivery.enabled || D.openPrTasks(state).length > 0)) {
    items.push({ kind: "open", key: "gh", what: "GitHub delivery is stopped", detail: gh.problem.message, action: "Settings", href: "#/settings/project/delivery" });
  }
  if (gh?.autoMergePaused) {
    items.push({ kind: "open", key: "auto", what: "automatic merging is paused", detail: `${gh.autoMergePaused.reason}. ${gh.autoMergePaused.sticky ? "It stays paused until you resume it." : "It resumes when the check passes again."}`, action: "Open", href: "#/results" });
  }
  for (const task of [...state.tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    const n = needsYouOf(state, task, nowMs);
    if (!n) continue;
    const pr = task.integration?.pr;
    const open = (): NeedsYouEntry => ({ kind: "open", key: task.id, task, what: n.what, detail: n.what === PR_PROBLEM ? pr?.attention?.message : n.what === PE_OBJECTION || n.what === PE_UNFINISHED ? peDetail(task) : undefined, action: n.action, href: n.href });
    if (n.what === "merge PR" && pr && mergeAsked(pr)) continue;
    if (n.what === "merge PR" && pr && mergeInPlace(state, task, pr, nowMs)) {
      items.push({ kind: "merge", key: task.id, task, pr, verdict: mergeVerdict(state, task, nowMs), simulated: !!pr.simulated });
    } else if (n.what === "choose an option") {
      const spec = M.currentSpec(task);
      if (spec.content.options.length === 2) items.push({ kind: "choose", key: task.id, task, options: spec.content.options, recommendedId: spec.content.recommendedOptionId, specRev: spec.rev });
      else items.push(open());
    } else if (n.what === "decide a finding") {
      // One row per decision, so each is decided once; a decision on failing final checks has its own controls on the task page.
      const mine = F.openDecisions(state, "user").filter((d) => d.taskId === task.id && d.kind === "finding");
      if (mine.length) for (const decision of mine) items.push({ kind: "finding", key: decision.id, task, decision });
      else items.push(open());
    } else if (n.what === "give the go-ahead") {
      items.push({ kind: "start", key: task.id, task });
    } else items.push(open());
  }
  return items;
}

/** What changed, what it touches and what waits: "You changed the blueprint: Invite sheet (v2); dropped Reminders (v1). It touches WT-6, WT-7. …" */
function changeOrderDetail(state: State, co: ChangeOrder, waits: string): string {
  // The items as the Lock in put them into force.
  const items = state.blueprint.revisions.find((r) => r.rev === co.rev)?.items ?? blueprintItems(state);
  const name = (id: string) => {
    const i = items.find((x) => x.id === id);
    return i ? `${i.title} (v${i.version})` : id;
  };
  const what = [co.changedItems.map(name).join(", "), co.droppedItems.length ? `dropped ${co.droppedItems.map(name).join(", ")}` : ""].filter(Boolean).join("; ");
  const touches = co.tasks.length ? `It touches ${co.tasks.map((t) => t.taskId).join(", ")}.` : "No task cites what changed.";
  return `You changed the blueprint: ${what}. ${touches} ${waits[0].toUpperCase()}${waits.slice(1)}.`;
}

/** The "what" of a run whose agent started subagents where none is allowed (ORC-031). */
export const HELPER_SLIPPED_THROUGH = "A helper agent started where none is allowed";

/** What happened and what the service did: "WT-002 S1 started 2 helper agents. …" (the run named in words, never by its id). */
function helperDetail(s: State, runId: string, count: number): string {
  const run = runWords(s, runId);
  return `${run[0].toUpperCase()}${run.slice(1)} started ${count === 1 ? "a helper agent" : `${count} helper agents`}. The provider should have switched them off. They are counted and shown on the run, and their cost counts in the budget. Mark them as seen once you know why.`;
}

/** "10:42": the local time of day, as the owner reads a time on a screen. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A run in the owner's words, never its internal id ("lead-1127"; ORC-030 a-words-ids): a task run by its task and step
 * ("WT-002 S1"); a lead run by its reply ("the lead's reply at 10:42"), or by when it started when it wrote none ("the
 * lead's run at 10:41"); a Vision run by its kind ("a PE run in Vision"); a helper by the run that started it.
 * `UnknownCost.runId` names a helper as "<run> helper <id>" or "<run> unlisted helper <n>".
 */
export function runWords(s: State, runId: string): string {
  const id = runId.split(" ")[0];
  const helper = id !== runId;
  const a = s.attempts.find((x) => x.id === id);
  const studio = a ? undefined : s.studio.runs.find((x) => x.id === id);
  const run = a ? `${a.taskId} ${a.stepId}` : studio ? `a ${studio.kind === "pe" ? "PE" : studio.kind} run in Vision` : leadRunWords(s, id);
  return helper ? `a helper of ${run}` : run;
}

/** "the lead's reply at 10:42", "the lead's run at 10:41", or "a lead run" when the record has no such run. */
function leadRunWords(s: State, id: string): string {
  const reply = s.conversation.find((m) => m.author === "lead" && m.leadRunId === id);
  if (reply) return `the lead's reply at ${clockTime(reply.at)}`;
  const r = s.leadRuns.find((x) => x.id === id);
  return r ? `the lead's run at ${clockTime(r.startedAt)}` : "a lead run";
}

/** What the budget stop means, and the runs it cannot count, if any (the first five are named). */
function budgetDetail(s: State, unknown: UnknownCost[]): string {
  const none = unknown.filter((u) => u.countedUsd === null);
  const named = none.slice(0, 5).map((u) => `${runWords(s, u.runId)} (${M.providerLabel(u.provider)} · ${u.model}, ${u.reason === "no-price" ? "no price" : "no usage recorded"})`);
  const notCounted = none.length ? ` Not counted: ${named.join(", ")}${none.length > 5 ? ` and ${none.length - 5} more` : ""}.` : "";
  return `Estimated at the providers' published prices. Nothing new starts; running work finishes. Raise the budget, or continue past it.${notCounted}`;
}

/** The two options as one line: "A, Guest link · B, One-time code". */
export function optionsLine(options: SpecOption[]): string {
  return options.map((o) => `${o.id}, ${o.name}`).join(" · ");
}
