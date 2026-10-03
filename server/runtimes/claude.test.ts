// Claude adapter tests. No SDK process, no network, no credentials: `query` is a scripted fake that
// yields messages shaped like the pinned SDK types (SDKSystemMessage init, SDKAssistantMessage,
// SDKResultMessage) and exposes interrupt().

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_AUTH_MESSAGE,
  ClaudeAdapter,
  claudeWorkerEnv,
  type ClaudeAdapterOptions,
  type ClaudeQueryFn,
  createWorkspaceGuard,
  toolPolicy,
} from "./claude";
import { redact } from "../redact";
import type { AdapterEvent, Assignment } from "./types";

// Real worker environments and child processes in some tests: a busy machine can take
// several times vitest's 5 s default, so these tests get 20 s. A real hang still fails.
vi.setConfig({ testTimeout: 20_000 });

// --- scripted fake SDK stream ----------------------------------------------------------------

class FakeStream implements AsyncIterable<SDKMessage> {
  private queue: SDKMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKMessage>) => void> = [];
  private rejecters: Array<(e: unknown) => void> = [];
  private ended = false;
  private error: unknown;
  interruptCalls = 0;
  onInterrupt?: () => void;

  push(...msgs: unknown[]) {
    for (const m of msgs) {
      const w = this.waiters.shift();
      this.rejecters.shift();
      if (w) w({ value: m as SDKMessage, done: false });
      else this.queue.push(m as SDKMessage);
    }
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
    this.rejecters.length = 0;
  }
  fail(err: unknown) {
    this.error = err;
    for (const r of this.rejecters.splice(0)) r(err);
    this.waiters.length = 0;
  }
  async interrupt() {
    this.interruptCalls++;
    this.onInterrupt?.();
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.error !== undefined) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => {
          this.waiters.push(resolve);
          this.rejecters.push(reject);
        });
      },
    };
  }
}

function fakeQuery() {
  const stream = new FakeStream();
  const calls: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Options }> = [];
  // What the real SDK would write to the CLI: every streamed input message, and whether the input closed.
  const inputs: SDKUserMessage[] = [];
  const input = { closed: false };
  const query: ClaudeQueryFn = (params) => {
    calls.push(params);
    void (async () => {
      for await (const m of params.prompt) inputs.push(m);
      input.closed = true;
    })();
    return stream;
  };
  return { stream, calls, query, inputs, input };
}

const ENVELOPE_MESSAGE = { type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text: "ENVELOPE" }] }, parent_tool_use_id: null };

// --- message builders (shapes from the pinned sdk.d.ts) --------------------------------------

const init = (model = "claude-sonnet-5") => ({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  model,
  cwd: "/w",
  tools: ["Read", "Glob", "Grep", "Write", "Edit"],
  apiKeySource: "ANTHROPIC_API_KEY",
  claude_code_version: "x",
  mcp_servers: [],
  permissionMode: "default",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
  uuid: "u0",
});

const assistant = (content: unknown[], id = "msg_1", extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { id, type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason: null },
  parent_tool_use_id: null,
  session_id: "sess-1",
  uuid: "u1",
  ...extra,
});

const result = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype,
  duration_ms: 10,
  duration_api_ms: 8,
  is_error: subtype !== "success",
  num_turns: 3,
  stop_reason: "end_turn",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {
    "claude-sonnet-5": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
      webSearchRequests: 0,
      costUSD: 0.0123,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  permission_denials: [],
  errors: [],
  uuid: "u9",
  session_id: "sess-1",
  ...(subtype === "success" ? { result: "Done.\n```json\n{}\n```" } : {}),
  ...extra,
});

// --- harness ---------------------------------------------------------------------------------

let ws: string;
let outside: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "claude-adapter-ws-"));
  outside = mkdtempSync(path.join(tmpdir(), "claude-adapter-out-"));
  mkdirSync(path.join(ws, "src"));
  writeFileSync(path.join(ws, "src", "x.ts"), "export {};\n");
  writeFileSync(path.join(outside, "secret.txt"), "nope\n");
  symlinkSync(outside, path.join(ws, "escape"));
  writeFileSync(path.join(ws, ".git"), "gitdir: /somewhere\n");
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ASSIGNMENT_DEFAULTS = { environment: "isolated" as const, connections: [] as string[] };
function assignment(over: Partial<Assignment> = {}, access: "read" | "write" = "write"): Assignment {
  return {
    ...ASSIGNMENT_DEFAULTS,
    attemptId: "att-1",
    taskId: "T-1",
    stepId: "S1",
    role: access === "write" ? "coder" : "code_reviewer",
    provider: "claude",
    model: "sonnet",
    workspace: { path: ws, access },
    prompt: "ENVELOPE",
    outputs: [],
    limits: { maxTurns: 7, timeoutMs: 60_000, maxBudgetUsd: 0.5 },
    ...over,
  };
}

function setup(opts: ClaudeAdapterOptions = {}) {
  const fq = fakeQuery();
  const adapter = new ClaudeAdapter({
    query: fq.query,
    env: { ANTHROPIC_API_KEY: "sk-ant-test", PATH: "/usr/bin" },
    interruptGraceMs: 30,
    killSettleMs: 30,
    ...opts,
  });
  const events: AdapterEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  return { adapter, events, ...fq };
}

const TERMINAL = new Set(["completed", "stopped", "failed"]);
const terminals = (events: AdapterEvent[]) => events.filter((e) => TERMINAL.has(e.type));
const noteEvents = (events: AdapterEvent[]) => events.filter((e) => e.type === "note");

