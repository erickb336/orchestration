// What the service makes of an artifact version after import (ORC-029 pass 3): screenshots of a screen, and the way
// each variant of a terminal demo or TUI is shown. The scheduler starts this once the import's transaction has
// committed, so the designer's run completes without waiting, and records the outcome on the version when it is done
// (src/domain/studio/studio.ts, recordArtifactMedia).
//
// - A screen designed for desktop or mobile: captureShots (shots.ts) on each of its devices, into shots/. Without
//   Chrome there are none, and the version says why.
// - A terminal demo or TUI, per variant: the tape it records (its entry, or the one .tape beside it) is recorded with
//   recordTape (terminal.ts) in the recorder's Docker container (container.ts), never outside it, into
//   recording/<variant>/ (WebM, GIF and a text transcript, as the tape asks). A recording whose transcript shows a
//   failure is "recorded-with-errors", with its first failing line, unless the variant says it shows an error on
//   purpose (`showsError`). A variant that is not recorded (Docker is not running, the image is missing, the probe
//   failed, the recording failed) is shown with its hand-written .cast or .ans files when it has them, and otherwise
//   says why it has nothing.
//
// Both kinds of file were checked at import (artifacts.ts); a tape is recorded from a copy of the whole version made
// from its files, each checked against its recorded hash, with the shell at the copy's root: paths in a tape's
// commands are relative to the artifact's root, as everywhere else.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { MediaResult } from "../../src/domain/studio/studio";
import type { ArtifactShots, VariantDemo } from "../../src/domain/studio/types";
import { variantFallback, variantTape } from "./artifacts";
import { readManifest, versionDir, type PrototypeManifest } from "./serve";
import { captureShots, type ShotsOutcome } from "./shots";
import { recordTape, type RecordResult } from "./terminal";

/** The tools behind the screenshots and recordings; the service uses systemMedia, tests stand in for it. Neither throws. */
export interface StudioMedia {
  shots(studioDir: string, artifactId: string, version: number): Promise<ShotsOutcome>;
  /** Record `tape` (its path in the artifact, under `artifactDir`) into `outDir`, in the container or not at all. */
  record(artifactDir: string, outDir: string, tape: string): Promise<RecordResult>;
}

/**
 * The service's tools: the system Chrome, and the recorder's container. Recordings stage the folders Docker mounts in
 * the recorder's default root (~/.cache/orchestrator/recorder), which Docker Desktop and Colima both share.
 */
export const systemMedia = (log?: (msg: string) => void): StudioMedia => ({
  shots: (studioDir, artifactId, version) => captureShots({ studioDir, artifactId, version, log }),
  record: (artifactDir, outDir, tape) => recordTape(artifactDir, outDir, { tape, log }),
});

