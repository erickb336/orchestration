# Runtime adapter research (2026-09-29)

This note gathers source-cited findings for the Milestone 3 Claude and Codex adapters. They are time-sensitive: re-verify them against the installed versions during the integration spike (PROJECT_SPEC.md requires this before any control is exposed).

## Claude: Agent SDK (TypeScript)

- **Package:** `@anthropic-ai/claude-agent-sdk`, Node 18+. It bundles a native Claude Code binary as an optional dependency, so a separate `claude` CLI is not required unless optional dependencies are omitted. [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart.md)
- **Authentication:** API key (`ANTHROPIC_API_KEY`), or Bedrock, Claude Platform on AWS, Vertex, or Foundry. **Claude.ai subscription login is not allowed for third-party apps built on the Agent SDK.** [overview](https://code.claude.com/docs/en/agent-sdk/overview.md)
- **Start:** `query({ prompt, options })` with `cwd` (absolute worktree path), `model`, `maxTurns`, `allowedTools`/`disallowedTools`, `permissionMode`, `systemPrompt`, `settingSources` (`[]` disables filesystem settings), `env`, `resume`/`forkSession`, `mcpServers`, `canUseTool`. [typescript](https://code.claude.com/docs/en/agent-sdk/typescript.md), [configuration](https://code.claude.com/docs/en/agent-sdk/configuration.md)
- **Events:** `system` (`init`, which includes the model), `assistant` (which carries `model`), `user`, `stream_event` (optional), and `result` (`subtype`, `total_cost_usd`, `usage`, `session_id`). [streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output.md), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md)
- **Interrupt:** `await query.interrupt()`. There is **no documented acknowledgment event or process-kill guarantee**; the interrupted turn is recorded as incomplete and can be resumed. The adapter must confirm the stop itself: the message stream ends, or the child process exits. [typescript](https://code.claude.com/docs/en/agent-sdk/typescript.md), [headless](https://code.claude.com/docs/en/headless.md)
- **Steering:** streaming-input mode (`prompt` as `AsyncIterable<SDKUserMessage>`). `setModel()` works on an active query.
- **Resume:** `resume: sessionId`. Sessions are stored in `~/.claude/projects/<encoded-cwd>/*.jsonl` and are local to the machine.
- **Subagents:** the `Agent` tool. Subagent messages carry `parent_tool_use_id`. `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` removes the built-in one. Depth, concurrency, and budget are capped by `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, and `maxBudgetUsd`. [subagents](https://code.claude.com/docs/en/agent-sdk/subagents.md)
- **Model catalog:** no listing API. Models are given as aliases (`sonnet`, `opus`, `haiku`, `fable`) or full IDs.

## Codex: app-server (JSON-RPC over stdio)

- **Install:** `@openai/codex` CLI (npm, brew, or installer). The `@openai/codex-sdk` package wraps `codex exec --experimental-json`. [app-server](https://learn.chatgpt.com/docs/app-server), [codex-sdk](https://learn.chatgpt.com/docs/codex-sdk)
- **Status:** app-server is **experimental**. Pin the version, and generate types with `codex app-server generate-ts`. Doc examples and source disagree on enum spellings (for example `workspace-write` vs `workspaceWrite`), so use the generated schema.
- **Authentication:** ChatGPT login (`codex login`) or an API key (`OPENAI_API_KEY`, `CODEX_API_KEY`). Credentials live in `~/.codex/auth.json` or the OS keyring. The app-server docs say its authentication "has never been permitted for commercial or hosted services". A personal local tool using the user's own login is not explicitly addressed, so this is **a policy question for the user**. [auth](https://learn.chatgpt.com/docs/auth)
- **Protocol:**
  - Handshake: `initialize` → `initialized`.
  - Threads: `thread/start` (`model`, `cwd`, `approvalPolicy`, `sandbox`).
  - Turns: `turn/start` (`threadId`, `input`, and overrides including `sandboxPolicy{workspaceWrite, writableRoots, networkAccess}`).
  - Events: `turn/started`, `item/*`, `turn/completed` (`completed | interrupted | failed`), `thread/tokenUsage/updated`.
- **Interrupt:** `turn/interrupt {threadId, turnId}` only acknowledges the request. **The stop is confirmed by `turn/completed` with `status: "interrupted"`.** No timeout is documented.
- **Steering:** `turn/steer {threadId, input, expectedTurnId}` works mid-turn.
- **Resume:** `thread/resume`. Threads persist in `~/.codex/sessions`.
- **Approvals:** delivered as server→client requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, …), answered with `accept | acceptForSession | decline | cancel`. To run unattended, use approval `never` with a workspace-write sandbox whose writable roots are the worktree and with network off. `.git` stays read-only. [approvals](https://learn.chatgpt.com/docs/agent-approvals-security)
- **Model catalog:** `model/list` (account-dependent).
- **Subagents:** on by default, and they can be triggered by AGENTS.md delegation text. Disable them with `agents.enabled=false`, or observe them via `collabToolCall` items. [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- **`codex exec --json` fallback:** no steering and no approvals. SIGINT triggers an internal interrupt; SIGTERM just kills the process.

## Implications for Orchestrator

1. **Authentication blocks the public-distribution goal as stated.** "Anyone with Claude or Codex installed" cannot rely on a Claude.ai subscription through the Agent SDK. Claude workers need an Anthropic API key or cloud credentials. For Codex, reusing a ChatGPT login is permitted for the CLI; whether it is permitted for a third-party local orchestrator is unclear. **The user decides the supported authentication modes.**
2. **Pause semantics:** Codex gives a real acknowledgment (`turn/completed: interrupted`). For Claude the adapter must confirm the stop itself: stream end or process exit after `interrupt()`, with a timeout that escalates to a process kill. Both map onto the existing `stopping → stopped | control failure` model.
3. **Workers must disable native subagents** (Claude: disable the built-in agent and the Agent tool; Codex: `agents.enabled=false`), so that every child is tracked by the Orchestrator scheduler, as PROJECT_SPEC.md requires.
4. **Model catalogs:** Codex can list its models. Claude cannot, so Claude needs a configured allowlist.
5. **Sandboxing:** run each writer in its own git worktree. For Codex, restrict writable roots to that worktree. For Claude, use `cwd` plus a permission mode or tool allowlist, since the SDK has no equivalent OS sandbox by default.
