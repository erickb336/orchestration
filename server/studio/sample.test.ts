// The fake runtime's PE and designer in the studio loop (ORC-029 pass 4): the simulated PE asks for one change on an
// artifact's first version and raises one open case, and the simulated designer revises the variants its brief names,
// so the demo and the tests show the loop without an agent. Everything they write says it is simulated.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGNER_KINDS } from "../../src/domain/studio/types";
import { writeDocumentSample } from "../runtimes/fake";
import { readStaged } from "./artifacts";
import {
  DICTIONARY_SAMPLE,
  FLOW_RULES_SAMPLE,
  SAMPLE_FILES,
  SAMPLE_MANIFEST,
  TERMINAL_SAMPLE_FILES,
  addDictionarySample,
  addFlowRules,
  askedKinds,
  asksForRules,
  fakePeAnswer,
  reviseSample,
  terminalSampleManifest,
  variantsToRevise,
} from "./sample";
import { validateAnsFrame } from "./terminal";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-sample-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(files: Readonly<Record<string, string>>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
}
/** The verdicts the simulated PE gives a version with these variants, given its envelope. */
function verdicts(version: number, variants: string[], prompt = "") {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ artifactId: "sa-1", version, variants: variants.map((id) => ({ id, label: id, entry: `${id}/index.html` })) }));
  const answer = fakePeAnswer(dir, prompt);
  if (!answer.ok) throw new Error(answer.error);
  const block = /```json\n([\s\S]*?)\n```/.exec(answer.text)![1];
  return (JSON.parse(block) as { verdicts: { variant?: string; verdict: string; reasons: string; change?: string; earlier?: unknown; openCases?: unknown }[] }).verdicts;
}

describe("the simulated PE", () => {
  it("asks for a change to the second variant of an artifact's first version, with one open case, and agrees with every later version, each earlier ask met; every reason says it is simulated", () => {
    const first = verdicts(1, ["a", "b"]);
    expect(first.map((v) => [v.variant, v.verdict])).toEqual([
      ["a", "feasible"],
      ["b", "feasible-if"],
    ]);
    expect(first[1].change).toBe("Simulated: a stand-in change, which the fake designer marks on this variant in a revision.");
    expect(first[1].openCases).toEqual([{ text: "Simulated: when a friend drops out after the cabin is booked, who pays their share?", why: "Simulated: a stand-in question, so the demo shows an open case going to the owner through the lead." }]);
    expect(first[0].openCases).toBeUndefined();
    expect(verdicts(2, ["a", "b"]).map((v) => v.verdict)).toEqual(["feasible", "feasible"]);
    // On a later pass it reads its earlier asks from the envelope, as pe.ts lists them, and finds each met.
    const envelope = "## Your earlier asks\n\n- `pev-7` on `b` (B · Day by day), pass 1, feasible if changed. The change: Simulated.\n- `pev-9` on the whole artifact, pass 1, not feasible. Your reasons: Simulated.\n";
    expect(verdicts(2, ["a", "b"], envelope).map((v) => [v.variant, v.earlier])).toEqual([
      ["a", [{ ask: "pev-9", met: true }]],
      ["b", [{ ask: "pev-7", met: true }, { ask: "pev-9", met: true }]],
    ]);
    // A single take has nothing to choose between: it agrees.
    expect(verdicts(1, ["a"]).map((v) => v.verdict)).toEqual(["feasible"]);
    for (const v of [...first, ...verdicts(2, ["a", "b"])]) expect(v.reasons).toMatch(/^Simulated: the fake runtime's PE, not an agent\./);
  });
});

describe("the simulated designer's revision", () => {
  it("reads the variants to revise from the brief's Revise lines", () => {
    expect(variantsToRevise("Revise only these.\n\n- Revise `b` (B · Day by day): feasible if changed.\n- Keep `a` as it is.\n- Revise `c-2` (C): not feasible.")).toEqual(["b", "c-2"]);
    expect(variantsToRevise("Make it better.")).toEqual([]);
  });

  it("marks the files of the variants it was asked to revise, leaves the others as they are, and hands in that one artifact", () => {
    write(SAMPLE_FILES);
    const text = reviseSample(dir, { terminal: false, variants: ["b"] });
    expect(text).toBe("Revised B · Day by day of Trip plan (simulated sample) in answer to the PE; the other variants are as they were (simulated revision).");
    expect(readFileSync(join(dir, "b/index.html"), "utf8")).toContain('<body>\n<p class="sim">Simulated revision: the fake runtime\'s designer marked this variant revised in answer to the PE; nothing was redesigned.</p>');
    for (const p of ["a/index.html", "a/style.css", "b/style.css"]) expect(readFileSync(join(dir, p), "utf8")).toBe(SAMPLE_FILES[p]);
    expect(JSON.parse(readFileSync(join(dir, "studio.json"), "utf8"))).toEqual({ artifacts: [SAMPLE_MANIFEST.artifacts[0]] });
  });

  it("revises a TUI's frame within its terminal size", () => {
    write(TERMINAL_SAMPLE_FILES);
    rmSync(join(dir, "cli"), { recursive: true });
    reviseSample(dir, { terminal: true, variants: ["b"] });
    const frame = readFileSync(join(dir, "tui/b/tui.ans"), "utf8");
    expect(frame).toContain("(simulated revision)");
    expect(validateAnsFrame(frame, { cols: 80, rows: 24 })).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, "tui/a/tui.ans"), "utf8")).toBe(TERMINAL_SAMPLE_FILES["tui/a/tui.ans"]);
    expect(JSON.parse(readFileSync(join(dir, "studio.json"), "utf8"))).toEqual({ artifacts: [terminalSampleManifest(true).artifacts[1]] });
  });

  it("revises only what it made", () => {
    write({ "page/index.html": "<h1>Someone else's</h1>" });
    expect(() => reviseSample(dir, { terminal: false, variants: [] })).toThrow("its working directory does not hold one of its own samples, and it revises only what it made");
  });
});

