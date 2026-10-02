// ORC-029 pass 4 at the service, with the fake runtime: the simulated lead runs the studio loop from the owner's
// message. It plans a round ("as it is today" for a repository with code, else the next focus), asks for one designer
// run and one question, labelled simulated; the simulated designer hands in what was asked (a screen, a document, or
// an "as is" reproduction naming files the repository has); the PE reviews it; the owner can answer.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/domain/commands";
import * as M from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import * as S from "../../src/domain/studio/studio";
import { startFactoryAsOwner } from "../../src/domain/testing/factory";
import type { State } from "../../src/domain/types";
import { buildLeadEnvelope } from "../envelope";
import { FakeAdapter, defaultFakeConfig, fakeStudio } from "../runtimes/fake";
import { Scheduler } from "../scheduler";
import { Store } from "../store";

let dir: string;
let dataDir: string;
let store: Store;
let scheduler: Scheduler;
let now = Date.parse("2026-10-02T09:00:00Z");
let key = 0;
const iso = () => new Date(now).toISOString();
const state = (): State => store.read().state;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const tick = () => {
  now += 1000;
  scheduler.tick(now);
};
/** Tick until `done` holds (the fake runtime advances a run a few percent a tick). */
function until(done: (s: State) => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (done(state())) return;
    tick();
  }
  throw new Error(`never: ${what}`);
}

function repo(files: Record<string, string>): string {
  const r = join(dir, "repo");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  execFileSync("git", ["-C", r, "add", "-A"]);
  execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return r;
}

function service(repoPath: string) {
  store = new Store(join(dataDir, "db.sqlite"));
  const catalog = store.read().state.project.catalog;
  scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", defaultFakeConfig(), catalog.claude), codex: new FakeAdapter("codex", defaultFakeConfig(), catalog.codex) }, { dataDir, leaseMs: 60_000 });
  cmd("initProject", { name: "Weekend Trips", repoPath, vision: "Weekend trips for a small group of friends.", focus: "" });
}
const settled = (s: State) => {
  const latest = S.latestArtifacts(s);
  return latest.length > 0 && latest.every((a) => S.readyForOwner(s, a)) && !s.studio.runs.some((r) => ["queued", "running", "stopping"].includes(r.status));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-fake-lead-"));
  dataDir = join(dir, "data");
  mkdirSync(dataDir);
});
afterEach(async () => {
  await scheduler?.stop();
  store?.close();
  scheduler = undefined as unknown as Scheduler;
  store = undefined as unknown as Store;
  rmSync(dir, { recursive: true, force: true });
});

