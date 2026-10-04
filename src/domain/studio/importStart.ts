// The start of an import (ORC-032): everything the Start screen sets, as one owner command. Pure.
//
// `startImportProject` builds the new project (its name and repository, the kind of product, the devices, how it runs)
// and starts the import on it (import.ts). Every part is checked before anything changes: on a refusal, the old
// project stays as it was. While the sample's simulated runs are active, the start pauses the sample and waits
// (`project.importPending`); the service starts the import once no run is active (`startPendingImport`), and
// `importStartStatus` says where the start stands (QA-F2).

import * as C from "../checks";
import { setEnvironment } from "../environment";
import * as M from "../model";
import { draft, event } from "../model/core";
import { STOP_RUNS_FIRST } from "../model/project";
import { activeStudioRuns } from "./runs";
import { ControlError, DEFAULT_CHECKS, type State } from "../types";
import { setDomains } from "./domains";
import { setPreview } from "./evidence";
import { startImport } from "./import";
import type { ImportProjectStart } from "./types";

/** The new project, with the import started on it; throws on any refusal. Whatever runs in the old project. */
function importProject(state: State, input: ImportProjectStart, now: string): State {
  let s = M.newProject(state, { name: input.name, repoPath: input.repoPath, vision: "", focus: "" }, now);
  s = setDomains(s, input.domains, now);
  s = M.setDevices(s, input.devices, now);
  if (input.environment) s = setEnvironment(s, input.environment, now);
  if (input.preview) s = setPreview(s, input.preview, now);
  if (input.tests) {
    const { rev: _rev, ...checks } = DEFAULT_CHECKS;
    const command = { id: "tests", label: "Tests", kind: "check" as const, argv: [...input.tests.argv] };
    s = C.setChecks(s, { ...checks, enabled: true, commands: [command], ...(input.tests.report ? { testReport: input.tests.report } : {}) }, false, now);
  }
  const { commit, branch, budgetUsd, helpers, size, readsOn } = input;
  return startImport(s, { commit, ...(branch !== undefined ? { branch } : {}), budgetUsd, helpers, size, ...(readsOn ? { readsOn } : {}) }, now);
}

/**
 * The owner starts an import: a new project from what the Start screen set, checked in full before anything changes.
 * With no run active, the import starts at once. While the sample's runs are active, the sample pauses and the start
 * waits for them to stop. Another project's active runs refuse it: they are real work.
 */
export function startImportProject(state: State, input: ImportProjectStart, now: string): State {
  const started = importProject(state, input, now);
  if (!M.hasActiveRuns(state)) return started;
  if (!state.project.sample) throw new ControlError(STOP_RUNS_FIRST);
  if (state.project.importPending && !state.project.importPending.refused) throw new ControlError("An import is starting already: it waits for the sample's agents to stop.");
  const s = draft(M.pauseProject(state, now));
  s.project.importPending = { at: now, input: structuredClone(input) };
  event(s, now, "user", "vision", `The import of "${input.name}" waits for the sample's agents to stop`);
  return s;
}

/**
 * The service starts an import that waited for the sample's runs: once none is active. A refusal now (something
 * changed meanwhile) is recorded on the waiting start, and the sample stays, paused. Otherwise nothing changes.
 */
export function startPendingImport(state: State, now: string): State {
  const p = state.project.importPending;
  if (!p || p.refused || M.hasActiveRuns(state)) return state;
  try {
    return importProject(state, p.input, now);
  } catch (e) {
    if (!(e instanceof ControlError)) throw e;
    const s = draft(state);
    s.project.importPending = { ...p, refused: e.message };
    event(s, now, "system", "vision", `The import of "${p.input.name}" did not start: ${e.message}`);
    return s;
  }
}

/** Where a waiting import's start stands, for the Start screen: pausing the sample's agents (how many still run), or refused (why). */
export type ImportStartStatus = { status: "pausing"; runs: number } | { status: "refused"; reason: string };

export function importStartStatus(s: State): ImportStartStatus | undefined {
  const p = s.project.importPending;
  if (!p) return undefined;
  if (p.refused) return { status: "refused", reason: p.refused };
  return { status: "pausing", runs: M.activeAttempts(s).length + (M.activeLeadRun(s) ? 1 : 0) + activeStudioRuns(s).length };
}
