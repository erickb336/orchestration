// ORC-009: steering by conversation, service level. Scripted adapters for both providers and a
// temporary git repository; no real providers. The user's own example end to end, planning preemption,
// newer direction, races, modes, the dependency guard, children, drop and re-proposal, idempotency,
// restart, the format 10 → 11 migration, the envelope, and provider neutrality.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import type { State, SteeringChangeSet } from "../src/domain/types";
import { buildLeadEnvelope } from "./envelope";
import { Scheduler } from "./scheduler";
import { STATE_FORMAT, Store } from "./store";
import { ScriptedAdapter, proposal, st, steer } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler;
let now = Date.parse("2026-09-29T12:00:00Z");
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
const lastSet = (): SteeringChangeSet => state().steering[state().steering.length - 1];
const status = (m = state().conversation.filter((x) => x.author === "user").pop()!) => M.messageStatus(state(), m, { nowMs: now });
const autonomy = (over: Record<string, unknown> = {}) =>
  cmd("setAutonomy", { enabled: true, planningIntervalMinutes: 60, maxProposalsPerCycle: 3, maxOpenProposals: 5, holdLeadProposals: false, operatingHours: null, ...over });
const createTask = (title: string, priority: number, over: Record<string, unknown> = {}) =>
  (cmd("createTask", { title, area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority, holdBeforeStart: false, patternId: "change", ...over }).result as { newId: string }).newId;
const FOCUS_MSG = "focus more on building out the apps working locally vs automating the deployment process";

/** Post a message and start its reply run. */
function ask(text: string, extra: object = {}) {
  cmd("postMessage", { text, ...extra });
  tick();
  return leadRun()!;
}

/** Direct state edits for setups no command makes (dependencies, children). */
const edit = (fn: (s: State) => void) =>
  store.update(
    (s) => {
      const next = structuredClone(s);
      fn(next);
      return next;
    },
    iso(),
  );

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-steer-"));
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
  cmd("initProject", { name: "Apps", repoPath: repo, vision: "Ship the apps.", focus: "Automate deployment" });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The user's example board: two lead proposals (one running, one unstarted) and four user tasks, with
 * one worker slot so only the running proposal has a run. Returns the ids by role.
 */
function exampleBoard() {
  cmd("setWorkerLimit", { limit: 1 });
  const r = ask("plan the deployment work");
  claude.reply(r.id, "Two proposals.", [proposal({ title: "Deploy previews", priority: 4 }), proposal({ title: "Deploy health check", priority: 1 })]);
  tick();
  const [previews, health] = state().conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds!;
  cmd("startHeldTask", { taskId: health });
  tick(); // promoted and dispatched: P1 takes the only slot
  expect(M.activeAttempts(state(), health)).toHaveLength(1);
  const deploy = createTask("Automate deployment to Vercel", 2);
  const local = createTask("Run every app locally with one command", 5);
  const ci = createTask("CI deploy pipeline", 3);
  cmd("setPriority", { taskId: ci, priority: 3 }); // pinned by hand
  const untouched = createTask("Untouched user task", 4);
  tick(); // promoted to ready; nothing else dispatches
  for (const id of [deploy, local, ci, untouched]) expect(task(id).lifecycle).toBe("ready");
  return { previews, health, deploy, local, ci, untouched };
}

