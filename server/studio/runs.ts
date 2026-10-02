// Studio runs at the service (ORC-029 pass 3a): importing what a designer run handed in as artifact versions.
//
// The scheduler reads and checks the run's studio.json outside the store's transaction (artifacts.ts), then, inside
// it, records each artifact with the studio's `addArtifact` (the rule behind the addStudioArtifact command) and writes
// its version folder before the transaction commits. A folder whose transaction did not commit names no record and is
// replaced by the next import of that version; a record never names a folder that was not written.

import { rmSync } from "node:fs";
import * as R from "../../src/domain/studio/runs";
import * as S from "../../src/domain/studio/studio";
import type { State } from "../../src/domain/types";
import { ManifestError, type StagedArtifact, writeVersion } from "./artifacts";

/**
 * Record a designer run's artifacts and write their version folders. A run that revises an artifact hands in exactly
 * one artifact: its new version. Throws a ManifestError (or the domain's ControlError) when something cannot be
 * recorded; then nothing is recorded and no folder is left. Returns the state and a summary for the run's record.
 */
export function importDesignerRun(state: State, runId: string, staged: StagedArtifact[], root: string, now: string): { state: State; summary: string } {
  const run = R.getStudioRun(state, runId);
  if (!run) throw new Error(`Unknown studio run ${runId}.`);
  const revising = run.artifactId === undefined ? undefined : S.latestVersion(state, run.artifactId);
  if (revising && staged.length !== 1) throw new ManifestError(`a revision hands in exactly one artifact, the new version of ${revising.title}; it listed ${staged.length}.`);
  let s = state;
  const written: string[] = [];
  const names: string[] = [];
  try {
    for (const a of staged) {
      const r = S.addArtifact(
        s,
        {
          ...(run.artifactId !== undefined ? { artifactId: run.artifactId } : {}),
          round: run.round,
          kind: a.kind,
          title: a.title,
          variants: a.variants.map((v) => ({ id: v.id, label: v.label })),
          files: a.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
          devices: a.devices,
          madeBy: { role: run.kind, provider: run.provider, model: run.actualModel ?? run.model, attemptId: run.id },
        },
        now,
      );
      s = r.state;
      const rec = S.getArtifact(s, r.artifactId, r.version);
      const entry = new Map(a.variants.map((v) => [v.id, v.entry]));
      written.push(
        writeVersion(
          root,
          {
            artifactId: rec.id,
            version: rec.version,
            kind: rec.kind,
            title: rec.title,
            devices: rec.devices,
            variants: rec.variants.map((v) => ({ id: v.id, label: v.label, entry: entry.get(v.id)! })),
            files: a.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
          },
          a.files,
        ),
      );
      names.push(`${S.artifactName(rec)}${rec.variants.length > 1 ? ` (${rec.variants.length} variants)` : ""}`);
    }
  } catch (e) {
    for (const dir of written) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { state: s, summary: names.join(", ") };
}
