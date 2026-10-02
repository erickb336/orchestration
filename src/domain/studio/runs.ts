// Studio runs (ORC-029 pass 3a): the agent runs of Vision, a designer's for now (the PE's and probes' come in pass 4).
// Pure: each operation returns a new State; the service's scheduler dispatches, launches and reports them.
//
// They follow lead runs. A run is asked for (queued) by the service, and the scheduler dispatches it only while the
// project is in Vision, not paused, and below the building budget; product task steps never start in Vision. Pausing
// the project asks every running studio run to stop; a stop counts only once the runtime confirms it, and a stop
// left unconfirmed becomes a visible control failure. A run that pausing stopped is asked for again, so the work
// resumes with the project. A result counts only from a run still running or stopping, and only while it is not
// stale: its round still open, and the artifact it revises not revised by anyone else meanwhile.

import { busyAgents, currentVision, draft, event, nextId } from "../model/core";
import { providerLabel } from "../model/resolution";
import { CONTROL_RE, stripInvisible, visibleOrEmpty } from "../model/textSafety";
import { budgetStop } from "../spend";
import { ControlError, roleDefaultFor, type ModelSelection, type ProviderId, type State } from "../types";
import { latestVersion } from "./studio";
import type { StudioRun, StudioRunKind } from "./types";

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

const KIND_WORDS: Record<StudioRunKind, string> = { designer: "Designer", pe: "PE", probe: "Probe" };
/** "Designer run studio-12" */
export const studioRunName = (r: StudioRun) => `${KIND_WORDS[r.kind]} run ${r.id}`;

/**
 * Why a run's result (or its start) no longer fits the studio, or undefined: its round was closed, or the artifact it
 * revises has a newer version than the one it was asked to revise.
 */
export function staleReason(s: State, r: StudioRun): string | undefined {
  const round = s.studio.rounds.find((x) => x.n === r.round);
  if (!round || round.closedAt) return `round ${r.round} was closed`;
  if (r.artifactId !== undefined) {
    const latest = latestVersion(s, r.artifactId);
    if (!latest || latest.version !== r.baseVersion) return `${latest?.title ?? r.artifactId} has a newer version (v${latest?.version}) than the one it revises (v${r.baseVersion})`;
  }
  return undefined;
}

// ---------- asking for a run ----------

export interface StudioRunRequest {
  kind: StudioRunKind;
  round: number;
  /** A new version of this artifact (a designer's revision). */
  artifactId?: string;
  /** The provider and model; absent: the designer's role default, else the project's default. */
  selection?: ModelSelection;
  brief: string;
}

/** The selection resolved against the enabled providers and the catalog: "auto" is the catalog's first model. */
function resolveSelection(s: State, kind: StudioRunKind, given: ModelSelection | undefined): { provider: ProviderId; model: string } {
  const p = s.project;
  const sel = given ?? (kind === "designer" ? roleDefaultFor(p, "designer") : undefined) ?? p.defaultSelection;
  if (!p.enabledProviders.includes(sel.provider)) throw new ControlError(`${providerLabel(sel.provider)} is not enabled. Enable it in Settings or choose another provider for the designer.`);
  const catalog = p.catalog[sel.provider];
  if (sel.model === "auto") {
    if (!catalog.length) throw new ControlError(`No models available for ${providerLabel(sel.provider)}.`);
    return { provider: sel.provider, model: catalog[0].id };
  }
  if (!catalog.some((m) => m.id === sel.model)) throw new ControlError(`Model ${sel.model} is not in the ${providerLabel(sel.provider)} catalog.`);
  return { provider: sel.provider, model: sel.model };
}

/**
 * Ask for a studio run (the service, for the lead: pass 4). Queued: the scheduler dispatches it in Vision. Only a
 * designer's for now; the PE's and probes' runs come in pass 4. Its provider and model are resolved now and recorded.
 */
export function requestStudioRun(state: State, req: StudioRunRequest, now: string): { state: State; runId: string } {
  if (req.kind !== "designer") throw new ControlError("Only designer runs can be asked for yet; the PE's and probes' runs come in ORC-029 pass 4.");
  if (state.project.stage !== "shaping") throw new ControlError("Studio runs happen in Vision. Go back to vision first.");
  const round = state.studio.rounds.find((r) => r.n === req.round);
  if (!round) throw new ControlError(`There is no round ${req.round}.`);
  if (round.closedAt) throw new ControlError(`Round ${req.round} is closed.`);
  if (round.n === 0) throw new ControlError("Round 0 holds what the owner brought; the designer works in the lead's rounds.");
  const base = req.artifactId === undefined ? undefined : latestVersion(state, req.artifactId);
  if (req.artifactId !== undefined && !base) throw new ControlError(`Unknown studio artifact ${req.artifactId}.`);
  const brief = visibleOrEmpty(stripInvisible(req.brief.replace(CONTROL_G, "")).replace(/\r\n?/g, "\n").trim());
  if (!brief) throw new ControlError("The brief is empty.");
  if (brief.length > MAX_BRIEF) throw new ControlError(`The brief is over ${MAX_BRIEF} characters.`);
  const { provider, model } = resolveSelection(state, req.kind, req.selection);
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
    askedAt: now,
    workspace: `staging/${id}`,
  };
  s.studio.runs.push(run);
  event(s, now, "lead", "vision", `${studioRunName(run)} asked for in round ${round.n}${base ? `, revising ${base.title} v${base.version}` : ""}, on ${providerLabel(provider)} · ${model}`);
  return { state: s, runId: id };
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
  const vision = currentVision(s).text.trim();
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
 * Start queued studio runs, oldest first: only in Vision, never while the project is paused or at the building budget
 * (they wait, queued). A run whose round closed, or whose artifact was revised, before it started is refused; one
 * whose provider is unavailable fails with the reason (nothing is substituted). Studio runs share the worker limits
 * with task runs. Returns the runs started, which the scheduler launches.
 */
export function dispatchStudioRuns(state: State, now: string, opts: StudioDispatchOptions = {}): { state: State; started: string[] } {
  if (state.project.hold || state.project.stage !== "shaping" || !state.studio.runs.some((r) => r.status === "queued")) return { state, started: [] };
  if (budgetStop(state)) return { state, started: [] };
  const s = draft(state);
  const started: string[] = [];
  for (const r of s.studio.runs) {
    if (r.status !== "queued") continue;
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
    started.push(r.id);
    event(s, now, "lead", "dispatch", `${studioRunName(r)} started for round ${r.round} on ${providerLabel(r.provider)} · ${r.model}${r.simulated ? " (simulated)" : ""}`);
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
      round: r.round,
      ...(r.artifactId !== undefined ? { artifactId: r.artifactId, baseVersion: r.baseVersion } : {}),
      provider: r.provider,
      model: r.model,
      status: "queued",
      brief: r.brief,
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
