// ORC-016: presentation helpers for pipeline patterns, shared by the picker (New task, Change pattern, the
// project default), the task page and Settings → Patterns. Pure derivations over domain state; no domain
// logic lives here, and nothing here edits a pipeline.

import type { Pattern, PatternRef, PatternSource, PipelineRevision, ProviderId, RetiredTemplate, StepDef, Task } from "../domain/types";

// ---------- grouping and labels ----------

export type PatternGroupId = "standard" | "pauses" | "experiments" | "unreviewed";

export interface PatternGroup {
  id: PatternGroupId;
  label: string;
  patterns: Pattern[];
}

const GROUP_LABEL: Record<PatternGroupId, string> = {
  standard: "Standard",
  pauses: "Pauses for you",
  experiments: "Experiments",
  unreviewed: "Without an independent review",
};

/** The option group a pattern belongs to: experiments first, then patterns that pause, then unreviewed ones; the rest are standard. */
export function patternGroupOf(p: Pattern): PatternGroupId {
  if (p.experimental) return "experiments";
  if (p.flags.pausesForYou) return "pauses";
  if (p.flags.unreviewed) return "unreviewed";
  return "standard";
}

/** Option groups for a picker, in display order, without empty groups. The catalog order within a group is kept. */
export function patternGroups(patterns: Pattern[]): PatternGroup[] {
  const order: PatternGroupId[] = ["standard", "pauses", "experiments", "unreviewed"];
  return order.map((id) => ({ id, label: GROUP_LABEL[id], patterns: patterns.filter((p) => patternGroupOf(p) === id) })).filter((g) => g.patterns.length > 0);
}

/** "built-in", "yours", "yours, replaces built-in", "internal", "from before patterns" or "custom pipeline". */
export function sourceLabel(source: PatternSource | PatternRef["source"], replacesBuiltIn?: boolean): string {
  switch (source) {
    case "built-in":
      return "built-in";
    case "local":
      return replacesBuiltIn ? "yours, replaces built-in" : "yours";
    case "internal":
      return "internal";
    case "legacy":
      return "from before patterns";
    case "custom":
      return "custom pipeline";
  }
}

/** The text of one `<option>`: the name, then "(yours)" or "(yours, replaces built-in)" for a file of yours. */
export function patternOptionLabel(p: Pattern): string {
  return p.source === "local" ? `${p.name} (${sourceLabel("local", p.replacesBuiltIn)})` : p.name;
}

/** The first 8 hex characters of a content hash, as the UI shows it. */
export function shortHash(hash: string | undefined): string {
  return hash ? hash.slice(0, 8) : "";
}

export interface FlagChip {
  text: string;
  title: string;
}

/** Flag chips for a pattern card: experiment, pauses for you, no independent review, breaks down, yours. The order is fixed. */
export function patternFlagChips(p: Pattern): FlagChip[] {
  const out: FlagChip[] = [];
  if (p.experimental) out.push({ text: "experiment", title: "Marked experimental in its file; only you can choose it, never the lead" });
  if (p.flags.pausesForYou) out.push({ text: "pauses for you", title: "A step has a gate: the task pauses after it until you resume" });
  if (p.flags.unreviewed) out.push({ text: "no independent review", title: "A step changes code and no code reviewer reads the change; only you can choose it" });
  if (p.flags.breaksDown) out.push({ text: "breaks down into child tasks", title: "A step produces a breakdown, which creates child tasks; not for child tasks" });
  if (p.source === "local") out.push({ text: sourceLabel("local", p.replacesBuiltIn), title: `Loaded from ${p.file}` });
  return out;
}

/** Providers the pattern names in `parallel.providers` that are not enabled; the picker warns about them. */
export function disabledProviders(p: Pattern, enabled: ProviderId[]): ProviderId[] {
  return p.flags.needsProviders.filter((x) => !enabled.includes(x));
}

