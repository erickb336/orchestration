// ORC-016 §10: outcome records. A `TaskOutcome` is a snapshot of what a task cost and produced, computed
// by a pure function from data already in the state and written once by the store when the task settles
// (done or cancelled). Nothing here is exported anywhere: the field names follow the OpenTelemetry GenAI
// conventions so that a later export (ORC-017) is a mapping. Delivery results are not copied; they stay
// on `Task.integration` and are derived later.

import * as C from "./checks";
import * as F from "./findings";
import { acceptedOutput } from "./model";
import { FINDING_ACTIONS, isProvider, SEVERITIES, type Artifact, type Attempt, type FindingAction, type ProviderId, type RoleId, type RunTally, type Severity, type State, type StepDef, type Task, type TaskOutcome } from "./types";

const settled = (t: Task) => t.lifecycle === "done" || t.lifecycle === "cancelled";
const ms = (iso: string) => Date.parse(iso);
const duration = (a: Attempt, now: string) => Math.max(0, ms(a.endedAt ?? now) - ms(a.startedAt));
const zero = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** The step definition an attempt ran: from the pipeline revision its snapshot names, else the task's current step. */
function stepOfAttempt(t: Task, a: Attempt): StepDef | undefined {
  return t.pipelineHistory.find((r) => r.rev === a.snapshot.pipelineRev)?.steps.find((d) => d.id === a.stepId) ?? t.steps.find((d) => d.id === a.stepId);
}

/** The role an attempt ran as (`gen_ai.agent.name`): stamped at dispatch; older attempts take the step's role from their pipeline revision. */
function roleOfAttempt(t: Task, a: Attempt): RoleId {
  return a.snapshot.role ?? stepOfAttempt(t, a)?.role ?? (a.snapshot.provider === "service" ? "checks" : "coder");
}

/** The structured findings and check results runs produced for the task (a person's edits do not count). */
const isFindingsArtifact = (x: Artifact) => x.kind === "review-findings" || x.kind === "check-results";

