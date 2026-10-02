// The container that records terminal demos (ORC-029; pass 3 review, findings 1 and 2). terminal.ts checks the tape
// and decides what to record; this module runs it in Docker and proves first that Docker isolates it.
//
// One `docker run` per tape, with a fixed argument list (containerArgs; never a shell string):
//
//   no network       --network none: the container has only its own loopback, where VHS, ttyd and Chromium talk.
//   no host files    two bind mounts and nothing else: a fresh copy of the artifact (/work) and an empty output folder
//                    (/out), both inside a stage folder the service makes for this one recording. No Docker socket.
//   read-only root   --read-only, with small tmpfs folders for /tmp and HOME. The VHS image's own volume (/vhs) is
//                    covered by an empty read-only tmpfs, so Docker makes no volume for it.
//   no privileges    a non-root user (the image's `recorder`, 10001), --cap-drop ALL, no-new-privileges.
//   limits           processes, memory (no swap) and CPU; a unique name, so the service can kill it.
//   own devices      the container's /dev has no device of the host: no /dev/ttys*, so no other terminal session.
//
// The image (docker/recorder/Dockerfile) is VHS 0.12.1 plus Node 22. The service never builds or pulls it: without it,
// recording is unavailable, with "run npm run recorder:build". Inside, VHS runs in the tape's folder, and its `ttyd`
// (a wrapper the image puts first on PATH) starts the tape's shell at the artifact's root.
//
// The stage folder must be one Docker can see: Colima shares only the home folder with its VM, so the default root is
// ~/.cache/orchestrator/recorder, not the system temp folder. probeRecorder proves it, with everything else, before
// anything records.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { killGroup, trackLive } from "../processes";

/** The recorder's image. `npm run recorder:build` tags it; bump both when docker/recorder changes. */
export const RECORDER_IMAGE = "orchestrator-recorder:1";
/** The image's user (docker/recorder/Dockerfile). Every container runs as it, never as root. */
export const RECORDER_USER = "10001:10001";
export const CONTAINER_HOME = "/home/recorder";
/** Where the copy of the artifact and the output folder are mounted. */
export const WORK = "/work";
export const OUT = "/out";
/**
 * Per container. One recording of the terminal sample peaked at 517 MB and 116 processes (threads included), so these
 * leave about twice the room. tmpfs pages count toward the memory limit.
 */
export const RECORDER_LIMITS = { pids: 512, memoryBytes: 1024 * 1024 * 1024, cpus: 1.5, tmpBytes: 512 * 1024 * 1024, homeBytes: 64 * 1024 * 1024 };
/** The probe's name for the host, from Docker's host-gateway (only the probe's containers get it). */
export const HOST_ALIAS = "orchestrator-host";

/** Where recordings stage their folders by default: inside the home folder, which Docker Desktop and Colima share. */
export const defaultRecorderRoot = () => join(homedir(), ".cache", "orchestrator", "recorder");

// ---------- the argument list ----------

export interface ContainerSpec {
  /** Unique: the service kills and removes the container by it. */
  name: string;
  /** Host folders: the copy of the artifact (mounted at /work) and the output folder (at /out). */
  work: string;
  out: string;
  /** The working directory inside the container (under /work). */
  workdir: string;
  /** The command, each argument as is: nothing is parsed by a shell. */
  command: string[];
  image?: string;
  /** Keep stdin open: the tape goes in there. */
  stdin?: boolean;
  /** Only for the probe: a hosts entry for the host gateway, so it can show the host is out of reach. */
  hostGateway?: boolean;
}

