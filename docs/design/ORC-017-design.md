# ORC-017 design: the demo story and the visual pass

Spec: `docs/tasks/ORC-017.md` r1. Product context: `PRODUCT.md`.

This document gives builders the direction, the tokens, the component decisions, the tour, and the full sample story. Builders must not invent a visual direction or sample content beyond it. Anything open is listed in §8.

## 1. Direction

- **Mode: Operate.** People use Orchestrator to watch and steer work. Being able to scan it and trust it matters more than expression.
- **The look the code already has is the authority.** We refine it; we do not replace it:
  - ink on paper;
  - black primary actions;
  - the platform's sans-serif font;
  - grey surfaces;
  - a black demo bar.
- **Colour means state, and nothing else.** There are four hues, each always paired with a text label:

| Meaning | Token | Used for |
| --- | --- | --- |
| Agents working | `--st-work` (blue) | running, reviewing, checks running, a pull request being merged |
| Needs you | `--st-you` (amber) | a decision, a pull request held for you, a review gate, an ask-user finding, waiting on a failed check |
| Failed | `--st-fail` (red) | blocked, failed check, failed run, lost run |
| Done | `--st-done` (green) | done, merged, passed |

Everything else is neutral grey: proposed, ready, paused, deferred and cancelled. Paused stops being amber. It is a calm grey pill with a pause mark and the word "Paused", because a pause is the user's own choice, not a request for attention.

- **What the polish must achieve.** A first-time visitor should answer three questions within five seconds of opening the Overview:
  - How far along is each part of the product?
  - What are the agents doing right now?
  - What needs me?

## 2. Tokens (replace the current `:root` block; keep the same dark-mode mechanism)

- **Type.**
  - Keep the system font stack: it is the platform's own face, there is no network font, and README screenshots are taken on macOS, where it renders as SF Pro.
  - Scale, fixed rem, ratio about 1.2: 0.75 (micro), 0.8125 (small), 0.875 (meta), 0.9375 (body, 15 px), 1.0625 (h3), 1.25 (h2), 1.5 (page title).
  - Weights: 450 (body), 560 (labels and buttons), 650 (titles).
  - Add `font-variant-numeric: tabular-nums` to counts, times, run ids and tables.
- **Spacing:** a 4 px base, using 4, 8, 12, 16, 24, 32 and 48. Put more space above a heading than below it.
- **Radius:** 6 (chips), 8 (controls), 12 (cards).
- **Surfaces.**
  - Light: `--bg #f6f6f4`, `--surface #ffffff`, `--surface-2 #efefec`, `--border #e4e4e0`, `--border-strong #c9c9c4`, `--text #111111`, `--muted #5f5f5b`. Use a slightly warm neutral, so the page reads as paper rather than a UI kit.
  - Dark: `--bg #0e0e0d`, `--surface #181817`, `--surface-2 #222220`, `--border #31312e`, `--border-strong #484844`, `--text #f2f2ef`, `--muted #a6a6a0`.
- **State hues.** Each has a foreground for text and dots and a tint for backgrounds, made with `color-mix(in srgb, <fg> 12%, var(--surface))`.

| Hue | Light | Dark |
| --- | --- | --- |
| work | `#1f5f99` | `#7cb6e8` |
| you | `#8a5a00` | `#e2b25c` |
| fail | `#b0372a` | `#ef8f80` |
| done | `#2f6f3a` | `#8cc796` |

  Every foreground must reach 4.5:1 against `--surface` and against its own tint, in both themes, and the builder checks this.
- **Theme the browser's own surfaces too:**
  - `::selection` uses the text colour at 15% opacity;
  - `accent-color: var(--text)` for checkboxes and radios;
  - focus rings stay 2 px in the text colour, offset 2 px;
  - `text-underline-offset: 0.18em` on links.
- **Shadows:** cards get `0 1px 2px rgb(0 0 0 / .05), 0 2px 8px rgb(0 0 0 / .04)` in light and no shadow in dark, where the border carries the edge.

## 3. Components

### 3.1 Status pill

- A dot and a label. The colour comes from the meaning table in §1.
- The dot pulses only for "Agents working", and never under reduced motion.
- A paused pill shows a two-bar pause mark (an inline SVG) instead of the dot.
- One shape is used everywhere.

### 3.2 Task card (board and list)

