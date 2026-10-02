// The loop around the lead's text, through the scheduler: when a lead run completes, its reply and questions are
// checked and the result is recorded on the run (never on the message, never blocking the reply); the lead's next
// envelope lists the rules its last reply broke, with at most 3 examples, and says nothing when it broke none or was
// not checked. One test runs the real Vale (skipped where it is not installed); the others use a stand-in checker.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as M from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import { startFactoryArgs } from "../../src/domain/testing/factory";
import type { LeadRun, ProseCheck, State } from "../../src/domain/types";
import { PROSE_FEEDBACK_HEADER, buildLeadEnvelope, proseFeedbackSection } from "../envelope";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { ScriptedAdapter } from "../testing/scripted";
import { SENTENCE_MARK, withLeadProse } from "./record";
import { findVale, valeChecker, type ProseChecker, type ValeAlert } from "./vale";

vi.setConfig({ testTimeout: 20_000 });

const PASSIVE = "No files were changed by the lead.";
/** A stand-in for Vale: every line is one sentence; "were changed" is a passive. */
const standIn: ProseChecker = (text) => {
  const alerts: ValeAlert[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    alerts.push({ rule: SENTENCE_MARK, level: "suggestion", what: "", line: i + 1, col: 1, match: line });
    const at = line.indexOf("were changed");
    if (at >= 0) alerts.push({ rule: "STE80.Passive", level: "warning", what: "The passive voice.", line: i + 1, col: at + 1, match: "were changed" });
  });
  return { checked: true, vale: "3.24.0", alerts };
};
const answer = (reply: string, questions: unknown[] = []) => JSON.stringify({ reply, proposals: [], questions });

describe("the lead's text, through the scheduler", () => {
  let dir: string;
  let store: Store;
  let claude: ScriptedAdapter;
  let scheduler: Scheduler | undefined;
  let now = Date.parse("2026-10-02T12:00:00Z");
  let key = 0;
  const iso = () => new Date(now).toISOString();
  const tick = () => scheduler!.tick((now += 1000));
  const st = (): State => store.read().state;
  const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
  async function start(prose?: ProseChecker) {
    scheduler = new Scheduler(store, { claude, codex: new ScriptedAdapter("codex") }, { leaseMs: 60_000, ackTimeoutMs: 10_000, ...(prose ? { prose } : {}) });
    await scheduler.refreshHealth();
  }
  /** The owner writes; the lead's run starts; it answers with `finalText`. Returns the run and the prompt it was given. */
  function exchange(message: string, finalText: string): { run: LeadRun; prompt: string } {
    cmd("postMessage", { text: message });
    tick();
    const r = M.activeLeadRun(st())!;
    const prompt = claude.runs.get(r.id)!.prompt;
    claude.emit({ type: "completed", attemptId: r.id, finalText });
    tick();
    return { run: st().leadRuns.find((x) => x.id === r.id)!, prompt };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-prose-lead-"));
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    store = new Store(join(dir, "db.sqlite"));
    claude = new ScriptedAdapter("claude");
    cmd("initProject", { name: "Greeter", repoPath: repo, vision: "A tiny greeting library.", focus: "Greeting" });
    cmd("startFactory", startFactoryArgs(store.read().state));
    cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
  });
  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the check on the run; the next envelope lists what the last reply broke; a clean reply ends the feedback", async () => {
    await start(standIn);
    const first = exchange("What changed?", answer(`I read the repository.\n${PASSIVE}`, [{ question: "Which file next?", why: "It sets the order." }]));
    expect(first.prompt).not.toContain(PROSE_FEEDBACK_HEADER);
    expect(first.prompt).toContain("### Write controlled English");
    expect(first.run.prose).toEqual({
      status: "checked",
      at: expect.any(String),
      vale: "3.24.0",
      sentences: 4,
      passed: 3,
      rules: [{ rule: "STE80.Passive", level: "warning", what: "The passive voice.", count: 1 }],
      examples: [{ rule: "STE80.Passive", part: "reply", line: 2, sentence: PASSIVE, match: "were changed" }],
    });
    // The reply went to the owner as written, with no score on it.
    const msg = st().conversation.find((m) => m.leadRunId === first.run.id)!;
    expect(msg.text).toBe(`I read the repository.\n${PASSIVE}`);
    expect(Object.keys(msg)).not.toContain("prose");

    const second = exchange("And now?", answer("I changed nothing."));
    const block = `${PROSE_FEEDBACK_HEADER}
Your last reply broke these rules of "Write controlled English" (3 of 4 sentences passed). Apply the principle in this reply. Do not mention this check to the user.
- The passive voice: 1
Examples from your last reply:
- The passive voice, reply line 2: "${PASSIVE}" ("were changed")
`;
    expect(second.prompt).toContain(block);
    expect(second.prompt.split(PROSE_FEEDBACK_HEADER)).toHaveLength(2);
    // Near the output instructions: just before them, after the steering rules.
    expect(second.prompt.indexOf(PROSE_FEEDBACK_HEADER)).toBeLessThan(second.prompt.indexOf("## Required final output"));
    expect(second.prompt.indexOf("## Steering rules")).toBeLessThan(second.prompt.indexOf(PROSE_FEEDBACK_HEADER));
    expect(second.run.prose).toMatchObject({ status: "checked", sentences: 1, passed: 1, rules: [] });

    const third = exchange("Thanks.", answer("Good."));
    expect(third.prompt).not.toContain(PROSE_FEEDBACK_HEADER);
  });

  it("without Vale the run records 'not checked' with the reason, the reply applies as usual, and no feedback follows", async () => {
    await start(valeChecker({ bin: join(dir, "no-vale-here") }));
    const first = exchange("What changed?", answer(PASSIVE));
    expect(first.run.prose).toEqual({ status: "not-checked", at: expect.any(String), reason: "Vale was not found" });
    expect(first.run.outcome).toBe("completed");
    expect(st().conversation.find((m) => m.leadRunId === first.run.id)!.text).toBe(PASSIVE);
    expect(exchange("And now?", answer("Fine.")).prompt).not.toContain(PROSE_FEEDBACK_HEADER);
  });

  it("a scheduler with no checker records nothing", async () => {
    await start();
    expect(exchange("What changed?", answer(PASSIVE)).run.prose).toBeUndefined();
  });

  it.skipIf(!findVale())("with the real Vale: a 40-word sentence is an error, and the next envelope names it (skipped where Vale is not installed)", async () => {
    await start(valeChecker());
    const long = `The lead read the repository and the vision documents and the conversation and found ${"one more thing and ".repeat(7)}nothing else to report today.`;
    const first = exchange("What changed?", answer(`${long}\n\nThe lead wrote the file.`));
    expect(first.run.prose).toMatchObject({ status: "checked", vale: "3.24.0", sentences: 2, passed: 1, rules: [{ rule: "STE80.SentenceLength", level: "error", what: "A sentence over 35 words.", count: 1 }] });
    const second = exchange("And now?", answer("Short and active."));
    expect(second.prompt).toContain("- A sentence over 35 words (error): 1\n");
    expect(second.run.prose).toMatchObject({ status: "checked", sentences: 1, passed: 1, rules: [] });
  });
});

