// The command registry: every change a client can request, mapped to a pure domain operation.
// The service validates argument shapes, applies commands inside a transaction, and records them.
// Clients send `{ name, args }`; they never ship functions or whole states.

import * as C from "./checks";
import * as D from "./delivery";
import * as F from "./findings";
import { buildDemo } from "./demo";
import * as M from "./model";
import * as P from "./peReview";
import type { PeReviewTarget } from "./peReview";
import * as B from "./studio/blueprint";
import { setDomains } from "./studio/domains";
import * as R from "./studio/runs";
import * as S from "./studio/studio";
import { type Mark, type StudioMaker, type VariantRules, ROUND_FOCUSES, STUDIO_AGENT_ROLES, STUDIO_ARTIFACT_KINDS, STUDIO_RUN_KINDS, VERDICTS } from "./studio/types";
import { parseDictionary, parseRules } from "./studio/words";
import {
  ControlError,
  DEVICES,
  PROJECT_DOMAINS,
  PROVIDERS,
  ROLES,
  STEERING_MODES,
  type Device,
  type ProjectDomain,
  type FactorySettings,
  type ModelSelection,
  type PrDeliveryConfig,
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
function numOrNull(a: Args, k: string): number | null {
  return a[k] === null ? null : num(a, k);
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

function strings(v: unknown, what: string): string[] {
  const xs = array<unknown>(v, what);
  if (!xs.every((x) => typeof x === "string")) throw new InvalidCommandError(`${what} must be a list of strings`);
  return xs as string[];
}
function oneOf<T extends string>(o: Args, k: string, options: readonly T[]): T {
  const v = str(o, k);
  if (!options.includes(v as T)) throw new InvalidCommandError(`${k} must be ${options.join(", ")}`);
  return v as T;
}
/** The factory's settings as the owner chose them. */
function factorySettings(v: unknown): FactorySettings {
  const o = obj(v, "settings");
  const p = obj(o.pausePoints, "settings.pausePoints");
  const d = obj(o.delivery, "settings.delivery");
  return {
    autonomy: oneOf(o, "autonomy", ["autopilot", "checkin", "manual"] as const),
    // Whether the combination holds together is the domain's to say (startFactory refuses one that contradicts itself).
    delivery: { mode: oneOf(d, "mode", ["off", "local", "pr"] as const), ...(d.branch === undefined ? {} : { branch: str(d, "branch") }), merge: oneOf(d, "merge", ["user", "auto"] as const) },
    pausePoints: { tradeoffs: oneOf(p, "tradeoffs", ["lead", "pe", "user"] as const), changeOrders: oneOf(p, "changeOrders", ["lead", "user"] as const), startEachTask: bool(p, "startEachTask") },
  };
}

// Structured payloads (spec content) are shape-checked here and semantically validated by the domain
// operation that receives them. A client never sends the structure of a pipeline: a task's steps come
// from the flow it names, and the server alone writes the flows, from the built-in files, at start.
function specContent(v: unknown): SpecContent {
  const c = obj(v, "content");
  for (const k of ["title", "area", "outcome", "benefit", "selectedOptionId", "recommendedOptionId", "overrideReason"]) str(c, k);
  array(c.options, "content.options");
  if (c.blueprintRefs !== undefined) strings(c.blueprintRefs, "content.blueprintRefs");
  return c as unknown as SpecContent;
}

// ---- the studio (ORC-029): shapes here, the rules in src/domain/studio ----

const optStr = (a: Args, k: string): string | undefined => (a[k] === undefined ? undefined : str(a, k));
function int(a: Args, k: string): number {
  const n = num(a, k);
  if (!Number.isInteger(n) || n < 0) throw new InvalidCommandError(`${k} must be a whole number`);
  return n;
}
function range(v: unknown, what: string): [number, number] | undefined {
  if (v === undefined) return undefined;
  const r = array<unknown>(v, what);
  if (r.length !== 2 || !r.every((x) => typeof x === "number")) throw new InvalidCommandError(`${what} must be [low, high] in dollars`);
  return r as [number, number];
}
function studioMaker(v: unknown): StudioMaker {
  const o = obj(v, "madeBy");
  if (o.role === "user") return { role: "user" };
  return { role: oneOf(o, "role", STUDIO_AGENT_ROLES), provider: provider(o.provider), model: str(o, "model"), attemptId: str(o, "attemptId") };
}
function feedbackEntry(v: unknown): S.FeedbackInput {
  const e = obj(v, "entry");
  if (e.mark !== null && !["keep", "change", "drop"].includes(e.mark as string)) throw new InvalidCommandError("mark must be keep, change, drop or null");
  const pins = array<unknown>(e.pins, "pins").map((x) => {
    const p = obj(x, "pin");
    return { x: num(p, "x"), y: num(p, "y"), ...(p.variant === undefined ? {} : { variant: str(p, "variant") }), text: str(p, "text"), ...(p.selector === undefined ? {} : { selector: str(p, "selector") }) };
  });
  const rows = e.rows === undefined ? [] : array<unknown>(e.rows, "rows").map((x) => {
    const r = obj(x, "row");
    return { row: str(r, "row"), ...(r.variant === undefined ? {} : { variant: str(r, "variant") }), mark: oneOf(r, "mark", MARKS) };
  });
  return { artifactId: str(e, "artifactId"), version: int(e, "version"), mark: e.mark as Mark | null, ...(e.pickedVariant === undefined ? {} : { pickedVariant: str(e, "pickedVariant") }), pins, ...(rows.length ? { rows } : {}), note: str(e, "note") };
}
const MARKS: readonly Mark[] = ["keep", "change", "drop"];
/** A dictionary's terms or a flow's rules given to addStudioArtifact: the same checks as at import (words.ts). */
function checked<T>(r: { ok: true; value: T } | { ok: false; errors: string[] }, what: string): T {
  if (!r.ok) throw new InvalidCommandError(`${what}: ${r.errors.join("; ")}`);
  return r.value;
}
function variantRules(v: unknown): VariantRules {
  const o = obj(v, "rules");
  return { variant: str(o, "variant"), path: str(o, "path"), ...checked(parseRules({ rules: o.rules, examples: o.examples }), "rules") };
}
function askCheck(v: unknown): { ask: string; met: boolean } {
  const o = obj(v, "earlier ask");
  return { ask: str(o, "ask"), met: bool(o, "met") };
}
function openCase(v: unknown): { text: string; why?: string } {
  const o = obj(v, "open case");
  return { text: str(o, "text"), ...(o.why === undefined ? {} : { why: str(o, "why") }) };
}
function verdictInput(v: unknown): S.VerdictInput {
  const o = obj(v, "verdict");
  const b = o.budget === undefined ? undefined : obj(o.budget, "budget");
  return {
    ...(o.variant === undefined ? {} : { variant: str(o, "variant") }),
    verdict: oneOf(o, "verdict", VERDICTS),
    reasons: str(o, "reasons"),
    ...(o.change === undefined ? {} : { change: str(o, "change") }),
    ...(o.earlier === undefined ? {} : { earlier: array<unknown>(o.earlier, "earlier").map(askCheck) }),
    ...(o.fromRevision === undefined ? {} : { fromRevision: bool(o, "fromRevision") }),
    ...(o.openCases === undefined ? {} : { openCases: array<unknown>(o.openCases, "openCases").map(openCase) }),
    ...(b ? { budget: { buildUsd: range(b.buildUsd, "budget.buildUsd"), maintenanceUsdPerMonth: range(b.maintenanceUsdPerMonth, "budget.maintenanceUsdPerMonth"), basis: str(b, "basis") } } : {}),
  };
}

/**
 * The work a PE review verdict or an overrule is about: `taskId` (a lead proposal), `taskId` with `stepId` (the
 * breakdown or the design that step made), or `changeOrder` (a blueprint revision).
 */
function peReviewTarget(a: Args): PeReviewTarget {
  if ((a.taskId === undefined) === (a.changeOrder === undefined)) throw new InvalidCommandError("name the work: taskId, or changeOrder");
  if (a.taskId === undefined) return { changeOrder: int(a, "changeOrder") };
  return { taskId: str(a, "taskId"), ...(a.stepId === undefined ? {} : { stepId: str(a, "stepId") }) };
}

/**
 * Commands the service records from its agents' runs: the studio's rounds, artifacts, the PE's verdicts and probes
 * (passes 3 and 4), and PE review of new work in the factory (pass 5). They are in the table so the service applies
 * them like any command, but a client never sends them: the HTTP endpoint refuses them, as it refuses
 * `stageVisionDoc`.
 */
export const SERVICE_COMMANDS: ReadonlySet<string> = new Set(["openRound", "closeRound", "addStudioArtifact", "addPeVerdicts", "addProbe", "setProbeStatus", "recordPeReview", "startStudioRun"]);

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

  // shaping the vision with the lead first (Vision), and the factory
  /**
   * Start the factory: the owner's agreement, and the only way from shaping to building. `agreed` must be true;
   * `blueprintRev` and `visionRev` are the revisions the owner saw (compare-and-set); `acceptOpen` names the open
   * items they confirm.
   * Needs a vision; applies the settings and records the start; releases the roadmap on Autopilot.
   */
  startFactory: same((s, now, a) => {
    if (a.agreed !== true) throw new InvalidCommandError("agreed must be true: the factory starts only on your agreement");
    return M.startFactory(s, { agreed: true, blueprintRev: num(a, "blueprintRev"), visionRev: num(a, "visionRev"), settings: factorySettings(a.settings), acceptOpen: strings(a.acceptOpen, "acceptOpen") }, now);
  }),
  /** Back to vision: nothing running is stopped; nothing new starts. */
  startVision: same((s, now) => M.startVision(s, now)),
  /** The device scope: at least one of desktop, mobile and terminal. Chosen in Vision. */
  setDevices: same((s, now, a) =>
    M.setDevices(
      s,
      strings(a.devices, "devices").map((d) => {
        if (!DEVICES.includes(d as Device)) throw new InvalidCommandError(`unknown device ${d}: choose desktop, mobile or terminal`);
        return d as Device;
      }),
      now,
    ),
  ),
  /** The product's domains: at least one of screen, code and infrastructure. The owner's only; the lead proposes them as a question. */
  setDomains: same((s, now, a) =>
    setDomains(
      s,
      strings(a.domains, "domains").map((d) => {
        if (!PROJECT_DOMAINS.includes(d as ProjectDomain)) throw new InvalidCommandError(`unknown domain ${d}: choose screen, code or infrastructure`);
        return d as ProjectDomain;
      }),
      now,
    ),
  ),
  /** Accept the lead's draft as drafted or with edits: a user-authored revision, compare-and-set on the vision. */
  acceptVisionDraft: same((s, now, a) =>
    M.acceptVisionDraft(s, str(a, "draftId"), num(a, "expectedRev"), { text: a.text === undefined ? undefined : str(a, "text"), focus: a.focus === undefined ? undefined : str(a, "focus") }, now),
  ),
  dismissVisionDraft: same((s, now, a) => M.dismissVisionDraft(s, str(a, "draftId"), now)),
  /** Who acts first on a change order from now on: the lead, or you. */
  setChangeOrders: same((s, now, a) => M.setChangeOrders(s, oneOf(a, "who", ["lead", "user"] as const), now)),

  // the studio and the blueprint: the owner's
  /** Your answer to a round: one entry per artifact version (mark, pick, pins, note), sent together. */
  sendFeedback: same((s, now, a) => S.sendFeedback(s, array<unknown>(a.entries, "entries").map(feedbackEntry), now)),
  /** Overrule one of the PE's objections, with your reason (recorded). */
  overruleObjection: same((s, now, a) => S.overruleObjection(s, str(a, "verdictId"), str(a, "why"), now)),
  /** Approve one artifact version (the one you saw) into the blueprint, with a variant when it has several. Never the lead's. */
  approveArtifact: same((s, now, a) => B.approveArtifact(s, { artifactId: str(a, "artifactId"), version: int(a, "version"), ...(a.variant === undefined ? {} : { variant: str(a, "variant") }) }, now)),
  /** Approve a whole round into the blueprint; what cannot be approved as it stands is listed as open. Never the lead's. */
  approveRound: same((s, now, a) => B.approveRound(s, int(a, "round"), now)),

  // the studio: the service's (SERVICE_COMMANDS), from the lead's, the designer's, the PE's and the probes' runs
  /** Returns { n }. */
  openRound: (s, now, a) => {
    const r = S.openRound(s, { focus: oneOf(a, "focus", ROUND_FOCUSES), summary: optStr(a, "summary"), leadRunId: optStr(a, "leadRunId") }, now);
    return { state: r.state, result: { n: r.n } };
  },
  closeRound: same((s, now, a) => S.closeRound(s, int(a, "round"), optStr(a, "summary"), now)),
  /** A new artifact, or with `artifactId` a new version of one. Returns { artifactId, version }. */
  addStudioArtifact: (s, now, a) => {
    const r = S.addArtifact(
      s,
      {
        ...(a.artifactId === undefined ? {} : { artifactId: str(a, "artifactId") }),
        round: int(a, "round"),
        kind: oneOf(a, "kind", STUDIO_ARTIFACT_KINDS),
        title: str(a, "title"),
        variants: array<unknown>(a.variants, "variants").map((x) => {
          const v = obj(x, "variant");
          return { id: str(v, "id"), label: str(v, "label"), ...(v.entry === undefined ? {} : { entry: str(v, "entry") }) };
        }),
        files: array<unknown>(a.files, "files").map((x) => {
          const f = obj(x, "file");
          return { path: str(f, "path"), sha256: str(f, "sha256") };
        }),
        devices: strings(a.devices, "devices").map((d) => {
          if (!DEVICES.includes(d as Device)) throw new InvalidCommandError(`unknown device ${d}`);
          return d as Device;
        }),
        madeBy: studioMaker(a.madeBy),
        ...(a.supersedes === undefined ? {} : { supersedes: str(a, "supersedes") }),
        ...(a.provenance === undefined ? {} : { provenance: { files: strings(obj(a.provenance, "provenance").files, "provenance.files") } }),
        ...(a.dictionary === undefined ? {} : { dictionary: checked(parseDictionary(a.dictionary), "dictionary") }),
        ...(a.rules === undefined ? {} : { rules: array<unknown>(a.rules, "rules").map(variantRules) }),
      },
      now,
    );
    return { state: r.state, result: { artifactId: r.artifactId, version: r.version } };
  },
  /** One PE pass on an artifact's newest version. Returns { pass }. */
  addPeVerdicts: (s, now, a) => {
    const r = S.addPeVerdicts(s, { artifactId: str(a, "artifactId"), version: int(a, "version"), verdicts: array<unknown>(a.verdicts, "verdicts").map(verdictInput) }, now);
    return { state: r.state, result: { pass: r.pass } };
  },
  /** Returns { probeId }. */
  addProbe: (s, now, a) => {
    const r = S.addProbe(s, str(a, "question"), now);
    return { state: r.state, result: { probeId: r.probeId } };
  },
  setProbeStatus: same((s, now, a) =>
    S.setProbeStatus(s, str(a, "probeId"), { status: oneOf(a, "status", ["running", "done", "failed"] as const), attemptId: optStr(a, "attemptId"), result: optStr(a, "result"), failure: optStr(a, "failure") }, now),
  ),
  /** Ask for a studio run in a round, with its brief: queued, and dispatched in Vision only (a designer's, until pass 4). Returns { runId }. */
  startStudioRun: (s, now, a) => {
    const r = R.requestStudioRun(
      s,
      {
        kind: oneOf(a, "kind", STUDIO_RUN_KINDS),
        round: int(a, "round"),
        ...(a.artifactId === undefined ? {} : { artifactId: str(a, "artifactId") }),
        ...(a.selection === undefined ? {} : { selection: selection(a.selection) }),
        brief: str(a, "brief"),
      },
      now,
    );
    return { state: r.state, result: { runId: r.runId } };
  },

  // PE review of new work in the factory (ORC-029 2e, pass 5)
  /**
   * The service's (SERVICE_COMMANDS), from the PE's review run: one verdict (pass 4e's shape) on pending work, with what
   * the PE read: a proposal's spec revision (`specRev`), or a step's output version (`version`).
   */
  recordPeReview: same((s, now, a) => {
    const { variant: _variant, ...v } = verdictInput(a);
    return P.recordPeReview(s, { ...v, target: peReviewTarget(a), ...(a.specRev === undefined ? {} : { specRev: int(a, "specRev") }), ...(a.version === undefined ? {} : { version: int(a, "version") }) }, now);
  }),
  /** The owner's: PE review of new work on or off. Off releases the work the PE is still reviewing; an objection already with you stays. */
  setPeReviewsNewWork: same((s, now, a) => P.setPeReviewsNewWork(s, bool(a, "on"), now)),
  /** The owner's: overrule the PE's objection after three rounds, with your reason (recorded). */
  overrulePeReview: same((s, now, a) => P.overrulePeReview(s, peReviewTarget(a), str(a, "why"), now)),

  // vision documents
  /** Record one uploaded file without a revision (sent by POST /api/vision-docs, never by the UI directly). Returns { docId, status, replaces? }. */
  stageVisionDoc: (s, now, a) => {
    const r = M.stageVisionDoc(s, { path: str(a, "path"), size: num(a, "size"), hash: str(a, "hash"), text: bool(a, "text") }, now);
    return { state: r.state, result: r.result };
  },
  /** Attach a batch of staged documents as one vision revision. Returns { revision?, docs }. */
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

  // flows: the structure of a pipeline is never sent by a client
  /** The flow used when a lead proposal or a breakdown item names none. */
  setDefaultFlow: same((s, now, a) => M.setDefaultFlow(s, str(a, "flowId"), now)),
  /** Run a task on another flow, before it starts or while it shows Paused: the pipeline starts over. `expectedRev` is the pipeline revision seen. */
  changeFlow: same((s, now, a) => M.changeFlow(s, str(a, "taskId"), num(a, "expectedRev"), str(a, "flowId"), a.note === undefined ? "" : str(a, "note"), now)),

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
  setProviderLimit: same((s, now, a) => M.setProviderLimit(s, provider(a.provider), num(a, "limit"), now)),

  // findings and decisions
  /** Your decision on one finding: fix, accept (leave it as it is), follow-up (a new held task of yours), or reopen. */
  decideFinding: same((s, now, a) => {
    const decision = str(a, "decision");
    if (!F.DECISION_OPTIONS.includes(decision as F.UserDecision)) throw new InvalidCommandError("decision must be fix, accept, follow-up, or reopen");
    return F.decideFinding(s, str(a, "decisionId"), decision as F.UserDecision, a.note === undefined ? undefined : str(a, "note"), now);
  }),
  /** Who decides ask-user findings from now on: the lead, the PE or you. Open decisions stay where they are. */
  setTriageRouting: same((s, now, a) => {
    const to = str(a, "askUserBy");
    if (to !== "lead" && to !== "pe" && to !== "user") throw new InvalidCommandError("askUserBy must be lead, pe or user");
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

  // the project's checks, run by the service: the only way the check commands change
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

  // steering by conversation; every one is compare-and-set and reports what it left alone
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

  // notes to a running stage
  /** Your direct note to a running agent step (any role but checks). Returns { noteId }. */
  sendNote: (s, now, a) => {
    const r = M.sendNote(s, str(a, "taskId"), str(a, "stepId"), str(a, "text"), now);
    return { state: r.state, result: { noteId: r.noteId } };
  },
  /** The suggested rerun: rerun the finished step with the note in the new run's instructions (the existing rerun rules apply). */
  rerunWithNote: same((s, now, a) => M.rerunWithNote(s, str(a, "taskId"), str(a, "stepId"), str(a, "noteId"), now)),
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

  // delivery and the review-later queue
  /** Off, local branch, or GitHub pull requests: never two at once. */
  setDeliveryMode: same((s, now, a) => {
    const mode = str(a, "mode");
    if (mode !== "off" && mode !== "local" && mode !== "pr") throw new InvalidCommandError("mode must be off, local, or pr");
    return D.setDeliveryMode(s, { mode, branch: a.branch === undefined ? undefined : str(a, "branch") }, now);
  }),
  resetDeliveryBaseline: same((s, now) => M.resetDeliveryBaseline(s, now)),
  /** Pull-request settings: the remote and base, who merges (you, or automatically), limits and protected paths. */
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
    // how GitHub's checks are judged: re-runs of cancelled jobs, review bots, a repository without CI
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

  // the owner's budgets
  /** Both budgets in dollars, each a positive number or null (not set). */
  setBudgets: same((s, now, a) => M.setBudgets(s, { buildingUsd: numOrNull(a, "buildingUsd"), maintenanceUsdPerMonth: numOrNull(a, "maintenanceUsdPerMonth") }, now)),
  /** At the building budget: new work starts again without raising it, until the budget changes or the project goes back to vision. */
  continuePastBudget: same((s, now) => M.continuePastBudget(s, now)),
  /** A new project, shaping its vision (which may be empty) until you start the factory. */
  initProject: same((s, now, a) => M.initProject(s, { name: str(a, "name"), repoPath: str(a, "repoPath"), vision: str(a, "vision"), focus: str(a, "focus") }, now)),
  /** Create a user-authored task from one of the six flows (`flowId`). Any `steps` sent are ignored. Returns { newId }. */
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
        flowId: str(a, "flowId"),
        priorityPinned: a.priorityPinned === undefined ? false : bool(a, "priorityPinned"),
      },
      now,
    );
    return { state: r.state, result: { newId: r.newId } };
  },

  // fake runtime only: replace everything with the sample project ("Weekend Trips (sample)")
  resetSampleData: (s, now) => {
    const next = buildDemo(Date.parse(now));
    // Never reuse generated ids: a runtime process or event row from before the reset must not
    // be confused with a new run or event that happens to receive the same id.
    next.seq = Math.max(next.seq, s.seq) + 1;
    // The flows are machine-level, like the files they come from: a reset keeps them.
    next.flows = structuredClone(s.flows);
    return { state: next };
  },
} satisfies Record<string, Handler>;

export type CommandName = keyof typeof COMMANDS;

function isCommandName(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name);
}

/** Apply a named command. Throws InvalidCommandError, ControlError, or StaleWriteError. */
export function runCommand(state: State, name: string, args: unknown, now: string): Outcome {
  if (!isCommandName(name)) throw new InvalidCommandError(`Unknown command ${name}`);
  const handler: Handler = COMMANDS[name];
  return handler(state, now, args === undefined ? {} : obj(args));
}

export { ControlError };
