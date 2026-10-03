#!/usr/bin/env node
// A stand-in for the `docker` CLI, for unit tests of the project environment (server/environment/prepared.ts). It never
// contacts a daemon. Its state is one file per container in DOCKER_CONFIG (the docker command's only variable that the
// service passes through, dockerEnv).
//
// What it models, and only that:
//   - the setup probe passes: networks, the proxy (detached, "listening"), and the probe's client printing good facts;
//   - images: every reference exists, with an id made from its name, and no proxy variables of its own;
//   - an attached `run` starts a "container": a separate, detached process that outlives the docker command when that
//     command is killed, as a real container does. It never outlives the test process that ran the docker command (the
//     command's parent): it ends, as if killed, once that process has gone. Its program (the entrypoint) is one of:
//       fake-exit <code>       ends at once with that code;
//       fake-beat              writes <work>/beat every 20 ms (making the folder again if it is gone) until stopped;
//       fake-fill <bytes>      writes <work>/fill of that size, then beats;
//   - `kill` and `rm --force` stop a container FAKE_DOCKER_SLOW_MS (default 500) later, and `ps` lists it until then:
//     Docker's own kill and removal take time.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const state = process.env.DOCKER_CONFIG;
if (!state) {
  process.stderr.write("fake docker: DOCKER_CONFIG names no state folder\n");
  process.exit(125);
}
mkdirSync(state, { recursive: true });
const SLOW_MS = Number(process.env.FAKE_DOCKER_SLOW_MS ?? 500);
const argv = process.argv.slice(2);
const file = (name) => join(state, `${name}.json`);
const read = (name) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : undefined);
const write = (name, s) => writeFileSync(file(name), JSON.stringify(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (s) => [...Buffer.from(s)].reduce((h, b) => ((h * 33) ^ b) >>> 0, 5381).toString(16).padStart(8, "0").repeat(8);
const log = (line) => appendFileSync(join(state, "calls.log"), `${JSON.stringify(argv.slice(0, 3))} ${line}\n`);
const out = (s) => process.stdout.write(`${s}\n`);
/** Whether a process exists (EPERM: it does, under another user). */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/**
 * The container process: does its program's work until a stop marker is due, then records its end. `owner` is the test
 * process that ran the docker command: once it has gone, the container ends as if killed.
 */
async function container(name, work, program, arg, owner) {
  write(name, { status: "running", pid: process.pid });
  if (program === "fake-fill") {
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "fill"), Buffer.alloc(Number(arg)));
  }
  for (;;) {
    if (!alive(owner)) {
      if (existsSync(state)) write(name, { status: "exited", code: 137 });
      process.exit(0);
    }
    const stop = existsSync(join(state, `${name}.stop`)) ? JSON.parse(readFileSync(join(state, `${name}.stop`), "utf8")) : undefined;
    if (stop && Date.now() >= stop.at) {
      if (stop.remove) rmSync(file(name), { force: true });
      else write(name, { status: "exited", code: 137 });
      rmSync(join(state, `${name}.stop`), { force: true });
      process.exit(0);
    }
    mkdirSync(work, { recursive: true });
    appendFileSync(join(work, "beat"), ".");
    await sleep(20);
  }
}

/** Ask a container to stop (and be removed) SLOW_MS from now; a container that already ended goes at once. */
function stop(name, remove) {
  const s = read(name);
  if (!s) return false;
  if (s.status !== "running") {
    if (remove) rmSync(file(name), { force: true });
    return true;
  }
  const prev = existsSync(join(state, `${name}.stop`)) ? JSON.parse(readFileSync(join(state, `${name}.stop`), "utf8")) : undefined;
  writeFileSync(join(state, `${name}.stop`), JSON.stringify({ at: prev?.at ?? Date.now() + SLOW_MS, remove: remove || !!prev?.remove }));
  return true;
}

const flag = (f) => {
  const i = argv.indexOf(f);
  return i < 0 ? undefined : argv[i + 1];
};

