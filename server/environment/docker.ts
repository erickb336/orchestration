// The project environment's containers (docs/design/project-environment.md), as fixed `docker` argument lists: never a
// shell string. Pure builders, tested as lists; server/environment/runner.ts runs them.
//
//   private network  `--internal`, with the isolated gateway mode: no route out, and no address of the Docker host on it.
//                    One per prepare, removed after it.
//   egress network   a plain bridge that only the proxy joins: its way to the registries.
//   proxy            egress-proxy.mjs in the official Node image (pinned by digest), on both networks: the prepare
//                    phase's only way out. HTTPS by host name, the registries' list only.
//   prepare          the project's setup commands, on the private network only, with HTTPS_PROXY set to the proxy.
//                    Two mounts: the copy of the worktree (/work) and the project's cache folder (/cache, where
//                    XDG_CACHE_HOME points). Not removed when it ends: the service commits what it wrote outside the
//                    mounts (a toolchain's own folders, HOME) as the prepared image, then removes it.
//   run              the checks' commands, `--network none`, on the prepared image, with one mount: the copy (/work).
//   preview          the capture of evidence's preview (unit E2), as run but detached, with PORT set. Its network is
//                    `none` too: the recorder's browser joins this container's network, so the two share one
//                    loopback and nothing else (the app may listen on 127.0.0.1, as many dev servers do).
//   session          a CLI's recording (unit E2), as run but made with `docker create --tty --interactive`: the
//                    service attaches to its terminal, types the tape and records it. A terminal's variables (TERM,
//                    VHS's prompt) instead of CI and NO_COLOR.
//
// Every container: a non-root user, no capabilities, no new privileges, a private /tmp, limits on processes, memory and
// CPU, its own name (so the service can kill it), and the image's entrypoint replaced by the program itself. The image's
// own files stay writable inside the container (toolchains write there); those writes never reach this computer. No
// Docker socket, no other host folder, no host gateway entry, and no variable from the service's environment.

import { randomBytes } from "node:crypto";

/** The official Node image the recorder's Dockerfile also pins: the proxy runs in it. */
export const PROXY_IMAGE = "node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4";
export const PROXY_PORT = 3128;
/** Every container of the environment runs as this user, never as root. */
export const ENV_USER = "10001:10001";
export const WORK = "/work";
export const CACHE = "/cache";
/** HOME inside the container's own file system (/var/tmp is writable by every user in the official images). */
export const HOME = "/var/tmp/home";
/**
 * Per container. The Docker VM here has 2 CPUs and 2 GB (Colima's default), and one environment run goes at a time.
 * tmpfs pages count toward the memory limit.
 */
export const ENV_LIMITS = { pids: 1024, memoryBytes: 1536 * 1024 * 1024, cpus: 2, tmpBytes: 512 * 1024 * 1024 };
export const PROXY_LIMITS = { pids: 64, memoryBytes: 128 * 1024 * 1024, cpus: 0.5, tmpBytes: 16 * 1024 * 1024 };
/** A label on everything the environment creates, so a sweep can find what a crashed service left. */
export const LABEL = "orchestrator.environment";

/**
 * The variables that send a tool's HTTPS through a proxy: the conventional names, which most package managers read.
 * A tool that ignores them reaches nothing, because the private network has no other way out; the proxy's refusals
 * show in the prepare's log. No tool or language has a variable of its own here.
 */
