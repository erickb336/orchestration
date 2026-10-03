// The demo in the fake service. It loads through the store at the current format; after start
// and a few scheduler cycles three agents work at the worker limit, WT-005's pull request is held for you
// on the simulated GitHub, the landed items stay in the review-later list, the paused task stays paused;
// and the simulated flag comes from the fake runtime, never from a scripted (real) lead.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as D from "../src/domain/delivery";
import { DEMO_DOC_HASH, DEMO_DOC_TEXT, buildDemo } from "../src/domain/demo";
import * as M from "../src/domain/model";
import { budgetStop, buildingSpend } from "../src/domain/spend";
import type { State } from "../src/domain/types";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { STATE_FORMAT, Store } from "./store";
import { ScriptedAdapter, steer } from "./testing/scripted";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let path: string;
const opened: { close(): void | Promise<void> }[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-demo-"));
  path = join(dir, "demo.db");
});
afterEach(async () => {
  // Newest first: a scheduler stops (and releases its lease) before its store closes.
  for (const o of opened.splice(0).reverse()) {
    try {
      await o.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function openDemo() {
  const store = new Store(path, () => buildDemo(T0));
  opened.push(store);
  return store;
}

const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const active = (s: State) => M.activeAgentAttempts(s).map((a) => `${a.taskId} ${a.stepId} ${a.snapshot.provider}`);

describe("the demo in the fake service", () => {
  it("loads through the store at the current format; no migration touches it", () => {
    const store = openDemo();
    const { state } = store.read();
    expect(state).toEqual(JSON.parse(JSON.stringify(buildDemo(T0))));
    store.close();
    const raw = new DatabaseSync(path);
    expect((raw.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(STATE_FORMAT);
    expect(raw.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_%'").all()).toEqual([]);
    raw.close();
    // Opening it again applies no migration and changes nothing.
    const again = new Store(path);
    opened.push(again);
    expect(again.read().state).toEqual(state);
  });

  it("the vision document's hash names its text", () => {
    expect(createHash("sha256").update(Buffer.from(DEMO_DOC_TEXT, "utf8")).digest("hex")).toBe(DEMO_DOC_HASH);
    expect(buildDemo(T0).project.visionDocs[0].hash).toBe(DEMO_DOC_HASH);
  });

  it("after start: three agents at the worker limit, the pull request held for you, landed items kept, the paused task paused, WT-003 next", async () => {
    const store = openDemo();
    const config = { ...defaultFakeConfig(), ackDelayMs: 2000 };
    const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) }, { leaseMs: 5000, ackTimeoutMs: 6000 });
    opened.push({ close: () => scheduler.stop() });
    let now = T0 + 1000;
    const tick = async (ms = 1000) => {
      now += ms;
      scheduler.tick(now);
      await scheduler.prIdle();
      const s = store.read().state;
      expect(M.activeAgentAttempts(s).length).toBeLessThanOrEqual(s.project.workerLimit);
      return s;
    };
    const before = store.read().state;
    let s = await tick();
    // Reconciliation found nothing to mark lost: no run was in flight. The scheduler dispatched the three.
    expect(s.attempts.filter((a) => a.outcome === "lost")).toEqual([]);
    expect(active(s)).toEqual(["WT-002 S1 codex", "WT-004.2 S1 claude", "WT-007 S3 claude"]);
    expect(M.column(s, task(s, "WT-007"))).toBe("reviewing");
    for (const id of ["WT-003", "WT-006", "WT-009", "WT-010", "WT-004.3"]) expect(M.activeAttempts(s, id), id).toEqual([]);
    // The lead's note in the story reached WT-005's coder while it ran; the start changes nothing about it and binds no other.
    expect(s.notes).toEqual(before.notes);
    expect(s.notes[0]).toMatchObject({ taskId: "WT-005", stepId: "S1", status: "delivered", via: "live", simulated: true });
    // The pull request of WT-005 is published on the simulated GitHub and observed: open, checks passed, held for you.
    for (let i = 0; i < 12 && !D.prReady(store.read().state, task(store.read().state, "WT-005"), now); i++) s = await tick();
    const pr = task(s, "WT-005").integration!.pr!;
    expect(pr).toMatchObject({ phase: "open", simulated: true, number: 1000, policy: "hold", url: "simulated://pr/1000" });
    expect(pr.attention).toBeUndefined();
    expect(D.prReady(s, task(s, "WT-005"), now)).toBe(true);
    // The chip's text carries no "(simulated)" suffix; the label's flag puts one small chip beside it.
    expect(D.prLabel(s, task(s, "WT-005"), now)).toEqual({ text: "PR #1000 ready to merge", tone: "strong", simulated: true });
    const gate = D.prGate(s, task(s, "WT-005"), now, { byUser: true });
    expect(gate.items.filter((i) => !i.ok).map((i) => i.id)).toEqual(["policy"]);
    expect(gate.items.find((i) => i.id === "review")).toMatchObject({ ok: true });
    expect(gate.items.find((i) => i.id === "service-checks")).toMatchObject({ ok: true });
    // Nothing was added for it: no dedicated review, no dedicated check run; and nothing else changed its state.
    expect(s.tasks.map((t) => t.id)).toEqual(before.tasks.map((t) => t.id));
    // Landed work stays in the review-later list as it was.
    expect(D.landedTasks(s).map((t) => `${t.id}:${t.integration!.landed!.status}`)).toEqual(["WT-011:unreviewed", "WT-001:unreviewed", "WT-004.1:reviewed", "WT-008:reviewed"]);
    for (const id of ["WT-001", "WT-004.1", "WT-008", "WT-011"]) expect(task(s, id).integration!.pr!.phase, id).toBe("merged");
    // The paused task stays paused with its acknowledged stop; the deferred one stays deferred.
    expect(M.stateLabel(s, task(s, "WT-009"))).toBe("Paused");
    expect(s.attempts.filter((a) => a.taskId === "WT-009").map((a) => a.outcome)).toEqual(["completed", "stopped"]);
    expect(M.stateLabel(s, task(s, "WT-010"))).toBe("Deferred by lead");
    // Pause WT-002: the runtime acknowledges, the freed slot goes to WT-007's security review on Claude, the next in line.
    store.command("pauseTask", { taskId: "WT-002" }, "k-pause", iso(now));
    for (let i = 0; i < 6 && !M.activeAttempts(store.read().state, "WT-007").some((a) => a.stepId === "SR1"); i++) s = await tick();
    expect(M.stateLabel(s, task(s, "WT-002"))).toBe("Paused");
    expect(M.activeAttempts(s, "WT-007").map((a) => `${a.stepId} ${a.snapshot.provider}`)).toEqual(["S3 claude", "SR1 claude"]);
    expect(M.activeAttempts(s, "WT-003")).toEqual([]);
    // The lead answers in the demo (a simulated run advances a few percent per tick): a steer from the fake
    // runtime carries the structured simulated flag, and no prefix.
    store.command("postMessage", { text: "Focus on offline maps" }, "k-msg", iso(now));
    for (let i = 0; i < 40 && store.read().state.steering.length < 2; i++) s = await tick();
    const set = s.steering[1];
    expect(set.simulated).toBe(true);
    expect(set.refused).toBeUndefined();
    expect(set.changes.find((c) => c.kind === "focus")).toMatchObject({ status: "applied", after: "Focus on offline maps" });
    const v = M.currentVision(s);
    expect(v).toMatchObject({ rev: 3, author: "lead", focus: "Focus on offline maps", simulated: true });
    expect(M.currentFocusChange(s)?.set.id).toBe(set.id);
    expect(s.conversation[s.conversation.length - 1].text).not.toMatch(/\(Simulated/);
  });

  it("simulated work never counts toward a building budget: the lead's replies, and runs the service lost at a restart (ORC-030 QA, Q-12 and Q-23)", async () => {
    const store = openDemo();
    store.command("setBudgets", { buildingUsd: 0.01, maintenanceUsdPerMonth: null }, "k-budget", iso(T0));
    const adapters = () => ({ claude: new FakeAdapter("claude", defaultFakeConfig()), codex: new FakeAdapter("codex", defaultFakeConfig()) });
    const first = new Scheduler(store, adapters(), { leaseMs: 5000, ackTimeoutMs: 6000 });
    let now = T0 + 1000;
    first.tick(now);
    store.command("postMessage", { text: "What needs me?" }, "k-msg", iso(now));
    for (let i = 0; i < 40 && !store.read().state.leadRuns.some((r) => r.outcome === "completed" && r.messageIds.length); i++) first.tick((now += 1000));
    expect(store.read().state.leadRuns.at(-1)).toMatchObject({ outcome: "completed", simulated: true });
    expect(M.activeAgentAttempts(store.read().state).length).toBeGreaterThan(0);
    await first.stop();
    // The service starts again: its fake runtime has no process for the runs in flight, so they are lost.
    const second = new Scheduler(store, adapters(), { leaseMs: 5000, ackTimeoutMs: 6000 });
    opened.push({ close: () => second.stop() });
    second.tick((now += 6000));
    const s = store.read().state;
    expect(s.attempts.filter((a) => a.outcome === "lost").length).toBeGreaterThan(0);
    expect(buildingSpend(s)).toMatchObject({ usd: 0, unknown: [] });
    expect(budgetStop(s)).toBeUndefined();
  });

  it("a scripted (real) lead's steering carries no simulated flag", async () => {
    const store = openDemo();
    const claude = new ScriptedAdapter("claude");
    const codex = new ScriptedAdapter("codex");
    const scheduler = new Scheduler(store, { claude, codex }, { leaseMs: 5000, ackTimeoutMs: 6000 });
    opened.push({ close: () => scheduler.stop() });
    await scheduler.refreshHealth();
    let now = T0 + 1000;
    store.command("postMessage", { text: "Packing lists first, please" }, "k-msg", iso(now));
    scheduler.tick((now += 1000));
    const run = M.activeLeadRun(store.read().state)!;
    expect(run.provider).toBe("claude");
    claude.reply(run.id, "Shifting the focus to packing lists.", [], steer({ focus: "Packing lists first.", reason: "You asked.", tasks: [] }));
    scheduler.tick((now += 1000));
    const s = store.read().state;
    const set = s.steering[1];
    expect(set.changes.find((c) => c.kind === "focus")).toMatchObject({ status: "applied" });
    expect(set.simulated).toBeUndefined();
    expect(M.currentVision(s)).toMatchObject({ rev: 3, author: "lead", focus: "Packing lists first." });
    expect(M.currentVision(s).simulated).toBeUndefined();
  });

  it("Reset sample data restores the demo through the store", () => {
    const store = openDemo();
    store.command("pauseTask", { taskId: "WT-002" }, "k1", iso(T0 + 1000));
    store.command("markLandedReviewed", { taskIds: ["WT-001"], reviewed: true }, "k2", iso(T0 + 2000));
    expect(D.unreviewedCount(store.read().state)).toBe(1);
    store.command("resetSampleData", {}, "k3", iso(T0 + 3000));
    const s = store.read().state;
    expect(s.project.name).toBe("Weekend Trips (sample)");
    expect(task(s, "WT-002").hold).toBe(false);
    expect(D.unreviewedCount(s)).toBe(2);
    expect(s.tasks.map((t) => t.id)).toEqual(buildDemo(T0).tasks.map((t) => t.id));
  });
});