/** A host path a `--mount` can name: absolute, with no comma (the option's separator), quote or control character. */
const MOUNTABLE = /^\/[^,"\u0000-\u001f\u007f]*$/;
const CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** `docker run`'s arguments for one container. Throws on a name or a path it cannot pass safely. */
export function containerArgs(s: ContainerSpec): string[] {
  if (!CONTAINER_NAME.test(s.name)) throw new Error(`not a container name: ${JSON.stringify(s.name)}`);
  for (const p of [s.work, s.out]) if (!MOUNTABLE.test(p)) throw new Error(`Docker cannot mount ${JSON.stringify(p)} (a comma, a quote or a control character)`);
  if (s.workdir !== WORK && !s.workdir.startsWith(`${WORK}/`)) throw new Error(`the working directory must be under ${WORK}`);
  const L = RECORDER_LIMITS;
  return [
    "run",
    "--rm",
    ...(s.stdin ? ["--interactive"] : []),
    "--name",
    s.name,
    "--pull",
    "never",
    "--network",
    "none",
    ...(s.hostGateway ? ["--add-host", `${HOST_ALIAS}:host-gateway`] : []),
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${L.tmpBytes}`,
    "--tmpfs",
    `${CONTAINER_HOME}:rw,noexec,nosuid,nodev,size=${L.homeBytes},mode=0700,uid=10001,gid=10001`,
    "--tmpfs",
    "/vhs:ro,noexec,nosuid,nodev,size=4096",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(L.pids),
    "--memory",
    `${L.memoryBytes}b`,
    "--memory-swap",
    `${L.memoryBytes}b`,
    "--cpus",
    String(L.cpus),
    "--user",
    RECORDER_USER,
    "--env",
    `HOME=${CONTAINER_HOME}`,
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "TMPDIR=/tmp",
    "--mount",
    `type=bind,source=${s.work},target=${WORK}`,
    "--mount",
    `type=bind,source=${s.out},target=${OUT}`,
    "--workdir",
    s.workdir,
    s.image ?? RECORDER_IMAGE,
    ...s.command,
  ];
}

export const containerName = (what: "rec" | "probe") => `orc-${what}-${process.pid}-${randomBytes(6).toString("hex")}`;

// ---------- running docker ----------

/** The environment the docker command gets: where it finds itself, its configuration and its daemon. Nothing else. */
export function dockerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    const v = env[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** The docker command on PATH (and the usual Homebrew folders), or undefined. */
export function findDocker(env: NodeJS.ProcessEnv): string | undefined {
  const dirs = [...(env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
  for (const d of dirs) {
    const f = join(d, "docker");
    try {
      if (statSync(f).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

const tailOf = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

/** Run docker with `args` (no shell), and capture the end of its output. Killed after `timeoutMs`. */
export function runDocker(docker: string, args: string[], o: { env: Record<string, string>; timeoutMs: number; cap?: number }): Promise<Captured> {
  const cap = o.cap ?? 8000;
  return new Promise((res) => {
    let child: ChildProcess;
    try {
      child = spawn(docker, args, { env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      return res({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
    }
    trackLive(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout = tailOf(stdout + d, cap)));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = tailOf(stderr + d, cap)));
    const t = setTimeout(() => killGroup(child, "SIGKILL"), o.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      res({ code: null, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      res({ code, stdout, stderr });
    });
  });
}

/** Containers this process started that may still run; killed when it exits (each also ends on its own timeout). */
const LIVE = new Map<string, { docker: string; env: Record<string, string> }>();
let exitHook = false;
function remember(name: string, docker: string, env: Record<string, string>) {
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const [n, d] of LIVE) spawnSync(d.docker, ["kill", n], { env: d.env, stdio: "ignore", timeout: 5000 });
    });
  }
  LIVE.set(name, { docker, env });
}

export interface RunningContainer {
  name: string;
  /** When `docker run` exits: its exit code (null when it could not start) and the end of its output. */
  done: Promise<{ code: number | null; output: string }>;
  /** Kill the container by its name, end the docker command, and remove the container. */
  stop(): Promise<void>;
  /** Make sure the container is gone (it removes itself when it ends; this covers a docker command that did not). */
  remove(): Promise<void>;
}

/** Start `docker run` with `args` (from containerArgs, whose name is `name`), writing `stdin` to it when given. */
export function startContainer(docker: string, args: string[], o: { env: Record<string, string>; name: string; stdin?: string; cap?: number }): RunningContainer {
  const cap = o.cap ?? 4000;
  remember(o.name, docker, o.env);
  let child: ChildProcess | undefined;
  let output = "";
  const done = new Promise<{ code: number | null; output: string }>((res) => {
    try {
      child = spawn(docker, args, { env: o.env, stdio: [o.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      return res({ code: null, output: e instanceof Error ? e.message : String(e) });
    }
    trackLive(child);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (output = tailOf(output + d, cap)));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (output = tailOf(output + d, cap)));
    if (o.stdin !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(o.stdin);
    }
    child.on("error", (e) => res({ code: null, output: tailOf(`${output}\n${e.message}`, cap) }));
    child.on("close", (code) => res({ code, output }));
  });
  const remove = async () => {
    await runDocker(docker, ["rm", "--force", o.name], { env: o.env, timeoutMs: 15_000 });
    LIVE.delete(o.name);
  };
  const stop = async () => {
    await runDocker(docker, ["kill", o.name], { env: o.env, timeoutMs: 15_000 });
    if (child) killGroup(child, "SIGKILL");
    await remove();
  };
  void done.then(() => {
    // `--rm`: the container is gone once `docker run` ends normally.
    if (child?.exitCode === 0) LIVE.delete(o.name);
  });
  return { name: o.name, done, stop, remove };
}

// ---------- is Docker there ----------

export type DockerReady = { ok: true; docker: string; imageId: string } | { ok: false; reason: string };

/** The docker command, its daemon, and the recorder's image, each with the reason it is missing. Never builds or pulls. */
export async function dockerReady(o: { docker?: string; env?: NodeJS.ProcessEnv; image?: string } = {}): Promise<DockerReady> {
  const env = o.env ?? process.env;
  const image = o.image ?? RECORDER_IMAGE;
  const docker = o.docker ?? findDocker(env);
  if (!docker) return { ok: false, reason: "Docker is not installed (no docker command on PATH)" };
  if (!existsSync(docker)) return { ok: false, reason: `Docker is not installed (${docker} was not found)` };
  const denv = dockerEnv(env);
  const v = await runDocker(docker, ["version", "--format", "{{.Server.Version}}"], { env: denv, timeoutMs: 20_000 });
  if (v.code !== 0 || !v.stdout.trim()) return { ok: false, reason: `Docker is not running (start it, for example with colima start)${v.stderr.trim() ? `: ${v.stderr.trim().split("\n").pop()!.slice(0, 160)}` : ""}` };
  const i = await runDocker(docker, ["image", "inspect", "--format", "{{.Id}}", image], { env: denv, timeoutMs: 20_000 });
  const imageId = i.stdout.trim();
  if (i.code !== 0 || !imageId) return { ok: false, reason: `the recorder image ${image} is missing: run npm run recorder:build` };
  return { ok: true, docker, imageId };
}

// ---------- the probe ----------

/**
 * Run inside the probe's container by the image's node, with one argument (JSON: a token, a port and host paths). It
 * prints one JSON line of facts; probeRecorder judges them (judgeProbe), so this script only looks.
 */
const PROBE_SCRIPT = `"use strict";
const fs = require("node:fs"), net = require("node:net");
const input = JSON.parse(process.argv[1]);
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return ""; } };
const status = read("/proc/self/status");
const field = (k) => ((new RegExp("^" + k + ":\\\\s*(.*)$", "m")).exec(status) || [])[1] || "";
const write = (p) => { try { fs.writeFileSync(p, input.token); return "OK"; } catch (e) { return e.code || "ERROR"; } };
const cg = (n) => read("/sys/fs/cgroup/" + n).trim();
const list = (p) => { try { return fs.readdirSync(p).sort(); } catch (e) { return ["(" + (e.code || "ERROR") + ")"]; } };
const connect = (host, port) => new Promise((done) => {
  const s = net.connect(port, host);
  const t = setTimeout(() => { s.destroy(); done("TIMEOUT"); }, 3000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); done("CONNECTED"); });
  s.on("error", (e) => { clearTimeout(t); done(e.code || "ERROR"); });
});
(async () => {
  const f = {
    uid: field("Uid").split(/\\s+/).filter(Boolean).map(Number),
    caps: ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(field),
    noNewPrivs: field("NoNewPrivs"),
    seccomp: field("Seccomp"),
    pid1: read("/proc/1/cmdline").split("\\0")[0],
    processes: list("/proc").filter((n) => /^\\d+$/.test(n)).length,
    interfaces: read("/proc/net/dev").split("\\n").slice(2).map((l) => l.split(":")[0].trim()).filter(Boolean),
    mounts: read("/proc/self/mountinfo").split("\\n").filter(Boolean).map((l) => { const [a, b] = l.split(" - "); return { point: a.split(" ")[4], type: (b || "").split(" ")[0] }; }),
    exists: Object.fromEntries(input.paths.map((p) => [p, fs.existsSync(p)])),
    readIn: read("${WORK}/probe-in.txt") === input.token,
    writes: Object.fromEntries(["/probe-x", "/etc/probe-x", "/usr/local/bin/probe-x", "/work/probe-written.txt", "/out/probe-out.txt", "/tmp/probe-x", "${CONTAINER_HOME}/probe-x"].map((p) => [p, write(p)])),
    dev: list("/dev"),
    pts: list("/dev/pts"),
    tty: write("/dev/tty"),
    limits: { pids: cg("pids.max"), memory: cg("memory.max"), swap: cg("memory.swap.max"), cpu: cg("cpu.max") },
  };
  f.connect = { outside: await connect("1.1.1.1", 443), host: /${HOST_ALIAS}/.test(read("/etc/hosts")) ? await connect("${HOST_ALIAS}", input.port) : "no hosts entry" };
  console.log(JSON.stringify({ orchestratorProbe: 1, ...f }));
})();
`;

/** What the probe's container saw, as it printed it. */
export interface ProbeFacts {
  uid: number[];
  caps: string[];
  noNewPrivs: string;
  seccomp: string;
  pid1: string;
  processes: number;
  interfaces: string[];
  mounts: { point: string; type: string }[];
  exists: Record<string, boolean>;
  readIn: boolean;
  writes: Record<string, string>;
  dev: string[];
  pts: string[];
  tty: string;
  limits: { pids: string; memory: string; swap: string; cpu: string };
  connect: { outside: string; host: string };
}

/** The probe's line of facts among whatever else the container printed, or why there is none. */
export function parseProbe(stdout: string): ProbeFacts | string {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{"orchestratorProbe":1'));
  if (!line) return `the probe printed no result${stdout.trim() ? ` (${stdout.trim().slice(-200)})` : ""}`;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return "the probe's result is not JSON";
  }
  const { orchestratorProbe: _marker, ...f } = v as Partial<ProbeFacts> & { orchestratorProbe?: number };
  const arr = (x: unknown) => Array.isArray(x);
  const obj = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);
  if (!arr(f.uid) || !arr(f.caps) || !arr(f.interfaces) || !arr(f.mounts) || !arr(f.dev) || !arr(f.pts) || !obj(f.exists) || !obj(f.writes) || !obj(f.limits) || !obj(f.connect) || typeof f.readIn !== "boolean") return "the probe's result is missing facts";
  return f as ProbeFacts;
}

/** What the service saw on its side of the probe. */
export interface HostSide {
  /** The token came back in the output folder, and the file the container wrote in its copy is there. */
  outputBack: boolean;
  workWritten: boolean;
  /** Connections the service's stand-in listener (127.0.0.1) accepted while the probe ran. */
  listenerHits: number;
  /** The paths the container must not see. */
  paths: string[];
}

export interface ProbeCheck {
  name: string;
  ok: boolean;
  saw: string;
}

/** The only mounts that may be backed by a disk: the two of the recording, and Docker's own three files in /etc. */
const DISK_MOUNTS = new Set([WORK, OUT, "/etc/resolv.conf", "/etc/hostname", "/etc/hosts"]);
const PSEUDO_FS = new Set(["overlay", "proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup2", "cgroup"]);
/** Docker's own /dev: no device of the host. */
const CONTAINER_DEV = new Set(["core", "fd", "full", "mqueue", "null", "ptmx", "pts", "random", "shm", "stderr", "stdin", "stdout", "tty", "urandom", "zero"]);
/** A refused connection, as Node names it: an error, never CONNECTED and never a timeout. */
const REFUSED_CONNECT = new Set(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "EACCES", "EPERM", "EADDRNOTAVAIL"]);
const ZERO_CAPS = /^0+$/;

/**
 * Judge the probe: every behaviour the recording relies on, in order. Each check says what it saw; the probe passes
 * only when all pass.
 */
export function judgeProbe(f: ProbeFacts, host: HostSide): ProbeCheck[] {
  const L = RECORDER_LIMITS;
  const check = (name: string, ok: boolean, saw: string): ProbeCheck => ({ name, ok, saw });
  const diskMounts = f.mounts.filter((m) => !PSEUDO_FS.has(m.type)).map((m) => m.point);
  const seen = host.paths.filter((p) => f.exists[p] !== false);
  const writes = (paths: string[], want: (r: string | undefined) => boolean) => paths.filter((p) => !want(f.writes[p]));
  const roFails = writes(["/probe-x", "/etc/probe-x", "/usr/local/bin/probe-x"], (r) => r === "EROFS");
  const rwFails = writes(["/work/probe-written.txt", "/out/probe-out.txt", "/tmp/probe-x", `${CONTAINER_HOME}/probe-x`], (r) => r === "OK");
  const strangeDev = f.dev.filter((d) => !CONTAINER_DEV.has(d));
  return [
    check("runs as a user other than root", f.uid.length === 4 && f.uid.every((u) => Number.isInteger(u) && u > 0), `uid ${f.uid.join(" ")}`),
    check("has no capabilities and cannot gain privileges", f.caps.length === 5 && f.caps.every((c) => ZERO_CAPS.test(c)) && f.noNewPrivs === "1" && f.seccomp === "2", `caps ${f.caps.join("/")}, no-new-privileges ${f.noNewPrivs}, seccomp ${f.seccomp}`),
    check("has its own processes", f.pid1 !== "" && !/(^|\/)(launchd|systemd|init)$/.test(f.pid1) && f.processes <= 5, `pid 1 ${f.pid1 || "(none)"}, ${f.processes} processes`),
    check("has no network but its own loopback", f.interfaces.length === 1 && f.interfaces[0] === "lo" && REFUSED_CONNECT.has(f.connect.outside), `interfaces ${f.interfaces.join(", ")}; 1.1.1.1:443 ${f.connect.outside}`),
    check("cannot reach the host", REFUSED_CONNECT.has(f.connect.host) && host.listenerHits === 0, `the host gateway ${f.connect.host}; ${host.listenerHits} connection(s) to the service's port`),
    check("sees no host files but its two mounts", seen.length === 0 && diskMounts.every((m) => DISK_MOUNTS.has(m)) && diskMounts.includes(WORK) && diskMounts.includes(OUT), `${seen.length ? `sees ${seen.join(", ")}; ` : ""}mounts ${diskMounts.join(", ")}`),
    check("reads the copy of the artifact", f.readIn && host.workWritten, `${f.readIn ? "read" : "did not read"} the service's file; ${host.workWritten ? "its own file is in the copy" : "its file did not reach the copy"}`),
    check("writes only to its copy, its output folder and its temporary folders", roFails.length === 0 && rwFails.length === 0 && host.outputBack, `${[...roFails, ...rwFails].map((p) => `${p} ${f.writes[p] ?? "untried"}`).join(", ") || "as required"}${host.outputBack ? "" : "; the output did not come back"}`),
    check("has no terminal of the host", strangeDev.length === 0 && f.pts.every((p) => p === "ptmx") && f.tty !== "OK", `${strangeDev.length ? `devices ${strangeDev.join(", ")}; ` : ""}/dev/pts ${f.pts.join(", ")}; /dev/tty ${f.tty}`),
    check("runs within its limits", f.limits.pids === String(L.pids) && f.limits.memory === String(L.memoryBytes) && f.limits.swap === "0" && f.limits.cpu === `${Math.round(L.cpus * 100_000)} 100000`, `pids ${f.limits.pids}, memory ${f.limits.memory}, swap ${f.limits.swap}, cpu ${f.limits.cpu}`),
  ];
}

