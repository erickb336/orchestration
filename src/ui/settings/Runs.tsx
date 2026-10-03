// Settings › How your project runs (ORC-030 C3, a-settings-runs; docs/design/project-environment.md): one card for
// the project's environment, where the checks and the evidence run for any language. First where the environment
// comes from (the repository's dev container, once you confirm what it sets, else the image you confirm) and its
// prepare commands; then how the evidence runs in it: the preview command, its port and the CLI entry. The fields edit
// this section's draft; Save sends setEnvironment and setPreview, the owner's commands. The lead may propose an image;
// only Save sets one or confirms a dev container.

import { useEffect, useState } from "react";
import type { EnvironmentFound } from "../../api";
import { REGISTRY_HOSTS, checksPrepareCommands } from "../../domain/environment";
import { Banner, Button, Chip, Disclosure, Field, Input, StatePill, Textarea } from "../kit";
import { useStore } from "../store";
import { sendInOrder, useDraft } from "./draft";
import { ENVIRONMENT_KEYS, addHost, confirmDevcontainer, devcontainerFacts, environmentProblem, environmentSteps, lastPrepareLine, liveEnvironment, shortImage, sourceLine, takeProposal, type EnvironmentDraft } from "./environment";
import { SettingsCard, SettingsSection } from "./parts";
import { PREVIEW_KEYS, evidenceStatus, livePreview, previewProblem, previewSteps, type PreviewDraft } from "./preview";
import type { SectionId } from "./sections";

type RunsDraft = EnvironmentDraft & PreviewDraft;

export function RunsSection({ current, onDirty }: { current: boolean; onDirty: (id: SectionId, dirty: boolean) => void }) {
  const { state, send } = useStore();
  const draft = useDraft<RunsDraft>({ ...liveEnvironment(state), ...livePreview(state) });
  const v = draft.value;
  const changed = draft.changed as ReadonlySet<string>;
  const invalid = (ENVIRONMENT_KEYS.some((k) => changed.has(k)) ? environmentProblem(v) : undefined) ?? (PREVIEW_KEYS.some((k) => changed.has(k)) ? previewProblem(v) : undefined);
  const save = async (begin: () => void) => {
    begin();
    return sendInOrder([...environmentSteps(v, changed, send), ...previewSteps(v, changed, send)]);
  };
  return (
    <SettingsSection
      id="how-it-runs"
      title="How your project runs"
      help="Where the checks and the evidence run: your project's own container, for any language. Changes here wait for Save."
      current={current}
      draft={draft}
      invalid={invalid}
      onSave={save}
      onDirty={onDirty}
    >
      <RunsCard v={v} set={draft.set} />
    </SettingsSection>
  );
}

