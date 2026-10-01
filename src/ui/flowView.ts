// ORC-021: presentation helpers for flows, shared by the picker (New task, Change flow, the project
// default), the task page and Settings → Flows. Pure derivations over domain state; no domain logic
// lives here, and nothing here edits a pipeline.

import { principleName } from "../domain/principles";
import type { Flow, FlowRef, GivenPrinciple, PipelineRevision, Task } from "../domain/types";

// ---------- the flow line on the task page ----------

/** The task page's flow line in two parts: "Flow: " + "Change"; "From before flows: " + "Feature"; "" + "Custom pipeline". A task that ran a personal file keeps its name. */
export function flowLineParts(ref: FlowRef): { prefix: string; name: string } {
  if (ref.source === "legacy") return { prefix: "From before flows: ", name: ref.name };
  if (ref.source === "local") return { prefix: "From your own file (no longer used): ", name: ref.name };
  if (ref.source === "custom") return { prefix: "", name: "Custom pipeline" };
  return { prefix: "Flow: ", name: ref.name };
}

/** "Flow: Change" for a built-in or internal pipeline; "From before flows: Feature" or "Custom pipeline" otherwise. */
export function flowLineText(ref: FlowRef): string {
  const p = flowLineParts(ref);
  return `${p.prefix}${p.name}`;
}

/** The flow in effect at a pipeline revision: the nearest revision at or below `rev` that applied one. */
export function flowAtRev(task: Pick<Task, "pipelineHistory" | "flow">, rev: number): FlowRef | undefined {
  let found: PipelineRevision | undefined;
  for (const h of task.pipelineHistory) if (h.flow && h.rev <= rev && (!found || h.rev > found.rev)) found = h;
  return found?.flow;
}

/** "earlier flow (r2, Feature)" for an artifact made before the task's flow changed. */
export function earlierFlowLabel(task: Pick<Task, "pipelineHistory" | "flow">, rev: number): string {
  const p = flowAtRev(task, rev);
  return `earlier flow (r${rev}${p ? `, ${p.name}` : ""})`;
}

/** The flow's name for a pipeline revision that applied one; undefined for expansions and check rounds. */
export function revisionFlowLabel(rev: Pick<PipelineRevision, "flow">): string | undefined {
  return rev.flow?.name;
}

// ---------- ORC-024: principles on the task page ----------

/**
 * The step's principles line: "Principles: Laziness protocol · Fix root causes · + Attack the premise
 * (added: check `test` failed again after S3)". An automatic one is marked "+" with its recorded reason.
 * Empty for a run that recorded none (older runs) and for a step without principles.
 */
export function principlesText(given: readonly (Pick<GivenPrinciple, "id"> & Partial<GivenPrinciple>)[] | undefined): string {
  if (!given?.length) return "";
  return `Principles: ${given.map((g) => (g.added ? `+ ${principleName(g.id)} (${g.added})` : principleName(g.id))).join(" · ")}`;
}

// ---------- the Change flow panel ----------

export interface ChangePreview {
  redo: string[];
  pinsKept: string[];
  pinsDropped: { step: string; why: "role changed" | "no such step" }[];
  artifactsKept: number;
  decisionsClosed: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The consequences of a flow change, one plain sentence each, for the panel and for tests. */
export function changeConsequences(preview: ChangePreview): string[] {
  const out: string[] = [];
  if (preview.redo.length) out.push(`${plural(preview.redo.length, "completed step starts", "completed steps start")} over (${preview.redo.join(", ")}); their results stay on the record and are not used again.`);
  else out.push("Nothing has run yet, so the pipeline is simply replaced.");
  if (preview.pinsKept.length) out.push(`Pins kept: ${preview.pinsKept.join(", ")}.`);
  if (preview.pinsDropped.length) out.push(`Pins dropped: ${preview.pinsDropped.map((d) => `${d.step} (${d.why})`).join(", ")}.`);
  if (!preview.pinsKept.length && !preview.pinsDropped.length) out.push("No step has a provider or model pin.");
  if (preview.decisionsClosed) out.push(`${plural(preview.decisionsClosed, "open decision is", "open decisions are")} closed.`);
  if (preview.artifactsKept) out.push(`${plural(preview.artifactsKept, "artifact is", "artifacts are")} kept, labelled "earlier flow".`);
  return out;
}

/** The pipeline changed under the panel (another tab, the service, a run): the design's "review again" message. */
export const PIPELINE_CHANGED_MESSAGE = "The pipeline changed while you were choosing; review again.";

/** True when choosing `p` would do nothing: the task already runs this flow at this version. */
export function sameFlow(current: FlowRef, p: Flow): boolean {
  return current.id === p.id && current.hash === p.hash && current.source === p.source;
}

// ---------- Settings → Flows ----------

/** The note under the default select when the stored default is not one of the six; empty otherwise. */
export function defaultFlowNote(stored: string, flows: Flow[], effective: Flow): string | undefined {
  if (flows.some((p) => p.id === stored)) return undefined;
  return `Using ${effective.name}: "${stored}" is not one of the flows.`;
}
