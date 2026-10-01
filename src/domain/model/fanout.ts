// Fan-out: loop steps add iterations, and breakdown outputs create child tasks. Also the task tree
// (childTasks, descendants, rootOf) that the controls and steering walk.

import { toDef, validatePipeline } from "../pipeline";
import { type InputRef, type State, type Step, type StepDef, type Task } from "../types";
import { acceptedOutput, fromEarlierFlow } from "./artifacts";
import { currentSpec, event, findStep, getTask, isOpen, nextRevisionFor, touch } from "./core";
import { type LeadProposal, proposeTask, validateProposal } from "./leadOutput";
import { prerequisiteReady } from "./presentation";

export const baseId = (id: string) => id.replace(/-i\d+$/, "");
const uniqueRefs = (refs: InputRef[]) => refs.filter((r, i) => refs.findIndex((x) => x.step === r.step && x.output === r.output) === i);

function steplist(t: Task): StepDef[] {
  return t.steps.map(toDef);
}

function recordRevision(s: State, t: Task, reason: string, now: string) {
  t.pipelineRev += 1;
  t.pipelineHistory.push({ rev: t.pipelineRev, at: now, author: "lead", reason, steps: steplist(t) });
  event(s, now, "lead", "pipeline", `Pipeline r${t.pipelineRev}: ${reason}`, t.id);
}

/**
 * Append the next iteration of a loop body (the steps from `iterate.from` to `st`). New steps depend
 * on the previous iteration; inputs that came from outside the body are re-pointed to the previous
 * iteration's newest output of the same kind (for example the repaired change instead of the first
 * one). Steps after the loop also wait for, and read, the new iteration.
 */
export function expandIteration(s: State, t: Task, st: Step, now: string) {
  const it = st.iterate!;
  const n = (st.iteration ?? 1) + 1;
  if (n > it.max) return;
  const from = t.steps.findIndex((x) => x.id === it.from);
  const to = t.steps.indexOf(st);
  if (from < 0 || from > to) return;
  const body = t.steps.slice(from, to + 1);
  const idMap = new Map(body.map((b) => [b.id, `${baseId(b.id)}-i${n}`]));
  if ([...idMap.values()].some((id) => t.steps.some((x) => x.id === id))) return;
  // Newest producer in the finished iteration for each artifact kind.
  const producerOfKind = new Map<string, InputRef>();
  for (const b of body) for (const o of b.outputs) producerOfKind.set(o.kind, { step: b.id, output: o.name });
  const kindOf = (r: InputRef) => findStep(t, r.step)?.outputs.find((o) => o.name === r.output)?.kind;
  const remap = (r: InputRef): InputRef => {
    if (idMap.has(r.step)) return { step: idMap.get(r.step)!, output: r.output };
    const k = kindOf(r);
    return (k && producerOfKind.get(k)) || r;
  };
  const copies: Step[] = body.map((b, i) => {
    const c: Step = {
      ...structuredClone(b),
      id: idMap.get(b.id)!,
      purpose: `${b.purpose.replace(/ \(iteration \d+\)$/, "")} (iteration ${n})`,
      revision: nextRevisionFor(s, t, idMap.get(b.id)!),
      state: t.hold ? "paused" : "pending",
      iteration: n,
      // Inside the body keep the structure; anything that depended on work before the loop now
      // depends on the previous iteration's end, so it reads the newest outputs.
      dependsOn: i === 0 ? [st.id] : [...new Set(b.dependsOn.map((d) => idMap.get(d) ?? st.id))],
      inputs: uniqueRefs(b.inputs.map(remap)),
      runIf: b.runIf && uniqueRefs(b.runIf.map(remap)),
      invalidatedBy: undefined,
      blockedReason: undefined,
      autoRetries: 0,
    };
    if (!c.runIf) delete c.runIf;
    if (b === st) c.iterate = { from: idMap.get(it.from)!, max: it.max };
    else delete c.iterate;
    return c;
  });
  const before = structuredClone(t.steps);
  delete st.iterate; // the loop continues from the new last step
  t.steps.splice(to + 1, 0, ...copies);
  const last = copies[copies.length - 1].id;
  for (const d of t.steps) {
    if (idMap.has(d.id) || copies.some((c) => c.id === d.id)) continue;
    if (d.dependsOn.includes(st.id)) d.dependsOn = [...new Set([...d.dependsOn, last])];
    const extra = d.inputs.filter((r) => idMap.has(r.step)).map((r) => ({ step: idMap.get(r.step)!, output: r.output }));
    if (extra.length) d.inputs = [...d.inputs, ...extra];
  }
  const issues = validatePipeline(steplist(t)).filter((i) => i.severity === "error");
  if (issues.length) {
    // Never leave an invalid pipeline behind: restore it exactly and record why.
    t.steps = before;
    event(s, now, "system", "blocked", `Could not add iteration ${n}: ${issues[0].message}`, t.id);
    return;
  }
  recordRevision(s, t, `Iteration ${n} of ${body.map((b) => b.id).join(" → ")}`, now);
}

