// ORC-029 pass 4d-2b at the service: the studio's designer and PE runs get their role's principles, under the same
// cap as a task step, and record them with their hashes; what they write for the owner (the PE's reasons, changes
// and open cases, the designer's documents) is checked when their result is recorded, on the run; and the next run
// of the same role is told which rules its role's last checked text broke, only then. One test runs the real Vale
// (skipped where it is not installed); the others use a stand-in checker, as the lead's tests do (server/prose/).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as M from "../../src/domain/model";
import { principle, wordCount } from "../../src/domain/principles";
import { buildSeed } from "../../src/domain/seed";
import * as R from "../../src/domain/studio/runs";
import * as S from "../../src/domain/studio/studio";
import { DESIGNER, openRound, sha } from "../../src/domain/testing/studio";
import type { ProseCheck, State } from "../../src/domain/types";
import { LEAD_PRINCIPLES_HEADER, PRINCIPLES_WORD_CAP } from "../envelope";
import { SENTENCE_MARK } from "../prose/record";
import { findVale, valeChecker, type ProseChecker, type ValeAlert } from "../prose/vale";
import type { Assignment } from "../runtimes/types";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { ScriptedAdapter } from "../testing/scripted";
import { startDesignerRun } from "./runs";
import { lastStudioProse, withStudioProse } from "./writing";

vi.setConfig({ testTimeout: 30_000 });

const DESIGNER_FEEDBACK = "## Your last run's documents and the writing standard";
const PE_FEEDBACK = "## Your last review and the writing standard";
const PASSIVE = /\b(?:was|were|is) (?:told|changed|shown)\b/;
/** A stand-in for Vale: every line is one sentence; "was told", "were changed" and "is shown" are passives. */
const standIn: ProseChecker = (text) => {
  const alerts: ValeAlert[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    alerts.push({ rule: SENTENCE_MARK, level: "suggestion", what: "", line: i + 1, col: 1, match: line });
    const m = PASSIVE.exec(line);
    if (m) alerts.push({ rule: "STE80.Passive", level: "warning", what: "The passive voice.", line: i + 1, col: m.index + 1, match: m[0] });
  });
  return { checked: true, vale: "3.24.0", alerts };
};

let dir: string;
let dataDir: string;
let store: Store;
let opened = false;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler | undefined;
let now = Date.parse("2026-10-02T09:00:00Z");
let key = 0;
const iso = () => new Date(now).toISOString();
const state = (): State => store.read().state;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const tick = () => scheduler!.tick((now += 1000));
const runOf = (id: string) => R.getStudioRun(state(), id)!;
const runs = (kind: "designer" | "pe") => state().studio.runs.filter((r) => r.kind === kind);

async function service(prose?: ProseChecker) {
  store = new Store(join(dataDir, "db.sqlite"));
  opened = true;
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  scheduler = new Scheduler(store, { claude, codex }, { dataDir, leaseMs: 60_000, ackTimeoutMs: 10_000, ...(prose ? { prose } : {}) });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Trips", repoPath: join(dir, "repo"), vision: "Weekend trips for a small group of friends.", focus: "" });
  cmd("openRound", { focus: "data" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-studio-writing-"));
  dataDir = join(dir, "data");
  mkdirSync(dataDir);
});
afterEach(async () => {
  await scheduler?.stop();
  scheduler = undefined;
  if (opened) store.close();
  opened = false;
  rmSync(dir, { recursive: true, force: true });
});

const CONTRACT = { kind: "contract", title: "Trip data", devices: [], variants: [{ id: "a", label: "A · As drafted", entry: "doc/index.md" }], files: ["doc/index.md"] };
const BROKEN_DOC = "# Trip data\n\nEach trip has people and one plan.\nThe organiser was told about each change.\n";
const CLEAN_DOC = "# Trip data\n\nEach trip has people and one plan.\nThe service tells the organiser about each change.\n";
const SCREEN = { kind: "screen", title: "Trip plan", devices: ["desktop"], variants: [{ id: "a", label: "A · Map first", entry: "a/index.html" }], files: ["a/index.html"] };
/** The designer at work: write files into the run's staging folder and its studio.json, as its agent would. */
function handIn(a: Assignment, artifact: object, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(a.workspace.path, p)), { recursive: true });
    writeFileSync(join(a.workspace.path, p), text);
  }
  writeFileSync(join(a.workspace.path, "studio.json"), JSON.stringify({ artifacts: [artifact] }));
}
const designerFinish = (id: string) => claude.emit({ type: "completed", attemptId: id, finalText: "I made it.", usage: { costUsd: 0.2 } });
const peFinish = (id: string, verdicts: object[]) => codex.emit({ type: "completed", attemptId: id, finalText: `I read the version.\n\n\`\`\`json\n${JSON.stringify({ verdicts })}\n\`\`\`\n`, usage: { costUsd: 0.1 } });
/** The section from its header to the next "## " header. */
const sectionOf = (prompt: string, header: string) => {
  const at = prompt.indexOf(`${header}\n`);
  if (at < 0) return undefined;
  const next = prompt.indexOf("\n## ", at + header.length);
  return prompt.slice(at, next < 0 ? undefined : next + 1);
};
const headings = (section: string) => [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]);