**Order of content, top to bottom:**

1. **The id and title.** The id is mono and muted, and the title has weight 600 and up to two lines.
2. **The state.** The status pill, plus a "Needs you: <what>" badge (amber tint) when something waits for the user, for example "Needs you: merge PR", "Needs you: choose an option" or "Needs you: decide a finding".
3. **The work line,** when an agent is working: the provider mark and name, the step purpose, and "step 3 of 6". The provider mark is a small authored SVG monogram, "C" for Claude and "X" for Codex, in a 14 px rounded square, in the text colour, never a brand logo. Under it goes a step bar: one 4 px segment per pipeline step, coloured done, work or neutral, from the task's real step states. This is content, not decoration.
4. **The footer:** the area chip, then the last activity on one line, truncated, with the full text in `title`.

**What moves off the card** to the task page only:

- the spec revision;
- the approach chip;
- the role chip;
- "runs at P1".

**What stays:** "part of T-…" for child tasks, as a small link, and the experiment chip for experimental patterns.

### 3.3 Progress by area (new, top of the Overview)

- **The heading is "Progress by area".** It has no eyebrow or kicker.
- **One row per area** (from `spec.content.area`; tasks with no area are grouped as "Other"):
  - **Left:** the area name (600), then "4 of 6 done" in tabular numerals.
  - **Middle:** a single bar 8 px tall, with segments in task order: done (done hue), agents working (work hue), needs you (you hue), and the rest (neutral, `--surface-2` with a 1 px border). Each segment's width is proportional to its number of tasks. The bar has `role="img"` and an `aria-label` that states the counts in words.
  - **Right:** the live line. For example "Codex · implementing *Show a clear offline state*", or "Claude · reviewing *VoiceOver labels*", or "Idle". After it, "1 needs you" (you hue), if any.
- **Each row is a button.** It opens the board filtered to that area: `#/tasks?area=<name>`, and the board reads that parameter.
- **Rows are ordered:** areas with work or "needs you" first, then by the most recent activity.
- **Data:** derived only from state. It is a pure function `progressByArea(state)` in `src/ui/progress.ts`, with tests.
- **At 375 px,** each row stacks: name and count, then the bar, then the live line.

### 3.4 Needs you (Overview, under Progress by area)

- A compact list of everything waiting for the user, each item with one action button that opens the right place: pull requests held for you, spec decisions, ask-user findings, review gates, and tasks waiting on a failed check.
- It reuses existing derivations; do not add state.
- When it is empty, say "Nothing needs you. Agents keep working within your settings."

### 3.5 Overview layout

- **Desktop:** Progress by area takes the full width; then two columns, with Needs you and the Vision on the left and the Lead on the right.
- **What moves lower:** the sample-project explanation card becomes one line in the demo bar, plus the tour.
- **What hides by default:** the long "involvement" sentence becomes a `<details>`.

### 3.6 The demo bar (simulated banner)

- **One line:** **Demo** · "Every run is simulated: no agents run and nothing leaves this computer."
- **The controls** (pause clock, step, acknowledgment mode, reset) move into a "Simulation" `<details>` popover at the right of the bar. They keep their labels and behaviour.
- **On phones** the bar wraps to two lines at most.
- It stays black (`--sim-bg`) on every page.

### 3.7 Header

- Brand and project name; the tabs; and on the right:
  - the live indicator, "3 agents working" with a pulsing work dot, or "Idle";
  - the Lead button;
  - the stage chip;
  - Tour (demo only);
  - Pause project.
- At 375 px, the tabs scroll horizontally inside their own row. The page never does.

### 3.8 Long explanations

These paragraphs keep their first sentence, and the rest goes into `<details><summary>How this works</summary>…</details>`. Only the existing wording is moved; nothing is rewritten.

- the Pipeline card;
- Settings → Checks, → Patterns and → Delivery;
- Vision documents;
- the involvement settings.

### 3.9 Pipeline on phones

- Below 700 px, the steps table becomes a list. Each step is one block:
  - the id and purpose;
  - the role and state pill;
  - the provider and model control at full width;
  - the context disclosure.
- Desktop keeps the table.

### 3.10 Checks settings radios

Each sandbox choice is a grid of a radio and a block. The radio sits on the first line of the label, and the description is under the label, indented to the label's text.

### 3.11 Built-in pattern purposes

