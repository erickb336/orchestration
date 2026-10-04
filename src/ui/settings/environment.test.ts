// Settings › How your project runs › Environment, pure: the form and the command it sends, "Use this image", "Add a
// host", where the environment comes from, what a dev container sets before you confirm it, and the last prepare's line.

import { describe, expect, it } from "vitest";
import { REGISTRY_HOSTS } from "../../domain/environment";
import { buildSeed } from "../../domain/seed";
import type { State } from "../../domain/types";
import { addHost, confirmDevcontainer, devcontainerFacts, environmentInput, environmentProblem, environmentSteps, lastPrepareLine, liveEnvironment, sourceLine, takeProposal } from "./environment";

const PINNED = "python:3.13-slim-trixie@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81";
const empty = { envImage: "", envPrepare: "", envHosts: [] as string[], envDevcontainer: "" };

describe("the environment form", () => {
  it("reads the setting, and saves one command per line as argument lists", () => {
    const s = buildSeed(Date.parse("2026-10-02T12:00:00Z"), { inFlightRuns: false });
    expect(liveEnvironment(s)).toEqual(empty);
    s.project.environment = { rev: 1, image: PINNED, prepare: [["sh", "-c", "make deps"]], hosts: ["pkgs.example.com"] };
    const v = liveEnvironment(s);
    expect(v).toEqual({ envImage: PINNED, envPrepare: 'sh -c "make deps"', envHosts: ["pkgs.example.com"], envDevcontainer: "" });
    expect(environmentInput({ ...v, envPrepare: 'sh -c "make deps"\n\n go mod download ' })).toEqual({ image: PINNED, prepare: [["sh", "-c", "make deps"], ["go", "mod", "download"]], hosts: ["pkgs.example.com"] });
    expect(environmentInput(empty)).toBeNull();
  });

  it("shows the domain's refusal and sends setEnvironment only when a field changed", async () => {
    expect(environmentProblem({ ...empty, envImage: "python:3.13" })).toMatch(/not pinned by digest/);
    expect(environmentProblem({ ...empty, envImage: PINNED })).toBeUndefined();
    const sent: [string, object][] = [];
    const send = async (name: "setEnvironment", args: object) => (sent.push([name, args]), { ok: true as const });
    expect(environmentSteps({ ...empty, envImage: PINNED }, new Set(["repoPath"]), send as never)).toEqual([]);
    for (const step of environmentSteps({ ...empty, envImage: PINNED }, new Set(["envImage"]), send as never)) await step();
    expect(sent).toEqual([["setEnvironment", { environment: { image: PINNED, prepare: [], hosts: [] } }]]);
  });

  it("Use this image fills the image, and the prepare commands only when there are none", () => {
    const p = { label: "Python", image: PINNED, prepare: [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]], because: "requirements.txt" };
    expect(takeProposal(empty, p)).toEqual({ envImage: PINNED, envPrepare: "python3 -m pip install --user -r requirements.txt" });
    expect(takeProposal({ ...empty, envPrepare: "make" }, p)).toEqual({ envImage: PINNED });
  });

  it("Add a host takes a host name, and refuses an address, a local name or a registry already allowed", () => {
    expect(addHost(empty, " Pkgs.Example.com ")).toEqual({ hosts: ["pkgs.example.com"] });
    expect(addHost(empty, "10.0.0.1")).toEqual({ refused: expect.stringMatching(/IP address/) });
    expect(addHost(empty, "host.docker.internal")).toEqual({ refused: expect.stringMatching(/local network/) });
    expect(addHost(empty, "pypi.org")).toEqual({ refused: "pypi.org is already allowed." });
  });
});

