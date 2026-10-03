// ORC-029 pass 6's settings forms: the budgets and the device scope (Settings › Project). Each saves through its
// owner's command and shows the domain's refusal, in the domain's words, before Save. At the budget stop, Continue past
// the budget sends its command at once. Rendered statically (there is no DOM test environment): a form's fields are
// given, and its save is run against the domain.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import { budgetStop } from "../../domain/spend";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import type { State } from "../../domain/types";
import type { SendResult } from "../store";
import { renderScreen, visible } from "../testStore";
import { BUDGET_REFUSED, DEVICES_REFUSED, budgetProblem, budgetWords, budgetsSteps, continuePastConfirm, devicesProblem, devicesSteps, liveBudgets, toggleDevice } from "./budgets";
import { BudgetsCard } from "./BudgetsCard";
import { DevicesCard } from "./DevicesCard";
import { sendInOrder } from "./draft";
import { ProjectSection } from "./Project";

const noop = () => {};
const T = "2026-10-02T10:00:00.000Z";

type Send = (name: string, args: object) => Promise<SendResult>;
type Steps = (() => Promise<SendResult> | null)[];

/** Run a form's save against the domain, as the service would: each command it sends, in order. */
async function save(s: State, steps: (send: Send) => Steps): Promise<{ state: State; sent: [string, object][] }> {
  let state = s;
  const sent: [string, object][] = [];
  const send: Send = async (name, args) => {
    sent.push([name, args]);
    state = runCommand(state, name as never, args, T).state;
    return { ok: true };
  };
  expect(await sendInOrder(steps(send))).toBe(true);
  return { state, sent };
}