- **The rule:** a step's `purpose` is a short description for people, at most about 60 characters. Instructions to agents leave the purpose.
- **Where the instructions go:**
  - into the role brief that the envelope already sends for that role;
  - or, if the instruction is specific to verifying with checks, into the envelope section that already describes service check results.
- **The known case:** Change S4, "Verify and integrate. Service check results are the record of what ran; do not say tests passed unless a check result shows it.", becomes "Verify and integrate".
- **The others:** the builder greps all of `patterns/*.json` for sentences that address the agent.
- **A test** shows the moved sentence still reaches the lead's verify envelope.
- **Changing the content of a pattern file changes its hash.** That is expected. Existing tasks keep their copied steps, as ORC-016 specifies.

### 3.12 Motion

- 150–200 ms ease-out on hover and state changes.
- The work dot pulses.
- Bar segments animate their width when counts change (200 ms).
- Nothing else moves.
- Everything is off under `prefers-reduced-motion`.

## 4. First-run tour (driver.js, pinned, MIT)

**When it runs:**

- It runs on the Overview, demo only, on the first visit.
- It is stored under the `localStorage` key `orc.tour.v1` = `"done"`, read and written inside try/catch. When storage throws, the tour runs once per page load at most, and never loops.
- The header's Tour button replays it.
- Skip, Esc and Done all mark it done.

**The stops** (anchors are `data-tour` attributes, not CSS classes):

1. `demo-bar`: "This is a demo. Every run is simulated: no agents run, and nothing touches your code or GitHub."
2. `progress`: "Progress by area. Each part of the product, how far along it is, and which agent is on it right now."
3. `needs-you`: "Only what needs you: a pull request to merge, an option to choose, a finding to decide."
4. `tab-tasks`: "Every task has a spec, a pipeline and a truthful state. Claude and Codex work on different tasks at the same time."
5. `lead`: "Talk to the lead from any page. It can change the focus or defer work, and every change has an Undo."
6. `tab-review`: "Work that has landed waits here for your review, at your own pace. Send it back if it is wrong."
7. **Final,** with no anchor and a centred popover: "Open any task to see its pipeline: provider and model per step, Pause and Resume. Replay this tour from Tour." The button reads "Start exploring".

**Behaviour:**

- The popover is styled from the tokens: surface, border, a 12 px radius, the text colour, a black primary button and a progress count ("2 of 7").
- The overlay is 45% black.
- It is keyboard operable: arrows, Enter and Esc.
- Focus returns to the Tour button when it ends.
- Real mode never starts it, and the button is hidden there.

## 5. The sample story: "Weekend Trips (sample)"

**The project.**

- **What it is:** a small app for planning weekend hikes with friends.
- **Repository path:** `~/code/weekend-trips`.
- **Stage:** building.
- **Delivery:** GitHub pull requests, held for you. They are simulated, as the current demo labels them.
- **Checks:** on, with two simulated commands, `npm test` and `npm run lint`.
- **Model ids:** the current sample model ids are kept, because they are honest. The catalog shows labels "Claude large (sample model)" and "Codex large (sample model)".

**The vision.** Revision 1 was a draft the lead wrote while shaping, accepted by the user, so the history says so. Revision 2 is the steering focus change.

> Weekend Trips helps a small group of friends plan a weekend hike together: pick a trail, share the plan, pack the right things, and keep the map working with no signal. It should feel calm and dependable on a phone at a trailhead. Fewer, clearer screens beat more features.

- **The focus in r1:** "Trip sharing first."
- **The focus in r2,** set by the lead from the user's message, simulated: "Offline maps first: the map must work with no signal."
- **Coverage:** all nine areas are clear.
- **Vision documents:** one, `trail-research.md`, listed as text (2.1 KB). Its content is a short, plausible field note written for the demo.

**The conversation,** oldest first. Each lead message carries the simulated label.

1. **User:** "Most of our hikes have no signal at the trailhead. Can we put offline maps ahead of sharing?"
2. **Lead:** "Done. Offline maps is now the focus. I deferred *Weather alerts for the trip day*, since it needs a connection anyway. Everything else keeps its order." It carries the steering change list (the focus and one deferral), with Undo available.
3. **User:** "Thanks. Keep the VoiceOver work going, though."
4. **Lead:** "It is still running: Claude is reviewing *Make the trail map readable with VoiceOver*. One finding needs your decision: whether distances are read in miles or kilometres."

