// ORC-029 pass 5, the "Capture evidence" step, for real: where Docker runs and the recorder's image (tag 2) is built,
// a tiny fixture repository (a static page served by a two-line Node server, and a Node CLI) is installed, previewed
// and captured, and the PNGs and the GIF come back; a hostile page and a hostile CLI reach neither the network nor this
// computer, their install hooks never run although the install has the network, and the files they plant do not come
// back; a preview that does not start says so. Skipped, with the reason, without Docker or the image.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_INSTALL, type CaptureItem, type ItemCapture } from "../../src/domain/studio/evidence";
import { RECORDER_IMAGE, defaultRecorderRoot, dockerReady } from "./container";
import { captureEvidence } from "./evidence";

const APP = resolve(__dirname, "fixtures/evidence-app");
const HOSTILE = resolve(__dirname, "fixtures/evidence-hostile");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SCREEN: CaptureItem = { itemId: "bi-1", kind: "screen", title: "Trip board", artifactId: "sa-1", version: 2 };
const CLI: CaptureItem = { itemId: "bi-3", kind: "terminal-demo", title: "trips CLI", artifactId: "sa-3", version: 1 };
const HOSTILE_PAGE: CaptureItem = { itemId: "bi-2", kind: "screen", title: "Hostile page", artifactId: "sa-2", version: 1 };
const HOSTILE_CLI: CaptureItem = { itemId: "bi-4", kind: "tui", title: "Hostile CLI", artifactId: "sa-4", version: 1 };

