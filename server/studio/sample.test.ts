// The fake runtime's PE and designer in the studio loop (ORC-029 pass 4): the simulated PE asks for one change on an
// artifact's first version, and the simulated designer revises the variants its brief names, so the demo and the
// tests show the loop without an agent. Everything they write says it is simulated.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAMPLE_FILES, SAMPLE_MANIFEST, TERMINAL_SAMPLE_FILES, fakePeAnswer, reviseSample, terminalSampleManifest, variantsToRevise } from "./sample";
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
/** The verdicts the simulated PE gives a version with these variants. */
function verdicts(version: number, variants: string[]) {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ artifactId: "sa-1", version, variants: variants.map((id) => ({ id, label: id, entry: `${id}/index.html` })) }));
  const answer = fakePeAnswer(dir);
  if (!answer.ok) throw new Error(answer.error);
  const block = /```json\n([\s\S]*?)\n```/.exec(answer.text)![1];
  return (JSON.parse(block) as { verdicts: { variant?: string; verdict: string; reasons: string; change?: string }[] }).verdicts;
}

describe("the simulated PE", () => {
  it("asks for a change to the second variant of an artifact's first version, and agrees with every later version; every reason says it is simulated", () => {
    const first = verdicts(1, ["a", "b"]);
    expect(first.map((v) => [v.variant, v.verdict])).toEqual([
      ["a", "feasible"],
      ["b", "feasible-if"],
    ]);
    expect(first[1].change).toBe("Simulated: a stand-in change, which the fake designer marks on this variant in a revision.");
    expect(verdicts(2, ["a", "b"]).map((v) => v.verdict)).toEqual(["feasible", "feasible"]);
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
