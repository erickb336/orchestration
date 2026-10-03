// The project environment, for real (unit E1): three tiny projects (Node, Python, Go) prepare through the egress proxy
// and run their tests with no network, each writing JUnit; a hostile project's install script and test try to reach a
// host that is not a registry, the Docker host and this computer's loopback, where a canary listens. Gated on Docker:
// skipped, with the reason, when it is not running. Pulls official images by digest the first time.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_TABLE, environmentPlan, environmentSource, type EnvironmentPlan, type EnvironmentRunRecord } from "../../src/domain/environment";
import { readDevcontainer } from "./devcontainer";
import type { CheckResult, TestReport } from "../../src/domain/types";
import type { CheckRunReport } from "../checks";
import type { AdapterEvent } from "../runtimes/types";
import { dockerEnv, findDocker, runDocker } from "../studio/container";
import { removeTree } from "./copy";
import { LABEL, PROXY_IMAGE, networkArgs } from "./docker";
import { EnvironmentChecks } from "./runner";
import { LEFTOVER_AGE_MS, PreparedEnvironments } from "./prepared";
import { Housekeeping, systemDocker, type DockerOps } from "../housekeeping";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const docker = findDocker(process.env);
const up = docker ? await runDocker(docker, ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv(process.env), timeoutMs: 20_000 }) : undefined;
const ready = !!up && up.code === 0 && !!up.stdout.trim();
const skipReason = ready ? "" : ` (skipped: ${docker ? "Docker is not running" : "Docker is not installed"})`;

const row = (label: string) => IMAGE_TABLE.find((r) => r.label === label)!;
const settingPlan = (label: string, prepare: string[][]): EnvironmentPlan => environmentPlan(environmentSource(undefined, { rev: 1, image: row(label).image, prepare, hosts: [] }).source!, { rev: 1, prepare, hosts: [] });

/** The tests' projects, so their prepared images (orc-env-<project>:<key>) can be removed afterwards, and only theirs. */
const TEST_ID = `envtest-${Math.random().toString(36).slice(2, 8)}`;
let root = "";
let scratch = "";
let runner: EnvironmentChecks;
let environments: PreparedEnvironments;
const timings: string[] = [];

beforeAll(() => {
  if (!ready) return;
  // Under the home folder: Colima shares only it with its VM.
  root = mkdtempSync(join(homedir(), ".cache", "orchestrator-env-test-"));
  scratch = mkdtempSync(join(tmpdir(), "orc-env-real-"));
  environments = new PreparedEnvironments({ root, log: (m) => console.log(m) });
  runner = new EnvironmentChecks({ environments, fallback: () => ({ start: () => { throw new Error("handed to the host sandbox"); } }) as never, log: (m) => console.log(m) });
});
afterAll(async () => {
  if (ready) {
    const images = await runDocker(docker!, ["images", "--format", "{{.Repository}}:{{.Tag}}"], { env: dockerEnv(process.env), timeoutMs: 30_000 });
    const ours = images.stdout.split("\n").filter((x) => x.startsWith(`orc-env-${TEST_ID}-`));
    if (ours.length) await runDocker(docker!, ["image", "rm", ...ours], { env: dockerEnv(process.env), timeoutMs: 120_000 });
  }
  if (root) removeTree(root);
  if (scratch) removeTree(scratch);
  if (timings.length) console.log(`environment timings:\n  ${timings.join("\n  ")}`);
});

