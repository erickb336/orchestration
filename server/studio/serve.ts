// The prototype server (ORC-029 pass 3, docs/design/ORC-029-pass3-design.md, 3b). Prototypes are code an agent
// wrote, so they are served on a second listener, on 127.0.0.1 and its own port, each artifact version on its own
// hostname (p-<artifactId>-v<n>.localhost:<port>, see prototypeOrigin). The app frames them with
// sandbox="allow-scripts" and never allow-same-origin; this server adds the rest of the guard:
//
// - any other Host is refused;
// - only files the version's manifest.json lists are served, and only while their bytes match its sha256: no
//   directory listing, no path the manifest does not name, no symlink, no type outside the allowlist;
// - every response carries a policy that allows no network (connect-src and form-action 'none', every other load
//   from the version's own origin only), may be framed by the app only, and is never cached or given cookies.
//   Inline styles and scripts are allowed (the lead's decision, design 3b as built): agents write them by default,
//   and they give a prototype nothing a script file from its own origin could not. ES modules are not supported:
//   in the frame's opaque origin a module needs a CORS header, which would let any website read local prototypes,
//   so the studio's import refuses `<script type="module">` (artifacts.ts).
//
// The version folders are written by the studio service (3a): <studioDir>/artifacts/<artifactId>/v<n>/ with the
// files and a manifest.json. Screenshots the service takes (shots.ts) sit beside them in shots/, outside the
// manifest, and are served as PNGs only. A terminal demo VHS recorded (terminal.ts, media.ts) sits in
// recording/<variant>/, and is served as GIF, WebM or text only, each checked for its kind.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join } from "node:path";
import { MAX_PIN_SELECTOR } from "../../src/runtime/prototype";

/** The device sizes the studio designs for, and their screenshots. A terminal artifact has no screenshot. */
export const SHOT_DEVICES = ["desktop", "mobile"] as const;
export type ShotDevice = (typeof SHOT_DEVICES)[number];

/** What the studio service writes beside each artifact version's files (the contract with 3a). */
export interface PrototypeManifest {
  artifactId: string;
  version: number;
  kind: string;
  title: string;
  devices: string[];
  variants: { id: string; label: string; entry: string }[];
  files: { path: string; sha256: string; bytes: number }[];
}

/**
 * Served types, by extension: the studio's file allowlist, plus the GIF and WebM of a terminal recording. Anything
 * else is refused. Text the designer wrote (a transcript, a hand-written asciicast, .ans frames) is plain text, so
 * with nosniff a browser shows it and never runs or renders it.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".mmd": "text/plain; charset=utf-8",
  ".tape": "text/plain; charset=utf-8",
  ".cast": "text/plain; charset=utf-8",
  ".ans": "text/plain; charset=utf-8",
  ".gif": "image/gif",
  ".webm": "video/webm",
};

/** What a recording may be, by extension, and how its first bytes must start (a transcript: any text). */
const RECORDING_SIGNATURES: Record<string, Buffer | null> = {
  ".gif": Buffer.from("GIF8", "latin1"),
  ".webm": Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  ".txt": null,
};

/** The largest file served; the studio's own caps are lower. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ARTIFACT_ID = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const PROJECT_ID = /^[A-Za-z0-9._-]{1,80}$/;
const VARIANT_ID = /^[A-Za-z0-9_-]{1,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The pin script, served at PIN_PATH and added to every HTML page. On a click it posts the position (fractions of
 * the document) and a short selector of the clicked element to the frame's parent, and nothing else; it reads
 * nothing but the click and the element's place in the page. The app takes it through acceptPinMessage.
 * It is served as a file from the service's own path, so every page gets the same script and no page can stand in for it.
 */
const PIN_PATH = "/__orchestrator/pin.js";
const PIN_SCRIPT = `(function () {
  if (window.parent === window) return;
  function selector(el) {
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      var part = el.localName;
      if (el.id) { parts.unshift(part + "#" + CSS.escape(el.id)); break; }
      var up = el.parentElement;
      if (up) {
        var same = Array.prototype.filter.call(up.children, function (c) { return c.localName === el.localName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
      }
      parts.unshift(part);
      el = up;
    }
    return parts.join(" > ").slice(0, ${MAX_PIN_SELECTOR});
  }
  function fraction(n, of) { return Math.round(Math.min(1, Math.max(0, n / Math.max(of, 1))) * 10000) / 10000; }
  document.addEventListener("click", function (e) {
    var d = document.documentElement;
    window.parent.postMessage({ type: "orchestrator-pin", x: fraction(e.pageX, d.scrollWidth), y: fraction(e.pageY, d.scrollHeight), selector: selector(e.target) }, "*");
  }, true);
})();
`;
const PIN_TAG = Buffer.from(`<script src="${PIN_PATH}"></script>`);

