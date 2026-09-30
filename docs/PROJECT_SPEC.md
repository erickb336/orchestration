# Orchestration Project Specification

Build a project workspace where the user talks to one lead agent, sees the work that agent proposes, and can inspect or redirect any task. The lead owns planning and execution within the project vision, delegates to designers, coders, and reviewers, and keeps work moving without requiring approval for every decision.

Every task carries a durable, versioned specification. It explains the problem, options, tradeoffs, and the agent's chosen approach. The user can return later to understand decisions, pause unfinished work, revise it, and resume execution.

Status: proposed implementation specification. The task board, live controls, runtime adapter, and scheduler described here are not built. The existing repository Markdown board and role briefs are the starting inputs. Working product name: Orchestration. SimpleApps is its first managed project; this is development tooling, not a new consumer app in the suite.

## Product outcome

The user should be able to leave a direction such as “make daily logging simpler,” let the lead find and execute useful work, and return to an understandable record of proposals, decisions, implementation, and verification. The interface should make intervention easy without turning the user into a project manager.

Success means the lead can explain why it chose a task and an approach, the user can change that decision before completion, and the system reliably stops outdated work from being integrated.

## Confirmed requirements

- One conversational lead owns the project vision and backlog. The user steers or redirects it.
- The lead may originate, prioritize, and start tasks within that vision.
- Designer, coding, code-review, and UX-review roles collaborate under the lead.
- Claude and Codex must run concurrently on the same project. Roles are provider-independent, and either provider can supply the lead. One active lead owns the project at a time.
- Provider and model are configurable independently for every workflow step, including planning, design, implementation, review, and repair. Support mixed providers and different models within one task.
- Tasks accumulate over time and remain visible with stable identifiers.
- Every task has an attached specification with options, tradeoffs, a recommendation, and an explicit selected approach decided by the agent unless overridden by the user.
- Reviewing specifications is optional. Their existence is not an approval gate. Human-in-the-loop is optional throughout (user direction, 2026-09-29): the tool must be able to run end to end on autopilot at large scale, while every control (pause, review gates, artifact edits, resubmission) remains available.
- Users can pause, edit, resume, reprioritize, or cancel unfinished tasks and pause the project as a whole.
- Completed tasks retain their specifications, decision history, changes, and verification evidence.
- The lead's work should be autonomous within the project mandate and bounded by configured execution limits.

## Recommended initial scope

Start as a single-user local web application with a local service and durable database. Use one managed repository and one lead, with up to three concurrent workers initially. Keep the runtime behind an adapter so the interface does not depend on one agent provider.

Use a restrained visual direction: a neutral black-and-white palette (user direction, 2026-09-29; replaces the earlier warm neutrals), light/dark appearance, readable typography, familiar controls, and minimal navigation. Color is reserved for status meaning. The product is for understanding and controlling work, not visualizing an animated agent organization.

Included in the first usable release: lead conversation, board/list, specification viewer/editor, decision history, role/run visibility, actual pause/resume controls, project-wide pause, activity history, local persistence, and working Claude and Codex runtime integrations supporting concurrent mixed-provider teams.

Deferred: multiple users, hosted accounts, mobile app, plugin marketplace, arbitrary visual workflow builder, additional providers beyond Claude and Codex, remote always-on hosting, and automatic production publishing. SimpleApps consumer-app features remain in their own backlog.

## Main interface

### Project overview

Show a short editable vision, current focus, project run state, latest meaningful outcomes, and the lead conversation. Display a prominent Pause project control and whether the service is running, sleeping/offline, or waiting for input. New user direction becomes a recorded vision revision or task edit with links to affected work.

### Task board

Provide a compact list by default and an optional board view. Group by Proposed, Ready, Running, Reviewing, Paused, Blocked, and Done; cancelled work lives in history. Each card shows its title, intended user benefit, priority, state, current role and provider, latest activity, and chosen approach summary. Make the attached spec accessible in one click.

Filters: app/area, status, role, provider, and tasks changed since the user's last visit. Sorting: priority or latest activity. New proposals appear as soon as their first valid spec is published. A badge identifies decisions made since the user's last visit; viewing does not approve or pause a task.

### Task detail

Show the outcome and chosen approach first, followed by options and tradeoffs, acceptance criteria, activity, and changes. Offer Pause, Edit spec, Resume, Change priority, and Cancel as appropriate to the current state. Display the exact specification revision being executed and a visible diff between revisions.

The recommendation and selected approach are separate fields. If the user chooses an alternative, preserve the agent's original recommendation and record the override and reason. If the lead later changes its selection, it creates a new revision and explains why.

