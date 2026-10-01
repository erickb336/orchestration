// Independent review of a pull request's change: the evidence from the task's own pipeline or from a
// dedicated review task, and starting that review task.

import * as C from "../checks";
import { MAX_PROVEN_PATHS, coverageCounts } from "../coverage";
import * as F from "../findings";
import * as M from "../model";
import { internalFlow, flowHash, flowRef } from "../flows";
import { instantiate, toDef } from "../pipeline";
import { clip } from "../text";
import {
  ControlError,
  REVIEW_ROLES,
  isProvider,
  type FlowRef,
  type PrDelivery,
  type ProviderId,
  type RoleId,
  type ReviewEvidence,
  type Artifact,
  type Attempt,
  type SpecContent,
  type State,
  type Task,
} from "../types";
import { openPr } from "./commands";
import { event, getTask, sha12 } from "./core";
import { refreshAttention, stuck, wrongRepo } from "./gate";
import { PR_LIMITS, prName, prTask } from "./pr";

/**
 * Does a review by this provider count as independent? Judged against everyone who authored a change
 * the pull request holds, not only the author of its newest commit: a fix pushed by another provider
 * never makes the first provider independent of its own work. An unknown author fails closed.
 */
function independent(s: State, pr: PrDelivery, provider: ProviderId | undefined): boolean {
  if (s.project.prDelivery.reviewer === "any-agent") return true;
  return !!provider && M.independentProviders(M.prAuthors(pr)).includes(provider);
}

/** No agent's review can be independent: every provider wrote part of the pull request, or an author is unknown. */
function nobodyIndependent(s: State, pr: PrDelivery): boolean {
  return s.project.prDelivery.reviewer !== "any-agent" && M.independentProviders(M.prAuthors(pr)).length === 0;
}

const NEEDS_USER = "Merge it yourself, or let any agent count as the reviewer (Settings → Delivery).";
function nobodyReason(pr: PrDelivery): string {
  const authors = M.prAuthors(pr);
  return authors.includes("unknown")
    ? `Who wrote part of this pull request is not on record, so no agent's review of ${sha12(pr.changeSha)} can be shown to be independent. ${NEEDS_USER}`
    : `${M.authorsLabel(authors)} each wrote part of this pull request, so no agent's review of ${sha12(pr.changeSha)} is independent, and no provider reviews its own work. ${NEEDS_USER}`;
}

/**
 * Where the independent review of a pull request's change stands.
 * "missing" and "not-independent": a dedicated review can cure it and none exists yet.
 * "pending": a dedicated review is queued or running. "findings": the review that saw the change
 * reported open findings. "blocked": it needs the user. The dedicated review cannot run, ran on a
 * provider that wrote part of the pull request, or was cancelled by the user; or no provider is left
 * that wrote none of it (or an author is unknown), so no agent's review could be independent.
 * "limit": the service already started as many dedicated reviews as it may.
 */
type ReviewState = "ok" | "pending" | "missing" | "not-independent" | "findings" | "blocked" | "limit" | "too-large";
interface ReviewView {
  state: ReviewState;
  evidence: ReviewEvidence;
  /** The dedicated review task this is about, if any. */
  reviewTaskId?: string;
}

function lastCompletedRun(s: State, taskId: string, stepId: string): Attempt | undefined {
  let run: Attempt | undefined;
  for (const a of s.attempts) if (a.taskId === taskId && a.stepId === stepId && a.outcome === "completed") run = a;
  return run;
}

interface Covering {
  art: Artifact;
  run: Attempt;
  role: RoleId;
}

const modelOf = (run: Attempt) => run.actualModel ?? run.snapshot.model;
const findingsText = (n: number) => `${n} open finding${n === 1 ? "" : "s"}`;

/**
 * May a review artifact count as evidence for the change `sha`? Findings someone still
 * has to fix or decide are evidence whatever the coverage (they keep the gate blocked and drive the
 * repair). A clean review counts only when a person wrote it, or when its coverage is complete for
 * exactly this change, or when the service recorded no changed-path set for the run at all (nothing
 * under review). A record from before coverage existed, an incomplete or an unproven one never
 * counts as clean.
 */
