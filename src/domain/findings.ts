// Structured findings and per-finding triage. Pure functions over the state: derived counts
// (what a repair may fix, what is undecided, what is unresolved), the decisions on `ask-user`
// findings, their routing to the lead, the PE or the user, carry-forward of an earlier decision on the same
// finding, and the validation of the decisions a lead run reports. Summary-only (legacy) artifacts
// keep their `openFindings` semantics everywhere.
//
// The PE's route (ORC-029 2d). On it the PE decides, within the budgets: a call whose stated cost would take the
// building spend or the maintenance estimate past a budget goes to the owner, even on Autopilot. The PE does not run
// its own decisions yet (pass 4): the lead's decision runs decide its decisions with the PE's brief, and the record
// says so (`decidedBy: "pe"`, with the call, its cost and the lead run in `pe`). The owner reverses a PE call as they
// reverse the lead's.

import * as C from "./checks";
import * as M from "./model";
import { fmtUsd, pastBudget } from "./spend";
import { readEstimate } from "./studio/studio";
import type { BudgetEstimate } from "./studio/types";
import { clip } from "./text";
import { ControlError, type Artifact, type Finding, type FindingDecision, type LeadRun, type PeCall, type Project, type State, type Step, type Task } from "./types";

export const MAX_DECISIONS = 2000;
export const MAX_DECISION_WHY = 300;
const MAX_LEAD_DECISIONS = 20;
export const DECISION_OPTIONS = ["fix", "accept", "follow-up", "reopen"] as const;
export type UserDecision = (typeof DECISION_OPTIONS)[number];
const LEAD_OPTIONS = ["fix", "accept", "follow-up", "ask-user"] as const;
type LeadDecision = (typeof LEAD_OPTIONS)[number];

/** A finding that must be fixed or decided: an error or warning that is not information only. */
export const isBlocking = (f: Finding) => f.severity !== "info" && f.action !== "no-op";

/** Two artifacts are versions of the same output: the same task, step and name. */
function sameOutput(s: State, a: Pick<Artifact, "id" | "taskId" | "stepId" | "name">, artifactId: string): boolean {
  if (a.id === artifactId) return true;
  const b = s.artifacts.find((x) => x.id === artifactId);
  return !!b && b.taskId === a.taskId && b.stepId === a.stepId && b.name === a.name;
}

/**
 * The decision record for one finding of one artifact (the newest, if several). A person's edit of the
 * summary makes a new artifact version with the same findings, and `editArtifact` moves the decisions
 * to it, so nothing waits on a record that exists.
 */
export function decisionFor(s: State, art: Pick<Artifact, "id">, f: Pick<Finding, "id">): FindingDecision | undefined {
  let best: FindingDecision | undefined;
  for (const d of s.decisions) if (d.artifactId === art.id && d.findingId === f.id) best = d;
  return best;
}

/** A finding decided "accept" or "follow-up" is settled whatever action the report gives it. */
const settled = (d: FindingDecision | undefined) => d?.status === "accept" || d?.status === "follow-up";

