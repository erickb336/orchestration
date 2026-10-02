# Real-model runs

Each JSON file here is the record of one run of `npm run test:real`. That command runs the end-to-end scenario ([ORC-027](../tasks/ORC-027.md)) with real Claude and Codex agents, on a throwaway repository.

**What a record holds:**

- every check, and whether it passed;
- each step of the scenario, with timings;
- the models that ran, with their usage;
- the agents' report and brief summaries;
- the Orchestrator commit that ran (from the second record on).

File names are the run's start time in UTC: both runs so far were on 2026-10-01 in the owner's time zone.

**What it leaves out:** local paths are replaced with `<work>`, `<orchestrator>` or `~`, and the service log stays in the local `evidence/` folder. The scenario checks a record before writing it (`scripts/recordLeaks.mjs`, plus your user name, computer name and git email) and keeps it out of this folder if anything is found. A unit test (`server/realRunRecords.test.ts`) runs the same check on every record here.

| Run | Ran by | Checks | What it showed |
| --- | --- | --- | --- |
| [2026-10-01T23-59-48-076Z](2026-10-01T23-59-48-076Z.json) | The owner | 11 of 11 | Codex and Claude at once; truthful pause and resume per task and per project; both tasks finished |
| [2026-10-02T02-22-16-079Z](2026-10-02T02-22-16-079Z.json) | The lead (Claude Code), with the owner's credentials | 13 of 13 | The same, plus a note to each running agent, acknowledged by both runtimes and followed by both reports. Claude's report dropped its list of files read; the review and the lead caught it. Ran from `1746324` plus this change's scenario edits, not yet committed (`uncommittedChanges: true`) |