/** Why a pattern is the lead's to use or yours only, in one sentence for the card. */
export function audienceText(p: Pattern): string {
  if (p.audience === "standard")
    return p.flags.breaksDown
      ? "Standard: the lead may choose it, and it can be the project default. Breakdowns may not, because it breaks down into child tasks itself."
      : "Standard: the lead and breakdowns may choose it, and it can be the project default.";
  const why = p.experimental ? "it is an experiment" : p.flags.pausesForYou ? "it pauses for you" : "it has no independent code review";
  return `Yours to choose: ${why}, so the lead never picks it.`;
}

// ---------- the pattern line on the task page ----------

/** The task page's pattern line in two parts: "Pattern: " + "Change"; "From before patterns: " + "Feature"; "" + "Custom pipeline". */
export function patternLineParts(ref: PatternRef): { prefix: string; name: string } {
  if (ref.source === "legacy") return { prefix: "From before patterns: ", name: ref.name };
  if (ref.source === "custom") return { prefix: "", name: "Custom pipeline" };
  return { prefix: "Pattern: ", name: ref.name };
}

/** "Pattern: Change" for a catalog or internal pipeline; "From before patterns: Feature" or "Custom pipeline" otherwise. */
export function patternLineText(ref: PatternRef): string {
  const p = patternLineParts(ref);
  return `${p.prefix}${p.name}`;
}

/** "(a1b2c3d4, built-in)": what follows the name on the task page. Empty for a pipeline without a hash. */
export function patternRefDetail(ref: PatternRef): string {
  const parts = [shortHash(ref.hash), ref.source === "legacy" || ref.source === "custom" ? "" : sourceLabel(ref.source)].filter(Boolean);
  return parts.length ? `(${parts.join(", ")})` : "";
}

/** The tooltip of the hash chip: the full hash, then each file in the `extends` chain. */
export function hashTitle(ref: Pick<PatternRef, "hash" | "chain">): string {
  const lines = [`Content hash ${ref.hash ?? "(none)"}`];
  for (const c of ref.chain ?? []) lines.push(`${c.file} (${c.source}, ${shortHash(c.fileHash)})`);
  return lines.join("\n");
}

/** The pattern in effect at a pipeline revision: the nearest revision at or below `rev` that applied one. */
export function patternAtRev(task: Pick<Task, "pipelineHistory" | "pattern">, rev: number): PatternRef | undefined {
  let found: PipelineRevision | undefined;
  for (const h of task.pipelineHistory) if (h.pattern && h.rev <= rev && (!found || h.rev > found.rev)) found = h;
  return found?.pattern;
}

/** "earlier pattern (r2, Feature)" for an artifact made before the task's pattern changed. */
export function earlierPatternLabel(task: Pick<Task, "pipelineHistory" | "pattern">, rev: number): string {
  const p = patternAtRev(task, rev);
  return `earlier pattern (r${rev}${p ? `, ${p.name}` : ""})`;
}

/** "Change · a1b2c3d4" for a pipeline revision that applied a pattern; undefined for expansions and check rounds. */
export function revisionPatternLabel(rev: Pick<PipelineRevision, "pattern">): string | undefined {
  if (!rev.pattern) return undefined;
  const h = shortHash(rev.pattern.hash);
  return h ? `${rev.pattern.name} · ${h}` : rev.pattern.name;
}

// ---------- the Change pattern panel ----------

