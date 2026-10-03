// Settings › Project: the repository, the kind of product (its domains) and its devices, the preview the service runs
// for evidence, the environment the checks run in, the stage (Vision or the factory), the budgets, and how finished
// work leaves (the delivery mode, the remote and base, who merges). Settings wait for Save; Start the factory opens its
// pre-flight, and Continue past the budget acts at once. In real mode, Start a new project is its own form with its
// own button.

import { useState } from "react";
import * as M from "../../domain/model";
import type { Device, ProjectDomain } from "../../domain/types";
import { Button, Checkbox, Chip, Disclosure, Field, Input, Textarea, useConfirm } from "../kit";
import { DeliveryCard, deliveryErrors, deliverySteps, liveDelivery, type DeliveryDraft } from "../DeliverySettings";
import { StartFactoryLink } from "../preflight/StartFactoryLink";
import { confirmNewProject } from "../settingsText";
import { DOMAIN_CHOICES, toggleDomain } from "../studio/studioView";
import { initProjectConfirm } from "../stageChoice";
import { useStore } from "../store";
import { budgetProblem, budgetsSteps, devicesProblem, devicesSteps, liveBudgets, type BudgetsDraft } from "./budgets";
import { BudgetsCard } from "./BudgetsCard";
import { DevicesCard } from "./DevicesCard";
import { sendInOrder, useDraft } from "./draft";
import { SettingsCard, SettingsSection } from "./parts";
import { EnvironmentCard } from "./EnvironmentCard";
import { ENVIRONMENT_KEYS, environmentProblem, environmentSteps, liveEnvironment, type EnvironmentDraft } from "./environment";
import { PreviewCard } from "./PreviewCard";
import { PREVIEW_KEYS, livePreview, previewProblem, previewSteps, type PreviewDraft } from "./preview";
import type { SectionId } from "./sections";

type ProjectDraft = DeliveryDraft & PreviewDraft & EnvironmentDraft & BudgetsDraft & { repoPath: string; conventions: boolean; domains: ProjectDomain[]; devices: Device[] };

/** Why the chosen kinds cannot be saved: none chosen, once the project has some (they can be changed, never cleared). */
export function domainsError(live: readonly ProjectDomain[], chosen: readonly ProjectDomain[]): string | undefined {
  return live.length && !chosen.length ? "Choose at least one kind." : undefined;
}

export function ProjectSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, service, send } = useStore();
  const confirm = useConfirm();
  const real = service.runtime === "real";
  const liveDel = liveDelivery(state);
  const live: ProjectDraft = { ...liveDel, ...livePreview(state), ...liveEnvironment(state), ...liveBudgets(state), repoPath: state.project.repoPath, conventions: state.project.conventions?.include ?? true, domains: state.project.domains, devices: state.project.devices };
  const draft = useDraft(live);
  const v = draft.value;
  const previewChanged = PREVIEW_KEYS.some((k) => draft.changed.has(k));
  const environmentChanged = ENVIRONMENT_KEYS.some((k) => draft.changed.has(k));
  const errors = { repoPath: v.repoPath.trim() ? undefined : "Give the repository's path.", domains: domainsError(live.domains, v.domains), ...deliveryErrors(v), preview: previewChanged ? previewProblem(v) : undefined, environment: environmentChanged ? environmentProblem(v) : undefined, devices: devicesProblem(v.devices), building: budgetProblem(v.buildingUsd), maintenance: budgetProblem(v.maintenanceUsd) };
  const invalid = Object.values(errors).find(Boolean);

  const save = async (begin: () => void) => {
    const delivery = await deliverySteps(state, real, liveDel, v, draft.changed, send, confirm);
    if (!delivery) return false;
    begin();
    return sendInOrder([
      () => (draft.changed.has("repoPath") ? send("setRepoPath", { repoPath: v.repoPath.trim() }) : null),
      () => (draft.changed.has("conventions") ? send("setConventions", { include: v.conventions }) : null),
      () => (draft.changed.has("domains") && v.domains.length ? send("setDomains", { domains: v.domains }) : null),
      ...previewSteps(v, draft.changed as ReadonlySet<string>, send),
      ...environmentSteps(v, draft.changed as ReadonlySet<string>, send),
      ...devicesSteps(v.devices, draft.changed.has("devices"), send),
      ...budgetsSteps(v, draft.changed as ReadonlySet<string>, send),
      ...delivery,
    ]);
  };

  const repo = service.repo;
  return (
    <SettingsSection
      id="project"
      title="Project"
      help="Your repository, the kind of product and its devices, the preview for evidence, the environment the checks run in, the stage and the budgets, and how finished work leaves Orchestrator. Changes here wait for Save; Start the factory opens its pre-flight, and Continue past the budget acts at once."
      current={current}
      draft={draft}
      invalid={invalid}
      onSave={save}
      onDirty={onDirty}
    >
      <SettingsCard id="repository" title="Repository" help="Agents work in separate worktrees of it and never edit its working tree.">
        <Field
          label="Repository path"
          error={errors.repoPath}
          hint={real ? (repo?.ok ? `Ready${repo.branch ? `, on ${repo.branch}` : ""}. A new path applies to runs not yet started.` : `Not usable${repo?.reason ? `: ${repo.reason}` : "."}`) : "The sample project has no repository of its own."}
        >
          <Input type="text" className="s-mono" value={v.repoPath} onChange={(e) => draft.set({ repoPath: e.target.value })} />
        </Field>
        {real && (
          <Checkbox
            label="Give every run the repository's AGENTS.md and CLAUDE.md as project conventions"
            hint="Read from the trusted base, never from a worktree agents write, and labelled so they never change a run's role."
            checked={v.conventions}
            onChange={(e) => draft.set({ conventions: e.target.checked })}
          />
        )}
      </SettingsCard>

      <SettingsCard
        id="domains"
        title="Kind of product"
        help={live.domains.length ? "What the studio's designer makes follows it. Choose every kind that fits." : "Not chosen yet. What the studio's designer makes follows it. Choose every kind that fits."}
      >
        <fieldset className="s-choices">
          <legend className="sr-only">Kind of product</legend>
          {DOMAIN_CHOICES.map((c) => (
            <Checkbox
              key={c.value}
              label={c.label}
              hint={`${c.use} ${c.makes}`}
              checked={v.domains.includes(c.value)}
              onChange={() => draft.set({ domains: toggleDomain(v.domains, c.value) })}
            />
          ))}
        </fieldset>
        {errors.domains && (
          <p className="s-error" role="alert">
            {errors.domains}
          </p>
        )}
      </SettingsCard>

      <DevicesCard devices={v.devices} set={(devices) => draft.set({ devices })} />

      <PreviewCard v={v} set={draft.set} />

      <EnvironmentCard v={v} set={draft.set} />

      <StageCard />

      <BudgetsCard v={v} set={draft.set} />

      <DeliveryCard v={v} set={draft.set} confirm={confirm} />

      {real && <NewProjectCard openByDefault={!repo?.ok} />}
    </SettingsSection>
  );
}

