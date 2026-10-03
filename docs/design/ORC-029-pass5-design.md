# ORC-029 pass 5: the draft, Lock in, and design beside reality

**What this is.** The design for pass 5 of ORC-029, the vision studio. Vision stays open after the factory starts. The owner's edits collect in a draft, and only the owner's **Lock in** puts them into force. The lead then adjusts the factory's tasks as a change order, and the PE reviews the new work. Each part of the design shows how far the factory has built it, with evidence beside the design.

**Where it fits.** Passes 1 to 4 and 4d built the studio: rounds with the lead, the designer and the PE, artifacts the owner marks, and the blueprint the factory builds from. Today an approval changes the blueprint at once, and "Back to vision" stops new work. The owner decided otherwise (spec r10 to r12, 2026-10-02):
- "the vision staging area even after factory has started should always be editable and revisable by chatting with the lead";
- "once a new revised vision is 'lock' in again the lead continues with adjusting tasks as needed creating new ones for refactoring or revisions";
- Vision becomes navigation, not a stage switch, and each design part shows its factory status with evidence.

Pass 6 then adds the pre-flight screen, the factory floor, the budget and device settings, and the Vision and Factory words across the UI.

## Experience first: the prototype

The screens come first, with sample data, before any backend work (the owner's rule). The prototype was published on 2026-10-02 as a private page, https://claude.ai/artifact/JKG9KTP1FtKV697MwUrrhi. Its source is `docs/design/ORC-029-pass5-prototype.html`. It has five screens:

1. **The header:** "Vision · draft, 3 changes" and "Factory running · 4 agents", side by side on every screen. Each is a link. "Back to vision" is gone.
2. **Vision with a draft:** a bar lists the draft's changes since the last Lock in, each with what it replaces. A changed artifact shows the draft version beside the version in force.
3. **The Lock in summary:** what changes, the tasks it touches, the new work, the budgets (the PE's estimate), and what stays open. Only the owner can lock in, and the agreement is recorded.
4. **The change order:** the lead's updates after a Lock in (updated, new and retired tasks), each in the design's words, with PE review and Undo.
5. **Design and reality:** each blueprint part with its status (designed, in the draft, being built, built and verified, fails a check), and the evidence beside the design: the built screen beside its prototype, the CLI's recording beside its demo, each rule of a flow with its test. Two layouts: a list, or a board by status.

**Questions for the owner** (in the prototype, each with the lead's recommendation first):
1. A running task builds something the owner changed: let it finish, then the lead revises it (recommended), or pause it until the lead updates its spec.
2. Lock in the whole draft at once (recommended), or choose which changes to lock in.
3. "Built and verified" means: the rule tests pass and the UX review matches the prototype (recommended), or that and the owner confirms each side-by-side.

**The owner's answers (r14, 2026-10-03), all four as recommended:** a running task finishes, then the lead revises it; Lock in takes the whole draft; the checks decide "built and verified"; and "Design and reality" is a list with evidence. The owner's marks (pasted 2026-10-03) agree with the header, Vision with a draft, the Lock in summary and the change order.

## Evidence of what the factory built (the lead's design, 2026-10-02)

**The problem.** "Design and reality" needs evidence per blueprint item: the built screen beside its prototype, the built CLI's recording beside its demo, and each rule of a flow with its test result. Today nothing can make it:
- Claude workers have no shell.
- The checks sandbox refuses loopback, so no check can start the built app and look at it.
- A check result is one result per command, not per test.

**Options:**

| | (a) The service runs a preview | (b) The agent makes the files | (c) Tests first |
| --- | --- | --- | --- |
| What runs the product | The service, in the recorder container, on a copy of the worktree | The coder agent, which cannot today (no shell, or loopback blocked) | The checks step, as today |
| Screens and CLIs | Chromium and VHS inside the container | The agent's own images | None |
| Rules and examples | None | The agent's claim | One test per rule or example, read from a JUnit report |
| Trust | Made by the service from the built code | A claim by the builder, not evidence | Test results |
| Owner's setup | Docker and the recorder image (already needed for demos); confirm the preview command, port and CLI entry | None | Checks on, and a test command that writes JUnit |

**The lead's decision:** (c) for flows and contracts, and (a) for screens and CLIs. (b) is rejected as evidence: a builder's own pictures are a claim. One part of (b) stays: the coder writes a **capture plan** (data: each screen item's page path and devices, and a tape that runs the real CLI).

**The first slice:**
1. **Rules:** the test command writes JUnit XML to a fixed path. The coder names each acceptance test by its rule or example id (`[R3] …`). Each rule shows pass, fail, skipped or "No test", and "No test" or "skipped" never shows as a pass.
2. **A service step, "Capture evidence"** (run by the service, like checks), after the checks in the Feature flow. Two container steps:
   - an install with the network on and every install hook off;
   - then, with no network, the preview command, a wait for the port, the shots with Chromium inside the container, and the tape with VHS.
   Only the files that the plan names come back. The UX review then gets the built shots beside the prototype shots.
3. **The record per item:** its design version, the commit, the evidence files, the rule results and the status.

**Deferred:**
- clicks and form steps in a capture;
- CLIs that are not Node;
- apps that need a database, secrets or the network;
- pixel comparison;
- evidence for interfaces, topologies and algorithms;
- the owner's own "Looks right", unless the owner picks it in question 3.

**The proof:** one real Feature task on a small sample repository (a Vite page, a Node CLI, and one flow with 3 rules), with one rule failing on purpose, so the page shows "fails a check".

## As built (2026-10-03, merged on `orc-029-pass5`)

**U1, rule results from tests.** A project's checks may name a JUnit report (`checks.testReport`). After the checks, the service reads one result per test case (fast-xml-parser 5.11.2, pinned; any `<!` declaration is refused before parsing; at most 400 cases kept). Before the commands run, the runner deletes any report the change itself carries, so only a report this run writes is read. This does not stop an agent from writing false results: the agent writes the test script, and the script writes the report. The code review judges the tests (review finding 12 corrected an earlier claim here). Each rule and example has one tag everywhere, `[bi-12 R3]`: in the spec's acceptance, in the test's name and in the result. "No test" and "skipped" are never a pass.

**U3, the factory link and PE review of new work.** Specs cite approved items (`blueprintRefs`); the lead is told where an item it cannot cite is (only in the draft, still open, dropped, or not in the blueprint). A cited flow's rules and examples join the acceptance. A Feature task's design step starts from the approved prototype, and the UX review compares with it. The lead's proposals, Goal breakdowns and Feature design steps wait for a real PE run; after 3 rounds, Needs you. `peReviewsNewWork` is on for new projects and off for upgraded ones, so an upgrade starts no paid run.

**5a, the draft and Lock in.** The blueprint always has a draft (a full working copy; its changes are derived). Approvals and drops change only the draft. Only the owner's `lockIn` (or `startFactory`, the first Lock in) may add a blueprint revision; the store refuses any other write that tries. Lock in records the summary computed at that moment. The app sends the draft revision and a digest (SHA-256 of the canonical JSON) of the summary it showed, and the Lock in is refused as stale when the summary it would record has another digest, so the draft, a task's state or handling, and the budgets cannot change unseen (review finding 13). Start the factory checks the pre-flight's summary the same way when it locks a change in. Only a queued task retires; a running one finishes, then the lead revises it (r14). "Back to vision" is removed, and studio runs work on the draft in either stage. The lead, the designer and the PE use the draft's dictionary; factory agents use the one in force.

**5b, the lead adjusts the factory.** An open change order starts one lead run. Its answer (a schema-checked block) updates queued specs, adds revision tasks, retires tasks and plans new work. Each line is one row of a steering change set, so the owner can undo each line. Under "ask me first", the lines are suggestions to apply or dismiss. PE review sits on each new or updated task. What the lead leaves goes to Needs you; the owner can close a change order as it stands (`closeChangeOrder`). **The lead may update the spec of a queued task that the owner created**, because the owner locked in the change; each update can be undone. After the start, a vision text edit goes into the draft too, and Lock in puts it into force.

**U2, evidence capture.** The coder writes a capture plan in the change (`.orchestrator/capture.json`): each screen item's page path and devices, and a tape that runs the real CLI. A service step, "Capture evidence", runs after the checks in the Feature flow, in the recorder image (`orchestrator-recorder:2`, with playwright-core 1.63.0): an install with the network and every install hook off, then, with no network, the preview, the screenshots and the tape. Only the files the plan names come back. Real tests: the fixture app in about 23 s; a hostile fixture reached nothing (a canary listener on the Mac got no connection).
- **Known gaps for the review:** the install container (with network) can reach the Mac's loopback through Colima; no repository code runs then, and the app refuses foreign Host headers. The built app runs as the same user as the capture, so code meant to deceive could plant a picture.

**5d, the screens.** The header's two places on every screen; the draft bar; the Lock in summary (`#/vision/lock-in`, "no estimate" never shown as $0, a changed summary clears the checkbox); "Design and reality" as a list (`#/results/design`) with each item's status and rule table. **The lead's decision:** a status "built, not verified", with its reason, for landed work that the checks do not prove (the agreed statuses had none, so such work showed "being built", which was not true).

**Housekeeping** (the owner's request, 2026-10-03: "cleanup orphaned codex chat sessions and … build some management of orphaned sessions into the factory"). At start, every 6 hours, and on "Clean up now", the service finds only what it can prove Orchestrator made: Codex threads with its client name as originator (archived; held-open threads wait for the next sweep), Claude session folders named for its own working folders (moved to the Trash on macOS), and its own stray containers (removed). Provider processes are left out: nothing records which ones an earlier service started. A setting turns off the part that touches the owner's apps. The real sweep on this computer found nothing.

**Still to come in pass 5:** the change order screen, the evidence beside the design, the settings forms (5e); the factory trial (5f); an independent review; one real trial.

## The independent review of pass 5 (2026-10-03)

The diff `97d7435..ab23aa9`, read by a reviewer that did not write it: **2 high, 6 medium and 6 low findings.** The blueprint's store guard is sound: only the owner's `lockIn` and `startFactory` write `blueprint.revisions`.

- **High 1:** the lead's "retire" in a change order could cancel a task that the owner wrote, against the Lock in's agreed handling.
- **High 2:** the lead's spec update in a change order could clear a PE objection that waits for the owner.
- **Medium:** a new project kept the old project's preview setting (3); the lead could replace a rule's text under its own tag (4); a spec update dropped the owner's chosen option and fields (5); per-line Undo broke after a PE round (6); a line's status lived only in the capped steering log (7); a networked install could send data to hosts named in a lockfile or `.npmrc` (8).
- **Low:** the test report's declaration guard could be bypassed with a processing instruction (9); change-order rows in a refused steering set (10); a failing tagged test dropped from a large report (11); the overclaim "an agent cannot plant results" (12); the Lock in record versus what the owner saw (13); the store guard's reference comparison (14); "being built" counting work on an older version (15); and a stage folder that may leak (to verify).

**The fix round:** R1 fixes 1, 2, 4, 5, 6, 7 and 10 (the change orders); R2 fixes 3, 9, 11–15 and the stage folder; **8 is closed by the project environment's egress proxy** (`docs/design/project-environment.md`, units E1 and E2), which also makes the checks and the evidence language agnostic (the owner, 2026-10-03: "Really this should be language agnostic for what we build").

