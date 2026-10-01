# ORC-023 UX: Orchestrator inside Claude Code

Draft r1. Lead (Claude), 2026-10-01. A working draft for the owner to iron out. The open decisions are listed at the end.

## What it is

You talk to your project's lead from any Claude Code session, wherever you are:

- the terminal;
- the desktop app's Code tab;
- your phone, through Remote Control.

There are three pieces:

1. **A local MCP server** that talks to the engine's API on 127.0.0.1. It starts the engine if it is not running.
2. **A Claude Code plugin** (`orchestrator`). It holds a few commands, plus a skill that tells Claude how to behave as a relay.
3. **A project registry** (`~/.orchestration/projects.json`). It maps a repository to its engine (data folder, port, demo or real), so the right lead answers in each repository.

Codex comes later, on the same MCP server.

## Principles

1. **One lead.** The Claude session relays; it never decides direction itself. Anything that changes the work goes to the lead as your message. The lead's reply is shown word for word, with its numbered changes.
2. **Reads are instant.** Claude answers questions like "what's going on" and "what needs me" from the engine's data, without a lead run.
3. **Your decisions only on your word.** Claude acts on a "needs you" item (choose an option, decide a finding, merge, undo) only when you say so explicitly. A merge or a cancel also shows Claude Code's permission prompt.
4. **Truthful.**
   - "Lead is working" while it works.
   - Notes say Delivered or Not delivered.
   - The demo says simulated.
   - Nothing is claimed that the engine has not recorded.
5. **Small.** About five commands; plain words for everything else.
6. **Rich views stay on the web page.** Diffs, artifact versions, screenshots and boards stay there. Every reply links to the right page (`http://127.0.0.1:<port>/#/task/WT-031`).

## Where you use it

| Surface | How | Notes |
| --- | --- | --- |
| Terminal | `claude`, in a repository | The main place to start |
| Desktop app, Code tab | The same plugin | To verify: plugin commands and the MCP server in the desktop app |
| Phone | Claude app → Code tab → the Remote Control session on your Mac | GA. Slash commands and MCP tools work. The Mac must stay on, and push notifications arrive when the session needs you or finishes |
| Discord, Telegram, iMessage | Anthropic's official channel plugins, which message the same session | Research preview. This replaces building our own Discord bridge |

## Commands (draft)

The plugin's commands are namespaced: `/orchestrator:<command>`.

| Command | Does |
| --- | --- |
| `/orchestrator:lead <message>` | Sends your message to this repository's lead and shows its reply |
| `/orchestrator:status` | This project's engine, then one line for each other running project |
| `/orchestrator:needs` | What needs you, numbered |
| `/orchestrator:open [task]` | Opens the web page, on the task if given |
| `/orchestrator:setup` | Registers this repository as a project, or changes its settings |

Plain words do the rest through the skill, for example:

- "pause WT-031";
- "undo 2";
- "what is WT-031 doing";
- "switch to apps";
- "stop the engine".

## Flows

### 1. First use in a repository

```
› /orchestrator:status
  This folder (~/workspace/SimpleApps) is not an Orchestrator project yet.
  Set it up? It gets its own engine and lead.
    1. Demo (simulated, no agents run)   2. Real agents (Claude and Codex, may cost money)
› 2
  Registered "simpleapps" → engine on 127.0.0.1:5321, data in ~/.orchestration/projects/simpleapps.
  Claude: signed in (subscription token from the Keychain). Codex: signed in (ChatGPT).
  Engine started. The lead has no vision yet: tell it what you are building with /orchestrator:lead.
```

### 2. Asking the lead

```
› /orchestrator:lead the draft submit crash Balthazar posted — repro and fix it, full autopilot
  Sent to the lead (simpleapps). Lead is working (Claude · opus)…
  ── Lead ───────────────────────────────────────────────
  On it. WT-031 "Draft submit crashes on empty title" runs the Bug fix flow on Autopilot:
  reproduce first, then fix, regression test, code and security review, then a pull request.
  Changed:
    [1] WT-031 created · Bug fix · Autopilot            (say "undo 1")
  ───────────────────────────────────────────────────────
  Open: http://127.0.0.1:5321/#/task/WT-031
```

- **While the lead works,** the command waits. After 2 minutes Claude Code moves the wait to background tasks, so you can keep working, and the reply appears when it is ready. (Open decision 2.)
- **The lead's reply is shown as written.** Claude does not summarise or reword it.

### 3. What needs you

```
› /orchestrator:needs
  simpleapps · 3 need you
    1. WT-028  PR #14 ready to merge · clean code and security review · checks passed   (merge / open)
    2. WT-029  Choose an option: "Offline sync: A) queue edits  B) last write wins"    (choose A / B)
    3. WT-031  Finding to decide: "Empty title should show a message, not save"        (fix / accept / ask lead)
› merge 1 and choose A on 2
  [permission prompt: orchestrator · merge WT-028 PR #14 at 4f2a9c1e7b20]
  Merged WT-028 PR #14 (4f2a9c1e7b20). WT-029: option A chosen.
```