async function waitFor(pred: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- tests -----------------------------------------------------------------------------------

describe("ClaudeAdapter", () => {
  it("reports its label and capabilities", () => {
    const { adapter } = setup();
    expect(adapter.provider).toBe("claude");
    expect(adapter.label).toMatch(/^Claude Agent SDK \d+\.\d+\.\d+$/);
    expect(adapter.capabilities).toEqual({
      start: "supported",
      streamEvents: "supported",
      steer: "supported",
      interrupt: "supported",
      resume: "unverified",
      usageReporting: "supported",
      childAgentTracking: "supported",
    });
  });

  it("never passes GitHub token variables to the worker, in either worker environment (ORC-008)", async () => {
    for (const environment of ["isolated", "local"] as const) {
      const { adapter, calls } = setup({ env: { ANTHROPIC_API_KEY: "sk-ant-test", PATH: "/usr/bin", GH_TOKEN: "t1", GITHUB_TOKEN: "t2", GH_ENTERPRISE_TOKEN: "t3", GITHUB_ENTERPRISE_TOKEN: "t4" } });
      adapter.start(assignment({ environment }));
      await waitFor(() => calls.length === 1);
      expect(Object.keys(calls[0].options.env ?? {}).filter((k) => /^(GH|GITHUB)_/.test(k))).toEqual([]);
      expect(calls[0].options.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
      await adapter.shutdown();
    }
  });

  it("turns the agent-kit hooks off in the worker, in either worker environment", async () => {
    // The envelope already gives each step its principles; the user's agent-kit plugin must not add them again.
    for (const environment of ["isolated", "local"] as const) {
      const { adapter, calls } = setup({ env: { ANTHROPIC_API_KEY: "sk-ant-test", PATH: "/usr/bin", AGENT_KIT_HOOKS: "on" } });
      adapter.start(assignment({ environment }));
      await waitFor(() => calls.length === 1);
      expect(calls[0].options.env?.AGENT_KIT_HOOKS, environment).toBe("off");
      await adapter.shutdown();
    }
  });

  it("passes exactly one way of signing in: the subscription token only when opted in (ORC-010)", async () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-key", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/usr/bin" };
    const sub = claudeWorkerEnv({ ...base, ORCHESTRATION_CLAUDE_AUTH: "subscription", ANTHROPIC_AUTH_TOKEN: "x" });
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-token");
    expect([sub.ANTHROPIC_API_KEY, sub.ANTHROPIC_AUTH_TOKEN, sub.CLAUDE_CODE_USE_BEDROCK]).toEqual([undefined, undefined, undefined]);
    const def = claudeWorkerEnv(base);
    expect(def.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // a token set for other scripts is never used by accident
    expect(def.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    // And the adapter really hands that environment to the run.
    const { adapter, calls } = setup({ env: { ...base, ORCHESTRATION_CLAUDE_AUTH: "Subscription", GH_TOKEN: "g" } });
    adapter.start(assignment());
    await waitFor(() => calls.length === 1);
    const env = calls[0].options.env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-token");
    expect([env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_USE_BEDROCK, env.GH_TOKEN]).toEqual([undefined, undefined, undefined]);
    await adapter.shutdown();
  });

  it("masks a subscription token in any text shown or logged (ORC-010)", () => {
    const token = "sk-ant-oat01-AbCdEfGhIjKlMnOp_qrstuv";
    expect(redact(`auth failed for ${token}`, { CLAUDE_CODE_OAUTH_TOKEN: token })).toBe("auth failed for ***");
    expect(redact(`auth failed for ${token}`, {})).toBe("auth failed for ***"); // by its shape, even if unset
  });

  it("runs to completion with usage, activity, and one terminal event", async () => {
    const { adapter, events, stream, calls, inputs, input } = setup();
    adapter.start(assignment());
    expect(adapter.has("att-1")).toBe(true);
    await waitFor(() => calls.length === 1);

    const opts = calls[0].options;
    // The prompt is an input stream whose first message is the envelope, shaped like the SDK's own string prompt.
    await waitFor(() => inputs.length === 1);
    expect(inputs[0]).toEqual(ENVELOPE_MESSAGE);
    expect(input.closed).toBe(false);
    expect(opts.cwd).toBe(ws);
    expect(opts.model).toBe("sonnet");
    expect(opts.maxTurns).toBe(7);
    expect(opts.maxBudgetUsd).toBe(0.5);
    expect(opts.settingSources).toEqual([]);
    expect(opts.permissionMode).toBe("default");
    expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.tools).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task", "Bash", "WebFetch", "WebSearch"]));
    expect(opts.abortController).toBeInstanceOf(AbortController);
    expect(typeof opts.canUseTool).toBe("function");
    expect(opts.hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
    expect(opts.env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe("1");
    expect(opts.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(opts.env?.PATH).toBe("/usr/bin");

    stream.push(
      init(),
      assistant([
        { type: "text", text: "Working" },
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: path.join(ws, "src/x.ts"), old_string: "a", new_string: "b" } },
      ]),
      assistant([{ type: "text", text: "Final answer" }], "msg_2"),
      result("success"),
    );
    stream.end();
    await waitFor(() => terminals(events).length === 1);
    await sleep(10);

    expect(events[0]).toEqual({ type: "started", attemptId: "att-1", sessionId: "sess-1", model: "claude-sonnet-5" });
    expect(events).toContainEqual({ type: "activity", attemptId: "att-1", note: "Edited src/x.ts" });
    const done = terminals(events);
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      type: "completed",
      attemptId: "att-1",
      finalText: "Done.\n```json\n{}\n```",
      usage: { inputTokens: 125, outputTokens: 50, costUsd: 0.0123 },
      model: "claude-sonnet-5",
    });
    expect(adapter.has("att-1")).toBe(false);
    await waitFor(() => input.closed);
    expect(inputs).toHaveLength(1); // nothing but the envelope was streamed
  });

  it("never saves a session or a memory to the user's own Claude history, for every kind of run", async () => {
    const { adapter, calls } = setup();
    const kinds: Partial<Assignment>[] = [
      { attemptId: "coder" },
      { attemptId: "lead", role: "lead", workspace: { path: ws, access: "read" }, outputSchema: { type: "object" } },
      { attemptId: "studio", role: "designer", studio: true },
      { attemptId: "local", environment: "local" },
    ];
    for (const k of kinds) adapter.start(assignment(k));
    await waitFor(() => calls.length === kinds.length);
    expect(calls.map((c) => c.options.persistSession)).toEqual([false, false, false, false]);
    expect(calls.map((c) => c.options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY)).toEqual(["1", "1", "1", "1"]);
    for (const k of kinds) adapter.kill(k.attemptId!);
  });

  it("falls back to the last assistant text when the result text is empty", async () => {
    const { adapter, events, stream, calls } = setup();
    adapter.start(assignment());
    await waitFor(() => calls.length === 1);
    stream.push(init(), assistant([{ type: "text", text: "Part A " }], "m1"), assistant([{ type: "text", text: "part B" }], "m1"));
    stream.push(result("success", { result: "" }));
    stream.end();
    await waitFor(() => terminals(events).length === 1);
    expect(terminals(events)[0]).toMatchObject({ type: "completed", finalText: "Part A \npart B" });
  });

  describe("an output schema (ORC-029 pass 4: the lead's reply)", () => {
    const schema = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false };

    it("is passed as outputFormat, the SDK's StructuredOutput tool is allowed, and the structured result is the final text as JSON", async () => {
      const { adapter, events, stream, calls } = setup();
      adapter.start(assignment({ outputSchema: schema }, "read"));
      await waitFor(() => calls.length === 1);
      const opts = calls[0].options;
      expect(opts.outputFormat).toEqual({ type: "json_schema", schema });
      const signal = new AbortController().signal;
      expect((await opts.canUseTool!("StructuredOutput", { reply: "Hi." }, { signal } as never))?.behavior).toBe("allow");
      // The model's prose around the tool call is not the answer.
      stream.push(init(), assistant([{ type: "text", text: "Let me answer through the tool." }]), result("success", { result: "", structured_output: { reply: "Hi." } }));
      stream.end();
      await waitFor(() => terminals(events).length === 1);
      expect(terminals(events)[0]).toMatchObject({ type: "completed", finalText: '{"reply":"Hi."}' });
    });

    it("without a schema: no outputFormat, StructuredOutput is refused, and a stray structured result is ignored", async () => {
      const { adapter, events, stream, calls } = setup();
      adapter.start(assignment({}, "read"));
      await waitFor(() => calls.length === 1);
      const opts = calls[0].options;
      expect(opts.outputFormat).toBeUndefined();
      expect((await opts.canUseTool!("StructuredOutput", { reply: "Hi." }, { signal: new AbortController().signal } as never))?.behavior).toBe("deny");
      stream.push(init(), result("success", { structured_output: { reply: "Hi." } }));
      stream.end();
      await waitFor(() => terminals(events).length === 1);
      expect(terminals(events)[0]).toMatchObject({ type: "completed", finalText: "Done.\n```json\n{}\n```" });
    });

    it("a runtime that returns no structured result: the last message is the answer, for the service to read as before", async () => {
      const { adapter, events, stream, calls } = setup();
      adapter.start(assignment({ outputSchema: schema }, "read"));
      await waitFor(() => calls.length === 1);
      stream.push(init(), result("success"));
      stream.end();
      await waitFor(() => terminals(events).length === 1);
      expect(terminals(events)[0]).toMatchObject({ type: "completed", finalText: "Done.\n```json\n{}\n```" });
    });
  });

  it("starting the same id twice is a no-op", async () => {
    const { adapter, calls } = setup();
    adapter.start(assignment());
    adapter.start(assignment());
    await sleep(20);
    expect(calls).toHaveLength(1);
    expect(adapter.ids()).toEqual(["att-1"]);
    adapter.kill("att-1");
  });

  it("read-only access allowlists only Read/Glob/Grep", async () => {
    const { adapter, calls } = setup({ allowShell: true });
    adapter.start(assignment({}, "read"));
    await waitFor(() => calls.length === 1);
    const opts = calls[0].options;
    expect(opts.tools).toEqual(["Read", "Glob", "Grep"]);
    for (const t of ["Write", "Edit", "Bash", "Agent", "Task", "NotebookEdit", "WebFetch", "WebSearch"]) {
      expect(opts.tools).not.toContain(t);
      expect(opts.disallowedTools).toContain(t);
    }
    adapter.kill("att-1");
  });

  it("allowShell adds Bash only for write access", () => {
    expect(toolPolicy("write", true).tools).toContain("Bash");
    expect(toolPolicy("write", true).disallowedTools).not.toContain("Bash");
    expect(toolPolicy("write").tools).not.toContain("Bash");
    expect(toolPolicy("read", true).tools).not.toContain("Bash");
  });

  describe("workspace guard", () => {
    it("denies tools outside the allowlist and paths outside the worktree", () => {
      const write = createWorkspaceGuard(ws, toolPolicy("write").tools);
      const read = createWorkspaceGuard(ws, toolPolicy("read").tools);

      expect(write("Edit", { file_path: path.join(ws, "src/x.ts") }).ok).toBe(true);
      expect(write("Write", { file_path: path.join(ws, "src/new/deep.ts") }).ok).toBe(true);
      expect(write("Write", { file_path: "src/rel.ts" }).ok).toBe(true);
      expect(write("Grep", { pattern: "x" }).ok).toBe(true);
      expect(write("Glob", { pattern: "src/**/*.ts" }).ok).toBe(true);

      expect(write("Edit", { file_path: path.join(outside, "secret.txt") }).ok).toBe(false);
      expect(write("Write", { file_path: "../escape.txt" }).ok).toBe(false);
      expect(write("Write", { file_path: path.join(ws, "escape", "planted.txt") }).ok).toBe(false); // symlinked dir
      expect(write("Read", { file_path: path.join(ws, "escape", "secret.txt") }).ok).toBe(false);
      expect(write("Read", { file_path: "/etc/passwd" }).ok).toBe(false);
      expect(write("Grep", { pattern: "x", path: outside }).ok).toBe(false);
      expect(write("Glob", { pattern: "/etc/*" }).ok).toBe(false);
      expect(write("Glob", { pattern: "../**" }).ok).toBe(false);
      expect(write("Write", { file_path: path.join(ws, ".git") }).ok).toBe(false);
      expect(write("Edit", {}).ok).toBe(false);

      expect(write("Bash", { command: "ls" }).ok).toBe(false);
      expect(write("Agent", { prompt: "x" }).ok).toBe(false);
      expect(write("WebFetch", { url: "https://example.com" }).ok).toBe(false);
      expect(write("mcp__x__y", {}).ok).toBe(false);

      expect(read("Read", { file_path: path.join(ws, "src/x.ts") }).ok).toBe(true);
      expect(read("Write", { file_path: path.join(ws, "src/x.ts") }).ok).toBe(false);
      expect(read("Edit", { file_path: path.join(ws, "src/x.ts") }).ok).toBe(false);
    });

    it("is wired into both canUseTool and the PreToolUse hook", async () => {
      const { adapter, calls, events } = setup();
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      const opts = calls[0].options;
      const signal = new AbortController().signal;

      const allow = await opts.canUseTool!("Edit", { file_path: path.join(ws, "src/x.ts") }, { signal } as never);
      expect(allow?.behavior).toBe("allow");
      const deny = await opts.canUseTool!("Write", { file_path: path.join(outside, "x") }, { signal } as never);
      expect(deny?.behavior).toBe("deny");
      const denyTool = await opts.canUseTool!("Bash", { command: "rm -rf /" }, { signal } as never);
      expect(denyTool?.behavior).toBe("deny");

      const hook = opts.hooks!.PreToolUse![0].hooks[0];
      const base = { session_id: "s", transcript_path: "/t", cwd: ws, hook_event_name: "PreToolUse", tool_use_id: "t" };
      const ok = await hook({ ...base, tool_name: "Read", tool_input: { file_path: path.join(ws, "src/x.ts") } } as never, "t", { signal });
      expect(ok).toEqual({});
      const blocked = await hook({ ...base, tool_name: "Edit", tool_input: { file_path: path.join(ws, "escape/x") } } as never, "t", { signal });
      expect(blocked).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
      const blockedTool = await hook({ ...base, tool_name: "Agent", tool_input: {} } as never, "t", { signal });
      expect(blockedTool).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });

      expect(events.some((e) => e.type === "activity" && e.note.startsWith("Blocked Write"))).toBe(true);
      adapter.kill("att-1");
    });
  });

  describe("interrupt", () => {
    it("is confirmed by the stream ending → stopped(interrupted); idempotent", async () => {
      const { adapter, events, stream, calls } = setup({ interruptGraceMs: 5000 });
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.push(init());
      await waitFor(() => events.some((e) => e.type === "started"));
      stream.onInterrupt = () => setTimeout(() => stream.end(), 5);
      adapter.interrupt("att-1");
      adapter.interrupt("att-1");
      await waitFor(() => terminals(events).length === 1);
      await sleep(20);
      expect(stream.interruptCalls).toBe(1);
      expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "interrupted" }]);
      expect(calls[0].options.abortController!.signal.aborted).toBe(false);
      expect(adapter.has("att-1")).toBe(false);
    });

    it("an aborted result after interrupt → stopped(interrupted) with usage", async () => {
      const { adapter, events, stream, calls } = setup({ interruptGraceMs: 5000 });
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.push(init());
      stream.onInterrupt = () => {
        stream.push(result("error_during_execution", { terminal_reason: "aborted_streaming" }));
        stream.end();
      };
      adapter.interrupt("att-1");
      await waitFor(() => terminals(events).length === 1);
      await sleep(10);
      expect(terminals(events)).toHaveLength(1);
      expect(terminals(events)[0]).toMatchObject({ type: "stopped", how: "interrupted", usage: { costUsd: 0.0123 } });
    });

    it("a success result that races the interrupt → completed", async () => {
      const { adapter, events, stream, calls } = setup({ interruptGraceMs: 5000 });
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.push(init());
      stream.onInterrupt = () => {
        stream.push(result("success", { terminal_reason: "completed" }));
        stream.end();
      };
      adapter.interrupt("att-1");
      await waitFor(() => terminals(events).length === 1);
      await sleep(10);
      expect(terminals(events)).toHaveLength(1);
      expect(terminals(events)[0].type).toBe("completed");
    });

    it("ignored interrupt → abort → stopped(killed) once the stream settles", async () => {
      const { adapter, events, stream, calls } = setup({ interruptGraceMs: 20, killSettleMs: 5000 });
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.push(init());
      const signal = calls[0].options.abortController!.signal;
      signal.addEventListener("abort", () => stream.fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
      adapter.interrupt("att-1");
      await waitFor(() => terminals(events).length === 1);
      expect(signal.aborted).toBe(true);
      expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "killed" }]);
    });

    it("stream that never settles after abort → stopped(killed) after the settle delay, later messages ignored", async () => {
      const { adapter, events, stream, calls } = setup({ interruptGraceMs: 20, killSettleMs: 20 });
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.push(init());
      adapter.interrupt("att-1");
      await waitFor(() => terminals(events).length === 1);
      expect(terminals(events)[0]).toMatchObject({ type: "stopped", how: "killed" });
      expect(adapter.has("att-1")).toBe(false);
      stream.push(assistant([{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "a" } }]), result("success"));
      stream.end();
      await sleep(20);
      expect(terminals(events)).toHaveLength(1);
      expect(events.filter((e) => e.type === "activity")).toHaveLength(0);
    });

    it("interrupt before the SDK is loaded confirms without starting a run", async () => {
      let release!: () => void;
      const fq = fakeQuery();
      const adapter = new ClaudeAdapter({
        env: { ANTHROPIC_API_KEY: "k" },
        loadSdk: () => new Promise((r) => (release = () => r({ query: fq.query }))),
      });
      const events: AdapterEvent[] = [];
      adapter.onEvent((e) => events.push(e));
      adapter.start(assignment());
      adapter.interrupt("att-1");
      release();
      await waitFor(() => terminals(events).length === 1);
      expect(fq.calls).toHaveLength(0);
      expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "interrupted" }]);
    });
  });

  describe("failures", () => {
    it.each([
      ["error_max_turns", /turn limit \(7 turns\)/],
      ["error_max_budget_usd", /spend limit \(\$0\.5\)/],
      ["error_during_execution", /failed during execution: boom/],
      ["error_max_structured_output_retries", /its answer did not match the output schema after the SDK's retries \(boom\)/],
    ])("%s → failed", async (subtype, pattern) => {
      const { adapter, events, stream, calls } = setup();
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.push(init(), result(subtype, { errors: ["boom"] }));
      stream.end();
      await waitFor(() => terminals(events).length === 1);
      await sleep(10);
      const t = terminals(events);
      expect(t).toHaveLength(1);
      expect(t[0].type).toBe("failed");
      expect((t[0] as { message: string }).message).toMatch(pattern);
      expect((t[0] as { usage?: unknown }).usage).toMatchObject({ costUsd: 0.0123 });
    });

    it("a thrown authentication error → actionable message", async () => {
      const { adapter, events, stream, calls } = setup();
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.fail(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'));
      await waitFor(() => terminals(events).length === 1);
      expect(terminals(events)).toEqual([{ type: "failed", attemptId: "att-1", message: CLAUDE_AUTH_MESSAGE }]);
    });

    it("an is_error result after an authentication_failed assistant message → actionable message", async () => {
      const { adapter, events, stream, calls } = setup();
      adapter.start(assignment());
      await waitFor(() => calls.length === 1);
      stream.push(
        init(),
        assistant([{ type: "text", text: "Invalid API key · Please run /login" }], "m1", { error: "authentication_failed" }),
        result("success", { is_error: true, result: "Invalid API key · Please run /login" }),
      );
      stream.end();
      await waitFor(() => terminals(events).length === 1);
      expect(terminals(events)[0]).toMatchObject({ type: "failed", message: CLAUDE_AUTH_MESSAGE });
    });

    it("other thrown errors keep their message; a stream without a result fails", async () => {
      const a = setup();
      a.adapter.start(assignment());
      await waitFor(() => a.calls.length === 1);
      a.stream.fail(new Error("Claude Code process exited with code 3"));
      await waitFor(() => terminals(a.events).length === 1);
      expect(terminals(a.events)[0]).toMatchObject({ type: "failed", message: "Claude run failed: Claude Code process exited with code 3" });

      const b = setup();
      b.adapter.start(assignment());
      await waitFor(() => b.calls.length === 1);
      b.stream.push(init());
      b.stream.end();
      await waitFor(() => terminals(b.events).length === 1);
      expect(terminals(b.events)[0]).toMatchObject({ type: "failed", message: "The Claude session ended without a result." });
    });
  });

  it("kill aborts and emits nothing afterwards", async () => {
    const { adapter, events, stream, calls } = setup();
    adapter.start(assignment());
    await waitFor(() => calls.length === 1);
    stream.push(init());
    await waitFor(() => events.length === 1);
    adapter.kill("att-1");
    expect(calls[0].options.abortController!.signal.aborted).toBe(true);
    expect(adapter.has("att-1")).toBe(false);
    expect(adapter.ids()).toEqual([]);
    stream.push(assistant([{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "a" } }]), result("success"));
    stream.end();
    adapter.interrupt("att-1");
    await sleep(50);
    expect(events.map((e) => e.type)).toEqual(["started"]);
  });

  it("enforces the time limit by interrupting", async () => {
    const { adapter, events, stream, calls } = setup({ interruptGraceMs: 5000 });
    adapter.start(assignment({ limits: { maxTurns: 5, timeoutMs: 30 } }));
    await waitFor(() => calls.length === 1);
    expect(calls[0].options.maxBudgetUsd).toBeUndefined();
    stream.push(init());
    stream.onInterrupt = () => stream.end();
    await waitFor(() => terminals(events).length === 1);
    expect(stream.interruptCalls).toBe(1);
    expect(events).toContainEqual({ type: "activity", attemptId: "att-1", note: "Time limit reached" });
    expect(terminals(events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "interrupted" }]);
  });

  it("shutdown kills live runs silently", async () => {
    const { adapter, events, stream, calls } = setup();
    adapter.start(assignment());
    await waitFor(() => calls.length === 1);
    stream.onInterrupt = undefined;
    calls[0].options.abortController!.signal.addEventListener("abort", () => stream.end());
    await adapter.shutdown();
    expect(adapter.ids()).toEqual([]);
    expect(terminals(events)).toHaveLength(0);
  });

  describe("notes", () => {
    const NOTE = "Note from the lead, relaying the user (mid-run, 10:00): skip the README; the owner will write it.";
    /** Start a run, bring it to the started state, send one note and return the message the adapter streamed. */
    async function started(opts: ClaudeAdapterOptions = {}) {
      const s = setup(opts);
      s.adapter.start(assignment());
      await waitFor(() => s.calls.length === 1);
      s.stream.push(init());
      await waitFor(() => s.events.some((e) => e.type === "started"));
      return s;
    }
    async function sendNote(s: Awaited<ReturnType<typeof started>>, id = "note-1") {
      s.adapter.note("att-1", { id, text: NOTE });
      const n = s.inputs.length + 1;
      await waitFor(() => s.inputs.length >= n);
      return s.inputs[n - 1];
    }
    const ack = (uuid: string | undefined) => ({ user_message_uuid: uuid, user_message_uuids: [uuid] });

    it("streams the note client-composed with priority next, and reports delivered only when an assistant message names its uuid", async () => {
      const s = await started();
      const sent = await sendNote(s);
      expect(sent).toMatchObject({ type: "user", message: { role: "user", content: NOTE }, parent_tool_use_id: null, priority: "next", client_composed: true });
      expect(sent.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      await sleep(20);
      expect(noteEvents(s.events)).toEqual([]); // written to the process, not delivered
      s.stream.push(assistant([{ type: "text", text: "Unrelated, no uuid" }], "msg_0"));
      await sleep(10);
      expect(noteEvents(s.events)).toEqual([]);
      s.stream.push(assistant([{ type: "text", text: "Reading the note" }], "msg_1", ack(sent.uuid)));
      await waitFor(() => noteEvents(s.events).length === 1);
      expect(noteEvents(s.events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "delivered" }]);
      s.stream.push(result("success"));
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      expect(terminals(s.events)[0]).toMatchObject({ type: "completed", finalText: "Done.\n```json\n{}\n```" });
      expect(noteEvents(s.events)).toHaveLength(1); // exactly one event per note
      await waitFor(() => s.input.closed);
    });

    it("a note folded into the running turn is acknowledged on that turn's result, before the completed event", async () => {
      const s = await started();
      s.stream.push(assistant([{ type: "text", text: "Working" }], "msg_1")); // the turn's first assistant frame: no client uuid (the envelope has none)
      const sent = await sendNote(s);
      s.stream.push(assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: path.join(ws, "src/x.ts") } }], "msg_2")); // typed turns stamp later frames no more
      await sleep(10);
      expect(noteEvents(s.events)).toEqual([]);
      s.stream.push(result("success", { user_message_uuids: [sent.uuid] }));
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      const types = s.events.map((e) => e.type);
      expect(noteEvents(s.events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "delivered" }]);
      expect(types.indexOf("note")).toBeLessThan(types.indexOf("completed"));
    });

    it("a turn that ends before the note was seen keeps the run going; the next turn acknowledges it and the run completes on the last result", async () => {
      const s = await started();
      const sent = await sendNote(s);
      s.stream.push(result("success", { result: "First turn done.", queued_turn_count: 1 }));
      await sleep(30);
      expect(terminals(s.events)).toHaveLength(0);
      expect(s.adapter.has("att-1")).toBe(true);
      expect(s.input.closed).toBe(false);
      expect(noteEvents(s.events)).toEqual([]);
      expect(s.events).toContainEqual({ type: "activity", attemptId: "att-1", note: "The turn ended with a note outstanding; waiting for the next turn to take it up" });
      s.stream.push(assistant([{ type: "text", text: "Applying the note" }], "msg_9", ack(sent.uuid)));
      await waitFor(() => noteEvents(s.events).length === 1);
      expect(noteEvents(s.events)[0]).toMatchObject({ noteId: "note-1", outcome: "delivered" });
      // modelUsage and total_cost_usd are cumulative across a session's turns (sdk.d.ts): the last result holds the totals.
      s.stream.push(
        result("success", {
          result: "Second turn done.\n```json\n{}\n```",
          total_cost_usd: 0.03,
          modelUsage: { "claude-sonnet-5": { inputTokens: 300, outputTokens: 120, cacheReadInputTokens: 40, cacheCreationInputTokens: 10, webSearchRequests: 0, costUSD: 0.03, contextWindow: 200000, maxOutputTokens: 32000 } },
        }),
      );
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      expect(terminals(s.events)[0]).toEqual({
        type: "completed",
        attemptId: "att-1",
        finalText: "Second turn done.\n```json\n{}\n```",
        usage: { inputTokens: 350, outputTokens: 120, costUsd: 0.03 },
        model: "claude-sonnet-5",
      });
      await waitFor(() => s.input.closed);
    });

    it("the note's turn hits the spend or turn limit: the run completes on the earlier result, with the total usage, and says so", async () => {
      for (const subtype of ["error_max_budget_usd", "error_max_turns"] as const) {
        const s = await started();
        const sent = await sendNote(s);
        s.stream.push(result("success", { result: "First turn done.\n```json\n{}\n```", queued_turn_count: 1 }));
        await sleep(30);
        s.stream.push(assistant([{ type: "text", text: "Applying the note" }], "msg_9", ack(sent.uuid)));
        await waitFor(() => noteEvents(s.events).length === 1);
        s.stream.push(result(subtype, { total_cost_usd: 2.01 }));
        s.stream.end();
        await waitFor(() => terminals(s.events).length === 1);
        expect(terminals(s.events)[0]).toMatchObject({ type: "completed", attemptId: "att-1", finalText: "First turn done.\n```json\n{}\n```", usage: { costUsd: 2.01 } });
        expect(s.events).toContainEqual({ type: "activity", attemptId: "att-1", note: `The note's turn reached the ${subtype === "error_max_turns" ? "turn" : "spend"} limit; the run completes on the result it had before the note` });
      }
    });

    it("a limit hit with no earlier result is still a failure", async () => {
      const s = await started();
      s.stream.push(result("error_max_budget_usd", { total_cost_usd: 2.01 }));
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      expect(terminals(s.events)[0]).toMatchObject({ type: "failed" });
    });

    it("sums the per-turn usage fallback when results carry no modelUsage", async () => {
      const s = await started();
      const sent = await sendNote(s);
      s.stream.push(result("success", { modelUsage: {}, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }, total_cost_usd: 0.01 }));
      await sleep(20);
      s.stream.push(assistant([{ type: "text", text: "Applying" }], "msg_9", ack(sent.uuid)));
      s.stream.push(result("success", { modelUsage: {}, usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.02 }));
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      expect(terminals(s.events)[0]).toMatchObject({ type: "completed", usage: { inputTokens: 145, outputTokens: 60, costUsd: 0.02 } });
    });

    it("the session ending without the acknowledgment → not-delivered, and the run still completes with its output", async () => {
      const s = await started();
      await sendNote(s);
      s.stream.push(result("success", { result: "Only turn." }));
      await sleep(20);
      expect(terminals(s.events)).toHaveLength(0);
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      expect(noteEvents(s.events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "not-delivered", reason: "the Claude session ended before the agent read it" }]);
      expect(terminals(s.events)[0]).toMatchObject({ type: "completed", finalText: "Only turn.", usage: { costUsd: 0.0123 } });
      const types = s.events.map((e) => e.type);
      expect(types.indexOf("note")).toBeLessThan(types.indexOf("completed"));
      await waitFor(() => s.input.closed);
    });

    it("no acknowledgment within the grace period → not-delivered, the run completes on its last result and the session is ended", async () => {
      const s = await started({ noteAckGraceMs: 40 });
      const sent = await sendNote(s);
      s.stream.push(result("success", { result: "Only turn." }));
      await waitFor(() => terminals(s.events).length === 1);
      expect(noteEvents(s.events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "not-delivered", reason: expect.stringMatching(/did not acknowledge the note within 0s/) }]);
      expect(terminals(s.events)[0]).toMatchObject({ type: "completed", finalText: "Only turn." });
      expect(s.calls[0].options.abortController!.signal.aborted).toBe(true);
      await waitFor(() => s.input.closed);
      // A late acknowledgment or result changes nothing.
      s.stream.push(assistant([{ type: "text", text: "late" }], "m", ack(sent.uuid)), result("success"));
      s.stream.end();
      await sleep(20);
      expect(noteEvents(s.events)).toHaveLength(1);
      expect(terminals(s.events)).toHaveLength(1);
    });

    it("while the CLI reports a turn running, the wait is renewed instead of completing under it; once idle, it gives up as before", async () => {
      const s = await started({ noteAckGraceMs: 40 });
      const sent = await sendNote(s);
      s.stream.push(result("success", { result: "First turn." }));
      s.stream.push({ type: "system", subtype: "session_state_changed", state: "running", uuid: "u-1", session_id: "sess-1" });
      await sleep(150); // well past the grace period
      expect(terminals(s.events)).toHaveLength(0);
      expect(s.events).toContainEqual({ type: "activity", attemptId: "att-1", note: "A turn is still running; waiting for it to take up the note" });
      // The note's turn shows up late: delivered, and the run completes on that turn's result.
      s.stream.push(assistant([{ type: "text", text: "Applying the note" }], "msg_9", ack(sent.uuid)));
      s.stream.push(result("success", { result: "Second turn." }));
      s.stream.push({ type: "system", subtype: "session_state_changed", state: "idle", uuid: "u-2", session_id: "sess-1" });
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      expect(noteEvents(s.events)[0]).toMatchObject({ outcome: "delivered" });
      expect(terminals(s.events)[0]).toMatchObject({ type: "completed", finalText: "Second turn." });
      // Idle: the original give-up applies.
      const t = await started({ noteAckGraceMs: 40 });
      await sendNote(t);
      t.stream.push(result("success", { result: "Only turn." }));
      t.stream.push({ type: "system", subtype: "session_state_changed", state: "idle", uuid: "u-3", session_id: "sess-1" });
      await waitFor(() => terminals(t.events).length === 1);
      expect(noteEvents(t.events)[0]).toMatchObject({ outcome: "not-delivered" });
    });

    it("a note to a finished or unknown run is not delivered, with the reason", async () => {
      const s = await started();
      s.stream.push(result("success"));
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      s.adapter.note("att-1", { id: "late", text: NOTE });
      s.adapter.note("never-started", { id: "nowhere", text: NOTE });
      await waitFor(() => noteEvents(s.events).length === 2);
      expect(noteEvents(s.events)).toEqual([
        { type: "note", attemptId: "att-1", noteId: "late", outcome: "not-delivered", reason: "the run had finished" },
        { type: "note", attemptId: "never-started", noteId: "nowhere", outcome: "not-delivered", reason: "no such run" },
      ]);
      expect(s.inputs).toHaveLength(1);
    });

    it("interrupt settles an outstanding note, refuses new ones, and closes the input", async () => {
      const s = await started({ interruptGraceMs: 5000 });
      await sendNote(s, "pending");
      s.stream.onInterrupt = () => setTimeout(() => s.stream.end(), 5);
      s.adapter.interrupt("att-1");
      s.adapter.note("att-1", { id: "after", text: NOTE });
      await waitFor(() => terminals(s.events).length === 1 && noteEvents(s.events).length === 2);
      expect(noteEvents(s.events)).toEqual([
        { type: "note", attemptId: "att-1", noteId: "pending", outcome: "not-delivered", reason: "the run was stopped first" },
        { type: "note", attemptId: "att-1", noteId: "after", outcome: "not-delivered", reason: "the run is stopping" },
      ]);
      expect(terminals(s.events)).toEqual([{ type: "stopped", attemptId: "att-1", how: "interrupted" }]);
      await waitFor(() => s.input.closed);
      expect(s.inputs).toHaveLength(2); // the envelope and the first note; the second was never streamed
    });

    it("a failed run settles its outstanding note before the terminal event", async () => {
      const s = await started();
      await sendNote(s);
      s.stream.push(result("error_max_turns"));
      s.stream.end();
      await waitFor(() => terminals(s.events).length === 1);
      expect(noteEvents(s.events)).toEqual([{ type: "note", attemptId: "att-1", noteId: "note-1", outcome: "not-delivered", reason: "the run failed first" }]);
      const types = s.events.map((e) => e.type);
      expect(types.indexOf("note")).toBeLessThan(types.indexOf("failed"));
    });

    it("kill forgets outstanding notes silently", async () => {
      const s = await started();
      await sendNote(s);
      s.adapter.kill("att-1");
      await sleep(20);
      expect(noteEvents(s.events)).toEqual([]);
      expect(s.input.closed).toBe(true);
    });

    it("closes the input on every terminal path", async () => {
      const paths: Array<[string, (s: Awaited<ReturnType<typeof started>>) => void]> = [
        ["completed", (s) => (s.stream.push(result("success")), s.stream.end())],
        ["stopped", (s) => ((s.stream.onInterrupt = () => s.stream.end()), s.adapter.interrupt("att-1"))],
        ["failed by result", (s) => (s.stream.push(result("error_during_execution")), s.stream.end())],
        ["failed by throw", (s) => s.stream.fail(new Error("boom"))],
        ["killed after abort", (s) => (s.calls[0].options.abortController!.signal.addEventListener("abort", () => s.stream.fail(new Error("aborted"))), s.adapter.interrupt("att-1"))],
      ];
      for (const [name, end] of paths) {
        const s = await started({ interruptGraceMs: name === "killed after abort" ? 10 : 5000 });
        expect(s.input.closed, name).toBe(false);
        end(s);
        await waitFor(() => terminals(s.events).length === 1);
        await waitFor(() => s.input.closed);
        expect(s.adapter.has("att-1"), name).toBe(false);
      }
    });
  });

  describe("health and models", () => {
    it("ready with ANTHROPIC_API_KEY, without printing the key", async () => {
      const { query } = fakeQuery();
      const h = await new ClaudeAdapter({ query, env: { ANTHROPIC_API_KEY: "sk-ant-secret-value" } }).health();
      expect(h.status).toBe("ready");
      expect(h.detail).not.toContain("sk-ant-secret-value");
      expect(h.detail).toContain("ANTHROPIC_API_KEY");
      expect(Number.isNaN(Date.parse(h.checkedAt))).toBe(false);
    });

    it("ready with a cloud provider flag", async () => {
      const { query } = fakeQuery();
      const h = await new ClaudeAdapter({ query, env: { CLAUDE_CODE_USE_BEDROCK: "1" } }).health();
      expect(h.status).toBe("ready");
      expect(h.detail).toContain("Bedrock");
    });

    it("not-configured without credentials, explaining API key and subscription policy", async () => {
      const { query, calls } = fakeQuery();
      const h = await new ClaudeAdapter({ query, env: { CLAUDE_CODE_USE_BEDROCK: "0" } }).health();
      expect(h.status).toBe("not-configured");
      expect(h.detail).toContain("ANTHROPIC_API_KEY");
      expect(h.detail).toMatch(/subscription/i);
      expect(calls).toHaveLength(0);
    });

    it("ready on the user's own subscription only with both the switch and the token, without printing the token (ORC-010)", async () => {
      const { query, calls } = fakeQuery();
      const token = "sk-ant-oat01-secret-token-value";
      const h = await new ClaudeAdapter({ query, env: { ORCHESTRATION_CLAUDE_AUTH: "subscription", CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: "sk-ant-other" } }).health();
      expect(h.status).toBe("ready");
      expect(h.detail).toMatch(/your own Claude subscription/);
      expect(h.detail).toMatch(/usage limits/);
      expect(h.detail).toMatch(/Anthropic/);
      expect(h.detail).not.toContain(token);
      expect(h.detail).not.toContain("sk-ant-other");
      expect(calls).toHaveLength(0);
    });

    it("not-configured with the switch but no token, pointing to claude setup-token (ORC-010)", async () => {
      const { query } = fakeQuery();
      const h = await new ClaudeAdapter({ query, env: { ORCHESTRATION_CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: "sk-ant-key" } }).health();
      expect(h.status).toBe("not-configured"); // an API key does not stand in: the user chose the subscription
      expect(h.detail).toContain("claude setup-token");
    });

    it("not-configured with a token but no switch, explaining the switch (ORC-010)", async () => {
      const { query } = fakeQuery();
      const token = "sk-ant-oat01-another-secret";
      const h = await new ClaudeAdapter({ query, env: { CLAUDE_CODE_OAUTH_TOKEN: token } }).health();
      expect(h.status).toBe("not-configured");
      expect(h.detail).toContain("ORCHESTRATION_CLAUDE_AUTH=subscription");
      expect(h.detail).not.toContain(token);
    });

    it("unavailable when the SDK cannot be imported", async () => {
      const h = await new ClaudeAdapter({
        env: { ANTHROPIC_API_KEY: "k" },
        loadSdk: () => Promise.reject(new Error("Cannot find module")),
      }).health();
      expect(h.status).toBe("unavailable");
      expect(h.detail).toMatch(/could not be loaded/);
    });

    it("lists the static alias allowlist", async () => {
      const { query } = fakeQuery();
      const models = await new ClaudeAdapter({ query, env: {} }).listModels();
      expect(models?.map((m) => m.id)).toEqual(["sonnet", "opus", "haiku"]);
      expect(models?.every((m) => m.label.includes("alias"))).toBe(true);
    });
  });
});

