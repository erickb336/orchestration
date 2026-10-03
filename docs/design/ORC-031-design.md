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

## 31c as built: the Codex adapter

**Result.** Codex's `childAgentTracking` stays "unsupported", so "Let research steps start helpers" stays off for Codex. Real runs prove pause, cost and safety. The cap does not hold: Codex limits its sub-agents only at once, not per run. Record: [2026-10-03T08-34-11-166Z](../real-runs/2026-10-03T08-34-11-166Z.json), from `scripts/codex-subagents-real.mjs` (9 of 10 checks).

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
