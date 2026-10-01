# ORC-018 design: comparing patterns, and trace export

Spec: `docs/tasks/ORC-018.md` r1. Product context: `PRODUCT.md`. Builds on ORC-016 (`TaskOutcome`, `PatternRef`; design §10.3, §10.4 and §19).

Builders follow this document. Anything not settled here is listed in §9, and builders do not invent it.

## 1. Principles

1. **Read what is recorded, never invent.**
   - A measure a row did not report is missing, not zero.
   - Every number shows how many rows it rests on.
2. **No winners.** The page shows medians, spreads and dots. It never ranks, colours a "better" cell, or says a difference matters. With one person's task counts, that would mislead.
3. **Versions are different patterns until you say otherwise.** Group rows by pattern id and hash, and merge versions only on request.
4. **Nothing leaves the computer unless you turn it on,** and what can leave is listed beside the switch.
5. **Open standards and tools.**
   - OTLP/HTTP with protobuf, through the OpenTelemetry JS SDK.
   - The GenAI semantic conventions where they apply, and `orc.*` attributes elsewhere.

## 2. `deliveryOutcome(t)` (`src/domain/outcomes.ts`, pure)

```ts
export interface DeliveryOutcome {
  status: "not-delivered" | "integrated" | "pr-open" | "landed" | "closed" | "not-needed" | "conflict";
  landedAt?: string;
  landedBy?: "app" | "person";
  via?: "pr" | "local";
  /** firstRunAt → landed.at, when both exist. */
  timeToLandedMs?: number;
  sentBack?: "fix" | "revert";
  flags: string[];
}
```

**Where each field comes from:**

- Everything comes from `t.integration` and `t.outcome?.firstRunAt`, following ORC-016 design §10.3.
- `sentBack` is set when `landed.status` is `sent-back`, or `landed.followUps` has a fix or revert. When there are both, `revert` wins.
- A pull request observed as `CLOSED`, and not landed, is `closed`.

**Tests** cover every status, both values of `landedBy`, both kinds of send-back, and a missing `firstRunAt`.

## 3. Comparison data (`src/domain/compare.ts`, pure)

### 3.1 Rows

There is one `CompareRow` per task that has `t.outcome`, but not for:

- tasks owned by the service (review, check and deliver-into tasks);
- tasks whose pattern source is `internal`;
- `legacy` or `custom` pipelines with no hash. These are grouped as "Custom pipelines", but only if any exist.

```ts
interface CompareRow {
  taskId: string; title: string; area: string;
  result: "done" | "cancelled"; settledAt: string;
  pattern: { id: string; name: string; hash: string; source: string; chosenBy: ChosenBy; experimental: boolean };
  /** outcome.patternChanges > 0 || outcome.runsBeforePattern > 0 */
  changedPattern: boolean;
  m: Partial<Record<MeasureId, number>>;   // absent = not reported
  simulated: boolean;                       // the project is the sample (project.sample)
}
```

### 3.2 Measures

A boolean measure is stored as 0 or 1 and shown as a rate.

| MeasureId | Definition (from `TaskOutcome` / `deliveryOutcome`) | Missing when |
| --- | --- | --- |
| `timeToDone` | `wallMs` | no `firstRunAt` |
| `agentTime` | `agentMs` | never |
| `runs` | sum of `runs[].runs` for agent runners (not `service`) | never |
| `inputTokens`, `outputTokens` | sum over `usage[]` | any provider row has `runsWithoutUsage > 0` |
| `cost` | sum of `usage[].costUsd` | any provider row has `costUsd === null`, or `runsWithoutUsage > 0` |
| `repairRounds` | `repair.rounds` | never |
| `findingsRaised` | sum of `findings.raised` (the per-severity detail stays in the row) | never |
| `errorsRaised` | `findings.raised.error` | never |
| `openAtEnd` | `findings.openAtEnd` | never |
| `firstPassChecks` (rate) | `checks.finalPassed === true && repair.rounds === 0` | `checks.finalPassed === null` |
| `failedCheckRuns` | `checks.failedRuns` | `checks.runs === 0` |
| `reviewComplete` (rate) | `coverage.complete / coverage.reviews` | `coverage.reviews === 0` |
| `humanTouches` | `human.artifactEdits + decisions.byUser + human.candidateChoices` | never |
| `landed` (rate) | `delivery.status === "landed"` | `delivery.status` is `not-needed` |
| `sentBack` (rate) | `delivery.sentBack !== undefined` | not landed |
| `timeToLanded` | `delivery.timeToLandedMs` | not landed |

**Labels and units** (`MEASURES` table: id, label, unit, help text, and a default-visible flag):

