// ORC-025 pass 3 (P8): the in-page confirmations of the task page, as data. Each says what the action does and
// what is kept, so the dialog carries the explanation the browser's confirm() used to.

import type { ConfirmOptions } from "../kit/confirmCore";

export const CONFIRM = {
  cancelTask: (taskId: string): ConfirmOptions => ({
    title: `Cancel ${taskId}?`,
    text: "Any agent working on it is stopped. The spec and the outputs so far are kept.\nA cancelled task cannot be resumed; create a new task instead.",
    primaryLabel: "Cancel task",
    cancelLabel: "Keep it",
    danger: true,
  }),
  createFollowUp: (taskId: string): ConfirmOptions => ({
    title: `Create a follow-up of ${taskId}?`,
    text: "A new task starts from this task's spec and flow, depending on it. It waits for your go-ahead, so you can edit the spec before anything runs.",
    primaryLabel: "Create follow-up",
  }),
  rerunStep: (stepId: string, purpose: string): ConfirmOptions => ({
    title: `Rerun ${stepId} (${purpose})?`,
    text: "Steps that depend on it will need revalidation, and any of them still running is stopped. Its earlier results stay on the record.",
    primaryLabel: "Rerun",
  }),
  changeModelWhileRunning: (stepId: string): ConfirmOptions => ({
    title: `Change the model while ${stepId} is running?`,
    text: "The current run is stopped and its work so far is checkpointed. A new attempt starts with the model you chose.",
    primaryLabel: "Change model",
  }),
  acceptFailingChecks: (): ConfirmOptions => ({
    title: "Accept the failing checks and let the task finish?",
    text: "The landed work is flagged as accepted with failing checks. Only you can do this; the lead cannot.",
    primaryLabel: "Accept failing checks",
    danger: true,
  }),
  discardDraft: (baseRev: number): ConfirmOptions => ({
    title: "Discard your draft?",
    text: `Your edits since r${baseRev} are lost. The spec stays as it is.`,
    primaryLabel: "Discard draft",
    cancelLabel: "Keep editing",
    danger: true,
  }),
};
