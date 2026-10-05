# Milestones

**What this is.** The list of Orchestrator's milestones, ORC-001 to ORC-033: what each added, and what survives today. Each has a spec in [`tasks/`](tasks/) with the options, the decision and the evidence. Later milestones sometimes replaced earlier ones; the last column says what survives.

**Where things stand.** Twenty-seven are done, five were dropped, and one is planned. The [real-run records](real-runs/README.md) say which features have run with real models.

**The foundation** (the five milestones in the [project spec](PROJECT_SPEC.md), plus pipelines):

| Milestone | What it added | Today |
| --- | --- | --- |
| [ORC-001](tasks/ORC-001.md) Interface prototype | A board of tasks, a task page, and a spec editor where each edit is a new revision | Done; rebuilt in ORC-025 |
| [ORC-002](tasks/ORC-002.md) Step pipelines | Tasks as steps that pass named outputs to later steps, from templates | Done; editing pipelines in the UI was replaced by files (ORC-016, then ORC-021) |
| [ORC-003](tasks/ORC-003.md) Durable service | A local service that owns state in SQLite: every change a checked command, one scheduler, recovery after a restart | Done |
| [ORC-004](tasks/ORC-004.md) Claude and Codex adapters | Real agents in isolated git worktrees, with pause and resume that wait for the agent to confirm | Done; **verified with real models** ([records](real-runs/README.md)) |
| [ORC-005](tasks/ORC-005.md) The team loop | A lead agent on either provider that plans tasks from the vision; an integration queue; limits on what it does alone | Done |
| [ORC-006](tasks/ORC-006.md) Ready to publish | Install steps, a first-run guide, notifications, worktree cleanup, import and export, CI | Done |

**Scale and steering:**

| Milestone | What it added | Today |
| --- | --- | --- |
| [ORC-007](tasks/ORC-007.md) Fan-out | A step can break work into child tasks that run in parallel; a step can run several agents | Done; child tasks live on in the Goal flow. Several agents per step and best-of were removed in ORC-025 |
| [ORC-008](tasks/ORC-008.md) Pull-request delivery | Delivery as pull requests that you merge or that merge after review, and a queue of results to look at later | Done; run against a real GitHub repository with scripted agents |
| [ORC-009](tasks/ORC-009.md) Steering by conversation | Message the lead to change the focus, priorities or plans, with Undo | Done |
| [ORC-010](tasks/ORC-010.md) Your own Claude subscription | Opt-in: Claude agents run on your own subscription token instead of an API key | Done; used in the real run |
| [ORC-011](tasks/ORC-011.md) Guided setup | `npm run setup` once, then `npm start` | Done |
| [ORC-012](tasks/ORC-012.md) Shape the vision first | The lead asks questions and drafts the vision with you before anything runs | Done; became Vision in ORC-029 |
| [ORC-013](tasks/ORC-013.md) Quality gates | The service runs your checks in a sandbox; each review finding is triaged; review coverage is recorded | Done |
| [ORC-014](tasks/ORC-014.md) Vision documents | Attach files or a folder to the vision | Done |
| ORC-015 Phone access | Reaching the app from a phone | Dropped |
| [ORC-016](tasks/ORC-016.md) Patterns | Pipelines as JSON pattern files instead of a UI editor | Done; simplified into six flows by ORC-021 |
| [ORC-017](tasks/ORC-017.md) A demo worth showing | The sample story, the first-run tour and the README media | Done; story and tour redone in ORC-025 |
| ORC-018 to ORC-020 | Comparing patterns, benchmark runs, rotating patterns automatically | Dropped to keep the tool simple (ORC-018 was built, then closed unmerged) |

**Simpler and sharper:**

| Milestone | What it added | Today |
| --- | --- | --- |
| [ORC-021](tasks/ORC-021.md) Flows | Six plain flows in place of the pattern catalog, and a security review beside every code review | Done |
| [ORC-022](tasks/ORC-022.md) Notes to a running agent | Through the lead or directly; a note shows Delivered once the runtime acknowledges it | Done; **verified with real models** ([records](real-runs/README.md)) |
| [ORC-023](tasks/ORC-023.md) Orchestrator inside Claude Code | A Claude Code plugin to talk to the lead of the repository you are in, also from your phone through Remote Control | Dropped on 2026-10-04: sage mode replaces it |
| [ORC-024](tasks/ORC-024.md) Working principles | Fifteen principles adapted from pstack, given to each step's agent where they fit | Done |
| [ORC-025](tasks/ORC-025.md) UI audit and rebuild | One dark theme, a component kit, every screen rebuilt, a new demo | Done |
| [ORC-026](tasks/ORC-026.md) Write for the reader | A sixteenth principle, our own, given to every agent and the lead | Done |
| [ORC-027](tasks/ORC-027.md) The real-run test, committed | The end-to-end scenario runs in CI on simulated agents; `npm run test:real` runs it with real ones and leaves a record in [`docs/real-runs/`](real-runs/) | Done |
| [ORC-028](tasks/ORC-028.md) Fixes from the real run | Investigation revises its report while its review finds something, and a rule keeps every flow from dropping review findings | Done; **verified with real models** ([records](real-runs/README.md)) |
| [ORC-029](tasks/ORC-029.md) The vision studio, before the factory | Vision: rounds on prototypes you can click, terminal demos, data contracts and flows, with PE review. The draft and Lock in, the pre-flight, the factory floor and change orders. Design and reality, with evidence the service captures. Checks and evidence in the project's own container, for any language | Done; the studio and the factory **ran with real models** |
| [ORC-030](tasks/ORC-030.md) QA, UI audit and a new demo | QA journeys in a real browser at two widths (`npm run qa`), fixes at the root with a backlog of what is left, a UI audit the owner marked and the cleanup it called for, Resume from the paused work, keeping the Mac awake, the demo's whole story and tour, a shorter README | Done |
| [ORC-031](tasks/ORC-031.md) Subagents in research steps | Agents in explicitly read-only research steps may start their provider's own subagents, counted, costed, capped and shown; writers stay single-session | Done for Claude (**proven with real models**); Codex's stays off, because Codex has no cap per run |
| [ORC-032](tasks/ORC-032.md) Import an existing project | Derive an "as it is today" vision from an existing repository, then revise it and build on it: the tests, the rules, the parts and their recordings, a review of only what the code cannot answer, and the baseline Lock in | Done with the simulated runtime and Docker; not yet run with real models |
| [ORC-033](tasks/ORC-033.md) Keep the living vision true | Notice when the code changes outside Orchestrator, keep the vision local, and fix bugs at their root as mismatches with the vision | **Planned** |
