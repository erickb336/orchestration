// The shell around Vale (MIT, github.com/errata-ai/vale), the checker of controlled English. It runs the binary on one
// text with this repository's style (vale/), a fixed argument list, a time limit and no network, and parses its JSON
// into alerts at this boundary. Vale is optional, as Chrome and Docker are: without it the text is "not checked", with
// the reason, and nothing fails. What the alerts mean, and the record kept of them, is in record.ts.

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The version the style is written and tested for (docs/design/ORC-029-pass4d-design.md, decision 2). */
export const VALE_PIN = "3.24.0";
/** The repository's configuration, by absolute path, so the working directory and any global configuration never count. */
export const VALE_CONFIG = fileURLToPath(new URL("../../vale/.vale.ini", import.meta.url));
/** Where Homebrew puts it, for a service started without the shell's PATH. */
const KNOWN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
/** A text is checked up to this many characters (a lead reply is at most 8,000). */
export const MAX_TEXT = 20_000;
const TIMEOUT_MS = 10_000;

export type ValeLevel = "error" | "warning" | "suggestion";

/** One alert, as Vale reported it: the rule ("STE80.Passive"), its level and description, where it starts, and the words it matched. */
export interface ValeAlert {
  rule: string;
  level: ValeLevel;
  what: string;
  /** From 1. */
  line: number;
  /** From 1, as Vale counts columns. */
  col: number;
  match: string;
}

export type ValeOutcome = { checked: true; vale: string; alerts: ValeAlert[] } | { checked: false; reason: string };

/**
 * What the service calls to check a text. Tests pass their own. `config`: another configuration, the one with the
 * project's words when a dictionary is in force (words.ts).
 */
export type ProseChecker = (text: string, config?: string) => ValeOutcome;

export interface ValeOptions {
  /** The binary; found on PATH or in Homebrew's directories when left out. */
  bin?: string;
  config?: string;
  timeoutMs?: number;
  /** The text is checked up to this many characters (MAX_TEXT); the report on the repository's documents reads them whole. */
  maxChars?: number;
}

/** The first `vale` on PATH or in Homebrew's directories, or undefined. */
export function findVale(path = process.env.PATH ?? ""): string | undefined {
  for (const dir of [...path.split(delimiter).filter(Boolean), ...KNOWN_DIRS]) {
    const bin = join(dir, "vale");
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

const versions = new Map<string, string>();

/** The binary's own version ("3.24.0"), asked once per binary; undefined when it cannot be run. */
function versionOf(bin: string, timeoutMs: number): string | undefined {
  const known = versions.get(bin);
  if (known) return known;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: timeoutMs, env: valeEnv() });
  const v = r.status === 0 ? /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] : undefined;
  if (v) versions.set(bin, v);
  return v;
}

/** Only PATH: no VALE_CONFIG_PATH or VALE_STYLES_PATH from the service's environment can change the style. */
const valeEnv = () => ({ PATH: process.env.PATH ?? "" });

/**
 * Check one Markdown text. Vale reads it on stdin and prints JSON; `--no-exit` keeps the exit code for its own
 * failures, and `--minAlertLevel=suggestion` brings the sentence marks (vale/styles/STE80/Sentence.yml) that the
 * record counts sentences with. Never throws: a missing binary, a failure or a time-out is "not checked".
 */
export function runVale(text: string, opts: ValeOptions = {}): ValeOutcome {
  const bin = opts.bin ?? findVale();
  if (!bin) return { checked: false, reason: "Vale was not found" };
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const config = opts.config ?? VALE_CONFIG;
  const r = spawnSync(bin, ["--no-global", `--config=${config}`, "--minAlertLevel=suggestion", "--ext=.md", "--output=JSON", "--no-exit"], {
    input: text.slice(0, opts.maxChars ?? MAX_TEXT),
    encoding: "utf8",
    cwd: dirname(config),
    env: valeEnv(),
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  const err = r.error as NodeJS.ErrnoException | undefined;
  if (err?.code === "ENOENT") return { checked: false, reason: "Vale was not found" };
  if (err?.code === "ETIMEDOUT" || r.signal) return { checked: false, reason: `Vale did not finish within ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}` };
  if (err) return { checked: false, reason: `Vale could not run: ${err.message.slice(0, 200)}` };
  if (r.status !== 0) return { checked: false, reason: `Vale failed (exit ${r.status}): ${firstLine(r.stderr || r.stdout)}` };
  let alerts: ValeAlert[];
  try {
    alerts = parseValeJson(r.stdout);
  } catch (e) {
    return { checked: false, reason: `Vale's output was not readable: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { checked: true, vale: versionOf(bin, timeoutMs) ?? "unknown", alerts };
}

/** The checker the service uses: Vale with this repository's style. */
export const valeChecker =
  (opts: ValeOptions = {}): ProseChecker =>
  (text, config) =>
    runVale(text, config ? { ...opts, config } : opts);

const firstLine = (s: string) => (s.trim().split("\n").find((l) => l.trim()) ?? "no output").trim().slice(0, 200);

const LEVELS: readonly string[] = ["error", "warning", "suggestion"];
const RULE = /^[A-Za-z0-9]+\.[A-Za-z0-9]+$/;

/**
 * Vale's JSON output: an object from each input ("stdin.md") to its alerts. Each alert must carry a rule name, a
 * level, a line and a span; anything else is refused, not guessed. Sorted by position.
 */
export function parseValeJson(stdout: string): ValeAlert[] {
  const doc: unknown = JSON.parse(stdout.trim() || "{}");
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object of files");
  const out: ValeAlert[] = [];
  for (const list of Object.values(doc)) {
    if (!Array.isArray(list)) throw new Error("a file's alerts are not a list");
    for (const a of list as Record<string, unknown>[]) {
      const span = a?.Span;
      if (typeof a?.Check !== "string" || !RULE.test(a.Check)) throw new Error("an alert without a rule name");
      if (typeof a.Severity !== "string" || !LEVELS.includes(a.Severity)) throw new Error(`an alert of ${a.Check} with no known level`);
      if (!Number.isInteger(a.Line) || (a.Line as number) < 1) throw new Error(`an alert of ${a.Check} without a line`);
      if (!Array.isArray(span) || !Number.isInteger(span[0])) throw new Error(`an alert of ${a.Check} without a span`);
      out.push({
        rule: a.Check,
        level: a.Severity as ValeLevel,
        what: typeof a.Description === "string" ? a.Description : "",
        line: a.Line as number,
        col: Math.max(1, span[0] as number),
        match: typeof a.Match === "string" ? a.Match : "",
      });
    }
  }
  return out.sort((x, y) => x.line - y.line || x.col - y.col);
}
