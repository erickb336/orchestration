---
id: prove-it-works
name: Prove it works
applyWhen: before declaring a task done, or when judging a claim that something works.
source: pstack principle-prove-it-works, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Verify the result by checking the real thing directly. Do not infer it from a proxy, a self-report or "it compiles".

**Why.** Unverified work has unknown correctness. Indirect checks (a file's timestamp, fresh-looking output, an agent's own report, a cached screenshot) feel cheaper than direct observation, and acting on a wrong inference costs far more.

**Check the real thing.**
- Run the feature, read the actual value, inspect the diff.
- Check that a process is alive directly, not through state derived from it.
- When a check fails, suspect the way you observed before you suspect the system.

**Script the check when you can.** The strongest proof is a command that re-runs the same comparison, not a one-time look. Write it, run it, and keep its output where a reviewer can re-run it.

**Stop** claiming when the evidence stops. Say what you ran and what you saw, and what you did not verify.
