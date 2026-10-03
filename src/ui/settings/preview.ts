// Settings › Project › Preview for evidence, as pure functions: the form's fields from the project's preview setting,
// the setPreview command they make, and the domain's refusal (normalizePreview, src/domain/studio/evidence.ts), so the
// form shows the same words the service would answer with. Commands are lists of arguments: a field is split at
// spaces, and quotes keep an argument with spaces whole.

import { DEFAULT_INSTALL, normalizePreview, type PreviewInput } from "../../domain/studio/evidence";
import type { State } from "../../domain/types";
import type { SendResult } from "../store";

export type PreviewDraft = { previewInstall: string; previewCommand: string; previewPort: string; previewCli: string };
export const PREVIEW_KEYS: readonly (keyof PreviewDraft)[] = ["previewInstall", "previewCommand", "previewPort", "previewCli"];

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

/** The fields as the project has them; with no setting yet, the install the service would use, and the rest empty. */
export function livePreview(s: State): PreviewDraft {
  const p = s.project.preview;
  if (!p) return { previewInstall: argvLine(DEFAULT_INSTALL), previewCommand: "", previewPort: "", previewCli: "" };
  return { previewInstall: argvLine(p.install), previewCommand: p.preview ? argvLine(p.preview) : "", previewPort: p.port === undefined ? "" : String(p.port), previewCli: p.cliEntry ?? "" };
}

/**
 * What the form saves: the setting, or null (no preview command, no port and no CLI entry: nothing to capture, so
 * the setting is cleared). An empty install is no install.
 */
export function previewInput(v: PreviewDraft): PreviewInput | null {
  const command = v.previewCommand.trim();
  const port = v.previewPort.trim();
  const cli = v.previewCli.trim();
  if (!command && !port && !cli) return null;
  return { install: splitArgv(v.previewInstall), ...(command ? { preview: splitArgv(command) } : {}), ...(port ? { port: Number(port) } : {}), ...(cli ? { cliEntry: cli } : {}) };
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