### 4. Course correction while a stage runs (ORC-022)

```
› /orchestrator:lead tell the coder to leave the migrations alone
  ── Lead ── Sent a note to WT-031 S2 (Coder · Codex).
    [2] Note → WT-031 S2 · Sending…
› what is WT-031 doing
  WT-031 · Bug fix · running S2 Implement (Codex · gpt-5.5) · 6 min
    S1 Reproduce ✓ (crash reproduced: empty title → nil deref in DraftStore.save)
    Note [2] delivered 1 min ago
```

### 5. Several projects

```
› /orchestrator:status
  simpleapps (this folder) · real · 2 agents working · 1 needs you · focus: "Offline first"
  orchestrator             · real · 1 agent working  · 0 need you
› switch to orchestrator
  Talking to orchestrator's lead for this session. (Changing folders also switches.)
```

### 6. From your phone

- Open the Claude app → Code → your Mac's session (Remote Control).
- Then use the same commands and words.
- The Mac must stay on and awake: the engine and the session run there.

### 7. When something is wrong (each says what to do)

- **The engine is not running and cannot start:** the reason, and the log path.
- **A provider is not signed in:** which one, and the command to fix it. Never a token in chat.
- **The lead's run failed:** the failure as the engine recorded it, plus "try again" or "open".
- **The engine is busy or paused:** "Paused by you since 14:02; say 'resume' to continue."

## What the engine needs for this

1. **Starting a task from chat** (a new steering change, "create", with Undo). The flagship "repro and fix X, full autopilot" depends on it. Today the lead's chat only changes focus and priority, defers or drops.
2. **A project registry** and launcher support for one data folder and one port per project.
3. **A reply hook.** The MCP server follows the engine's live stream (`/api/stream`) to learn when the lead has answered a given message.

## Out of scope for v1

- Codex packaging (the MCP server stays provider-neutral).
- Pushing "needs you" into the session unprompted. Channels can do it, but they are a research preview, so v1 relies on Remote Control's notifications and on `/orchestrator:needs`.
- Our own Discord bridge (the official channel plugins cover it).
- A custom terminal chat (the plugin replaces it).

## Decisions so far

The owner decided these on 2026-10-01:

- **Waiting for the lead.** The command waits for the reply; after 2 minutes Claude Code moves the wait to background tasks, and the reply appears when ready.
- **Status questions.** Claude answers them from the engine's recorded data, with no lead run. Anything that changes the work goes to the lead.
- **Decisions from chat.** They are allowed on your explicit word ("merge 1", "choose A on 2"). Merges and cancels also show Claude Code's permission prompt.
- **The command shape is still open.** The owner asked what would serve "a dev building very large projects iterating on e2e features rather than code". The draft below answers that.

## Draft: features, not code (for very large projects)

The unit you think in is a feature you can try end to end, not a task or a diff. The conversation and the commands should be about features.

| Your job | What you see | How you ask |
| --- | --- | --- |
| Start or reshape a feature | The lead turns it into a Goal: an outcome, acceptance scenarios a user could act out, and child tasks | `/orchestrator:lead build trip sharing: invite by link, guests join without an account` |
| Know where a feature stands | A feature card: each scenario ✓ verified, ✗ failing or ○ not yet; what is running; what needs you; cost so far | "how is trip sharing?" |
| See it working | Evidence per scenario: screenshots or a recording from the last verified run, and a link to the web page | `/orchestrator:show trip sharing` |
| Try it yourself | The app at the feature's latest state, running locally (simulator or web) | `/orchestrator:try trip sharing` |
| Steer by behaviour | Edit or add a scenario ("a guest sees who else is coming"); the lead re-plans | Plain words to the lead |
| Report what you saw | "The link opens the wrong trip on Android" becomes a Bug fix task on that feature, reproduced first | Plain words to the lead |
| Catch up after a break | What changed per feature since you last looked, and what landed for review | "catch me up" |
| Review | Landed work grouped by feature, with the evidence, reviewed as one | `/orchestrator:needs` |

**What already exists:**

- Areas, with progress by area;
- the Goal flow (a feature broken into child tasks);
- acceptance criteria on specs;
- the Review page.

**What this needs:**

1. **Features as first-class.** A Goal gets acceptance scenarios with a verified state each. The card rolls up the Goal's children.
2. **Evidence per scenario.** A per-project verification recipe drives the app the way a user would and records screenshots or recordings. This is the "verification recipe" milestone, pulled forward.
3. **"Try it."** Run the app at a branch or commit locally. For the Expo apps: the iOS simulator or the web build.

**The proposed command set for this persona:**

- `/orchestrator:lead`
- `/orchestrator:status` (features, not tasks)
- `/orchestrator:show <feature>`
- `/orchestrator:try <feature>`
- `/orchestrator:needs`

Plain words do the rest.