export interface ChangePreview {
  redo: string[];
  pinsKept: string[];
  pinsDropped: { step: string; why: "role changed" | "no such step" }[];
  artifactsKept: number;
  decisionsClosed: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The consequences of a pattern change, one plain sentence each, for the panel and for tests. */
export function changeConsequences(preview: ChangePreview): string[] {
  const out: string[] = [];
  if (preview.redo.length) out.push(`${plural(preview.redo.length, "completed step starts", "completed steps start")} over (${preview.redo.join(", ")}); their results stay on the record and are not used again.`);
  else out.push("Nothing has run yet, so the pipeline is simply replaced.");
  if (preview.pinsKept.length) out.push(`Pins kept: ${preview.pinsKept.join(", ")}.`);
  if (preview.pinsDropped.length) out.push(`Pins dropped: ${preview.pinsDropped.map((d) => `${d.step} (${d.why})`).join(", ")}.`);
  if (!preview.pinsKept.length && !preview.pinsDropped.length) out.push("No step has a provider or model pin.");
  if (preview.decisionsClosed) out.push(`${plural(preview.decisionsClosed, "open decision is", "open decisions are")} closed.`);
  if (preview.artifactsKept) out.push(`${plural(preview.artifactsKept, "artifact is", "artifacts are")} kept, labelled "earlier pattern".`);
  return out;
}

/** The pipeline changed under the panel (another tab, the service, a run): the design's "review again" message. */
export const PIPELINE_CHANGED_MESSAGE = "The pipeline changed while you were choosing; review again.";

/** True when choosing `p` would do nothing: the task already runs this pattern at this hash and source. */
export function samePattern(current: PatternRef, p: Pattern): boolean {
  return current.id === p.id && current.hash === p.hash && current.source === p.source;
}

// ---------- Settings → Patterns ----------

/** The note under the default picker when the stored default is no longer a standard pattern in the catalog. */
export function defaultPatternNote(stored: string, standard: Pattern[], effective: Pattern): string | undefined {
  if (standard.some((p) => p.id === stored)) return undefined;
  return `Using ${effective.name}: "${stored}" is no longer a standard pattern in the catalog.`;
}

/** "file:line:column" or "file" for a load error, as Settings lists it. */
export function errorLocation(e: { file: string; line?: number; column?: number }): string {
  return e.line !== undefined ? `${e.file}:${e.line}:${e.column ?? 1}` : e.file;
}

/** "Patterns loaded: 11 (2 yours); 1 file with errors" for the Settings summary. */
export function catalogSummary(c: { patterns: Pattern[]; errors: { file: string }[] }): string {
  const yours = c.patterns.filter((p) => p.source === "local").length;
  const bad = new Set(c.errors.map((e) => e.file)).size;
  return `${plural(c.patterns.length, "pattern", "patterns")}${yours ? ` (${yours} yours)` : ""}${bad ? `; ${plural(bad, "file", "files")} with errors` : ""}`;
}

/**
 * The pattern file a retired template would become, for the read-only copy box when the export failed. It
 * mirrors the server's export (`retiredTemplateFile`): steps normalised, `copyOf`, `iteration` and
 * `checks.only` left out, best-of made an experiment. The server cannot be imported into the UI bundle.
 */
export function retiredTemplateJson(t: RetiredTemplate): string {
  const steps = t.steps.map((s) => {
    const d: StepDef & Record<string, unknown> = { ...s };
    delete d.copyOf;
    delete d.iteration;
    if (d.checks?.only?.length) d.checks = { onFail: d.checks.onFail };
    return d;
  });
  const bestOf = steps.some((s) => s.parallel?.mode === "best-of");
  const experiment = t.internal ? "Exported from your edited internal template; review before use" : bestOf ? "Edit this file to say what the best-of experiment should show." : undefined;
  const id = t.exportedId ?? (t.kind === "edited-built-in" ? `${t.id}-yours` : t.id);
  const file = {
    $schema: "./pattern.schema.json",
    $comment: `Saved from your template "${t.name}" when pipelines became patterns (ORC-016).`,
    id,
    name: (t.kind === "edited-built-in" ? `${t.name} (yours)` : t.name).trim().slice(0, 60) || id,
    description: t.description.trim().slice(0, 300) || "Saved from your template.",
    whenToUse: "Your template from before patterns. Edit this file to say when to use it.",
    ...(experiment ? { experimental: true, hypothesis: experiment } : {}),
    steps,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The annotated two-line variant from the README, shown under "How patterns work". */
export const EXAMPLE_VARIANT = `{
  "$schema": "./pattern.schema.json",
  "id": "bugfix-pause-after-repro",      // must match the file name
  "name": "Bug fix, pause after the reproduction",
  "description": "Bug fix that stops after the reproduction so you can read it before the fix starts.",
  "whenToUse": "Bugs where a wrong reproduction would waste the fix.",
  "extends": "bugfix",                   // start from the built-in Bug fix
  "stepOverrides": {
    "S1": { "gate": true },              // pause after S1, Reproduce and diagnose
  },
}`;
