# Task Specification Template

Use this structure for every new task. Publish a valid spec before dispatch. Preserve older revisions; never rewrite the executed revision after completion.

## Task identity

- ID and title:
- Author and timestamps:
- Status, priority, and priority rationale:
- Specification revision:
- Project vision revision:

## Problem and outcome

Observed evidence, why this matters now, the user's job, and the outcome that simplifies it. Label uncertainty and do not invent supporting observations.

## Scope

Included behavior, affected areas, and exclusions.

## Options and tradeoffs

| Option | Approach | User benefit | Effort | Costs and risks | Reversibility |
| --- | --- | --- | --- | --- | --- |
| A | | | | | |
| B | | | | | |

Normally include two or three viable choices. For a trivial task, explain why one approach is sensible and compare it with deferring the change.

## Decision

- Agent recommendation:
- Selected option:
- Decided by:
- Rationale and evidence:
- Uncertainty and what would change the decision:
- User override, if any:

## Acceptance and validation

Observable success criteria, relevant interaction states, checks, and evidence required for completion.

## Execution plan

Dependencies, roles, provider/model assignments and routing rationale, workspace, allowed files, fixed interfaces, effort checkpoint, recovery approach, and hold state. Record provider switches as new runs with artifact-based handoffs, not native session resumes. Before dispatch, attach task/spec revision and worker/run identifiers.

## Workflow steps and model selections

| Step ID | Purpose and role | Depends on | Provider | Model | Inherited or pinned | Output and checks |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Resolve each step to a concrete enabled provider/model before dispatch. Record supported settings, tools, effort/budget, and the task/spec/step revisions with each run attempt. Changes to active selections require a stopped, checkpointed attempt; completed attempts retain their original configuration. Revalidate dependent results when upstream artifacts change.

## Revision history

Revision, author, timestamp, what changed, why, and affected runs. Editing paused work preserves the hold. Editing completed work creates a linked follow-up task.

## Completion evidence

Changed artifacts, review findings and resolutions, actual checks, tested environment, limitations, and delivered revision.
