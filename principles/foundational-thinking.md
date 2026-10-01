---
id: foundational-thinking
name: Foundational thinking
applyWhen: before writing logic, when choosing core types and data structures or ordering scaffold against features.
source: pstack principle-foundational-thinking, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Structural decisions protect your options later. Code-level decisions protect simplicity.

**Data structures first.** Get the shape of the data right before writing logic. Define the core types early, trace every way the data is accessed, and choose structures that fit the dominant paths. Once the data is right, the code around it becomes obvious.

At code level, avoid repeating structure, not every line. Types and data models should converge. Three similar statements still beat a premature abstraction. Prefer explicit over clever.

**Shared state.** Before two actors share state, ask what happens when one changes it while the other reads it. If the answer is not "nothing", isolate.

**Scaffold first.** If something helps every later phase, do it first: build and test infrastructure, shared types, a check that runs on every change. Setup before features, tests before fixes. Keep each change small and single-purpose. Each increment should land one coherent abstraction or deepen one that exists, not spread a new capability across callers as special cases.

Subtraction comes before scaffolding: remove dead code first, then lay foundations.
