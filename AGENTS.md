# Orchestration project instructions

Read README.md, docs/PROJECT_SPEC.md, and docs/TEAM.md before working. Use docs/task-spec-template.md for task specifications.

## Product mandate

The user talks to one lead. The lead may originate, prioritize, and execute tasks within the recorded vision, delegating to designers, coders, and independent reviewers. The user steers the product and may pause, edit, resume, or cancel work. Publish a versioned task specification with options, tradeoffs, and the selected approach before execution. Do not turn the spec into a mandatory approval gate.

## Collaboration

The primary agent is the lead unless explicitly assigned a worker role. Delegate concrete independent work when useful, initially using at most three workers or the lower environment limit. Give every worker exact scope, workspace, owned files, specification revision, and expected checks. Use disjoint file ownership or isolated worktrees and one integration owner. Review changes before integration; keep user pauses persistent until explicit resumption.

Inspect existing work before editing and preserve other tasks' changes. Stop affected writers before changing scope. Keep decisions, run state, and test evidence durable. Do not assume saved agent identifiers describe live processes.

## Implementation

Build in the milestones specified in docs/PROJECT_SPEC.md. Start with the board and spec editor; label simulated execution explicitly. Real pause/resume requires runtime acknowledgment, persistent controls, and stale-result protection. Keep desired state distinct from observed worker state.

This project lives at this repository. SimpleApps is a managed target, not this project's implementation directory. Do not modify managed app code as a side effect of building this tool.

Verify behavior appropriate to each change, especially state races, persistence, and interruption. Do not claim background operation, native device behavior, or runtime capabilities without evidence. Configure unattended scheduling only with established operating limits and cadence. No scheduler is installed by these instructions.

## Provider support

Claude and Codex concurrency is a first-release requirement, not a future extension. Separate roles from providers, support either as lead, and use separate runtime adapters under one scheduler. The application owns shared state and dispatch; do not assume native subagent tools span providers. Enforce common pause/revision controls and isolated writer workspaces. Verify both adapters with real mixed-provider runs before claiming support.

Provider/model choice must be configurable per workflow step, with project role defaults and task/step overrides. Preserve explicit user choices, record resolved configurations per attempt, and reconcile active workers before a model change. Do not treat a role-level provider selector as satisfying per-step configuration.


Default to one implementation per bounded task. Use providers across distinct tasks or sequential design, implementation and review steps. Do not create competing Claude/Codex implementations unless the user explicitly enables that comparison. Best-of mode remains optional; provider concurrency does not require duplicate work.
