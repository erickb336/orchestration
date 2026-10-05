// ORC-029 pass 5, the "Capture evidence" step, for real, in each project's own environment (unit E2; the only path
// since ORC-030 C3 removed the recorder's install): where Docker runs and the recorder's image (tag 2) is built, the
// Node, Python and Go fixtures are prepared through the egress proxy, their page is served in their own image with no
// network and shot by the recorder's browser, and their CLI is recorded as an asciicast; the hostile fixture reaches
// neither the network nor this computer; a preview that does not start says so; a built app that locks a folder in
// its copy does not stop the clean-up. Skipped, with the reason, without Docker or the image.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMAGE_TABLE, environmentPlan, environmentSource, type EnvironmentPlan } from "../../src/domain/environment";
import { readDevcontainer } from "../environment/devcontainer";
import type { CaptureItem, ItemCapture } from "../../src/domain/studio/evidence";
import type { CheckRunReport } from "../checks";
import { removeTree } from "../environment/copy";
import { EnvironmentChecks } from "../environment/runner";
import { PreparedEnvironments } from "../environment/prepared";
import type { AdapterEvent } from "../runtimes/types";
import { RECORDER_IMAGE, defaultRecorderRoot, dockerEnv, dockerReady, runDocker } from "./container";
import { captureEvidence } from "./evidence";
import { validateCast } from "./terminal";

