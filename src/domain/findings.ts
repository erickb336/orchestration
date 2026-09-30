// ORC-013: structured findings and per-finding triage. Pure functions over the state: derived counts
// (what a repair may fix, what is undecided, what is unresolved), the decisions on `ask-user`
// findings, their routing to the lead or the user, carry-forward of an earlier decision on the same
// finding, and the validation of the decisions a lead run reports. Summary-only (legacy) artifacts
// keep their `openFindings` semantics everywhere.

import * as M from "./model";
import { templateSteps } from "./templates";
import { ControlError, type Artifact, type Finding, type FindingDecision, type LeadRun, type State, type Step, type Task } from "./types";

export const MAX_DECISIONS = 2000;
export const MAX_DECISION_WHY = 300;
export const MAX_LEAD_DECISIONS = 20;
export const DECISION_OPTIONS = ["fix", "accept", "follow-up", "reopen"] as const;
export type UserDecision = (typeof DECISION_OPTIONS)[number];
const LEAD_OPTIONS = ["fix", "accept", "follow-up", "ask-user"] as const;
type LeadDecision = (typeof LEAD_OPTIONS)[number];

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** A finding that must be fixed or decided: an error or warning that is not information only. */
export const isBlocking = (f: Finding) => f.severity !== "info" && f.action !== "no-op";

/** The decision record for one finding of one artifact (the newest, if several). */
export function decisionFor(s: State, art: Pick<Artifact, "id">, f: Pick<Finding, "id">): FindingDecision | undefined {
  let best: FindingDecision | undefined;
  for (const d of s.decisions) if (d.artifactId === art.id && d.findingId === f.id) best = d;
  return best;
}

/** Work a repair may do: auto-fix blocking findings, plus ask-user ones decided "fix". Legacy: openFindings. */
export function fixable(s: State, art: Artifact): number {
  if (!art.findings) return art.openFindings ?? 0;
  let n = 0;
  for (const f of art.findings) {
    if (!isBlocking(f)) continue;
    if (f.action === "auto-fix" || decisionFor(s, art, f)?.status === "fix") n++;
  }
  return n;
}

/** ask-user blocking findings with no decision, or an open one. Legacy: none. */
export function undecided(s: State, art: Artifact): number {
  if (!art.findings) return 0;
  let n = 0;
  for (const f of art.findings) {
    if (!isBlocking(f) || f.action !== "ask-user") continue;
    const d = decisionFor(s, art, f);
    if (!d || d.status === "open") n++;
  }
  return n;
}

/** Not resolved: auto-fix blocking, plus ask-user blocking not decided "accept" or "follow-up". Legacy: openFindings. */
export function unresolved(s: State, art: Artifact): number {
  if (!art.findings) return art.openFindings ?? 0;
  let n = 0;
  for (const f of art.findings) {
    if (!isBlocking(f)) continue;
    if (f.action === "auto-fix") n++;
    else {
      const st = decisionFor(s, art, f)?.status;
      if (st !== "accept" && st !== "follow-up") n++;
    }
  }
  return n;
}

/** Blocking findings someone decided to accept as they are, as "F2 title" labels. */
export function acceptedFindings(s: State, art: Artifact): string[] {
  if (!art.findings) return [];
  const out: string[] = [];
  for (const f of art.findings) {
    if (!isBlocking(f) || f.action !== "ask-user") continue;
    const st = decisionFor(s, art, f)?.status;
    if (st === "accept" || st === "follow-up") out.push(`${f.id} ${clip(f.title, 80)}`);
  }
  return out;
}

/** The service-computed open count of a structured artifact: blocking findings (error or warning, auto-fix or ask-user). */
export const blockingCount = (findings: Finding[]) => findings.filter(isBlocking).length;

/** Every decision of a task, newest first. */
export function decisionsOf(s: State, taskId: string): FindingDecision[] {
  return s.decisions.filter((d) => d.taskId === taskId).reverse();
}

