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
import { domainLines } from "../../src/domain/studio/domains";
import { DESIGNER_KINDS, DOCUMENT_KINDS, type StudioRun } from "../../src/domain/studio/types";
import type { ModelSelection, State } from "../../src/domain/types";
import type { Store } from "../store";
import { FILE_TYPES, MAX_ARTIFACT_BYTES, MAX_FILE_BYTES, ManifestError, NO_MODULES, STUDIO_MANIFEST, type StagedArtifact, versionDir, writeVersion } from "./artifacts";
import { repoGlance, trackedAmong } from "./existing";

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

/**
 * Round 0 of an existing repository, "as it is today" (pass 4): the designer reproduces what the code does now, read
 * only, and names the repository files each artifact came from. Reads are confined for a Claude designer, whose
 * workspace guard lets it read only the read-only checkout and its staging folder (pass 3). A Codex designer's reads
 * are not confined, as for every Codex run (Codex has no readable-roots setting), so its brief says to read only the
 * checkout; that is an instruction, not a guard.
 */
function asIsSection(state: State, run: StudioRun, checkout: string | undefined): string[] {
  const glance = repoGlance(state.project.repoPath);
  const confined =
    run.provider === "claude"
      ? "The service lets you read only that checkout and your working directory."
      : "On Codex the service cannot confine what you read (as for every Codex run), so read only that checkout.";
  return [
    "## As it is today",
    "",
    "This round reproduces what the product's repository already does, before anything changes, so the owner can check that the studio understood it; later rounds revise it.",
    checkout ? `- Read the code, read-only, in the checkout at ${checkout}. ${confined}` : "- No checkout is available to read: reproduce only what the file list below and the brief show, and say so in each artifact.",
    "- Reproduce what the code does now, not what it could become: the key screens, or the interface and core algorithms, or the topology, following the product's domains. Do not improve or redesign it here.",
    '- In studio.json, give every artifact `"provenance"`: the repository files it came from, as paths from the repository\'s root, for example `"provenance": ["src/TripList.tsx", "src/trips.css"]`. The studio labels it "as is"; the service checks that the repository has each file, and refuses an artifact without provenance in this round.',
    glance ? `- Code in the repository (${glance.codeFiles} of ${glance.files} tracked files${glance.codeFiles > glance.code.length ? `; the first ${glance.code.length}` : ""}): ${glance.code.join(", ") || "none"}.` : "- The repository's file list could not be read.",
    "",
  ];
}

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
    "## The product's domains",
    "",
    // Designer briefs follow the domain (r9): what the studio shows for a screen product, a code product, an infrastructure system.
    ...domainLines(state.project.domains).map((l) => `- ${l}`),
    "- Make the kinds the brief asks for; when it names none, the kinds of the product's domains.",
    "",
    ...(round.n === 0 ? asIsSection(state, run, where.checkout) : []),
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
    `- File types: ${FILE_TYPES.join(", ")}. At most ${MAX_FILE_BYTES / 1024 / 1024} MB a file and ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB an artifact. Names use only letters, digits, ".", "_", "-" and spaces. No links. The folders shots/, recording/ and __orchestrator/ are the service's.`,
    `- A document (${DOCUMENT_KINDS.join(", ")}) is plain files: Markdown (.md) with code blocks and tables, and Mermaid (.mmd) for diagrams, which the app renders. Its variant's entry is its main .md file; it has no devices. Write rules and edge cases as tables of cases and outcomes.`,
    "- A terminal demo or TUI variant's entry is a VHS `.tape`, which the service records in a container: `Set Columns` and `Set Rows` to 80×24, 100×30 or 120×40, `Set Shell bash`, `Output` .webm, .gif and .txt (one each), no Copy, Paste, Screenshot or Env.",
    "  - Use bash: the recorder has no zsh. A tape that sets zsh is not recorded; the variant then shows its hand-written frames, with the reason.",
    "  - The tape's shell starts at the artifact's root, with a copy of every file the artifact lists, so paths in the tape's commands are relative to the artifact's root, as in studio.json: a tape at `demo/demo.tape` runs `node demo/trips.js`, not `node trips.js`.",
    "  - VHS's own `Output` and `Source` paths are relative to the tape's folder: `Output demo.gif` (the service writes it into recording/<variant>/), and Source only of a .tape in that folder.",
    "  - The demo runs with no network (not even localhost) and no access to the home folder (`~`); it can write only inside the artifact's copy.",
    "  - A CLI that does not exist yet is a `.js` script the tape runs with `node` (no .sh files, and files are not kept executable, so never `./trips.js`).",
    '  - It must run cleanly in the container, from the artifact\'s root. The service scans each recording\'s transcript: a failure on screen (such as "Cannot find module", "command not found", "No such file or directory", "Permission denied", a line starting "Error:", or a traceback) marks it "recorded with errors" for the PE and the owner. A demo meant to show an error path sets `"showsError": true` on its variant.',
    "  - Hand-written frames beside the entry, an asciicast v3 `.cast` or `.ans` text, are shown when the tape is not recorded; either can also be the entry instead of a tape.",
    ...(prev ? [`- You revise ${prev.title}: hand in exactly one artifact, its new version (kind ${prev.kind}).`] : []),
    "- Only what studio.json lists is kept; anything else in your working directory is discarded.",
    "",
    "Then reply with one or two sentences saying what you made.",
    "",
  ].join("\n");
}

