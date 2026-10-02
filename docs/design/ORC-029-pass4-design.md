# ORC-029 pass 4: driving the studio by talking to the lead

**What this is.** The design for pass 4 of ORC-029: the owner drives the vision studio by chatting with the lead, on a new idea or on an existing repository. The designer revises until the PE agrees. Vision gets its own place in the navigation.

**Where it fits.** Pass 3 made the studio's artifacts real: designer runs, sandboxed prototypes and terminal demos, the viewer, and a minimal PE review. Today a designer run can only be started by the service (the trial script stands in for the lead), so the owner cannot drive the studio from the app. The owner wants to try it on their old projects (2026-10-02, "in the morning we can walk through with a demo and test it out on some of my old projects"), so this pass is the slice that makes that possible.

The draft and Lock in (r10), the factory status with evidence (r12) and the lead adjusting tasks after Lock in go to pass 5. Full import (ORC-032) is a later milestone; this pass only gives existing repositories a first "as it is today" round.

## Units

At most three implementers, on disjoint files; the lead integrates. Each unit ends verified.

| Unit | Contents | Main files |
| --- | --- | --- |
| 4a | Vision in the main navigation; the lead's panel in the studio's right column; artifact kinds shown as documents | `src/ui/**` only |
| 4b | The lead in Vision: conversation-driven rounds, designer briefs, project domains, and an "as it is today" first round for an existing repository | `server/envelope.ts`, `src/domain/model/leadOutput.ts` and lead modules, `server/studio/runs.ts` (starting designer runs from the lead), `src/domain/studio/**` (domains, kinds) |
| 4c | The PE loop: the designer revises after an objection, up to three passes; `lastPass` removed | `server/studio/pe.ts`, the PE-related parts of `src/domain/studio/studio.ts`, the revision brief |

4b and 4c both touch the studio domain. 4c owns the verdict and loop functions, and 4b owns rounds, domains and kinds, with the boundary named in each brief. 4a needs only the domain's shapes.

## 4a. Vision in the navigation, and the lead's panel

- **Navigation (r12).** Vision is an item in the main navigation, beside Home, Tasks, Results and Settings, always one click away. Opening it never stops or changes the factory. The "Back to vision" stage switch is removed from Settings and Home. Pause the factory stays where it is.
- **The lead's panel.** The studio's right column shows the lead's message for the round, its questions (with option chips, as in ORC-012), and a box for "Message the lead" that posts to the same conversation as the header button. PE review and the feedback summary stay below it. The owner's feedback and answers go together as one message (ORC-012's "Send answers" pattern).
- **Document artifacts.** The kinds `interface`, `algorithm`, `topology`, `contract` and `flow` are shown as documents: Markdown with code blocks, Mermaid for diagrams (rendered by the app, never by the prototype server), and tables. They have no device frame.
- **Kit only;** a browser pass at 1280 and 375 wide.

## 4b. The lead in Vision

- **The lead's studio brief** goes into its envelope during Vision. It covers:
  - the vision text and documents;
  - the project's domains;
  - the open round and its artifacts;
  - the owner's marks, pins and notes since the last round;
  - the PE's verdicts;
  - the order of focus (experience, then data, then flows; r8 completeness: the product's things and how they relate, and every rule and edge case decided).
- **The lead's output gains a `studio` block** (validated, capped):
  - `openRound: { focus, summary }`;
  - `designerRuns: [{ brief, kinds, variants (1–3), devices }]` (at most 3 per reply);
  - `questions` (as in ORC-012);
  - `closeRound`.

  The service starts the designer runs through the existing service-only path. **The lead can never approve, overrule, lock in or start the factory;** only the owner's commands do (the tests from pass 2 must still hold).
- **Project domains (r9).** `project.domains: ("screen" | "code" | "infrastructure")[]`, which the lead proposes from the vision and the repository and the owner confirms (Settings, and a question in the first round).
  - Designer briefs follow the domain:
    - screens, terminal demos and TUIs for screen products;
    - interface, usage examples and algorithms for code products;
    - topology, failure and recovery, and scale and cost for infrastructure.
  - The studio artifact kinds gain `interface`, `algorithm` and `topology` (plain files: Markdown, Mermaid, code blocks).
- **An existing repository** (the project's repository has code). Unless the owner says otherwise, the lead's first round is **"as it is today"**:
  - the designer reproduces the key screens, or the interface and core algorithms, or the topology, from the code, as artifacts labelled "as is";
  - each artifact carries its provenance: the files it came from;
  - the owner corrects them, and later rounds revise them.

  It is a first slice of ORC-032. Designers read the repository read-only (a Claude designer through the read-only checkout; Codex reads are not confined, as for every Codex run).
- **The simulated runtime:** the fake lead plans a round and asks for one designer run, so the demo shows the loop.

## 4c. The PE loop

- **When the PE objects to a variant** (not-feasible), or asks for a change (feasible-if), the service queues a **designer revision run**. Its brief holds the PE's reasons and changes, plus the owner's feedback so far. The revision is a new version of the artifact, and the PE reviews it again.
- **Up to three passes per round** (2c's rule). After the third, any remaining objection goes to the owner, shown and never dropped, and the owner may overrule it.
- **`lastPass` is removed;** the interim rule from pass 3 goes.
- **Spend:** each pass counts in the building budget. A revision is not started past the budget stop.
- **The simulated runtime:** the fake PE objects once to one variant, and the fake designer revises it, so the loop is visible in the demo and the tests.

## Real trial (within the overnight budget)

One real round on a small sample repository with an existing screen, with these checks:
- the lead plans an "as it is today" round;
- the designer reproduces the screen with its provenance;
- the PE reviews it;
- one revision, if the PE asks for it.

The estimated Claude spend stays within what is left of the owner's $5 cap for pass 3 trials (about $4.70). The record goes to `docs/real-runs/`.

## Checks

- **Tests per unit:** the lead's studio block is validated; the lead cannot approve, overrule, lock in or start; the loop stops at three passes; past-budget revisions are not started.
- `npm test`, the typecheck, the build, `npm run test:integration` and `npm run trial:studio -- --fake` (extended for the lead's round and the loop).
- A browser pass at 1280 and 375 wide.
- An independent review, then a pull request.