export function childTasks(s: State, t: Task): Task[] {
  return s.tasks.filter((x) => x.parentTaskId === t.id);
}

/**
 * The child was created by a breakdown made under a flow the task has since left. It stays on the record,
 * labelled, and is never relinked, waited for or reported to the new steps.
 */
export function childFromEarlierFlow(s: State, t: Task, c: Task): boolean {
  if (!c.parentArtifactId) return false;
  const art = s.artifacts.find((a) => a.id === c.parentArtifactId);
  return !!art && fromEarlierFlow(s, t, art);
}

/** The children of the task's current flow: what breakdowns reconcile with, what waiting steps wait for, and what the envelope reports. */
export function currentChildren(s: State, t: Task): Task[] {
  return childTasks(s, t).filter((c) => !childFromEarlierFlow(s, t, c));
}

/** Children are settled when none is open and, with pull-request delivery, their work is in the base. Children of an earlier flow do not count. */
export function childrenSettled(s: State, t: Task): boolean {
  return currentChildren(s, t).every((c) => !isOpen(c) && (c.lifecycle === "cancelled" || prerequisiteReady(s, c)));
}

/** Every task created, directly or through its children, by breakdowns of `t`. */
export function descendants(s: State, t: Task): Task[] {
  const out: Task[] = [];
  const seen = new Set([t.id]);
  const stack = [t.id];
  while (stack.length) {
    const id = stack.pop()!;
    for (const c of s.tasks) {
      if (c.parentTaskId !== id || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      stack.push(c.id);
    }
  }
  return out;
}

function depth(s: State, t: Task): number {
  let d = 0;
  let cur: Task | undefined = t;
  while (cur?.parentTaskId && d < 10) {
    d++;
    cur = s.tasks.find((x) => x.id === cur!.parentTaskId);
  }
  return d;
}

export function rootOf(s: State, t: Task): Task {
  let cur = t;
  for (let i = 0; cur.parentTaskId && i < 10; i++) {
    const p = s.tasks.find((x) => x.id === cur.parentTaskId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/** At most this many child tasks (all levels, not counting cancelled ones) come from one task you created. */
export const MAX_CHILD_TASKS = 100;
const MAX_ITEMS_PER_BREAKDOWN = 20;

/** Create (or reconcile) the child tasks of a breakdown output, then continue its loop if it has one. */
export function applyBreakdown(s: State, t: Task, stepId: string, output: string, now: string) {
  const st = findStep(t, stepId);
  const art = st && acceptedOutput(s, t, stepId, output);
  if (!st || !art) return;
  const linked = createChildren(s, t, st, art.items ?? [], now, art.id);
  if (st.iterate && linked > 0) expandIteration(s, t, st, now);
}

/**
 * Turn breakdown items into child tasks of `t`. Items use the lead-proposal shape; `approach` alone is
 * enough (the options become "as planned" vs deferring). Items may depend on earlier items by index
 * (0-based) or title. Children follow the same autonomy holds as lead proposals.
 *
 * A newer version of the same step's breakdown (a re-run or an edit) reconciles instead of adding a
 * second batch: children whose title is still listed are kept, unstarted ones that are no longer
 * listed are cancelled, and started ones are kept and reported. Returns how many children the
 * breakdown now has.
 */
function createChildren(s: State, t: Task, st: Step, items: unknown[], now: string, artifactId: string): number {
  if (depth(s, t) >= 2) {
    event(s, now, "system", "blocked", `${st.id}: breakdowns are limited to two levels; no child tasks were created`, t.id);
    return 0;
  }
  const a = s.project.autonomy;
  const holdBeforeStart = !a.enabled || a.holdLeadProposals;
  const root = rootOf(s, t);
  // Only children of the current flow are reconciled; an earlier flow's children are the record.
  const earlier = currentChildren(s, t).filter((c) => c.parentStepId === st.id && c.parentArtifactId !== artifactId && c.lifecycle !== "cancelled");
  const started = (c: Task) => c.lifecycle === "active" || c.lifecycle === "done" || s.attempts.some((x) => x.taskId === c.id);
  const titleOf = (c: Task) => currentSpec(c).content.title.trim().toLowerCase();
  const linked: { id: string; title: string; kept?: boolean }[] = [];
  const rejected: string[] = [];
  const resolveDeps = (raw: unknown) =>
    (Array.isArray(raw) ? raw : [])
      .map((d) => (typeof d === "number" ? linked[d]?.id : linked.find((c) => c.title.toLowerCase() === String(d).toLowerCase())?.id))
      .filter((x): x is string => !!x);
  for (const [i, raw] of items.slice(0, MAX_ITEMS_PER_BREAKDOWN).entries()) {
    try {
      const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const title = typeof it.title === "string" ? it.title.trim() : "";
      const same = title && earlier.find((c) => titleOf(c) === title.toLowerCase() && !linked.some((l) => l.id === c.id));
      if (same) {
        same.parentArtifactId = artifactId;
        if (!started(same)) same.dependsOn = resolveDeps(it.dependsOn);
        linked.push({ id: same.id, title: currentSpec(same).content.title, kept: true });
        continue;
      }
      const approach = typeof it.approach === "string" ? it.approach : "";
      const p = {
        ...it,
        options: Array.isArray(it.options)
          ? it.options
          : [
              { id: "A", name: "As planned", approach, benefit: "", effort: "", risks: "", reversibility: "" },
              { id: "B", name: "Defer", approach: "Do not do this now", benefit: "", effort: "", risks: "", reversibility: "" },
            ],
        recommendedOptionId: typeof it.recommendedOptionId === "string" ? it.recommendedOptionId : "A",
        rationale: typeof it.rationale === "string" && it.rationale.trim() ? it.rationale : `Part of ${t.id}'s breakdown (${st.id}).`,
        // The item's flow; absent, the child default applies.
        ...(it.flowId !== undefined ? { flowId: it.flowId } : {}),
        priority: typeof it.priority === "number" ? it.priority : t.priority,
      } as unknown as LeadProposal;
      const why = validateProposal(s, p, now, "child");
      if (why) {
        rejected.push(`#${i + 1}: ${why}`);
        continue;
      }
      if (descendants(s, root).filter((x) => x.lifecycle !== "cancelled").length >= MAX_CHILD_TASKS) {
        rejected.push(`#${i + 1}: ${root.id} already has ${MAX_CHILD_TASKS} child tasks, the limit per task`);
        continue;
      }
      let k = childTasks(s, t).length + 1;
      while (s.tasks.some((x) => x.id === `${t.id}.${k}`)) k++;
      const id = proposeTask(s, p, now, holdBeforeStart, `${t.id}.${k}`, false, "breakdown");
      const child = getTask(s, id);
      child.parentTaskId = t.id;
      child.parentStepId = st.id;
      child.parentArtifactId = artifactId;
      if (t.hold) {
        child.hold = true;
        child.pausedWith = t.pausedWith ?? t.id;
      }
      child.dependsOn = resolveDeps(it.dependsOn);
      linked.push({ id, title: String(p.title) });
    } catch (err) {
      rejected.push(`#${i + 1}: invalid (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (items.length > MAX_ITEMS_PER_BREAKDOWN) rejected.push(`${items.length - MAX_ITEMS_PER_BREAKDOWN} item${items.length - MAX_ITEMS_PER_BREAKDOWN === 1 ? "" : "s"} beyond the limit of ${MAX_ITEMS_PER_BREAKDOWN} per breakdown`);
  // Children of an earlier version that the new version no longer lists.
  const dropped = earlier.filter((c) => !linked.some((l) => l.id === c.id));
  const cancelled: string[] = [];
  const keptStarted: string[] = [];
  for (const c of dropped) {
    if (started(c)) {
      keptStarted.push(c.id);
      continue;
    }
    c.lifecycle = "cancelled";
    touch(c, now);
    cancelled.push(c.id);
    event(s, now, "lead", "control", `Cancelled: no longer in ${t.id}'s breakdown (${st.id})`, c.id);
  }
  const fresh = linked.filter((l) => !l.kept).map((l) => l.id);
  const kept = linked.filter((l) => l.kept).map((l) => l.id);
  const parts = [
    `${st.id} broke the work into ${linked.length} child task${linked.length === 1 ? "" : "s"}${fresh.length ? `; new: ${fresh.join(", ")}` : ""}`,
    kept.length && `kept ${kept.join(", ")}`,
    cancelled.length && `cancelled ${cancelled.join(", ")} (no longer listed)`,
    keptStarted.length && `${keptStarted.join(", ")} already started and no longer listed; cancel them if they are not needed`,
    holdBeforeStart && fresh.length && "new ones wait for you to start them (autonomy settings)",
    rejected.length && `rejected ${rejected.join("; ")}`,
  ].filter(Boolean);
  event(s, now, "lead", "spec", parts.join("; "), t.id);
  return linked.length;
}