/** Work a repair may do: auto-fix blocking findings not settled earlier, plus ask-user ones decided "fix". Legacy: openFindings. */
export function fixable(s: State, art: Artifact): number {
  if (!art.findings) return art.openFindings ?? 0;
  let n = 0;
  for (const f of art.findings) {
    if (!isBlocking(f)) continue;
    const d = decisionFor(s, art, f);
    if (settled(d)) continue;
    if (f.action === "auto-fix" || d?.status === "fix") n++;
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

/** Not resolved: blocking findings not decided "accept" or "follow-up". Legacy: openFindings. */
export function unresolved(s: State, art: Artifact): number {
  if (!art.findings) return art.openFindings ?? 0;
  let n = 0;
  for (const f of art.findings) if (isBlocking(f) && !settled(decisionFor(s, art, f))) n++;
  return n;
}

/** Blocking findings someone decided to accept as they are, as "F2 title" labels. */
export function acceptedFindings(s: State, art: Artifact): string[] {
  if (!art.findings) return [];
  const out: string[] = [];
  for (const f of art.findings) if (isBlocking(f) && settled(decisionFor(s, art, f))) out.push(`${f.id} ${clip(f.title, 80)}`);
  return out;
}

/**
 * The decided decision an earlier round of this task (or the origin task of a pull-request repair) took
 * on a finding with this key, if any: what carry-forward repeats.
 */
export function earlierDecision(s: State, t: Task, key: string): FindingDecision | undefined {
  const origin = t.deliverInto?.taskId;
  const originTask = origin !== undefined ? s.tasks.find((x) => x.id === origin) : undefined;
  let earlier: FindingDecision | undefined;
  for (const d of s.decisions) {
    if (d.key !== key || d.status === "open" || d.status === "superseded" || d.kind !== "finding") continue;
    const owner = d.taskId === t.id ? t : originTask && d.taskId === originTask.id ? originTask : undefined;
    if (!owner) continue;
    // A decision taken under a flow the task has since left is the record, not a precedent.
    if (fromEarlierFlow(s, owner, d)) continue;
    earlier = d;
  }
  return earlier;
}

/** The decision's artifact was made under a flow its task has since left. A decision whose artifact is gone is not. */
export function fromEarlierFlow(s: State, t: Task, d: FindingDecision): boolean {
  const art = s.artifacts.find((a) => a.id === d.artifactId);
  return !!art && M.fromEarlierFlow(s, t, art);
}

/** Blocking findings of a fresh report that an earlier decision on this task already settled (accept or follow-up). */
export function settledByKey(s: State, t: Task, f: Finding): boolean {
  return settled(earlierDecision(s, t, f.key));
}

/** The service-computed open count of a structured artifact: blocking findings (error or warning, auto-fix or ask-user). */
export const blockingCount = (findings: Finding[]) => findings.filter(isBlocking).length;

/** Every decision of a task, newest first. */
export function decisionsOf(s: State, taskId: string): FindingDecision[] {
  return s.decisions.filter((d) => d.taskId === taskId).reverse();
}

/** Open decisions routed to `to`. */
export function openDecisions(s: State, to?: FindingDecision["routedTo"]): FindingDecision[] {
  return s.decisions.filter((d) => d.status === "open" && (to === undefined || d.routedTo === to));
}

/** Open decisions an agent takes: the lead's, and the PE's (which the lead's decision runs take until the PE runs its own). */
export function agentDecisions(s: State): FindingDecision[] {
  return s.decisions.filter((d) => d.status === "open" && d.routedTo !== "user");
}

/** Who decides, in words. */
export const DECIDER: Record<"lead" | "pe", string> = { lead: "the lead", pe: "the PE" };

/** "The lead is deciding 2 findings", "The PE is deciding 1 finding", or both, for open decisions an agent takes; "" for none. */
export function agentsDecidingLabel(ds: Pick<FindingDecision, "routedTo">[]): string {
  const findings = (n: number) => `${n} finding${n === 1 ? "" : "s"}`;
  const lead = ds.filter((d) => d.routedTo === "lead").length;
  const pe = ds.filter((d) => d.routedTo === "pe").length;
  const parts = [lead ? `the lead is deciding ${findings(lead)}` : "", pe ? `the PE is deciding ${findings(pe)} (through the lead's decision runs, with the PE's brief)` : ""].filter(Boolean).join("; ");
  return parts ? parts[0].toUpperCase() + parts.slice(1) : "";
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
  for (const f of art.findings) {
    if (!isBlocking(f) || decisionFor(s, art, f)) continue;
    const earlier = earlierDecision(s, t, f.key);
    // An auto-fix finding needs no record, unless an earlier round settled it: then the record says so.
    if (f.action !== "ask-user" && !settled(earlier)) continue;
    const d: FindingDecision = {
      id: M.nextId(s, "fd"),
      taskId: t.id,
      artifactId: art.id,
      findingId: f.id,
      key: f.key,
      kind: "finding",
      finding: { source: f.source, severity: f.severity, title: f.title, detail: f.detail, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), ...(f.why ? { why: f.why } : {}), ...(f.checkId ? { checkId: f.checkId } : {}) },
      routedTo: routeOf(s),
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
    if (earlier) M.event(s, now, "system", "decision", `${d.id}: ${f.id} "${clip(f.title, 80)}" decided as before (${earlier.id}: ${earlier.status} by ${earlier.decidedBy === "carried" ? "an earlier round" : earlier.decidedBy === "lead" || earlier.decidedBy === "pe" ? DECIDER[earlier.decidedBy] : "you"})`, t.id);
    else M.event(s, now, "system", "decision", `${d.id}: ${f.id} "${clip(f.title, 80)}" ${d.routedTo === "user" ? "needs you to decide" : `waits for ${DECIDER[d.routedTo]}'s decision`}`, t.id);
  }
  pruneDecisions(s);
  return out;
}

/**
 * Keep the record bounded: decided decisions of settled tasks go first, oldest first. A task is
 * settled once cancelled, or done and landed (or done with no delivery to wait for). Open decisions,
 * and decided ones a repair or the gate may still read (an unsettled task), are never dropped: the
 * cap yields rather than reopen a finding.
 */
function pruneDecisions(s: State) {
  if (s.decisions.length <= MAX_DECISIONS) return;
  const delivery = s.project.prDelivery.enabled || s.project.autonomy.autoDeliver.enabled;
  const settledTask = (t: Task) => t.lifecycle === "cancelled" || (t.lifecycle === "done" && (!!t.integration?.landed || t.integration?.status === "not-needed" || !delivery));
  const settledIds = new Set(s.tasks.filter(settledTask).map((t) => t.id));
  const droppable = (d: FindingDecision) => d.status !== "open" && (d.status === "superseded" || settledIds.has(d.taskId) || !s.tasks.some((t) => t.id === d.taskId));
  for (let i = 0; i < s.decisions.length && s.decisions.length > MAX_DECISIONS; ) {
    if (droppable(s.decisions[i])) s.decisions.splice(i, 1);
    else i++;
  }
}

/**
 * Close the open decisions nothing can act on any more: those of a cancelled
 * task, or on an artifact a later run replaced. Decided ones are kept as the record. Mutates the draft.
 */
export function supersedeDecisions(s: State, taskId: string, now: string, o: { artifactId?: string; reason: string }): number {
  let n = 0;
  for (const d of s.decisions) {
    if (d.taskId !== taskId || d.status !== "open") continue;
    if (o.artifactId !== undefined && d.artifactId !== o.artifactId) continue;
    d.status = "superseded";
    d.decidedAt = now;
    d.why = o.reason;
    delete d.suggestion;
    n++;
  }
  if (n) M.event(s, now, "system", "decision", `${n} open decision${n === 1 ? "" : "s"} closed: ${o.reason}`, taskId);
  return n;
}

/** The undecided findings a pending step with `runIf` would read, and who is to decide them. */
export function awaitingDecision(s: State, t: Task): { count: number; lead: number; pe: number; user: number } | undefined {
  let count = 0;
  let lead = 0;
  let pe = 0;
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
        // A finding with no record is nobody's yet: it is shown as the user's, never as "the lead's".
        if (d?.routedTo === "lead") lead++;
        else if (d?.routedTo === "pe") pe++;
        else user++;
      }
    }
  }
  return count ? { count, lead, pe, user } : undefined;
}

