// The factory floor (ORC-029 pass 6, screen 8 of the pass 1 prototype) in words, as pure functions over the state:
// Home after the start. One line per area with each task at its station (building, review, checks, evidence, landed),
// a change order or "needs you" marked on its task; the two budgets; the trade-off calls the PE made within budget;
// and the open change orders the lead is answering. The facts are the domain's: the money comes from spend.ts and the
// Lock in summary's budgets (never computed here), what waits for you from needsYou.ts, the calls from findings.ts.
// An unknown cost is "no estimate", never $0.

import * as F from "../../domain/findings";
import * as M from "../../domain/model";
import { budgetStop, buildingSpend, committedBuildUsd, fmtUsd, unrecordedWords } from "../../domain/spend";
import * as B from "../../domain/studio/blueprint";
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
      tasks: all.slice(0, MAX_ON_LINE),
      more: Math.max(0, all.length - MAX_ON_LINE),
    };
  });
}

// ---------- the two budgets ----------

export interface BudgetWords {
  building: {
    /** "$11.20 of $40.00 spent", or "$11.20 spent". */
    spent: string;
    /** The costs with no full record and their estimate, or that the spend cannot be checked (never counted as $0). */
    unknown?: string;
    /** "PE estimate for the rest: $9.00–$16.00", or "PE estimate for the rest: no estimate". */
    estimate: string;
    /** What the PE's standing calls commit before their work has run. */
    committed?: string;
    /** The stop's state: a pill and one sentence. */
    stop: { word: string; tone: Tone; text: string };
  };
  maintenance: {
    /** "$30.00 a month of your $50.00", or "No estimate yet". */
    estimate: string;
    /** Where the estimate comes from, and what changes it. */
    basis: string;
  };
}

/**
 * The two budgets in words. Building: the spend of the budget, the PE's estimate for the rest (the newest start's
 * pre-flight estimate), what the PE's calls commit, and where the stop stands. Maintenance: the PE's estimate a month
 * (the start's estimate and the PE calls that stand) against its budget.
 */
export function budgetWords(s: State): BudgetWords {
  const b = B.lockInSummary(s).budgets;
  const budget = b.building.budgetUsd;
  const estimate = s.project.factoryStarts.at(-1)?.estimate?.buildUsd;
  const committed = committedBuildUsd(s);
  const unknown = unrecordedWords(buildingSpend(s));
  const m = b.maintenance;
  return {
    building: {
      spent: budget === null ? `${fmtUsd(b.building.spentUsd)} spent` : `${fmtUsd(b.building.spentUsd)} of ${fmtUsd(budget)} spent`,
      ...(unknown ? { unknown } : {}),
      estimate: `PE estimate for the rest: ${estimate ? range(estimate) : "no estimate"}`,
      ...(committed > 0 ? { committed: `Up to ${fmtUsd(committed)} is committed to PE calls whose work has not run.` } : {}),
      stop: stopWords(s, budget),
    },
    maintenance: {
      estimate:
        m.estimateUsdPerMonth === null
          ? `No estimate yet${m.budgetUsdPerMonth === null ? "" : ` · your budget is ${fmtUsd(m.budgetUsdPerMonth)} a month`}`
          : `${fmtUsd(m.estimateUsdPerMonth)} a month${m.budgetUsdPerMonth === null ? " · no budget set" : ` of your ${fmtUsd(m.budgetUsdPerMonth)}`}`,
      basis: m.estimateUsdPerMonth === null ? "The PE estimates it before the factory starts. Until then it is unknown, never $0." : "The PE's estimate at the start, updated by each trade-off call the PE makes.",
    },
  };
}

function stopWords(s: State, budget: number | null): BudgetWords["building"]["stop"] {
  if (budget === null) return { word: "No budget", tone: "neutral", text: "No building budget is set, so the factory does not stop for cost." };
  const stop = budgetStop(s);
  if (stop) return { word: "Stopped", tone: "you", text: `${stop.why}. Nothing new starts until you raise the budget or continue past it.` };
  if (s.project.budgetContinued?.buildingUsd === budget) return { word: "Continued", tone: "neutral", text: `You continued past the budget. New work starts until you change the budget.` };
  return { word: "Within budget", tone: "done", text: `At ${fmtUsd(budget)} the factory stops and asks you.` };
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
