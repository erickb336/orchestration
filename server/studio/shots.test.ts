// Screenshots of artifact versions (ORC-029 pass 3, 3b): each variant on each device, at the device's size, kept
// beside the version and served by the prototype server; a page that never settles times out without holding the
// rest; nothing leaves the machine; without Chrome nothing is captured, and the outcome says so.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrototypeServer, versionDir } from "./serve";
import { captureShots, launchChrome } from "./shots";
import { chromeWritingNetLog, close, get, lanAddress, listen, netLogHosts, outsideListeners, outsidePage, pngSize, writeVersion } from "./testFixtures";

const chrome = await launchChrome();
const browser = "browser" in chrome ? chrome.browser : undefined;
// Written straight to stderr: the test runner shows no console output from a skipped test.
if (!browser) process.stderr.write(`Skipping the screenshot tests that need Chrome: ${"missing" in chrome ? chrome.missing : ""}. Install Google Chrome or set CHROME_PATH.\n`);
afterAll(() => browser?.close());

const RED = "rgb(200, 30, 30)";
const BLUE = "rgb(30, 30, 200)";
// With the viewport tag a mobile prototype has; without it a phone lays the page out 980 px wide and scales it.
const page = (css: string, body = "") => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"></head><body>${body}</body></html>`;
const fill = (color: string) => `html, body { margin: 0; height: 100%; background: ${color}; }`;
const TWO_VARIANTS = {
  variants: [
    { id: "a", label: "Red", entry: "a/index.html" },
    { id: "b", label: "Blue", entry: "b/index.html" },
  ],
};

