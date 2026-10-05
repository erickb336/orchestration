// What a completed lead run returns. Proposals are validated here and become tasks; steering, vision
// drafts, coverage, questions and the studio block (rounds, designer runs and the round's questions, in Vision)
// are validated by their own modules.

import * as F from "../findings";
import { childDefault, effectiveDefault, eligibleIds, findFlow, flowRef } from "../flows";
import { newWorkReview, PE_REVIEW_HOLD, proposalsToRevise, unrevisedInto } from "../peReview";
import { blueprintAcceptance, leadRefsProblem } from "../studio/blueprint";
import { instantiate, toDef } from "../pipeline";
import { type SpecOption, type SteeringChangeSet, type LeadQuestion, type LeadRun, type SpecContent, type State, type VisionDraft } from "../types";
import { currentSpec, draft, event, getTask, nextId } from "./core";
import { isImportReviewRun } from "../studio/import";
import { deferredLeadRoots, getLeadRun, openLeadProposals } from "./lead";
import { type RunReport } from "./runs";
import { applyStudioBlock, setRoundLead, type StudioBlockResult } from "../studio/lead";
import { answerChangeOrderInto, recordPeRevisionInto } from "./changeOrderUpdates";
import { draftFromRun, validateCoverage, validateQuestions, validateVisionDraft } from "./shaping";
import { editSpecInto } from "./specs";
import { steerFromRun, supersedeSuggestions } from "./steering";

export interface LeadProposal {
  title: string;
  area: string;
  whyNow: string;
  outcome: string;
  benefit: string;
  scopeIncluded: string[];
  scopeExcluded: string[];
  options: SpecOption[];
  recommendedOptionId: string;
  rationale: string;
  uncertainty: string;
  acceptance: string[];
  /** The flow to run. Absent: the project default. */
  flowId?: string;
  priority: number;
  /** The approved blueprint items the task builds, by id (ORC-029 pass 5). A cited flow's rules and examples join its acceptance. */
  blueprintRefs?: string[];
  /** A proposal the PE sent back: this revises that task's spec instead of proposing a new task (pass 5). */
  revises?: string;
}

/** The flow a proposal or breakdown item names, when it names one. */
const namedFlow = (p: LeadProposal): unknown => p.flowId;

interface LeadOutput {
  reply: string;
  proposals: LeadProposal[];
  /** The steering block as found in the JSON (untrusted; validated by the steering module). Absent or null: none. */
  steer?: unknown;
  /** The vision draft as found in the JSON (untrusted; validated by the shaping module). Absent or null: none. */
  vision?: unknown;
  /** The lead's coverage of the vision's areas, as found (untrusted; validated by the shaping module). */
  coverage?: unknown;
  /** The lead's questions to the user, as found (untrusted; validated by the shaping module). */
  questions?: unknown;
  /** The lead's decisions on findings routed to it, as found (untrusted; validated in the findings module). */
  decisions?: unknown;
  /** The lead's studio block in Vision, as found (untrusted; validated in src/domain/studio/lead.ts). */
  studio?: unknown;
  /** The lead's updates for the change order the run was shown, as found (untrusted; validated in changeOrderUpdates.ts). */
  changeOrder?: unknown;
  /** Why the answer could not be used as sent: recorded on the run and shown under the reply. */
  problem?: LeadReplyProblem;
  /** The final text as the runtime returned it: kept on the run only with a problem (keepRawAnswer). */
  answerText?: string;
}

/** The most of a lead's final text a run keeps, in characters (about 64 KB). */
export const MAX_RAW_ANSWER = 65_536;
/** How many lead runs keep their final text: the newest ones, so the state (rewritten on every change) stays small. */
export const MAX_RAW_ANSWERS = 5;

/** Keep the run's final text for diagnosis, capped, and drop it from the older runs past the limit. Mutates a draft. */
function keepRawAnswer(s: State, r: LeadRun, text: string) {
  r.rawAnswer = text.length > MAX_RAW_ANSWER ? { text: text.slice(0, MAX_RAW_ANSWER), truncated: true } : { text };
  const keeping = s.leadRuns.filter((x) => x.rawAnswer);
  for (const old of keeping.slice(0, Math.max(0, keeping.length - MAX_RAW_ANSWERS))) delete old.rawAnswer;
}

