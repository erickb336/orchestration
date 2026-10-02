# ORC-029 pass 2: the domain behind the vision studio

**What this is.** The design for pass 2 of ORC-029: the state, commands and rules behind the screens the owner approved in pass 1. It is pure domain (`src/domain`) plus the store migration, with no runtime or UI work; passes 3 to 6 build on it.

**Where it fits.** The spec is `docs/tasks/ORC-029.md` (r5). The approved screens are `docs/design/ORC-029-pass1-prototype.html`. The owner decided on 2026-10-01 that the building budget is **estimated in dollars** at each provider's published API prices, pinned and dated, and labelled as an estimate for subscription runs.

## Units, in order

Each unit is one commit with its tests, verified before the next starts (`sequence-verifiable-units`).

| Unit | Contents | Depends on |
| --- | --- | --- |
| 2a | Prices, estimated spend, budgets and the factory's budget stop | — |
| 2b | The stage boundary: one way in, the owner-only start with its record, factory settings set at the start, device scope, migration 18 → 19 | — |
| 2c | The studio: rounds, artifacts, feedback, PE verdicts, probes, the blueprint and change orders | 2b (migration) |
| 2d | The PE as a decision route on Autopilot, within budget | 2a, 2c |
| 2e | PE review of new work in the factory: the domain hooks (owner, r6) | 2d |

## 2a. Prices, spend and budgets