describe("A. the user's example, end to end", () => {
  it("one reply refocuses the team: focus, priorities, deferrals and a drop, each attributed and undoable; running work is never interrupted", () => {
    const b = exampleBoard();
    const order = () => state().tasks.filter((t) => ![b.local, b.ci].includes(t.id)).map((t) => t.id);
    const before = order();
    const r = ask(FOCUS_MSG);
    expect(r.visionRev).toBe(1);
    const focus = "Get every app building and running locally end to end; deployment automation waits.";
    claude.reply(r.id, "Refocusing on local builds.", [proposal({ title: "One-command local dev script", priority: 1 })], steer({ focus, tasks: [st.priority(b.local, 2), st.defer(b.deploy), st.priority(b.ci, 9), st.drop(b.previews), st.defer(b.health)] }));
    tick();
    const s = state();
    const set = lastSet();
    const msgs = s.conversation.filter((m) => m.author === "user");
    expect(M.currentVision(s)).toMatchObject({ rev: 2, author: "lead", text: "Ship the apps.", focus, source: { changeSetId: set.id, messageIds: [msgs[msgs.length - 1].id] } });
    expect(task(b.local).priority).toBe(2);
    expect(task(b.deploy).deferral).toMatchObject({ by: "lead", changeSetId: set.id });
    expect(M.column(s, task(b.deploy))).toBe("deferred");
    expect(task(b.ci).priority).toBe(3);
    expect(set.changes.find((c) => c.taskId === b.ci)).toMatchObject({ status: "suggested", note: "you set P3", before: 3, after: 9 });
    expect(task(b.previews)).toMatchObject({ lifecycle: "cancelled", cancelledBy: "lead", dropped: { changeSetId: set.id, lifecycle: "ready" } });
    expect(M.stateLabel(s, task(b.health))).toBe("Running · deferred after this step");
    expect(codex.interrupts).toEqual([]);
    expect(task(b.health).hold).toBe(false);
    expect(task(b.untouched).priority).toBe(4);
    expect(order().filter((id) => before.includes(id))).toEqual(before); // untouched tasks keep their order
    const reply = s.conversation.filter((m) => m.author === "lead").pop()!;
    expect(reply.changeSetId).toBe(set.id);
    expect(reply.proposedTaskIds).toHaveLength(1);
    expect(set.changes.map((c) => [c.kind, c.status])).toEqual([
      ["focus", "applied"],
      ["priority", "applied"],
      ["defer", "applied"],
      ["priority", "suggested"],
      ["drop", "applied"],
      ["defer", "applied"],
    ]);
    expect(set.changes[1]).toMatchObject({ before: 5, after: 2, appliedBy: "lead" });
    expect(s.events.filter((e) => e.actor === "lead" && e.message.includes(set.id)).length).toBeGreaterThanOrEqual(5);

    // 3. The running deployment step finishes: its result is accepted and nothing new starts on that task.
    const run = M.activeAttempts(s, b.health)[0];
    codex.finish(run.id, { write: ["health.js", "ok\n"] });
    tick();
    tick();
    expect(state().attempts.find((a) => a.id === run.id)!.outcome).toBe("completed");
    expect(M.activeAttempts(state(), b.health)).toHaveLength(0);
    expect(M.stateLabel(state(), task(b.health))).toBe("Deferred by lead");

    // 4. Everything survives a reopen of the store.
    const again = new Store(join(dir, "db.sqlite"));
    const persisted = again.read().state;
    again.close();
    expect(persisted.steering[0].id).toBe(set.id);
    expect(persisted.tasks.find((t) => t.id === b.deploy)!.deferral).toBeDefined();
    expect(persisted.tasks.find((t) => t.id === b.ci)!.userSet?.priority).toBeDefined();

    // 5. Undo all restores every value, reopens the drop, pins what was reversed, and the deferred task runs again.
    cmd("setWorkerLimit", { limit: 3 });
    const undo = cmd("undoSteering", { changeSetId: set.id }).result as M.UndoResult;
    expect(undo.left).toEqual([]);
    expect(undo.undone).toHaveLength(5);
    expect(M.currentVision(state())).toMatchObject({ rev: 3, author: "user", focus: "Automate deployment", source: { undoOf: set.id } });
    expect(task(b.local)).toMatchObject({ priority: 5, userSet: { priority: expect.any(String) } });
    expect(task(b.deploy).deferral).toBeUndefined();
    expect(task(b.deploy).userSet?.run).toBeDefined();
    expect(task(b.previews)).toMatchObject({ lifecycle: "ready", userSet: { run: expect.any(String) } });
    expect(task(b.health).deferral).toBeUndefined();
    tick();
    expect(M.activeAttempts(state(), b.health)).toHaveLength(1); // its next step started

    // 6. A later message that re-defers the same task now only suggests it.
    const r2 = ask("deployment can wait, honestly");
    claude.reply(r2.id, "As you say.", [], steer({ focus: undefined, tasks: [st.defer(b.deploy)] }));
    tick();
    expect(lastSet().changes).toEqual([expect.objectContaining({ kind: "defer", taskId: b.deploy, status: "suggested", note: "you asked it to keep running" })]);
    expect(task(b.deploy).deferral).toBeUndefined();
  });
});

describe("B. only runs that answer the user may steer", () => {
  it("a planning run's steering is refused and recorded, while its proposals are still created", () => {
    autonomy();
    tick();
    const r = leadRun()!;
    expect(r.trigger).toBe("planning");
    expect(claude.runs.get(r.id)!.prompt).toContain("Planning runs cannot steer");
    expect(claude.runs.get(r.id)!.prompt).not.toContain('"steer"');
    claude.reply(r.id, "Planning.", [proposal()], steer({ tasks: [] }));
    tick();
    expect(lastSet()).toMatchObject({ refused: "planning runs cannot steer", changes: [] });
    expect(M.currentVision(state()).rev).toBe(1);
    expect(state().tasks).toHaveLength(1);
  });

  it("22a: the gate is the messages a run answers, never its trigger", () => {
    cmd("postMessage", { text: FOCUS_MSG });
    const s0 = state();
    const started = M.startLeadRun(s0, { provider: "claude", model: "m", trigger: "planning" }, iso());
    expect(started.state.leadRuns[0].messageIds).toHaveLength(1);
    const done = M.completeLeadRun(started.state, started.runId, { reply: "ok", proposals: [], steer: steer({ focus: "Local first", tasks: [] }) }, iso());
    expect(done.steering[0].refused).toBeUndefined();
    expect(M.currentVision(done)).toMatchObject({ rev: 2, focus: "Local first" });
  });
});

