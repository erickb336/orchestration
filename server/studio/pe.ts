// The PE's studio runs at the service (ORC-029 pass 3): what a PE run is given, and how its answer is read and
// recorded.
//
// The owner sees a designer's work only after PE review (docs/design/ORC-029-pass2-design.md, 2c). Once a version is
// imported and its screenshots or recording are made, the scheduler asks for a PE run on it (askForPeReviews in
// src/domain/studio/runs.ts). The run is read-only: its working directory is the version's folder, with the
// designer's files, the screenshots the service took (shots/) and the terminal recordings it made (recording/). It
// answers with one JSON block, a verdict per variant, which is an agent's output: it is checked here, at the
// boundary, and then by the studio's addPeVerdicts, which records it.
//
// The designer cannot revise in answer to the PE until pass 4, so each pass is the last of its round for now: an
// objection goes to the owner at once, never dropped (PE_PASS_IS_LAST).

import { currentVision } from "../../src/domain/model/core";
import { buildingSpend, fmtUsd } from "../../src/domain/spend";
import * as S from "../../src/domain/studio/studio";
import { VERDICTS, type StudioRun, type Verdict } from "../../src/domain/studio/types";
import { ControlError, type State } from "../../src/domain/types";
import { lastJsonObject } from "../envelope";

/**
 * Until the designer revises in answer to the PE (pass 4), the service makes each PE pass the last of its round, so
 * the owner sees an objection at once instead of waiting for a revision that cannot come.
 */
export const PE_PASS_IS_LAST = true;

const KIND_WORDS: Record<string, string> = { screen: "a screen", "terminal-demo": "a terminal demo", tui: "a TUI", contract: "a contract", flow: "a flow map" };
const VISION_CAP = 6000;

/** What the PE is shown of one variant: its entry, and the screenshots or recording the service made of it. */
function variantLines(a: ReturnType<typeof S.getArtifact>, v: { id: string; label: string; entry?: string }): string[] {
  const lines = [`- \`${v.id}\`, "${v.label}"${v.entry ? `: its entry is ${v.entry}` : ""}.`];
  if (a.shots?.status === "taken") {
    const mine = a.shots.shots.filter((x) => x.variant === v.id);
    if (mine.length) lines.push(`  Screenshots: ${mine.map((x) => `${x.path} (${x.device})`).join(", ")}.`);
  }
  const demo = a.demo?.status === "done" ? a.demo.variants.find((x) => x.variant === v.id) : undefined;
  if (demo?.status === "recorded" || demo?.status === "recorded-with-errors") lines.push(`  Recorded in the sandbox from ${demo.tape}: ${[demo.txt && `${demo.txt} (its text transcript)`, demo.gif, demo.webm].filter(Boolean).join(", ")}.`);
  if (demo?.status === "recorded-with-errors") lines.push(`  The recording shows an error the designer did not mean to show: ${demo.reason}`);
  if (demo?.status === "hand-written") lines.push(`  Not recorded${demo.reason ? ` (${demo.reason})` : ""}; the designer's hand-written frames: ${demo.files.join(", ")}.`);
  if (demo?.status === "not-recorded") lines.push(`  Not recorded: ${demo.reason}.`);
  return lines;
}

/** The project's budgets and what is spent, as the PE judges the fourth question against them. */
function budgetLines(state: State): string[] {
  const b = state.project.budgets;
  const spent = buildingSpend(state);
  const unknown = spent.unknown.length ? ` (${spent.unknown.length} run${spent.unknown.length === 1 ? " has" : "s have"} no recorded cost, so the figure is uncertain)` : "";
  return [
    `- Building budget (agent usage to build the product, Vision's runs included): ${b.buildingUsd === null ? "not set yet" : `${fmtUsd(b.buildingUsd)}; about ${fmtUsd(spent.usd)} is spent so far${unknown}`}.`,
    `- Maintenance budget (hosting, APIs, data, licences and upkeep): ${b.maintenanceUsdPerMonth === null ? "not set yet" : `${fmtUsd(b.maintenanceUsdPerMonth)} a month`}.`,
  ];
}