describe("worker environment and connections", () => {
  const configWith = (servers: Record<string, unknown>) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-cfg-")), ".claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: servers, other: { secret: "not-read" } }));
    return file;
  };

  it("isolated runs get only the allowed connections, from the user's own MCP definitions", async () => {
    const claudeConfigPath = configWith({
      cloudflare: { type: "stdio", command: "cf-mcp", args: [] },
      tradingview: { type: "stdio", command: "tv-mcp", args: [] },
    });
    const { adapter, calls } = setup({ claudeConfigPath });
    adapter.start(assignment({ environment: "isolated", connections: ["cloudflare", "missing"] }));
    await waitFor(() => calls.length === 1);
    const opts = calls[0].options;
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(["cloudflare"]);
    const guard = opts.canUseTool!;
    const allow = await guard("mcp__cloudflare__list_workers", {}, { signal: new AbortController().signal } as never);
    const deny = await guard("mcp__tradingview__quote", {}, { signal: new AbortController().signal } as never);
    expect(allow?.behavior).toBe("allow");
    expect(deny?.behavior).toBe("deny");
  });

  it("never loads project or local settings in either environment (the worktree's instruction files and hooks are agent-written)", async () => {
    for (const environment of ["isolated", "local"] as const) {
      const { adapter, calls } = setup({ claudeConfigPath: configWith({}) });
      adapter.start(assignment({ environment }));
      await waitFor(() => calls.length === 1);
      const sources = calls[0].options.settingSources ?? [];
      expect(sources, environment).not.toContain("project");
      expect(sources, environment).not.toContain("local");
      expect(sources, environment).toEqual(environment === "local" ? ["user"] : []);
    }
  });

  it("local runs load the user's Claude Code setup and may use any connection, but files stay contained", async () => {
    const { adapter, calls } = setup({ claudeConfigPath: configWith({}) });
    adapter.start(assignment({ environment: "local" }));
    await waitFor(() => calls.length === 1);
    const opts = calls[0].options;
    expect(opts.settingSources).toEqual(["user"]); // never the worktree's own (agent-writable) project settings
    expect(opts.strictMcpConfig).toBeUndefined();
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
    const sig = { signal: new AbortController().signal } as never;
    expect((await opts.canUseTool!("mcp__anything__do", {}, sig))?.behavior).toBe("allow");
    expect((await opts.canUseTool!("Write", { file_path: "/etc/passwd", content: "x" }, sig))?.behavior).toBe("deny");
  });

  it("lists user-scope MCP servers by name only", async () => {
    const { adapter } = setup({ claudeConfigPath: configWith({ vercel: { command: "v" }, aws: { command: "a", disabled: true } }) });
    expect(await adapter.listConnections()).toEqual([
      { name: "vercel", enabled: true },
      { name: "aws", enabled: false },
    ]);
    const none = setup({ claudeConfigPath: path.join(tmpdir(), "does-not-exist", ".claude.json") });
    expect(await none.adapter.listConnections()).toEqual([]);
  });
});