/** The label for undecided findings: "Needs you: decide 2 findings", "The lead is deciding 1 finding", "The PE is deciding 1 finding", or several when the findings are split. */
export function awaitingLabel(w: { count: number; lead: number; pe?: number; user: number }): string {
  const findings = (n: number) => `${n} finding${n === 1 ? "" : "s"}`;
  const agents = [w.lead ? `the lead is deciding ${findings(w.lead)}` : "", w.pe ? `the PE is deciding ${findings(w.pe)}` : ""].filter(Boolean).join("; ");
  if (w.user && agents) return `Needs you: decide ${findings(w.user)}; ${agents}`;
  if (agents) return agents[0].toUpperCase() + agents.slice(1);
  return `Needs you: decide ${findings(w.count)}`;
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
  // A decision closed by a flow change belongs to the earlier flow; the new flow's review raises its own findings.
  if (d.status === "superseded" && d.kind === "finding" && fromEarlierFlow(s, t, d)) {
    throw new ControlError(`${d.id} belongs to an earlier flow of ${t.id}: it was closed when the flow changed and cannot be decided. The new flow's review reports its own findings.`);
  }
  // Failing final checks take a repair round, or the user's acceptance (only the user's).
  if (d.kind === "final-checks") {
    C.decideFinalChecks(s, d, decision, why, now);
    return s;
  }
  // The owner reverses a PE call as they reverse the lead's; the call stays on the record (`pe`).
  const reversing = d.decidedBy === "pe" && d.status !== "open" ? ` (reversing the PE's call: ${d.status})` : "";
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
    M.event(s, now, "user", "decision", `${d.id} reopened${reversing}${why ? `: ${why}` : ""}${d.usedBy.length ? ` (a repair already used the earlier decision; the change applies to later repairs)` : ""}`, t.id);
    t.updatedAt = now;
    return s;
  }
  if (decision === "follow-up") {
    if (d.followUpTaskId && s.tasks.some((x) => x.id === d.followUpTaskId && x.lifecycle !== "cancelled")) throw new ControlError(`${d.followUpTaskId} already follows up ${d.id}.`);
    const spec = M.currentSpec(t).content;
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
        // A follow-up fix runs the catalog's Change, chosen by the service.
        flowId: "change",
        chosenBy: "service",
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
    M.event(next, now, "user", "decision", `${dd.id}: follow-up ${r.newId} created for ${dd.findingId} "${clip(dd.finding.title, 80)}"; out of scope for ${t.id}${reversing}`, t.id);
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
  M.event(s, now, "user", "decision", `${d.id}: ${decision} for ${d.findingId} "${clip(d.finding.title, 80)}"${reversing}${why ? ` — ${why}` : ""}${d.usedBy.length ? " (applies to repairs that start later)" : ""}`, t.id);
  t.updatedAt = now;
  return s;
}

