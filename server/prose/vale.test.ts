// The controlled-English style (vale/styles/STE80) through the real Vale binary, as the service calls it: each rule on
// a good and a bad sample, the rules' own samples (`vale test`), and the version the style is written for. Then the
// shell's other paths with stand-in binaries: no Vale ("not checked", nothing fails), a failure, a time-out, output that
// is not Vale's. The style's tests are skipped, with the reason, where Vale is not installed.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SENTENCE_MARK } from "./record";
import { VALE_CONFIG, VALE_PIN, findVale, parseValeJson, runVale, type ValeOutcome } from "./vale";

const BIN = findVale();
if (!BIN) console.warn("server/prose/vale.test.ts: Vale is not installed (brew install vale), so the STE80 style's tests are skipped.");

const words = (n: number) => `${Array.from({ length: n }, (_, i) => (i === 0 ? "One" : "word")).join(" ")}.`;
/** The rules a text breaks, in text order (the sentence marks are counted, not reported). */
const broken = (o: ValeOutcome) => {
  if (!o.checked) throw new Error(o.reason);
  return o.alerts.filter((a) => a.rule !== SENTENCE_MARK).map((a) => `${a.level} ${a.rule}`);
};

describe.skipIf(!BIN)("the STE80 style, through Vale (skipped where Vale is not installed)", () => {
  const check = (text: string) => runVale(text, { bin: BIN });

  it(`is Vale ${VALE_PIN}, the version the style is written for, and each rule passes its own samples (vale test --coverage)`, () => {
    const v = check("A short sentence.");
    expect(v).toMatchObject({ checked: true, vale: VALE_PIN });
    const r = spawnSync(BIN!, ["--no-global", `--config=${VALE_CONFIG}`, "test", "--coverage", "styles/STE80"], { cwd: dirname(VALE_CONFIG), encoding: "utf8" });
    expect(r.stdout + r.stderr).toMatch(/SUCCESS\s+6 files — \d+ passed, 0 failed/);
    expect(r.status).toBe(0);
  });

  it("errors: a sentence over 35 words; 35 words is not one, and inline code counts as one word", () => {
    expect(broken(check(words(36)))).toEqual(["error STE80.SentenceLength"]);
    expect(broken(check(words(35)))).toEqual(["warning STE80.SentenceLong"]);
    expect(broken(check(`${words(34).slice(0, -1)} \`two words\`.`))).toEqual(["warning STE80.SentenceLong"]);
  });

  it("warnings: a sentence of 26 to 35 words, one alert per sentence; 25 words and two short sentences pass", () => {
    expect(broken(check(words(26)))).toEqual(["warning STE80.SentenceLong"]);
    expect(broken(check(words(25)))).toEqual([]);
    expect(broken(check(`${words(20)} ${words(20)}`))).toEqual([]);
    expect(broken(check(words(40)))).toEqual(["error STE80.SentenceLength"]);
  });

  it("warnings: a paragraph of more than 6 sentences; 6 sentences, a list and abbreviations pass", () => {
    expect(broken(check("One. Two. Three. Four. Five. Six. Seven."))).toEqual(["warning STE80.ParagraphLength"]);
    expect(broken(check("One. Two. Three. Four. Five. Six."))).toEqual([]);
    expect(broken(check("Intro.\n\n- One.\n- Two.\n- Three.\n- Four.\n- Five.\n- Six.\n- Seven."))).toEqual([]);
    expect(broken(check("It reads names, e.g. Ada. It stops, i.e. Ada waits. It saves. It ends. It waits. It is ready."))).toEqual([]);
  });

  it("warnings: the passive voice, with a word between or not; the active voice, adjectives and 'is yours' pass", () => {
    expect(broken(check("The file was written by the lead. The reply is not blocked."))).toEqual(["warning STE80.Passive", "warning STE80.Passive"]);
    expect(check("No files were changed.")).toMatchObject({ alerts: expect.arrayContaining([expect.objectContaining({ rule: "STE80.Passive", match: "were changed", line: 1, col: 10 })]) });
    expect(broken(check("The lead wrote the file. The file is ready. The choice is yours."))).toEqual([]);
  });

  it("warnings: vague words; specific words, and words that only start the same ('property'), pass", () => {
    expect(broken(check("Update the relevant files as needed, etc."))).toEqual(["warning STE80.Vague", "warning STE80.Vague", "warning STE80.Vague"]);
    expect(broken(check("We fixed various bugs with the appropriate tool."))).toEqual(["warning STE80.Vague", "warning STE80.Vague"]);
    expect(broken(check("Update README.md and the schema. The property holds three values."))).toEqual([]);
  });

  it("the sentence marks: one per sentence and list item, with its text; code blocks are not prose", () => {
    const o = check("First sentence. Second one.\n\n- An item\n\n```json\n{ \"reply\": \"This is code, not prose.\" }\n```\n");
    expect(o.checked && o.alerts.filter((a) => a.rule === SENTENCE_MARK).map((a) => [a.line, a.col, a.match])).toEqual([
      [1, 1, "First sentence."],
      [1, 17, "Second one."],
      [3, 3, "An item"],
    ]);
  });

  it("reads the text on stdin with the repository's configuration, from any directory, with no global configuration", () => {
    // The service's working directory and environment never pick the style: a VALE_CONFIG_PATH pointing elsewhere is ignored.
    const prev = process.env.VALE_CONFIG_PATH;
    process.env.VALE_CONFIG_PATH = "/nonexistent/.vale.ini";
    try {
      expect(broken(check(words(36)))).toEqual(["error STE80.SentenceLength"]);
    } finally {
      if (prev === undefined) delete process.env.VALE_CONFIG_PATH;
      else process.env.VALE_CONFIG_PATH = prev;
    }
  });
});