/** Why the lead's answer could not be used as sent (parseLeadOutput, server/envelope.ts). */
export type LeadReplyProblem =
  /** No JSON at all: the message is a reply without proposals. */
  | { kind: "no-json" }
  /** JSON that does not parse. `where`: the parser's reason and the line and column. */
  | { kind: "unparsed"; where: string }
  /** JSON that parses to something other than an object. */
  | { kind: "not-object" }
  /** An object that does not match the output schema. `where`: the first mismatches. Its parts still go to the checks below. */
  | { kind: "schema"; where: string };

/** The note for a problem, the same on the run and under the reply: what failed, where, and what the service did. */
export function leadReplyNote(p: LeadReplyProblem): string {
  switch (p.kind) {
    case "no-json":
      return "The reply had no JSON block, so nothing was changed.";
    case "unparsed":
      return `The reply's JSON did not parse (${p.where}), so nothing was changed.`;
    case "not-object":
      return "The reply's JSON was not an object, so nothing was changed.";
    case "schema":
      return `The reply's JSON did not match the output schema (${p.where}). The service checked each part on its own.`;
  }
}

/** How long a dropped title stays off limits to planning. */
const DROP_GUARD_MS = 7 * 24 * 60 * 60_000;

/**
 * Check a proposal against the spec requirements. Returns a reason when it cannot become a task.
 * `who`: a lead proposal, or a breakdown item ("child": its flow may not break down again). `revising`: the task a
 * revision for the PE replaces the spec of (its own title is not a duplicate).
 */
export function validateProposal(s: State, p: LeadProposal, now?: string, who: "lead" | "child" = "lead", revising?: string): string | undefined {
  // Lead output is untrusted data: check types before anything else.
  const isStr = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (!p || typeof p !== "object") return "not an object";
  if (!isStr(p.title, 200) || !isStr(p.outcome, 4000)) return "a title (≤200 chars) and an outcome (≤4000 chars) are required";
  for (const k of ["area", "whyNow", "benefit", "uncertainty"] as const) if (p[k] !== undefined && (typeof p[k] !== "string" || p[k].length > 4000)) return `"${k}" must be text (≤4000 chars)`;
  if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 4) return "it needs two to four options (include deferring when only one approach is sensible)";
  if (p.options.some((o) => !o || typeof o !== "object" || !["string", "number"].includes(typeof o.id) || !isStr(o.name, 200) || !isStr(o.approach, 4000))) return "every option needs an id, a name, and an approach";
  const ids = new Set(p.options.map((o) => String(o.id)));
  if (ids.size !== p.options.length) return "option ids must be unique";
  if (!ids.has(String(p.recommendedOptionId))) return "the recommended option is not among the options";
  if (!isStr(p.rationale, 4000)) return "the decision needs a rationale";
  if (!Array.isArray(p.acceptance) || !p.acceptance.some((x) => typeof x === "string" && x.trim()) || p.acceptance.length > 30) return "it needs one to thirty acceptance checks";
  for (const k of ["scopeIncluded", "scopeExcluded"] as const) if (p[k] !== undefined && (!Array.isArray(p[k]) || p[k].length > 30)) return `"${k}" must be a list`;
  // The flow is validated as untrusted data; the lead may name any of the six, a breakdown item any but Goal.
  const named = namedFlow(p);
  if (named !== undefined && typeof named !== "string") return "flowId must be text";
  const flowId = named ?? (who === "child" ? childDefault(s) : effectiveDefault(s)).id;
  const flow = findFlow(s, flowId);
  if (!flow) return `unknown flow "${flowId}"; choose one of: ${eligibleIds(s, who).join(", ")}`;
  if (who === "child" && flow.breaksDown) return `child tasks cannot break down further (flow "${flow.name}"); use a flow without breakdown steps: ${eligibleIds(s, "child").join(", ")}`;
  // The blueprint items it builds: approved items only (pass 5, the factory link).
  if (p.blueprintRefs !== undefined) {
    const why = leadRefsProblem(s, p.blueprintRefs);
    if (why) return why;
  }
  if (!acceptanceOf(s, p).length) return "it needs one to thirty acceptance checks; a line with a rule's tag is the blueprint's own";
  const title = (p.title as string).trim().toLowerCase();
  if (s.tasks.some((t) => t.id !== revising && t.lifecycle !== "cancelled" && currentSpec(t).content.title.trim().toLowerCase() === title)) return "a task with this title already exists";
  // Work the lead dropped when the focus changed is not proposed again for a week.
  const nowMs = now ? Date.parse(now) : Date.now();
  const dropped = s.tasks.find((t) => t.lifecycle === "cancelled" && t.dropped && nowMs - Date.parse(t.dropped.at) < DROP_GUARD_MS && currentSpec(t).content.title.trim().toLowerCase() === title);
  if (dropped) return `dropped when the focus changed on ${dropped.dropped!.at.slice(0, 10)}; the user can restore it`;
  return undefined;
}

