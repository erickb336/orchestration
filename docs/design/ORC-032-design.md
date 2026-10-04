# ORC-032: the import of an existing repository, as decided

**What this is.** The design of ORC-032 (`docs/tasks/ORC-032.md`, r3): how the import turns an existing repository into a baseline in Vision. It holds the data, the rules of the review, how a baseline item differs from a designed one, the budgets, the readers, the security and the build units. It records the owner's decisions of 2026-10-03 and the PE's changes C1–C15. Unit 1 (the pure domain) is built as written here; units 2 (the server) and 3 (the UI) build on it.

**The main point.** The import is a fixed procedure that the service runs: the tests once, then a reader for the rules, a designer for the parts, a designer for the words, and the capture. The owner answers only conflicts and important guesses, and locks the baseline in. The baseline is in force and built: a part is "built and verified" where its rules' tests pass and its recording has no failure.

**Where it fits.** ORC-029 built Vision and the factory, ORC-031 built helpers for read-only research, and ORC-030 stabilized both. Pass 4 of ORC-029 had a first slice: a lead-driven round 0, "as it is today". The import replaces it (C12). ORC-032 is the last feature milestone for now.

**What I need from the owner.** Nothing. Every decision below is the owner's, final. The open items for integration are in section 9.

---

## 1. The owner's decisions (2026-10-03, final)

| # | Decision |
| --- | --- |
| How much to ask | Only conflicts and important guesses, at most 10, conflicts first. The rest go into the baseline "not confirmed" and stay open in Vision (Q4). |
| What the baseline is | Built and in force: "built and verified" where its rules' tests pass. |
| Where it starts | The new-project screen, "Import an existing repository", with its own import budget ($3 by default) beside the formula estimate. |
| An answer unlike the code | A change request (C5). The baseline keeps what the code does. |
| Correct | Two choices: "tally should do something else" (a change) or "the reader misread it" (a fix). Also on confirmed items (C15). |
| No answer | The item goes in as the code has it, "not confirmed". |
| An important guess | It changes what users see or what the data means. |
| A failing test at import | A conflict. The part reads "fails a check" (Q2). |
| No Docker, no environment, no test report | The import runs anyway. Every rule is inferred, nothing is recorded, and the reason shows (Q3). |
| Who reads | Claude by default. Codex only if the owner picks it, with a warning (Q5). |
| A misread found after the baseline | A change. Its task adds the missing test (Q6). |
| The first change after the baseline | Starts the factory through the pre-flight, as any first build (Q1). |
| Rules | Rules belong to parts, and a rule may name existing tests (D1, C3). |
| The baseline Lock in | Its own owner command in Vision (C4). |
| PE review | None for the import's parts (C6). |
| The vision text | The import writes a vision draft, which the owner accepts on the Baseline screen (C10). |
| The commit | The import is pinned to the commit it started at (C11). |
| The pass-4 round | The lead-driven "as is" round goes (C12). |
| Bounds | At most 300 rules for each import and 60 for each part. The state keeps at most 1,000 test cases; the full report stays a file (C14). |
| The demo | The import works on a bundled sample repository (tally) with the simulated runtime, with no repository path outside the app. |

## 2. The data

### 2.1 Rules belong to parts (D1)

A part of any designer kind but the dictionary may carry a `rules.json`. Each rule may name the existing tests that prove it (`FlowRule.tests`, by id `suite::name`). Tests prove the rules of every part that has them, not only flows and contracts. The other options (the service sets the rules after the designer; one flow per part) were rejected: the first changes design content after import, out of the Lock in's digest; the second shows two rows per part.

### 2.2 The types (`src/domain/studio/types.ts`)

The import lives on the studio (`State.studio.import`), not on the state's top level. The reason: a new project (`initProject`) and the sample (`resetSampleData`) replace the studio, so an old import can never leak into a new project. The plan named `State.import`; this is the one change from it.