**Tasks.** The ids are `WT-001`… The pattern is from the built-in catalog, and every one was chosen by the lead except the experiment.

| Id | Title | Area | Pattern | State at start of demo | Notable artifacts and text |
| --- | --- | --- | --- | --- | --- |
| WT-001 | Cache trail map tiles for offline use | Offline maps | change | Done; merged; in Review (not yet reviewed) | Change (Codex): "Tile cache with a 200 MB cap and least-recently-used eviction (+214 −18, 6 files)". C1 checks: `npm test` failed: "tile-cache evicts oldest first (expected 3, got 4)" → finding "error, auto-fix" → S3 repair (Codex) → C2 passed. Review (Claude): approved, 1 low finding fixed. |
| WT-002 | Show a clear offline state on the map | Offline maps | change | Running: S1 implement on Codex, about 40% | Spec benefit: "You always know whether the map is current." |
| WT-003 | Download a trail area before you leave | Offline maps | feature (designer, then coder) | Ready, next in queue | Spec has two options; lead recommends "Download by trail" over "Download by map rectangle". |
| WT-004 | Share a trip plan with friends | Trip sharing | goal | Active: waiting on children | Breakdown: 3 child tasks. |
| WT-004.1 | Invite friends with a link | Trip sharing | change | Done; merged; reviewed | Change (Claude): "Signed invite links that expire after 7 days (+132 −4)". |
| WT-004.2 | See who is coming | Trip sharing | change | Running: S1 implement on Claude, about 70% | |
| WT-004.3 | Join a trip without an account | Trip sharing | change | Proposed; **needs you**: spec decision between "Guest link" (recommended) and "One-time code"; the lead asks because it changes what data is kept | |
| WT-005 | Suggest a packing list from trail length and weather | Packing lists | change | Done; **pull request held for you**; independent review approved; checks passed | PR title the same; head commit shown short; checklist all green except "You merge it". |
| WT-006 | Check items off together | Packing lists | change | Ready | |
| WT-007 | Make the trail map readable with VoiceOver | Accessibility | change | Reviewing: S2 code review on Claude, about 50%; earlier finding **needs you** (ask-user): "Read distances in miles or kilometres? Recommendation: follow the phone's region setting." | |
| WT-008 | Larger tap targets on the trip page | Accessibility | change | Done; merged; reviewed | |
| WT-009 | Never lose a trip plan if the app closes mid-edit | Reliability | bugfix | **Paused** by the user, acknowledged by the runtime (2 h ago), during S2 | Pause reason: "Holding until offline maps lands." |
| WT-010 | Weather alerts for the trip day | Reliability | change | Deferred by steering, with Undo | |
| WT-011 | Faster trail search | Reliability | change-best-of-two (experiment) | Done; merged; in Review | S1 Claude and S1-c2 Codex; S2 chose S1: "Both pass; S1 is simpler (one index instead of two) and 30 ms faster on the 5,000-trail fixture (simulated)." |

**What the board shows.** At the start of the demo, three agents are working, the project's worker limit:

- Codex on WT-002;
- Claude on WT-004.2;
- Claude reviewing WT-007.

As the simulation clock runs, the following happens:

- WT-002 moves to checks, review and done, and a pull request is held.
- WT-004.2 finishes.
- WT-003 starts once a slot frees, with its designer step on Claude (the role default).

These steps come from the existing fake runtime and scheduler, not from scripted timers.

**How the fake runtime words its output.**

- **Where the text comes from.** Each output summary comes from a per-task script keyed by task id and output name, in `src/domain/demo.ts` or a sibling file. The fallback is neutral wording such as "Implemented the change (simulated)", never "Simulated part A (run-1028)".
- **Breakdown children** created at run time take their titles from the goal's script, for example "Share the plan offline", and fall back to "Part 1 of <goal title>".
- **Run numbers** never appear in titles.

**Labelling.**

- **The bar** on every page.
- **Chips:**
  - each lead message carries a "simulated" chip (present already);
  - a vision revision written by the simulated lead carries a "simulated" chip. The chip is recorded as a structured flag, `simulated: true`, on the revision or the steering record, not as text in the focus. (If a structured flag needs a state change, record it in the spec and migrate. The preferred route is the existing lead-run record, which already knows it was simulated.)
  - each run row shows the runtime as "simulated".
