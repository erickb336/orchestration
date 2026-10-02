// Mermaid diagrams, drawn in a frame that can reach nothing (ORC-029 F2; pass 4 review, finding 2).
//
// A designer's .mmd file is untrusted, and Mermaid loads URLs while it lays a diagram out in a live document: a
// directive's themeCSS with url(…), an image shape, a C4 sprite. So the app never runs Mermaid in its own page. Mermaid
// runs in one hidden frame:
// - sandbox="allow-scripts" and never allow-same-origin: an opaque origin, with no way into the app's page, its
//   cookies, its storage or its API;
// - a srcdoc document, so the app page's own policy applies to it too, and its <meta> policy adds: no request of any
//   kind (default-src 'none'), only the two scripts named here, and inline styles for Mermaid's SVG;
// - Mermaid's classic bundle (a module needs CORS in an opaque origin) and diagramFrame.js, both from the app's origin.
// The frame posts back the SVG text. The app shows it as an <img> from a data: URL, where nothing runs or loads.

import type { MermaidConfig } from "mermaid";
import mermaidScript from "mermaid/dist/mermaid.min.js?url";
import frameScript from "./diagramFrame.js?url&no-inline";

/** The diagram frame's own policy: nothing loads but its two scripts, and Mermaid's SVG may carry inline styles. */
export function diagramFramePolicy(scripts: readonly string[]): string {
  return `default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The frame's whole document (its srcdoc): its policy, then Mermaid, then the frame's script. `scripts` are absolute URLs. */
export function diagramFrameDocument(scripts: readonly string[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr(diagramFramePolicy(scripts))}"></head><body>${scripts.map((s) => `<script src="${attr(s)}"></script>`).join("")}</body></html>`;
}

/** The longest SVG text taken back from the frame. */
export const MAX_SVG_CHARS = 4 * 1024 * 1024;

export type DiagramReply = { kind: "ready"; mermaid: boolean } | { kind: "drawn"; id: number; svg: string } | { kind: "failed"; id: number; message: string };

/** A message from the frame, read as one of its three replies; null for anything else. The caller checks it came from the frame. */
export function readDiagramReply(data: unknown): DiagramReply | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type === "orc-diagram-ready") return { kind: "ready", mermaid: d.mermaid === true };
  if (typeof d.id !== "number" || !Number.isInteger(d.id)) return null;
  if (d.type === "orc-diagram-drawn" && typeof d.svg === "string") return d.svg.length <= MAX_SVG_CHARS ? { kind: "drawn", id: d.id, svg: d.svg } : { kind: "failed", id: d.id, message: "The drawing is too large to show." };
  if (d.type === "orc-diagram-failed" && typeof d.message === "string") return { kind: "failed", id: d.id, message: d.message.slice(0, 1000) };
  return null;
}

const START_MS = 20_000;
const DRAW_MS = 20_000;

let frame: { window: Window; ready: Promise<void> } | undefined;
const waiting = new Map<number, { resolve: (svg: string) => void; reject: (e: Error) => void }>();
let nextId = 1;

/** The one diagram frame, made on first use. */
function diagramFrame(): { window: Window; ready: Promise<void> } {
  if (frame) return frame;
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  el.title = "Diagram renderer";
  el.className = "st-diagram-frame";
  el.srcdoc = diagramFrameDocument([mermaidScript, frameScript].map((u) => new URL(u, document.baseURI).href));
  let started: () => void = () => {};
  let broken: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    started = resolve;
    broken = reject;
  });
  addEventListener("message", (e) => {
    if (!frame || e.source !== frame.window) return;
    const r = readDiagramReply(e.data);
    if (!r) return;
    if (r.kind === "ready") return r.mermaid ? started() : broken(new Error("the diagram renderer did not load"));
    const w = waiting.get(r.id);
    waiting.delete(r.id);
    if (r.kind === "drawn") w?.resolve(r.svg);
    else w?.reject(new Error(r.message));
  });
  document.body.appendChild(el);
  frame = { window: el.contentWindow!, ready };
  setTimeout(() => broken(new Error("the diagram renderer did not start")), START_MS);
  return frame;
}

// Mermaid draws one diagram at a time (it measures text in its document); diagrams wait their turn.
let queue: Promise<unknown> = Promise.resolve();

/** Draws `source` in the diagram frame and returns Mermaid's SVG text. One at a time; each within a time limit. */
export function drawDiagram(source: string, config: MermaidConfig): Promise<string> {
  const job = queue.then(async () => {
    const f = diagramFrame();
    await f.ready;
    const id = nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`drawing took longer than ${DRAW_MS / 1000} s`));
      }, DRAW_MS);
      const done = <T>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        fn(v);
      };
      waiting.set(id, { resolve: done(resolve), reject: done(reject) });
      f.window.postMessage({ type: "orc-diagram-draw", id, source, config }, "*");
    });
  });
  queue = job.catch(() => undefined);
  return job;
}