/** What a PE run is given: the version it reviews, where to read it, the vision, the budgets, and exactly how to answer. */
export function peEnvelope(state: State, run: StudioRun, where: { folder: string }): string {
  const a = S.getArtifact(state, run.artifactId!, run.baseVersion!);
  const round = state.studio.rounds.find((r) => r.n === run.round)!;
  const vision = currentVision(state).text.trim();
  const ids = a.variants.map((v) => v.id);
  const notes = [S.shotsNote(a), ...a.variants.map((v) => S.demoNote(a, v.id))].filter((x): x is string => !!x);
  return [
    `# Studio run ${run.id}: PE review of ${S.artifactName(a)}, round ${round.n} (${round.focus})`,
    "",
    "You are the PE in Orchestrator's vision studio: a rigid principal engineer who cares about longevity, scalability, feasibility and budget. The project is in Vision: nothing is built yet. A designer made the artifact below; the owner sees it only after your review, and what the owner approves becomes the blueprint the factory builds from.",
    "",
    "Judge each variant (each option the owner will choose between) on four things:",
    "1. Feasibility: can it be built with the inputs and technology available?",
    "2. Scale: does it hold at the scale the vision states?",
    "3. Longevity: will it still work and be maintainable in years (dependencies, data sources, formats)?",
    "4. Budget: does it fit the project's budgets?",
    "",
    "## The artifact",
    "",
    `${S.artifactName(a)} is ${KIND_WORDS[a.kind] ?? a.kind}${a.devices.length ? `, designed for ${a.devices.join(" and ")}` : ""}, made by the ${a.madeBy.role === "user" ? "owner" : `${a.madeBy.role} (${a.madeBy.provider})`}.`,
    "",
    `Its variants (${a.variants.length}):`,
    ...a.variants.flatMap((v) => variantLines(a, v)),
    ...(notes.length ? ["", ...notes.map((n) => `- ${n}`)] : []),
    "",
    `Its files: ${a.files.map((f) => f.path).join(", ")}.`,
    "",
    "## Where you read",
    "",
    `- Your working directory (${where.folder}) is this version's folder: the designer's files, the screenshots in shots/, and the recordings in recording/. Read what you need; you cannot change anything.`,
    "- There is no network. Judge from these files, the vision and the budgets below; say what you could not check.",
    "",
    "## The vision",
    "",
    vision ? (vision.length > VISION_CAP ? `${vision.slice(0, VISION_CAP)}…` : vision) : "(no vision written yet)",
    "",
    `Round ${round.n} is about ${round.focus === "data" ? "the inputs and outputs" : `the ${round.focus}`}.${round.summary ? ` ${round.summary}` : ""}`,
    "",
    "## The budgets",
    "",
    ...budgetLines(state),
    "- A budget effect is optional. When you give one, state the building cost (`buildUsd`) and the monthly maintenance (`maintenanceUsdPerMonth`), each a [low, high] range in dollars, and its `basis`: recorded costs of past runs, the providers' published prices, or a probe. With no basis, leave the figures out and say so in your reasons; never guess.",
    "",
    "## Your answer",
    "",
    "End your reply with one JSON block:",
    "",
    "```json",
    "{ \"verdicts\": [",
    `  { "variant": "${ids[0] ?? "a"}", "verdict": "feasible", "reasons": "<feasibility, scale, longevity and budget in a few sentences>" },`,
    `  { "variant": "${ids[1] ?? "b"}", "verdict": "feasible-if", "reasons": "…", "change": "<the change that makes it feasible>",`,
    '    "budget": { "buildUsd": [0, 0], "maintenanceUsdPerMonth": [0, 0], "basis": "<what the figures rest on>" } }',
    "] }",
    "```",
    "",
    `- One verdict for each variant: ${ids.map((id) => `\`${id}\``).join(", ")}.`,
    `- \`verdict\`: ${VERDICTS.join(", ")}. Feasible-if states in \`change\` the change that makes it feasible; not-feasible states in \`change\` the evidence that would change your verdict.`,
    "- An objection (not-feasible) goes to the owner with your reasons; it is never dropped, and only the owner can overrule it.",
    "",
  ].join("\n");
}

