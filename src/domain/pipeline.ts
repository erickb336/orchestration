// Pure pipeline helpers: validation, instantiation, and structural comparison.

import { isPrincipleId, orderPrinciples } from "./principles";
import { REVIEW_ROLES, STEP_ROLES, type InputRef, type Step, type StepDef } from "./types";

export function instantiate(defs: StepDef[]): Step[] {
  return structuredClone(defs).map((d) => ({ ...d, selection: null, revision: 1, state: "pending" as const }));
}

export function toDef(st: StepDef): StepDef {
  const d: StepDef = { id: st.id, purpose: st.purpose, role: st.role, dependsOn: [...st.dependsOn], inputs: structuredClone(st.inputs), outputs: structuredClone(st.outputs) };
  if (st.runIf?.length) d.runIf = structuredClone(st.runIf);
  if (st.gate) d.gate = true;
  if (st.iterate) d.iterate = { ...st.iterate };
  if (st.parallel) d.parallel = { ...st.parallel, ...(st.parallel.providers ? { providers: [...st.parallel.providers] } : {}) };
  if (st.waitForChildren) d.waitForChildren = true;
  if (st.independentOf) d.independentOf = st.independentOf;
  if (st.copyOf) d.copyOf = st.copyOf;
  if (st.iteration && st.iteration > 1) d.iteration = st.iteration;
  if (st.checks) d.checks = { onFail: st.checks.onFail, ...(st.checks.only?.length ? { only: [...st.checks.only] } : {}) };
  // ORC-024: part of what the agent receives, so part of the definition and of the flow hash; table order, no duplicates.
  if (st.principles?.length) d.principles = orderPrinciples(st.principles);
  return d;
}

/** Fields whose change alters what a step does or receives. Purpose is the worker's instruction, so it counts. */
export function structuralKey(st: StepDef): string {
  const refs = (xs: InputRef[] = []) => xs.map((x) => `${x.step}.${x.output}`).sort();
  return JSON.stringify({
    purpose: st.purpose.trim(),
    role: st.role,
    deps: [...st.dependsOn].sort(),
    inputs: refs(st.inputs),
    outputs: st.outputs.map((o) => `${o.name}:${o.kind}`).sort(),
    runIf: refs(st.runIf),
    iterate: st.iterate ?? null,
    parallel: st.parallel ?? null,
    waitForChildren: !!st.waitForChildren,
    ...(st.independentOf ? { independentOf: st.independentOf } : {}),
    ...(st.checks ? { checks: { onFail: st.checks.onFail, only: [...(st.checks.only ?? [])].sort() } } : {}),
    ...(st.principles?.length ? { principles: orderPrinciples(st.principles) } : {}),
  });
}

/** Steps reachable upstream from `id` through dependencies. */
export function upstreamOf(defs: StepDef[], id: string): Set<string> {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(byId.get(x)?.dependsOn ?? []));
  }
  return seen;
}

/** Steps that depend, directly or transitively, on any of `ids`. */
export function downstreamOf(defs: StepDef[], ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const frontier = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of defs) {
      if (out.has(d.id) || frontier.has(d.id)) continue;
      if (d.dependsOn.some((x) => frontier.has(x) || out.has(x))) {
        out.add(d.id);
        changed = true;
      }
    }
  }
  return out;
}

export interface PipelineIssue {
  step?: string;
  severity: "error" | "warning";
  message: string;
}

/** Kinds a step may be conditioned on: findings artifacts, whose open count decides whether it runs. */
const CONDITION_KINDS = new Set(["review-findings", "check-results"]);
const MAX_CHECK_ONLY = 8;

/**
 * Validate a pipeline. Errors block saving; warnings are advisory. `reviewTarget`: the task is a
 * dedicated review of a pull request, whose reviewer is handed the change by the service, so a review
 * step without inputs is expected there. `checkTarget` (ORC-013): the task is a dedicated check run of
 * a pull request's change, so a checks step without a code-change input is expected there.
 * `checkIds`: the configured check commands; a step's `only` may name nothing else (M2).
 */
