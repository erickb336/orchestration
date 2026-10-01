---
id: subtract-before-you-add
name: Subtract before you add
applyWhen: ordering an addition, a refactor or a rewrite.
source: pstack principle-subtract-before-you-add, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

When evolving a system, remove complexity first, then build.

**Why.** Adding to a complex system compounds its complexity. Removing first leaves less code, shows the essential structure, and usually makes the next design obvious. Default to subtraction.

Treat simplification as a continual investment. Leave the design a little simpler, and a little more capable, behind the same or a smaller surface than you found it.

**What to do.**
- Remove before you construct.
- Cut before you polish: get to the minimum before investing in quality.
- Design for observed usage, not speculative edge cases.
- No speculative validators, parsers or guards beyond what the specification demands.
- Simplify instructions and prompts: remove redundant lines and excess templates.
- When a reference has no content of its own, delete it rather than leaving a stub.

**Stop** subtracting when the next removal would change behaviour the specification asks for. Report that instead.