/** The PE's answer was refused; the message says why, for the run's record. */
export class PeAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeAnswerError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The verdicts in a PE run's final message: its last JSON block's `verdicts`. Shapes are checked here; what they
 * mean (every variant judged, a change for feasible-if, an estimate with its basis) is the studio's to check.
 */
export function readPeAnswer(finalText: string): S.VerdictInput[] {
  const obj = lastJsonObject(finalText);
  if (!obj) throw new PeAnswerError("its answer has no JSON block with the verdicts");
  if (!Array.isArray(obj.verdicts) || !obj.verdicts.length) throw new PeAnswerError('its JSON block has no "verdicts" list');
  if (obj.verdicts.length > 6) throw new PeAnswerError("it gave more verdicts than an artifact has variants");
  return obj.verdicts.map((v, i): S.VerdictInput => {
    const where = `verdict ${i + 1}`;
    if (!isObj(v)) throw new PeAnswerError(`${where} is not an object`);
    if (v.variant !== undefined && typeof v.variant !== "string") throw new PeAnswerError(`${where}: "variant" is not a variant id`);
    if (typeof v.verdict !== "string" || !VERDICTS.includes(v.verdict as Verdict)) throw new PeAnswerError(`${where}: "verdict" is not one of ${VERDICTS.join(", ")}`);
    if (typeof v.reasons !== "string") throw new PeAnswerError(`${where} gives no reasons`);
    if (v.change !== undefined && v.change !== null && typeof v.change !== "string") throw new PeAnswerError(`${where}: "change" is not text`);
    let budget: S.VerdictInput["budget"];
    if (v.budget !== undefined && v.budget !== null) {
      try {
        budget = S.readEstimate(v.budget);
      } catch (e) {
        throw new PeAnswerError(`${where}: ${e instanceof ControlError ? e.message : String(e)}`);
      }
    }
    return {
      ...(v.variant !== undefined ? { variant: v.variant as string } : {}),
      verdict: v.verdict as Verdict,
      reasons: v.reasons,
      ...(typeof v.change === "string" && v.change.trim() ? { change: v.change } : {}),
      ...(budget ? { budget } : {}),
    };
  });
}

const VERDICT_WORDS: Record<Verdict, string> = { feasible: "feasible", "feasible-if": "feasible if changed", "not-feasible": "not feasible" };

/**
 * Record a PE run's verdicts on the version it reviewed, as the last pass of its round for now (PE_PASS_IS_LAST).
 * Throws the studio's ControlError when they cannot be recorded (a variant left out, a feasible-if without its
 * change, the version revised meanwhile). Returns the state and a summary for the run's record.
 */
export function recordPeRun(state: State, run: StudioRun, verdicts: S.VerdictInput[], now: string): { state: State; summary: string } {
  const r = S.addPeVerdicts(
    state,
    { artifactId: run.artifactId!, version: run.baseVersion!, verdicts, by: { provider: run.provider, model: run.actualModel ?? run.model, runId: run.id }, lastPass: PE_PASS_IS_LAST },
    now,
  );
  const a = S.getArtifact(r.state, run.artifactId!, run.baseVersion!);
  const label = (id: string | undefined) => (id === undefined ? "" : `${a.variants.find((v) => v.id === id)?.label ?? id} `);
  return { state: r.state, summary: `${S.artifactName(a)}, pass ${r.pass}: ${verdicts.map((v) => `${label(v.variant)}${VERDICT_WORDS[v.verdict]}`).join(", ")}` };
}
