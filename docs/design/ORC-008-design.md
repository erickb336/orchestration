# ORC-008 technical design: pull-request delivery, gated auto-merge, review-later queue

Companion to `docs/tasks/ORC-008.md` (spec r1). Branch `pr-delivery`. Line references are to the working copy on 2026-09-30.

## 0. Where this design comes from

Three designs were judged twice. The judges disagreed on the winner:

| Design | Judge 1 | Judge 2 | Total |
| --- | --- | --- | --- |
| 1 Safety-first | 7 | **8 (winner)** | 15 |
| 2 Autonomy-first | 6 | 6 | 12 |
| 3 Simplicity-first | **8 (winner)** | 5 | 13 |

Their graft lists converge on the same hybrid: judge 1 grafts Design 1's safety rules onto Design 3, and judge 2 grafts Design 3's reuse of the integration machine and its "queue of one" onto Design 1. This design is that hybrid:

- **Skeleton from Design 3 (smallest).** A PR is another target of the existing integration step. PR and review-later records live on `Task.integration`. There is no new state collection.
- **Gate and invariants from Design 1 (highest total).** The app's own SHA-bound gate, the authorship guard, protection of CI inputs, the posture card, and intent → act → observe with reconciliation.
- **From Design 2.** Writers wait for the first fetch, dependents wait for a merged prerequisite, a "main is red" pause with a breaker, comments by REST with a marker, and the rate-limit-aware cadence.

Every must-fix item from both judges is mapped in §19. Deviations from the judges are listed in §20.

## 1. Principles

1. One PR per task. One PR maps to one spec, one review, one merge commit, one review-later item and one revert target.
2. The PR head is the task's final commit itself. The service adds a commit only to bring a merge candidate up to date with the base.
3. Desired state (config, holds, merge requests), intent (`pr.op`) and observed state (`pr.observed`, `project.github`) are separate fields. "Merged", "posted" and "closed" are written only from an observation.
4. Only the service runs `gh` and `git push`. It never bypasses GitHub's rules, and it never forces a push.
5. Off by default. Turning PR mode on runs only a read-only preflight.
6. The review-later queue is informational. Nothing reads it to decide dispatch, integration or merging.

## 2. Safety invariants (each has a test, §17)

- **I1 No bypass, no force.** No `gh` call contains `--admin`, `--auto`, `-d`, `--delete-branch` or `--force`. No `gh api` call targets a merge endpoint (`/pulls/<n>/merge`) or sends a `mergePullRequest` or `enablePullRequestAutoMerge` mutation. No `git push` contains `--force`, `--force-with-lease`, `--mirror`, `--all`, `--tags`, `--delete` or a `+` refspec. `GhCliHost.gh()` and `WorkspaceManager.pushHead()` assert this before spawning.
- **I2 Namespace.** The only push destination is `refs/heads/orchestration/<pid>/pr/<taskId>-<n>`, checked against `^refs/heads/orchestration/[A-Za-z0-9._-]+/pr/[A-Za-z0-9._-]+-\d+$`. Fetches write only `refs/orchestration/<pid>/*`. The user's branches, `refs/remotes/*` and working copy are never written.
- **I3 Only Orchestrator's commits are published.** Before every push, every commit in `<base>..<head>` must have author name `Orchestration` and email `orchestration@localhost`. Otherwise nothing is pushed.
- **I4 Only the app's own PRs.** The app acts on a PR only if it recorded the number from its own create, or found it by `--head <its branch>` with its body marker, and the PR is not cross-repository.
- **I5 Merge binding.** The only merge path is `gh pr merge <n> -R <o/r> --merge --match-head-commit <pr.headSha>`. Review, checks and GitHub's mergeable state must all be observed for that SHA.
- **I6 Credentials.** The app never reads, stores, prints or sets a token. It never runs `gh auth token` or passes `--show-token`.
- **I7 Truthful records.** `phase: "merged"` and `landed` need an observed `MERGED` with a merge commit oid. A comment is "posted" only with a URL. A gh exit code alone records nothing.
- **I8 Bounded.** Every loop has a cap (§6.4).
- **I9 The queue never blocks.** `landed.status` changes only through the explicit commands in §5.

## 3. Data model

State format **9 → 10** (a migration is required). `State.version` becomes `10` and `STATE_FORMAT` becomes `10`. ORC-009, built next on the same branch, takes 10 → 11; its spec already says the second feature renumbers.

All additions are to `src/domain/types.ts`. No field of `Autonomy` changes, which keeps `setAutonomy`'s field-by-field rebuild (model.ts:1648) and ORC-009 out of each other's way.

```ts
// ---- desired: Project.prDelivery ----
export interface PrDeliveryConfig {
  enabled: boolean;                          // false. Never true together with autonomy.autoDeliver.enabled.
  remote: string;                            // "origin"   /^[A-Za-z0-9._-]{1,100}$/
  base: string;                              // "main"     /^[A-Za-z0-9._/-]{1,100}$/
  merge: "hold" | "auto";                    // "hold"
  reviewer: "other-provider" | "any-agent";  // "other-provider"
  updateBeforeMerge: boolean;                // true: an auto-merge candidate is brought up to date with the base first
  autoRepair: boolean;                       // true: auto mode only, bounded
  protectedPaths: string[];                  // globs; a touched path turns auto into hold. ≤20 entries, ≤200 chars each
  allowLocalWorkers: boolean;                // false: auto is unavailable while an enabled provider's workerEnvironment is "local"
  maxOpenPrs: number;                        // 5  (1–20)
  maxAutoMergesPerDay: number;               // 20 (0–100)
}
export const DEFAULT_PR_DELIVERY: PrDeliveryConfig = {
  enabled: false, remote: "origin", base: "main", merge: "hold", reviewer: "other-provider",
  updateBeforeMerge: true, autoRepair: true,
  protectedPaths: [".github/**", "package.json", "tsconfig*.json", "vitest.config.*", "vite.config.*"],
  allowLocalWorkers: false, maxOpenPrs: 5, maxAutoMergesPerDay: 20,
};

// ---- observed: Project.github (written only by the service; never secrets) ----
export interface PostureItem { id: string; status: "ok" | "warn" | "fail" | "unverified"; label: string; detail: string }
export interface GitHubStatus {
  simulated?: boolean;
  recheck?: boolean;                         // set by recheckGitHub
  checkedAt?: string;
  ok: boolean;                               // false: no GitHub operation except preflight
  problem?: { code: "gh-missing" | "gh-old" | "git-old" | "auth" | "remote" | "permission" | "rate-limit" | "network";
              message: string; since: string; retryAt?: string };
  repo?: string;                             // "owner/name", parsed from the remote URL
  login?: string; ghVersion?: string;
  requiredChecks: string[];                  // from the rules and protection APIs, never hard-coded
  autoMergeBlockers: string[];               // empty = auto mode available
  posture: PostureItem[];
  base?: { sha: string; fetchedAt: string }; // value of refs/orchestration/<pid>/base
  observedAt?: string; rateRemaining?: number;
  lastMutationAt?: string;
  mutations?: { hour: string; count: number };
  autoMerges?: { day: string; count: number };
  mainBreaks?: string[];                     // times (≤24 h old) a merge made by the app was followed by a failed main check
  autoMergePaused?: { since: string; reason: string; sticky: boolean; taskId?: string };
}

export interface CheckObs { name: string; required: boolean; status: string; conclusion: string | null; url?: string }

export type PrAttentionCode =
  | "foreign-commits" | "workflow-change" | "remote-diverged" | "foreign-push" | "draft" | "base-changed"
  | "checks-failed" | "checks-missing" | "checks-timeout" | "non-required-failing"
  | "review-findings" | "review-blocked" | "review-limit"
  | "conflict" | "approval-required" | "github-blocked" | "changes-requested" | "hold-label"
  | "merge-rejected" | "protected-path" | "local-workers" | "auto-unavailable" | "limit";

// ---- per task: Integration.pr ----
export interface PrDelivery {
  n: number;                                 // 1; +1 on redeliver → branch suffix
  repo: string; remote: string; base: string;
  branch: string;                            // orchestration/<pid>/pr/<taskId>-<n>
  simulated?: boolean;
  changeSha: string;                         // newest agent-authored commit: what the review must cover
  changeTaskId: string;                      // task whose finalChange is changeSha (the source task, or the latest repair)
  changeAuthor: ProviderId | "user" | "unknown"; // who wrote changeSha. "user" only when their edit supplied another commit; "unknown" (run not on record) fails closed
  changeAuthors: (ProviderId | "user" | "unknown")[]; // everyone who authored a commit the PR holds: the task's coder runs and every fix pushed onto it. Only grows.
  headSha: string;                           // what the app pushed: changeSha, or a service merge of the base into it
  baseSha: string;                           // base tip contained in headSha
  pendingHead?: { sha: string; changeSha: string; changeTaskId: string; changeAuthor: ProviderId | "user";
                  baseSha: string; kind: "update" | "repair" };
  changed: { files: number; additions: number; deletions: number; paths: string[] /* ≤50 */;
             protectedHits: string[]; workflowHits: string[] };
  // desired
  policy: "hold" | "auto"; policySource: "project" | "user";
  userHold?: { at: string; reason?: string };          // cleared only by the user; survives project resume
  mergeRequested?: { at: string; headSha: string };    // the user's Merge click, bound to the head they saw
  workflowPushAllowed?: boolean;
  closeRequested?: { at: string };
  // intent
  phase: "built" | "open" | "merged" | "closed";
  op?: { id: string; kind: "publish" | "push" | "merge" | "close"; at: string; headSha: string };
  // observed and recorded
  number?: number; url?: string;
  observed?: {
    at: string; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; crossRepo: boolean;
    headSha: string; baseRef: string; mergeable: string; mergeStateStatus: string;
    reviewDecision: string | null; labels: string[];
    checks: CheckObs[]; checksFor: string;
    mergedAt?: string; mergeCommit?: string; mergedBy?: string; closedBy?: string;
  };
  review: ReviewEvidence;
  reviewTaskIds: string[]; repairTaskIds: string[];
  foreignHead?: { sha: string; at: string };           // sticky
  attention?: { code: PrAttentionCode; message: string; headSha?: string; since: string };
  counters: { mergeAttempts: number; baseUpdates: number; repairs: number; reviews: number; failures: number };
  nextAt?: string;                                     // backoff after a failed operation
  headSince?: string;                                  // when headSha was first observed on GitHub (check timeouts)
  message?: string;                                    // last error, redacted, ≤300 chars
}
export interface ReviewEvidence {
  ok: boolean; source: "pipeline" | "dedicated" | "none"; reason: string;
  forSha?: string; taskId?: string; attemptId?: string; provider?: ProviderId; model?: string;
  artifactIds: string[]; clearedByUser?: boolean;
}

// ---- per task: Integration.landed (the review-later item) ----
export interface Landed {
  at: string; via: "pr" | "local"; target: string;     // "erickb336/orchestrator main" | "main"
  commit: string;                                      // full SHA: GitHub merge commit, or the task's integration merge commit
  simulated?: boolean;
  by: "app" | "person"; mergedBy?: string;
  pr?: { number: number; url: string };
  review?: ReviewEvidence;                             // as it stood at merge
  checks?: CheckObs[];                                 // required checks on the merged head
  mainCheck?: { state: "pending" | "success" | "failure" | "unknown"; at: string; url?: string };
  flags: ("main-check-failed" | "merged-without-clean-gate" | "findings-cleared-by-user" | "protected-paths")[];
  status: "unreviewed" | "reviewed" | "sent-back"; statusAt?: string;
  notes: { id: string; at: string; text: string;
           comment?: { status: "pending" | "posted" | "failed"; url?: string; error?: string; attempts: number } }[];
  followUps: { taskId: string; kind: "fix" | "revert" }[];
}
```

