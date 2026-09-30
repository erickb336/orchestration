// ORC-012: shaping the vision with the lead first, service level. Scripted adapters for both providers
// and a temporary git repository; no real providers. Shaping end to end (no planning, no dispatch, the
// shaping brief, a draft accepted, Start building releasing the roadmap), a planning run that cannot
// draft, going back to shaping with a live run, the format 11 → 12 migration, the simulated lead's
// draft, and command validation.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { buildSeed } from "../src/domain/seed";
import type { State } from "../src/domain/types";
import { buildLeadEnvelope, parseLeadOutput } from "./envelope";
import { fakeLeadText, fakeVision } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { CommandFailure, STATE_FORMAT, Store } from "./store";
import { ScriptedAdapter, coverage, proposal, questions, steer, visionDraft } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler;
let now = Date.parse("2026-09-30T12:00:00Z");
const iso = () => new Date(now).toISOString();
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const state = (): State => store.read().state;
const task = (id: string) => state().tasks.find((t) => t.id === id)!;
let key = 0;
const cmd = (name: string, args: object = {}, k = `k${++key}`) => store.command(name, args, k, iso());
const leadRun = () => M.activeLeadRun(state());
const lastReply = () => state().conversation.filter((m) => m.author === "lead").pop()!;
const autonomy = (over: Record<string, unknown> = {}) =>
  cmd("setAutonomy", { enabled: true, planningIntervalMinutes: 60, maxProposalsPerCycle: 3, maxOpenProposals: 5, holdLeadProposals: false, operatingHours: null, ...over });
const createTask = (title: string, priority: number, over: Record<string, unknown> = {}) =>
  (cmd("createTask", { title, area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority, holdBeforeStart: false, templateId: "change", ...over }).result as { newId: string }).newId;

/** Start a project in the given stage; role defaults and the lead are set afterwards (initProject resets them). */
function init(stage: "shaping" | "building", vision = "") {
  cmd("initProject", { name: "Apps", repoPath: repo, vision, focus: "", stage });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
}

/** Post a message and start its reply run. */
function ask(text: string) {
  cmd("postMessage", { text });
  tick();
  return leadRun()!;
}

