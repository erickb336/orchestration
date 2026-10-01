// ORC-025 pass 5, Settings › Quality: the checks every change must pass (S4: "On · 2 commands", Suggest from
// repository, Edit commands), the default flow and the six flows, and the principles agents work by. Flows and
// principles are read-only here: they change through their files in the repository.

import { useConfirm, Chip, Disclosure, Field, Select } from "../kit";
import { effectiveDefault } from "../../domain/flows";
import { EVERY_RUN_PRINCIPLE_IDS, LEAD_PRINCIPLE_IDS, PREMISE_ID, PRINCIPLES, PSTACK_COMMIT, principleName } from "../../domain/principles";
import { ChecksCard, checksProblem, checksSteps, liveChecks, type ChecksDraft } from "../ChecksSettings";
import { FlowSteps } from "../FlowPicker";
import { defaultFlowNote } from "../flowView";
import { useStore } from "../store";
import { sendInOrder, useDraft } from "./draft";
import { SettingsCard, SettingsSection } from "./parts";
import type { SectionId } from "./sections";

type QualityDraft = ChecksDraft & { defaultFlow: string };

/** Orchestrator's own principle; the others are adapted from pstack. */
const OWN_PRINCIPLE = "contextualize-and-write-for-the-reader";
const isIn = (ids: readonly string[], id: string) => ids.includes(id);

export function QualitySection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, send } = useStore();
  const confirm = useConfirm();
  const flows = state.flows;
  const stored = state.project.defaultFlowId;
  const effective = effectiveDefault(state);
  const live: QualityDraft = { ...liveChecks(state), defaultFlow: flows.some((f) => f.id === stored) ? stored : effective.id };
  const draft = useDraft(live);
  const v = draft.value;
  const checksChanged = new Set([...draft.changed].filter((k): k is keyof ChecksDraft => k === "enabled" || k === "commands"));
  const invalid = checksChanged.size ? checksProblem(state, v) : undefined;
  const note = defaultFlowNote(stored, flows, effective);

  const save = async (begin: () => void) => {
    const checks = await checksSteps(state, v, checksChanged, send, confirm);
    if (!checks) return false;
    begin();
    return sendInOrder([...checks, () => (draft.changed.has("defaultFlow") ? send("setDefaultFlow", { flowId: v.defaultFlow }) : null)]);
  };

  return (
    <SettingsSection
      id="quality"
      title="Quality"
      help="What every change must pass, and the flows and principles the work follows. Changes here wait for Save; Suggest from repository only fills in the commands."
      current={current}
      draft={draft}
      invalid={invalid}
      onSave={save}
      onDirty={onDirty}
    >
      <ChecksCard v={v} set={draft.set} />

      <SettingsCard id="flows" title="Flows" help="Every task runs one of these; the lead picks one per task, and you can change it on the task page. They are read-only here and change through their files in flows/.">
        <Field label="Default flow" hint={note ?? "Used by the lead's proposals and breakdowns that name none, and preselected in New task."} width="medium">
          <Select value={v.defaultFlow} onChange={(e) => draft.set({ defaultFlow: e.target.value })} options={flows.map((f) => ({ value: f.id, label: f.name }))} />
        </Field>
        <Disclosure label="The flows" count={flows.length}>
          <ul className="s-list" aria-label="The flows">
            {flows.map((f) => (
              <li key={f.id}>
                <div className="s-list__title">
                  {f.name}
                  {f.id === v.defaultFlow && <Chip>Default</Chip>}
                </div>
                <div className="s-list__meta">
                  {f.description} Use it for: {f.whenToUse}
                </div>
                <Disclosure label={`${f.steps.length} steps`}>
                  <FlowSteps steps={f.steps} />
                </Disclosure>
              </li>
            ))}
          </ul>
        </Disclosure>
      </SettingsCard>

      <SettingsCard id="principles" title="Principles" help="Short working principles each agent gets with its instructions, chosen per flow step; they change through their files in principles/.">
        <Disclosure label="The principles" count={PRINCIPLES.length}>
          <ul className="s-list" aria-label="The principles">
            {PRINCIPLES.map((pr) => (
              <li key={pr.id}>
                <div className="s-list__title">
                  {pr.name}
                  {isIn(EVERY_RUN_PRINCIPLE_IDS, pr.id) ? <Chip>Every agent and the lead</Chip> : isIn(LEAD_PRINCIPLE_IDS, pr.id) && <Chip>The lead</Chip>}
                  {pr.id === PREMISE_ID && <Chip>A repair after the same failure</Chip>}
                </div>
                <div className="s-list__meta">Apply when: {pr.applyWhen}</div>
              </li>
            ))}
          </ul>
        </Disclosure>
        <p className="s-note">
          Apart from &quot;{principleName(OWN_PRINCIPLE)}&quot;, Orchestrator&apos;s own, they are adapted from pstack by Lauren Tan (MIT), commit <code>{PSTACK_COMMIT.slice(0, 7)}</code> of github.com/cursor/plugins; the license is in <code>principles/LICENSE-pstack</code>.
        </p>
      </SettingsCard>
    </SettingsSection>
  );
}
