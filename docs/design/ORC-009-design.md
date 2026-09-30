# ORC-009 technical design

# ORC-009 technical design (spec r1)

The grounding for this design comes from a read-only trace of the code. All line numbers refer to the current tree, which is at state format 9.

## 0. Decisions at a glance

| Topic | Decision |
| --- | --- |
| Model-facing surface | One optional `steer` object in the lead's final JSON block: `focus`, `reason`, and `tasks[]`. Each entry carries exactly one of `priority`, `defer` or `drop`, plus `why`. |
| Who may steer | Only a lead run with `run.messageIds.length > 0` (it answers user messages). The run's trigger is never used for this, because of the observer-instance race. Planning runs get `refused: "planning runs cannot steer"`. |
| Authority | The service writes the change list. It checks every item against `steerPermission()` using the state at apply time, inside the same lease-checked transaction as `completeLeadRun`. The lead's prose is never the record. |
| Stopping work that no longer fits | `Task.deferral`, a dispatch-only flag. It is checked after the finishTask branch in `dispatchEligible` and ignored by `reportCompletion` and `settleStoppedStep`. The lead never sets `hold`, `holdBeforeStart`, `requestStop` or `resumeTask`. |
| Cancelling | A **drop** is limited to the lead's own unstarted root proposals with no open dependents. It records `dropped`, and `reopen` is the only relaxation of `assertOpen`. |
| Children | They cannot be targeted. Deferral and priority tier are derived from the root (`deferredBy`, `dispatchRank`), and nothing is written to children. |
| Preconditions | Recorded by the server: `LeadRun.visionRev`, the pins in `Task.userSet`, and the current state. The model supplies no `from` values. |
| Newer direction | When a run completes, if the user has posted another message or the vision revision has moved, every applicable item becomes a suggestion (`heldBecause`). A focus change is rejected if the vision moved. |
| Responsiveness | `postMessage` stops a running planning run. A reply run is not stopped automatically; the `stopLeadReply` command ("Answer together now") does that. `messageStatus()` derives the queue state. |
| Mode | `Project.steeringMode`: `apply` (the default), `apply-own` or `suggest`. It is changed only by its own `setSteeringMode` command, and never through Autonomy. |
| Undo | `undoSteering`, `applySteering` and `dismissSteering` go through `store.command` with idempotency keys. Each is compare-and-set, and anything it leaves alone is reported. Undo and applied suggestions set pins. |
| Idempotency of lead changes | Two guards: the run-outcome guard (only a `running` run applies) and the change-set ID `cs-${runId}`. |
| ORC-008 | Steering never touches done tasks, `integration`, `project.delivery` or `autonomy.autoDeliver`. The new names are `deferral`, `steering`, `steeringMode`, `userSet` and `dropped`, and none of them is a generic "hold". |

## 1. Lead contract

### 1.1 Output (message runs only)

```json
{
  "reply": "…",
  "proposals": [ … ],
  "steer": {
    "focus": "Get every app building and running locally end to end; deployment automation waits.",
    "reason": "You asked to focus on local builds over automating deployment.",
    "tasks": [
      { "id": "T-012", "priority": 1, "why": "one-command local dev serves the focus" },
      { "id": "T-019", "defer": true, "why": "deployment automation" },
      { "id": "T-021", "drop": true, "why": "my deploy-preview proposal no longer fits" },
      { "id": "T-008", "defer": false, "why": "local test harness fits again" }
    ]
  }
}
```

- The lead leaves `steer` out, or sets it to `null`, when the user only asked a question.
- New proposals carry their own `priority`. They are created after the focus and task changes, so they follow the new focus. No cross-reference such as `new:i` is needed.

### 1.2 Envelope (`server/envelope.ts`, `buildLeadEnvelope`)

**Header.** For message runs the header adds `Steering mode: apply | apply-own | suggest`.

**Vision.** It shows:
- `r7 by lead (from the user's message msg-12 at 12:03): <reason>`
- a focus history of the last 5 revisions: rev, author, source (message, undo, or hand edit), reason, and focus clipped to 200 characters

**Open work.** This replaces the 60-row cut that included done tasks.
- It lists open **root** tasks sorted by priority, then ID, up to 80 rows. If more exist, it ends with "N more open tasks not shown (lowest priority)".
- Each line has this form: `- T-019 [Running · deferred after this step] P3 (set by you) "Automate deploy" area:Deploy · by user · 2 child tasks · notes: depends on T-004 | held before start · may: priority, undefer · suggest: drop · not: defer (already deferred)`
- The `may` / `suggest` / `not` lists come from `steerPermission()` (§3). That is the same function that enforces them at apply time.

**Recently finished.** The last 10 done or cancelled roots, each marked "(finished; not steerable)". Dropped tasks read "dropped by the lead on <date>; the user can restore it; do not re-propose".

**Deferred lead work.** A line reading `Deferred lead proposals: N of at most M — drop those that no longer fit so planning can continue.`

**Recent steering.** The last 5 change sets, one line per row, each with its status:
- applied
- undone by the user
- left as is on undo
- suggested
- dismissed
- held (the user wrote again)
- superseded

Held suggestions come with: "Re-issue the ones that still fit the newest message."

**Messages to answer now.** Each message is prefixed with `(sent from T-012 "Title" [state])` when it has a `taskId`.

**Steering rules** (message runs only):
- Steer only when the user's messages ask for a change of direction, and change only what they imply.
- `focus` replaces the current-focus line. You cannot change the vision text.
- Steer root tasks only; child tasks follow their root.
- `priority` is 1–99, and lower starts sooner. It changes only which queued work takes the next free worker slot. Running work continues.
- `defer: true` lets the current step finish, and then nothing new starts on that task.
- Prefer `defer` to `drop`. `drop` works only on your own unstarted proposals.
- Only actions listed under `may` take effect. Everything else becomes a suggestion or is not applied.
- Never try to resume, pause or release work. Settings, delivery and integration are out of reach.
- Do not redo a change listed as undone or dismissed unless a newer message asks for it.
- Do not claim changes in `reply`. The service lists what was applied and what was only suggested, with Undo.
- For a direction change you need not read the repository. The board is enough.

**Planning runs** get one line instead of the steering rules: "Planning runs cannot steer. Serve the current focus; do not re-propose deferred or recently dropped work." The JSON contract shows `steer` only for message runs.

### 1.3 Parser and scheduler

- `parseLeadOutput` returns `{ reply, proposals, steer?: unknown, problem? }`.
  - `steer` is passed through as found (`obj.steer`). A missing value or `null` becomes `undefined`.
  - Type checks happen in the domain.
- `LeadOutput` in model.ts gains `steer?: unknown; problem?: string`.
- The scheduler (scheduler.ts:597-600) passes `steer` and `problem` on.
- `problem` is written to `run.note`, and the lead message's `rejected` list gets: "The reply had no machine-readable block, so nothing was changed." Today this is silently dropped.

## 2. Validation (`validateSteer`, pure, model.ts)

Lead output is untrusted data. Each item is checked on its own, inside a try/catch, following the H2 pattern.

### 2.1 Whole-block refusals

Each of these records a set with `refused` and no rows, and changes nothing:
- `r.messageIds.length === 0`: "planning runs cannot steer"
- `r.visionRev === undefined`: "started before steering existed"
- the block is not a plain object (it is an array, string or number): "the steering block was not an object"

### 2.2 Block fields

**`focus`** (optional).
- It must be a string that, trimmed, is 1–500 characters.
- It may contain no control characters other than `\n` and `\t`.
- Otherwise the result is a `rejected` focus row with a reason.
- A focus equal to the current one is a no-op and is not recorded.

