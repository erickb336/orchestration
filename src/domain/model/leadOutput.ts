// What a completed lead run returns. Proposals are validated here and become tasks; steering, vision
// drafts, coverage and questions are validated by their own modules.

import * as F from "../findings";
import { childDefault, effectiveDefault, eligibleIds, findFlow, flowRef } from "../flows";
import { newWorkReview, PE_REVIEW_HOLD } from "../peReview";
import { instantiate, toDef } from "../pipeline";
import { type SpecOption, type SteeringChangeSet, type LeadQuestion, type SpecContent, type State, type VisionDraft } from "../types";
import { currentSpec, draft, event, nextId } from "./core";
import { deferredLeadRoots, getLeadRun, openLeadProposals } from "./lead";
import { type RunReport } from "./runs";
import { draftFromRun, validateCoverage, validateQuestions, validateVisionDraft } from "./shaping";
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
  /** Why the output could not be read (no JSON block): recorded on the run and shown under the reply. */
  problem?: string;
}

/** How long a dropped title stays off limits to planning. */
const DROP_GUARD_MS = 7 * 24 * 60 * 60_000;

/**
 * Check a proposal against the spec requirements. Returns a reason when it cannot become a task.
 * `who`: a lead proposal, or a breakdown item ("child": its flow may not break down again).
 */
export function validateProposal(s: State, p: LeadProposal, now?: string, who: "lead" | "child" = "lead"): string | undefined {
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
  const title = (p.title as string).trim().toLowerCase();
  if (s.tasks.some((t) => t.lifecycle !== "cancelled" && currentSpec(t).content.title.trim().toLowerCase() === title)) return "a task with this title already exists";
  // Work the lead dropped when the focus changed is not proposed again for a week.
  const nowMs = now ? Date.parse(now) : Date.now();
  const dropped = s.tasks.find((t) => t.lifecycle === "cancelled" && t.dropped && nowMs - Date.parse(t.dropped.at) < DROP_GUARD_MS && currentSpec(t).content.title.trim().toLowerCase() === title);
  if (dropped) return `dropped when the focus changed on ${dropped.dropped!.at.slice(0, 10)}; the user can restore it`;
  return undefined;
}

/** Apply a completed lead run: its reply, and each valid proposal as a new lead-authored task. */
export function completeLeadRun(state: State, runId: string, out: LeadOutput, now: string, run: RunReport = {}): State {
  const s = draft(state);
  const r = getLeadRun(s, runId);
  if (!r || (r.outcome !== "running" && r.outcome !== "stopping")) return s;
  if (r.outcome === "stopping") {
    // Finished after a stop request: keep the reply for the record, but create nothing.
    r.outcome = "stopped";
    r.endedAt = now;
    r.note = `Finished after a stop request; its proposals and steering were not applied. Reply: ${String(out.reply).slice(0, 2000)}`;
    return s;
  }
  r.outcome = "completed";
  r.endedAt = now;
  if (run.usage) r.usage = run.usage;
  if (run.actualModel) r.actualModel = run.actualModel;
  const rejected: string[] = [];
  if (out.problem) {
    r.note = out.problem;
    rejected.push("The reply had no machine-readable block, so nothing was changed.");
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
  const label = (p: unknown) => {
    const t = p && typeof p === "object" ? (p as { title?: unknown }).title : undefined;
    return typeof t === "string" ? t.slice(0, 80) : "(untitled)";
  };
  for (const [i, p] of out.proposals.entries()) {
    if (i >= limit) {
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
    } catch (err) {
      rejected.push(`"${label(p)}": invalid (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // A completed message run decides the held suggestions, and its rows supersede older ones for the same target.
  if (r.messageIds.length) supersedeSuggestions(s, set, now);
  const applied = set?.changes.filter((c) => c.status === "applied").length ?? 0;
  const suggested = set?.changes.filter((c) => c.status === "suggested").length ?? 0;
  s.conversation.push({
    id: nextId(s, "msg"),
    at: now,
    author: "lead",
    text:
      out.reply.trim() ||
      (visionDraft
        ? "I drafted the vision; see below."
        : questions.length
          ? "I have a few questions; see below."
          : applied
            ? "I made the changes listed below."
            : suggested
              ? "I suggest the changes listed below."
              : decided.length
                ? "I went through the findings that were waiting for me; see below."
                : created.length
                  ? "I proposed new work; see the linked tasks."
                  : "No reply."),
    leadRunId: r.id,
    ...(created.length ? { proposedTaskIds: created } : {}),
    ...(rejected.length ? { rejected } : {}),
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
    `Lead run ${r.id} replied${visionDraft ? " and drafted the vision" : ""}${decided.length ? ` and went through ${decided.length} decision${decided.length === 1 ? "" : "s"}` : ""}${created.length ? ` and proposed ${created.join(", ")}${shaping ? " (roadmap, held while shaping)" : ""}` : ""}${rejected.length ? `; ${rejected.length} item${rejected.length === 1 ? "" : "s"} rejected` : ""}`,
  );
  return s;
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
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => String(x).trim()).filter(Boolean) : []);
  const content: SpecContent = {
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
    acceptance: list(p.acceptance),
    validationPlan: "",
    rollback: "Discard the orchestration branch; delivery to your branch happens only if you turned it on.",
    effort: "small",
  };
  const defs = structuredClone(flow.steps).map(toDef);
  // New work the lead plans while building waits for PE review when the project has it on (ORC-029 2e). The state is
  // the service's: nothing the lead sends (a proposal's or an item's own fields) reaches it.
  const peReview = fromShaping ? undefined : newWorkReview(s);
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
  event(s, now, "lead", "decision", `Proposed ${id}: ${content.title} (selected option ${content.selectedOptionId})${fromShaping ? "; planned while shaping, waits for Start building" : ""}${peReview ? `; ${PE_REVIEW_HOLD}` : ""}`, id);
  return id;
}
