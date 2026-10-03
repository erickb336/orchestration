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
- **Resume** starts a fresh attempt of the step from its saved inputs.
- **Cancel task** stops the task for good.

## Edit or rerun a step

- **Edit** a step's output. Later steps use your version, and the record keeps both.
- **Rerun** a finished step. The steps after it run again on its new output.

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