const ready = await dockerReady();
const skipReason = ready.ok ? "" : ` (skipped: ${ready.reason})`;
mkdirSync(defaultRecorderRoot(), { recursive: true });
/** Where these captures stage their folders: one Docker can see. Each capture's stage must be gone afterwards. */
const ROOT = mkdtempSync(join(defaultRecorderRoot(), "test-evidence-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const containersLeft = () => (ready.ok ? execFileSync(ready.docker, ["ps", "--all", "--filter", `name=orc-ev-${process.pid}-`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim() : "");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-evidence-real-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The change: a copy of a fixture, as a worktree of it would hold it. */
function change(fixture: string, extra: Record<string, string> = {}): string {
  const src = join(dir, "change");
  cpSync(fixture, src, { recursive: true });
  for (const [rel, text] of Object.entries(extra)) writeFileSync(join(src, rel), text);
  return src;
}
const listed = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(d.length + 1)).sort();
/** A PNG's width and height, from its header. */
const pngSize = (file: string) => {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};
const captured = (i: ItemCapture | undefined) => {
  if (i?.status !== "captured") throw new Error(`not captured: ${JSON.stringify(i)}`);
  return i;
};
const timings: string[] = [];
afterAll(() => {
  if (timings.length) console.log(`evidence capture timings: ${timings.join("; ")}`);
});

describe(`capturing evidence in the recorder's container${skipReason}`, () => {
  const listeners: Server[] = [];
  afterAll(() => {
    for (const l of listeners) l.close();
  });
  afterEach(() => {
    // Nothing a capture made stays behind: its stage folder and its containers are gone.
    expect(readdirSync(ROOT)).toEqual([]);
    expect(containersLeft()).toBe("");
  });

  it.skipIf(!ready.ok)(
    "installs, previews and captures the fixture: its page on desktop and mobile, and its CLI as a GIF and a transcript",
    async () => {
      const out = join(dir, "evidence");
      const t0 = Date.now();
      const r = await captureEvidence({ source: change(APP), sha: SHA, items: [SCREEN, CLI], preview: { rev: 1, install: DEFAULT_INSTALL, preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" }, outDir: out, root: ROOT });
      timings.push(`fixture app ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      expect(r.sha).toBe(SHA);
      const page = captured(r.items[0]);
      expect(page.files.map((f) => [f.path, f.type, f.device])).toEqual([
        ["bi-1/desktop.png", "png", "desktop"],
        ["bi-1/mobile.png", "png", "mobile"],
      ]);
      expect(page.warnings).toBeUndefined();
      // The studio's device sizes: desktop 1280×800 at 1×, mobile 390×844 at 3×.
      expect(pngSize(join(out, "bi-1/desktop.png"))).toEqual({ width: 1280, height: 800 });
      expect(pngSize(join(out, "bi-1/mobile.png"))).toEqual({ width: 1170, height: 2532 });
      const cli = captured(r.items[1]);
      expect(cli.files.map((f) => f.path)).toEqual(["bi-3/trips.gif", "bi-3/trips.txt"]);
      expect(cli.warnings).toBeUndefined();
      expect(readFileSync(join(out, "bi-3/trips.gif")).subarray(0, 6).toString("latin1")).toBe("GIF89a");
      const txt = readFileSync(join(out, "bi-3/trips.txt"), "utf8");
      expect(txt).toContain("> node bin/trips.js list");
      expect(txt).toContain("Lake weekend    4 going  12-14 June");
      // The package's preinstall hook never ran.
      expect(txt).not.toContain("INSTALL HOOK RAN");
      expect(listed(out)).toEqual(["bi-1/desktop.png", "bi-1/mobile.png", "bi-3/trips.gif", "bi-3/trips.txt"]);
    },
    300_000,
  );

  it.skipIf(!ready.ok)(
    "a hostile page and CLI reach neither the network nor this computer, its install hooks never run, and what it plants does not come back",
    async () => {
      // A listener on this computer's loopback: the host gateway forwards to it from a container that has a network.
      let hits = 0;
      const canary = await new Promise<Server>((res) => {
        const s = createServer((c) => {
          hits++;
          c.destroy();
        });
        s.listen(0, "127.0.0.1", () => res(s));
      });
      listeners.push(canary);
      const port = (canary.address() as { port: number }).port;
      // The control: a container with Docker's network (as the install has) does reach the listener, so a hook that
      // ran during the install would show. (Colima forwards the host gateway to this computer's loopback.)
      if (!ready.ok) return;
      const control = `const s=require("node:net").connect(${port},"host.lima.internal");s.on("connect",()=>{console.log("CONNECTED");s.destroy()});s.on("error",(e)=>console.log(e.code))`;
      const reached = execFileSync(ready.docker, ["run", "--rm", "--pull", "never", "--network", "bridge", "--user", "10001:10001", RECORDER_IMAGE, "/usr/local/bin/node", "-e", control], { encoding: "utf8", timeout: 60_000 }).trim();
      await new Promise((r) => setTimeout(r, 200));
      expect({ reached, hits }).toEqual({ reached: "CONNECTED", hits: 1 });
      hits = 0;
      const out = join(dir, "evidence");
      const t0 = Date.now();
      const r = await captureEvidence({
        source: change(HOSTILE, { "canary.json": JSON.stringify({ port }) }),
        sha: SHA,
        items: [HOSTILE_PAGE, HOSTILE_CLI],
        preview: { rev: 1, install: DEFAULT_INSTALL, preview: ["npm", "run", "preview"], port: 4173 },
        outDir: out,
        root: ROOT,
        // The page reports after its probes end (up to 4 s).
        limits: { settleMs: 6000 },
      });
      timings.push(`hostile fixture ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      expect(hits).toBe(0);
      const page = captured(r.items[0]);
      // The planted link at mobile.png is never followed; only the desktop shot comes back.
      expect(page.files.map((f) => f.path)).toEqual(["bi-2/desktop.png"]);
      const probes = page.warnings?.find((w) => w.includes("PROBES")) ?? "";
      expect(probes).toMatch(/http:\/\/1\.1\.1\.1\/ blocked/);
      expect(probes).toMatch(/webrtc no srflx/);
      expect(probes).toMatch(/1\.1\.1\.1:443 /);
      expect(probes).not.toMatch(/REACHED/);
      expect(page.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Not captured on mobile: bi-2\/mobile\.png .*reached through no link/)]));
      const cli = captured(r.items[1]);
      expect(cli.files.map((f) => f.path)).toEqual(["bi-4/hostile.txt"]);
      const txt = readFileSync(join(out, "bi-4/hostile.txt"), "utf8");
      for (const line of ["1.1.1.1:443 E", "dns example.com E", `192.168.5.2:${port} E`, "read /Users ENOENT", "write /etc/hostile E", "host terminals none", "probes done"]) expect(txt).toContain(line);
      expect(txt).not.toMatch(/REACHED/);
      expect(listed(out)).toEqual(["bi-2/desktop.png", "bi-4/hostile.txt"]);
    },
    300_000,
  );

  it.skipIf(!ready.ok)(
    "a built app that leaves a folder no one can read (mode 000) in its stage: the capture still ends, and its stage folder is gone",
    async () => {
      // The review's leak: the clean-up stopped at such a folder (EACCES), and later sweeps failed on it too.
      const lock = "const fs=require('node:fs');fs.mkdirSync('/work/locked/inner',{recursive:true});fs.writeFileSync('/work/locked/inner/f.txt','x');fs.chmodSync('/work/locked/inner',0);fs.chmodSync('/work/locked',0);process.exit(1);\n";
      const out = join(dir, "evidence");
      const r = await captureEvidence({ source: change(APP, { "lock.js": lock }), sha: SHA, items: [SCREEN], preview: { rev: 1, install: [], preview: ["node", "lock.js"], port: 4173 }, outDir: out, root: ROOT });
      expect(r.items.map((i) => [i.status, i.status === "none" ? i.reason : ""])).toEqual([["none", "preview-did-not-start"]]);
      // The afterEach checks that the stage folder and the containers are gone.
    },
    300_000,
  );

  it.skipIf(!ready.ok)(
    "a preview that does not start: the screen says so, with the end of its log",
    async () => {
      const out = join(dir, "evidence");
      const t0 = Date.now();
      const r = await captureEvidence({ source: change(APP), sha: SHA, items: [SCREEN], preview: { rev: 1, install: [], preview: ["node", "missing-server.js"], port: 4173 }, outDir: out, root: ROOT });
      timings.push(`preview that does not start ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      expect(r.items).toEqual([{ ...SCREEN, status: "none", reason: "preview-did-not-start", detail: "The preview command ended (exit 1) before port 4173 opened.", log: expect.stringMatching(/Cannot find module '\/work\/missing-server\.js'/) }]);
      expect(listed(out)).toEqual([]);
    },
    300_000,
  );
});