const failure = (fn: () => unknown): CommandFailure => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommandFailure) return e;
    throw e;
  }
  throw new Error("expected the command to fail");
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-shape-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000, ackTimeoutMs: 10_000 });
  await scheduler.refreshHealth();
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("A. shaping end to end", () => {
  it("no planning and no dispatch while shaping; a message gets the shaping brief; the draft waits; Start building needs the accepted vision and releases the roadmap on Autopilot", () => {
    init("shaping");
    autonomy(); // Autopilot-like: planning on, no holds
    expect(M.currentVision(state()).text).toBe("");
    createTask("A user task", 1); // ready, and would run while building
    for (let i = 0; i < 5; i++) tick(60 * 60_000); // hours pass: no planning run, nothing dispatched
    expect(leadRun()).toBeUndefined();
    expect(state().leadRuns).toHaveLength(0);
    expect(M.activeAttempts(state())).toHaveLength(0);
    expect(claude.started).toHaveLength(0);
    expect(codex.started).toHaveLength(0);

    const r = ask("I want every app to build and run locally with one command. Deployment can wait.");
    expect(r.trigger).toBe("message");
    const prompt = claude.runs.get(r.id)!.prompt;
    expect(prompt).toContain("Project stage: shaping");
    expect(prompt).toContain("## Shaping the vision");
    expect(prompt).toContain('"vision": {');
    expect(prompt).toContain("(not written yet)");
    claude.reply(r.id, "Here is a first draft and one planned task.", [proposal({ title: "One-command local dev", priority: 1 })], undefined, visionDraft());
    tick();
    const s = state();
    const d = M.openVisionDraft(s)!;
    expect(d).toMatchObject({ leadRunId: r.id, status: "open", focus: "Get every app running locally", basedOnVisionRev: 1 });
    expect(M.currentVision(s).rev).toBe(1); // the draft changed nothing
    expect(lastReply().visionDraftId).toBe(d.id);
    const [planned] = M.roadmapTasks(s);
    expect(planned).toMatchObject({ holdBeforeStart: true, fromShaping: true });
    tick();
    tick();
    expect(M.activeAttempts(state())).toHaveLength(0); // still nothing runs, the user task included
    expect(M.stateLabel(state(), task(planned.id))).toBe("Held before start");
    expect(state().leadRuns.filter((x) => x.trigger === "planning")).toHaveLength(0);

    const refused = failure(() => cmd("startBuilding"));
    expect(refused.kind).toBe("control");
    expect(refused.message).toMatch(/Write or accept a vision first/);
    expect(state().project.stage).toBe("shaping");

    const stale = failure(() => cmd("acceptVisionDraft", { draftId: d.id, expectedRev: 7 }));
    expect(stale.kind).toBe("stale");
    cmd("acceptVisionDraft", { draftId: d.id, expectedRev: 1 });
    expect(M.currentVision(state())).toMatchObject({ rev: 2, author: "user", text: d.text, focus: d.focus, source: { draftId: d.id, leadRunId: r.id } });
    expect(state().visionDrafts[0]).toMatchObject({ status: "accepted", visionRev: 2 });

    cmd("startBuilding");
    expect(state().project.stage).toBe("building");
    expect(task(planned.id).holdBeforeStart).toBe(false); // released: Autopilot
    tick();
    const active = M.activeAttempts(state());
    expect(active.length).toBeGreaterThan(0);
    expect(active.map((a) => a.taskId).sort()).toEqual([planned.id, state().tasks.find((t) => t.specs[0].author === "user")!.id].sort());
    expect(codex.started.length).toBeGreaterThan(0);
    // The next message run is a building one: no shaping brief, no vision contract.
    const r2 = ask("how is it going?");
    expect(claude.runs.get(r2.id)!.prompt).not.toContain("Project stage: shaping");
    expect(claude.runs.get(r2.id)!.prompt).not.toContain('"vision": {');
  });

  it("with manual involvement the roadmap keeps waiting after Start building, as lead proposals do", () => {
    init("shaping", "A tiny greeting library.");
    const r = ask("plan the first steps");
    claude.reply(r.id, "Two steps.", [proposal({ title: "Step one", priority: 1 }), proposal({ title: "Step two", priority: 2 })]);
    tick();
    expect(M.roadmapTasks(state())).toHaveLength(2);
    cmd("startBuilding");
    tick();
    for (const t of M.roadmapTasks(state())) expect(t.holdBeforeStart).toBe(true);
    expect(M.activeAttempts(state())).toHaveLength(0);
    cmd("startHeldTask", { taskId: M.roadmapTasks(state())[0].id });
    tick();
    expect(M.activeAttempts(state())).toHaveLength(1);
  });

  it("a dismissed draft leaves the vision unchanged and the lead sees the dismissal; a newer draft supersedes an open one", () => {
    init("shaping");
    const r = ask("notes should be fast");
    claude.reply(r.id, "Draft one.", [], undefined, visionDraft({ focus: "First" }));
    tick();
    const first = M.openVisionDraft(state())!;
    cmd("dismissVisionDraft", { draftId: first.id });
    expect(M.currentVision(state()).rev).toBe(1);
    expect(state().visionDrafts[0].status).toBe("dismissed");
    const r2 = ask("try again, shorter");
    expect(claude.runs.get(r2.id)!.prompt).toMatch(new RegExp(`${first.id} .*dismissed by the user`));
    claude.reply(r2.id, "Draft two.", [], undefined, visionDraft({ focus: "Second" }));
    tick();
    const r3 = ask("and once more");
    claude.reply(r3.id, "Draft three.", [], undefined, visionDraft({ focus: "Third" }));
    tick();
    expect(state().visionDrafts.map((d) => [d.focus, d.status])).toEqual([
      ["First", "dismissed"],
      ["Second", "superseded"],
      ["Third", "open"],
    ]);
    expect(M.currentVision(state()).rev).toBe(1);
  });
});