/** Apply a completed lead run: its reply, and each valid proposal as a new lead-authored task. */
export function completeLeadRun(state: State, runId: string, out: LeadOutput, now: string, run: RunReport = {}): State {
  let s = draft(state);
  const r = getLeadRun(s, runId);
  if (!r || (r.outcome !== "running" && r.outcome !== "stopping")) return s;
  // What the run cost, however it ends: its usage, its model, and whether the fake runtime ran it (a known $0).
  if (run.usage) r.usage = run.usage;
  if (run.actualModel) r.actualModel = run.actualModel;
  if (run.simulated) r.simulated = true;
  if (r.outcome === "stopping") {
    // Finished after a stop request: keep the reply for the record, but create nothing.
    r.outcome = "stopped";
    r.endedAt = now;
    r.note = `Finished after a stop request; its proposals and steering were not applied. Reply: ${String(out.reply).slice(0, 2000)}`;
    return s;
  }
  r.outcome = "completed";
  r.endedAt = now;
  const rejected: string[] = [];
  if (out.problem) {
    r.note = leadReplyNote(out.problem);
    rejected.push(r.note);
    if (out.answerText !== undefined) keepRawAnswer(s, r, out.answerText);
  }
  // Steering, before the proposals so they are created under the new focus and after the
  // deferrals and drops that make room. Two guards make it apply once: the run-outcome guard above and
  // the change-set id.
  let set: SteeringChangeSet | undefined;
  if (out.steer !== undefined && out.steer !== null && !s.steering.some((cs) => cs.id === `cs-${r.id}`)) {
    set = steerFromRun(s, r, out.steer, now, run.simulated);
    s.steering.push(set);
    if (s.steering.length > 200) s.steering.splice(0, s.steering.length - 200);
    r.changeSetId = set.id;
  }
  // The change order the run was shown (ORC-029 pass 5), after steering and before the proposals: each update is a
  // line of the change order and a row of this reply's change set, so the owner can undo each one.
  const answered = answerChangeOrderInto(s, r, out.changeOrder, set, now, run.simulated);
  set = answered.set;
  rejected.push(...answered.notes.map((n) => `Change order ${n}`));
  // A vision draft. Never applied: it is recorded as a suggestion for the user to accept, edit
  // or dismiss. The run-outcome guard above and the draft id (one per run) make it record once.
  let visionDraft: VisionDraft | undefined;
  if (out.vision !== undefined && out.vision !== null && !s.visionDrafts.some((d) => d.leadRunId === r.id)) {
    const v = validateVisionDraft(s, r, out.vision);
    if (v.ok) visionDraft = draftFromRun(s, r, v.draft, now, run.simulated);
    else rejected.push(`Vision draft: ${v.why}`);
  }
  // Coverage lives on the run (the latest stands); questions live on the reply. Both come only
  // from runs that answer the user; anything unreadable is left out with a note.
  let questions: LeadQuestion[] = [];
  if (out.coverage !== undefined && out.coverage !== null) {
    const c = validateCoverage(r, out.coverage);
    rejected.push(...c.notes.map((n) => `Coverage: ${n}`));
    // A block with no valid entry reports nothing; the previous coverage stands.
    if (c.ok && Object.keys(c.coverage).length === 0) rejected.push("Coverage: no valid entries; the previous coverage stands");
    else if (c.ok) r.coverage = c.coverage;
  }
  if (out.questions !== undefined && out.questions !== null) {
    const q = validateQuestions(r, out.questions);
    questions = q.questions;
    rejected.push(...q.notes.map((n) => `Questions: ${n}`));
  }
  // Decisions on findings routed to the lead, after steering and before the proposals (a
  // follow-up decision proposes a task under the same caps). The run-outcome guard makes it apply once.
  if (out.decisions !== undefined && out.decisions !== null) rejected.push(...F.applyLeadDecisions(s, r, out.decisions, now));
  const decided = F.leadRunDecisions(s, r.id);
  const limit = Math.max(1, s.project.autonomy.maxProposalsPerCycle);
  const maxOpen = s.project.autonomy.maxOpenProposals;
  const openRoom = Math.max(0, maxOpen - openLeadProposals(s).length);
  // The bound on deferred lead work applies to message runs as it does to planning.
  const deferredLead = deferredLeadRoots(s).length;
  // With autonomy off, proposals from a conversation still become tasks, but they wait for the user.
  // While shaping every proposal is the roadmap: held by its own flag until the user starts building;
  // the hold before start follows the involvement setting as for any lead proposal.
  const shaping = s.project.stage === "shaping";
  const hold = !s.project.autonomy.enabled || s.project.autonomy.holdLeadProposals;
  const created: string[] = [];
  const revised: string[] = [];
  const label = (p: unknown) => {
    const t = p && typeof p === "object" ? (p as { title?: unknown }).title : undefined;
    return typeof t === "string" ? t.slice(0, 80) : "(untitled)";
  };
  let proposed = 0;
  for (const p of out.proposals) {
    // A revision of work the PE sent back (pass 5): a new spec revision of that task, not a new proposal.
    const revises = p && typeof p === "object" ? (p as { revises?: unknown }).revises : undefined;
    if (revises !== undefined && revises !== null) {
      const why = reviseForPeInto(s, p, revises, now);
      if (why) rejected.push(`"${label(p)}": ${why}`);
      else {
        revised.push(String(revises));
        rejected.push(...refusedAcceptance(s, p).map((line) => `"${label(p)}": ${refusedAcceptanceNote(line)}`));
      }
      continue;
    }
    if (proposed++ >= limit) {
      rejected.push(`"${label(p)}": more than ${limit} proposals in one run`);
      continue;
    }
    if (deferredLead >= maxOpen) {
      rejected.push(`"${label(p)}": ${deferredLead} deferred lead proposals reached the limit of ${maxOpen}; drop those that no longer fit first`);
      continue;
    }
    if (created.length >= openRoom) {
      rejected.push(`"${label(p)}": the limit of ${s.project.autonomy.maxOpenProposals} open lead proposals is reached`);
      continue;
    }
    try {
      const why = validateProposal(s, p, now);
      if (why) {
        rejected.push(`"${label(p)}": ${why}`);
        continue;
      }
      created.push(proposeTask(s, p, now, hold, undefined, shaping));
      rejected.push(...refusedAcceptance(s, p).map((line) => `"${label(p)}": ${refusedAcceptanceNote(line)}`));
    } catch (err) {
      rejected.push(`"${label(p)}": invalid (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // Work the PE sent back that this run was shown and left as it was goes to the user with the objection (pass 5).
  const leftForUser = unrevisedInto(s, r.id, now);
  // A completed message run decides the held suggestions, and its rows supersede older ones for the same target.
  if (r.messageIds.length) supersedeSuggestions(s, set, now);
  const applied = set?.changes.filter((c) => c.status === "applied").length ?? 0;
  const suggested = set?.changes.filter((c) => c.status === "suggested").length ?? 0;
  // The studio block, last: it opens and closes rounds and asks for designer runs through the studio's own rules,
  // which return a new state (the run record above is final by now). It approves nothing and starts nothing.
  let studio: StudioBlockResult | undefined;
  if (out.studio !== undefined && out.studio !== null) {
    studio = applyStudioBlock(s, r, out.studio, now);
    s = studio.state;
    rejected.push(...studio.notes.map((n) => `Studio: ${n}`));
  }
  const text =
    out.reply.trim() ||
    (visionDraft
      ? "I drafted the vision; see below."
      : questions.length || studio?.questions.length
        ? "I have a few questions; see below."
        : studio?.runs.length
          ? "I asked the designer for this round; see the studio."
          : applied
            ? "I made the changes listed below."
            : suggested
              ? "I suggest the changes listed below."
              : decided.length
                ? "I went through the findings that were waiting for me; see below."
                : created.length
                  ? "I proposed new work; see the linked tasks."
                  : revised.length
                    ? "I revised the work the PE sent back; the PE reviews it again."
                    : "No reply.");
  // The round the block addressed shows this reply and its questions beside its artifacts.
  if (studio?.round !== undefined) setRoundLead(s, studio.round, text, studio.questions);
  // The import's review reply (ORC-032) is round 0's message: what the import found, beside its questions (UX-4).
  else if (isImportReviewRun(s, r)) setRoundLead(s, 0, text, []);
  s.conversation.push({
    id: nextId(s, "msg"),
    at: now,
    author: "lead",
    text,
    leadRunId: r.id,
    ...(created.length ? { proposedTaskIds: created } : {}),
    ...(rejected.length || leftForUser.length ? { rejected: [...rejected, ...leftForUser.map((id) => `${id}: not revised, so the PE's objection goes to you`)] } : {}),
    ...(set ? { changeSetId: set.id } : {}),
    ...(visionDraft ? { visionDraftId: visionDraft.id } : {}),
    ...(questions.length ? { questions } : {}),
    // What this reply decided, as recorded now; the user's later changes do not rewrite it.
    ...(decided.length ? { leadDecisions: decided.map(({ decision: d, what }) => ({ id: d.id, taskId: d.taskId, what, status: d.status, ...(d.why || d.suggestion?.why ? { why: d.why ?? d.suggestion?.why } : {}) })) } : {}),
  });
  event(
    s,
    now,
    "lead",
    "spec",
    `Lead run ${r.id} replied${visionDraft ? " and drafted the vision" : ""}${decided.length ? ` and went through ${decided.length} decision${decided.length === 1 ? "" : "s"}` : ""}${created.length ? ` and proposed ${created.join(", ")}${shaping ? " (roadmap, held while shaping)" : ""}` : ""}${revised.length ? ` and revised ${revised.join(", ")} for the PE` : ""}${rejected.length ? `; ${rejected.length} item${rejected.length === 1 ? "" : "s"} rejected` : ""}`,
  );
  return s;
}

/**
 * The lead revises a proposal the PE sent back (pass 5): its whole proposal, merged into the current spec
 * (`specUpdateOf`), becomes the task's next spec revision (by the lead, so an objection is not reopened), and the PE
 * reviews it again. The task keeps its flow and priority. A revision of a change order's spec update is recorded on
 * that line, so its Undo still restores the spec before the update. Returns why it cannot, or undefined. Mutates the draft.
 */
function reviseForPeInto(s: State, p: LeadProposal, revises: unknown, now: string): string | undefined {
  if (typeof revises !== "string") return '"revises" must be a task id';
  const t = proposalsToRevise(s).find((x) => x.id === revises);
  if (!t) return `${revises.slice(0, 40)} is not work the PE sent back for revision`;
  const why = validateProposal(s, p, now, "lead", t.id);
  if (why) return why;
  const spec = currentSpec(t);
  // A revision edits the spec it revises, as a change order's update does: the owner's decisions on it stay.
  const chosen = ownersChoiceLeftOut(spec.content, p);
  if (chosen) return `keep option ${chosen.id} (${chosen.name}) as it is: the user chose it`;
  const round = t.peReview!.rounds.length;
  editSpecInto(s, getTask(s, t.id), spec.rev, specUpdateOf(s, spec.content, p), `Revised for the PE (round ${round} asked for a change)`, "lead", now);
  recordPeRevisionInto(s, t.id, spec.rev, currentSpec(getTask(s, t.id)).rev);
  return undefined;
}

const list = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => String(x).trim()).filter(Boolean) : []);
const refsOf = (p: LeadProposal) => [...new Set(list(p.blueprintRefs))];

