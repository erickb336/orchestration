---
id: attack-the-premise
name: Attack the premise
applyWhen: two or more fixes that share one premise have failed the same check or review.
source: pstack principle-attack-the-premise, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

When two or more fixes that share one premise have failed the same gate, suspect the premise, not the fixes. Each failure under a shared premise is evidence about the premise.

**What to do.**
- **Write the premise down.** It is the one sentence every failed fix assumed.
- **Before the next fix, list what each failed fix assumed and what still failed.** Look for the factor present every time: the same input, path, component or ordering.
- **Follow that factor.** If one thing is present in every failure, something puts it there. Find what does; that is the next "why" (see "fix root causes").
- **Remove the cause instead of compensating for it.** A retry, a fallback, a special case or a periodic cleanup leaves the cause in place and adds work on every run.

**Stop.**
- Do not start the next fix before the premise is written down and the list exists.
- If no factor is common to the failures, the premise is not the cause. Look elsewhere and keep the list as evidence.

Say in your output which premise you questioned and what you found.
