// Project setup: the repository, run limits, the workers' environment and connections, the model catalog,
// initProject, and createTask.

import * as C from "../checks";
import { flowRef } from "../flows";
import { instantiate, toDef, validatePipeline } from "../pipeline";
import { validateBlueprintRefs } from "../studio/blueprint";
import { activeStudioRuns } from "../studio/runs";
import { emptyBlueprint, emptyStudio } from "../studio/types";
import {
  type CatalogModel,
  type RunLimits,
  type WorkerEnvironment,
  type ProviderId,
  type SpecContent,
  type State,
  type ChosenBy,
  ControlError,
  autoModelDefaults,
  DEFAULT_AUTONOMY,
  DEFAULT_CHECKS,
  DEFAULT_PR_DELIVERY,
  NO_BUDGETS,
} from "../types";
import { activeAttempts, draft, event } from "./core";
import { activeLeadRun } from "./lead";
import { providerLabel } from "./resolution";
import { creationFlow } from "./taskFlow";

export function setRepoPath(state: State, repoPath: string, now: string): State {
  const s = draft(state);
  if (!repoPath.trim()) throw new ControlError("Repository path cannot be empty.");
  s.project.repoPath = repoPath.trim();
  event(s, now, "user", "config", `Managed repository set to ${s.project.repoPath}; affects runs not yet dispatched`);
  return s;
}

export function setRunLimits(state: State, limits: RunLimits, now: string): State {
  const s = draft(state);
  const ok = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  if (!ok(limits.maxTurns, 1, 500) || !ok(limits.timeoutMinutes, 1, 240) || !ok(limits.maxBudgetUsd, 0.01, 1000)) {
    throw new ControlError("Run limits out of range: turns 1–500, time 1–240 minutes, budget $0.01–$1000.");
  }
  s.project.runLimits = { maxTurns: Math.round(limits.maxTurns), timeoutMinutes: limits.timeoutMinutes, maxBudgetUsd: limits.maxBudgetUsd };
  event(s, now, "user", "config", `Run limits: ${s.project.runLimits.maxTurns} turns, ${limits.timeoutMinutes} min, $${limits.maxBudgetUsd} (Claude)`);
  return s;
}

/** Whether housekeeping also cleans what runs left in the owner's Codex and Claude (server/housekeeping.ts). */
export function setHousekeepOwnerApps(state: State, on: boolean, now: string): State {
  if (state.project.housekeepOwnerApps === on) return state;
  const s = draft(state);
  s.project.housekeepOwnerApps = on;
  event(s, now, "user", "config", on ? "Housekeeping cleans what runs leave in Codex and Claude again" : "Housekeeping no longer touches Codex or Claude; it still removes the service's own containers and stage folders");
  return s;
}

export function setWorkerEnvironment(state: State, provider: ProviderId, environment: WorkerEnvironment, now: string): State {
  const s = draft(state);
  s.project.workerEnvironment[provider] = environment;
  event(
    s,
    now,
    "user",
    "config",
    `${providerLabel(provider)} workers: ${environment === "local" ? "use the local setup (settings, MCP servers, plugins)" : "isolated from the local setup"}; applies to runs started from now on`,
  );
  return s;
}

export function setWorkerConnections(state: State, provider: ProviderId, names: string[], now: string): State {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort();
  if (clean.some((n) => n.length > 100)) throw new ControlError("Connection names are too long.");
  const s = draft(state);
  s.project.workerConnections[provider] = clean;
  event(s, now, "user", "config", `${providerLabel(provider)} isolated workers may use: ${clean.length ? clean.join(", ") : "no connections"}; applies to runs started from now on`);
  return s;
}

/** Replace the provider's model catalog with the list the connected runtime reported. */
export function setCatalog(state: State, provider: ProviderId, models: CatalogModel[], now: string): State {
  const s = draft(state);
  if (JSON.stringify(s.project.catalog[provider]) === JSON.stringify(models)) return state;
  s.project.catalog[provider] = models;
  event(s, now, "system", "config", `${providerLabel(provider)} model catalog updated from the runtime (${models.length} models)`);
  return s;
}

/**
 * Start a real project: empty board, the given repository and vision (which may be empty). Refused while any
 * run is active, so no live work is orphaned by the replacement. Every project begins shaping (Vision); only
 * the owner's Start the factory moves it to building.
 */
