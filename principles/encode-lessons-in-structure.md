---
id: encode-lessons-in-structure
name: Encode lessons in structure
applyWhen: writing the same instruction a second time, or noticing a correction that keeps recurring.
source: pstack principle-encode-lessons-in-structure, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

Encode a recurring fix in a mechanism (a check, a type, a script, a lint rule) instead of in more text. Every error, correction and unexpected outcome is a lesson: capture it, put it in the right place, and close the loop.

**Why.** A written instruction needs the reader to notice, remember and comply. A mechanism enforces the rule without cooperation.

**What to do.** When you catch yourself writing the same instruction a second time:
1. Ask whether it can be a lint rule, a type, a runtime check or a script.
2. If yes, encode it and delete the instruction.
3. If it needs judgement, make the instruction prominent and add an example of the failure.

**Pick the strongest mechanism** the situation allows: a state that cannot be represented, then a check that fails the build, then a canonical helper, then a runtime check. Agents copy what the surrounding code does, so a weak guard becomes the next template.

**Close the loop.** A one-off correction gets a note; a recurring fix gets a check or a rule; a systemic issue changes the vision or a flow. Acknowledging without recording changes nothing.
