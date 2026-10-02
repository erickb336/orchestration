// ORC-029 pass 3a at the service: a designer run asked for in a round is dispatched by the scheduler in Vision only,
// works in its own staging folder under the data directory (with the product readable, never writable), and what its
// studio.json lists becomes artifact versions. Pause, stop and stale results follow lead runs. The stage guard and
// the owner-only start are untouched by any of it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as R from "../../src/domain/studio/runs";
import * as S from "../../src/domain/studio/studio";
import { startFactoryArgs } from "../../src/domain/testing/factory";
import type { State } from "../../src/domain/types";
import { FakeAdapter, defaultFakeConfig } from "../runtimes/fake";
import type { Assignment } from "../runtimes/types";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { ScriptedAdapter } from "../testing/scripted";
import { WorkspaceManager } from "../workspaces";
import { systemMedia, type StudioMedia } from "./media";
import { startDesignerRun } from "./runs";
import { SAMPLE_FILES, SAMPLE_MANIFEST, TERMINAL_SAMPLE_FILES } from "./sample";
import { createPrototypeServer } from "./serve";
import { launchChrome, type ShotsOutcome } from "./shots";
import { probeTerminalSandbox, validateAnsFrame, type RecordResult } from "./terminal";
import { close, get, listen } from "./testFixtures";

let dir: string;
let dataDir: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler;
let now = Date.parse("2026-10-02T09:00:00Z");
let key = 0;
const iso = () => new Date(now).toISOString();
const state = (): State => store.read().state;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const runOf = (id: string) => R.getStudioRun(state(), id)!;

/** A repository with one commit, for real-mode runs. */
function gitRepo(): string {
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "The trips app.\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return repo;
}