describe("C/D. a message preempts planning", () => {
  it("stops the planning run, discards its late proposals, and answers the message on the next tick after the stop is confirmed", () => {
    autonomy();
    tick();
    const planning = leadRun()!;
    const plannedAt = state().project.lastPlanningAt;
    cmd("postMessage", { text: FOCUS_MSG });
    expect(leadRun()!.outcome).toBe("stopping");
    expect(status()).toMatchObject({ kind: "stopping-planning", text: "The planning run is stopping; the next lead run answers you." });
    tick();
    expect(claude.interrupts).toContain(planning.id);
    claude.reply(planning.id, "Late plan.", [proposal()]);
    tick();
    expect(state().tasks).toHaveLength(0);
    expect(state().leadRuns[0]).toMatchObject({ outcome: "stopped", note: expect.stringContaining("not applied") });
    claude.emit({ type: "stopped", attemptId: planning.id, how: "interrupted" });
    tick();
    const reply = leadRun()!;
    expect(reply.messageIds).toEqual([state().conversation[0].id]);
    expect(state().project.lastPlanningAt).toBe(plannedAt);
    expect(status()).toMatchObject({ kind: "working" });
  });

  it("an unacknowledged stop becomes a visible control failure; the message run starts once the stop arrives", () => {
    autonomy();
    tick();
    const planning = leadRun()!;
    cmd("postMessage", { text: FOCUS_MSG });
    for (let i = 0; i < 11; i++) tick();
    expect(state().leadRuns[0].note).toMatch(/^Control failure/);
    expect(leadRun()!.id).toBe(planning.id);
    expect(status().text).toMatch(/Control failure/);
    claude.emit({ type: "stopped", attemptId: planning.id, how: "interrupted" });
    tick(); // the stop is applied
    tick(); // the reply run starts
    expect(leadRun()!.messageIds).toHaveLength(1);
  });
});

describe("E/F. newer direction wins", () => {
  it("a second message during a reply queues; the reply's steering is held, and the next completed reply supersedes it", () => {
    const id = createTask("Automate deployment", 2);
    tick();
    const r1 = ask(FOCUS_MSG);
    cmd("postMessage", { text: "also, keep CI green" });
    expect(leadRun()!.id).toBe(r1.id);
    expect(status()).toMatchObject({ kind: "queued-behind-reply" });
    claude.reply(r1.id, "Refocusing.", [], steer({ tasks: [st.defer(id)] }));
    tick();
    const held = lastSet();
    expect(held.heldBecause).toMatch(/another message/);
    expect(held.changes.map((c) => c.status)).toEqual(["suggested", "suggested"]);
    expect(task(id).deferral).toBeUndefined();
    expect(M.currentVision(state()).rev).toBe(1);
    expect(claude.runs.get(r1.id)).toBeUndefined();
    tick();
    const r2 = leadRun()!;
    expect(claude.runs.get(r2.id)!.prompt).toContain("Held suggestions: re-issue the ones that still fit");
    claude.reply(r2.id, "Keeping CI; deferring deployment.", [], steer({ tasks: [st.defer(id)] }));
    tick();
    expect(state().steering[0].changes.map((c) => c.status)).toEqual(["superseded", "superseded"]);
    expect(task(id).deferral).toMatchObject({ by: "lead", changeSetId: lastSet().id });
  });

  it("Answer together now stops the reply; the new run answers both messages, and the late completion applies nothing", () => {
    const id = createTask("Automate deployment", 2);
    tick();
    const r1 = ask(FOCUS_MSG);
    cmd("postMessage", { text: "and one more thing" });
    cmd("stopLeadReply");
    expect(status(state().conversation[0])).toMatchObject({ kind: "restarting" });
    tick();
    expect(claude.interrupts).toContain(r1.id);
    claude.emit({ type: "stopped", attemptId: r1.id, how: "interrupted" });
    tick(); // the stop is applied
    tick(); // the new run starts
    const r2 = leadRun()!;
    expect(r2.messageIds).toHaveLength(2);
    claude.reply(r1.id, "late", [], steer({ tasks: [st.defer(id)] }));
    tick();
    expect(state().steering).toHaveLength(0);
    expect(task(id).deferral).toBeUndefined();
    expect(() => cmd("stopLeadReply")).not.toThrow(); // r2 is a reply run
  });

  it("race: a completion queued before a message commits is discarded (planning) or held (reply)", () => {
    autonomy();
    tick();
    const planning = leadRun()!;
    claude.reply(planning.id, "plan", [proposal()]);
    cmd("postMessage", { text: FOCUS_MSG });
    tick();
    expect(state().tasks).toHaveLength(0);
    claude.emit({ type: "stopped", attemptId: planning.id, how: "interrupted" });
    tick();
    const reply = leadRun()!;
    claude.reply(reply.id, "ok", [], steer({ tasks: [] }));
    cmd("postMessage", { text: "wait" });
    tick();
    expect(lastSet().heldBecause).toMatch(/another message/);
    expect(lastSet().changes[0]).toMatchObject({ kind: "focus", status: "suggested" });
    expect(M.currentVision(state()).rev).toBe(1);
  });
});

