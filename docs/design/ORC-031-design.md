# ORC-031: subagents only in read-only research steps

**What this is.** The design for ORC-031 (`docs/tasks/ORC-031.md`, r2). An agent may start its provider's own subagents only in a flow step explicitly marked as read-only research, the owner switches it on per step with a cap, and every subagent is counted, costed and shown.

**Where it fits.** Today every named agent is one model session, and each provider's subagents are switched off at every start. The owner asked for the case against (r2), then decided: "1 but makes sure those stages are explicitly read only investigative research stages". ORC-029 (the vision studio) is finishing; ORC-030 (QA, UI audit and the new demo) comes after this.

## Units

| Unit | Contents |
| --- | --- |
| 31a | **The domain and the flows.** `"research": true` on a flow step; the schema and graph rules refuse it on a step that writes (outputs a code change, is a checks step, or conditions a repair that writes code); Investigation's evidence step and the PE's probes are research; a research step runs read-only whatever its role. Each run records its subagents (start, end, what it was asked, model, usage, how it ended; count, most at once, cost); the budgets count their cost; "Agents at once" keeps counting runs. The setting "Let research steps start helpers" per research step, with a cap per run, off until the provider is verified (the capability map's `childAgentTracking`). A subagent that appears where none is allowed is counted, shown and listed under Needs you. Notes go to the parent only, and the UI says so. |
| 31b | **The Claude adapter.** Allow `Agent` and `Task` only in a research step with the switch on; count subagents from `Agent` tool calls and messages tagged with `parent_tool_use_id`; enforce the cap in the PreToolUse hook; prove the workspace guard and the hook apply to the subagents' own tool calls; cost from the session's total and its per-model breakdown. |
| 31c | **The Codex adapter.** Drop `agents.enabled=false` and `--disable multi_agent` only in a research step with the switch on; count from `collabAgentToolCall` items and the sub-threads' notifications; find whether the sub-threads' usage is in the parent's or separate, and sum it; find a cap (a config key) and whether `turn/interrupt` stops sub-threads. Without a cap, Codex's switch stays off. |

**Proof (per provider, before its switch can turn on):** real runs that show pause stops the subagents, their cost is counted, the guard or the sandbox applies to them, and the cap holds. The evidence goes to `docs/real-runs/`; `childAgentTracking` becomes "supported" only with it.

## 31b as built (the Claude adapter)

**Status:** built and unit-tested. The real runs have not run, so Claude's `childAgentTracking` stays "unsupported" and no research step can turn helpers on yet.

**What the adapter does** (`server/runtimes/claude.ts`):

- **Tools.** A run gets the `Agent` tool only when it has `allowSubagents` and read-only access. `Agent` and `Task` then leave the disallowed list. Every other run keeps both disallowed, as before. The adapter refuses an allowance on a run that may write, even if the service sends one.
- **One helper type.** The session defines one helper, "researcher": the read tools only, no subagent tool, and the parent's model unless the call names one. The built-in agents stay off.
- **The hook decides every `Agent` call.** It refuses a call in four cases: where no helper is allowed, from inside a helper, without a tool-use id, or past the cap ("This run may start at most 2 helper agents, and it has started 2"). It reports each refusal as `refused`. Otherwise it counts the call and reports it as `started`. The decision is synchronous, so parallel calls in one message are counted one at a time. `canUseTool` passes only a call that the hook allowed.
- **Each allowed call is rewritten** to the "researcher" type, in the foreground, with no isolation and no name. The reasons:
  - The tool runs in the background by default. A background helper outlives the parent's turn, so the run could complete while it still works.
  - In the foreground, the helper is part of the parent's turn, which an interrupt stops.
  - Isolation ("worktree" or "remote") would move the helper out of the run's workspace.
- **A helper's own tool calls** go through the same hook and the same workspace guard. The hook input names the helper (`agent_id`), so the activity note says "(helper)".
- **Counting from the stream.** These messages end a helper or count one:
  - The `Agent` call's result ends the helper, with its model (`resolvedModel`) and usage from the structured result.
  - A `task_notification` also ends it.
  - A message tagged with a `parent_tool_use_id` that the hook never allowed counts as a helper that slipped through.
  - A helper that is still open when the run ends is reported "stopped" (or "failed"), before the run's terminal event.
- **Cost.** The run's usage stays the session total: `modelUsage` summed over every model, and `total_cost_usd`. Per `sdk.d.ts`, both include the subagents' calls, so every helper is reported with `usageInParent: true`, and the budgets do not add it twice. A helper's own usage is shown only on its run.

**Not verified (needs the real runs):**

- that interrupting the parent stops a foreground helper;
- that the session total really includes the helpers' usage, and whether the `Agent` result's `usage` covers all of a helper's calls or only its last one;
- that the CLI honours the helper definition and the forced foreground;
- that a real helper's refused write leaves nothing behind.

**To prove it:** run `node --import tsx scripts/helpers-real-claude.mjs` in an interactive shell with `ORCHESTRATION_CLAUDE_AUTH=subscription`. It makes two runs on haiku, limited to $0.15 and $0.10:

1. Three helpers under a cap of 2. One is asked to write a file and to read outside the folder.
2. Two helpers, interrupted while they work.

It checks the four points and writes a scrubbed record to `docs/real-runs/`. Only if every check passes does a person set `childAgentTracking` to "supported".
