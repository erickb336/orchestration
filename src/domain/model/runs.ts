// What the runtime reports about a run: started, activity, stopped, lost, failed or completed. A late result
// from an earlier step revision or an earlier flow is discarded, never integrated. Also the trusted base and
// what the service gave a run before it started.

import * as C from "../checks";
import { coverageOf as pathCoverageOf, gapText, notRequired } from "../coverage";
import { prBaseRef } from "../delivery";
import * as F from "../findings";
import { type Artifact, type Attempt, type Finding, type State } from "../types";
import {
  activeAttempts,
  beforeFlow,
  currentSpec,
  discardEarlierFlow,
  draft,
  event,
  findStep,
  finishTask,
  getTask,
  isActive,
  isSettled,
  nextId,
  settleSendingNotes,
  settleStoppedStep,
  touch,
} from "./core";
import { applyBreakdown, expandIteration } from "./fanout";
import { providerLabel } from "./resolution";

export function reportProgress(state: State, attemptId: string, progress: number): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (a && isActive(a)) a.progress = Math.max(0, Math.min(100, progress));
  return s;
}

/**
 * The runtime acknowledges that a run it was asked to stop has stopped. The usage it reports with the stop is
 * recorded: a paused, revised or cancelled run spent it, and the building budget counts it.
 */
export function acknowledgeStop(state: State, attemptId: string, now: string, run: RunReport = {}): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || a.outcome !== "stopping") return s;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  a.outcome = "stopped";
  a.endedAt = now;
  if (run.usage) a.usage = run.usage;
  a.artifacts.push(`checkpoint: partial work left in ${a.snapshot.workspace}`);
  // A run from before the flow changed settles alone; its step belongs to the new flow.
  const earlier = beforeFlow(t, a);
  if (earlier) a.note = `Stopped on pipeline r${a.snapshot.pipelineRev}, before the flow changed (r${t.flowSince}); its step was not touched`;
  else settleStoppedStep(s, t, st);
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  event(s, now, "runtime", "runtime", `${a.id} acknowledged stop; partial work checkpointed${earlier ? ` (it ran on pipeline r${a.snapshot.pipelineRev}, before the flow changed; its step is untouched)` : ""}`, t.id);
  settleSendingNotes(s, a.id, "the run stopped first", now);
  return s;
}

/**
 * Reconciliation found no live process for an active run (for example after the service restarted).
 * A run that was stopping is treated as stopped; a running one is marked lost. Neither is completed,
 * and the step is requeued (or stays paused under a hold) so the next dispatch starts a fresh attempt.
 */
export function reportRunLost(state: State, attemptId: string, reason: string, now: string): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  const t = getTask(s, a.taskId);
  const wasStopping = a.outcome === "stopping";
  a.outcome = wasStopping ? "stopped" : "lost";
  a.endedAt = now;
  a.note = `${reason}; no result was produced or integrated`;
  a.artifacts.push(`checkpoint: partial work left in ${a.snapshot.workspace}`);
  // A run from before the flow changed settles alone; its step belongs to the new flow.
  const earlier = beforeFlow(t, a);
  if (earlier) a.note += `; it ran on pipeline r${a.snapshot.pipelineRev}, before the flow changed (r${t.flowSince}), so its step was not touched`;
  else settleStoppedStep(s, t, findStep(t, a.stepId));
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  event(s, now, "system", "runtime", `${a.id} ${wasStopping ? "confirmed stopped" : "lost"} during reconciliation: ${reason}${earlier ? " (from before the flow changed; its step is untouched)" : ""}`, t.id);
  settleSendingNotes(s, a.id, "the run was lost before the runtime answered", now);
  return s;
}

/** The runtime accepted the run. */
export function reportRunStarted(state: State, attemptId: string, info: { sessionId?: string; actualModel?: string }): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  if (info.sessionId) a.sessionId = info.sessionId;
  if (info.actualModel) a.actualModel = info.actualModel;
  return s;
}

/** A meaningful milestone from the runtime. Updates the run's activity; not written to the event log. */
export function reportActivity(state: State, attemptId: string, note: string): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (a && isActive(a)) a.activity = note.slice(0, 200);
  return s;
}

/**
 * The run ended without a usable result (provider error, authentication, limits, crash). Nothing is
 * integrated. The step is blocked with the reason so a person decides whether to retry, change the
 * model, or edit the work; the scheduler never retries or switches providers on its own.
 */
