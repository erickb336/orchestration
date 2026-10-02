// The record of a check, pure (no Vale): which text of a lead reply is checked and where each part starts, the compact
// record kept on the lead run (counts by rule, errors first; the first alert of each rule as an example, at most 5; the
// sentences that pass), "not checked" with its reason, and which record the lead's next run is told about.

import { describe, expect, it } from "vitest";
import * as M from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import type { ProseCheck, State } from "../../src/domain/types";
import { MAX_EXAMPLES, MAX_SENTENCE, SENTENCE_MARK, checkLeadText, lastLeadProse, leadDoc, proseRecord, withLeadProse } from "./record";
import type { ValeAlert } from "./vale";

const AT = "2026-10-02T12:00:00.000Z";
const mark = (line: number, col: number, match: string): ValeAlert => ({ rule: SENTENCE_MARK, level: "suggestion", what: "Counts sentences; never shown.", line, col, match });
const alert = (rule: string, level: "error" | "warning", line: number, col: number, match: string, what = `${rule} broken.`): ValeAlert => ({ rule: `STE80.${rule}`, level, what, line, col, match });

describe("the text checked", () => {
  it("is the reply, then each question with its reason (the reply's, then the studio round's), one paragraph each", () => {
    const doc = leadDoc({
      reply: "First line.\r\nSecond line.",
      questions: [{ question: "Which layout?", why: "It sets the structure.", options: ["A", "B"] }, { question: 42 }, "not an object"],
      studio: { questions: [{ question: "Which domain?", why: "It sets the artifacts.\n\n\nOf the round." }] },
    })!;
    expect(doc.text).toBe("First line.\nSecond line.\n\nWhich layout?\nIt sets the structure.\n\nWhich domain?\nIt sets the artifacts.\nOf the round.");
    expect(doc.parts).toEqual([
      { name: "reply", firstLine: 1 },
      { name: "question 1", firstLine: 4 },
      { name: "question 2", firstLine: 7 },
    ]);
  });

  it("is nothing when the reply and the questions are empty; a reply alone, or questions alone, are checked", () => {
    expect(leadDoc({ reply: "  ", questions: [] })).toBeUndefined();
    expect(leadDoc({ reply: "", questions: [{ question: "Why?", why: "" }] })).toEqual({ text: "Why?", parts: [{ name: "question 1", firstLine: 1 }] });
    expect(checkLeadText({ reply: "" }, () => ({ checked: true, vale: "3.24.0", alerts: [] }), AT)).toBeUndefined();
  });
});

