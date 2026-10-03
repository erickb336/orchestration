# Flows

**What this is.** A flow is the list of steps one task runs. The lead gives each task a flow, and each step is a fresh agent. Each flow is one short JSON file in this folder, checked against [`flow.schema.json`](flow.schema.json).

| Flow | For | Steps |
| --- | --- | --- |
| **Change** | Most code changes | implement → checks → code review and security review side by side → repair until clean → final checks → the lead verifies |
| **Bug fix** | A defect you can reproduce | reproduce → then as Change; the lead confirms the bug is gone |
| **Feature** | New screens, flows or copy | design → implement → checks with a UX review beside them → code and security review → repair → final checks → verify |
| **Design** | Settling a design first | design → UX review → revise → the lead writes the implementation brief |
| **Investigation** | The cause is unknown | gather evidence → review it → revise the report while the review finds something (up to three rounds) → the lead proposes a spec (no code) |
| **Goal** | Work too big for one task | the lead breaks it into child tasks that run in parallel, then evaluates and re-plans |

**Rules every flow keeps:**

- A code review and a security review run side by side on each change, so the security review adds one review run per round.
- Every review's findings go to a repair step, so no flow drops a finding ([ORC-028](../docs/tasks/ORC-028.md)).
- A step marked `"research": true` is read-only, whatever its role. If you allow it in Settings, its agent may start its provider's own helper agents ([ORC-031](../docs/tasks/ORC-031.md)). Investigation's evidence step is one. The tests refuse the mark on a step that writes.

**To change a flow,** edit its file and run `npm test`. The tests check the schema and the step graph.
