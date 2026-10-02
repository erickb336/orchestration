// The PE's answer and envelope (ORC-029 pass 4, convergence after the second real trial): the answer keeps changes
// apart from open cases, and on a later pass checks each earlier ask; the envelope says so; verdicts stored before
// these fields load and read as they did, with no migration.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import * as R from "../../src/domain/studio/runs";
import * as S from "../../src/domain/studio/studio";
import { addScreen, openRound, pePass } from "../../src/domain/testing/studio";
import type { State } from "../../src/domain/types";
import { Store } from "../store";
import { peEnvelope, readPeAnswer } from "./pe";

const T0 = Date.parse("2026-10-02T20:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
const block = (verdicts: unknown) => `I read it.\n\n\`\`\`json\n${JSON.stringify({ verdicts })}\n\`\`\`\n`;
const AB = [
  { id: "a", label: "A · Single page" },
  { id: "b", label: "B · Tabs" },
];

/** The PE's envelope for the newest version of the round's one artifact: a PE run is asked for it, as the service does. */
function envelopeFor(s: State, id: string): { text: string; state: State } {
  const asked = R.askForPeReviews(s, at(50));
  const run = asked.studio.runs.filter((r) => r.kind === "pe" && r.artifactId === id).at(-1)!;
  return { text: peEnvelope(asked, run, { folder: "/tmp/v" }), state: asked };
}

describe("the PE's answer", () => {
  it("reads open cases, the checks of earlier asks and fromRevision; null is left out", () => {
    const read = readPeAnswer(
      block([
        { variant: "a", verdict: "feasible", reasons: "Fine.", openCases: [{ text: "Who pays for a dropout?", why: "No rule." }, { text: "Rain day?", why: null }], earlier: [{ ask: "pev-3", met: true }] },
        { variant: "b", verdict: "feasible-if", reasons: "Tiles.", change: "Cache the tiles.", fromRevision: true, earlier: null, openCases: null },
      ]),
    );
    expect(read).toEqual([
      { variant: "a", verdict: "feasible", reasons: "Fine.", earlier: [{ ask: "pev-3", met: true }], openCases: [{ text: "Who pays for a dropout?", why: "No rule." }, { text: "Rain day?" }] },
      { variant: "b", verdict: "feasible-if", reasons: "Tiles.", change: "Cache the tiles.", fromRevision: true },
    ]);
  });

  it("refuses the new fields in the wrong shape, saying which verdict", () => {
    const one = (more: object) => () => readPeAnswer(block([{ variant: "a", verdict: "feasible", reasons: "Fine.", ...more }]));
    expect(one({ openCases: "Who pays?" })).toThrow('verdict 1: "openCases" is not a list of { "text": "…", "why": "…" }');
    expect(one({ openCases: [{ why: "No rule." }] })).toThrow('verdict 1: "openCases" is not a list');
    expect(one({ earlier: [{ ask: "pev-3", met: "yes" }] })).toThrow('verdict 1: "earlier" is not a list of { "ask": "<id>", "met": true or false }');
    expect(one({ fromRevision: "true" })).toThrow('verdict 1: "fromRevision" is not true or false');
  });
});

describe("the PE's envelope", () => {
  it("on a first pass: a change only for feasibility, scale, longevity or budget; features, edge cases and rules are open cases for the owner", () => {
    const r = openRound(fresh(), "experience", at(1));
    const a = addScreen(r.state, r.n, at(2), { variants: AB });
    const { text } = envelopeFor(a.state, a.id);
    expect(text).toContain("- `change`: with feasible-if, the change the designer must make because feasibility, scale, longevity or budget needs it. Say what to change and why, in one or two sentences: the designer sees your change, not your reasons.");
    expect(text).toContain("- A change is only what feasibility, scale, longevity or budget needs. A missing feature, an undecided edge case or a rule nobody set is not a change: it is an open case. Do not ask the designer to invent a product rule. The owner decides those.");
    expect(text).toContain("- `openCases` (optional, at most 5 for each verdict): the product questions you noticed.");
    expect(text).toContain("- When all you found are open cases, the verdict is feasible.");
    expect(text).toContain('    "openCases": [{ "text": "<a question for the owner>", "why": "<why it matters>" }] },');
    expect(text).not.toContain("## Your earlier asks");
  });

  it("on a later pass: each earlier ask with its id (one on the whole artifact is on every variant), the convergence rules, and the last pass said so", () => {
    const r = openRound(fresh(), "experience", at(1));
    const a = addScreen(r.state, r.n, at(2), { variants: AB });
    let s = pePass(a.state, a.id, 1, [{ verdict: "not-feasible", reasons: "Live prices need a paid API.", change: "A free source of prices." }], at(3));
    const whole = s.studio.verdicts[0].id;
    s = addScreen(s, r.n, at(4), { artifactId: a.id, variants: AB }).state;
    const second = envelopeFor(s, a.id);
    expect(second.text).toContain(
      [
        "## Your earlier asks",
        "",
        "This is pass 2 of 3 in round 1. The designer revised the artifact since your pass 1. Check these asks first. For each one, say whether this version meets it:",
        `- \`${whole}\` on the whole artifact, pass 1, not feasible. Your reasons: Live prices need a paid API. What would change your verdict: A free source of prices.`,
        "",
        '- In each verdict, "earlier" lists every ask above on its variant, each once, with "met": true or false. An ask on the whole artifact is on every variant.',
        "- An ask the revision met is done. Do not ask for more of it.",
        '- A change on this pass is for an ask that is not met, or for a risk that this revision itself created. For the second, set "fromRevision": true, and say in the change what the revision added that causes the risk.',
        "- Anything else you notice now (a feature, an edge case, a rule nobody set) is an open case, not a change.",
        "- When every ask is met and the revision created no new risk, the verdict is feasible.",
        "",
      ].join("\n"),
    );
    expect(second.text).not.toContain("last pass");
    expect(second.text).toContain(`  { "variant": "a", "earlier": [{ "ask": "${whole}", "met": true }], "verdict": "feasible"`);
    expect(second.text).toContain(`  { "variant": "b", "earlier": [{ "ask": "${whole}", "met": true }], "verdict": "feasible"`);
    // Pass 2 meets the ask on A only; B still needs it. Pass 3 lists both asks on B, none on A, and says it is the last.
    s = pePass(second.state, a.id, 2, [{ variant: "a", verdict: "feasible" }, { variant: "b", verdict: "not-feasible", reasons: "B still prices live.", change: "Prices by hand." }], at(5));
    const onB = s.studio.verdicts.at(-1)!.id;
    s = addScreen(s, r.n, at(6), { artifactId: a.id, variants: AB }).state;
    const third = envelopeFor(s, a.id).text;
    expect(third).toContain(`- \`${onB}\` on \`b\` (B · Tabs), pass 2, not feasible. Your reasons: B still prices live. What would change your verdict: Prices by hand.\n`);
    expect(third).toContain(`  { "variant": "b", "earlier": [{ "ask": "${whole}", "met": true }, { "ask": "${onB}", "met": true }], "verdict": "feasible"`);
    expect(third).toContain("On your pass 2 you found `a` (A · Single page) feasible. Judge it again too.");
    expect(third).toContain("This is the round's last pass: what you still find not feasible goes to the owner as an objection");
  });

  it("on a later pass with no earlier ask (the PE agreed, and the designer revised in the round for the lead): any change must be a risk the revision created", () => {
    const r = openRound(fresh(), "experience", at(1));
    const a = addScreen(r.state, r.n, at(2), { variants: AB });
    let s = pePass(a.state, a.id, 1, [{ variant: "a", verdict: "feasible" }, { variant: "b", verdict: "feasible" }], at(3));
    s = addScreen(s, r.n, at(4), { artifactId: a.id, variants: AB }).state;
    const text = envelopeFor(s, a.id).text;
    expect(text).toContain("This is pass 2 of 3 in round 1. The designer revised the artifact since your pass 1. You asked for no change on it earlier in this round.\n");
    expect(text).not.toContain('"earlier"');
    expect(text).toContain('- A change on this pass is for an ask that is not met, or for a risk that this revision itself created. For the second, set "fromRevision": true');
  });
});

describe("verdicts stored before open cases and ask checks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orc029-pe-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("load with no migration: each verdict is as it was stored, and PE review reads the same", () => {
    const path = join(dir, "db.sqlite");
    // A studio as it was stored before this change: round 1 open, a pass on v1 asking for a change on B, none of the new fields.
    const r = openRound(fresh(), "experience", at(1));
    const a = addScreen(r.state, r.n, at(2), { variants: AB });
    const s = structuredClone(a.state);
    const old = [
      { id: "pev-9001", artifactId: a.id, version: 1, variant: "a", pass: 1, verdict: "feasible", reasons: "Fine.", at: at(3) },
      { id: "pev-9002", artifactId: a.id, version: 1, variant: "b", pass: 1, verdict: "feasible-if", reasons: "Long trips.", change: "Page the days.", at: at(3), by: { provider: "codex", model: "codex-sample-large", runId: "studio-1" } },
    ];
    (s.studio.verdicts as unknown[]).push(...structuredClone(old));
    const first = new Store(path);
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE state SET json = ? WHERE id = 1").run(JSON.stringify(s));
    raw.close();
    const store = new Store(path);
    try {
      const loaded = store.read().state;
      expect(loaded.studio.verdicts).toEqual(old);
      const v1 = S.getArtifact(loaded, a.id, 1);
      expect(S.peReview(loaded, v1)).toMatchObject({ status: "revising", pass: 1, asks: [{ id: "pev-9002", change: "Page the days." }], objections: [] });
      expect(S.openCasesOf(loaded, v1)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
