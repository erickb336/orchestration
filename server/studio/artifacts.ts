// The studio workspace on disk (ORC-029 pass 3a), and the layout the prototype server (pass 3b) reads. A fixed contract:
//
//   <dataDir>/studio/<projectId>/staging/<runId>/              a studio run's staging folder: the one place it writes
//   <dataDir>/studio/<projectId>/artifacts/<artifactId>/v<n>/  one artifact version, never rewritten once recorded:
//       its files, at the paths the designer gave them, and manifest.json:
//       { artifactId, version, kind, title, devices, variants: [{ id, label, entry, showsError? }], files: [{ path, sha256, bytes }],
//         provenance?: { asIs: true, files: [repository paths] } }
//       and, written by the service after import (media.ts): shots/<variant>-<device>.png for a screen, and
//       recording/<variant>/ for a terminal demo or TUI that VHS recorded. The files are read-only; the folders are
//       not, so those can be added.
//
// A designer run ends by writing studio.json in its staging folder. It is an agent's output, so it is checked here, at
// the boundary, before anything is copied: the kinds, the file types, the sizes, paths that stay inside the folder,
// no links, and every variant's entry among the files. Each file is read once, and what was hashed is what is written.

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { DEVICES, type Device } from "../../src/domain/types";
import type { StudioArtifactKind } from "../../src/domain/studio/types";
import { validateAnsFrame, validateCast, validateTape } from "./terminal";

/** What a designer run hands in, in its staging folder. */
export const STUDIO_MANIFEST = "studio.json";
/** What the service writes in each version folder. */
export const VERSION_MANIFEST = "manifest.json";
/** The file types an artifact may hold, by extension (lowercase). A terminal demo is a VHS .tape, or hand-written .cast (asciicast v3) or .ans frames. */
export const FILE_TYPES: readonly string[] = ["html", "css", "js", "svg", "png", "jpg", "jpeg", "webp", "woff2", "json", "txt", "md", "mmd", "tape", "cast", "ans"];
/**
 * Folders of a version that are the service's, never the designer's: the pin script's path on the prototype server,
 * the screenshots (shots.ts) and the terminal recordings (media.ts), written beside the files after import.
 */
export const RESERVED_FOLDERS: readonly string[] = ["__orchestrator", "shots", "recording"];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACTS = 10;
const MAX_FILES = 100;
const MAX_VARIANTS = 6;

/** The project's studio workspace. The project id is used as it is, so it must be a plain name. */
export function studioRoot(dataDir: string, projectId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(projectId) || projectId === "." || projectId === "..") throw new Error(`"${projectId}" cannot name a studio folder.`);
  return join(dataDir, "studio", projectId);
}

/** An artifact version's folder in the studio workspace. */
export const versionDir = (root: string, artifactId: string, version: number) => join(root, "artifacts", artifactId, `v${version}`);

/** A file handed in: its path in the artifact, its hash and size, and its bytes as they were read. */
export interface StagedFile {
  path: string;
  sha256: string;
  bytes: number;
  data: Buffer;
}

/**
 * A variant as studio.json gives it. `showsError`: a terminal demo or TUI that shows an error on purpose (an error
 * path), so a failure in its recording's transcript is expected rather than reported (media.ts).
 */
export interface StagedVariant {
  id: string;
  label: string;
  entry: string;
  showsError?: true;
}

/** One artifact of a run's studio.json, checked, with its files read. Titles and labels are checked by the domain when recorded. */
export interface StagedArtifact {
  kind: StudioArtifactKind;
  title: string;
  devices: Device[];
  variants: StagedVariant[];
  files: StagedFile[];
  /** An "as is" reproduction of the existing repository: the repository files it came from, as the designer listed them. */
  provenance?: string[];
}

/** studio.json was refused; the message says why, for the run's record. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * A `<script type="module">` in a page. The prototype server allows plain scripts only: the app frames a prototype
 * in an opaque origin, where a module script loads only with a CORS header, and that header would let any website
 * read local prototypes (design 3b as built). Every HTML file is checked, not only the entries, since a page can
 * link to another.
 */
