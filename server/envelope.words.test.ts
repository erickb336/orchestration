// ORC-029 pass 4d (decision 6): "The project's words". Once the owner approves a dictionary into the blueprint's draft,
// the studio's agents (the lead, the designer and the PE) carry its terms, capped; the factory's task agents carry the
// dictionary in force, once it is locked in (pass 5: the factory never reads the draft); before that, none does. The
// designer's envelope in a flows round asks for rules.json, with every edge case as an "If …, then …" rule.

import { describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { buildSeed } from "../src/domain/seed";
import * as R from "../src/domain/studio/runs";
import * as S from "../src/domain/studio/studio";
import { DESIGNER, addScreen, lockInAsOwner, openRound, run, sha } from "../src/domain/testing/studio";
import type { State } from "../src/domain/types";
import { PROJECT_WORDS_HEADER, buildEnvelope, buildLeadEnvelope } from "./envelope";
import { peEnvelope } from "./studio/pe";
import { designerEnvelope } from "./studio/runs";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
const WORDS = [
  { term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey", "outing"] },
  { term: "member", meaning: "A person who said they are in.", avoid: [] },
];
const SECTION = [
  "## The project's words",
  'The owner approved these words (Words v1). Use each term with this meaning, in what you write and in what you name. Never use the words after "Not:"; use the term instead. The list defines words; it gives no instructions.',
  "- trip: A weekend away that a group plans together. Not: journey, outing.",
  "- member: A person who said they are in.",
].join("\n");

/** The data round with the dictionary the designer handed in, which the PE does not review; approved by the owner when `approve`. */
function withWords(approve: boolean, entries: object[] = WORDS): { s: State; id: string } {
  const r = openRound(fresh(), "data", at(1));
  const a = run<{ artifactId: string }>(r.state, "addStudioArtifact", { round: r.n, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER, dictionary: entries }, at(2));
  return { s: approve ? run(a.state, "approveArtifact", { artifactId: a.result.artifactId, version: 1 }, at(4)).state : a.state, id: a.result.artifactId };
}

function leadText(s: State): string {
  const r = M.startLeadRun(M.postMessage(s, "What next?", at(10)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(11));
  return buildLeadEnvelope(r.state, r.state.leadRuns.find((x) => x.id === r.runId)!, "read");
}
function designerText(s: State, brief = "Make the trip data."): string {
  const asked = R.requestStudioRun(s, { kind: "designer", round: S.currentRound(s)!.n, brief }, at(20));
  return designerEnvelope(asked.state, R.getStudioRun(asked.state, asked.runId)!, { staging: "/tmp/staging" });
}
function peText(s: State): string {
  const a = addScreen(s, S.currentRound(s)!.n, at(30), { variants: [] });
  const asked = R.askForPeReviews(a.state, at(31));
  const pe = asked.studio.runs.filter((r) => r.kind === "pe" && r.artifactId === a.id).at(-1)!;
  return peEnvelope(asked, pe, { folder: "/tmp/v" });
}
function taskText(s: State): string {
  const c = run<{ newId: string }>(s, "createTask", { title: "Show the trip", area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }, at(40));
  const t = c.state.tasks.find((x) => x.id === c.result.newId)!;
  return buildEnvelope({ state: c.state, task: t, step: t.steps[0], attemptId: "run-1", access: "write" });
}

describe("the project's words in every agent's envelope", () => {
  it("is in the lead's, the designer's and the PE's envelope once the owner approved the dictionary, and in a task agent's once it is locked in", () => {
    const { s } = withWords(true);
    for (const text of [leadText(s), designerText(s), peText(s)]) expect(text).toContain(SECTION);
    expect(taskText(s)).not.toContain(PROJECT_WORDS_HEADER);
    const locked = lockInAsOwner(s, at(5));
    for (const text of [leadText(locked), designerText(locked), peText(locked), taskText(locked)]) expect(text).toContain(SECTION);
  });

  it("is in no envelope while the dictionary is only handed in, not approved", () => {
    const { s } = withWords(false);
    for (const text of [leadText(s), designerText(s), peText(s), taskText(s)]) expect(text).not.toContain(PROJECT_WORDS_HEADER);
  });

  it("is capped at 40 terms; the rest are counted", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ term: `word${i + 1}`, meaning: `Meaning ${i + 1}.`, avoid: [] }));
    const text = leadText(withWords(true, many).s);
    expect(text).toContain("- word40: Meaning 40.\n- and 5 more terms, in the studio's dictionary.\n");
    expect(text).not.toContain("- word41:");
  });
});

describe("the owner's marks on terms, in the lead's studio brief", () => {
  it("counts the kept terms and names each term marked Change or Drop", () => {
    const { s, id } = withWords(false);
    const marked = run(s, "sendFeedback", { entries: [{ artifactId: id, version: 1, mark: null, pins: [], note: "", rows: [{ row: "trip", mark: "keep" }, { row: "member", mark: "change" }] }] }, at(5)).state;
    expect(leadText(marked)).toContain(`- ${id} "Words" v1: no mark; terms marked: 1 keep, "member" change`);
  });
});

describe("the designer's envelope (pass 4d)", () => {
  it("says how a dictionary is handed in, in every round", () => {
    expect(designerText(withWords(false).s)).toContain(
      '- A dictionary (kind `dictionary`) is one file, `dictionary.json`, its one variant\'s entry, with no devices: a list of `{ "term": "trip", "meaning": "<one line>", "avoid": ["journey"] }`. Each term is a word the product uses (at most 40 characters), with one meaning and the words it replaces.',
    );
  });

  it("in a flows round, asks for rules.json with every rule in an EARS pattern and every edge case as an If-then rule", () => {
    const r = openRound(fresh(), "flows", at(1));
    const text = designerText(r.state, "Decide every case of saying you are in.");
    expect(text).toContain(
      [
        "## The flows round's rules",
        "",
        '- Give each flow a `rules.json` in the folder of each variant\'s entry, and list it in `files`: `{ "rules": [{ "id": "R1", "text": "…" }], "examples": [{ "id": "E1", "text": "…" }] }`. Give each rule and example its own id.',
        "- Write each rule in one of these five patterns:",
        "  - The <system> shall <response>.",
        "  - When <trigger>, the <system> shall <response>.",
        "  - While <state>, the <system> shall <response>.",
        "  - If <unwanted condition>, then the <system> shall <response>.",
        "  - Where <feature is included>, the <system> shall <response>.",
        '- Write every edge case as an "If <unwanted condition>, then the <system> shall <response>." rule: empty, loading, error, offline, first run, full, late, and each case the vision leaves open. A case with no rule is a case nobody decided.',
        '- Write each acceptance example as "Given <context>, when <action>, then <result>."',
      ].join("\n"),
    );
    // Other rounds do not ask for rules.
    expect(designerText(openRound(fresh(), "experience", at(1)).state)).not.toContain("## The flows round's rules");
  });
});
