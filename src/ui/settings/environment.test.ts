// Settings › Project › Environment, pure: the form and the command it sends, "Use this image", "Add a host", where the
// environment comes from, and the last prepare's line.

import { describe, expect, it } from "vitest";
import { buildSeed } from "../../domain/seed";
import type { State } from "../../domain/types";
import { addHost, environmentInput, environmentProblem, environmentSteps, lastPrepareLine, liveEnvironment, sourceLine, takeProposal } from "./environment";

const PINNED = "python:3.13-slim-trixie@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81";
const empty = { envImage: "", envPrepare: "", envHosts: [] as string[] };

describe("the environment form", () => {
  it("reads the setting, and saves one command per line as argument lists", () => {
    const s = buildSeed(Date.parse("2026-10-02T12:00:00Z"), { inFlightRuns: false });
    expect(liveEnvironment(s)).toEqual(empty);
    s.project.environment = { rev: 1, image: PINNED, prepare: [["sh", "-c", "make deps"]], hosts: ["pkgs.example.com"] };
    const v = liveEnvironment(s);
    expect(v).toEqual({ envImage: PINNED, envPrepare: 'sh -c "make deps"', envHosts: ["pkgs.example.com"] });
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
  it("the dev container comes first; then the confirmed image; else the checks run on this computer", () => {
    const dc = { ref: "main", devcontainer: { file: ".devcontainer/devcontainer.json", image: "node:22" } };
    expect(sourceLine(dc, { ...empty, envImage: PINNED })).toMatchObject({ label: "Dev container", tone: "done" });
    expect(sourceLine({ ref: "main" }, { ...empty, envImage: PINNED })).toMatchObject({ label: "Confirmed image", text: expect.stringMatching(/sha256:bb2988715db2…/) });
    expect(sourceLine({ ref: "main", devcontainer: { file: ".devcontainer.json", refused: "It uses Docker Compose." } }, empty)).toMatchObject({ label: "Not set up", tone: "fail", text: expect.stringMatching(/^It uses Docker Compose\. Checks run on this computer/) });
  });

  it("the last prepare: ran, reused, or on this computer and why", () => {
    const s = buildSeed(Date.parse("2026-10-02T12:00:00Z"), { inFlightRuns: false }) as State;
    expect(lastPrepareLine(s)).toBeUndefined();
    const art = (at: string, environment: NonNullable<NonNullable<State["artifacts"][number]["checkRun"]>["environment"]>) => ({ id: `c-${at}`, taskId: "T1", stepId: "C1", attemptId: `a-${at}`, name: "checks", kind: "check-results" as const, version: 1, summary: "", createdAt: at, checkRun: { sha: "a".repeat(40), configRev: 1, sandbox: "codex" as const, touchedInputs: [], results: [], durationMs: 1, environment } });
    s.artifacts.push(art("2026-10-02T12:01:00Z", { ran: "container", from: "setting", image: PINNED, prepare: "ran", key: "0123456789abcdef", prepareMs: 2300, refused: ["example.com (not on the list of registries)"] }));
    expect(lastPrepareLine(s)).toMatch(/prepared in 2\.3 s, in python:3\.13-slim-trixie@sha256:bb2988715db2…\. The proxy refused: example\.com/);
    s.artifacts.push(art("2026-10-02T12:02:00Z", { ran: "host", reason: "Docker is not running" }));
    expect(lastPrepareLine(s)).toMatch(/on this computer, because Docker is not running\.$/);
  });
});
