// ORC-029 pass 5, the "Capture evidence" step, for real: where Docker runs and the recorder's image (tag 2) is built,
// a tiny fixture repository (a static page served by a two-line Node server, and a Node CLI) is installed, previewed
// and captured, and the PNGs and the GIF come back; a hostile page and a hostile CLI reach neither the network nor this
// computer, their install hooks never run although the install has the network, and the files they plant do not come
// back; a preview that does not start says so. Skipped, with the reason, without Docker or the image.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMAGE_TABLE, environmentPlan, environmentSource, parseDevcontainer, type EnvironmentPlan } from "../../src/domain/environment";
import { DEFAULT_INSTALL, type CaptureItem, type ItemCapture } from "../../src/domain/studio/evidence";
import type { CheckRunReport } from "../checks";
import { removeTree } from "../environment/copy";
import { EnvironmentChecks } from "../environment/runner";
import type { AdapterEvent } from "../runtimes/types";
import { RECORDER_IMAGE, defaultRecorderRoot, dockerEnv, dockerReady, runDocker } from "./container";
import { captureEvidence } from "./evidence";
import { validateCast } from "./terminal";

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

// Unit E2 (docs/design/project-environment.md): the same step in each project's own environment. E1's Node, Python and
// Go fixtures are prepared through the egress proxy, then their page is served in their own image with no network and
// shot by the recorder's browser on the preview's loopback, and their CLI is typed into a terminal in their own image
// and recorded as an asciicast. The hostile fixture's preview, page and CLI try the internet, the Docker host and its
// gateway, Lima's name for this computer and this computer's loopback, where a canary listens.
const ENV_FIXTURES = resolve(__dirname, "../environment/fixtures");
const PAGE: CaptureItem = { itemId: "bi-1", kind: "screen", title: "Fixture page", artifactId: "sa-1", version: 1 };
const DEMO: CaptureItem = { itemId: "bi-2", kind: "terminal-demo", title: "Fixture CLI", artifactId: "sa-2", version: 1 };