const SHA = "0123456789abcdef0123456789abcdef01234567";

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
  let lender: PreparedEnvironments;
  let checks: EnvironmentChecks;
  const row = (label: string) => IMAGE_TABLE.find((r) => r.label === label)!;
  const settingPlan = (label: string, prepare: string[][]): EnvironmentPlan => environmentPlan(environmentSource(undefined, { rev: 1, image: row(label).image, prepare, hosts: [] }).source!, { rev: 1, prepare, hosts: [] });
  const envContainersLeft = () => (ready.ok ? execFileSync(ready.docker, ["ps", "--all", "--filter", `name=orc-env-`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n").filter((n) => n.startsWith(`orc-env-preview-${process.pid}-`) || n.startsWith(`orc-env-session-${process.pid}-`)) : []);

  beforeEach(() => {
    if (!ready.ok || envRoot) return;
    // Under the home folder: Colima shares only it with its VM.
    envRoot = mkdtempSync(join(homedir(), ".cache", "orchestrator-env-e2-test-"));
    lender = new PreparedEnvironments({ root: envRoot, log: (m) => console.log(m) });
    checks = new EnvironmentChecks({ environments: lender, fallback: () => ({ start: () => { throw new Error("handed to the host sandbox"); } }) as never, log: (m) => console.log(m) });
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
      preview: { rev: 1, preview, port: 8000 },
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
      // Read as the scheduler reads it, and confirmed by its digest as the owner confirms it (review finding 3).
      const found = readDevcontainer((p) => (existsSync(join(ENV_FIXTURES, "node", p)) ? { text: readFileSync(join(ENV_FIXTURES, "node", p), "utf8"), truncated: false } : undefined))!;
      const setting = { rev: 1, prepare: [["npm", "ci"]], hosts: [], devcontainer: { file: found.file, sha256: found.sha256! } };
      const plan = environmentPlan(environmentSource(found, setting).source!, setting);
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
      const checked = await new Promise<AdapterEvent>((res) => {
        const off = checks.onEvent((e) => {
          if (e.attemptId !== id || (e.type !== "completed" && e.type !== "failed" && e.type !== "stopped")) return;
          off();
          res(e);
        });
        checks.start({ attemptId: id, taskId: "T1", stepId: "C1", workspace, target: SHA, commands: [{ id: "test", label: "npm test", kind: "check", argv: ["npm", "test"], timeoutMs: 600_000 }], runTimeoutMs: 1_500_000, sandbox: "none", prepareNetwork: true, env: {}, tmpDir: join(dir, "chk.tmp"), cacheDir: join(dir, "chk.cache"), logDir: join(dir, "chk.logs"), environment: { plan, project } });
      });
      if (checked.type !== "completed") throw new Error(JSON.stringify(checked).slice(0, 400));
      const record = (checked.checks as CheckRunReport).environment as { prepare: string; key: string };
      expect(record.prepare).toBe("ran");

      const out = join(dir, "evidence");
      const t0 = Date.now();
      const r = await captureEvidence({ source: workspace, sha: SHA, items: [PAGE], preview: { rev: 1, preview: ["node", "missing-server.js"], port: 8000 }, outDir: out, root: ROOT, environment: { plan, project }, lender, attemptId: "ev-reuse" });
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
    "a built app that leaves a folder no one can read (mode 000) in its copy: the capture still ends, and its copy is gone",
    async () => {
      // The review's leak, moved from the recorder's stage to the environment's copy: the clean-up must not stop there.
      const lock = "const fs=require('node:fs');fs.mkdirSync('/work/locked/inner',{recursive:true});fs.writeFileSync('/work/locked/inner/f.txt','x');fs.chmodSync('/work/locked/inner',0);fs.chmodSync('/work/locked',0);process.exit(1);\n";
      const plan = settingPlan("Node", [["npm", "ci"]]);
      const project = `${TEST_ID}-reuse`;
      const out = join(dir, "evidence");
      const r = await captureEvidence({ source: change(join(ENV_FIXTURES, "node"), { "lock.js": lock }), sha: SHA, items: [PAGE], preview: { rev: 1, preview: ["node", "lock.js"], port: 8000 }, outDir: out, root: ROOT, environment: { plan, project }, lender, attemptId: "ev-lock" });
      expect(r.items.map((i) => [i.status, i.status === "none" ? i.reason : ""])).toEqual([["none", "preview-did-not-start"]]);
      expect(existsSync(join(envRoot, project, "runs", "ev-lock"))).toBe(false);
      // The afterEach checks that the stage folder and the containers are gone.
    },
    900_000,
  );

  it.skipIf(!ready.ok)(
    "each tape types into its own fresh copy of the change: a file one tape writes does not reach the next (ORC-032, U2-F1)",
    async () => {
      const src = join(dir, "change");
      mkdirSync(join(src, ".orchestrator"), { recursive: true });
      const tape = (cmd: string) => `Output demo.gif\nSet Shell bash\nSet Columns 80\nSet Rows 24\nType "${cmd}"\nEnter\nWait\nSleep 300ms\n`;
      writeFileSync(join(src, ".orchestrator", "first.tape"), tape("echo kept > left.txt && ls left.txt"));
      writeFileSync(join(src, ".orchestrator", "second.tape"), tape("ls left.txt"));
      writeFileSync(join(src, ".orchestrator", "capture.json"), JSON.stringify({ screens: [], terminals: [{ item: "bi-1", tape: ".orchestrator/first.tape" }, { item: "bi-2", tape: ".orchestrator/second.tape" }] }));
      const items: CaptureItem[] = [
        { ...DEMO, itemId: "bi-1", title: "First tape" },
        { ...DEMO, itemId: "bi-2", title: "Second tape", artifactId: "sa-3" },
      ];
      const out = join(dir, "evidence");
      const r = await captureEvidence({ source: src, sha: SHA, items, preview: { rev: 1 }, outDir: out, root: ROOT, environment: { plan: settingPlan("Python", []), project: `${TEST_ID}-tapes` }, lender, attemptId: "ev-tapes" });
      expect(r.items.map((i) => i.status)).toEqual(["captured", "captured"]);
      const transcript = (item: string) => readFileSync(join(out, item, "demo.txt"), "utf8");
      // The first tape wrote left.txt and lists it; the second, in a copy of its own, finds no such file.
      expect(transcript("bi-1")).toMatch(/^left\.txt$/m);
      expect(transcript("bi-2")).toContain("ls: cannot access 'left.txt': No such file or directory");
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
        // The control: a container on Docker's ordinary network does reach the canary and the Docker VM's SSH port
        // (172.17.0.1:22), so a leak to the hostile targets would show.
        const reach = (host: string, p: number) => `new Promise((r) => require("node:net").connect(${p}, "${host}").on("connect", function () { this.destroy(); r("CONNECTED") }).on("error", (e) => r(e.code)))`;
        const control = `Promise.all([${reach("host.lima.internal", port)}, ${reach("172.17.0.1", 22)}]).then((x) => console.log(x.join(" ")))`;
        const reached = execFileSync(ready.ok ? ready.docker : "docker", ["run", "--rm", "--pull", "never", "--network", "bridge", "--user", "10001:10001", RECORDER_IMAGE, "/usr/local/bin/node", "-e", control], { encoding: "utf8", timeout: 60_000 }).trim();
        await new Promise((r) => setTimeout(r, 200));
        expect({ reached, hits }).toEqual({ reached: "CONNECTED CONNECTED", hits: 1 });
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
        // No route or no answer: a refusal (ECONNREFUSED) would mean a host answered, except on the container's own
        // loopback, where nothing listens on the canary's port.
        const unreachable = /^(ENETUNREACH|EHOSTUNREACH|TIMEOUT)$/;
        const unresolved = /^(EAI_AGAIN|ENOTFOUND)$/;
        const preview = JSON.parse(/HOSTILE (\{.*\})/.exec(warning("HOSTILE"))![1]) as Record<string, string>;
        console.log(`hostile preview: ${JSON.stringify(preview)}`);
        // The transcript shows the terminal's rows: the CLI's one long line wraps at the tape's 120 columns.
        const cliText = readFileSync(join(c.out, "bi-2/hostile.txt"), "utf8").replace(/^(.{120})\n/gm, "$1");
        const cli = JSON.parse(/HOSTILE (\{.*\})/.exec(cliText)![1]) as Record<string, string>;
        console.log(`hostile CLI: ${JSON.stringify(cli)}`);
        for (const [what, r] of [["preview", preview], ["cli", cli]] as const) {
          expect(r.phase, what).toBe(what);
          for (const k of ["directOutside", "directHostAddress", "directDockerBridge"]) expect(r[k], `${what} ${k}`).toMatch(unreachable);
          for (const k of ["directHostGateway", "directLima", "dnsOutside"]) expect(r[k], `${what} ${k}`).toMatch(unresolved);
          expect(r.ownLoopback, `${what} ownLoopback`).toBe("ECONNREFUSED");
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
