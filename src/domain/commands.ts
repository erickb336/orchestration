// The command registry: every change a client can request, mapped to a pure domain operation.
// The service validates argument shapes, applies commands inside a transaction, and records them.
// Clients send `{ name, args }`; they never ship functions or whole states.

import * as C from "./checks";
import * as D from "./delivery";
import * as F from "./findings";
import * as M from "./model";
import { buildSeed } from "./seed";
import {
  ControlError,
  PROJECT_STAGES,
  PROVIDERS,
  ROLES,
  STEERING_MODES,
  type ModelSelection,
  type PrDeliveryConfig,
  type ProjectStage,
  type ProviderId,
  type RoleId,
  type SpecContent,
  type State,
  type SteeringMode,
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
/** An agent role: what has model defaults and overrides. */
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

// Structured payloads (spec content) are shape-checked here and semantically validated by the domain
// operation that receives them. ORC-016: no command accepts step definitions, templates or a catalog;
// a task's steps come from the pattern it names, and the server alone writes the catalog from files.
function specContent(v: unknown): SpecContent {
  const c = obj(v, "content");
  for (const k of ["title", "area", "outcome", "benefit", "selectedOptionId", "recommendedOptionId", "overrideReason"]) str(c, k);
  array(c.options, "content.options");
  return c as unknown as SpecContent;
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

  // shaping the vision with the lead first (ORC-012)
  /** Needs a vision; releases the roadmap on Autopilot, otherwise it keeps waiting for you. */
  startBuilding: same((s, now) => M.startBuilding(s, now)),
  /** Back to shaping: nothing running is stopped; nothing new starts. */
  startShaping: same((s, now) => M.startShaping(s, now)),
  /** Accept the lead's draft as drafted or with edits: a user-authored revision, compare-and-set on the vision. */
  acceptVisionDraft: same((s, now, a) =>
    M.acceptVisionDraft(s, str(a, "draftId"), num(a, "expectedRev"), { text: a.text === undefined ? undefined : str(a, "text"), focus: a.focus === undefined ? undefined : str(a, "focus") }, now),
  ),
  dismissVisionDraft: same((s, now, a) => M.dismissVisionDraft(s, str(a, "draftId"), now)),

  // vision documents (ORC-014)
  /** Record one uploaded file without a revision (sent by POST /api/vision-docs, never by the UI directly). Returns { docId, status, replaces? }. */
  stageVisionDoc: (s, now, a) => {
    const r = M.stageVisionDoc(s, { path: str(a, "path"), size: num(a, "size"), hash: str(a, "hash"), text: bool(a, "text") }, now);
    return { state: r.state, result: r.result };
  },
  /** ORC-014 review 9: attach a batch of staged documents as one vision revision. Returns { revision?, docs }. */
  attachVisionDocs: (s, now, a) => {
    if (!Array.isArray(a.docIds) || !a.docIds.every((x) => typeof x === "string")) throw new InvalidCommandError("docIds must be a list of document ids");
    if (a.docIds.length > M.MAX_VISION_DOCS) throw new InvalidCommandError(`docIds may name at most ${M.MAX_VISION_DOCS} documents`);
    const batchId = a.batchId === undefined ? undefined : str(a, "batchId");
    if (batchId !== undefined && batchId.length > 100) throw new InvalidCommandError("batchId must be at most 100 characters");
    const r = M.attachVisionDocs(s, a.docIds as string[], batchId, now);
    return { state: r.state, result: r.result };
  },
  /** Remove a document from the current set; earlier revisions keep it. */
  removeVisionDoc: same((s, now, a) => M.removeVisionDoc(s, str(a, "docId"), now)),

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

  // pipeline patterns (ORC-016): the structure of a pipeline is never sent by a client
  /** The standard pattern used when a lead proposal or a breakdown item names none. */
  setDefaultPattern: same((s, now, a) => M.setDefaultPattern(s, str(a, "patternId"), now)),

  // review and editing
  setReviewEveryStep: same((s, now, a) => M.setReviewEveryStep(s, str(a, "taskId"), bool(a, "value"), now)),
  editArtifact: same((s, now, a) =>
    M.editArtifact(
      s,
      str(a, "artifactId"),
      {
        summary: str(a, "summary"),
        reason: str(a, "reason"),
        openFindings: a.openFindings === undefined ? undefined : num(a, "openFindings"),
        ref: a.ref === undefined ? undefined : str(a, "ref"),
        items: a.items === undefined ? undefined : array<unknown>(a.items, "items"),
      },
      now,
    ),
  ),
  chooseCandidate: same((s, now, a) => M.chooseCandidate(s, str(a, "taskId"), str(a, "group"), str(a, "stepId"), now)),
  setProviderLimit: same((s, now, a) => M.setProviderLimit(s, provider(a.provider), num(a, "limit"), now)),

  // findings and decisions (ORC-013)
  /** Your decision on one finding: fix, accept (leave it as it is), follow-up (a new held task of yours), or reopen. */
  decideFinding: same((s, now, a) => {
    const decision = str(a, "decision");
    if (!F.DECISION_OPTIONS.includes(decision as F.UserDecision)) throw new InvalidCommandError("decision must be fix, accept, follow-up, or reopen");
    return F.decideFinding(s, str(a, "decisionId"), decision as F.UserDecision, a.note === undefined ? undefined : str(a, "note"), now);
  }),
  /** Who decides ask-user findings from now on: the lead or you. Open decisions stay where they are. */
  setTriageRouting: same((s, now, a) => {
    const to = str(a, "askUserBy");
    if (to !== "lead" && to !== "user") throw new InvalidCommandError("askUserBy must be lead or user");
    return F.setTriageRouting(s, to, now);
  }),
  /** Move one open decision to the lead or to you. */
  routeDecision: same((s, now, a) => {
    const to = str(a, "to");
    if (to !== "lead" && to !== "user") throw new InvalidCommandError("to must be lead or user");
    return F.routeDecision(s, str(a, "decisionId"), to, now);
  }),
  /** Give every run the repository's AGENTS.md and CLAUDE.md (from the trusted base) as project conventions. */
  setConventions: same((s, now, a) => F.setConventions(s, bool(a, "include"), now)),

  // the project's checks, run by the service (ORC-013 §9): the only way the check commands change
  /** The whole checks configuration (minus its revision). `acknowledgeUnsandboxed` confirms "no sandbox". */
  setChecks: same((s, now, a) => {
    const c = obj(a.config, "config");
    const commands = array<unknown>(c.commands, "config.commands").map((x) => {
      const d = obj(x, "command");
      const argv = array<unknown>(d.argv, "command.argv").map((v) => {
        if (typeof v !== "string") throw new InvalidCommandError("command.argv must be strings");
        return v;
      });
      const kind = str(d, "kind");
      if (kind !== "prepare" && kind !== "check") throw new InvalidCommandError("command.kind must be prepare or check");
      return { id: str(d, "id"), label: str(d, "label"), kind: kind as "prepare" | "check", argv, ...(d.timeoutMinutes === undefined ? {} : { timeoutMinutes: num(d, "timeoutMinutes") }) };
    });
    const sandbox = str(c, "sandbox");
    if (sandbox !== "codex" && sandbox !== "none") throw new InvalidCommandError("config.sandbox must be codex or none");
    return C.setChecks(
      s,
      {
        enabled: bool(c, "enabled"),
        commands,
        sandbox,
        prepareNetwork: bool(c, "prepareNetwork"),
        commandTimeoutMinutes: num(c, "commandTimeoutMinutes"),
        runTimeoutMinutes: num(c, "runTimeoutMinutes"),
        maxConcurrent: num(c, "maxConcurrent"),
        protectedInputs: array<unknown>(c.protectedInputs, "config.protectedInputs").map((x) => String(x)),
        passEnv: array<unknown>(c.passEnv, "config.passEnv").map((x) => String(x)),
      },
      a.acknowledgeUnsandboxed === undefined ? false : bool(a, "acknowledgeUnsandboxed"),
      now,
    );
  }),
  /** Probe the checks sandbox now. */
  recheckChecks: same((s, now) => C.recheckChecks(s, now)),

  // the lead
  /** A message stops a planning run in progress so it is answered next; `taskId` names the task page it was sent from. */
  postMessage: same((s, now, a) => M.postMessage(s, str(a, "text"), now, a.taskId === undefined ? undefined : str(a, "taskId"))),
  /** "Answer together now": stop the reply run in progress so the next run answers every pending message. */
  stopLeadReply: same((s, now) => M.stopLeadReply(s, now)),
  setLeadSelection: same((s, now, a) => M.setLeadSelection(s, selection(a.selection), now)),

  // steering by conversation (ORC-009); every one is compare-and-set and reports what it left alone
  undoSteering: (s, now, a) => {
    const r = M.undoSteering(s, str(a, "changeSetId"), a.changeId === undefined ? undefined : str(a, "changeId"), now);
    return { state: r.state, result: r.result };
  },
  applySteering: (s, now, a) => {
    const r = M.applySteering(s, str(a, "changeSetId"), a.changeId === undefined ? undefined : str(a, "changeId"), now);
    return { state: r.state, result: r.result };
  },
  dismissSteering: (s, now, a) => {
    const r = M.dismissSteering(s, str(a, "changeSetId"), a.changeId === undefined ? undefined : str(a, "changeId"), now);
    return { state: r.state, result: r.result };
  },
  /** Run now: lift the task's own deferral and keep it running whatever the focus. */
  undeferTask: same((s, now, a) => M.undeferTask(s, str(a, "taskId"), now)),
  setPriorityPin: same((s, now, a) => M.setPriorityPin(s, str(a, "taskId"), bool(a, "pinned"), now)),
  setRunPin: same((s, now, a) => M.setRunPin(s, str(a, "taskId"), bool(a, "pinned"), now)),
  setSteeringMode: same((s, now, a) => {
    const mode = str(a, "mode");
    if (!STEERING_MODES.includes(mode as SteeringMode)) throw new InvalidCommandError("mode must be apply, apply-own, or suggest");
    return M.setSteeringMode(s, mode as SteeringMode, now);
  }),
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
        autoRetry: a.autoRetry === undefined ? s.project.autonomy.autoRetry : num(a, "autoRetry"),
        autoDeliver:
          a.autoDeliver === undefined
            ? s.project.autonomy.autoDeliver
            : (() => {
                const d = obj(a.autoDeliver, "autoDeliver");
                return { enabled: bool(d, "enabled"), branch: str(d, "branch") };
              })(),
      },
      now,
    );
  }),
  /** Everything runs without waiting for a person: planning, no holds, retries, automatic delivery. */
  retryIntegration: same((s, now, a) => M.retryIntegration(s, str(a, "taskId"), now)),
  applyAutopilot: same((s, now, a) => M.applyAutopilot(s, str(a, "branch"), now)),
  /** Import a Markdown task table once (IDs preserved; open tasks need a spec before they run). */
  importMarkdown: (s, now, a) => {
    const r = M.importMarkdown(s, str(a, "markdown"), now);
    return { state: r.state, result: { imported: r.imported, skipped: r.skipped } };
  },

  // delivery and the review-later queue (ORC-008)
  /** Off, local branch, or GitHub pull requests: never two at once. */
  setDeliveryMode: same((s, now, a) => {
    const mode = str(a, "mode");
    if (mode !== "off" && mode !== "local" && mode !== "pr") throw new InvalidCommandError("mode must be off, local, or pr");
    return D.setDeliveryMode(s, { mode, branch: a.branch === undefined ? undefined : str(a, "branch") }, now);
  }),
  resetDeliveryBaseline: same((s, now) => M.resetDeliveryBaseline(s, now)),
  /** Pull-request settings (remote, base, limits, protected paths). Automatic merging cannot be chosen yet. */
  setPrDelivery: same((s, now, a) => {
    const c = obj(a.config, "config");
    const patch: Partial<PrDeliveryConfig> = {};
    if (c.remote !== undefined) patch.remote = str(c, "remote");
    if (c.base !== undefined) patch.base = str(c, "base");
    if (c.merge !== undefined) patch.merge = str(c, "merge") as PrDeliveryConfig["merge"];
    if (c.reviewer !== undefined) patch.reviewer = str(c, "reviewer") as PrDeliveryConfig["reviewer"];
    if (c.updateBeforeMerge !== undefined) patch.updateBeforeMerge = bool(c, "updateBeforeMerge");
    if (c.autoRepair !== undefined) patch.autoRepair = bool(c, "autoRepair");
    if (c.allowLocalWorkers !== undefined) patch.allowLocalWorkers = bool(c, "allowLocalWorkers");
    if (c.protectedPaths !== undefined) patch.protectedPaths = array<unknown>(c.protectedPaths, "protectedPaths").map((x) => String(x));
    if (c.maxOpenPrs !== undefined) patch.maxOpenPrs = num(c, "maxOpenPrs");
    if (c.maxAutoMergesPerDay !== undefined) patch.maxAutoMergesPerDay = num(c, "maxAutoMergesPerDay");
    // ORC-013 §7.5
    if (c.rerunBudget !== undefined) patch.rerunBudget = num(c, "rerunBudget");
    if (c.reviewBotApps !== undefined) patch.reviewBotApps = array<unknown>(c.reviewBotApps, "reviewBotApps").map((x) => String(x));
    if (c.noCi !== undefined) patch.noCi = bool(c, "noCi");
    return D.setPrDelivery(s, patch, now);
  }),
  /** Run the read-only repository check now. */
  recheckGitHub: same((s, now) => D.recheckGitHub(s, now)),
  holdPr: same((s, now, a) => D.holdPr(s, str(a, "taskId"), a.reason === undefined ? undefined : str(a, "reason"), now)),
  releasePr: same((s, now, a) => D.releasePr(s, str(a, "taskId"), now)),
  setPrPolicy: same((s, now, a) => {
    if (a.policy !== null && a.policy !== "hold" && a.policy !== "auto") throw new InvalidCommandError("policy must be hold, auto, or null");
    return D.setPrPolicy(s, str(a, "taskId"), a.policy, now);
  }),
  /** The user's Merge click, tied to the head commit they saw. */
  requestPrMerge: same((s, now, a) => D.requestPrMerge(s, str(a, "taskId"), str(a, "headSha"), now)),
  allowWorkflowPush: same((s, now, a) => D.allowWorkflowPush(s, str(a, "taskId"), now)),
  closePr: same((s, now, a) => D.closePr(s, str(a, "taskId"), now)),
  redeliver: same((s, now, a) => D.redeliver(s, array<unknown>(a.taskIds, "taskIds").map((x) => String(x)), now)),
  /** Fix this PR: one bounded fix task whose result is pushed onto the same pull request. Returns { newId }. */
  repairPr: (s, now, a) => {
    const r = D.repairPr(s, str(a, "taskId"), now);
    return { state: r.state, result: { newId: r.newId } };
  },
  /** Ask for a dedicated independent review of the pull request's current change now. */
  requestPrReview: same((s, now, a) => D.requestPrReview(s, str(a, "taskId"), now)),
  /** Automatic merging continues after a failing base branch paused it. */
  resumeAutoMerge: same((s, now) => D.resumeAutoMerge(s, now)),
  retryLandedComment: same((s, now, a) => D.retryLandedComment(s, str(a, "taskId"), str(a, "noteId"), now)),
  /** The only way a landed item becomes reviewed (or unreviewed again). */
  markLandedReviewed: same((s, now, a) => D.markLandedReviewed(s, array<unknown>(a.taskIds, "taskIds").map((x) => String(x)), bool(a, "reviewed"), now)),
  addLandedNote: same((s, now, a) => D.addLandedNote(s, str(a, "taskId"), str(a, "text"), a.postToGitHub === undefined ? false : bool(a, "postToGitHub"), now)),
  /** Send landed work back as a fix or a revert through the normal pipeline. Returns { newId }. */
  sendBackLanded: (s, now, a) => {
    const kind = str(a, "kind");
    if (kind !== "fix" && kind !== "revert") throw new InvalidCommandError("kind must be fix or revert");
    const r = D.sendBackLanded(s, { taskId: str(a, "taskId"), kind, note: a.note === undefined ? "" : str(a, "note"), holdBeforeStart: a.holdBeforeStart === undefined ? false : bool(a, "holdBeforeStart") }, now);
    return { state: r.state, result: { newId: r.newId } };
  },

  // real projects
  setWorkerConnections: same((s, now, a) => M.setWorkerConnections(s, provider(a.provider), array<unknown>(a.names, "names").map((x) => String(x)), now)),
  setWorkerEnvironment: same((s, now, a) => {
    const env = str(a, "environment");
    if (env !== "isolated" && env !== "local") throw new InvalidCommandError("environment must be isolated or local");
    return M.setWorkerEnvironment(s, provider(a.provider), env, now);
  }),
  setRunLimits: same((s, now, a) => M.setRunLimits(s, { maxTurns: num(a, "maxTurns"), timeoutMinutes: num(a, "timeoutMinutes"), maxBudgetUsd: num(a, "maxBudgetUsd") }, now)),
  /** ORC-012: `stage` chooses shaping (the vision may be empty) or building (the default; the vision is required). */
  initProject: same((s, now, a) => {
    let stage: ProjectStage | undefined;
    if (a.stage !== undefined) {
      const v = str(a, "stage");
      if (!PROJECT_STAGES.includes(v as ProjectStage)) throw new InvalidCommandError("stage must be shaping or building");
      stage = v as ProjectStage;
    }
    return M.initProject(s, { name: str(a, "name"), repoPath: str(a, "repoPath"), vision: str(a, "vision"), focus: str(a, "focus"), ...(stage ? { stage } : {}) }, now);
  }),
  /** Create a user-authored task from a catalog pattern (`patternId`). Any `steps` sent are ignored. Returns { newId }. */
  createTask: (s, now, a) => {
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
        patternId: str(a, "patternId"),
        priorityPinned: a.priorityPinned === undefined ? false : bool(a, "priorityPinned"),
      },
      now,
    );
    return { state: r.state, result: { newId: r.newId } };
  },

  // prototype only: replace everything with the labeled sample project
  resetSampleData: (s, now) => {
    const next = buildSeed(Date.parse(now), { inFlightRuns: false, checks: true });
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