async function service(opts: { workspaces?: boolean; media?: StudioMedia } = {}) {
  const repo = opts.workspaces ? gitRepo() : join(dir, "repo");
  store = new Store(join(dataDir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  scheduler = new Scheduler(store, { claude, codex }, { dataDir, leaseMs: 60_000, ackTimeoutMs: 10_000, ...(opts.workspaces ? { workspaces: new WorkspaceManager(join(dataDir, "worktrees")) } : {}), ...(opts.media ? { studioMedia: opts.media } : {}) });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Trips", repoPath: repo, vision: "Weekend trips for a small group of friends.", focus: "" });
  cmd("openRound", { focus: "experience" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-studio-runs-"));
  dataDir = join(dir, "data");
  mkdirSync(dataDir);
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const PAGES: Record<string, string> = {
  "a/index.html": "<!doctype html><link rel=stylesheet href=style.css><h1>Map first</h1>",
  "a/style.css": "h1 { color: teal; }",
  "b/index.html": "<!doctype html><link rel=stylesheet href=style.css><h1>Day by day</h1>",
  "b/style.css": "h1 { color: navy; }",
};
const TRIP_PLAN = {
  kind: "screen",
  title: "Trip plan",
  devices: ["desktop", "mobile"],
  variants: [
    { id: "a", label: "A · Map first", entry: "a/index.html" },
    { id: "b", label: "B · Day by day", entry: "b/index.html" },
  ],
  files: Object.keys(PAGES),
};
/** The designer at work: write files into the run's staging folder, as its agent would. */
function handIn(a: Assignment, manifest: unknown = { artifacts: [TRIP_PLAN] }, files: Record<string, string> = PAGES) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(a.workspace.path, p)), { recursive: true });
    writeFileSync(join(a.workspace.path, p), text);
  }
  writeFileSync(join(a.workspace.path, "studio.json"), JSON.stringify(manifest));
}
const finish = (id: string, usage = { costUsd: 0.42 }) => claude.emit({ type: "completed", attemptId: id, finalText: "I made the trip plan in two variants.", usage, model: "claude-sample-large-actual" });

describe("a designer run at the service", () => {
  it("is asked for with the placeholder brief, dispatched in Vision, isolated in its own staging folder, and hands in artifact versions", async () => {
    await service();
    const id = startDesignerRun(store, { round: 1 }, iso());
    expect(runOf(id).status).toBe("queued");
    tick();
    const a = claude.runs.get(id)!;
    const staging = join(dataDir, "studio", state().project.id, "staging", id);
    expect({ ...a, prompt: undefined }).toEqual({
      attemptId: id,
      taskId: "STUDIO",
      stepId: "designer",
      role: "designer",
      provider: "claude",
      model: "claude-sample-large",
      workspace: { path: staging, access: "write" },
      studio: true,
      environment: "isolated",
      connections: [],
      prompt: undefined,
      outputs: [],
      limits: { maxTurns: 40, timeoutMs: 20 * 60_000, maxBudgetUsd: 2 },
    });
    expect(a.prompt).toContain(`# Studio run ${id}: the designer, round 1 (experience)`);
    expect(a.prompt).toContain("PLACEHOLDER BRIEF. The lead's studio brief comes in ORC-029 pass 4");
    expect(a.prompt).toContain("Weekend trips for a small group of friends.");
    expect(a.prompt).toContain("End by writing `studio.json` in your working directory");
    expect(a.prompt).toContain("No checkout of the product's repository is available to read.");
    // The prototype policy as decided: inline is fine, plain scripts only, and a built app emits classic scripts.
    expect(a.prompt).toContain("- Inline styles and scripts are fine (`<style>`, `style=\"…\"`, `<script>`)");
    expect(a.prompt).toContain('- Use plain scripts, never `<script type="module">`: plain scripts only (no ES modules): a module needs a CORS header that would let other websites read local prototypes, so a page with one is refused. A built app must emit classic scripts');
    expect(a.prompt).not.toContain("the sandbox blocks inline");
    // Tapes, as the recorder runs them (the real trial's designer wrote root paths while the shell started elsewhere).
    expect(a.prompt).toContain("paths in the tape's commands are relative to the artifact's root, as in studio.json: a tape at `demo/demo.tape` runs `node demo/trips.js`");
    expect(a.prompt).toContain("VHS's own `Output` and `Source` paths are relative to the tape's folder");
    expect(a.prompt).toContain("The demo runs with no network (not even localhost) and no access to the home folder (`~`)");
    expect(a.prompt).toContain("A CLI that does not exist yet is a `.js` script the tape runs with `node`");
    expect(a.prompt).toContain('It must run cleanly in the sandbox, from the artifact\'s root.');
    expect(a.prompt).toContain('sets `"showsError": true` on its variant');
    expect(readdirSync(staging)).toEqual([]);
    expect(runOf(id)).toMatchObject({ status: "running", sessionId: `claude-session-${id}`, actualModel: "claude-sample-large-actual" });

    handIn(a);
    finish(id);
    tick();
    const art = S.latestArtifacts(state())[0];
    expect(runOf(id)).toMatchObject({ status: "completed", usage: { costUsd: 0.42 } });
    expect(art).toMatchObject({ round: 1, version: 1, title: "Trip plan", madeBy: { role: "designer", provider: "claude", model: "claude-sample-large-actual", attemptId: id } });
    // Each variant keeps the entry the designer named, so the viewer never guesses it.
    expect(art.variants).toEqual(TRIP_PLAN.variants);
    const folder = join(dataDir, "studio", state().project.id, "artifacts", art.id, "v1");
    expect(readdirSync(folder).sort()).toEqual(["a", "b", "manifest.json"]);
    expect(readFileSync(join(folder, "b", "index.html"), "utf8")).toBe(PAGES["b/index.html"]);
    // What was imported is kept in the version folder; the staging folder is gone.
    expect(existsSync(staging)).toBe(false);
    // Completed; the PE is asked to review it next (below).
    expect(state().events.slice(-2).map((e) => e.message)).toEqual([`Designer run ${id} completed: Trip plan v1 (2 variants)`, expect.stringMatching(/^PE run studio-\d+ asked for in round 1, reviewing Trip plan v1, on Codex/)]);
    // The studio never moves the project: it is still in Vision, with no start recorded.
    expect(state().project).toMatchObject({ stage: "shaping", factoryStarts: [] });
  });

  it("a refused studio.json fails the run with the reason; nothing is recorded, and its staging folder stays to look at", async () => {
    await service();
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    const a = claude.runs.get(id)!;
    handIn(a, { artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, "a/run.sh"] }] }, { ...PAGES, "a/run.sh": "curl example.com" });
    finish(id);
    tick();
    expect(runOf(id)).toMatchObject({
      status: "failed",
      usage: { costUsd: 0.42 },
      note: 'studio.json was refused: artifact 1: "a/run.sh" is not an allowed file type (html, css, js, svg, png, jpg, jpeg, webp, woff2, json, txt, md, mmd, tape, cast, ans).',
    });
    expect(S.latestArtifacts(state())).toEqual([]);
    expect(existsSync(join(dataDir, "studio", state().project.id, "artifacts"))).toBe(false);
    expect(existsSync(join(a.workspace.path, "studio.json"))).toBe(true);
    // A run that hands in nothing fails the same way.
    const next = startDesignerRun(store, { round: 1, brief: "Again." }, iso());
    tick();
    finish(next);
    tick();
    expect(runOf(next).note).toBe("studio.json was refused: the run wrote no studio.json.");
  });

  it("a result is refused once stale: its round was closed while it ran", async () => {
    await service();
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    handIn(claude.runs.get(id)!);
    cmd("closeRound", { round: 1 });
    finish(id);
    tick();
    expect(runOf(id)).toMatchObject({ status: "failed", note: "Its result is stale: round 1 was closed. Nothing was imported." });
    expect(S.latestArtifacts(state())).toEqual([]);
  });

  it("pausing stops it with the runtime's acknowledgment and asks for it again; nothing starts until the project resumes", async () => {
    await service();
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    cmd("pauseProject");
    tick();
    expect(claude.interrupts).toEqual([id]);
    expect(runOf(id).status).toBe("stopping");
    claude.emit({ type: "stopped", attemptId: id, how: "interrupted", usage: { costUsd: 0.1 } });
    tick();
    const again = state().studio.runs.at(-1)!;
    expect(runOf(id)).toMatchObject({ status: "stopped", usage: { costUsd: 0.1 } });
    expect(again).toMatchObject({ status: "queued", retryOf: id, brief: "Make the trip plan." });
    tick();
    expect(claude.started.map((a) => a.attemptId)).toEqual([id]);
    cmd("resumeProject");
    tick();
    expect(claude.started.map((a) => a.attemptId)).toEqual([id, again.id]);
    // A late report from the stopped run changes nothing.
    const before = JSON.stringify(state());
    finish(id);
    tick();
    expect(JSON.stringify(state().studio)).toBe(JSON.stringify((JSON.parse(before) as State).studio));
  });

  it("a stop the runtime never confirms becomes a control failure; a process that vanished is lost and its late result is ignored", async () => {
    await service();
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    cmd("pauseProject");
    tick(11_000);
    expect(runOf(id)).toMatchObject({ status: "stopping", note: "Control failure: the runtime has not acknowledged the stop request." });
    cmd("resumeProject");

    const other = startDesignerRun(store, { round: 1, brief: "Another." }, iso());
    tick();
    expect(runOf(other).status).toBe("running");
    // The process vanishes without a terminal event: after a short grace for late events, the run is lost.
    claude.kill(other);
    tick();
    expect(runOf(other).status).toBe("running");
    tick(11_000);
    expect(runOf(other).status).toBe("lost");
    handIn({ workspace: { path: join(dataDir, "studio", state().project.id, "staging", other) } } as Assignment);
    finish(other);
    tick();
    expect(runOf(other).status).toBe("lost");
    expect(S.latestArtifacts(state())).toEqual([]);
  });

  it("runs only in Vision: a run asked for before the factory started waits until the project is back in Vision", async () => {
    await service();
    cmd("pauseProject");
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    cmd("startFactory", startFactoryArgs(state()));
    cmd("resumeProject");
    tick();
    tick();
    expect(runOf(id).status).toBe("queued");
    expect(claude.started).toEqual([]);
    cmd("startVision");
    tick();
    expect(runOf(id).status).toBe("running");
  });

  it("the store's stage guard holds for studio writes: an update that completes a studio run and moves the project to building is refused, and nothing is written", async () => {
    await service();
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = store.read();
    expect(() =>
      store.update((s) => {
        const next = R.completeStudioRun(s, id, iso(), { summary: "done" });
        next.project.stage = "building";
        return next;
      }, iso()),
    ).toThrow(/^Refused: only the owner's Start the factory moves the project from Vision to the factory; an internal update tried to/);
    logged.mockRestore();
    expect(store.read()).toEqual(before);
    expect(runOf(id).status).toBe("running");
  });

  it("with the fake runtime, a simulated designer hands in the sample trip plan, which goes through the same check and import", async () => {
    store = new Store(join(dataDir, "db.sqlite"));
    const catalog = store.read().state.project.catalog;
    const fake = { claude: new FakeAdapter("claude", defaultFakeConfig(), catalog.claude), codex: new FakeAdapter("codex", defaultFakeConfig(), catalog.codex) };
    scheduler = new Scheduler(store, fake, { dataDir, leaseMs: 60_000 });
    cmd("initProject", { name: "Weekend Trips", repoPath: join(dir, "repo"), vision: "Weekend trips for a small group of friends.", focus: "" });
    cmd("openRound", { focus: "experience" });
    const id = startDesignerRun(store, { round: 1 }, iso());
    for (let i = 0; i < 60 && runOf(id).status !== "completed"; i++) tick();
    expect(runOf(id)).toMatchObject({ status: "completed", simulated: true });
    const art = S.latestArtifacts(state())[0];
    expect(art).toMatchObject({
      title: "Trip plan (simulated sample)",
      kind: "screen",
      devices: ["desktop", "mobile"],
      variants: [
        { id: "a", label: "A · Map first", entry: "a/index.html" },
        { id: "b", label: "B · Day by day", entry: "b/index.html" },
      ],
      files: Object.entries(SAMPLE_FILES).map(([path, text]) => ({ path, sha256: createHash("sha256").update(text).digest("hex") })),
    });
    const folder = join(dataDir, "studio", state().project.id, "artifacts", art.id, "v1");
    for (const v of ["a", "b"]) {
      const page = readFileSync(join(folder, v, "index.html"), "utf8");
      expect(page).toContain("Simulated sample: the fake runtime made this, not a designer agent.");
      expect(page).toContain("Lake weekend");
      // Nothing to fetch: the prototype server's policy blocks the network.
      expect(page).not.toMatch(/https?:\/\//);
    }
    expect(JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")).variants).toEqual(SAMPLE_MANIFEST.artifacts[0].variants);
  });

  it("in real mode, the product is checked out read-only beside the run and removed after it; a revision starts from the version it revises", async () => {
    await service({ workspaces: true });
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    const a = claude.runs.get(id)!;
    const checkout = a.workspace.readRoots![0];
    expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("The trips app.\n");
    expect(a.prompt).toContain(`The product's repository, as committed, is readable at ${checkout}.`);
    // The checkout is kept while the run is active, even through a prune.
    scheduler.prune();
    expect(existsSync(checkout)).toBe(true);
    handIn(a);
    finish(id);
    tick();
    expect(existsSync(checkout)).toBe(false);
    const art = S.latestArtifacts(state())[0];

    const rev = startDesignerRun(store, { round: 1, brief: "Tighten it.", artifactId: art.id }, iso());
    tick();
    const b = claude.runs.get(rev)!;
    expect(readdirSync(b.workspace.path).sort()).toEqual(["a", "b"]);
    expect(b.prompt).toContain("Your working directory starts with the files of Trip plan v1, the version you revise: a/index.html, a/style.css, b/index.html, b/style.css.");
    writeFileSync(join(b.workspace.path, "a", "style.css"), "h1 { color: coral; }");
    handIn(b, { artifacts: [{ ...TRIP_PLAN, title: "Trip plan" }] }, { "a/style.css": "h1 { color: coral; }" });
    finish(rev);
    tick();
    expect(S.versionsOf(state(), art.id).map((v) => v.version)).toEqual([1, 2]);
    expect(readFileSync(join(dataDir, "studio", state().project.id, "artifacts", art.id, "v1", "a", "style.css"), "utf8")).toBe("h1 { color: teal; }");
    expect(readFileSync(join(dataDir, "studio", state().project.id, "artifacts", art.id, "v2", "a", "style.css"), "utf8")).toBe("h1 { color: coral; }");
  });
});

// ---------- the PE's runs ----------

/** A designer run's Trip plan imported; returns the version's id and folder. */
function designed(): { artifactId: string; folder: string } {
  const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
  tick();
  handIn(claude.runs.get(id)!);
  finish(id);
  tick();
  const art = S.latestArtifacts(state())[0];
  return { artifactId: art.id, folder: join(dataDir, "studio", state().project.id, "artifacts", art.id, "v1") };
}
const peRuns = () => state().studio.runs.filter((r) => r.kind === "pe");
const answer = (verdicts: object[]) => `I read both variants and their pages.\n\n\`\`\`json\n${JSON.stringify({ verdicts })}\n\`\`\`\n`;
const peFinish = (id: string, finalText: string) => codex.emit({ type: "completed", attemptId: id, finalText, usage: { inputTokens: 12_000, outputTokens: 900 }, model: "codex-sample-large-actual" });
/** Every file under a folder, with its bytes: to show a read-only run changed nothing. */
const snapshot = (folder: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(folder, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(p);
      else out[p] = readFileSync(join(folder, p), "utf8");
    }
  };
  walk("");
  return out;
};

