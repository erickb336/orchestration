// ORC-014: copies of the user's vision documents. Each upload is checked (path, size, emptiness, the
// project's caps, duplicates) and then kept by content hash under <data dir>/vision-docs/<project>/,
// never in a repository or worktree. The state records metadata only (see M.addVisionDoc); the
// envelope reads the stored copies when it is built.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import * as M from "../src/domain/model";
import type { State, VisionDoc } from "../src/domain/types";
import type { VisionDocReader } from "./envelope";
import { CommandFailure } from "./store";

/** Formats whose bytes are never text, whatever they decode as (PDF and Office text extraction is out of scope). */
const BINARY_EXT = new Set(
  "pdf doc docx dot dotx xls xlsx xlsm ppt pptx pps odt ods odp rtf pages numbers key png jpg jpeg gif webp bmp ico tif tiff heic psd ai eps zip gz tgz bz2 xz 7z rar tar jar war mp3 mp4 m4a mov avi mkv wav flac ogg woff woff2 ttf otf eot exe dll so dylib bin dat sqlite db class pyc o a wasm".split(" "),
);

/** The largest base64 body that can decode to MAX_VISION_DOC_BYTES (checked before decoding, so an oversized body never allocates). */
const MAX_BASE64 = Math.ceil(M.MAX_VISION_DOC_BYTES / 3) * 4;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

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
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(projectId)) throw new CommandFailure("internal", `Project id ${JSON.stringify(projectId)} cannot name a documents directory.`);
    return this.inside(join(this.root, projectId));
  }

  /** The stored copy's path for a hash. Both parts are validated, and the result must lie inside the root. */
  pathOf(projectId: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new CommandFailure("internal", "A stored copy is named by its SHA-256 hash only.");
    return this.inside(join(this.dir(projectId), hash));
  }

  private inside(p: string): string {
    const full = resolve(p);
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new CommandFailure("internal", "A document path resolved outside the documents directory.");
    return full;
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
   * Check an inspected upload against the project's current documents and keep a copy. Returns what
   * `addVisionDoc` records. Nothing is written when the upload is refused.
   */
  admit(state: State, upload: { input: M.VisionDocInput; buf: Buffer }): M.VisionDocInput {
    const why = M.visionDocAdmission(state, upload.input);
    if (why) throw invalid(why);
    this.store(state.project.id, upload.input.hash, upload.buf);
    return upload.input;
  }

  /** Keep a copy by hash: written once, through a temporary name, so a reader never sees a partial file. */
  store(projectId: string, hash: string, buf: Buffer) {
    const target = this.pathOf(projectId, hash);
    if (existsSync(target)) return;
    mkdirSync(this.dir(projectId), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, buf);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** The stored copy's text, or undefined when it is missing on disk. */
  read(projectId: string, doc: Pick<VisionDoc, "hash">): string | undefined {
    try {
      return readFileSync(this.pathOf(projectId, doc.hash), "utf8");
    } catch {
      return undefined;
    }
  }

  /** What the envelope builder uses for one project. */
  reader(projectId: string): VisionDocReader {
    return { read: (doc) => this.read(projectId, doc) };
  }
}
