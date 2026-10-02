// ORC-029 pass 4d (decision 6): the project's words in the prose check. The dictionary the owner approved generates
// Vale substitution rules into the service's data folder (never the repository), and the real Vale then reports each
// avoided word as an error that names the term to use. Without a dictionary in force, nothing is generated. The Vale
// tests are skipped, with the reason, where Vale is not installed.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as M from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import { DESIGNER, openRound, peAgrees, run, sha } from "../../src/domain/testing/studio";
import type { State } from "../../src/domain/types";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { ScriptedAdapter } from "../testing/scripted";
import { proseRecord } from "./record";
import { VALE_CONFIG, findVale, runVale, valeChecker, type ProseChecker } from "./vale";
import { projectValeConfig } from "./words";

vi.setConfig({ testTimeout: 20_000 });

const BIN = findVale();
if (!BIN) console.warn("server/prose/words.test.ts: Vale is not installed (brew install vale), so the project's words are not checked through Vale.");

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
const WORDS = [
  { term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey", "outing"] },
  { term: "trip plan", meaning: "The days and stops of one trip.", avoid: ["plan", "itinerary"] },
  { term: "member", meaning: "A person who said they are in.", avoid: [] },
];

/** A project whose data round has the dictionary; approved into the blueprint when `approve`. */
function withWords(approve: boolean, entries: object[] = WORDS, s0: State = fresh(), sec = 1): State {
  const r = openRound(s0, "data", at(sec));
  const a = run<{ artifactId: string }>(r.state, "addStudioArtifact", { round: r.n, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER, dictionary: entries }, at(sec + 1));
  const s = peAgrees(a.state, a.result.artifactId, 1, ["a"], at(sec + 2));
  return approve ? run(s, "approveArtifact", { artifactId: a.result.artifactId, version: 1 }, at(sec + 3)).state : s;
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "orc029-words-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("generating the project's style", () => {
  it("writes nothing without an approved dictionary, or when no term avoids a word", () => {
    expect(projectValeConfig(dataDir, withWords(false))).toBeUndefined();
    expect(projectValeConfig(dataDir, withWords(true, [{ term: "member", meaning: "A person who is in." }]))).toBeUndefined();
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("writes the configuration, the repository's style and one rule per term that avoids words into the data folder", () => {
    const s = withWords(true);
    const config = projectValeConfig(dataDir, s)!;
    const root = join(dataDir, "vale", s.project.id);
    expect(config).toBe(join(root, ".vale.ini"));
    expect(readFileSync(config, "utf8")).toMatch(/\nBasedOnStyles = STE80, Project\n/);
    expect(readdirSync(join(root, "styles", "Project")).sort()).toEqual(["Term1.yml", "Term2.yml"]);
    expect(readdirSync(join(root, "styles", "STE80")).sort()).toEqual(readdirSync(join(VALE_CONFIG, "..", "styles", "STE80")).sort());
    // The repository's own configuration is unchanged.
    expect(readFileSync(VALE_CONFIG, "utf8")).toMatch(/\nBasedOnStyles = STE80\n/);
  });

  it("removes the rule of a term the next approved dictionary no longer has", () => {
    let s = withWords(true);
    projectValeConfig(dataDir, s);
    s = withWords(true, [WORDS[0]], run(s, "closeRound", { round: 1 }, at(10)).state, 11);
    projectValeConfig(dataDir, s);
    expect(readdirSync(join(dataDir, "vale", s.project.id, "styles", "Project"))).toEqual(["Term1.yml"]);
  });
});

describe("the lead's text, through the scheduler, with the project's words", () => {
  let store: Store;
  let claude: ScriptedAdapter;
  let scheduler: Scheduler | undefined;
  let now = Date.parse("2026-10-02T12:00:00Z");
  let key = 0;
  const iso = () => new Date(now).toISOString();
  const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
  beforeEach(() => {
    store = new Store(join(dataDir, "db.sqlite"));
    claude = new ScriptedAdapter("claude");
    cmd("initProject", { name: "Trips", repoPath: join(dataDir, "repo"), vision: "Weekend trips.", focus: "" });
    const round = (cmd("openRound", { focus: "data" }).result as { n: number }).n;
    const { artifactId } = cmd("addStudioArtifact", { round, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER, dictionary: WORDS }).result as { artifactId: string };
    cmd("addPeVerdicts", { artifactId, version: 1, verdicts: [{ variant: "a", verdict: "feasible", reasons: "Words." }] });
    cmd("approveArtifact", { artifactId, version: 1 });
    cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
  });
  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    store.close();
  });
  /** The owner writes; the lead's run starts and answers `reply`. Returns its prompt and its run's prose record. */
  async function exchange(prose: ProseChecker, reply: string) {
    scheduler = new Scheduler(store, { claude, codex: new ScriptedAdapter("codex") }, { leaseMs: 60_000, ackTimeoutMs: 10_000, dataDir, prose });
    await scheduler.refreshHealth();
    cmd("postMessage", { text: "What next?" });
    scheduler.tick((now += 1000));
    const r = M.activeLeadRun(store.read().state)!;
    const prompt = claude.runs.get(r.id)!.prompt;
    claude.emit({ type: "completed", attemptId: r.id, finalText: JSON.stringify({ reply, proposals: [] }) });
    scheduler.tick((now += 1000));
    return { prompt, prose: store.read().state.leadRuns.find((x) => x.id === r.id)!.prose };
  }

  it("checks the lead's reply with the configuration the approved dictionary generated", async () => {
    const configs: (string | undefined)[] = [];
    const { prompt } = await exchange((_text, config) => {
      configs.push(config);
      return { checked: true, vale: "3.24.0", alerts: [] };
    }, "Our journey starts on Friday.");
    expect(prompt).toContain("- trip: A weekend away that a group plans together. Not: journey, outing.");
    expect(configs).toEqual([join(dataDir, "vale", store.read().state.project.id, ".vale.ini")]);
  });

  it.skipIf(!BIN)("with the real Vale, an avoided word in the reply is an error that names the term (skipped where Vale is not installed)", async () => {
    const { prose } = await exchange(valeChecker({ bin: BIN }), "Our journey starts on Friday.");
    expect(prose).toMatchObject({ status: "checked", sentences: 1, passed: 0, rules: [{ rule: "Project.Term1", level: "error", what: "Use 'trip', not 'journey' or 'outing' (the project's dictionary).", count: 1 }] });
  });
});