/** The screenshots of a screen version, as the version records them. */
export async function makeShots(media: StudioMedia, studioDir: string, artifactId: string, version: number, now: () => string): Promise<MediaResult> {
  let out: ShotsOutcome;
  try {
    out = await media.shots(studioDir, artifactId, version);
  } catch (e) {
    out = { skipped: `the screenshots failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const skipped = (reason: string): MediaResult => ({ shots: { status: "skipped", at: now(), reason } });
  if ("skipped" in out) return skipped(out.skipped);
  if (!out.shots.length) return skipped(out.failed.length ? `every screenshot failed: ${out.failed[0].error}` : "the version has no variant on a screen device");
  const shots: ArtifactShots = { status: "taken", at: now(), shots: out.shots, failed: out.failed };
  return { shots };
}

/** Why a variant was not recorded, for the owner: the tool's own words, without its advice to the designer. */
export function notRecordedReason(r: RecordResult): string {
  const error = (r.error ?? "").replace(/^Not recorded: /, "").replace(/\.? ?(Nothing runs unsandboxed; )?[Uu]se a hand-written \.cast or \.ans instead\.?$/, "").trim();
  const what: Record<NonNullable<RecordResult["reason"]>, string> = {
    unavailable: "recording is not available here",
    "invalid-tape": "the tape was refused",
    failed: "the recording failed",
    timeout: "the recording took too long",
    "too-large": "the recording was too large",
  };
  const head = r.reason ? what[r.reason] : "the recording made nothing";
  return error ? `${head}: ${error}` : head;
}

/**
 * Copy every file of a version (those its manifest lists, at their paths, each checked against its hash) into a new
 * temporary folder, for VHS to record from: a tape's commands may run any file of the artifact by its path. The
 * service's own folders (shots/, recording/) are not listed, so not copied. Returns it, or why it could not.
 */
function copyVersion(dir: string, manifest: PrototypeManifest): string | { error: string } {
  const tmp = mkdtempSync(join(tmpdir(), "orc-tape-"));
  try {
    for (const f of manifest.files) {
      const from = join(dir, f.path);
      const st = lstatSync(from);
      const data = st.isFile() ? readFileSync(from) : undefined;
      if (!data || createHash("sha256").update(data).digest("hex") !== f.sha256) {
        rmSync(tmp, { recursive: true, force: true });
        return { error: `${f.path} is missing or does not match its recorded hash` };
      }
      const to = join(tmp, f.path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data, { mode: 0o644 });
    }
    return tmp;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * How each variant of a terminal demo or TUI version is shown, as the version records it. Variants are recorded one
 * at a time. `variants` are the version's, from its record: without a readable folder, each says so.
 */
export async function makeDemo(media: StudioMedia, studioDir: string, artifactId: string, version: number, variants: string[], now: () => string): Promise<MediaResult> {
  const manifest = readManifest(studioDir, artifactId, version);
  if (!manifest) return { demo: { status: "done", at: now(), variants: variants.map((id) => ({ variant: id, status: "not-recorded", reason: "the version's folder could not be read" })) } };
  const dir = versionDir(studioDir, artifactId, version);
  const shownVariants: VariantDemo[] = [];
  for (const v of manifest.variants) {
    const files = manifest.files.map((f) => f.path);
    const fallback = variantFallback(files, v.entry);
    const shown = (reason: string): VariantDemo => (fallback.length ? { variant: v.id, status: "hand-written", files: fallback, reason } : { variant: v.id, status: "not-recorded", reason });
    const tape = variantTape(files, v.entry);
    if (!tape) {
      shownVariants.push(fallback.length ? { variant: v.id, status: "hand-written", files: fallback } : { variant: v.id, status: "not-recorded", reason: "its entry is not a .tape, and no single .tape, nor a .cast or .ans, is beside it" });
      continue;
    }
    const copy = copyVersion(dir, manifest);
    if (typeof copy !== "string") {
      shownVariants.push(shown(`its files could not be read: ${copy.error}`));
      continue;
    }
    // A recording left by an earlier attempt (the service stopped meanwhile) is the service's own: it starts over.
    const out = join(dir, "recording", v.id);
    let r: RecordResult;
    try {
      rmSync(out, { recursive: true, force: true });
      r = await media.record(copy, out, tape);
    } catch (e) {
      r = { sandbox: null, reason: "failed", error: e instanceof Error ? e.message : String(e) };
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
    // Relative to the version's folder, and inside its recording/<variant>/ (the domain checks that too).
    const base = realpathSync(dir);
    const rel = (p: string | undefined) => {
      try {
        const r = p ? relative(base, realpathSync(p)).split("\\").join("/") : undefined;
        return r?.startsWith(`recording/${v.id}/`) ? r : undefined;
      } catch {
        return undefined;
      }
    };
    const outputs = { webm: rel(r.webm), gif: rel(r.gif), txt: rel(r.txt) };
    // Recorded means recorded in the container: anything else is not shown as a recording. One that shows a failure
    // says so, unless the designer made it to show one.
    if (!r.error && r.sandbox === "container" && (outputs.webm || outputs.gif || outputs.txt)) {
      const files = { ...(outputs.webm ? { webm: outputs.webm } : {}), ...(outputs.gif ? { gif: outputs.gif } : {}), ...(outputs.txt ? { txt: outputs.txt } : {}) };
      shownVariants.push(r.errorLine && v.showsError !== true ? { variant: v.id, status: "recorded-with-errors", tape, ...files, reason: r.errorLine } : { variant: v.id, status: "recorded", tape, ...files });
    } else {
      rmSync(out, { recursive: true, force: true });
      shownVariants.push(shown(notRecordedReason(r)));
    }
  }
  return { demo: { status: "done", at: now(), variants: shownVariants } };
}