const MODULE_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?\s*module\b/i;
export const NO_MODULES = "plain scripts only (no ES modules): a module needs a CORS header that would let other websites read local prototypes";

/** One name in a path: ASCII letters, digits, ".", "_", "-" and space. */
const SEGMENT = /^[A-Za-z0-9._ -]+$/;
const show = (x: string) => JSON.stringify(x.length > 80 ? `${x.slice(0, 80)}…` : x);
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** A path an artifact may list: relative, inside the folder, of an allowed type, and not the service's own manifest. */
function filePath(p: unknown, where: string): string {
  if (typeof p !== "string") throw new ManifestError(`${where}: a file is not a path.`);
  const outside = !p || p.length > 300 || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p) || p.split("/").some((x) => x === "" || x === "." || x === "..");
  if (outside) throw new ManifestError(`${where}: ${show(p)} is not a relative path inside the run's folder (no absolute paths, no "..").`);
  // Plain ASCII names only (review finding 9): no lookalike letters, and no name that two disks normalize differently.
  if (!p.split("/").every((x) => SEGMENT.test(x))) throw new ManifestError(`${where}: ${show(p)} has a name with a character other than A–Z, a–z, 0–9, ".", "_", "-" or a space.`);
  // Compared without case: the Mac's disk does not tell "Shots/" from "shots/".
  const lower = p.toLowerCase();
  if (lower === VERSION_MANIFEST || lower === STUDIO_MANIFEST) throw new ManifestError(`${where}: ${show(p)} is reserved for the service.`);
  if (p.includes("/") && RESERVED_FOLDERS.includes(lower.split("/")[0])) throw new ManifestError(`${where}: ${show(p)} is in a folder reserved for the service (${RESERVED_FOLDERS.map((f) => `${f}/`).join(", ")}).`);
  const ext = /\.([^./]+)$/.exec(p)?.[1];
  if (!ext || !FILE_TYPES.includes(ext)) throw new ManifestError(`${where}: ${show(p)} is not an allowed file type (${FILE_TYPES.join(", ")}).`);
  return p;
}

/**
 * Read one file of the staging folder: every folder on its path a real folder and the file a regular file with one
 * link, so nothing outside the folder is read through a symbolic or hard link. Opened without following links.
 */
