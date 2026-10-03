// The checks in the project's own environment (docs/design/project-environment.md, unit E1). A CheckRunner like the
// host sandboxes (server/checks.ts), for runs whose assignment carries an environment:
//
//   1. Docker, and a probe of the setup on this machine (once per service): without them, the run goes to the host
//      sandbox with the reason, as before the environment existed.
//   2. The image: the dev container's (pulled, or built from its Dockerfile with no network for RUN steps) or the one
//      the owner confirmed (pulled by digest).
//   3. A copy of the worktree without .git, in a folder Docker can mount.
//   4. Prepare, once per prepare key (the image, the prepare commands, the hosts and the prepare inputs' hashes): the
//      project's setup commands on a private network whose only way out is the egress proxy. What they add to the copy
//      is kept, and a later commit with the same key reuses it instead of preparing again.
//   5. Run: each check command in its own container with no network, on that copy. The test report is read from the
//      copy after the checks ran; a report there before them is removed first.
//
// One environment run at a time in this service: the Docker VM may have 2 CPUs and 2 GB.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvironmentRunRecord } from "../../src/domain/environment";
import type { ChecksHealth } from "../../src/domain/types";
import { BaseChecks, OUTPUT_CAP, notRun, resultOf, type Captured, type CheckAssignment, type CheckRunner, type PlannedCheck, type Run } from "../checks";
import { redact } from "../redact";
import { dockerEnv, findDocker, runDocker, startContainer } from "../studio/container";
import { clearReport, readTestReport } from "../testReport";
import { addedEntries, cloneEntries, copyWorktree, listTree, prepareInputs, prepareKey, removeTree } from "./copy";
import { MOUNTABLE, PROXY_IMAGE, PROXY_PORT, buildArgs, commitArgs, envName, networkArgs, phaseArgs, proxyArgs } from "./docker";

export const defaultEnvironmentRoot = () => join(homedir(), ".cache", "orchestrator", "environment");
export const PROXY_SCRIPT = readFileSync(new URL("./egress-proxy.mjs", import.meta.url), "utf8");

const PREPARE_TIMEOUT_MS = 15 * 60_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Prepared copies kept per project, newest first. */
const KEEP_PREPARED = 3;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";

/** Environment runs go one at a time in this process. */
let queue: Promise<void> = Promise.resolve();
function turn(): Promise<() => void> {
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const before = queue;
  queue = before.then(() => mine);
  return before.then(() => release);
}

/** Networks and detached containers this process made; removed when it exits (a crash leaves them labelled). */
const LIVE = new Map<string, { docker: string; env: Record<string, string>; kind: "container" | "network" }>();
let exitHook = false;
function remember(name: string, docker: string, env: Record<string, string>, kind: "container" | "network") {
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const [n, d] of [...LIVE].sort((x, y) => (x[1].kind === y[1].kind ? 0 : x[1].kind === "container" ? -1 : 1))) spawnSync(d.docker, d.kind === "container" ? ["rm", "--force", n] : ["network", "rm", n], { env: d.env, stdio: "ignore", timeout: 5000 });
    });
  }
  LIVE.set(name, { docker, env, kind });
}

type Ready = { ok: true; docker: string } | { ok: false; reason: string };

interface Dirs {
  /** The project's folder under the root; its cache folder (mounted at /cache) and its prepared copies. */
  project: string;
  cache: string;
  prepared: string;
  /** This run's folder: the copy (work) and the Dockerfile text, removed after the run. */
  run: string;
  work: string;
}

/** What the probe's client container saw, as it printed it. */
export interface EnvProbeFacts {
  outside: string;
  host: string;
  dns: string;
  proxyOutside: string;
  proxyLoopback: string;
  proxyHost: string;
}

