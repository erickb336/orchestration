// Delivery of finished work: local branch delivery, GitHub pull requests, and the review-later queue
// of what landed. Pure, like model.ts: every operation returns a new State and never mutates its input.
//
// The queue is informational. Nothing here is read to decide dispatch, integration or merging, and a
// landed item's `status` changes only through markLandedReviewed and sendBackLanded.
//
// This file is the public entry. The code lives in src/domain/delivery/, one module per topic, and callers
// import from here (`import * as D from "./delivery"`). The modules also export helpers they share with
// each other; only the names re-exported below are public.

export { deliveryMode, type DeliveryMode, recheckGitHub, resumeAutoMerge, setDeliveryMode, setPrDelivery, undeliveredTasks } from "./delivery/settings";
export {
  addLandedNote, cannotPostNote, landedRepo, landedReviews, landedTasks, markLandedReviewed, MAX_NOTE_CHARS, MAX_NOTES_PER_ITEM, needsYou, openRevertOf,
  recordLanded, retryLandedComment, sendBackLanded, unreviewedCount,
} from "./delivery/landed";
export {
  livePr, matchGlob, noteMarker, type Observations, OP_TIMEOUT_MS, openPrTasks, type OpError, type OpErrorCode, opMutates, PR_BRANCH_REF, PR_LIMITS,
  prBaseRef, prBranch, type PreflightReport, prMarker, type PrObservation, type PrOp, type PrOpResult, redeliverable, type ReportContext,
  revertWaitsForBase, trackedPrTasks, writersHeld,
} from "./delivery/pr";
export { ensureReview, requestPrReview, reviewCoverage, reviewView } from "./delivery/review";
export { ensureChecks } from "./delivery/serviceChecks";
export { advanceDelivery, createRepair, deliveredInto, openRepair, repairCause, repairPr, repairTarget } from "./delivery/repair";
export { autoQueue, type Gate, type GateItem, mergeCandidate, prGate, prReady, queueAhead } from "./delivery/gate";
export { codeWhy, JOB_TIMEOUT_MS, triageCheck } from "./delivery/ciTriage";
export { mergeBody, mergeSubject, prBody, prTitle } from "./delivery/prText";
export { reportPrHead, reportRepairHead } from "./delivery/prHeads";
export { reportBaseFetched, reportObservations, reportPreflight } from "./delivery/observations";
export { beginPrOp, nextPrOp, reportPrOp } from "./delivery/planner";
export { allowWorkflowPush, closePr, holdPr, redeliver, releasePr, requestPrMerge, setPrPolicy } from "./delivery/commands";
export { prIntentLine, prLabel, type PrLabel } from "./delivery/labels";