/**
 * A blueprint tag in an acceptance line: a rule's or an example's ("[bi-12 R3]", or "[bi-12_R3]" as ruleResults.ts
 * reads a test's name) or a contract's ("[bi-12]"). Only the blueprint's own lines carry one (review finding 4): a test
 * with the tag proves that line, so a line the lead wrote under it would let weaker text pass for the rule.
 */
const TAG_RE = /\[bi-\d{1,9}(?:[ _][A-Za-z0-9_-]{1,20})?\]/;

/** A proposal's acceptance: the lead's own lines without a blueprint tag, then every line the cited items give. */
function acceptanceOf(s: State, p: LeadProposal): string[] {
  return [...list(p.acceptance).filter((x) => !TAG_RE.test(x)), ...blueprintAcceptance(s, refsOf(p))];
}

/**
 * The lead's acceptance lines its spec leaves out, for a note under the reply: each line that carries a blueprint tag
 * and is not the blueprint's own line (an exact copy of one goes without a note: the spec has it anyway).
 */
export function refusedAcceptance(s: State, p: LeadProposal): string[] {
  const own = new Set(blueprintAcceptance(s, refsOf(p)));
  return list(p.acceptance).filter((x) => TAG_RE.test(x) && !own.has(x));
}

/** The note for one refused acceptance line. */
export const refusedAcceptanceNote = (line: string) => `the acceptance line "${line.length > 120 ? `${line.slice(0, 119)}…` : line}" is refused: only the blueprint's own line carries a rule's tag`;

