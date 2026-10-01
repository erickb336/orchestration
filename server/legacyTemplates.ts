// ORC-016: frozen copies of the built-in workflow templates as earlier state formats shipped them. The
// migrations read these, never the live catalog, so 13 → 14 → 15 keeps working after templates are gone,
// and a test proves the built-in flows equal the format-14 templates apart from the security review beside
// each code review (ORC-021). Nothing else reads them.

import type { InputRef, StepDef } from "../src/domain/types";

const ref = (step: string, output: string): InputRef => ({ step, output });

/**
 * ORC-013: the code-changing built-in templates exactly as format 13 shipped them. The 13 → 14 upgrade
 * replaces a project's copy with the format-14 built-in only when it still matches one of these; an
 * edited template is left alone.
 */
export const V13_TEMPLATE_STEPS: Record<string, StepDef[]> = {
  feature: [
    { id: "S1", purpose: "Plan and design the change", role: "designer", dependsOn: [], inputs: [], outputs: [{ name: "design", kind: "design" }] },
    {
      id: "S2",
      purpose: "Implement",
      role: "coder",
      dependsOn: ["S1"],
      inputs: [{ step: "S1", output: "design" }],
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
      inputs: [
        { step: "S1", output: "design" },
        { step: "S2", output: "change" },
        { step: "S2", output: "handoff" },
      ],
      outputs: [{ name: "findings", kind: "review-findings" }],
    },
    {
      id: "S4",
      purpose: "UX review",
      role: "ux_reviewer",
      dependsOn: ["S2"],
      inputs: [
        { step: "S1", output: "design" },
        { step: "S2", output: "change" },
      ],
      outputs: [{ name: "findings", kind: "review-findings" }],
    },
    {
      id: "S5",
      purpose: "Repair review findings",
      role: "coder",
      dependsOn: ["S3", "S4"],
      inputs: [
        { step: "S2", output: "change" },
        { step: "S3", output: "findings" },
        { step: "S4", output: "findings" },
      ],
      outputs: [{ name: "change", kind: "code-change" }],
      runIf: [
        { step: "S3", output: "findings" },
        { step: "S4", output: "findings" },
      ],
      iterate: { from: "S3", max: 3 },
    },
    {
      id: "S6",
      purpose: "Verify and integrate",
      role: "lead",
      dependsOn: ["S5"],
      inputs: [
        { step: "S2", output: "change" },
        { step: "S5", output: "change" },
        { step: "S3", output: "findings" },
        { step: "S4", output: "findings" },
      ],
      outputs: [{ name: "verification", kind: "verification" }],
    },
  ],
  change: [
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
    {
      id: "S2",
      purpose: "Code review",
      role: "code_reviewer",
      dependsOn: ["S1"],
      inputs: [
        { step: "S1", output: "change" },
        { step: "S1", output: "handoff" },
      ],
      outputs: [{ name: "findings", kind: "review-findings" }],
    },
    {
      id: "S3",
      purpose: "Repair review findings",
      role: "coder",
      dependsOn: ["S2"],
      inputs: [
        { step: "S1", output: "change" },
        { step: "S2", output: "findings" },
      ],
      outputs: [{ name: "change", kind: "code-change" }],
      runIf: [{ step: "S2", output: "findings" }],
      iterate: { from: "S2", max: 3 },
    },
    {
      id: "S4",
      purpose: "Verify and integrate",
      role: "lead",
      dependsOn: ["S3"],
      inputs: [
        { step: "S1", output: "change" },
        { step: "S3", output: "change" },
        { step: "S2", output: "findings" },
      ],
      outputs: [{ name: "verification", kind: "verification" }],
    },
  ],
  bugfix: [
    { id: "S1", purpose: "Reproduce and diagnose", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "reproduction", kind: "report" }] },
    {
      id: "S2",
      purpose: "Fix",
      role: "coder",
      dependsOn: ["S1"],
      inputs: [{ step: "S1", output: "reproduction" }],
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
      inputs: [
        { step: "S1", output: "reproduction" },
        { step: "S2", output: "change" },
        { step: "S2", output: "handoff" },
      ],
      outputs: [{ name: "findings", kind: "review-findings" }],
    },
    {
      id: "S4",
      purpose: "Repair review findings",
      role: "coder",
      dependsOn: ["S3"],
      inputs: [
        { step: "S2", output: "change" },
        { step: "S3", output: "findings" },
      ],
      outputs: [{ name: "change", kind: "code-change" }],
      runIf: [{ step: "S3", output: "findings" }],
      iterate: { from: "S3", max: 3 },
    },
    {
      id: "S5",
      purpose: "Verify the reproduction no longer fails, then integrate",
      role: "lead",
      dependsOn: ["S4"],
      inputs: [
        { step: "S1", output: "reproduction" },
        { step: "S2", output: "change" },
        { step: "S4", output: "change" },
      ],
      outputs: [{ name: "verification", kind: "verification" }],
    },
  ],
  revert: [
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
    {
      id: "S2",
      purpose: "Code review",
      role: "code_reviewer",
      dependsOn: ["S1"],
      inputs: [
        { step: "S1", output: "change" },
        { step: "S1", output: "handoff" },
      ],
      outputs: [{ name: "findings", kind: "review-findings" }],
    },
    {
      id: "S3",
      purpose: "Verify the revert and integrate",
      role: "lead",
      dependsOn: ["S2"],
      inputs: [
        { step: "S1", output: "change" },
        { step: "S2", output: "findings" },
      ],
      outputs: [{ name: "verification", kind: "verification" }],
    },
  ],
};

