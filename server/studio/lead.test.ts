// ORC-029 pass 4 at the service, with the fake runtime: the simulated lead runs the studio loop from the owner's
// message. It plans the next focus (the import, not the lead, makes round 0 of an existing repository: ORC-032), asks
// for one designer run and one question, labelled simulated; the simulated designer hands in what was asked (a screen or
// a document); the PE reviews it; the owner can answer. Once an import is in review, the lead writes its message.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/domain/commands";
import * as M from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import * as S from "../../src/domain/studio/studio";
import * as I from "../../src/domain/studio/import";
import { startFactoryAsOwner } from "../../src/domain/testing/factory";
import type { State } from "../../src/domain/types";
import { buildLeadEnvelope } from "../envelope";
import { FakeAdapter, defaultFakeConfig, fakeStudio } from "../runtimes/fake";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { tallyRepo } from "./import";

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
    // A repository with code changes nothing here: the import makes round 0 (C12).
    expect(studioOf(fresh(), { files: 2, codeFiles: 1, code: ["src/index.html"] })).toMatchObject({ openRound: { focus: "experience" }, designerRuns: [{ kinds: ["screen"], variants: 2, devices: ["desktop", "mobile"] }] });
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
  it("for a repository with code, opens round 1 on the experience: the import, not the lead, reproduces the code (C12)", () => {
    service(repo({ "README.md": "# Trips\n", "src/index.html": "<h1>Trips</h1>", "src/trips.css": "h1 {}" }));
    cmd("postMessage", { text: "This is my old trips app. Let's look at it." });
    until((s) => s.studio.rounds.length > 0, "a round");
    const s0 = state();
    expect(s0.studio.rounds[0]).toMatchObject({ n: 1, focus: "experience", leadRunId: s0.leadRuns.at(-1)!.id });
    expect(s0.studio.runs[0]).toMatchObject({ kind: "designer", round: 1 });
    until(settled, "round 1 imported and reviewed");
    expect(S.latestArtifacts(state()).every((a) => !a.provenance)).toBe(true);
  });

  it("once the import is in review, the lead replies by itself: what it found, with a vision draft of the product today (ORC-032)", async () => {
    const r = tallyRepo(join(dir, "tally"));
    service(r);
    cmd("setDomains", { domains: ["screen", "code"] });
    cmd("setDevices", { devices: ["terminal"] });
    const commit = execFileSync("git", ["-C", r, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    cmd("startImport", { commit, budgetUsd: 3, helpers: null, size: { sourceFiles: 7, testFiles: 7, kb: 12 } });
    // The import's service steps end asynchronously: wait for each before the next cycle.
    for (let i = 0; i < 400 && I.importStatus(state()) !== "review"; i++) {
      tick();
      await scheduler.importIdle();
    }
    expect(I.importStatus(state())).toBe("review");
    const drafts = state().visionDrafts.length;
    // No message is needed: the review itself wakes the lead, once (src/domain/model/lead.ts).
    until((x) => x.leadRuns.some((l) => l.outcome === "completed"), "the lead's reply");
    const reply = state().conversation.filter((m) => m.author === "lead").at(-1)!;
    expect(reply.text).toBe(
      `I read the repository at commit ${commit.slice(0, 7)} as it is today: the tests ran: 22, 22 pass; 17 rules, 13 named by tests; 6 parts; the screens and commands 3 of 3 recorded. The questions wait in Vision, round 0: answer the conflicts and the guesses that matter, then lock the baseline in (simulated).`,
    );
    // Its vision draft (C10): the owner accepts it on the Baseline screen.
    expect(state().visionDrafts).toHaveLength(drafts + 1);
    expect(state().visionDrafts.at(-1)!).toMatchObject({ status: "open", messageIds: [], reason: "A first draft from the import, for you to accept on the Baseline screen." });
    expect(state().visionDrafts.at(-1)!.text).toMatch(/^\(Simulated draft\) What the product is today, from the import at commit /);
    // The lead opened no round: round 0 is the import's. It replied once.
    expect(state().studio.rounds.map((x) => x.n)).toEqual([0]);
    for (let i = 0; i < 10; i++) tick();
    expect(state().leadRuns).toHaveLength(1);
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

  it("answers your marks: a Change brings the part's next version, from your note; it does not redraft the vision from them (ORC-030 QA, Q-07)", () => {
    service(repo({ "README.md": "# Trips\n" }));
    cmd("setDomains", { domains: ["screen"] });
    cmd("postMessage", { text: "A small app to plan weekend trips with friends." });
    until(settled, "round 1 imported and reviewed");
    const part = S.latestArtifacts(state())[0];
    const drafts = state().visionDrafts.length;
    cmd("sendFeedback", { entries: [{ artifactId: part.id, version: part.version, mark: "change", pickedVariant: "a", pins: [], note: "Show the stops as a list too." }] });
    cmd("postMessage", { text: "My feedback, recorded on each version: Trip plan, change, a note." });
    until((x) => x.leadRuns.filter((r) => r.outcome === "completed").length === 2, "the lead's answer");
    const reply = state().conversation.filter((m) => m.author === "lead").at(-1)!;
    expect(reply.text).toMatch(/^I asked the designer for the next version of Trip plan \(simulated sample\), with your note\./);
    expect(state().visionDrafts).toHaveLength(drafts);
    const ask = state().studio.runs.find((r) => r.kind === "designer" && r.artifactId === part.id && r.fromLead);
    expect(ask).toMatchObject({ round: 1, baseVersion: part.version });
    expect(ask!.brief).toContain("Show the stops as a list too.");
    until((x) => (S.latestVersion(x, part.id)?.version ?? 0) > part.version, "the next version");
    expect(S.latestVersion(state(), part.id)).toMatchObject({ version: part.version + 1, round: 1 });
    // Keep and Drop need nothing from the designer.
    until(settled, "the next version reviewed");
    const next = S.latestVersion(state(), part.id)!;
    cmd("sendFeedback", { entries: [{ artifactId: part.id, version: next.version, mark: "keep", pins: [], note: "" }] });
    cmd("postMessage", { text: "My feedback: Trip plan, keep." });
    until((x) => x.leadRuns.filter((r) => r.outcome === "completed").length === 3, "the lead's second answer");
    expect(state().studio.runs.filter((r) => r.kind === "designer" && r.fromLead && r.artifactId === part.id)).toHaveLength(1);
    expect(state().conversation.filter((m) => m.author === "lead").at(-1)!.text).toMatch(/^Noted your marks: Trip plan \(simulated sample\) stays as it is\./);
  });
});
