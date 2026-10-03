// The factory floor (ORC-029 pass 6, screen 8 of the pass 1 prototype) in words, as pure functions over the state:
// Home after the start. One line per area with each task at its station (building, review, checks, evidence, landed),
// a change order or "needs you" marked on its task; the two budgets; the trade-off calls the PE made within budget;
// and the open change orders the lead is answering. The facts are the domain's: the money comes from spend.ts and the
// Lock in summary's budgets (never computed here), what waits for you from needsYou.ts, the calls from findings.ts.
// An unknown cost is "no estimate", never $0.

import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import { budgetStop, buildingSpend, committedBuildUsd, fmtUsd, maintenanceEstimate, unrecordedWords, type MaintenanceEstimate, type PartsSum } from "../../domain/spend";
import * as B from "../../domain/studio/blueprint";
import { restOfBuild } from "../../domain/studio/itemStatus";
import type { ChangeOrder, UsdRange } from "../../domain/studio/types";
import type { FindingDecision, PeCall, State, Step, Task } from "../../domain/types";
import { relTime } from "../common";
import type { Tone } from "../kit";
import { areaOf, needsYouOf } from "../progress";
import { cardLine } from "../tasksView";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const range = ([lo, hi]: UsdRange) => (lo === hi ? fmtUsd(hi) : `${fmtUsd(lo)}–${fmtUsd(hi)}`);
const taskHref = (id: string) => `#/task/${encodeURIComponent(id)}`;

// ---------- one line per area ----------

/** Where a task is on its line. "waiting": not started, or started with no step running. */
export type Station = "waiting" | "building" | "review" | "checks" | "evidence" | "finished" | "landed";

/** The step's station: who works on it. A lead step that plans is building; one that verifies is review. */
function stationOfStep(st: Step): Station {
  switch (st.role) {
    case "code_reviewer":
    case "security_reviewer":
    case "ux_reviewer":
      return "review";
    case "checks":
      return "checks";
    case "evidence":
      return "evidence";
    case "lead":
      return st.outputs.some((o) => o.kind === "breakdown") ? "building" : "review";
    default:
      return "building";
  }
}

/**
 * Where a task stands on its line, and whether it moves: a finished task has landed (its work is on the target) or
 * is finished (it waits to land); a running step's station moves; a started task with no step running waits at its
 * next step's station; a task not started waits.
 */
export function stationOf(s: State, t: Task): { station: Station; moving: boolean } {
  if (t.lifecycle === "done") return { station: t.integration?.landed ? "landed" : "finished", moving: false };
  const run = M.activeAttempts(s, t.id)
    .map((a) => t.steps.find((x) => x.id === a.stepId))
    .find((x): x is Step => !!x);
  if (run) return { station: stationOfStep(run), moving: true };
  const next = t.lifecycle === "active" ? t.steps.find((x) => x.state !== "done" && x.state !== "skipped") : undefined;
  return { station: next ? stationOfStep(next) : "waiting", moving: false };
}

export interface FloorTask {
  id: string;
  title: string;
  href: string;
  station: Station;
  /** The station's pill: work while an agent or the service works on it, done once landed, neutral otherwise. */
  tone: Tone;
  moving: boolean;
  /** The open change order that touches it, by revision. */
  changeOrder?: number;
  /** What it waits on you for ("decide a finding"), when it does. */
  needsYou?: string;
  /** The one plain line about what is happening, for the link's title. */
  line: string;
}

export interface AreaLine {
  area: string;
  /** The task list, filtered to the area. */
  href: string;
  /** "3 tasks · 1 landed". */
  counts: string;
  /** The line as one row on a phone (ORC-030 a-home-phone): "1 building · 1 waiting · 1 landed", and how many need you. */
  summary: { counts: string; needsYou: number };
  tasks: FloorTask[];
  /** Tasks past the first `MAX_ON_LINE`, which the task list shows. */
  more: number;
}

/** At most this many tasks show on one line; the rest are one link to the task list. */
const MAX_ON_LINE = 12;