describe("the PE's runs at the service", () => {
  it("after the import, the PE reviews the version read-only, on the other provider, and its verdicts let the owner answer", async () => {
    await service();
    const { artifactId, folder } = designed();
    const before = snapshot(folder);
    // Asked for in the import's own write; dispatched on the next cycle.
    expect(peRuns()).toMatchObject([{ status: "queued", provider: "codex", artifactId, baseVersion: 1 }]);
    tick();
    const pe = peRuns()[0];
    const a = codex.runs.get(pe.id)!;
    // Its temp folder is its own staging folder, outside the immutable version it reads (review finding 6).
    const tmp = join(dataDir, "studio", state().project.id, "staging", pe.id);
    expect(existsSync(tmp)).toBe(true);
    expect({ ...a, prompt: undefined }).toEqual({
      attemptId: pe.id,
      taskId: "STUDIO",
      stepId: "pe",
      role: "pe",
      provider: "codex",
      model: "codex-sample-large",
      workspace: { path: folder, access: "read", tmp },
      studio: true,
      environment: "isolated",
      connections: [],
      prompt: undefined,
      outputs: [],
      limits: { maxTurns: 40, timeoutMs: 20 * 60_000, maxBudgetUsd: 2 },
    });
    expect(a.prompt).toContain(`# Studio run ${pe.id}: PE review of Trip plan v1, round 1 (experience)`);
    expect(a.prompt).toContain('- `a`, "A · Map first": its entry is a/index.html.');
    expect(a.prompt).toContain(`- Your working directory (${folder}) is this version's folder`);
    expect(a.prompt).toContain("Weekend trips for a small group of friends.");
    expect(a.prompt).toContain("- Building budget (agent usage to build the product, Vision's runs included): not set yet.");
    expect(a.prompt).toContain("- One verdict for each variant: `a`, `b`.");
    // The owner cannot answer yet: the PE has not agreed.
    expect(() => cmd("sendFeedback", { entries: [{ artifactId, version: 1, mark: "keep", pins: [], note: "" }] })).toThrow(/is still in PE review/);

    const budget = { buildUsd: [40, 90], maintenanceUsdPerMonth: [0, 5], basis: "Recorded designer runs of this size; a static page needs no paid API." };
    peFinish(pe.id, answer([
      { variant: "a", verdict: "feasible", reasons: "A static page with a drawn map: no tiles, no API." },
      { variant: "b", verdict: "feasible-if", reasons: "Fine at four friends; long trips need paging.", change: "Page the days after a week.", budget },
    ]));
    tick();
    expect(runOf(pe.id)).toMatchObject({ status: "completed", usage: { inputTokens: 12_000, outputTokens: 900 } });
    expect(existsSync(tmp)).toBe(false);
    expect(state().studio.verdicts.map((v) => ({ variant: v.variant, verdict: v.verdict, by: v.by, lastPass: v.lastPass, budget: v.budget }))).toEqual([
      { variant: "a", verdict: "feasible", by: { provider: "codex", model: "codex-sample-large-actual", runId: pe.id }, lastPass: true, budget: undefined },
      { variant: "b", verdict: "feasible-if", by: { provider: "codex", model: "codex-sample-large-actual", runId: pe.id }, lastPass: true, budget },
    ]);
    expect(state().events.map((e) => e.message)).toContain(`PE run ${pe.id} completed: Trip plan v1, pass 1: A · Map first feasible, B · Day by day feasible if changed`);
    expect(S.readyForOwner(state(), S.getArtifact(state(), artifactId, 1))).toBe(true);
    cmd("sendFeedback", { entries: [{ artifactId, version: 1, mark: "keep", pickedVariant: "b", pins: [], note: "" }] });
    // Read-only: the version's folder is as the import wrote it. The PE is asked once.
    expect(snapshot(folder)).toEqual(before);
    tick();
    expect(peRuns()).toHaveLength(1);
  });

  it("an objection goes to the owner at once, as the last pass for now: the designer cannot revise in answer yet", async () => {
    await service();
    const { artifactId } = designed();
    tick();
    const pe = peRuns()[0];
    peFinish(pe.id, answer([
      { variant: "a", verdict: "feasible", reasons: "Fine." },
      { variant: "b", verdict: "not-feasible", reasons: "Live prices for every stop need a paid API the budget does not cover.", change: "A free source of prices, or a budget for one." },
    ]));
    tick();
    const v = S.getArtifact(state(), artifactId, 1);
    expect(S.peReview(state(), v)).toMatchObject({ status: "objections", pass: 1 });
    expect(S.openObjections(state(), v).map((o) => o.reasons)).toEqual(["Live prices for every stop need a paid API the budget does not cover."]);
    expect(state().events.map((e) => e.message)).toContain("PE review of Trip plan v1, pass 1: A · Map first feasible, B · Day by day not feasible; objects, and the designer cannot revise in answer yet; it goes to the owner with the objections");
    cmd("sendFeedback", { entries: [{ artifactId, version: 1, mark: "change", pins: [], note: "Drop the live prices." }] });
  });

  it("an answer that cannot be recorded fails the run with the reason; the service asks once more, then stops", async () => {
    await service();
    const { artifactId } = designed();
    tick();
    const first = peRuns()[0];
    peFinish(first.id, "Both variants look fine to me.");
    tick();
    expect(runOf(first.id)).toMatchObject({ status: "failed", note: "Its verdicts were refused: its answer has no JSON block with the verdicts" });
    expect(peRuns().map((r) => r.status)).toEqual(["failed", "queued"]);
    tick();
    const second = peRuns()[1];
    peFinish(second.id, answer([{ variant: "a", verdict: "feasible", reasons: "Fine." }]));
    tick();
    expect(runOf(second.id)).toMatchObject({ status: "failed", note: "Its verdicts were refused: The pass leaves out variant b: the PE judges every option the owner will see." });
    tick();
    expect(peRuns()).toHaveLength(2);
    expect(S.peReview(state(), S.getArtifact(state(), artifactId, 1))).toEqual({ status: "waiting", passes: 0 });
  });

  it("with the fake runtime, a simulated PE agrees, feasible-if on the second variant, labelled simulated, so the owner can answer", async () => {
    store = new Store(join(dataDir, "db.sqlite"));
    const catalog = store.read().state.project.catalog;
    const fake = { claude: new FakeAdapter("claude", defaultFakeConfig(), catalog.claude), codex: new FakeAdapter("codex", defaultFakeConfig(), catalog.codex) };
    scheduler = new Scheduler(store, fake, { dataDir, leaseMs: 60_000 });
    cmd("initProject", { name: "Weekend Trips", repoPath: join(dir, "repo"), vision: "Weekend trips for a small group of friends.", focus: "" });
    cmd("openRound", { focus: "experience" });
    startDesignerRun(store, { round: 1 }, iso());
    for (let i = 0; i < 120 && !peRuns().some((r) => r.status === "completed"); i++) tick();
    const pe = peRuns()[0];
    expect(pe).toMatchObject({ status: "completed", provider: "codex", simulated: true });
    const art = S.latestArtifacts(state())[0];
    const verdicts = state().studio.verdicts;
    expect(verdicts.map((v) => [v.variant, v.verdict])).toEqual([
      ["a", "feasible"],
      ["b", "feasible-if"],
    ]);
    expect(verdicts.every((v) => v.reasons.startsWith("Simulated: the fake runtime's PE, not an agent."))).toBe(true);
    expect(S.peReview(state(), art)).toEqual({ status: "agreed", pass: 1 });
    cmd("sendFeedback", { entries: [{ artifactId: art.id, version: 1, mark: "keep", pins: [], note: "" }] });
  });
});