Changes to existing types:

| Type | Change |
| --- | --- |
| `State` | `version: 10` |
| `Project` | `prDelivery: PrDeliveryConfig`; `github?: GitHubStatus` |
| `Integration` | `sha?: string` (full SHA of the local integration merge commit); `pr?: PrDelivery`; `landed?: Landed` |
| `Task` | `deliverInto?: { taskId: string; n: number; mergeBase: boolean }` (a repair that is pushed onto that task's PR); `reviewTarget?: { taskId: string; n: number; headSha: string; baseSha: string }` (a dedicated review); `revertOf?: { taskId: string; commit: string }` |
| `StepDef` | `independentOf?: "writer"` |
| `SelectionSource` | add `"independence"` |
| `RunSnapshot` | `reviewedSha?: string` |

Migration `MIGRATIONS[9]` in `server/store.ts`: `project.prDelivery ??= { ...DEFAULT_PR_DELIVERY }; doc.version = 10`. It sets no `github`, no `pr` and no `landed`: earlier deliveries are never backfilled. `src/domain/seed.ts` builds version 10 with `prDelivery: DEFAULT_PR_DELIVERY`.

New pure module **`src/domain/delivery.ts`** holds everything below. `model.ts` gets only the hooks in §11, which keeps the overlap with ORC-009 small.

## 4. Lifecycle

```
task done → integration {status:"pending"}                              (existing)
  integrateNext [PR mode] → workspaces.preparePrHead (local, synchronous)
      commit missing | foreign commits | conflict with base → integration "conflict" (existing UI, Retry integration)
      clean → integration {status:"integrated", ref:"<sha12> on <branch>", pr:{phase:"built", …}}
              event: "Prepared pull request branch <branch> (<sha12>)"   // never "Integrated into the integration branch"
  built → publish (push, then find-or-create PR) → open
  open  → observe → gate
      policy hold: notify once when ready; the user merges on GitHub or clicks Merge (bound to the head SHA)
      policy auto: merge candidate → [update to base → checks on the new head] → merge → observe
      observed MERGED → phase "merged", landed {by: app|person}; fetch the base; watch the main check ≤2 h
      observed CLOSED → phase "closed"; nothing is reopened or pushed again; the user may Deliver again (n+1)
```

A task whose `deliverInto` is set never opens its own PR: its final commit becomes `pendingHead` of the target PR (§9.3).

Local fast-forward delivery is unchanged, except that `reportDeliveryResult("delivered")` also writes `landed {via:"local", commit: integration.sha}` for each task it newly marks delivered.

## 5. Commands

All are entries in `COMMANDS` (`src/domain/commands.ts`), shape-validated, applied in `BEGIN IMMEDIATE` with an idempotency key. The implementations are in `delivery.ts`.

| Command | Args | Behaviour |
| --- | --- | --- |
| `setDeliveryMode` | `{mode: "off" \| "local" \| "pr", branch?}` | Sets `autoDeliver.enabled` and `prDelivery.enabled` together, never both. `pr` sets `github.recheck`. `local` also sets `delivery.pending = true` when integrated, undelivered, non-PR tasks exist (fixes defect 1) and clears `delivery.lastSha` when the branch changed (part of defect 3). |
| `setPrDelivery` | `{config}` | Validates §3 ranges. A project-level `merge` change applies to open PRs whose `policySource` is `"project"`. |
| `recheckGitHub` | `{}` | Read-only preflight now. |
| `holdPr` / `releasePr` | `{taskId, reason?}` | Sets or clears `userHold`. |
| `setPrPolicy` | `{taskId, policy: "hold" \| "auto" \| null}` | `null` follows the project. |
| `requestPrMerge` | `{taskId, headSha}` | Rejected unless `headSha === pr.headSha` and no `pendingHead`. Any new head clears it. |
| `allowWorkflowPush` | `{taskId}` | One delivery only; logged. |
| `closePr` | `{taskId}` | Sets `closeRequested`. |
| `redeliver` | `{taskIds ≤20}` | Done tasks with a final change, not landed, whose PR is absent or closed: `integration = {status:"pending"}`; the next PR uses `n+1`. |
| `repairPr` | `{taskId}` | Creates a repair task now (user action; does not count against `autoRepair` but does count against the cap of 2). |
| `requestPrReview` | `{taskId}` | Creates a dedicated review now; the user may exceed the cap of 3. |
| `markLandedReviewed` | `{taskIds ≤100, reviewed: boolean}` | The only way `status` becomes `reviewed` or returns to `unreviewed`. |
| `addLandedNote` / `retryLandedComment` | `{taskId, text ≤4000, postToGitHub}` / `{taskId, noteId}` | The note is recorded at once. `postToGitHub` (default false, PR items only) sets `comment.status = "pending"`. |
| `sendBackLanded` | `{taskId, kind: "fix" \| "revert", note, holdBeforeStart}` → `{newId}` | §10. |
| `resumeAutoMerge` | `{}` | Clears `github.autoMergePaused` and `mainBreaks`. |
| `resetDeliveryBaseline` | `{}` | Local mode: clears `delivery.lastSha`, sets `pending` (fixes defect 3). |

Existing commands that change:

- `setAutonomy` rejects `autoDeliver.enabled = true` while `prDelivery.enabled` ("Pull-request delivery is on; switch the delivery mode instead").
- `applyAutopilot(branch)` leaves PR mode and `prDelivery.merge` untouched. If PR mode is on, it does not enable `autoDeliver`. A preset never turns on publishing or auto-merge.
- `createFollowUp(state, taskId, now, opts?)` with `opts = { holdBeforeStart?: boolean; steps?: StepDef[]; author?: Actor; dependsOn?: string[]; fields?: Partial<Task> }`:
  - **Unique id.** `<root>-F<k>`, with `k` = 1 + the highest `-F<n>` among ids sharing the root, then a loop until unused. This fixes the confirmed duplicate for a follow-up of a follow-up.
  - **Fresh steps.** `opts.steps`, else the steps of the newest `pipelineHistory` revision that contains no step with `copyOf` or `iteration`, instantiated fresh. Expanded `-iN` and `-cN` copies are never copied.
  - **Hold.** `holdBeforeStart = opts.holdBeforeStart ?? true`. The two existing commands keep `true`.

Service-only functions, called through lease-checked `store.update`: `reportPreflight`, `reportBaseFetched`, `beginPrOp`, `reportPrOp`, `reportObservations`, `reportPrHead` (from `integrateNext`), `recordLanded`.

`server/http.ts` rejects `setDeliveryMode {mode:"pr"}` when the runtime is real and the project is a sample, the same way it rejects `resetSampleData` today.

## 6. Scheduler

### 6.1 New code, and what changes in `server/scheduler.ts`

- **`server/github.ts`**: `GitHubHost`, `GhCliHost`, `SimulatedGitHub`, `classifyGhError` (§7).
- **`server/prdelivery.ts`**: `class PrDriver { constructor(store, host, workspaces | undefined, opts); tick(nowMs, lease); abortAll() }`. It owns single-flight, the result queue and the generation counter.
- **`server/scheduler.ts`** changes are four call sites:
  1. `SchedulerOptions.github?: GitHubHost` and `workerShell?: boolean`. The constructor builds `this.pr = new PrDriver(...)`, using `SimulatedGitHub` when there is no `workspaces` (fake runtime).
  2. `runCycle` step 5 becomes `integrateNext(); deliverIfDue(); this.pr.tick(nowMs, lease);`. Step 1 passes `holdWriters` (§6.5).
  3. `integrateNext` branches on `prDelivery.enabled` (§6.2). `launch()` chooses the writer base, passes a seed and the review diff (§6.5).
  4. `killAll()` calls `this.pr.abortAll()`.

### 6.2 `integrateNext` in PR mode

When `project.prDelivery.enabled`:

- Fake runtime: `reportPrHead` with a simulated head (`sim-<taskId>`), `pr.simulated = true`.
- `github.base` missing: `reportIntegrationError("waiting for the first fetch of <remote>/<base>")`; the existing 60 s retry applies.
- Otherwise `workspaces.preparePrHead({repoPath, projectId, taskId, n, baseRef, sha})`, which is local and synchronous:
  1. `git rev-parse --verify --end-of-options <sha>^{commit}`.
  2. **Authorship guard (I3).** `git log --format=%an%x00%ae --end-of-options <baseSha>..<sha>`. Any line other than `Orchestration\0orchestration@localhost` → `{status:"conflict", message:"contains N commit(s) not made by Orchestrator (authors: …); nothing was pushed"}`.
  3. **Conflict pre-check.** `git merge-tree --write-tree --name-only --no-messages <baseSha> <sha>`. Exit 1 → `{status:"conflict", message:"conflicts with <base> in a, b"}` (≤20 files).
  4. **Change facts.** `git diff --no-ext-diff --no-textconv --numstat -M <merge-base> <sha>` → `changed`. `protectedHits` = paths matching `protectedPaths`. `workflowHits` = paths under `.github/workflows/`.
  5. **Pin.** `git update-ref refs/orchestration/<pid>/pr/<taskId>-<n> <sha>`, so the object survives garbage collection.
- `reportPrHead` sets `integration = {status:"integrated", sha, ref, pr}` and evaluates `reviewCoverage` (§9.1). It does not set `project.delivery.pending`.
- For a task with `deliverInto`: the same checks, plus `git merge-base --is-ancestor <target.headSha> <sha>`. If the head moved, the result is `not-needed` with the message "stale: the PR head moved". Otherwise the target PR gets `pendingHead {kind:"repair"}`, the repair task gets `integration = {status:"integrated", ref:"<sha12> → PR #n of <taskId>"}` and no `pr` of its own. If the target PR is already merged or closed, the repair is delivered as its own PR.

`nextIntegration` is unchanged. `reportDeliveryResult` skips tasks that have `integration.pr`, so a mode switch can never mark a PR task as delivered, and `deliver()` never sees PR work because PR heads are not merged into the integration branch.

### 6.3 `PrDriver.tick(nowMs, lease)`

```
1. for each queued result with gen === this.gen:
     store.update(s => D.reportPrOp(s, result, now), now, lease)     // stale-guarded by opId, n and headSha
2. if an operation is in flight → return                             // single flight: one network operation per project
3. state = store.read().state
   if real runtime and state.project.sample → return                 // samples never contact GitHub
4. op = D.nextPrOp(state, nowMs)                                     // pure planner, §6.4
   if !op → return
5. if op mutates GitHub:
     r = store.update(s => D.beginPrOp(s, op, now), now, lease)      // re-checks project hold, userHold, the gate and that no op is recorded
     if the transaction did not record op.id as pr.op → return       // nothing starts without a committed intent
6. start the async operation; on settle push {op, result, gen} onto the result queue
```

- `abortAll()` increments `gen`, kills the child process group (SIGTERM, then SIGKILL after 5 s) and clears the queue. Results from before a lease loss are therefore never written.
- Local git inside an operation (building a base-update commit) is synchronous and capped, like `integrate()` today. Everything that touches the network is async: gh 60 s timeout, git 120 s, `maxBuffer` 5 MB.
- **Merge freshness.** `observed.at` is the time GitHub was read, stamped by the driver before the request is sent, not the time the result is applied. The planner emits `merge` only when `observed.at` is ≤15 s old. If the gate is ready but the observation is older, it emits an `observe` for that PR first. `beginPrOp(merge)` then re-reads the hold and re-runs the gate inside the transaction, and `gh pr merge` starts in the same tick. The time between the last check of GitHub and the merge is at most about 16 s; a pause or hold is honoured up to the moment of the spawn.

### 6.4 `D.nextPrOp(state, nowMs)`: order, cadence and bounds

First match wins.

1. `github.problem.retryAt > now` → nothing. Any other problem → only `preflight`, every 5 min, backing off to 30.
2. **Preflight** when `github` is missing, `recheck` is set, or `checkedAt` is older than 6 h. It runs only while PR mode is on or an open PR or a pending main check is still tracked.
3. **Interrupted intent.** A `pr.op` with no operation in flight, older than its timeout plus 30 s (an orphaned child may still finish): `merge` or `close` → `observe` that PR; `publish` or `push` → the same operation again (both check the remote first, §8).
4. **Fetch base** when `base.fetchedAt` is older than 60 s and something needs it (a writer step is dispatchable, a PR build is pending, a merge candidate exists, or a merge was observed since the last fetch). Otherwise every 10 min while PR mode is on.
5. **Observe** (one batched query, ≤20 PRs plus pending main checks):
   - every 30 s while a merge candidate, a `mergeRequested` or an intent exists;
   - every 2 min otherwise while PRs are open;
   - every 5 min while the project is paused (read-only watching continues and is labelled);
   - main checks of landed commits every 60 s for ≤2 h, then `unknown` (flagged);
   - everything drops to 5 min when `rateRemaining < 300`.
6. **Mutations**, only when `!project.hold`, `github.ok`, PR mode is on, ≥2 s since `lastMutationAt` and fewer than 200 mutations this hour. Per PR, also `!userHold`, `!foreignHead` and `nextAt` elapsed:
   1. `merge` for a PR with a valid `mergeRequested`, else for the merge candidate, when the gate is ready (§9.5).
   2. `push` for a PR with `pendingHead`.
   3. `update-base` for the merge candidate when `updateBeforeMerge` and the fetched base is not contained in its head.
   4. `publish` for the oldest `built` PR, while open PRs < `maxOpenPrs` and the path policy allows (§9.6).
   5. `comment` for a note with `comment.status = "pending"`.
   6. `close` for `closeRequested`.

A prepared base update (`pendingHead {kind:"update"}`) is pushed only for the merge candidate. When the PR stops being it before the push (switched to hold, held, blocked), the prepared head is dropped and does not count against the cap.

**The merge candidate** is the oldest open PR (by `integration.at`) with policy `auto`, no `userHold`, no `foreignHead`, no `pendingHead`, `review.ok`, and no attention that needs the user. Only the candidate is ever updated to the base or auto-merged. A PR that becomes blocked drops out, so the next one proceeds. Other ready PRs show "Waiting behind PR #n".

**Bounds.**

| Bound | Value |
| --- | --- |
| Open PRs | `maxOpenPrs` (5) |
| Auto-merges per day | `maxAutoMergesPerDay` (20) |
| Merge attempts per head | 2, then `merge-rejected` |
| Base updates per PR | 3, then `limit` |
| Repairs per PR | 2, then the user |
| Dedicated reviews per PR | 3, then `review-limit` |
| Required check pending on one head | 60 min → `checks-timeout` |
| No required check reported after the head was observed | 15 min → `checks-missing` |
| GitHub `BLOCKED` with every required check green | 10 min → `github-blocked` (at once as `approval-required` when `reviewDecision` is `REVIEW_REQUIRED`) |
| Non-required checks failing or pending after required ones passed | 30 min → `non-required-failing` |
| Operation failure backoff per PR | 1, 2, 4, 8, 15 min |
| Rate limit | until the reset time when known, else 5, 15, 60 min |
| Comment attempts | 3, then `failed` with Retry |
| Mutation pacing | ≥2 s apart, ≤200 per hour (GitHub allows 80 per minute and 500 per hour) |

### 6.5 Writers, dependencies and the reviewer's view

- **Writer base (`launch()`).**
  `baseRefFor(state, task, step) ?? (task.deliverInto ? target pr.headSha : prMode || task.revertOf-in-PR-mode ? "refs/orchestration/<pid>/base" : d.enabled ? "refs/heads/<d.branch>" : undefined)`.
  In PR mode a writer never falls back to a local branch or `HEAD`.
- **Wait for the first fetch.** `DispatchOptions.holdWriters?: string`. While PR mode is on and `github.base` is missing, `runCycle` passes `"waiting for the first fetch of origin/main"`, and `dispatchEligible` skips `coder` steps that have no code-change input. Nothing is blocked or failed; the UI shows the reason.
- **Dependencies (`waitingOn`).** In PR mode a prerequisite counts as satisfied only when it is done and one of these holds:
  - its integration is `not-needed`;
  - it has `landed` and `github.base.fetchedAt >= landed.at`, so the merged code is in the writer base;
  - it has no `pr` and was integrated before PR mode was switched on.

  A prerequisite whose PR is open shows "Waiting for T-012's PR #34 to merge". One whose PR was closed gives a `blockedReason`: "T-012's PR #34 was closed without merging". The same predicate is used by `childrenSettled` for `waitForChildren` steps. Dedicated review and repair tasks are created with `dependsOn: []`, so they do not wait on their own PR.
- **Seeds (`WorkspaceManager.prepare({… seed})`).** After `worktree add`, as Orchestrator:
  - `{kind:"merge", ref}` → `git merge --no-ff --no-commit <ref>`;
  - `{kind:"revert", commit}` → `git revert --no-commit [-m 1] <commit>` (`-m 1` when `git rev-list --parents -n 1` shows two parents).

  A non-zero exit that leaves conflicts is expected. `prepare` returns `seed.conflicted` (≤20 files, from `diff --name-only --diff-filter=U`), and the envelope lists them and tells the coder not to run git.
- **Marker guard (`WorkspaceManager.commit`).** For a seeded workspace, after `add -A`: `git grep -n -E '^(<<<<<<<|>>>>>>>) ' --cached` must find nothing in the seeded conflicted files. Otherwise the step fails with "unresolved conflict markers in X" and nothing is recorded. `git commit` then concludes the merge (two parents) or the revert.
- **The reviewer sees the diff.** `EnvelopeInput.changeUnderReview?: string`. For a read-only step whose inputs include a code change, or whose task has `reviewTarget`, `launch()` computes it and `buildEnvelope` stays pure:
  - `from` = `reviewTarget.baseSha`, else `git merge-base <project base ref> <sha>`; `to` = the newest code-change input's SHA, or `reviewTarget.headSha`.
  - `git diff --no-color --no-ext-diff --no-textconv -M --stat --patch <from> <to>`, capped at 60 KB with "truncated; k files not shown" and the file list.
  - The section is headed "Change under review (<from12>..<to12>)" and is followed by: "Count in openFindings only issues that must be fixed before merging. Any weakening of tests, CI or build scripts is a blocking finding."

  This closes a real gap: the default reviewer (Claude, read-only: Read, Glob, Grep) cannot see diff hunks today. A dedicated review's worktree is detached at `reviewTarget.headSha`, and its attempt snapshot records `reviewedSha`.

## 7. GitHub host interface

```ts
// server/github.ts
export interface RepoRef { owner: string; name: string }
export interface PreflightResult {
  ok: boolean; problem?: GitHubStatus["problem"];
  repo?: string; login?: string; ghVersion?: string;
  requiredChecks: string[]; autoMergeBlockers: string[]; posture: PostureItem[];
}
export interface PrObservation {
  number: number; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; crossRepo: boolean; url: string;
  headRef: string; headSha: string; baseRef: string; mergeable: string; mergeStateStatus: string;
  reviewDecision: string | null; labels: string[]; checks: CheckObs[]; checksFor: string;
  mergedAt?: string; mergeCommit?: string; mergedBy?: string; closedBy?: string;
}
export type GhErrorCode = "auth" | "not-found" | "head-mismatch" | "rejected" | "rate-limit" | "network" | "timeout" | "unknown";
export class GhError extends Error { code: GhErrorCode; retryAt?: string }

export interface GitHubHost {
  readonly simulated: boolean;
  preflight(a: { remoteUrl: string; base: string }): Promise<PreflightResult>;
  findPr(a: { repo: RepoRef; head: string; marker: string }): Promise<{ number: number; url: string } | undefined>;
  createPr(a: { repo: RepoRef; base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  observe(a: { repo: RepoRef; prs: number[]; commits: string[] }): Promise<{
    prs: PrObservation[]; commits: { oid: string; checks: CheckObs[] }[]; rateRemaining?: number; rateResetAt?: string }>;
  merge(a: { repo: RepoRef; number: number; headSha: string; subject: string; body: string }): Promise<void>; // the caller observes afterwards
  findComment(a: { repo: RepoRef; number: number; marker: string }): Promise<{ url: string } | undefined>;
  comment(a: { repo: RepoRef; number: number; body: string }): Promise<{ url: string }>;
  close(a: { repo: RepoRef; number: number; comment: string }): Promise<void>;
  abortAll(): void;
}

export class GhCliHost implements GitHubHost {
  constructor(o: { ghBin?: string /* "gh" */; gitBin?: string; cwd: string /* empty <dataDir>/gh-neutral */; timeoutMs?: number });
}
export class SimulatedGitHub implements GitHubHost { /* in memory; PR numbers from 1000; urls "simulated://pr/1000" */ }
```

Git network operations are not part of the host. They are three async methods on `WorkspaceManager`, so tests run them for real against a local bare remote:

```ts
fetchBase(o: { repoPath; projectId; remote; base }): Promise<{ sha: string }>
lsRemote(o: { repoPath; remote; branch }): Promise<string | undefined>
pushHead(o: { repoPath; remote; branch; sha }): Promise<"pushed" | "already" | "diverged">
```

They share a private `runAsync(args)` (`execFile`, no shell) with the same `-c` safety flags and `gitEnv()` as `run()`.

Tests inject one of three things:

- `server/testing/fakeGitHub.ts`, `class FakeGitHub extends SimulatedGitHub`, given a bare repository path. `observe` reads the real head of the PR branch from the bare repository. `merge` checks `headSha` and makes a real two-parent merge commit on the bare `main` (`merge-tree --write-tree`, `commit-tree`, `update-ref`). The test scripts check states, delays, failures, a person's merge or close, and labels.
- `server/testing/fake-gh.mjs`, an executable Node script passed as `ghBin` to `GhCliHost`. It appends argv, stdin, selected environment and cwd to a log file and returns canned output. It tests the exact command lines and the parsing.
- `SimulatedGitHub` itself, for the fake runtime.

## 8. Exact git and gh invocations

**Environment for every gh and git network child.** Start from `gitEnv()`. Remove `GH_DEBUG`, `GH_REPO`, `GH_HOST`, `GIT_TRACE*`, `GIT_CURL_VERBOSE`. Set `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `NO_COLOR=1`, `GIT_TERMINAL_PROMPT=0`. For ssh remotes add `GIT_SSH_COMMAND=ssh -oBatchMode=yes`. The app never sets `GH_TOKEN`; a value the user set passes through unread. Every gh call runs from the neutral cwd with `-R <owner/repo>` (or an explicit `repos/<o>/<r>` path) and takes bodies on stdin. Stderr goes through a shared `redact()` (moved from `server/runtimes/codex.ts:158` to `server/redact.ts`), is cut to the last 2 lines and 300 characters, and is never logged raw.

| Operation | Commands |
| --- | --- |
| **Preflight** (read-only) | `gh --version` (≥2.13; developed against 2.101.0) · `git --version` (≥2.40, for `merge-tree --merge-base`) · `git -C <repo> remote get-url --push <remote>` → must parse as `github.com[:/]<owner>/<name>(.git)` · `gh api user --jq .login` (exit 4 → `auth`) · `gh api repos/<o>/<r> --jq '{push:.permissions.push,admin:.permissions.admin,archived:.archived,mergeCommit:.allow_merge_commit,autoMerge:.allow_auto_merge,deleteOnMerge:.delete_branch_on_merge,private:.private}'` · `gh api repos/<o>/<r>/rules/branches/<base>` (required status check contexts; `pull_request` parameters; `merge_queue`) · `gh api repos/<o>/<r>/branches/<base>/protection/required_status_checks --jq .contexts` (404 = none) · `gh api repos/<o>/<r>/rulesets --jq '.[].id'` then `gh api repos/<o>/<r>/rulesets/<id> --jq '{name,enforcement,current_user_can_bypass}'` |
| **Fetch base** | `git -C <repo> fetch --quiet --no-tags --no-write-fetch-head --no-recurse-submodules <remote> +refs/heads/<base>:refs/orchestration/<pid>/base` then `rev-parse refs/orchestration/<pid>/base^{commit}`. This is the only `+` refspec, and its destination is a private local ref. |
| **Publish** | (1) Re-check the push URL. (2) `git -C <repo> ls-remote --refs <remote> refs/heads/<branch>`: equal to `headSha` → skip; absent, or an ancestor of `headSha` → push; anything else → attention `remote-diverged`, never forced. (3) `git -C <repo> push --porcelain --no-verify <remote> <headSha>:refs/heads/<branch>`. (4) `gh pr list -R <o/r> --head <branch> --state all --json number,url,state,body,isCrossRepository --limit 10`; adopt the one carrying the marker. (5) Otherwise `gh pr create -R <o/r> --base <base> --head <branch> --title "<taskId>: <title>" --body-file -`; stdout is the URL, and the number is parsed from `/pull/(\d+)`. |
| **Observe** | `gh api graphql --input -` with one alias per PR: `p<n>: pullRequest(number:n){number state isDraft isCrossRepository url mergedAt mergedBy{login} mergeCommit{oid} headRefName headRefOid baseRefName mergeable mergeStateStatus reviewDecision labels(first:20){nodes{name}} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{actor{login}}}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:50){nodes{__typename ... on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:n)} ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:n)}}}}}}}}`, plus `c<k>: object(oid:"<sha>"){... on Commit{statusCheckRollup{contexts(first:50){…}}}}` for each pending main check, plus `rateLimit{remaining resetAt}`. Numbers and oids are validated as integers and hex before they are placed in the query. The legacy `commits/<sha>/status` endpoint is never used. About 1 point per query. |
| **Base update** (local, then push) | `git merge-tree --write-tree --name-only --no-messages <headSha> <baseSha>` (exit 1 → attention `conflict`) → `git -c user.name=Orchestration -c user.email=orchestration@localhost commit-tree <tree> -p <headSha> -p <baseSha> -m "Merge <base> into <branch>"` → `update-ref refs/orchestration/<pid>/pr/<taskId>-<n> <new> <headSha>` → recorded as `pendingHead {kind:"update"}` → the push above. A commit already pinned there is reused only when its parents, its author and its tree equal this merge. The new commit descends from the old head, so the push is a plain fast-forward. |
| **Merge** | `gh pr merge <n> -R <o/r> --merge --match-head-commit <headSha> --subject "<taskId>: <title> (#<n>)" --body-file -`. The body names the review evidence and the checks. An `observe` always follows; the exit code records nothing. |
| **Comment** (user notes only) | Before any post: `gh api repos/<o>/<r>/issues/<n>/comments --paginate --jq '.[] \| select(.body \| contains("<marker>")) \| .html_url'`. If absent: `gh api -X POST repos/<o>/<r>/issues/<n>/comments --input -` with `{"body": "<note>\n\n<!-- orchestration:note:<pid>/<noteId> -->"}` → `.html_url`. `gh pr comment --edit-last` is never used. |
| **Close** | `gh pr close <n> -R <o/r> --comment "Closed from Orchestrator."`, then `observe`. The remote branch is not deleted. |
| **Diff for the viewer** | `git -C <repo> diff --no-color --no-ext-diff --no-textconv -M --stat --patch <c>^1 <c>`. |

**PR body.** The spec outcome and acceptance; the review evidence when it exists ("Automated review by Orchestrator (Claude · <model>), not a human review: 0 open findings on <sha12>"); "Opened by Orchestrator using this GitHub account"; and the marker `<!-- orchestration:pr:<pid>/<taskId>/<n> -->`. It is redacted and capped at 6,000 characters. The repository may be public, so agent-written text becomes public.

## 9. Review and the merge gate

### 9.1 Review coverage: `D.reviewCoverage(s, prTask) → ReviewEvidence`

Evaluated when the PR is built, on every head change, and whenever a review or repair task of this PR finishes. Evidence counts only `forSha === pr.changeSha`.

1. **Pipeline review (no extra run).** Let `c = getTask(pr.changeTaskId)` and `fc = finalChange(s, c)`. It requires `sha(fc) === pr.changeSha`. `covering` = the accepted `review-findings` outputs of done steps of `c` whose producing attempt has `fc.id` in `snapshot.inputs` (for a version the user edited, the attempt of the latest non-edit version). It passes when all of these hold:
   - `covering` is not empty, and at least one comes from a `code_reviewer` attempt with `outcome === "completed"`. Otherwise the reason is "no review saw the final change <sha12>". This catches the confirmed defect where the repair loop runs out and the last repair is never reviewed.
   - every covering artifact has `openFindings === 0`. A value the user edited to 0 passes with `clearedByUser`.
   - with `reviewer: "other-provider"`, that attempt's `snapshot.provider` is none of `pr.changeAuthors`: every provider that authored a commit the pull request holds, not only the author of the newest one. A fix pushed by another provider never makes the first provider independent of its own work. A commit the user supplied constrains nobody. When every provider is an author, or an author is unknown, no agent review counts and none is started: the pull request needs the user (`review-blocked`), or the "any agent" setting. No provider reviews its own work.
2. **Dedicated review.** A done task with `reviewTarget {taskId, n, headSha === pr.changeSha}` whose `code_reviewer` attempt completed with `snapshot.reviewedSha === pr.changeSha`, accepted findings `openFindings === 0`, and the same independence test.
3. Otherwise `ok: false` with the reason.

A service base update changes `headSha` but not `changeSha`. The update is a clean merge the service made and the app verified on GitHub, so the reviewed change is unchanged; how it interacts with the newer base is covered by the required checks on the new head. This replaces patch-id bookkeeping.

### 9.2 Dedicated review task: `D.ensureReview(s, prTask, now)`

Created when coverage fails for a reason a review can cure (no covering review, or the reviewer was not independent) and no review for this `changeSha` exists or is running. It is not created for open findings; those go to repair (§9.3).

- Id `<taskId>-RV<k>` (unique loop). `lifecycle: "ready"`, `holdBeforeStart: false`, `dependsOn: []`, the source task's priority, spec author `"system"`, `reviewTarget` set. It is excluded from `openLeadProposals`.
- Steps from a new built-in template `delivery-review` (in `templates.ts`, editable like any template): `S1 code_reviewer "Review <taskId> for merge into <base> at <sha12>"`, `inputs: []`, `outputs: [{name:"findings", kind:"review-findings"}]`, `independentOf: "writer"`. `validatePipeline`'s "review with no inputs" warning is exempt when `reviewTarget` is set.
- It runs through the normal `dispatchEligible`: worker and provider limits, pause, cancel, model edits and stale-result discard all apply. It has no code change, so it finishes with `integration: not-needed`.
- **Provider and model (`resolveStep`).** Order: step pin → task role override → **independence** → project role default → project default. For `independentOf: "writer"` with `reviewer: "other-provider"` and no pin or override: if the role default's provider equals `pr.changeAuthor`, pick the other provider when it is enabled, with model `"auto"`, `source: "independence"` and reason "Claude: other provider than the writer (Codex)". If it is not enabled, the result is `{ok:false, reason:"Independent review needs Claude, which is not enabled"}`: the step blocks, the PR gets `review-blocked`, and nothing is substituted. A user pin wins; if it is the writer's provider, the gate reports "not independent" and holds. The service never writes a step pin, so a user's pin and the system's choice stay distinguishable.
- A head change cancels review tasks for older `changeSha` values (`cancelTask`), so a late completion is stopped and never counted.
- A dedicated review the user cancels is not "missing": the service starts no other. The pull request shows `review-blocked` ("ask for a review, or merge it yourself") until the user does one of the two.
- Independence is resolved against `pr.changeAuthors`. When no provider is left that wrote none of the pull request, the step does not resolve and nothing is substituted.

Findings are ordinary `review-findings` artifacts: versioned, editable while the review task is open, and already shown to the lead in "Recent outcomes and findings".

### 9.3 Repair into the open PR: `D.createRepair(s, prTask, cause, now)`

Runs automatically only when `policy === "auto"`, `autoRepair` is on and `counters.repairs < 2`. In hold mode the user gets a **Fix this PR** button (`repairPr`).

| Cause | Seeded spec | Workspace |
| --- | --- | --- |
| A required check failed on `headSha` | failing check names and links (no CI log text) | base = `pr.headSha` |
| A review has open findings | the findings summaries | base = `pr.headSha` |
| Conflict with the base | conflicted file names | base = `pr.headSha`, seed `{kind:"merge", ref: base}` |

- Created through `createFollowUp` with `{steps: templateSteps("change"), holdBeforeStart: false, author: "system", dependsOn: [], fields: {deliverInto: {taskId, n, mergeBase}}}`. The id is `<taskId>-F<k>`.
- The `change` template ends its repair loop with reviews, and the coverage rule in §9.1 refuses a final repair that no review saw, so an unreviewed repair can never pass the gate.
- When the repair finishes, §6.2 turns its final commit into `pendingHead {kind:"repair"}`. The push is a fast-forward. `changeSha`, `changeTaskId` and `changeAuthor` move to the repair; coverage is re-evaluated against the repair task's own review, which sees the whole change against the base.

### 9.4 Path policy and worker isolation

- **Workflow files.** A PR whose `workflowHits` is not empty is not pushed until the user runs `allowWorkflowPush` (attention `workflow-change`). The required check runs the PR's own workflow, so an agent could otherwise make it a no-op.
- **Protected paths.** `protectedHits` not empty → the PR is pushed and opened, but auto-merge is off for it (`protected-path`); the user merges.
- **Local worker environments.** If an enabled provider has `workerEnvironment: "local"` and `allowLocalWorkers` is false, auto-merge is unavailable (`local-workers`). Such workers can reach the user's gh keyring or a GitHub MCP server.
- **Worker environment variables.** The Claude and Codex adapters strip `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` (`server/runtimes/claude.ts:592`, `codex.ts:693`), in every mode.
- **Shell.** `SchedulerOptions.workerShell` (true when the Claude adapter runs with `allowShell`) becomes a posture warning. The UI and docs do not claim that only the service can reach GitHub in that setup.

### 9.5 Merge gate: `D.prGate(s, task, nowMs, {byUser}) → {status: "ready" | "waiting" | "blocked", items: {id, label, ok, detail}[]}`

Pure. The UI calls the same function to show the checklist. The items are evaluated for `pr.headSha`.

| # | Item | Rule |
| --- | --- | --- |
| 1 | Policy | `policy === "auto"`, or `mergeRequested.headSha === pr.headSha` (user merge) |
| 2 | Not paused | no `project.hold`, no `userHold`, no `closeRequested` |
| 3 | GitHub reachable | `github.ok`; preflight ≤6 h old |
| 4 | It is our PR | observed `OPEN`, not draft, not cross-repository, `baseRef === pr.base`, no `foreignHead` |
| 5 | Head matches | `observed.headSha === pr.headSha`, no `pendingHead`. Any other head sets the sticky `foreignHead` and attention `foreign-push`; the app never pushes to or merges that PR again |
| 6 | Required checks | every name in `github.requiredChecks` ∪ contexts with `isRequired` is present with conclusion `SUCCESS` and `checksFor === pr.headSha`. At least one required check must exist. Pending or missing → waiting, then blocked at the timeouts in §6.4. `FAILURE`, `ERROR`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `SKIPPED` and `NEUTRAL` → blocked (`checks-failed`) with the name and link |
| 7 | GitHub's own view | `mergeable === "MERGEABLE"` and `mergeStateStatus ∈ {CLEAN, HAS_HOOKS}`. `UNKNOWN` → waiting (never merged). `UNSTABLE` → waiting, then `non-required-failing`. `DIRTY` or `CONFLICTING` → `conflict`. `BEHIND` → base update. `BLOCKED` with item 6 green → `approval-required` or `github-blocked`, with the explanation in §12 |
| 8 | No stop on GitHub | `reviewDecision` is not `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; no label `orchestration:hold` (a kill switch the user can set from any device; the app never creates labels) |
| 9 | Independent review *(auto only)* | `pr.review.ok` and `pr.review.forSha === pr.changeSha` |
| 10 | Paths and workers *(auto only)* | no `protectedHits`; the local-workers rule |
| 11 | Auto-merge available *(auto only)* | `github.autoMergeBlockers` is empty (≥1 required check, no merge queue, merge commits allowed, 0 required approvals); `autoMergePaused` unset; `autoMerges.count < maxAutoMergesPerDay` |
| 12 | Up to date *(auto only)* | with `updateBeforeMerge`, `pr.baseSha === github.base.sha` and the base was fetched ≤2 min ago |
| 13 | Attempts | `counters.mergeAttempts < 2` for this head |

