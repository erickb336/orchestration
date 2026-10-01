---
id: boundary-discipline
name: Boundary discipline
applyWhen: reviewing or writing validation, error handling or framework adapters.
source: pstack principle-boundary-discipline, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Put validation, type narrowing and error handling at the system's boundaries. Trust internal code. Keep business logic in pure functions; keep the shell thin and mechanical.

**Why.** Scattered validation is noisy, redundant, and gives a false sense of safety. Logic kept out of framework wiring can be tested without the framework.

**What to do.**
- At a boundary (command-line arguments, configuration files, external APIs, network input, files): validate, return errors, handle defensively.
- Inside: typed data, errors propagated, no re-validation. Trust the types.
- Across the boundary: expose domain concepts, not the boundary's private representation. Keep general mechanism inside and special-purpose policy at the edge.

**In practice.** Parse raw data into domain types at the boundary. Do not re-export transport, storage or framework types through the public surface. No redundant nil checks deep in call chains when the boundary already validated. Prompt construction, parsing and scoring are pure transforms.

**Two tests.** "Is this data crossing a boundary right now?" If not, validation is redundant. "Can this be a pure function the shell calls?" If yes, extract it.

As a reviewer, report input that reaches logic unvalidated.