describe("the fake designer's terminal sample", () => {
  it("for a brief that asks for a terminal demo, it hands in the trips CLI's tape (with a hand-written .cast) and a TUI in two layouts, which pass the same checks and get the PE's review", async () => {
    store = new Store(join(dataDir, "db.sqlite"));
    const catalog = store.read().state.project.catalog;
    const fake = { claude: new FakeAdapter("claude", defaultFakeConfig(), catalog.claude), codex: new FakeAdapter("codex", defaultFakeConfig(), catalog.codex) };
    scheduler = new Scheduler(store, fake, { dataDir, leaseMs: 60_000 });
    cmd("initProject", { name: "Weekend Trips", repoPath: join(dir, "repo"), vision: "Weekend trips for a small group of friends.", focus: "" });
    cmd("setDevices", { devices: ["desktop", "mobile", "terminal"] });
    cmd("openRound", { focus: "experience" });
    const id = startDesignerRun(store, { round: 1, brief: "Make a terminal demo of the trips CLI, and its TUI." }, iso());
    for (let i = 0; i < 120 && peRuns().filter((r) => r.status === "completed").length < 2; i++) tick();
    expect(runOf(id)).toMatchObject({ status: "completed", simulated: true });
    const [cli, tui] = S.latestArtifacts(state());
    expect(cli).toMatchObject({ kind: "terminal-demo", title: "trips CLI (simulated sample)", devices: ["terminal"], variants: [{ id: "a", label: "A · Plan, then pick", entry: "cli/trips.tape" }] });
    expect(tui).toMatchObject({ kind: "tui", devices: ["terminal"], variants: [{ id: "a", entry: "tui/a/tui.ans" }, { id: "b", entry: "tui/b/tui.ans" }] });
    // Every hand-written frame fits the terminal size it is drawn at.
    for (const p of ["tui/a/tui.ans", "tui/b/tui.ans"]) expect(validateAnsFrame(TERMINAL_SAMPLE_FILES[p], { cols: 80, rows: 24 })).toMatchObject({ ok: true });
    // The PE reviewed both; the owner can answer.
    for (const a of [cli, tui]) expect(S.peReview(state(), a).status).toBe("agreed");
  });
});

