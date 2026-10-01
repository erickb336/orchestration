// Files the user attaches to the vision. The state keeps metadata; the service keeps a copy of each
// file by content hash outside any repository. Attaching or removing one creates a user-authored
// vision revision that records the resulting set, so history says which documents applied when. A
// document is never removed from the registry: an old revision may still refer to it.

import { type VisionRevision, type State, type VisionDoc, ControlError } from "../types";
import { currentVision, draft, nextId } from "./core";
import { CONTROL_RE } from "./textSafety";
import { pushVision } from "./vision";

export const MAX_VISION_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_VISION_DOCS = 200;
export const MAX_VISION_DOCS_BYTES = 20 * 1024 * 1024;
const MAX_VISION_DOC_PATH = 512;
const HOSTILE_PATH_RE = /[\u0080-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

/** Bytes as people read them: "1.2 KB", "3.4 MB". */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)} KB`;
  return `${n} B`;
}

/**
 * A safe relative path for a document, or why the given one is refused. Separators are normalized to
 * `/`, `.` segments dropped; `..` segments, absolute paths (POSIX, Windows drive or UNC), empty names,
 * control characters and over-long paths are refused. The result never leaves the documents directory
 * when joined under it, because no segment is `..` and none is absolute.
 */
export function visionDocPath(given: string): { ok: true; path: string } | { ok: false; why: string } {
  // ORC-014 review 9: one spelling per name, so the same name in two encodings replaces rather than duplicates.
  const raw = typeof given === "string" ? given.normalize("NFC") : "";
  if (!raw.trim()) return { ok: false, why: "The file needs a name." };
  if (raw.length > MAX_VISION_DOC_PATH) return { ok: false, why: `The path is over ${MAX_VISION_DOC_PATH} characters.` };
  if (CONTROL_RE.test(raw) || raw.includes("\n") || raw.includes("\t")) return { ok: false, why: "The path contains control characters." };
  // Reviews 3 and 8: a name is the user's, so it is refused rather than altered when it carries characters that
  // reorder or hide text (line and paragraph separators, bidi controls, tag characters, other invisible ones).
  if (HOSTILE_PATH_RE.test(raw)) return { ok: false, why: "The name contains invisible or bidirectional control characters." };
  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return { ok: false, why: "Absolute paths are not allowed; attach the file with a relative path." };
  const segments = unified.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (!segments.length) return { ok: false, why: "The file needs a name." };
  if (segments.some((seg) => seg === ".." || /^\.+$/.test(seg))) return { ok: false, why: 'Paths with ".." are not allowed.' };
  if (segments.some((seg) => seg.trim() !== seg)) return { ok: false, why: "A path segment starts or ends with whitespace." };
  return { ok: true, path: segments.join("/") };
}

/** The documents a revision recorded, in the order they were attached; ids no longer in the registry are skipped (never expected). */
export function visionDocsOf(s: State, rev: VisionRevision): VisionDoc[] {
  if (!rev.docIds?.length) return [];
  const byId = new Map(s.project.visionDocs.map((d) => [d.id, d]));
  return rev.docIds.map((id) => byId.get(id)).filter((d): d is VisionDoc => !!d);
}

/** The current document set: what the lead and designers read. */
export function currentVisionDocs(s: State): VisionDoc[] {
  return visionDocsOf(s, currentVision(s));
}

export const visionDocsBytes = (docs: VisionDoc[]) => docs.reduce((n, d) => n + d.size, 0);

/** Files whose text is not extracted yet, so the interface says so when one is attached. */
export function isOfficeDoc(doc: Pick<VisionDoc, "name">): boolean {
  return /\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf|pages|key|numbers)$/i.test(doc.name);
}

export interface VisionDocInput {
  path: string;
  size: number;
  hash: string;
  text: boolean;
}

/** ORC-014 review 9: a staged record whose batch never committed is dropped after this long. */
export const STAGED_DOC_TTL_MS = 60 * 60 * 1000;

/** Documents uploaded but not yet attached (waiting for their batch). */
export function stagedVisionDocs(s: State): VisionDoc[] {
  return s.project.visionDocs.filter((d) => d.stagedAt);
}

/** Drop staged records older than the TTL, except those named: their batch never committed. */
function pruneStaged(s: State, now: string, keep: Set<string> = new Set()) {
  const cutoff = Date.parse(now) - STAGED_DOC_TTL_MS;
  s.project.visionDocs = s.project.visionDocs.filter((d) => !d.stagedAt || keep.has(d.id) || Date.parse(d.stagedAt) >= cutoff);
}

/** A set with more documents applied in order, each replacing the one at its path. */
function withDocs(set: VisionDoc[], more: VisionDoc[]): VisionDoc[] {
  const out = [...set];
  for (const d of more) {
    const i = out.findIndex((x) => x.path === d.path);
    if (i >= 0) out[i] = d;
    else out.push(d);
  }
  return out;
}

/** Why a document on top of `set` would break the project's caps, or undefined. A replacement at an existing path takes that document's place. */
function capReason(set: VisionDoc[], input: { path: string; size: number }): string | undefined {
  const others = set.filter((d) => d.path !== input.path);
  if (others.length + 1 > MAX_VISION_DOCS) return `The vision already has ${MAX_VISION_DOCS} documents; remove one first.`;
  const total = visionDocsBytes(others) + input.size;
  if (total > MAX_VISION_DOCS_BYTES) return `Attaching ${input.path} (${fmtBytes(input.size)}) would bring the documents to ${fmtBytes(total)}; the limit is ${fmtBytes(MAX_VISION_DOCS_BYTES)} per project.`;
  return undefined;
}

/**
 * Why staging this file would be refused, or undefined when it is admitted: the path, the size, the hash,
 * and the caps against the current set with the documents already staged for the next batch applied.
 * The endpoint asks before anything is written; `stageVisionDoc` asks again inside the transaction, and
 * `attachVisionDocs` decides for the batch as a whole. The same file again (same path and content) is
 * admitted: it is reported as unchanged, never as an error.
 */
export function visionDocAdmission(s: State, input: VisionDocInput): string | undefined {
  const p = visionDocPath(input.path);
  if (!p.ok) return p.why;
  if (!Number.isInteger(input.size) || input.size < 0) return "The size must be a whole number of bytes.";
  if (input.size === 0) return "The file is empty.";
  if (input.size > MAX_VISION_DOC_BYTES) return `The file is ${fmtBytes(input.size)}; the limit is ${fmtBytes(MAX_VISION_DOC_BYTES)} per file.`;
  if (!/^[a-f0-9]{64}$/.test(input.hash)) return "The content hash must be a lowercase SHA-256 hex string.";
  const current = currentVisionDocs(s);
  const same = current.find((d) => d.path === p.path);
  if (same && same.hash === input.hash) return undefined;
  return capReason(withDocs(current, stagedVisionDocs(s)), { path: p.path, size: input.size });
}

interface StagedDoc {
  docId: string;
  /** "unchanged": the same file is attached already (`docId` is that document); nothing to commit. */
  status: "staged" | "unchanged";
  /** The document at the same path this one will replace when its batch commits. */
  replaces?: string;
}

/**
 * ORC-014 review 9: record one uploaded file, without a revision. The endpoint stores the copy once this
 * succeeds; `attachVisionDocs` then attaches the batch as one revision. Staging the same file twice
 * before the commit reuses the record.
 */
export function stageVisionDoc(state: State, input: VisionDocInput, now: string): { state: State; result: StagedDoc } {
  const why = visionDocAdmission(state, input);
  if (why) throw new ControlError(why);
  const path = (visionDocPath(input.path) as { ok: true; path: string }).path;
  const s = draft(state);
  pruneStaged(s, now);
  const current = currentVisionDocs(s);
  const same = current.find((d) => d.path === path);
  if (same && same.hash === input.hash) return { state: s, result: { docId: same.id, status: "unchanged" } };
  const already = stagedVisionDocs(s).find((d) => d.path === path && d.hash === input.hash);
  if (already) return { state: s, result: { docId: already.id, status: "staged", ...(same ? { replaces: same.id } : {}) } };
  const doc: VisionDoc = { id: nextId(s, "doc"), name: path.slice(path.lastIndexOf("/") + 1), path, size: input.size, hash: input.hash, text: input.text, addedAt: now, stagedAt: now };
  s.project.visionDocs.push(doc);
  return { state: s, result: { docId: doc.id, status: "staged", ...(same ? { replaces: same.id } : {}) } };
}

interface AttachedDoc {
  /** The staged document's id as sent. */
  docId: string;
  path: string;
  /** "unchanged": the same file was attached already (see `attachedAs`); "refused": `why` says what cap it broke. */
  status: "added" | "replaced" | "unchanged" | "refused";
  /** For "unchanged": the document already in the set. */
  attachedAs?: string;
  /** For "replaced": the earlier document at the same path, kept by earlier revisions. */
  replaced?: string;
  why?: string;
}

export interface AttachResult {
  /** The revision created, when at least one document was added or replaced. */
  revision?: number;
  docs: AttachedDoc[];
}

/** Up to three names, then "and N more". */
function nameList(paths: string[]): string {
  const shown = paths.slice(0, 3);
  const more = paths.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/**
 * ORC-014 review 9: attach a batch of staged documents as ONE user-authored vision revision ("Attached N
 * documents"). Files are applied in the order given; each is checked against the caps on top of the ones
 * before it, so a batch that overflows attaches what fits and reports the rest by name. A file whose
 * path and content are attached already is reported unchanged. The revision records the whole resulting
 * set (one list per revision: linear in the number of documents, and every revision stays self-contained).
 */
export function attachVisionDocs(state: State, docIds: string[], batchId: string | undefined, now: string): { state: State; result: AttachResult } {
  const ids = [...new Set(docIds)];
  if (!ids.length) throw new ControlError("Nothing to attach: the batch names no documents.");
  for (const id of ids) if (!state.project.visionDocs.some((x) => x.id === id)) throw new ControlError(`Unknown document ${id}.`);
  const s = draft(state);
  const cur = currentVision(s);
  let set = visionDocsOf(s, cur);
  const rows: AttachedDoc[] = [];
  const added: VisionDoc[] = [];
  const removed: string[] = [];
  const drop = new Set<string>();
  const all = ids.map((id) => s.project.visionDocs.find((x) => x.id === id)!);
  const batch = all.filter((d) => d.stagedAt);
  // Two clients uploading the same file share one staged record: the second commit finds it attached
  // already and reports it unchanged; one attached and replaced or removed since must be uploaded again.
  for (const d of all) {
    if (d.stagedAt) continue;
    if (set.some((x) => x.id === d.id)) rows.push({ docId: d.id, path: d.path, status: "unchanged", attachedAs: d.id });
    else rows.push({ docId: d.id, path: d.path, status: "refused", why: "it was attached earlier and has since been replaced or removed; attach it again" });
  }
  for (const d of batch) {
    const later = batch.find((x) => x !== d && x.path === d.path && batch.indexOf(x) > batch.indexOf(d));
    if (later) {
      rows.push({ docId: d.id, path: d.path, status: "refused", why: `a later file in the same batch has the same path (${later.id})` });
      drop.add(d.id);
      continue;
    }
    const same = set.find((x) => x.path === d.path);
    if (same && same.hash === d.hash) {
      rows.push({ docId: d.id, path: d.path, status: "unchanged", attachedAs: same.id });
      drop.add(d.id);
      continue;
    }
    const why = capReason(set, d);
    if (why) {
      rows.push({ docId: d.id, path: d.path, status: "refused", why });
      drop.add(d.id);
      continue;
    }
    delete d.stagedAt;
    d.addedAt = now;
    set = withDocs(set, [d]);
    added.push(d);
    if (same) {
      removed.push(same.id);
      rows.push({ docId: d.id, path: d.path, status: "replaced", replaced: same.id });
    } else rows.push({ docId: d.id, path: d.path, status: "added" });
  }
  s.project.visionDocs = s.project.visionDocs.filter((d) => !drop.has(d.id));
  pruneStaged(s, now, new Set(ids));
  if (!added.length) return { state: s, result: { docs: rows } };
  const docIdsNow = set.map((d) => d.id);
  const n = added.length;
  const unreadable = added.filter((d) => !d.text).length;
  const reason = `Attached ${n} document${n === 1 ? "" : "s"}: ${nameList(added.map((d) => d.path))}${removed.length ? ` (${removed.length} replaced ${removed.length === 1 ? "an earlier copy" : "earlier copies"})` : ""}${unreadable ? ` (${unreadable} not readable as text; the lead sees ${unreadable === 1 ? "its name" : "their names"} only)` : ""}`;
  const rev = pushVision(
    s,
    { author: "user", text: cur.text, focus: cur.focus, reason, source: { docsAdded: added.map((d) => d.id), ...(removed.length ? { docsRemoved: removed } : {}), ...(batchId ? { batchId } : {}) }, docIds: docIdsNow },
    now,
    `Vision r${cur.rev + 1}: attached ${n} document${n === 1 ? "" : "s"} (${docIdsNow.length} in total, ${fmtBytes(visionDocsBytes(set))})`,
  );
  return { state: s, result: { revision: rev.rev, docs: rows } };
}

/**
 * Stage and attach one document in one step (tests and single-file callers). A file at a path already
 * in the set replaces the older one in the current set only; the same file again is refused as
 * already attached.
 */
export function addVisionDoc(state: State, input: VisionDocInput, now: string): { state: State; docId: string; replaced?: string } {
  const staged = stageVisionDoc(state, input, now);
  if (staged.result.status === "unchanged") throw new ControlError(`${(visionDocPath(input.path) as { ok: true; path: string }).path} is already attached (the same content).`);
  const r = attachVisionDocs(staged.state, [staged.result.docId], undefined, now);
  const row = r.result.docs[0];
  if (row.status === "refused") throw new ControlError(row.why ?? "Refused.");
  return { state: r.state, docId: row.docId, ...(row.replaced ? { replaced: row.replaced } : {}) };
}

/** Remove a document from the current set. Its record and stored copy stay: earlier revisions refer to them. */
export function removeVisionDoc(state: State, docId: string, now: string): State {
  const doc = state.project.visionDocs.find((d) => d.id === docId);
  if (!doc) throw new ControlError(`Unknown document ${docId}.`);
  const cur = currentVision(state);
  if (!cur.docIds?.includes(docId)) throw new ControlError(`${doc.path} is not attached to the current vision (r${cur.rev}).`);
  const s = draft(state);
  const docIds = cur.docIds.filter((id) => id !== docId);
  pushVision(s, { author: "user", text: cur.text, focus: cur.focus, reason: `Removed ${doc.path}`, source: { docRemoved: doc.id }, docIds }, now, `Vision r${cur.rev + 1}: removed ${doc.path} (${docIds.length} document${docIds.length === 1 ? "" : "s"} left; earlier revisions keep it)`);
  return s;
}
