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