function countsFor(s: State, art: Artifact, sha: string): boolean {
  if (art.author === "user") return true;
  if (F.unresolved(s, art) > 0) return true;
  const c = art.pathCoverage;
  if (!c || !coverageCounts(c)) return false;
  return c.state === "not-required" || (!!c.to && C.sameSha(c.to, sha));
}

/** The finished review steps of a task whose accepted findings satisfy `covers` and count for `pr`'s change. */
function reviewsOf(s: State, c: Task, pr: PrDelivery, covers: (run: Attempt) => boolean): Covering[] {
  const out: Covering[] = [];
  for (const st of c.steps) {
    if (st.state !== "done" || !REVIEW_ROLES.includes(st.role)) continue;
    for (const o of st.outputs) {
      if (o.kind !== "review-findings") continue;
      const art = M.acceptedOutput(s, c, st.id, o.name);
      // For findings a person edited, the run is the one whose output they edited.
      const run = lastCompletedRun(s, c.id, st.id);
      if (art && run && covers(run) && countsFor(s, art, pr.changeSha)) out.push({ art, run, role: st.role });
    }
  }
  return out;
}

/**
 * Evidence from a set of reviews that saw the change: unresolved findings, then independence. Every
 * review's findings count; independence is judged on the code review alone. A
 * security review by the writer's own provider adds findings but is never the independent evidence.
 */
function judge(s: State, pr: PrDelivery, covering: Covering[], source: "pipeline" | "dedicated", taskId: string): ReviewView {
  const h = sha12(pr.changeSha);
  const base = { source, forSha: pr.changeSha, taskId, artifactIds: covering.map((x) => x.art.id) };
  const open = covering.reduce((n, x) => n + F.unresolved(s, x.art), 0);
  if (open > 0) return { state: "findings", evidence: { ok: false, ...base, reason: `The review of ${h} reported ${findingsText(open)}.` } };
  const code = covering.filter((x) => x.role === "code_reviewer");
  const by = code.find((x) => independent(s, pr, isProvider(x.run.snapshot.provider) ? x.run.snapshot.provider : undefined));
  if (!by) {
    const who = code[0].run.snapshot.provider;
    const authors = M.prAuthors(pr);
    const why = authors.includes("unknown")
      ? "and who wrote part of this pull request is not on record"
      : authors.filter((a) => a !== "user").length > 1
        ? `which wrote part of this pull request (written by ${M.authorsLabel(authors)})`
        : "the provider that wrote the change";
    return {
      state: "not-independent",
      evidence: { ok: false, ...base, attemptId: code[0].run.id, ...(isProvider(who) ? { provider: who } : {}), model: modelOf(code[0].run), reason: `The review of ${h} was done by ${M.providerLabel(who)}, ${why}, so it does not count as independent.` },
    };
  }
  const cleared = covering.some((x) => x.art.author === "user");
  // Findings someone decided to accept as they are do not block, and the evidence names them.
  const accepted = covering.flatMap((x) => F.acceptedFindings(s, x.art));
  const provider = by.run.snapshot.provider;
  return {
    state: "ok",
    evidence: {
      ok: true,
      ...base,
      attemptId: by.run.id,
      ...(isProvider(provider) ? { provider } : {}),
      model: modelOf(by.run),
      reason: `Clean review of ${h} by ${M.providerLabel(provider)}${cleared ? " (findings cleared by you)" : ""}${accepted.length ? `; ${accepted.length} finding${accepted.length === 1 ? "" : "s"} accepted as is (${accepted.slice(0, 5).join("; ")})` : ""}.`,
      ...(cleared ? { clearedByUser: true } : {}),
      ...(accepted.length ? { accepted } : {}),
    },
  };
}

const noReview = (pr: PrDelivery, reason: string): ReviewEvidence => ({ ok: false, source: "none", reason, forSha: pr.changeSha, artifactIds: [] });

/**
 * The task's own review counts only when it provably covers the final change: a finished code review
 * and a finished security review whose runs received exactly the final change as an input. A finished task alone proves nothing (when
 * a repair loop runs out, its last repair is never reviewed).
 */
