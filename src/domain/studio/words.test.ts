// ORC-029 pass 4d (decisions 6 and 7): the project's dictionary and the fixed sentence patterns of a flow's rules.
// The parsers check what a designer hands in (each refusal says which line and why); the studio records the result,
// takes the owner's mark on each term and rule, and only the dictionary the owner approved into the blueprint is in
// force.

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { buildSeed } from "../seed";
import { DESIGNER, openRound, peAgrees, run, sha } from "../testing/studio";
import type { State } from "../types";
import * as B from "./blueprint";
import * as S from "./studio";
import { PATTERNS_HELP, isExample, parseDictionary, parseRules, rulePattern } from "./words";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));

const WORDS = [
  { term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey", "outing"] },
  { term: "trip plan", meaning: "The days and stops of one trip.", avoid: ["itinerary"] },
  { term: "member", meaning: "A person who said they are in.", avoid: [] },
];

describe("the dictionary's file", () => {
  it("reads a list of terms, each with its meaning and the words it replaces, one line each", () => {
    expect(parseDictionary([{ term: " trip ", meaning: "A weekend\naway.", avoid: ["journey"] }, { term: "member", meaning: "In." }])).toEqual({
      ok: true,
      value: [
        { term: "trip", meaning: "A weekend away.", avoid: ["journey"] },
        { term: "member", meaning: "In.", avoid: [] },
      ],
    });
  });

  it("refuses a file that is not a list of terms, or that has none", () => {
    expect(parseDictionary({ terms: WORDS })).toEqual({ ok: false, errors: ['dictionary.json is a list of { "term", "meaning", "avoid" }'] });
    expect(parseDictionary([])).toEqual({ ok: false, errors: ["dictionary.json has between 1 and 100 terms; it has 0"] });
    expect(parseDictionary(Array.from({ length: 101 }, (_, i) => ({ term: `t${i}`, meaning: "m" })))).toEqual({ ok: false, errors: ["dictionary.json has between 1 and 100 terms; it has 101"] });
  });

  it("refuses a term twice, an avoided word that is a term, a word avoided under two terms, and a term that avoids itself", () => {
    const r = parseDictionary([
      { term: "Trip", meaning: "A weekend away.", avoid: ["journey", "member", "trip"] },
      { term: "trip", meaning: "Again." },
      { term: "outing", meaning: "A day out.", avoid: ["Journey"] },
      { term: "member", meaning: "A person who is in." },
    ]);
    expect(r).toEqual({
      ok: false,
      errors: [
        'term 1 ("Trip"): it avoids itself',
        'term 2 ("trip") is also term 1: list each term once',
        'term 1 ("Trip"): the avoided word "member" is also a term (term 4); a word is either used or avoided',
        'term 3 ("outing"): the avoided word "Journey" is also avoided under "Trip"; each avoided word has one term to use instead',
      ],
    });
  });

  it("refuses the wrong shapes and sizes, naming the term", () => {
    const r = parseDictionary([
      { term: "<b>trip</b>", meaning: "x" },
      { term: "member", meaning: "" },
      { term: "group", meaning: "x".repeat(301) },
      { term: "stop", meaning: "A place.", avoid: "halt" },
      { term: "cost", meaning: "Money.", avoid: Array.from({ length: 9 }, (_, i) => `w${i}`) },
      "trip",
    ]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toEqual([
      'term 1 ("<b>trip</b>"): "term" is 1 to 40 characters: letters, digits, spaces, "-", "\'" and ".", starting with a letter or a digit',
      'term 2 ("member"): "meaning" is one line of 1 to 300 characters',
      'term 3 ("group"): "meaning" is one line of 1 to 300 characters',
      'term 4 ("stop"): "avoid" is a list of at most 8 words',
      'term 5 ("cost"): "avoid" is a list of at most 8 words',
      'term 6 is not { "term", "meaning", "avoid" }',
    ]);
  });
});

describe("rule patterns (EARS) and examples (Given, when, then)", () => {
  it("names the pattern each of the five forms fits, without case and with or without the final period", () => {
    expect(rulePattern("The app shall show the cost each.")).toBe("always");
    expect(rulePattern("When a member says they are in, the app shall show the cost each again.")).toBe("event");
    expect(rulePattern("While the trip is full, the app shall add each new member to the waiting list.")).toBe("state");
    expect(rulePattern("If the trip has started, then the app shall refuse a new member and tell the organiser.")).toBe("unwanted");
    expect(rulePattern("Where payments are included, the app shall split the cost.")).toBe("optional");
    expect(rulePattern("if the network drops, THEN THE APP SHALL keep the answer and send it later")).toBe("unwanted");
  });

  it("finds no pattern in a sentence outside the five", () => {
    expect(rulePattern("If the trip is full, the app shall add you to the waiting list.")).toBeUndefined(); // no "then"
    expect(rulePattern("The app will show the cost.")).toBeUndefined(); // no "shall"
    expect(rulePattern("When a member joins the app shall tell the group.")).toBeUndefined(); // no comma
    expect(rulePattern("Show the cost each.")).toBeUndefined();
    expect(rulePattern("The app shall.")).toBeUndefined(); // no response
  });

  it("reads an example only in the form Given, when, then", () => {
    expect(isExample("Given a trip with one bed left, when Kim says she is in, then Kim is in and the trip is full.")).toBe(true);
    expect(isExample("given a full trip, WHEN Sam says he is in, THEN Sam is on the waiting list")).toBe(true);
    expect(isExample("When Sam says he is in, then Sam is on the waiting list.")).toBe(false);
    expect(isExample("Given a full trip, Sam is on the waiting list.")).toBe(false);
  });
});

describe("the flow's rules.json", () => {
  it("reads the rules with their patterns, and the examples", () => {
    const r = parseRules({
      rules: [
        { id: "R1", text: "When a member says they are in, the app shall show the cost each." },
        { id: "R2", text: "If the trip is full, then the app shall add the member to the waiting list." },
      ],
      examples: [{ id: "E1", text: "Given a full trip, when Sam says he is in, then Sam is on the waiting list." }],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        rules: [
          { id: "R1", text: "When a member says they are in, the app shall show the cost each.", pattern: "event" },
          { id: "R2", text: "If the trip is full, then the app shall add the member to the waiting list.", pattern: "unwanted" },
        ],
        examples: [{ id: "E1", text: "Given a full trip, when Sam says he is in, then Sam is on the waiting list." }],
      },
    });
    expect(parseRules({ rules: [{ id: "R1", text: "The app shall show the cost each." }] })).toEqual({ ok: true, value: { rules: [{ id: "R1", text: "The app shall show the cost each.", pattern: "always" }], examples: [] } });
  });

  it("names each line that fits no pattern by its id, then the patterns it may fit", () => {
    const r = parseRules({
      rules: [
        { id: "R1", text: "The app shall show the cost each." },
        { id: "R2", text: "If the trip is full, the app shall add the member to the waiting list." },
      ],
      examples: [{ id: "E1", text: "Sam joins a full trip and waits." }],
    });
    expect(r).toEqual({
      ok: false,
      errors: ['rule R2 fits no pattern: "If the trip is full, the app shall add the member to the waiting list."', 'example E1 fits no pattern: "Sam joins a full trip and waits."', PATTERNS_HELP],
    });
    expect(PATTERNS_HELP).toBe(
      'A rule fits one of: "The <system> shall <response>."; "When <trigger>, the <system> shall <response>."; "While <state>, the <system> shall <response>."; "If <unwanted condition>, then the <system> shall <response>."; "Where <feature is included>, the <system> shall <response>.". An example fits "Given <context>, when <action>, then <result>."',
    );
  });

  it("refuses the wrong shape, ids used twice, and an empty list", () => {
    expect(parseRules([{ id: "R1", text: "The app shall work." }])).toEqual({ ok: false, errors: ['rules.json is { "rules": [{ "id", "text" }], "examples": [{ "id", "text" }] }'] });
    expect(parseRules({ rules: [] })).toEqual({ ok: false, errors: ["rules.json has between 1 and 60 rules; it has 0"] });
    expect(parseRules({ rules: [{ id: "R1", text: "The app shall work." }], examples: "none" })).toEqual({ ok: false, errors: ['"examples" in rules.json is a list of { "id", "text" }'] });
    expect(parseRules({ rules: [{ id: "R1", text: "The app shall work." }, { id: "R1", text: "The app shall rest." }, { id: "r 3", text: "The app shall sleep." }, { text: "x" }] })).toEqual({
      ok: false,
      errors: ["rule R1: the id is used twice; give each rule and example its own", 'rule 3: the id "r 3" is 1 to 20 letters, digits, "-" and "_"', 'rule 4 is not { "id", "text" }'],
    });
  });
});

/** Round `focus` open, with a dictionary the designer handed in (WORDS unless given). */
function withDictionary(s = fresh(), entries: unknown = WORDS, sec = 1) {
  const r = S.currentRound(s) ? { state: s, n: S.currentRound(s)!.n } : openRound(s, "data", at(sec));
  const args = { round: r.n, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER, dictionary: entries };
  const a = run<{ artifactId: string; version: number }>(r.state, "addStudioArtifact", args, at(sec + 1));
  return { s: a.state, id: a.result.artifactId, version: a.result.version };
}
const marks = (s: State, artifactId: string, version: number, rows: object[], extra: object = {}) => run(s, "sendFeedback", { entries: [{ artifactId, version, mark: null, pins: [], note: "", rows, ...extra }] }, at(40)).state;
const approve = (s: State, artifactId: string, version: number) => run(s, "approveArtifact", { artifactId, version }, at(50)).state;

describe("the dictionary in the studio", () => {
  it("records the terms on the version; a dictionary without terms, or terms on another kind, is refused", () => {
    const { s, id } = withDictionary();
    expect(S.getArtifact(s, id, 1)).toMatchObject({ kind: "dictionary", dictionary: WORDS });
    const r0 = openRound(fresh(), "data", at(1));
    expect(() => run(r0.state, "addStudioArtifact", { round: r0.n, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER }, at(2))).toThrow("A dictionary lists its terms.");
    expect(() => withDictionary(fresh(), [{ term: "trip", meaning: "x", avoid: ["trip"] }])).toThrow('dictionary: term 1 ("trip"): it avoids itself');
    const r = openRound(fresh(), "data", at(1));
    expect(() => run(r.state, "addStudioArtifact", { round: r.n, kind: "contract", title: "Trip data", variants: [], files: [{ path: "doc/index.md", sha256: sha("c") }], devices: [], madeBy: DESIGNER, dictionary: WORDS }, at(2))).toThrow("Only a dictionary lists terms.");
  });

  it("takes the owner's mark on each term, and refuses a term it does not have or a term marked twice", () => {
    let { s, id } = withDictionary();
    s = marks(s, id, 1, [
      { row: "trip", mark: "keep" },
      { row: "trip plan", mark: "change" },
      { row: "member", mark: "drop" },
    ]);
    expect(S.currentFeedback(s, id, 1)?.rows).toEqual([
      { row: "trip", mark: "keep" },
      { row: "trip plan", mark: "change" },
      { row: "member", mark: "drop" },
    ]);
    expect(s.events.at(-1)?.message).toBe("Your feedback: Words v1 (3 terms marked)");
    expect(() => marks(s, id, 1, [{ row: "voyage", mark: "keep" }])).toThrow('Words v1 has no term "voyage".');
    expect(() => marks(s, id, 1, [{ row: "trip", mark: "keep" }, { row: "trip", mark: "drop" }])).toThrow('"trip" is marked twice; send one mark per row.');
    expect(() => marks(s, id, 1, [{ row: "trip", mark: "maybe" }])).toThrow("mark must be keep, change, drop");
  });

  it("cannot be approved while a term is marked Change or Drop; keeping every term, it can", () => {
    let { s, id } = withDictionary();
    s = marks(s, id, 1, [
      { row: "trip", mark: "keep" },
      { row: "member", mark: "drop" },
    ]);
    expect(() => approve(s, id, 1)).toThrow('Words v1 cannot be approved yet: you marked 1 term Change or Drop ("member"); the next version makes the change, or clear those marks to approve this one.');
    s = marks(s, id, 1, [{ row: "member", mark: "keep" }]);
    expect(B.currentBlueprint(approve(s, id, 1))?.items).toMatchObject([{ kind: "dictionary", artifactId: id, version: 1, status: "approved" }]);
  });

  it("is in force only once approved, at the version approved; with two dictionaries approved, the one approved last", () => {
    let { s, id } = withDictionary();
    expect(B.dictionaryInForce(s)).toBeUndefined(); // with the owner, not approved by them
    s = approve(s, id, 1);
    expect(B.dictionaryInForce(s)).toMatchObject({ artifact: { id, version: 1 }, entries: WORDS });
    // A new version is not in force until the owner approves it.
    const v2 = run<{ version: number }>(s, "addStudioArtifact", { artifactId: id, round: 1, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("e") }], devices: [], madeBy: DESIGNER, dictionary: [WORDS[0]] }, at(60));
    s = v2.state;
    expect(B.dictionaryInForce(s)?.artifact.version).toBe(1);
    s = run(s, "approveArtifact", { artifactId: id, version: 2 }, at(62)).state;
    expect(B.dictionaryInForce(s)).toMatchObject({ artifact: { id, version: 2 }, entries: [WORDS[0]] });
    // A second dictionary, approved later, is the one in force.
    const other = withDictionary(s, [{ term: "outing", meaning: "A day out." }], 70);
    s = approve(other.s, other.id, 1);
    expect(B.dictionaryInForce(s)?.artifact.id).toBe(other.id);
  });
});

