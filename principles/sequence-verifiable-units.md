---
id: sequence-verifiable-units
name: Sequence verifiable units
applyWhen: multi-step work (a sweep, a migration, a run of similar edits) or the order of commits in a change.
source: pstack principle-sequence-verifiable-units, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Order the work as a sequence of small units, each ending in a state you can check, and do not advance until the current one passes.

**Why.** A break caught at the unit that caused it is cheap to find. A break caught after a batch is buried, and you have already built on a broken base. A sequence a reviewer can replay turns "trust me" into "watch it go red, then green".

**Doing the work.** In a sweep, a migration or any run of similar edits, verify each change before starting the next. Each unit is a bracket: a known-good state, one change, the check, then on. Start from a clean base so every check measures against the real baseline. When a script does the edits, the per-unit check is nearly free; run it anyway.

**Delivery.** Order the units, and the commits that will carry them, so the sequence proves the work: the failing test first, then the fix; a removal before the reshape; the scaffold before the feature. Each unit stands on its own, and the sequence reads as an argument.

Keep each check real (see "prove it works").