describe("the principles of the studio's runs", () => {
  it("the designer and the PE each get their role's set under the run header, within the cap, placed before what they hand in, and record each with its hash", async () => {
    await service();
    const d = startDesignerRun(store, { round: 1, brief: "Make the trip data contract." }, iso());
    tick();
    const designer = claude.runs.get(d)!.prompt;
    const ds = sectionOf(designer, LEAD_PRINCIPLES_HEADER)!;
    expect(headings(ds)).toEqual(["Contextualize and write for the reader", "Write controlled English", "Experience first"]);
    expect(ds).not.toContain("Named only");
    expect(wordCount(ds)).toBeLessThanOrEqual(PRINCIPLES_WORD_CAP);
    expect(designer.indexOf("## The brief")).toBeLessThan(designer.indexOf(LEAD_PRINCIPLES_HEADER));
    expect(designer.indexOf(LEAD_PRINCIPLES_HEADER)).toBeLessThan(designer.indexOf("## What to hand in"));
    // The run records exactly what its envelope gave it, each with the hash of the text it got.
    const given = runOf(d).principles!;
    expect(given.map((p) => principle(p.id)!.name)).toEqual(headings(ds));
    for (const p of given) expect(p.hash).toBe(principle(p.id)!.hash);

    handIn(claude.runs.get(d)!, CONTRACT, { "doc/index.md": CLEAN_DOC });
    designerFinish(d);
    tick();
    tick();
    const pe = runs("pe")[0];
    const prompt = codex.runs.get(pe.id)!.prompt;
    const ps = sectionOf(prompt, LEAD_PRINCIPLES_HEADER)!;
    expect(headings(ps)).toEqual(["Contextualize and write for the reader", "Write controlled English", "Foundational thinking", "Prove it works"]);
    expect(ps).not.toContain("Named only");
    expect(wordCount(ps)).toBeLessThanOrEqual(PRINCIPLES_WORD_CAP);
    expect(prompt.indexOf("## The vision")).toBeLessThan(prompt.indexOf(LEAD_PRINCIPLES_HEADER));
    expect(prompt.indexOf(LEAD_PRINCIPLES_HEADER)).toBeLessThan(prompt.indexOf("## Your answer"));
    expect(runOf(pe.id).principles!.map((p) => principle(p.id)!.name)).toEqual(headings(ps));
    for (const p of runOf(pe.id).principles!) expect(p.hash).toBe(principle(p.id)!.hash);
  });
});