- Durations show as "4m 12s" or "1h 05m".
- Cost shows as "$0.42".
- Rates show as "7 of 9 (78%)".
- The **default-visible** measures are `timeToDone`, `runs`, `cost` (falling back to `inputTokens` when no row reports cost), `repairRounds`, `openAtEnd`, `firstPassChecks`, `landed` and `sentBack`.

### 3.3 Groups and statistics

- **The group key** is `${pattern.id}@${hash}`. With `mergeVersions`, it is `pattern.id`, and the group lists the hashes it holds and says "mixes N versions".
- **The current version.** The group marks a hash as "current" when it equals `findPattern(state, id)?.hash`.
- **Per measure:** `n` (rows reporting), `of` (rows in the group), `median`, `q1`, `q3`, `min`, `max`.
  - Quantiles use linear interpolation between order statistics (R type 7). Values with `n ≤ 1` have no quantiles.
  - Rates have `n` and `count` (the rows equal to 1) instead.
- **Too few:** a group with `of < 5` gets `tooFew: true`, and a measure with `n < 5` gets the same per cell.
- **Order:** groups are sorted by `of`, descending, then by name.

### 3.4 Filters (`CompareFilter`)

| Filter | Default |
| --- | --- |
| `areas` | all |
| `results` | `["done"]` |
| `chosenBy` | all |
| `from`, `to` | open (on `settledAt`) |
| `includeChanged` | false |
| `mergeVersions` | false |

### 3.5 Exports

- `toCSV(rows, measures)` writes RFC 4180 CSV: quotes doubled, CRLF line ends, a header row.
- Its columns are: `task_id`, `title`, `area`, `result`, `settled_at`, `pattern_id`, `pattern_name`, `pattern_hash`, `pattern_source`, `chosen_by`, `experimental`, `changed_pattern`, `simulated`, then one column per measure (all of them, not only the visible ones), with an empty value when missing.
- `toJSON` writes `{ generatedAt, filter, simulated, rows }`.

## 4. The Compare page (`src/ui/Compare.tsx`, route `#/compare`, a tab between Review and Activity)

Read the `dataviz` skill before writing the dot strips.

- **Head:**
  - the `h1` "Compare patterns";
  - one sentence: "How each pattern's tasks went: medians, spreads and every task as a dot. Small groups are marked; nothing here declares a winner.";
  - in the demo, a neutral banner: "Simulated outcomes, made by the demo to show this page. They say nothing about real patterns."
- **Toolbar:**
  - the filters (§3.4), as compact selects and checkboxes;
  - "Measures…", a popover of checkboxes, kept in `localStorage` under `orc.compare.measures`, with every access in try/catch;
  - "Download CSV" and "Download JSON", built from a Blob in the browser.
- **The table:**
  - **Rows are groups.** The first column has the pattern name (600), the version chip (a short hash, plus "current" or "older"), the source chip, an experiment chip, n, and a "too few to compare" chip in neutral styling.
  - **Each measure cell** has the median in tabular numerals, the q1–q3 spread in small muted text, and a dot strip.
    - The strip is 96 × 14 SVG, with one dot per row on a shared scale per column, across all groups.
    - Dots are `--text` at 55% opacity, with the median as a 2 px tick.
    - A rate cell shows "7 of 9" and a thin bar instead of dots.
  - **A missing cell** shows "—" with the title "No task in this group reported it".
  - **The column header** carries the measure's help text in a `title`, plus a visually hidden description.
- **Selecting groups:**
  - Each row has a checkbox, "Select to compare", with at most two. With two selected, a panel above the table shows them side by side.
  - The panel has one line per visible measure: both medians and spreads, and both dot strips on one shared scale.
  - When either side has `n < 5`, the line says "Too few tasks to compare this".
  - There is no colour for better or worse. The two sides are told apart by position and label only.
- **Opening a group** shows its tasks below the row: id, title (linked), settled date, and the visible measures.
- **Empty state:** "No finished tasks with an outcome yet. Each task records how it went when it finishes or is cancelled; they will appear here, grouped by the pattern they ran."
- **Phones (≤ 700 px):**
  - Groups become cards, each with a definition list of measures (median, spread, dots).
  - The side-by-side panel stacks.
  - The page never scrolls sideways.
- **Tokens and accessibility.**
  - It uses the ORC-017 tokens only; the state hues are not used here, because these are not states.
  - Contrast is at least 4.5:1, focus is visible, every control is keyboard operable, and the SVG strips are `aria-hidden` with numbers in text beside them.

## 5. Trace export

### 5.1 Configuration (domain)

```ts
project.telemetry?: { enabled: boolean; endpoint: string; allowRemote: boolean; enabledAt?: string; rev: number }
```

- **When it is absent,** the export is off. The field is optional, so the state format does not change, as ORC-017 did for its flags.
- **The command** is `setTelemetry({ config, expectedRev })`. It validates:
  - the endpoint is an `http:` or `https:` URL;
  - the endpoint has no credentials in the URL (refused with a reason);
  - a non-loopback host (anything but `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`) needs `allowRemote: true`.
