// Studio runs (ORC-029 pass 3): the agent runs of Vision, the designer's and the PE's (probes' come in pass 4).
// Pure: each operation returns a new State; the service's scheduler dispatches, launches and reports them.
//
// The import's runs (ORC-032) work in round 0 and name their step (`importStep`): the rules reader (a research run,
// read-only, with the helpers the owner allowed on the import), and designers for the words, the parts and a fix. They
// run on the provider the owner chose to read the repository, Claude by default, and wait at the import budget.
//
// One kind runs in the factory instead (pass 5): a PE run on new work (`review`), which has no round. It is asked
// for by askForNewWorkReviews (src/domain/peReview.ts) and dispatched only while building; everything below about
// Vision applies to the other runs.
//
// The PE's runs. The owner sees a designer's work only after PE review (the loop rule, studio.ts), so once a version
// is imported, and its screenshots or recording are made, the service asks for a PE run on it (askForPeReviews). The
// PE reads the version and returns a verdict per variant, which the service records with addPeVerdicts. By default
// the PE runs on the other provider than the designer's, so the check is independent; the project's `pe` role
// default overrides that.
//
// They follow lead runs. A run is asked for (queued) by the service, and the scheduler dispatches it only while the
// project is in Vision, not paused, and below the building budget; product task steps never start in Vision. Pausing
// the project asks every running studio run to stop; a stop counts only once the runtime confirms it, and a stop
// left unconfirmed becomes a visible control failure. A run that pausing stopped is asked for again, so the work
// resumes with the project. A result counts only from a run still running or stopping, and only while it is not
// stale: its round still open, and the artifact it revises not revised by anyone else meanwhile.

import { busyAgents, draft, event, nextId } from "../model/core";
import { draftVisionText } from "../model/vision";
import { providerLabel } from "../model/resolution";
import { CONTROL_RE, stripInvisible, visibleOrEmpty } from "../model/textSafety";
import { budgetStop, importStop } from "../spend";
import { allowSubagentsForStudioRun } from "../subagents";
import { ControlError, PROVIDERS, roleDefaultFor, type ModelSelection, type ProviderId, type State } from "../types";
import { artifactName, endReview, latestArtifacts, latestVersion, peReview, peRunsOf } from "./studio";
import { newWorkStaleReason } from "../peReview";
import { isUnderWay, type ImportStep, type NewWorkReviewRef, type StudioArtifact, type StudioRun, type StudioRunKind } from "./types";

/** The longest brief a run takes, in characters. */
const MAX_BRIEF = 20_000;

const CONTROL_G = new RegExp(CONTROL_RE.source, "g");

// ---------- lookups ----------

export function getStudioRun(s: State, id: string): StudioRun | undefined {
  return s.studio.runs.find((r) => r.id === id);
}

/** Runs with a live process: running, or stopping until the runtime confirms the stop. */
export function activeStudioRuns(s: State): StudioRun[] {
  return s.studio.runs.filter((r) => r.status === "running" || r.status === "stopping");
}

export const isActiveStudioRun = (r: StudioRun) => r.status === "running" || r.status === "stopping";

const KIND_WORDS: Record<StudioRunKind, string> = { designer: "Designer", pe: "PE", probe: "Probe", reader: "Reader" };
/** "Designer run studio-12" */
export const studioRunName = (r: StudioRun) => `${KIND_WORDS[r.kind]} run ${r.id}`;

/**
 * Why a run's result (or its start) no longer fits the studio, or undefined: its round was closed, or the artifact it
 * revises has a newer version than the one it was asked to revise.
 */
export function staleReason(s: State, r: StudioRun): string | undefined {
  // A PE run on new work in the factory: the work it reads must still wait for it, as it was.
  if (r.review) return newWorkStaleReason(s, r.review);
  if (r.importStep && s.studio.import?.stopped) return "the import stopped";
  const round = s.studio.rounds.find((x) => x.n === r.round);
  if (!round || round.closedAt) return `round ${r.round} was closed`;
  if (r.artifactId !== undefined) {
    const latest = latestVersion(s, r.artifactId);
    if (!latest || latest.version !== r.baseVersion) return `${latest?.title ?? r.artifactId} has a newer version (v${latest?.version}) than the one it ${r.kind === "pe" ? "reviews" : "revises"} (v${r.baseVersion})`;
  }
  return undefined;
}

