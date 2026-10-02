// Codex adapter tests against a stub app-server (codex-fixtures/stub-app-server.mjs).
// No model calls, no network, no credentials. The only test touching the real pinned CLI runs
// `codex --version`.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_SERVER_ARGS, CodexAdapter, ISOLATION_CONFIG_ARGS, ISOLATION_FEATURE_ARGS, LOGIN_GUIDANCE, mcpDisableArgs, redact, type CodexAdapterOptions } from "./codex";
import type { AdapterEvent, Assignment } from "./types";

// Real child processes (the pinned Codex binary) in some tests: a busy machine can take
// several times vitest's 5 s default, so these tests get 20 s. A real hang still fails.
vi.setConfig({ testTimeout: 20_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(HERE, "codex-fixtures/stub-app-server.mjs");
const REAL_CODEX = resolve(HERE, "../../node_modules/.bin/codex");

let dir: string;
let adapters: CodexAdapter[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-adapter-test-"));
});
afterEach(async () => {
  for (const a of adapters) await a.shutdown();
  adapters = [];
  rmSync(dir, { recursive: true, force: true });
});

function make(mode: string, extra: Partial<CodexAdapterOptions> = {}, env: NodeJS.ProcessEnv = {}) {
  const logFile = join(dir, "stub.log");
  const adapter = new CodexAdapter({
    codexPath: STUB,
    env: { PATH: process.env.PATH, CODEX_STUB_MODE: mode, CODEX_STUB_LOG: logFile, CODEX_STUB_PID_FILE: join(dir, "gc.pid"), ...env },
    interruptGraceMs: 300,
    probeTimeoutMs: 2000,
    ...extra,
  });
  adapters.push(adapter);
  const events: AdapterEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const stubLog = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  return { adapter, events, stubLog };
}

// Protocol tests run in "local" mode (no isolation check needed); isolation has its own tests below.
const ASSIGNMENT_DEFAULTS = { environment: "local" as "local" | "isolated", connections: [] as string[] };
function assignment(id = "att-1", over: Partial<Assignment> = {}): Assignment {
  return {
    ...ASSIGNMENT_DEFAULTS,
    attemptId: id,
    taskId: "ORC-1",
    stepId: "S1",
    role: "coder",
    provider: "codex",
    model: "stub-model",
    workspace: { path: dir, access: "write" },
    prompt: "Do the thing.",
    outputs: [{ name: "change", kind: "code-change" }],
    limits: { maxTurns: 10, timeoutMs: 60_000 },
    ...over,
  };
}

async function waitFor(pred: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TERMINAL = new Set(["completed", "stopped", "failed"]);
const terminals = (events: AdapterEvent[]) => events.filter((e) => TERMINAL.has(e.type));
const noteEvents = (events: AdapterEvent[]) => events.filter((e) => e.type === "note");
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("CodexAdapter runs", () => {
  it("never passes GitHub token variables to a Codex process (ORC-008)", async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const spawn: CodexAdapterOptions["spawn"] = (command, args, options) => {
      envs.push(options.env ?? {});
      return nodeSpawn(command, args, options);
    };
    const { adapter, events } = make("complete", { spawn }, { GH_TOKEN: "t1", GITHUB_TOKEN: "t2", GH_ENTERPRISE_TOKEN: "t3", GITHUB_ENTERPRISE_TOKEN: "t4" });
    await adapter.health(); // a probe process
    adapter.start(assignment()); // a worker process
    await waitFor(() => terminals(events).length > 0);
    expect(envs.length).toBeGreaterThanOrEqual(2);
    for (const env of envs) {
      expect(Object.keys(env).filter((k) => /^(GH|GITHUB)_/.test(k))).toEqual([]);
      expect(env.CODEX_STUB_MODE).toBe("complete");
    }
  });

  it("turns the agent-kit hooks off in every Codex process, in either worker environment", async () => {
    // The envelope already gives each step its principles; the user's agent-kit plugin must not add them again.
    const { adapter, events, stubLog } = make("complete", {}, { AGENT_KIT_HOOKS: "on" });
    await adapter.health(); // probe processes; they also tell the adapter the MCP servers an isolated run disables
    adapter.start(assignment("att-local", { environment: "local" }));
    adapter.start(assignment("att-iso", { environment: "isolated" }));
    await waitFor(() => terminals(events).length === 2);
    expect(terminals(events).map((e) => e.type)).toEqual(["completed", "completed"]);
    const processes = stubLog().filter((l: { argv?: string[] }) => l.argv);
    expect(processes.filter((l: { argv: string[] }) => l.argv[0] === "app-server").length).toBeGreaterThanOrEqual(3); // a probe and two workers
    for (const p of processes) expect(p.agentKitHooks, p.argv.join(" ")).toBe("off");
  });

  it("starts, reports activity, and completes with the final agent message and usage", async () => {
    const { adapter, events, stubLog } = make("complete");
    adapter.start(assignment());
    expect(adapter.has("att-1")).toBe(true);
    expect(adapter.ids()).toEqual(["att-1"]);
    await waitFor(() => terminals(events).length > 0);
    await settle();

    expect(events[0]).toEqual({ type: "started", attemptId: "att-1", sessionId: "thr_stub_1", model: "stub-model" });
    const notes = events.filter((e) => e.type === "activity").map((e) => (e as { note: string }).note);
    expect(notes).toContain("Ran `npm test` (exit 0)");
    expect(notes).toContain("Changed src/a.ts");
    expect(notes.every((n) => n.length <= 140)).toBe(true);

    const done = terminals(events);
    expect(done).toHaveLength(1);
    const c = done[0] as Extract<AdapterEvent, { type: "completed" }>;
    expect(c.type).toBe("completed");
    expect(c.finalText).toContain('"outputs"');
    expect(c.finalText).toContain("```json");
    // The thread's totals; 80 of the 120 input tokens were read from the prompt cache and are kept apart for pricing.
    expect(c.usage).toEqual({ inputTokens: 120, cachedInputTokens: 80, outputTokens: 30 });
    expect(c.model).toBe("stub-model");
    expect(adapter.has("att-1")).toBe(false);

    // Wire checks: flags, no "jsonrpc" field, exact params per the generated schema.
    const log = stubLog();
    // Local mode: the user's own setup applies, but native sub-agents are still disabled.
    expect(log[0].argv).toEqual([...APP_SERVER_ARGS]);
    expect(log[0].argv.slice(0, 5)).toEqual(["app-server", "-c", "agents.enabled=false", "--disable", "multi_agent"]);
    const recv = log.filter((l) => l.recv).map((l) => l.recv);
    expect(recv.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(recv.every((m) => !("jsonrpc" in m))).toBe(true);
    expect(recv[0].params.clientInfo).toEqual({ name: "orchestration", title: "Orchestrator", version: "0.1.0" });
    expect(recv[2].params).toEqual({ model: "stub-model", cwd: dir, approvalPolicy: "never", sandbox: "workspace-write" });
    expect(recv[3].params).toEqual({
      threadId: "thr_stub_1",
      input: [{ type: "text", text: "Do the thing.", text_elements: [] }],
      cwd: dir,
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [dir, `${dir}.tmp`], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
  });

  it("uses a read-only sandbox for read access", async () => {
    const { adapter, events, stubLog } = make("complete");
    adapter.start(assignment("att-r", { workspace: { path: dir, access: "read" } }));
    await waitFor(() => terminals(events).length > 0);
    const recv = stubLog().filter((l) => l.recv).map((l) => l.recv);
    expect(recv.find((m) => m.method === "thread/start").params.sandbox).toBe("read-only");
    expect(recv.find((m) => m.method === "turn/start").params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("starting the same attempt twice is a no-op", async () => {
    const { adapter, events, stubLog } = make("complete");
    adapter.start(assignment());
    adapter.start(assignment());
    await waitFor(() => terminals(events).length > 0);
    await settle();
    expect(events.filter((e) => e.type === "started")).toHaveLength(1);
    expect(stubLog().filter((l) => l.argv)).toHaveLength(1);
  });

  it("interrupt is confirmed by turn/completed(interrupted) and is idempotent", async () => {
    const { adapter, events, stubLog } = make("interrupt-honoured");
    adapter.start(assignment());
    await waitFor(() => stubLog().some((l) => l.recv?.method === "turn/start"));
    await settle(50);
    adapter.interrupt("att-1");
    adapter.interrupt("att-1");
    await waitFor(() => terminals(events).length > 0);
    await settle(400);
    expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "interrupted", usage: undefined }]);
    const interrupts = stubLog().filter((l) => l.recv?.method === "turn/interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].recv.params).toEqual({ threadId: "thr_stub_1", turnId: "turn_stub_1" });
    expect(adapter.has("att-1")).toBe(false);
  });

  it("kills the process and reports stopped(killed) when the interrupt is not confirmed in time", async () => {
    const { adapter, events, stubLog } = make("interrupt-ignored");
    adapter.start(assignment());
    await waitFor(() => stubLog().some((l) => l.recv?.method === "turn/start"));
    await settle(50);
    const t0 = Date.now();
    adapter.interrupt("att-1");
    await waitFor(() => terminals(events).length > 0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    await settle();
    expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "killed", usage: undefined }]);
    expect(adapter.has("att-1")).toBe(false);
  });

  it("an interrupt before the turn has started kills the process", async () => {
    const { adapter, events, stubLog } = make("slow-thread");
    adapter.start(assignment());
    await waitFor(() => stubLog().some((l) => l.recv?.method === "thread/start"));
    adapter.interrupt("att-1");
    await waitFor(() => terminals(events).length > 0);
    await settle();
    expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "killed", usage: undefined }]);
    expect(events.some((e) => e.type === "started")).toBe(false);
  });

  it("enforces the time limit with an interrupt", async () => {
    const { adapter, events } = make("interrupt-honoured");
    adapter.start(assignment("att-t", { limits: { maxTurns: 5, timeoutMs: 400 } }));
    await waitFor(() => terminals(events).length > 0);
    await settle();
    expect(events.some((e) => e.type === "activity" && e.note === "Time limit reached")).toBe(true);
    expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-t", how: "interrupted", usage: undefined }]);
  });

  it("maps an authentication failure to login guidance", async () => {
    const { adapter, events } = make("auth-fail");
    adapter.start(assignment());
    await waitFor(() => terminals(events).length > 0);
    await settle();
    const done = terminals(events);
    expect(done).toHaveLength(1);
    expect(done[0].type).toBe("failed");
    expect((done[0] as { message: string }).message).toContain(LOGIN_GUIDANCE);
  });

  it("reports a crash mid-turn as a failure with the exit reason", async () => {
    const { adapter, events } = make("crash");
    adapter.start(assignment());
    await waitFor(() => terminals(events).length > 0);
    await settle(400);
    const done = terminals(events);
    expect(done).toHaveLength(1);
    expect(done[0].type).toBe("failed");
    expect((done[0] as { message: string }).message).toMatch(/exited unexpectedly \(exit code 101\).*stub crash/);
    expect(adapter.has("att-1")).toBe(false);
  });

  it("reports a JSON-RPC error from thread/start as a failure", async () => {
    const { adapter, events } = make("thread-error");
    adapter.start(assignment());
    await waitFor(() => terminals(events).length > 0);
    await settle(400);
    expect(terminals(events)).toHaveLength(1);
    expect((terminals(events)[0] as { message: string }).message).toBe("Codex rejected thread/start: model `nope` is not supported");
  });

  it("fails cleanly when the CLI is missing", async () => {
    const { adapter, events } = make("complete", { codexPath: join(dir, "no-such-codex") });
    adapter.start(assignment());
    await waitFor(() => terminals(events).length > 0);
    await settle();
    expect(terminals(events)).toHaveLength(1);
    expect((terminals(events)[0] as { message: string }).message).toContain("Codex CLI not found");
    expect(adapter.has("att-1")).toBe(false);
  });

  it("declines approval requests and notes them", async () => {
    const { adapter, events } = make("approval");
    adapter.start(assignment());
    await waitFor(() => terminals(events).length > 0);
    expect(events.some((e) => e.type === "activity" && e.note.includes("Declined a Codex request (item/commandExecution/requestApproval)"))).toBe(true);
    const c = terminals(events)[0] as Extract<AdapterEvent, { type: "completed" }>;
    expect(c.finalText).toBe('decision="decline"');
  });

  it("kill terminates the whole process group and emits nothing", async () => {
    const { adapter, events } = make("grandchild");
    adapter.start(assignment());
    const pidFile = join(dir, "gc.pid");
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
    const gc = Number(readFileSync(pidFile, "utf8"));
    expect(alive(gc)).toBe(true);
    const before = events.length;
    adapter.kill("att-1");
    expect(adapter.has("att-1")).toBe(false);
    expect(adapter.ids()).toEqual([]);
    await waitFor(() => !alive(gc), 3000);
    await settle(400);
    expect(events.length).toBe(before);
    adapter.kill("att-1"); // idempotent
  });

  it("runs concurrent attempts independently", async () => {
    const { adapter, events } = make("interrupt-honoured");
    adapter.start(assignment("a"));
    adapter.start(assignment("b"));
    await waitFor(() => events.filter((e) => e.type === "started").length === 2);
    await settle(50);
    adapter.interrupt("a");
    await waitFor(() => terminals(events).length === 1);
    expect(adapter.ids()).toEqual(["b"]);
    adapter.kill("b");
    await settle();
    expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "a", how: "interrupted", usage: undefined }]);
  });
});

