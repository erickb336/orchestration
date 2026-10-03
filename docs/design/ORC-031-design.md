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
