// Notes to a running stage, service level. The fake runtime end to end through the scheduler
// (sending, then delivered after its simulated delay; not delivered when the run ends or stops first), the
// scripted adapters (the note handed over once, stale answers ignored, a restart while sending), queued notes
// written into the next run's envelope and confirmed at start, the downstream and lead envelopes, the fake
// lead relaying a note, and the format 16 → 17 migration. No real providers.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSeed } from "../src/domain/seed";
import * as M from "../src/domain/model";
import type { Note, State } from "../src/domain/types";
import { buildEnvelope, buildLeadEnvelope } from "./envelope";
import { FakeAdapter, NOTE_ACK_TICKS, defaultFakeConfig, fakeNote, fakeSteer } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { STATE_FORMAT, Store } from "./store";
import { ScriptedAdapter, steer } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
const opened: { close(): void | Promise<void> }[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-notes-"));
});
afterEach(async () => {
  for (const o of opened.splice(0).reverse()) {
    try {
      await o.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const runOf = (s: State, id: string, stepId: string) => M.activeAttempts(s, id).find((a) => a.stepId === stepId);
const note = (s: State, id: string): Note => s.notes.find((n) => n.id === id)!;
let key = 0;
const k = () => `k-${++key}`;

// ---------- the fake runtime through the scheduler ----------

/** The sample project (no runs in flight) on two fake adapters; the scheduler dispatches and ticks on our clock. */
function fakeService(progressPerTick = 5) {
  const store = new Store(join(dir, `fake-${key}.db`), () => buildSeed(T0, { inFlightRuns: false }));
  opened.push(store);
  const config = { ...defaultFakeConfig(), progressPerTick, ackDelayMs: 2000 };
  const claude = new FakeAdapter("claude", config);
  const codex = new FakeAdapter("codex", config);
  const scheduler = new Scheduler(store, { claude, codex }, { leaseMs: 60_000, ackTimeoutMs: 10_000 });
  opened.push({ close: () => scheduler.stop() });
  let now = T0;
  const tick = (ms = 1000) => {
    now += ms;
    scheduler.tick(now);
  };
  const state = () => store.read().state;
  const cmd = (name: string, args: object = {}) => store.command(name, args, k(), iso(now));
  return { store, scheduler, claude, codex, tick, state, cmd, now: () => now };
}

describe("the fake runtime, end to end", () => {
  it("your note to a running coder: Sending, then Delivered (simulated) after the fake delay; the run continues and completes with its work kept", () => {
    const f = fakeService(5);
    f.tick(); // reconcile and dispatch
    const s0 = f.state();
    const run = runOf(s0, "EX-001", "S2")!;
    expect(run.snapshot.provider).toBe("codex");
    const r = f.cmd("sendNote", { taskId: "EX-001", stepId: "S2", text: "Skip the README; I will write it." });
    const id = (r.result as { noteId: string }).noteId;
    expect(note(f.state(), id)).toMatchObject({ status: "sending", via: "live", attemptId: run.id, from: { by: "user" } });
    f.tick(); // handed to the adapter this cycle; the fake acknowledges after NOTE_ACK_TICKS ticks
    for (let i = 0; i < NOTE_ACK_TICKS - 1; i++) {
      expect(note(f.state(), id).status).toBe("sending");
      f.tick();
    }
    const n = note(f.state(), id);
    expect(n).toMatchObject({ status: "delivered", via: "live", simulated: true });
    expect(n.settledAt).toBeDefined();
    expect(f.state().events.some((e) => e.message === `Note ${id} delivered to S2's run ${run.id}`)).toBe(true);
    // The run goes on and completes normally; the note stays delivered and is what downstream steps see.
    for (let i = 0; i < 40 && runOf(f.state(), "EX-001", "S2"); i++) f.tick();
    const done = f.state();
    expect(step(done, "EX-001", "S2").state).toBe("done");
    expect(f.state().attempts.find((a) => a.id === run.id)!.outcome).toBe("completed");
    expect(M.notesReceived(done, run.id).map((x) => x.id)).toEqual([id]);
  });

  it("the run ends before the acknowledgment: Not delivered, with the fake's reason; nothing is ever marked delivered by implication", () => {
    const f = fakeService(60); // two ticks to finish
    f.tick();
    const run = runOf(f.state(), "EX-001", "S2")!;
    const id = (f.cmd("sendNote", { taskId: "EX-001", stepId: "S2", text: "Too late." }).result as { noteId: string }).noteId;
    f.tick(); // handed over; the run completes on this tick, before the two-tick acknowledgment
    expect(f.state().attempts.find((a) => a.id === run.id)!.outcome).toBe("completed");
    expect(note(f.state(), id)).toMatchObject({ status: "not-delivered", reason: "the run ended first", simulated: true });
  });

  it("a pause while the note is on its way: the stopping run acknowledges nothing; the note is Not delivered, and a note to a stopping run is queued", () => {
    const f = fakeService(1);
    f.tick();
    const run = runOf(f.state(), "EX-001", "S2")!;
    const id = (f.cmd("sendNote", { taskId: "EX-001", stepId: "S2", text: "Before the pause." }).result as { noteId: string }).noteId;
    f.tick(); // handed over
    f.cmd("pauseTask", { taskId: "EX-001" });
    const queued = (f.cmd("sendNote", { taskId: "EX-001", stepId: "S2", text: "During the pause." }).result as { noteId: string }).noteId;
    expect(note(f.state(), queued).status).toBe("queued");
    f.tick();
    expect(note(f.state(), id)).toMatchObject({ status: "not-delivered", reason: "the run stopped first" });
    f.tick(2000);
    f.tick();
    expect(f.state().attempts.find((a) => a.id === run.id)!.outcome).toBe("stopped");
    expect(note(f.state(), queued).status).toBe("queued"); // the pause wins: nothing resumed
    expect(task(f.state(), "EX-001").hold).toBe(true);
    // Resume: the next run carries the queued note in its instructions and confirms it at start.
    f.cmd("resumeTask", { taskId: "EX-001" });
    f.tick();
    const next = runOf(f.state(), "EX-001", "S2")!;
    expect(next.id).not.toBe(run.id);
    expect(note(f.state(), queued)).toMatchObject({ status: "delivered", via: "start", attemptId: next.id, simulated: true });
  });

  it("the lead relays a note (simulated lead, a scripted coder so its run outlives the reply): the row is sent live and acknowledged; Undo all leaves it", async () => {
    const store = new Store(join(dir, `mixed-${key}.db`), () => buildSeed(T0, { inFlightRuns: false }));
    opened.push(store);
    const claude = new FakeAdapter("claude", { ...defaultFakeConfig(), progressPerTick: 20 });
    const codex = new ScriptedAdapter("codex");
    const scheduler = new Scheduler(store, { claude, codex }, { leaseMs: 60_000, ackTimeoutMs: 10_000 });
    opened.push({ close: () => scheduler.stop() });
    await scheduler.refreshHealth();
    let now = T0;
    const tick = () => scheduler.tick((now += 1000));
    const state = () => store.read().state;
    store.command("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } }, k(), iso(now));
    tick();
    const run = runOf(state(), "EX-001", "S2")!;
    expect(run.snapshot.provider).toBe("codex");
    store.command("postMessage", { text: "Tell the coder on EX-001 to skip the README; I will write it" }, k(), iso(now));
    for (let i = 0; i < 30 && !state().steering.length; i++) tick();
    const set = state().steering[0];
    expect(set.simulated).toBe(true);
    const row = set.changes.find((c) => c.kind === "note")!;
    expect(row).toMatchObject({ status: "applied", appliedBy: "lead", taskId: "EX-001", stepId: "S2", after: "Skip the README; I will write it" });
    const n = note(state(), row.noteId!);
    expect(n).toMatchObject({ status: "sending", via: "live", attemptId: run.id, simulated: true, from: { by: "lead", changeSetId: set.id, changeId: row.id, leadRunId: set.leadRunId } });
    expect(codex.notes.map((x) => [x.attemptId, x.id])).toEqual([[run.id, n.id]]);
    expect(codex.notes[0].text).toMatch(/^Note from the lead, relaying the user \(mid-run, .*\): Skip the README; I will write it\n/);
    codex.emit({ type: "note", attemptId: run.id, noteId: n.id, outcome: "delivered" });
    tick();
    expect(note(state(), n.id)).toMatchObject({ status: "delivered", via: "live" });
    const undo = store.command("undoSteering", { changeSetId: set.id }, k(), iso(now));
    expect((undo.result as { left: unknown[] }).left).toEqual([]);
    expect(state().steering[0].changes.find((c) => c.kind === "note")!.status).toBe("applied");
    expect(state().conversation.filter((m) => m.author === "lead").pop()!.text).toMatch(/^I asked to pass your note on to the coder/);
  });
});

// ---------- the scripted adapters: hand-over, stale answers, restart ----------

function scriptedService() {
  const repo = join(dir, `repo-${key}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const path = join(dir, `scripted-${key}.db`);
  const store = new Store(path);
  opened.push(store);
  const claude = new ScriptedAdapter("claude");
  const codex = new ScriptedAdapter("codex");
  const scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, `worktrees-${key}`)), leaseMs: 60_000, ackTimeoutMs: 10_000 });
  opened.push({ close: () => scheduler.stop() });
  let now = T0;
  const tick = (ms = 1000) => {
    now += ms;
    scheduler.tick(now);
  };
  const state = () => store.read().state;
  const cmd = (name: string, args: object = {}) => store.command(name, args, k(), iso(now));
  return { path, repo, store, scheduler, claude, codex, tick, state, cmd, now: () => now };
}

async function setUp(f: ReturnType<typeof scriptedService>) {
  await f.scheduler.refreshHealth();
  f.cmd("initProject", { name: "Apps", repoPath: f.repo, vision: "Ship the apps.", focus: "Local builds" });
  f.cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  f.cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  f.cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
  const id = (f.cmd("createTask", { title: "Add a greeting", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
  f.tick(); // promoted
  f.tick(); // dispatched: S1 on Codex
  const run = runOf(f.state(), id, "S1")!;
  expect(f.codex.started.map((a) => a.attemptId)).toEqual([run.id]);
  return { id, run };
}

describe("the scripted adapters", () => {
  it("the lead's note reaches exactly that run once, with the framing text; the adapter's answer settles it; a stale answer changes nothing", async () => {
    const f = scriptedService();
    const { id, run } = await setUp(f);
    f.cmd("postMessage", { text: "tell the coder to skip the README" });
    f.tick();
    const lead = M.activeLeadRun(f.state())!;
    f.claude.reply(lead.id, "Sent a note.", [], steer({ focus: undefined, tasks: [], notes: [{ task: id, step: "S1", text: "Skip the README; the owner will write it." }] }));
    f.tick();
    const set = f.state().steering[0];
    const row = set.changes[0];
    expect(row).toMatchObject({ kind: "note", status: "applied", taskId: id, stepId: "S1" });
    const n = note(f.state(), row.noteId!);
    expect(n).toMatchObject({ status: "sending", via: "live", attemptId: run.id });
    expect(f.codex.notes).toEqual([{ attemptId: run.id, id: n.id, text: M.noteMessage(n) }]);
    expect(f.codex.notes[0].text).toMatch(/^Note from the lead, relaying the user \(mid-run, .*\): Skip the README; the owner will write it\.\nThis is guidance within your current assignment/);
    expect(f.claude.notes).toEqual([]);
    f.tick();
    f.tick();
    expect(f.codex.notes).toHaveLength(1); // handed over once, however many cycles pass
    // An answer for another run is ignored; the right one settles it.
    f.codex.emit({ type: "note", attemptId: "run-999", noteId: n.id, outcome: "delivered" });
    f.tick();
    expect(note(f.state(), n.id).status).toBe("sending");
    f.codex.emit({ type: "note", attemptId: run.id, noteId: n.id, outcome: "not-delivered", reason: "turn/steer: no active turn" });
    f.tick();
    expect(note(f.state(), n.id)).toMatchObject({ status: "not-delivered", reason: "turn/steer: no active turn" });
    expect(note(f.state(), n.id).simulated).toBeUndefined();
    f.codex.emit({ type: "note", attemptId: run.id, noteId: n.id, outcome: "delivered" }); // late and contradictory: ignored
    f.tick();
    expect(note(f.state(), n.id).status).toBe("not-delivered");
    // The lead's next envelope lists it with its status and reason.
    f.cmd("postMessage", { text: "and now?" });
    f.tick();
    const env = f.claude.started[f.claude.started.length - 1].prompt;
    expect(env).toMatch(new RegExp(`## Notes to running steps \\(last 24 hours; yours and the user's\\)\\n- ${n.id} \\(.*\\) by you \\(from msg-\\d+\\) → ${id} S1 \\(${run.id}\\): "Skip the README; the owner will write it\\." — not delivered: turn/steer: no active turn`));
    expect(env).toMatch(/· steps: S1 coder running \(Codex, run-\d+\), C1 checks pending \(the service\), S2 code_reviewer pending \(Claude\)/);
    expect(env).toMatch(/"notes": \[\n\s+\{ "task": "<task id>", "step": "<coder or designer step id>"/);
    expect(env).toMatch(/- "notes": when the user's message should change what running work does/);
    expect(env).toMatch(/note to .* S1 "Skip the README; the owner will write it\." — sent; not delivered: turn\/steer: no active turn/);
  });

  it("a restart while a note is sending: the new scheduler marks it not delivered with that reason, and never hands it over again", async () => {
    const f = scriptedService();
    const { id, run } = await setUp(f);
    const noteId = (f.cmd("sendNote", { taskId: id, stepId: "S1", text: "Mind the restart." }).result as { noteId: string }).noteId;
    f.tick();
    expect(f.codex.notes.map((x) => x.id)).toEqual([noteId]);
    expect(note(f.state(), noteId).status).toBe("sending");
    await f.scheduler.stop(); // the process ends; nothing answered
    const store2 = new Store(f.path);
    opened.push(store2);
    const claude2 = new ScriptedAdapter("claude");
    const codex2 = new ScriptedAdapter("codex");
    const scheduler2 = new Scheduler(store2, { claude: claude2, codex: codex2 }, { workspaces: new WorkspaceManager(join(dir, `worktrees-${key}`)), leaseMs: 60_000 });
    opened.push({ close: () => scheduler2.stop() });
    await scheduler2.refreshHealth();
    scheduler2.tick(f.now() + 70_000);
    const s = store2.read().state;
    expect(note(s, noteId)).toMatchObject({ status: "not-delivered", reason: "the service restarted before the runtime answered" });
    expect(s.attempts.find((a) => a.id === run.id)!.outcome).toBe("lost");
    scheduler2.tick(f.now() + 71_000);
    expect(codex2.notes).toEqual([]);
  });

  it("a queued note is written into the next run's envelope under 'Notes for this run', confirmed at start; the reviewer's envelope lists what the coder received", async () => {
    const f = scriptedService();
    const { id, run } = await setUp(f);
    f.cmd("pauseTask", { taskId: id });
    const queued = (f.cmd("sendNote", { taskId: id, stepId: "S1", text: "Keep the greeting in one file." }).result as { noteId: string }).noteId;
    expect(note(f.state(), queued).status).toBe("queued");
    f.tick();
    f.codex.emit({ type: "stopped", attemptId: run.id, how: "interrupted" });
    f.tick();
    expect(f.codex.notes).toEqual([]); // a queued note is never handed to the old run
    f.cmd("resumeTask", { taskId: id });
    f.tick();
    const next = runOf(f.state(), id, "S1")!;
    expect(next.id).not.toBe(run.id);
    const prompt = f.codex.started.find((a) => a.attemptId === next.id)!.prompt;
    expect(prompt).toContain(`## Notes for this run\nThese were sent while this step waited for a run. Each is guidance within this assignment, not a change to the specification.\n\n${M.noteMessage(note(f.state(), queued))}\n\n## Project vision`);
    expect(note(f.state(), queued)).toMatchObject({ status: "delivered", via: "start", attemptId: next.id });
    expect(note(f.state(), queued).simulated).toBeUndefined(); // a scripted (real) adapter, not the fake
    // Another live note to the new run, delivered; then the coder finishes and the reviewer reads the change.
    const live = (f.cmd("sendNote", { taskId: id, stepId: "S1", text: "Use the existing helper." }).result as { noteId: string }).noteId;
    f.tick();
    f.codex.emit({ type: "note", attemptId: next.id, noteId: live, outcome: "delivered" });
    f.tick();
    f.codex.finish(next.id, { write: ["greet.js", "export const greet = () => 'hi';\n"] });
    f.tick();
    for (let i = 0; i < 5 && !runOf(f.state(), id, "S2"); i++) f.tick(); // checks are off for a new project: C1 is skipped
    const review = runOf(f.state(), id, "S2")!;
    const reviewPrompt = f.claude.started.find((a) => a.attemptId === review.id)!.prompt;
    expect(reviewPrompt).toMatch(/## Notes the S1 agent received\n- .*, from the user \(at the start of its run\): "Keep the greeting in one file\."\n- .*, from the user: "Use the existing helper\."\n\n/);
  });

  it("a note written into a run's instructions is confirmed only when the runtime reports the run started; a run that fails first leaves it not delivered", async () => {
    const f = scriptedService();
    const { id, run } = await setUp(f);
    f.cmd("pauseTask", { taskId: id });
    const queued = (f.cmd("sendNote", { taskId: id, stepId: "S1", text: "Keep the greeting in one file." }).result as { noteId: string }).noteId;
    f.tick();
    f.codex.emit({ type: "stopped", attemptId: run.id, how: "interrupted" });
    f.tick();
    f.codex.reportsStart = false; // e.g. the binary is missing or sign-in fails before the run gets going
    f.cmd("resumeTask", { taskId: id });
    f.tick();
    const next = runOf(f.state(), id, "S1")!;
    expect(f.codex.started.find((a) => a.attemptId === next.id)!.prompt).toContain("## Notes for this run");
    expect(note(f.state(), queued)).toMatchObject({ status: "sending", via: "start", attemptId: next.id });
    f.codex.emit({ type: "failed", attemptId: next.id, message: "codex: not signed in" });
    f.tick();
    expect(note(f.state(), queued).status).toBe("not-delivered");
  });

  it("the user's note to a running reviewer is allowed; the lead's is rejected; a note to a check run is refused", async () => {
    const f = scriptedService();
    const { id, run } = await setUp(f);
    expect(() => f.cmd("sendNote", { taskId: id, stepId: "C1", text: "x" })).toThrow(/Check runs have no agent/);
    expect(() => f.cmd("sendNote", { taskId: id, stepId: "S2", text: "x" })).toThrow(/S2 is not running/);
    f.codex.finish(run.id, { write: ["greet.js", "x\n"] });
    f.tick();
    for (let i = 0; i < 5 && !runOf(f.state(), id, "S2"); i++) f.tick();
    const review = runOf(f.state(), id, "S2")!;
    const mine = (f.cmd("sendNote", { taskId: id, stepId: "S2", text: "Also check the retry path." }).result as { noteId: string }).noteId;
    f.tick();
    expect(f.claude.notes.map((x) => [x.attemptId, x.id])).toEqual([[review.id, mine]]);
    expect(f.claude.notes[0].text).toMatch(/^Note from the user \(mid-run, /);
    f.cmd("postMessage", { text: "tell the reviewer to hurry" });
    f.tick();
    const lead = M.activeLeadRun(f.state())!;
    f.claude.reply(lead.id, "ok", [], steer({ focus: undefined, tasks: [], notes: [{ task: id, step: "S2", text: "Hurry." }] }));
    f.tick();
    expect(f.state().steering[0].changes[0]).toMatchObject({ kind: "note", status: "rejected", note: "S2 is a code reviewer step: notes go to coder and designer steps only" });
    expect(f.claude.notes).toHaveLength(1);
  });
});

// ---------- the fake lead ----------

describe("the fake lead relays a note from the envelope", () => {
  it("finds the role's running step of the named task (else the first task with one), and nothing for other messages", () => {
    const prompt = [
      "## Open work (root tasks by priority; child tasks follow their root)",
      '- WT-002 [Running] P1 "Show a clear offline state" area:Maps · by lead · may: priority, defer · steps: S1 coder running (Codex, run-12), C1 checks pending (the service)',
      '- WT-004 [Running] P2 "Share a trip plan" area:Trips · by lead · may: priority · steps: S2 lead pending (Claude)',
      '  child WT-004.2 [Running] "See who is coming" · steps: S1 coder running (Claude, run-13)',
      "",
      "## Messages to answer now",
      "- Tell the coder on WT-004.2 to keep the attendee list sorted.",
      "",
      "## Rules",
    ].join("\n");
    const messages = ["Tell the coder on WT-004.2 to keep the attendee list sorted."];
    expect(fakeNote(prompt, messages)).toEqual({ task: "WT-004.2", step: "S1", text: "Keep the attendee list sorted" });
    expect(fakeNote(prompt, ["Please tell the coder to skip the README."])).toEqual({ task: "WT-002", step: "S1", text: "Skip the README" });
    expect(fakeNote(prompt, ["Can we put offline maps first?"])).toBeUndefined();
    expect(fakeNote(prompt, ["Tell the designer to use bigger type."])).toBeUndefined(); // no designer step on the board
    const block = fakeSteer(prompt)!;
    expect(block.focus).toBeUndefined();
    expect(block.notes).toEqual([{ task: "WT-004.2", step: "S1", text: "Keep the attendee list sorted" }]);
  });
});

// ---------- the migration ----------

describe("the format 16 → 17 migration", () => {
  it("a format-16 database loads with notes: [] and nothing else moved; a backup of the original is kept", () => {
    const path = join(dir, "old.db");
    const first = new Store(path);
    first.close();
    const raw = new DatabaseSync(path);
    const row = raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string };
    const doc = JSON.parse(row.json) as Record<string, unknown>;
    delete doc.notes;
    doc.version = 16;
    raw.prepare("UPDATE state SET format = 16, json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();
    const upgraded = new Store(path);
    opened.push(upgraded);
    const s = upgraded.read().state;
    expect(STATE_FORMAT).toBe(18);
    expect(s.version).toBe(18);
    expect(s.notes).toEqual([]);
    expect(s.tasks.map((t) => t.id)).toEqual((doc.tasks as { id: string }[]).map((t) => t.id));
    expect(s.steering).toEqual(doc.steering);
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(18);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_16_%'").get()).toBeDefined();
    check.close();
  });
});

// ---------- envelopes, directly ----------

describe("the envelopes", () => {
  it("a worker envelope without notes has neither section; the lead's envelope lists none and keeps the rules", () => {
    const s = buildSeed(T0);
    const t = task(s, "EX-002");
    const env = buildEnvelope({ state: s, task: t, step: step(s, "EX-002", "S2"), attemptId: "run-x", access: "read" });
    expect(env).not.toContain("## Notes for this run");
    expect(env).not.toContain("agent received");
    const run = M.startLeadRun(M.postMessage(s, "hi", iso(T0)), { provider: "claude", model: "m", trigger: "message" }, iso(T0 + 1000));
    const lead = buildLeadEnvelope(run.state, run.state.leadRuns.find((r) => r.id === run.runId)!, "read");
    expect(lead).toContain("## Notes to running steps (last 24 hours; yours and the user's)\n- None in the last 24 hours.");
    expect(lead).toMatch(/- EX-001 \[.*\] P1 .* · steps: S2 coder running \(Codex, run-\d+\), C1 checks pending \(the service\), S3 code_reviewer pending \(Claude\)/);
  });

  it("a note settled before it reached any run is listed to the lead as recorded, not sent", () => {
    const s = buildSeed(T0);
    const first = M.startLeadRun(M.postMessage(s, "tell the coder on EX-002 to skip the README", iso(T0)), { provider: "claude", model: "m", trigger: "message" }, iso(T0 + 1000));
    const done = M.completeLeadRun(first.state, first.runId, { reply: "Sent.", proposals: [], steer: { notes: [{ task: "EX-002", step: "S1", text: "Skip the README." }] } }, iso(T0 + 2000));
    const n = done.notes[done.notes.length - 1];
    expect(n).toMatchObject({ status: "not-delivered", reason: "S1 had finished" });
    expect(n.attemptId).toBeUndefined();
    const next = M.startLeadRun(M.postMessage(done, "and now?", iso(T0 + 3000)), { provider: "claude", model: "m", trigger: "message" }, iso(T0 + 4000));
    const lead = buildLeadEnvelope(next.state, next.state.leadRuns.find((r) => r.id === next.runId)!, "read");
    expect(lead).toMatch(/note to EX-002 S1 "Skip the README\." — recorded; not delivered: S1 had finished/);
  });
});