describe("studio runs (ORC-029 pass 3a)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "claude-adapter-repo-"));
    writeFileSync(path.join(repo, "README.md"), "The product.\n");
    symlinkSync(outside, path.join(repo, "linked"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const configWith = (servers: Record<string, unknown>) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "claude-cfg-")), ".claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: servers }));
    return file;
  };
  const sig = { signal: new AbortController().signal } as never;

  it("have no Artifact tool, no shell, no settings and no connections, even with the shell on and an assignment that says local", async () => {
    const { adapter, calls } = setup({ allowShell: true, claudeConfigPath: configWith({ cloudflare: { type: "stdio", command: "cf-mcp", args: [] } }) });
    adapter.start(assignment({ studio: true, role: "designer", environment: "local", connections: ["cloudflare"] }));
    await waitFor(() => calls.length === 1);
    const opts = calls[0].options;
    expect(opts.tools).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Agent", "Task", "WebFetch", "WebSearch"]));
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
    for (const tool of ["Artifact", "Bash", "mcp__cloudflare__deploy"]) expect((await opts.canUseTool!(tool, {}, sig))?.behavior, tool).toBe("deny");
    // The same shell setting gives an ordinary writer its shell: only the studio run goes without.
    const writer = setup({ allowShell: true });
    writer.adapter.start(assignment());
    await waitFor(() => writer.calls.length === 1);
    expect(writer.calls[0].options.tools).toContain("Bash");
  });

  it("write only in their staging folder and may read the product's checkout, never write it", async () => {
    const { adapter, calls } = setup();
    adapter.start(assignment({ studio: true, role: "designer", workspace: { path: ws, access: "write", readRoots: [repo] } }));
    await waitFor(() => calls.length === 1);
    const use = async (tool: string, input: Record<string, unknown>) => (await calls[0].options.canUseTool!(tool, input, sig))?.behavior;
    expect(await use("Write", { file_path: path.join(ws, "a", "index.html"), content: "<p>" })).toBe("allow");
    expect(await use("Read", { file_path: path.join(repo, "README.md") })).toBe("allow");
    expect(await use("Grep", { pattern: "product", path: repo })).toBe("allow");
    expect(await use("Write", { file_path: path.join(repo, "README.md"), content: "x" })).toBe("deny");
    expect(await use("Edit", { file_path: path.join(repo, "README.md"), old_string: "The", new_string: "A" })).toBe("deny");
    // Reading out of the checkout through a link in it, or anywhere else, is not allowed.
    expect(await use("Read", { file_path: path.join(repo, "linked", "secret.txt") })).toBe("deny");
    expect(await use("Read", { file_path: path.join(outside, "secret.txt") })).toBe("deny");
  });
});