/** Open decisions routed to `to`. */
export function openDecisions(s: State, to?: "lead" | "user"): FindingDecision[] {
  return s.decisions.filter((d) => d.status === "open" && (to === undefined || d.routedTo === to));
}

function getDecision(s: State, id: string): FindingDecision {
  const d = s.decisions.find((x) => x.id === id);
  if (!d) throw new ControlError(`Unknown decision ${id}`);
  return d;
}

/**
 * Create one decision per blocking `ask-user` finding of an accepted structured artifact. Mutates the
 * draft `s`. An earlier decided decision with the same key on this task (or on the origin task of a
 * pull-request repair) is carried forward, labelled, so the same finding is not decided twice.
 */
export function createDecisions(s: State, t: Task, art: Artifact, now: string): FindingDecision[] {
  if (!art.findings) return [];
  const out: FindingDecision[] = [];
  const origin = t.deliverInto?.taskId;
  for (const f of art.findings) {
    if (!isBlocking(f) || f.action !== "ask-user" || decisionFor(s, art, f)) continue;
    let earlier: FindingDecision | undefined;
    for (const d of s.decisions) {
      if (d.key !== f.key || d.status === "open" || d.kind !== "finding") continue;
      if (d.taskId === t.id || (origin !== undefined && d.taskId === origin)) earlier = d;
    }
    const d: FindingDecision = {
      id: M.nextId(s, "fd"),
      taskId: t.id,
      artifactId: art.id,
      findingId: f.id,
      key: f.key,
      kind: "finding",
      finding: { source: f.source, severity: f.severity, title: f.title, detail: f.detail, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), ...(f.why ? { why: f.why } : {}), ...(f.checkId ? { checkId: f.checkId } : {}) },
      routedTo: s.project.triage.askUserBy,
      routedAt: now,
      status: "open",
      usedBy: [],
      createdAt: now,
      ...(earlier
        ? {
            status: earlier.status,
            decidedBy: "carried" as const,
            decidedAt: now,
            carriedFrom: earlier.id,
            ...(earlier.why ? { why: earlier.why } : {}),
            ...(earlier.followUpTaskId ? { followUpTaskId: earlier.followUpTaskId } : {}),
          }
        : {}),
    };
    s.decisions.push(d);
    out.push(d);
    if (earlier) M.event(s, now, "system", "decision", `${d.id}: ${f.id} "${clip(f.title, 80)}" decided as before (${earlier.id}: ${earlier.status} by ${earlier.decidedBy === "carried" ? "an earlier round" : earlier.decidedBy === "lead" ? "the lead" : "you"})`, t.id);
    else M.event(s, now, "system", "decision", `${d.id}: ${f.id} "${clip(f.title, 80)}" needs a decision (${d.routedTo === "lead" ? "the lead" : "you"})`, t.id);
  }
  pruneDecisions(s);
  return out;
}

/** Keep the record bounded: decided decisions of settled tasks go first, oldest first; open ones are never dropped. */
function pruneDecisions(s: State) {
  if (s.decisions.length <= MAX_DECISIONS) return;
  const settled = new Set(s.tasks.filter((t) => t.lifecycle === "done" || t.lifecycle === "cancelled").map((t) => t.id));
  const droppable = (d: FindingDecision, strict: boolean) => d.status !== "open" && (!strict || settled.has(d.taskId));
  for (const strict of [true, false]) {
    for (let i = 0; i < s.decisions.length && s.decisions.length > MAX_DECISIONS; ) {
      if (droppable(s.decisions[i], strict)) s.decisions.splice(i, 1);
      else i++;
    }
  }
}