**`reason`** (optional).
- A string of 500 characters or fewer, trimmed.
- If it is invalid or missing, the set uses "From your message" and records a set note.

**`tasks`** (optional).
- If it is not an array, the set note reads "tasks ignored: not a list".

### 2.3 Each task entry

It must be an object with:
- `id`: a string matching `/^[A-Za-z0-9._-]{1,40}$/`
- exactly one action:
  - `priority`: a `number` that is an integer from 1 to 99. The values `2.5`, `"1"`, `0` and `100` are rejected.
  - `defer`: a `boolean`
  - `drop`: `true`
- `why` (optional): a string of 300 characters or fewer. A longer one is rejected.

Violations become `rejected` rows with a specific reason, such as "priority must be a whole number 1–99" or "give exactly one of priority, defer, drop".

**Caps:**
- At most **20** task entries. The rest are rejected with "more than 20 changes in one reply".
- **One entry per task ID.** The first wins; later ones are rejected with "one change per task per reply".

## 3. Permission function (the single source for the envelope and for validation)

```ts
export type SteerAction = "priority" | "defer" | "undefer" | "drop";
export type SteerVerdict =
  | { v: "apply" }
  | { v: "suggest"; why: string }
  | { v: "skip"; why: string }     // valid, but a rule keeps the current value
  | { v: "reject"; why: string }   // not steerable
  | { v: "noop" };                 // nothing would change: not recorded
export function steerPermission(s: State, t: Task | undefined, action: SteerAction, mode: SteeringMode, value?: number): SteerVerdict;
```

### 3.1 Evaluation order

1. **Reject** when:
   - the task is unknown
   - the task is done or cancelled ("T-3 is done")
   - it is a child task (`parentTaskId` is set): "child of T-4: steer T-4"
2. **Noop** when:
   - `priority` equals the current value
   - `defer` is sent to a task that already has its own deferral
   - `undefer` is sent to a task without its own deferral
3. **Skip.** The item is valid but the current value is kept:
   - **defer** on `t.hold`: "paused by you" or "paused for review", so only the user decides when it runs
   - **defer** on `t.controlFailure`: "needs your attention (control failure)"
   - **defer or drop** under the dependency guard (§3.3): "kept: T-12 depends on it"
4. **Suggest.** The item is valid, but a user choice or the mode applies:
   - see the matrix in §3.2
   - in `suggest` mode, every `apply` becomes `suggest` with the note "only suggest (Settings)"
5. **Apply** otherwise.

### 3.2 Matrix in mode `apply`

| Target (root, open) | priority | defer | undefer | drop |
| --- | --- | --- | --- | --- |
| The lead's own task (`specs[0].author === "lead"`), unstarted, not touched by the user | apply | apply | apply (the lead's deferral) | **apply** |
| The lead's own task, started or running | apply (next free slot only) | apply: the current step finishes and its result is accepted | apply | suggest: "it has started; cancelling stops its work" |
| The lead's own task, touched by the user (`userTouched`) | per the pin rows below | per the pin rows below | apply | suggest: "you changed this task" |
| A user-created task, including follow-ups and imports | apply unless the priority is pinned | apply unless `userSet.run` is set | apply only if `deferral.by === "lead"` | suggest: "your task: only you cancel it" |
| `userSet.priority` set | suggest: "you set P2" | — | — | — |
| `userSet.run` set | — | suggest: "you asked it to keep running" | — | — |
| `deferral.by === "user"` | — | — | suggest: "you deferred it" | — |
| Held before start | apply; **the hold is never released** (note: "still waits for your release") | apply | apply | per the other rows |

**Mode `apply-own`.** On a user-created root, priority, defer and drop become `suggest` with the note "your task: suggest-only (Settings)". Undoing the lead's own deferral stays `apply`.

**Focus** (not task-scoped):
- `apply` in both `apply` and `apply-own`.
- `suggest` in `suggest` mode or when the run is held.
- `reject` when the vision revision has moved since the run started (§5).

**What "started" means:** lifecycle `active`, or any attempt exists, or any descendant exists. This is the same predicate as the `createChildren` precedent at model.ts:2366.

**What "userTouched" means** (used for drops): any of the following is true.
- `userSet.priority` or `userSet.run` is set
- the task has a user hold (`t.hold && !holdReason && !pausedWith`)
- any spec revision or pipeline revision was authored by the user
- any `step.selection` is not null
- `roleOverrides` is not empty

### 3.3 Dependency guard

Let `tree = {t} ∪ descendants(t)`. The guard triggers if any **open** task outside `tree`, and with no `deferredBy`, lists a member of `tree` in `dependsOn`.

A direct check is enough. Any intermediate prerequisite in a chain is itself an open dependent that has not been deferred, so the guard finds it. A dependent that is already deferred is already waiting, so it does not trigger the guard.

The effect: a drop never turns a user's dependent task Blocked, and a deferral never leaves focus work waiting silently.

**Order independence.** The lead may defer or drop both a prerequisite and its dependent in the same reply, in either order. Defer and drop items skipped only by the dependency guard are re-checked after the other items, repeating until no more apply. This takes at most 20 passes, one per item.

## 4. State (format 10, `src/domain/types.ts`)

```ts
export type SteeringMode = "apply" | "apply-own" | "suggest";

export interface Deferral {
  by: "lead" | "user";
  at: string;
  reason: string;
  /** The change set that deferred it (lead deferrals and applied suggestions). */
  changeSetId?: string;
}

// Task
/** Explicit user choices the lead must not override (ISO time the user made them). */
userSet?: { priority?: string; run?: string };
/** Dispatch-only: no new step starts on this task or its descendants. Never a hold. */
deferral?: Deferral;
/** The lead dropped (cancelled) its own unstarted proposal: what reopen restores. */
dropped?: { changeSetId: string; lifecycle: "proposed" | "ready"; at: string };

// VisionRevision
source?: { changeSetId: string; leadRunId: string; messageIds: string[] } | { undoOf: string };

// Message
changeSetId?: string;   // lead messages that carried steering
taskId?: string;        // user messages sent from a task page

// LeadRun
visionRev?: number;     // set in startLeadRun; absent on runs started before format 10 (cannot steer)
changeSetId?: string;

// Project
steeringMode: SteeringMode;   // default "apply"

// State
version: 10;
steering: SteeringChangeSet[];  // the last 200 sets; events keep the full record

export type SteeringValue = string | number | Deferral | null;
export interface SteeringChange {
  id: string;                       // `${setId}.${n}`
  kind: "focus" | "priority" | "defer" | "undefer" | "drop";
  taskId?: string;
  before: SteeringValue;            // focus text | priority | deferral | lifecycle
  after: SteeringValue;
  why: string;                      // the lead's reason (plain text, ≤300)
  status: "applied" | "suggested" | "skipped" | "rejected" | "undone" | "dismissed" | "superseded";
  note?: string;                    // service reason: why suggested/skipped/rejected; "left as is on undo: …"
  appliedBy?: "lead" | "user";
  visionRev?: number;               // focus: the revision created (applied) or based on (suggested)
  resolvedAt?: string;              // undo / apply / dismiss / supersede time
}
export interface SteeringChangeSet {
  id: string;                       // `cs-${leadRunId}`
  leadRunId: string;
  messageIds: string[];
  at: string;
  mode: SteeringMode;               // in force at completion
  basedOnVisionRev: number;
  reason: string;
  refused?: string;                 // whole block refused (planning run, old run, not an object)
  heldBecause?: string;             // newer direction: applicable items became suggestions
  notes: string[];                  // set-level notes (reason ignored, tasks not a list…)
  changes: SteeringChange[];
}
```