/**
 * One line per area, in the order of each area's first task (priority, then id), so the lines stay in place while the
 * work moves. Cancelled tasks and the service's own delivery tasks are left out, as in the task list's areas.
 */
export function floorLines(s: State, nowMs = Date.now()): AreaLine[] {
  const touched = new Map<string, number>();
  for (const co of B.openChangeOrders(s)) for (const t of co.tasks) if (!touched.has(t.taskId)) touched.set(t.taskId, co.rev);
  const groups = new Map<string, Task[]>();
  const tasks = s.tasks.filter((t) => t.lifecycle !== "cancelled" && !M.serviceOwned(t)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const t of tasks) {
    const area = areaOf(t);
    groups.set(area, [...(groups.get(area) ?? []), t]);
  }
  return [...groups].map(([area, list]) => {
    const all = list.map((t): FloorTask => {
      const { station, moving } = stationOf(s, t);
      const needs = needsYouOf(s, t, nowMs);
      const co = touched.get(t.id);
      return {
        id: t.id,
        title: M.currentSpec(t).content.title,
        href: taskHref(t.id),
        station,
        tone: moving ? "work" : station === "landed" ? "done" : "neutral",
        moving,
        ...(co !== undefined ? { changeOrder: co } : {}),
        ...(needs ? { needsYou: needs.what } : {}),
        line: cardLine(s, t, nowMs).text,
      };
    });
    const landed = all.filter((t) => t.station === "landed").length;
    return {
      area,
      href: `#/tasks?area=${encodeURIComponent(area)}`,
      counts: [count(all.length, "task"), landed ? `${landed} landed` : ""].filter(Boolean).join(" · "),
      summary: { counts: summaryCounts(all), needsYou: all.filter((t) => t.needsYou).length },
      tasks: all.slice(0, MAX_ON_LINE),
      more: Math.max(0, all.length - MAX_ON_LINE),
    };
  });
}

/**
 * "2 building · 1 waiting · 1 landed": how many tasks of a line are at work (building, in review, in checks, being
 * captured), wait, and landed; a finished task that has not landed (nothing to merge, or its pull request is still
 * open) counts as finished. Only the counts that are not zero.
 */
function summaryCounts(tasks: FloorTask[]): string {
  const n = (stations: Station[]) => tasks.filter((t) => stations.includes(t.station)).length;
  const parts: [number, string][] = [
    [n(["building", "review", "checks", "evidence"]), "building"],
    [n(["waiting"]), "waiting"],
    [n(["landed"]), "landed"],
    [n(["finished"]), "finished"],
  ];
  return parts
    .filter(([k]) => k > 0)
    .map(([k, w]) => `${k} ${w}`)
    .join(" · ");
}

// ---------- the budgets ----------

/**
 * One budget as one line on Home's Budgets card (ORC-030 a-home-budgets): its name, a figure and a bar; the reasons
 * open on click. "Building · $12 of $40 · about $18 more (the PE)", "Maintenance · about $0.80 a month of $10".
 */
export interface BudgetLine {
  name: "Building" | "Maintenance";
  /** "$8.10 of $40 · about $9–$16 more (the PE)", "$8.10 spent · no budget", "no estimate yet". */
  figure: string;
  /** The bar, with a budget only: the share used, and the share the PE's estimate adds on top. */
  bar?: { used: number; more: number };
  /** The figure's state when it needs saying: "stopped" (it waits for you), "continued past it". */
  state?: { word: string; tone: Tone };
  /** Why the figure is what it is: the stop, the estimate's basis, the costs with no full record, the PE's calls. */
  reasons: string[];
}

export interface BudgetWords {
  building: BudgetLine;
  maintenance: BudgetLine;
}

/** "$40", "$8.10", "$0.80": whole dollars without cents, the rest to the cent. */
export function money(usd: number): string {
  const cents = Math.round(usd * 100);
  return cents % 100 === 0 ? `$${cents / 100}` : fmtUsd(usd);
}
const moneyRange = ([lo, hi]: UsdRange) => (lo === hi ? money(hi) : `${money(lo)}–${money(hi)}`);