### Activity and team

Show which role is working on which task, meaningful milestones, blockers, review findings, and links to evidence. Include a concise “Since your last visit” summary. Expose detailed logs on demand; do not fill the primary UI with tool calls. Keep permanent role definitions distinct from temporary worker runs.

## Required task specification

Every published task must include:

| Field | Required content |
| --- | --- |
| Identity | Stable ID, title, author, creation time, current revision, and status |
| Why now | Observed problem or opportunity, evidence, relation to project vision, and priority rationale |
| Outcome | User job, expected benefit, and observable success criteria |
| Scope | Included behavior and explicit exclusions |
| Options | Normally two or three viable approaches; effort, UX impact, technical implications, risk, and reversibility for each |
| Agent decision | Recommended option, selected option, deciding role, concise rationale, uncertainty, and what evidence would change the decision |
| Acceptance | Specific observable checks for correctness and the user experience |
| Execution | Dependencies, affected areas, intended roles, estimated effort category, validation plan, and rollback/recovery approach |
| History | Append-only changes to scope and decisions, with author and reason |

Avoid fabricated alternatives for trivial tasks. If only one sensible approach exists, say why and compare against deferring the change. Unknown details must be explicit. A proposed investigation can have unresolved implementation details if its own outcome and validation are well-defined; create a follow-on implementation spec from its findings.

Before running, add exact workspace, allowed files, fixed interfaces, assignment revision, worker/run IDs, provider and model, routing rationale, and bounded effort. Attach results, reviewer findings, and checks to the completed revision. Historical completed tasks imported from the old board may be marked “legacy spec unavailable”; no active task may bypass the new spec requirement.

## Example decision specification

Task: Make empty library screens explain the next action.

Problem: a user with no saved items or no matching search results needs to know what happened and how to proceed. Reproduce the current behavior before implementation; this is an illustrative task, not a claim that the issue is still present.

| Option | Benefits | Tradeoffs |
| --- | --- | --- |
| A: Contextual empty states and one primary action | Small change, preserves the existing layout, gives a clear next step | Does not teach the full library workflow |
| B: Guided onboarding sequence | More instruction for a first-time user | Adds screens and setup time; larger implementation |
| C: Keep the interface unchanged | No implementation cost | Leaves the identified confusion unresolved |

Agent recommendation and selection: A, because a local explanation and one action fit SimpleApps' essential-feature direction. Accept when empty libraries and empty searches are distinguished, the main action works, populated states stay intact, and keyboard/screen-reader checks pass. The user may change the chosen approach, edit the copy requirements, or pause the task before completion.

## Lead and worker behavior

The lead reads project vision, feedback, code evidence, review findings, and the current backlog. It proposes a small number of useful tasks, publishes complete specs, selects approaches, orders dependencies, and starts eligible work. It can refine its plan without per-task permission, while respecting the user's holds and latest vision.

Typical flow: inspect → publish spec and decision → design if needed → implement → independent review → repair → verify and integrate. Parallelize independent tasks or file sets. Use a designer before significant interaction changes and a UX reviewer for the finished experience. Reviewers must not be the sole approver of their own implementation.

Use the existing role responsibilities in [TEAM.md](TEAM.md). Roles do not need permanent running agents; start workers only when useful work is ready. The lead owns conflicts and integration. No worker owns the global roadmap or resumes a user-paused task.

Keep each execution cycle bounded. Initial proposed defaults: three worker slots, one integration at a time, up to three new proposals per planning cycle, and a review checkpoint after each completed task. Runtime budgets and scheduling cadence are configurable; no unattended run begins until those settings are established. The lead can stop when no useful next action is justified rather than invent work to stay busy.

## Task states and controls

Normal progression is Proposed → Ready → Running → Reviewing → Done. Proposed has a complete published spec; Ready also has resolved dependencies and an execution assignment. The lead can advance both without user approval. There is no default waiting period; a task might finish before the user looks at it. A per-task Hold before start option provides a guaranteed review opportunity when wanted.

| Action | Required behavior |
| --- | --- |
| Pause a queued task | Persist a user hold and exclude it from dispatch |
| Pause active work | Persist the hold first; display Pausing; interrupt workers; checkpoint partial changes; show Paused only after termination/idle acknowledgment |
| Edit queued work | Save a new immutable spec revision and re-evaluate its dependencies and assignment |
| Edit active work | Freeze integration, stop affected workers, checkpoint, then execute a new revision; allow draft editing while stopping but no new dispatch until reconciliation |
| Edit paused work | Save the new revision and leave the user hold in place |
| Resume | Explicitly clear the applicable hold, check current files/dependencies, and requeue; never imply it is running until actually dispatched |
| Cancel | Stop affected work, retain its spec and partial artifacts, mark Cancelled, and block dependent tasks as appropriate |
| Pause project | Freeze dispatch and integration, request interruption of all project runs, and show any still stopping |
| Resume project | Clear the global hold while preserving individual task holds |