/** A flow with two variants; each has its rules. */
function withFlowRules() {
  const r = openRound(fresh(), "flows", at(1));
  const rules = (variant: string, text: string) => ({ variant, path: `${variant}/rules.json`, rules: [{ id: "R1", text }, { id: "R2", text: "If the trip is full, then the app shall add the member to the waiting list." }], examples: [] });
  const args = {
    round: r.n,
    kind: "flow",
    title: "Saying you are in",
    variants: [
      { id: "a", label: "A", entry: "a/index.md" },
      { id: "b", label: "B", entry: "b/index.md" },
    ],
    files: [
      { path: "a/index.md", sha256: sha("1") },
      { path: "b/index.md", sha256: sha("2") },
    ],
    devices: [],
    madeBy: DESIGNER,
    rules: [rules("a", "The app shall show the cost each."), rules("b", "When a member says they are in, the app shall show the cost each.")],
  };
  const a = run<{ artifactId: string }>(r.state, "addStudioArtifact", args, at(2));
  return { s: peAgrees(a.state, a.result.artifactId, 1, ["a", "b"], at(3)), id: a.result.artifactId };
}

describe("a flow's rules in the studio", () => {
  it("records each variant's rules with their patterns", () => {
    const { s, id } = withFlowRules();
    expect(S.getArtifact(s, id, 1).rules?.map((r) => [r.variant, r.rules.map((x) => x.pattern)])).toEqual([
      ["a", ["always", "unwanted"]],
      ["b", ["event", "unwanted"]],
    ]);
    expect(S.markableRows(S.getArtifact(s, id, 1), "b")).toEqual(["R1", "R2"]);
  });

  it("takes a mark on a rule of a variant, and refuses one that does not name its variant or names no rule", () => {
    let { s, id } = withFlowRules();
    s = marks(s, id, 1, [{ row: "R2", variant: "b", mark: "change" }]);
    expect(S.currentFeedback(s, id, 1)?.rows).toEqual([{ row: "R2", variant: "b", mark: "change" }]);
    expect(() => marks(s, id, 1, [{ row: "R2", mark: "keep" }])).toThrow("A mark on a rule of Saying you are in names the variant the rule is on.");
    expect(() => marks(s, id, 1, [{ row: "R9", variant: "a", mark: "keep" }])).toThrow('Saying you are in v1 has no rule "R9" on A.');
    // A rule marked Change on B holds B back, not A.
    expect(() => run(s, "approveArtifact", { artifactId: id, version: 1, variant: "b" }, at(50))).toThrow('you marked 1 rule Change or Drop ("R2")');
    expect(B.currentBlueprint(run(s, "approveArtifact", { artifactId: id, version: 1, variant: "a" }, at(50)).state)?.items[0]).toMatchObject({ variant: "a", status: "approved" });
  });

  it("refuses rules on another kind, and marks on an artifact with no rows", () => {
    const r = openRound(fresh(), "experience", at(1));
    const screen = { round: r.n, kind: "screen", title: "Trip plan", variants: [{ id: "a", label: "A", entry: "a/index.html" }], files: [{ path: "a/index.html", sha256: sha("a") }], devices: ["desktop"], madeBy: DESIGNER };
    expect(() => run(r.state, "addStudioArtifact", { ...screen, rules: [{ variant: "a", path: "a/rules.json", rules: [{ id: "R1", text: "The app shall work." }] }] }, at(2))).toThrow("Only a flow carries rules.");
    const a = run<{ artifactId: string }>(r.state, "addStudioArtifact", screen, at(2));
    const s = peAgrees(a.state, a.result.artifactId, 1, ["a"], at(3));
    expect(() => marks(s, a.result.artifactId, 1, [{ row: "R1", mark: "keep" }])).toThrow("Trip plan v1 has no rows to mark: only a dictionary's terms and a flow's rules have marks of their own.");
  });
});
