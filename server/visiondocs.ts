// ORC-014: copies of the user's vision documents. Each upload is checked (path, size, emptiness, the
// project's caps) and, once the `stageVisionDoc` command recorded it, kept by content hash under
// <data dir>/vision-docs/<project>/, never in a repository or worktree. The state records metadata only
// (see M.stageVisionDoc and M.attachVisionDocs); the envelope reads the stored copies when it is built
// and verifies each against its hash. Copies no record refers to are swept (review 6).

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import * as M from "../src/domain/model";
import type { State, VisionDoc } from "../src/domain/types";
import type { VisionDocRead, VisionDocReader } from "./envelope";
import { CommandFailure } from "./store";

/** Formats whose bytes are never text, whatever they decode as (PDF and Office text extraction is out of scope). */
const BINARY_EXT = new Set(
  "pdf doc docx dot dotx xls xlsx xlsm ppt pptx pps odt ods odp rtf pages numbers key png jpg jpeg gif webp bmp ico tif tiff heic psd ai eps zip gz tgz bz2 xz 7z rar tar jar war mp3 mp4 m4a mov avi mkv wav flac ogg woff woff2 ttf otf eot exe dll so dylib bin dat sqlite db class pyc o a wasm".split(" "),
);

/** The largest base64 body that can decode to MAX_VISION_DOC_BYTES (checked before decoding, so an oversized body never allocates). */
const MAX_BASE64 = Math.ceil(M.MAX_VISION_DOC_BYTES / 3) * 4;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const PROJECT_RE = /^[A-Za-z0-9._-]{1,80}$/;
/** Review 6: an orphan copy younger than this is left alone; its batch may still be committing. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const invalid = (why: string) => new CommandFailure("invalid", why);

/** Valid UTF-8 with no NUL byte. */
export function isTextContent(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Text means Markdown, plain text, JSON, YAML, CSV, HTML, source code and the like: by content, with known binary formats ruled out by extension. */
export function isTextDoc(name: string, buf: Buffer): boolean {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (BINARY_EXT.has(ext)) return false;
  return isTextContent(buf);
}

/** The upload body's `content` (base64) as bytes, or why it is refused. */
export function decodeUpload(content: unknown): Buffer {
  if (typeof content !== "string") throw invalid("content must be the file's bytes, base64-encoded.");
  if (content.length > MAX_BASE64 + 4) throw invalid(`The file is over ${M.fmtBytes(M.MAX_VISION_DOC_BYTES)}; the limit is ${M.fmtBytes(M.MAX_VISION_DOC_BYTES)} per file.`);
  if (content.length % 4 !== 0 || !BASE64_RE.test(content)) throw invalid("content is not valid base64.");
  const buf = Buffer.from(content, "base64");
  if (buf.length === 0) throw invalid("The file is empty.");
  if (buf.length > M.MAX_VISION_DOC_BYTES) throw invalid(`The file is ${M.fmtBytes(buf.length)}; the limit is ${M.fmtBytes(M.MAX_VISION_DOC_BYTES)} per file.`);
  return buf;
}

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

export class VisionDocStore {
  /** <data dir>/vision-docs, resolved. Every stored path is checked to lie under it. */
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dir(projectId: string): string {
    if (!PROJECT_RE.test(projectId)) throw new CommandFailure("internal", `Project id ${JSON.stringify(projectId)} cannot name a documents directory.`);
    return this.inside(join(this.root, projectId));
  }

  /** The stored copy's path for a hash. Both parts are validated, and the result must lie inside the root. */
  pathOf(projectId: string, hash: string): string {
    if (!HASH_RE.test(hash)) throw new CommandFailure("internal", "A stored copy is named by its SHA-256 hash only.");
    return this.inside(join(this.dir(projectId), hash));
  }

  private inside(p: string): string {
    const full = resolve(p);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new CommandFailure("internal", "A document path resolved outside the documents directory.");
    return full;
  }

  /**
   * Review 7: the project's directory as the file system resolves it. Nothing is written unless that
   * lies under the resolved root: a link placed in the data directory cannot redirect a copy elsewhere.
   */
  private writableDir(projectId: string): string {
    const dir = this.dir(projectId);
    mkdirSync(dir, { recursive: true });
    const realRoot = realpathSync(this.root);
    const real = realpathSync(dir);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new CommandFailure("internal", `The documents directory for this project resolves outside ${this.root} (a link?); nothing is written.`);
    return real;
  }

  has(projectId: string, hash: string): boolean {
    return existsSync(this.pathOf(projectId, hash));
  }

  /** Decode and describe one upload: the path made safe, the bytes, their hash and whether they are text. Nothing is checked against the project yet. */
  inspect(rawPath: unknown, content: unknown): { input: M.VisionDocInput; buf: Buffer } {
    if (typeof rawPath !== "string") throw invalid("path must be the file's relative path.");
    const p = M.visionDocPath(rawPath);
    if (!p.ok) throw invalid(p.why);
    const buf = decodeUpload(content);
    return { input: { path: p.path, size: buf.length, hash: sha256(buf), text: isTextDoc(p.path, buf) }, buf };
  }

  /**
   * Keep a copy by hash: written once, through a temporary name, so a reader never sees a partial file.
   * Called only after the command that records the document succeeded (review 5). A link where the copy
   * should be is refused, never followed.
   */
  store(projectId: string, hash: string, buf: Buffer) {
    if (!HASH_RE.test(hash)) throw new CommandFailure("internal", "A stored copy is named by its SHA-256 hash only.");
    const dir = this.writableDir(projectId);
    const target = join(dir, hash);
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) throw new CommandFailure("internal", "The stored copy's path is a link; nothing is written.");
      if (st.isFile()) return;
    } catch (e) {
      if (e instanceof CommandFailure) throw e;
      // Not there yet: written below.
    }
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, buf);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** The stored copy's text, verified against the document's hash (review 7): missing or changed copies are reported, never used. */
  read(projectId: string, doc: Pick<VisionDoc, "hash">): VisionDocRead {
    let buf: Buffer;
    try {
      buf = readFileSync(this.pathOf(projectId, doc.hash));
    } catch {
      return { missing: true };
    }
    if (sha256(buf) !== doc.hash) return { changed: true };
    return { text: buf.toString("utf8") };
  }

  /** What the envelope builder uses for one project. */
  reader(projectId: string): VisionDocReader {
    return { read: (doc) => this.read(projectId, doc) };
  }

  /**
   * Review 6: delete copies no document record refers to (failed or refused uploads, batches that never
   * committed) once they are older than the grace period, or at once when named in `immediate`; delete
   * leftover temporary files; and delete the directories of projects other than the current one (a
   * project replaced by `initProject`). Copies any revision refers to are always kept: history stays
   * truthful, so a removed document's copy stays on disk while a revision names it.
   */
  sweep(state: State, opts: { nowMs?: number; immediate?: Iterable<string>; graceMs?: number } = {}): { removed: string[]; removedDirs: string[] } {
    const nowMs = opts.nowMs ?? Date.now();
    const grace = opts.graceMs ?? ORPHAN_GRACE_MS;
    const immediate = new Set(opts.immediate ?? []);
    const referenced = new Set(state.project.visionDocs.map((d) => d.hash));
    const removed: string[] = [];
    const removedDirs: string[] = [];
    if (!existsSync(this.root)) return { removed, removedDirs };
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === state.project.id || !PROJECT_RE.test(entry.name)) continue;
      rmSync(this.inside(join(this.root, entry.name)), { recursive: true, force: true });
      removedDirs.push(entry.name);
    }
    const dir = this.dir(state.project.id);
    if (!existsSync(dir)) return { removed, removedDirs };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const isTmp = entry.name.endsWith(".tmp");
      const isCopy = HASH_RE.test(entry.name);
      if (!isTmp && !isCopy) continue;
      if (isCopy && referenced.has(entry.name)) continue;
      const full = this.inside(join(dir, entry.name));
      let old = false;
      try {
        old = nowMs - lstatSync(full).mtimeMs >= grace;
      } catch {
        continue;
      }
      if (!old && !immediate.has(entry.name)) continue;
      rmSync(full, { force: true });
      removed.push(entry.name);
    }
    return { removed, removedDirs };
  }
}