- **`src/domain/prices.json`**, pinned. One entry per model id pattern:
  - `provider` and `model`;
  - `inputPerMTok` and `outputPerMTok`, plus a cached-input price where the provider publishes one;
  - `source` (the URL of the provider's pricing page) and `checked` (a date).

  The prices are taken from the providers' published pages, never guessed. A test checks every entry has a source and a date.
- **`estimateUsd(attempt, prices)`**, a pure function:
  - It uses the runtime's reported `costUsd` when there is one (Claude). That is still labelled an estimate on a subscription, since it is not billed.
  - Otherwise it prices the tokens.
  - It returns `{ usd, basis: "reported" | "priced" | "unknown", estimated: boolean }`, where `unknown` carries a reason: `no-price` (the model is not in the price list) or `no-usage` (the run recorded none).
  - An unknown cost counts as unknown, never as zero. The one exception is a run that never started (no session, no model, no tokens), which is a known $0.
- **`Project.budgets`**: `{ buildingUsd: number | null; maintenanceUsdPerMonth: number | null }`. Null means not set yet; the lead asks for it in Vision.
- **`buildingSpend(state)`**: the sum over the project's attempts since its first Vision round, probes and stopped runs included, with the runs whose cost is unknown.
- **The budget stop:**
  - When `buildingUsd` is set and the spend reaches it, dispatch starts nothing new. Running work finishes.
  - A Needs-you item says "The building budget is reached: $X of $Y", listing the runs with no recorded cost, if there are any.
  - The owner raises the budget (`setBudgets`) or chooses to continue once (`continuePastBudget`, recorded).
  - Tests: dispatch stops at the budget, runs with an unknown cost are reported, and raising the budget resumes.
- **While a budget is set and any run has an unknown cost,** a Needs-you item says the budget cannot count those runs and names the models (review finding 1).

## 2b. The stage boundary

- **Identifiers keep their names:** `stage: "shaping" | "building"`. The UI words are Vision and Factory (pass 6).
- **One way in.**
  - `initProject` always starts in shaping. Its `stage` argument is removed (subtract).
  - Seeds and test fixtures may still construct building projects directly; they are not a way in.
- **`Project.devices`**: `("desktop" | "mobile" | "terminal")[]`, set at the start of the project (`setDevices`) and changeable during Vision. It defaults to desktop and mobile.
- **`startFactory`**, the owner's command and the only transition from shaping to building. It replaces `startBuilding`. Its arguments:
  - `agreed: true`;
  - `blueprintRev` (compare-and-set: refused if the blueprint changed since the pre-flight was shown);
  - `settings`: autonomy mode, who merges, the pause points;
  - `acceptOpen`: the open items the owner accepts.

  It writes a **`FactoryStart` record** to `Project.factoryStarts[]`:
  - `at`, `by: "user"`, `blueprintRev`, `settings`, `openItems`;
  - the pre-flight's budget estimates.

  It applies the settings through the existing setters: the autonomy preset, `triage.askUserBy`, the pull-request delivery mode, the hold before start.
- **Pause points (settings):**
  - `tradeoffs: "pe" | "user"` (maps to `triage.askUserBy`, which gains `"pe"`);
  - `changeOrders: "lead" | "user"`;
  - `startEachTask: boolean` (new tasks wait for a go-ahead);
  - `merge: "user" | "auto"`.

  The budget stop is always on.
- **Nothing else starts the factory.** Tests prove each of these cannot:
  - no steering change kind, lead output field or scheduler path reaches `startFactory`;
  - the lead's envelope never offers it;
  - Autopilot, a timeout and a probe cannot.

  `startFactory` lives in one domain function, called only from the command table.
- **`startVision`** replaces `startShaping` (Back to vision): nothing running stops, and nothing new starts.
- **Migration 18 → 19:**
  - existing projects keep their stage, and building ones need no start record (they started before ORC-029);
  - `devices` defaults from nothing to `["desktop"]`;
  - `budgets` defaults to nulls;
  - empty studio state and an empty blueprint;
  - with a migration test.

## 2c. The studio

New module `src/domain/studio/` with its own types file, so it rarely conflicts with other work.

- **`Round`**:
  - `n` (0 is what the owner brought);
  - `focus: "material" | "experience" | "data" | "flows"`;
  - `openedAt`, `closedAt?`, `leadRunId?`, `summary`.
- **`StudioArtifact`**:
  - `id`, `round`, `version`, `supersedes?`;
  - `kind: "screen" | "terminal-demo" | "tui" | "contract" | "flow" | "material" | "evidence"`;
  - `title`, `variants: { id, label }[]`;
  - `files: { path, sha256 }[]`, relative to the project's studio workspace (pass 3);
  - `devices`;
  - `madeBy: { role, provider, model, attemptId }`.

  Files are provider-neutral. A revision is a new artifact version that carries the owner's open pins.
- **`Feedback`**, the owner's only:
  - `artifactId`, `version`, `mark: "keep" | "change" | "drop" | null`, `pickedVariant?`;
  - `pins: { x, y, variant?, text }[]`, `note`, `at`.
- **`PeVerdict`**:
  - `artifactId`, `version`, `variant?`, `pass` (1–3);
  - `verdict: "feasible" | "feasible-if" | "not-feasible"`, `reasons`, `change?`;
  - `budget?: { buildUsd?: [lo, hi]; maintenanceUsdPerMonth?: [lo, hi]; basis }`;
  - `overruled?: { at, why }` (the owner only).

  **The loop rule:** an artifact reaches the owner only when every variant is feasible or feasible-if, or after three passes with the open objections shown. An objection is never dropped.
- **`Probe`**:
  - `id`, `askedBy: "pe"`, `question`;
  - `status: "queued" | "running" | "done" | "failed"`;
  - `attemptId?`, `result?` (an evidence artifact id).

  Its spend counts in the building budget.
- **The blueprint:**
  - `Blueprint.revisions: { rev, at, visionRev, items: BlueprintItem[] }[]`;
  - `BlueprintItem`: `{ id, kind, title, artifactId, version, status: "approved" | "open" }`.
  - `approveArtifact` and `approveRound` are owner commands that each make a new revision. An open item stays listed for the pre-flight.
- **Change orders:**
  - A new blueprint revision while building creates a `ChangeOrder`: `{ rev, changedItems, affectedTasks, status }`.
  - Affected tasks are those whose spec cites a changed item, through a new optional spec field `blueprintRefs`.
  - With `changeOrders: "user"`, it waits under Needs you. Otherwise the lead proposes the updates through steering.

### 2c as built (7eb56a5, merged in 0fdc0d3)

Decisions the implementer made where the design was open:

- **The start checks two tokens:** `blueprintRev` and `visionRev`. A vision edit makes no blueprint revision, so the blueprint alone would have dropped the existing guard. The start record keeps both.
- **The change-order choice** is a flat `Project.changeOrders: "lead" | "user"`, not a copy of every pause point. The other pause points already live in their own settings. Format 19 defaults it to `"lead"`.
- **PE passes count per round:** a new round starts again at pass 1. A pass judges every variant, and after three passes a further revision in that round is refused.
- **The owner acts on the newest version only.** Approving a variant with an objection that has not been overruled is refused, so every overrule is explicit. Approving a round never downgrades an item.
- **Material and probe evidence** are not held back for PE review.
- **Ids:** an `id` names an artifact across its versions, and `supersedes` hands over a blueprint item.
- **Pins** are fractions (0–1) of the artifact's size.
- **Service-only commands** (refused over HTTP): `openRound`, `closeRound`, `addStudioArtifact`, `addPeVerdicts`, `addProbe`, `setProbeStatus`.
- **Not yet:** resolving a change order (pass 5), and counting running probes as pre-flight open items (2e).

## 2d. The PE as a decision route

- **The route:** `triage.askUserBy` gains `"pe"`. The Autopilot preset sets it; Check-in and Manual set `"user"`.
- **A PE decision** records `decidedBy: "pe"` with its reasons and its budget effect. The owner can reverse it, as with the lead's decisions today.
- **Never past a budget.** A PE decision whose stated cost would take the building spend past the budget, or the maintenance estimate past its budget, is turned into a user decision and listed under Needs you, even on Autopilot.
- **Who runs it:** the PE's decision runs come in pass 4. Until then, a `"pe"` route decides through the lead's decision runs with the PE's brief, which is labelled.

## 2e. PE review of new work in the factory (owner, r6)

The domain hooks only; the runs and flow changes come in pass 5.

- **A PE review state:** lead proposals and breakdown items carry `peReview: "pending" | "agreed" | "objected"`, with the verdict's reasons.
  - Pending holds them from dispatch with the hold reason "waiting for PE review".
  - Agreed releases them under the usual involvement rules.
  - Objected after three rounds goes to Needs you with the objection. The owner can overrule it, recorded.
- **Change-order updates** carry the same state before the lead applies them.
- **The Feature design step** gets a PE review step beside its UX review: a flow-file change in pass 5, tested by the no-finding-dropped rule (ORC-028), which the PE's findings must also satisfy.
- **Code changes are not PE-reviewed.**
- **Tests:** a pending proposal never dispatches; an agreement releases it; an objection goes to Needs you; an overrule is recorded.

## Review of 2a and 2b (2026-10-02)

An independent review found no path to the factory except the owner's `startFactory`. It reported 8 findings:

- **Being fixed in parallel with 2c** (files 2c does not touch):
  - (1) unpriced runs silently disable the budget;
  - (4) stopped runs lose their usage;
  - (5) a continuation past the budget comes back after the amount round-trips;
  - (7) a structural guard on the stage transition where state is written;
  - (8) Codex cached input priced at the full rate.
- **Carried into 2d**, which owns the start code after 2c:
  - (2) `startFactory` rewrites an explicit "the lead" decision route to "the PE". It must keep the owner's choice, or change it only when the owner chooses it in the pre-flight.
  - (3) starting on Autopilot from Manual or Check-in turns on local automatic delivery to `main` while the record says "you merge". Delivery (mode and branch) must be part of the factory settings, and must never change implicitly.
- **Carried to the UI work:** (6) the budget stop has no UI action yet. Settings needs a budget field, and the Needs-you item needs "Raise the budget" and "Continue once", in the pass that builds the pre-flight and the factory screens.
  - The lead also proposes that the "no recorded cost" item can be acknowledged. The owner cannot add a price from the app, so an item that never clears would become noise. Acknowledging it keeps a warning chip on the budget, and the item returns only when a new model without a price appears.
- **Fixed in 4170add** (findings 1, 4, 5, 7, 8): each has a test that failed before its fix. 1,283 tests pass.

## 2d and 2e as built (1b8ef22..2444bc0)

- **Review finding 2:** the start settings carry the decision route exactly (`"lead"`, `"pe"` or `"user"`). Autopilot's planning numbers apply, but not its route.
- **Review finding 3:** the factory settings hold `delivery: { mode: "off" | "local" | "pr", branch?, merge }`, and the start applies exactly that. Contradictions are refused with a clear message: local delivery that the owner merges, automatic merging with delivery off, a branch with delivery off, and a mode without a branch.
- **2d:**
  - A PE call is recorded as `decidedBy: "pe"`, with a `pe` record: the reasons, the stated cost, `by: "lead-run"` and the lead run's id.
  - Until pass 4, the lead's decision runs carry the PE's brief and the budgets, and the UI says so.
  - **Budget:** the high end of a stated range counts. A call with no figure for a set budget goes to the owner, since an unknown cost is never zero.
  - The maintenance estimate is the newest start's estimate plus the standing PE calls.
  - The owner reverses a PE call like a lead call.
  - The Autopilot preset routes to the PE. Check-in and Manual route to the owner. Failing final checks stay with the lead: they are not a trade-off.
- **2e:**
  - `peReview` on tasks and change orders.
  - Pending work is held with "Waiting for PE review". An agreement releases it. The third objection goes to Needs you, and the owner may overrule it (recorded).
  - `recordPeReview` is service-only; `overrulePeReview` is the owner's.
  - A verdict names the spec revision the PE read, and a stale one is refused.
  - **Scope:** lead proposals and the follow-ups that come from findings are reviewed. The roadmap planned in Vision, the owner's own tasks, delivery tasks and code changes are not.
  - Queued and running probes count as pre-flight open items.
  - **Off until pass 5:** `Project.peReviewsNewWork` is off and no command sets it. Nothing runs PE reviews before pass 5, so turning it on would hold every lead proposal.
- **Not yet:**
  - a UI to overrule a PE objection (the command exists);
  - applying a change order's updates (pass 5);
  - real providers (pass 4, then the real-run scenario).

## Review of 2c–2e (2026-10-02)

An independent review found no high-severity defect and confirmed the authority rules:
- only the owner or the service approves the blueprint, records PE verdicts and overrules;
- pending work never dispatches;
- calls past a budget reach the owner;
- both new Needs-you items are present.

All 9 findings were fixed in 11 commits (d41d5cf..09b6fee), each with a regression test that failed first:

1. The lead could drop a standing PE objection, by steering or a breakdown re-run. Now only the owner cancels it.
2. A run with no recorded cost was counted as $0 in the PE's budget check. Now any cost-adding call goes to the owner.
3. The building check was not cumulative. It now adds the PE calls that stand until their work runs.
4. Maintenance the owner accepted dropped out of the estimate. Now a call counts while its outcome stands, whoever took it.
5. An owner's edit to objected work reopens the review.
6. The sample project can no longer start with pull-request delivery.
7. Format-19 databases from this branch are normalized on load.
8. A blueprint change that touches no task makes no change order.
9. Wording and dead code: PE attribution, route-aware pull-request wording, the dead `"pe"` route branch, no-op `setChangeOrders` events, and no verdicts on material or evidence.

**Decisions:**
- While no start estimate exists (pass 6 writes it), a PE call adding maintenance cost goes to the owner: an unknown baseline is not zero.
- The owner's edit does not reopen an overruled objection, and the lead's edit reopens nothing.

**Known limit, for pass 5:** pruning old decisions past the 2,000 limit would drop their PE calls from the maintenance estimate.

## Checks for the whole pass

- **Unit tests per unit**, plus the migration test.
- **The owner-only start**, proven by tests as listed in 2b.
- `npm test`, the typecheck and the build pass.
- `npm run test:integration` passes. The scenario's project is created in Vision and started with `startFactory`, recording an agreement.
- **An independent review of the pass.**