export function reportRunFailed(state: State, attemptId: string, message: string, now: string, run: RunReport = {}): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  const wasStopping = a.outcome === "stopping";
  a.endedAt = now;
  if (run.usage) a.usage = run.usage;
  if (run.actualModel) a.actualModel = run.actualModel;
  if (beforeFlow(t, a)) {
    // The step belongs to the new flow; a failure from the earlier one says nothing about it.
    discardEarlierFlow(s, t, a, now, `; it failed: ${message}`);
    return s;
  }
  a.outcome = "failed";
  a.note = message;
  if (st) {
    if (wasStopping) settleStoppedStep(s, t, st);
    else {
      st.state = "blocked";
      st.blockedReason = `Last run failed: ${message}`;
    }
  }
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  event(s, now, "runtime", wasStopping ? "runtime" : "blocked", `${a.id} failed: ${message}`, t.id);
  settleSendingNotes(s, a.id, "the run ended before the runtime answered", now);
  return s;
}

export function reportStopTimeout(state: State, attemptId: string, now: string): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || a.outcome !== "stopping") return s;
  const t = getTask(s, a.taskId);
  if (t.controlFailure) return s;
  t.controlFailure = { at: now, message: `${a.id} has not acknowledged the stop request. Integration stays frozen; the run may still be working.` };
  event(s, now, "system", "control", `Control failure: ${a.id} did not acknowledge stop in time`, t.id);
  return s;
}

export function retryStop(state: State, taskId: string, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  t.controlFailure = undefined;
  for (const a of activeAttempts(s, t.id)) if (a.outcome === "stopping") a.stopRequestedAt = now;
  event(s, now, "user", "control", "Retrying stop request", t.id);
  return s;
}

/** The runtime reports that a run finished. Stale or interrupted results are never integrated. */
export interface OutputReport {
  name: string;
  summary: string;
  /** Legacy review findings: the worker's count. Ignored when `findings` is present (the service computes it). */
  openFindings?: number;
  /** Structured findings, already validated by the parser. */
  findings?: Finding[];
  /** The changed files the reviewer says it judged (normalised by the parser). */
  reviewedPaths?: string[];
  /** A service check run. */
  checkRun?: Artifact["checkRun"];
  /** A service capture of evidence (ORC-029 pass 5). */
  evidence?: Artifact["evidence"];
  /** Breakdown outputs: the work items that become child tasks. */
  items?: unknown[];
  /** Durable reference, e.g. "<sha> on orchestration/run-12". */
  ref?: string;
}

export interface RunReport {
  usage?: Attempt["usage"];
  actualModel?: string;
  /**
   * The run came from the fake runtime (simulated). The server sets it from the adapter that ran
   * the lead; a lead run's focus change and steering change set then carry a structured `simulated` flag.
   */
  simulated?: true;
}

