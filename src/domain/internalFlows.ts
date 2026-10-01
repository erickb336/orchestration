// The pipelines the service owns. They stay in code, never among the flows a task can be created from:
// their steps are a contract with delivery code (a prepared revert, a review pinned to a commit, a check
// target). ORC-021: the revert and the delivery review carry a security review beside their code review.
// ORC-024: each step names the principles that fit it, as the flow files do (the table in docs/tasks/ORC-024.md).

import type { InputRef, StepDef } from "./types";

const ref = (step: string, output: string): InputRef => ({ step, output });

const FINAL_CHECKS_PURPOSE = "Final checks";

/** ORC-024: the principles every code reviewer and every security reviewer gets, in the flows, here and in check rounds. */
export const CODE_REVIEW_PRINCIPLES = ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"];
export const SECURITY_REVIEW_PRINCIPLES = ["boundary-discipline"];
/** ORC-024: the principles every repair step gets (loop repairs and check-round fixes); "attack the premise" is added by dispatch when a round fails the same way again. */
export const REPAIR_PRINCIPLES = ["laziness-protocol", "migrate-callers-then-delete-legacy-apis", "fix-root-causes"];

export interface InternalFlow {
  id: InternalFlowId;
  name: string;
  description: string;
  steps: StepDef[];
}

type InternalFlowId = "revert" | "delivery-review" | "delivery-checks";

/**
 * Pipelines the service uses itself and that are never offered for a new task: a task made from
 * "revert" by hand would have nothing prepared in its workspace, one made from "delivery-review" would
 * have no pull request to review, and one made from "delivery-checks" would have no change to check.
 */
const INTERNAL_FLOW_IDS: InternalFlowId[] = ["revert", "delivery-review", "delivery-checks"];

export const isInternalFlowId = (id: string): id is InternalFlowId => (INTERNAL_FLOW_IDS as string[]).includes(id);

/**
 * Undo a change that already landed. The service prepares the revert in the first coder's workspace
 * before the run starts; the coder completes it, and it is reviewed and delivered like any task.
 */
const revert: StepDef[] = [
  {
    id: "S1",
    purpose: "Complete the prepared revert: resolve any conflicts, keep later work",
    role: "coder",
    dependsOn: [],
    inputs: [],
    outputs: [
      { name: "change", kind: "code-change" },
      { name: "handoff", kind: "handoff" },
    ],
    principles: ["laziness-protocol"],
  },
  { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1"], inputs: [ref("S1", "change"), ref("S1", "handoff")], outputs: [{ name: "findings", kind: "review-findings" }], principles: [...CODE_REVIEW_PRINCIPLES] },
  { id: "SR1", purpose: "Security review", role: "security_reviewer", dependsOn: ["S1"], inputs: [ref("S1", "change"), ref("S1", "handoff")], outputs: [{ name: "findings", kind: "review-findings" }], principles: [...SECURITY_REVIEW_PRINCIPLES] },
  { id: "C1", purpose: FINAL_CHECKS_PURPOSE, role: "checks", dependsOn: ["S2", "SR1"], inputs: [ref("S1", "change")], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "block" } },
  {
    id: "S3",
    // ORC-017: the instruction that was here reaches the lead through its role brief (server/envelope.ts VERIFY_CHECKS_NOTE).
    purpose: "Verify the revert and integrate",
    role: "lead",
    dependsOn: ["C1"],
    inputs: [ref("S1", "change"), ref("S2", "findings"), ref("SR1", "findings"), ref("C1", "final")],
    outputs: [{ name: "verification", kind: "verification" }],
    principles: ["prove-it-works"],
  },
];

/**
 * One independent code review and one security review of a pull request's change before it merges. The
 * service creates the task itself, points both reviewers' workspaces at the exact commit, and hands them
 * the changed lines. The findings of either gate the merge.
 */
const deliveryReview: StepDef[] = [
  { id: "S1", purpose: "Review the change for merge", role: "code_reviewer", dependsOn: [], inputs: [], outputs: [{ name: "findings", kind: "review-findings" }], independentOf: "writer", principles: [...CODE_REVIEW_PRINCIPLES] },
  { id: "SR1", purpose: "Security review of the change for merge", role: "security_reviewer", dependsOn: [], inputs: [], outputs: [{ name: "findings", kind: "review-findings" }], independentOf: "writer", principles: [...SECURITY_REVIEW_PRINCIPLES] },
];

/**
 * ORC-013: the project's checks run once on a pull request's change for merge, when that change has
 * no check evidence of its own. The service creates the task itself with a `checkTarget`.
 */
const deliveryChecks: StepDef[] = [
  { id: "S1", purpose: "Run the project's checks on the change for merge", role: "checks", dependsOn: [], inputs: [], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "findings" } },
];

export const INTERNAL_FLOWS: InternalFlow[] = [
  { id: "revert", name: "Revert", description: "Undo a landed change: complete the prepared revert, code and security review, final checks, verify. Used by Send back as revert.", steps: revert },
  {
    id: "delivery-review",
    name: "Delivery review",
    description: "An independent code review and a security review of a pull request's change before it merges, by another provider than the writer. Used by pull-request delivery.",
    steps: deliveryReview,
  },
  {
    id: "delivery-checks",
    name: "Delivery checks",
    description: "The project's checks, run by the service on a pull request's change before it merges. Used by pull-request delivery.",
    steps: deliveryChecks,
  },
];

/** An internal flow by id, with its steps cloned. */
export function internalFlow(id: string): InternalFlow {
  const p = INTERNAL_FLOWS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown internal flow ${id}`);
  return { ...p, steps: structuredClone(p.steps) };
}