/** The undecided findings a pending step with `runIf` would read, and who is to decide them. */
export function awaitingDecision(s: State, t: Task): { count: number; lead: number; user: number } | undefined {
  let count = 0;
  let lead = 0;
  let user = 0;
  for (const st of t.steps) {
    if (st.state !== "pending" || !st.runIf?.length) continue;
    for (const r of st.runIf) {
      const art = M.acceptedOutput(s, t, r.step, r.output);
      if (!art?.findings) continue;
      for (const f of art.findings) {
        if (!isBlocking(f) || f.action !== "ask-user") continue;
        const d = decisionFor(s, art, f);
        if (d && d.status !== "open") continue;
        count++;
        if (!d || d.routedTo === "lead") lead++;
        else user++;
      }
    }
  }
  return count ? { count, lead, user } : undefined;
}

/** "Waiting for a decision on 2 findings (the lead)". */
export function awaitingLabel(w: { count: number; lead: number; user: number }): string {
  const who = w.lead && w.user ? "you and the lead" : w.lead ? "the lead" : "you";
  return `Waiting for a decision on ${w.count} finding${w.count === 1 ? "" : "s"} (${who})`;
}

/** A pending step with `runIf` whose findings are still undecided: neither dispatched nor skipped. */
export function stepAwaitsDecision(s: State, t: Task, st: Step): boolean {
  if (!st.runIf?.length) return false;
  return st.runIf.some((r) => {
    const art = M.acceptedOutput(s, t, r.step, r.output);
    return !!art && undecided(s, art) > 0;
  });
}

function assertNote(note: string | undefined): string | undefined {
  const why = note?.trim();
  if (why && why.length > MAX_DECISION_WHY) throw new ControlError(`The note is limited to ${MAX_DECISION_WHY} characters.`);
  return why || undefined;
}

/**
 * The user's decision. "fix": the next repair fixes it. "accept": leave it as it is; later repairs and
 * reviews see it as settled. "follow-up": a new task of yours, held before start, seeded from the
 * finding; the decision then counts as accepted for this task. "reopen": open again; a change applies
 * only to repairs that start later. Allowed at any time, also on a decision the lead took.
 */
export function decideFinding(state: State, decisionId: string, decision: UserDecision, note: string | undefined, now: string): State {
  if (!DECISION_OPTIONS.includes(decision)) throw new ControlError("The decision must be fix, accept, follow-up or reopen.");
  const why = assertNote(note);
  const s = structuredClone(state);
  const d = getDecision(s, decisionId);
  const t = s.tasks.find((x) => x.id === d.taskId);
  if (!t) throw new ControlError(`Unknown task ${d.taskId}`);
  if (d.kind === "final-checks") throw new ControlError("Decisions on failing final checks are not available in this version.");
  if (decision === "reopen") {
    if (d.status === "open" && !d.suggestion) throw new ControlError(`${d.id} is already open.`);
    d.status = "open";
    delete d.decidedBy;
    delete d.decidedAt;
    delete d.leadRunId;
    delete d.suggestion;
    if (why) d.why = why;
    else delete d.why;
    d.routedTo = "user";
    d.routedAt = now;
    M.event(s, now, "user", "decision", `${d.id} reopened${why ? `: ${why}` : ""}${d.usedBy.length ? ` (a repair already used the earlier decision; the change applies to later repairs)` : ""}`, t.id);
    t.updatedAt = now;
    return s;
  }
  if (decision === "follow-up") {
    if (d.followUpTaskId && s.tasks.some((x) => x.id === d.followUpTaskId && x.lifecycle !== "cancelled")) throw new ControlError(`${d.followUpTaskId} already follows up ${d.id}.`);
    const spec = M.currentSpec(t).content;
    const tpl = s.project.templates.find((x) => x.id === "change");
    const where = d.finding.file ? ` (${d.finding.file}${d.finding.line ? `:${d.finding.line}` : ""})` : "";
    const r = M.createTask(
      s,
      {
        title: clip(d.finding.title, 200),
        area: spec.area,
        outcome: `The finding "${clip(d.finding.title, 120)}" from the review of ${t.id} is addressed.`,
        benefit: spec.benefit,
        whyNow: `A review of ${t.id} reported it${where}; it was taken out of that task as a follow-up${why ? `: ${why}` : ""}.`,
        approach: d.finding.detail || d.finding.title,
        acceptance: [`The finding no longer applies${where}`],
        priority: t.priority,
        holdBeforeStart: true,
        steps: tpl ? structuredClone(tpl.steps) : templateSteps("change"),
        templateName: tpl?.name ?? "Change",
      },
      now,
    );
    const next = r.state;
    const dd = getDecision(next, decisionId);
    dd.status = "follow-up";
    dd.decidedBy = "user";
    dd.decidedAt = now;
    dd.followUpTaskId = r.newId;
    delete dd.suggestion;
    if (why) dd.why = why;
    M.event(next, now, "user", "decision", `${dd.id}: follow-up ${r.newId} created for ${dd.findingId} "${clip(dd.finding.title, 80)}"; out of scope for ${t.id}`, t.id);
    const tt = next.tasks.find((x) => x.id === t.id)!;
    tt.updatedAt = now;
    return next;
  }
  d.status = decision;
  d.decidedBy = "user";
  d.decidedAt = now;
  delete d.leadRunId;
  delete d.suggestion;
  if (why) d.why = why;
  else delete d.why;
  M.event(s, now, "user", "decision", `${d.id}: ${decision} for ${d.findingId} "${clip(d.finding.title, 80)}"${why ? ` — ${why}` : ""}${d.usedBy.length ? " (applies to repairs that start later)" : ""}`, t.id);
  t.updatedAt = now;
  return s;
}

