// ORC-029 pass 4: the lead's studio brief, in its envelope while the project is in Vision. It says what the studio is
// and the lead's part (never the owner's), the order of focus aiming at completeness, the domains and devices, the
// repository (an "as it is today" first round when it has code), the rounds with their artifacts and PE review, and the
// owner's answers since the lead's last reply. It is bounded however large the studio grows.

import { describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { buildSeed } from "../src/domain/seed";
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
    expect(brief).toContain("1. experience: the key screens or commands, or the interface, or the topology, and how they behave;");
    expect(brief).toContain("2. data: the product's things and how they relate, in plain words with worked examples, and what crosses each boundary;");
    expect(brief).toContain("3. flows: every rule and edge case decided, as tables of cases and outcomes (empty, loading, error, offline, first run), because a case the design leaves open becomes special-casing in code.");
    expect(brief).toContain("Domains (the user's to choose; until they do, propose them as one question with options, from the vision and the repository; you never set them):\n- Not chosen yet by the owner.\nDevices (the user's scope): desktop, mobile.");
    expect(brief).toContain("Repository: no code yet (1 tracked file, documents only).\nNo round yet: open round 1 on the experience once you know enough to brief the designer.");
    expect(brief).toContain('- "designerRuns": at most 3 per reply.');
    expect(text).toContain('"studio": {\n    "closeRound": { "summary": "<what came of the open round>" },\n    "openRound": { "focus": "material | experience | data | flows"');
    expect(text).toContain('leave "studio", or any part of it, out when the studio needs nothing from you');
    // Not to a decisions run, and not once the factory has started.
    expect(envelope(fresh(), DOCS, "decisions")).not.toContain("## The studio");
    const building = envelope(startFactoryAsOwner(fresh(), at(1)), DOCS);
    expect(building).not.toContain("## The studio");
    expect(building).not.toContain('"studio": {');
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
    expect(brief).toContain("Domains (the user's to choose; until they do, propose them as one question with options, from the vision and the repository; you never set them):\n- A screen product (screen, terminal-demo, tui):");
    expect(brief).toContain(`- Round 1 (the experience), open: (no summary)\n  - ${plan.id} "Trip plan" v1 · screen · 2 variants: A Map first, B Timeline · desktop, mobile · PE agreed (pass 1), if: A: cache the map tiles`);
    expect(brief).toContain(`  - ${cli.id} "Packing list" v1 · screen · desktop, mobile · PE objects (pass 1): a: No packing data exists anywhere.`);
    expect(brief).toContain("  Your questions in this round: 1. Map or timeline first?");
    expect(brief).toMatch(/\n  Runs under way: studio-\d+ designer queued\.\n/);
    expect(brief).toContain("- Round 0 (what exists), closed: The trip list as the code has it. (1 artifacts)");
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
      s = peAgrees(a.state, a.id, 1, Array.from({ length: 6 }, (_, k) => `v${k}`), at(50 + i));
      ids.push(a.id);
    }
    for (const id of ids) s = feedback(s, id, 1, { mark: "change", pins: Array.from({ length: 50 }, () => ({ x: 0.1, y: 0.1, text: "pin text ".repeat(100) })), note: "a long note ".repeat(300) }, at(200));
    const brief = studioBriefSection(s, CODE);
    expect(brief).toContain("  - and 28 more, in the studio");
    expect(brief).toContain("- and 30 earlier answers, in the studio");
    // About 3,500 tokens at worst: 12 artifacts with 6 long variants each, 10 answers with long pins and notes.
    expect(brief.length).toBeLessThan(14_000);
  });

  it("parseLeadOutput passes the studio block through as found, for the domain to check", () => {
    const studio = { openRound: { focus: "experience", summary: "x" }, approve: true };
    expect(parseLeadOutput(`ok\n\`\`\`json\n${JSON.stringify({ reply: "ok", proposals: [], studio })}\n\`\`\``).studio).toEqual(studio);
    expect(parseLeadOutput(`ok\n\`\`\`json\n${JSON.stringify({ reply: "ok", proposals: [], studio: null })}\n\`\`\``).studio).toBeUndefined();
  });
});
