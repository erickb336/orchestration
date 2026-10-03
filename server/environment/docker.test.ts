// The environment's docker argument lists, and the copies on disk: no Docker runs here.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE, ENV_USER, PROXY_IMAGE, WORK, buildArgs, commitArgs, networkArgs, phaseArgs, proxyArgs } from "./docker";
import { addedEntries, cloneEntries, copyWorktree, listTree, prepareInputs, prepareKey, removeTree } from "./copy";

/** The value after each occurrence of a flag, among docker's own options (before the image). */
const IMAGES = /^(python:|node:)/;
const values = (args: string[], flag: string) => {
  const opts = args.findIndex((a) => IMAGES.test(a));
  return args.slice(0, opts < 0 ? undefined : opts).flatMap((a, i, xs) => (a === flag ? [xs[i + 1]] : []));
};

describe("the argument lists", () => {
  const base = { name: "orc-env-prep-1-abc", image: "python:3.13@sha256:" + "a".repeat(64), work: "/Users/me/.cache/orchestrator/environment/p/runs/a1/work", cache: "/Users/me/.cache/orchestrator/environment/p/cache", argv: ["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"] };

  it("prepare: the private network only, through the proxy, hardened, two mounts, kept for its commit", () => {
    const args = phaseArgs({ ...base, phase: { kind: "prepare", privateNet: "orc-env-net-1-abc", proxy: "orc-env-proxy-1-abc" } });
    expect(values(args, "--network")).toEqual(["orc-env-net-1-abc"]);
    expect(values(args, "--env")).toContain("HTTPS_PROXY=http://orc-env-proxy-1-abc:3128");
    expect(values(args, "--env")).toContain("HOME=/var/tmp/home");
    expect(values(args, "--env")).toContain("XDG_CACHE_HOME=/cache/xdg");
    expect(values(args, "--mount")).toEqual([`type=bind,source=${base.work},target=${WORK}`, `type=bind,source=${base.cache},target=${CACHE}`]);
    expect(values(args, "--user")).toEqual([ENV_USER]);
    expect(values(args, "--cap-drop")).toEqual(["ALL"]);
    expect(values(args, "--security-opt")).toEqual(["no-new-privileges"]);
    // Not removed when it ends: the service commits what it wrote outside its mounts, then removes it.
    expect(args).not.toContain("--rm");
    expect(values(args, "--tmpfs")).toEqual(["/tmp:rw,exec,nosuid,nodev,size=536870912"]);
    expect(values(args, "--pids-limit")).toEqual(["1024"]);
    expect(values(args, "--memory")).toEqual(values(args, "--memory-swap"));
    expect(values(args, "--pull")).toEqual(["never"]);
    expect(args).not.toContain("--add-host");
    expect(args).not.toContain("--privileged");
    expect(args.join(" ")).not.toMatch(/docker\.sock|SSH_AUTH|TOKEN|API_KEY/);
    // The program replaces the image's entrypoint; its arguments follow the image.
    expect(values(args, "--entrypoint")).toEqual(["python3"]);
    expect(args.slice(args.indexOf(base.image) + 1)).toEqual(base.argv.slice(1));
  });

  it("run: --network none, no proxy, the copy as its only mount, removed when it ends", () => {
    const args = phaseArgs({ ...base, cache: undefined, argv: ["python3", "-m", "pytest"], phase: { kind: "run" } });
    expect(values(args, "--network")).toEqual(["none"]);
    expect(values(args, "--env").filter((e) => /PROXY=./i.test(e))).toEqual([]);
    expect(values(args, "--env")).toContain("HTTPS_PROXY=");
    expect(values(args, "--mount")).toEqual([`type=bind,source=${base.work},target=${WORK}`]);
    expect(args).toContain("--rm");
    expect(values(args, "--user")).toEqual([ENV_USER]);
    expect(values(args, "--cap-drop")).toEqual(["ALL"]);
  });

  it("an ended prepare container becomes the next image", () => {
    expect(commitArgs("orc-env-prep-1-abc")).toEqual(["commit", "--change", "LABEL orchestrator.environment=prepared", "orc-env-prep-1-abc"]);
    expect(() => commitArgs("-x")).toThrow(/not a container name/);
  });

  it("refuses a mount path, a name or a command it cannot pass safely", () => {
    expect(() => phaseArgs({ ...base, work: "/a,b", phase: { kind: "run" } })).toThrow(/cannot mount/);
    expect(() => phaseArgs({ ...base, name: "--privileged", phase: { kind: "run" } })).toThrow(/not a container name/);
    expect(() => phaseArgs({ ...base, image: "--privileged", phase: { kind: "run" } })).toThrow(/not an image/);
    expect(() => phaseArgs({ ...base, argv: ["--entrypoint=sh"], phase: { kind: "run" } })).toThrow(/not a command/);
  });

  it("the private network has no route out and no gateway address; the egress network is plain", () => {
    expect(networkArgs("orc-env-net-1-abc", "private")).toEqual(["network", "create", "--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "--opt", "com.docker.network.bridge.gateway_mode_ipv6=isolated", "--label", "orchestrator.environment=private", "orc-env-net-1-abc"]);
    expect(networkArgs("orc-env-out-1-abc", "egress")).toEqual(["network", "create", "--label", "orchestrator.environment=egress", "orc-env-out-1-abc"]);
  });

  it("the proxy joins both networks, in the pinned Node image, with the hosts as its configuration", () => {
    const args = proxyArgs({ name: "orc-env-proxy-1-abc", privateNet: "orc-env-net-1-abc", egressNet: "orc-env-out-1-abc", hosts: ["pypi.org"], script: "/* proxy */" });
    expect(values(args, "--network")).toEqual(["orc-env-net-1-abc", "orc-env-out-1-abc"]);
    expect(values(args, "--env")).toEqual(['ORC_PROXY_CONFIG={"hosts":["pypi.org"],"ports":[443],"port":3128}']);
    expect(args.slice(args.indexOf(PROXY_IMAGE))).toEqual([PROXY_IMAGE, "--input-type=module", "--eval", "/* proxy */"]);
    expect(values(args, "--user")).toEqual([ENV_USER]);
    expect(args).not.toContain("--mount");
  });

  it("a dev container's Dockerfile builds with no network for its RUN steps", () => {
    expect(buildArgs({ tag: "orc-env-p:0123456789ab", dockerfile: "/s/Dockerfile", context: "/s/work" })).toEqual(["build", "--network", "none", "--label", "orchestrator.environment=build", "--tag", "orc-env-p:0123456789ab", "--file", "/s/Dockerfile", "/s/work"]);
  });
});

describe("the copies", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) removeTree(d);
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "orc-env-test-"));
    dirs.push(d);
    return d;
  };

  it("copies a worktree without .git, keeps links as links, and finds what prepare added as whole entries", () => {
    const src = tmp();
    mkdirSync(join(src, ".git"));
    mkdirSync(join(src, "pkg/a"), { recursive: true });
    writeFileSync(join(src, "package.json"), "{}");
    writeFileSync(join(src, "pkg/a/package.json"), '{"a":1}');
    symlinkSync("/etc/passwd", join(src, "link"));
    const dst = join(tmp(), "copy");
    copyWorktree(src, dst);
    expect(existsSync(join(dst, ".git"))).toBe(false);
    expect(readlinkSync(join(dst, "link"))).toBe("/etc/passwd");
    const before = listTree(dst);
    mkdirSync(join(dst, "node_modules/ms"), { recursive: true });
    writeFileSync(join(dst, "node_modules/ms/index.js"), "");
    mkdirSync(join(dst, "pkg/a/node_modules"));
    writeFileSync(join(dst, "pkg/a/package.json"), "changed");
    expect(addedEntries(dst, before)).toEqual(["node_modules", "pkg/a/node_modules"]);
    expect(prepareInputs(src, listTree(src)).map((i) => i.path)).toEqual(["package.json", "pkg/a/package.json"]);
  });

  it("keys a prepare by its image, commands, hosts and inputs", () => {
    const k = (o: Partial<Parameters<typeof prepareKey>[0]> = {}) => prepareKey({ imageId: "sha256:1", prepare: [["npm", "ci"]], hosts: ["a.org", "b.org"], inputs: [{ path: "package-lock.json", sha256: "x" }], ...o });
    expect(k()).toMatch(/^[0-9a-f]{16}$/);
    expect(k({ hosts: ["b.org", "a.org"] })).toBe(k());
    expect(k({ imageId: "sha256:2" })).not.toBe(k());
    expect(k({ prepare: [["npm", "install"]] })).not.toBe(k());
    expect(k({ inputs: [{ path: "package-lock.json", sha256: "y" }] })).not.toBe(k());
  });

  it("clones prepared entries into a new copy, never below a link, and removes read-only folders", () => {
    const from = tmp();
    mkdirSync(join(from, "node_modules/x"), { recursive: true });
    writeFileSync(join(from, "node_modules/x/i.js"), "1");
    mkdirSync(join(from, "linked/node_modules"), { recursive: true });
    const to = tmp();
    const outside = tmp();
    symlinkSync(outside, join(to, "linked"));
    expect(cloneEntries(from, to, ["node_modules", "linked/node_modules", "../escape"])).toEqual(["node_modules"]);
    expect(existsSync(join(outside, "node_modules"))).toBe(false);
    chmodSync(join(to, "node_modules/x"), 0o555);
    removeTree(to);
    expect(existsSync(to)).toBe(false);
  });
});