/** Run one fixture through the runner, as the scheduler would: a copy of it is the worktree. */
async function run(fixture: string, plan: EnvironmentPlan, argv: string[], o: { project?: string; before?: (dir: string) => void; testReport?: string } = {}) {
  const id = `a-${fixture}-${Math.random().toString(36).slice(2, 8)}`;
  const workspace = join(scratch, id);
  cpSync(join(FIXTURES, fixture), workspace, { recursive: true });
  o.before?.(workspace);
  const events: AdapterEvent[] = [];
  const t0 = Date.now();
  const end = new Promise<AdapterEvent>((res) => {
    const off = runner.onEvent((e) => {
      if (e.attemptId !== id) return;
      events.push(e);
      if (e.type === "completed" || e.type === "failed" || e.type === "stopped") {
        off();
        res(e);
      }
    });
  });
  runner.start({
    attemptId: id, taskId: "T1", stepId: "C1", workspace, target: "f".repeat(40),
    commands: [{ id: "test", label: argv.join(" "), kind: "check", argv, timeoutMs: 10 * 60_000 }],
    runTimeoutMs: 25 * 60_000, sandbox: "codex", prepareNetwork: true, env: {}, tmpDir: join(scratch, `${id}.tmp`), cacheDir: join(scratch, `${id}.cache`), logDir: join(scratch, `${id}.logs`),
    testReport: o.testReport ?? "reports/junit.xml",
    environment: { plan, project: `${TEST_ID}-${o.project ?? fixture}` },
  });
  const e = await end;
  if (e.type !== "completed") throw new Error(`the run did not complete: ${JSON.stringify(e).slice(0, 600)}`);
  const report = e.checks as CheckRunReport;
  const env = report.environment as Extract<EnvironmentRunRecord, { ran: "container" }>;
  timings.push(`${fixture}: ${((Date.now() - t0) / 1000).toFixed(1)} s in all, prepare ${env.prepare} ${(env.prepareMs / 1000).toFixed(1)} s, image ${env.image}`);
  return { report, env, results: report.results as CheckResult[], tests: report.tests as TestReport | undefined, events };
}

const statuses = (rs: CheckResult[]) => rs.map((r) => `${r.id}:${r.status}`);
const read = (t: TestReport | undefined) => (t?.status === "read" ? t.counts : t);

