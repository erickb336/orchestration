# Orchestrator team roles

The lead selects these roles when delegating. These are reusable role briefs, not installed custom Codex agent configurations or permanently running processes. Include the relevant brief and task context in the worker assignment. Roles are independent of provider: Claude or Codex may fill any role, including lead. Provider/model assignments are explicit run settings in the future application, not an instruction to override the models of agents in the current editing session.

| Role | Responsibility | Required result |
| --- | --- | --- |
| Lead | Own the product vision, visible backlog, task controls, dependencies, staffing, and integration | Prioritized, scoped tasks and verified outcomes; concise updates to the user |
| Designer | Reduce steps and decisions; define essential flows, states, copy, accessibility, and suite consistency | A concrete interaction specification, rationale, acceptance criteria, and visual evidence when relevant |
| Coder | Implement an assigned interaction or behavior in exclusively owned files | Changes, relevant checks, limitations, and any contract changes needing coordination |
| Code reviewer | Independently inspect correctness, data preservation, regressions, and test evidence | Actionable findings with locations and reproduction evidence; explicit gaps in verification |
| UX reviewer | Compare the implemented experience with the intended flow and simplicity criteria | Observed interaction/visual issues and checks for empty, loading, failure, correction, and success states |

The lead may run multiple coders or reviewers, but at most three workers concurrently in the present environment. Roles rotate through those slots. Do not spawn idle role agents merely to fill a team chart.

For UI work, the usual path is designer → coder(s) → independent code and UX review → lead integration. Small, well-defined fixes can skip a separate design assignment. Reviewers report findings to the lead and do not edit implementation unless explicitly reassigned. The designer writes only assigned design artifacts; the lead owns the board. Read-only roles may inspect existing output but must not mutate live user data.

Every worker receives task ID, revision, absolute workspace, allowed files, fixed interfaces, expected output, acceptance criteria, checks, and an effort checkpoint. A pause or revision from the lead supersedes the old assignment. Workers never resume themselves after a user pause or pick up unrelated backlog items.

## Mixed provider teams

Run Claude and Codex concurrently through separate adapters under the same lead and scheduler. Use a single project-wide worker cap, file/worktree ownership policy, integration queue, and pause mechanism. Cross-provider review is supported but does not replace evidence-based checks. Either provider may lead; only one lead has scheduling authority at a time. Record the provider, model, session/run IDs, and assignment revision for every worker.


## Single implementation by default

Assign one coder to each bounded implementation. Another provider can review that result; repair addresses concrete findings in the same line of work. Multiple coders normally own different tasks or disjoint parts of a change. There are no best-of comparisons and no parallel copies of a step (removed in ORC-025); a mixed-provider team splits work across tasks and steps.