/**
 * The two budgets in words. Building: the spend of the budget and the PE's estimate for the rest (its estimates of the
 * approved parts not built yet); the reasons: where the stop stands, the estimate's parts, the costs with no full
 * record, and what the PE's calls commit. Maintenance: the PE's monthly estimates of the approved parts and the PE
 * calls that stand, against its budget. An unknown cost is "no estimate", never $0.
 */
export function budgetWords(s: State): BudgetWords {
  const b = B.lockInSummary(s).budgets;
  const budget = b.building.budgetUsd;
  const spent = b.building.spentUsd;
  const rest = restOfBuild(s);
  const committed = committedBuildUsd(s);
  const unknown = unrecordedWords(buildingSpend(s));
  const stop = stopWords(s, budget);
  const m = maintenanceEstimate(s);
  const monthBudget = s.project.budgets.maintenanceUsdPerMonth;
  const month = m.partsUsd === null ? null : m.partsUsd + m.callsUsd;
  const more = rest.usd ? rest.usd[1] : 0;
  const lockedIn = !!B.currentBlueprint(s);
  return {
    building: {
      name: "Building",
      figure: [budget === null ? `${money(spent)} spent` : `${money(spent)} of ${money(budget)}`, budget === null ? "no budget" : "", restFigure(rest, lockedIn)].filter(Boolean).join(" · "),
      ...(budget ? { bar: { used: spent / budget, more: more / budget } } : {}),
      ...(stop.state ? { state: stop.state } : {}),
      reasons: [stop.text, `The PE's estimate for the rest: ${restWords(rest, lockedIn)}.`, ...(unknown ? [unknown] : []), ...(committed > 0 ? [`Up to ${fmtUsd(committed)} is committed to PE calls whose work has not run.`] : [])],
    },
    maintenance: {
      name: "Maintenance",
      figure: month === null ? `no estimate yet${monthBudget === null ? "" : ` · budget ${money(monthBudget)} a month`}` : `about ${money(month)} a month${monthBudget === null ? " · no budget" : ` of ${money(monthBudget)}`}`,
      ...(month !== null && monthBudget ? { bar: { used: month / monthBudget, more: 0 } } : {}),
      ...(month !== null && monthBudget !== null && month > monthBudget ? { state: { word: "over", tone: "you" as Tone } } : {}),
      reasons: [maintenanceBasis(m), monthBudget === null ? "No maintenance budget is set, so a PE call that adds a monthly cost is not held for cost." : `A PE call that would take it past ${money(monthBudget)} a month comes to you.`],
    },
  };
}

/** "about $9–$16 more (the PE)"; "no estimate for the rest yet"; "nothing left to build"; nothing before a Lock in. */
function restFigure(rest: PartsSum, lockedIn: boolean): string {
  if (!lockedIn) return "";
  if (!rest.parts) return "nothing left to build";
  if (!rest.usd) return "no estimate for the rest yet";
  return `about ${moneyRange(rest.usd)} more (the PE)`;
}

/** "$9.00–$16.00 for 3 parts"; with no total, how many parts have no estimate; with nothing left, a known $0. */
function restWords(rest: PartsSum, lockedIn: boolean): string {
  if (!lockedIn) return "none yet: nothing is locked in, so the PE has no part to estimate";
  if (!rest.parts) return "nothing is left to build";
  if (!rest.usd) return `none for ${rest.missing} of ${count(rest.parts, "part")}, so it is unknown, never $0`;
  return `${range(rest.usd)} for the ${count(rest.parts, "approved part")} not built yet`;
}

/** Where the maintenance estimate comes from, or why there is none yet (never $0). */
function maintenanceBasis(m: MaintenanceEstimate): string {
  if (m.partsUsd !== null) return `The sum of the PE's estimates for the ${count(m.parts, "approved part")}, and each trade-off call the PE makes.`;
  if (m.parts) return `The PE gave no monthly estimate for ${m.missing} of ${count(m.parts, "approved part")}. Until it does, it is unknown, never $0.`;
  return "No part of the blueprint is approved, so the PE has nothing to estimate. Until then it is unknown, never $0.";
}

