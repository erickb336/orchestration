// Step outputs: the accepted version, what a step consumed, and a person's edit of an output, which
// revalidates every step downstream. Also the step-by-step review setting.

import * as F from "../findings";
import { type Artifact, type Attempt, type ConsumedInput, type State, type StepDef, type Task, ControlError } from "../types";
import { activeAttempts, assertOpen, draft, event, findStep, getStep, getTask, isSettled, nextId, requestStop, touch } from "./core";
import { peReviewStands, reopenStepReviewInto } from "../peReview";
import { applyBreakdown } from "./fanout";

export function latestArtifact(s: State, t: Task, stepId: string, output: string): Artifact | undefined {
  let best: Artifact | undefined;
  for (const x of s.artifacts) if (x.taskId === t.id && x.stepId === stepId && x.name === output && (!best || x.version > best.version)) best = x;
  return best;
}

/**
 * The output a step's current accepted run produced. Only a done step has one; skipped, pending,
 * or re-running steps contribute nothing, even if older versions exist.
 */
export function acceptedOutput(s: State, t: Task, stepId: string, output: string): Artifact | undefined {
  const st = findStep(t, stepId);
  if (!st || st.state !== "done") return undefined;
  let run: Attempt | undefined;
  for (const a of s.attempts) if (a.taskId === t.id && a.stepId === stepId && a.outcome === "completed") run = a;
  const fromRun = run && s.artifacts.find((x) => x.attemptId === run.id && x.name === output);
  // A person's later edit of this output supersedes the run's version.
  let edited: Artifact | undefined;
  for (const x of s.artifacts) {
    if (x.taskId === t.id && x.stepId === stepId && x.name === output && x.author === "user" && (!fromRun || x.version > fromRun.version) && (!edited || x.version > edited.version)) edited = x;
  }
  return edited ?? fromRun;
}

/** The upstream artifacts a step receives. Inputs from skipped or unfinished steps are absent. */
export function consumedInputs(s: State, t: Task, st: StepDef): ConsumedInput[] {
  const out: ConsumedInput[] = [];
  for (const r of st.inputs) {
    const art = acceptedOutput(s, t, r.step, r.output);
    if (art) out.push({ step: r.step, output: r.output, artifactId: art.id, version: art.version });
  }
  return out;
}

/** Inputs a completed run consumed that have since been superseded by a newer version. */
export function staleInputs(s: State, t: Task, a: Attempt): ConsumedInput[] {
  return a.snapshot.inputs.filter((i) => (latestArtifact(s, t, i.step, i.output)?.version ?? 0) > i.version);
}

/**
 * The pipeline revision an artifact was made under. Stamped on new artifacts; an older one takes
 * it from its attempt's snapshot, and an older edit from the version it edited. Unknown counts as 0.
 */
export function artifactPipelineRev(s: State, art: Artifact): number {
  if (art.pipelineRev !== undefined) return art.pipelineRev;
  const run = s.attempts.find((a) => a.id === art.attemptId);
  if (run) return run.snapshot.pipelineRev;
  let prev: Artifact | undefined;
  for (const x of s.artifacts) if (x.taskId === art.taskId && x.stepId === art.stepId && x.name === art.name && x.version < art.version && (!prev || x.version > prev.version)) prev = x;
  return prev ? artifactPipelineRev(s, prev) : 0;
}

/** The artifact was made under a flow the task has since left. Labelled in the UI; never edited or consumed again. */
export function fromEarlierFlow(s: State, t: Task, art: Artifact): boolean {
  return artifactPipelineRev(s, art) < t.flowSince;
}

export function setReviewEveryStep(state: State, taskId: string, value: boolean, now: string): State {
  const s = draft(state);
  const t = getTask(s, taskId);
  assertOpen(t, "Changing review mode");
  t.reviewEveryStep = value;
  touch(t, now);
  event(s, now, "user", "control", value ? "Step-by-step review on: the task pauses after every step" : "Step-by-step review off", t.id);
  return s;
}

/**
 * A person edits (or replaces) a step's output. The edit becomes a new version that later steps
 * receive; every step downstream that already used an earlier version is revalidated (stopped if
 * running, requeued if done), which re-submits the work through the rest of the pipeline.
 */
