// ORC-029 pass 4: the lead's studio brief, in its envelope while the project is in Vision. It says what the studio is
// and the lead's part (never the owner's), the order of focus aiming at completeness, the domains and devices, the
// repository (an "as it is today" first round when it has code), the rounds with their artifacts and PE review, and the
// owner's answers since the lead's last reply. It is bounded however large the studio grows.

import { describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { buildSeed } from "../src/domain/seed";
import * as S from "../src/domain/studio/studio";
import { startFactoryAsOwner } from "../src/domain/testing/factory";
import { addScreen, feedback, openRound, peAgrees, pePass, run } from "../src/domain/testing/studio";
import type { State } from "../src/domain/types";
import { buildLeadEnvelope, parseLeadOutput, studioBriefSection } from "./envelope";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
const CODE = { files: 5, codeFiles: 3, code: ["src/index.html", "src/trips.css", "src/app.js"] };
const DOCS = { files: 1, codeFiles: 0, code: [] };
/** The lead's envelope for a reply to a message (or a planning or decisions run). */
function envelope(s: State, repo?: typeof CODE, trigger: "message" | "planning" | "decisions" = "message", sec = 100): string {
  const asked = trigger === "message" ? M.postMessage(s, "Let's look at the trip plan.", at(sec)) : s;
  const r = M.startLeadRun(asked, { provider: "claude", model: "claude-sample-large", trigger }, at(sec + 1));
  return buildLeadEnvelope(r.state, r.state.leadRuns.find((x) => x.id === r.runId)!, "read", undefined, undefined, repo);
}
const section = (text: string) => /\n## The studio\n[\s\S]*?(?=\n## Principles for this run)/.exec(text)?.[0] ?? "";

describe("the lead's studio brief", () => {
  it("goes to replies in Vision, with the lead's part, the order of focus, the domains, the devices and the studio's output contract", () => {
    const text = envelope(fresh(), DOCS);
    const brief = section(text);
    expect(brief).toContain("You never approve, overrule the PE, lock in or start the factory, and you never answer for the user: only the user's own actions do those.");
    // Which artifacts the PE reviews follows the kind's rules: a dictionary goes to the user directly.
    expect(brief).toContain("The PE reviews each design before the user sees it (not dictionaries, material or evidence);");
    expect(brief).toContain("1. experience: the key screens or commands, or the interface, or the topology, and how they behave;");
    // The data round asks for the project's dictionary (pass 4d): from the vision, and from the code's names.
    expect(brief).toContain(
      '2. data: the product\'s things and how they relate, in plain words with worked examples, and what crosses each boundary. Also ask the designer for the project\'s dictionary (kind "dictionary"): each word the product uses, with one meaning and the words it replaces. Base it on the vision and, for an existing repository, on the names in the code. When the user approves it, every agent gets its words;',
    );
    expect(brief).toContain("3. flows: every rule and edge case decided, as tables of cases and outcomes (empty, loading, error, offline, first run), because a case the design leaves open becomes special-casing in code.");
    // The three product domains in plain words (real trial finding 3: the lead asked about the subject, "Travel and group planning").
    expect(brief).toContain(
      [
        "Product domains: the kind of product this is, which decides what the designer makes. A domain is not the product's subject (travel, finance, \"a web app\"). There are three:",
        "- screen: people use it on a screen: in a browser, on a desktop or a phone, or in a terminal;",
        "- code: other programs use it: a library, an engine, a compiler;",
        "- infrastructure: systems that run other software: servers, queues, pipelines, deployment.",
        'The user chooses the domains in the app. You never set them, and you do not ask about them in "questions"; you may recommend domains in one sentence of your reply. The user\'s choice:',
        "- Not chosen yet by the owner.",
        "Devices (the user's scope): desktop, mobile.",
      ].join("\n"),
    );
    expect(brief).toContain('- "questions": at most 5, about this round\'s choices (a variant, an undecided case), each with why and up to 4 options;');
    expect(brief).toContain("Repository: no code yet (1 tracked file, documents only).\nNo round yet: open round 1 on the experience once you know enough to brief the designer.");
    expect(brief).toContain('- "designerRuns": at most 3 per reply.');
    expect(text).toContain('"studio": {\n    "closeRound": { "summary": "<what came of the open round>" },\n    "openRound": { "focus": "material | experience | data | flows"');
    expect(text).toContain('leave "studio", or any part of it, out when the studio needs nothing from you');
    // Not to a decisions run, nor to a planning run once the factory has started.
    expect(envelope(fresh(), DOCS, "decisions")).not.toContain("## The studio");
    expect(envelope(startFactoryAsOwner(fresh(), at(1)), DOCS, "planning")).not.toMatch(/## The studio|"studio": \{/);
  });

  it("goes to replies while the factory runs too (pass 5): the studio works on the draft, and the factory keeps the version in force", () => {
    const started = startFactoryAsOwner(fresh(), at(1));
    const text = envelope(started);
    const brief = section(text);
    expect(brief).toContain("You run Vision's studio.");
    expect(brief).toContain(
      'The factory is running. Vision stays open: when the user\'s messages are about the design, run the studio as before. What the user approves goes into the draft, not into force: the factory keeps building from the version in force until the user locks the draft in, and then you adjust the tasks it touches (a change order). Opening a round never stops or changes the factory. Leave "studio" out when the user\'s messages are about the work in the factory, not the design.',
    );
    expect(text).toContain('"studio": {\n    "closeRound"');
    // The vision may be drafted (it goes into the draft); the shaping brief and coverage are Vision's only.
    expect(text).toContain('"vision": {');
    expect(text).not.toMatch(/"coverage": \{|## Draft the vision with the user/);
    // A vision text in the draft is shown to the studio; the vision in force heads the brief, as the factory reads it.
    const edited = M.editVision(started, 1, "Weekend trips, offline on the trail.", "", "offline", at(2));
    const withDraft = envelope(edited);
    expect(withDraft).toContain("## Vision (r1)\nWeekend trips for a small group of friends.\n");
    expect(section(withDraft)).toContain("\nThe vision text in the draft (the user changed it; it goes into force at their Lock in, and the factory keeps the text above until then): Weekend trips, offline on the trail.\n");
    // The factory's lead (a planning run) reads the vision in force, and nothing of the draft.
    const plan = envelope(edited, undefined, "planning");
    expect(plan).toContain("## Vision (r1)\nWeekend trips for a small group of friends.\n");
    expect(plan).not.toContain("offline on the trail");
  });

  it("for a repository with code and no round yet, starts with round 0, as it is today", () => {
    const brief = section(envelope(fresh(), CODE));
    expect(brief).toContain("Repository: has code, 3 code files of 5 tracked (src/index.html, src/trips.css, src/app.js).");
    expect(brief).toContain('No round yet, and the repository has code. Unless the user said otherwise, start with round 0, "as it is today": openRound { "focus": "material", "summary": "As it is today: <what the code does now>" }');
    expect(brief).toContain("the service labels each artifact \"as is\" with the files it came from");
    expect(section(envelope(fresh()))).toContain("Repository: its file list was not read for this run; your working directory is a read-only checkout of it.");
    // Once a round exists, the start is not repeated.
    expect(section(envelope(openRound(fresh(), "experience", at(1)).state, CODE))).not.toContain("No round yet");
  });

  it("shows the open round's artifacts with PE review and provenance, earlier rounds, the runs under way and the lead's own questions", () => {
    let s = run(fresh(), "setDomains", { domains: ["screen"] }, at(1)).state;
    const zero = openRound(s, "material", at(2));
    const asIs = addScreen(zero.state, 0, at(3), { title: "Trip list (as is)", variants: [{ id: "a", label: "As it is today" }], provenance: { files: ["src/index.html", "src/trips.css"] } });
    s = peAgrees(asIs.state, asIs.id, 1, ["a"], at(4));
    const one = openRound(run(s, "closeRound", { round: 0, summary: "The trip list as the code has it." }, at(5)).state, "experience", at(6));
    const plan = addScreen(one.state, one.n, at(7), { variants: [{ id: "A", label: "Map first" }, { id: "B", label: "Timeline" }] });
    s = pePass(plan.state, plan.id, 1, [{ variant: "A", verdict: "feasible-if", change: "cache the map tiles" }, { variant: "B", verdict: "feasible" }], at(8));
    const cli = addScreen(s, one.n, at(9), { title: "Packing list", variants: [{ id: "a", label: "One list" }] });
    s = pePass(cli.state, cli.id, 1, [{ variant: "a", verdict: "not-feasible", reasons: "No packing data exists anywhere." }], at(10));
    s = run(s, "startStudioRun", { kind: "designer", round: one.n, brief: "One more take." }, at(11)).state;
    s.studio.rounds[1].lead = { message: "Two takes.", questions: [{ text: "Map or timeline first?" }] };
    const brief = section(envelope(s, CODE));
    expect(brief).toContain("The user's choice:\n- A screen product (screen, terminal-demo, tui):");
    const asked = s.studio.runs.at(-1)!.id;
    expect(brief).toContain(`- Round 1 (the experience), open: (no summary)\n  It cannot close yet: the designer's run ${asked} is queued.\n  - ${plan.id} "Trip plan" v1 · screen · 2 variants: A Map first, B Timeline · desktop, mobile · the designer revises for the PE (pass 1); asks for changes: A: cache the map tiles`);
    expect(brief).toContain(`  - ${cli.id} "Packing list" v1 · screen · desktop, mobile · the designer revises for the PE (pass 1); objects: a: No packing data exists anywhere.`);
    expect(brief).toContain("  Your questions in this round: 1. Map or timeline first?");
    expect(brief).toContain(`\n  Runs under way: ${asked} designer queued (asked by the service).\n`);
    expect(brief).toContain("- Round 0 (what exists), closed: The trip list as the code has it. (1 artifacts)");
  });

  it("says why PE review ended, with what the PE still says, and what the service did not do of the lead's last block", () => {
    const r = openRound(fresh(), "experience", at(1));
    const plan = addScreen(r.state, r.n, at(2), { variants: [{ id: "A", label: "Map first" }, { id: "B", label: "Timeline" }] });
    let s = plan.state;
    for (const v of [1, 2, 3]) {
      if (v > 1) s = addScreen(s, r.n, at(10 * v), { artifactId: plan.id, variants: [{ id: "A", label: "Map first" }, { id: "B", label: "Timeline" }] }).state;
      s = pePass(s, plan.id, v, [{ variant: "A", verdict: "feasible-if", change: `page the days (${v})` }, { variant: "B", verdict: "not-feasible", reasons: "Live prices need a paid API." }], at(10 * v + 1));
    }
    expect(section(envelope(s, DOCS))).toContain(
      `  - ${plan.id} "Trip plan" v3 · screen · 2 variants: A Map first, B Timeline · desktop, mobile · PE review ended after pass 3 (the PE made its 3 passes in the round), shown to the user; objects: B: Live prices need a paid API.; asks for changes: A: page the days (3)`,
    );
    // The lead's close of a busy round was refused: its next brief says so (review finding 1).
    const busy = addScreen(s, r.n, at(40), { title: "Packing list", variants: [{ id: "a", label: "One list" }] });
    const asked = M.startLeadRun(M.postMessage(busy.state, "Move on.", at(41)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(42));
    s = M.completeLeadRun(asked.state, asked.runId, { reply: "Moving on.", proposals: [], studio: { closeRound: true } } as never, at(43));
    const brief = section(envelope(s, DOCS));
    expect(brief).toContain(`What the service did not do of your last studio block:\n- closeRound: round 1 stays open while Packing list v1 waits for PE review; close it once the round's runs and PE review have ended\n`);
    expect(brief).toContain(`  It cannot close yet: Packing list v1 waits for PE review.\n`);
  });

  it("lists the PE's open cases of the open round, with the rule that the user decides them, never the designer; at most 10, the rest counted", () => {
    const r = openRound(fresh(), "experience", at(1));
    const plan = addScreen(r.state, r.n, at(2), { variants: [{ id: "A", label: "Map first" }, { id: "B", label: "Timeline" }] });
    let s = pePass(plan.state, plan.id, 1, [{ variant: "A", verdict: "feasible", openCases: [{ text: "Who pays when a friend drops out?", why: "Nobody set the rule." }] }, { variant: "B", verdict: "feasible-if", change: "Daily forecasts.", openCases: [{ text: "What happens on a rain day?" }] }], at(3));
    s = addScreen(s, r.n, at(4), { artifactId: plan.id, variants: [{ id: "A", label: "Map first" }, { id: "B", label: "Timeline" }] }).state;
    s = pePass(s, plan.id, 2, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "feasible", openCases: [{ text: "Can the organizer clear a balance?" }] }], at(5));
    const brief = section(envelope(s, DOCS));
    expect(brief).toContain(
      [
        `  - ${plan.id} "Trip plan" v2 · screen · 2 variants: A Map first, B Timeline · desktop, mobile · PE agreed (pass 2)`,
        "  Open cases the PE raised in this round (3): product questions for the user, never changes for the designer.",
        `  - ${plan.id} "Trip plan" A, PE pass 1: Who pays when a friend drops out? Why: Nobody set the rule.`,
        `  - ${plan.id} "Trip plan" B, PE pass 1: What happens on a rain day?`,
        `  - ${plan.id} "Trip plan" B, PE pass 2: Can the organizer clear a balance?`,
      ].join("\n"),
    );
    expect(brief).toContain('- The PE\'s open cases are product questions: a missing feature, an undecided edge case, a rule nobody set. The user decides them. Ask the user about them in "questions" (group related ones), or settle them with the user in the flows round. Never pass them to the designer as changes.');
    // Once the round closes they leave the brief with it; with none raised there is no list.
    expect(section(envelope(run(s, "closeRound", { round: r.n }, at(6)).state, DOCS))).not.toContain("Open cases the PE raised");
    expect(section(envelope(peAgrees(plan.state, plan.id, 1, ["A", "B"], at(3)), DOCS))).not.toContain("Open cases the PE raised");
    // Many: ten shown, the rest counted.
    const many = pePass(plan.state, plan.id, 1, ["A", "B"].map((variant) => ({ variant, verdict: "feasible", openCases: Array.from({ length: 5 }, (_, i) => ({ text: `${variant} question ${i} ${"long ".repeat(55)}` })) })), at(3));
    s = addScreen(many, r.n, at(4), { title: "Packing list", variants: [{ id: "a", label: "One list" }] }).state;
    s = pePass(s, S.latestArtifacts(s).at(-1)!.id, 1, [{ variant: "a", verdict: "feasible", openCases: [{ text: "Who brings the stove?" }] }], at(5));
    const crowded = section(envelope(s, DOCS));
    expect(crowded).toContain("  Open cases the PE raised in this round (11): product questions for the user, never changes for the designer.");
    expect(crowded).toContain("  - and 1 more, in the studio");
    expect(crowded).not.toContain("Who brings the stove?");
  });

  it("lists the user's marks, picks, pins and notes since the lead's last reply, not before it, and never the pins a revision carried", () => {
    const r = openRound(fresh(), "experience", at(1));
    const plan = addScreen(r.state, r.n, at(2), { variants: [{ id: "A", label: "Map first" }, { id: "B", label: "Timeline" }] });
    let s = peAgrees(plan.state, plan.id, 1, ["A", "B"], at(3));
    s = feedback(s, plan.id, 1, { mark: "keep", note: "An answer the lead already read." }, at(4));
    // The lead replied after that answer.
    const replied = M.startLeadRun(M.postMessage(s, "First answer.", at(5)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(6));
    s = M.completeLeadRun(replied.state, replied.runId, { reply: "Thanks.", proposals: [] }, at(7));
    s = feedback(s, plan.id, 1, { mark: "change", pickedVariant: "B", pins: [{ x: 0.5, y: 0.2, variant: "B", text: "Bigger dates.", selector: "h2.dates" }], note: "Closer to a calendar." }, at(8));
    const brief = section(envelope(s, DOCS));
    expect(brief).toContain(`The user's marks, picks, pins and notes since your last reply (their answers to your questions are in their messages below):\n- ${plan.id} "Trip plan" v1: change; picked B; 1 pin: "Bigger dates." on B at h2.dates; note: "Closer to a calendar."`);
    expect(brief).not.toContain("An answer the lead already read.");
    // A revision starts with the open pins carried forward: that is not a new answer.
    const v2 = addScreen(s, r.n, at(9), { artifactId: plan.id });
    expect(v2.state.studio.feedback.at(-1)).toMatchObject({ version: 2, carriedFrom: 1 });
    const after = section(envelope(v2.state, DOCS));
    expect(after).toContain(`- ${plan.id} "Trip plan" v1: change; picked B;`);
    expect(after).not.toContain(`- ${plan.id} "Trip plan" v2:`);
  });

  it("stays bounded however large the studio grows", () => {
    const r = openRound(fresh(), "experience", at(1));
    let s = r.state;
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const a = addScreen(s, r.n, at(2 + i), { title: `Screen ${i} ${"long title ".repeat(17)}`, variants: Array.from({ length: 6 }, (_, k) => ({ id: `v${k}`, label: "a long variant label ".repeat(5) })) });
      // The PE agrees, with the most open cases it may raise: 5 long ones on each variant.
      const openCases = Array.from({ length: 5 }, () => ({ text: "an open case ".repeat(23), why: "why it matters ".repeat(20) }));
      s = pePass(a.state, a.id, 1, Array.from({ length: 6 }, (_, k) => ({ variant: `v${k}`, verdict: "feasible", openCases })), at(50 + i));
      ids.push(a.id);
    }
    for (const id of ids) s = feedback(s, id, 1, { mark: "change", pins: Array.from({ length: 50 }, () => ({ x: 0.1, y: 0.1, text: "pin text ".repeat(100) })), note: "a long note ".repeat(300) }, at(200));
    const brief = studioBriefSection(s, CODE);
    expect(brief).toContain("  - and 28 more, in the studio");
    expect(brief).toContain("- and 30 earlier answers, in the studio");
    expect(brief).toContain("  - and 1190 more, in the studio");
    // About 4,600 tokens at worst: 12 artifacts with 6 long variants each, 10 long open cases (about 4,200 characters), 10 answers with long pins and notes.
    expect(brief.length).toBeLessThan(18_500);
  });

  it("parseLeadOutput passes the studio block through as found, for the domain to check", () => {
    const studio = { openRound: { focus: "experience", summary: "x" }, approve: true };
    expect(parseLeadOutput(`ok\n\`\`\`json\n${JSON.stringify({ reply: "ok", proposals: [], studio })}\n\`\`\``).studio).toEqual(studio);
    expect(parseLeadOutput(`ok\n\`\`\`json\n${JSON.stringify({ reply: "ok", proposals: [], studio: null })}\n\`\`\``).studio).toBeUndefined();
  });
});