describe("B. only message runs may draft", () => {
  it("a planning run's draft is rejected with a reason and recorded under its reply, while its proposal is still created", () => {
    init("building", "Ship the apps.");
    autonomy();
    tick();
    const r = leadRun()!;
    expect(r.trigger).toBe("planning");
    const prompt = claude.runs.get(r.id)!.prompt;
    expect(prompt).not.toContain("Project stage: shaping");
    expect(prompt).not.toContain('"vision": {');
    claude.reply(r.id, "Planning.", [proposal()], undefined, visionDraft());
    tick();
    expect(state().visionDrafts).toEqual([]);
    expect(lastReply().rejected).toEqual(["Vision draft: planning runs cannot draft the vision"]);
    expect(state().tasks).toHaveLength(1);
    expect(M.currentVision(state()).rev).toBe(1);
  });

  it("a malformed draft from a message run is rejected with its reason; steering in the same reply still applies while shaping", () => {
    init("shaping", "Ship the apps.");
    const r = ask("focus on local builds instead of deployment");
    claude.reply(r.id, "ok", [], steer({ focus: "Local builds first" }), { text: "x".repeat(9000) });
    tick();
    expect(state().visionDrafts).toEqual([]);
    expect(lastReply().rejected).toEqual(["Vision draft: the text is over 8000 characters"]);
    expect(M.currentVision(state())).toMatchObject({ rev: 2, author: "lead", focus: "Local builds first" });
    expect(state().steering[0].changes[0]).toMatchObject({ kind: "focus", status: "applied" });
  });
});

describe("C. back to shaping stops nothing", () => {
  it("a running step finishes and its result is accepted; the next step waits until Start building", () => {
    init("building", "Ship the apps.");
    const id = createTask("Two-step task", 1);
    tick();
    const [a] = M.activeAttempts(state());
    expect(a.taskId).toBe(id);
    cmd("startShaping");
    expect(state().project.stage).toBe("shaping");
    tick();
    expect(codex.interrupts).toEqual([]);
    expect(claude.interrupts).toEqual([]);
    expect(M.activeAttempts(state())[0]).toMatchObject({ id: a.id, outcome: "running" });
    codex.finish(a.id, { write: ["greet.txt", "hi\n"] });
    tick();
    expect(state().attempts.find((x) => x.id === a.id)!.outcome).toBe("completed");
    expect(state().artifacts.some((x) => x.attemptId === a.id)).toBe(true);
    for (let i = 0; i < 3; i++) tick();
    expect(M.activeAttempts(state())).toHaveLength(0);
    expect(M.stateLabel(state(), task(id))).toBe("Next step waits (shaping)");
    expect(M.stateLabel(state(), task(id))).not.toMatch(/Paused/);
    cmd("startBuilding");
    tick();
    expect(M.activeAttempts(state()).map((x) => x.taskId)).toEqual([id]);
    expect(M.activeAttempts(state())[0].stepId).not.toBe(a.stepId);
  });

  it("the stage survives a restart, and a run left running across it still finishes normally", async () => {
    init("building", "Ship the apps.");
    const id = createTask("Survives", 1);
    tick();
    const [a] = M.activeAttempts(state());
    cmd("startShaping");
    const claude2 = new ScriptedAdapter("claude");
    const codex2 = new ScriptedAdapter("codex");
    const s2 = new Scheduler(store, { claude: claude2, codex: codex2 }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000 });
    await s2.refreshHealth();
    await scheduler.stop();
    now += 1000;
    s2.tick(now);
    expect(state().project.stage).toBe("shaping");
    expect(state().attempts.find((x) => x.id === a.id)!.outcome).toBe("lost"); // no process survives a restart
    for (let i = 0; i < 3; i++) {
      now += 1000;
      s2.tick(now);
    }
    // The lost step went back to pending; shaping holds it, and Start building lets it run again.
    expect(M.activeAttempts(state())).toHaveLength(0);
    expect(task(id).steps.find((x) => x.id === a.stepId)!.state).toBe("pending");
    expect(task(id).lifecycle).toBe("active");
    store.command("startBuilding", {}, "restart-build", iso());
    now += 1000;
    s2.tick(now);
    expect(M.activeAttempts(state()).map((x) => [x.taskId, x.stepId])).toEqual([[id, a.stepId]]);
    await s2.stop();
  });
});

