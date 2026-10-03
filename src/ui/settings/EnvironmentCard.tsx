// Settings › Project › Environment (docs/design/project-environment.md): where the checks run when Docker is present,
// for any language. The status line says where the environment comes from (the repository's dev container first, else
// the image you confirm); the fields edit the Project section's draft, and Save sends setEnvironment, the owner's
// command. The lead may propose an image; only Save sets one.

import { useEffect, useState } from "react";
import type { EnvironmentFound } from "../../api";
import { REGISTRY_HOSTS } from "../../domain/environment";
import { Banner, Button, Chip, Disclosure, Field, Input, StatePill, Textarea } from "../kit";
import { useStore } from "../store";
import { SettingsCard } from "./parts";
import { addHost, environmentProblem, lastPrepareLine, shortImage, sourceLine, takeProposal, type EnvironmentDraft } from "./environment";

export function EnvironmentCard({ v, set }: { v: EnvironmentDraft; set: (p: Partial<EnvironmentDraft>) => void }) {
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
  const source = sourceLine(found, v);
  const proposal = found?.proposal && found.proposal.image !== v.envImage.trim() ? found.proposal : undefined;
  const problem = environmentProblem(v);
  const last = lastPrepareLine(state);
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
      help="With Docker, the checks run in your project's own container, for any language: first the prepare commands, whose only way out is a proxy to package registries, then the checks with no network."
    >
      <div className="s-status">
        <StatePill tone={source.tone}>{source.label}</StatePill>
        <span className="muted">{source.text}</span>
      </div>
      {found?.reason && <p className="s-note">{found.reason}</p>}
      {proposal && (
        <div className="s-inline">
          <span>
            Proposed from <code>{proposal.because}</code>: the {proposal.label} image <code className="s-mono">{shortImage(proposal.image)}</code>
          </span>
          <Button size="small" onClick={() => set(takeProposal(v, proposal))}>
            Use this image
          </Button>
        </div>
      )}
      <div className="s-fields s-fields--wide">
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
      {problem && (
        <Banner tone="fail" className="s-gap">
          {problem}
        </Banner>
      )}
    </SettingsCard>
  );
}
