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
| 3: Claude and Codex runtime adapters ([ORC-004](docs/tasks/ORC-004.md)) | Built and reviewed; real-run verification needs your API key |
| 4: Autonomous team loop | Not started |
| 5: Reliability and usability | Not started |

The service stores state in SQLite. By default it drives a **fake runtime**, and the UI labels all execution as simulated. With `ORCHESTRATION_RUNTIME=real` it runs real Claude (Agent SDK) and Codex (app-server) workers in isolated git worktrees.

The adapters are covered by tests against scripted runtimes. A run against the real providers has not been recorded yet: see "Real-run test" below. Until then, treat real mode as unverified.

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

## Running real agents

```bash
ORCHESTRATION_RUNTIME=real npm start
```

In real mode:

- **Providers:** workers need credentials, set in the service's environment. Settings shows each provider's status, and checking never starts a model run.
  - **Claude:** set `ANTHROPIC_API_KEY`, or Bedrock/Vertex/Foundry settings. A Claude.ai subscription login cannot be used: Anthropic does not permit third-party Agent SDK apps to use it.
  - **Codex:** uses your local Codex sign-in (`npx codex login`, a ChatGPT plan) or `OPENAI_API_KEY`/`CODEX_API_KEY`. Whether the Codex plan terms cover third-party local orchestrators is not stated explicitly; use an API key if in doubt.
- **Project:** a new real-mode database starts empty. In Settings, point it at a git repository with at least one commit, then create tasks from the Tasks page.
- **Workspaces:** each run gets its own git worktree under `~/.orchestration/worktrees`, never inside your repository's working tree.
  - Coders write on an `orchestration/<task>/<step>/<run>` branch, and the service commits their changes.
  - Every other role gets a read-only checkout.
  - Nothing is merged into your branches.
- **Worker environment** is set per provider in Settings:
  - **Isolated** (default): workers see none of your settings, plugins, or web tools, and use only the MCP connections you tick (for example Cloudflare, Vercel, or AWS servers from your own Claude or Codex config).
  - **Use my local setup:** workers use your Claude or Codex configuration as-is, including all its MCP servers and plugins.
  - In both environments:
    - native sub-agents stay off;
    - Claude workers' file tools are restricted to their worktree, with no shell;
    - Codex workers run in Codex's workspace-write sandbox with command network access off.
  - MCP connections run outside that sandbox, so their tools still work.
- **Limits:** Settings → Run limits caps turns, wall-clock time, and Claude spend per run. Runs cost provider usage.

### Real-run test

`node scripts/real-run-test.mjs` checks Milestone 3 end to end. It creates a throwaway repository and database, then:

1. Runs a Codex coder and a Claude coder concurrently.
2. Pauses and resumes each.
3. Pauses and resumes the project.
4. Lets both finish.

It writes an evidence file to `evidence/`, and its limits are low (12 turns, 5 minutes, $0.50 per Claude run). To run the same scenario at no cost, use `node scripts/real-run-test.mjs --fake`.

## Layout

- `src/domain/`: pure task/spec/step/run state transitions, the command registry, templates, and their tests. No UI, storage, or runtime dependencies.
- `src/runtime/`: the runtime adapter contract and simulated outputs.
- `src/ui/`: the React interface, a client of the service.
- `server/`: the SQLite store (state document, command log with idempotency keys, events, leases), the scheduler with its lease and restart reconciliation, the fake runtime, and the HTTP API.
- `docs/tasks/`: versioned task specs with decisions and completion evidence.