describe("the simulated lead's studio block, from its envelope alone", () => {
  const T0 = Date.parse("2026-10-02T12:00:00Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
  const studioOf = (s: State, repoGlance?: { files: number; codeFiles: number; code: string[] }) => {
    const r = M.startLeadRun(M.postMessage(s, "Go on.", at(10)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(11));
    return fakeStudio(buildLeadEnvelope(r.state, r.state.leadRuns.find((x) => x.id === r.runId)!, "read", undefined, undefined, repoGlance));
  };
  const close = (s: State, n: number) => runCommand(s, "closeRound", { round: n }, at(5)).state;
  const open = (s: State, focus: string) => runCommand(s, "openRound", { focus }, at(4)).state;

  it("plans the next focus in order, each text labelled simulated, and nothing while a round is open or after the flows", () => {
    expect(studioOf(fresh(), { files: 2, codeFiles: 1, code: ["src/index.html"] })).toMatchObject({ openRound: { focus: "material" }, designerRuns: [{ kinds: ["screen"], variants: 1, devices: ["desktop", "mobile"] }] });
    let s = open(fresh(), "experience");
    expect(studioOf(s)).toBeUndefined();
    s = close(s, 1);
    // The data round asks for the project's dictionary too (pass 4d).
    expect(studioOf(s)).toMatchObject({ openRound: { focus: "data" }, designerRuns: [{ kinds: ["contract", "dictionary"], devices: [] }] });
    s = close(open(s, "data"), 2);
    const flows = studioOf(s)!;
    expect(flows).toMatchObject({ openRound: { focus: "flows" }, designerRuns: [{ kinds: ["flow"] }] });
    for (const text of [JSON.stringify((flows.openRound as { summary: string }).summary), (flows.designerRuns as { brief: string }[])[0].brief, (flows.questions as { question: string }[])[0].question]) expect(text).toMatch(/simulated/i);
    expect(studioOf(close(open(s, "flows"), 3))).toBeUndefined();
  });

  it("asks a terminal-only product for a terminal demo, and nothing outside a reply in Vision", () => {
    const terminal = runCommand(fresh(), "setDevices", { devices: ["terminal"] }, at(1)).state;
    expect(studioOf(terminal)).toMatchObject({ openRound: { focus: "experience" }, designerRuns: [{ kinds: ["terminal-demo"], devices: ["terminal"] }] });
    const planning = M.startLeadRun(fresh(), { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(1));
    expect(fakeStudio(buildLeadEnvelope(planning.state, planning.state.leadRuns[0], "read"))).toBeUndefined();
    expect(studioOf(startFactoryAsOwner(fresh(), at(1)))).toBeUndefined();
  });
});

describe("the simulated lead in Vision", () => {
  it("for a repository with code, plans round 0 as it is today: the designer reproduces the screen as is, naming the files it came from, and the PE reviews it", () => {
    service(repo({ "README.md": "# Trips\n", "src/index.html": "<h1>Trips</h1>", "src/trips.css": "h1 {}" }));
    cmd("postMessage", { text: "This is my old trips app. Let's look at it." });
    until((s) => s.studio.rounds.length > 0, "a round");
    const s0 = state();
    const lead = s0.leadRuns.at(-1)!;
    expect(s0.studio.rounds[0]).toMatchObject({ n: 0, focus: "material", summary: "As it is today (simulated): what the code in the repository does now.", leadRunId: lead.id });
    expect(s0.studio.rounds[0].lead!.message).toMatch(/I opened a round on the product as it is today and asked the designer for one run, with one question beside it \(simulated\)\.$/);
    // The owner chooses the domains in the app, so the lead never asks about them.
    expect(s0.studio.rounds[0].lead!.questions).toEqual([{ text: "Is this how the product works today? (simulated)", reason: "Later rounds change what the code does now, so it must be right first.", options: ["Yes", "Mostly: see my pins", "No"] }]);
    const [designer] = s0.studio.runs;
    expect(designer).toMatchObject({ kind: "designer", round: 0, fromLead: { leadRunId: lead.id, kinds: ["screen"], variants: 1, devices: ["desktop", "mobile"] } });
    until(settled, "the reproduction imported and reviewed");
    const s = state();
    const [a] = S.latestArtifacts(s);
    expect(a).toMatchObject({ round: 0, kind: "screen", title: "Trip plan as it is today (simulated sample)", variants: [{ id: "a", label: "As it is today" }], provenance: { asIs: true, files: ["src/index.html", "src/trips.css"] } });
    expect(s.studio.runs.find((r) => r.id === designer.id)).toMatchObject({ status: "completed", simulated: true });
    expect(s.studio.verdicts.filter((v) => v.artifactId === a.id).map((v) => v.verdict)).toEqual(["feasible"]);
    // The owner answers; the lead's next reply plans nothing while the round is open, and never moves the stage.
    cmd("sendFeedback", { entries: [{ artifactId: a.id, version: 1, mark: "keep", pins: [], note: "That is how it works." }] });
    cmd("postMessage", { text: "Yes, that is it." });
    until((x) => x.leadRuns.length === 2 && x.leadRuns[1].outcome === "completed", "the second reply");
    expect(state().studio.rounds).toHaveLength(1);
    expect(state().studio.runs.filter((r) => r.kind === "designer")).toHaveLength(1);
    expect(state().project).toMatchObject({ stage: "shaping", factoryStarts: [] });
  });

  it("for a new idea, plans round 1 on the experience in two takes; once it is closed, the data, as a document", () => {
    service(repo({ "README.md": "# Trips\n" }));
    cmd("setDomains", { domains: ["screen"] });
    cmd("postMessage", { text: "A small app to plan weekend trips with friends." });
    until(settled, "round 1 imported and reviewed");
    const s1 = state();
    expect(s1.studio.rounds[0]).toMatchObject({ n: 1, focus: "experience" });
    expect(s1.studio.rounds[0].lead!.questions[0].text).toBe("Is anything missing from this round? (simulated)");
    expect(S.latestArtifacts(s1)[0]).toMatchObject({ kind: "screen", variants: [{ id: "a" }, { id: "b" }] });
    expect(S.latestArtifacts(s1)[0].provenance).toBeUndefined();
    // The round closes (the service's command, as the lead's closeRound would), and the next reply plans the data.
    cmd("closeRound", { round: 1, summary: "Map first." });
    cmd("postMessage", { text: "Next." });
    until((x) => x.studio.rounds.length === 2 && settled(x), "round 2 imported and reviewed");
    const s2 = state();
    expect(s2.studio.rounds[1]).toMatchObject({ n: 2, focus: "data", summary: "The data (simulated): the product's things and how they relate." });
    const doc = S.latestArtifacts(s2).find((a) => a.round === 2)!;
    expect(doc).toMatchObject({ kind: "contract", title: "Trip data (simulated sample)", devices: [], variants: [{ id: "a", entry: "doc/index.md" }] });
    expect(doc.files.map((f) => f.path)).toEqual(["doc/index.md", "doc/diagram.mmd"]);
    const folder = join(dataDir, "studio", s2.project.id, "artifacts", doc.id, "v1");
    expect(readFileSync(join(folder, "doc", "index.md"), "utf8")).toContain("> Simulated sample: the fake runtime made this, not a designer agent.");
    expect(M.activeLeadRun(s2)).toBeUndefined();
  });
});
