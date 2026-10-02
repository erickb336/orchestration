// The owner's budgets: setting them, and continuing past the building budget once it is reached.
// The stop itself is derived (spend.ts) and enforced where new work starts (dispatch, planning).

import { budgetStop, fmtUsd } from "../spend";
import { type Budgets, type State, ControlError } from "../types";
import { draft, event } from "./core";

const line = (usd: number | null, unit = "") => (usd === null ? "not set" : `${fmtUsd(usd)}${unit}`);

/**
 * Set both budgets: each a positive amount in dollars, or null (not set). A new building budget ends a choice to
 * continue past the old one, so returning to that amount later stops work again.
 */
export function setBudgets(state: State, budgets: Budgets, now: string): State {
  const ok = (v: number | null) => v === null || (Number.isFinite(v) && v > 0);
  if (!ok(budgets.buildingUsd) || !ok(budgets.maintenanceUsdPerMonth)) throw new ControlError("A budget is a positive amount in dollars, or not set.");
  const s = draft(state);
  const ended = s.project.budgetContinued !== undefined && budgets.buildingUsd !== s.project.budgets.buildingUsd;
  if (ended) delete s.project.budgetContinued;
  s.project.budgets = { buildingUsd: budgets.buildingUsd, maintenanceUsdPerMonth: budgets.maintenanceUsdPerMonth };
  event(s, now, "user", "config", `Budgets: building ${line(budgets.buildingUsd)}, maintenance ${line(budgets.maintenanceUsdPerMonth, " a month")}${ended ? "; continuing past the building budget ends" : ""}`);
  return s;
}

/**
 * The owner's choice at the building budget: new work starts again, without raising it. It holds while the
 * building budget stays at this amount and the project keeps building; changing the building budget (setBudgets)
 * or going back to vision ends it. Refused while the budget is not reached.
 */
export function continuePastBudget(state: State, now: string): State {
  const stop = budgetStop(state);
  if (!stop) throw new ControlError("The building budget is not reached.");
  const s = draft(state);
  s.project.budgetContinued = { at: now, buildingUsd: stop.budgetUsd, spentUsd: stop.spend.usd };
  event(s, now, "user", "config", `Continued past the building budget (${fmtUsd(stop.spend.usd)} of ${fmtUsd(stop.budgetUsd)}): new work starts until the budget changes or the project goes back to vision`);
  return s;
}
