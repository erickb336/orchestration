# ORC-016 technical design: pipeline patterns

Companion to `docs/tasks/ORC-016.md` (spec r1). Branch `pipeline-patterns`, cut from `main` after the tasks in flight when the user asked are merged. Code is referred to by function name as of `4096d49` (state format 14). Line numbers are not used.

## 0. Decisions in one place

1. **The UI never edits a pipeline's structure.** A task's steps come from a pattern. Two things change the shape of a task's pipeline:
   - the service's own expansions (parallel copies, loop iterations, check rounds);
   - the user choosing another pattern, under the rules of §7.
2. **Patterns are JSON files.**
   - Built-in patterns are in `patterns/` in this repository, compiled into the app through JSON imports.
   - Your patterns are in `<dataDir>/patterns/` (`~/.orchestration/patterns/` by default), read at start and on Reload.
   - A file of yours with a built-in's id replaces that built-in.
3. **The catalog reaches the domain through the state** (`state.patterns`), as the model catalog does (`setCatalog`).
   - Only the server writes it, from files, through `store.update`.
   - No command accepts steps, templates or a catalog.
4. **Reuse is `extends` plus `stepOverrides` on existing steps.** `null` removes an optional field. There are no parameters, expressions or code.
5. **Validation runs in three layers:**
   - JSON Schema 2020-12 (`ajv`);
   - the existing graph rules (`validatePipeline`);
   - the pattern rules of §3.5.

   An invalid file is skipped and listed with its file, line and column. When a broken file of yours replaces a built-in, the built-in stays in effect. Start never fails because of a pattern file.
6. **Every pattern has an audience.**
   - "Standard": not experimental, no pauses for you, and an independent code review of any code change.
   - "User-only": everything else.
   - The lead, breakdown items and the project default may use standard patterns only.
7. **Service-owned pipelines stay in code.** `revert`, `delivery-review` and `delivery-checks` move from `templates.ts` to `internalPatterns.ts`, and no file may take those ids. The catalog ids the service creates tasks from (`change`, `bugfix`) may be replaced only by a standard pattern that changes code.
8. **Model choice is unchanged.** These all stay exactly as they are:
   - `setStepSelection`, `setTaskRoleOverride`, `setRoleDefault`, `setProjectDefault`;
   - `resolveStep`;
   - the pickers on the task page.
9. **Changing a task's pattern** is allowed before the task has run, or while it is Paused with no run active.
   - The pipeline starts over, and nothing done earlier is consumed again.
   - Two extra guards reject any result from before the change.
10. **Removed:**
    - the commands `setPipeline`, `saveTemplate`, `deleteTemplate` and `restoreBuiltInTemplates`;
    - `PipelineEditor.tsx`;
    - template editing in Settings;
    - `WorkflowTemplate` and `Project.templates`.

    `M.setPipeline` stays as an internal domain function that tests use.
11. **Migration 14 → 15** retires custom and edited templates into `state.retiredTemplates`. The server writes each of them once as a file of yours at the next start, never overwriting. Tasks are not touched.
12. **Provenance and outcomes.**
    - Each pattern application records a `PatternRef`: id, hash, `extends` chain, source and `chosenBy`.
    - A `TaskOutcome` snapshot is written once when a task becomes done or cancelled. The store applies it in one place.
    - Field names map onto the OpenTelemetry GenAI conventions.
13. **New libraries**, all under permissive licences, with exact versions pinned:
    - `ajv` (MIT);
    - `jsonc-parser` (MIT);
    - `@noble/hashes` (MIT);
    - `canonicalize` (Apache-2.0).

## 1. Principles

1. **Structure comes from reviewed files; the UI only chooses.** Built-in files change through commits and pull requests, and your files are yours.
2. **Nothing a client sends becomes steps.**
3. **Tasks own copies.** A file change or a Reload never changes a task that already exists.
4. **Behaviour is preserved.** The built-in patterns are a 1:1 transcription of today's built-in templates, and the service keeps creating the same shapes.
5. **Files fail soft, code fails hard.** A broken file of yours is skipped and listed. A broken built-in fails the test suite and never ships.
6. **Record now, compare later.** Provenance and outcomes are written from now on, and the comparison view is ORC-018.
7. **Reuse the machinery.** Pipeline revisions, stale-result checks, holds, `supersedeDecisions` and `validatePipeline` all stay.

## 2. Invariants (each has a test, §17)

- **P1 No client-supplied structure.**
  - No command in `COMMANDS` accepts step definitions, templates or a catalog.
  - `createTask` ignores a `steps` argument.
  - `state.patterns` is written only by `M.setPatternCatalog`, which no command calls.
- **P2 Model choice unchanged.** Per-step pins, task role overrides, project role defaults and the project default resolve exactly as before (the `resolveStep` order).
- **P3 Copy on use.** Reloading the catalog or changing a file never changes any task's `steps`, `pipelineHistory` or `pattern`.
- **P4 Built-in equivalence.** The steps of the built-in patterns `change`, `feature`, `bugfix`, `investigation`, `design` and `goal`, and of the internal `revert`, `delivery-review` and `delivery-checks`, equal the format-14 templates (`V14_TEMPLATES`) when ORC-016 ships.
- **P5 Standard only for agents.** Lead proposals, breakdown items, the project default and the default fallback resolve only to standard patterns. Breakdown items additionally never resolve to a pattern that breaks down.
- **P6 Service shapes fixed.**
  - `revert`, `delivery-review` and `delivery-checks` come from `internalPatterns.ts`, and a file with one of those ids is refused.
  - The effective `change` and `bugfix` are standard, change code and do not break down.
- **P7 Safe pattern change.** `changePattern` succeeds only when the task has never run, or is held with no active attempt. After it, `reportCompletion` and `reportRunFailed` cannot apply a result from an attempt started before the change.
- **P8 No reuse across patterns.** After a change, no step consumes an artifact produced under the earlier pattern, and `editArtifact` refuses such artifacts.
- **P9 Migration leaves tasks alone.** Migration 14 → 15 changes no task's `steps`, `pipelineRev`, `pipelineHistory`, pins or state, and a run active before the upgrade completes normally after it.
- **P10 No overwrite.** Exporting retired templates never overwrites a file, and each template is exported or marked failed exactly once.
- **P11 One outcome per settle.**
  - A task that becomes done or cancelled gets exactly one `outcome` in that transaction.
  - Tasks already settled at format 14 get none.
  - Whole-state replacements (`resetSampleData`, `initProject`) record none.
- **P12 Loading never blocks start.** Every error in a file of yours is listed. The built-in catalog is always present.
- **P13 Provenance everywhere.** Every path that creates a task or applies a pattern sets `task.pattern`. Every pipeline revision that applies a pattern carries `pattern`.

## 3. Pattern files

### 3.1 Layout

```
patterns/                          built-in, in the repository
  pattern.schema.json              JSON Schema 2020-12
  change.json  change-cross-review.json  change-best-of-two.json  change-lean.json
  feature.json  feature-design-gate.json
  bugfix.json  investigation.json  design.json
  goal.json  goal-plan-gate.json
src/domain/builtInPatterns.ts      the manifest: one JSON import per built-in file
src/domain/patterns.ts             pure: types, resolver, rules, flags, hashing, lookups, summaries
src/domain/internalPatterns.ts     revert, delivery-review, delivery-checks (moved from templates.ts)
server/patterns.ts                 I/O: read your directory, parse, ajv, schema copy, export retired templates
server/legacyTemplates.ts          frozen V13_TEMPLATE_STEPS (moved from store.ts) and V14_TEMPLATES
<dataDir>/patterns/                yours; the app keeps a copy of pattern.schema.json here
```

`src/domain/templates.ts` is deleted.

`tsconfig.json` and `tsconfig.server.json` gain `"resolveJsonModule": true`. The first task of step B1 is to confirm that `tsx`, Vite and Vitest import the JSON with the same shape `tsc` expects. If one does not, use import attributes (`import x from "…json" with { type: "json" }`).

### 3.2 Format and parsing

- **Built-in files** are strict JSON. A test runs `JSON.parse` on each, because the app compiles them in.
- **Your files** are `.json` or `.jsonc`, parsed with `jsonc-parser`: `parseTree(text, errors, { allowTrailingComma: true, disallowComments: false })`. A parse error reports its line and column (from the offset).
- **The file name must be `<id>.json` or `<id>.jsonc`.** One name, one pattern.
- **Limits:**
  - at most 100 files and 64 KiB per file;
  - at most 30 steps per pattern;
  - `extends` at most 3 deep.

  Subdirectories, dotfiles and other extensions are ignored. A symlink is followed only to a regular file.
- **`$comment`** (a string) is allowed at the top level and on every step, and it is ignored. Built-in files use it in place of comments.

### 3.3 Fields

Top level:

| Field | Required | Meaning |
| --- | --- | --- |
| `$schema` | no | `"./pattern.schema.json"` |
| `$comment` | no | Notes; ignored |
| `id` | yes | `^[a-z][a-z0-9-]{1,39}$`; equals the file name |
| `name` | yes | At most 60 characters, shown in pickers |
| `description` | yes | What it does, at most 300 characters |
| `whenToUse` | yes | When to choose it, at most 300 characters |
| `order` | no | Sort key, default 100 |
| `experimental` | no | `true` labels it an experiment |
| `hypothesis` | when `experimental` | At most 300 characters; shown in the picker |
| `steps` | base patterns only | 1–30 steps |
| `extends` | variants only | The id of another pattern |
| `stepOverrides` | variants only | `{ "<step id>": { <step fields> } }` |

Step fields are the `StepDef` fields: `id`, `purpose`, `role`, `dependsOn`, `inputs`, `outputs`, `runIf`, `gate`, `iterate`, `parallel`, `waitForChildren`, `independentOf` and `checks` (`onFail` only). `copyOf` and `iteration` are set by the service and are refused. So is `checks.only`, because check ids belong to each project.

### 3.4 Variants: `extends` and `stepOverrides`

To resolve a variant:

1. Resolve the base: its effective version (§4.2), which may itself be a variant. The chain may be at most 3 deep. A cycle is an error on every member.
2. Copy the base's steps. For each entry in `stepOverrides`:
   - the step id must exist in the base;
   - `null` removes an optional field (`runIf`, `gate`, `iterate`, `parallel`, `waitForChildren`, `independentOf`, `checks`); `null` on a required field is an error;
   - any other value replaces the field wholesale: arrays and objects are replaced, not merged;
   - `id` cannot be overridden.
3. Nothing at the top level is inherited: `name`, `description` and `whenToUse` are required again, and `order`, `experimental` and `hypothesis` come from the variant only. The rules of §3.5 still apply to the result, so a variant of a best-of pattern must say `experimental: true` itself.
4. The resolved pattern records its chain, nearest first: the variant's own file, then each base.

A variant cannot add or remove steps. Write a full pattern file for that.

### 3.5 Validation, flags and audience

The stages, in order. The first failure skips the file:

| Stage | Where | Checks |
| --- | --- | --- |
| A Parse | server | JSONC syntax (your files); `JSON.parse` (built-in, in tests) |
| B Schema | server (`ajv`) | Types, lengths, enums, `additionalProperties: false`, base xor variant, `hypothesis` required with `experimental: true` |
| C Identity | pure | `id` equals the file name; not `revert`, `delivery-review` or `delivery-checks`; unique among your files (a duplicate skips both files) |
| D Resolve | pure | `extends` target exists; override step ids exist; `null` only on optional fields; depth; cycles |
| E Graph | pure | `validatePipeline(steps)`: errors skip the file; warnings stay on the pattern as `warnings` |
| F Pattern rules | pure | See below |

Pattern rules:

- **F1 Reserved step ids.** No step id ends in `-c<digits>` or `-i<digits>`. Expansions create those ids, and `baseId` strips the suffix.
- **F2 No `checks.only`.** The schema already refuses it. The message adds: "check commands belong to each project; patterns run every configured check".
- **F3 Best of N is an experiment.** Any `parallel.mode: "best-of"` requires `experimental: true`, because `AGENTS.md` allows competing implementations only when the user chooses them.
- **F4 An agent chooses.** The step that chooses among best-of candidates (the first later step that reads the group) must not have the role `checks`, because a service run never reports `chosen`.
- **F5 Service ids stay safe.** The effective `change` and `bugfix` must be standard (below), produce a `code-change` and not break down. Otherwise your file is skipped and the built-in is kept.

Derived flags, stored on the resolved `Pattern`:

- `breaksDown`: an output has the kind `breakdown`.
- `pausesForYou`: a step has `gate: true`.
- `unreviewed`: some step outputs `code-change`, and no `code_reviewer` step has an input of kind `code-change`.
- `bestOf`: a step is parallel and best-of.
- `needsProviders`: the union of `parallel.providers`. The picker warns when one of them is disabled.

**Audience:** `"standard"` when the pattern is not experimental, not `pausesForYou` and not `unreviewed`; otherwise `"user-only"`. A standard pattern of yours may be used by the lead, so the experimental flag is also how you keep one of yours away from the lead.

Who may use what:

| Who | Allowed patterns |
| --- | --- |
| You, at New task or Change pattern | Any catalog pattern; not internal ones |
| The lead's proposals | Standard |
| Breakdown items | Standard, and not `breaksDown` |
| Project default | Standard |
| Service-created fix tasks | The effective `change` and `bugfix` (standard by F5); internal ones |

**When a file of yours fails.** If it replaces a built-in and fails at stage C, D, E or F, the built-in stays in effect, and the error's `effect` says `"built-in kept"`. A variant that extends the failed id extends the built-in.

### 3.6 The catalog

The six standard base patterns carry today's templates unchanged (P4). Their descriptions are today's template descriptions.

| Order | Id | Name | Steps | Audience | When to use |
| --- | --- | --- | --- | --- | --- |
| 10 | `change` | Change | S1 Implement → C1 Checks → S2 Code review → S3 Repair (if findings; repeats from C1, up to 3) → C2 Final checks → S4 Verify | Standard, the default | Most code changes: a fix you already understand, a refactor, a small feature without new screens or flows |
| 15 | `change-cross-review` | Change, reviewed by the other provider | Change, with `S2.independentOf: "writer"` | Standard | You want the code review done by the provider that did not write the change, whichever wrote it. This applies while Settings → Delivery's reviewer is "another provider" (the default); a pin or a task role override still wins (`resolveStep`). |
| 20 | `feature` | Feature | S1 Design → S2 Implement → C1 Checks → S3 Code review, with S4 UX review in parallel → S5 Repair (if findings; repeats from C1, up to 3) → C2 Final checks → S6 Verify | Standard | User-facing work with new screens, flows or copy, where a design and a UX review are worth their cost |
| 25 | `feature-design-gate` | Feature, pause after design | Feature, with `S1.gate: true` | User-only (pauses for you) | You want to read or edit the design before code is written |
| 30 | `bugfix` | Bug fix | S1 Reproduce and diagnose → S2 Fix → C1 → S3 Code review → S4 Repair (loop) → C2 → S5 Verify the reproduction no longer fails | Standard | A defect you can reproduce |
| 40 | `investigation` | Investigation | S1 Investigate → S2 Review the evidence → S3 Propose a follow-up spec | Standard | The cause or the right change is unknown; the result is a spec, not code |
| 50 | `design` | Design | S1 Design → S2 UX review → S3 Revise (if findings; repeats from S2, up to 3) → S4 Implementation brief | Standard | Settle and review a design before anyone implements it |
| 60 | `goal` | Goal | S1 Plan, breaking down into child tasks → S2 Evaluate once the child tasks finish (repeats, up to 5) → S3 Report | Standard; never for child tasks | Work too large for one task |
| 65 | `goal-plan-gate` | Goal, review the plan first | Goal, with `S1.gate: true`. Child tasks are created from your (possibly edited) list when you resume, which is today's `pendingBreakdowns` behaviour. | User-only (pauses for you) | You want to check the list of child tasks before any exists |
| 90 | `change-best-of-two` | Change, best of two implementations | S1 Implement ×2 (best of, alternating providers) → S2 Compare and choose → C1 → S3 Code review → S4 Repair (loop) → C2 → S5 Verify | User-only, experimental | A hard change where two first attempts are worth about twice the implementation cost |
| 95 | `change-lean` | Change without the lead's verification | Change without S4: it ends with C2 Final checks | User-only, experimental | Measure whether the verification run is worth its cost |

Hypotheses:

- `change-best-of-two`: "For hard changes, two independent first implementations, compared before review, give a better starting change than one. It costs about one more implementation and one comparison run."
- `change-lean`: "Final checks and a clean independent review are enough evidence. The lead's verification run adds cost without changing outcomes." Nothing reads `verification` artifacts today; ORC-013 observed that the verify step's output "gates nothing".

**Rejected: "Quick change (no separate review)".** It removes the independent code review, which `TEAM.md` and `PROJECT_SPEC.md` require ("Reviewers must not be the sole approver of their own implementation"; "followed by independent review"). Change is already cheap when the review is clean: C1 and C2 skip while checks are off, and S3 runs only on findings. `change-lean` tests the one optional run, and keeps the review. A file of yours may still omit the review. It is then flagged `unreviewed`, it is user-only, and pull-request delivery still adds its own independent review before an automatic merge.

**Internal (code, not in the catalog):** `revert`, `delivery-review`, `delivery-checks`, as in `templates.ts` today.

### 3.7 Examples

`patterns/change.json`. The steps are transcribed from `templates.ts`; only the start is shown:

```json
{
  "$schema": "./pattern.schema.json",
  "id": "change",
  "name": "Change",
  "order": 10,
  "description": "Code change without interaction design: implement, checks, review, repair if needed, final checks, verify.",
  "whenToUse": "Most code changes: a fix you already understand, a refactor, a small feature without new screens or flows.",
  "steps": [
    {
      "id": "S1", "purpose": "Implement", "role": "coder", "dependsOn": [], "inputs": [],
      "outputs": [{ "name": "change", "kind": "code-change" }, { "name": "handoff", "kind": "handoff" }]
    },
    { "id": "C1", "purpose": "Run the project's checks", "role": "checks", "dependsOn": ["S1"], "...": "as in templates.ts" }
  ]
}
```

`patterns/feature-design-gate.json`, a whole variant:

```json
{
  "$schema": "./pattern.schema.json",
  "id": "feature-design-gate",
  "name": "Feature, pause after design",
  "order": 25,
  "description": "Feature that pauses after the design so you can read or edit it before implementation starts.",
  "whenToUse": "You want to read or edit the design before code is written.",
  "extends": "feature",
  "stepOverrides": { "S1": { "gate": true } }
}
```

`patterns/change-best-of-two.json`, a full experimental pattern:

```json
{
  "$schema": "./pattern.schema.json",
  "id": "change-best-of-two",
  "name": "Change, best of two implementations",
  "order": 90,
  "experimental": true,
  "hypothesis": "For hard changes, two independent first implementations, compared before review, give a better starting change than one. It costs about one more implementation and one comparison run.",
  "description": "Two agents implement the change separately, one on each provider; a reviewer compares them and chooses one; then checks, review, repair if needed, final checks, verify.",
  "whenToUse": "A hard change where you want to compare two first attempts. Not for everyday work.",
  "steps": [
    { "id": "S1", "purpose": "Implement", "role": "coder", "dependsOn": [], "inputs": [],
      "outputs": [{ "name": "change", "kind": "code-change" }, { "name": "handoff", "kind": "handoff" }],
      "parallel": { "count": 2, "mode": "best-of", "providers": ["claude", "codex"] } },
    { "id": "S2", "purpose": "Compare the two implementations and choose the better one", "role": "code_reviewer", "dependsOn": ["S1"],
      "inputs": [{ "step": "S1", "output": "change" }, { "step": "S1", "output": "handoff" }],
      "outputs": [{ "name": "comparison", "kind": "report" }] },
    { "id": "C1", "purpose": "Run the project's checks", "role": "checks", "dependsOn": ["S2"],
      "inputs": [{ "step": "S1", "output": "change" }], "outputs": [{ "name": "checks", "kind": "check-results" }], "checks": { "onFail": "findings" } },
    { "id": "S3", "purpose": "Code review", "role": "code_reviewer", "dependsOn": ["C1"],
      "inputs": [{ "step": "S1", "output": "change" }, { "step": "S1", "output": "handoff" }, { "step": "S2", "output": "comparison" }, { "step": "C1", "output": "checks" }],
      "outputs": [{ "name": "findings", "kind": "review-findings" }] },
    { "id": "S4", "purpose": "Repair review findings and failing checks", "role": "coder", "dependsOn": ["S3"],
      "inputs": [{ "step": "S1", "output": "change" }, { "step": "S3", "output": "findings" }, { "step": "C1", "output": "checks" }],
      "outputs": [{ "name": "change", "kind": "code-change" }],
      "runIf": [{ "step": "C1", "output": "checks" }, { "step": "S3", "output": "findings" }],
      "iterate": { "from": "C1", "max": 3 } },
    { "id": "C2", "purpose": "Final checks", "role": "checks", "dependsOn": ["S4"],
      "inputs": [{ "step": "S1", "output": "change" }, { "step": "S4", "output": "change" }],
      "outputs": [{ "name": "final", "kind": "check-results" }], "checks": { "onFail": "block" } },
    { "id": "S5", "purpose": "Verify and integrate. Service check results are the record of what ran; do not say tests passed unless a check result shows it.", "role": "lead", "dependsOn": ["C2"],
      "inputs": [{ "step": "S1", "output": "change" }, { "step": "S4", "output": "change" }, { "step": "S3", "output": "findings" }, { "step": "C2", "output": "final" }],
      "outputs": [{ "name": "verification", "kind": "verification" }] }
  ]
}
```

Why it is shaped like this:

- S2 is the choosing step, so F4 holds.
- S1 sits outside the loop, so the rule against parallel steps inside a loop holds.
- After S2 chooses, C1, S3, S4, C2 and S5 receive only the chosen candidate (`consumedInputs`). Only the chosen change is integrated, as ORC-007 does today.
- When an iteration is added, S1's two `change` inputs are remapped to the repair's change and de-duplicated (`expandIteration`, `uniqueRefs`).

A file of yours, the example the README annotates (`~/.orchestration/patterns/bugfix-pause-after-repro.jsonc`):

```jsonc
{
  "$schema": "./pattern.schema.json",   // the app keeps a copy of the schema next to your files
  "id": "bugfix-pause-after-repro",      // must match the file name
  "name": "Bug fix, pause after the reproduction",
  "description": "Bug fix that stops after the reproduction so you can read it before the fix starts.",
  "whenToUse": "Bugs where a wrong reproduction would waste the fix.",
  "extends": "bugfix",                   // start from the built-in Bug fix
  "stepOverrides": {
    "S1": { "gate": true },              // pause after S1, Reproduce and diagnose
  },                                     // trailing commas are fine in your files
}
```

### 3.8 The schema (`patterns/pattern.schema.json`)

```
$schema: https://json-schema.org/draft/2020-12/schema
type: object, additionalProperties: false
required: [id, name, description, whenToUse]
properties: $schema, $comment, id, name, description, whenToUse, order, experimental, hypothesis, steps, extends, stepOverrides
oneOf:
  - required: [steps];   not: anyOf [required [extends], required [stepOverrides]]
  - required: [extends]; not: required [steps]
if: { properties: { experimental: { const: true } }, required: [experimental] }  then: { required: [hypothesis] }
dependentRequired: { hypothesis: [experimental], stepOverrides: [extends] }
$defs:
  patternId:  string, pattern ^[a-z][a-z0-9-]{1,39}$
  stepId:     string, pattern ^[A-Za-z][A-Za-z0-9-]{0,31}$
  role:       enum = STEP_ROLES          (lead, designer, coder, code_reviewer, ux_reviewer, checks)
  kind:       enum = ARTIFACT_KINDS
  provider:   enum = PROVIDERS           (claude, codex)
  ref:        { step: stepId, output: string }, additionalProperties false
  output:     { name: ^[a-z][a-z0-9-]*$, kind }, additionalProperties false
  step:       required [id, purpose, role, dependsOn, inputs, outputs]; additionalProperties false;
              gate: const true; iterate { from: stepId, max: integer 1..10 };
              parallel { count: integer 2..5, mode: copies|best-of, providers?: provider[] (unique) };
              waitForChildren: const true; independentOf: const "writer";
              checks { onFail: findings|block }, additionalProperties false; $comment
  stepOverride: the step's properties, all optional, each optional one also allowing null; no id
```

A test checks that the three enums equal `STEP_ROLES`, `ARTIFACT_KINDS` and `PROVIDERS`.

## 4. Loading and the catalog in the state

### 4.1 Pure resolver (`src/domain/patterns.ts`)

```ts
export interface PatternFile {
  file: string;                    // display path: "patterns/change.json", "~/.orchestration/patterns/x.jsonc"
  source: "built-in" | "local";
  raw: RawPattern;                 // already schema-valid (the server ran ajv; built-ins are proven by tests)
}
export function resolveCatalog(files: PatternFile[], preErrors: PatternError[] = []): { patterns: Pattern[]; errors: PatternError[] };
export function builtInCatalog(): PatternCatalog;   // resolveCatalog(BUILT_IN_FILES), memoised; used by seeds, migration and tests
export function patternSummary(steps: StepDef[]): string;   // "S1 Implement → C1 Checks → …", shared by the UI and the lead envelope
export function patternRef(p: Pattern | InternalPattern, chosenBy: ChosenBy): PatternRef;
```

How `resolveCatalog` works:

1. Index built-in files by id, and your files by id. A duplicate id among your files is an error on both, and neither loads.
2. `resolve(id)` is memoised and guarded by a visiting set:
   - if a file of yours has this id, try it: stages C to F, with the base resolved through `resolve(base)`; if it succeeds, return it, marked `replacesBuiltIn` when a built-in has the same id;
   - if it fails, record the error, with `effect: "built-in kept"` when a built-in exists;
   - otherwise, or after such a failure, try the built-in.
3. Compute the flags, the audience, the `hash` and the chain (§4.4).
4. Sort by `order`, then by name.

### 4.2 Built-in manifest (`src/domain/builtInPatterns.ts`)

```ts
import change from "../../patterns/change.json";
// … one import per file …
export const BUILT_IN_FILES: PatternFile[] = [
  { file: "patterns/change.json", source: "built-in", raw: change as RawPattern },
  // …
];
```

A test lists `patterns/*.json` (except the schema) and asserts that each appears in the manifest once.

### 4.3 Server loader (`server/patterns.ts`)

```ts
export function loadPatternCatalog(dir: string, nowIso: string): PatternCatalog;
export function exportRetiredTemplates(store: Store, dir: string): void;   // §9.3
```

`loadPatternCatalog`, in order:

1. `mkdirSync(dir, { recursive: true })`. Write `dir/pattern.schema.json` when it is missing or differs from the bundled schema, so `"$schema": "./pattern.schema.json"` works in your files too. That file is the app's: it is rewritten, and it is not a pattern.
2. Validate each built-in raw object with the compiled `ajv` validator. A failure becomes a `PatternError` with no position. This cannot happen in a tested build.
3. List `dir` (§3.2 limits). For each file of yours:
   - read the text and run `parseTree`, turning syntax errors into line and column;
   - `getNodeValue`, then `ajv`;
   - map each `ajv` error's `instancePath` (a JSON Pointer) to a node with `findNodeAtLocation(tree, path)`, and its offset to a line and column. Messages read like "`steps[2].role`: must be one of lead, designer, coder, code_reviewer, ux_reviewer, checks".
4. `resolveCatalog([...builtIns, ...yours], parseAndSchemaErrors)`.
5. Return `{ loadedAt, localDir: display(dir), patterns, errors }`.

`ajv` is compiled once: `new Ajv2020({ allErrors: true, strict: true })` (from `ajv/dist/2020`). It runs only in the server and the tests, never in the UI bundle.

### 4.4 Hashing

