// The task model: state transitions for tasks, specs, steps and runs, and the views derived from them.
// Every operation is pure: it returns a new State and never mutates its input.
// Operations are applied one at a time, which serializes races such as
// pause-vs-completion: whichever is applied first determines the outcome.
//
// This file is the public entry. The code lives in src/domain/model/, one module per topic, and callers
// import from here (`import * as M from "./model"`). The modules also export helpers they share with each
// other (draft, getTask, requestStop, …); only the names re-exported below are public.

export {
  activeAgentAttempts, activeAttempts, activeServiceAttempts, currentSpec, currentVision, event, isActive, isSettled, nextId, nextRevisionFor,
  stopServiceRuns, testingInternals,
} from "./model/core";
export {
  artifactAuthor, authorsLabel, independentProviders, prAuthors, providerLabel, resolveStep, sourceLabel, writerOf, writersOf,
} from "./model/resolution";
export {
  blockedReason, BOARD_COLUMNS, column, type Column, deferredBy, deferredLabel, prerequisiteReady, stateLabel, stopLabel, waitingDetail,
  waitingForChildren, waitingOn,
} from "./model/presentation";
export { createFollowUp, editSpec, overrideSelection } from "./model/specs";
export {
  cancelTask, pauseProject, pauseTask, resumeProject, resumeTask, setHoldBeforeStart, setPriority, setPriorityPin, setRunPin, startHeldTask,
  undeferTask,
} from "./model/controls";
export { setProjectDefault, setProviderEnabled, setProviderLimit, setRoleDefault, setStepSelection, setTaskRoleOverride, setWorkerLimit } from "./model/steps";
export { autoRetryCandidates, autoRetryStep, rerunStep, retryStep } from "./model/retries";
export { editVision, markVisited, setSteeringMode } from "./model/vision";
export { dispatchEligible, dispatchRank, leadPromoteProposals } from "./model/dispatch";
export {
  acknowledgeStop, type OutputReport, reportActivity, reportCompletion, reportProgress, reportRunContext, reportRunFailed, reportRunLost,
  reportRunStarted, reportStopTimeout, retryStop, type RunContext, type RunReport, trustedBaseRef,
} from "./model/runs";
export {
  acceptedOutput, artifactPipelineRev, consumedInputs, editArtifact, fromEarlierFlow, latestArtifact, setReviewEveryStep, staleInputs,
} from "./model/artifacts";
export { changeFlow, flowChangeBlocker, flowChangePreview, serviceOwned, setDefaultFlow, setFlows } from "./model/taskFlow";
export { createTask, initProject, type NewTask, setCatalog, setRepoPath, setRunLimits, setWorkerConnections, setWorkerEnvironment } from "./model/project";
export {
  activeLeadRun, applyAutopilot, autonomyMode, deferredLeadRoots, deliveryNews, leadDue, messageStatus, openLeadProposals, pendingMessages, postMessage,
  reportLeadActivity, reportLeadFailed, reportLeadStarted, reportLeadStopped, reportLeadStopTimeout, setAutonomy, setLeadSelection, startLeadRun,
  stopLeadReply,
} from "./model/lead";
export { completeLeadRun, type LeadProposal, proposeTask, validateProposal } from "./model/leadOutput";
export { stripHostile, stripInvisible } from "./model/textSafety";
export { steerPermission, validateSteer, visionContentMovedSince } from "./model/steering";
export {
  type ApplyResult, applySteering, currentFocusChange, dismissSteering, openSuggestions, priorityProvenance, type UndoResult, undoSteering,
} from "./model/steeringChanges";
export {
  noteMessage, noteOf, notePermission, notesAtStart, notesOfRun, notesReceived, noteTextCheck, queuedNotes, recentNotes, reconcileNotes,
  reportNoteOutcome, rerunWithNote, sendNote,
} from "./model/notes";
export {
  acceptVisionDraft, answersMessage, coverageOf, dismissVisionDraft, latestQuestions, openAreas, openVisionDraft, roadmapTasks, SHAPING_LABEL,
  currentFactorySettings, type FactoryRequest, setDevices, startFactory, startFactoryBlocker, startFactoryPlan, startFactoryRequest, startVision,
  validateCoverage, validateQuestions, validateVisionDraft,
} from "./model/shaping";
export {
  addVisionDoc, type AttachResult, attachVisionDocs, currentVisionDocs, fmtBytes, isOfficeDoc, MAX_VISION_DOC_BYTES, MAX_VISION_DOCS,
  MAX_VISION_DOCS_BYTES, removeVisionDoc, STAGED_DOC_TTL_MS, stagedVisionDocs, stageVisionDoc, visionDocAdmission, type VisionDocInput, visionDocPath,
  visionDocsBytes, visionDocsOf,
} from "./model/visionDocs";
export {
  deliveryDue, finalChange, nextIntegration, reportDeliveryResult, reportIntegration, reportIntegrationError, resetDeliveryBaseline, retryIntegration,
} from "./model/integration";
export { exportMarkdown, importMarkdown } from "./model/markdown";
export { childFromEarlierFlow, childrenSettled, childTasks, currentChildren, descendants, MAX_CHILD_TASKS } from "./model/fanout";
export { premiseReason, runPrinciples } from "./model/runPrinciples";
export { continuePastBudget, setBudgets } from "./model/budget";
