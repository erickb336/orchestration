# Orchestration

A workspace for directing an autonomous lead and its designers, coding agents, and reviewers across Claude and Codex at the same time. Either provider can lead, and roles can be assigned to either provider. Every task has a visible specification with options, tradeoffs, and an agent-selected approach. The user can inspect decisions, pause work, edit its scope, and resume it.

Start with the [project specification](docs/PROJECT_SPEC.md), [task specification template](docs/task-spec-template.md), and [team roles](docs/TEAM.md).

SimpleApps is the first managed project. This repository is separate development tooling; it is not a consumer app in that suite.

## Build status

Milestone 1 (interface prototype) is in progress; see [ORC-001](docs/tasks/ORC-001.md). The prototype has a task board, task detail with spec editor and revision diffs, per-step provider/model controls, decision history, and pause/resume/cancel/project-pause controls, all running against a **clearly labeled simulated runtime**. No agents run, nothing touches a repository, and state lives in the browser's local storage.

The durable local service (Milestone 2) and real Claude and Codex adapters (Milestone 3) are not built. Concurrent execution and cross-provider pause/review are required for the first usable runtime release and are not yet implemented.

## Run the prototype

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5317. The dev server binds to loopback only.

Checks: `npm run typecheck`, `npm test`, `npm run build`.

## Layout

- `src/domain/` — pure task/spec/step/run state transitions and their tests. No UI or runtime dependencies, so the Milestone 2 service can reuse them.
- `src/runtime/` — runtime adapter contract and the simulated runtime.
- `src/ui/` — React interface.