describe("helpers in research runs (ORC-031 31b)", () => {
  const sig = { signal: new AbortController().signal } as never;
  const research = (cap = 2) => assignment({ allowSubagents: { cap } }, "read");
  const subagentEvents = (events: AdapterEvent[]) => events.flatMap((e) => (e.type === "subagent" ? [e.subagent] : []));
  type HookOut = { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string; updatedInput: Record<string, unknown> } };
  async function started(a: Assignment) {
    const s = setup();
    s.adapter.start(a);
    await waitFor(() => s.calls.length === 1);
    const opts = s.calls[0].options;
    const hook = opts.hooks!.PreToolUse![0].hooks[0];
    const base = { session_id: "s", transcript_path: "/t", cwd: ws, hook_event_name: "PreToolUse" };
    const call = (tool_name: string, tool_input: Record<string, unknown>, tool_use_id: string, agent_id?: string) =>
      hook({ ...base, tool_name, tool_input, tool_use_id, ...(agent_id ? { agent_id, agent_type: "researcher" } : {}) } as never, tool_use_id, sig) as Promise<HookOut>;
    return { ...s, opts, call };
  }

  it("offers the subagent tool only to a read-only run allowed helpers; every other run keeps it disallowed", async () => {
    const allowed = await started(research());
    expect(allowed.opts.tools).toEqual(["Read", "Glob", "Grep", "Agent"]);
    expect(allowed.opts.disallowedTools).not.toContain("Agent");
    expect(allowed.opts.disallowedTools).not.toContain("Task");
    expect(allowed.opts.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]));
    // The one helper type: read tools only, and no subagent tool of its own. The built-in agents stay off.
    expect(allowed.opts.agents).toEqual({ researcher: expect.objectContaining({ tools: ["Read", "Glob", "Grep"], model: "inherit", maxTurns: 7 }) });
    expect(allowed.opts.agents!.researcher.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task", "Write", "Edit", "Bash"]));
    expect(allowed.opts.env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe("1");
    allowed.adapter.kill("att-1");

    for (const a of [assignment({}, "read"), assignment({ allowSubagents: { cap: 2 } }, "write"), assignment({ allowSubagents: { cap: 2 }, studio: true, role: "designer" }, "write")]) {
      const other = await started(a);
      expect(other.opts.tools).not.toContain("Agent");
      expect(other.opts.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task"]));
      expect(other.opts.agents).toBeUndefined();
      other.adapter.kill("att-1");
    }
  });

  it("counts each Agent call the hook allows, sets it to the read-only helper in the foreground, and refuses one past the cap", async () => {
    const { adapter, call, events } = await started(research(2));
    const ask = (n: number) => ({ description: `look ${n}`, prompt: `Read file ${n}`, subagent_type: "general-purpose", run_in_background: true, isolation: "worktree", model: "haiku" });
    // Two calls of one message, decided in parallel.
    const [one, two] = await Promise.all([call("Agent", ask(1), "tu-1"), call("Agent", ask(2), "tu-2")]);
    for (const r of [one, two]) {
      expect(r.hookSpecificOutput.permissionDecision).toBe("allow");
      expect(r.hookSpecificOutput.updatedInput).toMatchObject({ subagent_type: "researcher", run_in_background: false, model: "haiku" });
      expect(r.hookSpecificOutput.updatedInput.isolation).toBeUndefined();
    }
    const three = await call("Agent", ask(3), "tu-3");
    expect(three.hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("at most 2 helper agents") });
    // The legacy name is the same tool, under the same cap.
    expect((await call("Task", ask(4), "tu-4")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(subagentEvents(events)).toEqual([
      { phase: "started", id: "tu-1", asked: "Read file 1", model: "haiku", usageInParent: true },
      { phase: "started", id: "tu-2", asked: "Read file 2", model: "haiku", usageInParent: true },
      { phase: "refused", id: "tu-3", asked: "Read file 3" },
      { phase: "refused", id: "tu-4", asked: "Read file 4" },
    ]);
    adapter.kill("att-1");
  });

  it("refuses an Agent call where none is allowed, and one from inside a helper, and reports each", async () => {
    const none = await started(assignment({}, "read"));
    expect((await none.call("Agent", { prompt: "x" }, "tu-1")).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(subagentEvents(none.events)).toEqual([{ phase: "refused", id: "tu-1", asked: "x" }]);
    none.adapter.kill("att-1");

    const nested = await started(research(3));
    expect((await nested.call("Agent", { prompt: "deeper" }, "tu-9", "agent-1")).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("helpers of its own") });
    expect(subagentEvents(nested.events)).toEqual([{ phase: "refused", id: "tu-9", asked: "deeper" }]);
    // canUseTool passes only a call the hook allowed.
    expect((await nested.opts.canUseTool!("Agent", { prompt: "x" }, { signal: new AbortController().signal, toolUseID: "tu-unknown" } as never))?.behavior).toBe("deny");
    await nested.call("Agent", { prompt: "ok" }, "tu-10");
    expect((await nested.opts.canUseTool!("Agent", { prompt: "ok" }, { signal: new AbortController().signal, toolUseID: "tu-10" } as never))?.behavior).toBe("allow");
    nested.adapter.kill("att-1");
  });

  it("runs the workspace guard on a helper's own tool calls: its write and its read outside the worktree are refused", async () => {
    const { adapter, call, events } = await started(research());
    const write = await call("Write", { file_path: path.join(ws, "note.txt"), content: "x" }, "tu-w", "agent-1");
    expect(write.hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining('"Write" is not permitted') });
    const out = await call("Read", { file_path: path.join(outside, "secret.txt") }, "tu-r", "agent-1");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await call("Read", { file_path: path.join(ws, "src/x.ts") }, "tu-ok", "agent-1")).toEqual({});
    expect(events.filter((e) => e.type === "activity" && e.note.startsWith("Blocked Write (helper)"))).toHaveLength(1);
    adapter.kill("att-1");
  });

  // The Agent call's structured result, as a real run reported it: its `usage` covers one call of the helper.
  const agentResult = (toolUseId: string, resolvedModel: string) => ({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "lantern" }] },
    tool_use_result: { status: "completed", agentId: "a1", resolvedModel, totalTokens: 3780, usage: { input_tokens: 2, output_tokens: 86, cache_read_input_tokens: 3516, cache_creation_input_tokens: 176 } },
  });
  const notification = (toolUseId: string, status = "completed") => ({ type: "system", subtype: "task_notification", task_id: `task-${toolUseId}`, tool_use_id: toolUseId, status, output_file: "", summary: "", session_id: "sess-1", uuid: `n-${toolUseId}` });

  it("ends each helper with its model, the parent's unless its call named one, and its usage unknown, never 0", async () => {
    const { adapter, call, stream, events } = await started(research(3));
    await call("Agent", { prompt: "Read alpha" }, "tu-1");
    await call("Agent", { prompt: "Read beta", model: "haiku" }, "tu-2");
    await call("Agent", { prompt: "Read gamma" }, "tu-3");
    stream.push(
      init("claude-sonnet-5-5"),
      { ...assistant([{ type: "tool_use", id: "inner-1", name: "Read", input: { file_path: "alpha.txt" } }], "msg_sub"), parent_tool_use_id: "tu-1" },
      // The order of a real run: the notification ends the helper before its Agent result arrives.
      notification("tu-1"),
      agentResult("tu-1", "claude-sonnet-5-5"),
      notification("tu-2"),
      // The Agent result ends this one first, and its reported model is used.
      agentResult("tu-3", "claude-sonnet-5-5-20990101"),
      result("success"),
    );
    await waitFor(() => terminals(events).length === 1);
    expect(subagentEvents(events).filter((s) => s.phase === "ended")).toEqual([
      { phase: "ended", id: "tu-1", how: "completed", model: "claude-sonnet-5-5" },
      { phase: "ended", id: "tu-2", how: "completed", model: "haiku" },
      { phase: "ended", id: "tu-3", how: "completed", model: "claude-sonnet-5-5-20990101" },
    ]);
    // The session's total (helpers included) is the run's usage, as before.
    expect(terminals(events)[0]).toMatchObject({ type: "completed", usage: { costUsd: 0.0123 } });
    adapter.kill("att-1");
  });

  it("counts a helper that slipped through from its tagged messages, with no model it did not report", async () => {
    const { adapter, stream, events } = await started(research(2));
    stream.push(
      init("claude-sonnet-5-5"),
      // A tagged message for a call the hook never saw.
      { ...assistant([{ type: "tool_use", id: "inner-2", name: "Read", input: { file_path: "beta.txt" } }], "msg_sub2"), parent_tool_use_id: "tu-x" },
      result("success"),
    );
    await waitFor(() => terminals(events).length === 1);
    expect(subagentEvents(events)).toEqual([
      { phase: "started", id: "tu-x", asked: "", usageInParent: true },
      // Still open when the run ended: its session closed with the run.
      { phase: "ended", id: "tu-x", how: "stopped" },
    ]);
    adapter.kill("att-1");
  });

  it("an interrupt ends the open helpers as stopped, before the run's stop", async () => {
    const { adapter, call, stream, events } = await started(research(2));
    stream.push(init());
    await call("Agent", { prompt: "slow search" }, "tu-1");
    await waitFor(() => events.some((e) => e.type === "started"));
    adapter.interrupt("att-1");
    await waitFor(() => stream.interruptCalls === 1);
    stream.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: true, content: "interrupted" }] } });
    stream.end();
    await waitFor(() => terminals(events).length === 1);
    const tail = events.filter((e) => e.type === "subagent" || TERMINAL.has(e.type)).map((e) => (e.type === "subagent" ? `${e.subagent.phase}:${"how" in e.subagent ? e.subagent.how : ""}` : e.type));
    expect(tail).toEqual(["started:", "ended:stopped", "stopped"]);
  });
});