/**
 * A proposal's spec content: the lead's fields, the recommended option selected, and (pass 5) the blueprint items it
 * builds, with the acceptance their rules and examples give, after the lead's own checks.
 */
export function specContentOf(s: State, p: LeadProposal): SpecContent {
  const refs = refsOf(p);
  const acceptance = acceptanceOf(s, p);
  return {
    title: p.title.trim().slice(0, 200),
    area: (p.area ?? "").trim().slice(0, 60) || "General",
    whyNow: (p.whyNow ?? "").trim(),
    outcome: p.outcome.trim(),
    benefit: (p.benefit ?? "").trim(),
    successCriteria: [],
    scopeIncluded: list(p.scopeIncluded),
    scopeExcluded: list(p.scopeExcluded),
    options: p.options.map((o) => ({
      id: String(o.id).slice(0, 10),
      name: String(o.name),
      approach: String(o.approach),
      benefit: String(o.benefit ?? ""),
      effort: String(o.effort ?? ""),
      risks: String(o.risks ?? ""),
      reversibility: String(o.reversibility ?? ""),
    })),
    recommendedOptionId: String(p.recommendedOptionId).slice(0, 10),
    selectedOptionId: String(p.recommendedOptionId).slice(0, 10),
    decidedBy: "lead",
    rationale: p.rationale.trim(),
    uncertainty: (p.uncertainty ?? "").trim(),
    overrideReason: "",
    acceptance,
    validationPlan: "",
    rollback: "Discard the orchestration branch; delivery to your branch happens only if you turned it on.",
    effort: "small",
    ...(refs.length ? { blueprintRefs: refs } : {}),
  };
}

