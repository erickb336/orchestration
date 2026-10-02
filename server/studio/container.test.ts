// The recorder's container (ORC-029; pass 3 review, findings 1 and 2): the exact `docker run` arguments, the probe's
// judging of what the container saw, the reasons recording is unavailable (no Docker, Docker not running, no image, a
// failed probe), and a stop that kills the container by its name. Stand-in docker commands answer where Docker is not
// needed. Where Docker and the image are present, the real probe passes, and a docker that drops the isolation flags
// fails it.

import { chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECORDER_IMAGE, STAGE_SWEEP_AGE_MS, containerArgs, containerName, defaultRecorderRoot, dockerReady, judgeProbe, parseProbe, probeRecorder, startContainer, sweepStages, type HostSide, type ProbeFacts } from "./container";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-container-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in docker: logs each call's arguments, and answers each subcommand with the given bash. */
function standIn(name: string, answers: { version?: string; image?: string; run?: string }) {
  const log = join(dir, `${name}.log`);
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1" in
  version) ${answers.version ?? "echo 29.0.0"} ;;
  image) ${answers.image ?? "echo sha256:feed"} ;;
  run) ${answers.run ?? "exit 0"} ;;
esac
`,
  );
  chmodSync(file, 0o755);
  return { file, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

describe("the docker run arguments", () => {
  const spec = { name: "orc-rec-1-abc", work: "/Users/me/.cache/orchestrator/recorder/orc-rec-x/work", out: "/Users/me/.cache/orchestrator/recorder/orc-rec-x/out", workdir: "/work/cli", command: ["/usr/bin/vhs", "-"], stdin: true };

  it("are a fixed list: no network, a read-only root with tmpfs, no capabilities or new privileges, limits, a non-root user, and two mounts", () => {
    expect(containerArgs(spec)).toEqual([
      "run",
      "--rm",
      "--interactive",
      "--name",
      "orc-rec-1-abc",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=536870912",
      "--tmpfs",
      "/home/recorder:rw,noexec,nosuid,nodev,size=67108864,mode=0700,uid=10001,gid=10001",
      "--tmpfs",
      "/vhs:ro,noexec,nosuid,nodev,size=4096",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--memory",
      "1073741824b",
      "--memory-swap",
      "1073741824b",
      "--cpus",
      "1.5",
      "--user",
      "10001:10001",
      "--env",
      "HOME=/home/recorder",
      "--env",
      "LANG=C.UTF-8",
      "--env",
      "TMPDIR=/tmp",
      "--mount",
      "type=bind,source=/Users/me/.cache/orchestrator/recorder/orc-rec-x/work,target=/work",
      "--mount",
      "type=bind,source=/Users/me/.cache/orchestrator/recorder/orc-rec-x/out,target=/out",
      "--workdir",
      "/work/cli",
      RECORDER_IMAGE,
      "/usr/bin/vhs",
      "-",
    ]);
  });

  it("pass the command through as separate arguments, never through a shell; only the probe names the host gateway", () => {
    const args = containerArgs({ ...spec, command: ["/usr/local/bin/node", "-e", "x'; rm -rf / #", "$(id)"] });
    expect(args.slice(-4)).toEqual(["/usr/local/bin/node", "-e", "x'; rm -rf / #", "$(id)"]);
    expect(args).not.toContain("--add-host");
    expect(containerArgs({ ...spec, hostGateway: true })).toEqual(expect.arrayContaining(["--add-host", "orchestrator-host:host-gateway"]));
    expect(containerArgs({ ...spec, stdin: false })).not.toContain("--interactive");
  });

  it("name the image that npm run recorder:build tags, and the user the image makes", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["recorder:build"]).toBe(`docker build --tag ${RECORDER_IMAGE} docker/recorder`);
    const dockerfile = readFileSync(join(__dirname, "../../docker/recorder/Dockerfile"), "utf8");
    expect(dockerfile).toContain("useradd --uid 10001 ");
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    // Both images pinned by digest.
    expect(dockerfile.match(/^FROM \S+@sha256:[0-9a-f]{64}/gm)).toHaveLength(2);
  });

  it("refuse a path a mount cannot name, a name that is not a container's, and a working directory outside the copy", () => {
    expect(() => containerArgs({ ...spec, work: "/tmp/a,target=/etc" })).toThrow(/cannot mount/);
    expect(() => containerArgs({ ...spec, out: "relative/out" })).toThrow(/cannot mount/);
    expect(() => containerArgs({ ...spec, out: '/tmp/a"b' })).toThrow(/cannot mount/);
    expect(() => containerArgs({ ...spec, name: "--privileged" })).toThrow(/not a container name/);
    expect(() => containerArgs({ ...spec, workdir: "/" })).toThrow(/under \/work/);
    expect(() => containerArgs({ ...spec, workdir: "/workshop" })).toThrow(/under \/work/);
    expect(containerName("rec")).toMatch(/^orc-rec-\d+-[0-9a-f]{12}$/);
  });
});

describe("the probe's judging", () => {
  /** What a container made by containerArgs saw on Colima (2026-10-02). */
  const GOOD: ProbeFacts = {
    uid: [10001, 10001, 10001, 10001],
    caps: ["0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000"],
    noNewPrivs: "1",
    seccomp: "2",
    pid1: "/usr/local/bin/node",
    processes: 1,
    interfaces: ["lo"],
    mounts: [
      { point: "/", type: "overlay" },
      { point: "/proc", type: "proc" },
      { point: "/dev", type: "tmpfs" },
      { point: "/dev/pts", type: "devpts" },
      { point: "/sys/fs/cgroup", type: "cgroup2" },
      { point: "/tmp", type: "tmpfs" },
      { point: "/work", type: "virtiofs" },
      { point: "/out", type: "virtiofs" },
      { point: "/etc/resolv.conf", type: "ext4" },
      { point: "/etc/hostname", type: "ext4" },
      { point: "/etc/hosts", type: "ext4" },
    ],
    exists: { "/Users": false, "/Users/me": false, "/var/run/docker.sock": false },
    readIn: true,
    writes: { "/probe-x": "EROFS", "/etc/probe-x": "EROFS", "/usr/local/bin/probe-x": "EROFS", "/work/probe-written.txt": "OK", "/out/probe-out.txt": "OK", "/tmp/probe-x": "OK", "/home/recorder/probe-x": "OK" },
    dev: ["core", "fd", "full", "mqueue", "null", "ptmx", "pts", "random", "shm", "stderr", "stdin", "stdout", "tty", "urandom", "zero"],
    pts: ["ptmx"],
    tty: "ENXIO",
    limits: { pids: "512", memory: "1073741824", swap: "0", cpu: "150000 100000" },
    connect: { outside: "ENETUNREACH", host: "ENETUNREACH" },
  };
  const HOST: HostSide = { outputBack: true, workWritten: true, listenerHits: 0, paths: ["/Users", "/Users/me", "/var/run/docker.sock"] };
  /** The names of the checks that fail. */
  const failing = (f: Partial<ProbeFacts>, h: Partial<HostSide> = {}) =>
    judgeProbe({ ...GOOD, ...f }, { ...HOST, ...h })
      .filter((c) => !c.ok)
      .map((c) => c.name);

  it("passes a container that behaves as required", () => {
    const checks = judgeProbe(GOOD, HOST);
    expect(checks.map((c) => c.name)).toEqual([
      "runs as a user other than root",
      "has no capabilities and cannot gain privileges",
      "has its own processes",
      "has no network but its own loopback",
      "cannot reach the host",
      "sees no host files but its two mounts",
      "reads the copy of the artifact",
      "writes only to its copy, its output folder and its temporary folders",
      "has no terminal of the host",
      "runs within its limits",
    ]);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("fails each check on what breaks it, and only that check", () => {
    expect(failing({ uid: [0, 0, 0, 0] })).toEqual(["runs as a user other than root"]);
    expect(failing({ caps: [...GOOD.caps.slice(0, 2), "00000000a80425fb", ...GOOD.caps.slice(3)] })).toEqual(["has no capabilities and cannot gain privileges"]);
    expect(failing({ noNewPrivs: "0" })).toEqual(["has no capabilities and cannot gain privileges"]);
    expect(failing({ pid1: "/sbin/launchd", processes: 700 })).toEqual(["has its own processes"]);
    // A bridge network: an interface, and the internet reached.
    expect(failing({ interfaces: ["lo", "eth0"], connect: { outside: "CONNECTED", host: "ENETUNREACH" } })).toEqual(["has no network but its own loopback"]);
    expect(failing({ connect: { outside: "TIMEOUT", host: "ENETUNREACH" } })).toEqual(["has no network but its own loopback"]);
    // The host's gateway answers, or the service's port saw a connection.
    expect(failing({ connect: { outside: "ENETUNREACH", host: "CONNECTED" } })).toEqual(["cannot reach the host"]);
    expect(failing({}, { listenerHits: 1 })).toEqual(["cannot reach the host"]);
    // A host folder or the Docker socket shows, or a third disk mount.
    expect(failing({ exists: { ...GOOD.exists, "/Users/me": true } })).toEqual(["sees no host files but its two mounts"]);
    expect(failing({ exists: { "/Users": false } })).toEqual(["sees no host files but its two mounts"]);
    expect(failing({ mounts: [...GOOD.mounts, { point: "/var/run/docker.sock", type: "virtiofs" }] })).toEqual(["sees no host files but its two mounts"]);
    expect(failing({ mounts: GOOD.mounts.filter((m) => m.point !== "/work") })).toEqual(["sees no host files but its two mounts"]);
    // The copy is not the service's (Docker cannot see the stage folder).
    expect(failing({ readIn: false })).toEqual(["reads the copy of the artifact"]);
    expect(failing({}, { workWritten: false })).toEqual(["reads the copy of the artifact"]);
    // A writable root, or an output that does not come back.
    expect(failing({ writes: { ...GOOD.writes, "/etc/probe-x": "OK" } })).toEqual(["writes only to its copy, its output folder and its temporary folders"]);
    expect(failing({ writes: { ...GOOD.writes, "/tmp/probe-x": "EROFS" } })).toEqual(["writes only to its copy, its output folder and its temporary folders"]);
    expect(failing({}, { outputBack: false })).toEqual(["writes only to its copy, its output folder and its temporary folders"]);
    // A terminal of the host: a ttys device, an open pty, or a controlling terminal.
    expect(failing({ dev: [...GOOD.dev, "ttys000"] })).toEqual(["has no terminal of the host"]);
    expect(failing({ pts: ["0", "ptmx"] })).toEqual(["has no terminal of the host"]);
    expect(failing({ tty: "OK" })).toEqual(["has no terminal of the host"]);
    expect(failing({ limits: { ...GOOD.limits, pids: "max" } })).toEqual(["runs within its limits"]);
    expect(failing({ limits: { ...GOOD.limits, swap: "max" } })).toEqual(["runs within its limits"]);
  });

  it("reads the probe's line among whatever else the container printed, and says why when there is none", () => {
    const line = JSON.stringify({ orchestratorProbe: 1, ...GOOD });
    expect(parseProbe(`Unable to find image\n${line}\n`)).toEqual(GOOD);
    expect(parseProbe("")).toBe("the probe printed no result");
    expect(parseProbe("docker: Error response from daemon: no such image")).toBe("the probe printed no result (docker: Error response from daemon: no such image)");
    expect(parseProbe('{"orchestratorProbe":1, broken')).toBe("the probe's result is not JSON");
    expect(parseProbe('{"orchestratorProbe":1,"uid":[1]}')).toBe("the probe's result is missing facts");
  });
});

describe("when recording is unavailable, and why", () => {
  it("no docker command, Docker not running, no recorder image: each says so, and nothing runs", async () => {
    expect(await dockerReady({ docker: join(dir, "no-docker") })).toEqual({ ok: false, reason: `Docker is not installed (${join(dir, "no-docker")} was not found)` });
    const down = standIn("down", { version: 'echo "Cannot connect to the Docker daemon at unix:///x/docker.sock. Is the docker daemon running?" >&2; exit 1' });
    expect(await dockerReady({ docker: down.file })).toEqual({ ok: false, reason: "Docker is not running (start it, for example with colima start): Cannot connect to the Docker daemon at unix:///x/docker.sock. Is the docker daemon running?" });
    const bare = standIn("bare", { image: 'echo "Error: No such image: orchestrator-recorder:1" >&2; exit 1' });
    expect(await dockerReady({ docker: bare.file })).toEqual({ ok: false, reason: "the recorder image orchestrator-recorder:1 is missing: run npm run recorder:build" });
    expect(bare.calls()).toEqual(["version --format {{.Server.Version}}", "image inspect --format {{.Id}} orchestrator-recorder:1"]);
    // The service never builds or pulls: nothing but those two questions was asked.
    expect(bare.calls().some((c) => /^(build|pull|run)/.test(c))).toBe(false);
  });

  it("a container that does not behave fails the probe, with the check and what it saw", async () => {
    const facts = { orchestratorProbe: 1, uid: [10001, 10001, 10001, 10001], caps: ["0", "0", "0", "0", "0"], noNewPrivs: "1", seccomp: "2", pid1: "/usr/local/bin/node", processes: 1, interfaces: ["lo", "eth0"], mounts: [], exists: {}, readIn: true, writes: {}, dev: [], pts: [], tty: "ENXIO", limits: { pids: "512", memory: "1073741824", swap: "0", cpu: "150000 100000" }, connect: { outside: "CONNECTED", host: "ENETUNREACH" } };
    const leaky = standIn("leaky", { run: `echo '${JSON.stringify(facts)}'` });
    const h = await probeRecorder({ docker: leaky.file, root: join(dir, "root") });
    expect(h.ok).toBe(false);
    expect(h.detail).toBe('the recorder\'s container failed the check "has no network but its own loopback" (saw: interfaces lo, eth0; 1.1.1.1:443 CONNECTED)');
    expect(h.checks.find((c) => c.name === "has no network but its own loopback")?.ok).toBe(false);
    // Its stage folder is gone, and the container was removed by name.
    expect(readdirSync(join(dir, "root"))).toEqual([]);
    expect(leaky.calls().filter((c) => c.startsWith("rm --force orc-probe-"))).toHaveLength(1);
    // A probe that prints nothing says so.
    const mute = standIn("mute", { run: "echo 'docker: Error response from daemon: oci runtime error' >&2; exit 125" });
    expect((await probeRecorder({ docker: mute.file, root: join(dir, "root") })).detail).toBe("the recorder's container did not run the probe (exit 125): the probe printed no result (docker: Error response from daemon: oci runtime error)");
  });

  it("a stop kills the container by its name, ends the docker command and removes the container", async () => {
    const slow = standIn("slow", { run: "exec sleep 30" });
    const name = containerName("rec");
    const t0 = Date.now();
    const run = startContainer(slow.file, ["run", "--name", name, "image"], { env: { PATH: process.env.PATH ?? "" }, name });
    await new Promise((r) => setTimeout(r, 300));
    await run.stop();
    const r = await run.done;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.code).toBeNull(); // killed, not finished
    expect(slow.calls()).toEqual([`run --name ${name} image`, `kill ${name}`, `rm --force ${name}`]);
  });
});

describe("the stage folders a crash left (the sweep at the service's start)", () => {
  const HOUR = 60 * 60_000;
  /** A folder (with a file) or a link at root/name, its own time `age` ago. */
  function make(root: string, name: string, age: number, link?: string): string {
    const p = join(root, name);
    if (link) symlinkSync(link, p);
    else {
      mkdirSync(join(p, "work"), { recursive: true });
      writeFileSync(join(p, "work", "tape.tape"), "Output demo.gif");
    }
    const t = new Date(Date.now() - age);
    lutimesSync(p, t, t);
    return p;
  }

  it("removes only old folders the recorder made, by name, and never follows a link", () => {
    const root = join(dir, "recorder");
    const outside = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "not the recorder's");
    make(root, "orc-rec-a1B2c3", 2 * HOUR);
    const probe = make(root, "orc-probe-Zz9yX8", 2 * HOUR);
    // Inside an old stage: a link to a folder outside. The link goes; what it points at stays.
    symlinkSync(outside, join(probe, "work", "escape"));
    make(root, "orc-rec-new000", 5 * 60_000); // a recording that may still run
    make(root, "test-terminal-abc123", 2 * HOUR); // a test's folder
    make(root, "orc-rec-toolong1", 2 * HOUR); // not mkdtemp's six characters
    make(root, "orc-rec-link00", 2 * HOUR, outside); // a link named like a stage
    writeFileSync(join(root, "orc-rec-file00"), "a file named like a stage");

    const r = sweepStages(root);

    expect(r).toEqual({ removed: expect.arrayContaining(["orc-rec-a1B2c3", "orc-probe-Zz9yX8"]), failed: [] });
    expect(r.removed).toHaveLength(2);
    expect(readdirSync(root).sort()).toEqual(["orc-rec-file00", "orc-rec-link00", "orc-rec-new000", "orc-rec-toolong1", "test-terminal-abc123"]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("not the recorder's");
  });

  it("does nothing through a root that is a link, or when there is no root yet", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    make(real, "orc-rec-a1B2c3", 2 * HOUR);
    symlinkSync(real, join(dir, "root-link"));
    expect(sweepStages(join(dir, "root-link"))).toEqual({ removed: [], failed: [] });
    expect(readdirSync(real)).toEqual(["orc-rec-a1B2c3"]);
    expect(sweepStages(join(dir, "missing"))).toEqual({ removed: [], failed: [] });
  });

  it("a folder younger than the age, an hour by default, stays; the age counts from the folder's own time", () => {
    const root = join(dir, "recorder");
    mkdirSync(root);
    make(root, "orc-rec-a1B2c3", 30 * 60_000);
    expect(sweepStages(root).removed).toEqual([]);
    expect(STAGE_SWEEP_AGE_MS).toBe(HOUR);
    expect(sweepStages(root, { minAgeMs: 10 * 60_000 }).removed).toEqual(["orc-rec-a1B2c3"]);
  });
});

// ---------- with Docker and the recorder's image ----------

const ready = await dockerReady();
const skip = ready.ok ? "" : ` (skipped: ${ready.reason})`;
mkdirSync(defaultRecorderRoot(), { recursive: true });
const ROOT = mkdtempSync(join(defaultRecorderRoot(), "test-container-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe(`the real container${skip}`, () => {
  it.skipIf(!ready.ok)(
    "passes every check of the probe, and leaves nothing behind",
    async () => {
      const h = await probeRecorder({ root: ROOT, fresh: true });
      expect(h.checks.filter((c) => !c.ok)).toEqual([]);
      expect(h.ok).toBe(true);
      expect(h.checks).toHaveLength(10);
      expect(readdirSync(ROOT)).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!ready.ok)(
    "a docker that drops the isolation (the network, the read-only root, the capabilities) fails the probe",
    async () => {
      if (!ready.ok) return;
      // Passes everything else to the real docker.
      const loose = join(dir, "loose-docker");
      writeFileSync(
        loose,
        `#!/bin/bash
args=()
skip=0
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  case "$a" in
    --network|--cap-drop) skip=1 ;;
    --read-only) ;;
    *) args+=("$a") ;;
  esac
done
exec ${JSON.stringify(ready.docker)} "\${args[@]}"
`,
      );
      chmodSync(loose, 0o755);
      const h = await probeRecorder({ docker: loose, root: ROOT });
      expect(h.ok).toBe(false);
      const failed = h.checks.filter((c) => !c.ok).map((c) => c.name);
      expect(failed).toEqual(expect.arrayContaining(["has no capabilities and cannot gain privileges", "has no network but its own loopback", "cannot reach the host", "writes only to its copy, its output folder and its temporary folders"]));
      expect(h.detail).toMatch(/^the recorder's container failed the check "has no capabilities/);
    },
    60_000,
  );
});