describe("the record", () => {
  const doc = leadDoc({ reply: "Nothing is built yet. Short.\n\nA very long sentence here.", questions: [{ question: "Which one?", why: "It was chosen by nobody." }] })!;

  it("counts the sentences and those with no alert, each broken rule (errors first, then by count), and one example of each", () => {
    const rec = proseRecord(
      doc,
      {
        checked: true,
        vale: "3.24.0",
        alerts: [
          mark(1, 1, "Nothing is built yet."),
          alert("Passive", "warning", 1, 9, "is built", "The passive voice."),
          mark(1, 23, "Short."),
          mark(3, 1, "A very long sentence here."),
          alert("SentenceLength", "error", 3, 1, "A very long sentence here.", "A sentence over 35 words."),
          mark(5, 1, "Which one?"),
          mark(6, 1, "It was chosen by nobody."),
          alert("Passive", "warning", 6, 4, "was chosen", "The passive voice."),
        ],
      },
      AT,
    );
    expect(rec).toEqual({
      status: "checked",
      at: AT,
      vale: "3.24.0",
      sentences: 5,
      passed: 2,
      rules: [
        { rule: "STE80.SentenceLength", level: "error", what: "A sentence over 35 words.", count: 1 },
        { rule: "STE80.Passive", level: "warning", what: "The passive voice.", count: 2 },
      ],
      examples: [
        // The whole sentence is the match: no separate match.
        { rule: "STE80.SentenceLength", part: "reply", line: 3, sentence: "A very long sentence here." },
        { rule: "STE80.Passive", part: "reply", line: 1, sentence: "Nothing is built yet.", match: "is built" },
        { rule: "STE80.Passive", part: "question 1", line: 2, sentence: "It was chosen by nobody.", match: "was chosen" },
      ],
    });
  });

  it("is capped: at most 5 examples, each sentence at most 200 characters on one line", () => {
    const long = `${"word ".repeat(80)}end.`;
    const alerts: ValeAlert[] = [mark(1, 1, long)];
    for (let i = 0; i < 9; i++) alerts.push(alert("Vague", "warning", 1, 2 + i, "various"));
    const rec = proseRecord({ text: long, parts: [{ name: "reply", firstLine: 1 }] }, { checked: true, vale: "3.24.0", alerts }, AT);
    if (rec.status !== "checked") throw new Error("not checked");
    expect(rec.rules).toEqual([{ rule: "STE80.Vague", level: "warning", what: "Vague broken.", count: 9 }]);
    expect(rec.examples).toHaveLength(MAX_EXAMPLES);
    expect(rec.examples[0].sentence).toHaveLength(MAX_SENTENCE);
    expect(rec.examples[0].sentence.endsWith("…")).toBe(true);
    expect([rec.sentences, rec.passed]).toEqual([1, 0]);
  });

  it("a text that breaks nothing records its sentences and no rules", () => {
    expect(proseRecord(doc, { checked: true, vale: "3.24.0", alerts: [mark(1, 1, "Fine."), mark(1, 7, "Also fine.")] }, AT)).toEqual({ status: "checked", at: AT, vale: "3.24.0", sentences: 2, passed: 2, rules: [], examples: [] });
  });

  it("without Vale: 'not checked', with the reason", () => {
    expect(proseRecord(doc, { checked: false, reason: "Vale was not found" }, AT)).toEqual({ status: "not-checked", at: AT, reason: "Vale was not found" });
  });
});

describe("the record on the lead run", () => {
  const T0 = Date.parse("2026-10-02T12:00:00Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const broke: ProseCheck = { status: "checked", at: AT, vale: "3.24.0", sentences: 2, passed: 1, rules: [{ rule: "STE80.Passive", level: "warning", what: "The passive voice.", count: 1 }], examples: [] };
  const clean: ProseCheck = { status: "checked", at: AT, vale: "3.24.0", sentences: 2, passed: 2, rules: [], examples: [] };
  /** A message, a lead run started for it; completed with a reply when `reply` is given. */
  function run(s: State, sec: number, reply?: string) {
    const r = M.startLeadRun(M.postMessage(s, `Message ${sec}`, at(sec)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(sec + 1));
    return { state: reply === undefined ? r.state : M.completeLeadRun(r.state, r.runId, { reply, proposals: [] }, at(sec + 2)), id: r.runId };
  }
  const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));

  it("goes on a completed run only, not on the message the owner reads", () => {
    const done = run(fresh(), 10, "Done.");
    const s = withLeadProse(done.state, done.id, broke);
    expect(s.leadRuns.find((r) => r.id === done.id)!.prose).toEqual(broke);
    expect(JSON.stringify(s.conversation)).not.toContain("STE80");
    const active = run(fresh(), 10);
    expect(withLeadProse(active.state, active.id, broke)).toBe(active.state);
  });

  it("the next run is told about the newest completed run before it that has a record", () => {
    const a = run(fresh(), 10, "First.");
    let s = withLeadProse(a.state, a.id, broke);
    const b = run(s, 20, "Second, with no record.");
    s = b.state;
    const c = run(s, 30);
    s = c.state;
    // b has no record (no checker, or no text): the newest record before c is a's.
    expect(lastLeadProse(s, c.id)).toEqual(broke);
    s = withLeadProse(M.completeLeadRun(s, c.id, { reply: "Third.", proposals: [] }, at(33)), c.id, clean);
    const d = run(s, 40);
    expect(lastLeadProse(d.state, d.id)).toEqual(clean);
    // The first run has nothing before it.
    expect(lastLeadProse(d.state, a.id)).toBeUndefined();
  });
});