`seed.ts` sets `version: 10`, `steering: []` and `steeringMode: "apply"`.

## 5. Applying a completed lead run (`completeLeadRun`)

Everything below runs inside the scheduler's existing `store.update`: BEGIN IMMEDIATE, the lease checked inside, and an optimistic version check. The steps run in this order.

**1. Existing guards, unchanged.**
- If the run is not `running` or `stopping`, the call is a no-op.
- If it is `stopping`, it becomes `stopped` and nothing is applied. `run.note` records that its proposals and steering were not applied, and stores the clipped reply.

**2. Complete the run.**
- Mark the run `completed`. Store `usage` and `actualModel`.
- If `problem` is set, store it in `run.note` and add the rejected line described in §1.3.

**3. Steering**, only if `out.steer !== undefined`.
- **Idempotency guard.** If `s.steering` already has a set `cs-${r.id}`, skip. This is a second guard behind the run-outcome guard.
- **Validate.** Run `validateSteer` (§2). A refusal records the set and moves on to step 4.
- **Check for newer direction.**
  - `newer = pendingMessages(s).length > 0`. The run is now `completed`, so its own messages count as covered; anything left pending was posted during the run.
  - `visionMoved = currentVision(s).rev !== r.visionRev`.
  - If either is true, set `heldBecause`:
    - "You sent another message while the lead was working; its next reply decides."
    - or "You edited the vision while the lead was working."
- **Choose the mode.** `mode = heldBecause ? "suggest" : s.project.steeringMode`. The set records the project mode, and `heldBecause` explains the downgrade.
- **Focus first.**
  - If `visionMoved`: the row is `rejected`, "you edited the vision (now rN); your edit stands".
  - Otherwise, in suggest mode: the row is `suggested`, with `visionRev = r.visionRev`.
  - Otherwise, apply it through `pushVision(s, { author: "lead", text: current.text, focus, reason, source: { changeSetId, leadRunId, messageIds } })`. This is the internal function that `editVision` now also uses with `author: "user"`. The row gets `visionRev` = the new revision. The event is actor `lead`, kind `vision`: `Focus r7 by lead from your message msg-12 (cs-lead-40): <reason>`.
- **Task items, in array order.** Each item is checked with `steerPermission` against the **current** state, including the items already applied in this run. Each item then does one of the following:
  - It applies, through actor-parameterised internals that the user commands also call:
    - `writePriority(s, t, p, "lead")`
    - `deferInto(s, t, { by: "lead", reason: why, changeSetId })`
    - `clearDeferral(s, t, "lead")`
    - `dropInto(s, t, changeSetId)`
  - It becomes `suggested`, `skipped` or `rejected`, with its note.

  Then run the dependency-guard retry pass (§3.3). Each applied row logs one event with actor `lead`, for example: `Priority P5 → P1 by lead (cs-lead-40.2, from msg-12): <why>`, or `Deferred by lead (cs-lead-40.3): <why>; the current step finishes first`.

**4. Proposals.**
- Proposals are created as today. `openRoom` is computed now, after deferrals and drops, and it excludes deferred work (§6.5).
- `validateProposal` also rejects:
  - titles of open or deferred tasks (as today)
  - titles of tasks dropped through steering in the last 7 days that are still cancelled: "dropped when the focus changed on <date>; the user can restore it"

**5. Supersede.**
- If this is a message run and it completed (the set is not refused), older `suggested` rows become `superseded`, with `resolvedAt` set, when either:
  - (a) they belong to a set with `heldBecause`, or
  - (b) this set has a row with the same target, meaning the same `taskId`, or both are focus rows.
- Any other pending suggestions stay available.

**6. Record.**
- Push the set and trim `s.steering` to the last 200.
- Set `r.changeSetId`.
- Push the lead message with `changeSetId`, `proposedTaskIds` and `rejected`. If `reply` is empty and the set has rows, the text is "I made the changes listed below." or "I suggest the changes listed below.".
- Log one summary event: `Lead run lead-40 steered from msg-12: focus changed, 2 reprioritized, 2 deferred, 1 dropped; 1 suggestion, 1 kept (cs-lead-40)`.

**Races.** User commands and this transaction are serialized by BEGIN IMMEDIATE.
- A user command committed first is seen by the re-check at apply time. A pin turns the item into a suggestion, a pause turns a defer into a skip, and a vision edit rejects the focus and holds the set.
- A user command committed afterwards sees the lead's values, and Undo is compare-and-set.

## 6. Deferral

### 6.1 `deferredBy(s, t)`

It returns `{ task, deferral }` for the nearest task among `t` and its ancestors (walking at most 10 levels, like `rootOf`) that has a `deferral`, or `undefined` if there is none.

Children are never written, so an Undo touches one field. A root and all its children defer together, so `waitForChildren` cannot stall on a single deferred child.

### 6.2 Dispatch (`dispatchEligible`, model.ts:685-)

The check goes **after** the finish branch, never into the skip list at line 693:

```ts
if (t.lifecycle === "active" && t.steps.every(isSettled) && activeAttempts(s, t.id).length === 0) {
  finishTask(t); … continue;
}
// ORC-009: deferral is checked only here, after the finish branch, so a deferred task whose work is
// complete (including steps settled by skipping) still becomes Done and is queued for integration.
if (deferredBy(s, t)) continue;
```

- `reportCompletion` (model.ts:924-936) and `settleStoppedStep` are **unchanged**. A deferral is not a hold, so the running step's result is accepted. `reportCompletion`'s own finish path (about model.ts:997) does not check a deferral either.
- `leadPromoteProposals` skips deferred proposed tasks, so they stay proposed until the deferral is lifted.

### 6.3 Presentation (`column`, `stateLabel`, `waitingOn`)

**Columns.**
- `Column` gains `"deferred"`.
- `BOARD_COLUMNS` becomes: proposed, ready, running, reviewing, paused, **deferred**, blocked, done.
- In `column()`, `if (deferredBy(s, t)) return "deferred";` comes after `if (t.hold) return "paused";` and before the proposed and ready checks.
- Running and reviewing tasks are returned earlier, so they stay in Running or Reviewing.

**Labels.**
- A running or reviewing task that is deferred: `Running · deferred after this step` or `Reviewing · deferred after this step`.
- An idle deferred task: `Deferred by lead`, `Deferred by you`, or `Deferred with T-4` when the deferral comes from an ancestor.
- The controlFailure and stopping labels still take precedence.
- A task with both `hold` and a deferral shows `Paused`: the hold wins.
- `waitingOn`: a prerequisite that is deferred shows as `Waiting on T-x (deferred)`. This only happens with dependents added later, because the dependency guard prevents it at defer time.

### 6.4 What releases a deferral

- `undeferTask`, the user's "Run now". It also sets `userSet.run`.
- The lead's `defer:false`, for lead deferrals only.
- Undo.
- Applying an `undefer` suggestion.

These leave a deferral alone: `resumeTask`, `startHeldTask`, `resumeProject`, `pauseProject`. The deferral banner explains what still applies.

### 6.5 Caps

- `openLeadProposals` becomes the lead-authored open tasks **without** `deferredBy`. It is used by `leadDue` and by `openRoom`.
- The new `deferredLeadRoots(s)` counts lead-authored open roots with their own deferral.
- `leadDue` refuses to plan when either count reaches `maxOpenProposals`. Deferred old-focus work therefore does not block planning for the new focus, and it cannot pile up without limit either. The envelope prompts the lead to drop deferred proposals that no longer fit.
- Settings shows both counts.

## 7. Priority and the derived tier for child tasks

