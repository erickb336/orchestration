// How the app and a served prototype meet (ORC-029 pass 3, docs/design/ORC-029-pass3-design.md, 3b). Shared by the
// service (server/studio/serve.ts serves each artifact version on its own origin and injects the pin script) and
// the UI (it frames that origin with sandbox="allow-scripts", never allow-same-origin, and takes pins through
// acceptPinMessage). No Node or DOM imports: both sides load this file.

/**
 * The origin one artifact version is served on. Every version has its own hostname, because cookies and storage
 * are shared across ports on one host. `*.localhost` resolves to the loopback address in Chrome and in Safari's
 * WebKit (checked 2026-10-02), so no hosts-file entry is needed.
 */
export function prototypeOrigin(artifactId: string, version: number, port: number): string {
  return `http://p-${artifactId}-v${version}.localhost:${port}`;
}

/** Where the owner clicked in a prototype: fractions (0 to 1) of the document's width and height, and a short CSS selector of the element. */
export interface PinMessage {
  type: "orchestrator-pin";
  x: number;
  y: number;
  selector: string;
}

/** The longest selector a pin carries; the pin script cuts its own at this length. */
export const MAX_PIN_SELECTOR = 300;

/**
 * The pin a prototype frame posted, or null for anything else: a message from another window (only
 * `event.source === frameWindow` counts), another type, an extra or missing field, a position outside the document,
 * or a selector that is not a short string. The selector is the prototype's text: show it as text, never as markup.
 *
 * Self-contained (it names nothing outside itself), so the escape tests run this very function in a real browser.
 */
export function acceptPinMessage(event: { source: unknown; data: unknown }, frameWindow: unknown): PinMessage | null {
  if (frameWindow == null || event.source !== frameWindow) return null;
  const d = event.data;
  if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
  const keys = Object.keys(d).sort();
  if (keys.length !== 4 || keys[0] !== "selector" || keys[1] !== "type" || keys[2] !== "x" || keys[3] !== "y") return null;
  const { type, x, y, selector } = d as Record<string, unknown>;
  if (type !== "orchestrator-pin") return null;
  const fraction = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 1;
  if (!fraction(x) || !fraction(y)) return null;
  if (typeof selector !== "string" || selector.length > 300) return null;
  return { type, x, y, selector };
}
