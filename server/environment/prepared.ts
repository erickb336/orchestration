// The project's environment, made ready for a step (docs/design/project-environment.md): the setup probe, a copy of
// the change, the image, and the prepare or its reuse by key. Two steps run in it, and both use this module: the
// checks (runner.ts, a CheckRunner) and the capture of evidence (server/studio/evidence.ts).
//
//   1. Docker, and a probe of the setup on this machine (once per service): without them, nothing runs, with the reason.
//   2. The image: the dev container's (pulled, or built from its Dockerfile with no network for RUN steps) or the one
//      the owner confirmed (pulled by digest).
//   3. A copy of the worktree without .git, in a folder Docker can mount.
//   4. Prepare, once per prepare key (the image, the prepare commands, the hosts and the prepare inputs' hashes): the
//      project's setup commands on a private network whose only way out is the egress proxy. What they add to the copy
//      is kept, and a later commit with the same key reuses it instead of preparing again.
//   5. The step's own use of the copy (the checks' commands, the preview, the CLI sessions), then the copy goes.
//
// One environment run at a time in this service: the Docker VM may have 2 CPUs and 2 GB.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvironmentRunRecord } from "../../src/domain/environment";
import type { CheckResult } from "../../src/domain/types";
import { OUTPUT_CAP, notRun, resultOf, type Captured, type EnvironmentAssignment, type PlannedCheck } from "../checks";
import { dockerEnv, findDocker, runDocker, startContainer, waitGone } from "../studio/container";
import { addedEntries, cloneEntries, copyWorktree, listTree, prepareInputs, prepareKey, removeTree } from "./copy";
import { MOUNTABLE, PROXY_IMAGE, PROXY_PORT, PROXY_VARIABLES, buildArgs, commitArgs, envName, networkArgs, phaseArgs, proxyArgs } from "./docker";

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

export type Ready = { ok: true; docker: string } | { ok: false; reason: string };

/** The record of a step that ran in its environment. */
export type ContainerRecord = Extract<EnvironmentRunRecord, { ran: "container" }>;

/** What a step asks for: a copy of `workspace` (the change at `sha`), prepared in its environment. */
export interface PrepareRequest {
  attemptId: string;
  workspace: string;
  sha: string;
  environment: EnvironmentAssignment;
  /** Where the prepare commands' logs go. */
  logDir: string;
  /** Ends the step: the container in flight stops, and nothing more starts. */
  signal?: AbortSignal;
  /** Progress notes. */
  note?: (msg: string) => void;
  /** Called once the step has its turn and the setup probe passed: its own time limit starts here. */
  onReady?: () => void;
}

/** What a step gets: a copy of the change, prepared as the checks prepare it. */
export interface PreparedCopy {
  docker: string;
  /** The docker command's environment. */
  denv: Record<string, string>;
  /** The copy (to mount at /work), and the image to run on: the base image plus what the prepare wrote outside the copy. */
  work: string;
  image: string;
  /** The base image's own values of the proxy variables: a phase after the prepare restores them (phaseArgs' imageEnv). */
  imageEnv: Record<string, string>;
  record: ContainerRecord;
  /** One command in its own container with no network, on the prepared image and the copy (the checks' run phase). */
  run(argv: string[], timeoutMs: number): Promise<Captured>;
  /** A container of the step's own that mounts the copy: removed if this process exits before it does. */
  track(name: string): void;
  untrack(name: string): void;
}

export type PreparedOutcome<T> =
  | { ok: true; value: T; record: ContainerRecord; prepare: CheckResult[] }
  | { ok: false; reason: "unavailable" | "prepare-failed" | "stopped"; detail: string; log?: string; record?: ContainerRecord; prepare: CheckResult[] };

interface Dirs {
  /** The project's folder under the root; its cache folder (mounted at /cache) and its prepared copies. */
  project: string;
  cache: string;
  prepared: string;
  /** This step's folder: the copy (work) and the Dockerfile text, removed after the step. */
  run: string;
  work: string;
}

/** One step's use of the environment, from its copy to its clean-up. */
interface Session {
  req: PrepareRequest;
  docker: string;
  d?: Dirs;
  /** The prepare commands' results, in order. */
  results: CheckResult[];
  /** The step was stopped (its signal). */
  stopped: boolean;
  /** Ends the container in flight. */
  current?: () => void;
  /**
   * Every container that mounted the copy and may still run: the copy is not removed until Docker no longer lists
   * them, because a container that still runs can swap a folder of the copy for a link to this computer's files.
   */
  mounted: Set<string>;
  /** Why the copy must not be touched again: a container that mounts it did not go away. */
  unsafe?: string;
}

/** How long the clean-up waits for Docker to stop listing a container it removed. */
const GONE_WITHIN_MS = 30_000;

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