/**
 * What a designer run handed in, read outside the store's transaction (review finding 11): its artifacts, and which of
 * the repository files their provenance names the repository tracks at HEAD (round 0 only; undefined when the
 * repository cannot be read).
 */
export interface HandedIn {
  artifacts: StagedArtifact[];
  tracked: ReadonlySet<string> | undefined;
}

/** Read what a run handed in, with its provenance looked up in git: in the scheduler, before the transaction that imports it. */
export function handedIn(state: State, runId: string, artifacts: StagedArtifact[]): HandedIn {
  const named = R.getStudioRun(state, runId)?.round === 0 ? [...new Set(artifacts.flatMap((a) => a.provenance ?? []))] : [];
  return { artifacts, tracked: named.length ? trackedAmong(state.project.repoPath, named) : new Set() };
}

/**
 * Record a designer run's artifacts and write their version folders. A run that revises an artifact hands in exactly
 * one artifact: its new version. Throws a ManifestError (or the domain's ControlError) when something cannot be
 * recorded; then nothing is recorded and no folder is left. Returns the state, a summary for the run's record, and
 * the versions it recorded. It reads no repository: `handedIn` did.
 */
export function importDesignerRun(state: State, runId: string, given: HandedIn, root: string, now: string): { state: State; summary: string; imported: { artifactId: string; version: number }[] } {
  const run = R.getStudioRun(state, runId);
  if (!run) throw new Error(`Unknown studio run ${runId}.`);
  const staged = given.artifacts;
  const revising = run.artifactId === undefined ? undefined : S.latestVersion(state, run.artifactId);
  if (revising && staged.length !== 1) throw new ManifestError(`a revision hands in exactly one artifact, the new version of ${revising.title}; it listed ${staged.length}.`);
  // Provenance is kept only in round 0, where the designer reproduces the existing code "as is"; a later round's
  // artifacts are proposals, so a provenance listed there is not recorded. Each file named must be one the repository
  // tracks, so the owner is never shown a source the code does not have.
  const provenanceOf = (a: StagedArtifact): { files: string[] } | undefined => {
    if (!a.provenance || run.round !== 0) return undefined;
    if (!given.tracked) throw new ManifestError(`the provenance of "${a.title}" cannot be checked: the repository cannot be read.`);
    const missing = a.provenance.filter((p) => !given.tracked!.has(p));
    if (missing.length) throw new ManifestError(`the provenance of "${a.title}" names ${missing.slice(0, 3).map((p) => JSON.stringify(p)).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}, which the repository does not have.`);
    return { files: a.provenance };
  };
  let s = state;
  const written: string[] = [];
  const names: string[] = [];
  const imported: { artifactId: string; version: number }[] = [];
  try {
    for (const a of staged) {
      const provenance = provenanceOf(a);
      const r = S.addArtifact(
        s,
        {
          ...(run.artifactId !== undefined ? { artifactId: run.artifactId } : {}),
          round: run.round,
          kind: a.kind,
          title: a.title,
          variants: a.variants.map((v) => ({ id: v.id, label: v.label, entry: v.entry })),
          files: a.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
          devices: a.devices,
          madeBy: { role: run.kind, provider: run.provider, model: run.actualModel ?? run.model, attemptId: run.id },
          ...(provenance ? { provenance } : {}),
        },
        now,
      );
      s = r.state;
      const rec = S.getArtifact(s, r.artifactId, r.version);
      written.push(
        writeVersion(
          root,
          {
            artifactId: rec.id,
            version: rec.version,
            kind: rec.kind,
            title: rec.title,
            devices: rec.devices,
            variants: rec.variants.map((v) => ({ id: v.id, label: v.label, entry: v.entry!, ...(a.variants.find((x) => x.id === v.id)?.showsError ? { showsError: true as const } : {}) })),
            files: a.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
            ...(rec.provenance ? { provenance: rec.provenance } : {}),
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
