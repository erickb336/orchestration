#!/usr/bin/env node
// Stub of `codex app-server` for adapter tests. Speaks the same JSONL JSON-RPC shapes as the pinned
// Codex CLI (method names and fields from ../codex-protocol). No network, no model, no credentials.
//
// Behaviour is selected with CODEX_STUB_MODE:
//   complete            normal turn: command, file change, agent messages, token usage, completed
//   interrupt-honoured  turn stays running; turn/interrupt -> turn/completed(interrupted)
//   interrupt-ignored   turn stays running; turn/interrupt is acknowledged but never completes
//   steer               turn stays running; turn/steer with the active turn id is accepted, echoed as an
//                       agent message "steered: <text>", and the turn then completes (interrupts honoured)
//   steer-refused       like steer, but turn/steer answers with a JSON-RPC error (non-steerable turn)
//   steer-wrong-turn    like steer, but the turn/steer response names another turn id
//   grandchild          like interrupt-ignored, and spawns a long-lived child (pid -> CODEX_STUB_PID_FILE)
//   auth-fail           error notification (unauthorized) then turn/completed(failed)
//   crash               exits with code 101 mid-turn after writing a panic to stderr
//   approval            sends a command approval request, then completes echoing the decision
//   slow-thread         thread/start answers after 2s (to interrupt before the turn starts)
//   (any mode)          CODEX_STUB_THREAD_DELAY_MS=n delays thread/start's answer by n ms (a note before the turn exists)
//   thread-error        thread/start answers with a JSON-RPC error
//   account-none        account/read reports no account
//   hang                never answers initialize
// CODEX_STUB_LOG: file to append every received message and argv to (JSON lines). The argv entry also records
//   the AGENT_KIT_HOOKS value the process received.
// CODEX_STUB_VERSION_EXIT: exit code for --version (default 0).
// CODEX_STUB_STEER_SILENT=1: turn/steer is never answered (any mode).

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const mode = process.env.CODEX_STUB_MODE || "complete";
const logFile = process.env.CODEX_STUB_LOG;
const log = (entry) => logFile && appendFileSync(logFile, JSON.stringify(entry) + "\n");

const args = process.argv.slice(2);
log({ argv: args, agentKitHooks: process.env.AGENT_KIT_HOOKS ?? null });

if (args.includes("--version")) {
  const code = Number(process.env.CODEX_STUB_VERSION_EXIT || 0);
  if (code === 0) process.stdout.write("codex-cli 0.159.2\n");
  process.exit(code);
}

// `codex ... mcp list --json`: two configured servers, one of them already disabled.
// CODEX_STUB_MCP_FAIL=1 makes it fail (to test that isolation fails closed).
if (args.includes("mcp") && args.includes("list")) {
  if (process.env.CODEX_STUB_MCP_FAIL === "1") process.exit(2);
  process.stdout.write(JSON.stringify([
    { name: "user_repl", enabled: true },
    { name: "weird name", enabled: true },
    { name: "off", enabled: false },
  ]));
  process.exit(0);
}

const THREAD = "thr_stub_1";
const TURN = "turn_stub_1";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const later = (ms, fn) => setTimeout(fn, ms);
let serverReqId = 0;
const awaiting = new Map();
let cwd = "/tmp";
/** The turn in progress (null between turns); turn/steer needs it, like the real app-server. */
let activeTurn = null;
const STEER_MODES = new Set(["steer", "steer-refused", "steer-wrong-turn"]);

function turnObj(status, error = null, items = []) {
  return { id: TURN, items, itemsView: "full", status, error, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: null };
}
function threadObj(model) {
  return { id: THREAD, sessionId: THREAD, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false, modelProvider: "openai", model, status: { type: "idle" }, cwd, turns: [] };
}
const item = (it) => notify("item/completed", { item: it, threadId: THREAD, turnId: TURN, completedAtMs: Date.now() });
const completeTurn = (status, error = null) => {
  activeTurn = null;
  notify("turn/completed", { threadId: THREAD, turn: turnObj(status, error) });
};
const agentMessage = (id, text, phase) => ({ type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null, questions: null });

const FINAL = [
  "All done.",
  "",
  "```json",
  JSON.stringify({ outputs: { change: { summary: "Stub change" } } }),
  "```",
].join("\n");

