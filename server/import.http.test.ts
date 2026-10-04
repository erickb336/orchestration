// ORC-032 over HTTP: what the import's Start screen reads from a repository (real mode, read-only, nothing saved), the
// bundled sample for the demo (the fake runtime only), and the capture's files, served like a capture of evidence.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImportStartInfo } from "../src/api";
import { buildEmptyProject } from "../src/domain/seed";
import { tallyImport } from "../src/domain/testing/import";
import type { State } from "../src/domain/types";
import { createHttpServer } from "./http";
import { FakeAdapter } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { TALLY_FIXTURE, captureDir, tallyRepo } from "./studio/import";
import { close } from "./studio/testFixtures";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

const HOST = "orchestrator.test";
let dir: string;
let server: Server | undefined;
let scheduler: Scheduler | undefined;
let store: Store | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-http-"));
});
afterEach(async () => {
  await scheduler?.stop();
  if (server) await close(server);
  store?.close();
  server = scheduler = store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A service on `state`: real mode (scripted adapters and a workspace manager) or the fake runtime. */
async function serve(state: State, mode: "real" | "fake") {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  store = new Store(join(dataDir, "db.sqlite"), () => structuredClone(state));
  const workspaces = mode === "real" ? new WorkspaceManager(join(dir, "worktrees")) : undefined;
  const adapters = mode === "real" ? { claude: new ScriptedAdapter("claude"), codex: new ScriptedAdapter("codex") } : { claude: new FakeAdapter("claude"), codex: new FakeAdapter("codex") };
  scheduler = new Scheduler(store, adapters, { workspaces, dataDir });
  server = createHttpServer({ store, scheduler, workspaces, dataDir, startedAt: new Date().toISOString(), allowedHosts: [HOST] });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return dataDir;
}

function call(path: string, body?: unknown): Promise<{ status: number; type: string; text: string }> {
  const port = (server!.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, ...(body === undefined ? {} : { "content-type": "application/json", "x-orchestration-client": "1" }) };
    const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const json = async (path: string, body?: unknown) => JSON.parse((await call(path, body)).text) as ImportStartInfo & { error?: string };

describe("the Start screen's facts (GET /api/import/start)", () => {
  it("reads the repository at HEAD: its commit, branch, size, the kinds it shows, how it runs and the estimate; it changes nothing", async () => {
    const repo = tallyRepo(join(dir, "tally"));
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await serve(buildEmptyProject(Date.now()), "real");
    const info = await json(`/api/import/start?path=${encodeURIComponent(repo)}`);
    expect(info).toMatchObject({
      ok: true,
      path: repo,
      commit: head,
      branch: "main",
      size: { sourceFiles: 7, testFiles: 7 },
      domains: [{ domain: "screen", device: "terminal", because: "tally/__main__.py: a command-line entry" }],
      proposal: { label: "Python", because: "requirements.txt", prepare: [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]] },
      checks: [],
      // The README's Tests section shows the command and where it writes its JUnit report.
      testReport: { command: { id: "test", label: "Tests with a JUnit report", kind: "check", argv: ["python3", "tests/run.py"] }, path: "reports/junit.xml", because: "The README's Tests section" },
    });
    if (!info.ok) throw new Error(info.reason);
    expect(info.estimate.usd[0]).toBeGreaterThan(0);
    expect(info.estimate.basis).toMatch(/^7 source files, 7 test files/);
    // Nothing is saved: the project is as it was.
    expect(store!.read().state.project.repoPath).toBe("");
  });

  it("refuses a path that is not a repository; reads one whose git config sets a filter, and runs no filter (SR-2)", async () => {
    await serve(buildEmptyProject(Date.now()), "real");
    expect(await json(`/api/import/start?path=${encodeURIComponent(join(dir, "nothing"))}`)).toEqual({ ok: false, reason: `Repository path ${join(dir, "nothing")} does not exist.` });
    const repo = tallyRepo(join(dir, "tally"));
    const marker = join(dir, "the-filter-ran");
    writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(dir, "evil.sh"), `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
    execFileSync("git", ["-C", repo, "config", "--local", "filter.evil.smudge", join(dir, "evil.sh")]);
    execFileSync("git", ["-C", repo, "config", "--local", "filter.evil.clean", join(dir, "evil.sh")]);
    expect(await json(`/api/import/start?path=${encodeURIComponent(repo)}`)).toMatchObject({ ok: true, path: repo });
    expect(existsSync(marker)).toBe(false);
  });

  it("with the simulated runtime, reads no repository of yours", async () => {
    await serve(buildEmptyProject(Date.now()), "fake");
    expect(await json(`/api/import/start?path=${encodeURIComponent(dir)}`)).toEqual({ ok: false, reason: "The simulated runtime reads no repository of yours: import the bundled sample, tally, instead." });
  });
});

describe("the bundled sample (POST /api/import/demo)", () => {
  it("makes tally in the service's data folder, once, and gives its facts, labelled the sample; the simulated runtime only", async () => {
    const dataDir = await serve(buildEmptyProject(Date.now()), "fake");
    const info = await json("/api/import/demo", {});
    expect(info).toMatchObject({ ok: true, demo: true, path: join(dataDir, "import-demo", "tally"), branch: "main", domains: [{ domain: "screen", device: "terminal" }], proposal: { label: "Python" } });
    // Made once: a second call gives the same repository at the same commit.
    const again = await json("/api/import/demo", {});
    expect(again.ok && info.ok && again.commit === info.commit).toBe(true);
    await close(server!);
    await scheduler!.stop();
    store!.close();
    await serve(buildEmptyProject(Date.now()), "real");
    const real = await call("/api/import/demo", {});
    expect([real.status, JSON.parse(real.text).error]).toEqual([400, "The sample import is for the simulated runtime. Give the path of your repository instead."]);
  });
});

describe("the capture's files (GET /api/studio/file?evidence=<import>)", () => {
  it("serves a file the import's capture recorded, and nothing else", async () => {
    const { s, importId, parts } = tallyImport("review");
    const dataDir = await serve(s, "fake");
    const path = `${parts.add}/demo.cast`;
    mkdirSync(join(captureDir(dataDir, s.project.id, importId), parts.add!), { recursive: true });
    writeFileSync(join(captureDir(dataDir, s.project.id, importId), path), readFileSync(join(TALLY_FIXTURE, "casts", "add.cast")));
    const ok = await call(`/api/studio/file?evidence=${importId}&path=${encodeURIComponent(path)}`);
    expect([ok.status, ok.type, ok.text.split("\n")[0]]).toEqual([200, "text/plain; charset=utf-8", readFileSync(join(TALLY_FIXTURE, "casts", "add.cast"), "utf8").split("\n")[0]]);
    expect((await call(`/api/studio/file?evidence=${importId}&path=${encodeURIComponent(`${parts.add}/other.cast`)}`)).status).toBe(404);
    expect((await call(`/api/studio/file?evidence=import-99&path=${encodeURIComponent(path)}`)).status).toBe(404);
  });
});