A user merge skips items 9–12 and nothing else. The user replaces the agent review; they never replace GitHub's checks or rules.

Item 12 means the tree the required checks ran on is the tree that lands, which the repository's non-strict rule does not guarantee.

### 9.6 Main is red, and the breaker

- When a landed commit merged by the app gets `mainCheck.state = "failure"`: the item is flagged `main-check-failed`, the lead is woken, the time is appended to `github.mainBreaks`, and `autoMergePaused = {reason: "main is failing after PR #n", sticky: false}`.
- A non-sticky pause clears when a later observation shows the required checks passing on the newest landed commit, or when the user runs `resumeAutoMerge`.
- Two breaks within 24 h make the pause `sticky`: auto behaves as hold until the user runs `resumeAutoMerge`.
- There are no automatic reverts. The flagged item offers **Send back as revert** and **Send back as fix**.

## 10. Post-merge review queue ("Landed")

- **Entry.**
  - PR mode: `reportObservations` sees `MERGED` with a `mergeCommit` → `phase = "merged"` and `landed {via:"pr", by}`. `by` is `"app"` when a merge intent for that head existed, otherwise `"person"` (flagged `merged-without-clean-gate` if the gate was not ready). It records `review`, the required `checks`, and `mainCheck {state:"pending"}`, and cancels open review and repair tasks of that PR.
  - Local mode: `reportDeliveryResult("delivered")` → `landed {via:"local", commit: integration.sha}` for each task it newly marks delivered.
  - Never backfilled. The service's "Merge <branch> into integration" commits are not tasks, so they are never items.