// ---------- asking for a run ----------

export interface StudioRunRequest {
  kind: StudioRunKind;
  /** The Vision round; absent for a PE run on new work in the factory (`review`). */
  round?: number;
  /** A PE run on new work in the factory (pass 5): what it reviews. Only while building. */
  review?: NewWorkReviewRef;
  /** A designer's run: a new version of this artifact (a revision). The PE's: the artifact it reviews, at its newest version. */
  artifactId?: string;
  /** The provider and model; absent: the role's default (see peSelection for the PE), else the project's default. */
  selection?: ModelSelection;
  brief: string;
  /** A designer run the lead asked for in its studio block: recorded on the run (lead.ts). */
  fromLead?: StudioRun["fromLead"];
  /** A run of the import (ORC-032): the rules are the reader's; the words, the parts and a fix are a designer's, in round 0. */
  importStep?: ImportStep;
}

/** The kind of run each step of the import takes. */
const IMPORT_STEP_KIND: Record<ImportStep, StudioRunKind> = { words: "designer", rules: "reader", parts: "designer", fix: "designer" };

/**
 * Why a run of the import cannot be asked for now, or undefined: the import must go on (a fix only before the baseline,
 * on a part of round 0), in round 0, and the step takes its own kind of run. A reader works only for the import.
 */
function importRunRefusal(s: State, req: StudioRunRequest): string | undefined {
  const step = req.importStep;
  if (step === undefined) return req.kind === "reader" ? "A reader run reads a repository for its import: it names the import's step" : undefined;
  const imp = s.studio.import;
  if (!imp) return "This project has no import";
  if (imp.stopped) return `The import stopped: ${imp.stopped.reason}`;
  if (imp.lockedInAt) return "The import is locked in: a change to a part goes through the draft";
  if (IMPORT_STEP_KIND[step] !== req.kind) return `The import's ${step} step is a ${IMPORT_STEP_KIND[step]}'s run, not a ${req.kind}'s`;
  if (req.round !== 0) return "The import works in round 0, As it is today";
  if ((step === "fix") !== (req.artifactId !== undefined)) return "A fix names the part it revises, and only a fix does";
  return undefined;
}

/**
 * Who reviews a version as the PE, and why: the project's `pe` role default when it has one; else the other
 * provider than the one that made it, so the check is independent; else, when that provider is not enabled, the
 * maker's own (the review is then not independent, and `note` says so).
 */
export function peSelection(s: State, a: StudioArtifact): { selection: ModelSelection; note?: string } {
  const p = s.project;
  const set = roleDefaultFor(p, "pe");
  if (set) return { selection: set };
  const maker = a.madeBy.role === "user" ? undefined : a.madeBy.provider;
  if (!maker) return { selection: p.defaultSelection };
  const other = PROVIDERS.find((x) => x !== maker)!;
  if (p.enabledProviders.includes(other)) return { selection: { provider: other, model: "auto" } };
  return { selection: { provider: maker, model: "auto" }, note: `on the designer's own provider: ${providerLabel(other)} is not enabled, so this review is not independent` };
}

/** The selection resolved against the enabled providers and the catalog: "auto" is the catalog's first model. */
function resolveSelection(s: State, kind: StudioRunKind, given: ModelSelection | undefined): { provider: ProviderId; model: string } {
  const p = s.project;
  const sel = given ?? (kind === "designer" ? roleDefaultFor(p, "designer") : undefined) ?? p.defaultSelection;
  if (!p.enabledProviders.includes(sel.provider)) throw new ControlError(`${providerLabel(sel.provider)} is not enabled. Enable it in Settings or choose another provider for the ${kind === "pe" ? "PE" : kind}.`);
  const catalog = p.catalog[sel.provider];
  if (sel.model === "auto") {
    if (!catalog.length) throw new ControlError(`No models available for ${providerLabel(sel.provider)}.`);
    return { provider: sel.provider, model: catalog[0].id };
  }
  if (!catalog.some((m) => m.id === sel.model)) throw new ControlError(`Model ${sel.model} is not in the ${providerLabel(sel.provider)} catalog.`);
  return { provider: sel.provider, model: sel.model };
}

