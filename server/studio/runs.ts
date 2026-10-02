// Studio runs at the service (ORC-029 pass 3a): asking for a designer run, its staging folder and its envelope, and
// importing what it handed in as artifact versions.
//
// The scheduler reads and checks the run's studio.json outside the store's transaction (artifacts.ts), then, inside
// it, records each artifact with the studio's `addArtifact` (the rule behind the addStudioArtifact command) and writes
// its version folder before the transaction commits. A folder whose transaction did not commit names no record and is
// replaced by the next import of that version; a record never names a folder that was not written.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as R from "../../src/domain/studio/runs";
import * as S from "../../src/domain/studio/studio";
import { DESIGNER_KINDS, type StudioRun } from "../../src/domain/studio/types";
import type { ModelSelection, State } from "../../src/domain/types";
import type { Store } from "../store";
import { FILE_TYPES, MAX_ARTIFACT_BYTES, MAX_FILE_BYTES, ManifestError, NO_MODULES, STUDIO_MANIFEST, type StagedArtifact, versionDir, writeVersion } from "./artifacts";

/**
 * Ask for a designer run in a round (the service: from pass 4, the lead's studio loop). Without a brief it gets the
 * labelled placeholder built from the vision and the round's focus. Queued; the scheduler dispatches it in Vision.
 * Returns its id.
 */
export function startDesignerRun(store: Store, input: { round: number; brief?: string; artifactId?: string; selection?: ModelSelection }, now: string, idempotencyKey = `studio-run-${randomUUID()}`): string {
  const brief = input.brief ?? R.placeholderBrief(store.read().state, input.round);
  const args = { kind: "designer", round: input.round, brief, ...(input.artifactId ? { artifactId: input.artifactId } : {}), ...(input.selection ? { selection: input.selection } : {}) };
  return (store.command("startStudioRun", args, idempotencyKey, now).result as { runId: string }).runId;
}

/**
 * A fresh staging folder for a run. A revision's starts with the files of the version it revises, writable, so the
 * designer edits them in place.
 */
export function prepareStaging(state: State, run: StudioRun, root: string): string {
  const staging = join(root, run.workspace);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const prev = run.artifactId === undefined ? undefined : S.getArtifact(state, run.artifactId, run.baseVersion!);
  for (const f of prev?.files ?? []) {
    const to = join(staging, f.path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(join(versionDir(root, prev!.id, prev!.version), f.path)), { mode: 0o644 });
  }
  return staging;
}

const SIZES: Record<string, string> = { desktop: "desktop 1280×800", mobile: "mobile 390×844", terminal: "terminal 80×24, 100×30 or 120×40 (columns × rows)" };

