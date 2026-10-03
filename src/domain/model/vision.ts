// The project vision's revisions, the vision text in the blueprint's draft while building, the steering mode, and the
// last-visit mark.

import type { DraftVision } from "../studio/types";
import { type SteeringMode, type VisionRevision, type State, ControlError, StaleWriteError } from "../types";
import { currentVision, draft, event } from "./core";

/**
 * Append a vision revision. The user's edits and the lead's focus changes both go through here.
 * The document set carries forward unless the revision changes it, so every revision records
 * exactly which documents applied.
 */
export function pushVision(s: State, v: Pick<VisionRevision, "author" | "text" | "focus" | "reason" | "source" | "docIds" | "simulated">, now: string, message?: string): VisionRevision {
  const prev = currentVision(s);
  const docIds = v.docIds ?? prev.docIds;
  // The simulated flag is structured provenance, set only from the lead run's runtime.
  const rev: VisionRevision = { rev: prev.rev + 1, at: now, author: v.author, text: v.text, focus: v.focus, reason: v.reason, ...(v.source ? { source: v.source } : {}), ...(docIds ? { docIds: [...docIds] } : {}), ...(v.simulated ? { simulated: true as const } : {}) };
  s.project.visions.push(rev);
  event(s, now, v.author, "vision", message ?? `Vision r${rev.rev}: ${v.reason}`);
  return rev;
}

// ---------- the vision text in the draft (ORC-029 pass 5, r10) ----------
//
// Before the start, an edit of the vision text goes into force at once, as it always has. After the start, the text
// joins the blueprint's draft: "Edits collect in a draft", and the owner's Lock in puts the text into force together
// with the blueprint (blueprint.ts, `putDraftInForce`). The factory's lead and agents read the vision in force
// (`currentVision`); the studio works on the draft (`draftVisionText`). The focus is not design: it says what to work
// on now, like the lead's focus change (steering), so it applies at once in either stage.

/** The vision text the draft holds: its own after an edit since the last Lock in, or else the text in force. */
export function draftVisionText(s: State): string {
  return s.blueprint.draft.vision?.text ?? currentVision(s).text;
}

/**
 * Put a vision text into the draft, on a draft state (while building): it waits there for the owner's Lock in. The
 * text in force clears it (the draft holds no vision change then). Bumps the draft revision, so a Lock in summary shown
 * before it is refused.
 */
export function setDraftVisionInto(s: State, v: { text: string; reason: string; source?: DraftVision["source"]; simulated?: true }, now: string) {
  const { vision: _old, ...rest } = s.blueprint.draft;
  const same = v.text === currentVision(s).text;
  s.blueprint.draft = { ...rest, rev: rest.rev + 1, ...(same ? {} : { vision: { text: v.text, reason: v.reason, at: now, ...(v.source ? { source: v.source } : {}), ...(v.simulated ? { simulated: true as const } : {}) } }) };
  event(s, now, "user", "vision", same ? "The draft: the vision text is the one in force again" : `The draft: the vision text changed (${v.reason}); it goes into force at your Lock in`);
}

/**
 * The owner edits the vision. Before the start, a new revision in force. While building, the text goes into the draft
 * (until Lock in) and a focus change applies at once; an edit that changes neither is refused. `expectedRev` is the
 * revision in force the owner saw (compare-and-set).
 */
export function editVision(state: State, expectedRev: number, text: string, focus: string, reason: string, now: string): State {
  const s = draft(state);
  const v = currentVision(s);
  if (v.rev !== expectedRev) throw new StaleWriteError(expectedRev, v.rev);
  if (s.project.stage === "building") {
    // A project never builds without a vision. Clearing it is possible while shaping.
    if (!text.trim()) throw new ControlError("The vision cannot be empty while the factory runs.");
    const textChanged = text !== draftVisionText(s);
    const focusChanged = focus !== v.focus;
    if (!textChanged && !focusChanged) throw new ControlError("Nothing changed: the text is the draft's, and the focus is the one in force.");
    if (textChanged) setDraftVisionInto(s, { text, reason }, now);
    if (focusChanged) pushVision(s, { author: "user", text: v.text, focus, reason }, now);
    return s;
  }
  pushVision(s, { author: "user", text, focus, reason }, now);
  return s;
}

/** How far the lead may go when the user gives direction. Its own setting, never part of Autonomy. */
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