/**
 * Ask for a studio run (the service: the designer's for the lead, pass 4; the PE's after an import). Queued: the
 * scheduler dispatches it, in Vision or while the factory runs (pass 5: a studio run works on the studio and the
 * draft, which the factory never reads). A PE run reviews an artifact's newest version, in that version's round.
 * Probes' runs come in pass 4. Its provider and model are resolved now and recorded.
 */
export function requestStudioRun(state: State, req: StudioRunRequest, now: string): { state: State; runId: string } {
  if (req.kind === "probe") throw new ControlError("Probe runs cannot be asked for yet; they come in ORC-029 pass 4.");
  if (req.review) return requestNewWorkRun(state, req, req.review, now);
  const refused = importRunRefusal(state, req);
  if (refused) throw new ControlError(`${refused}.`);
  const round = state.studio.rounds.find((r) => r.n === req.round);
  if (!round) throw new ControlError(`There is no round ${req.round}.`);
  if (round.closedAt) throw new ControlError(`Round ${req.round} is closed.`);
  // Round 0 is what already exists: the designer works there only to reproduce an existing repository "as is" (its
  // import refuses anything else there), and the PE reviews those reproductions like any other designer's work.
  const base = req.artifactId === undefined ? undefined : latestVersion(state, req.artifactId);
  if (req.artifactId !== undefined && !base) throw new ControlError(`Unknown studio artifact ${req.artifactId}.`);
  let note: string | undefined;
  if (req.kind === "pe") {
    if (!base) throw new ControlError("A PE run names the artifact it reviews.");
    const review = peReview(state, base);
    if (review.status === "not-reviewed") throw new ControlError(`The PE does not review ${base.title}: ${review.why}.`);
    if (base.round !== round.n) throw new ControlError(`${artifactName(base)} is from round ${base.round}; the PE reviews it in that round.`);
    if (!req.selection) note = peSelection(state, base).note;
  }
  const brief = cleanBrief(req.brief);
  // The import's runs read an untrusted repository: on the provider the owner chose for it (Claude by default, Q5).
  const readsOn = req.importStep && state.studio.import ? { provider: state.studio.import.readsOn, model: "auto" } : undefined;
  const { provider, model } = resolveSelection(state, req.kind, req.selection ?? (req.kind === "pe" ? peSelection(state, base!).selection : readsOn));
  const s = draft(state);
  const id = nextId(s, "studio");
  const run: StudioRun = {
    id,
    kind: req.kind,
    round: round.n,
    ...(base ? { artifactId: base.id, baseVersion: base.version } : {}),
    provider,
    model,
    status: "queued",
    brief,
    ...(req.kind === "designer" && req.fromLead ? { fromLead: structuredClone(req.fromLead) } : {}),
    askedAt: now,
    workspace: `staging/${id}`,
    ...(req.importStep ? { importStep: req.importStep } : {}),
  };
  s.studio.runs.push(run);
  const what = !base ? "" : req.kind === "pe" ? `, reviewing ${artifactName(base)}` : `, revising ${artifactName(base)}`;
  // Who asked: the lead, from its studio block (`fromLead`), or the service (the PE's runs, the loop's revisions; review finding 8).
  event(s, now, req.fromLead ? "lead" : "system", "vision", `${studioRunName(run)} asked for in round ${round.n}${what}, on ${providerLabel(provider)} · ${model}${note ? ` (${note})` : ""}`);
  return { state: s, runId: id };
}

function cleanBrief(raw: string): string {
  const brief = visibleOrEmpty(stripInvisible(raw.replace(CONTROL_G, "")).replace(/\r\n?/g, "\n").trim());
  if (!brief) throw new ControlError("The brief is empty.");
  if (brief.length > MAX_BRIEF) throw new ControlError(`The brief is over ${MAX_BRIEF} characters.`);
  return brief;
}

/**
 * A PE run on new work in the factory (pass 5, asked for by the service: askForNewWorkReviews in peReview.ts). Only
 * while building, on work that waits for it as it is now. Queued: dispatched while building, like task steps.
 */