- `setPriority` moves to an internal `writePriority(s, t, p, actor)`. The user command also sets `userSet.priority`.
- The dispatch sort key (model.ts:689) becomes `dispatchRank(s, t) = [tier, t.priority]`:
  - `tier = (t.parentTaskId && !t.userSet?.priority) ? rootOf(s, t).priority : t.priority`
  - A stable sort breaks ties by creation order.
- The cascade from a root to its children is therefore **derived**. Breakdown-item priorities still order work inside a tree, and a child whose priority the user pinned keeps its own tier. Nothing is written to children.
- Only the tasks the lead names change. There is no band renumbering, and untouched tasks keep their relative order.
- Task detail for a child shows "Runs at T-010's priority (P1)".

## 8. Drop and reopen

**`dropInto(s, t, csId)`**
- It is permitted only by `steerPermission`. That requires: the lead's own task, a root, lifecycle `proposed` or `ready`, no attempts, no descendants, no open dependent, and not touched by the user.
- It sets `lifecycle = "cancelled"` and `dropped = { changeSetId, lifecycle: previous, at }`.
- The event actor is `lead`: `Dropped by lead (cs-…): <why>; Undo restores it`.
- There are no runs to stop and no children to cascade to. Dependents cannot exist because of the guard.

**`reopenDropped(s, t)`** (internal). It requires all of:
- `lifecycle === "cancelled"`
- `t.dropped` is set, and its `changeSetId` matches the set being undone
- no attempts
- no non-cancelled task with the same title (case-insensitive)

Otherwise it is left as is with a reason, for example "a task with this title was created since". It restores the previous lifecycle, clears `dropped` and sets `userSet.run`.

`assertOpen` is not relaxed anywhere else. `blockedReason` is derived, so nothing else needs repairing.

## 9. Pins (explicit user choices)

**`userSet.priority` is set by:**
- the user's `setPriority`
- `createTask` with `priorityPinned: true`. The New task form's priority select now defaults to "Auto (the lead may reorder it)", which submits priority 3 unpinned; choosing a number pins it.
- Undo of a lead priority change
- applying a priority suggestion
- `setPriorityPin {pinned: true}`

It is cleared by `setPriorityPin {pinned: false}`, labelled "Let the lead reorder this".

**`userSet.run` is set by:**
- `undeferTask` (Run now)
- Undo of a lead deferral
- Undo of a drop
- applying an `undefer` suggestion
- `setRunPin {pinned: true}`, labelled "Keep running whatever the focus"

It is cleared by `setRunPin {pinned: false}`.

**Not pins:**
- `startHeldTask` and `resumeTask`. These are general go signals from before the new direction. A deferral does not discard work and is undoable, and the user's newest message is itself the direction.
- Imports and follow-ups. Their priority was inherited or came from an older plan document.

## 10. Commands (`src/domain/commands.ts`)

All of these go through `store.command`: one BEGIN IMMEDIATE transaction, an idempotency key, and replay of the recorded outcome.

| Command | Args | Effect and result |
| --- | --- | --- |
| `postMessage` | `{text, taskId?}` | `taskId` must name an existing task. Appends the message. **If the active lead run is `running` with `messageIds.length === 0`, it calls `requestLeadStop(s, r, "your message takes priority over planning", now)`.** |
| `stopLeadReply` | `{}` | "Answer together now." Stops the active `running` run with `messageIds.length > 0`, using `requestLeadRunStop`, which today has no callers. Its messages become pending again, because runs that are stopping or stopped do not cover messages. Otherwise it throws ControlError "Nothing to interrupt". |
| `undoSteering` | `{changeSetId, changeId?}` | Reverts `applied` rows in reverse order, by compare-and-set (below). Returns `{undone: string[], left: {id, why}[]}`. |
| `applySteering` | `{changeSetId, changeId?}` | Applies `suggested` rows **as the user**, by compare-and-set against `before`. Returns `{applied, left}`. |
| `dismissSteering` | `{changeSetId, changeId?}` | Marks `suggested` rows `dismissed`. The envelope then shows this to the lead. |
| `undeferTask` | `{taskId}` | Run now: clears the task's own deferral and sets `userSet.run`. A deferral inherited from an ancestor gives ControlError "Deferred with T-x: run T-x now instead". |
| `setPriorityPin` | `{taskId, pinned}` | Pin, or "Let the lead reorder this". |
| `setRunPin` | `{taskId, pinned}` | "Keep running whatever the focus." |
| `setSteeringMode` | `{mode}` | Sets `project.steeringMode` and logs a config event. It does not touch Autonomy. |
| `createTask` | `{…, priorityPinned?}` | Pins the priority when true. |

### 10.1 Undo per kind (compare-and-set)

| Kind | Condition | Action | Otherwise |
| --- | --- | --- | --- |
| focus | `currentVision.rev === row.visionRev` | Push rev+1 with `author: "user"`, `text: current.text`, `focus: before`, reason "Undid the lead's focus change (cs-…)", `source: {undoOf}` | Left: "the vision changed since (now r9)" |
| priority | Task open and `t.priority === after` | Write `before` as the user and set the priority pin | Left: "you changed it since (now P2)" |
| defer | `t.deferral?.changeSetId === set.id` | Clear the deferral and set the run pin | Left: "it was run or deferred again since" |
| undefer | Task open and no own deferral | Restore `before`, the full earlier deferral | Left |
| drop | `reopenDropped` succeeds | Reopen the task and set the run pin | Left, with `reopenDropped`'s reason |

- Rows that are undone get `status: "undone"` and `resolvedAt`.
- A row left as is keeps `applied`, and its `note` gains "left as is on undo: …".
- A row that is already undone is reported in `left` as "already undone". It is not an error.
- A single-row undo of a row that is not applied is reported as "not applied".

### 10.2 Apply per kind (as the user)

| Kind | Condition | Action |
| --- | --- | --- |
| focus | `currentVision.rev === row.visionRev` | Push a revision with `author: "user"` and `source: {changeSetId}` |
| priority | `t.priority === before` | The user's `setPriority`, which pins |
| defer | Task open, root, no own deferral | `deferral = {by: "user", reason: why, changeSetId}` |
| undefer | The deferral matches `before` | Clear it and set the run pin |
| drop | Task still open | The user's `cancelTask`. The UI confirms first, listing any running work (shown as "Cancelling" until confirmed) and any dependents that would be blocked. |

A row whose condition fails is reported in `left`.

## 11. Responsiveness and message status

### 11.1 Planning preemption

`postMessage` stops a `running` run whose `messageIds` is empty. The rest is the existing machinery:
- Scheduler step 2b forwards `interrupt` on every cycle.
- The fake acknowledges in about 2.5 s. Real adapters escalate to abort or kill after 15 s.
- A timeout sets the existing "Control failure" note after `ackTimeoutMs`.
- A late completion is discarded by the stopping guard, so old-focus proposals never land after the user's direction.
- `leadDue` returns `"message"` on the next tick.

`lastPlanningAt` was set when the planning run started, so planning does not restart at once. A message stops at most one planning run.

### 11.2 Reply runs

A second message does not stop the reply run in progress. The message is queued, and its status says so, with "Answer together now" (`stopLeadReply`). If that reply finishes first, it is held (§5) and the next run decides.

### 11.3 `messageStatus(s, m, { blocked?, nowMs }): { kind, text }`

This is a pure function, derived only from state. It never assumes a message reached a running lead. The kinds, in order of evaluation:

