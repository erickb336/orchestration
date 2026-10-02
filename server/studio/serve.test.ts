// The prototype server over HTTP (ORC-029 pass 3, 3b): which hosts, paths and files it serves, and the headers on
// every answer. The escapes a hostile prototype attempts in a real browser are in escape.test.ts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServiceInfo } from "../../src/api";
import { acceptPinMessage } from "../../src/runtime/prototype";
import { createHttpServer } from "../http";
import { FakeAdapter, defaultFakeConfig } from "../runtimes/fake";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { createPrototypeServer, projectStudioDir } from "./serve";
import { TINY_PNG, close, get, listen, sha256, writeVersion } from "./testFixtures";

const APP = ["http://127.0.0.1:5319", "http://localhost:5319"];
const CSP = "default-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:5319 http://localhost:5319";
const PAGE = "<!doctype html><html><head><link rel=stylesheet href=style.css></head><body><h1>Trip plan</h1></body></html>";

let root: string;
let studio: string;
let server: Server | undefined;
let port: number;
let logged: string[];
const host = (artifact = "sa-1", v = 1) => `p-${artifact}-v${v}.localhost:${port}`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "orch-proto-"));
  studio = join(root, "studio", "p-test");
  logged = [];
  writeVersion(studio, "sa-1", 1, { "a/index.html": PAGE, "a/style.css": "h1 { color: teal }", "b/index.html": "<p>B</p>" }, { variants: [{ id: "a", label: "A", entry: "a/index.html" }, { id: "b", label: "B", entry: "b/index.html" }] });
  writeVersion(studio, "sa-1", 2, { "a/index.html": "<p>version 2</p>" });
  server = createPrototypeServer({ studioDir: () => studio, appOrigins: APP, log: (m) => logged.push(m) });
  port = await listen(server);
});