// ---------- after an import: screenshots and recordings ----------

/** Gates still closed when a test ends: opened then, so the scheduler's stop does not wait on them. */
const gates: (() => void)[] = [];
afterEach(() => {
  for (const open of gates.splice(0)) open();
});
/** A stand-in for Chrome and VHS that answers only once released, so a test sees what happens meanwhile. */
function gated(answers: { shots?: ShotsOutcome; record?: RecordResult }) {
  const calls: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  gates.push(release);
  const media: StudioMedia = {
    shots: async (_dir, artifactId, version) => {
      calls.push(`shots ${artifactId} v${version}`);
      await gate;
      return answers.shots ?? { skipped: "no answer" };
    },
    record: async (_tapeDir, _outDir, tape) => {
      calls.push(`record ${tape}`);
      await gate;
      return answers.record ?? { sandbox: null, reason: "failed", error: "no answer" };
    },
  };
  return { media, calls, release };
}
/** Let started media jobs reach their first await. */
const flush = () => new Promise((r) => setImmediate(r));
/** Let the media jobs finish, then apply what they queued. */
async function settleMedia() {
  await scheduler.mediaIdle();
  tick();
}

// As the real trial's designer wrote it: the tape in a subfolder runs its script by its path from the artifact's root.
const TAPE = 'Output demo.gif\nOutput demo.webm\nOutput demo.txt\nSet Columns 80\nSet Rows 24\nSet TypingSpeed 20ms\nType "node a/trips.js plan"\nEnter\nSleep 1500ms\n';
const TRIPS_JS = 'console.log("Weekend trips from Lisbon");\nconsole.log("  1  Sintra     45 min by train");\n';
const DEMO_FILES: Record<string, string> = { "a/demo.tape": TAPE, "a/trips.js": TRIPS_JS, "a/demo.cast": '{"version": 3, "term": {"cols": 80, "rows": 24}}\n[0.5, "o", "trips plan\\r\\n"]\n', "b/plan.ans": "Weekend trips\n" };
const TRIPS_DEMO = {
  kind: "terminal-demo",
  title: "trips",
  variants: [
    { id: "a", label: "A · Recorded", entry: "a/demo.tape" },
    { id: "b", label: "B · Frames", entry: "b/plan.ans" },
  ],
  files: Object.keys(DEMO_FILES),
};