function readInside(staging: string, rel: string, max: number): Buffer {
  const parts = rel.split("/");
  let cur = staging;
  for (const [i, part] of parts.entries()) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw new ManifestError(`${show(rel)} is listed but is not in the run's folder.`);
    }
    if (st.isSymbolicLink()) throw new ManifestError(`${show(rel)}: ${i < parts.length - 1 ? `the folder ${show(parts.slice(0, i + 1).join("/"))} is` : "it is"} a symbolic link; links are not imported.`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new ManifestError(`${show(rel)} is listed but is not in the run's folder.`);
  }
  const fd = openSync(cur, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ManifestError(`${show(rel)} is not a regular file.`);
    if (st.nlink > 1) throw new ManifestError(`${show(rel)} is a hard link; links are not imported.`);
    if (st.size > max) throw new ManifestError(`${show(rel)} is ${mb(st.size)}, over the ${mb(max)} limit.`);
    const data = readFileSync(fd);
    if (data.length > max) throw new ManifestError(`${show(rel)} is over the ${mb(max)} limit.`);
    return data;
  } finally {
    closeSync(fd);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Read and check the studio.json a run left in its staging folder, and read every file it lists. `kinds` are the
 * kinds this run may hand in. Throws a ManifestError naming the first problem; nothing is copied before all pass.
 */
export function readStaged(staging: string, kinds: readonly StudioArtifactKind[]): StagedArtifact[] {
  let text: string;
  try {
    text = readInside(staging, STUDIO_MANIFEST, MAX_MANIFEST_BYTES).toString("utf8");
  } catch (e) {
    throw e instanceof ManifestError && /is listed but is not/.test(e.message) ? new ManifestError(`the run wrote no ${STUDIO_MANIFEST}.`) : e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError(`${STUDIO_MANIFEST} is not valid JSON.`);
  }
  if (!isObj(raw) || !Array.isArray(raw.artifacts)) throw new ManifestError(`${STUDIO_MANIFEST} has no "artifacts" list.`);
  if (!raw.artifacts.length || raw.artifacts.length > MAX_ARTIFACTS) throw new ManifestError(`${STUDIO_MANIFEST} lists between 1 and ${MAX_ARTIFACTS} artifacts.`);
  return raw.artifacts.map((a, i): StagedArtifact => {
    const where = `artifact ${i + 1}`;
    if (!isObj(a)) throw new ManifestError(`${where} is not an object.`);
    if (typeof a.kind !== "string" || !kinds.includes(a.kind as StudioArtifactKind)) throw new ManifestError(`${where}: the kind ${show(String(a.kind))} is not one this run makes (${kinds.join(", ")}).`);
    if (typeof a.title !== "string") throw new ManifestError(`${where} has no title.`);
    const devices = a.devices === undefined ? [] : a.devices;
    if (!Array.isArray(devices) || !devices.every((d) => DEVICES.includes(d as Device))) throw new ManifestError(`${where}: devices are a list of ${DEVICES.join(", ")}.`);
    if (!Array.isArray(a.files) || !a.files.length || a.files.length > MAX_FILES) throw new ManifestError(`${where} lists between 1 and ${MAX_FILES} files.`);
    const paths = a.files.map((p) => filePath(p, where));
    if (new Set(paths.map((p) => p.toLowerCase())).size !== paths.length) throw new ManifestError(`${where} lists a file twice (paths that differ only in case are one file on this disk).`);
    if (!Array.isArray(a.variants) || !a.variants.length || a.variants.length > MAX_VARIANTS) throw new ManifestError(`${where} has between 1 and ${MAX_VARIANTS} variants, each with its entry file.`);
    const variants = a.variants.map((v): StagedVariant => {
      if (!isObj(v) || typeof v.id !== "string" || typeof v.label !== "string" || typeof v.entry !== "string") throw new ManifestError(`${where}: a variant is { "id", "label", "entry" }.`);
      if (!paths.includes(v.entry)) throw new ManifestError(`${where}: the entry ${show(v.entry)} of variant ${show(v.id)} is not one of its files.`);
      if (v.showsError !== undefined && typeof v.showsError !== "boolean") throw new ManifestError(`${where}: "showsError" of variant ${show(v.id)} is true or false.`);
      return { id: v.id, label: v.label, entry: v.entry, ...(v.showsError === true ? { showsError: true as const } : {}) };
    });
    let total = 0;
    const files = paths.map((p): StagedFile => {
      const data = readInside(staging, p, MAX_FILE_BYTES);
      total += data.length;
      if (total > MAX_ARTIFACT_BYTES) throw new ManifestError(`${where} is over the ${mb(MAX_ARTIFACT_BYTES)} limit for an artifact.`);
      if (p.endsWith(".html") && MODULE_SCRIPT.test(data.toString("utf8"))) throw new ManifestError(`${where}: ${show(p)} has a <script type="module">: ${NO_MODULES}.`);
      return { path: p, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, data };
    });
    checkTerminalFiles(where, a.kind as StudioArtifactKind, variants, files);
    const provenance = a.provenance === undefined ? undefined : provenanceOf(a.provenance, where);
    return { kind: a.kind as StudioArtifactKind, title: a.title, devices: devices as Device[], variants, files, ...(provenance ? { provenance } : {}) };
  });
}

const MAX_PROVENANCE = 50;

/**
 * An "as is" artifact's provenance: 1 to 50 paths in the repository, relative to its root, with no "." or ".." name.
 * Whether the repository has each file is checked when the run is imported (runs.ts).
 */
function provenanceOf(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PROVENANCE || !raw.every((p) => typeof p === "string")) throw new ManifestError(`${where}: "provenance" lists 1 to ${MAX_PROVENANCE} repository files, as paths from the repository's root.`);
  for (const p of raw as string[]) {
    const bad = !p || p.length > 300 || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p) || p.split("/").some((x) => x === "" || x === "." || x === "..");
    if (bad) throw new ManifestError(`${where}: the provenance ${show(p)} is not a path from the repository's root (no absolute paths, no "..").`);
  }
  return [...new Set(raw as string[])];
}