/** Move one open decision between the lead and the user ("Send to the lead", "Send to me"). A suggestion on it is kept. */
export function routeDecision(state: State, decisionId: string, to: "lead" | "user", now: string): State {
  if (to !== "lead" && to !== "user") throw new ControlError("Route a decision to the lead or to the user.");
  const s = structuredClone(state);
  const d = getDecision(s, decisionId);
  if (d.status !== "open") throw new ControlError(`${d.id} is decided (${d.status}); reopen it first.`);
  if (d.routedTo === to) return state;
  d.routedTo = to;
  d.routedAt = now;
  M.event(s, now, "user", "decision", `${d.id} sent to ${to === "lead" ? "the lead" : "you"}`, d.taskId);
  return s;
}

/** Open decisions routed to the lead that no lead run has been shown yet (routed after the last run started). */
export function decisionsDueForLead(s: State): FindingDecision[] {
  const last = s.leadRuns.length ? s.leadRuns[s.leadRuns.length - 1].startedAt : "";
  return openDecisions(s, "lead").filter((d) => (d.routedAt ?? d.createdAt) > last);
}

/** Who decides `ask-user` findings created from now on. Open decisions stay where they are. */
export function setTriageRouting(state: State, askUserBy: "lead" | "user", now: string): State {
  if (askUserBy !== "lead" && askUserBy !== "user") throw new ControlError("Findings that need a decision go to the lead or to you.");
  if (state.project.triage.askUserBy === askUserBy) return state;
  const s = structuredClone(state);
  s.project.triage = { askUserBy };
  M.event(s, now, "user", "config", `Findings that need a decision now go to ${askUserBy === "lead" ? "the lead" : "you"}; open decisions stay where they are`);
  return s;
}

/** Whether every run is given the repository's AGENTS.md and CLAUDE.md from the trusted base as project conventions. */
export function setConventions(state: State, include: boolean, now: string): State {
  if (state.project.conventions.include === include) return state;
  const s = structuredClone(state);
  s.project.conventions = { include };
  M.event(s, now, "user", "config", include ? "Runs receive the repository's AGENTS.md and CLAUDE.md as project conventions (from the trusted base)" : "Runs no longer receive the repository's instruction files");
  return s;
}