afterEach(async () => {
  await close(server);
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("the prototype server", () => {
  it("serves a listed file with its type, and every answer carries the policy, nosniff, no-store and no cookie", async () => {
    const css = await get(port, host(), "/a/style.css");
    expect(css.status).toBe(200);
    expect(css.body.toString()).toBe("h1 { color: teal }");
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    for (const r of [css, await get(port, host(), "/missing.css"), await get(port, "evil.example", "/a/style.css"), await get(port, host(), "/a/style.css", "POST")]) {
      expect(r.headers["content-security-policy"]).toBe(CSP);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("serves each version from its own hostname", async () => {
    expect((await get(port, host("sa-1", 2), "/a/index.html")).body.toString()).toContain("version 2");
    expect((await get(port, host("sa-1", 1), "/a/index.html")).body.toString()).toContain("Trip plan");
    expect((await get(port, host("sa-1", 2), "/a/style.css")).status).toBe(404);
  });

  it("refuses any other Host", async () => {
    const refused = [`127.0.0.1:${port}`, `localhost:${port}`, `p-sa-1-v1.localhost:${port + 1}`, "p-sa-1-v1.localhost", `p-sa-1-v1.localhost.evil.example:${port}`, `evil.example:${port}`, `p-sa-1-v0.localhost:${port}`, `p--v1.localhost:${port}`, ""];
    for (const h of refused) expect((await get(port, h, "/a/index.html")).status, h).toBe(403);
    expect((await get(port, host().toUpperCase(), "/a/style.css")).status).toBe(200);
  });

  it("adds the pin script to HTML pages, before </body>, and serves it as a script", async () => {
    const page = await get(port, host(), "/a/index.html");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body.toString()).toBe(PAGE.replace("</body>", '<script src="/__orchestrator/pin.js"></script></body>'));
    expect((await get(port, host(), "/b/index.html")).body.toString()).toBe('<p>B</p><script src="/__orchestrator/pin.js"></script>');
    const pin = await get(port, host(), "/__orchestrator/pin.js");
    expect(pin.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(pin.body.toString()).toContain('type: "orchestrator-pin"');
  });

  it("serves only files the manifest lists: no listing, no traversal, no unlisted file, not the manifest", async () => {
    const dir = join(studio, "artifacts", "sa-1", "v1");
    writeFileSync(join(dir, "a", "unlisted.js"), "alert(1)");
    writeVersion(studio, "sa-2", 1, { "a/secret.txt": "sibling secret" });
    for (const path of ["/", "/a", "/a/", "/manifest.json", "/a/unlisted.js", "/a/../../../sa-2/v1/a/secret.txt", "/a/%2e%2e/%2e%2e/%2e%2e/sa-2/v1/a/secret.txt", "/..%2f..%2f..%2fsa-2%2fv1%2fa%2fsecret.txt", "/a%2fstyle.css%00", "/%E0%A4%A"]) {
      const r = await get(port, host(), path);
      expect([400, 404], path).toContain(r.status);
      expect(r.body.toString()).not.toContain("sibling secret");
    }
  });

  it("refuses a file whose bytes no longer match the manifest's hash, and says so in the log", async () => {
    writeFileSync(join(studio, "artifacts", "sa-1", "v1", "a", "style.css"), "h1 { color: red }!");
    expect((await get(port, host(), "/a/style.css")).status).toBe(404);
    writeFileSync(join(studio, "artifacts", "sa-1", "v1", "a", "style.css"), "h1 { color: red }");
    expect((await get(port, host(), "/a/style.css")).status).toBe(404);
    expect(logged).toEqual(["Prototype sa-1 v1: a/style.css is missing or does not match its recorded hash; not served.", "Prototype sa-1 v1: a/style.css is missing or does not match its recorded hash; not served."]);
  });

  it("follows no symlink: not a listed file, not a folder inside the version, not the version folder", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "outside secret");
    // A listed file that is a link to a file outside, with the target's own hash.
    const dir = writeVersion(studio, "sa-3", 1, { "a/index.html": "<p>ok</p>" });
    symlinkSync(join(outside, "secret.txt"), join(dir, "a", "secret.txt"));
    // A folder inside the version that is a link.
    symlinkSync(outside, join(dir, "linked"));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.files.push({ path: "a/secret.txt", sha256: sha256("outside secret"), bytes: 14 }, { path: "linked/secret.txt", sha256: sha256("outside secret"), bytes: 14 });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    expect((await get(port, host("sa-3"), "/a/index.html")).status).toBe(200);
    expect((await get(port, host("sa-3"), "/a/secret.txt")).status).toBe(404);
    expect((await get(port, host("sa-3"), "/linked/secret.txt")).status).toBe(404);
    // The version folder itself is a link to another version's folder.
    mkdirSync(join(studio, "artifacts", "sa-4"), { recursive: true });
    const real = writeVersion(join(root, "elsewhere"), "sa-4", 1, { "a/index.html": "<p>elsewhere</p>" });
    symlinkSync(real, join(studio, "artifacts", "sa-4", "v1"));
    expect((await get(port, host("sa-4"), "/a/index.html")).status).toBe(404);
  });

  it("serves only the allowed types", async () => {
    writeVersion(studio, "sa-5", 1, { "a/index.html": "<p>x</p>", "a/run.sh": "rm -rf /", "a/page.php": "<?php ?>", "a/Font.WOFF2": "font", "a/shot.jpg": "jpg" });
    expect((await get(port, host("sa-5"), "/a/run.sh")).status).toBe(404);
    expect((await get(port, host("sa-5"), "/a/page.php")).status).toBe(404);
    expect((await get(port, host("sa-5"), "/a/Font.WOFF2")).headers["content-type"]).toBe("font/woff2");
    expect((await get(port, host("sa-5"), "/a/shot.jpg")).headers["content-type"]).toBe("image/jpeg");
  });

  it("serves a screenshot of a known variant and device as a PNG, and nothing else from shots/", async () => {
    const shots = join(studio, "artifacts", "sa-1", "v1", "shots");
    mkdirSync(shots);
    writeFileSync(join(shots, "a-desktop.png"), TINY_PNG);
    writeFileSync(join(shots, "b-mobile.png"), "<script>alert(1)</script>");
    writeFileSync(join(shots, "a-terminal.png"), TINY_PNG);
    writeFileSync(join(shots, "c-desktop.png"), TINY_PNG);
    writeFileSync(join(shots, "note.html"), "<p>hi</p>");
    const shot = await get(port, host(), "/shots/a-desktop.png");
    expect(shot.status).toBe(200);
    expect(shot.headers["content-type"]).toBe("image/png");
    expect(shot.body.equals(TINY_PNG)).toBe(true);
    for (const p of ["/shots/b-mobile.png", "/shots/a-terminal.png", "/shots/c-desktop.png", "/shots/note.html", "/shots/"]) expect((await get(port, host(), p)).status, p).toBe(404);
  });

  it("answers GET and HEAD only, and serves nothing without a studio folder or a manifest", async () => {
    expect((await get(port, host(), "/a/style.css", "POST")).status).toBe(405);
    const head = await get(port, host(), "/a/style.css", "HEAD");
    expect([head.status, head.body.length]).toEqual([200, 0]);
    expect((await get(port, host("sa-9"), "/a/index.html")).status).toBe(404);
    writeFileSync(join(studio, "artifacts", "sa-1", "v2", "manifest.json"), JSON.stringify({ artifactId: "sa-1", version: 3, files: [], variants: [], devices: [] }));
    expect((await get(port, host("sa-1", 2), "/a/index.html")).status).toBe(404);
    const none = createPrototypeServer({ studioDir: () => undefined, appOrigins: APP });
    const nonePort = await listen(none);
    expect((await get(nonePort, `p-sa-1-v1.localhost:${nonePort}`, "/a/style.css")).status).toBe(404);
    await close(none);
  });

  it("names a project's studio folder only for a safe project id", () => {
    expect(projectStudioDir("/data", "p-mf3k2")).toBe(join("/data", "studio", "p-mf3k2"));
    expect(projectStudioDir("/data", "../etc")).toBeUndefined();
  });
});

describe("acceptPinMessage", () => {
  const frame = { name: "the prototype frame" };
  const other = { name: "another window" };
  const pin = { type: "orchestrator-pin", x: 0.25, y: 1, selector: "main > button:nth-of-type(2)" };

  it("accepts the pin shape from that frame only", () => {
    expect(acceptPinMessage({ source: frame, data: pin }, frame)).toEqual({ type: "orchestrator-pin", x: 0.25, y: 1, selector: "main > button:nth-of-type(2)" });
    expect(acceptPinMessage({ source: other, data: pin }, frame)).toBeNull();
    expect(acceptPinMessage({ source: null, data: pin }, null)).toBeNull();
  });

  it("refuses anything else", () => {
    const refused: unknown[] = [
      "orchestrator-pin",
      null,
      [pin],
      { ...pin, type: "pin" },
      { ...pin, html: "<img src=x onerror=alert(1)>" },
      { type: "orchestrator-pin", x: 0.5, y: 0.5 },
      { ...pin, x: 1.5 },
      { ...pin, y: -0.1 },
      { ...pin, x: Number.NaN },
      { ...pin, x: "0.5" },
      { ...pin, selector: 42 },
      { ...pin, selector: "a".repeat(301) },
      { type: "orchestrator-command", name: "startFactory" },
    ];
    for (const data of refused) expect(acceptPinMessage({ source: frame, data }, frame), JSON.stringify(data)).toBeNull();
    expect(acceptPinMessage({ source: frame, data: { ...pin, selector: "a".repeat(300) } }, frame)?.selector).toHaveLength(300);
  });
});

describe("the service's state and health name the prototype listener's port", () => {
  it("while it listens, and not before or after", async () => {
    const store = new Store(join(root, "test.db"));
    const config = defaultFakeConfig();
    const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
    const prototypes = createPrototypeServer({ studioDir: () => studio, appOrigins: APP });
    // The app's port first: its allowed Host names it.
    const free = createPrototypeServer({ studioDir: () => undefined, appOrigins: APP });
    const appPort = await listen(free);
    await close(free);
    const app = createHttpServer({ store, scheduler, startedAt: new Date().toISOString(), allowedHosts: [`127.0.0.1:${appPort}`], prototypePort: appPort + 1, prototypeServer: prototypes });
    await new Promise<void>((r) => app.listen(appPort, "127.0.0.1", r));
    const service = async () => {
      const replies = await Promise.all(["/api/state", "/api/health"].map((p) => get(appPort, `127.0.0.1:${appPort}`, p)));
      return replies.map((r) => (JSON.parse(r.body.toString()) as { service: ServiceInfo }).service.prototypePort);
    };
    try {
      expect(await service()).toEqual([undefined, undefined]);
      const protoPort = await listen(prototypes);
      expect(await service()).toEqual([protoPort, protoPort]);
      await close(prototypes);
      expect(await service()).toEqual([undefined, undefined]);
    } finally {
      await close(app);
      await scheduler.stop();
      store.close();
    }
  });
});
