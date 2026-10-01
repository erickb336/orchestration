// Settings › Project: the repository, the stage, and how finished work leaves (the delivery mode,
// the remote and base, who merges). Settings wait for Save; Start building and Back to shaping are actions and
// act at once. In real mode, Start a new project is its own form with its own button.

import { useState } from "react";
import * as M from "../../domain/model";
import { Button, Checkbox, Chip, Disclosure, Field, Input, Textarea, useConfirm } from "../kit";
import { DeliveryCard, deliveryErrors, deliverySteps, liveDelivery, type DeliveryDraft } from "../DeliverySettings";
import { StartBuildingButton } from "../Shaping";
import { confirmNewProject } from "../settingsText";
import { initProjectConfirm, newProjectStage } from "../stageChoice";
import { useStore } from "../store";
import { sendInOrder, useDraft } from "./draft";
import { Choice, SettingsCard, SettingsSection } from "./parts";
import type { SectionId } from "./sections";

type ProjectDraft = DeliveryDraft & { repoPath: string; conventions: boolean };

export function ProjectSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, service, send } = useStore();
  const confirm = useConfirm();
  const real = service.runtime === "real";
  const liveDel = liveDelivery(state);
  const live: ProjectDraft = { ...liveDel, repoPath: state.project.repoPath, conventions: state.project.conventions?.include ?? true };
  const draft = useDraft(live);
  const v = draft.value;
  const errors = { repoPath: v.repoPath.trim() ? undefined : "Give the repository's path.", ...deliveryErrors(v) };
  const invalid = Object.values(errors).find(Boolean);

  const save = async (begin: () => void) => {
    const delivery = await deliverySteps(state, real, liveDel, v, draft.changed, send, confirm);
    if (!delivery) return false;
    begin();
    return sendInOrder([
      () => (draft.changed.has("repoPath") ? send("setRepoPath", { repoPath: v.repoPath.trim() }) : null),
      () => (draft.changed.has("conventions") ? send("setConventions", { include: v.conventions }) : null),
      ...delivery,
    ]);
  };

  const repo = service.repo;
  return (
    <SettingsSection
      id="project"
      title="Project"
      help="Your repository, the stage, and how finished work leaves Orchestrator. Changes here wait for Save; Start building and Back to shaping act at once."
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

      <StageCard />

      <DeliveryCard v={v} set={draft.set} confirm={confirm} />

      {real && <NewProjectCard openByDefault={!repo?.ok} />}
    </SettingsSection>
  );
}

/** The stage: shaping (the lead drafts the vision, nothing runs) or building. Both buttons act at once. */
function StageCard() {
  const { state, send, disabled } = useStore();
  const [busy, setBusy] = useState(false);
  const shaping = state.project.stage === "shaping";
  const running = M.activeAttempts(state).length;
  return (
    <SettingsCard
      id="stage"
      title={
        <>
          Stage <Chip strong>{shaping ? "Shaping" : "Building"}</Chip>
        </>
      }
      help={shaping ? `${M.SHAPING_LABEL}; the lead answers your messages and drafts the vision.` : "Work runs as usual. Back to shaping stops nothing that is running; nothing new starts."}
    >
      {shaping ? (
        <StartBuildingButton variant="secondary" />
      ) : (
        <div className="s-inline">
          <Button
            disabled={disabled || busy}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await send("startShaping");
              setBusy(false);
            }}
          >
            Back to shaping
          </Button>
          {running > 0 && (
            <span className="muted small">
              {running} running step{running === 1 ? "" : "s"} would finish normally.
            </span>
          )}
        </div>
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
  // Shape the vision with the lead first (the vision may stay empty), or start building now. Until you choose, the
  // stage follows the vision: shaping while it is empty (building needs a vision), building once written.
  const [stageChoice, setStageChoice] = useState<"shaping" | "building" | null>(null);
  const stage = newProjectStage(stageChoice, vision);
  const docCount = M.currentVisionDocs(state).length;
  return (
    <SettingsCard id="new-project" title="Start a new project" help="Replaces this board and its history with an empty project; refused while any run is active.">
      <Disclosure label="New project form" defaultOpen={openByDefault}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!(await confirm(confirmNewProject(name, initProjectConfirm(name, docCount))))) return;
            await send("initProject", { name, repoPath: repo, vision, focus, stage });
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
          <fieldset className="s-choices">
            <legend className="k-field__label">How to begin</legend>
            <Choice name="new-stage" checked={stage === "shaping"} onChange={() => setStageChoice("shaping")} label="Shape the vision with the lead first" description="The lead drafts the vision and a first roadmap with you; nothing runs until you start building." />
            <Choice name="new-stage" checked={stage === "building"} onChange={() => setStageChoice("building")} label="Start building now" description="Work runs as soon as there is a task. The vision is required." />
          </fieldset>
          <Field label={`Vision${stage === "shaping" ? " (optional while shaping)" : ""}`} className="s-gap">
            <Textarea value={vision} onChange={(e) => setVision(e.target.value)} required={stage === "building"} />
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
