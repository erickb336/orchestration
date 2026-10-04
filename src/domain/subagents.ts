// Subagents (ORC-031): the provider's own helper agents, which a run's agent may start. Only a read-only research step
// may start them, only when the owner lets that step start helpers, and only on a provider whose adapter tracks them
// (proven by real runs: the capability map's `childAgentTracking`). Each one is recorded on its run, with its cost. One
// that starts where none is allowed is counted, shown on its run and listed under Needs you. Pure.

import { draft, event } from "./model/core";
import { baseId } from "./model/fanout";
import { providerLabel } from "./model/resolution";
import { isResearchRun, type StudioRun } from "./studio/types";
import {
  ControlError,
  MAX_SUBAGENTS_LISTED,
  MAX_SUBAGENT_ASK,
  MAX_SUBAGENT_CAP,
  PROVIDERS,
  isProvider,
  type Attempt,
  type LeadRun,
  type ProviderId,
  type Runner,
  type RunSubagents,
  type State,
  type StepDef,
  type SubagentAllowance,
  type SubagentReport,
  type Task,
} from "./types";

// ---------- the research steps a setting names ----------

/** The setting's key for the studio's probes. */
export const PROBE_KEY = "studio/probe";

/** "investigation/S1": a research step of a built-in flow, by the flow's id and the step's id. */
export const stepKey = (flowId: string, stepId: string) => `${flowId}/${stepId}`;

/** A research step the owner may let start helpers. */
export interface ResearchStep {
  key: string;
  /** "Investigation · S1 Investigate and gather evidence", "Vision studio · Probes". */
  label: string;
}

/** Every research step: each built-in flow's, in catalog order, then the studio's probes. */
export function researchSteps(s: State): ResearchStep[] {
  const steps = s.flows.flatMap((f) => f.steps.filter((st) => st.research).map((st) => ({ key: stepKey(f.id, st.id), label: `${f.name} · ${st.id} ${st.purpose}` })));
  return [...steps, { key: PROBE_KEY, label: "Vision studio · Probes for the PE" }];
}

/** The setting's key for a task's step: its flow's research step, or undefined (not research, or not a built-in flow). */
export function taskStepKey(t: Task, st: Pick<StepDef, "id" | "research">): string | undefined {
  if (!st.research || t.flow.source !== "built-in") return undefined;
  return stepKey(t.flow.id, baseId(st.id));
}

// ---------- the setting ----------

/**
 * The providers whose adapter tracks subagents (`childAgentTracking: "supported"`), as the service's adapters say at
 * start. The service's only; nothing is written when nothing changed. A setting stays stored when its provider stops
 * tracking them, and has no effect there (`allowSubagentsForStep`).
 */
export function setSubagentProviders(state: State, providers: ProviderId[], now: string): State {
  const next = PROVIDERS.filter((p) => providers.includes(p));
  if (next.length === state.project.subagentProviders.length && next.every((p, i) => state.project.subagentProviders[i] === p)) return state;
  const s = draft(state);
  s.project.subagentProviders = next;
  event(s, now, "system", "config", next.length ? `Helper agents are tracked on ${next.map(providerLabel).join(" and ")}` : "No provider tracks helper agents: research steps start none");
  return s;
}

/**
 * How each provider's cap holds (ORC-031): Claude's hook counts helpers per run; Codex limits them only at once
 * (`agents.max_threads`), so a Codex run may start more over time. The owner allowed Codex helpers on those terms
 * (ORC-030 r6, 2026-10-03), and the setting says so beside it.
 */
export const HELPER_CAP: Record<ProviderId, "per run" | "at once"> = { claude: "per run", codex: "at once" };

/** "at most 2 per run on Claude, at most 2 at once on Codex": the cap on the providers that track helpers. */
export function capWords(cap: number, providers: readonly ProviderId[]): string {
  return providers.map((p) => `at most ${cap} ${HELPER_CAP[p]} on ${providerLabel(p)}`).join(", ");
}

/** Whether any provider tracks subagents yet: without one, the setting cannot be turned on. */
export const canAllowSubagents = (s: State) => s.project.subagentProviders.length > 0;

/**
 * "Let research steps start helpers" for one research step: `cap` helpers per run (1 to MAX_SUBAGENT_CAP), or null
 * to turn it off. The owner's only. Refused for a step that is not research, and turning it on is refused while no
 * provider tracks subagents (both are "unsupported" until real runs prove pause, cost and safety for them).
 */