/** The base image's own values of the proxy variables (absent when it sets none), from `docker image inspect`. */
export function imageProxyEnv(configEnv: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(configEnv)) return out;
  for (const kv of configEnv) {
    if (typeof kv !== "string") continue;
    const i = kv.indexOf("=");
    const k = i < 0 ? kv : kv.slice(0, i);
    if (PROXY_VARIABLES.includes(k)) out[k] = i < 0 ? "" : kv.slice(i + 1);
  }
  return out;
}

/**
 * The project environments of this process: the probe, the turn, the images and the prepared copies. One instance
 * serves the checks and the capture of evidence (sharedEnvironments), so they share one probe and one turn.
 */
export class PreparedEnvironments {
  private readonly root: string;
  private readonly dockerPath?: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly log: (msg: string) => void;
  private probed?: Promise<Ready>;

  constructor(o: { root?: string; docker?: string; env?: NodeJS.ProcessEnv; log?: (msg: string) => void } = {}) {
    this.root = o.root ?? defaultEnvironmentRoot();
    this.dockerPath = o.docker;
    this.baseEnv = o.env ?? process.env;
    this.log = o.log ?? (() => {});
  }

  private get denv() {
    return dockerEnv(this.baseEnv);
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

  /**
   * A copy of the change, prepared in its environment: Docker and the setup probe, the copy, the image, and the
   * prepare or its reuse by key. In this process's environment turn, `use` runs with the prepared copy; the copy goes
   * afterwards, however it ends. Never throws for the environment's own failures: they come back as the reason
   * nothing was used, with the prepare commands' results.
   */
  async withPrepared<T>(req: PrepareRequest, use: (p: PreparedCopy) => Promise<T>): Promise<PreparedOutcome<T>> {
    const release = await turn();
    const s: Session = { req, docker: "", results: [], stopped: false, mounted: new Set() };
    const stopped = (): PreparedOutcome<T> => ({ ok: false, reason: "stopped", detail: "The step was stopped.", prepare: s.results });
    const onAbort = () => {
      s.stopped = true;
      s.current?.();
    };
    req.signal?.addEventListener("abort", onAbort);
    if (req.signal?.aborted) onAbort();
    try {
      if (s.stopped) return stopped();
      const up = await this.ready();
      if (!up.ok) return { ok: false, reason: "unavailable", detail: up.reason, prepare: [] };
      if (s.stopped) return stopped();
      s.docker = up.docker;
      req.onReady?.();
      const st = await this.stage(s);
      if (st.kind === "handoff") return { ok: false, reason: "unavailable", detail: st.reason, prepare: s.results };
      if (st.kind === "stopped") return stopped();
      if (!st.ok) {
        const failed = s.results.find((r) => r.status !== "passed" && r.status !== "not-run");
        return { ok: false, reason: "prepare-failed", detail: `The prepare failed${failed ? ` (${failed.label}: ${failed.status}${failed.exitCode !== undefined ? `, exit ${failed.exitCode}` : ""})` : ""}.`, ...(failed?.excerpt ? { log: failed.excerpt } : {}), record: st.record, prepare: s.results };
      }
      const docker = up.docker;
      const d = s.d!;
      const value = await use({
        docker,
        denv: this.denv,
        work: d.work,
        image: st.runImage,
        imageEnv: st.imageEnv,
        record: st.record,
        run: (argv, timeoutMs) => this.execIn(s, phaseArgs({ name: envName("run"), image: st.runImage, work: d.work, argv, phase: { kind: "run" }, imageEnv: st.imageEnv }), timeoutMs),
        track: (name) => {
          s.mounted.add(name);
          remember(name, docker, this.denv, "container");
        },
        // The step removed it; the clean-up still checks that Docker no longer lists it.
        untrack: (name) => void LIVE.delete(name),
      });
      return { ok: true, value, record: st.record, prepare: s.results };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      await this.cleanup(s);
      release();
    }
  }

  private dirs(project: string, attemptId: string): Dirs {
    const p = join(this.root, project.replace(/[^A-Za-z0-9._-]/g, "_"));
    const run = join(p, "runs", attemptId.replace(/[^A-Za-z0-9._-]/g, "_"));
    return { project: p, cache: join(p, "cache"), prepared: join(p, "prepared"), run, work: join(run, "work") };
  }

  private note(s: Session, note: string) {
    s.req.note?.(note);
  }

  /** The stage, the image and the prepare (or its reuse by key) of a step: everything before its own use. */
  private async stage(s: Session): Promise<{ kind: "prepared"; runImage: string; imageEnv: Record<string, string>; ok: boolean; record: ContainerRecord } | { kind: "handoff"; reason: string } | { kind: "stopped" }> {
    const { req, docker } = s;
    const env = req.environment;
    const d = this.dirs(env.project, req.attemptId);
    for (const dir of [join(d.cache, "xdg"), d.prepared, d.run]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!MOUNTABLE.test(d.work) || !MOUNTABLE.test(d.cache)) return { kind: "handoff", reason: `Docker cannot mount ${JSON.stringify(d.run)}` };
    s.d = d;
    copyWorktree(req.workspace, d.work);
    const image = await this.image(s, d);
    if (s.stopped) return { kind: "stopped" };
    if ("refused" in image) return { kind: "handoff", reason: image.refused };
    const imageEnv = await this.imageEnvOf(docker, image.id);
    const before = listTree(d.work);
    const key = prepareKey({ imageId: image.id, prepare: env.plan.prepare, hosts: env.plan.hosts, inputs: prepareInputs(d.work, before) });
    const prepCmds: PlannedCheck[] = env.plan.prepare.map((argv, i) => ({ id: `env-prepare-${i + 1}`, label: `Prepare: ${argv.join(" ")}`.slice(0, 60), kind: "prepare", argv, timeoutMs: PREPARE_TIMEOUT_MS }));
    const from = env.plan.source.from;
    const t0 = Date.now();
    // The steps after the prepare run on the prepared image: the base image plus what the prepare wrote outside the copy.
    const tag = `orc-env-${slug(env.project)}:${key}`;
    const reuse = prepCmds.length ? await this.preparedOf(docker, d, key, tag) : undefined;
    if (s.stopped) return { kind: "stopped" };
    if (reuse) {
      cloneEntries(join(d.prepared, key, "copy"), d.work, reuse.added);
      for (const c of prepCmds) s.results.push({ ...notRun(c), status: "passed", excerpt: `Reused what the prepare made for ${reuse.sha.slice(0, 12)}: the same image, prepare commands, hosts and prepare inputs.` });
      this.note(s, `Reused the prepare of ${reuse.sha.slice(0, 12)} (${image.ref})`);
      return { kind: "prepared", runImage: reuse.imageId, imageEnv, ok: true, record: { ran: "container", from, image: image.ref, imageId: image.id, prepare: "reused", key, reusedFrom: reuse.sha, prepareMs: 0 } };
    }
    const out = prepCmds.length ? await this.preparePhase(s, image.id, d, prepCmds) : { ok: true, refused: [] as string[], imageId: image.id };
    if (s.stopped) return { kind: "stopped" };
    if (out.ok && out.imageId && prepCmds.length) await this.savePrepared(docker, d, key, tag, out.imageId, before, req.sha);
    const record: ContainerRecord = { ran: "container", from, image: image.ref, imageId: image.id, prepare: out.ok ? "ran" : "failed", key, prepareMs: Date.now() - t0, ...(out.refused.length ? { refused: out.refused } : {}) };
    return { kind: "prepared", runImage: out.ok && out.imageId ? out.imageId : image.id, imageEnv, ok: out.ok, record };
  }

  /**
   * The step's stage goes when the step ends, however it ends, but only once every container that mounted it is gone:
   * each is removed, and Docker must stop listing it. One that stays keeps the stage where it is, with the reason.
   */
  private async cleanup(s: Session): Promise<void> {
    const stage = s.d?.run;
    if (!stage) return;
    s.d = undefined;
    const left: string[] = [];
    for (const name of s.mounted) {
      let r = await waitGone(s.docker, name, this.denv, 0);
      if (!r.gone) {
        await runDocker(s.docker, ["rm", "--force", name], { env: this.denv, timeoutMs: 30_000 });
        r = await waitGone(s.docker, name, this.denv, GONE_WITHIN_MS);
      }
      if (r.gone) LIVE.delete(name);
      else left.push(r.reason);
    }
    if (s.unsafe || left.length) return this.log(`environment: ${stage} stays, because a container that mounts it may still run: ${[s.unsafe, ...left].filter(Boolean).join(" ")}`);
    try {
      removeTree(stage);
    } catch (e) {
      this.log(`environment: could not remove ${stage}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * One container of a phase, to its end: its exit code and the end of its output. A stop request or its limit ends
   * it, and then it returns only once Docker no longer lists the container (else the copy is marked unsafe).
   */
  private async execIn(s: Session, args: string[], timeoutMs: number): Promise<Captured> {
    if (s.unsafe) return { exitCode: undefined, stdout: "", stderr: `Not run: ${s.unsafe}`, timedOut: false, capped: false, ended: true };
    const name = args[args.indexOf("--name") + 1];
    s.mounted.add(name);
    const c = startContainer(s.docker, args, { env: this.denv, name, cap: OUTPUT_CAP });
    let timedOut = false;
    let ended = false;
    let stopping: Promise<void> | undefined;
    s.current = () => {
      ended = true;
      stopping ??= c.stop();
    };
    if (s.stopped) s.current();
    const t = setTimeout(() => {
      timedOut = true;
      stopping ??= c.stop();
    }, timeoutMs);
    const r = await c.done;
    clearTimeout(t);
    s.current = undefined;
    // A container that `docker run` saw end (exit 0) has stopped; any other may still run until Docker removed it.
    if (stopping || r.code !== 0) {
      await stopping;
      const gone = await c.remove();
      if (!gone.gone) s.unsafe = gone.reason;
    }
    if (!s.unsafe) s.mounted.delete(name);
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

  /** The base image's own proxy variables (an image may set its own HTTPS_PROXY): the phases after the prepare restore them. */
  private async imageEnvOf(docker: string, id: string): Promise<Record<string, string>> {
    const r = await runDocker(docker, ["image", "inspect", "--format", "{{json .Config.Env}}", id], { env: this.denv, timeoutMs: 30_000, cap: 64_000 });
    try {
      return imageProxyEnv(JSON.parse(r.stdout));
    } catch {
      return {};
    }
  }

  /** The image of the step: pulled as named, or built from the dev container's Dockerfile (its text from the trusted base). */
  private async image(s: Session, d: Dirs): Promise<{ ref: string; id: string } | { refused: string }> {
    const { docker } = s;
    const env = s.req.environment;
    const src = env.plan.source;
    if ("image" in src) {
      this.note(s, `Using the image ${src.image}`);
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
    this.note(s, `Building ${src.file}'s Dockerfile (no network for its RUN steps)`);
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
   * under the key's tag. Then keep only the newest few of both. Never fails the step.
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
      this.log(`environment: the prepare was not kept for reuse: ${e instanceof Error ? e.message : String(e)}`);
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
  private async preparePhase(s: Session, baseImage: string, d: Dirs, cmds: PlannedCheck[]): Promise<{ ok: boolean; refused: string[]; imageId?: string }> {
    const { req, docker } = s;
    const egress = await this.startEgress(docker, req.environment.plan.hosts);
    if ("error" in egress) {
      s.results.push({ ...notRun(cmds[0]), status: "failed", excerpt: `The prepare phase could not start: ${egress.error}` });
      for (const c of cmds.slice(1)) s.results.push(notRun(c));
      return { ok: false, refused: [] };
    }
    let ok = true;
    // Each command runs on the image the one before it left; the last image is the prepared image.
    let imageId = baseImage;
    const logs: string[] = [];
    try {
      for (const c of cmds) {
        if (s.stopped) break;
        if (!ok) {
          s.results.push(notRun(c));
          continue;
        }
        this.note(s, `Preparing: ${c.argv.join(" ")} (the network goes only to the registries)`);
        const t0 = Date.now();
        const name = envName("prep");
        const cap = await this.execIn(s, phaseArgs({ name, image: imageId, work: d.work, cache: d.cache, argv: c.argv, phase: { kind: "prepare", privateNet: egress.privateNet, proxy: egress.proxy } }), c.timeoutMs);
        let r = resultOf(c, cap, Date.now() - t0, this.baseEnv, req.logDir, req.attemptId);
        if (cap.exitCode === 0 && !cap.ended && !s.stopped) {
          const committed = await runDocker(docker, commitArgs(name), { env: this.denv, timeoutMs: 10 * 60_000 });
          const id = committed.stdout.trim();
          if (committed.code === 0 && id.startsWith("sha256:")) imageId = id;
          else r = { ...r, status: "failed", excerpt: `The service could not keep what this command made (docker commit: ${committed.stderr.trim().slice(0, 200)}).\n${r.excerpt}` };
        }
        await runDocker(docker, ["rm", "--force", name], { env: this.denv, timeoutMs: 30_000 });
        if (s.stopped || cap.ended) break;
        s.results.push(r);
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
    const failed = s.results.find((r) => r.kind === "prepare" && r.status !== "passed" && r.status !== "not-run");
    if (failed && refused.length) failed.excerpt = `[The proxy refused: ${refused.join("; ")}. Add a host in Settings › Project › Environment if it is a registry.]\n${failed.excerpt}`;
    // A prepare that did not finish leaves no image behind (each command's commit builds on the one before).
    if ((!ok || s.stopped) && imageId !== baseImage) await runDocker(docker, ["image", "rm", imageId], { env: this.denv, timeoutMs: 60_000 });
    return { ok: ok && !s.stopped, refused, ...(ok ? { imageId } : {}) };
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
      const srv = createServer((c) => {
        hits++;
        c.destroy();
      });
      srv.once("error", rej);
      srv.listen(0, "127.0.0.1", () => res(srv));
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

let shared: PreparedEnvironments | undefined;
/** This process's environments: the checks and the capture of evidence share them (one probe, one turn, one root). */
export function sharedEnvironments(log?: (msg: string) => void): PreparedEnvironments {
  return (shared ??= new PreparedEnvironments({ ...(log ? { log } : {}) }));
}