| Kind | Condition |
| --- | --- |
| `answered` | In the `messageIds` of a completed run |
| `working` | In the `messageIds` of the active `running` run |
| `restarting` | In the `messageIds` of a `stopping` run, after "Answer together now" |
| `stopping-planning` | Pending, and the active run is a stopping planning run. The text includes the control-failure note once the stop has timed out. |
| `queued-behind-reply` | Pending, and a reply run is running |
| `project-paused` | Pending, and `project.hold` is set |
| `blocked` | Pending, and the scheduler's `leadBlocked` is set. It is passed in as `blocked`. |
| `retry-wait` | Pending during the failure backoff, including "send a new message to retry" after 3 failures |
| `starting` | Otherwise |

The Lead button's dot and the text under each user message use this function. `LeadStatus` wording follows it, so a queued message is no longer hidden behind "Lead is working…".

## 12. Settings

A Settings card, "When you steer the lead in conversation", sits outside the Autonomy form. It has three choices:
- **Apply changes; undo any of them.** This is `apply`, the default.
- **Apply to the lead's own proposals; suggest for my tasks.** This is `apply-own`.
- **Only suggest.** This is `suggest`.

Copy changes:
- Settings.tsx:420-421 becomes: "The lead never edits specs or your pinned choices. When you give direction in the conversation, it may change the focus, reorder and defer work, and drop its own unstarted proposals; every change is listed with Undo."
- The Conversation.tsx:41 caption becomes: "When you give direction, the lead can change the focus, reorder and defer work, and drop its own unstarted proposals. Every change is listed with Undo. It never pauses or stops running work."

## 13. UI

### 13.1 Lead drawer (`App.tsx` Shell and a new `LeadDrawer.tsx`)

**The Lead button** sits next to ProjectControl and shows:
- a status dot from `messageStatus`, `activeLeadRun` and `leadBlocked`: working, stopping planning, N waiting, or blocked
- a badge with unread lead replies plus unresolved suggestions. Unread tracking uses localStorage wrapped in try/catch.

**On desktop** it opens a non-modal `<aside aria-label="Lead">` with width `min(420px, 100vw)`. The drawer:
- stays open across routes, so the user can watch the board
- moves focus to the composer on open, and returns it to the button on close
- closes on Esc when focus is inside it

**Below 768 px** it is a modal dialog with a focus trap.

**On the Overview**, the button scrolls to and focuses the inline Conversation, so there is only one instance on the page.

`Composer` uses `useId()` instead of `id="lead-message"`. The drawer takes an optional context task and shows a removable chip, "About T-012 ×".

### 13.2 Board

- A **Steer** button next to "New task" opens the drawer with the placeholder "Tell the lead what to focus on…".
- A focus banner above the toolbar reads: `Focus r8 · set by the lead from your message · 3 min ago: "…" [What changed] [Undo] [History]`.
- A **Deferred** column is added.
- Card chips:
  - `P1 · set by lead (was P5)`, while the lead's value still holds
  - `Pinned P2`
  - `Deferred by lead`
  - `Running · deferred after this step`
  - `Deferred with T-010`

  None of these changes `decisionAt` or the "New decision" badge.

### 13.3 TaskDetail

- **Ask the lead about this task** in Controls opens the drawer with the task as context. The message carries `taskId`.
- A deferral banner reads: "Deferred by the lead from your message: <why>. [Run now] [Undo]".
  - While a step is running, it reads: "This step finishes, then nothing new starts. [Pause now]". Pause now is the existing `pauseTask`: Pausing, then Paused after the runtime confirms.
  - An idle deferred task that is held before start also says it still needs release.
- Priority provenance shows one of:
  - "set by you · Let the lead reorder this"
  - "set by the lead (was P5) · Undo"
  - "Auto"
  - for a child, "Runs at T-010's priority"
- A checkbox, "Keep running whatever the focus", sets `setRunPin`.
- Activity rows with actor `lead` link to the change set and the originating message.

### 13.4 The change list (`SteeringChanges.tsx`, used in MessageItem)

Rows are grouped into four sections:

| Section | Contents | Controls |
| --- | --- | --- |
| **Changed** | Applied rows | Undo per row, and Undo all |
| **Suggested** | Suggested rows | Apply and Dismiss per row, and Apply all |
| **Not changed** | Skipped and rejected rows, each with its reason | — |
| **Undone** | Struck through, for example "by you 2 min ago" | — |

Each row shows:
- a focus diff built with `diffLines` from `src/domain/diff.ts`, or one of `P5 → P1 (next free slot; running work continues)`, `Deferred (after its current step)`, `Dropped (had not started)`
- a task link
- the **live** `stateLabel`
- the lead's `why`, as quoted plain text

Notices:
- `heldBecause` is shown as a notice, with "Ask again", which posts "Please re-apply your last steering".
- `refused` is shown as a notice.
- If any item was not applied, a notice reads "Some changes the lead described were not applied".

Behaviour of the controls:
- Buttons use the per-intent idempotency key from `ui/store.ts`, and are disabled while the request is in flight.
- The final state arrives through SSE, never from the lead's prose.

User messages show their `messageStatus` line, "About T-012" when relevant, and "Answer together now" when they are queued behind a reply.

### 13.5 Overview Vision card and notifications

**Vision card.**
- The revision chip reads `r8 · lead · from your message` and links to the message.
- It shows a diff against the previous revision.
- It has Undo when the revision was made by the lead.
- A History disclosure lists the revisions.

**Notifications** (`notifications.ts`).
- The key is `steer:{setId}`. It replaces the generic "Lead replied" notification for that message.
- The title is "Lead changed 4 things (1 suggestion)" or "Lead suggests 3 changes".
- The body is the first three rows.

## 14. Simulation and the test adapter

### 14.1 Fake runtime (`server/runtimes/fake.ts`)

The fake keeps the assignment's `prompt` in `procs` and calls `fakeLeadText(id, trigger, prompt)`.

For a message run whose pending message mentions "focus", " vs ", "instead" or "rather than", the fake emits:
- `steer.focus = "(Simulated) " + message clipped to 200`
- a `defer` on the lowest-priority open-work line whose `may:` list includes `defer`

The reply starts "(Simulated lead)". The drawer keeps its "simulated replies" chip. Other replies are unchanged.

### 14.2 ScriptedAdapter (`server/testing/scripted.ts`)

- `reply(id, reply, proposals = [], steer?: unknown)` puts `steer` in the JSON block only when it is given.
- `replyText(id, text)` returns a reply with no JSON block.
- A helper `steer(over)` builds a valid block, like `proposal()`, with items built by `st.priority(id, p)`, `st.defer(id)`, `st.undefer(id)` and `st.drop(id)`.

## 15. Migration 9→10 and ORC-008 sequencing

```ts
9: (doc) => {
  const d = doc as any;
  d.steering ??= [];
  d.project.steeringMode ??= "apply";
  const re = /^Priority P\d+ → P\d+$/;           // before ORC-009 only the user could reprioritize
  for (const e of d.events ?? []) {
    if (e.actor !== "user" || e.kind !== "control" || !e.taskId || !re.test(e.message)) continue;
    const t = d.tasks.find((x: any) => x.id === e.taskId);
    if (t) (t.userSet ??= {}).priority = e.at;
  }
  d.version = 10;
  return d;
}
```

- `STATE_FORMAT` becomes 10. The existing backup of format 9 is kept.
- Existing lead runs get no `visionRev`. A run that completes after the upgrade has its steering refused with "started before steering existed".
- Priorities chosen when a task was created before ORC-009 cannot be distinguished from the form's default, so they are **not** pinned. This is stated in the risks. The first change list shows each of these changes with Undo, and Undo pins.
- **ORC-008 sequencing.** One integration owner lands both. Whichever merges second renumbers its migration to 10→11 and rebases types.ts, model.ts, store.ts, seed.ts and Settings.tsx.
  - ORC-009 does not modify `Autonomy`, `setAutonomy`'s rebuild, `applyAutopilot`, the commands parser for `setAutonomy`, `Integration`, `project.delivery` or `deliverIfDue`/`integrateNext`.