/** The environment, then the evidence that runs in it. */
export function RunsCard({ v, set }: { v: RunsDraft; set: (p: Partial<RunsDraft>) => void }) {
  const { state, service } = useStore();
  const real = service.runtime === "real";
  const [found, setFound] = useState<EnvironmentFound | null>(null);
  const [host, setHost] = useState("");
  const [hostError, setHostError] = useState<string | undefined>();
  useEffect(() => {
    if (!real) return;
    let live = true;
    fetch("/api/environment/found")
      .then((r) => (r.ok ? (r.json() as Promise<EnvironmentFound>) : { ref: "", reason: "What the repository says could not be read." }))
      .then((f) => live && setFound(f))
      .catch(() => live && setFound({ ref: "", reason: "The service is unreachable." }));
    return () => {
      live = false;
    };
  }, [real, state.project.repoPath]);
  const source = sourceLine(found, state.project.environment);
  // A dev container the form does not confirm yet: what it sets, and "Confirm this dev container", which puts its
  // digest in the form. Save confirms it.
  const dc = found?.devcontainer;
  const confirmable = dc?.sha256 && confirmDevcontainer(dc).envDevcontainer !== v.envDevcontainer ? dc : undefined;
  const proposal = found?.proposal && found.proposal.image !== v.envImage.trim() ? found.proposal : undefined;
  const envProblem = environmentProblem(v);
  const prevProblem = previewProblem(v);
  const last = lastPrepareLine(state);
  const evidence = evidenceStatus(state);
  const add = () => {
    const r = addHost(v, host);
    if ("refused" in r) return setHostError(r.refused);
    set({ envHosts: r.hosts });
    setHost("");
    setHostError(undefined);
  };
  return (
    <SettingsCard
      id="environment"
      title="Environment"
      help="The prepare commands install what your project needs, through a proxy that reaches package registries only. Then the checks and the evidence run in the same container with no network."
    >
      <div className="s-status">
        <StatePill tone={source.tone}>{source.label}</StatePill>
        <span className="muted">{source.text}</span>
      </div>
      {found?.reason && <p className="s-note">{found.reason}</p>}
      {confirmable && (
        <Banner
          tone="you"
          className="s-gap s-confirm"
          title="Confirm the repository's dev container"
          actions={
            <Button size="small" onClick={() => set(confirmDevcontainer(confirmable))}>
              Confirm this dev container
            </Button>
          }
        >
          <p>
            <code>{confirmable.file}</code> at <code>{found!.ref}</code> chooses the container the checks and the evidence run in. It sets:
          </p>
          <dl className="s-facts">
            {devcontainerFacts(confirmable, v, checksPrepareCommands(state.project.checks)).map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.text}</dd>
              </div>
            ))}
          </dl>
          <p>Only its image comes from it: its features and its own commands do not run.</p>
        </Banner>
      )}
      {proposal && (
        <div className="s-inline s-gap">
          <span>
            Proposed from <code>{proposal.because}</code>: the {proposal.label} image <code className="s-mono">{shortImage(proposal.image)}</code>
          </span>
          <Button size="small" onClick={() => set(takeProposal(v, proposal))}>
            Use this image
          </Button>
        </div>
      )}
      <div className="s-fields s-fields--wide s-gap">
        <Field label="Image" hint="Used when the repository has no dev container. Pinned by digest: name:tag@sha256:…">
          <Input type="text" className="s-mono" value={v.envImage} placeholder="python:3.13-slim-trixie@sha256:…" onChange={(e) => set({ envImage: e.target.value })} />
        </Field>
        <Field label="Prepare commands" hint="One per line, run in order with the network to the registries only. Install scripts may run: the container holds them.">
          <Textarea className="s-mono" rows={3} value={v.envPrepare} placeholder="npm ci" onChange={(e) => set({ envPrepare: e.target.value })} />
        </Field>
      </div>
      <Disclosure label={`Allowed registries (${REGISTRY_HOSTS.length + v.envHosts.length})`} className="s-gap">
        <div className="s-commands">
          {REGISTRY_HOSTS.map((r) => (
            <Chip key={r.host} title={r.what}>
              {r.host}
            </Chip>
          ))}
          {v.envHosts.map((h) => (
            <Chip key={h} tone="you" title="Added by you">
              {h}{" "}
              <Button variant="quiet" size="small" aria-label={`Remove ${h}`} onClick={() => set({ envHosts: v.envHosts.filter((x) => x !== h) })}>
                ×
              </Button>
            </Chip>
          ))}
        </div>
        <div className="s-inline s-gap">
          <Field label="Add a host" labelHidden error={hostError}>
            <Input
              type="text"
              className="s-mono"
              value={host}
              placeholder="pkgs.example.com"
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </Field>
          <Button size="small" onClick={add}>
            Add a host
          </Button>
        </div>
        <p className="s-note">HTTPS by host name only, on port 443. An address, this computer and its local network are never allowed.</p>
      </Disclosure>
      {last && <p className="s-note">{last}</p>}
      {envProblem && (
        <Banner tone="fail" className="s-gap">
          {envProblem}
        </Banner>
      )}

      <h4 className="s-sub s-sub--rule">Evidence</h4>
      <p className="s-card-help">The service runs your built product in this environment to show each screen and each CLI demo beside its design.</p>
      <div className="s-status">
        <StatePill tone={evidence.tone}>{evidence.label}</StatePill>
        <span className="muted">{evidence.text}</span>
      </div>
      <div className="s-fields s-fields--wide">
        <Field label="Preview command" hint="What serves the built screens in your project's container. Empty for a product with no screens.">
          <Input type="text" className="s-mono" value={v.previewCommand} placeholder="npm run preview" onChange={(e) => set({ previewCommand: e.target.value })} />
        </Field>
        <Field label="Port" hint="The port the preview serves on, from 1024 to 65535.">
          <Input type="text" inputMode="numeric" className="s-mono" value={v.previewPort} placeholder="4173" onChange={(e) => set({ previewPort: e.target.value })} />
        </Field>
        <Field label="CLI entry" hint="The CLI's entry file in the repository: each demo's tape must type it. Empty for a product with no CLI.">
          <Input type="text" className="s-mono" value={v.previewCli} placeholder="bin/trips.js" onChange={(e) => set({ previewCli: e.target.value })} />
        </Field>
      </div>
      <p className="s-note">Commands are lists of arguments, never a shell line: quote an argument with a space. Empty the preview command, the port and the CLI entry to turn capture off.</p>
      {prevProblem && (
        <Banner tone="fail" className="s-gap">
          {prevProblem}
        </Banner>
      )}
    </SettingsCard>
  );
}