/** What a designer run is given: its brief, where it works, and exactly what to hand in. */
export function designerEnvelope(state: State, run: StudioRun, where: { staging: string; checkout?: string }): string {
  const round = state.studio.rounds.find((r) => r.n === run.round)!;
  const prev = run.artifactId === undefined ? undefined : S.getArtifact(state, run.artifactId, run.baseVersion!);
  const devices = state.project.devices;
  return [
    `# Studio run ${run.id}: the designer, round ${round.n} (${round.focus})`,
    "",
    "You are the designer in Orchestrator's vision studio. The project is in Vision: nothing is built yet. You make prototypes that the owner looks at, marks and comments on; what the owner approves becomes the blueprint the factory builds from.",
    "",
    "## The brief",
    "",
    run.brief,
    "",
    "## Where you work",
    "",
    `- Your working directory (${where.staging}) is the one place you can write. Put every file there.`,
    where.checkout ? `- The product's repository, as committed, is readable at ${where.checkout}. Read it to match an existing app; you cannot write there.` : "- No checkout of the product's repository is available to read.",
    ...(prev ? [`- Your working directory starts with the files of ${S.artifactName(prev)}, the version you revise: ${prev.files.map((f) => f.path).join(", ")}.`] : []),
    "- There is no network, and prototypes are shown offline in a sandbox that blocks every request: no CDN, web font, remote image or script. Everything a prototype needs is in its files.",
    '- Inline styles and scripts are fine (`<style>`, `style="…"`, `<script>`), as are .css and .js files beside the page.',
    `- Use plain scripts, never \`<script type="module">\`: ${NO_MODULES}, so a page with one is refused. A built app must emit classic scripts (for example Vite with \`build.rollupOptions.output.format: "iife"\`).`,
    "",
    `## The project's devices: ${devices.join(", ")}`,
    "",
    `Design for ${devices.map((d) => SIZES[d]).join("; ")}.`,
    "",
    "## What to hand in",
    "",
    `End by writing \`${STUDIO_MANIFEST}\` in your working directory:`,
    "",
    "```json",
    '{ "artifacts": [ { "kind": "screen", "title": "Trip plan", "devices": ["desktop", "mobile"],',
    '    "variants": [ { "id": "a", "label": "A · Map first", "entry": "a/index.html" } ],',
    '    "files": ["a/index.html", "a/style.css"] } ] }',
    "```",
    "",
    `- \`kind\`: one of ${DESIGNER_KINDS.join(", ")}. \`devices\`: those it is designed for, within the project's devices (none for a contract or a flow).`,
    "- `variants`: 1 to 6 options side by side, each with an id (letters, digits, - and _), a short label, and its entry file.",
    "- `files`: every file of the artifact, as paths relative to your working directory, each listed once; every entry is one of them.",
    `- File types: ${FILE_TYPES.join(", ")}. At most ${MAX_FILE_BYTES / 1024 / 1024} MB a file and ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB an artifact. No links. The folders shots/, recording/ and __orchestrator/ are the service's.`,
    "- A terminal demo or TUI variant's entry is a VHS `.tape`, which the service records offline in a sandbox: `Set Columns` and `Set Rows` to 80×24, 100×30 or 120×40, `Set Shell` bash or zsh, `Output` .webm, .gif and .txt inside your folder, no Copy, Paste, Screenshot or Env, and Source only of a .tape in the folder. A CLI that does not exist yet is a `.js` script the tape runs with `node` (files are not kept executable). Hand-written frames beside the entry, an asciicast v3 `.cast` or `.ans` text, are shown when the tape is not recorded; either can also be the entry instead of a tape.",
    ...(prev ? [`- You revise ${prev.title}: hand in exactly one artifact, its new version (kind ${prev.kind}).`] : []),
    "- Only what studio.json lists is kept; anything else in your working directory is discarded.",
    "",
    "Then reply with one or two sentences saying what you made.",
    "",
  ].join("\n");
}

/**
 * Record a designer run's artifacts and write their version folders. A run that revises an artifact hands in exactly
 * one artifact: its new version. Throws a ManifestError (or the domain's ControlError) when something cannot be
 * recorded; then nothing is recorded and no folder is left. Returns the state, a summary for the run's record, and
 * the versions it recorded.
 */
export function importDesignerRun(state: State, runId: string, staged: StagedArtifact[], root: string, now: string): { state: State; summary: string; imported: { artifactId: string; version: number }[] } {
  const run = R.getStudioRun(state, runId);
  if (!run) throw new Error(`Unknown studio run ${runId}.`);
  const revising = run.artifactId === undefined ? undefined : S.latestVersion(state, run.artifactId);
  if (revising && staged.length !== 1) throw new ManifestError(`a revision hands in exactly one artifact, the new version of ${revising.title}; it listed ${staged.length}.`);
  let s = state;
  const written: string[] = [];
  const names: string[] = [];
  const imported: { artifactId: string; version: number }[] = [];
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
      imported.push({ artifactId: rec.id, version: rec.version });
    }
  } catch (e) {
    for (const dir of written) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { state: s, summary: names.join(", "), imported };
}