## 16. Security and boundaries

- Steering is available only in runs that answer user messages. This limits the prompt-injection path through worker-written summaries (README "Autopilot" note). A message run still reads those summaries, so injected text could steer within the allowed actions.
- The damage is bounded:
  - only four task verbs
  - at most 20 task changes and one focus change per reply
  - no interruption
  - no cancelling of user or started work
  - no settings, delivery, integration, spec or pin edits
  - everything listed, attributed and undoable

  The README gains a note stating this.
- Task IDs are matched with `Array.find`, never by object-key lookup. Every string is length-bounded and rendered as plain text.
- Managed apps (SimpleApps) are not touched.

## 17. Work split and fixed interfaces

The fixed interfaces are the §4 types, the §10 command names and arguments, `parseLeadOutput`'s return type, `steerPermission`, `deferredBy`, `dispatchRank` and `messageStatus`. The lead commits them as stubs in P0.

| Worker | Area | Owned files |
| --- | --- | --- |
| W1 (Codex) | Domain | types.ts, model.ts, commands.ts, seed.ts, server/store.ts (migration), src/domain/steering.test.ts, model.test.ts updates |
| W2 (Claude) | Service | envelope.ts, scheduler.ts, runtimes/fake.ts, testing/scripted.ts, server/steering.test.ts, teamloop.test.ts updates (the envelope assertion at line 290), service.test.ts |
| W3 (Claude) | UI | App.tsx, LeadDrawer.tsx (new), SteeringChanges.tsx (new), Conversation.tsx, Board.tsx, TaskDetail.tsx, Overview.tsx, Settings.tsx, common.tsx, notifications.ts, styles.css |

The lead owns the docs, README, PROJECT_SPEC, the ORC-005 note, scripts/real-run-test.mjs, integration and evidence.

## 18. Judged defects and where they are fixed

| Must-fix item from the judgment | Where it is fixed |
| --- | --- |
| Deferral check placed after the finishTask branch | §6.2, with test K |
| The lead never sets hold or holdBeforeStart, requests stops or resumes, or releases any hold | §0, §3, §6; tests A and F |
| Idle deferred tasks are not shown as Paused | §6.3, the Deferred column; test D4 |
| Permission decided by messageIds, never by trigger | §2.1; test B, including the 22a variant |
| Re-check at apply time; preconditions recorded by the server | §5; test G |
| Newer direction never silently overridden | §5 `heldBecause`, §11.2; test E |
| Dependency guard for defer and drop | §3.3; test I |
| Drop limited to the lead's own unstarted proposals; reopen is the only relaxation | §8; test L |
| Children steered only through their root, derived | §6.1, §7; test J |
| Deferred proposals do not block planning, and are bounded separately | §6.5; test P |
| No band renumbering | §7; test A (untouched tasks keep their order) |
| Change list written by the service, with before/after, status, attribution and live state | §4, §5, §13.4 |
| Undo, Apply and Dismiss are keyed commands with compare-and-set | §10; test M |
| Lead changes idempotent per run | §5 step 3; test Q |
| Planning preempted; queue state visible | §11; tests C, D, W |
| ORC-008 boundaries respected | §0, §15, §16 |
| Migration and seed | §15; test S |
| Copy, README, ORC-005 note, Composer useId | §12, §13.1, the spec's scope |
| No support claims without real runs | Spec acceptance item 10; test plan "Real evidence" |


## Touched files
- src/domain/types.ts
- src/domain/model.ts
- src/domain/commands.ts
- src/domain/seed.ts
- server/store.ts
- server/envelope.ts
- server/scheduler.ts
- server/runtimes/fake.ts
- server/testing/scripted.ts
- src/ui/App.tsx
- src/ui/LeadDrawer.tsx (new)
- src/ui/SteeringChanges.tsx (new)
- src/ui/Conversation.tsx
- src/ui/Board.tsx
- src/ui/TaskDetail.tsx
- src/ui/Overview.tsx
- src/ui/Settings.tsx
- src/ui/common.tsx
- src/ui/notifications.ts
- src/ui/styles.css
- src/domain/steering.test.ts (new)
- server/steering.test.ts (new)
- server/teamloop.test.ts (envelope assertions at ~line 290)
- server/service.test.ts (simulated steering case)
- src/domain/model.test.ts (column/label/dispatch-order cases)
- scripts/real-run-test.mjs (--lead mode)
- docs/tasks/ORC-009.md (new)
- docs/tasks/ORC-005.md (appended supersession note only; executed text unchanged)
- docs/PROJECT_SPEC.md (Deferred state)
- README.md (steering capability and prompt-injection note)
- evidence/ (real Claude-led and Codex-led steering evidence JSON)

## Test plan
## Harness

**Tools.** Tests use vitest with the existing pattern from server/teamloop.test.ts:
- a temporary git repository
- `Store`, plus `Scheduler` with `claude` and `codex` `ScriptedAdapter`s
- `tick()`, `cmd()` (each call gets its own idempotency key) and `st()`

**ScriptedAdapter additions** (server/testing/scripted.ts):
- `reply(id, reply, proposals = [], steer?)`: puts `steer` in the JSON block only when it is given.
- `replyText(id, text)`: a reply with no JSON block.
- `steer(over)`: builds a valid block.
- Item helpers: `st.priority(id, p, why?)`, `st.defer(id)`, `st.undefer(id)`, `st.drop(id)`.

No real providers run in CI.

## Domain tests: src/domain/steering.test.ts (new)

**D1. Permission matrix.** A table test of `steerPermission` over targets × actions × modes, asserting the exact verdict and the reason text.
- Targets:
  - the lead's task: unstarted, running, touched by the user
  - a user task
  - a pinned priority, `userSet.run`
  - a user hold, a gate hold (`holdReason`), held before start
  - a controlFailure
  - a child, a done task, a cancelled task
- Actions: priority, defer, undefer, drop.
- Modes: apply, apply-own, suggest.

**D2. `validateSteer` strictness.** Each of these is rejected:
- the block is an array, a string or a number
- priority `2.5`, `"1"`, `0` or `100`
- two actions in one item
- no action
- `why` of 301 characters
- focus of 501 characters, a non-string focus, or a focus with control characters
- an ID with a space
- 21 items (the 21st)
- a duplicate ID (the second)

Also: `reason` defaults to "From your message", and a set note is recorded.

**D3. Deferral and dispatch** (the must-fix placement). Each is a separate case.
- A deferred ready task is not dispatched.
- A deferred active task with a running coder step:
  - no `requestStop` is issued
  - its completion is accepted (attempt completed, artifact recorded)
  - its next step is not dispatched
- A deferred active task whose last step completes becomes Done, with integration pending (the `reportCompletion` path).
- A deferred active task whose remaining steps are settled by skipping (a run-if condition) becomes Done through `dispatchEligible`'s finish branch. **This case fails if the check sits in the skip list at line 693.**
- A child of a deferred root is not dispatched.
- `resumeProject`, `resumeTask` and `startHeldTask` leave the deferral in place.
- `undeferTask` clears it, the task dispatches, and `userSet.run` is set.

**D4. Presentation.**
- An idle deferred task: column `deferred`, label "Deferred by lead".
- A running deferred task: label "Running · deferred after this step".
- A descendant: "Deferred with T-1".
- Hold plus deferral: "Paused".
- A dependent of a deferred task: "Waiting on T-x (deferred)".
- BOARD_COLUMNS contains `deferred`, and no deferred task is ever labelled Paused.

