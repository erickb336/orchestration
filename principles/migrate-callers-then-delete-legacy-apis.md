---
id: migrate-callers-then-delete-legacy-apis
name: Migrate callers, then delete legacy APIs
applyWhen: a change introduces a new internal API while callers of the old one still exist.
source: pstack principle-migrate-callers-then-delete-legacy-apis, MIT, Copyright (c) 2026 Lauren Tan, github.com/cursor/plugins at 12d587d, adapted
---

When a new internal API is the right design, migrate its callers and remove the old one in the same change, instead of keeping a compatibility layer.

**The rule.**
- Do not keep an old path only because internal callers still use it.
- List the callers, migrate them, and delete the old API now.
- Treat a temporary adapter as exceptional and short-lived, not as architecture.
- Update tests to assert the new contract; delete tests that only protected the old implementation.

**Why.** Keeping both paths doubles the ways through the code, slows cleanup, and makes the code feel append-only.

**Where it applies.** Internal code that your change replaced, within this task. An external caller, or a public interface others depend on, is not yours to break: report it and leave it working. A repair stays within its task; a legacy path outside it is reported, not removed.

**Stop** when the old API has no callers left and is gone.