- **The prefix** "(Simulated)" leaves the focus text, the steering reason and the artifact summaries, because the chips and the bar label them.
- **A test** asserts that the demo's lead-authored focus renders with the simulated chip.

## 6. Capture and README media (B3)

- **Running it:** `node scripts/capture-demo.mjs [--out docs]`.
  - It creates a temporary HOME and data directory, and starts the service in the demo runtime on a free loopback port.
  - It waits for health, then drives the installed Chrome through playwright-core (`channel: "chrome"`). It never downloads browsers.
  - It sets the viewport to 1440×900 at deviceScaleFactor 2, and the theme to light. Dark-mode shots are taken where the README shows them.
- **Screenshots.**
  - It regenerates every image the README references; the list is read from README.md's image links.
  - Each one is downscaled to 1600 px wide with `sips` on macOS or ffmpeg elsewhere.
  - The tour is skipped by presetting `localStorage` `orc.tour.v1`, except in the tour frames.
- **Hero image, `docs/media/hero.png`.**
  - It renders `scripts/media/hero.html`: a 2400×1350 canvas on `--bg`.
  - On it: the product name "Orchestrator"; one sentence, "One lead. Claude and Codex workers. Every step visible, pausable and yours to steer."; and the Overview screenshot in a simple window frame (a 12 px radius, a hairline border and a soft shadow). It must not look like a fake browser chrome with traffic lights.
- **Animated tour, `docs/media/tour.gif`.** About 20 s at 12 fps, 1200 px wide, under 5 MB, or `tour.webp` if the GIF is over budget. It is made from Playwright's video recording, then ffmpeg palettegen and paletteuse. The sequence:
  1. Overview with progress by area (with the bar animating as the clock runs);
  2. open the Lead and send "Focus on offline maps", showing the change list;
  3. the board;
  4. open WT-002 and its pipeline with the provider and model per step;
  5. Pause, and the acknowledged "Paused";
  6. Resume;
  7. Review.
- **The README:**
  - The hero goes directly under the title.
  - The animated tour goes after the "What you get" table, with a one-line caption saying it is the demo with simulated runs.
  - The screenshots section keeps its order, with retaken images.
  - The text never claims real-run results.
- **Failure handling.** The script exits non-zero with a plain message when Chrome or ffmpeg is missing. It stops the service and removes the temporary directory on every exit path.

## 7. Builder split (disjoint files)

- **B1, the story.**
  - `src/domain/demo.ts` (new), and `src/domain/demoScript.ts` if useful.
  - `server/runtimes/fake.ts` (its text only), and `server/app.ts` (the demo seed for the fake runtime and Reset sample data).
  - The structured simulated flag, if needed: `src/domain/types.ts`, `commands.ts` and `model.ts`, with a migration.
  - Tests.
  - Not `src/ui/**`.
- **B2, the UI.**
  - `src/ui/**`, including `progress.ts`, `Tour.tsx` and `styles.css`.
  - `patterns/*.json` purposes, together with the role brief and envelope sections in `server/envelope.ts`.
  - `package.json` and the lockfile, for driver.js.
  - Tests.
  - B2 renders the simulated chip from whatever structured flag B1 exposes. The interface is agreed below.
- **B3, media:** `scripts/capture-demo.mjs`, `scripts/media/hero.html`, `docs/media/*`, `docs/screenshots/*`, README.md, and `package.json` for playwright-core (a dev dependency).

**The agreed interface between B1 and B2:**

- `VisionRevision.simulated?: true` and `SteeringChangeSet.simulated?: true`, set by the store when the lead run that produced them ran on the fake runtime.
- B1 owns setting them; B2 shows a "simulated" chip wherever a revision's provenance or a change set is shown.
- If B1 finds an existing flag that already carries this, B1 records the name in its report and B2 uses it.

## 8. Open decisions (builders do not invent these)

- **The GIF size.** If 20 s at 1200 px is over 5 MB, drop to 10 fps, then 1000 px, then WebP. Record what was used.
- **Whether to commit `PRODUCT.md`.** Yes: it is product truth for later design work.
- **Any further agent instructions found in pattern purposes.** Each is moved, never deleted, and listed in the B2 report.
