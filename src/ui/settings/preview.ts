// Settings › How your project runs › the preview for evidence, as pure functions: the form's fields from the project's
// preview setting, the setPreview command they make, the domain's refusal (normalizePreview,
// src/domain/studio/evidence.ts), so the form shows the same words the service would answer with, and what the card
// says about evidence. Commands are lists of arguments: a field is split at spaces, and quotes keep an argument with
// spaces whole.

import { environmentIsSet } from "../../domain/environment";
import { normalizePreview, type PreviewInput, type PreviewSetting } from "../../domain/studio/evidence";
import type { State } from "../../domain/types";
import type { SendResult } from "../store";

export type PreviewDraft = { previewCommand: string; previewPort: string; previewCli: string };
export const PREVIEW_KEYS: readonly (keyof PreviewDraft)[] = ["previewCommand", "previewPort", "previewCli"];

/** An argument list as one line: an argument with a space or a quote is quoted. */
export const argvLine = (argv: readonly string[]) => argv.map((a) => (a === "" || /[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");

/** A line as an argument list: split at spaces; "double" or 'single' quotes keep an argument whole. */
export function splitArgv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/** The fields as the project has them; empty with no setting yet. */
export function livePreview(s: State): PreviewDraft {
  const p = s.project.preview;
  return { previewCommand: p?.preview ? argvLine(p.preview) : "", previewPort: p?.port === undefined ? "" : String(p.port), previewCli: p?.cliEntry ?? "" };
}

/** What the form saves: the setting, or null (no preview command, no port and no CLI entry: nothing to capture, so the setting is cleared). */
export function previewInput(v: PreviewDraft): PreviewInput | null {
  const command = v.previewCommand.trim();
  const port = v.previewPort.trim();
  const cli = v.previewCli.trim();
  if (!command && !port && !cli) return null;
  return { ...(command ? { preview: splitArgv(command) } : {}), ...(port ? { port: Number(port) } : {}), ...(cli ? { cliEntry: cli } : {}) };
}

/** Why the domain refuses the form's setting, in its words; undefined when it takes it. */
export function previewProblem(v: PreviewDraft): string | undefined {
  const input = previewInput(v);
  if (!input) return undefined;
  const r = normalizePreview(input);
  return "refused" in r ? r.refused : undefined;
}

/** The owner's command that saves the form, when one of its fields changed. */
export function previewSteps(v: PreviewDraft, changed: ReadonlySet<string>, send: (name: "setPreview", args: object) => Promise<SendResult>): (() => Promise<SendResult> | null)[] {
  if (!PREVIEW_KEYS.some((k) => changed.has(k))) return [];
  return [() => send("setPreview", { preview: previewInput(v) })];
}

/**
 * Whether the factory's evidence is captured, from the saved settings: it needs the preview setting and an environment
 * (an image or a dev container the owner confirmed). Without either, the card says what to set.
 */
export function evidenceStatus(s: State): { tone: "done" | "neutral" | "fail"; label: string; text: string } {
  const p = s.project.preview;
  const env = environmentIsSet(s.project.environment);
  if (p && env) return { tone: "done", label: `Set up (r${p.rev})`, text: `It captures ${whatCaptured(p)}, in this environment with no network.` };
  if (p) return { tone: "fail", label: "Not captured", text: `It would capture ${whatCaptured(p)}, but nothing is captured until the project has an environment: set an image above, or confirm the repository's dev container.` };
  return { tone: "neutral", label: "Not set up", text: `Give the preview command and its port for screens, or the CLI entry for terminal demos.${env ? "" : " Evidence also needs an environment above."} Until then, each capture records "not set up".` };
}

/** "screens from "npm run preview" on port 4173 and terminal demos that type bin/trips.js", in plain words. */
function whatCaptured(p: PreviewSetting): string {
  return [p.preview ? `screens from "${argvLine(p.preview)}" on port ${p.port}` : "", p.cliEntry ? `terminal demos that type ${p.cliEntry}` : ""].filter(Boolean).join(" and ");
}