/** The outcome of one task as it stands now. Pure; cheap: one pass over the task's attempts, artifacts and decisions. */
export function computeOutcome(s: State, t: Task, now: string): TaskOutcome {
  const attempts = s.attempts.filter((a) => a.taskId === t.id);
  const artifacts = s.artifacts.filter((a) => a.taskId === t.id);
  const decisions = s.decisions.filter((d) => d.taskId === t.id);
  const byRun = artifacts.filter((x) => x.author !== "user");

  // Runs: one row per (role, runner, model); usage per provider.
  const rows = new Map<string, RunTally>();
  const usage = new Map<ProviderId, TaskOutcome["usage"][number]>();
  let agentMs = 0;
  let firstRunAt: string | undefined;
  for (const a of attempts) {
    if (!firstRunAt || a.startedAt < firstRunAt) firstRunAt = a.startedAt;
    const role = roleOfAttempt(t, a);
    const model = a.actualModel ?? a.snapshot.model;
    const key = `${role}\u0000${a.snapshot.provider}\u0000${model}`;
    const row = rows.get(key) ?? { role, runner: a.snapshot.provider, model, runs: 0, completed: 0, failed: 0, stopped: 0, lost: 0, discarded: 0, ms: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
    rows.set(key, row);
    row.runs++;
    if (a.outcome === "completed" || a.outcome === "failed" || a.outcome === "stopped" || a.outcome === "lost" || a.outcome === "discarded") row[a.outcome]++;
    const d = duration(a, now);
    row.ms += d;
    row.inputTokens += a.usage?.inputTokens ?? 0;
    row.outputTokens += a.usage?.outputTokens ?? 0;
    if (a.usage?.costUsd !== undefined) row.costUsd = (row.costUsd ?? 0) + a.usage.costUsd;
    if (!isProvider(a.snapshot.provider)) continue;
    agentMs += d;
    const u = usage.get(a.snapshot.provider) ?? { provider: a.snapshot.provider, inputTokens: 0, outputTokens: 0, costUsd: null, runsWithoutUsage: 0 };
    usage.set(a.snapshot.provider, u);
    u.inputTokens += a.usage?.inputTokens ?? 0;
    u.outputTokens += a.usage?.outputTokens ?? 0;
    if (a.usage?.costUsd !== undefined) u.costUsd = (u.costUsd ?? 0) + a.usage.costUsd;
    if (a.usage?.inputTokens === undefined && a.usage?.outputTokens === undefined && a.usage?.costUsd === undefined) u.runsWithoutUsage++;
  }

  // Repairs: completed runs of coder steps conditioned on findings, iterations included.
  const repairRounds = attempts.filter((a) => {
    if (a.outcome !== "completed") return false;
    const d = stepOfAttempt(t, a);
    return d?.role === "coder" && !!d.runIf?.length;
  }).length;
  const loop = t.steps.some((st) => st.iterate || st.iteration);
  const iterations = loop ? Math.max(1, ...t.steps.map((st) => st.iteration ?? 1)) : 0;

  // Findings raised by runs, by severity and action; summary-only counts; what the done review and check steps leave open.
  const raised = zero(SEVERITIES);
  const byAction = zero(FINDING_ACTIONS);
  let summaryOnly = 0;
  for (const x of byRun) {
    if (!isFindingsArtifact(x)) continue;
    if (!x.findings) {
      summaryOnly += x.openFindings ?? 0;
      continue;
    }
    for (const f of x.findings) {
      raised[f.severity as Severity] = (raised[f.severity as Severity] ?? 0) + 1;
      byAction[f.action as FindingAction] = (byAction[f.action as FindingAction] ?? 0) + 1;
    }
  }
  // What the last round left open: per review or check step, its latest round only (an earlier round's
  // findings were the next round's work, not what is open at the end). A round is a loop iteration
  // (`-iN`) or a check round after failed final checks (`-rK-checks`, `-rK-review`; steps 2–3 review,
  // finding 5), keyed by the base id and the output kind so a check round's review counts on its own.
  const latestRound = new Map<string, { st: Task["steps"][number]; rank: number }>();
  for (const st of t.steps) {
    if (st.state !== "done") continue;
    const round = /-r(\d+)-[a-z]+$/.exec(st.id);
    const rank = (round ? Number(round[1]) : 0) * 1000 + (st.iteration ?? 1);
    const base = st.id.replace(/(-i\d+|-r\d+-[a-z]+)+$/, "");
    for (const kind of ["review-findings", "check-results"] as const) {
      if (!st.outputs.some((o) => o.kind === kind)) continue;
      const key = `${base}\u0000${kind}`;
      const cur = latestRound.get(key);
      if (!cur || rank >= cur.rank) latestRound.set(key, { st, rank });
    }
  }
  let openAtEnd = 0;
  for (const [key, { st }] of latestRound) {
    const kind = key.slice(key.indexOf("\u0000") + 1);
    for (const o of st.outputs) {
      if (o.kind !== kind) continue;
      const art = acceptedOutput(s, t, st.id, o.name);
      if (art) openAtEnd += F.unresolved(s, art);
    }
  }

  // Decisions, captured now because they are pruned later.
  const dec = { total: decisions.length, byUser: 0, byLead: 0, fix: 0, accept: 0, followUp: 0, superseded: 0, open: 0 };
  for (const d of decisions) {
    if (d.decidedBy === "user") dec.byUser++;
    else if (d.decidedBy === "lead") dec.byLead++;
    if (d.status === "fix") dec.fix++;
    else if (d.status === "accept") dec.accept++;
    else if (d.status === "follow-up") dec.followUp++;
    else if (d.status === "superseded") dec.superseded++;
    else dec.open++;
  }

  // Service check runs and the last blocking Checks step.
  const checkRuns = attempts.filter((a) => a.snapshot.provider === "service");
  const failedRuns = checkRuns.filter((a) => a.outcome === "failed" || byRun.some((x) => x.attemptId === a.id && x.checkRun && !C.allPassed(x.checkRun))).length;
  const finalStep = [...t.steps].reverse().find((st) => st.checks?.onFail === "block");
  const finalArt = finalStep?.state === "done" ? acceptedOutput(s, t, finalStep.id, finalStep.outputs[0]?.name ?? "") : undefined;
  const finalPassed = finalArt?.checkRun ? C.allPassed(finalArt.checkRun) : null;

  // Coverage of code reviews, `not-required` excluded, and the clean reviews run again for a coverage gap. A
  // step's `coverageRetries` is cleared once it completes, so the retries are counted from the attempts the
  // gap failed (`reportCompletion` records each with this note).
  const coverage = { reviews: 0, complete: 0, incomplete: 0, unproven: 0, retries: attempts.filter((a) => a.outcome === "failed" && a.note?.startsWith("Reported no findings but ")).length };
  for (const x of byRun) {
    const state = x.pathCoverage?.state;
    if (!state || state === "not-required") continue;
    coverage.reviews++;
    coverage[state]++;
  }

  // Best-of groups: leaders that run as candidates, their copies, and the groups a person chose.
  const groups = t.steps.filter((st) => st.parallel?.mode === "best-of" && st.copyOf === st.id).map((st) => st.id);
  const chosenByUser = Object.keys(t.bestOfByUser ?? {}).length;

  return {
    v: 1,
    result: t.lifecycle === "cancelled" ? "cancelled" : "done",
    settledAt: now,
    pattern: structuredClone(t.pattern),
    // Revisions after the first that applied a pattern. A task from before patterns, or one built by the internal
    // setPipeline, has no pattern on its first revision, so "all but the first" would undercount (steps 2–3 review, finding 4).
    patternChanges: t.pipelineHistory.filter((r) => r.pattern && r.rev > (t.pipelineHistory[0]?.rev ?? 0)).length,
    runsBeforePattern: attempts.filter((a) => a.snapshot.pipelineRev < t.patternSince).length,
    createdAt: t.createdAt,
    ...(firstRunAt ? { firstRunAt, wallMs: Math.max(0, ms(now) - ms(firstRunAt)) } : {}),
    agentMs,
    runs: [...rows.values()],
    usage: [...usage.values()],
    repair: { rounds: repairRounds, iterations, finalCheckRounds: t.checkRounds ?? 0 },
    findings: { raised, byAction, summaryOnly, openAtEnd },
    decisions: dec,
    checks: { runs: checkRuns.length, failedRuns, finalPassed, acceptedFailing: !!C.acceptedFailingChecks(s, t.id) },
    coverage,
    human: { artifactEdits: artifacts.length - byRun.length, pinnedSteps: t.steps.filter((st) => st.selection).length, candidateChoices: chosenByUser },
    ...(groups.length ? { bestOf: { groups: groups.length, candidates: t.steps.filter((st) => st.copyOf && groups.includes(st.copyOf)).length, chosenByUser } } : {}),
  };
}

/**
 * The store's one capture point (P11): every task that is done or cancelled in `next` and was the same
 * task (id and `createdAt`), still open, in `prev` gets its outcome computed from `next`. A task reopened
 * and settled again has its record replaced. Nothing else is ever captured: tasks already settled when
 * the state was loaded or replaced (migrations, `resetSampleData`, `initProject`) have no open
 * counterpart. Returns `next` itself when there is nothing to record.
 */
export function captureOutcomes(prev: State, next: State, now: string): State {
  const open = new Map<string, Task>();
  for (const t of prev.tasks) if (!settled(t)) open.set(t.id, t);
  const ids = next.tasks.filter((t) => settled(t) && open.get(t.id)?.createdAt === t.createdAt).map((t) => t.id);
  if (!ids.length) return next;
  const s = structuredClone(next);
  for (const id of ids) {
    const t = s.tasks.find((x) => x.id === id)!;
    t.outcome = computeOutcome(s, t, now);
  }
  return s;
}