/** Move one open decision between the lead, the PE and the user ("Send to the lead", "Send to me"). A suggestion on it is kept. */
export function routeDecision(state: State, decisionId: string, to: FindingDecision["routedTo"], now: string): State {
  if (to !== "lead" && to !== "pe" && to !== "user") throw new ControlError("Route a decision to the lead, the PE or the user.");
  const s = structuredClone(state);
  const d = getDecision(s, decisionId);
  if (d.status !== "open") throw new ControlError(`${d.id} is decided (${d.status}); reopen it first.`);
  if (to === "pe" && d.kind === "final-checks") throw new ControlError("Failing final checks are decided by the lead or by you.");
  if (d.routedTo === to) return state;
  d.routedTo = to;
  d.routedAt = now;
  M.event(s, now, "user", "decision", `${d.id} sent to ${to === "user" ? "you" : DECIDER[to]}`, d.taskId);
  return s;
}

/**
 * Open decisions for the lead's decision runs (its own and, until the PE runs its own, the PE's) that no completed
 * lead run has been shown yet (routed after the last completed run started). A run that failed or was lost decided
 * nothing, so they are due again; the lead's failure backoff still applies.
 */
export function decisionsDueForLead(s: State): FindingDecision[] {
  let last = "";
  for (const r of s.leadRuns) if ((r.outcome === "completed" || r.outcome === "running" || r.outcome === "stopping") && r.startedAt > last) last = r.startedAt;
  return agentDecisions(s).filter((d) => (d.routedAt ?? d.createdAt) > last);
}

/**
 * The task whose specification a decision is really about: a dedicated review or a repair of a pull
 * request acts on that pull request's task, whose spec the user may have written.
 */