describe("D. migration and the simulated lead", () => {
  it("a format-11 database migrates to 12: every existing project is building, with no drafts, and accepts the new commands", () => {
    const path = join(dir, "old.sqlite");
    const seeded = new Store(path);
    seeded.close();
    const raw = new DatabaseSync(path);
    const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json);
    delete doc.project.stage;
    delete doc.visionDrafts;
    doc.version = 11;
    raw.prepare("UPDATE state SET format = 11, json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(STATE_FORMAT).toBe(12);
    expect(s.version).toBe(12);
    expect(s.project.stage).toBe("building");
    expect(s.visionDrafts).toEqual([]);
    expect(s.tasks.every((t) => t.fromShaping === undefined)).toBe(true);
    upgraded.command("startShaping", {}, "m1", iso());
    expect(upgraded.read().state.project.stage).toBe("shaping");
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(12);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_11_%'").get()).toBeDefined();
    check.close();
  });

  it("the simulated lead drafts a vision from the user's message only while shaping, labelled simulated; planning never drafts", () => {
    const base = buildSeed(now, { inFlightRuns: false });
    const shaping = M.postMessage(M.startShaping(base, iso()), "Build a notes app that syncs offline", iso());
    const run = M.startLeadRun(shaping, { provider: "claude", model: "m", trigger: "message" }, iso());
    const prompt = buildLeadEnvelope(run.state, M.activeLeadRun(run.state)!, "read");
    const v = fakeVision(prompt)!;
    expect(v.text).toMatch(/^\(Simulated draft, exchange 1\) Problem: Build a notes app that syncs offline/);
    expect(v.focus).toBe("(Simulated) Build a notes app that syncs offline");
    const text = fakeLeadText(run.runId, "message", prompt);
    const out = parseLeadOutput(text);
    expect(out.vision).toEqual(v);
    expect(out.reply).toMatch(/^\(Simulated lead\) Here is what I understand: Build a notes app that syncs offline/);
    const done = M.completeLeadRun(run.state, run.runId, out, iso());
    expect(M.openVisionDraft(done)).toMatchObject({ leadRunId: run.runId, focus: v.focus, status: "open" });
    expect(M.currentVision(done).rev).toBe(1);
    // Building: no draft, whatever the message says.
    const building = M.postMessage(base, "Build a notes app that syncs offline", iso());
    const run2 = M.startLeadRun(building, { provider: "claude", model: "m", trigger: "message" }, iso());
    const prompt2 = buildLeadEnvelope(run2.state, M.activeLeadRun(run2.state)!, "read");
    expect(fakeVision(prompt2)).toBeUndefined();
    expect(parseLeadOutput(fakeLeadText(run2.runId, "message", prompt2)).vision).toBeUndefined();
    // A planning run never drafts, even from a shaping envelope.
    expect(parseLeadOutput(fakeLeadText("lead-p", "planning", prompt)).vision).toBeUndefined();
  });
});

