// Settings › Budgets (ORC-030 C3, a-settings-split): the building budget and the maintenance budget a month, in a
// section of their own, so Home and the pre-flight link here. The fields wait for Save (setBudgets); Continue past the
// budget acts at once. The card and its words are in BudgetsCard.tsx and budgets.ts.

import { useStore } from "../store";
import { budgetProblem, budgetsSteps, liveBudgets } from "./budgets";
import { BudgetsCard } from "./BudgetsCard";
import { sendInOrder, useDraft } from "./draft";
import { SettingsSection } from "./parts";
import type { SectionId } from "./sections";

export function BudgetsSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, send } = useStore();
  const draft = useDraft(liveBudgets(state));
  const v = draft.value;
  const invalid = budgetProblem(v.buildingUsd) ?? budgetProblem(v.maintenanceUsd);
  const save = async (begin: () => void) => {
    begin();
    return sendInOrder(budgetsSteps(v, draft.changed as ReadonlySet<string>, send));
  };
  return (
    <SettingsSection
      id="budgets"
      title="Budgets"
      help="Two limits in dollars, at the providers' published prices. Each is an estimate, not a bill. Changes here wait for Save; Continue past the budget acts at once."
      current={current}
      draft={draft}
      invalid={invalid}
      onSave={save}
      onDirty={onDirty}
    >
      <BudgetsCard v={v} set={draft.set} />
    </SettingsSection>
  );
}
