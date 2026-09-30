// Built-in workflow templates. Generic by design: they describe kinds of work toward any
// project or app goal and name no product, repository, or model.

import type { InputRef, StepDef, WorkflowTemplate } from "./types";

const ref = (step: string, output: string): InputRef => ({ step, output });

const feature: StepDef[] = [
  { id: "S1", purpose: "Plan and design the change", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "design", kind: "design" }] },
  {
    id: "S2",
    purpose: "Implement",
    role: "coder",
    dependsOn: ["S1"],
    inputs: [ref("S1", "design")],
    outputs: [
      { name: "change", kind: "code-change" },
      { name: "handoff", kind: "handoff" },
    ],
  },
  {
    id: "S3",
    purpose: "Code review",
    role: "code_reviewer",
    dependsOn: ["S2"],
    inputs: [ref("S1", "design"), ref("S2", "change"), ref("S2", "handoff")],
    outputs: [{ name: "findings", kind: "review-findings" }],
  },
  {
    id: "S4",
    purpose: "UX review",
    role: "ux_reviewer",
    dependsOn: ["S2"],
    inputs: [ref("S1", "design"), ref("S2", "change")],
    outputs: [{ name: "findings", kind: "review-findings" }],
  },
  {
    id: "S5",
    purpose: "Repair review findings",
    role: "coder",
    dependsOn: ["S3", "S4"],
    inputs: [ref("S2", "change"), ref("S3", "findings"), ref("S4", "findings")],
    outputs: [{ name: "change", kind: "code-change" }],
    runIf: [ref("S3", "findings"), ref("S4", "findings")],
    // Review → repair repeats until the reviews find nothing (at most 3 rounds).
    iterate: { from: "S3", max: 3 },
  },
  {
    id: "S6",
    purpose: "Verify and integrate",
    role: "lead",
    dependsOn: ["S5"],
    inputs: [ref("S2", "change"), ref("S5", "change"), ref("S3", "findings"), ref("S4", "findings")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

const change: StepDef[] = [
  {
    id: "S1",
    purpose: "Implement",
    role: "coder",
    dependsOn: [],
    inputs: [],
    outputs: [
      { name: "change", kind: "code-change" },
      { name: "handoff", kind: "handoff" },
    ],
  },
  { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1"], inputs: [ref("S1", "change"), ref("S1", "handoff")], outputs: [{ name: "findings", kind: "review-findings" }] },
  {
    id: "S3",
    purpose: "Repair review findings",
    role: "coder",
    dependsOn: ["S2"],
    inputs: [ref("S1", "change"), ref("S2", "findings")],
    outputs: [{ name: "change", kind: "code-change" }],
    runIf: [ref("S2", "findings")],
    iterate: { from: "S2", max: 3 },
  },
  {
    id: "S4",
    purpose: "Verify and integrate",
    role: "lead",
    dependsOn: ["S3"],
    inputs: [ref("S1", "change"), ref("S3", "change"), ref("S2", "findings")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

const bugfix: StepDef[] = [
  { id: "S1", purpose: "Reproduce and diagnose", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "reproduction", kind: "report" }] },
  {
    id: "S2",
    purpose: "Fix",
    role: "coder",
    dependsOn: ["S1"],
    inputs: [ref("S1", "reproduction")],
    outputs: [
      { name: "change", kind: "code-change" },
      { name: "handoff", kind: "handoff" },
    ],
  },
  { id: "S3", purpose: "Code review", role: "code_reviewer", dependsOn: ["S2"], inputs: [ref("S1", "reproduction"), ref("S2", "change"), ref("S2", "handoff")], outputs: [{ name: "findings", kind: "review-findings" }] },
  {
    id: "S4",
    purpose: "Repair review findings",
    role: "coder",
    dependsOn: ["S3"],
    inputs: [ref("S2", "change"), ref("S3", "findings")],
    outputs: [{ name: "change", kind: "code-change" }],
    runIf: [ref("S3", "findings")],
    iterate: { from: "S3", max: 3 },
  },
  {
    id: "S5",
    purpose: "Verify the reproduction no longer fails, then integrate",
    role: "lead",
    dependsOn: ["S4"],
    inputs: [ref("S1", "reproduction"), ref("S2", "change"), ref("S4", "change")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

const investigation: StepDef[] = [
  { id: "S1", purpose: "Investigate and gather evidence", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "report", kind: "report" }] },
  { id: "S2", purpose: "Review evidence for gaps", role: "code_reviewer", dependsOn: ["S1"], inputs: [ref("S1", "report")], outputs: [{ name: "findings", kind: "review-findings" }] },
  {
    id: "S3",
    purpose: "Propose follow-up spec",
    role: "lead",
    dependsOn: ["S2"],
    inputs: [ref("S1", "report"), ref("S2", "findings")],
    outputs: [{ name: "brief", kind: "brief" }],
  },
];

const design: StepDef[] = [
  { id: "S1", purpose: "Design flow, states, and copy", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "design", kind: "design" }] },
  { id: "S2", purpose: "UX review", role: "ux_reviewer", dependsOn: ["S1"], inputs: [ref("S1", "design")], outputs: [{ name: "findings", kind: "review-findings" }] },
  {
    id: "S3",
    purpose: "Revise design",
    role: "designer",
    dependsOn: ["S2"],
    inputs: [ref("S1", "design"), ref("S2", "findings")],
    outputs: [{ name: "design", kind: "design" }],
    runIf: [ref("S2", "findings")],
    iterate: { from: "S2", max: 3 },
  },
  {
    id: "S4",
    purpose: "Accept design and write implementation brief",
    role: "lead",
    dependsOn: ["S3"],
    inputs: [ref("S1", "design"), ref("S3", "design"), ref("S2", "findings")],
    outputs: [{ name: "brief", kind: "brief" }],
  },
];

/**
 * Large goals: plan a breakdown into child tasks (each runs its own pipeline in parallel), wait for
 * them, then evaluate. The evaluation may break the remaining work down again, up to five rounds.
 */
const goal: StepDef[] = [
  { id: "S1", purpose: "Plan the goal and break it into independent tasks", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "plan", kind: "breakdown" }] },
  {
    id: "S2",
    purpose: "Evaluate the finished tasks against the goal; list any remaining work",
    role: "lead",
    dependsOn: ["S1"],
    inputs: [ref("S1", "plan")],
    outputs: [{ name: "next", kind: "breakdown" }],
    waitForChildren: true,
    iterate: { from: "S2", max: 5 },
  },
  {
    id: "S3",
    purpose: "Report the outcome of the goal",
    role: "lead",
    dependsOn: ["S2"],
    inputs: [ref("S1", "plan"), ref("S2", "next")],
    outputs: [{ name: "report", kind: "verification" }],
    waitForChildren: true,
  },
];

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
  },
  { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1"], inputs: [ref("S1", "change"), ref("S1", "handoff")], outputs: [{ name: "findings", kind: "review-findings" }] },
  {
    id: "S3",
    purpose: "Verify the revert and integrate",
    role: "lead",
    dependsOn: ["S2"],
    inputs: [ref("S1", "change"), ref("S2", "findings")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

export const BUILT_IN_TEMPLATES: WorkflowTemplate[] = [
  { id: "goal", name: "Goal", description: "Large goal: break it into parallel child tasks, evaluate, and iterate until the goal is met.", builtIn: true, rev: 1, steps: goal },
  { id: "feature", name: "Feature", description: "User-facing change: design, implement, independent code and UX review, repair if needed, verify.", builtIn: true, rev: 1, steps: feature },
  { id: "change", name: "Change", description: "Code change without interaction design: implement, review, repair if needed, verify.", builtIn: true, rev: 1, steps: change },
  { id: "bugfix", name: "Bug fix", description: "Reproduce first, fix, review, repair if needed, verify the reproduction no longer fails.", builtIn: true, rev: 1, steps: bugfix },
  { id: "investigation", name: "Investigation", description: "Gather evidence, review it, and propose a follow-up implementation spec.", builtIn: true, rev: 1, steps: investigation },
  { id: "design", name: "Design", description: "Design only: design, UX review, revise if needed, hand off an implementation brief.", builtIn: true, rev: 1, steps: design },
  { id: "revert", name: "Revert", description: "Undo a landed change: complete the prepared revert, review it, verify. Used by Send back as revert.", builtIn: true, rev: 1, steps: revert },
];

/**
 * Built-in templates the service uses itself and that are never offered for a new task: a task made
 * from "revert" by hand would have nothing prepared in its workspace.
 */
export const INTERNAL_TEMPLATE_IDS = ["revert"];

/** The built-in templates a project starts with and a person or the lead can pick. */
export const PROJECT_TEMPLATES: WorkflowTemplate[] = BUILT_IN_TEMPLATES.filter((t) => !INTERNAL_TEMPLATE_IDS.includes(t.id));

export function templateSteps(id: string): StepDef[] {
  const t = BUILT_IN_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown template ${id}`);
  return structuredClone(t.steps);
}

/** True when a project template differs from the built-in it came from. */
export function isModifiedBuiltIn(t: WorkflowTemplate): boolean {
  const b = BUILT_IN_TEMPLATES.find((x) => x.id === t.id);
  if (!b) return false;
  return JSON.stringify([t.name, t.description, t.steps]) !== JSON.stringify([b.name, b.description, b.steps]);
}