describe("the feedback block", () => {
  const T0 = Date.parse("2026-10-02T12:00:00Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

  it("shows every broken rule with its count, at most 3 examples, and nothing for a reply that was not checked", () => {
    let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
    const r = M.startLeadRun(M.postMessage(s, "Hello", at(1)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(2));
    s = M.completeLeadRun(r.state, r.runId, { reply: "Hi.", proposals: [] }, at(3));
    const ex = (n: number) => ({ rule: "STE80.Vague", part: "reply", line: n, sentence: `Sentence ${n}.`, match: "various" });
    const check: ProseCheck = {
      status: "checked",
      at: at(3),
      vale: "3.24.0",
      sentences: 9,
      passed: 4,
      rules: [
        { rule: "STE80.SentenceLength", level: "error", what: "A sentence over 35 words.", count: 1 },
        { rule: "STE80.Vague", level: "warning", what: "A vague word.", count: 4 },
      ],
      examples: [{ rule: "STE80.SentenceLength", part: "question 2", line: 1, sentence: "Long." }, ex(1), ex(2), ex(3), ex(4)],
    };
    const next = M.startLeadRun(M.postMessage(withLeadProse(s, r.runId, check), "Again", at(4)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(5));
    const run = next.state.leadRuns.find((x) => x.id === next.runId)!;
    expect(proseFeedbackSection(next.state, run)).toBe(`
${PROSE_FEEDBACK_HEADER}
Your last reply broke these rules of "Write controlled English" (4 of 9 sentences passed). Apply the principle in this reply. Do not mention this check to the user.
- A sentence over 35 words (error): 1
- A vague word: 4
Examples from your last reply:
- A sentence over 35 words, question 2 line 1: "Long."
- A vague word, reply line 1: "Sentence 1." ("various")
- A vague word, reply line 2: "Sentence 2." ("various")
`);
    expect(buildLeadEnvelope(next.state, run, "read")).toContain(proseFeedbackSection(next.state, run));
    const unchecked = withLeadProse(s, r.runId, { status: "not-checked", at: at(3), reason: "Vale was not found" });
    const again = M.startLeadRun(M.postMessage(unchecked, "Again", at(4)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(5));
    expect(buildLeadEnvelope(again.state, again.state.leadRuns.find((x) => x.id === again.runId)!, "read")).not.toContain(PROSE_FEEDBACK_HEADER);
  });
});
