// The project vision's revisions, the steering mode, and the last-visit mark.

import { type SteeringMode, type VisionRevision, type State, ControlError, StaleWriteError } from "../types";
import { currentVision, draft, event } from "./core";

/**
 * Append a vision revision. The user's edits and the lead's focus changes (ORC-009) both go through here.
 * ORC-014: the document set carries forward unless the revision changes it, so every revision records
 * exactly which documents applied.
 */
export function pushVision(s: State, v: Pick<VisionRevision, "author" | "text" | "focus" | "reason" | "source" | "docIds" | "simulated">, now: string, message?: string): VisionRevision {
  const prev = currentVision(s);
  const docIds = v.docIds ?? prev.docIds;
  // ORC-017: the simulated flag is structured provenance, set only from the lead run's runtime.
  const rev: VisionRevision = { rev: prev.rev + 1, at: now, author: v.author, text: v.text, focus: v.focus, reason: v.reason, ...(v.source ? { source: v.source } : {}), ...(docIds ? { docIds: [...docIds] } : {}), ...(v.simulated ? { simulated: true as const } : {}) };
  s.project.visions.push(rev);
  event(s, now, v.author, "vision", message ?? `Vision r${rev.rev}: ${v.reason}`);
  return rev;
}

export function editVision(state: State, expectedRev: number, text: string, focus: string, reason: string, now: string): State {
  const s = draft(state);
  const v = currentVision(s);
  if (v.rev !== expectedRev) throw new StaleWriteError(expectedRev, v.rev);
  // ORC-012 review 6: a project never builds without a vision. Clearing it is possible while shaping.
  if (s.project.stage === "building" && !text.trim()) throw new ControlError("The vision cannot be empty while building. Go back to shaping to clear it.");
  pushVision(s, { author: "user", text, focus, reason }, now);
  return s;
}

/** ORC-009: how far the lead may go when the user gives direction. Its own setting, never part of Autonomy. */
export function setSteeringMode(state: State, mode: SteeringMode, now: string): State {
  if (mode !== "apply" && mode !== "apply-own" && mode !== "suggest") throw new ControlError("Unknown steering mode.");
  const s = draft(state);
  s.project.steeringMode = mode;
  event(s, now, "user", "config", `Steering by conversation: ${steeringModeLabel(mode)}`);
  return s;
}

function steeringModeLabel(mode: SteeringMode): string {
  return mode === "apply" ? "the lead applies changes; undo any of them" : mode === "apply-own" ? "the lead applies changes to its own proposals and suggests changes to your tasks" : "the lead only suggests changes";
}

export function markVisited(state: State, now: string): State {
  const s = draft(state);
  s.project.lastVisitAt = now;
  return s;
}