describe("the card's lines", () => {
  it("the confirmed dev container comes first; then the confirmed image; else the checks run on this computer", () => {
    const SHA = "f".repeat(64);
    const dc = { ref: "main", devcontainer: { file: ".devcontainer/devcontainer.json", image: "node:22", sha256: SHA } };
    const saved = (o: object = {}) => ({ rev: 1, image: PINNED, prepare: [], hosts: [], ...o });
    expect(sourceLine(dc, saved({ devcontainer: { file: dc.devcontainer.file, sha256: SHA } }))).toMatchObject({ label: "Dev container", tone: "done" });
    expect(sourceLine({ ref: "main" }, saved())).toMatchObject({ label: "Confirmed image", text: expect.stringMatching(/sha256:bb2988715db2…/) });
    expect(sourceLine({ ref: "main", devcontainer: { file: ".devcontainer.json", refused: "It uses Docker Compose." } }, undefined)).toMatchObject({ label: "Not set up", tone: "fail", text: expect.stringMatching(/^It uses Docker Compose\. Checks run on this computer/) });
  });

  it("a dev container the owner has not confirmed is not used, and the card asks for it (review finding 3)", () => {
    const SHA = "f".repeat(64);
    const dc = { ref: "main", devcontainer: { file: ".devcontainer/devcontainer.json", image: "node:22", sha256: SHA } };
    expect(sourceLine(dc, { rev: 1, image: PINNED, prepare: [], hosts: [] })).toMatchObject({ label: "Dev container not confirmed", tone: "fail", text: expect.stringMatching(/not used until you confirm it.*The checks use .*sha256:bb2988715db2…/) });
    expect(sourceLine(dc, undefined)).toMatchObject({ label: "Dev container not confirmed", text: expect.stringMatching(/Checks run on this computer/) });
    expect(sourceLine(dc, { rev: 1, prepare: [], hosts: [], devcontainer: { file: dc.devcontainer.file, sha256: "0".repeat(64) } })).toMatchObject({ label: "Dev container not confirmed", text: expect.stringMatching(/changed since you confirmed it/) });
    // "Confirm this dev container" puts its digest in the form; Save sends it with the rest of the setting.
    const v = { ...empty, ...confirmDevcontainer(dc.devcontainer) };
    expect(environmentInput(v)).toEqual({ prepare: [], hosts: [], devcontainer: { file: dc.devcontainer.file, sha256: SHA } });
    const s = buildSeed(Date.parse("2026-10-02T12:00:00Z"), { inFlightRuns: false });
    s.project.environment = { rev: 1, prepare: [], hosts: [], devcontainer: { file: dc.devcontainer.file, sha256: SHA } };
    expect(liveEnvironment(s).envDevcontainer).toBe(v.envDevcontainer);
  });

  it("Confirm this dev container says what it sets in plain words, and never shows its digest (a-settings-devcontainer)", () => {
    const SHA = "f".repeat(64);
    const image = { file: ".devcontainer/devcontainer.json", image: "node:22-bookworm", sha256: SHA };
    const reach = `the ${REGISTRY_HOSTS.length} package registries, through a proxy. The checks and the evidence run with no network.`;
    expect(devcontainerFacts(image, { ...empty, envPrepare: "npm ci\nnpm run build" }, [])).toEqual([
      { label: "Image", text: "node:22-bookworm" },
      { label: "Prepare commands", text: "npm ci, then npm run build (yours, below)" },
      { label: "Installs may reach", text: reach },
    ]);
    // A Dockerfile build: the file and its base images; without prepare commands of your own, the checks' own run.
    const build = { file: ".devcontainer/devcontainer.json", dockerfile: ".devcontainer/Dockerfile", context: ".", bases: ["python:3.13-slim", "golang:1.26"], sha256: SHA };
    const facts = devcontainerFacts(build, { ...empty, envHosts: ["pkgs.example.com"] }, [["python3", "-m", "pip", "install", "-r", "requirements.txt"]]);
    expect(facts.map((f) => `${f.label}: ${f.text}`)).toEqual([
      "Builds from: .devcontainer/Dockerfile, based on python:3.13-slim and golang:1.26",
      "Prepare commands: python3 -m pip install -r requirements.txt (the checks' own, because you set none below)",
      `Installs may reach: the ${REGISTRY_HOSTS.length} package registries and pkgs.example.com, through a proxy. The checks and the evidence run with no network.`,
    ]);
    expect(devcontainerFacts(image, empty, [])[1].text).toBe("none: nothing is installed");
    expect(JSON.stringify([...facts, ...devcontainerFacts(image, empty, [])])).not.toContain(SHA.slice(0, 8));
  });

  it("the last prepare: ran, reused, or on this computer and why", () => {
    const s = buildSeed(Date.parse("2026-10-02T12:00:00Z"), { inFlightRuns: false }) as State;
    expect(lastPrepareLine(s)).toBeUndefined();
    const art = (at: string, environment: NonNullable<NonNullable<State["artifacts"][number]["checkRun"]>["environment"]>) => ({ id: `c-${at}`, taskId: "T1", stepId: "C1", attemptId: `a-${at}`, name: "checks", kind: "check-results" as const, version: 1, summary: "", createdAt: at, checkRun: { sha: "a".repeat(40), configRev: 1, sandbox: "codex" as const, touchedInputs: [], results: [], durationMs: 1, environment } });
    s.artifacts.push(art("2026-10-02T12:01:00Z", { ran: "container", from: "setting", image: PINNED, prepare: "ran", key: "0123456789abcdef", prepareMs: 2300, refused: ["example.com (not on the list of registries)"] }));
    expect(lastPrepareLine(s)).toMatch(/prepared in 2\.3 s, in python:3\.13-slim-trixie@sha256:bb2988715db2…\. The proxy refused: example\.com/);
    s.artifacts.push(art("2026-10-02T12:02:00Z", { ran: "host", reason: "Docker is not running" }));
    expect(lastPrepareLine(s)).toMatch(/on this computer, because Docker is not running\.$/);
    // Review finding 8: the checks' own prepare commands, and no prepare at all, are said as such, never "prepared in 0.0 s".
    s.artifacts.push(art("2026-10-02T12:03:00Z", { ran: "container", from: "devcontainer", image: PINNED, prepare: "ran", prepareFrom: "checks", key: "0123456789abcdef", prepareMs: 4100 }));
    expect(lastPrepareLine(s)).toMatch(/prepared in 4\.1 s with the checks' own prepare commands, because the environment has none,/);
    s.artifacts.push(art("2026-10-02T12:04:00Z", { ran: "container", from: "devcontainer", image: PINNED, prepare: "none", key: "0123456789abcdef", prepareMs: 0 }));
    expect(lastPrepareLine(s)).toMatch(/no prepare command ran: the environment and the checks have none\. Set them above if the checks need dependencies\./);
    expect(lastPrepareLine(s)).not.toMatch(/prepared in/);
  });
});