export interface RecorderHealth {
  ok: boolean;
  detail: string;
  /** Each check of the container, when it ran. */
  checks: ProbeCheck[];
  /** The docker command and image the probe proved. */
  docker?: string;
  imageId?: string;
}

const healthCache = new Map<string, Promise<RecorderHealth>>();

/**
 * Prove the recorder before anything records: Docker is running, the image is there, and a container made exactly as a
 * recording's (containerArgs; the probe adds only a hosts entry for the host gateway) behaves as required, with
 * service-owned commands. The stage folder sits under `root` (default defaultRecorderRoot()), as a recording's does, so
 * the probe also proves Docker can see it. Cached per docker command, image and root once it passes; `fresh` checks
 * again.
 */
export function probeRecorder(o: { docker?: string; env?: NodeJS.ProcessEnv; image?: string; root?: string; fresh?: boolean } = {}): Promise<RecorderHealth> {
  return (async () => {
    const ready = await dockerReady(o);
    if (!ready.ok) return { ok: false, detail: ready.reason, checks: [] };
    const root = o.root ?? defaultRecorderRoot();
    const key = [ready.docker, ready.imageId, root].join("\0");
    let h = healthCache.get(key);
    if (!h || o.fresh) {
      h = probe(ready.docker, dockerEnv(o.env ?? process.env), o.image ?? RECORDER_IMAGE, root).then((x) => {
        if (!x.ok) healthCache.delete(key);
        return { ...x, docker: ready.docker, imageId: ready.imageId };
      });
      healthCache.set(key, h);
    }
    return h;
  })();
}