Pause is not rollback. External operations already accepted may finish; show their actual status and preserve a record. If pause or edit races with completion, serialize the decisions: either integration completed first and the task is Done, or the persisted hold/revision prevents integration. Never silently claim both. For completed work, edits create a linked follow-up task instead of rewriting the delivered specification.

Dependent tasks cannot start using unfinished results from paused or cancelled prerequisites. A partial artifact is not an accepted dependency unless the lead explicitly scopes and verifies it as a separate completed task.

## Architecture recommendation and tradeoffs

Recommendation: build a thin control application around existing coding-agent runtimes. Own task state, task specs, controls, scheduling, and evidence. Delegate model/tool execution to the runtime.

| Option | Advantages | Tradeoffs | Decision |
| --- | --- | --- | --- |
| Repository Markdown and Codex conversation | Available now, inexpensive, easy to inspect | No live buttons, transactional controls, or durable scheduler | Retain as the bridge and export format |
| Local control app with runtime adapter | Direct task controls, inspectable state, reuse existing coding tools | Requires a small service and verification of runtime capabilities | Recommended first implementation |
| Hosted control app and managed agents | Supports away-from-computer execution | Hosting, credentials, remote checkout, cost controls, and operational scope | Later option if local execution is insufficient |

Proposed components: TypeScript browser UI, local TypeScript service, SQLite task/spec/event store, and separate Codex and Claude runtime adapters. UI components should remain independent of the execution adapter. Exact libraries are implementation choices to settle after the first interface prototype.

Codex App Server is a candidate integration because it exposes Codex to custom clients. Verify the installed version's start, stream, steering, interrupt, resume, and subagent behavior in a small integration spike before depending on it. This spec does not assert that the present conversation exposes the same protocol or that a specific interruption guarantee already exists. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server)

For a later hosted implementation, evaluate the Agents API's managed sessions and orchestration rather than recreating a full agent harness. Provider availability, costs, and recovery semantics need validation at implementation time. [Official Agents API documentation](https://developers.openai.com/api/docs/guides/agents-api/overview)

The runtime adapter must support start, observe events, send steering, request interruption, query status, and reconcile/restart from a checkpoint. If an operation is unsupported, surface it explicitly and block dependent automation; never implement pause as a visual status change alone.

## Concurrent Claude and Codex execution

Role and provider are separate choices. The lead can use either provider and assign designers, coders, or reviewers to either. For example, a Claude lead could dispatch a Codex implementation worker while a Claude designer works on an independent task; a later Claude reviewer can inspect the Codex change. The reverse arrangement must also work. These examples are not claims that one provider is inherently better at a role.

The Orchestration service owns cross-provider dispatch, dependencies, pauses, file/worktree ownership, and integration. It must not rely on Codex native subagents being able to launch Claude, or Claude native subagents being able to launch Codex. Expose bounded task-management tools to the lead, validate its requests, and route each worker to the appropriate adapter. Native child delegation should be disabled or restricted unless every child can be tracked, budgeted, and interrupted through the same control layer.

### Provider selection and visibility

Project settings define the lead provider/model, defaults by role, enabled providers, total worker limit, and per-provider limits. Each task can override role defaults, and each workflow step can override the task setting. Resolution order: explicit step selection, task role override, project role default, then project default. Resolve to a concrete enabled provider/model before dispatch; missing or incompatible settings block that step with an actionable explanation. Auto routing chooses only among enabled configurations and records a concise reason, such as user preference, availability, or the need for independent review. Never silently substitute a different provider after a failure.

Display provider and model on each active run, plus connection health and usage where available. Authentication is configured separately for Claude and Codex. Do not assume a subscription to either chat product covers a custom runtime integration; verify supported authentication and billing during setup. API credentials remain outside the board, specs, and exported logs.

### Model configuration per step

Each task detail includes an editable Steps section. Every step has a stable ID, purpose, role, dependencies, provider, model, supported effort/settings, allowed tools, budget/checkpoint, and expected output. Show whether its selection is inherited or overridden and offer Reset to default. Choose models from the connected provider's available model catalog; do not hardcode a forever-current list or expose unsupported settings.