describe("the check of what the studio's runs write for the owner", () => {
  it("records the check of a designer's documents and a PE's verdicts on the run; the next run of the same role is told what its role's last text broke, and only while rules broke", async () => {
    await service(standIn);
    // The designer writes a contract with one passive sentence.
    const d1 = startDesignerRun(store, { round: 1, brief: "Make the trip data contract." }, iso());
    tick();
    const d1Prompt = claude.runs.get(d1)!.prompt;
    expect(d1Prompt).not.toContain(DESIGNER_FEEDBACK);
    handIn(claude.runs.get(d1)!, CONTRACT, { "doc/index.md": BROKEN_DOC });
    designerFinish(d1);
    tick();
    expect(runOf(d1).prose).toEqual({
      status: "checked",
      at: expect.any(String),
      vale: "3.24.0",
      sentences: 3,
      passed: 2,
      rules: [{ rule: "STE80.Passive", level: "warning", what: "The passive voice.", count: 1 }],
      examples: [{ rule: "STE80.Passive", part: "Trip data: doc/index.md", line: 4, sentence: "The organiser was told about each change.", match: "was told" }],
    });
    // The artifact is as the designer wrote it, with no score on it.
    const artifactId = S.latestArtifacts(state())[0].id;
    expect(Object.keys(S.getArtifact(state(), artifactId, 1))).not.toContain("prose");

    // The PE reviews it: its prompt has no feedback, since no PE text was checked yet, and the designer's is not its own.
    tick();
    const p1 = runs("pe")[0];
    const p1Prompt = codex.runs.get(p1.id)!.prompt;
    expect(p1Prompt).not.toContain(PE_FEEDBACK);
    expect(p1Prompt).not.toContain(DESIGNER_FEEDBACK);
    const CHANGE = "The cost each were changed by hand; compute it from the trip's total.";
    peFinish(p1.id, [{ variant: "a", verdict: "feasible-if", reasons: "A static file holds it for a small group.", change: CHANGE, openCases: [{ text: "Who pays when a friend drops out?", why: "Nobody set the rule." }] }]);
    tick();
    expect(runOf(p1.id)).toMatchObject({ status: "completed" });
    expect(runOf(p1.id).prose).toEqual({
      status: "checked",
      at: expect.any(String),
      vale: "3.24.0",
      sentences: 4,
      passed: 3,
      rules: [{ rule: "STE80.Passive", level: "warning", what: "The passive voice.", count: 1 }],
      examples: [{ rule: "STE80.Passive", part: "variant a, change", line: 1, sentence: CHANGE, match: "were changed" }],
    });
    expect(Object.keys(state().studio.verdicts[0])).not.toContain("prose");

    // The designer's revision (its brief is the PE's change) is told what its role's last documents broke; not the PE's.
    tick();
    const d2 = runs("designer").at(-1)!;
    expect(d2).toMatchObject({ baseVersion: 1, status: "running" });
    const d2Prompt = claude.runs.get(d2.id)!.prompt;
    expect(sectionOf(d2Prompt, LEAD_PRINCIPLES_HEADER)).toBe(sectionOf(d1Prompt, LEAD_PRINCIPLES_HEADER));
    expect(d2Prompt).toContain(`${DESIGNER_FEEDBACK}
Your last run's documents broke these rules of "Write controlled English" (2 of 3 sentences passed). Apply the principle in this run's documents. Do not mention this check to the owner.
- The passive voice: 1
Examples from your last run's documents:
- The passive voice, Trip data: doc/index.md line 4: "The organiser was told about each change." ("was told")
`);
    expect(d2Prompt).not.toContain(PE_FEEDBACK);
    // Near what it hands in: after its principles, just before the output instructions.
    expect(d2Prompt.indexOf(LEAD_PRINCIPLES_HEADER)).toBeLessThan(d2Prompt.indexOf(DESIGNER_FEEDBACK));
    expect(d2Prompt.indexOf(DESIGNER_FEEDBACK)).toBeLessThan(d2Prompt.indexOf("## What to hand in"));
    handIn(claude.runs.get(d2.id)!, CONTRACT, { "doc/index.md": CLEAN_DOC });
    designerFinish(d2.id);
    tick();
    expect(runOf(d2.id).prose).toMatchObject({ status: "checked", sentences: 3, passed: 3, rules: [], examples: [] });

    // The PE's second pass is told what its first broke.
    tick();
    const p2 = runs("pe").at(-1)!;
    expect(p2).toMatchObject({ baseVersion: 2, status: "running" });
    const p2Prompt = codex.runs.get(p2.id)!.prompt;
    expect(p2Prompt).toContain(`${PE_FEEDBACK}
Your last review broke these rules of "Write controlled English" (3 of 4 sentences passed). Apply the principle in this review. Do not mention this check to the owner.
- The passive voice: 1
Examples from your last review:
- The passive voice, variant a, change line 1: "${CHANGE}" ("were changed")
`);
    expect(p2Prompt).not.toContain(DESIGNER_FEEDBACK);
    expect(p2Prompt.indexOf(PE_FEEDBACK)).toBeLessThan(p2Prompt.indexOf("## Your answer"));
    const ask = state().studio.verdicts[0].id;
    peFinish(p2.id, [{ variant: "a", earlier: [{ ask, met: true }], verdict: "feasible", reasons: "The service computes the cost each from the total." }]);
    tick();
    expect(runOf(p2.id).prose).toMatchObject({ status: "checked", sentences: 1, passed: 1, rules: [] });

    // Both roles' last texts broke nothing: their next runs get no feedback. A screen holds no designer text, so no record.
    const d3 = startDesignerRun(store, { round: 1, brief: "Make the trip plan." }, iso());
    tick();
    expect(claude.runs.get(d3)!.prompt).not.toContain(DESIGNER_FEEDBACK);
    handIn(claude.runs.get(d3)!, SCREEN, { "a/index.html": "<!doctype html><h1>The plan was told to nobody</h1>" });
    designerFinish(d3);
    tick();
    expect(runOf(d3)).toMatchObject({ status: "completed" });
    expect(runOf(d3).prose).toBeUndefined();
    tick();
    const p3 = runs("pe").at(-1)!;
    expect(p3).toMatchObject({ artifactId: S.latestArtifacts(state()).find((a) => a.kind === "screen")!.id, status: "running" });
    expect(codex.runs.get(p3.id)!.prompt).not.toContain(PE_FEEDBACK);
  });

  it("an answer the studio refuses fails the run and records no check", async () => {
    await service(standIn);
    const d = startDesignerRun(store, { round: 1, brief: "Make the trip data contract." }, iso());
    tick();
    handIn(claude.runs.get(d)!, CONTRACT, { "doc/index.md": CLEAN_DOC });
    designerFinish(d);
    tick();
    tick();
    const pe = runs("pe")[0];
    // A verdict on a variant the artifact does not have: the studio refuses it, so nothing of it is recorded.
    peFinish(pe.id, [{ variant: "zz", verdict: "feasible", reasons: "The cost was told to nobody." }]);
    tick();
    expect(runOf(pe.id)).toMatchObject({ status: "failed", note: expect.stringMatching(/^Its verdicts were refused/) });
    expect(runOf(pe.id).prose).toBeUndefined();
  });

  it("without Vale the run records 'not checked' with the reason, its result is recorded as usual, and no feedback follows", async () => {
    await service(valeChecker({ bin: join(dir, "no-vale-here") }));
    const d1 = startDesignerRun(store, { round: 1, brief: "Make the trip data contract." }, iso());
    tick();
    handIn(claude.runs.get(d1)!, CONTRACT, { "doc/index.md": BROKEN_DOC });
    designerFinish(d1);
    tick();
    expect(runOf(d1)).toMatchObject({ status: "completed", prose: { status: "not-checked", at: expect.any(String), reason: "Vale was not found" } });
    expect(S.latestArtifacts(state())).toHaveLength(1);
    tick();
    const p1 = runs("pe")[0];
    peFinish(p1.id, [{ variant: "a", verdict: "feasible-if", reasons: "Fine for a small group.", change: "The cost each were changed by hand; compute it." }]);
    tick();
    expect(runOf(p1.id)).toMatchObject({ status: "completed", prose: { status: "not-checked", reason: "Vale was not found" } });
    expect(state().studio.verdicts).toHaveLength(1);
    tick();
    const d2 = runs("designer").at(-1)!;
    expect(d2).toMatchObject({ baseVersion: 1, status: "running" });
    expect(claude.runs.get(d2.id)!.prompt).not.toContain(DESIGNER_FEEDBACK);
  });

  it("checks the designer's documents and the PE's verdicts with the project's words once a dictionary is in force", async () => {
    const configs: (string | undefined)[] = [];
    await service((_text, config) => {
      configs.push(config);
      return { checked: true, vale: "3.24.0", alerts: [] };
    });
    const words = [{ term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey"] }];
    const { artifactId } = cmd("addStudioArtifact", { round: 1, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER, dictionary: words }).result as { artifactId: string };
    if (!S.readyForOwner(state(), S.latestArtifacts(state()).find((a) => a.id === artifactId)!)) cmd("addPeVerdicts", { artifactId, version: 1, verdicts: [{ variant: "a", verdict: "feasible", reasons: "Words." }] });
    cmd("approveArtifact", { artifactId, version: 1 });
    const d1 = startDesignerRun(store, { round: 1, brief: "Make the trip data contract." }, iso());
    tick();
    handIn(claude.runs.get(d1)!, CONTRACT, { "doc/index.md": CLEAN_DOC });
    designerFinish(d1);
    tick();
    tick();
    const p1 = runs("pe").find((r) => r.baseVersion === 1 && r.artifactId !== artifactId)!;
    peFinish(p1.id, [{ variant: "a", verdict: "feasible", reasons: "Fine for a small group." }]);
    tick();
    const config = join(dataDir, "vale", state().project.id, ".vale.ini");
    expect(runOf(d1).prose).toMatchObject({ status: "checked" });
    expect(runOf(p1.id).prose).toMatchObject({ status: "checked" });
    expect(configs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(configs)).toEqual(new Set([config]));
  });

  it("a scheduler with no checker records nothing", async () => {
    await service();
    const d = startDesignerRun(store, { round: 1, brief: "Make the trip data contract." }, iso());
    tick();
    handIn(claude.runs.get(d)!, CONTRACT, { "doc/index.md": BROKEN_DOC });
    designerFinish(d);
    tick();
    expect(runOf(d)).toMatchObject({ status: "completed" });
    expect(runOf(d).prose).toBeUndefined();
  });

  it.skipIf(!findVale())("with the real Vale: a 40-word sentence in a designer's document is an error, and the next designer run names it (skipped where Vale is not installed)", async () => {
    await service(valeChecker());
    const long = `The designer read the brief and the vision and the owner's marks and wrote this contract ${"with one more field and ".repeat(6)}nothing else to report today.`;
    const d1 = startDesignerRun(store, { round: 1, brief: "Make the trip data contract." }, iso());
    tick();
    handIn(claude.runs.get(d1)!, CONTRACT, { "doc/index.md": `# Trip data\n\n${long}\n\nEach trip has one plan.\n` });
    designerFinish(d1);
    tick();
    expect(runOf(d1).prose).toMatchObject({ status: "checked", vale: "3.24.0", sentences: 3, passed: 2, rules: [{ rule: "STE80.SentenceLength", level: "error", what: "A sentence over 35 words.", count: 1 }] });
    const d2 = startDesignerRun(store, { round: 1, brief: "Make the trip plan flow." }, iso());
    tick();
    expect(claude.runs.get(d2)!.prompt).toContain("- A sentence over 35 words (error): 1\n");
  });
});

describe("the role's last checked text", () => {
  const T0 = Date.parse("2026-10-02T09:00:00Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const check = (sec: number, broke: boolean): ProseCheck => ({ status: "checked", at: at(sec), vale: "3.24.0", sentences: 2, passed: broke ? 1 : 2, rules: broke ? [{ rule: "STE80.Vague", level: "warning", what: "A vague word.", count: 1 }] : [], examples: [] });

  it("is the newest check of the same role recorded before the run started, whatever order the runs were asked in", () => {
    let s = openRound(M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0)), "data", at(1)).state;
    const ask = (sec: number) => {
      const r = R.requestStudioRun(s, { kind: "designer", round: 1, brief: "Make it." }, at(sec));
      s = r.state;
      return r.runId;
    };
    const a = ask(2);
    const b = ask(2);
    s = R.dispatchStudioRuns(s, at(3)).state;
    // b finishes first, then a; c is asked and starts after both.
    s = withStudioProse(R.completeStudioRun(s, b, at(5), { summary: "b" }), b, check(5, true));
    s = withStudioProse(R.completeStudioRun(s, a, at(6), { summary: "a" }), a, check(6, false));
    const c = ask(7);
    s = R.dispatchStudioRuns(s, at(8)).state;
    expect(lastStudioProse(s, R.getStudioRun(s, c)!)).toEqual(check(6, false));
    // Neither a nor b saw the other's check: both started before either was recorded.
    expect(lastStudioProse(s, R.getStudioRun(s, a)!)).toBeUndefined();
    expect(lastStudioProse(s, R.getStudioRun(s, b)!)).toBeUndefined();
    // A run that did not complete keeps no check.
    const d = ask(9);
    s = R.dispatchStudioRuns(s, at(9)).state;
    expect(withStudioProse(R.reportStudioRunFailed(s, d, "no studio.json", at(10)), d, check(10, true))).toEqual(R.reportStudioRunFailed(s, d, "no studio.json", at(10)));
  });
});
