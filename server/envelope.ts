// The assignment envelope every worker receives, whichever provider runs it, and the parser for the
// output block workers must end with. Provider session state is never passed between runs; context
// travels only through this envelope and the artifacts it references.

import * as M from "../src/domain/model";
import { INTERNAL_TEMPLATE_IDS } from "../src/domain/templates";
import type { LeadRun, OutputDef, RoleId, State, Step, Task } from "../src/domain/types";

const ROLE_BRIEFS: Record<RoleId, string> = {
  lead: "You are the lead. Verify the work against the acceptance criteria using the inputs, and decide whether it is ready to integrate. Do not change files.",
  designer: "You are the designer. Reduce steps and decisions for the user; define the essential flow, states, copy, and accessibility. Produce a concrete interaction specification. Do not change code.",
  coder: "You are the coder. Implement the assigned behaviour in this workspace with focused, minimal changes, following the repository's existing conventions. Run no destructive commands.",
  code_reviewer:
    "You are an independent code reviewer. Inspect the change for correctness, data preservation, regressions, and missing tests. Report actionable findings with file locations. Do not change files.",
  ux_reviewer:
    "You are an independent UX reviewer. Compare the implemented experience with the intended flow; check empty, loading, failure, correction, and success states. Report findings. Do not change files.",
};

export interface EnvelopeInput {
  state: State;
  task: Task;
  step: Step;
  attemptId: string;
  access: "write" | "read";
  /** A merge or revert the service prepared, uncommitted, in the workspace before the run. */
  seed?: { kind: "merge" | "revert"; commit: string; conflicted: string[] };
}

export function buildEnvelope({ state, task, step, attemptId, access, seed }: EnvelopeInput): string {
  const vision = M.currentVision(state);
  const spec = M.currentSpec(task);
  const c = spec.content;
  const selected = c.options.find((o) => o.id === c.selectedOptionId);
  const inputs = M.consumedInputs(state, task, step);
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none recorded)");

  const inputText = inputs.length
    ? inputs
        .map((i) => {
          const art = state.artifacts.find((a) => a.id === i.artifactId);
          if (!art) return `- ${i.step}.${i.output} v${i.version}: (missing)`;
          const ref = art.ref ? ` [ref: ${art.ref}]` : "";
          const findings = art.openFindings !== undefined ? ` (${art.openFindings} open findings)` : "";
          const edited = art.author === "user" ? ` [edited by the user: ${art.editReason ?? "no reason given"}; follow this version]` : "";
          return `- ${i.step}.${i.output} v${art.version} (${art.kind})${findings}${ref}${edited}:\n  ${art.summary.replace(/\n/g, "\n  ")}`;
        })
        .join("\n")
    : "- No upstream artifacts. Work from the specification.";

  const outputSpec = step.outputs
    .map((o) => {
      if (o.kind === "review-findings") return `    "${o.name}": { "summary": "<findings, each with file:line and a suggested fix>", "openFindings": <number of unresolved findings> }`;
      if (o.kind === "code-change") return `    "${o.name}": { "summary": "<what you changed and why, and what you verified>" }`;
      if (o.kind === "breakdown")
        return `    "${o.name}": { "summary": "<the plan in a few sentences>", "items": [ { "title": "...", "outcome": "...", "approach": "...", "acceptance": ["..."], "templateId": "change", "priority": 3, "dependsOn": [0] } ] }`;
      return `    "${o.name}": { "summary": "<your ${o.kind}>" }`;
    })
    .join(",\n");

  return `# Assignment ${attemptId}: ${task.id} ${step.id}

${ROLE_BRIEFS[step.role]}

## Your step
${step.purpose}

## Project vision (r${vision.rev})
${vision.text}
Current focus: ${vision.focus}

## Task ${task.id} (spec r${spec.rev}): ${c.title}
Outcome: ${c.outcome}
User benefit: ${c.benefit}
${c.whyNow ? `Why now: ${c.whyNow}\n` : ""}Selected approach ${selected?.id ?? "?"}: ${selected?.name ?? ""} — ${selected?.approach ?? ""}
In scope:
${list(c.scopeIncluded)}
Out of scope:
${list(c.scopeExcluded)}
Acceptance criteria:
${list(c.acceptance)}

## Inputs from earlier steps
${inputText}

${bestOfNote(state, task, step)}${childrenNote(state, task, step)}${seedNote(seed)}## Workspace rules
- Your working directory is an isolated git worktree created for this run. ${access === "write" ? "Edit files only inside it." : "It is read-only for you: do not create, modify, or delete any file."}
- Do not commit, push, create branches, or change git configuration; the orchestration service records your work.
- Do not start sub-agents or delegate; this run is tracked and bounded by the orchestration service.
- Stop when the step is complete. If you cannot complete it, say why in the output block.

## Required final output
End your final message with exactly one fenced JSON block in this shape (all declared outputs are required):

\`\`\`json
{
  "outputs": {
${outputSpec}
  }
}
\`\`\`
`;
}

