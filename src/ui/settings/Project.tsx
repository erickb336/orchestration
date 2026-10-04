// Settings › Project: the repository, the kind of product (its domains) and its devices, and how finished work
// leaves (the delivery mode, the remote and base, who merges). Settings wait for Save. The budgets and how the project
// runs have sections of their own (BudgetsSection.tsx, Runs.tsx). In real mode, Start a new project is its own form with its
// own button.

import { useState } from "react";
import * as M from "../../domain/model";
import type { Device, ProjectDomain } from "../../domain/types";
import { Button, Checkbox, Disclosure, Field, Input, SegmentedControl, Textarea, useConfirm } from "../kit";
import { StartImport } from "../import/StartImport";
import { DeliveryCard, deliveryErrors, deliverySteps, liveDelivery, type DeliveryDraft } from "../DeliverySettings";
import { confirmNewProject } from "../settingsText";
import { DOMAIN_CHOICES, toggleDomain } from "../studio/studioView";
import { initProjectConfirm } from "../stageChoice";
import { useStore } from "../store";
import { devicesProblem, devicesSteps } from "./budgets";
import { DevicesCard } from "./DevicesCard";
import { sendInOrder, useDraft } from "./draft";
import { SettingsCard, SettingsSection } from "./parts";
import type { SectionId } from "./sections";

type ProjectDraft = DeliveryDraft & { repoPath: string; conventions: boolean; domains: ProjectDomain[]; devices: Device[] };

/** Why the chosen kinds cannot be saved: none chosen, once the project has some (they can be changed, never cleared). */
export function domainsError(live: readonly ProjectDomain[], chosen: readonly ProjectDomain[]): string | undefined {
  return live.length && !chosen.length ? "Choose at least one kind." : undefined;
}

export function ProjectSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, service, send } = useStore();
  const confirm = useConfirm();
  const real = service.runtime === "real";
  const liveDel = liveDelivery(state);
  const live: ProjectDraft = { ...liveDel, repoPath: state.project.repoPath, conventions: state.project.conventions?.include ?? true, domains: state.project.domains, devices: state.project.devices };
  const draft = useDraft(live);
  const v = draft.value;
  const errors = { repoPath: v.repoPath.trim() ? undefined : "Give the repository's path.", domains: domainsError(live.domains, v.domains), ...deliveryErrors(v), devices: devicesProblem(v.devices) };
  const invalid = Object.values(errors).find(Boolean);

  const save = async (begin: () => void) => {
    const delivery = await deliverySteps(state, real, liveDel, v, draft.changed, send, confirm);
    if (!delivery) return false;
    begin();
    return sendInOrder([
      () => (draft.changed.has("repoPath") ? send("setRepoPath", { repoPath: v.repoPath.trim() }) : null),
      () => (draft.changed.has("conventions") ? send("setConventions", { include: v.conventions }) : null),
      () => (draft.changed.has("domains") && v.domains.length ? send("setDomains", { domains: v.domains }) : null),
      ...devicesSteps(v.devices, draft.changed.has("devices"), send),
      ...delivery,
    ]);
  };

  const repo = service.repo;
  return (
    <SettingsSection
      id="project"
      title="Project"
      help="Your repository, the kind of product and its devices, and how finished work leaves Orchestrator. Changes here wait for Save."
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

      <DeliveryCard v={v} set={draft.set} confirm={confirm} />

      {real ? <NewProjectCard openByDefault={!repo?.ok} /> : <TryImportCard />}
    </SettingsSection>
  );
}

/**
 * The demo: the import on the invented sample repository, tally (ORC-032), with the simulated runtime. It replaces the
 * sample project, as a new project does in real mode.
 */
function TryImportCard() {
  const [open, setOpen] = useState(false);
  return (
    <SettingsCard id="new-project" title="Import an existing repository" help="In the demo, the import reads tally, an invented command-line tool, and every run is simulated. It replaces the sample project.">
      {open ? (
        <StartImport sample onCancel={() => setOpen(false)} />
      ) : (
        <div>
          <Button onClick={() => setOpen(true)}>Try the import on a sample repository (tally)</Button>
        </div>
      )}
    </SettingsCard>
  );
}

/** What the page says once a new project started, as it opens Vision. */
const projectStartedNotice = (name: string) => `"${name}" is ready. Every project begins in Vision: design it there with the lead.`;

/**
 * Real mode: replace the board with an empty project. Its own form and button; not part of the section's Save. Once
 * it started, the page says so and opens Vision, where every project begins.
 */
function NewProjectCard({ openByDefault }: { openByDefault: boolean }) {
  const [how, setHow] = useState<"idea" | "import">("idea");
  return (
    <SettingsCard id="new-project" title="Start a new project" help="Replaces this board and its history with an empty project; refused while any run is active.">
      <Disclosure label="New project form" defaultOpen={openByDefault}>
        <div className="k-stack">
          <SegmentedControl
            label="How the project starts"
            value={how}
            onChange={setHow}
            options={[
              { value: "idea", label: "From an idea" },
              { value: "import", label: "Import an existing repository" },
            ]}
          />
          {how === "idea" ? <FromAnIdea /> : <StartImport sample={false} />}
        </div>
      </Disclosure>
    </SettingsCard>
  );
}

/** A new project from an idea: its name, its repository, and the vision, which may stay empty. */
function FromAnIdea() {
  const { state, send, disabled, setNotice } = useStore();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [vision, setVision] = useState("");
  const [focus, setFocus] = useState("");
  // Every project begins in Vision (the vision may stay empty); the factory starts only when you start it.
  const docCount = M.currentVisionDocs(state).length;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!(await confirm(confirmNewProject(name, initProjectConfirm(name, docCount))))) return;
        if (!(await send("initProject", { name, repoPath: repo, vision, focus })).ok) return;
        // Every project begins in Vision: say that it started, and go there.
        setNotice({ kind: "info", message: projectStartedNotice(name) });
        location.hash = "#/vision";
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
  );
}
