---
id: minimize-reader-load
name: Minimise reader load
applyWhen: reviewing or shaping code that is hard to follow.
source: pstack principle-minimize-reader-load, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Maintainability is the work a reader must do to understand the code. Track two things:
1. **Layers to trace.** How many indirections sit between the question and the answer.
2. **State to hold.** How much hidden or mutable context the reader must keep in their head.

**Why.** Code is read far more than it is written. The two axes are independent: a flat file with fifty globals is as hard as a six-layer adapter stack.

**What to do.**
- Collapse layers that cost more than they save: wrappers with one caller, adapters with no second implementation, indirection that was never needed.
- Make adjacent layers change the abstraction. A layer that repeats the same methods and arguments adds load without compression.
- Shrink the scope of state: pure functions over mutation, locals over fields, fields over module state. Derive instead of synchronising.
- Name the invariant once, at the boundary, not in every consumer.
- Before adding a layer or state, ask whether it saves at least as much reader load elsewhere.

**The test.** Can a new reader answer "where does X come from?" and "what can change X?" in thirty seconds? If not, say so in a finding.