describe("Settings › Project › Budgets", () => {
  it("says what each budget covers and what was spent so far; no maintenance estimate is never $0", () => {
    const { s } = blueprintScene();
    const text = visible(renderScreen(<ProjectSection current onDirty={noop} />, s));
    expect(text).toContain("Budgets Two limits in dollars, at the providers' published prices. Each is an estimate, not a bill.");
    expect(text).toContain("Building budget (dollars) What all agent runs may spend to build the product, the studio's runs in Vision included. At it, nothing new starts and the factory asks you. Empty: no limit.");
    expect(text).toContain("Maintenance budget (dollars a month) What the product may cost to run each month. It stops no work: a PE call that could go past it comes to you. Empty: no limit.");
    expect(budgetWords(s).spent).toBe("Spent so far: $9.90 of $40.00 in 9 runs.");
    expect(budgetWords(s).maintenance).toBe("Maintenance estimate: none yet. Until there is one, a PE call that adds a monthly cost comes to you.");
    expect(text).not.toContain("Raise the building budget");
  });

  it("saves both budgets through setBudgets; an empty field is no budget; an unchanged form sends nothing", async () => {
    const { s } = blueprintScene();
    expect(liveBudgets(s)).toEqual({ buildingUsd: "40", maintenanceUsd: "10" });
    const r = await save(s, (send) => budgetsSteps({ buildingUsd: " $60 ", maintenanceUsd: "12.5" }, new Set(["buildingUsd", "maintenanceUsd"]), send));
    expect(r.sent).toEqual([["setBudgets", { buildingUsd: 60, maintenanceUsdPerMonth: 12.5 }]]);
    expect(liveBudgets(r.state)).toEqual({ buildingUsd: "60", maintenanceUsd: "12.5" });
    expect(budgetWords(r.state).spent).toBe("Spent so far: $9.90 of $60.00 in 9 runs.");
    const cleared = await save(r.state, (send) => budgetsSteps({ buildingUsd: "", maintenanceUsd: "12.5" }, new Set(["buildingUsd"]), send));
    expect(cleared.state.project.budgets).toEqual({ buildingUsd: null, maintenanceUsdPerMonth: 12.5 });
    expect(budgetWords(cleared.state).spent).toBe("Spent so far: $9.90 in 9 runs.");
    expect(budgetsSteps(liveBudgets(s), new Set(["repoPath"]), async () => ({ ok: true }))).toEqual([]);
  });

  it("shows the domain's refusal under a field that is not a positive amount, the same words the service answers with", () => {
    const { s } = blueprintScene();
    for (const text of ["0", "-5", "forty"]) expect(budgetProblem(text)).toBe(BUDGET_REFUSED);
    expect(() => runCommand(s, "setBudgets", { buildingUsd: 0, maintenanceUsdPerMonth: null }, T)).toThrow(BUDGET_REFUSED);
    expect(visible(renderScreen(<BudgetsCard v={{ buildingUsd: "0", maintenanceUsd: "" }} set={noop} />, s))).toContain(BUDGET_REFUSED);
    expect([budgetProblem(""), budgetProblem("$3.50")]).toEqual([undefined, undefined]);
  });

  it("at the budget stop: says why, and Continue past the budget starts new work again until the budget changes", async () => {
    const { s: base } = blueprintScene();
    const s = runCommand(base, "setBudgets", { buildingUsd: 1, maintenanceUsdPerMonth: null }, T).state;
    const stop = budgetStop(s)!;
    const text = visible(renderScreen(<BudgetsCard v={liveBudgets(s)} set={noop} />, s));
    expect(text).toContain(`${stop.why}. Nothing new starts: no task step and no studio run. Raise the building budget and save, or continue past it. Continue past the budget`);
    expect(continuePastConfirm(s)).toEqual({ title: "Continue past the budget?", text: "New work starts again, and the spend goes past $1.00. This lasts until you change the building budget.", primaryLabel: "Continue past the budget" });
    // The button's command: the stop ends, and the card says the choice and how it ends.
    const on = runCommand(s, "continuePastBudget", {}, T).state;
    expect(budgetStop(on)).toBeUndefined();
    const after = visible(renderScreen(<BudgetsCard v={liveBudgets(on)} set={noop} />, on));
    expect(after).not.toContain("Nothing new starts");
    expect(after).toContain(`You continued past the $1.00 budget at $${stop.spend.usd.toFixed(2)} spent. New work starts until you change the building budget.`);
    // Below the budget there is no stop, and the domain refuses to continue past it.
    expect(() => runCommand(base, "continuePastBudget", {}, T)).toThrow("The building budget is not reached.");
    // A new building budget ends the choice.
    const raised = runCommand(on, "setBudgets", { buildingUsd: 2, maintenanceUsdPerMonth: null }, T).state;
    expect(budgetWords(raised).continued).toBeUndefined();
  });
});

describe("Settings › Project › Devices", () => {
  it("shows the device scope with what the studio designs for each", () => {
    const { s } = blueprintScene();
    const text = visible(renderScreen(<DevicesCard devices={s.project.devices} set={noop} />, s));
    expect(text).toContain("Devices The studio designs for these devices, and evidence shows the built product on them.");
    expect(text).toContain("Desktop Screens at 1280 pixels wide. Mobile Screens at 390 pixels wide. Terminal Demos of a command-line tool in a terminal.");
  });

  it("saves through setDevices in a fixed order; none chosen shows the domain's refusal", async () => {
    const { s } = blueprintScene();
    const chosen = toggleDevice(toggleDevice(["mobile"], "terminal"), "desktop");
    expect(chosen).toEqual(["desktop", "mobile", "terminal"]);
    const r = await save(s, (send) => devicesSteps(chosen, true, send));
    expect([r.sent, r.state.project.devices]).toEqual([[["setDevices", { devices: chosen }]], chosen]);
    expect(devicesSteps(chosen, false, async () => ({ ok: true }))).toEqual([]);
    const none = toggleDevice(["desktop"], "desktop");
    expect(devicesProblem(none)).toBe(DEVICES_REFUSED);
    expect(() => runCommand(s, "setDevices", { devices: none }, T)).toThrow(DEVICES_REFUSED);
    expect(visible(renderScreen(<DevicesCard devices={none} set={noop} />, s))).toContain(DEVICES_REFUSED);
  });
});