A simple example flow can select Claude model A for design, Codex model B for implementation, Claude model C for code review, and Codex model D for repair. These are illustrative slots, not actual model IDs or performance recommendations. Steps can be sequential or parallel according to dependencies. The first UI uses an ordered step list with dependency labels; a visual graph editor is unnecessary.

Project settings offer defaults by role and reusable workflow templates. The lead may propose step/model assignments and explain the choice in the task spec. Explicit user selections are pinned until the user changes them; the lead cannot override them to optimize cost or availability. If Auto is selected, the lead chooses from the enabled model allowlist and records the resolved model and reason before execution.

Resolve settings into an immutable execution snapshot for every attempt: provider, model identifier, effort and supported parameters, tools/permissions, task/spec revision, step revision, workspace, and artifact inputs. Default-setting changes affect steps not yet dispatched; never retroactively relabel earlier runs. Keep run attempts separate from the logical step so retries and model changes remain auditable.

Editing a queued step updates its configuration revision. Changing provider/model for a running step requests a pause, checkpoints its work, and starts a new attempt only after the old worker has stopped and ownership is reconciled. A paused step stays paused until resumed. Completed-step selections remain historical; rerunning creates a new attempt and marks dependent results for revalidation rather than silently treating them as current. Upstream artifact changes invalidate downstream acceptance evidence.

The board and activity feed show the actual model used on each step, not just the project's current default. Provider session state does not transfer between models/providers by assumption: use a new run with the versioned spec, artifacts, and handoff when compatibility is uncertain. A rate limit or unavailable model yields a blocked step unless a user-configured fallback policy explicitly permits another selection; record every fallback.

### Adapter choices

- Codex: evaluate Codex App Server for local execution, event streaming, steering, interruption, and session continuation.
- Claude: evaluate the Claude Agent SDK for local execution. It embeds the Claude Code agent loop and tools in TypeScript or Python, with sessions and permission controls. Validate streaming, interruption, process shutdown, resumption, and authentication against the installed SDK before exposing controls. [Official Claude Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview)

Both adapters emit normalized run events but retain provider-specific identifiers and raw diagnostic evidence. Publish a capability map for steering, interrupt, resume, usage reporting, and child-agent tracking. When live steering is unsupported, checkpoint and interrupt before a revised turn instead of pretending the instruction reached active work.

### Shared context and control

Pass each worker the same versioned assignment envelope: vision, task spec, selected option, acceptance criteria, artifact references, current branch/base, ownership, limits, and prior handoff summary. Provider session IDs and internal conversation state are not portable. A provider switch creates a new run from shared artifacts and a recorded handoff; it is not a native session resume.

Use isolated worktrees for concurrent writers and a stable commit/diff for review. Separate providers must never edit the same live checkout without enforced disjoint ownership. Maintain one integration queue across both providers. Spec revision checks, project/task holds, and the scheduler lease apply identically to both adapters.

Project pause reaches both providers and every tracked child. Display Pausing until all relevant runs acknowledge stopping; a timeout produces a visible control failure while integration remains frozen. A disconnected provider is not evidence that its worker stopped. Reconcile before redispatch or fallback. Provider outages block affected tasks while independent tasks may proceed on the healthy provider within the configured policy.

Switching the lead requires a checkpoint, suspension of new dispatch, and transfer of the single-lead lease. Preserve active worker ownership and feed the new lead the vision, board, decision history, outstanding controls, and run summaries. Never start two independent roadmap owners for the same project.

## Persistent state and consistency

Store projects, vision revisions, tasks, immutable spec revisions, option decisions, workflow templates, versioned steps and their model overrides, dependencies, role definitions, immutable run configuration snapshots, worker attempts, artifacts, review findings, control requests, and append-only events. Every run references the exact task/spec/vision revisions it received. Separate desired state, observed worker state, and integration state.

Use database transactions and expected-revision checks for edits, state transitions, and dispatch. Reject stale writes with a reload-and-reconcile path. A single scheduler holds a renewable project lease. Expired leases trigger reconciliation, not blind redispatch: inspect live processes, run IDs, branches, and artifacts before retrying. Control requests and dispatches have idempotency keys.

The database becomes the source of truth when the live board ships. Import the existing Markdown queue once, preserving IDs and identifying missing legacy specs; generate Markdown exports for repository visibility. Do not maintain an independently editable database and Markdown board with silent last-write-wins synchronization.

Use isolated worktrees for independent implementation runs and one integration owner. Keep task state separate from app data. Credentials stay with the runtime or protected configuration, not specs, logs, or repository commits. A local service should bind to loopback and protect control endpoints against requests from unrelated browser origins.