- **Counts** (pure, persistent, not tied to `lastVisitAt`): `D.unreviewedCount(s)` and `D.needsYou(s)` (open PRs with attention or ready in hold mode, flagged landed items, a GitHub problem, a paused auto-merge).
- **What an item shows, summary first:** the task and spec outcome (linked); who merged, where and when; the agent review (provider, model, reviewed SHA, findings, link); checks at merge and the main check after; files changed; flags; notes; follow-ups with live status; **Show changes**; **Open on GitHub**.
- **Diff endpoint.** `GET /api/change?task=<id>` in `server/http.ts`. It accepts a task id only, never a SHA. It reads `landed.commit` (or `baseSha..headSha` of an open PR) from state, runs the diff command in §8, caps the output at 512 KB with `truncated: true`, and never writes. A missing commit gives 404 with the GitHub link; a simulated item gives 404 "simulated". The UI colours lines by their first character with the existing `.diff` CSS; `diffLines` in `src/domain/diff.ts` is not used for code.
- **Actions.** `markLandedReviewed`, `addLandedNote` (optional comment, §8), and `sendBackLanded`:
  - **Fix.** `createFollowUp` with `{steps: templateSteps("bugfix"), holdBeforeStart: <dialog checkbox, default off>, author: "user"}`, then `editSpec` seeded with the note, the findings and any main-check failure. `dependsOn: [origin]` is already satisfied, so it starts from the fresh base.
  - **Revert.** A task `<root>-F<k>` with `revertOf {taskId, commit}` and a new built-in template `revert`: `S1 coder "Complete the prepared revert of <commit12>: resolve any conflicts, keep later work"`, `S2 code_reviewer`, `S3 lead verify`. The first writer's worktree starts from the base with seed `{kind:"revert", commit}` (§6.5). It is reviewed and delivered like any task; in PR mode the same gate applies. A second revert of the same commit is rejected while one is open.
  - Both set `status = "sent-back"` and append to `followUps`.