describe("after an import, the service's screenshots and recordings", () => {
  it("the run completes at once; the screenshots follow and are recorded on the version", async () => {
    const shots = { shots: [{ variant: "a", device: "desktop" as const, path: "shots/a-desktop.png" }, { variant: "b", device: "mobile" as const, path: "shots/b-mobile.png" }], failed: [] };
    const g = gated({ shots });
    await service({ media: g.media });
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    handIn(claude.runs.get(id)!);
    finish(id);
    tick();
    // Completed and imported, while the screenshots are still being taken.
    const art = S.latestArtifacts(state())[0];
    expect(runOf(id).status).toBe("completed");
    expect(art.shots).toEqual({ status: "pending" });
    await flush();
    expect(g.calls).toEqual([`shots ${art.id} v1`]);
    // Started once, however many cycles pass meanwhile.
    tick();
    await flush();
    expect(g.calls).toHaveLength(1);
    expect(S.getArtifact(state(), art.id, 1).shots).toEqual({ status: "pending" });
    // The PE reads the screenshots, so it is not asked for while they are being taken.
    expect(state().studio.runs.filter((r) => r.kind === "pe")).toEqual([]);
    g.release();
    await settleMedia();
    expect(S.getArtifact(state(), art.id, 1).shots).toEqual({ status: "taken", at: iso(), ...shots });
    // The PE was waiting for them: it is asked for in the same write.
    expect(state().events.slice(-2).map((e) => e.message)).toEqual(["Screenshots of Trip plan v1: 2 taken", expect.stringMatching(/^PE run studio-\d+ asked for in round 1, reviewing Trip plan v1/)]);
  });

  it("says why there are no screenshots when they were skipped", async () => {
    const g = gated({ shots: { skipped: "no Chrome found" } });
    g.release();
    await service({ media: g.media });
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    handIn(claude.runs.get(id)!);
    finish(id);
    tick();
    await settleMedia();
    const art = S.latestArtifacts(state())[0];
    expect(art.shots).toMatchObject({ status: "skipped", reason: "no Chrome found" });
    expect(S.shotsNote(art)).toBe("No screenshots: no Chrome found");
  });

  it("a terminal demo's tape is recorded after the run completes; not recorded, the hand-written frames are shown, with the reason", async () => {
    const g = gated({ record: { sandbox: null, reason: "unavailable", error: "Not recorded: no working sandbox (shellWriteOutside allowed). Nothing runs unsandboxed; use a hand-written .cast or .ans instead." } });
    await service({ media: g.media });
    const id = startDesignerRun(store, { round: 1, brief: "Make the trips demo." }, iso());
    tick();
    handIn(claude.runs.get(id)!, { artifacts: [TRIPS_DEMO] }, DEMO_FILES);
    finish(id);
    tick();
    const art = S.latestArtifacts(state())[0];
    expect([runOf(id).status, art.demo, art.shots]).toEqual(["completed", { status: "pending" }, undefined]);
    expect(S.demoNote(art, "a")).toBe("Recording…");
    await flush();
    expect(g.calls).toEqual(["record a/demo.tape"]);
    g.release();
    await settleMedia();
    const reason = "recording is not available here: no working sandbox (shellWriteOutside allowed)";
    expect(S.getArtifact(state(), art.id, 1).demo).toEqual({
      status: "done",
      at: iso(),
      variants: [
        { variant: "a", status: "hand-written", files: ["a/demo.cast"], reason },
        { variant: "b", status: "hand-written", files: ["b/plan.ans"] },
      ],
    });
    expect(S.demoNote(S.getArtifact(state(), art.id, 1), "a")).toBe(`Hand-written, not recorded: ${reason}`);
  });

  it("a recording that shows a failure is recorded with errors, and the PE is told so, with the failing line", async () => {
    const line = "Error: Cannot find module '/private/var/folders/wk/T/orc-vhs-1/work/trips.js'";
    const media: StudioMedia = {
      shots: async () => ({ skipped: "no Chrome found" }),
      record: async (_root, out) => {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "demo.gif"), "GIF89a");
        return { sandbox: "sandbox-exec", gif: join(out, "demo.gif"), errorLine: line };
      },
    };
    await service({ media });
    const id = startDesignerRun(store, { round: 1, brief: "Make the trips demo." }, iso());
    tick();
    handIn(claude.runs.get(id)!, { artifacts: [TRIPS_DEMO] }, DEMO_FILES);
    finish(id);
    tick();
    await settleMedia();
    const art = S.getArtifact(state(), S.latestArtifacts(state())[0].id, 1);
    expect(art.demo).toEqual({ status: "done", at: iso(), variants: [{ variant: "a", status: "recorded-with-errors", tape: "a/demo.tape", gif: "recording/a/demo.gif", reason: line }, { variant: "b", status: "hand-written", files: ["b/plan.ans"] }] });
    expect(S.demoNote(art, "a")).toBe(`Recorded with errors: the demo did not run cleanly in the sandbox (${line})`);
    // The PE was asked for once the recording was made; its envelope says what the recording shows.
    tick();
    const prompt = codex.runs.get(peRuns()[0].id)!.prompt;
    expect(prompt).toContain("  Recorded in the sandbox from a/demo.tape: recording/a/demo.gif.");
    expect(prompt).toContain(`  The recording shows an error the designer did not mean to show: ${line}`);
    expect(prompt).toContain(`Recorded with errors: the demo did not run cleanly in the sandbox (${line})`);
  });

  it("a result the studio refuses is recorded as none, with the reason, and not made again in a loop", async () => {
    const g = gated({ shots: { shots: [{ variant: "z", device: "desktop", path: "shots/z-desktop.png" }], failed: [] } });
    g.release();
    await service({ media: g.media });
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    handIn(claude.runs.get(id)!);
    finish(id);
    tick();
    await settleMedia();
    await settleMedia();
    const art = S.latestArtifacts(state())[0];
    expect(art.shots).toMatchObject({ status: "skipped", reason: "the result could not be recorded (Trip plan has no variant z.)" });
    expect(g.calls).toHaveLength(1);
  });

  it("none starts while the project is paused; they are made once it resumes (review finding 5)", async () => {
    const g = gated({ shots: { skipped: "no Chrome found" } });
    await service({ media: g.media });
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan and the trips demo." }, iso());
    tick();
    handIn(claude.runs.get(id)!, { artifacts: [TRIP_PLAN, TRIPS_DEMO] }, { ...PAGES, ...DEMO_FILES });
    finish(id);
    // Paused with the run's result on its way: the result is imported, but nothing is made of it.
    cmd("pauseProject");
    tick();
    const [screen, demo] = S.latestArtifacts(state());
    expect(runOf(id).status).toBe("completed");
    expect(S.pendingMedia(state()).map((p) => p.kind)).toEqual(["shots", "demo"]);
    await flush();
    tick();
    await flush();
    expect(g.calls).toEqual([]);
    // Resumed: they are made, one at a time.
    cmd("resumeProject");
    tick();
    await flush();
    expect(g.calls).toEqual([`shots ${screen.id} v1`]);
    // Paused while the screenshots are being taken: they finish, and the recording waits for the next resume.
    cmd("pauseProject");
    g.release();
    await settleMedia();
    expect(S.getArtifact(state(), screen.id, 1).shots).toMatchObject({ status: "skipped" });
    tick();
    await flush();
    expect(g.calls).toEqual([`shots ${screen.id} v1`]);
    expect(S.getArtifact(state(), demo.id, 1).demo).toEqual({ status: "pending" });
    cmd("resumeProject");
    tick();
    await settleMedia();
    expect(g.calls).toEqual([`shots ${screen.id} v1`, "record a/demo.tape"]);
    expect(S.getArtifact(state(), demo.id, 1).demo).toMatchObject({ status: "done" });
  });

  it("a version an earlier service left pending is made by the next one", async () => {
    await service();
    const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    handIn(claude.runs.get(id)!);
    finish(id);
    tick();
    const art = S.latestArtifacts(state())[0];
    // This service makes none; say an earlier one had started and stopped before it finished.
    expect(art.shots).toBeUndefined();
    store.update((s) => S.startArtifactMedia(s, art.id, 1), iso());
    await scheduler.stop();
    const g = gated({ shots: { skipped: "no Chrome found" } });
    g.release();
    scheduler = new Scheduler(store, { claude, codex }, { dataDir, leaseMs: 60_000, studioMedia: g.media });
    tick();
    await settleMedia();
    expect(g.calls).toEqual([`shots ${art.id} v1`]);
    expect(S.getArtifact(state(), art.id, 1).shots).toMatchObject({ status: "skipped", reason: "no Chrome found" });
  });
});