export function owningTask(s: State, t: Task): Task {
  let cur = t;
  for (let i = 0; i < 5; i++) {
    const id = cur.reviewTarget?.taskId ?? cur.deliverInto?.taskId ?? cur.checkTarget?.taskId;
    const next = id ? s.tasks.find((x) => x.id === id) : undefined;
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

/** Who decides `ask-user` findings created from now on. Open decisions stay where they are. */
export function setTriageRouting(state: State, askUserBy: Project["triage"]["askUserBy"], now: string): State {
  if (askUserBy !== "lead" && askUserBy !== "pe" && askUserBy !== "user") throw new ControlError("Findings that need a decision go to the lead, the PE or you.");
  if (state.project.triage.askUserBy === askUserBy) return state;
  const s = structuredClone(state);
  s.project.triage = { askUserBy };
  const who = askUserBy === "lead" ? "the lead" : askUserBy === "pe" ? "the PE (the lead decides for it until the PE runs its own decisions)" : "you";
  M.event(s, now, "user", "config", `Findings that need a decision now go to ${who}; open decisions stay where they are`);
  return s;
}

/**
 * Where a new decision goes: the project's route. Failing final checks are not a trade-off (an agent may only add a
 * bounded repair round, and only the owner accepts them), so on the PE's route they stay with the lead.
 */
export function routeOf(s: State, kind: FindingDecision["kind"] = "finding"): FindingDecision["routedTo"] {
  const to = s.project.triage.askUserBy;
  return to === "pe" && kind === "final-checks" ? "lead" : to;
}

/** Whether every run is given the repository's AGENTS.md and CLAUDE.md from the trusted base as project conventions. */
export function setConventions(state: State, include: boolean, now: string): State {
  if (state.project.conventions.include === include) return state;
  const s = structuredClone(state);
  s.project.conventions = { include };
  M.event(s, now, "user", "config", include ? "Runs receive the repository's AGENTS.md and CLAUDE.md as project conventions (from the trusted base)" : "Runs no longer receive the repository's instruction files");
  return s;
}

/** "build $0.00–$2.00, maintenance $0.00–$0.00 a month (recorded runs)", or that none was stated. */
export function costLine(c: BudgetEstimate | undefined): string {
  if (!c) return "no budget effect stated";
  const range = ([lo, hi]: [number, number]) => (lo === hi ? fmtUsd(hi) : `${fmtUsd(lo)}–${fmtUsd(hi)}`);
  const parts = [c.buildUsd ? `build ${range(c.buildUsd)}` : "", c.maintenanceUsdPerMonth ? `maintenance ${range(c.maintenanceUsdPerMonth)} a month` : ""].filter(Boolean);
  return `${parts.join(", ") || "no figure"} (${c.basis})`;
}

/**
 * The PE's call on a decision on its route, as a lead decision run made it with the PE's brief: its stated cost read
 * (untrusted), and whether the call stays within the budgets. A cost that cannot be read is never guessed: the call
 * goes to the owner.
 */
function peCall(s: State, r: LeadRun, decision: PeCall["decision"], why: string, rawCost: unknown, now: string): PeCall {
  let cost: BudgetEstimate | undefined;
  let unreadable: string | undefined;
  if (rawCost !== undefined && rawCost !== null) {
    try {
      cost = readEstimate(rawCost);
    } catch (err) {
      unreadable = `its budget effect could not be read (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const past = unreadable ?? pastBudget(s, cost);
  return { decision, why, ...(cost ? { cost } : {}), by: "lead-run", leadRunId: r.id, at: now, ...(past ? { pastBudget: past } : {}) };
}

/**
 * Apply the decisions a lead run reported (untrusted data). Mutates the draft `s`. Each entry names
 * an open decision routed to the lead, or to the PE (which the lead's decision runs decide with the PE's brief until
 * the PE runs its own), and gives a reason. "fix" on a finding of a task whose current
 * spec the user wrote becomes a suggestion for the user (the lead never widens scope the user set);
 * "follow-up" proposes a task under the usual caps; "ask-user" hands it to the user. A PE call states its cost
 * ("cost"); one that would pass a budget, or states no figure for a budget that is set, goes to the user instead,
 * with the call recorded. Returns the entries that were refused, with the reason; what was decided is on the records
 * themselves.
 */
export function applyLeadDecisions(s: State, r: LeadRun, raw: unknown, now: string): string[] {
  const notes: string[] = [];
  if (!Array.isArray(raw)) return ["Decisions: not a list; nothing was decided"];
  const shaping = s.project.stage === "shaping";
  const hold = !s.project.autonomy.enabled || s.project.autonomy.holdLeadProposals;
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
    if (!d || d.status !== "open" || (d.routedTo !== "lead" && d.routedTo !== "pe")) return void notes.push(`Decision ${id}: not open or not yours`);
    const t = s.tasks.find((x) => x.id === d.taskId);
    if (!t) return void notes.push(`Decision ${id}: its task is gone`);
    const kind = decision as LeadDecision;
    // On failing final checks the lead may add a repair round or hand over; it can never accept.
    if (d.kind === "final-checks") {
      const note = C.leadDecidesFinalChecks(s, d, kind, why, r.id, now);
      if (note) notes.push(note);
      return;
    }
    const asPe = d.routedTo === "pe";
    const who = asPe ? "the PE" : "the lead";
    if (kind === "ask-user") {
      d.routedTo = "user";
      d.routedAt = now;
      d.why = why;
      d.leadRunId = r.id;
      M.event(s, now, "lead", "decision", `${d.id} sent to you by ${who}: ${clip(why, 200)}`, t.id);
      return;
    }
    // The PE decides within the budgets only: a call past a budget is the owner's, even on Autopilot.
    const call = asPe ? peCall(s, r, kind, why, e.cost, now) : undefined;
    if (call?.pastBudget) {
      d.pe = call;
      d.routedTo = "user";
      d.routedAt = now;
      d.why = why;
      d.leadRunId = r.id;
      M.event(s, now, "lead", "decision", `${d.id}: the PE would ${kind === "follow-up" ? "follow up" : kind} ${d.findingId} "${clip(d.finding.title, 80)}", but ${call.pastBudget}; spending past a budget is yours to decide`, t.id);
      return;
    }
    const pe = call ? ` as the PE (lead run ${r.id}, with the PE's brief; ${costLine(call.cost)})` : "";
    if (kind === "fix" && M.currentSpec(owningTask(s, t)).author === "user") {
      d.suggestion = { decision: "fix", why, leadRunId: r.id, at: now };
      if (call) d.pe = call;
      d.routedTo = "user";
      d.routedAt = now;
      M.event(s, now, "lead", "decision", `${d.id}: ${who} suggests fixing ${d.findingId} "${clip(d.finding.title, 80)}" (a spec you wrote; yours to decide)${pe}: ${clip(why, 200)}`, t.id);
      return;
    }
    if (kind === "follow-up") {
      // Each proposal counts once: what this run already proposed is among the open proposals.
      if (M.openLeadProposals(s).length >= s.project.autonomy.maxOpenProposals) return void notes.push(`Decision ${id}: follow-up refused; the limit of ${s.project.autonomy.maxOpenProposals} open lead proposals is reached, so it stays open`);
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
        flowId: "change",
        priority: t.priority,
      };
      const problem = M.validateProposal(s, p, now);
      if (problem) return void notes.push(`Decision ${id}: follow-up refused (${problem}); it stays open`);
      const newId = M.proposeTask(s, p, now, hold, undefined, shaping);
      d.status = "follow-up";
      d.decidedBy = asPe ? "pe" : "lead";
      d.decidedAt = now;
      d.leadRunId = r.id;
      d.why = why;
      d.followUpTaskId = newId;
      if (call) d.pe = call;
      M.event(s, now, "lead", "decision", `${d.id}: follow-up ${newId} proposed for ${d.findingId} "${clip(d.finding.title, 80)}"${pe}: ${clip(why, 200)}`, t.id);
      return;
    }
    d.status = kind;
    d.decidedBy = asPe ? "pe" : "lead";
    d.decidedAt = now;
    d.leadRunId = r.id;
    d.why = why;
    if (call) d.pe = call;
    M.event(s, now, "lead", "decision", `${d.id}: ${kind} for ${d.findingId} "${clip(d.finding.title, 80)}"${pe} — ${clip(why, 200)}`, t.id);
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

/** The decisions a repair or review envelope lists for a step: those on the findings artifacts it reads, any version of them. */
export function decisionsForStep(s: State, t: Task, st: Step): FindingDecision[] {
  const read = M.consumedInputs(s, t, st).map((i) => s.artifacts.find((a) => a.id === i.artifactId)).filter((a): a is Artifact => !!a);
  return s.decisions.filter((d) => d.taskId === t.id && read.some((a) => sameOutput(s, a, d.artifactId)));
}

/** A decision, in the words later prompts and the UI use. */
export function decisionLabel(d: FindingDecision): string {
  const by = d.decidedBy === "carried" ? "carried from an earlier round" : d.decidedBy === "lead" ? "by the lead" : d.decidedBy === "pe" ? "by the PE (a lead run with the PE's brief)" : "by the user";
  if (d.suggestion) return `suggested fix by ${d.pe ? "the PE" : "the lead"}, waiting for the user${d.suggestion.why ? `: ${d.suggestion.why}` : ""}`;
  if (d.status === "open") return `waiting for a decision (${d.routedTo === "user" ? "the user" : DECIDER[d.routedTo]})`;
  if (d.status === "superseded") return `no longer open${d.why ? `: ${d.why}` : ""}`;
  if (d.status === "follow-up") return `followed up as ${d.followUpTaskId ?? "a separate task"} (${by})${d.why ? `: ${d.why}` : ""}`;
  return `decided: ${d.status}, ${by}${d.why ? `: ${d.why}` : ""}`;
}