/** Run inside the probe's client container (on the private network) by the Node image's node; it only looks. */
const PROBE_CLIENT = `"use strict";
const net = require("node:net"), dns = require("node:dns");
const input = JSON.parse(process.argv[1]);
const tcp = (h, p) => new Promise((r) => { const s = net.connect(p, h); const t = setTimeout(() => { s.destroy(); r("TIMEOUT"); }, 3000); s.on("connect", () => { clearTimeout(t); s.destroy(); r("CONNECTED"); }); s.on("error", (e) => { clearTimeout(t); r(e.code || "ERROR"); }); });
const via = (target) => new Promise((r) => { const s = net.connect(input.port, input.proxy); let b = ""; const t = setTimeout(() => { s.destroy(); r("TIMEOUT"); }, 6000); s.on("connect", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\n\\r\\n")); s.on("data", (d) => { b += d; const i = b.indexOf("\\r\\n"); if (i >= 0) { clearTimeout(t); s.destroy(); r(b.slice(0, i)); } }); s.on("error", (e) => { clearTimeout(t); r(e.code || "ERROR"); }); });
const lookup = (h) => new Promise((r) => dns.lookup(h, (e, a) => r(e ? e.code : "RESOLVED " + a)));
(async () => {
  const f = { outside: await tcp("1.1.1.1", 443), host: await tcp("orchestrator-host", input.canary), dns: await lookup("example.com"), proxyOutside: await via("example.com:443"), proxyLoopback: await via("127.0.0.1:" + input.canary), proxyHost: await via("orchestrator-host:" + input.canary) };
  console.log(JSON.stringify({ orchestratorEnvProbe: 1, ...f }));
})();
`;

const REFUSED = new Set(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "EACCES", "EPERM", "EADDRNOTAVAIL", "ENOTFOUND", "EAI_AGAIN"]);

/** Judge the probe: the private network reaches nothing but the proxy, and the proxy refuses what is not a registry. */
export function judgeEnvProbe(f: EnvProbeFacts, canaryHits: number): string | undefined {
  if (!REFUSED.has(f.outside)) return `a container on the private network reached the internet directly (1.1.1.1:443 ${f.outside})`;
  if (!REFUSED.has(f.host) || canaryHits > 0) return `a container on the private network reached this computer (the host gateway: ${f.host}; ${canaryHits} connection(s) to the canary)`;
  if (f.dns.startsWith("RESOLVED")) return `a container on the private network resolved an outside name (${f.dns})`;
  for (const [what, v] of [["example.com", f.proxyOutside], ["this computer's loopback", f.proxyLoopback], ["the host gateway", f.proxyHost]] as const) {
    if (!v.startsWith("HTTP/1.1 403")) return `the proxy did not refuse ${what} (${v})`;
  }
  return undefined;
}

export class EnvironmentChecks extends BaseChecks {
  readonly simulated = false;
  private readonly root: string;
  private readonly fallback: (a: CheckAssignment) => CheckRunner;
  private readonly dockerPath?: string;
  private probed?: Promise<Ready>;

  constructor(o: { fallback: (a: CheckAssignment) => CheckRunner; root?: string; docker?: string; log?: (msg: string) => void; env?: NodeJS.ProcessEnv }) {
    super(o);
    this.fallback = o.fallback;
    this.root = o.root ?? defaultEnvironmentRoot();
    this.dockerPath = o.docker;
  }

  private get denv() {
    return dockerEnv(this.baseEnv);
  }

  /** The host sandboxes' probe: this runner has none of its own; its setup probe runs before its first run. */
  async probe(sandbox: "codex" | "none"): Promise<ChecksHealth> {
    return { sandbox, status: "unavailable", detail: "The environment runner has no host sandbox.", checkedAt: new Date().toISOString() };
  }

