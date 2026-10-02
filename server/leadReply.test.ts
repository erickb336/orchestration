// ORC-029 pass 4: the lead's reply is schema-constrained output. In the real trial of 2026-10-02 the lead left its
// "vision" object open, the block did not parse, and the whole reply was lost under a false note ("no
// machine-readable block"). Now each lead run asks its runtime for the reply schema, the service checks the answer
// again on arrival, and the note says what failed and where. The trial's reply is the fixture.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as M from "../src/domain/model";
import { LEAD_REPLY_SCHEMA, withNulls, type JsonSchema } from "../src/domain/model/leadReplySchema";
import { buildSeed } from "../src/domain/seed";
import { startFactoryArgs } from "../src/domain/testing/factory";
import type { State } from "../src/domain/types";
import { buildLeadEnvelope, parseLeadOutput } from "./envelope";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { ScriptedAdapter, proposal } from "./testing/scripted";

vi.setConfig({ testTimeout: 20_000 });

const TRIAL = readFileSync(join(import.meta.dirname, "fixtures", "lead-reply-trial-2026-10-02.txt"), "utf8");
/** The trial's reply with the one missing brace put back: the "vision" object closes before "coverage". */
const TRIAL_FIXED = TRIAL.replace(',\n  "coverage":', '\n  },\n  "coverage":');
const block = (o: unknown) => `Done.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe("reading the lead's answer", () => {
  it("the trial's reply as sent: its JSON does not parse, the note says where, and the text before it is the reply", () => {
    const out = parseLeadOutput(TRIAL);
    expect(out.problem).toEqual({ kind: "unparsed", where: "expected ',' or '}' after property value at line 59, column 2" });
    expect(M.leadReplyNote(out.problem!)).toBe("The reply's JSON did not parse (expected ',' or '}' after property value at line 59, column 2), so nothing was changed.");
    expect(out.reply).toMatch(/^Here is my first draft of the vision and the first studio round\./);
    expect(out.reply).not.toContain("```");
    expect(out).toEqual({ reply: out.reply, proposals: [], problem: out.problem });
  });

  it("the trial's reply with its brace put back matches the schema, and every part goes on to the domain", () => {
    expect(TRIAL_FIXED).not.toBe(TRIAL);
    const out = parseLeadOutput(TRIAL_FIXED);
    expect(out.problem).toBeUndefined();
    expect(out.reply).toMatch(/^Draft vision and round 1 are ready\./);
    expect(out.vision).toEqual({ text: expect.stringMatching(/^Weekend Trips: a small group of friends/) });
    expect(out.coverage).toMatchObject({ intent: "partial", material: "open" });
    expect(out.questions).toHaveLength(4);
    expect(out.studio).toMatchObject({ openRound: { focus: "experience" }, designerRuns: [{ kinds: ["screen"], variants: 2, devices: ["desktop", "mobile"] }], questions: [{}, {}] });
  });

  it("a constrained answer is the JSON alone, and a null field means the lead left it out", () => {
    const answer = withNulls(LEAD_REPLY_SCHEMA, { reply: "Opened round 1.", proposals: [], studio: { openRound: { focus: "experience" }, designerRuns: [{ brief: "The home screen.", kinds: ["screen"], variants: 1 }] } });
    const json = JSON.stringify(answer);
    expect(json).toContain('"steer":null');
    expect(json).toContain('"revises":null');
    const out = parseLeadOutput(json);
    expect(out).toEqual({ reply: "Opened round 1.", proposals: [], studio: { openRound: { focus: "experience" }, designerRuns: [{ brief: "The home screen.", kinds: ["screen"], variants: 1 }] } });
  });

  it("names each failure truthfully: no JSON, JSON that does not parse, JSON that is not an object, and a mismatch", () => {
    const none = parseLeadOutput("Just prose, no block.");
    expect(none).toEqual({ reply: "Just prose, no block.", proposals: [], problem: { kind: "no-json" } });
    expect(M.leadReplyNote(none.problem!)).toBe("The reply had no JSON block, so nothing was changed.");
    // A block that never closes (the answer was cut off), and a constrained answer cut off: both say where they stop.
    expect(parseLeadOutput('Here it is.\n```json\n{"reply": "ok", "proposals": [')).toEqual({ reply: "Here it is.", proposals: [], problem: { kind: "unparsed", where: "unexpected end of JSON input" } });
    expect(parseLeadOutput('{"reply": "ok",\n "proposals": [] "steer": null}')).toEqual({ reply: "", proposals: [], problem: { kind: "unparsed", where: "expected ',' or '}' after property value at line 2, column 18" } });
    // V8 quotes the text in some messages; the note leaves the quote out.
    expect(parseLeadOutput('{"reply": tru}').problem).toEqual({ kind: "unparsed", where: "unexpected token '}'" });
    const list = parseLeadOutput("```json\n[1, 2]\n```");
    expect(list.problem).toEqual({ kind: "not-object" });
    expect(M.leadReplyNote(list.problem!)).toBe("The reply's JSON was not an object, so nothing was changed.");
    // A mismatch is noted, and the parts still go to the domain, which checks each one (here: an unknown studio field).
    const odd = parseLeadOutput(block({ reply: "ok", proposals: [], studio: { approve: true } }));
    expect(odd.problem).toEqual({ kind: "schema", where: '/studio must NOT have additional properties ("approve")' });
    expect(odd.studio).toEqual({ approve: true });
    expect(M.leadReplyNote(odd.problem!)).toBe('The reply\'s JSON did not match the output schema (/studio must NOT have additional properties ("approve")). The service checked each part on its own.');
    // A sparse reply from a runtime that applied no schema matches: a field left out is the same as null.
    expect(parseLeadOutput(block({ reply: "ok", proposals: [proposal()] })).problem).toBeUndefined();
  });

  it("the output instructions name the schema, and every field the shown shape uses is in the schema", () => {
    const T0 = Date.parse("2026-10-02T12:00:00Z");
    const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
    const s = M.postMessage(M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0)), "Hello", at(1));
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(2));
    const text = buildLeadEnvelope(r.state, r.state.leadRuns.find((x) => x.id === r.runId)!, "read");
    expect(text).toContain('Your final answer is one JSON object, as the output schema defines. Put your whole message to the user in "reply"');
    expect(text).toContain("If you have no output schema, end your final message with the object in exactly one fenced JSON block.");
    const shown = JSON.parse(/\nThe fields:\n```json\n([\s\S]*?)\n```/.exec(text)![1]) as Record<string, unknown>;
    expect(Object.keys(shown)).toEqual(["reply", "proposals", "steer", "vision", "coverage", "questions", "studio"]);
    expect(fieldsOutside(LEAD_REPLY_SCHEMA, shown)).toEqual([]);
  });
});

