// Helper agents in words (ORC-031): a run's helpers (the provider's own subagents) as its page shows them, the
// setting "Let research steps start helpers" for one research step, and the notes hint. Pure, so it is tested
// without React. The domain's word is "subagent"; the owner reads "helper agent".

import { providerLabel } from "../domain/model/resolution";
import { fmtUsd, subagentsCost } from "../domain/spend";
import type { StudioRun } from "../domain/studio/types";
import { HELPER_CAP, allowanceOf, researchSteps } from "../domain/subagents";
import { MAX_SUBAGENT_CAP, PROVIDERS, type Attempt, type LeadRun, type State, type Step, type Subagent, type Task } from "../domain/types";

type AnyRun = Attempt | LeadRun | StudioRun;

const isLive = (r: AnyRun) => ("status" in r ? r.status === "running" || r.status === "stopping" : r.outcome === "running" || r.outcome === "stopping");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The cost of a run's helpers: "$0.40, in the run's cost", "$0.40, added to the run's cost; 1 still running", "cost unknown for 1 helper". */
function costWords(r: AnyRun): string {
  const c = subagentsCost(r);
  const known = c.usd > 0 || (!c.unknown && !c.running);
  const where = c.usd === 0 ? "" : c.inParentUsd === c.usd ? ", in the run's cost" : c.inParentUsd === 0 ? ", added to the run's cost" : `, ${fmtUsd(c.inParentUsd)} of it in the run's cost`;
  const parts = [
    ...(known ? [`${fmtUsd(c.usd)}${where}`] : []),
    ...(c.unknown ? [`cost unknown for ${plural(c.unknown, "helper")}`] : []),
    ...(c.running ? [`${c.running} still running`] : []),
  ];
  return parts.join("; ");
}

/** "2 helpers · at most 2 at once · $0.40, in the run's cost"; undefined when the run reported none. */
export function helpersLine(r: AnyRun): string | undefined {
  const rec = r.subagents;
  if (!rec || rec.count === 0) return undefined;
  return `${plural(rec.count, "helper")} · at most ${rec.mostAtOnce} at once · ${costWords(r)}`;
}

/**
 * What the run was allowed: "At most 3 helpers per run", or on Codex "At most 3 helpers at once" (Codex limits them
 * only at once), with what went past it; "None allowed" when it may start none.
 */
export function allowanceLine(r: AnyRun): string {
  const allowed = allowanceOf(r);
  const count = r.subagents?.count ?? 0;
  if (!allowed) return count ? "None allowed: the provider should have switched helpers off for this run." : "None allowed.";
  if (allowed.atOnce) {
    const most = r.subagents?.mostAtOnce ?? 0;
    return `At most ${plural(allowed.cap, "helper")} at once, read-only like the step. The provider limits them only at once, so a run may start more over time.${most > allowed.cap ? ` ${most} ran at once, over the cap.` : ""}`;
  }
  const over = count > allowed.cap ? ` ${count} started, over the cap.` : "";
  return `At most ${plural(allowed.cap, "helper")} per run, read-only like the step.${over}`;
}

/** How one helper ended, in words; a live run's helper with no end yet is running. */
function endWords(r: AnyRun, h: Subagent): string {
  if (h.ended === "refused") return "refused: over the cap";
  if (h.ended) return h.ended;
  return isLive(r) ? "running" : "no end reported";
}

/** One helper: "Find where sync is called · completed · gpt-test". */
export function helperLine(r: AnyRun, h: Subagent): string {
  const asked = h.asked ? `${h.asked}${h.askedCut ? "…" : ""}` : "(its ask was not reported)";
  return [asked, endWords(r, h), h.model].filter(Boolean).join(" · ");
}

/** The helpers past the listed ones: "And 5 more, not listed; their cost is unknown." */
export function unlistedLine(r: AnyRun): string | undefined {
  const n = r.subagents?.unlisted ?? 0;
  return n ? `And ${n} more, not listed; their cost is unknown.` : undefined;
}

/** A run whose helpers started where none is allowed and which the owner has not marked as seen. */
export const helpersUnseen = (r: AnyRun) => !!r.subagents && r.subagents.count > 0 && !allowanceOf(r) && !r.subagents.seenAt;

// ---------- the setting ----------

export interface HelperSetting {
  key: string;
  /** "Investigation · S1 Investigate and gather evidence". */
  label: string;
  /** The cap per run, or null: off. */
  cap: number | null;
  /** Whether it may be turned on: some provider tracks helpers. */
  canTurnOn: boolean;
  /** Where it applies, or why it stays off. */
  why: string;
  /** The cap's field: "Helpers per run, at most", or "Helpers, at most" when a provider counts them at once. */
  capLabel: string;
  /** Beside the cap, for a provider that counts it at once (Codex): what the cap means there. */
  capHint?: string;
}

/** The setting for one research step, or undefined when the key names none. */
export function helperSetting(s: State, key: string): HelperSetting | undefined {
  const step = researchSteps(s).find((r) => r.key === key);
  if (!step) return undefined;
  const providers = s.project.subagentProviders;
  const canTurnOn = providers.length > 0;
  const others = PROVIDERS.some((p) => !providers.includes(p));
  const why = canTurnOn
    ? `It applies to runs on ${providers.map(providerLabel).join(" and ")}.${others ? " Runs on another provider start none." : ""}`
    : "No provider tracks helper agents yet, so this stays off. A provider is turned on only after real runs prove that pause stops its helpers and that their cost is counted.";
  const atOnce = providers.filter((p) => HELPER_CAP[p] === "at once");
  const perRun = providers.filter((p) => HELPER_CAP[p] === "per run");
  const capHint = atOnce.length
    ? `On ${atOnce.map(providerLabel).join(" and ")}: at most this many at once. ${atOnce.length === 1 ? "It limits" : "They limit"} helpers only at once, not per run, so a run may start more over time.${perRun.length ? ` On ${perRun.map(providerLabel).join(" and ")}: at most this many per run.` : ""}`
    : undefined;
  return { key, label: step.label, cap: s.project.researchHelpers[key]?.cap ?? null, canTurnOn, why, capLabel: atOnce.length ? "Helpers, at most" : "Helpers per run, at most", ...(capHint ? { capHint } : {}) };
}

/** The caps the owner may choose, 1 to MAX_SUBAGENT_CAP. */
export const CAP_CHOICES = Array.from({ length: MAX_SUBAGENT_CAP }, (_, i) => i + 1);

// ---------- notes ----------

export const NOTES_TO_PARENT_ONLY = "Helpers do not receive notes; the parent agent does.";

/** Whether a note to this running step should say that it reaches the parent only: research, and its run may have helpers. */
export function notesReachParentOnly(s: State, task: Task, st: Step): boolean {
  if (!st.research) return false;
  const run = s.attempts.find((a) => a.taskId === task.id && a.stepId === st.id && (a.outcome === "running" || a.outcome === "stopping"));
  return !!run && (!!run.snapshot.allowSubagents || (run.subagents?.count ?? 0) > 0);
}