**D5. Priority tier.**
- The root is set to P1: its unpinned children dispatch before another P2 root.
- A child pinned to P9 keeps tier 9.
- Breakdown-item priorities still order children within a tree.
- Tasks the lead did not name keep their relative order.

**D6. Undo is compare-and-set.** For each kind:
- The value is restored, and the pin is set for priority, defer and drop.
- A user change in between leaves the row as is, and a note is recorded.
- A second undo reports "already undone".
- A focus undo creates a revision authored by the user with `undoOf`, and is left as is once the revision has moved.
- Undo all runs in reverse order.

**D7. Apply and dismiss.**
- An applied suggestion's actor is the user: priority pins, and a deferral has `by: "user"`.
- Applying after the value has changed is reported in `left`.
- Dismiss sets the row to `dismissed`.
- Supersede rules:
  - rows from a held set are superseded by the next completed message run
  - a row is superseded when a later set targets the same task or the focus
  - other suggestions survive

**D8. Drop and reopen.**
- The lead drops its unstarted proposal: `dropped` is recorded, and nothing else changes.
- Undo reopens it to its previous lifecycle and sets `userSet.run`.
- Reopen is refused when an open task with the same title exists.
- `validateProposal` rejects a title dropped through steering within the last 7 days.

**D9. `messageStatus`.** One case per kind:
- answered
- working
- restarting
- stopping-planning, including the control-failure text
- queued-behind-reply
- project-paused
- blocked
- retry-wait, including "send a new message" after 3 failures
- starting

**D10. Determinism.** For a fixed state and steer input, the produced change set is byte-identical (snapshot).

**D11. Pins from commands.**
- The user's `setPriority` pins.
- `createTask` pins with `priorityPinned: true` and does not pin without it.
- `setPriorityPin` and `setRunPin` toggle their pins.

## Service tests: server/steering.test.ts (new)

**A. The user's example, end to end, in apply mode.**

Setup:
- T-001: user task "Automate deployment to Vercel", ready, P2, not pinned.
- T-002: user task "Run every app locally with one command", P5, not pinned.
- T-003: user task "CI deploy pipeline", pinned with `setPriority` to P3.
- T-004: lead proposal "Deploy previews", unstarted.
- T-005: lead proposal "Deploy health check", active, with a codex coder step running.
- T-006: untouched user task at P4.

Steps:
1. `cmd("postMessage", {text: "focus more on building out the apps working locally vs automating the deployment process"})`, then `tick()`. A message run starts with `visionRev` 1.
2. `claude.reply(id, "Refocusing…", [proposal({title: "One-command local dev script", priority: 1})], steer({focus, reason, tasks: [st.priority("T-002", 2), st.defer("T-001"), st.priority("T-003", 9), st.drop("T-004"), st.defer("T-005")]}))`, then `tick()`.

Expected:
- Vision r2 is authored by lead, the text is unchanged, `source.messageIds` equals `[msg]`, and it has a `changeSetId`.
- T-002 is P2.
- T-001 is deferred by lead, in column `deferred`.
- T-003 stays P3, with a suggested row "you set P3".
- T-004 is cancelled with a `dropped` record.
- T-005:
  - its label is "Running · deferred after this step"
  - `codex.interrupts` is empty and `t.hold` is false
- T-006's priority and relative order are unchanged.
- The new proposal exists.
- The message has `changeSetId`, the rows have before and after values, and the events have actor `lead`.

Then:
3. `codex.finish(T-005 attempt)`: the result is accepted, no next step is dispatched, and the label is "Deferred by lead".
4. Close and reopen the Store: the set, deferrals and pins persist.
5. `cmd("undoSteering", {changeSetId})`:
   - every value is restored, and vision r3 is authored by the user
   - T-004 is reopened
   - T-005's next step dispatches on the next tick
   - pins are set
6. A later message whose steer re-defers T-001 now produces a suggestion, not an application.

**B. Planning runs cannot steer.**
- A planning run with a steer block records a set with `refused: "planning runs cannot steer"`. State is unchanged, but its proposals are still created.
- 22a variant: a run with trigger "planning" and non-empty `messageIds` can steer.

**C. A message preempts planning.**
1. With autonomy on and a planning run active, `postMessage` sets the run to `stopping`, and `messageStatus` is `stopping-planning`.
2. After the next tick, `claude.interrupts` contains the run.
3. A late `claude.reply(planningId, …, [proposal()])` creates no task.
4. Emit stopped, then tick: a message run starts, its `messageIds` equal `[msg]`, and `lastPlanningAt` is unchanged.

**D. Stop timeout during preemption.** No acknowledgement arrives within `ackTimeoutMs`:
- the lead run gets the control-failure note
- no message run starts
- the status text shows the failure
- after stopped is emitted, the message run starts

**E. Newer direction.**
- A second message during a message run leaves the first run running, with status `queued-behind-reply`.
- The first run completes with a steer: `heldBecause` is set, every applicable row is suggested, and nothing is applied.
- The next run's completion supersedes the held rows.
- Variant: `cmd("stopLeadReply")` → stopped → tick. The new run's `messageIds` contains both messages, and a late completion of the first run applies nothing.

**F. Race: completion queued before a message commits.**
- Planning run: call `claude.reply(...)`, then `cmd("postMessage")` before `tick()`. The completion is discarded.
- Message run: the same order. The steer is held, because a newer message is pending.

**G. User edits during the run.**
- A user `setPriority` on the target while the run is active turns the lead's priority row into a suggestion, and the user's value stays.
- A user `editVision` during the run: the focus row is rejected ("your edit stands"), the set is held, the task rows are suggested, and the proposals are still created.

**H. Modes.**
- `setSteeringMode suggest`: every row is suggested and state is unchanged.
- `applySteering` with the same idempotency key replayed returns the recorded outcome.
- The same key with different arguments is rejected.
- `dismissSteering`: the next envelope's "Recent steering" shows the row as dismissed.
- `apply-own`: the lead's proposals are applied and the user's tasks are suggested.

**I. Dependency guard.** User task T-B depends on lead proposal T-A.
- Dropping T-A is skipped: "kept: T-B depends on it". T-B is not Blocked.
- Deferring T-A is skipped.
- Deferring both, in either order: both are applied (the retry pass).

**J. Children.**
- Deferring a root that has breakdown children:
  - its children are not dispatched and show "Deferred with T-x"
  - no fields on the children change
  - the root's `waitForChildren` step is not stalled by a partial deferral
- Targeting a child ID is rejected with "steer T-x".

**K. Deferral placement** (must-fix). A service-level version of D3's skipped-steps case, driven through the scheduler.

**L. Drop and re-proposal.** After the lead drops a proposal, a planning run that proposes the same title within 7 days is rejected with the "dropped when the focus changed" reason. After Undo, the title is open again, and a duplicate is rejected as today.

**M. Undo idempotency.**
- Lead sets P5→P1, then the user sets P2, then undo: the row is left as is and the priority stays 2.
- A new key on a row that is already undone is reported "already undone" and is not an error.

**N. Caps.** A reply with 21 items: 20 are processed and 1 is rejected. A duplicate task ID is rejected.

**O. Untrusted output, rejected one by one** (the H2 pattern). A single reply mixes:
- an unknown ID
- a done task
- priority 0, 100, 2.5 and "1"
- priority and defer in one item
- a `why` of 400 characters
- a focus of 501 characters

Each is rejected with its own reason, and the valid items apply. `replyText` (no JSON) stores the problem in `run.note` and puts "nothing was changed" in `rejected`.