## 11. Hooks in existing domain code (`src/domain/model.ts`)

| Function | Change |
| --- | --- |
| `waitingOn`, `blockedReason`, `childrenSettled` | the PR-mode dependency predicate (§6.5) |
| `dispatchEligible` | `holdWriters` (§6.5) |
| `resolveStep` | the independence rung (§9.2) |
| `reportIntegration` | event text by target; does not set `delivery.pending` for PR results; stores `sha` |
| `reportDeliveryResult` | skips tasks with `integration.pr`; leaves `integration.delivered` untouched when status and message are unchanged (fixes the repeat notification); calls `D.recordLanded` |
| `setAutonomy`, `applyAutopilot` | §5 |
| `createFollowUp` | §5 |
| `openLeadProposals` | excludes tasks with `reviewTarget` or `deliverInto` |
| `leadDue` | also wakes on a new `attention` of `checks-failed`, `review-findings`, `conflict` or `foreign-push`, a PR closed by a person, a main-check failure, or a new landed note (existing caps) |

`workspaces.integrate()` additionally returns the full `sha`.

## 12. Failure handling

| Situation | Detection | Behaviour |
| --- | --- | --- |
| Conflict when building the head | `merge-tree` exit 1 | `integration.status = "conflict"` with files; existing notification, lead wake and Retry integration |
| Conflict with a moved base | `CONFLICTING`/`DIRTY`, or base-update `merge-tree` exit 1 | attention `conflict`. Auto with `autoRepair`: a seeded-merge repair task. Otherwise Fix this PR, or resolve on GitHub |
| Failing required check | gate item 6 | attention `checks-failed` (one notification per head and check). Auto: repair task, ≤2. A re-run that passes makes the gate ready again |
| Check never reports, or hangs | §6.4 timeouts | `checks-missing` / `checks-timeout`; recovers by itself when the check completes |
| Base branch moves | fetch shows a new base tip | only the merge candidate is updated (≤3); earlier check results are ignored because they are bound to the old head |
| A person pushes to the PR branch | observed head ≠ `headSha` and ≠ `pendingHead.sha`, or `ls-remote` shows divergence | sticky `foreign-push`; the app never pushes or merges it again; running reviews and repairs for it are cancelled. The user merges on GitHub, or closes it and chooses Deliver again |
| A person merges on GitHub | observed `MERGED` without an intent | `landed {by:"person"}`; counted unreviewed like any item |
| A person closes the PR | observed `CLOSED` | `phase = "closed"`, `closedBy`; one notification; lead envelope line; dependents get a blocked reason; Deliver again creates `n+1` |
| Retargeted, draft, hold label, changes requested | observation | attention with the reason; nothing is merged |
| GitHub `BLOCKED` with green required checks | gate item 7 | `approval-required`: "GitHub requires an approval the app cannot give. This may be the ruleset's `require_extra_approval_for_unattributed_changes` applied to commits authored by Orchestrator. Merge on GitHub, approve from another account, or change the ruleset." Never bypassed |
| Merge refused by GitHub | gh error, then observe shows `OPEN` | `merge-rejected` with GitHub's reason after 2 attempts per head |
| Authentication lost | exit 4, HTTP 401, push 403 | `github.problem = auth`, `ok = false`. Every operation stops; phases do not change; each PR shows "Waiting: GitHub sign-in needed (run `gh auth login`)". Preflight retries every 5 → 30 min and recovers by itself |
| gh or git missing or too old; remote not GitHub; no push permission | preflight | `github.problem` with the fix; nothing is pushed; Check again |
| Rate limited | error text, HTTP 403/429, or `rateRemaining` | backoff in §6.4; shown on the Review page |
| Network down, timeout | timeout or DNS error | the outcome is unknown → reconcile, then per-PR backoff. The age of the last observation is shown |
| Restart or crash mid-operation | `pr.op` present with nothing in flight | after timeout + 30 s: publish/push → re-run (it checks `ls-remote` and finds the PR by head and marker first); merge/close → observe: `MERGED` → landed `by:"app"`; still `OPEN` → clear the intent, `mergeAttempts + 1`, re-evaluate; comment → marker search, then post |
| Lease lost mid-operation | `LeaseLostError` or `deactivate` | child killed, result dropped by `gen`; the new holder reconciles as above. Duplicates are prevented by find-by-head (create), `--match-head-commit` plus observe (merge) and the marker (comment) |
| Mode switched | `setDeliveryMode` | PR → off or local: open PRs stay open and are observed read-only until merged or closed; nothing new is pushed, merged or commented; their tasks are skipped by local delivery. Local → PR: preflight warns when the local branch has Orchestrator commits that are not on the remote; the app does not push them |
| Only one provider enabled | independence rung | `review-blocked`: "Independent review needs Codex"; or the user chooses "any agent" |

