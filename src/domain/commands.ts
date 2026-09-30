// The command registry: every change a client can request, mapped to a pure domain operation.
// The service validates argument shapes, applies commands inside a transaction, and records them.
// Clients send `{ name, args }`; they never ship functions or whole states.

import * as M from "./model";
import { buildSeed } from "./seed";
import { BUILT_IN_TEMPLATES } from "./templates";
import {
  ControlError,
  PROVIDERS,
  ROLES,
  type ModelSelection,
  type ProviderId,
  type RoleId,
  type SpecContent,
  type State,
  type StepDef,
  type WorkflowTemplate,
} from "./types";

export class InvalidCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCommandError";
  }
}

type Outcome = { state: State; result?: unknown };

// ---- minimal argument validation (clients are local but untrusted input is still input) ----

type Args = Record<string, unknown>;
function obj(v: unknown, what = "args"): Args {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InvalidCommandError(`${what} must be an object`);
  return v as Args;
}
function str(a: Args, k: string): string {
  if (typeof a[k] !== "string") throw new InvalidCommandError(`${k} must be a string`);
  return a[k] as string;
}
function num(a: Args, k: string): number {
  if (typeof a[k] !== "number" || !Number.isFinite(a[k])) throw new InvalidCommandError(`${k} must be a number`);
  return a[k] as number;
}
function bool(a: Args, k: string): boolean {
  if (typeof a[k] !== "boolean") throw new InvalidCommandError(`${k} must be a boolean`);
  return a[k] as boolean;
}
function provider(v: unknown): ProviderId {
  if (!PROVIDERS.includes(v as ProviderId)) throw new InvalidCommandError(`unknown provider ${String(v)}`);
  return v as ProviderId;
}
function role(v: unknown): RoleId {
  if (!ROLES.includes(v as RoleId)) throw new InvalidCommandError(`unknown role ${String(v)}`);
  return v as RoleId;
}
function selection(v: unknown): ModelSelection {
  const o = obj(v, "selection");
  return { provider: provider(o.provider), model: str(o, "model") };
}
function selectionOrNull(v: unknown): ModelSelection | null {
  return v === null ? null : selection(v);
}
function array<T>(v: unknown, what: string): T[] {
  if (!Array.isArray(v)) throw new InvalidCommandError(`${what} must be an array`);
  return v as T[];
}

// Structured payloads (spec content, step definitions, templates) are shape-checked here and
// semantically validated by the domain operation that receives them.
function specContent(v: unknown): SpecContent {
  const c = obj(v, "content");
  for (const k of ["title", "area", "outcome", "benefit", "selectedOptionId", "recommendedOptionId", "overrideReason"]) str(c, k);
  array(c.options, "content.options");
  return c as unknown as SpecContent;
}
function stepDefs(v: unknown): StepDef[] {
  return array<unknown>(v, "steps").map((x) => {
    const d = obj(x, "step");
    str(d, "id");
    str(d, "purpose");
    role(d.role);
    array(d.dependsOn, "step.dependsOn");
    array(d.inputs, "step.inputs");
    array(d.outputs, "step.outputs");
    return d as unknown as StepDef;
  });
}
function template(v: unknown): WorkflowTemplate {
  const t = obj(v, "template");
  str(t, "id");
  str(t, "name");
  str(t, "description");
  return { ...(t as unknown as WorkflowTemplate), steps: stepDefs(t.steps) };
}

// ---- registry ----

type Handler = (s: State, now: string, args: Args) => Outcome;
const same = (f: (s: State, now: string, a: Args) => State): Handler => (s, now, a) => ({ state: f(s, now, a) });

