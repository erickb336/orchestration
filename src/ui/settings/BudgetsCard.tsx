// Settings › Project › Budgets (ORC-029 pass 6): the building budget and the maintenance budget a month, what each
// covers, and the spend so far. The fields edit the Project section's draft; Save sends setBudgets. At the budget
// stop, Continue past the budget sends continuePastBudget at once, after the owner confirms. The words are in
// budgets.ts.

import { Banner, Button, Field, Input, useConfirm } from "../kit";
import { useStore } from "../store";
import { budgetProblem, budgetWords, continuePastConfirm, type BudgetsDraft } from "./budgets";
import { SettingsCard } from "./parts";

export function BudgetsCard({ v, set }: { v: BudgetsDraft; set: (p: Partial<BudgetsDraft>) => void }) {
  const { state, send, disabled } = useStore();
  const confirm = useConfirm();
  const w = budgetWords(state);
  const goOn = async () => {
    if (await confirm(continuePastConfirm(state))) await send("continuePastBudget", {});
  };
  return (
    <SettingsCard id="budgets" title="Budgets" help="Two limits in dollars, at the providers' published prices. Each is an estimate, not a bill.">
      {w.stop && (
        <Banner
          tone="you"
          title={w.stop.title}
          actions={
            <Button variant="primary" disabled={disabled} onClick={() => void goOn()}>
              Continue past the budget
            </Button>
          }
        >
          {w.stop.text}
        </Banner>
      )}
      <div className="s-fields s-fields--wide">
        <Field
          label="Building budget (dollars)"
          hint="What all agent runs may spend to build the product, the studio's runs in Vision included. At it, nothing new starts and the factory asks you. Empty: no limit."
          error={budgetProblem(v.buildingUsd)}
        >
          <Input type="text" inputMode="decimal" value={v.buildingUsd} placeholder="Not set" onChange={(e) => set({ buildingUsd: e.target.value })} />
        </Field>
        <Field
          label="Maintenance budget (dollars a month)"
          hint="What the product may cost to run each month. It stops no work: a PE call that could go past it comes to you. Empty: no limit."
          error={budgetProblem(v.maintenanceUsd)}
        >
          <Input type="text" inputMode="decimal" value={v.maintenanceUsd} placeholder="Not set" onChange={(e) => set({ maintenanceUsd: e.target.value })} />
        </Field>
      </div>
      <p className="s-note">
        {w.spent} {w.maintenance}
        {w.continued ? ` ${w.continued}` : ""}
      </p>
    </SettingsCard>
  );
}