## 13. Pause, cancel and stale results

- **Project pause** freezes every GitHub write (publish, push, base update, merge, comment, close) and, as today, all dispatch, so no review, repair or revert run starts. Preflight, fetch and observe continue at 5 min. The banner reads "Paused: watching GitHub only; nothing will be pushed, opened, merged or commented."
- **An operation already in flight finishes** and its real outcome is recorded: "Merge of PR #12 was requested at 10:02, before you paused; GitHub merged it at 10:02." The label while it runs is "Merging (already sent to GitHub; cannot be interrupted)".
- **Per-PR hold** (`userHold`) is the same freeze for one PR and survives project resume.
- **Done tasks cannot be cancelled.** A delivery is abandoned with Close PR. Review, repair and revert tasks are ordinary open tasks with the normal controls.
- **Stale results.**
  - An operation result applies only when `result.opId === pr.op.id` and `n` and `headSha` still match.
  - Check results count only for `checksFor === pr.headSha`.
  - Review evidence counts only for `forSha === pr.changeSha`.
  - `mergeRequested` is bound to a head and is cleared by any new head.
  - A repair applies only if it descends from the current head.
  - `MERGED` and `CLOSED` are terminal evidence and always apply.

## 14. Notifications (`src/ui/notifications.ts`)

New `detectEvents` cases compare `prev` and `next` and are keyed on transitions, never on poll or retry times:

| Key | Title | When |
| --- | --- | --- |
| `pr-ready:<task>:<headSha>` | "PR #n is ready for you" | hold policy; gate items 2–8 pass and the review is clean |
| `pr-needs-you:<task>:<code>:<headSha>` | "PR #n needs you: …" | a new `attention` |
| `pr-merged:<task>:<n>` | "PR #n merged; review it when you like" | landed by the app. A per-browser preference can mute this category; flagged items always notify |
| `pr-closed:<task>:<n>` | "PR #n was closed on GitHub" | |
| `main-check:<task>:<commit>` | "Check failed on main after PR #n" | |
| `auto-merge-paused:<since>` | "Automatic merging is paused" | |
| `github:<code>:<since>` | "GitHub delivery stopped: sign-in needed" | a new `github.problem` |

The existing local-delivery event is re-keyed to `deliver:<task>:<status>:<message>`.

Settings copy: "Notifications appear only while an Orchestrator page is open, and merges happen only while the service is running. GitHub is not expected to notify you about pull requests opened with your own account, so the Review badge keeps the count."

## 15. UI changes, per file

Bodies go in new files, and existing files get one mount point each, to keep merges with ORC-009 small.

| File | Change |
| --- | --- |
| `src/ui/Review.tsx` (new) | Route `#/review`. **Needs you**: open PRs with the gate checklist and Merge (sends the head SHA shown), Hold/Release, Auto on/off for this PR, Fix this PR, Allow workflow change, Close, Open on GitHub. **Waiting**: PRs in the merge queue or awaiting checks. **Landed**: unreviewed first; filters Unreviewed / All / Sent back; bulk Mark reviewed; the item card of §10 with Show changes, notes and Send back. The GitHub status banner. |
| `src/ui/Delivery.tsx` (new) | `DeliveryCard` for TaskDetail: desired ("You: hold", "Mode: auto") next to observed ("GitHub: open · check passed on abc123 · seen 40 s ago"), the checklist, the intent line, review evidence, and the landed section. `PrChip` for the board. |
| `src/ui/DeliverySettings.tsx` (new) | Delivery mode (Off / Local branch / GitHub pull requests); PR options (remote, base, "When a PR is ready: hold and notify me / merge automatically after an independent review and passing required checks", reviewer independence, update before merge, automatic repair, protected paths, limits, allow local workers); the read-only **GitHub posture** list with Check again; "N integrated tasks were never delivered: deliver them as PRs". |
| `src/ui/App.tsx` | **Review** tab with badge `needsYou + unreviewed` (tooltip "1 PR needs you · 3 landed, not reviewed"); the route; SimBanner copy for PR mode and for simulated PRs. |
| `src/ui/Board.tsx` | `IntegrationChip` delegates to `PrChip`: "PR #12 waiting for you", "PR #12 checks", "PR #12 merging", "merged · review", "PR closed", "delivered · review"; "(simulated)" when simulated. "PR review" and "PR repair" chips on those tasks. |
| `src/ui/TaskDetail.tsx` | `StatusBanners` mounts `DeliveryCard` for done tasks with `integration.pr` or `landed`; the "waiting for T-012's PR #34" reason. |
| `src/ui/Overview.tsx` | A persistent **Needs you** list (PRs, flagged landed items, GitHub problem, paused auto-merge) and the stat "Landed, not reviewed: N"; PR chips in Latest outcomes; `ModeSummary` names the delivery mode. |
| `src/ui/Settings.tsx` | Mounts `DeliverySettings`. `AutonomyCard` and `InvolvementCard` show the delivery mode and link to it instead of the deliver checkbox. `NotificationsCard` gets the category toggle and the truthful copy. |
| `src/ui/notifications.ts` | §14. |
| `src/ui/common.tsx` | `involvementOf` treats PR mode as a delivery mode; `fetchChange(taskId)` helper. |
| `src/ui/styles.css` | checklist, chips, landed cards. |

Posture items, from preflight (each ok / warn / fail / unverified):