export const PROXY_VARIABLES: readonly string[] = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
export const proxyEnv = (proxy: string): Record<string, string> => Object.fromEntries(PROXY_VARIABLES.map((k) => [k, /^no_proxy$/i.test(k) ? "" : `http://${proxy}:${PROXY_PORT}`]));

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
/** A host path a `--mount` can name: absolute, with no comma (the option's separator), quote or control character. */
export const MOUNTABLE = /^\/[^,"\u0000-\u001f\u007f]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A unique name for a container or a network of the environment. */
export const envName = (what: "net" | "out" | "proxy" | "prep" | "run" | "probe" | "preview" | "session") => `orc-env-${what}-${process.pid}-${randomBytes(5).toString("hex")}`;

function need(ok: boolean, what: string) {
  if (!ok) throw new Error(what);
}

/** `docker network create` for the private network (no route out, no gateway address) or the proxy's egress network. */
export function networkArgs(name: string, kind: "private" | "egress"): string[] {
  need(NAME.test(name), `not a network name: ${JSON.stringify(name)}`);
  return ["network", "create", ...(kind === "private" ? ["--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "--opt", "com.docker.network.bridge.gateway_mode_ipv6=isolated"] : []), "--label", `${LABEL}=${kind}`, name];
}

/** The hardening every container of the environment gets. */
function hardened(limits: typeof ENV_LIMITS, readOnly: boolean): string[] {
  return [
    ...(readOnly ? ["--read-only"] : []),
    "--tmpfs",
    // Toolchains run what they build in /tmp (go test, go tool), so the environment's /tmp allows it; the proxy's does not.
    `/tmp:rw,${readOnly ? "noexec" : "exec"},nosuid,nodev,size=${limits.tmpBytes}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(limits.pids),
    "--memory",
    `${limits.memoryBytes}b`,
    "--memory-swap",
    `${limits.memoryBytes}b`,
    "--cpus",
    String(limits.cpus),
    "--user",
    ENV_USER,
  ];
}

/** The proxy's container: detached, on the private network and the egress network, the script passed as an argument. */
export function proxyArgs(o: { name: string; privateNet: string; egressNet: string; hosts: string[]; script: string }): string[] {
  for (const n of [o.name, o.privateNet, o.egressNet]) need(NAME.test(n), `not a name: ${JSON.stringify(n)}`);
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    o.name,
    "--pull",
    "never",
    "--network",
    o.privateNet,
    "--network",
    o.egressNet,
    ...hardened(PROXY_LIMITS, true),
    "--label",
    `${LABEL}=proxy`,
    "--env",
    `ORC_PROXY_CONFIG=${JSON.stringify({ hosts: o.hosts, ports: [443], port: PROXY_PORT })}`,
    "--entrypoint",
    "node",
    PROXY_IMAGE,
    "--input-type=module",
    "--eval",
    o.script,
  ];
}

export interface PhaseSpec {
  name: string;
  /** The image to run: a reference or an image id. */
  image: string;
  /** Host folders: the copy of the worktree (/work) and, for prepare, the project's cache folder (/cache). */
  work: string;
  cache?: string;
  /** The command, each argument as is. argv[0] replaces the image's entrypoint. */
  argv: string[];
  /**
   * prepare: on the private network, through the proxy (by its container name). run: no network. preview: no network,
   * detached, serving on `port` (unit E2). session: no network, made with a terminal for the service to attach to.
   */
  phase: { kind: "prepare"; privateNet: string; proxy: string } | { kind: "run" } | { kind: "preview"; port: number } | { kind: "session" };
  /**
   * The base image's own values of the proxy variables. The prepared image keeps what its prepare container had, so
   * the phases after the prepare set each proxy variable back: to the image's own value, or empty when it had none.
   */
  imageEnv?: Record<string, string>;
}

/** A session's terminal: VHS's terminal type and prompt, and CI and NO_COLOR emptied (the prepared image keeps its prepare's). */
const SESSION_ENV = { TERM: "xterm-256color", PS1: "> ", CI: "", NO_COLOR: "" };

/** `docker run`'s arguments for one command of a phase. Throws on a name, a path or an argument it cannot pass safely. */
export function phaseArgs(s: PhaseSpec): string[] {
  need(NAME.test(s.name), `not a container name: ${JSON.stringify(s.name)}`);
  const prepare = s.phase.kind === "prepare";
  need(!prepare || s.cache !== undefined, "prepare needs the cache folder");
  for (const p of [s.work, ...(prepare ? [s.cache!] : [])]) need(MOUNTABLE.test(p), `Docker cannot mount ${JSON.stringify(p)} (a comma, a quote or a control character)`);
  need(!s.image.startsWith("-") && s.image.length > 0, `not an image: ${JSON.stringify(s.image)}`);
  need(s.argv.length > 0 && !s.argv[0].startsWith("-") && s.argv.every((a) => !/[\0]/.test(a)), "not a command");
  if (s.phase.kind === "preview") need(Number.isInteger(s.phase.port) && s.phase.port >= 1024 && s.phase.port <= 65535, `not a port: ${s.phase.port}`);
  const env: Record<string, string> = {
    HOME,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    // prepare: through the proxy, with a download cache shared by the project's prepares. The others: the proxy
    // variables go back to the base image's own values, because the prepared image keeps its prepare container's.
    ...(s.phase.kind === "prepare" ? { ...proxyEnv(s.phase.proxy), XDG_CACHE_HOME: `${CACHE}/xdg` } : { ...Object.fromEntries(PROXY_VARIABLES.map((k) => [k, s.imageEnv?.[k] ?? ""])), XDG_CACHE_HOME: `${HOME}/.cache` }),
    ...(s.phase.kind === "preview" ? { PORT: String(s.phase.port), BROWSER: "none" } : {}),
    ...(s.phase.kind === "session" ? SESSION_ENV : {}),
  };
  for (const k of Object.keys(env)) need(ENV_NAME.test(k), `not a variable: ${k}`);
  if (s.phase.kind === "prepare") need(NAME.test(s.phase.privateNet) && NAME.test(s.phase.proxy), "not a network or proxy name");
  // prepare: kept for its commit. run: removed when it ends. preview: detached, its log read before the service
  // removes it. session: created with a terminal, started once the service is attached; the service removes it.
  const start = { prepare: ["run"], run: ["run", "--rm"], preview: ["run", "--detach"], session: ["create", "--tty", "--interactive"] }[s.phase.kind];
  return [
    ...start,
    "--name",
    s.name,
    "--pull",
    "never",
    "--network",
    s.phase.kind === "prepare" ? s.phase.privateNet : "none",
    ...hardened(ENV_LIMITS, false),
    "--label",
    `${LABEL}=${s.phase.kind}`,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--mount",
    `type=bind,source=${s.work},target=${WORK}`,
    ...(prepare ? ["--mount", `type=bind,source=${s.cache},target=${CACHE}`] : []),
    "--workdir",
    WORK,
    "--entrypoint",
    s.argv[0],
    s.image,
    ...s.argv.slice(1),
  ];
}

/**
 * `docker build` for a dev container's Dockerfile: its RUN steps have no network (`--network none`); the Dockerfile's
 * text comes from the trusted base (written to `dockerfile`, outside the context), the context from the checked copy.
 */
export function buildArgs(o: { tag: string; dockerfile: string; context: string }): string[] {
  need(/^orc-env-[a-z0-9-]+:[0-9a-f]{12,64}$/.test(o.tag), `not a tag: ${JSON.stringify(o.tag)}`);
  for (const p of [o.dockerfile, o.context]) need(p.startsWith("/") && !p.includes("\0"), `not an absolute path: ${JSON.stringify(p)}`);
  return ["build", "--network", "none", "--label", `${LABEL}=build`, "--tag", o.tag, "--file", o.dockerfile, o.context];
}

/** `docker commit` for an ended prepare container: what it wrote outside its mounts becomes the next image. */
export function commitArgs(container: string): string[] {
  need(NAME.test(container), `not a container name: ${JSON.stringify(container)}`);
  return ["commit", "--change", `LABEL ${LABEL}=prepared`, container];
}