- `hash`: SHA-256 hex of `canonicalize(steps.map(toDef))`, where `steps` are the resolved steps. It identifies what runs: the purposes (the workers' instructions), roles, the graph, gates, loops and parallelism. Name, description and comments do not count.
- `chain[i].fileHash`: SHA-256 hex of `canonicalize(raw)` for each file in the chain. Any edit to a file in the chain changes it, but whitespace and comments do not.
- Both use `@noble/hashes/sha2` and `canonicalize` (RFC 8785), both pure, so the same code runs in the server, the seed, the migration and the tests.
- The UI shows the first 8 hex characters.

### 4.5 State and `setPatternCatalog`

```ts
state.patterns: PatternCatalog            // machine-level, like the files; initProject leaves it alone
M.setPatternCatalog(s, catalog, now)      // never a command
```

It replaces `state.patterns`. It records a `config` event only when the set of `(id, source, hash)` or the errors changed, for example "Patterns loaded: 11 (2 yours); 1 file has errors". It changes no task (P3).

### 4.6 Start and Reload

In `server/app.ts`, after `new Store(...)` and before `scheduler.start()`:

1. `exportRetiredTemplates(store, join(dataDir, "patterns"))` (§9.3).
2. `store.update((s) => M.setPatternCatalog(s, loadPatternCatalog(dir, now), now), now)`.

Errors are logged in one line each, as `[orchestrator] patterns: <file>:<line>:<col> <message>`.

`POST /api/patterns/reload` (new, in `server/http.ts`):

- it goes through the same Host, Origin, client-header and JSON-body checks as every other POST;
- its body is `{}`;
- it runs step 2 and returns `{ loadedAt, patterns: n, errors: m }`;
- it works in fake and real mode. Repeating it changes nothing.

There is no file watch (spec: options). If one is added later, use `chokidar` with `awaitWriteFinish`.

### 4.7 Lookups (pure, in `patterns.ts`)

- `findPattern(s, id)`: from `s.patterns.patterns`.
- `effectiveDefault(s)`: `project.defaultPatternId` when that pattern exists and is standard, else `change`.
- `childDefault(s)`: `effectiveDefault(s)` unless it breaks down, else `change`.
- `servicePattern(s, "change" | "bugfix")`: the catalog entry, falling back to `builtInCatalog()`'s entry if the state's catalog lacks it.
- `internalPattern(id)` and `patternSteps(id)` (built-in or internal steps, cloned). The latter replaces `templateSteps` in tests and seeds.
- `eligible(p, who: "lead" | "child" | "default")`, from the table in §3.5.

## 5. Data model (`src/domain/types.ts`)

Removed: `WorkflowTemplate`, `Project.templates`.

Added:

```ts
export type ChosenBy = "user" | "lead" | "breakdown" | "default" | "service" | "follow-up" | "migration";
// A later automatic assignment (spec: excluded) adds "rotation" plus PatternRef.assignment = { experimentId, arm }.

export interface PatternChainEntry { id: string; source: "built-in" | "local"; file: string; fileHash: string }

export interface Pattern {
  id: string; name: string; description: string; whenToUse: string; order: number;
  experimental?: true; hypothesis?: string;
  source: "built-in" | "local";
  replacesBuiltIn?: true;
  file: string;
  chain: PatternChainEntry[];          // nearest first
  hash: string;
  steps: StepDef[];
  flags: { breaksDown: boolean; pausesForYou: boolean; unreviewed: boolean; bestOf: boolean; needsProviders: ProviderId[] };
  audience: "standard" | "user-only";
  warnings: string[];                  // validatePipeline warnings, and "no independent code review"
}

export interface PatternError { file: string; id?: string; message: string; line?: number; column?: number; effect: "skipped" | "built-in kept" }

export interface PatternCatalog { loadedAt: string; localDir: string; patterns: Pattern[]; errors: PatternError[] }

/** What a task ran. Recorded on each pipeline revision that applied a pattern, and as the task's current one. */
export interface PatternRef {
  id: string;
  name: string;
  /** "legacy": made from a template before ORC-016. "custom": built by the internal setPipeline (tests). */
  source: "built-in" | "local" | "internal" | "legacy" | "custom";
  hash?: string;                       // absent for legacy and custom
  chain?: PatternChainEntry[];
  experimental?: true;
  chosenBy: ChosenBy;
}

export interface RetiredTemplate {
  id: string; name: string; description: string; steps: StepDef[];
  kind: "custom" | "edited-built-in";
  retiredAt: string;
  exportedTo?: string;                 // display path of the file written
  exportedId?: string;
  exportError?: string;
  stripped?: string[];                 // e.g. "C2.checks.only (lint, test)"
}
```

Changed:

- `State`: `version: 15`, plus `patterns: PatternCatalog` and `retiredTemplates: RetiredTemplate[]`.
- `Project`: `defaultPatternId: string`, `"change"` by default. `initProject` resets it to `"change"`.
- `Task`:
  - `pattern: PatternRef` (current);
  - `patternSince: number` (the pipeline revision that applied the current pattern; 0 for legacy tasks);
  - `outcome?: TaskOutcome` (§10).
- `PipelineRevision`: `pattern?: PatternRef`, set on revisions that applied a pattern (creation and `changePattern`). Expansions and check rounds leave it unset.
- `RunSnapshot`: `role?: RoleId`, set at both dispatch sites in `dispatchEligible` (agent runs and service check runs). It is used by outcomes and a later trace export. Older attempts take the role from the pipeline revision named by `snapshot.pipelineRev`.
- `Artifact`: `pipelineRev?: number`, set in `reportCompletion` and `editArtifact`. Older artifacts take it from their attempt's snapshot, and an edit from the artifact it edited.

## 6. Choosing a pattern: every creation path

| Path (function) | Pattern | `chosenBy` | Validation |
| --- | --- | --- | --- |
| New task: `createTask` command → `M.createTask` | `patternId` from the args (required) | `user` | Exists in the catalog; not internal ("used by the service only" / "used by Send back only"). Experiments and patterns that pause are allowed. `a.steps` is never read (P1). |
| Lead proposal: `validateProposal`, `proposeTask` | `p.patternId ?? p.templateId ?? effectiveDefault(s).id` | `lead` when named, `default` otherwise | Must be a string when present. Unknown, internal or user-only is rejected: `pattern "x" is not available to the lead; choose one of: change, feature, …`. |
| Breakdown item: `createChildren` | `it.patternId ?? it.templateId ?? childDefault(s).id` | `breakdown` or `default` | As for the lead, plus `breaksDown` is rejected (the existing rule, reworded). |
| Findings follow-up decided by you: `decideFinding` | `change` | `service` | `servicePattern` |
| Findings follow-up decided by the lead: `applyLeadDecisions` | `change` (proposal) | `lead` | As for a lead proposal |
| Follow-up of a done task: `createFollowUp` (and `createFollowUpWithSpec`) | The origin's pattern id from the current catalog, when it is there and not legacy or custom; otherwise a copy of the origin's unexpanded steps, as today | `follow-up` | Pins carry over on steps with the same id and role. A copy keeps the origin's `source` (`legacy` or `custom`). |
| Send back as fix: `sendBackLanded` | `servicePattern(s, "bugfix")` | `service` | — |
| Send back as revert | internal `revert` | `service` | — |
| Pull-request repair: `startRepair` | `servicePattern(s, "change")` | `service` | — |
| Dedicated review or checks: `startReview`, the check task | internal `delivery-review` or `delivery-checks` | `service` | `reviewSteps` and `checkSteps` lose their "your edited template" fallbacks |
| Markdown import: `importMarkdown` | `effectiveDefault(s)` | `default` | — |
| Seed: `buildSeed` | `patternSteps(template)` with a built-in or internal ref | `lead` | — |

Every path:

- copies `pattern.steps` (cloned, through `instantiate`);
- sets `task.pattern` and `task.patternSince = 1`;
- writes `pipelineHistory[0] = { rev: 1, …, reason: "Created from the <name> pattern", steps, pattern: ref }`.

`NewTask` loses `steps` and `templateName` and gains `patternId: string` and `chosenBy?: ChosenBy`. `FollowUpOptions` gains `pattern?: PatternRef`, used with `steps` by the service paths.

**Project default.** `setDefaultPattern(patternId)` is a new user command. It refuses an unknown, internal or user-only pattern ("The default is also used by the lead and by breakdowns, so it must be a standard pattern."). It records a `config` event. If the pattern later leaves the catalog, `effectiveDefault` falls back to `change`, and Settings says so. The state is not rewritten.

**Lead and pattern changes.** The lead has no verb to change a pattern. ORC-009 steering is unchanged.

## 7. Changing a task's pattern

### 7.1 Command and preconditions

```ts
// commands.ts
changePattern: same((s, now, a) => M.changePattern(s, str(a, "taskId"), num(a, "expectedRev"), str(a, "patternId"), a.note === undefined ? "" : str(a, "note"), now)),
```

`M.changePattern(state, taskId, expectedPipelineRev, patternId, note, now)` checks the following in order; the first failure is the message:

1. The task is open (`assertOpen`). For a done task: "Done tasks keep the pipeline they ran. Create a follow-up and choose its pattern there."
2. It is not service-owned (`reviewTarget`, `checkTarget`, `revertOf`, `deliverInto`): "This task's pipeline is set by pull-request delivery."
3. `t.pipelineRev === expectedPipelineRev`, else `StaleWriteError`.
4. The pattern is in the catalog and not internal. A child task (`parentTaskId`) may not get a pattern that breaks down.
5. It has no child task that is not cancelled: "It has child tasks; cancel them or let them finish first."
6. If any attempt ever ran on the task (`s.attempts.some(a => a.taskId === t.id)`), it needs `t.hold && activeAttempts(s, t.id).length === 0`:
   - while running: "Pause the task first; patterns change only before a task starts or while it is paused";
   - while pausing: "Wait until it shows Paused."
7. If the id and hash equal `t.pattern`, nothing happens and no revision is made. The same id with a newer hash is allowed; that is how you take up an updated pattern.

### 7.2 Effects (a fresh start)

- `rev = t.pipelineRev + 1`.
- New steps come from `instantiate(pattern.steps)`, each with:
  - `revision = 1 + max(the old step's revision with that id, every snapshot.stepRev of the task's attempts with that id, 0)`;
  - `state = t.hold ? "paused" : "pending"`;
  - `selection` = the old step's selection when a step with the same id has the same role; otherwise `null`, listed as dropped.
- The task gets `t.steps = newSteps`, `t.pipelineRev = rev`, `t.patternSince = rev` and `t.pattern = patternRef(p, "user")`. `pipelineHistory` gains `{ rev, at, author: "user", reason: "Pattern changed from <old> to <new>[: note]", steps: defs, pattern }`.
- These are cleared, because they belong to the old steps:
  - `bestOf`, `bestOfByUser`, `pendingBreakdowns`;
  - `checkRounds`;
  - `holdReason`. The hold itself stays.
- These are kept: `hold`, `holdBeforeStart`, `reviewEveryStep`, `roleOverrides`, `deferral`, `userSet`, priority, `dependsOn` and the specs.
- Decisions: `F.supersedeDecisions(s, t.id, now, { reason: "the task's pattern changed" })` closes every open decision of the task.
- Artifacts and attempts are not changed or deleted. They are the record.
- Event (`pipeline`): "Pipeline r{rev}: pattern Feature → Change; 3 completed steps start over; pins kept: S1; dropped: S2 (role changed)".

Why a fresh start rather than keeping matching steps: step ids mean different things in different patterns (S1 is the design in Feature and the implementation in Change), so matching by id saves little across patterns and invites stale results. Between a pattern and its variants, the per-task toggles cover the common need (Review every step).

### 7.3 Stale-result protection

- **Primary.** No attempt is active at the change (precondition 6), and `reportCompletion` and `reportRunFailed` ignore attempts that are not active. No earlier run can report.
- **G1 (strengthened).** The existing check in `reportCompletion` (`a.snapshot.stepRev !== st.revision`) catches any earlier attempt on a reused id, because every new revision is higher than any revision that id ever had.
- **G2 (new).** In `reportCompletion` and `reportRunFailed`, an attempt with `a.snapshot.pipelineRev < (t.patternSince ?? 0)` is discarded.
  - Its note: "Result from before the pattern changed (pipeline r{n}); not integrated".
  - The step is not touched: no blocked state and no output.
- **G3 (new).** `editArtifact` refuses an artifact whose pipeline revision (§5) is below `t.patternSince`: "This artifact belongs to an earlier pattern of this task. It is kept for the record and cannot be edited."
- **Consumption.**
  - New steps start pending, and `acceptedOutput` takes only a done step's latest completed attempt.
  - Versions per `(task, step, output)` are monotonic, so a new run's output outranks every earlier version under the same id, including your edits made under the earlier pattern.
  - `chooseCandidate` on an old group fails the existing "not a best-of step" or "not a candidate" checks.

### 7.4 Preview (pure, shared by the UI and the event)

```ts
export function patternChangePreview(s: State, t: Task, p: Pattern): {
  allowed: boolean; why?: string;           // the precondition message
  redo: string[];                           // current steps that are done or skipped
  pinsKept: string[]; pinsDropped: { step: string; why: "role changed" | "no such step" }[];
  artifactsKept: number; decisionsClosed: number;
};
```

## 8. What is removed, and what stays internal

| File | Change |
| --- | --- |
| `src/ui/PipelineEditor.tsx` | Deleted |
| `src/domain/templates.ts` | Deleted; the contents move to `builtInPatterns.ts` (as JSON files), `internalPatterns.ts` and `server/legacyTemplates.ts` |
| `src/domain/commands.ts` | Removed: `setPipeline`, `saveTemplate`, `deleteTemplate`, `restoreBuiltInTemplates`, and the `stepDefs()` and `template()` validators. `createTask` takes `patternId`. Added: `changePattern`, `setDefaultPattern`. |
| `src/domain/model.ts` | `saveTemplate` and `deleteTemplate` deleted. `setPipeline` stays, with a doc comment: "Internal (ORC-016): no command reaches this. Tests use it to build pipelines that patterns do not offer." It now also sets `t.pattern = { id: "custom", name: "Custom pipeline", source: "custom", chosenBy: actor }`. `nextStepId` is deleted if nothing else uses it. |
| `src/domain/types.ts` | §5 |
| `src/domain/delivery.ts` | `stepsOf` is replaced by `servicePattern` and the internal patterns; the `usable(mine)` fallbacks are deleted |
| `src/ui/TaskDetail.tsx`, `Settings.tsx`, `Board.tsx` | §13 |

How tests keep building pipelines: a new helper, `server/testing/pipelines.ts`.

```ts
export function setTestPipeline(store: Store, taskId: string, steps: StepDef[], now = new Date().toISOString(), reason = "test pipeline") {
  return store.update((s) => M.setPipeline(s, taskId, s.tasks.find((t) => t.id === taskId)!.pipelineRev, steps, reason, "user", now), now);
}
```

- Server tests replace `cmd("setPipeline", { taskId, expectedRev, steps, reason })` with `setTestPipeline(store, id, steps, iso(), reason)`. The call sites are in fanout, autopilot, teamloop, prsim, landed, prdelivery, checksflow and `shaping.review`.
- `store.update` rethrows the domain error after rolling back, so `expect(() => setTestPipeline(…)).toThrow(/…/)` keeps working for the error-message tests in fanout.
- Domain tests keep calling `M.setPipeline` directly (pipeline, checks, steering).
- Tests of `saveTemplate` and `deleteTemplate` (`pipeline.test.ts`, "saves, updates, and deletes templates…" and "template saves reject stale revisions…") are deleted.
- The "internal template cannot be created" tests in `delivery.test.ts` and `delivery.auto.test.ts` become `createTask` with `patternId: "revert"` or `"delivery-review"` being refused.
- In every test, `templateId: "x"` in `createTask` args becomes `patternId: "x"`, `templateSteps` becomes `patternSteps`, and `BUILT_IN_TEMPLATES` and `PROJECT_TEMPLATES` become `builtInCatalog().patterns` and the internal patterns.

## 9. Migration 14 → 15

### 9.1 The migration (pure, `MIGRATIONS[14]` in `server/store.ts`)

```ts
14: (doc) => {
  const project = doc.project as Record<string, unknown>;
  const now = new Date().toISOString();
  const retired = (doc.retiredTemplates ??= []) as RetiredTemplate[];
  for (const t of (project.templates ?? []) as { id: string; name: string; description: string; steps: StepDef[] }[]) {
    const b = V14_TEMPLATES[t.id];
    const unedited = b && !INTERNAL_IDS.includes(t.id) && sameSteps(t.steps, b.steps) && t.name === b.name && t.description === b.description;
    if (unedited) continue;                              // the catalog provides it
    retired.push({ id: t.id, name: t.name, description: t.description, steps: t.steps.map(toDef),
                   kind: b ? "edited-built-in" : "custom", retiredAt: now });
    note(`Template "${t.name}" was retired: pipelines now come from patterns. It is saved as a pattern file of yours when the service starts.`);
  }
  delete project.templates;
  project.defaultPatternId ??= "change";
  doc.patterns = builtInCatalog();                       // the server replaces it at start (§4.6)
  for (const t of (doc.tasks ?? []) as Record<string, unknown>[]) {
    t.pattern ??= legacyRef(t);
    t.patternSince ??= 0;
  }
  doc.version = 15;
  return doc;
},
```

- `legacyRef(t)` returns:
  - `{ id: "delivery-review" | "delivery-checks" | "revert", source: "internal", hash, chosenBy: "migration" }` for `reviewTarget`, `checkTarget` or `revertOf`;
  - otherwise `{ id, name, source: "legacy", chosenBy: "migration" }`. The name comes from `pipelineHistory[0].reason` (`/(?:from|applied) the (.+) template/`). The id is the V14 template whose name it is, or `"custom"`.
- Nothing reads or writes `steps`, `pipelineRev`, `pipelineHistory`, attempts or artifacts (P9).
- `STATE_FORMAT = 15`. The `State.version` literal becomes 15. The existing upgrade loop keeps a backup of the format-14 document (`backup_format_14_v…`).

### 9.2 Frozen templates (`server/legacyTemplates.ts`)

- `V13_TEMPLATE_STEPS` moves here from `store.ts`, unchanged.
- `V14_TEMPLATES: Record<string, { name; description; steps }>` holds the nine templates exactly as in `templates.ts` at `4096d49`.
- `MIGRATIONS[13]` now reads `V14_TEMPLATES[t.id].steps` and `.description` in place of `templateSteps(t.id)` and `BUILT_IN_TEMPLATES`, so 13 → 14 → 15 keeps working after `templates.ts` is gone.
- P4 compares the built-in patterns with `V14_TEMPLATES`. When a built-in pattern changes on purpose later, that test is updated in the same change and the task spec records it.

### 9.3 Exporting retired templates (server, at start)

`exportRetiredTemplates(store, dir)` handles each `retiredTemplates` entry that has neither `exportedTo` nor `exportError`:

1. **Choose the id.**
   - A custom template: the slug of its name (lowercase, digits and hyphens, at most 40 characters), else the slug of its old id.
   - An edited built-in: `<old id>-yours`, named "<name> (yours)".
   - Any id that would collide with a built-in, internal or already-exported id gets `-yours`, then `-yours-2`, and so on.
2. **Build the file.**
   - `{ "$schema": "./pattern.schema.json", "$comment": "Saved from your template \"<name>\" when pipelines became patterns (ORC-016).", id, name, description (or "Saved from your template."), whenToUse: "Your template from before patterns. Edit this file to say when to use it.", steps }`.
   - Steps go through `toDef`, with `copyOf` and `iteration` dropped.
   - `checks.only` is removed and listed in `stripped`.
   - `experimental: true` and a placeholder hypothesis are added when a step is best-of.
3. **Write** with `writeFileSync(path, json, { flag: "wx" })`. `EEXIST` records an `exportError`: "A file named <file> already exists; nothing was written." Nothing is ever overwritten (P10).
4. **Record** with `store.update((s) => M.recordTemplateExport(s, oldId, result, now), now)`, which logs a `config` event. The loader then lists the new file like any other. If it is invalid, its errors appear in Settings → Patterns.

### 9.4 Running tasks

A task running on a custom pipeline keeps its steps, and its active attempt finishes normally. Nothing in dispatch or completion reads templates, and `patternSince = 0`, so G2 never fires for legacy tasks. A scheduler test proves this (§17). Such a task can still change to a catalog pattern under §7.

## 10. Outcome records

### 10.1 When and where

```ts
export function captureOutcomes(prev: State, next: State, now: string): State;   // src/domain/outcomes.ts (pure)
export function computeOutcome(s: State, t: Task, now: string): TaskOutcome;
```

- A task is captured when, in `next`, its `lifecycle` is `done` or `cancelled`, and `prev` holds the same task (same id and `createdAt`) with an open lifecycle. Its `outcome` is set to `computeOutcome(next, t, now)`. If a task is reopened (ORC-009 undo of a drop) and settles again, the record is replaced.
- `Store.command` applies it after `runCommand` and before `persist`. `Store.update` applies it after `fn`. That is one choke point, so no settle path (`finishTask`, `cancelTask`, drops, breakdown cancellations, delivery) can be missed.
- Migrations, `resetSampleData` and `initProject` record nothing, because their tasks have no open counterpart in `prev` (P11).
- Cost: one lifecycle comparison over the tasks per write, and one scan of the task's attempts, artifacts and decisions per settle. The record is about 1–2 KB.

### 10.2 Fields

```ts
export interface TaskOutcome {
  v: 1;
  result: "done" | "cancelled";
  settledAt: string;
  pattern: PatternRef;                 // in effect at settle
  patternChanges: number;              // revisions with `pattern` after the first
  runsBeforePattern: number;           // attempts with snapshot.pipelineRev < patternSince
  createdAt: string;
  firstRunAt?: string;
  wallMs?: number;                     // firstRunAt → settledAt
  agentMs: number;                     // sum of agent attempt durations
  runs: RunTally[];                    // one row per (role, runner, model)
  usage: { provider: ProviderId; inputTokens: number; outputTokens: number; costUsd: number | null; runsWithoutUsage: number }[];
  repair: { rounds: number; iterations: number; finalCheckRounds: number };
  findings: { raised: Record<Severity, number>; byAction: Record<FindingAction, number>; summaryOnly: number; openAtEnd: number };
  decisions: { total: number; byUser: number; byLead: number; fix: number; accept: number; followUp: number; superseded: number; open: number };
  checks: { runs: number; failedRuns: number; finalPassed: boolean | null; acceptedFailing: boolean };
  coverage: { reviews: number; complete: number; incomplete: number; unproven: number; retries: number };
  human: { artifactEdits: number; pinnedSteps: number; candidateChoices: number };
  bestOf?: { groups: number; candidates: number; chosenByUser: number };
}
export interface RunTally {
  role: RoleId; runner: Runner; model: string;        // model: actualModel ?? snapshot.model
  runs: number; completed: number; failed: number; stopped: number; lost: number; discarded: number;
  ms: number; inputTokens: number; outputTokens: number; costUsd: number | null;
}
```

How each field is derived:

- **`repair.rounds`**: completed attempts on coder steps with `runIf`, including their iterations, using the step definition from the pipeline revision named by the snapshot.
- **`repair.iterations`**: the highest `iteration` among the task's steps.
- **`repair.finalCheckRounds`**: `t.checkRounds ?? 0`.
- **`findings.raised` and `byAction`**: summed over structured findings in `review-findings` and `check-results` artifacts produced by completed runs, not by your edits.
- **`findings.summaryOnly`**: the sum of `openFindings` of artifacts that have no structured findings.
- **`findings.openAtEnd`**: the blocking count of the accepted outputs of the done review and check steps at settle.
- **`decisions`**: from `s.decisions` for the task. These are captured now because decisions are pruned later (`MAX_DECISIONS`).
- **`checks.finalPassed`**: `C.allPassed` on the last `onFail: "block"` step's accepted run, or `null` when it was skipped or did not run.
- **`checks.acceptedFailing`**: a `final-checks` decision with the status `accept`.
- **`coverage`**: the states of `pathCoverage` on code-review artifacts (`not-required` is excluded), plus the sum of the steps' `coverageRetries`.
- **`human.pinnedSteps`**: the steps with a `selection`.
- **`human.candidateChoices`**: the keys of `bestOfByUser`.

### 10.3 Derived later, not copied

Delivery results are already stored on the task, are never backfilled, and are not pruned. A pure `deliveryOutcome(t)` (ORC-018) reads them from `t.integration`:

- the `status` and `at`;
- `pr` (merged or closed, as observed);
- `landed.at`, used for time to landed: `landed.at - outcome.firstRunAt`;
- `landed.by`: `"app"` (an automatic merge, or the app's Merge button) or `"person"` (merged by hand on GitHub), with `mergedBy`;
- `landed.via`, `landed.flags` (for example `checks-accepted-failing` or `merged-without-clean-gate`) and `landed.status` (`sent-back`);
- `landed.followUps` (`fix` or `revert`, with task ids).

Time spent paused for a person is derivable later from control events. It is not recorded in v1.

### 10.4 OpenTelemetry GenAI mapping (for ORC-018; nothing is exported now)

The GenAI semantic conventions are still marked "Development". The names below are re-checked against the version pinned when ORC-018 adds an exporter for Phoenix or Langfuse, both of which ingest OTLP.

| Orchestrator | OpenTelemetry | Note |
| --- | --- | --- |
| Task | Root span, attributes `orc.task.id`, `orc.task.result`, `orc.pattern.id`, `orc.pattern.hash`, `orc.pattern.source`, `orc.pattern.experimental`, `orc.pattern.chosen_by` | Custom namespace; no GenAI convention covers workflows of agents |
| Agent attempt | Child span with `gen_ai.operation.name = "invoke_agent"` | From `startedAt` to `endedAt` |
| `snapshot.provider` | `gen_ai.provider.name`: `claude` → `anthropic`, `codex` → `openai` | Claude through Bedrock or Vertex would be `aws.bedrock` or `gcp.vertex_ai`; the snapshot does not record the sign-in path yet |
| `snapshot.model` / `actualModel` | `gen_ai.request.model` / `gen_ai.response.model` | |
| `snapshot.role` | `gen_ai.agent.name` | |
| `attempt.sessionId` | `gen_ai.conversation.id` | |
| `usage.inputTokens` / `outputTokens` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | |
| `usage.costUsd` | `orc.cost.usd` | No standard attribute |
| Outcome `failed` or `lost` | `error.type` | |
| Service check run | Child span `orc.checks` | No `gen_ai.*` attributes |
| `RunTally` rows | Metrics `gen_ai.client.token.usage` (`gen_ai.token.type` = input or output) and `gen_ai.client.operation.duration`, by provider, model and agent name | |
| `TaskOutcome` numbers | `orc.outcome.*` attributes on the task span | Custom |

A later SWE-bench run (ORC-019) needs only what exists after this task:

- `createTask` with a `patternId` over HTTP;
- the per-task `PatternRef` with its hash;
- `TaskOutcome`.

## 11. Envelopes (`server/envelope.ts`)

- **Lead.** The `templates` list and the `INTERNAL_TEMPLATE_IDS` import are replaced by this section:

  ```
  ## Pipeline patterns
  Pick "patternId" from these. Leave it out to use the project default ("change").
  - change: Change. <description> Use when: <whenToUse>. Steps: S1 Implement → C1 Run the project's checks → …
  …
  Experiments and patterns that pause for the user are the user's to choose; do not name them.
  ```

  The list holds only patterns that pass `eligible(p, "lead")`, and the steps come from `patternSummary`. The output contract shows `"patternId": "<pattern id>"`.
- **Breakdown output contract** (the `o.kind === "breakdown"` branch). The example item uses `"patternId": "<id>"`, followed by "Pick from: change (Change), feature (Feature), …", listing patterns that pass `eligible(p, "child")`. It names the default.
- **Parsing is unchanged.** Proposals and items are untrusted data, validated in `validateProposal` and `createChildren` (§6). `templateId` is accepted there only, as an alias.
- **Fake and scripted runtimes** (`server/runtimes/fake.ts`, `server/testing/scripted.ts`) emit `patternId`.

## 12. Commands and HTTP

| Name | Kind | Args | Notes |
| --- | --- | --- | --- |
| `setPipeline` | Removed | — | `M.setPipeline` is internal (§8) |
| `saveTemplate`, `deleteTemplate`, `restoreBuiltInTemplates` | Removed | — | |
| `createTask` | Changed | `patternId` replaces `templateId` | `steps` is never read |
| `changePattern` | New, user | `taskId`, `expectedRev` (pipeline), `patternId`, `note?` | §7 |
| `setDefaultPattern` | New, user | `patternId` | §6 |
| `POST /api/patterns/reload` | New endpoint | `{}` | §4.6; the server reads the files |
| `M.setPatternCatalog`, `M.recordTemplateExport` | Internal | — | Called by the server through `store.update`; never commands |

A removed command name sent to `/api/commands` gets the existing 400 "Unknown command <name>". No special case is needed, and the test covers it.

## 13. UI, per file

- **`src/ui/PatternPicker.tsx` (new).**
  - `PatternPicker({ state, value, onChange, filter })`: a `<select>` with option groups: Standard; Pauses for you; Experiments.
    - A file of yours shows "(yours)". One that replaces a built-in shows "(yours, replaces built-in)".
    - The current task's legacy or custom pipeline shows as a disabled first option, when relevant.
  - Below it, `PatternCard`:
    - the description, "Use when", and the hypothesis for experiments;
    - flag chips: experimental, pauses for you, no independent review, breaks down into child tasks, yours;
    - a warning when `needsProviders` names a disabled provider.
  - `PatternSteps`, read-only, is an ordered list with one row per step: the id, the purpose, the role label, and markers from `stepMarkers`, extended with "pauses for you", "reviewed by the other provider" and "run by the service".
  - Keyboard and screen-reader basics: a labelled select; the card is an `aria-live="polite"` region.
- **`src/ui/Board.tsx` (`NewTaskForm`).**
  - "Pipeline template" becomes "Pattern" (a `PatternPicker` filtered to non-internal patterns), with `effectiveDefault` preselected.
  - `templateId` becomes `patternId`, and the `INTERNAL_TEMPLATE_IDS` import is removed.
  - The help text becomes: "The pipeline comes from the pattern you choose. You can pin a provider and model for each step on the task page."
- **`src/ui/TaskDetail.tsx` (`StepsCard`).**
  - Removed: the `editing` branch and `PipelineEditor`, the "Edit pipeline" button, the `INTERNAL_TEMPLATE_IDS` import, and the `toDef` import if it becomes unused.
  - Header: "Pattern: <name>", with a source chip (built-in, yours, internal), a hash chip (8 hex; the title shows the full hash and the chain files), and an experimental chip. Legacy tasks show "From before patterns: <template name>"; custom ones show "Custom pipeline".
  - "Change pattern" appears when the task is open and not service-owned. It is disabled, with the reason, when `patternChangePreview(...).allowed` is false.
  - The button opens an inline panel with:
    - a `PatternPicker` (without patterns that break down when the task is a child);
    - the consequences: "N completed steps start over; their results stay on the record", "Pins kept: …; dropped: …", "Open decisions closed: n";
    - an optional note;
    - "Use <name>" and Cancel.

    A 409 shows "The pipeline changed while you were choosing; review again."
  - The step table, model pickers, Rerun, Retry, task role overrides, Review every step and Hold before start are unchanged.
  - Pipeline revisions show the pattern's name and short hash on revisions that applied a pattern.
- **`ArtifactsCard`.** Artifacts from before `patternSince` are labelled "earlier pattern (r{n}, <name>)", and they have no Edit.
- **`ArtifactEditor`.** The breakdown help text names `patternId`.
- **`src/ui/Settings.tsx`.** `Templates()` and its imports are replaced by `Patterns()`:
  - **Default pattern** (standard only). If the stored default is missing: "Using Change: <id> is no longer in the catalog."
  - **Reload patterns** (`postJson("/api/patterns/reload", {})`), showing the load time and the counts.
  - **The list.** Name; source chip; flags; description; when to use; hypothesis; file path; short hash; the steps in a `<details>`.
  - **Errors.** File, line:column, message and effect ("skipped" / "built-in kept").
  - **Templates from before patterns.** Each retired template with "saved as <path>" or its export error. For a failed export, the would-be JSON is in a read-only `<pre>` to copy.
  - **"How patterns work"** (`<details>`): the two folders, "built-in patterns change through commits; drop a file of yours and choose Reload", the `bugfix-pause-after-repro` example, and a pointer to the README section "Adding or changing a pipeline pattern".
- **`src/ui/fanout.ts`.** `stepMarkers` gains the two new markers. `pipelineSummary` is replaced by the domain's `patternSummary`.
- **`src/api.ts`.** Add the type of the reload response.

Visual checks: the existing tokens and components only; light and dark; desktop and 375 px width (the picker card wraps, and the steps list scrolls inside its card).

## 14. Libraries

| Package | Licence | Use | Where | Notes |
| --- | --- | --- | --- | --- |
| `ajv` (v8, `ajv/dist/2020`) | MIT | JSON Schema 2020-12 validation of pattern files | `server/patterns.ts`, tests | Compiled once; `strict`, `allErrors`. Never in the UI bundle. |
| `jsonc-parser` | MIT | Parsing your `.json`/`.jsonc` files with comments and trailing commas; error offsets; JSON Pointer to node, for line and column | `server/patterns.ts` | Microsoft's parser, used by VS Code |
| `@noble/hashes` | MIT | Synchronous SHA-256 in pure domain code (server, seed, migration, tests) | `src/domain/patterns.ts` | Pure JS, no native code; also bundled by the UI through the domain, which is small |
| `canonicalize` | Apache-2.0 | RFC 8785 JSON canonicalisation before hashing | `src/domain/patterns.ts` | Hashes ignore key order and whitespace |

Not added:

- `ajv-formats`: no `format` keywords are used.
- `chokidar`: there is no file watch. It is the choice if one is added.
- `yaml`, `json5`: see the spec's options.

Versions are exact in `package.json` (no caret) and recorded in the lockfile. Step B1 reads each package's `license` from its `package.json` in `node_modules` and lists it in the completion evidence. None of these packages makes network calls or sends telemetry.

## 15. Safety

- **Pattern files are configuration of your own machine,** like Settings.
  - Only the service reads them, from `<dataDir>/patterns`, outside every worktree. In the default isolation, Claude workers' file tools are confined to their worktree and Codex writes only inside its sandbox, so no agent can add a pattern.
  - The README's existing warnings still apply: a Claude worker with a shell, or a worker in the "local setup" environment, runs as you.
  - ORC-016 narrows the API: no command writes pipeline structure any more.
- **The managed repository is never read for patterns.** Reading them from the trusted base, with protected paths, is a later option.
- **Purposes in patterns are instructions to workers**, as template purposes are today. Built-in purposes are reviewed in pull requests, and yours are yours.
- **Bounded parsing:** 100 files, 64 KiB each, 30 steps, `extends` 3 deep.
- **Pattern ids are checked** (`^[a-z][a-z0-9-]{1,39}$`) before they are used in file names, and every write uses `wx`, which never overwrites.
- **The reload endpoint** has no arguments, is idempotent, and goes through the same Host, Origin and client-header checks as every other POST.

## 16. Docs and scripts

**`README.md`** (section names, not line numbers):

- **Intro.**
  - "runs each task through an editable pipeline" becomes "runs each task through a pipeline pattern you choose".
  - "off in all built-in templates" becomes "an experimental pattern only you can choose".
- **"What you get" table.** The row "The way of working…" becomes: "Pipelines come from patterns: tested workflows (design → implement → review → repair → verify, and variants), each a small JSON file versioned like code. You choose one per task."
- **"What it does".**
  - "Editable pipelines." becomes "Pipeline patterns.": each task runs a pattern from a catalog (Change, Feature, Bug fix, Investigation, Design, Goal, and labelled variants); built-in ones are in `patterns/`, yours in `~/.orchestration/patterns/`; each step can still use its own provider and model, set on the task page.
  - "Human-in-the-loop": "add review gates to single steps" becomes "choose a pattern that pauses after a step (or write a two-line variant), or turn on step-by-step review for a task".
- **Screenshots.**
  - Delete the "Pipeline editor" paragraph and image, and `docs/screenshots/pipeline-editor.png`.
  - Add "Choosing a pattern" (`docs/screenshots/patterns.png`: New task with the picker and the step preview).
  - Retake `best-of-pipeline.png`: the task page now shows "Pattern: Change, best of two implementations". Its caption names the experimental pattern.
  - The Goal caption says "The Goal pattern".
- **"Getting large goals done".**
  - Item 3: "Every built-in pattern runs one agent per step. Best of N is the experimental pattern 'Change, best of two'. Parallel copies are available to patterns you write."
  - Item 4: "The Goal pattern…", and "Goal, review the plan first" lets you edit the list before any child task exists.
  - Item 5: "Built-in patterns repeat review → repair… Patterns you write can loop other steps."
- **Limits.** "Child tasks: they cannot use a pattern that breaks down again."
- **"How it is built".** The tree gains `patterns/`. "Adding a workflow means adding a pattern file; see Adding or changing a pipeline pattern."
- **New section, "Adding or changing a pipeline pattern":**
  - where files live;
  - the fields, as a short table;
  - the annotated `bugfix-pause-after-repro.jsonc` example;
  - Reload and where errors show;
  - standard versus user-only, and experiments with a hypothesis;
  - what is recorded on each task (id, hash, source);
  - built-in changes go through pull requests;
  - service-owned pipelines stay in code.
- **Status table.** Add an ORC-016 row: "Pipeline patterns instead of an editable pipeline; outcome records per task".

**`docs/PROJECT_SPEC.md`:**

- "Model configuration per step": "reusable workflow templates" becomes "a catalog of pipeline patterns defined as JSON files (ORC-016)".
- "Persistent state": "workflow templates" becomes "the pipeline pattern each task ran (id and hash), and task outcomes".
- Add a short "Pipeline patterns (ORC-016)" section, in the style of the ORC-008 section.

**Unchanged:**

- `docs/tasks/*.md`: historical records; completed specs are not rewritten.
- `AGENTS.md`.

**`package.json`:** the description says "pipeline patterns"; the four dependencies are added.

**`scripts/real-run-test.mjs`:** before spawning the service, write `work/patterns/one-step.json`, which is a valid file of yours. The database is `work/orchestration.db`, so the patterns directory is `work/patterns`. Then call `createTask` with `patternId: "one-step"`. The pattern is flagged `unreviewed`, so it is user-only, which suits `createTask`. Remove the `saveTemplate` call.

**`server/testing/prSandbox.ts`:** `patternId: "change"`.

## 17. Tests

New and changed test files, by step. "M" marks a mutation that must make the named test fail. Each was tried once and recorded in the completion evidence.

### Step B1: catalog and creation

`src/domain/patterns.test.ts` (pure):

- **Resolution.**
  - Base patterns resolve.
  - `extends` overrides one field; `null` removes `gate`; `null` on `purpose` is an error.
  - An unknown override step is an error.
  - A cycle `a → b → a` is an error on both; depth 4 is an error.
- **Your files.**
  - A file of yours replaces a built-in and is marked as such.
  - A broken file of yours that replaces `feature` leaves the built-in with `effect: "built-in kept"`. **M:** let the broken file win.
  - A variant extending a broken file of yours extends the built-in.
  - Duplicate ids among your files skip both.
  - The ids `revert`, `delivery-review` and `delivery-checks` are refused.
- **Rules.**
  - F1: `S1-c2` is refused.
  - F3: best-of without `experimental` is refused. **M:** drop F3.
  - F4: a checks step choosing among candidates is refused.
  - F5: a file of yours for `change` without a review is refused, and the built-in is kept.
- **Flags and audience** for each built-in, as in §3.6.
- **Hash.** It is stable across key order and whitespace, changes when a purpose changes, and stays the same when the description changes. Each chain `fileHash` changes when any field of that file changes.
- **Eligibility.** **M:** let `eligible(p, "lead")` accept experimental patterns.

`server/patterns.test.ts` (loader and service):

- **Parsing.**
  - A `.jsonc` file with comments and trailing commas loads.
  - A syntax error reports the correct line and column.
  - A schema error (`steps[2].role: "tester"`) reports the line and column of that value.
  - An unknown key and `checks.only` are refused with the friendly message.
  - A file name that does not match the id is refused.
  - More than 100 files, or a file over 64 KiB, is refused.
- **Built-ins.**
  - The schema copy is written and refreshed.
  - Built-ins pass `ajv` and `JSON.parse`.
  - The manifest covers every file in `patterns/`.
  - The schema enums equal the TS constants.
  - Built-ins name no product or model; provider ids may appear only in `parallel.providers` (this replaces the template neutrality test).
  - **P4:** the built-in steps equal `V14_TEMPLATES`.
- **Reload over HTTP.**
  - Write a new variant and `POST /api/patterns/reload`; it appears with no restart.
  - Edit the file and reload; a task created before keeps its steps, its `pattern.hash` and its history (P3).
- **The removed commands (P1).**
  - `POST /api/commands` with `setPipeline`, `saveTemplate`, `deleteTemplate` or `restoreBuiltInTemplates` gets 400 "Unknown command". **M:** re-add `setPipeline` to `COMMANDS`.
  - A static check asserts that `COMMANDS` contains none of those names, nor `setPatternCatalog` or `recordTemplateExport`. **M:** expose `setPatternCatalog`.
  - `createTask` with `steps: [one step]` and `patternId: "change"` creates the Change pipeline. **M:** read `a.steps`.
- **Migration 14 → 15**, on a format-14 document built in the style of `qualitygates.test.ts`:
  - The unedited `change` template is dropped. A custom template and an edited `feature` go to `retiredTemplates` with the right kinds.
  - `defaultPatternId` is `"change"`, `patterns` holds the built-in catalog, and the format is 15. A backup row exists.
  - Every task's `steps`, `pipelineRev`, `pipelineHistory` and pins are deep-equal to before (P9). **M:** let the migration rewrite task steps from the catalog.
  - Legacy refs: a task made from "Feature" gets `{ id: "feature", source: "legacy" }`; one with a `reviewTarget` gets `internal`.
  - A format-13 document migrates to 15 through the frozen `V14_TEMPLATES`.
- **Export at start.**
  - Files are written as `<slug>.json` and `feature-yours.json`.
  - An existing file is never overwritten and records `exportError`. **M:** use the `w` flag in place of `wx`.
  - `checks.only` is stripped and listed. Best-of gains `experimental`.
  - A second start exports nothing again (P10).
- **A running custom pipeline across the upgrade (scheduler, scripted adapters).**
  1. Create a task, set a one-step custom pipeline with `setTestPipeline`, and dispatch it.
  2. Rewrite the database's format to 14 with a template list.
  3. Reopen the store, then finish the run.
  4. The task is done, with its original steps.

`src/domain/patternchoice.test.ts`:

- **`createTask`.** A `patternId` of an experiment is allowed for you, and the provenance is `chosenBy: "user"`. `revert` and `delivery-review` are refused with the existing messages.
- **Lead proposals.**
  - A named standard pattern gives `chosenBy: "lead"`; an omitted one gives the default and `chosenBy: "default"`.
  - `templateId` works as an alias.
  - Unknown, experimental, pausing, unreviewed and internal ids are rejected, and the rejection lists the valid ids. **M:** accept user-only patterns in `validateProposal`.
- **Breakdown items.**
  - The default applies, and `childDefault` falls back to `change` when the default breaks down.
  - `goal` is refused for a child.
- **`setDefaultPattern`** refuses user-only patterns. **M:** drop the check. After a reload removes the default, `effectiveDefault` is `change`.
- **Follow-ups.**
  - A follow-up of a done Feature task uses the current `feature` (the new hash) and keeps pins with the same id and role.
  - A follow-up of a legacy custom task copies its steps.
- **Service paths.** A fix send-back uses `bugfix`, a revert uses the internal `revert`, `startRepair` uses `change`, and the dedicated review and checks use the internal patterns. All have `chosenBy: "service"`.
- **Markdown import** uses the default.

The envelope tests (`server/envelope.test.ts`) assert:

- the lead prompt lists exactly the lead-eligible ids, with `patternId`;
- the breakdown contract lists the child-eligible ids;
- no internal or experimental id appears.

### Step B2: changing a pattern

`src/domain/changepattern.test.ts`:

- **Not started.**
  - The pattern is replaced, the revision recorded, and `task.pattern` and `patternSince` set.
  - A pin on S1 (coder in both patterns) is kept, and a pin on S2 (coder in Feature, reviewer in Change) is dropped and listed.
- **The same pattern and hash** makes no revision.
- **Refusals.**
  - While a run is active: refused. **M:** drop the active-attempt check.
  - While pausing: refused.
  - Blocked but not held: refused.
  - Done, cancelled, service-owned, a parent with open child tasks, and a child moved to `goal`: refused.
  - A stale `expectedRev` throws `StaleWriteError`.
- **Paused after S1 and S2 are done.**
  - Every new step is `paused` with a revision above every earlier one. **M:** set `revision = 1`.
  - Open decisions are superseded, and `bestOf` and `pendingBreakdowns` are cleared.
  - The artifacts remain, and no new step's consumed inputs include them.
- **G2.** An attempt forced active from before the change (state surgery, standing in for a regression elsewhere) reports completion and is discarded; the step stays untouched. **M:** remove G2 together with the revision bump; with either guard alone, the test still passes.
- **G3.** Editing an artifact from before the change is refused. **M:** drop G3.
- **The preview** matches the effects.

`server/changepattern.test.ts` (scheduler, scripted adapters):

1. A Change task runs S1.
2. Pause it: Pausing, then Paused. The change is refused while Pausing and accepted once Paused.
3. Resume: the new S1 is dispatched as a new attempt on the new steps.
4. A reload during the run does not touch the task.

### Step B3: outcomes

`src/domain/outcomes.test.ts`:

- **Fields from a constructed state.**
  - Claude runs report cost and Codex runs report tokens only, so `costUsd` is null and `runsWithoutUsage` is counted.
  - Two repair rounds and three iterations.
  - Structured findings by severity and action; summary-only findings counted.
  - Decisions by user and by lead.
  - Final checks passed, or accepted while failing.
  - Coverage complete and incomplete.
  - Edits, pins, a best-of choice.
- **Edge cases.** `patternChanges` and `runsBeforePattern` after a change. A legacy task's outcome has `source: "legacy"`.

`server/outcomes.test.ts`:

- **Captured once through the store** at done (scripted run) and at cancel. **M:** capture on every write while settled.
- **No outcome** for tasks settled before the upgrade (a migrated database) or after `resetSampleData`. **M:** capture tasks with no open counterpart in `prev`.
- **An outcome survives decision pruning:** fill `decisions` beyond `MAX_DECISIONS`.
- **Undo of a drop**, then cancel, replaces the record.

### Steps B4 and B5: UI, docs and scripts

- `npm run typecheck`, `npm test`, `npm run build`.
- A browser pass on the fake runtime (`npm run dev`), recorded with screenshots:
  - New task: the picker and the preview for every group.
  - The task page: the pattern line, Change pattern disabled while running with its reason, then allowed after Pause, with the consequences shown.
  - The earlier-pattern artifact label.
  - Settings → Patterns, with a broken file of yours listed with its line and column, Reload, and a default that has gone missing.
  - No "Edit pipeline" anywhere, and no template editing.
  - Light and dark, desktop and 375 px.
- `node scripts/real-run-test.mjs --fake` passes with its pattern file. A real run is optional, and only with the user's consent and credentials.

## 18. Build order

Each step is one implementation and then an independent review on the other provider (spec: workflow table). The suite stays green after every step.

1. **B1, catalog and creation.**
   - Files: `patterns/*`, `src/domain/{patterns,builtInPatterns,internalPatterns}.ts`, `server/{patterns,legacyTemplates}.ts`, `types.ts`, `model.ts` (creation paths, `validateProposal`, `createChildren`, `createFollowUp`, `importMarkdown`, `setDefaultPattern`, `setPatternCatalog`, `recordTemplateExport`), `delivery.ts`, `findings.ts`, `seed.ts`, `commands.ts`, `store.ts` (migration 14, repointed migration 13), `app.ts`, `http.ts` (reload), `envelope.ts`, the fake and scripted runtimes, and `tsconfig*.json`.
   - UI, minimal, so it compiles: `Board.tsx` sends `patternId` from a plain select; `TaskDetail.tsx` loses the editor; `Settings.tsx` replaces `Templates()` with a plain read-only list; `PipelineEditor.tsx` is deleted.
   - Tests: the B1 files, plus the migration of the existing tests (`setTestPipeline`, `patternId`, `patternSteps`).
   - Before anything else: confirm the JSON imports (§3.1).
2. **B2, changing a pattern.** `changePattern`, the preview, G2 and G3, the `Artifact.pipelineRev` stamp, the command, and a basic "Change pattern" button with a select. Tests for B2.
3. **B3, outcomes.** `src/domain/outcomes.ts`, the capture in `Store.command` and `Store.update`, and `RunSnapshot.role` at dispatch. Tests for B3.
4. **B4, UI.** `PatternPicker.tsx`, the full `NewTaskForm`, `StepsCard` (pattern line and change panel), `ArtifactsCard` labels, Settings → Patterns complete, and `fanout.ts`. Browser pass.
5. **B5, docs and scripts.** README (including the new section and the screenshots), `PROJECT_SPEC.md`, `package.json`, `real-run-test.mjs`, `prSandbox.ts`.
6. **V1, verification.** Full suite, build, every mutation in §17 tried once, the browser pass, `real-run-test.mjs --fake`, and the completion evidence in `docs/tasks/ORC-016.md`.

Dependencies: B2 needs B1's provenance (`patternSince`). B3 needs B2's `patternSince` (for `runsBeforePattern`) and `RunSnapshot.role`. B4 needs B2's preview.

## 19. Later: seams left on purpose

- **ORC-018, comparison.** Outcomes grouped by `pattern.id` and `hash`, with sample sizes, using `TaskOutcome` and `deliveryOutcome(t)`. An OTLP exporter maps §10.4 to Phoenix or Langfuse, off by default.
- **ORC-019, SWE-bench Verified through patterns.** `createTask` with a `patternId` over HTTP, and the outcome records.
- **Automatic assignment.** `ChosenBy` gains `"rotation"` and `PatternRef.assignment = { experimentId, arm }`, plus a project setting that rotates two patterns for new tasks of one kind. It needs rules for lead-created tasks and holds.
- **Patterns in a managed repository**, read only from the trusted base (as ORC-013 does for conventions) and added to protected paths.
- **"Final checks only" per check command** in Settings → Checks, if `checks.only` is missed.
- **A file watch** with `chokidar`, if Reload proves tedious.