describe("G. the user edits during the run", () => {
  it("a priority the user set meanwhile turns the lead's row into a suggestion; a vision edit rejects the focus and holds the set, proposals still land", () => {
    const id = createTask("Deploy", 2);
    tick();
    const r = ask(FOCUS_MSG);
    cmd("setPriority", { taskId: id, priority: 7 });
    claude.reply(r.id, "ok", [], steer({ focus: undefined, tasks: [st.priority(id, 1)] }));
    tick();
    expect(lastSet().changes).toEqual([expect.objectContaining({ status: "suggested", note: "you set P7", before: 7, after: 1 })]);
    expect(task(id).priority).toBe(7);
    const r2 = ask("more");
    cmd("editVision", { expectedRev: 1, text: "Ship the apps.", focus: "My own focus", reason: "hand edit" });
    claude.reply(r2.id, "ok", [proposal({ title: "Still proposed" })], steer({ tasks: [st.defer(id)] }));
    tick();
    const set = lastSet();
    expect(set.heldBecause).toMatch(/edited the vision/);
    expect(set.changes[0]).toMatchObject({ kind: "focus", status: "rejected", note: "you edited the vision (now r2); your edit stands" });
    expect(set.changes[1]).toMatchObject({ kind: "defer", status: "suggested" });
    expect(state().tasks.some((t) => M.currentSpec(t).content.title === "Still proposed")).toBe(true);
  });
});

describe("H. modes and idempotent controls", () => {
  it("only suggest: nothing changes; Apply is replayed by key and refused with different arguments; Dismiss reaches the next envelope; apply-own splits by author", () => {
    cmd("setSteeringMode", { mode: "suggest" });
    const mine = createTask("Deploy", 2);
    const r = ask("plan");
    claude.reply(r.id, "ok", [proposal({ title: "Lead's own", priority: 4 })]);
    tick();
    const own = state().conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds![0];
    const r2 = ask(FOCUS_MSG);
    expect(claude.runs.get(r2.id)!.prompt).toContain("Steering mode: suggest");
    claude.reply(r2.id, "ok", [], steer({ tasks: [st.priority(mine, 1), st.drop(own)] }));
    tick();
    const set = lastSet();
    expect(set.mode).toBe("suggest");
    expect(set.changes.every((c) => c.status === "suggested" && c.note === "only suggest (Settings)")).toBe(true);
    expect(task(mine).priority).toBe(2);
    expect(task(own).lifecycle).toBe("ready");
    const first = cmd("applySteering", { changeSetId: set.id, changeId: set.changes[1].id }, "apply-once");
    expect((first.result as M.ApplyResult).applied).toEqual([set.changes[1].id]);
    expect(task(mine).priority).toBe(1);
    expect(task(mine).userSet?.priority).toBeDefined();
    const replay = cmd("applySteering", { changeSetId: set.id, changeId: set.changes[1].id }, "apply-once");
    expect(replay).toMatchObject({ replayed: true, result: first.result });
    expect(() => cmd("applySteering", { changeSetId: set.id }, "apply-once")).toThrow(/different command/);
    cmd("dismissSteering", { changeSetId: set.id, changeId: set.changes[2].id });
    expect(lastSet().changes[2].status).toBe("dismissed");
    const r3 = ask("status?");
    expect(claude.runs.get(r3.id)!.prompt).toMatch(new RegExp(`${set.changes[2].id}.*dismissed`));
    expect(claude.runs.get(r3.id)!.prompt).toMatch(new RegExp(`${set.changes[1].id}.*applied by the user`));
    claude.reply(r3.id, "fine");
    tick();
    cmd("setSteeringMode", { mode: "apply-own" });
    const r4 = ask(FOCUS_MSG);
    claude.reply(r4.id, "ok", [], steer({ focus: undefined, tasks: [st.defer(mine), st.drop(own)] }));
    tick();
    expect(lastSet().changes.map((c) => [c.status, c.note])).toEqual([
      ["suggested", "your task: suggest-only (Settings)"],
      ["applied", undefined],
    ]);
    expect(task(own).lifecycle).toBe("cancelled");
  });
});

