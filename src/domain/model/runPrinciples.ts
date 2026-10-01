// The principles a run is given at dispatch: its step's own, the ones every agent run gets, and "attack the
// premise" for a repair round that failed the same way as the round before it.

import * as C from "../checks";
import * as F from "../findings";
import { EVERY_RUN_PRINCIPLE_IDS, PREMISE_ID, orderPrinciples, principle, stepPrinciples } from "../principles";
import { type Artifact, type ArtifactKind, type Attempt, type GivenPrinciple, type ConsumedInput, type Finding, type State, type Step, type Task } from "../types";
import { consumedInputs } from "./artifacts";
import { findStep } from "./core";
import { baseId } from "./fanout";

/**
 * The repair step whose round this one repeats, or undefined when this is not a repair round after the
 * first: a loop iteration `-i<k>` (k ≥ 2) of a conditional coder or designer step (a Change repair, a
 * Design revision), or a check-round fix `-r<k>-fix` (k ≥ 2).
 */
function previousRepair(t: Task, st: Step): Step | undefined {
  const round = /-r(\d+)-fix$/.exec(st.id);
  if (round) {
    const k = Number(round[1]);
    if (st.role !== "coder") return undefined;
    // The first round's fix follows the loop's last repair that ran, when there was one: final
    // checks failing the check the loop kept fixing is the strongest case for questioning the premise.
    if (k < 2) return t.steps.filter((x) => x.role === "coder" && x.runIf?.length && !/-r\d+-fix$/.test(x.id) && x.state === "done").pop();
    return t.steps.find((x) => x.role === "coder" && new RegExp(`-r${k - 1}-fix$`).test(x.id));
  }
  const k = st.iteration ?? 1;
  if (k < 2 || !st.runIf?.length || (st.role !== "coder" && st.role !== "designer")) return undefined;
  const base = baseId(st.id);
  return findStep(t, k === 2 ? base : `${base}-i${k - 1}`);
}

/** The ids of the checks that did not pass in a check-results artifact (a legacy record without the run keeps them on its findings). */
const failedCheckIds = (art: Artifact): string[] => (art.checkRun ? C.failedResults(art.checkRun).map((r) => r.id) : (art.findings ?? []).map((f) => f.checkId).filter((id): id is string => !!id));

/** A finding's identity across rounds: the file and the normalised title (not the severity, unlike `key`). */
const findingIdentity = (f: Finding) => `${f.file ?? ""}|${f.title.toLowerCase().replace(/\s+/g, " ").trim()}`;

/** The findings a repair still has in front of it: blocking, and not settled by an accept or a follow-up. */
function openFindings(s: State, art: Artifact): Finding[] {
  return (art.findings ?? []).filter((f) => {
    if (!F.isBlocking(f)) return false;
    const d = F.decisionFor(s, art, f);
    return d?.status !== "accept" && d?.status !== "follow-up";
  });
}

const MAX_PREMISE_REASONS = 5;

/**
 * Why "attack the premise" is added to this run, or undefined. A repair round after the first gets it
 * when the gate failed the same way again: a check that failed before the previous repair fails again in
 * the round before this one (same check id), or an open finding of the previous round's review comes
 * back (same file and normalised title). A first repair, or a later round whose failures are all new,
 * gets nothing. The previous round's inputs are the ones its run recorded.
 */
export function premiseReason(s: State, t: Task, st: Step, inputs: ConsumedInput[] = consumedInputs(s, t, st)): string | undefined {
  const prev = previousRepair(t, st);
  if (!prev) return undefined;
  let prevRun: Attempt | undefined;
  for (const a of s.attempts) if (a.taskId === t.id && a.stepId === prev.id && a.outcome === "completed") prevRun = a;
  const artifacts = (refs: ConsumedInput[], kind: ArtifactKind) => refs.map((i) => s.artifacts.find((a) => a.id === i.artifactId)).filter((a): a is Artifact => !!a && a.kind === kind);
  const prevInputs = prevRun ? prevRun.snapshot.inputs : consumedInputs(s, t, prev);
  const reasons: string[] = [];
  const failedBefore = new Set(artifacts(prevInputs, "check-results").flatMap(failedCheckIds));
  for (const id of new Set(artifacts(inputs, "check-results").flatMap(failedCheckIds))) if (failedBefore.has(id)) reasons.push(`check \`${id}\` failed again after ${prev.id}`);
  const openBefore = new Set(artifacts(prevInputs, "review-findings").flatMap((a) => openFindings(s, a)).map(findingIdentity));
  const seen = new Set<string>();
  for (const a of artifacts(inputs, "review-findings")) {
    for (const f of openFindings(s, a)) {
      const key = findingIdentity(f);
      if (!openBefore.has(key) || seen.has(key)) continue;
      seen.add(key);
      reasons.push(`the finding "${f.title.length > 120 ? `${f.title.slice(0, 119)}…` : f.title}" came back after ${prev.id}`);
    }
  }
  if (!reasons.length) return undefined;
  return `added: ${reasons.slice(0, MAX_PREMISE_REASONS).join("; ")}${reasons.length > MAX_PREMISE_REASONS ? `; and ${reasons.length - MAX_PREMISE_REASONS} more` : ""}`;
}

/**
 * The principles a run of `st` is given, in table order, each with the hash of its body: the step's own
 * (from its flow file, an internal flow or a check round) and, for a repair round that follows a round
 * which failed the same way, "attack the premise" with the reason. Written into the run's snapshot at dispatch.
 */
export function runPrinciples(s: State, t: Task, st: Step, inputs: ConsumedInput[] = consumedInputs(s, t, st)): GivenPrinciple[] {
  const own = stepPrinciples(st);
  // Every agent run also gets the every-run principles ("contextualize and write for the reader"), on tasks whose steps
  // carry principles at all. A task created before steps carried principles has none anywhere, and its runs get none,
  // this one included.
  const current = t.steps.some((x) => (x.principles?.length ?? 0) > 0);
  const base = current && st.role !== "checks" ? orderPrinciples([...own, ...EVERY_RUN_PRINCIPLE_IDS]) : own;
  const reason = own.length ? premiseReason(s, t, st, inputs) : undefined;
  const ids = reason ? orderPrinciples([...base, PREMISE_ID]) : base;
  return ids.map((id) => ({ id, hash: principle(id)?.hash ?? "", ...(reason && id === PREMISE_ID && !own.includes(PREMISE_ID) ? { added: reason } : {}) }));
}
