// Dispatch: which steps start next, on which model, with which notes and principles; and the lead's
// promotion of its proposals.

import * as C from "../checks";
import * as F from "../findings";
import { type Attempt, type CheckRunRecord, type ProviderId, type State, type Task, DEFAULT_CHECKS } from "../types";
import { acceptedOutput, consumedInputs } from "./artifacts";
import {
  activeAgentAttempts,
  activeAttempts,
  activeServiceAttempts,
  currentSpec,
  currentVision,
  draft,
  event,
  finishTask,
  getStep,
  isSettled,
  nextId,
  settleStrandedNotes,
  touch,
} from "./core";
import { childrenSettled, rootOf } from "./fanout";
import { bindQueuedNotes } from "./notes";
import { blockedReason, deferredBy, waitingOn } from "./presentation";
import { providerLabel, resolveStep } from "./resolution";
import { runPrinciples } from "./runPrinciples";
import { type OutputReport, reportCompletion } from "./runs";

/** The lead promotes proposals whose dependencies and assignments resolve. */
export function leadPromoteProposals(state: State, now: string): State {
  const s = draft(state);
  if (s.project.hold) return s;
  for (const t of s.tasks) {
    if (t.lifecycle !== "proposed" || t.hold || t.legacySpecUnavailable) continue;
    // ORC-009: a deferred proposal stays proposed until the deferral is lifted.
    if (deferredBy(s, t)) continue;
    if (blockedReason(s, t) || waitingOn(s, t)) continue;
    // ORC-013: a Checks step is run by the service and never resolves to a provider.
    const unresolved = t.steps.filter((st) => st.role !== "checks").map((st) => resolveStep(s, t, st)).find((r) => !r.ok);
    if (unresolved) continue;
    t.lifecycle = "ready";
    touch(t, now);
    event(s, now, "lead", "control", "Moved to Ready: spec published, assignments resolved", t.id);
  }
  return s;
}

interface DispatchOptions {
  /** Providers that cannot run work right now, with an actionable reason (observed health). */
  unavailable?: Partial<Record<ProviderId, string>>;
  /** Providers whose status is not known yet: their steps wait without being blocked. */
  deferred?: ProviderId[];
  /** Where an attempt's workspace will live (recorded in the immutable run snapshot). */
  workspaceFor?: (taskId: string, stepId: string, attemptId: string) => string;
  /**
   * Set while writers have no base to start from (pull-request delivery before the first fetch):
   * coder steps that continue no earlier change are not dispatched. Nothing is blocked or failed.
   */
  holdWriters?: string;
  /** Tasks whose first writer must wait for a fresh base (a revert, before the base was fetched again). */
  staleBase?: (t: Task) => boolean;
  /** ORC-013: the checks sandbox is not ready: Checks steps wait, labelled, and nothing falls back to running unsandboxed. */
  checksHeld?: boolean;
}

/**
 * ORC-009: the dispatch order. A child runs at its root's priority tier unless the user pinned its own
 * priority; inside a tier, a task's own priority orders it (so breakdown items keep their order within
 * a tree). Nothing is written to children: the cascade is derived.
 */
export function dispatchRank(s: State, t: Task): [number, number] {
  const tier = t.parentTaskId && !t.userSet?.priority ? rootOf(s, t).priority : t.priority;
  return [tier, t.priority];
}

