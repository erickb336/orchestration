// Settings › Project › Budgets and Devices (ORC-029 pass 6), as pure functions: the fields from the project, the
// owner's commands they make (setBudgets, setDevices), the domain's refusals in its own words, and what the cards say
// about the spend and the budget stop. Continue past the budget is its own command (continuePastBudget) and acts at
// once.

import { budgetStop, buildingSpend, fmtUsd, maintenanceEstimate } from "../../domain/spend";
import { DEVICES, type Device, type State } from "../../domain/types";
import type { ConfirmOptions } from "../kit";
import type { SendResult } from "../store";

// ---------- budgets ----------

export type BudgetsDraft = { buildingUsd: string; maintenanceUsd: string };
export const BUDGET_KEYS: readonly (keyof BudgetsDraft)[] = ["buildingUsd", "maintenanceUsd"];

/** The domain's words when a budget is not a positive amount (src/domain/model/budget.ts). */
export const BUDGET_REFUSED = "A budget is a positive amount in dollars, or not set.";

const field = (usd: number | null) => (usd === null ? "" : String(usd));

export function liveBudgets(s: State): BudgetsDraft {
  return { buildingUsd: field(s.project.budgets.buildingUsd), maintenanceUsd: field(s.project.budgets.maintenanceUsdPerMonth) };
}

/** A field's amount: null when empty (not set), undefined when it is not a positive amount. A leading "$" is allowed. */
export function budgetAmount(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$\s*/, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Why the domain refuses a field, in its words; undefined when it takes it. */
export const budgetProblem = (text: string): string | undefined => (budgetAmount(text) === undefined ? BUDGET_REFUSED : undefined);

/** The owner's command that saves both budgets, when one of them changed. */
export function budgetsSteps(v: BudgetsDraft, changed: ReadonlySet<string>, send: (name: "setBudgets", args: object) => Promise<SendResult>): (() => Promise<SendResult> | null)[] {
  if (!BUDGET_KEYS.some((k) => changed.has(k))) return [];
  return [() => send("setBudgets", { buildingUsd: budgetAmount(v.buildingUsd) ?? null, maintenanceUsdPerMonth: budgetAmount(v.maintenanceUsd) ?? null })];
}

const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;

export interface BudgetWords {
  /** The building spend so far, against the budget when there is one. */
  spent: string;
  /** The maintenance estimate, or that there is none yet (never $0). */
  maintenance: string;
  /** At the budget stop: why, and what the owner can do. */
  stop?: { title: string; text: string };
  /** The owner chose to continue past this budget. */
  continued?: string;
}

export function budgetWords(s: State): BudgetWords {
  const b = s.project.budgets;
  const spend = buildingSpend(s);
  const unknown = spend.unknown.length ? `; ${runs(spend.unknown.length)} with no recorded cost, not counted` : "";
  const m = maintenanceEstimate(s);
  const stop = budgetStop(s);
  const c = s.project.budgetContinued;
  return {
    spent: `Spent so far: ${fmtUsd(spend.usd)}${b.buildingUsd === null ? "" : ` of ${fmtUsd(b.buildingUsd)}`} in ${runs(spend.runs)}${unknown}.`,
    maintenance: m.startUsd === null ? "Maintenance estimate: none yet. Until there is one, a PE call that adds a monthly cost comes to you." : `Maintenance estimate: up to ${fmtUsd(m.startUsd + m.callsUsd)} a month.`,
    ...(stop ? { stop: { title: `${stop.why}.`, text: "Nothing new starts: no task step and no studio run. Raise the building budget and save, or continue past it." } } : {}),
    ...(c && c.buildingUsd === b.buildingUsd ? { continued: `You continued past the ${fmtUsd(c.buildingUsd)} budget at ${fmtUsd(c.spentUsd)} spent. New work starts until you change the building budget.` } : {}),
  };
}

/** Before Continue past the budget: what it does, and how it ends. */
export function continuePastConfirm(s: State): ConfirmOptions {
  const b = s.project.budgets.buildingUsd;
  return {
    title: "Continue past the budget?",
    text: `New work starts again, and the spend goes past ${b === null ? "the budget" : fmtUsd(b)}. This lasts until you change the building budget.`,
    primaryLabel: "Continue past the budget",
  };
}

// ---------- devices ----------

/** The device scope's choices: what the studio designs for each. */
export const DEVICE_CHOICES: readonly { value: Device; label: string; hint: string }[] = [
  { value: "desktop", label: "Desktop", hint: "Screens at 1280 pixels wide." },
  { value: "mobile", label: "Mobile", hint: "Screens at 390 pixels wide." },
  { value: "terminal", label: "Terminal", hint: "Demos of a command-line tool in a terminal." },
];

/** The domain's words when no device is chosen (src/domain/model/shaping.ts). */
export const DEVICES_REFUSED = "Choose at least one device: desktop, mobile or terminal.";

/** The devices with `d` added, or taken away when it is there; always in the fixed order. */
export function toggleDevice(chosen: readonly Device[], d: Device): Device[] {
  const next = chosen.includes(d) ? chosen.filter((x) => x !== d) : [...chosen, d];
  return DEVICES.filter((x) => next.includes(x));
}

export const devicesProblem = (chosen: readonly Device[]): string | undefined => (chosen.length ? undefined : DEVICES_REFUSED);

/** The owner's command that saves the device scope, when it changed. */
export function devicesSteps(devices: readonly Device[], changed: boolean, send: (name: "setDevices", args: object) => Promise<SendResult>): (() => Promise<SendResult> | null)[] {
  return changed ? [() => send("setDevices", { devices })] : [];
}