describe("notes", () => {
  const NOTE = "Note from the lead, relaying the user (mid-run, 10:00): skip the README; the owner will write it.";
  /** Start a run in `mode` and wait until its turn is live (the adapter knows the turn id). */
  async function live(mode: string, env: NodeJS.ProcessEnv = {}) {
    const s = make(mode, {}, env);
    s.adapter.start(assignment());
    await waitFor(() => s.events.some((e) => e.type === "started") && s.stubLog().some((l) => l.recv?.method === "turn/start"));
    await settle(50);
    return s;
  }
  const steers = (stubLog: ReturnType<typeof make>["stubLog"]) => stubLog().filter((l) => l.recv?.method === "turn/steer").map((l) => l.recv);

  it("steers the live turn and reports delivered on the app-server's response", async () => {
    const { adapter, events, stubLog } = await live("steer");
    adapter.note("att-1", { id: "note-1", text: NOTE });
    await waitFor(() => noteEvents(events).length === 1);
    expect(noteEvents(events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "delivered" }]);
    await waitFor(() => terminals(events).length === 1);
    await settle();
    // The request carried this run's thread and turn, and the text as given.
    expect(steers(stubLog)).toHaveLength(1);
    expect(steers(stubLog)[0].params).toEqual({ threadId: "thr_stub_1", expectedTurnId: "turn_stub_1", input: [{ type: "text", text: NOTE, text_elements: [] }] });
    // The stub echoed it on the same turn, and the run then completed normally.
    expect(events).toContainEqual({ type: "activity", attemptId: "att-1", note: `Message: steered: ${NOTE}` });
    expect(terminals(events)[0]).toMatchObject({ type: "completed" });
    expect(noteEvents(events)).toHaveLength(1); // exactly one event per note
  });

  it("a refused turn/steer → not-delivered with Codex's message, and the run goes on", async () => {
    const { adapter, events } = await live("steer-refused");
    adapter.note("att-1", { id: "note-1", text: NOTE });
    await waitFor(() => noteEvents(events).length === 1);
    expect(noteEvents(events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "not-delivered", reason: "Codex refused the note: turn/steer failed: the active turn is not steerable (review)" }]);
    expect(adapter.has("att-1")).toBe(true);
    expect(terminals(events)).toHaveLength(0);
  });

  it("a response naming another turn → not-delivered (a note never lands in another run's turn)", async () => {
    const { adapter, events } = await live("steer-wrong-turn");
    adapter.note("att-1", { id: "note-1", text: NOTE });
    await waitFor(() => noteEvents(events).length === 1);
    expect(noteEvents(events)[0]).toMatchObject({ outcome: "not-delivered", reason: "Codex steered turn turn_other, not this run's turn" });
  });

  it("a note before the turn exists is held, then steered once the turn starts (ORC-027 review)", async () => {
    const { adapter, events, stubLog } = make("steer", {}, { CODEX_STUB_THREAD_DELAY_MS: "300" });
    adapter.start(assignment());
    await waitFor(() => stubLog().some((l) => l.recv?.method === "thread/start"));
    adapter.note("att-1", { id: "early", text: NOTE });
    await settle(50);
    // Held: neither settled nor sent while Codex is still starting the thread.
    expect(noteEvents(events)).toEqual([]);
    expect(steers(stubLog)).toHaveLength(0);
    await waitFor(() => noteEvents(events).length === 1);
    // The outcome says the note was held: evidence of this path in a real run's record (ORC-028 review).
    expect(noteEvents(events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "early", outcome: "delivered", heldForTurn: true }]);
    expect(steers(stubLog)).toHaveLength(1);
    expect(steers(stubLog)[0].params).toMatchObject({ threadId: "thr_stub_1", expectedTurnId: "turn_stub_1" });
    await waitFor(() => terminals(events).length === 1);
    expect(noteEvents(events)).toHaveLength(1);
  });

  it("a held note whose run is stopped before its turn starts → not-delivered, before the terminal event", async () => {
    const { adapter, events, stubLog } = make("slow-thread");
    adapter.start(assignment());
    await waitFor(() => stubLog().some((l) => l.recv?.method === "thread/start"));
    adapter.note("att-1", { id: "early", text: NOTE });
    await settle(50);
    expect(noteEvents(events)).toEqual([]);
    adapter.interrupt("att-1");
    await waitFor(() => terminals(events).length === 1);
    expect(noteEvents(events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "early", outcome: "not-delivered", reason: "the run was stopped first", heldForTurn: true }]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("note")).toBeLessThan(types.findIndex((t) => t === "stopped" || t === "failed"));
    await settle(2200);
    expect(steers(stubLog)).toHaveLength(0);
    expect(noteEvents(events)).toHaveLength(1);
  });

  it("after completion, and for an unknown attempt → not-delivered with the reason, without calling the app-server", async () => {
    const { adapter, events, stubLog } = make("complete");
    adapter.start(assignment());
    await waitFor(() => terminals(events).length > 0);
    adapter.note("att-1", { id: "late", text: NOTE });
    adapter.note("never-started", { id: "nowhere", text: NOTE });
    await waitFor(() => noteEvents(events).length === 2);
    expect(noteEvents(events)).toEqual([
      { type: "note", attemptId: "att-1", noteId: "late", outcome: "not-delivered", reason: "the run had finished" },
      { type: "note", attemptId: "never-started", noteId: "nowhere", outcome: "not-delivered", reason: "no such run" },
    ]);
    await settle();
    expect(steers(stubLog)).toHaveLength(0);
  });

  it("during an interrupt → not-delivered (the run is stopping)", async () => {
    const { adapter, events, stubLog } = await live("interrupt-ignored");
    adapter.interrupt("att-1");
    adapter.note("att-1", { id: "note-1", text: NOTE });
    await waitFor(() => noteEvents(events).length === 1);
    expect(noteEvents(events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "not-delivered", reason: "the run is stopping" }]);
    await waitFor(() => terminals(events).length === 1);
    expect(steers(stubLog)).toHaveLength(0);
  });

  it("a steer the app-server never answers settles as not-delivered before the run's terminal event", async () => {
    const { adapter, events, stubLog } = await live("interrupt-honoured", { CODEX_STUB_STEER_SILENT: "1" });
    adapter.note("att-1", { id: "note-1", text: NOTE });
    await settle(100);
    expect(steers(stubLog)).toHaveLength(1);
    expect(noteEvents(events)).toEqual([]); // unanswered: neither delivered nor refused yet
    adapter.interrupt("att-1");
    await waitFor(() => terminals(events).length === 1);
    expect(noteEvents(events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "not-delivered", reason: "the run was stopped first" }]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("note")).toBeLessThan(types.indexOf("stopped"));
    await settle(400);
    expect(noteEvents(events)).toHaveLength(1);
  });

  it("kill forgets an unanswered steer silently", async () => {
    const { adapter, events } = await live("interrupt-honoured", { CODEX_STUB_STEER_SILENT: "1" });
    adapter.note("att-1", { id: "note-1", text: NOTE });
    await settle(50);
    adapter.kill("att-1");
    await settle(300);
    expect(noteEvents(events)).toEqual([]);
  });
});