/**
 * The stage: Vision (the domain's "shaping": the studio designs with you, nothing is built) or the factory
 * ("building"). Start the factory opens its pre-flight. Once the factory runs, there is no way back: Vision stays open
 * while it runs (ORC-029 r12), and Pause stops new work.
 */
function StageCard() {
  const { state } = useStore();
  const shaping = state.project.stage === "shaping";
  return (
    <SettingsCard
      id="stage"
      title={
        <>
          Stage <Chip strong>{shaping ? "Vision" : "The factory"}</Chip>
        </>
      }
      help={
        shaping
          ? `${M.SHAPING_LABEL}. The lead answers your messages, and the studio designs with you.`
          : "The factory builds from the blueprint in force. Vision stays open: change the design there, and Lock in each change. Pause the project to stop new work."
      }
    >
      {shaping ? (
        <StartFactoryLink variant="secondary" />
      ) : (
        <p className="small no-margin">
          <a href="#/vision">Open Vision</a>
        </p>
      )}
    </SettingsCard>
  );
}

/** Real mode: replace the board with an empty project. Its own form and button; not part of the section's Save. */
function NewProjectCard({ openByDefault }: { openByDefault: boolean }) {
  const { state, send, disabled } = useStore();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [vision, setVision] = useState("");
  const [focus, setFocus] = useState("");
  // Every project begins in Vision (the vision may stay empty); the factory starts only when you start it.
  const docCount = M.currentVisionDocs(state).length;
  return (
    <SettingsCard id="new-project" title="Start a new project" help="Replaces this board and its history with an empty project; refused while any run is active.">
      <Disclosure label="New project form" defaultOpen={openByDefault}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!(await confirm(confirmNewProject(name, initProjectConfirm(name, docCount))))) return;
            await send("initProject", { name, repoPath: repo, vision, focus });
          }}
        >
          <div className="s-fields s-fields--wide">
            <Field label="Name">
              <Input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Repository path (absolute)" hint="A git repository with at least one commit.">
              <Input type="text" className="s-mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/path/to/your/repo" required />
            </Field>
          </div>
          <Field label="Vision (optional)" className="s-gap">
            <Textarea value={vision} onChange={(e) => setVision(e.target.value)} />
          </Field>
          <Field label="Current focus">
            <Input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} />
          </Field>
          <Button type="submit" className="s-gap" disabled={disabled}>
            Start project
          </Button>
        </form>
      </Disclosure>
    </SettingsCard>
  );
}
