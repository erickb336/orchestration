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

**Status:** built and unit-tested. The lead ran the real check once on sonnet. The cap, safety and pause held, and two reporting checks failed; both are now fixed. Claude's `childAgentTracking` stays "unsupported" until the lead's rerun passes every check, so no research step can turn helpers on yet.

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
  - A `task_notification` ends the helper. In the real run it came before the `Agent` call's result.
  - The `Agent` call's result ends it if no notification did, with the model the result names (`resolvedModel`).
  - The model of a helper otherwise: the one its call named, else the parent's, because the "researcher" definition inherits the parent's model.
  - A message tagged with a `parent_tool_use_id` that the hook never allowed counts as a helper that slipped through.
  - A helper that is still open when the run ends is reported "stopped" (or "failed"), before the run's terminal event.
- **Cost.** The run's usage stays the session total: `modelUsage` summed over every model, and `total_cost_usd`. Both include the helpers' calls (the real run below), so every helper is reported with `usageInParent: true`, and the budgets count helpers through the parent, once. A helper's own usage is never reported: it stays unknown, never 0. The `Agent` result's `usage` covers only one call of the helper, so it would undercount.

**The real check** (`scripts/helpers-real-claude.mjs`, record [2026-10-03T08-25-56-353Z](../real-runs/2026-10-03T08-25-56-353Z.json)). The lead ran it on the owner's subscription, on sonnet, for an estimated $0.075. An earlier run on haiku started no helper: the parent answered in one turn with no tools. So the script now uses sonnet by default.

| Point | Result | Evidence |
| --- | --- | --- |
| (d) The cap holds | Held | Cap 2: the hook allowed two `Agent` calls and refused the third |
| (c) The guard runs for helpers | Held | 3 helper tool calls went through the hook. A read inside the folder passed; a read outside it was refused. No helper had a write tool, and nothing was written |
| (a) Pause stops helpers | Held | The interrupt came while both helpers worked. Both ended "stopped", and no tool call or message came in the 4 s after the stop |
| (b) Cost is counted | Held; the check failed | Total $0.0610. The per-model total was 30,207 tokens and the parent's main loop 14,532, so 15,675 tokens of helper work are in the total. The check asked for per-helper usage, which the SDK does not give for all calls. It now checks what the budget needs, and it passes on this record |
| Each helper's model | Missing; fixed | The notification ended each helper before its result, so no model was reported. The adapter now gives the parent's model |

**Not verified yet:** the fixed reporting in a real run (the lead's rerun), and a helper that tries to write with a write tool. No helper has one, so its refused write was proved only in unit tests.

**To rerun:** in an interactive shell with `ORCHESTRATION_CLAUDE_AUTH=subscription`, run `node --import tsx scripts/helpers-real-claude.mjs`. It makes two runs on sonnet, limited to $0.15 and $0.10:

1. Three helpers under a cap of 2. One is asked to write a file and to read outside the folder.
2. Two helpers, interrupted while they work.

It checks the four points and writes a scrubbed record to `docs/real-runs/`. Only if every check passes does a person set `childAgentTracking` to "supported".

**The lead's rerun on the fixed adapter (2026-10-03, `docs/real-runs/2026-10-03T08-35-46-945Z.json`, about $0.055 on Sonnet): all four points held.** The cap allowed two helpers and refused the third; the hook and the guard decided the helpers' own tool calls (a read outside the folder was refused); each helper ended with its model; the helpers' work was inside the session's total (30,245 tokens against 14,589 in the parent's own loop); the interrupt stopped both helpers, with nothing after the stop. **Claude's `childAgentTracking` is now "supported".** The earlier Haiku run (`2026-10-03T08-25-14-231Z`) made no tool call in its first run, so it could not test the cap; it is kept as a record.

## 31c as built: the Codex adapter

**Result.** Real runs prove pause, cost and safety. The cap does not hold per run: Codex limits its sub-agents only at once. Record: [2026-10-03T08-34-11-166Z](../real-runs/2026-10-03T08-34-11-166Z.json), from `scripts/codex-subagents-real.mjs` (9 of 10 checks).

**The owner's choice (ORC-030 r6, option 2 below):** Codex helpers are allowed with the cap "at most N at once". Codex's `childAgentTracking` is "supported" on that record. A Codex run's allowance carries `atOnce`; the setting says beside the cap that Codex counts it at once, a run's Helpers line says "at most N at once", and the activity log flags only more running together than the cap (`HELPER_CAP` in `src/domain/subagents.ts`). Not verified: a real run after the switch (no paid runs in ORC-030 C3).

**What the adapter does** (`server/runtimes/codex.ts`):

- **Switch.** Only a read-only run with `allowSubagents` drops `agents.enabled=false` and `--disable multi_agent`. It gets `agents.max_threads=<cap>` and `agents.max_depth=1` (no sub-agent of a sub-agent). Every other run starts as before.
- **Kept thread.** Such a run's thread is not ephemeral. Codex 0.159.2 forks a sub-agent from its parent's session file, and on an ephemeral thread every spawn failed ("no rollout found for thread id"). When the run's app-server exits, the adapter archives the thread, as housekeeping does. Archiving a parent also archives its sub-agents' threads.
- **Count.** The parent's `subAgentActivity` item (0.159.2's form) or a `collabAgentToolCall` spawn reports a sub-agent's start. The first has no ask, so its task path stands in, for example "Codex sub-agent /root/p". A sub-agent ends when its own turn ends, or as "stopped" when the run's app-server exits. Its model comes from `thread/read`.
- **Apart from the parent.** A sub-thread's notifications no longer reach the parent's usage, turn or failure. Before, a sub-thread's token update or error could overwrite the parent's usage or fail the run.
- **Not seen.** Codex reports a refused spawn as no item, so the adapter sends no "refused" report.

| Point | Holds? | Evidence (real runs, gpt-6.1-sol) |
| --- | --- | --- |
| Pause | Yes | `turn/interrupt` ends only the parent's turn: the sub-agents' commands ran on for 10 s while the app-server lived. The adapter ends the app-server when the parent's turn ends, and the sleeping sub-agent's command had stopped 0.5 s after the pause. |
| Cost | Yes | Each sub-thread reports its own token totals. The parent's total rises only by its own calls, so `usageInParent` is false and the budgets add the sub-agents' cost (31a). A sub-agent stopped before its first report has no usage: unknown in the budgets, never zero. |
| Safety | Yes | The read-only sandbox applies to sub-agents: both writes, inside and outside the workspace, got "Operation not permitted", and neither file exists. |
| Cap | No | `agents.max_threads=2` refused a third sub-agent at once. With a cap of 1, a second started after the first had finished. The `agents` settings of 0.159.2 have no per-run limit. |

**Also found.** Codex reports a command as an item only for some ways of running it: code mode's later `exec_command` calls are not items. Such commands do not show as activity notes, on any run. The real-run check reads them from the session files.

**Options for the cap (the owner's call):**

1. Keep Codex off (now). Recommended until the owner wants Codex helpers.
2. Accept "at most N at once" as Codex's cap, and say so beside the setting.
3. Stop a sub-agent past the cap: the adapter interrupts its own turn. It starts, then stops, and its first call can cost tokens. Not tested: needs a real run that `turn/interrupt` on a sub-thread stops it.