/** What the service already did in a seeded workspace, and what is left for the coder. */
function seedNote(seed: EnvelopeInput["seed"]): string {
  if (!seed) return "";
  const what = seed.kind === "revert" ? `a revert of commit ${seed.commit.slice(0, 12)}` : `a merge of ${seed.commit.slice(0, 12)}`;
  const rest = seed.conflicted.length
    ? `These files have conflicts, marked with <<<<<<< and >>>>>>> lines:\n${seed.conflicted.slice(0, 20).map((f) => `- ${f}`).join("\n")}${seed.conflicted.length > 20 ? `\n- and ${seed.conflicted.length - 20} more (every file with a conflict marker)` : ""}\nResolve every conflict by editing the files and remove all conflict markers. Keep work that landed later. The result is not recorded while a marker remains.`
    : "It applied without conflicts. Check that the result is complete and correct, and adjust files only where needed.";
  return `## Prepared in this workspace
The orchestration service already applied ${what} to the files here and left it uncommitted.
${rest}
Do not run git: no commit, merge, revert, reset, or checkout. Edit files only.

`;
}

export interface ParsedOutputs {
  outputs: { name: string; summary: string; openFindings?: number; items?: unknown[] }[];
  /** Best-of choice reported by a comparing step. */
  chosen?: string;
  /** Why parsing failed or which declared outputs are missing. Empty when everything was reported. */
  problems: string[];
}

/** Extract the output block from a worker's final message. Uses the last fenced JSON block. */
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The last fenced JSON object in a message. Summaries may themselves contain ``` fences. */
export function lastJsonObject(text: string): Record<string, unknown> | undefined {
  // Candidates, most likely first: from the last ```json fence to the last closing fence, then each
  // simple fenced block from the end.
  const candidates: string[] = [];
  const open = text.lastIndexOf("```json");
  const close = text.lastIndexOf("```");
  if (open >= 0 && close > open + 7) candidates.push(text.slice(open + 7, close));
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  candidates.push(...blocks.reverse());
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (isObject(v)) return v;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

export function parseOutputs(finalText: string, declared: OutputDef[]): ParsedOutputs {
  const problems: string[] = [];
  const parsed = lastJsonObject(finalText);
  if (!parsed) {
    return { outputs: [], problems: ["The final message has no parseable JSON output block."] };
  }
  const map = isObject(parsed.outputs) ? parsed.outputs : parsed;
  const outputs: ParsedOutputs["outputs"] = [];
  for (const d of declared) {
    const v = map[d.name];
    const entry = typeof v === "string" ? { summary: v } : isObject(v) ? v : undefined;
    const summary = entry && typeof entry.summary === "string" ? entry.summary.trim() : "";
    if (!summary) {
      problems.push(`Missing output "${d.name}".`);
      continue;
    }
    const out: ParsedOutputs["outputs"][number] = { name: d.name, summary: summary.slice(0, 4000) };
    if (d.kind === "breakdown") {
      const items = entry!.items;
      if (!Array.isArray(items)) {
        problems.push(`Output "${d.name}" needs an "items" list (it may be empty).`);
        continue;
      }
      out.items = items.slice(0, 50);
    }
    if (d.kind === "review-findings") {
      const n = Number(entry!.openFindings);
      if (!Number.isInteger(n) || n < 0) {
        problems.push(`Output "${d.name}" needs a non-negative integer openFindings.`);
        continue;
      }
      out.openFindings = n;
    }
    outputs.push(out);
  }
  const chosen = typeof parsed.chosen === "string" ? parsed.chosen.slice(0, 40) : undefined;
  return { outputs, problems, ...(chosen ? { chosen } : {}) };
}

