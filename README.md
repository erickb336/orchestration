# Orchestrator

![Orchestrator: one lead, Claude and Codex agents, every step visible and yours to steer](docs/media/hero.png)

**One lead agent runs a team of Claude and Codex agents on your repository.** You set the vision and steer. The lead plans each task and runs it step by step, each step a fresh agent. You answer the few decisions that need you and look at results, not every detail.

Several tasks move at once. The service runs your checks itself, a different agent reviews each change, and a task reads Paused only once its agent has stopped.

## Try the demo

The demo needs no API keys and runs no agents, and nothing leaves your computer:

```bash
git clone https://github.com/erickb336/orchestrator.git
cd orchestrator
npm install
npm start
```

It opens a sample project (Weekend Trips, a hiking app) on a simulated runtime, with a short tour. It needs Node.js 22.13 or newer.

![The demo's first-run tour](docs/media/tour.gif)

## How it works

1. **Shape the vision with the lead.** It asks targeted questions and drafts the vision with you. Nothing runs yet.
2. **The lead plans tasks.** Each task gets a versioned spec: the options, their trade-offs, and the chosen approach.
3. **It picks a flow for each task** (see below), and a provider and model for each step.
4. **Each step is a fresh agent** in its own copy of the repository, given only the earlier outputs it needs and a few working principles that fit its job (fix the root cause, the smallest change, prove it works), adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). Every agent and the lead also get one of our own, [*contextualize and write for the reader*](principles/contextualize-and-write-for-the-reader.md): whatever they write says where it fits, what was decided and what is left, so you can come in cold.
5. **The service runs your project's checks** (tests, lint, build). **Then a code review and a security review run side by side.** The coder repairs whatever any of them found, and they run again until all are clean.
6. **The lead verifies the result against the spec.** It is delivered as a branch or a pull request, which you merge or which merges automatically.
7. **You look at the results** whenever you like, and can send anything that landed back as a fix or a revert.

![Home in the demo](docs/screenshots/home.png)

*Home: decisions answered in place, progress by area, and new results.*

### You can step in

- **Message the lead**, your main channel. It can change the focus, defer work or pass a note to a running coder, and every change has an Undo.
- **Send a note** to a running step yourself. It shows Delivered once the runtime has acknowledged it.
- **Pause** a task, **edit** a step's output (later steps use your version), or **rerun** a step.

![The lead conversation](docs/screenshots/lead.png)

*The lead changed the focus, deferred a task (with Undo) and passed your note to a coder at work.*

![A task page](docs/screenshots/task.png)

*A task page: the finding to decide, then each step in plain words.*

### The six flows

| Flow | For | Steps |
| --- | --- | --- |
| **Change** | Most code changes | implement → checks → code review and security review side by side → repair until clean → final checks → the lead verifies |
| **Bug fix** | A defect you can reproduce | reproduce → then as Change; the lead confirms the bug is gone |
| **Feature** | New screens, flows or copy | design → implement → checks with a UX review beside them → code and security review → repair → final checks → verify |
| **Design** | Settling a design first | design → UX review → revise → the lead writes the implementation brief |
| **Investigation** | The cause is unknown | gather evidence → review it → the lead proposes a spec (no code) |
| **Goal** | Work too big for one task | the lead breaks it into child tasks that run in parallel, then evaluates and re-plans |

Each flow is a short JSON file in [`flows/`](flows/). To change one, edit its file and run `npm test`. The security review adds one review run per round.

![The Tasks board](docs/screenshots/tasks.png)

*Tasks: every task's state, with what needs you first.*

![Results](docs/screenshots/results.png)

*Results: merge what is ready, mark a result as seen, or send it back.*

## Why I built it

I use several AI agents every day, and the bottleneck is no longer writing code: it is me. I juggle chats, re-explain direction, check whether "the tests pass" is true, and read every diff. Orchestrator is my playground for trying ways of using several agents in my own workflow, to take myself out of the loop as much as possible and review artifacts and working results instead of details.

It is deliberately small, local and readable, so that changing it is cheap. Fork it and make it yours.

**How it was made.**

- I set the direction and made the calls. AI agents in Claude Code wrote the specs and the code: a lead, plus designer, coder and reviewer agents.
- Every feature started as a versioned spec with options and trade-offs ([`docs/tasks/`](docs/tasks/)).
- Each implementation was reviewed by a separate agent, and every finding was fixed with a regression test.
- The UI was then audited (about 300 controls on 13 screens, "needs you" worded four ways) and rebuilt UI first, from target screens I approved, on one component kit ([ORC-025](docs/tasks/ORC-025.md)).

## Use it on your own repository

```bash
npm run setup   # asks once: real agents or the demo, and how Claude and Codex sign in
npm start
```

**Signing in:**

- **Claude:** an Anthropic API key, cloud credentials, or (opt-in, for personal use) your own Claude subscription token. Read [the note on subscription tokens](docs/real-agents.md#your-own-claude-subscription-token) before using one.
- **Codex:** your ChatGPT sign-in.
- **Your keys never pass through Orchestrator.** They stay in your Keychain or your environment.

Details: [docs/real-agents.md](docs/real-agents.md).

## Safety in brief

- **Local only.** The service runs on your computer and listens on 127.0.0.1 only.
- **Isolated worktrees.** Every agent works in its own git worktree. Your branch changes only by a fast-forward of verified work, or through a pull request.
- **Sandboxed agents.** Codex agents run in Codex's sandbox. Claude agents have no shell.
- **Sandboxed checks.** Your project's checks run in a sandbox with no network, except dependency installs, which run with every install hook off.
- **Narrow GitHub use.** On GitHub the app only ever merges the exact commit that was verified. It never force-pushes or uses admin rights.

Full notes: [docs/safety.md](docs/safety.md).

## Development

```bash
npm run dev        # service + UI at http://127.0.0.1:5317, restarting on change
npm run typecheck
npm test
npm run build
npm run capture    # retake the README images from the demo (needs Chrome and ffmpeg)
```

**Where things are:**

- `src/domain/`: pure state and commands, no I/O.
- `server/`: the SQLite store, the scheduler, the Claude and Codex adapters, git worktrees, and the HTTP API.
- `src/ui/`: the React app, in one dark theme.
- `src/ui/kit/`: the component kit every screen is built from; open `#/kit` in the running app to see each component in every state. A test fails when a screen sets a font size or colour inline, so new screens use the kit.
- `flows/` and `principles/`: the flows, and the principles agents are given.
- `docs/tasks/`: one spec per milestone.

## Status

A personal tool under active development, built in milestones ORC-001 to ORC-026 (the gaps were dropped), each with a spec and an independent review.

**Recent:** notes to a running agent ([ORC-022](docs/tasks/ORC-022.md)), the working principles ([ORC-024](docs/tasks/ORC-024.md), [ORC-026](docs/tasks/ORC-026.md)), and the UI audit and rebuild ([ORC-025](docs/tasks/ORC-025.md)).

**Next:** [ORC-023](docs/tasks/ORC-023.md), Orchestrator inside Claude Code, is planned.

**Not yet verified with real models.** Every feature is tested against simulated and scripted Claude and Codex runtimes. Runs with real models still need checking: `node scripts/real-run-test.mjs` does it with your credentials.

## License

MIT. See [LICENSE](LICENSE).