| Type | What it holds |
| --- | --- |
| `ProjectImport` | `id`, `commit` (C11), `branch`, `startedAt`, `budgetUsd`, `estimate` (`usd` range and `basis`), `helpers` (the reader's cap, or null), `readsOn` (Claude by default, Q5), `checks`, `reading`, `capture`, `answers`, `stopped`, `lockedInAt`. |
| `ImportChecks` | `pending`; `read` (the report's counts and its file; `simulated`); `not-run` (and why). |
| `ImportReading` | The reader's `rules`, the `cases` of the report that the rules name (C14), the reader's `runId`. |
| `ImportRule` | `id`, `area`, `text` (an EARS pattern), `pattern`, `tests`, `sources` (`from`: test, code or docs; `ref`; `says`; `differs`), `important`. |
| `ImportCapture` | For each screen, terminal demo and TUI of round 0, by artifact: its files, or why none (the factory's `NoEvidence` reasons). |
| `ImportAnswer` | `on` (a rule or a part), `option`, `correction` (change or misread), `text`, `at`. |
| `StudioRun` | New kind `reader` (research). New field `importStep`: words, rules, parts or fix. |
| `FlowRule`, `Provenance`, `LockInRecord` | `tests`; `commit`; `baseline` (`importId`, `commit`). |

The import's status is derived, never stored (`importStatus`):

```
reading ──(reading and capture recorded, no words/rules/parts run under way)──► review ──(lockInBaseline)──► locked-in
   └──────────────────────────────(stopImport)──────────────────────────────► stopped
```

### 2.3 The commands

| Command | Who | What it does |
| --- | --- | --- |
| `startImport { commit, branch?, budgetUsd, helpers, size, readsOn? }` | owner | After `initProject` and `setDomains`. Opens round 0, "As it is today", and records the estimate from `size`. Refused outside a new project in Vision, before the kind of product, with a short commit, or with helpers no provider tracks. |
| `setImportBudget { budgetUsd }` | owner | For example at the import's stop. |
| `answerImport { answers }` | owner | In the review or after the baseline. Each answer names one of its item's options; Neither and Correct need the owner's words. |
| `lockInBaseline { draftRev, summaryDigest }` | owner | Revision 1 in Vision, marked as the baseline; closes round 0. |
| `recordImportChecks`, `recordImportRules`, `recordImportCapture`, `stopImport` | service | In `SERVICE_COMMANDS`: a client cannot send them. A late or repeated report changes nothing. |
| `startStudioRun { …, importStep }` | service | The import's runs: a reader for the rules; a designer for the words, the parts and a fix. Round 0 only. |

**State upgrade.** `STATE_FORMAT` stays 19. Every new field is optional, and absent means none. A format-19 database without them loads unchanged, and loading writes nothing (`server/import.store.test.ts`). The store's guard lets `lockInBaseline` add exactly one revision, and only when there is none.

## 3. The rules of the review (`src/domain/studio/import.ts`)

**A rule's confidence** (`ruleConfidence`) is derived, never the reader's claim. The first case that applies wins:

| # | The baseline run and the sources | Confidence | Asked? |
| --- | --- | --- | --- |
| 1 | A test the rule names failed or ended with an error | conflict (`test-fails`) | yes |
| 2 | A source says something other than the rule (`differs`) | conflict (`sources-differ`) | yes |
| 3 | It names at least one test, and every one passed | confirmed | no: listed |
| 4 | No test, only skipped tests, or no baseline run | inferred | only if `important` |
| — | It names a test that the report does not have | refused when recorded | — |

**The questions** (`importQuestions`): every conflict, then every important guess, in the rules' order. At most 10 are asked; the rest are `notAsked`. They go into the baseline as the code has them and stay open in Vision.

**The options** (`importOptions`):

| Item | Options |
| --- | --- |
| A conflict | `keep` (named by the first source that agrees: "The test: one currency per group"; for a failing test, "The code: as it is today"); `test` (a failing test: "The test: test_split.py::test_even"); `source-N` for each source that differs; `neither` (with the owner's words). |
| Any other rule, and a part (C15) | `confirm`; `correct` (with its kind and the owner's words). |

**What an answer does** (`answerEffect`, `itemAnswerEffect`). The newest answer on an item counts.

| Answer | Effect | The baseline holds | Then |
| --- | --- | --- | --- |
| `keep`, `confirm` | kept | the item as the code has it, "you confirmed it" | — |
| another option, `neither`, `correct` + change, or after the Lock in any `correct` (Q6) | change | the item as the code has it | a change request (`changeRequests`). It is open while no newer version of its part exists. The lead's next round designs it. |
| `correct` + misread, before the Lock in | fixed | the part's next version, which a designer's fix writes in the import budget (`importFixesDue`) | — |
| no answer | open | the item as the code has it, "not confirmed" | the question stays in Vision |

## 4. A baseline item

| | A designed item | A baseline item |
| --- | --- | --- |
| Made by | a designer's proposal in round 1 or later, reviewed by the PE | the import, round 0, "as is", provenance at the import's commit, no PE review (C6) |
| In force by | Start the factory or Lock in | `lockInBaseline`: revision 1, with `lockIn.baseline` |
| Built by | landed tasks that cite it | the repository at the import's commit |
| A rule's result | tests that carry `[bi-N Rk]` in landed checks | the tests the rule names, in the baseline run, which counts at the Lock in's time; later landed checks too |
| Its evidence | the factory's capture of landed work | the import's capture (`ItemFactoryView.baseline.capture`) |
| New work in the Lock in summary | yes, when no task cites it | never |
| The PE's estimate of the rest | counts | left out |
| A later version | — | an ordinary change; once it is in force, the factory's rules apply |

**Its status** (`itemFactoryStatus`). The first case that applies: a dictionary is "in force"; a rule's test failed: "fails a check"; the draft changes it: "in the draft"; then "built and verified", or "built, not verified" with the first gap:
- `rules-unproved`: a rule with no test, or a skipped one;
- `no-rules`: a flow or a contract with none;
- `kind-not-checked`: a document with no rules;
- `no-evidence`: a screen, a terminal demo or a TUI that the capture did not record, and why;
- `evidence-missing-device`, `evidence-warning`: a screen without a device, or a recording with a warning.

The baseline summary (`baselineSummary`) is the Lock in summary of the draft with every part of round 0 added, so the owner agrees to exactly what goes into force.

## 5. The budgets (`src/domain/spend.ts`)

- **The split.** In an imported project, a run asked for before the baseline Lock in is the import's (`importSpend`); a run asked for after it is the building's (`buildingSpend`). The split uses time, so no run carries a tag.
- **The import's stop.** `importStop`, like `budgetStop`, at `import.budgetUsd`, only while the import goes on. Studio dispatch checks it. The building budget plays no part.
- **Unknown costs** count as for the building budget. Known risk: a Claude run with no recorded usage counts at the run limit, $2 by default, which is two thirds of a $3 import budget.
- **The estimate** (`importEstimate`, no agent run, C6). A base of $0.40–$1.60 for the runs, from recorded real runs on small repositories. Plus the files read 1 to 4 times by 3 readers, at Claude's published input prices (256 tokens for each KB). tally (38 KB): $0.43–$2.07. 1,000 KB: $1.17–$13.89. There is no basis above about 50 files.

## 6. The readers (units 2 and 3)

The order (C2). Rules belong to parts, so the rules reader goes before the parts designer. The reader names the report's tests, so the checks go first.

```
Start ──► checks (service) ──► rules (reader, research, helpers) ──► parts (designer) ──► capture (service) ──► review (the lead's message)
     └──► words (designer) ─────────────────────────────────────────────────────────────────────┘
```

| Step | Who | It produces | Simulated |
| --- | --- | --- | --- |
| Checks | the service, in the project's environment, on a copy of the import's commit, no network | the report's counts and file (`recordImportChecks`) | a canned tally report: 22 cases, all pass |
| Words | a designer run (`importStep: "words"`), the dictionary, as is | a dictionary with provenance | 6 tally words |
| Rules | a reader run (`kind: "reader"`, research, read-only, helpers under the import's cap) | `recordImportRules`: rules and the cases they name | 17 tally rules |
| Parts | a designer run (`importStep: "parts"`), as is, with each part's `rules.json` | screens, terminal demos, documents, each with provenance and rules | 6 tally parts |
| Capture | the service's capture job, in the project's environment | `recordImportCapture` | 3 canned casts |
| Fix | a designer run (`importStep: "fix"`) on one part | the part's next version | — |
| Review | the lead: one reply with the round's message and a vision draft (C10) | the message | the fake lead's message |

The service starts the readers, not the lead's studio block: the import is a fixed procedure. The demo writes the tally fixture into a git repository in the app's data folder, so the import needs no path outside the app.

## 7. Security

The repository's content is untrusted: it may be someone else's code. "(unit 2)" marks a guard that unit 2 builds; the others exist.

| What the repository can do | The guard | Residual |
| --- | --- | --- |
| Steer a reader by prompt injection (README, comments, test names) | Read-only runs; Claude's reads stay in the checkout; no connections; "confirmed" comes from test results, never from the reader | Codex reads are not confined: Codex reads only if the owner picks it, with a warning (Q5). An injected text can bend a guess; the owner sees the sources. |
| Run its code | Only in the project's environment: prepare through the allowlist proxy, run with no network, non-root, a copy | Without Docker nothing runs: rules are inferred, nothing is recorded (Q3). |
| Run git hooks, filters or fsmonitor | Hooks and fsmonitor off for the workspace manager's calls; no `git status` on the repository, `GIT_LFS_SKIP_SMUDGE=1`, and a refusal of a local config with filter drivers (unit 2) | — |
| Feed hostile data | The reader's output is checked at the boundary (`parseImportReading`, then `recordImportRules`: every test id in the cases, caps; unit 2 checks the ids against the full report); the capture (`parseImportCapture`); JUnit and casts as today | — |
| Spend money | The import's stop; the per-run limit | An unrecorded run counts at $2. |
| Change under the import | A reproduction shows the import's commit (`addArtifact` refuses another); every read, check and capture uses that commit (unit 2) | — |
| Change the repository | Readers only read; copies leave out `.git` | `git worktree add` writes records under `.git`: "No file in your repository changes" (C7). |

## 8. The build units

| Unit | Owns | State |
| --- | --- | --- |
| 1, the domain | `src/domain/studio/import.ts` (+ test), `src/domain/testing/import.ts`, `server/import.store.test.ts`; changes in `studio/types.ts`, `blueprint.ts`, `ruleResults.ts`, `itemStatus.ts`, `studio.ts`, `runs.ts`, `words.ts` (+ test), `spend.ts`, `subagents.ts` (+ test), `commands.ts`, `server/store.ts` | Built: phase A (`bc38ee6`), phase B (`bfdcbb7`). The tests of the derivations are in `src/domain/studio/import.test.ts`, one describe block for each acceptance line. |
| 2, the server | the import's procedure (`server/studio/import.ts`), the tally fixture, the scheduler, the reader's launch and parse, the capture, the lead's brief, the Start route, `docs/safety.md` | Starts from phase A. |
| 3, the UI | the five screens, `#/vision/baseline`, the header and Home, the QA journey `import.mjs`, `docs/user-guide.md` | Starts from phase A. |

**The state builders** for units 2 and 3 (`src/domain/testing/import.ts`): `tallyImport(stage, options)` builds tally's import through the real commands, at `started`, `checked`, `read`, `parts`, `review`, `answered` or `baseline`, with all tests passing, some failing, or no Docker. `PROTOTYPE_ANSWERS` are the prototype's example answers. `baselineArgs` gives the Baseline screen's arguments.

**Unit 1's changes outside its list**, to keep the checks passing:
- `server/studio/writing.ts`: a reader run, like a probe, gets no principles and no prose feedback;
- `server/studio/runs.ts`: a reader run hands in no artifacts;
- `src/ui/studio/studioView.ts`: the words for a running reader;
- `server/studio.test.ts`: the four new service commands in the guard test;
- `server/orc029.test.ts`: `lockInBaseline` is the third caller of `putDraftInForce`.

## 9. Open for integration

- **C12, the pass-4 round.** The domain skips PE review only for reproductions in a project with an import. When unit 2 removes the lead-driven round, the `as-is` end of PE review (`LoopEnd`, `studio.ts`) has no caller left: delete it and its tests then (`src/domain/studio/studio.test.ts`, `src/ui/studio/studio.test.tsx`, `server/studio/runs.test.ts`).
- **The lead's review run.** The review needs a lead trigger in Vision (`src/domain/model/lead.ts`), which checks `importStop` like studio dispatch. No unit owns that file: the lead assigns it.
- **The fix run's brief.** `importFixesDue` gives each part's fix with the owner's words; unit 2 asks for the run.