describe(`capturing evidence in the project's environment${skipReason}`, () => {
  const TEST_ID = `evtest-${Math.random().toString(36).slice(2, 8)}`;
  let envRoot = "";
  let lender: EnvironmentChecks;
  const row = (label: string) => IMAGE_TABLE.find((r) => r.label === label)!;
  const settingPlan = (label: string, prepare: string[][]): EnvironmentPlan => environmentPlan(environmentSource(undefined, { rev: 1, image: row(label).image, prepare, hosts: [] }).source!, { rev: 1, prepare, hosts: [] });
  const envContainersLeft = () => (ready.ok ? execFileSync(ready.docker, ["ps", "--all", "--filter", `name=orc-env-`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n").filter((n) => n.startsWith(`orc-env-preview-${process.pid}-`) || n.startsWith(`orc-env-session-${process.pid}-`)) : []);

  beforeEach(() => {
    if (!ready.ok || envRoot) return;
    // Under the home folder: Colima shares only it with its VM.
    envRoot = mkdtempSync(join(homedir(), ".cache", "orchestrator-env-e2-test-"));
    lender = new EnvironmentChecks({ root: envRoot, fallback: () => ({ start: () => { throw new Error("handed to the host sandbox"); } }) as never, log: (m) => console.log(m) });
  });
  afterEach(() => {
    // Nothing a capture made stays behind: its stage folders and its containers are gone.
    expect(readdirSync(ROOT)).toEqual([]);
    expect(containersLeft()).toBe("");
    expect(envContainersLeft()).toEqual([]);
  });
  afterAll(async () => {
    if (!ready.ok) return;
    const denv = dockerEnv(process.env);
    const images = await runDocker(ready.docker, ["images", "--format", "{{.Repository}}:{{.Tag}}"], { env: denv, timeoutMs: 30_000 });
    const ours = images.stdout.split("\n").filter((x) => x.startsWith(`orc-env-${TEST_ID}-`));
    if (ours.length) await runDocker(ready.docker, ["image", "rm", ...ours], { env: denv, timeoutMs: 120_000 });
    if (envRoot) removeTree(envRoot);
  });

  /** One fixture captured in its environment: its page on desktop, and its CLI's tape. */
  async function capture(fixture: string, plan: EnvironmentPlan, preview: string[], o: { extra?: Record<string, string>; startMs?: number; settleMs?: number } = {}) {
    const out = join(dir, "evidence");
    const t0 = Date.now();
    const r = await captureEvidence({
      source: change(join(ENV_FIXTURES, fixture), o.extra),
      sha: SHA,
      items: [PAGE, DEMO],
      preview: { rev: 1, install: [], preview, port: 8000 },
      outDir: out,
      root: ROOT,
      environment: { plan, project: `${TEST_ID}-${fixture}` },
      lender,
      attemptId: `ev-${fixture}-${Math.random().toString(36).slice(2, 8)}`,
      limits: { startMs: o.startMs ?? 120_000, ...(o.settleMs ? { settleMs: o.settleMs } : {}) },
      log: (m) => console.log(m),
    });
    const prep = r.path?.via === "environment" ? r.path.prepare : "?";
    timings.push(`${fixture} in its environment ${((Date.now() - t0) / 1000).toFixed(1)} s (prepare ${prep})`);
    return { r, out };
  }
  /** The page came back as a 1280×800 PNG; the CLI as a valid asciicast v2 and its transcript. */
  function expectCaptured(r: Awaited<ReturnType<typeof capture>>, cast: string, transcript: string) {
    const page = captured(r.r.items[0]);
    expect(page.files.map((f) => [f.path, f.type, f.device])).toEqual([["bi-1/desktop.png", "png", "desktop"]]);
    expect(pngSize(join(r.out, "bi-1/desktop.png"))).toEqual({ width: 1280, height: 800 });
    const cli = captured(r.r.items[1]);
    expect(cli.files.map((f) => [f.path, f.type])).toEqual([
      [`bi-2/${cast}`, "cast"],
      [`bi-2/${transcript}`, "txt"],
    ]);
    expect(cli.warnings).toBeUndefined();
    const castText = readFileSync(join(r.out, "bi-2", cast), "utf8");
    expect(validateCast(castText, 2)).toMatchObject({ ok: true });
    return { page, cli, castText, transcript: readFileSync(join(r.out, "bi-2", transcript), "utf8") };
  }

  it.skipIf(!ready.ok)(
    "Node, from its dev container: its page (served on 127.0.0.1 with ms) and its CLI in a terminal",
    async () => {
      const found = { file: ".devcontainer/devcontainer.json", parsed: parseDevcontainer(readFileSync(join(ENV_FIXTURES, "node/.devcontainer/devcontainer.json"), "utf8"), ".devcontainer/devcontainer.json") };
      const plan = environmentPlan(environmentSource(found, undefined).source!, { rev: 1, prepare: [["npm", "ci"]], hosts: [] });
      const c = await capture("node", plan, ["node", "server.js"]);
      expect(c.r.path).toMatchObject({ via: "environment", from: "devcontainer", prepare: "ran", imageId: expect.stringMatching(/^sha256:/) });
      const got = expectCaptured(c, "demo.cast", "demo.txt");
      expect(got.transcript).toContain("> node bin/cli.js 2d");
      expect(got.transcript).toContain("2d is 172800000 ms (stdout is a terminal, 80 columns)");
      // The recording has its timing: the output arrives after the typing.
      const events = got.castText.trim().split("\n").slice(1).map((l) => JSON.parse(l) as [number, string, string]);
      expect(events.length).toBeGreaterThan(5);
      expect(events.at(-1)![0]).toBeGreaterThan(0.5);
    },
    900_000,
  );

  it.skipIf(!ready.ok)(
    "reuses what the checks prepared, by its key; a preview that ends says so at once, with its log",
    async () => {
      // E1's checks first, on the same project and the same prepare inputs.
      const plan = settingPlan("Node", [["npm", "ci"]]);
      const project = `${TEST_ID}-reuse`;
      const workspace = change(join(ENV_FIXTURES, "node"));
      const id = "chk-reuse";
      const checks = await new Promise<AdapterEvent>((res) => {
        const off = lender.onEvent((e) => {
          if (e.attemptId !== id || (e.type !== "completed" && e.type !== "failed" && e.type !== "stopped")) return;
          off();
          res(e);
        });
        lender.start({ attemptId: id, taskId: "T1", stepId: "C1", workspace, target: SHA, commands: [{ id: "test", label: "npm test", kind: "check", argv: ["npm", "test"], timeoutMs: 600_000 }], runTimeoutMs: 1_500_000, sandbox: "none", prepareNetwork: true, env: {}, tmpDir: join(dir, "chk.tmp"), cacheDir: join(dir, "chk.cache"), logDir: join(dir, "chk.logs"), environment: { plan, project } });
      });
      if (checks.type !== "completed") throw new Error(JSON.stringify(checks).slice(0, 400));
      const record = (checks.checks as CheckRunReport).environment as { prepare: string; key: string };
      expect(record.prepare).toBe("ran");

      const out = join(dir, "evidence");
      const t0 = Date.now();
      const r = await captureEvidence({ source: workspace, sha: SHA, items: [PAGE], preview: { rev: 1, install: [], preview: ["node", "missing-server.js"], port: 8000 }, outDir: out, root: ROOT, environment: { plan, project }, lender, attemptId: "ev-reuse" });
      timings.push(`a preview that ends, in its environment ${((Date.now() - t0) / 1000).toFixed(1)} s (prepare reused)`);
      expect(r.path).toMatchObject({ via: "environment", prepare: "reused", key: record.key });
      expect(r.items).toEqual([{ ...PAGE, status: "none", reason: "preview-did-not-start", detail: "The preview command ended (exit 1) before port 8000 opened.", log: expect.stringMatching(/Cannot find module '\/work\/missing-server\.js'/) }]);
      // Well within the 60 s wait for the port.
      expect(Date.now() - t0).toBeLessThan(45_000);
      expect(listed(out)).toEqual([]);
    },
    900_000,
  );

  it.skipIf(!ready.ok)(
    "Python, from the confirmed image: its page (pytest from PyPI) and its CLI in a terminal",
    async () => {
      const c = await capture("python", settingPlan("Python", [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]]), ["python3", "serve.py"]);
      expect(c.r.path).toMatchObject({ via: "environment", from: "setting", image: row("Python").image });
      const got = expectCaptured(c, "demo.cast", "demo.txt");
      expect(got.transcript).toContain("> python3 cli.py 2 3");
      expect(got.transcript).toMatch(/2 \+ 3 = 5 \(pytest 8\.3\.5; stdout is a terminal, 100 columns\)/);
    },
    900_000,
  );

  it.skipIf(!ready.ok)(
    "Go, from the confirmed image: its page (go run, with go-cmp) and a CLI it builds in the recording",
    async () => {
      const c = await capture("go", settingPlan("Go", [["go", "mod", "download"]]), ["go", "run", "./cmd/web"], { startMs: 300_000 });
      expect(c.r.path).toMatchObject({ via: "environment", from: "setting", image: row("Go").image });
      const got = expectCaptured(c, "demo.cast", "demo.txt");
      expect(got.transcript).toContain("> go build -o /tmp/calc ./cmd/calc && /tmp/calc 2 3");
      expect(got.transcript).toContain("2 + 3 = 5 (go-cmp says equal to 5: true)");
    },
    1_200_000,
  );

  it.skipIf(!ready.ok)(
    "the hostile fixture: its preview, its page and its CLI reach neither the internet, the Docker host nor this computer; the canary sees nothing",
    async () => {
      let hits = 0;
      const canary = await new Promise<Server>((res) => {
        const s = createServer((c) => {
          hits++;
          c.destroy();
        });
        s.listen(0, "127.0.0.1", () => res(s));
      });
      try {
        const port = (canary.address() as { port: number }).port;
        // The control: a container on Docker's ordinary network does reach the canary, so a leak would show.
        const control = `const s=require("node:net").connect(${port},"host.lima.internal");s.on("connect",()=>{console.log("CONNECTED");s.destroy()});s.on("error",(e)=>console.log(e.code))`;
        const reached = execFileSync(ready.ok ? ready.docker : "docker", ["run", "--rm", "--pull", "never", "--network", "bridge", "--user", "10001:10001", RECORDER_IMAGE, "/usr/local/bin/node", "-e", control], { encoding: "utf8", timeout: 60_000 }).trim();
        await new Promise((r) => setTimeout(r, 200));
        expect({ reached, hits }).toEqual({ reached: "CONNECTED", hits: 1 });
        hits = 0;

        const c = await capture("hostile", settingPlan("Node", [["npm", "ci"]]), ["node", "hostile.js", "preview"], { extra: { "canary.json": JSON.stringify({ canary: port }) }, settleMs: 5000 });
        expect(hits).toBe(0);
        const page = captured(c.r.items[0]);
        expect(page.files.map((f) => f.path)).toEqual(["bi-1/desktop.png"]);
        const warning = (prefix: string) => page.warnings?.find((w) => w.includes(prefix)) ?? "";
        const probes = warning("PROBES");
        console.log(`hostile page: ${probes}`);
        for (const url of ["http://1.1.1.1/", `http://192.168.5.2:${port}/`, `http://host.lima.internal:${port}/`, `http://host.docker.internal:${port}/`, `http://127.0.0.1:${port}/`]) expect(probes).toContain(`${url} blocked`);
        expect(probes).toMatch(/webrtc no srflx/);
        expect(probes).not.toMatch(/REACHED/);
        const refused = /^(ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)$/;
        const preview = JSON.parse(/HOSTILE (\{.*\})/.exec(warning("HOSTILE"))![1]) as Record<string, string>;
        console.log(`hostile preview: ${JSON.stringify(preview)}`);
        const cliText = readFileSync(join(c.out, "bi-2/hostile.txt"), "utf8");
        const cli = JSON.parse(/HOSTILE (\{.*\})/.exec(cliText)![1]) as Record<string, string>;
        console.log(`hostile CLI: ${JSON.stringify(cli)}`);
        for (const [what, r] of [["preview", preview], ["cli", cli]] as const) {
          expect(r.phase, what).toBe(what);
          for (const k of ["directOutside", "directHostAddress", "directDockerBridge", "directHostGateway", "directLima", "ownLoopback", "dnsOutside"]) expect(r[k], `${what} ${k}`).toMatch(refused);
        }
        expect(cli.terminal).toBe("a terminal");
        expect(captured(c.r.items[1]).files.map((f) => f.path)).toEqual(["bi-2/hostile.cast", "bi-2/hostile.txt"]);
        expect(listed(c.out)).toEqual(["bi-1/desktop.png", "bi-2/hostile.cast", "bi-2/hostile.txt"]);
      } finally {
        canary.close();
      }
    },
    900_000,
  );
});