function runTurn() {
  activeTurn = TURN;
  notify("turn/started", { threadId: THREAD, turn: turnObj("inProgress") });
  switch (mode) {
    case "complete":
      later(10, () => {
        item({ type: "commandExecution", id: "i1", pluginId: null, scriptPath: null, command: "npm test", cwd, processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "ok", exitCode: 0, durationMs: 5 });
        item({ type: "fileChange", id: "i2", changes: [{ path: `${cwd}/src/a.ts`, kind: { type: "update", move_path: null }, diff: "" }], status: "completed" });
        item({ type: "agentMessage", id: "i3", text: "Working on it", phase: "commentary", memoryCitation: null, delivery: null, questions: null });
        notify("thread/tokenUsage/updated", {
          threadId: THREAD,
          turnId: TURN,
          tokenUsage: {
            total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0 },
            last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0 },
            modelContextWindow: null,
          },
        });
        item({ type: "agentMessage", id: "i4", text: FINAL, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });
        completeTurn("completed");
      });
      return;
    case "interrupt-honoured":
    case "interrupt-ignored":
    case "steer":
    case "steer-refused":
    case "steer-wrong-turn":
      later(10, () => notify("item/started", { item: { type: "commandExecution", id: "i1", command: "sleep 100" }, threadId: THREAD, turnId: TURN }));
      return;
    case "grandchild": {
      const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(process.env.CODEX_STUB_PID_FILE, String(gc.pid));
      return;
    }
    case "auth-fail": {
      const error = { message: "401 Unauthorized: missing bearer token", codexErrorInfo: "unauthorized", additionalDetails: null, misalignment: null };
      later(10, () => {
        notify("error", { error, willRetry: false, threadId: THREAD, turnId: TURN });
        completeTurn("failed", error);
      });
      return;
    }
    case "crash":
      later(10, () => {
        process.stderr.write("thread 'main' panicked: stub crash\n");
        process.exit(101);
      });
      return;
    case "approval": {
      const id = `srv-${++serverReqId}`;
      awaiting.set(id, (msg) => {
        const decision = msg.result?.decision;
        later(5, () => {
          item({ type: "agentMessage", id: "i9", text: `decision=${JSON.stringify(decision)}`, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });
          completeTurn("completed");
        });
      });
      send({ id, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: THREAD, turnId: TURN, itemId: "i1", startedAtMs: Date.now(), environmentId: null, command: "rm -rf /" } });
      return;
    }
    default:
      return;
  }
}

function handle(msg) {
  log({ recv: msg });
  if (msg.id !== undefined && msg.method === undefined) {
    const cb = awaiting.get(msg.id);
    awaiting.delete(msg.id);
    cb?.(msg);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      if (mode === "hang") return;
      send({ id, result: { userAgent: "stub/0.159.2", codexHome: "/tmp/stub-codex-home", platformFamily: "unix", platformOs: "macos" } });
      return;
    case "initialized":
      return;
    case "account/read":
      send({
        id,
        result:
          mode === "account-none"
            ? { account: null, requiresOpenaiAuth: true }
            : { account: { type: "chatgpt", email: "stub-user@example.invalid", planType: "plus" }, requiresOpenaiAuth: true },
      });
      return;
    case "model/list": {
      const m = (id2, name) => ({ id: id2, model: id2, displayName: name, description: "", hidden: false, isDefault: false });
      if (!params?.cursor) send({ id, result: { data: [m("stub-a", "Stub A"), { ...m("stub-hidden", "Hidden"), hidden: true }], nextCursor: "p2" } });
      else send({ id, result: { data: [m("stub-b", "Stub B")], nextCursor: null } });
      return;
    }
    case "thread/start": {
      cwd = params?.cwd ?? cwd;
      if (mode === "thread-error") {
        send({ id, error: { code: -32600, message: "model `nope` is not supported" } });
        return;
      }
      const model = params?.model ?? "stub-default";
      const answer = () => {
        send({ id, result: { thread: threadObj(model), model, modelProvider: "openai", serviceTier: null, cwd, approvalPolicy: params?.approvalPolicy, sandbox: { type: "readOnly", networkAccess: false } } });
        notify("thread/started", { thread: threadObj(model) });
      };
      if (mode === "slow-thread") later(2000, answer);
      else if (process.env.CODEX_STUB_THREAD_DELAY_MS) later(Number(process.env.CODEX_STUB_THREAD_DELAY_MS), answer);
      else answer();
      return;
    }
    case "turn/start":
      send({ id, result: { turn: turnObj("inProgress") } });
      runTurn();
      return;
    case "turn/interrupt":
      send({ id, result: {} });
      if (mode === "interrupt-honoured" || STEER_MODES.has(mode)) later(20, () => completeTurn("interrupted"));
      return;
    case "turn/steer": {
      if (process.env.CODEX_STUB_STEER_SILENT === "1") return;
      // Like the real app-server: a steer needs an active turn whose id matches expectedTurnId.
      const text = params?.input?.map((i) => (i.type === "text" ? i.text : `<${i.type}>`)).join("") ?? "";
      if (mode === "steer-refused") {
        send({ id, error: { code: -32600, message: "turn/steer failed: the active turn is not steerable (review)" } });
        return;
      }
      if (activeTurn === null) {
        send({ id, error: { code: -32600, message: "turn/steer failed: no active turn" } });
        return;
      }
      if (params?.threadId !== THREAD || params?.expectedTurnId !== activeTurn) {
        send({ id, error: { code: -32600, message: `turn/steer failed: expected turn ${params?.expectedTurnId} is not the active turn ${activeTurn}` } });
        return;
      }
      send({ id, result: { turnId: mode === "steer-wrong-turn" ? "turn_other" : activeTurn } });
      if (mode === "steer") {
        later(10, () => {
          item(agentMessage("i5", `steered: ${text}`, "commentary"));
          item(agentMessage("i6", FINAL, "final_answer"));
          completeTurn("completed");
        });
      }
      return;
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `stub: unknown method ${method}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
// Like the real app-server (verified on 0.159.2): exit on stdin EOF.
process.stdin.on("end", () => process.exit(0));