/** Where the stop stands: a word on the line only when it needs saying (stopped, continued), and one sentence. */
function stopWords(s: State, budget: number | null): { state?: { word: string; tone: Tone }; text: string } {
  if (budget === null) return { text: "No building budget is set, so the factory does not stop for cost." };
  const stop = budgetStop(s);
  if (stop) return { state: { word: "stopped", tone: "you" }, text: `${stop.why}. Nothing new starts until you raise the budget or continue past it.` };
  if (s.project.budgetContinued?.buildingUsd === budget) return { state: { word: "continued past it", tone: "neutral" }, text: "You continued past the budget. New work starts until you change the budget." };
  return { text: `At ${fmtUsd(budget)} the factory stops and asks you.` };
}

// ---------- decided by the PE ----------

const CALL_WORD: Record<PeCall["decision"], string> = { fix: "Fix it", accept: "Accept it as is", "follow-up": "Follow it up as a separate task" };

export interface PeCallWords {
  decisionId: string;
  taskId: string;
  taskTitle: string;
  href: string;
  /** The finding, in its reviewer's words. */
  finding: string;
  /** "Fix it", "Accept it as is", "Follow it up as WT-9". */
  call: string;
  /** The PE's reasons. */
  why: string;
  /** "build $1.00–$4.00 (Two recent repair runs)", or that it stated none. */
  cost: string;
  when: string;
  /** Why Reverse is off: the task finished or was cancelled, so nothing on it can be decided any more. */
  locked?: string;
}

/**
 * The trade-off calls the PE made within budget that stand, newest first: decisions the PE took (`decidedBy: "pe"`)
 * whose current call did not go past a budget. A call the owner reversed or took over is not listed.
 */
export function peCalls(s: State, nowMs = Date.now()): PeCallWords[] {
  return s.decisions
    .filter((d): d is FindingDecision & { pe: PeCall } => d.decidedBy === "pe" && d.status !== "open" && d.status !== "superseded" && !!F.currentPeCall(d) && !d.pe!.pastBudget)
    .sort((a, b) => (b.decidedAt ?? b.pe.at).localeCompare(a.decidedAt ?? a.pe.at) || b.id.localeCompare(a.id))
    .map((d) => {
      const t = s.tasks.find((x) => x.id === d.taskId);
      const lifecycle = t?.lifecycle;
      return {
        decisionId: d.id,
        taskId: d.taskId,
        taskTitle: t ? M.currentSpec(t).content.title : d.taskId,
        href: taskHref(d.taskId),
        finding: d.finding.title,
        call: d.status === "follow-up" && d.followUpTaskId ? `Follow it up as ${d.followUpTaskId}` : CALL_WORD[d.pe.decision],
        why: d.pe.why,
        cost: F.costLine(d.pe.cost),
        when: relTime(d.decidedAt ?? d.pe.at, nowMs),
        ...(lifecycle === "done" || lifecycle === "cancelled" ? { locked: `${d.taskId} is ${lifecycle === "done" ? "finished" : "cancelled"}, so the call stands.` } : {}),
      };
    });
}

/** The owner's Reverse of a PE call: the decision opens again and comes to them (Needs you), with their reason recorded. */
export const reverseCommand = (decisionId: string, why: string) => ({ name: "decideFinding" as const, args: { decisionId, decision: "reopen" as const, note: why } });

// ---------- change orders the lead is answering ----------

/**
 * The open change orders that do not wait for you, newest first: the lead is updating the tasks they touch. One that
 * waits for you is under Needs you instead, with its way to the change order's screen.
 */
export function changeOrdersInMotion(s: State): ChangeOrder[] {
  return B.openChangeOrders(s)
    .filter((co) => !M.changeOrderNeeds(s, co))
    .sort((a, b) => b.rev - a.rev);
}