/** A new stage folder under `root`: `work/` and `out/`, private to this user. */
export function makeStage(root: string, prefix: string): { dir: string; work: string; out: string } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = realpathSync(mkdtempSync(join(root, prefix)));
  const s = { dir, work: join(dir, "work"), out: join(dir, "out") };
  mkdirSync(s.work, { mode: 0o700 });
  mkdirSync(s.out, { mode: 0o700 });
  return s;
}

async function probe(docker: string, env: Record<string, string>, image: string, root: string): Promise<Omit<RecorderHealth, "docker" | "imageId">> {
  let stage: ReturnType<typeof makeStage>;
  try {
    stage = makeStage(root, "orc-probe-");
  } catch (e) {
    return { ok: false, detail: `cannot make the recorder's folder in ${root}: ${e instanceof Error ? e.message : String(e)}`, checks: [] };
  }
  let hits = 0;
  let listener: Server | undefined;
  const name = containerName("probe");
  try {
    if (!MOUNTABLE.test(stage.dir)) return { ok: false, detail: `Docker cannot mount ${JSON.stringify(stage.dir)}`, checks: [] };
    const token = randomBytes(16).toString("hex");
    writeFileSync(join(stage.work, "probe-in.txt"), token, { mode: 0o600 });
    // Beside the mounts, never inside them: the container must not see it.
    const beside = join(stage.dir, "beside.txt");
    writeFileSync(beside, token, { mode: 0o600 });
    // The service's stand-in: a port on this machine's loopback, like the API's.
    listener = await new Promise<Server>((res, rej) => {
      const s = createServer((c) => {
        hits++;
        c.destroy();
      });
      s.once("error", rej);
      s.listen(0, "127.0.0.1", () => res(s));
    });
    const port = (listener.address() as { port: number }).port;
    const paths = [...new Set([beside, stage.dir, root, homedir(), "/Users", "/Volumes", "/private", "/var/folders", "/var/run/docker.sock", "/run/docker.sock"])];
    const args = containerArgs({ name, work: stage.work, out: stage.out, workdir: WORK, image, hostGateway: true, command: ["/usr/local/bin/node", "-e", PROBE_SCRIPT, JSON.stringify({ token, port, paths })] });
    const run = startContainer(docker, args, { env, name, cap: 64_000 });
    const timer = setTimeout(() => void run.stop(), 60_000);
    const r = await run.done;
    clearTimeout(timer);
    await run.remove();
    const facts = parseProbe(r.output);
    if (typeof facts === "string") return { ok: false, detail: `the recorder's container did not run the probe (exit ${r.code ?? "?"}): ${facts}`, checks: [] };
    const readBack = (p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    const checks = judgeProbe(facts, { outputBack: readBack(join(stage.out, "probe-out.txt")) === token, workWritten: readBack(join(stage.work, "probe-written.txt")) === token, listenerHits: hits, paths });
    const failed = checks.find((c) => !c.ok);
    if (failed) return { ok: false, detail: `the recorder's container failed the check "${failed.name}" (saw: ${failed.saw})`, checks };
    return { ok: true, detail: "the recorder's container is verified: no network, no host files beyond the copy and the output folder, a read-only root, no privileges, no host terminals, and its limits.", checks };
  } catch (e) {
    return { ok: false, detail: `the probe failed: ${e instanceof Error ? e.message : String(e)}`, checks: [] };
  } finally {
    listener?.close();
    rmSync(stage.dir, { recursive: true, force: true });
  }
}