export function dispatchEligible(state: State, now: string, opts: DispatchOptions = {}): State {
  const s = draft(state);
  settleStrandedNotes(s, now);
  if (s.project.hold) return s;
  const vision = currentVision(s);
  // ORC-012: while shaping no worker step starts, on any task. Like a deferral (and unlike a hold),
  // running work finishes and its result is accepted, settled tasks become Done, and nothing is paused.
  const shaping = s.project.stage === "shaping";
  // ORC-013: Final checks steps that repeat an earlier run of the same commit and settings complete in this same transaction.
  const reused: { attemptId: string; outputs: OutputReport[] }[] = [];
  // A stable sort: tasks the lead did not name keep their relative (creation) order.
  const tasks = s.tasks.map((t) => ({ t, rank: dispatchRank(s, t) })).sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map((x) => x.t);
  for (const t of tasks) {
    if (activeAgentAttempts(s).length >= s.project.workerLimit) break;
    if (t.lifecycle !== "ready" && t.lifecycle !== "active") continue;
    if (t.hold || t.holdBeforeStart || t.heldForShaping || t.controlFailure || t.legacySpecUnavailable) continue;
    if (waitingOn(s, t) || blockedReason(s, t)) continue;
    // Reconcile before redispatch: nothing new while any run on this task is still stopping.
    if (activeAttempts(s, t.id).some((a) => a.outcome === "stopping")) continue;
    const spec = currentSpec(t);
    if (t.lifecycle === "active" && t.steps.every(isSettled) && activeAttempts(s, t.id).length === 0) {
      finishTask(t);
      touch(t, now);
      event(s, now, "lead", "integration", `All steps settled on spec r${spec.rev}; task Done, queued for integration`, t.id);
      continue;
    }
    // ORC-009: deferral is checked only here, after the finish branch, so a deferred task whose work is
    // complete (including steps settled by skipping) still becomes Done and is queued for integration.
    // It is not a hold: the running step's result is accepted by reportCompletion as usual. Below, a
    // conditional step with nothing to do still settles by skipping; only starting work is withheld.
    const deferred = shaping || !!deferredBy(s, t);
    for (const st of [...t.steps]) {
      if (activeAgentAttempts(s).length >= s.project.workerLimit) break;
      if (st.state !== "pending") continue;
      const depsDone = st.dependsOn.every((d) => isSettled(getStep(t, d)));
      if (!depsDone) continue;
      if (st.waitForChildren && !childrenSettled(s, t)) continue;
      if ((opts.holdWriters || opts.staleBase?.(t)) && st.role === "coder" && !consumedInputs(s, t, st).some((i) => s.artifacts.find((x) => x.id === i.artifactId)?.kind === "code-change")) continue;
      if ((st.iteration ?? 1) > 1 && st.dependsOn.length && st.dependsOn.every((d) => getStep(t, d).state === "skipped")) {
        // The previous iteration ended without work to repeat (for example after a re-run came back clean).
        st.state = "skipped";
        st.invalidatedBy = undefined;
        touch(t, now);
        event(s, now, "lead", "dispatch", `Skipped ${st.id}: the previous iteration ended clean`, t.id);
        continue;
      }
      // ORC-013: a Checks step is run by the service, never by a provider. While checks are off for the
      // project it settles by skipping, so the pipeline continues (a settle-by-skip is allowed even
      // while deferred or shaping, as for a condition with nothing to do).
      if (st.role === "checks") {
        const cfg = s.project.checks ?? DEFAULT_CHECKS;
        if (!C.checksOn(cfg)) {
          st.state = "skipped";
          st.invalidatedBy = undefined;
          touch(t, now);
          event(s, now, "lead", "dispatch", `Skipped ${st.id}: checks are off for this project (Settings → Checks)`, t.id);
          continue;
        }
        const target = C.checkTargetOf(s, t, st);
        if (!target) {
          st.state = "skipped";
          st.invalidatedBy = undefined;
          touch(t, now);
          event(s, now, "lead", "dispatch", `Skipped ${st.id}: nothing to check: no code change reached this step`, t.id);
          continue;
        }
        // M2: a step that would run no check command never counts as passing; it blocks and says why.
        const missing = C.missingChecks(cfg, st);
        if (missing.length || !C.commandsFor(cfg, st).some((c) => c.kind === "check")) {
          const reason = missing.length ? `this step names checks that do not exist: ${missing.join(", ")}. Fix the pipeline, or the check settings.` : "this step runs no check command: every check it names was removed from the settings.";
          st.state = "blocked";
          st.blockedReason = reason;
          touch(t, now);
          event(s, now, "system", "blocked", `${st.id} blocked: ${reason}`, t.id);
          continue;
        }
        if (deferred) continue; // settling by skipping is allowed while deferred or shaping; starting is not
        // The sandbox is not ready: the step waits, labelled; nothing ever falls back to running unsandboxed (Q3).
        if (opts.checksHeld ?? C.checksHeld(s)) continue;
        if (activeServiceAttempts(s).length >= cfg.maxConcurrent) continue;
        const targetSha = target.ref;
        const reuse = st.checks?.onFail === "block" ? C.reusableRun(s, t, st, targetSha) : undefined;
        const attemptId = nextId(s, "run");
        const a: Attempt = {
          id: attemptId,
          taskId: t.id,
          stepId: st.id,
          snapshot: {
            provider: "service",
            model: "checks",
            source: "service",
            routingReason: reuse ? `Same commit and settings as ${reuse.attempt.stepId}'s run ${reuse.attempt.id}; not run again` : `Run by the service (${cfg.sandbox === "codex" ? "sandboxed" : "no sandbox"})`,
            specRev: spec.rev,
            stepRev: st.revision,
            visionRev: vision.rev,
            workspace: opts.workspaceFor ? opts.workspaceFor(t.id, st.id, attemptId) : `${s.project.repoPath}/.orchestration/worktrees/${t.id}-${st.id}`,
            pipelineRev: t.pipelineRev,
            role: st.role,
            purpose: st.purpose,
            inputs: consumedInputs(s, t, st),
            checks: { configRev: cfg.rev, sandbox: cfg.sandbox, target, commands: C.commandsFor(cfg, st), ...(reuse ? { reusedFrom: reuse.attempt.id } : {}) },
          },
          startedAt: now,
          outcome: "running",
          progress: 0,
          artifacts: [],
        };
        s.attempts.push(a);
        st.state = "running";
        if (t.lifecycle === "ready") t.lifecycle = "active";
        touch(t, now);
        event(s, now, "lead", "dispatch", `Dispatched ${st.id} (checks) to the service as ${a.id} on ${targetSha.slice(0, 12)} with settings r${cfg.rev}${reuse ? `; same commit and settings as ${reuse.attempt.id}, not run again` : ""}`, t.id);
        // Reuse (a Final checks step whose commit the loop already checked with these settings): it completes in this same transaction with a copy of that result.
        if (reuse) {
          const record: CheckRunRecord = { ...structuredClone(reuse.artifact.checkRun!), reusedFrom: reuse.attempt.id };
          const findings = reuse.artifact.findings ? structuredClone(reuse.artifact.findings) : undefined;
          reused.push({ attemptId, outputs: [{ name: st.outputs[0].name, summary: C.runSummary(record), checkRun: record, ...(findings ? { findings } : {}) }] });
        }
        continue;
      }
      // ORC-013: a step conditioned on findings waits, neither dispatched nor skipped, while an
      // ask-user finding it would read is undecided. Deferral, holds and pauses apply as usual.
      if (F.stepAwaitsDecision(s, t, st)) continue;
      if (st.runIf?.length) {
        // Only what a repair may do counts: auto-fix findings and those someone decided to fix.
        const open = st.runIf.reduce((n, r) => {
          const art = acceptedOutput(s, t, r.step, r.output);
          return n + (art ? F.fixable(s, art) : 0);
        }, 0);
        if (open === 0) {
          st.state = "skipped";
          st.invalidatedBy = undefined;
          touch(t, now);
          event(s, now, "lead", "dispatch", `Skipped ${st.id}: nothing to fix in ${st.runIf.map((r) => `${r.step}.${r.output}`).join(", ")}`, t.id);
          continue;
        }
      }
      if (deferred) continue; // ORC-009: nothing new starts on a deferred task; ORC-012: nor on any task while shaping
      const r = resolveStep(s, t, st);
      if (r.ok && opts.deferred?.includes(r.selection.provider)) continue;
      if (r.ok && activeAgentAttempts(s).filter((x) => x.snapshot.provider === r.selection.provider).length >= (s.project.providerLimits?.[r.selection.provider] ?? s.project.workerLimit)) continue;
      const down = r.ok ? opts.unavailable?.[r.selection.provider] : undefined;
      if (!r.ok || down) {
        // Never substitute another provider: block with the reason and let the user act.
        const reason = r.ok ? `${providerLabel(r.selection.provider)} is not available: ${down}` : r.reason;
        st.state = "blocked";
        st.blockedReason = reason;
        event(s, now, "system", "blocked", `${st.id} blocked: ${reason}`, t.id);
        continue;
      }
      const attemptId = nextId(s, "run");
      const inputs = consumedInputs(s, t, st);
      const a: Attempt = {
        id: attemptId,
        taskId: t.id,
        stepId: st.id,
        snapshot: {
          provider: r.selection.provider,
          model: r.selection.model,
          source: r.source,
          routingReason: r.reason,
          specRev: spec.rev,
          stepRev: st.revision,
          visionRev: vision.rev,
          workspace: opts.workspaceFor ? opts.workspaceFor(t.id, st.id, attemptId) : `${s.project.repoPath}/.orchestration/worktrees/${t.id}-${st.id}`,
          pipelineRev: t.pipelineRev,
          role: st.role,
          environment: s.project.workerEnvironment[r.selection.provider],
          connections: [...s.project.workerConnections[r.selection.provider]],
          purpose: st.purpose,
          inputs,
          // ORC-024: what the run is given, with "attack the premise" when this repair round follows one that failed the same way.
          principles: runPrinciples(s, t, st, inputs),
          // A dedicated delivery review reads a worktree detached at exactly this commit.
          ...(t.reviewTarget ? { reviewedSha: t.reviewTarget.headSha } : {}),
        },
        startedAt: now,
        outcome: "running",
        progress: 0,
        artifacts: [],
      };
      s.attempts.push(a);
      st.state = "running";
      if (t.lifecycle === "ready") t.lifecycle = "active";
      touch(t, now);
      event(s, now, "lead", "dispatch", `Dispatched ${st.id} (${st.role}) to ${providerLabel(a.snapshot.provider)} · ${a.snapshot.model} as ${a.id} on spec r${spec.rev}`, t.id);
      bindQueuedNotes(s, t, st, a, now);
    }
  }
  let out: State = s;
  for (const r of reused) out = reportCompletion(out, r.attemptId, [], now, r.outputs);
  return out;
}