export function editArtifact(
  state: State,
  artifactId: string,
  change: { summary: string; openFindings?: number; ref?: string; items?: unknown[]; reason: string },
  now: string,
): State {
  const s = draft(state);
  const base = s.artifacts.find((a) => a.id === artifactId);
  if (!base) throw new ControlError(`Unknown artifact ${artifactId}`);
  const t = getTask(s, base.taskId);
  assertOpen(t, "Editing an artifact");
  // Work done under an earlier flow is the record, never an input to the new steps.
  if (artifactPipelineRev(s, base) < t.flowSince) throw new ControlError("This artifact belongs to an earlier flow of this task. It is kept for the record and cannot be edited.");
  const st = getStep(t, base.stepId);
  if (!change.reason.trim()) throw new ControlError("Say why you changed it; the reason goes to the next steps.");
  if (!change.summary.trim()) throw new ControlError("The artifact cannot be empty.");
  // Structured findings are decided one by one; the summary can still be edited and the findings carry over.
  if (base.kind === "review-findings" && base.findings && change.openFindings !== undefined) throw new ControlError("These findings are listed one by one: decide each finding instead of editing the open count.");
  if (base.kind === "review-findings" && !base.findings && (!Number.isInteger(change.openFindings) || change.openFindings! < 0)) throw new ControlError("Review findings need a number of open findings.");
  if (change.ref?.trim() && !/^[0-9a-f]{7,40}$/i.test(change.ref.trim())) throw new ControlError("Use a commit hash (7–40 hex characters) for your own change.");
  if (change.items !== undefined && (base.kind !== "breakdown" || !Array.isArray(change.items) || change.items.length > 50)) throw new ControlError("Items can be edited only on breakdowns (at most 50).");
  const version = Math.max(...s.artifacts.filter((a) => a.taskId === t.id && a.stepId === st.id && a.name === base.name).map((a) => a.version)) + 1;
  const art: Artifact = {
    id: nextId(s, "art"),
    taskId: t.id,
    stepId: st.id,
    attemptId: "edit",
    name: base.name,
    kind: base.kind,
    version,
    summary: change.summary.slice(0, 20000),
    createdAt: now,
    pipelineRev: t.pipelineRev,
    author: "user",
    editReason: change.reason.trim(),
    ...(base.kind === "review-findings" && !base.findings ? { openFindings: change.openFindings } : {}),
    ...(base.kind === "review-findings" && base.findings ? { openFindings: base.openFindings, findings: structuredClone(base.findings) } : {}),
    ...(base.kind === "review-findings" && base.pathCoverage ? { pathCoverage: structuredClone(base.pathCoverage) } : {}),
    ...(base.kind === "check-results" && base.checkRun ? { checkRun: structuredClone(base.checkRun), ...(base.findings ? { findings: structuredClone(base.findings), openFindings: base.openFindings } : {}) } : {}),
    ...(base.kind === "breakdown" ? { items: structuredClone(change.items ?? base.items ?? []) } : {}),
    ...(change.ref?.trim() ? { ref: change.ref.trim() } : base.ref ? { ref: base.ref } : {}),
  };
  s.artifacts.push(art);
  // The findings carry over with their decisions, which now belong to the new version (the same
  // findings under a new artifact id); any blocking ask-user finding still without a record gets one, so
  // nothing waits on a record that does not exist.
  if (art.findings) {
    for (const d of s.decisions) if (d.artifactId === base.id) d.artifactId = art.id;
    F.createDecisions(s, t, art, now);
  }
  // Re-submit: everything downstream of this step that consumed it (directly or transitively).
  const downstream = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of t.steps) {
      if (downstream.has(d.id)) continue;
      if (d.dependsOn.includes(st.id) || d.dependsOn.some((x) => downstream.has(x))) {
        downstream.add(d.id);
        grew = true;
      }
    }
  }
  for (const d of t.steps) {
    if (!downstream.has(d.id)) continue;
    if (isSettled(d)) {
      d.state = t.hold ? "paused" : "pending";
      d.invalidatedBy = `edited ${st.id}.${base.name}`;
    }
  }
  for (const a of activeAttempts(s, t.id)) {
    if (!downstream.has(a.stepId)) continue;
    const d = findStep(t, a.stepId);
    if (d) d.revision += 1;
    requestStop(s, a, "revision", now);
  }
  touch(t, now);
  event(s, now, "user", "spec", `Edited ${st.id}.${base.name} (v${version}): ${art.editReason}${downstream.size ? `; re-submitting ${[...downstream].join(", ")}` : ""}`, t.id);
  // Your edit of a breakdown or a design the PE objected to starts a new review of it; one the PE is still reviewing
  // is reviewed as you edited it. Either way its children wait for the PE's agreement.
  reopenStepReviewInto(s, t, st, version, now);
  if (base.kind === "breakdown" && st.state === "done" && !peReviewStands(st.peReview)) {
    // Child tasks follow the edited breakdown: now, or when the task resumes if it is paused.
    const pb = { stepId: st.id, output: base.name };
    const already = (t.pendingBreakdowns ?? []).some((x) => x.stepId === pb.stepId && x.output === pb.output);
    if (t.hold) {
      if (!already) t.pendingBreakdowns = [...(t.pendingBreakdowns ?? []), pb];
    } else if (!already) applyBreakdown(s, t, st.id, base.name, now);
  }
  return s;
}