describe("repository instruction files", () => {
  it("every app-server the service starts (worker, isolated or local; lead; probe) carries -c project_doc_max_bytes=0", async () => {
    const argvs: string[][] = [];
    const spawn: CodexAdapterOptions["spawn"] = (command, args, options) => {
      argvs.push(args);
      return nodeSpawn(command, args, options);
    };
    const { adapter, events } = make("complete", { spawn });
    await adapter.health(); // a probe process
    adapter.start(assignment("w-local", { environment: "local" }));
    await waitFor(() => terminals(events).length === 1);
    adapter.start(assignment("w-isolated", { environment: "isolated" }));
    await waitFor(() => terminals(events).length === 2);
    adapter.start(assignment("lead", { role: "lead", taskId: "LEAD", stepId: "LEAD", workspace: { path: dir, access: "read" } }));
    await waitFor(() => terminals(events).length === 3);
    const servers = argvs.filter((argv) => argv.includes("app-server"));
    expect(servers.length).toBeGreaterThanOrEqual(4); // the probe, two workers, the lead
    for (const argv of servers) {
      const i = argv.indexOf("project_doc_max_bytes=0");
      expect(i, argv.join(" ")).toBeGreaterThan(argv.indexOf("app-server"));
      expect(argv[i - 1]).toBe("-c");
    }
    expect(APP_SERVER_ARGS).toContain("project_doc_max_bytes=0");
  });
});

