# ORC-029 pass 4d: controlled writing, the project dictionary and rule patterns

**What this is.** The design for pass 4d of ORC-029 (spec r13). Agents write to the owner in controlled English, and a check measures it. The data round produces the project's dictionary. The flows round writes rules and acceptance in fixed sentence patterns.

**Where it fits.** The core problem of Orchestrator is alignment: the owner and the agents must mean the same things (PRODUCT.md, "The core problem"). Karpathy's guidance ranks forms by how well a person understands them: controlled writing, then diagrams, then interactive pages, then explainer videos. Passes 1–4 built the studio's pages and prototypes. This pass makes the text itself controlled. It starts after pass 4 merges, because it adds an artifact kind next to 4b's new kinds. Explainer videos are a later artifact type.

## Decisions

**1. The standard is a principle.** A new principle, `write-controlled-english`, holds the rules of ASD-STE100 at about 80% (the owner, 2026-10-02: "Yes 80%"). The service gives it to every agent run and to the lead, next to "Contextualize and write for the reader". The text comes from the owner's agent kit (`writing/ste-80.md`, github.com/erickb336/agent-kit), shortened to the 200-word limit for principles.

**2. The checker is Vale.** Options:

| Option | For | Against |
| --- | --- | --- |
| **Vale** (MIT, Go) | Rules are YAML data, so the dictionary can generate them. It has substitution rules for words and part-of-speech sequences for noun clusters. Deterministic. Mature. | An external binary (Homebrew). |
| retext / unified (MIT, JS) | Runs in the process. Plugins exist for the passive voice and readability. | Noun clusters and the dictionary need custom plugins. |
| write-good (JS) | Small. | Few rules, little maintenance. |
| A model as judge | Understands meaning. | Costs a run per text. Not deterministic. |

**The lead's choice: Vale**, pinned to 3.24.0, with a style folder in this repository (`vale/styles/STE80/`). Vale is optional at runtime, as Chrome and Docker are: without it, the text is "not checked", with the reason.

**3. What the check does.** It never blocks a message, and it shows no score to the owner. Options:
- a rewrite gate (costs a run per failure, and can loop);
- a score beside each message (the owner does not want to police agents);
- **a record and a feedback loop (chosen):** the service records the result on the run. The writer's next envelope lists the rules that its last text broke, with examples.

**4. What the check reads (first set):**
- the lead's replies and questions;
- the PE's reasons and changes;
- the designer's notes on its artifacts.

The repository's own documents get `npm run lint:prose`, which reports and does not fail CI in this pass.

**5. The rules and their levels.** Errors are few and certain. Warnings guide.
- **Error:** a sentence over 35 words; a noun cluster of 5 words or more; a word the project's dictionary says to avoid.
- **Warning:** a sentence over 25 words; a paragraph over 6 sentences; a noun cluster of 4 words; the passive voice; vague words ("various", "etc.", "appropriate").

**6. The project dictionary.** The data round produces it:
- **The shape:** a new artifact kind, `dictionary`, with one file, `dictionary.json`: a list of `{ term, meaning, avoid[] }`. The app shows it as a table.
- **The owner's part:** a mark on each term (keep, change, drop). This is the cheapest form.
- **In force:** the approved version in the blueprint is the project's dictionary. It goes into every agent's envelope as "The project's words" (capped), and it generates Vale substitution rules (each avoided word → its term).
- The lead proposes it in the data round, from the vision and, for an existing repository, from the code's names.

**7. Rule patterns.** Rules and acceptance in the flows round use fixed sentence patterns:
- **Rules: EARS** (Easy Approach to Requirements Syntax, from Rolls-Royce: Mavin et al., 2009). There are five patterns:
  - "The <system> shall <response>."
  - "When <trigger>, the <system> shall <response>."
  - "While <state>, the <system> shall <response>."
  - "If <unwanted condition>, then the <system> shall <response>."
  - "Where <feature is included>, the <system> shall <response>."
