import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_HEADER } from "../src/api";
import * as M from "../src/domain/model";
import type { State } from "../src/domain/types";
import { FakeAdapter, defaultFakeConfig, type FakeRuntimeConfig } from "./runtimes/fake";
import { createHttpServer } from "./http";
import { Scheduler } from "./scheduler";
import { CommandFailure, STATE_FORMAT, Store } from "./store";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response) => r.json() as Promise<any>;
/** Fake adapters for both providers sharing one simulation config, plus aggregate views for assertions. */
function fakes(cfg: Partial<FakeRuntimeConfig> = {}) {
  const config = { ...defaultFakeConfig(), ...cfg };
  const claude = new FakeAdapter("claude", config);
  const codex = new FakeAdapter("codex", config);
  const runtime = {
    size: () => claude.size() + codex.size(),
    ids: () => [...claude.ids(), ...codex.ids()],
    status: (id: string) => (claude.has(id) ? claude.status(id) : codex.status(id)),
  };
  return { adapters: { claude, codex }, runtime, config };
}

const T0 = Date.parse("2026-09-29T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let dbPath: string;
const opened: Store[] = [];
function open() {
  const s = new Store(dbPath);
  opened.push(s);
  return s;
}
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
let key = 0;
const k = () => `k-${++key}`;

/** Invariant from the spec: never more than one active attempt per step. */
function assertOneActivePerStep(s: State) {
  const seen = new Set<string>();
  for (const a of M.activeAttempts(s)) {
    const id = `${a.taskId}/${a.stepId}`;
    expect(seen.has(id), `two active attempts for ${id}`).toBe(false);
    seen.add(id);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-test-"));
  dbPath = join(dir, "test.db");
});
afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("store", () => {
  it("persists commands across restarts", () => {
    const a = open();
    const v0 = a.read().version;
    const r = a.command("pauseTask", { taskId: "EX-003" }, k(), iso(T0));
    expect(r.version).toBe(v0 + 1);
    a.close();
    const b = open();
    expect(b.read().version).toBe(v0 + 1);
    expect(task(b.read().state, "EX-003").hold).toBe(true);
  });

  it("applies an idempotency key at most once and replays its outcome", () => {
    const s = open();
    const v0 = s.read().version;
    const first = s.command("setPriority", { taskId: "EX-003", priority: 9 }, "same", iso(T0));
    const again = s.command("setPriority", { taskId: "EX-003", priority: 9 }, "same", iso(T0 + 1));
    expect(again).toMatchObject({ version: first.version, replayed: true });
    expect(s.read().version).toBe(v0 + 1);
    expect(task(s.read().state, "EX-003").priority).toBe(9);
    expect(s.commandCount()).toBe(1);
    // The same key for a different command is refused, not silently replayed.
    expect(() => s.command("pauseProject", {}, "same", iso(T0 + 2))).toThrow(/different command/);
    expect(s.read().state.project.hold).toBe(false);
  });

  it("rejects stale edits with a typed failure and replays the rejection", () => {
    const s = open();
    const content = M.currentSpec(task(s.read().state, "EX-003")).content;
    s.command("editSpec", { taskId: "EX-003", expectedRev: 1, content, reason: "first" }, k(), iso(T0));
    const stale = () => s.command("editSpec", { taskId: "EX-003", expectedRev: 1, content, reason: "second" }, "stale-key", iso(T0 + 1));
    expect(stale).toThrow(CommandFailure);
    try {
      stale();
    } catch (e) {
      expect((e as CommandFailure).kind).toBe("stale");
    }
    expect(M.currentSpec(task(s.read().state, "EX-003")).rev).toBe(2);
  });

  it("rejects unknown commands and malformed arguments without changing state", () => {
    const s = open();
    const v = s.read().version;
    expect(() => s.command("dropTables", {}, k(), iso(T0))).toThrow(/Unknown command/);
    expect(() => s.command("pauseTask", { taskId: 7 }, k(), iso(T0))).toThrow(/taskId must be a string/);
    expect(s.read().version).toBe(v);
  });

  it("mirrors domain events into the events table", () => {
    const s = open();
    const before = s.eventCount();
    s.command("pauseProject", {}, k(), iso(T0));
    expect(s.eventCount()).toBe(before + 1);
  });

  it("allows one lease holder at a time and hands over after expiry", () => {
    const s = open();
    expect(s.acquireLease("scheduler", "a", 5000, T0)).toBe(true);
    expect(s.acquireLease("scheduler", "b", 5000, T0 + 1000)).toBe(false);
    expect(s.acquireLease("scheduler", "a", 5000, T0 + 2000)).toBe(true); // renew
    expect(s.acquireLease("scheduler", "b", 5000, T0 + 7001)).toBe(true); // expired
    expect(s.acquireLease("scheduler", "a", 5000, T0 + 7002)).toBe(false);
  });
});

describe("scheduler with fake runtime", () => {
  const make = (store: Store, cfg: Partial<FakeRuntimeConfig> = {}) => {
    const f = fakes({ ackDelayMs: 2000, ...cfg });
    return { runtime: f.runtime, scheduler: new Scheduler(store, f.adapters, { leaseMs: 5000, ackTimeoutMs: 6000 }) };
  };

  it("only the lease holder dispatches; a second instance observes", () => {
    const store = open();
    const a = make(store);
    const b = make(open());
    a.scheduler.tick(T0);
    b.scheduler.tick(T0 + 100);
    expect(a.scheduler.active).toBe(true);
    expect(b.scheduler.active).toBe(false);
    expect(a.runtime.size()).toBeGreaterThan(0);
    expect(b.runtime.size()).toBe(0);
    assertOneActivePerStep(store.read().state);
  });

  it("pause reaches the runtime; Paused only after acknowledgment", () => {
    const store = open();
    const { scheduler, runtime } = make(store);
    scheduler.tick(T0);
    const run = M.activeAttempts(store.read().state, "EX-001")[0];
    store.command("pauseTask", { taskId: "EX-001" }, k(), iso(T0 + 100));
    scheduler.tick(T0 + 1000);
    expect(runtime.status(run.id)).toBe("stopping");
    expect(M.stateLabel(store.read().state, task(store.read().state, "EX-001"))).toBe("Pausing");
    scheduler.tick(T0 + 3500);
    const s = store.read().state;
    expect(s.attempts.find((x) => x.id === run.id)!.outcome).toBe("stopped");
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Paused");
  });

  it("an unresponsive runtime yields a control failure and blocks redispatch", () => {
    const store = open();
    const { scheduler } = make(store, { ackMode: "never" });
    scheduler.tick(T0);
    store.command("pauseTask", { taskId: "EX-001" }, k(), iso(T0));
    for (let t = 1; t <= 8; t++) scheduler.tick(T0 + t * 1000);
    const s = store.read().state;
    expect(task(s, "EX-001").controlFailure).toBeDefined();
    expect(M.activeAttempts(s, "EX-001")).toHaveLength(1);
    expect(M.activeAttempts(s, "EX-001")[0].outcome).toBe("stopping");
  });

  it("a pause committed before the runtime reports completion prevents integration", () => {
    const store = open();
    const { scheduler } = make(store, { progressPerTick: 60, ackMode: "never" });
    scheduler.tick(T0); // dispatch + first progress
    store.command("pauseTask", { taskId: "EX-002" }, k(), iso(T0 + 10));
    scheduler.tick(T0 + 1000);
    scheduler.tick(T0 + 2000);
    const s = store.read().state;
    expect(task(s, "EX-002").lifecycle).not.toBe("done");
    expect(s.attempts.filter((a) => a.taskId === "EX-002" && a.outcome === "completed" && a.stepId === "S2")).toHaveLength(0);
  });

  it("restart reconciles: running runs become lost, stopping runs stopped, nothing completes or duplicates", () => {
    const store1 = open();
    const first = make(store1);
    first.scheduler.tick(T0);
    first.scheduler.tick(T0 + 1000);
    store1.command("pauseTask", { taskId: "EX-002" }, k(), iso(T0 + 1100));
    first.scheduler.tick(T0 + 1200); // EX-002's run is now stopping
    const before = store1.read().state;
    const running = M.activeAttempts(before).filter((a) => a.outcome === "running").map((a) => a.id);
    const stopping = M.activeAttempts(before).filter((a) => a.outcome === "stopping").map((a) => a.id);
    expect(running.length).toBeGreaterThan(0);
    expect(stopping.length).toBe(1);
    const completedBefore = before.attempts.filter((a) => a.outcome === "completed").length;
    // Crash: no lease release, runtime memory gone.
    store1.close();

    const store2 = open();
    const second = make(store2);
    second.scheduler.tick(T0 + 2000); // lease still held by the crashed instance
    expect(second.scheduler.active).toBe(false);
    expect(M.activeAttempts(store2.read().state).length).toBe(running.length + stopping.length);

    second.scheduler.tick(T0 + 7000); // lease expired: take over and reconcile
    const after = store2.read().state;
    for (const id of running) expect(after.attempts.find((a) => a.id === id)!.outcome).toBe("lost");
    for (const id of stopping) expect(after.attempts.find((a) => a.id === id)!.outcome).toBe("stopped");
    expect(after.attempts.filter((a) => a.outcome === "completed").length).toBe(completedBefore);
    expect(task(after, "EX-002").hold).toBe(true);
    assertOneActivePerStep(after);
    // Lost steps were redispatched as fresh attempts, never alongside the old ones.
    const redispatched = M.activeAttempts(after).filter((a) => running.some((id) => after.attempts.find((x) => x.id === id)!.stepId === a.stepId && after.attempts.find((x) => x.id === id)!.taskId === a.taskId));
    expect(redispatched.every((a) => !running.includes(a.id))).toBe(true);
    expect(M.activeAttempts(after, "EX-002")).toHaveLength(0);
  });

  it("drives tasks to completion with artifacts and never exceeds the worker limit", () => {
    const store = open();
    const { scheduler } = make(store, { progressPerTick: 40 });
    store.command("startHeldTask", { taskId: "EX-004" }, k(), iso(T0));
    for (let t = 0; t < 80; t++) {
      scheduler.tick(T0 + t * 1000);
      const s = store.read().state;
      expect(M.activeAttempts(s).length).toBeLessThanOrEqual(s.project.workerLimit);
      assertOneActivePerStep(s);
    }
    const s = store.read().state;
    expect(task(s, "EX-001").lifecycle).toBe("done");
    expect(s.artifacts.some((a) => a.taskId === "EX-001" && a.stepId === "S6" && a.kind === "verification")).toBe(true);
  });
});

describe("http", () => {
  let base = "";
  let close: () => void = () => {};

  beforeEach(async () => {
    const store = open();
    const { adapters, config: fakeConfig } = fakes();
    const scheduler = new Scheduler(store, adapters);
    const server = createHttpServer({ store, scheduler, fakeConfig, startedAt: iso(T0), allowedHosts: [] });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    // Re-create with the real port in the allowlist.
    server.close();
    const allowed = createHttpServer({ store, scheduler, fakeConfig, startedAt: iso(T0), allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((r) => allowed.listen(port, "127.0.0.1", r));
    base = `http://127.0.0.1:${port}`;
    close = () => {
      allowed.closeAllConnections();
      allowed.close();
    };
  });
  afterEach(() => close());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", [CLIENT_HEADER]: "1", ...headers }, body: JSON.stringify(body) });

  it("serves state and applies commands", async () => {
    const st = await j(await fetch(base + "/api/state"));
    expect(st.service.runtime).toBe("fake");
    const r = await post("/api/commands", { name: "pauseTask", args: { taskId: "EX-003" }, idempotencyKey: k() });
    expect(r.status).toBe(200);
    expect((await j(r)).version).toBe(st.version + 1);
  });

  it("maps failures to status codes", async () => {
    const stale = await post("/api/commands", { name: "editVision", args: { expectedRev: 99, text: "x", focus: "y", reason: "z" }, idempotencyKey: k() });
    expect(stale.status).toBe(409);
    expect((await j(stale)).kind).toBe("stale");
    const control = await post("/api/commands", { name: "resumeTask", args: { taskId: "EX-003" }, idempotencyKey: k() });
    expect(control.status).toBe(400);
    expect((await j(control)).kind).toBe("control");
  });

  it("rejects cross-origin requests, missing client header, wrong content type, and foreign Host", async () => {
    const body = { name: "pauseProject", idempotencyKey: k() };
    expect((await post("/api/commands", body, { Origin: "https://evil.example" })).status).toBe(403);
    const noHeader = await fetch(base + "/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(noHeader.status).toBe(403);
    const form = await fetch(base + "/api/commands", { method: "POST", headers: { "Content-Type": "text/plain", [CLIENT_HEADER]: "1" }, body: JSON.stringify(body) });
    expect(form.status).toBe(415);
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(base + "/api/state", { headers: { Host: "attacker.example:80" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(403);
    // Nothing above changed state.
    const st = await j(await fetch(base + "/api/state"));
    expect(st.state.project.hold).toBe(false);
  });

  it("streams state changes over SSE", async () => {
    const ctrl = new AbortController();
    const res = await fetch(base + "/api/stream", { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: state");
    await post("/api/commands", { name: "pauseProject", idempotencyKey: k() });
    let text = "";
    while (!text.includes('"hold":true')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
  });
});

describe("review regressions (ORC-003)", () => {
  const make = (store: Store) => {
    const f = fakes({ ackDelayMs: 2000 });
    return { runtime: f.runtime, scheduler: new Scheduler(store, f.adapters, { leaseMs: 5000, ackTimeoutMs: 6000 }) };
  };

  it("H1: a reset from another instance never lets old processes report into new runs", () => {
    const storeA = open();
    const a = make(storeA);
    a.scheduler.tick(T0);
    a.scheduler.tick(T0 + 1000);
    const oldIds = M.activeAttempts(storeA.read().state).map((x) => x.id);
    expect(oldIds.length).toBeGreaterThan(0);
    // Observer instance B resets the sample project.
    open().command("resetSampleData", {}, k(), iso(T0 + 1500));
    a.scheduler.tick(T0 + 2000);
    const s = storeA.read().state;
    for (const id of oldIds) expect(s.attempts.some((x) => x.id === id), `old id ${id} reused`).toBe(false);
    expect(a.runtime.ids().some((id) => oldIds.includes(id))).toBe(false);
    // Every new run starts from zero progress: nothing continued from an old process.
    for (const x of M.activeAttempts(s)) expect(x.progress).toBeLessThanOrEqual(12);
  });

  it("H2: failed reconciliation is retried, never skipped", () => {
    const store1 = open();
    const first = make(store1);
    first.scheduler.tick(T0);
    const running = M.activeAttempts(store1.read().state).map((x) => x.id);
    store1.close();
    const store2 = open();
    const second = make(store2);
    const realUpdate = store2.update.bind(store2);
    let failOnce = true;
    store2.update = ((...args: Parameters<Store["update"]>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("database is locked");
      }
      return realUpdate(...args);
    }) as Store["update"];
    second.scheduler.tick(T0 + 6000); // lease expired; reconciliation fails
    expect(second.scheduler.active).toBe(false);
    second.scheduler.tick(T0 + 7000); // retried
    expect(second.scheduler.active).toBe(true);
    const s = store2.read().state;
    for (const id of running) expect(s.attempts.find((x) => x.id === id)!.outcome).toBe("lost");
  });

  it("M2: a scheduler whose lease was taken over cannot write or start runs", () => {
    const store = open();
    const a = make(store);
    a.scheduler.tick(T0);
    const b = make(open());
    b.scheduler.tick(T0 + 6000); // A's lease expired; B takes over and reconciles
    const v = store.read().version;
    a.scheduler.cycle(T0 + 6100); // A still believes it is active
    expect(a.scheduler.active).toBe(false);
    expect(a.runtime.size()).toBe(0);
    expect(store.read().version).toBe(v);
  });

  it("M4: refuses to open a database written by a newer format", () => {
    open().close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE state SET format = ? WHERE id = 1").run(STATE_FORMAT + 1);
    raw.close();
    expect(() => open()).toThrow(/newer than this version/);
  });
});

describe("http review regressions (ORC-003)", () => {
  it("H3/M1/low: unreadable static files do not crash; cross-site reads and bad bodies are refused", async () => {
    const staticDir = join(dir, "static");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(staticDir, "secret.js"), "x");
    chmodSync(join(staticDir, "secret.js"), 0o000);
    const store = open();
    const { adapters, config: fakeConfig } = fakes();
    const scheduler = new Scheduler(store, adapters);
    const probe = createHttpServer({ store, scheduler, fakeConfig, startedAt: iso(T0), allowedHosts: [], staticDir });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createHttpServer({ store, scheduler, fakeConfig, startedAt: iso(T0), allowedHosts: [`127.0.0.1:${port}`], staticDir });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;
    try {
      const secret = await fetch(base + "/secret.js");
      expect([403, 404]).toContain(secret.status);
      expect((await fetch(base + "/")).status).toBe(200); // still alive
      expect((await fetch(base + "/%E0%A4%A")).status).toBe(400);
      expect((await fetch(base + "/api/state", { headers: { Origin: "http://localhost:8080" } })).status).toBe(403);
      expect((await fetch(base + "/api/state", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
      const nullBody = await fetch(base + "/api/commands", { method: "POST", headers: { "Content-Type": "application/json", [CLIENT_HEADER]: "1" }, body: "null" });
      expect(nullBody.status).toBe(400);
    } finally {
      chmodSync(join(staticDir, "secret.js"), 0o644);
      server.closeAllConnections();
      server.close();
    }
  });
});
