---
id: fix-root-causes
name: Fix root causes
applyWhen: debugging a failure or repairing a finding.
source: pstack principle-fix-root-causes, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Do not fix symptoms. Trace each problem to its root cause and fix it there.

**Why.** Symptom fixes accumulate. Each workaround makes the system harder to reason about, and the real defect stays. A root-cause fix is slower up front and cheaper in total.

**What to do.**
- Reproduce first.
- Ask "why" until you reach the cause.
- Do not add guards: a nil check that silences a crash is a symptom fix.
- If a workaround needs a paragraph to justify it, the code is wrong. Fix the code, not the comment.
- Fix every instance, not just this one: search for the same shape elsewhere.
- When stuck, measure instead of guessing: add logging, read the actual error.

**Failures after a restart.** Suspect stale persistent state before code: configuration files, caches, lock files, serialised state. If clearing state fixes it, validate that state.

**Stop** when the reproduction no longer fails for the reason you found, not when the symptom is hidden.