export function setResearchHelpers(state: State, key: string, cap: number | null, now: string): State {
  const step = researchSteps(state).find((r) => r.key === key);
  if (!step) throw new ControlError(`${key} is not a research step. Only read-only research steps may start helpers.`);
  if (cap !== null) {
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_SUBAGENT_CAP) throw new ControlError(`The cap is a whole number from 1 to ${MAX_SUBAGENT_CAP}.`);
    if (!canAllowSubagents(state)) throw new ControlError("No provider tracks helper agents yet, so research steps cannot start them. A provider is turned on only after real runs prove that pause stops its helpers and that their cost is counted.");
  }
  const current = state.project.researchHelpers[key]?.cap ?? null;
  if (current === cap) return state;
  const s = draft(state);
  if (cap === null) delete s.project.researchHelpers[key];
  else s.project.researchHelpers[key] = { cap };
  const on = s.project.subagentProviders.map(providerLabel).join(" and ");
  event(s, now, "user", "config", cap === null ? `${step.label}: helpers off` : `${step.label}: helpers on, ${capWords(cap, s.project.subagentProviders)} (${on} only)`);
  return s;
}

// ---------- what a run may start ----------

/**
 * What a run may start, from the setting's key and the run's provider: the cap when the owner allows it there, else
 * none. On a provider whose cap holds only at once (HELPER_CAP), the allowance says so.
 */
function allowance(s: State, key: string | undefined, provider: Runner): SubagentAllowance | undefined {
  if (!key || !isProvider(provider) || !s.project.subagentProviders.includes(provider)) return undefined;
  const set = s.project.researchHelpers[key];
  return set ? { cap: set.cap, ...(HELPER_CAP[provider] === "at once" ? { atOnce: true as const } : {}) } : undefined;
}

/** What a task step's run may start, resolved at dispatch and recorded in its snapshot. */
export const allowSubagentsForStep = (s: State, t: Task, st: Pick<StepDef, "id" | "research">, provider: Runner) => allowance(s, taskStepKey(t, st), provider);

/** What a studio run may start: a probe's run, under the probes' setting; no other studio run. */
export const allowSubagentsForStudioRun = (s: State, r: Pick<StudioRun, "kind" | "provider">) => (isResearchRun(r.kind) ? allowance(s, PROBE_KEY, r.provider) : undefined);

// ---------- the record ----------

/** A run of any kind: a task step's, the lead's, or the studio's. */
type AnyRun = Attempt | LeadRun | StudioRun;

/** A run's own allowance: what its snapshot (a task run) or its record (a studio run) says; a lead run may start none. */
export function allowanceOf(r: AnyRun): SubagentAllowance | undefined {
  if ("snapshot" in r) return r.snapshot.allowSubagents;
  if ("kind" in r) return r.allowSubagents;
  return undefined;
}

function findRun(s: State, id: string): AnyRun | undefined {
  return s.attempts.find((a) => a.id === id) ?? s.leadRuns.find((r) => r.id === id) ?? s.studio.runs.find((r) => r.id === id);
}

/** "S1's run run-12", "the lead's run lead-3", "Probe run studio-4". */
function runName(r: AnyRun): string {
  if ("snapshot" in r) return `${r.taskId} ${r.stepId}'s run ${r.id}`;
  if ("kind" in r) return `${r.kind === "pe" ? "The PE's" : r.kind === "probe" ? "A probe's" : "The designer's"} run ${r.id}`;
  return `The lead's run ${r.id}`;
}

const running = (x: RunSubagents) => x.items.filter((i) => !i.ended).length;

/**
 * Record what the runtime reported about one subagent of a run. Any run that exists takes it, ended or not: the record
 * is what the provider did, and a subagent that slipped through must be counted. A start where none is allowed, or past
 * the run's cap, also goes in the activity log (Needs you lists the first kind). A report for an id already recorded
 * in that phase changes nothing.
 */
