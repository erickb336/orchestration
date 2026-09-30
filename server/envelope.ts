// The assignment envelope every worker receives, whichever provider runs it, and the parser for the
// output block workers must end with. Provider session state is never passed between runs; context
// travels only through this envelope and the artifacts it references.

import * as M from "../src/domain/model";
import type { OutputDef, RoleId, State, Step, Task } from "../src/domain/types";

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
}

export function buildEnvelope({ state, task, step, attemptId, access }: EnvelopeInput): string {
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
          return `- ${i.step}.${i.output} v${art.version} (${art.kind})${findings}${ref}:\n  ${art.summary.replace(/\n/g, "\n  ")}`;
        })
        .join("\n")
    : "- No upstream artifacts. Work from the specification.";

  const outputSpec = step.outputs
    .map((o) => {
      if (o.kind === "review-findings") return `    "${o.name}": { "summary": "<findings, each with file:line and a suggested fix>", "openFindings": <number of unresolved findings> }`;
      if (o.kind === "code-change") return `    "${o.name}": { "summary": "<what you changed and why, and what you verified>" }`;
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

## Workspace rules
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

export interface ParsedOutputs {
  outputs: { name: string; summary: string; openFindings?: number }[];
  /** Why parsing failed or which declared outputs are missing. Empty when everything was reported. */
  problems: string[];
}

/** Extract the output block from a worker's final message. Uses the last fenced JSON block. */
export function parseOutputs(finalText: string, declared: OutputDef[]): ParsedOutputs {
  const problems: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  // Candidates, most likely first: from the last ```json fence to the last closing fence (summaries
  // may themselves contain ``` fences), then each simple fenced block from the end.
  const candidates: string[] = [];
  const open = finalText.lastIndexOf("```json");
  const close = finalText.lastIndexOf("```");
  if (open >= 0 && close > open + 7) candidates.push(finalText.slice(open + 7, close));
  const blocks = [...finalText.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  candidates.push(...blocks.reverse());
  let parsed: Record<string, unknown> | undefined;
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (isObject(v)) {
        parsed = v;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
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
  return { outputs, problems };
}