**P. Caps with deferral.**
- `openLeadProposals` excludes deferred work, and `leadDue` returns "planning" again once the interval has elapsed.
- When `deferredLeadRoots` reaches `maxOpenProposals`, planning is refused.

**Q. Idempotency.**
- A duplicate `completed` event for one run produces one set and one message.
- A completion after a stop request applies nothing, and `run.note` says the steering was not applied.

**R. Restart during a lead run.** The run is lost (a new scheduler instance), no set is written, and the messages stay pending.

**S. Migration 9→10.** A format-9 document fixture with a user event "Priority P3 → P1" on T-002, and a running lead run without `visionRev`. After open:
- the format is 10, `steering` is `[]`, and `steeringMode` is "apply"
- T-002 has `userSet.priority`
- the backup row is present
- when the old run completes with a steer, the set is refused with "started before steering existed"

**T. Envelope.** With 70 done tasks and 3 open ones:
- the open ones are listed first and are visible
- the `may` / `suggest` / `not` lists equal `steerPermission`
- the focus history, "Recent steering" (with undone, dismissed and held entries), "(sent from T-x)" and the steering mode line are present
- the steer contract is shown only in message runs
- the planning envelope has the planning line and no steer contract

**U. Provider-neutral.** `it.each(["claude", "codex"])` as the lead through `setLeadSelection` produces identical change sets (snapshot).

## Updates to existing tests

- **server/teamloop.test.ts.** The envelope test around line 290 is adapted to the open-work board. Assertions on reply and proposal parsing are kept.
- **server/service.test.ts.** A simulated message run containing "focus" produces a steer whose focus starts "(Simulated)", with a simulated reply.
- **src/domain/model.test.ts.** Column, label and dispatch-order cases, if any assert BOARD_COLUMNS or the sort.

## Checks

- `npm run typecheck`
- `npm test`
- `npm run build`

## Mutation checks

Revert each of these in turn and confirm that at least one test fails:
- the deferral placement (move it to line 693)
- the `messageIds` gate (use the trigger instead)
- the held downgrade
- the dependency guard
- the pins set by Undo
- the change-set ID guard
- the re-check at apply time (use the envelope snapshot)

## UI verification

There are no UI unit tests, so this uses the run skill and a browser preview on the simulated runtime.
- The drawer opens from Board and TaskDetail, stays open while navigating, handles Esc and focus correctly, and behaves as a modal dialog at 375 px.
- The Steer button and the focus banner work.
- The Deferred column shows its chips.
- The change list works: Undo, Undo all, Apply, Apply all, Dismiss, and the held and refused notices.
- "Answer together now" appears when a message is queued behind a reply.
- The TaskDetail deferral banner shows Run now, Undo and Pause now. Pause now shows Pausing, then Paused after the runtime confirms.
- Priority provenance is shown, including for a child.
- The Settings choice works, and the Overview vision diff and history are shown.
- Everything is checked in light and dark themes. Screenshots are saved with the evidence.

## Real evidence (required before claiming support)

`node scripts/real-run-test.mjs --lead` runs on a throwaway repository, never SimpleApps. The repository is seeded with:
- deployment tasks: one user task, one lead proposal, and one lead task with a running step
- local-development tasks

The script posts the user's steering message:
- once with a Claude lead
- once with a Codex lead, with workers on both providers in flight

It records in `evidence/`:
- the prompt and the raw output
- the parsed steer
- the change set
- whether any running step was interrupted (it must not be)
- the Undo-all result
- timings: from the message to the planning stop, and to the reply

`--lead --fake` runs the same scenario at no cost. Mixed-provider steering is claimed only after both real runs pass.

## Open risks
- Latency is still a full model run. Preempting planning removes the wait behind a planning run. But a real reply run can take minutes (up to runLimits.timeoutMinutes, 20 by default), plus up to about 15 s of stop time when planning is preempted. The envelope asks message runs to reply without reading the repository, but no separate time limit for reply runs is added in ORC-009.
- The model may over-steer. It can defer or reprioritize more than the user meant, and injected text from worker summaries read during a message run could skew what it does. The damage is bounded:
- four task verbs
- at most 20 task changes and one focus change per reply
- no interruption
- no cancelling of user or started work
- every change listed, attributed and undoable
- planning runs cannot steer

Even so, it steers on the model's reading of casual phrasing.
- In the default 'apply' mode, the lead may defer tasks the user created without asking, unless their run pin is set. This follows the user's autopilot preference over a stricter reading of 'preserve explicit user choices'. The spec states it. If the user objects, the fallback is to make 'apply-own' the default.
- The priority-pin migration can only use evidence it has. Priorities set with the Set control before ORC-009 are pinned, taken from user events. Priorities chosen in the New task form before ORC-009 cannot be told apart from its P3 default, so they are not pinned, and the first steer may change one the user chose on purpose. The change list shows every such change with Undo, and Undo pins.
- Ordering children by their root's priority tier changes ORC-007 dispatch order. A breakdown child whose own priority was higher than its root's no longer jumps ahead of other roots, unless the user pinned its priority. This is intended, since it is the derived cascade, but existing projects will see it.
- Deferral is a third 'not running' concept, alongside a pause and a hold before start. It comes with a new Deferred column and the label 'Running · deferred after this step'. Users must learn that deferring never interrupts, while pausing does. The copy and banners need care, and the UX reviewer should check this specifically.
- The lead's prose can contradict the service. A reply may claim a change that was rejected, only suggested, or held. The change list is authoritative and flags the mismatch, and the envelope forbids such claims, but the text can still mislead a reader.
- The 'newer direction wins' rule adds a round trip. Correcting yourself while a reply is being written turns that reply's changes into suggestions, and the next reply has to re-issue them. 'Answer together now' avoids this, but it discards the first reply's cost.
- Preempting planning wastes that run's cost, and stopped planning runs still count toward the cap of 48 planning runs a day. Only planning runs are preempted automatically, so a burst of messages stops at most one run.
- Deferred lead proposals no longer count toward the open cap. They are bounded separately (planning stops once deferred lead roots reach maxOpenProposals), but the user or the lead may still have to clear stale deferred work. The envelope prompts the lead to drop proposals that no longer fit.
- Overlap with ORC-008:
- the STATE_FORMAT bump
- shared files: types.ts, model.ts, store.ts, seed.ts, Settings.tsx
- possibly the notification and settings layout

ORC-009 keeps out of Autonomy and delivery. Even so, one integration owner must sequence the migrations and rebase whichever task lands second.
- Undo cannot restore everything:
- A drop cannot be reopened after a task with the same title has been created.
- A cancel suggestion the user applies to started work is an ordinary irreversible cancel. The UI confirms first.
- A focus undo is left as is once the vision has moved on.
- 'Pause now' loses in-flight progress, as it does today.
- The lead does not run while the whole project is paused, so the user cannot steer then. Allowing reply-only lead runs during a project pause is an open product decision.
- Real Claude and Codex leads have not yet been tested against the steer contract. Expect item rejections until the prompt is tuned: child IDs, missing JSON, or a priority given as a string. Provider support must not be claimed until both real `--lead` runs pass.
- Prompt cost grows with the envelope: the per-task allowed actions, the focus history and the recent steering. Large boards are clipped to 80 open roots, and lower-priority open work beyond that is invisible to the lead. Steering those tasks by ID is rejected as unknown to the lead's view only if the ID does not exist; the service still validates them against the current state.
- The UI work is error-prone in three places:
- two Conversation instances (the drawer and the Overview): ID collisions, duplicated live regions, focus management
- a drawer that is non-modal on desktop and modal on phones
- a new column that must stay consistent with column() and stateLabel() in both the list and column views