function pipelineReview(s: State, pr: PrDelivery): ReviewView {
  const h = sha12(pr.changeSha);
  const missing: ReviewView = { state: "missing", evidence: noReview(pr, `No review saw the final change ${h}.`) };
  const c = s.tasks.find((x) => x.id === pr.changeTaskId);
  if (!c) return missing;
  // Simulated runs make code-change artifacts without commits: the newest one stands for the final change.
  const fc = M.finalChange(s, c) ?? (pr.simulated ? s.artifacts.filter((a) => a.taskId === c.id && a.kind === "code-change").pop() : undefined);
  if (!fc) return missing;
  if (!pr.simulated) {
    const ref = fc.ref?.split(" ")[0] ?? "";
    if (ref.length < 7 || !pr.changeSha.startsWith(ref)) return missing;
  }
  const covering = reviewsOf(s, c, pr, (run) => run.snapshot.inputs.some((i) => i.artifactId === fc.id));
  if (!covering.some((x) => x.role === "code_reviewer")) {
    // A review that saw the change but did not list the files it covered is not clean evidence.
    const saw = c.steps.some((st) => st.state === "done" && st.role === "code_reviewer" && lastCompletedRun(s, c.id, st.id)?.snapshot.inputs.some((i) => i.artifactId === fc.id));
    return saw ? { state: "missing", evidence: noReview(pr, `The review of ${h} did not list the files it covered, so it does not count.`) } : missing;
  }
  const v = judge(s, pr, covering, "pipeline", c.id);
  // A clean pass also needs a security review that saw the final change; without one the
  // dedicated review (which has one) runs. Findings and a review that is not independent stand as they are.
  if (v.state === "ok" && !covering.some((x) => x.role === "security_reviewer")) return { state: "missing", evidence: noReview(pr, `No security review saw the final change ${h}.`) };
  return v;
}

/**
 * The dedicated review tasks of this pull request for the change it holds now, oldest first.
 * `withCancelled`: also the ones a person cancelled (never the ones the service cancelled itself).
 */
function reviewTasksFor(s: State, t: Task, pr: PrDelivery, withCancelled = false): Task[] {
  return s.tasks.filter(
    (x) => x.reviewTarget?.taskId === t.id && x.reviewTarget.n === pr.n && x.reviewTarget.headSha === pr.changeSha && (x.lifecycle !== "cancelled" || (withCancelled && x.cancelledBy !== "system")),
  );
}

function dedicatedReview(s: State, t: Task, pr: PrDelivery): ReviewView | undefined {
  const all = reviewTasksFor(s, t, pr, true);
  const last = all[all.length - 1];
  if (!last) return undefined;
  if (last.lifecycle === "cancelled") {
    // An earlier review that finished clean still stands. Otherwise the cancellation is the user's
    // word: the review is not missing, and the service does not start another behind their back.
    const earlier = all.filter((x) => x.lifecycle === "done").pop();
    const v = earlier && finishedReview(s, pr, earlier);
    if (v?.state === "ok") return v;
    return {
      state: "blocked",
      reviewTaskId: last.id,
      evidence: noReview(pr, `The independent review ${last.id} of ${sha12(pr.changeSha)} was cancelled${last.cancelledBy === "lead" ? " by the lead" : " by you"}, so no other is started. Ask for a review, or merge it yourself.`),
    };
  }
  return finishedReview(s, pr, last);
}