describe("I/J. the dependency guard and children", () => {
  it("a prerequisite of an open task is kept; deferring both in either order applies both", () => {
    const r = ask("plan");
    claude.reply(r.id, "ok", [proposal({ title: "Prereq A" })]);
    tick();
    const a = state().conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds![0];
    const b = createTask("Dependent B", 3);
    edit((s) => {
      s.tasks.find((t) => t.id === b)!.dependsOn = [a];
    });
    const r2 = ask(FOCUS_MSG);
    claude.reply(r2.id, "ok", [], steer({ focus: undefined, tasks: [st.drop(a)] }));
    tick();
    expect(lastSet().changes[0]).toMatchObject({ status: "skipped", note: `kept: ${b} depends on it` });
    expect(M.column(state(), task(b))).not.toBe("blocked");
    for (const order of [
      [st.defer(b), st.defer(a)],
      [st.defer(a), st.defer(b)],
    ]) {
      const rr = ask("defer both");
      claude.reply(rr.id, "ok", [], steer({ focus: undefined, tasks: order }));
      tick();
      expect(lastSet().changes.map((c) => c.status)).toEqual(["applied", "applied"]);
      cmd("undoSteering", { changeSetId: lastSet().id });
      expect(task(a).deferral).toBeUndefined();
      cmd("setRunPin", { taskId: a, pinned: false });
      cmd("setRunPin", { taskId: b, pinned: false });
    }
  });

  it("deferring a root defers its children without writing to them; a child id is rejected with the root to steer", () => {
    cmd("setWorkerLimit", { limit: 1 });
    const filler = createTask("Filler", 1);
    tick(); // the filler takes the only slot
    const fillerRun = M.activeAttempts(state(), filler)[0];
    const root = createTask("Root", 2);
    const child = createTask("Child", 3);
    edit((s) => {
      const c = s.tasks.find((t) => t.id === child)!;
      c.parentTaskId = root;
      const p = s.tasks.find((t) => t.id === root)!;
      p.steps[0].waitForChildren = true;
    });
    tick(); // promoted; nothing dispatches
    const before = JSON.stringify(task(child));
    const r = ask(FOCUS_MSG);
    claude.reply(r.id, "ok", [], steer({ focus: undefined, tasks: [st.defer(root), st.priority(child, 1)] }));
    tick();
    expect(lastSet().changes.map((c) => [c.status, c.note])).toEqual([
      ["applied", undefined],
      ["rejected", `child of ${root}: steer ${root}`],
    ]);
    codex.finish(fillerRun.id, { write: ["f.txt", "f\n"] });
    tick();
    tick();
    expect(M.activeAttempts(state(), child)).toHaveLength(0);
    expect(M.stateLabel(state(), task(child))).toBe(`Deferred with ${root}`);
    expect(JSON.stringify(task(child))).toBe(before);
  });
});

