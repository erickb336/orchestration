// What waits for the user ("Needs you"), derived from state only; nothing here is stored. This is the one place
// that decides it, so the task list, Home's Needs-you card, the progress rows and the demo lead's answers
// (server/runtimes/fakeStatus.ts) agree.

import * as D from "./delivery";
import * as F from "./findings";
import * as M from "./model";
import { lastObjection, PE_REVIEW_HOLD, peReviewHold } from "./peReview";
import { budgetStop, buildingSpend, type UnknownCost } from "./spend";
import { blueprintItems, openChangeOrders } from "./studio/blueprint";
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
  // PE review comes before your go-ahead: an objection after three rounds is yours; pending work is the PE's.
  const review = open ? peReviewHold(task.peReview) : undefined;
  if (review && review !== PE_REVIEW_HOLD) return { what: PE_OBJECTION, action: "Open", href };
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
  | { kind: "open"; key: string; task?: Task; what: string; detail?: string; action: string; href: string };

/** Whether Merge can be offered in place: the same conditions as the task page's Merge button, on a pull request that is ready. */
function mergeInPlace(state: State, task: Task, pr: PrDelivery, nowMs: number): boolean {
  return D.prReady(state, task, nowMs) && state.project.prDelivery.enabled && !mergeAsked(pr);
}

/** You already asked for the merge of this head: the service merges it; nothing is left for you to decide. */
const mergeAsked = (pr: PrDelivery) => pr.mergeRequested?.headSha === pr.headSha;

/** Everything that waits for you, in the order the Needs-you card shows it: project-wide problems first, then tasks by priority. */
export function needsYouItems(state: State, nowMs = Date.now()): NeedsYouEntry[] {
  const items: NeedsYouEntry[] = [];
  const stop = budgetStop(state);
  if (stop) items.push({ kind: "open", key: "budget", what: stop.why, detail: budgetDetail(), action: "Settings", href: "#/settings/project" });
  // Apart from the stop: while a building budget is set, a run with no recorded cost is the owner's to know about.
  const unknown = state.project.budgets.buildingUsd === null ? [] : (stop?.spend ?? buildingSpend(state)).unknown;
  if (unknown.length) items.push({ kind: "open", key: "budget-unknown", what: unknownCostLine(unknown), detail: unknownCostDetail(unknown), action: "Settings", href: "#/settings/project" });
  // You asked to see change orders before the lead updates tasks. The Tasks page lists the affected tasks until the blueprint has its own page (ORC-029 pass 6).
  for (const co of openChangeOrders(state, "user")) items.push({ kind: "open", key: `change-order-${co.rev}`, what: `Change order: blueprint r${co.rev}`, detail: changeOrderDetail(state, co), action: "Open", href: "#/tasks" });
  // The PE still objects to the lead's updates for a change order after three rounds (2e).
  for (const co of openChangeOrders(state)) {
    const hold = peReviewHold(co.peReview);
    if (!co.peReview || !hold || hold === PE_REVIEW_HOLD) continue;
    items.push({ kind: "open", key: `change-order-pe-${co.rev}`, what: `The PE objects to the updates for change order r${co.rev}`, detail: lastObjection(co.peReview), action: "Open", href: "#/tasks" });
  }
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
    const open = (): NeedsYouEntry => ({ kind: "open", key: task.id, task, what: n.what, detail: n.what === PR_PROBLEM ? pr?.attention?.message : n.what === PE_OBJECTION && task.peReview ? lastObjection(task.peReview) : undefined, action: n.action, href: n.href });
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

/** What changed and what it touches: "You changed the blueprint: Invite sheet (v2); dropped Reminders (v1). It touches WT-6 and WT-7. …" */
function changeOrderDetail(state: State, co: ChangeOrder): string {
  // The items as the Lock in put them into force.
  const items = state.blueprint.revisions.find((r) => r.rev === co.rev)?.items ?? blueprintItems(state);
  const name = (id: string) => {
    const i = items.find((x) => x.id === id);
    return i ? `${i.title} (v${i.version})` : id;
  };
  const what = [co.changedItems.map(name).join(", "), co.droppedItems.length ? `dropped ${co.droppedItems.map(name).join(", ")}` : ""].filter(Boolean).join("; ");
  const touches = co.tasks.length ? `It touches ${co.tasks.map((t) => t.taskId).join(", ")}.` : "No task cites what changed.";
  return `You changed the blueprint: ${what}. ${touches} You asked to look before the lead updates tasks.`;
}

/** What the budget stop means (the runs with no recorded cost have their own item). */
function budgetDetail(): string {
  return "Estimated at the providers' published prices. Nothing new starts; running work finishes. Raise the budget, or continue past it.";
}

/** "a", "a and b", "a, b and c". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** "3 runs have no recorded cost (model gpt-x has no price; no usage was recorded for 1)". */
function unknownCostLine(unknown: UnknownCost[]): string {
  const n = unknown.length;
  const models = [...new Set(unknown.filter((u) => u.reason === "no-price").map((u) => u.model))];
  const noUsage = unknown.filter((u) => u.reason === "no-usage").length;
  const why = [
    ...(models.length ? [`${models.length === 1 ? "model" : "models"} ${listed(models)} ${models.length === 1 ? "has" : "have"} no price`] : []),
    ...(noUsage ? [noUsage === n ? "no usage was recorded" : `no usage was recorded for ${noUsage}`] : []),
  ].join("; ");
  return `${n} run${n === 1 ? " has" : "s have"} no recorded cost (${why})`;
}

/** What it means for the stop (spend.ts, `budgetStop`), and the runs (the first five are named). */
function unknownCostDetail(unknown: UnknownCost[]): string {
  const named = unknown.slice(0, 5).map((u) => `${u.runId} (${u.provider} · ${u.model}, ${u.reason === "no-price" ? "no price" : "no usage recorded"})`);
  return `The budget's stop counts each at its run limit, the most it could cost; one with no spend limit (Codex has none) stops new work until you raise the budget or continue past it. Runs: ${named.join(", ")}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""}.`;
}

/** The two options as one line: "A, Guest link · B, One-time code". */
export function optionsLine(options: SpecOption[]): string {
  return options.map((o) => `${o.id}, ${o.name}`).join(" · ");
}
