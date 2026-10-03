# Real-model runs

Each JSON file here is the record of one run with real Claude and Codex agents, on a throwaway repository. Most are runs of `npm run test:real`, the end-to-end scenario ([ORC-027](../tasks/ORC-027.md)). The others are the studio and factory trials (`npm run trial:studio`, `npm run trial:factory`, [ORC-029](../tasks/ORC-029.md)) and the helper checks of [ORC-031](../tasks/ORC-031.md).

**What a record holds:**

- every check, and whether it passed;
- each step of the scenario, with timings;
- the models that ran, with their usage;
- the agents' report and brief summaries;
- the Orchestrator commit that ran (from the second record on).

File names are the run's start time in UTC.

**What it leaves out:** local paths are replaced with `<work>`, `<orchestrator>` or `~`, and the service log stays in the local `evidence/` folder. The scenario checks a record before writing it (`scripts/recordLeaks.mjs`, plus your user name, computer name and git email) and keeps it out of this folder if anything is found. A unit test (`server/realRunRecords.test.ts`) runs the same check on every record here.

| Run | Ran by | Checks | What it showed |
| --- | --- | --- | --- |
| [2026-10-01T23-59-48-076Z](2026-10-01T23-59-48-076Z.json) | The owner | 11 of 11 | Codex and Claude at once; truthful pause and resume per task and per project; both tasks finished |
| [2026-10-02T02-22-16-079Z](2026-10-02T02-22-16-079Z.json) | The lead (Claude Code), with the owner's credentials | 13 of 13 | The same, plus a note to each running agent, acknowledged by both runtimes and followed by both reports. Claude's report dropped its list of files read; the review and the lead caught it. Ran from `1746324` plus this change's scenario edits, not yet committed (`uncommittedChanges: true`) |
| [2026-10-02T02-59-21-044Z](2026-10-02T02-59-21-044Z.json) | The lead (Claude Code), with the owner's credentials | 15 of 15 | After ORC-028's first version. Notes sent as soon as each agent was dispatched were acknowledged by both (whether Codex held its note was not recorded yet). Claude's report again missed its files-read list; the review found it, the new revise step (on Codex) fixed it, and the second review was clean. Ran from `9843367` plus ORC-028's changes, not yet committed |
| [2026-10-02T03-14-14-830Z](2026-10-02T03-14-14-830Z.json) | The lead (Claude Code), with the owner's credentials | 15 of 15 | ORC-028 after its review, from a clean commit (`2628c42`). Notes acknowledged by both; neither was held (each agent's turn had begun). Claude's report gave a wrong line count in answer to the note; the review raised it as an error, the revise step (on Codex) fixed it, and the second review was clean |
| [2026-10-02T11-35-02-810Z](2026-10-02T11-35-02-810Z.json) | The lead, with the owner's credentials | 9 of 9 | The first studio trial: a real Claude designer and a Codex PE on one round; about $0.26 of Claude |
| [2026-10-02T17-41-38-949Z](2026-10-02T17-41-38-949Z.json) | The lead, with the owner's credentials | 7 of 9 | A studio trial with a real lead. One missing brace lost the lead's whole reply; schema-constrained output fixed it |
| [2026-10-02T19-07-28-755Z](2026-10-02T19-07-28-755Z.json) | The lead, with the owner's credentials | 8 of 9 | The PE review loop did not converge in three passes; open cases for the owner fixed it (pass 4e) |
| [2026-10-02T20-06-37-859Z](2026-10-02T20-06-37-859Z.json) | The lead, with the owner's credentials | 9 of 9 | The PE agreed on the first pass and sent 6 product questions to the owner as open cases |
| [2026-10-03T08-10-44-692Z](2026-10-03T08-10-44-692Z.json) | The lead, with the owner's credentials | 12 of 12 | The factory trial: a Feature task built from a blueprint, evidence captured, a rule failing on purpose, the statuses truthful; about $0.61 of Claude. The lead and the designer were stand-ins (`standIns`) |
| [2026-10-03T08-17-43-063Z](2026-10-03T08-17-43-063Z.json) | The lead, with the owner's credentials | 17 of 17 | `npm run test:real` with a studio round before the start, and the start through the pre-flight's command; 149 seconds, about $0.17 of Claude |
| [2026-10-03T08-25-14-231Z](2026-10-03T08-25-14-231Z.json) | The lead, with the owner's credentials | 5 of 9 | Claude helpers on Haiku: the parent answered with no tool call, so the cap could not be tested. Kept as a record |
| [2026-10-03T08-25-56-353Z](2026-10-03T08-25-56-353Z.json) | The lead, with the owner's credentials | 7 of 9 | Claude helpers on Sonnet: the cap, the guard and pause held; two reporting checks failed and were fixed |
| [2026-10-03T08-34-11-166Z](2026-10-03T08-34-11-166Z.json) | The lead, with the owner's credentials | 9 of 10 | Codex sub-agents: pause, cost and the sandbox held; the cap holds only at once, not per run, so Codex's helpers stay off |
| [2026-10-03T08-35-46-945Z](2026-10-03T08-35-46-945Z.json) | The lead, with the owner's credentials | 9 of 9 | Claude helpers on the fixed adapter: all four points held, so Claude's helpers are supported |

**Not run with real models yet:** pull-request delivery with real workers; steering by a real lead, and the notes it sends; whether the principles change what agents do; a Codex note held before its turn starts; a real lead and designer through a whole factory run (the factory trial used stand-ins for them); the setup path (`npm run setup`) with real sign-ins. Every feature is also tested against simulated and scripted runtimes, and CI runs the end-to-end scenario on simulated agents.