describe("L/M/O/Q. drops, undo idempotency, untrusted output, duplicate events", () => {
  it("a dropped title is not proposed again for a week; after Undo it is a duplicate as before", () => {
    const r = ask("plan");
    claude.reply(r.id, "ok", [proposal({ title: "Deploy previews" })]);
    tick();
    const id = state().conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds![0];
    const r2 = ask(FOCUS_MSG);
    claude.reply(r2.id, "ok", [], steer({ tasks: [st.drop(id)] }));
    tick();
    autonomy({ maxOpenProposals: 10 });
    tick();
    const planning = leadRun()!;
    expect(claude.runs.get(planning.id)!.prompt).toMatch(/Deploy previews.*dropped by the lead on 2026-09-29; the user can restore it; do not re-propose/);
    claude.reply(planning.id, "again", [proposal({ title: "Deploy previews" })]);
    tick();
    expect(state().conversation.filter((m) => m.author === "lead").pop()!.rejected![0]).toMatch(/dropped when the focus changed on 2026-09-29; the user can restore it/);
    cmd("undoSteering", { changeSetId: state().steering[0].id });
    expect(task(id).lifecycle).toBe("ready");
    const r3 = ask("propose it again please");
    claude.reply(r3.id, "ok", [proposal({ title: "Deploy previews" })]);
    tick();
    expect(state().conversation.filter((m) => m.author === "lead").pop()!.rejected![0]).toMatch(/already exists/);
  });

  it("undo is compare-and-set and a repeat reports already undone; invalid items are rejected one by one; a reply without JSON changes nothing", () => {
    const id = createTask("Deploy", 5);
    const done = createTask("Finished", 6);
    edit((s) => {
      s.tasks.find((t) => t.id === done)!.lifecycle = "done";
    });
    const r = ask(FOCUS_MSG);
    claude.reply(
      r.id,
      "ok",
      [],
      steer({
        focus: "x".repeat(501),
        tasks: [
          st.priority(id, 1),
          { id: "T-999", defer: true },
          st.priority(done, 2),
          { id: id, defer: true },
          { id: "a", priority: 0 },
          { id: "a", priority: 100 },
          { id: "b", priority: 2.5 },
          { id: "c", priority: "1" },
          { id: "d", priority: 1, defer: true },
          { id: "e", defer: true, why: "w".repeat(400) },
        ],
      }),
    );
    tick();
    const set = lastSet();
    expect(set.changes.map((c) => [c.status, c.note])).toEqual([
      ["rejected", "focus must be 1–500 characters"],
      ["applied", undefined],
      ["rejected", "unknown task"],
      ["rejected", `${done} is done`],
      ["rejected", "one change per task per reply"],
      ["rejected", "priority must be a whole number 1–99"],
      ["rejected", "priority must be a whole number 1–99"],
      ["rejected", "priority must be a whole number 1–99"],
      ["rejected", "priority must be a whole number 1–99"],
      ["rejected", "give exactly one of priority, defer, drop"],
      ["rejected", "why must be text of at most 300 characters"],
    ]);
    expect(task(id).priority).toBe(1);
    cmd("setPriority", { taskId: id, priority: 2 });
    const u = cmd("undoSteering", { changeSetId: set.id }).result as M.UndoResult;
    expect(u).toEqual({ undone: [], left: [{ id: set.changes[1].id, why: "you changed it since (now P2)" }] });
    expect(task(id).priority).toBe(2);
    cmd("setPriority", { taskId: id, priority: 1 });
    edit((s) => {
      delete s.tasks.find((t) => t.id === id)!.userSet;
    });
    expect((cmd("undoSteering", { changeSetId: set.id, changeId: set.changes[1].id }).result as M.UndoResult).undone).toEqual([set.changes[1].id]);
    expect((cmd("undoSteering", { changeSetId: set.id, changeId: set.changes[1].id }).result as M.UndoResult).left).toEqual([{ id: set.changes[1].id, why: "already undone" }]);
    const r2 = ask("hello?");
    claude.replyText(r2.id, "Just prose, no block.");
    tick();
    expect(state().leadRuns.find((x) => x.id === r2.id)!.note).toMatch(/no JSON block/);
    expect(state().conversation.filter((m) => m.author === "lead").pop()!.rejected).toEqual(["The reply had no machine-readable block, so nothing was changed."]);
    expect(state().steering).toHaveLength(1);
  });

  it("a duplicate completion produces one set and one message; a completion after a stop request applies nothing", () => {
    const id = createTask("Deploy", 5);
    const r = ask(FOCUS_MSG);
    claude.reply(r.id, "ok", [], steer({ tasks: [st.defer(id)] }));
    claude.reply(r.id, "ok", [], steer({ tasks: [st.defer(id)] }));
    tick();
    expect(state().steering).toHaveLength(1);
    expect(state().conversation.filter((m) => m.author === "lead")).toHaveLength(1);
    cmd("undoSteering", { changeSetId: lastSet().id });
    cmd("setRunPin", { taskId: id, pinned: false });
    const r2 = ask("again");
    cmd("pauseProject");
    claude.reply(r2.id, "late", [], steer({ tasks: [st.defer(id)] }));
    tick();
    // Review finding 16: the note must say the steering, not only the proposals, was not applied.
    expect(state().leadRuns.find((x) => x.id === r2.id)).toMatchObject({ outcome: "stopped", note: expect.stringMatching(/^Finished after a stop request; its proposals and steering were not applied\./) });
    expect(state().steering).toHaveLength(1);
    expect(task(id).deferral).toBeUndefined();
  });
});

describe("P. caps with deferral", () => {
  it("deferred lead work does not block planning for the new focus, but is bounded separately", () => {
    autonomy({ maxOpenProposals: 2, maxProposalsPerCycle: 2 });
    tick();
    const p = leadRun()!;
    claude.reply(p.id, "two", [proposal({ title: "One" }), proposal({ title: "Two" })]);
    tick();
    const ids = state().conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds!;
    tick(2 * 60 * 60_000);
    expect(leadRun()).toBeUndefined(); // at the cap
    const r = ask(FOCUS_MSG);
    claude.reply(r.id, "ok", [], steer({ tasks: [st.defer(ids[0])] }));
    tick();
    expect(M.openLeadProposals(state())).toHaveLength(1);
    tick(2 * 60 * 60_000);
    expect(leadRun()!.trigger).toBe("planning"); // room again
    claude.reply(leadRun()!.id, "one more", [proposal({ title: "Three" })]);
    tick();
    const r2 = ask("defer more");
    claude.reply(r2.id, "ok", [], steer({ focus: undefined, tasks: [st.defer(ids[1])] }));
    tick();
    expect(M.deferredLeadRoots(state())).toHaveLength(2);
    tick(2 * 60 * 60_000);
    expect(leadRun()).toBeUndefined(); // deferred lead roots reached the cap: planning refused
  });
});