  /** Docker is running, and the setup probe passed (once per service; a failure is checked again next time). */
  ready(): Promise<Ready> {
    return (async (): Promise<Ready> => {
      const docker = this.dockerPath ?? findDocker(this.baseEnv);
      if (!docker || !existsSync(docker)) return { ok: false, reason: "Docker is not installed (no docker command on PATH)" };
      const v = await runDocker(docker, ["version", "--format", "{{.Server.Version}}"], { env: this.denv, timeoutMs: 20_000 });
      if (v.code !== 0 || !v.stdout.trim()) return { ok: false, reason: `Docker is not running${v.stderr.trim() ? `: ${v.stderr.trim().split("\n").pop()!.slice(0, 160)}` : ""}` };
      if (!this.probed) {
        this.probed = this.probeSetup(docker).then((why): Ready => (why ? { ok: false, reason: `the environment's network did not pass its probe: ${why}` } : { ok: true, docker }));
        void this.probed.then((r) => {
          if (!r.ok) this.probed = undefined;
        });
      }
      return this.probed;
    })();
  }

  /** Hand a run to the host sandbox, with the reason it did not run in its environment. */
  private handOff(run: Run, reason: string) {
    const a: CheckAssignment = { ...run.a, environment: undefined, hostReason: reason };
    run.done = true;
    this.clearTimers(run);
    this.runs.delete(a.attemptId);
    this.cleanup(run);
    this.log(`checks: ${a.attemptId} runs in the host sandbox: ${reason}`);
    this.emit({ type: "activity", attemptId: a.attemptId, note: `Running on this computer: ${reason}`.slice(0, 200) });
    this.fallback(a).start(a);
  }

  protected async drive(run: Run): Promise<void> {
    const { a } = run;
    const release = await turn();
    try {
      if (run.done) return;
      if (run.stopRequested) return this.finish(run, { type: "stopped", attemptId: a.attemptId, how: "interrupted" });
      const up = await this.ready();
      if (run.done) return;
      if (!up.ok) return this.handOff(run, up.reason);
      this.timer(run, () => {
        if (run.done) return;
        run.current?.();
        this.finish(run, { type: "failed", attemptId: a.attemptId, message: `Checks reached their ${Math.round(a.runTimeoutMs / 60_000)}-minute time limit.` });
      }, a.runTimeoutMs);
      await this.inEnvironment(run, up.docker);
    } catch (e) {
      this.finish(run, { type: "failed", attemptId: a.attemptId, message: redact(e instanceof Error ? e.message : String(e), this.baseEnv).slice(0, 300) });
    } finally {
      release();
    }
  }

  protected exec(): Promise<Captured> {
    throw new Error("the environment runner drives its own commands");
  }

  private dirs(project: string, attemptId: string): Dirs {
    const p = join(this.root, project.replace(/[^A-Za-z0-9._-]/g, "_"));
    const run = join(p, "runs", attemptId.replace(/[^A-Za-z0-9._-]/g, "_"));
    return { project: p, cache: join(p, "cache"), prepared: join(p, "prepared"), run, work: join(run, "work") };
  }