/**
 * Apply the decisions a lead run reported (untrusted data). Mutates the draft `s`. Each entry names
 * an open decision routed to the lead and gives a reason. "fix" on a finding of a task whose current
 * spec the user wrote becomes a suggestion for the user (the lead never widens scope the user set);
 * "follow-up" proposes a task under the usual caps; "ask-user" hands it to the user. Returns the
 * entries that were refused, with the reason; what was decided is on the records themselves.
 */
export function applyLeadDecisions(s: State, r: LeadRun, raw: unknown, now: string): string[] {
  const notes: string[] = [];
  if (!Array.isArray(raw)) return ["Decisions: not a list; nothing was decided"];
  const shaping = s.project.stage === "shaping";
  const hold = !s.project.autonomy.enabled || s.project.autonomy.holdLeadProposals;
  let proposed = 0;
  raw.forEach((entry, i) => {
    if (i >= MAX_LEAD_DECISIONS) {
      if (i === MAX_LEAD_DECISIONS) notes.push(`Decisions: more than ${MAX_LEAD_DECISIONS} in one run; the rest were ignored`);
      return;
    }
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
    const id = typeof e?.id === "string" ? e.id.slice(0, 40) : `#${i + 1}`;
    const decision = e?.decision;
    const why = typeof e?.why === "string" ? e.why.trim() : "";
    if (!e || typeof e.id !== "string") return void notes.push(`Decision ${id}: not an object with an id`);
    if (!LEAD_OPTIONS.includes(decision as LeadDecision)) return void notes.push(`Decision ${id}: "decision" must be fix, accept, follow-up or ask-user`);
    if (!why || why.length > MAX_DECISION_WHY) return void notes.push(`Decision ${id}: "why" is required (1–${MAX_DECISION_WHY} characters)`);
    const d = s.decisions.find((x) => x.id === e.id);
    if (!d || d.status !== "open" || d.routedTo !== "lead") return void notes.push(`Decision ${id}: not open or not yours`);
    const t = s.tasks.find((x) => x.id === d.taskId);
    if (!t) return void notes.push(`Decision ${id}: its task is gone`);
    const kind = decision as LeadDecision;
    if (d.kind === "final-checks" && kind === "accept") return void notes.push(`Decision ${id}: refused; only the user can accept failing checks`);
    if (d.kind === "final-checks" && kind !== "ask-user") return void notes.push(`Decision ${id}: check rounds are not available in this version; it stays open`);
    if (kind === "ask-user") {
      d.routedTo = "user";
      d.routedAt = now;
      d.why = why;
      d.leadRunId = r.id;
      M.event(s, now, "lead", "decision", `${d.id} sent to you by the lead: ${clip(why, 200)}`, t.id);
      return;
    }
    if (kind === "fix" && M.currentSpec(t).author === "user") {
      d.suggestion = { decision: "fix", why, leadRunId: r.id, at: now };
      d.routedTo = "user";
      d.routedAt = now;
      M.event(s, now, "lead", "decision", `${d.id}: the lead suggests fixing ${d.findingId} "${clip(d.finding.title, 80)}" (a spec you wrote; yours to decide): ${clip(why, 200)}`, t.id);
      return;
    }
    if (kind === "follow-up") {
      const openRoom = Math.max(0, s.project.autonomy.maxOpenProposals - M.openLeadProposals(s).length);
      if (proposed >= openRoom) return void notes.push(`Decision ${id}: follow-up refused; the limit of ${s.project.autonomy.maxOpenProposals} open lead proposals is reached, so it stays open`);
      if (M.deferredLeadRoots(s).length >= s.project.autonomy.maxOpenProposals) return void notes.push(`Decision ${id}: follow-up refused; deferred lead proposals reached their limit, so it stays open`);
      const spec = M.currentSpec(t).content;
      const title = clip((typeof e.title === "string" && e.title.trim()) || d.finding.title, 200);
      const where = d.finding.file ? ` (${d.finding.file}${d.finding.line ? `:${d.finding.line}` : ""})` : "";
      const p: M.LeadProposal = {
        title,
        area: spec.area,
        whyNow: `A review of ${t.id} reported "${clip(d.finding.title, 120)}"${where}. ${clip(why, 300)}`,
        outcome: `The finding "${clip(d.finding.title, 120)}" from the review of ${t.id} is addressed.`,
        benefit: spec.benefit,
        scopeIncluded: [clip(d.finding.detail || d.finding.title, 300)],
        scopeExcluded: [`Changes to ${t.id} beyond this finding`],
        options: [
          { id: "A", name: "Address the finding", approach: clip(d.finding.detail || d.finding.title, 1000), benefit: "The reviewed problem is fixed in its own task", effort: "Small", risks: "Low", reversibility: "High" },
          { id: "B", name: "Defer", approach: "Leave it as it is", benefit: "No cost now", effort: "None", risks: "The finding stays", reversibility: "High" },
        ],
        recommendedOptionId: "A",
        rationale: clip(why, 300),
        uncertainty: "",
        acceptance: [`The finding no longer applies${where}`],
        templateId: "change",
        priority: t.priority,
      };
      const problem = M.validateProposal(s, p, now);
      if (problem) return void notes.push(`Decision ${id}: follow-up refused (${problem}); it stays open`);
      const newId = M.proposeTask(s, p, now, hold, undefined, shaping);
      proposed++;
      d.status = "follow-up";
      d.decidedBy = "lead";
      d.decidedAt = now;
      d.leadRunId = r.id;
      d.why = why;
      d.followUpTaskId = newId;
      M.event(s, now, "lead", "decision", `${d.id}: follow-up ${newId} proposed for ${d.findingId} "${clip(d.finding.title, 80)}": ${clip(why, 200)}`, t.id);
      return;
    }
    d.status = kind;
    d.decidedBy = "lead";
    d.decidedAt = now;
    d.leadRunId = r.id;
    d.why = why;
    M.event(s, now, "lead", "decision", `${d.id}: ${kind} for ${d.findingId} "${clip(d.finding.title, 80)}" — ${clip(why, 200)}`, t.id);
  });
  return notes;
}