describe("R/S. restart and migration", () => {
  it("a lead run lost to a restart applies nothing; its messages stay pending", async () => {
    const r = ask(FOCUS_MSG);
    const claude2 = new ScriptedAdapter("claude");
    const codex2 = new ScriptedAdapter("codex");
    const s2 = new Scheduler(store, { claude: claude2, codex: codex2 }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000 });
    await s2.refreshHealth();
    await scheduler.stop();
    now += 1000;
    s2.tick(now);
    expect(state().leadRuns.find((x) => x.id === r.id)!.outcome).toBe("lost");
    expect(state().steering).toHaveLength(0);
    expect(M.pendingMessages(state())).toHaveLength(1);
    await s2.stop();
  });

  it("a format-10 database migrates to 11: pins from the user's priority events, and an old run cannot steer", () => {
    const path = join(dir, "old.sqlite");
    const seeded = new Store(path);
    seeded.close();
    const raw = new DatabaseSync(path);
    const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json);
    delete doc.steering;
    delete doc.project.steeringMode;
    doc.version = 10;
    doc.events.push({ id: "ev-old", at: "2026-09-01T00:00:00.000Z", actor: "user", kind: "control", taskId: "EX-002", message: "Priority P3 → P1" });
    doc.conversation.push({ id: "msg-old", at: "2026-09-01T00:00:00.000Z", author: "user", text: "hello" });
    doc.leadRuns.push({ id: "lead-old", trigger: "message", provider: "claude", model: "m", startedAt: "2026-09-01T00:00:00.000Z", outcome: "running", messageIds: ["msg-old"] });
    raw.prepare("UPDATE state SET format = 10, json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    // ORC-012 raised the format to 12 and ORC-014 to 13; a format-10 document upgrades through each.
    expect(STATE_FORMAT).toBe(15);
    expect(s.version).toBe(15);
    expect(s.steering).toEqual([]);
    expect(s.project.steeringMode).toBe("apply");
    expect(s.tasks.find((t) => t.id === "EX-002")!.userSet).toEqual({ priority: "2026-09-01T00:00:00.000Z" });
    expect(s.tasks.find((t) => t.id === "EX-003")!.userSet).toBeUndefined();
    const done = M.completeLeadRun(s, "lead-old", { reply: "late", proposals: [], steer: steer({ tasks: [] }) }, iso());
    expect(done.steering[0].refused).toBe("started before steering existed");
    upgraded.close();
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_10_%'").get()).toBeDefined();
    check.close();
  });
});

