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

export const BUILT_IN_TEMPLATES: WorkflowTemplate[] = [
  { id: "feature", name: "Feature", description: "User-facing change: design, implement, independent code and UX review, repair if needed, verify.", builtIn: true, rev: 1, steps: feature },
  { id: "change", name: "Change", description: "Code change without interaction design: implement, review, repair if needed, verify.", builtIn: true, rev: 1, steps: change },
  { id: "bugfix", name: "Bug fix", description: "Reproduce first, fix, review, repair if needed, verify the reproduction no longer fails.", builtIn: true, rev: 1, steps: bugfix },
  { id: "investigation", name: "Investigation", description: "Gather evidence, review it, and propose a follow-up implementation spec.", builtIn: true, rev: 1, steps: investigation },
  { id: "design", name: "Design", description: "Design only: design, UX review, revise if needed, hand off an implementation brief.", builtIn: true, rev: 1, steps: design },
];

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
