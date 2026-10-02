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

The units and the domain design follow the owner's marks.

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