/**
 * Whether `options` still hold the option the owner chose as the owner saw it: its id, with the same name and approach
 * (pass 6 review finding 6). An option that keeps its id but says another thing is another option.
 */
function keepsOption(chosen: SpecOption, options: readonly { id: unknown; name: unknown; approach: unknown }[]): boolean {
  const same = (a: unknown, b: string) => String(a).trim() === b.trim();
  return options.some((o) => String(o.id).slice(0, 10) === chosen.id && same(o.name, chosen.name) && same(o.approach, chosen.approach));
}

/**
 * The option the owner chose on this spec, when the lead's proposal leaves it out or changes its name or approach:
 * only the owner overrules it.
 */
export function ownersChoiceLeftOut(cur: SpecContent, p: LeadProposal): SpecOption | undefined {
  if (cur.decidedBy !== "user") return undefined;
  const chosen = cur.options.find((o) => o.id === cur.selectedOptionId);
  return chosen && !keepsOption(chosen, p.options) ? chosen : undefined;
}

/** The override reason a kept choice gets when the owner had taken the recommendation and the lead now recommends another. */
const KEPT_CHOICE = "Your choice, kept when the lead's update recommended another option";

/**
 * A spec update's content (a change order's "update-spec", review finding 5): the lead's proposal merged into the
 * current spec. Each field the proposal gives replaces the current one; the rest stays, among them what a proposal
 * never carries: the success criteria, the validation plan, the rollback and the effort. The owner's choice stays
 * where its option still exists unchanged, with its reason; an update that leaves it out or changes it is the owner's
 * call (`ownersChoiceLeftOut`), and the owner's go-ahead takes the lead's recommendation.
 */
