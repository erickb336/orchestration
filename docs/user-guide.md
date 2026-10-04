# Stepping in

**What this is.** How you steer Orchestrator while it works: the lead, notes, pause, edits and reruns. The [README](../README.md) says how the whole product works; this page covers what you can do once tasks run.

## Message the lead

The lead is your main channel. Write to it in the lead conversation. It can:

- change the focus, or reorder and defer open tasks;
- drop one of its own proposals that has not started;
- pass a note to an agent at work.

Each change it makes has an Undo. Only runs that answer your messages may steer, so text an agent wrote cannot steer the project.

## Send a note to a running agent

Open the task, and write a note to the step that runs. The note shows **Delivered** once the runtime acknowledges it, or **Delivered when the run started** when it waited for the agent to start.

## Pause, resume and cancel

- **Pause** a task or the whole project. The task reads **Pausing** until its agent confirms the stop, and then **Paused**. A pause stays until you resume.
- **Resume** starts a fresh run of the step. When the paused run had changed files, the fresh run starts from those changes and reviews them first, so no work is lost. If the step's inputs changed while it was paused, it starts from its inputs again, and the run says why.
- **Cancel task** stops the task for good.

## Edit or rerun a step

- **Edit** a step's output. Later steps use your version, and the record keeps both.
- **Rerun** a finished step. The steps after it run again on its new output.

## Import an existing repository

The import reads a repository you already have and shows, in Vision, what the product does today. You answer only what the code cannot. Your Lock in then makes it the baseline: in force and built.

1. **Start.** Open Settings › Project › Start a new project, and choose **Import an existing repository**. Give the repository's path, and click **Read the repository**. In the demo, click **Try the import on a sample repository (tally)** instead. If the sample's agents are running, the import pauses them first and says so; you do not pause them yourself.
2. **Check what it found.** The import reads the last commit. Changes you have not committed are left out. The kind of product, the devices and how it runs come prefilled, each with its reason. Change any that is wrong.
3. **How it runs.** The environment, the test command and the path of its JUnit report let the import run your tests once and record the CLI and the screens, in a container with no network. For a screen product on a desktop or a phone, give the preview command and its port too: the import opens each screen's page there. Without a test command, every rule is read from the code. Without a preview command, the screens are not recorded. Without an environment, none of your code runs.
4. **Who reads it.** Claude reads the repository by default, and its reads stay in a read-only copy. Pick Codex only for a repository you trust: its reads are not confined to the repository.
5. **Budget.** The import has its own budget, $3 by default, with an estimate beside it. At the budget the import waits: the reading, the review and the Lock in screen say so, with **Raise the budget**. It spends nothing from the building budget.
6. Click **Start the import**. Vision shows the reading: the tests, then the rules, then the parts, then the recording; the words at the same time. You can leave the page, or pause the import. While it is paused or stopped, every step says so.
7. **Review.** Round 0, *As it is today*, asks at most 10 questions: conflicts first, then the guesses that change what the product does. Confirmed rules and the parts are listed, each part with what it shows: its recording, its pseudo-code or data, or its words. Click **Correct** on any item that is wrong: "should do something else" is a change to design; "does something else today" means the reader misread the code, and a designer fixes the part before the baseline. Click **Send to the lead**. You can send with no answer: every question stays open. The vision text and the lead's draft of it are at the top of the review.
8. **Baseline.** The Lock in screen says what goes into force, the changes to design that stay out, and what stays open. Tick your agreement, and click **Lock in the baseline**.

After the baseline, Vision names round 0 *Lock in 1 · the baseline*. Its parts take no mark: a round changes them. The questions you left open stay in Vision, to answer there. Results › Design and reality shows each part with its tests and its recording. Home says "Nothing to build" until you change the design. To design the changes you asked for, click **Ask the lead for a round**, on Home or beside the list of changes in Vision. Your first change starts the factory through Start the factory. No file in your repository changes, and the vision stays on this computer.

## Change what is built

Vision stays open while the factory runs.

1. Make a new design in Vision, and approve it into the draft.
2. Click **Lock in**. It first shows what changes: the tasks it touches and what happens to each, the new work and the budgets. That is a **change order**.
3. The lead updates the tasks. It asks you first when an update changes an option you chose. A running task finishes first, and then the lead revises it.

Each line of a change order has an Undo.

## How the factory runs

You choose this on the pre-flight, and you can change it later in Settings:

- **Autopilot:** the lead plans and work starts without waiting for you. The PE decides trade-offs within the budget, and Home lists each call with Reverse.
- **Check-in:** each task the lead proposes waits for your go-ahead. After that it runs by itself.
- **Manual:** the lead works only when you message it. Tasks you create still run, and nothing new is planned.

At the building budget the factory always stops and asks you.

## Overnight runs

On a Mac, the service keeps the Mac from sleeping while any agent or check runs, and lets it sleep again when none does. The display can still sleep. Settings › Advanced shows it. On other systems, keep the computer awake yourself.