/** What a lead run decided, suggested or handed over, from the records (the reply lists this, never the lead's prose). */
export function leadRunDecisions(s: State, leadRunId: string): { decision: FindingDecision; what: "decided" | "suggested" | "handed-over" }[] {
  const out: { decision: FindingDecision; what: "decided" | "suggested" | "handed-over" }[] = [];
  for (const d of s.decisions) {
    if (d.suggestion?.leadRunId === leadRunId) out.push({ decision: d, what: "suggested" });
    else if (d.leadRunId === leadRunId) out.push({ decision: d, what: d.status === "open" ? "handed-over" : "decided" });
  }
  return out;
}

/** The decisions a repair or review envelope lists for a step: those on the findings artifacts it reads. */
export function decisionsForStep(s: State, t: Task, st: Step): FindingDecision[] {
  const ids = new Set(M.consumedInputs(s, t, st).map((i) => i.artifactId));
  return s.decisions.filter((d) => ids.has(d.artifactId));
}

/** A decision, in the words later prompts and the UI use. */
export function decisionLabel(d: FindingDecision): string {
  const by = d.decidedBy === "carried" ? "carried from an earlier round" : d.decidedBy === "lead" ? "by the lead" : "by the user";
  if (d.suggestion) return `suggested fix by the lead, waiting for the user${d.suggestion.why ? `: ${d.suggestion.why}` : ""}`;
  if (d.status === "open") return `waiting for a decision (${d.routedTo === "lead" ? "the lead" : "the user"})`;
  if (d.status === "follow-up") return `followed up as ${d.followUpTaskId ?? "a separate task"} (${by})${d.why ? `: ${d.why}` : ""}`;
  return `decided: ${d.status}, ${by}${d.why ? `: ${d.why}` : ""}`;
}