async function main() {
  const [cmd, sub] = argv;
  if (cmd === "__container") return container(argv[1], argv[2], argv[3], argv[4], Number(argv[5]));
  log("");
  if (cmd === "version") return out("29.0.0-fake");
  if (cmd === "network" && sub === "inspect") {
    // Docker's default bridge and the proxy's network have a gateway (the Docker VM); the isolated private one has none.
    const net = argv.at(-1);
    return out(JSON.stringify(net === "bridge" ? [{ Subnet: "172.17.0.0/16", Gateway: "172.17.0.1" }] : net.startsWith("orc-env-out-") ? [{ Subnet: "172.30.0.0/16", Gateway: "172.30.0.1" }] : [{ Subnet: "172.31.0.0/16" }]));
  }
  if (cmd === "network") return sub === "create" ? out(hex(argv.at(-1)).slice(0, 64)) : undefined;
  if (cmd === "image" && sub === "inspect") return out(argv.includes("{{json .Config.Env}}") ? JSON.stringify(["PATH=/usr/local/bin:/usr/bin:/bin"]) : `sha256:${hex(argv.at(-1)).slice(0, 64)}`);
  if (cmd === "pull" || cmd === "tag" || (cmd === "image" && sub === "rm")) return;
  if (cmd === "commit") return out(`sha256:${hex(`commit-${argv.at(-1)}`).slice(0, 64)}`);
  if (cmd === "logs") {
    // The probe's proxy (its hosts entry maps the probe's name to the host gateway) refuses that name as private.
    out('{"orchestratorProxy":1,"listening":3128}');
    if (read(argv[1])?.probe) out('{"orchestratorProxy":1,"host":"registry.probe.invalid","port":443,"allowed":false,"reason":"resolves to a local or private address (192.168.5.2)"}');
    return;
  }
  if (cmd === "kill") return void stop(argv[1], false);
  if (cmd === "rm") {
    for (const n of argv.slice(1).filter((a) => !a.startsWith("-"))) if (!stop(n, true)) process.stderr.write(`Error response from daemon: No such container: ${n}\n`);
    return;
  }
  if (cmd === "ps") {
    const name = (flag("--filter") ?? "").replace(/^name=/, "");
    return read(name) ? out(name) : undefined;
  }
  if (cmd === "run") {
    const name = flag("--name");
    const work = /source=([^,]+),target=\/work/.exec(argv.find((a) => a.includes("target=/work")) ?? "")?.[1] ?? "";
    // phaseArgs ends with: --entrypoint <program> <image> <arguments…>
    const e = argv.indexOf("--entrypoint");
    const entry = argv[e + 1];
    const args = argv.slice(e + 3);
    // The container's owner is this command's parent: the test process.
    const start = () => spawn(process.execPath, [new URL(import.meta.url).pathname, "__container", name, work, entry, args[0] ?? "", String(process.ppid)], { detached: true, stdio: "ignore", env: process.env }).unref();
    if (argv.includes("--detach")) {
      if (entry === "fake-beat" || entry === "fake-fill") start();
      else write(name, { status: "running", pid: 0, probe: argv.includes("registry.probe.invalid:host-gateway") });
      return;
    }
    if (entry === "node" && args[0] === "-e") {
      // The setup probe's client, on a machine whose private network reaches nothing.
      write(name, { status: "exited", code: 0 });
      const input = JSON.parse(args[2]);
      const forbidden = "HTTP/1.1 403 Forbidden";
      return out(JSON.stringify({ orchestratorEnvProbe: 1, outside: "ENETUNREACH", host: "ENETUNREACH", dns: "EAI_AGAIN", vm: Object.fromEntries(input.vm.map((a) => [a, "ENETUNREACH"])), proxyOutside: forbidden, proxyLoopback: forbidden, proxyHost: forbidden, proxyPrivate: forbidden }));
    }
    if (entry === "fake-exit") {
      const code = Number(args[0] ?? 0);
      if (argv.includes("--rm")) rmSync(file(name), { force: true });
      else write(name, { status: "exited", code });
      out(`fake-exit ${code}`);
      process.exit(code);
    }
    // A container that runs until it is stopped: a process of its own, which the docker command only waits for.
    start();
    for (;;) {
      await sleep(20);
      // Its test process has gone: nothing waits for this command any more, and the container ends by itself.
      if (!alive(process.ppid)) process.exit(137);
      const s = read(name);
      if (s && s.status === "exited") process.exit(s.code);
      if (!s && existsSync(join(state, `${name}.seen`))) process.exit(137);
      if (s) writeFileSync(join(state, `${name}.seen`), "");
    }
  }
  process.stderr.write(`fake docker: ${argv.slice(0, 2).join(" ")} is not modelled\n`);
  process.exit(125);
}

await main();