  private async inEnvironment(run: Run, docker: string): Promise<void> {
    const { a } = run;
    const env = a.environment!;
    const d = this.dirs(env.project, a.attemptId);
    for (const dir of [join(d.cache, "xdg"), d.prepared, d.run]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!MOUNTABLE.test(d.work) || !MOUNTABLE.test(d.cache)) return this.handOff(run, `Docker cannot mount ${JSON.stringify(d.run)}`);
    (run as Run & { stage?: string }).stage = d.run;
    copyWorktree(a.workspace, d.work);
    const image = await this.image(docker, run, d);
    if (run.done) return;
    if ("refused" in image) return this.handOff(run, image.refused);
    const before = listTree(d.work);
    const key = prepareKey({ imageId: image.id, prepare: env.plan.prepare, hosts: env.plan.hosts, inputs: prepareInputs(d.work, before) });
    const prepCmds: PlannedCheck[] = env.plan.prepare.map((argv, i) => ({ id: `env-prepare-${i + 1}`, label: `Prepare: ${argv.join(" ")}`.slice(0, 60), kind: "prepare", argv, timeoutMs: PREPARE_TIMEOUT_MS }));
    const from = env.plan.source.from;
    const t0 = Date.now();
    let record: EnvironmentRunRecord;
    // The run phase runs on the prepared image: the base image plus what the prepare wrote outside the copy.
    let runImage = image.id;
    const tag = `orc-env-${slug(env.project)}:${key}`;
    const reuse = prepCmds.length ? await this.preparedOf(docker, d, key, tag) : undefined;
    if (run.done) return;
    if (reuse) {
      cloneEntries(join(d.prepared, key, "copy"), d.work, reuse.added);
      runImage = reuse.imageId;
      for (const c of prepCmds) run.results.push({ ...notRun(c), status: "passed", excerpt: `Reused what the prepare made for ${reuse.sha.slice(0, 12)}: the same image, prepare commands, hosts and prepare inputs.` });
      record = { ran: "container", from, image: image.ref, imageId: image.id, prepare: "reused", key, reusedFrom: reuse.sha, prepareMs: 0 };
      this.emit({ type: "activity", attemptId: a.attemptId, note: `Reused the prepare of ${reuse.sha.slice(0, 12)} (${image.ref})`.slice(0, 200) });
    } else {
      const out = prepCmds.length ? await this.preparePhase(run, docker, image.id, d, prepCmds) : { ok: true, refused: [] as string[], imageId: image.id };
      if (run.done) return;
      if (run.stopRequested) return this.finish(run, { type: "stopped", attemptId: a.attemptId, how: "interrupted" });
      if (out.ok && out.imageId) runImage = out.imageId;
      if (out.ok && out.imageId && prepCmds.length) await this.savePrepared(docker, d, key, tag, out.imageId, before, a.target);
      record = { ran: "container", from, image: image.ref, imageId: image.id, prepare: out.ok ? "ran" : "failed", key, prepareMs: Date.now() - t0, ...(out.refused.length ? { refused: out.refused } : {}) };
      if (!out.ok) {
        for (const c of a.commands) if (c.kind === "check") run.results.push(notRun(c));
        return this.finish(run, { type: "completed", attemptId: a.attemptId, finalText: "", checks: { sha: a.target, results: run.results, durationMs: Date.now() - run.startedAt, sandbox: a.sandbox, environment: record } });
      }
    }
    // The run phase. A report the change or its prepare left in the copy never counts: it goes before the checks run.
    const reportRefused = a.testReport ? clearReport(d.work, a.testReport) : undefined;
    for (const c of a.commands) {
      if (c.kind !== "check") continue;
      if (run.done || run.stopRequested) break;
      this.emit({ type: "activity", attemptId: a.attemptId, note: `Running ${c.label} (${c.argv.join(" ")}) in the project's environment, with no network`.slice(0, 200) });
      const t1 = Date.now();
      const cap = await this.execIn(run, docker, phaseArgs({ name: envName("run"), image: runImage, work: d.work, argv: c.argv, phase: { kind: "run" } }), c.timeoutMs);
      if (run.done) return;
      if (run.stopRequested || cap.ended) break;
      run.results.push(resultOf(c, cap, Date.now() - t1, this.baseEnv, a.logDir, a.attemptId));
    }
    if (run.stopRequested) return this.finish(run, { type: "stopped", attemptId: a.attemptId, how: "interrupted" });
    const tests = a.testReport ? (reportRefused ? { status: "refused" as const, path: a.testReport, reason: reportRefused } : readTestReport(a.testReport, { workspace: d.work, scratch: [], env: this.baseEnv })) : undefined;
    if (tests) this.emit({ type: "activity", attemptId: a.attemptId, note: `Test report ${tests.path}: ${tests.status === "read" ? `${tests.counts.passed} passed, ${tests.counts.failed + tests.counts.error} failed, ${tests.counts.skipped} skipped` : tests.reason}`.slice(0, 200) });
    this.finish(run, { type: "completed", attemptId: a.attemptId, finalText: "", checks: { sha: a.target, results: run.results, durationMs: Date.now() - run.startedAt, sandbox: a.sandbox, ...(tests ? { tests } : {}), environment: record } });
  }