describe(`the project environment, in Docker${skipReason}`, () => {
  it.skipIf(!ready)("proves its network on this machine before the first run", async () => {
    const t0 = Date.now();
    const r = await environments.ready();
    timings.push(`setup probe: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    expect(r).toMatchObject({ ok: true });
  }, 120_000);

  it.skipIf(!ready)("Node, from its dev container: npm ci through the proxy, the test with no network, JUnit; the next commit reuses the prepare", async () => {
    // Read as the scheduler reads it, and confirmed by its digest as the owner confirms it (review finding 3).
    const found = readDevcontainer((p) => (existsSync(join(FIXTURES, "node", p)) ? { text: readFileSync(join(FIXTURES, "node", p), "utf8"), truncated: false } : undefined))!;
    const setting = { rev: 1, prepare: [["npm", "ci"]], hosts: [], devcontainer: { file: found.file, sha256: found.sha256! } };
    const plan = environmentPlan(environmentSource(found, setting).source!, setting);
    expect(plan.source).toMatchObject({ from: "devcontainer", image: PROXY_IMAGE });
    const first = await run("node", plan, ["npm", "test"]);
    expect(statuses(first.results), first.results.map((r) => r.excerpt).join("\n")).toEqual(["env-prepare-1:passed", "test:passed"]);
    expect(first.env).toMatchObject({ ran: "container", from: "devcontainer", prepare: "ran" });
    expect(read(first.tests)).toMatchObject({ passed: 1, failed: 0 });
    // Another commit with the same lockfile: the prepared node_modules is reused, and nothing goes out.
    const second = await run("node", plan, ["npm", "test"], { before: (dir) => writeFileSync(join(dir, "README.md"), "another commit\n") });
    expect(second.env).toMatchObject({ prepare: "reused", key: first.env.key, prepareMs: 0 });
    expect(statuses(second.results)).toEqual(["env-prepare-1:passed", "test:passed"]);
    expect(read(second.tests)).toMatchObject({ passed: 1 });
  }, 600_000);

  it.skipIf(!ready)("Python, from the confirmed image: pip from PyPI through the proxy, pytest with no network, JUnit", async () => {
    const r = await run("python", settingPlan("Python", [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]]), ["python3", "-m", "pytest", "--junitxml=reports/junit.xml"]);
    expect(statuses(r.results), r.results.map((x) => x.excerpt).join("\n")).toEqual(["env-prepare-1:passed", "test:passed"]);
    expect(r.env).toMatchObject({ from: "setting", prepare: "ran" });
    expect(read(r.tests)).toMatchObject({ passed: 3, failed: 0 });
  }, 600_000);

  it.skipIf(!ready)("Go, from the confirmed image: go mod download through the proxy, gotestsum with no network, JUnit", async () => {
    const r = await run("go", settingPlan("Go", [["go", "mod", "download"]]), ["go", "tool", "gotestsum", "--junitfile", "reports/junit.xml"]);
    expect(statuses(r.results), r.results.map((x) => x.excerpt).join("\n")).toEqual(["env-prepare-1:passed", "test:passed"]);
    expect(read(r.tests)).toMatchObject({ passed: 1, failed: 0 });
  }, 900_000);

  describe("a hostile project", () => {
    let canary: Server;
    let hits = 0;
    beforeAll(async () => {
      if (!ready) return;
      canary = await new Promise<Server>((res) => {
        const s = createServer((c) => {
          hits++;
          c.destroy();
        });
        s.listen(0, "127.0.0.1", () => res(s));
      });
    });
    afterAll(() => canary?.close());

    it.skipIf(!ready)("cannot reach a host that is not a registry, the Docker host or this computer, in either phase; the canary sees nothing", async () => {
      const port = (canary.address() as { port: number }).port;
      // The control: a container on Docker's ordinary network does reach the canary (through the host gateway and at
      // the Mac's address) and the Docker VM's SSH port, so a leak to any of the hostile targets would show.
      const reach = (host: string, p: number) => `new Promise((r) => require("node:net").connect(${p}, "${host}").on("connect", function () { this.destroy(); r("CONNECTED") }).on("error", (e) => r(e.code)))`;
      const control = await runDocker(docker!, ["run", "--rm", "--add-host", "orchestrator-host:host-gateway", "--user", "10001:10001", "--entrypoint", "node", PROXY_IMAGE, "-e", `Promise.all([${reach("orchestrator-host", port)}, ${reach("192.168.5.2", port)}, ${reach("172.17.0.1", 22)}]).then((x) => console.log(x.join(" ")))`], { env: dockerEnv(process.env), timeoutMs: 60_000 });
      // The host gateway reaches the canary on every Docker. The Mac's address (192.168.5.2) and the VM's SSH port exist
      // only under Colima; on a Linux host 172.17.0.1 is the host itself, and its SSH port may be closed.
      const reached = control.stdout.trim().split(" ");
      expect(reached[0], control.stdout).toBe("CONNECTED");
      expect(hits).toBe(reached.slice(0, 2).filter((x) => x === "CONNECTED").length);
      hits = 0;
      // No route or no answer: a refusal (ECONNREFUSED) would mean a host answered.
      const unreachable = /^(ENETUNREACH|EHOSTUNREACH|TIMEOUT)$/;
      const unresolved = /^(EAI_AGAIN|ENOTFOUND)$/;

      // The change carries a report full of passes, and its install script plants another: neither may be read.
      const plant = (dir: string) => {
        writeFileSync(join(dir, "canary.json"), JSON.stringify({ canary: port }));
        mkdirSync(join(dir, "reports"), { recursive: true });
        writeFileSync(join(dir, "reports/junit.xml"), '<testsuites><testsuite name="carried" tests="9"><testcase name="carried pass" classname="carried"/></testsuite></testsuites>');
      };
      const r = await run("hostile", settingPlan("Node", [["npm", "ci"]]), ["npm", "test"], { before: plant });
      expect(r.tests).toMatchObject({ status: "missing", path: "reports/junit.xml" });
      const line = (phase: string) => {
        const text = r.results.map((x) => x.excerpt).join("\n");
        const m = new RegExp(`HOSTILE (\\{"phase":"${phase}".*\\})`).exec(text);
        if (!m) throw new Error(`no HOSTILE line for ${phase}: ${text.slice(0, 2000)}`);
        return JSON.parse(m[1]) as Record<string, string>;
      };
      const prep = line("prepare");
      console.log(`hostile prepare: ${JSON.stringify(prep)}`);
      for (const k of ["proxyNotRegistry", "proxyLoopback", "proxyLocalhost", "proxyHostGateway", "proxyHostAddress", "proxyRegistryPlainPort"]) expect(prep[k], k).toMatch(/^HTTP\/1\.1 403 /);
      for (const k of ["directOutside", "directHostAddress", "directDockerBridge"]) expect(prep[k], k).toMatch(unreachable);
      for (const k of ["directHostGateway", "dnsOutside"]) expect(prep[k], k).toMatch(unresolved);
      const runPhase = line("run");
      console.log(`hostile run: ${JSON.stringify(runPhase)}`);
      for (const k of ["directOutside", "directHostAddress", "directDockerBridge"]) expect(runPhase[k], k).toMatch(unreachable);
      for (const k of ["directHostGateway", "dnsOutside"]) expect(runPhase[k], k).toMatch(unresolved);
      expect(runPhase.proxyNotRegistry).toBe("NO PROXY");
      expect(r.env.refused?.join(" ")).toMatch(/example\.com \(not on the list of registries\)/);
      expect(r.env.refused?.join(" ")).toMatch(/127\.0\.0\.1 \(an IP address/);
      expect(hits).toBe(0);
    }, 600_000);
  });
});

// Housekeeping, for real (B-04): what a service that stopped mid-step leaves in Docker, found by the environment's
// label and removed; the owner's own container stays. The sweep sees only this test's objects, so it never touches
// another run's containers on this Docker.
describe(`housekeeping of the environment, in Docker${skipReason}`, () => {
  it.skipIf(!ready)("removes a labelled container and network whose service has gone, then its old work folder; leaves the owner's container", async () => {
    const env = dockerEnv(process.env);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let dead = 99_999;
    while (alive(dead)) dead--;
    const hex = Math.random().toString(16).slice(2, 12).padEnd(10, "0");
    const net = `orc-env-net-${dead}-${hex}`;
    const box = `orc-env-run-${dead}-${hex}`;
    const owner = `s2-owner-${hex}`;
    const mine = (name: string) => name.includes(hex);
    const home = mkdtempSync(join(scratch, "home-"));
    const envRoot = join(scratch, `hk-${hex}`);
    const folder = join(envRoot, "p1", "runs", "run-1");
    mkdirSync(join(folder, "work"), { recursive: true });
    writeFileSync(join(folder, "work", "f.txt"), "left by a stopped service");
    const old = (Date.now() - LEFTOVER_AGE_MS - 60_000) / 1000;
    utimesSync(folder, old, old);
    try {
      expect((await runDocker(docker!, networkArgs(net, "private"), { env, timeoutMs: 30_000 })).code).toBe(0);
      expect((await runDocker(docker!, ["create", "--name", box, "--label", `${LABEL}=run`, "--network", net, "--entrypoint", "/bin/true", PROXY_IMAGE], { env, timeoutMs: 30_000 })).code).toBe(0);
      expect((await runDocker(docker!, ["create", "--name", owner, "--entrypoint", "/bin/true", PROXY_IMAGE], { env, timeoutMs: 30_000 })).code).toBe(0);
      const real = systemDocker(process.env)!;
      const listed = await real.list();
      if ("unavailable" in listed) throw new Error(listed.unavailable);
      // Docker's own words, read: the label, and a time for each (a network's comes with fractions of a second).
      expect(listed.filter((t) => mine(t.name)).map((t) => [t.kind, t.name, t.environment])).toEqual([["container", box, "run"], ["network", net, "private"]]);
      for (const t of listed.filter((x) => mine(x.name))) expect(Math.abs(Date.now() - t.createdMs)).toBeLessThan(5 * 60_000);
      const only: DockerOps = {
        list: async () => {
          const l = await real.list();
          return "unavailable" in l ? l : l.filter((t) => mine(t.name));
        },
        remove: (t) => real.remove(t),
      };
      const r = await new Housekeeping({ home, env: {}, ownedFolders: [], ownerApps: () => false, ownerAppsAllowed: false, docker: only, environmentRoot: envRoot }).sweep("owner");
      expect(r).toMatchObject({ containers: 1, networks: 1, stages: 1, notes: [] });
      const after = await runDocker(docker!, ["ps", "--all", "--format", "{{.Names}}"], { env, timeoutMs: 30_000 });
      expect(after.stdout.split("\n").filter(mine)).toEqual([owner]);
      expect((await runDocker(docker!, ["network", "ls", "--format", "{{.Name}}"], { env, timeoutMs: 30_000 })).stdout.split("\n").filter(mine)).toEqual([]);
      expect(existsSync(folder)).toBe(false);
    } finally {
      await runDocker(docker!, ["rm", "--force", owner, box], { env, timeoutMs: 30_000 });
      await runDocker(docker!, ["network", "rm", net], { env, timeoutMs: 30_000 });
    }
  }, 120_000);
});