describe("F. coverage and questions (revision 2)", () => {
  it("a shaping reply with a draft, questions and coverage is stored and survives a reopen of the store; the answers arrive as one message", () => {
    init("shaping");
    const r = ask("I want fast note capture on my phone.");
    expect(claude.runs.get(r.id)!.prompt).toContain("## Shaping the vision");
    expect(claude.runs.get(r.id)!.prompt).toContain('"coverage": {');
    expect(claude.runs.get(r.id)!.prompt).toContain('"questions": [');
    expect(claude.runs.get(r.id)!.prompt).toContain("- intent: Intent and why now — open (not reported yet)");
    claude.reply(r.id, "Here is what I understand…", [], undefined, visionDraft(), { coverage: coverage(), questions: questions() });
    tick();
    const reply = lastReply();
    expect(reply.visionDraftId).toBe(M.openVisionDraft(state())!.id);
    expect(reply.questions).toEqual(questions());
    expect(reply.rejected).toBeUndefined();
    expect(state().leadRuns.find((x) => x.id === r.id)!.coverage).toEqual(coverage());
    expect(M.coverageOf(state())).toEqual(coverage());
    expect(M.openAreas(state())).toEqual(["outcome", "constraints", "risks", "priorities", "material"]);
    expect(M.currentVision(state()).rev).toBe(1);
    // Persisted: a second store on the same file reads the same coverage and questions.
    const again = new Store(store.path);
    expect(again.read().state.leadRuns.find((x) => x.id === r.id)!.coverage).toEqual(coverage());
    expect(again.read().state.conversation.find((m) => m.id === reply.id)!.questions).toEqual(questions());
    again.close();
    // The inline answers: one user message; the next run sees the reported coverage and the answers.
    cmd("postMessage", { text: M.answersMessage(questions(), ["Just you", "", "No sync"]) });
    expect(state().conversation.filter((m) => m.author === "user")).toHaveLength(2);
    expect(state().conversation[state().conversation.length - 1].text).toBe("Q: Who is this for first?\nA: Just you\n\nQ: What must it not do?\nA: No sync");
    expect(M.latestQuestions(state())).toBeUndefined();
    tick();
    const r2 = leadRun()!;
    expect(claude.runs.get(r2.id)!.prompt).toContain("- audience: Who it is for — partial");
    expect(claude.runs.get(r2.id)!.prompt).toContain("Q: Who is this for first?");
    // Start building is not blocked by open areas (the UI asks for confirmation; the command starts).
    claude.reply(r2.id, "ok", []);
    tick();
    cmd("acceptVisionDraft", { draftId: M.openVisionDraft(state())!.id, expectedRev: 1 });
    expect(M.openAreas(state())).toHaveLength(5);
    cmd("startBuilding");
    expect(state().project.stage).toBe("building");
  });

  it("a planning run cannot send questions or coverage; the reasons are recorded under its reply", () => {
    init("building", "Ship the apps.");
    autonomy();
    tick();
    const r = leadRun()!;
    expect(r.trigger).toBe("planning");
    claude.reply(r.id, "Planning.", [proposal()], undefined, undefined, { coverage: coverage(), questions: questions() });
    tick();
    expect(lastReply().rejected).toEqual(["Coverage: planning runs cannot report coverage", "Questions: planning runs cannot ask the user"]);
    expect(lastReply().questions).toBeUndefined();
    expect(state().leadRuns.find((x) => x.id === r.id)!.coverage).toBeUndefined();
    expect(state().tasks).toHaveLength(1);
  });

  it("the simulated lead in shaping sends a living draft with marked assumptions, three questions with options and a coverage, all labelled simulated, from the first exchange", () => {
    const base = buildSeed(now, { inFlightRuns: false });
    const shaping = M.postMessage(M.startShaping(base, iso()), "Build a notes app that syncs offline", iso());
    const run = M.startLeadRun(shaping, { provider: "claude", model: "m", trigger: "message" }, iso());
    const prompt = buildLeadEnvelope(run.state, M.activeLeadRun(run.state)!, "read");
    const out = parseLeadOutput(fakeLeadText(run.runId, "message", prompt));
    expect(out.reply).toMatch(/^\(Simulated lead\) Here is what I understand/);
    expect(String((out.vision as { text: string }).text)).toMatch(/^\(Simulated draft, exchange 1\)/);
    expect(String((out.vision as { text: string }).text)).toContain("(assumption");
    expect(out.questions).toHaveLength(3);
    for (const q of out.questions as { question: string; why: string }[]) {
      expect(q.question).toMatch(/^\(Simulated\)/);
      expect(q.why).toMatch(/^\(Simulated\)/);
    }
    expect((out.questions as { options?: string[] }[])[0].options).toEqual(["Just me (recommended)", "A small team", "Anyone"]);
    expect(out.coverage).toMatchObject({ intent: "partial", audience: "open" });
    const done = M.completeLeadRun(run.state, run.runId, out, iso());
    expect(M.openVisionDraft(done)?.status).toBe("open");
    expect(M.currentVision(done).rev).toBe(1);
    expect(done.conversation[done.conversation.length - 1].questions).toHaveLength(3);
    expect(done.conversation[done.conversation.length - 1].rejected).toBeUndefined();
    expect(M.coverageOf(done)!.intent).toBe("partial");
    // Second exchange: the coverage improves and the draft says so; still a suggestion.
    const answered = M.postMessage(done, "Just me. I use it daily.", iso());
    const run2 = M.startLeadRun(answered, { provider: "claude", model: "m", trigger: "message" }, iso());
    const out2 = parseLeadOutput(fakeLeadText(run2.runId, "message", buildLeadEnvelope(run2.state, M.activeLeadRun(run2.state)!, "read")));
    expect(String((out2.vision as { text: string }).text)).toMatch(/^\(Simulated draft, exchange 2\)/);
    expect(out2.coverage).toMatchObject({ intent: "clear", audience: "partial" });
    const done2 = M.completeLeadRun(run2.state, run2.runId, out2, iso());
    expect(done2.visionDrafts.map((d) => d.status)).toEqual(["superseded", "open"]);
    expect(M.currentVision(done2).rev).toBe(1);
    // Planning never sends any of it.
    const planning = parseLeadOutput(fakeLeadText("lead-p", "planning", prompt));
    expect(planning.vision).toBeUndefined();
    expect(planning.questions).toBeUndefined();
    expect(planning.coverage).toBeUndefined();
  });
});