function requestNewWorkRun(state: State, req: StudioRunRequest, review: NewWorkReviewRef, now: string): { state: State; runId: string } {
  if (req.kind !== "pe") throw new ControlError("Only the PE reviews new work in the factory.");
  if (state.project.stage !== "building") throw new ControlError("PE review of new work happens in the factory.");
  const stale = newWorkStaleReason(state, review);
  if (stale) throw new ControlError(`Nothing to review: ${stale}.`);
  const brief = cleanBrief(req.brief);
  const { provider, model } = resolveSelection(state, "pe", req.selection);
  const s = draft(state);
  const id = nextId(s, "studio");
  const run: StudioRun = { id, kind: "pe", review: { ...review }, provider, model, status: "queued", brief, askedAt: now, workspace: `staging/${id}` };
  s.studio.runs.push(run);
  event(s, now, "system", "decision", `${studioRunName(run)} asked for, reviewing ${reviewName(review)}, on ${providerLabel(provider)} · ${model}`, review.taskId);
  return { state: s, runId: id };
}

/** "T-005 (spec r2)", "T-007 S1 v2": the new work a PE run reviews. */
export const reviewName = (r: NewWorkReviewRef) => (r.stepId === undefined ? `${r.taskId} (spec r${r.specRev})` : `${r.taskId} ${r.stepId} v${r.version}`);

// ---------- the PE's runs, asked for by the service ----------

/**
 * Whether a version needs the PE now: it is the newest version, with its screenshots or recording done, its review
 * waiting (no pass yet, and not ended; never so for a kind the PE does not review), and no PE run on it under way. A
 * PE run that ended without a verdict is asked for again until review ends (`no-review`, studio.ts); a run a pause
 * stopped was asked for again in the same write (retryOf), and that run is among these. In Vision or while the
 * factory runs alike (pass 5).
 */
export function peRunDue(s: State, a: StudioArtifact): boolean {
  if (latestVersion(s, a.id)?.version !== a.version) return false;
  // The PE reads the screenshots and the recording: it waits until the service has made them.
  if (a.shots?.status === "pending" || a.demo?.status === "pending") return false;
  if (peReview(s, a).status !== "waiting") return false;
  return !peRunsOf(s, a.id, a.version).some(isUnderWay);
}

/** The PE's brief for a version: what the run record says it was asked to do (the envelope has the rest). */
export const peBrief = (a: StudioArtifact) =>
  a.provenance ? `PE review of ${artifactName(a)}, a reproduction of the code as it is today: is it faithful, a verdict for each variant.` : `PE review of ${artifactName(a)}: feasibility, scale, longevity and budget, a verdict for each variant.`;

/**
 * Ask for a PE run on every version that needs one (the service, on each cycle: after an import, and after the
 * screenshots or recording). When no enabled provider can run the PE, its review ends there (`no-provider`, with the
 * reason) and the version goes to the owner unreviewed, never left waiting.
 */
export function askForPeReviews(state: State, now: string): State {
  let s = state;
  for (const a of latestArtifacts(state)) {
    if (!peRunDue(s, a)) continue;
    try {
      s = requestStudioRun(s, { kind: "pe", round: a.round, artifactId: a.id, brief: peBrief(a) }, now).state;
    } catch (e) {
      if (!(e instanceof ControlError)) throw e;
      s = endReview(s, a.id, a.version, `the PE cannot run: ${e.message}`, now);
    }
  }
  return s;
}

/** The labelled stand-in for the lead's studio brief (pass 4): the vision and the round's focus, nothing else. */
export function placeholderBrief(s: State, round: number): string {
  const r = s.studio.rounds.find((x) => x.n === round);
  if (!r) throw new ControlError(`There is no round ${round}.`);
  const focus: Record<string, string> = {
    material: "what the owner brought",
    experience: "the experience: the screens and how they feel to use",
    data: "the inputs and outputs: the data crossing each boundary",
    flows: "the flows: the user's journeys, the system's sequence, and the states (empty, loading, error, offline, first run)",
  };
  // The studio works on the draft (pass 5): its vision text, which is the one in force until the owner edits it.
  const vision = draftVisionText(s).trim();
  return [
    "PLACEHOLDER BRIEF. The lead's studio brief comes in ORC-029 pass 4; this one is built from the vision and the round's focus only.",
    "",
    `Round ${r.n} is about ${focus[r.focus]}.${r.summary ? ` ${r.summary}` : ""}`,
    "Make two variants that differ in a real choice, each for every device in the project's scope.",
    "",
    "The vision:",
    vision ? (vision.length > 6000 ? `${vision.slice(0, 6000)}…` : vision) : "(no vision written yet)",
  ].join("\n");
}