describe("the shell around Vale", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-vale-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** A stand-in for the binary: answers --version, then runs `body` for a check. */
  const fake = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "vale version 9.8.7"; exit 0; fi\ncat > /dev/null\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  it("without Vale the text is not checked, with the reason, and nothing fails", () => {
    expect(runVale("Any text.", { bin: join(dir, "no-such-vale") })).toEqual({ checked: false, reason: "Vale was not found" });
  });

  it("finds the binary on PATH", () => {
    const bin = fake("vale", "echo '{}'");
    expect(findVale(dir)).toBe(bin);
  });

  it("records the binary's own version with the alerts", () => {
    const json = JSON.stringify({ "stdin.md": [{ Check: "STE80.Passive", Severity: "warning", Description: "The passive voice.", Line: 2, Span: [5, 15], Match: "was written" }] });
    expect(runVale("x", { bin: fake("ok", `echo '${json}'`) })).toEqual({ checked: true, vale: "9.8.7", alerts: [{ rule: "STE80.Passive", level: "warning", what: "The passive voice.", line: 2, col: 5, match: "was written" }] });
  });

  it("a failure, a time-out and output that is not Vale's are 'not checked', each with its reason", () => {
    expect(runVale("x", { bin: fake("fails", "echo 'E100 [loadStyle] Runtime error' >&2; exit 2") })).toEqual({ checked: false, reason: "Vale failed (exit 2): E100 [loadStyle] Runtime error" });
    expect(runVale("x", { bin: fake("slow", "sleep 5"), timeoutMs: 300 })).toEqual({ checked: false, reason: "Vale did not finish within 300 ms" });
    expect(runVale("x", { bin: fake("garbage", "echo 'not json'") })).toMatchObject({ checked: false, reason: expect.stringMatching(/^Vale's output was not readable: /) });
  });

  it("the parser refuses alerts without a rule name, a level, a line or a span, and sorts the rest by position", () => {
    const a = (o: object) => JSON.stringify({ "stdin.md": [{ Check: "STE80.Vague", Severity: "warning", Line: 1, Span: [1, 2], Match: "x", ...o }] });
    expect(() => parseValeJson(a({ Check: "../../etc" }))).toThrow(/without a rule name/);
    expect(() => parseValeJson(a({ Severity: "fatal" }))).toThrow(/no known level/);
    expect(() => parseValeJson(a({ Line: 0 }))).toThrow(/without a line/);
    expect(() => parseValeJson(a({ Span: "1" }))).toThrow(/without a span/);
    expect(() => parseValeJson("[]")).toThrow(/not an object/);
    expect(parseValeJson("{}")).toEqual([]);
    const two = JSON.stringify({ "stdin.md": [{ Check: "A.B", Severity: "error", Line: 3, Span: [1, 1] }, { Check: "A.C", Severity: "warning", Line: 1, Span: [9, 9] }] });
    expect(parseValeJson(two).map((x) => x.rule)).toEqual(["A.C", "A.B"]);
  });
});