- A pull request is required for the base branch.
- Required checks: the names read from the rules.
- "You can bypass these rules (admin, always). The app never does, but your own account and anything using it could. Consider narrowing the bypass on the ruleset."
- "Repository auto-merge is off. It is not needed: the app merges only after its own gate."
- "`require_extra_approval_for_unattributed_changes` is on. Pull requests whose commits are authored by Orchestrator may need an approval from a second account. Unverified."
- Merge commits allowed; branches deleted on merge; no merge queue.
- "A worker environment set to 'local' may expose your GitHub sign-in or a GitHub MCP server to agents."
- "Claude workers have shell access" (when `workerShell`).
- "This repository is public: PR titles, descriptions and review summaries are public."

## 16. Lead (`server/envelope.ts`)

`buildLeadEnvelope` gains a "Delivery" section: open PRs with attention and one-line reasons, PRs closed by a person, the unreviewed landed count, failed main checks, and the last 5 user notes on landed work (≤300 characters each). The lead may propose tasks under its existing caps. It cannot merge, push, comment, close, send back or mark reviewed. ORC-009 already excludes integration and delivery state from steering.

## 17. Test plan

No test contacts GitHub. All run in vitest with deterministic time (`tick(ms)`), temporary git repositories, a local bare repository as `origin` (`git init --bare`), the scripted adapters in `server/testing/scripted.ts`, and an injected host.

**`src/domain/delivery.test.ts` (pure)**

- Migration 9 → 10 on a format-9 fixture: defaults applied; no `github`, `pr` or `landed` created; seed builds version 10.
- Mode exclusivity: `setDeliveryMode`, `setAutonomy` and `applyAutopilot` never leave both modes on, and never set `merge: "auto"`.
- `prGate` truth table, one case per item in §9.5, including: a required check `SKIPPED`, `NEUTRAL`, missing, pending, or on another SHA; `UNKNOWN`; `UNSTABLE`; `BLOCKED` with green checks; no required checks; a stale observation; a user merge that skips only items 9–12; `requestPrMerge` with a stale SHA rejected and cleared by a new head.
- `reviewCoverage`: Codex writes and Claude reviews clean → ok; same provider → not independent; the confirmed exhausted repair loop (findings open every round) → "no review saw the final change"; user cleared findings → ok and flagged; only one provider enabled → blocked, then ok under "any agent"; a dedicated review for an older `changeSha` does not count.
- Independence rung in `resolveStep`: other provider chosen with `source: "independence"`; a user pin wins and is reported not independent; a disabled provider blocks without substitution.
- `nextPrOp`: order; single candidate, oldest first; a blocked candidate is skipped; pause allows only preflight, fetch and observe; 2 s spacing and hourly budget; backoff; interrupted intents reconcile only after the grace time; merge needs an observation ≤15 s old.
- `beginPrOp` refuses when a hold or a pause landed after planning.
- Stale guards: wrong `opId`, `n` or `headSha` ignored; `MERGED` and `CLOSED` always applied.
- Dependencies: a dependent waits for the prerequisite's merge and the following fetch; a closed PR gives a blocked reason; `waitForChildren` uses the same rule.
- Landed: created only from `MERGED` with a merge commit; `by` follows the intent; local mode creates one per newly delivered task; `markVisited` never changes `status`; send-back links both ways; a second revert is rejected.
- `createFollowUp`: a follow-up of a follow-up gets a new id; no `-iN` or `-cN` steps; `holdBeforeStart` honoured.
- `detectEvents`: repeated identical observations produce no events; each transition produces exactly one; identical local delivery retries produce none.
- Main red: one failure pauses auto-merge and clears on a later green commit; two in 24 h need `resumeAutoMerge`.

**`server/github.test.ts` (adapter contract, fake `gh` script)**

- No invocation contains `--admin`, `--auto`, `-d`, `--delete-branch` or `--force`; no `api` call targets a merge endpoint; the guard throws before spawning when asked to.
- Every call has `-R` or an explicit repo path, runs from the neutral cwd and sends bodies on stdin.
- The environment has the prompts disabled and no `GH_DEBUG` or `GIT_TRACE*`. A fake `GH_TOKEN=ghp_…` echoed on stderr is redacted; messages are ≤300 characters.
- Parsing: PR URL → number; GraphQL rollup per alias with `isRequired`; "no checks reported" → pending.
- Errors: exit 4 → `auth`; rate-limit text → `rate-limit`; a hung process is killed at the timeout → `timeout`.
- Version floors → `gh-old`, `git-old`.

**`server/prdelivery.test.ts` (end to end: temp repo, bare `origin`, `FakeGitHub`, scripted adapters)**

1. **Hold mode.** The head pushed is exactly the final commit, under `orchestration/<pid>/pr/<task>-1`; exactly one PR with the marker; one "ready" event after checks pass; `requestPrMerge` merges with the right `--match-head-commit`; landed unreviewed; the badge goes 1 → 0 on `markLandedReviewed`.
2. **Auto mode.** No person involved; exactly one merge; the merge is recorded only after observe; the main check is watched.
3. **Same-provider reviewer.** A dedicated review task is created and resolved to the other provider with the diff in its envelope; clean → merge.
4. **Exhausted repair loop.** No merge; a dedicated review runs.
5. **Base moves.** A commit is pushed to the bare `main`; the candidate gets a two-parent Orchestrator merge commit pushed as a fast-forward; checks run on the new head; the review is not repeated; merge. The main tree equals the tree the checks ran on.
6. **Sibling conflict.** Auto: a seeded-merge repair resolves it, is pushed onto the same PR and merges. Leftover markers are refused.
7. **Failing check.** Auto: a repair task pushes onto the same PR; a third failure needs the user.
8. **Foreign push** to the PR branch in the bare repository: sticky hold; no push or merge afterwards.
9. **Foreign commits.** The writer base contains an unpushed user commit: nothing is pushed; the integration shows a conflict naming the author.
10. **Workflow change.** Not pushed until `allowWorkflowPush`; then pushed but held as protected.
11. **Merged or closed by a person.** Landed `by: "person"`; closed → `redeliver` makes `-2`.
12. **Pause.** A project pause during each phase stops writes while observes continue. A merge already in flight (a delayed fake) is recorded truthfully. A `userHold` survives resume.
13. **Crash windows.** A new scheduler on the same database after push, create, merge and comment: exactly one branch, one PR, one merge and one marker comment.
14. **Lease loss.** Two schedulers on one store; the lease expires during a delayed create; the late result is not written; exactly one PR.
15. **Authentication lost.** One notification; no retry storm over 30 simulated minutes; recovery without a command.
16. **`BLOCKED` with green checks** → `approval-required`; `--admin` never appears in the log.
17. **Revert.** Send back → the first writer's worktree already holds the revert → review → PR → merge; the main tree equals the tree before the original merge.
18. **Local mode.** The existing delivery-safety tests (H1–H4, M1) still pass; each delivered task gets a landed item; `GET /api/change?task=` returns `M^1..M`, is capped, returns 404 for an unknown id, and ignores a `sha` parameter.
19. **Fake runtime.** The whole flow on `SimulatedGitHub` with a spy on `child_process`: zero spawns; every record `simulated`.
20. **Dependents.** A dependent task dispatches only after its prerequisite's PR merged and the base was fetched; its worktree contains the prerequisite's code.

**Existing suites** stay green: `autopilot.test.ts`, `teamloop.test.ts`, `fanout.test.ts`, `realmode.test.ts`, `service.test.ts`, `model.test.ts`. Then `npm run typecheck`, `npm test`, `npm run build`.

**Mutation checks.** Reverting each of these makes a test fail: the authorship guard; the `SKIPPED`-is-not-a-pass rule; the `UNKNOWN` rule; the intent-before-side-effect check; the `opId` guard; the coverage rule for the exhausted loop; the dependency rule; the forbidden-flag guard; the notification keys.