let root: string;
let studio: string;
let outside: Server | undefined;
let outsideRequests: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orch-shots-"));
  studio = join(root, "studio", "p-test");
  outsideRequests = [];
});
afterEach(async () => {
  await close(outside);
  outside = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** The colour of a PNG's centre pixel, read by Chrome itself. */
async function centre(png: Buffer): Promise<string> {
  const p = await browser!.newPage();
  try {
    await p.setContent(`<img id="i" src="data:image/png;base64,${png.toString("base64")}">`);
    return await p.evaluate(`(async () => {
      const img = document.getElementById("i");
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const [r, gr, b] = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return "rgb(" + r + ", " + gr + ", " + b + ")";
    })()`);
  } finally {
    await p.close();
  }
}

describe.skipIf(!browser)("captureShots", () => {
  it("captures each variant on each device at its size, beside the version, without changing the manifest; the prototype server serves them", async () => {
    const dir = writeVersion(studio, "sa-1", 1, { "a/index.html": page("a.css"), "a/a.css": fill(RED), "b/index.html": page("b.css"), "b/b.css": fill(BLUE) }, { ...TWO_VARIANTS, devices: ["desktop", "mobile", "terminal"] });
    const manifest = readFileSync(join(dir, "manifest.json"));

    const outcome = await captureShots({ studioDir: studio, artifactId: "sa-1", version: 1 });

    expect(outcome).toEqual({
      shots: [
        { variant: "a", device: "desktop", path: "shots/a-desktop.png" },
        { variant: "a", device: "mobile", path: "shots/a-mobile.png" },
        { variant: "b", device: "desktop", path: "shots/b-desktop.png" },
        { variant: "b", device: "mobile", path: "shots/b-mobile.png" },
      ],
      failed: [],
    });
    expect(readdirSync(join(dir, "shots")).sort()).toEqual(["a-desktop.png", "a-mobile.png", "b-desktop.png", "b-mobile.png"]);
    const shot = (name: string) => readFileSync(join(dir, "shots", name));
    expect(pngSize(shot("a-desktop.png"))).toEqual({ width: 1280, height: 800 });
    expect(pngSize(shot("b-mobile.png"))).toEqual({ width: 1170, height: 2532 });
    expect(await centre(shot("a-mobile.png"))).toBe(RED);
    expect(await centre(shot("b-desktop.png"))).toBe(BLUE);
    expect(readFileSync(join(dir, "manifest.json")).equals(manifest)).toBe(true);

    const server = createPrototypeServer({ studioDir: () => studio, appOrigins: ["http://127.0.0.1:5319"] });
    const port = await listen(server);
    const served = await get(port, `p-sa-1-v1.localhost:${port}`, "/shots/b-mobile.png");
    await close(server);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.body.equals(shot("b-mobile.png"))).toBe(true);
  }, 60_000);

  it("gives up on a page that never finishes loading, and still captures the others", async () => {
    writeVersion(studio, "sa-2", 1, { "a/index.html": '<script src="spin.js"></script>', "a/spin.js": "while (true) {}", "b/index.html": page("b.css"), "b/b.css": fill(BLUE) }, { ...TWO_VARIANTS, devices: ["desktop"] });
    const logged: string[] = [];
    const started = Date.now();

    const outcome = await captureShots({ studioDir: studio, artifactId: "sa-2", version: 1, timeoutMs: 3000, log: (m) => logged.push(m) });

    expect(Date.now() - started).toBeLessThan(30_000);
    expect(outcome).toEqual({ shots: [{ variant: "b", device: "desktop", path: "shots/b-desktop.png" }], failed: [{ variant: "a", device: "desktop", error: expect.stringContaining("Timeout 3000ms exceeded") }] });
    expect(existsSync(join(versionDir(studio, "sa-2", 1), "shots", "a-desktop.png"))).toBe(false);
    expect(logged).toEqual([expect.stringContaining("Screenshot of sa-2 v1 a on desktop failed: ")]);
  }, 60_000);

  it("lets a page reach nothing but its own origin, even by navigating", async () => {
    outside = createServer((req, res) => {
      outsideRequests.push(req.url ?? "");
      res.end("outside");
    });
    const ext = `http://127.0.0.1:${await listen(outside)}`;
    const files = {
      "a/index.html": page("a.css", '<script src="leak.js"></script>'),
      "a/a.css": fill(RED),
      "a/leak.js": `fetch("${ext}/fetch").catch(() => {}); new Image().src = "${ext}/image"; navigator.sendBeacon("${ext}/beacon", "x");`,
      "b/index.html": page("b.css", '<script src="away.js"></script>'),
      "b/b.css": fill(BLUE),
      "b/away.js": `location.href = "${ext}/navigate";`,
    };
    writeVersion(studio, "sa-3", 1, files, { ...TWO_VARIANTS, devices: ["desktop"] });

    const outcome = await captureShots({ studioDir: studio, artifactId: "sa-3", version: 1 });

    expect(outcome).toEqual({ shots: [{ variant: "a", device: "desktop", path: "shots/a-desktop.png" }, { variant: "b", device: "desktop", path: "shots/b-desktop.png" }], failed: [] });
    expect(await centre(readFileSync(join(versionDir(studio, "sa-3", 1), "shots", "a-desktop.png")))).toBe(RED);
    expect(outsideRequests).toEqual([]);
  }, 60_000);

  // Outside any page policy and request interception (pass 3 review, finding 3). The page holds its load event for 5 s
  // while it tries. Without the flags, the same capture sends STUN packets and looks up the STUN server's name (checked
  // 2026-10-02); escape.test.ts shows each way out from a Chrome without them, and none from one with them.
  it.skipIf(!lanAddress())("gives a page no WebRTC, DNS prefetch or preconnect: nothing reaches the network, no name is looked up", async () => {
    const lan = lanAddress()!;
    const listeners = await outsideListeners();
    const tag = randomBytes(4).toString("hex");
    writeVersion(studio, "sa-5", 1, { "a/index.html": outsidePage(lan, listeners, tag, 5000) }, { devices: ["desktop"] });
    const netLog = join(root, "netlog.json");
    const chrome = chromeWritingNetLog(root, netLog);
    const before = process.env.CHROME_PATH;
    if (chrome) process.env.CHROME_PATH = chrome;
    const logged: string[] = [];
    try {
      const outcome = await captureShots({ studioDir: studio, artifactId: "sa-5", version: 1, log: (m) => logged.push(m) });
      expect(outcome).toEqual({ shots: [{ variant: "a", device: "desktop", path: "shots/a-desktop.png" }], failed: [] });
    } finally {
      if (before === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = before;
      await listeners.close();
    }
    expect(listeners.hits()).toEqual([]);
    if (chrome) {
      // No host name of the page was looked up: the resolver answered none of them, and no DNS query went out.
      const looked = netLogHosts(netLog, tag);
      expect(Object.values(looked).flat().filter((e) => /DNS_TRANSACTION|HOST_RESOLVER_SYSTEM_TASK|HOST_RESOLVER_DNS_TASK/.test(e))).toEqual([]);
    } else process.stderr.write("Not checked: the DNS lookups, which need Chrome's network log (no Chrome at its install path or CHROME_PATH).\n");
  }, 60_000);

  it("writes nothing through a shots/ that is a link", async () => {
    const dir = writeVersion(studio, "sa-4", 1, { "a/index.html": page("a.css"), "a/a.css": fill(RED) }, { devices: ["desktop"] });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, "shots"));

    const outcome = await captureShots({ studioDir: studio, artifactId: "sa-4", version: 1 });

    expect(outcome).toEqual({ shots: [], failed: [{ variant: "a", device: "desktop", error: "shots/ is not a folder." }] });
    expect(readdirSync(elsewhere)).toEqual([]);
  }, 60_000);
});

describe("captureShots without screenshots to take", () => {
  it("says so when there is no Chrome", async () => {
    writeVersion(studio, "sa-5", 1, { "a/index.html": "<p>x</p>" });
    const saved = process.env.CHROME_PATH;
    process.env.CHROME_PATH = join(root, "no-chrome-here");
    try {
      expect(await captureShots({ studioDir: studio, artifactId: "sa-5", version: 1 })).toEqual({ skipped: "no Chrome found" });
    } finally {
      if (saved === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = saved;
    }
    expect(existsSync(join(versionDir(studio, "sa-5", 1), "shots"))).toBe(false);
  });

  it("takes none of a terminal artifact, and none without a manifest", async () => {
    writeVersion(studio, "sa-6", 1, { "demo.tape": "Type hello" }, { kind: "terminal-demo", devices: ["terminal"], variants: [{ id: "a", label: "A", entry: "demo.tape" }] });
    expect(await captureShots({ studioDir: studio, artifactId: "sa-6", version: 1 })).toEqual({ shots: [], failed: [] });
    expect(existsSync(join(versionDir(studio, "sa-6", 1), "shots"))).toBe(false);
    expect(await captureShots({ studioDir: studio, artifactId: "sa-7", version: 1 })).toEqual({ skipped: "no manifest for sa-7 v1" });
  });
});