export function validatePipeline(defs: StepDef[], opts: { reviewTarget?: boolean; checkTarget?: boolean; checkIds?: string[] } = {}): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const err = (step: string | undefined, message: string): undefined => {
    issues.push({ step, severity: "error", message });
    return undefined;
  };
  if (defs.length === 0) err(undefined, "A pipeline needs at least one step.");
  const seen = new Set<string>();
  // ORC-013: the steps inside a loop body, so a blocking checks step is never repeated.
  const inLoop = new Set<string>();
  defs.forEach((d, i) => {
    if (!d.iterate) return;
    const fromIdx = defs.findIndex((x) => x.id === d.iterate!.from);
    if (fromIdx >= 0 && fromIdx <= i) for (const b of defs.slice(fromIdx, i + 1)) inLoop.add(b.id);
  });
  defs.forEach((d, i) => {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(d.id)) err(d.id || undefined, `Step ${i + 1} ID "${d.id}" must start with a letter and use only letters, digits, or hyphens.`);
    else if (seen.has(d.id)) err(d.id, `Duplicate step ID ${d.id}.`);
    seen.add(d.id);
    if (!d.purpose.trim()) err(d.id, `${d.id} needs a purpose.`);
    if (!STEP_ROLES.includes(d.role)) err(d.id, `${d.id} has an unknown role "${String(d.role)}".`);
    // ORC-024: a principle is one of the files in principles/; a checks step is run by the service and gets none.
    for (const p of d.principles ?? []) if (!isPrincipleId(p)) err(d.id, `${d.id} names a principle that does not exist: "${String(p)}".`);
    if (d.role === "checks" && d.principles?.length) err(d.id, `${d.id} is a Checks step, run by the service; it takes no principles.`);
    const earlier = new Set(defs.slice(0, i).map((x) => x.id));
    for (const dep of d.dependsOn) {
      if (dep === d.id) err(d.id, `${d.id} cannot depend on itself.`);
      else if (!earlier.has(dep)) err(d.id, `${d.id} depends on ${dep}, which is not an earlier step.`);
    }
    const names = new Set<string>();
    for (const o of d.outputs) {
      if (!/^[a-z][a-z0-9-]*$/.test(o.name)) err(d.id, `${d.id} output "${o.name}" must be lowercase letters, digits, or hyphens.`);
      if (names.has(o.name)) err(d.id, `${d.id} has two outputs named ${o.name}.`);
      names.add(o.name);
      if (o.kind === "check-results" && d.role !== "checks") err(d.id, `${d.id} produces check results, which only a Checks step (run by the service) can produce.`);
    }
    const up = upstreamOf(defs.slice(0, i + 1), d.id);
    const checkRef = (r: InputRef, what: string) => {
      const src = defs.find((x) => x.id === r.step);
      if (!src || !up.has(r.step)) return err(d.id, `${d.id} ${what} ${r.step}.${r.output}, but ${r.step} is not upstream of it.`);
      const out = src.outputs.find((o) => o.name === r.output);
      if (!out) return err(d.id, `${d.id} ${what} ${r.step}.${r.output}, which ${r.step} does not produce.`);
      return out;
    };
    for (const r of d.inputs) checkRef(r, "reads");
    for (const r of d.runIf ?? []) {
      const out = checkRef(r, "is conditioned on");
      if (out && !CONDITION_KINDS.has(out.kind)) err(d.id, `${d.id} can only be conditioned on review findings or check results; ${r.step}.${r.output} is ${out.kind}.`);
    }
    if (d.iterate) {
      const fromIdx = defs.findIndex((x) => x.id === d.iterate!.from);
      if (fromIdx < 0 || fromIdx > i) err(d.id, `${d.id} loops back to ${d.iterate.from}, which must be this step or an earlier one.`);
      if (!Number.isInteger(d.iterate.max) || d.iterate.max < 1 || d.iterate.max > 10) err(d.id, `${d.id} can loop 1–10 times.`);
    }
    if (d.parallel) {
      if (!Number.isInteger(d.parallel.count) || d.parallel.count < 2 || d.parallel.count > 5) err(d.id, `${d.id} can run 2–5 parallel agents.`);
      if (d.parallel.mode !== "copies" && d.parallel.mode !== "best-of") err(d.id, `${d.id} parallel mode must be "copies" or "best-of".`);
      const chooser = defs.slice(i + 1).find((x) => x.inputs.some((r) => r.step === d.id));
      if (d.parallel.mode === "best-of" && !chooser) err(d.id, `${d.id} is best-of, so a later step must read its output to choose one.`);
      if (d.parallel.mode === "best-of" && d.runIf?.length) err(d.id, `${d.id} is best-of, so it must always run (remove its condition).`);
      if (d.parallel.mode === "best-of" && chooser?.runIf?.length) err(chooser.id, `${chooser.id} chooses among ${d.id}'s candidates, so it must always run (remove its condition).`);
      if (d.parallel.mode === "best-of" && chooser?.parallel) err(chooser.id, `${chooser.id} chooses among ${d.id}'s candidates, so it cannot itself run in parallel.`);
      if (d.parallel.mode === "copies" && d.outputs.some((o) => o.kind === "code-change")) err(d.id, `${d.id} changes code, and parallel copies cannot all be merged; use best-of to pick one.`);
      if (d.outputs.some((o) => o.kind === "breakdown")) err(d.id, `${d.id} creates child tasks, so it cannot run in parallel.`);
    }
    if (d.iterate) {
      // Loop bodies: no parallel steps inside (their copies cannot be repeated), and no overlaps.
      const fromIdx = defs.findIndex((x) => x.id === d.iterate!.from);
      if (fromIdx >= 0 && fromIdx <= i) {
        const body = defs.slice(fromIdx, i + 1);
        const par = body.find((x) => x.parallel || (x.copyOf && x.copyOf !== x.id));
        if (par) err(d.id, `${d.id}'s loop contains ${par.id}, which runs in parallel; parallel steps cannot be inside a loop.`);
        const other = body.find((x) => x !== d && x.iterate);
        if (other) err(d.id, `${d.id}'s loop overlaps ${other.id}'s loop; loops cannot overlap or nest.`);
      }
    }
    // ORC-013: a Checks step is run by the service on a code change; it produces check results and nothing else.
    if (d.role === "checks") {
      if (d.outputs.length !== 1 || d.outputs[0].kind !== "check-results") err(d.id, `${d.id} is a Checks step, so it produces exactly one output of kind check-results.`);
      const readsChange = d.inputs.some((r) => defs.find((x) => x.id === r.step)?.outputs.find((o) => o.name === r.output)?.kind === "code-change");
      if (!readsChange && !opts.checkTarget) err(d.id, `${d.id} is a Checks step, so it must read a code change to check.`);
      if (d.parallel || d.independentOf || d.iterate) err(d.id, `${d.id} is a Checks step, which cannot run in parallel, require independence, or end a loop.`);
      if (d.checks && d.checks.onFail !== "findings" && d.checks.onFail !== "block") err(d.id, `${d.id}: when checks fail, choose "findings" (for the repair step) or "block" (stop and ask for a decision).`);
      if ((d.checks?.only?.length ?? 0) > MAX_CHECK_ONLY) err(d.id, `${d.id} can name at most ${MAX_CHECK_ONLY} commands.`);
      if (opts.checkIds && d.checks?.only?.length) {
        const unknown = d.checks.only.filter((id) => !opts.checkIds!.includes(id));
        if (unknown.length) err(d.id, `${d.id} names checks that do not exist: ${unknown.join(", ")}. The configured checks are ${opts.checkIds.join(", ") || "none"} (Settings → Checks).`);
      }
      if (d.checks?.onFail === "block" && inLoop.has(d.id)) err(d.id, `${d.id} stops the task when checks fail, so it cannot be inside a loop; use "findings" there.`);
    }
    if (REVIEW_ROLES.includes(d.role) && d.inputs.length === 0 && !opts.reviewTarget) issues.push({ step: d.id, severity: "warning", message: `${d.id} is a review with no inputs, so it has nothing specific to review.` });
    if (d.outputs.length === 0) issues.push({ step: d.id, severity: "warning", message: `${d.id} produces no artifacts, so later steps cannot use its work.` });
  });
  // ORC-013: a pipeline that changes code with no Checks step runs no service checks on the change.
  if (defs.some((d) => d.outputs.some((o) => o.kind === "code-change")) && !defs.some((d) => d.role === "checks")) {
    issues.push({ severity: "warning", message: "No service checks run on this change: add a Checks step (run by the service) to run the project's checks on it." });
  }
  return issues;
}

/** A new step ID never used in this draft or in `reserved` (IDs the task has ever used). */
export function nextStepId(defs: StepDef[], reserved: Iterable<string> = []): string {
  const ids = new Set([...defs.map((d) => d.id), ...reserved]);
  let n = defs.length + 1;
  while (ids.has(`S${n}`)) n++;
  return `S${n}`;
}
