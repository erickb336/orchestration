# The first real import: a walkthrough

This page takes you through the first import with real agents, on a small throwaway repository, with a $5 cap. You do every step yourself: no agent starts this run.

The import (ORC-032) has run only on simulated agents so far. This run shows whether it works with real Claude runs and real tests. The chief reads what you send back (step 7) and plans the fixes.

**What is real and what is not.**

- Real: the readers are real Claude runs, and they cost money. Your tests run for real, once, in a Docker container with no network.
- Not real: the repository. `tip` is a small invented program that the script below makes.
- Not measured: the cost. Start shows an estimate from a formula. Nobody has measured a real import of this repository.

## 1. Before you start

1. Start Docker (`colima start`). The import runs the tests only in a container. Without Docker, the tests show "not run".
2. Open a terminal where your Claude token is set: your usual `zsh` login shell, as for `npm run test:real`. Do not paste the token anywhere.
3. You need nothing else. Codex is not needed: Claude reads the repository by default.

## 2. Make the trial repository

From this checkout, run:

```bash
scripts/real-run/make-trial-repo.sh
```

It makes `~/workspace/orchestrator-trial` with one commit, and refuses if that folder exists. To use another folder, give its path as the first argument. Keep the lines it prints: you type them into Start in step 4.

## 3. Start the service in real mode, with its own data

```bash
ORCHESTRATION_RUNTIME=real ORCHESTRATION_DB=~/workspace/orchestrator-trial-data/orchestration.db npm start
```

`ORCHESTRATION_DB` gives the trial its own data file. Start a new project replaces the board and its history, so this keeps your usual real-mode project as it is. The terminal prints the address (http://127.0.0.1:5319 unless you saved another port), and the browser opens it.

## 4. Fill in Start

1. Open **Settings › Project**. In **Start a new project**, open **New project form**, and choose **Import an existing repository**.
2. In **Repository path (absolute)**, type the path that the script printed. Click **Read the repository**.
3. Check the **✓ Found** line. It names the commit that the script printed (7 characters, on main). Start has no commit field: the import reads the last commit.
4. Check the prefilled values. Change nothing that matches:
   - **Kind of product**: Screen product. **Devices**: Terminal.
   - **How it runs**: **Use the image Python** is ticked. **Test command** is `python3 tests/run.py`. **JUnit report path** is `reports/junit.xml`.
   - **Who reads it**: Claude.
5. In **Import budget (dollars)**, type `5`. The default is 3. Read the estimate under it: for this repository the formula gives about $0.40–$1.65.
6. Click **Start the import**, then confirm. The app opens Vision.

The import has its own budget, and it spends nothing from the building budget in Settings › Budgets. You stop after Baseline, so you do not need to set the building budget.

## 5. What each screen shows

1. **Vision, the import** (reading): the spend line ("$… spent of the $5.00 import budget"), the steps, and the cards The rules, The parts and The words. The tests run first. Then a reader turns them into rules, and a designer makes the parts.
2. **Vision, Round 0 · As it is today** (review): at most 10 questions, about conflicts and important guesses. Answer them, or leave them open. Click **Send to the lead**.
3. **Vision › Lock in** (baseline): the parts that become the baseline, what stays open, and **The budgets** ("Import: $… spent of $5.00"). **Lock in the baseline** is the last step. It is safe here, because the trial has its own data.

## 6. How to stop

- **Pause the import** is on the import's card. **Resume the import** goes on.
- **At $5, the import waits.** The app says "The import waits at its budget". Nothing new starts until you raise it. Do not raise it: stop the service instead. I did not check whether a run that is under way at that moment stops, so the total can go a little past $5.
- **Ctrl-C** in the terminal stops the service.

## 7. What to send back to the chief

1. A screenshot of the review screen (Round 0 · As it is today), before you click Send to the lead.
2. A screenshot of the baseline screen (Vision › Lock in), before you lock in.
3. The spend line from the import's card or The budgets: what was spent of $5.00, and the estimate.
4. Anything that stopped or looked wrong, with a screenshot.

When you are done, you can delete `~/workspace/orchestrator-trial` and `~/workspace/orchestrator-trial-data`.
