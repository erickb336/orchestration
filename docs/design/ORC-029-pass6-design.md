# ORC-029 pass 6: the pre-flight, the factory floor, and the words

**What this is.** The design for pass 6, the last pass of ORC-029, the vision studio. It builds the two screens the owner agreed to in pass 1 that are not built yet: **the pre-flight** before Start the factory, and **the factory floor**, Home after the start. It adds the settings the owner needs to run the factory (budgets, devices, overrules), puts the new words (Vision, Factory, Lock in) across the whole app, and proves the result with a real run.

**Where it fits.** Passes 1–5 built the studio, the draft and Lock in, the factory link, evidence, and change orders. Today the start is still a text confirmation ("Start building"), Home still shows the old shaping panel and board, and 31 places in the app still say "Shaping", "Building" or "Start building". After pass 6, ORC-029 is complete; ORC-031 (subagents in research steps) is next, and ORC-030 (QA, UI audit and the new demo) comes last.

## The screens (agreed in pass 1)

The source is `docs/design/ORC-029-pass1-prototype.html`, screens 7 and 8 (the owner's marks: Agree). Pass 5 changed two things since then: the stepper "1 Vision → 2 Factory" is replaced by the two places in the header, and "Back to vision" is gone.

**The pre-flight (screen 7).** The one way the factory starts: the owner's explicit agreement, from here. Start the factory is the first Lock in, so the pre-flight holds the Lock in summary (pass 5) and adds:
- **The blueprint:** what is approved per focus (experience, inputs and outputs, flows), PE review on every approved item, and what is still open (a probe running, a pick open, a flow not started), named and confirmed, never a block. An empty vision blocks, as today.
- **What the factory will do:** the tasks planned from the blueprint (by flow), the roles and their providers, agents at once, run limits, and both budgets beside the PE's estimate.
- **How the factory runs, set here and changeable later:** Autopilot, Check-in or Manual; who merges; where it pauses or asks (at the budget, always; trade-offs; change orders; before each task; before merging).
- The agreement checkbox and **Start the factory**; the start records the summary and the settings.

**The factory floor (screen 8).** Home after the start:
- **Needs you first.**
- **The two budgets:** building spent of the budget, with the PE's estimate for the rest; maintenance estimate a month, updated as tasks land.
- **One line per area,** with each task moving along it (building, review, checks, landed), and a change order or "needs you" marked on its task.
- **Decided by the PE on Autopilot:** each trade-off call within budget, with "Reverse" and "See the reasons".
- An open change order links to its screen (pass 5).

## Settings

- **Budgets:** building and maintenance, with "continue past the budget" when the factory stopped at it.
- **Devices:** the device scope (desktop, mobile, terminal) for designs.
- **Overrules:** the owner can overrule a PE objection in the factory (as in the studio) and reverse a PE trade-off call, each with a reason.

## The words

Across the app, the README and the docs: **Vision** (not Shaping), **the factory** (not Building), **Start the factory** (not Start building), **Lock in**, **the draft**, **change order**, **the blueprint**. The domain's stage values stay as they are (`shaping`, `building`); only the words change.

## Proof

- The real-run scenario (`npm run test:real`) gains a studio round before the start, and starts the factory through the pre-flight's command.
- A browser pass at 1280 and 375 wide on the pre-flight and the factory floor.
- An independent review, then the pull request.

## Units

| Unit | Contents |
| --- | --- |
| 6a | The pre-flight screen, and the settings it sets |
| 6b | The factory floor (Home after the start), and PE trade-off Reverse |
| 6c | Budgets, devices and overrule settings; the words across the app, the README and the docs; the real-run scenario's studio round |
