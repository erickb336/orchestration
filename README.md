# Orchestration

A workspace for directing an autonomous lead and its designers, coding agents, and reviewers across Claude and Codex at the same time. Either provider can lead, and roles can be assigned to either provider. Every task has a visible specification with options, tradeoffs, and an agent-selected approach. The user can inspect decisions, pause work, edit its scope, and resume it.

Start with the [project specification](docs/PROJECT_SPEC.md), [task specification template](docs/task-spec-template.md), and [team roles](docs/TEAM.md).

SimpleApps is the first managed project. This repository is separate development tooling; it is not a consumer app in that suite.

## Build status

| Milestone | State |
| --- | --- |
| 1: Interface prototype ([ORC-001](docs/tasks/ORC-001.md)) | Done |
| Editable pipelines, artifacts, templates ([ORC-002](docs/tasks/ORC-002.md)) | Done |
| 2: Durable task service ([ORC-003](docs/tasks/ORC-003.md)) | Done |
| 3: Claude and Codex runtime adapters | Not started |
| 4: Autonomous team loop | Not started |
| 5: Reliability and usability | Not started |

The service stores state in SQLite and drives a **fake runtime**. No agent runs yet, and the UI labels all execution as simulated. Claude and Codex adapters, concurrent mixed-provider execution, and cross-provider pause/review are required for the first usable runtime release and are not implemented.

## Run it

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
npm start
```

`npm start` builds the UI and serves the UI and API at http://127.0.0.1:5319. For development, `npm run dev` runs the service (restarting on change) and the Vite UI at http://127.0.0.1:5317.

Environment variables:

- `ORCHESTRATION_DB`: database path. Default: `~/.orchestration/orchestration.db`. Delete the file to start over with the sample project.
- `ORCHESTRATION_PORT`: service port. Default: 5319.

The service binds to loopback only. It rejects requests with foreign `Host` headers, cross-origin browser requests, and state-changing requests without its client header.

Checks: `npm run typecheck`, `npm test`, `npm run build`.

## Layout

- `src/domain/`: pure task/spec/step/run state transitions, the command registry, templates, and their tests. No UI, storage, or runtime dependencies.
- `src/runtime/`: the runtime adapter contract and simulated outputs.
- `src/ui/`: the React interface, a client of the service.
- `server/`: the SQLite store (state document, command log with idempotency keys, events, leases), the scheduler with its lease and restart reconciliation, the fake runtime, and the HTTP API.
- `docs/tasks/`: versioned task specs with decisions and completion evidence.