/** The field paths of a shown shape that the schema does not name. */
function fieldsOutside(schema: JsonSchema, value: unknown, at = ""): string[] {
  const s = schema.anyOf?.find((b) => b.type === (Array.isArray(value) ? "array" : "object")) ?? schema;
  if (Array.isArray(value)) return value.flatMap((x, i) => fieldsOutside(s.items ?? {}, x, `${at}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => (s.properties?.[k] ? fieldsOutside(s.properties[k], v, `${at}/${k}`) : [`${at}/${k}`]));
}

describe("the lead run asks its runtime for the reply schema", () => {
  let dir: string;
  let store: Store;
  let claude: ScriptedAdapter;
  let scheduler: Scheduler;
  let now = Date.parse("2026-10-02T12:00:00Z");
  let key = 0;
  const iso = () => new Date(now).toISOString();
  const tick = () => scheduler.tick((now += 1000));
  const st = (): State => store.read().state;
  const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-lead-reply-"));
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    store = new Store(join(dir, "db.sqlite"));
    claude = new ScriptedAdapter("claude");
    scheduler = new Scheduler(store, { claude, codex: new ScriptedAdapter("codex") }, { leaseMs: 60_000, ackTimeoutMs: 10_000 });
    await scheduler.refreshHealth();
    cmd("initProject", { name: "Greeter", repoPath: repo, vision: "A tiny greeting library.", focus: "Greeting" });
    cmd("startFactory", startFactoryArgs(store.read().state));
    cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
  });
  afterEach(async () => {
    await scheduler.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the request carries the schema, and a constrained answer with nulls applies as the lead meant", () => {
    cmd("postMessage", { text: "Plan the greeting." });
    tick();
    const r = M.activeLeadRun(st())!;
    expect(claude.runs.get(r.id)!.outputSchema).toBe(LEAD_REPLY_SCHEMA);
    // A proposal with the fields it leaves out as null: removed before the domain reads it, so none is refused.
    const answer = withNulls(LEAD_REPLY_SCHEMA, { reply: "Planned one task.", proposals: [{ ...proposal({ title: "Say hello" }), area: null, whyNow: null, flowId: null, priority: null }] });
    claude.emit({ type: "completed", attemptId: r.id, finalText: JSON.stringify(answer) });
    tick();
    const msg = st().conversation.find((m) => m.author === "lead")!;
    expect(msg.text).toBe("Planned one task.");
    expect(msg.rejected).toBeUndefined();
    expect(msg.proposedTaskIds).toHaveLength(1);
    const t = st().tasks.find((x) => x.id === msg.proposedTaskIds![0])!;
    expect(M.currentSpec(t).content).toMatchObject({ title: "Say hello", area: "General" });
    const run = st().leadRuns.find((x) => x.id === r.id)!;
    expect([run.note, run.rawAnswer]).toEqual([undefined, undefined]);
  });

  it("the trial's reply as sent: nothing applies, the note says where, and the run keeps the text for diagnosis", () => {
    cmd("postMessage", { text: "A small app for friends to plan a weekend away." });
    tick();
    const r = M.activeLeadRun(st())!;
    claude.emit({ type: "completed", attemptId: r.id, finalText: TRIAL });
    tick();
    const run = st().leadRuns.find((x) => x.id === r.id)!;
    const note = "The reply's JSON did not parse (expected ',' or '}' after property value at line 59, column 2), so nothing was changed.";
    expect(run).toMatchObject({ outcome: "completed", note, rawAnswer: { text: TRIAL } });
    const msg = st().conversation.find((m) => m.author === "lead")!;
    expect(msg.text).toMatch(/^Here is my first draft of the vision/);
    expect(msg.rejected).toEqual([note]);
    expect(st().visionDrafts).toEqual([]);
  });
});

describe("the final text a lead run keeps", () => {
  const T0 = Date.parse("2026-10-02T12:00:00Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  /** Ask, start a lead run and complete it with this output; returns the state and the run's id. */
  function answer(s: State, sec: number, out: { problem?: M.LeadReplyProblem; answerText: string }) {
    const r = M.startLeadRun(M.postMessage(s, `Message ${sec}`, at(sec)), { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(sec + 1));
    return { state: M.completeLeadRun(r.state, r.runId, { reply: "", proposals: [], ...out }, at(sec + 2)), id: r.runId };
  }
  const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));

  it("is kept only with a problem, capped at 65,536 characters, and only on the newest five runs", () => {
    let s = fresh();
    const ok = answer(s, 10, { answerText: '{"reply":"fine","proposals":[]}' });
    s = ok.state;
    expect(s.leadRuns.find((x) => x.id === ok.id)!.rawAnswer).toBeUndefined();
    const long = answer(s, 20, { problem: { kind: "no-json" }, answerText: "x".repeat(70_000) });
    s = long.state;
    expect(s.leadRuns.find((x) => x.id === long.id)!.rawAnswer).toEqual({ text: "x".repeat(65_536), truncated: true });
    const ids: string[] = [long.id];
    for (let i = 0; i < 5; i++) {
      const next = answer(s, 30 + i * 10, { problem: { kind: "unparsed", where: "unexpected end of JSON input" }, answerText: `{"reply": "cut off ${i}` });
      s = next.state;
      ids.push(next.id);
    }
    // Six runs had a problem; the oldest one's text was dropped.
    expect(ids.map((id) => s.leadRuns.find((x) => x.id === id)!.rawAnswer?.text.slice(0, 20))).toEqual([undefined, '{"reply": "cut off 0', '{"reply": "cut off 1', '{"reply": "cut off 2', '{"reply": "cut off 3', '{"reply": "cut off 4']);
    expect(s.leadRuns.find((x) => x.id === long.id)!.note).toBe("The reply had no JSON block, so nothing was changed.");
  });
});