describe("CodexAdapter health and models", () => {
  it("is ready when signed in, and includes the CLI version without the account email", async () => {
    const { adapter } = make("complete");
    const h = await adapter.health();
    expect(h.status).toBe("ready");
    expect(h.detail).toContain("0.159.2");
    expect(h.detail).toContain("ChatGPT");
    expect(h.detail).not.toContain("@");
    expect(adapter.label).toBe("Codex app-server 0.159.2");
  });

  it("is not-configured without an account", async () => {
    const { adapter } = make("account-none");
    const h = await adapter.health();
    expect(h).toMatchObject({ status: "not-configured", detail: LOGIN_GUIDANCE });
  });

  it("mentions an environment API key without revealing it", async () => {
    const { adapter } = make("account-none", {}, { OPENAI_API_KEY: "sk-test-not-a-real-key-123456" });
    const h = await adapter.health();
    expect(h.status).toBe("not-configured");
    expect(h.detail).toContain("--with-api-key");
    expect(h.detail).not.toContain("sk-test");
  });

  it("is unavailable when the binary is missing, fails, or hangs", async () => {
    const missing = make("complete", { codexPath: join(dir, "no-such-codex") }).adapter;
    expect((await missing.health()).status).toBe("unavailable");
    expect((await missing.health()).detail).toContain("not found");

    const broken = make("complete", {}, { CODEX_STUB_VERSION_EXIT: "3" }).adapter;
    expect((await broken.health()).status).toBe("unavailable");

    const hung = make("hang", { probeTimeoutMs: 500 }).adapter;
    const t0 = Date.now();
    const h = await hung.health();
    expect(h.status).toBe("unavailable");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("lists visible models across pages", async () => {
    const { adapter } = make("complete");
    expect(await adapter.listModels()).toEqual([
      { id: "stub-a", label: "Stub A" },
      { id: "stub-b", label: "Stub B" },
    ]);
  });

  it("returns null models when the CLI is missing or hangs", async () => {
    expect(await make("complete", { codexPath: join(dir, "no-such-codex") }).adapter.listModels()).toBeNull();
    expect(await make("hang", { probeTimeoutMs: 300 }).adapter.listModels()).toBeNull();
  });

  it("publishes the capability map", () => {
    const { adapter } = make("complete");
    expect(adapter.provider).toBe("codex");
    expect(adapter.capabilities).toEqual({
      start: "supported",
      streamEvents: "supported",
      steer: "supported",
      interrupt: "supported",
      resume: "unverified",
      usageReporting: "supported",
      childAgentTracking: "unsupported",
    });
  });
});

describe("redact", () => {
  it("removes secret env values and token shapes", () => {
    const env = { MY_API_KEY: "abcdefgh12345", HOME: "/Users/x" };
    expect(redact("key=abcdefgh12345 home=/Users/x tok=sk-abcdefghijklmnop", env)).toBe("key=*** home=/Users/x tok=***");
  });
});

describe.skipIf(!existsSync(REAL_CODEX))("pinned Codex CLI (smoke, no auth, no network)", () => {
  it("runs --version and reports the pinned version", () => {
    const r = spawnSync(REAL_CODEX, ["--version"], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0.159.2");
  });
});

describe("worker isolation", () => {
  const lastAppServerArgv = (stubLog: () => { argv?: string[] }[]) => stubLog().filter((l) => l.argv?.[0] === "app-server").pop()!.argv as string[];

  it("isolated runs fail closed when MCP servers cannot be enumerated; the provider stays usable for local runs", async () => {
    const { adapter, events } = make("complete", {}, { CODEX_STUB_MCP_FAIL: "1" });
    const h = await adapter.health();
    expect(h.status).toBe("ready");
    expect(h.detail).toMatch(/Isolated runs are blocked/);
    adapter.start(assignment("iso", { environment: "isolated" }));
    await waitFor(() => terminals(events).length > 0);
    expect(terminals(events)[0]).toMatchObject({ type: "failed" });
    expect((terminals(events)[0] as { message: string }).message).toMatch(/worker isolation/);
  });

  it("an isolated run disables every enabled MCP server except its allowed connections", async () => {
    const { adapter, stubLog } = make("complete");
    await adapter.health();
    adapter.start(assignment("att-iso", { environment: "isolated", connections: ["user_repl"] }));
    await waitFor(() => stubLog().some((l: { recv?: { method?: string } }) => l.recv?.method === "turn/start"));
    const argv = lastAppServerArgv(stubLog);
    expect(argv).toEqual(expect.arrayContaining([...ISOLATION_FEATURE_ARGS, ...ISOLATION_CONFIG_ARGS]));
    expect(argv).toContain('mcp_servers."weird name".enabled=false');
    expect(argv.join(" ")).not.toContain("mcp_servers.user_repl"); // allowed connection stays on
    expect(argv.join(" ")).not.toContain("mcp_servers.off"); // already disabled by the user
  });

  it("lists the user's configured MCP servers as connections", async () => {
    const { adapter } = make("complete");
    expect(await adapter.listConnections()).toEqual([
      { name: "user_repl", enabled: true },
      { name: "weird name", enabled: true },
      { name: "off", enabled: false },
    ]);
  });

  it("disables every enabled MCP server by name after a health check, quoting unusual names", async () => {
    expect(mcpDisableArgs(["user_repl", "weird name"])).toEqual(["-c", "mcp_servers.user_repl.enabled=false", "-c", 'mcp_servers."weird name".enabled=false']);
  });
});