describe("the simulated designer's dictionary and rules (pass 4d)", () => {
  it("hands in the project's dictionary beside a contract, and it passes the import's checks", () => {
    writeDocumentSample(dir, "contract");
    addDictionarySample(dir);
    const staged = readStaged(dir, DESIGNER_KINDS);
    expect(staged.map((a) => [a.kind, a.title])).toEqual([
      ["contract", "Trip data (simulated sample)"],
      ["dictionary", "Weekend Trips words (simulated sample)"],
    ]);
    expect(staged[1].dictionary).toEqual(DICTIONARY_SAMPLE);
  });

  it("gives its flow rules.json beside the entry; each of EARS's five patterns appears, and the examples pass", () => {
    writeDocumentSample(dir, "flow");
    addFlowRules(dir);
    const [flow] = readStaged(dir, DESIGNER_KINDS);
    expect(flow.files.map((f) => f.path)).toEqual(["doc/index.md", "doc/diagram.mmd", "doc/rules.json"]);
    expect(flow.rules).toHaveLength(1);
    expect(flow.rules![0]).toMatchObject({ variant: "a", path: "doc/rules.json", examples: FLOW_RULES_SAMPLE.examples });
    expect(flow.rules![0].rules.map((r) => `${r.id} ${r.pattern}`)).toEqual(["R1 event", "R2 state", "R3 unwanted", "R4 unwanted", "R5 unwanted", "R6 optional", "R7 always"]);
  });

  it("reads the kinds the brief asks for, and whether its envelope asks for rules", () => {
    expect(askedKinds("Describe the data.\n\nThe lead asks for: contract, dictionary; one take; documents, with no devices.")).toEqual(["contract", "dictionary"]);
    expect(askedKinds("Make the trip plan.")).toEqual([]);
    expect(asksForRules("…\n## The flows round's rules\n\n- Give each flow…")).toBe(true);
    expect(asksForRules("## What to hand in")).toBe(false);
  });
});
