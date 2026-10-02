// Test helpers for the prototype server and screenshots: artifact version folders in the shape the studio service
// (3a) writes, <studioDir>/artifacts/<artifactId>/v<n>/ with the files and a manifest.json, and a request helper that
// sets the Host header (fetch cannot). Also the stand-ins for the ways out that no page policy covers: WebRTC, DNS
// prefetch and preconnect, observed by listeners on the network and by Chrome's own network log.

import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { initProject } from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import { addScreen, openRound, peAgrees, run } from "../../src/domain/testing/studio";
import type { State } from "../../src/domain/types";
import { versionDir, type PrototypeManifest } from "./serve";

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Writes the files and a manifest listing each with its hash; returns the version folder. */
export function writeVersion(
  studioDir: string,
  artifactId: string,
  version: number,
  files: Record<string, string | Buffer>,
  meta: Partial<Pick<PrototypeManifest, "devices" | "variants" | "kind" | "title">> = {},
): string {
  const dir = versionDir(studioDir, artifactId, version);
  const listed: PrototypeManifest["files"] = [];
  for (const [path, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), buf);
    listed.push({ path, sha256: sha256(buf), bytes: buf.length });
  }
  const manifest: PrototypeManifest = {
    artifactId,
    version,
    kind: meta.kind ?? "screen",
    title: meta.title ?? `Artifact ${artifactId}`,
    devices: meta.devices ?? ["desktop", "mobile"],
    variants: meta.variants ?? [{ id: "a", label: "A", entry: "a/index.html" }],
    files: listed,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

export async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

export interface Got {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** One request to 127.0.0.1:<port> with the given Host header and a raw path (sent as is, not normalised). */
export function get(port: number, host: string, path: string, method = "GET"): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A valid 1×1 transparent PNG. */
export const TINY_PNG = (() => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(5))), chunk("IEND", Buffer.alloc(0))]);
})();

/** A PNG's pixel size, from its header. */
export const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

// ---------- a project in Vision, for checks of the real app in a browser ----------

const BOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head>
<body><header><h1>Trip board</h1><button type="button">New trip</button></header>
<main><section><h2>Coast weekend</h2><p>Fri 12 to Sun 14 · 4 people</p></section><section><h2>Lake cabin</h2><p>Not dated yet · 2 people</p></section></main></body></html>`;
const BOARD_CSS = `body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #f6f4ef; color: #222; }
header { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; background: #fff; border-bottom: 1px solid #ddd; }
main { display: grid; gap: 16px; padding: 24px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
section { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
h1, h2 { margin: 0; font-size: 1.1rem; }`;
const API_MD = `# Trip planner API

Every call answers with \`JSON\`. A trip has days, and a day has stops.

| Call | What it does | Errors |
| --- | --- | --- |
| \`plan(trip)\` | Orders the stops of each day | \`NoDates\` when the trip has no dates |
| \`share(trip, people)\` | Sends the plan to the people | \`TooMany\` above 12 people |

\`\`\`ts
export function plan(trip: Trip): DayPlan[];
\`\`\`

\`\`\`mermaid
sequenceDiagram
  App->>Planner: plan(trip)
  Planner-->>App: DayPlan[]
\`\`\`
`;
const FLOW_MMD = `flowchart LR
  A[Pick a trip] --> B{Dates set?}
  B -- yes --> C[Order the stops]
  B -- no --> D[Ask for dates]
  C --> E[Share the plan]`;

/**
 * Hostile documents (pass 4 review, finding 2): Mermaid and Markdown that try to load `ext`, the address of a server
 * the test watches. Each must load nothing, wherever the app draws it.
 */
export function hostileDocuments(ext: string): Record<string, string> {
  return {
    "bad/theme-css.mmd": `%%{init: {"themeCSS": ".node rect { fill: url(${ext}/theme-fill) } @import url(${ext}/theme-import); @font-face { font-family: x; src: url(${ext}/theme-font) } text { font-family: x; background-image: url(${ext}/theme-bg) }"}}%%\nflowchart LR\n  A[Theme CSS] --> B`,
    "bad/front-matter.mmd": `---\nconfig:\n  themeCSS: "rect { fill: url(${ext}/front-matter-fill) }"\n  fontFamily: "x; background: url(${ext}/front-matter-font)"\n---\nflowchart LR\n  A[Front matter] --> B`,
    "bad/image-shape.mmd": `flowchart LR\n  A@{ img: "${ext}/image-shape.png", label: "An image shape", pos: "t", w: 60, h: 60 }\n  A --> B`,
    "bad/c4-sprite.mmd": `C4Context\n  Person(a, "A person", "with a sprite", "${ext}/c4-sprite.png")\n  System(b, "A system", "with a link", $link="${ext}/c4-link")`,
    "bad/click.mmd": `flowchart LR\n  A[A link] --> B\n  click A href "${ext}/click" "a link"`,
    "bad/hostile.md": [
      "# Hostile Markdown",
      `![remote image](${ext}/md-image.png) ![ref image][r]`,
      "",
      `[r]: ${ext}/md-ref-image.png`,
      "",
      `<img src="${ext}/md-raw-img.png"><link rel="dns-prefetch" href="${ext}"><iframe src="${ext}/md-frame"></iframe><style>body { background: url(${ext}/md-style) }</style>`,
      "",
      `[a link](${ext}/md-link) and <${ext}/md-autolink>`,
      "",
      "```mermaid",
      `%%{init: {"themeCSS": "rect { fill: url(${ext}/md-mermaid-fill) }"}}%%`,
      "flowchart LR",
      "  A[In Markdown] --> B",
      "```",
    ].join("\n"),
  };
}

/** A version for the studio to show: its artifact, and the files to write in its folder (writeVersion). */
export interface SampleVersion {
  id: string;
  version: number;
  files: Record<string, string>;
  meta: Partial<Pick<PrototypeManifest, "devices" | "variants" | "kind" | "title">>;
}

/**
 * A project in Vision with what the owner reviews: round 0, "as it is today", with a screen the designer reproduced
 * from the repository (labelled as is, with its files); round 1 with a document, Markdown and Mermaid. Both agreed by
 * the PE (simulated). Domains are not chosen yet. With `hostile`, round 1 also holds hostileDocuments.
 */
export function studioSample(t0: number, hostile?: { ext: string }): { state: State; versions: SampleVersion[] } {
  const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
  let s = initProject(buildSeed(t0, { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/trips", vision: "Plan weekend trips with friends.", focus: "" }, at(0));
  const versions: SampleVersion[] = [];
  const add = (round: number, kind: string, title: string, files: Record<string, string>, variants: { id: string; label: string; entry?: string }[], devices: string[], extra: object = {}) => {
    const listed = Object.entries(files).map(([path, text]) => ({ path, sha256: sha256(text) }));
    const a = addScreen(s, round, at(versions.length + 3), { kind, title, variants, files: listed, devices, ...extra });
    s = peAgrees(a.state, a.id, a.version, variants.map((v) => v.id), at(versions.length + 20));
    versions.push({ id: a.id, version: a.version, files, meta: { kind, title, variants: variants.map((v) => ({ entry: "", ...v })), devices } });
  };
  s = openRound(s, "material", at(1)).state;
  add(0, "screen", "Trip board", { "board/index.html": BOARD_HTML, "board/style.css": BOARD_CSS }, [{ id: "a", label: "As is", entry: "board/index.html" }], ["desktop", "mobile"], { provenance: { files: ["src/board/index.html", "src/board/style.css", "src/trips.js"] } });
  s = run(s, "closeRound", { round: 0, summary: "The trip board as the repository has it today." }, at(40)).state;
  s = openRound(s, "data", at(41)).state;
  add(1, "interface", "Trip planner API", { "api/README.md": API_MD, "api/flow.mmd": FLOW_MMD }, [], []);
  if (hostile) add(1, "contract", "Hostile samples", hostileDocuments(hostile.ext), [], []);
  return { state: s, versions };
}

// ---------- ways out that no page policy covers (pass 3 review, finding 3) ----------

/** This machine's first IPv4 address on a network (not loopback), or undefined when it has none. */
export function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
}

/**
 * Stand-ins for servers on the network, listening on every interface: a STUN server (UDP), a TURN server (TCP) and a
 * web server a page may preconnect to (TCP). Each records what reached it.
 */
export async function outsideListeners(): Promise<{ stun: number; turn: number; web: number; hits: () => string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const udp = createSocket("udp4");
  udp.on("message", (m) => hits.push(`STUN: ${m.length} bytes over UDP`));
  await new Promise<void>((r) => udp.bind(0, "0.0.0.0", r));
  const tcp = (what: string) => {
    const s = createNetServer((socket) => {
      hits.push(`${what}: a TCP connection`);
      socket.on("error", () => {});
      setTimeout(() => socket.destroy(), 200);
    });
    return new Promise<NetServer>((r) => s.listen(0, "0.0.0.0", () => r(s)));
  };
  const [turn, web] = await Promise.all([tcp("TURN"), tcp("preconnect")]);
  const port = (s: NetServer) => (s.address() as AddressInfo).port;
  return {
    stun: udp.address().port,
    turn: port(turn),
    web: port(web),
    hits: () => [...hits],
    close: async () => {
      udp.close();
      for (const s of [turn, web]) await new Promise<void>((r) => s.close(() => r()));
    },
  };
}

/** The host names the outside page asks the browser to resolve; `tag` makes them unique to one test run. */
export const outsideHosts = (tag: string) => ({ dnsPrefetch: `orc-dnsprefetch-${tag}.invalid`, preconnect: `orc-preconnect-${tag}.invalid`, scripted: `orc-scripted-${tag}.invalid`, stun: `orc-stun-${tag}.invalid` });

/**
 * A prototype that tries the ways out a page policy does not cover: WebRTC to a STUN server and to a TURN server (with a
 * user name, which a TURN server would read), `<link rel="dns-prefetch">` and `<link rel="preconnect">` (in the page,
 * and added by a script), to an address and to host names. It records its ICE candidates in window.__ice and sets
 * window.__done after four seconds. With `holdMs`, the page holds its load event that long (a busy loop after the
 * attempts): WebRTC gathers off the main thread (a candidate pool needs no offer), so the attempts go on meanwhile.
 */
export function outsidePage(lan: string, ports: { stun: number; turn: number; web: number }, tag: string, holdMs = 0): string {
  const h = outsideHosts(tag);
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="dns-prefetch" href="//${h.dnsPrefetch}">
<link rel="preconnect" href="http://${lan}:${ports.web}">
<link rel="preconnect" href="http://${h.preconnect}">
</head><body><main><p>Trying WebRTC, DNS prefetch and preconnect.</p></main>
<script>
window.__ice = [];
var pc = new RTCPeerConnection({ iceCandidatePoolSize: 2, iceServers: [{ urls: "stun:${lan}:${ports.stun}" }, { urls: "stun:${h.stun}:3478" }, { urls: "turn:${lan}:${ports.turn}?transport=tcp", username: "leaked-by-the-prototype", credential: "x" }] });
pc.onicecandidate = function (e) { window.__ice.push(e.candidate ? e.candidate.candidate : "end"); };
pc.createDataChannel("out");
pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function (e) { window.__ice.push("error: " + e.name); });
var l = document.createElement("link"); l.rel = "dns-prefetch"; l.href = "//${h.scripted}"; document.head.appendChild(l);
setTimeout(function () { window.__done = true; }, 4000);
</script>${holdMs ? `<script>var until = Date.now() + ${holdMs}; while (Date.now() < until) {}</script>` : ""}</body></html>`;
}

/**
 * The system Chrome that playwright-core launches (CHROME_PATH, or Google Chrome where it installs), wrapped so that it
 * writes Chrome's own network log to `netLog`: what its resolver looked up. Undefined when there is no such Chrome.
 */
export function chromeWritingNetLog(dir: string, netLog: string): string | undefined {
  const chrome = process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/opt/google/chrome/chrome");
  if (!existsSync(chrome)) return undefined;
  const wrapper = join(dir, "chrome-with-netlog");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(chrome)} --log-net-log=${JSON.stringify(netLog)} --net-log-capture-mode=Everything "$@"\n`, { mode: 0o755 });
  return wrapper;
}

/** From Chrome's network log, what it did for each host name with `tag` in it: the event names (DNS_TRANSACTION: a query went out). */
export function netLogHosts(netLog: string, tag: string): Record<string, string[]> {
  const text = readFileSync(netLog, "utf8").trim();
  type NetLog = { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: unknown }[] };
  let log: NetLog;
  try {
    log = JSON.parse(text) as NetLog;
  } catch {
    // A log Chrome did not finish ends after an event: close it.
    log = JSON.parse(`${text.replace(/,$/, "")}]}`) as NetLog;
  }
  const names = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const out: Record<string, Set<string>> = {};
  const host = new RegExp(`orc-[a-z]+-${tag}\\.invalid`, "g");
  for (const e of log.events) for (const h of new Set(JSON.stringify(e.params ?? {}).match(host) ?? [])) (out[h] ??= new Set()).add(names[e.type]);
  return Object.fromEntries(Object.entries(out).map(([h, s]) => [h, [...s].sort()]));
}