## Scheduling and recovery

While the service runs, task completion, a new task, a user message, or a cleared dependency can wake the lead. A configurable periodic planning check can propose new work from the vision and evidence. Coalesce events so multiple triggers do not launch duplicate leads.

The user can see and configure operating hours, concurrent workers, run duration, available usage/cost caps, and notification preferences. If the provider cannot expose reliable spend figures, show usage as unavailable and enforce measurable limits such as elapsed run duration and worker count instead of promising an exact dollar cap.

Closing the browser need not stop a separately running local service. Sleeping or shutting down the host prevents local progress; label this clearly and reconcile after restart. Always-on remote execution is a later deployment choice. Notify for meaningful completion, failure, or required input, not unchanged heartbeat checks.

## Acceptance scenarios

1. The lead creates a task from the vision with options and its chosen approach; the spec appears before execution starts.
2. The lead executes an eligible task without a per-task approval interaction and records its outcome.
3. The user opens a finished task days later and can inspect the executed spec revision, options, decision, changes, and review evidence.
4. Pausing queued work prevents dispatch. Pausing running work displays Pausing until the runtime acknowledges stopping; partial changes remain available.
5. Editing running work prevents old-revision results from integrating and creates a visible new revision.
6. Editing a paused task does not resume it. Resuming the project does not clear task-specific holds.
7. Concurrent pause/completion and edit/completion events produce one consistent result with an audit trail.
8. The service restarts during a run, reconciles its state, and does not duplicate execution or falsely report completion.
9. A reviewer finds a real issue, the lead assigns a fix, and the final checks reference the resulting artifact revision.
10. An unavailable runtime, denied operation, or offline host produces a truthful blocked/offline state, not simulated progress.
11. A Claude worker and a Codex worker execute concurrently in isolated workspaces and their results appear on one board with correct provider attribution.
12. A task implemented by one provider is reviewed by the other against the same immutable artifact and spec revision.
13. Project pause reaches both providers; a delayed acknowledgment leaves a truthful Pausing state and prevents integration.
14. A provider failure does not duplicate its work or silently switch its assignment; independent healthy-provider tasks can continue.
15. Either provider can serve as lead, and a checkpointed lead switch preserves worker ownership, task decisions, and user holds.
16. One task executes design, implementation, and review with different step-level provider/model selections, preserving each actual selection and artifact handoff.
17. Changing a role default updates unresolved queued steps while preserving explicit user overrides and all dispatched run snapshots.
18. Changing an active step model checkpoints and stops the previous attempt before another starts; rerunning an upstream step invalidates affected downstream verification.

Use deterministic fake-runtime tests for state races and failure recovery, plus one real-runtime end-to-end flow to establish actual execution and interruption behavior. Visual review covers light/dark appearance, keyboard access, readable option comparisons, and state/control feedback.

## Implementation milestones

| Milestone | Deliverable | Exit criteria |
| --- | --- | --- |
| 1: Interface prototype | Board, task detail, editable spec/options, per-step provider/model controls, decision history, and pause/resume feedback | User can inspect and redirect a clearly labeled simulated task; no live execution claims |
| 2: Durable task service | Database, versioned specs, controls, events, dependency rules, and fake runtime | Restart persistence and all control race tests pass |
| 3: Runtime integrations | One repository, lead conversation, Claude and Codex adapters, actual interruption and status | Run Claude and Codex workers concurrently; pause/resume each and the project with saved evidence |
| 4: Autonomous team loop | Provider-independent designer and review roles, agent-created tasks, serial integration, bounded scheduler | Vision → spec → mixed-provider implementation → independent review → verified completion works without task-by-task prompting; either provider can lead |
| 5: Reliability and usability | Recovery, operating controls, notifications, onboarding, import/export | Interruption/restart scenarios pass and the user can understand work without reading raw logs |

Recommended first build: Milestone 1. Use the task detail and specification editor as the central interaction, then add reliable runtime control behind it. Do not build a general graph editor or cloud deployment before the core review-and-steer loop is usable.

## Assumptions to revisit

The first version is local, single-user, and supports both Claude and Codex as first-class concurrent runtimes. Orchestration is the project name. The exact scheduling cadence and execution budget are not selected. The project lives at this repository, separate from the SimpleApps consumer apps. SimpleApps is its first managed repository.

The autonomous lead may create and execute ordinary reversible product work within the recorded vision. External publishing, purchases, destructive actions, and other actions outside existing authorization remain separate capabilities. No scheduling or external deployment is enabled by writing this spec.
