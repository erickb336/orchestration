// The studio runs' principles and the check of what they write for the owner (ORC-029 pass 4d-2b).
//
// A designer's and a PE's envelope get a "Principles for this run" section through the builder task steps use
// (server/envelope.ts), under the same cap: the every-run principles and a small set of the role's own
// (STUDIO_PRINCIPLE_IDS). Each run records them at dispatch, with their hashes, as a task run's snapshot does.
//
// What they write for the owner is checked as the lead's replies are (server/prose/): the PE's reasons, changes and
// open cases (pe.ts reads them), and the designer's documents (runs.ts). The check runs in the scheduler outside the
// store's transaction, and the record goes on the run when its result is recorded. The next run of the same role in
// the project is told which rules its role's last checked text broke, in the lead's feedback block.

import { STUDIO_PRINCIPLE_IDS, orderPrinciples, principle } from "../../src/domain/principles";
import type { StudioRun } from "../../src/domain/studio/types";
import type { GivenPrinciple, ProseCheck, State } from "../../src/domain/types";
import { LEAD_PRINCIPLES_HEADER, PRINCIPLES_WORD_CAP, principlesSection, proseFeedbackBlock, type ProseFeedbackWords } from "../envelope";

/** The principles a run of this kind is given, in table order, each with the hash of its body. A probe gets none. */
export function studioPrinciples(kind: StudioRun["kind"]): GivenPrinciple[] {
  if (kind === "probe") return [];
  return orderPrinciples(STUDIO_PRINCIPLE_IDS[kind]).map((id) => ({ id, hash: principle(id)?.hash ?? "" }));
}

/** What a run was given: its record from dispatch, else what dispatch records now (an envelope built for a run not yet dispatched). */
export const givenStudioPrinciples = (run: StudioRun): GivenPrinciple[] => run.principles ?? studioPrinciples(run.kind);

/** The state with each run just dispatched carrying the principles its envelope gives it. */
export function withStudioPrinciples(s: State, started: readonly string[]): State {
  if (!started.length) return s;
  return { ...s, studio: { ...s.studio, runs: s.studio.runs.map((r) => (started.includes(r.id) ? { ...r, principles: studioPrinciples(r.kind) } : r)) } };
}

/**
 * The run's "Principles for this run" section, as envelope lines (then an empty line); none when it has none. A
 * studio run is not a step, so it takes the lead's header.
 */
export function studioPrinciplesLines(run: StudioRun): string[] {
  return lines(principlesSection(givenStudioPrinciples(run), PRINCIPLES_WORD_CAP, LEAD_PRINCIPLES_HEADER));
}

/** The state with the check on the run, when the run completed (a run stopped, failed or gone keeps none). */
export function withStudioProse(s: State, runId: string, check: ProseCheck | undefined): State {
  if (!check || !s.studio.runs.some((r) => r.id === runId && r.status === "completed")) return s;
  return { ...s, studio: { ...s.studio, runs: s.studio.runs.map((r) => (r.id === runId ? { ...r, prose: check } : r)) } };
}

/**
 * The newest check of the run's role that was recorded before the run started: the role's last checked text, which
 * the run is told about. Studio runs overlap, so it is the newest check, not the run listed last; a check recorded
 * after the run started was not in its envelope. Undefined when the role has none yet.
 */
export function lastStudioProse(s: State, run: StudioRun): ProseCheck | undefined {
  let last: ProseCheck | undefined;
  for (const r of s.studio.runs) {
    if (r.id === run.id || r.kind !== run.kind || r.status !== "completed" || !r.prose) continue;
    if (run.startedAt && r.prose.at >= run.startedAt) continue;
    if (!last || r.prose.at >= last.at) last = r.prose;
  }
  return last;
}

/** How the feedback names each role's text. */
const FEEDBACK_WORDS: Record<"designer" | "pe", ProseFeedbackWords> = {
  designer: { last: "your last run's documents", now: "this run's documents", reader: "owner" },
  pe: { last: "your last review", now: "this review", reader: "owner" },
};

/** The feedback on the role's last checked text, as envelope lines (then an empty line); none when it broke no rule. */
export function studioFeedbackLines(s: State, run: StudioRun): string[] {
  return run.kind === "probe" ? [] : lines(proseFeedbackBlock(lastStudioProse(s, run), FEEDBACK_WORDS[run.kind]));
}

const lines = (section: string): string[] => (section.trim() ? [section.trim(), ""] : []);