const chrome = await launchChrome();
if ("browser" in chrome) await chrome.browser.close();
const sandbox = await probeTerminalSandbox();
const realSkip = "missing" in chrome ? `no Chrome (${chrome.missing})` : !sandbox.ok ? `no terminal sandbox (${sandbox.detail})` : "";

describe(`with the system Chrome and VHS${realSkip ? ` (skipped: ${realSkip})` : ""}`, () => {
  it.skipIf(!!realSkip)(
    "a designer's screen gets its screenshots and its terminal demo its sandboxed recording, served from the version",
    async () => {
      await service({ media: systemMedia(undefined, { recording: true }) });
      const id = startDesignerRun(store, { round: 1, brief: "Make the trip plan and the trips demo." }, iso());
      tick();
      handIn(claude.runs.get(id)!, { artifacts: [TRIP_PLAN, TRIPS_DEMO] }, { ...PAGES, ...DEMO_FILES });
      finish(id);
      tick();
      expect(runOf(id).status).toBe("completed");
      const [screen, demo] = S.latestArtifacts(state());
      for (let i = 0; i < 20 && S.pendingMedia(state()).length; i++) await settleMedia();
      const project = join(dataDir, "studio", state().project.id);
      const shots = S.getArtifact(state(), screen.id, 1).shots;
      expect(shots).toMatchObject({ status: "taken", failed: [] });
      expect(shots?.status === "taken" && shots.shots.map((s) => s.path).sort()).toEqual(["shots/a-desktop.png", "shots/a-mobile.png", "shots/b-desktop.png", "shots/b-mobile.png"]);
      expect(S.getArtifact(state(), demo.id, 1).demo).toEqual({
        status: "done",
        at: expect.any(String),
        variants: [
          { variant: "a", status: "recorded", tape: "a/demo.tape", gif: "recording/a/demo.gif", webm: "recording/a/demo.webm", txt: "recording/a/demo.txt" },
          { variant: "b", status: "hand-written", files: ["b/plan.ans"] },
        ],
      });
      expect(readFileSync(join(project, "artifacts", demo.id, "v1", "recording", "a", "demo.txt"), "utf8")).toContain("Weekend trips from Lisbon");
      // The prototype server serves them, each as its kind.
      const server = createPrototypeServer({ studioDir: () => project, appOrigins: ["http://127.0.0.1:5319"] });
      const port = await listen(server);
      try {
        const type = async (artifactId: string, path: string) => (await get(port, `p-${artifactId}-v1.localhost:${port}`, path)).headers["content-type"];
        expect(await type(screen.id, "/shots/a-mobile.png")).toBe("image/png");
        expect(await type(demo.id, "/recording/a/demo.gif")).toBe("image/gif");
        expect(await type(demo.id, "/recording/a/demo.webm")).toBe("video/webm");
        expect(await type(demo.id, "/recording/a/demo.txt")).toBe("text/plain; charset=utf-8");
      } finally {
        await close(server);
      }
    },
    120_000,
  );
});