  /** The run's stage goes when the run ends, however it ends. */
  protected cleanup(run: Run): void {
    const stage = (run as Run & { stage?: string }).stage;
    if (!stage) return;
    (run as Run & { stage?: string }).stage = undefined;
    try {
      removeTree(stage);
    } catch (e) {
      this.log(`checks: could not remove ${stage}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** One container of a phase, to its end: its exit code and the end of its output. A stop request or its limit ends it. */
  private async execIn(run: Run, docker: string, args: string[], timeoutMs: number): Promise<Captured> {
    const name = args[args.indexOf("--name") + 1];
    const c = startContainer(docker, args, { env: this.denv, name, cap: OUTPUT_CAP });
    let timedOut = false;
    let ended = false;
    run.current = () => {
      ended = true;
      void c.stop();
    };
    const t = setTimeout(() => {
      timedOut = true;
      void c.stop();
    }, timeoutMs);
    const r = await c.done;
    clearTimeout(t);
    run.current = undefined;
    if (r.code !== 0) await c.remove();
    return { exitCode: r.code ?? undefined, stdout: r.output, stderr: "", timedOut, capped: r.output.length >= OUTPUT_CAP, ended };
  }

  /** Make sure an image is here: inspect it, else pull it. Its id, or undefined with Docker's words. */
  private async ensureImage(docker: string, ref: string): Promise<{ id: string } | { error: string }> {
    const inspect = () => runDocker(docker, ["image", "inspect", "--format", "{{.Id}}", ref], { env: this.denv, timeoutMs: 30_000 });
    let i = await inspect();
    if (i.code !== 0 || !i.stdout.trim()) {
      const p = await runDocker(docker, ["pull", ref], { env: this.denv, timeoutMs: PULL_TIMEOUT_MS });
      if (p.code !== 0) return { error: (p.stderr.trim() || p.stdout.trim()).split("\n").pop()!.slice(0, 200) || `exit ${p.code}` };
      i = await inspect();
    }
    const id = i.stdout.trim();
    return id.startsWith("sha256:") ? { id } : { error: "Docker did not report the image's id" };
  }

  /** The image of the run: pulled as named, or built from the dev container's Dockerfile (its text from the trusted base). */
  private async image(docker: string, run: Run, d: Dirs): Promise<{ ref: string; id: string } | { refused: string }> {
    const env = run.a.environment!;
    const src = env.plan.source;
    if ("image" in src) {
      this.emit({ type: "activity", attemptId: run.a.attemptId, note: `Using the image ${src.image}`.slice(0, 200) });
      const r = await this.ensureImage(docker, src.image);
      return "id" in r ? { ref: src.image, id: r.id } : { refused: `the image ${src.image} could not be pulled: ${r.error}` };
    }
    if (env.dockerfile === undefined) return { refused: `${src.file} names the Dockerfile ${src.build.dockerfile}, which could not be read at the trusted base` };
    // The context is a real folder of the copy, never a link out of it.
    let p = d.work;
    for (const seg of src.build.context === "." ? [] : src.build.context.split("/")) {
      p = join(p, seg);
      if (!existsSync(p) || !lstatSync(p).isDirectory()) return { refused: `${src.file}: build.context ${src.build.context} is not a folder of the repository` };
    }
    const file = join(d.run, "Dockerfile");
    writeFileSync(file, env.dockerfile, { mode: 0o600 });
    const tag = `orc-env-${slug(env.project)}:${createHash("sha256").update(env.dockerfile).digest("hex").slice(0, 16)}`;
    this.emit({ type: "activity", attemptId: run.a.attemptId, note: `Building ${src.file}'s Dockerfile (no network for its RUN steps)`.slice(0, 200) });
    const b = await runDocker(docker, buildArgs({ tag, dockerfile: file, context: p }), { env: this.denv, timeoutMs: BUILD_TIMEOUT_MS });
    if (b.code !== 0) return { refused: `${src.file}'s Dockerfile did not build: ${(b.stderr.trim() || b.stdout.trim()).split("\n").slice(-2).join(" ").slice(0, 240)}` };
    const r = await this.ensureImage(docker, tag);
    return "id" in r ? { ref: tag, id: r.id } : { refused: r.error };
  }

  /**
   * What an earlier prepare with this key made, when it is all still here: the entries it added to its copy (with the
   * commit it ran for) and its image, tagged by the key.
   */
  private async preparedOf(docker: string, d: Dirs, key: string, tag: string): Promise<{ sha: string; added: string[]; imageId: string } | undefined> {
    let meta: { sha?: unknown; added?: unknown; key?: unknown };
    try {
      meta = JSON.parse(readFileSync(join(d.prepared, key, "meta.json"), "utf8")) as typeof meta;
    } catch {
      return undefined;
    }
    if (meta.key !== key || typeof meta.sha !== "string" || !Array.isArray(meta.added) || !meta.added.every((x) => typeof x === "string")) return undefined;
    const i = await runDocker(docker, ["image", "inspect", "--format", "{{.Id}}", tag], { env: this.denv, timeoutMs: 30_000 });
    const imageId = i.stdout.trim();
    if (i.code !== 0 || !imageId.startsWith("sha256:")) return undefined;
    return { sha: meta.sha, added: meta.added as string[], imageId };
  }

  /**
   * Keep what the prepare made, for later commits with the same key: the entries it added to the copy, and its image
   * under the key's tag. Then keep only the newest few of both. Never fails the run.
   */
  private async savePrepared(docker: string, d: Dirs, key: string, tag: string, imageId: string, before: ReadonlySet<string>, sha: string) {
    const tmp = join(d.prepared, `.tmp-${key}-${randomBytes(4).toString("hex")}`);
    try {
      const t = await runDocker(docker, ["tag", imageId, tag], { env: this.denv, timeoutMs: 30_000 });
      if (t.code !== 0) throw new Error(`docker tag: ${t.stderr.trim().slice(0, 160)}`);
      const added = addedEntries(d.work, before);
      mkdirSync(join(tmp, "copy"), { recursive: true, mode: 0o700 });
      const kept = cloneEntries(d.work, join(tmp, "copy"), added);
      writeFileSync(join(tmp, "meta.json"), JSON.stringify({ key, sha, added: kept, at: new Date().toISOString() }), { mode: 0o600 });
      if (existsSync(join(d.prepared, key))) removeTree(tmp);
      else renameSync(tmp, join(d.prepared, key));
      const all = readdirSync(d.prepared)
        .filter((n) => /^[0-9a-f]{16}$/.test(n))
        .map((n) => ({ n, at: statSync(join(d.prepared, n)).mtimeMs }))
        .sort((x, y) => y.at - x.at);
      for (const old of all.slice(KEEP_PREPARED)) {
        removeTree(join(d.prepared, old.n));
        await runDocker(docker, ["image", "rm", `${tag.split(":")[0]}:${old.n}`], { env: this.denv, timeoutMs: 60_000 });
      }
    } catch (e) {
      this.log(`checks: the prepare was not kept for reuse: ${e instanceof Error ? e.message : String(e)}`);
      try {
        removeTree(tmp);
      } catch {
        /* nothing more to do */
      }
    }
  }

  /** The networks and the proxy of one prepare phase (or the probe); `stop` removes all of them and returns the proxy's decisions. */
  private async startEgress(docker: string, hosts: string[]): Promise<{ privateNet: string; proxy: string; stop: () => Promise<string[]> } | { error: string }> {
    const privateNet = envName("net");
    const egressNet = envName("out");
    const proxy = envName("proxy");
    const made: string[] = [];
    const decisions: string[] = [];
    const stop = async () => {
      const logs = await runDocker(docker, ["logs", proxy], { env: this.denv, timeoutMs: 15_000, cap: 256_000 });
      decisions.push(...`${logs.stdout}\n${logs.stderr}`.split("\n").filter((l) => l.startsWith('{"orchestratorProxy":1')));
      await runDocker(docker, ["rm", "--force", proxy], { env: this.denv, timeoutMs: 15_000 });
      LIVE.delete(proxy);
      for (const n of made) {
        await runDocker(docker, ["network", "rm", n], { env: this.denv, timeoutMs: 15_000 });
        LIVE.delete(n);
      }
      return decisions;
    };
    for (const [n, kind] of [[privateNet, "private"], [egressNet, "egress"]] as const) {
      const r = await runDocker(docker, networkArgs(n, kind), { env: this.denv, timeoutMs: 30_000 });
      if (r.code !== 0) {
        await stop();
        return { error: `could not make the ${kind} network: ${r.stderr.trim().split("\n").pop()?.slice(0, 160) ?? ""}` };
      }
      made.push(n);
      remember(n, docker, this.denv, "network");
    }
    const img = await this.ensureImage(docker, PROXY_IMAGE);
    if ("error" in img) {
      await stop();
      return { error: `the proxy's image could not be pulled: ${img.error}` };
    }
    remember(proxy, docker, this.denv, "container");
    const started = await runDocker(docker, proxyArgs({ name: proxy, privateNet, egressNet, hosts, script: PROXY_SCRIPT }), { env: this.denv, timeoutMs: 60_000 });
    if (started.code !== 0) {
      await stop();
      return { error: `the proxy did not start: ${started.stderr.trim().split("\n").pop()?.slice(0, 160) ?? ""}` };
    }
    for (let i = 0; i < 75; i++) {
      const logs = await runDocker(docker, ["logs", proxy], { env: this.denv, timeoutMs: 10_000 });
      if (logs.stdout.includes('"listening"')) return { privateNet, proxy, stop };
      await new Promise((r) => setTimeout(r, 200));
    }
    await stop();
    return { error: "the proxy did not start listening within 15 s" };
  }

  /** The prepare phase: each setup command in its own container on the private network, through the proxy, in order. */
  private async preparePhase(run: Run, docker: string, baseImage: string, d: Dirs, cmds: PlannedCheck[]): Promise<{ ok: boolean; refused: string[]; imageId?: string }> {
    const { a } = run;
    const egress = await this.startEgress(docker, a.environment!.plan.hosts);
    if ("error" in egress) {
      run.results.push({ ...notRun(cmds[0]), status: "failed", excerpt: `The prepare phase could not start: ${egress.error}` });
      for (const c of cmds.slice(1)) run.results.push(notRun(c));
      return { ok: false, refused: [] };
    }
    let ok = true;
    // Each command runs on the image the one before it left; the last image is the prepared image.
    let imageId = baseImage;
    const logs: string[] = [];
    try {
      for (const c of cmds) {
        if (run.done || run.stopRequested) break;
        if (!ok) {
          run.results.push(notRun(c));
          continue;
        }
        this.emit({ type: "activity", attemptId: a.attemptId, note: `Preparing: ${c.argv.join(" ")} (the network goes only to the registries)`.slice(0, 200) });
        const t0 = Date.now();
        const name = envName("prep");
        const cap = await this.execIn(run, docker, phaseArgs({ name, image: imageId, work: d.work, cache: d.cache, argv: c.argv, phase: { kind: "prepare", privateNet: egress.privateNet, proxy: egress.proxy } }), c.timeoutMs);
        let r = resultOf(c, cap, Date.now() - t0, this.baseEnv, a.logDir, a.attemptId);
        if (cap.exitCode === 0 && !cap.ended && !run.done) {
          const committed = await runDocker(docker, commitArgs(name), { env: this.denv, timeoutMs: 10 * 60_000 });
          const id = committed.stdout.trim();
          if (committed.code === 0 && id.startsWith("sha256:")) imageId = id;
          else r = { ...r, status: "failed", excerpt: `The service could not keep what this command made (docker commit: ${committed.stderr.trim().slice(0, 200)}).\n${r.excerpt}` };
        }
        await runDocker(docker, ["rm", "--force", name], { env: this.denv, timeoutMs: 30_000 });
        if (run.done || run.stopRequested || cap.ended) break;
        run.results.push(r);
        if (r.status !== "passed") ok = false;
      }
    } finally {
      logs.push(...(await egress.stop()));
    }
    const refused = [...new Set(logs.flatMap((l) => {
      try {
        const x = JSON.parse(l) as { allowed?: boolean; host?: string; reason?: string };
        return x.allowed === false && x.host ? [`${x.host} (${x.reason ?? "refused"})`.slice(0, 120)] : [];
      } catch {
        return [];
      }
    }))].slice(0, 20);
    // The repair (and the owner) see what the proxy refused, next to the command that failed.
    const failed = run.results.find((r) => r.kind === "prepare" && r.status !== "passed" && r.status !== "not-run");
    if (failed && refused.length) failed.excerpt = `[The proxy refused: ${refused.join("; ")}. Add a host in Settings › Project › Environment if it is a registry.]\n${failed.excerpt}`;
    return { ok: ok && !run.stopRequested, refused, ...(ok ? { imageId } : {}) };
  }

  /**
   * The setup probe: the private network and the proxy, made as a prepare's are, with a client container in the
   * proxy's own image. It must reach nothing directly (the internet, the host gateway, a name outside), and the proxy
   * must refuse a host off the list, this computer's loopback and the host gateway. A canary on this computer's
   * loopback must see no connection. Undefined when all hold, else the first that does not.
   */
  async probeSetup(docker: string): Promise<string | undefined> {
    let hits = 0;
    const canary: Server = await new Promise((res, rej) => {
      const s = createServer((c) => {
        hits++;
        c.destroy();
      });
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => res(s));
    });
    const egress = await this.startEgress(docker, ["registry.npmjs.org"]);
    if ("error" in egress) {
      canary.close();
      return egress.error;
    }
    const tmp = join(this.root, ".probe", randomBytes(4).toString("hex"));
    try {
      mkdirSync(join(tmp, "work"), { recursive: true, mode: 0o700 });
      mkdirSync(join(tmp, "cache"), { recursive: true, mode: 0o700 });
      const name = envName("probe");
      const args = phaseArgs({ name, image: PROXY_IMAGE, work: join(tmp, "work"), cache: join(tmp, "cache"), argv: ["node", "-e", PROBE_CLIENT, JSON.stringify({ proxy: egress.proxy, port: PROXY_PORT, canary: (canary.address() as { port: number }).port })], phase: { kind: "prepare", privateNet: egress.privateNet, proxy: egress.proxy } });
      // Only the probe: a hosts entry for the host gateway, so it can show the host is out of reach.
      args.splice(args.indexOf("--workdir"), 0, "--add-host", "orchestrator-host:host-gateway");
      const r = await startContainer(docker, args, { env: this.denv, name, cap: 16_000 }).done;
      await runDocker(docker, ["rm", "--force", name], { env: this.denv, timeoutMs: 30_000 });
      const line = r.output.split("\n").reverse().find((l) => l.trim().startsWith('{"orchestratorEnvProbe":1'));
      if (!line) return `the probe printed no result (exit ${r.code ?? "?"}): ${r.output.trim().slice(-200)}`;
      return judgeEnvProbe(JSON.parse(line) as EnvProbeFacts, hits);
    } finally {
      await egress.stop();
      canary.close();
      removeTree(tmp);
    }
  }
}