**Real GitHub (only with the user's consent, never against `erickb336/orchestrator`, formerly `erickb336/orchestration`).** `scripts/pr-sandbox-check.mjs` is a dry run by default and needs `--yes --repo <sandbox>`. It saves commands and redacted outputs under `evidence/ORC-008/` and records: (a) preflight posture; (b) hold mode end to end; (c) auto mode with a slow check, including what `mergeStateStatus` a bypass actor sees while the check is pending and that a manual push is rejected by `--match-head-commit`; (d) whether the unattributed-changes rule blocks Orchestrator-authored commits; (e) a comment on a merged PR and its marker reconcile; (f) a revert delivered as a PR; (g) a restart during a merge; (h) a mixed-provider run, Codex writing with Claude reviewing and the reverse.

## 18. Build order

Three sequential steps on `pr-delivery`. Each is one implementation followed by an independent review from the other provider, and each leaves the suite green.

**Step 1: foundations and the review-later queue for local delivery.** No code that writes to GitHub.

- `src/domain/types.ts`, `src/domain/delivery.ts` (new: landed functions, counts, `setDeliveryMode`, defaults), `src/domain/commands.ts`, `src/domain/seed.ts`, `src/domain/templates.ts` (`revert`), `server/store.ts` (migration).
- `src/domain/model.ts`: `createFollowUp` fixes; `reportDeliveryResult` and `reportIntegration` changes; `setAutonomy`/`applyAutopilot` exclusivity; `resetDeliveryBaseline`.
- `server/workspaces.ts`: `integrate()` returns `sha`; seeds; marker guard; `changeDiff`.
- `server/scheduler.ts`: seed and revert base in `launch()`. `server/http.ts`: `GET /api/change`.
- `server/redact.ts` (new), `server/runtimes/claude.ts`, `server/runtimes/codex.ts`: token variables stripped from workers.
- UI: `Review.tsx` (Landed), `Delivery.tsx` (landed section), `App.tsx` tab and badge, `notifications.ts` re-key, `Overview.tsx` stat.
- Tests: `src/domain/delivery.test.ts` (landed, follow-ups, migration, notifications), scenarios 17 (local) and 18.

**Step 2: PR delivery, hold and notify.**

- `server/github.ts`, `server/prdelivery.ts`, `server/testing/fakeGitHub.ts`, `server/testing/fake-gh.mjs` (all new).
- `server/workspaces.ts`: `runAsync`, `fetchBase`, `lsRemote`, `pushHead`, `preparePrHead`.
- `server/scheduler.ts`: options, `pr.tick`, PR-mode `integrateNext`, writer base, `holdWriters`, `killAll`. `server/app.ts`: wiring. `server/http.ts`: sample guard.
- `src/domain/delivery.ts`: `nextPrOp`, `beginPrOp`, `reportPrOp`, `reportObservations`, `prGate` items 1–8 and 13, hold, merge request, close, redeliver, notes and comments, preflight and posture. `src/domain/model.ts`: dependency predicate, `holdWriters`.
- UI: `DeliverySettings.tsx`, `Delivery.tsx` card and chips, `Review.tsx` Needs you, `Board.tsx`, `TaskDetail.tsx`, `Settings.tsx`, `Overview.tsx`, notifications.
- Tests: `server/github.test.ts`; scenarios 1, 8–16, 19, 20.

**Step 3: independent review and automatic merge.**

- `src/domain/delivery.ts`: `reviewCoverage`, `ensureReview`, `createRepair`, gate items 9–12, the merge candidate, base update, main-red pause and breaker. `src/domain/model.ts`: independence rung, `openLeadProposals`, `leadDue`. `src/domain/templates.ts`: `delivery-review`. `src/domain/pipeline.ts`: warning exemption.
- `server/prdelivery.ts`: base update. `server/scheduler.ts` and `server/envelope.ts`: `changeUnderReview`, `reviewedSha`, the lead's Delivery section.
- UI: auto controls, review evidence, merge-queue position, paused auto-merge.
- `scripts/pr-sandbox-check.mjs`; README and PROJECT_SPEC notes.
- Tests: scenarios 2–7, the coverage and gate tables, mutation checks.

Hand-over to ORC-009: it renumbers its migration to 10 → 11 and rebases onto `types.ts`, `model.ts`, `store.ts`, `seed.ts` and `Settings.tsx`. ORC-008 adds nothing to `Autonomy` and nothing to the lead's reply contract.

Estimated effort: 12 to 15 working days (about 4, 5 and 4, plus the sandbox run).

## 19. Must-fix coverage

J1 = first judge's list (0–27), J2 = second judge's (0–16).

| Must-fix | Where |
| --- | --- |
| Never `--admin`, `--auto`, `--force`, `-d`; no direct merge endpoint; one merge command (J1-0, J2-8) | I1, I5, §8, contract tests |
| App verifies required checks from the rules on the exact head; never on `UNKNOWN` (J1-1, J2-0) | §9.5 items 6, 7 |
| `SKIPPED`, `NEUTRAL`, missing, pending are not passes; bounded timeouts become visible holds (J1-2, J2-0) | §9.5 item 6, §6.4 |
| No auto mode without required checks; no "merge with no checks" (J1-3, J2-0) | item 11 |
| Merged, posted, closed only from observed state (J1-4, J2-6) | I7, §10 |
| Intent before side effect; reconcile before retry, after a grace time; drop late results (J1-5, J2-4, J2-7) | §6.3, §6.4 rule 3, §12 |
| Never push foreign commits; namespace; private fetch refs; writers only from the fetched base (J1-6, J2-2) | I2, I3, §6.2, §6.5 |
| Dependents wait for the prerequisite's merge (J1-7, J2-3) | §6.5 |
| A reused pipeline review must prove coverage; exhausted loop fails (J1-8) | §9.1 |
| Never substitute a reviewer provider; record provider, model and SHA (J1-9) | §9.2 |
| Evidence bound to a head SHA; user merge carries the SHA seen (J1-10, J2-5) | §13, `requestPrMerge` |
| Foreign push is a sticky hold (J1-11) | item 5, §12 |
| Pause freezes every write and dispatch; reads continue; in-flight merge labelled (J1-12, J2-14) | §13 |
| Network calls async, timed out, single-flight, killed on deactivate (J1-13) | §6.3 |
| Credentials; redaction; strip debug variables; strip tokens from workers; warn about MCP and shell (J1-14, J2-9) | I6, §8, §9.4 |
| Only the service runs gh or push; not claimed where workers could (J1-15, J2-9) | §9.4 |
| Opt-in; sample and fake never contact GitHub; simulated labelled; enabling runs only preflight (J1-16, J2-16) | §5, §6.3, §7 |
| No preset turns on publishing, auto-merge or reverts (J1-17) | `applyAutopilot`, §9.6 |
| No commits under the user's identity (J1-18) | not offered in r1 |
| Unattributed-changes rule: detect, hold, never bypass, no claim before sandbox evidence (J1-19, J2-12) | §12, §17 |
| Queue never blocks; reviewed only by command; persistent counts (J1-20, J2-13) | I9, §10 |
| No backfill; no service merge commits as items; full SHAs (J1-21, J2-6) | §3, §10 |
| Notification keys on transitions; fix the 60 s repeat (J1-22, J2-13) | §14, §11 |
| Notes posted only per note, off by default, marker-deduplicated; agent reviews are labelled automated (J1-23) | §8 |
| `createFollowUp` fixes (J1-24, J2-15) | §5 |
| Diff endpoint by task id, capped, no LCS (J1-25) | §10 |
| Every loop bounded (J1-26) | §6.4 |
| UI says merges and notifications need the service and a page (J1-27) | §14 |
| Protect the gate's own inputs (J2-1) | §9.4 |
| Automatic reverts (J2-10) | not offered |
| Mode switches cannot double-deliver or strand state (J2-11) | §6.2, §12 |

## 20. Deviations from the judges

- **The judges split on the winner.** The design takes the safety-first gate and invariants (highest total score) on the simplicity-first skeleton (judge 1's winner), which is where both graft lists point.
- **Service-made revert without an agent (judge 1, graft 5): not taken.** The revert is prepared by the service in the writer's worktree and completed by a coder step, then reviewed. This avoids a service-executed step kind and service-completed attempts. Reverts are rare and started by the user.
- **Patch-id carry-over (judge 2, graft 2): replaced** by the `changeSha`/`headSha` split, which has the same effect with no extra bookkeeping.
- **Queue for PRs the app did not open (judge 2, graft 10, "consider"): not in r1.** Every item maps to a task. It is an open question for the user (§22).
- **Repairs push onto the same PR.** Judge 1 allowed either that or close-and-supersede.
- **No CI log text in envelopes.** Repair specs get check names and links only, because logs are untrusted input.
- **Blocking gh and git push in the worker tool guard (judge 2, must-fix 9, which allows "block, refuse or warn"):** auto-merge is refused while a provider runs with a local worker environment unless the user allows it, and shell access is a posture warning.
- **Adopting a head pushed by a person (Design 1): not in r1.** The PR stays held.

## 21. Open risks

1. **`require_extra_approval_for_unattributed_changes`.** It may keep every Orchestrator-authored PR `BLOCKED` with green checks. If so, auto-merge cannot work on that repository until the user changes the rule. Unverified.
2. **The user's account bypasses the ruleset ("always").** For merges the app makes, its own gate is the only barrier, and gh does not refuse an `UNKNOWN` state. What `mergeStateStatus` a bypass actor sees while a check is pending is unverified.
3. **The review is advisory evidence.** `openFindings` is self-reported; diffs over 60 KB are truncated; PR content could mislead a reviewer. Required checks, protected paths, the daily cap, the main check and the queue are the independent layers.
4. **Agents can weaken the checks that gate them** through files outside the default protected paths (lockfiles, test helpers). The list is editable.
5. **Throughput.** One merge per check run while `updateBeforeMerge` is on.
6. **Async operations are new to a synchronous scheduler.** The race tests (scenarios 12–14) carry this.
7. **Behaviour changes to existing code:** `createFollowUp`, `reportDeliveryResult`, `waitingOn`. Existing tests may need updates.
8. **`waitForChildren` in PR mode** uses the dependency rule; the fan-out code path (`childrenSettled`, model.ts:713) needs care, and a Goal parent now waits for its children's merges.
9. **Public text.** PR titles, bodies and optional comments are published under the user's account; `redact()` is best effort.
10. **gh behaviour differs between versions.** JSON only, version floors, the contract tests and the sandbox run limit this.
11. **Orphaned child after a hard crash** can finish a side effect late. The grace time plus reconcile keeps the state truthful; a duplicate comment remains possible in a narrow window.
12. **Closed PR branches accumulate** on the remote; private refs keep objects in the user's repository.
13. **Notifications need an open page, and merging needs a running service.** A held PR can sit unseen; only the badge and the lead's envelope surface it.
14. **Revert conflicts** are resolved by an agent, which could drop later work. Review, checks and the marker guard reduce this.

## 22. What needs the user

The GitHub reader found these facts about `erickb336/orchestrator` (then named `erickb336/orchestration`; read-only, 2026-09-30). The managed repository may differ; preflight reads each repository's own rules.

| Fact | What it means | Action |
| --- | --- | --- |
| "allow_auto_merge is FALSE" | GitHub's native auto-merge is off | **None.** The app does not use it. Leave it off |
| Ruleset 24227602 "Protect main": "required_status_checks: \"check\", non-strict, not pinned to any app" | One required check exists, so auto mode is available. Non-strict is fine: the app updates the candidate itself | None |
| "pull_request: 0 required approvals; require_extra_approval_for_unattributed_changes is TRUE" | Orchestrator commits use `orchestration@localhost`, which is linked to no GitHub account. PRs may need an approval from a second account. Unverified | If the sandbox run shows PRs stuck, **the user decides**: turn that ruleset option off, or merge held PRs by hand. The app cannot and will not change it |
| "RepositoryRole admin bypass with bypass_mode \"always\", and current_user_can_bypass is \"always\"" | The user's account can merge past the required check. The app never does | **Recommended:** narrow or remove the bypass. Optional |
| "delete_branch_on_merge is true"; merge, squash and rebase all allowed | The app needs merge commits allowed and handles deleted branches | Keep merge commits allowed |
| "gh is logged in as erickb336 with the token in the keyring … scopes gist, read:org, repo and workflow"; "git pushes to github.com already authenticate through `gh auth git-credential`" | No credential setup is needed | If sign-in lapses: `gh auth login` in a terminal |
| "Task branches under orchestration/... have zero rules" | The app can push its PR branches | None |

Decisions and consent:

1. **Consent and a throwaway repository** for the real-GitHub evidence run (§17). Until it passes, the feature is labelled "not verified against GitHub".
2. **Turning it on.** PR mode and automatic merging are separate, explicit choices in Settings. No preset turns them on.
3. **Should the queue also list PRs merged into `main` that Orchestrator did not open** (for example PR #1)? Not in r1.
4. **Which repository** this is first used on, so its rules can be checked with a read-only preflight.
