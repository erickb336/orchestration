---
id: laziness-protocol
name: Laziness protocol
applyWhen: refactoring, judging a diff's size, or tempted to add an abstraction, a layer or a threaded signal.
source: pstack principle-laziness-protocol, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Aim for the most result with the least code and complexity.

- **Prefer deletion.** When asked to refactor or improve, look for removals before additions.
- **Keep the call hierarchy flat.** If answering a question means tracing through more than three files or layers, flatten it. A rich interface that hides real work is fine; a chain of thin layers is not.
- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result on.
- **Minimise the diff.** Make the smallest change that solves the problem. Fewer lines beat elegant boilerplate.
- **Question the threading.** If the task asks you to pass a new signal through types, schemas, pipelines or similar layers, look for a more direct path first.
- **Sweat the small leaks.** Remove tiny pass-throughs and duplicated choices before they spread.

**The test.** If a developer would find the code exhausting to maintain, it is a bad solution.