export const COMMANDS = {
  // task controls
  pauseTask: same((s, now, a) => M.pauseTask(s, str(a, "taskId"), now)),
  resumeTask: same((s, now, a) => M.resumeTask(s, str(a, "taskId"), now)),
  startHeldTask: same((s, now, a) => M.startHeldTask(s, str(a, "taskId"), now)),
  setHoldBeforeStart: same((s, now, a) => M.setHoldBeforeStart(s, str(a, "taskId"), bool(a, "value"), now)),
  cancelTask: same((s, now, a) => M.cancelTask(s, str(a, "taskId"), now)),
  setPriority: same((s, now, a) => M.setPriority(s, str(a, "taskId"), num(a, "priority"), now)),
  retryStop: same((s, now, a) => M.retryStop(s, str(a, "taskId"), now)),

  // project controls
  pauseProject: same((s, now) => M.pauseProject(s, now)),
  resumeProject: same((s, now) => M.resumeProject(s, now)),
  markVisited: same((s, now) => M.markVisited(s, now)),
  editVision: same((s, now, a) => M.editVision(s, num(a, "expectedRev"), str(a, "text"), str(a, "focus"), str(a, "reason"), now)),

  // specs
  editSpec: same((s, now, a) => M.editSpec(s, str(a, "taskId"), num(a, "expectedRev"), specContent(a.content), str(a, "reason"), "user", now)),
  overrideSelection: same((s, now, a) => M.overrideSelection(s, str(a, "taskId"), num(a, "expectedRev"), str(a, "optionId"), str(a, "reason"), now)),
  createFollowUp: (s, now, a) => {
    const r = M.createFollowUp(s, str(a, "taskId"), now);
    return { state: r.state, result: { newId: r.newId } };
  },
  /** Create a follow-up from a delivered task and immediately save a draft spec on it. */
  createFollowUpWithSpec: (s, now, a) => {
    const r = M.createFollowUp(s, str(a, "taskId"), now);
    return { state: M.editSpec(r.state, r.newId, 1, specContent(a.content), str(a, "reason"), "user", now), result: { newId: r.newId } };
  },

  // steps and models
  setStepSelection: same((s, now, a) => M.setStepSelection(s, str(a, "taskId"), str(a, "stepId"), selectionOrNull(a.selection), now)),
  setTaskRoleOverride: same((s, now, a) => M.setTaskRoleOverride(s, str(a, "taskId"), role(a.role), selectionOrNull(a.selection), now)),
  setRoleDefault: same((s, now, a) => M.setRoleDefault(s, role(a.role), selectionOrNull(a.selection), now)),
  setProjectDefault: same((s, now, a) => M.setProjectDefault(s, selection(a.selection), now)),
  setProviderEnabled: same((s, now, a) => M.setProviderEnabled(s, provider(a.provider), bool(a, "enabled"), now)),
  setWorkerLimit: same((s, now, a) => M.setWorkerLimit(s, num(a, "limit"), now)),
  setRepoPath: same((s, now, a) => M.setRepoPath(s, str(a, "repoPath"), now)),
  rerunStep: same((s, now, a) => M.rerunStep(s, str(a, "taskId"), str(a, "stepId"), now)),
  retryStep: same((s, now, a) => M.retryStep(s, str(a, "taskId"), str(a, "stepId"), now)),

  // pipelines and templates
  setPipeline: same((s, now, a) => M.setPipeline(s, str(a, "taskId"), num(a, "expectedRev"), stepDefs(a.steps), str(a, "reason"), "user", now)),
  saveTemplate: same((s, now, a) => M.saveTemplate(s, template(a.template), a.expectedRev === null ? null : num(a, "expectedRev"), now)),
  deleteTemplate: same((s, now, a) => M.deleteTemplate(s, str(a, "templateId"), now)),
  restoreBuiltInTemplates: same((s, now) =>
    BUILT_IN_TEMPLATES.filter((b) => !s.project.templates.some((t) => t.id === b.id)).reduce((acc, b) => M.saveTemplate(acc, structuredClone(b), null, now), s),
  ),

  // the lead
  postMessage: same((s, now, a) => M.postMessage(s, str(a, "text"), now)),
  setLeadSelection: same((s, now, a) => M.setLeadSelection(s, selection(a.selection), now)),
  setAutonomy: same((s, now, a) => {
    const hours = a.operatingHours === null || a.operatingHours === undefined ? null : obj(a.operatingHours, "operatingHours");
    return M.setAutonomy(
      s,
      {
        enabled: bool(a, "enabled"),
        planningIntervalMinutes: num(a, "planningIntervalMinutes"),
        maxProposalsPerCycle: num(a, "maxProposalsPerCycle"),
        maxOpenProposals: num(a, "maxOpenProposals"),
        holdLeadProposals: bool(a, "holdLeadProposals"),
        operatingHours: hours ? { start: str(hours, "start"), end: str(hours, "end") } : null,
      },
      now,
    );
  }),

  // real projects
  setWorkerConnections: same((s, now, a) => M.setWorkerConnections(s, provider(a.provider), array<unknown>(a.names, "names").map((x) => String(x)), now)),
  setWorkerEnvironment: same((s, now, a) => {
    const env = str(a, "environment");
    if (env !== "isolated" && env !== "local") throw new InvalidCommandError("environment must be isolated or local");
    return M.setWorkerEnvironment(s, provider(a.provider), env, now);
  }),
  setRunLimits: same((s, now, a) => M.setRunLimits(s, { maxTurns: num(a, "maxTurns"), timeoutMinutes: num(a, "timeoutMinutes"), maxBudgetUsd: num(a, "maxBudgetUsd") }, now)),
  initProject: same((s, now, a) => M.initProject(s, { name: str(a, "name"), repoPath: str(a, "repoPath"), vision: str(a, "vision"), focus: str(a, "focus") }, now)),
  /** Create a user-authored task from one of the project's templates. Returns { newId }. */
  createTask: (s, now, a) => {
    const templateId = str(a, "templateId");
    const tpl = s.project.templates.find((t) => t.id === templateId);
    if (!tpl) throw new InvalidCommandError(`Unknown template ${templateId}`);
    const r = M.createTask(
      s,
      {
        title: str(a, "title"),
        area: str(a, "area"),
        outcome: str(a, "outcome"),
        benefit: str(a, "benefit"),
        whyNow: str(a, "whyNow"),
        approach: str(a, "approach"),
        acceptance: array<unknown>(a.acceptance, "acceptance").map((x) => String(x)),
        priority: num(a, "priority"),
        holdBeforeStart: bool(a, "holdBeforeStart"),
        steps: structuredClone(tpl.steps),
        templateName: tpl.name,
      },
      now,
    );
    return { state: r.state, result: { newId: r.newId } };
  },

  // prototype only: replace everything with the labeled sample project
  resetSampleData: (s, now) => {
    const next = buildSeed(Date.parse(now), { inFlightRuns: false });
    // Never reuse generated ids: a runtime process or event row from before the reset must not
    // be confused with a new run or event that happens to receive the same id.
    next.seq = Math.max(next.seq, s.seq) + 1;
    return { state: next };
  },
} satisfies Record<string, Handler>;

export type CommandName = keyof typeof COMMANDS;

export function isCommandName(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name);
}

/** Apply a named command. Throws InvalidCommandError, ControlError, or StaleWriteError. */
export function runCommand(state: State, name: string, args: unknown, now: string): Outcome {
  if (!isCommandName(name)) throw new InvalidCommandError(`Unknown command ${name}`);
  const handler: Handler = COMMANDS[name];
  return handler(state, now, args === undefined ? {} : obj(args));
}

export { ControlError };
