// The two places in the header (ORC-029 pass 5, screen 1): Vision and the Factory last for the project's life, side
// by side, and each says where it stands. These are the facts; the header words them ("Vision · draft, 3 changes",
// "Factory running · 4 agents"). Pure, from the state only.

import { activeAgentAttempts, activeAttempts } from "./model/core";
import { activeLeadRun } from "./model/lead";
import { budgetStop } from "./spend";
import { blueprintRev, currentBlueprint, draftChanges } from "./studio/blueprint";
import type { State } from "./types";

/**
 * Where Vision stands:
 * - draft: the owner's draft differs from the version in force (`changes`: added, changed and dropped items) or holds
 *   open items (`openItems`), or both;
 * - locked-in: no draft, and a version is in force: its revision and when it came into force;
 * - no-draft: no draft, and nothing in force yet (a new project before its first approval).
 */
export type VisionPlace = { state: "draft"; changes: number; openItems: number } | { state: "locked-in"; rev: number; at: string } | { state: "no-draft" };

/**
 * Where the Factory stands:
 * - not-started: the project is in Vision, before Start the factory;
 * - pausing, then paused: the owner paused the project (see `projectPause`);
 * - budget-stop: nothing new starts at the building budget (`why`, in one line), until the owner raises it or
 *   continues past it;
 * - running: it builds, with `agents` task runs on a provider under way (the studio's runs are Vision's work).
 * A pause is named before the budget stop: the owner's own pause is what holds the factory then.
 */
export type FactoryPlace = { state: "not-started" } | ProjectPause | { state: "budget-stop"; why: string } | { state: "running"; agents: number };

/**
 * The owner's pause of the project: pausing while a run it asked to stop has not confirmed the stop (`stopping`: task
 * and check runs, the lead's run and the studio's runs), then paused. Undefined while the project is not paused. The
 * header's pill and the Factory place both read it, so neither says paused before the runs stopped.
 */
export type ProjectPause = { state: "pausing"; stopping: number } | { state: "paused" };

export function projectPause(s: State): ProjectPause | undefined {
  if (!s.project.hold) return undefined;
  const stopping = activeAttempts(s).filter((a) => a.outcome === "stopping").length + (activeLeadRun(s)?.outcome === "stopping" ? 1 : 0) + s.studio.runs.filter((r) => r.status === "stopping").length;
  return stopping ? { state: "pausing", stopping } : { state: "paused" };
}

export function visionPlace(s: State): VisionPlace {
  const c = draftChanges(s);
  // A vision text waiting in the draft (an edit after the start, pass 5) is one change.
  const changes = c.added.length + c.changed.length + c.dropped.length + (c.vision ? 1 : 0);
  if (changes || c.open.length) return { state: "draft", changes, openItems: c.open.length };
  const inForce = currentBlueprint(s);
  return inForce ? { state: "locked-in", rev: blueprintRev(s), at: inForce.at } : { state: "no-draft" };
}

export function factoryPlace(s: State): FactoryPlace {
  if (s.project.stage === "shaping") return { state: "not-started" };
  const pause = projectPause(s);
  if (pause) return pause;
  const stop = budgetStop(s);
  if (stop) return { state: "budget-stop", why: stop.why };
  return { state: "running", agents: activeAgentAttempts(s).length };
}