- **`enabledAt`** is set when the export goes from off to on. Only tasks that settle after `enabledAt` are exported automatically.

### 5.2 Bookkeeping (server, outside the state)

The store gains a table:

```sql
CREATE TABLE IF NOT EXISTS trace_exports (
  task_id TEXT NOT NULL, settled_at TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'pending' | 'sent' | 'failed'
  tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER, last_error TEXT, sent_at TEXT,
  PRIMARY KEY (task_id, settled_at)
);
```

- **Unit.** One row per (task, settle). A task that reopens and settles again is a new row.
- **Queueing.** The exporter (`server/telemetry.ts`) runs in the scheduler's loop, on the lease holder only. On each pass it:
  1. queues `pending` rows for tasks whose `outcome.settledAt > enabledAt` and that have no row yet;
  2. sends at most 20 due rows per pass, in one OTLP request per task.
- **Retries.** Failures back off by 1, 5, 15 and 30 minutes. After 6 tries a row is `failed`, with `last_error`. "Retry failed" sets them back to `pending`.
- **Requests over HTTP:**
  - `POST /api/telemetry/backfill` queues every settled task with an outcome that has no row, whatever `enabledAt` says. It needs the export to be on.
  - `POST /api/telemetry/retry` retries the failed rows.
  - Both have the same origin and client-header protections as other POSTs.
- **Status.** `ServiceInfo.telemetry` reports `{ enabled, pending, sent, failed, lastSentAt?, lastError? }`, read from the table.
- **At most once per settle, as far as the app can tell.** A row is marked `sent` in the same tick as the exporter's success. A crash between the send and the mark resends the same trace with the same ids (§5.3), which viewers treat as the same trace.
- **Headers** are read once at start from `OTEL_EXPORTER_OTLP_HEADERS`, using the standard `key=value,key2=value2` form, URL-decoded. They are never logged, stored or shown; the status says only "headers from OTEL_EXPORTER_OTLP_HEADERS: yes or no". A change needs a restart.
- **Timeout:** 10 s per request.

### 5.3 The trace (`buildTaskTrace(state, task, settledAt)`, pure, in `src/domain/trace.ts`)

**It returns plain span records:**

- `{ traceId, spanId, parentSpanId?, name, kind, startTimeUnixNano, endTimeUnixNano, attributes, status }`.
- A small adapter in `server/telemetry.ts` turns them into SDK `ReadableSpan`s for `OTLPTraceExporter` (`@opentelemetry/exporter-trace-otlp-proto`). The adapter must match the SDK v2 `ReadableSpan` shape: `parentSpanContext`, `instrumentationScope`, `resource`.

**IDs are deterministic.**

- `traceId` is the first 32 hex characters of `sha256("orc-trace|" + projectId + "|" + taskId + "|" + settledAt)`.
- `spanId` is the first 16 hex characters of `sha256(traceId + "|" + part)`, where `part` is `task` or the attempt id.

**The resource:**

- `service.name = "orchestrator"`;
- `service.version` from `package.json`;
- `orc.project.id`;
- `orc.simulated = true` for the sample project, and absent otherwise.

**The spans,** following ORC-016 design §10.4. Each attribute name is re-checked against the pinned `@opentelemetry/semantic-conventions` incubating exports, and every difference is recorded in the B1 report.