/** The headers every response carries, errors included. */
function prototypeHeaders(appOrigins: string[]): Record<string, string> {
  return {
    "Content-Security-Policy": `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors ${appOrigins.join(" ")}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

/** A project's studio workspace, <dataDir>/studio/<projectId>. */
export function projectStudioDir(dataDir: string, projectId: string): string | undefined {
  return PROJECT_ID.test(projectId) ? join(dataDir, "studio", projectId) : undefined;
}

/** The immutable folder of one artifact version. */
export function versionDir(studioDir: string, artifactId: string, version: number): string {
  return join(studioDir, "artifacts", artifactId, `v${version}`);
}

const safePath = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length <= 300 && !p.startsWith("/") && !p.includes("\\") && !/[\u0000-\u001f\u007f]/.test(p) && p.split("/").every((s) => s !== "" && s !== "." && s !== "..");

/**
 * The bytes of `rel` in one version's folder, if it is a regular file reached through no symlink: the folder must
 * resolve to exactly <studioDir>/artifacts/<artifactId>/v<n>, every folder below it to itself, and the file is
 * opened without following a link. Undefined otherwise, or when its size is not `bytes` (if given).
 */
function readVersionFile(studioDir: string, artifactId: string, version: number, rel: string, bytes?: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    const base = realpathSync(versionDir(studioDir, artifactId, version));
    if (base !== versionDir(realpathSync(studioDir), artifactId, version)) return undefined;
    const file = join(base, rel);
    if (realpathSync(dirname(file)) !== dirname(file)) return undefined;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES || (bytes !== undefined && st.size !== bytes)) return undefined;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) return undefined;
      read += n;
    }
    return buf;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One version's manifest, read through the same guard and checked against the version it is read for; undefined if it is missing or malformed. */
export function readManifest(studioDir: string, artifactId: string, version: number): PrototypeManifest | undefined {
  let m: Partial<PrototypeManifest>;
  try {
    m = JSON.parse(readVersionFile(studioDir, artifactId, version, "manifest.json")?.toString("utf8") ?? "");
  } catch {
    return undefined;
  }
  if (!m || typeof m !== "object" || m.artifactId !== artifactId || m.version !== version) return undefined;
  if (!Array.isArray(m.files) || !Array.isArray(m.variants) || !Array.isArray(m.devices)) return undefined;
  const filesOk = m.files.every((f) => f && safePath(f.path) && typeof f.sha256 === "string" && SHA256.test(f.sha256) && Number.isInteger(f.bytes) && f.bytes >= 0 && f.bytes <= MAX_FILE_BYTES);
  const variantsOk = m.variants.every((v) => v && typeof v.id === "string" && VARIANT_ID.test(v.id) && safePath(v.entry));
  if (!filesOk || !variantsOk || !m.devices.every((d) => typeof d === "string")) return undefined;
  return m as PrototypeManifest;
}

/** A served file of one version: its bytes and its extension (lowercase, with the dot). */
export interface ServedFile {
  body: Buffer;
  ext: string;
}

/**
 * One file of a version, as a server may serve it, or undefined: a file its manifest lists (its bytes matching the
 * recorded hash), one of its screenshots (shots/<variant>-<device>.png for a variant and device of the version, a
 * PNG), or one of its terminal recordings (recording/<variant>/…, a GIF, WebM or text, each checked for its kind).
 * Read through the version folder's guard: no symlink, nothing outside it. Shared by the prototype server and the
 * app's own file route (files.ts), which serves fewer types.
 */
export function readServedFile(studioDir: string, artifactId: string, version: number, rel: string, log: (msg: string) => void = () => {}): ServedFile | undefined {
  if (!ARTIFACT_ID.test(artifactId) || !Number.isInteger(version) || version < 1 || !safePath(rel)) return undefined;
  const manifest = readManifest(studioDir, artifactId, version);
  if (!manifest) return undefined;

  // A screenshot the service took: shots/<variant>-<device>.png, for a variant and a device of this version.
  if (rel.startsWith("shots/")) {
    const name = rel.slice("shots/".length);
    const known = manifest.variants.some((v) => SHOT_DEVICES.some((d) => manifest.devices.includes(d) && name === `${v.id}-${d}.png`));
    const png = known ? readVersionFile(studioDir, artifactId, version, rel) : undefined;
    return png && png.subarray(0, 8).equals(PNG_SIGNATURE) ? { body: png, ext: ".png" } : undefined;
  }

  // A terminal recording the service made: recording/<variant>/<the tape's Output path>, GIF, WebM or text.
  if (rel.startsWith("recording/")) {
    const [variant, ...rest] = rel.slice("recording/".length).split("/");
    const ext = extname(rel).toLowerCase();
    const signature = RECORDING_SIGNATURES[ext];
    const known = manifest.variants.some((v) => v.id === variant) && rest.length > 0 && signature !== undefined;
    const body = known ? readVersionFile(studioDir, artifactId, version, rel) : undefined;
    return body && (!signature || body.subarray(0, signature.length).equals(signature)) ? { body, ext } : undefined;
  }

  const entry = manifest.files.find((f) => f.path === rel);
  if (!entry) return undefined;
  const body = readVersionFile(studioDir, artifactId, version, entry.path, entry.bytes);
  if (!body || createHash("sha256").update(body).digest("hex") !== entry.sha256) {
    log(`Prototype ${artifactId} v${version}: ${entry.path} is missing or does not match its recorded hash; not served.`);
    return undefined;
  }
  return { body, ext: extname(entry.path).toLowerCase() };
}

/** The first bytes a served PNG, GIF or WebM starts with. */
export const MAGIC: Readonly<Record<".png" | ".gif" | ".webm", Buffer>> = { ".png": PNG_SIGNATURE, ".gif": RECORDING_SIGNATURES[".gif"]!, ".webm": RECORDING_SIGNATURES[".webm"]! };

/** The page with the pin script added: before the last </body>, or at the end. */
function withPinScript(html: Buffer): Buffer {
  const at = html.toString("latin1").toLowerCase().lastIndexOf("</body");
  return at < 0 ? Buffer.concat([html, PIN_TAG]) : Buffer.concat([html.subarray(0, at), PIN_TAG, html.subarray(at)]);
}

interface PrototypeServerOptions {
  /** The current project's studio workspace (projectStudioDir), read on every request; undefined serves nothing. */
  studioDir: () => string | undefined;
  /** The app's origins (http://host:port), the only pages allowed to frame a prototype. */
  appOrigins: string[];
  log?: (msg: string) => void;
}

/** The second listener. Listen on 127.0.0.1 only; the Host check uses the port it listens on. */
export function createPrototypeServer(opts: PrototypeServerOptions): Server {
  const headers = prototypeHeaders(opts.appOrigins);
  const log = opts.log ?? (() => {});
  const reply = (res: ServerResponse, status: number, type: string, body: Buffer, head: boolean) => {
    res.writeHead(status, { ...headers, "Content-Type": type, "Content-Length": body.length });
    res.end(head ? undefined : body);
  };
  const refuse = (res: ServerResponse, status: number, message: string, head = false) => reply(res, status, "text/plain; charset=utf-8", Buffer.from(`${message}\n`), head);

  const server = createServer((req, res) => {
    try {
      const head = req.method === "HEAD";
      if (req.method !== "GET" && !head) return refuse(res, 405, "Method not allowed");
      const port = (server.address() as AddressInfo).port;
      const host = new RegExp(`^p-([a-z0-9-]+)-v([1-9][0-9]{0,5})\\.localhost:${port}$`).exec((req.headers.host ?? "").toLowerCase());
      if (!host || !ARTIFACT_ID.test(host[1])) return refuse(res, 403, "Unexpected Host header", head);
      const [artifactId, version] = [host[1], Number(host[2])];

      let rel: string;
      try {
        rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).slice(1);
      } catch {
        return refuse(res, 400, "Malformed path", head);
      }
      if (`/${rel}` === PIN_PATH) return reply(res, 200, TYPES[".js"], Buffer.from(PIN_SCRIPT), head);

      const studioDir = opts.studioDir();
      const file = studioDir ? readServedFile(studioDir, artifactId, version, rel, log) : undefined;
      const type = file && TYPES[file.ext];
      if (!file || !type) return refuse(res, 404, "Not found", head);
      return reply(res, 200, type, type.startsWith("text/html") ? withPinScript(file.body) : file.body, head);
    } catch (e) {
      log(`Prototype request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) return refuse(res, 500, "Internal error");
      res.destroy();
    }
  });
  return server;
}
