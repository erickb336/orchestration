---
id: exhaust-the-design-space
name: Exhaust the design space
applyWhen: a new interaction or an architectural choice has no precedent in the code.
source: pstack principle-exhaust-the-design-space, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

When the right answer is not obvious, do not build the first idea. Sketch two or three competing designs and compare them side by side before you commit. Building the wrong thing costs more than exploring three options. A second flavour of the first shape does not count as an alternative.

**When it applies.**
- A new interaction with no prior art in the code.
- An architectural choice with more than one viable approach.
- A product decision that depends on feel, not logic.

**When it does not.**
- Mechanical work with an established way of doing it.
- A bug fix or a refactor with a clear target state.
- A change where the constraints leave one viable approach.

**Stop** exploring once the options are concrete enough to compare and one is clearly better. Record the options you rejected and why, in a few lines, so the reviewer sees the choice.
