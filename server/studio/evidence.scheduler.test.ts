// ORC-029 pass 5, the Capture evidence step through the scheduler, with scripted agents and a scripted capture runner
// on a temporary repository: E1 starts after the checks on a read-only worktree at the coder's commit, with the cited
// items and the preview setting; its report becomes the evidence artifact; its worktree goes; the UX review then reads
// the built files beside the approved design's, which its run may read. A pause stops a capture, and Resume runs it
// again. Without a preview setting nothing starts and every item says "not set up". Where Docker and the recorder's
// image are there, the same step captures the fixture app for real. No model runs.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as M from "../../src/domain/model";
import * as E from "../../src/domain/studio/evidence";
import { startFactoryArgs } from "../../src/domain/testing/factory";
import type { AdapterEvent } from "../runtimes/types";
import type { BlueprintItem } from "../../src/domain/studio/types";
import type { SpecContent, State } from "../../src/domain/types";
import { createHttpServer } from "../http";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { ScriptedAdapter } from "../testing/scripted";
import { WorkspaceManager } from "../workspaces";
import { dockerReady } from "./container";
import { CAPTURE_PLAN, ContainerEvidence, type EvidenceAssignment, type EvidenceRunner } from "./evidence";

vi.setConfig({ testTimeout: 30_000 });

/** Tests decide when a capture completes or confirms a stop. Nothing is spawned. */
class ScriptedEvidence implements EvidenceRunner {
  readonly simulated = false;
  runs = new Map<string, EvidenceAssignment>();
  started: EvidenceAssignment[] = [];
  interrupts: string[] = [];
  private listeners = new Set<(e: AdapterEvent) => void>();
  start(a: EvidenceAssignment) {
    if (this.runs.has(a.attemptId)) return;
    this.runs.set(a.attemptId, a);
    this.started.push(a);
    this.emit({ type: "started", attemptId: a.attemptId });
  }
  interrupt(id: string) {
    if (!this.interrupts.includes(id)) this.interrupts.push(id);
  }
  kill(id: string) {
    this.runs.delete(id);
  }
  has(id: string) {
    return this.runs.has(id);
  }
  ids() {
    return [...this.runs.keys()];
  }
  onEvent(l: (e: AdapterEvent) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  async shutdown() {
    this.runs.clear();
  }
  emit(e: AdapterEvent) {
    if (e.type === "completed" || e.type === "failed" || e.type === "stopped") this.runs.delete(e.attemptId);
    for (const l of this.listeners) l(e);
  }
  /** Complete a capture: each item captured on desktop, its PNG written into the run's evidence folder. */
  finish(id: string) {
    const a = this.runs.get(id)!;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    const items: E.ItemCapture[] = a.items.map((i) => {
      mkdirSync(join(a.outDir, i.itemId), { recursive: true });
      writeFileSync(join(a.outDir, i.itemId, "desktop.png"), png);
      return { ...i, status: "captured", files: [{ path: `${i.itemId}/desktop.png`, type: "png", device: "desktop", bytes: png.length, sha256: "d".repeat(64) }] };
    });
    this.emit({ type: "completed", attemptId: id, finalText: "", evidence: { sha: a.sha, at: new Date().toISOString(), durationMs: 1234, previewRev: a.preview.rev, items } });
  }
  stopped(id: string) {
    this.emit({ type: "stopped", attemptId: id, how: "interrupted" });
  }
}

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let evidence: EvidenceRunner;
let scheduler: Scheduler;
let now = Date.parse("2026-10-02T12:00:00Z");
const iso = () => new Date(now).toISOString();
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const tick = () => {
  now += 1000;
  scheduler.tick(now);
};
const settle = () => {
  tick();
  tick();
};
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
const stepOf = (id: string, stepId: string) => task(id).steps.find((x) => x.id === stepId)!;
const runOf = (taskId: string, stepId: string) => M.activeAttempts(st(), taskId).find((a) => a.stepId === stepId);
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const ITEM: BlueprintItem = { id: "bi-1", kind: "screen", title: "Trip board", artifactId: "sa-1", version: 1, status: "approved" };

async function setUp(runner: EvidenceRunner, files: Record<string, string> = { "README.md": "hello\n" }) {
  dir = mkdtempSync(join(tmpdir(), "orc-evidence-sched-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  evidence = runner;
  scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), evidence, dataDir: dir, leaseMs: 30000, ackTimeoutMs: 10000 });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Test", repoPath: repo, vision: "Test vision", focus: "Testing" });
  // The owner approved the Trip board into the draft (the approval itself is the studio's; tested there), and Start
  // the factory, the first Lock in, puts it into force: only the owner's Lock in may make a blueprint revision.
  store.update((s) => {
    const next = structuredClone(s);
    next.blueprint.draft = { rev: next.blueprint.draft.rev + 1, items: [ITEM] };
    return next;
  }, iso());
  cmd("startFactory", startFactoryArgs(st()));
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  // The scripted adapters never answer a PE run, so new work does not wait for PE review here (tested in peReview).
  cmd("setPeReviewsNewWork", { on: false });
}

afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A Feature task citing the Trip board, run through its design and its implementation, which writes `files`. */
function implemented(files: Record<string, string>) {
  const id = (cmd("createTask", { title: "Trip board", area: "Trips", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["It works"], priority: 1, holdBeforeStart: true, flowId: "feature" }).result as { newId: string }).newId;
  const content: SpecContent = { ...M.currentSpec(task(id)).content, blueprintRefs: ["bi-1"] };
  cmd("editSpec", { taskId: id, expectedRev: 1, content, reason: "Cites the blueprint" });
  cmd("startHeldTask", { taskId: id });
  tick();
  claude.finish(runOf(id, "S1")!.id);
  settle();
  const coder = runOf(id, "S2")!;
  const ws = codex.runs.get(coder.id)!.workspace.path;
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(ws, rel, ".."), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  codex.finish(coder.id);
  settle();
  return id;
}
const PLAN = JSON.stringify({ screens: [{ item: "bi-1", path: "/", devices: ["desktop"] }] });

describe("the Capture evidence step through the scheduler", () => {
  beforeEach(async () => {
    await setUp(new ScriptedEvidence());
  });

  it("captures the coder's commit after the checks, records the evidence, removes its worktree, and the UX review reads it", () => {
    cmd("setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173 } });
    const id = implemented({ [CAPTURE_PLAN]: PLAN, "index.html": "<h1>Trip board</h1>" });
    expect(stepOf(id, "C1").state).toBe("skipped");
    const run = runOf(id, "E1")!;
    expect(run.snapshot).toMatchObject({ provider: "service", model: "evidence", evidence: { items: [{ itemId: "bi-1", artifactId: "sa-1", version: 1 }], preview: { rev: 1 } } });
    // The UX review waits; the code and security reviews start beside the capture.
    expect(stepOf(id, "S4").state).toBe("pending");
    const change = M.acceptedOutput(st(), task(id), "S2", "change")!;
    const sha = git("rev-parse", change.ref!.split(" ")[0]);
    const runner = evidence as ScriptedEvidence;
    const a = runner.started[0];
    expect(a).toMatchObject({ attemptId: run.id, taskId: id, stepId: "E1", sha, items: [E.captureItems(st(), task(id))[0]], preview: { rev: 1, install: E.DEFAULT_INSTALL, preview: ["npm", "run", "preview"], port: 4173 }, outDir: join(dir, "evidence", st().project.id, run.id) });
    expect(git("-C", a.workspace, "rev-parse", "HEAD")).toBe(sha);
    expect(readFileSync(join(a.workspace, CAPTURE_PLAN), "utf8")).toBe(PLAN);

    runner.finish(run.id);
    settle();
    expect(stepOf(id, "E1").state).toBe("done");
    expect(existsSync(a.workspace)).toBe(false);
    const art = M.acceptedOutput(st(), task(id), "E1", "evidence")!;
    expect(art.evidence).toMatchObject({ sha, items: [{ itemId: "bi-1", status: "captured", files: [{ path: "bi-1/desktop.png" }] }] });
    expect(E.itemEvidence(st(), "bi-1")).toMatchObject({ status: "captured", commit: sha, design: { artifactId: "sa-1", version: 1 } });

    // The UX review: the built screenshot as a path its run may read.
    const ux = runOf(id, "S4")!;
    const given = claude.runs.get(ux.id)!;
    expect(given.workspace.readRoots).toEqual([join(dir, "evidence", st().project.id, run.id), join(dir, "studio", st().project.id, "artifacts", "sa-1", "v1")]);
    expect(given.prompt).toContain(`- E1.evidence v1 (evidence):\n  Evidence of ${sha.slice(0, 12)}: 1 of 1 item captured.`);
    expect(given.prompt).toContain(`  - bi-1 Trip board (screen v1): built on desktop: ${join(dir, "evidence", st().project.id, run.id, "bi-1/desktop.png")}`);
  });

  it("the app's file route serves the files the record lists, with the studio files' headers, and nothing else", async () => {
    cmd("setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173 } });
    const id = implemented({ [CAPTURE_PLAN]: PLAN });
    const run = runOf(id, "E1")!;
    const runner = evidence as ScriptedEvidence;
    const outDir = runner.started[0].outDir;
    runner.finish(run.id);
    settle();
    // A file the record does not list, beside the ones it does.
    writeFileSync(join(outDir, "bi-1", "planted.png"), readFileSync(join(outDir, "bi-1", "desktop.png")));
    const probe = createHttpServer({ store, scheduler, startedAt: iso(), allowedHosts: [] });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createHttpServer({ store, scheduler, startedAt: iso(), allowedHosts: [`127.0.0.1:${port}`], dataDir: dir });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const get = (q: string) => fetch(`http://127.0.0.1:${port}/api/studio/file?${q}`);
      const ok = await get(`evidence=${run.id}&path=${encodeURIComponent("bi-1/desktop.png")}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect({ nosniff: ok.headers.get("x-content-type-options"), cache: ok.headers.get("cache-control"), csp: ok.headers.get("content-security-policy") }).toEqual({ nosniff: "nosniff", cache: "no-store", csp: "default-src 'none'; sandbox" });
      expect(Buffer.from(await ok.arrayBuffer()).subarray(1, 4).toString("latin1")).toBe("PNG");
      for (const q of [`evidence=${run.id}&path=${encodeURIComponent("bi-1/planted.png")}`, `evidence=${run.id}&path=${encodeURIComponent("../../../db.sqlite")}`, `evidence=run-9999&path=${encodeURIComponent("bi-1/desktop.png")}`, `evidence=${encodeURIComponent("../x")}&path=${encodeURIComponent("bi-1/desktop.png")}`]) {
        const r = await get(q);
        expect(r.status, q).toBe(404);
        expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      }
      expect((await get(`evidence=${run.id}&path=${encodeURIComponent("bi-1/page.html")}`)).status).toBe(403);
      expect((await get(`evidence=${run.id}`)).status).toBe(400);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("a pause stops a running capture, and Resume runs it again", () => {
    cmd("setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173 } });
    const id = implemented({ [CAPTURE_PLAN]: PLAN });
    const run = runOf(id, "E1")!;
    cmd("pauseTask", { taskId: id });
    tick();
    const runner = evidence as ScriptedEvidence;
    expect(runner.interrupts).toContain(run.id);
    runner.stopped(run.id);
    // The reviews beside it stop too (scripted agents confirm only when told).
    for (const x of M.activeAttempts(st(), id).filter((r) => r.stepId !== "E1")) claude.emit({ type: "stopped", attemptId: x.id, how: "interrupted" });
    settle();
    expect(stepOf(id, "E1").state).toBe("paused");
    cmd("resumeTask", { taskId: id });
    settle();
    const again = runOf(id, "E1")!;
    expect(again.id).not.toBe(run.id);
    expect(runner.started.map((x) => x.attemptId)).toEqual([run.id, again.id]);
  });

  it("without a preview setting nothing starts: every cited item is not set up, and the UX review goes on", () => {
    const id = implemented({ [CAPTURE_PLAN]: PLAN });
    expect(stepOf(id, "E1").state).toBe("done");
    expect((evidence as ScriptedEvidence).started).toEqual([]);
    expect(M.acceptedOutput(st(), task(id), "E1", "evidence")!.evidence!.items).toEqual([expect.objectContaining({ itemId: "bi-1", status: "none", reason: "not-set-up" })]);
    tick();
    expect(runOf(id, "S4")).toBeDefined();
  });
});

const ready = await dockerReady();
const APP = resolve(__dirname, "fixtures/evidence-app");

describe(`the Capture evidence step for real, in the recorder's container${ready.ok ? "" : ` (skipped: ${ready.reason})`}`, () => {
  it.skipIf(!ready.ok)(
    "captures the fixture app at the coder's commit, and the UX review gets its screenshots",
    async () => {
      const files: Record<string, string> = {};
      for (const rel of ["server.js", "public/index.html", "bin/trips.js", "package.json", "package-lock.json"]) files[rel] = readFileSync(join(APP, rel), "utf8");
      await setUp(new ContainerEvidence({}), files);
      cmd("setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" } });
      const id = implemented({ [CAPTURE_PLAN]: JSON.stringify({ screens: [{ item: "bi-1", path: "/", devices: ["desktop", "mobile"] }] }) });
      const run = runOf(id, "E1")!;
      const t0 = Date.now();
      for (let i = 0; i < 240 && runOf(id, "E1"); i++) {
        await new Promise((r) => setTimeout(r, 500));
        tick();
      }
      settle();
      console.log(`the capture through the scheduler took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const art = M.acceptedOutput(st(), task(id), "E1", "evidence")!;
      expect(art.evidence!.items).toEqual([expect.objectContaining({ itemId: "bi-1", status: "captured", files: [expect.objectContaining({ path: "bi-1/desktop.png", device: "desktop" }), expect.objectContaining({ path: "bi-1/mobile.png", device: "mobile" })] })]);
      const out = join(dir, "evidence", st().project.id, run.id);
      for (const f of ["bi-1/desktop.png", "bi-1/mobile.png"]) expect(readFileSync(join(out, f)).subarray(1, 4).toString("latin1")).toBe("PNG");
      const ux = runOf(id, "S4")!;
      expect(claude.runs.get(ux.id)!.prompt).toContain(`built on mobile: ${join(out, "bi-1/mobile.png")}`);
    },
    180_000,
  );
});