export function initProject(state: State, init: { name: string; repoPath: string; vision: string; focus: string }, now: string): State {
  if (activeAttempts(state).length || activeLeadRun(state) || activeStudioRuns(state).length) throw new ControlError("Stop all active runs (pause the project and wait for Paused) before starting a new project.");
  if (!init.name.trim() || !init.repoPath.trim()) throw new ControlError("Name and repository path are required.");
  const s = draft(state);
  s.project.id = `p-${Date.parse(now).toString(36)}-${s.seq.toString(36)}`;
  s.project.sample = false;
  s.project.name = init.name.trim();
  s.project.repoPath = init.repoPath.trim();
  // A new project starts from provider-neutral defaults, never another project's model choices.
  Object.assign(s.project, autoModelDefaults());
  s.project.visions = [{ rev: 1, at: now, author: "user", text: init.vision.trim(), focus: init.focus.trim(), reason: "Project created; the vision is shaped with the lead first" }];
  // Documents belong to the project they were attached to; a new project starts with none.
  s.project.visionDocs = [];
  s.project.stage = "shaping";
  s.project.shapingSince = now;
  s.project.devices = ["desktop", "mobile"];
  // Not chosen yet: the lead proposes the domains, and the owner confirms them.
  s.project.domains = [];
  s.project.factoryStarts = [];
  s.project.changeOrders = "lead";
  // New work in the factory waits for PE review: on for a new project (ORC-029 pass 5).
  s.project.peReviewsNewWork = true;
  s.project.hold = false;
  s.project.lastVisitAt = now;
  // Delivery to GitHub is a choice made per project and repository: a new project starts with it off
  // and with nothing observed about the previous repository.
  s.project.prDelivery = structuredClone(DEFAULT_PR_DELIVERY);
  delete s.project.github;
  // Local delivery writes to a branch of the previous repository, and its baseline is a commit there.
  s.project.autonomy.autoDeliver = { ...DEFAULT_AUTONOMY.autoDeliver };
  delete s.project.delivery;
  // The preview runs the previous repository's commands; only the owner sets it for this one.
  delete s.project.preview;
  // Checks are off until the user turns them on for this repository, and nothing has been probed for it.
  s.project.checks = structuredClone(DEFAULT_CHECKS);
  delete s.project.checksHealth;
  // Budgets belong to the project they were set for.
  s.project.budgets = { ...NO_BUDGETS };
  delete s.project.budgetContinued;
  // The catalog is machine-level and stays; the default flow is a project choice.
  s.project.defaultFlowId = "change";
  s.decisions = [];
  s.tasks = [];
  s.attempts = [];
  s.artifacts = [];
  s.events = [];
  s.conversation = [];
  s.leadRuns = [];
  // An old project's change sets must not rewrite a new project's task with the same id.
  s.steering = [];
  s.visionDrafts = [];
  // The studio and the blueprint belong to the project too.
  s.studio = emptyStudio();
  s.blueprint = emptyBlueprint();
  s.project.lastPlanningAt = undefined;
  event(s, now, "user", "vision", `Project "${s.project.name}" created for ${s.project.repoPath}; it starts in Vision`);
  return s;
}

export interface NewTask {
  title: string;
  area: string;
  outcome: string;
  benefit: string;
  whyNow: string;
  acceptance: string[];
  approach: string;
  priority: number;
  holdBeforeStart: boolean;
  /** The catalog flow the pipeline comes from. Any flow but an internal one; nothing else supplies steps. */
  flowId: string;
  /** Default "user". The service passes "service" for the follow-ups it creates. */
  chosenBy?: ChosenBy;
  /** The user chose the priority (not the form's default): the lead may not reorder it. */
  priorityPinned?: boolean;
  /** The blueprint items the task builds (ORC-029 pass 5), for example a review finding's fix; checked like a spec edit. */
  blueprintRefs?: string[];
}

/**
 * A user-authored task. Its spec records one approach decided by the user and says so; the lead
 * has not proposed alternatives (the spec allows a single option when that is stated).
 */
export function createTask(state: State, t: NewTask, now: string): { state: State; newId: string } {
  if (!t.title.trim() || !t.outcome.trim() || !t.approach.trim()) throw new ControlError("Title, outcome, and approach are required.");
  const flow = creationFlow(state, t.flowId);
  const errors = validatePipeline(flow.steps, { checkIds: C.configuredCheckIds(state.project.checks) }).filter((i) => i.severity === "error");
  if (errors.length) throw new ControlError(`Pipeline is invalid: ${errors.map((e) => e.message).join(" ")}`);
  const s = draft(state);
  let n = s.tasks.length + 1;
  const ids = new Set(s.tasks.map((x) => x.id));
  while (ids.has(`T-${String(n).padStart(3, "0")}`)) n++;
  const id = `T-${String(n).padStart(3, "0")}`;
  const content: SpecContent = {
    title: t.title.trim(),
    area: t.area.trim() || "General",
    whyNow: t.whyNow.trim(),
    outcome: t.outcome.trim(),
    benefit: t.benefit.trim(),
    successCriteria: [],
    scopeIncluded: [],
    scopeExcluded: [],
    options: [
      { id: "A", name: "As described", approach: t.approach.trim(), benefit: t.benefit.trim(), effort: "Unknown", risks: "Not assessed; user-authored", reversibility: "Changes stay on an orchestration branch until merged" },
      { id: "B", name: "Defer", approach: "Do not do this now", benefit: "No cost", effort: "None", risks: "The outcome is not delivered", reversibility: "N/A" },
    ],
    recommendedOptionId: "A",
    selectedOptionId: "A",
    decidedBy: "user",
    rationale: "User-authored task; the lead has not proposed alternatives.",
    uncertainty: "",
    overrideReason: "",
    acceptance: t.acceptance.map((x) => x.trim()).filter(Boolean),
    validationPlan: "",
    rollback: "Discard the orchestration branch.",
    effort: "small",
    ...(t.blueprintRefs?.length ? { blueprintRefs: validateBlueprintRefs(state, t.blueprintRefs) } : {}),
  };
  const defs = structuredClone(flow.steps).map(toDef);
  const ref = flowRef(flow, t.chosenBy ?? "user");
  s.tasks.push({
    id,
    priority: Math.max(1, Math.round(t.priority) || 1),
    lifecycle: "proposed",
    hold: false,
    holdBeforeStart: t.holdBeforeStart,
    specs: [{ rev: 1, at: now, author: "user", reason: "Task created by user", content }],
    steps: instantiate(defs),
    roleOverrides: {},
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    decisionAt: now,
    pipelineRev: 1,
    pipelineHistory: [{ rev: 1, at: now, author: "user", reason: `Created from the ${flow.name} flow`, steps: defs, flow: ref }],
    flow: ref,
    flowSince: 1,
    ...(t.priorityPinned ? { userSet: { priority: now } } : {}),
  });
  event(s, now, "user", "spec", `Created ${id}: ${content.title}`, id);
  return { state: s, newId: id };
}