export function specUpdateOf(s: State, cur: SpecContent, p: LeadProposal): SpecContent {
  const next = specContentOf(s, p);
  const given = (k: "area" | "whyNow" | "benefit" | "uncertainty" | "scopeIncluded" | "scopeExcluded") => p[k] !== undefined && p[k] !== null;
  const chosen = cur.decidedBy === "user" ? cur.options.find((o) => o.id === cur.selectedOptionId) : undefined;
  const keep = !!chosen && keepsOption(chosen, next.options);
  return {
    ...next,
    area: given("area") ? next.area : cur.area,
    whyNow: given("whyNow") ? next.whyNow : cur.whyNow,
    benefit: given("benefit") ? next.benefit : cur.benefit,
    uncertainty: given("uncertainty") ? next.uncertainty : cur.uncertainty,
    scopeIncluded: given("scopeIncluded") ? next.scopeIncluded : cur.scopeIncluded,
    scopeExcluded: given("scopeExcluded") ? next.scopeExcluded : cur.scopeExcluded,
    successCriteria: cur.successCriteria,
    validationPlan: cur.validationPlan,
    rollback: cur.rollback,
    effort: cur.effort,
    ...(keep ? { selectedOptionId: cur.selectedOptionId, decidedBy: cur.decidedBy, overrideReason: cur.selectedOptionId === next.recommendedOptionId ? "" : cur.overrideReason.trim() || KEPT_CHOICE } : {}),
  };
}

/**
 * Create a lead-authored task from a validated proposal on a draft state. Also used by the findings module
 * for follow-ups. `who`: who named the flow when the proposal names one; the project default
 * (or the child default for breakdown items) applies otherwise, recorded as chosen by "default".
 */
export function proposeTask(s: State, p: LeadProposal, now: string, hold: boolean, fixedId?: string, fromShaping = false, who: "lead" | "breakdown" = "lead"): string {
  let n = s.tasks.length + 1;
  const ids = new Set(s.tasks.map((x) => x.id));
  while (ids.has(`T-${String(n).padStart(3, "0")}`)) n++;
  const id = fixedId ?? `T-${String(n).padStart(3, "0")}`;
  const named = namedFlow(p);
  const flow = typeof named === "string" ? findFlow(s, named)! : who === "breakdown" ? childDefault(s) : effectiveDefault(s);
  const ref = flowRef(flow, typeof named === "string" ? who : "default");
  const content = specContentOf(s, p);
  const defs = structuredClone(flow.steps).map(toDef);
  // New work the lead plans while building waits for PE review when the project has it on (ORC-029 2e). The state is
  // the service's: nothing the lead sends (a proposal's or an item's own fields) reaches it. A breakdown item has none
  // of its own: the PE reviewed the breakdown before its children existed (pass 5).
  const peReview = fromShaping || who === "breakdown" ? undefined : newWorkReview(s);
  s.tasks.push({
    id,
    priority: Number.isFinite(p.priority) ? Math.min(99, Math.max(1, Math.round(p.priority))) : 5,
    lifecycle: "proposed",
    hold: false,
    holdBeforeStart: hold,
    ...(fromShaping ? { heldForShaping: true } : {}),
    specs: [{ rev: 1, at: now, author: "lead", reason: "Proposed by the lead", content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    ...(fromShaping ? { fromShaping: true } : {}),
    ...(peReview ? { peReview } : {}),
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "lead", reason: `Created from the ${flow.name} flow`, steps: defs, flow: ref }],
    flow: ref,
    flowSince: 1,
  });
  event(s, now, "lead", "decision", `Proposed ${id}: ${content.title} (selected option ${content.selectedOptionId})${fromShaping ? "; planned in Vision, waits for Start the factory" : ""}${peReview ? `; ${PE_REVIEW_HOLD}` : ""}`, id);
  return id;
}