// ---------- dispatch ----------

export interface StudioDispatchOptions {
  /** Providers that cannot run work right now, with an actionable reason (observed health). */
  unavailable?: Partial<Record<ProviderId, string>>;
  /** Providers whose status is not known yet: their runs wait. */
  deferred?: ProviderId[];
  /** Providers run by the fake runtime: their runs are recorded as simulated. */
  simulated?: ProviderId[];
}

function fail(s: State, r: StudioRun, note: string, now: string) {
  r.status = "failed";
  r.endedAt = now;
  r.note = note;
  event(s, now, "runtime", "blocked", `${studioRunName(r)} failed: ${note}`);
}

/**
 * Start queued studio runs, oldest first: in Vision and while the factory runs (pass 5: they work on the studio and
 * the draft), never while the project is paused or at the building budget (they wait, queued). A run whose round
 * closed, or whose artifact was revised, before it started is refused; one whose provider is unavailable fails with
 * the reason (nothing is substituted). Studio runs share the worker limits with task runs. Returns the runs started,
 * which the scheduler launches.
 */
/** A run starts only in its stage: the studio's in Vision, a PE run on new work in the factory. It waits, queued, in the other. */
/** A studio run works on the draft, in either stage (pass 5); a PE review of new work waits until the factory has started. */
const inItsStage = (s: State, r: StudioRun) => !r.review || s.project.stage === "building";

export function dispatchStudioRuns(state: State, now: string, opts: StudioDispatchOptions = {}): { state: State; started: string[] } {
  if (state.project.hold || !state.studio.runs.some((r) => r.status === "queued" && inItsStage(state, r))) return { state, started: [] };
  // At the building budget, or while an import goes on, at the import budget (ORC-032): nothing new starts.
  if (budgetStop(state) || importStop(state)) return { state, started: [] };
  const s = draft(state);
  const started: string[] = [];
  for (const r of s.studio.runs) {
    if (r.status !== "queued" || !inItsStage(s, r)) continue;
    const stale = staleReason(s, r);
    if (stale) {
      fail(s, r, `not started: ${stale}`, now);
      continue;
    }
    if (opts.deferred?.includes(r.provider)) continue;
    const down = opts.unavailable?.[r.provider];
    if (down) {
      fail(s, r, `${providerLabel(r.provider)} is not available: ${down}`, now);
      continue;
    }
    if (busyAgents(s) >= s.project.workerLimit) break;
    if (busyAgents(s, r.provider) >= (s.project.providerLimits?.[r.provider] ?? s.project.workerLimit)) continue;
    r.status = "running";
    r.startedAt = now;
    if (opts.simulated?.includes(r.provider)) r.simulated = true;
    // A probe is read-only research: it may start helpers where the owner allows them (ORC-031); no other studio run may.
    const allowSubagents = allowSubagentsForStudioRun(s, r);
    if (allowSubagents) r.allowSubagents = allowSubagents;
    started.push(r.id);
    event(s, now, "lead", "dispatch", `${studioRunName(r)} started ${r.review ? `reviewing ${reviewName(r.review)}` : `for round ${r.round}`} on ${providerLabel(r.provider)} · ${r.model}${r.simulated ? " (simulated)" : ""}`);
  }
  return { state: s, started };
}

// ---------- the runtime's reports ----------

function active(s: State, id: string): StudioRun | undefined {
  const r = getStudioRun(s, id);
  return r && isActiveStudioRun(r) ? r : undefined;
}

export function reportStudioRunStarted(state: State, id: string, info: { sessionId?: string; actualModel?: string }): State {
  if (!active(state, id)) return state;
  const s = draft(state);
  Object.assign(active(s, id)!, info.sessionId ? { sessionId: info.sessionId } : {}, info.actualModel ? { actualModel: info.actualModel } : {});
  return s;
}

export function reportStudioRunActivity(state: State, id: string, note: string): State {
  if (!active(state, id)) return state;
  const s = draft(state);
  active(s, id)!.activity = note.slice(0, 200);
  return s;
}