describe("T/U. the envelope and provider neutrality", () => {
  it("lists open work first with the exact permissions, focus history, recent steering, the message's task, and the mode; planning gets no contract", () => {
    for (let i = 0; i < 70; i++) createTask(`Done ${i}`, 50);
    edit((s) => {
      for (const t of s.tasks) {
        t.lifecycle = "done";
        t.integration = { status: "not-needed" };
      }
    });
    const a = createTask("Open A", 1);
    const b = createTask("Open B", 2);
    cmd("setPriority", { taskId: b, priority: 2 });
    const c = createTask("Open C", 3);
    tick();
    const r = ask(FOCUS_MSG);
    claude.reply(r.id, "ok", [], steer({ tasks: [st.priority(a, 4), st.defer(c)] }));
    tick();
    const set = lastSet();
    cmd("undoSteering", { changeSetId: set.id, changeId: set.changes[0].id }); // the focus: r3 by the user
    cmd("undoSteering", { changeSetId: set.id, changeId: set.changes[2].id }); // the deferral of C
    cmd("setSteeringMode", { mode: "suggest" });
    const r2 = ask("and now?", { taskId: c });
    claude.reply(r2.id, "ok", [], steer({ focus: undefined, tasks: [st.priority(b, 1)] }));
    tick();
    const set2 = lastSet();
    expect(set2.changes).toEqual([expect.objectContaining({ kind: "priority", taskId: b, status: "suggested" })]);
    cmd("dismissSteering", { changeSetId: set2.id });
    cmd("postMessage", { text: "hold on", taskId: a });
    const s = M.startLeadRun(state(), { provider: "claude", model: "m", trigger: "message" }, iso()).state;
    const text = buildLeadEnvelope(s, M.activeLeadRun(s)!, "read");
    const open = text.indexOf("## Open work");
    const finished = text.indexOf("## Recently finished");
    expect(open).toBeGreaterThan(0);
    expect(text.slice(open, finished)).toContain(`- ${a} [`);
    expect(text.slice(open, finished)).toContain(`P2 (set by you) "Open B"`);
    expect(text.slice(open, finished)).not.toContain("Done 1");
    for (const t of [a, b, c]) {
      const line = text.split("\n").find((l) => l.startsWith(`- ${t} [`))!;
      for (const action of ["priority", "defer", "undefer", "drop"] as const) {
        const v = M.steerPermission(s, s.tasks.find((x) => x.id === t), action, s.project.steeringMode);
        if (v.v === "apply") expect(line).toMatch(new RegExp(`may: [^·]*\\b${action}\\b`));
        else if (v.v === "suggest") expect(line).toMatch(new RegExp(`suggest: [^·]*\\b${action}\\b`));
        else if (v.v === "skip" || v.v === "reject") expect(line).toMatch(new RegExp(`not: [^·]*${action} \\(${v.why.replace(/[()]/g, "\\$&")}\\)`));
      }
    }
    expect(text).toContain("Steering mode: suggest");
    expect(text).toContain("Focus history (newest first):");
    expect(text).toMatch(/r2 by lead \(the user's message msg-/);
    expect(text).toMatch(/r3 by user \(undo of cs-/);
    expect(text).toMatch(new RegExp(`${set.changes[2].id}.*deferred — undone by the user`));
    // Review finding 16: the rules text always contains the word "dismissed"; assert the dismissed row itself.
    expect(text).toMatch(new RegExp(`- ${set2.changes[0].id.replace(/\\./g, "\\.")} \\(.*\\): ${b} P2 → P1 — dismissed`));
    expect(text.split("\n").filter((l) => l.includes(" — dismissed"))).toHaveLength(1);
    expect(text).toContain(`(sent from ${a} "Open A"`);
    expect(text).toContain('"steer": {');
    expect(text).toContain("## Steering rules");
    const planning = buildLeadEnvelope({ ...s, leadRuns: [] }, { ...M.activeLeadRun(s)!, trigger: "planning", messageIds: [] }, "read");
    expect(planning).toContain("Planning runs cannot steer");
    expect(planning).not.toContain('"steer": {');
    expect(planning).not.toContain("Steering mode:");
  });

  it.each(["claude", "codex"] as const)("a %s lead produces the same change set", (provider) => {
    cmd("setLeadSelection", { selection: { provider, model: `${provider}-sample-large` } });
    const id = createTask("Deploy", 5);
    const other = createTask("Docs", 6);
    tick();
    const r = ask(FOCUS_MSG);
    expect(r.provider).toBe(provider);
    (provider === "claude" ? claude : codex).reply(r.id, "ok", [], steer({ tasks: [st.priority(id, 1), st.defer(other), st.drop("nope")] }));
    tick();
    const set = lastSet();
    expect(set.changes.map((c) => ({ kind: c.kind, taskId: c.taskId, before: c.before, after: c.after, status: c.status, note: c.note }))).toEqual([
      { kind: "focus", taskId: undefined, before: "Automate deployment", after: "Get every app building and running locally end to end; deployment automation waits.", status: "applied", note: undefined },
      { kind: "priority", taskId: id, before: 5, after: 1, status: "applied", note: undefined },
      { kind: "defer", taskId: other, before: null, after: { by: "lead", at: expect.any(String), reason: "no longer fits the focus", changeSetId: set.id }, status: "applied", note: undefined },
      { kind: "drop", taskId: "nope", before: null, after: "cancelled", status: "rejected", note: "unknown task" },
    ]);
  });
});

describe("R1. independent review findings (service)", () => {
  it("1: the open-work board leaves out the service's review and fix tasks, and steering them is rejected", () => {
    const a = createTask("Open A", 1);
    const rv = createTask("Review of A's pull request", 1);
    const fx = createTask("Fix for A's pull request", 1);
    edit((s) => {
      s.tasks.find((t) => t.id === rv)!.reviewTarget = { taskId: a, n: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40) };
      s.tasks.find((t) => t.id === fx)!.deliverInto = { taskId: a, n: 1, mergeBase: false };
    });
    tick();
    const r = ask(FOCUS_MSG);
    const prompt = claude.runs.get(r.id)!.prompt;
    const open = prompt.slice(prompt.indexOf("## Open work"), prompt.indexOf("## Recently finished"));
    expect(open).toContain(`- ${a} [`);
    expect(open).not.toContain(`- ${rv} [`);
    expect(open).not.toContain(`- ${fx} [`);
    claude.reply(r.id, "ok", [], steer({ focus: undefined, tasks: [st.defer(rv), st.priority(fx, 9), st.defer(a)] }));
    tick();
    expect(lastSet().changes.map((c) => [c.taskId, c.status, c.note])).toEqual([
      [rv, "rejected", "delivery task: not steerable"],
      [fx, "rejected", "delivery task: not steerable"],
      [a, "applied", undefined],
    ]);
    expect(task(rv).deferral).toBeUndefined();
    expect(task(fx).priority).toBe(1);
  });
});

describe("R1. independent review findings (low, service)", () => {
  it("15: a message run cannot propose past the bound on deferred lead work either", () => {
    autonomy({ maxOpenProposals: 1, maxProposalsPerCycle: 2 });
    tick();
    const p = leadRun()!;
    claude.reply(p.id, "one", [proposal({ title: "One" })]);
    tick();
    const [one] = state().conversation.filter((m) => m.author === "lead").pop()!.proposedTaskIds!;
    const r = ask(FOCUS_MSG);
    claude.reply(r.id, "ok", [proposal({ title: "Two" })], steer({ tasks: [st.defer(one)] }));
    tick();
    expect(M.deferredLeadRoots(state())).toHaveLength(1);
    expect(state().conversation.filter((m) => m.author === "lead").pop()!.rejected).toEqual([expect.stringMatching(/^"Two": 1 deferred lead proposals reached the limit of 1; drop those that no longer fit first$/)]);
    expect(state().tasks.some((t) => M.currentSpec(t).content.title === "Two")).toBe(false);
  });
});