describe("E. command validation", () => {
  it("initProject rejects an unknown stage; acceptVisionDraft needs string edits; dismiss needs a known draft", () => {
    expect(failure(() => cmd("initProject", { name: "X", repoPath: repo, vision: "", focus: "", stage: "later" })).kind).toBe("invalid");
    expect(failure(() => cmd("initProject", { name: "X", repoPath: repo, vision: "", focus: "" })).message).toMatch(/vision is required/);
    init("shaping");
    const r = ask("notes should be fast");
    claude.reply(r.id, "Draft.", [], undefined, visionDraft());
    tick();
    const d = M.openVisionDraft(state())!;
    expect(failure(() => cmd("acceptVisionDraft", { draftId: d.id, expectedRev: 1, text: 5 })).kind).toBe("invalid");
    expect(failure(() => cmd("acceptVisionDraft", { draftId: d.id, expectedRev: 1, text: "   " })).message).toMatch(/cannot be empty/);
    expect(failure(() => cmd("dismissVisionDraft", { draftId: "vd-none" })).kind).toBe("control");
    cmd("acceptVisionDraft", { draftId: d.id, expectedRev: 1, text: "My words.", focus: "Mine" });
    expect(M.currentVision(state())).toMatchObject({ rev: 2, text: "My words.", focus: "Mine", author: "user" });
    expect(M.currentVision(state()).reason).toMatch(/with edits/);
    expect(failure(() => cmd("startShaping")).message).toMatch(/Already shaping/);
  });
});