/** Ask a running studio run to stop (mutates a draft). With `requeue`, it is asked for again once the stop is confirmed. */
export function requestStudioStop(s: State, r: StudioRun, reason: string, now: string, requeue = false) {
  if (r.status !== "running") return;
  r.status = "stopping";
  r.stopRequestedAt = now;
  if (requeue) r.requeue = true;
  event(s, now, "system", "control", `Stop requested for ${studioRunName(r)} (${reason}); awaiting runtime acknowledgment`);
}

/**
 * The runtime confirmed the stop, or the run's process is gone. A stop that was asked for is "stopped"; a process gone
 * after a stop request too; one gone without a request is "lost" (`lost`), or "failed" when the runtime ended it on
 * its own (its time limit). The usage reported with the stop is recorded, so the budget counts it. A run pausing
 * stopped is asked for again, queued, with the same brief, provider and model.
 */
export function reportStudioRunStopped(state: State, id: string, now: string, opts: { lost?: boolean; usage?: StudioRun["usage"] } = {}): State {
  if (!active(state, id)) return state;
  const s = draft(state);
  const r = active(s, id)!;
  r.status = r.status === "stopping" ? "stopped" : opts.lost ? "lost" : "failed";
  r.endedAt = now;
  if (opts.usage) r.usage = opts.usage;
  if (r.status === "failed") r.note = "The runtime stopped it without a stop request (for example its time limit).";
  if (r.status === "lost") r.note = "Its runtime process is gone (the service restarted, or the process ended without a result).";
  event(s, now, "runtime", "runtime", `${studioRunName(r)} ${r.status}`);
  if (r.status === "stopped" && r.requeue) {
    const again: StudioRun = {
      id: nextId(s, "studio"),
      kind: r.kind,
      ...(r.round !== undefined ? { round: r.round } : {}),
      ...(r.review ? { review: { ...r.review } } : {}),
      ...(r.artifactId !== undefined ? { artifactId: r.artifactId, baseVersion: r.baseVersion } : {}),
      provider: r.provider,
      model: r.model,
      status: "queued",
      brief: r.brief,
      ...(r.fromLead ? { fromLead: structuredClone(r.fromLead) } : {}),
      ...(r.importStep ? { importStep: r.importStep } : {}),
      askedAt: now,
      workspace: "",
      retryOf: r.id,
    };
    again.workspace = `staging/${again.id}`;
    s.studio.runs.push(again);
    event(s, now, "system", "control", `${studioRunName(again)} asked for again (it repeats ${r.id}, which pausing stopped); it starts when the project resumes`);
  }
  return s;
}

export function reportStudioRunFailed(state: State, id: string, message: string, now: string, usage?: StudioRun["usage"]): State {
  if (!active(state, id)) return state;
  const s = draft(state);
  const r = active(s, id)!;
  const stopping = r.status === "stopping";
  if (usage) r.usage = usage;
  if (stopping) {
    // It ended while stopping: the stop is confirmed (and a paused run asked for again), with the reason kept.
    const next = reportStudioRunStopped(s, id, now);
    getStudioRun(next, id)!.note = message;
    return next;
  }
  fail(s, r, message, now);
  return s;
}

export function reportStudioStopTimeout(state: State, id: string, now: string): State {
  const r = getStudioRun(state, id);
  if (!r || r.status !== "stopping" || r.note?.startsWith("Control failure")) return state;
  const s = draft(state);
  const run = getStudioRun(s, id)!;
  run.note = "Control failure: the runtime has not acknowledged the stop request.";
  event(s, now, "system", "control", `Control failure: ${studioRunName(run)} did not acknowledge stop in time`);
  return s;
}

/**
 * The run finished and what it handed in was recorded (the service imports a designer's artifacts first, with
 * `addArtifact`, in the same transaction). Only a running or stopping run completes; anything else is a stale report.
 */
export function completeStudioRun(state: State, id: string, now: string, info: { usage?: StudioRun["usage"]; actualModel?: string; summary: string }): State {
  if (!active(state, id)) return state;
  const s = draft(state);
  const r = active(s, id)!;
  r.status = "completed";
  r.endedAt = now;
  if (info.usage) r.usage = info.usage;
  if (info.actualModel) r.actualModel = info.actualModel;
  delete r.requeue;
  event(s, now, "runtime", "vision", `${studioRunName(r)} completed: ${info.summary}`);
  return s;
}