describe.skipIf(!BIN)("the project's words through Vale (skipped where Vale is not installed)", () => {
  it("reports an avoided word as an error that names the term, and never the term itself", () => {
    const config = projectValeConfig(dataDir, withWords(true))!;
    const text = "Our journey starts on Friday. The trip plan is ready. Read the Trip Plan, not the plan.";
    const out = runVale(text, { bin: BIN, config });
    if (!out.checked) throw new Error(out.reason);
    expect(out.alerts.filter((a) => a.rule.startsWith("Project.")).map((a) => ({ rule: a.rule, level: a.level, match: a.match, col: a.col }))).toEqual([
      { rule: "Project.Term1", level: "error", match: "journey", col: 5 },
      { rule: "Project.Term2", level: "error", match: "plan", col: 83 },
    ]);
    // The record the lead's next envelope is made from says which term to use.
    const record = proseRecord({ text, parts: [{ name: "reply", firstLine: 1 }] }, out, at(20));
    expect(record).toMatchObject({ status: "checked", rules: [{ rule: "Project.Term1", level: "error", what: "Use 'trip', not 'journey' or 'outing' (the project's dictionary).", count: 1 }, { rule: "Project.Term2", level: "error", what: "Use 'trip plan', not 'plan' or 'itinerary' (the project's dictionary).", count: 1 }] });
  });

  it("checks with the repository's style alone when no dictionary is in force", () => {
    const out = runVale("Our journey starts on Friday.", { bin: BIN });
    expect(out.checked && out.alerts.filter((a) => a.rule.startsWith("Project."))).toEqual([]);
    expect(existsSync(join(dataDir, "vale"))).toBe(false);
  });
});
