// What the service says when it cannot read the project's repository (ORC-030 QA, Q-16): the sample project has
// none, and a project of your own may have none set yet. One message served both, so a new real project was told it
// is "the sample project". Real mode (a runtime that is not the fake one), with no agent run.

import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEmptyProject, buildSeed } from "../src/domain/seed";
import type { State } from "../src/domain/types";
import { createHttpServer } from "./http";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";
import { close } from "./studio/testFixtures";

const HOST = "orchestrator.test";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-http-repo-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** GET a JSON path from a real-mode service on `state`. */
async function get(state: State, path: string): Promise<{ reason?: string }> {
  const store = new Store(join(dir, `${Math.random()}.db`), () => structuredClone(state));
  const workspaces = new WorkspaceManager(join(dir, "worktrees"));
  const scheduler = new Scheduler(store, { claude: new ScriptedAdapter("claude"), codex: new ScriptedAdapter("codex") }, { workspaces });
  const server = createHttpServer({ store, scheduler, workspaces, startedAt: new Date().toISOString(), allowedHosts: [HOST] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    return await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host: HOST } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(JSON.parse(body)));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await scheduler.stop();
    await close(server);
    store.close();
  }
}

describe("a repository the service cannot read", () => {
  it("a project of your own with no repository yet: it says to give the path, never that it is the sample", async () => {
    const empty = buildEmptyProject(Date.now());
    expect(empty.project).toMatchObject({ repoPath: "" });
    expect(empty.project.sample).toBeFalsy();
    expect((await get(empty, "/api/environment/found")).reason).toBe("No repository is set yet: give its path in Settings › Project.");
    expect((await get(empty, "/api/checks/suggest")).reason).toBe("No repository is set yet: give its path in Settings › Project.");
  });

  it("a dev container that builds from a Dockerfile: the route names the file and its base images, for the owner to confirm (ORC-030 C3)", async () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".devcontainer"), { recursive: true });
    writeFileSync(join(repo, ".devcontainer", "devcontainer.json"), JSON.stringify({ build: { dockerfile: "Dockerfile" } }));
    writeFileSync(join(repo, ".devcontainer", "Dockerfile"), "FROM python:3.13-slim AS base\nRUN pip install uv\nFROM base\n");
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "dev container");
    const s = buildEmptyProject(Date.now());
    s.project.repoPath = repo;
    const found = (await get(s, "/api/environment/found")) as { devcontainer?: Record<string, unknown> };
    expect(found.devcontainer).toMatchObject({ file: ".devcontainer/devcontainer.json", dockerfile: ".devcontainer/Dockerfile", bases: ["python:3.13-slim"], sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("the sample project: it is the sample, with no repository to read", async () => {
    const sample = buildSeed(Date.now(), { inFlightRuns: false });
    expect(sample.project.sample).toBe(true);
    expect((await get(sample, "/api/environment/found")).reason).toBe("This is the sample project; start a project of your own to read its repository.");
    expect((await get(sample, "/api/checks/suggest")).reason).toBe("This is the sample project; start a project of your own to read its repository.");
  });
});