| Span | Name | Time | Attributes |
| --- | --- | --- | --- |
| Task (root, `INTERNAL`) | `task <id>` | `outcome.createdAt` (or the first attempt's start) → `settledAt` | `orc.task.id`, `orc.task.title`, `orc.task.area`, `orc.task.result`, `orc.pattern.id`, `orc.pattern.name`, `orc.pattern.hash`, `orc.pattern.source`, `orc.pattern.experimental`, `orc.pattern.chosen_by`, `orc.outcome.*` (every number of §3.2 that is present, plus `orc.outcome.findings.<severity>`), `orc.delivery.status`, `orc.delivery.landed_by`, `orc.delivery.sent_back` |
| Agent attempt (`CLIENT`) | `invoke_agent <role>` | `startedAt` → `endedAt` (attempts still active at settle are left out) | `gen_ai.operation.name = "invoke_agent"`, `gen_ai.provider.name` (`anthropic` for claude, `openai` for codex), `gen_ai.request.model`, `gen_ai.response.model` (`actualModel`, when set), `gen_ai.agent.name` (role), `gen_ai.conversation.id` (`sessionId`, when set), `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` (when reported), `orc.cost.usd` (when reported), `orc.step.id`, `orc.attempt.id`, `orc.attempt.outcome`; for `failed` or `lost`, `error.type` = the outcome and span status `ERROR` |
| Check run (`INTERNAL`) | `orc.checks` | `startedAt` → `endedAt` | `orc.step.id`, `orc.attempt.id`, `orc.checks.passed`, `orc.checks.failed`, `orc.checks.sandbox`; status `ERROR` when a check failed |

**Never included:**

- spec text, outcome or approach;
- prompts, envelopes, outputs, artifacts or findings text;
- file paths, repository paths, branch names or commit SHAs;
- the vision;
- user names;
- credentials.

A test asserts the absence of each by searching the serialised attributes for sentinels planted in a fixture's spec, artifact, repository path and vision.

### 5.4 Settings → Telemetry (`src/ui/Settings.tsx` section, `id="telemetry"`)

- **The heading is "Traces".** One sentence follows: "Send each finished task as an OpenTelemetry trace to a viewer you run, such as Phoenix or Langfuse. Off by default."
- **Controls:**
  - "Send traces", a toggle;
  - the endpoint input, with a placeholder `http://localhost:6006/v1/traces`;
  - two example buttons that fill it: "Phoenix (local)" for `http://localhost:6006/v1/traces`, and "Langfuse (local)" for `http://localhost:3000/api/public/otel/v1/traces`.
- **"What is sent"** is a short list taken from §5.3, including "never prompts, outputs, code, paths or credentials".
- **Credentials:** "Headers (for example Langfuse's key) come only from `OTEL_EXPORTER_OTLP_HEADERS` in the shell that starts Orchestrator; they are never stored here." It then says whether that variable is set, as yes or no.
- **A remote endpoint:** the checkbox "Send to <host>: task titles, pattern and model names, timings, token counts and cost leave this computer" must be ticked before Save.
- **Status:** "Sent 41 · waiting 0 · failed 0 · last sent 2m ago", plus the last error. "Send finished tasks (n)" calls the backfill, and "Retry failed" appears when any have failed.

## 6. Done tasks collapse (`src/ui/Board.tsx`)

- **Which tasks collapse:** done tasks whose `outcome?.settledAt ?? updatedAt` is more than 7 days old.
- **In the list view:** they move to a final group, "Done earlier (n)", closed by default, with a button to show them.
- **On the board:** the Done column shows the recent ones, and below them the button "Done earlier (n)".
- **Filters** still apply.
- **What it never hides:** a task that needs you, that has an open pull request, or that is landed and unreviewed.

## 7. Demo outcomes (`src/domain/demo.ts`, B3)

- **The history.** Add 24 earlier tasks, `WT-101` to `WT-124`, settled between 30 and 9 days before `now`, so they collapse under "Done earlier":
  - 10 on "Change";
  - 8 on "Change, reviewed by the other provider";
  - 6 on "Bug fix".
- **Content.** Their titles are plausible for the product. Their attempts are simulated: claude and codex, with role, model, durations and usage. Their outcomes come from `computeOutcome` on that state, never hand-written.
- **Variation** is chosen so the page shows real spread, without implying a verdict:
  - cross-review has slightly longer agent time and fewer open findings at the end, with overlapping spreads;
  - bug fix has a short time to done;
  - one "Change" task was cancelled;
  - one "Bug fix" ran an older version, with a different hash from a recorded `extends` change. That shows version grouping, with `tooFew` on the older version.
- **Costs.** Only claude runs report cost; codex runs report tokens only, as the real adapters do. The cost column therefore shows "n of m reported".
- **Every outcome counts as simulated,** through `project.sample`.
- **Tests.** The existing demo tests keep passing: three starting runs, the held pull request, and the rest. A test checks that the 24 outcomes match `computeOutcome` and that the Compare page's groups have the intended sizes.

## 8. Capture and README (B3)

- **A capture scene, `compare`,** produces `docs/screenshots/compare.png`: the Compare page with two groups selected side by side. It is added to the README's screenshot list and to "Measuring, not guessing".
- **README:**
  - "Measuring, not guessing" changes to present tense for the Compare page and the trace export, and states that both are opt-in or local.
  - A short "Look at traces in Phoenix or Langfuse" section explains how to start each locally (commands checked against their current docs and linked), sets the endpoint in Settings, and gives Langfuse's header through `OTEL_EXPORTER_OTLP_HEADERS`.
  - The Status table gains ORC-018.

## 9. Open decisions (builders do not invent these)

- **Phoenix and protobuf.** If Phoenix rejects OTLP/HTTP protobuf on `/v1/traces`, record it, and do not switch to JSON silently.
- **Convention names.** If the pinned conventions name `gen_ai.provider.name` differently (older releases used `gen_ai.system`), use the pinned name and note it in the report.
- **New dependencies:** `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/resources` and `@opentelemetry/semantic-conventions`, exact-pinned and Apache-2.0. No others.