/** Where one dedicated review task (not cancelled) stands. */
function finishedReview(s: State, pr: PrDelivery, rv: Task): ReviewView {
  const h = sha12(pr.changeSha);
  if (rv.lifecycle !== "done") {
    const blocked = rv.steps.find((x) => x.state === "blocked");
    if (blocked) return { state: "blocked", reviewTaskId: rv.id, evidence: noReview(pr, `The independent review ${rv.id} cannot run: ${blocked.blockedReason ?? "its step is blocked"}`) };
    // Steering rejects delivery tasks, but a deferral reached by any other path
    // must be reported as what it is: nothing starts on the review until the deferral is lifted.
    const deferred = !M.activeAttempts(s, rv.id).length && M.deferredBy(s, rv);
    if (deferred) {
      return { state: "blocked", reviewTaskId: rv.id, evidence: noReview(pr, `The independent review ${rv.id} of ${h} is deferred${deferred.task.id !== rv.id ? ` with ${deferred.task.id}` : ""}, so it does not run. Run it now to continue, or merge it yourself.`) };
    }
    // While shaping the review, like any other work, waits for Start building; it is not queued.
    const how = M.activeAttempts(s, rv.id).length ? "running" : rv.hold || rv.holdBeforeStart ? "paused" : s.project.stage === "shaping" ? "held: it waits until you start building (shaping)" : "queued";
    return { state: "pending", reviewTaskId: rv.id, evidence: noReview(pr, `The independent review ${rv.id} of ${h} is ${how}.`) };
  }
  // A dedicated review counts only when its run read a worktree detached at exactly this commit, and
  // only when it listed the files it covered.
  const all = reviewsOf(s, rv, pr, () => true);
  if (!all.some((x) => x.role === "code_reviewer") || all.some((x) => x.run.snapshot.reviewedSha !== pr.changeSha)) {
    const ran = rv.steps.some((st) => st.state === "done" && st.role === "code_reviewer" && lastCompletedRun(s, rv.id, st.id)?.snapshot.reviewedSha === pr.changeSha);
    return { state: "missing", reviewTaskId: rv.id, evidence: noReview(pr, ran ? `The review ${rv.id} of ${h} did not list the files it covered, so it does not count.` : `The review ${rv.id} did not read ${h}, so it does not count.`) };
  }
  const v = judge(s, pr, all, "dedicated", rv.id);
  if (v.state === "not-independent") {
    // The reviewer was the user's own choice (a pin or an override). Nothing is substituted and no second review is started.
    return { state: "blocked", reviewTaskId: rv.id, evidence: { ...v.evidence, reason: `${v.evidence.reason} Choose another reviewer and ask for a new review, or let any agent count (Settings → Delivery).` } };
  }
  return { ...v, reviewTaskId: rv.id };
}

/** Where the independent review of this pull request's change stands now. Pure. */
export function reviewView(s: State, t: Task): ReviewView {
  const pr = t.integration?.pr;
  if (!pr) return { state: "missing", evidence: { ok: false, source: "none", reason: "No pull request.", artifactIds: [] } };
  const own = pipelineReview(s, pr);
  if (own.state === "ok") return own;
  // A dedicated review of this exact change, once one exists, is the newer word.
  const dedicated = dedicatedReview(s, t, pr);
  if (dedicated && dedicated.state !== "missing") return dedicated;
  if (own.state === "findings") return own;
  // Above the coverage limit no agent review can ever be shown complete, so none is started; the user merges.
  if (pr.changed.files > MAX_PROVEN_PATHS) {
    return { state: "too-large", evidence: noReview(pr, `The change ${sha12(pr.changeSha)} touches ${pr.changed.files} files, too many for a review to show it covered them all (the limit is ${MAX_PROVEN_PATHS}). No review is started; look at it and merge it yourself.`) };
  }
  const base = dedicated ?? own;
  // Every provider wrote part of it (or an author is unknown): no review can cure that, so none is started.
  if (nobodyIndependent(s, pr)) return { ...base, state: "blocked", evidence: { ...base.evidence, ok: false, reason: nobodyReason(pr) } };
  if (pr.counters.reviews >= PR_LIMITS.reviews) {
    return { ...base, state: "limit", evidence: { ...base.evidence, reason: `${base.evidence.reason} ${PR_LIMITS.reviews} dedicated reviews were already started for this pull request. Ask for another yourself, or merge it yourself.` } };
  }
  return base;
}

/**
 * Review evidence for a pull request's change: the task's own review when it provably
 * covers the final change and was done by another provider than the author, else a finished dedicated
 * review of exactly that change. Evidence always names the change it is for.
 */
export function reviewCoverage(s: State, t: Task): ReviewEvidence {
  return reviewView(s, t).evidence;
}