// ---------- the lead ----------

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Everything the lead sees: vision, board, outcomes, conflicts, conversation, and the rules. */
export function buildLeadEnvelope(state: State, run: LeadRun, access: "read"): string {
  const p = state.project;
  const vision = M.currentVision(state);
  const maxProposals = p.autonomy.maxProposalsPerCycle;
  const tasks = [...state.tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const board = tasks.length
    ? tasks
        .slice(0, 60)
        .map((t) => {
          const c = M.currentSpec(t).content;
          const sel = c.options.find((o) => o.id === c.selectedOptionId);
          const integ = t.integration ? `; integration ${t.integration.status}` : "";
          return `- ${t.id} [${M.stateLabel(state, t)}${integ}] P${t.priority} ${clip(c.title, 90)} — approach ${sel?.id}: ${clip(sel?.name ?? "", 60)} (by ${t.specs[0].author})`;
        })
        .join("\n")
    : "- The board is empty.";
  const recent = state.artifacts
    .filter((a) => a.kind === "review-findings" || a.kind === "verification" || a.kind === "report")
    .slice(-10)
    .map((a) => `- ${a.taskId} ${a.stepId}.${a.name} (${a.kind}${a.openFindings !== undefined ? `, ${a.openFindings} open` : ""}): ${clip(a.summary.replace(/\n/g, " "), 240)}`)
    .join("\n");
  const conflicts = state.tasks.filter((t) => t.integration?.status === "conflict").map((t) => `- ${t.id}: ${t.integration!.message}`);
  const convo = state.conversation
    .slice(-20)
    .map((m) => `${m.author === "user" ? "User" : m.author === "lead" ? "Lead" : "System"} (${m.at}): ${clip(m.text, 1200)}`)
    .join("\n\n");
  const pending = state.conversation.filter((m) => run.messageIds.includes(m.id));
  const templates = p.templates.filter((t) => !INTERNAL_TEMPLATE_IDS.includes(t.id)).map((t) => `- ${t.id}: ${t.name} — ${t.description}`).join("\n");

  return `# Lead run ${run.id} (${run.trigger === "planning" ? "planning" : "reply to the user"})

You are the lead of the project "${p.name}". You own the backlog within the vision below: you decide what is worth doing next, specify it clearly, and pick the approach. Workers (designers, coders, reviewers on Claude or Codex) carry tasks out through each task's pipeline. You do not edit files: ${access === "read" ? "your working directory is a read-only checkout of the repository, which you may read to ground your proposals" : "you have no workspace"}.

## Vision (r${vision.rev})
${vision.text || "(not written yet)"}
Current focus: ${vision.focus || "(none)"}

## Board
${board}

## Recent outcomes and findings
${recent || "- None yet."}

## Integration conflicts
${conflicts.length ? conflicts.join("\n") : "- None."}

## Conversation (most recent last)
${convo || "(no messages yet)"}

## ${pending.length ? "Messages to answer now" : "This run"}
${pending.length ? pending.map((m) => `- ${clip(m.text, 2000)}`).join("\n") : run.trigger === "planning" ? "Planning check: propose the most useful next work, or nothing if nothing is clearly worth doing." : "No new messages."}

## Rules for proposals
- Propose at most ${maxProposals} task(s). Proposing nothing is fine when nothing is clearly worth doing; say why in your reply.
- Do not duplicate tasks already on the board. Prefer small, independently verifiable work that serves the current focus.
- Each proposal needs 2–4 options with trade-offs. When only one approach is sensible, include deferring as the other option and explain.
- Choose "recommendedOptionId" yourself; it becomes the selected approach unless the user overrides it.
- Give concrete, observable acceptance checks.
- Pick "templateId" from:
${templates}

## Required final output
End your final message with exactly one fenced JSON block:

\`\`\`json
{
  "reply": "<your answer to the user, or a short planning summary>",
  "proposals": [
    {
      "title": "<short imperative title>",
      "area": "<area>",
      "whyNow": "<evidence and why this matters now>",
      "outcome": "<what is true when done>",
      "benefit": "<user benefit>",
      "scopeIncluded": ["..."],
      "scopeExcluded": ["..."],
      "options": [
        { "id": "A", "name": "...", "approach": "...", "benefit": "...", "effort": "...", "risks": "...", "reversibility": "..." },
        { "id": "B", "name": "Defer", "approach": "...", "benefit": "...", "effort": "...", "risks": "...", "reversibility": "..." }
      ],
      "recommendedOptionId": "A",
      "rationale": "<why this option>",
      "uncertainty": "<what you do not know, and what would change the decision>",
      "acceptance": ["<observable check>"],
      "templateId": "<template id>",
      "priority": 3
    }
  ]
}
\`\`\`
`;
}

/** Parse the lead's final message. A reply without a JSON block is still a reply (with no proposals). */
export function parseLeadOutput(finalText: string): { reply: string; proposals: M.LeadProposal[]; problem?: string } {
  const obj = lastJsonObject(finalText);
  if (!obj) return { reply: clip(finalText.trim(), 4000), proposals: [], problem: "no JSON block; treated the message as a reply without proposals" };
  const reply = typeof obj.reply === "string" ? clip(obj.reply, 8000) : "";
  const proposals = Array.isArray(obj.proposals) ? (obj.proposals.filter(isObject) as unknown as M.LeadProposal[]) : [];
  return { reply, proposals };
}

/** A step that reads best-of candidates must choose one. */
function bestOfNote(_state: State, task: Task, step: Step): string {
  const groups = [...new Set(step.inputs.map((r) => task.steps.find((x) => x.id === r.step)?.copyOf).filter((g): g is string => !!g))].filter(
    (g) => task.steps.find((x) => x.id === g)?.parallel?.mode === "best-of" && !task.bestOf?.[g],
  );
  if (!groups.length) return "";
  const lines = groups.map((g) => `- ${g}: candidates ${task.steps.filter((x) => x.copyOf === g && x.state === "done").map((x) => x.id).join(", ")}`);
  return `## Choose the best candidate
Several agents produced alternatives. Compare them and choose one; only the chosen one goes further.
${lines.join("\n")}
Add \`"chosen": "<step id>"\` at the top level of your JSON block.

`;
}

/** A step that waits for child tasks sees how each of them ended. */
function childrenNote(state: State, task: Task, step: Step): string {
  if (!step.waitForChildren) return "";
  const kids = M.childTasks(state, task);
  if (!kids.length) return "## Child tasks\n- None were created.\n\n";
  const lines = kids.map((c) => {
    const spec = M.currentSpec(c).content;
    const results = state.artifacts
      .filter((a) => a.taskId === c.id && (a.kind === "verification" || a.kind === "code-change" || a.kind === "report"))
      .slice(-2)
      .map((a) => `${a.kind}: ${a.summary.replace(/\n/g, " ").slice(0, 300)}`)
      .join(" | ");
    return `- ${c.id} [${M.stateLabel(state, c)}${c.integration ? `, integration ${c.integration.status}` : ""}] ${spec.title}${results ? ` — ${results}` : ""}`;
  });
  return `## Child tasks (results of the breakdown)
${lines.join("\n")}
If the goal is not met yet, your breakdown output may list the next items; an empty list means the goal is met.

`;
}
