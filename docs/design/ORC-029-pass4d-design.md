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