/** Create the dedicated review task. Mutates the draft `s`. */
function startReview(s: State, t: Task, pr: PrDelivery, now: string, actor: "user" | "system"): string {
  const h = sha12(pr.changeSha);
  const ids = new Set(s.tasks.map((x) => x.id));
  let k = 1;
  while (ids.has(`${t.id}-RV${k}`)) k++;
  const id = `${t.id}-RV${k}`;
  // The dedicated review pipeline is the service's own; no flow file can replace it.
  // It carries a security review beside the code review; both are independent of the writer,
  // and the findings of either gate the merge (`judge` counts every review role).
  const review = internalFlow("delivery-review");
  const defs = review.steps.map(toDef);
  const named = new Set<RoleId>();
  for (const d of defs) {
    if (d.role !== "code_reviewer" && d.role !== "security_reviewer") continue;
    // The independence rule is not the pipeline's to drop.
    d.independentOf = "writer";
    if (!named.has(d.role)) d.purpose = `${d.role === "security_reviewer" ? "Security review of" : "Review"} ${t.id} for merge into ${pr.base} at ${h}`;
    named.add(d.role);
  }
  // The hash is of the steps that run, with the rewritten purpose and the independence rule, so it names exactly what ran.
  const flow: FlowRef = { ...flowRef(review, "service"), hash: flowHash(defs) };
  const content: SpecContent = structuredClone(M.currentSpec(t).content);
  const title = content.title;
  content.title = `Review for merge: ${title}`;
  content.whyNow = `${pr.review.reason} A pull request merges only after a review by ${s.project.prDelivery.reviewer === "any-agent" ? "an agent" : "another provider than the one that wrote the change"}.`;
  content.benefit = "The change is looked at independently before it reaches the base branch.";
  const selected = content.options.find((o) => o.id === content.selectedOptionId);
  if (selected) selected.approach = `Review the change ${h} of ${t.id} against its specification. This is a review, not a second implementation. Original approach: ${clip(selected.approach, 600)}`;
  s.tasks.push({
    id,
    priority: t.priority,
    lifecycle: "ready",
    hold: false,
    holdBeforeStart: false,
    specs: [{ rev: 1, at: now, author: "system", reason: `Independent review of ${t.id} (${h}) before it merges into ${pr.base}`, content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    reviewTarget: { taskId: t.id, n: pr.n, headSha: pr.changeSha, baseSha: pr.baseSha },
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "system", reason: "Created from the Delivery review flow", steps: defs.map(toDef), flow }],
    flow,
    flowSince: 1,
  });
  pr.reviewTaskIds.push(id);
  pr.counters.reviews += 1;
  event(s, now, actor, "integration", `Independent review ${id} created for ${prName(pr)} at ${h}: ${clip(pr.review.reason, 200)}`, t.id);
  return id;
}

/**
 * Make sure one dedicated review exists when the change needs one: coverage failed for a
 * reason a review can cure, and no review of this change exists or is running. Never for open
 * findings (those go to repair), never a second one for the same change, never past the cap.
 */
export function ensureReview(state: State, taskId: string, now: string): State {
  const { task, pr } = prTask(state, taskId);
  if (pr.phase !== "built" && pr.phase !== "open") return state;
  // Nothing new is started while delivery is off, the project is paused or the pull request is held.
  if (!mayStartWork(state, pr)) return state;
  const v = reviewView(state, task);
  if (v.state !== "missing" && v.state !== "not-independent") return state;
  const s = structuredClone(state);
  const t = getTask(s, taskId);
  const p = t.integration!.pr!;
  p.review = v.evidence;
  startReview(s, t, p, now, "system");
  p.review = reviewView(s, t).evidence;
  refreshAttention(s, t, now);
  return s;
}

/** May the service start a review or a fix for this pull request now? Not while anything is paused, held, taken over or closing. */
export function mayStartWork(s: State, pr: PrDelivery): boolean {
  return s.project.prDelivery.enabled && !s.project.hold && !pr.userHold && !pr.foreignHead && !pr.closeRequested && !stuck(pr) && !wrongRepo(s, pr);
}

/** The user asks for a dedicated review now. They may exceed the service's cap; one at a time per change. */
export function requestPrReview(state: State, taskId: string, now: string): State {
  const s = structuredClone(state);
  const { task, pr } = openPr(s, taskId, "review");
  if (!s.project.prDelivery.enabled) throw new ControlError("Pull-request delivery is off, so no review is started. Switch the delivery mode back on first.");
  const open = reviewTasksFor(s, task, pr).find((x) => x.lifecycle !== "done");
  if (open) throw new ControlError(`${open.id} is already reviewing this change.`);
  // A review that could never count is not started: no provider reviews its own work.
  if (nobodyIndependent(s, pr)) throw new ControlError(nobodyReason(pr));
  startReview(s, task, pr, now, "user");
  pr.review = reviewView(s, task).evidence;
  refreshAttention(s, task, now);
  return s;
}