export function reportCompletion(state: State, attemptId: string, artifacts: string[], now: string, outputs: OutputReport[] = [], run: RunReport = {}): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  const t = getTask(s, a.taskId);
  const st = findStep(t, a.stepId);
  a.endedAt = now;
  a.progress = 100;
  a.artifacts.push(...artifacts);
  if (run.usage) a.usage = run.usage;
  if (run.actualModel) a.actualModel = run.actualModel;

  // A run started before the task's flow changed reports nothing to the new steps, whatever its step id
  // now means. Checked before the stale-revision check below, so the note names the cause.
  if (beforeFlow(t, a)) {
    discardEarlierFlow(s, t, a, now);
    return s;
  }
  const stale = !st || a.snapshot.specRev !== currentSpec(t).rev || a.snapshot.stepRev !== st.revision;
  if (stale) {
    a.outcome = "discarded";
    a.note = st
      ? `Result for spec r${a.snapshot.specRev}/step r${a.snapshot.stepRev} arrived after a newer revision; not integrated`
      : `${a.stepId} was removed from the pipeline; result not integrated`;
    settleStoppedStep(s, t, st);
    event(s, now, "runtime", "integration", `${a.id} finished on superseded revision; result discarded, not integrated`, t.id);
  } else if (a.outcome === "stopping" || t.hold || s.project.hold || t.lifecycle === "cancelled") {
    a.outcome = "stopped";
    a.note = "Finished after a stop request; kept as a checkpoint, not integrated";
    settleStoppedStep(s, t, st);
    event(s, now, "runtime", "runtime", `${a.id} finished after stop request; kept as checkpoint, not integrated`, t.id);
  } else {
    const missing = st.outputs.filter((d) => !outputs.some((o) => o.name === d.name)).map((d) => d.name);
    if (missing.length) {
      // Accepting a partial result would hand downstream steps a mix of old and new context.
      a.outcome = "failed";
      a.note = `Finished without declared outputs: ${missing.join(", ")}; not accepted`;
      st.state = "blocked";
      st.blockedReason = `Last run did not produce ${missing.join(", ")}. Retry the step or edit its outputs.`;
      event(s, now, "runtime", "blocked", `${a.id} finished without ${missing.join(", ")}; result not accepted, ${st.id} blocked`, t.id);
      touch(t, now);
      settleSendingNotes(s, a.id, "the run ended before the runtime answered", now);
      return s;
    }
    // A code review that reports nothing must account for every changed file the
    // service showed it. Otherwise it is not accepted: once more with the gap named, then blocked.
    const reviewCoverage = new Map<string, ReturnType<typeof pathCoverageOf>>();
    // A code review that read a real change but got no changed-path set is "unproven", never "not-required".
    const readsRealChange = a.snapshot.inputs.some((i) => {
      const art = s.artifacts.find((x) => x.id === i.artifactId);
      return art?.kind === "code-change" && !!art.ref && !art.ref.startsWith("sim-");
    });
    for (const def of st.outputs) {
      if (def.kind !== "review-findings") continue;
      const rep = outputs.find((o) => o.name === def.name)!;
      const cov = st.role !== "code_reviewer" ? notRequired() : a.scope || !readsRealChange ? pathCoverageOf(a.scope, rep.reviewedPaths ?? []) : { state: "unproven" as const, changed: 0, reviewed: (rep.reviewedPaths ?? []).length, missing: [], extra: [] };
      reviewCoverage.set(def.name, cov);
      // A finding an earlier round settled (accepted, followed up) does not make this report "not clean".
      const open = rep.findings ? rep.findings.filter((f) => F.isBlocking(f) && !F.settledByKey(s, t, f)).length : (rep.openFindings ?? 0);
      if (open > 0 || cov.state !== "incomplete") continue;
      // The gap and its retry belong to one change; a different change starts over.
      if (st.coverageGap && st.coverageGap.to !== cov.to) {
        delete st.coverageGap;
        delete st.coverageRetries;
      }
      const gap = gapText(cov);
      a.outcome = "failed";
      const files = [...cov.missing, ...cov.extra].slice(0, 10).join(", ");
      if (!st.coverageRetries) {
        st.coverageRetries = 1;
        st.coverageGap = { missing: [...cov.missing], extra: [...cov.extra], ...(cov.to ? { to: cov.to } : {}) };
        settleStoppedStep(s, t, st); // pending, or paused under a hold
        a.note = `Reported no findings but ${gap}; not accepted. It runs again with those files named.`;
        event(s, now, "runtime", "runtime", `${a.id} reported no findings but ${gap}; ${st.id} runs again with those files named`, t.id);
      } else {
        st.state = "blocked";
        st.blockedReason = `Last run failed: the clean review did not cover ${files} (twice). Retry it, or edit its findings to accept it.`;
        a.note = `Reported no findings but ${gap} (twice); not accepted.`;
        event(s, now, "runtime", "blocked", `${a.id} reported no findings but ${gap} (twice); ${st.id} blocked`, t.id);
      }
      if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
      touch(t, now);
      settleSendingNotes(s, a.id, "the run ended before the runtime answered", now);
      return s;
    }
    a.outcome = "completed";
    st.state = "done";
    st.invalidatedBy = undefined;
    st.autoRetries = 0;
    delete st.coverageGap;
    delete st.coverageRetries;
    const produced: string[] = [];
    for (const def of st.outputs) {
      const rep = outputs.find((o) => o.name === def.name)!;
      const version = s.artifacts.filter((x) => x.taskId === t.id && x.stepId === st.id && x.name === def.name).length + 1;
      // Structured findings: the open count is computed here from the findings, never taken from the worker.
      const findings = def.kind === "review-findings" && rep.findings ? structuredClone(rep.findings) : undefined;
      const art: Artifact = {
        id: nextId(s, "art"),
        taskId: t.id,
        stepId: st.id,
        attemptId: a.id,
        name: def.name,
        kind: def.kind,
        version,
        summary: rep.summary,
        createdAt: now,
        pipelineRev: t.pipelineRev,
        ...(rep.ref ? { ref: rep.ref } : {}),
        ...(def.kind === "review-findings" ? { openFindings: findings ? F.blockingCount(findings) : (rep.openFindings ?? 0), ...(findings ? { findings } : {}), pathCoverage: reviewCoverage.get(def.name) ?? notRequired() } : {}),
        ...(def.kind === "check-results" && rep.checkRun ? { checkRun: structuredClone(rep.checkRun), ...(rep.findings ? { findings: structuredClone(rep.findings), openFindings: F.blockingCount(rep.findings) } : {}) } : {}),
        ...(def.kind === "breakdown" ? { items: structuredClone(rep.items ?? []) } : {}),
        ...(def.kind === "evidence" && rep.evidence ? { evidence: structuredClone(rep.evidence) } : {}),
      };
      // Open decisions on the version this run replaces cannot be acted on any more; decided ones are the record (and carry forward).
      for (const old of s.artifacts) if (old.taskId === t.id && old.stepId === st.id && old.name === def.name) F.supersedeDecisions(s, t.id, now, { artifactId: old.id, reason: `${st.id} ran again and produced ${def.name} v${version}` });
      s.artifacts.push(art);
      produced.push(`${def.name} v${version}`);
      // Every blocking ask-user finding becomes a decision, routed as the project is set.
      if (art.findings) F.createDecisions(s, t, art, now);
      // A Final checks step whose run did not pass blocks the task and opens a decision.
      // The result stays on the record. The reason never starts with "Last run failed", so automatic
      // retry leaves it alone; only a repair round (lead or user) or the user's acceptance ends it.
      if (def.kind === "check-results" && st.checks?.onFail === "block" && art.checkRun && !C.allPassed(art.checkRun)) {
        const d = C.openFinalChecksDecision(s, t, st, art, now);
        st.state = "blocked";
        st.blockedReason = `Checks failed on the final change ${art.checkRun.sha.slice(0, 12)}: ${C.failedResults(art.checkRun).map((r) => r.label).join(", ")}. A decision is needed (${d.id}).`;
      }
    }
    event(s, now, "runtime", "runtime", `${st.id} completed by ${providerLabel(a.snapshot.provider)} · ${a.snapshot.model}${produced.length ? `; produced ${produced.join(", ")}` : ""}`, t.id);
    // Breakdown outputs become child tasks; loops append their next iteration.
    const breakdowns = st.outputs.filter((d) => d.kind === "breakdown");
    const gated = t.reviewEveryStep && t.steps.some((x) => !isSettled(x));
    if (breakdowns.length && gated) {
      // Children are created when the person resumes, from the (possibly edited) latest version.
      t.pendingBreakdowns = breakdowns.map((d) => ({ stepId: st.id, output: d.name }));
    } else if (breakdowns.length) {
      for (const def of breakdowns) applyBreakdown(s, t, st.id, def.name, now);
    } else if (st.iterate) expandIteration(s, t, st, now);
    // Optional review gate: stop here so a person can read or edit this step's output before the pipeline continues.
    const more = t.steps.some((x) => !isSettled(x));
    if (t.reviewEveryStep && more && !t.hold) {
      t.hold = true;
      t.holdReason = `Review ${st.id} (${st.purpose}) before the pipeline continues`;
      event(s, now, "lead", "control", `Paused for review after ${st.id}; edit its artifacts if needed, then resume`, t.id);
    }
  }
  if (!activeAttempts(s, t.id).some((x) => x.outcome === "stopping")) t.controlFailure = undefined;
  touch(t, now);
  // A note the run never acknowledged is not delivered, whatever the result (it is never "delivered" by implication).
  settleSendingNotes(s, a.id, "the run ended before the runtime answered", now);

  if (t.lifecycle === "active" && t.steps.every(isSettled) && activeAttempts(s, t.id).length === 0 && !t.hold && !s.project.hold) {
    finishTask(t);
    event(s, now, "lead", "integration", `All steps settled on spec r${currentSpec(t).rev}; task Done, queued for integration`, t.id);
  }
  return s;
}

