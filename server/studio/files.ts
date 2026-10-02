// What the app's own origin serves of a studio artifact version (ORC-029 pass 3): GET /api/studio/file. The studio
// reads a terminal demo's text (a hand-written .cast or .ans, a recording's transcript), a screenshot and a
// recording through it, so they show even while the prototype server is down; the prototype origin cannot be read
// from the app.
//
// The app's origin is where the owner's state and commands live, so it serves far less than the prototype server:
// never HTML, script or SVG, nothing a browser could run there. Only plain text (.txt, .ans, .cast, and a document's
// Markdown and Mermaid, .md and .mmd, all served as text/plain in UTF-8) and PNG, GIF
// and WebM (each checked by its first bytes), and only files the prototype server would serve (serve.ts,
// readServedFile): those the version's manifest lists, its screenshots and its recordings. Every answer carries
// nosniff, no-store and a policy that runs nothing.

import { MAGIC, readServedFile } from "./serve";

/** What the app serves, by extension: text as plain text, images and video by their first bytes. */
const APP_TYPES: Record<string, { type: string; magic?: Buffer }> = {
  ".txt": { type: "text/plain; charset=utf-8" },
  ".ans": { type: "text/plain; charset=utf-8" },
  ".cast": { type: "text/plain; charset=utf-8" },
  // A document artifact's Markdown and Mermaid (interface, algorithm, topology, contract, flow): the app renders them itself.
  ".md": { type: "text/plain; charset=utf-8" },
  ".mmd": { type: "text/plain; charset=utf-8" },
  ".png": { type: "image/png", magic: MAGIC[".png"] },
  ".gif": { type: "image/gif", magic: MAGIC[".gif"] },
  ".webm": { type: "video/webm", magic: MAGIC[".webm"] },
};
/** Never from the app's origin, whatever the version holds: a page, a script or an SVG could run there. */
const NEVER = new Set([".html", ".htm", ".js", ".mjs", ".svg", ".xhtml", ".xml"]);

/** The headers of every answer of the route, errors included. */
export const APP_FILE_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

export type AppFile = { ok: true; type: string; body: Buffer } | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * One file of a version of the current project, for the app: `query` is the route's search parameters (artifact,
 * version, path). `known` says whether the project records that version (a folder whose import did not commit is
 * not served).
 */
export function appStudioFile(studioDir: string | undefined, query: URLSearchParams, known: (artifactId: string, version: number) => boolean): AppFile {
  const artifactId = query.get("artifact") ?? "";
  const versionText = query.get("version") ?? "";
  const path = query.get("path") ?? "";
  if (!/^[1-9][0-9]{0,5}$/.test(versionText) || !artifactId || !path) return { ok: false, status: 400, error: "artifact, version and path are required." };
  const ext = /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? "";
  if (NEVER.has(ext)) return { ok: false, status: 403, error: "Pages, scripts and SVG are never served from the app's origin; the prototype server shows them, sandboxed." };
  const kind = APP_TYPES[ext];
  if (!kind) return { ok: false, status: 404, error: "Not found." };
  const version = Number(versionText);
  if (!studioDir || !known(artifactId, version)) return { ok: false, status: 404, error: "Not found." };
  const file = readServedFile(studioDir, artifactId, version, path);
  if (!file || file.ext !== ext || (kind.magic && !file.body.subarray(0, kind.magic.length).equals(kind.magic))) return { ok: false, status: 404, error: "Not found." };
  return { ok: true, type: kind.type, body: file.body };
}