- **Acceptance:** "Given <context>, when <action>, then <result>." (Gherkin's form).
- **The shape:** a flow artifact may carry `rules.json`: a list of `{ id, text }` and examples. The import checks each line against the patterns, as it checks a tape. A line that fits no pattern is refused, with its line, and the designer's revision fixes it.
- The owner marks each rule. An edge case is an "If …, then …" rule, so an undecided case shows as a missing rule, not a special case in code.

## Units

At most two implementers, after pass 4 merges:

| Unit | Contents | Main files |
| --- | --- | --- |
| 4d-1 | The principle; the Vale style; the check of agent text, its record and the feedback in the next envelope; `npm run lint:prose` | `principles/`, `vale/**`, a new `server/prose/**`, the feedback lines in `server/envelope.ts` |
| 4d-2 | The `dictionary` kind and `rules.json` in flows: validation at import, the tables in the app, "The project's words" in envelopes, the generated substitution rules | `src/domain/studio/**`, `server/studio/artifacts.ts`, `src/ui/studio/**`, the dictionary lines in `server/envelope.ts` |

Both touch `server/envelope.ts`. 4d-1 owns the feedback section and 4d-2 owns the dictionary section. The lead integrates.

## Checks

- **Tests:** each Vale rule on good and bad samples; no Vale means "not checked"; the feedback appears in the next envelope only; a rule outside the patterns is refused at import; the dictionary's substitution rules are generated from an approved version only.
- **The simulated runtime:** the fake lead writes one sentence that breaks a rule, and its next envelope shows the feedback. The fake designer hands in a dictionary in the data round, and a flow with rules.
- `npm test`, the typecheck, the build, `npm run test:integration` and `npm run trial:studio -- --fake`.
- **A measure for the playground:** the share of the lead's sentences that pass, before and after the feedback, over the fake trial and the next real trial.

## Not in this pass

- Explainer videos (a later artifact type).
- A failing CI check on this repository's documents (ORC-030 can decide, from the report).
- One instruction per sentence and the missing article. No tool checks them well, so the principle carries them.

## 4d-1 as built (merged in 2a3da31, 2026-10-02)

- **The principle** `principles/write-controlled-english.md` (175 words) goes to every agent run and to the lead, next to "Contextualize and write for the reader". The cap on a step's principles section rose from 1,200 to 1,400 words, because the largest step was already at 1,149 words. ORC-026 raised it before for the same reason.
- **The Vale style** (`vale/styles/STE80/`), measured on all the real lead text in `docs/real-runs` (159 sentences):

  | Rule | Level | Alerts | Wrong |
  | --- | --- | --- | --- |
  | A sentence over 35 words | error | 4 | 0 |
  | A sentence of 26 to 35 words | warning | 9 | 0 |
  | A paragraph over 6 sentences | warning | 7 | 0 |
  | The passive voice | warning | 43 | 4 (about 10%) |
  | A vague word | warning | 0 | 0 |
  | A noun cluster | dropped | 2 | 2 |

  Vale's tagger found none of 5 sample noun clusters, so the principle carries that rule alone.
- **The record** is `LeadRun.prose`: "checked" (Vale's version, sentences checked and passed, up to 12 broken rules with counts and 5 examples) or "not checked" with the reason. The owner sees no score.
- **The feedback:** the lead's next envelope lists the rules that its last reply broke, with up to 3 examples, and tells the lead not to mention the check to the owner.
- **The measure** (`scripts/prose-measure.mjs`) on `docs/real-runs`: the lead's messages pass at 79% (33 of 42 sentences), and its briefs to the designer at 57% (49 of 86). `npm run lint:prose` reports 86% over 41 documents and never fails.
- **Not done:** designer and PE runs get no principles section at all today, so neither writing principle reaches them. Part 2 adds it.

## 4e: the PE loop converges (merged in 1065d79, 2026-10-02)

The fix for the second real trial's finding. **The verdict now keeps three things apart:**
- `change`: what feasibility, scale, longevity or budget needs. Only a change starts a revision.
- `openCases` (at most 5): a missing feature, an undecided edge case, or a rule nobody set. Open cases never start a revision. The lead's brief lists them, and the app shows them under PE review as "Questions for you".
- `earlier` (on passes 2 and 3): each earlier ask, met or not met. A new change on a later pass must answer a risk that the revision itself created (`fromRevision`).

**The service refuses a later pass that grows the asks:** a pass that leaves out an earlier ask, or that sends a variant back with every ask met and no `fromRevision`. The PE retries with the reason. Rejected options: turning the new change into an open case without asking (it rewrites the PE's answer), and a prompt rule alone (the trial showed that it fails).

**The revision brief** gives a feasible-if variant only its change, and tells the designer to add no features. An objection keeps its reasons.

**Replay of the real trial's three passes:** they resolve as 1 change and 7 open cases, the pass-2 "code reset" ask is refused as a new change, and the PE agrees on pass 2.

**Checks after both merges:** `npm test` 1,712 passed and 1 skipped; the build passes; the integration test and both simulated studio trials pass. The next real trial checks whether a real PE follows the new answer format.