/**
 * The commit whose files the service trusts: the fetched remote base with pull-request delivery on,
 * the delivery branch with local delivery on, else HEAD of the user's repository. Never a worktree,
 * which agents write.
 */
export function trustedBaseRef(s: State): string {
  const p = s.project;
  if (p.prDelivery.enabled && p.github?.base) return prBaseRef(p.id);
  if (p.autonomy.autoDeliver.enabled) return `refs/heads/${p.autonomy.autoDeliver.branch}`;
  return "HEAD";
}

export interface RunContext {
  /** The changed-path set a review run was shown. */
  scope?: NonNullable<Attempt["scope"]>;
  /** The repository instruction files the run was given as project conventions. */
  conventions?: NonNullable<Attempt["conventions"]>;
  /** Decisions the run's envelope carried, so a later change applies only to later repairs. */
  decisions?: string[];
}

/** Record what the service gave a run (queued before the run starts; applied only while the run is active). The snapshot stays immutable. */
export function reportRunContext(state: State, attemptId: string, ctx: RunContext): State {
  const s = draft(state);
  const a = s.attempts.find((x) => x.id === attemptId);
  if (!a || !isActive(a)) return s;
  if (ctx.scope) a.scope = { from: ctx.scope.from, to: ctx.scope.to, paths: ctx.scope.paths.slice(0, 500), total: ctx.scope.total };
  if (ctx.conventions) a.conventions = ctx.conventions.map((c) => ({ ...c }));
  for (const id of ctx.decisions ?? []) {
    const d = s.decisions.find((x) => x.id === id);
    if (d && !d.usedBy.includes(attemptId)) d.usedBy.push(attemptId);
  }
  return s;
}