// ---------- the nine built-in templates exactly as state format 14 shipped them (src/domain/templates.ts at 4096d49) ----------

const CHECKS_PURPOSE = "Run the project's checks";
const FINAL_CHECKS_PURPOSE = "Final checks";
const VERIFY_CHECKS_NOTE = "Service check results are the record of what ran; do not say tests passed unless a check result shows it.";

const feature14: StepDef[] = [
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
  { id: "C1", purpose: CHECKS_PURPOSE, role: "checks", dependsOn: ["S2"], inputs: [ref("S2", "change")], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings" } },
  {
    id: "S3",
    purpose: "Code review",
    role: "code_reviewer",
    dependsOn: ["S2", "C1"],
    inputs: [ref("S1", "design"), ref("S2", "change"), ref("S2", "handoff"), ref("C1", "checks")],
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
    purpose: "Repair review findings and failing checks",
    role: "coder",
    dependsOn: ["S3", "S4"],
    inputs: [ref("S2", "change"), ref("S3", "findings"), ref("S4", "findings"), ref("C1", "checks")],
    outputs: [{ name: "change", kind: "code-change" }],
    runIf: [ref("C1", "checks"), ref("S3", "findings"), ref("S4", "findings")],
    iterate: { from: "C1", max: 3 },
  },
  { id: "C2", purpose: FINAL_CHECKS_PURPOSE, role: "checks", dependsOn: ["S5"], inputs: [ref("S2", "change"), ref("S5", "change")], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "block" } },
  {
    id: "S6",
    purpose: `Verify and integrate. ${VERIFY_CHECKS_NOTE}`,
    role: "lead",
    dependsOn: ["C2"],
    inputs: [ref("S2", "change"), ref("S5", "change"), ref("S3", "findings"), ref("S4", "findings"), ref("C2", "final")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

const change14: StepDef[] = [
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
  { id: "C1", purpose: CHECKS_PURPOSE, role: "checks", dependsOn: ["S1"], inputs: [ref("S1", "change")], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings" } },
  { id: "S2", purpose: "Code review", role: "code_reviewer", dependsOn: ["S1", "C1"], inputs: [ref("S1", "change"), ref("S1", "handoff"), ref("C1", "checks")], outputs: [{ name: "findings", kind: "review-findings" }] },
  {
    id: "S3",
    purpose: "Repair review findings and failing checks",
    role: "coder",
    dependsOn: ["S2"],
    inputs: [ref("S1", "change"), ref("S2", "findings"), ref("C1", "checks")],
    outputs: [{ name: "change", kind: "code-change" }],
    runIf: [ref("C1", "checks"), ref("S2", "findings")],
    iterate: { from: "C1", max: 3 },
  },
  { id: "C2", purpose: FINAL_CHECKS_PURPOSE, role: "checks", dependsOn: ["S3"], inputs: [ref("S1", "change"), ref("S3", "change")], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "block" } },
  {
    id: "S4",
    purpose: `Verify and integrate. ${VERIFY_CHECKS_NOTE}`,
    role: "lead",
    dependsOn: ["C2"],
    inputs: [ref("S1", "change"), ref("S3", "change"), ref("S2", "findings"), ref("C2", "final")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

const bugfix14: StepDef[] = [
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
  { id: "C1", purpose: CHECKS_PURPOSE, role: "checks", dependsOn: ["S2"], inputs: [ref("S2", "change")], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings" } },
  {
    id: "S3",
    purpose: "Code review",
    role: "code_reviewer",
    dependsOn: ["S2", "C1"],
    inputs: [ref("S1", "reproduction"), ref("S2", "change"), ref("S2", "handoff"), ref("C1", "checks")],
    outputs: [{ name: "findings", kind: "review-findings" }],
  },
  {
    id: "S4",
    purpose: "Repair review findings and failing checks",
    role: "coder",
    dependsOn: ["S3"],
    inputs: [ref("S2", "change"), ref("S3", "findings"), ref("C1", "checks")],
    outputs: [{ name: "change", kind: "code-change" }],
    runIf: [ref("C1", "checks"), ref("S3", "findings")],
    iterate: { from: "C1", max: 3 },
  },
  { id: "C2", purpose: FINAL_CHECKS_PURPOSE, role: "checks", dependsOn: ["S4"], inputs: [ref("S2", "change"), ref("S4", "change")], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "block" } },
  {
    id: "S5",
    purpose: `Verify the reproduction no longer fails, then integrate. ${VERIFY_CHECKS_NOTE}`,
    role: "lead",
    dependsOn: ["C2"],
    inputs: [ref("S1", "reproduction"), ref("S2", "change"), ref("S4", "change"), ref("C2", "final")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

const investigation14: StepDef[] = [
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

const design14: StepDef[] = [
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

const goal14: StepDef[] = [
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

const revert14: StepDef[] = [
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
  { id: "C1", purpose: FINAL_CHECKS_PURPOSE, role: "checks", dependsOn: ["S2"], inputs: [ref("S1", "change")], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "block" } },
  {
    id: "S3",
    purpose: `Verify the revert and integrate. ${VERIFY_CHECKS_NOTE}`,
    role: "lead",
    dependsOn: ["C1"],
    inputs: [ref("S1", "change"), ref("S2", "findings"), ref("C1", "final")],
    outputs: [{ name: "verification", kind: "verification" }],
  },
];

const deliveryReview14: StepDef[] = [
  { id: "S1", purpose: "Review the change for merge", role: "code_reviewer", dependsOn: [], inputs: [], outputs: [{ name: "findings", kind: "review-findings" }], independentOf: "writer" },
];

const deliveryChecks14: StepDef[] = [
  { id: "S1", purpose: "Run the project's checks on the change for merge", role: "checks", dependsOn: [], inputs: [], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "findings" } },
];

interface V14Template {
  id: string;
  name: string;
  description: string;
  steps: StepDef[];
}

/** The format-14 built-in templates by id, including the three the service used itself. */
export const V14_TEMPLATES: Record<string, V14Template> = Object.fromEntries(
  (
    [
      { id: "goal", name: "Goal", description: "Large goal: break it into parallel child tasks, evaluate, and iterate until the goal is met.", steps: goal14 },
      { id: "feature", name: "Feature", description: "User-facing change: design, implement, checks, independent code and UX review, repair if needed, final checks, verify.", steps: feature14 },
      { id: "change", name: "Change", description: "Code change without interaction design: implement, checks, review, repair if needed, final checks, verify.", steps: change14 },
      { id: "bugfix", name: "Bug fix", description: "Reproduce first, fix, checks, review, repair if needed, final checks, verify the reproduction no longer fails.", steps: bugfix14 },
      { id: "investigation", name: "Investigation", description: "Gather evidence, review it, and propose a follow-up implementation spec.", steps: investigation14 },
      { id: "design", name: "Design", description: "Design only: design, UX review, revise if needed, hand off an implementation brief.", steps: design14 },
      { id: "revert", name: "Revert", description: "Undo a landed change: complete the prepared revert, review it, final checks, verify. Used by Send back as revert.", steps: revert14 },
      {
        id: "delivery-review",
        name: "Delivery review",
        description: "One independent review of a pull request's change before it merges, by another provider than the writer. Used by pull-request delivery.",
        steps: deliveryReview14,
      },
      {
        id: "delivery-checks",
        name: "Delivery checks",
        description: "The project's checks, run by the service on a pull request's change before it merges. Used by pull-request delivery.",
        steps: deliveryChecks14,
      },
    ] satisfies V14Template[]
  ).map((t) => [t.id, t]),
);

/** The format-14 template steps, cloned. */
export function v14TemplateSteps(id: string): StepDef[] {
  const t = V14_TEMPLATES[id];
  if (!t) throw new Error(`Unknown format-14 template ${id}`);
  return structuredClone(t.steps);
}
