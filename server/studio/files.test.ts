// GET /api/studio/file (ORC-029 pass 3): the app's own origin serves a studio version's plain text, screenshots and
// recordings, so the studio can show them while the prototype server is down, and nothing that could run there.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGNER, sha } from "../../src/domain/testing/studio";
import { createHttpServer } from "../http";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { ScriptedAdapter } from "../testing/scripted";
import { projectStudioDir } from "./serve";
import { TINY_PNG, writeVersion } from "./testFixtures";

const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
const CAST = '{"version": 3, "term": {"cols": 80, "rows": 24}}\n[0.5, "o", "trips plan\\r\\n"]\n';

let dir: string;
let store: Store;
let scheduler: Scheduler;
let base = "";
let close: () => void = () => {};
let key = 0;
let artifactId = "";
const now = () => new Date(Date.parse("2026-10-02T09:00:00Z") + key * 1000).toISOString();
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, now());
const file = (path: string, version = 1, id = artifactId, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/studio/file?artifact=${encodeURIComponent(id)}&version=${version}&path=${encodeURIComponent(path)}`, { headers });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orc029-files-"));
  const dataDir = join(dir, "data");
  store = new Store(join(dataDir, "db.sqlite"));
  scheduler = new Scheduler(store, { claude: new ScriptedAdapter("claude"), codex: new ScriptedAdapter("codex") }, { leaseMs: 60_000 });
  cmd("initProject", { name: "Trips", repoPath: join(dir, "repo"), vision: "Weekend trips.", focus: "" });
  const n = (cmd("openRound", { focus: "experience" }).result as { n: number }).n;
  // A terminal demo version as the studio records it, and its folder as the import and the service's media wrote it.
  const files: Record<string, string | Buffer> = {
    "a/demo.cast": CAST,
    "a/plan.ans": "Weekend trips\n",
    "a/notes.txt": "Hand-written notes.\n",
    "a/interface.md": "# Interface\n\n`plan(trip)`\n",
    "a/topology.mmd": "graph LR\n  app --> api\n",
    "a/demo.tape": "Output demo.gif\n",
    "a/index.html": "<script>fetch('/api/state')</script>",
    "a/app.js": "fetch('/api/state')",
    "a/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    "a/style.css": "body {}",
    "a/fake.png": "not a png",
  };
  const added = cmd("addStudioArtifact", {
    round: n,
    kind: "screen",
    title: "trips",
    variants: [{ id: "a", label: "A", entry: "a/index.html" }],
    files: Object.keys(files).map((path) => ({ path, sha256: sha("a") })),
    devices: ["desktop"],
    madeBy: DESIGNER,
  }).result as { artifactId: string };
  artifactId = added.artifactId;
  const studioDir = projectStudioDir(dataDir, store.read().state.project.id)!;
  const folder = writeVersion(studioDir, artifactId, 1, files, { devices: ["desktop"], variants: [{ id: "a", label: "A", entry: "a/index.html" }] });
  mkdirSync(join(folder, "shots"), { recursive: true });
  writeFileSync(join(folder, "shots", "a-desktop.png"), TINY_PNG);
  mkdirSync(join(folder, "recording", "a"), { recursive: true });
  writeFileSync(join(folder, "recording", "a", "demo.gif"), GIF);
  writeFileSync(join(folder, "recording", "a", "demo.webm"), WEBM);
  writeFileSync(join(folder, "recording", "a", "demo.txt"), "trips plan\nWeekend trips from Lisbon\n");
  writeFileSync(join(folder, "recording", "a", "bad.gif"), "<html>not a gif</html>");
  // A version folder no recorded version names (an import that did not commit): never served.
  writeVersion(studioDir, artifactId, 2, { "a/demo.cast": CAST }, { variants: [{ id: "a", label: "A", entry: "a/demo.cast" }] });

  const probe = createHttpServer({ store, scheduler, startedAt: now(), allowedHosts: [] });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  const server = createHttpServer({ store, scheduler, startedAt: now(), allowedHosts: [`127.0.0.1:${port}`], dataDir });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
  close = () => {
    server.closeAllConnections();
    server.close();
  };
});
afterEach(async () => {
  close();
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const GUARD = { "x-content-type-options": "nosniff", "cache-control": "no-store", "content-security-policy": "default-src 'none'; sandbox" };
const headersOf = (r: Response) => ({ "x-content-type-options": r.headers.get("x-content-type-options"), "cache-control": r.headers.get("cache-control"), "content-security-policy": r.headers.get("content-security-policy") });

describe("GET /api/studio/file", () => {
  it("serves a version's text (.txt, .ans, .cast, .md, .mmd) as plain text, and its screenshots and recordings by their first bytes, with nosniff and no-store", async () => {
    for (const [path, type, body] of [
      ["a/demo.cast", "text/plain; charset=utf-8", CAST],
      ["a/plan.ans", "text/plain; charset=utf-8", "Weekend trips\n"],
      ["a/notes.txt", "text/plain; charset=utf-8", "Hand-written notes.\n"],
      // A document artifact's Markdown and Mermaid, as plain UTF-8 text: the app renders them, nothing runs here.
      ["a/interface.md", "text/plain; charset=utf-8", "# Interface\n\n`plan(trip)`\n"],
      ["a/topology.mmd", "text/plain; charset=utf-8", "graph LR\n  app --> api\n"],
      ["recording/a/demo.txt", "text/plain; charset=utf-8", "trips plan\nWeekend trips from Lisbon\n"],
    ] as const) {
      const r = await file(path);
      expect([path, r.status, r.headers.get("content-type")]).toEqual([path, 200, type]);
      expect(headersOf(r)).toEqual(GUARD);
      expect(await r.text()).toBe(body);
    }
    for (const [path, type, bytes] of [
      ["shots/a-desktop.png", "image/png", TINY_PNG],
      ["recording/a/demo.gif", "image/gif", GIF],
      ["recording/a/demo.webm", "video/webm", WEBM],
    ] as const) {
      const r = await file(path);
      expect([path, r.status, r.headers.get("content-type")]).toEqual([path, 200, type]);
      expect(headersOf(r)).toEqual(GUARD);
      expect(Buffer.from(await r.arrayBuffer()).equals(bytes)).toBe(true);
    }
  });

  it("never serves a page, a script or an SVG from the app's origin, even one the version lists", async () => {
    for (const path of ["a/index.html", "a/app.js", "a/logo.svg"]) {
      const r = await file(path);
      expect([path, r.status, r.headers.get("content-type")]).toEqual([path, 403, "application/json; charset=utf-8"]);
      expect(headersOf(r)).toEqual(GUARD);
      expect(((await r.json()) as { error: string }).error).toMatch(/never served from the app's origin/);
    }
  });

  it("serves nothing else: other types, bytes that are not what their name says, files the version does not list, a version not recorded, paths out of the folder", async () => {
    const notFound = [
      file("a/style.css"),
      file("a/demo.tape"),
      file("a/fake.png"),
      file("recording/a/bad.gif"),
      file("a/missing.cast"),
      file("shots/b-desktop.png"),
      file("shots/a-mobile.png"),
      file("a/demo.cast", 2),
      file("a/demo.cast", 1, "sa-999"),
      file("../../../db.sqlite.txt"),
      file("a/../a/demo.cast"),
      file("manifest.json"),
    ];
    for (const r of await Promise.all(notFound)) {
      expect([r.url, r.status]).toEqual([r.url, 404]);
      expect(headersOf(r)).toEqual(GUARD);
    }
    expect((await fetch(`${base}/api/studio/file?artifact=${artifactId}&path=a%2Fdemo.cast`)).status).toBe(400);
    expect((await fetch(`${base}/api/studio/file?artifact=${artifactId}&version=0&path=a%2Fdemo.cast`)).status).toBe(400);
  });

  it("is refused to other sites, like every API read", async () => {
    const r = await file("a/demo.cast", 1, artifactId, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
  });
});