const TERMINAL_KINDS: readonly StudioArtifactKind[] = ["terminal-demo", "tui"];
const sameFolder = (a: string, b: string) => posix.dirname(a) === posix.dirname(b);

/** The tape a terminal variant records: its entry when that is a .tape, else the one .tape beside its entry. */
export function variantTape(files: readonly string[], entry: string): string | undefined {
  if (entry.endsWith(".tape")) return entry;
  const beside = files.filter((f) => f.endsWith(".tape") && sameFolder(f, entry));
  return beside.length === 1 ? beside[0] : undefined;
}

/** The hand-written files a terminal variant is shown with when it is not recorded: the .cast and .ans files beside its entry, the entry first. */
export function variantFallback(files: readonly string[], entry: string): string[] {
  const beside = files.filter((f) => /\.(cast|ans)$/.test(f) && sameFolder(f, entry)).sort();
  return beside.includes(entry) ? [entry, ...beside.filter((f) => f !== entry)] : beside;
}

/**
 * 3c's validators, at import: every .cast (asciicast v3) and .ans frame of any artifact, and the tape each variant of
 * a terminal demo or TUI records (its Sources read from the same folder). A tape that would be refused when recorded
 * is refused now, with the reason, while the designer can still fix it.
 */
function checkTerminalFiles(where: string, kind: StudioArtifactKind, variants: { id: string; entry: string }[], files: StagedFile[]) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const text = (f: StagedFile) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(f.data);
    } catch {
      throw new ManifestError(`${where}: ${show(f.path)} is not UTF-8 text.`);
    }
  };
  for (const f of files) {
    const check = f.path.endsWith(".cast") ? validateCast(text(f)) : f.path.endsWith(".ans") ? validateAnsFrame(text(f)) : undefined;
    if (check && !check.ok) throw new ManifestError(`${where}: ${show(f.path)}: ${check.error}.`);
  }
  if (!TERMINAL_KINDS.includes(kind)) return;
  const paths = files.map((f) => f.path);
  for (const tape of new Set(variants.map((v) => variantTape(paths, v.entry)).filter((t): t is string => t !== undefined))) {
    const folder = posix.dirname(tape);
    const readSource = (rel: string) => {
      const f = byPath.get(folder === "." ? rel : `${folder}/${rel}`);
      return f ? text(f) : undefined;
    };
    const check = validateTape(text(byPath.get(tape)!), { name: tape, readSource });
    if (!check.ok) throw new ManifestError(`${where}: ${show(tape)} would not record: ${check.errors.join("; ")}.`);
  }
}

/** The manifest.json of a version folder (the contract with the prototype server). */
export interface VersionManifest {
  artifactId: string;
  version: number;
  kind: StudioArtifactKind;
  title: string;
  devices: Device[];
  variants: StagedVariant[];
  files: { path: string; sha256: string; bytes: number }[];
  /** An "as is" version's provenance, as recorded: the repository files it came from (so the PE reading the folder sees it). */
  provenance?: { asIs: true; files: string[] };
}

/**
 * Write a version folder: the files as they were read, read-only, and its manifest.json, assembled beside it and then
 * renamed into place, so the folder is whole or absent. Called for a version just recorded in the same transaction:
 * no committed record names it, so a folder already at its path was left by an import that did not commit, and is
 * replaced. Returns the folder.
 */
export function writeVersion(root: string, manifest: VersionManifest, files: StagedFile[]): string {
  const final = versionDir(root, manifest.artifactId, manifest.version);
  const tmp = `${final}.partial-${randomUUID()}`;
  mkdirSync(tmp, { recursive: true });
  try {
    for (const f of files) {
      const p = join(tmp, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.data, { mode: 0o444, flag: "wx" });
    }
    writeFileSync(join(tmp, VERSION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: "wx" });
    rmSync(final, { recursive: true, force: true });
    renameSync(tmp, final);
    return final;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
