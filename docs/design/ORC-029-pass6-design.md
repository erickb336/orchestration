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

## The independent review of pass 6, the environment and the fix round (2026-10-03)

The diff `c969f24..219b463`, read by a reviewer that did not write it: **3 high, 6 medium and 4 low findings.** The real trials had passed (the factory trial 12 of 12, the real-run scenario 17 of 17), so these are defects the trials did not reach.

- **High:** a tape's `Wait` pattern could freeze the service (measured: 79 s for one match); a CLI's output could use up the service's memory (measured: 16 KB of output grew the heap by 624 MB); an agent's merged dev container could replace the owner's confirmed image, because the dev container file was not protected and wins unconfirmed.
- **Medium:** clean-up ran while the container was alive and could follow a planted link onto the Mac; the setup probe never tried the Docker VM's own address and counted "connection refused" as unreachable; the owner's chosen option was kept by its id only; a new project inherited the old environment; a dev container without prepare commands broke the checks and reported "prepared"; the claim that pass 5 finding 8 is closed was too broad.
- **Low:** the safety notes did not describe E2; no disk limit on the mounted folders; some IPv6 forms of local addresses passed the proxy's check; the prepare step faked a check assignment, and a JVM-specific environment variable was a language code path.

**The fix round, as built.** Two workers fixed all 13 findings, each with a test that failed before its fix.

- **F1, the terminal session and the domain (1, 2, 6, 7, 9):**
  - 1: the service tests each Wait pattern in a worker thread with a 0.25 s limit, and a slower pattern fails with "use a simpler pattern". The review's pattern now answers in 263 ms, and the event loop is blocked for at most 2 ms. Plain text only was rejected, because the same tape runs in VHS, where Wait takes a regular expression. RE2 was rejected: its packages download or build a binary, or have no release since 2022.
  - 2: the cursor stops at the session's width, a line holds at most that width, the Waits see the last 500 lines and the transcript keeps the last 20,000. The review's 16 KB of output now adds 0.2 MB, not 605 MB.
  - 6: the owner's option counts as kept only when its id, name and approach are unchanged. Otherwise the update waits for the owner. The change-order brief now shows the chosen option word for word, so the lead can keep it.
  - 7: a new project clears the old environment, and also the notes queued for the old project's tasks.
  - 9: the pass 5 design says finding 8 is closed only for a project with an environment and Docker.
- **F2, the project environment (3, 4, 5, 8, 10, 11, 12, 13):** the choices and the measurements are in `project-environment.md`.
  - 3: a dev container is used only after the owner confirms its digest (the file and the Dockerfile it names), from Settings › Environment or Needs you. A new or changed one falls back to the confirmed image, with the reason. New projects protect `.devcontainer/**`, `.devcontainer.json` and Dockerfiles. A Dockerfile's `# syntax=` line and `RUN --mount` are refused, whatever the builder. "The confirmed image always wins" was rejected, because a project with no confirmed image would still run an agent's dev container.
  - 4: the copy is removed only after Docker lists no container that mounted it, and the walk never follows a link.
  - 5: the probe tries every gateway of the private network on port 22, and only no route or a time-out counts as unreachable.
  - 8: with no environment prepare commands, the checks' own prepare commands run in the prepare phase; with neither, the record and the card say "none".
  - 10: the safety notes describe E2 and these fixes. 11: an 8 GB limit on the mounted folders. 12: every IPv6 form of a local address is private. 13: the prepare step has its own module, and the JVM variable is gone.
- **Checks after both merged:** `npm test` 2,211 passed and 1 skipped; the typecheck, the build and the integration scenario pass; the three browser passes (the pre-flight, the floor, Design and reality) and the three simulated trials pass. F2 ran the real Docker tests: 14 of 14.
- **Not verified:** the Settings card in a browser; a BuildKit build on a machine with buildx; a Docker engine that ignores the isolated network mode; the Java row of the image table; a real lead's change-order answer with the new brief line.

