// ORC-014 review 10: the Get-started list's first step and the new-project form, as pure decisions so
// they can be tested without a browser. An empty project starts by shaping, so the step must be
// completable while already shaping, and "Start building now" must ask for a vision instead of dying.

import * as M from "../domain/model";
import type { ProjectStage, State } from "../domain/types";

/** The first step is done once the user chose either way, or the project shows the choice was made: tasks exist, or the vision is written. */
export function stageStepDone(state: State, stageChosen: string | null): boolean {
  return stageChosen === "1" || state.tasks.length > 0 || M.currentVision(state).text.trim().length > 0;
}

/** Why "Start building now" cannot run yet (a vision first), or undefined. Already building: nothing stands in the way. */
export function startNowBlocker(state: State): string | undefined {
  if (state.project.stage === "building") return undefined;
  return M.startBuildingBlocker(state);
}

/** The new-project stage: the user's explicit choice, otherwise shaping while the vision is empty and building once it is written. */
export function newProjectStage(choice: ProjectStage | null, vision: string): ProjectStage {
  return choice ?? (vision.trim() ? "building" : "shaping");
}

/** The confirmation before replacing the project, saying what is lost: the board, the history, and any vision documents. */
export function initProjectConfirm(name: string, docCount: number): string {
  const one = docCount === 1;
  const docs = docCount
    ? ` The ${docCount} vision document${one ? "" : "s"} attached to the current project ${one ? "is" : "are"} removed too, and ${one ? "its copy is" : "their copies are"} deleted from disk; attach ${one ? "it" : "them"} again to the new project if you still need ${one ? "it" : "them"}.`
    : "";
  return `Start a new project "${name}"? The current board and history are replaced.${docs}`;
}