export function reportSubagent(state: State, runId: string, report: SubagentReport, now: string): State {
  const before = findRun(state, runId);
  if (!before) return state;
  const known = before.subagents?.items.find((i) => i.id === report.id);
  if (report.phase === "started" && known) return state;
  if (report.phase === "refused" && known) return state;
  if (report.phase === "ended" && known?.ended) return state;
  // Past the list, an end for an unknown id is most likely an unlisted one ending, which was counted at its start.
  if (report.phase === "ended" && !known && (before.subagents?.items.length ?? 0) >= MAX_SUBAGENTS_LISTED) return state;
  const s = draft(state);
  const run = findRun(s, runId)!;
  const rec = (run.subagents ??= { count: 0, mostAtOnce: 0, items: [] });
  const taskId = "snapshot" in run ? run.taskId : undefined;
  const full = rec.items.length >= MAX_SUBAGENTS_LISTED;
  const ask = (text: string) => (text.length > MAX_SUBAGENT_ASK ? { asked: text.slice(0, MAX_SUBAGENT_ASK), askedCut: true as const } : { asked: text });
  if (report.phase === "refused") {
    if (!full) rec.items.push({ id: report.id, startedAt: now, endedAt: now, ...ask(report.asked), usageInParent: true, ended: "refused" });
    event(s, now, "runtime", "runtime", `${runName(run)}: a helper agent was refused, over the cap of ${allowanceOf(run)?.cap ?? 0}`, taskId);
    return s;
  }
  if (report.phase === "ended" && known) {
    Object.assign(rec.items.find((i) => i.id === report.id)!, { endedAt: now, ended: report.how }, report.model ? { model: report.model } : {}, report.usage ? { usage: { ...report.usage } } : {});
    return s;
  }
  // A start, or an end for a subagent whose start was never reported: it ran, so it counts.
  rec.count++;
  if (full) rec.unlisted = (rec.unlisted ?? 0) + 1;
  else if (report.phase === "started") rec.items.push({ id: report.id, startedAt: now, ...ask(report.asked), ...(report.model ? { model: report.model } : {}), usageInParent: report.usageInParent });
  // Its start was not reported, so neither was what it was asked, nor where its usage counts: counted apart, so the budget never misses it.
  else rec.items.push({ id: report.id, startedAt: now, endedAt: now, asked: "", ...(report.model ? { model: report.model } : {}), ...(report.usage ? { usage: { ...report.usage } } : {}), usageInParent: false, ended: report.how });
  rec.mostAtOnce = Math.max(rec.mostAtOnce, running(rec), 1);
  const allowed = allowanceOf(run);
  if (!allowed) {
    // A new one after the owner marked the earlier ones as seen is theirs to know about again.
    delete rec.seenAt;
    event(s, now, "runtime", "blocked", `${runName(run)} started a helper agent where none is allowed`, taskId);
  }
  // A cap that holds at once is passed only by more running together; a per-run cap, by more in the run.
  else if (allowed.atOnce ? running(rec) > allowed.cap : rec.count > allowed.cap) event(s, now, "runtime", "blocked", allowed.atOnce ? `${runName(run)} ran ${running(rec)} helper agents at once, over its cap of ${allowed.cap} at once` : `${runName(run)} started ${rec.count} helper agents, over its cap of ${allowed.cap}`, taskId);
  return s;
}

// ---------- what slipped through ----------

/** A run whose agent started subagents where none is allowed, and which the owner has not marked as seen. */
export interface SlippedThrough {
  runId: string;
  /** The task, for a task step's run. */
  taskId?: string;
  /** Where the run is shown. */
  href: string;
  count: number;
  /** "T-4 S1's run run-12". */
  name: string;
}

/** Every run with subagents where none is allowed, not yet marked as seen, oldest run first. */
export function slippedThrough(s: State): SlippedThrough[] {
  const runs: AnyRun[] = [...s.attempts, ...s.leadRuns, ...s.studio.runs];
  return runs
    .filter((r) => r.subagents && r.subagents.count > 0 && !allowanceOf(r) && !r.subagents.seenAt)
    .map((r) => ({
      runId: r.id,
      ...("snapshot" in r ? { taskId: r.taskId } : {}),
      href: "snapshot" in r ? `#/task/${encodeURIComponent(r.taskId)}` : "kind" in r ? "#/vision" : "#/activity",
      count: r.subagents!.count,
      name: runName(r),
    }));
}

/** The owner saw the subagents that slipped through on a run: it leaves Needs you. The record stays on the run. */
export function markSubagentsSeen(state: State, runId: string, now: string): State {
  const run = findRun(state, runId);
  if (!run?.subagents) throw new ControlError(`Run ${runId} reported no helper agents.`);
  if (run.subagents.seenAt) return state;
  const s = draft(state);
  findRun(s, runId)!.subagents!.seenAt = now;
  event(s, now, "user", "control", `Marked the helper agents of run ${runId} as seen`, "snapshot" in run ? run.taskId : undefined);
  return s;
}
